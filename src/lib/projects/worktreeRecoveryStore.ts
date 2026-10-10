import fs from "node:fs";

import { stateDir, statePath } from "@/lib/configDir";
import type { LifecycleEvent } from "@/lib/lifecycle/journal";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { assertStateMutationAllowed } from "@/lib/state/stateMutationBarrier";
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

/** The retiring Viewer (or the adapter in its scoped activation) holds the
    release fence until every mirror succeeds. Project the atomic recovery into
    the files a retained release reads before it may resume writes. A failed
    checkpoint blocks demotion and can be retried from the same SQLite rows. */
export async function checkpointWorktreeRecoveryForDemotion(): Promise<void> {
  if (!readWorktreeRecoveries().length) return;
  assertStateMutationAllowed(stateDir());
  const { projectAliasSnapshot } = await import("./aliases");
  const { lifecycleJournalPath, readLifecycleJournal } = await import("@/lib/lifecycle/journal");
  const mapFile = statePath("worktree-map.json");
  const aliasesFile = statePath("project-aliases.json");
  // Match recovery's lock order; ordinary writers cannot overwrite a projection
  // between its read and write, or allocate an already used journal sequence.
  withFileTransactionSync(mapFile, "worktree recovery is busy", () =>
    withFileTransactionSync(aliasesFile, "project aliases are busy", () =>
      withFileTransactionSync(lifecycleJournalPath(), "lifecycle journal is busy", () => {
        let map: Record<string, { repo: string; worktree: string }> = {};
        try { map = JSON.parse(fs.readFileSync(mapFile, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (!map || typeof map !== "object" || Array.isArray(map)
          || Object.values(map).some(item => !item || typeof item.repo !== "string" || typeof item.worktree !== "string")) {
          throw new Error("Worktree map is unreadable");
        }
        for (const { cwd, repo, worktree } of readWorktreeRecoveries()) {
          if (map[cwd] && map[cwd]!.repo !== repo) throw new Error("Worktree recovery conflicts with a recorded mapping");
          map[cwd] = { repo, worktree };
        }
        // Validate every projection before publishing any of them. These are
        // compatibility files only; the live commit remains wholly in SQLite.
        const aliases = projectAliasSnapshot({ strict: true });
        const journal = readLifecycleJournal();
        writeJsonDurably(mapFile, map, { space: 0 });
        writeJsonDurably(aliasesFile, { schemaVersion: 1, ...aliases });
        writeJsonDurably(lifecycleJournalPath(), journal);
      })));
}
