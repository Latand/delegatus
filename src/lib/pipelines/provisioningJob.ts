import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "@/lib/configDir";
import { describeTransientGitFailure, transientGitFailure } from "@/lib/git/transientFailure";
import { operationPortIdentity, withoutOperationLease } from "@/lib/operationLease";
import { captureProcessIdentity, processIdentityStatus, systemBootEpoch } from "@/lib/processIdentity";
import { DISK_SPACE_RETRY_MS, DISK_SPACE_WAIT_PREFIX, worktreeDiskWait } from "@/lib/state/diskPressure";
import { StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import { hotStateSqliteWriterReady, hotStateWriterRevision, readHotStateAuthority } from "@/lib/state/hotStateAuthority";
import { realExec } from "@/lib/workflows/provision";
import { reportProvisioningPhase } from "./controllerJobs";
import { requestPipelineTick } from "./controllerSignal";
import {
  ensurePipelineCheckout, planPipelineCheckout, prepareProvisionedPipeline, realProvisionExec, resolvePipelineBaseAsync,
  verifyProvisioningCheckoutReceipt,
  WORKTREE_INITIALIZATION_HELD, type PreservedProvisionRef, type ProvisionExecPort,
} from "./git";
import { pipelinePublishesRemoteBranch } from "./publication";
import { provesProvisionCacheHolder } from "./provisionCacheHolder";
import { physicalProvisioningPath, provisioningStripe, tryProvisioningLock, type ProvisioningGrant } from "./provisionCheckoutCustody";
import { observeLegacyInstaller, type LegacyInstallerObservation } from "./provisionLegacyInstaller";
import { ProvisionToolchainFailure, runProvisionToolchain } from "./provisionToolchain";
import { provisionToolchainEntry } from "./provisionToolchainEntry";
import { PROVISION_STEPS, provisioningStepView, validProvisioningRecord, type ProvisioningRecord, type ProvisioningStepView, type ProvisionStep } from "./provisioningRecord";
import { controllerPipelineVersionNow, deliveryJournal, findControllerPipeline, provisioningCacheOwnerKeys, withProvisioningCheckpoint } from "./store";
import type { Pipeline, PipelineBoundedWait } from "./types";
import type { StateBoundedTransaction } from "@/lib/state/sqliteStateStore";

const MAX_EXECUTORS = 4;
const EXECUTION_MS = 360_000;
const RETRY_MS = 180_000;
const ADD_ROLLBACK_DEFERRAL_MS = 300_000;
const METADATA_STEPS = new Set<ProvisionStep>(["startingToolchain", "checkingDependencies", "validatingSealedGraph"]);
const instance = randomUUID();
let stopped = false;

export type ProvisionClock = {
  wallMs(): number;
  monotonicMs(): number;
  arm(delayMs: number, run: () => void): () => void;
};

type ProvisionPorts = {
  exec: typeof realExec;
  provisionExec?: ProvisionExecPort;
  provisionClock?: ProvisionClock;
  provisionToolchainReply?: (id: string, type: string, detail?: string) => Promise<void>;
  observeProvisioningCheckpoint?: (id: string, step: ProvisioningStepView | undefined, at: number) => void | Promise<void>;
  now(): string;
  monotonicNow(): number;
  scheduleTick?(delayMs?: number): void;
  worktreeDiskWait?: (repo: string, worktree: string, usesClaude: boolean) => string | null;
};

type Handle = { finished: Promise<boolean>; abort: AbortController; subject: string; token?: string; revision?: string; child?: ChildProcess; writing?: boolean };
type Pool = { handles: Map<string, Handle>; cancelWake?: () => void; due?: number; wake?: symbol; poll?: ReturnType<typeof setInterval> };
const pools = new Map<string, Pool>();

export function stopProvisioningJobsForDemotion(): void {
  stopped = true;
  for (const pool of pools.values()) {
    pool.cancelWake?.();
    for (const handle of pool.handles.values()) handle.abort.abort(new JobRevoked());
  }
}

/** Each fixture owns one isolated state root and its remaining helper leases. */
export async function settleProvisioningJobsForTests(): Promise<void> {
  const pool = pools.get(stateDir());
  if (!pool) return;
  pool.cancelWake?.();
  delete pool.wake;
  delete pool.due;
  const handles = [...pool.handles.values()];
  const closing = handles.map(handle => {
    const child = handle.child;
    return child && child.exitCode === null && child.signalCode === null
      ? new Promise<void>(resolve => { child.once("close", () => resolve()); }) : Promise.resolve();
  });
  for (const handle of handles) handle.abort.abort(new JobRevoked());
  await Promise.all([...handles.map(handle => handle.finished), ...closing]);
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const asDate = (ms: number) => new Date(ms).toISOString();
const due = (value?: string) => value ? Date.parse(value) : 0;
const clockFor = (ports: ProvisionPorts): ProvisionClock => ports.provisionClock ?? {
  wallMs: () => Date.parse(ports.now()),
  monotonicMs: ports.monotonicNow,
  arm(delay, run) {
    const timer = setTimeout(run, delay);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

export function provisioningDueAt(pipeline: Pipeline): number | undefined {
  const slot = pipeline.provisioningJob;
  if (!validProvisioningRecord(slot) || slot.status === "parked") return;
  return slot.retryAt ?? slot.deadlineAt;
}

export function hasSupersededProvisioningJob(row: Pipeline): boolean {
  return row.provisioningJob !== undefined
    && (row.state === "closed" || row.state === "completed" || row.state === "running" || Boolean(row.hiddenAt));
}

function subject(row: Pipeline): string {
  return hash([planSubject(row), row.controlGeneration, row.cursor?.stageId, row.cursor?.state]);
}

function planSubject(row: Pipeline): string {
  const { delivery } = row;
  return hash([row.id, row.createdAt, row.repoDir, row.worktreeDir, row.branch, row.baseBranch,
    row.baseRef, row.baseRefPinned, row.lastPassedCommit, delivery?.ownerId, delivery?.epoch,
    delivery?.active, delivery?.target]);
}

function eligible(row: Pipeline): boolean {
  return row.state === "provisioning" && !row.closedAt && !row.hiddenAt && (!pipelinePublishesRemoteBranch(row) || !!row.delivery);
}

class JobRevoked extends Error {}
class StepDeadline extends Error {}
class Deferred extends Error {
  constructor(readonly step: ProvisionStep, readonly since: number, readonly deadline: number, readonly reason: string, readonly resource?: string,
    readonly cache?: { identity: string; holderDeadline?: number }, readonly legacyWriter?: ProvisioningRecord["legacyWriter"]) { super(reason); }
}

function schedule(pool: Pool, at: number, clock: ProvisionClock, ports: ProvisionPorts) {
  if (pool.due !== undefined && pool.due <= at) return;
  pool.cancelWake?.();
  const wake = pool.wake = Symbol();
  pool.due = at;
  pool.cancelWake = clock.arm(Math.max(0, at - clock.wallMs()), () => {
    if (pool.wake !== wake) return;
    delete pool.due;
    delete pool.wake;
    delete pool.cancelWake;
    ports.scheduleTick?.(0);
    requestPipelineTick();
  });
}

export function bindProvisioningGit(ports: Pick<ProvisionPorts, "exec" | "provisionExec">): { native: boolean; exec: ProvisionExecPort } {
  if (ports.provisionExec) return { native: false, exec: ports.provisionExec };
  if (operationPortIdentity(ports.exec) === realExec) return { native: true, exec: realProvisionExec };
  return { native: false, exec: async (command, args, cwd, signal, options) => ports.exec(command, args, cwd, options?.env,
    { signal, timeoutMs: options?.timeoutMs, inheritFd: options?.inheritFd, additionalInheritedFds: options?.additionalInheritedFds }) };
}

type JobHooks = { phaseDone?: Promise<void>; parked(row: Pipeline): void };

function workerExited(worker: NonNullable<ProvisioningRecord["worker"]>): boolean {
  if (worker.bootEpoch !== systemBootEpoch() || processIdentityStatus(worker) !== "dead") return false;
  try { process.kill(-worker.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Terminal rows stay hot until the prior effect releases its native custody. */
async function retireProvisioningJob(row: Pipeline, root: string, native: boolean): Promise<boolean> {
  const slot = row.provisioningJob;
  if (!validProvisioningRecord(slot)) return false;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5_000);
  const grants: ProvisioningGrant[] = [];
  try {
    if (slot.worker && !workerExited(slot.worker)) return false;
    if (slot.admittedAdd && !await tryProvisioningLock(root, "add", slot.admittedAdd.stripe, native, abort.signal, grant => grants.push(grant))) return false;
    return await withProvisioningCheckpoint(tx => {
      const current = tx.get(row.id);
      if (!current || current.createdAt !== row.createdAt || eligible(current) || current.provisioningJob?.token !== slot.token) return false;
      delete current.provisioningJob;
      if (slot.admittedAdd) {
        if (slot.admittedAdd.previousWait) current.provisioningWait = slot.admittedAdd.previousWait;
        else delete current.provisioningWait;
      }
      tx.put(current);
      return true;
    }, 500);
  } finally {
    clearTimeout(timer);
    for (const grant of grants) grant.close();
  }
}

/** An excluded lane may retire or revoke a slot. It may never start a new
 * claim while a legacy domain walk owns the lane. */
export async function reconcileExcludedProvisioning(row: Pipeline, ports: ProvisionPorts): Promise<boolean> {
  if (stopped) return false;
  const slot = row.provisioningJob;
  if (!validProvisioningRecord(slot)) return false;
  const root = stateDir();
  const terminal = hasSupersededProvisioningJob(row);
  const active = pools.get(root)?.handles.get(row.id);
  if (active) {
    if (terminal) active.abort.abort(new JobRevoked());
    // A live local claim's monotonic timer owns expiry.
    return false;
  }
  if (terminal) return retireProvisioningJob(row, root, bindProvisioningGit(ports).native);
  const now = clockFor(ports).wallMs();
  if (!eligible(row) || (slot.status !== "running" && slot.status !== "awaitingApply") || slot.deadlineAt > now) return false;
  return withProvisioningCheckpoint(tx => {
    const current = tx.get(row.id);
    if (!current || !eligible(current) || subject(current) !== subject(row)
      || current.provisioningJob?.token !== slot.token || current.provisioningJob.deadlineAt !== slot.deadlineAt
      || current.provisioningJob.status !== slot.status) return false;
    const reason = now >= slot.executionDeadlineAt ? "provision-execution-budget-exhausted" : "provision-step-timeout";
    current.provisioningJob = { ...slot, token: randomUUID(), status: "waiting", retryAt: now + 5_000,
      interruption: slot.interruption ?? { step: slot.step, since: slot.since, deadlineAt: slot.deadlineAt, observedAt: now, reason } };
    current.stateDetail = `provisioning deferred: ${reason}`;
    tx.put(current);
    return true;
  }, 500);
}

export function advanceProvisioningJob(row: Pipeline, ports: ProvisionPorts, hooks: JobHooks): Promise<boolean> | undefined {
  if (stopped) return;
  const cleanup = hasSupersededProvisioningJob(row);
  if (!eligible(row) && !cleanup) return;
  const root = stateDir();
  let pool = pools.get(root);
  if (!pool) pools.set(root, pool = { handles: new Map() });
  const prior = pool.handles.get(row.id);
  if (prior) {
    if (cleanup) prior.abort.abort(new JobRevoked());
    return prior.finished;
  }
  const clock = clockFor(ports), current = row.provisioningJob;
  const at = cleanup ? 0 : current?.retryAt ?? (current?.admittedAdd ? 0 : due(row.provisioningWait?.retryAfter));
  if (at > clock.wallMs()) {
    schedule(pool, at, clock, ports);
    return;
  }
  if (pool.handles.size >= MAX_EXECUTORS) return;
  const abort = new AbortController();
  const handle: Handle = { subject: subject(row), abort, finished: Promise.resolve(false) };
  const ownedPool = pool;
  const git = bindProvisioningGit(ports);
  handle.finished = withoutOperationLease(async () => {
    await hooks.phaseDone;
    if (cleanup) return retireProvisioningJob(row, root, git.native);
    return runProvisioningJob(row.id, root, ports, hooks, git, clock, ownedPool, handle);
  }).catch(error => {
    if (!(error instanceof JobRevoked)) schedule(ownedPool, clock.wallMs() + 1_000, clock, ports);
    return false;
  }).finally(() => {
    const retire = () => {
      ownedPool.handles.delete(row.id);
      if (!ownedPool.handles.size) {
        clearInterval(ownedPool.poll);
        delete ownedPool.poll;
        if (ownedPool.due === undefined) pools.delete(root);
      }
      requestPipelineTick();
    };
    const child = handle.child;
    if (child && child.exitCode === null && child.signalCode === null) child.once("close", retire);
    else retire();
  });
  pool.handles.set(row.id, handle);
  if (!pool.poll) {
    let checking = false;
    pool.poll = withoutOperationLease(() => setInterval(() => {
      if (checking) return;
      checking = true;
      void Promise.all([...ownedPool.handles].map(async ([id, active]) => {
        if (!active.token || active.writing || active.abort.signal.aborted) return;
        try {
          const revision = controllerPipelineVersionNow(id);
          if (revision === active.revision) return;
          const record = await findControllerPipeline(id);
          if (!record || !eligible(record) || subject(record) !== active.subject || record.provisioningJob?.token !== active.token) {
            active.abort.abort(new JobRevoked());
          }
          active.revision = revision;
        } catch { active.abort.abort(new JobRevoked()); }
      })).finally(() => { checking = false; });
    }, 50));
    pool.poll.unref?.();
  }
  return handle.finished;
}

async function runProvisioningJob(id: string, root: string, ports: ProvisionPorts, hooks: JobHooks,
  git: ReturnType<typeof bindProvisioningGit>, clock: ProvisionClock, pool: Pool, handle: Handle): Promise<boolean> {
  let row = await findControllerPipeline(id);
  if (!row || !eligible(row) || subject(row) !== handle.subject) return false;
  const previous = row.provisioningJob;
  if (previous !== undefined && !validProvisioningRecord(previous)) {
    await withProvisioningCheckpoint(tx => {
      const current = tx.get(id);
      if (!current || !eligible(current) || subject(current) !== handle.subject || validProvisioningRecord(current.provisioningJob)) return;
      current.state = "needs_decision";
      current.stateDetail = "provisioning evidence is invalid or belongs to a newer controller; inspect the lane before retrying";
      tx.put(current);
    }, 500);
    return true;
  }
  const wall = clock.wallMs();
  const release = hotStateWriterRevision(root) ?? "unversioned";
  const authority = readHotStateAuthority(root);
  const claimed = previous?.status === "running" || previous?.status === "awaitingApply";
  if (claimed && previous.owner.instance !== instance && previous.deadlineAt > wall
    && !(authority?.mode === "sqlite" && hotStateSqliteWriterReady(root) && authority.releaseRevision !== previous.owner.release)) {
    const boot = systemBootEpoch();
    const sameDomain = boot && previous.owner.bootEpoch === boot;
    if (!sameDomain || processIdentityStatus(previous.owner) !== "dead") {
      schedule(pool, Math.min(previous.deadlineAt, wall + PROVISION_STEPS[previous.step]), clock, ports);
      return false;
    }
  }
  const { signal } = handle.abort;
  let slot: ProvisioningRecord = {
    ...previous, version: 1, kind: "provision", subject: handle.subject, planSubject: planSubject(row), generation: (previous?.generation ?? 0) + 1,
    token: randomUUID(), owner: { ...captureProcessIdentity(process.pid), instance, release },
    step: "resolvingRepository", status: "running", since: wall, deadlineAt: wall + PROVISION_STEPS.resolvingRepository,
    executionDeadlineAt: wall + EXECUTION_MS, retryAt: undefined,
    cacheOwner: undefined,
  };
  if (claimed && previous.deadlineAt <= wall && !slot.interruption) {
    slot.interruption = { step: previous.step, since: previous.since, deadlineAt: previous.deadlineAt, observedAt: wall, reason: "provision-step-timeout" };
  }
  const stale = previous?.planSubject !== undefined && previous.planSubject !== slot.planSubject;
  if (stale) {
    if (previous?.admittedAdd || previous?.worker) return false;
    delete slot.plan;
    delete slot.privateReceipt;
    delete slot.privateIntent;
    delete slot.cacheWaitSince;
    delete slot.cacheWaitIdentity;
  }
  let changed = false;
  let stopAt = clock.monotonicMs() + PROVISION_STEPS.resolvingRepository;
  let executionStop = clock.monotonicMs() + EXECUTION_MS;
  let metadataStop = Infinity;
  let cancelTimer: (() => void) | undefined;
  let checkoutGrant: ProvisioningGrant | null = null;
  let armed: symbol | undefined;
  const grants = new Set<ProvisioningGrant>();
  const own = (grant: ProvisioningGrant) => {
    if (signal.aborted) grant.close();
    else grants.add(grant);
  };
  const cleanup = () => {
    armed = undefined;
    cancelTimer?.();
    for (const grant of grants) {
      const child = handle.child;
      if (grant === checkoutGrant && child && child.exitCode === null && child.signalCode === null) {
        child.once("close", grant.close);
      } else grant.close();
    }
    grants.clear();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  const arm = () => {
    cancelTimer?.();
    const token = armed = Symbol();
    const deadline = stopAt;
    cancelTimer = clock.arm(Math.max(0, deadline - clock.monotonicMs()), () => {
      if (armed === token) handle.abort.abort(new StepDeadline());
    });
  };
  arm();
  const read = () => { signal.throwIfAborted(); if (clock.monotonicMs() >= stopAt) throw new StepDeadline(); };
  const write = async (update: (record: Pipeline, tx: StateBoundedTransaction<Pipeline>) => void,
    next: ProvisioningRecord | null = slot, initial = false, afterStop = false) => {
    if (!afterStop) read();
    handle.writing = true;
    const result = await withProvisioningCheckpoint(tx => {
      const current = tx.get(id);
      if (!current || !eligible(current) || subject(current) !== handle.subject
        || current.provisioningJob?.token !== (initial ? previous?.token : slot.token)
        || (!initial && current.provisioningJob?.step !== slot.step)) throw new JobRevoked();
      if (!afterStop) read();
      update(current, tx);
      if (next) {
        next.subject = subject(current);
        next.planSubject = planSubject(current);
        if (!validProvisioningRecord(next)) throw new Error("provisioning evidence exceeds its limits");
        current.provisioningJob = next;
      } else delete current.provisioningJob;
      tx.put(current);
      return current;
    }, afterStop ? 500 : stopAt - clock.monotonicMs()).finally(() => { handle.writing = false; });
    changed = true;
    handle.subject = subject(result);
    const transitioned = initial || !next || next.step !== slot.step || next.since !== slot.since || next.status !== slot.status;
    if (next) { handle.token = next.token; slot = next; }
    else delete handle.token;
    row = result;
    if (transitioned) {
      const view = provisioningStepView(result);
      const at = clock.wallMs();
      if (view) reportProvisioningPhase(id, { phase: "step", view }, asDate(at));
      if (ports.observeProvisioningCheckpoint) await ports.observeProvisioningCheckpoint(id, view, at);
    }
    requestPipelineTick();
  };
  const step = async (name: ProvisionStep) => {
    read();
    if (slot.step === name) return;
    const now = clock.wallMs(), monotonic = clock.monotonicMs();
    if (name === "startingToolchain") metadataStop = monotonic + PROVISION_STEPS.startingToolchain;
    const bound = Math.min(executionStop, monotonic + PROVISION_STEPS[name], METADATA_STEPS.has(name) ? metadataStop : Infinity);
    let cutoff = bound;
    if (name === "applyingCheckout" && previous?.status === "awaitingApply") {
      cutoff = Math.min(bound, monotonic + Math.max(0, previous.deadlineAt - now));
    }
    await write(() => {}, { ...slot, step: name, since: now, deadlineAt: now + Math.ceil(Math.max(0, cutoff - monotonic)),
      status: name === "applyingCheckout" ? "awaitingApply" : "running" });
    stopAt = cutoff;
    arm();
    read();
  };
  const park = async (reason: string) => {
    const bounded = reason.slice(0, 256);
    await write(current => {
      current.state = "needs_decision";
      current.pausedState = null;
      current.stateDetail = bounded;
      current.dismissedAt = null;
      delete current.dismissedBy;
      delete current.dismissedNote;
      if (!slot.admittedAdd) delete current.provisioningWait;
    }, { ...slot, status: "parked", retryAt: undefined,
      interruption: slot.interruption ?? { step: slot.step, since: slot.since, deadlineAt: slot.deadlineAt, observedAt: clock.wallMs(),
        reason: /^[a-z][a-z-]{1,63}$/.test(bounded) ? bounded : "provisioning-refused" } },
    false, true);
    hooks.parked(row!);
  };
  const wait = async (error: Deferred) => {
    const at = Math.min(error.deadline, clock.wallMs() + 5_000, error.cache?.holderDeadline ?? Infinity);
    await write(current => { current.stateDetail = `provisioning wait: ${error.reason}`; },
      { ...slot, step: error.step, since: error.since, deadlineAt: error.deadline, status: "waiting", retryAt: at,
      resource: error.resource, waitReason: error.reason,
      ...(error.cache ? { cacheWaitSince: error.since, cacheWaitIdentity: error.cache.identity } : {}),
      ...(error.step === "waitingForLegacyInstaller" ? { legacyWaitSince: error.since, legacyWriter: error.legacyWriter } : {}) }, false, true);
    schedule(pool, at, clock, ports);
  };
  const deferLegacyWriter = async (cause: Exclude<LegacyInstallerObservation, { kind: "clear" }>): Promise<never> => {
    const since = slot.legacyWaitSince ?? clock.wallMs();
    const detail = cause.kind === "possible-writer" ? "possible-writer" : cause.reason;
    const writer = cause.kind === "possible-writer" ? { pid: cause.pid, start: cause.start } : undefined;
    throw new Deferred("waitingForLegacyInstaller", since, since + PROVISION_STEPS.waitingForLegacyInstaller,
      `private-install-writer-live (${detail})`, undefined, undefined, writer);
  };
  const disk = () => {
    const lane = row!;
    return ports.worktreeDiskWait ? ports.worktreeDiskWait(lane.repoDir, lane.worktreeDir, lane.stages.some(stage => stage.effectiveRole.engine === "claude"))
      : worktreeDiskWait(lane.repoDir, lane.worktreeDir, undefined, undefined, undefined, lane.stages.some(stage => stage.effectiveRole.engine === "claude"));
  };
  let checkoutStripe = 0;
  const lock = (kind: "checkout" | "repo" | "add", stripe: number) => tryProvisioningLock(root, kind, stripe, git.native, signal, own);
  const deferAdd = (start: number) => new Deferred("waitingForCheckoutWriter", start, start + PROVISION_STEPS.waitingForCheckoutWriter, "checkout-writer-unverified");
  const dispatch = (name: string) => write(() => {}, { ...slot, effect: { name, sequence: (slot.effect?.sequence ?? 0) + 1 } });
  const checkAddExit = async () => {
    const admitted = slot.admittedAdd;
    if (!admitted) return;
    const proof = await lock("add", admitted.stripe);
    if (!proof) throw deferAdd(admitted.since);
    proof.close();
  };
  const exec: ProvisionExecPort = async (command, args, cwd, _signal, options) => {
    read();
    const add = command === "git" && args[0] === "worktree" && args[1] === "add";
    const fetch = command === "git" && args[0] === "fetch";
    const common = command === "git" && args.includes("--git-common-dir");
    const label = add ? "worktree-add" : fetch ? "fetch" : common ? "common-directory" : null;
    let fence: ProvisioningGrant | null = null;
    let launcher: ReturnType<typeof provisionToolchainEntry> | undefined;
    if (add) {
      const blocked = disk();
      if (blocked) throw new Error(blocked);
      if (git.native) {
        try { launcher = provisionToolchainEntry(); }
        catch {
          await step("startingToolchain");
          throw new ProvisionToolchainFailure("toolchain-start-failed");
        }
      }
      await step("creatingCheckout");
      if (slot.admittedAdd) await checkAddExit();
      fence = await lock("add", checkoutStripe);
      if (!fence) throw deferAdd(clock.wallMs());
      const since = clock.wallMs(), horizon = asDate(since + ADD_ROLLBACK_DEFERRAL_MS);
      const previousWait = slot.admittedAdd?.previousWait ?? row?.provisioningWait;
      const admittedAdd = { stripe: checkoutStripe, since, argsDigest: hash(args), sequence: (slot.admittedAdd?.sequence ?? 0) + 1,
        ...(previousWait ? { previousWait } : {}) };
      await write(current => {
        current.provisioningWait = { ...(previousWait ?? { startedAt: horizon, rounds: 0 }), retryAfter: horizon };
      }, { ...slot, admittedAdd });
    } else if (command === "git" && (["update-ref", "merge", "read-tree", "checkout-index"].includes(args[0] ?? "")
      || (args[0] === "worktree" && args[1] === "unlock"))) await dispatch("checkout-mutation");
    else if (command === "bun") await dispatch("install-private");
    if (label) reportProvisioningPhase(id, { phase: "git-started", step: label });
    let ok = false;
    try {
      read();
      const timeoutMs = Math.min(options?.timeoutMs ?? Infinity, Math.max(1, Math.floor(stopAt - clock.monotonicMs())));
      const result = launcher ? await git.exec(launcher.command,
        ["--no-env-file", launcher.entry, "add", String(Date.now() + timeoutMs), cwd, ...args],
        launcher.cwd, signal, { ...options, timeoutMs, inheritFd: fence!.fd })
        : await git.exec(command, args, cwd, signal, { ...options, timeoutMs });
      read();
      ok = result.code === 0;
      return result;
    } finally {
      fence?.close();
      if (label) reportProvisioningPhase(id, { phase: "git-finished", step: label, status: signal.aborted ? "cancelled" : ok ? "ok" : "failed" });
    }
  };
  try {
    await write(() => {}, slot, true);
    const execute = async () => {
      if (slot.worker) {
        if (!workerExited(slot.worker)) {
          const since = previous?.since ?? slot.since;
          throw new Deferred("preparingToolchain", since, since + 180_000, "toolchain-writer-unverified");
        }
        await write(() => {}, { ...slot, worker: undefined });
      }
      const waitingDisk = disk();
      if (waitingDisk) throw new Error(waitingDisk);
      const repoRead = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], row!.repoDir, signal);
      if (repoRead.code !== 0 || !repoRead.stdout.trim()) throw new Error("resolving the pipeline Git directory failed");
      const commonDir = git.native ? await fs.promises.realpath(path.resolve(row!.repoDir, repoRead.stdout.trim())) : path.resolve(row!.repoDir, repoRead.stdout.trim());
      const physicalCheckout = git.native ? await physicalProvisioningPath(row!.worktreeDir) : path.resolve(row!.worktreeDir);
      checkoutStripe = provisioningStripe(physicalCheckout);
      await checkAddExit();
      const checkout = await lock("checkout", checkoutStripe);
      checkoutGrant = checkout;
      const repoStripe = provisioningStripe(commonDir);
      const repository = checkout && await lock("repo", repoStripe);
      const checkoutResource = `checkout:${checkoutStripe}`, repoResource = `repo:${repoStripe}`;
      const waitTurn = (resource: string) => {
        const since = previous?.resource === resource ? previous.since : clock.wallMs();
        return new Deferred("waitingForTurn", since, clock.wallMs() + PROVISION_STEPS.waitingForTurn, "waiting-for-provisioning-turn", resource);
      };
      if (!repository) {
        throw waitTurn(checkout ? repoResource : checkoutResource);
      }
      const executionStart = clock.monotonicMs();
      executionStop = executionStart + EXECUTION_MS;
      await write((_current, tx) => {
        for (const resource of [checkoutResource, repoResource]) {
          const head = tx.provisioningWaitHead(resource);
          if (head && head !== id) throw waitTurn(resource);
        }
      }, { ...slot, executionDeadlineAt: clock.wallMs() + EXECUTION_MS, resource: undefined, waitReason: undefined });
      if (!slot.plan) {
        await step("resolvingBase");
        let { baseBranch, baseRef } = row!;
        const baseRefPinned = row!.baseRefPinned ?? false;
        if (!baseBranch || !baseRef || !row!.lastPassedCommit) {
          const resolved = await resolvePipelineBaseAsync(row!.repoDir, { baseBranch }, exec, signal);
          if (!resolved.ok) throw new Error(resolved.error);
          ({ baseBranch, baseRef } = resolved);
        }
        const result = await planPipelineCheckout({ ...row!, baseBranch, baseRef, baseRefPinned }, exec, signal);
        if (!result.ok) throw new Error(result.error);
        await write(current => {
          Object.assign(current, { baseBranch, baseRef, baseRefPinned, lastPassedCommit: baseRef });
        }, { ...slot, plan: result.plan });
      }
      await step("verifyingCheckout");
      let preserved: PreservedProvisionRef | undefined;
      const custody = git.native || fs.existsSync(row!.worktreeDir) ? {
        commonDir, addAdmitted: !!slot.admittedAdd,
        checkpointAlternative: (plan: NonNullable<ProvisioningRecord["plan"]>) => write(() => {}, { ...slot, plan }),
        verify: async () => {
          await step("verifyingCheckout");
          await checkAddExit();
          if (git.native && await physicalProvisioningPath(row!.worktreeDir) !== physicalCheckout) throw new Error("checkout identity changed during provisioning");
          await dispatch("record-provenance");
        },
      } : undefined;
      const result = await ensurePipelineCheckout(row!, slot.plan!, exec, signal, custody, value => { preserved = value; });
      if (!result.ok) throw new Error(result.error);
      await checkAddExit();
      await write(current => {
        if (slot.admittedAdd?.previousWait) current.provisioningWait = slot.admittedAdd.previousWait;
        else if (slot.admittedAdd) delete current.provisioningWait;
      }, { ...slot, admittedAdd: undefined });
      repository.close();
      await step("startingToolchain");
      if (git.native) await runProvisionToolchain({ root, token: slot.token, repository: row!.repoDir, checkout: row!.worktreeDir,
        signal, exec, budgetMs: Math.min(180_000, Math.floor(executionStop - clock.monotonicMs())),
        observeReply: ports.provisionToolchainReply ? (type, detail) => ports.provisionToolchainReply!(id, type, detail) : undefined,
        privateReceipt: slot.privateReceipt,
        privateIntent: slot.privateIntent,
        recordPrivateReceipt: receipt => write(() => {}, { ...slot, privateReceipt: receipt }),
        recordPrivateIntent: intent => write(() => {}, { ...slot, privateIntent: intent }),
        ready: async workerPid => {
          const worker = captureProcessIdentity(workerPid);
          if (!worker.startIdentity || !worker.bootEpoch) throw new Error("cannot verify the provisioning worker");
          await write(() => {}, { ...slot, worker });
          reportProvisioningPhase(id, { phase: "toolchain-ready" });
        }, step, dispatch,
        cacheAcquired: async fence => {
          const worker = slot.worker;
          const cacheOwner = worker && await provesProvisionCacheHolder(worker, fence, signal) ? fence : undefined;
          await write(() => {}, { ...slot, cacheWaitSince: undefined, cacheWaitIdentity: undefined, cacheOwner });
        },
        cacheBusy: async identity => {
          const now = clock.wallMs();
          const since = slot.cacheWaitIdentity === identity ? slot.cacheWaitSince ?? now : now;
          let holderDeadline: number | undefined;
          for (const ownerId of await provisioningCacheOwnerKeys(identity)) {
            const observed = (await findControllerPipeline(ownerId))?.provisioningJob;
            if (!validProvisioningRecord(observed) || observed.status !== "running"
              || observed.cacheOwner?.identity !== identity || !observed.worker
              || !await provesProvisionCacheHolder(observed.worker, observed.cacheOwner, signal)) continue;
            const fresh = (await findControllerPipeline(ownerId))?.provisioningJob;
            if (fresh?.token === observed.token && fresh.status === "running" && fresh.cacheOwner?.identity === identity
              && fresh.cacheOwner.fd === observed.cacheOwner.fd) {
              holderDeadline = fresh.deadlineAt;
              break;
            }
          }
          if (holderDeadline !== undefined && holderDeadline <= now) requestPipelineTick();
          const cutoff = since + PROVISION_STEPS.waitingForCache;
          const reason = holderDeadline === undefined ? "cache-holder-unclaimed"
            : now >= cutoff ? "cache-wait-expired" : "waiting-for-cache-holder";
          throw new Deferred("waitingForCache", since, cutoff, reason, undefined,
            { identity, holderDeadline: holderDeadline !== undefined && holderDeadline > now ? holderDeadline : undefined });
        },
        legacyWriter: deferLegacyWriter, track: child => { handle.child = child; },
      }); else {
        await step("checkingDependencies");
        const prepared = await prepareProvisionedPipeline(row!, result.sha, exec, signal);
        if (!prepared.ok) throw new Error(prepared.error);
      }
      await step("applyingCheckout");
      const verified = custody
        ? await verifyProvisioningCheckoutReceipt(row!, slot.plan!, commonDir, exec, signal)
        : (await exec("git", ["rev-parse", "HEAD"], row!.worktreeDir, signal)).stdout.trim() === result.sha;
      if (!verified || (git.native && await physicalProvisioningPath(row!.worktreeDir) !== physicalCheckout)) {
        throw new Error("checkout changed before its provisioning receipt could be consumed");
      }
      if (slot.privateReceipt) {
        const receipt = slot.privateReceipt;
        // Toolchain verification can precede apply by another state-admission
        // window. Qualify readiness with a fresh census at the consume boundary.
        const observation = await observeLegacyInstaller(row!.worktreeDir);
        read();
        if (observation.kind !== "clear") await deferLegacyWriter(observation);
        const modules = await fs.promises.lstat(path.join(row!.worktreeDir, "node_modules"), { bigint: true });
        if (!modules.isDirectory() || String(modules.dev) !== receipt.device || String(modules.ino) !== receipt.inode) {
          throw new ProvisionToolchainFailure("private-install-unverified");
        }
      }
      await write(current => {
        const journal = preserved ? `${preserved.unpublishedCommits} unpublished commit(s) preserved at ${preserved.ref}; checkout excludes this local tip` : null;
        if (journal && current.delivery && !current.delivery.journal.some(entry => entry.reason === journal)) deliveryJournal(current, "recovery", journal);
        delete current.provisioningWait;
        current.lastPassedCommit = result.sha;
        current.state = "running";
        current.stateDetail = journal;
        if (slot.interruption) current.lastProvisioningInterruption = slot.interruption;
      }, null);
      ports.scheduleTick?.(0);
    };
    let rejectRevoked!: () => void;
    const revoked = new Promise<never>((_, reject) => {
      rejectRevoked = () => reject(signal.reason);
      signal.addEventListener("abort", rejectRevoked, { once: true });
      if (signal.aborted) rejectRevoked();
    });
    try { await Promise.race([execute(), revoked]); }
    finally { signal.removeEventListener("abort", rejectRevoked); }
  } catch (error) {
    if (!changed || error instanceof JobRevoked) return changed;
    if (error instanceof StoreBusyBeforeAdmissionError) {
      schedule(pool, clock.wallMs() + 1_000, clock, ports);
      return changed;
    }
    if (error instanceof Deferred) {
      if (error.step !== "waitingForTurn" && clock.wallMs() >= error.deadline) {
        await write(() => {}, { ...slot, step: error.step, since: error.since, deadlineAt: error.deadline, waitReason: error.reason,
          ...(error.cache ? { cacheWaitSince: error.since, cacheWaitIdentity: error.cache.identity } : {}),
          ...(error.step === "waitingForLegacyInstaller" ? { legacyWaitSince: error.since, legacyWriter: error.legacyWriter } : {}),
        }, false, true);
        await park(error.reason);
      }
      else await wait(error);
      return true;
    }
    const message = error instanceof Error ? error.message : "provisioning operation refused";
    if (message.includes(DISK_SPACE_WAIT_PREFIX)) {
      const at = clock.wallMs() + DISK_SPACE_RETRY_MS;
      await write(current => { current.stateDetail = message.slice(message.indexOf(DISK_SPACE_WAIT_PREFIX)); },
        { ...slot, status: "waiting", retryAt: at }, false, true);
      schedule(pool, at, clock, ports);
      return true;
    }
    const gitReason = message.startsWith(WORKTREE_INITIALIZATION_HELD) ? "lock" : transientGitFailure(message);
    const timeout = error instanceof StepDeadline || signal.reason instanceof StepDeadline;
    const workerFailure = error instanceof ProvisionToolchainFailure && error.reason !== "private-install-unverified";
    if (!timeout && !workerFailure && !gitReason) {
      await park(error instanceof ProvisionToolchainFailure ? error.reason : message);
      return true;
    }
    const now = clock.wallMs();
    const reason = timeout ? (clock.monotonicMs() >= executionStop ? "provision-execution-budget-exhausted" : "provision-step-timeout")
      : workerFailure ? error.reason : describeTransientGitFailure(gitReason!, message).cause;
    const earlier = slot.admittedAdd ? slot.admittedAdd.previousWait : row!.provisioningWait;
    const budget = earlier?.budgetMs ?? RETRY_MS;
    const remaining = budget - Math.max(0, now - due(earlier?.startedAt ?? asDate(now)));
    if (remaining <= 0) {
      await park(`${reason}; inspect the last provisioning step and retry-stage`);
      return true;
    }
    const rounds = earlier?.rounds ?? 0, retryMaxMs = earlier?.retryMaxMs ?? 60_000;
    const retryAt = now + Math.min(5_000 * 2 ** rounds, retryMaxMs, remaining);
    const retry: PipelineBoundedWait = { startedAt: earlier?.startedAt ?? asDate(now), rounds: rounds + 1, retryAfter: asDate(retryAt), budgetMs: budget, retryMaxMs };
    await write(current => {
      if (!slot.admittedAdd) current.provisioningWait = retry;
      current.stateDetail = `provisioning deferred: ${reason}`;
    }, { ...slot, ...(slot.admittedAdd ? { admittedAdd: { ...slot.admittedAdd, previousWait: retry } } : {}), retryAt, status: "waiting",
      interruption: slot.interruption ?? { step: slot.step, since: slot.since, deadlineAt: slot.deadlineAt, observedAt: now, reason } }, false, true);
    schedule(pool, retryAt, clock, ports);
  } finally {
    cleanup();
    signal.removeEventListener("abort", cleanup);
  }
  return changed;
}
