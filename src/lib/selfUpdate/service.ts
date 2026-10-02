/* The self-update service (#2007): one per web process, behind the Update
   surface's routes. It holds the update check, and either the checkout
   install's step runner or the managed install's deployment record, and it
   answers one Snapshot for both modes.

   What survives the web process being replaced (which is what a restart or a
   deployment does to it) is on disk under `<state>/self-update/`: the check
   and the last checkout update in `state.json`, the deployment in
   `managed.json`, the automatic policy and managed request intent in
   `auto.json`, and the launcher's own record. A fresh process reads them
   back, so the surface carries on where the previous one stopped. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { cancelUntakenRequest, DIALOG_WRITER, readAuto, requestAutoRestart, restorePointer, writeAuto, pruneReleaseWorktrees, type AutoState, type AutoView, type AutoWriter } from "./auto";
import { DRAIN_NOTICE_MS, DRAIN_LEASE_MS, releaseDrain, writeDrain } from "./drain";
import { GreenReader, type GreenVerdict } from "./green";
import { appendHistory, findAutoSwitchRequest, readHistory, storeAutoSwitchResponse } from "./history";
import { probeQuiet, type QuietBlockers, type QuietPorts } from "./quiet";
import { activeRestartGate, beginRestartGate, endRestartGate, restartGateFile } from "./restartGate";
import { headOf, releaseDirFor } from "./release";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { memAvailableMb } from "./steps";
import { isRuntimeHostTransportFailure } from "@/lib/runtime/client";

import type { RuntimeHostHealth } from "@/lib/runtime/client";
import type { ViewerDeploymentReceipt, ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import { applyCheck, initialCheck, type CheckSlice } from "./checkState";
import { CheckError, type CheckInput, type CheckOutcome } from "./git";
import { readLauncherRecord, type LauncherProcess, type LauncherRecord, type LauncherRole } from "./launcher";
import {
  DeploymentBusyError,
  managedActive,
  managedUpdateState,
  observeDeployment,
  observeMissing,
  managedIdempotencyKey,
  readManagedRecord,
  requestManagedUpdate,
  writeManagedRecord,
  type ManagedRecord,
} from "./managed";
import { LAUNCHER_RECORD_ENV, type ModeDecision } from "./mode";
import { ReleasePointer, type Release } from "./release";
import type { RunnerConfig } from "./steps";
import {
  CHECKOUT_STEPS,
  idleUpdate,
  MANAGED_STEPS,
  shortSha,
  stoppedProcess,
  UNKNOWN_REVISION,
  type Busy,
  type CheckoutStepName,
  type ProcessStatus,
  type ProcessView,
  type RefusalCode,
  type Revision,
  type Snapshot,
  type UpdateState,
} from "./types";

export interface RunnerPort {
  state: UpdateState;
  start(target: string, meta?: { short?: string; version?: string; trigger?: "operator" | "auto" }): Promise<void>;
  retry(): Promise<void>;
  restore(saved: UpdateState): void;
  logPath(step: CheckoutStepName): string;
}

export interface ServiceDeps {
  now(): number;
  env: Readonly<Record<string, string | undefined>>;
  /** `<state>/self-update`. */
  dir: string;
  remote: string;
  branch: string;
  pollMinutes: number;
  bun: string;
  mode(): Promise<ModeDecision>;
  check(input: CheckInput): Promise<CheckOutcome>;
  describe(repo: string, revision: string): Promise<Revision>;
  createRunner(config: RunnerConfig, publish: (release: Release) => void, onChange: () => void): RunnerPort;
  requestRestart(record: LauncherRecord, role: LauncherRole): string;
  processAlive(pid: number, startIdentity: string): boolean;
  hostHealth(): Promise<RuntimeHostHealth | null>;
  requestDeployment(body: ViewerDeploymentRequest): Promise<ViewerDeploymentReceipt>;
  readDeployment(deploymentId: string): Promise<ViewerDeploymentStatus | null>;
  /** Read-only idempotency lookup. Unlike replaying a request, this never
      admits a deployment when the key is absent. */
  findDeploymentByIdempotencyKey(idempotencyKey: string): Promise<ViewerDeploymentStatus | null>;
  releaseTarget(): { revision: string } | null;
  prepareCheckRepo(): Promise<string>;
  buildEnv(scratchRoot: string): Record<string, string>;
  web: { pid: number; port: number | null; startedAt: string };
  green?: GreenReader;
  quiet?: QuietPorts;
  requestPipelineTick?(): void;
  updateProject?(): string;
  prune?(record: LauncherRecord, rollbackPointer: string | null): Promise<void>;
}

/** A refusal carries a code the client words; `error` is the same in
    English for API readers and logs, and `detail` is machine output (the
    runtime host's own refusal). */
export type ActionResult = { ok: true; replaySnapshot?: Snapshot } | { ok: false; status: number; code: RefusalCode | "auto-persistence-failed" | "auto-switch-superseded"; error: string; detail?: string };
type DeploymentResult = ActionResult & { deliveryUncertain?: boolean };

export function refuse(status: number, code: RefusalCode | "auto-persistence-failed" | "auto-switch-superseded", error: string, detail?: string): ActionResult {
  return { ok: false, status, code, error, ...(detail ? { detail } : {}) };
}

function busy(state: Exclude<Busy, null>): ActionResult {
  return refuse(409, `busy-${state}`, `Busy: ${state}`);
}

function restoreFile(file: string, bytes: Buffer | null): void {
  if (bytes === null) {
    rmSync(file, { force: true });
    return;
  }
  const temporary = `${file}.${process.pid}.rollback`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, file);
}

const MODE_TTL_MS = 30_000;
const PENDING_RESTART_MS = 60_000;
const SAVE_DELAY_MS = 1_000;
const DEPLOYMENT_WATCH_MS = 1_000;
const UNDESCRIBABLE_HOLD_MS = 30_000;

interface PendingManualRestart { role: LauncherRole; requestId: string; at: number; from: string | null; target: string }
interface Persisted { slice: CheckSlice; update: UpdateState | null; pendingRestart?: PendingManualRestart | null; autoPending?: AutoState["pending"]; autoRollbackPointer?: string | null; autoRollbackCaptured?: boolean }

class Changes {
  private readonly listeners = new Set<() => void>();
  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export class SelfUpdateService {
  readonly changes = new Changes();
  private slice: CheckSlice = initialCheck();
  private savedUpdate: UpdateState | null = null;
  private checking: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private runner: RunnerPort | null = null;
  private runnerRecord: string | null = null;
  private managed: ManagedRecord | null;
  private managedNeedsSave = false;
  private decision: { value: ModeDecision; at: number } | null = null;
  private pendingRestart: PendingManualRestart | null = null;
  private readonly described = new Map<string, Revision>();
  private readonly undescribable = new Map<string, number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private deploymentWatch: ReturnType<typeof setInterval> | null = null;
  private auto: AutoState;
  private autoSwitchSequence = 0;
  private committedAutoSwitchSequence = 0;
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private autoRunning = false;
  private autoBlockers: QuietBlockers | null = null;
  private readonly greenReader: GreenReader;

  constructor(private readonly deps: ServiceDeps) {
    this.auto = readAuto(join(deps.dir, "auto.json"));
    this.greenReader = deps.green ?? new GreenReader();
    const persisted = this.readPersisted();
    if (persisted) {
      this.slice = persisted.slice;
      this.savedUpdate = persisted.update;
      this.pendingRestart = persisted.pendingRestart ?? null;
      this.auto = { ...this.auto, pending: persisted.autoPending ?? null, rollbackPointer: persisted.autoRollbackPointer ?? null, rollbackCaptured: persisted.autoRollbackCaptured === true };
      /* A check the previous process was running when it went away. */
      if (this.slice.check.state === "checking") this.slice = { ...this.slice, check: { ...this.slice.check, state: "idle" } };
    }
    this.managed = readManagedRecord(this.managedFile);
    if (managedActive(this.managed)) this.watchDeployment();
  }

  /* A deployment is followed whether or not anyone has the surface open, so
     a failure is placed at the step that was running when it happened. */
  private watchDeployment(): void {
    if (this.deploymentWatch) return;
    this.deploymentWatch = setInterval(() => {
      if (!managedActive(this.managed)) {
        if (this.deploymentWatch) clearInterval(this.deploymentWatch);
        this.deploymentWatch = null;
        return;
      }
      void this.refreshManaged();
    }, DEPLOYMENT_WATCH_MS);
    this.deploymentWatch.unref?.();
  }

  private get stateFile(): string { return join(this.deps.dir, "state.json"); }
  private get managedFile(): string { return join(this.deps.dir, "managed.json"); }
  private get autoFile(): string { return join(this.deps.dir, "auto.json"); }
  private get historyFile(): string { return join(this.deps.dir, "history.jsonl"); }

  /** Host acceptance remains authoritative when the local receipt cannot be
      written. The durable automatic intent keeps its key for cold lookup. */
  private saveManaged(): void {
    if (!this.managed) return;
    this.managedNeedsSave = true;
    try {
      writeManagedRecord(this.managedFile, this.managed);
      this.managedNeedsSave = false;
    } catch (error) {
      console.error("[self-update] deployment receipt persistence failed", error instanceof Error ? error.name : "unknown");
    }
    const pending = this.auto.managedPending;
    if (this.managed.trigger === "auto" && pending
      && this.managed.idempotencyKey === managedIdempotencyKey(pending.target.sha, pending.clientKey)
      && pending.deploymentId !== this.managed.deploymentId) {
      this.auto = { ...this.auto, managedPending: { ...pending, deploymentId: this.managed.deploymentId } };
      this.saveAuto();
    }
  }

  private saveAuto(): void { writeAuto(this.autoFile, this.auto); this.persistNow(); this.changes.emit(); }

  /** Called only by the release-owning web process after its fence is active. */
  startAuto(): void {
    if (this.autoTimer) return;
    // Restore durable custody before startup hands pending stages or seats to
    // their controllers, even when future automatic updates are switched off.
    this.refreshDrain();
    if (this.auto.enabled) this.ensureChecked();
    this.autoTimer = setInterval(() => { void this.autoTick(); }, 60_000);
    this.autoTimer.unref?.();
    void this.autoTick();
  }

  /** The one switch of automatic updates: the Update dialog and the
      `auto_updates` MCP tool both reach it through `POST /api/self-update/auto`.
      Each write is recorded with its writer, on the setting and in the
      history the dialog shows. */
  async setAuto(enabled: boolean, writer: AutoWriter = DIALOG_WRITER, requestId?: string): Promise<ActionResult> {
    const sequence = ++this.autoSwitchSequence;
    const receiptId = requestId ? createHash("sha256").update(requestId).digest("hex") : undefined;
    if (receiptId) {
      const previous = findAutoSwitchRequest(this.historyFile, receiptId);
      if (previous) {
        const replaySnapshot = previous.response && typeof previous.response === "object" ? previous.response as Snapshot : undefined;
        return { ok: true, ...(replaySnapshot ? { replaySnapshot } : {}) };
      }
    }
    // A prior snapshot may have cached a different launcher generation.
    if (enabled) this.decision = null;
    const decision = await this.decide();
    const availability = this.autoAvailability(decision);
    if (enabled && availability !== "available") return refuse(409, "auto-unavailable", `Automatic updates unavailable: ${availability}`);
    const at = new Date(this.deps.now()).toISOString();
    const previousAuto = this.auto;
    const requestedAuto = { ...previousAuto, enabled, changedAt: at, changedBy: writer, off: enabled ? null : previousAuto.off, quietSince: null };
    let replaySnapshot: Snapshot;
    try {
      // Snapshot construction can refresh deployment state and settle an
      // automatic rollback. Prepare first; the commit below overlays this
      // request on whatever controller state that work left current.
      replaySnapshot = await this.buildSnapshot(requestedAuto);
    } catch (error) {
      return refuse(500, "auto-persistence-failed", "Automatic update setting could not be recorded", error instanceof Error ? error.message : undefined);
    }
    if (this.committedAutoSwitchSequence > sequence) {
      return refuse(409, "auto-switch-superseded", "A newer automatic update switch has already been applied");
    }
    const currentAuto = this.auto;
    const autoBeforeCommit = currentAuto;
    const nextAuto = { ...currentAuto, enabled, changedAt: at, changedBy: writer, off: enabled ? null : currentAuto.off, quietSince: null };
    replaySnapshot.auto = this.autoView(decision, replaySnapshot, nextAuto);
    replaySnapshot.meta.pollMinutes = nextAuto.enabled ? 15 : this.deps.pollMinutes;
    let previousAutoFile: Buffer | null;
    let previousHistoryFile: Buffer | null;
    try {
      previousAutoFile = existsSync(this.autoFile) ? readFileSync(this.autoFile) : null;
      previousHistoryFile = existsSync(this.historyFile) ? readFileSync(this.historyFile) : null;
    } catch (error) {
      return refuse(500, "auto-persistence-failed", "Automatic update setting could not be recorded", error instanceof Error ? error.message : undefined);
    }
    try {
      writeAuto(this.autoFile, nextAuto);
      appendHistory(this.historyFile, { at, by: writer.kind === "seat" ? "seat" : "operator", kind: enabled ? "auto-on" : "auto-off",
        target: this.slice.available?.sha ?? "", from: null, outcome: "done", writer, ...(receiptId ? { requestId: receiptId } : {}) });
      if (receiptId) storeAutoSwitchResponse(this.historyFile, receiptId, replaySnapshot);
      this.auto = nextAuto;
      this.committedAutoSwitchSequence = sequence;
    } catch (error) {
      this.auto = autoBeforeCommit;
      try { restoreFile(this.autoFile, previousAutoFile); } catch { /* keep the original write failure */ }
      try { restoreFile(this.historyFile, previousHistoryFile); } catch { /* keep the original write failure */ }
      return refuse(500, "auto-persistence-failed", "Automatic update setting could not be recorded", error instanceof Error ? error.message : undefined);
    }
    if (!enabled && !this.hasAutoCustody()) this.endDrain();
    this.changes.emit();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (enabled) { this.ensureChecked(); void this.autoTick(); }
    else this.schedulePoll();
    return { ok: true, ...(receiptId ? { replaySnapshot } : {}) };
  }

  private autoAvailability(decision: ModeDecision): AutoView["availability"] {
    if (decision.mode === "managed") {
      try { if (!this.deps.releaseTarget()?.revision) return "no-release-target"; }
      catch { return "no-release-target"; }
    } else {
      if (decision.mode !== "checkout" || !decision.record?.checkout) return "packaged";
      if (decision.record.launcher.autoAdmission !== 1) return "launcher-upgrade";
      try {
        const raw = JSON.parse(readFileSync(decision.record.releasePointer, "utf8")) as { checkoutHead?: string };
        if (!raw.checkoutHead || raw.checkoutHead !== headOf(decision.record.checkout)) return "hand-managed";
      } catch { if (existsSync(decision.record.releasePointer)) return "hand-managed"; }
    }
    if (!githubRepositoryOfRemote(this.deps.remote)) return "not-github";
    if (["ahead", "diverged"].includes(this.slice.check.relation ?? "")) return "diverged";
    return "available";
  }

  private autoView(decision: ModeDecision, snapshot: Snapshot, auto: AutoState = this.auto): AutoView {
    const built = snapshot.installed.sha;
    const target = auto.off ? (this.described.get(auto.off.target) ?? { ...UNKNOWN_REVISION, sha: auto.off.target, short: shortSha(auto.off.target) })
      : auto.drain ? auto.drain.target : auto.managedPending?.target ?? this.slice.available ?? (built && (snapshot.serving.web?.sha !== built || snapshot.serving.runtimeHost?.sha !== built) ? snapshot.installed : null);
    const sha = target?.sha ?? null;
    const pending = auto.pending;
    const managedPending = auto.managedPending;
    const phase: AutoView["phase"] = !auto.enabled && !pending && !managedPending ? "idle"
      : pending ? pending.role === "web" ? "restarting-web" : "restarting-host"
      : managedPending || decision.mode === "managed" && snapshot.update.state === "running" && snapshot.update.trigger === "auto" ? "deploying"
      : snapshot.update.state === "running" && snapshot.update.trigger === "auto" ? "building"
      : sha && auto.green[sha] && auto.green[sha].state !== "green" ? "not-green"
      : auto.waitingSince ? "waiting"
      : sha && !auto.green[sha] ? "checks" : "idle";
    return { availability: this.autoAvailability(decision), enabled: auto.enabled, off: auto.off, phase, target, green: sha ? auto.green[sha] ?? null : null,
      blockers: phase === "waiting" ? this.autoBlockers ?? auto.lastBlockers : null,
      waitingSince: auto.waitingSince, longWait: phase === "waiting" && !!auto.waitingSince && this.deps.now() - Date.parse(auto.waitingSince) >= DRAIN_NOTICE_MS,
      decision: auto.enabled && (phase === "waiting" || phase === "building") && !auto.drain?.admitted && auto.drain?.overranAt && !auto.drain.acknowledgedAt ? { id: auto.drain.id, at: auto.drain.overranAt, project: this.deps.updateProject?.() ?? "Delegatus", blockers: auto.lastBlockers ?? auto.drain.blockers } : null,
      drain: auto.enabled && auto.waitingSince ? auto.drain
        ? auto.drain.overranAt ? { state: "overran", at: auto.drain.overranAt }
          : { state: "draining", at: auto.drain.since }
        : null : null,
      changedAt: auto.changedAt, changedBy: auto.changedBy };
  }

  /** Re-read durable facts on every pass. A web restart replaces this object
      between the two restart requests, so no in-memory phase is authoritative. */
  async autoTick(): Promise<void> {
    // Timer ticks keep admission held even while an earlier GitHub or host
    // observation waits. Its asynchronous work must not consume the lease.
    try { this.refreshDrain(); }
    catch (error) {
      console.error("[self-update] drain renewal failed", error instanceof Error ? error.name : "unknown");
      return;
    }
    if (this.autoRunning) return;
    this.autoRunning = true;
    try { await this.runAutoTick(); }
    catch (error) { console.error("[self-update] automatic tick failed", error instanceof Error ? error.name : "unknown"); }
    finally { this.autoRunning = false; }
  }

  private async runAutoTick(): Promise<void> {
    // Recover a switch-off persisted before its lease cleanup during a crash.
    if (!this.auto.enabled && !this.hasAutoCustody()) this.endDrain();
    if (!this.auto.enabled && !this.hasAutoCustody()) return;
    // The previous web process may have saved the terminal host status just
    // before it exited. Settle that durable result even if the host is away.
    if (this.auto.managedPending && this.managed && !managedActive(this.managed)) this.finishManagedAuto();
    if (!this.auto.enabled && !this.hasAutoCustody()) return;
    const decision = await this.decide();
    if ((!this.auto.enabled || this.autoAvailability(decision) !== "available") && !this.hasAutoCustody()) this.endDrain();
    else if (this.auto.drain) this.refreshDrain();
    if (decision.mode === "managed") { await this.runManagedAutoTick(decision); return; }
    if (decision.mode !== "checkout" || !decision.record) return;
    const record = decision.record;
    const snapshot = await this.snapshot();
    const observedHealthy = [snapshot.processes.web, snapshot.processes.runtimeHost]
      .every((process) => process.state === "healthy" && process.lastHealthOk === true);
    const now = this.deps.now();
    const pending = this.auto.pending;
    if (this.auto.rollback) {
      const rollback = this.auto.rollback.target;
      const serves = (revision: Revision | null, target: string | null | undefined) => !!target && (revision?.sha === target || revision?.short === shortSha(target));
      const consistent = [rollback, this.auto.drain?.target.sha].some((target) => serves(snapshot.serving.web, target) && serves(snapshot.serving.runtimeHost, target));
      if (observedHealthy && consistent) {
        this.auto = { ...this.auto, rollback: null, waitingSince: null, waitingTarget: null, lastBlockers: null };
        this.endDrain();
      }
      return;
    }
    if (record.launcher.autoAdmission !== 1) {
      const entry = pending?.role === "web" ? record.web : record.runtimeHost;
      if (pending && entry.requestId !== pending.requestId) {
        cancelUntakenRequest(record, pending.requestId);
        this.auto = { ...this.auto, pending: null, quietSince: null };
        this.saveAuto();
      }
      // A request taken by a previous release still needs outcome and rollback
      // tracking; no new request may be filed under this launcher.
      if (!pending || entry.requestId !== pending.requestId) return;
    }
    if (pending) {
      const entry = pending.role === "web" ? record.web : record.runtimeHost;
      if (pending.launcherPid !== record.launcher.pid) {
        cancelUntakenRequest(record, pending.requestId);
        this.auto = { ...this.auto, pending: null, quietSince: null };
        this.saveAuto();
        return;
      }
      if (entry.requestId === pending.requestId && (entry.error?.kind === "fell-back" || entry.state === "failed")) {
        this.finishAutoRestart(pending, "fell-back", entry.error?.kind === "fell-back" ? entry.error.detail : "restart failed", record);
        return;
      }
      if (entry.requestId === pending.requestId && entry.state === "healthy" && entry.error === null
        && entry.revision === shortSha(pending.target)) {
        this.finishAutoRestart(pending, "done", undefined, record);
        return;
      }
      if (entry.requestId !== pending.requestId && !existsSync(record.requestFile) && now - Date.parse(pending.at) > 2_000) {
        this.auto = { ...this.auto, pending: null, quietSince: null };
        this.saveAuto();
        return;
      }
      const deadline = pending.role === "web" ? 5 * 60_000 : 3 * 60_000;
      if (now - Date.parse(pending.at) >= deadline) {
        this.finishAutoRestart(pending, "failed", "the launcher did not take the restart request", record);
      }
      return;
    }
    if ((!this.auto.enabled && !this.hasAutoCustody()) || this.autoAvailability(decision) !== "available") return;
    const staleBuilt = snapshot.installed.sha && (snapshot.serving.web?.short !== snapshot.installed.short || snapshot.serving.runtimeHost?.short !== snapshot.installed.short);
    const target = this.auto.drain ? this.auto.drain.target : this.slice.available ?? ((staleBuilt || this.auto.waitingSince) ? snapshot.installed : null);
    if (!target?.sha) return;
    let green = await this.autoGreen(target.sha, record.checkout!, now);
    if (green.state !== "green") return;
    if (snapshot.installed.sha !== target.sha) {
      // Pending updates fence new work before building too: otherwise busy
      // agents can keep consuming the resources the candidate build needs.
      await this.waitForAutoQuiet(snapshot, target.sha, now);
      if (!this.auto.enabled && !this.hasAutoCustody()) return;
      if (snapshot.busy || this.checking || snapshot.check.state === "checking" || memAvailableMb() < 4_096) return;
      green = await this.refreshGreen(target.sha, record.checkout!, green);
      if (green.state !== "green") return;
      const runner = this.runnerFor(record);
      if (!this.auto.rollbackCaptured) {
        this.auto = { ...this.auto, rollbackPointer: existsSync(record.releasePointer) ? readFileSync(record.releasePointer, "utf8") : null, rollbackCaptured: true };
        this.saveAuto();
      }
      void runner.start(target.sha, { short: target.short, version: target.version, trigger: "auto" })
        .catch((error) => console.error("[self-update] automatic build failed", error instanceof Error ? error.name : "unknown"))
        .finally(() => this.afterUpdate());
      return;
    }
    const serves = (revision: Revision | null) => revision?.sha === target.sha || revision?.short === target.short;
    if (observedHealthy && serves(snapshot.serving.web) && serves(snapshot.serving.runtimeHost)) {
      if (this.auto.waitingSince) {
        this.endDrain();
        const rollback = this.auto.rollbackPointer;
        this.auto = { ...this.auto, waitingSince: null, waitingTarget: null, lastBlockers: null, quietSince: null, noticeAt: null, rollbackPointer: null, rollbackCaptured: false };
        this.saveAuto();
        try { await (this.deps.prune ?? pruneReleaseWorktrees)(record, rollback); }
        catch (error) { console.error("[self-update] release cleanup failed", error instanceof Error ? error.name : "unknown"); }
      }
      return;
    }
    const quiet = this.deps.quiet;
    if (!quiet || !await this.waitForAutoQuiet(existsSync(record.requestFile) ? { ...snapshot, busy: "restart-web" } : snapshot, target.sha, now)) return;
    const gateFile = restartGateFile(record.requestFile);
    const gateId = beginRestartGate(gateFile);
    if (!gateId) return;
    let requested = false;
    try {
      green = await this.refreshGreen(target.sha, record.checkout!, green);
      if (green.state !== "green") {
        this.auto = { ...this.auto, quietSince: null };
        this.saveAuto();
        return;
      }
      const finalSnapshot = await this.snapshot();
      const finalProbe = await probeQuiet(finalSnapshot, quiet, this.deps.now(), this.draining());
      this.autoBlockers = finalProbe.blockers;
      if (!this.quietAdmits(finalProbe) || finalSnapshot.installed.sha !== target.sha || existsSync(record.requestFile)) {
        this.auto = { ...this.auto, quietSince: null, lastBlockers: finalProbe.blockers };
        this.saveAuto();
        return;
      }
      const role: LauncherRole = serves(finalSnapshot.serving.web) ? "runtime-host" : "web";
      const rollbackPointer = this.auto.rollbackCaptured ? this.auto.rollbackPointer : this.pointerForServing(record, finalSnapshot);
      if (rollbackPointer === undefined) {
        this.autoBlockers = { ...finalProbe.blockers, unreadable: "the release now served by web cannot be identified" };
        this.changes.emit();
        return;
      }
      // The launcher may have been replaced while GitHub and activity were read.
      // Re-read the record before filing anything an older watcher would take.
      this.decision = null;
      const current = await this.decide();
      if (current.mode !== "checkout" || current.record?.launcher.autoAdmission !== 1
        || current.record.launcher.pid !== record.launcher.pid
        || current.record.launcher.startIdentity !== record.launcher.startIdentity
        || (!this.auto.enabled && !this.hasAutoCustody())) return;
      this.beginAutoCustody(target);
      this.auto = { ...this.auto, rollbackPointer, rollbackCaptured: true, quietSince: null };
      requestAutoRestart(record, role, target.sha, rollbackPointer, now, gateId, (request) => {
        this.auto = { ...this.auto, pending: request };
        this.persistNow();
      });
      requested = true;
      this.changes.emit();
    } finally {
      if (!requested) endRestartGate(gateFile, gateId);
    }
  }

  private async autoGreen(target: string, repo: string, now: number): Promise<GreenVerdict> {
    let green = this.auto.green[target] ?? null;
    if (!green || (["pending", "unknown", "red"].includes(green.state) && (!green.nextAt || Date.parse(green.nextAt) <= now))) {
      green = await this.greenReader.read(this.deps.remote, this.deps.branch, target, repo, green?.firstReadAt, green?.state === "red");
      if (["pending", "unknown", "red"].includes(green.state)) green = { ...green, nextAt: green.nextAt ?? new Date(now + 15 * 60_000).toISOString() };
      this.auto = { ...this.auto, green: Object.fromEntries(Object.entries({ ...this.auto.green, [target]: green }).slice(-8)) };
      this.saveAuto();
    }
    return green;
  }

  private async waitForAutoQuiet(snapshot: Snapshot, target: string, now: number): Promise<boolean> {
    if (!this.auto.enabled && !this.hasAutoCustody()) return false;
    const at = new Date(now).toISOString();
    if (!this.auto.waitingSince) {
      this.auto = { ...this.auto, waitingSince: at, waitingTarget: target };
      this.saveAuto();
    } else if (this.auto.waitingTarget && this.auto.waitingTarget !== target) {
      this.auto = { ...this.auto, waitingTarget: target, quietSince: null };
      this.saveAuto();
    } else if (!this.auto.waitingTarget) {
      this.auto = { ...this.auto, waitingTarget: target };
      this.saveAuto();
    }
    if (!this.draining()) {
      const revision = snapshot.mode === "checkout" && snapshot.installed.sha === target ? snapshot.installed : snapshot.available;
      if (revision?.sha === target) {
        const drain = { id: randomUUID(), target: revision, since: at, overranAt: null, blockers: null };
        // Publish the hold before the next asynchronous observation can launch work.
        writeDrain(this.drainFile, { id: drain.id, target, since: at, until: now + DRAIN_LEASE_MS, persistent: true });
        this.auto = { ...this.auto, drain, quietSince: null };
        this.saveAuto();
      }
    }
    if (!this.deps.quiet) return false;
    const probe = await probeQuiet(snapshot, this.deps.quiet, now, this.draining());
    this.autoBlockers = probe.blockers;
    if (JSON.stringify(this.auto.lastBlockers) !== JSON.stringify(probe.blockers)) {
      this.auto = { ...this.auto, lastBlockers: probe.blockers };
      this.saveAuto();
    }
    const drain = this.auto.drain;
    if (drain && !drain.overranAt && !probe.quiet && now - Date.parse(drain.since) >= DRAIN_NOTICE_MS) {
      this.auto = { ...this.auto, drain: { ...drain, overranAt: at, blockers: probe.blockers } };
      this.saveAuto();
    }
    this.changes.emit();
    if (this.auto.drain?.force && this.quietAdmits(probe)) return true;
    if (!probe.quiet) {
      if (this.auto.quietSince) { this.auto = { ...this.auto, quietSince: null }; this.saveAuto(); }
      return false;
    }
    if (!this.auto.quietSince) {
      this.auto = { ...this.auto, quietSince: at };
      this.saveAuto();
      return false;
    }
    return now - Date.parse(this.auto.quietSince) >= 60_000;
  }

  private finishManagedAuto(snapshot?: Snapshot): void {
    const pending = this.auto.managedPending;
    const record = this.managed;
    if (!pending || !record || managedActive(record)
      || record.idempotencyKey !== managedIdempotencyKey(pending.target.sha, pending.clientKey)) return;
    const failed = record.phase !== "succeeded";
    if (failed) {
      // A terminal failure can follow web promotion or a failed rollback.
      // Disable future updates immediately, but keep the accepted transaction
      // and its custody until a fresh observation establishes safe succession.
      if (this.auto.enabled || !this.auto.off) {
        this.auto = { ...this.auto, enabled: false, off: { at: new Date(this.deps.now()).toISOString(), target: record.target,
          stage: "deploy", reason: record.error || (record.lost ? "deployment record was lost" : "deployment failed") } };
        this.saveAuto();
      }
    }
    const serves = (revision: Revision | null, target: string | null | undefined) => !!target && (revision?.sha === target || revision?.short === shortSha(target));
    const healthy = snapshot && [snapshot.processes.web, snapshot.processes.runtimeHost]
      .every((process) => process.state === "healthy" && process.lastHealthOk === true);
    const settledTargets = failed ? [pending.from ?? this.slice.installed?.sha, pending.target.sha] : [pending.target.sha];
    const consistent = snapshot && settledTargets
      .some((target) => serves(snapshot.serving.web, target) && serves(snapshot.serving.runtimeHost, target));
    if (!healthy || !consistent) return;
    this.endDrain();
    this.auto = {
      ...this.auto, managedPending: null, waitingSince: null, waitingTarget: null,
      lastBlockers: null, quietSince: null, noticeAt: null,
    };
    this.saveAuto();
  }

  private finishManagedAutoRefusal(target: Revision, reason: string): void {
    this.endDrain();
    this.auto = {
      ...this.auto, enabled: false, managedPending: null, waitingSince: null, waitingTarget: null,
      quietSince: null, lastBlockers: null,
      off: { at: new Date(this.deps.now()).toISOString(), target: target.sha, stage: "deploy", reason },
    };
    this.saveAuto();
  }

  private async runManagedAutoTick(decision: ModeDecision): Promise<void> {
    const snapshot = await this.snapshot();
    let pending = this.auto.managedPending;
    if (pending) {
      const idempotencyKey = managedIdempotencyKey(pending.target.sha, pending.clientKey);
      if (this.managed?.idempotencyKey === idempotencyKey) return;
      // A saved intent can outlive a lost reply and an unrelated prior
      // managed.json record. Query the host without submitting a request:
      // request replay itself creates a deployment for an unknown key.
      let accepted: ViewerDeploymentStatus | null;
      try { accepted = await this.deps.findDeploymentByIdempotencyKey(idempotencyKey); }
      catch { return; }
      if (accepted || pending.deploymentId) {
        const record: ManagedRecord = {
          deploymentId: accepted?.deploymentId ?? pending.deploymentId!, idempotencyKey, trigger: "auto",
          target: accepted?.revision ?? pending.target.sha, targetShort: shortSha(accepted?.revision ?? pending.target.sha), targetVersion: pending.target.version || null,
          requestedAt: accepted?.createdAt ?? pending.at, observed: {}, lastStep: null, finishedAt: null,
          phase: null, error: null, servingProgress: null,
        };
        this.managed = observeDeployment(record, accepted);
        this.saveManaged();
        if (managedActive(this.managed)) this.watchDeployment();
        this.finishManagedAuto();
        if (!managedActive(this.managed) && this.auto.managedPending) await this.snapshot();
        this.changes.emit();
        return;
      }
      // If the switch is off, retain the uncertain identity for observation
      // and do not admit a request. Re-enabling will re-check current policy.
      if (!this.auto.enabled) return;
      if ((this.slice.check.state === "update-available" || this.slice.check.state === "up-to-date")
        && this.slice.available?.sha !== pending.target.sha) {
        // The host does not know this key and a successful check moved past
        // its target. No accepted transaction remains to own launch custody.
        // Recheck admission without resetting the cumulative wait.
        this.endDrain();
        this.auto = { ...this.auto, managedPending: null, waitingTarget: null,
          quietSince: null, lastBlockers: null };
        this.saveAuto();
        pending = null;
      }
    }
    if (!this.auto.enabled || this.autoAvailability(decision) !== "available" || managedActive(this.managed)
      || this.checking || snapshot.check.state === "checking") return;
    const target = this.draining() ? this.auto.drain!.target : pending?.target ?? this.slice.available;
    if (this.slice.check.state !== "update-available" || !target?.sha || (!this.draining() && this.slice.available?.sha !== target.sha)
      || snapshot.installed.sha === target.sha
      || this.managed?.phase === "succeeded" && this.managed.target === target.sha) return;
    const now = this.deps.now();
    const repo = await this.deps.prepareCheckRepo();
    let green = await this.autoGreen(target.sha, repo, now);
    if (green.state !== "green") return;
    if (!await this.waitForAutoQuiet(snapshot, target.sha, now)) return;
    green = await this.refreshGreen(target.sha, repo, green);
    if (green.state !== "green") { this.auto = { ...this.auto, quietSince: null }; this.saveAuto(); return; }
    const finalSnapshot = await this.snapshot();
    const finalProbe = this.deps.quiet ? await probeQuiet(finalSnapshot, this.deps.quiet, this.deps.now(), this.draining()) : null;
    this.autoBlockers = finalProbe?.blockers ?? null;
    if (!this.quietAdmits(finalProbe) || (!this.draining() && finalSnapshot.available?.sha !== target.sha) || finalSnapshot.installed.sha === target.sha
      || this.checking || finalSnapshot.check.state === "checking" || !this.auto.enabled) {
      this.auto = { ...this.auto, quietSince: null, lastBlockers: finalProbe?.blockers ?? this.auto.lastBlockers };
      this.saveAuto();
      return;
    }
    const gateFile = restartGateFile(join(this.deps.dir, "managed-deploy.intent"));
    const gateId = beginRestartGate(gateFile, this.deps.now());
    if (!gateId) return;
    try {
      // Mode resolution can be asynchronous. Recheck it before admission, then
      // read blockers again so work that starts during that read can veto it.
      this.decision = null;
      const current = await this.decide();
      if (current.mode !== "managed" || this.autoAvailability(current) !== "available" || !this.auto.enabled
        || managedActive(this.managed) || this.checking || this.slice.check.state !== "update-available"
        || (!this.draining() && this.slice.available?.sha !== target.sha)) return;
      green = await this.refreshGreen(target.sha, repo, green);
      const admissionSnapshot = await this.snapshot();
      const admissionProbe = this.deps.quiet ? await probeQuiet(admissionSnapshot, this.deps.quiet, this.deps.now(), this.draining()) : null;
      this.autoBlockers = admissionProbe?.blockers ?? null;
      if (activeRestartGate(gateFile, this.deps.now()) !== gateId || green.state !== "green" || !this.quietAdmits(admissionProbe) || !this.auto.enabled || this.checking
        || admissionSnapshot.check.state === "checking" || admissionSnapshot.installed.sha === target.sha
        || (!this.draining() && (admissionSnapshot.available?.sha !== target.sha || this.slice.available?.sha !== target.sha))) {
        this.auto = { ...this.auto, quietSince: null, lastBlockers: admissionProbe?.blockers ?? this.auto.lastBlockers };
        this.saveAuto();
        return;
      }
      this.beginAutoCustody(target);
      const clientKey = pending?.clientKey ?? randomUUID();
      if (!pending) {
        this.auto = { ...this.auto, managedPending: { target, clientKey, at: new Date(this.deps.now()).toISOString(), from: admissionSnapshot.serving.web?.sha ?? null }, quietSince: null };
        this.saveAuto();
      }
      const result = await this.deploy(target, clientKey, "auto");
      if (!result.ok && !result.deliveryUncertain) this.finishManagedAutoRefusal(target, result.detail ?? result.error);
    } finally {
      endRestartGate(gateFile, gateId);
    }
  }

  private async refreshGreen(target: string, checkout: string, prior: GreenVerdict): Promise<GreenVerdict> {
    const verdict = await this.greenReader.read(this.deps.remote, this.deps.branch, target, checkout, prior.firstReadAt, true);
    this.auto = { ...this.auto, green: { ...this.auto.green, [target]: verdict } };
    this.saveAuto();
    return verdict;
  }

  /** The launcher calls this under the held admission gate, immediately before
      taking an automatic request. It is the final read for both restart roles. */
  async admitAutoRestart(requestId: string, gateId: string): Promise<boolean> {
    const pending = this.auto.pending;
    const decision = await this.decide();
    const record = decision.record;
    if (!pending || pending.requestId !== requestId || !record || decision.mode !== "checkout"
      || activeRestartGate(restartGateFile(record.requestFile)) !== gateId) return false;
    const green = await this.refreshGreen(pending.target, record.checkout!, this.auto.green[pending.target] ?? { state: "unknown" });
    const snapshot = await this.snapshot();
    const quiet = this.deps.quiet ? await probeQuiet(snapshot, this.deps.quiet, this.deps.now(), this.draining()) : null;
    if ((this.auto.enabled || this.hasAutoCustody()) && green.state === "green" && this.quietAdmits(quiet) && snapshot.installed.sha === pending.target
      && record.launcher.pid === pending.launcherPid && this.autoAvailability(decision) === "available") return true;
    this.autoBlockers = quiet?.blockers ?? null;
    this.auto = { ...this.auto, pending: null, quietSince: null, lastBlockers: quiet?.blockers ?? this.auto.lastBlockers };
    this.saveAuto();
    return false;
  }

  private pointerForServing(record: LauncherRecord, snapshot: Snapshot): string | null | undefined {
    const checkoutHead = headOf(record.checkout!);
    const serving = snapshot.serving.web?.sha;
    if (!serving || !/^[a-f0-9]{40}$/.test(serving)) return undefined;
    if (serving === checkoutHead) return null;
    try {
      const raw = readFileSync(record.releasePointer, "utf8");
      if ((JSON.parse(raw) as { sha?: string }).sha === serving) return raw;
    } catch { /* a newer build already moved the pointer */ }
    const dir = releaseDirFor(record.releasesDir, serving);
    if (!existsSync(join(dir, ".next", "BUILD_ID")) || headOf(dir) !== serving) return undefined;
    return `${JSON.stringify({ sha: serving, dir, checkoutHead, publishedAt: new Date(this.deps.now()).toISOString() })}\n`;
  }

  /** An operator may override running turns; the transaction still needs
      healthy processes, readable evidence and idle state controllers. */
  private quietAdmits(probe: { quiet: boolean; blockers: QuietBlockers } | null): boolean {
    return !!probe && (probe.quiet || this.auto.drain?.force === true
      && !probe.blockers.busy && !probe.blockers.unreadable && probe.blockers.memoryMb === null);
  }

  private get drainFile(): string { return join(this.deps.dir, "auto-drain.json"); }

  private draining(): boolean { return !!this.auto.drain; }

  /** A switch controls future admission; a persisted accepted transaction owns
      the hold independently, including the gap between checkout roles. */
  private hasAutoCustody(): boolean {
    return !!this.auto.rollback || this.auto.drain?.admitted === true || !!this.auto.pending || !!this.auto.managedPending;
  }

  private beginAutoCustody(target: Revision): void {
    const drain = this.draining() ? this.auto.drain! : {
      id: randomUUID(), target, since: new Date(this.deps.now()).toISOString(), overranAt: null, blockers: null,
    };
    // The short gate fences this write. Persist renewable custody before the
    // request can be accepted and outlive that gate or this service instance.
    writeDrain(this.drainFile, { id: drain.id, target: target.sha, since: drain.since, until: this.deps.now() + DRAIN_LEASE_MS, persistent: true });
    this.auto = { ...this.auto, drain: { ...drain, admitted: true } };
    this.saveAuto();
  }

  private refreshDrain(): void {
    const drain = this.auto.drain;
    if ((this.auto.enabled || this.hasAutoCustody()) && drain) writeDrain(this.drainFile, { id: drain.id, target: drain.target.sha, since: drain.since, until: this.deps.now() + DRAIN_LEASE_MS, persistent: true });
  }

  private endDrain(): void {
    const drain = this.auto.drain;
    if (!drain) return;
    releaseDrain(this.drainFile, drain.id);
    this.auto = { ...this.auto, drain: null };
    this.saveAuto();
    this.deps.requestPipelineTick?.();
  }

  private finishAutoRestart(pending: NonNullable<AutoState["pending"]>, outcome: "done" | "failed" | "fell-back", detail: string | undefined, record: LauncherRecord): void {
    appendHistory(this.historyFile, { at: new Date(this.deps.now()).toISOString(), by: "auto", kind: pending.role === "web" ? "restart-web" : "restart-host", target: pending.target, from: pending.from, outcome, detail });
    if (outcome === "done") {
      this.auto = { ...this.auto, pending: null, quietSince: null };
    } else {
      cancelUntakenRequest(record, pending.requestId);
      restorePointer(record.releasePointer, pending.rollbackPointer);
      this.auto = { ...this.auto, enabled: false, pending: null, quietSince: null,
        off: { at: new Date(this.deps.now()).toISOString(), target: pending.target, stage: pending.role === "web" ? "restart-web" : "restart-host", reason: detail ?? outcome } };
      // Restoring the pointer does not move the other process. Keep durable
      // custody until a later observation proves both are healthy on rollback.
      this.auto = { ...this.auto, rollback: { target: pending.from } };
    }
    this.saveAuto();
  }

  /** Only the operator route accepts this decision; the drain identity fences
      an old tab from forcing a newer update. Keep waiting preserves custody. */
  async decideDrain(id: string, choice: "deploy-now" | "keep-waiting"): Promise<ActionResult> {
    const drain = this.auto.drain;
    if (!this.auto.enabled || !drain || drain.id !== id || !drain.overranAt || drain.acknowledgedAt || drain.admitted) {
      return refuse(409, "auto-switch-superseded", "This automatic update decision is no longer pending");
    }
    this.auto = { ...this.auto, drain: { ...drain, acknowledgedAt: new Date(this.deps.now()).toISOString(), force: choice === "deploy-now" } };
    this.saveAuto();
    if (choice === "deploy-now") await this.autoTick();
    return { ok: true };
  }

  private readPersisted(): Persisted | null {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Persisted;
      return parsed && parsed.slice && parsed.slice.check ? parsed : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private persistNow(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const body: Persisted = { slice: this.slice, update: this.runner?.state ?? this.savedUpdate, pendingRestart: this.pendingRestart,
      autoPending: this.auto.pending, autoRollbackPointer: this.auto.rollbackPointer, autoRollbackCaptured: this.auto.rollbackCaptured };
    writeFileSync(temporary, `${JSON.stringify(body)}\n`);
    renameSync(temporary, this.stateFile);
  }

  saveNow(): void {
    try {
      this.persistNow();
    } catch {
      /* The surface still answers from memory; the next write retries. */
    }
  }

  private changed(): void {
    this.save();
    this.changes.emit();
  }

  async decide(): Promise<ModeDecision> {
    const now = this.deps.now();
    if (this.decision && now - this.decision.at < MODE_TTL_MS) {
      const file = this.deps.env[LAUNCHER_RECORD_ENV]?.trim();
      /* The record is re-read on every decision: it is the live state of both
         processes. */
      if (this.decision.value.mode === "checkout" && file) {
        const record = readLauncherRecord(file);
        if (record) return { ...this.decision.value, record };
      }
      return this.decision.value;
    }
    const value = await this.deps.mode();
    /* A host that does not answer is a moment, never a fact about the
       install: a deployment's own handover replaces the host, and a web
       process promoted mid-deployment asks before the host is back. So that
       answer is never cached, and a managed install stays managed through
       it: by the last managed decision, or by a deployment it recorded as
       still running. */
    if (value.mode === "unsupported" && value.reason === "no-runtime-host") {
      if (this.decision?.value.mode === "managed" || managedActive(this.managed)) return { mode: "managed", reason: null, record: null };
      return value;
    }
    this.decision = { value, at: now };
    return value;
  }

  /* ---------- the check ---------- */

  check(): Promise<void> {
    if (this.checking) return this.checking;
    this.slice = { ...this.slice, check: { ...this.slice.check, state: "checking" } };
    this.changes.emit();
    this.checking = (async () => {
      try {
        const decision = await this.decide();
        const input = await this.checkInput(decision);
        const outcome: CheckOutcome = input
          ? await this.deps.check(input)
          : { ok: false, error: "This install cannot check for updates", code: "cannot-check", installed: null };
        this.slice = applyCheck(this.slice, outcome, new Date(this.deps.now()), this.auto.enabled ? 15 : this.deps.pollMinutes);
      } catch (error) {
        const failed: CheckOutcome = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof CheckError ? { code: error.code } : {}),
          installed: null,
        };
        this.slice = applyCheck(this.slice, failed, new Date(this.deps.now()), this.auto.enabled ? 15 : this.deps.pollMinutes);
      } finally {
        this.checking = null;
        this.undescribable.clear();
        this.schedulePoll();
        this.saveNow();
        this.changes.emit();
        if (this.auto.enabled) void this.autoTick();
      }
    })();
    return this.checking;
  }

  private async checkInput(decision: ModeDecision): Promise<CheckInput | null> {
    const { remote, branch } = this.deps;
    if (decision.mode === "checkout" && decision.record?.checkout) {
      const installed = new ReleasePointer(decision.record.releasePointer, decision.record.checkout).current().sha || "HEAD";
      return { repo: decision.record.checkout, remote, branch, installed };
    }
    if (decision.mode === "managed") {
      const target = this.deps.releaseTarget();
      if (!target) throw new CheckError("no-release-target", "The Viewer release target is not readable, so the installed revision is unknown");
      return { repo: await this.deps.prepareCheckRepo(), remote, branch, installed: target.revision, fetchInstalled: true };
    }
    return null;
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const interval = (this.auto.enabled ? 15 : this.deps.pollMinutes) * 60_000;
    const at = this.slice.check.at ? Date.parse(this.slice.check.at) + interval : this.deps.now() + interval;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.check();
    }, Math.max(1_000, at - this.deps.now()));
    this.pollTimer.unref?.();
  }

  /** The surface opened: check now when nothing current is known. */
  ensureChecked(): void {
    const { check } = this.slice;
    const stale = !check.at || this.deps.now() - Date.parse(check.at) > (this.auto.enabled ? 15 : this.deps.pollMinutes) * 60_000;
    if (check.state === "idle" || (stale && check.state !== "checking")) void this.check();
    else if (!this.pollTimer) this.schedulePoll();
  }

  /* ---------- checkout mode ---------- */

  private runnerFor(record: LauncherRecord): RunnerPort {
    if (this.runner && this.runnerRecord === record.releasePointer) return this.runner;
    const pointer = new ReleasePointer(record.releasePointer, record.checkout!);
    const scratch = join(this.deps.dir, "work");
    this.runner = this.deps.createRunner({
      checkout: record.checkout!,
      remote: this.deps.remote,
      branch: this.deps.branch,
      bun: this.deps.bun,
      logDir: join(this.deps.dir, "steps"),
      releasesDir: record.releasesDir,
      env: this.deps.buildEnv(scratch),
    }, (release) => pointer.publish(release), () => this.changed());
    this.runnerRecord = record.releasePointer;
    if (this.savedUpdate && this.savedUpdate.steps.every((step) => (CHECKOUT_STEPS as readonly string[]).includes(step.name))) {
      this.runner.restore(this.savedUpdate);
    }
    return this.runner;
  }

  stepLog(step: CheckoutStepName): string | null {
    const path = join(this.deps.dir, "steps", `${step}.log`);
    try { return readFileSync(path, "utf8"); } catch { return existsSync(path) ? "" : null; }
  }

  /* ---------- actions ---------- */

  async startUpdate(clientKey: string): Promise<ActionResult> {
    const decision = await this.decide();
    const snapshot = await this.snapshot();
    if (snapshot.busy) return busy(snapshot.busy);
    const available = this.slice.available;
    if (!available && decision.mode === "checkout" && decision.record && this.autoAvailability(decision) === "hand-managed"
      && this.slice.check.relation === "equal" && snapshot.installed.sha) {
      const runner = this.runnerFor(decision.record);
      void runner.start(snapshot.installed.sha, { short: snapshot.installed.short, version: snapshot.installed.version, trigger: "operator" }).catch(() => {}).finally(() => this.afterUpdate());
      return { ok: true };
    }
    if (this.slice.check.state !== "update-available" || !available) return refuse(409, "no-update", "No update is available; run a check first");
    if (decision.mode === "checkout" && decision.record) {
      const runner = this.runnerFor(decision.record);
      void runner.start(available.sha, { short: available.short, version: available.version, trigger: "operator" }).catch(() => {}).finally(() => this.afterUpdate());
      return { ok: true };
    }
    if (decision.mode === "managed") return this.deploy(available, clientKey);
    return refuse(409, "cannot-update", "This install cannot update itself");
  }

  async retry(clientKey: string): Promise<ActionResult> {
    const decision = await this.decide();
    if (decision.mode === "checkout" && decision.record) {
      const runner = this.runnerFor(decision.record);
      const snapshot = await this.snapshot();
      if (snapshot.busy) return busy(snapshot.busy);
      if (runner.state.state !== "failed") return refuse(409, "not-failed", "Only a failed update can be retried");
      void runner.retry().catch(() => {}).finally(() => this.afterUpdate());
      return { ok: true };
    }
    if (decision.mode === "managed") {
      const record = this.managed;
      if (!record || managedActive(record) || record.phase === "succeeded") return refuse(409, "not-failed", "Only a failed deployment can be retried");
      const described = this.described.get(record.target);
      return this.deploy(described ?? { version: record.targetVersion ?? "", sha: record.target, short: record.targetShort, date: "" }, clientKey);
    }
    return refuse(409, "cannot-update", "This install cannot update itself");
  }

  private async deploy(target: Revision, clientKey: string, trigger: "operator" | "auto" = "operator"): Promise<DeploymentResult> {
    if (managedActive(this.managed)) return busy("update");
    let record: ManagedRecord;
    try {
      record = await requestManagedUpdate(target, clientKey, this.deps.requestDeployment, this.deps.now, trigger);
    } catch (error) {
      if (error instanceof DeploymentBusyError) return refuse(409, "deployment-busy", error.message);
      const detail = error instanceof Error ? error.message : undefined;
      return { ...refuse(503, "deployment-refused", "The runtime host did not take the deployment", detail),
        ...(isRuntimeHostTransportFailure(error) ? { deliveryUncertain: true } : {}) };
    }
    this.managed = record;
    this.saveManaged();
    this.watchDeployment();
    this.changes.emit();
    return { ok: true };
  }

  private afterUpdate(): void {
    const state = this.runner?.state;
    if (state?.target && state.trigger) {
      const result = state.state;
      if (result === "done" || result === "failed") {
        appendHistory(this.historyFile, { at: new Date(this.deps.now()).toISOString(), by: state.trigger, kind: "build", target: state.target, from: null, outcome: result === "done" ? "done" : "failed", detail: result === "failed" ? JSON.stringify(state.steps.find((step) => step.state === "failed")?.failure ?? null) : undefined });
        if (state.trigger === "auto" && result === "failed") {
          const failure = state.steps.find((step) => step.state === "failed")?.failure;
          if (failure && !["remote-moved", "memory", "interrupted"].includes(failure.kind)) {
            const step = state.steps.find((entry) => entry.state === "failed")?.name ?? "build";
            const reason = failure.kind === "timeout" ? `${step} exceeded ${failure.minutes} min`
              : failure.kind === "exit" ? `${step} exited with code ${failure.code}`
              : failure.kind === "error" ? `${step}: ${failure.text}`
              : `${step} failed (${failure.kind})`;
            this.auto = { ...this.auto, enabled: false, off: { at: new Date(this.deps.now()).toISOString(), target: state.target, stage: "build", reason } };
            this.saveAuto();
          }
        }
      }
    }
    this.saveNow();
    if (this.runner?.state.state === "done" || (this.runner?.state.state === "failed" && ["remote-moved", "memory", "interrupted"].includes(this.runner.state.steps.find((step) => step.state === "failed")?.failure?.kind ?? ""))) void this.check();
    this.changes.emit();
    if (this.auto.enabled) void this.autoTick();
  }

  async restart(role: LauncherRole): Promise<ActionResult> {
    const decision = await this.decide();
    if (decision.mode !== "checkout" || !decision.record) {
      return decision.mode === "managed"
        ? refuse(409, "managed-restart", "A managed install restarts its processes through a deployment")
        : refuse(409, "cannot-restart", "This install cannot restart its processes");
    }
    const snapshot = await this.snapshot();
    if (snapshot.busy) return busy(snapshot.busy);
    const requestId = this.deps.requestRestart(decision.record, role);
    this.pendingRestart = { role, requestId, at: this.deps.now(), from: role === "web" ? decision.record.web.revision : decision.record.runtimeHost.revision, target: snapshot.installed.sha };
    this.saveNow();
    this.changes.emit();
    return { ok: true };
  }

  /* ---------- the snapshot ---------- */

  /* A revision the repository cannot describe yet (the managed check
     repository before its first fetch) is not asked about again on every
     snapshot: the answer is held for a while, and a finished check, which
     may have brought the objects, clears it. */
  private async describe(repo: string, sha: string): Promise<Revision> {
    const known = this.described.get(sha);
    if (known) return known;
    const unknown = { ...UNKNOWN_REVISION, sha, short: shortSha(sha) };
    const heldUntil = this.undescribable.get(sha);
    if (heldUntil !== undefined && this.deps.now() < heldUntil) return unknown;
    try {
      const revision = await this.deps.describe(repo, sha);
      this.described.set(sha, revision);
      this.undescribable.delete(sha);
      return revision;
    } catch {
      this.undescribable.set(sha, this.deps.now() + UNDESCRIBABLE_HOLD_MS);
      return unknown;
    }
  }

  private async describeShort(repo: string | null, short: string | null): Promise<Revision | null> {
    if (!short) return null;
    for (const revision of this.described.values()) if (revision.short === short) return revision;
    if (repo) {
      try { return await this.describe(repo, short); } catch { /* falls through */ }
    }
    return { ...UNKNOWN_REVISION, short };
  }

  /** Reads the deployment once more while it is active. */
  async refreshManaged(): Promise<void> {
    if (!managedActive(this.managed)) {
      if (this.managedNeedsSave) this.saveManaged();
      return;
    }
    try {
      const status = await this.deps.readDeployment(this.managed!.deploymentId);
      const next = status ? observeDeployment(this.managed!, status) : observeMissing(this.managed!, this.deps.now());
      if (JSON.stringify(next) !== JSON.stringify(this.managed)) {
        this.managed = next;
        this.managedNeedsSave = true;
        this.changes.emit();
        if (!managedActive(next) && next.phase === "succeeded") void this.check();
      }
    } catch {
      /* The web process is replaced mid-deployment; the next one reads on. */
    }
    if (this.managedNeedsSave) this.saveManaged();
    this.finishManagedAuto();
  }

  active(): boolean {
    return this.checking !== null || (this.runner?.state.state === "running") || managedActive(this.managed) || this.pendingRestart !== null;
  }

  async snapshot(): Promise<Snapshot> {
    return this.buildSnapshot();
  }

  private async buildSnapshot(replayAuto?: AutoState): Promise<Snapshot> {
    const decision = await this.decide();
    const now = this.deps.now();
    const base = {
      mode: decision.mode,
      unsupportedReason: decision.reason,
      available: this.slice.available,
      check: this.slice.check,
      meta: {
        branch: this.deps.branch,
        remote: this.deps.remote,
        checkout: decision.record?.checkout ?? null,
        pollMinutes: this.deps.pollMinutes,
        serverTime: new Date(now).toISOString(),
      },
    };
    const snapshot: Snapshot = decision.mode === "checkout" && decision.record ? { ...base, ...await this.checkoutPart(decision.record, now) }
      : decision.mode === "managed" ? { ...base, ...await this.managedPart(now) } : {
      ...base,
      installed: this.slice.installed ?? UNKNOWN_REVISION,
      serving: { web: null, runtimeHost: null },
      update: idleUpdate(CHECKOUT_STEPS),
      processes: { web: { ...stoppedProcess(), tail: [] }, runtimeHost: { ...stoppedProcess(), tail: [] } },
      busy: null,
    };
    if (snapshot.mode === "managed") this.finishManagedAuto(snapshot);
    // Ordinary reads use the controller state after awaited deployment
    // refreshes. Receipt snapshots pass replayAuto to preserve their original
    // immutable response across later changes.
    const auto = replayAuto ?? this.auto;
    snapshot.auto = this.autoView(decision, snapshot, auto);
    snapshot.history = readHistory(this.historyFile);
    snapshot.meta.pollMinutes = auto.enabled ? 15 : this.deps.pollMinutes;
    return snapshot;
  }

  private async checkoutPart(record: LauncherRecord, now: number): Promise<Omit<Snapshot, "mode" | "unsupportedReason" | "available" | "check" | "meta">> {
    const runner = this.runnerFor(record);
    const pointer = new ReleasePointer(record.releasePointer, record.checkout!).current();
    const installed = pointer.sha ? await this.describe(record.checkout!, pointer.sha) : (this.slice.installed ?? UNKNOWN_REVISION);
    let health: RuntimeHostHealth | null = null;
    let healthError: string | null = null;
    try { health = await this.deps.hostHealth(); } catch (error) { healthError = error instanceof Error ? error.message : String(error); }
    const at = new Date(now).toISOString();

    const fromRecord = (entry: LauncherProcess, extra: Partial<ProcessStatus>): ProcessView => {
      const status: ProcessView = {
        ...stoppedProcess(),
        state: entry.state,
        pid: entry.pid,
        startedAt: entry.startedAt,
        revision: entry.revision,
        error: entry.error,
        tail: [],
        ...extra,
      };
      const gone = entry.pid !== null && entry.startIdentity !== null && !this.deps.processAlive(entry.pid, entry.startIdentity);
      if (gone && (entry.state === "healthy" || entry.state === "starting")) {
        return { ...status, pid: null, state: "failed", error: entry.error ?? { kind: "gone", pid: entry.pid! }, lastHealthOk: false, lastHealthAt: at };
      }
      /* A failed launch names no live process: its card offers a start. */
      if (gone && entry.state === "failed") return { ...status, pid: null };
      return status;
    };
    const web = fromRecord(record.web, {
      port: record.port,
      ...(record.web.pid === this.deps.web.pid ? { lastHealthAt: at, lastHealthOk: true } : {}),
    });
    let host = fromRecord(record.runtimeHost, { socket: record.socket });
    if (host.state === "healthy") {
      if (health && health.pid === host.pid && health.startIdentity === record.runtimeHost.startIdentity) host = { ...host, lastHealthAt: at, lastHealthOk: true };
      else host = { ...host, state: "failed", lastHealthAt: at, lastHealthOk: false, error: { kind: "message", text: healthError ?? (health ? "Runtime host health identity does not match the launcher" : "Runtime host health is unavailable") } };
    }

    /* Busy follows what the processes are, after the PID check: a "starting"
       entry whose PID is gone is a launch that failed, which blocks nothing,
       and the surface offers to start it again. */
    const moving = (view: ProcessView) => view.state === "stopping" || view.state === "starting";
    let busy: Busy = runner.state.state === "running" ? "update" : null;
    if (!busy && moving(web)) busy = "restart-web";
    if (!busy && moving(host)) busy = "restart-runtime-host";
    const pending = this.pendingRestart;
    if (pending) {
      const entry = pending.role === "web" ? record.web : record.runtimeHost;
      const settled = entry.requestId === pending.requestId && !moving(pending.role === "web" ? web : host);
      if (settled || now - pending.at > PENDING_RESTART_MS) {
        if (settled) appendHistory(this.historyFile, { at, by: "operator", kind: pending.role === "web" ? "restart-web" : "restart-host", target: pending.target, from: pending.from,
          outcome: entry.error?.kind === "fell-back" ? "fell-back" : entry.state === "healthy" ? "done" : "failed", detail: entry.error?.kind === "fell-back" ? entry.error.detail : undefined });
        this.pendingRestart = null;
        this.saveNow();
      }
      else busy = busy ?? (pending.role === "web" ? "restart-web" : "restart-runtime-host");
    }
    return {
      installed,
      serving: {
        web: web.pid !== null ? await this.describeShort(record.checkout, web.revision) : null,
        runtimeHost: host.pid !== null ? await this.describeShort(record.checkout, host.revision) : null,
      },
      update: runner.state,
      processes: { web, runtimeHost: host },
      busy,
    };
  }

  private async managedPart(now: number): Promise<Omit<Snapshot, "mode" | "unsupportedReason" | "available" | "check" | "meta">> {
    await this.refreshManaged();
    let target: { revision: string } | null = null;
    try { target = this.deps.releaseTarget(); } catch { target = null; }
    let repo: string | null = null;
    try { repo = await this.deps.prepareCheckRepo(); } catch { repo = null; }
    const installed = target
      ? (repo ? await this.describe(repo, target.revision) : { ...UNKNOWN_REVISION, sha: target.revision, short: shortSha(target.revision) })
      : (this.slice.installed ?? UNKNOWN_REVISION);
    const update = this.managed ? managedUpdateState(this.managed, now) : idleUpdate(MANAGED_STEPS);
    const running = (name: string) => update.state === "running" && update.steps.some((step) => step.name === name && step.state === "running");
    const at = new Date(now).toISOString();

    const web: ProcessView = {
      ...stoppedProcess(),
      state: running("promote") ? "starting" : "healthy",
      pid: this.deps.web.pid,
      port: this.deps.web.port,
      startedAt: this.deps.web.startedAt,
      lastHealthAt: at,
      lastHealthOk: true,
      revision: installed.short || null,
      tail: [],
    };
    let host: ProcessView;
    try {
      const health = await this.deps.hostHealth();
      const revision = health?.generation?.revision ? shortSha(health.generation.revision) : null;
      host = health
        ? { ...stoppedProcess(), state: running("handoff") ? "starting" : "healthy", pid: health.pid, lastHealthAt: at, lastHealthOk: true, revision, tail: [] }
        : { ...stoppedProcess(), state: "failed", error: { kind: "no-answer" }, tail: [] };
    } catch (error) {
      host = { ...stoppedProcess(), state: running("handoff") ? "starting" : "failed", lastHealthAt: at, lastHealthOk: false, error: { kind: "message", text: error instanceof Error ? error.message : String(error) }, tail: [] };
    }
    return {
      installed,
      serving: {
        web: target ? installed : null,
        runtimeHost: host.revision ? await this.describeShort(repo, host.revision) : null,
      },
      update,
      processes: { web, runtimeHost: host },
      busy: managedActive(this.managed) ? "update" : null,
    };
  }

  stop(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    if (this.deploymentWatch) clearInterval(this.deploymentWatch);
    this.deploymentWatch = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.pollTimer = null;
    this.saveTimer = null;
  }
}
