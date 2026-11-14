import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { ROLE_MEMORY_HISTORY_LIMIT, type RoleMemoryScopeRow, type ScopeHistoryEntry } from "./roleTypes";

/* A scope's retained history, outside the scope row. One stored row per
   history entry, and a second row for the entry's undo payload (`prior`),
   which is nearly all of a long-lived scope's bytes and which only an undo
   reads. A scope row names its rows by a token; rows under a token no scope
   row names belong to nothing and are removed by the drain. The scope row
   keeps the newest entries in `history`, where every writer appends, so a
   scope row from before this collection existed is the same format with no
   rows yet. */

export const ROLE_HISTORY_COLLECTION = "role_memory_history";
type UndoPayload = NonNullable<ScopeHistoryEntry["prior"]>;
/** With `undo` set, the entry's `prior` array is stored in its own row and
 * `entry.prior` only holds its place among the entry's fields. Without it the
 * entry is stored exactly as written, whatever its `prior` is. */
export type StoredHistoryEntry = { kind: "entry"; token: string; seq: number; scope: string; entry: Omit<ScopeHistoryEntry, "prior"> & { prior?: unknown }; undo?: true };
export type StoredHistoryUndo = { kind: "undo"; token: string; seq: number; scope: string; prior: UndoPayload };
/** A token whose entries a scope row took back, recorded beside the rows so
 * the record outlives a scope row that an earlier release removes. */
export type StoredHistoryReleased = { kind: "released"; token: string; scope: string; at: string };
export type StoredHistoryRow = StoredHistoryEntry | StoredHistoryUndo | StoredHistoryReleased;

const sequence = (seq: number) => String(seq).padStart(10, "0");
export const historyEntryKey = (token: string, seq: number) => `h:${token}:${sequence(seq)}`;
export const historyUndoKey = (token: string, seq: number) => `u:${token}:${sequence(seq)}`;
export const historyReleasedKey = (token: string) => `d:${token}`;
const key = (row: StoredHistoryRow) => row.kind === "released" ? historyReleasedKey(row.token) : row.kind === "entry" ? historyEntryKey(row.token, row.seq) : historyUndoKey(row.token, row.seq);
function decode(value: unknown): StoredHistoryRow | null {
  const row = value as StoredHistoryRow | null;
  if (!row || typeof row !== "object" || typeof row.token !== "string" || !/^[a-f0-9]{16}$/.test(row.token) || typeof row.scope !== "string") return null;
  if (row.kind === "released") return typeof row.at === "string" ? row : null;
  if (!Number.isSafeInteger(row.seq) || row.seq < 0) return null;
  return row.kind === "entry" && !!row.entry && typeof row.entry === "object" && typeof row.entry.at === "string"
    || row.kind === "undo" && Array.isArray(row.prior) ? row : null;
}

const seed = { collection: ROLE_HISTORY_COLLECTION, schemaVersion: 1, migrationId: "role-memory-history-v1", key, loadRecords: (): StoredHistoryRow[] => [] };
const cache = new Map<string, SqliteStateCollection<StoredHistoryRow>>();
export function roleHistoryCollection(create = false): SqliteStateCollection<StoredHistoryRow> | null {
  const file = statePath("state.sqlite");
  const held = cache.get(file);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const opened = new SqliteStateCollection<StoredHistoryRow>(file, { ...seed, busyMessage: "role memory history busy", decode, clone: structuredClone, strictDecode: true });
  cache.set(file, opened);
  return opened;
}

/** The stored rows of one history entry. */
export function historyEntryRows(scope: string, token: string, seq: number, entry: ScopeHistoryEntry): StoredHistoryRow[] {
  if (!Array.isArray(entry.prior)) return [{ kind: "entry", token, seq, scope, entry }];
  return [{ kind: "entry", token, seq, scope, entry: { ...entry, prior: null }, undo: true }, { kind: "undo", token, seq, scope, prior: entry.prior }];
}

/** The entries as they were written. With `undo` absent the payloads are left
 * out; with it every entry that had one must find it. */
export function historyEntries(rows: readonly StoredHistoryEntry[], undo?: ReadonlyMap<number, UndoPayload>): ScopeHistoryEntry[] {
  return rows.map(row => {
    if (!row.undo) return row.entry as ScopeHistoryEntry;
    if (!undo) { const entry = { ...row.entry }; delete entry.prior; return entry as ScopeHistoryEntry; }
    const prior = undo.get(row.seq);
    if (!prior) throw new Error("memory scope changed while being read");
    // Assigning the held key keeps the entry's field order as it was written.
    return { ...row.entry, prior };
  });
}

/** Keep 10,000 ordinary changes independently of every curator Undo record.
 * At 141 daily writes this covers over 70 days; delivery rows keep their own
 * ordered ids and content hashes, so reconstruction never depends on this window. */
export function keepHistory(entries: ScopeHistoryEntry[]): ScopeHistoryEntry[] {
  const recent = new Set(entries.filter(entry => !entry.pass).slice(-ROLE_MEMORY_HISTORY_LIMIT));
  return entries.filter(entry => !!entry.pass || recent.has(entry));
}

/** The way a writer adds one entry to a stored scope row: every field of the
 * row it read stays, the reference to its history rows among them. A scope
 * row built from chosen fields would leave those rows without a scope. */
export function scopeRowWithEntry(row: RoleMemoryScopeRow, change: Partial<Pick<RoleMemoryScopeRow, "revision" | "active" | "curatedAt">>,
  entry: ScopeHistoryEntry, options: { window?: boolean } = {}): RoleMemoryScopeRow {
  const history = [...row.history, entry];
  return { ...row, ...change, history: options.window === false ? history : keepHistory(history) };
}

/** A scope row with its stored rows ahead of the entries it still holds, in
 * the shape a scope row had before history rows existed. Written back, it is
 * a scope with no rows. */
export function scopeWithEntries(row: RoleMemoryScopeRow, earlier: readonly ScopeHistoryEntry[], droppedAt?: string): RoleMemoryScopeRow {
  const scope = { ...row, history: [...earlier, ...row.history] };
  delete scope.historyRows;
  // A writer that stores this shape records the token it stopped naming.
  if (droppedAt !== undefined && row.historyRows) scope.historyDropped = [...(row.historyDropped ?? []), { token: row.historyRows.token, at: droppedAt }];
  return scope;
}

/** Group the rows of a whole history collection by token, for a reader that
 * holds every row at once (an install export, an import's target rows). */
export function historyRowsByToken(rows: Iterable<unknown>): Map<string, { entries: StoredHistoryEntry[]; undo: Map<number, UndoPayload> }> {
  const tokens = new Map<string, { entries: StoredHistoryEntry[]; undo: Map<number, UndoPayload> }>();
  for (const value of rows) {
    const row = decode(value);
    if (!row || row.kind === "released") continue;
    let held = tokens.get(row.token);
    if (!held) tokens.set(row.token, held = { entries: [], undo: new Map() });
    if (row.kind === "entry") held.entries.push(row); else held.undo.set(row.seq, row.prior);
  }
  for (const held of tokens.values()) held.entries.sort((a, b) => a.seq - b.seq);
  return tokens;
}

/** A scope row as an export or an import compares it: whole history in the
 * row. A row whose stored rows are incomplete is refused. */
export function scopeFromCollectedRows(row: RoleMemoryScopeRow, tokens: ReturnType<typeof historyRowsByToken>): RoleMemoryScopeRow {
  if (!row.historyRows) return row;
  const held = tokens.get(row.historyRows.token);
  const entries = (held?.entries ?? []).filter(entry => entry.seq < row.historyRows!.next);
  if (entries.length !== row.historyRows.count) throw new Error("role memory history rows are incomplete");
  return scopeWithEntries(row, historyEntries(entries, held?.undo ?? new Map()));
}

/** Every stored role memory row, each scope with its whole history in its
 * row, for an offline reader that holds both collections. */
export function rowsWithCollectedHistory<T>(memory: readonly T[], history: () => Iterable<unknown>): T[] {
  let tokens: ReturnType<typeof historyRowsByToken> | undefined;
  return memory.map(value => {
    const row = value as RoleMemoryScopeRow | null;
    if (!row || typeof row !== "object" || row.kind !== "scope" || !row.historyRows) return value;
    return scopeFromCollectedRows(row, tokens ??= historyRowsByToken(history())) as T;
  });
}

/** What makes two stored entries the same change of one scope lineage: its
 * place in the lineage and what it changed, whatever was marked on the entry
 * since (an undo, its undo payload moving to a row of its own). Two entries
 * at one place that changed different things are two entries. */
export function historyEntryIdentity(entry: ScopeHistoryEntry | StoredHistoryEntry["entry"], scope: string): string {
  const content: Partial<ScopeHistoryEntry> = { ...(entry as ScopeHistoryEntry) };
  for (const mark of ["revisionScope", "revertedAt", "undoSkipped", "prior"] as const) delete content[mark];
  return JSON.stringify([entry.revisionScope ?? scope, content]);
}
