import { afterAll, expect, mock, test } from "bun:test";

import * as actualFiles from "@/hooks/useFiles";
import { LAUNCH_NOT_STARTED_ERROR, type BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * Audit B5/B6: Link, Unlink and the dismissal of a launch that did not start
 * are drawn on the task row before the request, confirmed by the server's row,
 * and taken back on a refusal. The client cache is observed at its entry points.
 */

const actual = { ...actualFiles };
const drawn: string[] = [];
mock.module("@/hooks/useFiles", () => ({
  ...actual,
  applyTaskSnapshot: (task: BoardTask, confirmed = true) => drawn.push(`${confirmed ? "echo" : "draw"}:${task.id}:${task.assignments.map((row) => `${row.path ?? row.launchId}/${row.state}`).join(",")}`),
  revertTaskSnapshot: (id: string) => drawn.push(`revert:${id}`),
}));
afterAll(() => { mock.module("@/hooks/useFiles", () => actual); });

const { optimisticAssignment, predictDismissedLaunches, predictLink, predictUnlink } = await import("./kanbanAssignments");

const AT = "2026-10-16T10:00:00.000Z";
const task = (assignments: BoardTask["assignments"] = []): BoardTask => ({ id: "t-1", project: "fixture", text: "Task", status: "assigned", placement: "unplaced", assignments, createdAt: AT, updatedAt: AT }) as BoardTask;
const file = { path: "/c/one.jsonl", conversationId: "c-1" } as FileEntry;

test("the predicted rows: a link adds one handoff, an unlink removes the row, a dismissal marks the launch failed", () => {
  const linked = predictLink(task(), file, AT);
  expect(linked.assignments).toEqual([{ path: "/c/one.jsonl", conversationId: "c-1", panePid: null, state: "handoff", error: null, at: AT }]);
  expect(predictLink(linked, file, AT)).toBe(linked);
  expect(predictUnlink(linked, { conversationId: "c-1" }).assignments).toEqual([]);
  const launching = task([{ launchId: "l-1", path: null, conversationId: "c-2", panePid: null, state: "spawning", error: null, at: AT }]);
  expect(predictDismissedLaunches(launching, [{ launchId: "l-1", conversationId: "c-2" }], AT).assignments[0]).toMatchObject({ state: "failed", error: LAUNCH_NOT_STARTED_ERROR });
});

test("a link is drawn before the request and replaced by the server's row", async () => {
  drawn.length = 0;
  let answer: (value: { ok: true; task: BoardTask }) => void = () => {};
  const done = optimisticAssignment(predictLink(task(), file, AT), () => new Promise((resolve) => { answer = resolve; }));
  expect(drawn).toEqual(["draw:t-1:/c/one.jsonl/handoff"]);
  answer({ ok: true, task: predictLink(task(), { path: "/c/one.jsonl", conversationId: "c-1" } as FileEntry, AT) });
  expect((await done).ok).toBe(true);
  expect(drawn).toEqual(["draw:t-1:/c/one.jsonl/handoff", "echo:t-1:/c/one.jsonl/handoff"]);
});

test("a refused unlink is taken back", async () => {
  drawn.length = 0;
  const linked = predictLink(task(), file, AT);
  const done = await optimisticAssignment(predictUnlink(linked, { conversationId: "c-1" }), async () => ({ ok: false, status: 409, error: "the conversation's own task" }));
  expect(done).toEqual({ ok: false, status: 409, error: "the conversation's own task" });
  expect(drawn).toEqual(["draw:t-1:", "revert:t-1"]);
});
