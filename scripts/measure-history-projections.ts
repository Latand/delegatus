/** Run serially through gate-slot in isolated exports. Seed once, then copy
 * that corpus for each base/head process. Output contains aggregates only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { AgentRegistry, normalizeRegistry } from "../src/lib/agent/registry";
import { SqliteAgentRegistryStore } from "../src/lib/agent/sqliteRegistryStore";
import { buildRegistryPerformanceDataset, REGISTRY_PERFORMANCE_SHAPE } from "../src/lib/agent/registryPerformanceDataset";
import { AccountMigrationController, syncCompatibilityRouting } from "../src/lib/accounts/migration/controller";
import { conversationCwdStatus } from "../src/lib/pipelines/worktreeSweep";
import { RuntimeJournal } from "../src/runtime-host/journal";
import type { FileEntry } from "../src/lib/types";

const at = Date.parse("2026-10-28T00:00:00Z");
assert(process.env.LLV_STATE_DIR && process.env.LLV_VIEWER_CONTROL_URL === "http://127.0.0.1:1");
const [mode, corpus] = process.argv.slice(2);
assert(corpus);
if (mode === "seed") {
  fs.mkdirSync(corpus, { recursive: true });
  const dataset = buildRegistryPerformanceDataset(path.join(corpus, "registry"), {
    ...REGISTRY_PERFORMANCE_SHAPE, conversations: 13_204, entries: 11_986, receipts: 13_368, deliveryOperationOwners: 20_376,
    transcripts: 3150,
  });
  fs.writeFileSync(path.join(corpus, "scan.json"), JSON.stringify(dataset.conversationPaths));
  const registry = new AgentRegistry(path.join(corpus, "seed.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename: dataset.filename,
  });
  fs.writeFileSync(path.join(corpus, "registry.json"), JSON.stringify(registry.snapshot()));
  registry.close();
  const journal = new RuntimeJournal(path.join(corpus, "journal.sqlite"), { now: () => at });
  journal.close();
  const db = new Database(path.join(corpus, "journal.sqlite"));
  db.exec("BEGIN");
  const insert = db.query("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq,updated_at) VALUES ('session',?,1,?,?,?)");
  for (let index = 0; index < 11_958; index++) {
    const active = index < 1091;
    const running = index < 4;
    const id = `conversation-${String(index).padStart(5, "0")}`;
    const value = { conversationId: id, sessionKey: { engine: "codex", sessionId: `session-${index}` }, revision: 1,
      hostKind: "codex-app-server", host: active ? "hosted" : "dead", turn: running ? "running" : "idle",
      provenance: "structured", capabilities: {}, attentionIds: [], recentReceipts: [],
      liveTurn: { turnId: `turn-${index}`, text: "Synthetic retained turn. ".repeat(running ? 120 : 2500) },
      voiceDeliveries: [{ deliveryId: `voice-${index}`, turnId: `turn-${index}`, ready: true, responses: [{ responseId: "response", text: "Synthetic voice. ".repeat(260) }] }],
    };
    insert.run(id, JSON.stringify(value), index + 1, at);
  }
  db.exec("COMMIT"); db.close();
  const hashes = Object.fromEntries(["registry.json", "journal.sqlite", "scan.json"].map(file => [file,
    createHash("sha256").update(fs.readFileSync(path.join(corpus, file))).digest("hex")]));
  fs.writeFileSync(path.join(corpus, "manifest.json"), JSON.stringify({ registryRows: dataset.rows, registryPayloadBytes: dataset.payloadBytes,
    runtimeSessions: 11_958, activeRuntimeSessions: 1091, runningRuntimeSessions: 4, hashes }, null, 2));
  console.log(fs.readFileSync(path.join(corpus, "manifest.json"), "utf8"));
} else {
  assert.equal(mode, "run");
  const root = process.env.LLV_STATE_DIR!;
  fs.cpSync(corpus, path.join(root, "corpus"), { recursive: true });
  const copy = path.join(root, "corpus");
  const runtimeReader: { journal?: RuntimeJournal } = {};
  let payloadReads = 0;
  let payloadParses = 0;
  const readIo = () => Number(/^rchar:\s+(\d+)/m.exec(fs.readFileSync("/proc/self/io", "utf8"))![1]);
  async function measure(site: string, kind: string, work: () => unknown) {
    const before = { reads: payloadReads, parses: payloadParses, runtime: runtimeReader.journal?.snapshotProjectionReads ?? 0 };
    const reads = readIo(), cpu = process.cpuUsage(), start = performance.now(), load = os.loadavg();
    const value = await work();
    const ms = performance.now() - start, used = process.cpuUsage(cpu);
    const digest = createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value) ?? "undefined").digest("hex");
    console.log(JSON.stringify({ site, kind, ms, cpuMs: (used.user + used.system) / 1000, readBytes: readIo() - reads, load, digest,
      registryPayloads: payloadReads - before.reads, registryParses: payloadParses - before.parses,
      runtimePayloads: typeof runtimeReader.journal?.snapshotProjectionReads === "number" ? runtimeReader.journal.snapshotProjectionReads - before.runtime : null }));
    return value;
  }
  const json = new AgentRegistry(path.join(copy, "registry.json"), undefined, undefined, { sqliteMode: "off", now: () => at });
  await measure("registry-json", "cold", () => Object.keys(json.readOnlySnapshot().conversations).length);
  await measure("registry-json", "unchanged", () => Object.keys(json.readOnlySnapshot().conversations).length);
  json.close();
  const filename = path.join(copy, "registry", "agent-registry.sqlite");
  // The dataset's returned filename is recorded independently of naming.
  const sqliteFile = fs.readdirSync(path.join(copy, "registry")).find(name => name.endsWith(".sqlite"))!;
  const sqliteFilename = fs.existsSync(filename) ? filename : path.join(copy, "registry", sqliteFile);
  const registry = new AgentRegistry(path.join(copy, "sqlite.json"), undefined, undefined, { sqliteMode: "sqlite", sqliteFilename, now: () => at,
    onSqliteRowPayloadRead: (_collection, count) => { payloadReads += count; }, onSqliteRowPayloadParse: () => { payloadParses++; } });
  const writer = new SqliteAgentRegistryStore(sqliteFilename, { initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }), normalize: normalizeRegistry });
  await measure("migration-routing", "cold", () => syncCompatibilityRouting(registry));
  await registry.prepareReadOnlySnapshot();
  await measure("registry-sqlite", "unchanged", () => registry.readOnlySnapshot().engineRouting);
  writer.mutate(file => { file.engineRouting.codex.revision++; }, false);
  await measure("registry-sqlite", "metadata-change", () => registry.readOnlySnapshot().engineRouting);
  await measure("migration-routing", "unchanged", () => syncCompatibilityRouting(registry));
  const files: FileEntry[] = (JSON.parse(fs.readFileSync(path.join(copy, "scan.json"), "utf8")) as string[]).map(pathname => ({ path: pathname,
    engine: "codex", parent: null, size: 1, mtime: 1 } as FileEntry));
  let contextReads = 0;
  const activity = registry.activityConversationSnapshot.bind(registry);
  registry.activityConversationSnapshot = (...args) => { contextReads++; return activity(...args); };
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files, projectCatalog: [], complete: true }),
    reconcileInventory: async () => ({ conversations: {}, entries: {}, receipts: {} } as ReturnType<AgentRegistry["readOnlySnapshot"]>),
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
    reconcileMigrationCycle: async () => {},
  });
  await controller.poll();
  contextReads = 0;
  await measure("migration-controller", "unchanged", () => controller.poll());
  console.log(JSON.stringify({ site: "migration-controller", contextReads }));
  const cursorPaths = [...files].sort((left, right) => left.path.localeCompare(right.path)).slice(64, 96);
  const selected = new Set(cursorPaths.map(file => file.path));
  const changedFiles = files.map(file => selected.has(file.path) ? { ...file, size: file.size + 1 } : file);
  files.splice(0, files.length, ...changedFiles);
  contextReads = 0;
  await measure("migration-controller", "changed-catalog", () => controller.poll());
  console.log(JSON.stringify({ site: "migration-controller", contextReads }));
  await measure("worktree-cwd-deferred", "unchanged", () => conversationCwdStatus(registry.readOnlySnapshot(), at, () => true));
  writer.close(); registry.close();
  const journal = new RuntimeJournal(path.join(copy, "journal.sqlite"), { now: () => at });
  runtimeReader.journal = journal;
  // Finish the existing asynchronous metadata migration before each measured
  // pass; it is independent of the snapshot projection being compared.
  const deadline = performance.now() + 120_000;
  while (!(journal as unknown as { sessionHostMetadata: { ready: boolean } }).sessionHostMetadata.ready) {
    assert(performance.now() < deadline, "session metadata did not settle");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  journal.snapshot(); journal.snapshotJson(); journal.snapshotJson([]);
  await measure("journal-snapshot", "unchanged", () => journal.snapshot());
  await measure("journal-json", "unchanged", () => journal.snapshotJson());
  await measure("journal-summary", "unchanged", () => journal.snapshotJson([]));
  journal.append({ scope: { type: "session", id: "conversation-00000" }, kind: "session-status",
    payload: { conversationId: "conversation-00000", host: "hosted", turn: "idle" } });
  await measure("journal-snapshot", "one-row-change", () => journal.snapshot());
  await measure("journal-json", "one-row-change", () => journal.snapshotJson());
  await measure("journal-summary", "one-row-change", () => journal.snapshotJson([]));
  console.log(JSON.stringify({ site: "journal", selectedSessions: journal.snapshot().sessions.length,
    projectionReads: (journal as unknown as { snapshotProjectionReads?: number }).snapshotProjectionReads ?? null }));
  journal.close();
}
