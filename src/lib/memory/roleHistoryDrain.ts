import crypto from "node:crypto";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { waitForStateLock } from "@/lib/state/lockWait";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { historyEntryRows, roleHistoryCollection, type StoredHistoryRow } from "./roleHistoryRows";
import { roleMemoryCollection } from "./roleStore";
import { ROLE_MEMORY_HISTORY_LIMIT, type RoleMemoryRow, type RoleMemoryScopeRow } from "./roleTypes";
import { historyKeysOfToken, oldestOrdinaryHistoryKeys, roleScopeRowKeys, scopeHistoryTail, scopeKeysWithDroppedHistory, unclaimedHistoryTokens } from "./roleViewSource";

/* Moves history entries out of scope rows into history rows. Writers append
   to the scope row; this drain is the only writer of history rows. Each step
   is one bounded transaction that commits the shortened scope row together
   with the rows that now hold its entries, so a stop between steps leaves
   every entry in exactly one place and the next step continues from the
   stored data. A scope written before history rows existed is a scope whose
   entries are all still in its row.

   Rows are removed only for a token a scope row records as released: the
   writer that took the entries back into the scope row committed that record
   with them. Rows no scope row names or releases are kept. A writer from a
   release before history rows can leave such rows (it removes a scope row it
   joined into another); they hold the only copy of those entries. */

export interface RoleHistoryDrainOptions {
  /** A scope row is drained once it holds this many entries, or this many bytes. */
  minEntries?: number;
  minBytes?: number;
  /** Bounds of one transaction. */
  maxEntries?: number;
  maxBytes?: number;
  /** Released rows stay this long after the record that released them. */
  graceMs?: number;
  now?: number;
}
const DEFAULTS = { minEntries: 16, minBytes: 32 * 1024, maxEntries: 1024, maxBytes: 16 * 1024 * 1024, graceMs: 24 * 60 * 60 * 1000 };
const validEntry = (entry: unknown) => !!entry && typeof entry === "object" && typeof (entry as { at?: unknown }).at === "string";
const PAGE = 1024;

/** One bounded write. `cursor.after` is the last scope key found drained; the
 * answer is false once a whole walk found nothing to move and nothing to remove. */
export function drainRoleHistoryStep(cursor: { after: string }, options: RoleHistoryDrainOptions = {}): boolean {
  const memory = roleMemoryCollection();
  if (!memory) return false;
  assertStateStartupMutation(path.dirname(statePath("state.sqlite")), "role memory history drain");
  const { minEntries, minBytes, maxEntries, maxBytes, graceMs } = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  const due = (tail: { entries: number; bytes: number } | null) => !!tail && tail.entries > 0 && (tail.entries >= minEntries || tail.bytes >= minBytes);
  for (const key of roleScopeRowKeys("s:")) {
    if (key <= cursor.after) continue;
    if (!due(scopeHistoryTail(key))) { cursor.after = key; continue; }
    const history = roleHistoryCollection(true)!;
    const scopes: RoleMemoryRow[] = [], rows: StoredHistoryRow[] = [], removed: string[] = [];
    SqliteStateCollection.commitPatchesSync([
      { collection: memory as SqliteStateCollection<unknown>, records: scopes },
      { collection: history as SqliteStateCollection<unknown>, records: rows, deleteKeys: removed },
    ], { busyMessage: "role memory busy", beforeMerge: () => {
      // Read under both leases: no writer can change the scope before this commit.
      const row = memory.get(key);
      // A history some reader refuses stays where its readers report it.
      if (row?.kind !== "scope" || !row.history.length || !row.history.every(validEntry)) return;
      const held = row.historyRows ?? { token: crypto.randomBytes(8).toString("hex"), next: 0, count: 0, ordinary: 0 };
      const payloads: StoredHistoryRow[] = [];
      let moved = 0, bytes = 0, ordinary = 0;
      for (const entry of row.history) {
        const size = JSON.stringify(entry).length;
        if (moved >= maxEntries || moved > 0 && bytes + size > maxBytes) break;
        const [stored, undo] = historyEntryRows(row.scope, held.token, held.next + moved, entry);
        rows.push(stored!);
        if (undo) payloads.push(undo);
        moved++; bytes += size;
        if (!entry.pass) ordinary++;
      }
      // Entry rows are written together, ahead of the undo payloads, so a
      // reader of entries meets pages of entries.
      rows.push(...payloads);
      const rest = row.history.slice(moved);
      const next = { token: held.token, next: held.next + moved, count: held.count + moved, ordinary: held.ordinary + ordinary };
      // The retained window of entries without a pass spans the stored rows
      // and the scope row. The oldest such entries are stored rows.
      const excess = next.ordinary + rest.filter(entry => !entry.pass).length - ROLE_MEMORY_HISTORY_LIMIT;
      if (excess > 0 && row.historyRows) {
        removed.push(...oldestOrdinaryHistoryKeys(row.historyRows, Math.min(excess, PAGE)));
        next.count -= removed.length; next.ordinary -= removed.length;
      }
      scopes.push({ ...row, history: rest, historyRows: next });
    } });
    if (!scopes.length) { cursor.after = key; continue; }
    return true;
  }
  cursor.after = "";
  const history = roleHistoryCollection();
  if (!history) return false;
  for (const key of scopeKeysWithDroppedHistory()) {
    const scopes: RoleMemoryRow[] = [], removed: string[] = [];
    SqliteStateCollection.commitPatchesSync([
      { collection: memory as SqliteStateCollection<unknown>, records: scopes },
      { collection: history as SqliteStateCollection<unknown>, records: [], deleteKeys: removed },
    ], { busyMessage: "role memory busy", beforeMerge: () => {
      const row = memory.get(key);
      if (row?.kind !== "scope") return;
      const due = row.historyDropped?.find(dropped => !(now - Date.parse(dropped.at) < graceMs));
      if (!due) return;
      // A token is released by the scope that stopped naming it, so the scope
      // row cannot name it again; a row that does keeps its rows.
      if (row.historyRows?.token !== due.token) removed.push(...historyKeysOfToken(due.token, PAGE));
      if (removed.length) return;
      const left = row.historyDropped!.filter(dropped => dropped !== due);
      const next: RoleMemoryScopeRow = { ...row, historyDropped: left };
      if (!left.length) delete next.historyDropped;
      scopes.push(next);
    } });
    if (scopes.length || removed.length) return true;
  }
  return false;
}

/** Stored tokens that no scope row names or releases; see the note above. */
export function unclaimedRoleHistoryTokens(): number {
  return roleMemoryCollection() && roleHistoryCollection() ? unclaimedHistoryTokens() : 0;
}

/** Run steps until nothing is left, yielding to the event loop between them. */
export async function drainRoleHistory(options: RoleHistoryDrainOptions & { active?: () => boolean; pauseMs?: number } = {}): Promise<number> {
  const cursor = { after: "" };
  let steps = 0;
  for (;;) {
    if (options.active && !options.active()) return steps;
    const worked = await withViewerOperation("memory.history-drain", () =>
      waitForStateLock("memory.history-drain", () => drainRoleHistoryStep(cursor, options)));
    if (!worked) return steps;
    steps++;
    await new Promise<void>(resolve => { setTimeout(resolve, options.pauseMs ?? 0); });
  }
}

const owner = globalThis as typeof globalThis & { __delegatusRoleHistoryDrain?: { stop(): void } };
/** Only the Viewer startup path starts this clock. A pass starts shortly
 * after startup and then every ten minutes; steps of one pass are spaced so
 * the serving loop runs between them. */
export function startRoleHistoryDrain(ports: { active?: () => Promise<boolean> } = {}): void {
  if (owner.__delegatusRoleHistoryDrain) return;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const active = ports.active ?? (async () => (await import("@/lib/viewerInstrumentation")).viewerReleaseOwnsTraffic());
  const arm = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void (async () => {
        if (!await active() || stopped) { stopped = true; return; }
        await drainRoleHistory({ active: () => !stopped, pauseMs: 2_000 });
        const unclaimed = unclaimedRoleHistoryTokens();
        if (unclaimed) console.warn("[role-memory] history rows kept without a scope row", unclaimed);
      })().catch(error => console.warn("[role-memory] history drain unavailable", error instanceof Error ? error.name : "unknown")).finally(() => arm(600_000));
    }, ms);
    timer.unref?.();
  };
  arm(60_000);
  owner.__delegatusRoleHistoryDrain = { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
