import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper, unrefLeasedHelper } from "@/lib/helperLease";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { TempSweepReport } from "@/lib/tempSweep";
import type { DiskPressure } from "@/lib/state/diskPressure";
import type { WorktreeSweepMode, WorktreeSweepReport } from "./worktreeSweep";

export const WORKTREE_SWEEP_DEADLINE_MS = 45 * 60_000;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const DISK_PRESSURE_CACHE_TTL_MS = 30_000;
const DISK_PRESSURE_REQUEST_TIMEOUT_MS = 10_000;
export type SweepWorkerLaunch = { executable: string; entry: string; args?: string[] };
export function worktreeSweepWorkerLaunch(cwd = process.cwd()): SweepWorkerLaunch {
  const source = path.join(cwd, "src/lib/worktreeSweep.worker.ts");
  const bundle = path.join(cwd, ".next/server/worktree-sweep-worker.js");
  const container = "/usr/local/bin/bun-container";
  if (fs.existsSync(source) && fs.existsSync(container)) return { executable: container, entry: source };
  if (fs.existsSync(bundle)) return { executable: process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun", entry: bundle };
  return { executable: process.execPath, entry: source };
}

type SweepRequest = { kind: "worktrees"; mode: WorktreeSweepMode }
  | { kind: "temp"; env: Pick<NodeJS.ProcessEnv, "LLV_TEMP_SWEEP" | "LLV_TEMP_SWEEP_MAX_AGE_HOURS"> }
  | { kind: "disk-pressure" };
type SweepResult = WorktreeSweepReport | TempSweepReport | DiskPressure | null;
type Pending = { request: SweepRequest; resolve: (report: SweepResult) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; failure?: Error };
/** The leased child keeps directory observers between passes. No filesystem
 * inspections, registry snapshots or report writes run on the Viewer loop.
 * The guardian contains its Git/namespace children on owner loss or deadline.
 */
export class WorktreeSweepWorker {
  private child?: ChildProcess;
  private jobs = new Map<SweepRequest["kind"], Promise<SweepResult>>();
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private diskPressureCache?: { report: DiskPressure; observedAt: number };
  private pending?: Pending;
  private output = "";
  private replyBytes = 0;
  private closed: Promise<void> = Promise.resolve();
  constructor(private readonly launch = worktreeSweepWorkerLaunch(), private readonly timeoutMs = WORKTREE_SWEEP_DEADLINE_MS) {}

  private start() {
    const child = this.child = spawnLeasedHelper("worktree-sweep", {
      command: this.launch.executable, args: [this.launch.entry, ...(this.launch.args ?? [])], cwd: process.cwd(),
      // Read state already migrated by the serving Viewer. No startup authority.
      env: { ...process.env, LLV_STATE_OWNER: "tool" },
    }, undefined, { input: true, stdout: "pipe", stderr: "inherit" });
    this.output = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (!this.pending) { this.fail(new Error("worktree sweep worker answered without a request")); return; }
      this.replyBytes += Buffer.byteLength(chunk);
      if (this.replyBytes > MAX_REPLY_BYTES) { this.fail(new Error("worktree sweep worker reply exceeded its bound")); return; }
      this.output += chunk;
      const newline = this.output.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(this.output.slice(0, newline));
        this.output = this.output.slice(newline + 1);
        const report = response?.report;
        const kind = this.pending.request.kind;
        const valid = kind === "disk-pressure"
          ? report && typeof report.at === "string" && Number.isFinite(Date.parse(report.at))
            && Array.isArray(report.volumes) && Array.isArray(report.consumers)
          : (kind === "temp" && report === null) || (report && Array.isArray(report.removed) && Array.isArray(report.errors)
            && (kind === "worktrees" ? Array.isArray(report.kept)
              : report.kept && !Array.isArray(report.kept) && typeof report.kept === "object"));
        if (!response || response.error || !valid)
          throw new Error(response?.error || "worktree sweep worker returned an invalid report");
        if (this.pending.failure) return;
        const pending = this.pending;
        clearTimeout(pending.timer);
        this.pending = undefined;
        unrefLeasedHelper(child);
        if (kind === "disk-pressure") {
          this.diskPressureCache = { report: response.report as DiskPressure, observedAt: Date.parse(response.report.at) };
        }
        pending.resolve(response.report);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    leasedHelperInput(child).on("error", error => this.fail(error));
    child.once("error", error => this.fail(error));
    this.closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
      if (this.child === child) this.child = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(pending.failure ?? new Error(`worktree sweep worker exited with ${code ?? signal}`));
      }
      resolve();
    }));
  }

  private fail(error: Error) {
    if (this.pending) this.pending.failure ??= error;
    if (this.child) endLeasedHelper(this.child);
  }

  private request(request: SweepRequest): Promise<SweepResult> {
    const existing = this.jobs.get(request.kind);
    if (existing) return request.kind === "worktrees"
      ? Promise.reject(new Error("worktree sweep is already running")) : existing;
    const generation = this.generation;
    const timeoutMs = request.kind === "disk-pressure" ? Math.min(this.timeoutMs, DISK_PRESSURE_REQUEST_TIMEOUT_MS) : this.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    const operation = request.kind === "temp" ? "temp.sweep" : request.kind === "disk-pressure" ? "resources.read" : "worktrees.sweep";
    const deadlineLabel = request.kind === "worktrees" ? "worktree sweep" : request.kind === "temp" ? "temp sweep" : "disk pressure refresh";
    // At most one job per kind; polls join rather than retaining an unbounded
    // queue. The same deadline includes time behind another sweep.
    const execution = withViewerOperation(operation, () => this.tail.then(() => {
      if (generation !== this.generation) throw new Error("worktree sweep worker stopped");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${deadlineLabel} exceeded ${timeoutMs} ms`);
      return new Promise<SweepResult>((resolve, reject) => {
        if (!this.child) this.start();
        const child = this.child!;
        child.ref();
        for (const stream of child.stdio) (stream as unknown as { ref?: () => void } | null)?.ref?.();
        this.replyBytes = 0;
        const timer = setTimeout(() => this.fail(new Error(`${deadlineLabel} exceeded ${timeoutMs} ms`)), remaining);
        this.pending = { request, resolve, reject, timer };
        leasedHelperInput(child).write(JSON.stringify(request) + "\n");
      });
    }));
    const job = execution.finally(() => { if (this.jobs.get(request.kind) === job) this.jobs.delete(request.kind); });
    this.jobs.set(request.kind, job);
    this.tail = job.then(() => {}, () => {});
    return job;
  }

  run(mode: WorktreeSweepMode): Promise<WorktreeSweepReport> {
    return this.request({ kind: "worktrees", mode }) as Promise<WorktreeSweepReport>;
  }
  temp(env: NodeJS.ProcessEnv = process.env): Promise<TempSweepReport | null> {
    return this.request({ kind: "temp", env: { LLV_TEMP_SWEEP: env.LLV_TEMP_SWEEP, LLV_TEMP_SWEEP_MAX_AGE_HOURS: env.LLV_TEMP_SWEEP_MAX_AGE_HOURS } }) as Promise<TempSweepReport | null>;
  }
  diskPressure(): Promise<DiskPressure> {
    const cached = this.diskPressureCache;
    if (cached) {
      const age = Date.now() - cached.observedAt;
      if (age >= 0 && age < DISK_PRESSURE_CACHE_TTL_MS) return Promise.resolve(structuredClone(cached.report));
    }
    const existing = this.jobs.get("disk-pressure");
    if (existing) return existing as Promise<DiskPressure>;
    if (this.jobs.has("worktrees") || this.jobs.has("temp")) {
      const job = Promise.reject(new Error("disk pressure observation is stale while the sweep helper is busy"))
        .finally(() => { if (this.jobs.get("disk-pressure") === job) this.jobs.delete("disk-pressure"); });
      void job.catch(() => {});
      this.jobs.set("disk-pressure", job);
      return job as Promise<DiskPressure>;
    }
    return this.request({ kind: "disk-pressure" }) as Promise<DiskPressure>;
  }

  async close() {
    this.generation++;
    const tail = this.tail;
    if (this.child) this.fail(new Error("worktree sweep worker stopped"));
    await this.closed;
    await tail;
  }
}

const shared = globalThis as typeof globalThis & { __delegatusWorktreeSweepWorker?: WorktreeSweepWorker };
function worker() { return shared.__delegatusWorktreeSweepWorker ??= new WorktreeSweepWorker(); }
export function runWorktreeSweepOffThread(mode: WorktreeSweepMode) { return worker().run(mode); }
export function runTempSweepOffThread(env: NodeJS.ProcessEnv) { return worker().temp(env); }
export function readDiskPressureOffThread() { return worker().diskPressure(); }
export async function stopWorktreeSweepWorker() {
  const worker = shared.__delegatusWorktreeSweepWorker;
  shared.__delegatusWorktreeSweepWorker = undefined;
  await worker?.close();
}
