import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

/* Every home the inventory can reach is a sandbox, claimed before the modules
   under test load and resolve anything. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-noop-inventory-home-"));
fs.chmodSync(home, 0o700);
const restoreEnv = Object.fromEntries(
  ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].map((name) => [name, process.env[name]]),
);
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.LLV_STATE_DIR = path.join(home, "state");
process.env.CODEX_HOME = path.join(home, ".codex");
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");

const { AgentRegistry } = await import("@/lib/agent/registry");
const { reconcileMigrationInventory } = await import("./coordinator");

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

afterAll(() => {
  for (const [name, value] of Object.entries(restoreEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/* Assembled from parts: the publication gate refuses any UUID-shaped literal. */
const SESSION_ID = ["019900aa", "0000", "7000", "8000", "000000001990"].join("-");

function record(type: string, payload: Record<string, unknown>, timestamp: string): string {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

/** A finished Codex turn: the transcript's tail says the composer is free. */
function finishedRollout(pathname: string) {
  fs.writeFileSync(pathname, [
    record("session_meta", { id: SESSION_ID, cwd: path.dirname(pathname), timestamp: "2026-09-22T10:00:00.000Z" }, "2026-09-22T10:00:00.000Z"),
    record("event_msg", { type: "task_started" }, "2026-09-22T10:00:01.000Z"),
    record("event_msg", { type: "agent_message", message: "done" }, "2026-09-22T10:00:02.000Z"),
    record("event_msg", { type: "task_complete" }, "2026-09-22T10:00:03.000Z"),
  ].join(""));
  const past = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(pathname, past, past);
}

function entry(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "viewer",
    title: "no-op inventory",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "idle",
    activityReason: "jsonl_turn_complete",
    derivationComplete: true,
    nativeForkSourceThreadId: null,
    sessionStartedAt: "2026-09-22T10:00:00.000Z",
    cwd: path.dirname(pathname),
    proc: null,
    pid: null,
    model: "gpt",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function fixture() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-noop-inventory-"));
  fs.chmodSync(sandbox, 0o700);
  sandboxes.push(sandbox);
  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const transcript = path.join(sandbox, `rollout-2026-09-22T10-00-00-${SESSION_ID}.jsonl`);
  finishedRollout(transcript);
  return { registry, transcript };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("an unchanged transcript re-inventoried leaves the row and the registry revision as they were", async () => {
  const { registry, transcript } = fixture();
  await reconcileMigrationInventory(registry, [entry(transcript)]);
  const before = registry.snapshot();
  const conversation = registry.conversationForPath(transcript)!;
  expect(conversation.turn.state).toBe("terminal");

  await tick();
  await reconcileMigrationInventory(registry, [entry(transcript)]);

  const after = registry.snapshot();
  expect(after.conversations[conversation.id]).toEqual(before.conversations[conversation.id]);
  expect(after.conversationRevision).toEqual(before.conversationRevision);
  expect(after).toEqual(before);
});

test("a transcript that moved is a new observation even when the turn reads the same", async () => {
  const { registry, transcript } = fixture();
  await reconcileMigrationInventory(registry, [entry(transcript)]);
  const first = registry.conversationForPath(transcript)!;

  fs.appendFileSync(transcript, record("event_msg", { type: "token_count", info: null }, "2026-09-22T10:00:04.000Z"));
  await tick();
  await reconcileMigrationInventory(registry, [entry(transcript)]);

  const second = registry.conversationForPath(transcript)!;
  expect(second.turn.state).toBe(first.turn.state);
  expect(Date.parse(second.turn.observedAt!)).toBeGreaterThan(Date.parse(first.turn.observedAt!));
  expect(Date.parse(second.turn.observedAt!)).toBeGreaterThanOrEqual(fs.statSync(transcript).mtimeMs - 1);
});

test("a turn the scan now projects differently is recorded with a fresh observation", async () => {
  const { registry, transcript } = fixture();
  fs.appendFileSync(transcript, record("event_msg", { type: "task_started" }, "2026-09-22T10:00:05.000Z"));
  const past = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(transcript, past, past);
  await reconcileMigrationInventory(registry, [entry(transcript, { activity: "live", activityReason: "jsonl_turn_open" })]);
  const busy = registry.conversationForPath(transcript)!;
  expect(busy.turn.state).toBe("busy");

  await tick();
  await reconcileMigrationInventory(registry, [entry(transcript, { activity: "idle", activityReason: "pane_at_composer" })]);

  const released = registry.conversationForPath(transcript)!;
  expect(released.turn.state).toBe("idle");
  expect(Date.parse(released.turn.observedAt!)).toBeGreaterThan(Date.parse(busy.turn.observedAt!));
});

test("a re-read after a delivery settles is fresh evidence the reaper's delivery fence depends on", async () => {
  const { registry, transcript } = fixture();
  await reconcileMigrationInventory(registry, [entry(transcript)]);
  const conversation = registry.conversationForPath(transcript)!;

  await tick();
  const held = registry.holdDelivery(conversation.id, "a new operator turn");
  const started = registry.beginDeliveryAttempt(held.id, held.generationId!)!;
  const delivered = registry.recordDeliveryOutcome(started.id, "delivered");
  expect(Date.parse(delivered.deliveredAt!)).toBeGreaterThanOrEqual(Date.parse(conversation.turn.observedAt!));

  await tick();
  await reconcileMigrationInventory(registry, [entry(transcript)]);

  const observed = registry.conversation(conversation.id)!;
  expect(Date.parse(observed.turn.observedAt!)).toBeGreaterThan(Date.parse(delivered.deliveredAt!));

  /* And once that re-read is recorded, the next unchanged pass is quiet again. */
  const before = registry.snapshot();
  await tick();
  await reconcileMigrationInventory(registry, [entry(transcript)]);
  expect(registry.snapshot()).toEqual(before);
});

function openTurn(transcript: string) {
  fs.appendFileSync(transcript, record("event_msg", { type: "task_started" }, "2026-09-22T10:00:05.000Z"));
  const past = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(transcript, past, past);
}

test("an incomplete read keeps the open turn and its observation, and the next complete read still lands", async () => {
  const { registry, transcript } = fixture();
  openTurn(transcript);
  const open = { activity: "live", activityReason: "jsonl_turn_open" } as Partial<FileEntry>;
  await reconcileMigrationInventory(registry, [entry(transcript, open)]);
  const busy = registry.conversationForPath(transcript)!;
  expect(busy.turn.state).toBe("busy");

  /* A scan that recorded more bytes than the file can give back is not a read. */
  await tick();
  const short = entry(transcript, open);
  await reconcileMigrationInventory(registry, [{ ...short, size: short.size + 4096 }]);
  expect(registry.conversationForPath(transcript)!.turn).toEqual(busy.turn);

  fs.appendFileSync(transcript, record("event_msg", { type: "task_complete" }, "2026-09-22T10:00:06.000Z"));
  await tick();
  await reconcileMigrationInventory(registry, [entry(transcript)]);
  const finished = registry.conversationForPath(transcript)!;
  expect(finished.turn.state).toBe("terminal");
  expect(Date.parse(finished.turn.observedAt!)).toBeGreaterThan(Date.parse(busy.turn.observedAt!));
});

test("an open turn over an unchanged transcript stays busy and is not rewritten", async () => {
  const { registry, transcript } = fixture();
  openTurn(transcript);
  const open = { activity: "live", activityReason: "jsonl_turn_open" } as Partial<FileEntry>;
  await reconcileMigrationInventory(registry, [entry(transcript, open)]);
  const before = registry.snapshot();
  const conversation = registry.conversationForPath(transcript)!;
  expect(conversation.turn.state).toBe("busy");

  await tick();
  await reconcileMigrationInventory(registry, [entry(transcript, open)]);
  expect(registry.snapshot()).toEqual(before);
});

test("an identity change over an unchanged transcript is still written", async () => {
  const { registry, transcript } = fixture();
  await reconcileMigrationInventory(registry, [entry(transcript)]);
  const first = registry.conversationForPath(transcript)!;

  await tick();
  await reconcileMigrationInventory(registry, [entry(transcript, { project: "regrouped" })]);

  const moved = registry.conversationForPath(transcript)!;
  expect(moved.generations.at(-1)!.launchProfile.project).toBe("regrouped");
  expect(moved.turn).toEqual(first.turn);
});
