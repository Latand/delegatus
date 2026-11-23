/**
 * The HTTP half of #1766: a create refused on the registry lock says nothing
 * was admitted and may be repeated, instead of answering 500 and leaving the
 * caller to guess whether a pipeline exists. Since #1835 such a create is
 * queued rather than refused: the answer carries the pipeline, 202 says it is
 * not stored yet, and the serving release's controller stores it once.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const previousLockWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-busy-http-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
fs.mkdirSync(path.join(process.env.LLV_CODEX_HOME, "sessions"), { recursive: true });
// The source may be a read-only review export without Git metadata. Create
// only this fixture's tiny repository; never initialize the checkout itself.
const repoDir = path.join(sandbox, "repo");
const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe", env: {
  ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
} });
git("init", "--template=", "--initial-branch=main", repoDir);
fs.writeFileSync(path.join(repoDir, "README.md"), "HTTP creation fixture\n");
git("-C", repoDir, "add", "README.md");
git("-C", repoDir, "-c", "commit.gpgsign=false", "commit", "-m", "Seed fixture");
git("-C", repoDir, "remote", "add", "origin", "https://example.invalid/project.git");

const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { agentRegistry } = await import("@/lib/agent/registry");
const { loadPipelines, withPipelineMutation } = await import("@/lib/pipelines/store");
const { tickPipelinesController } = await import("@/lib/pipelines/controllerPass");
const { queuedPipelineCreationStatus } = await import("@/lib/pipelines/creationQueue");
const { POST } = await import("./route");

/** A durable creator lineage, the same one an agent caller carries. */
function seedCallerPath(): string {
  const store = agentRegistry();
  const begun = beginLegacySpawnFixture(store, {
    engine: "codex",
    cwd: repoDir,
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
    cwd: repoDir,
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
    headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1:8898", "content-type": "application/json" },
    body: JSON.stringify({ task, spec: task, repoDir, src: callerPath, autoStart: false, stages: [] }),
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

  expect(first.status, await first.clone().text()).toBe(201);
  expect(second.status, await second.clone().text()).toBe(201);
  expect(pipelinesNamed("http race a")).toHaveLength(1);
  expect(pipelinesNamed("http race b")).toHaveLength(1);
});

test("a create refused on the lock is queued, stores nothing yet, and is stored once by the controller (#1766, #1835)", async () => {
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "200";
  const releaseLease = await holdRegistryLease();
  const task = "http busy refusal";

  const body = await (async () => {
    const startedAt = Date.now();
    const queued = await POST(createRequest(task));
    const elapsed = Date.now() - startedAt;

    expect(queued.status, await queued.clone().text()).toBe(202);
    const body = await queued.json() as { ok: boolean; pipeline: { id: string }; queued?: { reason: string; queuedAt: string } };
    const stored = queuedPipelineCreationStatus(body.pipeline.id);
    expect(stored?.state).toBe("queued");
    if (stored?.state !== "queued") throw new Error("expected a durable queued creation");
    expect(stored.reason).not.toBe("");
    expect(body).toMatchObject({ ok: true, queued: { reason: stored.reason, queuedAt: stored.queuedAt } });
    expect(pipelinesNamed(task)).toEqual([]);
    /* It waited for the lock: the store gives up only once its own clock has
       passed the configured wait. The wait was bounded: the request answered
       while the lease was still held by someone else, released below. */
    expect(elapsed).toBeGreaterThanOrEqual(200);
    return body;
  })().finally(releaseLease);

  await tickPipelinesController([]);
  expect(pipelinesNamed(task)).toEqual([body.pipeline.id]);
  await tickPipelinesController([]);
  expect(pipelinesNamed(task)).toEqual([body.pipeline.id]);
});
