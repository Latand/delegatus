import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureIdentity } from "@/lib/testing/fixtureProcess";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { runAsMcpHttpCaller } from "./callerContext";
import { McpTaskExecutor, TaskExecutorReplies, TASK_EXECUTOR_HTTP_FRAME_BYTES } from "./taskExecutor";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-executor-"));
for (const name of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) {
  process.env[name] = path.join(root, name); fs.mkdirSync(process.env[name]!, { recursive: true });
}
process.env.TMPDIR = root;
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
let capability: string;
let capabilities: string[];
const executors: McpTaskExecutor[] = [];
const create = () => {
  const executor = new McpTaskExecutor(process.env.LLV_MCP_TASK_WORKER_BUNDLE
    ? { launch: { executable: process.execPath, workerPath: path.resolve(process.env.LLV_MCP_TASK_WORKER_BUNDLE) } } : {});
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

test("HTTP pipe replies expose headers before the body ends and preserve split UTF-8 bytes", async () => {
  const source = new PassThrough();
  const completed: number[] = [], errors: Error[] = [];
  let response: Response | undefined;
  const wire = new TaskExecutorReplies(source, value => {
    if (!value.http) throw new Error("expected HTTP reply");
    response = new Response(value.http.body, value.http);
  }, id => completed.push(id), error => errors.push(error));
  try {
    const header = Buffer.from(JSON.stringify({ id: 1, http: { status: 200, headers: [["content-type", "application/json"]] } }) + "\t");
    const body = Buffer.from('"' + "x".repeat(16_383) + "🙂" + "λ".repeat(100_000) + '"');
    source.write(header.subarray(0, 7)); source.write(header.subarray(7));
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
  let body: ReadableStream<Uint8Array> | undefined;
  const wire = new TaskExecutorReplies(source, value => {
    replies.push(value);
    if (value.http) body = value.http.body;
  }, id => completed.push(id), error => errors.push(error));
  try {
    source.write(JSON.stringify({ id: 1, http: { status: 200, headers: [] } }) + "\t");
    source.write(Buffer.alloc(65_536, 120));
    source.write(Buffer.alloc(65_536, 121));
    expect(source.isPaused()).toBe(true); expect(completed).toEqual([]);
    await body!.cancel();
    source.write(Buffer.from('tail\n{"id":2,"result":{"conversationId":null}}\n'));
    await Bun.sleep(0);
    expect(completed).toEqual([1, 2]); expect(replies).toHaveLength(2); expect(errors).toEqual([]);
  } finally { wire.close(); source.destroy(); }
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
    headers: { "content-type": "application/json", "x-llv-spawn-capability": "invalid" },
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

test("idle retirement closes the real executor before the next request starts one", async () => {
  const ready = path.join(root, "idle-worker.pid");
  const executor = new McpTaskExecutor({ idleMs: 10,
    launch: { executable: process.execPath, workerPath: path.join(import.meta.dir, "writerConcurrencyChild.ts") },
    env: { LLV_TASK_EXECUTOR_REPORT_PID: "1", LLV_WRITER_READY: ready } });
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

test.skipIf(process.platform !== "linux")("hard Viewer death ends its actual task executor and guardian within three seconds", async () => {
  const ready = path.join(root, "owner.ready");
  const parent = ownFixtureChild(Bun.spawn({ cmd: [process.execPath, path.join(import.meta.dir, "writerConcurrencyChild.ts")],
    env: { ...process.env, LLV_TASK_EXECUTOR_OWNER: capability, LLV_WRITER_READY: ready }, stdout: "ignore", stderr: "pipe" }));
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
