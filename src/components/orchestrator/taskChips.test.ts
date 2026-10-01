import { afterEach, expect, test } from "bun:test";

import {
  addTaskChip,
  clearTaskChips,
  onOrchestratorFocusRequest,
  onTaskChipOpen,
  openTaskChip,
  readTaskChips,
  removeTaskChip,
  resetTaskChipsForTests,
  taskChipRefs,
} from "./taskChips";

afterEach(() => resetTaskChipsForTests());

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
