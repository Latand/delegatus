import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

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
