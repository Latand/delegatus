import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { procBackend } from "@/lib/proc";
import { linuxBackend } from "@/lib/proc/linux";
import { descendantPids, parsePsMemory } from "@/lib/proc/memory";

import { GIB, type AgentMemoryKill, type HostMemoryState } from "./agentMemoryState";
import { cpuScopeProperties, invalidateCpuContainmentProbe, type AgentCpuPlan } from "./cpuPlacement";
export { GIB, normalizeHostMemory, memoryKillText, type AgentMemoryKill, type HostMemoryState } from "./agentMemoryState";
export type MemoryMode = "auto" | "scope" | "watchdog" | "off";
export type MemoryRunner = (command: string, args: string[]) => string;
const run: MemoryRunner = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"] });
function read(file: string): string { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
const diagnostics = new Set<string>();
function diagnostic(key: string, message: string) { if (!diagnostics.has(key)) { diagnostics.add(key); console.warn(`[delegatus] ${message}`); } }

export function parseMemorySize(value: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const bytes = Number(match[1]) * 1024 ** (match[2] ? "KMGT".indexOf(match[2].toUpperCase()) + 1 : 0);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}
export function agentMemoryCeiling(totalBytes: number, liveAgents: number, env: Readonly<Record<string, string | undefined>> = {}) {
  const reserveBytes = parseMemorySize(env.LLV_AGENT_MEMORY_RESERVE) ?? Math.max(4 * GIB, Math.ceil(totalBytes * .15 / GIB) * GIB);
  const budgetBytes = Math.max(GIB, totalBytes - reserveBytes);
  const lo = Math.min(4 * GIB, budgetBytes);
  const requested = parseMemorySize(env.LLV_AGENT_MEMORY_MAX);
  const limitBytes = requested === null
    ? Math.max(lo, Math.min(Math.max(budgetBytes / 2, lo), Math.floor(2 * budgetBytes / Math.max(1, liveAgents) / (GIB / 2)) * (GIB / 2)))
    : Math.min(budgetBytes, requested);
  return { reserveBytes, budgetBytes, limitBytes };
}
export function viewerUnitFromCgroup(text: string): string | null {
  const entry = text.split("\n").find((line) => line.startsWith("0::"));
  if (!entry || !/\/user@\d+\.service\//.test(entry)) return null;
  const unit = entry.slice(3).split("/").pop()!;
  return /^(?:[a-zA-Z0-9_:@.-]|\\x[0-9a-fA-F]{2})+\.service$/.test(unit) ? unit : null;
}
export function agentOomScore(viewerScore: number): number { return Math.min(1000, Math.max(500, viewerScore + 300)); }
export interface AgentMemoryPlan {
  /** `none`: memory mode off or unmeasurable, kept only to carry a CPU scope. */
  mechanism: "scope" | "watchdog" | "none";
  mode?: MemoryMode;
  platform: NodeJS.Platform;
  limitBytes: number;
  budgetBytes: number;
  reserveBytes: number;
  totalBytes: number;
  score: number;
  unit: string | null;
  /** The memory budget slice; a CPU plan may place the scope below it. */
  slice: string;
  viewerUnit: string | null;
  systemdVersion: number;
  cpu?: AgentCpuPlan | null;
}
export function wrapAgentCommand(plan: AgentMemoryPlan | null, command: string, args: string[]): { command: string; args: string[] } {
  if (!plan) return { command, args };
  const scored = plan.platform === "linux" && plan.mechanism !== "none"
    ? ["/bin/sh", "-c", `echo ${plan.score} >/proc/self/oom_score_adj 2>/dev/null; exec "$@"`, "delegatus-agent", command, ...args]
    : [command, ...args];
  if (plan.mechanism !== "scope" && !plan.cpu) return { command: scored[0], args: scored.slice(1) };
  const systemdVersion = Math.min(plan.systemdVersion, plan.cpu?.systemdVersion ?? Infinity);
  return { command: "systemd-run", args: ["--user", "--scope", "--quiet", "--collect",
    ...(systemdVersion >= 254 ? ["--expand-environment=no"] : []),
    `--unit=${plan.unit}`, `--slice=${plan.cpu?.slice ?? plan.slice}`, "--description=Delegatus agent",
    ...(plan.mechanism === "scope" ? ["-p", `MemoryMax=${plan.limitBytes}`, "-p", "MemorySwapMax=0", "-p", "OOMPolicy=continue"] : []),
    ...(plan.cpu ? cpuScopeProperties(plan.cpu) : []),
    ...(plan.viewerUnit ? ["-p", `BindsTo=${plan.viewerUnit}`, "-p", `After=${plan.viewerUnit}`] : []), "--", ...scored] };
}
export function probeAgentScopes(options: { platform: NodeJS.Platform; cgroupRoot: string; uid: number; runner: MemoryRunner; docker: boolean; slice?: string }): number | null {
  if (options.platform !== "linux" || options.docker || !fs.existsSync(path.join(options.cgroupRoot, "cgroup.controllers"))) return null;
  const delegated = read(path.join(options.cgroupRoot, `user.slice/user-${options.uid}.slice/user@${options.uid}.service/cgroup.controllers`));
  if (!delegated.split(/\s+/).includes("memory")) return null;
  try {
    const version = Number(/systemd\s+(\d+)/.exec(options.runner("systemd-run", ["--version"]))?.[1]);
    if (!(version >= 253)) return null;
    options.runner("systemd-run", ["--user", "--scope", "--quiet", "--collect", ...(version >= 254 ? ["--expand-environment=no"] : []),
      `--slice=${options.slice ?? "delegatus-agents.slice"}`, "-p", "MemoryMax=64M", "-p", "MemorySwapMax=0", "-p", "OOMPolicy=continue", "--", "true"]);
    return version;
  } catch { return null; }
}
let cachedMechanism: { mechanism: "scope" | "watchdog"; version: number } | null = null;
let sliceConfigured = false;
export function invalidateAgentScopeProbe(): void { cachedMechanism = null; sliceConfigured = false; }
/** The unit name every agent scope carries; HostMemoryState validates it. */
function agentScopeUnit(engine: string, sessionKey: string): string {
  return `delegatus-agent-${engine}-${createHash("sha256").update(sessionKey + randomUUID()).digest("hex").slice(0,12)}.scope`;
}
/** A scope that carries only CPU placement: memory is off or cannot be measured. */
function cpuOnlyPlan(input: { engine: string; sessionKey: string; cpu?: AgentCpuPlan | null }, mode: MemoryMode, totalBytes = 0): AgentMemoryPlan | null {
  if (!input.cpu) return null;
  return { mechanism: "none", mode, platform: process.platform, limitBytes: 0, budgetBytes: 0, reserveBytes: 0, totalBytes, score: 0,
    unit: agentScopeUnit(input.engine, input.sessionKey), slice: "delegatus-agents.slice", viewerUnit: viewerUnitFromCgroup(read("/proc/self/cgroup")),
    systemdVersion: input.cpu.systemdVersion, cpu: input.cpu };
}
/** `input.cpu` comes from planAgentCpu; CPU placement is independent of the memory mode. */
export function planAgentMemory(input: { engine: string; sessionKey: string; liveAgents: number; cpu?: AgentCpuPlan | null }, env = process.env, ports: { totalBytes?: number; probe?: () => number | null; runner?: MemoryRunner } = {}): AgentMemoryPlan | null {
  const raw = env.DELEGATUS_AGENT_MEMORY ?? env.LLV_AGENT_MEMORY ?? "auto";
  const mode: MemoryMode = ["auto", "scope", "watchdog", "off"].includes(raw) ? raw as MemoryMode : "auto";
  if (raw !== mode) diagnostic("mode", "Invalid agent memory mode; using auto.");
  if (process.platform === "win32") return null;
  if (mode === "off") return cpuOnlyPlan(input, mode);
  const config = { LLV_AGENT_MEMORY_MAX: env.DELEGATUS_AGENT_MEMORY_MAX ?? env.LLV_AGENT_MEMORY_MAX, LLV_AGENT_MEMORY_RESERVE: env.DELEGATUS_AGENT_MEMORY_RESERVE ?? env.LLV_AGENT_MEMORY_RESERVE };
  for (const [name, value] of Object.entries(config)) if (value !== undefined && parseMemorySize(value) === null) diagnostic(name, `Invalid ${name}; using the default.`);
  const totalBytes = ports.totalBytes ?? procBackend.systemMemory()?.ramTotal;
  if (!totalBytes) { diagnostic("total", "Agent memory limits unavailable: cannot read system memory."); return cpuOnlyPlan(input, mode); }
  if (!cachedMechanism) {
    const version = mode === "watchdog" ? null : ports.probe ? ports.probe() : probeAgentScopes({ platform: process.platform, cgroupRoot: "/sys/fs/cgroup", uid: process.getuid?.() ?? -1, runner: run, docker: fs.existsSync("/.dockerenv") || env.LLV_DOCKER_NSENTER_SHIMS === "1" });
    cachedMechanism = { mechanism: version ? "scope" : "watchdog", version: version ?? 253 };
  }
  const mechanism = mode === "auto" ? cachedMechanism.mechanism : mode;
  const limits = agentMemoryCeiling(totalBytes, input.liveAgents, config);
  const plan: AgentMemoryPlan = { ...limits, totalBytes, mechanism, mode, platform: process.platform,
    score: agentOomScore(Number(read("/proc/self/oom_score_adj")) || 0),
    unit: mechanism === "scope" || input.cpu ? agentScopeUnit(input.engine, input.sessionKey) : null,
    slice: "delegatus-agents.slice", viewerUnit: viewerUnitFromCgroup(read("/proc/self/cgroup")),
    systemdVersion: mechanism === "scope" ? cachedMechanism.version : input.cpu?.systemdVersion ?? cachedMechanism.version, cpu: input.cpu ?? null };
  if (mechanism === "scope" && !sliceConfigured) {
    try { (ports.runner ?? run)("systemctl", ["--user", "set-property", "--runtime", plan.slice, `MemoryMax=${limits.budgetBytes}`]); sliceConfigured = true; }
    catch { diagnostic("slice", "Cannot set the shared agent memory budget; per-agent ceilings still apply."); }
  }
  return plan;
}

function events(file: string, fd?: number | null): { oom: number; kills: number } | null {
  let text = read(file);
  if (fd != null) {
    try { const buffer = Buffer.alloc(4096); text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"); }
    catch { /* The last observed counters survive a removed cgroup. */ }
  }
  const oom = /^oom (\d+)$/m.exec(text), kills = /^oom_kill (\d+)$/m.exec(text);
  return oom && kills ? { oom: Number(oom[1]), kills: Number(kills[1]) } : null;
}
export type MemorySample = { pid: number; identity: string; rss: number; name: string | null };
interface CellPorts {
  cgroupRoot?: string;
  cgroupForPid?: (pid: number) => string | null;
  runner?: MemoryRunner;
  now?: () => number;
  watch?: typeof fs.watch;
  sample?: (pid: number) => MemorySample[];
  identity?: (pid: number) => string | null;
  readPpid?: (pid: number) => number | null;
  kill?: (pid: number) => void;
}
const watchdogCells = new Set<AgentMemoryCell>();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let portableWatchdogPids = new Set<number>();
let portableWatchdogParents = new Map<number, number>();
function linuxTree(root: number): number[] {
  const seen = new Set<number>(), stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    let tids: string[];
    try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch { continue; }
    for (const tid of tids) {
      const file = `/proc/${pid}/task/${tid}/children`;
      if (!fs.existsSync(file)) return descendantPids(root, procBackend.ppidMap());
      stack.push(...read(file).trim().split(/\s+/).map(Number).filter((n) => n > 0));
    }
  }
  return [...seen];
}
/** Re-walk ancestry after discovery; every link must still have its captured start identity. */
function verifiedTreeMember(root: number, pid: number, identities: Map<number, string | null>,
  identity = procBackend.processIdentity, readPpid = linuxBackend.readPpid): boolean {
  const rootIdentity = identities.get(root);
  if (!rootIdentity || identity(root) !== rootIdentity) return false;
  const seen = new Set<number>();
  while (pid !== root) {
    if (seen.has(pid)) return false;
    seen.add(pid);
    const expected = identities.get(pid);
    if (!expected || identity(pid) !== expected) return false;
    const parent = readPpid(pid);
    if (parent === null || identity(pid) !== expected) return false;
    pid = parent;
  }
  return identity(root) === rootIdentity;
}
function sampleTrees(roots: number[], platform: NodeJS.Platform): Map<number, MemorySample[]> {
  const result = new Map<number, MemorySample[]>();
  if (platform === "linux") {
    for (const root of roots) {
      const pids = linuxTree(root);
      const identities = new Map(pids.map((pid) => [pid, procBackend.processIdentity(pid)]));
      const memory = procBackend.processMemory(pids);
      result.set(root, pids.flatMap((pid) => {
        const identity = identities.get(pid), rss = memory.get(pid)?.rssBytes;
        return identity && rss !== undefined && verifiedTreeMember(root, pid, identities) ? [{ pid, identity, rss, name: read(`/proc/${pid}/comm`).trim() || null }] : [];
      }));
    }
  } else {
    // Prior ps candidates let us capture identities before this tick's single ps.
    // New descendants enroll on the next tick; no cached backend ancestry authorizes them.
    const identities = new Map([...new Set([...roots, ...portableWatchdogPids])]
      .map((pid) => [pid, procBackend.processIdentity(pid)]));
    let text: string;
    try { text = run("ps", ["-axo", "pid=,ppid=,rss="]); } catch { return result; }
    const ppids = new Map<number, number>();
    const rows = text.split("\n").flatMap((line) => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line); if (!m) return []; ppids.set(Number(m[1]), Number(m[2])); return [`${m[1]} ${m[3]}`]; });
    const memory = parsePsMemory(rows.join("\n"));
    portableWatchdogParents = ppids;
    portableWatchdogPids = new Set(roots.flatMap((root) => descendantPids(root, ppids)));
    for (const root of roots) result.set(root, descendantPids(root, ppids).flatMap((pid) => {
      const identity = identities.get(pid), rss = memory.get(pid);
      return identity && rss !== undefined && verifiedTreeMember(root, pid, identities, procBackend.processIdentity, (pid) => ppids.get(pid) ?? null)
        ? [{ pid, identity, rss, name: null }] : [];
    }));
  }
  return result;
}
/** One timer samples all trees. The injected samples keep the kill seam testable without touching live PIDs. */
export function tickAgentMemoryWatchdogs(cells: Iterable<AgentMemoryCell> = watchdogCells): void {
  const list = [...cells];
  const samples = new Map<number, MemorySample[]>();
  for (const platform of new Set(list.map((cell) => cell.plan.platform))) {
    const roots = list.filter((cell) => cell.plan.platform === platform && !cell.hasInjectedSample).map((cell) => cell.pid).filter((pid): pid is number => pid !== null);
    if (roots.length) for (const [root, tree] of sampleTrees(roots, platform)) samples.set(root, tree);
  }
  const all: { cell: AgentMemoryCell; sample: MemorySample }[] = [];
  for (const cell of list) {
    const tree = cell.sample(samples);
    all.push(...tree.map((sample) => ({ cell, sample })));
    if (tree.reduce((sum, item) => sum + item.rss, 0) > cell.plan.limitBytes) {
      const victim = [...tree].sort((a,b) => b.rss - a.rss)[0];
      if (victim) cell.killSample(victim, "agent");
    }
  }
  const budget = list[0]?.plan.budgetBytes ?? Infinity;
  // Per-agent cleanup can reap a native process or a whole descendant subtree
  // after this tick's initial samples. Never charge that stale RSS to the
  // shared budget (or let a recycled PID stand in for the old process).
  const survivors = all.filter(({ cell, sample }) => !cell.killedThisTick.has(sample.pid) && cell.ownsCurrentSample(sample));
  if (survivors.reduce((sum, item) => sum + item.sample.rss, 0) > budget) {
    const victim = survivors.sort((a,b) => b.sample.rss - a.sample.rss)[0];
    if (victim) victim.cell.killSample(victim.sample, "shared");
  }
  for (const cell of list) cell.killedThisTick.clear();
}

export class AgentMemoryCell {
  private state: Omit<HostMemoryState, "mechanism"> & { mechanism: AgentMemoryPlan["mechanism"] };
  private readonly listeners = new Set<() => void>();
  private watcher: fs.FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private file: string | null = null;
  private eventsFd: number | null = null;
  private sliceFile: string | null = null;
  private previous = { oom: 0, kills: 0 };
  private sliceOom = 0;
  private ownOomAt = -Infinity;
  private sharedOomAt = -Infinity;
  private exitSettled = false;
  private scopeAdmissionError: string | null = null;
  private lastSample: MemorySample[] = [];
  private rootIdentity: string | null = null;
  private child: ChildProcess | null = null;
  private closed = false;
  private attachTimer: ReturnType<typeof setInterval> | null = null;
  pid: number | null = null;
  readonly killedThisTick = new Set<number>();
  get hasInjectedSample() { return Boolean(this.ports.sample); }
  get fatalMemoryExit(): boolean { return this.exitSettled && this.state.lastKill?.fatal === true; }
  constructor(readonly plan: AgentMemoryPlan, private readonly ports: CellPorts = {}) {
    this.state = { mechanism: plan.mechanism, limitBytes: plan.limitBytes, unit: plan.unit, kills: 0, lastKill: null };
  }
  /** The memory evidence of a memory plan; memoryState() is the host's field. */
  snapshot(): HostMemoryState {
    return { ...this.state, mechanism: this.state.mechanism === "watchdog" ? "watchdog" : "scope", lastKill: this.state.lastKill ? { ...this.state.lastKill } : null };
  }
  /** Null when the scope carries only CPU placement. */
  memoryState(): HostMemoryState | null { return this.state.mechanism === "none" ? null : this.snapshot(); }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify() { for (const listener of this.listeners) listener(); }
  launchFailure(): string | null {
    if (!this.scopeAdmissionError) return null;
    if (this.plan.cpu?.workload === "work") return `CPU containment for agent work is unavailable: ${this.scopeAdmissionError}`;
    return this.plan.mode === "scope" ? this.scopeAdmissionError : "agent memory scope launch failed before exec; retry shortly";
  }
  wrapSpawn(base = (command: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams => spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] })) {
    return (command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
      const wrapped = wrapAgentCommand(this.plan, command, args);
      const child = base(wrapped.command, wrapped.args, options);
      let tail = "";
      child.stderr.on("data", (chunk) => { tail = (tail + String(chunk)).slice(-1024); });
      child.once("close", () => {
        // These pre-exec messages belong to systemd-run, not provider stderr.
        const admission = tail.split("\n").find((line) => /^Failed to (?:create bus (?:connection|message)|connect to (?:(?:user|system) )?bus|start transient scope unit|attach bus to event loop):/.test(line));
        if (this.plan.unit && this.pid === null && admission) {
          this.scopeAdmissionError = admission.trim();
          invalidateAgentScopeProbe();
          if (this.plan.cpu) invalidateCpuContainmentProbe();
        }
      });
      if (child.pid) {
        const pid = child.pid;
        this.attach(pid, child);
        if (this.pid === null) {
          const deadline = Date.now() + 10_000;
          this.attachTimer = setInterval(() => {
            this.attach(pid);
            if (this.pid !== null || Date.now() > deadline) {
              if (this.attachTimer) clearInterval(this.attachTimer);
              this.attachTimer = null;
            }
          }, 10);
          this.attachTimer.unref();
        }
      }
      child.once("error", () => this.close());
      return child;
    };
  }
  attach(pid: number, child?: ChildProcess): void {
    if (this.closed || this.pid !== null) return;
    if (child) {
      this.child = child;
      child.once("exit", () => { this.child = null; });
    }
    this.rootIdentity = (this.ports.identity ?? procBackend.processIdentity)(pid);
    if (this.plan.mechanism === "watchdog") {
      this.pid = pid;
      watchdogCells.add(this);
      if (!watchdogTimer) { watchdogTimer = setInterval(() => tickAgentMemoryWatchdogs(), 2_000); watchdogTimer.unref(); }
      return;
    }
    const group = this.ports.cgroupForPid?.(pid) ?? read(`/proc/${pid}/cgroup`).split("\n").find((line) => line.startsWith("0::"))?.slice(3);
    // Never observe the inherited Viewer cgroup while systemd-run is still entering the scope.
    if (!group || path.basename(group) !== this.plan.unit) return;
    this.pid = pid;
    const root = this.ports.cgroupRoot ?? "/sys/fs/cgroup";
    this.file = path.join(root, group, "memory.events");
    // The shared budget sits on the memory slice, which a work scope's CPU
    // slice nests below.
    const parts = group.split("/");
    const budget = parts.lastIndexOf(this.plan.slice);
    this.sliceFile = path.join(root, budget > 0 ? parts.slice(0, budget + 1).join("/") : path.dirname(group), "memory.events");
    this.sliceOom = events(this.sliceFile)?.oom ?? 0;
    try { this.eventsFd = fs.openSync(this.file, "r"); } catch { /* Poll and watch can still attach when the file appears. */ }
    this.readEvents();
    const poll = () => {
      this.watcher?.close(); this.watcher = null;
      if (!this.poll && !this.closed) { this.poll = setInterval(() => this.readEvents(), 1_000); this.poll.unref(); }
    };
    try {
      this.watcher = (this.ports.watch ?? fs.watch)(this.file, () => this.readEvents());
      this.watcher.on?.("error", poll);
    } catch { poll(); }
  }
  readEvents(): void {
    if (!this.file || this.plan.mechanism === "none") return;
    const current = events(this.file, this.eventsFd);
    if (!current) return;
    const sliceOom = this.sliceFile ? events(this.sliceFile)?.oom ?? this.sliceOom : this.sliceOom;
    const now = (this.ports.now ?? Date.now)();
    if (current.oom > this.previous.oom) this.ownOomAt = now;
    if (sliceOom > this.sliceOom) this.sharedOomAt = now;
    if (current.kills > this.previous.kills) {
      const limit = now - this.ownOomAt <= 10_000 ? "agent" : now - this.sharedOomAt <= 10_000 ? "shared" : "system";
      this.recordKill(limit, false, null, current.kills - this.previous.kills);
      this.ownOomAt = -Infinity; this.sharedOomAt = -Infinity;
    }
    this.previous = current;
    this.sliceOom = sliceOom;
  }
  private recordKill(limit: AgentMemoryKill["limit"], fatal: boolean, processName: string | null, count = 1, notify = true): void {
    this.state.kills += count;
    this.state.lastKill = { at: new Date((this.ports.now ?? Date.now)()).toISOString(), limitBytes: limit === "agent" ? this.plan.limitBytes : limit === "shared" ? this.plan.budgetBytes : this.plan.totalBytes, limit, fatal, process: processName };
    if (notify) this.notify();
  }
  sample(samples: Map<number, MemorySample[]>): MemorySample[] {
    if (this.pid === null || this.closed) return [];
    // Only the unreaped child handle can establish ownership after a missed initial lookup.
    const ownedChild = () => this.child?.pid === this.pid && this.child.exitCode === null && this.child.signalCode === null;
    if (!this.rootIdentity && !ownedChild()) return [];
    const identity = (this.ports.identity ?? procBackend.processIdentity)(this.pid);
    if (!identity) return [];
    if (!this.rootIdentity && ownedChild()) this.rootIdentity = identity;
    if (identity !== this.rootIdentity) return [];
    const tree = this.ports.sample?.(this.pid) ?? samples.get(this.pid) ?? [];
    const identities = new Map(tree.map((sample) => [sample.pid, sample.identity]));
    identities.set(this.pid, this.rootIdentity!);
    this.lastSample = tree.filter((sample) => this.plan.platform === "linux"
      ? verifiedTreeMember(this.pid!, sample.pid, identities, this.ports.identity ?? procBackend.processIdentity, this.ports.readPpid ?? linuxBackend.readPpid)
      : (this.ports.identity ?? procBackend.processIdentity)(sample.pid) === sample.identity);
    return this.lastSample;
  }
  private canSignal(victim: MemorySample): boolean {
    if (this.pid === null || !this.rootIdentity || this.closed) return false;
    const identity = this.ports.identity ?? procBackend.processIdentity;
    const identities = new Map(this.lastSample.map((sample) => [sample.pid, sample.identity]));
    identities.set(this.pid, this.rootIdentity);
    const readPpid = this.ports.readPpid ?? (this.plan.platform === "linux"
      ? linuxBackend.readPpid
      : (pid: number) => portableWatchdogParents.get(pid) ?? null);
    return identities.get(victim.pid) === victim.identity && verifiedTreeMember(this.pid, victim.pid, identities, identity, readPpid);
  }
  ownsCurrentSample(sample: MemorySample): boolean {
    return (this.ports.identity ?? procBackend.processIdentity)(sample.pid) === sample.identity && this.canSignal(sample);
  }
  killSample(victim: MemorySample, limit: AgentMemoryKill["limit"]): void {
    if ((this.ports.identity ?? procBackend.processIdentity)(victim.pid) !== victim.identity) return;
    const target = this.plan.platform === "linux" ? victim : this.lastSample.find((sample) => sample.pid === this.pid);
    if (!target || this.killedThisTick.has(target.pid) || !this.canSignal(target)) return;
    // Contain the selected process's verified subtree while its parents still
    // anchor ownership. On Linux, the largest process may be a native child
    // with its own tools; on macOS, enforcement targets the wrapper root.
    // Deepest-first keeps each remaining parent alive until its children are signalled.
    if (this.plan.platform === "linux" || target.pid === this.pid) {
      const ppidMap = this.plan.platform === "darwin" && !this.ports.readPpid ? portableWatchdogParents : null;
      const readPpid = this.ports.readPpid ?? (ppidMap
        ? (pid: number) => ppidMap.get(pid) ?? null
        : this.plan.platform === "linux" ? linuxBackend.readPpid : (pid: number) => portableWatchdogParents.get(pid) ?? null);
      const identity = this.ports.identity ?? procBackend.processIdentity;
      const identities = new Map(this.lastSample.map((sample) => [sample.pid, sample.identity]));
      identities.set(this.pid!, this.rootIdentity!);
      const descendants = this.lastSample.filter((sample) => sample.pid !== target.pid).flatMap((sample) => {
        if (!verifiedTreeMember(target.pid, sample.pid, identities, identity, readPpid)) return [];
        let depth = 0, current = sample.pid;
        while (current !== target.pid && depth <= identities.size) {
          const parent = readPpid(current);
          if (parent === null) return [];
          current = parent;
          depth++;
        }
        return current === target.pid ? [{ sample, depth }] : [];
      }).sort((left, right) => right.depth - left.depth);
      let signalledDescendant = false;
      for (const { sample } of descendants) {
        if (this.killedThisTick.has(sample.pid) || !this.canSignal(target)
          || !verifiedTreeMember(target.pid, sample.pid, identities, identity, readPpid)
          || !this.canSignal(sample)) continue;
        if (identity(sample.pid) !== sample.identity) continue;
        this.killedThisTick.add(sample.pid);
        try {
          (this.ports.kill ?? ((pid) => process.kill(pid, "SIGKILL")))(sample.pid);
          signalledDescendant = true;
        } catch { /* Already gone. */ }
      }
      // A descendant signal may race with a root exit or PID reuse.
      if (!this.canSignal(target)) {
        // Keep evidence for the memory kill when the selected native process
        // exits as a consequence of containing its verified subtree.
        if (signalledDescendant) {
          this.recordKill(limit, target.pid === this.pid, victim.name, 1, false);
          this.notify();
        }
        return;
      }
    }
    // Do not run listeners between the final ownership check and the signal.
    this.recordKill(limit, target.pid === this.pid, victim.name, 1, false);
    this.killedThisTick.add(target.pid);
    try { (this.ports.kill ?? ((pid) => process.kill(pid, "SIGKILL")))(target.pid); } catch { /* The sampled process may have already exited. */ }
    this.notify();
  }
  settleExit({ expected }: { expected: boolean }): AgentMemoryKill | null {
    if (this.exitSettled) return this.state.lastKill;
    this.exitSettled = true;
    this.readEvents();
    const kill = this.state.lastKill;
    const age = kill ? (this.ports.now ?? Date.now)() - Date.parse(kill.at) : Infinity;
    if (kill && !expected && age >= 0 && age <= 10_000) {
      kill.fatal = true;
      this.notify();
      this.reap();
    } else if (kill && expected && kill.fatal) { kill.fatal = false; this.notify(); }
    this.close();
    return this.state.lastKill;
  }
  private reap(): void {
    if (this.plan.mechanism === "scope" && this.plan.unit) {
      try { (this.ports.runner ?? run)("systemctl", ["--user", "kill", "--signal=SIGKILL", this.plan.unit]); } catch { /* An empty scope has already been collected. */ }
    } else {
      for (const sample of this.lastSample) if (this.canSignal(sample)) {
        try { (this.ports.kill ?? ((pid) => process.kill(pid, "SIGKILL")))(sample.pid); } catch { /* Already gone. */ }
      }
    }
  }
  close(): void {
    this.closed = true;
    this.child = null;
    if (this.attachTimer) clearInterval(this.attachTimer); this.attachTimer = null;
    this.watcher?.close(); this.watcher = null;
    if (this.eventsFd !== null) { fs.closeSync(this.eventsFd); this.eventsFd = null; }
    if (this.poll) clearInterval(this.poll); this.poll = null;
    watchdogCells.delete(this);
    if (!watchdogCells.size) {
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = null;
      portableWatchdogPids.clear();
      portableWatchdogParents.clear();
    }
  }
}
export function agentMemoryHeadroom(liveAgents: number, priorLimitBytes: number): { availableBytes: number; requiredBytes: number } | null {
  const memory = procBackend.systemMemory();
  if (!memory || !cachedMechanism) return null;
  const limits = agentMemoryCeiling(memory.ramTotal, liveAgents, { LLV_AGENT_MEMORY_MAX: process.env.DELEGATUS_AGENT_MEMORY_MAX ?? process.env.LLV_AGENT_MEMORY_MAX, LLV_AGENT_MEMORY_RESERVE: process.env.DELEGATUS_AGENT_MEMORY_RESERVE ?? process.env.LLV_AGENT_MEMORY_RESERVE });
  let availableBytes = Math.max(0, memory.ramAvailable - limits.reserveBytes);
  if (cachedMechanism.mechanism === "scope") {
    try {
      const group = run("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", "delegatus-agents.slice"]).trim();
      const current = Number(read(path.join("/sys/fs/cgroup", group, "memory.current")));
      if (group && Number.isFinite(current)) availableBytes = Math.max(0, Math.min(memory.ramAvailable, limits.budgetBytes - current));
    } catch { return null; }
  }
  return { availableBytes, requiredBytes: Math.min(priorLimitBytes, limits.limitBytes) };
}
