import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-remote-actions-"));
const { pipelineCorpus } = await import("./fixtures/corpus");
const { savePipelines, findPipelineRecord, withPipelineMutation } = await import("./store");
const { defaultPipelinePorts, patchPipeline, settlePendingRemoteActions, settlePendingStageGit, tickPipelines } = await import("./engine");
const { realExec } = await import("@/lib/workflows/provision");
const { publishPipelineBranch } = await import("./git");
const { registerPipelineTick } = await import("./controllerSignal");
const restore = registerPipelineTick(async () => {});
afterAll(() => { restore(); fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }); });
const HEAD = "a".repeat(40);

test("legacy publication records acceptance before observing its missing delivery claim", async () => {
  const h = setupRetry();
  delete h.lane.delivery;
  savePipelines([h.lane]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let commands = 0;
  const ports = { ...h.ports, exec: async (_command: string, args: string[]) => {
    commands++; await held;
    return { code: 0, stdout: args[0] === "remote" ? "https://example.invalid/project.git" : "", stderr: "" };
  } };
  const publish = patchPipeline(h.lane.id, { action: "publish", acceptedSha: HEAD }, ports);
  try {
    const answer = await Promise.race([publish, new Promise<null>((resolve) => setTimeout(() => resolve(null), 150))]);
    expect(answer).not.toBeNull();
    expect(answer?.error).toBeUndefined();
    expect(commands).toBe(0);
    expect(findPipelineRecord(h.lane.id)!.stateDetail).toContain("pending");
    release();
    await tickPipelines([], ports);
    expect(findPipelineRecord(h.lane.id)!.publicationAdmission).toMatchObject({ state: "settled" });
    expect(findPipelineRecord(h.lane.id)!.delivery).toBeDefined();
  } finally { release(); await publish; }
});

test("a passed-stage retry acknowledges before checking its accepted local head", async () => {
  const h = setupRetry();
  h.lane.stateDetail = "publishing the passed stage: remote unavailable";
  h.lane.cursor = { stageId: "build", state: "committing", input: null, activatedBy: null };
  const attempt = h.lane.runs[0]!.attempts[0]!;
  attempt.state = "passed"; attempt.verdict = { status: "pass" };
  savePipelines([h.lane]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let commands = 0;
  const ports = { ...h.ports, exec: async (_command: string, args: string[]) => {
    commands++;
    if (args[0] === "status") await held;
    return { code: 0, stdout: args[0] === "rev-parse" ? HEAD : args[0] === "branch" ? h.lane.branch : "", stderr: "" };
  } };
  const retry = patchPipeline(h.lane.id, { action: "retry-stage" }, ports);
  try {
    const answer = await Promise.race([retry, new Promise<null>((resolve) => setTimeout(() => resolve(null), 150))]);
    expect(answer).not.toBeNull();
    expect(answer?.error).toBeUndefined();
    expect(commands).toBe(0);
    expect(findPipelineRecord(h.lane.id)).toMatchObject({ state: "running", stateDetail: expect.stringContaining("pending"), cursor: { state: "committing" } });
    release();
    await settlePendingStageGit(ports);
    expect(commands).toBeGreaterThan(0);
    expect(findPipelineRecord(h.lane.id)!.runs[0]!.attempts).toHaveLength(1);
  } finally { release(); await retry; }
});

test("a routine mutation acknowledges an existing queued publication without executing Git", async () => {
  const h = setupRetry();
  h.lane.delivery = { target: { repository: "audit-repo", remote: "origin", branch: `refs/heads/${h.lane.branch}` },
    disposition: "owner", publish: "enabled", ownerId: h.lane.id, epoch: 1, active: true, journal: [] };
  h.lane.delivery!.operation = { id: "queued-publication", epoch: h.lane.delivery!.epoch, sha: HEAD, requestKey: "pass:build:1", state: "pending" };
  savePipelines([h.lane]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let remoteCalls = 0;
  const ports = { ...h.ports, exec: async (_command: string, args: string[]) => {
    if (args.includes("ls-remote") || args.includes("fetch")) { remoteCalls++; await held; }
    return { code: 0, stdout: args.includes("ls-remote") ? `${HEAD}\trefs/heads/${h.lane.branch}\n`
      : args[0] === "rev-parse" ? HEAD : args[0] === "branch" ? h.lane.branch : "", stderr: "" };
  } };
  const mutation = patchPipeline(h.lane.id, { action: "pause" }, ports);
  try {
    const answer = await Promise.race([mutation, new Promise<null>((resolve) => setTimeout(() => resolve(null), 150))]);
    expect(answer).not.toBeNull();
    expect(answer?.error).toBeUndefined();
    expect(remoteCalls).toBe(0);
    expect(findPipelineRecord(h.lane.id)).toMatchObject({ state: "paused", delivery: { operation: { state: "pending" } } });
  } finally { release(); await mutation; }
});

test("unsupported inherited locks settle visibly before any Git command", async () => {
  const lane = pipelineCorpus(2, 1)[1]!;
  lane.state = "running"; lane.closedAt = null; lane.publication = "internal";
  lane.lastPassedCommit = HEAD;
  lane.cursor = { stageId: "build", state: "committing", input: null, activatedBy: null };
  lane.runs[0]!.attempts[0]!.state = "committing";
  savePipelines([lane]);
  let commands = 0;
  const ports = { ...defaultPipelinePorts(), getFlow: () => null,
    exec: async () => { commands++; return { code: 0, stdout: HEAD, stderr: "" }; } };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // Exercise the unsupported admission branch without claiming device proof.
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    expect(await settlePendingStageGit(ports)).toBe(true);
    expect(findPipelineRecord(lane.id)).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("WSL 2") });
    const h = setupRetry();
    expect((await patchPipeline(h.lane.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await settlePendingRemoteActions(h.ports);
    expect(findPipelineRecord(h.lane.id)).toMatchObject({ remoteAction: { state: "settled", error: expect.stringContaining("WSL 2") } });
    expect(h.remoteCalls()).toBe(0);
    expect(await publishPipelineBranch(h.lane, ports.exec, { acceptedSha: HEAD })).toMatchObject({ ok: false, error: expect.stringContaining("WSL 2") });
    expect(commands).toBe(0);
  } finally { Object.defineProperty(process, "platform", platform); }
});

test("superseded stage Git leaves the current task note untouched", async () => {
  const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
  const lane = pipelineCorpus(2, 1)[1]!;
  lane.state = "running"; lane.closedAt = null; lane.publication = "internal";
  lane.lastPassedCommit = HEAD;
  lane.cursor = { stageId: "build", state: "committing", input: null, activatedBy: null };
  lane.runs[0]!.attempts[0]!.state = "committing";
  lane.taskIds = ["current-note-task"];
  savePipelines([lane]);
  const note = { text: "The current lane is paused for a different decision.", author: { kind: "orchestrator" as const }, updatedAt: new Date().toISOString() };
  saveTasks([{ id: lane.taskIds[0]!, project: lane.project, text: "Complete the change", status: "assigned", placement: "unplaced", assignments: [], createdAt: lane.createdAt, updatedAt: lane.createdAt, note }]);
  let observed!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { observed = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ports = { ...defaultPipelinePorts(), getFlow: () => null,
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "status") { observed(); await held; return { code: 1, stdout: "", stderr: "old stage observation failed" }; }
      return { code: 0, stdout: args[0] === "rev-parse" ? HEAD : args[0] === "branch" ? lane.branch : "", stderr: "" };
    },
  };
  const settlement = settlePendingStageGit(ports);
  await entered;
  try {
    expect((await patchPipeline(lane.id, { action: "pause" }, ports)).error).toBeUndefined();
    release(); await settlement;
    expect(findPipelineRecord(lane.id)!.state).toBe("paused");
    expect(loadTasks()[0]!.note).toEqual(note);
  } finally { release(); await settlement; }
});

test("review flow identity Git yields to a pause before the controller lease", async () => {
  const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { saveFlows } = await import("@/lib/flows/store");
  const root = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "flow-ingress-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = Bun.which("git")!;
  const run = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-m", "base");
  const head = run("rev-parse", "HEAD");
  const lane = pipelineCorpus(2, 1)[1]!;
  lane.repoDir = repo; lane.worktreeDir = `${repo}-pipeline-${lane.id}`;
  run("worktree", "add", "-q", "-b", lane.branch, lane.worktreeDir, head);
  lane.state = "running"; lane.closedAt = null; lane.publication = "internal";
  lane.lastPassedCommit = head; lane.baseRef = head;
  lane.cursor = { stageId: "review", state: "pending", input: null, activatedBy: null };
  lane.runs[1]!.attempts = [];
  const transcript = path.join(root, "builder.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: crypto.randomUUID(), cwd: lane.worktreeDir } })}\n`);
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const owner = registry.ensureConversation("codex", transcript, null);
  lane.runs[0]!.attempts[0]!.agentPath = transcript;
  lane.runs[0]!.attempts[0]!.conversationId = owner.id;
  saveFlows([]);
  savePipelines([lane]);
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const entered = path.join(bin, "entered"), released = path.join(bin, "released");
  fs.writeFileSync(path.join(bin, "git"), '#!/bin/sh\nif [ "$1 $2" = "remote get-url" ]; then touch "$FLOW_ENTERED"; while [ ! -f "$FLOW_RELEASED" ]; do sleep 0.01; done; fi\nexec "$FLOW_GIT" "$@"\n', { mode: 0o700 });
  const previous = { PATH: process.env.PATH, FLOW_ENTERED: process.env.FLOW_ENTERED, FLOW_RELEASED: process.env.FLOW_RELEASED, FLOW_GIT: process.env.FLOW_GIT };
  Object.assign(process.env, { PATH: `${bin}:${previous.PATH}`, FLOW_ENTERED: entered, FLOW_RELEASED: released, FLOW_GIT: git });
  const ports = { ...defaultPipelinePorts(), stageHostResident: async () => false,
    stopStageAgent: async () => ({ outcome: "not-running" as const }),
    conversationAgentActive: async () => false, paneAgentAlive: async () => false,
    spawnAgent: async () => { throw new Error("test does not launch agents"); } };
  let controller: ReturnType<typeof tickPipelines> | undefined, pause: ReturnType<typeof patchPipeline> | undefined;
  try {
    controller = tickPipelines([], ports);
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(fs.existsSync(entered)).toBe(true);
    pause = patchPipeline(lane.id, { action: "pause" }, ports);
    const answer = await Promise.race([pause, new Promise<null>((resolve) => setTimeout(() => resolve(null), 150))]);
    expect(answer).not.toBeNull();
    expect(findPipelineRecord(lane.id)!.state).toBe("paused");
  } finally {
    fs.writeFileSync(released, "");
    await controller; await pause;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setAgentRegistryForTests(null);
  }
});

test("local committing stages progress with Git available and no flock utility", async () => {
  const repo = path.join(process.env.LLV_STATE_DIR!, "git-without-flock");
  fs.mkdirSync(repo);
  const git = Bun.which("git")!;
  const run = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-m", "base");
  const head = run("rev-parse", "HEAD");
  const lane = pipelineCorpus(2, 1)[1]!;
  lane.repoDir = repo;
  lane.worktreeDir = `${repo}-pipeline-${lane.id}`;
  run("worktree", "add", "-q", "-b", lane.branch, lane.worktreeDir, head);
  lane.state = "running"; lane.closedAt = null; lane.publication = "internal";
  lane.lastPassedCommit = head;
  lane.cursor = { stageId: "build", state: "committing", input: null, activatedBy: null };
  lane.runs[0]!.attempts[0]!.state = "committing";
  savePipelines([lane]);
  const bin = path.join(repo, "git-only");
  fs.mkdirSync(bin);
  fs.symlinkSync(git, path.join(bin, "git"));
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    expect((await realExec("git", ["rev-parse", "HEAD"], repo)).stdout.trim()).toBe(head);
    expect(await settlePendingStageGit({ ...defaultPipelinePorts(), getFlow: () => null })).toBe(true);
    expect(findPipelineRecord(lane.id)!.cursor!.stageId).toBe("review");
  } finally { process.env.PATH = previousPath; }
});

test("a remote review retry records pending work before remote Git answers", async () => {
  const lane = pipelineCorpus(2, 1)[1]!;
  lane.state = "needs_decision";
  lane.publication = "remote-branch";
  lane.closedAt = null;
  lane.cursor = { stageId: "review", state: "reviewing", input: null, activatedBy: null };
  lane.lastPassedCommit = HEAD;
  lane.runs[1]!.attempts[0]!.state = "needs_decision";
  const ports = { ...defaultPipelinePorts(),
    closeFlow: async () => ({}), conversationAgentActive: async () => false, paneAgentAlive: async () => false,
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "ls-remote") await held;
      return { code: 0, stdout: args[0] === "rev-parse" ? HEAD : args[0] === "branch" ? lane.branch : "", stderr: "" };
    },
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  savePipelines([lane]);
  const retry = patchPipeline(lane.id, { action: "retry-stage" }, ports);
  try {
    const answer = await Promise.race([retry, new Promise<null>((resolve) => setTimeout(() => resolve(null), 150))]);
    expect(answer).not.toBeNull();
    expect(answer?.pipeline).toBeDefined();
    expect(findPipelineRecord(lane.id)).toMatchObject({ remoteAction: { action: "retry-stage", state: "pending" } });
  } finally { release(); await retry; }
});

function setupRetry() {
  const lane = pipelineCorpus(2, 1)[1]!;
  lane.state = "needs_decision";
  lane.publication = "remote-branch";
  lane.closedAt = null;
  lane.cursor = { stageId: "review", state: "reviewing", input: null, activatedBy: null };
  lane.lastPassedCommit = HEAD;
  const attempt = lane.runs[1]!.attempts[0]!;
  attempt.state = "needs_decision";
  attempt.launchId = null;
  savePipelines([lane]);
  let remoteCalls = 0;
  const ports = { ...defaultPipelinePorts(), closeFlow: async () => ({}),
    conversationAgentActive: async () => false, paneAgentAlive: async () => false,
    exec: async (_command: string, args: string[]) => {
      if (args.includes("ls-remote") || args.includes("fetch")) remoteCalls++;
      return { code: 0, stdout: args[0] === "rev-parse" ? HEAD : args[0] === "branch" ? lane.branch
        : args.includes("ls-remote") ? `${HEAD}\trefs/heads/${lane.branch}\n` : "", stderr: "" };
    },
  };
  return { lane, attempt, ports, remoteCalls: () => remoteCalls };
}

test("durable retry intent settles after a fresh controller loads it", async () => {
  const h = setupRetry();
  expect((await patchPipeline(h.lane.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  expect(h.remoteCalls()).toBe(0);
  // The executor receives no closure or request object from admission.
  await settlePendingRemoteActions({ ...h.ports });
  expect(h.remoteCalls()).toBeGreaterThan(0);
  expect(findPipelineRecord(h.lane.id)).toMatchObject({ state: "running", cursor: { state: "pending" }, remoteAction: { state: "settled" } });
});

test("a paused lane cancels a remote check and preserves the pause", async () => {
  const h = setupRetry();
  await patchPipeline(h.lane.id, { action: "retry-stage" }, h.ports);
  let observed!: () => void;
  const entered = new Promise<void>((resolve) => { observed = resolve; });
  let cancelled = false;
  const executor = settlePendingRemoteActions({ ...h.ports, exec: async (command, args, cwd, env, options) => {
    if (args.includes("ls-remote")) {
      observed();
      await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return { code: null, stdout: "", stderr: "cancelled" };
    }
    return h.ports.exec(command, args);
  } });
  await entered;
  await withPipelineMutation((lanes, persist) => { lanes[0]!.state = "paused"; lanes[0]!.stateDetail = "operator pause"; persist(); });
  await executor;
  expect(cancelled).toBe(true);
  expect(findPipelineRecord(h.lane.id)).toMatchObject({ state: "paused", stateDetail: "operator pause", remoteAction: { state: "settled", error: "remote action superseded" } });
});

test("another pending action is refused before it can replace an admitted retry", async () => {
  const h = setupRetry();
  await patchPipeline(h.lane.id, { action: "retry-stage" }, h.ports);
  const id = findPipelineRecord(h.lane.id)!.remoteAction!.id;
  expect(await patchPipeline(h.lane.id, { action: "takeover", expectedOwner: "another-lane", expectedEpoch: 1, reason: "recover" }, h.ports)).toMatchObject({ status: 409 });
  expect(findPipelineRecord(h.lane.id)!.remoteAction!.id).toBe(id);
});

test("remote failure settles visibly without launching a review", async () => {
  const h = setupRetry();
  await patchPipeline(h.lane.id, { action: "retry-stage" }, h.ports);
  await settlePendingRemoteActions({ ...h.ports, exec: async (command, args) => args.includes("ls-remote")
    ? { code: 1, stdout: "", stderr: "remote unavailable" } : h.ports.exec(command, args) });
  expect(findPipelineRecord(h.lane.id)).toMatchObject({ state: "needs_decision", remoteAction: { state: "settled" } });
  expect(findPipelineRecord(h.lane.id)!.remoteAction!.error).toContain("remote unavailable");
});

test("a receipt that settles during remote verification cancels its retry", async () => {
  const h = setupRetry();
  let state: "failed" | "completed" = "failed";
  h.attempt.paneId = null;
  h.attempt.launchId = "retry-launch";
  savePipelines([h.lane]);
  const ports = { ...h.ports, spawnReceiptState: () => state,
    spawnReceipt: () => ({ state, launchId: "retry-launch", conversationId: "conversation_retry", sessionId: null, transcript: null, paneId: null, accountId: null }),
    claimSpawnRetry: () => "claimed" as const,
  };
  const accepted = await patchPipeline(h.lane.id, { action: "retry-stage", stageId: "review", launchId: "retry-launch" }, ports);
  expect(accepted.error).toBeUndefined();
  await settlePendingRemoteActions({ ...ports, exec: async (command, args) => {
    const result = await h.ports.exec(command, args);
    if (args.includes("ls-remote")) state = "completed";
    return result;
  } });
  expect(findPipelineRecord(h.lane.id)).toMatchObject({ state: "needs_decision", remoteAction: { state: "settled", error: "remote action superseded" } });
});

for (const checkedStage of ["review", "build"]) test(`controller ${checkedStage} Git does not hold the MCP mutation lease`, async () => {
  const lane = pipelineCorpus(2, 1)[1]!;
  const head = "a".repeat(40);
  lane.state = "running"; lane.closedAt = null; lane.publication = "remote-branch";
  lane.lastPassedCommit = head;
  lane.cursor = { stageId: checkedStage, state: "committing", input: null, activatedBy: null };
  lane.delivery = { target: { repository: "audit-repo", remote: "origin", branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "enabled", ownerId: lane.id, epoch: 1, active: true, journal: [] } as never;
  const attempt = lane.runs[checkedStage === "review" ? 1 : 0]!.attempts[0]!;
  attempt.state = "committing"; attempt.reviewHeadSha = head; attempt.expectedReviewHeadSha = head;
  let entered!: () => void, release!: () => void;
  const observed = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ports = { ...defaultPipelinePorts(), getFlow: () => null, stageHostResident: async () => false,
    stopStageAgent: async () => ({ outcome: "not-running" as const }),
    paneAgentAlive: async () => false, conversationAgentActive: async () => false,
    spawnAgent: async () => { throw new Error("test does not launch agents"); },
    exec: async (_command: string, args: string[]) => {
      if (checkedStage === "review" ? args.includes("ls-remote") : args[0] === "status") { entered(); await held; }
      return { code: 0, stdout: args.includes("ls-remote") ? `${head}\trefs/heads/${lane.branch}\n`
        : args[0] === "rev-parse" ? head : args[0] === "branch" ? lane.branch : "", stderr: "" };
    },
  };
  savePipelines([lane]);
  const controller = tickPipelines([], ports);
  await observed;
  const mutation = patchPipeline(lane.id, { action: "pause" }, ports);
  try {
    const answer = await Promise.race([mutation, new Promise<null>((resolve) => setTimeout(() => resolve(null), 150))]);
    expect(answer).not.toBeNull();
    expect(findPipelineRecord(lane.id)!.state).toBe("paused");
  } finally { release(); await controller; await mutation; }
});
