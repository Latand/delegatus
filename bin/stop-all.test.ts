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
  "const run = (suffix, childMode) => spawn(process.execPath, [process.argv[1], 'app-server', report + suffix, childMode], { stdio: 'ignore' });",
  /* Children start in this process's group. `leader`: a member with a child
     of its own, and a sibling; `orphaner`: a child that starts one of its own
     and exits, leaving it reparented. */
  "const child = mode === 'leaf' ? null : mode === 'leader' ? (run('.sibling', 'leaf'), run('.member', 'plain'))",
  "  : mode === 'orphaner' ? run('.middle', 'middle') : run('.leaf', 'leaf');",
  "fs.writeFileSync(report + '.tmp', JSON.stringify({ pid: process.pid, child: child?.pid ?? null }));",
  "fs.renameSync(report + '.tmp', report);",
  "if (mode === 'middle') setInterval(() => { if (fs.existsSync(report + '.leaf')) process.exit(0); }, 10);",
  "else setInterval(() => {}, 1000);",
  "",
].join("\n"));

let serial = 0;
/** A process tree as a structured host is started: detached, with a child.
    `socket` puts an install's runtime-host socket in its environment, as the
    launcher does for the Viewer and the runtime host it starts. */
async function startHost(mode: "plain" | "stubborn" = "plain", socket: string | null = null) {
  const report = spawnTree(mode, socket);
  for (let i = 0; i < 400 && !(fs.existsSync(report) && fs.existsSync(`${report}.leaf`)); i++) await Bun.sleep(25);
  const { pid, child: leafPid } = JSON.parse(fs.readFileSync(report, "utf8")) as { pid: number; child: number };
  const root = { pid, identity: probe!.identity(pid)! };
  const leaf = { pid: leafPid, identity: probe!.identity(leafPid)! };
  owned.push(root, leaf);
  return { root, leaf, launcherIdentity: probe!.launcherIdentity(pid)! };
}

/** Starts the script detached, leading a process group of its own; returns its report file. */
function spawnTree(mode: string, socket: string | null = null): string {
  const report = path.join(SANDBOX, `host-${++serial}.json`);
  const env = { ...process.env };
  delete env.LLV_RUNTIME_HOST_SOCKET;
  if (socket) env.LLV_RUNTIME_HOST_SOCKET = socket;
  handles.push(spawn(process.execPath, [HOST, "app-server", report, mode], { detached: true, stdio: "ignore", env }));
  return report;
}

/** The pid a report file names once it is written, recorded for cleanup when `own`. */
async function reported(file: string, own = true) {
  for (let i = 0; i < 400 && !fs.existsSync(file); i++) await Bun.sleep(25);
  const { pid } = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number };
  const entry = { pid, identity: probe!.identity(pid)! };
  if (own) owned.push(entry);
  return entry;
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

test.skipIf(!probe)("a recorded host that does not lead its process group stops alone: the group's unrecorded leader and other members keep running", async () => {
  const state = stateDirectory();
  /* An unrecorded process leads the group; the recorded host started inside
     it, as a host started from a tmux pane's shell job would be. */
  const report = spawnTree("leader");
  const leader = await reported(report);
  const sibling = await reported(`${report}.sibling`);
  const member = await reported(`${report}.member`);
  const memberLeaf = await reported(`${report}.member.leaf`);
  const table = probe!.table();
  expect([leader, sibling, member, memberLeaf].map(({ pid }) => table.get(pid)?.pgid)).toEqual([leader.pid, leader.pid, leader.pid, leader.pid]);
  await writeRegistry(state, [hostEntry("member", identity(member.pid, member.identity))]);

  const result = await stopEverything({ stateDirectory: state, ...quick });

  expect([member, memberLeaf].map(alive)).toEqual([false, false]);
  expect([leader, sibling].map(alive)).toEqual([true, true]);
  expect(result.stopped).toEqual([{ pid: member.pid, kind: "codex-app-server", session: "codex member", under: 1 }]);
  expect(result.survived).toEqual([]);
});

test.skipIf(!probe)("a member of the group a recorded host leads is stopped with it after it was reparented away", async () => {
  const state = stateDirectory();
  const report = spawnTree("orphaner");
  const root = await reported(report);
  const middle = await reported(`${report}.middle`, false);
  const orphan = await reported(`${report}.middle.leaf`);
  for (let i = 0; i < 400 && probe!.identity(middle.pid) !== null; i++) await Bun.sleep(25);
  /* Its parent exited: it is no descendant of the recorded host, only a member of its group. */
  const table = probe!.table();
  const ancestors = new Set<number>();
  for (let pid = orphan.pid; pid > 1 && !ancestors.has(pid); pid = table.get(pid)?.ppid ?? 0) ancestors.add(pid);
  expect(probe!.identity(middle.pid)).toBeNull();
  expect(ancestors.has(root.pid)).toBe(false);
  expect(table.get(orphan.pid)?.pgid).toBe(root.pid);
  await writeRegistry(state, [hostEntry("orphaner", identity(root.pid, root.identity))]);

  const result = await stopEverything({ stateDirectory: state, ...quick });

  expect([root, orphan].map(alive)).toEqual([false, false]);
  expect(result.stopped).toEqual([{ pid: root.pid, kind: "codex-app-server", session: "codex orphaner", under: 1 }]);
});

test("the kill phase signals a captured process only while its identity matches: a pid reused before SIGTERM or before SIGKILL gets nothing more", async () => {
  const state = stateDirectory();
  const epoch = "linux:fixture-boot:pidns:pid:[4026531836]";
  /* Three recorded hosts as an injected probe reads them; nothing here is a
     real process. A pid marked `reusedAfterCapture` reads as its recorded
     process once after the process table is taken (the check that captures
     it), then as another process at the same pid. `term` is what SIGTERM
     does to the recorded process; `reused` ends it and starts another
     process at its pid. */
  type Fixture = { ppid: number; pgid: number; identity: string | null; term: "exit" | "ignore" | "reused"; reusedAfterCapture?: boolean; reads: number };
  const processes = new Map<number, Fixture>([
    [4_000_100, { ppid: 1, pgid: 4_000_100, identity: "4000100:7", term: "exit", reusedAfterCapture: true, reads: 0 }],
    [4_000_200, { ppid: 1, pgid: 4_000_200, identity: "4000200:7", term: "ignore", reads: 0 }],
    [4_000_201, { ppid: 4_000_200, pgid: 4_000_200, identity: "4000201:7", term: "reused", reads: 0 }],
    [4_000_300, { ppid: 1, pgid: 4_000_300, identity: "4000300:7", term: "exit", reads: 0 }],
    [4_000_301, { ppid: 4_000_300, pgid: 4_000_300, identity: "4000301:7", term: "exit", reusedAfterCapture: true, reads: 0 }],
  ]);
  const recorded = (pid: number) => `${pid}:7`;
  const reuse = (pid: number, row: Fixture) => { row.identity = `${pid}:99`; row.reusedAfterCapture = false; };
  let tableTaken = false;
  const signals: string[] = [];
  const fake = {
    identity(pid: number) {
      const row = processes.get(pid);
      if (!row) return null;
      if (tableTaken && row.reusedAfterCapture && ++row.reads > 1) reuse(pid, row);
      return row.identity;
    },
    launcherIdentity: () => null,
    bootEpoch: () => epoch,
    bootTimeMs: () => 0,
    ownsInstall: () => false,
    table() {
      tableTaken = true;
      return new Map([...processes].filter(([, row]) => row.identity !== null).map(([pid, row]) => [pid, { ppid: row.ppid, pgid: row.pgid }]));
    },
  };
  const signal = (pid: number, value: NodeJS.Signals) => {
    const row = processes.get(pid);
    signals.push(`${pid}:${row?.identity}:${value}`);
    if (!row || row.identity !== recorded(pid)) return;
    if (value === "SIGKILL" || row.term === "exit") row.identity = null;
    else if (row.term === "reused") reuse(pid, row);
  };
  await writeRegistry(state, [4_000_100, 4_000_200, 4_000_300].map((pid) =>
    hostEntry(`h${pid}`, { pid, startIdentity: recorded(pid), bootEpoch: epoch })));

  const report = await stopEverything({ stateDirectory: state, probe: fake as unknown as ReturnType<typeof processProbe>, signal,
    graceMs: 40, killMs: 40, pollMs: 5, launcherWaitMs: 40 });

  /* The pid reused before SIGTERM (a recorded root and a member) gets no
     signal; the one reused after SIGTERM gets no SIGKILL. */
  expect([...signals].sort()).toEqual([
    "4000200:4000200:7:SIGKILL", "4000200:4000200:7:SIGTERM", "4000201:4000201:7:SIGTERM", "4000300:4000300:7:SIGTERM",
  ]);
  expect(signals.at(-1)).toBe("4000200:4000200:7:SIGKILL");
  expect([...report.stopped].sort((a, b) => a.pid - b.pid)).toEqual([
    { pid: 4_000_200, kind: "codex-app-server", session: "codex h4000200", under: 1 },
    { pid: 4_000_300, kind: "codex-app-server", session: "codex h4000300", under: 0 },
  ]);
  expect(report.survived).toEqual([]);
  expect(report.gone).toBe(1);
  expect(report.notProven).toEqual([]);
  expect(stopSucceeded(report)).toBe(true);
});

function writeLauncherRecord(state: string, name: string, record: unknown) {
  const file = path.join(state, "self-update", `launcher-${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record), { mode: 0o600 });
}

test.skipIf(!probe)("every recorded launcher is asked first, and a Viewer one left running is stopped by its own record", async () => {
  const state = stateDirectory();
  const socket = path.join(SANDBOX, `runtime-${serial}.sock`);
  /* Launcher stand-ins that exit on SIGTERM without stopping their Viewer:
     a global install and a `bunx` cache keep a record each. */
  const launcher = await startHost();
  const second = await startHost();
  const web = await startHost("plain", socket);
  const decoy = await startHost("plain", socket);
  writeLauncherRecord(state, "global", {
    version: 1, launcher: { pid: launcher.root.pid, startIdentity: launcher.launcherIdentity, bootEpoch: probe!.bootEpoch() }, socket,
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

test.skipIf(!probe)("a recorded Viewer or runtime host is stopped only when its own environment carries this install's socket", async () => {
  const state = stateDirectory();
  const socket = path.join(SANDBOX, `runtime-${serial}.sock`);
  /* The recorded pid and start identity match, which a reused pid at the
     same start tick also would; neither carries this install's socket. */
  const bare = await startHost();
  const otherInstall = await startHost("plain", `${socket}.other`);
  writeLauncherRecord(state, "a", {
    version: 1, launcher: { pid: 999_999_999, startIdentity: "1", bootEpoch: probe!.bootEpoch() }, socket,
    web: { state: "healthy", pid: bare.root.pid, startIdentity: bare.launcherIdentity },
    runtimeHost: { state: "healthy", pid: otherInstall.root.pid, startIdentity: otherInstall.launcherIdentity },
  });
  const report = await stopEverything({ stateDirectory: state, ...quick });
  expect([bare.root, bare.leaf, otherInstall.root, otherInstall.leaf].map(alive)).toEqual([true, true, true, true]);
  expect(report.services).toEqual([
    { role: "web", pid: bare.root.pid, state: "not-proven" },
    { role: "runtimeHost", pid: otherInstall.root.pid, state: "not-proven" },
  ]);
  expect(stopSucceeded(report)).toBe(false);
  expect(formatStopReport(report, "en")).toContain(`Left the Viewer (pid ${bare.root.pid}) running: it does not carry this install's runtime-host socket`);
});

/* An epoch of a boot that is not this one, and of this boot seen from a pid
   namespace that is not this process's. */
const otherBoot = (epoch: string) => epoch.startsWith("linux:")
  ? epoch.replace(/^linux:[^:]+/, "linux:00000000-0000-0000-0000-000000000000") : "darwin:1:0";
const otherNamespace = (epoch: string) => epoch.replace(/:pidns:.*$/, ":pidns:pid:[1]");

test.skipIf(!probe)("a launcher record from before this boot names nothing: its launcher, Viewer and runtime host stay running", async () => {
  const state = stateDirectory();
  const socket = path.join(SANDBOX, `runtime-${serial}.sock`);
  /* What a crash or power loss leaves: the record outlives its boot, and the
     pids it names now belong to other processes, here at the very start
     ticks it recorded. A record from a launcher that predates the recorded
     epoch is dated by its file. */
  const launcher = await startHost();
  const web = await startHost("plain", socket);
  const host = await startHost("plain", socket);
  writeLauncherRecord(state, "legacy", {
    version: 1, launcher: { pid: launcher.root.pid, startIdentity: launcher.launcherIdentity }, socket,
    web: { state: "healthy", pid: web.root.pid, startIdentity: web.launcherIdentity },
    runtimeHost: { state: "healthy", pid: host.root.pid, startIdentity: host.launcherIdentity },
  });
  fs.utimesSync(path.join(state, "self-update", "launcher-legacy.json"), 0, 0);
  /* A current record names its boot. */
  writeLauncherRecord(state, "recorded", {
    version: 1, launcher: { pid: launcher.root.pid, startIdentity: launcher.launcherIdentity, bootEpoch: otherBoot(probe!.bootEpoch()!) }, socket,
    web: { state: "healthy", pid: web.root.pid, startIdentity: web.launcherIdentity },
  });

  const report = await stopEverything({ stateDirectory: state, ...quick });

  expect([launcher.root, launcher.leaf, web.root, web.leaf, host.root, host.leaf].map(alive)).toEqual([true, true, true, true, true, true]);
  expect(report.launchers).toEqual([
    { state: "earlier-boot", detail: "launcher-legacy.json" },
    { state: "earlier-boot", detail: "launcher-recorded.json" },
  ]);
  expect(report.services).toEqual([]);
  expect(stopSucceeded(report)).toBe(true);
  expect(formatStopReport(report, "en")).toContain("The launcher record launcher-legacy.json was written before this computer last started; nothing was stopped by it.");
  expect(formatStopReport(report, "uk")).toContain("Запис лаунчера launcher-legacy.json зроблено до останнього запуску комп'ютера");
  for (const lang of ["en", "uk"]) expect(formatStopReport(report, lang)).not.toContain("earlier-boot");
});

test.skipIf(!probe)("registry hosts: another boot's record names nothing; another pid namespace's is not proven, never gone", async () => {
  const state = stateDirectory();
  const epoch = probe!.bootEpoch()!;
  const earlier = await startHost();
  const elsewhere = await startHost();
  const entries = [
    /* A live process at the recorded pid and start identity, recorded in an earlier boot. */
    hostEntry("earlier", { pid: earlier.root.pid, startIdentity: earlier.root.identity, bootEpoch: otherBoot(epoch) }),
  ];
  const namespaced = epoch.includes(":pidns:");
  if (namespaced) {
    entries.push(
      hostEntry("elsewhere", { pid: elsewhere.root.pid, startIdentity: elsewhere.root.identity, bootEpoch: otherNamespace(epoch) }),
      /* A pid that reads as missing from here proves nothing about the namespace that recorded it. */
      hostEntry("unseen", { pid: 999_999_999, startIdentity: "999999999:1", bootEpoch: otherNamespace(epoch) }),
    );
  }
  await writeRegistry(state, entries);

  const report = await stopEverything({ stateDirectory: state, ...quick });

  expect([earlier.root, earlier.leaf, elsewhere.root, elsewhere.leaf].map(alive)).toEqual([true, true, true, true]);
  expect(report.stopped).toEqual([]);
  expect(report.gone).toBe(1);
  if (namespaced) {
    expect(report.notProven.map((entry: { session: string | null; reason: string }) => `${entry.session}:${entry.reason}`))
      .toEqual(["codex elsewhere:other-pid-namespace", "codex unseen:other-pid-namespace"]);
    expect(stopSucceeded(report)).toBe(false);
    expect(formatStopReport(report, "en")).toContain(`codex-app-server pid ${elsewhere.root.pid} (codex elsewhere): recorded in another process namespace, so it cannot be checked from here`);
  } else {
    expect(report.notProven).toEqual([]);
    expect(stopSucceeded(report)).toBe(true);
  }
});

test.skipIf(!probe?.bootEpoch()?.includes(":pidns:"))("a launcher record from another pid namespace is not proven, and its launcher stays running", async () => {
  const state = stateDirectory();
  const launcher = await startHost();
  writeLauncherRecord(state, "a", {
    version: 1, launcher: { pid: launcher.root.pid, startIdentity: launcher.launcherIdentity, bootEpoch: otherNamespace(probe!.bootEpoch()!) },
  });
  const report = await stopEverything({ stateDirectory: state, ...quick });
  expect(alive(launcher.root)).toBe(true);
  expect(report.launchers).toEqual([{ state: "not-proven", pid: launcher.root.pid, detail: "launcher-a.json", reason: "other-pid-namespace" }]);
  expect(stopSucceeded(report)).toBe(false);
  expect(formatStopReport(report, "en")).toContain(`Left the launcher (pid ${launcher.root.pid}) of launcher-a.json and what it started alone: it was recorded in another process namespace`);
  expect(formatStopReport(report, "uk")).toContain("його записано в іншому просторі імен процесів");
});

test.skipIf(!probe)("where the boot cannot be read, nothing recorded is signalled and the command fails", async () => {
  const state = stateDirectory();
  const launcher = await startHost();
  const host = await startHost();
  writeLauncherRecord(state, "a", { version: 1, launcher: { pid: launcher.root.pid, startIdentity: launcher.launcherIdentity } });
  await writeRegistry(state, [
    hostEntry("host", identity(host.root.pid, host.root.identity)),
    hostEntry("gone", identity(999_999_999, "999999999:1")),
  ]);
  const blind = { ...probe!, bootEpoch: () => null, bootTimeMs: () => null };
  const report = await stopEverything({ stateDirectory: state, probe: blind, ...quick });
  expect([launcher.root, host.root, host.leaf].map(alive)).toEqual([true, true, true]);
  expect(report.launchers).toEqual([{ state: "not-proven", pid: launcher.root.pid, detail: "launcher-a.json", reason: "unverifiable" }]);
  expect(report.notProven.map((entry: { session: string | null; reason: string }) => `${entry.session}:${entry.reason}`))
    .toEqual(["codex host:unverifiable", "codex gone:unverifiable"]);
  expect(report.gone).toBe(0);
  expect(stopSucceeded(report)).toBe(false);
});

test.skipIf(!probe)("the launcher record names the boot epoch the stop compares against", async () => {
  const { createLauncherRecord } = await import("./self-update-supervisor.mjs");
  const file = path.join(stateDirectory(), "launcher-x.json");
  createLauncherRecord(file, { checkout: null, releasesDir: SANDBOX, releasePointer: path.join(SANDBOX, "release.json"),
    requestFile: path.join(SANDBOX, "request.json"), port: 0, socket: path.join(SANDBOX, "x.sock") }).set("launcher", { state: "ready" });
  expect(JSON.parse(fs.readFileSync(file, "utf8")).launcher.bootEpoch).toBe(probe!.bootEpoch());
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
