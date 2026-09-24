import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { readStateCollectionRows } from "@/lib/state/sqliteStateStore";
import type { BoardProjectStateV1 } from "@/lib/view/types";

import { BOARD_FILE } from "./store";

/* Test fixture for the SQLite board store (#1870). Tests that used to read
   `board.json` back to see what a write persisted read the stored rows here
   instead: the project states exactly as stored, keyed by project. */

export function persistedBoardProjects(filePath = BOARD_FILE): Record<string, BoardProjectStateV1> {
  const rows = (readStateCollectionRows(legacyDatabasePath(filePath), "board") ?? []) as { project: string; state: BoardProjectStateV1 }[];
  return Object.fromEntries(rows.map((row) => [row.project, row.state]));
}
