import fs from "node:fs";

import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { readStateImport } from "@/lib/state/sqliteStateStore";

import { normalizeOrchestratorSeatDocument } from "./seatRecords";
import {
  ORCHESTRATOR_SEAT_COLLECTION,
  orchestratorSeatCollectionForTests,
  orchestratorSeatRowsForTests,
  orchestratorSeatsLegacyPath,
} from "./seatStore";

/* Test fixture for the SQLite seat store (#1870 slice 4). Tests that used to
   write `orchestrator-seats.json` by hand to put the record in a given state
   write it here instead: into the legacy file while the store has not been
   imported, which is what an install that predates the move holds, and into
   the stored rows once it has. Project keys are kept as written, as the
   legacy file kept them. */

function imported(): boolean {
  return readStateImport(legacyDatabasePath(orchestratorSeatsLegacyPath()), ORCHESTRATOR_SEAT_COLLECTION) !== null;
}

/** Make the stored record exactly `record`, a legacy-shaped seat document.
    Text that is not JSON, or a document of another schema, leaves the record
    unestablished, as a torn or future-schema file did. */
export function writeStoredSeatRecord(record: unknown): void {
  const text = typeof record === "string" ? record : JSON.stringify(record);
  if (!imported()) {
    fs.writeFileSync(orchestratorSeatsLegacyPath(), text, "utf8");
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return damageStoredSeatRecord(); }
  const file = normalizeOrchestratorSeatDocument(parsed, (project) => project);
  if (!file) return damageStoredSeatRecord((parsed as { schemaVersion?: unknown } | null)?.schemaVersion);
  orchestratorSeatCollectionForTests().replaceSync(orchestratorSeatRowsForTests(file));
}

/** Leave the stored record unestablished: its meta row names a schema this
    release does not read. */
export function damageStoredSeatRecord(schemaVersion: unknown = 99): void {
  if (!imported()) {
    fs.writeFileSync(orchestratorSeatsLegacyPath(), "{ torn", "utf8");
    return;
  }
  const collection = orchestratorSeatCollectionForTests();
  collection.patchSync(() => ({ records: [{ key: "meta", value: { schemaVersion, nextSeatEpoch: 1, nextSeq: 0 } }] }));
}

/** Remove every stored seat row: a store that answers and holds nothing. */
export function clearStoredSeatRecord(): void {
  if (!imported()) {
    fs.rmSync(orchestratorSeatsLegacyPath(), { force: true });
    return;
  }
  orchestratorSeatCollectionForTests().replaceSync([]);
}

/** Store rows exactly as given, beside the record: a damaged store whose
    tolerant read drops them and whose strict read refuses the record. */
export function addStoredSeatRows(rows: readonly { key: string; value: unknown }[]): void {
  orchestratorSeatCollectionForTests().patchSync(() => ({ records: rows.map((row) => ({ key: row.key, value: row.value })) }));
}
