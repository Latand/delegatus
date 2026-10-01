import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { isAgentInitiatedSpawn, spawnLineageSelectorForCaller } from "@/app/api/spawn/admission";
import { POST as spawnAdmissionPost } from "@/app/api/spawn/validate/route";
import { executeSpawnAdmissionValidation } from "@/lib/agent/spawnAdmissionValidation";
import { AgentRegistry } from "@/lib/agent/registry";
import { readSpawnAdmissionFence } from "@/lib/agent/spawnAdmission";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { executeSpawnRequest, type SpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import { resolveSpawnLineage } from "@/lib/agent/spawnParent";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { projectForCwd } from "@/lib/scanner/describe";
import type { BoardTask } from "@/lib/tasks/types";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { directoryProjectId } from "@/lib/projects/identity";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectSuccessionFor, recordProjectSuccessions } from "@/lib/projects/succession";

import {
  productionDomainDependencies,
  viewerMcpBindings,
  viewerMcpRecoverableTools,
  type ViewerControlDependencies,
  type ViewerMcpDomainDependencies,
} from "./bindings";
import {
  createMcpToolService,
  McpDispatchVerdictError,
  MemoryMcpReceiptStore,
  SqliteMcpReceiptStore,
  type McpRecoveryReceiptStore,
  type McpRequestBinding,
  type McpToolCallContext,
} from "./server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-spawn-recovery-integration-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const previousHome = process.env.HOME;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
const previousStructuredHosts = process.env.LLV_STRUCTURED_HOSTS;
const previousRuntimeEvents = process.env.LLV_RUNTIME_EVENTS;
const previousRuntimeSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
const previousRuntimeUi = process.env.NEXT_PUBLIC_RUNTIME_UI;
const previousCodexBinary = process.env.LLV_CODEX_BINARY;
const codexBinary = path.join(sandbox, "codex-list");
fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.HOME = path.join(sandbox, "home");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_SPAWN_TRANSPORT = "structured";
process.env.LLV_STRUCTURED_HOSTS = "1";
process.env.LLV_RUNTIME_EVENTS = "1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
process.env.LLV_CODEX_BINARY = codexBinary;

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
  else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
  if (previousStructuredHosts === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
  else process.env.LLV_STRUCTURED_HOSTS = previousStructuredHosts;
  if (previousRuntimeEvents === undefined) delete process.env.LLV_RUNTIME_EVENTS;
  else process.env.LLV_RUNTIME_EVENTS = previousRuntimeEvents;
  if (previousRuntimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = previousRuntimeSocket;
  if (previousRuntimeUi === undefined) delete process.env.NEXT_PUBLIC_RUNTIME_UI;
  else process.env.NEXT_PUBLIC_RUNTIME_UI = previousRuntimeUi;
  if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
  else process.env.LLV_CODEX_BINARY = previousCodexBinary;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function routeRequest(pathname: string, body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://127.0.0.1:8898${pathname}`, {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:8898",
      host: "127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function spawnDependencies(registry: AgentRegistry, cwd: string): SpawnCommandDependencies {
  const account = {
    engine: "codex" as const,
    accountId: "codex-test",
    kind: "managed" as const,
    home: path.join(cwd, "account"),
    transcriptRoot: path.join(cwd, "projects"),
    env: { NODE_ENV: "test" as const },
  };
  return {
    registry: () => registry,
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    assertStructuredRuntime: () => {},
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: () => {},
    storeImages: () => [],
    spawnStructuredConversation: async () => {
      throw new Error("the fenced spawn must not reach structured launch");
    },
  };
}

function domainDependencies(registry: AgentRegistry, validate = true): ViewerMcpDomainDependencies {
  return {
    registrySnapshot: () => registry.readOnlySnapshot(),
    readSpawnAdmissionFence,
    attentionAuthority: () => ({ kind: "root", conversationId: null, role: null }),
    ...(validate ? {
      validateSpawnAdmission: async (body: Record<string, unknown>, _context?: McpToolCallContext) => {
        const response = await executeSpawnAdmissionValidation(
          routeRequest("/api/spawn/validate", body),
          { registry: () => registry },
        );
        return await response.json() as Record<string, unknown>;
      },
    } : {}),
  } as unknown as ViewerMcpDomainDependencies;
}

function routeControl(dependencies: SpawnCommandDependencies, dispatches: { count: number }): ViewerControlDependencies {
  return {
    post: async () => { throw new Error("unexpected non-dispatch control call"); },
    dispatch: async (pathname, body, headers, context) => {
      if (pathname !== "/api/spawn") throw new Error(`unexpected control path: ${pathname}`);
      dispatches.count += 1;
      if (context?.dispatch) context.dispatch.attempted = true;
      const response = await executeSpawnRequest(routeRequest(pathname, body, headers), dependencies);
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        throw new McpDispatchVerdictError(String(payload.error ?? "spawn refused"), {
          status: response.status,
          ...(typeof payload.code === "string" ? { code: payload.code } : {}),
        });
      }
      return payload;
    },
  };
}

function service(
  registry: AgentRegistry,
  store: McpRecoveryReceiptStore,
  control: ViewerControlDependencies,
  domain: ViewerMcpDomainDependencies,
) {
  return createMcpToolService(
    viewerMcpBindings(undefined, control, domain),
    store,
    undefined,
    { recovery: viewerMcpRecoverableTools(domain) },
  );
}

function spawnArgs(clientRequestId: string, cwd: string): Record<string, unknown> {
  return {
    clientRequestId,
    role: "deployer",
    roleParams: { sha: "a".repeat(40), pr: "26" },
    cwd,
    ["prompt"]: "launch the dev deployer",
    title: "Rejected deployer integration",
  };
}

test("a foreign task refuses before the MCP claim and dispatch, and a corrected task can reuse the request id", async () => {
  const cwd = path.join(sandbox, "task-project-target");
  fs.mkdirSync(cwd, { recursive: true });
  const project = projectForCwd(cwd)!;
  const foreignProject = "dir-" + "f".repeat(32);
  const tasks = [
    { id: "foreign-task", project: foreignProject, assignments: [] },
    { id: "target-task", project, assignments: [] },
  ] as unknown as BoardTask[];
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const store = new MemoryMcpReceiptStore();
  let dispatches = 0;
  const control: ViewerControlDependencies = {
    post: async () => {
      dispatches += 1;
      return { launchId: "launch_target_task", conversationId: "conversation_target_task", state: "starting", initialMessage: "pending" };
    },
  };
  const domain = { ...domainDependencies(registry), loadTasks: () => tasks };
  const live = service(registry, store, control, domain);
  const args = { clientRequestId: "task-project-retry", cwd, title: "Build target task", prompt: "Build target task", taskId: "foreign-task" };
  const refused = await live.callTool("spawn_agent", args);
  expect(refused).toMatchObject({ ok: false, code: "invalid_request", replayed: false });
  expect(refused.error).toContain(foreignProject);
  expect(refused.error).toContain(project);
  expect(refused.error).toContain("target project's board");
  expect(refused.error).toContain("omit taskId");
  expect(await store.lookup(`spawn_agent:${args.clientRequestId}`)).toBeNull();
  expect(dispatches).toBe(0);
  expect(registry.readOnlySnapshot().receipts).toEqual({});
  expect(readSpawnAdmissionFence("mcp_spawn_" + crypto.createHash("sha256").update(args.clientRequestId).digest("hex"))).toBeNull();
  expect(tasks.map(task => task.assignments)).toEqual([[], []]);

  expect(await live.callTool("spawn_agent", { ...args, taskId: "target-task" })).toMatchObject({ ok: true, replayed: false });
  expect(dispatches).toBe(1);
});

test("HTTP spawn and validation refuse a foreign task without a receipt or fence", async () => {
  const cwd = path.join(sandbox, "http-task-project-target");
  fs.mkdirSync(cwd, { recursive: true });
  const project = "dir-" + "e".repeat(32);
  const now = new Date().toISOString();
  saveTasks([...loadTasks(), { id: "http-foreign-task", project, text: "Foreign task", status: "inbox", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now }]);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const body = { cwd, taskId: "http-foreign-task", engine: "codex", title: "Build target project", prompt: "Build target project", clientAttemptId: "http_task_project_retry" };
  const validation = await executeSpawnAdmissionValidation(routeRequest("/api/spawn/validate", body), { registry: () => registry });
  expect(await validation.json()).toMatchObject({ admissible: false, fenced: false, status: 400 });
  const response = await executeSpawnRequest(routeRequest("/api/spawn", body), spawnDependencies(registry, cwd));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain(project);
  expect(registry.readOnlySnapshot().receipts).toEqual({});
  expect(readSpawnAdmissionFence(body.clientAttemptId)).toBeNull();
  expect(loadTasks().find(task => task.id === body.taskId)?.assignments).toEqual([]);

  saveTasks([...loadTasks(), { id: "http-target-task", project: projectForCwd(cwd)!, text: "Target task", status: "inbox", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now }]);
  const corrected = { ...body, taskId: "http-target-task" };
  expect(await (await executeSpawnAdmissionValidation(routeRequest("/api/spawn/validate", corrected), { registry: () => registry })).json()).toMatchObject({ admissible: true, fenced: false });
  const admitted = await executeSpawnRequest(routeRequest("/api/spawn", corrected), spawnDependencies(registry, cwd));
  expect(admitted.status).toBe(202);
  expect(registry.spawnReceiptForClientAttempt(body.clientAttemptId)?.conversationId).toBeTruthy();
  expect(loadTasks().find(task => task.id === corrected.taskId)?.assignments).toHaveLength(1);
});

test("spawn admits a task under the folder's old directory key after repository succession, and omitting taskId reads no tasks", async () => {
  const cwd = path.join(sandbox, "task-project-succession");
  fs.mkdirSync(cwd, { recursive: true });
  const oldProject = directoryProjectId(cwd);
  expect(Bun.spawnSync(["git", "init", "--quiet", cwd]).exitCode).toBe(0);
  recordProjectSuccessions([projectSuccessionFor(oldProject, cwd)]);
  const project = projectForCwd(cwd)!;
  expect(project).toStartWith("repo-");
  expect(canonicalProject(oldProject)).toBe(project);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const store = new MemoryMcpReceiptStore();
  let taskReads = 0;
  let dispatches = 0;
  const domain = { ...domainDependencies(registry), loadTasks: () => {
    taskReads += 1;
    return [{ id: "old-folder-task", project: oldProject, assignments: [] }] as unknown as BoardTask[];
  } };
  const live = service(registry, store, { post: async () => {
    dispatches += 1;
    return { launchId: `launch_${dispatches}`, conversationId: `conversation_${dispatches}`, state: "starting", initialMessage: "pending" };
  } }, domain);
  const args = { clientRequestId: "old-folder-task-request", cwd, title: "Build folder task", prompt: "Build folder task", taskId: "old-folder-task" };
  expect(await live.callTool("spawn_agent", args)).toMatchObject({ ok: true, replayed: false });
  expect(taskReads).toBe(1);
  expect(await live.callTool("spawn_agent", { ...args, clientRequestId: "no-task-project-request", taskId: undefined })).toMatchObject({ ok: true, replayed: false });
  expect(taskReads).toBe(1);
  expect(dispatches).toBe(2);
});

test("task validation resolves a home-relative cwd the same way as spawn admission", async () => {
  const cwd = os.homedir();
  fs.mkdirSync(cwd, { recursive: true });
  const now = new Date().toISOString();
  saveTasks([...loadTasks(), { id: "home-task", project: projectForCwd(cwd)!, text: "Home task", status: "inbox", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now }]);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const response = await executeSpawnAdmissionValidation(routeRequest("/api/spawn/validate", { cwd: "~", taskId: "home-task" }), { registry: () => registry });
  expect(await response.json()).toMatchObject({ admissible: true, fenced: false });
});

test("a real post-wire HTTP 400 is fenced once and an existing stranded claim recovers without redispatch", async () => {
  const cwd = path.join(sandbox, "launch-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });

  const liveDispatches = { count: 0 };
  const liveStore = new MemoryMcpReceiptStore();
  const live = service(registry, liveStore, routeControl(spawnDependencies(registry, cwd), liveDispatches), domainDependencies(registry));
  const liveArgs = spawnArgs("spawn_post_wire_live_1", cwd);
  const liveAnswer = await live.callTool("spawn_agent", liveArgs);
  expect(liveAnswer).toMatchObject({
    ok: false,
    code: "not_executed",
    details: {
      outcome: "not-executed",
      evidence: "spawn-admission-fence",
      nextAction: "new-request-permitted",
    },
  });
  expect(liveDispatches.count).toBe(1);
  expect(registry.readOnlySnapshot().receipts).toEqual({});
  const liveDownstreamKey = "mcp_spawn_" + crypto.createHash("sha256").update(String(liveArgs.clientRequestId)).digest("hex");
  expect(readSpawnAdmissionFence(liveDownstreamKey)).toMatchObject({ status: 400 });
  expect(await live.callTool("spawn_agent", liveArgs)).toMatchObject({ ok: false, code: "not_executed", replayed: true });
  expect(liveDispatches.count).toBe(1);

  const historicalDispatches = { count: 0 };
  const historicalStore = new SqliteMcpReceiptStore(path.join(sandbox, "historical-receipts.sqlite"));
  const oldControl: ViewerControlDependencies = {
    post: async () => { throw new Error("unexpected old control call"); },
    dispatch: async (_pathname, _body, _headers, context) => {
      historicalDispatches.count += 1;
      if (context?.dispatch) context.dispatch.attempted = true;
      throw new McpDispatchVerdictError("deployer requires confirm: deploy", { status: 400 });
    },
  };
  const historicalArgs = spawnArgs("spawn_post_wire_stranded_1", cwd);
  const oldService = service(registry, historicalStore, oldControl, domainDependencies(registry, false));
  const oldAnswer = await oldService.callTool("spawn_agent", historicalArgs);
  expect(oldAnswer).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown" } });
  expect(historicalDispatches.count).toBe(1);
  const downstreamKey = "mcp_spawn_" + crypto.createHash("sha256").update(String(historicalArgs.clientRequestId)).digest("hex");
  const stranded = await historicalStore.lookup(`spawn_agent:${historicalArgs.clientRequestId}`);
  expect(stranded).toMatchObject({ stage: "dispatching", result: null });

  const recoveryDispatches = { count: 0 };
  const recovered = service(
    registry,
    historicalStore,
    {
      post: async () => { throw new Error("historical recovery must not dispatch"); },
      dispatch: async () => {
        recoveryDispatches.count += 1;
        throw new Error("historical recovery must not dispatch");
      },
    },
    domainDependencies(registry),
  );
  const recoveredAnswer = await recovered.callTool("spawn_agent", { ...historicalArgs, recoveryOnly: true });
  expect(recoveredAnswer).toMatchObject({
    ok: false,
    code: "not_executed",
    replayed: true,
    details: { outcome: "not-executed", evidence: "spawn-admission-fence" },
  });
  expect(recoveryDispatches.count).toBe(0);
  const closed = await historicalStore.lookup(`spawn_agent:${historicalArgs.clientRequestId}`);
  expect(closed).toMatchObject({ stage: "not-executed" });
  expect(closed?.digest).toBe(stranded?.digest);
  expect(closed?.binding).toEqual(stranded?.binding);
  expect(registry.readOnlySnapshot().receipts).toEqual({});
  expect(readSpawnAdmissionFence(downstreamKey)).toMatchObject({ status: 400 });
  historicalStore.close();
});

test("production recovery probes the exported validate route over HTTP with the dispatch capability", async () => {
  const cwd = path.join(sandbox, "http-probe-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const requests: { pathname: string; capability: string | null }[] = [];
  const viewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({
        pathname: new URL(request.url).pathname,
        capability: request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER),
      });
      return spawnAdmissionPost.withDependencies(
        new NextRequest(request),
        { registry: () => registry },
      );
    },
  });
  const previousControlUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = viewer.url.origin;
  try {
    const args = spawnArgs("spawn_post_wire_http_1", cwd);
    const tools = viewerMcpRecoverableTools({
      ...productionDomainDependencies,
      registrySnapshot: () => registry.readOnlySnapshot(),
      attentionAuthority: () => ({ kind: "root", conversationId: null, role: null }),
      recoveryPredecessors: () => [],
    });
    const bindingInput = await tools.spawn_agent!.bind(args);
    const binding: McpRequestBinding = {
      ...bindingInput,
      version: 1,
      toolName: "spawn_agent",
      clientRequestId: String(args.clientRequestId),
      owner: { pid: process.pid, startIdentity: null },
      claimedAt: new Date().toISOString(),
    };
    const recovered = await tools.spawn_agent!.recover(binding, { legacy: false, args });
    expect(recovered).toMatchObject({ outcome: "not-executed", evidence: "spawn-admission-fence" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ pathname: "/api/spawn/validate", capability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(readSpawnAdmissionFence(binding.downstreamKey)).toMatchObject({ status: 400 });
  } finally {
    viewer.stop(true);
    if (previousControlUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previousControlUrl;
  }
});

/* #1720 — who the parent of an MCP spawn is. The mandate and the spawn_agent
   schema tell a manager what a spawn with no taskId joins, and that depends on
   whether the route infers the caller as lineage parent. It does for an
   agent-capability POST to /api/spawn; it does NOT for this tool, whose control
   dispatch arrives same-origin with the operator spawn capability. This drives
   the tool's spawn VALIDATE probe (`recover` POSTs to /api/spawn/validate) over
   real HTTP. The probe shares the dispatch's headers (`spawnControlHeaders()`
   plus the same-origin control post) and body (`spawnDispatchBody()`), so it
   stands in for the /api/spawn call without being that call. The request
   classifies as no agent caller, and applying the route's selector rule to the
   received body with no src/parent/parentConversationId resolves no parent. */
test("the spawn_agent validate probe arrives as no agent caller, so without a body selector it resolves no lineage parent", async () => {
  const cwd = path.join(sandbox, "parentless-probe-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const received: { agentInitiated: boolean; body: Record<string, unknown> }[] = [];
  const viewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const routed = new NextRequest(request);
      received.push({ agentInitiated: isAgentInitiatedSpawn(routed), body: await routed.clone().json() as Record<string, unknown> });
      return spawnAdmissionPost.withDependencies(routed, { registry: () => registry });
    },
  });
  const previousControlUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = viewer.url.origin;
  try {
    const args = spawnArgs("spawn_parentless_http_1", cwd);
    const tools = viewerMcpRecoverableTools({
      ...productionDomainDependencies,
      registrySnapshot: () => registry.readOnlySnapshot(),
      attentionAuthority: () => ({ kind: "root", conversationId: null, role: null }),
      recoveryPredecessors: () => [],
    });
    const bindingInput = await tools.spawn_agent!.bind(args);
    await tools.spawn_agent!.recover({
      ...bindingInput,
      version: 1,
      toolName: "spawn_agent",
      clientRequestId: String(args.clientRequestId),
      owner: { pid: process.pid, startIdentity: null },
      claimedAt: new Date().toISOString(),
    }, { legacy: false, args });

    expect(received).toHaveLength(1);
    expect(received[0]!.agentInitiated).toBe(false);
    const selector = spawnLineageSelectorForCaller(null, received[0]!.body);
    expect(selector).toBe(received[0]!.body);
    expect(resolveSpawnLineage(selector, registry).parent).toBeNull();
  } finally {
    viewer.stop(true);
    if (previousControlUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previousControlUrl;
  }
});

/** The exact shape the original stranded claim carried (#1641): a reviewer
    launch that names no `reviews`. Its arguments are otherwise complete, so
    every refusal it meets belongs to the mandatory reviewer contract alone. */
function reviewerArgsWithoutReviews(clientRequestId: string, cwd: string): Record<string, unknown> {
  return {
    clientRequestId,
    role: "reviewer",
    roleParams: { diffSource: "origin/main...HEAD" },
    engine: "codex",
    cwd,
    ["prompt"]: "independent read-only review of the runtime packet",
    title: "Independent runtime packet review",
  };
}

test("a reviewer stranded for missing reviews recovers to NOT_EXECUTED on its exact original key", async () => {
  const cwd = path.join(sandbox, "reviewer-http-probe-dir");
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(sandbox, `registry-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const requests: { pathname: string; capability: string | null; secFetchSite: string | null }[] = [];
  const viewer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({
        pathname: new URL(request.url).pathname,
        capability: request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER),
        secFetchSite: request.headers.get("sec-fetch-site"),
      });
      return spawnAdmissionPost.withDependencies(
        new NextRequest(request),
        { registry: () => registry },
      );
    },
  });
  const previousControlUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = viewer.url.origin;
  try {
    const args = reviewerArgsWithoutReviews("spawn_reviewer_stranded_http_1", cwd);
    const tools = viewerMcpRecoverableTools({
      ...productionDomainDependencies,
      registrySnapshot: () => registry.readOnlySnapshot(),
      attentionAuthority: () => ({ kind: "root", conversationId: null, role: null }),
      recoveryPredecessors: () => [],
    });
    const bindingInput = await tools.spawn_agent!.bind(args);
    const binding: McpRequestBinding = {
      ...bindingInput,
      version: 1,
      toolName: "spawn_agent",
      clientRequestId: String(args.clientRequestId),
      owner: { pid: process.pid, startIdentity: null },
      claimedAt: new Date().toISOString(),
    };

    /* Viewer control calls carry the same-origin marker, so this probe lands
       on the validator's role-resolution branch — the same branch the original
       dispatch reached through `/api/spawn`. That branch used to answer
       admissible:true, which is why the caller's key could only stay unknown. */
    const recovered = await tools.spawn_agent!.recover(binding, { legacy: false, args });
    expect(recovered).toMatchObject({
      outcome: "not-executed",
      evidence: "spawn-admission-fence",
      reason: "reviewer requires reviews",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      pathname: "/api/spawn/validate",
      capability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      secFetchSite: "same-origin",
    });
    expect(readSpawnAdmissionFence(binding.downstreamKey)).toMatchObject({ status: 400 });
    /* Nothing was launched for the recovered key. */
    expect(registry.readOnlySnapshot().receipts).toEqual({});

    /* A recovery bound to different arguments under the same key reads the
       fence as contradicting its request and must stay unknown. */
    const contradicted = await tools.spawn_agent!.recover(binding, {
      legacy: false,
      args: { ...args, ["prompt"]: "review a different packet" },
    });
    expect(contradicted).toMatchObject({ outcome: "unknown" });
    expect(requests).toHaveLength(1);
  } finally {
    viewer.stop(true);
    if (previousControlUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previousControlUrl;
  }
});
