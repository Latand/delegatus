import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

/* Who launched an attempt by hand (`launchedBy`): the cursor carries the actor of
   a start, a retry or a decision answer to the one attempt it makes, and an
   attempt the engine makes along an edge carries none. The board's orchestrator
   wires read this record. Every port is a mock and the state directory is
   private to this file. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hand-launch-"));
const { createPipelineFromRequest, reportStageCompletion, tickPipelines, patchPipeline } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const { loadPipelines, savePipelines, pipelineRevision } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;

registerPipelineTick(async () => {});
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const HEAD = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
const agent = (conversationId: string) => ({ kind: "agent", role: "builder", conversationId }) as const;
const creator = agent("conversation_creator");

function entry(pathname: string): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "stage", engine: "codex",
    kind: "session", fmt: "codex", parent: null, mtime: 2_000, size: 10, activity: "idle", proc: null, pid: null,
    model: null, pendingQuestion: null, waitingInput: null,
  };
}

function harness() {
  const messages = new Map<string, { text: string; ts: number }>();
  let spawned = 0;
  let clock = 1_000_000;
  const ports: PipelinePorts = {
    exec: async (command, args) => {
      if (command === "timeout") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "https://forge.example/repo.git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "--show-current") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: (roleId) => roleId === "builder"
      ? { engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "Builder guidance" }
      : null,
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    spawnAgent: async (_input, onReserved) => {
      spawned += 1;
      onReserved({ launchId: `launch-${spawned}`, conversationId: `conversation_stage_${spawned}`, accountId: "account-a" });
      return { launchId: `launch-${spawned}`, conversationId: `conversation_stage_${spawned}`, sessionId: `session-${spawned}`, transcript: `/codex/stage-${spawned}.jsonl`, paneId: `%${spawned}`, accountId: "account-a" };
    },
    paneAgentAlive: async () => false,
    stopStageAgent: async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "stopped" }),
    stageHostResident: async () => false,
    monotonicNow: () => Date.now(),
    worktreePresent: () => true,
    conversationAgentActive: async () => null,
    durableTurnEvidence: async (_engine, pathname) => {
      const message = messages.get(pathname);
      return message ? { turn: "terminal", message, lastRecordAt: message.ts } : null;
    },
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: (item) => messages.get(item.path) ?? null,
    pathForConversation: (id) => {
      const n = /^conversation_stage_(\d+)$/.exec(id)?.[1];
      return n ? `/codex/stage-${n}.jsonl` : null;
    },
    sourcePathAllowed: (pathname) => pathname.startsWith("/codex/") && pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => {
      if (pathname === "/codex/creator.jsonl") return "conversation_creator";
      const n = /stage-(\d+)\.jsonl$/.exec(pathname)?.[1];
      return n ? `conversation_stage_${n}` : null;
    },
    pipelineAdoptionCandidates: () => [],
    createFlow: async () => ({ error: "no review flows in this suite" }),
    patchFlow: () => ({}),
    closeFlow: async () => ({}),
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date((clock += 1_000)).toISOString(),
  };
  /** The stage spawned `n`th reports and its turn ends. */
  const settle = async (n: number, verdict: "pass" | "fail" | "needs_decision") => {
    await reportStageCompletion({ verdict, summary: `${verdict} from ${n}` }, agent(`conversation_stage_${n}`), ports);
    const pathname = `/codex/stage-${n}.jsonl`;
    messages.set(pathname, { text: "Done.", ts: clock + 100_000 });
    await tickPipelines([entry(pathname)], ports);
  };
  return { ports, settle };
}

const stage = (id: string, next: string | null) => ({ id, kind: "run", role: { roleId: "builder" }, prompt: `Do ${id}`, next });
const current = () => loadPipelines()[0]!;
const attemptsOf = (stageId: string) => current().runs.find((run) => run.stageId === stageId)!.attempts;

async function create(ports: PipelinePorts, autoStart = true): Promise<string> {
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Hand launches", publication: "internal", spec: "AC", repoDir: "/repo",
    stages: [stage("build", "verify"), stage("verify", null)] as never, src: "/codex/creator.jsonl", ...(autoStart ? {} : { autoStart: false }) }, ports);
  if (!created.pipeline) throw new Error(created.error);
  return created.pipeline.id;
}

test("a draft the creator starts launches its first attempt under the creator's hand", async () => {
  const h = harness();
  const id = await create(h.ports, false);
  expect(current().state).toBe("draft");
  expect((await patchPipeline(id, { action: "start" }, h.ports, creator)).error).toBeUndefined();
  expect(current().cursor?.launchedBy?.actor).toEqual(creator);
  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn the entry stage
  expect(attemptsOf("build")[0]).toMatchObject({ n: 1, launchedBy: { actor: creator } });
  expect(attemptsOf("build")[0]!.startedAt).toBeTruthy();
  expect(current().cursor?.launchedBy).toBeUndefined();
  /* The engine follows the pass edge on its own: that launch has no hand. */
  await h.settle(1, "pass");
  await tickPipelines([], h.ports);
  expect(attemptsOf("verify")[0]!.startedAt).toBeTruthy();
  expect(attemptsOf("verify")[0]!.launchedBy).toBeUndefined();
});

test("a lane created to start at once carries no hand launch, and a local retry by the seat does", async () => {
  const h = harness();
  const id = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(attemptsOf("build")[0]!.launchedBy).toBeUndefined();
  await h.settle(1, "fail");
  expect(current().state).toBe("needs_decision");
  const seat = agent("conversation_creator");
  const retried = await patchPipeline(id, { action: "retry-stage" }, h.ports, seat);
  expect(retried.error).toBeUndefined();
  expect(current().remoteAction).toBeUndefined();
  expect(current().cursor).toMatchObject({ stageId: "build", state: "pending", launchedBy: { actor: seat } });
  await tickPipelines([], h.ports);
  expect(attemptsOf("build")[1]).toMatchObject({ n: 2, launchedBy: { actor: seat } });
  expect(attemptsOf("build")[1]!.startedAt).toBeTruthy();
  /* The next stage along the pass edge is the engine's, however recent the retry. */
  await h.settle(2, "pass");
  await tickPipelines([], h.ports);
  expect(attemptsOf("verify")[0]!.startedAt).toBeTruthy();
  expect(attemptsOf("verify")[0]!.launchedBy).toBeUndefined();
});

test("a decision answer launches its continuation under the answering hand", async () => {
  const h = harness();
  const id = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await h.settle(1, "needs_decision");
  expect(current().state).toBe("needs_decision");
  const answered = await patchPipeline(id, {
    action: "resolve-decision", clientRequestId: "answer-1", answer: "Use Markdown.",
    expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(current()),
  }, h.ports, creator);
  expect(answered.error).toBeUndefined();
  expect(attemptsOf("build")[1]).toMatchObject({ n: 2, decisionAnswerId: "answer-1", launchedBy: { actor: creator } });
  expect(current().cursor?.launchedBy).toBeUndefined();
});
