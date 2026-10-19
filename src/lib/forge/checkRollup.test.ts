import { expect, test } from "bun:test";
import { rollupChecks } from "./checkRollup";

test("REST check runs and statuses use the same green and red rules as auto-merge", () => {
  expect(rollupChecks([
    { name: "suite", status: "completed", conclusion: "skipped", startedAt: "2026-01-01T00:00:00Z" },
    { context: "optional", state: "error", startedAt: "2026-01-01T00:00:00Z" },
  ])).toEqual([{ name: "optional", verdict: "red" }, { name: "suite", verdict: "green" }]);
});

test("the newest run of one check supersedes its earlier verdict", () => {
  const run = (conclusion: string, startedAt: string) => ({ name: "suite", status: "completed", conclusion, startedAt,
    app: { id: 1 }, checkSuite: { workflowRun: { workflow: { name: "tests" } } } });
  expect(rollupChecks([
    run("failure", "2026-01-01T00:00:00Z"), run("success", "2026-01-01T00:01:00Z"),
  ])).toEqual([{ name: "suite", verdict: "green" }]);
});

test("the newest status context supersedes its earlier state", () => {
  expect(rollupChecks([
    { __typename: "StatusContext", context: "ci", state: "FAILURE", startedAt: "2026-10-16T10:00:00Z" },
    { __typename: "StatusContext", context: "ci", state: "SUCCESS", startedAt: "2026-10-16T10:01:00Z" },
  ])).toEqual([{ name: "ci", verdict: "green" }]);
});

test.each(["FAILURE", "PENDING"] as const)("check runs do not supersede an independent %s status context", state => {
  expect(rollupChecks([
    { __typename: "StatusContext", context: "ci", state, startedAt: "2026-10-16T10:00:00Z" },
    { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z" },
  ])).toEqual([
    { name: "ci", verdict: "green" },
    { name: "ci", verdict: state === "FAILURE" ? "red" : "pending" },
  ]);
});

test.each(["FAILURE", "IN_PROGRESS"] as const)("same-name check runs in distinct workflows stay independent (%s)", state => {
  expect(rollupChecks([
    { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-16T10:01:00Z",
      app: { id: 123 }, checkSuite: { workflowRun: { workflow: { name: "optional-format" } } } },
    { __typename: "CheckRun", name: "ci", status: state, conclusion: "", startedAt: "2026-10-16T10:00:00Z",
      app: { id: 123 }, checkSuite: { workflowRun: { workflow: { name: "required-tests" } } } },
  ])).toEqual([{ name: "ci", verdict: "green" }, { name: "ci", verdict: "pending" }]);
});

test("a completed rerun supersedes an earlier failure for the same app and workflow", () => {
  const run = (conclusion: string, startedAt: string) => ({ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion, startedAt,
    app: { id: 123 }, checkSuite: { workflowRun: { workflow: { name: "required-tests" } } } });
  expect(rollupChecks([run("FAILURE", "2026-10-16T10:00:00Z"), run("SUCCESS", "2026-10-16T10:01:00Z")]))
    .toEqual([{ name: "ci", verdict: "green" }]);
});

test("conflicting same-time results with identical provenance stay pending", () => {
  const run = (conclusion: string) => ({ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion,
    startedAt: "2026-10-16T10:00:00Z", app: { id: 123 }, checkSuite: { workflowRun: { workflow: { name: "required-tests" } } } });
  expect(rollupChecks([run("SUCCESS"), run("FAILURE")]))
    .toEqual([{ name: "ci", verdict: "pending" }]);
});
