import { sweepMonotonicNow } from "../runtime/attemptTempDeadline";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper, unrefLeasedHelper } from "@/lib/helperLease";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { TempSweepReport } from "@/lib/tempSweep";
import type { DiskPressure } from "@/lib/state/diskPressure";
import type { MemoryReading } from "@/lib/state/memoryPressure";
import type { WorktreeSweepMode, WorktreeSweepReport } from "./worktreeSweep";
import type { ApprovedAttemptTempRequest, ApprovedAttemptTempReport } from "../runtime/attemptTempApproved";
import type { CleanerSweepRequest, CleanerSweepResult } from "../cleaner/diskSweep";
import { SweepWalkDeferred } from "./sweepWalkAdmission";

export const WORKTREE_SWEEP_DEADLINE_MS = 45 * 60_000;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const DISK_PRESSURE_CACHE_TTL_MS = 30_000;
const DISK_PRESSURE_REQUEST_TIMEOUT_MS = 10_000;
const ATTEMPT_TEMP_REQUEST_TIMEOUT_MS = 60_000;
export type SweepWorkerClock = { now: () => number; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
const sweepClock: SweepWorkerClock = { now: sweepMonotonicNow, setTimeout, clearTimeout };
export type SweepWorkerLaunch = { executable: string; entry: string; args?: string[] };
export function worktreeSweepWorkerLaunch(cwd = process.cwd()): SweepWorkerLaunch {
  const source = path.join(cwd, "src/lib/worktreeSweep.worker.ts");
  const bundle = path.join(cwd, ".next/server/worktree-sweep-worker.js");
  const container = "/usr/local/bin/bun-container";
  if (fs.existsSync(source) && fs.existsSync(container)) return { executable: container, entry: source };
  if (fs.existsSync(bundle)) return { executable: process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun", entry: bundle };
  return { executable: process.execPath, entry: source };
}

export type SweepRequest = { kind: "worktrees"; mode: WorktreeSweepMode }
  | { kind: "temp"; env: Pick<NodeJS.ProcessEnv, "LLV_TEMP_SWEEP" | "LLV_TEMP_SWEEP_MAX_AGE_HOURS" | "LLV_TEMP_STRAY_MAX_AGE_HOURS" | "LLV_TEMP_STRAY_KEEP"> }
  | { kind: "attempt-temp" }
  | { kind: "attempt-temp-approved"; approval: ApprovedAttemptTempRequest }
  | { kind: "maintenance" }
  | { kind: "disk-cleaner"; sweep: CleanerSweepRequest }
  | { kind: "disk-pressure" }
  | { kind: "disk-consumers" }
  | { kind: "memory" };
type SweepResult = WorktreeSweepReport | TempSweepReport | DiskPressure | CleanerSweepResult | ApprovedAttemptTempReport | Awaited<ReturnType<typeof import("../runtime/attemptTempProduction").runAttemptTempSweep>> | { checked: number; removed: number } | MemoryReading | null;
type Pending = { request: SweepRequest; resolve: (report: SweepResult) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; finishPhase?: () => void; failure?: Error };
/** The leased child keeps directory observers between passes. No filesystem
 * inspections, registry snapshots or report writes run on the Viewer loop.
 * The guardian contains its Git/namespace children on owner loss or deadline.
 */
export class WorktreeSweepWorker {
  private child?: ChildProcess;
  private jobs = new Map<SweepRequest["kind"], Promise<SweepResult>>();
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private pressureWorker?: WorktreeSweepWorker;
  private attemptWorker?: WorktreeSweepWorker;
  private diskPressureCache?: { report: DiskPressure; observedAt: number };
  private pending?: Pending;
  private output = "";
  private replyBytes = 0;
  private recycleAfterReply = false;
  private closed: Promise<void> = Promise.resolve();
  constructor(private readonly launch = worktreeSweepWorkerLaunch(), private readonly timeoutMs = WORKTREE_SWEEP_DEADLINE_MS,
    private readonly clock: SweepWorkerClock = sweepClock, private readonly pressureOnly = false, private readonly attemptOnly = false) {}

  private start() {
    const child = this.child = spawnLeasedHelper(this.pressureOnly ? "disk-pressure" : this.attemptOnly ? "attempt-temp" : "worktree-sweep", {
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
      while (this.output.includes("\n")) {
        if (!this.pending) { this.fail(new Error("worktree sweep worker answered without a request")); return; }
        const newline = this.output.indexOf("\n");
        try {
          const response = JSON.parse(this.output.slice(0, newline));
          this.output = this.output.slice(newline + 1);
          if (response?.phase !== undefined) {
            const phase = response.phase;
            if (this.pending.request.kind !== "worktrees" || !["discovery", "candidate", "accounting"].includes(phase))
              throw new Error("worktree sweep worker returned an invalid phase");
            this.pending.finishPhase?.();
            const label = `worktrees.${phase}` as "worktrees.discovery" | "worktrees.candidate" | "worktrees.accounting";
            withViewerOperation(label, () => new Promise<void>(resolve => { this.pending!.finishPhase = resolve; }));
            continue;
          }
          const report = response?.report;
          const kind = this.pending.request.kind;
          const deferred = kind !== "disk-pressure" && kind !== "memory"
            && (response?.deferred === "busy" || response?.deferred === "memory") ? response.deferred : undefined;
          const valid = kind === "disk-consumers" ? report === null
            : kind === "disk-cleaner" ? report && Array.isArray(report.kept) && Number.isInteger(report.errors)
              && (report.next === null || typeof report.next === "string") && typeof report.more === "boolean"
            : kind === "attempt-temp" || kind === "attempt-temp-approved" || kind === "maintenance" ? report === null || report && Number.isInteger(report.checked) && Number.isInteger(report.removed)
            : kind === "memory" ? report === null || report && Number.isFinite(report.ram?.usedBytes) && Number.isFinite(report.swap?.usedBytes) && "tmp" in report
            : kind === "disk-pressure"
            ? report && typeof report.at === "string" && Number.isFinite(Date.parse(report.at))
              && Array.isArray(report.volumes) && Array.isArray(report.consumers)
            : (kind === "temp" && report === null) || (report && Array.isArray(report.removed) && Array.isArray(report.errors)
              && (kind === "worktrees" ? Array.isArray(report.kept)
                : report.kept && !Array.isArray(report.kept) && typeof report.kept === "object"));
          if (!response || response.error || (!valid && !deferred))
            throw new Error(response?.error || "worktree sweep worker returned an invalid report");
          if (this.pending.failure) return;
          const pending = this.pending;
          this.clock.clearTimeout(pending.timer);
          pending.finishPhase?.();
          this.pending = undefined;
          unrefLeasedHelper(child);
          if (deferred) {
            if (kind === "attempt-temp" || kind === "maintenance" || kind === "disk-consumers") pending.resolve(null);
            else pending.reject(new SweepWalkDeferred(deferred));
            continue;
          }
          this.recycleAfterReply = response.recycle === true;
          if (kind === "disk-pressure") {
            this.diskPressureCache = { report: response.report as DiskPressure, observedAt: Date.parse(response.report.at) };
          }
          pending.resolve(response.report);
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
      }
    });
    leasedHelperInput(child).on("error", error => this.fail(error));
    child.once("error", error => this.fail(error));
    this.closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
      if (this.child === child) this.child = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        this.clock.clearTimeout(pending.timer);
        pending.finishPhase?.();
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
    if (existing) return request.kind === "worktrees" || request.kind === "attempt-temp-approved" || request.kind === "disk-cleaner"
      ? Promise.reject(new Error(`${request.kind} sweep is already running`)) : existing;
    const generation = this.generation;
    const attempt = request.kind === "attempt-temp" || request.kind === "attempt-temp-approved" || request.kind === "disk-cleaner";
    const observation = request.kind === "disk-pressure" || request.kind === "memory";
    const timeoutMs = observation ? Math.min(this.timeoutMs, DISK_PRESSURE_REQUEST_TIMEOUT_MS)
      : attempt || request.kind === "maintenance" || request.kind === "disk-consumers"
        ? Math.min(this.timeoutMs, ATTEMPT_TEMP_REQUEST_TIMEOUT_MS) : this.timeoutMs;
    const deadline = this.clock.now() + timeoutMs;
    const operation = attempt || request.kind === "temp" || request.kind === "maintenance" ? "temp.sweep"
      : observation || request.kind === "disk-consumers" ? "resources.read" : "worktrees.sweep";
    const deadlineLabel = request.kind === "disk-cleaner" ? "disk cleaner slice" : attempt ? "attempt temp tick"
      : request.kind === "worktrees" ? "worktree sweep" : request.kind === "temp" ? "temp sweep"
        : request.kind === "memory" ? "memory reading" : request.kind === "disk-consumers" ? "disk consumer measurement" : "disk pressure refresh";
    // At most one job per kind; polls join rather than retaining an unbounded
    // queue. The same deadline includes time behind another sweep.
    const execution = withViewerOperation(operation, () => this.tail.then(() => {
      if (generation !== this.generation) throw new Error("worktree sweep worker stopped");
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) {
        if (request.kind === "attempt-temp" || request.kind === "maintenance") {
          // The minute tick spent its observation window behind another
          // sweep. There is no failed root and no helper to kill. Its next
          // scheduled tick must get a fresh request and admission window.
          console.error(`[attempt temp] deferred: helper queue exceeded ${timeoutMs} ms; retry next tick`);
          return null;
        }
        throw new Error(`${deadlineLabel} exceeded ${timeoutMs} ms`);
      }
      return new Promise<SweepResult>((resolve, reject) => {
        if (!this.child) this.start();
        const child = this.child!;
        child.ref();
        for (const stream of child.stdio) (stream as unknown as { ref?: () => void } | null)?.ref?.();
        this.replyBytes = 0;
        this.recycleAfterReply = false;
        const timer = this.clock.setTimeout(() => this.fail(new Error(`${deadlineLabel} exceeded ${timeoutMs} ms`)), remaining);
        this.pending = { request, resolve, reject, timer };
        leasedHelperInput(child).write(JSON.stringify({ ...request, deadline }) + "\n");
      });
    }));
    const completed = execution.then(async report => {
      const attemptComplete = request.kind === "attempt-temp" && !!(report as { pass?: { ended?: unknown } } | null)?.pass?.ended;
      if ((this.recycleAfterReply || request.kind === "worktrees" && (report as WorktreeSweepReport | null)?.progress?.complete || attemptComplete) && this.child) {
        // Release observers and allocator high-water memory at the pass
        // boundary or RSS threshold. A continuation can resume its durable
        // cursor even if the helper has to rebuild its discovery projection.
        endLeasedHelper(this.child);
        await this.closed;
      }
      return report;
    });
    const job = completed.finally(() => { if (this.jobs.get(request.kind) === job) this.jobs.delete(request.kind); });
    this.jobs.set(request.kind, job);
    this.tail = job.then(() => {}, () => {});
    return job;
  }

  run(mode: WorktreeSweepMode): Promise<WorktreeSweepReport> {
    return this.request({ kind: "worktrees", mode }) as Promise<WorktreeSweepReport>;
  }
  temp(env: NodeJS.ProcessEnv = process.env): Promise<TempSweepReport | null> {
    return this.request({ kind: "temp", env: { LLV_TEMP_SWEEP: env.LLV_TEMP_SWEEP, LLV_TEMP_SWEEP_MAX_AGE_HOURS: env.LLV_TEMP_SWEEP_MAX_AGE_HOURS,
      LLV_TEMP_STRAY_MAX_AGE_HOURS: env.LLV_TEMP_STRAY_MAX_AGE_HOURS, LLV_TEMP_STRAY_KEEP: env.LLV_TEMP_STRAY_KEEP } }) as Promise<TempSweepReport | null>;
  }
  attemptTemp(): Promise<SweepResult> {
    if (!this.attemptOnly) {
      // A worktree pass can hold its helper for minutes. Scratch pressure
      // gets its own leased owner and coalesced queue, like disk observations.
      this.attemptWorker ??= new WorktreeSweepWorker(this.launch, this.timeoutMs, this.clock, false, true);
      return this.attemptWorker.attemptTemp();
    }
    return this.request({ kind: "attempt-temp" });
  }
  approvedAttemptTemp(approval: ApprovedAttemptTempRequest): Promise<ApprovedAttemptTempReport> {
    if (!this.attemptOnly) {
      this.attemptWorker ??= new WorktreeSweepWorker(this.launch, this.timeoutMs, this.clock, false, true);
      return this.attemptWorker.approvedAttemptTemp(approval);
    }
    return this.request({ kind: "attempt-temp-approved", approval }) as Promise<ApprovedAttemptTempReport>;
  }
  maintenance() { return this.request({ kind: "maintenance" }); }
  diskConsumers() { return this.request({ kind: "disk-consumers" }); }
  diskCleaner(sweep: CleanerSweepRequest): Promise<CleanerSweepResult> {
    if (!this.attemptOnly) {
      this.attemptWorker ??= new WorktreeSweepWorker(this.launch, this.timeoutMs, this.clock, false, true);
      return this.attemptWorker.diskCleaner(sweep);
    }
    return this.request({ kind: "disk-cleaner", sweep }) as Promise<CleanerSweepResult>;
  }
  diskPressure(): Promise<DiskPressure> {
    // A separate leased reader observes volumes while retirement is busy.
    // Polls still join one bounded request and reuse its short-lived cache.
    if (!this.pressureOnly) {
      this.pressureWorker ??= new WorktreeSweepWorker(this.launch, Math.min(this.timeoutMs, DISK_PRESSURE_REQUEST_TIMEOUT_MS), this.clock, true);
      return this.pressureWorker.diskPressure();
    }
    const cached = this.diskPressureCache;
    if (cached) {
      const age = Date.now() - cached.observedAt;
      if (age >= 0 && age < DISK_PRESSURE_CACHE_TTL_MS) return Promise.resolve(structuredClone(cached.report));
    }
    const existing = this.jobs.get("disk-pressure");
    if (existing) return existing as Promise<DiskPressure>;
    return this.request({ kind: "disk-pressure" }) as Promise<DiskPressure>;
  }

  /** RAM, swap and the machine's `/tmp`, beside the disk reading: the same
      leased reader, which may enter the host namespace. */
  memory(): Promise<MemoryReading | null> {
    if (!this.pressureOnly) {
      this.pressureWorker ??= new WorktreeSweepWorker(this.launch, Math.min(this.timeoutMs, DISK_PRESSURE_REQUEST_TIMEOUT_MS), this.clock, true);
      return this.pressureWorker.memory();
    }
    return this.request({ kind: "memory" }) as Promise<MemoryReading | null>;
  }

  async close() {
    this.generation++;
    const tail = this.tail;
    if (this.child) this.fail(new Error("worktree sweep worker stopped"));
    await Promise.all([this.closed, this.pressureWorker?.close(), this.attemptWorker?.close()]);
    this.pressureWorker = undefined;
    this.attemptWorker = undefined;
    await tail;
  }
}

const shared = globalThis as typeof globalThis & { __delegatusWorktreeSweepWorker?: WorktreeSweepWorker };
function worker() { return shared.__delegatusWorktreeSweepWorker ??= new WorktreeSweepWorker(); }
export function runWorktreeSweepOffThread(mode: WorktreeSweepMode) { return worker().run(mode); }
export function runTempSweepOffThread(env: NodeJS.ProcessEnv) { return worker().temp(env); }
export function runAttemptTempSweepOffThread() { return worker().attemptTemp(); }
export function runTemporaryDataMaintenanceOffThread() { return worker().maintenance(); }
export function runDiskCleanerOffThread(sweep: CleanerSweepRequest) { return worker().diskCleaner(sweep); }
export function readDiskPressureOffThread() { return worker().diskPressure(); }
export function measureDiskConsumersOffThread() { return worker().diskConsumers(); }
export function readMemoryReadingOffThread() { return worker().memory(); }
export async function stopWorktreeSweepWorker() {
  const worker = shared.__delegatusWorktreeSweepWorker;
  shared.__delegatusWorktreeSweepWorker = undefined;
  await worker?.close();
}
