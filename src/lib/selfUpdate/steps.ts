/* The five update steps of a checkout install (#2007), run one after another,
   stopping at the first failure. The target is checked out into its own
   release directory (a git worktree of the checkout) and installed and built
   there; the directory the running processes serve from is never written.
   Only a ready build is published as the installed release, which the next
   restart runs. The runner never starts or stops a process. Commands go
   through an injected port so tests stub them. */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { cpus, loadavg, setPriority } from "node:os";

import { recordHelperGroup } from "@/lib/helperLease";
import { wrapReleaseCommand, wrapWorkCommand } from "@/lib/runtime/cpuPlacement";
import { machineCpuPressureGate, waitForCpuPressure, type CpuPressureGate } from "@/lib/runtime/cpuPressure";
import { runGit, TIP_REF } from "./git";
import { classifyStatus, disposableIgnoredPath } from "@/lib/pipelines/worktreeSweep";
import { readStartIdentity, sameProcess, signalGroup, type RecordedPid } from "./pid";
import { releaseDirFor, type Release } from "./release";
import { CHECKOUT_STEPS, idleUpdate, pendingSteps, shortSha, type CheckoutStepName, type Step, type StepFailure, type UpdateState } from "./types";

export const TAIL_LINES = 40;
export const MIN_AVAILABLE_MB = 4_096;

export interface RunOptions {
  cwd: string; env: Record<string, string>; onLine(line: string): void; lowPriority?: boolean;
  /** Heavy work: the real port runs it in a CPU work scope under this label. */
  work?: string;
}

export interface StepPorts {
  /** Runs a command to completion and answers its exit code. */
  run(command: string[], options: RunOptions): Promise<number>;
  memAvailableMb(): number;
  revParse(ref: string, cwd: string): Promise<string>;
  exists(path: string): boolean;
  buildIdReadable(dir: string): boolean;
  /** Makes a ready build the installed release. */
  publish(release: Release): void | Promise<void>;
  now(): number;
  cpuLoad?(): { load1: number; cpus: number };
  abort?(): void | Promise<void>;
  /** False for an authoritative end without an exit status; null for a
      missing PID whose exit notification is still pending. A recorded exit
      code remains valid while run() drains output and settles. */
  childAlive?(): boolean | null;
  /** The commit whose build passed the ready check in this directory, when
      the directory records one; a new build withdraws the record first. */
  builtRevision?(dir: string): string | null;
  markBuilt?(dir: string, sha: string | null): void;
  /** Refuses dirty existing checkouts; the real port restores proven missing paths. */
  prepareExistingRelease?(dir: string): Promise<string | null>;
}

/** Written by the ready step: the build in this release directory passed its
    check for the named commit, so a later run of the same target reuses it. */
const BUILT_MARKER = join(".next", "DELEGATUS_RELEASE_READY");

export function builtRevision(dir: string): string | null {
  try { return readFileSync(join(dir, BUILT_MARKER), "utf8").trim() || null; } catch { return null; }
}

/** Whether `dir` holds a build of `sha` that already passed the ready check. */
export function releaseBuilt(dir: string, sha: string): boolean {
  return builtRevision(dir) === sha && existsSync(join(dir, ".next", "BUILD_ID"));
}

/** Restore only missing tracked paths left by an interrupted removal. */
export async function prepareExistingRelease(dir: string, git: typeof runGit = runGit): Promise<string | null> {
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], dir);
  if (status.code !== 0) return `cannot inspect existing release contents: ${status.stderr || status.stdout}`;
  const classified = classifyStatus(status.stdout, true);
  const onlyMissingTracked = classified.changed.length > 0 && status.stdout.split("\0").filter(Boolean).every(row => /^( D|D ) /.test(row) || row.startsWith("!! "));
  if (classified.changed.length && (!onlyMissingTracked || existsSync(join(dir, BUILT_MARKER)))) return "Existing release has local changes; checkout was refused to preserve them";
  if (classified.ignored.some(entry => !disposableIgnoredPath(dir, entry))) return "Existing release has ignored contents that cannot be proven generated; checkout was refused";
  if (!classified.changed.length) return null;
  const missing = await git(["ls-files", "--deleted", "-z"], dir);
  const paths = missing.stdout.split("\0").filter(Boolean);
  if (missing.code !== 0 || !paths.length) return "Existing release has changes that cannot be proven to come from interrupted removal";
  // checkout-index without --force restores absent paths while leaving a
  // writer's file intact if it appeared after ls-files --deleted.
  const restored = await git(["checkout-index", "--", ...paths], dir);
  if (restored.code !== 0) return `cannot restore missing release files: ${restored.stderr || restored.stdout}`;
  const checked = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], dir);
  if (checked.code !== 0) return "Existing release status could not be checked after deletion recovery";
  const after = classifyStatus(checked.stdout, true);
  if (after.changed.length || after.ignored.some(entry => !disposableIgnoredPath(dir, entry))) return "Existing release still has local changes after deletion recovery; checkout was refused";
  return null;
}

export interface RunnerConfig {
  checkout: string;
  remote: string;
  branch: string;
  bun: string;
  logDir: string;
  releasesDir: string;
  env: Record<string, string>;
  /** Tests can shorten the deadline without sleeping for minutes. */
  stepTimeoutMs?: Partial<Record<CheckoutStepName, number>>;
  livenessPollMs?: number;
  /** Output renews this silence bound; the total step bound never moves. */
  releaseIdleTimeoutMs?: number;
}

export const RELEASE_IDLE_TIMEOUT_MS = 30 * 60_000;

export const STEP_TIMEOUT_MS: Record<CheckoutStepName, number> = {
  fetch: 10 * 60_000, checkout: 5 * 60_000, install: 60 * 60_000,
  build: 2 * 60 * 60_000, ready: 5 * 60_000,
};

/* A command that exited non-zero; its output is already in the log. */
class CommandFailure extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

/* A step that failed for a reason of ours: the fact travels to the surface,
   which words it; the log file gets the same fact as a line. */
class StepError extends Error {
  constructor(readonly failure: StepFailure, line: string) { super(line); }
}

export class UpdateRunner {
  state: UpdateState = idleUpdate(CHECKOUT_STEPS);

  constructor(
    private readonly config: RunnerConfig,
    private readonly ports: StepPorts,
    private readonly onChange: () => void,
  ) {}

  logPath(step: CheckoutStepName): string {
    return join(this.config.logDir, `${step}.log`);
  }

  /** A state read back from disk after the web process restarted. A run the
      restart cut short is reported as failed at the step it was in, never as
      still running. */
  restore(saved: UpdateState): void {
    if (saved.state !== "running") { this.state = saved; return; }
    this.state = {
      ...saved,
      state: "failed",
      finishedAt: saved.finishedAt ?? new Date(this.ports.now()).toISOString(),
      steps: saved.steps.map((step) => step.state === "running"
        ? { ...step, state: "failed", failure: { kind: "interrupted" } }
        : { ...step, failure: step.failure ?? null }),
    };
  }

  async start(target: string, meta: { short?: string; version?: string; trigger?: "operator" | "seat" | "auto" } = {}): Promise<void> {
    if (this.state.state === "running") throw new Error("an update is already running");
    this.state = {
      ...idleUpdate(CHECKOUT_STEPS),
      state: "running",
      target,
      targetShort: meta.short ?? shortSha(target),
      targetVersion: meta.version ?? null,
      releaseDir: releaseDirFor(this.config.releasesDir, target),
      startedAt: this.iso(),
      trigger: meta.trigger ?? "operator",
    };
    this.onChange();
    await this.runFrom(0);
  }

  async retry(): Promise<void> {
    if (this.state.state !== "failed" || !this.state.target) throw new Error("update is not failed");
    const from = Math.max(0, this.state.steps.findIndex((step) => step.state === "failed"));
    this.state = {
      ...this.state,
      state: "running",
      finishedAt: null,
      steps: this.state.steps.map((step, index) => index >= from ? { ...pendingSteps(CHECKOUT_STEPS)[index]! } : step),
    };
    this.onChange();
    await this.runFrom(from);
  }

  private iso(): string {
    return new Date(this.ports.now()).toISOString();
  }

  private patch(index: number, change: Partial<Step>): void {
    const steps = this.state.steps.slice();
    steps[index] = { ...steps[index]!, ...change };
    this.state = { ...this.state, steps };
    this.onChange();
  }

  private async runFrom(from: number): Promise<void> {
    mkdirSync(this.config.logDir, { recursive: true });
    for (let index = from; index < CHECKOUT_STEPS.length; index += 1) {
      const name = CHECKOUT_STEPS[index]!;
      const started = this.ports.now();
      const releaseWork = name === "install" || name === "build";
      this.patch(index, { state: "running", startedAt: this.iso(), durationMs: null, exitCode: null, tail: [], failure: null });
      const fd = openSync(this.logPath(name), "w");
      const tail: string[] = [];
      let accepting = true;
      let renewProgress: (() => void) | null = null;
      const push = (line: string, toTail = true) => {
        if (!accepting) return;
        writeSync(fd, `${line}\n`);
        if (!toTail) return;
        if (line.trim()) renewProgress?.();
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        this.patch(index, { tail: tail.slice() });
      };
      let exitCode: number | null = null;
      let failure: StepFailure | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;
      let exitTurn: ReturnType<typeof setImmediate> | null = null;
      let exitGrace: ReturnType<typeof setTimeout> | null = null;
      let liveness: ReturnType<typeof setInterval> | null = null;
      let expiring = false;
      try {
        const limit = this.config.stepTimeoutMs?.[name] ?? STEP_TIMEOUT_MS[name];
        const timeout = (reason: "silence" | "total") => {
          const failure: StepFailure = { kind: "timeout", minutes: releaseWork ? (this.ports.now() - started) / 60_000 : limit / 60_000,
            ...(releaseWork ? { reason, ...(reason === "silence" ? { idleMinutes: (this.config.releaseIdleTimeoutMs ?? RELEASE_IDLE_TIMEOUT_MS) / 60_000 } : {}), ...this.ports.cpuLoad?.() } : {}) };
          return new StepError(failure, `${name}: ${stepFailureDetail(failure)}`);
        };
        exitCode = await Promise.race([
          this.runStep(name, push).then(
            value => expiring ? new Promise<never>(() => {}) : value,
            error => { if (expiring) return new Promise<never>(() => {}); throw error; },
          ),
          new Promise<never>((_, reject) => {
            const stop = (error: StepError) => {
              if (expiring) return;
              expiring = true;
              renewProgress = null;
              if (silenceTimer) clearTimeout(silenceTimer);
              if (timer) clearTimeout(timer);
              void Promise.resolve(this.ports.abort?.()).then(() => reject(error), cleanup => {
                const text = `${stepFailureDetail(error.failure)}; cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
                reject(new StepError({ kind: "error", text }, `${name}: ${text}`));
              });
            };
            const expire = (reason: "silence" | "total") => {
              const alive = this.ports.childAlive?.();
              stop(alive === false
                ? new StepError({ kind: "interrupted" }, `${name} child process ended without an exit status before the deadline`)
                : timeout(reason));
            };
            const due = (reason: "silence" | "total") => {
              if (expiring) return;
              // Both deadlines allow queued exit I/O to settle. A missing PID
              // alone cannot distinguish a successful exit from a lost one.
              if (this.ports.childAlive?.() === null) {
                if (exitTurn || exitGrace) return;
                exitTurn = setImmediate(() => {
                  exitTurn = null;
                  exitGrace = setTimeout(() => { exitGrace = null; expire(reason); }, this.config.livenessPollMs ?? 1_000);
                  exitGrace.unref?.();
                });
              } else expire(reason);
            };
            if (releaseWork) {
              renewProgress = () => {
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => due("silence"), this.config.releaseIdleTimeoutMs ?? RELEASE_IDLE_TIMEOUT_MS);
                silenceTimer.unref?.();
              };
              renewProgress();
            }
            timer = setTimeout(() => due("total"), limit);
            timer.unref?.();
          }),
          new Promise<never>((_, reject) => {
            if (!this.ports.childAlive) return;
            liveness = setInterval(() => {
              if (!expiring && this.ports.childAlive?.() === false) reject(new StepError({ kind: "interrupted" }, `${name} child process ended without settling the step`));
            }, this.config.livenessPollMs ?? 1_000);
            liveness.unref?.();
          }),
        ]);
      } catch (error) {
        if (error instanceof CommandFailure) {
          exitCode = error.code;
          failure = { kind: "exit", code: error.code };
        } else if (error instanceof StepError) {
          push(error.message, false);
          failure = error.failure;
        } else {
          /* Unexpected: its text is machine output, shown as it came. */
          const text = error instanceof Error ? error.message : String(error);
          push(text);
          failure = { kind: "error", text };
        }
      } finally {
        renewProgress = null;
        if (silenceTimer) clearTimeout(silenceTimer);
        if (timer) clearTimeout(timer);
        if (exitTurn) clearImmediate(exitTurn);
        if (exitGrace) clearTimeout(exitGrace);
        if (liveness) clearInterval(liveness);
        accepting = false;
        closeSync(fd);
      }
      const ok = failure === null;
      this.patch(index, {
        state: ok ? "done" : "failed",
        durationMs: this.ports.now() - started,
        exitCode,
        tail: tail.slice(),
        failure,
      });
      if (!ok) {
        this.state = { ...this.state, state: "failed", finishedAt: this.iso() };
        this.onChange();
        return;
      }
    }
    this.state = { ...this.state, state: "done", finishedAt: this.iso() };
    this.onChange();
  }

  /* Answers the exit code of a command step (null for the check-only step).
     A CommandFailure means the command's own output explains it; any other
     error's message is pushed as the step's last line. */
  private async runStep(name: CheckoutStepName, push: (line: string, toTail?: boolean) => void): Promise<number | null> {
    const { checkout, remote, branch, bun, env } = this.config;
    const target = this.state.target!;
    const release = this.state.releaseDir!;
    const command = async (argv: string[], cwd: string, work?: string): Promise<number> => {
      push(`$ ${argv.join(" ")}   (in ${cwd})`, false);
      const code = await this.ports.run(argv, { cwd, env, onLine: (line) => push(line), lowPriority: this.state.trigger === "auto" && name !== "build" && name !== "install", ...(work ? { work } : {}) });
      push(`exit ${code}`, false);
      if (code !== 0) throw new CommandFailure(code);
      return code;
    };
    const guardMemory = () => {
      const available = Math.floor(this.ports.memAvailableMb());
      if (available < MIN_AVAILABLE_MB) {
        throw new StepError({ kind: "memory", availableMb: available, neededMb: MIN_AVAILABLE_MB }, `Not enough free memory (${available} MB available, ${MIN_AVAILABLE_MB} needed)`);
      }
    };
    /* A refused admission or a failed switch puts the previous release back
       while the candidate's directory stays. The same target then needs its
       pointer again, never another install and build. */
    const reusable = async () => this.ports.builtRevision?.(release) === target && this.ports.buildIdReadable(release)
      && (await this.ports.revParse("HEAD", release)).trim() === target;
    switch (name) {
      case "fetch": {
        const code = await command(["git", "fetch", "--no-tags", remote, `+refs/heads/${branch}:${TIP_REF}`], checkout);
        const fetched = (await this.ports.revParse(TIP_REF, checkout)).trim();
        if (fetched !== target) {
          // Automatic admission freezes a green revision while its original
          // cohort finishes. Later merges may advance main without invalidating
          // that revision. Verify it is still on main before building it;
          // manual updates retain the exact-tip check and rewrites fail closed.
          const ancestry = ["git", "merge-base", "--is-ancestor", target, fetched];
          const ancestor = (this.state.trigger === "auto" || this.state.trigger === "seat")
            && await this.ports.run(ancestry, { cwd: checkout, env, onLine: (line) => push(line), lowPriority: true }) === 0;
          if (!ancestor) {
            throw new StepError({ kind: "remote-moved", expected: shortSha(target), fetched: shortSha(fetched) }, `The remote moved since the last check (${shortSha(target)} → ${shortSha(fetched)}). Check again.`);
          }
          push(`main advanced to ${shortSha(fetched)}; building its validated ancestor ${shortSha(target)}`, false);
        }
        return code;
      }
      case "checkout":
        /* A directory an earlier attempt at this target left is reused. */
        if (this.ports.exists(release)) {
          const refusal = await (this.ports.prepareExistingRelease ?? prepareExistingRelease)(release);
          if (refusal) { push(refusal, false); throw new CommandFailure(1); }
          return command(["git", "checkout", "--detach", target], release);
        }
        return command(["git", "worktree", "add", "--detach", release, target], checkout);
      case "install":
        if (await reusable()) { push(`${shortSha(target)} is already built in ${release}; its dependencies are kept`, false); return null; }
        guardMemory();
        return command([bun, "install", "--frozen-lockfile"], release, "update-install");
      case "build":
        if (await reusable()) { push(`${shortSha(target)} is already built in ${release}; the build is reused`, false); return null; }
        guardMemory();
        this.ports.markBuilt?.(release, null);
        return command([bun, "run", "build"], release, "update-build");
      case "ready": {
        const head = (await this.ports.revParse("HEAD", release)).trim();
        if (head !== target) throw new StepError({ kind: "head-mismatch", head: shortSha(head), expected: shortSha(target) }, `HEAD is ${shortSha(head)}, expected ${shortSha(target)}`);
        if (!this.ports.buildIdReadable(release)) throw new StepError({ kind: "build-id-missing" }, ".next/BUILD_ID is missing after the build");
        this.ports.markBuilt?.(release, target);
        await this.ports.publish({ sha: target, dir: release });
        push(`${shortSha(target)} is built in ${release}; the next restart runs it`, false);
        return null;
      }
    }
  }
}

/** The real ports. Output from stdout and stderr is split into lines as it
    arrives, so a build streams into the surface while it runs. Each command
    leads its own process group, recorded by PID, so abort() stops the command
    this runner started and nothing else. */
export interface RealPorts extends StepPorts { abort(): Promise<void> }

export function realPorts(publish: (release: Release) => void | Promise<void>,
  cpu: { pressure?: () => Pick<CpuPressureGate, "check"> | null; pollMs?: number } = {}): RealPorts {
  let current: RecordedPid | null = null;
  let completion: { ended: boolean; code: number | null } | null = null;
  let waiting: AbortController | null = null;
  let currentExit: Promise<number | null> | null = null;
  let currentScope: string | null = null;
  return {
    async run(command, { cwd, env, onLine, lowPriority, work }) {
      const releaseWork = work === "update-install" || work === "update-build";
      let scope: string | null = null;
      mkdirSync(env.TMPDIR ?? cwd, { recursive: true });
      if (work) {
        // Release preparation has immediate admission and its own high-weight
        // scope. Other heavy steps retain pressure admission and work quotas.
        // A missing CPU mechanism refuses before any command starts.
        const wrapped = releaseWork
          ? wrapReleaseCommand(command[0]!, command.slice(1), work)
          : { ...wrapWorkCommand(command[0]!, command.slice(1), { label: work }), unit: null };
        scope = wrapped.unit;
        command = [wrapped.command, ...wrapped.args];
        waiting = new AbortController();
        try {
          if (!releaseWork && !await waitForCpuPressure((cpu.pressure ?? machineCpuPressureGate)(), { subject: work, onReason: onLine, signal: waiting.signal, ...(cpu.pollMs ? { pollMs: cpu.pollMs } : {}) })) return 143;
        } finally { waiting = null; }
      }
      const child = spawn(command[0]!, command.slice(1), { cwd, env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      /* Detached so abort() can end its group; recorded so that group also
         ends with the Viewer generation running this update. */
      recordHelperGroup("self-update-step", child);
      const result = { ended: false, code: null as number | null };
      completion = result;
      const exited = new Promise<number | null>((resolve) => {
        const finish = (code: number | null) => {
          if (result.ended) return;
          result.ended = true;
          result.code = code;
          resolve(code);
        };
        child.once("error", (error) => { onLine(error.message); finish(127); });
        child.once("exit", (code) => finish(code));
        child.once("close", (code) => finish(code));
      });
      currentExit = exited;
      currentScope = scope;
      const identity = child.pid ? readStartIdentity(child.pid) : null;
      current = child.pid && identity ? { pid: child.pid, startIdentity: identity } : null;
      if (lowPriority && !releaseWork && child.pid) {
        try { setPriority(child.pid, 10); } catch { /* best effort; never fail the update for scheduling */ }
      }
      try {
        await Promise.all([pumpLines(child.stdout, onLine), pumpLines(child.stderr, onLine)]);
        const code = await exited;
        if (code === null) throw new StepError({ kind: "interrupted" }, "child process ended without an exit status");
        return code;
      } finally {
        if (completion === result) {
          current = null;
          completion = null;
          currentExit = null;
          currentScope = null;
        }
      }
    },
    async abort() {
      waiting?.abort();
      const owned = current;
      const exited = currentExit;
      const scope = currentScope;
      if (scope) { await stopReleaseScope(scope); return; }
      if (!owned || !exited) return;
      signalGroup(owned, "SIGTERM");
      const wait = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2_000); })]); }
        finally { if (timer) clearTimeout(timer); }
      };
      await wait();
      // Re-read the recorded process identity at the kill dispatch. A retry
      // may already own current, so never signal through that mutable field.
      if (sameProcess(owned)) { signalGroup(owned, "SIGKILL"); await wait(); }
      if (sameProcess(owned)) throw new Error("The timed-out update child survived cleanup");
    },
    childAlive() {
      if (waiting) return true;
      if (completion === null) return true;
      if (completion.ended) return completion.code !== null;
      // Missing-PID polls carry no exit status, however often they run.
      // Wait for exit/close; the deadline bounds an unreported completion.
      return !current || sameProcess(current) ? true : null;
    },
    memAvailableMb,
    async revParse(ref, cwd) {
      return (await runGit(["rev-parse", "--verify", "--quiet", ref], cwd)).stdout.trim();
    },
    exists: (path) => existsSync(path),
    buildIdReadable: (dir) => existsSync(join(dir, ".next", "BUILD_ID")),
    builtRevision,
    markBuilt: (dir, sha) => {
      if (sha === null) rmSync(join(dir, BUILT_MARKER), { force: true });
      else writeFileSync(join(dir, BUILT_MARKER), `${sha}\n`);
    },
    publish,
    now: () => Date.now(),
    cpuLoad: () => ({ load1: loadavg()[0]!, cpus: cpus().length }),
  };
}

export function memAvailableMb(): number {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return match ? Number(match[1]) / 1024 : 0;
  } catch {
    return 0;
  }
}

/** Carriage returns (progress bars) end a line too, so the tail shows the
    latest progress state instead of one ever-growing line. */
export async function pumpLines(stream: AsyncIterable<Uint8Array | string> | null, onLine: (line: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const parts = buffer.split(/\r?\n|\r/);
    buffer = parts.pop() ?? "";
    for (const part of parts) onLine(stripAnsi(part));
  }
  buffer += decoder.decode();
  if (buffer) onLine(stripAnsi(buffer));
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Deployment records retain phase and cause, including older saved failures. */
export function updateFailureDetail(state: UpdateState | undefined): string {
  const step = state?.steps.find(step => step.state === "failed");
  if (!step) return "Release preparation failed: no completed runner result";
  const cause = step.failure ? stepFailureDetail(step.failure) : "no exit status";
  return `Release ${step.name} failed: ${cause}`;
}

function stepFailureDetail(failure: StepFailure): string {
  switch (failure.kind) {
    case "timeout": return `timeout after ${Number(failure.minutes.toFixed(2))} minutes${failure.reason === "silence" ? ` (${failure.idleMinutes} minutes without output)` : failure.reason === "total" ? " (total deadline)" : ""}${failure.load1 === undefined ? "" : `; load avg1 ${failure.load1.toFixed(2)} on ${failure.cpus} CPUs`}`;
    case "exit": return `exit ${failure.code}`;
    case "error": return failure.text;
    case "memory": return `only ${failure.availableMb} MB available; ${failure.neededMb} MB required`;
    case "remote-moved": return `remote moved from ${failure.expected} to ${failure.fetched}`;
    case "head-mismatch": return `HEAD ${failure.head}, expected ${failure.expected}`;
    case "build-id-missing": return "missing .next/BUILD_ID";
    case "interrupted": return "child interrupted without an exit status";
    case "deployment-lost": return "deployment ownership lost";
  }
}

/** The generated unit remains ours while descendants outlive their leader. */
async function stopReleaseScope(unit: string): Promise<void> {
  const control = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
  try { await control(["stop", unit]); }
  catch (error) {
    // --collect can remove an empty scope between the command exit and stop.
    if (await control(["show", unit, "--property=LoadState", "--value"]).catch(() => "unknown") !== "not-found") throw error;
  }
}
