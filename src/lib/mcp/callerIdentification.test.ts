import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { OWNERSHIP_PRELOAD, ownershipSandbox } from "@/lib/state/fixtures/ownershipSandbox";
import { ownFixtureChild } from "./ownedFixtureChildren";

setDefaultTimeout(30_000);

function providerEnvironment(home: string): Record<string, string> {
  const roots = { CODEX_HOME: "codex", LLV_CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", LLV_CLAUDE_HOME: "claude",
    COPILOT_HOME: "copilot", OPENCLAW_STATE_DIR: "openclaw", GH_CONFIG_DIR: "gh" };
  const env = Object.fromEntries(Object.entries(roots).map(([key, directory]) => [key, path.join(home, "provider-fixtures", directory)]));
  for (const directory of new Set(Object.values(env))) fs.mkdirSync(directory, { recursive: true });
  return env;
}
Object.assign(process.env, providerEnvironment(process.env.HOME!));
const { AgentRegistry, normalizeRegistry } = await import("@/lib/agent/registry");
const { SqliteAgentRegistryStore } = await import("@/lib/agent/sqliteRegistryStore");
const { SqliteMcpReceiptStore } = await import("./server");

const capability = "a".repeat(43);
const conversationId = "conversation_legacy";

function fixture(receiptsReady = true) {
  const sandbox = ownershipSandbox();
  const directory = path.join(sandbox.home, ".config", "agent-log-viewer", "state");
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(path.join(sandbox.home, ".config", "agent-log-viewer"), path.join(sandbox.home, ".config", "delegatus"),
    process.platform === "win32" ? "junction" : "dir");
  const filename = path.join(directory, "agent-registry.json");
  // The version-2 JSON shape used by the July registry and the JSON-only
  // migration tests. The current launch adds its digest to the old registry.
  fs.writeFileSync(filename, JSON.stringify({ version: 2, entries: {}, receipts: {
    legacy: { launchId: "legacy", conversationId, engine: "codex", state: "completed",
      createdAt: "2026-07-27T00:00:00.000Z", launchProfile: {},
      spawnCapabilityDigest: createHash("sha256").update(capability).digest("hex") },
  }, conversations: { [conversationId]: { id: conversationId, engine: "codex",
    createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z", generations: [
    { id: "legacy-session", path: "fixture-session.jsonl", accountId: "default" },
  ] } } }));
  const receiptOwner = process.env.LLV_STATE_OWNER;
  process.env.LLV_STATE_OWNER = "viewer";
  try { if (receiptsReady) new SqliteMcpReceiptStore(path.join(directory, "mcp-receipts.sqlite")).close(); }
  finally { if (receiptOwner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = receiptOwner; }
  return { sandbox, filename, directory,
    environment: () => ({ ...sandbox.environment(), ...providerEnvironment(sandbox.home) }),
    migrate(explicitSqlite = false) {
    const owner = process.env.LLV_STATE_OWNER;
    const backend = process.env.LLV_AGENT_REGISTRY_SQLITE;
    const mode = process.env.NODE_ENV;
    process.env.LLV_STATE_OWNER = "viewer";
    Object.assign(process.env, { NODE_ENV: "production" });
    if (explicitSqlite) process.env.LLV_AGENT_REGISTRY_SQLITE = "sqlite"; else delete process.env.LLV_AGENT_REGISTRY_SQLITE;
    try { new AgentRegistry(filename, undefined, undefined, { resolveBackendIdentity: true }).close(); }
    finally {
      if (owner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = owner;
      if (backend === undefined) delete process.env.LLV_AGENT_REGISTRY_SQLITE; else process.env.LLV_AGENT_REGISTRY_SQLITE = backend;
      if (mode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: mode });
    }
  } };
}

type Reply = Record<string, unknown>;
async function worker(f: ReturnType<typeof fixture>, request: Record<string, unknown>, options: {
  onLog?: (line: string) => void;
  afterReply?: (reply: Reply, index: number) => Promise<Record<string, unknown> | null>;
  deadlineMs?: number;
  cancelWhenWaiting?: boolean;
} = {}) {
  const child = ownFixtureChild(Bun.spawn([process.execPath, "--preload", OWNERSHIP_PRELOAD, "src/lib/mcpTask.worker.ts"], {
    env: { ...f.environment(), LLV_STATE_OWNER: "mcp", LLV_TOKEN: "",
      LLV_STATE_DIR: path.join(f.sandbox.home, ".config", "delegatus", "state") },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  }));
  let stderr = "";
  const logs = (async () => {
    const decoder = new TextDecoder();
    const reader = child.stderr.getReader();
    let pending = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const text = decoder.decode(next.value, { stream: true }); stderr += text; pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (options.cancelWhenWaiting && line.includes('"outcome":"waiting-for-registry"')) child.stdin.write('{"cancel":1}\n');
        options.onLog?.(line);
      }
    }
  })();
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const reader = child.stdout.getReader();
    let text = ""; const decoder = new TextDecoder();
    const read = async (id: number): Promise<Reply> => {
      for (;;) {
        const newline = text.indexOf("\n");
        if (newline >= 0) {
          const line = text.slice(0, newline); text = text.slice(newline + 1);
          const frame = JSON.parse(line.split("\t", 1)[0]!) as Reply;
          if (frame.id === id) return line.includes("\t") ? { ...frame, body: JSON.parse(line.slice(line.indexOf("\t") + 1)) } : frame;
          continue;
        }
        const next = await reader.read();
        if (next.done) throw new Error(`worker exited before reply: ${stderr}`);
        text += decoder.decode(next.value, { stream: true });
      }
    };
    // Start request deadlines only after the real entry point is ready.
    await read(0);
    const replies: Reply[] = [];
    for (;;) {
      const id = replies.length + 1;
      child.stdin.write(JSON.stringify({ id, name: "identifyCapability", args: {}, caller: { capability },
        deadlineAt: Date.now() + (options.deadlineMs ?? 5_000), ...request }) + "\n");
      const reply = await read(id); replies.push(reply);
      const next = await options.afterReply?.(reply, replies.length - 1);
      if (!next) break;
      request = next;
    }
    child.stdin.end();
    await child.exited; await logs;
    return { reply: replies.at(-1)!, replies, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited; await logs;
  }
}

test("worker logs the registry exception with its caller-identification phase", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.directory, "agent-registry.backend.json"), "{");
    const result = await worker(f, {});
    expect(result.reply.error).toBe("task executor could not identify the caller (registry-read-failed)");
    expect(String(result.reply.error)).not.toContain(capability);
    expect(String(result.reply.error)).not.toContain(f.sandbox.home);
    expect(result.stderr).toContain("caller-identification");
    expect(result.stderr).toContain("RegistryBackendIdentityError");
    expect(result.stderr).toContain("not valid JSON");
    expect(result.stderr).not.toContain(capability);
    expect(result.stderr).not.toContain(f.sandbox.home);
  } finally { f.sandbox.release(); }
});

test("identity waits while an imported registry still awaits its backend publication", async () => {
  const f = fixture();
  const owner = process.env.LLV_STATE_OWNER;
  try {
    process.env.LLV_STATE_OWNER = "viewer";
    const store = new SqliteAgentRegistryStore(path.join(f.directory, "agent-registry.sqlite"), {
      normalize: normalizeRegistry, initialSnapshot: normalizeRegistry(JSON.parse(fs.readFileSync(f.filename, "utf8"))),
    });
    store.close();
    let published = false;
    const result = await worker(f, {}, { onLog: line => {
      if (!published && line.includes("caller-identification") && line.includes("unpublished")) {
        published = true;
        f.migrate(true);
      }
    } });
    expect(published).toBe(true);
    expect(result.reply.result).toEqual({ conversationId });
  } finally {
    if (owner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = owner;
    f.sandbox.release();
  }
});

test("a migrated July registry identifies its caller before task receipts exist, across worker restarts", async () => {
  const f = fixture(false);
  try {
    f.migrate();
    expect(fs.existsSync(f.filename)).toBe(false);
    for (let generation = 0; generation < 2; generation++) {
      const result = await worker(f, {});
      expect(result.reply.result).toEqual({ conversationId });
      expect(fs.existsSync(path.join(f.directory, "mcp-receipts.sqlite"))).toBe(false);
    }
  } finally { f.sandbox.release(); }
});

for (const ingress of ["identity", "http"] as const) test(`${ingress} caller identification waits for the Viewer to migrate a July registry`, async () => {
  const f = fixture();
  let migrated = false, keptLegacy = false;
  try {
    const request = ingress === "identity" ? {} : { name: "httpTaskCall", args: {
      toolName: "get_task", url: "http://127.0.0.1/api/mcp",
      headers: [["content-type", "application/json"], ["accept", "application/json, text/event-stream"]],
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_task", arguments: { taskId: "fixture-absent" } } },
    } };
    const result = await worker(f, request, { onLog: line => {
      if (!migrated && line.includes("caller-identification") && line.includes("StateStartupMutationRefused")) {
        keptLegacy = fs.existsSync(f.filename);
        migrated = true;
        f.migrate();
      }
    } });
    expect(migrated).toBe(true);
    expect(keptLegacy).toBe(true);
    if (result.reply.error) throw new Error(`identity failed: ${result.stderr}`);
    if (ingress === "identity") expect(result.reply.result).toEqual({ conversationId });
    else expect(result.reply.http).toMatchObject({ status: 200 });
  } finally { f.sandbox.release(); }
});

async function prepareViewer(f: ReturnType<typeof fixture>) {
    const child = ownFixtureChild(Bun.spawn([process.execPath, "--preload", OWNERSHIP_PRELOAD, "--eval",
      'const { initializeHotStateStoresAtStartup } = await import("./src/lib/viewerInstrumentation.ts"); await initializeHotStateStoresAtStartup();'], {
      env: { ...f.environment(), LLV_STATE_OWNER: "viewer", LLV_STATE_DIR: f.directory }, stdout: "pipe", stderr: "pipe",
    }));
    const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const code = await child.exited;
      const diagnostic = await errors;
      await output;
      if (code !== 0) throw new Error(`Viewer startup failed: ${diagnostic}`);
    } finally { clearTimeout(timer); }
}

function taskRequest() {
  return { name: "httpTaskCall", args: {
    toolName: "get_task", url: "http://127.0.0.1/api/mcp",
    headers: [["content-type", "application/json"], ["accept", "application/json, text/event-stream"]],
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_task", arguments: { taskId: "fixture-absent" } } },
  } };
}

test("Viewer startup prepares task receipts before an MCP reader needs them", async () => {
  const f = fixture(false);
  try {
    f.migrate();
    await prepareViewer(f);
    expect(fs.existsSync(path.join(f.directory, "mcp-receipts.sqlite"))).toBe(true);
    const result = await worker(f, taskRequest());
    expect(result.reply.http).toMatchObject({ status: 200 });
  } finally { f.sandbox.release(); }
});

test("a failed lazy task-service open recovers in the same worker after owner preparation", async () => {
  const f = fixture(false);
  try {
    f.migrate();
    const result = await worker(f, taskRequest(), { afterReply: async (reply, index) => {
      if (index !== 0) return null;
      expect(reply.http).toMatchObject({ status: 200 });
      expect(reply.body).toMatchObject({ result: { isError: true,
        structuredContent: { code: "receipts_not_ready", retryable: true } } });
      await prepareViewer(f);
      return taskRequest();
    } });
    expect(result.replies).toHaveLength(2);
    expect(result.reply.http).toMatchObject({ status: 200 });
    // The fixture has no task: reaching the binding proves preparation recovered.
    expect(result.reply.body).toMatchObject({ result: { structuredContent: {
      code: "tool_failed", error: "task not found",
    } } });
  } finally { f.sandbox.release(); }
});

test("a registry wait expires under its request deadline and a fresh worker can recover", async () => {
  const f = fixture();
  try {
    for (let generation = 0; generation < 2; generation++) {
      const result = await worker(f, {}, { deadlineMs: 1_000 });
      expect(result.reply.error).toBeDefined();
      expect(String(result.reply.error)).toMatch(/\((registry-busy|deadline)\)$/);
      expect(String(result.reply.error)).not.toContain(capability);
      expect(String(result.reply.error)).not.toContain(f.sandbox.home);
      expect(result.stderr).toContain("waiting-for-registry");
      expect(fs.existsSync(f.filename)).toBe(true);
    }
    f.migrate();
    expect((await worker(f, {})).reply.result).toEqual({ conversationId });
  } finally { f.sandbox.release(); }
});

test("the worker retains registry-busy when its bounded registry wait expires before the request", async () => {
  const f = fixture();
  try {
    const result = await worker(f, {}, { deadlineMs: 7_000 });
    expect(result.reply.error).toBe("task executor could not identify the caller (registry-busy)");
    expect(String(result.reply.error)).not.toContain(capability);
    expect(String(result.reply.error)).not.toContain(f.sandbox.home);
    expect(fs.existsSync(f.filename)).toBe(true);
  } finally { f.sandbox.release(); }
});

test("the real worker reports deadline when admission aborts during registry identification", async () => {
  const f = fixture();
  try {
    const result = await worker(f, {}, { cancelWhenWaiting: true });
    expect(result.reply.error).toBe("task executor could not identify the caller (deadline)");
    expect(String(result.reply.error)).not.toContain(capability);
    expect(String(result.reply.error)).not.toContain(f.sandbox.home);
  } finally { f.sandbox.release(); }
});

for (const ingress of ["identity", "http"] as const) test(`${ingress} rechecks a capability rotated while its registry wait was pending`, async () => {
  const f = fixture();
  let rotated = false;
  try {
    const result = await worker(f, ingress === "identity" ? {} : taskRequest(), { onLog: line => {
      if (!rotated && line.includes("waiting-for-registry")) {
        rotated = true;
        const legacy = JSON.parse(fs.readFileSync(f.filename, "utf8"));
        legacy.receipts.legacy.spawnCapabilityDigest = createHash("sha256").update("b".repeat(43)).digest("hex");
        fs.writeFileSync(f.filename, JSON.stringify(legacy));
        f.migrate();
      }
    } });
    expect(rotated).toBe(true);
    if (ingress === "identity") expect(result.reply.result).toEqual({ conversationId: null });
    else expect(result.reply.http).toMatchObject({ status: 403 });
    expect((await worker(f, { caller: { capability: "b".repeat(43) } })).reply.result).toEqual({ conversationId });
  } finally { f.sandbox.release(); }
});

const checkId = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");

for (const phase of ["caller-identification", "tool-service", "capability-unknown"] as const) {
  for (const [headerCase, supplied] of [["valid", checkId], ["capability", capability], ["oversized", "x".repeat(37)],
    ["path", path.join(process.env.HOME!, "private")], ["version", checkId.replace("4000", "3000")],
    ["variant", checkId.replace("8000", "7000")], ["newline", checkId + "\n"], ["absent", undefined]] as const) {
    test(`HTTP ${phase} bounds and validates check context ${headerCase}`, async () => {
      const { handleMcpHttpRequest, setMcpHttpDependenciesForTests } = await import("./http");
      const { MCP_CHECK_HEADER, MCP_REFUSAL_HEADER } = await import("./httpResponse");
      const { NextRequest } = await import("next/server");
      const logs: string[] = [];
      const secret = "credential".repeat(4);
      const filename = path.join(process.env.HOME!, "private", "registry.sqlite");
      const logging = spyOn(console, "error").mockImplementation(value => { logs.push(String(value)); });
      const { trackMcpClaim } = await import("../../../bin/mcp-lifecycle.mjs");
      const pending = Array.from({ length: 256 }, (_, index) => trackMcpClaim(`get_task:pending-${index}`, "fixture"));
      const fail = () => { throw new Error(`${capability} ${filename}\nAuthorization: Bearer ${secret}\n${"Ω".repeat(5_000)}`); };
      setMcpHttpDependenciesForTests({ service: async () => fail(), conversationForCapability: () => {
        if (phase === "caller-identification") return fail();
        return phase === "tool-service" ? conversationId : null;
      } });
      try {
        const request = new NextRequest("http://127.0.0.1/api/mcp", { method: "POST",
          headers: { host: "127.0.0.1", "content-type": "application/json", "x-llv-spawn-capability": capability,
            ...(supplied === undefined || supplied.includes("\n") ? {} : { [MCP_CHECK_HEADER]: supplied }) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        });
        // Native Headers rejects newlines. Exercise the receiver's validation
        // too without changing any other request field or method.
        const get = request.headers.get.bind(request.headers);
        if (supplied?.includes("\n")) spyOn(request.headers, "get").mockImplementation(name => name === MCP_CHECK_HEADER ? supplied : get(name));
        const response = await handleMcpHttpRequest(request);
        expect(response.status).toBe(phase === "capability-unknown" ? 403 : 503);
        expect(response.headers.get(MCP_REFUSAL_HEADER)).toBe(phase);
        expect(response.headers.has(MCP_CHECK_HEADER)).toBe(false);
        if (phase === "caller-identification") expect(response.headers.get("retry-after")).toBe("1");
        if (phase === "capability-unknown") { expect(logs).toEqual([]); return; }
        expect(logs).toHaveLength(1);
        const line = JSON.parse(logs[0]!.slice(logs[0]!.indexOf("{") ));
        expect(line.phase).toBe(phase);
        expect(line.operation).toBe(phase === "tool-service" ? "service-construction" : "registry-read");
        expect(line.check).toBe(supplied === checkId ? checkId : undefined);
        for (const value of [capability, secret, filename]) expect(logs[0]).not.toContain(value);
        expect(Buffer.byteLength(logs[0]!)).toBeLessThan(4096);
      } finally { for (const release of pending) release(); setMcpHttpDependenciesForTests(null); logging.mockRestore(); }
    });
  }
}

test("identification classes distinguish bounded registry waits, deadlines and read failures", async () => {
  const { callerIdentificationFailureClass, identifyCallerWhenReady } = await import("./callerIdentification");
  const { FileTransactionBusyError } = await import("@/lib/state/fileTransaction");
  const { StateLockDeferredError } = await import("@/lib/state/lockWait");
  const logging = spyOn(console, "error").mockImplementation(() => {});
  const signal = new AbortController();
  try {
    const expired = await identifyCallerWhenReady(() => null, capability, 0, signal.signal).catch(error => error);
    expect(callerIdentificationFailureClass(expired, 0, signal.signal)).toBe("deadline");
    signal.abort(new Error("private abort reason"));
    const aborted = await identifyCallerWhenReady(() => null, capability, Date.now() + 5000, signal.signal).catch(error => error);
    expect(callerIdentificationFailureClass(aborted, Date.now() + 5000, signal.signal)).toBe("deadline");
    for (const error of [new FileTransactionBusyError("private busy reason"), new StateLockDeferredError("fixture")]) {
      expect(callerIdentificationFailureClass(error, 0, signal.signal)).toBe("registry-busy");
    }
    expect(callerIdentificationFailureClass(new Error("private read reason"), Date.now() + 5000, new AbortController().signal)).toBe("registry-read-failed");
  } finally { logging.mockRestore(); }
});

for (const phase of ["caller-identification", "tool-service"] as const) test(`${phase} never logs parser input or stack frames`, async () => {
  const { handleMcpHttpRequest, setMcpHttpDependenciesForTests } = await import("./http");
  const { NextRequest } = await import("next/server");
  const logs: string[] = [];
  const logging = spyOn(console, "error").mockImplementation(value => { logs.push(String(value)); });
  const fail = () => { const error = new SyntaxError("private-parser-frame"); error.stack = "private-stack-frame"; throw error; };
  setMcpHttpDependenciesForTests({ service: async () => fail(), conversationForCapability: () => phase === "caller-identification" ? fail() : conversationId });
  try {
    const response = await handleMcpHttpRequest(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json", "x-llv-spawn-capability": capability },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }));
    expect(response.status).toBe(503); expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("SyntaxError"); expect(logs[0]).not.toContain("private-parser-frame"); expect(logs[0]).not.toContain("private-stack-frame");
  } finally { logging.mockRestore(); setMcpHttpDependenciesForTests(null); }
});

test("an HTTP MCP client initializes and discovers tools on migrated state across executor restarts", async () => {
  const f = fixture(false);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { NextRequest } = await import("next/server");
  const { handleMcpHttpRequest } = await import("./http");
  const { McpTaskExecutor } = await import("./taskExecutor");
  const workerPath = path.join(f.sandbox.temporaryRoot(), "fixture-worker.ts");
  fs.writeFileSync(workerPath, `await import(${JSON.stringify(pathToFileURL(OWNERSHIP_PRELOAD).href)});\nawait import(${JSON.stringify(pathToFileURL(path.resolve("src/lib/mcpTask.worker.ts")).href)});\n`);
  const executor = new McpTaskExecutor({ launch: { executable: process.execPath, workerPath },
    env: { ...f.environment(), LLV_STATE_DIR: f.directory, LLV_TOKEN: "" } });
  const key = Symbol.for("llv.mcp.taskExecutor");
  const holder = globalThis as typeof globalThis & { [key]?: InstanceType<typeof McpTaskExecutor> };
  const previous = holder[key]; holder[key] = executor;
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => handleMcpHttpRequest(new NextRequest(request)) });
  try {
    f.migrate();
    for (let generation = 0; generation < 2; generation++) {
      const client = new Client({ name: "caller-discovery-fixture", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
          requestInit: { headers: { "x-llv-spawn-capability": capability } },
        }));
        expect((await client.listTools()).tools.some(tool => tool.name === "list_tasks")).toBe(true);
      } finally { await client.close(); }
      await executor.close();
    }
    expect(fs.existsSync(path.join(f.directory, "mcp-receipts.sqlite"))).toBe(false);
  } finally {
    await executor.close(); listener.stop(true);
    if (previous) holder[key] = previous; else delete holder[key];
    f.sandbox.release();
  }
});
