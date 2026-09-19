import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import type { FileCatalogScan } from "./index";

const FILES_RESPONSE_WORKER_TIMEOUT_MS = 60_000;
const FILES_RESPONSE_WORKER_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const FILES_RESPONSE_WORKER_STDERR_MAX_BYTES = 4 * 1024;
/**
 * The two thresholds that keep one resident worker from becoming a slow leak
 * (#1814). Both are measured on the worker itself, and either one retires it:
 *
 * - **size** — the resident set it reports after finishing a build. Production
 *   projections peaked at 1 349 MB inside a freshly forked worker, so a
 *   resident one that ends a build above 1 536 MB is carrying something it did
 *   not carry before and is replaced rather than trusted.
 * - **idle** — a worker nobody has asked for a projection in a minute holds a
 *   whole projection's heap for nothing, so it goes and the next poll forks a
 *   new one. A polled board never reaches this; a quiet Viewer always does.
 */
const FILES_RESPONSE_WORKER_RSS_LIMIT_BYTES = 1_536 * 1024 * 1024;
const FILES_RESPONSE_WORKER_IDLE_MS = 60_000;

function positiveNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The size threshold, overridable so a test can cross it deliberately. */
function residentLimitBytes(): number {
  const configured = positiveNumber(process.env.LLV_FILES_RESPONSE_WORKER_RSS_LIMIT_MB);
  return configured === null ? FILES_RESPONSE_WORKER_RSS_LIMIT_BYTES : configured * 1024 * 1024;
}

/** The idle threshold, overridable for the same reason. */
function idleLimitMs(): number {
  return positiveNumber(process.env.LLV_FILES_RESPONSE_WORKER_IDLE_MS) ?? FILES_RESPONSE_WORKER_IDLE_MS;
}

export type FilesResponseRepresentation = {
  body: string;
  contentType: string;
  etag: string;
  timing: string;
};

export type FilesResponseWorkerRequest = {
  type: "project";
  url: string;
  headers: Array<[string, string]>;
  snapshot?: FileCatalogScan;
  snapshotFile?: string;
};

export interface FilesResponseWorkerRuntime {
  launch?: { executable: string; workerPath: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** What the pool has done since this process started, for tests and diagnosis. */
export interface FilesResponseWorkerPoolDiagnostics {
  /** Worker processes forked. The number #1814 is about. */
  spawns: number;
  /** Projections built, however many workers built them. */
  builds: number;
  /** The resident worker's pid, or null when none is held. */
  pid: number | null;
  /** Its resident set after its last build, in bytes. */
  rssBytes: number;
  /** Why the last retirement happened, for the record. */
  lastRetirement: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FilesResponseWorkerWireRepresentation = Omit<FilesResponseRepresentation, "body"> & {
  bodyFile: string;
};

function representation(value: unknown): FilesResponseWorkerWireRepresentation | null {
  if (!record(value)
    || typeof value.bodyFile !== "string"
    || typeof value.contentType !== "string"
    || typeof value.etag !== "string"
    || typeof value.timing !== "string") return null;
  return value as unknown as FilesResponseWorkerWireRepresentation;
}

function workerLaunch(cwd = process.cwd()): { executable: string; workerPath: string } {
  const source = path.join(cwd, "src/lib/filesResponse.worker.ts");
  const bundled = path.join(cwd, ".next/server/files-response-worker.js");
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) {
    return { executable: "/usr/local/bin/bun-container", workerPath: source };
  }
  if (fs.existsSync(bundled)) {
    const bun = process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun");
    return { executable: bun, workerPath: bundled };
  }
  return { executable: process.execPath, workerPath: source };
}

export function filesResponseWorkerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV !== "test"
    && env.LLV_FILES_RESPONSE_WORKER !== "1"
    && env.LLV_FILES_RESPONSE_WORKER_DISABLED !== "1";
}

type PendingBuild = {
  id: string;
  resolve: (value: FilesResponseWorkerWireRepresentation) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ResidentWorker = {
  child: ChildProcess;
  /** Everything a reused worker has to match: launch, cwd and environment. */
  signature: string;
  /** Where its body files are allowed to be, checked on every answer. */
  resultDirectory: string;
  buffer: string;
  bufferBytes: number;
  stderr: string;
  pending: PendingBuild | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  rssBytes: number;
  nextId: number;
  retired: boolean;
};

/* The Viewer loads this module through more than one bundle, and two pools
   would be two resident workers. */
const pool = globalThis as typeof globalThis & {
  __llvFilesResponseWorker?: ResidentWorker | null;
  __llvFilesResponseWorkerTail?: Promise<unknown>;
  __llvFilesResponseWorkerSpawns?: number;
  __llvFilesResponseWorkerBuilds?: number;
  __llvFilesResponseWorkerLastRetirement?: string | null;
  __llvFilesResponseWorkerExitHook?: boolean;
};

export function filesResponseWorkerPoolDiagnostics(): FilesResponseWorkerPoolDiagnostics {
  const worker = pool.__llvFilesResponseWorker ?? null;
  return {
    spawns: pool.__llvFilesResponseWorkerSpawns ?? 0,
    builds: pool.__llvFilesResponseWorkerBuilds ?? 0,
    pid: worker?.child.pid ?? null,
    rssBytes: worker?.rssBytes ?? 0,
    lastRetirement: pool.__llvFilesResponseWorkerLastRetirement ?? null,
  };
}

function workerSignature(
  launch: { executable: string; workerPath: string },
  useNice: boolean,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  return createHash("sha1").update(JSON.stringify({
    launch,
    useNice,
    cwd,
    env: Object.keys(env).sort().map((key) => [key, env[key]]),
  })).digest("hex");
}

function retire(worker: ResidentWorker, reason: string): void {
  if (worker.retired) return;
  worker.retired = true;
  pool.__llvFilesResponseWorkerLastRetirement = reason;
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = null;
  if (pool.__llvFilesResponseWorker === worker) pool.__llvFilesResponseWorker = null;
  const pending = worker.pending;
  worker.pending = null;
  if (pending) {
    clearTimeout(pending.timer);
    const detail = worker.stderr.trim();
    pending.reject(new Error(`files response worker was retired mid-build (${reason})${detail ? `: ${detail}` : ""}`));
  }
  try { worker.child.stdin?.end(); } catch { /* the pipe is already gone */ }
  try { worker.child.kill("SIGKILL"); } catch { /* the child already exited */ }
}

/** Stop and forget the resident worker. Exported for tests and shutdown. */
export function shutdownFilesResponseWorker(reason = "shutdown"): void {
  const worker = pool.__llvFilesResponseWorker ?? null;
  if (worker) retire(worker, reason);
  pool.__llvFilesResponseWorkerTail = undefined;
}

/**
 * A child's stdio pipes hold the event loop open on their own, so unrefing the
 * child alone would not let a Viewer — or a test runner — exit while a worker
 * waits idle. The handles carry `ref`/`unref` at runtime; the stream types
 * they are declared as do not.
 */
function holdEventLoop(worker: ResidentWorker, hold: boolean): void {
  const handles: Array<{ ref?: () => void; unref?: () => void } | null | undefined> = [
    worker.child.stdin as unknown as { ref?: () => void; unref?: () => void } | null,
    worker.child.stdout as unknown as { ref?: () => void; unref?: () => void } | null,
    worker.child.stderr as unknown as { ref?: () => void; unref?: () => void } | null,
  ];
  if (hold) worker.child.ref();
  else worker.child.unref();
  for (const handle of handles) {
    if (hold) handle?.ref?.();
    else handle?.unref?.();
  }
}

function armIdleTimer(worker: ResidentWorker): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = setTimeout(() => retire(worker, "idle"), idleLimitMs());
  /* An idle worker must not be what keeps the process alive — neither this
     timer nor the pipes it is waiting on. */
  (worker.idleTimer as unknown as { unref?: () => void }).unref?.();
  holdEventLoop(worker, false);
}

function disarmIdleTimer(worker: ResidentWorker): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = null;
  holdEventLoop(worker, true);
}

function answer(worker: ResidentWorker, frame: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    retire(worker, "unreadable answer");
    return;
  }
  if (!record(parsed) || typeof parsed.id !== "string") {
    retire(worker, "unaddressed answer");
    return;
  }
  if (typeof parsed.rssBytes === "number") worker.rssBytes = parsed.rssBytes;
  const pending = worker.pending;
  if (!pending || pending.id !== parsed.id) {
    /* An answer to a build nobody is waiting for means the two sides disagree
       about what has been asked, and the next answer cannot be trusted either. */
    retire(worker, "unexpected answer");
    return;
  }
  worker.pending = null;
  clearTimeout(pending.timer);
  const detail = worker.stderr.trim();
  worker.stderr = "";
  if (parsed.ok !== true) {
    const message = typeof parsed.error === "string" ? parsed.error : "files response worker failed";
    pending.reject(new Error(`${message}${detail ? `: ${detail}` : ""}`));
    return;
  }
  const result = representation(parsed.result);
  if (!result) {
    pending.reject(new Error(`files response worker emitted an invalid representation${detail ? `: ${detail}` : ""}`));
    return;
  }
  pending.resolve(result);
}

function startWorker(
  signature: string,
  launch: { executable: string; workerPath: string },
  useNice: boolean,
  cwd: string,
  env: NodeJS.ProcessEnv,
  resultDirectory: string,
): ResidentWorker {
  const child = spawn(useNice ? "/usr/bin/nice" : launch.executable, [
    ...(useNice ? ["-n", "10", launch.executable] : []),
    launch.workerPath,
  ], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, LLV_FILES_RESPONSE_WORKER: "1" },
  });
  pool.__llvFilesResponseWorkerSpawns = (pool.__llvFilesResponseWorkerSpawns ?? 0) + 1;
  const worker: ResidentWorker = {
    child,
    signature,
    resultDirectory,
    buffer: "",
    bufferBytes: 0,
    stderr: "",
    pending: null,
    idleTimer: null,
    rssBytes: 0,
    nextId: 0,
    retired: false,
  };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    worker.buffer += chunk;
    worker.bufferBytes += Buffer.byteLength(chunk);
    for (;;) {
      const newline = worker.buffer.indexOf("\n");
      if (newline < 0) break;
      const frame = worker.buffer.slice(0, newline);
      worker.buffer = worker.buffer.slice(newline + 1);
      worker.bufferBytes = Buffer.byteLength(worker.buffer);
      if (frame.trim()) answer(worker, frame);
      if (worker.retired) return;
    }
    if (worker.bufferBytes > FILES_RESPONSE_WORKER_OUTPUT_MAX_BYTES) {
      retire(worker, "output limit");
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    worker.stderr = `${worker.stderr}${chunk}`;
    if (Buffer.byteLength(worker.stderr) > FILES_RESPONSE_WORKER_STDERR_MAX_BYTES) {
      worker.stderr = Buffer.from(worker.stderr).subarray(-FILES_RESPONSE_WORKER_STDERR_MAX_BYTES).toString("utf8");
    }
  });
  /* A failing write to the worker's stdin is a connection event, not a process
     event: unhandled, it takes the Viewer down with it. */
  child.stdin!.on("error", () => retire(worker, "stdin closed"));
  child.once("error", (error) => retire(worker, `launch failed: ${error.message}`));
  child.once("close", (code, signal) => retire(worker, `exited (${signal ?? code ?? "unknown"})`));
  if (!pool.__llvFilesResponseWorkerExitHook) {
    pool.__llvFilesResponseWorkerExitHook = true;
    process.once("exit", () => shutdownFilesResponseWorker("viewer exit"));
  }
  return worker;
}

function residentWorker(runtime: FilesResponseWorkerRuntime): ResidentWorker {
  const launch = runtime.launch ?? workerLaunch(runtime.cwd);
  const useNice = runtime.launch === undefined && fs.existsSync("/usr/bin/nice");
  const cwd = runtime.cwd ?? process.cwd();
  const env = withoutWakatimeCredential(runtime.env ?? process.env);
  const signature = workerSignature(launch, useNice, cwd, env);
  const resultDirectory = runtime.env?.LLV_STATE_DIR
    ? path.resolve(runtime.env.LLV_STATE_DIR, "files-response-results")
    : path.resolve(statePath("files-response-results"));
  const existing = pool.__llvFilesResponseWorker ?? null;
  if (existing && !existing.retired && existing.signature === signature) {
    disarmIdleTimer(existing);
    return existing;
  }
  if (existing) retire(existing, existing.signature === signature ? "replaced" : "different launch");
  const worker = startWorker(signature, launch, useNice, cwd, env, resultDirectory);
  pool.__llvFilesResponseWorker = worker;
  return worker;
}

function askWorker(
  worker: ResidentWorker,
  request: FilesResponseWorkerRequest,
  timeoutMs: number,
): Promise<FilesResponseWorkerWireRepresentation> {
  return new Promise<FilesResponseWorkerWireRepresentation>((resolve, reject) => {
    if (worker.retired) {
      reject(new Error("files response worker is unavailable"));
      return;
    }
    const id = String(worker.nextId++);
    const timer = setTimeout(() => {
      const detail = worker.stderr.trim();
      retire(worker, "timed out");
      reject(new Error(`files response worker timed out${detail ? `: ${detail}` : ""}`));
    }, timeoutMs);
    worker.pending = { id, resolve, reject, timer };
    try {
      worker.child.stdin!.write(`${JSON.stringify({ id, request })}\n`);
    } catch (error) {
      retire(worker, "stdin write failed");
      reject(error instanceof Error ? error : new Error("files response worker could not be reached"));
    }
  });
}

function readBody(worker: ResidentWorker, result: FilesResponseWorkerWireRepresentation): string {
  const bodyFile = path.resolve(result.bodyFile);
  if (path.dirname(bodyFile) !== worker.resultDirectory) {
    throw new Error("files response worker returned an invalid body path");
  }
  const body = fs.readFileSync(bodyFile, "utf8");
  fs.rmSync(bodyFile, { force: true });
  return body;
}

async function dispatch(
  request: FilesResponseWorkerRequest,
  runtime: FilesResponseWorkerRuntime,
): Promise<FilesResponseRepresentation> {
  const worker = residentWorker(runtime);
  try {
    const result = await askWorker(worker, request, runtime.timeoutMs ?? FILES_RESPONSE_WORKER_TIMEOUT_MS);
    const body = readBody(worker, result);
    pool.__llvFilesResponseWorkerBuilds = (pool.__llvFilesResponseWorkerBuilds ?? 0) + 1;
    return { ...result, body };
  } finally {
    if (!worker.retired) {
      if (worker.rssBytes > residentLimitBytes()) retire(worker, "size");
      else armIdleTimer(worker);
    }
  }
}

/**
 * Build the `/api/files` representation off the request thread (#1157), in one
 * resident worker rather than one worker per request (#1814). Builds are
 * serialised: the worker holds a whole projection while it builds one, and
 * a burst of polls is what this exists to serve from a single process.
 */
export function buildFilesResponseInWorker(
  request: FilesResponseWorkerRequest,
  runtime: FilesResponseWorkerRuntime = {},
): Promise<FilesResponseRepresentation> {
  const previous = pool.__llvFilesResponseWorkerTail ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => dispatch(request, runtime));
  pool.__llvFilesResponseWorkerTail = current.then(() => undefined, () => undefined);
  return current;
}
