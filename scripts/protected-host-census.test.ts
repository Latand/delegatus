import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { censusDescriber, censusSnapshot, readOnlyReferences } from "./protected-host-census";
import { agentLivenessSnapshot } from "../src/lib/lifecycle/liveness";
import { retainedLivenessFixture as nativeRetainedFixture } from "../src/lib/lifecycle/liveness.retained.fixture";
import { describeTranscriptPath } from "../src/lib/lifecycle/transcript";
import { historyHeadlessFlows, historyPipelineRef, readHistoryProjection } from "../src/lib/state/historyProjection";
import { statePath } from "../src/lib/configDir";
import { buildPipeline, loadArchivedPipelines, savePipelines, isStoredPipeline } from "../src/lib/pipelines/store";
import { isStoredFlow, loadFlows, saveFlows } from "../src/lib/flows/store";
import { publishRegistryBackendIdentity } from "../src/lib/agent/registryBackendIdentity";
import { projectInfoFromCwd } from "../src/lib/scanner/describe";
import type { AgentRegistryEntry, RegistryFile } from "../src/lib/agent/registry";
import type { Flow } from "../src/lib/flows/types";

const TARGET = "a".repeat(40);
const NOW = "2026-10-29T12:00:00.000Z";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const created: string[] = [];
afterEach(() => { for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "protected-census-")); created.push(root); return root; }
function retainedLivenessFixture(count = 12) {
  const fixture = nativeRetainedFixture(count);
  try { loadArchivedPipelines(); loadFlows(); return fixture; }
  catch (error) { fixture.close(); throw error; }
}
const sha = (file: string) => fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
const fields = (rows: Awaited<ReturnType<typeof censusSnapshot>>["conversations"]) => rows.filter(row => row.host.state === "alive")
  .map(row => [row.conversationId, row.host.state, row.host.kind, row.host.pid, row.turnState, row.pipeline && [row.pipeline.pipelineId, row.pipeline.stageId, row.pipeline.attempt]])
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function fixture() {
  const f = retainedLivenessFixture(12);
  const registry = f.registry.readOnlySnapshot();
  const base = structuredClone(registry.entries[f.worker.key]!);
  const conversation = structuredClone(registry.conversations[f.conversationId]!);
  const probe = { now: () => Date.parse(NOW), pidAlive: (pid: number) => pid !== 4004,
    processIdentity: (pid: number) => pid === 4005 ? null : "fixture-start" };
  const rows = [];
  for (const [index, kind] of ["structured", "settled", "receipt", "dead", "unknown", "headless"].entries()) {
    const pid = 4001 + index;
    const pathname = path.join(path.dirname(f.worker.transcript), `owner-${kind}.jsonl`);
    fs.writeFileSync(pathname, [
      { type: "session_meta", timestamp: NOW, payload: { id: `owner-${kind}`, cwd: "/repo" } },
      { type: "event_msg", timestamp: NOW, payload: { type: "task_started", turn_id: `turn-${kind}` } },
      ...(kind === "settled" ? [{ type: "event_msg", timestamp: NOW, payload: { type: "task_complete", turn_id: `turn-${kind}` } }] : []),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const entry: AgentRegistryEntry = { ...structuredClone(base), key: { engine: "codex", sessionId: `owner-${kind}` }, artifactPath: pathname,
      structuredHost: { ...base.structuredHost!, process: { pid, startIdentity: "fixture-start" } }, host: null };
    const id = `conversation_owner-${kind}`;
    const generation = { ...conversation.generations[0]!, id: entry.key.sessionId, path: pathname };
    rows.push({ kind, pid, pathname, entry, id, conversation: { ...structuredClone(conversation), id, generations: [generation] } });
  }
  const file = { ...registry, entries: {}, receipts: {}, conversations: {}, conversationAliases: {} } as RegistryFile;
  for (const row of rows) {
    file.conversations[row.id] = row.conversation as RegistryFile["conversations"][string];
    if (!["receipt", "headless"].includes(row.kind)) file.entries[`codex:${row.entry.key.sessionId}`] = row.entry;
  }
  const receipt = structuredClone(Object.values(registry.receipts)[0]!);
  const receiptRow = rows[2]!;
  Object.assign(receipt, { launchId: "receipt-only", state: "prompt-delivered", transport: "structured", admissionOwner: { pid: receiptRow.pid, startIdentity: "fixture-start" },
    conversationId: receiptRow.id, artifactPath: receiptRow.pathname, key: receiptRow.entry.key,
    verifiedHost: null, pane: null });
  file.receipts[receipt.launchId] = receipt;
  const flows = [{ id: "headless-flow", reviewerMode: "headless", rounds: [{ n: 1, reviewerPid: 4006,
    reviewerIdentity: "fixture-start", reviewerPath: rows[5]!.pathname, reviewerConversationId: rows[5]!.id }] }] as Flow[];
  const sources = { ...f.sources, probe, registrySnapshot: () => file, flows: () => flows,
    pipelines: () => [], describeTranscript: censusDescriber(file),
    workProcesses: () => [], now: () => Date.parse(NOW) };
  const catalog = rows.map(row => ({ ...f.files[0]!, path: row.pathname, conversationId: row.id, engine: "codex" as const, mtime: Date.parse(NOW) / 1000 }));
  return { f, file, rows, sources, catalog, close: f.close };
}

test("B-1: native census equals the product over every live structured, receipt and headless owner", async () => {
  const f = fixture();
  try {
    const answer = await censusSnapshot(f.sources, 1, TARGET, 30000);
    const baseline = await agentLivenessSnapshot({ liveOnly: true, limit: 200, evidenceDeadlineMs: 30000 }, { ...f.sources,
      describeTranscript: f.f.sources.describeTranscript, selectInventory: undefined, listFiles: async () => f.catalog });
    expect(fields(answer.conversations)).toEqual(fields(baseline.conversations));
    expect(answer.conversations.filter(row => row.host.state === "alive").map(row => row.host.kind).sort()).toEqual(["headless", "structured", "structured", "structured", "structured"]);
    expect(answer.conversations.filter(row => row.host.state === "alive").map(row => row.host.pid).sort()).toEqual([4001, 4002, 4003, 4005, 4006]);
    expect(answer.undescribedHostCount).toBe(0);
    expect(answer.selection.projected).toBe(0);
    expect(answer.selection.unreadable).toBe(0);
  } finally { f.close(); }
});

test("B-1: removing any census owner kind fails equivalence and marks missing protection", async () => {
  for (const kind of ["structured", "settled", "receipt", "headless"]) {
    const f = fixture();
    try {
      const baseline = await censusSnapshot(f.sources, 1, TARGET, 30000);
      const omitted = f.rows.find(row => row.kind === kind)!;
      const broken = await censusSnapshot({ ...f.sources, describeTranscript: async pathname => pathname === omitted.pathname ? null : f.sources.describeTranscript(pathname) }, 1, TARGET, 30000);
      expect(fields(broken.conversations)).not.toEqual(fields(baseline.conversations));
      expect(broken.undescribedHostCount).toBeGreaterThan(0);
    } finally { f.close(); }
  }
});

test("B-1: real registry and history stores agree with a completed production catalog and drained projection", async () => {
  const f = fixture();
  const previousFlows = loadFlows();
  let db: Database | undefined;
  let references: ReturnType<typeof readOnlyReferences> | undefined;
  const ids: string[] = [];
  try {
    f.f.peer.mutate(stored => {
      stored.entries = f.file.entries;
      stored.receipts = f.file.receipts;
      stored.conversations = f.file.conversations;
      stored.conversationAliases = {};
    });
    const pipelines = f.rows.map(row => {
      const stage = f.f.pipeline.stages[0]!;
      const pipeline = buildPipeline({ id: `census-${row.kind}`, task: "Census fixture", project: "fixture", repoDir: "/repo",
        srcPath: null, srcConversationId: null, now: NOW,
        stages: [{ ...structuredClone(stage), id: "build", next: "review" }, { ...structuredClone(stage), id: "review", next: null }] });
      pipeline.state = "running";
      const attempt = { ...structuredClone(f.f.pipeline.runs[0]!.attempts[0]!), conversationId: row.id, agentPath: row.pathname };
      pipeline.runs[0]!.attempts = [attempt, { ...structuredClone(attempt), n: 2, historical: true }];
      pipeline.runs[1]!.attempts = [{ ...structuredClone(attempt), historical: true }];
      expect(isStoredPipeline(pipeline)).toBe(true);
      ids.push(pipeline.id);
      return pipeline;
    });
    savePipelines(pipelines.filter(pipeline => pipeline.id !== "census-headless"));
    loadArchivedPipelines();
    db = new Database(statePath("state.sqlite"));
    for (const pipeline of pipelines) {
      expect(db.query("SELECT 1 FROM state_rows WHERE collection='pipelines_archive' AND row_key=?").get(pipeline.id)).toBeNull();
      db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES ('pipelines_archive',?,?,0,1,0)")
        .run(pipeline.id, JSON.stringify(pipeline));
    }
    const flow = { ...f.sources.flows()[0]!, project: "fixture", template: "implement-review-loop", cwd: "/repo",
      implementerPath: f.rows[0]!.pathname, baseRef: TARGET,
      roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } } };
    expect(isStoredFlow(flow)).toBe(true);
    saveFlows([flow as Flow]);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM history_pending").get()!.n).toBeGreaterThan(0);
    references = readOnlyReferences(db);
    const registry = f.f.registry.readOnlySnapshot();
    const memory = references.memory;
    const sources = { ...f.f.sources, probe: f.sources.probe, now: f.sources.now, workProcesses: f.sources.workProcesses };
    const answer = await censusSnapshot({ ...sources, registrySnapshot: () => registry, describeTranscript: censusDescriber(registry),
      pipelines: Object.assign(() => [], { forLiveness: async (targets: { conversationId: string | null; path: string }[]) => targets.map(target => historyPipelineRef(memory, target.conversationId, target.path)) }),
      flows: () => references!.flows as Flow[],
    }, 1, TARGET, 30000);
    f.f.files.splice(0, f.f.files.length, ...f.catalog);
    const baseline = await agentLivenessSnapshot({ liveOnly: true, limit: 200, evidenceDeadlineMs: 30000 }, sources);
    expect(fields(answer.conversations)).toEqual(fields(baseline.conversations));
    const alive = answer.conversations.filter(row => row.host.state === "alive");
    expect(alive.map(row => row.host.pid).sort()).toEqual([4001, 4002, 4003, 4005, 4006]);
    expect(alive.every(row => row.pipeline?.stageId === "build" && row.pipeline.attempt === 1)).toBe(true);
    expect(alive.find(row => row.host.kind === "headless")?.pipeline?.pipelineId).toBe("census-headless");
    expect(answer.undescribedHostCount).toBe(0);
    expect(answer.selection.matched).toBe(answer.selection.selected);
    const round = flow.rounds[0]!;
    saveFlows([{ ...flow, id: "Z-flow", rounds: [{ ...round, reviewerPid: 4006 }] } as Flow,
      { ...flow, id: "a-flow", rounds: [{ ...round, reviewerPid: 4007 }] } as Flow]);
    db.exec("UPDATE state_rows SET row_order=0 WHERE collection='flows'");
    const tied = readOnlyReferences(db);
    try {
      const pids = tied.flows.flatMap(flow => flow.rounds.map(round => round.reviewerPid));
      expect(pids).toEqual([4006, 4007]);
      await readHistoryProjection(() => null, { filename: statePath("state.sqlite") });
      // The census starts a fresh process: compare with the cold production
      // reader after a complete drain, rather than a previously warmed cache.
      const coldFile = path.join(f.f.directory, "cold-history.sqlite");
      db.query("VACUUM INTO ?").run(coldFile);
      const cold = new Database(coldFile, { readonly: true });
      try {
        const drained = historyHeadlessFlows(cold);
        expect(pids).toEqual(drained.flatMap(flow => flow.rounds.map(round => round.reviewerPid)));
      } finally { cold.close(); }
    } finally { tied.memory.close(); }
  } finally {
    references?.memory.close();
    if (db) {
      for (const id of ids) db.query("DELETE FROM state_rows WHERE collection='pipelines_archive' AND row_key=?").run(id);
      db.close();
    }
    saveFlows(previousFlows);
    f.close();
  }
});

test("B-1: pending open/archive references preserve runs, historical exclusion, deletion and path fallback", async () => {
  const retained = retainedLivenessFixture(12);
  const root = temporary();
  const filename = path.join(root, "state.sqlite");
  // The real writer supplies the complete state schema and pending row.
  const pipeline = structuredClone(retained.pipeline);
  const attempt = { ...pipeline.runs[0]!.attempts[0]!, conversationId: "conversation_census", agentPath: "/fixture/transcript" };
  pipeline.runs[0]!.attempts = [attempt, { ...attempt, n: 2, historical: true }];
  savePipelines([pipeline]);
  const source = new Database(statePath("state.sqlite"));
  source.query("VACUUM INTO ?").run(filename); source.close();
  const db = new Database(filename);
  try {
    const pendingBefore = db.query("SELECT * FROM history_pending ORDER BY collection,row_key").all();
    expect(pendingBefore.length).toBeGreaterThan(0);
    const overlay = readOnlyReferences(db);
    const ref = historyPipelineRef(overlay.memory, "conversation_census", "/absent");
    expect(ref).toMatchObject({ pipelineId: pipeline.id, stageId: "build", attempt: 1 });
    expect(historyPipelineRef(overlay.memory, null, attempt.agentPath)).toEqual(ref);
    overlay.memory.close();
    expect(db.query("SELECT * FROM history_pending ORDER BY collection,row_key").all()).toEqual(pendingBefore);
    const drained = await readHistoryProjection(db => historyPipelineRef(db, "conversation_census", "/absent"), { filename });
    expect(ref).toEqual(drained);
    const archive = structuredClone(pipeline);
    expect(isStoredPipeline(archive)).toBe(true);
    db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES ('pipelines_archive',?,?,999,1,1)").run(archive.id, JSON.stringify(archive));
    const newest = structuredClone(pipeline);
    newest.stages.push({ ...structuredClone(newest.stages[0]!), id: "review" });
    newest.runs.push({ stageId: "review", attempts: [structuredClone(attempt)] });
    expect(isStoredPipeline(newest)).toBe(true);
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?").run(JSON.stringify(newest), pipeline.id);
    for (const expected of ["review", "build", null]) {
      const overlay = readOnlyReferences(db);
      const actual = historyPipelineRef(overlay.memory, "conversation_census", "/absent");
      expect(actual?.stageId ?? null).toBe(expected);
      overlay.memory.close();
      expect(actual).toEqual(await readHistoryProjection(db => historyPipelineRef(db, "conversation_census", "/absent"), { filename }));
      db.query("DELETE FROM state_rows WHERE collection=? AND row_key=?").run(expected === "review" ? "pipelines" : "pipelines_archive", expected === "review" ? pipeline.id : archive.id);
    }
  } finally { db.close(); retained.close(); }
});

test("B-2: production transcript description preserves bytes for a newly observed worktree; default still persists", async () => {
  const root = temporary();
  const repo = path.join(root, "parent"), checkout = path.join(root, "arbitrary-checkout");
  fs.mkdirSync(path.join(repo, ".git/worktrees/fixture"), { recursive: true });
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${repo}/.git/worktrees/fixture\n`);
  fs.writeFileSync(path.join(repo, ".git/worktrees/fixture/commondir"), "../..\n");
  fs.writeFileSync(path.join(repo, ".git/worktrees/fixture/gitdir"), path.join(checkout, ".git") + "\n");
  fs.writeFileSync(path.join(repo, ".git/config"), "[core]\nrepositoryformatversion = 0\n[remote \"origin\"]\nurl = https://example.invalid/fixture/project.git\n");
  projectInfoFromCwd(repo);
  const transcript = path.join(root, "rollout-fixture.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: "readonly-fixture", cwd: checkout }, timestamp: NOW }) + "\n");
  const names = () => fs.readdirSync(process.env.LLV_STATE_DIR!).sort();
  const before = [sha(statePath("state.sqlite")), sha(statePath("state.sqlite-wal")), names()];
  const description = await describeTranscriptPath(transcript, { readOnly: true, roots: [["codex-sessions", root]] });
  expect(description?.engine).toBe("codex");
  expect([sha(statePath("state.sqlite")), sha(statePath("state.sqlite-wal")), names()]).toEqual(before);
  await describeTranscriptPath(transcript, { roots: [["codex-sessions", root]] });
  expect(sha(statePath("state.sqlite-wal"))).not.toBe(before[1]);
});

test("B-2: complete census child leaves database, WAL, pending rows and files unchanged", () => {
  const f = retainedLivenessFixture(12);
  try {
    const root = temporary();
    const checkout = path.join(root, "new-checkout");
    fs.mkdirSync(checkout);
    fs.mkdirSync(path.join(root, "parent/.git/worktrees/new"), { recursive: true });
    fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${root}/parent/.git/worktrees/new\n`);
    const records = fs.readFileSync(f.worker.transcript, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const metadata = records.find(row => row.type === "session_meta");
    expect(metadata).toBeDefined();
    metadata.payload.cwd = checkout;
    fs.writeFileSync(f.worker.transcript, records.map(row => JSON.stringify(row)).join("\n") + "\n");
    const source = new Database(statePath("state.sqlite"));
    source.query("VACUUM INTO ?").run(path.join(root, "state.sqlite")); source.close();
    const registrySource = new Database(f.dataset.filename, { readonly: true });
    registrySource.query("VACUUM INTO ?").run(path.join(root, "agent-registry.sqlite")); registrySource.close();
    publishRegistryBackendIdentity(path.join(root, "agent-registry.json"), "sqlite", path.join(root, "agent-registry.sqlite"));
    const db = new Database(path.join(root, "state.sqlite"));
    db.exec("PRAGMA journal_mode=WAL");
    db.query("UPDATE state_rows SET value_json=value_json WHERE collection='pipelines'").run();
    const pending = db.query("SELECT * FROM history_pending ORDER BY collection,row_key").all();
    expect(pending.length).toBeGreaterThan(0);
    const before = [sha(path.join(root, "state.sqlite")), sha(path.join(root, "state.sqlite-wal"))];
    const files = fs.readdirSync(root, { recursive: true }).map(String).sort();
    const env: NodeJS.ProcessEnv = { ...process.env, LLV_STATE_DIR: root, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
    delete env.LLV_STATE_OWNER;
    delete env.LLV_AGENT_REGISTRY_SQLITE;
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/protected-host-census.ts"), TARGET, "30000"], { cwd: ROOT, env, encoding: "utf8", timeout: 10000 });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).conversations).toHaveLength(1);
    expect([sha(path.join(root, "state.sqlite")), sha(path.join(root, "state.sqlite-wal"))]).toEqual(before);
    expect(db.query("SELECT * FROM history_pending ORDER BY collection,row_key").all()).toEqual(pending);
    expect(fs.readdirSync(root, { recursive: true }).map(String).filter(name => !name.endsWith("-shm")).sort()).toEqual(files.filter(name => !name.endsWith("-shm")));
    db.close();
  } finally { f.close(); }
});

test("B-3: actual census child refuses absent state, schema and registry errors with no rows", () => {
  const f = retainedLivenessFixture(12);
  try {
  for (const kind of ["absent", "schema", "migration", "collection-version", "import", "registry"]) {
    const root = temporary();
    if (kind !== "absent") {
      const registrySource = new Database(f.dataset.filename, { readonly: true });
      registrySource.query("VACUUM INTO ?").run(path.join(root, "agent-registry.sqlite")); registrySource.close();
      publishRegistryBackendIdentity(path.join(root, "agent-registry.json"), "sqlite", path.join(root, "agent-registry.sqlite"));
      const source = new Database(statePath("state.sqlite"));
      source.query("VACUUM INTO ?").run(path.join(root, "state.sqlite")); source.close();
      if (kind === "schema") fs.writeFileSync(path.join(root, "state.sqlite"), "malformed database");
      if (kind === "registry") fs.writeFileSync(path.join(root, "agent-registry.sqlite"), "malformed database");
      if (kind === "migration") {
        const old = new Database(path.join(root, "state.sqlite")); old.exec("DROP INDEX history_conversation"); old.close();
      }
      if (kind === "collection-version" || kind === "import") {
        const old = new Database(path.join(root, "state.sqlite"));
        old.exec(kind === "import" ? "DELETE FROM state_collections WHERE collection='flows'"
          : "UPDATE state_collections SET schema_version=2 WHERE collection='flows'");
        old.close();
      }
    }
    const env: NodeJS.ProcessEnv = { ...process.env, LLV_STATE_DIR: root, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
    delete env.LLV_STATE_OWNER;
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/protected-host-census.ts"), TARGET, "30000"], { cwd: ROOT, env, encoding: "utf8", timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  }
  } finally { f.close(); }
});

test("B-2: census refuses an operator-shaped home without an explicit state directory", () => {
  const root = temporary();
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "home/.config") };
  delete env.LLV_STATE_DIR;
  delete env.LLV_STATE_OWNER;
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/protected-host-census.ts"), TARGET, "30000"], { cwd: ROOT, env, encoding: "utf8", timeout: 10000 });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(fs.readdirSync(root)).toEqual([]);
});

test("B-4: unreadable native evidence and missing descriptions report incompleteness", async () => {
  for (const missing of [false, true]) {
    const f = fixture();
    try {
      const sources = { ...f.sources, ...(missing ? { describeTranscript: async () => null } : { transcriptEvidence: async () => null }) };
      const answer = await censusSnapshot(sources, 1, TARGET, 30000);
      expect(answer.undescribedHostCount + answer.selection.unreadable + answer.selection.projected).toBeGreaterThan(0);
    } finally { f.close(); }
  }
});

test("live census: readable older hosts remain selected beside their conversation's current host", async () => {
  const f = fixture();
  try {
    const base = f.rows[0]!;
    fs.utimesSync(base.pathname, new Date(NOW), new Date(NOW));
    const pathname = path.join(path.dirname(base.pathname), "older-generation.jsonl");
    fs.copyFileSync(base.pathname, pathname);
    fs.utimesSync(pathname, new Date(Date.parse(NOW) - 1000), new Date(Date.parse(NOW) - 1000));
    const entry = structuredClone(base.entry);
    entry.artifactPath = pathname;
    entry.key.sessionId = "older-generation";
    entry.structuredHost!.process = { pid: 5000, startIdentity: "fixture-start" };
    f.file.entries["codex:older-generation"] = entry;
    f.file.conversations[base.id]!.generations.unshift({ ...base.conversation.generations[0]!, path: pathname, id: "older-generation" });
    const answer = await censusSnapshot({ ...f.sources, describeTranscript: censusDescriber(f.file) }, 1, TARGET, 30000);
    expect(answer.conversations.filter(row => row.conversationId === base.id).map(row => row.host.pid).sort()).toEqual([4001, 5000]);
    expect(answer.measurements.foldedConversations).toBe(1);
    expect(answer.unselectedCount).toBe(0);
    expect(answer.selection.matched).toBe(answer.selection.selected);
    expect(answer.undescribedHostCount).toBe(0);
  } finally { f.close(); }
});

test.each(["settled", "receipt", "headless"])("live census: folded %s ownership keeps its own process", async kind => {
  const f = fixture();
  try {
    const current = f.rows[0]!;
    const older = f.rows.find(row => row.kind === kind)!;
    fs.utimesSync(current.pathname, new Date(NOW), new Date(NOW));
    fs.utimesSync(older.pathname, new Date(Date.parse(NOW) - 1000), new Date(Date.parse(NOW) - 1000));
    delete f.file.conversations[older.id];
    f.file.conversations[current.id]!.generations.unshift(older.conversation.generations[0]!);
    if (kind === "receipt") f.file.receipts["receipt-only"]!.conversationId = current.id as `conversation_${string}`;
    const flows = f.sources.flows().map(flow => ({ ...flow, rounds: flow.rounds.map(round => ({ ...round,
      ...(kind === "headless" ? { reviewerConversationId: current.id as `conversation_${string}` } : {}),
    })) }));
    const answer = await censusSnapshot({ ...f.sources, flows: () => flows, describeTranscript: censusDescriber(f.file) }, 1, TARGET, 30000);
    expect(answer.conversations.filter(row => row.conversationId === current.id).map(row => row.host.pid).sort()).toEqual([current.pid, older.pid]);
    expect(answer.undescribedHostCount).toBe(0);
    expect(answer.unselectedCount).toBe(0);
    expect(answer.selection.projected + answer.selection.unreadable).toBe(0);
  } finally { f.close(); }
});

test("live census: setup without an artifact is excluded, a real pathless host remains incomplete", async () => {
  const f = fixture();
  try {
    const setup = structuredClone(f.file.receipts["receipt-only"]!);
    Object.assign(setup, { launchId: "setup-only", conversationId: f.rows[0]!.id, artifactPath: null,
      admissionOwner: { pid: 6000, startIdentity: "fixture-start" } });
    f.file.receipts[setup.launchId] = setup;
    const ready = await censusSnapshot(f.sources, 1, TARGET, 30000);
    expect(ready.undescribedHostCount).toBe(0);
    const owner: AgentRegistryEntry = structuredClone(f.rows[0]!.entry);
    owner.key.sessionId = "pathless-host";
    owner.artifactPath = "";
    owner.structuredHost!.process = { pid: 6001, startIdentity: "fixture-start" };
    f.file.entries["codex:pathless-host"] = owner;
    const missing = await censusSnapshot(f.sources, 1, TARGET, 30000);
    expect(missing.undescribedHostCount).toBe(1);
  } finally { f.close(); }
});

test("live census: duplicate registry records count one physical owner", async () => {
  const f = fixture();
  try {
    const original = f.rows[0]!;
    const duplicate = structuredClone(original.entry);
    duplicate.key.sessionId = "duplicate-owner";
    f.file.entries["codex:duplicate-owner"] = duplicate;
    const answer = await censusSnapshot(f.sources, 1, TARGET, 30000);
    expect(answer.measurements.owners).toBe(5);
    expect(answer.conversations.filter(row => row.host.pid === original.pid)).toHaveLength(1);
    expect(answer.undescribedHostCount + answer.unselectedCount).toBe(0);
  } finally { f.close(); }
});

test("live census: a folded headless owner without a path retains the native conversation fallback", async () => {
  const f = fixture();
  try {
    const current = f.rows[0]!;
    const flows = f.sources.flows().map(flow => ({ ...flow, rounds: flow.rounds.map(round => ({ ...round,
      reviewerPath: null, reviewerConversationId: current.id as `conversation_${string}`,
    })) }));
    const answer = await censusSnapshot({ ...f.sources, flows: () => flows }, 1, TARGET, 30000);
    expect(answer.conversations.filter(row => row.conversationId === current.id).map(row => row.host.pid).sort()).toEqual([4001, 4006]);
    expect(answer.undescribedHostCount + answer.unselectedCount).toBe(0);
  } finally { f.close(); }
});

test("live census: a missing recorded transcript counts one undescribed host and still refuses capture", async () => {
  const f = fixture();
  try {
    // Both the default session home and a managed account home can lose a
    // recorded artifact. The native describer uses the recorded path directly.
    for (const row of [f.rows[0]!, f.rows[1]!]) fs.unlinkSync(row.pathname);
    const answer = await censusSnapshot(f.sources, 1, TARGET, 30000);
    expect(answer.undescribedHostCount).toBe(2);
    expect(answer.conversations.some(row => [4001, 4002].includes(row.host.pid ?? 0))).toBe(false);
    const check = spawnSync("python3", ["-c", "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('deploy',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.complete_activity(json.load(sys.stdin))", path.join(ROOT, "scripts/deploy-checkout.py")],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, input: JSON.stringify(answer), encoding: "utf8", timeout: 10000 });
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain("protected activity capture incomplete");
    expect(fs.existsSync(path.join(ROOT, "scripts/__pycache__"))).toBe(false);
  } finally { f.close(); }
});

test("B-4: more than 200 owners never claim completeness", async () => {
  const f = fixture();
  try {
    const base = f.rows[0]!;
    for (let index = 0; index < 202; index++) {
      const pid = 5000 + index;
      const pathname = path.join(path.dirname(base.pathname), `extra-${index}.jsonl`);
      fs.copyFileSync(base.pathname, pathname);
      const entry = structuredClone(base.entry);
      entry.artifactPath = pathname;
      entry.key.sessionId = `extra-${index}`;
      entry.structuredHost!.process = { pid, startIdentity: "fixture-start" };
      f.file.entries[`codex:${entry.key.sessionId}`] = entry;
      const generation = { ...base.conversation.generations[0]!, path: pathname, id: entry.key.sessionId };
      f.file.conversations[`conversation_extra-${index}`] = { ...structuredClone(base.conversation), id: `conversation_extra-${index}`, generations: [generation] } as never;
    }
    const answer = await censusSnapshot({ ...f.sources, describeTranscript: censusDescriber(f.file) }, 1, TARGET, 30000);
    expect(answer.unselectedCount + answer.undescribedHostCount).toBeGreaterThan(0);
    expect(answer.selection.matched).toBeGreaterThan(200);
  } finally { f.close(); }
});

test("B-4: a tail that misses the evidence deadline is projected and refused", async () => {
  const f = fixture();
  let now = Date.parse(NOW);
  try {
    const answer = await censusSnapshot({ ...f.sources, now: () => now, transcriptEvidence: async () => {
      now += 2;
      return null;
    } }, 1, TARGET, 1);
    expect(answer.selection.projected).toBeGreaterThan(0);
    expect(answer.conversations.some(row => row.evidenceSource === "projection")).toBe(true);
  } finally { f.close(); }
});
