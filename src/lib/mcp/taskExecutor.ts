import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { stateDir } from "@/lib/configDir";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper, unrefLeasedHelper } from "@/lib/helperLease";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { currentMcpHttpCaller, type McpHttpCaller } from "./callerContext";
import type { McpToolArgs, McpToolCallContext, McpToolResult } from "./server";

export const TASK_EXECUTOR_TOOLS = new Set(["list_tasks", "get_task", "create_task", "update_task"]);
const MAX_PENDING = 64;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const TASK_EXECUTOR_FRAME_BYTES = 32 * 1024 * 1024;
// The HTTP envelope contains both structuredContent and its escaped text copy.
export const TASK_EXECUTOR_HTTP_FRAME_BYTES = 4 * TASK_EXECUTOR_FRAME_BYTES;
export type ExecutorHttpResponse = { status: number; headers: [string, string][]; body: ReadableStream<Uint8Array> };
type ExecutorResult = McpToolResult | { conversationId: string | null } | { http: ExecutorHttpResponse };
type ExecutorReply = { id: number; result?: ExecutorResult; error?: string; http?: ExecutorHttpResponse };
type ExecutorWireReply = Omit<ExecutorReply, "http"> & { http?: Omit<ExecutorHttpResponse, "body"> };
type Pending = { bytes: number; finish: (error?: Error, result?: ExecutorResult) => void; dispose: () => void };
export type TaskExecutorRequest = { id: number; name: string; args: McpToolArgs; caller: McpHttpCaller; deadlineAt: number; nativeWork?: McpToolCallContext["nativeWork"] };

/** HTTP bodies cross the pipe as bytes. Only their small header is decoded on
 * the Viewer; a slow network consumer pauses the pipe. Cancelled bodies drain
 * through their existing frame so replies for other callers stay aligned. */
export class TaskExecutorReplies {
  private parts: Buffer[] = [];
  private bytes = 0;
  private output?: { id: number; bytes: number; controller?: ReadableStreamDefaultController<Uint8Array> };
  private closed = false;
  private ended = false;
  private queued?: Buffer;
  private continuation?: ReturnType<typeof setImmediate>;

  constructor(private source: Readable, private reply: (value: ExecutorReply) => void,
    private complete: (id: number) => void, private failed: (error: Error) => void) {
    source.on("data", (chunk: Buffer) => withViewerOperation("mcp.tasks.executor", () => {
      if (this.closed) return;
      this.source.pause();
      try { this.accept(chunk); }
      catch (error) { this.close(error as Error); failed(error as Error); }
    }));
    source.on("error", error => { this.close(error); failed(error); });
    source.once("end", () => {
      this.ended = true;
      this.defer();
    });
  }

  /** At most one pipe chunk is held outside the stream queue. Header delivery
   * and each 16 KiB body slice run on separate turns, including while draining
   * a cancelled reply. A consumer's pull cannot resume past that held chunk. */
  private defer(chunk?: Buffer): void {
    if (this.closed) return;
    if (chunk?.length) this.queued = chunk;
    if (this.continuation || (this.output?.controller?.desiredSize ?? 1) <= 0) return;
    this.continuation = setImmediate(() => withViewerOperation("mcp.tasks.executor", () => {
      this.continuation = undefined;
      if (this.closed) return;
      const queued = this.queued; this.queued = undefined;
      try {
        if (queued) this.accept(queued);
        else if (this.ended) throw new Error("task executor output ended");
        else this.source.resume();
      } catch (error) { this.close(error as Error); this.failed(error as Error); }
    }));
  }

  private accept(chunk: Buffer): void {
    while (chunk.length) {
      if (this.output) {
        const output = this.output;
        const slice = chunk.subarray(0, 16_384);
        const end = slice.indexOf(10);
        const body = end < 0 ? slice : slice.subarray(0, end);
        output.bytes += body.length;
        if (output.bytes > TASK_EXECUTOR_HTTP_FRAME_BYTES) throw new Error("task executor HTTP frame exceeds its bound");
        if (body.length && output.controller) {
          output.controller.enqueue(body);
        }
        if (end < 0) { this.defer(chunk.subarray(body.length)); return; }
        output.controller?.close(); this.output = undefined;
        this.complete(output.id);
        this.defer(chunk.subarray(end + 1)); return;
      }
      const tab = chunk.indexOf(9);
      const newline = chunk.subarray(0, tab < 0 ? chunk.length : tab).indexOf(10);
      const http = tab >= 0 && (newline < 0 || tab < newline);
      const end = http ? tab : newline;
      const part = end < 0 ? chunk : chunk.subarray(0, end);
      this.parts.push(part); this.bytes += part.length;
      if (this.bytes + 1 > TASK_EXECUTOR_FRAME_BYTES) throw new Error("task executor frame exceeds its bound");
      if (end < 0) { this.defer(); return; }
      if (http && this.bytes > 16_384) throw new Error("task executor HTTP header exceeds its bound");
      const value = JSON.parse(Buffer.concat(this.parts, this.bytes).toString("utf8")) as ExecutorWireReply;
      const headerBytes = this.bytes;
      this.parts = []; this.bytes = 0;
      if (http) {
        if (!value.http) throw new Error("task executor HTTP header is missing");
        const output: NonNullable<TaskExecutorReplies["output"]> = { id: value.id, bytes: headerBytes + 2 };
        this.output = output;
        const body = new ReadableStream<Uint8Array>({
          start(controller) { output.controller = controller; },
          pull: () => { if (this.output === output) this.defer(); },
          cancel: () => { output.controller = undefined; if (this.output === output) this.defer(); },
        }, { highWaterMark: 65_536, size: value => value?.byteLength ?? 0 });
        this.reply({ id: value.id, http: { ...value.http, body } });
        this.defer(chunk.subarray(end + 1)); return;
      } else {
        if (value.http) throw new Error("task executor HTTP frame is missing its body delimiter");
        this.reply({ id: value.id, result: value.result, error: value.error }); this.complete(value.id);
      }
      chunk = chunk.subarray(end + 1);
    }
    this.defer();
  }

  close(error = new Error("task executor reply ended before its frame completed")): void {
    if (this.closed) return;
    this.closed = true; this.parts = []; this.bytes = 0;
    clearImmediate(this.continuation); this.continuation = undefined; this.queued = undefined;
    this.output?.controller?.error(error); this.output = undefined;
  }
}

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
  private replies?: TaskExecutorReplies;

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

  async callHttpTool(toolName: string, body: unknown, request: Request, caller: McpHttpCaller, context: McpToolCallContext): Promise<Response> {
    if (!TASK_EXECUTOR_TOOLS.has(toolName)) throw new Error("unsupported task HTTP tool");
    const result = await this.request("httpTaskCall", {
      toolName, body, url: request.url,
      headers: [...request.headers].filter(([name]) => ["accept", "content-type", "mcp-protocol-version", "mcp-session-id"].includes(name)),
    }, caller, context);
    if (!("http" in result) || !result.http || typeof result.http !== "object") throw new Error("invalid task executor HTTP reply");
    const response = result.http as ExecutorHttpResponse;
    return new Response(response.body, { status: response.status, headers: response.headers });
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
          if (error) reject(error);
          else resolve(result!);
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
    this.replies = new TaskExecutorReplies(child.stdout!, reply => {
      const job = this.pending.get(reply.id);
      const result = reply.http ? { http: reply.http } : reply.result;
      if (!job || (!result && !reply.error)) throw new Error("invalid task executor reply");
      job.finish(reply.error ? new Error(reply.error) : undefined, result);
    }, id => {
      this.pending.get(id)?.dispose();
      if (!this.pending.size) {
        this.idle = setTimeout(() => this.retire(child), this.runtime.idleMs ?? 60_000);
        this.idle.unref();
      }
    }, () => this.retire(child));
    leasedHelperInput(child).on("error", () => this.retire(child));
    child.once("error", () => this.retire(child, "could not start"));
    child.once("close", (code, signal) => this.retire(child, `exited (${signal ?? code})`));
    unrefLeasedHelper(child);
    return child;
  }

  private retire(child: ChildProcess, reason = "stopped"): void {
    if (this.child !== child) return;
    this.replies?.close(); this.replies = undefined;
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
