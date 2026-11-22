import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";
import { TRANSCRIPT_WORK_MAX_BYTES, transcriptWork, transcriptWorkFor } from "./transcriptWork";

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
  fs.rmSync(entry.path);
  expect(await transcriptWork(entry)).toBe(first);
  const grown = transcript("e.jsonl", [user(0), done(5), user(50), done(60)]);
  expect((await transcriptWork(grown)).windows).toHaveLength(2);
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
