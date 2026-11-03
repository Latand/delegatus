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
import { retainedLivenessFixture } from "../src/lib/lifecycle/liveness.retained.fixture";
import { describeTranscriptPath } from "../src/lib/lifecycle/transcript";
import { historyPipelineRef, readHistoryProjection } from "../src/lib/state/historyProjection";
import { statePath } from "../src/lib/configDir";
import { savePipelines, isStoredPipeline } from "../src/lib/pipelines/store";
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
  for (const [index, kind] of ["structured", "tmux", "receipt", "dead", "unknown", "headless"].entries()) {
    const pid = 4001 + index;
    const pathname = path.join(path.dirname(f.worker.transcript), `owner-${kind}.jsonl`);
    fs.writeFileSync(pathname, [
      { type: "session_meta", timestamp: NOW, payload: { id: `owner-${kind}`, cwd: "/repo" } },
      { type: "event_msg", timestamp: NOW, payload: { type: "task_started", turn_id: `turn-${kind}` } },
      ...(kind === "tmux" ? [{ type: "event_msg", timestamp: NOW, payload: { type: "task_complete", turn_id: `turn-${kind}` } }] : []),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const entry: AgentRegistryEntry = { ...structuredClone(base), key: { engine: "codex", sessionId: `owner-${kind}` }, artifactPath: pathname,
      structuredHost: { ...base.structuredHost!, process: { pid, startIdentity: "fixture-start" } }, host: null };
    if (kind === "tmux") {
      entry.structuredHost = null;
      entry.host = { kind: "tmux", endpoint: "/synthetic/socket", server: { pid: 4999, startIdentity: "fixture-start" },
        paneId: "%1", panePid: { pid, startIdentity: "fixture-start" }, agent: { pid, startIdentity: "fixture-start" }, windowName: "fixture", argv: [] };
    }
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

test("B-1: native census equals the product over every live structured, tmux, receipt and headless owner", async () => {
  const f = fixture();
  try {
    const answer = await censusSnapshot(f.sources, 1, TARGET, 30000);
    const baseline = await agentLivenessSnapshot({ liveOnly: true, limit: 200, evidenceDeadlineMs: 30000 }, { ...f.sources,
      describeTranscript: f.f.sources.describeTranscript, selectInventory: undefined, listFiles: async () => f.catalog });
    expect(fields(answer.conversations)).toEqual(fields(baseline.conversations));
    expect(answer.conversations.filter(row => row.host.state === "alive").map(row => row.host.kind).sort()).toEqual(["headless", "structured", "structured", "structured", "tmux"]);
    expect(answer.conversations.filter(row => row.host.state === "alive").map(row => row.host.pid).sort()).toEqual([4001, 4002, 4003, 4005, 4006]);
    expect(answer.undescribedHostCount).toBe(0);
    expect(answer.selection.projected).toBe(0);
    expect(answer.selection.unreadable).toBe(0);
  } finally { f.close(); }
});

test("B-1: removing any census owner kind fails equivalence and marks missing protection", async () => {
  for (const kind of ["structured", "tmux", "receipt", "headless"]) {
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
  for (const kind of ["absent", "schema", "migration", "registry"]) {
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

test("B-4: more than 200 owners and folded live generations never claim completeness", async () => {
  for (const folded of [false, true]) {
    const f = fixture();
    try {
      const base = f.rows[0]!;
      for (let index = 0; index < (folded ? 1 : 202); index++) {
        const pid = 5000 + index;
        const pathname = path.join(path.dirname(base.pathname), `extra-${index}.jsonl`);
        fs.copyFileSync(base.pathname, pathname);
        const entry = structuredClone(base.entry);
        entry.artifactPath = pathname;
        entry.key.sessionId = `extra-${index}`;
        entry.structuredHost!.process = { pid, startIdentity: "fixture-start" };
        f.file.entries[`codex:${entry.key.sessionId}`] = entry;
        const generation = { ...base.conversation.generations[0]!, path: pathname, id: entry.key.sessionId };
        if (folded) f.file.conversations[base.id]!.generations.push(generation);
        else f.file.conversations[`conversation_extra-${index}`] = { ...structuredClone(base.conversation), id: `conversation_extra-${index}`, generations: [generation] } as never;
      }
      const answer = await censusSnapshot({ ...f.sources, describeTranscript: censusDescriber(f.file) }, 1, TARGET, 30000);
      expect(answer.unselectedCount + answer.undescribedHostCount).toBeGreaterThan(0);
      if (folded) expect(answer.measurements.foldedConversations).toBe(1);
      else expect(answer.selection.matched).toBeGreaterThan(200);
    } finally { f.close(); }
  }
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
