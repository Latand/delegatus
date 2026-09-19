import { loadTasks, saveTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

/* Writes tasks through the production task store in a process of its own, so
   the parent test holds no connection to the database it later damages and
   restores. Prints the task ids the store reads back. */

const args = process.argv.slice(2);
const readOnly = args[0] === "--read";
const [tasksFile, ...ids] = readOnly ? args.slice(1) : args;
if (!tasksFile) throw new Error("tasks file argument is required");

const tasks: BoardTask[] = ids.map((id) => ({
  id,
  project: "proj",
  status: "inbox",
  text: `task ${id}`,
  placement: "unplaced",
  assignments: [],
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
}));
if (!readOnly) saveTasks(tasks, tasksFile);
process.stdout.write(JSON.stringify(loadTasks(tasksFile).map((task) => task.id)));
