import { AgentRegistry } from "@/lib/agent/registry";
import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { statePath } from "@/lib/configDir";
import { bindHostExitWriter, hostExitText, observeHostExit, readHostExit, readHostExitSpool, recordHostExit, recordHostStop, withHostStopOrigin } from "./hostExit";
import { launcherFile } from "./agentSignalSandbox";
import { socketWaitOwnerSource } from "./codexSocketTransport";
import path from "node:path";
import { terminateStructuredHostTree } from "./structuredHostControl";
import { AgentMemoryCell, type AgentMemoryPlan } from "./agentMemory";

for (const mode of ["descendant", "fatal-cleanup"] as const) test(`memory ${mode} records the native host stop before signalling it`, () => {
  const root = 2147482800;
  const native = { pid: root + 1, startIdentity: `fixture-memory-${mode}`, bootEpoch: "fixture-boot" };
  const samples = [
    { pid: root, identity: "fixture-memory-root", rss: 200, name: "launcher" },
    { pid: native.pid, identity: native.startIdentity, rss: 1, name: "host" },
    { pid: root + 2, identity: "fixture-memory-tool", rss: 101, name: "tool" },
  ];
  const killed: number[] = [];
  const plan = { mechanism: "watchdog", platform: "linux", unit: null, limitBytes: 100, budgetBytes: 1000 } as AgentMemoryPlan;
  const cell = new AgentMemoryCell(plan, {
    now: () => 100_000, identity: pid => samples.find(sample => sample.pid === pid)?.identity ?? null,
    readPpid: () => root, sample: () => samples,
    kill: pid => {
      if (pid === native.pid) expect(readHostExit(native)?.stop).toMatchObject({ path: "agent-memory-enforcement", signal: "SIGKILL" });
      killed.push(pid);
    },
  });
  try {
    cell.attach(root);
    cell.setExitProcess(native);
    cell.sample(new Map());
    cell.killSample(samples[mode === "descendant" ? 0 : 2]!, "agent");
    if (mode === "fatal-cleanup") cell.settleExit({ expected: false });
    expect(killed).toEqual(mode === "descendant" ? [native.pid, root + 2, root] : [root + 2, root, native.pid, root + 2]);
  } finally { cell.close(); }
});

for (const mode of ["delegatus", "external"] as const) test(`real host exit persists ${mode} sender and signal across a reader restart`, async () => {
  const child = spawn(process.execPath, ["-e", 'setInterval(()=>{},1000); process.stdout.write("ready\\n")'], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await once(child.stdout!, "data");
    const identity = captureProcessIdentity(child.pid!);
    expect(identity.startIdentity).not.toBeNull();
    observeHostExit(child, identity);
    if (mode === "delegatus") {
      const result = await terminateStructuredHostTree({ kind: "structured", pid: child.pid!, startIdentity: identity.startIdentity!,
        bootEpoch: identity.bootEpoch!, engine: "codex", sessionId: "exit-fixture", conversationId: null, seat: false,
        turnBusy: false, owned: false, lastActiveAt: null }, {
        stopOrigin: { path: "retirement", operationId: "retirement-fixture-operation" },
        terminateOwnedHost: async () => false,
        retireRegistryEntry: () => true,
        processGroupId: () => null,
        ppidMap: () => new Map([[child.pid!, 0]]),
        signal: (pid, signal) => {
          expect(readHostExit(identity)?.stop).toMatchObject({ path: "retirement", operationId: "retirement-fixture-operation", signal });
          process.kill(pid, signal);
        },
      });
      expect(result.ok).toBe(true);
    } else child.kill("SIGKILL");
    const [code, signal] = await closed;
    expect(code).toBeNull();
    expect(signal).toBe(mode === "delegatus" ? "SIGTERM" : "SIGKILL");
    const evidence = readHostExit(identity)!;
    expect(evidence.exit).toMatchObject({ code: null, signal });
    expect(evidence.stop?.path ?? null).toBe(mode === "delegatus" ? "retirement" : null);
    const text = hostExitText(evidence);
    expect(text).toContain(`exit: signal ${signal}; `);
    expect(text).toContain(mode === "delegatus" ? "stopped by retirement (retirement-fixture-operation)" : "no Delegatus stop recorded");
    // A new OS process has no in-memory evidence, and must read the same receipt.
    const reader = Bun.spawn([process.execPath, "-e", `import { readHostExit } from ${JSON.stringify(import.meta.path.replace(/\.test\.ts$/, ".ts"))}; console.log(JSON.stringify(readHostExit(${JSON.stringify(identity)})))`],
      { env: process.env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(reader.stdout).text();
    expect(await reader.exited).toBe(0);
    expect(JSON.parse(output)).toEqual(evidence);
    // Late failure cleanup cannot relabel an external death.
    recordHostStop(identity, "SIGKILL", "late-failure-cleanup");
    expect(readHostExit(identity)).toEqual(evidence);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

test("exit receipts retain the latest stop operation and first numeric exit in fixed slots", () => {
  const process = { pid: 2147483000, startIdentity: "fixture-host-exit-bounded", bootEpoch: "fixture-boot" };
  const directory = statePath("host-exits");
  const beforeFiles = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
  withHostStopOrigin({ path: "recovery", operationId: "recovery-fixture-operation" }, () => recordHostStop(process, "SIGTERM", "fallback"));
  withHostStopOrigin({ path: "kill-action", operationId: "kill-fixture-operation" }, () => recordHostStop(process, "SIGKILL", "fallback"));
  const before = readHostExit(process)!;
  expect(before.stop).toMatchObject({ path: "kill-action", operationId: "kill-fixture-operation", signal: "SIGKILL" });
  recordHostExit(process, 23, null);
  for (let i = 0; i < 20; i++) {
    recordHostStop(process, "SIGKILL", "escalation");
    recordHostExit(process, 23, null);
    recordHostExit(process, null, "SIGKILL");
  }
  expect(readHostExit(process)).toMatchObject({ stop: before.stop, exit: { code: 23, signal: null } });
  expect(hostExitText(readHostExit(process))).toBe("exit: code 23; stopped by kill-action (kill-fixture-operation)");
  expect(fs.readdirSync(directory).filter(file => !beforeFiles.has(file))).toHaveLength(2);
});

for (const sqliteMode of ["off", "sqlite"] as const) test(`retired ${sqliteMode} host rows retain their exit identity after reopening`, () => {
  const process = { pid: 2147482999, startIdentity: "fixture-retired-host", bootEpoch: "fixture-boot" };
  const key = { engine: "codex" as const, sessionId: `retired-exit-${sqliteMode}` };
  const registry = new AgentRegistry(statePath(`host-exit-${sqliteMode}.json`), undefined, undefined, { sqliteMode });
  try {
    registry.upsert({ key, artifactPath: "fixtures/exit.jsonl", cwd: "fixtures", accountId: null, status: "dead", host: null,
      claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: { kind: "codex-app-server", process, exitProcess: process,
        endpoint: "stdio:fixture", eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
    recordHostExit(process, 23, null);
    expect(registry.terminateStructuredHost(key, process)).toBe(true);
    registry.close();
    const reopened = new AgentRegistry(registry.filename, undefined, undefined, { sqliteMode });
    try {
      const entry = reopened.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
      expect(entry.structuredHost).toBeNull();
      expect(entry.hostExitProcess).toEqual(process);
      expect(readHostExit(entry.hostExitProcess)?.exit).toMatchObject({ code: 23, signal: null });
    } finally { reopened.close(); }
  } finally { registry.close(); }
});

test("a failed receipt write leaves no temporary record and the exit observer can retry", () => {
  const process = { pid: 2147482997, startIdentity: "fixture-exit-write-failure", bootEpoch: "fixture-boot" };
  const directory = statePath("host-exits");
  fs.mkdirSync(directory, { recursive: true });
  const before = new Set(fs.readdirSync(directory));
  const sync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("fixture sync refused"); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => recordHostStop(process, "SIGTERM", "fixture-stop")).not.toThrow();
    expect(() => recordHostExit(process, null, "SIGKILL")).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(statePath("host-exits")).filter(file => !before.has(file))).toEqual([]);
  } finally { sync.mockRestore(); log.mockRestore(); }
  recordHostExit(process, null, "SIGKILL");
  expect(readHostExit(process)?.exit).toMatchObject({ code: null, signal: "SIGKILL" });
  expect(readHostExit(process)?.stop).toBeNull();
});

for (const sqliteMode of ["off", "sqlite"] as const) for (const writer of ["set", "upsert", "claimed"] as const) test(`replaced ${sqliteMode}/${writer} hosts retain launch evidence and reclaim generation files`, () => {
  const registry = new AgentRegistry(statePath(`exit-retention-${sqliteMode}-${writer}.json`), undefined, undefined, { sqliteMode });
  const key = { engine: "codex" as const, sessionId: `replaced-exit-${sqliteMode}-${writer}` };
  const directory = statePath("host-exits");
  const before = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
  const launch = registry.beginSpawn("codex", "fixtures", { title: "Retained host exit fixture" });
  const columns = (generation: number) => {
    const process = { pid: 2147482700, startIdentity: `retention-${sqliteMode}-${writer}-${generation}`, bootEpoch: "fixture-boot" };
    return { kind: "codex-app-server" as const, endpoint: "stdio:fixture", process, exitProcess: process,
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: "open-attempt", pendingAttention: [], activeFlags: [] };
  };
  try {
    registry.stageStructuredSpawn(launch.launchId, { key, artifactPath: "fixtures/replaced.jsonl", cwd: "fixtures", accountId: null,
      status: "dead", host: null, claimEpoch: 1, claimOwner: "fixture-exit-owner", pendingAction: null, structuredHost: columns(0) });
    const observer = new EventEmitter();
    observeHostExit(observer, columns(0).process);
    for (let generation = 0; generation < 20; generation++) {
      const process = columns(generation).process;
      recordHostStop(process, "SIGTERM", "retention-fixture");
      if (generation === 0) observer.emit("exit", 0, null);
      else recordHostExit(process, generation, null);
      const next = columns(generation + 1);
      if (writer === "set") registry.setStructuredHost(key, next, "dead");
      else if (writer === "upsert") registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]!, structuredHost: next });
      else expect(registry.setStructuredHostClaimed(key, { ...next, exitProcess: undefined }, "dead", "fixture-exit-owner", 1)).not.toBeNull();
      observer.emit("close", 0, null);
      expect(fs.readdirSync(directory).filter(file => !before.has(file))).toHaveLength(0);
    }
    registry.close();
    const reopened = new AgentRegistry(registry.filename, undefined, undefined, { sqliteMode });
    try {
      const snapshot = reopened.readOnlySnapshot();
      expect(snapshot.receipts[launch.launchId]?.hostExit).toMatchObject({ process: columns(0).process, exit: { code: 0 } });
      expect(snapshot.entries[`codex:${key.sessionId}`]?.previousHostExit?.exit?.code).toBe(19);
      expect(snapshot.entries[`codex:${key.sessionId}`]?.pendingHostExits).toBeUndefined();
    } finally { reopened.close(); }
  } finally { registry.close(); }
});

test("a refused registry commit retains the original generation files for retry", () => {
  const registry = new AgentRegistry(statePath("exit-retention-refusal.json"), undefined, undefined, { sqliteMode: "off" });
  const key = { engine: "codex" as const, sessionId: "retention-refusal" };
  const first = { pid: 2147482698, startIdentity: "refused-first", bootEpoch: "fixture-boot" };
  const columns = { kind: "codex-app-server" as const, process: first, exitProcess: first, endpoint: "stdio:fixture",
    eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] };
  try {
    registry.upsert({ key, artifactPath: "fixtures/refusal.jsonl", cwd: "fixtures", accountId: null, status: "dead", host: null,
      claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: columns });
    recordHostExit(first, 23, null);
    const rename = fs.renameSync;
    const refusal = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === registry.filename) throw new Error("fixture commit refused");
      return rename(from, to);
    });
    const next = { ...first, startIdentity: "refused-next" };
    try {
      expect(() => registry.setStructuredHost(key, { ...columns, process: next, exitProcess: next })).toThrow("fixture commit refused");
    } finally { refusal.mockRestore(); }
    expect(readHostExit(first)?.exit?.code).toBe(23);
    expect(registry.readOnlySnapshot().entries["codex:retention-refusal"]?.hostExitProcess).toEqual(first);
    registry.setStructuredHost(key, { ...columns, process: next, exitProcess: next });
    expect(readHostExit(first)?.exit).toBeNull();
  } finally { registry.close(); }
});

test("replacement keeps a pending native waiter referenced until its exit arrives", () => {
  const registry = new AgentRegistry(statePath("exit-retention-pending.json"), undefined, undefined, { sqliteMode: "off" });
  const key = { engine: "codex" as const, sessionId: "pending-exit" };
  const first = { pid: 2147482699, startIdentity: "pending-first", bootEpoch: "fixture-boot" };
  const next = { ...first, startIdentity: "pending-next" };
  const columns = { kind: "codex-app-server" as const, process: first, exitProcess: first, endpoint: "stdio:fixture",
    eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: "open-attempt", pendingAttention: [], activeFlags: [] };
  try {
    registry.upsert({ key, artifactPath: "fixtures/pending.jsonl", cwd: "fixtures", accountId: null, status: "dead", host: null,
      claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: columns });
    const binding = fs.mkdtempSync(path.join(process.env.TMPDIR!, "pending-waiter-"));
    try { bindHostExitWriter(binding, first); } finally { fs.rmSync(binding, { recursive: true, force: true }); }
    registry.setStructuredHost(key, { ...columns, process: next, exitProcess: next });
    expect(registry.readOnlySnapshot().entries["codex:pending-exit"]?.pendingHostExits).toEqual([{ process: first, launchId: null }]);
    recordHostExit(first, null, "SIGKILL");
    registry.setStructuredHost(key, null);
    expect(registry.readOnlySnapshot().entries["codex:pending-exit"]?.previousHostExit?.exit?.signal).toBe("SIGKILL");
    expect(readHostExit(first)?.exit).toBeNull();
  } finally { registry.close(); }
});

for (const entry of ["socket", "namespace"] as const) for (const ending of ["signal", "code"] as const) test(`${entry} native waiter distinguishes SIGKILL from exit(137): ${ending}`, async () => {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "native-wait-"));
  const ready = path.join(directory, entry === "socket" ? "native.json" : "inner.json");
  const finish = ending === "signal" ? 'process.kill(process.pid,"SIGKILL")' : "process.exit(137)";
  const command = [process.execPath, "-e", entry === "namespace" ? finish
    : `const fs=require("node:fs"); const ready=${JSON.stringify(path.join(directory, "exec.json"))}; const timer=setInterval(()=>{if(fs.existsSync(ready)){clearInterval(timer);${finish}}},10)`];
  // Exercise the actual protected entry/wait code without requiring namespace
  // privileges. Only its membership proof is supplied by the protocol fixture;
  // native fork, exec, wait status and durable write are real OS operations.
  const namespace = `import importlib.util,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("launcher",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
original=m.read
def read(file):
    if str(file)=="/proc/self/status":
        return "CapEff: 0\\nNoNewPrivs: 1\\nNSpid: "+str(os.getpid())+"\\n"
    return original(file)
m.read=read; m.group=lambda:"/fixture.scope/agent"
directory=Path(sys.argv[2]); (directory/"proc").symlink_to("/proc"); (directory/"context.json").write_text("{}")
sys.exit(m.inner(directory,sys.argv[3:]))`;
  const child = entry === "socket"
    ? spawn(process.execPath, ["-e", socketWaitOwnerSource, "--", JSON.stringify([directory, ...command])], { stdio: "ignore" })
    : spawn("python3", ["-c", namespace, launcherFile(), directory, ...command], { stdio: "ignore", env: { ...process.env, LLV_HOST_EXIT_RECEIPTS: "1" } });
  const closed = once(child, "close");
  let native: ReturnType<typeof captureProcessIdentity> | undefined;
  try {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(fs.existsSync(ready)).toBeTrue();
    const process = native = captureProcessIdentity(JSON.parse(fs.readFileSync(ready, "utf8")).pid);
    bindHostExitWriter(directory, process, captureProcessIdentity(child.pid!));
    fs.writeFileSync(path.join(directory, "exec.json"), "true");
    await closed;
    expect(readHostExit(process)?.exit).toMatchObject(ending === "signal" ? { code: null, signal: "SIGKILL" } : { code: 137, signal: null });
  } finally {
    if (native && processIdentityStatus(native) === "alive") process.kill(native.pid, "SIGKILL");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a waiter whose readiness write fails records its cleanup and reaps its native child", async () => {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "native-readiness-refusal-"));
  fs.mkdirSync(path.join(directory, "native.json"));
  const child = spawn(process.execPath, ["-e", socketWaitOwnerSource, "--", JSON.stringify([directory, process.execPath, "-e", "setInterval(()=>{},1000)"])], { stdio: "ignore" });
  const closed = once(child, "close");
  try {
    await closed;
    const evidence = readHostExitSpool(directory)!;
    expect(evidence.exit).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(evidence.stop).toMatchObject({ path: "codex-socket-startup-cleanup", signal: "SIGKILL" });
    expect(evidence.stop?.operationId).toBeTruthy();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
