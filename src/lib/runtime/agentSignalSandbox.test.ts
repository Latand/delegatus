import { expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity, systemBootEpoch } from "@/lib/processIdentity";
import { codexHostColumns, claudeHostColumns, copilotHostColumns } from "./registry";
import { normalizeAgentSignalDomain, normalizeSignalBoundaryOff, signalBoundaryOff, signalDomain, spawnHeadlessSignalSandbox, spawnManagedEngine,
  spawnSignalSandbox, terminalSignalSandboxCommand, type AgentSignalDomain } from "./agentSignalSandbox";
import { CopilotAcpHost } from "./copilotAcpHost";
import { FileRuntimeEventStore } from "./eventStore";
import type { HostState } from "./engineHost";
import { Database } from "bun:sqlite";
import { cpuOwnerExited, cpuOwnerStatus } from "./signalSandboxContext";

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
    expect(terminalSignalSandboxCommand("exec claude", fallbackEnv(root, extra))).toBe("exec claude");
    expect(warn.mock.calls.filter(call => String(call[0]).includes("without the agent signal boundary"))).toHaveLength(4);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    getuid?.mockRestore(); warn.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
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
