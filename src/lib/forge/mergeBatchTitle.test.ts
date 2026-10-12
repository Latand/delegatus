import { expect, test } from "bun:test";

import { isMergeBatchHead, mergeBatchTitle, parseMergeBatchTitle } from "./mergeBatchTitle";

/* The merge batch's title is a contract between `scripts/merge-batch.ts`,
   which writes it, and the «Готово» projection, which reads which closed PRs
   landed through it (docs/design/done-section.md §2.1). */

test("the batch title names its PRs in order, and the parser reads back exactly those numbers", () => {
  expect(mergeBatchTitle([2699, 2708, 2710])).toBe("Merge batch: #2699, #2708, #2710");
  expect(parseMergeBatchTitle("Merge batch: #2699, #2708, #2710")).toEqual([2699, 2708, 2710]);
  expect(parseMergeBatchTitle(mergeBatchTitle([7]))).toEqual([7]);
});

test("any other title names no batch members", () => {
  for (const title of ["Fix the merge batch: #12", "Merge batch: #12, and more", "Merge batch: 12", "Merge batch: ", "", null, undefined]) {
    expect(parseMergeBatchTitle(title)).toEqual([]);
  }
});

test("a batch head is recognized by its branch prefix only", () => {
  expect(isMergeBatchHead("merge-batch/one")).toBe(true);
  expect(isMergeBatchHead("pipeline/merge-batch-fix")).toBe(false);
});
