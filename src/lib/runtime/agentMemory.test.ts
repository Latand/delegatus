import { expect, test } from "bun:test";
import { agentMemoryCeiling, GIB } from "./agentMemory";

test("reserves the core budget and bounds each agent at launch", () => {
  for (const [n, gb] of [[1,53],[5,42],[8,26.5],[11,19],[14,15],[20,10.5],[30,7],[53,4]]) {
    expect(agentMemoryCeiling(125 * GIB, n)).toEqual({ reserveBytes: 19 * GIB, budgetBytes: 106 * GIB, limitBytes: gb * GIB });
  }
  expect(agentMemoryCeiling(16 * GIB, 1).limitBytes).toBe(6 * GIB);
  expect(agentMemoryCeiling(16 * GIB, 6).limitBytes).toBe(4 * GIB);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", unit: null }, { identity: (pid) => identities.get(pid) ?? null, sample: () => samples, kill: (pid) => { killed.push(pid); } });
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
    const cell = new AgentMemoryCell({ ...basePlan, mechanism: "watchdog", limitBytes: 4 * GIB, budgetBytes: 5 * GIB, unit: null }, { identity: (n) => `${n}:owned`, sample: () => samples, kill: (n) => { killed.push(n); } });
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
