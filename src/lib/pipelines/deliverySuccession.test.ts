import { afterEach, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { createPipelineFromRequest, rawPatchPipeline, loadPipelines, savePipelines, tickPipelines,
  projectPipelineEvents, fs, path } from "./engine.fixture";
import { fixture, isolatePublicationGit, stages } from "./publicationRecovery.fixture";
import { buildPipeline, createPipelineWithDelivery, findPipelineRecord, pipelineArtifactsDir, takeoverPipelineDelivery, withPipelineMutation } from "./store";
import { settlePendingRemoteActions } from "./engine";
import { acquirePublicationFileLock, releasePublicationFileLock } from "./git";

isolatePublicationGit();
const CLOCK = "2026-11-01T10:00:00.000Z";
let restoreIds: (() => void) | undefined;
function pinIds(label: string) {
  let id = 0;
  const mocked = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `${crypto.createHash("sha256").update(`${label}:${++id}`).digest("hex").slice(0, 8)}-0000-4000-8000-000000000000`);
  restoreIds = () => mocked.mockRestore();
}
afterEach(() => { restoreIds?.(); restoreIds = undefined; });

test("close owner, create successor on its PR, and publish the successor head", async () => {
  pinIds("closed-owner-successor");
  const f = await fixture();
  try {
    const owner = loadPipelines()[0]!;
    const target = { ...owner.delivery!.target, pr: 17 };
    owner.delivery!.target = target;
    savePipelines([owner]);
    const closed = await rawPatchPipeline(owner.id, { action: "close" }, f.h.ports);
    expect(closed.error).toBeUndefined();
    expect(findPipelineRecord(owner.id)!.state).toBe("closed");
    // Creation must work while teardown still owes the old stage's host.
    expect(findPipelineRecord(owner.id)!.closeTeardown?.phase).not.toBe("settled");
    const successor = await createPipelineFromRequest({ task: "Continue the PR", repoDir: f.repo,
      baseRef: owner.lastPassedCommit, delivery: { branch: target.branch, remote: "origin", pr: target.pr },
      stages: stages as never }, f.h.ports);
    expect(successor.error).toBeUndefined();
    const lane = successor.pipeline!;
    expect(lane.delivery).toMatchObject({ disposition: "owner", active: true, epoch: 2, target });
    await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
    const head = await f.commit("successor implementation");
    await f.finish(2);
    const published = findPipelineRecord(lane.id)!;
    expect(published.publishedCommit).toBe(head);
    expect(published.delivery!.target).toEqual(target);
    expect(await f.git(f.remote, "rev-parse", target.branch)).toBe(head);
    expect(findPipelineRecord(owner.id)!.delivery).toMatchObject({ active: false, publish: "disabled" });
  } finally { f.close(); }
});

test("a completed comparison takes over a closed owner's PR and publishes its passed head", async () => {
  pinIds("completed-comparison");
  const f = await fixture();
  try {
    const owner = loadPipelines()[0]!;
    const target = { ...owner.delivery!.target, pr: 17 };
    owner.delivery!.target = target; savePipelines([owner]);
    const created = await createPipelineFromRequest({ task: "Compare the fix", repoDir: f.repo,
      baseRef: owner.lastPassedCommit, delivery: { branch: target.branch, remote: "origin", pr: target.pr },
      stages: stages as never }, f.h.ports);
    expect(created.error).toBeUndefined();
    const id = created.pipeline!.id;
    expect(created.pipeline!.delivery!.disposition).toBe("comparison");
    await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
    const head = await f.commit("passed comparison fix");
    await f.finish(2); await tickPipelines([], f.h.ports); await f.finish(3);
    expect(findPipelineRecord(id)!.state).toBe("completed");
    expect(findPipelineRecord(id)!.publishedCommit).not.toBe(head);
    expect((await rawPatchPipeline(owner.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
    expect((await rawPatchPipeline(id, { action: "takeover", expectedOwner: owner.id,
      expectedEpoch: 1, reason: "Deliver the passed comparison" }, f.h.ports)).error).toBeUndefined();
    // A fresh controller reads the pending intent and reopens the real stored
    // pass. No parent-process copy supplies the outcome or publication cursor.
    const restarted = await f.execute(process.execPath, ["-e", `
      const { settlePendingRemoteActions } = await import("./src/lib/pipelines/engine.ts");
      await settlePendingRemoteActions();
    `], process.cwd());
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(findPipelineRecord(id)!.remoteAction!.error).toBeUndefined();
    expect((await rawPatchPipeline(id, { action: "publish" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(await f.git(f.remote, "rev-parse", target.branch)).toBe(head);
    expect(findPipelineRecord(id)).toMatchObject({ state: "completed", publishedCommit: head });
  } finally { f.close(); }
});

test.each(["live owner", "closed successor", "hidden successor", "failed verdict", "missing head", "running publisher", "stale epoch"] as const)(
  "completed comparison recovery refuses %s", async condition => {
    savePipelines([]);
    const target = { repository: "fixture", branch: "refs/heads/result", remote: "origin", pr: 17 };
    const lane = (id: string) => buildPipeline({ id, task: "Deliver the passed head", project: "fixture", repoDir: "/fixture",
      now: CLOCK, srcPath: null, srcConversationId: null, stages: [{ id: "review", kind: "run", prompt: "Review", next: null,
        effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } }] });
    const owner = await createPipelineWithDelivery(lane("owner"), target);
    const comparison = await createPipelineWithDelivery(lane("comparison"), target);
    owner.state = condition === "live owner" ? "running" : "closed";
    owner.closedAt = condition === "live owner" ? null : CLOCK;
    if (owner.state === "closed") owner.cursor = null;
    if (condition === "running publisher") owner.delivery!.operation = { id: "writer", epoch: 1,
      sha: "a".repeat(40), state: "running" };
    comparison.state = condition === "closed successor" ? "closed" : "completed";
    comparison.closedAt = CLOCK; comparison.cursor = null;
    comparison.hiddenAt = condition === "hidden successor" ? CLOCK : null;
    comparison.lastPassedCommit = condition === "missing head" ? "" : "a".repeat(40);
    comparison.runs[0]!.attempts = [{ n: 1, state: "passed", verdict: { status: condition === "failed verdict" ? "fail" : "pass" },
      effectiveRole: comparison.stages[0]!.effectiveRole, startedAt: CLOCK, completedAt: CLOCK,
      launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
      input: null, output: null, error: null, activatedBy: null }];
    savePipelines([owner, comparison]);
    const taken = await takeoverPipelineDelivery(comparison.id, owner.id, condition === "stale epoch" ? 99 : 1, "Recover", null);
    expect(taken.status).toBe(409);
    expect(findPipelineRecord(comparison.id)!.delivery).toMatchObject({ disposition: "comparison", active: false, epoch: 1 });
    expect(findPipelineRecord(owner.id)!.delivery!.epoch).toBe(1);
    if (condition === "running publisher") expect(findPipelineRecord(owner.id)!.delivery!.active).toBe(true);
  });

test.each(["refused", "superseded"] as const)("a %s takeover parks a progressing comparison and emits a lane event", async (outcome) => {
  pinIds(`takeover-${outcome}`);
  const f = await fixture();
  try {
    const owner = loadPipelines()[0]!;
    const created = await createPipelineFromRequest({ task: "Recover publication", repoDir: f.repo,
      baseRef: owner.lastPassedCommit, delivery: { branch: owner.delivery!.target.branch, remote: "origin" },
      stages: stages as never }, f.h.ports);
    expect(created.error).toBeUndefined();
    const id = created.pipeline!.id;
    await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
    expect((await rawPatchPipeline(id, { action: "takeover", expectedOwner: owner.id,
      expectedEpoch: outcome === "refused" ? 99 : 1, reason: "Recover delivery" }, f.h.ports)).error).toBeUndefined();
    if (outcome === "superseded") await withPipelineMutation(async (lanes, persist) => {
      const lane = lanes.find(item => item.id === id)!;
      lane.lastPassedCommit = "b".repeat(40);
      await persist([lane]);
    });
    await settlePendingRemoteActions({ ...f.h.ports, now: () => CLOCK });
    const lane = findPipelineRecord(id)!;
    expect(lane.remoteAction!.state).toBe("settled");
    expect(lane.remoteAction!.error).toBeTypeOf("string");
    expect(lane.state).toBe("needs_decision");
    expect(lane.stateDetail).toContain(lane.remoteAction!.error!);
    expect(projectPipelineEvents([lane])).toContainEqual(expect.objectContaining({
      type: "stage_blocked", at: CLOCK, summary: expect.stringContaining(lane.remoteAction!.error!),
    }));
    expect(lane.publishedCommit).toBeNull();
  } finally { f.close(); }
});

test("a pending takeover holds the pass boundary until its owner claim settles", async () => {
  pinIds("pending-takeover");
  const f = await fixture();
  let descriptor: number | null = null;
  try {
    const owner = loadPipelines()[0]!;
    const created = await createPipelineFromRequest({ task: "Take over before passing", repoDir: f.repo,
      baseRef: owner.lastPassedCommit, delivery: { branch: owner.delivery!.target.branch, remote: "origin" },
      stages: stages as never }, f.h.ports);
    expect(created.error).toBeUndefined();
    const id = created.pipeline!.id;
    await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
    const head = await f.commit("waiting for delivery authority");
    expect((await rawPatchPipeline(id, { action: "takeover", expectedOwner: owner.id,
      expectedEpoch: 1, reason: "Deliver before advancing" }, f.h.ports)).error).toBeUndefined();
    const lock = path.join(pipelineArtifactsDir(id), "remote-action.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    descriptor = await acquirePublicationFileLock(lock);
    expect(descriptor).not.toBeNull();
    await f.finish(2);
    const waiting = findPipelineRecord(id)!;
    expect(waiting.remoteAction!.state).toBe("pending");
    expect(waiting.cursor).toMatchObject({ stageId: "build", state: "running" });
    expect(waiting.lastPassedCommit).toBe(owner.lastPassedCommit);
    releasePublicationFileLock(descriptor!); descriptor = null;
    await settlePendingRemoteActions(f.h.ports);
    expect(findPipelineRecord(id)!.remoteAction!.error).toBeUndefined();
    await f.finish(2);
    expect(await f.git(f.remote, "rev-parse", owner.delivery!.target.branch)).toBe(head);
  } finally {
    if (descriptor !== null) releasePublicationFileLock(descriptor);
    f.close();
  }
});

test("a takeover lock refusal replaces its pending acknowledgement with a visible park", async () => {
  pinIds("takeover-lock-refusal");
  const f = await fixture();
  try {
    const owner = loadPipelines()[0]!;
    const created = await createPipelineFromRequest({ task: "Recover the parked PR", repoDir: f.repo,
      baseRef: owner.lastPassedCommit, delivery: { branch: owner.delivery!.target.branch, remote: "origin" },
      stages: stages as never }, f.h.ports);
    expect(created.error).toBeUndefined();
    const lane = created.pipeline!;
    lane.state = "needs_decision"; lane.stateDetail = null;
    savePipelines([owner, lane]);
    expect((await rawPatchPipeline(lane.id, { action: "takeover", expectedOwner: owner.id,
      expectedEpoch: 1, reason: "Recover publication" }, f.h.ports)).error).toBeUndefined();
    const lock = path.join(pipelineArtifactsDir(lane.id), "remote-action.lock");
    fs.mkdirSync(lock, { recursive: true });
    await settlePendingRemoteActions(f.h.ports);
    const current = findPipelineRecord(lane.id)!;
    expect(current.state).toBe("needs_decision");
    expect(current.stateDetail).toContain("could not be opened");
    expect(current.remoteAction!.error).toContain("could not be opened");
    expect(current.delivery!.journal.at(-1)!.reason).toContain("refused");
  } finally { f.close(); }
});

test.each(["pause", "owner epoch", "passed head"] as const)("takeover revalidates %s after its remote probe", async changed => {
  pinIds(`probe-${changed}`);
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let settlement: Promise<void> | undefined;
  try {
    const owner = loadPipelines()[0]!;
    const created = await createPipelineFromRequest({ task: "Revalidate takeover", repoDir: f.repo,
      baseRef: owner.lastPassedCommit, delivery: { branch: owner.delivery!.target.branch, remote: "origin" },
      stages: stages as never }, f.h.ports);
    expect(created.error).toBeUndefined();
    const id = created.pipeline!.id;
    const lock = path.join(f.root, "interrupted-publisher.lock"); fs.writeFileSync(lock, "");
    const stat = fs.statSync(lock);
    owner.delivery!.operation = { id: "interrupted-publisher", epoch: 1, sha: owner.lastPassedCommit, state: "running",
      executor: { pid: 1, identity: null, lock, lockIdentity: `${stat.dev}:${stat.ino}` } };
    savePipelines([owner, findPipelineRecord(id)!]);
    expect((await rawPatchPipeline(id, { action: "takeover", expectedOwner: owner.id,
      expectedEpoch: 1, reason: "Reconcile the writer" }, f.h.ports)).error).toBeUndefined();
    let entered!: () => void;
    const probing = new Promise<void>(resolve => { entered = resolve; });
    settlement = settlePendingRemoteActions({ ...f.h.ports, exec: async (...args) => {
      entered(); await held;
      return f.h.ports.exec(...args);
    } });
    expect(await Promise.race([probing.then(() => true), settlement.then(() => false)])).toBe(true);
    if (changed === "pause") expect((await rawPatchPipeline(id, { action: "pause" }, f.h.ports)).error).toBeUndefined();
    else await withPipelineMutation(async (lanes, persist) => {
      const current = lanes.find(item => item.id === (changed === "owner epoch" ? owner.id : id))!;
      if (changed === "owner epoch") { current.delivery!.epoch++; current.delivery!.operation!.epoch++; }
      else current.lastPassedCommit = "b".repeat(40);
      await persist([current]);
    });
    release(); await settlement;
    const refused = findPipelineRecord(id)!;
    expect(refused.remoteAction!.error).toBeTypeOf("string");
    expect(refused.delivery).toMatchObject({ disposition: "comparison", active: false, epoch: 1 });
    expect(refused.state).toBe(changed === "pause" ? "paused" : "needs_decision");
    if (changed === "pause") expect(refused.stateDetail).toContain("paused");
  } finally { release(); await settlement; f.close(); }
});
