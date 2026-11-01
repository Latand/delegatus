import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { setDeploymentRuntimeForTests } from "@/lib/runtime/deploymentRuntime";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";

import { productionDeps, setSelfUpdateServiceForTests } from "@/lib/selfUpdate/instance";
import { SelfUpdateService } from "@/lib/selfUpdate/service";
import { POST } from "./route";
import { beginSeatDeployment, seatDeploymentsFile, seatDeploymentsFor } from "@/lib/orchestrator/seatDeployments";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { serveRuntimeHost } from "@/runtime-host/socket";
import { testEndpoint } from "@/runtime-host/fixtures/testEndpoint";

/**
 * The HTTP deploy door, at parity with the MCP binding and the raw socket
 * (#795): the same request shape — one full commit SHA and an idempotency key —
 * forwarded to the same serialized admission. The deploy DECISION belongs to
 * the designated agent and is enforced at the deploy binding from
 * server-attributed identity; no confirmation proof exists anywhere for this
 * route to forward or verify.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
const originalSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const originalRollback = process.env.LLV_RUNTIME_EVENTS;

let requested: { revision?: string; ref?: string; idempotencyKey: string }[] = [];

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployments-route-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  /* The endpoint stands down entirely when the events plane is off, so the
     handler below is only reachable with a socket configured. */
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(dir, "runtime.sock");
  delete process.env.LLV_RUNTIME_EVENTS;
  setSelfUpdateServiceForTests(new SelfUpdateService({ ...productionDeps(), mode: async () => ({ mode: "managed", record: null, reason: null }) }));
  requested = [];
  setDeploymentRuntimeForTests(async (request) => {
    requested.push(request);
    return { deploymentId: "deployment_1", revision: request.revision ?? "a".repeat(40), state: "accepted", replayed: false };
  });
});

afterEach(() => {
  closeAgentRegistryForTests();
  setSelfUpdateServiceForTests(null);
  setDeploymentRuntimeForTests(null);
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = originalSocket;
  if (originalRollback === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = originalRollback;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

function deployRequest(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/deployments", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.serial("HTTP deployment route", () => {
test.each(["adopted", "rejected", "revoked-during-admission"] as const)("attributable deployment rechecks proactive authority: %s", async phase => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority } = await import("@/lib/tasks/proactive.fixture");
  const { agentRegistry } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const project = `deploy-${phase}`;
  const { task } = await admitProactiveTask({ ...candidate(`deploy-${phase}`), project }, { ...context(), project }, undefined, authority());
  await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task));
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: sandboxes[0]!, taskIds: [task.id], origin: { kind: "operator" } });
  if (begun.kind !== "created") throw new Error("expected a fresh launch");
  const capability = registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
  const reject = () => decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(task));
  if (phase === "rejected") await reject();
  if (phase === "revoked-during-admission") setSelfUpdateServiceForTests(new SelfUpdateService({ ...productionDeps(), mode: async () => {
    await reject();
    return { mode: "managed", record: null, reason: null };
  } }));
  const request = deployRequest({ revision: SHA, idempotencyKey: `proactive-${phase}` });
  request.headers.set("x-llv-spawn-capability", capability);
  const response = await POST(request);
  expect(response.status).toBe(phase === "adopted" ? 202 : 403);
  expect(requested).toHaveLength(phase === "adopted" ? 1 : 0);
});

test.each([false, true])("managed deployment rechecks attributable authority after socket admission: revoked %s", async revoked => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority } = await import("@/lib/tasks/proactive.fixture");
  const { agentRegistry } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const project = `managed-queue-${revoked}`;
  const { task } = await admitProactiveTask({ ...candidate(project), project }, { ...context(), project }, undefined, authority());
  const adopt = () => decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task));
  await adopt();
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: sandboxes[0]!, taskIds: [task.id], origin: { kind: "operator" } });
  if (begun.kind !== "created") throw new Error("expected a fresh launch");
  const capability = registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
  const endpoint = testEndpoint(sandboxes[0]!, "managed-queue");
  process.env.LLV_RUNTIME_HOST_SOCKET = endpoint;
  setDeploymentRuntimeForTests(null);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let saturated!: () => void;
  const ready = new Promise<void>(resolve => { saturated = resolve; });
  let reads = 0;
  const deployments: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = serveRuntimeHost(endpoint, { handle: async request => {
    if (request.method === "files-revision") {
      if (++reads === 4) saturated();
      if (reads <= 4) await gate;
      return { id: request.id, ok: true, result: 1 };
    }
    deployments.push(request.method);
    return { id: request.id, ok: true, result: { deploymentId: "managed-queued", revision: SHA, state: "accepted", replayed: false } };
  } });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const client = new UnixRuntimeHostClient(endpoint);
  const active: Promise<number>[] = [];
  let response: Promise<Response> | undefined;
  let queued!: () => void;
  const waiting = new Promise<void>(resolve => { queued = resolve; });
  const original = UnixRuntimeHostClient.prototype.requestViewerDeployment;
  const dispatch = spyOn(UnixRuntimeHostClient.prototype, "requestViewerDeployment").mockImplementation(function(this: UnixRuntimeHostClient, request, authorize) {
    const result = original.call(this, request, authorize);
    queued();
    return result;
  });
  const request = () => {
    const input = deployRequest({ revision: SHA, idempotencyKey: project });
    input.headers.set("x-llv-spawn-capability", capability);
    return input;
  };
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    active.push(...Array.from({ length: 4 }, () => client.filesRevision()));
    await ready;
    response = POST(request());
    await waiting;
    expect(deployments).toEqual([]);
    if (revoked) await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(task));
    release();
    const answer = await response;
    expect(answer.status).toBe(revoked ? 403 : 202);
    if (revoked) expect(await answer.json()).toMatchObject({ error: "invented work was rejected by the operator" });
    expect(deployments).toHaveLength(revoked ? 0 : 1);
    await Promise.all(active);
    expect(await client.filesRevision()).toBe(1);
    if (revoked) {
      await adopt();
      expect((await POST(request())).status).toBe(202);
      expect(deployments).toEqual(["viewer-deployment-request"]);
    }
  } finally {
    release();
    await Promise.allSettled([...active, ...(response ? [response] : [])]);
    dispatch.mockRestore();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("admission records the pending seat before a lost HTTP reply, including checkout installs", async () => {
  for (const mode of ["managed", "checkout"] as const) {
    const key = `lost-${mode}`;
    await beginSeatDeployment({ conversationId: `seat-${mode}`, project: "viewer", revision: SHA,
      requestedAt: "2026-10-19T12:00:00Z", idempotencyKey: key });
    const service = new SelfUpdateService({ ...productionDeps(), mode: async () => ({ mode, record: null, reason: null }) });
    if (mode === "checkout") service.deployRevision = async () => ({
      state: "accepted", deploymentId: "checkout-admitted", revision: SHA, replayed: false,
    });
    setSelfUpdateServiceForTests(service);
    // The handler finishes after the caller gives up; nobody consumes its reply.
    await POST(deployRequest({ revision: SHA, idempotencyKey: key }));
    expect(seatDeploymentsFor(`seat-${mode}`)).toMatchObject([{
      deploymentId: mode === "managed" ? "deployment_1" : "checkout-admitted", idempotencyKey: key,
    }]);
  }
});

test("a same-SHA busy HTTP join durably binds its own key to the admitted deployment", async () => {
  const seat = "joining-seat";
  await beginSeatDeployment({ conversationId: seat, project: "viewer", revision: SHA,
    requestedAt: "2026-10-19T12:00:00Z", idempotencyKey: "joining-original-key" });
  await POST(deployRequest({ revision: SHA, idempotencyKey: "joining-original-key" }));
  const original = seatDeploymentsFor(seat).find(record => record.deploymentId === "deployment_1");
  expect(original?.idempotencyKey).toBe("joining-original-key");

  await beginSeatDeployment({ conversationId: seat, project: "viewer", revision: SHA,
    requestedAt: "2026-10-19T12:01:00Z", idempotencyKey: "joining-busy-key" });
  setDeploymentRuntimeForTests(async () => ({ state: "busy", deploymentId: "deployment_1", revision: SHA }));
  const response = await POST(deployRequest({ revision: SHA, idempotencyKey: "joining-busy-key" }));
  expect(response.status).toBe(409);
  expect(seatDeploymentsFor(seat).find(record => record.deploymentId === "deployment_1")?.idempotencyKeys)
    .toContain("joining-busy-key");
  expect(seatDeploymentsFor(seat).find(record => record.deploymentId === "deployment_1"))
    .toMatchObject({ idempotencyKeys: ["joining-original-key", "joining-busy-key"] });
});

test("HTTP admission cannot invent a seat or attach a different busy SHA", async () => {
  await POST(deployRequest({ revision: SHA, idempotencyKey: "no-pending-seat", conversationId: "forged-seat" }));
  expect(seatDeploymentsFor("forged-seat")).toEqual([]);
  await beginSeatDeployment({ conversationId: "waiting-seat", project: "viewer", revision: SHA,
    requestedAt: "2026-10-19T12:00:00Z", idempotencyKey: "different-sha-busy" });
  setDeploymentRuntimeForTests(async () => ({ state: "busy", deploymentId: "other-deployment", revision: "b".repeat(40) }));
  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "different-sha-busy" }))).status).toBe(409);
  expect(seatDeploymentsFor("waiting-seat")).toEqual([]);
});

test("an attribution write failure preserves the admitted HTTP response", async () => {
  const queuePath = `${seatDeploymentsFile()}.write-locks`;
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "fixture prevents attribution lock admission");
  const response = await POST(deployRequest({ revision: SHA, idempotencyKey: "attribution-unavailable" }));
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ state: "accepted", deploymentId: "deployment_1" });
  expect(requested).toEqual([{ revision: SHA, idempotencyKey: "attribution-unavailable" }]);
});

test("a well-formed exact-SHA request is forwarded to host admission as-is", async () => {
  const response = await POST(deployRequest({ revision: SHA, idempotencyKey: "k1" }));
  expect(response.status).toBe(202);
  expect(requested).toEqual([{ revision: SHA, idempotencyKey: "k1" }]);
});

test("an uppercase revision is normalized to the lowercase exact SHA", async () => {
  const response = await POST(deployRequest({ revision: SHA.toUpperCase(), idempotencyKey: "k1" }));
  expect(response.status).toBe(202);
  expect(requested).toEqual([{ revision: SHA, idempotencyKey: "k1" }]);
});

test("a canonical branch ref is forwarded for server-side resolution (#1033)", async () => {
  const response = await POST(deployRequest({ ref: "refs/heads/main", idempotencyKey: "k1" }));
  expect(response.status).toBe(202);
  expect(requested).toEqual([{ ref: "refs/heads/main", idempotencyKey: "k1" }]);
});

for (const [name, ref] of [
  ["a tag", "refs/tags/v1"],
  ["a remote-tracking ref", "refs/remotes/origin/main"],
  ["a bare branch name", "main"],
  ["parent traversal", "refs/heads/../../tags/v1"],
  ["an option-looking branch", "refs/heads/-upload-pack=touch"],
  ["a revision expression", "refs/heads/main~1"],
] as const) {
  test(`a ref outside the canonical repository's branches is refused: ${name}`, async () => {
    const response = await POST(deployRequest({ ref, idempotencyKey: "k1" }));
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("ref_invalid");
    expect(requested).toEqual([]);
  });
}

test("a request naming both a revision and a ref is refused rather than silently preferring one", async () => {
  const response = await POST(deployRequest({ revision: SHA, ref: "refs/heads/main", idempotencyKey: "k1" }));
  expect(response.status).toBe(400);
  expect((await response.json()).reason).toBe("target_ambiguous");
  expect(requested).toEqual([]);
});

test("a revision-less or non-commit deploy is refused while a short prefix reaches host resolution", async () => {
  expect((await POST(deployRequest({ idempotencyKey: "k1" }))).status).toBe(400);
  expect((await POST(deployRequest({ revision: "origin/main", idempotencyKey: "k3" }))).status).toBe(400);
  expect(requested).toEqual([]);
  expect((await POST(deployRequest({ revision: SHA.slice(0, 12), idempotencyKey: "k2" }))).status).toBe(202);
  expect(requested).toEqual([{ revision: SHA.slice(0, 12), idempotencyKey: "k2" }]);
});

test("the idempotencyKey requirement still holds", async () => {
  const response = await POST(deployRequest({ revision: SHA }));
  expect(response.status).toBe(400);
  expect(requested).toEqual([]);

  expect((await POST(deployRequest({ revision: SHA, idempotencyKey: "k1" }))).status).toBe(202);
});

test("a cross-origin browser is still refused before anything else is read", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/runtime/deployments", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ revision: SHA, idempotencyKey: "k1" }),
  }));
  expect(response.status).toBe(403);
  expect(requested).toEqual([]);
});

test("the deployment endpoint reserves the disabled message for explicit rollback", async () => {
  process.env.LLV_RUNTIME_EVENTS = "0";
  const rolledBack = await POST(deployRequest({}));
  expect(rolledBack.status).toBe(503);
  expect(await rolledBack.json()).toEqual({
    error: "runtime events are disabled",
    code: RUNTIME_PLANE_ABSENT,
  });

  delete process.env.LLV_RUNTIME_EVENTS;
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  setDeploymentRuntimeForTests(null);
  const absent = await POST(deployRequest({ revision: SHA, idempotencyKey: "missing-runtime" }));
  expect(absent.status).toBe(503);
  expect(await absent.json()).toEqual({
    error: "runtime host socket is unavailable",
    code: RUNTIME_PLANE_ABSENT,
  });
});
});
