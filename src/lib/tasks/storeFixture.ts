import path from "node:path";

import { readStateCollectionRows } from "@/lib/state/sqliteStateStore";

import { saveTasksFile, TASKS_FILE } from "./store";

/* Test fixtures for the SQLite task store (#1870). Tests that used to compare
   the bytes of `tasks.json` to prove a refusal wrote nothing compare these
   instead: every persisted row (tasks, receipts, migration markers) exactly as
   stored, in row order. */

export function persistedTaskState(filePath = TASKS_FILE): string {
  return JSON.stringify(readStateCollectionRows(path.join(path.dirname(filePath), "state.sqlite"), "tasks"));
}

/** The persisted task rows only, as `tasks.json`'s `tasks` array held them. */
export function persistedTaskRows(filePath = TASKS_FILE): Record<string, unknown>[] {
  const rows = (readStateCollectionRows(path.join(path.dirname(filePath), "state.sqlite"), "tasks") ?? []) as Record<string, unknown>[];
  return rows.filter((row) => typeof row.status === "string" && typeof row.id === "string");
}

/** Empty the store: no tasks, receipts or migration markers. */
export function resetTaskStore(filePath = TASKS_FILE): void {
  saveTasksFile({ tasks: [], recentCreates: [], migrations: {} }, filePath);
}
