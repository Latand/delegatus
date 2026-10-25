import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { systemScheduler, type DeadlineScheduler } from "@/lib/deadline";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { awaitFixtureFile } from "./fixtureBarrier";

/**
 * The shared Streamable HTTP endpoint, driven at its public boundary.
 *
 * An SDK client speaks the protocol over real HTTP to a loopback listener that
 * rebuilds each request as a `NextRequest` and hands it to the EXPORTED route
 * (`src/app/api/mcp/route.ts`). Behind the route is the production tool
 * service — real bindings, the real per-call policy, the SQLite receipt store —
 * and the production identity resolution: the capability each client presents
 * is looked up in a real registry. The only stand-in is the Viewer's
 * `/api/tmux` delivery route, served on the same listener, which records what
 * the bindings forwarded and delivers nothing.
 *
 * Everything runs in a private sandbox: state, config, home and temp all point
 * inside it before a single Viewer module loads.
 */

const originalEnv = { ...process.env };
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-http-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LLV_") || key.startsWith("NEXT_PUBLIC_")) delete process.env[key];
}
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.TMPDIR = sandbox;
process.env.HOSTNAME = "127.0.0.1";
fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), JSON.stringify({
  schemaVersion: 1, aliases: {}, displayNames: { viewer: "Fixture Viewer" },
}));

const { agentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const route = await import("@/app/api/mcp/route");
const { proxy } = await import("@/proxy");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore, SqliteMcpReceiptStore, withMcpDispatchTurns } = await import("./server");
const { productionViewerControlDependencies, sendDownstreamKey, viewerMcpBindings, viewerMcpRecoverableTools, viewerMcpToolPolicy } = await import("./bindings");

test("a tool server still validates elicited content when its JSON Schema validator starts lazily", async () => {
  const server = createViewerMcpServer({ async callTool() { throw new Error("no tool expected"); } });
  const client = new Client({ name: "elicitation-fixture", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  let content: Record<string, string | number> = { value: "accepted" };
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const params = { message: "Fixture value", requestedSchema: {
    type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"],
  } };
  try {
    expect(await server.server.elicitInput(params)).toMatchObject({ action: "accept", content: { value: "accepted" } });
    content = { value: 42 };
    await expect(server.server.elicitInput(params)).rejects.toThrow("does not match requested schema");
    content = { value: "accepted again" };
    expect(await server.server.elicitInput(params)).toMatchObject({ action: "accept", content });
  } finally { await Promise.all([client.close(), server.close()]); }
});

test("MCP dispatch yields to timers, preserves each caller and keeps awaited operations concurrent", async () => {
  const { runAsMcpHttpCaller, currentMcpHttpCaller } = await import("./callerContext");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  const observed: Array<string | undefined> = [];
  const service = withMcpDispatchTurns({ async callTool(toolName, args) {
    observed.push(currentMcpHttpCaller()?.capability);
    if (args.clientRequestId === "held") await held;
    return { ok: true, toolName: toolName as import("./server").McpToolName, clientRequestId: String(args.clientRequestId), replayed: false };
  } });
  const first = runAsMcpHttpCaller({ capability: "fixture-first" }, () => service.callTool("list_tasks", { clientRequestId: "held" }));
  try {
    const second = await runAsMcpHttpCaller({ capability: "fixture-second" }, () => service.callTool("list_tasks", { clientRequestId: "free" }));
    expect(second.ok).toBe(true);
    expect(timerRan).toBe(true);
    expect(observed).toEqual(["fixture-first", "fixture-second"]);
  } finally { clearTimeout(timer); release(); await first; }
  const cancelled = new AbortController(); cancelled.abort();
  const refused = await service.callTool("create_task", withTaskDue({ clientRequestId: "original-key" }), { signal: cancelled.signal });
  expect(refused).toMatchObject({ ok: false, code: "outcome_unknown", details: { nextAction: "original-key-lookup" } });
  expect(observed).toHaveLength(2);
  expect((await service.callTool("create_task", withTaskDue({ clientRequestId: "original-key" }))).ok).toBe(true);
  expect(observed).toHaveLength(3);
});

interface Delivery {
  capability: string | null;
  clientMessageId: string;
}

let listener: ReturnType<typeof Bun.serve> | null = null;
let port = 0;
let origin = "";
let deliveries: Delivery[] = [];
const nativeMcpRequests: Array<{ capability: string | null; method: string | null }> = [];

function rpcMethods(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(rpcMethods);
  if (!value || typeof value !== "object") return [];
  return [...("method" in value && typeof value.method === "string" ? [value.method] : []),
    ...Object.values(value).flatMap(rpcMethods)];
}
/** When set, the next MCP request is served by the route and its answer is
    then lost on the way back, as when the stable listener loses its upstream
    mid-answer during a deploy. */
let loseNextAnswer = false;
let loseNextDeliveryAnswer = false;
/** When set, the delivery route holds its answer until the bindings' request
    to it is abandoned, and resolves this with how long it waited. */
let holdDelivery: ((waitedMs: number) => void) | null = null;

function serveViewer(listenPort: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: listenPort,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/tmux" && request.method === "POST" && holdDelivery) {
        const settle = holdDelivery;
        holdDelivery = null;
        const started = Date.now();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        settle(Date.now() - started);
        return new Response(null, { status: 499 });
      }
      if (url.pathname === "/api/tmux" && request.method === "POST") {
        const body = await request.json() as { clientMessageId: string };
        deliveries.push({ capability: request.headers.get("x-llv-spawn-capability"), clientMessageId: body.clientMessageId });
        if (loseNextDeliveryAnswer) {
          loseNextDeliveryAnswer = false;
          return new Response('{"ok":', { headers: { "content-type": "application/json" } });
        }
        const operationId = `op_${body.clientMessageId.slice(-12)}`;
        return Response.json({ ok: true, operationId, outcome: "queued", receipt: { operationId, status: "queued" } });
      }
      if (url.pathname === "/api/mcp") {
        const body = request.method === "POST" ? await request.clone().json().catch(() => null) as unknown : null;
        const methods = rpcMethods(body);
        for (const method of methods.length ? methods : [null]) {
          nativeMcpRequests.push({ capability: request.headers.get("x-llv-spawn-capability"), method });
        }
        const next = new NextRequest(url, {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          ...(request.method === "POST" ? { body: await request.text() } : {}),
        });
        const perimeter = proxy(next);
        if (perimeter.headers.get("x-middleware-next") !== "1") return perimeter;
        const answer = request.method === "POST"
          ? await route.POST(next)
          : request.method === "DELETE" ? route.DELETE() : route.GET();
        if (loseNextAnswer) {
          loseNextAnswer = false;
          await answer.arrayBuffer();
          return new Response(null, { status: 502 });
        }
        return answer;
      }
      return Response.json({ error: `no route for ${request.method} ${url.pathname}` }, { status: 404 });
    },
  });
}

interface Agent {
  conversationId: string;
  launchId: string;
  capability: string;
}

let alice: Agent;
let bob: Agent;

function launchAgent(title: string): Agent {
  const registry = agentRegistry();
  const receipt = registry.beginSpawn("claude", sandbox, { cwd: sandbox, title });
  return { conversationId: receipt.conversationId, launchId: receipt.launchId, capability: registry.rotateSpawnCapabilityForReceipt(receipt.launchId) };
}

beforeAll(async () => {
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  const at = "2026-10-01T00:00:00.000Z";
  beginOrchestratorSeatIntent({ project: "viewer", mandate: "Fixture board", clientRequestId: "http-fixture-seat", mode: "existing", now: at });
  completeOrchestratorSeatIntent({ project: "viewer", clientRequestId: "http-fixture-seat", conversationId: "conversation_http_fixture_seat", path: null, preparedAuthCredentialBaseline: null, now: at });
  listener = serveViewer(0);
  port = listener.port!;
  origin = `http://127.0.0.1:${port}`;
  /* Where the bindings send the delivery the send tool makes. */
  process.env.LLV_VIEWER_CONTROL_URL = origin;
  alice = launchAgent("HTTP MCP caller A");
  bob = launchAgent("HTTP MCP caller B");
});

afterAll(async () => {
  listener?.stop(true);
  await (await import("./taskExecutor")).viewerTaskExecutor().close();
  await reapFixtureChildren();
  setAgentRegistryForTests(null);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  deliveries = [];
  loseNextAnswer = false;
  loseNextDeliveryAnswer = false;
});

async function httpClient(headers: Record<string, string>, name = "llv-http-mcp-regression"): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", origin), { requestInit: { headers } }));
  /* As an agent does at startup; it also primes the client's tool cache, so a
     later call is exactly one request. */
  await client.listTools();
  return client;
}

for (const engine of ["codex-mcp-client", "claude-code"]) test(`${engine} receives one JSON result across HTTP executor calls`, async () => {
  const client = await httpClient({ "x-llv-spawn-capability": alice.capability, "user-agent": `${engine}/fixture` }, engine);
  try {
    const success = await client.callTool({ name: "list_tasks", arguments: { ids: ["task-fixture-absent"] } });
    expect(success.structuredContent).toBeUndefined();
    expect(success.content).toHaveLength(1);
    expect(JSON.parse((success.content as Array<{ text: string }>)[0].text)).toMatchObject({ ok: true, toolName: "list_tasks" });
    const invalid = await client.callTool({ name: "create_task", arguments: withTaskDue({
      clientRequestId: `format-invalid-${engine}`, project: "fixture-project", text: "Inspect the transport", details: 42,
    }) });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toBeUndefined();
    expect(invalid.content).toHaveLength(1);
    expect(JSON.parse((invalid.content as Array<{ text: string }>)[0].text)).toMatchObject({ ok: false, code: "TASK_INVALID_FIELD" });
  } finally { await client.close(); }
});

function agentClient(agent: Agent): Promise<Client> {
  return httpClient({ "x-llv-spawn-capability": agent.capability });
}

for (const keyed of [false, true]) test(`spawned MCP client calls Delegatus over HTTP with access key=${keyed}`, async () => {
  const { applyClaudeSpawnPolicy, viewerMcpTransportForLaunch } = await import("@/lib/agent/spawnPolicy");
  const previous = { ...process.env };
  try {
    if (keyed) process.env.LLV_TOKEN = crypto.randomBytes(32).toString("base64url");
    else delete process.env.LLV_TOKEN;
    process.env.LLV_VIEWER_PORT = String(port);
    const launchEnv: NodeJS.ProcessEnv = { ...process.env, LLV_SPAWN_CAPABILITY: alice.capability };
    delete launchEnv.LLV_TOKEN;
    if (keyed) {
      const bare = await fetch(`${origin}/api/mcp`, { method: "POST", headers: { "x-llv-spawn-capability": alice.capability }, body: "{}" });
      expect(bare.status).toBe(403);
      expect(await bare.json()).toEqual({ error: "access denied: key required" });
    }
    const transport = viewerMcpTransportForLaunch(launchEnv);
    expect(transport).toBe("http");
    const config = applyClaudeSpawnPolicy(path.join(sandbox, `keyed-${keyed}`), {
      profileId: "access", cwd: sandbox, viewerTransport: transport, cleanMemory: true,
    });
    const child = ownFixtureChild(Bun.spawn([process.execPath, path.join(import.meta.dir, "httpSpawnClient.fixture.ts"), config.mcpConfigPath], {
      env: launchEnv, stdout: "pipe", stderr: "pipe",
    }));
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output, error }).toEqual({ code: 0, output: "MCP tool call succeeded\n", error: "" });
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  }
});

test("local MCP access never substitutes for current launch identity or native peer proof", async () => {
  const { mcpHttpAccessToken, MCP_HTTP_ACCESS_HEADER } = await import("./httpAccess");
  const previous = process.env.LLV_TOKEN;
  process.env.LLV_TOKEN = crypto.randomBytes(32).toString("base64url");
  const agent = launchAgent("Access rotation fixture");
  const oldCapability = agent.capability;
  agent.capability = agentRegistry().rotateSpawnCapabilityForReceipt(agent.launchId);
  try {
    const access = mcpHttpAccessToken()!;
    for (const [headers, message] of [
      [{}, "requires the x-llv-spawn-capability header"],
      [{ "x-llv-spawn-capability": "a".repeat(43) }, "unknown or was rotated"],
      [{ "x-llv-spawn-capability": oldCapability }, "unknown or was rotated"],
      [{ "x-delegatus-mcp-peer": "invalid" }, "native MCP peer could not be authenticated"],
      [{ "x-delegatus-mcp-unattributed": "1" }, "requires the x-llv-spawn-capability header"],
    ] as Array<[Record<string, string>, string]>) {
      const response = await fetch(`${origin}/api/mcp`, { method: "POST", headers: {
        [MCP_HTTP_ACCESS_HEADER]: access, ...headers, "content-type": "application/json",
      }, body: "{}" });
      expect(response.status).toBe(403);
      expect((await response.json() as { error: { message: string } }).error.message).toContain(message);
    }
    const client = await httpClient({ [MCP_HTTP_ACCESS_HEADER]: access, "x-llv-spawn-capability": agent.capability });
    try { expect((await client.listTools()).tools.some(tool => tool.name === "list_tasks")).toBe(true); }
    finally { await client.close(); }
  } finally {
    if (previous === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = previous;
  }
});

// Native discovery uses no provider credentials or model turn. The process
// receives the terminal command's global flags, with app-server as its probe
// subcommand, so Codex itself opens the configured connector and lists tools.
for (const mode of ["fresh", "resume", "denied", "keyed"] as const) test.skipIf(originalEnv.LLV_NATIVE_CODEX_TEST !== "1")(`native ${mode} terminal verifies Viewer access after HTTP registration removal`, async () => {
  const { freshSpecFor, prepareAgentPublicationSpec, resumeSpecForSession, withSpawnCapability } = await import("@/lib/agent/cli");
  const { setCodexFeatureReaderForTest } = await import("@/lib/agent/codexSpawnPolicy");
  const restoreFeatures = setCodexFeatureReaderForTest(undefined);
  const previousBinary = process.env.LLV_CODEX_BINARY;
  const previousPath = process.env.PATH;
  const previousToken = process.env.LLV_TOKEN;
  const previousPort = process.env.LLV_VIEWER_PORT;
  const requestedBinary = originalEnv.LLV_CODEX_BINARY?.trim() || "codex";
  const selectedBinary = path.isAbsolute(requestedBinary) || requestedBinary.includes(path.sep)
    ? path.resolve(requestedBinary)
    : Bun.which(requestedBinary) ?? requestedBinary;
  process.env.LLV_CODEX_BINARY = selectedBinary;
  const root = path.join(sandbox, `terminal-${mode}`);
  const configRoot = path.join(root, "config");
  const home = path.join(configRoot, "accounts", "codex", "fixture");
  const tools = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(tools);
  for (const tool of ["dirname", "basename", "awk", "grep", "mktemp", "chmod", "mv"]) {
    const found = Bun.which(tool);
    if (!found) throw new Error(`missing installer fixture tool: ${tool}`);
    fs.symlinkSync(found, path.join(tools, tool));
  }
  const pathCodexLog = path.join(root, "path-codex-called.log");
  fs.writeFileSync(path.join(tools, "codex"), `#!/bin/sh\nprintf called > '${pathCodexLog}'\nexit 93\n`, { mode: 0o700 });
  process.env.PATH = `${tools}:${previousPath ?? ""}`;
  const catalog = path.join(root, "models.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [{
    slug: "fixture", display_name: "Fixture", description: null,
    base_instructions: "Synthetic discovery fixture.", supported_reasoning_levels: [],
    shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [], tool_mode: "direct", multi_agent_version: "v2", context_window: 32000, prefer_websockets: false,
  }] }));
  const invocationLog = path.join(root, "codex-invocations.log");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const selectedWrapper = path.join(root, "selected-codex");
  fs.writeFileSync(selectedWrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(invocationLog)}\nexec ${quote(selectedBinary)} "$@"\n`, { mode: 0o700 });
  process.env.LLV_CODEX_BINARY = selectedWrapper;
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, [
    'model="fixture"', 'model_provider="fixture"', `model_catalog_json=${JSON.stringify(catalog)}`,
    '[model_providers.fixture]', 'name="fixture"', 'base_url="http://127.0.0.1:1/v1"',
    'wire_api="responses"', 'requires_openai_auth=false',
    '[mcp_servers.viewer]', 'command="bun"', `args=[${JSON.stringify(path.join(process.cwd(), "bin/mcp-server.mjs"))}]`,
    '[mcp_servers.ungranted]', 'command="fixture-must-never-start"',
  ].join("\n"));
  try {
    if (mode === "keyed") {
      process.env.LLV_TOKEN = crypto.randomBytes(32).toString("base64url");
      process.env.LLV_VIEWER_PORT = String(port);
    }
    const installer = Bun.spawn([Bun.which("bash")!, "scripts/install-mcp.sh"], {
      env: { HOME: root, CODEX_HOME: home, PATH: tools, LLV_CONFIG_ROOT: configRoot,
        LLV_MCP_BIN: path.join(process.cwd(), "bin/mcp-server.mjs"), LLV_MCP_TRANSPORT: "http" },
      stdout: "pipe", stderr: "pipe",
    });
    const [installed, , installerError] = await Promise.all([installer.exited, new Response(installer.stdout).text(), new Response(installer.stderr).text()]);
    expect({ installed, installerError }).toEqual({ installed: 0, installerError: "" });
    const installedConfig = fs.readFileSync(config, "utf8");
    expect(installedConfig).not.toContain("mcp_servers.viewer");
    const inventory = Bun.spawnSync([process.env.LLV_CODEX_BINARY, "-c", "features.plugins=false", "mcp", "list", "--json"], {
      env: { ...process.env, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    expect({ code: inventory.exitCode, error: inventory.stderr.toString() }).toMatchObject({ code: 0 });
    const initial = mode !== "resume" ? freshSpecFor("codex", root, { codexHome: home, cleanMemory: true })
      : resumeSpecForSession("codex", "12345678-1234-1234-1234-123456789abc", root, home, { cleanMemory: true, hostTerminal: true })!;
    const prepared = await prepareAgentPublicationSpec(initial);
    const capability = mode === "denied" ? "d".repeat(43) : alice.capability;
    nativeMcpRequests.length = 0;
    const admitted = withSpawnCapability(prepared, capability, { ...process.env, LLV_MCP_TRANSPORT: "http", DELEGATUS_MCP_TRANSPORT: undefined, LLV_MCP_HTTP_URL: `${origin}/api/mcp` });
    const command = admitted.command.replace(prepared.codexPublication!.subcommand ?? /(?= \) \)$)/, " app-server");
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: root, CODEX_HOME: home };
    delete childEnv.LLV_TOKEN;
    const child = ownFixtureChild(Bun.spawn(["sh", "-c", command], {
      cwd: root, env: childEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    }));
    const stderr = new Response(child.stderr).text();
    // Bun and Node declare distinct Web Stream types for the same adapter.
    const lines = createInterface({ input: Readable.fromWeb(child.stdout as unknown as import("node:stream/web").ReadableStream) });
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let nextId = 0;
    lines.on("line", line => {
      const response = JSON.parse(line);
      const request = pending.get(response.id); if (!request) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error(JSON.stringify(response.error))); else request.resolve(response.result);
    });
    const rpc = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    const deadline = setTimeout(() => child.kill(9), 20_000);
    try {
      const discovered = async () => {
        await rpc("initialize", { clientInfo: { name: "terminal-mcp-readiness", version: "1" }, capabilities: { experimentalApi: true } });
        child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
        const started = await rpc("thread/start", { cwd: root, approvalPolicy: "never", sandbox: "read-only" }) as { thread: { id: string } };
        const status = await rpc("mcpServerStatus/list", { threadId: started.thread.id, detail: "toolsAndAuthOnly" }) as { data: Array<{ name: string; tools: Record<string, unknown> }> };
        const viewer = status.data.find(entry => entry.name === "viewer");
        expect(viewer).toBeDefined();
        if (mode === "denied") expect(Object.keys(viewer!.tools)).toHaveLength(0);
        else expect(Object.keys(viewer!.tools)).toContain("list_tasks");
        const launchRequests = nativeMcpRequests.filter(request => request.capability === capability).map(request => request.method);
        expect(launchRequests).toContain("initialize");
        if (mode !== "denied") expect(launchRequests).toContain("tools/list");
        expect(status.data.some(entry => entry.name === "ungranted" && Object.keys(entry.tools).length > 0)).toBe(false);
      };
      await Promise.race([discovered(), child.exited.then(async code => { throw new Error(`native terminal probe exited ${code}: ${await stderr}`); })]);
      const invocations = fs.readFileSync(invocationLog, "utf8").split("\n");
      expect(invocations.some(line => line.includes("app-server") && line.includes("mcp_servers.viewer.url="))).toBe(true);
      expect(fs.existsSync(pathCodexLog)).toBe(false);
      expect(fs.readFileSync(config, "utf8")).toBe(installedConfig);
    } finally {
      clearTimeout(deadline); lines.close(); child.stdin.end();
      await Promise.race([child.exited, Bun.sleep(1_000)]);
      if (child.exitCode === null) child.kill();
      await child.exited; await stderr;
    }
  } finally {
    restoreFeatures();
    if (previousBinary === undefined) delete process.env.LLV_CODEX_BINARY; else process.env.LLV_CODEX_BINARY = previousBinary;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousToken === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = previousToken;
    if (previousPort === undefined) delete process.env.LLV_VIEWER_PORT; else process.env.LLV_VIEWER_PORT = previousPort;
  }
});

function payloadOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

async function holdReceiptLock(holdMs: number) {
  const filename = path.join(process.env.LLV_STATE_DIR!, "mcp-receipts.sqlite");
  new SqliteMcpReceiptStore(filename).close();
  const ready = path.join(sandbox, `lock-${crypto.randomUUID()}`);
  const release = `${ready}-release`;
  const child = ownFixtureChild(Bun.spawn([process.execPath, path.join(import.meta.dir, "receiptStoreProbeChild.ts"),
    "hold-sqlite", filename, ready, release, String(holdMs)], { env: process.env, stdout: "pipe", stderr: "pipe" }));
  await awaitFixtureFile(ready);
  let closing: Promise<void> | undefined;
  return { child, close() { return closing ??= (async () => {
    fs.writeFileSync(release, "released");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  })(); } };
}

test("HTTP retries a failed first inline initialization and original keys without repeating a write", async () => {
  const client = await agentClient(alice);
  // The task executor warms the HTTP wrapper without opening its inline store.
  await client.callTool({ name: "get_task", arguments: { taskId: "missing-task" } });
  const lock = await holdReceiptLock(6200);
  const args = { limit: 1, clientRequestId: "first-inline-read" };
  try {
    const [read, write] = await Promise.all([
      client.callTool({ name: "list_flows", arguments: args }),
      send(client, "first-inline-send"),
    ]);
    expect(read.isError).toBe(true);
    expect(write.isError).toBe(true);
    expect(JSON.stringify(read.content)).toMatch(/state admission timed out|database is locked/);
    expect(deliveries).toHaveLength(0);
    expect(await lock.child.exited).toBe(0);
    expect(payloadOf(await client.callTool({ name: "list_flows", arguments: args }))).toMatchObject({ ok: true });
    expect(payloadOf(await client.callTool({ name: "list_flows", arguments: { limit: 1, clientRequestId: "after-inline-failure" } })))
      .toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "first-inline-send"))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "first-inline-send"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries).toHaveLength(1);
  } finally { await lock.close(); await client.close(); }
}, 20_000);

test("forwarded stdio receipt contention yields on the Viewer and preserves replay", async () => {
  const client = new Client({ name: "receipt-contention", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(import.meta.dir, "entry.ts")],
    env: Object.fromEntries(Object.entries({ ...process.env, LLV_SPAWN_CAPABILITY: alice.capability })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: "pipe" });
  await client.connect(transport);
  await client.callTool({ name: "list_flows", arguments: { limit: 1 } });
  const lock = await holdReceiptLock(60_000);
  const { stateLockWaitsInFlight } = await import("@/lib/state/lockWait");
  const blockingWait = spyOn(Atomics, "wait");
  const blockingSleep = spyOn(Bun, "sleepSync");
  const args = { limit: 1, clientRequestId: "stdio-held-receipt" };
  let pending: ReturnType<Client["callTool"]> | undefined;
  try {
    let settled = false;
    pending = client.callTool({ name: "list_flows", arguments: args });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    // The lock stays held until the Viewer has retried and the event loop has
    // returned to this test. Runner latency cannot release it for us.
    const retried = () => stateLockWaitsInFlight().some(wait => wait.callSite === "mcp.receipts.claim" && wait.attempts >= 2);
    while (!settled && !retried())
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(retried()).toBe(true);
    expect(blockingWait).not.toHaveBeenCalled();
    expect(blockingSleep).not.toHaveBeenCalled();
    await lock.close();
    expect(payloadOf(await pending)).toMatchObject({ ok: true });
    expect(payloadOf(await client.callTool({ name: "list_flows", arguments: args }))).toMatchObject({ ok: true, replayed: true });
    expect(payloadOf(await send(client, "stdio-held-send"))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "stdio-held-send"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries).toHaveLength(1);
  } finally {
    blockingWait.mockRestore(); blockingSleep.mockRestore();
    await lock.close(); await pending?.catch(() => {}); await client.close();
  }
}, 20_000);

test("task HTTP execution preserves protocol validation, exact text, caller receipts and replay", async () => {
  const client = await agentClient(alice);
  const details = "First line\nA tab\tand a backslash \\ with Unicode λ";
  const args = { project: "Fixture Viewer", text: "Task HTTP executor fixture", details, board: "hidden", clientRequestId: "http-task-protocol" };
  try {
    const invalid = payloadOf(await client.callTool({ name: "create_task", arguments: withTaskDue({ ...args, steps: "invalid" }) }));
    expect(invalid).toMatchObject({ ok: false, code: "TASK_INVALID_FIELD" });
    const created = payloadOf(await client.callTool({ name: "create_task", arguments: withTaskDue({ ...args, full: true }) }));
    expect(created).toMatchObject({ ok: true, task: { text: args.text, details } });
    expect(payloadOf(await client.callTool({ name: "create_task", arguments: withTaskDue({ ...args, full: true }) })))
      .toMatchObject({ ok: true, replayed: true, taskId: created.taskId, revision: created.revision });
    const other = await agentClient(bob);
    try {
      expect(payloadOf(await other.callTool({ name: "create_task", arguments: withTaskDue({ ...args, full: true }) })))
        .toMatchObject({ ok: true, replayed: true, taskId: created.taskId, revision: created.revision,
          task: { statusBy: (created.task as { statusBy: unknown }).statusBy } });
      expect(payloadOf(await other.callTool({ name: "update_task", arguments: {
        taskId: created.taskId, note: "Second caller note", clientRequestId: "http-task-note", full: true,
      } }))).toMatchObject({ ok: true, task: { note: { author: { conversationId: bob.conversationId } } } });
    } finally { await other.close(); }
    expect(payloadOf(await client.callTool({ name: "get_task", arguments: { taskId: created.taskId, full: true } })))
      .toMatchObject({ ok: true, task: { text: args.text, details } });
  } finally { await client.close(); }
});

function send(client: Client, clientRequestId: string, to: Agent = bob) {
  return client.callTool({ name: "send_message", arguments: { clientRequestId, conversationId: to.conversationId, text: "hello over http" } });
}

test("an authenticated compatibility adapter keeps unidentified authority and cannot borrow a launch identity", async () => {
  const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
  const headers = { ...internalServiceHeaders("mcp"), "x-delegatus-mcp-unattributed": "1" };
  await expect(httpClient({ "x-delegatus-mcp-unattributed": "1" })).rejects.toThrow();
  await expect(httpClient({ ...headers, "x-llv-spawn-capability": "unknown" })).rejects.toThrow();
  const client = await httpClient(headers);
  const previous = process.env.LLV_SPAWN_CAPABILITY;
  process.env.LLV_SPAWN_CAPABILITY = alice.capability;
  try {
    expect(payloadOf(await client.callTool({ name: "list_tasks", arguments: { ids: ["absent"] } }))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "compatibility-unidentified"))).toMatchObject({ ok: false, code: "caller_unidentified" });
    expect(deliveries).toHaveLength(0);
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.LLV_SPAWN_CAPABILITY;
    else process.env.LLV_SPAWN_CAPABILITY = previous;
  }
});

async function inMemoryAgentClient(control = productionViewerControlDependencies()) {
  process.env.LLV_SPAWN_CAPABILITY = alice.capability;
  const store = new SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "reconnect-receipts.sqlite"));
  const service = createMcpToolService(viewerMcpBindings(undefined, control), store, viewerMcpToolPolicy(), {
    recovery: viewerMcpRecoverableTools(),
  });
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "control-reconnect-regression", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server, store, service };
}

test("the first MCP send after an idle connection closes reaches either target exactly once", async () => {
  const { client, server } = await inMemoryAgentClient();
  try {
    expect(payloadOf(await send(client, "idle-warm"))).toMatchObject({ ok: true });
    // Close every pooled HTTP connection while the MCP session stays alive.
    await listener!.stop(true);
    listener = serveViewer(port);
    expect(payloadOf(await send(client, "idle-target"))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "idle-sibling", alice))).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "idle-target"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries.map(delivery => delivery.clientMessageId)).toEqual([
      sendDownstreamKey("idle-warm"), sendDownstreamKey("idle-target"), sendDownstreamKey("idle-sibling"),
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
});

test("an MCP send survives a refused connection during a brief Viewer restart", async () => {
  const { client, server } = await inMemoryAgentClient();
  let restarted: Promise<void> = Promise.resolve();
  try {
    expect(payloadOf(await send(client, "restart-warm"))).toMatchObject({ ok: true });
    await listener!.stop(true);
    restarted = Bun.sleep(250).then(() => { listener = serveViewer(port); });
    const result = payloadOf(await send(client, "restart-first-send"));
    expect(result).toMatchObject({ ok: true });
    expect(payloadOf(await send(client, "restart-first-send"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries.map(delivery => delivery.clientMessageId)).toEqual([
      sendDownstreamKey("restart-warm"), sendDownstreamKey("restart-first-send"),
    ]);
  } finally {
    await restarted;
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
});

test("an exhausted reconnect leaves the original MCP send key available for retry", async () => {
  const { client, server, store } = await inMemoryAgentClient();
  try {
    expect(payloadOf(await send(client, "outage-warm"))).toMatchObject({ ok: true });
    await listener!.stop(true);
    listener = null;
    const result = payloadOf(await send(client, "outage-send"));
    expect(result).toMatchObject({
      ok: false, retryable: true,
      error: expect.stringContaining(origin),
      details: { outcome: "not-executed", nextAction: "retry-same-key", endpoint: origin, lastResponseAgeMs: expect.any(Number) },
    });
    expect(await store.lookup("send_message:outage-send")).toBeNull();
    expect(deliveries).toHaveLength(1);
    listener = serveViewer(port);
    expect(payloadOf(await send(client, "outage-send"))).toMatchObject({ ok: true, replayed: false });
    expect(payloadOf(await send(client, "outage-send"))).toMatchObject({ ok: true, replayed: true });
    expect(deliveries.map(delivery => delivery.clientMessageId)).toEqual([
      sendDownstreamKey("outage-warm"), sendDownstreamKey("outage-send"),
    ]);
  } finally {
    if (!listener) listener = serveViewer(port);
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
}, 15_000);

test("a send with a lost acceptance answer keeps its original claim and never reconnects by resending", async () => {
  const { client, server, store } = await inMemoryAgentClient();
  try {
    loseNextDeliveryAnswer = true;
    expect(payloadOf(await send(client, "lost-delivery-answer"))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(await store.lookup("send_message:lost-delivery-answer")).toMatchObject({ stage: "dispatching" });
    expect(payloadOf(await send(client, "lost-delivery-answer"))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(payloadOf(await client.callTool({ name: "send_message", arguments: {
      clientRequestId: "lost-delivery-answer", conversationId: bob.conversationId, text: "hello over http", recoveryOnly: true,
    } }))).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(payloadOf(await client.callTool({ name: "send_message", arguments: {
      clientRequestId: "lost-delivery-answer", conversationId: bob.conversationId, text: "changed",
    } }))).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(deliveries).toEqual([{ capability: alice.capability, clientMessageId: sendDownstreamKey("lost-delivery-answer") }]);
  } finally {
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
});

test("cancellation during a refused-connection backoff releases the unadmitted send", async () => {
  const backoff = Promise.withResolvers<void>();
  const timers = new Map<unknown, number>();
  let realTimers = false;
  const scheduler: DeadlineScheduler = {
    setTimeout(handler, ms) {
      if (realTimers) return systemScheduler.setTimeout(handler, ms);
      timers.set(handler, ms);
      if (ms <= 100) backoff.resolve();
      return handler;
    },
    clearTimeout(handle) {
      if (!timers.delete(handle)) systemScheduler.clearTimeout(handle);
    },
  };
  const { client, server, store, service } = await inMemoryAgentClient(productionViewerControlDependencies(false, scheduler));
  const args = { clientRequestId: "cancel-refused-send", conversationId: bob.conversationId, text: "cancel before sending" };
  try {
    await listener!.stop(true);
    listener = null;
    const controller = new AbortController();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    let result;
    try {
      const cancelled = service.callTool("send_message", args, { signal: controller.signal, deadlineAt: Date.now() + 60_000 });
      await backoff.promise;
      expect([...timers.values()]).toHaveLength(1);
      expect(controller.signal.aborted).toBe(false);
      controller.abort(new Error("fixture cancellation"));
      result = await cancelled;
      expect(timers.size).toBe(0);
    } finally { clock.mockRestore(); realTimers = true; }
    expect(result).toMatchObject({ ok: false, details: { outcome: "not-executed", nextAction: "retry-same-key" } });
    expect(await store.lookup("send_message:cancel-refused-send")).toBeNull();
    expect(deliveries).toHaveLength(0);
    listener = serveViewer(port);
    expect(await service.callTool("send_message", args)).toMatchObject({ ok: true, replayed: false });
    expect(deliveries).toEqual([{ capability: alice.capability, clientMessageId: sendDownstreamKey("cancel-refused-send") }]);
  } finally {
    if (!listener) listener = serveViewer(port);
    await Promise.all([client.close(), server.close()]);
    delete process.env.LLV_SPAWN_CAPABILITY;
  }
});

async function rawPost(headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL("/api/mcp", origin), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("the HTTP endpoint publishes exactly the stdio server's tools, schemas and instructions", async () => {
  const http = await agentClient(alice);
  const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies()), new MemoryMcpReceiptStore(), viewerMcpToolPolicy());
  const server = createViewerMcpServer(service);
  const stdio = new Client({ name: "llv-stdio-shape", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), stdio.connect(clientSide)]);
  try {
    const [overHttp, overStdio] = await Promise.all([http.listTools(), stdio.listTools()]);
    expect(overHttp.tools.length).toBeGreaterThan(30);
    expect(overHttp.tools).toEqual(overStdio.tools);
    expect(overHttp.tools.map(tool => tool.name)).not.toContain("suggest_replies");
    expect(http.getInstructions()).toBe(stdio.getInstructions());
    expect(http.getServerVersion()).toEqual(stdio.getServerVersion());
  } finally {
    await Promise.all([http.close(), stdio.close(), server.close()]);
  }
});

test("a missing, malformed, unknown or rotated capability is refused before any tool runs", async () => {
  const missing = await rawPost({});
  expect(missing.status).toBe(403);
  expect(missing.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32001 } });
  expect((await rawPost({ "x-llv-spawn-capability": "not-a-capability" })).status).toBe(403);
  expect((await rawPost({ "x-llv-spawn-capability": crypto.randomBytes(32).toString("base64url") })).status).toBe(403);

  for (const name of ["codex-mcp-client", "claude-code"]) {
    expect((await rawPost({ "user-agent": `${name}/fixture` })).status).toBe(403);
    expect((await rawPost({ "user-agent": `${name}/fixture`, "x-llv-spawn-capability": "not-a-capability" })).status).toBe(403);
  }

  /* A relaunch rotates the capability; the one it replaced names nobody. */
  const carol = launchAgent("HTTP MCP rotated caller");
  const rotated = agentRegistry().rotateSpawnCapabilityForReceipt(carol.launchId);
  const stale = await rawPost({ "x-llv-spawn-capability": carol.capability });
  expect(stale.status).toBe(403);
  expect(JSON.stringify(stale.body)).not.toContain(carol.capability);
  expect((await rawPost({ "x-llv-spawn-capability": rotated })).status).toBe(200);

  /* Never a browser's cross-site request. */
  expect((await rawPost({ "x-llv-spawn-capability": alice.capability, origin: "http://evil.example" })).status).toBe(403);

  /* A client with no capability cannot even initialize. */
  await expect(httpClient({})).rejects.toThrow();
  expect(deliveries).toEqual([]);

  /* Stateless: nothing to stream, nothing to end. */
  for (const method of ["GET", "DELETE"]) {
    const response = await fetch(new URL("/api/mcp", origin), { method, headers: { "x-llv-spawn-capability": alice.capability } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  }
});

test("both HTTP migration hosts can call tools before commit and a discard withdraws only the successor", async () => {
  agentRegistry().settleSpawn(alice.launchId, {
    key: { engine: "claude", sessionId: crypto.randomUUID() }, artifactPath: path.join(sandbox, "handover.jsonl"),
    cwd: sandbox, accountId: "source", status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  const predecessor = await agentClient(alice);
  const pending = agentRegistry().stageSpawnCapabilityForConversation(alice.conversationId, "http-handover")!;
  const successor = await agentClient({ ...alice, capability: pending.capability });
  try {
    expect(payloadOf(await send(predecessor, "http-handover-predecessor"))).toMatchObject({ ok: true });
    expect(payloadOf(await send(successor, "http-handover-successor"))).toMatchObject({ ok: true });
    agentRegistry().discardSpawnCapabilityForOperation("http-handover");
    await expect(send(successor, "http-handover-discarded")).rejects.toThrow();
    expect(payloadOf(await send(predecessor, "http-handover-after-discard"))).toMatchObject({ ok: true });
    expect(deliveries.map(row => row.capability)).toEqual([alice.capability, pending.capability, alice.capability]);
  } finally {
    agentRegistry().discardSpawnCapabilityForOperation("http-handover");
    await Promise.all([predecessor.close(), successor.close()]);
  }
});

test("each call runs as the agent whose capability it presented, and one agent's key cannot replay another's call", async () => {
  const [a, b] = await Promise.all([agentClient(alice), agentClient(bob)]);
  try {
    /* Interleaved calls from both agents: every forwarded delivery carries the
       capability of the agent that made that call and of no other. */
    const calls = Array.from({ length: 6 }, (_, index) => index % 2 === 0
      ? send(a, `http-identity-a-${index}`, bob)
      : send(b, `http-identity-b-${index}`, alice));
    const results = await Promise.all(calls);
    for (const result of results) expect(payloadOf(result)).toMatchObject({ ok: true });
    expect(deliveries).toHaveLength(6);
    for (const delivery of deliveries) {
      const index = Array.from({ length: 6 }, (_, i) => i).find((i) => delivery.clientMessageId === sendDownstreamKey(`http-identity-${i % 2 === 0 ? "a" : "b"}-${i}`));
      expect(index).toBeDefined();
      expect(delivery.capability).toBe(index! % 2 === 0 ? alice.capability : bob.capability);
    }

    /* The durable claim names the caller the server derived from the key. */
    const store = new SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, "mcp-receipts.sqlite"));
    const claimA = await store.lookup("send_message:http-identity-a-0");
    const claimB = await store.lookup("send_message:http-identity-b-1");
    expect(claimA?.binding?.caller).toMatchObject({ kind: "worker", conversationId: alice.conversationId });
    expect(claimB?.binding?.caller).toMatchObject({ kind: "worker", conversationId: bob.conversationId });

    /* Replaying one's own call answers from the receipt and delivers nothing new. */
    const replay = await send(a, "http-identity-a-0", bob);
    expect(payloadOf(replay)).toMatchObject({ ok: true, replayed: true });
    /* The other agent presenting the same clientRequestId learns nothing and
       causes nothing. */
    const borrowed = await send(b, "http-identity-a-0", bob);
    expect(borrowed.isError).toBe(true);
    expect(payloadOf(borrowed)).toMatchObject({ ok: false, code: "recovery_not_permitted" });
    expect(deliveries).toHaveLength(6);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test("a restart fails the call in flight cleanly and the next call succeeds on the same client, with no duplicate side effect", async () => {
  const client = await agentClient(alice);
  try {
    /* 1. The route ran and delivered, but the answer never came back (the
          stable listener lost its upstream mid-answer). The call fails. */
    loseNextAnswer = true;
    await expect(send(client, "http-restart-lost-answer")).rejects.toThrow();
    expect(deliveries).toHaveLength(1);
    /* Retrying under the SAME clientRequestId answers from the receipt: the
       message is not delivered twice. */
    const retried = await send(client, "http-restart-lost-answer");
    expect(payloadOf(retried)).toMatchObject({ ok: true, replayed: true });
    expect(deliveries).toHaveLength(1);

    /* 2. The Viewer is gone altogether: the call fails as a transport error. */
    listener!.stop(true);
    await expect(send(client, "http-restart-down")).rejects.toThrow();
    expect(deliveries).toHaveLength(1);

    /* 3. The Viewer is back on the same port. The same client, with no new
          session and no reconnect, simply makes its next call. */
    listener = serveViewer(port);
    const after = await send(client, "http-restart-down");
    expect(after.isError).not.toBe(true);
    expect(payloadOf(after)).toMatchObject({ ok: true });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual({ capability: alice.capability, clientMessageId: sendDownstreamKey("http-restart-down") });
  } finally {
    await client.close();
  }
});

test("a client's cancel ends the call it names, over the stateless endpoint", async () => {
  const client = await agentClient(alice);
  try {
    const abandoned = new Promise<number>((resolve) => { holdDelivery = resolve; });
    const controller = new AbortController();
    const call = client.callTool(
      { name: "send_message", arguments: { clientRequestId: "http-walk-away", conversationId: bob.conversationId, text: "held" } },
      undefined,
      { signal: controller.signal },
    );
    await Bun.sleep(300);
    /* The SDK client sends `notifications/cancelled` on a new POST and keeps
       the original request open, as Claude's client does. */
    controller.abort();
    await expect(call).rejects.toThrow();
    /* The Viewer-side work — here the delivery the tool was waiting on — is
       abandoned promptly, well inside the 30-second tool deadline that alone
       bounded it before. */
    const waited = await Promise.race([abandoned, Bun.sleep(4_000).then(() => Number.POSITIVE_INFINITY)]);
    expect(waited).toBeLessThan(4_000);
  } finally {
    holdDelivery = null;
    await client.close();
  }
}, 15_000);
