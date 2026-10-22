import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { waitForStateLock } from "@/lib/state/lockWait";

export const MEMORY_SELECTION_MONTHLY_CAP_USD = 5;
type Spend = { month: string; usd: number };
const key = () => "monthly";
const seed = { collection: "role_memory_selection_spend", schemaVersion: 1, migrationId: "role-memory-selection-spend-v1", key, loadRecords: (): Spend[] => [] };
function collection() {
  const file = statePath("state.sqlite");
  initializeStateCollections(file, [seed]);
  return new SqliteStateCollection<Spend>(file, { ...seed, busyMessage: "memory selection spend busy", clone: structuredClone, strictDecode: true,
    decode: value => { const row = value as Spend; return row && /^\d{4}-\d{2}$/.test(row.month) && Number.isFinite(row.usd) && row.usd >= 0 ? row : null; } });
}
/** Reserve the full byte-based ceiling before dispatch. A crash or lost reply
 * leaves that charge in place, including across process restarts. */
export async function reserveSelectionSpend(ceiling: number, signal: AbortSignal, now = new Date()): Promise<{ month: string; ceiling: number } | null> {
  const month = now.toISOString().slice(0, 7);
  return waitForStateLock("memory.selection-spend", () => {
    signal.throwIfAborted();
    const store = collection();
    try { return store.boundedPatch(2, tx => {
      signal.throwIfAborted();
      const held = tx.get("monthly");
      const usd = held?.month === month ? held.usd : 0;
      if (held && held.month > month || usd + ceiling > MEMORY_SELECTION_MONTHLY_CAP_USD) return null;
      tx.put({ month, usd: usd + ceiling });
      return { month, ceiling };
    }); } finally { store.close(); }
  }, { signal });
}
/** Only an observed bill (or an HTTP refusal) releases unused reservation.
 * Settlement is awaited; a timeout keeps its entire ceiling charged. */
export async function settleSelectionSpend(reservation: { month: string; ceiling: number }, billed: number, signal: AbortSignal): Promise<void> {
  await waitForStateLock("memory.selection-spend", () => {
    signal.throwIfAborted();
    const store = collection();
    try { store.boundedPatch(2, tx => {
      signal.throwIfAborted();
      const held = tx.get("monthly");
      if (held?.month === reservation.month) tx.put({ ...held, usd: Math.max(0, held.usd - reservation.ceiling + billed) });
    }); } finally { store.close(); }
  }, { signal });
}
