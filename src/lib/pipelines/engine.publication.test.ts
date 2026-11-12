import { expect, test, spawn, fs, path, tickPipelines, createPipelineFromRequest, loadPipelines, savePipelines, patchPipeline, harness, create } from "./engine.fixture";
import { os, engineModule, finishReported, realExec, pipelineIdentity } from "./engine.fixture";
import { pipelinePublicationFence, pipelinePublicationHookEnv, publishPipelineBranch, realProvisionExec } from "./git";
import { buildPipeline, findPipelineRecord } from "./store";
import { resolvePipelineRole } from "./roles";
import { createPublicationFixtures } from "../../../scripts/publicationHook.fixture";
import { publicationCheckBinding, readPublicationCheckReceipt, type PublicationCheckReceipt } from "@/lib/git/publicationCheckReceipt";
import { lessonPublicationEnv } from "@/lib/memory/roleStore";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { publicationFailurePhase, recoverablePublication } from "./publicationHistory";
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

test("rejection lets the running publication settle before the controller parks its lane", async () => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority, NOW } = await import("@/lib/tasks/proactive.fixture");
  const { acquirePublicationFileLock, releasePublicationFileLock } = await import("./git");
  const { procBackend } = await import("@/lib/proc");
  const f = await repository();
  let descriptor: number | null = null;
  try {
    await f.addRemote();
    const lane = await f.start({ publication: "remote-branch" });
    const project = lane.project;
    const { task } = await admitProactiveTask({ ...candidate("controller-publication"), project }, { ...context(), project }, undefined, authority());
    const now = () => new Date(NOW).toISOString();
    await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task), undefined, now);
    lane.taskIds = [task.id];
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.state = "passed"; attempt.verdict = { status: "pass", findings: [] }; attempt.completedAt = f.h.ports.now();
    lane.cursor!.state = "committing";
    const lock = path.join(f.root, "active-publication.lock");
    descriptor = await acquirePublicationFileLock(lock);
    expect(descriptor).not.toBeNull();
    const stat = fs.statSync(lock);
    lane.delivery!.operation = { id: "active-rejected-publication", epoch: lane.delivery!.epoch, sha: f.base,
      state: "running", passedStage: true, executor: { pid: process.pid, identity: procBackend.processIdentity(process.pid),
        lock, lockIdentity: `${stat.dev}:${stat.ino}` } };
    fs.writeFileSync(path.join(lane.worktreeDir, "retained.txt"), "Retain the accepted work\n");
    savePipelines([lane]);
    const fence = pipelinePublicationFence(lane);
    const spawns = f.h.spawnInputs.length;
    await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(task), undefined, now);
    await f.tick(2);
    expect({ state: f.current().state, detail: f.current().stateDetail }).toMatchObject({ state: "running" });
    expect(pipelinePublicationFence(f.current())).toBe(fence);
    expect(f.current().delivery!.operation).toMatchObject({ state: "running", id: "active-rejected-publication" });
    expect(f.h.spawnInputs).toHaveLength(spawns);
    expect(f.pushes()).toBe(0);
    const settled = f.current();
    settled.delivery!.operation = { ...settled.delivery!.operation!, state: "settled", result: { ok: true, remote: "published", sha: f.base } };
    savePipelines([settled]);
    await f.tick(2);
    expect(f.current()).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("rejected") });
    expect(f.h.spawnInputs).toHaveLength(spawns);
    expect(f.pushes()).toBe(0);
    expect(fs.readFileSync(path.join(lane.worktreeDir, "retained.txt"), "utf8")).toBe("Retain the accepted work\n");
  } finally { if (descriptor !== null) releasePublicationFileLock(descriptor); f.cleanup(); }
});

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
    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", remote: refusal === "unknown" ? "missing" : "origin" }, f.h.ports))
      .toMatchObject(refusal === "review-flow" ? { status: 410, code: "STAGE_KIND_RETIRED" } : { status: 409 });
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

test.each([true, false])("a recursive publication pass restores caller branch protections, accepted=%s", async accepted => {
  const f = await repository();
  try {
    const remote = await f.addRemote(); const lane = await f.start();
    if (!accepted) fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const protections = new Map();
    f.h.ports.stageBranchProtections = protections;
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "publication work\n");
    await f.pass(1);
    expect(f.pushes()).toBeGreaterThan(0);
    expect(f.h.ports.stageBranchProtections).toBe(protections);
    expect(f.current().cursor?.stageId).toBe(accepted ? "review" : "build");
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

test("legacy review creation refuses even with a separate origin push URL", async () => {
  const f = await repository();
  try {
    await f.addRemote(); const pushRemote = await f.addRemote("push-target");
    await f.git(f.repo, "remote", "set-url", "--push", "origin", pushRemote);
    const result = await f.create({ autoStart: false, publication: "internal", stages: [
      { id: "plan", kind: "run", role: { roleId: "architect" }, prompt: "Plan", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null },
    ] });
    expect(result).toMatchObject({ status: 410, code: "STAGE_KIND_RETIRED" });
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
] as const)("retired legacy review refuses remote adoption via $label", async ({ remote, splitOrigin }) => {
  const f = await repository();
  try {
    const lane = await f.start({ publication: "internal" });
    lane.stages[1]!.kind = "review-loop";
    savePipelines([lane]);
    await f.addRemote();
    const other = await f.addRemote("other");
    if (splitOrigin) await f.git(f.repo, "remote", "set-url", "--push", "origin", other);
    else await f.git(f.repo, "remote", "add", "delivery", other);
    const before = structuredClone(f.current().delivery);

    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", ...(remote ? { remote } : {}) }, f.h.ports))
      .toMatchObject({ status: 410, code: "STAGE_KIND_RETIRED" });
    expect(f.current().delivery).toEqual(before);
    expect(f.current().delivery!.epoch).toBe(1);
  } finally { f.cleanup(); }
});

test("legacy review creation refuses before any stage or delivery is admitted", async () => {
  const f = await repository();
  try {
    expect(await f.create({ publication: "internal", stages: structuredClone(legacyReviewStages) as unknown as CreatePipelineRequest["stages"] }))
      .toMatchObject({ status: 410, code: "STAGE_KIND_RETIRED" });
    expect(loadPipelines()).toHaveLength(0);
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { f.cleanup(); }
});

const nativePublicationTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));

type PrivacyPublicationMode = "preparation" | "transport" | "padded-preparation" | "padded-transport" | "privacy" | "remote" | "success";

async function controllerPublicationFixture(roots: string[], cleanup: Array<() => void>, privacyMode?: PrivacyPublicationMode) {
  const fixtures = createPublicationFixtures(path.resolve(import.meta.dir, "../../.."), roots);
  const f = fixtures.nativeFixture();
  // Keep the fixture's Bun shim and use native Git in its isolated children.
  const shim = path.join(f.dir, "shims/bun");
  f.env.PATH = `${path.dirname(shim)}:/usr/bin:/bin:${f.env.PATH}`;
  expect(fs.readFileSync(Bun.which("git", { PATH: f.env.PATH })!).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const http = await fixtures.httpFixture(f, false);
  cleanup.push(() => http.close());
  if (privacyMode) {
    const root = path.resolve(import.meta.dir, "../../..");
    fs.copyFileSync(path.join(root, "scripts/privacy-known-value-fingerprints.json"), path.join(f.dir, "scripts/privacy-known-value-fingerprints.json"));
    // Run the real scanner, then pad its successful diagnostic and change a
    // checked input. The gate itself detects and refuses that drift.
    const scanner = `#!/bin/bash
if [[ "$1" == scripts/privacy-publication-gate.ts ]]; then
  shift
  if [[ "$PRIVACY_FIXTURE_MODE" == privacy ]]; then export LLV_PRIVACY_KNOWN_VALUES_FILE="$PWD/.git/fixture-known-values"; fi
  "$HOOK_BUN" "$PRIVACY_FIXTURE_SCANNER" "$@"
  scanner_status=$?
  if [[ "$scanner_status" == 0 && "$PRIVACY_FIXTURE_MODE" == padded-* ]]; then "$HOOK_BUN" -e 'process.stdout.write("benign diagnostic ".repeat(400) + "\\n")'; fi
  if [[ "$scanner_status" == 0 && ( ( "$PRIVACY_FIXTURE_MODE" == *preparation && -z "${"${LLV_GATE_PUBLICATION_OBSERVED:-}"}" ) || ( "$PRIVACY_FIXTURE_MODE" == *transport && -n "${"${LLV_GATE_PUBLICATION_OBSERVED:-}"}" ) ) ]]; then
    git config fixture.input changed
  fi
  exit "$scanner_status"
fi
`;
    fs.writeFileSync(shim, fs.readFileSync(shim, "utf8").replace("#!/bin/bash\n", scanner));
    Object.assign(f.env, { PRIVACY_FIXTURE_SCANNER: path.join(root, "scripts/privacy-publication-gate.ts"), PRIVACY_FIXTURE_MODE: privacyMode });
    fixtures.commitFixtureInputs(f);
    if (privacyMode === "privacy") fs.writeFileSync(path.join(f.dir, ".git/fixture-known-values"), "A retained publication fixture phrase.\n");
    if (privacyMode === "remote") {
      fs.mkdirSync(path.join(http.bare, "hooks"), { recursive: true });
      fs.writeFileSync(path.join(http.bare, "hooks/pre-receive"), "#!/bin/sh\necho 'fatal error in commit_refs_rules' >&2\nexit 1\n", { mode: 0o700 });
    }
  }
  // Keep the installed fixture tools on the base; this source change selects
  // standalone types, lint and the touched test in the real gate plan.
  f.git("update-ref", "refs/remotes/origin/main", f.head);
  if (!privacyMode) fs.writeFileSync(path.join(f.dir, "example.ts"), "export const value = 3;\n");
  f.git("-c", "core.hooksPath=/dev/null", "add", "example.ts");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", privacyMode === "privacy" ? "A retained publication fixture phrase." : "source change");
  f.head = f.git("rev-parse", "HEAD").toString().trim();
  f.env.LLV_GATE_PUSH_HEAD = f.head;
  // Seed with the environment the publisher supplies, including its defaults.
  Object.assign(f.env, pipelinePublicationHookEnv(f.env), {
    LANG: "C", NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=11264",
  });
  const h = harness();
  const lane = buildPipeline({ id: "p0000001", task: "Task 1", project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"),
    stages: stages.map(stage => {
      const resolved = resolvePipelineRole(stage, "run", h.ports.roleLookup);
      expect(resolved.error).toBeUndefined();
      return { ...stage, effectiveRole: resolved.role! };
    }), srcPath: "/codex/creator.jsonl", srcConversationId: "conversation_creator", now: h.ports.now(), publication: "remote-branch" });
  expect(lane.worktreeDir).toBe(f.dir);
  expect(lane.branch).toBe(f.git("branch", "--show-current").toString().trim());
  Object.assign(lane, { baseBranch: "main", baseRef: f.git("merge-base", "HEAD", "origin/main").toString().trim(), baseRefPinned: true,
    lastPassedCommit: f.head, state: "running", cursor: { stageId: "build", state: "committing", input: null, activatedBy: null } });
  lane.runs[0]!.attempts.push({ n: 1, state: "passed", effectiveRole: lane.stages[0]!.effectiveRole,
    launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: h.ports.now(), completedAt: h.ports.now(), input: null, activatedBy: null, output: "Accepted work",
    verdict: { status: "pass", findings: [] }, error: null });
  lane.delivery = { target: { repository: projectIdentityFromRemote(http.remote, f.dir)!.project, remote: http.remote, branch: "refs/heads/main" },
    disposition: "owner", publish: "enabled", active: true, ownerId: lane.id, epoch: 1, journal: [] };
  Object.assign(f.env, lessonPublicationEnv(), { LLV_GATE_LANE_ID: lane.id, LLV_GATE_STAGE_ID: "build" });
  savePipelines([lane]);
  const current = () => findPipelineRecord(lane.id)!;
  const acceptedEvidence = () => current().runs.map(run => ({ stageId: run.stageId, attempts: run.attempts.map(attempt => ({
    n: attempt.n, state: attempt.state, verdict: attempt.verdict, completedAt: attempt.completedAt, output: attempt.output,
  })) }));
  const acceptedRuns = structuredClone(acceptedEvidence());
  const source = () => ["HEAD", "HEAD^{tree}", "origin/main"].map(ref => f.git("rev-parse", ref).toString().trim());
  const pinnedSource = source();
  const checks = () => ["tsc", "scripts/eslint-changes.ts", "scripts/local-gate-tests.ts"].map(command =>
    f.calls().filter(call => call.args[0] === command).length);
  const preparations: string[] = [], receipts: PublicationCheckReceipt[] = [], receiptPaths: string[] = [];
  const captured: Array<{ command: string; output: string }> = [];
  let pushes = 0, driftOnPush = false, authorityChecks = 0, pendingId: string;
  h.ports.exec = async (command, args, cwd, overrides, options) => {
    if (command === "bun" && args.includes("--publication-prepare")) preparations.push(overrides!.LLV_GATE_PUBLICATION_ID!);
    if (command === "git" && args[0] === "push") {
      pushes++;
      const operation = current().delivery!.operation!;
      expect(operation).toMatchObject({ state: "running", sha: f.head, epoch: 1, reservationId: pendingId });
      expect(overrides).toMatchObject({ LLV_GATE_PUBLICATION_ID: operation.id, LLV_GATE_PUBLICATION_EPOCH: "1",
        LLV_GATE_PUBLICATION_FENCE: pipelinePublicationFence(current()), LLV_GATE_PUSH_HEAD: f.head,
        LLV_GATE_PUBLICATION_REF: "refs/heads/main", LLV_GATE_PUBLICATION_REMOTE_HEAD: "0".repeat(40) });
      const receipt = readPublicationCheckReceipt(overrides!.LLV_GATE_PUBLICATION_RECEIPT!, publicationCheckBinding(overrides!));
      receipts.push(receipt); receiptPaths.push(overrides!.LLV_GATE_PUBLICATION_RECEIPT!);
      expect(preparations.at(-1)).toBe(operation.id);
      if (driftOnPush) { f.env.LANG = "C.UTF-8"; driftOnPush = false; }
    }
    const result = await realExec(command, args, cwd, { ...f.env, ...overrides }, options);
    if (command === "bun" && args.includes("--publication-prepare") || command === "git" && args[0] === "push") {
      captured.push({ command, output: `${result.stdout}\n${result.stderr}` });
    }
    if (command === "git" && args[0] === "push") {
      // Observe consumption before the publisher's unconditional cleanup.
      expect(fs.existsSync(receiptPaths.at(-1)!)).toBeFalse();
      expect(fs.existsSync(`${receiptPaths.at(-1)!}.consuming`)).toBeFalse();
      if (result.code !== 0 && !privacyMode) expect(result.stderr).toContain("changed components: environment");
    }
    return result;
  };
  const publish = async () => {
    const before = authorityChecks;
    const result = await engineModule.patchPipeline(lane.id, { action: "publish", acceptedSha: f.head }, h.ports,
      { kind: "agent", role: "orchestrator", conversationId: "conversation_creator" }, () => { authorityChecks++; }, undefined);
    expect(result.error).toBeUndefined(); expect(authorityChecks).toBeGreaterThan(before);
    const operation = current().delivery!.operation!;
    expect(operation).toMatchObject({ state: "pending", sha: f.head, epoch: 1, passedStage: true });
    expect(operation.fence).toBe(pipelinePublicationFence(current()));
    pendingId = operation.id;
    return pendingId;
  };
  // Use the same durable operation and arguments as the pending-publication tick.
  const consume = () => {
    const row = current();
    return publishPipelineBranch(row, h.ports.exec, { acceptedSha: row.delivery!.operation!.sha, now: h.ports.now });
  };
  const assertPublishedOnce = () => {
    expect(current()).toMatchObject({ publishedCommit: f.head, lastPassedCommit: f.head,
      delivery: { ownerId: lane.id, epoch: 1, operation: { state: "settled", result: { ok: true, remote: "published", sha: f.head } } } });
    expect(http.rpc()).toBe(1); expect(http.rejected()).toBe(0);
    expect(f.git("--git-dir", http.bare, "rev-parse", "refs/heads/main").toString().trim()).toBe(f.head);
    expect(source()).toEqual(pinnedSource);
    expect(acceptedEvidence()).toEqual(acceptedRuns);
    expect(h.spawnInputs).toHaveLength(0);
  };
  return { f, http, fixtures, current, checks, source, pinnedSource, preparations, receipts, receiptPaths, captured, publish, consume,
    assertPublishedOnce, pushes: () => pushes, driftOnNextPush: () => { driftOnPush = true; } };
}

for (const mode of ["preparation", "transport", "padded-preparation", "padded-transport", "privacy", "remote", "success"] as const) {
  nativePublicationTest(`real privacy-only publication preserves the outcome: ${mode}`, async () => {
    const roots: string[] = [], cleanup: Array<() => void> = [], previous = loadPipelines();
    try {
      const c = await controllerPublicationFixture(roots, cleanup, mode);
      await c.publish();
      const result = await c.consume();
      if (mode === "success") {
        expect(result).toMatchObject({ ok: true, remote: "published", sha: c.f.head });
        c.assertPublishedOnce();
        expect(await c.consume()).toMatchObject({ ok: true, remote: "published", sha: c.f.head });
        expect(c.pushes()).toBe(1);
        c.assertPublishedOnce();
        return;
      }
      expect(result.ok).toBe(false);
      if (result.ok || !result.failure) throw new Error("expected publication refusal evidence");
      const privacy = mode === "privacy", remote = mode === "remote";
      const fullOutput = c.captured.at(-1)!.output;
      expect(publicationFailurePhase({ outputTail: fullOutput })).toBe(privacy ? "privacy" : null);
      expect(result.failure.outputTail.length).toBeLessThanOrEqual(4000);
      expect(result.failure.changedFiles).toBe(0);
      expect(c.source()).toEqual(c.pinnedSource);
      expect(c.current().lastPassedCommit).toBe(c.f.head);
      expect(c.current().publishedCommit).toBeNull();
      expect(c.pushes()).toBe(mode.endsWith("preparation") || privacy ? 0 : 1);
      expect(c.http.rpc()).toBe(remote ? 1 : 0);
      if (!privacy && !remote) {
        expect(fullOutput).toContain("PRIVACY GATE: PASS");
        if (mode.startsWith("padded-")) expect(fullOutput.length).toBeGreaterThan(4000);
        expect(result.failure.outputTail).toContain("publication inputs changed during");
        expect(result.failure.outputTail).toContain("PRIVACY GATE: PASS");
        expect(fs.existsSync(c.f.receipt)).toBeFalse();
        expect(c.receipts).toHaveLength(mode.endsWith("transport") ? 1 : 0);
      } else if (privacy) expect(result.failure.outputTail).toContain("known_value");
      // Read the adapter's durable result through the real controller tick.
      await tickPipelines([], { ...harness().ports, exec: realExec });
      const row = c.current();
      const record = row.publicationRecovery?.[c.f.head]?.history.at(-1);
      expect(record?.cause).toBe(remote ? "remote-refusal" : "check-failure");
      expect(publicationFailurePhase(result.failure)).toBe(privacy ? "privacy" : null);
      expect(recoverablePublication(result)).toBe(!privacy && !remote);
      expect(record?.retryAt).toBe(privacy || remote ? null : new Date(Date.parse(record!.at) + 60_000).toISOString());
      expect(row.runs[0]!.attempts[0]!.publicationRepair).toBeUndefined();
      if (!privacy) expect(row.stateDetail).not.toContain("commits this push carries were refused");
      expect(row.lastPassedCommit).toBe(c.f.head);
      expect(c.pushes()).toBe(mode.endsWith("preparation") || privacy ? 0 : 1);
    } finally {
      for (const close of cleanup) close();
      savePipelines(previous);
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    }
  }, 150_000);
}

nativePublicationTest("controller publication renews cached checks after environment drift on the same head", async () => {
  const roots: string[] = [], cleanup: Array<() => void> = [], previous = loadPipelines();
  try {
    const c = await controllerPublicationFixture(roots, cleanup);
    const seeds: PublicationCheckReceipt[] = [];
    for (const id of ["seed-cold", "seed-warm"]) {
      const env: NodeJS.ProcessEnv = { ...c.f.env, LLV_GATE_PUBLICATION_ID: id };
      // Yield while the real gate fetches from this process's port-0 server.
      const prepared = await realExec("bun", ["scripts/local-gate.ts", "pre-push", "--publication-prepare"], c.f.dir, env, { timeoutMs: 45_000 });
      expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0);
      seeds.push(readPublicationCheckReceipt(c.f.receipt, publicationCheckBinding(env)));
      const consumed = await realExec("bash", ["-c", 'bash .githooks/pre-push <<< "$1"', "seed-hook",
        `HEAD ${c.f.head} refs/heads/main ${"0".repeat(40)}`], c.f.dir,
      { ...env, PATH: `${c.f.git("--exec-path").toString().trim()}${path.delimiter}${env.PATH}` }, { timeoutMs: 45_000 });
      expect(consumed.code, consumed.stdout + consumed.stderr).toBe(0);
      expect(fs.existsSync(c.f.receipt)).toBeFalse();
      expect(c.checks()).toEqual([1, 1, 1]);
      expect(c.fixtures.touchedChecks(c.f)).toHaveLength(1);
    }
    expect(seeds[1]!.components).toEqual(seeds[0]!.components);
    expect(c.http.rpc()).toBe(0);
    c.f.env.LANG = "C.UTF-8";
    const id = await c.publish();
    expect(await c.consume()).toMatchObject({ ok: true, remote: "published", sha: c.f.head });
    const executionId = c.current().delivery!.operation!.id;
    expect(c.current().delivery!.operation!.reservationId).toBe(id);
    expect(c.preparations).toEqual([executionId]); expect(c.pushes()).toBe(1);
    expect(c.checks()).toEqual([2, 2, 2]);
    expect(c.fixtures.touchedChecks(c.f)).toHaveLength(2);
    const before = seeds[1]!.components!, after = c.receipts[0]!.components!;
    expect(Object.keys(after).filter(name => after[name] !== before[name])).toEqual(["environment"]);
    c.assertPublishedOnce();
    expect(await c.consume()).toMatchObject({ ok: true, remote: "published" });
    expect(c.preparations).toEqual([executionId]); expect(c.pushes()).toBe(1);
    c.assertPublishedOnce();
  } finally {
    for (const close of cleanup) close();
    savePipelines(previous);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}, 150_000);

nativePublicationTest("explicit controller publish replaces a consumed environment refusal on the same head", async () => {
  const roots: string[] = [], cleanup: Array<() => void> = [], previous = loadPipelines();
  try {
    const c = await controllerPublicationFixture(roots, cleanup);
    c.driftOnNextPush();
    const refusedReservation = await c.publish();
    const refused = await c.consume();
    expect(refused).toMatchObject({ ok: false, failure: { code: 1, retryableDeadline: false,
      outputTail: expect.stringContaining("changed components: environment") } });
    const refusedId = c.current().delivery!.operation!.id;
    expect(c.current().delivery!.operation).toMatchObject({ reservationId: refusedReservation, state: "settled", result: refused });
    expect(c.current().publishedCommit).toBeNull();
    expect(c.http.rpc()).toBe(0); expect(c.pushes()).toBe(1);
    expect(await realExec("git", ["--git-dir", c.http.bare, "show-ref", "--verify", "refs/heads/main"], c.f.dir, c.f.env))
      .toMatchObject({ code: 128 });
    expect(c.source()).toEqual(c.pinnedSource);
    expect(c.checks()).toEqual([1, 1, 1]);
    const refusalJournal = c.current().delivery!.journal.filter(row => row.reason.includes("publication refused:"));
    expect(refusalJournal).toHaveLength(1);
    const retryId = await c.publish();
    expect(retryId).not.toBe(refusedId);
    expect(retryId).not.toBe(refusedReservation);
    expect(c.current().publicationRecovery?.[c.f.head]?.history).toContainEqual(expect.objectContaining({ operationId: refusedId }));
    expect(await c.consume()).toMatchObject({ ok: true, remote: "published", sha: c.f.head });
    const retryExecution = c.current().delivery!.operation!;
    expect(retryExecution.id).not.toBe(refusedId);
    expect(retryExecution.reservationId).toBe(retryId);
    expect(c.preparations).toEqual([refusedId, retryExecution.id]); expect(c.pushes()).toBe(2);
    expect(c.receiptPaths[1]).not.toBe(c.receiptPaths[0]);
    expect(c.receipts[1]!.binding).not.toBe(c.receipts[0]!.binding);
    const before = c.receipts[0]!.components!, after = c.receipts[1]!.components!;
    expect(Object.keys(after).filter(name => after[name] !== before[name])).toEqual(["environment"]);
    expect(c.checks()).toEqual([2, 2, 2]);
    expect(c.fixtures.touchedChecks(c.f)).toHaveLength(2);
    expect(c.current().delivery!.journal).toEqual(expect.arrayContaining(refusalJournal));
    c.assertPublishedOnce();
  } finally {
    for (const close of cleanup) close();
    savePipelines(previous);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}, 150_000);
