import { expect, test } from "bun:test";

import { interleaveDeputyBlocks, placeDeputyBlocks, quoteHead, resumedSeatRows, type ResumeRole } from "./deputyPlacement";

/* docs/design/ghost-seat.md §6.1: a block is pinned at its head by startedAt
   and grows only at its own end. */

const at = (minute: number) => Date.parse(`2026-09-26T12:${String(minute).padStart(2, "0")}:00.000Z`);

test("a block lands after the last seat row dated at or before it, and after the undated rows that follow", () => {
  const rows = [at(30), at(35), null, null, at(41), at(45)];
  expect(placeDeputyBlocks(rows, [{ id: "b", startedAt: at(39) }])).toEqual([{ id: "b", after: 4 }]);
  /* A row dated exactly at the start sits above the block. */
  expect(placeDeputyBlocks(rows, [{ id: "b", startedAt: at(41) }])).toEqual([{ id: "b", after: 5 }]);
});

test("seat rows dated later stay below it, and later arrivals never move it", () => {
  const before = [at(30), at(35)];
  const placed = placeDeputyBlocks(before, [{ id: "b", startedAt: at(39) }]);
  expect(placed).toEqual([{ id: "b", after: 2 }]);
  const grown = [...before, at(40), null, at(44)];
  expect(placeDeputyBlocks(grown, [{ id: "b", startedAt: at(39) }])).toEqual(placed);
  expect(interleaveDeputyBlocks(["r30", "r35", "r40", "rx", "r44"], placed, (id) => `block:${id}`))
    .toEqual(["r30", "r35", "block:b", "r40", "rx", "r44"]);
});

test("two blocks sit in start order, interleaved with the seat's rows between them", () => {
  const rows = [at(30), at(36), at(42)];
  const placed = placeDeputyBlocks(rows, [{ id: "late", startedAt: at(40) }, { id: "early", startedAt: at(33) }]);
  expect(placed).toEqual([{ id: "early", after: 1 }, { id: "late", after: 2 }]);
  expect(interleaveDeputyBlocks(["a", "b", "c"], placed, (id) => id)).toEqual(["a", "early", "b", "late", "c"]);
  /* Two blocks in the same slot keep start order. */
  const same = placeDeputyBlocks([at(30)], [{ id: "second", startedAt: at(34) }, { id: "first", startedAt: at(32) }]);
  expect(interleaveDeputyBlocks(["a"], same, (id) => id)).toEqual(["a", "first", "second"]);
});

test("an empty feed, or one whose rows are all later, places the block first", () => {
  expect(placeDeputyBlocks([], [{ id: "b", startedAt: at(39) }])).toEqual([{ id: "b", after: 0 }]);
  expect(placeDeputyBlocks([at(50), null], [{ id: "b", startedAt: at(39) }])).toEqual([{ id: "b", after: 0 }]);
  expect(interleaveDeputyBlocks([], [{ id: "b", after: 0 }], (id) => id)).toEqual(["b"]);
});

test("the first seat row after a block names the seat head it continues; a new head needs no caption", () => {
  type Row = { role: ResumeRole; text?: string };
  const rows: Row[] = [
    { role: "head", text: "Go through the review queue" },
    { role: "seat" },
    { role: "block" },
    { role: "seat" },
    { role: "seat" },
    { role: "block" },
    { role: "block" },
    { role: "other" },
    { role: "seat" },
    { role: "head", text: "Next question" },
    { role: "block" },
    { role: "head", text: "Answered in place" },
    { role: "seat" },
  ];
  const resumed = resumedSeatRows(rows, (row) => row.role, (row) => row.text ?? null);
  expect([...resumed]).toEqual([[3, "Go through the review queue"], [8, "Go through the review queue"]]);
  /* A block before any seat head resumes with nothing to quote. */
  expect([...resumedSeatRows<Row>([{ role: "block" }, { role: "seat" }], (row) => row.role, () => null)]).toEqual([[1, null]]);
});

test("a quoted head is cut at a word and closed with an ellipsis", () => {
  expect(quoteHead("Short ask")).toBe("Short ask");
  expect(quoteHead("Go through the review queue and tell me what blocks the release.")).toBe("Go through the review queue…");
  expect(quoteHead("Проглянь чергу рев'ю і скажи, що блокує реліз.")).toBe("Проглянь чергу рев'ю і…");
  expect(quoteHead("a\n\n  b")).toBe("a b");
});
