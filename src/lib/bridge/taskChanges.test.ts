import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BoardTask } from "@/lib/tasks/types";

import {
  deployTaskChanges,
  projectSnapshots,
  recordDeploySnapshot,
  recordDeploySnapshots,
  resetTaskChangeCollectionsForTests,
  TASK_STATUS_SNAPSHOTS_KEPT,
  type SettledDeployment,
} from "./taskChanges";

/* docs/design/orchestrator-reports.md §3.8. Titles are invented. */

const PROJECT = "repo-project-a";
let sandbox = "";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-changes-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetTaskChangeCollectionsForTests();
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  resetTaskChangeCollectionsForTests();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function task(id: string, status: BoardTask["status"], text = `Task ${id}`, extra: Partial<BoardTask> = {}): BoardTask {
  return { id, project: PROJECT, status, text, assignments: [], createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", ...extra } as unknown as BoardTask;
}

function deploy(index: number, settledAt: string, phase = "succeeded"): SettledDeployment {
  return {
    deploymentId: `d000000${index}-0000-4000-8000-00000000000${index}`,
    revision: `${String(index).repeat(8)}`.padEnd(40, "0"),
    phase,
    terminal: true,
    updatedAt: settledAt,
  };
}

test("one snapshot per settled deploy, idempotent by deployment id, the newest ten kept", () => {
  const board = [task("a", "inbox")];
  expect(recordDeploySnapshot(PROJECT, deploy(1, "2026-09-25T10:00:00Z"), board)).toBe(true);
  expect(recordDeploySnapshot(PROJECT, deploy(1, "2026-09-25T10:00:00Z"), [task("a", "done")])).toBe(false);
  expect(projectSnapshots(PROJECT)[0]!.statuses).toEqual({ a: "inbox" });
  expect(recordDeploySnapshot(PROJECT, { ...deploy(2, "2026-09-25T10:05:00Z"), terminal: false }, board)).toBe(false);

  const many = Array.from({ length: 14 }, (_, index) => ({
    ...deploy(3, `2026-09-25T${String(11 + index).padStart(2, "0")}:00:00Z`),
    deploymentId: `e${String(index).padStart(7, "0")}-0000-4000-8000-000000000000`,
  }));
  expect(recordDeploySnapshots(PROJECT, many, board)).toBe(14);
  const kept = projectSnapshots(PROJECT);
  expect(kept).toHaveLength(TASK_STATUS_SNAPSHOTS_KEPT);
  expect(kept.at(-1)!.deploymentId).toBe(many.at(-1)!.deploymentId);
});

test("done, blocked, in progress and new are listed; moves back to inbox, hidden and deleted tasks are left out", () => {
  recordDeploySnapshot(PROJECT, deploy(1, "2026-09-25T10:00:00Z"), [
    task("done", "assigned"), task("blocked", "assigned"), task("started", "inbox"), task("back", "assigned"),
    task("hidden", "inbox"), task("deleted", "inbox"), task("same", "done"),
  ]);
  const board = [
    task("done", "done", "Fix the scroll\nsecond line is not the title"), task("blocked", "blocked"), task("started", "assigned"), task("back", "inbox"),
    task("hidden", "done", "Hidden one", { board: "hidden" }), task("same", "done"), task("new", "inbox", "A brand new task"),
  ];
  recordDeploySnapshot(PROJECT, deploy(2, "2026-09-25T11:00:00Z"), board);
  expect(deployTaskChanges(PROJECT, deploy(2, "").deploymentId, board)).toEqual({
    groups: { done: ["Fix the scroll"], blocked: ["Task blocked"], assigned: ["Task started"], created: ["A brand new task"] },
    notOnProdYet: false,
  });
});

test("late filing: a task done after D2 settled is not in D2's list, and is in D3's", () => {
  recordDeploySnapshot(PROJECT, deploy(1, "2026-09-25T08:00:00Z"), [task("t", "assigned")]);
  /* D2 succeeds at 10:00; its snapshot is taken then. */
  recordDeploySnapshot(PROJECT, deploy(2, "2026-09-25T10:00:00Z"), [task("t", "assigned")]);
  /* The task moves to Done at 11:00; D2's report is filed at 12:00. */
  const board = [task("t", "done")];
  expect(deployTaskChanges(PROJECT, deploy(2, "").deploymentId, board)).toEqual({ groups: {}, notOnProdYet: false });
  recordDeploySnapshot(PROJECT, deploy(3, "2026-09-25T13:00:00Z"), board);
  expect(deployTaskChanges(PROJECT, deploy(3, "").deploymentId, board)!.groups).toEqual({ done: ["Task t"] });
});

test("a successful deploy that never got a report is still the next list's starting point", () => {
  recordDeploySnapshot(PROJECT, deploy(1, "2026-09-25T08:00:00Z"), [task("a", "inbox"), task("b", "inbox")]);
  recordDeploySnapshot(PROJECT, deploy(2, "2026-09-25T09:00:00Z"), [task("a", "done"), task("b", "inbox")]);
  const board = [task("a", "done"), task("b", "done")];
  recordDeploySnapshot(PROJECT, deploy(3, "2026-09-25T10:00:00Z"), board);
  expect(deployTaskChanges(PROJECT, deploy(3, "").deploymentId, board)!.groups).toEqual({ done: ["Task b"] });
});

test("a failed deploy lists from the last successful one and is marked not on prod yet", () => {
  recordDeploySnapshot(PROJECT, deploy(1, "2026-09-25T08:00:00Z"), [task("a", "inbox")]);
  recordDeploySnapshot(PROJECT, deploy(2, "2026-09-25T09:00:00Z", "failed"), [task("a", "done")]);
  const board = [task("a", "done"), task("b", "inbox")];
  recordDeploySnapshot(PROJECT, deploy(3, "2026-09-25T10:00:00Z", "failed"), board);
  expect(deployTaskChanges(PROJECT, deploy(3, "").deploymentId, board)).toEqual({ groups: { done: ["Task a"], created: ["Task b"] }, notOnProdYet: true });
});

test("a deploy with no snapshot, or with nothing successful before it, has no list", () => {
  expect(deployTaskChanges(PROJECT, "missing", [])).toBeNull();
  recordDeploySnapshot(PROJECT, deploy(1, "2026-09-25T08:00:00Z"), [task("a", "inbox")]);
  expect(deployTaskChanges(PROJECT, deploy(1, "").deploymentId, [])).toBeNull();
});
