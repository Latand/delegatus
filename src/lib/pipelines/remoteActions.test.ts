import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-remote-actions-"));
const { pipelineCorpus } = await import("./fixtures/corpus");
const { savePipelines, findPipelineRecord, withPipelineMutation } = await import("./store");
const { defaultPipelinePorts, patchPipeline, settlePendingRemoteActions, tickPipelines } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const restore = registerPipelineTick(async () => {});
afterAll(() => { restore(); fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }); });
const HEAD = "a".repeat(40);

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
