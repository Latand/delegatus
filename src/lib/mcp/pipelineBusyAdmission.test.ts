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
import { afterAll, expect, spyOn, test } from "bun:test";

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
const pipelineStore = await import("@/lib/pipelines/store");
const { loadPipelines, withPipelineMutation } = pipelineStore;
const { getPipelines, tickPipelines } = await import("@/lib/pipelines/engine");
const { publishHotStateAuthority } = await import("@/lib/state/hotStateAuthority");
const { isoNow } = await import("@/lib/tasks/helpers");
const { mutateTasks } = await import("@/lib/tasks/store");
const { FileTransactionBusyError } = await import("@/lib/state/fileTransaction");
const { productionDomainDependencies, viewerMcpBindings, viewerMcpRecoverableTools } = await import("./bindings");
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
const recovery = viewerMcpRecoverableTools({ ...productionDomainDependencies,
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
  attentionAuthority: () => ({ kind: "worker", role: "builder", conversationId: caller.conversationId }),
});
const service = createMcpToolService(
  viewerMcpBindings(),
  receipts,
  undefined,
  { recovery },
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

test("original-key recovery reconstructs a creation committed before its MCP receipt settled", async () => {
  const request = createArgs("creation-recovery", "recover committed creation");
  const originalSettle = receipts.settle.bind(receipts);
  const failSettlement = spyOn(receipts, "settle").mockImplementation((...args) => {
    if (args[0] === "create_pipeline:creation-recovery") throw new Error("simulated receipt interruption");
    return originalSettle(...args);
  });
  try { expect((await service.callTool("create_pipeline", request)).ok).toBe(true); }
  finally { failSettlement.mockRestore(); }
  const originalIds = pipelinesNamed("recover committed creation");
  expect(originalIds).toHaveLength(1);
  expect(receipts.lookup("create_pipeline:creation-recovery")?.stage).toBe("dispatching");
  const restarted = createMcpToolService(viewerMcpBindings(), new SqliteMcpReceiptStore(receiptsPath), undefined, { recovery });
  const replay = await restarted.callTool("create_pipeline", { ...request, recoveryOnly: true });
  expect(replay).toMatchObject({ ok: true, replayed: true, outcome: "settled", pipelineId: originalIds[0] });
  expect(pipelinesNamed("recover committed creation")).toEqual(originalIds);
  expect(await restarted.callTool("create_pipeline", { ...request, task: "different request" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
});

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
    service.callTool("create_pipeline", { ...createArgs(`race-a-${crypto.randomUUID()}`, "busy race a"), delivery: { branch: "refs/heads/shared-review-target" } }),
    service.callTool("create_pipeline", { ...createArgs(`race-b-${crypto.randomUUID()}`, "busy race b"), delivery: { branch: "refs/heads/shared-review-target" } }),
  ]);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(pipelinesNamed("busy race a")).toHaveLength(1);
  expect(pipelinesNamed("busy race b")).toHaveLength(1);
  const records = loadPipelines().filter((pipeline) => pipeline.delivery?.target.branch === "refs/heads/shared-review-target");
  expect(records.filter((pipeline) => pipeline.delivery?.active)).toHaveLength(1);
  const owner = records.find((pipeline) => pipeline.delivery?.active)!;
  expect(records.find((pipeline) => pipeline.id !== owner.id)).toMatchObject({ publication: "internal", delivery: { ownerId: owner.id, epoch: 1, publish: "disabled" } });
  const firstId = first.ok ? first.pipelineId : null;
  const secondId = second.ok ? second.pipelineId : null;
  expect(firstId).not.toBe(secondId);
});

test("a create that meets a held lease is queued under its id and stored exactly once (#1766, #1835)", async () => {
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "200";
  const releaseLease = await holdRegistryLease();
  const clientRequestId = `busy-then-retry-${crypto.randomUUID()}`;
  const task = "busy refusal is queued";

  const queued = await service.callTool("create_pipeline", createArgs(clientRequestId, task));
  expect(queued).toMatchObject({ ok: true, replayed: false, queued: true });
  const pipelineId = queued.ok ? String(queued.pipelineId) : "";
  /* Nothing is stored while the lease is held. */
  expect(pipelinesNamed(task)).toEqual([]);

  await releaseLease();
  /* A retry under the same id answers the same queued pipeline. */
  const retried = await service.callTool("create_pipeline", createArgs(clientRequestId, task));
  expect(retried).toMatchObject({ ok: true, replayed: true, pipelineId });

  /* The controller's next pass stores it, and a second pass stores nothing more. */
  await tickPipelines([]);
  expect(pipelinesNamed(task)).toEqual([pipelineId]);
  await tickPipelines([]);
  expect(pipelinesNamed(task)).toEqual([pipelineId]);
});

test("a queued create the controller refuses when it stores it answers that refusal to the caller's read of its id (#1835)", async () => {
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "200";
  const releaseLease = await holdRegistryLease();
  const task = "queued then refused";
  const queued = await service.callTool("create_pipeline", createArgs(`queued-refused-${crypto.randomUUID()}`, task))
    .finally(releaseLease);
  expect(queued).toMatchObject({ ok: true, queued: true });
  const pipelineId = queued.ok ? String(queued.pipelineId) : "";

  /* Before the controller's pass, the read says it is queued. */
  const waiting = await service.callTool("get_pipeline", { clientRequestId: `read-${crypto.randomUUID()}`, pipelineId });
  expect(waiting).toMatchObject({ ok: false, details: { code: "pipeline_queued", pipelineId, queuedCreation: { state: "queued" } } });

  /* The store turns it away for a reason no retry changes. */
  const refusal = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementationOnce(async () => {
    throw new Error("idempotency_conflict: creation arguments changed");
  });
  try {
    await tickPipelines([]);
  } finally {
    refusal.mockRestore();
  }
  expect(pipelinesNamed(task)).toEqual([]);

  const read = await service.callTool("get_pipeline", { clientRequestId: `read-${crypto.randomUUID()}`, pipelineId });
  expect(read).toMatchObject({
    ok: false,
    details: {
      code: "pipeline_creation_refused",
      pipelineId,
      queuedCreation: { state: "refused", error: "idempotency_conflict: creation arguments changed" },
    },
  });
  expect(read.ok ? "" : read.error).toContain("refused when the controller stored it");
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
  const answered = await service.callTool("create_pipeline", createArgs(`bounded-${crypto.randomUUID()}`, "bounded wait"));
  const elapsed = Date.now() - startedAt;
  await releaseLease();

  /* It waited for the lock rather than refusing on contact (the store gives up
     only once its own clock has passed the configured wait), and it answered
     rather than holding the request open: the lease is released only after
     the answer arrived. */
  expect(elapsed).toBeGreaterThanOrEqual(300);
  expect(answered).toMatchObject({ ok: true, queued: true });
  expect(pipelinesNamed("bounded wait")).toEqual([]);
  await tickPipelines([]);
  expect(pipelinesNamed("bounded wait")).toHaveLength(1);
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

test("a create during a deploy's write fence is queued and stored by the release that can write (#1835)", async () => {
  delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  const stateDir = process.env.LLV_STATE_DIR!;
  const revision = "e".repeat(40);
  const previousPort = process.env.PORT;
  delete process.env.PORT;
  /* A live installation's pipeline store exists before any deploy fences it. */
  loadPipelines();
  /* The handoff as the deploy adapter publishes it: a release target, and
     the authority fencing every hot-state writer until the successor is
     ready. */
  fs.writeFileSync(path.join(stateDir, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:1", revision }));
  publishHotStateAuthority(stateDir, "fencing", revision);
  const clientRequestId = `fenced-${crypto.randomUUID()}`;
  const task = "created during the handover";
  try {
    const queued = await service.callTool("create_pipeline", createArgs(clientRequestId, task));
    expect(queued).toMatchObject({ ok: true, queued: true, queuedBecause: "hot state writes are fenced during release handoff" });
    const pipelineId = queued.ok ? String(queued.pipelineId) : "";
    expect(pipelinesNamed(task)).toEqual([]);

    /* The successor activates, and its controller's next pass stores it. */
    publishHotStateAuthority(stateDir, "sqlite", revision, { activationReadyAt: new Date().toISOString() });
    await tickPipelines([]);

    expect(pipelinesNamed(task)).toEqual([pipelineId]);
    expect(loadPipelines().find((pipeline) => pipeline.id === pipelineId)).toMatchObject({
      srcPath: caller.path,
      creationRequest: { key: `create_pipeline:${clientRequestId}` },
    });
    /* A retry under the same id answers the stored pipeline. */
    expect(await service.callTool("create_pipeline", createArgs(clientRequestId, task))).toMatchObject({ ok: true, pipelineId });
  } finally {
    fs.rmSync(path.join(stateDir, "viewer-release.json"), { force: true });
    fs.rmSync(path.join(stateDir, "hot-state-authority.json"), { force: true });
    if (previousPort !== undefined) process.env.PORT = previousPort;
  }
});
