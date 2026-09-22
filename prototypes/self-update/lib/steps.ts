/* The five update steps, run one after another, stopping at the first failure.
   The target is checked out into its own release directory (a git worktree of
   the checkout) and installed and built there; the directory the running
   processes serve from is never written. Only a ready build is published as
   the installed release, which the next restart runs. The runner never starts
   or stops a process. Commands go through an injected port so tests stub
   them. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { TIP_REF } from "./git";
import { readStartIdentity, signalGroup } from "./processes";
import { releaseDirFor, type Release } from "./release";
import { idleUpdate, pendingSteps, STEP_NAMES, type Step, type StepName, type UpdateState } from "./state";

export { STEP_NAMES, type StepName };

export const TAIL_LINES = 40;
export const MIN_AVAILABLE_MB = 4_096;

export interface RunOptions { cwd: string; env: Record<string, string>; onLine(line: string): void }

export interface StepPorts {
  /* Runs a command to completion and answers its exit code. */
  run(command: string[], options: RunOptions): Promise<number>;
  memAvailableMb(): number;
  revParse(ref: string, cwd: string): Promise<string>;
  exists(path: string): boolean;
  buildIdReadable(dir: string): boolean;
  /* Makes a ready build the installed release. */
  publish(release: Release): void;
  now(): number;
}

export interface RunnerConfig {
  checkout: string;
  remote: string;
  branch: string;
  bun: string;
  logDir: string;
  releasesDir: string;
  env: Record<string, string>;
}

/* A command that exited non-zero; its output is already in the log. */
class StepFailure extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

export class UpdateRunner {
  state: UpdateState = idleUpdate();

  constructor(
    private readonly config: RunnerConfig,
    private readonly ports: StepPorts,
    private readonly onChange: () => void,
  ) {}

  logPath(step: StepName): string {
    return join(this.config.logDir, `${step}.log`);
  }

  async start(target: string, meta: { short?: string; version?: string } = {}): Promise<void> {
    if (this.state.state === "running") throw new Error("an update is already running");
    this.state = {
      ...idleUpdate(),
      state: "running",
      target,
      targetShort: meta.short ?? target.slice(0, 7),
      targetVersion: meta.version ?? null,
      releaseDir: releaseDirFor(this.config.releasesDir, target),
      steps: pendingSteps(),
      startedAt: this.iso(),
    };
    this.onChange();
    await this.runFrom(0);
  }

  async retry(): Promise<void> {
    if (this.state.state !== "failed" || !this.state.target) throw new Error("update is not failed");
    const from = this.state.steps.findIndex((step) => step.state === "failed");
    this.state = {
      ...this.state,
      state: "running",
      finishedAt: null,
      steps: this.state.steps.map((step, index) => index >= from ? { ...pendingSteps()[index]! } : step),
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
    for (let index = from; index < STEP_NAMES.length; index += 1) {
      const name = STEP_NAMES[index]!;
      const started = this.ports.now();
      this.patch(index, { state: "running", startedAt: this.iso(), durationMs: null, exitCode: null, tail: [] });
      const fd = openSync(this.logPath(name), "w");
      const tail: string[] = [];
      const push = (line: string, toTail = true) => {
        writeSync(fd, `${line}\n`);
        if (!toTail) return;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        this.patch(index, { tail: tail.slice() });
      };
      let exitCode: number | null = null;
      let ok = false;
      try {
        exitCode = await this.runStep(name, push);
        ok = true;
      } catch (error) {
        if (error instanceof StepFailure) exitCode = error.code;
        else push(error instanceof Error ? error.message : String(error));
      } finally {
        closeSync(fd);
      }
      this.patch(index, {
        state: ok ? "done" : "failed",
        durationMs: this.ports.now() - started,
        exitCode,
        tail: tail.slice(),
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

  /* Answers the exit code of a command step (null for the check-only step). A
     StepFailure means the command's own output explains it; any other error's
     message is pushed as the step's last line. */
  private async runStep(name: StepName, push: (line: string, toTail?: boolean) => void): Promise<number | null> {
    const { checkout, remote, branch, bun, env } = this.config;
    const target = this.state.target!;
    const release = this.state.releaseDir!;
    const command = async (argv: string[], cwd: string): Promise<number> => {
      push(`$ ${argv.join(" ")}   (in ${cwd})`, false);
      const code = await this.ports.run(argv, { cwd, env, onLine: (line) => push(line) });
      push(`exit ${code}`, false);
      if (code !== 0) throw new StepFailure(code);
      return code;
    };
    const guardMemory = () => {
      const available = Math.floor(this.ports.memAvailableMb());
      if (available < MIN_AVAILABLE_MB) throw new Error(`Not enough free memory (${available} MB available, ${MIN_AVAILABLE_MB} needed)`);
    };
    switch (name) {
      case "fetch": {
        const code = await command(["git", "fetch", "--no-tags", remote, `+refs/heads/${branch}:${TIP_REF}`], checkout);
        const fetched = (await this.ports.revParse(TIP_REF, checkout)).trim();
        if (fetched !== target) throw new Error("The remote moved since the last check. Check again.");
        return code;
      }
      case "checkout":
        /* A directory an earlier attempt at this target left is reused. */
        if (this.ports.exists(release)) return command(["git", "checkout", "--detach", target], release);
        return command(["git", "worktree", "add", "--detach", release, target], checkout);
      case "install":
        guardMemory();
        return command([bun, "install", "--frozen-lockfile"], release);
      case "build":
        guardMemory();
        return command([bun, "run", "build"], release);
      case "ready": {
        const head = (await this.ports.revParse("HEAD", release)).trim();
        if (head !== target) throw new Error(`HEAD is ${head.slice(0, 7)}, expected ${target.slice(0, 7)}`);
        if (!this.ports.buildIdReadable(release)) throw new Error(".next/BUILD_ID is missing after the build");
        this.ports.publish({ sha: target, dir: release });
        push(`${target.slice(0, 7)} is built in ${release}; the next restart runs it`);
        return null;
      }
    }
  }
}

/* The real ports. Output from stdout and stderr is split into lines as it
   arrives, so a Next build streams into the page while it runs. Each command
   leads its own process group, recorded by PID, so abort() can stop the build
   this runner started and nothing else. */
export interface RealPorts extends StepPorts { abort(): void }

export function realPorts(publish: (release: Release) => void): RealPorts {
  let current: { pid: number; startIdentity: string | null } | null = null;
  return {
    async run(command, { cwd, env, onLine }) {
      const child = spawn(command[0]!, command.slice(1), { cwd, env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise<number>((resolve) => {
        child.once("error", (error) => { onLine(error.message); resolve(127); });
        child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      });
      if (child.pid) current = { pid: child.pid, startIdentity: readStartIdentity(child.pid) };
      try {
        await Promise.all([
          pumpLines(child.stdout!, onLine),
          pumpLines(child.stderr!, onLine),
        ]);
        return await exited;
      } finally {
        current = null;
      }
    },
    abort() {
      if (!current || current.startIdentity === null) return;
      signalGroup({ pid: current.pid, startIdentity: current.startIdentity }, "SIGTERM");
    },
    memAvailableMb,
    async revParse(ref, cwd) {
      const child = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, stdout: "pipe", stderr: "ignore" });
      const out = await new Response(child.stdout).text();
      await child.exited;
      return out.trim();
    },
    exists: (path) => existsSync(path),
    buildIdReadable: (dir) => existsSync(join(dir, ".next", "BUILD_ID")),
    publish,
    now: () => Date.now(),
  };
}

export function memAvailableMb(): number {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
  return match ? Number(match[1]) / 1024 : 0;
}

/* Carriage returns (progress bars) end a line too, so the tail shows the latest
   progress state instead of one ever-growing line. */
export async function pumpLines(stream: AsyncIterable<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
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
