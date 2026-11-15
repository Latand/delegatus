import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeRegistry, resolveConversationAlias, type AgentRegistry } from "../src/lib/agent/registry";
import { registryRowsMatching, registryConversationKeysForEntryKey, SqliteAgentRegistryStore } from "../src/lib/agent/sqliteRegistryStore";
import { laneFinish } from "../src/lib/pipelines/laneFinish";
import type { Pipeline } from "../src/lib/pipelines/types";
import type { AttemptTempStore } from "../src/lib/runtime/attemptTempRetention";
import { temporaryDataAuthority, type TemporaryRegistry } from "../src/lib/runtime/temporaryDataProduction";
import { TemporaryDataStore, type TemporaryDataCandidate } from "../src/lib/runtime/temporaryDataStore";
import { PRESERVATION_NAMES, sweepTemporaryData, temporaryDataProtection, type TemporaryDataAuthority } from "../src/lib/runtime/temporaryDataRetention";
import { attemptReferencesClear, type RetainedCheckoutReads } from "../src/lib/runtime/attemptTempFilesystem";
import { attemptTempJournalPath, scanProcesses } from "../src/lib/tempSweep";
import { retentionProcessScan } from "../src/lib/selfUpdate/retentionInspection";

/** A full policy inventory plus a bounded dispatch sample per class. Live
 * databases are opened read-only. All ledger/report writes go below TMPDIR.
 * No production sweep, quarantine, sudo, installer or Docker prune is called. */
const [stateArgument, output] = process.argv.slice(2);
if (!stateArgument || !output || !process.env.TMPDIR || !path.resolve(output).startsWith(fs.realpathSync(process.env.TMPDIR) + path.sep))
  throw new Error("usage: temporary-data-dry-run <state directory to read> <report under TMPDIR>");
const state = fs.realpathSync(stateArgument), scratch = fs.mkdtempSync(path.join(process.env.TMPDIR, "retention-audit-"));
const startedAt = new Date().toISOString(), now = Date.now();
const db = new Database(path.join(state, "state.sqlite"), { readonly: true });
const rootsDb = new Database(path.join(state, "attempt-temp.sqlite"), { readonly: true });
const registryStore = new SqliteAgentRegistryStore(path.join(state, "agent-registry.sqlite"), { readOnly: true, normalize: normalizeRegistry,
  initialSnapshot: () => { throw new Error("read-only audit refuses registry import"); } });
type Facts = ReturnType<AgentRegistry["temporaryDataFacts"]>;
const registry: TemporaryRegistry = {
  temporaryDataReceiptKeys: after => registryStore.temporaryDataReceiptKeys(after, 32),
  temporaryDataFacts: input => registryStore.read(file => {
    const receipt = input.launchId ? file.receipts[input.launchId] ?? null : null, key = input.key ?? receipt?.key;
    const entry = key ? file.entries[`${key.engine}:${key.sessionId}`] ?? null : null;
    const ids = key ? registryConversationKeysForEntryKey(file, `${key.engine}:${key.sessionId}`) : [];
    if (!ids || ids.length > 32) throw new Error("retention conversation inventory unavailable");
    const conversations = new Set([...ids, ...(receipt ? [receipt.conversationId] : [])]);
    for (const id of conversations) conversations.add(resolveConversationAlias(file, id as Parameters<typeof resolveConversationAlias>[1]));
    const memberships = [...conversations].flatMap(id => file.memberships[id] ?? []);
    return JSON.parse(JSON.stringify({ receipt, entry, pipelines: memberships.filter(row => row.kind === "pipeline").map(row => row.containerId) })) as Facts;
  }, { skipColdKeyInitialization: true }),
  spawnReceipt: launch => registryStore.read(file => file.receipts[launch] ? JSON.parse(JSON.stringify(file.receipts[launch]!)) : null, { skipColdKeyInitialization: true }),
  spawnReceiptForHost: key => registryStore.read(file => {
    const entry = file.entries[`${key.engine}:${key.sessionId}`];
    const receipt = entry?.structuredHostOperationId ? file.receipts[entry.structuredHostOperationId]
      : registryRowsMatching(file, "receipts", "key.sessionId", key.sessionId).findLast(row => row.key?.engine === key.engine && row.artifactPath === entry?.artifactPath);
    return receipt ? JSON.parse(JSON.stringify(receipt)) : null;
  }, { skipColdKeyInitialization: true }),
};
const roots = { owner: directory => rootsDb.query("SELECT * FROM roots WHERE directory=?").get(directory),
  copy: directory => rootsDb.query("SELECT * FROM copies WHERE destination=?").get(directory) } as Pick<AttemptTempStore, "owner" | "copy">;
const pipelineValue = (id: string) => db.query<{ value_json: string }, [string]>(
  "SELECT value_json FROM state_rows WHERE collection IN ('pipelines','pipelines_archive') AND row_key=? ORDER BY collection LIMIT 1").get(id)?.value_json;
const lane = (id: string): TemporaryDataAuthority => {
  const value = pipelineValue(id), pipeline = value ? JSON.parse(value) as Pipeline : null, finish = pipeline ? laneFinish(pipeline) : { finished: false as const };
  return { expiresAt: finish.finished ? finish.expiresAt : null, reason: !pipeline ? "lane-owner-missing" : finish.finished ? "young" : "open-or-unsettled-lane",
    revision: value ?? "missing", pipelineIds: [id], current: () => pipelineValue(id) === value };
};
const evidence = path.join(state, "evidence"), journals = path.join(state, "structured-host-events");
const names = (directory: string) => { try { return fs.readdirSync(directory).sort(); } catch { return []; } };
const bindings = new Map<string, string>();
for (let cursor = "";;) {
  const keys = registry.temporaryDataReceiptKeys(cursor); if (!keys.length) break;
  for (const key of keys) bindings.set(createHash("sha256").update(key).digest("hex").slice(0, 32), key);
  cursor = keys.at(-1)!;
}
const rows: TemporaryDataCandidate[] = [];
function candidate(directory: string, scope: string, kind: TemporaryDataCandidate["kind"], owner: string) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || fs.existsSync(attemptTempJournalPath(directory))) return;
  // Ownerless adoption begins on rollout. This audit never backdates it.
  rows.push({ directory, scope, kind, owner, identity: `${stat.dev}:${stat.ino}`, adoptedAt: now, checkedAt: 0, bytes: 0, reason: "audit" });
}
for (const name of names(evidence)) if (/^[A-Za-z0-9_-]+$/.test(name) && !["agents", "attempt-temp", "recorded-checks"].includes(name)) {
  const directory = path.join(evidence, name), children = names(directory);
  if (!children.length) candidate(directory, evidence, "lane-evidence", name);
  for (const child of children) if (!PRESERVATION_NAMES.has(child) && child !== ".delegatus-keep") candidate(path.join(directory, child), evidence, "lane-evidence", name);
}
for (const name of names(path.join(evidence, "agents"))) {
  const directory = path.join(evidence, "agents", name), children = names(directory), launch = bindings.get(name) ?? "";
  if (!children.length) candidate(directory, evidence, "agent-evidence", launch);
  for (const child of children) if (!PRESERVATION_NAMES.has(child) && child !== ".delegatus-keep") candidate(path.join(directory, child), evidence, "agent-evidence", launch);
}
for (const name of names(path.join(evidence, "recorded-checks"))) {
  const directory = path.join(evidence, "recorded-checks", name), children = names(directory);
  if (!children.length) candidate(directory, evidence, "lane-evidence", name);
  for (const child of children) candidate(path.join(directory, child), evidence, "lane-evidence", name);
}
for (const name of names(path.join(evidence, "attempt-temp"))) if (/^[a-f0-9]{64}$/.test(name)) candidate(path.join(evidence, "attempt-temp", name), evidence, "ownerless-copy", name);
for (const name of names(journals)) if (name.endsWith(".jsonl")) candidate(path.join(journals, name), journals, "journal", decodeURIComponent(name.slice(0, -6)));

function bytes(directory: string) {
  const pending = [directory], seen = new Set<string>(); let total = 0, count = 0;
  while (pending.length) {
    if (++count > 200000) throw new Error("byte-walk-bound");
    const file = pending.pop()!, stat = fs.lstatSync(file), key = `${stat.dev}:${stat.ino}`;
    if (!seen.has(key)) { seen.add(key); total += stat.blocks * 512; }
    if (stat.isDirectory()) pending.push(...fs.readdirSync(file).map(name => path.join(file, name)));
  }
  return total;
}
const classes: Record<string, { count: number; bytes: number; policyDueCount: number; policyDueBytes: number; unmeasured: number;
  reasons: Record<string, { count: number; bytes: number }>; dispatchSample?: unknown }> = {};
const due = new Map<string, TemporaryDataCandidate[]>();
for (const row of rows) {
  const summary = classes[row.kind] ??= { count: 0, bytes: 0, policyDueCount: 0, policyDueBytes: 0, unmeasured: 0, reasons: {} };
  summary.count++;
  let reason = "unknown";
  try { row.bytes = bytes(row.directory); summary.bytes += row.bytes; } catch { summary.unmeasured++; }
  try {
    const authority = temporaryDataAuthority(row, registry, roots, () => now, lane);
    if (authority.expiresAt !== null && now >= authority.expiresAt && authority.current()) {
      const protection = temporaryDataProtection(row, row.directory, () => performance.now(), performance.now() + 1000);
      if (!protection.current()) throw new Error("changed-during-inspection");
      reason = "policy-due"; summary.policyDueCount++; summary.policyDueBytes += row.bytes;
      const list = due.get(row.kind) ?? []; if (list.length < 8) list.push(row); due.set(row.kind, list);
    } else reason = authority.reason;
  } catch (error) { reason = error instanceof Error ? error.message : "inspection-unavailable"; }
  const category = summary.reasons[reason] ??= { count: 0, bytes: 0 }; category.count++; category.bytes += row.bytes;
}
const checkoutReads: RetainedCheckoutReads = new Map();
for (const [kind, selected] of due) {
  const ledger = new TemporaryDataStore(path.join(scratch, kind + ".sqlite"));
  try {
    for (const row of selected) ledger.register(row);
    classes[kind]!.dispatchSample = await sweepTemporaryData(ledger, { mode: "dry-run", now: () => now, budgetMs: 20000, checkoutReads,
      authority: async row => temporaryDataAuthority(row, registry, roots, () => now, lane), claim: async () => { throw new Error("audit refuses claims"); },
      references: async (row, target, inventory) => attemptReferencesClear(row.directory, target, scanProcesses("/proc", [row.directory, target]), undefined, inventory),
    });
  } finally { ledger.close(); }
}
const backupDirectories = names(evidence).map(name => path.join(evidence, name, "worktree")).filter(fs.existsSync);
let backupBytes = 0; for (const directory of backupDirectories) backupBytes += bytes(directory);
let releases: unknown;
const launcherFiles = names(path.join(state, "self-update")).filter(name => /^launcher-.*\.json$/.test(name));
for (const name of launcherFiles) {
  const record = JSON.parse(fs.readFileSync(path.join(state, "self-update", name), "utf8"));
  if (!record.releasesDir || !fs.existsSync(record.releasesDir)) continue;
  const entries = names(record.releasesDir).filter(name => /^[a-f0-9]{12,40}$/.test(name)).map(name => path.join(record.releasesDir, name));
  const scan = retentionProcessScan(record.releasesDir);
  releases = { count: entries.length, bytes: entries.reduce((sum, entry) => sum + bytes(entry), 0),
    ordinaryScanUncertainProcesses: scan.uncertain?.length ?? 0, holderProcesses: scan.processes.length,
    disposition: "Existing release protections apply; unreadable processes retain releases until the fixed observer is installed. No privileged probe was run." };
}
let docker: unknown;
try { docker = (await promisify(execFile)("docker", ["system", "df", "--format", "{{json .}}"], { timeout: 30000, maxBuffer: 65536 })).stdout.trim().split("\n").map(line => JSON.parse(line)); }
catch { docker = { state: "read-only Docker inventory unavailable" }; }
registryStore.close(); rootsDb.close(); db.close();
const report = { startedAt, finishedAt: new Date().toISOString(), policy: "seven days; ownerless copies start their adoption grace on rollout",
  measurement: "allocated bytes, hardlinks counted once per candidate; sums across candidates exceed unique freed blocks; incomplete walks are marked",
  classes, worktreeBackups: { count: backupDirectories.length, bytes: backupBytes, disposition: "preserved" }, releases, docker,
  limits: "Policy inventory covers current files. Dispatch samples cover up to eight due entries per class under a 20-second class budget. Remaining policy-due entries require fresh dispatch fences. No live deletion, quarantine, claims, sudo, installation or prune occurred." };
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
