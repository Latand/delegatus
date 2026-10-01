import { expect, spyOn, test } from "bun:test";
import { agentMemoryCeiling, GIB } from "./agentMemory";

test("reserves the core budget and bounds each agent at launch", () => {
  for (const [n, gb] of [[1,53],[5,42],[8,26.5],[11,19],[14,15],[20,10.5],[30,7],[53,4]]) {
    expect(agentMemoryCeiling(125 * GIB, n)).toEqual({ reserveBytes: 19 * GIB, budgetBytes: 106 * GIB, limitBytes: gb * GIB });
  }
  expect(agentMemoryCeiling(16 * GIB, 1).limitBytes).toBe(6 * GIB);
  expect(agentMemoryCeiling(16 * GIB, 6).limitBytes).toBe(4 * GIB);
});

import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import { procBackend } from "@/lib/proc";
import { AgentMemoryCell, agentOomScore, parseMemorySize, probeAgentScopes, tickAgentMemoryWatchdogs, viewerUnitFromCgroup, wrapAgentCommand, normalizeHostMemory, planAgentMemory, invalidateAgentScopeProbe, type AgentMemoryPlan } from "./agentMemory";
const basePlan: AgentMemoryPlan = { mechanism: "scope", platform: "linux", limitBytes: 15 * GIB, budgetBytes: 106 * GIB, reserveBytes: 19 * GIB, totalBytes: 125 * GIB, score: 500, unit: "delegatus-agent-test-123.scope", slice: "delegatus-agents-test.slice", viewerUnit: "delegatus.service", systemdVersion: 255 };

test("size overrides are binary, invalid values ignored, tiny hosts stay bounded", () => {
  expect(parseMemorySize("24G")).toBe(24 * GIB);
  expect(parseMemorySize("4.5GB")).toBe(4.5 * GIB);
  expect(parseMemorySize("nope")).toBeNull();
  expect(parseMemorySize("0G")).toBeNull();
  expect(agentMemoryCeiling(16 * GIB, 2, { LLV_AGENT_MEMORY_MAX: "24G", LLV_AGENT_MEMORY_RESERVE: "8G" })).toEqual({ reserveBytes: 8 * GIB, budgetBytes: 8 * GIB, limitBytes: 8 * GIB });
  expect(agentMemoryCeiling(2 * GIB, 100).limitBytes).toBe(GIB);
});
test("scope preserves literal argv and binding; watchdog raises score; off is untouched", () => {
  const args = ["$literal", "two words", "\"quote\""];
  for (const version of [253,254]) {
    const wrapped = wrapAgentCommand({ ...basePlan, systemdVersion: version }, "agent", args);
    expect(wrapped.command).toBe("systemd-run");
    expect(wrapped.args.includes("--expand-environment=no")).toBe(version >= 254);
    expect(wrapped.args).toContain("BindsTo=delegatus.service");
    expect(wrapped.args.slice(-3)).toEqual(args);
  }
  expect(wrapAgentCommand({ ...basePlan, mechanism: "watchdog" }, "agent", args).command).toBe("/bin/sh");
  expect(wrapAgentCommand({ ...basePlan, mechanism: "watchdog", platform: "darwin" }, "agent", args)).toEqual({ command: "agent", args });
  expect(wrapAgentCommand(null, "agent", args)).toEqual({ command: "agent", args });
  expect(agentOomScore(200)).toBe(500);
  expect(agentOomScore(900)).toBe(1000);
  expect(viewerUnitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service")).toBe("delegatus.service");
  expect(viewerUnitFromCgroup("0::/system.slice/delegatus.service")).toBeNull();
});
test("probe requires delegated memory and a successful fake scope runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-probe-"));
  const manager = path.join(root, "user.slice/user-1000.slice/user@1000.service");
  fs.mkdirSync(manager, { recursive: true });
  fs.writeFileSync(path.join(root, "cgroup.controllers"), "memory cpu");
  fs.writeFileSync(path.join(manager, "cgroup.controllers"), "memory");
  const options = { platform: "linux" as const, cgroupRoot: root, uid: 1000, docker: false, runner: (command: string, args: string[]) => args[0] === "--version" ? "systemd 255" : "" };
  try {
    expect(probeAgentScopes(options)).toBe(255);
    expect(probeAgentScopes({ ...options, runner: () => { throw new Error("ENOENT"); } })).toBeNull();
    expect(probeAgentScopes({ ...options, docker: true })).toBeNull();
    fs.writeFileSync(path.join(manager, "cgroup.controllers"), "cpu");
    expect(probeAgentScopes(options)).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
function fakeCell() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-cell-"));
  const group = `/${basePlan.slice}/${basePlan.unit}`;
  const dir = path.join(root, group);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "memory.events");
  const slice = path.join(root, basePlan.slice, "memory.events");
  fs.writeFileSync(file, "oom 0\noom_kill 0\n");
  fs.writeFileSync(slice, "oom 0\noom_kill 0\n");
  const calls: string[][] = [];
  let notify = () => {};
  const cell = new AgentMemoryCell(basePlan, { cgroupRoot: root, cgroupForPid: () => group, now: () => 100_000,
    watch: ((_file: string, listener: () => void) => { notify = listener; return { close() {} }; }) as unknown as typeof fs.watch,
    runner: (command, args) => { calls.push([command, ...args]); return ""; } });
  cell.attach(123);
  return { cell, file, slice, calls, notify: () => notify(), dispose: () => { cell.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
for (const kind of ["agent", "shared", "system"] as const) test(`fake cgroup attributes ${kind} kills and retains fatal evidence after collection`, () => {
  const fixture = fakeCell();
  try {
    fs.writeFileSync(fixture.file, `oom ${kind === "agent" ? 1 : 0}\noom_kill 1\n`);
    if (kind === "shared") fs.writeFileSync(fixture.slice, "oom 1\noom_kill 1\n");
    fixture.notify();
    expect(fixture.cell.snapshot().lastKill?.limit).toBe(kind);
    expect(fixture.cell.snapshot().lastKill?.fatal).toBe(false);
    fs.rmSync(fixture.file);
    expect(fixture.cell.settleExit({ expected: false })?.fatal).toBe(true);
    expect(fixture.calls[0]).toContain(basePlan.unit!);
    expect(normalizeHostMemory(fixture.cell.snapshot())).toEqual(fixture.cell.snapshot());
  } finally { fixture.dispose(); }
});
test("exit read catches missed watch; release and an unmarked SIGKILL are never OOM", () => {
  const fixture = fakeCell();
  try {
    expect(fixture.cell.settleExit({ expected: false })).toBeNull();
  } finally { fixture.dispose(); }
  const releasing = fakeCell();
  try {
    fs.writeFileSync(releasing.file, "oom 1\noom_kill 1\n");
    expect(releasing.cell.settleExit({ expected: true })?.fatal).toBe(false);
    expect(releasing.calls).toHaveLength(0);
  } finally { releasing.dispose(); }
  expect(normalizeHostMemory({ ...basePlan, kills: -1, lastKill: null })).toBeNull();
});
test("watchdog kills the largest owned process and identity-fences fatal cleanup", () => {
  const killed: number[] = [];
  let identities = new Map([[123,"123:a"],[124,"124:b"]]);
  let samples = [{ pid: 123, identity: "123:a", rss: GIB, name: "agent" }, { pid: 124, identity: "124:b", rss: 16 * GIB, name: "tool" }];
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null }, { identity: (pid) => identities.get(pid) ?? null, readPpid: () => 123, sample: () => samples, kill: (pid) => { killed.push(pid); } });
  cell.attach(123);
  tickAgentMemoryWatchdogs([cell]);
  expect(killed).toEqual([124]);
  expect(cell.snapshot().lastKill?.fatal).toBe(false);
  samples = [{ pid: 123, identity: "123:a", rss: 16 * GIB, name: "agent" }, { pid: 124, identity: "124:b", rss: GIB, name: "tool" }];
  tickAgentMemoryWatchdogs([cell]);
  expect(cell.snapshot().lastKill?.fatal).toBe(true);
  identities = new Map([[123,"123:a"],[124,"124:reused"]]);
  cell.settleExit({ expected: false });
  expect(killed).toEqual([124,123,123]);
});

test("a size without a suffix means bytes", () => {
  expect(parseMemorySize("4096")).toBe(4096);
});
test("the shared watchdog budget kills across individually bounded trees", () => {
  const killed: number[] = [];
  const cells = [123,124].map((pid) => {
    const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", limitBytes: 4 * GIB, budgetBytes: 5 * GIB, unit: null }, {
      identity: (n) => `${n}:owned`, sample: () => [{ pid, identity: `${pid}:owned`, rss: 3 * GIB, name: "agent" }], kill: (n) => { killed.push(n); },
    });
    cell.attach(pid);
    return cell;
  });
  try {
    tickAgentMemoryWatchdogs(cells);
    expect(killed).toHaveLength(1);
    expect(cells.find((cell) => cell.snapshot().lastKill)?.snapshot().lastKill?.limit).toBe("shared");
  } finally { for (const cell of cells) cell.close(); }
});

test("a per-agent watchdog kill satisfies the shared budget without killing a healthy agent", () => {
  const killed: number[] = [];
  const cells = [123,125].map((pid) => {
    const samples = pid === 123 ? [{ pid, identity: `${pid}:owned`, rss: GIB, name: "agent" }, { pid: 124, identity: "124:owned", rss: 5 * GIB, name: "tool" }] : [{ pid, identity: `${pid}:owned`, rss: GIB, name: "healthy" }];
    const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", limitBytes: 4 * GIB, budgetBytes: 5 * GIB, unit: null }, { identity: (n) => `${n}:owned`, readPpid: () => pid, sample: () => samples, kill: (n) => { killed.push(n); } });
    cell.attach(pid); return cell;
  });
  try { tickAgentMemoryWatchdogs(cells); expect(killed).toEqual([124]); }
  finally { for (const cell of cells) cell.close(); }
});

test("separate OOM and kill notifications retain the agent limit witness", () => {
  const fixture = fakeCell();
  try {
    fs.writeFileSync(fixture.file, "oom 1\noom_kill 0\n");
    fixture.notify();
    fs.writeFileSync(fixture.file, "oom 1\noom_kill 1\n");
    fixture.notify();
    expect(fixture.cell.snapshot().lastKill?.limit).toBe("agent");
  } finally { fixture.dispose(); }
});


test("a cached auto scope that loses admission re-probes and wraps the next launch with watchdog", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const env = { ...process.env, LLV_AGENT_MEMORY: "auto", DELEGATUS_AGENT_MEMORY: "auto" };
  let probes = 0;
  const ports = { totalBytes: 16 * GIB, probe: () => ++probes === 1 ? 255 : null, runner: () => "" };
  invalidateAgentScopeProbe();
  const first = planAgentMemory({ engine: "codex", sessionKey: "first", liveAgents: 1 }, env, ports)!;
  expect(first.mechanism).toBe("scope");
  const cell = new AgentMemoryCell(first, { cgroupForPid: () => null });
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    cell.wrapSpawn(() => child as unknown as import("node:child_process").ChildProcessWithoutNullStreams)("agent", [], {});
    child.stderr.write("Failed to create bus connection: Connection refused");
    child.emit("close", 1, null);
    expect(cell.launchFailure()).toContain("retry shortly");
    const next = planAgentMemory({ engine: "codex", sessionKey: "next", liveAgents: 1 }, env, ports)!;
    expect(probes).toBe(2);
    expect(next.mechanism).toBe("watchdog");
    expect(wrapAgentCommand(next, "agent", ["literal"]).command).toBe("/bin/sh");
  } finally { cell.close(); invalidateAgentScopeProbe(); }
});


test("forced scope preserves the admission runner error without automatic retry", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const cell = new AgentMemoryCell({ ...basePlan, mode: "scope" }, { cgroupForPid: () => null });
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    cell.wrapSpawn(() => child as unknown as import("node:child_process").ChildProcessWithoutNullStreams)("agent", [], {});
    child.stderr.write("Failed to create bus connection: Connection refused");
    child.emit("close", 1, null);
    expect(cell.launchFailure()).toBe("Failed to create bus connection: Connection refused");
  } finally { cell.close(); }
});


test("provider Failed-to stderr is not exposed as a scope admission failure", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const cell = new AgentMemoryCell({ ...basePlan, mode: "scope" }, { cgroupForPid: () => null });
  const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    cell.wrapSpawn(() => child as unknown as import("node:child_process").ChildProcessWithoutNullStreams)("agent", [], {});
    child.stderr.write("Failed to authenticate provider: private-diagnostic");
    child.emit("close", 1, null);
    expect(cell.launchFailure()).toBeNull();
  } finally { cell.close(); }
});

function watchdogChild() {
  return Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
}
for (const launch of ["wrapSpawn", "attach"] as const) for (const limit of ["agent", "shared"] as const) test(`watchdog ${launch} acquires an initially unavailable owned identity and enforces the ${limit} limit`, () => {
  const child = watchdogChild();
  const killed: number[] = [];
  let identity: string | null = null;
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null,
    limitBytes: limit === "agent" ? 100 : 200, budgetBytes: 100 }, {
    identity: () => identity, sample: () => [{ pid: 123, identity: "123:owned", rss: 101, name: "agent" }],
    kill: (pid) => { killed.push(pid); },
  });
  try {
    if (launch === "wrapSpawn") cell.wrapSpawn(() => child as unknown as ChildProcessWithoutNullStreams)("agent", [], {});
    else cell.attach(child.pid, child as unknown as ChildProcessWithoutNullStreams);
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual([]);
    identity = "123:owned";
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual([123]);
    expect(cell.snapshot().lastKill).toMatchObject({ limit, fatal: true });
    identity = "123:reused";
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual([123]);
  } finally { cell.close(); }
});
for (const exit of ["exit", "exitCode", "signalCode", "during-lookup"] as const) test(`watchdog never adopts a reused initial PID after child ${exit}`, () => {
  const child = watchdogChild();
  let identity: string | null = null;
  const killed: number[] = [];
  let sampled = 0;
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null, limitBytes: 100 }, {
    identity: () => { if (identity && exit === "during-lookup") child.emit("exit", 0, null); return identity; },
    sample: () => { sampled++; return [{ pid: 123, identity: "123:reused", rss: 101, name: "unrelated" }]; },
    kill: (pid) => { killed.push(pid); },
  });
  try {
    cell.wrapSpawn(() => child as unknown as ChildProcessWithoutNullStreams)("agent", [], {});
    if (exit === "exit") child.emit("exit", 0, null);
    if (exit === "exitCode") child.exitCode = 0;
    if (exit === "signalCode") child.signalCode = "SIGKILL";
    identity = "123:reused";
    tickAgentMemoryWatchdogs([cell]);
    expect(sampled).toBe(0);
    expect(killed).toEqual([]);
    expect(cell.snapshot().kills).toBe(0);
  } finally { cell.close(); }
});
test("watchdog cannot acquire an unknown PID without a spawned child handle", () => {
  let identity: string | null = null;
  const killed: number[] = [];
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null, limitBytes: 100 }, {
    identity: () => identity, sample: () => [{ pid: 123, identity: "123:reused", rss: 101, name: "unrelated" }], kill: (pid) => { killed.push(pid); },
  });
  try {
    cell.attach(123);
    identity = "123:reused";
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual([]);
  } finally { cell.close(); }
});
for (const unit of ["delegatus@review.service", "delegatus@review\\x2dcase.service", "delegatus\\x20viewer.service"]) test(`user service ${unit} retains scope lifetime binding`, () => {
  const viewerUnit = viewerUnitFromCgroup(`0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`);
  expect(viewerUnit).toBe(unit);
  const wrapped = wrapAgentCommand({ ...basePlan, viewerUnit }, "agent", []);
  expect(wrapped.args).toContain(`BindsTo=${unit}`);
  expect(wrapped.args).toContain(`After=${unit}`);
});

for (const limit of ["agent", "shared"] as const) for (const owned of [false, true]) test(`Linux production sampler ${owned ? "enforces a current descendant" : "rejects an unrelated replacement"} at the ${limit} limit`, () => {
  const root = process.pid;
  const descendant = 987654321;
  const killed: number[] = [];
  const originalRead = fs.readFileSync.bind(fs);
  const originalReaddir = fs.readdirSync.bind(fs);
  const originalExists = fs.existsSync.bind(fs);
  const reads = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const name = String(file);
    if (name === `/proc/${root}/task/${root}/children`) return String(descendant);
    if (name === `/proc/${descendant}/task/${descendant}/children`) return "";
    if (name === `/proc/${descendant}/comm`) return "replacement";
    return Reflect.apply(originalRead, fs, [file, ...args]);
  }) as typeof fs.readFileSync);
  const dirs = spyOn(fs, "readdirSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file) === `/proc/${root}/task`) return [String(root)];
    if (String(file) === `/proc/${descendant}/task`) return [String(descendant)];
    return Reflect.apply(originalReaddir, fs, [file, ...args]);
  }) as typeof fs.readdirSync);
  const exists = spyOn(fs, "existsSync").mockImplementation((file) => String(file).endsWith("/children") || originalExists(file));
  // The old children list already points to a reused PID when identities are captured.
  const identities = spyOn(procBackend, "processIdentity").mockImplementation((pid) => `${pid}:current`);
  const parents = spyOn(procBackend, "readPpid").mockImplementation((pid) => pid === descendant ? owned ? root : 2 : 2);
  const memory = spyOn(procBackend, "processMemory").mockReturnValue(new Map([
    [root, { rssBytes: 1, swapBytes: 0 }], [descendant, { rssBytes: 101, swapBytes: 0 }],
  ]));
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null,
    limitBytes: limit === "agent" ? 100 : 200, budgetBytes: 100 }, { kill: (pid) => { killed.push(pid); } });
  try {
    cell.attach(root);
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual(owned ? [descendant] : []);
    expect(cell.snapshot().kills).toBe(owned ? 1 : 0);
    expect(cell.snapshot().lastKill?.limit ?? null).toBe(owned ? limit : null);
  } finally { cell.close(); memory.mockRestore(); parents.mockRestore(); identities.mockRestore(); exists.mockRestore(); dirs.mockRestore(); reads.mockRestore(); }
});

for (const limit of ["agent", "shared"] as const) test(`Linux rechecks ancestry at ${limit} signal time`, () => {
  let parent = 123;
  const killed: number[] = [];
  const samples = [{ pid: 123, identity: "123:owned", rss: 1, name: "agent" }, { pid: 124, identity: "124:owned", rss: 101, name: "tool" }];
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null, limitBytes: 200, budgetBytes: 200 }, {
    identity: (pid) => `${pid}:owned`, readPpid: () => parent, sample: () => samples, kill: (pid) => { killed.push(pid); },
  });
  try {
    cell.attach(123);
    cell.sample(new Map());
    parent = 2;
    cell.killSample(samples[1], limit);
    expect(killed).toEqual([]);
    expect(cell.snapshot().kills).toBe(0);
  } finally { cell.close(); }
});

test("Linux fatal cleanup refuses reparented descendants and a dead owned root", () => {
  let parent = 123;
  let rootAlive = true;
  const killed: number[] = [];
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null, limitBytes: 100 }, {
    identity: (pid) => pid === 123 && !rootAlive ? null : `${pid}:owned`, readPpid: () => parent,
    sample: () => [{ pid: 123, identity: "123:owned", rss: 1, name: "agent" }, { pid: 124, identity: "124:owned", rss: 101, name: "tool" }],
    kill: (pid) => { killed.push(pid); },
  });
  try {
    cell.attach(123);
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual([124]);
    parent = 2;
    rootAlive = false;
    cell.settleExit({ expected: false });
    expect(killed).toEqual([124]);
  } finally { cell.close(); }
});

for (const limit of ["agent", "shared"] as const) test(`macOS ${limit} enforcement and fatal cleanup signal only the direct child`, () => {
  const killed: number[] = [];
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", platform: "darwin", unit: null,
    limitBytes: limit === "agent" ? 100 : 200, budgetBytes: 100 }, {
    identity: (pid) => `${pid}:owned`,
    sample: () => [{ pid: 123, identity: "123:owned", rss: 1, name: "agent" }, { pid: 124, identity: "124:owned", rss: 101, name: "tool" }],
    readPpid: () => { throw new Error("macOS ancestry is cached and cannot authorize signals"); },
    kill: (pid) => { killed.push(pid); },
  });
  try {
    cell.attach(123, watchdogChild() as unknown as ChildProcessWithoutNullStreams);
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual([123]);
    expect(cell.snapshot().lastKill).toMatchObject({ limit, fatal: true, process: "tool" });
    cell.settleExit({ expected: false });
    expect(killed.every((pid) => pid === 123)).toBe(true);
  } finally { cell.close(); }
});

for (const change of ["unrelated", "reused", "owned"] as const) test(`macOS production sampler handles ${change} descendants without signalling them`, () => {
  const root = process.pid;
  const descendant = 987654321;
  const killed: number[] = [];
  let replaced = false;
  let observations = 0;
  const identities = spyOn(procBackend, "processIdentity").mockImplementation((pid) => `${pid}:${pid === descendant && replaced ? "replacement" : "owned"}`);
  const discovery = spyOn(procBackend, "ppidMap").mockImplementation(() => { throw new Error("cached ancestry must not trigger another ps/lsof scan"); });
  const runner = spyOn(childProcess, "execFileSync").mockImplementation((() => {
    observations++;
    if (change === "reused" && observations > 1) replaced = true;
    return `${root} 2 1\n${descendant} ${change === "unrelated" && observations > 1 ? 2 : root} 101\n`;
  }) as unknown as typeof childProcess.execFileSync);
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", platform: "darwin", unit: null,
    limitBytes: 100 * 1024 }, { kill: (pid) => { killed.push(pid); } });
  try {
    cell.attach(root);
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual([]);
    expect(cell.snapshot().kills).toBe(0);
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual(change === "owned" ? [root] : []);
    expect(cell.snapshot().kills).toBe(change === "owned" ? 1 : 0);
    expect(cell.snapshot().lastKill?.fatal ?? null).toBe(change === "owned" ? true : null);
    expect(observations).toBe(2);
  } finally { cell.close(); runner.mockRestore(); discovery.mockRestore(); identities.mockRestore(); }
});

for (const change of ["reused", "missing", "cycle"] as const) test(`Linux rejects a ${change} intermediate ancestor`, () => {
  const killed: number[] = [];
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null, limitBytes: 100 }, {
    identity: (pid) => pid === 124 ? change === "missing" ? null : change === "reused" ? "124:new" : "124:owned" : `${pid}:owned`,
    readPpid: (pid) => pid === 125 ? 124 : change === "cycle" ? 125 : 123,
    sample: () => [{ pid: 123, identity: "123:owned", rss: 1, name: "agent" },
      { pid: 124, identity: "124:owned", rss: 1, name: "parent" }, { pid: 125, identity: "125:owned", rss: 101, name: "tool" }],
    kill: (pid) => { killed.push(pid); },
  });
  try {
    cell.attach(123);
    tickAgentMemoryWatchdogs([cell]);
    expect(killed).toEqual([]);
    expect(cell.snapshot().kills).toBe(0);
  } finally { cell.close(); }
});
