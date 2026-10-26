import { expect, test } from "bun:test";

import { composeLaneReviewMessage, type LaneReviewMessageInput } from "./message";

const BASE = "8e081f431c".padEnd(40, "0");
const HEAD = "bf1c00247d".padEnd(40, "1");

const input = (overrides: Partial<LaneReviewMessageInput> = {}): LaneReviewMessageInput => ({
  locale: "en",
  base: BASE,
  head: HEAD,
  branch: "pipeline/example",
  note: "tighten the error copy before the next round.",
  pathOrder: ["docs/design/example.md", "src/lib/example.ts"],
  comments: [
    { path: "src/lib/example.ts", side: "old", line: 17, quote: "return null;", body: "This removal drops the empty-state answer; keep it." },
    { path: "docs/design/example.md", side: "new", line: null, quote: "", body: "Add the 390 px case.\nAnd the 1024 px one." },
    { path: "src/lib/example.ts", side: "new", line: 42, quote: "const limit = 200;", body: "Read this from REVIEW_DIFF_CAPS instead of repeating it." },
  ],
  ...overrides,
});

test("the English message names both full SHAs, orders the comments and indents every body line", () => {
  expect(composeLaneReviewMessage(input())).toBe(`Line comments on this lane's changes.
Base ${BASE} · head ${HEAD} (branch pipeline/example).
Line numbers: "old" is the file at the base commit, "new" is the file at the head commit.

Overall: tighten the error copy before the next round.

1. docs/design/example.md (file)
   Add the 390 px case.
   And the 1024 px one.

2. src/lib/example.ts:42 (new)
   > const limit = 200;
   Read this from REVIEW_DIFF_CAPS instead of repeating it.

3. src/lib/example.ts:17 (old)
   > return null;
   This removal drops the empty-state answer; keep it.

Address each numbered comment on the branch, or answer why not.`);
});

test("the Ukrainian frame keeps the bodies verbatim", () => {
  expect(composeLaneReviewMessage(input({ locale: "uk", note: "", comments: [input().comments[2]!, { path: "src/lib/example.ts", side: "new", line: null, quote: "return null;", body: "Рядок зник." }] }))).toBe(`Коментарі до змін у цій гілці.
База ${BASE} · голова ${HEAD} (гілка pipeline/example).
Номери рядків: «старий» — файл у базовому коміті, «новий» — у головному.

1. src/lib/example.ts (файл)
   > return null;
   Рядок зник.

2. src/lib/example.ts:42 (новий)
   > const limit = 200;
   Read this from REVIEW_DIFF_CAPS instead of repeating it.

Виправте кожен пронумерований коментар у гілці або поясніть, чому ні.`);
});

test("a note alone makes a message; the same input gives the same bytes", () => {
  const noteOnly = composeLaneReviewMessage(input({ comments: [] }));
  expect(noteOnly).toContain("Overall: tighten the error copy");
  expect(noteOnly).not.toContain("1. ");
  expect(composeLaneReviewMessage(input())).toBe(composeLaneReviewMessage(input()));
});
