import { withoutUnsupportedApiCredentials } from "@/lib/environmentIsolation";
import fs from "node:fs";
import path from "node:path";
import { performanceSpans } from "@/lib/performanceSpans";

import { deadlineSignal, systemScheduler, type DeadlineScheduler } from "@/lib/deadline";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } from "@/lib/helperLease";
import { scheduleTranscriptIndex, type TranscriptIndexFeed } from "@/lib/search/transcriptFeed";

import type { FileCatalogScan, FileScanOptions } from "./index";
import { transcriptIndexFeed } from "./discover";
import { conversationSearchProjection } from "./conversationSearchProjection";
import {
  beginProjectCatalogScan,
  isProjectCatalogScanCurrent,
  publishConversationCatalogForScan,
} from "./projectCatalog";

const FILE_SCAN_WORKER_TIMEOUT_MS = 5 * 60_000;
const FILE_SCAN_WORKER_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
const FILE_SCAN_WORKER_STDERR_MAX_BYTES = 4 * 1024;
const FILE_SCAN_BOOTSTRAP_BACKOFF_MS = [250, 1_000] as const;

class FileScannerBootstrapBusyError extends Error {}

type SerializableFileScanOptions = Omit<FileScanOptions, "onResourceSnapshot" | "signal">;

type FileScanWorkerMessage =
  | { type: "resource"; snapshot: FileCatalogScan }
  | { type: "complete"; snapshot: FileCatalogScan };

export interface FileScanWorkerRuntime {
  launch?: FileScanWorkerLaunch;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  scheduler?: DeadlineScheduler;
  transcriptIndexScheduler?: (feed: TranscriptIndexFeed) => void;
}

function abortError(reason?: unknown): Error {
  return reason instanceof Error ? reason : new DOMException("file scan cancelled", "AbortError");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileCatalogScan(value: unknown): value is FileCatalogScan {
  return record(value)
    && Array.isArray(value.files)
    && Array.isArray(value.projectCatalog)
    && typeof value.complete === "boolean"
    && (value.conversationCatalog === undefined || Array.isArray(value.conversationCatalog))
    && (value.pinOverlayPaths === undefined || Array.isArray(value.pinOverlayPaths));
}

function workerMessage(value: unknown): FileScanWorkerMessage | null {
  if (!record(value)
    || (value.type !== "resource" && value.type !== "complete")
    || !fileCatalogScan(value.snapshot)) return null;
  return value as unknown as FileScanWorkerMessage;
}

export interface FileScanWorkerLaunch {
  executable: string;
  workerPath: string;
}

/**
 * The worker artifact THIS process can run, or `null` when its root carries
 * none.
 *
 * Both artifacts are resolved against the process root: the container's
 * checkout, or a built Next server. The published MCP runtime release is
 * neither — its root holds `dist/`, `node_modules/` and a manifest — and the
 * final branch used to return the source path it had just found missing and
 * spawn it anyway. Every corpus read in that process then died with
 * `Module not found`, which is how a candidate whose whole HTTP surface was
 * healthy failed its `board_snapshot` gate (#790). Naming the absence lets the
 * caller scan in-process instead of launching nothing.
 */
export function fileScanWorkerLaunch(cwd = process.cwd()): FileScanWorkerLaunch | null {
  const source = path.join(cwd, "src/lib/fileScanner.worker.ts");
  const bundled = path.join(cwd, ".next/server/file-scanner-worker.js");
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) {
    return { executable: "/usr/local/bin/bun-container", workerPath: source };
  }
  if (fs.existsSync(bundled)) {
    const bun = process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun");
    return { executable: bun, workerPath: bundled };
  }
  if (fs.existsSync(source)) return { executable: process.execPath, workerPath: source };
  return null;
}

export function fileScanWorkerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV !== "test"
    && env.LLV_FILE_SCANNER_WORKER !== "1"
    && env.LLV_FILE_SCANNER_WORKER_DISABLED !== "1";
}

export function collectFileScanInWorker(
  options: SerializableFileScanOptions,
  onResourceSnapshot?: (snapshot: FileCatalogScan) => void,
  runtime: FileScanWorkerRuntime = {},
): Promise<FileCatalogScan> {
  if (runtime.signal?.aborted) return Promise.reject(abortError(runtime.signal.reason));
  return withViewerOperation("scanner.worker", async () => {
    const scheduler = runtime.scheduler ?? systemScheduler;
    const expiresAt = performance.now() + (runtime.timeoutMs ?? FILE_SCAN_WORKER_TIMEOUT_MS);
    // All launches and retry waits belong to one generation and one deadline.
    const deadline = deadlineSignal(runtime.timeoutMs ?? FILE_SCAN_WORKER_TIMEOUT_MS, {
      signal: runtime.signal, scheduler, reason: "file scanner worker timed out",
    });
    try {
      for (let attempt = 0; ; attempt++) {
        if (deadline.signal.aborted) throw abortError(deadline.signal.reason);
        try {
          return await collectFileScanAttempt(options, onResourceSnapshot, { ...runtime, signal: deadline.signal }, expiresAt);
        } catch (error) {
          const delay = FILE_SCAN_BOOTSTRAP_BACKOFF_MS[attempt];
          if (!(error instanceof FileScannerBootstrapBusyError) || delay === undefined) throw error;
          await waitForBootstrapRetry(delay, deadline.signal, scheduler);
        }
      }
    } finally {
      deadline.release();
    }
  });
}

function waitForBootstrapRetry(ms: number, signal: AbortSignal, scheduler: DeadlineScheduler): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError(signal.reason)); return; }
    const onAbort = () => {
      scheduler.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal.reason));
    };
    const timer = scheduler.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function collectFileScanAttempt(
  options: SerializableFileScanOptions,
  onResourceSnapshot: ((snapshot: FileCatalogScan) => void) | undefined,
  runtime: FileScanWorkerRuntime,
  expiresAt: number,
): Promise<FileCatalogScan> {
  if (runtime.signal?.aborted) return Promise.reject(abortError(runtime.signal.reason));
  const launch = runtime.launch ?? fileScanWorkerLaunch(runtime.cwd);
  /* Callers choose the in-process scan when no artifact is present; reaching
     here without one would spawn a path this process does not have. */
  if (!launch) return Promise.reject(new Error("this process has no file scanner worker artifact"));
  const catalogScanToken = beginProjectCatalogScan(false);
  /* Nothing created after the worker starts listing is in its inventory. */
  const listedAt = Date.now();
  /* Full-corpus scans are background freshness work. Keep the interactive
     Next process ahead of their CPU demand on a busy operator host. Explicit
     test/runtime launch seams retain their exact command. */
  const useNice = runtime.launch === undefined && fs.existsSync("/usr/bin/nice");
  /* Under a lease: the scan ends with this Viewer however it exits, and the
     deadline below ends the worker's whole group (src/lib/helperLease.ts). */
  const child = spawnLeasedHelper("file-scanner", {
    command: useNice ? "/usr/bin/nice" : launch.executable,
    args: [...(useNice ? ["-n", "10", launch.executable] : []), launch.workerPath],
    cwd: runtime.cwd ?? process.cwd(),
    env: {
      ...withoutUnsupportedApiCredentials(runtime.env ?? process.env),
      LLV_FILE_SCANNER_WORKER: "1",
    },
  }, undefined, { input: true, stdout: "pipe", stderr: "pipe", followRelease: false });
  const input = leasedHelperInput(child);
  return new Promise<FileCatalogScan>((resolve, reject) => {
    let settled = false;
    let listening = false;
    let stdout = "";
    let stderr = "";
    let diagnosticLine = "";
    let outputBytes = 0;
    let completed: FileCatalogScan | null = null;
    let completedConversationCatalog: FileCatalogScan["conversationCatalog"];
    let terminationError: Error | null = null;
    let receivedFrame = false;
    let inputError: Error | undefined;
    const finish = (error?: Error, snapshot?: FileCatalogScan) => {
      if (settled) return;
      settled = true;
      if (listening) {
        runtime.signal?.removeEventListener("abort", onAbort);
        listening = false;
      }
      if (error) reject(error);
      else resolve(snapshot!);
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      endLeasedHelper(child);
      if (child.exitCode !== null || child.signalCode !== null) finish(error);
    };
    const fail = (message: string) => {
      terminate(new Error(message));
    };
    const onAbort = () => terminate(abortError(runtime.signal?.reason));
    const consume = () => performanceSpans.sync("scanner.ipc-frame", () => {
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const raw = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!raw) continue;
        let parsed: unknown;
        try {
          parsed = performanceSpans.sync("scanner.ipc-decode", () => JSON.parse(raw), 0, Buffer.byteLength(raw));
        } catch {
          fail("file scanner worker emitted invalid JSON");
          return;
        }
        const message = workerMessage(parsed);
        if (!message) {
          fail("file scanner worker emitted an invalid message");
          return;
        }
        receivedFrame = true;
        if (message.type === "resource") {
          performanceSpans.sync("scanner.publication", () => onResourceSnapshot?.(message.snapshot));
        } else {
          const { conversationCatalog, ...snapshot } = message.snapshot;
          /* The full scanner runs in a child process. Its process-global
             publication cannot update the parent that serves /api/conversations,
             so carry the completed uncapped catalog over the existing worker
             response. Publication waits for successful worker exit below. */
          completedConversationCatalog = conversationCatalog;
          completed = snapshot;
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > FILE_SCAN_WORKER_OUTPUT_MAX_BYTES) {
        fail("file scanner worker exceeded output limit");
        return;
      }
      stdout += chunk;
      consume();
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      // Successful worker waits must remain visible in the service journal.
      // Forward only complete, bounded monitoring lines; retain the ordinary
      // stderr tail below for the existing failure receipt.
      diagnosticLine += chunk;
      let newline: number;
      while ((newline = diagnosticLine.indexOf("\n")) >= 0) {
        const line = diagnosticLine.slice(0, newline);
        diagnosticLine = diagnosticLine.slice(newline + 1);
        if (line.length <= FILE_SCAN_WORKER_STDERR_MAX_BYTES
          && /^\[(?:blocking-wait|viewer loop-gap|performance summary)\]/.test(line)) console.error(line);
      }
      if (diagnosticLine.length > FILE_SCAN_WORKER_STDERR_MAX_BYTES) diagnosticLine = "";
      stderr = `${stderr}${chunk}`;
      if (Buffer.byteLength(stderr) > FILE_SCAN_WORKER_STDERR_MAX_BYTES) {
        stderr = Buffer.from(stderr).subarray(-FILE_SCAN_WORKER_STDERR_MAX_BYTES).toString("utf8");
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (terminationError) {
        finish(terminationError);
        return;
      }
      consume();
      if (code !== 0 || !completed) {
        const detail = stderr.trim() || inputError?.message || "";
        // Retry only a bootstrap refusal before any resource was published.
        // A later failure may follow scanner effects and remains decisive.
        const BootstrapError = code === 1 && !signal && !receivedFrame
          && /state database initialization is busy|state admission is busy at state\.schema(?:\s|$)/.test(detail)
          ? FileScannerBootstrapBusyError : Error;
        finish(new BootstrapError(`file scanner worker exited before completion (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (completedConversationCatalog) {
        const currentScan = isProjectCatalogScanCurrent(catalogScanToken);
        performanceSpans.sync("scanner.publication", () =>
          publishConversationCatalogForScan(completedConversationCatalog!, catalogScanToken, completed!.complete));
        if (currentScan) {
          if (completed!.complete) void conversationSearchProjection().prepare(completedConversationCatalog!).catch(() => undefined);
          (runtime.transcriptIndexScheduler ?? scheduleTranscriptIndex)(
            performanceSpans.sync("transcript.feed", () =>
              transcriptIndexFeed(completedConversationCatalog!, completed!.complete, undefined, listedAt)),
          );
        }
      }
      finish(undefined, completed);
    });
    input.once("error", (error) => {
      // A bootstrap refusal can close stdin before the request is written.
      // Wait for close to retain its stderr and release the owned child before
      // deciding whether that refusal is retryable.
      inputError = error;
    });
    if (runtime.signal) {
      runtime.signal.addEventListener("abort", onAbort, { once: true });
      listening = true;
      if (runtime.signal.aborted) onAbort();
    }
    input.end(JSON.stringify({ type: "scan", options, lockWaitMs: Math.max(0, expiresAt - performance.now()) }));
  });
}
