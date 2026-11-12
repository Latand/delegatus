import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { guardViewerMcpStartup } from "./startup";
import { systemScheduler } from "@/lib/deadline";
import { ownExternalFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { MCP_CHECK_HEADER, MCP_CHECK_PATTERN, MCP_REFUSAL_HEADER } from "./httpResponse";
import { serveViewerDeploymentProxy, serveViewerLocalEntry } from "@/runtime-host/deploymentProxy";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { handleMcpHttpRequest, setMcpHttpDependenciesForTests } from "./http";
import type { NextRequest } from "next/server";

for (const mode of ["reset", "body-reset", "gateway", "revoked-after-reset", "malformed", "deadline", "deadline-in-backoff", "closed"] as const) {
  test(`established discovery handles ${mode} under one recovery deadline`, async () => {
    const original = { capability: process.env.LLV_SPAWN_CAPABILITY, origin: process.env.LLV_VIEWER_CONTROL_URL };
    process.env.LLV_SPAWN_CAPABILITY = "C".repeat(43);
    process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
    const input = new PassThrough(), output = new PassThrough();
    const transport = new StdioServerTransport(input, output);
    const deadlines: Array<{ ms: number; fire(): void; cleared: boolean; fired: boolean }> = [];
    const timing = spyOn(systemScheduler, "setTimeout").mockImplementation((callback, ms) => {
      const timer = { ms, fire() { timer.fired = true; callback(); }, cleared: false, fired: false };
      deadlines.push(timer); return timer;
    });
    const clearing = spyOn(systemScheduler, "clearTimeout").mockImplementation(handle => { (handle as typeof deadlines[number]).cleared = true; });
    let calls = 0, accepted = 0;
    let accept!: () => void;
    transport.onmessage = () => { accepted++; accept(); };
    const fetching = spyOn(globalThis, "fetch").mockImplementation((async () => {
      calls++;
      if (calls === 2) {
        if (mode === "deadline") deadlines.find(timer => timer.ms === 55_000)!.fire();
        if (mode === "deadline-in-backoff") setImmediate(() => deadlines.find(timer => timer.ms === 55_000)!.fire());
        if (mode === "closed") await transport.close();
        if (mode === "malformed") return new Response("private-response-sentinel");
        if (mode === "body-reset") return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError("private-response-sentinel")); },
        }));
        if (mode === "gateway") return new Response("private-response-sentinel", { status: 503 });
        throw new Error("private-response-sentinel");
      }
      if (calls > 2 && mode === "revoked-after-reset") return new Response("private-response-sentinel", { status: 403 });
      return Response.json({ result: { capabilities: { tools: {} } } });
    }) as unknown as typeof fetch);
    guardViewerMcpStartup(transport);
    try {
      await transport.start();
      const first = new Promise<void>(resolve => { accept = resolve; });
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n"); await first;
      const succeeds = mode === "reset" || mode === "body-reset" || mode === "gateway";
      const answer = succeeds
        ? new Promise<void>(resolve => { accept = resolve; }) : once(output, "data");
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      const result = await answer;
      if (succeeds) {
        expect(accepted).toBe(2); expect(calls).toBe(3);
      } else {
        expect(accepted).toBe(1);
        const error = JSON.parse(String((result as unknown[])[0])).error;
        expect(error.code).toBe(-32002);
        expect(error.message).toContain("tools/list check ");
        expect(error.message).not.toContain("private-response-sentinel");
        expect(calls).toBe(mode === "revoked-after-reset" ? 3 : 2);
        if (mode === "revoked-after-reset") expect(error.message).toContain("HTTP 403");
      }
      expect(deadlines.filter(timer => timer.ms === 55_000)).toHaveLength(1);
      expect(deadlines.every(timer => timer.cleared || timer.fired)).toBe(true);
    } finally {
      await transport.close(); input.destroy(); output.destroy();
      fetching.mockRestore(); timing.mockRestore(); clearing.mockRestore();
      for (const [name, value] of [["LLV_SPAWN_CAPABILITY", original.capability], ["LLV_VIEWER_CONTROL_URL", original.origin]]) {
        if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
      }
    }
  });
}

class OwnedStdioClientTransport extends StdioClientTransport {
  override async start(): Promise<void> {
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child) throw new Error("stdio fixture transport did not retain its child");
    ownExternalFixtureChild(child, () => this.close());
  }
}

test.each(["unknown", "malformed", "valid"])("stdio startup checks the %s launch capability against the Viewer", async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-startup-"));
  let admitted = mode === "valid";
  let probes = 0;
  setMcpHttpDependenciesForTests({
    conversationForCapability: () => admitted ? "test-conversation" : null,
    service: async () => ({ callTool: async () => { throw new Error("startup must execute no tools"); } }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    probes++;
    return handleMcpHttpRequest(request as NextRequest);
  } });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && !key.startsWith("LLV_") && !key.startsWith("DELEGATUS_"))) as Record<string, string>;
  const transport = new OwnedStdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dir, "entry.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."), stderr: "pipe", env: { ...environment, NODE_ENV: "test", HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"),
      LLV_VIEWER_CONTROL_URL: server.url.origin, LLV_SPAWN_CAPABILITY: mode === "malformed" ? "invalid" : "C".repeat(43) } });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "startup-test", version: "1" });
  try {
    if (mode === "valid") {
      await client.connect(transport);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      admitted = false;
      const error = await client.listTools().catch(reason => reason);
      expect(String(error)).toContain("HTTP 403, capability-unknown");
      expect(String(error)).toMatch(/tools\/list check [0-9a-f-]{36}/);
      expect(await savedFailure(String(error), root)).toContain(String(error).match(/tools\/list check [0-9a-f-]{36}/)![0]);
      expect(probes).toBe(3);
    } else {
      const error = await client.connect(transport).then(() => null, reason => reason);
      expect(String(error)).toContain("capability");
      expect(String(error)).toContain(path.join(root, "state"));
    }
    expect(stderr).not.toContain("C".repeat(43));
  } finally {
    await client.close();
    await transport.close();
    await reapFixtureChildren();
    await server.stop(true);
    setMcpHttpDependenciesForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

const privateBody = "private-response-sentinel";
const launchCapability = "C".repeat(43);

async function failingEntry(origin: string, inspect: (error: string, root: string) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-startup-refusal-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && !key.startsWith("LLV_") && !key.startsWith("DELEGATUS_"))) as Record<string, string>;
  const transport = new OwnedStdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dir, "entry.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."), stderr: "pipe", env: { ...environment, NODE_ENV: "test", HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"),
      LLV_VIEWER_CONTROL_URL: origin, LLV_SPAWN_CAPABILITY: launchCapability } });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "startup-refusal-test", version: "1" });
  try {
    const error = await client.connect(transport).then(() => "unexpected success", reason => String(reason));
    expect(error).toContain("initialize check ");
    await inspect(error, root);
    for (const value of [launchCapability, privateBody]) {
      expect(error).not.toContain(value); expect(stderr).not.toContain(value);
    }
  } finally {
    await client.close(); await transport.close(); await reapFixtureChildren(); fs.rmSync(root, { recursive: true, force: true });
  }
}

// Run the real launch failure writer and reopen its registry: this exercises
// both the engine's 500-character shaping and the receipt's own bound.
async function savedFailure(error: string, root: string): Promise<string> {
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { spawnStructuredConversation } = await import("@/lib/runtime/structuredSpawn");
  const { assertViewerMcpTools } = await import("@/lib/runtime/viewerMcpLaunch");
  const { redactCodexHostDiagnostic } = await import("@/lib/runtime/codexAppServerHost");
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    readSession: async (identity) => journal.readSession(identity), snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after), waitEvents: async (after) => journal.replay(after),
    append: async (event) => journal.append(event), operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command), operationStatus: async (id) => journal.operationResult(id),
    retryOperation: async (id) => journal.retryOperation(id), producerCursor: async (kind, prefix) => journal.producerCursor(kind, prefix),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
  } as import("@/lib/runtime/client").RuntimeHostClient;
  try {
    const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: root, transport: "structured", accountId: "fixture" });
    if (begun.kind !== "created") throw new Error("fixture admission failed");
    await expect(spawnStructuredConversation({ engine: "codex", receipt: begun.receipt, registry, client,
      spec: { command: "codex", cwd: root, windowName: "diagnostic-fixture", engine: "codex", transcript: path.join(root, "session.jsonl") },
      account: { engine: "codex", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" } },
      "prompt": "Synthetic startup fixture",
    }, { startHost: async () => {
      assertViewerMcpTools([{ name: "viewer", tools: {}, runtimeStatus: "failed",
        toolsError: redactCodexHostDiagnostic(`Viewer MCP: ${error}; ${"padding ".repeat(100)}`) }], root);
      throw new Error("unexpected catalog acceptance");
    }, deliverFirst: async () => { throw new Error("unexpected work delivery"); } })).rejects.toThrow("Viewer MCP launch failed");
    const reopened = new AgentRegistry(registry.filename, undefined, undefined, { sqliteMode: "off" });
    try {
      const receipt = reopened.spawnReceipt(begun.receipt.launchId)!;
      expect(receipt.state).toBe("failed");
      expect(receipt.error!.length).toBeLessThanOrEqual(500);
      return receipt.error!;
    } finally { reopened.close(); }
  } finally { registry.close(); journal.close(); }
}

for (const phase of ["caller-identification", "tool-service", "capability-unknown"] as const) {
  test(`real route ${phase} refusal correlates with the stdio startup failure through both proxies`, async () => {
    const logs: string[] = [], checks: string[] = [];
    const logging = spyOn(console, "error").mockImplementation(value => { logs.push(String(value)); });
    let probes = 0;
    setMcpHttpDependenciesForTests({ conversationForCapability: () => {
      if (phase === "caller-identification") throw new Error("fixture registry read failed");
      return phase === "capability-unknown" ? null : "fixture-conversation";
    }, service: async () => { throw new Error("fixture service failed"); } });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      probes++; checks.push(request.headers.get(MCP_CHECK_HEADER)!);
      return handleMcpHttpRequest(request as NextRequest);
    } });
    const proxyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-startup-proxy-"));
    const target = path.join(proxyRoot, "target.json");
    fs.writeFileSync(target, JSON.stringify({ endpoint: server.url.origin, image: "fixture", container: "fixture", revision: "fixture" }));
    const tcp = serveViewerDeploymentProxy(target, 0);
    const gateway = serveViewerLocalEntry(target, 0, "127.0.0.1", { gatewayFile: path.join(proxyRoot, "gateway.json"), releaseCredential: () => null });
    try {
      await Promise.all([once(tcp, "listening"), once(gateway, "listening")]);
      for (const proxy of [tcp, gateway]) {
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("missing proxy address");
        await failingEntry(`http://127.0.0.1:${address.port}`, async (error, root) => {
          expect(error).toContain(`HTTP ${phase === "capability-unknown" ? 403 : 503}, ${phase}`);
          const id = checks.at(-1)!;
          expect(id).toMatch(MCP_CHECK_PATTERN); expect(error).toContain(`initialize check ${id}`);
          if (phase !== "capability-unknown") {
            expect(logs.filter(line => line.includes(id))).toHaveLength(1);
            const saved = await savedFailure(error, root);
            expect(saved).toContain(`HTTP 503, ${phase}`); expect(saved).toContain(`initialize check ${id}`);
          }
        });
      }
      expect(probes).toBe(2); expect(new Set(checks).size).toBe(2);
      expect(logs).toHaveLength(phase === "capability-unknown" ? 0 : 2);
    } finally {
      await Promise.all([new Promise<void>(resolve => tcp.close(() => resolve())), new Promise<void>(resolve => gateway.close(() => resolve()))]);
      await server.stop(true); setMcpHttpDependenciesForTests(null); logging.mockRestore();
      fs.rmSync(proxyRoot, { recursive: true, force: true });
    }
  }, 30_000);
}

test("the real stable proxy's self-target refusal stays unlabelled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-startup-self-target-"));
  const target = path.join(root, "target.json");
  const proxy = serveViewerDeploymentProxy(target, 0);
  try {
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("missing proxy address");
    const origin = `http://127.0.0.1:${address.port}`;
    fs.writeFileSync(target, JSON.stringify({ endpoint: origin, image: "fixture", container: "fixture", revision: "fixture" }));
    await failingEntry(origin, error => { expect(error).toContain("HTTP 503, unlabelled"); });
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

for (const label of [undefined, launchCapability, privateBody, "future-refusal"]) test(`untrusted refusal label ${label === undefined ? "absent" : label === launchCapability ? "capability" : label === privateBody ? "body" : "future"} is discarded`, async () => {
  const checks: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    checks.push(request.headers.get(MCP_CHECK_HEADER)!);
    return new Response(privateBody, { status: 503, headers: label ? { [MCP_REFUSAL_HEADER]: label } : {} });
  } });
  try {
    for (let i = 0; i < 2; i++) await failingEntry(server.url.origin, error => {
      expect(error).toContain("HTTP 503, unlabelled");
      expect(error).toContain(checks.at(-1)!);
    });
    expect(checks).toHaveLength(2); expect(new Set(checks).size).toBe(2);
    for (const check of checks) {
      expect(check).toMatch(MCP_CHECK_PATTERN);
      expect(check).not.toContain(launchCapability.slice(0, 8));
      expect(check).not.toContain(createHash("sha256").update(launchCapability).digest("hex"));
    }
  } finally { await server.stop(true); }
}, 20_000);

for (const mode of ["refusal", "cancel-error", "fetch-error", "parse-error", "missing-tools", "deadline"] as const) {
  test(`${mode} keeps response and stream bytes private at the startup guard`, async () => {
    const env = { capability: process.env.LLV_SPAWN_CAPABILITY, origin: process.env.LLV_VIEWER_CONTROL_URL };
    process.env.LLV_SPAWN_CAPABILITY = launchCapability; process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
    const input = new PassThrough(), output = new PassThrough();
    const transport = new StdioServerTransport(input, output);
    const checks: string[] = [];
    const deadlines: Array<{ fire: () => void; ms: number; cleared: boolean; fired: boolean }> = [];
    const timing = spyOn(systemScheduler, "setTimeout").mockImplementation((callback, ms) => {
      const timer = { fire: () => { timer.fired = true; callback(); }, ms, cleared: false, fired: false };
      deadlines.push(timer); return timer;
    });
    const clearing = spyOn(systemScheduler, "clearTimeout").mockImplementation(handle => {
      (handle as typeof deadlines[number]).cleared = true;
    });
    let reads = 0, cancelled = 0, accepted = 0;
    const fetching = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
      checks.push(new Headers(init?.headers).get(MCP_CHECK_HEADER)!);
      if (mode === "deadline") return await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        deadlines.at(-1)!.fire();
      });
      if (mode === "fetch-error") throw new Error(`${launchCapability} ${privateBody}`);
      if (mode === "parse-error") return new Response(privateBody);
      if (mode === "missing-tools") return Response.json({ result: { capabilities: {} } });
      return new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new TextEncoder().encode(privateBody)); },
        cancel() { cancelled++; if (mode === "cancel-error") throw new Error(privateBody); },
      }, { highWaterMark: 0 }), { status: 503, headers: { [MCP_REFUSAL_HEADER]: privateBody } });
    }) as typeof fetch);
    transport.onmessage = () => { accepted++; };
    guardViewerMcpStartup(transport);
    try {
      await transport.start();
      for (const method of ["initialize", "tools/list"]) {
        const reply = once(output, "data");
        input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method }) + "\n");
        const error = JSON.parse(String((await reply)[0])).error;
        expect(error.code).toBe(-32002);
        expect(error.message).toContain(`${method} check ${checks.at(-1)}`);
        expect(error.message).not.toContain(privateBody); expect(error.message).not.toContain(launchCapability);
        if (mode === "refusal" || mode === "cancel-error") expect(error.message).toContain("HTTP 503, unlabelled");
      }
      expect(checks).toHaveLength(2); expect(new Set(checks).size).toBe(2); expect(accepted).toBe(0);
      expect(deadlines).toHaveLength(2);
      expect(deadlines.map(timer => timer.ms)).toEqual([10_000, 10_000]);
      expect(deadlines.every(timer => timer.cleared || timer.fired)).toBe(true);
      expect(reads).toBe(0); expect(cancelled).toBe(mode === "refusal" || mode === "cancel-error" ? 2 : 0);
    } finally {
      await transport.close(); input.destroy(); output.destroy(); fetching.mockRestore(); timing.mockRestore(); clearing.mockRestore();
      if (env.capability === undefined) delete process.env.LLV_SPAWN_CAPABILITY; else process.env.LLV_SPAWN_CAPABILITY = env.capability;
      if (env.origin === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = env.origin;
    }
  });
}
