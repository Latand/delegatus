import { expect, test } from "bun:test";

import { withoutArchivedPredecessors } from "@/lib/accounts/identity";
import type { FileEntry } from "@/lib/types";

import { createCatalogReading, createCatalogSelection, recordReplacedRows, REPLACEMENT_LINEAGE, replacedRows } from "./catalogOverlay";

function row(id: string, project = "atlas", extra: Partial<FileEntry> = {}): FileEntry {
  return { conversationId: id, path: "/" + id, root: "claude-projects", engine: "claude", fmt: "claude", kind: "session", project,
    name: id, title: id, parent: null, mtime: 0, size: 0, activity: "idle", proc: null, pid: null, model: null,
    pendingQuestion: null, waitingInput: null, ...extra };
}
/** One publication of an overlay: the rows at `positions` retitled. */
function replace(from: FileEntry[], ...positions: number[]): FileEntry[] {
  const next = from.slice();
  for (const position of positions) next[position] = { ...next[position]!, title: next[position]!.title + "!" };
  recordReplacedRows(from, next, positions);
  return next;
}

test("a reader follows every publication it skipped up to the retained lineage, then reads in full", () => {
  const first = [row("a"), row("b"), row("c")];
  let latest = first;
  for (let step = 0; step < REPLACEMENT_LINEAGE; step++) latest = replace(latest, step % 2);
  expect([...replacedRows(first, latest)!].sort()).toEqual([0, 1]);
  expect(replacedRows(first, replace(latest, 2))).toBeNull();
  expect(replacedRows(latest, latest)).toEqual([]);
  /* A publication nothing recorded is another catalog. */
  expect(replacedRows(first, first.slice())).toBeNull();
});

test("a row whose identity changed is read in full", () => {
  const first = [row("a"), row("b")];
  for (const change of [{ project: "other" }, { conversationId: "z" }, { path: "/z" }, { migratedTo: "/a" }, { generation: 3 }]) {
    const next = first.slice();
    next[1] = { ...next[1]!, ...change };
    recordReplacedRows(first, next, [1]);
    expect(replacedRows(first, next)).toBeNull();
  }
});

test("a selection costs the replaced rows, keeps the others and rebuilds for a new admission", () => {
  let full = 0;
  const select = createCatalogSelection((rows) => { full++; return rows.filter((entry) => entry.project === "atlas"); });
  const first = [row("a"), row("x", "other"), row("b")];
  const shown = select(first);
  expect(shown.map((entry) => entry.name)).toEqual(["a", "b"]);
  const foreign = replace(first, 1);
  expect(select(foreign)).toBe(shown);
  const sibling = replace(foreign, 2);
  const after = select(sibling);
  expect(after).not.toBe(shown);
  expect(after[0]).toBe(shown[0]!);
  expect(after[1]).toBe(sibling[2]!);
  expect(replacedRows(shown, after)).toEqual([1]);
  expect(full).toBe(1);
  /* A new admission with the same rows in the selection keeps its array. */
  expect(select([...sibling, row("y", "other")])).toBe(after);
  expect(select([...sibling, row("c")]).map((entry) => entry.name)).toEqual(["a", "b", "c"]);
  expect(full).toBe(3);
});

test("the visible generations follow an overlay without readmitting an archived row", () => {
  const select = createCatalogSelection(withoutArchivedPredecessors);
  const plain = [row("a"), row("b")];
  expect(select(plain)).toBe(plain);
  const settled = replace(plain, 0);
  expect(select(settled)).toBe(settled);
  const migrated = [row("a"), row("old", "atlas", { conversationId: "a", migratedTo: "/a" }), row("b")];
  const visible = select(migrated);
  expect(visible.map((entry) => entry.name)).toEqual(["a", "b"]);
  const archivedOnly = replace(migrated, 1);
  expect(select(archivedOnly)).toBe(visible);
  const current = replace(archivedOnly, 2);
  expect(select(current)[1]).toBe(current[2]!);
});

test("an identity reading holds across replacements and is read again for another catalog", () => {
  let reads = 0;
  const reading = createCatalogReading((rows) => { reads++; return new Set(rows.map((entry) => entry.conversationId)); });
  const first = [row("a")];
  const ids = reading(first);
  expect(reading(replace(first, 0))).toBe(ids);
  expect(reads).toBe(1);
  expect([...reading([row("a"), row("b")])]).toEqual(["a", "b"]);
  expect(reads).toBe(2);
});
