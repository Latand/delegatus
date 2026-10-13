import { expect, test } from "bun:test";
import type { FileEntry } from "@/lib/types";
import { buildBranchGroups } from "./projectModel";
import { createOverviewGroups } from "./overviewGroups";

const file = (path: string, project: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  path, project, root: "claude-projects", name: path, kind: "session", engine: "claude", fmt: "claude", parent: null,
  title: path, mtime: 1000, size: 1, activity: "live", proc: "running", pid: null, model: null,
  pendingQuestion: null, waitingInput: null, ...overrides,
});

test("only changed project groups rebuild; deletion and scope removal drop their cached rows", () => {
  const group = createOverviewGroups();
  const a = file("a", "a"), b = file("b", "b");
  const first = group([a, b], ["a", "b"], 1000);
  const updated = { ...a, size: 2 };
  const next = group([updated, b], ["a", "b"], 1000);
  expect(next).toEqual([buildBranchGroups([updated, b], "a", { now: 1000 })[0], first[1]]);
  expect(next[0]).not.toBe(first[0]);
  expect(next[1]).toBe(first[1]);
  expect(group([b], ["a", "b"], 1000)).toEqual([first[1]]);
  expect(group([b], [], 1000)).toEqual([]);
  expect(group([b], ["b"], 1000)[0]).not.toBe(first[1]);
});

test("foreign parent arrival, removal and project movement preserve the full grouper's answer", () => {
  const group = createOverviewGroups();
  const child = file("child", "b", { parent: "parent", kind: "subagent", activity: "idle", proc: null });
  const parent = file("parent", "a");
  for (const files of [[child], [parent, child], [{ ...parent, project: "b" }, child], [child]]) {
    expect(group(files, ["a", "b"], 1000)).toEqual(["a", "b"].flatMap(p => buildBranchGroups(files, p, { now: 1000 })));
  }
});

test("clock expiry still removes quiet roots without a catalog update", () => {
  const group = createOverviewGroups();
  const files = [file("old", "a", { activity: "idle", proc: null })];
  expect(group(files, ["a"], 1000)).toHaveLength(1);
  expect(group(files, ["a"], 1000 + 49 * 3600)).toEqual([]);
});
