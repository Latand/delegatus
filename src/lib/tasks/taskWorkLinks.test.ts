import { expect, test } from "bun:test";

import { patchTask, type TaskWorkLinkContext } from "./commands";
import { snapshotTasks, stampTaskRevisions, taskRevision } from "./revision";
import type { BoardTask } from "./types";

/* Manual PR and issue links on a task (#2059) as a pure command: invented
   repository and numbers, an injected link context, no store. */

const REV = ["task-v1:00000000", "0000", "4000", "8000", "000000000002"].join("-");
const NOW = "2026-09-23T12:00:00.000Z";
const context: TaskWorkLinkContext = { repository: "acme/widgets" };

function task(extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task-a",
    project: "fixture",
    text: "Chips on cards\nPR and issue links",
    status: "assigned",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-22T09:00:00.000Z",
    updatedAt: "2026-09-22T10:00:00.000Z",
    revision: REV,
    ...extra,
  } as BoardTask;
}

const options = { actor: "agent" as const, workLinks: () => context };

test("#2059, 2059 and a full URL are one link, the URL saying what it is; attaching is presentation and moves the revision only", () => {
  const first = patchTask([task()], "task-a", { attachLinks: ["#2059", "2059", "https://github.com/acme/widgets/issues/2059"] }, NOW, options);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.task.workLinks).toEqual([{ repository: "acme/widgets", number: 2059, kind: "issue", addedAt: NOW, addedBy: "agent" }]);
  expect(first.task.updatedAt).toBe(task().updatedAt);
  const before = snapshotTasks([task()]);
  stampTaskRevisions(first.tasks, before, false);
  expect(taskRevision(first.task)).not.toBe(REV);
});

test("the URL's kind wins over an unknown one already stored, and a repeat attach changes nothing", () => {
  const stored = task({ workLinks: [{ repository: "acme/widgets", number: 7, kind: null, addedAt: NOW, addedBy: "operator" }] });
  const typed = patchTask([stored], "task-a", { attachLinks: "github.com/acme/widgets/pull/7" }, NOW, options);
  expect(typed.ok && typed.task.workLinks).toEqual([{ repository: "acme/widgets", number: 7, kind: "pr", addedAt: NOW, addedBy: "operator" }]);
  const repeat = patchTask([stored], "task-a", { attachLinks: 7 }, NOW, options);
  expect(repeat.ok && repeat.task).toEqual(stored);
});

test("detaching removes only what was attached, and the field disappears with the last link", () => {
  const stored = task({ workLinks: [{ repository: "acme/widgets", number: 7, kind: "pr", addedAt: NOW, addedBy: "operator" }] });
  const detached = patchTask([stored], "task-a", { detachLinks: "PR 7" }, NOW, options);
  expect(detached.ok && "workLinks" in detached.task).toBe(false);
  const discovered = patchTask([task()], "task-a", { detachLinks: "#8" }, NOW, { ...options, workLinks: () => ({ ...context, autoVia: () => ["lane-branch"] }) });
  expect(discovered).toMatchObject({ ok: false, status: 409, code: "WORK_LINK_AUTO", field: "detachLinks" });
});

test("a bare number with no known repository, a foreign URL and a bad kind are refused with their field", () => {
  expect(patchTask([task()], "task-a", { attachLinks: "#5" }, NOW, { actor: "agent" })).toMatchObject({ ok: false, status: 400, field: "attachLinks" });
  expect(patchTask([task()], "task-a", { attachLinks: "https://example.com/acme/widgets/pull/5" }, NOW, options)).toMatchObject({ ok: false, field: "attachLinks" });
  expect(patchTask([task()], "task-a", { attachLinks: "#5", linkKind: "commit" }, NOW, options)).toMatchObject({ ok: false, field: "linkKind" });
});

test("links in the same patch as real work do move updatedAt", () => {
  const both = patchTask([task()], "task-a", { attachLinks: "#9", status: "done" }, NOW, options);
  expect(both.ok && both.task.updatedAt).toBe(NOW);
});
