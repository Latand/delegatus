import { expect, spyOn, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity, systemBootEpoch } from "@/lib/processIdentity";
import { codexHostColumns, claudeHostColumns, copilotHostColumns } from "./registry";
import { headlessFixtureTransport, setHeadlessSpawnForTests, normalizeAgentSignalDomain, normalizeSignalBoundaryOff, signalBoundaryOff, signalDomain, spawnHeadlessSignalSandbox, spawnManagedEngine,
  spawnSignalSandbox, terminalSignalSandboxCommand, type AgentSignalDomain } from "./agentSignalSandbox";
import { CopilotAcpHost } from "./copilotAcpHost";
import { FileRuntimeEventStore } from "./eventStore";
import type { HostState } from "./engineHost";
import { Database } from "bun:sqlite";
import { cpuOwnerExited, cpuOwnerStatus } from "./signalSandboxContext";
import { AgentMemoryCell, GIB, planAgentMemory, setAgentMemoryPortsForTests, wrapAgentLaunch } from "./agentMemory";
import { headlessRuns, launchDetached } from "@/lib/agent/headless";
import { readHostExit } from "./hostExit";

test.skipIf(process.platform !== "linux")("a missing namespace marker never proves an unseen namespace's queue owner dead", () => {
  const current = captureProcessIdentity(process.pid);
  const foreign = { ...current, pid: 99999999, bootEpoch: current.bootEpoch!.replace(/pid:\[\d+\]$/, "pid:[99999999]") };
  expect(cpuOwnerStatus(foreign, { NODE_ENV: "test" })).toBe("unverified");
  expect(cpuOwnerExited(foreign, { NODE_ENV: "test" })).toBeFalse();
});

function domain(): AgentSignalDomain {
  const identity = (pid: number) => ({ pid, startIdentity: `${pid}:100`, bootEpoch: systemBootEpoch() });
  return { policyVersion: 1, monitor: identity(51001), bubblewrap: identity(51004), init: identity(51002), native: identity(51003),
    pidNamespace: "pid:[4026000001]", userNamespace: "user:[4026000002]", scope: "/isolated/agent.scope", directory: "/scratch/invocation" };
}

const engines: Array<"codex" | "claude" | "copilot"> = ["codex", "claude", "copilot"];
test.each(engines.flatMap(engine => (["off", "sqlite"] as const).map(mode => [engine, mode] as const)))("signal identities survive the actual registry writer and restart: %s %s", (engine, mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-registry-"));
  const file = path.join(root, "registry.json");
  const storage = { sqliteMode: mode, sqliteFilename: path.join(root, "registry.sqlite") };
  const store = new AgentRegistry(file, () => false, undefined, storage);
  const signalDomain = domain();
  const key = { engine, sessionId: "signal-registry-fixture" };
  const state: HostState = { signalDomain, status: "idle", sessionKey: key.sessionId,
    endpoint: `stdio:${signalDomain.native.pid}`, pid: signalDomain.native.pid, processStartIdentity: signalDomain.native.startIdentity,
    eventCursor: 0, protocolVersion: "fixture", activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null };
  try {
    store.upsert({ key, artifactPath: "/sessions/fixture.jsonl", cwd: "/repo", accountId: null,
      status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    const columns = engine === "codex" ? codexHostColumns(state, 0) : engine === "claude" ? claudeHostColumns(state, 0) : copilotHostColumns(state, 0);
    store.setStructuredHost(key, columns);
    expect(() => store.setStructuredHost(key, null)).toThrow("must be retired");
    expect(() => store.upsert({ ...store.readOnlySnapshot().entries[`${engine}:${key.sessionId}`]!, structuredHost: null })).toThrow("must be retired");
    const reopened = new AgentRegistry(file, () => false, undefined, storage);
    try {
      const retained = reopened.readOnlySnapshot().entries[`${engine}:${key.sessionId}`]!.structuredHost!.signalDomain!;
      expect(retained).toEqual(signalDomain);
      expect(normalizeAgentSignalDomain(retained)).toEqual(signalDomain);
    }
    finally { reopened.close(); }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("SQLite refuses an older writer dropping active domain authority and permits a proven retired row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-rollback-"));
  const filename = path.join(root, "registry.sqlite");
  const store = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: filename });
  const key = { engine: "codex" as const, sessionId: "rollback-fixture" };
  const signalDomain = domain();
  const columns = { kind: "codex-app-server" as const, endpoint: "stdio:fixture", process: signalDomain.native, eventCursor: 0,
    protocolVersion: "fixture", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [], signalDomain };
  store.upsert({ key, artifactPath: "/sessions/rollback.jsonl", cwd: "/repo", accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  store.setStructuredHost(key, columns);
  const raw = new Database(filename);
  const row = "codex:rollback-fixture";
  try {
    expect(() => raw.run("UPDATE registry_rows SET value_json=json_remove(value_json,'$.structuredHost.signalDomain') WHERE collection='entries' AND row_key=?", [row])).toThrow("requires a current reader");
    expect(() => raw.run("UPDATE registry_rows SET value_json=json_set(value_json,'$.structuredHost',NULL) WHERE collection='entries' AND row_key=?", [row])).toThrow("requires a current reader");
    expect(() => raw.run("DELETE FROM registry_rows WHERE collection='entries' AND row_key=?", [row])).toThrow("requires a current reader");
    expect(store.readOnlySnapshot().entries[row]!.structuredHost!.signalDomain).toEqual(signalDomain);
    expect(store.terminateStructuredHost(key)).toBeTrue();
    expect(store.readOnlySnapshot().entries[row]!.structuredHost!.signalDomain?.retired).toBeTrue();
    expect(() => raw.run("UPDATE registry_rows SET value_json=json_remove(value_json,'$.structuredHost.signalDomain') WHERE collection='entries' AND row_key=?", [row])).not.toThrow();
  } finally { raw.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy rows are distinguishable and malformed namespace authority refuses normalization", () => {
  expect(normalizeAgentSignalDomain(undefined)).toBeUndefined();
  for (const changed of [{ policyVersion: 2 }, { init: { pid: 51002, startIdentity: null } }, { scope: "/../other.scope" }, { pidNamespace: "unavailable" }]) {
    expect(() => normalizeAgentSignalDomain({ ...domain(), ...changed })).toThrow("malformed or unsupported");
  }
});

function fallbackEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"), ...extra };
  for (const name of ["LLV_GATE_SLOT_LEASE", "LLV_SIGNAL_SANDBOX", "LLV_DOCKER_NSENTER_SHIMS"]) if (!(name in extra)) delete env[name];
  return env;
}

async function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const [code] = await once(child, "close") as [number | null];
  return code;
}

/** Each launch adapter, given an engine that writes its marker. */
async function launchEach(env: NodeJS.ProcessEnv, marker: string) {
  const script = (name: string) => ["-c", `printf ran > '${marker}.${name}'`];
  const structured = await spawnSignalSandbox("/bin/sh", script("structured"), { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const managed = await spawnManagedEngine("/bin/sh", script("managed"), { env, detached: true }, null);
  const headless = spawnHeadlessSignalSandbox("/bin/sh", script("headless"), { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let headlessErrors = ""; headless.stderr!.on("data", chunk => { headlessErrors += chunk; });
  const codes = await Promise.all([exited(structured), exited(managed), exited(headless)]);
  return { structured, managed, headless, codes, headlessErrors };
}

function expectEnginesRan(marker: string) {
  for (const name of ["structured", "managed", "headless"]) expect(fs.readFileSync(`${marker}.${name}`, "utf8")).toBe("ran");
}

test.skipIf(process.platform !== "linux").each([
  ["managed", "monitor"], ["managed", "fallback"], ["headless", "monitor"], ["headless", "fallback"],
  ["managed", "bridge-monitor"], ["managed", "bridge-fallback"], ["headless", "bridge-monitor"], ["headless", "bridge-fallback"],
] as const)("%s %s keeps supervisors below the CLI and its children in OOM priority", async (adapter, boundary) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-oom-score-"));
  const marker = path.join(root, "scores.json"), release = path.join(root, "release");
  const inherited = Number(fs.readFileSync("/proc/self/oom_score_adj", "utf8"));
  const previousTransport = headlessFixtureTransport();
  const previousCpu = process.env.DELEGATUS_AGENT_CPU, previousMemory = process.env.DELEGATUS_AGENT_MEMORY;
  // Only namespace admission is replaced. The monitor really waits for its
  // child; launch composition, scoring, native waiter and headless runner run.
  const python = Bun.which("python3")!;
  fs.writeFileSync(path.join(root, "python3"), `#!${python}\n` + String.raw`
import importlib.util, json, os, pathlib, sys
args = sys.argv[1:]
receipt = args[args.index('--receipt') + 1]
spec = importlib.util.spec_from_file_location('launcher', args[0])
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
child = os.fork()
if child == 0:
    launcher.execute(args[args.index('--') + 1:])
pathlib.Path(receipt).write_text(json.dumps({'policyVersion': 1, 'boundary': 'off', 'reason': 'fixture monitor'}))
_, status = os.waitpid(child, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`, { mode: 0o700 });
  const bridge = boundary.startsWith("bridge-");
  const env = fallbackEnv(root, bridge
    ? { PATH: process.env.PATH!, LLV_DOCKER_NSENTER_SHIMS: "1", FIXTURE_ENTER: recordingEnter(root).enter }
    : { PATH: boundary === "monitor" ? root : "/nonexistent-signal-path" });
  const command = bridge ? bridgeShim(root, boundary === "bridge-monitor" ? path.join(root, "python3") : path.join(root, "absent-python3"), process.execPath) : process.execPath;
  const args = ["$literal", "two words", '"quote"'];
  const script = `const fs=require('node:fs');const score=p=>Number(fs.readFileSync('/proc/'+p+'/oom_score_adj','utf8'));
const grandchild=require('node:child_process').spawnSync(process.execPath,['-e','console.log(require("node:fs").readFileSync("/proc/self/oom_score_adj","utf8").trim())'],{encoding:'utf8'});
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,score:score('self'),parent:process.ppid,parentScore:score(process.ppid),grandchild:Number(grandchild.stdout),grandchildExit:grandchild.status,args:process.argv.slice(1),pendingScore:process.env.LLV_SIGNAL_OOM_SCORE??null}));
setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(23)},10);`;
  let child: ChildProcess | undefined, cell: AgentMemoryCell | undefined;
  const key = `oom-score-${adapter}-${boundary}`;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    process.env.DELEGATUS_AGENT_CPU = "off";
    process.env.DELEGATUS_AGENT_MEMORY = "watchdog";
    setAgentMemoryPortsForTests({ totalBytes: 16 * GIB, probe: () => null });
    setHeadlessSpawnForTests(null);
    const plan = planAgentMemory({ engine: "codex", sessionKey: key, liveAgents: 1 })!;
    if (adapter === "managed") {
      cell = new AgentMemoryCell(plan);
      child = await spawnManagedEngine(command, ["-e", script, ...args], { env, detached: true }, cell);
      child.stdout!.resume(); child.stderr!.resume();
    } else {
      child = launchDetached({ key, cwd: root, built: { command, args: ["-e", script, ...args], env,
        stdin: null, outputPath: null, sessionId: null, reviewerPath: null },
        stdoutPath: path.join(root, "stdout"), stderrPath: path.join(root, "stderr"), timeoutMs: 10_000, onExit: () => {} })!.handle;
    }
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(marker)) {
      if (Date.now() >= deadline || child.exitCode !== null || child.signalCode !== null) throw new Error("score fixture did not become ready");
      await Bun.sleep(10);
    }
    const scores = JSON.parse(fs.readFileSync(marker, "utf8"));
    const identity = captureProcessIdentity(child.pid!);
    expect(scores).toMatchObject({ score: plan.score, parentScore: inherited, grandchild: plan.score, grandchildExit: 0, args, pendingScore: null });
    expect(scores.score).toBeGreaterThanOrEqual(500);
    expect(scores.parentScore).toBeLessThan(scores.score);
    if (adapter === "managed" && boundary === "fallback") expect(scores.pid).toBe(child.pid);
    fs.writeFileSync(release, "exit");
    expect(await exited(child)).toBe(23);
    if (adapter === "managed") expect(readHostExit(identity)?.exit).toMatchObject({ code: 23, signal: null });
  } finally {
    fs.writeFileSync(release, "exit");
    if (child) await exited(child);
    cell?.close(); headlessRuns.delete(key);
    setHeadlessSpawnForTests(previousTransport); setAgentMemoryPortsForTests(null);
    if (previousCpu === undefined) delete process.env.DELEGATUS_AGENT_CPU; else process.env.DELEGATUS_AGENT_CPU = previousCpu;
    if (previousMemory === undefined) delete process.env.DELEGATUS_AGENT_MEMORY; else process.env.DELEGATUS_AGENT_MEMORY = previousMemory;
    warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test.each([
  ["a non-Linux platform", "darwin", {}, null, "unavailable on darwin"],
  ["an inherited gate slot lease", null, { LLV_GATE_SLOT_LEASE: "external" }, null, "gate slot lease"],
  ["the root user", null, {}, 0, "non-root user"],
  ["a missing python3", null, { PATH: "/nonexistent-signal-path" }, null, "missing: python3"],
] as const)("%s launches every adapter unprotected and reports the boundary off", async (_name, platform, extra, uid, reason) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-boundary-off-"));
  const marker = path.join(root, "engine");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const getuid = uid === null ? null : spyOn(process, "getuid").mockReturnValue(uid);
  if (platform) Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    const launched = await launchEach(fallbackEnv(root, extra), marker);
    expect(launched.codes).toEqual([0, 0, 0]);
    expectEnginesRan(marker);
    for (const child of [launched.structured, launched.managed, launched.headless]) {
      expect(signalBoundaryOff(child)?.reason).toContain(reason);
      expect(signalDomain(child)).toBeUndefined();
      // The engine itself is the launched process, exactly as on main.
      expect(child.spawnargs[0]).toBe("/bin/sh");
    }
    // A pane's lease belongs to the tmux server's environment; its launcher judges it.
    const pane = terminalSignalSandboxCommand("exec claude", fallbackEnv(root, extra));
    if ("LLV_GATE_SLOT_LEASE" in extra) expect(pane).toMatch(/^\/bin\/sh -c '.+' sh '.+' 'exec claude'$/);
    else expect(pane).toBe("exec claude");
    expect(warn.mock.calls.filter(call => String(call[0]).includes("without the agent signal boundary"))).toHaveLength("LLV_GATE_SLOT_LEASE" in extra ? 3 : 4);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    getuid?.mockRestore(); warn.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test.each([
  ["a non-Linux platform", "darwin", {}, "Linux namespaces are unavailable on darwin"],
  ["a missing python3", null, { PATH: "/nonexistent-signal-path" }, "required host dependency is missing: python3"],
] as const)("%s writes the boundary-off cause into a headless run's own stderr file before the engine's output", async (_name, platform, extra, reason) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-headless-file-"));
  const errors = path.join(root, "stderr.log");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  if (platform) Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  const fd = fs.openSync(errors, "w");
  try {
    // The production headless launcher hands the run's stderr file as a descriptor.
    const child = spawnHeadlessSignalSandbox("/bin/sh", ["-c", "echo engine >&2"], { env: fallbackEnv(root, extra), detached: true, stdio: ["ignore", "ignore", fd] });
    fs.closeSync(fd);
    expect(await exited(child)).toBe(0);
    expect(child.spawnargs[0]).toBe("/bin/sh");
    expect(fs.readFileSync(errors, "utf8")).toBe(`agent signal sandbox: boundary off, running unprotected: ${reason}\nengine\n`);
    expect(signalBoundaryOff(child)?.reason).toBe(reason);
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([`[signal-sandbox] headless launch runs without the agent signal boundary: ${reason}`]);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    try { fs.closeSync(fd); } catch { /* Closed after the launch. */ }
    warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(process.platform !== "linux")("a host without Bubblewrap runs the engine through the launcher's unprotected fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-no-bwrap-"));
  const marker = path.join(root, "engine");
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  fs.symlinkSync(Bun.which("python3")!, path.join(bin, "python3"));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const launched = await launchEach(fallbackEnv(root, { PATH: bin }), marker);
    expect(launched.codes).toEqual([0, 0, 0]);
    expectEnginesRan(marker);
    for (const child of [launched.structured, launched.managed, launched.headless]) {
      // The launcher ran and replaced itself with the engine.
      expect(child.spawnargs[0]).toBe("python3");
      expect(signalBoundaryOff(child)?.reason).toBe("required host dependency is missing: bwrap");
      expect(signalDomain(child)).toBeUndefined();
    }
    expect(launched.headlessErrors).toContain("boundary off, running unprotected: required host dependency is missing: bwrap");
    // Fallback receipts and their scratch are removed once read.
    expect(fs.readdirSync(root).filter(name => name.startsWith("delegatus-signal-"))).toEqual([]);
  } finally { warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

/** A user manager that answers the probe and then refuses or grants the
 * scope request itself; a granted request execs in place like systemd-run. */
function scopeManagerBin(root: string, request: "refused" | "granted"): string {
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  for (const binary of ["python3", "bwrap"]) fs.symlinkSync(Bun.which(binary) ?? "/bin/false", path.join(bin, binary));
  fs.writeFileSync(path.join(bin, "systemd-run"), `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/systemd-run.log'
[ "$1" = --version ] && { echo 'systemd 255'; exit 0; }
case "$*" in *--unit=*) ;; *) exit 0 ;; esac
${request === "refused" ? "echo 'scope request refused after successful probe' >&2; exit 1" : "while [ \"$1\" != -- ]; do shift; done; shift; exec \"$@\""}
`, { mode: 0o755 });
  return bin;
}

test.skipIf(process.platform !== "linux")("a scope request refused after a successful probe runs every engine once and reports the boundary off", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-scope-refused-"));
  const marker = path.join(root, "engine");
  const env = fallbackEnv(root, { PATH: scopeManagerBin(root, "refused") });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const launched = await launchEach(env, marker);
    expect(launched.codes).toEqual([0, 0, 0]);
    expectEnginesRan(marker);
    const reason = "transient scope request exited 1 before the launcher entered it";
    for (const child of [launched.structured, launched.managed, launched.headless]) {
      // The launcher outlived the refusal and replaced itself with the engine.
      expect(child.spawnargs[0]).toBe("python3");
      expect(signalBoundaryOff(child)?.reason).toBe(reason);
      expect(signalDomain(child)).toBeUndefined();
    }
    expect(launched.headlessErrors).toContain("scope request refused after successful probe");
    expect(launched.headlessErrors).toContain(`boundary off, running unprotected: ${reason}`);
    const requests = fs.readFileSync(path.join(root, "systemd-run.log"), "utf8").trim().split("\n");
    expect(requests.filter(line => line.includes("--unit="))).toHaveLength(3);
    expect(requests.filter(line => line.endsWith("-- true"))).toHaveLength(3);
    const pane = runPane(terminalSignalSandboxCommand(`printf ran >> '${marker}.pane'`, env), env);
    expect(pane.stdout).toBe("status=0");
    expect(pane.stderr).toContain(`boundary off, running unprotected: ${reason}`);
    expect(fs.readFileSync(`${marker}.pane`, "utf8")).toBe("ran");
    // The entry marks and the receipts' scratch are gone with their launches.
    expect(fs.readdirSync(root).filter(name => name.startsWith("delegatus-signal-"))).toEqual([]);
  } finally { warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(process.platform !== "linux")("a granted scope request leaves the engine to the launcher inside it, which runs it once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-scope-granted-"));
  const marker = path.join(root, "engine");
  const env = fallbackEnv(root, { PATH: scopeManagerBin(root, "granted") });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // The stub grants no real scope, so the launcher inside reports that and
    // runs the engine itself; the launcher waiting outside never runs it again.
    const command = `printf ran >> '${marker}'; exit 7`;
    const structured = await spawnSignalSandbox("/bin/sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
    let errors = ""; structured.stderr!.on("data", chunk => { errors += chunk; }); structured.stdout!.resume();
    expect(await exited(structured), errors).toBe(7);
    expect(fs.readFileSync(marker, "utf8")).toBe("ran");
    expect(signalBoundaryOff(structured)?.reason).toBe("launcher did not enter its declared invocation scope");
    const pane = runPane(terminalSignalSandboxCommand(`printf ran >> '${marker}.pane'; exit 5`, env), env);
    expect(pane.stdout).toBe("status=5");
    expect(pane.stderr).toContain("boundary off, running unprotected: launcher did not enter its declared invocation scope");
    expect(fs.readFileSync(`${marker}.pane`, "utf8")).toBe("ran");
    expect(fs.readdirSync(root).filter(name => name.startsWith("delegatus-signal-"))).toEqual([]);
  } finally { warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(process.platform !== "linux").each([
  ["names the handle as its waiting launcher", "__SELF__", null],
  ["names no launcher, so its monitor must be the handle", null, "does not match its handle"],
  ["names the monitor as its launcher", 51001, "launcher identity is contradictory"],
] as const)("a protected receipt that %s", async (_name, launcherPid, refusal) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-receipt-handle-"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const receipt = { ...domain(), ...(launcherPid === null ? {} : { launcher: { pid: launcherPid, startIdentity: "launcher", bootEpoch: systemBootEpoch() } }) };
  // Stands in for the launcher: publishes its receipt and keeps the handle alive.
  fs.writeFileSync(path.join(bin, "python3"), `#!/bin/sh
while [ "$1" != --receipt ]; do shift; done
printf '%s' '${JSON.stringify(receipt).replace('"__SELF__"', () => `'"$$"'`)}' > "$2.new" && mv "$2.new" "$2"
exec sleep 30
`, { mode: 0o755 });
  const error = spyOn(console, "error").mockImplementation(() => {});
  const child = spawnHeadlessSignalSandbox("/bin/true", [], { env: fallbackEnv(root, { PATH: `${bin}:/usr/bin:/bin` }), stdio: "ignore" });
  try {
    const file = path.join(root, fs.readdirSync(root).find(name => name.startsWith("delegatus-signal-"))!, "ready.json");
    for (const end = Date.now() + 5_000; !fs.existsSync(file) && Date.now() < end;) await Bun.sleep(10);
    if (refusal) expect(() => signalDomain(child)).toThrow(refusal);
    else expect(signalDomain(child)?.monitor.pid).toBe(51001);
  } finally {
    child.kill("SIGKILL"); await exited(child);
    error.mockRestore(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("a launch scratch the Viewer cannot create launches every adapter unprotected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-no-scratch-"));
  const marker = path.join(root, "engine");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const launched = await launchEach(fallbackEnv(root, { TMPDIR: path.join(root, "missing", "tmp") }), marker);
    expect(launched.codes).toEqual([0, 0, 0]);
    expectEnginesRan(marker);
    for (const child of [launched.structured, launched.managed, launched.headless]) {
      expect(child.spawnargs[0]).toBe("/bin/sh");
      expect(signalBoundaryOff(child)?.reason).toStartWith("launch scratch is unavailable: ");
      expect(signalDomain(child)).toBeUndefined();
    }
  } finally { warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

/** Run a pane command as an interactive shell would: what follows it still runs. */
function runPane(command: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync("/bin/sh", ["-c", `${command}; printf 'status=%s' "$?"`], { env, encoding: "utf8", timeout: 15_000 });
  return { stdout: result.stdout, stderr: result.stderr };
}

test.skipIf(process.platform !== "linux")("a pane without python3 or without Bubblewrap runs its command once and prints the boundary off", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-pane-off-"));
  const marker = path.join(root, "engine");
  const empty = path.join(root, "empty"), pythonOnly = path.join(root, "python-only");
  fs.mkdirSync(empty); fs.mkdirSync(pythonOnly);
  fs.symlinkSync(Bun.which("python3")!, path.join(pythonOnly, "python3"));
  try {
    // The Viewer sees python3; the tmux server's environment decides the rest.
    const pane = terminalSignalSandboxCommand(`printf ran >> '${marker}'; exit 7`, fallbackEnv(root));
    expect(pane).toStartWith("/bin/sh -c ");
    for (const [bin, reason] of [[empty, "required host dependency is missing: python3"], [pythonOnly, "required host dependency is missing: bwrap"]]) {
      fs.rmSync(marker, { force: true });
      const result = runPane(pane, fallbackEnv(root, { PATH: bin }));
      expect(fs.readFileSync(marker, "utf8")).toBe("ran");
      expect(result.stdout).toBe("status=7");
      expect(result.stderr).toContain(`agent signal sandbox: boundary off, running unprotected: ${reason}`);
    }
    fs.rmSync(marker, { force: true });
    const unreadable = pane.replace(/ sh '[^']+' /, ` sh '${path.join(root, "absent.py")}' `);
    const result = runPane(unreadable, fallbackEnv(root, { PATH: pythonOnly }));
    expect(fs.readFileSync(marker, "utf8")).toBe("ran");
    expect(result.stdout).toBe("status=7");
    expect(result.stderr).toContain("boundary off, running unprotected: the launcher is unreadable from the pane");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const ENTER_HOST = 'nsenter -t 1 -m -p -C --no-fork -- /usr/bin/setpriv --reuid="\\$uid" --regid="\\$gid" --groups="\\$groups" --';

/** The Dockerfile's host CLI shim, written into the fixture with its host
 * entry replaced by the fixture's own and, optionally, its python3 moved. */
function bridgeShim(root: string, python = "/usr/bin/python3", engine = "/bin/sh"): string {
  const bin = path.join(root, "bridge-bin"); fs.mkdirSync(bin, { recursive: true });
  const source = fs.readFileSync(path.resolve("Dockerfile"), "utf8").match(/make_nsenter_shim\(\) \{[\s\S]*?\n\}/)![0];
  for (const part of [ENTER_HOST, '"/usr/local/bin/$name"', "/usr/bin/python3"]) expect(source).toContain(part);
  const fixture = source.replace(ENTER_HOST, '"\\$FIXTURE_ENTER"').replaceAll('"/usr/local/bin/$name"', `"${bin}/$name"`).replaceAll("/usr/bin/python3", python);
  const made = spawnSync("bash", ["-c", `${fixture}\nmake_nsenter_shim engine '${engine.replaceAll("'", "'\\''")}'`], { encoding: "utf8" });
  expect(made.status, made.stderr).toBe(0);
  return path.join(bin, "engine");
}

const signalRuns = path.join(os.homedir(), ".cache/delegatus/signal-runs");

test.skipIf(process.platform !== "linux")("the host shim warns on a refused score before hiding native stdio and still execs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-bridge-score-refused-"));
  try {
    const shim = bridgeShim(root, path.join(root, "absent-python3"), process.execPath);
    const plan = planAgentMemory({ engine: "codex", sessionKey: "bridge-score-refused", liveAgents: 1 },
      { DELEGATUS_AGENT_MEMORY: "watchdog" }, { totalBytes: 16 * GIB })!;
    plan.score = -1001;
    const marker = path.join(root, "native.json");
    const inherited = Number(fs.readFileSync("/proc/self/oom_score_adj", "utf8"));
    const env = fallbackEnv(root, { FIXTURE_ENTER: recordingEnter(root).enter, LLV_SIGNAL_LAUNCHER: "unused-launcher",
      LLV_SIGNAL_RECEIPT: path.join(root, "receipt"), LLV_SIGNAL_IGNORE_NATIVE_STDIO: "1" });
    const wrapped = wrapAgentLaunch(plan, shim, ["-e", `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({score:Number(fs.readFileSync('/proc/self/oom_score_adj','utf8')),pending:process.env.LLV_SIGNAL_OOM_SCORE??null}));process.exit(23);`], env);
    const result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(23);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ score: inherited, pending: null });
    expect(result.stderr).toContain("workload OOM score unavailable");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const runEntries = () => { try { return fs.readdirSync(signalRuns); } catch { return []; } };
const userNamespaceMounts = process.platform === "linux" && spawnSync("unshare", ["-r", "-m", "true"], { stdio: "ignore", timeout: 5_000 }).status === 0;
const tempOutsideHome = path.relative(os.homedir(), os.tmpdir()).startsWith("..");
/** A host entry that records each receipt path it is handed before entering. */
function recordingEnter(root: string): { enter: string; receipts: () => string[] } {
  const enter = path.join(root, "enter"), file = path.join(root, "receipts");
  fs.writeFileSync(enter, `#!/bin/sh\nprintf '%s\\n' "$LLV_SIGNAL_RECEIPT" >> '${file}'\nexec "$@"\n`, { mode: 0o700 });
  return { enter, receipts: () => fs.readFileSync(file, "utf8").trim().split("\n") };
}

/** The whole stream. Bun discards a pipe nobody read once its process has
 * exited, so engines wait for a barrier until every reader is attached. */
function readAll(stream: NodeJS.ReadableStream & { readableEnded?: boolean }): Promise<string> {
  if (stream.readableEnded) throw new Error("stream ended before it was read");
  return new Promise(resolve => { let text = ""; stream.on("data", chunk => { text += chunk; }); stream.once("end", () => resolve(text)); });
}

/** Each bridged adapter launches the shim, whose engine appends its marker
 * and records any launch variable it was left. */
async function launchBridged(shim: string, env: NodeJS.ProcessEnv, marker: string) {
  const script = (name: string) => ["-c", `while [ ! -e '${marker}.go' ]; do sleep 0.01; done; env | grep '^LLV_SIGNAL_' >> '${marker}.${name}.env'; printf ran >> '${marker}.${name}'; echo visible`];
  const structured = await spawnSignalSandbox(shim, script("structured"), { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const output = readAll(structured.stdout!);
  const socket = await spawnSignalSandbox(shim, script("socket"), { env: { ...env, LLV_SIGNAL_IGNORE_NATIVE_STDIO: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const socketOutput = readAll(socket.stdout!);
  const headless = spawnHeadlessSignalSandbox(shim, script("headless"), { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  const headlessErrors = readAll(headless.stderr!);
  fs.writeFileSync(`${marker}.go`, "");
  const codes = await Promise.all([exited(structured), exited(socket), exited(headless)]);
  for (const name of ["structured", "socket", "headless"]) {
    expect(fs.readFileSync(`${marker}.${name}`, "utf8")).toBe("ran");
    expect(fs.existsSync(`${marker}.${name}.env`) ? fs.readFileSync(`${marker}.${name}.env`, "utf8") : "").toBe("");
  }
  return { structured, socket, headless, codes, output: await output, socketOutput: await socketOutput, headlessErrors: await headlessErrors };
}

test.skipIf(process.platform !== "linux" || !tempOutsideHome)("a bridged host without python3 runs every engine once and reports the boundary off", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-bridge-python-"));
  const { enter, receipts } = recordingEnter(root);
  const before = runEntries();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const shim = bridgeShim(root, path.join(root, "absent", "python3"));
    const launched = await launchBridged(shim, fallbackEnv(root, { LLV_DOCKER_NSENTER_SHIMS: "1", FIXTURE_ENTER: enter }), path.join(root, "engine"));
    expect(launched.codes).toEqual([0, 0, 0]);
    for (const child of [launched.structured, launched.socket, launched.headless]) {
      expect(child.spawnargs[0]).toBe(shim);
      expect(signalBoundaryOff(child)?.reason).toBe("required host dependency is missing: python3");
      expect(signalDomain(child)).toBeUndefined();
    }
    expect(launched.output).toBe("visible\n");
    // Socket engines keep no Viewer pipes, as through the launcher.
    expect(launched.socketOutput).toBe("");
    expect(launched.headlessErrors).toContain("agent signal sandbox: boundary off, running unprotected: required host dependency is missing: python3");
    // A TMPDIR outside the shared home is never handed across the bridge.
    expect(receipts()).toHaveLength(3);
    for (const receipt of receipts()) expect(receipt).toStartWith(fs.realpathSync(signalRuns) + path.sep);
    expect(runEntries()).toEqual(before);
  } finally { warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(process.platform !== "linux")("a bridged launch keeps a TMPDIR that lies under the shared home", async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), "signal-bridge-home-tmp-"));
  const { enter, receipts } = recordingEnter(root);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const shim = bridgeShim(root, path.join(root, "absent", "python3"));
    const launched = await launchBridged(shim, fallbackEnv(root, { LLV_DOCKER_NSENTER_SHIMS: "1", FIXTURE_ENTER: enter, TMPDIR: root }), path.join(root, "engine"));
    expect(launched.codes).toEqual([0, 0, 0]);
    expect(receipts()).toHaveLength(3);
    for (const receipt of receipts()) expect(receipt).toStartWith(fs.realpathSync(root) + path.sep);
    expect(fs.readdirSync(root).filter(name => name.startsWith("delegatus-signal-"))).toEqual([]);
  } finally { warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!userNamespaceMounts || !tempOutsideHome || !fs.existsSync("/usr/bin/python3"))("a bridged launcher that cannot see the Viewer's temporary root still answers through the shared home", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-bridge-tmp-"));
  // The host side of the bridge: a private mount namespace in which the
  // Viewer's temporary root is an unrelated empty filesystem.
  const hidden = path.join(root, "viewer-tmp"); fs.mkdirSync(hidden);
  const enter = path.join(root, "enter");
  fs.writeFileSync(enter, `#!/bin/sh\nexec unshare -r -m /bin/sh -c 'mount -t tmpfs fixture "$FIXTURE_HIDDEN" && exec "$@"' sh "$@"\n`, { mode: 0o700 });
  const before = runEntries();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const shim = bridgeShim(root);
    const launched = await launchBridged(shim, fallbackEnv(root, { LLV_DOCKER_NSENTER_SHIMS: "1", FIXTURE_ENTER: enter, FIXTURE_HIDDEN: hidden, TMPDIR: hidden }),
      path.join(root, "engine"));
    expect(launched.codes).toEqual([0, 0, 0]);
    for (const child of [launched.structured, launched.socket, launched.headless]) {
      // The fixture's host side maps the caller to root, which the launcher declines.
      expect(signalBoundaryOff(child)?.reason).toBe("managed signal domains require a non-root user");
      expect(signalDomain(child)).toBeUndefined();
    }
    expect(launched.headlessErrors).toContain("boundary off, running unprotected: managed signal domains require a non-root user");
    expect(fs.readdirSync(hidden)).toEqual([]);
    expect(runEntries()).toEqual(before);
  } finally { warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(!userNamespaceMounts || !tempOutsideHome || !fs.existsSync("/usr/bin/python3"))("a bridged TMPDIR linked from the shared home to the container's own temporary root uses the shared cache", async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), "signal-bridge-link-"));
  // The link lies under the home, its target only in the Viewer's temporary root.
  const hidden = fs.mkdtempSync(path.join(os.tmpdir(), "signal-bridge-link-target-"));
  const link = path.join(root, "tmp-link"); fs.symlinkSync(hidden, link);
  const enter = path.join(root, "enter"), handed = path.join(root, "receipts");
  fs.writeFileSync(enter, `#!/bin/sh\nprintf '%s\\n' "$LLV_SIGNAL_RECEIPT" >> '${handed}'\nexec unshare -r -m /bin/sh -c 'mount -t tmpfs fixture "$FIXTURE_HIDDEN" && exec "$@"' sh "$@"\n`, { mode: 0o700 });
  const before = runEntries();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const shim = bridgeShim(root);
    const launched = await launchBridged(shim, fallbackEnv(root, { LLV_DOCKER_NSENTER_SHIMS: "1", FIXTURE_ENTER: enter, FIXTURE_HIDDEN: hidden, TMPDIR: link }),
      path.join(root, "engine"));
    expect(launched.codes).toEqual([0, 0, 0]);
    // The launcher's fallback receipt answers each launch: every receipt it was
    // handed lies in the shared cache, which both sides of the bridge see.
    for (const child of [launched.structured, launched.socket, launched.headless]) {
      expect(signalBoundaryOff(child)?.reason).toBe("managed signal domains require a non-root user");
      expect(signalDomain(child)).toBeUndefined();
    }
    expect(launched.output).toBe("visible\n");
    expect(launched.headlessErrors).toContain("boundary off, running unprotected: managed signal domains require a non-root user");
    const receipts = fs.readFileSync(handed, "utf8").trim().split("\n");
    expect(receipts).toHaveLength(3);
    for (const receipt of receipts) expect(receipt).toStartWith(fs.realpathSync(signalRuns) + path.sep);
    expect(fs.readdirSync(hidden)).toEqual([]);
    expect(runEntries()).toEqual(before);
  } finally {
    warn.mockRestore();
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(hidden, { recursive: true, force: true });
  }
}, 40_000);

test.skipIf(process.platform !== "linux")("a structured host records the boundary-off status beside its running engine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-host-off-"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  fs.symlinkSync(Bun.which("python3")!, path.join(bin, "python3"));
  const binary = path.join(root, "copilot-fixture");
  fs.writeFileSync(binary, `#!${Bun.which("python3")}\nimport json,sys\n` + String.raw`
for line in sys.stdin:
    rpc=json.loads(line)
    if 'id' not in rpc: continue
    result={'protocolVersion':1,'agentInfo':{'name':'fixture','version':'1'}} if rpc['method']=='initialize' else {'sessionId':'signal-off-fixture'} if rpc['method']=='session/new' else {}
    print(json.dumps({'jsonrpc':'2.0','id':rpc['id'],'result':result}),flush=True)
    if rpc['method']=='session/close': break
`, { mode: 0o700 });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let host: CopilotAcpHost | undefined;
  try {
    host = await CopilotAcpHost.start({ binary, cwd: root, env: fallbackEnv(root, { PATH: bin }), copilotHome: path.join(root, "config"),
      mcpServers: [], viewerMcpServer: null, eventStore: new FileRuntimeEventStore(path.join(root, "events")) });
    const state = await host.health();
    expect(state.pid).toBeGreaterThan(1);
    expect(state.signalDomain).toBeUndefined();
    expect(state.signalBoundary).toEqual({ state: "off", reason: "required host dependency is missing: bwrap" });
    expect(copilotHostColumns(state, 0).signalBoundary).toEqual(state.signalBoundary);
    await host.release(); host = undefined;
  } finally { await host?.release(); warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test.each(engines)("boundary-off status survives the registry writer and restart: %s", engine => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-boundary-registry-"));
  const storage = { sqliteMode: "sqlite" as const, sqliteFilename: path.join(root, "registry.sqlite") };
  const store = new AgentRegistry(path.join(root, "registry.json"), () => false, undefined, storage);
  const key = { engine, sessionId: "signal-boundary-fixture" };
  const signalBoundary = { state: "off" as const, reason: "Linux namespaces are unavailable on darwin" };
  const state: HostState = { signalBoundary, status: "idle", sessionKey: key.sessionId, endpoint: "stdio:4242", pid: 4242,
    processStartIdentity: "4242:100", eventCursor: 0, protocolVersion: "fixture", activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null };
  try {
    store.upsert({ key, artifactPath: "/sessions/fixture.jsonl", cwd: "/repo", accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    store.setStructuredHost(key, engine === "codex" ? codexHostColumns(state, 0) : engine === "claude" ? claudeHostColumns(state, 0) : copilotHostColumns(state, 0));
    const reopened = new AgentRegistry(path.join(root, "registry.json"), () => false, undefined, storage);
    try { expect(reopened.readOnlySnapshot().entries[`${engine}:${key.sessionId}`]!.structuredHost!.signalBoundary).toEqual(signalBoundary); }
    finally { reopened.close(); }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("malformed boundary-off status is dropped rather than trusted", () => {
  expect(normalizeSignalBoundaryOff({ state: "off", reason: "x".repeat(900) })?.reason).toHaveLength(500);
  for (const value of [undefined, null, "off", { state: "on", reason: "x" }, { state: "off", reason: "" }, { state: "off", reason: 7 }]) {
    expect(normalizeSignalBoundaryOff(value)).toBeUndefined();
  }
});

/** A socket engine launched through each launcher path writes to stderr. */
async function socketStderr(shim: string, env: NodeJS.ProcessEnv, keep: boolean, root: string): Promise<string> {
  const go = path.join(root, `go-${keep}`);
  const child = await spawnSignalSandbox(shim, ["-c", `while [ ! -e '${go}' ]; do sleep 0.01; done; echo native-bind-cause >&2`], {
    env: { ...env, LLV_SIGNAL_IGNORE_NATIVE_STDIO: "1", ...(keep ? { LLV_SIGNAL_KEEP_NATIVE_STDERR: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  // Discarded stderr closes the pipe at once; an ended stream carries nothing.
  const errors = child.stderr!.readableEnded ? Promise.resolve("") : readAll(child.stderr!); child.stdout!.resume();
  fs.writeFileSync(go, "");
  await exited(child);
  return errors;
}

test.skipIf(process.platform !== "linux" || !tempOutsideHome).each([
  ["the container shim without python3", (root: string) => bridgeShim(root, path.join(root, "absent", "python3"))],
  ["the launcher boundary-off path", (root: string) => bridgeShim(root)],
] as const)("%s keeps native stderr only when the caller bounds it", async (_name, shimFor) => {
  if (_name.includes("launcher") && !fs.existsSync("/usr/bin/python3")) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-keep-stderr-"));
  const { enter } = recordingEnter(root);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const shim = shimFor(root);
    const env = fallbackEnv(root, { LLV_DOCKER_NSENTER_SHIMS: "1", FIXTURE_ENTER: enter });
    expect(await socketStderr(shim, env, true, root)).toContain("native-bind-cause");
    expect(await socketStderr(shim, env, false, root)).toBe("");
  } finally { warn.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

const KEY_BODY = Array.from({ length: 150 }, (_, line) => `KEYPAYLOAD${String(line).padStart(3, "0")}${"A".repeat(50)}`).join("\n");
const SECRET_STDERR = {
  "a complete key": `bind refused\n-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`,
  "a key clipped past the read bound": `bind refused\n-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n${KEY_BODY}\n`,
  "a bearer value and a private path": `bind refused\nAuthorization: ${["Bea", "rer"].join("")} ${"abcdefghij".repeat(3)}\n@ROOT@/private/file\n`,
};
test.skipIf(process.platform !== "linux").each(["closed", "rejected"] as const)("a launcher with %s spawn readiness keeps its cause and completes cleanup", async (readiness) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-ready-close-"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "python3"), readiness === "closed"
    ? "#!/bin/sh\nprintf 'bind refused during readiness\\n' >&2\nexit 9\n"
    : "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 });
  let child: ChildProcess | undefined;
  const start = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const launched = spawn(command, args, options);
    child = launched;
    launched.stderr?.resume();
    Object.assign(launched, { spawnReady: new Promise<void>((resolve, reject) => readiness === "closed"
      ? launched.once("close", () => resolve())
      : launched.once("spawn", () => reject(new Error("launcher readiness refused")))) });
    return launched;
  }) as typeof spawn;
  try {
    const env = fallbackEnv(root, { PATH: `${bin}:/usr/bin:/bin` });
    await expect(spawnSignalSandbox("/bin/true", [], { env, stdio: ["ignore", "pipe", "pipe"] }, start))
      .rejects.toThrow(readiness === "closed" ? "agent signal sandbox unavailable: bind refused during readiness" : "launcher readiness refused");
    if (readiness === "closed") expect(child!.exitCode).toBe(9);
    else expect(child!.signalCode).toBe("SIGKILL");
    expect(fs.readdirSync(root).filter(name => name.startsWith("delegatus-signal-"))).toEqual([]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [secret, text] of Object.entries(SECRET_STDERR)) for (const channel of ["pipe", "file"] as const) {
  test.skipIf(process.platform !== "linux")(`a launcher that fails after printing ${secret} on its ${channel} reports the cause without the secret`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-wrapper-secret-"));
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, "secret.txt"), text.replace("@ROOT@", root));
    // Stands in for a launcher whose setup fails after printing the secret.
    fs.writeFileSync(path.join(bin, "python3"), channel === "pipe"
      ? `#!/bin/sh\ncat '${path.join(root, "secret.txt")}' >&2\nexit 9\n`
      : `#!/bin/sh\ncat '${path.join(root, "secret.txt")}' > "$LLV_SIGNAL_DIAGNOSTIC"\nexit 9\n`, { mode: 0o755 });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = fallbackEnv(root, { PATH: `${bin}:/usr/bin:/bin`, ...(channel === "file" ? { LLV_SIGNAL_IGNORE_NATIVE_STDIO: "1" } : {}) });
      let message = "";
      try { await spawnSignalSandbox("/bin/true", [], { env, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (thrown) { message = (thrown as Error).message; }
      expect(message).toStartWith("agent signal sandbox unavailable: ");
      expect(message).toContain("bind refused");
      expect(message).not.toContain("KEYPAYLOAD");
      expect(message).not.toContain("PRIVATE KEY");
      expect(message).not.toContain("abcdefghij".repeat(3));
      expect(message).not.toContain(root);
      expect(message.length).toBeLessThanOrEqual(2100);
    } finally { error.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
}
