import { expect, test } from "bun:test";

import { readDataset, validate } from "./runner";

test("pilot manifest pins all nine cells and immutable fixture inputs", () => {
  const dataset = readDataset();
  expect(validate(dataset)).toEqual([]);
  expect(dataset.cells).toHaveLength(9);
  expect(dataset.fixtures.map((fixture) => fixture.baseCommit)).toHaveLength(3);
});

test("manifest rejects a mutable brief and A/B treatment drift", () => {
  const dataset = readDataset();
  const mutable = structuredClone(dataset);
  mutable.cells.find((cell) => cell.id === "quota-window-B")!.briefHash = "not-a-hash";
  mutable.cells.find((cell) => cell.id === "quota-window-A")!.requestedEffort = "medium";
  expect(validate(mutable)).toContain("quota-window-B: brief hash contract is invalid");
  expect(validate(mutable)).toContain("quota-window: A/B model or effort mismatch");
});
