import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-scan-integrity-"));
const previousEnvironment = Object.fromEntries(["LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "TMPDIR"].map((key) => [key, process.env[key]]));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.TMPDIR = path.join(sandbox, "tmp");
const sessions = path.join(process.env.LLV_CODEX_HOME, "sessions");
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { cachedFileScan, currentFileScan, resetFilesRouteCacheForTests, setFileScanRunnerForTests } = await import("./scanCache");
const { runFileCatalogScan } = await import("./scanCoordinator");
const { listFilesWithProjectCatalog } = await import("./index");
const { tailRecordsResult, transcriptTurnResult } = await import("./activity");
const { AgentRegistry, closeAgentRegistryForTests } = await import("@/lib/agent/registry");
const { reconcileMigrationInventory } = await import("@/lib/accounts/migration/coordinator");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");

const header = JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/scan-integrity" } });
const started = JSON.stringify({ type: "event_msg", payload: { type: "task_started" } });
const completed = JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } });
const paths: string[] = [];
function transcript(name: string, body: string): string {
  const filename = path.join(sessions, `${name}.jsonl`);
  fs.writeFileSync(filename, `${header}\n${body}`);
  paths.push(filename);
  return filename;
}

afterEach(() => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(null);
  for (const filename of paths.splice(0)) fs.unlinkSync(filename);
});
afterAll(() => {
  closeAgentRegistryForTests();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("a damaged historical tail retains its row and cannot block a healthy current inventory", async () => {
  const damaged = transcript("damaged", `{broken}\n${completed}\n`);
  const healthy = transcript("healthy", `${started}\n`);
  const scan = await currentFileScan({ fresh: true });
  expect(scan.snapshot.complete).toBe(true);
  expect(scan.snapshot.files.find((entry) => entry.path === healthy)).toMatchObject({
    derivationComplete: true, authoritativeTurn: { state: "busy" },
  });
  const unknown = scan.snapshot.files.find((entry) => entry.path === damaged)!;
  expect(unknown).toMatchObject({ derivationComplete: false });
  expect(unknown.authoritativeTurn).toBeUndefined();
  expect(transcriptTurnResult(damaged, unknown.size, unknown.mtime * 1000, "codex")).toMatchObject({
    complete: false, turn: { state: "unknown" },
  });

  const registry = new AgentRegistry(path.join(sandbox, "inventory.json"), undefined, undefined, { sqliteMode: "off" });
  try {
    const conversation = registry.ensureConversation("codex", damaged, "default");
    registry.reconcileConversations([{
      engine: "codex", path: damaged, accountId: null, launchProfile: emptyLaunchProfile({ cwd: "/repo/scan-integrity" }),
      turn: { state: "busy", source: "lifecycle", terminalAt: null }, observedAt: new Date().toISOString(),
    }]);
    await reconcileMigrationInventory(registry, scan.snapshot.files);
    expect(registry.conversation(conversation.id)?.turn.state).toBe("busy");
  } finally {
    registry.close();
  }
});

test("an append during hydration is retried at its current identity", async () => {
  const filename = transcript("growing", `${completed}\n`);
  const originalOpen = fs.openSync;
  const originalStat = fs.fstatSync;
  const originalClose = fs.closeSync;
  const tracked = new Set<number>();
  let appended = false;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = originalOpen(target, flags, mode);
    if (target === filename) tracked.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.fstatSync = ((fd: number, ...args: unknown[]) => {
    const stat = Reflect.apply(originalStat, fs, [fd, ...args]);
    if (tracked.has(fd) && !appended) {
      appended = true;
      fs.appendFileSync(filename, `${started}\n`);
    }
    return stat;
  }) as typeof fs.fstatSync;
  fs.closeSync = ((fd: number) => {
    tracked.delete(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync;
  try {
    const scan = await listFilesWithProjectCatalog(undefined, { persist: false });
    expect(appended).toBe(true);
    expect(scan.complete).toBe(true);
    const entry = scan.files.find((row) => row.path === filename)!;
    expect(entry).toMatchObject({ size: fs.statSync(filename).size, derivationComplete: true, authoritativeTurn: { state: "busy" } });
  } finally {
    fs.openSync = originalOpen;
    fs.fstatSync = originalStat;
    fs.closeSync = originalClose;
  }
});

test("a stable invalid tail is distinguishable from a stale file identity and an I/O failure", () => {
  const filename = transcript("failure-reasons", `{broken}\n`);
  const stat = fs.statSync(filename);
  expect(tailRecordsResult(filename, stat.size, stat.mtimeMs)).toMatchObject({ complete: false, failure: "content" });
  expect(tailRecordsResult(filename, stat.size - 1, stat.mtimeMs)).toMatchObject({ complete: false, failure: "changed" });
  expect(tailRecordsResult(path.join(sandbox, "absent.jsonl"), 1, 1)).toMatchObject({ complete: false, failure: "io" });
});

test("polls reuse a completed degraded inventory and a repaired tail becomes authoritative again", async () => {
  const damaged = transcript("repairable", `{broken}\n`);
  transcript("current", `${started}\n`);
  let scans = 0;
  setFileScanRunnerForTests((...args) => {
    scans++;
    return runFileCatalogScan(...args);
  });
  const first = await currentFileScan({ fresh: true });
  for (let index = 0; index < 20; index++) {
    const poll = await cachedFileScan();
    expect(poll.generation).toBe(first.generation);
    expect(poll.snapshot.files.find((entry) => entry.path === damaged)?.derivationComplete).toBe(false);
  }
  expect(scans).toBe(1);
  fs.writeFileSync(damaged, `${header}\n${completed}\n`);
  const repaired = await currentFileScan({ fresh: true });
  expect(repaired.generation).toBeGreaterThan(first.generation);
  expect(repaired.snapshot.files.find((entry) => entry.path === damaged)).toMatchObject({
    derivationComplete: true, authoritativeTurn: { state: "terminal" },
  });
});
