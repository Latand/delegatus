import { AgentRegistry } from "@/lib/agent/registry";
import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { statePath } from "@/lib/configDir";
import { bindHostExitWriter, hostExitText, observeHostExit, readHostExit, readHostExitSpool, recordHostExit, recordHostStop, withHostStopOrigin } from "./hostExit";
import { launcherFile, spawnManagedEngine } from "./agentSignalSandbox";
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

for (const engine of ["claude", "copilot"] as const) for (const boundary of ["direct", "launcher"] as const) for (const ending of ["signal", "code"] as const) {
  test.skipIf(process.platform !== "linux")(`${engine} ${boundary} fallback retains native ${ending} after its observer dies`, async () => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "unprotected-host-exit-"));
    const ready = path.join(directory, "host.json"), finish = path.join(directory, "finish");
    const nativeReady = path.join(directory, "native.pid");
    const fixture = path.join(directory, "engine.cjs"), binary = path.join(directory, "engine");
    fs.writeFileSync(fixture, `const fs=require("node:fs");
fs.writeFileSync(${JSON.stringify(nativeReady)},String(process.pid));
process.stdout.on("error",()=>{}); process.stderr.on("error",()=>{});
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
  const q=JSON.parse(line); if(q.id===undefined) return;
  const result=q.method==="initialize"?{protocolVersion:1,agentInfo:{name:"fixture",version:"1"}}:q.method==="session/new"?{sessionId:"exit-fixture-session"}:{};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:q.id,result})+"\\n");
});
setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})) process.exit(23)},10);`);
    fs.writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o700 });
    const bin = path.join(directory, "bin"); fs.mkdirSync(bin);
    fs.symlinkSync(Bun.which("python3")!, path.join(bin, "python3"));
    fs.symlinkSync(Bun.which("git")!, path.join(bin, "git"));
    const hostModule = path.join(import.meta.dir, engine === "claude" ? "claudeStreamBrokerHost.ts" : "copilotAcpHost.ts");
    const source = `import fs from "node:fs";
import { ${engine === "claude" ? "ClaudeStreamBrokerHost" : "CopilotAcpHost"} as Host } from ${JSON.stringify(hostModule)};
import { captureProcessIdentity } from ${JSON.stringify(path.join(import.meta.dir, "../processIdentity.ts"))};
const env={...process.env,PATH:${JSON.stringify(boundary === "launcher" ? bin : process.env.PATH)},LLV_GATE_SLOT_LEASE:${boundary === "direct" ? '"fixture-lease"' : 'undefined'}};
delete env.LLV_SIGNAL_SANDBOX; delete env.LLV_DOCKER_NSENTER_SHIMS;
const host=await Host.start({cwd:${JSON.stringify(directory)},binary:${JSON.stringify(binary)},env,
  copilotHome:${JSON.stringify(path.join(directory, "copilot"))},viewerMcpServer:null,mcpServers:[],
  readAuthStatus:()=>({loggedIn:true,authMethod:"claude.ai",subscriptionType:"max"}),readTranscript:()=>[]});
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify(captureProcessIdentity((await host.health()).pid)));
setInterval(()=>{},1000);`;
    const observer = spawn(process.execPath, ["-e", source], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    const closed = once(observer, "close");
    let errors = ""; observer.stderr!.on("data", chunk => { errors += String(chunk); });
    let native: ReturnType<typeof captureProcessIdentity> | undefined;
    let waiter: ReturnType<typeof captureProcessIdentity> | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready) && observer.exitCode === null && observer.signalCode === null && Date.now() < deadline) await Bun.sleep(10);
      expect({ ready: fs.existsSync(ready), errors }).toMatchObject({ ready: true });
      native = JSON.parse(fs.readFileSync(ready, "utf8"));
      waiter = captureProcessIdentity(Number(fs.readFileSync(`/proc/${native!.pid}/stat`, "utf8").split(")").at(-1)!.trim().split(/\s+/)[1]));
      observer.kill("SIGKILL"); await closed;
      expect(processIdentityStatus(native!)).toBe("alive");
      if (ending === "signal") process.kill(native!.pid, "SIGKILL");
      else fs.writeFileSync(finish, "finish");
      const exitDeadline = Date.now() + 5_000;
      while (!readHostExit(native)?.exit && Date.now() < exitDeadline) await Bun.sleep(10);
      const evidence = readHostExit(native)!;
      expect(evidence.exit).toMatchObject(ending === "signal" ? { code: null, signal: "SIGKILL" } : { code: 23, signal: null });
      expect(Number.isFinite(Date.parse(evidence.exit!.at))).toBeTrue();
      expect(evidence.stop).toBeNull();
      const reader = Bun.spawn([process.execPath, "-e", `import {readHostExit,hostExitText} from ${JSON.stringify(path.join(import.meta.dir, "hostExit.ts"))}; const evidence=readHostExit(${JSON.stringify(native)});console.log(JSON.stringify({evidence,text:hostExitText(evidence)}));`], { env: process.env, stdout: "pipe", stderr: "pipe" });
      const answer = JSON.parse(await new Response(reader.stdout).text());
      expect(await reader.exited).toBe(0);
      expect(answer.evidence).toEqual(evidence);
      expect(answer.text).toBe(`exit: ${ending === "signal" ? "signal SIGKILL" : "code 23"}; no Delegatus stop recorded`);
    } finally {
      if (!native && fs.existsSync(nativeReady)) native = captureProcessIdentity(Number(fs.readFileSync(nativeReady, "utf8")));
      if (native && !waiter && processIdentityStatus(native) === "alive") waiter = captureProcessIdentity(Number(fs.readFileSync(`/proc/${native.pid}/stat`, "utf8").split(")").at(-1)!.trim().split(/\s+/)[1]));
      if (native && processIdentityStatus(native) === "alive") process.kill(native.pid, "SIGKILL");
      if (observer.exitCode === null && observer.signalCode === null) observer.kill("SIGKILL");
      await closed;
      const deadline = Date.now() + 5_000;
      while (waiter && processIdentityStatus(waiter) === "alive" && Date.now() < deadline) await Bun.sleep(10);
      expect(waiter ? processIdentityStatus(waiter) : "dead").toBe("dead");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
}

for (const newer of [false, true]) test(`withdrawing a refused stop preserves existing sender evidence (newer=${newer})`, () => {
  const process = { pid: 2147482596, startIdentity: `withdraw-fixture-${newer}`, bootEpoch: "fixture-boot" };
  withHostStopOrigin({ path: "earlier-stop", operationId: "earlier-operation" }, () => recordHostStop(process, "SIGTERM", "fallback"));
  const earlier = readHostExit(process)?.stop;
  const withdraw = withHostStopOrigin({ path: "refused-stop", operationId: "refused-operation" }, () => recordHostStop(process, "SIGKILL", "fallback"));
  if (newer) withHostStopOrigin({ path: "later-stop", operationId: "later-operation" }, () => recordHostStop(process, "SIGTERM", "fallback"));
  const expected = newer ? readHostExit(process)?.stop : earlier;
  withdraw?.();
  expect(readHostExit(process)?.stop).toEqual(expected);
});

test("repeated refused first stops stay empty and use one bounded receipt", () => {
  const identity = { pid: 2147482594, startIdentity: "withdraw-empty-fixture", bootEpoch: "fixture-boot" };
  const directory = statePath("host-exits");
  const before = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
  for (let attempt = 0; attempt < 20; attempt++) {
    const withdraw = recordHostStop(identity, "SIGTERM", "refused-first-stop");
    expect(readHostExit(identity)?.stop?.signal).toBe("SIGTERM");
    withdraw?.();
    withdraw?.();
    expect(readHostExit(identity)?.stop).toBeNull();
  }
  expect(fs.readdirSync(directory).filter(file => !before.has(file))).toHaveLength(1);
});

test("a successful sender in another process survives withdrawal after the receipt read", async () => {
  const child = spawn(process.execPath, ["-e", 'setInterval(()=>{},1000);process.stdout.write("ready")'], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let receiptRead: ReturnType<typeof spyOn> | undefined;
  try {
    await once(child.stdout!, "data");
    const identity = captureProcessIdentity(child.pid!);
    observeHostExit(child, identity);
    const withdraw = withHostStopOrigin({ path: "refused-stop", operationId: "refused-race-operation" }, () => recordHostStop(identity, "SIGTERM", "fallback"));
    const readFile = fs.readFileSync;
    let interleaved = false;
    receiptRead = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const value = readFile(...args);
      if (!interleaved && String(value).includes("refused-race-operation")) {
        interleaved = true;
        const sender = spawnSync(process.execPath, ["-e", `import { recordHostStop, withHostStopOrigin } from ${JSON.stringify(import.meta.path.replace(/\.test\.ts$/, ".ts"))};
          withHostStopOrigin({path:"successful-stop",operationId:"successful-race-operation"},()=>recordHostStop(${JSON.stringify(identity)},"SIGKILL","fallback"));
          process.kill(${child.pid},"SIGKILL");`], { env: process.env, encoding: "utf8", timeout: 5_000 });
        expect(sender.status).toBe(0);
      }
      return value;
    }) as typeof fs.readFileSync);
    withdraw?.();
    receiptRead.mockRestore();
    expect(interleaved).toBe(true);
    await closed;
    expect(readHostExit(identity)).toMatchObject({ stop: { path: "successful-stop", operationId: "successful-race-operation", signal: "SIGKILL" }, exit: { signal: "SIGKILL" } });
  } finally {
    receiptRead?.mockRestore();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

test("the managed waiter forwards native stdio and exit status without changing the signal target", async () => {
  const child = await spawnManagedEngine(process.execPath, ["-e", `process.stdout.write(JSON.stringify({pid:process.pid})+"\\n");process.stdin.once("data",data=>{process.stdout.write(data);process.exit(23)});`],
    { detached: true, env: { ...process.env, LLV_GATE_SLOT_LEASE: "fixture-lease" } }, null);
  const closed = once(child, "close");
  const identity = captureProcessIdentity(child.pid!);
  let output = ""; child.stdout.on("data", chunk => { output += String(chunk); });
  try {
    const deadline = Date.now() + 5_000;
    while (!output.includes("\n") && Date.now() < deadline) await Bun.sleep(10);
    expect(JSON.parse(output.trim()).pid).toBe(child.pid);
    child.stdin.write("native-stdio-fixture");
    expect(await closed).toEqual([23, null]);
    expect(output).toContain("native-stdio-fixture");
    expect(readHostExit(identity)?.exit).toMatchObject({ code: 23, signal: null });
  } finally {
    if (processIdentityStatus(identity) === "alive") child.kill("SIGKILL");
    await closed;
  }
});

test("a managed waiter whose engine cannot spawn releases its private binding", async () => {
  const directory = statePath("host-exit-waits");
  const before = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  await expect(spawnManagedEngine("/nonexistent-host-exit-fixture", [],
    { detached: true, env: { ...process.env, LLV_GATE_SLOT_LEASE: "fixture-lease" } }, null)).rejects.toThrow("invalid PID");
  const deadline = Date.now() + 5_000;
  while (fs.readdirSync(directory).length !== before.length && Date.now() < deadline) await Bun.sleep(10);
  expect(fs.readdirSync(directory)).toEqual(before);
});

test("a refused managed exit binding reaps the native engine before rejecting startup", async () => {
  const write = fs.writeFileSync;
  let native: ReturnType<typeof captureProcessIdentity> | null = null;
  const refusal = spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
    if (path.basename(String(file)) === "host-exit.json") {
      const pid = JSON.parse(fs.readFileSync(path.join(path.dirname(String(file)), "native.json"), "utf8")).pid;
      native = captureProcessIdentity(pid);
      throw new Error("fixture exit binding refused");
    }
    return write(file, ...args);
  });
  try {
    await expect(spawnManagedEngine(process.execPath, ["-e", "setInterval(()=>{},1000)"],
      { detached: true, env: { ...process.env, LLV_GATE_SLOT_LEASE: "fixture-lease" } }, null)).rejects.toThrow("fixture exit binding refused");
    expect(native).not.toBeNull();
    expect(processIdentityStatus(native!)).toBe("dead");
    expect(readHostExit(native)?.stop).toBeNull();
  } finally {
    refusal.mockRestore();
    if (native && processIdentityStatus(native) === "alive") process.kill((native as { pid: number }).pid, "SIGKILL");
  }
});

for (const detached of [false, true]) test(`refused managed exit binding reaps inherited pipes and descendants (detached=${detached})`, async () => {
  const fixture = fs.mkdtempSync(path.join(process.env.TMPDIR!, "refused-binding-tree-"));
  const ready = path.join(fixture, "descendant.json");
  const waits = statePath("host-exit-waits");
  const receipts = statePath("host-exits");
  const beforeWaits = fs.existsSync(waits) ? fs.readdirSync(waits).sort() : [];
  const beforeReceipts = fs.existsSync(receipts) ? fs.readdirSync(receipts).sort() : [];
  const write = fs.writeFileSync;
  let native: ReturnType<typeof captureProcessIdentity> | null = null;
  let descendant: ReturnType<typeof captureProcessIdentity> | null = null;
  const refusal = spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
    if (path.basename(String(file)) === "host-exit.json") {
      const pid = JSON.parse(fs.readFileSync(path.join(path.dirname(String(file)), "native.json"), "utf8")).pid;
      native = captureProcessIdentity(pid);
      const probe = spawnSync(process.execPath, ["-e", `const fs=require("node:fs");const until=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(ready)})){if(Date.now()>until)process.exit(1);await Bun.sleep(10)}`], { timeout: 6_000, env: process.env });
      if (probe.status !== 0) throw new Error("fixture descendant did not become ready");
      descendant = captureProcessIdentity(JSON.parse(fs.readFileSync(ready, "utf8")).pid);
      throw new Error("fixture tree exit binding refused");
    }
    return write(file, ...args);
  });
  try {
    await expect(spawnManagedEngine(process.execPath, ["-e", `const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit",detached:${detached}});child.once("spawn",()=>require("node:fs").writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:child.pid})));setInterval(()=>{},1000);`],
      { detached: true, env: { ...process.env, LLV_GATE_SLOT_LEASE: "fixture-lease" } }, null)).rejects.toThrow("fixture tree exit binding refused");
    expect(native).not.toBeNull();
    expect(descendant).not.toBeNull();
    expect(processIdentityStatus(native!)).toBe("dead");
    expect(processIdentityStatus(descendant!)).toBe("dead");
    expect(fs.readdirSync(waits).sort()).toEqual(beforeWaits);
    expect(fs.readdirSync(receipts).sort()).toEqual(beforeReceipts);
  } finally {
    refusal.mockRestore();
    const identities: Array<ReturnType<typeof captureProcessIdentity> | null> = [descendant, native];
    for (const identity of identities) if (identity && processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
