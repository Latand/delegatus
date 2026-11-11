import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { foregroundCheckTiming } from "@/lib/recordedChecks/timing";
import type { TimeSpan } from "@/lib/pipelines/accounting";

/** The existing launch/root ledger pins ownership; no root discovery scan. */
export function readAttemptCheckTiming(launch: string, pipeline: string): TimeSpan[] {
  const filename = statePath("attempt-temp.sqlite");
  if (!fs.existsSync(filename)) return [];
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) return [];
  const db = new sqlite.Database(filename, { readonly: true });
  try {
    const roots = db.query<{ directory: string; identity: string }, [string, string]>(
      "SELECT directory,identity FROM roots WHERE launchId=? AND pipelineId=? ORDER BY directory LIMIT 8").all(launch, pipeline);
    return roots.flatMap(root => foregroundCheckTiming(root.directory, root.identity).flatMap(row => [
      ...row.queue.map(value => ({ kind: "checkQueue" as const, ...value })),
      ...row.runners.map(value => ({ kind: "checkRunner" as const, ...value })),
    ]));
  } finally { db.close(); }
}
