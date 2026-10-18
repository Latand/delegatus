import { withoutUnsupportedApiCredentials } from "@/lib/environmentIsolation";
import { spawn, type ChildProcess } from "node:child_process";
import crypto, { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { StateWriteHealth } from "@/lib/state/diskFull";
import { startupDiagnostic } from "@/lib/startupDiagnostics";
import { statePath } from "@/lib/configDir";

import type { FileCatalogScan } from "./index";

const FILES_RESPONSE_WORKER_TIMEOUT_MS = 60_000;
const FILES_RESPONSE_WORKER_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const FILES_RESPONSE_WORKER_STDERR_MAX_BYTES = 4 * 1024;
// Keep one warm projection process for this Viewer generation. RSS after a
// build includes allocator headroom; cache hits can legitimately avoid builds
// for minutes. Neither observation is evidence that the worker failed.

export type FilesResponseRepresentation = {
  stateWrites?: StateWriteHealth;
  stateDataWrites?: StateWriteHealth;
  body: string;
  contentType: string;
  etag: string;
  timing: string;
  /** Serialised delta from the scope's previous representation (#1994). */
  delta?: { base: string; body: string };
  /** The scan the worker read from `snapshotFile`, when the file names one
      (#2072). Absent for an inline snapshot, which the caller already knows. */
  snapshotRead?: { epoch: string; generation: number };
};

export type FilesResponseWorkerRequest = {
  type: "project";
  url: string;
  headers: Array<[string, string]>;
  snapshot?: FileCatalogScan;
  snapshotFile?: string;
  /** Hash of the board scope; asks for a delta from its previous build. */
  deltaScope?: string;
  /** The parent's certified base, which may differ from a discarded build. */
  deltaFrom?: { bodyFile: string; etag: string };
  /** v2 structured base belongs to this Viewer epoch and deltaScope. */
  boardEpoch?: string;
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

type FilesResponseWorkerWireRepresentation = Omit<FilesResponseRepresentation, "body" | "delta" | "snapshotRead"> & {
  bodyFile: string;
  stateWritesJson?: string;
  deltaFile?: string;
  deltaBase?: string;
  snapshotEpoch?: string;
  snapshotGeneration?: string;
};

function representation(value: unknown): FilesResponseWorkerWireRepresentation | null {
  if (!record(value)
    || typeof value.bodyFile !== "string"
    || typeof value.contentType !== "string"
    || typeof value.etag !== "string"
    || typeof value.timing !== "string"
    || (value.stateWritesJson !== undefined && typeof value.stateWritesJson !== "string")
    || (value.deltaFile !== undefined && typeof value.deltaFile !== "string")
    || (value.deltaBase !== undefined && typeof value.deltaBase !== "string")
    || (value.snapshotEpoch !== undefined && typeof value.snapshotEpoch !== "string")
    || (value.snapshotGeneration !== undefined && typeof value.snapshotGeneration !== "string")) return null;
  return value as unknown as FilesResponseWorkerWireRepresentation;
}

function workerLaunch(cwd = process.cwd()): { executable: string; workerPath: string } {
  const source = path.join(cwd, "src/lib/filesResponse.worker.ts");
  const bundled = path.join(cwd, ".next/server/files-response-worker.js");
  /* The candidate performance gate runs the Viewer from source and measures
     the worker the same way; a bundle left by an earlier build is other code. */
  if (fs.existsSync(source) && process.env.LLV_FILES_RESPONSE_WORKER_LAUNCH === "source") {
    return { executable: process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun"), workerPath: source };
  }
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) {
    return { executable: "/usr/local/bin/bun-container", workerPath: source };
  }
  if (fs.existsSync(bundled)) {
    const bun = process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun");
    return { executable: bun, workerPath: bundled };
  }
  return { executable: process.execPath, workerPath: source };
}

/* A test that drives the files route through a real worker names the worker
   it launches; while one is named, the route projects through it. */
let testRuntime: FilesResponseWorkerRuntime | null = null;
export function setFilesResponseWorkerRuntimeForTests(runtime: FilesResponseWorkerRuntime | null): void {
  testRuntime = runtime;
}

export function filesResponseWorkerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (testRuntime) return true;
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
  /** Launch identity and storage roots a reused worker must match. */
  signature: string;
  /** Where its body files are allowed to be, checked on every answer. */
  resultDirectory: string;
  buffer: string;
  bufferBytes: number;
  stderr: string;
  pending: PendingBuild | null;
  rssBytes: number;
  nextId: number;
  retired: boolean;
  drainReason?: string;
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
    // Ambient request/monitoring variables may change between builds. Storage
    // roots define which installation the worker serves and must never mix.
    roots: [env.LLV_STATE_DIR, env.HOME, env.XDG_CONFIG_HOME, env.CODEX_HOME,
      env.LLV_CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.LLV_CLAUDE_HOME, env.OPENCLAW_STATE_DIR, env.COPILOT_HOME],
  })).digest("hex");
}

function retire(worker: ResidentWorker, reason: string): void {
  if (worker.retired) return;
  worker.retired = true;
  pool.__llvFilesResponseWorkerLastRetirement = reason;
  const log = reason === "viewer exit" ? (...args: unknown[]) => startupDiagnostic("info", ...args) : console.warn;
  log(`[files response worker] retired: ${reason}`, {
    pid: worker.child.pid ?? null, rssBytes: worker.rssBytes,
  });
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

/** Let the resident worker finish what it was asked and exit on its own, then
    forget it; one that outlives `timeoutMs` is stopped as `shutdown` stops it. */
export async function drainFilesResponseWorker(reason = "drained", timeoutMs = 5_000): Promise<void> {
  const worker = pool.__llvFilesResponseWorker ?? null;
  if (!worker || worker.retired) return;
  const exited = new Promise<void>((resolve) => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) resolve();
    else worker.child.once("exit", () => resolve());
  });
  worker.drainReason = reason;
  try { worker.child.stdin?.end(); } catch { /* the pipe is already gone */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  if (timer) clearTimeout(timer);
  retire(worker, reason);
  pool.__llvFilesResponseWorkerTail = undefined;
  /* A worker stopped at the deadline is gone once its exit is observed. */
  await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })]);
  if (timer) clearTimeout(timer);
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
  child.once("close", (code, signal) => retire(worker, worker.drainReason ?? `exited (${signal ?? code ?? "unknown"})`));
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
  const env = withoutUnsupportedApiCredentials(runtime.env ?? process.env);
  const signature = workerSignature(launch, useNice, cwd, env);
  const resultDirectory = runtime.env?.LLV_STATE_DIR
    ? path.resolve(runtime.env.LLV_STATE_DIR, "files-response-results")
    : path.resolve(statePath("files-response-results"));
  const existing = pool.__llvFilesResponseWorker ?? null;
  if (existing && !existing.retired && existing.signature === signature) {
    holdEventLoop(existing, true);
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

async function readBody(worker: ResidentWorker, file: string): Promise<string> {
  const bodyFile = path.resolve(file);
  if (path.dirname(bodyFile) !== worker.resultDirectory) {
    throw new Error("files response worker returned an invalid body path");
  }
  const body = await fs.promises.readFile(bodyFile, "utf8");
  await fs.promises.rm(bodyFile, { force: true });
  return body;
}

async function dispatch(
  request: FilesResponseWorkerRequest,
  runtime: FilesResponseWorkerRuntime,
  previous?: { body: string; etag: string },
): Promise<FilesResponseRepresentation> {
  const worker = residentWorker(runtime);
  let previousFile: string | undefined;
  try {
    if (previous && request.deltaScope) {
      previousFile = path.join(worker.resultDirectory, `${process.pid}-${crypto.randomUUID()}.base.json`);
      await fs.promises.mkdir(worker.resultDirectory, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(previousFile, previous.body, { encoding: "utf8", mode: 0o600 });
      request = { ...request, deltaFrom: { bodyFile: previousFile, etag: previous.etag } };
    }
    const result = await askWorker(worker, request, runtime.timeoutMs ?? FILES_RESPONSE_WORKER_TIMEOUT_MS);
    const { bodyFile, deltaFile, deltaBase, snapshotEpoch, snapshotGeneration, stateWritesJson, ...metadata } = result;
    const stateWrites = stateWritesJson ? JSON.parse(stateWritesJson) as StateWriteHealth : undefined;
    if (stateWrites && (!record(stateWrites)
      || !["ok", "disk-full"].includes(stateWrites.state)
      || (stateWrites.since !== null && typeof stateWrites.since !== "string")
      || (stateWrites.freeBytes !== null && (typeof stateWrites.freeBytes !== "number" || !Number.isFinite(stateWrites.freeBytes))))) {
      throw new Error("files response worker emitted invalid write health");
    }
    const body = await readBody(worker, bodyFile);
    const delta = deltaFile && deltaBase ? { base: deltaBase, body: await readBody(worker, deltaFile) } : undefined;
    const generation = snapshotGeneration !== undefined && /^\d+$/.test(snapshotGeneration) ? Number(snapshotGeneration) : undefined;
    const snapshotRead = snapshotEpoch && generation !== undefined && Number.isSafeInteger(generation)
      ? { epoch: snapshotEpoch, generation }
      : undefined;
    pool.__llvFilesResponseWorkerBuilds = (pool.__llvFilesResponseWorkerBuilds ?? 0) + 1;
    return { ...metadata, body, ...(stateWrites ? { stateWrites, stateDataWrites: stateWrites } : {}), ...(delta ? { delta } : {}), ...(snapshotRead ? { snapshotRead } : {}) };
  } finally {
    if (previousFile) await fs.promises.rm(previousFile, { force: true }).catch(() => undefined);
    if (!worker.retired) holdEventLoop(worker, false);
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
  runtime: FilesResponseWorkerRuntime = testRuntime ?? {},
  previous?: { body: string; etag: string },
): Promise<FilesResponseRepresentation> {
  const previousBuild = pool.__llvFilesResponseWorkerTail ?? Promise.resolve();
  const current = previousBuild.catch(() => undefined).then(() => dispatch(request, runtime, previous));
  pool.__llvFilesResponseWorkerTail = current.then(() => undefined, () => undefined);
  return current;
}
