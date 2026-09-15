import { expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { assignmentRefFor } from "./kanbanAssignments";
import { clampSeatHeight, seatCollapsed, SEAT_MIN_HEIGHT } from "./kanbanSeatStore";
import { closeReader, foldReader, followPaths, openReader, parseReaders, READER_STORAGE_PREFIX, ReaderMemory } from "./readerMemory";

/* Pure pieces of the K3 slice (#1695): what a device remembers about its open
   readers and its orchestrator seat, and which handle Unlink sends. */

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

test("readers open, fold, follow a moved transcript and close", () => {
  let readers = openReader([], "conversation_a", "/a.jsonl");
  readers = openReader(readers, "conversation_b", "/b.jsonl");
  readers = foldReader(readers, "conversation_a", true);
  expect(readers).toEqual([{ key: "conversation_a", path: "/a.jsonl", folded: true }, { key: "conversation_b", path: "/b.jsonl", folded: false }]);
  /* Opening a folded reader unfolds it in place. */
  readers = openReader(readers, "conversation_a", "/a.jsonl");
  expect(readers[0]).toEqual({ key: "conversation_a", path: "/a.jsonl", folded: false });
  readers = followPaths(readers, (key) => (key === "conversation_b" ? "/b-after-migration.jsonl" : null));
  expect(readers[1]?.path).toBe("/b-after-migration.jsonl");
  expect(closeReader(readers, "conversation_a").map((reader) => reader.key)).toEqual(["conversation_b"]);
});

test("seventy opens keep seventy readers, open and remembered, and a refused write is reported instead of trimming", () => {
  const storage = memoryStorage();
  const memory = new ReaderMemory("fixture", storage);
  for (let index = 0; index < 70; index += 1) memory.update((readers) => openReader(readers, `conversation_${index}`, `/${index}.jsonl`));
  expect(memory.snapshot()).toHaveLength(70);
  expect(memory.persisted()).toBe(true);
  const stored = JSON.parse(storage.values.get(`${READER_STORAGE_PREFIX}fixture`)!) as unknown[];
  expect(stored).toHaveLength(70);
  expect(new ReaderMemory("fixture", storage).snapshot().map((reader) => reader.key)).toEqual(Array.from({ length: 70 }, (_, index) => `conversation_${index}`));

  const full = { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } };
  const refused = new ReaderMemory("fixture", full);
  refused.update((readers) => openReader(readers, "conversation_a", "/a.jsonl"));
  expect(refused.snapshot()).toEqual([{ key: "conversation_a", path: "/a.jsonl", folded: false }]);
  expect(refused.persisted()).toBe(false);
});

test("the remembered list survives a reload, keeps every identity it holds, and ignores what it cannot read", () => {
  const storage = memoryStorage();
  const first = new ReaderMemory("fixture", storage);
  first.update((readers) => openReader(readers, "conversation_a", "/a.jsonl"));
  expect(JSON.parse(storage.values.get(`${READER_STORAGE_PREFIX}fixture`)!)).toEqual([{ key: "conversation_a", path: "/a.jsonl", folded: false }]);
  expect(new ReaderMemory("fixture", storage).snapshot()).toEqual([{ key: "conversation_a", path: "/a.jsonl", folded: false }]);
  expect(new ReaderMemory("neighbour", storage).snapshot()).toEqual([]);

  const long = Array.from({ length: 70 }, (_, index) => ({ key: `conversation_${index}`, path: `/${index}.jsonl`, folded: false }));
  const parsed = parseReaders(JSON.stringify(long));
  expect(parsed).toHaveLength(70);
  expect(parsed[0]?.key).toBe("conversation_0");
  expect(parseReaders("not json")).toEqual([]);
  expect(parseReaders(JSON.stringify([{ key: 7 }, { key: "conversation_a", path: "/a.jsonl" }, { key: "conversation_a", path: "/again.jsonl" }]))).toEqual([{ key: "conversation_a", path: "/a.jsonl", folded: false }]);
});

test("the seat is dragged between its floor and three quarters of the window, and starts collapsed only in a short window the operator never set", () => {
  expect(SEAT_MIN_HEIGHT).toBe(160);
  expect(clampSeatHeight(40, 900)).toBe(160);
  expect(clampSeatHeight(2000, 900)).toBe(675);
  expect(clampSeatHeight(333.4, 900)).toBe(333);
  const record = { height: null, collapsed: { chosen: false } };
  expect(seatCollapsed(record, "fresh", 760)).toBe(true);
  expect(seatCollapsed(record, "fresh", 900)).toBe(false);
  expect(seatCollapsed(record, "chosen", 760)).toBe(false);
});

test("Unlink names the assignment by the strongest handle it has, and has nothing to send for a conversation tied through its pipeline", () => {
  const file = { path: "/fixture/a.jsonl", conversationId: "conversation_fixture_a" } as FileEntry;
  const task = (assignments: BoardTask["assignments"]) => ({ id: "t", assignments } as BoardTask);
  const base = { panePid: null, state: "handoff" as const, error: null, at: "2026-09-14T10:00:00.000Z" };
  expect(assignmentRefFor(task([{ ...base, path: "/fixture/a.jsonl", conversationId: "conversation_fixture_a", launchId: "launch_fixture_a" }]), file)).toEqual({ launchId: "launch_fixture_a" });
  expect(assignmentRefFor(task([{ ...base, path: "/fixture/older.jsonl", conversationId: "conversation_fixture_a" }]), file)).toEqual({ conversationId: "conversation_fixture_a" });
  expect(assignmentRefFor(task([{ ...base, path: "/fixture/a.jsonl" }]), file)).toEqual({ path: "/fixture/a.jsonl" });
  expect(assignmentRefFor(task([{ ...base, path: "/fixture/other.jsonl", conversationId: "conversation_fixture_other" }]), file)).toBeNull();
});
