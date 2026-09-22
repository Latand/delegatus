/* The two managed processes. A managed process is one this prototype (or the
   bench, in the same record format) started itself: its PID and /proc start
   identity are recorded at spawn, and a stop signals only that recorded
   process group. Nothing here finds a process any other way. */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import type { ProcessStatus } from "./state";
import { stoppedProcess } from "./state";

export type Role = "web" | "runtime-host";

export interface ProcessRecord {
  role: Role;
  pid: number;
  startIdentity: string;
  startedAt: string;
  port: number | null;
  socket: string | null;
  revision?: string | null;
}

/* Port-0 allocation, the same shape as ephemeralPort() in
   src/runtime-host/hostRehearsalRun.ts (repeated: the prototype imports
   nothing from src/). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port assigned"));
      server.close(() => resolve(address.port));
    });
  });
}

/* Whether 127.0.0.1:<port> can be bound right now. A readiness probe on a port
   someone else holds would be answered by them, so a held port fails the start
   before anything is spawned. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function statFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    /* The command name may hold spaces and parentheses; fields resume after the last ")". */
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/* Field 22 of /proc/<pid>/stat: the start time in clock ticks. A PID reused
   after an exit carries a different value. */
export function readStartIdentity(pid: number): string | null {
  return statFields(pid)?.[19] ?? null;
}

/* Alive means present and not a zombie. */
export function isAlive(pid: number): boolean {
  const state = statFields(pid)?.[0];
  return state !== undefined && state !== "Z" && state !== "X";
}

export function sameProcess(record: Pick<ProcessRecord, "pid" | "startIdentity">): boolean {
  return isAlive(record.pid) && readStartIdentity(record.pid) === record.startIdentity;
}

/* processes.json: one record per role, replaced atomically. */
export class ProcessRegistry {
  constructor(readonly file: string) {}

  read(): Partial<Record<Role, ProcessRecord>> {
    try { return JSON.parse(readFileSync(this.file, "utf8")) as Partial<Record<Role, ProcessRecord>>; }
    catch { return {}; }
  }

  get(role: Role): ProcessRecord | null {
    return this.read()[role] ?? null;
  }

  write(role: Role, record: ProcessRecord | null): void {
    const all = this.read();
    if (record) all[role] = record;
    else delete all[role];
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(temp, this.file);
  }
}

export interface ProcessSpec {
  role: Role;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  port: number | null;
  socket: string | null;
  /* Readiness and health: resolves when the process answers as itself. */
  probe(pid: number): Promise<void>;
  readyBudgetMs: number;
  readyPollMs: number;
  readyTimeout: string;
  stopGraceMs?: number;
  killGraceMs?: number;
  logFile?: string;
  /* Short SHA the checkout is at, recorded with the PID. */
  revision?: () => string | null;
}

const RING_LINES = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seconds(ms: number): string {
  return ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
}

export class ManagedProcess {
  status: ProcessStatus = stoppedProcess();
  private exit: { code: number | null; signal: string | null; at: number } | null = null;
  private busy = false;
  private readonly logFile: string;

  constructor(
    readonly spec: ProcessSpec,
    private readonly registry: ProcessRegistry,
    private readonly onChange: () => void,
  ) {
    this.logFile = spec.logFile ?? `${registry.file}-${spec.role}.log`;
  }

  private set(change: Partial<ProcessStatus>): void {
    this.status = { ...this.status, ...change };
    this.onChange();
  }

  lines(): string[] {
    try {
      const text = readFileSync(this.logFile, "utf8");
      return text.split(/\r?\n|\r/).filter((line) => line.length > 0).slice(-RING_LINES);
    } catch {
      return [];
    }
  }

  /* Takes over a record left by an earlier run of the prototype (or by the
     bench). A record whose PID no longer carries the recorded start identity
     belongs to nobody we know: it is dropped and nothing is signalled. */
  adopt(): void {
    const record = this.registry.get(this.spec.role);
    if (!record) { this.status = stoppedProcess(); return; }
    if (!sameProcess(record)) {
      this.registry.write(this.spec.role, null);
      this.status = stoppedProcess();
      this.onChange();
      return;
    }
    this.status = {
      ...stoppedProcess(),
      state: "starting",
      pid: record.pid,
      port: record.port,
      socket: record.socket,
      startedAt: record.startedAt,
      revision: record.revision ?? null,
    };
    this.onChange();
  }

  async start(): Promise<void> {
    this.busy = true;
    try { await this.startInner(); }
    finally { this.busy = false; }
  }

  async restart(): Promise<void> {
    this.busy = true;
    try {
      await this.stopInner();
      await this.startInner();
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    this.busy = true;
    try { await this.stopInner(); }
    finally { this.busy = false; }
  }

  private async startInner(): Promise<void> {
    const { spec } = this;
    if (spec.port !== null && !await portFree(spec.port)) {
      this.set({ ...stoppedProcess(), state: "failed", port: spec.port, error: `Port ${spec.port} is in use` });
      return;
    }
    mkdirSync(dirname(this.logFile), { recursive: true });
    const fd = openSync(this.logFile, "w");
    let child: ChildProcess;
    try {
      child = spawn(spec.command[0]!, spec.command.slice(1), {
        cwd: spec.cwd,
        env: spec.env as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    /* The process outlives whoever started it (the bench exits, the prototype
       restarts and adopts it by its record). */
    child.unref();
    const startedAt = Date.now();
    this.exit = null;
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (error) => resolve(error));
    });
    if (spawnError || !child.pid) {
      this.set({ ...stoppedProcess(), state: "failed", error: `Could not start: ${spawnError?.message ?? "no PID"}` });
      return;
    }
    const pid = child.pid;
    const record: ProcessRecord = {
      role: spec.role,
      pid,
      startIdentity: readStartIdentity(pid) ?? "",
      startedAt: new Date(startedAt).toISOString(),
      port: spec.port,
      socket: spec.socket,
      revision: spec.revision?.() ?? null,
    };
    this.registry.write(spec.role, record);
    child.once("exit", (code, signal) => {
      this.exit = { code, signal, at: Date.now() };
      if (this.registry.get(spec.role)?.pid === pid) this.registry.write(spec.role, null);
      if (!this.busy && this.status.pid === pid) {
        this.set({ state: "failed", pid: null, error: this.exitMessage(startedAt), lastHealthOk: false });
      }
    });
    this.set({
      ...stoppedProcess(),
      state: "starting",
      pid,
      port: spec.port,
      socket: spec.socket,
      startedAt: record.startedAt,
      revision: record.revision ?? null,
    });

    const deadline = startedAt + spec.readyBudgetMs;
    while (Date.now() < deadline) {
      if (this.exit) {
        this.set({ state: "failed", pid: null, error: this.exitMessage(startedAt) });
        return;
      }
      try {
        await spec.probe(pid);
        this.set({ state: "healthy", error: null, lastHealthAt: new Date().toISOString(), lastHealthOk: true });
        return;
      } catch {
        await sleep(spec.readyPollMs);
      }
    }
    if (this.exit) this.set({ state: "failed", pid: null, error: this.exitMessage(startedAt) });
    else this.set({ state: "failed", error: spec.readyTimeout, lastHealthOk: false });
  }

  private exitMessage(startedAt: number): string {
    const lines = this.lines();
    if (this.spec.port !== null && lines.some((line) => /EADDRINUSE|address already in use/i.test(line))) {
      return `Port ${this.spec.port} is in use`;
    }
    const exit = this.exit;
    const after = seconds((exit?.at ?? Date.now()) - startedAt);
    if (exit?.signal) return `Stopped by ${exit.signal} after ${after} s`;
    return `Exited with code ${exit?.code ?? "unknown"} after ${after} s`;
  }

  private async waitGone(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await sleep(50);
    }
    return !isAlive(pid);
  }

  /* Stop is by recorded PID only: re-read the record, verify the start
     identity, SIGTERM the group the PID leads, SIGKILL it after the grace. */
  private async stopInner(): Promise<void> {
    const record = this.registry.get(this.spec.role);
    if (!record) {
      this.set({ ...stoppedProcess() });
      return;
    }
    if (!sameProcess(record)) {
      this.registry.write(this.spec.role, null);
      this.set({ ...stoppedProcess() });
      return;
    }
    const { pid } = record;
    this.set({ state: "stopping", pid, error: null });
    signalGroup(record, "SIGTERM");
    if (!await this.waitGone(pid, this.spec.stopGraceMs ?? 10_000)) {
      signalGroup(record, "SIGKILL");
      await this.waitGone(pid, this.spec.killGraceMs ?? 2_000);
    }
    if (this.registry.get(this.spec.role)?.pid === pid) this.registry.write(this.spec.role, null);
    this.set({ ...stoppedProcess() });
  }

  async checkHealth(timeoutMs = 5_000): Promise<void> {
    if (this.busy || this.status.pid === null) return;
    const pid = this.status.pid;
    const record = this.registry.get(this.spec.role);
    if (!record || record.pid !== pid || !sameProcess(record)) {
      if (record?.pid === pid) this.registry.write(this.spec.role, null);
      this.set({ state: "failed", pid: null, error: `PID ${pid} is no longer running`, lastHealthAt: new Date().toISOString(), lastHealthOk: false });
      return;
    }
    try {
      await Promise.race([
        this.spec.probe(pid),
        sleep(timeoutMs).then(() => { throw new Error(`No answer within ${seconds(timeoutMs)} s`); }),
      ]);
      if (this.busy || this.status.pid !== pid) return;
      this.set({ state: "healthy", error: null, lastHealthAt: new Date().toISOString(), lastHealthOk: true });
    } catch (error) {
      if (this.busy || this.status.pid !== pid) return;
      this.set({ state: "failed", error: error instanceof Error ? error.message : String(error), lastHealthAt: new Date().toISOString(), lastHealthOk: false });
    }
  }
}

/* Signals the process group a recorded PID leads, after checking once more
   that the PID is still the process that was recorded. */
export function signalGroup(record: Pick<ProcessRecord, "pid" | "startIdentity">, signal: NodeJS.Signals): boolean {
  if (!sameProcess(record)) return false;
  try {
    process.kill(-record.pid, signal);
    return true;
  } catch {
    try { process.kill(record.pid, signal); return true; } catch { return false; }
  }
}

/* Web readiness and health: GET / answers 200. */
export function webProbe(port: number, timeoutMs = 5_000): (pid: number) => Promise<void> {
  return async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await response.body?.cancel();
    if (response.status !== 200) throw new Error(`GET / answered ${response.status}`);
  };
}

/* Runtime-host readiness and health, as bin/cli.mjs waitForRuntimeHost checks
   it: the fence file names the recorded PID, and the socket answers one
   newline-framed runtime-host-health request with ok:true for that PID. */
export function runtimeHostProbe(socket: string, fence: string, timeoutMs = 5_000): (pid: number) => Promise<void> {
  return async (pid) => {
    let owner: { pid?: unknown } | null = null;
    try { owner = JSON.parse(readFileSync(fence, "utf8")) as { pid?: unknown }; } catch { /* not yet written */ }
    if (owner?.pid !== pid) throw new Error(owner ? `Fence is held by PID ${String(owner.pid)}` : "Fence not written yet");
    if (!existsSync(socket)) throw new Error("Socket not created yet");
    const reply = await socketRequest(socket, { id: `self-update-${Date.now()}`, method: "runtime-host-health", params: {} }, timeoutMs);
    const parsed = JSON.parse(reply) as { ok?: boolean; result?: { pid?: number }; error?: unknown };
    if (parsed.ok !== true) throw new Error(`runtime-host-health refused: ${JSON.stringify(parsed.error ?? parsed).slice(0, 200)}`);
    if (parsed.result?.pid !== pid) throw new Error(`runtime-host-health answered for PID ${String(parsed.result?.pid)}`);
  };
}

function socketRequest(path: string, request: unknown, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Socket did not answer in time")); }, timeoutMs);
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.end();
      resolve(buffer.slice(0, newline));
    });
  });
}
