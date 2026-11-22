import "@/lib/state/owner/tool";
import { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { databaseFileIdentity } from "@/lib/state/currentDatabase";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { defaultRegistrySqliteFilename, resolveRegistryBackend } from "@/lib/agent/registryBackendIdentity";
import { archiveRetirementReport, retirementApprovalFile } from "@/lib/agent/registryArchiveRetirement";

export function registryArchiveRetirement(args: string[]) {
  const approve = args.length === 2 && args[0] === "--approve" ? args[1] : null;
  if (!approve && !(args.length === 1 && args[0] === "--dry-run")) {
    throw new Error("usage: registry-archive-retirement.ts --dry-run | --approve <report-sha256>");
  }
  const json = statePath("agent-registry.json");
  const backend = resolveRegistryBackend(json);
  if (backend.mode !== "sqlite") throw new Error("registry archive retirement requires the SQLite backend");
  if (backend.pendingJsonImport) throw new Error("registry import is pending; wait for the serving writer to publish SQLite");
  const filename = backend.sqliteFilename ?? defaultRegistrySqliteFilename(json);
  const identity = databaseFileIdentity(filename);
  const db = new Database(filename,{ readonly: true });
  try {
    const report = archiveRetirementReport(db);
    if (databaseFileIdentity(filename) !== identity) throw new Error("registry changed files; request a fresh dry run");
    if (approve) {
      if (approve !== report.digest) throw new Error("report digest changed; request a fresh dry run and approval");
      writeJsonDurably(retirementApprovalFile(filename), { category: "A",digest: approve,databaseIdentity: identity,
        graceMs: report.graceMs,batchSize: report.batchSize,cycleBatches: report.cycleBatches });
    }
    return { ...report, approved: Boolean(approve), productionDeletion: approve ? "Enabled for category A only through the reaper after the grace period" : "Dry run does not enable or disable retirement; existing approval remains authoritative" };
  } finally { db.close(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(registryArchiveRetirement(process.argv.slice(2)),null,2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
