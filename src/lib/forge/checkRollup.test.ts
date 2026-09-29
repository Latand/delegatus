import { expect, test } from "bun:test";
import { rollupChecks } from "./checkRollup";

test("REST check runs and statuses use the same green and red rules as auto-merge", () => {
  expect(rollupChecks([
    { name: "suite", status: "completed", conclusion: "skipped", startedAt: "2026-01-01T00:00:00Z" },
    { context: "optional", state: "error", startedAt: "2026-01-01T00:00:00Z" },
  ])).toEqual([{ name: "optional", verdict: "red" }, { name: "suite", verdict: "green" }]);
});

test("the newest run of one check supersedes its earlier verdict", () => {
  expect(rollupChecks([
    { name: "suite", status: "completed", conclusion: "failure", startedAt: "2026-01-01T00:00:00Z" },
    { name: "suite", status: "completed", conclusion: "success", startedAt: "2026-01-01T00:01:00Z" },
  ])).toEqual([{ name: "suite", verdict: "green" }]);
});
