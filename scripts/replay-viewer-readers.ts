/** Run from an exported revision. Output contains generated data and relative
 * source fingerprints only. CPU admission and isolated roots belong to caller. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const root = process.env.LLV_STATE_DIR!;
if (!root || process.env.NODE_ENV !== "test" || !process.env.LLV_VIEWER_CONTROL_URL?.endsWith(":1")) {
  throw Error("isolated state, NODE_ENV=test and closed control port required");
}
if (fs.readdirSync(root).length) throw Error("replay requires a freshly created empty state root");
const load = (file: string) => import(pathToFileURL(path.join(repo, file)).href);
const { buildPipeline, savePipelines, loadPipelinesForRetirement } = await load("src/lib/pipelines/store.ts");
const { defaultPipelinePorts } = await load("src/lib/pipelines/engine.ts");
const { tickPipelinesController } = await load("src/lib/pipelines/controllerPass.ts");
const { registerPipelineTick } = await load("src/lib/pipelines/controllerSignal.ts");
const { SqliteStateCollection, initializeStateCollections } = await load("src/lib/state/sqliteStateStore.ts");
const memory = await load("src/lib/memory/curation/store.ts");
const { roleMemoryCollection } = await load("src/lib/memory/roleStore.ts");
const { AgentRegistry, normalizeRegistry } = await load("src/lib/agent/registry.ts");
const { SqliteAgentRegistryStore } = await load("src/lib/agent/sqliteRegistryStore.ts");
const { runStructuredHostRetirementSweep } = await load("src/lib/runtime/structuredHostRetirement.ts");
const { performanceSpans, performanceSites } = await load("src/lib/performanceSpans.ts");
const { determined } = await load("src/lib/runtime/determinable.ts");
const lanes = Number(process.argv[2]);
const mode = process.argv[3];
if (![15, 30].includes(lanes) || !["before", "after"].includes(mode)) throw Error("usage: replay-viewer-readers.ts <15|30> <before|after>");
const startup = mode === "after" ? await load("src/lib/runtime/startup.ts") : null;
const retirement = mode === "after" ? await load("src/lib/pipelines/retirementEvidence.ts") : null;
const now = "2026-10-16T00:00:00.000Z";
const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null };
const record = (id: string, open: boolean) => {
  const row = buildPipeline({ id, task: id, project: "fixture", repoDir: "/fixture/repository", publication: "internal",
    stages: [{ id: "build", kind: "run", prompt: "Build", next: null, effectiveRole: role }], srcPath: null, srcConversationId: null, now });
  row.state = open ? "running" : "closed"; row.pausedState = null; row.closedAt = open ? null : now;
  row.baseBranch = "main"; row.baseRef = row.lastPassedCommit = "a".repeat(40); row.baseRefPinned = true;
  row.cursor = open ? { stageId: "build", state: "running", input: null, activatedBy: null } : null;
  row.terminalReap = { rounds: 1, stopped: 16, lastAt: now, settledAt: now, settledAttempts: Array.from({ length: 16 }, (_, n) => `build:${n + 1}`) };
  row.runs[0].attempts = Array.from({ length: 16 }, (_, n) => ({ n: n + 1, state: open && n === 15 ? "running" : "failed",
    effectiveRole: role, historical: n < 15, launchId: null, conversationId: `conversation_${id}_${n}`, sessionId: `session-${id}-${n}`,
    agentPath: `/fixture/${id}-${n}.jsonl`, paneId: null, flowId: null, startedAt: now, completedAt: open && n === 15 ? null : now,
    input: null, activatedBy: null, output: "generated payload ".repeat(430), error: null, verdict: open && n === 15 ? null : { status: "fail", findings: [] } }));
  return row;
};
const hot = Array.from({ length: 274 }, (_, n) => record(`hot-${n}`, n < lanes));
const archived = Array.from({ length: 980 }, (_, n) => record(`archive-${n}`, false));
savePipelines(hot);
const filename = path.join(root, "state.sqlite");
const db = new Database(filename);
// The normal store initialized both collections. Raw old-writer writes exercise
// the real tracking triggers while keeping identical generated input per side.
for (const row of archived) db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive',?,?,?,1,0)")
  .run(row.id, JSON.stringify(row), Number(row.id.split("-").at(-1)));
const counts = { calls: 0, changed: 0, rewritten: 0, merged: 0, moved: 0, split: 0, archived: 0, restored: 0 };
const pass = { kind: "pass", id: "curate_fixture", project: "fixture", repoDir: null, scopes: [], clientAttemptId: "curate_fixture", conversationId: "conversation_curator", launchId: null,
  transcriptPath: null, launchedAt: now, claimedAt: now, state: "running", endedAt: null, failure: null, counts };
initializeStateCollections(filename, [{ collection: "role_memory_curation", schemaVersion: 1, migrationId: "role-memory-curation-v1",
  key: (row: { kind: string; id: string }) => row.kind === "machine" ? "machine" : `r:${row.id}`, loadRecords: () => [pass, ...Array.from({ length: 49 }, (_, n) => ({ ...pass, id: `curate_history_${n}`, state: "succeeded", conversationId: null, endedAt: now })), { kind: "machine", current: pass.id }] }]);
const scopes = roleMemoryCollection(true);
scopes.boundedPatch(100, (tx: { put(row: unknown): void }) => {
  for (let n = 0; n < 100; n++) tx.put({ kind: "scope", scope: n === 0 ? "machine" : `role:fixture:fixture-${n}`, revision: 100, active: [],
    history: Array.from({ length: 100 }, (_, revision) => ({ revision, at: `${now}-${revision}`, by: "curator", pass: pass.id, counts: { ...counts, calls: 1 },
      before: ["generated retained rule ".repeat(50)], added: [], merged: [] })) });
});
// Real indexed registry, with generated retained conversations and terminal rows.
const template = new AgentRegistry(path.join(root, "template.json"), undefined, undefined, { sqliteMode: "off" });
const conv = template.ensureConversation("codex", "/fixture/template.jsonl", null);
const launched = template.beginSpawn("codex", "/fixture", { title: "Reader fixture" });
template.close();
// beginSpawn creates fixture-owned system tasks. Their ids and wall-clock
// timestamps are irrelevant to these readers; remove only its recorded ids.
for (const id of launched.failureReporting?.taskIds ?? []) {
  db.query("DELETE FROM state_rows WHERE collection='tasks' AND row_key=?").run(`t:${id}`);
}
const initial = normalizeRegistry({ version: 2, entries: {}, receipts: {} });
for (let n = 0; n < 4000; n++) {
  const active = n < lanes, id = `conversation_registry_${n}`, session = `registry-${n}`;
  initial.conversations[id] = { ...conv, id, createdAt: now, updatedAt: now, generations: [{ ...conv.generations[0], createdAt: now, id: session, path: `/fixture/${session}.jsonl` }] };
  initial.entries[`codex:${session}`] = { key: { engine: "codex", sessionId: session }, artifactPath: `/fixture/${session}.jsonl`, cwd: "/fixture", accountId: null,
    status: active ? "idle" : "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, updatedAt: now,
    ...(active ? { structuredHost: { kind: "codex-app-server", endpoint: "fixture", process: { pid: 900000 + n, startIdentity: "fixture", bootEpoch: "fixture" },
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] } } : {}) };
  initial.memberships[id] = [{ conversationId: id, kind: "pipeline", containerId: `hot-${n}`, role: "builder", slot: "build", stageId: "build", stageOrder: 0, round: 1, parentConversationId: null, createdAt: now }];
  initial.receipts[`receipt-${n}`] = { ...launched, pathCorrelation: null, failureReporting: undefined, createdAt: now, launchId: `receipt-${n}`, conversationId: id, key: { engine: "codex", sessionId: session }, state: "completed" };
}
const registrySha256 = crypto.createHash("sha256").update(JSON.stringify(initial)).digest("hex");
let registryPayloadReads = 0;
const registry = new SqliteAgentRegistryStore(path.join(root, "replay-registry.sqlite"), { initialSnapshot: initial, normalize: normalizeRegistry,
  onRowPayloadRead: (_collection: string, count: number) => { registryPayloadReads += count; } });
while (registry.archiveInactive(1000)) { /* Retained history uses the real archive. */ }
const retired = () => runStructuredHostRetirementSweep({ now: () => Date.parse(now), snapshot: () => registry.readOnlySnapshot().file,
  handoffRows: () => determined([]), orchestratorSeatConversations: () => determined(new Set()), revokedSeatConversations: () => determined(new Set()),
  publicationState: () => "ready", owned: () => false, durableEventTail: () => determined(0), realtimeBound: () => determined(false),
  transcriptStat: () => determined(null), processIdentity: () => determined("fixture"), bootEpoch: () => determined("fixture"), record: () => {} });
registerPipelineTick(async () => {});
let clock = Date.parse(now);
const ports = { ...defaultPipelinePorts(), now: () => new Date(clock).toISOString(), monotonicNow: () => performance.now(),
  exec: async () => ({ code: 1, stdout: "", stderr: "fixture unavailable" }), provisionExec: async () => ({ code: 1, stdout: "", stderr: "fixture unavailable" }),
  cpuAdmissionReconcile: async () => {}, cpuPressureHold: () => null, drainHold: () => null, durableTurnEvidence: async () => null, sourcePathAllowed: () => false,
  transcriptPresent: () => false, stageHostResident: async () => true, conversationAgentActive: async () => null, worktreePresent: () => false, scheduleTick: () => {} };
const decodeOwner = SqliteStateCollection.prototype as { decodeRow(json: string): unknown };
const originalDecode = decodeOwner.decodeRow;
let collectionDecodedBytes = 0;
decodeOwner.decodeRow = function (json: string) { collectionDecodedBytes += Buffer.byteLength(json); return originalDecode.call(this, json); };
const corpus = db.query("SELECT collection,count(*) AS rows,sum(length(value_json)) AS bytes FROM state_rows GROUP BY collection").all();
const digest = crypto.createHash("sha256");
for (const row of db.query("SELECT collection,row_key,value_json FROM state_rows ORDER BY collection,row_key").iterate()) digest.update(JSON.stringify(row));
const corpusSha256 = digest.digest("hex");
const startupMemberships = () => {
  if (mode === "before") return Object.entries(registry.readOnlySnapshot().file.memberships);
  return startup!.pipelineStartupMemberships({ readOnlySnapshot: () => registry.readOnlySnapshot().file });
};
const curation = () => mode === "before" ? memory.machinePass() : memory.machinePassAuthority();
const ownership = async () => {
  if (mode === "before") loadPipelinesForRetirement();
  else (await retirement!.pipelineRetirementReader())({ conversations: ["conversation_absent"], sessionId: "absent" });
};
const samples = [];
const measure = async (read: () => unknown | Promise<unknown>) => {
  const started = performance.now(), decoded = collectionDecodedBytes, registryReads = registryPayloadReads;
  performanceSpans.clear();
  await read();
  const spans = performanceSpans.snapshot().records;
  return { wallMs: performance.now() - started, collectionDecodedBytes: collectionDecodedBytes - decoded, registryPayloadReads: registryPayloadReads - registryReads,
    rawDecodedBytes: spans.filter((row: { site: number; bytes: number; rows: number }) => performanceSites[row.site] === "state.json").reduce((n: number, row: { site: number; bytes: number; rows: number }) => n + row.bytes, 0),
    pipelineCopies: spans.filter((row: { site: number; bytes: number; rows: number }) => performanceSites[row.site] === "pipeline.copy").reduce((n: number, row: { site: number; bytes: number; rows: number }) => n + row.rows, 0) };
};
const loadBefore = os.loadavg();
const limits: Array<{ level: number; cpu: string | null; memory: string | null }> = [];
if (process.platform === "linux") {
  const group = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (group) for (let dir = path.join("/sys/fs/cgroup", group), level = 0; dir.startsWith("/sys/fs/cgroup"); dir = path.dirname(dir), level++) {
    const read = (name: string) => { try { return fs.readFileSync(path.join(dir, name), "utf8").trim(); } catch { return null; } };
    limits.push({ level, cpu: read("cpu.max"), memory: read("memory.max") });
    if (dir === "/sys/fs/cgroup") break;
  }
}
const driverSha256 = crypto.createHash("sha256").update(fs.readFileSync(import.meta.path)).digest("hex");
const dependencyDigest = crypto.createHash("sha256");
for (const file of ["package.json", "bun.lock", "Dockerfile"]) dependencyDigest.update(file).update(fs.readFileSync(path.join(repo, file)));
const dependencySha256 = dependencyDigest.digest("hex");
const startedAt = new Date().toISOString();
try {
  // Cold observations are recorded independently; warm runs never conceal them.
  let coldLast = performance.now(); const coldGaps: number[] = [];
  const coldObserver = setInterval(() => { const at = performance.now(); coldGaps.push(Math.max(0, at - coldLast - 2)); coldLast = at; }, 2);
  await new Promise<void>(resolve => setImmediate(resolve));
  let cold;
  try {
    cold = { curator: await measure(curation), display: await measure(() => memory.machinePass()), ownership: await measure(ownership), registry: await measure(retired), startup: await measure(startupMemberships), controller: await measure(() => tickPipelinesController([], ports)) };
    await new Promise<void>(resolve => setTimeout(resolve, 4));
  } finally { clearInterval(coldObserver); }
  coldGaps.sort((a, b) => a - b);
  const coldLoop = { samples: coldGaps.length, p95Ms: coldGaps[Math.min(coldGaps.length - 1, Math.floor(coldGaps.length * .95))], maxMs: coldGaps.at(-1) };
  const replayGaps = [...coldGaps];
  for (let sample = 0; sample < 6; sample++) {
    let last = performance.now(), gaps: number[] = [];
    const observer = setInterval(() => { const at = performance.now(); gaps.push(Math.max(0, at - last - 2)); last = at; }, 2);
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      const curator = await measure(curation), display = await measure(() => memory.machinePass()), registryRead = await measure(retired), startupRead = await measure(startupMemberships), ownershipRead = await measure(ownership);
      // Progress edit invalidates one lane while background readers are active.
      const id = `hot-${sample % lanes}`;
      db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.stateDetail',?),row_revision=row_revision+1 WHERE collection='pipelines' AND row_key=?").run(`progress-${sample}`, id);
      db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines'").run();
      clock += 1000;
      const controller = await measure(() => tickPipelinesController([], ports));
      if (controller.pipelineCopies > 4) throw Error("controller selected more than four lanes");
      const refreshed = await measure(ownership);
      const lifecycle = await measure(async () => {
        const transient = record(`churn-${sample}`, true);
        db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive',?,?,2000,1,0)").run(transient.id, JSON.stringify(transient));
        if (mode === "after") {
          const held = await retirement!.pipelineRetirementReader();
          if (!held({ conversations: [`conversation_${transient.id}_15`] })) throw Error("new archive owner was missed");
          db.query("DELETE FROM state_rows WHERE collection='pipelines_archive' AND row_key=?").run(transient.id);
          let refused = false;
          try { held({ conversations: [`conversation_${transient.id}_15`] }); } catch { refused = true; }
          if (!refused) throw Error("stale lifecycle evidence was accepted");
          if ((await retirement!.pipelineRetirementReader())({ conversations: [`conversation_${transient.id}_15`] })) throw Error("deleted owner was retained");
        } else {
          loadPipelinesForRetirement();
          db.query("DELETE FROM state_rows WHERE collection='pipelines_archive' AND row_key=?").run(transient.id);
          loadPipelinesForRetirement();
        }
      });
      // Keep the observer through a post-work timer opportunity.
      await new Promise<void>(resolve => setTimeout(resolve, 4));
      if (!gaps.length) throw Error("missing loop observer evidence");
      replayGaps.push(...gaps);
      gaps = gaps.sort((a, b) => a - b);
      samples.push({ sample, curator, display, registry: registryRead, startup: startupRead, ownership: ownershipRead, controller, refreshed, lifecycle,
        loop: { samples: gaps.length, p95Ms: gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * .95))], maxMs: gaps.at(-1) } });
    } finally { clearInterval(observer); }
  }
  const fingerprint = crypto.createHash("sha256");
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file);
    else if (/\.tsx?$/.test(file) && !/\.(test|fixture)\./.test(file) && !file.includes("/fixtures/")) fingerprint.update(path.relative(repo, file)).update(fs.readFileSync(file));
  } };
  walk(path.join(repo, "src"));
  replayGaps.sort((a, b) => a - b);
  const loop = { samples: replayGaps.length, p95Ms: replayGaps[Math.min(replayGaps.length - 1, Math.floor(replayGaps.length * .95))], maxMs: replayGaps.at(-1) };
  console.log(JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), limits, mode, lanes, bun: Bun.version, driverSha256, dependencySha256, corpus, corpusSha256, registrySha256, sourceSha256: fingerprint.digest("hex"), load: { before: loadBefore, after: os.loadavg(), cpus: os.cpus().length }, cold, coldLoop, loop, samples }));
  if (mode === "after" && (!loop.samples || loop.p95Ms! > 50 || loop.maxMs! > 500)) process.exitCode = 1;
} finally { decodeOwner.decodeRow = originalDecode; registry.close(); db.close(); }
