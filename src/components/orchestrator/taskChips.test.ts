import { afterEach, beforeAll, expect, test } from "bun:test";

import {
  addTaskChip,
  clearTaskChips,
  onOrchestratorFocusRequest,
  MAX_TASK_CHIPS,
  onTaskChipOpen,
  openTaskChip,
  readTaskChips,
  reloadTaskChipsForTests,
  removeTaskChip,
  resetTaskChipsForTests,
  taskChipsStorageKey,
  taskChipRefs,
  settleTaskChips,
  restoreTaskChips,
} from "./taskChips";

/* The tab's session storage, as a reload keeps it. */
beforeAll(() => {
  if (typeof sessionStorage !== "undefined") return;
  const map = new Map<string, string>();
  Object.assign(globalThis, {
    sessionStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    },
  });
});

afterEach(() => resetTaskChipsForTests());

test("chips survive a page reload beside the draft they belong to", () => {
  addTaskChip("atlas", { id: "t1", title: "First", color: "teal", icon: "rocket" });
  addTaskChip("atlas", { id: "t2", title: "Second" });
  addTaskChip("borealis", { id: "t9", title: "Elsewhere" });
  reloadTaskChipsForTests();
  expect(readTaskChips("atlas")).toEqual([
    { id: "t1", title: "First", color: "teal", icon: "rocket" },
    { id: "t2", title: "Second" },
  ]);
  expect(readTaskChips("borealis").map((chip) => chip.id)).toEqual(["t9"]);
});

test("a removed or sent chip does not come back after a reload", () => {
  addTaskChip("atlas", { id: "t1", title: "First" });
  addTaskChip("atlas", { id: "t2", title: "Second" });
  removeTaskChip("atlas", "t1");
  reloadTaskChipsForTests();
  expect(readTaskChips("atlas").map((chip) => chip.id)).toEqual(["t2"]);
  clearTaskChips("atlas");
  reloadTaskChipsForTests();
  expect(readTaskChips("atlas")).toEqual([]);
  expect(sessionStorage.getItem(taskChipsStorageKey("atlas"))).toBeNull();
});

test("a stored list that is damaged restores what is valid and never throws", () => {
  sessionStorage.setItem(taskChipsStorageKey("atlas"), JSON.stringify([{ id: "t1", title: "Kept" }, { id: 5 }, null, { id: "t1", title: "Dup" }]));
  expect(readTaskChips("atlas")).toEqual([{ id: "t1", title: "Kept" }]);
  reloadTaskChipsForTests();
  sessionStorage.setItem(taskChipsStorageKey("atlas"), "{not json");
  expect(readTaskChips("atlas")).toEqual([]);
});

test("a task past the cap is refused, and every attached chip is one the wire can carry", () => {
  for (let n = 0; n < MAX_TASK_CHIPS; n += 1) expect(addTaskChip("atlas", { id: `t${n}`, title: `Task ${n}` })).toBe(true);
  expect(addTaskChip("atlas", { id: "extra", title: "Ninth" })).toBe(false);
  expect(readTaskChips("atlas")).toHaveLength(MAX_TASK_CHIPS);
  expect(readTaskChips("atlas").some((chip) => chip.id === "extra")).toBe(false);
  expect(taskChipRefs(readTaskChips("atlas"))).toHaveLength(MAX_TASK_CHIPS);
  /* A task already attached still refreshes, and room made by × admits a new one. */
  expect(addTaskChip("atlas", { id: "t0", title: "Renamed" })).toBe(true);
  removeTaskChip("atlas", "t1");
  expect(addTaskChip("atlas", { id: "extra", title: "Ninth" })).toBe(true);
});

test("a chip is added to its project's orchestrator and keeps the order it was added in", () => {
  addTaskChip("atlas", { id: "t1", title: "First" });
  addTaskChip("atlas", { id: "t2", title: "Second", color: "teal" });
  expect(readTaskChips("atlas").map((chip) => chip.id)).toEqual(["t1", "t2"]);
  expect(readTaskChips("atlas")[1]!.color).toBe("teal");
});

test("adding the same task twice keeps one chip, with the latest title", () => {
  addTaskChip("atlas", { id: "t1", title: "Old" });
  addTaskChip("atlas", { id: "t1", title: "Renamed" });
  expect(readTaskChips("atlas")).toEqual([{ id: "t1", title: "Renamed" }]);
});

test("chips belong to a project: another project's orchestrator sees none of them", () => {
  addTaskChip("atlas", { id: "t1", title: "First" });
  expect(readTaskChips("borealis")).toEqual([]);
});

test("removing one chip leaves the rest, and the list identity changes only when it must", () => {
  addTaskChip("atlas", { id: "t1", title: "First" });
  addTaskChip("atlas", { id: "t2", title: "Second" });
  const before = readTaskChips("atlas");
  removeTaskChip("atlas", "nope");
  expect(readTaskChips("atlas")).toBe(before);
  removeTaskChip("atlas", "t1");
  expect(readTaskChips("atlas").map((chip) => chip.id)).toEqual(["t2"]);
});

test("a send clears exactly the chips it carried; one added meanwhile stays", () => {
  addTaskChip("atlas", { id: "t1", title: "First" });
  addTaskChip("atlas", { id: "t2", title: "Second" });
  clearTaskChips("atlas", ["t1"]);
  addTaskChip("atlas", { id: "t3", title: "Third" });
  expect(readTaskChips("atlas").map((chip) => chip.id)).toEqual(["t2", "t3"]);
  clearTaskChips("atlas");
  expect(readTaskChips("atlas")).toEqual([]);
});

test("the wire reference of a chip list is id and title only", () => {
  addTaskChip("atlas", { id: "t1", title: "First", color: "teal", icon: "rocket" });
  expect(taskChipRefs(readTaskChips("atlas"))).toEqual([{ id: "t1", title: "First" }]);
});

test("subscribers hear every change, and stop hearing after they leave", async () => {
  const { subscribeTaskChips } = await import("./taskChips");
  let heard = 0;
  const off = subscribeTaskChips(() => { heard += 1; });
  addTaskChip("atlas", { id: "t1", title: "First" });
  removeTaskChip("atlas", "t1");
  expect(heard).toBe(2);
  off();
  addTaskChip("atlas", { id: "t2", title: "Second" });
  expect(heard).toBe(2);
});

test("adding a chip asks the shell to open that project's orchestrator", () => {
  const heard: string[] = [];
  const off = onOrchestratorFocusRequest((project) => heard.push(project));
  addTaskChip("atlas", { id: "t1", title: "First" });
  off();
  expect(heard).toEqual(["atlas"]);
});

test("opening a chip names the task and its project to the board", () => {
  const heard: { project: string; id: string }[] = [];
  const off = onTaskChipOpen((request) => heard.push(request));
  openTaskChip("atlas", "t1");
  off();
  expect(heard).toEqual([{ project: "atlas", id: "t1" }]);
});


test("settling a captured snapshot preserves a refreshed identity and later chips", () => {
  addTaskChip("atlas", { id: "t1", title: "First" });
  addTaskChip("atlas", { id: "t2", title: "Second" });
  const snapshot = readTaskChips("atlas");
  addTaskChip("atlas", { id: "t1", title: "Updated" });
  addTaskChip("atlas", { id: "t3", title: "Later" });
  settleTaskChips("atlas", snapshot);
  expect(readTaskChips("atlas")).toEqual([{ id: "t1", title: "Updated" }, { id: "t3", title: "Later" }]);
  reloadTaskChipsForTests();
  expect(readTaskChips("atlas")).toEqual([{ id: "t1", title: "Updated" }, { id: "t3", title: "Later" }]);
});

test("restoring a refused snapshot preserves a later version of the same task", () => {
  addTaskChip("atlas", { id: "t1", title: "Updated" });
  restoreTaskChips("atlas", [{ id: "t1", title: "Original" }, { id: "t2", title: "Second" }]);
  expect(readTaskChips("atlas")).toEqual([{ id: "t1", title: "Updated" }, { id: "t2", title: "Second" }]);
});


test("restoring tasks refuses atomically if later chips filled the cap", () => {
  for (let i = 0; i < MAX_TASK_CHIPS - 1; i++) addTaskChip("atlas", { id: `later_${i}`, title: `Later ${i}` });
  const before = readTaskChips("atlas");
  expect(restoreTaskChips("atlas", [{ id: "old_1", title: "First" }, { id: "old_2", title: "Second" }])).toBe(false);
  expect(readTaskChips("atlas")).toBe(before);
});


test("a persisted delivery snapshot settles after reload and preserves identical reattachments", async () => {
  const { captureTaskChipSnapshot, settleTaskChipSnapshot } = await import("./taskChips");
  addTaskChip("atlas", { id: "t1", title: "First" });
  addTaskChip("atlas", { id: "t2", title: "Second" });
  const snapshot = JSON.parse(JSON.stringify(captureTaskChipSnapshot("atlas", readTaskChips("atlas"))));
  reloadTaskChipsForTests();
  addTaskChip("atlas", { id: "t2", title: "Second" });
  settleTaskChipSnapshot("atlas", snapshot);
  expect(readTaskChips("atlas")).toEqual([{ id: "t2", title: "Second" }]);
});
