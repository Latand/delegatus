import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dedupeCandidates } from "./humanInput";
import { ingestTranscripts, type IngestSource } from "./ingest";
import { ActivityStore, LOCAL_HOST_KEY } from "./store";
import type { ConversationResolution, TranscriptFacts } from "./transcriptExport";

/* The continuous ingest over invented transcripts in a throw-away directory:
   invented projects, ids and text only. */

let dir: string;
let storeFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-ingest-"));
  storeFile = path.join(dir, "state", "activity", "records.sqlite");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-09-23T12:00:00Z");
const mark = (origin: "o" | "a", key: string) => `<!-- llv:structured-user ctx=${origin}.${key.padEnd(43, "A")}.${"B".repeat(16)} -->\n`;
const codexMeta = (at: string) => ({ timestamp: at, type: "session_meta", payload: { id: "session", cwd: "/work/harbor", originator: "llv-structured-host", source: "vscode" } });
const codexUser = (at: string, id: string, text: string) => ({ timestamp: at, type: "response_item", payload: { type: "message", role: "user", id, content: [{ type: "input_text", text }] } });
const codexEvent = (at: string, type: string) => ({ timestamp: at, type: "event_msg", payload: { type } });
const codexWork = (at: string) => ({ timestamp: at, type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } });
const claudeTyped = (at: string, uuid: string, text: string) => ({
  type: "user", timestamp: at, uuid, promptId: `p-${uuid}`, sessionId: "s", cwd: "/work/harbor", entrypoint: "cli", promptSource: "typed",
  message: { role: "user", content: text },
});
const claudeAssistant = (at: string) => ({ type: "assistant", timestamp: at, uuid: `a-${at}`, message: { role: "assistant", content: [{ type: "text", text: "done" }] } });

const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function write(relative: string, rows: unknown[]): string {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines(rows));
  return file;
}

function source(file: string, engine: "claude" | "codex" = "codex"): IngestSource {
  const stat = fs.statSync(file);
  return { path: file, engine, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Every transcript is a registered operator launch in project harbor. */
const operatorLaunch = (): ((facts: TranscriptFacts) => ConversationResolution) => (facts) => ({
  project: "harbor", launch: "operator", registered: true, conversation: `conversation:${path.basename(facts.path)}`,
  agent: { role: "none", pipelineId: null, stageId: null },
});

async function ingest(sources: IngestSource[], options: { complete?: boolean; listedAt?: number; batchBytes?: number; resolver?: () => (facts: TranscriptFacts) => ConversationResolution } = {}) {
  const store = ActivityStore.open(storeFile);
  try {
    return await ingestTranscripts(sources, {
      complete: options.complete ?? true,
      listedAt: options.listedAt ?? NOW,
      store,
      resolver: options.resolver ?? operatorLaunch,
      now: () => NOW,
      ...(options.batchBytes ? { batchBytes: options.batchBytes } : {}),
    });
  } finally {
    store.close();
  }
}

function stored<T>(read: (store: ActivityStore) => T): T {
  const store = ActivityStore.open(storeFile);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

describe("the continuous ingest", () => {
  test("writes one record per operator input and none for the excluded kinds, and no text", async () => {
    const file = write("sessions/rollout-a.jsonl", [
      codexMeta("2026-09-23T08:00:00Z"),
      codexUser("2026-09-23T08:00:01Z", "i-0", "# AGENTS.md instructions for the repo"),
      codexUser("2026-09-23T08:01:00Z", "i-1", `${mark("o", "K1")}reconcile the saffron ledger`),
      codexUser("2026-09-23T08:02:00Z", "i-2", `${mark("a", "K2")}Reviewer: two findings`),
      codexUser("2026-09-23T08:03:00Z", "i-3", "worker note that arrived with role=user and no marker"),
      codexUser("2026-09-23T08:30:00Z", "i-4", `${mark("o", "K4")}also check the saffron totals`),
    ]);
    const result = await ingest([source(file)]);
    expect(result.inputsWritten).toBe(2);
    const { count, state, rows } = stored((store) => ({
      count: store.count(LOCAL_HOST_KEY),
      state: store.hostState(LOCAL_HOST_KEY),
      rows: store.candidates(LOCAL_HOST_KEY, 0, NOW, "local"),
    }));
    expect(count).toBe(2);
    expect(rows.map((row) => [new Date(row.at).toISOString(), row.project, row.kind])).toEqual([
      ["2026-09-23T08:01:00.000Z", "harbor", "spawn"],
      ["2026-09-23T08:30:00.000Z", "harbor", "message"],
    ]);
    expect(state!.excluded).toEqual({ injected: 1, "agent-message": 1, unmarked: 1 });
    /* The first record on disk opens the read span; the pass closes it. */
    expect(state!.coveredFrom).toBe(Date.parse("2026-09-23T08:00:01Z"));
    expect(state!.coveredUntil).toBe(NOW);
    /* No message text anywhere in the store; the rows that leave the host
       carry no path either (the cursor keeps its transcript's path here). */
    const bytes = fs.readFileSync(storeFile).toString("latin1") + (fs.existsSync(`${storeFile}-wal`) ? fs.readFileSync(`${storeFile}-wal`).toString("latin1") : "");
    for (const secret of ["saffron", "Reviewer", "worker note", "AGENTS.md"]) expect(bytes.includes(secret)).toBeFalse();
    const shared = JSON.stringify(stored((store) => [store.localRowsAfter(0, 100), store.localTurnsAfter(0, 100)]));
    for (const secret of [file, "/work/harbor", "rollout-a"]) expect(shared.includes(secret)).toBeFalse();
  });

  test("a restart resumes from the cursor: nothing doubles, and a half-written line waits", async () => {
    const file = write("projects/-work-harbor/claude-a.jsonl", [
      claudeTyped("2026-09-23T08:00:00Z", "u-1", "first request"),
      claudeAssistant("2026-09-23T08:05:00Z"),
    ]);
    expect((await ingest([source(file, "claude")])).inputsWritten).toBe(1);

    /* The transcript grows, its last line still being written. */
    fs.appendFileSync(file, lines([claudeTyped("2026-09-23T09:00:00Z", "u-2", "second request")]) + JSON.stringify(claudeTyped("2026-09-23T09:30:00Z", "u-3", "third")).slice(0, 40));
    /* A fresh store handle is a restarted process: only the cursor carries over. */
    const second = await ingest([source(file, "claude")]);
    expect(second.inputsWritten).toBe(1);
    expect(stored((store) => store.count(LOCAL_HOST_KEY))).toBe(2);
    const cursor = stored((store) => store.fileCursor(file))!;
    expect(cursor.offset).toBeLessThan(fs.statSync(file).size);

    /* An unchanged transcript is skipped; the finished line is read once. */
    expect((await ingest([source(file, "claude")])).filesSkipped).toBe(1);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, cursor.offset) + lines([claudeTyped("2026-09-23T09:30:00Z", "u-3", "third")]));
    expect((await ingest([source(file, "claude")])).inputsWritten).toBe(1);
    expect(stored((store) => store.count(LOCAL_HOST_KEY))).toBe(3);

    /* A cursor lost with its transcript rewritten reads it whole again, and the ids keep it at three. */
    stored((store) => store.forgetFile(file));
    expect((await ingest([source(file, "claude")])).inputsWritten).toBe(0);
    expect(stored((store) => store.count(LOCAL_HOST_KEY))).toBe(3);
  });

  test("a record seen through two mirrors counts once", async () => {
    const rows = [claudeTyped("2026-09-23T08:00:00Z", "u-1", "add the audit column"), claudeAssistant("2026-09-23T08:02:00Z")];
    const account = write("accounts/b/projects/-work-harbor/claude-one.jsonl", rows);
    const mirror = write("shared/projects/-work-harbor/claude-one.jsonl", rows);
    /* Unregistered, so each copy is its own transcript to the registry. */
    const unregistered = () => (): ConversationResolution => ({ project: "harbor", launch: null, registered: false });
    await ingest([source(account, "claude"), source(mirror, "claude")], { resolver: unregistered });
    const { count, inputs, turns } = stored((store) => ({
      count: store.count(LOCAL_HOST_KEY),
      inputs: dedupeCandidates(store.candidates(LOCAL_HOST_KEY, 0, NOW, "local")),
      turns: store.turns(LOCAL_HOST_KEY, 0, NOW),
    }));
    expect(count).toBe(1);
    expect(inputs).toHaveLength(1);
    /* Both copies are one session, so they are one agent turn. */
    expect(turns).toHaveLength(1);
  });

  test("agent turns follow the engine's own boundaries, not the gap to the next user message", async () => {
    /* A Codex conversation fed by another agent: its second turn starts with
       no user message, three hours after the first ended. */
    const codex = write("sessions/rollout-seat.jsonl", [
      codexMeta("2026-09-23T06:00:00Z"),
      codexEvent("2026-09-23T06:00:00Z", "task_started"),
      codexUser("2026-09-23T06:00:01Z", "c-1", `${mark("o", "C1")}run the nightly check`),
      codexWork("2026-09-23T06:10:00Z"),
      codexEvent("2026-09-23T06:20:00Z", "task_complete"),
      codexEvent("2026-09-23T08:00:00Z", "thread_settings_applied"),
      codexEvent("2026-09-23T09:20:00Z", "task_started"),
      codexWork("2026-09-23T09:30:00Z"),
      codexEvent("2026-09-23T09:40:00Z", "task_complete"),
    ]);
    /* A Claude turn ends at its last assistant record; a queue record written
       while it waits is not work. */
    const claude = write("projects/-work-harbor/claude-b.jsonl", [
      claudeTyped("2026-09-23T10:00:00Z", "u-1", "tidy the report"),
      { type: "user", timestamp: "2026-09-23T10:04:00Z", uuid: "t-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } },
      claudeAssistant("2026-09-23T10:15:00Z"),
      { type: "queue-operation", operation: "enqueue", timestamp: "2026-09-23T11:45:00Z", sessionId: "s" },
    ]);
    const result = await ingest([source(codex), source(claude, "claude")]);
    expect(result.turnsRead).toBe(3);
    const turns = stored((store) => store.turns(LOCAL_HOST_KEY, 0, NOW)).map((turn) => [new Date(turn.start).toISOString().slice(11, 16), new Date(turn.end).toISOString().slice(11, 16), turn.engine]);
    expect(turns).toEqual([
      ["06:00", "06:20", "codex"],
      ["09:20", "09:40", "codex"],
      ["10:00", "10:15", "claude"],
    ]);
  });

  test("a turn still running is stored as far as it has run and extended by the next pass", async () => {
    const file = write("sessions/rollout-running.jsonl", [
      codexMeta("2026-09-23T06:00:00Z"),
      codexEvent("2026-09-23T06:00:00Z", "task_started"),
      codexWork("2026-09-23T06:30:00Z"),
    ]);
    await ingest([source(file)]);
    fs.appendFileSync(file, lines([codexWork("2026-09-23T07:10:00Z"), codexEvent("2026-09-23T07:15:00Z", "task_complete")]));
    await ingest([source(file)]);
    const turns = stored((store) => store.turns(LOCAL_HOST_KEY, 0, NOW));
    expect(turns.map((turn) => [turn.start, turn.end])).toEqual([[Date.parse("2026-09-23T06:00:00Z"), Date.parse("2026-09-23T07:15:00Z")]]);
  });

  test("only a complete pass moves the read span, and never past the listing or a transcript waiting for the registry", async () => {
    const file = write("sessions/rollout-b.jsonl", [codexMeta("2026-09-23T08:00:00Z"), codexUser("2026-09-23T08:01:00Z", "i-1", `${mark("o", "K1")}go`)]);
    await ingest([source(file)], { complete: false });
    expect(stored((store) => store.hostState(LOCAL_HOST_KEY))!.coveredUntil).toBeNull();
    await ingest([source(file)], { listedAt: NOW - 60_000 });
    expect(stored((store) => store.hostState(LOCAL_HOST_KEY))!.coveredUntil).toBe(NOW - 60_000);

    /* A Delegatus session the registry does not name yet, written a minute ago. */
    const young = write("sessions/rollout-young.jsonl", [codexMeta("2026-09-23T11:58:00Z"), codexUser("2026-09-23T11:58:30Z", "y-1", `${mark("o", "Y1")}hello`)]);
    fs.utimesSync(young, new Date(NOW - 60_000), new Date(NOW - 60_000));
    const unregistered = () => (): ConversationResolution => ({ project: "harbor", launch: null, registered: false });
    const held = await ingest([source(file), source(young)], { resolver: unregistered });
    expect(held.filesHeld).toBe(1);
    expect(stored((store) => store.hostState(LOCAL_HOST_KEY))!.coveredUntil).toBe(Date.parse("2026-09-23T11:58:30Z") - 1);
    /* Once the registry names it, the next pass stores it. */
    await ingest([source(file), source(young)]);
    expect(stored((store) => store.count(LOCAL_HOST_KEY))).toBe(2);
    expect(stored((store) => store.hostState(LOCAL_HOST_KEY))!.coveredUntil).toBe(NOW);
  });

  test("a transcript read in small pieces stores what one whole read stores", async () => {
    const rows: unknown[] = [codexMeta("2026-09-23T06:00:00Z")];
    for (let index = 0; index < 12; index += 1) {
      const at = (minute: number) => new Date(Date.parse("2026-09-23T06:00:00Z") + (index * 30 + minute) * 60_000).toISOString();
      rows.push(codexEvent(at(0), "task_started"), codexUser(at(0), `p-${index}`, `${mark("o", `P${index}`)}piece ${index}`), codexWork(at(5)), codexEvent(at(9), "task_complete"));
    }
    const file = write("sessions/rollout-pieces.jsonl", rows);
    const whole = path.join(dir, "whole.sqlite");
    const snapshot = (store: ActivityStore) => ({
      inputs: store.candidates(LOCAL_HOST_KEY, 0, NOW, "local").map((row) => [row.at, row.kind, row.ids]),
      turns: store.turns(LOCAL_HOST_KEY, 0, NOW).map((turn) => [turn.start, turn.end]),
      excluded: store.hostState(LOCAL_HOST_KEY)!.excluded,
    });
    await ingest([source(file)], { batchBytes: 300 });
    const pieces = stored(snapshot);
    storeFile = whole;
    await ingest([source(file)]);
    expect(stored(snapshot)).toEqual(pieces);
    expect(pieces.inputs).toHaveLength(12);
    expect(pieces.turns).toHaveLength(12);
  });

  test("a pass reads within its budget, newest first, and the read span waits for the backfill to finish", async () => {
    const older = write("sessions/rollout-older.jsonl", [codexMeta("2026-09-20T08:00:00Z"), codexUser("2026-09-20T08:01:00Z", "o-1", `${mark("o", "O1")}older request`)]);
    const newer = write("sessions/rollout-newer.jsonl", [codexMeta("2026-09-23T08:00:00Z"), codexUser("2026-09-23T08:01:00Z", "n-1", `${mark("o", "N1")}newer request`)]);
    fs.utimesSync(older, new Date(NOW - 3 * 86_400_000), new Date(NOW - 3 * 86_400_000));
    const budget = fs.statSync(newer).size;
    const first = await ingestWithBudget([source(older), source(newer)], budget);
    expect([first.filesRead, first.filesDeferred, first.coveredUntil]).toEqual([1, 1, null]);
    expect(stored((store) => store.candidates(LOCAL_HOST_KEY, 0, NOW, "local").map((row) => new Date(row.at).toISOString().slice(0, 10)))).toEqual(["2026-09-23"]);
    expect(stored((store) => store.hostState(LOCAL_HOST_KEY))!.coveredUntil).toBeNull();
    const second = await ingestWithBudget([source(older), source(newer)], budget);
    expect([second.filesRead, second.filesSkipped, second.filesDeferred, second.coveredUntil]).toEqual([1, 1, 0, NOW]);
    expect(stored((store) => store.count(LOCAL_HOST_KEY))).toBe(2);
  });
});

async function ingestWithBudget(sources: IngestSource[], budgetBytes: number) {
  const store = ActivityStore.open(storeFile);
  try {
    return await ingestTranscripts(sources, { complete: true, listedAt: NOW, store, resolver: operatorLaunch, now: () => NOW, budgetBytes });
  } finally {
    store.close();
  }
}
