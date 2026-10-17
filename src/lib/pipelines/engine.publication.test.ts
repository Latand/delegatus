import { expect, test, spawn, fs, path, tickPipelines, createPipelineFromRequest, loadPipelines, savePipelines, patchPipeline, harness, create } from "./engine.fixture";
import { os, engineModule, finishReported, realExec, pipelineIdentity } from "./engine.fixture";
import { realProvisionExec } from "./git";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import type { CreatePipelineRequest, Pipeline } from "./types";

const stages = [
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
] as const;

async function repository() {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-publication-"));
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const h = harness();
  const git = async (cwd: string, ...args: string[]) => {
    const date = ["commit", "merge", "rebase", "am"].includes(args[0]!) ? h.ports.now() : undefined;
    const result = await realExec("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], cwd,
      date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : undefined);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  let pushes = 0;
  h.ports.exec = (...args) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    return realExec(...args);
  };
  h.ports.provisionExec = realProvisionExec;
  h.setConversationActive(false); h.setPaneAlive(false);
  let laneId: string | undefined;
  const create = async (extra: Partial<CreatePipelineRequest> = {}) => {
    const result = await createPipelineFromRequest({ task: "Local publication", repoDir: repo, baseRef: base,
      stages: structuredClone(stages) as unknown as CreatePipelineRequest["stages"], ...extra }, h.ports);
    if (result.pipeline) laneId ??= result.pipeline.id;
    return result;
  };
  const current = () => loadPipelines().find(pipeline => pipeline.id === laneId)!;
  const tick = async (count = 3) => { for (let n = 0; n < count; n++) await tickPipelines([], h.ports); };
  const start = async (extra: Partial<CreatePipelineRequest> = {}) => {
    const result = await create(extra);
    if (!result.pipeline) throw new Error(result.error);
    await tick(2);
    return current();
  };
  const pass = async (n: number) => {
    expect((await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: n === 1 ? "builder" : "reviewer", conversationId: `conversation_stage_${n}` }, h.ports)).error).toBeUndefined();
    await tickPipelines([finishReported(h, `/codex/stage-${n}.jsonl`, "pass", "Checked")], h.ports);
    await tick();
  };
  const addRemote = async (name = "origin") => {
    const remote = path.join(root, `${name}.git`);
    await git(repo, "init", "-q", "--bare", "-b", "main", remote);
    fs.mkdirSync(path.join(remote, "hooks"), { recursive: true });
    await git(repo, "remote", "add", name, remote);
    return remote;
  };
  return { root, repo, base, git, h, create, current, tick, start, pass, addRemote, pushes: () => pushes,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const publication of [undefined, "internal"] as const) test(`remote-less ${publication ?? "default"} lane commits and reviews its local accepted head`, async () => {
  const f = await repository();
  try {
    const lane = await f.start({ publication });
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "builder work\n");
    await f.pass(1);
    const accepted = f.current().lastPassedCommit;
    expect(accepted).not.toBe(f.base);
    expect(await f.git(lane.worktreeDir, "show", `${accepted}:result.txt`)).toBe("builder work");
    expect(f.current().cursor).toMatchObject({ stageId: "review", state: "running" });
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.cwd).toBe(lane.worktreeDir);
    expect(await f.git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(accepted);
    expect(f.pushes()).toBe(0);
    await f.pass(2);
    expect(f.current()).toMatchObject({ state: "completed", lastPassedCommit: accepted });
    expect(f.current().runs[1]!.attempts[0]!.state).toBe("passed");
  } finally { f.cleanup(); }
});

test("a previously stuck default lane advances from its settled unavailable publication", async () => {
  const f = await repository();
  try {
    const lane = await f.start();
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.state = "passed"; attempt.verdict = { status: "pass", findings: [] }; attempt.completedAt = f.h.ports.now();
    lane.cursor!.state = "committing";
    lane.stateDetail = "passed but unpublished: the delivery remote is unavailable; configure it to publish this accepted head";
    lane.delivery!.operation = { id: "old-publication", epoch: lane.delivery!.epoch, sha: f.base, state: "settled", at: f.h.ports.now(),
      result: { ok: true, remote: "unavailable", sha: f.base }, passedStage: true } as NonNullable<Pipeline["delivery"]>["operation"];
    savePipelines([lane]); await f.tick(2);
    expect(f.current().cursor).toMatchObject({ stageId: "review", state: "running" });
    expect(f.current().stateDetail).toBeNull(); expect(f.pushes()).toBe(0);
  } finally { f.cleanup(); }
});

test("creation refuses an explicit remote policy without a remote and distinguishes unreadable remotes", async () => {
  const f = await repository();
  try {
    const refused = await f.create({ publication: "remote-branch" });
    expect(refused).toMatchObject({ status: 400, violations: [{ field: "publication", message: expect.stringContaining("needs a delivery remote") }] });
    expect(await f.create({ publication: "remote-branch", delivery: { branch: "refs/heads/lane", remote: "origin" } }))
      .toMatchObject({ status: 400, violations: [{ field: "publication" }] });
    expect(loadPipelines()).toHaveLength(0);
    const exec = f.h.ports.exec;
    f.h.ports.exec = (command, args, ...rest) => command === "git" && args[0] === "remote"
      ? { code: 128, stdout: "", stderr: "repository read failed" } : exec(command, args, ...rest);
    expect(await f.create()).toMatchObject({ status: 409, error: expect.stringContaining("could not read") });
    expect(loadPipelines()).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("a remote-less unpinned base provisions from local main", async () => {
  const f = await repository();
  try {
    await f.start({ baseRef: undefined });
    expect(f.current()).toMatchObject({ state: "running", baseRef: f.base, lastPassedCommit: f.base });
  } finally { f.cleanup(); }
});

test("set-delivery-remote adopts a configured remote, clears old publication and publishes the next accepted head", async () => {
  const f = await repository();
  try {
    const lane = await f.start();
    lane.publishedCommit = f.base;
    lane.delivery!.operation = { id: "old", epoch: 1, sha: f.base, state: "settled", at: "now", result: { ok: true, remote: "unavailable", sha: f.base } } as NonNullable<Pipeline["delivery"]>["operation"];
    savePipelines([lane]);
    const remote = await f.addRemote();
    expect((await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote" }, f.h.ports,
      { kind: "agent", conversationId: "conversation_controller", role: "orchestrator" })).error).toBeUndefined();
    expect(f.current().delivery!.target).toMatchObject({ remote, repository: projectIdentityFromRemote(remote, f.repo)!.project });
    expect(f.current().delivery!.epoch).toBe(2);
    expect(f.current().delivery!.operation).toBeUndefined(); expect(f.current().publishedCommit).toBeNull();
    expect(f.current().delivery!.journal.at(-1)!.conversationId).toBe("conversation_controller");
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "published work\n"); await f.pass(1);
    expect(await f.git(remote, "rev-parse", `refs/heads/${lane.branch}`)).toBe(f.current().lastPassedCommit);
    expect(f.current().cursor?.stageId).toBe("review");
  } finally { f.cleanup(); }
});

test("publish refuses a local-only target with a working recovery hint", async () => {
  const f = await repository();
  try {
    const lane = await f.start();
    expect(await engineModule.patchPipeline(lane.id, { action: "publish" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("set-delivery-remote") });
    expect(f.current().delivery!.operation).toBeUndefined();
  } finally { f.cleanup(); }
});

test("an older explicit remote lane parks honestly, admits retry and recovers after adopting origin", async () => {
  const f = await repository();
  try {
    const lane = await f.start(); lane.publication = "remote-branch"; savePipelines([lane]);
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "accepted work\n"); await f.pass(1);
    expect(f.current()).toMatchObject({ state: "needs_decision", cursor: { stageId: "build", state: "committing" },
      stateDetail: expect.stringContaining("set-delivery-remote") });
    expect((await engineModule.patchPipeline(lane.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await f.tick(); expect(f.current().state).toBe("needs_decision");
    const remote = await f.addRemote();
    expect((await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote" }, f.h.ports)).error).toBeUndefined();
    expect(f.current().state).toBe("running"); await f.tick();
    expect(f.current().cursor).toMatchObject({ stageId: "review", state: "running" });
    expect(await f.git(remote, "rev-parse", `refs/heads/${lane.branch}`)).toBe(f.current().lastPassedCommit);
  } finally { f.cleanup(); }
});

for (const refusal of ["unknown", "running", "owned", "redirect", "closed", "hidden", "review-flow"] as const) test(`remote adoption refuses ${refusal} without changing the delivery claim`, async () => {
  const f = await repository();
  try {
    const lane = await f.start(); const remote = await f.addRemote();
    let owners: Pipeline[] = [];
    if (refusal === "running") lane.delivery!.operation = { id: "in-flight", epoch: 1, sha: f.base, state: "running", at: "now" } as NonNullable<Pipeline["delivery"]>["operation"];
    if (refusal === "redirect") lane.delivery!.target.remote = remote;
    if (refusal === "closed") { lane.state = "closed"; lane.closedAt = f.h.ports.now(); lane.cursor = null; }
    if (refusal === "hidden") lane.hiddenAt = f.h.ports.now();
    if (refusal === "owned") {
      const owner = structuredClone(lane); owner.id = "other-owner"; Object.assign(owner, pipelineIdentity(owner.id, owner.task, owner.repoDir));
      owner.delivery!.target = { ...lane.delivery!.target, repository: projectIdentityFromRemote(remote, f.repo)!.project, remote };
      owner.delivery!.ownerId = owner.id; owners = [owner];
    }
    if (refusal === "review-flow") {
      lane.stages[1]!.kind = "review-loop";
      const attempt = structuredClone(lane.runs[0]!.attempts[0]!);
      attempt.effectiveRole = lane.stages[1]!.effectiveRole; attempt.flowId = "live-review";
      lane.runs[1]!.attempts = [attempt]; lane.cursor!.stageId = "review";
    }
    savePipelines([lane, ...owners]); const before = structuredClone(f.current().delivery);
    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", remote: refusal === "unknown" ? "missing" : "origin" }, f.h.ports)).toMatchObject({ status: 409 });
    expect(f.current().delivery).toEqual(before);
  } finally { f.cleanup(); }
});

test("a default lane with origin publishes before review and a refused push cannot spawn review", async () => {
  const f = await repository();
  try {
    const remote = await f.addRemote(); const lane = await f.start();
    const hook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "remote work\n"); await f.pass(1);
    expect(f.h.spawnInputs).toHaveLength(1); expect(f.current().cursor?.stageId).toBe("build");
    fs.rmSync(hook);
    expect((await engineModule.patchPipeline(lane.id, { action: "publish" }, f.h.ports)).error).toBeUndefined(); await f.tick();
    expect(f.current().cursor?.stageId).toBe("review");
    expect(await f.git(remote, "rev-parse", `refs/heads/${lane.branch}`)).toBe(f.current().lastPassedCommit);
  } finally { f.cleanup(); }
});

test("a local reviewer cannot accept a different committed head", async () => {
  const f = await repository();
  try {
    const lane = await f.start(); await f.pass(1);
    const accepted = f.current().lastPassedCommit;
    await f.git(lane.worktreeDir, "commit", "-q", "--allow-empty", "-m", "reviewer commit");
    await f.pass(2);
    expect(f.current().state).toBe("needs_decision");
    expect(f.current().lastPassedCommit).toBe(accepted);
    expect(f.current().runs[1]!.attempts[0]!.error).toContain("read-only");
    expect(f.pushes()).toBe(0);
  } finally { f.cleanup(); }
});

test("adoption uses a named relative push remote and advances beyond its released owner epoch", async () => {
  const f = await repository();
  try {
    const lane = await f.start(); const remote = await f.addRemote("delivery");
    await f.git(f.repo, "remote", "set-url", "--push", "delivery", "../delivery.git");
    const history = structuredClone(lane); history.id = "past-owner";
    Object.assign(history, pipelineIdentity(history.id, history.task, history.repoDir));
    history.state = "completed"; history.cursor = null;
    history.delivery!.target = { ...history.delivery!.target, remote, repository: projectIdentityFromRemote(remote, f.repo)!.project };
    history.delivery!.active = false; history.delivery!.publish = "disabled";
    history.delivery!.ownerId = history.id; history.delivery!.epoch = 7;
    savePipelines([lane, history]);
    expect((await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", remote: "delivery" }, f.h.ports)).error).toBeUndefined();
    expect(f.current().delivery!.epoch).toBe(8);
    expect(f.current().delivery!.target.remote).toBe(remote);
    const before = structuredClone(f.current().delivery);
    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", remote: "delivery" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("never redirected") });
    expect(f.current().delivery).toEqual(before);
  } finally { f.cleanup(); }
});

test("adoption rechecks ownership after its remote read and leaves an in-flight publisher untouched", async () => {
  const f = await repository();
  try {
    const lane = await f.start(); await f.addRemote();
    const exec = f.h.ports.exec;
    let calls = 0;
    f.h.ports.exec = async (...args) => {
      const result = await exec(...args);
      if (args[0] === "git" && args[1][0] === "remote" && calls++ === 0) {
        const current = f.current();
        current.delivery!.operation = { id: "raced-publication", epoch: current.delivery!.epoch, sha: f.base, state: "running" };
        savePipelines([current]);
      }
      return result;
    };
    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("in flight") });
    expect(f.current().delivery!.operation!.id).toBe("raced-publication");
    expect(f.current().delivery!.target.remote).toBe(""); expect(f.current().delivery!.epoch).toBe(1);
  } finally { f.cleanup(); }
});

test("a local comparison takeover keeps its new owner local until a remote is adopted", async () => {
  const f = await repository();
  try {
    const owner = (await f.create({ autoStart: false })).pipeline!;
    const comparison = (await f.create({ autoStart: false, delivery: { branch: owner.delivery!.target.branch, comparison: true } })).pipeline!;
    const { takeoverPipelineDelivery, findPipelineRecord } = await import("./store");
    expect((await takeoverPipelineDelivery(comparison.id, owner.id, owner.delivery!.epoch, "selected comparison", null)).error).toBeUndefined();
    const current = findPipelineRecord(comparison.id)!;
    const { pipelinePublishesRemoteBranch } = await import("./publication");
    expect(current.publication).toBeUndefined(); expect(pipelinePublishesRemoteBranch(current)).toBe(false);
  } finally { f.cleanup(); }
});

test("legacy review delivery keeps the origin fetch repository fence with a separate push URL", async () => {
  const f = await repository();
  try {
    await f.addRemote(); const pushRemote = await f.addRemote("push-target");
    await f.git(f.repo, "remote", "set-url", "--push", "origin", pushRemote);
    const result = await f.create({ autoStart: false, publication: "internal", stages: [
      { id: "plan", kind: "run", role: { roleId: "architect" }, prompt: "Plan", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null },
    ] });
    expect(result).toMatchObject({ status: 400, error: expect.stringContaining("origin repository") });
    expect(loadPipelines()).toHaveLength(0);
  } finally { f.cleanup(); }
});

const legacyReviewStages = [
  { id: "plan", kind: "run", role: { roleId: "architect" }, prompt: "Plan", next: "review" },
  { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null },
] as const;

test.each([
  { label: "origin push URL", remote: undefined, splitOrigin: true },
  { label: "named remote", remote: "delivery", splitOrigin: false },
] as const)("remote adoption refuses a legacy review target outside origin fetch repository via $label", async ({ remote, splitOrigin }) => {
  const f = await repository();
  try {
    const lane = await f.start({ publication: "internal", stages: structuredClone(legacyReviewStages) as unknown as CreatePipelineRequest["stages"] });
    await f.addRemote();
    const other = await f.addRemote("other");
    if (splitOrigin) await f.git(f.repo, "remote", "set-url", "--push", "origin", other);
    else await f.git(f.repo, "remote", "add", "delivery", other);
    const before = structuredClone(f.current().delivery);

    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", ...(remote ? { remote } : {}) }, f.h.ports))
      .toMatchObject({ status: 400, error: expect.stringContaining("origin repository") });
    expect(f.current().delivery).toEqual(before);
    expect(f.current().delivery!.epoch).toBe(1);
  } finally { f.cleanup(); }
});

test("legacy review adoption from origin publishes the accepted head and launches review", async () => {
  const f = await repository();
  try {
    const lane = await f.start({ publication: "internal", stages: structuredClone(legacyReviewStages) as unknown as CreatePipelineRequest["stages"] });
    lane.publication = "remote-branch";
    savePipelines([lane]);
    const origin = await f.addRemote();
    expect((await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote" }, f.h.ports)).error).toBeUndefined();
    await f.pass(1);
    expect(f.current()).toMatchObject({ cursor: { stageId: "review", state: "reviewing" } });
    expect(f.h.flowRequests).toHaveLength(1);
    expect(f.h.flowRequests[0]).toMatchObject({ targetSha: f.current().lastPassedCommit, headRef: lane.branch, requireRemoteHead: true });
    expect(await f.git(origin, "rev-parse", `refs/heads/${lane.branch}`)).toBe(f.current().lastPassedCommit);
  } finally { f.cleanup(); }
});
