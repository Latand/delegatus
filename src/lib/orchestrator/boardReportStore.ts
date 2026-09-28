import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";

import type { BoardReportCounts } from "./boardReport";

/**
 * `orchestrator_board_reports` (docs/design/board-maintenance-report.md §5.1):
 * one row per project, the claim and the outcome of the board maintenance
 * report for the newest seat epoch. The claim is what makes the report run once
 * per epoch: a second activation of the same epoch (a reconciled launch, a
 * retried request) finds it and does nothing. The text itself is not kept; it
 * lives in the seat's transcript once delivered.
 */

export type BoardReportOutcome =
  /** Queued to the seat, or held until its host exists. */
  | "sent"
  /** The seat moved to another epoch or conversation before the send. */
  | "superseded"
  /** Nothing to say: every section empty and GitHub not configured. */
  | "empty"
  /** The send was refused or threw. */
  | "failed";

export interface BoardReportRecord {
  project: string;
  seatEpoch: number;
  conversationId: string;
  clientMessageId: string;
  claimedAt: string;
  sentAt: string | null;
  outcome: BoardReportOutcome | null;
  /** The delivery layer's answer, or why it refused. */
  detail: string | null;
  bytes: number | null;
  counts: BoardReportCounts | null;
  gaps: string[];
}

const COLLECTION = "orchestrator_board_reports";
const rowKey = (project: string) => `p:${project}`;
const seed = { collection: COLLECTION, schemaVersion: 1, migrationId: "board-maintenance-report-v1", key: (row: BoardReportRecord) => rowKey(row.project), loadRecords: (): BoardReportRecord[] => [] };
const cache = new Map<string, SqliteStateCollection<BoardReportRecord>>();

function decode(value: unknown): BoardReportRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<BoardReportRecord>;
  return typeof row.project === "string" && typeof row.seatEpoch === "number" && typeof row.conversationId === "string"
    ? row as BoardReportRecord
    : null;
}

function collection(create: boolean): SqliteStateCollection<BoardReportRecord> | null {
  const file = statePath("state.sqlite");
  const held = cache.get(file);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const opened = new SqliteStateCollection<BoardReportRecord>(file, {
    collection: COLLECTION, schemaVersion: 1, busyMessage: "board maintenance reports busy", key: (row) => rowKey(row.project),
    decode, clone: structuredClone, strictDecode: true,
  });
  cache.set(file, opened);
  return opened;
}

/** The project's newest report record, or null. */
export function readBoardReportRecord(project: string): BoardReportRecord | null {
  return collection(false)?.get(rowKey(project)) ?? null;
}

/** Claim the report for `record.seatEpoch`: written only when the stored epoch
    is lower, so exactly one caller per epoch is answered true. */
export function claimBoardReport(record: BoardReportRecord): boolean {
  return collection(true)!.boundedPatch(2, (tx) => {
    const held = tx.get(rowKey(record.project));
    if (held && held.seatEpoch >= record.seatEpoch) return false;
    tx.put(record);
    return true;
  });
}

/** Record how the claimed epoch ended. A newer epoch's row is left alone. */
export function settleBoardReport(project: string, seatEpoch: number, patch: Partial<Pick<BoardReportRecord, "sentAt" | "outcome" | "detail" | "bytes" | "counts" | "gaps">>): void {
  collection(true)!.boundedPatch(2, (tx) => {
    const held = tx.get(rowKey(project));
    if (!held || held.seatEpoch !== seatEpoch) return;
    tx.put({ ...held, ...patch });
  });
}
