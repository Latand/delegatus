import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";
import { attemptWork } from "@/lib/board/attemptWork";
import { TRANSCRIPT_WORK_MAX_BYTES, transcriptWork, transcriptWorkFor, transcriptWorkRead } from "./transcriptWork";

let directory = "";
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-work-")); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 21, 9, 0) + minutes * 60_000).toISOString();
const user = (minutes: number, text = "go") => JSON.stringify({ type: "user", timestamp: at(minutes), message: { role: "user", content: text } });
const done = (minutes: number) => JSON.stringify({ type: "assistant", timestamp: at(minutes), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
const tool = (minutes: number) => JSON.stringify({ type: "assistant", timestamp: at(minutes), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } });

function transcript(name: string, lines: string[], root: FileEntry["root"] = "claude-projects"): Pick<FileEntry, "path" | "root" | "size" | "mtime"> {
  const file = path.join(directory, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const stat = fs.statSync(file);
  return { path: file, root, size: stat.size, mtime: stat.mtimeMs / 1000 };
}

test("a transcript read through yields one window per turn, with the gaps between turns left out", async () => {
  const entry = transcript("a.jsonl", [user(0), tool(5), done(20), user(600, "next"), tool(601), done(610), user(1500, "again"), tool(1503)]);
  const result = await transcriptWork(entry);
  const ms = (minutes: number) => Date.parse(at(minutes));
  expect(result).toEqual({ windows: [[ms(0), ms(20)], [ms(600), ms(610)], [ms(1500), null]], lastRecordAt: ms(1503), complete: true });
});

test("a long record, a torn line and blank lines are skipped without losing the turns around them", async () => {
  const huge = JSON.stringify({ type: "user", timestamp: at(30), message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(9 * 1024 * 1024) }] } });
  const entry = transcript("b.jsonl", [user(0), "", "{not json", huge, done(40)]);
  const result = await transcriptWork(entry);
  expect(result.complete).toBe(true);
  expect(result.windows).toEqual([[Date.parse(at(0)), Date.parse(at(40))]]);
});

test("a Codex transcript uses its own turn records", async () => {
  const stamp = (minutes: number, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(minutes), type: "event_msg", payload });
  const entry = transcript("c.jsonl", [stamp(0, { type: "user_message", message: "build" }), stamp(12, { type: "task_complete" })], "codex-sessions");
  expect((await transcriptWork(entry)).windows).toEqual([[Date.parse(at(0)), Date.parse(at(12))]]);
});

test("a transcript that changed since the scan, vanished or is too large is unread, never partial", async () => {
  const entry = transcript("d.jsonl", [user(0), done(5)]);
  expect((await transcriptWork({ ...entry, size: entry.size + 10 })).complete).toBe(false);
  expect((await transcriptWork({ ...entry, path: path.join(directory, "missing.jsonl") })).complete).toBe(false);
  expect((await transcriptWork({ ...entry, size: TRANSCRIPT_WORK_MAX_BYTES + 1 })).complete).toBe(false);
  expect((await transcriptWork({ ...entry, root: "other" as FileEntry["root"] })).complete).toBe(false);
});

test("a transcript that did not move is read once, and one that grew is read again", async () => {
  const entry = transcript("e.jsonl", [user(0), done(5)]);
  const first = await transcriptWork(entry);
  expect(await transcriptWork(entry)).toBe(first);
  const grown = transcript("e.jsonl", [user(0), done(5), user(50), done(60)]);
  expect((await transcriptWork(grown)).windows).toHaveLength(2);
});

test("a transcript that grew after the scan is read to the size it has now, and cached under that size", async () => {
  const entry = transcript("f.jsonl", [user(0), done(5)]);
  fs.appendFileSync(entry.path, [user(50), tool(52), done(60)].join("\n") + "\n");
  const ms = (minutes: number) => Date.parse(at(minutes));
  const grown = await transcriptWork(entry);
  expect(grown).toEqual({ windows: [[ms(0), ms(5)], [ms(50), ms(60)]], lastRecordAt: ms(60), complete: true });
  // The same stale scan entry asked again finds the cached read of the observed size, not a new one.
  expect(await transcriptWork(entry)).toBe(grown);
  fs.appendFileSync(entry.path, [user(90), done(95)].join("\n") + "\n");
  expect((await transcriptWork(entry)).windows).toHaveLength(3);
});

test("identities resolve to the transcripts the caller may see; anything else answers null like a missing one", async () => {
  const mine = transcript("mine.jsonl", [user(0), done(7)]);
  const hidden = transcript("hidden.jsonl", [user(0), done(9)]);
  const visible = [{ ...mine, conversationId: "conversation_mine" } as FileEntry];
  const answer = await transcriptWorkFor(visible, ["conversation_mine", mine.path, "conversation_hidden", hidden.path]);
  expect(answer["conversation_mine"]?.windows).toEqual([[Date.parse(at(0)), Date.parse(at(7))]]);
  expect(answer[mine.path]).toBe(answer["conversation_mine"]);
  expect(answer["conversation_hidden"]).toBeNull();
  expect(answer[hidden.path]).toBeNull();
});

const ms = (minutes: number) => Date.parse(at(minutes));
const generation = (name: string, lines: string[], extra: Partial<FileEntry>, root: FileEntry["root"] = "claude-projects"): FileEntry =>
  ({ ...transcript(name, lines, root), conversationId: "conversation_moved", ...extra } as FileEntry);

test("distinct turns of two generations are both counted", async () => {
  const predecessor = generation("p.jsonl", [user(0), tool(30), done(60)], { migratedTo: path.join(directory, "s.jsonl") });
  const successor = generation("s.jsonl", [user(70), tool(100), done(130)], { predecessorPath: predecessor.path });
  for (const files of [[successor, predecessor], [predecessor, successor]]) {
    const answer = await transcriptWorkFor(files, ["conversation_moved", predecessor.path, successor.path]);
    const work = answer["conversation_moved"]!;
    expect(answer[predecessor.path]).toBe(work);
    expect(answer[successor.path]).toBe(work);
    expect(work.windows).toEqual([[ms(0), ms(60)], [ms(70), ms(130)]]);
    expect(work.lastRecordAt).toBe(ms(130));
  }
  const work = (await transcriptWorkFor([successor, predecessor], ["conversation_moved"]))["conversation_moved"]!;
  expect(attemptWork({ startedAtMs: ms(0), endAtMs: ms(140), live: false }, work, ms(200))).toEqual({ kind: "known", ms: 2 * 3_600_000 });
});

test("a successor that copies the predecessor's records with their timestamps counts them once", async () => {
  const history = [user(0), tool(30), done(60)];
  const predecessor = generation("c-old.jsonl", history, { migratedTo: path.join(directory, "c-new.jsonl") });
  const successor = generation("c-new.jsonl", [...history, user(70), done(90)], { predecessorPath: predecessor.path });
  const work = (await transcriptWorkFor([predecessor, successor], ["conversation_moved"]))["conversation_moved"]!;
  expect(work.windows).toEqual([[ms(0), ms(60)], [ms(70), ms(90)]]);
});

test("a predecessor turn left open ends at its own last record, while the newest generation may still be open", async () => {
  const predecessor = generation("o-old.jsonl", [user(0), tool(20)], { migratedTo: path.join(directory, "o-new.jsonl") });
  const successor = generation("o-new.jsonl", [user(50), tool(55)], { predecessorPath: predecessor.path });
  const work = (await transcriptWorkFor([predecessor, successor], ["conversation_moved"]))["conversation_moved"]!;
  expect(work.windows).toEqual([[ms(0), ms(20)], [ms(50), null]]);
});

test("a generation that cannot be read, or a migration link to a transcript the caller cannot see, leaves the conversation unread", async () => {
  const vanished = generation("v-old.jsonl", [user(0), done(60)], { migratedTo: path.join(directory, "v-new.jsonl") });
  const successor = generation("v-new.jsonl", [user(70), done(130)], { predecessorPath: vanished.path });
  fs.rmSync(vanished.path);
  expect((await transcriptWorkFor([vanished, successor], ["conversation_moved"]))["conversation_moved"]?.complete).toBe(false);
  const hidden = generation("h-new.jsonl", [user(70), done(130)], { conversationId: "conversation_hidden_old", predecessorPath: path.join(directory, "not-visible.jsonl") });
  expect((await transcriptWorkFor([hidden], ["conversation_hidden_old"]))["conversation_hidden_old"]?.complete).toBe(false);
});

test("a transcript that only grew is resumed: the re-ask parses the appended bytes and equals a full read", async () => {
  const entry = transcript("g.jsonl", [user(0), tool(3), done(5), user(50), tool(51)]);
  const first = await transcriptWork(entry);
  expect(first.windows).toEqual([[ms(0), ms(5)], [ms(50), null]]);
  const before = transcriptWorkRead.bytes;
  const appended = [tool(55), done(60), user(90), tool(91)].join("\n") + "\n";
  fs.appendFileSync(entry.path, appended);
  const resumed = await transcriptWork(entry);
  expect(transcriptWorkRead.bytes - before).toBe(Buffer.byteLength(appended));
  expect(resumed.windows).toEqual([[ms(0), ms(5)], [ms(50), ms(60)], [ms(90), null]]);
  // The same file read cold, from another path, gives the same windows.
  const cold = transcript("g-cold.jsonl", fs.readFileSync(entry.path, "utf8").trimEnd().split("\n"));
  expect(resumed).toEqual(await transcriptWork(cold));
});

test("a last line still being written counts toward the answer and is parsed whole once it completes", async () => {
  const entry = transcript("h.jsonl", [user(0)]);
  const finished = done(10);
  fs.appendFileSync(entry.path, finished.slice(0, 20));
  expect((await transcriptWork(entry)).windows).toEqual([[ms(0), null]]);
  fs.appendFileSync(entry.path, finished.slice(20));
  expect((await transcriptWork(entry)).windows).toEqual([[ms(0), ms(10)]]);
  fs.appendFileSync(entry.path, "\n" + user(20) + "\n");
  expect((await transcriptWork(entry)).windows).toEqual([[ms(0), ms(10)], [ms(20), null]]);
  // An unterminated final record is not committed: dropping it again changes nothing for the next resume.
  fs.appendFileSync(entry.path, done(25));
  expect((await transcriptWork(entry)).windows).toEqual([[ms(0), ms(10)], [ms(20), ms(25)]]);
  fs.appendFileSync(entry.path, "\n");
  expect((await transcriptWork(entry)).windows).toEqual([[ms(0), ms(10)], [ms(20), ms(25)]]);
});

test("a file rewritten in place under a longer size is read from its start, not resumed", async () => {
  const entry = transcript("r.jsonl", [user(0), tool(3), done(5)]);
  await transcriptWork(entry);
  fs.writeFileSync(entry.path, [user(400, "a much longer prompt that changes the bytes before the old end"), tool(402), done(410), user(500), done(505)].join("\n") + "\n");
  expect((await transcriptWork(entry)).windows).toEqual([[ms(400), ms(410)], [ms(500), ms(505)]]);
});

test("a long record that straddles a resume point is still skipped whole", async () => {
  const entry = transcript("l.jsonl", [user(0), done(5)]);
  await transcriptWork(entry);
  const huge = JSON.stringify({ type: "user", timestamp: at(30), message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(9 * 1024 * 1024) }] } });
  fs.appendFileSync(entry.path, huge.slice(0, 5 * 1024 * 1024));
  await transcriptWork(entry);
  fs.appendFileSync(entry.path, huge.slice(5 * 1024 * 1024) + "\n" + [user(40), done(45)].join("\n") + "\n");
  expect((await transcriptWork(entry)).windows).toEqual([[ms(0), ms(5)], [ms(40), ms(45)]]);
});

test("concurrent asks for one file share one read", async () => {
  const entry = transcript("k.jsonl", [user(0), tool(3), done(5)]);
  const before = transcriptWorkRead.bytes;
  const [first, second] = await Promise.all([transcriptWork(entry), transcriptWork(entry)]);
  expect(second).toBe(first);
  expect(transcriptWorkRead.bytes - before).toBe(entry.size);
});
