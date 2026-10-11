import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BoardTask } from "@/lib/tasks/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-extraction-retirement-"));
// Exercise an installation that had opted into the retired feature. Assemble
// its old setting so a repository search cannot advertise it as a live gate.
const retiredGate = ["LLV", "ENABLE", "AUTO", "TASK", "INBOX"].join("_");
const environment = {
  HOME: path.join(sandbox, "home"),
  XDG_CONFIG_HOME: path.join(sandbox, "config"),
  LLV_STATE_DIR: path.join(sandbox, "state"),
  LLV_CODEX_HOME: path.join(sandbox, "codex"),
  LLV_CLAUDE_HOME: path.join(sandbox, "claude"),
  OPENCLAW_STATE_DIR: path.join(sandbox, "openclaw"),
  COPILOT_HOME: path.join(sandbox, "copilot"),
  CLAUDE_CODE_TMPDIR: path.join(sandbox, "tmp"),
  TMPDIR: path.join(sandbox, "tmp"),
  [retiredGate]: "1",
};
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
for (const directory of Object.values(environment).filter(value => value !== "1")) fs.mkdirSync(directory, { recursive: true });

const scanner = await import("./index");
const processes = await import("./process");
const tmux = await import("@/lib/tmux");
const reader = await import("@/lib/session/reader");
const durableJson = await import("@/lib/state/durableJson");
const flows = await import("@/lib/flows/engine");
const pipelines = await import("@/lib/pipelines/engine");
const workflows = await import("@/lib/workflows/engine");
const { loadTasks, saveTasks, TASKS_FILE } = await import("@/lib/tasks/store");
const { legacyDatabasePath } = await import("@/lib/state/legacyImport");
const { readStateCollectionRows, readStateCollectionRevision } = await import("@/lib/state/sqliteStateStore");
const { createLegacyRuntimeScheduler } = await import("@/runtime-host/legacyScheduler");
const { RuntimeJournal } = await import("@/runtime-host/journal");

afterEach(() => {
  // These ports can launch work in a real controller; each test keeps them inert.
  for (const spy of spies.splice(0)) spy.mockRestore();
});
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});
const spies: Array<{ mockRestore(): void }> = [];

function fixture() {
  const now = new Date().toISOString();
  const directory = path.join(environment.LLV_CLAUDE_HOME, "projects", "fixture");
  fs.mkdirSync(directory, { recursive: true });
  const transcript = path.join(directory, "session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: now, cwd: "/fixture-repo",
    message: { role: "user", content: "Please implement a new retry for the deploy script." } }) + "\n");
  const source = { path: transcript, ts: now, text: "Original source text", fingerprint: "original-source", engine: "claude" as const };
  const task: BoardTask = { id: "existing-task", project: "fixture", status: "inbox", text: "Existing card",
    placement: "unplaced", assignments: [{ path: transcript, panePid: null, state: "linked", error: null, at: now }],
    source, createdAt: now, updatedAt: now };
  saveTasks([task]);
  const before = loadTasks();
  const database = legacyDatabasePath(TASKS_FILE);
  const persisted = JSON.stringify(readStateCollectionRows(database, "tasks"));
  const revision = readStateCollectionRevision(database, "tasks");
  expect(revision).not.toBeNull();
  const scanState = path.join(environment.LLV_STATE_DIR, "task-inbox-scan.json");
  fs.writeFileSync(scanState, JSON.stringify({ lastRunAt: "2026-01-01T00:00:00Z", seen: ["retained-fingerprint"] }));
  const scanBytes = fs.readFileSync(scanState, "utf8");
  const scanMtime = fs.statSync(scanState).mtimeMs;
  const sessionRead = spyOn(reader, "readSession");
  const cacheRead = spyOn(durableJson, "readJsonCache");
  spies.push(sessionRead, cacheRead,
    spyOn(processes, "agentProcesses").mockReturnValue([]),
    spyOn(tmux, "panePidMap").mockResolvedValue({ kind: "no-server" }),
    spyOn(flows, "tickFlows").mockResolvedValue({ flows: [], changed: false }),
    spyOn(pipelines, "tickPipelines").mockResolvedValue({ pipelines: [], changed: false }),
    spyOn(workflows, "tickWorkflows").mockResolvedValue({ workflows: [], changed: false }));
  return { transcript, assertPreserved() {
    expect(sessionRead).not.toHaveBeenCalled();
    expect(cacheRead.mock.calls.some(([file]) => file === scanState)).toBe(false);
    expect(loadTasks()).toEqual(before);
    expect(JSON.stringify(readStateCollectionRows(database, "tasks"))).toBe(persisted);
    expect(readStateCollectionRevision(database, "tasks")).toBe(revision);
    expect(fs.readFileSync(scanState, "utf8")).toBe(scanBytes);
    expect(fs.statSync(scanState).mtimeMs).toBe(scanMtime);
  } };
}

test("file scans and controller reconciliation preserve tasks without extracting transcript requests", async () => {
  const { transcript, assertPreserved } = fixture();
  const entries = await scanner.listFiles();
  expect(entries.some(entry => entry.path === transcript)).toBe(true);
  assertPreserved();
  await scanner.reconcileFileControllers(entries);
  await scanner.reconcileFileControllers(entries);
  assertPreserved();
});

test("the legacy runtime scheduler preserves tasks and retired scan-state", async () => {
  const { transcript, assertPreserved } = fixture();
  const entries = await scanner.listFiles();
  expect(entries.some(entry => entry.path === transcript)).toBe(true);
  spies.push(spyOn(scanner, "listFiles").mockResolvedValue(entries));
  const journal = new RuntimeJournal(path.join(sandbox, "legacy-runtime.sqlite"));
  try {
    const scheduler = createLegacyRuntimeScheduler(journal);
    expect(await scheduler.runDue()).toBe(true);
    expect(await scheduler.runDue()).toBe(false);
    expect(journal.snapshot().filesRevision).toBe(1);
    assertPreserved();
  } finally {
    journal.close();
  }
});
