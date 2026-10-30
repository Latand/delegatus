import { expect, test, fs, path, Database, loadPipelines, realWorktreeLane, finishReported, createPipelineFromRequest, pipelineIdentity } from "./engine.fixture";
import { spyOn } from "bun:test";
import * as stateStore from "@/lib/state/sqliteStateStore";
import * as taskNotes from "./taskStatusNote";
import * as pipelineStore from "./store";
import { withControllerPipelineScope, withoutControllerPipelineScope } from "./controllerScope";
import { patchPipeline, settlePendingStageGit } from "./engine";
import { takeoverPipelineDelivery, withPipelineMutation } from "./store";
import { createTask } from "@/lib/tasks/commands";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineControllerJobs, startPipelineControllerJob, PIPELINE_CONTROLLER_MAX_JOBS } from "./controllerJobs";
import { realExec } from "@/lib/workflows/provision";

async function passedStagePublication(holdPush?: { entered(): void; ready: Promise<void>; wait: Promise<void> }) {
  const box = await realWorktreeLane("settlement-preparation", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  const { h } = box;
  const execute = h.ports.exec;
  let pushes = 0;
  h.ports.exec = async (...args) => {
    if (args[0] === "git" && args[1][0] === "push") {
      pushes++;
      if (holdPush) { holdPush.entered(); await holdPush.wait; }
    }
    return execute(...args);
  };
  fs.writeFileSync(path.join(box.worktree, "change.txt"), "accepted output\n");
  await tickPipelinesController([finishReported(h, "/codex/stage-1.jsonl", "pass", "Finished")], h.ports);
  if (holdPush) await holdPush.ready;
  else await settlePipelineControllerJobs();
  const accepted = loadPipelines()[0]!;
  expect(accepted.cursor).toMatchObject({ stageId: "build", state: "committing" });
  expect(accepted.runs[0]!.attempts[0]!.state).toBe("passed");
  const published = loadPipelines()[0]!;
  if (!holdPush) expect(published.delivery!.operation!.result).toMatchObject({ ok: true, remote: "published", sha: published.lastPassedCommit });
  expect(pushes).toBe(1);
  const publication = structuredClone(published.delivery!.operation!);
  return { ...box, publication, pushes: () => pushes, current: () => loadPipelines().find(row => row.id === box.id)! };
}

/** Finish the real compact read, then commit a real evidence-journal write
 * before the ownership reader's freshness check. No exception is mocked. */
function racePreparation(mutate?: () => Promise<void>) {
  const original = stateStore.readCompactPipelineEvidence;
  let reads = 0;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation(async (...args) => {
    const ownership = new Error().stack?.includes("stageBranch.ts");
    const result = await original(...args);
    if (!ownership) return result;
    await mutate?.();
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
    try { db.query("UPDATE state_rows SET value_json=value_json WHERE collection='pipelines'").run(); }
    finally { db.close(); }
    reads++;
    return result;
  });
  return { restore: () => read.mockRestore(), reads: () => reads };
}

async function failPreparationInReplacementController(at: string, postPreparation?: { lane: string; peer: string }) {
  const source = `
    import { spyOn } from 'bun:test';
    import { Database } from 'bun:sqlite';
    import * as stateStore from ${JSON.stringify(path.resolve("src/lib/state/sqliteStateStore.ts"))};
    import { defaultPipelinePorts } from ${JSON.stringify(path.resolve("src/lib/pipelines/engine.ts"))};
    import { tickPipelinesController } from ${JSON.stringify(path.resolve("src/lib/pipelines/controllerPass.ts"))};
    import { settlePipelineControllerJobs } from ${JSON.stringify(path.resolve("src/lib/pipelines/controllerJobs.ts"))};
    import { registerPipelineTick } from ${JSON.stringify(path.resolve("src/lib/pipelines/controllerSignal.ts"))};
    import { withPipelineMutation, pipelineIdentity } from ${JSON.stringify(path.resolve("src/lib/pipelines/store.ts"))};
    import { withControllerPipelineScope, withoutControllerPipelineScope } from ${JSON.stringify(path.resolve("src/lib/pipelines/controllerScope.ts"))};
    import { settlePendingStageGit } from ${JSON.stringify(path.resolve("src/lib/pipelines/engine.ts"))};
    registerPipelineTick(async () => {});
    const original = stateStore.readCompactPipelineEvidence;
    const read = spyOn(stateStore, 'readCompactPipelineEvidence').mockImplementation(async (...args) => {
      const ownership = new Error().stack?.includes('stageBranch.ts');
      const result = await original(...args);
      if (ownership) {
        const db = new Database(process.env.LLV_STATE_DIR + '/state.sqlite');
        try { db.query("UPDATE state_rows SET value_json=value_json WHERE collection='pipelines'").run(); }
        finally { db.close(); }
      }
      return result;
    });
    const postPreparation = ${JSON.stringify(postPreparation ?? null)};
    const defaults = defaultPipelinePorts();
    let invalidated = false;
    let pushes = 0;
    const ports = { ...defaults, now: () => ${JSON.stringify(at)},
      exec: async (...args) => {
        if (postPreparation && args[0] === 'git' && args[1][0] === 'push') { pushes++; throw new Error('unexpected replacement push'); }
        const result = await defaults.exec(...args);
        if (postPreparation && !invalidated && args[0] === 'git' && args[1][0] === 'status') {
          invalidated = true;
          await withoutControllerPipelineScope(() => withPipelineMutation(async (rows, persist) => {
            const peer = rows.find(row => row.id === postPreparation.peer);
            peer.task += ' changed';
            Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
            await persist([peer]);
          }));
        }
        return result;
      },
      scheduleTick: () => {}, sourcePathAllowed: () => false, conversationAgentActive: async () => false,
      stageHostResident: async () => false, paneAgentAlive: async () => false,
      spawnAgent: async () => { throw new Error('unexpected fixture spawn'); }, stopStageAgent: async () => { throw new Error('unexpected fixture stop'); } };
    try {
      if (postPreparation) {
        read.mockRestore();
        try { await withControllerPipelineScope([postPreparation.lane], () => settlePendingStageGit(ports)); }
        catch (error) { if (error.pipelineId !== postPreparation.lane) throw error; }
        if (!invalidated || pushes) throw new Error('replacement controller did not preserve stale-ownership custody');
      } else { await tickPipelinesController([], ports); await settlePipelineControllerJobs(); }
    }
    finally { read.mockRestore(); }
  `;
  const child = await realExec(process.execPath, ["-e", source], process.cwd(), process.env, { timeoutMs: 30_000 });
  expect(child.code, child.stderr).toBe(0);
}

/** A valid peer changes authority after a real, fenced Git read. The adoption
 * variant writes just before the real mutation callback checks its fences. */
async function raceAfterPreparation(box: Pick<Awaited<ReturnType<typeof passedStagePublication>>, "repo" | "h">,
  point: "git-status" | "adoption" = "git-status", change?: () => Promise<void>) {
  const peer = await createPipelineFromRequest({ task: "Independent authority", repoDir: box.repo, autoStart: false,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
    publication: "internal" }, box.h.ports);
  if (!peer.pipeline) throw new Error(peer.error);
  const mutate = pipelineStore.withPipelineMutation;
  const execute = box.h.ports.exec;
  let armed = false, writes = 0;
  const invalidate = async () => {
    armed = false;
    await withoutControllerPipelineScope(() => mutate(async (rows, persist) => {
      const current = rows.find(row => row.id === peer.pipeline!.id)!;
      current.task += " changed";
      Object.assign(current, pipelineIdentity(current.id, current.task, current.repoDir));
      await persist([current]);
    }));
    writes++;
    await withoutControllerPipelineScope(() => change?.());
  };
  box.h.ports.exec = async (...args) => {
    const result = await execute(...args);
    if (args[0] === "git" && args[1][0] === "status") {
      armed = true;
      if (point === "git-status") await invalidate();
    }
    return result;
  };
  const guardedMutation: typeof pipelineStore.withPipelineMutation = async (callback, observeHold) => {
    if (armed) await invalidate();
    return mutate(callback, observeHold);
  };
  const mutation = point === "adoption" ? spyOn(pipelineStore, "withPipelineMutation").mockImplementation(guardedMutation) : undefined;
  return { peer: peer.pipeline.id, writes: () => writes,
    restore: () => { box.h.ports.exec = execute; mutation?.mockRestore(); } };
}

async function refuseStaleSettlement(box: Awaited<ReturnType<typeof passedStagePublication>>) {
  let refused = false;
  try { await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports)); }
  catch (error) { expect(error).toMatchObject({ pipelineId: box.id, operationId: box.publication.id }); refused = true; }
  // Keep the custody assertions first so the pre-fix control diagnoses the
  // missing durable accounting even when the old path returns silently.
  expect(box.current().cursor).toMatchObject({ stageId: "build", state: "committing" });
  expect(box.current().runs[1]!.attempts).toHaveLength(0);
  return refused;
}

test.each(["git-status", "adoption"] as const)("post-preparation invalidation at %s spends the retained window and parks honestly", async point => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const accepted = structuredClone(box.current().runs[0]!.attempts[0]!);
  const race = await raceAfterPreparation(box, point);
  try {
    await refuseStaleSettlement(box);
    const first = structuredClone(box.current().runs[0]!.attempts[0]!.settlementPreparationWait);
    expect(first).toBeDefined();
    expect(race.writes()).toBe(1);
    expect(box.current().delivery!.operation).toEqual(box.publication);
    clock = Date.parse(first!.retryAfter);
    await refuseStaleSettlement(box);
    const second = box.current().runs[0]!.attempts[0]!.settlementPreparationWait!;
    expect(second.startedAt).toBe(first!.startedAt);
    expect(second.rounds).toBe(first!.rounds + 1);
    clock = Date.parse(first!.startedAt) + 15 * 60_000;
    await refuseStaleSettlement(box);
    const parked = box.current(), retained = parked.runs[0]!.attempts[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("retry-stage");
    expect(retained.settlementPreparationWait).toEqual(second);
    for (const key of ["output", "verdict", "report", "definition", "n", "launchId", "conversationId", "completedAt"] as const)
      expect(retained[key]).toEqual(accepted[key]);
    expect(parked.delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(parked.lastPassedCommit).toBe(box.publication.sha);
    expect(parked.publishedCommit).toBe(box.publication.sha);
    expect(parked.delivery!.ownerId).toBe(box.id);
    expect(parked.delivery!.epoch).toBe(box.publication.epoch);
    race.restore();
    clock += 60_000;
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(box.current().state).toBe("needs_decision");
    expect(box.current().runs[1]!.attempts).toHaveLength(0);
    expect(box.pushes()).toBe(1);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(box.publication.sha);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["recover", "restart"] as const)("post-preparation recovery retains its original publication (%s)", async outcome => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = await raceAfterPreparation(box);
  try {
    await refuseStaleSettlement(box);
    const first = structuredClone(box.current().runs[0]!.attempts[0]!.settlementPreparationWait);
    expect(first).toBeDefined();
    race.restore();
    if (outcome === "restart") {
      clock = Date.parse(first!.startedAt) + 15 * 60_000;
      await failPreparationInReplacementController(new Date(clock).toISOString(), { lane: box.id, peer: race.peer });
      const parked = box.current();
      expect(parked.state).toBe("needs_decision");
      expect(parked.runs[0]!.attempts[0]!.settlementPreparationWait).toEqual(first);
      expect(parked.delivery!.operation).toEqual({ ...box.publication, passedStage: false });
      expect(parked.publishedCommit).toBe(box.publication.sha);
      expect(parked.lastPassedCommit).toBe(box.publication.sha);
      expect(parked.runs[1]!.attempts).toHaveLength(0);
    } else {
      clock = Date.parse(first!.retryAfter);
      await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports));
      expect(box.current().cursor).toMatchObject({ stageId: "audit", state: "pending" });
      expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
      for (let n = 0; n < 3; n++) { await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs(); }
      expect(box.current().runs[0]!.attempts).toHaveLength(1);
      expect(box.current().runs[1]!.attempts).toHaveLength(1);
      expect(box.current().delivery!.operation).toEqual(box.publication);
    }
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("post-preparation invalidation cannot dispatch a pending publication", async () => {
  const box = await realWorktreeLane("pending-ownership", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  let clock = Date.parse(box.h.ports.now()), pushes = 0;
  box.h.ports.now = () => new Date(clock).toISOString();
  const held = Promise.withResolvers<void>(), execute = box.h.ports.exec;
  box.h.ports.exec = (...args) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    return execute(...args);
  };
  let race: Awaited<ReturnType<typeof raceAfterPreparation>> | undefined;
  const current = () => loadPipelines().find(row => row.id === box.id)!;
  try {
    fs.writeFileSync(path.join(box.worktree, "change.txt"), "accepted output\n");
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++)
      expect(startPipelineControllerJob(`ownership-capacity-${n}`, () => held.promise, async () => "held")).toBe(true);
    await tickPipelinesController([finishReported(box.h, "/codex/stage-1.jsonl", "pass", "Finished")], box.h.ports);
    held.resolve(); await settlePipelineControllerJobs();
    await settlePendingStageGit(box.h.ports);
    const publication = structuredClone(current().delivery!.operation!);
    expect(publication.state).toBe("pending");
    race = await raceAfterPreparation(box);
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(race.writes()).toBeGreaterThan(0);
    expect(current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeDefined();
    expect(current().delivery!.operation).toEqual(publication);
    expect(pushes).toBe(0);
    clock += 15 * 60_000;
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(current().state).toBe("needs_decision");
    expect(current().delivery!.operation).toMatchObject({ id: publication.id, requestKey: publication.requestKey,
      sha: publication.sha, epoch: publication.epoch, state: "settled", result: { ok: false } });
    expect(current().runs[1]!.attempts).toHaveLength(0);
    expect(pushes).toBe(0);
  } finally { race?.restore(); held.resolve(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["pause", "close", "owner", "epoch", "head", "reservation"] as const)("post-preparation %s changes supersede the old accounting selection", async change => {
  const box = await passedStagePublication();
  let changed = false;
  const race = await raceAfterPreparation(box, "git-status", async () => {
    if (changed) return;
    changed = true;
    if (change === "pause" || change === "close") {
      expect((await patchPipeline(box.id, { action: change, reason: "Fixture control" }, box.h.ports)).error).toBeUndefined();
    } else if (change === "owner" || change === "epoch") {
      const successor = change === "owner" ? await createPipelineFromRequest({ task: "Successor", repoDir: box.repo, autoStart: false,
        stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
        publication: "remote-branch", delivery: { branch: box.current().delivery!.target.branch } }, box.h.ports) : null;
      expect((await takeoverPipelineDelivery(successor?.pipeline?.id ?? box.id, box.id, box.publication.epoch, "Fixture recovery", null)).error).toBeUndefined();
    } else await withPipelineMutation(async (rows, persist) => {
      const current = rows.find(row => row.id === box.id)!;
      if (change === "head") current.lastPassedCommit = box.base;
      else current.delivery!.operation = { ...box.publication, id: "replacement-publication", reservationId: "replacement-reservation" };
      await persist([current]);
    });
  });
  try {
    try { await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports)); } catch { /* Refusal retains newer controls. */ }
    const current = box.current();
    expect(changed).toBe(true);
    expect(current.runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(current.runs[1]!.attempts).toHaveLength(0);
    if (["pause", "close", "owner", "head"].includes(change)) expect(current.delivery!.operation).toEqual(box.publication);
    if (change === "reservation") expect(current.delivery!.operation!.id).toBe("replacement-publication");
    if (change === "epoch") expect(current.delivery!.epoch).toBe(box.publication.epoch + 1);
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("admitted preparation races park within the settlement window while preserving verified publication", async () => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = racePreparation();
  const logged = spyOn(console, "error");
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(race.reads()).toBeGreaterThan(0);
    expect(box.current().state).toBe("running");
    clock += 15 * 60_000;
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const parked = box.current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(parked.publishedCommit).toBe(box.publication.sha);
    expect(box.pushes()).toBe(1);
    expect(parked.runs[1]!.attempts).toHaveLength(0);
    expect(logged.mock.calls.some(([, error]) => error?.pipelineId === box.id && error?.stageId === "build"
      && error?.attempt === 1 && error?.operationId === box.publication.id)).toBe(true);
    race.restore();
    expect((await patchPipeline(box.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, box.h.ports)).error).toBeUndefined();
    for (let n = 0; n < 3; n++) {
      await tickPipelinesController([], box.h.ports);
      await settlePipelineControllerJobs();
    }
    expect(box.current().cursor?.stageId).toBe("audit");
    expect(box.current().delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); logged.mockRestore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("failed preparation cannot spend recovery or park an executing publication", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const box = await passedStagePublication({ entered: () => entered.resolve(), ready: entered.promise, wait: release.promise });
  const race = racePreparation();
  try {
    expect(box.current().delivery!.operation!.state).toBe("running");
    await expect(settlePendingStageGit(box.h.ports)).rejects.toThrow();
    expect(race.reads()).toBeGreaterThan(0);
    expect(box.current().state).toBe("running");
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(box.current().delivery!.operation).toMatchObject({ id: box.publication.id, epoch: box.publication.epoch,
      sha: box.publication.sha, requestKey: box.publication.requestKey, state: "running" });
    expect(box.current().delivery!.operation!.result).toEqual(box.publication.result);
  } finally {
    race.restore(); release.resolve(); await settlePipelineControllerJobs();
    try {
      expect(box.current().delivery!.operation!.result).toMatchObject({ ok: true, remote: "published", sha: box.publication.sha });
      expect(box.pushes()).toBe(1);
    } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
  }
});

test.each(["ack-loss", "superseded"] as const)("decision-note delivery preserves the preparation decision and newer controls (%s)", async outcome => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const previousTasks = loadTasks();
  let restoreRace = () => {}, restoreNote = () => {};
  try {
    const task = createTask(previousTasks, { project: box.current().project, text: "Preparation decision", placement: "unplaced" }, [],
      { now: box.h.ports.now, id: () => "preparation-decision-task" });
    if (!task.ok) throw new Error(task.error);
    saveTasks(task.tasks);
    await withPipelineMutation(async (rows, persist) => {
      const lane = rows.find(row => row.id === box.id)!;
      lane.taskIds = [...lane.taskIds, task.task.id];
      await persist([lane]);
    });
    const race = racePreparation(); restoreRace = race.restore;
    let notes = 0;
    const write = taskNotes.writeParkedTaskNote;
    const note = spyOn(taskNotes, "writeParkedTaskNote").mockImplementation(async (...args) => {
      notes++;
      if (outcome === "superseded") expect((await patchPipeline(box.id,
        { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, box.h.ports)).error).toBeUndefined();
      await write(...args);
      throw new Error("fixture note unavailable");
    });
    restoreNote = () => note.mockRestore();
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    clock += 15 * 60_000;
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(notes).toBeGreaterThan(0);
    expect(loadTasks().find(row => row.id === task.task.id)!.note?.author.kind).toBe(outcome === "ack-loss" ? "orchestrator" : undefined);
    expect(box.current().state).toBe(outcome === "ack-loss" ? "needs_decision" : "running");
    expect(box.current().delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(box.pushes()).toBe(1);
  } finally { restoreRace(); restoreNote(); await settlePipelineControllerJobs(); saveTasks(previousTasks); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("preparation retries honor their persisted backoff without renewing the first failure clock", async () => {
  const box = await passedStagePublication();
  const start = Date.parse(box.h.ports.now());
  let clock = start;
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = racePreparation();
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const first = box.current().runs[0]!.attempts[0]!.settlementPreparationWait;
    expect(first).toBeDefined();
    expect(box.current().runs[0]!.attempts[0]!.error).toBeNull();
    const reads = race.reads();
    expect(reads).toBeGreaterThan(0);
    await expect(settlePendingStageGit(box.h.ports)).rejects.toThrow();
    expect(race.reads()).toBe(reads);
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toEqual(first);
    clock = Date.parse(first!.retryAfter);
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(race.reads()).toBe(reads + 1);
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait?.startedAt).toBe(first!.startedAt);
    clock = start + 15 * 60_000;
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(box.current().state).toBe("needs_decision");
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["pause", "close", "owner", "epoch"] as const)("a %s during preparation supersedes its failure accounting", async change => {
  const box = await passedStagePublication();
  let changed = false;
  let successorId: string | undefined;
  const race = racePreparation(async () => {
    if (changed) return;
    changed = true;
    if (change === "pause" || change === "close") {
      const result = await patchPipeline(box.id, { action: change, reason: "Fixture control" }, box.h.ports);
      expect(result.error).toBeUndefined();
    } else {
      if (change === "owner") {
        const successor = await createPipelineFromRequest({ task: "Successor", repoDir: box.repo, autoStart: false,
          stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
          publication: "remote-branch", delivery: { branch: box.current().delivery!.target.branch } }, box.h.ports);
        expect(successor.error).toBeUndefined();
        successorId = successor.pipeline!.id;
      }
      const taken = await takeoverPipelineDelivery(successorId ?? box.id, box.id, box.publication.epoch, "Fixture recovery", null);
      expect(taken.error).toBeUndefined();
    }
  });
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const current = box.current();
    expect(changed).toBe(true);
    expect(current.runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(current.runs[1]!.attempts).toHaveLength(0);
    if (change !== "epoch") expect(current.delivery!.operation).toEqual(box.publication);
    if (change === "pause") expect(current.state).toBe("paused");
    if (change === "close") expect(current.state).toBe("closed");
    if (change === "owner") {
      expect(current.delivery!.active).toBe(false);
      expect(loadPipelines().find(row => row.id === successorId)!.delivery).toMatchObject({ active: true, ownerId: successorId, epoch: box.publication.epoch + 1 });
    }
    if (change === "epoch") {
      expect(current.delivery!.epoch).toBe(box.publication.epoch + 1);
      expect(current.delivery!.operation).toBeUndefined();
    }
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("preparation failures spend the same persisted window in a replacement controller process", async () => {
  const box = await passedStagePublication();
  const initial = box.h.ports.now();
  box.h.ports.now = () => initial;
  const race = racePreparation();
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
  } finally { race.restore(); }
  try {
    await failPreparationInReplacementController(new Date(Date.parse(initial) + 15 * 60_000).toISOString());
    const parked = box.current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(parked.publishedCommit).toBe(box.publication.sha);
  } finally { await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a fresh preparation advances the original published pass exactly once", async () => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = racePreparation();
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
  } finally { race.restore(); }
  try {
    clock += 60_000;
    for (let n = 0; n < 3; n++) {
      await tickPipelinesController([], box.h.ports);
      await settlePipelineControllerJobs();
    }
    const advanced = box.current();
    expect(advanced.cursor?.stageId).toBe("audit");
    expect(advanced.runs[0]!.attempts).toHaveLength(1);
    expect(advanced.runs[1]!.attempts).toHaveLength(1);
    expect(advanced.delivery!.operation).toEqual(box.publication);
    expect(advanced.lastPassedCommit).toBe(box.publication.sha);
    expect(advanced.publishedCommit).toBe(box.publication.sha);
    expect(advanced.delivery!.ownerId).toBe(box.id);
    expect(advanced.delivery!.epoch).toBe(box.publication.epoch);
    expect(box.pushes()).toBe(1);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(box.publication.sha);
  } finally { await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a foreign head after a preparation failure cannot replace the verified publication", async () => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = racePreparation();
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
  } finally { race.restore(); }
  try {
    await box.git(box.repo, "commit", "--allow-empty", "-m", "independent work");
    const foreign = await box.git(box.repo, "rev-parse", "HEAD");
    expect(foreign).not.toBe(box.publication.sha);
    await box.git(box.repo, "update-ref", `refs/heads/${box.current().branch}`, foreign, box.publication.sha);
    clock += 60_000;
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const refused = box.current();
    expect(refused.state).toBe("needs_decision");
    expect(refused.lastPassedCommit).toBe(box.publication.sha);
    expect(refused.publishedCommit).toBe(box.publication.sha);
    expect(refused.delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(refused.runs[1]!.attempts).toHaveLength(0);
    expect(box.pushes()).toBe(1);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(foreign);
  } finally { await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["fresh", "exhausted", "deadline", "restart", "replacement"] as const)("a pending publication cannot bypass failed preparation (%s)", async outcome => {
  const box = await realWorktreeLane("pending-preparation", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const held = Promise.withResolvers<void>();
  const execute = box.h.ports.exec;
  let pushes = 0;
  box.h.ports.exec = (...args) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    return execute(...args);
  };
  const current = () => loadPipelines().find(row => row.id === box.id)!;
  let race: ReturnType<typeof racePreparation> | undefined;
  try {
    fs.writeFileSync(path.join(box.worktree, "change.txt"), "accepted output\n");
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++)
      expect(startPipelineControllerJob(`preparation-capacity-${n}`, () => held.promise, async () => "held")).toBe(true);
    await tickPipelinesController([finishReported(box.h, "/codex/stage-1.jsonl", "pass", "Finished")], box.h.ports);
    held.resolve(); await settlePipelineControllerJobs();
    await settlePendingStageGit(box.h.ports);
    const operation = structuredClone(current().delivery!.operation!);
    expect(operation.state).toBe("pending");
    expect(pushes).toBe(0);
    race = racePreparation();
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(race.reads()).toBeGreaterThan(0);
    expect(current().delivery!.operation).toEqual(operation);
    expect(pushes).toBe(0);
    if (outcome === "fresh" || outcome === "deadline" || outcome === "restart") {
      const window = current().runs[0]!.attempts[0]!.settlementPreparationWait;
      expect(window).toBeDefined();
      race.restore(); race = undefined;
      clock += 60_000;
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      // The native publisher promotes its pending admission to an execution.
      // Once verified, that execution must remain the original publication.
      const executed = structuredClone(current().delivery!.operation!);
      expect(executed.id).not.toBe(operation.id);
      expect(executed).toMatchObject({ requestKey: operation.requestKey, epoch: operation.epoch,
        sha: operation.sha, state: "settled", result: { ok: true, remote: "published" } });
      expect(current().runs[0]!.attempts[0]!.settlementPreparationWait?.startedAt).toBe(window!.startedAt);
      if (outcome !== "fresh") {
        clock = Date.parse(window!.startedAt) + 15 * 60_000;
        const accepted = structuredClone(current().runs[0]!.attempts[0]!);
        if (outcome === "restart") await failPreparationInReplacementController(new Date(clock).toISOString());
        else {
          race = racePreparation();
          await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
          expect(race.reads()).toBeGreaterThan(0);
        }
        const parked = current();
        expect(parked.state).toBe("needs_decision");
        expect(parked.delivery!.operation).toEqual({ ...executed, passedStage: false });
        expect(parked.runs[0]!.attempts[0]!.settlementPreparationWait).toEqual(window);
        const retained = parked.runs[0]!.attempts[0]!;
        for (const key of ["output", "verdict", "report", "definition", "n", "launchId", "conversationId", "completedAt"] as const)
          expect(retained[key]).toEqual(accepted[key]);
        expect(parked.publishedCommit).toBe(executed.sha);
        expect(parked.lastPassedCommit).toBe(executed.sha);
        expect(parked.delivery!.ownerId).toBe(box.id);
        expect(parked.delivery!.epoch).toBe(executed.epoch);
        expect(parked.runs[1]!.attempts).toHaveLength(0);
        expect(pushes).toBe(1);
        return;
      }
      for (let n = 0; n < 2; n++) { await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs(); }
      expect(current().cursor?.stageId).toBe("audit");
      expect(current().delivery!.operation).toEqual(executed);
      expect(pushes).toBe(1);
    } else if (outcome === "replacement") {
      const window = structuredClone(current().runs[0]!.attempts[0]!.settlementPreparationWait!);
      await withPipelineMutation(async (rows, persist) => {
        const lane = rows.find(row => row.id === box.id)!;
        lane.delivery!.operation = { ...operation, id: "replacement-reservation" };
        await persist([lane]);
      });
      clock = Date.parse(window.startedAt) + 15 * 60_000;
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      expect(current().state).toBe("running");
      const replacement = current().runs[0]!.attempts[0]!.settlementPreparationWait!;
      expect(replacement.identity).not.toBe(window.identity);
      expect(replacement.startedAt).toBe(new Date(clock).toISOString());
      expect(replacement.rounds).toBe(1);
      expect(current().delivery!.operation).toEqual({ ...operation, id: "replacement-reservation" });
      expect(pushes).toBe(0);
    } else {
      clock += 15 * 60_000;
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      expect(current().state).toBe("needs_decision");
      expect(current().delivery!.operation).toMatchObject({ id: operation.id, requestKey: operation.requestKey,
        epoch: operation.epoch, sha: operation.sha, state: "settled", result: { ok: false } });
      expect(pushes).toBe(0);
    }
  } finally { race?.restore(); held.resolve(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});
