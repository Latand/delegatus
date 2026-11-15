import { afterEach, expect, test } from "bun:test";
import { productionDeputyCommandPorts } from "@/lib/orchestrator/deputyCommandPorts";
import { loadTasks, loadTasksForList, saveTasks } from "./store";
import type { BoardTask } from "./types";

const native = globalThis.structuredClone;
afterEach(() => { globalThis.structuredClone = native; });

/* Counts every structured clone the block runs. A whole-collection read with a
   copy clones each stored row; a read of the shared frozen list clones none. */
function clonesDuring<T>(work: () => T): { value: T; clones: number } {
  let clones = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { clones++; return native(value, options); }) as typeof structuredClone;
  try { return { value: work(), clones }; } finally { globalThis.structuredClone = native; }
}

function seed(count: number): BoardTask[] {
  const tasks = Array.from({ length: count }, (_, index): BoardTask => ({
    id: crypto.randomUUID(), project: "proj", status: index % 3 ? "done" : "inbox", text: `task ${index}\nsecond line`,
    placement: "unplaced", assignments: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: new Date().toISOString(),
  }));
  saveTasks(tasks);
  return tasks;
}

test("a deputy's work context reads the project's tasks without copying the collection", () => {
  const tasks = seed(120);
  loadTasksForList();
  const { value, clones } = clonesDuring(() => productionDeputyCommandPorts().workContext("proj"));
  expect(value.recentTasks).toHaveLength(120);
  expect(value.recentTasks[0]).toEqual({ id: tasks[0]!.id, title: "task 0", status: "inbox" });
  expect(clones).toBe(0);
});

test("the shared list holds what a copying read holds, and refuses a write", () => {
  seed(40);
  const shared = loadTasksForList();
  expect(clonesDuring(() => loadTasksForList()).clones).toBe(0);
  const copied = clonesDuring(() => loadTasks());
  expect(copied.clones).toBeGreaterThanOrEqual(40);
  expect(JSON.stringify(shared)).toBe(JSON.stringify(copied.value));
  expect(loadTasksForList()).toBe(shared);
  expect(() => { (shared[0] as BoardTask).status = "blocked"; }).toThrow(TypeError);
  expect(() => { (shared as BoardTask[]).push(copied.value[0]!); }).toThrow(TypeError);
});
