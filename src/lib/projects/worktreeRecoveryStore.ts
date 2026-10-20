import crypto from "node:crypto";
import { worktreeMapStore, readProjectDocument } from "./persistence";

import { stateDir, statePath } from "@/lib/configDir";
import type { LifecycleEvent } from "@/lib/lifecycle/journal";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionAttempt } from "@/lib/state/fileTransaction";
import { assertStateMutationAllowed } from "@/lib/state/stateMutationBarrier";
import {
  initializeStateCollections, readStateCollectionRevision, readStateCollectionRows, readStateImport, recordStateImportMirror, SqliteStateCollection, stateDatabaseSignature,
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

function writeProjectedMirror(file: string, collection: string, document: unknown): void {
  const database = statePath("state.sqlite");
  const text = `${JSON.stringify(document, null, 2)}\n`;
  writeJsonDurably(file, document);
  if (readStateImport(database, collection)) {
    const revision = readStateCollectionRevision(database, collection);
    if (revision === null) throw new Error(`${collection} import has no collection revision during recovery checkpoint`);
    recordStateImportMirror(database, collection, crypto.createHash("sha256").update(text).digest("hex"), revision);
  }
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
  // The SQLite release fence protects map/alias checkpoints; the retained
  // lifecycle file still serializes with its writers.
  withFileTransactionAttempt(lifecycleJournalPath(), "lifecycle journal is busy", () => {
        const map = { ...readProjectDocument(worktreeMapStore, "worktree-map.json") };
        for (const { cwd, repo, worktree } of readWorktreeRecoveries()) {
          if (map[cwd] && map[cwd]!.repo !== repo) throw new Error("Worktree recovery conflicts with a recorded mapping");
          map[cwd] = { repo, worktree };
        }
        // Validate every projection before publishing any of them. These are
        // compatibility files only; the live commit remains wholly in SQLite.
        const aliases = projectAliasSnapshot({ strict: true });
        const journal = readLifecycleJournal();
        // Recovery rows are already committed atomically in SQLite. During
        // release fencing ordinary collection writes are denied, so publish
        // only the legacy documents the retained release needs.
        writeProjectedMirror(mapFile, "worktree_map", map);
        writeProjectedMirror(aliasesFile, "project_aliases", { schemaVersion: 1, ...aliases });
        writeJsonDurably(lifecycleJournalPath(), journal);
      });
}
