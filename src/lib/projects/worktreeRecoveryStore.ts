import { statePath } from "@/lib/configDir";
import type { LifecycleEvent } from "@/lib/lifecycle/journal";
import {
  initializeStateCollections, readStateCollectionRows, SqliteStateCollection, stateDatabaseSignature,
} from "@/lib/state/sqliteStateStore";

/** Recovery's mapping, alias and journal event share the board's SQLite commit.
    JSON ledgers remain readable; these rows augment those same identities. */
export interface WorktreeRecoveryRow {
  source: string;
  target: string;
  displayName: string;
  cwd: string;
  repo: string;
  worktree: string;
  event: LifecycleEvent;
}
export const WORKTREE_RECOVERY_COLLECTION = "worktree_recovery";
const seed = {
  collection: WORKTREE_RECOVERY_COLLECTION, schemaVersion: 1, migrationId: "worktree-recovery-v1",
  key: (row: WorktreeRecoveryRow) => row.source, loadRecords: (): WorktreeRecoveryRow[] => [],
};
function decode(value: unknown): WorktreeRecoveryRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as WorktreeRecoveryRow;
  return [row.source, row.target, row.displayName, row.cwd, row.repo, row.worktree].every(v => typeof v === "string" && !!v)
    && row.event?.type === "project_moved" && typeof row.event.id === "string"
    && row.event.state === "completed" && row.event.project === row.target
    && typeof row.event.at === "string" && typeof row.event.summary === "string"
    && [row.event.pipelineId, row.event.stageId, row.event.attempt, row.event.conversationId, row.event.role].every(v => v === null)
    && Number.isInteger(row.event.seq) && row.event.seq > 0 ? row : null;
}
let cache: { signature: string; rows: WorktreeRecoveryRow[] } | undefined;
/** Read-only, including before the first recovery: never initialize a database. */
export function readWorktreeRecoveries(): readonly WorktreeRecoveryRow[] {
  const file = statePath("state.sqlite");
  const signature = `${file}:${stateDatabaseSignature(file)}`;
  if (cache?.signature === signature) return cache.rows;
  const rows = (readStateCollectionRows(file, WORKTREE_RECOVERY_COLLECTION) ?? []).map(value => {
    const row = decode(value);
    if (!row) throw new Error("Worktree recovery record is unreadable");
    return row;
  });
  cache = { signature, rows };
  return rows;
}
export function worktreeRecoveryCollection(): SqliteStateCollection<WorktreeRecoveryRow> {
  const file = statePath("state.sqlite");
  initializeStateCollections(file, [seed]);
  return new SqliteStateCollection(file, {
    ...seed, clone: row => structuredClone(row), decode, strictDecode: true,
    decodeError: error => new Error("Worktree recovery record is unreadable", { cause: error }),
    busyMessage: "worktree recovery is busy",
  });
}
