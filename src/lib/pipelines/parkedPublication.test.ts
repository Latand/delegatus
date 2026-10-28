import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

setDefaultTimeout(30_000);

// Store modules bind some paths at import time. Run these real controller
// regressions in a child so their state and module caches cannot affect the
// pre-push hook's other selected suites in the parent Bun process. The child
// needs room for owned-runner setup and cleanup as well as every assertion;
// the bound stays inside the hook's five-minute budget per file.
if (process.env.LLV_PARKED_PUBLICATION_CHILD !== "1") {
  test("isolated parked publication regressions", () => {
    const result = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, LLV_PARKED_PUBLICATION_CHILD: "1" }, encoding: "utf8", timeout: 240_000,
    });
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    expect(result.status).toBe(0);
  }, 245_000);
} else {
const previousState = process.env.LLV_STATE_DIR;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-parked-publication-"));
process.env.LLV_STATE_DIR = state;
const { pipelineCorpus } = await import("./fixtures/corpus");
const { savePipelines, findPipelineRecord } = await import("./store");
const { defaultPipelinePorts, patchPipeline, tickPipelines } = await import("./engine");
const { realExec } = await import("@/lib/workflows/provision");
const { prepareStageGitGuard, stageGitReceiptDirectory } = await import("@/lib/git/stageAttemptGuard");
const { agentPublicationIdentityEnv } = await import("@/lib/git/agentPublicationIdentity");
const { projectIdentityFromRemote } = await import("@/lib/projects/identity");
const { registerPipelineTick } = await import("./controllerSignal");
let restore = registerPipelineTick(async () => {});
afterAll(() => {
  restore();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(state, { recursive: true, force: true });
});

// Run the real PR verifier against a fixture service. Its head comes from
// the bare remote, so an unpushed or mismatched head cannot advance the lane.
// This function is also installed in the fresh-process retry controllers.
async function publicationFixtureExec(...args: Parameters<typeof realExec>) {
  const [command, argv, cwd, env, options] = args;
  if (command !== "gh") return realExec(...args);
  const unavailable = { code: 1, stdout: "", stderr: "fixture pull request service unavailable" };
  if (argv[0] !== "pr" || !["list", "view"].includes(argv[1]!)
    || !argv.includes("number,headRefName,baseRefName,state,headRefOid,isCrossRepository")
    || argv[argv.indexOf("--repo") + 1] !== "example/widgets") return unavailable;
  if (argv[1] === "view" && argv[2] !== "17") return unavailable;
  const branch = await realExec("git", ["symbolic-ref", "--short", "HEAD"], cwd, env, options);
  if (branch.code !== 0) return unavailable;
  const headRefName = branch.stdout.trim();
  if (argv[1] === "list" && (argv[argv.indexOf("--head") + 1] !== headRefName
    || argv[argv.indexOf("--base") + 1] !== "main")) return unavailable;
  const remote = await realExec("git", ["ls-remote", "--heads", "origin", `refs/heads/${headRefName}`], cwd, env, options);
  if (remote.code !== 0) return unavailable;
  const headRefOid = remote.stdout.trim().split(/\s+/)[0];
  if (!headRefOid) return argv[1] === "list" ? { code: 0, stdout: "[]", stderr: "" } : unavailable;
  const pr = { number: 17, headRefName, headRefOid, baseRefName: "main", state: "OPEN", isCrossRepository: false };
  return { code: 0, stdout: JSON.stringify(argv[1] === "list" ? [pr] : pr), stderr: "" };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-publication-repo-"));
  const repo = path.join(root, "source"); fs.mkdirSync(repo);
  const remote = path.join(root, "remote.git");
  let workingRepo = repo;
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], { cwd: workingRepo, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z" } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main"); git("init", "-q", "--bare", remote);
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  git("commit", "-q", "--allow-empty", "-m", "base"); const base = git("rev-parse", "HEAD");
  const lane = pipelineCorpus(2, 1)[1]!;
  git("checkout", "-q", "-b", lane.branch);
  fs.writeFileSync(path.join(repo, "stage.txt"), "passed work\n"); git("add", "."); git("commit", "-q", "-m", "passed stage");
  const passed = git("rev-parse", "HEAD");
  git("checkout", "-q", "main"); fs.writeFileSync(path.join(repo, "main.txt"), "hook repair\n");
  git("add", "."); git("commit", "-q", "-m", "main hook repair"); git("checkout", "-q", lane.branch);
  git("merge", "-q", "--no-ff", "main", "-m", "merge main"); const head = git("rev-parse", "HEAD");
  // Git still uses the real local transport and hooks, including from child
  // controllers, while the delivery target names the fixture PR service.
  const deliveryRemote = "https://github.com/example/widgets.git";
  git("config", `url.${remote}.insteadOf`, deliveryRemote);
  git("remote", "add", "origin", deliveryRemote);
  git("push", "-q", "origin", "main"); git("fetch", "-q", "origin", "main");
  const checkout = `${repo}-pipeline-${lane.id}`;
  git("checkout", "-q", "main"); git("worktree", "add", "-q", checkout, lane.branch); workingRepo = checkout;
  lane.repoDir = repo; lane.worktreeDir = checkout; lane.baseRef = base; lane.baseBranch = "main";
  lane.state = "needs_decision"; lane.closedAt = null; lane.stateDetail = "the worktree moved after accepting the passed stage";
  lane.publication = "remote-branch"; lane.lastPassedCommit = passed; lane.publishedCommit = null;
  lane.cursor = { stageId: "build", state: "committing", input: null, activatedBy: null };
  lane.stages = [lane.stages[0]!]; lane.stages[0]!.next = null; lane.runs = [lane.runs[0]!];
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = "passed"; attempt.verdict = { status: "pass", findings: [] };
  attempt.agentPath = null; attempt.conversationId = null; attempt.launchId = null; attempt.paneId = null;
  lane.delivery = { target: { repository: projectIdentityFromRemote(deliveryRemote, checkout)!.project, remote: deliveryRemote, branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "enabled", ownerId: lane.id, epoch: 1, active: true, journal: [] };
  savePipelines([lane]);
  let pushes = 0;
  let pullRequestReads = 0;
  const ports = { ...defaultPipelinePorts(), exec: async (...args: Parameters<typeof realExec>) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    if (args[0] === "gh") pullRequestReads++;
    return publicationFixtureExec(...args);
  }, conversationAgentActive: async () => false, stageHostResident: async () => false,
  paneAgentAlive: async () => false, getFlow: () => null, worktreePresent: () => true };
  return { root, repo: checkout, hook: path.join(repo, ".git", "hooks", "pre-push"), remote, lane, git, head, passed, ports, pushes: () => pushes,
    pullRequestReads: () => pullRequestReads,
    current: () => findPipelineRecord(lane.id)!,
    tick: async () => { for (let n = 0; n < 3; n++) await tickPipelines([], ports); },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const recovery of ["automatic", "retry-stage", "publish"] as const) for (const shape of ["old-publication", "no-publication"] as const) test(`a passed unsettled committing stage settles (${shape}, ${recovery})`, async () => {
  const h = fixture();
  const saturated = recovery !== "automatic";
  const { settlePipelineControllerJobs, startPipelineControllerJob, PIPELINE_CONTROLLER_MAX_JOBS } = await import("./controllerJobs");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    h.git("push", "-q", "origin", `HEAD:refs/heads/${h.lane.branch}`);
    const previous = h.head;
    const attempt = h.lane.runs[0]!.attempts[0]!;
    const now = "2026-10-20T10:00:00.000Z";
    attempt.startedAt = now; attempt.completedAt = null;
    attempt.launchId = `unsettled-${shape}-${recovery}`;
    attempt.state = "committing";
    const guard = await prepareStageGitGuard(attempt.launchId, h.repo, realExec, now, async () => {});
    const identity = agentPublicationIdentityEnv({ ...process.env, ...guard });
    const made = await realExec("git", ["commit", "--allow-empty", "-m", "accepted stage output"], h.repo,
      { ...identity, ...guard, GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now });
    expect(made.code, made.stderr).toBe(0);
    const head = h.git("rev-parse", "HEAD");
    h.lane.lastPassedCommit = previous; h.lane.publishedCommit = previous;
    h.lane.state = "running"; h.lane.stateDetail = "Viewer publication: owner"; h.lane.createdAt = now;
    attempt.report = { seq: 1, at: now, actor: { kind: "agent", role: "worker", conversationId: "stage-owner" },
      verdict: { status: "pass" }, summary: "Accepted stage output", calls: 1,
      provenance: { state: "complete", head, branch: h.lane.branch, uncommitted: [], outputs: [], pullRequest: null, pullRequestState: "absent" } };
    savePipelines([h.lane]);
    let clock = "2026-10-20T10:01:00.000Z";
    const ports = { ...h.ports, now: () => clock };
    if (shape === "old-publication") {
      expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
      expect(h.current().delivery!.operation).toMatchObject({ state: "pending", sha: previous });
    }
    const queued = h.current();
    const { tickPipelinesController } = await import("./controllerPass");
    if (saturated) {
      for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++) {
        expect(startPipelineControllerJob(`held-publication-${n}`, () => held, async () => "unchanged")).toBe(true);
      }
      // A fresh pass waits; the persisted report, rather than an in-memory
      // counter, also bounds admission in a replacement controller process.
      await tickPipelinesController([], ports);
      expect(h.current().state).toBe("running");
      clock = "2026-10-20T10:15:00.000Z";
      const script = `const { defaultPipelinePorts } = await import(${JSON.stringify(path.join(import.meta.dir, "engine.ts"))});
        const { tickPipelinesController } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerPass.ts"))});
        const { startPipelineControllerJob, settlePipelineControllerJobs, PIPELINE_CONTROLLER_MAX_JOBS } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerJobs.ts"))});
        const { registerPipelineTick } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerSignal.ts"))});
        registerPipelineTick(async () => {});
        let release; const held = new Promise(resolve => { release = resolve; });
        try {
          for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++) startPipelineControllerJob('held-' + n, () => held, async () => 'unchanged');
          await tickPipelinesController([], { ...defaultPipelinePorts(), now: () => ${JSON.stringify(clock)},
            conversationAgentActive: async () => false, stageHostResident: async () => false, paneAgentAlive: async () => false });
        } finally { release(); await settlePipelineControllerJobs(); }`;
      const restarted = await realExec(process.execPath, ["-e", script], process.cwd(), process.env, { timeoutMs: 30_000 });
      expect(restarted.code, restarted.stderr).toBe(0);
      expect(h.current().state).toBe("needs_decision");
      expect(h.current().lastPassedCommit).toBe(previous);
      expect(h.current().publishedCommit).toBe(previous);
      expect(h.current().stateDetail).toContain("settling the stage push:");
      expect(h.current().delivery!.operation?.state).not.toBe("pending");
      if (shape === "old-publication") {
        const { publishPipelineBranch } = await import("./git");
        const stale = await publishPipelineBranch(queued, ports.exec, { acceptedSha: previous });
        expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("newer reservation") });
        expect(h.current().delivery!.operation?.state).toBe("settled");
      }
      expect(h.git("rev-parse", "HEAD")).toBe(head);
      expect(h.pushes()).toBe(0);
      release(); await settlePipelineControllerJobs();
      const stranger = { kind: "agent" as const, role: "worker", conversationId: "other-lane" };
      expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: head }, ports, stranger)).status).toBe(403);
      expect((await patchPipeline(h.lane.id, { action: "retry-stage", expectedStageId: "other" }, ports)).code).toBe("STAGE_CHANGED");
      expect((await patchPipeline(h.lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: attempt.n + 1 }, ports)).code).toBe("STAGE_CHANGED");
      const request = recovery === "retry-stage"
        ? { action: "retry-stage" as const, expectedStageId: "build", expectedAttempt: attempt.n }
        : { action: "publish" as const, acceptedSha: head };
      expect((await patchPipeline(h.lane.id, request, ports)).error).toBeUndefined();
    }
    for (let n = 0; n < 4; n++) {
      await tickPipelinesController([], ports);
      await settlePipelineControllerJobs();
    }
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: head, publishedCommit: head });
    expect(h.current().delivery!.operation).toMatchObject({ state: "settled", sha: head });
    expect(h.pushes()).toBe(1);
  } finally { release(); await settlePipelineControllerJobs(); h.cleanup(); }
});

test("admission expiry preserves an executing publisher and an owned settlement job", async () => {
  const h = fixture();
  const { startPipelineControllerJob, settlePipelineControllerJobs, PIPELINE_CONTROLLER_MAX_JOBS } = await import("./controllerJobs");
  const { tickPipelinesController } = await import("./controllerPass");
  const { publishPipelineBranch } = await import("./git");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  let publication: ReturnType<typeof publishPipelineBranch> | undefined;
  try {
    h.lane.state = "running"; h.lane.stateDetail = "Viewer publication: owner";
    h.lane.lastPassedCommit = h.head;
    const attempt = h.lane.runs[0]!.attempts[0]!;
    attempt.state = "committing"; attempt.startedAt = "2026-10-20T10:00:00.000Z"; attempt.completedAt = null;
    savePipelines([h.lane]);
    const ports = { ...h.ports, now: () => "2026-10-20T11:00:00.000Z" };
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++) {
      expect(startPipelineControllerJob(n === 0 ? h.lane.id : `owned-job-${n}`, () => held, async () => "unchanged")).toBe(true);
    }
    await tickPipelinesController([], ports);
    expect(h.current().state).toBe("running");
    release(); await settlePipelineControllerJobs();
    const publisherHeld = new Promise<void>(resolve => { release = resolve; });
    publication = publishPipelineBranch(h.current(), async (...args: Parameters<typeof realExec>) => {
      if (args[0] === "git" && args[1][0] === "push") { entered(); await publisherHeld; }
      return h.ports.exec(...args);
    }, { acceptedSha: h.head });
    // Await the dispatch boundary, never elapsed time, and keep a bounded
    // failure if the publisher refuses before reaching it.
    await Promise.race([writing, publication.then(result => { throw new Error(JSON.stringify(result)); })]);
    const operation = h.current().delivery!.operation!;
    expect(operation.state).toBe("running");
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++) {
      expect(startPipelineControllerJob(`publisher-peer-${n}`, () => publisherHeld, async () => "unchanged")).toBe(true);
    }
    await tickPipelinesController([], ports);
    expect(h.current().state).toBe("running");
    expect(h.current().delivery!.operation!.id).toBe(operation.id);
    expect(h.current().delivery!.operation!.state).toBe("running");
    release();
    expect(await publication).toMatchObject({ ok: true, remote: "published" });
  } finally { release(); await publication; await settlePipelineControllerJobs(); h.cleanup(); }
});

for (const change of ["epoch", "pause"] as const) test(`admission expiry refuses a lane changed before its mutation (${change})`, async () => {
  const h = fixture();
  const store = await import("./store");
  const mutate = store.withPipelineMutation;
  const { tickPipelinesController } = await import("./controllerPass");
  const { startPipelineControllerJob, settlePipelineControllerJobs, PIPELINE_CONTROLLER_MAX_JOBS } = await import("./controllerJobs");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let raced = false;
  let mutation: ReturnType<typeof spyOn> | undefined;
  try {
    h.lane.state = "running"; h.lane.stateDetail = "Viewer publication: owner";
    const attempt = h.lane.runs[0]!.attempts[0]!;
    attempt.state = "committing"; attempt.startedAt = "2026-10-20T10:00:00.000Z"; attempt.completedAt = null;
    savePipelines([h.lane]);
    const ports = { ...h.ports, now: () => "2026-10-20T11:00:00.000Z" };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    const reservation = h.current().delivery!.operation!.id;
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++) {
      expect(startPipelineControllerJob(`racing-job-${n}`, () => held, async () => "unchanged")).toBe(true);
    }
    // Interpose a real peer write after selection and before the expiry's
    // mutation lease. The expiry must retain that writer's epoch or pause.
    mutation = spyOn(store, "withPipelineMutation").mockImplementationOnce(async (apply, observe) => {
      await mutate(async (rows, persist) => {
        const lane = rows.find(row => row.id === h.lane.id)!;
        if (change === "epoch") {
          lane.delivery!.epoch++;
          lane.delivery!.operation = { id: "epoch-successor", epoch: lane.delivery!.epoch, sha: lane.lastPassedCommit, state: "pending" };
        }
        else { lane.state = "paused"; lane.pausedState = "running"; }
        await persist([lane]); raced = true;
      });
      return mutate(apply, observe);
    });
    await tickPipelinesController([], ports);
    expect(raced).toBe(true);
    expect(h.current().state).toBe(change === "pause" ? "paused" : "running");
    expect(h.current().delivery!.epoch).toBe(change === "epoch" ? 2 : 1);
    expect(h.current().delivery!.operation).toMatchObject({ id: change === "epoch" ? "epoch-successor" : reservation, state: "pending" });
    expect(h.pushes()).toBe(0);
  } finally { mutation?.mockRestore(); release(); await settlePipelineControllerJobs(); h.cleanup(); }
});

for (const action of ["publish", "retry-stage"] as const) for (const suffix of ["proved", "unrecorded", "divergent"] as const) test(`${action} without acceptedSha retries a custody-parked stage (${suffix})`, async () => {
  const h = fixture();
  const launchId = `parked-successor-${action}-${suffix}`;
  try {
    h.git("push", "-q", "origin", `${h.passed}:refs/heads/${h.lane.branch}`);
    const attempt = h.lane.runs[0]!.attempts[0]!;
    const now = "2026-10-20T10:00:00.000Z";
    attempt.startedAt = now; attempt.completedAt = null; attempt.launchId = launchId;
    attempt.state = "needs_decision";
    const guard = await prepareStageGitGuard(launchId, h.repo, realExec, now, async () => {});
    const identity = agentPublicationIdentityEnv({ ...process.env, ...guard });
    const env = { ...identity, ...guard, GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now };
    // An unrecorded head has no receipt: its object is written outside a
    // commit command and HEAD reaches it by reset.
    const made = suffix === "unrecorded"
      ? await realExec("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "passed successor output"], h.repo, env)
      : await realExec("git", ["commit", "--allow-empty", "-m", "passed successor output"], h.repo, env);
    expect(made.code, made.stderr).toBe(0);
    if (suffix === "unrecorded") h.git("reset", "-q", "--hard", made.stdout.trim());
    const head = h.git("rev-parse", "HEAD");
    if (suffix === "divergent") {
      h.git("checkout", "-q", "--detach", h.passed);
      h.git("commit", "-q", "--allow-empty", "-m", "foreign delivery output");
      h.git("push", "-q", "origin", `HEAD:refs/heads/${h.lane.branch}`);
      h.git("checkout", "-q", h.lane.branch);
    }
    const tip = h.git("ls-remote", "origin", `refs/heads/${h.lane.branch}`).split(/\s+/)[0];
    h.lane.baseRef = h.head; h.lane.lastPassedCommit = h.head;
    h.lane.stateDetail = `settling the stage push: commit ${tip} does not descend from the pipeline base; both tips are preserved`;
    savePipelines([h.lane]);
    const ports = { ...h.ports, now: () => "2026-10-20T11:00:00.000Z" };
    expect((await patchPipeline(h.lane.id, { action }, ports)).error).toBeUndefined();
    for (let n = 0; n < 3; n++) await tickPipelines([], ports);
    if (suffix === "proved") {
      expect(h.current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, state: "completed" });
      expect(h.pushes()).toBe(1);
    } else {
      expect(h.current().state).toBe("needs_decision");
      expect(h.current().stateDetail).toContain("settling the stage push:");
      expect(h.current().lastPassedCommit).toBe(h.head);
      expect(h.pushes()).toBe(0);
      expect(h.git("ls-remote", "origin", `refs/heads/${h.lane.branch}`).split(/\s+/)[0]).toBe(tip);
      expect(h.current().stateDetail).toContain("pipeline_action publish with acceptedSha");
    }
    if (suffix === "unrecorded") {
      // The seat reviews the refused head and accepts it in place.
      const stranger = { kind: "agent" as const, role: "worker", conversationId: "conversation-of-another-lane" };
      expect(await patchPipeline(h.lane.id, { action: "publish", acceptedSha: head }, ports, stranger)).toMatchObject({ status: 403 });
      fs.writeFileSync(path.join(h.repo, "unsaved.txt"), "keep\n");
      expect(await patchPipeline(h.lane.id, { action: "publish", acceptedSha: head }, ports)).toMatchObject({ status: 409,
        error: expect.stringContaining("uncommitted changes") });
      fs.rmSync(path.join(h.repo, "unsaved.txt"));
      expect(h.current()).toMatchObject({ state: "needs_decision", lastPassedCommit: h.head });
      expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: head.slice(0, 10) }, ports)).error).toBeUndefined();
      expect(h.current()).toMatchObject({ state: "running", lastPassedCommit: head });
      expect(h.current().delivery!.journal.at(-1)).toMatchObject({ kind: "recovery",
        reason: expect.stringContaining(`accepted reviewed head ${head} after commit custody was refused: settling the stage push:`) });
      for (let n = 0; n < 3; n++) await tickPipelines([], ports);
      expect(h.current()).toMatchObject({ lastPassedCommit: head, publishedCommit: head, state: "completed" });
      expect(h.current().runs[0]!.attempts[0]).toMatchObject({ state: "passed", completedAt: "2026-10-20T11:00:00.000Z" });
      expect(h.pushes()).toBe(1);
      expect(h.git("ls-remote", "origin", `refs/heads/${h.lane.branch}`).split(/\s+/)[0]).toBe(head);
    }
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.git("rev-parse", "HEAD")).toBe(head);
  } finally { h.cleanup(); fs.rmSync(stageGitReceiptDirectory(launchId), { recursive: true, force: true }); }
});

// A refused foreign push parks a lane whose own HEAD never moved past the
// passed commit. Accepting that unchanged head is the same in-place recovery.
test("publish acceptedSha accepts a custody-parked head equal to the passed commit", async () => {
  const h = fixture();
  const launchId = "parked-unchanged-head";
  try {
    const attempt = h.lane.runs[0]!.attempts[0]!;
    const now = "2026-10-20T10:00:00.000Z";
    attempt.startedAt = now; attempt.completedAt = null; attempt.launchId = launchId;
    attempt.state = "needs_decision";
    await prepareStageGitGuard(launchId, h.repo, realExec, now, async () => {});
    const refusal = `stage push refused: commit ${"f".repeat(40)} was not created in the attempt worktree during this attempt; commit in the lane worktree and let Delegatus publish`;
    fs.writeFileSync(path.join(stageGitReceiptDirectory(launchId), "refused"), `${refusal}\n`);
    h.lane.lastPassedCommit = h.head;
    h.lane.stateDetail = `${refusal}\nTo accept the stage's own work without a new lane, review the lane head, then call pipeline_action publish with acceptedSha set to that clean worktree HEAD.`;
    savePipelines([h.lane]);
    const ports = { ...h.ports, now: () => "2026-10-20T11:00:00.000Z" };
    expect(h.git("rev-parse", "HEAD")).toBe(h.current().lastPassedCommit);
    const stranger = { kind: "agent" as const, role: "worker", conversationId: "conversation-of-another-lane" };
    expect(await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, ports, stranger)).toMatchObject({ status: 403 });
    fs.writeFileSync(path.join(h.repo, "unsaved.txt"), "keep\n");
    expect(await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, ports)).toMatchObject({ status: 409,
      error: expect.stringContaining("uncommitted changes") });
    fs.rmSync(path.join(h.repo, "unsaved.txt"));
    expect(h.current()).toMatchObject({ state: "needs_decision", lastPassedCommit: h.head });
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, ports)).error).toBeUndefined();
    expect(h.current()).toMatchObject({ state: "running", lastPassedCommit: h.head });
    expect(h.current().delivery!.journal.at(-1)).toMatchObject({ kind: "recovery",
      reason: expect.stringContaining(`accepted reviewed head ${h.head} after commit custody was refused: stage push refused:`) });
    for (let n = 0; n < 3; n++) await tickPipelines([], ports);
    expect(h.current()).toMatchObject({ lastPassedCommit: h.head, publishedCommit: h.head, state: "completed" });
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.current().runs[0]!.attempts[0]).toMatchObject({ state: "passed", completedAt: "2026-10-20T11:00:00.000Z" });
    expect(h.pushes()).toBe(1);
    expect(h.git("ls-remote", "origin", `refs/heads/${h.lane.branch}`).split(/\s+/)[0]).toBe(h.head);
  } finally { h.cleanup(); fs.rmSync(stageGitReceiptDirectory(launchId), { recursive: true, force: true }); }
});

for (const alreadyRemote of [false, true]) test(`parked publication accepts a clean merge descendant and advances (already remote: ${alreadyRemote})`, async () => {
  const h = fixture();
  try {
    if (alreadyRemote) h.git("push", "-q", "origin", `${h.head}:refs/heads/${h.lane.branch}`);
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: alreadyRemote ? h.head : h.head.slice(0, 8) }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ lastPassedCommit: h.head, publishedCommit: h.head, state: "completed" });
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.current().runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    expect(h.current().delivery!.target.pr).toBe(17);
    expect(h.pullRequestReads()).toBeGreaterThan(0);
    expect(h.pushes()).toBe(alreadyRemote ? 0 : 1);
  } finally { h.cleanup(); }
});

for (const failure of ["lookup", "head"] as const) test(`parked publication retains its pass when the PR service refuses ${failure}`, async () => {
  const h = fixture();
  let restoreVerifier = () => {};
  try {
    let clock = 0;
    const waits: number[] = [];
    const timing = { now: () => clock, sleep: async (milliseconds: number) => {
      waits.push(milliseconds);
      clock += milliseconds;
    } };
    const stagePullRequest = await import("./stagePullRequest");
    const verifyPullRequest = stagePullRequest.ensureStagePullRequest;
    // Current main retries a just-published PR head through this injected
    // clock. Delegate to the real verifier so its bounded backoff stays
    // deterministic; older heads ignore the extra optional timing argument.
    const verifier = spyOn(stagePullRequest, "ensureStagePullRequest").mockImplementation(
      (pipeline, attempt, exec, acceptedHead) => Reflect.apply(verifyPullRequest, stagePullRequest,
        [pipeline, attempt, exec, acceptedHead, timing]),
    );
    restoreVerifier = () => verifier.mockRestore();
    const ports = { ...h.ports, exec: async (...args: Parameters<typeof realExec>) => {
      if (args[0] !== "gh") return h.ports.exec(...args);
      if (failure === "lookup") return { code: 1, stdout: "", stderr: "fixture lookup refused" };
      const result = await h.ports.exec(...args);
      const rows = JSON.parse(result.stdout);
      return { ...result, stdout: JSON.stringify(rows.map((row: object) => ({ ...row, headRefOid: "f".repeat(40) }))) };
    } };
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, ports)).error).toBeUndefined();
    for (let n = 0; n < 3; n++) await tickPipelines([], ports);
    expect(h.current()).toMatchObject({ state: "needs_decision", lastPassedCommit: h.head, publishedCommit: h.head });
    expect(h.current().stateDetail).toContain(failure === "lookup" ? "pull request lookup failed" : "pull request differs in headRefOid");
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.current().runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    expect(h.current().delivery!.target.pr).toBeUndefined();
    expect(h.pushes()).toBe(1);
    if (failure === "head") {
      expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 14_000].slice(0, waits.length));
      expect(waits.length).toBeLessThanOrEqual(5);
      expect(clock).toBeLessThanOrEqual(30_000);
    }
  } finally { restoreVerifier(); h.cleanup(); }
});

test("publication refuses stale and ambiguous short heads without changing accepted evidence", async () => {
  const h = fixture();
  try {
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: "ffffffff" }, h.ports)).status).toBe(409);
    h.lane.lastPassedCommit = h.head.slice(0, 8) + (h.head[8] === "a" ? "b" : "a") + h.head.slice(9);
    savePipelines([h.lane]);
    const accepted = h.current().lastPassedCommit;
    expect(await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head.slice(0, 8) }, h.ports)).toMatchObject({ code: "short_id_ambiguous", field: "acceptedSha" });
    expect(h.current().lastPassedCommit).toBe(accepted);
    expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});

function terminalReview(h: ReturnType<typeof fixture>) {
  const builder = h.lane.stages[0]!;
  builder.next = "review";
  // Keep the shared corpus unchanged: publication exercises current run stages.
  h.lane.stages.push({ ...pipelineCorpus(2, 1)[1]!.stages[1]!, kind: "run" });
  const attempt = structuredClone(h.lane.runs[0]!.attempts[0]!);
  attempt.effectiveRole = h.lane.stages[1]!.effectiveRole!;
  attempt.flowId = null;
  attempt.reviewHeadSha = null; attempt.expectedReviewHeadSha = null;
  attempt.reviewedHead = h.passed;
  h.lane.runs.push({ ...h.lane.runs[0]!, stageId: "review", attempts: [attempt] });
  h.lane.cursor = { stageId: "review", state: "committing", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } };
  savePipelines([h.lane]);
}

// An explicit budget stop controls recovery even when an earlier fix still
// needs publication. Publishing that fix never supplies a review verdict,
// and the fixed budget cannot be extended to leave the stop.
function terminalBudgetPark(h: ReturnType<typeof fixture>) {
  terminalReview(h);
  const stage = h.lane.stages[1]!;
  stage.onFail = { to: "build", maxRounds: 1, onExhausted: "park" };
  const attempt = h.lane.runs[1]!.attempts[0]!;
  attempt.state = "failed";
  attempt.verdict = { status: "fail", findings: ["P1 retained defect"] };
  attempt.completedAt = new Date().toISOString();
  attempt.activatedBy = { stageId: "build", attempt: 1, edge: "pass", budgetRecheck: true };
  h.lane.lastPassedCommit = h.head;
  h.lane.stateDetail = "budget spent: retained terminal findings; explicit operator stop";
  h.lane.reviewPending = { terminalRecheck: true, stageId: "review", attempt: 1,
    fixStageId: "build", fixAttempt: 1, reviewedHead: h.head, currentHead: h.head,
    verdict: "fail", findings: 1, at: attempt.completedAt };
  savePipelines([h.lane]);
}

for (const timing of ["before execution", "during Git verification", "after final Git verification"] as const) {
  for (const lateVerdict of ["needs_decision", "fail"] as const) {
    test(`deferred skip preserves a terminal budget ${lateVerdict} verdict settled ${timing}`, async () => {
      const h = fixture();
      const { settlePendingRemoteActions } = await import("./engine");
      const { pipelineRevision } = await import("./store");
      let entered!: () => void;
      let release!: () => void;
      const checking = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      let work: Promise<void> | undefined;
      try {
        terminalBudgetPark(h);
        const review = h.lane.runs[1]!.attempts[0]!;
        review.state = "needs_decision"; review.verdict = null; review.completedAt = null;
        review.conversationId = "conversation_fixture_review";
        review.error = "host unavailable before terminal verdict settlement";
        review.reviewedHead = h.head;
        review.report = { seq: 1, at: new Date().toISOString(),
          actor: { kind: "agent", conversationId: review.conversationId, role: "worker" },
          verdict: { status: lateVerdict, findings: ["P1 late review defect"] },
          summary: "late terminal review", calls: 1,
          provenance: { head: h.head, branch: h.lane.branch, uncommitted: [], pullRequest: null, outputs: [] } };
        h.lane.cursor!.state = "pending";
        h.lane.cursor!.activatedBy = structuredClone(review.activatedBy!);
        delete h.lane.reviewPending;
        h.lane.stateDetail = review.error;
        savePipelines([h.lane]);
        const ports = { ...h.ports, remoteActionSupported: () => true, pathForConversation: () => null,
          conversationRuntime: () => null, sourcePathAllowed: () => false, conversationRegistered: () => false };
        expect((await patchPipeline(h.lane.id, { action: "skip-stage" }, ports)).error).toBeUndefined();
        const admittedRevision = pipelineRevision(h.current());
        let delayed = false;
        let gitCalls = 0;
        let branchReads = 0;
        const deferredPorts = { ...ports, exec: async (...args: Parameters<typeof realExec>) => {
          gitCalls++;
          if (timing === "during Git verification" && !delayed && args[0] === "git" && args[1][0] === "status") {
            delayed = true; entered(); await held;
          }
          const executed = await ports.exec(...args);
          if (args[0] === "git" && args[1][0] === "branch" && ++branchReads === 2 && timing === "after final Git verification") {
            entered(); await held;
          }
          return executed;
        } };
        if (timing !== "before execution") {
          work = settlePendingRemoteActions(deferredPorts);
          expect(await Promise.race([checking.then(() => true), work.then(() => false), Bun.sleep(1000).then(() => false)])).toBe(true);
        }
        // Replaying an admitted intent after a restart must also fence the
        // verdict that settled before the recovery executor started.
        const admittedAction = structuredClone(h.current().remoteAction);
        if (timing === "before execution") {
          const awaitingReport = h.current();
          delete awaitingReport.remoteAction;
          savePipelines([awaitingReport]);
        }
        await tickPipelines([], ports);
        const settled = h.current();
        if (timing === "before execution") {
          settled.remoteAction = admittedAction;
          savePipelines([settled]);
        }
        expect(settled).toMatchObject({ state: "needs_decision", reviewPending: { terminalRecheck: true },
          remoteAction: { state: "pending" } });
        expect(settled.runs[1]!.attempts[0]!.verdict).toMatchObject({ status: lateVerdict, findings: ["P1 late review defect"] });
        const retainedReview = structuredClone(settled.runs[1]!.attempts[0]);
        const retainedPending = structuredClone(settled.reviewPending);
        const retainedDetail = settled.stateDetail;
        release();
        if (work) await work;
        else await settlePendingRemoteActions(deferredPorts);
        await h.tick();
        expect(h.current()).toMatchObject({ state: "needs_decision", closedAt: null, publishedCommit: null,
          reviewPending: retainedPending, stateDetail: retainedDetail, remoteAction: { state: "settled", error: expect.any(String) } });
        expect(h.current().runs[1]!.attempts).toEqual([retainedReview!]);
        expect(h.current().delivery!.operation).toBeUndefined();
        expect(h.current().reviewGrants).toBeUndefined();
        expect(h.pushes()).toBe(0);
        if (timing === "before execution") expect(gitCalls).toBe(0);
        for (const action of ["skip-stage", "retry-stage"] as const) {
          expect(await patchPipeline(h.lane.id, { action }, ports)).toMatchObject({ status: 409, error: expect.stringContaining("Review budget is fixed") });
        }
        expect((await patchPipeline(h.lane.id, { action: "continue-review", clientRequestId: "stale-race-grant",
          addRounds: 1, expectedRevision: admittedRevision }, ports, { kind: "operator" })).status).toBe(409);
        const fixedRevision = pipelineRevision(h.current());
        expect(await patchPipeline(h.lane.id, { action: "continue-review", clientRequestId: "fresh-race-grant",
          addRounds: 1, expectedRevision: fixedRevision }, ports, { kind: "operator" }))
          .toMatchObject({ status: 409, error: expect.stringContaining("Review budget is fixed") });
        expect(pipelineRevision(h.current())).toBe(fixedRevision);
        expect(h.current()).toMatchObject({ state: "needs_decision", reviewPending: retainedPending });
        expect(h.current().reviewGrants).toBeUndefined();
        expect(h.current().stages[1]!.onFail!.maxRounds).toBe(1);
        expect(h.pushes()).toBe(0);
      } finally { release(); await work; h.cleanup(); }
    });
  }
}

for (const action of ["publish", "retry-stage"] as const) test(`a passed publication park with budget activation remains retryable through ${action}`, async () => {
  const h = fixture();
  try {
    terminalReview(h);
    const attempt = h.lane.runs[1]!.attempts[0]!;
    attempt.activatedBy = { stageId: "build", attempt: 1, edge: "pass", budgetRecheck: true };
    h.lane.lastPassedCommit = h.head;
    h.lane.stateDetail = "hook failed";
    h.lane.delivery!.operation = { id: "failed-publication", state: "settled", epoch: 1, sha: h.head,
      passedStage: true, result: { ok: false, error: "hook failed" } };
    savePipelines([h.lane]);
    expect((await patchPipeline(h.lane.id, { action: "continue-review", clientRequestId: "unneeded-grant",
      addRounds: 1, expectedRevision: (await import("./store")).pipelineRevision(h.current()) }, h.ports, { kind: "operator" })).status).toBe(409);
    expect((await patchPipeline(h.lane.id, { action }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: h.head });
    expect(h.current().runs[1]!.attempts).toHaveLength(1);
    expect(h.current().runs[1]!.attempts[0]!.verdict?.status).toBe("pass");
    expect(h.current().reviewGrants).toBeUndefined();
  } finally { h.cleanup(); }
});

for (const hookFails of [false, true]) test(`publishing an unpublished fix preserves its terminal budget park (hook fails: ${hookFails})`, async () => {
  const h = fixture();
  const { pipelineRevision } = await import("./store");
  try {
    terminalBudgetPark(h);
    const pending = structuredClone(h.lane.reviewPending);
    const review = structuredClone(h.lane.runs[1]!.attempts[0]);
    fs.writeFileSync(h.hook, hookFails ? "#!/bin/sh\necho retained-hook-phase >&2\nexit 7\n" : "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const ports = { ...h.ports, remoteActionSupported: () => false };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ state: "needs_decision", closedAt: null, reviewPending: pending,
      lastPassedCommit: h.head, delivery: { ownerId: h.lane.id, epoch: 1, operation: { state: "settled", result: { ok: !hookFails } } } });
    expect(h.current().runs[1]!.attempts).toEqual([review!]);
    expect(h.current().delivery!.operation!.passedStage).not.toBe(true);
    expect(h.pushes()).toBe(1);
    const result = h.current().delivery!.operation!.result!;
    if (!result.ok) expect(result.error).toContain("retained-hook-phase");
    else expect(h.current().publishedCommit).toBe(h.head);
    for (const action of ["retry-stage", "skip-stage"] as const) {
      expect(await patchPipeline(h.lane.id, { action }, ports)).toMatchObject({ status: 409, error: expect.stringContaining("Review budget is fixed") });
    }
    const current = h.current();
    const fixedRevision = pipelineRevision(current);
    expect(await patchPipeline(h.lane.id, { action: "continue-review", clientRequestId: "budget-before-recovery",
      addRounds: 1, expectedRevision: fixedRevision }, ports, { kind: "operator" }))
      .toMatchObject({ status: 409, error: expect.stringContaining("Review budget is fixed") });
    expect(pipelineRevision(h.current())).toBe(fixedRevision);
    expect(h.current()).toMatchObject({ state: "needs_decision", reviewPending: pending });
    expect(h.current().reviewGrants).toBeUndefined();
    expect(h.current().stages[1]!.onFail!.maxRounds).toBe(1);
    expect(h.current().runs[1]!.attempts).toEqual([review!]);
    expect(h.pushes()).toBe(1);
  } finally { h.cleanup(); }
});

test("a failed terminal budget park cannot accept a moved head as passed publication", async () => {
  const h = fixture();
  const { pipelineRevision } = await import("./store");
  try {
    terminalBudgetPark(h);
    // The last accepted fix predates the clean merge, but its reviewer failed.
    h.lane.lastPassedCommit = h.passed;
    h.lane.reviewPending!.currentHead = h.passed;
    savePipelines([h.lane]);
    const revision = pipelineRevision(h.current());
    expect(await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, h.ports)).toMatchObject({ status: 409,
      error: expect.stringContaining("parked passed stage") });
    await h.tick();
    expect(pipelineRevision(h.current())).toBe(revision);
    expect(h.current().delivery!.operation).toBeUndefined();
    expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});

for (const kind of ["linear work", "extra merge content", "foreign side branch"] as const) test(`terminal review refuses moved-head publication with unreviewed ${kind}`, async () => {
  const h = fixture();
  try {
    terminalReview(h);
    if (kind === "foreign side branch") {
      h.git("checkout", "-q", "-b", "unreviewed-side");
      fs.writeFileSync(path.join(h.repo, "application.txt"), "unreviewed work\n");
      h.git("add", "."); h.git("commit", "-q", "-m", "additional application work");
      h.git("checkout", "-q", h.lane.branch); h.git("merge", "-q", "--no-ff", "unreviewed-side", "-m", "merge unreviewed work");
    } else {
      fs.writeFileSync(path.join(h.repo, "application.txt"), "unreviewed work\n"); h.git("add", ".");
      h.git("commit", "-q", ...(kind === "extra merge content" ? ["--amend", "--no-edit"] : ["-m", "additional application work"]));
    }
    const accepted = h.git("rev-parse", "HEAD");
    const result = await patchPipeline(h.lane.id, { action: "publish", acceptedSha: accepted }, h.ports);
    expect(result.status).toBe(409); expect(result.error).toContain("fresh review");
    await h.tick();
    expect(h.current()).toMatchObject({ state: "needs_decision", lastPassedCommit: h.passed, publishedCommit: null });
    expect(h.current().runs[1]!.attempts).toHaveLength(1);
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ reviewedHead: h.passed, verdict: { status: "pass" } });
    expect(h.current().delivery!.operation).toBeUndefined(); expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});

for (const alreadyRemote of [false, true]) test(`terminal review accepts only clean main integration and retains reviewed provenance (already remote: ${alreadyRemote})`, async () => {
  const h = fixture();
  try {
    terminalReview(h);
    if (alreadyRemote) h.git("push", "-q", "origin", `${h.head}:refs/heads/${h.lane.branch}`);
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: h.head, publishedCommit: h.head });
    expect(h.current().runs[1]!.attempts).toHaveLength(1);
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ reviewedHead: h.passed,
      publicationIntegration: { passedSha: h.passed, acceptedSha: h.head, mainSha: h.git("rev-parse", "origin/main") }, verdict: { status: "pass" } });
    expect(h.pushes()).toBe(alreadyRemote ? 0 : 1);
  } finally { h.cleanup(); }
});

for (const seam of ["admission", "integration proof", "publication"] as const) test(`replacement refs cannot make unreviewed application work pass ${seam}`, async () => {
  const h = fixture();
  const { verifyPassedHeadIntegration, publishPipelineBranch } = await import("./git");
  try {
    terminalReview(h);
    fs.writeFileSync(path.join(h.repo, "unreviewed.txt"), "later application work\n");
    h.git("add", "."); h.git("commit", "-q", "-m", "later application work");
    const original = h.git("rev-parse", "HEAD");
    const replacement = h.git("commit-tree", `${h.head}^{tree}`, "-p", h.passed, "-p", "origin/main", "-m", "replacement fixture");
    h.git("replace", original, replacement); h.git("reset", "--hard", original);
    expect(h.git("status", "--porcelain")).toBe("");
    if (seam === "integration proof") {
      const result = await verifyPassedHeadIntegration(h.lane, h.passed, original, h.ports.exec);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.includes("fresh review")).toBe(true);
    } else if (seam === "publication") {
      const result = await publishPipelineBranch(h.current(), h.ports.exec, { acceptedSha: original });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.includes("uncommitted")).toBe(true);
      expect(h.current().publishedCommit).toBeNull();
    } else {
      const result = await patchPipeline(h.lane.id, { action: "publish", acceptedSha: original }, h.ports);
      expect(result.status).toBe(409);
      expect(result.error?.includes("uncommitted") || result.error?.includes("fresh review")).toBe(true);
      expect(h.current().lastPassedCommit).toBe(h.passed);
      expect(h.current().delivery!.operation).toBeUndefined();
    }
    expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});

for (const source of ["replacement refs", "legacy grafts"]) for (const seam of ["admission", "integration proof"] as const) test(`${source} cannot invent passed ancestry for ${seam}`, async () => {
  const h = fixture();
  const { verifyPassedHeadIntegration } = await import("./git");
  try {
    terminalReview(h);
    const main = h.git("rev-parse", "origin/main");
    if (source === "replacement refs") {
      const replacement = h.git("commit-tree", `${main}^{tree}`, "-p", h.passed, "-m", "replacement ancestry fixture");
      h.git("replace", main, replacement);
    } else {
      const grafts = h.git("rev-parse", "--git-path", "info/grafts");
      fs.mkdirSync(path.dirname(grafts), { recursive: true }); fs.writeFileSync(grafts, `${main} ${h.passed}\n`);
    }
    h.git("reset", "--hard", main);
    expect(h.git("status", "--porcelain")).toBe("");
    if (seam === "integration proof") {
      const result = await verifyPassedHeadIntegration(h.lane, h.passed, main, h.ports.exec);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.includes("ancestor")).toBe(true);
    } else {
      const result = await patchPipeline(h.lane.id, { action: "publish", acceptedSha: main }, h.ports);
      expect(result.status).toBe(409); expect(result.error).toContain("ancestor");
      expect(h.current().lastPassedCommit).toBe(h.passed);
      expect(h.current().delivery!.operation).toBeUndefined();
    }
    expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});

for (const source of ["replacement refs", "legacy grafts"]) test(`a later integration preserves literal ancestry to the prior accepted integration despite ${source}`, async () => {
  const h = fixture();
  try {
    terminalReview(h);
    const main = h.git("rev-parse", "origin/main");
    h.lane.lastPassedCommit = h.head;
    h.lane.runs[1]!.attempts[0]!.publicationIntegration = { passedSha: h.passed, acceptedSha: h.head, mainSha: main };
    savePipelines([h.lane]);
    const alternate = h.git("commit-tree", `${h.head}^{tree}`, "-p", h.passed, "-p", main, "-m", "alternate clean integration");
    h.git("reset", "--hard", alternate);
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: alternate }, h.ports)).error).toContain("ancestor");
    if (source === "replacement refs") {
      const replacement = h.git("commit-tree", `${h.head}^{tree}`, "-p", h.head, "-p", main, "-m", "replacement prior integration fixture");
      h.git("replace", alternate, replacement);
    } else {
      const grafts = h.git("rev-parse", "--git-path", "info/grafts");
      fs.mkdirSync(path.dirname(grafts), { recursive: true }); fs.writeFileSync(grafts, `${alternate} ${h.head} ${main}\n`);
    }
    const result = await patchPipeline(h.lane.id, { action: "publish", acceptedSha: alternate }, h.ports);
    expect(result.status).toBe(409); expect(result.error).toContain("ancestor");
    expect(h.current().lastPassedCommit).toBe(h.head);
    expect(h.current().delivery!.operation).toBeUndefined(); expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});

test("parked publication refuses a non-descendant head at admission", async () => {
  const h = fixture();
  try {
    h.git("checkout", "-q", "--orphan", "unrelated"); h.git("rm", "-q", "-rf", ".");
    h.git("commit", "-q", "--allow-empty", "-m", "unrelated"); const head = h.git("rev-parse", "HEAD");
    h.git("branch", "-D", h.lane.branch); h.git("branch", "-m", h.lane.branch);
    const result = await patchPipeline(h.lane.id, { action: "publish", acceptedSha: head }, h.ports);
    expect(result.error).toContain("ancestor"); expect(result.status).toBe(409);
    expect(h.current().lastPassedCommit).toBe(h.passed); expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});

test("failed publication retains the hook tail, exit status and duration in lane detail", async () => {
  const h = fixture();
  try {
    h.lane.lastPassedCommit = h.head; h.lane.state = "running"; h.lane.stateDetail = null; savePipelines([h.lane]);
    const hook = h.hook;
    fs.writeFileSync(hook, "#!/bin/sh\necho pre-push: types >&2\necho pre-push: eslint >&2\necho pre-push: touched-tests >&2\nexit 7\n", { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined(); await h.tick();
    expect(h.current().stateDetail).toContain("pre-push: touched-tests");
    expect(h.current().stateDetail).toContain("exit 1");
    expect(h.current().delivery!.operation!.result).toMatchObject({ failure: { code: 1, signal: null, durationMs: expect.any(Number) } });
    expect(h.current().stateDetail).not.toContain("interrupted publication");
  } finally { h.cleanup(); }
});

test.each(["repaired", "unrepaired"])("skip-stage retries a settled publication failure (%s hook)", async hookState => {
  const repaired = hookState === "repaired";
  const h = fixture();
  h.ports.now = () => "2026-10-22T12:00:00.000Z";
  h.lane.runs[0]!.attempts[0]!.startedAt = "2026-10-22T11:00:00.000Z";
  try {
    h.lane.lastPassedCommit = h.head;
    h.lane.state = "running";
    h.lane.stateDetail = null;
    savePipelines([h.lane]);
    fs.writeFileSync(h.hook, "#!/bin/sh\necho pre-push: privacy >&2\nexit 1\n", { mode: 0o700 });

    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ state: "needs_decision", publishedCommit: null,
      delivery: { operation: { state: "settled", result: { ok: false } } } });
    const failedOperation = h.current().delivery!.operation!.id;
    expect(h.pushes()).toBe(1);

    if (repaired) fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "skip-stage", expectedStageId: "build", expectedAttempt: 1 }, h.ports)).error).toBeUndefined();
    await h.tick();

    expect(h.current()).toMatchObject(repaired
      ? { state: "completed", publishedCommit: h.head }
      : { state: "needs_decision", publishedCommit: null, delivery: { operation: { state: "settled", result: { ok: false } } } });
    expect(h.current().delivery!.operation!.id).not.toBe(failedOperation);
    expect(h.pushes()).toBe(2);
  } finally { h.cleanup(); }
});

/** A lane cut from an older main whose stage left `files` behind (none for a
    read-only stage), with main moved on by `behind` commits since. */
function trailingLane(h: ReturnType<typeof fixture>, behind: number, files: Record<string, string> = {}): string {
  const source = path.join(h.root, "source");
  h.git("reset", "-q", "--hard", h.lane.baseRef!);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true }); fs.writeFileSync(path.join(h.repo, file), text);
  }
  if (Object.keys(files).length) { h.git("add", "."); h.git("commit", "-q", "-m", "stage output"); }
  for (let n = 1; n < behind; n++) h.git("-C", source, "commit", "--allow-empty", "-q", "-m", `later main ${n}`);
  h.git("-C", source, "push", "-q", "origin", "main"); h.git("fetch", "-q", "origin", "main");
  expect(h.git("rev-list", "--count", "HEAD..origin/main")).toBe(String(behind));
  h.lane.lastPassedCommit = h.git("rev-parse", "HEAD"); h.lane.state = "running"; h.lane.stateDetail = null;
  savePipelines([h.lane]);
  return h.lane.lastPassedCommit;
}

/** The hook of a repository whose main carries a test that reads the pushing
    process's settings: green from a shell, red under the Viewer's own
    interface language, launcher handoff or token (bin/server-runtime.test.ts
    did exactly this on five lanes on 2026-10-04). Privacy runs first. */
function viewerSensitiveHook(h: ReturnType<typeof fixture>): string {
  const marker = path.join(h.root, "privacy-ran");
  fs.writeFileSync(h.hook, `#!/bin/sh\nset -eu\necho "pre-push: branch is $(git rev-list --count HEAD..origin/main) commit(s) behind origin/main; merge it" >&2\necho "pre-push: privacy" >&2\ntouch '${marker}'\necho "pre-push: Linux tests" >&2\nif [ -n "\${LLV_LANG:-}\${LLV_LAUNCHER_REEXEC:-}\${LLV_TOKEN:-}\${LLV_STATE_OWNER:-}" ]; then\n  echo "(fail) the CLI names a missing prerequisite [1.00ms]" >&2\n  echo "pre-push: bash failed (1); gate failed" >&2\n  exit 1\nfi\n`, { mode: 0o700 });
  return marker;
}

async function underViewerSettings<T>(run: () => Promise<T>): Promise<T> {
  const settings = { LLV_LANG: "uk", LLV_LAUNCHER_REEXEC: "1", LLV_TOKEN: "fixture-token", NODE_ENV: "production" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("a lane branch behind main whose stage changed nothing publishes: the hook never sees the Viewer's own settings", async () => {
  const h = fixture();
  try {
    const head = trailingLane(h, 3);
    expect(head).toBe(h.lane.baseRef!);
    const marker = viewerSensitiveHook(h);
    await underViewerSettings(async () => {
      expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
      await h.tick();
    });
    // The hook ran, privacy included, and passed as it does from a shell.
    expect(fs.existsSync(marker)).toBe(true);
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: head });
    expect(h.pushes()).toBe(1);
    expect(spawnSync("git", ["--git-dir", h.remote, "rev-parse", `refs/heads/${h.lane.branch}`], { encoding: "utf8" }).stdout.trim()).toBe(head);
  } finally { h.cleanup(); }
});

test("a lane branch behind main whose stage changed one document publishes while main carries a test that fails under the Viewer", async () => {
  const h = fixture();
  try {
    const head = trailingLane(h, 2, { "docs/design/note.md": "# design\n" });
    const marker = viewerSensitiveHook(h);
    await underViewerSettings(async () => {
      expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
      await h.tick();
    });
    expect(fs.existsSync(marker)).toBe(true);
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: head });
  } finally { h.cleanup(); }
});

test("a refused publication of an unchanged head retries on a bounded backoff, then parks with one line a person can act on", async () => {
  const h = fixture();
  try {
    const head = trailingLane(h, 2);
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\necho 'pre-push: Linux tests' >&2\necho '(fail) main is red [2.00ms]' >&2\necho 'pre-push: bash failed (1); gate failed' >&2\nexit 1\n", { mode: 0o700 });
    let clock = Date.parse("2026-10-04T10:00:00.000Z");
    const scheduled: number[] = [];
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: (delay: number) => { scheduled.push(delay); } };
    const tick = async () => { for (let n = 0; n < 3; n++) await tickPipelines([], ports); };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    await tick();
    const cause = "the repository's pre-push hook failed in its \"Linux tests\" phase (exit 1, 1 failing test, first: main is red)";
    expect(h.current().state).toBe("running");
    expect(h.current().stateDetail).toBe(`passed but unpublished: ${cause}. The stage changed no files; automatic retry 1 of 3 at 2026-10-04T10:01:00.000Z`);
    expect(h.current().delivery!.operation!.result).toMatchObject({ failure: { changedFiles: 0 } });
    expect(scheduled).toContain(60_000);
    // Ticks before the wait is over push nothing: no four-second loop.
    await tick(); await tick();
    expect(h.pushes()).toBe(1);
    for (const [wait, pushes] of [[60_000, 2], [5 * 60_000, 3]] as const) {
      clock += wait; await tick();
      expect(h.pushes()).toBe(pushes);
      expect(h.current().state).toBe("running");
      await tick();
      expect(h.pushes()).toBe(pushes);
    }
    expect(h.current().stateDetail).toContain("automatic retry 3 of 3 at 2026-10-04T10:21:00.000Z");
    clock += 15 * 60_000; await tick();
    expect(h.pushes()).toBe(4);
    expect(h.current().state).toBe("needs_decision");
    const [line, ...evidence] = h.current().stateDetail!.split("\n");
    expect(line).toBe(`publishing the passed stage: ${cause}. The stage changed no files; retried 3 times, so the cause is on the base branch or in the hook itself: fix it there, then retry-stage.`);
    expect(evidence.join("\n")).toContain("(fail) main is red");
    // The pass is kept; only its publication waits for a person.
    expect(h.current().runs[0]!.attempts[0]!).toMatchObject({ state: "passed", verdict: { status: "pass" } });
    // Parked means parked: time alone publishes nothing more.
    clock += 60 * 60_000; await tick();
    expect(h.pushes()).toBe(4);
    expect(h.current().publishedCommit).toBeNull();
    // The cause is fixed; a person asks once and the same accepted head lands.
    fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "retry-stage" }, ports)).error).toBeUndefined();
    await tick();
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: head });
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toBeUndefined();
  } finally { h.cleanup(); }
});

test("an interrupted push that never landed is retried on the same bounded backoff, then parks naming the interruption", async () => {
  const h = fixture();
  try {
    const head = trailingLane(h, 2);
    // The hook's parent is the push itself: it dies by signal mid-phase.
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: types' >&2\nkill -9 $PPID\nsleep 0.2\n", { mode: 0o700 });
    let clock = Date.parse("2026-10-04T10:00:00.000Z");
    const scheduled: number[] = [];
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: (delay: number) => { scheduled.push(delay); } };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    // Eight controller ticks with the clock standing still: one push, no loop.
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    const cause = "the push was ended by SIGKILL in the hook's \"types\" phase and did not reach the remote";
    expect(h.pushes()).toBe(1);
    expect(h.current().state).toBe("running");
    expect(h.current().stateDetail).toBe(`passed but unpublished: ${cause}; automatic retry 1 of 3 at 2026-10-04T10:01:00.000Z`);
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toMatchObject({ sha: head, failures: 1 });
    expect(scheduled).toContain(60_000);
    for (const [wait, pushes] of [[60_000, 2], [5 * 60_000, 3]] as const) {
      clock += wait;
      for (let n = 0; n < 8; n++) await tickPipelines([], ports);
      expect(h.pushes()).toBe(pushes);
      expect(h.current().state).toBe("running");
    }
    expect(h.current().stateDetail).toContain("automatic retry 3 of 3 at 2026-10-04T10:21:00.000Z");
    clock += 15 * 60_000;
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    expect(h.pushes()).toBe(4);
    expect(h.current().state).toBe("needs_decision");
    const [line, ...evidence] = h.current().stateDetail!.split("\n");
    expect(line).toBe(`publishing the passed stage: ${cause}; retried 3 times. Nothing on this branch caused it: check that the hook can finish on this machine (time limit, memory, a stopped Viewer), then retry-stage.`);
    expect(evidence.join("\n")).toContain("pre-push: types");
    expect(h.current().runs[0]!.attempts[0]!).toMatchObject({ state: "passed", verdict: { status: "pass" } });
    clock += 60 * 60_000;
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    expect(h.pushes()).toBe(4);
    expect(h.current().publishedCommit).toBeNull();
    // retry-stage starts a new round: the push that survives lands the same head.
    fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "retry-stage" }, ports)).error).toBeUndefined();
    for (let n = 0; n < 3; n++) await tickPipelines([], ports);
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: head });
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toBeUndefined();
  } finally { h.cleanup(); }
});

test("a refused publication of a head that changed code parks at once and is never retried on its own", async () => {
  const h = fixture();
  try {
    trailingLane(h, 2, { "src/work.ts": "export const work = 1;\n" });
    const marker = path.join(h.root, "privacy-ran");
    fs.writeFileSync(h.hook, `#!/bin/sh\necho 'pre-push: privacy' >&2\ntouch '${marker}'\necho 'pre-push: touched tests' >&2\necho '(fail) the stage broke this [2.00ms]' >&2\nexit 1\n`, { mode: 0o700 });
    let clock = Date.parse("2026-10-04T10:00:00.000Z");
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: () => {} };
    const tick = async () => { for (let n = 0; n < 3; n++) await tickPipelines([], ports); };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    await tick();
    expect(fs.existsSync(marker)).toBe(true);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail!.split("\n")[0]).toBe("publishing the passed stage: the repository's pre-push hook failed in its \"touched tests\" phase (exit 1, 1 failing test, first: the stage broke this). Fix it on this branch or on the base branch, then retry-stage.");
    expect(h.current().delivery!.operation!.result).toMatchObject({ failure: { changedFiles: 1 } });
    clock += 60 * 60_000; await tick();
    expect(h.pushes()).toBe(1);
    expect(h.current().publishedCommit).toBeNull();
  } finally { h.cleanup(); }
});

test("a hook that stopped at the deadline it was handed is retried as an interrupted push, even when the stage changed code", async () => {
  const h = fixture();
  try {
    trailingLane(h, 2, { "src/work.ts": "export const work = 1;\n" });
    const { NoVerdict } = await import("../../../scripts/local-gate");
    // The hook's own line, as scripts/local-gate.ts writes it.
    const line = `pre-push: ${new NoVerdict({ name: "touched tests", command: [] }, { at: 840_000, startedAt: 0 }, { ranMs: 830_000 }).message}`;
    const handed = path.join(h.root, "deadline");
    fs.writeFileSync(h.hook, `#!/bin/sh\necho "$LLV_GATE_PUSH_DEADLINE" > '${handed}'\necho 'pre-push: privacy' >&2\necho 'pre-push: touched tests' >&2\necho '${line}' >&2\nexit 75\n`, { mode: 0o700 });
    let clock = Date.parse("2026-10-04T10:00:00.000Z");
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: () => {} };
    const before = Date.now();
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    // Fourteen minutes: the fifteen-minute push limit less one for the pack.
    const deadline = Number(fs.readFileSync(handed, "utf8"));
    expect(deadline).toBeGreaterThanOrEqual(before + 14 * 60_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 14 * 60_000);
    expect(h.pushes()).toBe(1);
    expect(h.current().state).toBe("running");
    expect(h.current().stateDetail).toBe("passed but unpublished: a check reached its execution deadline without a verdict; automatic capacity retry 1 at 2026-10-04T10:01:00.000Z");
    expect(h.current().delivery!.operation!.result).toMatchObject({ ok: false, outcome: "not-landed", failure: { retryableDeadline: true, hookBudgetMs: 840_000, hookStoppedCheck: "touched tests", changedFiles: 1 } });
    for (const wait of [60_000, 5 * 60_000, 15 * 60_000]) { clock += wait; for (let n = 0; n < 8; n++) await tickPipelines([], ports); }
    expect(h.pushes()).toBe(4);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail).toContain("after 3 automatic retries");
    fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    expect(h.current().state).toBe("completed");
  } finally { h.cleanup(); }
});

test("a hook stopped at its deadline stays an interrupted push when the Viewer stopped before settling it", async () => {
  const h = fixture();
  const { reconcilePipelinePublication } = await import("./git");
  try {
    trailingLane(h, 2, { "src/work.ts": "export const work = 1;\n" });
    const { NoVerdict } = await import("../../../scripts/local-gate");
    const line = `pre-push: ${new NoVerdict({ name: "touched tests", command: [] }, { at: 840_000, startedAt: 0 }, { ranMs: 830_000 }).message}`;
    fs.writeFileSync(h.hook, `#!/bin/sh\necho 'pre-push: touched tests' >&2\necho '${line}' >&2\nexit 75\n`, { mode: 0o700 });
    const clock = Date.parse("2026-10-04T10:00:00.000Z");
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: () => {} };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    // The executor retained its result; settlement never ran.
    const interrupted = h.current();
    const operation = interrupted.delivery!.operation!;
    expect(operation.executor!.result).toMatchObject({ ok: false, outcome: "not-landed" });
    operation.state = "running"; delete operation.result;
    interrupted.stateDetail = "publication accepted; remote verification pending";
    savePipelines([interrupted]);
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    expect(h.current().delivery!.operation!.result).toMatchObject({ ok: false, outcome: "not-landed", failure: { hookBudgetMs: 840_000, hookStoppedCheck: "touched tests", changedFiles: 1 } });
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    expect(h.pushes()).toBe(1);
    expect(h.current().state).toBe("running");
    expect(h.current().stateDetail).toContain("automatic capacity retry 1");
  } finally { h.cleanup(); }
});

test("a privacy refusal of an unchanged head is never retried or bypassed: the pushed commits stay unpublished", async () => {
  const h = fixture();
  try {
    trailingLane(h, 2);
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\necho 'privacy-publication: commit identity is not allowed' >&2\necho 'pre-push: bun failed (1); gate failed' >&2\nexit 1\n", { mode: 0o700 });
    let clock = Date.parse("2026-10-04T10:00:00.000Z");
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: () => {} };
    const tick = async () => { for (let n = 0; n < 3; n++) await tickPipelines([], ports); };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    await tick();
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail!.split("\n")[0]).toBe("publishing the passed stage: the repository's pre-push hook failed in its \"privacy\" phase (exit 1). The commits this push carries were refused: correct their author, message or content on this branch, then retry-stage.");
    clock += 60 * 60_000; await tick();
    expect(h.pushes()).toBe(1);
    expect(h.current().publishedCommit).toBeNull();
    expect(spawnSync("git", ["--git-dir", h.remote, "rev-parse", "--verify", "-q", `refs/heads/${h.lane.branch}`], { encoding: "utf8" }).status).not.toBe(0);
  } finally { h.cleanup(); }
});

test("the publication hook environment drops the Viewer's settings and keeps the hook's own inputs", async () => {
  const { pipelinePublicationHookEnv } = await import("./git");
  const env = pipelinePublicationHookEnv({ NODE_ENV: "production", PATH: "/usr/bin", HOME: "/sandbox/home", LANG: "en_US.UTF-8",
    LLV_LANG: "uk", LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: "/checkout", LLV_TOKEN: "t", LLV_STATE_OWNER: "viewer",
    LLV_SKIP_HOOKS: "1", DELEGATUS_DEBUG: "1", NEXT_RUNTIME: "nodejs", LLV_GATE_SLOTS: "2", LLV_PRIVACY_OCR_LANGUAGES: "eng",
    LLV_PUBLICATION_NAME: "Agent", NEXT_TELEMETRY_DISABLED: "1",
    // The operator's CPU placement choices reach the hook's gates.
    DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_CPU_PRESSURE_HOLD: "30", DELEGATUS_WORK_CPU_QUOTA: "900", DELEGATUS_WORK_SCOPE_CPU_QUOTA: "200" });
  // Every key present is an explicit removal; a kept variable is inherited untouched.
  expect(Object.values(env).every((value) => value === undefined)).toBe(true);
  expect(Object.keys(env).sort()).toEqual(["DELEGATUS_DEBUG", "LLV_LANG", "LLV_LAUNCHER_CHECKOUT", "LLV_LAUNCHER_REEXEC", "LLV_SKIP_HOOKS", "LLV_STATE_OWNER", "LLV_TOKEN", "NEXT_RUNTIME", "NODE_ENV"]);
});

test("a publisher that died with its Viewer retries at once, and that retry is counted against the same bound", async () => {
  const h = fixture();
  try {
    const head = trailingLane(h, 2);
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: types' >&2\nkill -9 $PPID\nsleep 0.2\n", { mode: 0o700 });
    // What reconciliation leaves when the executor retained nothing.
    h.lane.delivery!.operation = { id: "died-with-its-viewer", epoch: 1, sha: head, state: "settled", passedStage: true,
      requestKey: `pass:build:${h.lane.runs[0]!.attempts[0]!.n}`,
      result: { ok: false, error: "interrupted publication did not leave its accepted head on the remote", outcome: "not-landed" } };
    savePipelines([h.lane]);
    const clock = Date.parse("2026-10-04T10:00:00.000Z");
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: () => {} };
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    expect(h.pushes()).toBe(1);
    expect(h.current().state).toBe("running");
    expect(h.current().stateDetail).toContain("automatic retry 2 of 3 at 2026-10-04T10:05:00.000Z");
  } finally { h.cleanup(); }
});

test("an interrupted push is named by what ended it and the phase the hook had reached", async () => {
  const { publicationInterruptionCause } = await import("./git");
  const failure = { step: "publishing the pipeline branch", code: null, signal: "SIGKILL" as const, durationMs: 900_004, outputTail: "pre-push: privacy\npre-push: Linux tests" };
  expect(publicationInterruptionCause({ ...failure, timedOutMs: 900_000 })).toBe("the push ran past its 15-minute limit in the hook's \"Linux tests\" phase and did not reach the remote");
  expect(publicationInterruptionCause({ ...failure, outputTail: "" })).toBe("the push was ended by SIGKILL and did not reach the remote");
  // The Viewer died with its push: nothing was retained.
  expect(publicationInterruptionCause()).toBe("the push was interrupted and did not reach the remote");
  expect(publicationInterruptionCause({ ...failure, code: 1, signal: null, hookBudgetMs: 840_000 })).toBe("the pre-push hook's 14-minute budget ran out while its \"Linux tests\" phase was still running; it stopped without a verdict and the push did not reach the remote");
});

function missingDependencyFixture(h: ReturnType<typeof fixture>): string {
  h.lane.stages[0]!.role = { roleId: "verifier" };
  h.lane.stages[0]!.effectiveRole = { ...h.lane.stages[0]!.effectiveRole!, roleId: "verifier", access: "read-only" };
  h.lane.runs[0]!.attempts[0]!.effectiveRole = h.lane.stages[0]!.effectiveRole!;
  fs.mkdirSync(path.join(h.repo, "dependency"));
  fs.writeFileSync(path.join(h.repo, "dependency/package.json"), JSON.stringify({ name: "publication-fixture-dependency", version: "1.0.0" }));
  fs.writeFileSync(path.join(h.repo, "package.json"), JSON.stringify({ name: "publication-fixture", dependencies: { "publication-fixture-dependency": "file:./dependency" } }));
  fs.writeFileSync(path.join(h.repo, ".gitignore"), "node_modules/\n");
  const lock = spawnSync(process.execPath, ["install", "--lockfile-only", "--ignore-scripts"], { cwd: h.repo, encoding: "utf8" });
  expect(lock.status).toBe(0);
  fs.rmSync(path.join(h.repo, "node_modules"), { recursive: true, force: true });
  h.git("add", "."); h.git("commit", "-q", "-m", "read-only publication fixture");
  // This fixture's dependency inputs are part of its passed stage.
  h.lane.lastPassedCommit = h.git("rev-parse", "HEAD");
  h.lane.state = "running"; h.lane.stateDetail = null;
  return h.lane.lastPassedCommit;
}

test("a passed read-only stage with no node_modules publishes and advances", async () => {
  const h = fixture();
  try {
    const head = missingDependencyFixture(h);
    const gateRan = path.join(h.root, "publication-gate-ran");
    fs.writeFileSync(h.hook, `#!/bin/sh\nset -eu\ntest -d node_modules/publication-fixture-dependency\ntouch '${gateRan}'\n`, { mode: 0o700 });
    savePipelines([h.lane]);

    expect(fs.existsSync(path.join(h.repo, "node_modules"))).toBe(false);
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: head }, h.ports)).error).toBeUndefined();
    await h.tick();

    expect(fs.existsSync(gateRan)).toBe(true);
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: head });
    expect(h.pushes()).toBe(1);
  } finally { h.cleanup(); }
});

for (const [privacyFails, partial] of [[false, false], [true, false], [false, true]]) test(`read-only publication provisions missing dependencies and preserves the privacy hook (privacy failure: ${privacyFails}, partial installation: ${partial})`, async () => {
  const h = fixture();
  try {
    const head = missingDependencyFixture(h);
    if (partial) fs.mkdirSync(path.join(h.repo, "node_modules"));
    const source = path.join(h.root, "source");
    for (let n = 0; n < 2; n++) h.git("-C", source, "commit", "--allow-empty", "-q", "-m", `later main ${n}`);
    h.git("-C", source, "push", "-q", "origin", "main"); h.git("fetch", "-q", "origin", "main");
    expect(h.git("rev-list", "--count", "HEAD..origin/main")).toBe("2");
    const marker = path.join(h.root, "privacy-ran");
    fs.writeFileSync(h.hook, `#!/bin/sh\nset -eu\nbehind=$(git rev-list --count HEAD..origin/main)\necho "pre-push: branch is $behind commit(s) behind origin/main" >&2\necho pre-push: privacy >&2\ntouch '${marker}'\n${privacyFails ? "exit 9" : "test -d node_modules/publication-fixture-dependency\necho pre-push: types >&2"}\n`, { mode: 0o700 });
    savePipelines([h.lane]);
    expect(fs.existsSync(path.join(h.repo, "node_modules/publication-fixture-dependency"))).toBe(false);
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: head }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(path.join(h.repo, "node_modules/publication-fixture-dependency"))).toBe(true);
    expect(h.git("status", "--porcelain")).toBe("");
    if (privacyFails) {
      expect(h.current().publishedCommit).toBeNull();
      expect(h.current().stateDetail).toContain("pre-push: privacy");
      expect(h.current().stateDetail).toContain("exit 1");
    } else {
      expect(h.current()).toMatchObject({ state: "completed", publishedCommit: head });
      expect(h.pushes()).toBe(1);
    }
  } finally { h.cleanup(); }
});

test("a slow owned publisher keeps its progress evidence fresh while the hook runs", async () => {
  const h = fixture();
  try {
    const { pipelinePublicationInFlight } = await import("./git");
    let progressWasFresh = false;
    const ports = { ...h.ports, exec: async (...args: Parameters<typeof realExec>) => {
      if (args[0] === "git" && args[1][0] === "push") {
        const stale = new Date(Date.now() - 120_000);
        const lock = h.current().delivery!.operation!.executor!.lock;
        fs.utimesSync(lock, stale, stale);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        progressWasFresh = pipelinePublicationInFlight(h.current()).ok;
      }
      return h.ports.exec(...args);
    } };
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, ports)).error).toBeUndefined();
    for (let n = 0; n < 3; n++) await tickPipelines([], ports);
    expect(progressWasFresh).toBe(true);
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: h.head });
  } finally { h.cleanup(); }
});

for (const dirty of [false, true]) test(`publication refuses unsuccessful dependency preparation (changed tracked work: ${dirty})`, async () => {
  const h = fixture();
  try {
    const head = missingDependencyFixture(h); savePipelines([h.lane]);
    const ports = { ...h.ports, exec: async (...args: Parameters<typeof realExec>) => {
      if (args[0] === "bun" && args[1][0] === "install") {
        if (dirty) fs.writeFileSync(path.join(h.repo, "stage.txt"), "changed by install script\n");
        return { code: dirty ? 0 : 7, stdout: "dependency preparation failed", stderr: "" };
      }
      return h.ports.exec(...args);
    } };
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: head }, ports)).error).toBeUndefined();
    for (let n = 0; n < 3; n++) await tickPipelines([], ports);
    expect(h.pushes()).toBe(0);
    expect(h.current().publishedCommit).toBeNull();
    expect(h.current().stateDetail).toContain(dirty ? "uncommitted" : "preparing publication dependencies: exit 7");
    if (!dirty) expect(h.current().delivery!.operation!.result).toMatchObject({ failure: {
      code: 7, signal: null, durationMs: expect.any(Number), outputTail: "dependency preparation failed",
    } });
  } finally { h.cleanup(); }
});

for (const action of ["publish", "retry-stage"] as const) test(`next explicit ${action} retains a settled deadline failure before retry`, async () => {
  const h = fixture();
  try {
    h.ports.now = () => "2026-10-16T10:00:00.000Z";
    h.lane.lastPassedCommit = h.head;
    h.lane.delivery!.operation = { id: "failed", state: "settled", epoch: 1, sha: h.head,
      result: { ok: false, error: "hook deadline", failure: { step: "publishing the pipeline branch", code: 124, signal: null,
        durationMs: 60_000, outputTail: "owned runner: deadline expired", retryableDeadline: true } } };
    h.lane.stateDetail = "hook failed"; savePipelines([h.lane]);
    expect((await patchPipeline(h.lane.id, { action }, h.ports)).error).toBeUndefined(); await h.tick();
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: h.head, delivery: { epoch: 1, ownerId: h.lane.id } });
    expect(h.pushes()).toBe(1);
    expect(h.current().publicationRecovery?.[h.head]).toMatchObject({ failures: 1, totalAttempts: 1,
      history: [{ operationId: "failed", cause: "infrastructure-deadline", retryAt: "2026-10-16T10:01:00.000Z" }] });
  } finally { h.cleanup(); }
});

for (const action of ["publish", "retry-stage"] as const) for (const legacy of [false, true]) test(`terminal review ${action} retries a hook failure while preserving the passed review (legacy attempt: ${legacy})`, async () => {
  const h = fixture();
  const { reconcilePipelinePublication } = await import("./git");
  try {
    terminalReview(h);
    const ports = { ...h.ports, remoteActionSupported: () => false };
    fs.writeFileSync(h.hook, "#!/bin/sh\necho pre-push: types >&2\nexit 7\n", { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current().state).toBe("needs_decision"); expect(h.current().stateDetail).toContain("exit 1");
    expect(h.current().delivery!.operation).toMatchObject({ state: "settled", passedStage: true, result: { ok: false } });
    // A child outcome survived but settlement did not. Real reconciliation
    // writes it directly, without the controller's old display prefix.
    const reconciled = h.current();
    const operation = reconciled.delivery!.operation!;
    operation.state = "running"; delete operation.result;
    if (legacy) reconciled.runs[1]!.attempts[0]!.state = "needs_decision";
    savePipelines([reconciled]);
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    expect(h.current().stateDetail).toStartWith("publishing the pipeline branch: exit 1");
    fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action }, ports)).error).toBeUndefined();
    expect(h.current().remoteAction).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: h.head, publishedCommit: h.head, delivery: { epoch: 1, ownerId: h.lane.id } });
    expect(h.current().runs[1]!.attempts).toHaveLength(1);
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ flowId: null, reviewedHead: h.passed, verdict: { status: "pass" } });
    expect(h.pushes()).toBe(2);
  } finally { h.cleanup(); }
});

test("skip-stage refuses admission when the serving controller has no remoteAction handler", async () => {
  const h = fixture();
  try {
    restore();
    fs.writeFileSync(path.join(state, "flow-pipeline-controller-heartbeat.json"), JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString() }));
    // MCP has no in-process controller; the serving Viewer's heartbeat is legacy.
    const result = await patchPipeline(h.lane.id, { action: "skip-stage" }, h.ports);
    expect(result.error).toContain("serving controller"); expect(result.status).toBe(409);
    expect(h.current().remoteAction).toBeUndefined();
  } finally { restore = registerPipelineTick(async () => {}); h.cleanup(); }
});

async function legacyPublication(h: ReturnType<typeof fixture>) {
  const { pipelineArtifactsDir } = await import("./store");
  terminalReview(h);
  h.git("reset", "--hard", h.passed);
  h.lane.runs[1]!.attempts[0]!.state = "needs_decision";
  h.lane.stateDetail = "publishing the passed stage: publishing the pipeline branch: no output";
  const lock = path.join(pipelineArtifactsDir(h.lane.id), "publication.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, "");
  const stat = fs.statSync(lock);
  h.lane.delivery!.operation = { id: "legacy-publication", epoch: 1, sha: h.passed, state: "running",
    executor: { pid: process.pid, identity: "legacy-executor", lock, lockIdentity: `${stat.dev}:${stat.ino}`, finished: true } };
  savePipelines([h.lane]);
}

async function restartedPublicationController(clock = "2026-10-19T10:00:00.000Z", bounded = false, crashLog?: string) {
  const script = `const { realExec } = await import(${JSON.stringify(path.join(import.meta.dir, "../workflows/provision.ts"))});
    const { defaultPipelinePorts, tickPipelines } = await import(${JSON.stringify(path.join(import.meta.dir, "engine.ts"))});
    const { registerPipelineTick } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerSignal.ts"))});
    registerPipelineTick(async () => {});
    const fs = await import("node:fs");
    const crashLog = ${JSON.stringify(crashLog ?? null)};
    const fixtureExec = ${publicationFixtureExec.toString()};
    const ports = { ...defaultPipelinePorts(), exec: async (...args) => {
      if (crashLog && args[0] === "git" && args[1][0] === "push") {
        fs.appendFileSync(crashLog, JSON.stringify(args[1]) + "\\n");
        process.exit(0);
      }
      return fixtureExec(...args);
    }, now: () => ${JSON.stringify(clock)}, scheduleTick: () => {},
      conversationAgentActive: async () => false, stageHostResident: async () => false,
      paneAgentAlive: async () => false, getFlow: () => null, worktreePresent: () => true };
    const { tickPipelinesController } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerPass.ts"))});
    const { settlePipelineControllerJobs } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerJobs.ts"))});
    for (let n = 0; n < 8; n++) {
      if (${bounded}) { await tickPipelinesController([], ports); await settlePipelineControllerJobs(); }
      else await tickPipelines([], ports);
    }`;
  const result = await realExec(process.execPath, ["-e", script], process.cwd(), process.env, { timeoutMs: 30_000 });
  expect(result.code, result.stderr).toBe(0);
}

async function leaveDeadPublication(h: ReturnType<typeof fixture>) {
  h.git("reset", "--hard", h.passed);
  h.lane.state = "running"; h.lane.stateDetail = null;
  h.lane.delivery!.operation = { id: "accepted-publication", epoch: 1, sha: h.passed,
    state: "pending", passedStage: true, requestKey: "pass:build:1" };
  savePipelines([h.lane]);
  const script = `const { publishPipelineBranch } = await import(${JSON.stringify(path.join(import.meta.dir, "git.ts"))});
    const { findPipelineRecord, withDeliveryMutationAsync } = await import(${JSON.stringify(path.join(import.meta.dir, "store.ts"))});
    const { realExec } = await import(${JSON.stringify(path.join(import.meta.dir, "../workflows/provision.ts"))});
    const id = ${JSON.stringify(h.lane.id)};
    await publishPipelineBranch(findPipelineRecord(id), async (...args) => {
      if (args[0] === "git" && args[1][0] === "push") {
        await withDeliveryMutationAsync(tx => {
          const lane = tx.get(id);
          lane.state = "needs_decision";
          lane.stateDetail = "publishing the passed stage: publication " + lane.delivery.operation.id + " has no progress for 187s";
          tx.put(lane);
        });
        process.exit(0);
      }
      return realExec(...args);
    }, { acceptedSha: ${JSON.stringify(h.passed)} });`;
  const died = await realExec(process.execPath, ["-e", script], process.cwd(), process.env, { timeoutMs: 30_000 });
  expect(died.code, died.stderr).toBe(0);
  const interrupted = h.current().delivery!.operation!;
  expect(interrupted.state).toBe("running");
  expect(interrupted.executor!.pid).not.toBe(process.pid);
  expect(interrupted.executor!.identity).toBeTruthy();
  expect(fs.existsSync(interrupted.executor!.lock)).toBe(true);
}

test.each([false, true])("startup retries a parked publication left by a dead Viewer generation (bounded controller: %s)", async bounded => {
  const h = fixture();
  try {
    await leaveDeadPublication(h);
    await restartedPublicationController(undefined, bounded);
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: h.passed, publishedCommit: h.passed });
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.git("ls-remote", "origin", `refs/heads/${h.lane.branch}`).split(/\s/)[0]).toBe(h.passed);
  } finally { h.cleanup(); }
}, 90_000);

test("bounded startup returns during publication recovery and labels its remote wait", async () => {
  const h = fixture();
  const { tickPipelinesController } = await import("./controllerPass");
  const { settlePipelineControllerJobs, pipelineControllerJobLanes } = await import("./controllerJobs");
  const { viewerLoopMonitor } = await import("@/lib/viewerLoopMonitor");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let reads = 0, label: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await leaveDeadPublication(h);
    const ports = { ...h.ports, now: () => "2026-10-19T10:00:00.000Z", scheduleTick: () => {},
      exec: async (...args: Parameters<typeof realExec>) => {
        if (args[0] === "timeout" && args[1].includes("ls-remote")) {
          reads++;
          label = viewerLoopMonitor.current();
          enter();
          await released;
        }
        return h.ports.exec(...args);
      } };
    // The phase completes before the remote observation is allowed to finish.
    await Promise.race([
      Promise.all([tickPipelinesController([], ports), entered]),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("publication recovery did not reach its remote wait")), 10_000); }),
    ]);
    clearTimeout(deadline);
    expect(label).toBe("pipelines.publication-recovery");
    expect(pipelineControllerJobLanes()).toEqual([h.lane.id]);
    await tickPipelinesController([], ports);
    expect(reads).toBe(1);
    expect(h.current().delivery!.operation!.state).toBe("running");
  } finally {
    clearTimeout(deadline);
    release();
    await settlePipelineControllerJobs();
    h.cleanup();
  }
});

test("takeover reconciles the departed publisher generation before changing its epoch", async () => {
  const h = fixture();
  try {
    await leaveDeadPublication(h);
    const { reconcilePipelinePublication } = await import("./git");
    const { takeoverPipelineDelivery } = await import("./store");
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    const taken = await takeoverPipelineDelivery(h.lane.id, h.lane.id, 1, "Recover departed publisher", null);
    expect(taken.error).toBeUndefined();
    expect(taken.pipeline!.delivery!.epoch).toBe(2);
  } finally { h.cleanup(); }
});

test("a matching live publisher generation is never duplicated by startup recovery", async () => {
  const h = fixture();
  const { acquirePublicationFileLock, releasePublicationFileLock, reconcilePipelinePublication } = await import("./git");
  let descriptor: number | null = null;
  try {
    await legacyPublication(h);
    const { procBackend } = await import("@/lib/proc");
    const current = h.current();
    const executor = current.delivery!.operation!.executor!;
    descriptor = await acquirePublicationFileLock(executor.lock);
    expect(descriptor).not.toBeNull();
    executor.identity = procBackend.processIdentity(process.pid);
    delete executor.finished;
    savePipelines([current]);
    let remoteReads = 0;
    expect(await reconcilePipelinePublication(h.lane.id, 1, async (...args) => {
      remoteReads++; return realExec(...args);
    }, null)).toContain("still in flight");
    expect(remoteReads).toBe(0);
    expect(h.current().delivery!.operation!.state).toBe("running");
    await restartedPublicationController();
    expect(h.current().delivery!.operation!.state).toBe("running");
    expect(h.current().publishedCommit).toBeNull();
    releasePublicationFileLock(descriptor!); descriptor = null;
    // The Viewer can survive a failed finished-marker write. Once its
    // publisher has released the fence, that generation no longer blocks.
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    expect(h.current().delivery!.operation!.state).toBe("settled");
  } finally { if (descriptor !== null) releasePublicationFileLock(descriptor); h.cleanup(); }
});

test("departed publication retries exhaust their durable budget across controller restarts", async () => {
  const h = fixture();
  try {
    await leaveDeadPublication(h);
    const pushes = path.join(h.root, "interrupted-pushes");
    let clock = Date.parse("2026-10-19T10:00:00.000Z");
    const restart = () => restartedPublicationController(new Date(clock).toISOString(), false, pushes);
    // Each retry loses its actual controller process at the push boundary.
    // A second fresh controller reconciles that death and persists the wait.
    await restart();
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toMatchObject({ failures: 1 });
    await restart();
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toMatchObject({ failures: 2 });
    for (const wait of [5 * 60_000, 15 * 60_000]) {
      clock += wait;
      await restart();
      await restart();
    }
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail!.split("\n")[0]).toContain("retried 3 times");
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toMatchObject({ sha: h.passed, failures: 3, exhausted: true });
    const recorded = () => fs.readFileSync(pushes, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(recorded()).toHaveLength(3);
    for (const argv of recorded()) expect(argv).toContain(`${h.passed}:refs/heads/${h.lane.branch}`);
    clock += 60 * 60_000;
    await restart();
    expect(h.current().state).toBe("needs_decision");
    expect(recorded()).toHaveLength(3);
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
  } finally { h.cleanup(); }
}, 90_000);

test.each(["paused", "needs_decision"] as const)("startup preserves a newer %s decision over an interrupted publication", async state => {
  const h = fixture();
  try {
    await leaveDeadPublication(h);
    const current = h.current();
    current.state = state;
    current.stateDetail = "a newer operator decision";
    savePipelines([current]);
    await restartedPublicationController();
    expect(h.current().state).toBe(state);
    expect(h.current().stateDetail).toBe("a newer operator decision");
    expect(h.current().publishedCommit).toBeNull();
  } finally { h.cleanup(); }
});

for (const action of ["publish", "retry-stage"] as const) for (const alreadyRemote of [false, true]) test(`marker-less legacy reconciliation preserves the original passed review for ${action} (already remote: ${alreadyRemote})`, async () => {
  const h = fixture();
  const { reconcilePipelinePublication } = await import("./git");
  try {
    await legacyPublication(h);
    if (alreadyRemote) h.git("push", "-q", "origin", `${h.passed}:refs/heads/${h.lane.branch}`);
    const ports = { ...h.ports, remoteActionSupported: () => false };
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    expect(h.current().delivery!.operation).toMatchObject({ state: "settled", passedStage: true, sha: h.passed, epoch: 1 });
    expect(h.current().runs[1]!.attempts[0]!.state).toBe("passed");
    expect((await patchPipeline(h.lane.id, { action }, ports)).error).toBeUndefined();
    expect(h.current().remoteAction).toBeUndefined();
    for (let n = 0; n < 3; n++) await tickPipelines([], ports);
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: h.passed, publishedCommit: h.passed,
      delivery: { epoch: 1, ownerId: h.lane.id } });
    expect(h.current().runs[1]!.attempts).toHaveLength(1);
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ n: 1, flowId: null, reviewedHead: h.passed, verdict: { status: "pass" } });
    expect(h.pushes()).toBe(alreadyRemote ? 0 : 1);
  } finally { h.cleanup(); }
});

for (const condition of ["unrelated detail", "no pass", "different passed SHA", "foreign owner", "comparison"] as const) test(`legacy reconciliation refuses passed-stage promotion with ${condition}`, async () => {
  const h = fixture();
  const { reconcilePipelinePublication } = await import("./git");
  try {
    await legacyPublication(h);
    if (condition === "unrelated detail") h.lane.stateDetail = "a different operator decision";
    if (condition === "no pass") h.lane.runs[1]!.attempts[0]!.verdict = null;
    if (condition === "different passed SHA") h.lane.lastPassedCommit = h.head;
    if (condition === "foreign owner") { h.lane.delivery!.ownerId = "another-owner"; h.lane.delivery!.active = false; }
    if (condition === "comparison") { h.lane.delivery!.disposition = "comparison"; h.lane.delivery!.publish = "disabled"; h.lane.delivery!.active = false; }
    savePipelines([h.lane]);
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    expect(h.current().delivery!.operation!.passedStage).toBeUndefined();
    expect(h.current().runs[1]!.attempts[0]!.state).toBe("needs_decision");
    expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});

for (const changed of ["id", "epoch", "sha", "executor"] as const) test(`reconciliation leaves a publication whose ${changed} changes during its remote read untouched`, async () => {
  const h = fixture();
  const { reconcilePipelinePublication } = await import("./git");
  try {
    await legacyPublication(h);
    const exec = async (...args: Parameters<typeof realExec>) => {
      const result = await realExec(...args);
      if (args[1].includes("ls-remote")) {
        const current = h.current();
        const operation = current.delivery!.operation!;
        if (changed === "id") operation.id = "replacement-operation";
        if (changed === "epoch") { operation.epoch = 2; current.delivery!.epoch = 2; }
        if (changed === "sha") operation.sha = h.head;
        if (changed === "executor") operation.executor!.identity = "replacement-generation";
        savePipelines([current]);
      }
      return result;
    };
    expect(await reconcilePipelinePublication(h.lane.id, 1, exec, null)).toContain("publication changed");
    expect(h.current().delivery!.operation!.state).toBe("running");
    expect(h.current().delivery!.operation!.passedStage).toBeUndefined();
    expect(h.current().runs[1]!.attempts[0]!.state).toBe("needs_decision");
  } finally { h.cleanup(); }
});

test("reconciliation retains a child outcome persisted during its remote read", async () => {
  const h = fixture();
  const { reconcilePipelinePublication } = await import("./git");
  try {
    await legacyPublication(h);
    const failure = { step: "publishing the pipeline branch", code: 7, signal: null,
      durationMs: 12, outputTail: "pre-push: types\npre-push: touched-tests failed" };
    const exec = async (...args: Parameters<typeof realExec>) => {
      const result = await realExec(...args);
      if (args[1].includes("ls-remote")) {
        const current = h.current();
        current.delivery!.operation!.executor!.result = { ok: false, error: "hook failed", failure };
        savePipelines([current]);
      }
      return result;
    };
    expect(await reconcilePipelinePublication(h.lane.id, 1, exec, null)).toBeNull();
    expect(h.current().delivery!.operation!.result).toMatchObject({ ok: false, failure });
    expect(h.current().stateDetail).toContain("exit 7");
    expect(h.current().stateDetail).toContain("pre-push: touched-tests failed");
    expect(h.current().stateDetail).not.toContain("interrupted publication");
  } finally { h.cleanup(); }
});

test.each(["dirty", "different SHA"])("moved-head admission refuses %s and keeps the pass", async (condition) => {
  const h = fixture();
  try {
    if (condition === "dirty") fs.writeFileSync(path.join(h.repo, "stage.txt"), "uncommitted\n");
    const result = await patchPipeline(h.lane.id, { action: "publish", acceptedSha: condition === "dirty" ? h.head : h.passed.slice(0, 39) + (h.passed.endsWith("a") ? "b" : "a") }, h.ports);
    expect(result.error).toContain(condition === "dirty" ? "uncommitted" : "HEAD");
    expect(h.current().lastPassedCommit).toBe(h.passed);
    expect(h.current().runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    expect(h.current().delivery!.operation).toBeUndefined();
  } finally { h.cleanup(); }
});

test("publisher evidence stays redacted and bounded through lock reacquisition and reconciliation", async () => {
  const h = fixture();
  const { publishPipelineBranch, reconcilePipelinePublication } = await import("./git");
  const { redactMonitorText } = await import("@/lib/monitor/redact");
  let holder: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  try {
    h.lane.lastPassedCommit = h.head; savePipelines([h.lane]);
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    // An owned child inherits the actual per-lane kernel fence and outlives
    // the failed push. Recovery must use the durable executor result.
    const failure = ["pre-push: types", "pre-push: eslint", "noise".repeat(1500), `path=${os.homedir()}/private/output`,
      `Authorization: Bearer ${"test".repeat(30)}`, "pre-push: touched-tests failed"].join("\n");
    const exec = async (...args: Parameters<typeof realExec>) => {
      if (args[0] === "git" && args[1][0] === "push") {
        holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: ["ignore", "ignore", "ignore", args[4]!.inheritFd!],
        });
        closed = new Promise<void>((resolve) => holder!.once("close", () => resolve()));
        await new Promise<void>((resolve, reject) => { holder!.once("spawn", resolve); holder!.once("error", reject); });
        return { code: 7, signal: null, stdout: "", stderr: failure };
      }
      return realExec(...args);
    };
    const result = await publishPipelineBranch(h.current(), exec, { acceptedSha: h.head });
    expect(result).toMatchObject({ remote: "unreachable", uncertain: true });
    const operation = h.current().delivery!.operation!;
    expect(operation.state).toBe("running");
    expect(operation.executor!.result).toMatchObject({ ok: false, failure: { code: 7 } });
    const retained = JSON.stringify(operation.executor!.result);
    expect(retained).not.toContain(os.homedir()); expect(retained).not.toContain("test".repeat(30));
    expect(operation.executor!.result!.failure!.outputTail.length).toBeLessThanOrEqual(4000);
    expect(operation.executor!.result!.failure!.outputTail).toContain("pre-push: types");
    expect(operation.executor!.result!.failure!.outputTail).toContain("pre-push: eslint");
    expect(operation.executor!.result!.failure!.outputTail.endsWith(redactMonitorText(failure).trim().slice(-500))).toBe(true);
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toContain("still in flight");
    expect(holder!.pid).toBeGreaterThan(0); holder!.kill("SIGTERM"); await closed;
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    expect(h.current().stateDetail).toContain("exit 7");
    expect(h.current().stateDetail).toContain("pre-push: touched-tests failed");
    expect(h.current().stateDetail).not.toContain("interrupted publication");
  } finally { if (holder?.exitCode === null && holder.signalCode === null) holder.kill("SIGTERM"); await closed; h.cleanup(); }
});

for (const held of [false, true]) for (const split of ["none", "forward", "reverse", "forward-complete", "reverse-complete", "crossed-complete"]) test(`private-key hook output is redacted before retention and reconciliation (held lock: ${held}, split streams: ${split})`, async () => {
  const h = fixture();
  const { publishPipelineBranch, reconcilePipelinePublication } = await import("./git");
  let holder: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  try {
    h.lane.lastPassedCommit = h.head; h.lane.state = "running"; h.lane.stateDetail = null; savePipelines([h.lane]);
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const truncated = pem.slice(0, pem.indexOf("-----END"));
    const keyBytes = truncated.split("\n").slice(1).join("").trim();
    const [header, ...body] = truncated.split("\n");
    const footer = pem.trim().split("\n").at(-1)!;
    // Opposite routing for two blocks puts the first key's body before the
    // second opener in stdout, while stderr contains the first armor block.
    const output = split === "crossed-complete" ? `echo pre-push: types >&2\necho pre-push: eslint >&2\necho '${header}' >&2\ncat <<'KEY'\n${body.join("\n")}KEY\necho '${footer}' >&2\necho '${header}'\ncat <<'KEY' >&2\n${body.join("\n")}KEY\necho '${footer}'\n`
      : split.startsWith("reverse") ? `echo pre-push: types >&2\necho pre-push: eslint >&2\necho '${header}' >&2\ncat <<'KEY'\n${body.join("\n")}KEY\n${split.endsWith("complete") ? `echo '${footer}' >&2\n` : ""}`
      : split.startsWith("forward") ? `echo pre-push: types\necho pre-push: eslint\necho '${header}'\ncat <<'KEY' >&2\n${body.join("\n")}KEY\n${split.endsWith("complete") ? `echo '${footer}'\n` : ""}`
        : `echo pre-push: types >&2\necho pre-push: eslint >&2\ncat <<'KEY' >&2\n${truncated}KEY\n`;
    fs.writeFileSync(h.hook, `#!/bin/sh\n${output}exit 7\n`, { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    const exec = async (...args: Parameters<typeof realExec>) => {
      if (held && args[0] === "git" && args[1][0] === "push") {
        holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", args[4]!.inheritFd!] });
        closed = new Promise<void>((resolve) => holder!.once("close", () => resolve()));
        await new Promise<void>((resolve, reject) => { holder!.once("spawn", resolve); holder!.once("error", reject); });
      }
      return realExec(...args);
    };
    const publication = await publishPipelineBranch(h.current(), exec, { acceptedSha: h.head });
    expect(JSON.stringify(publication).includes(keyBytes)).toBe(false);
    const before = h.current().delivery!.operation!;
    // Never print generated private material even when this regression is red.
    expect(JSON.stringify(before.executor!.result).includes(keyBytes)).toBe(false);
    if (held) {
      expect(before.state).toBe("running");
      const diagnostic = await reconcilePipelinePublication(h.lane.id, 1, realExec, null);
      expect(diagnostic?.includes(keyBytes) ?? false).toBe(false); expect(diagnostic).toContain("still in flight");
      holder!.kill("SIGTERM"); await closed;
    }
    const diagnostic = await reconcilePipelinePublication(h.lane.id, 1, realExec, null);
    expect(diagnostic?.includes(keyBytes) ?? false).toBe(false);
    const lane = h.current();
    expect(JSON.stringify(lane).includes(keyBytes)).toBe(false);
    expect(lane.delivery!.operation!.state).toBe("settled");
    expect(lane.delivery!.operation!.result).toMatchObject({ failure: { code: 1, signal: null, durationMs: expect.any(Number) } });
    expect(lane.stateDetail).toContain("exit 1");
    if (split === "crossed-complete") expect(lane.stateDetail).toContain("[redacted-private-key]");
    else { expect(lane.stateDetail).toContain("pre-push: types"); expect(lane.stateDetail).toContain("pre-push: eslint"); }
    expect(lane.stateDetail).not.toContain("interrupted publication");
  } finally { if (holder?.exitCode === null && holder.signalCode === null) holder.kill("SIGTERM"); await closed; h.cleanup(); }
});

test("failed remote reconciliation redacts credentials and home paths in its returned diagnostic", async () => {
  const h = fixture();
  const { publishPipelineBranch, reconcilePipelinePublication } = await import("./git");
  try {
    h.lane.lastPassedCommit = h.head; h.lane.state = "running"; h.lane.stateDetail = null; savePipelines([h.lane]);
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    await publishPipelineBranch(h.current(), async (...args: Parameters<typeof realExec>) => args[0] === "git" && args[1][0] === "push"
      ? { code: null, signal: "SIGTERM", stdout: "", stderr: "pre-push: types" } : realExec(...args), { acceptedSha: h.head });
    const credential = "ghp_" + "x".repeat(30);
    const diagnostic = await reconcilePipelinePublication(h.lane.id, 1, async (...args: Parameters<typeof realExec>) => args[1].includes("ls-remote")
      ? { code: 1, stdout: "", stderr: `remote read failed ${credential} ${os.homedir()}/private/config` } : realExec(...args), null);
    expect(diagnostic !== null).toBe(true);
    expect(diagnostic!.includes(credential)).toBe(false); expect(diagnostic!.includes(os.homedir())).toBe(false);
    expect(diagnostic).toContain("remote read failed"); expect(diagnostic!.length).toBeLessThanOrEqual(4500);
    expect(h.current().delivery!.operation!.state).toBe("running");
  } finally { h.cleanup(); }
});

test("publisher settlement exceptions retain a redacted bounded reconciliation diagnostic", async () => {
  const h = fixture();
  const { publishPipelineBranch } = await import("./git");
  const close = fs.closeSync;
  try {
    h.lane.lastPassedCommit = h.head; h.lane.state = "running"; h.lane.stateDetail = null; savePipelines([h.lane]);
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    const credential = "ghp_" + "x".repeat(30);
    const result = await publishPipelineBranch(h.current(), async (...args: Parameters<typeof realExec>) => {
      const executed = await realExec(...args);
      if (args[0] === "git" && args[1][0] === "push") {
        const descriptor = args[4]!.inheritFd!;
        fs.closeSync = (fd) => {
          if (fd !== descriptor) return close(fd);
          fs.closeSync = close;
          throw new Error(`settlement fixture ${credential} ${os.homedir()}/private/config ${"noise".repeat(1200)}`);
        };
      }
      return executed;
    }, { acceptedSha: h.head });
    expect(result.ok && result.remote === "unreachable").toBe(true);
    if (!result.ok || result.remote !== "unreachable") throw new Error("expected uncertain settlement");
    expect(result.detail.includes(credential)).toBe(false); expect(result.detail.includes(os.homedir())).toBe(false);
    expect(result.detail).toContain("settlement fixture"); expect(result.detail.length).toBeLessThanOrEqual(4500);
    expect(h.current().delivery!.operation!.state).toBe("running");
  } finally { fs.closeSync = close; h.cleanup(); }
});

test("MCP capability admission reads the living serving controller's advertised actions", async () => {
  const { servingControllerSupports } = await import("./controllerCapabilities");
  const { writeFlowPipelineControllerHeartbeat } = await import("./controller");
  const filename = path.join(state, "flow-pipeline-controller-heartbeat.json");
  restore();
  try {
    const heartbeat = { schemaVersion: 1 as const, controller: "flow-pipeline" as const, cycle: 1, pass: 1,
      trigger: "watchdog", phase: "idle" as const, state: "idle" as const,
      phaseStartedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ageMs: 0, deadlineMs: 15_000 };
    writeFlowPipelineControllerHeartbeat(heartbeat, filename);
    expect(servingControllerSupports("skip-stage")).toBe(true);
    expect(servingControllerSupports("takeover")).toBe(true);
    expect(servingControllerSupports("unknown-action")).toBe(false);
    const observed = JSON.parse(fs.readFileSync(filename, "utf8"));
    fs.writeFileSync(filename, JSON.stringify({ ...observed, processIdentity: "earlier-generation" }));
    expect(servingControllerSupports("skip-stage")).toBe(false);
    fs.writeFileSync(filename, JSON.stringify({ ...observed, updatedAt: new Date(Date.now() - 121_000).toISOString() }));
    expect(servingControllerSupports("skip-stage")).toBe(false);
    fs.writeFileSync(filename, JSON.stringify(heartbeat));
    expect(servingControllerSupports("skip-stage")).toBe(false);
  } finally { restore = registerPipelineTick(async () => {}); }
});

test("a signal-ended publisher keeps its signal and tail through remote reconciliation", async () => {
  const h = fixture();
  const { publishPipelineBranch, reconcilePipelinePublication } = await import("./git");
  try {
    h.lane.lastPassedCommit = h.head; h.lane.state = "running"; h.lane.stateDetail = null; savePipelines([h.lane]);
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    const result = await publishPipelineBranch(h.current(), async (...args: Parameters<typeof realExec>) =>
      args[0] === "git" && args[1][0] === "push"
        ? { code: null, signal: "SIGTERM", stdout: "", stderr: "pre-push: types\nchild terminated" }
        : realExec(...args), { acceptedSha: h.head });
    expect(result).toMatchObject({ remote: "unreachable", uncertain: true, failure: { code: null, signal: "SIGTERM" } });
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    expect(h.current().stateDetail).toContain("signal SIGTERM");
    expect(h.current().stateDetail).toContain("pre-push: types");
    expect(h.current().delivery!.operation!.result).toMatchObject({ outcome: "not-landed", failure: { code: null, signal: "SIGTERM" } });
  } finally { h.cleanup(); }
});
for (const failsAfterWait of [false, true]) test(`capacity retries survive a controller process restart and settle the next verdict (fails: ${failsAfterWait})`, async () => {
  const h = fixture();
  try {
    const head = trailingLane(h, 2, { "src/work.ts": "export const work = 1;\n" });
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: touched tests: failed (124)' >&2\necho 'owned runner: deadline expired' >&2\nexit 1\n", { mode: 0o700 });
    let clock = Date.parse("2026-10-16T10:00:00.000Z");
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: () => {} };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    expect(h.current().state).toBe("running");
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toMatchObject({ failures: 1, retryAt: "2026-10-16T10:01:00.000Z" });
    expect(h.current().publicationRecovery?.[head]).toMatchObject({ failures: 1, totalAttempts: 1,
      history: [{ cause: "infrastructure-deadline", retryAt: "2026-10-16T10:01:00.000Z" }] });
    const engine = path.join(import.meta.dir, "engine.ts");
    const restart = async () => {
      const script = `const { realExec } = await import(${JSON.stringify(path.join(import.meta.dir, "../workflows/provision.ts"))});
      const { defaultPipelinePorts, tickPipelines } = await import(${JSON.stringify(engine)});
        const { registerPipelineTick } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerSignal.ts"))});
        registerPipelineTick(async () => {});
        const ports = { ...defaultPipelinePorts(), exec: ${publicationFixtureExec.toString()},
          now: () => ${JSON.stringify(new Date(clock).toISOString())}, scheduleTick: () => {},
          conversationAgentActive: async () => false, stageHostResident: async () => false, paneAgentAlive: async () => false, getFlow: () => null, worktreePresent: () => true };
        for (let n = 0; n < 8; n++) await tickPipelines([], ports);`;
      const outcome = await realExec(process.execPath, ["-e", script], process.cwd(), { ...process.env, LLV_STATE_DIR: state }, { timeoutMs: 30_000 });
      expect(outcome.code, outcome.stderr).toBe(0);
    };
    // A new controller process sees the durable future retry and does no push.
    await restart();
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry!.failures).toBe(1);
    expect(h.current().publicationRecovery?.[head]!.history).toHaveLength(1);
    // A transient overload clears before the bounded retry budget is spent.
    clock += 60_000; await restart();
    fs.writeFileSync(h.hook, failsAfterWait
      ? "#!/bin/sh\necho 'pre-push: touched tests: failed (1)' >&2\necho '(fail) named publication assertion [2.00ms]' >&2\nexit 1\n"
      : "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    clock += 5 * 60_000; await restart();
    expect(h.current().state).toBe(failsAfterWait ? "needs_decision" : "completed");
    if (failsAfterWait) {
      expect(h.current().stateDetail!.split("\n")[0]).toContain("named publication assertion");
      expect(h.current().publishedCommit).toBeNull();
      expect(h.current().publicationRecovery?.[head]!.history.at(-1)).toMatchObject({ cause: "check-failure", retryAt: null,
        detail: expect.stringContaining("named publication assertion") });
    } else expect(h.current().publishedCommit).toBe(head);
  } finally { h.cleanup(); }
}, 90_000);

test("owned-runner cleanup refusal parks despite a deadline marker", async () => {
  const h = fixture();
  try {
    trailingLane(h, 2, { "src/work.ts": "export const work = 1;\n" });
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: touched tests: failed (1)' >&2\necho 'owned runner: execution guard expired' >&2\necho 'owned runner: budget cleanup failed: child tree could not be stopped' >&2\nexit 1\n", { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.pushes()).toBe(1);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().delivery!.operation!.result!.failure).toMatchObject({ retryableDeadline: false });
    expect(h.current().stateDetail!.split("\n")[0]).toContain("touched tests");
  } finally { h.cleanup(); }
});

test("permanent capacity deadlines stop after three retries across controller restarts", async () => {
  const h = fixture();
  try {
    trailingLane(h, 2, { "src/work.ts": "export const work = 1;\n" });
    const attempts = path.join(h.root, "push-attempts");
    fs.writeFileSync(h.hook, `#!/bin/sh\necho attempt >> '${attempts}'\necho 'pre-push: touched tests: failed (124)' >&2\necho 'owned runner: deadline expired' >&2\nexit 1\n`, { mode: 0o700 });
    let clock = Date.parse("2026-10-16T11:00:00.000Z");
    const ports = { ...h.ports, now: () => new Date(clock).toISOString(), scheduleTick: () => {} };
    expect((await patchPipeline(h.lane.id, { action: "publish" }, ports)).error).toBeUndefined();
    for (let n = 0; n < 8; n++) await tickPipelines([], ports);
    expect(h.pushes()).toBe(1);
    const engine = path.join(import.meta.dir, "engine.ts");
    const restart = async () => {
      const script = `import { defaultPipelinePorts, tickPipelines } from ${JSON.stringify(engine)};
        const { registerPipelineTick } = await import(${JSON.stringify(path.join(import.meta.dir, "controllerSignal.ts"))});
        registerPipelineTick(async () => {});
        const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(new Date(clock).toISOString())}, scheduleTick: () => {},
          conversationAgentActive: async () => false, stageHostResident: async () => false, paneAgentAlive: async () => false, getFlow: () => null, worktreePresent: () => true };
        for (let n = 0; n < 8; n++) await tickPipelines([], ports);`;
      const outcome = await realExec(process.execPath, ["-e", script], process.cwd(), { ...process.env, LLV_STATE_DIR: state }, { timeoutMs: 30_000 });
      expect(outcome.code, outcome.stderr).toBe(0);
    };
    await restart();
    for (const wait of [60_000, 5 * 60_000, 15 * 60_000]) { clock += wait; await restart(); }
    expect(fs.readFileSync(attempts, "utf8").trim().split("\n")).toHaveLength(4);
    expect(h.current().state).toBe("needs_decision");
    const head = h.current().lastPassedCommit;
    expect(h.current().publicationRecovery?.[head]).toMatchObject({ failures: 4, totalAttempts: 4 });
    expect(h.current().publicationRecovery?.[head]!.history.map(entry => entry.retryAt)).toEqual([
      "2026-10-16T11:01:00.000Z", "2026-10-16T11:06:00.000Z", "2026-10-16T11:21:00.000Z", null,
    ]);
    expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toMatchObject({ failures: 3, exhausted: true });
    expect(h.current().stateDetail!.split("\n")[0]).toContain("after 3 automatic retries");
    clock += 60 * 60_000;
    await restart();
    expect(fs.readFileSync(attempts, "utf8").trim().split("\n")).toHaveLength(4);
    expect(h.current().state).toBe("needs_decision");
    // An explicit request grants one push and retains the exhausted automatic bound.
    expect((await patchPipeline(h.lane.id, { action: "retry-stage" }, ports)).error).toBeUndefined();
    await restart();
    expect(fs.readFileSync(attempts, "utf8").trim().split("\n")).toHaveLength(5);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().publicationRecovery?.[head]).toMatchObject({ failures: 5, totalAttempts: 5 });
  } finally { h.cleanup(); }
}, 90_000);

test("a named touched assertion vetoes deadline recovery before log truncation", async () => {
  const h = fixture();
  try {
    trailingLane(h, 2, { "src/work.ts": "export const work = 1;\n" });
    fs.writeFileSync(h.hook, `#!/bin/sh\necho 'pre-push: touched tests: failed (1)' >&2\necho 'NEW src/work.test.ts: publication assertion' >&2\n${"echo diagnostic >&2\n".repeat(500)}echo 'owned runner: deadline expired' >&2\nexit 1\n`, { mode: 0o700 });
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail!.split("\n")[0]).toContain("first: src/work.test.ts: publication assertion");
    expect(h.current().delivery!.operation!.result!.failure).toMatchObject({ retryableDeadline: false });
    expect(h.current().delivery!.operation!.result!.failure!.outputTail.length).toBeLessThanOrEqual(4000);
  } finally { h.cleanup(); }
});

}
