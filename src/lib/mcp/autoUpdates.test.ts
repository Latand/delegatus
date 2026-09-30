import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";

import { POST as autoRoute } from "@/app/api/self-update/auto/route";
import { GET as snapshotRoute } from "@/app/api/self-update/route";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_ENV } from "@/lib/agent/spawnPolicy";
import {
  productionViewerControlDependencies,
  viewerMcpBindings,
  viewerMcpToolPolicy,
  type CallerAttribution,
  type ViewerMcpDomainDependencies,
} from "@/lib/mcp/bindings";
import { MemoryMcpReceiptStore, createMcpToolService, createViewerMcpServer } from "@/lib/mcp/server";
import { setSelfUpdateServiceForTests } from "@/lib/selfUpdate/instance";
import { SelfUpdateService, type ServiceDeps } from "@/lib/selfUpdate/service";
import type { Snapshot } from "@/lib/selfUpdate/types";

/**
 * auto_updates: the orchestrator seat switches automatic updates through MCP.
 *
 * The operator asked that the Delegatus project's designated seat turn
 * automatic updates on by itself. The Update dialog's switch posts to
 * `POST /api/self-update/auto`; the tool reaches the same route, so the one
 * `setAuto` of the web process changes, and the dialog, its "turned off
 * because…" state and the automatic-update controller read that one change.
 *
 * Everything is driven at its public boundary: an MCP client speaks the
 * protocol to the real tool registration and tool service, the real bindings
 * reach the Viewer over the production control transport, and a loopback
 * listener serves the exported route modules. The seam that keeps this off the
 * operator's machine is the self-update service itself, a managed-mode service
 * over a private directory whose deployment and check ports are stubs.
 */

const SEAT_ID = "conversation_11111111-1111-4111-8111-111111111111";
const WORKER_ID = "conversation_22222222-2222-4222-8222-222222222222";
const ROOT_ID = "conversation_33333333-3333-4333-8333-333333333333";
const OTHER_SEAT_ID = "conversation_44444444-4444-4444-8444-444444444444";
const DEPUTY_ID = "conversation_55555555-5555-4555-8555-555555555555";
const VIEWER_PROJECT = "repo-delegatus";
const OTHER_PROJECT = "repo-elsewhere";
const RELEASE = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

let sandbox = "";
let listener: ReturnType<typeof Bun.serve> | null = null;
let controlOrigin = "";
let routeRequests: { method: string; pathname: string }[] = [];
let service: SelfUpdateService | null = null;
let releaseTarget: { revision: string } | null = { revision: RELEASE };
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      routeRequests.push({ method: request.method, pathname: url.pathname });
      let answer: Response;
      if (url.pathname === "/api/self-update" && request.method === "GET") {
        answer = await snapshotRoute(new Request(url, { headers: request.headers }));
      } else if (url.pathname === "/api/self-update/auto" && request.method === "POST") {
        answer = await autoRoute(new NextRequest(url, { method: "POST", headers: request.headers, body: await request.text() }));
      } else {
        return Response.json({ error: `no route for ${request.method} ${url.pathname}` }, { status: 404 });
      }
      return new Response(await answer.text(), { status: answer.status, headers: { "content-type": "application/json" } });
    },
  });
  controlOrigin = `http://127.0.0.1:${listener.port}`;
});

afterAll(() => {
  listener?.stop(true);
  listener = null;
});

beforeEach(() => {
  for (const name of ["LLV_STATE_DIR", "LLV_VIEWER_CONTROL_URL", "LLV_VIEWER_DEPLOY_TARGET", "LLV_VIEWER_PORT", VIEWER_SPAWN_CAPABILITY_ENV]) saved[name] = process.env[name];
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-auto-updates-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  process.env.LLV_VIEWER_CONTROL_URL = controlOrigin;
  delete process.env.LLV_VIEWER_DEPLOY_TARGET;
  delete process.env.LLV_VIEWER_PORT;
  delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  /* The key the Viewer creates at startup; the MCP server tags its control
     requests with it, and the route verifies that tag. */
  ensureOperatorSpawnCapability();
  setCallerConversationResolverForTests(() => null);
  releaseTarget = { revision: RELEASE };
  service = new SelfUpdateService(serviceDeps(path.join(sandbox, "self-update")));
  setSelfUpdateServiceForTests(service);
  routeRequests = [];
});

afterEach(() => {
  setSelfUpdateServiceForTests(null);
  setCallerConversationResolverForTests(null);
  service = null;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function serviceDeps(dir: string): ServiceDeps {
  return {
    now: () => Date.now(),
    env: {},
    dir,
    remote: "https://github.com/example/delegatus.git",
    branch: "main",
    pollMinutes: 60,
    bun: "/opt/bun",
    mode: async () => ({ mode: "managed", reason: null, record: null }),
    check: async () => ({ ok: false, error: "fixture", installed: null }),
    describe: async (_repo, revision) => ({ version: "", sha: revision, short: revision.slice(0, 7), date: "" }),
    createRunner: () => { throw new Error("no runner in managed mode"); },
    requestRestart: () => { throw new Error("no restart in this fixture"); },
    processAlive: () => true,
    hostHealth: async () => null,
    requestDeployment: async () => { throw new Error("no deployment in this fixture"); },
    readDeployment: async () => null,
    findDeploymentByIdempotencyKey: async () => null,
    releaseTarget: () => releaseTarget,
    prepareCheckRepo: async () => path.join(dir, "check.git"),
    buildEnv: () => ({}),
    web: { pid: process.pid, port: null, startedAt: new Date().toISOString() },
    green: { read: async () => ({ state: "pending" }) } as unknown as NonNullable<ServiceDeps["green"]>,
  };
}

const SEAT: CallerAttribution = { kind: "manager", conversationId: SEAT_ID, role: "orchestrator" };
const GATEWAY: CallerAttribution = { kind: "gateway", conversationId: ROOT_ID, role: null };
const WORKER: CallerAttribution = { kind: "agent", conversationId: WORKER_ID, role: "builder" };
const UNIDENTIFIED: CallerAttribution = { kind: "unidentified", conversationId: null, role: null };
const OTHER_SEAT: CallerAttribution = { kind: "manager", conversationId: OTHER_SEAT_ID, role: "orchestrator" };
const DEPUTY: CallerAttribution = { kind: "manager", conversationId: SEAT_ID, role: "orchestrator", via: { deputy: DEPUTY_ID } };

/** The server-derived identity the caller would have, and the durable seat
    designations: the Delegatus project's seat and another project's seat. */
function domain(attribution: CallerAttribution, callerProject: string | null = null): ViewerMcpDomainDependencies {
  return {
    attentionAuthority: () => ({ kind: "unidentified" as const }),
    callerAttribution: () => attribution,
    callerProject: () => callerProject,
    viewerProjects: () => [VIEWER_PROJECT],
    authorizedSeats: () => [
      { conversationId: SEAT_ID, path: null, project: VIEWER_PROJECT },
      { conversationId: OTHER_SEAT_ID, path: null, project: OTHER_PROJECT },
    ],
  } as unknown as ViewerMcpDomainDependencies;
}

interface Session {
  call(args: Record<string, unknown>): Promise<{ failed: boolean; payload: Record<string, unknown> }>;
  description(): Promise<string>;
  close(): Promise<void>;
}

/** One MCP process: its own receipt store and protocol connection. */
async function session(attribution: CallerAttribution, callerProject: string | null = null): Promise<Session> {
  const dependencies = domain(attribution, callerProject);
  const tools = createMcpToolService(
    viewerMcpBindings(undefined, productionViewerControlDependencies(), dependencies),
    new MemoryMcpReceiptStore(),
    viewerMcpToolPolicy(dependencies),
  );
  const server = createViewerMcpServer(tools);
  const client = new Client({ name: "auto-updates-regression", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(args) {
      const result = await client.callTool({ name: "auto_updates", arguments: args });
      return { failed: result.isError === true, payload: (result.structuredContent ?? {}) as Record<string, unknown> };
    },
    async description() {
      return (await client.listTools()).tools.find((tool) => tool.name === "auto_updates")?.description ?? "";
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function once(attribution: CallerAttribution, args: Record<string, unknown>, callerProject: string | null = null) {
  const opened = await session(attribution, callerProject);
  try { return await opened.call(args); } finally { await opened.close(); }
}

/** What the Update dialog reads: the snapshot route, as the operator's page. */
async function dialog(): Promise<Snapshot> {
  const response = await fetch(new URL("/api/self-update", controlOrigin), { headers: { origin: controlOrigin, "sec-fetch-site": "same-origin" } });
  return await response.json() as Snapshot;
}

/** The dialog's own switch: the browser's POST, with no service tag. */
async function dialogSwitch(body: Record<string, unknown>): Promise<number> {
  const response = await fetch(new URL("/api/self-update/auto", controlOrigin), {
    method: "POST",
    headers: { origin: controlOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.status;
}

const autoFile = () => path.join(sandbox, "self-update", "auto.json");
const posts = () => routeRequests.filter((request) => request.method === "POST");

test("any caller reads the state the Update dialog shows, and a read changes nothing", async () => {
  for (const caller of [WORKER, UNIDENTIFIED, SEAT]) {
    const { failed, payload } = await once(caller, { clientRequestId: `read-${caller.kind}` });
    expect(failed).toBe(false);
    expect(payload).toMatchObject({ mode: "managed", availability: "available", enabled: false, off: null, phase: "idle", target: { sha: RELEASE, short: RELEASE.slice(0, 7) }, green: null, blockers: null, changedBy: null, recentChanges: [] });
  }
  expect(posts()).toEqual([]);
  expect(fs.existsSync(autoFile())).toBe(false);
});

test("the Delegatus seat turns automatic updates on and off, and the dialog and the record name it", async () => {
  const on = await once(SEAT, { clientRequestId: "seat-on", enabled: true });
  expect(on.failed).toBe(false);
  expect(on.payload).toMatchObject({ enabled: true, changedBy: { kind: "seat", conversationId: SEAT_ID, via: "mcp" } });
  expect(posts()).toEqual([{ method: "POST", pathname: "/api/self-update/auto" }]);

  /* The dialog reads the same service the tool changed, at once. */
  const afterOn = await dialog();
  expect(afterOn.auto).toMatchObject({ enabled: true, changedBy: { kind: "seat", conversationId: SEAT_ID, via: "mcp" } });
  expect(typeof afterOn.auto?.changedAt).toBe("string");
  expect(afterOn.history?.[0]).toMatchObject({ kind: "auto-on", by: "seat", writer: { kind: "seat", conversationId: SEAT_ID, via: "mcp" }, outcome: "done" });
  expect(afterOn.history?.[0]?.at).toBe(afterOn.auto?.changedAt ?? "");
  /* One state file: the switch the dialog and the controller read. */
  expect(JSON.parse(fs.readFileSync(autoFile(), "utf8"))).toMatchObject({ enabled: true, changedBy: { kind: "seat", conversationId: SEAT_ID } });

  const off = await once(SEAT, { clientRequestId: "seat-off", enabled: false });
  expect(off.failed).toBe(false);
  expect(off.payload).toMatchObject({ enabled: false, changedBy: { kind: "seat", conversationId: SEAT_ID, via: "mcp" } });
  const afterOff = await dialog();
  expect(afterOff.auto?.enabled).toBe(false);
  expect(afterOff.history?.slice(0, 2).map((entry) => [entry.kind, entry.by, entry.writer?.conversationId])).toEqual([
    ["auto-off", "seat", SEAT_ID],
    ["auto-on", "seat", SEAT_ID],
  ]);
});

test("the operator's own session writes, recorded as the operator", async () => {
  const { failed, payload } = await once(GATEWAY, { clientRequestId: "root-on", enabled: true });
  expect(failed).toBe(false);
  expect(payload).toMatchObject({ enabled: true, changedBy: { kind: "operator", conversationId: ROOT_ID, via: "mcp" } });
  expect((await dialog()).history?.[0]).toMatchObject({ kind: "auto-on", by: "operator", writer: { kind: "operator", conversationId: ROOT_ID, via: "mcp" } });
});

test.each([
  ["a worker", WORKER, null, "not-designated"],
  ["an unidentified caller", UNIDENTIFIED, null, "not-designated"],
  ["another project's seat", OTHER_SEAT, null, "foreign-project"],
  ["the seat acting from another project", SEAT, OTHER_PROJECT, "cross-project"],
  ["the seat's parallel self", DEPUTY, null, "deputy"],
] as const)("%s is refused by name before anything changes", async (_label, caller, callerProject, reason) => {
  const { failed, payload } = await once(caller, { clientRequestId: `refused-${reason}`, enabled: true }, callerProject);
  expect(failed).toBe(true);
  expect(payload).toMatchObject({ ok: false, details: { code: "auto_updates_write_refused", reason } });
  expect(posts()).toEqual([]);
  expect(fs.existsSync(autoFile())).toBe(false);
  expect((await dialog()).auto?.enabled).toBe(false);
});

test("a replayed clientRequestId answers the first write and writes nothing again", async () => {
  const opened = await session(SEAT);
  try {
    const first = await opened.call({ clientRequestId: "seat-on-once", enabled: true });
    await dialogSwitch({ enabled: false });
    const replay = await opened.call({ clientRequestId: "seat-on-once", enabled: true });
    expect(replay.failed).toBe(false);
    expect(replay.payload).toMatchObject({ enabled: true, replayed: true });
    expect(first.payload.changedAt).toBe(replay.payload.changedAt);
  } finally {
    await opened.close();
  }
  expect(posts().filter((request) => request.pathname === "/api/self-update/auto")).toHaveLength(2);
  const view = await dialog();
  expect(view.auto?.enabled).toBe(false);
  expect(view.history?.filter((entry) => entry.kind === "auto-on")).toHaveLength(1);
});

test("an install that cannot update itself refuses the seat's enable, and nothing is written", async () => {
  releaseTarget = null;
  const { failed, payload } = await once(SEAT, { clientRequestId: "seat-on-unavailable", enabled: true });
  expect(failed).toBe(true);
  expect(payload).toMatchObject({ ok: false, details: { code: "auto_updates_unavailable", availability: "no-release-target" } });
  expect(posts()).toEqual([]);
  expect(fs.existsSync(autoFile())).toBe(false);
  expect((await dialog()).history ?? []).toEqual([]);
});

test("the dialog's switch is recorded as the operator, and a writer claimed without the service tag is ignored", async () => {
  expect(await dialogSwitch({ enabled: true, writer: { kind: "seat", conversationId: SEAT_ID } })).toBe(202);
  const view = await dialog();
  expect(view.auto?.changedBy).toEqual({ kind: "operator", conversationId: null, via: "dialog" });
  expect(view.history?.[0]).toMatchObject({ kind: "auto-on", by: "operator", writer: { kind: "operator", conversationId: null, via: "dialog" } });
});

test("the registered description says what enabling does", async () => {
  const opened = await session(WORKER);
  const description = await opened.description().finally(() => opened.close());
  expect(description).toContain("main");
  expect(description).toContain("green");
  expect(description).toContain("quiet");
  expect(description).toContain("rolls back");
  expect(description).toContain("switch themselves off");
  expect(description).toContain("auto_updates_write_refused");
});
