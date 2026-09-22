/* The self-update service (#2007): one per web process, behind the Update
   surface's routes. It holds the update check, and either the checkout
   install's step runner or the managed install's deployment record, and it
   answers one Snapshot for both modes.

   What survives the web process being replaced (which is what a restart or a
   deployment does to it) is on disk under `<state>/self-update/`: the check
   and the last checkout update in `state.json`, the deployment in
   `managed.json`, and the launcher's own record. A fresh process reads them
   back, so the surface carries on where the previous one stopped. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RuntimeHostHealth } from "@/lib/runtime/client";
import type { ViewerDeploymentReceipt, ViewerDeploymentRequest, ViewerDeploymentStatus } from "@/lib/runtime/contracts";

import { applyCheck, initialCheck, type CheckSlice } from "./checkState";
import type { CheckInput, CheckOutcome } from "./git";
import { readLauncherRecord, type LauncherProcess, type LauncherRecord, type LauncherRole } from "./launcher";
import {
  DeploymentBusyError,
  managedActive,
  managedUpdateState,
  observeDeployment,
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
  type Revision,
  type Snapshot,
  type UpdateState,
} from "./types";

export interface RunnerPort {
  state: UpdateState;
  start(target: string, meta?: { short?: string; version?: string }): Promise<void>;
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
  releaseTarget(): { revision: string } | null;
  prepareCheckRepo(): Promise<string>;
  buildEnv(scratchRoot: string): Record<string, string>;
  web: { pid: number; port: number | null; startedAt: string };
}

export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

const MODE_TTL_MS = 30_000;
const PENDING_RESTART_MS = 60_000;
const SAVE_DELAY_MS = 1_000;
const DEPLOYMENT_WATCH_MS = 1_000;

interface Persisted { slice: CheckSlice; update: UpdateState | null }

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
  private decision: { value: ModeDecision; at: number } | null = null;
  private pendingRestart: { role: LauncherRole; requestId: string; at: number } | null = null;
  private readonly described = new Map<string, Revision>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private deploymentWatch: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ServiceDeps) {
    const persisted = this.readPersisted();
    if (persisted) {
      this.slice = persisted.slice;
      this.savedUpdate = persisted.update;
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

  saveNow(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      const body: Persisted = { slice: this.slice, update: this.runner?.state ?? this.savedUpdate };
      writeFileSync(temporary, `${JSON.stringify(body)}\n`);
      renameSync(temporary, this.stateFile);
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
          : { ok: false, error: "This install cannot check for updates", installed: null };
        this.slice = applyCheck(this.slice, outcome, new Date(this.deps.now()), this.deps.pollMinutes);
      } catch (error) {
        const failed: CheckOutcome = { ok: false, error: error instanceof Error ? error.message : String(error), installed: null };
        this.slice = applyCheck(this.slice, failed, new Date(this.deps.now()), this.deps.pollMinutes);
      } finally {
        this.checking = null;
        this.schedulePoll();
        this.saveNow();
        this.changes.emit();
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
      if (!target) throw new Error("The Viewer release target is not readable, so the installed revision is unknown");
      return { repo: await this.deps.prepareCheckRepo(), remote, branch, installed: target.revision, fetchInstalled: true };
    }
    return null;
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const at = this.slice.check.nextPollAt ? Date.parse(this.slice.check.nextPollAt) : this.deps.now() + this.deps.pollMinutes * 60_000;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.check();
    }, Math.max(1_000, at - this.deps.now()));
    this.pollTimer.unref?.();
  }

  /** The surface opened: check now when nothing current is known. */
  ensureChecked(): void {
    const { check } = this.slice;
    const stale = !check.at || this.deps.now() - Date.parse(check.at) > this.deps.pollMinutes * 60_000;
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
    if (snapshot.busy) return { ok: false, status: 409, error: `Busy: ${snapshot.busy}` };
    const available = this.slice.available;
    if (this.slice.check.state !== "update-available" || !available) return { ok: false, status: 409, error: "No update is available; run a check first" };
    if (decision.mode === "checkout" && decision.record) {
      const runner = this.runnerFor(decision.record);
      void runner.start(available.sha, { short: available.short, version: available.version }).catch(() => {}).finally(() => this.afterUpdate());
      return { ok: true };
    }
    if (decision.mode === "managed") return this.deploy(available, clientKey);
    return { ok: false, status: 409, error: "This install cannot update itself" };
  }

  async retry(clientKey: string): Promise<ActionResult> {
    const decision = await this.decide();
    if (decision.mode === "checkout" && decision.record) {
      const runner = this.runnerFor(decision.record);
      const snapshot = await this.snapshot();
      if (snapshot.busy) return { ok: false, status: 409, error: `Busy: ${snapshot.busy}` };
      if (runner.state.state !== "failed") return { ok: false, status: 409, error: "Only a failed update can be retried" };
      void runner.retry().catch(() => {}).finally(() => this.afterUpdate());
      return { ok: true };
    }
    if (decision.mode === "managed") {
      const record = this.managed;
      if (!record || managedActive(record) || record.phase === "succeeded") return { ok: false, status: 409, error: "Only a failed deployment can be retried" };
      const described = this.described.get(record.target);
      return this.deploy(described ?? { version: record.targetVersion ?? "", sha: record.target, short: record.targetShort, date: "" }, clientKey);
    }
    return { ok: false, status: 409, error: "This install cannot update itself" };
  }

  private async deploy(target: Revision, clientKey: string): Promise<ActionResult> {
    if (managedActive(this.managed)) return { ok: false, status: 409, error: "Busy: update" };
    try {
      this.managed = await requestManagedUpdate(target, clientKey, this.deps.requestDeployment, this.deps.now);
      writeManagedRecord(this.managedFile, this.managed);
      this.watchDeployment();
      this.changes.emit();
      return { ok: true };
    } catch (error) {
      if (error instanceof DeploymentBusyError) return { ok: false, status: 409, error: error.message };
      return { ok: false, status: 503, error: error instanceof Error ? error.message : "The runtime host did not take the deployment" };
    }
  }

  private afterUpdate(): void {
    this.saveNow();
    if (this.runner?.state.state === "done") void this.check();
    this.changes.emit();
  }

  async restart(role: LauncherRole): Promise<ActionResult> {
    const decision = await this.decide();
    if (decision.mode !== "checkout" || !decision.record) {
      return { ok: false, status: 409, error: decision.mode === "managed" ? "A managed install restarts its processes through a deployment" : "This install cannot restart its processes" };
    }
    const snapshot = await this.snapshot();
    if (snapshot.busy) return { ok: false, status: 409, error: `Busy: ${snapshot.busy}` };
    const requestId = this.deps.requestRestart(decision.record, role);
    this.pendingRestart = { role, requestId, at: this.deps.now() };
    this.changes.emit();
    return { ok: true };
  }

  /* ---------- the snapshot ---------- */

  private async describe(repo: string, sha: string): Promise<Revision> {
    const known = this.described.get(sha);
    if (known) return known;
    try {
      const revision = await this.deps.describe(repo, sha);
      this.described.set(sha, revision);
      return revision;
    } catch {
      return { ...UNKNOWN_REVISION, sha, short: shortSha(sha) };
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
    if (!managedActive(this.managed)) return;
    try {
      const status = await this.deps.readDeployment(this.managed!.deploymentId);
      const next = observeDeployment(this.managed!, status);
      if (JSON.stringify(next) !== JSON.stringify(this.managed)) {
        this.managed = next;
        writeManagedRecord(this.managedFile, next);
        this.changes.emit();
        if (!managedActive(next) && next.phase === "succeeded") void this.check();
      }
    } catch {
      /* The web process is replaced mid-deployment; the next one reads on. */
    }
  }

  active(): boolean {
    return this.checking !== null || (this.runner?.state.state === "running") || managedActive(this.managed) || this.pendingRestart !== null;
  }

  async snapshot(): Promise<Snapshot> {
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
    if (decision.mode === "checkout" && decision.record) return { ...base, ...await this.checkoutPart(decision.record, now) };
    if (decision.mode === "managed") return { ...base, ...await this.managedPart(now) };
    return {
      ...base,
      installed: this.slice.installed ?? UNKNOWN_REVISION,
      serving: { web: null, runtimeHost: null },
      update: idleUpdate(CHECKOUT_STEPS),
      processes: { web: { ...stoppedProcess(), tail: [] }, runtimeHost: { ...stoppedProcess(), tail: [] } },
      busy: null,
    };
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
      if (entry.pid !== null && entry.startIdentity && (entry.state === "healthy" || entry.state === "starting")
        && !this.deps.processAlive(entry.pid, entry.startIdentity)) {
        return { ...status, state: "failed", error: { kind: "gone", pid: entry.pid }, lastHealthOk: false, lastHealthAt: at };
      }
      return status;
    };
    const web = fromRecord(record.web, {
      port: record.port,
      ...(record.web.pid === this.deps.web.pid ? { lastHealthAt: at, lastHealthOk: true } : {}),
    });
    let host = fromRecord(record.runtimeHost, { socket: record.socket });
    if (host.state === "healthy") {
      if (health && health.pid === host.pid) host = { ...host, lastHealthAt: at, lastHealthOk: true };
      else if (healthError) host = { ...host, state: "failed", lastHealthAt: at, lastHealthOk: false, error: { kind: "message", text: healthError } };
    }

    let busy: Busy = runner.state.state === "running" ? "update" : null;
    if (!busy && (record.web.state === "stopping" || record.web.state === "starting")) busy = "restart-web";
    if (!busy && (record.runtimeHost.state === "stopping" || record.runtimeHost.state === "starting")) busy = "restart-runtime-host";
    const pending = this.pendingRestart;
    if (pending) {
      const entry = pending.role === "web" ? record.web : record.runtimeHost;
      const settled = entry.requestId === pending.requestId && entry.state !== "stopping" && entry.state !== "starting";
      if (settled || now - pending.at > PENDING_RESTART_MS) this.pendingRestart = null;
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
        : { ...stoppedProcess(), state: "failed", error: { kind: "message", text: "The runtime host did not answer" }, tail: [] };
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
    if (this.deploymentWatch) clearInterval(this.deploymentWatch);
    this.deploymentWatch = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.pollTimer = null;
    this.saveTimer = null;
  }
}
