import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPipeline, isStoredPipeline, loadPipelinesForRetirement, savePipelines } from "./store";
import { pipelineRetirementReader } from "./retirementEvidence";
import { pipelineHostHasLiveWork } from "./hostRetirement";
import { performanceSpans, performanceSites } from "@/lib/performanceSpans";
import type { Pipeline } from "./types";

const roots: string[] = [];
const prior = process.env.LLV_STATE_DIR;
afterEach(() => {
  if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-evidence-")); roots.push(root);
  process.env.LLV_STATE_DIR = root;
  const lane = buildPipeline({ id: "owner", task: "Fixture", project: "fixture", repoDir: "/fixture", srcPath: null, srcConversationId: null,
    now: "2026-10-01T00:00:00Z", stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } }] });
  lane.state = "running";
  lane.runs[0]!.attempts = [{ n: 1, state: "running", effectiveRole: lane.stages[0]!.effectiveRole,
    historical: false, launchId: "launch-owner", conversationId: "conversation_owner", sessionId: "session-owner", agentPath: "/fixture/owner.jsonl", paneId: null,
    flowId: null, startedAt: lane.createdAt, completedAt: null, input: null, activatedBy: null, output: null, error: null, verdict: null }];
  expect(isStoredPipeline(lane)).toBe(true);
  savePipelines([lane]);
  return { root, lane, db: new Database(path.join(root, "state.sqlite")) };
}
const target = { conversations: ["conversation_owner"], sessionId: "session-owner", agentPath: "/fixture/owner.jsonl" };
function decodedRows() { return performanceSpans.snapshot().records.filter(row => performanceSites[row.site] === "state.json").reduce((n, row) => n + row.rows, 0); }

test("retirement target reads match the full predicate and warm decoding stays flat across tenfold history", async () => {
  const f = setup();
  try {
    for (const size of [10, 100]) {
      for (let n = 0; n < size; n++) {
        const row = { ...buildPipeline({ ...f.lane, state: "provisioning", id: `history-${n}`, now: f.lane.createdAt }), state: "running", srcConversationId: null,
          runs: [{ stageId: "build", attempts: [{ ...f.lane.runs[0]!.attempts[0]!, conversationId: `conversation_history_${n}`, sessionId: `session-${n}`, agentPath: `/fixture/${n}.jsonl` }] }] };
        f.db.query("INSERT OR REPLACE INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive',?,?,?,1,0)")
          .run(row.id, JSON.stringify(row), n);
      }
      const reader = await pipelineRetirementReader();
      const all = loadPipelinesForRetirement();
      for (const selected of [target, { conversations: ["missing"] }, { conversations: [], sessionId: "session-owner" }, { conversations: [], agentPath: target.agentPath }]) {
        expect(reader(selected)).toBe(pipelineHostHasLiveWork(all, { conversationId: selected.conversations[0] ?? null, sessionId: selected.sessionId, agentPath: selected.agentPath ?? null, paneId: null }));
      }
      performanceSpans.clear();
      const warm = await pipelineRetirementReader();
      expect(warm(target)).toBe(true);
      expect(decodedRows()).toBe(0);
      // A held witness cannot survive even an unrelated committed write.
      f.db.query("UPDATE state_rows SET row_revision=row_revision+1 WHERE collection='pipelines' AND row_key='owner'").run();
      expect(() => warm(target)).toThrow("changed");
      performanceSpans.clear();
      expect((await pipelineRetirementReader())(target)).toBe(true);
      expect(decodedRows()).toBe(1);
    }
  } finally { f.db.close(); }
});

test.each(["malformed", "invalid-json", "duplicate", "tracking", "partial"] as const)("retirement refuses %s evidence and recovers after repair", async kind => {
  const f = setup();
  try {
    const reader = await pipelineRetirementReader();
    if (kind === "malformed") f.db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive','bad','{}',1,1,0)").run();
    if (kind === "invalid-json") f.db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive','bad','{broken',1,1,0)").run();
    if (kind === "duplicate") f.db.query("INSERT INTO state_rows SELECT 'pipelines_archive',row_key,value_json,row_order,row_revision,controller_active FROM state_rows WHERE collection='pipelines'").run();
    if (kind === "tracking") f.db.exec("DROP TRIGGER pipeline_evidence_update");
    if (kind === "partial") f.db.query("DELETE FROM state_collections WHERE collection='pipelines_archive'").run();
    expect(() => reader(target)).toThrow("changed");
    await expect(pipelineRetirementReader()).rejects.toThrow();
    if (kind === "malformed" || kind === "invalid-json" || kind === "duplicate") {
      f.db.query("DELETE FROM state_rows WHERE collection='pipelines_archive'").run();
      expect((await pipelineRetirementReader())(target)).toBe(true);
    }
  } finally { f.db.close(); }
});

test("a peer archive edit and deletion revoke old evidence and the next read answers current ownership", async () => {
  const f = setup();
  try {
    const first = await pipelineRetirementReader();
    f.db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='owner'").run(JSON.stringify({ ...f.lane, runs: [{ stageId: "build", attempts: [] }], state: "closed", cursor: null }));
    expect(() => first(target)).toThrow("changed");
    expect((await pipelineRetirementReader())(target)).toBe(false);
    f.db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('pipelines_archive','archived',?,1,1,0)").run(JSON.stringify({ ...buildPipeline({ ...f.lane, state: "provisioning", id: "archived", now: f.lane.createdAt }), state: "running", runs: f.lane.runs }));
    const archived = await pipelineRetirementReader(); expect(archived(target)).toBe(true);
    f.db.query("DELETE FROM state_rows WHERE collection='pipelines_archive'").run();
    expect(() => archived(target)).toThrow("changed");
    expect((await pipelineRetirementReader())(target)).toBe(false);
  } finally { f.db.close(); }
});


test("a fresh process validates durable ownership independently of the previous reader cache", async () => {
  const f = setup();
  try {
    const warm = await pipelineRetirementReader(); expect(warm(target)).toBe(true);
    f.db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='owner'").run(JSON.stringify({ ...f.lane, runs: [{ stageId: "build", attempts: [] }], state: "closed", cursor: null }));
    const script = `import { pipelineRetirementReader } from ${JSON.stringify(path.join(import.meta.dir, "retirementEvidence.ts"))}; console.log(JSON.stringify((await pipelineRetirementReader())(${JSON.stringify(target)})));`;
    const child = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    expect(JSON.parse(output)).toBe(false);
    expect(() => warm(target)).toThrow("changed");
  } finally { f.db.close(); }
});


test("compact ownership preserves source, attempt, publication and recovery custody", async () => {
  const f = setup();
  try {
    for (const state of ["running", "needs_decision", "passed"] as const) {
      for (const publication of [false, true]) {
        for (const completed of [false, true]) {
          const lane = structuredClone(f.lane), attempt = lane.runs[0]!.attempts[0]!;
          attempt.state = state;
          attempt.completedAt = completed ? lane.createdAt : null;
          attempt.activation = undefined;
          lane.srcConversationId = "conversation_source"; lane.srcPath = "/fixture/source.jsonl";
          if (publication) lane.publicationAdmission = { id: "publication", sha: "a".repeat(40), fence: "b".repeat(64), state: "pending" };
          expect(isStoredPipeline(lane)).toBe(true);
          f.db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key='owner'").run(JSON.stringify(lane));
          const reader = await pipelineRetirementReader();
          for (const selected of [target, { conversations: ["conversation_source"] }, { conversations: [], agentPath: lane.srcPath },
            { conversations: [], launchId: "launch-owner" }, { conversations: ["missing"] }]) {
            const original = { conversationId: selected.conversations[0] ?? null, agentPath: selected.agentPath ?? null,
              launchId: "launchId" in selected ? selected.launchId : undefined, paneId: null, sessionId: "sessionId" in selected ? selected.sessionId : undefined };
            expect(reader(selected)).toBe(pipelineHostHasLiveWork([lane], original));
            const recovery = { pipelineId: lane.id, stageId: "build", attempt: 1, controlGeneration: null, turnTs: 1 };
            expect(reader(selected, recovery)).toBe(pipelineHostHasLiveWork([lane], original, id => id, attempt));
          }
        }
      }
    }
  } finally { f.db.close(); }
});


test.each(["completed", "closed", "superseded"] as const)("the production projection releases %s attempts and successor source custody", async outcome => {
  const f = setup();
  try {
    const original = f.lane.runs[0]!.attempts[0]!;
    for (const protection of ["none", "publication", "activation", "historical", "peer", "source-publication"] as const) {
      const lane = structuredClone(f.lane), attempt = lane.runs[0]!.attempts[0]!;
      if (outcome === "superseded") lane.runs[0]!.attempts.push({ ...attempt, n: 2,
        conversationId: "conversation_current", sessionId: "current", agentPath: "/fixture/current.jsonl", launchId: "current" });
      else { lane.state = outcome; lane.cursor = null; }
      if (protection === "historical") attempt.historical = true;
      if (protection === "publication") lane.publicationAdmission = { id: "publish", sha: "a".repeat(40), fence: "b".repeat(64), state: "pending" };
      if (protection === "activation") attempt.activation = { id: "activation", phase: "dispatching", clientAttemptId: "fixture", startedAt: lane.createdAt, fence: "fixture",
        input: { role: attempt.effectiveRole, prompt: "Build", cwd: "/fixture", project: "fixture", clientAttemptId: "fixture", title: "Fixture", runtimeProfile: {}, membership: {} } } as typeof attempt.activation;
      const successor = { ...buildPipeline({ ...f.lane, state: "provisioning", id: "successor", now: f.lane.createdAt }), state: "paused",
        srcConversationId: original.conversationId, srcPath: original.agentPath, runs: f.lane.runs.map(run => ({ ...run, attempts: [] })) } as Pipeline;
      if (protection === "source-publication") successor.publicationAdmission = { id: "publish", sha: "a".repeat(40), fence: "b".repeat(64), state: "pending" };
      const rows = [lane, successor];
      if (protection === "peer") rows.push({ ...f.lane, id: "peer", worktreeDir: "/fixture-pipeline-peer", branch: "pipeline/fixture-peer" });
      expect(rows.every(isStoredPipeline)).toBe(true);
      savePipelines(rows);
      const reader = await pipelineRetirementReader();
      for (const selected of [target, { conversations: [], launchId: "launch-owner" }, { conversations: [], sessionId: "session-owner" },
        { conversations: ["conversation_owner"] }, { conversations: [], agentPath: target.agentPath }]) {
        const fullTarget = { conversationId: selected.conversations[0] ?? null, sessionId: "sessionId" in selected ? selected.sessionId : undefined,
          agentPath: ("agentPath" in selected ? selected.agentPath : null) ?? null, launchId: "launchId" in selected ? selected.launchId : undefined, paneId: null };
        expect(reader(selected)).toBe(pipelineHostHasLiveWork(rows, fullTarget));
      }
      expect(reader(target)).toBe(protection !== "none");
      if (outcome === "superseded") expect(reader({ conversations: ["conversation_current"] })).toBe(true);
    }
  } finally { f.db.close(); }
});


test("released conversation aliases end source custody while independent paths and owners retain it", async () => {
  const f = setup();
  try {
    const lane = structuredClone(f.lane);
    lane.state = "completed"; lane.cursor = null;
    const successor = { ...buildPipeline({ ...f.lane, state: "provisioning", id: "successor", now: f.lane.createdAt }), state: "paused",
      srcConversationId: "conversation_alias", srcPath: "/fixture/independent.jsonl",
      runs: f.lane.runs.map(run => ({ ...run, attempts: [] })) } as Pipeline;
    savePipelines([lane, successor]);
    const selected = { conversations: ["conversation_owner", "conversation_alias"] };
    const reader = await pipelineRetirementReader();
    expect(reader(selected)).toBe(false);
    expect(reader({ ...selected, agentPath: successor.srcPath })).toBe(true);
    successor.publicationAdmission = { id: "publish", sha: "a".repeat(40), fence: "b".repeat(64), state: "pending" };
    savePipelines([lane, successor]);
    expect(() => reader(selected)).toThrow("changed");
    expect((await pipelineRetirementReader())(selected)).toBe(true);
    delete successor.publicationAdmission;
    const peer = { ...f.lane, id: "peer", worktreeDir: "/fixture-pipeline-peer", branch: "pipeline/fixture-peer" };
    savePipelines([lane, successor, peer]);
    expect((await pipelineRetirementReader())(selected)).toBe(true);
  } finally { f.db.close(); }
});
