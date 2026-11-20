import { expect, test } from "bun:test";
import type { BoardTask, TaskAssignment } from "./types";
import { taskChatParents } from "./chatParents";

const mainPath = "/sessions/main.jsonl";
const childPath = "/sessions/child.jsonl";
const assignment = (path: string, conversationId: string, engine: TaskAssignment["engine"] = "codex"): TaskAssignment => ({
  path, conversationId, engine, state: "linked", at: "2026-01-01T00:00:00Z", panePid: null, error: null,
});
const task = (id: string, project: string, assignments: TaskAssignment[], own?: string): BoardTask => ({
  id, project, assignments, text: id, placement: "unplaced", status: "assigned",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  ...(own ? { origin: { kind: "conversation", key: own, refinement: "titled" } } : {}),
});

test("a task link uses the recorded parent, keeps the originating card and ignores a foreign board", () => {
  const linkedParent = assignment(mainPath, "main-chat");
  const parent = task("parent", "app", [linkedParent], "main-chat");
  const child = task("child", "app", [assignment(childPath, "child-chat")], "child-chat");
  const mirror = task("mirror", "app", [linkedParent]);
  const foreign = task("foreign", "other", [assignment(childPath, "foreign-chat")], "foreign-chat");
  const parentFile = (pathname: string) => ({ engine: "codex" as const, parent: pathname === childPath ? mainPath : null, kind: "session", mtime: 1 });

  expect([...taskChatParents([mirror, parent, child, foreign], parentFile)]).toEqual([["child", "parent"]]);
  expect([...taskChatParents([mirror, parent, { ...child, status: "blocked" }], parentFile)]).toEqual([["child", "parent"]]);
  expect([...taskChatParents([parent, { ...mirror, origin: parent.origin }, child], parentFile)]).toEqual([]);
});

test("Desktop parentage connects tasks even if neither transcript is in the board feed", () => {
  const pid = crypto.randomUUID();
  const cid = crypto.randomUUID();
  const prior = crypto.randomUUID();
  const parent = task("parent", "app", [assignment(`/sessions/${pid}.jsonl`, "p", "claude")], "p");
  const child = task("child", "app", [assignment(`/sessions/${cid}.jsonl`, "c", "claude")], "c");
  const previousParent = { ...parent, assignments: [assignment(`/sessions/${prior}.jsonl`, "p", "claude")] };
  const desktopParent = { key: "parent", currentId: pid, parentKey: null, title: "Planning" };
  const desktop = new Map([
    [pid, desktopParent], [prior, desktopParent],
    [cid, { key: "child", currentId: cid, parentKey: "parent", title: "Design" }],
  ]);

  expect([...taskChatParents([parent, child], () => undefined, desktop)]).toEqual([["child", "parent"]]);
  expect([...taskChatParents([previousParent, child], () => undefined, desktop)]).toEqual([["child", "parent"]]);
});
