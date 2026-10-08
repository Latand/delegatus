import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { GET as GET_DEPLOYMENT } from "@/app/api/runtime/deployments/[deploymentId]/route";
import { GET as GET_LIST } from "@/app/api/runtime/deployments/route";
import { RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { viewerDeploymentListCursor, type ViewerDeploymentStatus } from "@/lib/runtime/contracts";
import { productionDeps, setSelfUpdateServiceForTests } from "@/lib/selfUpdate/instance";
import { SelfUpdateService } from "@/lib/selfUpdate/service";
import type { InstallMode } from "@/lib/selfUpdate/types";

import { viewerMcpBindings, type ViewerControlDependencies } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore } from "./server";

/* deployment_status end to end: the MCP binding through the production Viewer
   control adapter, into the real list and lookup routes, and from there into a
   checkout install's ledger or a runtime host on a private socket. Everything
   lives under a temp sandbox; the control URL is the fixture's own port. */

const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_VIEWER_DEPLOY_TARGET", "LLV_VIEWER_CONTROL_URL",
  "LLV_VIEWER_PORT", "LLV_TOKEN", "LLV_RUNTIME_EVENTS", "LLV_RUNTIME_HOST_SOCKET", "LLV_RUNTIME_JOURNAL"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const sandboxes: string[] = [];
const stops: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  setSelfUpdateServiceForTests(null);
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

/** A Viewer whose control port serves the real deployment routes. */
async function installViewer(mode: InstallMode): Promise<string> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployment-pages-"));
  sandboxes.push(sandbox);
  const stateDirectory = path.join(sandbox, "state");
  fs.mkdirSync(path.join(stateDirectory, "self-update"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, "config"), { recursive: true });
  process.env.HOME = sandbox;
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  process.env.LLV_STATE_DIR = stateDirectory;
  delete process.env.LLV_TOKEN;
  delete process.env.LLV_RUNTIME_EVENTS;
  delete process.env.LLV_RUNTIME_JOURNAL;
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "absent.sock");
  setSelfUpdateServiceForTests(new SelfUpdateService({ ...productionDeps(), mode: async () => ({ mode, record: null, reason: null }) }));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const next = new NextRequest(url.href, { headers: { host: url.host } });
      if (url.pathname === "/api/runtime/deployments") return GET_LIST(next);
      const named = /^\/api\/runtime\/deployments\/([^/]+)$/.exec(url.pathname);
      if (named) return GET_DEPLOYMENT(next, { params: Promise.resolve({ deploymentId: decodeURIComponent(named[1]!) }) });
      return Response.json({ error: "not served" }, { status: 405 });
    },
  });
  stops.push(() => { server.stop(true); });
  if (server.port === 8898) throw new Error("the fixture Viewer selected the production port");
  const target = path.join(stateDirectory, "viewer-release.json");
  fs.writeFileSync(target, JSON.stringify({ revision: "f".repeat(40), image: "viewer:fixture", container: "viewer-fixture", endpoint: server.url.origin }));
  process.env.LLV_VIEWER_DEPLOY_TARGET = target;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  process.env.LLV_VIEWER_PORT = String(server.port);
  return stateDirectory;
}

function checkoutRow(index: number): ViewerDeploymentStatus {
  const at = `2026-10-0${index}T09:00:00.000Z`;
  return {
    deploymentId: `checkout-${index}`, idempotencyKey: `key-${index}`, requestedRevision: String(index).repeat(40), revision: String(index).repeat(40),
    phase: "succeeded", terminal: true, candidate: null, previous: null,
    mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, health: [], error: null,
    owner: { pid: 4242, startIdentity: "fixture" }, createdAt: at, updatedAt: at, revisionNumber: 2,
  };
}

function writeCheckoutLedger(stateDirectory: string, rows: ViewerDeploymentStatus[]): void {
  fs.writeFileSync(path.join(stateDirectory, "self-update", "deployments.json"), JSON.stringify(rows));
}

function summary(row: ViewerDeploymentStatus) {
  return { deploymentId: row.deploymentId, phase: row.phase, sha: row.revision, terminal: row.terminal,
    startedAt: row.createdAt, finishedAt: row.updatedAt, error: null };
}

/** A runtime host on a private socket that answers each request with `answer`. */
async function serveRuntimeHost(answer: (method: string, params: Record<string, unknown>) => { ok: true; result: unknown } | { ok: false; error: string }): Promise<Array<Record<string, unknown>>> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deployment-pages-host-"));
  sandboxes.push(sandbox);
  const socketPath = path.join(sandbox, "runtime.sock");
  const lists: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let frame = "";
    socket.on("data", (chunk) => {
      frame += String(chunk);
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(frame.slice(0, newline)) as { id: string; method: string; params?: Record<string, unknown> };
      if (request.method === "viewer-deployment-list") lists.push(request.params ?? {});
      socket.end(`${JSON.stringify({ id: request.id, ...answer(request.method, request.params ?? {}) })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  stops.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  return lists;
}

function service() {
  return createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore());
}

test("a checkout install with an empty ledger answers an empty terminal page", async () => {
  const state = await installViewer("checkout");
  writeCheckoutLedger(state, []);

  expect(await viewerMcpBindings().deployment_status({ clientRequestId: "checkout-empty", compact: true, limit: 3 }))
    .toEqual({ count: 0, deployments: [], nextCursor: null, hasMore: false });
});

test("a checkout install pages its ledger newest first, continues from the cursor and ends on a terminal page", async () => {
  const state = await installViewer("checkout");
  const rows = [1, 2, 3, 4, 5].map(checkoutRow);
  writeCheckoutLedger(state, rows);
  const bindings = viewerMcpBindings();

  const first = await bindings.deployment_status({ clientRequestId: "checkout-page-1", compact: true, limit: 2 }) as Record<string, unknown>;
  expect(first).toMatchObject({ count: 2, deployments: [summary(rows[4]!), summary(rows[3]!)], hasMore: true });
  expect(typeof first.nextCursor).toBe("string");

  const second = await bindings.deployment_status({ clientRequestId: "checkout-page-2", compact: true, limit: 2, cursor: first.nextCursor }) as Record<string, unknown>;
  expect(second).toMatchObject({ count: 2, deployments: [summary(rows[2]!), summary(rows[1]!)], hasMore: true });
  expect(typeof second.nextCursor).toBe("string");

  expect(await bindings.deployment_status({ clientRequestId: "checkout-page-3", compact: true, limit: 2, cursor: second.nextCursor }))
    .toEqual({ count: 1, deployments: [summary(rows[0]!)], nextCursor: null, hasMore: false });
});

test("a packaged install's full list is the same bounded page with full records", async () => {
  const state = await installViewer("package");
  const rows = [1, 2, 3].map(checkoutRow);
  writeCheckoutLedger(state, rows);

  const page = await viewerMcpBindings().deployment_status({ clientRequestId: "package-full", limit: 3 });
  expect(page).toEqual({ count: 3, deployments: [rows[2], rows[1], rows[0]], nextCursor: null, hasMore: false });
});

test("a checkout install refuses a cursor it cannot read instead of repeating page one", async () => {
  const state = await installViewer("checkout");
  writeCheckoutLedger(state, [checkoutRow(1)]);

  const answer = await service().callTool("deployment_status", { clientRequestId: "checkout-bad-cursor", cursor: "not-a-cursor" });
  expect(answer).toMatchObject({ ok: false, error: "deployment list cursor is invalid", details: { status: 400 } });
});

test("a checkout install's named lookup keeps answering from its ledger", async () => {
  const state = await installViewer("checkout");
  const rows = [1, 2].map(checkoutRow);
  writeCheckoutLedger(state, rows);

  expect(await viewerMcpBindings().deployment_status({ clientRequestId: "checkout-named", deploymentId: "checkout-2", compact: true }))
    .toEqual({ deploymentId: "checkout-2", deployment: expect.objectContaining({ deploymentId: "checkout-2", phase: "succeeded" }) });
});

test("an unreadable checkout ledger is named as unavailable, never as malformed pagination", async () => {
  const state = await installViewer("checkout");
  fs.writeFileSync(path.join(state, "self-update", "deployments.json"), "{ torn");

  const answer = await service().callTool("deployment_status", { clientRequestId: "checkout-unreadable", compact: true, limit: 3 }) as Record<string, unknown>;
  expect(answer).toMatchObject({ ok: false, details: { status: 503 } });
  expect(String(answer.error)).not.toContain("malformed");
});

/* The managed install reads its runtime host. The host's own pages already
   carried both fields; these hold that shape through the whole chain. */
test("a managed install passes the host's empty, continued and terminal pages through unchanged", async () => {
  await installViewer("managed");
  const rows = [3, 2, 1].map(index => summary(checkoutRow(index)));
  const next = viewerDeploymentListCursor(Date.parse(rows[1]!.startedAt), rows[1]!.deploymentId);
  const pages: Record<string, { deployments: unknown[]; nextCursor: string | null; hasMore: boolean }> = {
    "": { deployments: rows.slice(0, 2), nextCursor: next, hasMore: true },
    [next]: { deployments: rows.slice(2), nextCursor: null, hasMore: false },
    "empty": { deployments: [], nextCursor: null, hasMore: false },
  };
  const lists = await serveRuntimeHost((method, params) => method === "viewer-deployment-list"
    ? { ok: true, result: params.limit === 9 ? pages.empty : pages[String(params.cursor ?? "")] }
    : { ok: false, error: "runtime request method is unsupported" });
  const bindings = viewerMcpBindings();

  expect(await bindings.deployment_status({ clientRequestId: "managed-1", compact: true, limit: 2 }))
    .toMatchObject({ count: 2, deployments: rows.slice(0, 2), nextCursor: next, hasMore: true });
  expect(await bindings.deployment_status({ clientRequestId: "managed-2", compact: true, limit: 2, cursor: next }))
    .toMatchObject({ count: 1, deployments: rows.slice(2), nextCursor: null, hasMore: false });
  expect(await bindings.deployment_status({ clientRequestId: "managed-empty", compact: true, limit: 9 }))
    .toMatchObject({ count: 0, deployments: [], nextCursor: null, hasMore: false });
  expect(lists).toEqual([{ limit: 2, compact: true }, { limit: 2, cursor: next, compact: true }, { limit: 9, compact: true }]);
});

test("a runtime host without deployments says so in plain words on a named lookup", async () => {
  await installViewer("unsupported");
  await serveRuntimeHost(() => ({ ok: false, error: "viewer deployments are disabled" }));

  const answer = await service().callTool("deployment_status", { clientRequestId: "named-disabled", deploymentId: "deployment_1" });
  expect(answer).toMatchObject({ ok: false, error: "viewer deployments are disabled", details: { status: 503 } });
});

test("an absent runtime plane and an unreachable host are named, never read as malformed pagination", async () => {
  await installViewer("managed");
  process.env.LLV_RUNTIME_EVENTS = "0";
  expect(await service().callTool("deployment_status", { clientRequestId: "plane-absent", compact: true, limit: 3 }))
    .toMatchObject({ ok: false, error: "runtime events are disabled", details: { code: RUNTIME_PLANE_ABSENT, status: 503 } });

  delete process.env.LLV_RUNTIME_EVENTS;
  await serveRuntimeHost(() => ({ ok: false, error: "runtime host is unavailable" }));
  expect(await service().callTool("deployment_status", { clientRequestId: "host-unavailable", compact: true, limit: 3 }))
    .toMatchObject({ ok: false, error: "runtime host is unavailable", details: { status: 503 } });
});

/* The answer a checkout Viewer at 2fda8a4e still gives while a newer MCP
   server reads it: a terminal page that names no cursor and omits hasMore. */
test("a Viewer page with a null cursor and no hasMore reads as a terminal page", async () => {
  const row = { deploymentId: "checkout-legacy", phase: "succeeded", revision: "a".repeat(40) };
  const control: ViewerControlDependencies = {
    async get() { return { count: 1, deployments: [row], nextCursor: null }; },
    async post() { throw new Error("unexpected write"); },
  };
  expect(await viewerMcpBindings(undefined, control).deployment_status({ clientRequestId: "legacy-terminal", limit: 3 }))
    .toEqual({ count: 1, deployments: [row], nextCursor: null, hasMore: false });
});

test("a Viewer page whose hasMore contradicts its cursor is still refused", async () => {
  const control: ViewerControlDependencies = {
    async get() { return { count: 0, deployments: [], nextCursor: "next", hasMore: false }; },
    async post() { throw new Error("unexpected write"); },
  };
  await expect(viewerMcpBindings(undefined, control).deployment_status({ clientRequestId: "contradiction" }))
    .rejects.toThrow("malformed deployment pagination");
});

/* That same Viewer ignores a cursor and answers page one again in the same
   shape, so a continuation read from it is refused instead of repeating rows. */
test("a continuation answered with a null cursor and no hasMore is refused as unavailable pagination", async () => {
  const rows = [3, 2].map(index => checkoutRow(index));
  const requested: string[] = [];
  const control: ViewerControlDependencies = {
    async get(route) { requested.push(route); return { count: 2, deployments: rows, nextCursor: null }; },
    async post() { throw new Error("unexpected write"); },
  };
  const cursor = viewerDeploymentListCursor(Date.parse(rows[1]!.createdAt), rows[1]!.deploymentId);

  await expect(viewerMcpBindings(undefined, control).deployment_status({ clientRequestId: "legacy-continuation", limit: 2, cursor }))
    .rejects.toThrow("pagination is unavailable");
  expect(requested).toEqual([`/api/runtime/deployments?limit=2&cursor=${encodeURIComponent(cursor)}`]);
});

test("a continuation answered with an explicit terminal page still reads as the last page", async () => {
  const row = checkoutRow(1);
  const control: ViewerControlDependencies = {
    async get() { return { count: 1, deployments: [row], nextCursor: null, hasMore: false }; },
    async post() { throw new Error("unexpected write"); },
  };
  const cursor = viewerDeploymentListCursor(Date.parse(checkoutRow(2).createdAt), "checkout-2");

  expect(await viewerMcpBindings(undefined, control).deployment_status({ clientRequestId: "modern-terminal", limit: 2, cursor }))
    .toEqual({ count: 1, deployments: [row], nextCursor: null, hasMore: false });
});
