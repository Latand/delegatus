import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import type { Flow } from "@/lib/flows/types";

// Store modules bind some paths at import time. Run these real controller
// regressions in a child so their state and module caches cannot affect the
// pre-push hook's other selected suites in the parent Bun process. The child
// takes 45 s at load 18 on 24 cores; the bound stays inside the hook's
// five-minute budget per file.
if (process.env.LLV_PARKED_PUBLICATION_CHILD !== "1") {
  test("isolated parked publication regressions", () => {
    const result = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, LLV_PARKED_PUBLICATION_CHILD: "1" }, encoding: "utf8", timeout: 120_000,
    });
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    expect(result.status).toBe(0);
  }, 125_000);
} else {
const previousState = process.env.LLV_STATE_DIR;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-parked-publication-"));
process.env.LLV_STATE_DIR = state;
const { pipelineCorpus } = await import("./fixtures/corpus");
const { savePipelines, findPipelineRecord } = await import("./store");
const { defaultPipelinePorts, patchPipeline, tickPipelines } = await import("./engine");
const { realExec } = await import("@/lib/workflows/provision");
const { registerPipelineTick } = await import("./controllerSignal");
let restore = registerPipelineTick(async () => {});
afterAll(() => {
  restore();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(state, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-publication-repo-"));
  const repo = path.join(root, "source"); fs.mkdirSync(repo);
  const remote = path.join(root, "remote.git");
  let workingRepo = repo;
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], { cwd: workingRepo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main"); git("init", "-q", "--bare", remote);
  git("commit", "-q", "--allow-empty", "-m", "base"); const base = git("rev-parse", "HEAD");
  const lane = pipelineCorpus(2, 1)[1]!;
  git("checkout", "-q", "-b", lane.branch);
  fs.writeFileSync(path.join(repo, "stage.txt"), "passed work\n"); git("add", "."); git("commit", "-q", "-m", "passed stage");
  const passed = git("rev-parse", "HEAD");
  git("checkout", "-q", "main"); fs.writeFileSync(path.join(repo, "main.txt"), "hook repair\n");
  git("add", "."); git("commit", "-q", "-m", "main hook repair"); git("checkout", "-q", lane.branch);
  git("merge", "-q", "--no-ff", "main", "-m", "merge main"); const head = git("rev-parse", "HEAD");
  git("remote", "add", "origin", remote);
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
  lane.delivery = { target: { repository: `fixture-${lane.id}`, remote, branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "enabled", ownerId: lane.id, epoch: 1, active: true, journal: [] };
  savePipelines([lane]);
  let pushes = 0;
  const ports = { ...defaultPipelinePorts(), exec: async (...args: Parameters<typeof realExec>) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    return realExec(...args);
  }, conversationAgentActive: async () => false, stageHostResident: async () => false,
  paneAgentAlive: async () => false, getFlow: () => null, worktreePresent: () => true };
  return { root, repo: checkout, hook: path.join(repo, ".git", "hooks", "pre-push"), remote, lane, git, head, passed, ports, pushes: () => pushes,
    current: () => findPipelineRecord(lane.id)!,
    tick: async () => { for (let n = 0; n < 3; n++) await tickPipelines([], ports); },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const alreadyRemote of [false, true]) test(`parked publication accepts a clean merge descendant and advances (already remote: ${alreadyRemote})`, async () => {
  const h = fixture();
  try {
    if (alreadyRemote) h.git("push", "-q", "origin", `${h.head}:refs/heads/${h.lane.branch}`);
    expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current()).toMatchObject({ lastPassedCommit: h.head, publishedCommit: h.head, state: "completed" });
    expect(h.current().runs[0]!.attempts).toHaveLength(1);
    expect(h.current().runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    expect(h.pushes()).toBe(alreadyRemote ? 0 : 1);
  } finally { h.cleanup(); }
});

function terminalReview(h: ReturnType<typeof fixture>) {
  const builder = h.lane.stages[0]!;
  builder.next = "review";
  h.lane.stages.push(pipelineCorpus(2, 1)[1]!.stages[1]!);
  const attempt = structuredClone(h.lane.runs[0]!.attempts[0]!);
  attempt.effectiveRole = h.lane.stages[1]!.effectiveRole!;
  attempt.flowId = "approved-flow";
  attempt.reviewHeadSha = h.passed; attempt.expectedReviewHeadSha = h.passed;
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
  stage.kind = "run"; stage.onFail = { to: "build", maxRounds: 1, onExhausted: "park" };
  const attempt = h.lane.runs[1]!.attempts[0]!;
  attempt.flowId = null; attempt.state = "failed";
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
        review.reviewHeadSha = h.head; review.expectedReviewHeadSha = h.head;
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
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ reviewHeadSha: h.passed, expectedReviewHeadSha: h.passed, verdict: { status: "pass" } });
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
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ reviewHeadSha: h.passed, expectedReviewHeadSha: h.passed,
      publicationIntegration: { passedSha: h.passed, acceptedSha: h.head, mainSha: h.git("rev-parse", "origin/main") }, verdict: { status: "pass" } });
    expect(h.pushes()).toBe(alreadyRemote ? 0 : 1);
  } finally { h.cleanup(); }
});

test("moved-head admission refuses a review envelope synchronized during its off-lease proof", async () => {
  const h = fixture();
  const { reconcileEmbeddedReviewFlows } = await import("./engine");
  try {
    terminalReview(h);
    let synchronized = false;
    const ports = { ...h.ports, exec: async (...args: Parameters<typeof realExec>) => {
      const result = await h.ports.exec(...args);
      if (!synchronized && args[0] === "git" && args[1][0] === "rev-list") {
        synchronized = true;
        const lane = h.current();
        const flow = { id: "approved-flow", state: "approved", stateDetail: null, createdAt: new Date().toISOString(), closedAt: null,
          targetSha: h.passed, rounds: [{ n: 1, reviewHeadSha: h.head, verdict: "APPROVE" }] } as unknown as Parameters<typeof reconcileEmbeddedReviewFlows>[1][number];
        expect(reconcileEmbeddedReviewFlows([lane], [flow])).toBe(true);
        savePipelines([lane]);
      }
      return result;
    } };
    const result = await patchPipeline(h.lane.id, { action: "publish", acceptedSha: h.head }, ports);
    expect(synchronized).toBe(true); expect(result.status).toBe(409); expect(result.error).toContain("changed");
    expect(h.current()).toMatchObject({ state: "needs_decision", lastPassedCommit: h.passed, publishedCommit: null });
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ state: "passed", reviewHeadSha: h.head, expectedReviewHeadSha: h.head, verdict: { status: "pass" } });
    expect(h.current().runs[1]!.attempts[0]!.publicationIntegration).toBeUndefined();
    expect(h.current().delivery!.operation).toBeUndefined(); expect(h.pushes()).toBe(0);
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
    const cause = "the pre-push hook's 14-minute budget ran out before its \"touched tests\" check reached a verdict, and the push did not reach the remote";
    expect(h.pushes()).toBe(1);
    expect(h.current().state).toBe("running");
    expect(h.current().stateDetail).toBe(`passed but unpublished: ${cause}; automatic retry 1 of 3 at 2026-10-04T10:01:00.000Z`);
    expect(h.current().delivery!.operation!.result).toMatchObject({ ok: false, outcome: "not-landed", failure: { hookBudgetMs: 840_000, hookStoppedCheck: "touched tests", changedFiles: 1 } });
    for (const wait of [60_000, 5 * 60_000, 15 * 60_000]) { clock += wait; for (let n = 0; n < 8; n++) await tickPipelines([], ports); }
    expect(h.pushes()).toBe(4);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail!.split("\n")[0]).toBe(`publishing the passed stage: ${cause}; retried 3 times. Nothing on this branch caused it: check that the hook can finish on this machine (time limit, memory, a stopped Viewer), then retry-stage.`);
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
    expect(h.current().stateDetail).toContain("automatic retry 1 of 3");
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

for (const action of ["publish", "retry-stage"] as const) test(`next explicit ${action} retries a settled failure without takeover`, async () => {
  const h = fixture();
  try {
    h.lane.lastPassedCommit = h.head;
    h.lane.delivery!.operation = { id: "failed", state: "settled", epoch: 1, sha: h.head,
      result: { ok: false, error: "hook failed" } };
    h.lane.stateDetail = "hook failed"; savePipelines([h.lane]);
    expect((await patchPipeline(h.lane.id, { action }, h.ports)).error).toBeUndefined(); await h.tick();
    expect(h.current()).toMatchObject({ state: "completed", publishedCommit: h.head, delivery: { epoch: 1, ownerId: h.lane.id } });
    expect(h.pushes()).toBe(1);
  } finally { h.cleanup(); }
});

for (const action of ["publish", "retry-stage"] as const) for (const legacy of [false, true]) test(`terminal review ${action} retries a hook failure while preserving the approved flow and pass (legacy attempt: ${legacy})`, async () => {
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
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ flowId: "approved-flow", reviewHeadSha: h.passed, expectedReviewHeadSha: h.passed, verdict: { status: "pass" } });
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

for (const action of ["publish", "retry-stage"] as const) for (const alreadyRemote of [false, true]) test(`marker-less legacy reconciliation preserves the original passed review for ${action} (already remote: ${alreadyRemote})`, async () => {
  const h = fixture();
  const { reconcilePipelinePublication } = await import("./git");
  try {
    await legacyPublication(h);
    if (alreadyRemote) h.git("push", "-q", "origin", `${h.passed}:refs/heads/${h.lane.branch}`);
    const flow = { id: "approved-flow", state: "approved", stateDetail: null, targetSha: h.passed,
      createdAt: new Date().toISOString(), closedAt: null,
      rounds: [{ n: 1, reviewHeadSha: h.passed, verdict: "APPROVE" }] } as Flow;
    const effects: string[] = [];
    const ports = { ...h.ports, remoteActionSupported: () => false, getFlow: () => flow,
      patchFlow: () => { effects.push("patch"); return {}; }, closeFlow: async () => { effects.push("close"); } };
    expect(await reconcilePipelinePublication(h.lane.id, 1, realExec, null)).toBeNull();
    expect(h.current().delivery!.operation).toMatchObject({ state: "settled", passedStage: true, sha: h.passed, epoch: 1 });
    expect(h.current().runs[1]!.attempts[0]!.state).toBe("passed");
    expect((await patchPipeline(h.lane.id, { action }, ports)).error).toBeUndefined();
    expect(h.current().remoteAction).toBeUndefined();
    for (let n = 0; n < 3; n++) await tickPipelines([], ports);
    expect(h.current()).toMatchObject({ state: "completed", lastPassedCommit: h.passed, publishedCommit: h.passed,
      delivery: { epoch: 1, ownerId: h.lane.id } });
    expect(h.current().runs[1]!.attempts).toHaveLength(1);
    expect(h.current().runs[1]!.attempts[0]).toMatchObject({ n: 1, flowId: "approved-flow", reviewHeadSha: h.passed,
      expectedReviewHeadSha: h.passed, verdict: { status: "pass" } });
    expect(h.pushes()).toBe(alreadyRemote ? 0 : 1);
    expect(flow.state).toBe("approved"); expect(effects).toEqual([]);
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

for (const changed of ["id", "epoch", "sha"] as const) test(`reconciliation leaves a publication whose ${changed} changes during its remote read untouched`, async () => {
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
}
