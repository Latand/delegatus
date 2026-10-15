import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureIdentity } from "@/lib/testing/fixtureProcess";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { runAsMcpHttpCaller } from "./callerContext";
import { McpTaskExecutor } from "./taskExecutor";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-executor-"));
for (const name of ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) {
  process.env[name] = path.join(root, name); fs.mkdirSync(process.env[name]!, { recursive: true });
}
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
afterAll(async () => {
  await Promise.all(executors.map(executor => executor.close()));
  await reapFixtureChildren();
  fs.rmSync(root, { recursive: true, force: true });
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
