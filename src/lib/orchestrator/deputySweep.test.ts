import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { activateDeputy, beginDeputy, readDeputies, recordDeputyFork, type OrchestratorDeputy } from "./deputies";
import { deputyWorkFromLines } from "./deputyNote";
import {
  DEPUTY_HOST_GRACE_MS,
  deputyNoteKey,
  deputySeatNoteRequest,
  deputyVerdict,
  readDeputyOwnLines,
  sweepDeputies,
  type DeputyRuntimeFacts,
  type DeputySweepPorts,
} from "./deputySweep";
import type { OrchestratorSeat } from "./seats";

/* How a seat's deputy ends (docs/design/ghost-seat.md §5 "End"). */

const START = Date.parse("2026-09-26T12:00:00.000Z");
let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deputy-sweep-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const seat = { conversationId: "conversation_seat", seatEpoch: 3 } as OrchestratorSeat;

function liveDeputy(): OrchestratorDeputy {
  const begun = beginDeputy({ project: "proj", seatConversationId: "conversation_seat", seatEpoch: 3, seatPath: "/t/seat.jsonl", clientRequestId: "ask-1", ask: { text: "file a task", images: 0, sender: null }, now: new Date(START) });
  if (begun.kind !== "begun") throw new Error("not begun");
  const transcript = path.join(sandbox, "ghost.jsonl");
  const prefix = [
    JSON.stringify({ type: "user", message: { content: "the seat's own history" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the seat's own answer" }] } }),
  ];
  fs.writeFileSync(transcript, prefix.join("\n") + "\n");
  recordDeputyFork(begun.deputy.askId, { deputyConversationId: "conversation_ghost", artifactPath: transcript, forkRecordCount: prefix.length });
  return activateDeputy(begun.deputy.askId, new Date(START + 1_000))!;
}

function appendOwn(deputy: OrchestratorDeputy, lines: unknown[]): void {
  fs.appendFileSync(deputy.artifactPath!, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

const hosted = (turn: DeputyRuntimeFacts["turn"]): DeputyRuntimeFacts => ({ host: "hosted", turn });

test("verdicts: rotated seat, expiry, done after an answer, a host that died first", () => {
  const deputy = liveDeputy();
  const at = (ms: number) => START + ms;
  expect(deputyVerdict(deputy, { nowMs: at(5_000), seat: { ...seat, seatEpoch: 4 }, runtime: hosted("running"), answered: false }))
    .toEqual({ kind: "end", outcome: "seat-rotated", interrupt: true });
  expect(deputyVerdict(deputy, { nowMs: at(15 * 60_000), seat, runtime: hosted("running"), answered: true }))
    .toEqual({ kind: "end", outcome: "timeout", interrupt: true });
  expect(deputyVerdict(deputy, { nowMs: at(20_000), seat, runtime: hosted("running"), answered: true })).toEqual({ kind: "wait" });
  /* Idle before it answered is the resume still starting, never "done". */
  expect(deputyVerdict(deputy, { nowMs: at(20_000), seat, runtime: hosted("idle"), answered: false })).toEqual({ kind: "wait" });
  expect(deputyVerdict(deputy, { nowMs: at(20_000), seat, runtime: hosted("idle"), answered: true }))
    .toEqual({ kind: "end", outcome: "done", interrupt: false });
  expect(deputyVerdict(deputy, { nowMs: at(DEPUTY_HOST_GRACE_MS + 2_000), seat, runtime: { host: "dead", turn: "idle" }, answered: false }))
    .toEqual({ kind: "end", outcome: "host-died", interrupt: false });
  expect(deputyVerdict(deputy, { nowMs: at(10_000), seat, runtime: null, answered: false })).toEqual({ kind: "wait" });
});

test("the deputy's own lines skip the fork prefix, and its work is read from its Delegatus calls", () => {
  const deputy = liveDeputy();
  appendOwn(deputy, [
    { type: "user", message: { content: "file a task" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "call_1", name: "mcp__viewer__create_task", input: { text: "Reviewer for #2244", project: "proj" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: JSON.stringify({ taskId: "task_318" }) }] }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Created task «Reviewer for #2244».\nLinked it to the lane." }] } },
  ]);
  const own = readDeputyOwnLines(deputy)!;
  expect(own).toHaveLength(5);
  const work = deputyWorkFromLines(own);
  expect(work.touched).toEqual({ taskIds: ["task_318"], pipelineIds: [], conversationIds: [] });
  expect(work.finalText).toBe("Created task «Reviewer for #2244».\nLinked it to the lane.");
});

test("a finished deputy releases its host, collapses to one line, and queues one note to the seat", async () => {
  const deputy = liveDeputy();
  appendOwn(deputy, [
    { type: "user", message: { content: "file a task" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Filed the task." }] } },
  ]);
  const calls: string[] = [];
  const notes: { clientMessageId: string; text: string }[] = [];
  const ports: DeputySweepPorts = {
    now: () => new Date(START + 30_000),
    deputies: readDeputies,
    activeSeat: () => seat,
    runtime: async () => hosted("idle"),
    ownLines: readDeputyOwnLines,
    interrupt: async () => { calls.push("interrupt"); },
    release: async () => { calls.push("release"); },
    noteSeat: async (input) => { notes.push(input); return "queued"; },
  };
  expect(await sweepDeputies(ports)).toBe(false);
  const ended = readDeputies()[0]!;
  expect(ended).toMatchObject({ state: "ended", outcome: "done", result: { line: "Filed the task." } });
  expect(ended.note).toMatchObject({ clientMessageId: deputyNoteKey(ended.askId), outcome: "queued" });
  expect(calls).toEqual(["release"]);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.text).toContain("Your parallel self handled: «file a task»");
  expect(notes[0]!.text).toContain("Its final message: Filed the task.");

  /* A second sweep repeats nothing. */
  await sweepDeputies(ports);
  expect(notes).toHaveLength(1);
});

test("a note that failed to land is retried on the next sweep, once", async () => {
  const deputy = liveDeputy();
  appendOwn(deputy, [{ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }]);
  let fail = true;
  const notes: string[] = [];
  const ports: DeputySweepPorts = {
    now: () => new Date(START + 30_000),
    deputies: readDeputies,
    activeSeat: () => seat,
    runtime: async () => hosted("idle"),
    ownLines: readDeputyOwnLines,
    interrupt: async () => undefined,
    release: async () => undefined,
    noteSeat: async (input) => {
      if (fail) throw new Error("runtime host unavailable");
      notes.push(input.clientMessageId);
      return "queued";
    },
  };
  await sweepDeputies(ports);
  expect(readDeputies()[0]!.note).toBeNull();
  fail = false;
  await sweepDeputies(ports);
  await sweepDeputies(ports);
  expect(notes).toEqual([deputyNoteKey(deputy.askId)]);
});

test("the note is queued behind the seat's running turn, never interrupting it", () => {
  expect(deputySeatNoteRequest({ seatPath: "/t/seat.jsonl", seatConversationId: "conversation_seat" }, "deputy_note_x", "note")).toEqual({
    path: "/t/seat.jsonl",
    conversationId: "conversation_seat",
    clientMessageId: "deputy_note_x",
    text: "note",
    policy: "queue",
    origin: { kind: "agent", role: "orchestrator" },
  });
});

test("a timed-out deputy is interrupted and its note says what it had done", async () => {
  const deputy = liveDeputy();
  appendOwn(deputy, [{ type: "assistant", message: { content: [{ type: "text", text: "Still reading the lane…" }] } }]);
  const calls: string[] = [];
  const notes: string[] = [];
  await sweepDeputies({
    now: () => new Date(START + 16 * 60_000),
    deputies: readDeputies,
    activeSeat: () => seat,
    runtime: async () => hosted("running"),
    ownLines: readDeputyOwnLines,
    interrupt: async () => { calls.push("interrupt"); },
    release: async () => { calls.push("release"); },
    noteSeat: async (input) => { notes.push(input.text); return "queued"; },
  });
  expect(calls).toEqual(["interrupt", "release"]);
  expect(readDeputies()[0]).toMatchObject({ outcome: "timeout" });
  expect(notes[0]).toContain("ran out of its 15 minutes on");
});

test("the own-lines reader seeks past the fork by its byte size and never returns a half-written line", () => {
  const transcript = path.join(sandbox, "bytes.jsonl");
  const prefix = `${JSON.stringify({ type: "user", message: { content: "seat history ✅" } })}\n`;
  fs.writeFileSync(transcript, prefix);
  const forkBytes = Buffer.byteLength(prefix);
  const own = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "own" }] } });
  fs.appendFileSync(transcript, `${own}\n{"type":"assistant","message":`);
  expect(readDeputyOwnLines({ artifactPath: transcript, forkRecordCount: 1, forkBytes })).toEqual([own]);
  /* A window smaller than the deputy's own records starts at a line boundary. */
  fs.appendFileSync(transcript, `{"content":[]}}\n`);
  const lines = readDeputyOwnLines({ artifactPath: transcript, forkRecordCount: 1, forkBytes }, 40)!;
  expect(lines.every((line) => line.startsWith("{"))).toBe(true);
  expect(readDeputyOwnLines({ artifactPath: path.join(sandbox, "gone.jsonl"), forkRecordCount: 1, forkBytes })).toBeNull();
});
