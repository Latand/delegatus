import type { Database } from "bun:sqlite";
import { observeSqlite } from "../sqliteReadAttribution";
import { taskPriority, type TaskPriority } from "../tasks/types";

/** A durable binding keeps commands on the lane's current board priority. */
export type CpuPrioritySource = { database: string; taskIds: readonly string[] };

export const CPU_TASK_PRIORITY_SQL = "SELECT json_extract(value_json, '$.priority') AS priority FROM state_rows WHERE collection = 'tasks' AND row_key = ?";

export function readCpuPriority(source: CpuPrioritySource): TaskPriority {
  if (!source.taskIds.length) return "normal";
  const sqlite = process.getBuiltinModule!("bun:sqlite") as typeof import("bun:sqlite");
  const db: Database = observeSqlite(new sqlite.Database(source.database, { readonly: true }), "cpu-task-priority");
  try {
    // A serving loop never waits for another writer. Unavailable evidence
    // refuses this check; it cannot silently demote a waiting high task.
    db.exec("PRAGMA busy_timeout=0");
    let result: TaskPriority | undefined;
    const query = db.query<{ priority: unknown }, [string]>(CPU_TASK_PRIORITY_SQL);
    for (const id of new Set(source.taskIds)) {
      const row = query.get(`t:${id}`);
      if (!row) continue;
      const priority = taskPriority(row);
      if (priority === "high") return priority;
      if (result === undefined || priority === "normal") result = priority;
    }
    return result ?? "normal";
  } finally { db.close(); }
}

export function cpuPriorityEnv(source: CpuPrioritySource): Partial<NodeJS.ProcessEnv> {
  return { LLV_GATE_CPU_PRIORITY_SOURCE: JSON.stringify(source) };
}

export function cpuPriorityFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): CpuPrioritySource {
  if (!env.LLV_GATE_CPU_PRIORITY_SOURCE) return { database: "", taskIds: [] };
  const source = JSON.parse(env.LLV_GATE_CPU_PRIORITY_SOURCE) as CpuPrioritySource;
  if (source && typeof source === "object" && typeof source.database === "string"
    && Array.isArray(source.taskIds) && source.taskIds.every(id => typeof id === "string")) return source;
  throw new Error("Invalid CPU task priority binding");
}
