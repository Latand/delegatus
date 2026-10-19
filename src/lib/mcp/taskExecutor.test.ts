import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import net from "node:net";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureIdentity } from "@/lib/testing/fixtureProcess";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { runAsMcpHttpCaller } from "./callerContext";
import { McpTaskExecutor, TaskExecutorReplies, TASK_EXECUTOR_HTTP_FRAME_BYTES, viewerTaskExecutor } from "./taskExecutor";
import type { McpToolResult } from "./server";
import { callTaskChannel, decodeTaskChannel, TASK_CHANNEL_CALLS, TASK_CHANNEL_HEADER, TASK_CHANNEL_REQUEST_HEADER, TASK_CHANNEL_INPUT_BYTES } from "./taskChannel";
import { peerCredentials } from "./nativePeer";

const seedTaskId = `00000000-0000-4000-8000-${String(0).padStart(12, "0")}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-executor-"));
for (const name of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) {
  process.env[name] = path.join(root, name); fs.mkdirSync(process.env[name]!, { recursive: true });
}
process.env.TMPDIR = root;
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
let capability: string;
let capabilities: string[];
const executors: McpTaskExecutor[] = [];
const create = (env?: Partial<NodeJS.ProcessEnv>) => {
  const executor = new McpTaskExecutor({ ...(process.env.LLV_MCP_TASK_WORKER_BUNDLE
    ? { launch: { executable: process.execPath, workerPath: path.resolve(process.env.LLV_MCP_TASK_WORKER_BUNDLE) } } : {}), ...(env ? { env } : {}) });
  executors.push(executor); return executor;
};
const call = (executor: McpTaskExecutor, name: string, args: Record<string, unknown>, context = {}) =>
  runAsMcpHttpCaller({ capability }, () => executor.callTool(name, args, context));
beforeAll(async () => {
  process.env.MCP_BENCH_READY = path.join(root, "capabilities.json");
  await (await import("../../../scripts/mcp-state-writer-benchmark")).stateWriterChild("seed");
  capabilities = JSON.parse(fs.readFileSync(process.env.MCP_BENCH_READY, "utf8"));
  capability = capabilities[0]!;
});
afterEach(async () => {
  await Promise.all(executors.splice(0).map(executor => executor.close()));
});
afterAll(async () => {
  await reapFixtureChildren();
  fs.rmSync(root, { recursive: true, force: true });
});

async function privateChannel(executor: McpTaskExecutor, token = capability) {
  const response = await executor.callHttpTool("get_task", {
    jsonrpc: "2.0", id: "channel-discovery", method: "tools/call", params: { name: "get_task", arguments: { taskId: seedTaskId } },
  }, new Request("http://127.0.0.1/api/mcp", { headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", [TASK_CHANNEL_REQUEST_HEADER]: "1",
  } }), { capability: token }, {});
  const channel = decodeTaskChannel(response.headers.get(TASK_CHANNEL_HEADER));
  expect(channel !== null).toBe(true);
  expect((await response.json() as { result: { structuredContent: McpToolResult } }).result.structuredContent.ok).toBe(true);
  return channel!;
}

test.skipIf(process.platform !== "linux")("a Viewer without a perimeter key can delegate managed task calls", async () => {
  const executor = create({ LLV_TOKEN: "", PORT: "" });
  const response = await executor.callHttpTool("get_task", {
    jsonrpc: "2.0", id: "unprotected-channel", method: "tools/call", params: { name: "get_task", arguments: { taskId: seedTaskId } },
  }, new Request("http://127.0.0.1/api/mcp", { headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", [TASK_CHANNEL_REQUEST_HEADER]: "1",
  } }), { capability }, {});
  expect(decodeTaskChannel(response.headers.get(TASK_CHANNEL_HEADER)) !== null).toBe(true);
  expect((await response.json() as { result: { structuredContent: McpToolResult } }).result.structuredContent.ok).toBe(true);
});

test.skipIf(process.platform !== "linux")("enabling the access key withdraws the old delegation before Settings returns", async () => {
  const savedToken = process.env.LLV_TOKEN, savedPort = process.env.PORT;
  process.env.LLV_TOKEN = ""; delete process.env.PORT;
  const executor = viewerTaskExecutor(); executors.push(executor);
  try {
    const channel = await privateChannel(executor);
    const { POST } = await import("@/app/api/links/route");
    const { NextRequest } = await import("next/server");
    const response = await POST(new NextRequest("http://127.0.0.1/api/links", {
      method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", origin: "http://127.0.0.1" }, body: JSON.stringify({ action: "key" }),
    }));
    expect(response.status).toBe(200);
    expect(Boolean(process.env.LLV_TOKEN)).toBe(true);
    expect(processIdentityStatus(channel.identity)).toBe("dead");
    await expect(privateCall(channel, "get_task", { taskId: seedTaskId })).rejects.toBeInstanceOf(Error);
    const successor = await privateChannel(executor);
    expect(successor.identity).not.toEqual(channel.identity);
  } finally {
    if (savedToken === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = savedToken;
    if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
  }
});

function privateCall(channel: NonNullable<ReturnType<typeof decodeTaskChannel>>, name: string, args: Record<string, unknown>, token = capability) {
  return callTaskChannel(channel, JSON.stringify({ jsonrpc: "2.0", id: "private-call", method: "tools/call", params: { name, arguments: args } }), token,
    new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" }), Date.now() + 30_000, new AbortController().signal);
}

test.skipIf(process.platform !== "linux")("the real task channel preserves command receipts, note attribution and wire escaping", async () => {
  const executor = create({ LLV_TOKEN: "fixture-perimeter-key", PORT: "" });
  const channel = await privateChannel(executor);
  const args = { project: "fixture", text: "Private task", details: "Exact\n\t🙂", board: "hidden", clientRequestId: "private-task-create" };
  const answer = await (await privateCall(channel, "create_task", args)).json() as { result: { structuredContent: McpToolResult } };
  const result = answer.result.structuredContent;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("private creation refused");
  expect(await call(executor, "create_task", args)).toMatchObject({ ok: true, replayed: true, taskId: result.taskId, revision: result.revision });
  const edit = await (await privateCall(channel, "update_task", { taskId: result.taskId, note: "private caller", clientRequestId: "private-task-note", full: true })).json() as { result: { structuredContent: McpToolResult } };
  const { agentRegistry } = await import("@/lib/agent/registry");
  const conversationId = agentRegistry().conversationIdForSpawnCapabilityDigest(createHash("sha256").update(capability).digest("hex"));
  expect(edit.result.structuredContent).toMatchObject({ ok: true, task: { details: args.details, note: { author: { conversationId } } } });
  expect((await privateCall(channel, "unknown_private_tool", {})).status).toBe(403);
});

for (const engine of ["codex-mcp-client", "claude-code"]) test.skipIf(process.platform !== "linux")(`${engine} private channel returns JSON once across worker restart`, async () => {
  for (let generation = 0; generation < 2; generation++) {
    const executor = create();
    try {
      const channel = await privateChannel(executor);
      for (const invalid of [false, true]) {
        const name = invalid ? "create_task" : "get_task";
        const args = invalid ? { clientRequestId: `format-invalid-${engine}`, project: "fixture", text: "Inspect the transport", details: 42 } : { taskId: seedTaskId };
        const response = await callTaskChannel(channel, JSON.stringify({ jsonrpc: "2.0", id: "format-fixture", method: "tools/call", params: { name, arguments: args } }), capability,
          new Headers({ accept: "application/json, text/event-stream", "content-type": "application/json", "user-agent": `${engine}/fixture` }), Date.now() + 30_000, new AbortController().signal);
        expect(response.status).toBe(200);
        const wire = await response.json() as { result: { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean } };
        expect(wire.result.structuredContent).toBeUndefined();
        expect(wire.result.content).toHaveLength(1);
        expect(JSON.parse(wire.result.content[0].text)).toMatchObject(invalid ? { ok: false, code: "TASK_INVALID_FIELD" } : { ok: true, toolName: "get_task" });
        expect(wire.result.isError === true).toBe(invalid);
      }
    } finally { await executor.close(); }
  }
});

test.skipIf(process.platform !== "linux")("private receipt replay observes external capability rotation and worker replacement", async () => {
  const executor = create({ LLV_TOKEN: "fixture-perimeter-key", PORT: "" });
  const token = capabilities[5]!;
  const channel = await privateChannel(executor, token);
  const args = { project: "fixture", text: "Private rotation", board: "hidden", clientRequestId: "private-task-rotation" };
  const accepted = await (await privateCall(channel, "create_task", args, token)).json() as { result: { structuredContent: McpToolResult } };
  const result = accepted.result.structuredContent;
  if (!result.ok) throw new Error("private creation refused");
  const { agentRegistry } = await import("@/lib/agent/registry");
  const registry = agentRegistry();
  const conversationId = registry.conversationIdForSpawnCapabilityDigest(createHash("sha256").update(token).digest("hex"));
  const receipt = Object.values(registry.readOnlySnapshot().receipts).find(row => row.conversationId === conversationId)!;
  const successor = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  const refused = await privateCall(channel, "create_task", args, token);
  expect(refused.status).toBe(403); expect((await refused.text()).includes(String(result.taskId))).toBe(false);
  const replayed = await (await privateCall(channel, "create_task", args, successor)).json() as { result: { structuredContent: McpToolResult } };
  expect(replayed.result.structuredContent).toMatchObject({ ok: true, replayed: true, taskId: result.taskId, revision: result.revision });
  await executor.close();
  await expect(privateCall(channel, "get_task", { taskId: result.taskId }, successor)).rejects.toBeInstanceOf(Error);
  const replacement = create({ LLV_TOKEN: "fixture-perimeter-key", PORT: "" });
  const next = await privateChannel(replacement, successor);
  const afterRestart = await (await privateCall(next, "create_task", args, successor)).json() as { result: { structuredContent: McpToolResult } };
  expect(afterRestart.result.structuredContent).toMatchObject({ ok: true, replayed: true, taskId: result.taskId, revision: result.revision });
});

test.skipIf(process.platform !== "linux")("new private calls are refused after their Viewer loses release traffic", async () => {
  const target = path.join(process.env.LLV_STATE_DIR!, "viewer-release.json");
  const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const executor = create({ LLV_TOKEN: "fixture-perimeter-key", PORT: "1" });
  try {
    if (previous) fs.rmSync(target);
    const channel = await privateChannel(executor);
    fs.writeFileSync(target, JSON.stringify({ endpoint: "http://127.0.0.1:2" }));
    expect((await privateCall(channel, "get_task", { taskId: seedTaskId })).status).toBe(403);
  } finally { if (previous) fs.writeFileSync(target, previous); else fs.rmSync(target, { force: true }); }
});

test.skipIf(process.platform !== "linux")("stdio task calls use the delegated worker and retry a retired channel through the Viewer once", async () => {
  const key = Symbol.for("llv.mcp.taskExecutor");
  const holder = globalThis as typeof globalThis & { [key]?: McpTaskExecutor };
  const previous = holder[key];
  const keys = ["LLV_VIEWER_CONTROL_URL", "LLV_VIEWER_CONTROL_TOKEN", "LLV_SPAWN_CAPABILITY"] as const;
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const { NextRequest } = await import("next/server");
  const { handleMcpHttpRequest } = await import("./http");
  const { createProductionViewerMcpService } = await import("./server");
  let requests = 0;
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    requests++;
    if (request.headers.get("authorization") !== "Bearer fixture-perimeter-key") return new Response(null, { status: 403 });
    return handleMcpHttpRequest(new NextRequest(request));
  } });
  const executor = create({ LLV_TOKEN: "fixture-perimeter-key", PORT: "" }); holder[key] = executor;
  process.env.LLV_VIEWER_CONTROL_URL = listener.url.origin;
  process.env.LLV_VIEWER_CONTROL_TOKEN = "fixture-perimeter-key";
  process.env.LLV_SPAWN_CAPABILITY = capability;
  try {
    const adapter = await createProductionViewerMcpService(false, true);
    const args = { project: "fixture", text: "Delegated adapter", board: "hidden", clientRequestId: "private-adapter-create" };
    const created = await adapter.callTool("create_task", args);
    if (!created.ok) throw new Error("adapter creation refused");
    expect(requests).toBe(1);
    const edit = { taskId: created.taskId, appendLine: "one private line", clientRequestId: "private-adapter-edit" };
    const changed = await adapter.callTool("update_task", edit);
    expect(changed.ok).toBe(true); expect(requests).toBe(1);
    if (!changed.ok) throw new Error("private edit refused");
    await executor.close(); holder[key] = create({ LLV_TOKEN: "fixture-perimeter-key", PORT: "" });
    expect(await adapter.callTool("update_task", edit)).toMatchObject({ ok: true, replayed: true, revision: changed.revision });
    expect(requests).toBe(2);
    const read = await adapter.callTool("get_task", { taskId: created.taskId, full: true });
    expect(JSON.stringify(read).match(/one private line/g)).toHaveLength(1); expect(requests).toBe(2);
  } finally {
    listener.stop(true);
    if (previous) holder[key] = previous; else delete holder[key];
    for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  }
}, 15_000);

test.skipIf(process.platform !== "linux")("private inputs and pipe jobs share call and byte admission, and disconnects restore it", async () => {
  const executor = create({ LLV_TOKEN: "fixture-perimeter-key", PORT: "" });
  const channel = await privateChannel(executor);
  const sockets: net.Socket[] = [];
  const responses: number[] = [];
  let full!: () => void;
  const args = { taskId: seedTaskId, padding: "x".repeat(8192) };
  const hold = async (bytes: number) => {
    const socket = net.createConnection(channel.socketPath); sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      const tab = chunk.indexOf(9);
      if (tab >= 0) {
        const status = (JSON.parse(chunk.subarray(0, tab).toString("utf8")) as { status: number }).status;
        responses.push(status); if (status === 503) full?.();
      }
    });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    expect(peerCredentials(socket).pid).toBe(channel.identity.pid);
    socket.write(JSON.stringify({ nonce: channel.nonce, capability, deadlineAt: Date.now() + 30_000, bytes, headers: [] }) + "\t");
  };
  const refusal = () => expect(call(executor, "get_task", args)).rejects.toThrow("admission");
  const restore = async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (let step = 0; step < 64; step++) {
      try { expect((await call(executor, "get_task", args)).ok).toBe(true); return; }
      catch (error) { if (!(error as Error).message.includes("admission")) throw error; }
    }
    throw new Error("disconnected input retained pipe admission");
  };
  const fill = async (count: number, bytes: number) => {
    let timer: ReturnType<typeof setTimeout>;
    const filled = new Promise<void>((resolve, reject) => {
      full = resolve;
      timer = setTimeout(() => reject(new Error(`private admission did not refuse its extra input before the protocol deadline (replies=${responses.join(",")})`)), 30_000);
    });
    void filled.catch(() => {});
    try {
      // The refused extra private input proves its peers hold admission before
      // a pipe probe can race a not-yet-read private header.
      for (let n = 0; n < count; n++) await hold(bytes);
      await filled;
    } finally { clearTimeout(timer!); full = () => {}; }
  };
  try {
    await fill(2, TASK_CHANNEL_INPUT_BYTES - 4096);
    await refusal(); await restore();
    await fill(TASK_CHANNEL_CALLS + 1, 2);
    await refusal();
    const peer = create({ LLV_TOKEN: "fixture-perimeter-key", PORT: "" });
    expect((await call(peer, "get_task", { taskId: args.taskId })).ok).toBe(true);
    await restore();
  } finally { for (const socket of sockets) socket.destroy(); }
}, 45_000);

test("HTTP pipe replies expose headers before the body ends and preserve split UTF-8 bytes", async () => {
  const source = new PassThrough();
  const completed: number[] = [], errors: Error[] = [];
  let response: Response | undefined;
  let headersArrived!: () => void;
  const headers = new Promise<void>(resolve => { headersArrived = resolve; });
  const wire = new TaskExecutorReplies(source, value => {
    if (!value.http) throw new Error("expected HTTP reply");
    response = new Response(value.http.body, value.http);
    headersArrived();
  }, id => completed.push(id), error => errors.push(error));
  try {
    const header = Buffer.from(JSON.stringify({ id: 1, http: { status: 200, headers: [["content-type", "application/json"]] } }) + "\t");
    const body = Buffer.from('"' + "x".repeat(16_383) + "🙂" + "λ".repeat(100_000) + '"');
    source.write(header.subarray(0, 7)); source.write(header.subarray(7));
    await headers;
    expect(response).toBeDefined(); expect(completed).toEqual([]);
    let settled = false;
    const result = response!.text().then(value => { settled = true; return value; });
    source.write(body.subarray(0, 16_386)); // Ends inside the emoji's UTF-8 bytes.
    await Bun.sleep(0); expect(settled).toBe(false);
    for (let offset = 16_386; offset < body.length; offset += 4_093) source.write(body.subarray(offset, offset + 4_093));
    source.write("\n");
    expect(await result).toBe(body.toString("utf8"));
    expect(completed).toEqual([1]); expect(errors).toEqual([]);
  } finally { wire.close(); source.destroy(); }
});

test("a slow HTTP consumer pauses the pipe and cancellation drains through the next reply", async () => {
  const source = new PassThrough();
  const completed: number[] = [], errors: Error[] = [], replies: unknown[] = [];
  let finished!: () => void;
  const drained = new Promise<void>(resolve => { finished = resolve; });
  let body: ReadableStream<Uint8Array> | undefined;
  const wire = new TaskExecutorReplies(source, value => {
    replies.push(value);
    if (value.http) body = value.http.body;
  }, id => { completed.push(id); if (id === 2) finished(); }, error => errors.push(error));
  try {
    source.write(JSON.stringify({ id: 1, http: { status: 200, headers: [] } }) + "\t");
    source.write(Buffer.alloc(65_536, 120));
    source.write(Buffer.alloc(65_536, 121));
    expect(source.isPaused()).toBe(true); expect(completed).toEqual([]);
    await body!.cancel();
    source.write(Buffer.from('tail\n{"id":2,"result":{"conversationId":null}}\n'));
    await drained;
    expect(completed).toEqual([1, 2]); expect(replies).toHaveLength(2); expect(errors).toEqual([]);
  } finally { wire.close(); source.destroy(); }
});

test("a buffered HTTP answer yields to an independent timer and preserves its following frame", async () => {
  const source = new PassThrough();
  const completed: number[] = [], errors: Error[] = [];
  let body: ReadableStream<Uint8Array> | undefined;
  let finished!: () => void;
  const drained = new Promise<void>(resolve => { finished = resolve; });
  const wire = new TaskExecutorReplies(source, value => {
    if (value.http) body = value.http.body;
  }, id => { completed.push(id); if (id === 2) finished(); }, error => errors.push(error));
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 0);
  try {
    source.write(JSON.stringify({ id: 1, http: { status: 200, headers: [] } }) + "\t");
    const reading = new Response(body).text();
    // Let the empty pipe resume before one already-buffered answer arrives.
    await new Promise<void>(resolve => setImmediate(resolve));
    ticks = 0;
    const payload = "x".repeat(4 * 1024 * 1024);
    source.end(payload + '\n{"id":2,"result":{"conversationId":null}}\n');
    expect(await reading).toBe(payload);
    await drained;
    expect(ticks).toBeGreaterThan(0);
    expect(completed).toEqual([1, 2]); expect(errors).toEqual([]);
  } finally { clearInterval(timer); wire.close(); source.destroy(); }
});

test("worker loss errors an HTTP body whose headers already arrived", async () => {
  const source = new PassThrough();
  let body: ReadableStream<Uint8Array> | undefined;
  const wire = new TaskExecutorReplies(source, value => {
    if (value.http) body = value.http.body;
  }, () => {}, () => {});
  try {
    source.write(JSON.stringify({ id: 1, http: { status: 200, headers: [] } }) + "\tpart");
    const reader = body!.getReader(); await reader.read();
    const pending = reader.read();
    wire.close(new Error("fixture worker ended"));
    await expect(pending).rejects.toThrow("fixture worker ended");
  } finally { wire.close(); source.destroy(); }
});

test("HTTP byte streaming keeps the complete wire bound across backpressure and chunk boundaries", async () => {
  for (const extra of [0, 1]) {
    const source = new PassThrough();
    const completed: number[] = [], errors: Error[] = [];
    let body: ReadableStream<Uint8Array> | undefined;
    const wire = new TaskExecutorReplies(source, value => {
      if (value.http) body = value.http.body;
    }, id => completed.push(id), error => errors.push(error));
    try {
      const header = JSON.stringify({ id: 1, http: { status: 200, headers: [] } }) + "\t";
      source.write(header);
      const reader = body!.getReader();
      const reading = (async () => {
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return bytes;
          bytes += chunk.value.byteLength;
        }
      })().then(bytes => bytes, error => error as Error);
      const bytes = TASK_EXECUTOR_HTTP_FRAME_BYTES - Buffer.byteLength(header) - 1 + extra;
      // Reuse one immutable chunk; the control exercises the full wire bound
      // without allocating a complete response on the test thread.
      const chunk = Buffer.alloc(1_048_576, 120);
      for (let offset = 0; offset < bytes; offset += chunk.length) source.write(chunk.subarray(0, Math.min(chunk.length, bytes - offset)));
      source.write("\n");
      const result = await reading;
      if (extra) {
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toContain("exceeds its bound");
        expect(completed).toEqual([]); expect(errors).toHaveLength(1);
      } else {
        expect(result).toBe(bytes); expect(completed).toEqual([1]); expect(errors).toEqual([]);
      }
    } finally { wire.close(); source.destroy(); }
  }
});

test("HTTP frame metadata has its own small decoding bound", async () => {
  for (const extra of [0, 1]) {
    const source = new PassThrough();
    const completed: number[] = [], errors: Error[] = [];
    let body: ReadableStream<Uint8Array> | undefined;
    const wire = new TaskExecutorReplies(source, value => {
      if (value.http) body = value.http.body;
    }, id => completed.push(id), error => errors.push(error));
    try {
      const header = (padding: number) => JSON.stringify({ id: 1, http: { status: 200, headers: [["x-fixture", "x".repeat(padding)]] } });
      source.write(header(16_384 - Buffer.byteLength(header(0)) + extra) + "\t\n");
      if (extra) {
        expect(body).toBeUndefined(); expect(completed).toEqual([]);
        expect(errors).toHaveLength(1); expect(errors[0]!.message).toContain("header exceeds its bound");
      } else {
        expect(await new Response(body).text()).toBe(""); expect(completed).toEqual([1]); expect(errors).toEqual([]);
      }
    } finally { wire.close(); source.destroy(); }
  }
});

test("the real executor exposes HTTP headers while its worker holds the body tail", async () => {
  const ready = path.join(root, "partial-http.ready"), release = path.join(root, "partial-http.release");
  const executor = new McpTaskExecutor({
    launch: { executable: process.execPath, workerPath: path.join(import.meta.dir, "writerConcurrencyChild.ts") },
    env: { LLV_TASK_EXECUTOR_HTTP_PARTIAL: release, LLV_WRITER_READY: ready },
  });
  executors.push(executor);
  try {
    const response = await executor.callHttpTool("get_task", {}, new Request("http://127.0.0.1/api/mcp"), { capability }, { deadlineAt: Date.now() + 3_000 });
    expect(fs.existsSync(release)).toBe(false);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"message":"partial');
    fs.writeFileSync(release, "release");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(' response"}');
    expect((await reader.read()).done).toBe(true);
  } finally { fs.writeFileSync(release, "release"); await executor.close(); }
});

test("capability lookup observes external rotation without retaining an authorization cache", async () => {
  const executor = create();
  const token = capabilities[2]!;
  const conversationId = await executor.identifyCapability(token);
  expect(typeof conversationId).toBe("string");
  expect(await executor.identifyCapability("unknown")).toBeNull();
  const { agentRegistry } = await import("@/lib/agent/registry");
  const registry = agentRegistry();
  const receipt = Object.values(registry.readOnlySnapshot().receipts).find(row => row.conversationId === conversationId)!;
  const successor = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
  expect(await executor.identifyCapability(token)).toBeNull();
  expect(await executor.identifyCapability(successor)).toBe(conversationId);
});

test("isolated HTTP dispatch preserves the SDK envelope and direct-service receipt replay", async () => {
  const executor = create();
  const args = { project: "fixture", text: "HTTP pipe task", details: "Exact text\n\t\\ 🙂", board: "hidden", clientRequestId: "executor-http-wire", full: true };
  const request = new Request("http://127.0.0.1/api/mcp", { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
  } });
  const response = await executor.callHttpTool("create_task", {
    jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "create_task", arguments: args },
  }, request, { capability }, {});
  expect(response.status).toBe(200);
  const wire = await response.json() as { id: number; result: { content: Array<{ text: string }>; structuredContent: Record<string, unknown> } };
  expect(wire.id).toBe(7);
  expect(JSON.parse(wire.result.content[0]!.text)).toEqual(wire.result.structuredContent);
  expect(wire.result.structuredContent).toMatchObject({ ok: true, task: { text: args.text, details: args.details } });
  expect(await call(executor, "create_task", args)).toMatchObject({
    ok: true, replayed: true, taskId: wire.result.structuredContent.taskId, revision: wire.result.structuredContent.revision,
  });
});

test("task HTTP calls authenticate unknown and rotated capabilities before receipt replay", async () => {
  const executor = create();
  const key = Symbol.for("llv.mcp.taskExecutor");
  const holder = globalThis as typeof globalThis & { [key]?: McpTaskExecutor };
  const previous = holder[key]; holder[key] = executor;
  const { NextRequest } = await import("next/server");
  const { handleMcpHttpRequest } = await import("./http");
  const token = capabilities[3]!;
  const conversationId = await executor.identifyCapability(token);
  const args = { project: "fixture", text: "HTTP caller authentication", board: "hidden", clientRequestId: "executor-http-auth" };
  const post = (capability: string, framed = true, large = false, malformed = false) => {
    const body = malformed ? "{" : JSON.stringify({ jsonrpc: "2.0", id: 19, method: "tools/call", params: {
      name: "create_task", arguments: { ...args, ...(large ? { details: "x".repeat(16_384) } : {}) },
    } });
    return handleMcpHttpRequest(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", body, headers: {
      host: "127.0.0.1", "content-type": "application/json", accept: "application/json, text/event-stream", "x-llv-spawn-capability": capability,
      ...(framed ? { "content-length": String(Buffer.byteLength(body)) } : {}),
    } }));
  };
  try {
    const response = await post(token);
    const accepted = await response.json() as { result?: { structuredContent: McpToolResult } };
    if (response.status !== 200 || !accepted.result) throw new Error(JSON.stringify({ status: response.status, accepted }));
    const result = accepted.result.structuredContent;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(typeof result.taskId).toBe("string");
    expect(typeof result.revision).toBe("string");
    for (const [framed, large] of [[false, false], [true, false], [true, true]]) {
      const refused = await post("q".repeat(43), framed, large);
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain(String(result.taskId));
    }
    expect((await post("q".repeat(43), true, false, true)).status).toBe(403);
    expect((await post(token, true, false, true)).status).toBe(400);
    const { agentRegistry } = await import("@/lib/agent/registry");
    const registry = agentRegistry();
    const receipt = Object.values(registry.readOnlySnapshot().receipts).find(row => row.conversationId === conversationId)!;
    const successor = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
    for (const framed of [false, true]) {
      const refused = await post(token, framed);
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain(String(result.taskId));
    }
    const replay = await (await post(successor)).json() as { result: { structuredContent: McpToolResult } };
    expect(replay.result.structuredContent).toMatchObject({ ok: true, replayed: true, taskId: result.taskId, revision: result.revision });
  } finally { if (previous) holder[key] = previous; else delete holder[key]; }
});

test("isolated task service preserves receipts, identity, revisions and same-key replay across executors", async () => {
  const first = create();
  const created = await call(first, "create_task", { project: "fixture", text: "Executor task", board: "hidden", clientRequestId: "executor-create" });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(JSON.stringify(created));
  const taskId = created.taskId;
  expect(typeof taskId).toBe("string");
  const edited = await call(first, "update_task", { taskId, appendLine: "one durable edit", clientRequestId: "executor-edit" });
  expect(edited.ok).toBe(true);
  if (!edited.ok) throw new Error(JSON.stringify(edited));
  await first.close();
  const successor = create();
  const replayed = await call(successor, "update_task", { taskId, appendLine: "one durable edit", clientRequestId: "executor-edit" });
  expect(replayed).toMatchObject({ ok: true, replayed: true, revision: edited.revision });
  const conflict = await call(successor, "update_task", { taskId, text: "Different payload", clientRequestId: "executor-edit" });
  expect(conflict.ok).toBe(false);
  const stale = await call(successor, "update_task", { taskId, text: "Stale edit", expectedProject: "fixture", expectedRevision: created.revision, clientRequestId: "executor-stale" });
  expect(stale.ok).toBe(false);
  const task = await call(successor, "get_task", { taskId, full: true });
  expect(JSON.stringify(task)).toContain("one durable edit");
  expect(JSON.stringify(task).match(/one durable edit/g)).toHaveLength(1);
  const { NextRequest } = await import("next/server");
  const { handleMcpHttpRequest } = await import("./http");
  const refused = await handleMcpHttpRequest(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", "x-llv-spawn-capability": "invalid" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_task", arguments: { taskId, appendLine: "one durable edit", clientRequestId: "executor-edit" } } }),
  }));
  expect(refused.status).toBe(403);
  expect(await refused.text()).not.toContain(String(edited.revision));
});

test("caller cancellation does not claim that the original mutation never ran", async () => {
  const executor = create();
  const caller = new AbortController(); caller.abort();
  await expect(call(executor, "create_task", { project: "fixture", text: "Cancelled", clientRequestId: "executor-cancel" }, { signal: caller.signal })).rejects.toThrow("before dispatch");
  const result = await call(executor, "create_task", { project: "fixture", text: "Cancelled", clientRequestId: "executor-cancel" });
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(result.ok).toBe(true);
});

test("concurrent callers keep their own server-derived note attribution across the pipe", async () => {
  const executor = create();
  const { agentRegistry } = await import("@/lib/agent/registry");
  const expected = capabilities.slice(0, 2).map(token => {
    const id = agentRegistry().conversationIdForSpawnCapabilityDigest(createHash("sha256").update(token).digest("hex"));
    if (!id) throw new Error("fixture caller has no conversation");
    return id;
  });
  expect(expected[0]).not.toBe(expected[1]);
  const results = await Promise.all(capabilities.slice(0, 2).map((token, n) =>
    runAsMcpHttpCaller({ capability: token }, async () => {
      const created = await executor.callTool("create_task", {
        project: "fixture", text: `Attributed task ${n}`, board: "hidden", clientRequestId: `attributed-${n}`,
      });
      if (!created.ok) throw new Error(JSON.stringify(created));
      return executor.callTool("update_task", { taskId: created.taskId, note: `Caller ${n}`, clientRequestId: `attributed-note-${n}`, full: true });
    })));
  for (let n = 0; n < results.length; n++) {
    const result = results[n]!;
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect((result.task as { note: { author: { conversationId: string } } }).note.author.conversationId).toBe(expected[n]);
  }
});

test("timed-out replies retain admission until the executor settles or closes", async () => {
  const ready = path.join(root, "stalled-worker.pid");
  const executor = new McpTaskExecutor({ launch: { executable: process.execPath, workerPath: path.join(import.meta.dir, "writerConcurrencyChild.ts") },
    env: { LLV_TASK_EXECUTOR_STALL: "1", LLV_WRITER_READY: ready } });
  executors.push(executor);
  const deadlineAt = Date.now() + 100;
  const pending = Array.from({ length: 64 }, (_, n) => call(executor, "update_task", { taskId: "held", clientRequestId: `held-${n}` }, { deadlineAt }));
  const outcomes = await Promise.allSettled(pending);
  expect(outcomes.every(result => result.status === "rejected")).toBe(true);
  await expect(call(executor, "list_tasks", {})).rejects.toThrow("admission is full");
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
  const identity = captureProcessIdentity(Number(fs.readFileSync(ready, "utf8")));
  while (identity && processIdentityStatus(identity) === "alive" && Date.now() < deadline) await Bun.sleep(10);
  if (identity) expect(processIdentityStatus(identity)).not.toBe("alive");
  await expect(call(executor, "list_tasks", {}, { deadlineAt: Date.now() + 10 })).rejects.toThrow("timed out");
  await executor.close();
});

test("retiring before a queued dispatch releases its byte reservation once", async () => {
  const ready = path.join(root, "queued-retirement.ready");
  const executor = new McpTaskExecutor({
    launch: { executable: process.execPath, workerPath: path.join(import.meta.dir, "writerConcurrencyChild.ts") },
    env: { LLV_TASK_EXECUTOR_REPORT_PID: "1", LLV_WRITER_READY: ready },
  });
  executors.push(executor);
  await call(executor, "get_task", { taskId: seedTaskId });
  const queued = call(executor, "get_task", { padding: "x".repeat(3 * 1024 * 1024) });
  void queued.catch(() => {});
  const closed = executor.close();
  await expect(queued).rejects.toThrow("before its reply");
  await closed; fs.unlinkSync(ready);
  await expect(call(executor, "get_task", { padding: "x".repeat(5 * 1024 * 1024) })).rejects.toThrow("admission is full");
  expect(fs.existsSync(ready)).toBe(false);
});

test("idle retirement closes the real executor before the next request starts one", async () => {
  const ready = path.join(root, "idle-worker.pid");
  const executor = new McpTaskExecutor({ idleMs: 10,
    launch: { executable: process.execPath, workerPath: path.join(import.meta.dir, "writerConcurrencyChild.ts") },
    env: { LLV_TOKEN: "fixture-perimeter-key", PORT: "", LLV_TASK_EXECUTOR_REPORT_PID: "1", LLV_WRITER_READY: ready } });
  executors.push(executor);
  const pending = call(executor, "list_tasks", { project: "fixture", limit: 1 });
  void pending.catch(() => {});
  const readyDeadline = Date.now() + 5_000;
  while (!fs.existsSync(ready) && Date.now() < readyDeadline) await Bun.sleep(10);
  const identity = captureProcessIdentity(Number(fs.readFileSync(ready, "utf8")))!;
  expect((await pending).ok).toBe(true);
  const shutdown = Date.now() + 3_000;
  while (processIdentityStatus(identity) === "alive" && Date.now() < shutdown) await Bun.sleep(10);
  expect(processIdentityStatus(identity)).not.toBe("alive");
  fs.rmSync(ready);
  const next = call(executor, "list_tasks", { project: "fixture", limit: 1 });
  void next.catch(() => {});
  const replacementDeadline = Date.now() + 5_000;
  while (!fs.existsSync(ready) && Date.now() < replacementDeadline) await Bun.sleep(10);
  const replacement = captureProcessIdentity(Number(fs.readFileSync(ready, "utf8")));
  expect(replacement.startIdentity === identity.startIdentity && replacement.pid === identity.pid).toBe(false);
  expect((await next).ok).toBe(true);
  await executor.close();
});

test("the real task worker refuses before application imports without an explicit state directory", async () => {
  const env = { ...process.env };
  for (const name of ["LLV_STATE_DIR", "DELEGATUS_STATE_DIR", "LLV_STATE_OWNER", "DELEGATUS_STATE_OWNER"]) delete env[name];
  const child = ownFixtureChild(Bun.spawn({ cmd: [process.execPath, path.resolve("src/lib/mcpTask.worker.ts")],
    env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }));
  const output = new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(await output).toContain("task executor needs an explicit state directory");
});

for (const protectedWorker of [false, true]) test.skipIf(process.platform !== "linux")(`hard Viewer death ends its actual task executor and guardian within three seconds (protected=${protectedWorker})`, async () => {
  const ready = path.join(root, `owner-${protectedWorker}.ready`);
  const parent = ownFixtureChild(Bun.spawn({ cmd: [process.execPath, path.join(import.meta.dir, "writerConcurrencyChild.ts")],
    env: { ...process.env, LLV_TOKEN: protectedWorker ? "fixture-perimeter-key" : "", LLV_TASK_EXECUTOR_OWNER: capability, LLV_WRITER_READY: ready }, stdout: "ignore", stderr: "pipe" }));
  const stderr = new Response(parent.stderr).text();
  const owned: ProcessIdentity[] = [];
  const descendants = (pid: number): number[] => {
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
    return children.flatMap(child => [child, ...descendants(child)]);
  };
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready)) {
      if (parent.exitCode !== null) throw new Error(await stderr);
      if (Date.now() > deadline) throw new Error("task executor owner did not become ready");
      await Bun.sleep(10);
    }
    owned.push(...descendants(parent.pid).map(pid => captureProcessIdentity(pid)!));
    expect(owned.length).toBeGreaterThanOrEqual(2);
    parent.kill("SIGKILL"); await parent.exited;
    const shutdown = Date.now() + 3_000;
    while (owned.some(identity => processIdentityStatus(identity) === "alive") && Date.now() < shutdown) await Bun.sleep(10);
    expect(owned.map(identity => processIdentityStatus(identity))).not.toContain("alive");
  } finally { for (const identity of owned) await stopFixtureIdentity(identity); }
}, 15_000);
