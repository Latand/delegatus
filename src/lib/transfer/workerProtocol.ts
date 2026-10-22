import crypto from "node:crypto";
import fs from "node:fs";

import { memorySource } from "@/lib/memory/source";
import { projectAliasSnapshot, recordedProjectRemotes } from "@/lib/projects/aliases";

import metadata from "../../../package.json";
import { TransferBundleError } from "./bundle";
import { exportTransferBundle, TransferSecretError } from "./exporter";
import { applyTransferImport, previewTransferImport, readTransferReport, recoverTransferImports, TransferImportError } from "./importer";
import { isSectionName, type SectionName, type TransferImportRequest } from "./types";

export type TransferWorkerRequest =
  | { operation: "export"; sections?: string[]; outFile: string }
  | { operation: "preview"; bundleFile: string; mappings?: Record<string, string>; replace?: string[] }
  | { operation: "apply"; request: TransferImportRequest }
  | { operation: "recover" }
  | { operation: "report"; importId?: string };

export type TransferWorkerError = { code: string; message: string; section?: string; key?: string };
export type TransferWorkerResponse = { ok: true; result: unknown } | { ok: false; error: TransferWorkerError };

const ENGINE_MEMORY_KINDS = new Set(["claude_memory", "claude_index", "codex_memory", "codex_summary", "rollout_summary"]);

/** Engine memory files on this install that never went through the import into
    Delegatus memory (docs/design/memory-source-switch.md). They do not travel:
    the bundle carries Delegatus memory only (operator decision on Q3). */
export async function engineMemoryNotImported(): Promise<number> {
  const choice = memorySource();
  if (choice.choice === "delegatus" && (choice.phase === null || choice.phase === "active")) return 0;
  const { defaultMemoryRoots } = await import("@/lib/memory/service");
  const { discoverMemorySources } = await import("@/lib/memory/sources");
  const { sources } = await discoverMemorySources(await defaultMemoryRoots());
  return sources.filter(source => ENGINE_MEMORY_KINDS.has(source.sourceKind)).length;
}

function describe(error: unknown): TransferWorkerError {
  if (error instanceof TransferSecretError) return { code: "secret_in_bundle", message: error.message, section: error.section, key: error.key };
  if (error instanceof TransferBundleError || error instanceof TransferImportError) return { code: error.code, message: error.message };
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}

export async function runTransferWorkerRequest(request: TransferWorkerRequest): Promise<TransferWorkerResponse> {
  try {
    switch (request.operation) {
      case "export": {
        const sections = request.sections?.filter(isSectionName) as SectionName[] | undefined;
        const aliases = projectAliasSnapshot();
        const exportId = crypto.randomUUID();
        const { accountExporter } = await import("./accounts");
        const result = await exportTransferBundle({
          exportId,
          accounts: accountExporter(exportId),
          sections,
          product: metadata.version,
          env: process.env,
          projects: { aliases: aliases.aliases, displayNames: aliases.displayNames, remotes: recordedProjectRemotes() },
          engineMemoryNotImported,
        });
        fs.writeFileSync(request.outFile, result.bytes, { mode: 0o600 });
        return { ok: true, result: { exportId: result.exportId, sections: result.sections, notices: result.notices, bytes: result.bytes.length } };
      }
      case "preview": {
        const bytes = fs.readFileSync(request.bundleFile);
        return { ok: true, result: await previewTransferImport(bytes, { mappings: request.mappings, replace: request.replace }) };
      }
      case "apply": {
        const { withAccountMutationLockAsync } = await import("@/lib/accounts/accountMutation");
        const { report } = await withAccountMutationLockAsync(() => applyTransferImport(request.request), { holder: "install transfer" });
        return { ok: true, result: report };
      }
      case "recover":
        return { ok: true, result: await recoverTransferImports() };
      case "report": {
        const row = readTransferReport(request.importId);
        if (!row) return { ok: true, result: null };
        const { accountReportRows, accountsReady, importedAccountRows } = await import("./accounts");
        const accounts = accountReportRows(importedAccountRows().filter(account => account.importId === row.importId));
        return { ok: true, result: { ...row.report, accounts, accountsReady: accountsReady(accounts) } };
      }
    }
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}
