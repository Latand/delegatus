/**
 * The HTTP half of #1766: a create refused on the registry lock says nothing
 * was admitted and may be repeated, instead of answering 500 and leaving the
 * caller to guess whether a pipeline exists. The route carries no idempotency
 * receipt of its own, so what it owes is a truthful, repeatable refusal.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const previousLockWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-busy-http-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
fs.mkdirSync(path.join(process.env.LLV_CODEX_HOME, "sessions"), { recursive: true });

const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { agentRegistry } = await import("@/lib/agent/registry");
const { loadPipelines, withPipelineMutation } = await import("@/lib/pipelines/store");
const { POST } = await import("./route");

/** A durable creator lineage, the same one an agent caller carries. */
function seedCallerPath(): string {
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
  return artifactPath;
}

const callerPath = seedCallerPath();

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  if (previousLockWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  else process.env.LLV_PIPELINE_LOCK_WAIT_MS = previousLockWait;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function createRequest(task: string): NextRequest {
  return new NextRequest("http://127.0.0.1:8898/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1:8898", "content-type": "application/json" },
    body: JSON.stringify({ task, spec: task, repoDir: process.cwd(), src: callerPath, autoStart: false, stages: [] }),
  });
}

function pipelinesNamed(task: string): string[] {
  return loadPipelines().filter((pipeline) => pipeline.task === task).map((pipeline) => pipeline.id);
}

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

test("two creates racing on the registry lock both succeed", async () => {
  const [first, second] = await Promise.all([
    POST(createRequest("http race a")),
    POST(createRequest("http race b")),
  ]);

  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(pipelinesNamed("http race a")).toHaveLength(1);
  expect(pipelinesNamed("http race b")).toHaveLength(1);
});

test("a create refused on the lock is retryable, admits nothing, and succeeds when repeated", async () => {
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "200";
  const releaseLease = await holdRegistryLease();
  const task = "http busy refusal";

  const startedAt = Date.now();
  const refused = await POST(createRequest(task));
  const elapsed = Date.now() - startedAt;

  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ code: "store_busy", retryable: true });
  expect(pipelinesNamed(task)).toEqual([]);
  /* It waited for the lock, and the wait was bounded: the request answered
     while the lease was still held by someone else. */
  expect(elapsed).toBeGreaterThanOrEqual(200);
  expect(elapsed).toBeLessThan(10_000);

  await releaseLease();
  const repeated = await POST(createRequest(task));
  expect(repeated.status).toBe(201);
  expect(pipelinesNamed(task)).toHaveLength(1);
});
