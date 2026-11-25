import type { Database } from "bun:sqlite";

import { runtimePresentationReceipt, type RuntimeOperationReceipt, type RuntimeStartupOperationCursor } from "./contracts";

export const activeStartupOperation = (row = "") =>
  `json_extract(${row}receipt_json, '$.status') IN ('pending', 'queued', 'delivering', 'applying')`;

export function startupPendingOperationPage(db: Database, after: RuntimeStartupOperationCursor) {
  const rows = db.query<{ receipt_json: string; event_seq: number; rowid: number }, [number, number]>(`
    SELECT receipt_json,event_seq,rowid FROM operations WHERE (event_seq,rowid)>(?,?) AND ${activeStartupOperation()}
    ORDER BY event_seq,rowid LIMIT 101`,
  ).all(after.eventSeq, after.rowId);
  const page = rows.slice(0, 100);
  const pendingOperations = page.map(row => runtimePresentationReceipt(JSON.parse(row.receipt_json) as RuntimeOperationReceipt));
  const last = rows.length > page.length ? page.at(-1) : undefined;
  return { pendingOperations, ...(last ? { pendingOperationsNext: { eventSeq: last.event_seq, rowId: last.rowid } } : {}) };
}
