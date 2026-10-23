import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readMemorySourceFile } from "@/lib/memory/source";
import { projectAliasSnapshot, recordedProjectRemotes } from "@/lib/projects/aliases";

import metadata from "../../../package.json";
import { TransferBundleError } from "./bundle";
import { exportTransferBundle, TransferSecretError } from "./exporter";
import { applyTransferImport, importAccountRows, previewTransferImport, readTransferReport, recoverTransferImports, TransferImportError } from "./importer";
import { isSectionName, type BundleNotice, type SectionName, type TransferImportRequest } from "./types";

export type TransferWorkerRequest =
  | { operation: "export"; sections?: string[]; outFile: string }
  | { operation: "preview"; bundleFile: string; mappings?: Record<string, string>; replace?: string[] }
  /** `lease`: the account mutation hold the Viewer took for this apply and lends it; absent, the worker takes the lock itself. */
  | { operation: "apply"; request: TransferImportRequest; lease?: string }
  | { operation: "recover" }
  | { operation: "report"; importId?: string };

export type TransferWorkerError = { code: string; message: string; section?: string; key?: string };
export type TransferWorkerResponse = { ok: true; result: unknown } | { ok: false; error: TransferWorkerError };

const ENGINE_MEMORY_KINDS = new Set(["claude_memory", "claude_index", "codex_memory", "codex_summary", "rollout_summary"]);

/** Engine memory files on this install whose content never went through the
    import into Delegatus memory (docs/design/memory-source-switch.md). They do
    not travel: the bundle carries Delegatus memory only (operator decision on
    Q3). An install that already switched is compared file by file with what
    its import copied, by content: a file added or changed since the switch is
    named too. Engine memory files are never read into the bundle. */
export async function engineMemoryNotImported(): Promise<BundleNotice | null> {
  const { defaultMemoryRoots } = await import("@/lib/memory/service");
  const { discoverMemorySources } = await import("@/lib/memory/sources");
  const { sources } = await discoverMemorySources(await defaultMemoryRoots());
  const engineFiles = sources.filter(source => ENGINE_MEMORY_KINDS.has(source.sourceKind));
  if (!engineFiles.length) return null;
  const choice = readMemorySourceFile();
  if (choice?.source !== "delegatus" || choice.phase === "importing") return { code: "engine_memory_not_imported", files: engineFiles.length };
  /* No import id: the choice arrived settled by an earlier transfer, and nothing here was imported. */
  const imported = choice.importId ? await importedEngineMemoryHashes(choice.importId) : new Set<string>();
  let missing = 0;
  for (const source of engineFiles) {
    let digest: string | null;
    try { digest = crypto.createHash("sha256").update(fs.readFileSync(source.path)).digest("hex"); }
    catch { digest = null; }
    if (!digest || !imported.has(digest)) missing += 1;
  }
  return missing ? { code: "engine_memory_not_imported", files: missing, since: "import" } : null;
}

/** The content hashes the memory source import copied, from its own manifest;
    empty when the record or the manifest cannot be read, so every file counts. */
async function importedEngineMemoryHashes(importId: string): Promise<Set<string>> {
  try {
    const { readImportRecord } = await import("@/lib/memory/importStore");
    const record = readImportRecord(importId);
    if (!record) return new Set();
    const manifest = JSON.parse(fs.readFileSync(path.join(record.backup, "manifest.json"), "utf8")) as { files?: { sha256?: unknown }[] };
    return new Set((manifest.files ?? []).map(file => file.sha256).filter((hash): hash is string => typeof hash === "string"));
  } catch { return new Set(); }
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
        const { underLentAccountMutationLease, withAccountMutationLockAsync } = await import("@/lib/accounts/accountMutation");
        const apply = () => applyTransferImport(request.request);
        const { report } = request.lease
          ? await underLentAccountMutationLease(request.lease, apply)
          : await withAccountMutationLockAsync(apply, { holder: "install transfer" });
        return { ok: true, result: report };
      }
      case "recover": {
        const { withAccountMutationLockAsync } = await import("@/lib/accounts/accountMutation");
        return { ok: true, result: await withAccountMutationLockAsync(() => recoverTransferImports(), { holder: "install transfer recovery" }) };
      }
      case "report": {
        const row = readTransferReport(request.importId);
        if (!row) return { ok: true, result: null };
        const { accountReportRows, accountsReady } = await import("./accounts");
        const accounts = accountReportRows(importAccountRows(row));
        return { ok: true, result: { ...row.report, accounts, accountsReady: accountsReady(accounts) } };
      }
    }
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}
