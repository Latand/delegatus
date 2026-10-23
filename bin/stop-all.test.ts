import { afterAll, afterEach, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatStopReport, processProbe, registryTargets, stopEverything, stopSucceeded } from "./stop-all.mjs";

/* `delegatus stop --all` against processes this file starts and a registry the
   real store writes, in a private state directory. Nothing else is signalled:
   every recorded pid, the decoys included, is one of this file's children. */

const probe = processProbe();
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stop-all-"));
const owned: Array<{ pid: number; identity: string }> = [];
const handles: ChildProcess[] = [];
/* Each test ends every process it started, by the identity recorded at its
   start, and waits until they are gone. */
afterEach(async () => {
  const live = () => owned.filter(({ pid, identity }) => probe?.identity(pid) === identity);
  for (const { pid } of live()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  for (let i = 0; i < 200 && live().length; i++) await Bun.sleep(10);
  expect(live()).toEqual([]);
  /* Gone is not reaped: the runner reaps its own children on their exit. */
  await Promise.all(handles.map((child) => child.exitCode !== null || child.signalCode !== null
    ? undefined : new Promise((resolve) => child.once("exit", resolve))));
  owned.length = 0;
  handles.length = 0;
});
afterAll(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

const alive = (entry: { pid: number; identity: string }) => probe!.identity(entry.pid) === entry.identity;

/* One script for every process here, so a recorded host and a foreign one
   carry the same name and the same command line. */
const HOST = path.join(SANDBOX, "codex");
fs.writeFileSync(HOST, [
  "import { spawn } from 'node:child_process';",
  "import fs from 'node:fs';",
  "const [, , , report, mode] = process.argv;",
  "if (mode === 'stubborn') process.on('SIGTERM', () => {});",
  "const child = mode === 'leaf' ? null : spawn(process.execPath, [process.argv[1], 'app-server', report + '.leaf', 'leaf'], { stdio: 'ignore' });",
  "fs.writeFileSync(report + '.tmp', JSON.stringify({ pid: process.pid, child: child?.pid ?? null }));",
  "fs.renameSync(report + '.tmp', report);",
  "setInterval(() => {}, 1000);",
  "",
].join("\n"));

let serial = 0;
/** A process tree as a structured host is started: detached, with a child. */
async function startHost(mode: "plain" | "stubborn" = "plain") {
  const report = path.join(SANDBOX, `host-${++serial}.json`);
  const child = spawn(process.execPath, [HOST, "app-server", report, mode], { detached: true, stdio: "ignore" });
  handles.push(child);
  for (let i = 0; i < 400 && !(fs.existsSync(report) && fs.existsSync(`${report}.leaf`)); i++) await Bun.sleep(25);
  const { pid, child: leafPid } = JSON.parse(fs.readFileSync(report, "utf8")) as { pid: number; child: number };
  const root = { pid, identity: probe!.identity(pid)! };
  const leaf = { pid: leafPid, identity: probe!.identity(leafPid)! };
  owned.push(root, leaf);
  return { root, leaf, launcherIdentity: probe!.launcherIdentity(pid)! };
}

function stateDirectory(): string {
  const directory = path.join(SANDBOX, `state-${++serial}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

const identity = (pid: number, startIdentity: string | null) => ({ pid, startIdentity, bootEpoch: probe!.bootEpoch() });

function hostEntry(sessionId: string, process: { pid: number; startIdentity: string | null; bootEpoch: string | null }, extra: Record<string, unknown> = {}) {
  return {
    key: { engine: "codex", sessionId }, artifactPath: `/sessions/${sessionId}.jsonl`, cwd: "/work", accountId: null,
    status: "idle", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: `stdio:${sessionId}`, process, eventCursor: 0, protocolVersion: "fixture-v1",
      writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: null, pendingAction: null, updatedAt: "2026-10-21T15:00:00.000Z", ...extra,
  };
}

/* Written by the registry's own store, as a Viewer writes it. */
async function writeRegistry(state: string, entries: ReturnType<typeof hostEntry>[]) {
  const { AgentRegistry, normalizeRegistry } = await import("@/lib/agent/registry");
  const { SqliteAgentRegistryStore } = await import("@/lib/agent/sqliteRegistryStore");
  const seed = new AgentRegistry(path.join(state, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const initial = seed.snapshot();
  seed.close();
  for (const entry of entries) (initial.entries as Record<string, unknown>)[`codex:${entry.key.sessionId}`] = entry;
  const store = new SqliteAgentRegistryStore(path.join(state, "agent-registry.sqlite"), { initialSnapshot: initial, normalize: normalizeRegistry });
  store.close();
}

const quick = { graceMs: 1_000, killMs: 2_000, pollMs: 20, launcherWaitMs: 3_000 };

test.skipIf(!probe)("only recorded hosts stop: a same-named foreign process, a reused pid and an unproven record stay running", async () => {
  const state = stateDirectory();
  const host = await startHost();
  const stubborn = await startHost("stubborn");
  const foreign = await startHost();
  const reused = await startHost();
  const unproven = await startHost();
  const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const exitedIdentity = await new Promise<string>((resolve) => {
    const recorded = probe!.identity(exited.pid!) ?? `${exited.pid}:0`;
    exited.once("exit", () => resolve(recorded));
  });
  await writeRegistry(state, [
    hostEntry("host", identity(host.root.pid, host.root.identity)),
    hostEntry("stubborn", identity(stubborn.root.pid, stubborn.root.identity)),
    /* The kernel handed the recorded pid to another process. */
    hostEntry("reused", identity(reused.root.pid, `${reused.root.pid}:1`)),
    hostEntry("unproven", identity(unproven.root.pid, null)),
    hostEntry("exited", identity(exited.pid!, exitedIdentity)),
  ]);
  /* The registry store kept every row this reader depends on. */
  const { readRegistryEntries } = await import("./stop-all.mjs");
  expect((await readRegistryEntries(state)).entries.map((entry: { key: { sessionId: string } }) => entry.key.sessionId).sort())
    .toEqual(["exited", "host", "reused", "stubborn", "unproven"]);

  const report = await stopEverything({ stateDirectory: state, ...quick });

  expect([host.root, host.leaf, stubborn.root, stubborn.leaf].map(alive)).toEqual([false, false, false, false]);
  expect([foreign.root, foreign.leaf, reused.root, reused.leaf, unproven.root, unproven.leaf].map(alive)).toEqual([true, true, true, true, true, true]);
  expect(report.registry).toEqual({ state: "read" });
  expect(report.stopped.map((entry: { pid: number }) => entry.pid).sort()).toEqual([host.root.pid, stubborn.root.pid].sort());
  for (const entry of report.stopped) expect(entry).toMatchObject({ kind: "codex-app-server", under: 1 });
  expect(report.gone).toBe(2);
  expect(report.notProven).toEqual([expect.objectContaining({ pid: unproven.root.pid, reason: "no-recorded-identity" })]);
  expect(report.survived).toEqual([]);
  expect(stopSucceeded(report)).toBe(true);
});

function writeLauncherRecord(state: string, name: string, record: unknown) {
  const file = path.join(state, "self-update", `launcher-${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record), { mode: 0o600 });
}

test.skipIf(!probe)("every recorded launcher is asked first, and a Viewer one left running is stopped by its own record", async () => {
  const state = stateDirectory();
  /* Launcher stand-ins that exit on SIGTERM without stopping their Viewer:
     a global install and a `bunx` cache keep a record each. */
  const launcher = await startHost();
  const second = await startHost();
  const web = await startHost();
  const decoy = await startHost();
  writeLauncherRecord(state, "global", {
    version: 1, launcher: { pid: launcher.root.pid, startIdentity: launcher.launcherIdentity },
    web: { state: "healthy", pid: web.root.pid, startIdentity: web.launcherIdentity },
    /* Recorded under an identity the live process does not have. */
    runtimeHost: { state: "healthy", pid: decoy.root.pid, startIdentity: "0" },
  });
  writeLauncherRecord(state, "bunx", { version: 1, launcher: { pid: second.root.pid, startIdentity: second.launcherIdentity } });

  const report = await stopEverything({ stateDirectory: state, ...quick });

  expect(report.launchers).toEqual([{ pid: second.root.pid, state: "stopped" }, { pid: launcher.root.pid, state: "stopped" }]);
  expect(report.services).toEqual([{ role: "web", pid: web.root.pid, state: "stopped" }]);
  expect([launcher.root, second.root, web.root, web.leaf].map(alive)).toEqual([false, false, false, false]);
  expect([decoy.root, decoy.leaf].map(alive)).toEqual([true, true]);
  expect(report.registry).toEqual({ state: "missing" });
  expect(stopSucceeded(report)).toBe(true);
});

test.skipIf(!probe)("a launcher that ignores SIGTERM past the wait is killed; a changed identity is left alone; an unreadable record fails the command", async () => {
  const state = stateDirectory();
  const stubborn = await startHost("stubborn");
  writeLauncherRecord(state, "a", { version: 1, launcher: { pid: stubborn.root.pid, startIdentity: stubborn.launcherIdentity } });
  const report = await stopEverything({ stateDirectory: state, ...quick, launcherWaitMs: 300 });
  expect(report.launchers).toEqual([{ pid: stubborn.root.pid, state: "killed" }]);
  expect(alive(stubborn.root)).toBe(false);

  const other = await startHost();
  writeLauncherRecord(state, "a", { version: 1, launcher: { pid: other.root.pid, startIdentity: "1" } });
  const left = await stopEverything({ stateDirectory: state, ...quick });
  expect(left.launchers).toEqual([]);
  expect(alive(other.root)).toBe(true);
  expect(stopSucceeded(left)).toBe(true);

  writeLauncherRecord(state, "b", "{ torn");
  const torn = await stopEverything({ stateDirectory: state, ...quick });
  expect(torn.launchers).toEqual([expect.objectContaining({ state: "unreadable" })]);
  expect(alive(other.root)).toBe(true);
  expect(stopSucceeded(torn)).toBe(false);
  expect(formatStopReport(torn, "en")).toContain("A launcher record could not be read (launcher-b.json: ");
});

test.skipIf(!probe)("without a way to prove identity nothing is signalled, and the command says so", async () => {
  const state = stateDirectory();
  const host = await startHost();
  await writeRegistry(state, [hostEntry("host", identity(host.root.pid, host.root.identity))]);
  const report = await stopEverything({ stateDirectory: state, platform: "win32", probe: null, ...quick });
  expect(alive(host.root)).toBe(true);
  expect(report.supported).toBe(false);
  expect(report.notProven).toEqual([expect.objectContaining({ pid: host.root.pid, reason: "unsupported-platform" })]);
  expect(stopSucceeded(report)).toBe(false);
  expect(formatStopReport(report, "en")).toContain("Stopping agent hosts is not supported on win32");
  expect(formatStopReport(report, "uk")).toContain("На win32 зупинка хостів агентів не підтримується");
});

test.skipIf(!probe)("an unreadable registry stops no agent host and fails the command", async () => {
  const state = stateDirectory();
  fs.writeFileSync(path.join(state, "agent-registry.sqlite"), "not a database");
  const report = await stopEverything({ stateDirectory: state, ...quick });
  expect(report.registry.state).toBe("unreadable");
  expect(stopSucceeded(report)).toBe(false);
  expect(formatStopReport(report, "en")).toContain("The agent registry could not be read");
});

test("every process a registry row records is a target once: host, live signal sandbox, survivors and tmux agent", () => {
  const process = (pid: number) => ({ pid, startIdentity: `${pid}:9`, bootEpoch: "linux:boot" });
  const targets = registryTargets([
    { key: { engine: "codex", sessionId: "a" }, structuredHost: { kind: "codex-app-server", process: process(10),
      signalDomain: { monitor: process(11), bubblewrap: process(12), init: process(13), native: process(10) } },
      structuredTerminationSurvivors: [process(14), process(10)] },
    { key: { engine: "claude", sessionId: "b" }, structuredHost: { kind: "claude-broker", process: process(20),
      signalDomain: { monitor: process(21), bubblewrap: process(22), init: process(23), native: process(24), retired: true } } },
    { key: { engine: "claude", sessionId: "c" }, host: { kind: "tmux", agent: process(30) }, structuredHost: null },
    { key: { engine: "codex", sessionId: "d" }, structuredHost: { kind: "codex-app-server", process: null } },
    { key: { engine: "codex", sessionId: "e" }, structuredHost: { kind: "codex-app-server", process: { pid: 1, startIdentity: "1:1" } } },
  ]);
  expect(targets.map((target: { pid: number; kind: string }) => `${target.pid}:${target.kind}`)).toEqual([
    "10:codex-app-server", "11:signal-sandbox", "12:signal-sandbox", "13:signal-sandbox", "14:survivor",
    "20:claude-broker", "30:tmux-agent",
  ]);
  expect(targets[0]).toEqual({ pid: 10, startIdentity: "10:9", bootEpoch: "linux:boot", kind: "codex-app-server", session: "codex a" });
});

test("the report names what was stopped and what was left, in words, in both languages", () => {
  const report: Parameters<typeof formatStopReport>[0] = {
    platform: "linux", supported: true, launchers: [{ pid: 41, state: "stopped" }],
    services: [{ role: "runtimeHost", pid: 42, state: "stopped" }], registry: { state: "read" },
    stopped: [{ pid: 50, kind: "codex-app-server", session: "codex s1", under: 3 }], gone: 2,
    notProven: [{ pid: 60, startIdentity: null, bootEpoch: null, kind: "claude-broker", session: null, reason: "no-recorded-identity" }], survived: [],
  };
  const en = formatStopReport(report, "en");
  expect(en.split("\n")).toEqual([
    "Delegatus stop --all",
    "Stopped the launcher (pid 41), and with it the Viewer and the runtime host it started.",
    "Stopped the runtime host (pid 42) that the launcher left running.",
    "Stopped agent hosts:",
    "  codex-app-server pid 50 (codex s1), and 3 processes under it",
    "2 recorded processes were already gone.",
    "Left running, not proven to be Delegatus's:",
    "  claude-broker pid 60: recorded without a start identity",
  ]);
  const uk = formatStopReport(report, "uk");
  expect(uk).toContain("Зупинено лаунчер (pid 41)");
  expect(uk).toContain("записаний без ідентичності запуску");
  for (const text of [en, uk]) expect(text).not.toContain("no-recorded-identity");
});

/* The command as a person runs it: the real launcher entry, in a fresh
   process, against an empty private state. */
function runCli(args: string[], state: string) {
  const home = path.join(SANDBOX, `home-${++serial}`);
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    LLV_STATE_DIR: state, TMPDIR: SANDBOX, LLV_LANG: "en" };
  delete env.LLV_STATE_OWNER;
  delete env.LLV_LAUNCHER_REEXEC;
  return spawnSync(process.execPath, [path.resolve(import.meta.dir, "cli.mjs"), ...args], { env, encoding: "utf8", timeout: 60_000 });
}

test.skipIf(!probe)("delegatus stop --all on an install with nothing running reports so and exits 0; stop alone prints its usage", () => {
  const state = stateDirectory();
  const stopped = runCli(["stop", "--all"], state);
  expect(stopped.status).toBe(0);
  expect(stopped.stdout).toContain("No running launcher is recorded.");
  expect(stopped.stdout).toContain("No agent registry: no agent host is recorded.");
  const usage = runCli(["stop"], state);
  expect(usage.status).toBe(2);
  expect(usage.stdout).toContain("Usage: delegatus stop --all");
}, 120_000);

test.skipIf(!probe)("the menu's entry stops a recorded host in a fresh process and writes its report", async () => {
  const state = stateDirectory();
  const host = await startHost();
  await writeRegistry(state, [hostEntry("host", identity(host.root.pid, host.root.identity))]);
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dir, "stop-all.mjs"), "--state-dir", state, "--lang", "uk"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, LLV_STATE_DIR: state } });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Зупинено хости агентів:");
  expect(result.stdout).toContain(`codex-app-server pid ${host.root.pid} (codex host)`);
  expect([host.root, host.leaf].map(alive)).toEqual([false, false]);
}, 120_000);
