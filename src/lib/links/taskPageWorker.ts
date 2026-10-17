import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "@/lib/configDir";
import { leasedHelperInput, spawnLeasedHelper, unrefLeasedHelper } from "@/lib/helperLease";
import { storedLessonRevision } from "@/lib/memory/roleStore";
import { lastScannedFiles } from "@/lib/scanner/scanCache";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { FeedFilter, FeedFiles, ScanPage, LogPage, Position } from "./taskFeed";
import type { PageBuildRequest, PageBuildResult, PageRequest } from "./taskPageBuild";
import { markTaskExport } from "./taskExportPrivacy";
import { sharedLinkState } from "./runtimeState";

export function taskPageWorkerLaunch(cwd = process.cwd()) {
  const source = path.join(cwd, "src/lib/taskPage.worker.ts");
  const bundled = path.join(cwd, ".next/server/task-page-worker.js");
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) return { executable: "/usr/local/bin/bun-container", workerPath: source };
  return { executable: process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun"), workerPath: fs.existsSync(bundled) ? bundled : source };
}
export type TaskPageWorkerRuntime = { cwd?: string; env?: Partial<NodeJS.ProcessEnv>; launch?: ReturnType<typeof taskPageWorkerLaunch>; timeoutMs?: number };
type Job = { id: number; settled: boolean; finish(error?: Error, result?: PageBuildResult): void };
type Resident = { child: ChildProcess; closed: Promise<void>; buffer: string; files?: ReturnType<typeof lastScannedFiles> };
const unavailable = () => Object.assign(new Error("Task export privacy filter is unavailable; nothing was sent"), { code: "LESSON_PRIVACY_UNAVAILABLE" });

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
  lastCpu: NodeJS.CpuUsage | null = null;
  constructor(private runtime: TaskPageWorkerRuntime = {}) {}

  build(request: PageRequest, filter: FeedFilter): Promise<PageBuildResult> {
    if (this.jobs.size >= 16) return Promise.reject(unavailable());
    return withViewerOperation("links.task-export", () => new Promise<PageBuildResult>((resolve, reject) => {
      let complete!: () => void;
      const completed = new Promise<void>(done => { complete = done; });
      const job: Job = { id: ++this.nextId, settled: false, finish: (error, result) => {
        if (job.settled) return;
        job.settled = true; clearTimeout(timer); this.jobs.delete(job);
        if (error) reject(error); else resolve(result!);
        complete();
      } };
      const timer = setTimeout(() => {
        job.finish(unavailable());
        if (this.active === job && this.resident) this.retire(this.resident);
      }, this.runtime.timeoutMs ?? 60_000);
      this.jobs.add(job);
      this.tail = this.tail.then(async () => {
        if (job.settled) return;
        try {
          await this.waitForRetirement();
          if (job.settled) return;
          this.active = job;
          const worker = this.resident ?? this.start();
          clearTimeout(this.idle);
          const files = lastScannedFiles();
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
          const wire: PageBuildRequest = { ...request, now: filter.now ?? Date.now(), filter: {
            self: filter.self, skipPrefix: filter.skipPrefix, peerTaskWireVersion: filter.peerTaskWireVersion,
            includeBoard: filter.includeBoard, includePrototypeReview: filter.includePrototypeReview,
            filePath: filter.filePath, projects: [...filter.projects].sort(),
          }, ...(observation ? { files: observation } : {}) };
          leasedHelperInput(worker.child).write(`${JSON.stringify({ id: job.id, request: wire })}\n`);
          worker.files = files;
          await completed;
          await this.waitForRetirement();
          if (this.resident === worker) {
            // Keep the page cache through the failing peer's five-minute wait.
            this.idle = setTimeout(() => this.retire(worker), 10 * 60_000);
            this.idle.unref();
          }
        } catch {
          job.finish(unavailable());
          if (this.resident) this.retire(this.resident);
        } finally { this.active = null; }
      });
    }));
  }

  private start(): Resident {
    const cwd = this.runtime.cwd ?? process.cwd();
    const launch = this.runtime.launch ?? taskPageWorkerLaunch(cwd);
    const directory = this.runtime.env?.LLV_STATE_DIR ?? stateDir();
    const child = spawnLeasedHelper("task-export", { command: launch.executable, args: [launch.workerPath], cwd,
      env: { ...process.env, ...this.runtime.env, LLV_STATE_DIR: directory } }, directory, { input: true, stdout: "pipe", stderr: "ignore", followRelease: false });
    const worker: Resident = { child, buffer: "", closed: new Promise(resolve => child.once("close", () => resolve())) };
    this.resident = worker;
    const fail = () => { if (this.resident === worker) { this.active?.finish(unavailable()); this.retire(worker); } };
    child.once("error", fail); child.once("close", fail);
    leasedHelperInput(child).on("error", fail);
    child.stdout!.on("error", fail); child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (this.resident !== worker) return;
      worker.buffer += chunk;
      if (Buffer.byteLength(worker.buffer) > 2 * 1024 * 1024) { fail(); return; }
      let end: number;
      while ((end = worker.buffer.indexOf("\n")) >= 0) {
        const line = worker.buffer.slice(0, end); worker.buffer = worker.buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          const job = this.active;
          if (!job || job.settled || job.id !== frame.id) throw unavailable();
          if (frame.error || !frame.result?.page || typeof frame.result.privacyRevision !== "string") throw unavailable();
          if (frame.result.page.rows?.length && storedLessonRevision() !== frame.result.privacyRevision) throw unavailable();
          this.builds = frame.result.builds;
          this.lastCpu = frame.result.cpu;
          job.finish(undefined, frame.result);
        } catch { fail(); return; }
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
      const timer = setTimeout(() => reject(unavailable()), 5_000);
      void this.closing.then(() => { clearTimeout(timer); resolve(); });
    });
  }
  async shutdown() {
    for (const job of this.jobs) job.finish(unavailable());
    if (this.resident) this.retire(this.resident);
    await this.waitForRetirement(); await this.tail;
  }
}
const pool = sharedLinkState("taskPages.worker", () => ({ directory: "", worker: null as TaskPageWorker | null }));
async function page(request: PageRequest, filter: FeedFilter): Promise<LogPage | ScanPage> {
  const directory = stateDir();
  if (pool.directory !== directory) {
    await pool.worker?.shutdown();
    if (pool.directory !== directory) { pool.directory = directory; pool.worker = new TaskPageWorker({ env: { LLV_STATE_DIR: directory } }); }
  }
  const result = await pool.worker!.build(request, filter);
  if (request.kind === "scan") Object.defineProperty(result.page, "at", { value: [result.startRevision] });
  return "rows" in result.page && result.page.rows.length ? markTaskExport(result.page, result.privacyRevision) : result.page;
}
export async function readScanPageInWorker(after: string, filter: FeedFilter): Promise<ScanPage & { at: Position }> { return await page({ kind: "scan", after }, filter) as ScanPage & { at: Position }; }
export async function readLogPageInWorker(after: Position, filter: FeedFilter): Promise<LogPage> { return await page({ kind: "log", after }, filter) as LogPage; }
export async function shutdownTaskPageWorker() { await pool.worker?.shutdown(); pool.worker = null; pool.directory = ""; }

export function taskPageWorkerDiagnostics() { return { builds: pool.worker?.builds ?? 0, cpu: pool.worker?.lastCpu ?? null }; }
