import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { stateDir } from "@/lib/configDir";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper, unrefLeasedHelper } from "@/lib/helperLease";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { currentMcpHttpCaller, type McpHttpCaller } from "./callerContext";
import type { McpToolArgs, McpToolCallContext, McpToolResult } from "./server";

export const TASK_EXECUTOR_TOOLS = new Set(["list_tasks", "get_task", "create_task", "update_task"]);
const MAX_PENDING = 64;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const TASK_EXECUTOR_FRAME_BYTES = 32 * 1024 * 1024;
type ExecutorResult = McpToolResult | { conversationId: string | null };
type Pending = { bytes: number; finish: (error?: Error, result?: ExecutorResult) => void; dispose: () => void };
export type TaskExecutorRequest = { id: number; name: string; args: McpToolArgs; caller: McpHttpCaller; deadlineAt: number; nativeWork?: McpToolCallContext["nativeWork"] };

export function taskExecutorLaunch(cwd = process.cwd()) {
  const source = path.join(cwd, "src/lib/mcpTask.worker.ts");
  const bundled = path.join(cwd, ".next/server/mcp-task-worker.js");
  const containerBun = "/usr/local/bin/bun-container";
  return {
    executable: fs.existsSync(containerBun) ? containerBun : process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun",
    workerPath: fs.existsSync(source) ? source : bundled,
  };
}

/** One task service per Viewer, shared across Next bundles. A timed-out caller
 * keeps its slot until the executor settles: cancellation cannot create an
 * unbounded queue of work whose replies nobody is waiting for. */
export class McpTaskExecutor {
  private child: ChildProcess | null = null;
  private closing: Promise<void> = Promise.resolve();
  private pending = new Map<number, Pending>();
  private inputBytes = 0;
  private nextId = 0;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(private runtime: { launch?: ReturnType<typeof taskExecutorLaunch>; env?: Partial<NodeJS.ProcessEnv>; idleMs?: number } = {}) {}

  async identifyCapability(capability: string, context: McpToolCallContext = {}): Promise<string | null> {
    const result = await this.request("identifyCapability", {}, { capability }, context);
    if (!("conversationId" in result) || (result.conversationId !== null && typeof result.conversationId !== "string")) {
      throw new Error("invalid task executor identity reply");
    }
    return result.conversationId;
  }

  async callTool(name: string, args: McpToolArgs, context: McpToolCallContext = {}): Promise<McpToolResult> {
    const caller = currentMcpHttpCaller();
    if (!caller || !TASK_EXECUTOR_TOOLS.has(name)) throw new Error("task executor requires an authenticated Viewer call");
    return await this.request(name, args, caller, context) as McpToolResult;
  }

  private request(name: string, args: McpToolArgs, caller: McpHttpCaller, context: McpToolCallContext): Promise<ExecutorResult> {
    return withViewerOperation("mcp.tasks.executor", async () => {
      const deadlineAt = Math.min(context.deadlineAt ?? Infinity, Date.now() + 30_000);
      if (context.signal?.aborted || deadlineAt <= Date.now()) throw new Error("task executor call ended before dispatch");
      const id = ++this.nextId;
      const frame = JSON.stringify({ id, name, args, caller, deadlineAt, nativeWork: context.nativeWork } satisfies TaskExecutorRequest) + "\n";
      const bytes = Buffer.byteLength(frame);
      if (this.pending.size >= MAX_PENDING || this.inputBytes + bytes > MAX_INPUT_BYTES) throw new Error("task executor admission is full; retry the original request key");
      // Reserve before waiting for an old guardian to close.
      return await new Promise<ExecutorResult>((resolve, reject) => {
        let settled = false;
        let dispatched: ChildProcess | undefined;
        let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
        const finish: Pending["finish"] = (error, result) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve(result!);
        };
        const cancel = () => {
          finish(new Error("task executor reply was cancelled or timed out; look up the original request key"));
          if (dispatched && this.child === dispatched) {
            leasedHelperInput(dispatched).write(JSON.stringify({ cancel: id }) + "\n");
            cancellationTimer ??= setTimeout(() => {
              if (this.pending.has(id)) this.retire(dispatched!, "did not settle cancellation");
            }, 1_000);
          }
        };
        const timer = setTimeout(cancel, Math.max(1, deadlineAt - Date.now()));
        context.signal?.addEventListener("abort", cancel, { once: true });
        const pending: Pending = { bytes, finish, dispose: () => {
          clearTimeout(timer); clearTimeout(cancellationTimer); context.signal?.removeEventListener("abort", cancel);
          this.pending.delete(id); this.inputBytes -= bytes;
        } };
        this.pending.set(id, pending); this.inputBytes += bytes;
        void this.closing.then(() => {
          if (settled) { pending.dispose(); return; }
          clearTimeout(this.idle);
          const child = this.child ?? this.start();
          dispatched = child;
          leasedHelperInput(child).write(frame, error => { if (error) this.retire(child); });
        }).catch(error => { finish(error); pending.dispose(); });
      });
    });
  }

  private start(): ChildProcess {
    const launch = this.runtime.launch ?? taskExecutorLaunch();
    const child = spawnLeasedHelper("mcp-tasks", {
      command: launch.executable, args: [launch.workerPath], cwd: process.cwd(),
      env: { ...process.env, ...this.runtime.env, LLV_STATE_DIR: this.runtime.env?.LLV_STATE_DIR ?? stateDir(), LLV_STATE_OWNER: "mcp" },
    }, this.runtime.env?.LLV_STATE_DIR ?? stateDir(), { input: true, stdout: "pipe", stderr: "inherit", followRelease: false });
    this.child = child;
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          if (Buffer.byteLength(line) + 1 > TASK_EXECUTOR_FRAME_BYTES) throw new Error("task executor frame exceeds its bound");
          const reply = JSON.parse(line) as { id: number; result?: ExecutorResult; error?: string };
          const job = this.pending.get(reply.id);
          if (!job || (!reply.result && !reply.error)) throw new Error("invalid task executor reply");
          job.finish(reply.error ? new Error(reply.error) : undefined, reply.result); job.dispose();
        } catch { this.retire(child); return; }
      }
      if (Buffer.byteLength(buffer) > TASK_EXECUTOR_FRAME_BYTES) { this.retire(child); return; }
      if (!this.pending.size) {
        this.idle = setTimeout(() => this.retire(child), this.runtime.idleMs ?? 60_000);
        this.idle.unref();
      }
    });
    leasedHelperInput(child).on("error", () => this.retire(child));
    child.once("error", () => this.retire(child, "could not start"));
    child.once("close", (code, signal) => this.retire(child, `exited (${signal ?? code})`));
    unrefLeasedHelper(child);
    return child;
  }

  private retire(child: ChildProcess, reason = "stopped"): void {
    if (this.child !== child) return;
    this.child = null; clearTimeout(this.idle);
    this.closing = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : new Promise(resolve => child.once("close", () => resolve()));
    endLeasedHelper(child);
    for (const job of this.pending.values()) {
      job.finish(new Error(`task executor ${reason} before its reply; look up the original request key`)); job.dispose();
    }
  }

  async close(): Promise<void> { if (this.child) this.retire(this.child); await this.closing; }
}

const KEY = Symbol.for("llv.mcp.taskExecutor");
export function viewerTaskExecutor(): McpTaskExecutor {
  const holder = globalThis as typeof globalThis & { [KEY]?: McpTaskExecutor };
  return holder[KEY] ??= new McpTaskExecutor();
}
