import { attemptAccountingSchema } from "../src/lib/pipelines/accounting";
import { taskAccountingSchema } from "../src/lib/tasks/accounting";
import { Database } from "bun:sqlite";
import { accountingReport } from "../src/lib/pipelines/accountingReport";
import type { BoardTask } from "../src/lib/tasks/types";
import type { Pipeline } from "../src/lib/pipelines/types";

/** Explicit database input; opening a report cannot initialize or migrate state. */
export function storedAccountingReport(filename: string, from: string, to: string, asOf = to) {
  const db = new Database(filename, { readonly: true });
  try {
    return db.transaction(() => {
      const read = <T>(collection: string) => db.query<{ value_json: string }, [string, string]>(
        "SELECT value_json FROM state_rows WHERE collection=? AND (?<>'tasks' OR row_key LIKE 't:%') ORDER BY row_key").all(collection, collection).map(row => JSON.parse(row.value_json) as T);
      const tasks = read<BoardTask>("tasks");
      const lanes = [...read<Pipeline>("pipelines"), ...read<Pipeline>("pipelines_archive")];
      for (const task of tasks) if (task.accounting) taskAccountingSchema.parse(task.accounting);
      for (const lane of lanes) for (const run of lane.runs) for (const attempt of run.attempts)
        if (attempt.accounting) attemptAccountingSchema.parse(attempt.accounting);
      return accountingReport(tasks, lanes, { from, to, asOf });
    })();
  } finally { db.close(); }
}

if (import.meta.main) {
  const [database, from, to, asOf] = process.argv.slice(2);
  if (!database || !from || !to) throw new Error("usage: bun scripts/accounting-report.ts DATABASE FROM TO [AS_OF]");
  process.stdout.write(JSON.stringify(storedAccountingReport(database, from, to, asOf), null, 2) + "\n");
}
