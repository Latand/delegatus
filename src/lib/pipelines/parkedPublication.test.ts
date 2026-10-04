import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import type { Flow } from "@/lib/flows/types";

// Store modules bind some paths at import time. Run these real controller
// regressions in a child so their state and module caches cannot affect the
// pre-push hook's other selected suites in the parent Bun process.
if (process.env.LLV_PARKED_PUBLICATION_CHILD !== "1") {
  test("isolated parked publication regressions", () => {
    const result = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, LLV_PARKED_PUBLICATION_CHILD: "1" }, encoding: "utf8", timeout: 30_000,
    });
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    expect(result.status).toBe(0);
  }, 35_000);
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
