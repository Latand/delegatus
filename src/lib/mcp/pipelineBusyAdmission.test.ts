/**
 * A busy refusal before admission never consumes the request id (#1766).
 *
 * Production route and binding: the MCP tool service built from the real
 * `viewerMcpBindings` over the real `SqliteMcpReceiptStore`, in an isolated
 * state directory. The contention is the real one — the pipeline registry
 * lease, held by another mutation — and the assertions are about what the
 * registry holds afterwards, never about the wording of the refusal.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { BoardTask } from "@/lib/tasks/types";

const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const previousLockWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-busy-mcp-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
fs.mkdirSync(path.join(process.env.LLV_CODEX_HOME, "sessions"), { recursive: true });

const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { agentRegistry } = await import("@/lib/agent/registry");
const { loadPipelines, withPipelineMutation } = await import("@/lib/pipelines/store");
const { getPipelines } = await import("@/lib/pipelines/engine");
const { isoNow } = await import("@/lib/tasks/helpers");
const { mutateTasks } = await import("@/lib/tasks/store");
const { FileTransactionBusyError } = await import("@/lib/state/fileTransaction");
const { viewerMcpBindings, viewerMcpRecoverableTools } = await import("./bindings");
const { SqliteMcpReceiptStore, createMcpToolService } = await import("./server");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  if (previousLockWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  else process.env.LLV_PIPELINE_LOCK_WAIT_MS = previousLockWait;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function seedCaller(): { conversationId: ViewerConversationId; path: string } {
  const store = agentRegistry();
  const begun = beginLegacySpawnFixture(store, {
    engine: "codex",
    cwd: process.cwd(),
    role: "builder",
    origin: { kind: "operator" },
  });
  if (begun.kind !== "created") throw new Error("expected create");
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(process.env.LLV_CODEX_HOME!, "sessions", `caller-${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  const settled = store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: process.cwd(),
    accountId: "terra",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error(`settlement conflict: ${settled.code}`);
  return { conversationId: settled.conversation.id, path: artifactPath };
}

const caller = seedCaller();
const receiptsPath = path.join(sandbox, "mcp-receipts.sqlite");
const receipts = new SqliteMcpReceiptStore(receiptsPath);
const service = createMcpToolService(
  viewerMcpBindings(),
  receipts,
  undefined,
  { recovery: viewerMcpRecoverableTools() },
);

function createArgs(clientRequestId: string, task: string): Record<string, unknown> {
  return {
    clientRequestId,
    task,
    spec: task,
    repoDir: process.cwd(),
    src: caller.path,
    autoStart: false,
    stages: [],
  };
}

function pipelinesNamed(task: string): string[] {
  return loadPipelines().filter((pipeline) => pipeline.task === task).map((pipeline) => pipeline.id);
}

/** Hold the pipeline registry lease until the returned release is called. */
async function holdRegistryLease(): Promise<() => Promise<void>> {
  let release = (): void => {};
  let acquired = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withPipelineMutation(async () => {
    acquired();
    await held;
  });
  await ready;
  return async () => {
    release();
    await holder;
  };
}

test("two creates racing on the registry lock both succeed under their own ids", async () => {
  const [first, second] = await Promise.all([
    service.callTool("create_pipeline", createArgs(`race-a-${crypto.randomUUID()}`, "busy race a")),
    service.callTool("create_pipeline", createArgs(`race-b-${crypto.randomUUID()}`, "busy race b")),
  ]);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(pipelinesNamed("busy race a")).toHaveLength(1);
  expect(pipelinesNamed("busy race b")).toHaveLength(1);
  const firstId = first.ok ? first.pipelineId : null;
  const secondId = second.ok ? second.pipelineId : null;
  expect(firstId).not.toBe(secondId);
});

test("a create refused as busy runs again under the same id and creates exactly one pipeline", async () => {
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "200";
  const releaseLease = await holdRegistryLease();
  const clientRequestId = `busy-then-retry-${crypto.randomUUID()}`;
  const task = "busy refusal is not a receipt";

  const refused = await service.callTool("create_pipeline", createArgs(clientRequestId, task));
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.retryable).toBe(true);
    expect(refused.replayed).toBe(false);
    expect(refused.details?.outcome).toBe("not-executed");
    expect(refused.details?.nextAction).toBe("retry-same-key");
  }
  /* Nothing was admitted, and nothing was remembered under the key. */
  expect(pipelinesNamed(task)).toEqual([]);
  expect(receipts.lookup(`create_pipeline:${clientRequestId}`)).toBeNull();

  await releaseLease();
  const retried = await service.callTool("create_pipeline", createArgs(clientRequestId, task));
  expect(retried.ok).toBe(true);
  expect(retried.replayed).toBe(false);
  expect(pipelinesNamed(task)).toHaveLength(1);

  /* And the id is spent again the moment a create really happens. */
  const replayed = await service.callTool("create_pipeline", createArgs(clientRequestId, task));
  expect(replayed.ok).toBe(true);
  expect(replayed.replayed).toBe(true);
  expect(pipelinesNamed(task)).toHaveLength(1);
});

test("a completed create still replays its receipt under the same id", async () => {
  delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  const clientRequestId = `completed-${crypto.randomUUID()}`;
  const task = "completed create replays";

  const first = await service.callTool("create_pipeline", createArgs(clientRequestId, task));
  const second = await service.callTool("create_pipeline", createArgs(clientRequestId, task));

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(second.replayed).toBe(true);
  if (first.ok && second.ok) expect(second.pipelineId).toBe(first.pipelineId);
  expect(pipelinesNamed(task)).toHaveLength(1);
});

test("a refused create that carries no admission evidence still consumes its id", async () => {
  /* The rule is narrow on purpose: only a refusal proven to precede admission
     is released. An ordinary rejected request keeps answering from its
     receipt, so nothing about idempotency is loosened by #1766. */
  const clientRequestId = `invalid-${crypto.randomUUID()}`;
  const invalid = { clientRequestId, task: "", repoDir: process.cwd(), src: caller.path, autoStart: false, stages: [] };

  const refused = await service.callTool("create_pipeline", invalid);
  const repeated = await service.callTool("create_pipeline", invalid);

  expect(refused.ok).toBe(false);
  expect(repeated.ok).toBe(false);
  expect(repeated.replayed).toBe(true);
  expect(receipts.lookup(`create_pipeline:${clientRequestId}`)).not.toBeNull();
});

test("the bounded wait for the lock cannot hang a request", async () => {
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "300";
  const releaseLease = await holdRegistryLease();
  const startedAt = Date.now();
  const refused = await service.callTool("create_pipeline", createArgs(`bounded-${crypto.randomUUID()}`, "bounded wait"));
  const elapsed = Date.now() - startedAt;
  await releaseLease();

  expect(refused.ok).toBe(false);
  /* It waited for the lock rather than refusing on contact, and it answered
     rather than holding the request open while the lease stayed taken. */
  expect(elapsed).toBeGreaterThanOrEqual(300);
  expect(elapsed).toBeLessThan(10_000);
  expect(pipelinesNamed("bounded wait")).toEqual([]);
});

test("a pipeline_action refused on the lock keeps its id too", async () => {
  delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  const task = "pipeline action after busy";
  const created = await service.callTool("create_pipeline", createArgs(`action-create-${crypto.randomUUID()}`, task));
  expect(created.ok).toBe(true);
  const pipelineId = created.ok ? created.pipelineId : null;

  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "200";
  const releaseLease = await holdRegistryLease();
  const clientRequestId = `action-close-${crypto.randomUUID()}`;
  const args = { clientRequestId, pipelineId, action: "update-draft", task: "pipeline action after busy, renamed" };

  const refused = await service.callTool("pipeline_action", args);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.retryable).toBe(true);
  expect(receipts.lookup(`pipeline_action:${clientRequestId}`)).toBeNull();

  await releaseLease();
  delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  const retried = await service.callTool("pipeline_action", args);
  expect(retried.ok).toBe(true);
  expect(retried.replayed).toBe(false);
  expect(loadPipelines().find((pipeline) => pipeline.id === pipelineId)?.task).toBe("pipeline action after busy, renamed");
});

test("a link-task refused on the task lock keeps its id too", async () => {
  const task = "link task after busy";
  const created = await service.callTool("create_pipeline", createArgs(`link-create-${crypto.randomUUID()}`, task));
  expect(created.ok).toBe(true);
  const pipelineId = created.ok ? created.pipelineId : null;

  /* The task lock is held by whoever is inside a synchronous transaction, which
     no call in this process can be while another awaits. The contention is
     injected at the same seam the store raises it from: before the mutator
     runs, which is the only shape `withFileTransactionSync` can refuse in. */
  let refuseOnce = true;
  const linkDependencies = {
    getPipelines,
    isoNow,
    mutateTasks<R>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }): R {
      if (refuseOnce) {
        refuseOnce = false;
        throw new FileTransactionBusyError("task state is busy");
      }
      return mutateTasks((tasks) => {
        const outcome = mutator(tasks);
        return { tasks: outcome.tasks, result: outcome.result };
      });
    },
  };
  const linkService = createMcpToolService(viewerMcpBindings(linkDependencies), receipts);
  const board = await linkService.callTool("create_task", {
    clientRequestId: `link-task-${crypto.randomUUID()}`,
    text: task,
    project: path.basename(process.cwd()),
  });
  expect(board.ok).toBe(true);
  const taskId = board.ok ? board.taskId : null;
  const clientRequestId = `link-${crypto.randomUUID()}`;
  const args = { clientRequestId, taskId, pipelineId };

  const refused = await linkService.callTool("link_task_to_pipeline", args);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.retryable).toBe(true);
  expect(receipts.lookup(`link_task_to_pipeline:${clientRequestId}`)).toBeNull();

  const retried = await linkService.callTool("link_task_to_pipeline", args);
  expect(retried.ok).toBe(true);
  expect(retried.replayed).toBe(false);
});
