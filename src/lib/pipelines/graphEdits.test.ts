import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

/* Graph slice 1: a started pipeline's graph stays editable. Every port is a
   mock and the state directory is private to this file, so nothing here can
   reach a host, an account or the operator's registry. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-graph-edits-"));
const { createPipelineFromRequest, patchPipeline, tickPipelines } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines } = await import("./store");
const { graphDigest, stageDigest } = await import("./stageDigest");
type PipelinePorts = import("./engine").PipelinePorts;
type Pipeline = import("./types").Pipeline;
type SpawnInput = Parameters<PipelinePorts["spawnAgent"]>[0];

registerPipelineTick(async () => {});
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const HEAD = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
const AGENT = { kind: "agent", role: "orchestrator", conversationId: "conversation_orchestrator" } as const;

function entry(pathname: string): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "stage", engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime: 2_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  };
}

function harness() {
  const messages = new Map<string, { text: string; ts: number }>();
  const spawns: SpawnInput[] = [];
  /* The persisted attempt as the spawn call found it: proof of what was bound
     before the engine was asked to launch anything. */
  const persistedAtSpawn: Array<Pipeline["runs"][number]["attempts"][number] | null> = [];
  let clock = 1_000_000;
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs) => {
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: (roleId) => roleId === "builder"
      ? { engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "Builder guidance" }
      : null,
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    spawnAgent: async (input, onReserved) => {
      spawns.push(structuredClone(input));
      const n = spawns.length;
      const run = loadPipelines()[0]?.runs.find((candidate) => candidate.stageId === input.membership.stageId);
      persistedAtSpawn.push(run?.attempts.at(-1) ? structuredClone(run.attempts.at(-1)!) : null);
      onReserved({ launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, accountId: "account-a" });
      return { launchId: `launch-${n}`, conversationId: `conversation_stage_${n}`, sessionId: `session-${n}`, transcript: `/codex/stage-${n}.jsonl`, paneId: `%${n}`, accountId: "account-a" };
    },
    paneAgentAlive: async () => true,
    stopStageAgent: async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "stopped" }),
    stageHostResident: async () => false,
    monotonicNow: () => Date.now(),
    worktreePresent: () => true,
    conversationAgentActive: async () => null,
    durableTurnEvidence: async () => null,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: (item) => messages.get(item.path) ?? null,
    pathForConversation: (id) => {
      const n = /^conversation_stage_(\d+)$/.exec(id)?.[1];
      return n ? `/codex/stage-${n}.jsonl` : null;
    },
    sourcePathAllowed: (pathname) => pathname.startsWith("/codex/") && pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => {
      if (pathname === "/codex/creator.jsonl") return "conversation_creator";
      const n = /stage-(\d+)\.jsonl$/.exec(pathname)?.[1];
      return n ? `conversation_stage_${n}` : null;
    },
    pipelineAdoptionCandidates: () => [],
    createFlow: async () => ({ error: "no review flows in this suite" }),
    patchFlow: () => ({}),
    closeFlow: async () => ({}),
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  /** Ends the turn of the stage spawned `n`th with a verdict. */
  const finish = (n: number, status: "pass" | "fail") => {
    const pathname = `/codex/stage-${n}.jsonl`;
    messages.set(pathname, { text: `done\n\n\`\`\`json\n${JSON.stringify({ status, findings: status === "fail" ? ["broken"] : [] })}\n\`\`\``, ts: clock + 100_000 });
    return entry(pathname);
  };
  return { ports, spawns, persistedAtSpawn, finish, spawnedStages: () => spawns.map((spawn) => spawn.membership.stageId) };
}

const stage = (id: string, next: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "run", role: { roleId: "builder" }, prompt: `Do ${id}`, next, ...extra });

async function started(ports: PipelinePorts, stages: unknown[]): Promise<string> {
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Graph slice", spec: "AC", repoDir: "/repo", stages: stages as never, src: "/codex/creator.jsonl" }, ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], ports); // provision
  await tickPipelines([], ports); // spawn the entry stage
  return created.pipeline.id;
}

const current = () => loadPipelines()[0]!;
const attemptsOf = (stageId: string) => current().runs.find((run) => run.stageId === stageId)!.attempts;

test("an attempt binds its stage definition before the spawn call, and an edit under it applies from the next attempt", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("build", "verify"), stage("verify", null, { onFail: { to: "build", maxRounds: 2 } })]);

  /* The attempt that reached spawnAgent was already persisted with its definition. */
  expect(h.spawns).toHaveLength(1);
  expect(h.persistedAtSpawn[0]?.state).toBe("spawning");
  expect(h.persistedAtSpawn[0]?.definition).toMatchObject({ "prompt": "Do build", account: null });
  const runningDefinition = structuredClone(attemptsOf("build")[0]!.definition);
  const runningRole = structuredClone(attemptsOf("build")[0]!.effectiveRole);

  const edited = await patchPipeline(id, { action: "override-stage", stageId: "build", "prompt": "Do build again", effort: "high" }, h.ports, AGENT);
  expect(edited.error).toBeUndefined();
  expect(edited.graphEdit).toMatchObject({ action: "override-stage", stageId: "build", effect: "pending-next-attempt", appliesFromAttempt: 2 });

  /* The live attempt is untouched; the stage carries the edit. */
  expect(attemptsOf("build")[0]!.definition).toEqual(runningDefinition);
  expect(attemptsOf("build")[0]!.effectiveRole).toEqual(runningRole);
  expect(current().stages[0]!.prompt).toBe("Do build again");

  /* Ticks while the turn is open never launch the stage twice. */
  await tickPipelines([], h.ports);
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0]!.role.effort).toBe("medium");

  await tickPipelines([h.finish(1, "pass")], h.ports); // build passes → verify
  await tickPipelines([], h.ports); // spawn verify
  await tickPipelines([h.finish(2, "fail")], h.ports); // verify fails → build again
  await tickPipelines([], h.ports); // spawn build attempt 2

  expect(h.spawnedStages()).toEqual(["build", "verify", "build"]);
  const [first, second] = attemptsOf("build");
  expect(first!.definition).toEqual(runningDefinition);
  expect(second!.definition).toMatchObject({ "prompt": "Do build again" });
  expect(second!.effectiveRole.effort).toBe("high");
  expect(h.spawns[2]!.role.effort).toBe("high");
});

test("an edit to a stage that has not started yet is applied to its first attempt", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("build", "verify"), stage("verify", null)]);
  const edited = await patchPipeline(id, { action: "override-stage", stageId: "verify", "prompt": "Verify the edit" }, h.ports, AGENT);
  expect(edited.graphEdit).toMatchObject({ effect: "applied", appliesFromAttempt: 1 });
  await tickPipelines([h.finish(1, "pass")], h.ports);
  await tickPipelines([], h.ports);
  expect(attemptsOf("verify")[0]!.definition).toMatchObject({ "prompt": "Verify the edit" });
});

test("pass edges decide execution; reordering the array alone changes nothing that runs", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("one", "two"), stage("two", null)]);

  /* During one's open turn: append three (two → three), then move two to the end of the array. */
  const added = await patchPipeline(id, { action: "add-stage", stage: stage("three", null) as never }, h.ports, AGENT);
  expect(added.error).toBeUndefined();
  const moved = await patchPipeline(id, { action: "reorder-stage", stageId: "two", toIndex: 2 }, h.ports, AGENT);
  expect(moved.error).toBeUndefined();
  expect(current().stages.map((item) => item.id)).toEqual(["one", "three", "two"]);
  expect(current().stages.map((item) => [item.id, item.next])).toEqual([["one", "two"], ["three", null], ["two", "three"]]);
  expect(current().runs.map((run) => run.stageId)).toEqual(["one", "three", "two"]);
  expect(attemptsOf("one")).toHaveLength(1);

  await tickPipelines([h.finish(1, "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish(2, "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish(3, "pass")], h.ports);
  expect(h.spawnedStages()).toEqual(["one", "two", "three"]);
  expect(current().state).toBe("completed");
});

test("rewiring pass edges during the first turn changes the order stages run in", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("one", "two"), stage("two", null)]);

  expect((await patchPipeline(id, { action: "add-stage", stage: stage("three", null) as never }, h.ports, AGENT)).error).toBeUndefined();
  /* two → three from the append; now route one → three → two. */
  expect((await patchPipeline(id, { action: "set-edge", stageId: "two", edge: "pass", to: null }, h.ports, AGENT)).error).toBeUndefined();
  expect((await patchPipeline(id, { action: "set-edge", stageId: "three", edge: "pass", to: "two" }, h.ports, AGENT)).error).toBeUndefined();
  expect((await patchPipeline(id, { action: "set-edge", stageId: "one", edge: "pass", to: "three" }, h.ports, AGENT)).error).toBeUndefined();
  /* The array still lists two before three. */
  expect(current().stages.map((item) => item.id)).toEqual(["one", "two", "three"]);

  await tickPipelines([h.finish(1, "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish(2, "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish(3, "pass")], h.ports);
  expect(h.spawnedStages()).toEqual(["one", "three", "two"]);
  expect(attemptsOf("three")[0]!.activatedBy).toEqual({ stageId: "one", attempt: 1, edge: "pass" });
  expect(attemptsOf("two")[0]!.activatedBy).toEqual({ stageId: "three", attempt: 1, edge: "pass" });
  expect(current().state).toBe("completed");

  /* A traversed pass edge stays the evidence it is. */
  const frozen = await patchPipeline(id, { action: "set-edge", stageId: "one", edge: "pass", to: "two" }, h.ports, AGENT);
  expect(frozen.status).toBe(409);
});

test("a stage with attempts keeps its place in the array", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("one", "two"), stage("two", null)]);
  const refused = await patchPipeline(id, { action: "reorder-stage", stageId: "one", toIndex: 1 }, h.ports, AGENT);
  expect(refused.status).toBe(409);
  expect(current().stages.map((item) => item.id)).toEqual(["one", "two"]);
});

test("add-stage may not insert before a started stage, and inserting after the running stage still routes through the new stage", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("one", "two"), stage("two", null)]);
  const before = structuredClone(current());

  /* At the front the new stage would be a head nothing routes to, and one would move. */
  const front = await patchPipeline(id, { action: "add-stage", index: 0, stage: stage("zero", null) as never }, h.ports, AGENT);
  expect(front.status).toBe(409);
  expect(front.graphEdit).toBeUndefined();
  expect(current().stages).toEqual(before.stages);
  expect(current().runs).toEqual(before.runs);
  expect(current().graphEdits).toEqual(before.graphEdits);

  const after = await patchPipeline(id, { action: "add-stage", index: 1, stage: stage("between", null) as never }, h.ports, AGENT);
  expect(after.error).toBeUndefined();
  expect(current().stages.map((item) => [item.id, item.next])).toEqual([["one", "between"], ["between", "two"], ["two", null]]);

  await tickPipelines([h.finish(1, "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish(2, "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish(3, "pass")], h.ports);
  expect(h.spawnedStages()).toEqual(["one", "between", "two"]);
  expect(current().state).toBe("completed");
});

test("a completed pipeline refuses graph edits, because no attempt would ever run them", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("one", "two"), stage("two", null)]);
  await tickPipelines([h.finish(1, "pass")], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish(2, "pass")], h.ports);
  expect(current().state).toBe("completed");

  const completed = structuredClone(current());
  for (const request of [
    { action: "add-stage", stage: stage("three", null) },
    { action: "override-stage", stageId: "two", effort: "high" },
    { action: "set-edge", stageId: "two", edge: "fail", to: "one" },
    { action: "reorder-stage", stageIds: ["one", "two"] },
  ] as const) {
    const refused = await patchPipeline(id, request as never, h.ports, AGENT);
    expect(refused.status).toBe(409);
    expect(refused.graphEdit).toBeUndefined();
  }
  expect(current()).toEqual(completed);
});

test("a launch re-issued after the controller was unavailable keeps the definition bound before the edit", async () => {
  const h = harness();
  const baseSpawn = h.ports.spawnAgent;
  let calls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    calls += 1;
    if (calls === 1) {
      h.spawns.push(structuredClone(input));
      throw new Error("structured delivery controller is unavailable");
    }
    return baseSpawn(input, onReserved);
  };
  const id = await started(h.ports, [stage("build", "verify"), stage("verify", null)]);

  const bounced = attemptsOf("build");
  expect(bounced).toHaveLength(1);
  expect(bounced[0]!.state).toBe("pending");
  expect(bounced[0]!.controllerWait).toMatchObject({ rounds: 1 });
  const boundDefinition = structuredClone(bounced[0]!.definition);
  const boundRole = structuredClone(bounced[0]!.effectiveRole);
  expect(boundRole.effort).toBe("medium");

  const edited = await patchPipeline(id, { action: "override-stage", stageId: "build", "prompt": "Do build differently", effort: "high" }, h.ports, AGENT);
  expect(edited.graphEdit).toMatchObject({ effect: "pending-next-attempt", appliesFromAttempt: 2 });

  for (let tick = 0; tick < 5 && calls < 2; tick += 1) await tickPipelines([], h.ports);
  expect(calls).toBe(2);
  expect(attemptsOf("build")).toHaveLength(1);
  expect(attemptsOf("build")[0]!.state).toBe("running");
  expect(attemptsOf("build")[0]!.definition).toEqual(boundDefinition);
  expect(attemptsOf("build")[0]!.effectiveRole).toEqual(boundRole);
  expect(h.spawns[1]!.role.effort).toBe("medium");
  expect(h.persistedAtSpawn.at(-1)!.definition).toEqual(boundDefinition);
  expect(current().stages[0]!.effectiveRole.effort).toBe("high");
});

test("two editors holding the same read: the second write is refused with STAGE_CHANGED and nothing is changed", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("one", "two"), stage("two", null)]);
  const read = current();
  const seenStage = stageDigest(read.stages[1]!);
  const seenGraph = graphDigest(read.stages);

  expect((await patchPipeline(id, { action: "override-stage", stageId: "two", "prompt": "first editor", expectedStageDigest: seenStage }, h.ports, AGENT)).error).toBeUndefined();
  const second = await patchPipeline(id, { action: "override-stage", stageId: "two", "prompt": "second editor", expectedStageDigest: seenStage }, h.ports, AGENT);
  expect(second).toMatchObject({ status: 409, code: "STAGE_CHANGED", field: "expectedStageDigest" });
  expect(current().stages[1]!.prompt).toBe("first editor");

  /* An edge is part of the stage it leaves. */
  const oneDigest = stageDigest(current().stages[0]!);
  expect((await patchPipeline(id, { action: "add-stage", stage: stage("three", null) as never, expectedStageDigest: graphDigest(current().stages) }, h.ports, AGENT)).error).toBeUndefined();
  const staleEdge = await patchPipeline(id, { action: "set-edge", stageId: "two", edge: "pass", to: null, expectedStageDigest: stageDigest(read.stages[1]!) }, h.ports, AGENT);
  expect(staleEdge).toMatchObject({ status: 409, code: "STAGE_CHANGED" });
  expect((await patchPipeline(id, { action: "set-edge", stageId: "one", edge: "pass", to: "three", expectedStageDigest: oneDigest }, h.ports, AGENT)).error).toBeUndefined();

  /* Structural edits guard the whole ordered graph. */
  const before = structuredClone(current().stages);
  const staleAdd = await patchPipeline(id, { action: "add-stage", stage: stage("four", null) as never, expectedStageDigest: seenGraph }, h.ports, AGENT);
  expect(staleAdd).toMatchObject({ status: 409, code: "STAGE_CHANGED", field: "expectedStageDigest" });
  const staleMove = await patchPipeline(id, { action: "reorder-stage", stageId: "three", toIndex: 1, expectedStageDigest: seenGraph }, h.ports, AGENT);
  expect(staleMove).toMatchObject({ status: 409, code: "STAGE_CHANGED" });
  expect(current().stages).toEqual(before);
});

test("a paused pipeline accepts graph edits and a closed one refuses every one of them", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("one", "two"), stage("two", null)]);
  expect((await patchPipeline(id, { action: "pause" }, h.ports, AGENT)).error).toBeUndefined();
  expect((await patchPipeline(id, { action: "add-stage", stage: stage("three", null) as never }, h.ports, AGENT)).error).toBeUndefined();
  expect((await patchPipeline(id, { action: "override-stage", stageId: "three", "prompt": "while paused" }, h.ports, AGENT)).error).toBeUndefined();
  expect(current().state).toBe("paused");

  expect((await patchPipeline(id, { action: "close" }, h.ports)).error).toBeUndefined();
  const closed = structuredClone(current());
  for (const request of [
    { action: "add-stage", stage: stage("four", null) },
    { action: "reorder-stage", stageId: "three", toIndex: 1 },
    { action: "set-edge", stageId: "two", edge: "pass", to: null },
    { action: "override-stage", stageId: "three", "prompt": "after close" },
  ] as const) {
    expect((await patchPipeline(id, request as never, h.ports, AGENT)).status).toBe(409);
  }
  expect(current()).toEqual(closed);
});

test("every accepted graph edit is recorded with who made it", async () => {
  const h = harness();
  const id = await started(h.ports, [stage("one", "two"), stage("two", null)]);
  await patchPipeline(id, { action: "add-stage", stage: stage("three", null) as never }, h.ports, AGENT);
  await patchPipeline(id, { action: "set-edge", stageId: "two", edge: "pass", to: null }, h.ports);
  await patchPipeline(id, { action: "override-stage", stageId: "one", effort: "high" }, h.ports, AGENT);
  /* A refused edit leaves no record. */
  await patchPipeline(id, { action: "reorder-stage", stageId: "one", toIndex: 2 }, h.ports, AGENT);

  expect(current().graphEdits?.map(({ seq, action, stageId, actor, effect, appliesFromAttempt }) => ({ seq, action, stageId, actor, effect, appliesFromAttempt }))).toEqual([
    { seq: 1, action: "add-stage", stageId: "three", actor: AGENT, effect: "applied", appliesFromAttempt: 1 },
    { seq: 2, action: "set-edge", stageId: "two", actor: { kind: "operator" }, effect: "applied", appliesFromAttempt: null },
    { seq: 3, action: "override-stage", stageId: "one", actor: AGENT, effect: "pending-next-attempt", appliesFromAttempt: 2 },
  ]);
  expect(current().graphEdits![0]!.summary).toContain("three");
});
