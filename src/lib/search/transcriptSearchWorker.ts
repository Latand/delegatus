import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "@/lib/configDir";
import { leasedHelperInput, spawnLeasedHelper, unrefLeasedHelper } from "@/lib/helperLease";
import {
  InvalidTranscriptSearchCursorError, TranscriptSearchPageTooLargeError,
  type TranscriptSearchOptions, type TranscriptSearchResult,
} from "./transcriptSearch";

const TIMEOUT_MS = 30_000;
const IDLE_MS = 60_000;
const FRAME_BYTES = 64 * 1024 * 1024; // complete highlighted source for trusted projections

export function transcriptSearchQueryWorkerLaunch(cwd = process.cwd()): { executable: string; workerPath: string } {
  const source = path.join(cwd, "src/lib/transcriptSearchQuery.worker.ts");
  const bundled = path.join(cwd, ".next/server/transcript-search-query-worker.js");
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) {
    return { executable: "/usr/local/bin/bun-container", workerPath: source };
  }
  return {
    executable: process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun"),
    workerPath: fs.existsSync(bundled) ? bundled : source,
  };
}

interface Job {
  id: number;
  options: TranscriptSearchOptions;
  settled: boolean;
  finish: (error?: Error, result?: TranscriptSearchResult) => void;
}

interface Resident {
  child: ChildProcess;
  closed: Promise<void>;
  buffer: string;
  idle?: ReturnType<typeof setTimeout>;
}

export interface TranscriptSearchWorkerRuntime {
  cwd?: string;
  env?: Partial<NodeJS.ProcessEnv>;
  launch?: { executable: string; workerPath: string };
  timeoutMs?: number;
  idleMs?: number;
}

/** One serial query lane. Queue time counts against the deadline; cancelled
    queued work never reaches SQLite. An interrupted active query ends its
    leased process group before a successor starts. There is no inline retry. */
export class TranscriptSearchWorker {
  private worker: Resident | null = null;
  private active: Job | null = null;
  private jobs = new Set<Job>();
  private tail: Promise<void> = Promise.resolve();
  private closing: Promise<void> = Promise.resolve();
  private nextId = 0;
  constructor(private runtime: TranscriptSearchWorkerRuntime = {}) {}

  search(options: TranscriptSearchOptions, signal?: AbortSignal): Promise<TranscriptSearchResult> {
    if (signal?.aborted) return Promise.reject(new DOMException("Transcript search cancelled", "AbortError"));
    if (this.jobs.size >= 64) return Promise.reject(new Error("Transcript search queue is full"));
    return new Promise((resolve, reject) => {
      let complete!: () => void;
      const completed = new Promise<void>(done => { complete = done; });
      const cancel = (error: Error) => {
        job.finish(error);
        if (this.active === job && this.worker) this.retire(this.worker);
      };
      const abort = () => cancel(new DOMException("Transcript search cancelled", "AbortError"));
      const timer = setTimeout(() => cancel(new Error("Transcript search timed out")), this.runtime.timeoutMs ?? TIMEOUT_MS);
      const job: Job = {
        id: this.nextId++, options, settled: false,
        finish: (error, result) => {
          if (job.settled) return;
          job.settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.jobs.delete(job);
          if (error) reject(error); else resolve(result!);
          complete();
        },
      };
      this.jobs.add(job);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      this.tail = this.tail.then(async () => {
        if (job.settled) return;
        try {
          await this.waitForRetirement();
          if (job.settled) return;
          this.active = job;
          const worker = this.worker ?? this.start();
          clearTimeout(worker.idle);
          const { redactText, ...query } = options;
          this.write(worker, { type: "search", id: job.id, options: query, redact: Boolean(redactText) });
          await completed;
          await this.waitForRetirement();
          if (this.worker === worker) {
            worker.idle = setTimeout(() => this.retire(worker), this.runtime.idleMs ?? IDLE_MS);
            worker.idle.unref();
          }
        } catch {
          job.finish(new Error("Transcript search worker is unavailable"));
          if (this.worker) this.retire(this.worker);
        } finally { this.active = null; }
      });
    });
  }

  private write(worker: Resident, frame: unknown): void {
    leasedHelperInput(worker.child).write(JSON.stringify(frame) + "\n");
  }

  private start(): Resident {
    const cwd = this.runtime.cwd ?? process.cwd();
    const launch = this.runtime.launch ?? transcriptSearchQueryWorkerLaunch(cwd);
    const child = spawnLeasedHelper("transcript-search-query", {
      command: launch.executable, args: [launch.workerPath], cwd,
      env: { ...process.env, ...this.runtime.env, LLV_STATE_DIR: this.runtime.env?.LLV_STATE_DIR ?? stateDir() },
    }, this.runtime.env?.LLV_STATE_DIR ?? stateDir(), { input: true, stdout: "pipe", followRelease: false });
    const worker: Resident = { child, buffer: "", closed: new Promise(resolve => { child.once("close", () => resolve()); }) };
    this.worker = worker;
    const fail = () => {
      if (this.worker !== worker) return;
      this.active?.finish(new Error("Transcript search worker is unavailable"));
      this.retire(worker);
    };
    child.once("error", fail);
    child.once("close", fail);
    leasedHelperInput(child).on("error", fail);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("error", fail);
    child.stdout!.on("data", (chunk: string) => {
      if (this.worker !== worker) return;
      worker.buffer += chunk;
      if (Buffer.byteLength(worker.buffer) > FRAME_BYTES) { fail(); return; }
      let end: number;
      while ((end = worker.buffer.indexOf("\n")) >= 0) {
        const frame = worker.buffer.slice(0, end);
        worker.buffer = worker.buffer.slice(end + 1);
        try { this.answer(worker, JSON.parse(frame)); }
        catch { fail(); return; }
      }
    });
    // The lease closes at owner death; idle stdio must not hold that owner open.
    unrefLeasedHelper(child);
    return worker;
  }

  private answer(worker: Resident, frame: Record<string, unknown>): void {
    const job = this.active;
    if (!job || job.settled || frame.id !== job.id) throw new Error("Unexpected search worker answer");
    if (frame.type === "redact" && typeof frame.text === "string" && job.options.redactText) {
      this.write(worker, { type: "redacted", id: job.id, text: job.options.redactText(frame.text) });
    } else if (frame.type === "error") {
      job.finish(frame.name === "InvalidTranscriptSearchCursorError" ? new InvalidTranscriptSearchCursorError()
        : frame.name === "TranscriptSearchPageTooLargeError" ? new TranscriptSearchPageTooLargeError()
        : new Error("Transcript search worker is unavailable"));
    } else if (frame.type === "result" && frame.result && typeof frame.result === "object") {
      const result = frame.result as TranscriptSearchResult;
      if (!Array.isArray(result.items) || typeof result.total !== "number" || !result.stats
        || typeof result.stats.conversationsIndexed !== "number" || typeof result.stats.messagesIndexed !== "number"
        || !Array.isArray(result.stats.fieldsSearched) || typeof result.stats.tokenizer !== "string"
        || (result.nextCursor !== null && typeof result.nextCursor !== "string")) throw new Error("Invalid search page");
      job.finish(undefined, result);
      if (typeof frame.rssBytes === "number" && frame.rssBytes > 512 * 1024 * 1024) this.retire(worker);
    } else throw new Error("Invalid search worker answer");
  }

  private retire(worker: Resident): void {
    clearTimeout(worker.idle);
    if (this.worker !== worker) return;
    this.worker = null;
    // Closing the lease runs guardian cleanup on Windows too, where sending
    // SIGTERM would terminate the guardian before it could reap its helper.
    worker.child.stdin?.end();
    this.closing = worker.closed;
  }

  private waitForRetirement(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Transcript search worker did not stop")), 5_000);
      // A deadline bounds this caller's wait. The exit barrier itself remains
      // pending until confirmed closure, so a late exit admits a later request.
      void this.closing.then(() => { clearTimeout(timer); resolve(); });
    });
  }

  async shutdown(): Promise<void> {
    for (const job of this.jobs) job.finish(new Error("Transcript search worker stopped"));
    if (this.worker) this.retire(this.worker);
    await this.waitForRetirement();
    await this.tail;
  }
}

const pool = globalThis as typeof globalThis & {
  __llvTranscriptSearchWorker?: { directory: string; worker: TranscriptSearchWorker };
};

export async function searchTranscriptsInWorker(options: TranscriptSearchOptions, signal?: AbortSignal): Promise<TranscriptSearchResult> {
  const directory = stateDir();
  if (pool.__llvTranscriptSearchWorker?.directory !== directory) {
    if (pool.__llvTranscriptSearchWorker) await pool.__llvTranscriptSearchWorker.worker.shutdown();
    if (pool.__llvTranscriptSearchWorker?.directory !== directory) {
      pool.__llvTranscriptSearchWorker = { directory, worker: new TranscriptSearchWorker({ env: { LLV_STATE_DIR: directory } }) };
    }
  }
  try {
    return await pool.__llvTranscriptSearchWorker.worker.search(options, signal);
  } catch (error) {
    // Next bundles this module for multiple routes. The global lane may come
    // from another bundle, whose domain error constructors have other identities.
    if (error instanceof Error && error.name === "InvalidTranscriptSearchCursorError") throw new InvalidTranscriptSearchCursorError();
    if (error instanceof Error && error.name === "TranscriptSearchPageTooLargeError") throw new TranscriptSearchPageTooLargeError();
    throw error;
  }
}

export async function shutdownTranscriptSearchWorker(): Promise<void> {
  await pool.__llvTranscriptSearchWorker?.worker.shutdown();
  pool.__llvTranscriptSearchWorker = undefined;
}
