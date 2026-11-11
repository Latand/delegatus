import { PrivacyWorkError, privacyFailureCode, privacyFailureOf, type PrivacyFailure } from "@/lib/memory/privacyFailure";
import { privacyWorkTimeoutMs } from "@/lib/memory/privacyRetry";
import { currentOperationLease } from "@/lib/operationLease";
import { observePrivacyWorkerJob, privacyWorkerObservations } from "@/lib/memory/privacyDiagnostics";
import { performanceSpans } from "@/lib/performanceSpans";
import type { PrivacyRequest, PrivacyResult } from "@/lib/memory/privacyWork";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "@/lib/configDir";
import { leasedHelperInput, spawnLeasedHelper, unrefLeasedHelper } from "@/lib/helperLease";
import { RoleMemoryRefusal, storedLessonRevision } from "@/lib/memory/roleStore";
import { lastScannedFiles } from "@/lib/scanner/scanCache";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { residentWorkerOverLimit } from "@/lib/residentWorkerMemory";
import type { FeedFilter, FeedFiles, ScanPage, LogPage, Position } from "./taskFeed";
import type { PageBuildResult, PageRequest } from "./taskPageBuild";
import { markTaskExport } from "./taskExportPrivacy";
import { sharedLinkState } from "./runtimeState";

export function taskPageWorkerLaunch(cwd = process.cwd()) {
  const source = path.join(cwd, "src/lib/taskPage.worker.ts");
  const bundled = path.join(cwd, ".next/server/task-page-worker.js");
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) return { executable: "/usr/local/bin/bun-container", workerPath: source };
  return { executable: process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun"), workerPath: fs.existsSync(bundled) ? bundled : source };
}
export type TaskPageWorkerRuntime = { cwd?: string; env?: Partial<NodeJS.ProcessEnv>; launch?: ReturnType<typeof taskPageWorkerLaunch>; timeoutMs?: number; onPhase?: (phase: "compile" | "match") => void;
  /** A job that raises the worker's resident set by this much is named in the journal. */
  memoryStepBytes?: number };
/** One job adding this much resident memory is worth a journal line: the kind
 * of job and the sizes, never its content. */
const MEMORY_STEP_BYTES = 256 * 1024 * 1024;
type WorkResult = PageBuildResult | PrivacyResult;
type Job = { id: number; settled: boolean; observation: ReturnType<typeof observePrivacyWorkerJob>; phaseDone?: () => void; finish(error?: Error, result?: WorkResult): void };
type Resident = { child: ChildProcess; closed: Promise<void>; buffer: string; files?: ReturnType<typeof lastScannedFiles>;
  /** When this process was started, how many jobs it answered, and the resident set it last reported. */
  startedAt: number; served: number; rssBytes?: number; rssBefore?: number };
/** A task page worker holds the lesson matchers and a page cache. Above this
 * resident size after a job it is retired and the next job starts a fresh
 * process; `LLV_RESIDENT_WORKER_RSS_LIMIT_MB` overrides it for every worker. */
export const TASK_PAGE_WORKER_RSS_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const unavailable = (failure: PrivacyFailure = "worker-unavailable") => Object.assign(new PrivacyWorkError(failure), { code: "LESSON_PRIVACY_UNAVAILABLE" });

/** One leased, serial lane shared by route bundles. A queue of 16 and a 60s
 * deadline bound work; an idle worker retires after ten minutes, releasing its LRU.
 * A worker failure never falls back to inline or unfiltered task export. */
export class TaskPageWorker {
  private resident: Resident | null = null;
  private active: Job | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closing: Promise<void> = Promise.resolve();
  private jobs = new Set<Job>();
  private nextId = 0;
  private idle?: ReturnType<typeof setTimeout>;
  builds = 0;
  /** Worker processes started, and how many were retired over the memory limit. */
  starts = 0;
  memoryRetirements = 0;
  lastCpu: NodeJS.CpuUsage | null = null;
  constructor(private runtime: TaskPageWorkerRuntime = {}) {}

  build(request: PageRequest, filter: FeedFilter): Promise<PageBuildResult> {
    return this.submit(request, filter) as Promise<PageBuildResult>;
  }
  privacy(request: PrivacyRequest): Promise<PrivacyResult> {
    return this.submit(request) as Promise<PrivacyResult>;
  }
  private submit(request: PageRequest | PrivacyRequest, filter?: FeedFilter): Promise<WorkResult> {
    const budgetMs = Math.min(this.runtime.timeoutMs ?? 60_000, privacyWorkTimeoutMs());
    if (this.jobs.size >= 16) {
      observePrivacyWorkerJob(budgetMs).emit("settled", "worker-queue-full");
      return Promise.reject(unavailable("worker-queue-full"));
    }
    return withViewerOperation(filter ? "links.task-export" : request.kind === "curation-undo" ? "memory.import.curation" : "memory.privacy.worker", () => performanceSpans.wait("privacy.worker", () => new Promise<WorkResult>((resolve, reject) => {
      let complete!: () => void;
      const completed = new Promise<void>(done => { complete = done; });
      const diagnostic = observePrivacyWorkerJob(budgetMs);
      const signal = currentOperationLease()?.abort.signal;
      const cancelled = () => diagnostic.emit("cancelled");
      const job: Job = { id: ++this.nextId, observation: diagnostic, settled: false, finish: (error, result) => {
        if (job.settled) return;
        job.settled = true; job.phaseDone?.(); clearTimeout(timer); this.jobs.delete(job);
        signal?.removeEventListener("abort", cancelled);
        const failure = error instanceof RoleMemoryRefusal && (error.code === "CURATE_LIVE" || error.code === "CURATE_INVALID")
          ? error.code : error ? privacyFailureOf(error) : undefined;
        diagnostic.emit(failure === "worker-timeout" ? "timeout" : "settled", failure);
        if (error) reject(error); else resolve(result!);
        complete();
      } };
      const timer = setTimeout(() => {
        job.finish(unavailable("worker-timeout"));
        if (this.active === job && this.resident) this.retire(this.resident);
      }, budgetMs);
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
      this.jobs.add(job);
      this.tail = this.tail.then(async () => {
        if (job.settled) return;
        try {
          await this.waitForRetirement();
          if (job.settled) return;
          this.active = job;
          const worker = this.resident ?? this.start();
          clearTimeout(this.idle);
          const files = filter ? lastScannedFiles() : worker.files;
          let observation: FeedFiles | undefined;
          if (worker.files !== files) {
            const projected: FeedFiles[number][] = [];
            let inspected = 0;
            for (const file of files ?? []) {
              const { path, conversationId, pendingQuestion, waitingInput } = file;
              // A member with no pending decision cannot resurface an expired
              // done task. Carry only observations the eligibility predicate uses.
              if (pendingQuestion || waitingInput) projected.push({ path, conversationId, pendingQuestion, waitingInput });
              if (++inspected % 128 === 0) await new Promise<void>(done => setImmediate(done));
              if (job.settled) return;
            }
            observation = projected.sort((a, b) => a.path.localeCompare(b.path) || (a.conversationId ?? "").localeCompare(b.conversationId ?? ""));
          }
          const wire = filter ? { ...request, now: filter.now ?? Date.now(), filter: {
            self: filter.self, skipPrefix: filter.skipPrefix, peerTaskWireVersion: filter.peerTaskWireVersion,
            includeBoard: filter.includeBoard, includePrototypeReview: filter.includePrototypeReview,
            filePath: filter.filePath, projects: [...filter.projects].sort(),
          }, ...(observation ? { files: observation } : {}) } : request;
          const encoded = JSON.stringify({ id: job.id, correlation: diagnostic.correlation, request: wire });
          if (!filter && Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw unavailable("worker-input-too-large");
          leasedHelperInput(worker.child).write(`${encoded}\n`);
          diagnostic.emit("dispatched");
          worker.files = files;
          await completed;
          await this.waitForRetirement();
          if (this.resident === worker) {
            worker.served += 1;
            const before = worker.rssBefore, after = worker.rssBytes;
            worker.rssBefore = after;
            if (before !== undefined && after !== undefined && after - before >= (this.runtime.memoryStepBytes ?? MEMORY_STEP_BYTES)) {
              console.warn(`[task-page-worker] memory step ${JSON.stringify({ kind: filter ? `page-${request.kind}` : request.kind, addedBytes: after - before, rssBytes: after, served: worker.served })}`);
            }
            // Between two jobs: this one is answered and the next has not been
            // written to the worker. A job already queued waits for this
            // process to close and then starts a fresh one.
            if (worker.rssBytes !== undefined && residentWorkerOverLimit("task-page-worker", { defaultLimitBytes: TASK_PAGE_WORKER_RSS_LIMIT_BYTES,
              served: worker.served, rssBytes: worker.rssBytes, pid: worker.child.pid, ageMs: performance.now() - worker.startedAt, env: { ...process.env, ...this.runtime.env } })) {
              this.memoryRetirements += 1;
              this.retire(worker);
            } else {
              // Keep the page cache through the failing peer's five-minute wait.
              this.idle = setTimeout(() => this.retire(worker), 10 * 60_000);
              this.idle.unref();
            }
          }
        } catch (error) {
          job.finish(unavailable(privacyFailureOf(error)));
          if (this.resident) this.retire(this.resident);
        } finally { this.active = null; }
      });
    })));
  }

  private start(): Resident {
    const cwd = this.runtime.cwd ?? process.cwd();
    const launch = this.runtime.launch ?? taskPageWorkerLaunch(cwd);
    const directory = this.runtime.env?.LLV_STATE_DIR ?? stateDir();
    const child = spawnLeasedHelper("task-export", { command: launch.executable, args: [launch.workerPath], cwd,
      env: { ...process.env, ...this.runtime.env, LLV_STATE_DIR: directory } }, directory, { input: true, stdout: "pipe", stderr: "ignore", followRelease: false });
    const worker: Resident = { child, buffer: "", closed: new Promise(resolve => child.once("close", () => resolve())), startedAt: performance.now(), served: 0 };
    this.resident = worker; this.starts += 1;
    const fail = (failure: PrivacyFailure) => { if (this.resident === worker) { this.active?.finish(unavailable(failure)); this.retire(worker); } };
    child.once("error", () => fail("worker-io")); child.once("close", () => fail("worker-exited"));
    leasedHelperInput(child).on("error", () => fail("worker-io"));
    child.stdout!.on("error", () => fail("worker-io")); child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (this.resident !== worker) return;
      worker.buffer += chunk;
      if (Buffer.byteLength(worker.buffer) > 2 * 1024 * 1024) { fail("worker-invalid-reply"); return; }
      let end: number;
      while ((end = worker.buffer.indexOf("\n")) >= 0) {
        const line = worker.buffer.slice(0, end); worker.buffer = worker.buffer.slice(end + 1);
        try {
          let frame;
          try { frame = JSON.parse(line); }
          catch { throw unavailable("worker-invalid-reply"); }
          if (!frame || typeof frame !== "object") throw unavailable("worker-invalid-reply");
          const job = this.active;
          if (!job || job.settled || job.id !== frame.id) throw unavailable("worker-invalid-reply");
          if (typeof frame.rssBytes === "number") worker.rssBytes = frame.rssBytes;
          // Older fixtures/retained worker replies may lack an acknowledgement;
          // their execution duration stays explicitly unknown. A supplied token
          // must agree with this exact job before any phase/result is consumed.
          if (frame.correlation !== undefined && (frame.correlation?.requestId !== job.observation.correlation.requestId
            || frame.correlation?.jobId !== job.observation.correlation.jobId)) throw unavailable("worker-invalid-reply");
          if (frame.phase === "started") {
            if (!frame.correlation) throw unavailable("worker-invalid-reply");
            job.observation.emit("started"); continue;
          }
          if (frame.phase === "compile" || frame.phase === "match") {
            job.phaseDone?.();
            const phase = frame.phase as "compile" | "match";
            job.observation.emit(phase);
            this.runtime.onPhase?.(phase);
            void withViewerOperation(`memory.privacy.${phase}`, () => performanceSpans.wait(`privacy.${phase}`, () => new Promise<void>(done => { job.phaseDone = done; })));
            continue;
          }
          if (frame.curationRefusal === "CURATE_LIVE" || frame.curationRefusal === "CURATE_INVALID") {
            job.finish(new RoleMemoryRefusal(frame.curationRefusal, frame.curationRefusal === "CURATE_LIVE" ? "only a completed curator pass can be undone" : "pass version is unavailable")); continue;
          }
          if (frame.error) throw unavailable(privacyFailureCode(frame.failure) ?? "worker-unavailable");
          if (!frame.result || typeof frame.result.privacyRevision !== "string"
            || !(frame.result.page || Object.hasOwn(frame.result, "value"))) throw unavailable("worker-invalid-reply");
          if (storedLessonRevision() !== frame.result.privacyRevision) throw unavailable("store-changed");
          if (frame.result.page) { this.builds = frame.result.builds; this.lastCpu = frame.result.cpu; }
          job.finish(undefined, frame.result);
        } catch (error) { fail(privacyFailureOf(error, "worker-invalid-reply")); return; }
      }
    });
    unrefLeasedHelper(child);
    return worker;
  }
  private retire(worker: Resident) {
    if (this.resident !== worker) return;
    this.resident = null; clearTimeout(this.idle);
    worker.child.stdin?.end(); // lease guardian ends the owned group, including a blocked filter
    this.closing = worker.closed;
  }
  private waitForRetirement(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(unavailable("worker-retirement-timeout")), 5_000);
      void this.closing.then(() => { clearTimeout(timer); resolve(); });
    });
  }
  async shutdown() {
    for (const job of this.jobs) job.finish(unavailable("worker-shutdown"));
    if (this.resident) this.retire(this.resident);
    await this.waitForRetirement(); await this.tail;
  }
}
const pool = sharedLinkState("taskPages.worker", () => ({ directory: "", worker: null as TaskPageWorker | null }));
async function sharedWorker(): Promise<TaskPageWorker> {
  const directory = stateDir();
  if (pool.directory !== directory) {
    await pool.worker?.shutdown();
    if (pool.directory !== directory) { pool.directory = directory; pool.worker = new TaskPageWorker({ env: { LLV_STATE_DIR: directory } }); }
  }
  return pool.worker!;
}
async function page(request: PageRequest, filter: FeedFilter): Promise<LogPage | ScanPage> {
  const result = await (await sharedWorker()).build(request, filter);
  if (request.kind === "scan") Object.defineProperty(result.page, "at", { value: [result.startRevision] });
  return "rows" in result.page && result.page.rows.length ? markTaskExport(result.page, result.privacyRevision) : result.page;
}
export async function readScanPageInWorker(after: string, filter: FeedFilter): Promise<ScanPage & { at: Position }> { return await page({ kind: "scan", after }, filter) as ScanPage & { at: Position }; }
export async function readLogPageInWorker(after: Position, filter: FeedFilter): Promise<LogPage> { return await page({ kind: "log", after }, filter) as LogPage; }
export async function shutdownTaskPageWorker() { await pool.worker?.shutdown(); pool.worker = null; pool.directory = ""; }

export function taskPageWorkerDiagnostics() { return { builds: pool.worker?.builds ?? 0, cpu: pool.worker?.lastCpu ?? null, privacy: privacyWorkerObservations() }; }

export async function runPrivacyWork(request: PrivacyRequest): Promise<PrivacyResult> {
  // A missing collection is an affirmative empty revision. Reading this
  // scalar still refuses an unreadable store and observes later creation.
  const revision = storedLessonRevision();
  if (request.kind === "filter" && revision === "") return { privacyRevision: revision, value: request.value };
  return (await sharedWorker()).privacy(request);
}
