import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { BACKUP_DIRECTORY, listBackups } from "@/lib/state/durability";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { waitForStateLock } from "@/lib/state/lockWait";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { historyEntryRows, historyUndoKey, roleHistoryCollection, type StoredHistoryRow } from "./roleHistoryRows";
import { canonicalScope, roleMemoryCollection } from "./roleStore";
import { ROLE_MEMORY_HISTORY_LIMIT, type RoleMemoryRow, type RoleMemoryScopeRow } from "./roleTypes";
import { historyKeysOfToken, historyOfToken, oldestOrdinaryHistoryKeys, roleScopeRowKeys, scopeHistoryTail, scopeKeysWithDroppedHistory, scopeRowForRewrite, scopeRowRevision, unclaimedHistoryTokens } from "./roleViewSource";

/* Moves history entries out of scope rows into history rows. Writers append
   to the scope row; this drain is the only writer of history rows. Each step
   is one bounded transaction that commits the shortened scope row together
   with the rows that now hold its entries, so a stop between steps leaves
   every entry in exactly one place and the next step continues from the
   stored data. A scope written before history rows existed is a scope whose
   entries are all still in its row.

   The drain is off until the operator turns it on, and its first step on a
   store needs a recent state backup. A release before history rows reads a
   drained scope as its newest entries only: its undo finds nothing to undo,
   its export carries the tail, and its scope join removes a scope row whose
   rows it cannot see. Turning the drain on is therefore the point after which
   this store cannot go back to such a release.

   Rows are removed only for a token a scope row records as released: the
   writer that took the entries back into the scope row committed that record
   with them. Rows no scope row names or releases hold the only copy of their
   entries. They are joined into the scope their own scope moved to when the
   stored aliases name one, and kept otherwise. */

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
  /** Time of the newest state backup; the product's own backups by default. */
  newestBackupAt?: () => number | null;
}
const DEFAULTS = { minEntries: 16, minBytes: 32 * 1024, maxEntries: 1024, maxBytes: 16 * 1024 * 1024, graceMs: 24 * 60 * 60 * 1000 };
const PAGE = 1024;
export const ROLE_HISTORY_BACKUP_AGE_MS = 60 * 60 * 1000;
const validEntry = (entry: unknown) => !!entry && typeof entry === "object" && typeof (entry as { at?: unknown }).at === "string";

export class RoleHistoryDrainRefusal extends Error {}
function newestStateBackupAt(): number | null {
  return listBackups(path.join(path.dirname(statePath("state.sqlite")), BACKUP_DIRECTORY), "state.sqlite")[0]?.at ?? null;
}
/** Before the first entry of a store moves, a backup taken within the hour
 * must exist: it is the way back to the scope rows as they are now. */
export function assertRoleHistoryBackup(options: Pick<RoleHistoryDrainOptions, "now" | "newestBackupAt"> = {}): void {
  const history = roleHistoryCollection();
  if (history && history.keyPage("", 1).length) return;
  const at = (options.newestBackupAt ?? newestStateBackupAt)();
  if (at === null || (options.now ?? Date.now()) - at > ROLE_HISTORY_BACKUP_AGE_MS) {
    throw new RoleHistoryDrainRefusal("moving role memory history needs a state backup taken within the last hour; none was found");
  }
}

/** Scope rows the drain left alone, by the stored revision it saw: an
 * unchanged row is not read again. */
const refused = new Map<string, number>();

/** One bounded write. `cursor.after` is the last scope key found drained; the
 * answer is false once a whole walk found nothing to move and nothing to remove. */
export function drainRoleHistoryStep(cursor: { after: string }, options: RoleHistoryDrainOptions = {}): boolean {
  const memory = roleMemoryCollection();
  if (!memory) return false;
  const file = statePath("state.sqlite");
  assertStateStartupMutation(path.dirname(file), "role memory history drain");
  const { minEntries, minBytes, maxEntries, maxBytes, graceMs } = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  const due = (tail: { entries: number; bytes: number } | null) => !!tail && tail.entries > 0 && (tail.entries >= minEntries || tail.bytes >= minBytes);
  for (const key of roleScopeRowKeys("s:")) {
    if (key <= cursor.after) continue;
    const revision = scopeRowRevision(key);
    if (revision === undefined || refused.get(`${file}\0${key}`) === revision || !due(scopeHistoryTail(key))) { cursor.after = key; continue; }
    assertRoleHistoryBackup(options);
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
        const oldest = oldestOrdinaryHistoryKeys(row.historyRows, Math.min(excess, PAGE));
        // An entry leaves with the undo payload stored beside it, if it has one.
        removed.push(...oldest, ...oldest.map(entryKey => historyUndoKey(held.token, Number(entryKey.slice(entryKey.lastIndexOf(":") + 1)))));
        next.count -= oldest.length; next.ordinary -= oldest.length;
      }
      scopes.push({ ...row, history: rest, historyRows: next });
    } });
    if (!scopes.length) { refused.set(`${file}\0${key}`, revision); cursor.after = key; continue; }
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
  return adoptUnclaimedHistory(new Date(now).toISOString());
}

/** Rows whose scope row is gone because a release before history rows joined
 * that scope into the one its project key moved to: the stored aliases name
 * the target, and the rows' entries go ahead of the target's own, as a join
 * by this release orders them. The entries the earlier join already carried
 * over stay where it put them, after the target's stored rows. */
function adoptUnclaimedHistory(at: string): boolean {
  const memory = roleMemoryCollection()!, history = roleHistoryCollection()!;
  for (const { token, scope } of unclaimedHistoryTokens()) {
    const into = scope ? canonicalScope(scope) : scope;
    if (!scope || into === scope || memory.get(`s:${scope}`)) continue;
    const scopes: RoleMemoryRow[] = [];
    SqliteStateCollection.commitPatchesSync([
      { collection: memory as SqliteStateCollection<unknown>, records: scopes },
      { collection: history as SqliteStateCollection<unknown>, records: [] },
    ], { busyMessage: "role memory busy", beforeMerge: () => {
      const target = memory.get(`s:${into}`);
      if (target?.kind !== "scope" || memory.get(`s:${scope}`)) return;
      const whole = scopeRowForRewrite(target, at);
      const earlier = historyOfToken(token).map(entry => ({ ...entry, revisionScope: entry.revisionScope ?? scope }));
      scopes.push({ ...whole, history: [...earlier, ...whole.history], historyDropped: [...(whole.historyDropped ?? []), { token, at }] });
    } });
    if (scopes.length) return true;
  }
  return false;
}

/** Stored tokens that no scope row names or releases and no alias places. */
export function unclaimedRoleHistoryTokens(): number {
  return roleMemoryCollection() && roleHistoryCollection() ? unclaimedHistoryTokens().length : 0;
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

/* The operator's switch. Off unless the operator turned it on for this store. */
const settingFile = () => statePath("role-history-rows.json");
export function roleHistoryRowsEnabled(): boolean {
  try { return (JSON.parse(fs.readFileSync(settingFile(), "utf8")) as { enabled?: unknown }).enabled === true; }
  catch { return false; }
}
/** Turning the drain on is refused without a recent backup while the store
 * has no history rows yet. */
export function setRoleHistoryRowsEnabled(enabled: boolean, options: Pick<RoleHistoryDrainOptions, "now" | "newestBackupAt"> = {}): void {
  if (enabled) assertRoleHistoryBackup(options);
  const file = settingFile();
  withFileTransactionSync(file, "role memory history setting is busy", () =>
    writeJsonDurably(file, { enabled, at: new Date(options.now ?? Date.now()).toISOString() }));
}
export function roleHistoryRowsStatus(): { enabled: boolean; newestBackupAt: string | null; unclaimed: number } {
  const at = newestStateBackupAt();
  return { enabled: roleHistoryRowsEnabled(), newestBackupAt: at === null ? null : new Date(at).toISOString(), unclaimed: unclaimedRoleHistoryTokens() };
}

const owner = globalThis as typeof globalThis & { __delegatusRoleHistoryDrain?: { stop(): void } };
/** Only the Viewer startup path starts this clock. Every minute it looks at
 * the operator's switch; while that is on and this release serves traffic, a
 * pass runs every ten minutes with its steps spaced so the serving loop runs
 * between them. */
export function startRoleHistoryDrain(ports: { active?: () => Promise<boolean> } = {}): void {
  if (owner.__delegatusRoleHistoryDrain) return;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const active = ports.active ?? (async () => (await import("@/lib/viewerInstrumentation")).viewerReleaseOwnsTraffic());
  const arm = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      let ran = false;
      void (async () => {
        if (!roleHistoryRowsEnabled() || !await active()) return;
        ran = true;
        await drainRoleHistory({ active: () => !stopped && roleHistoryRowsEnabled(), pauseMs: 2_000 });
        const unclaimed = unclaimedRoleHistoryTokens();
        if (unclaimed) console.warn("[role-memory] history rows kept without a scope row", unclaimed);
      })().catch(error => console.warn("[role-memory] history drain unavailable", error instanceof RoleHistoryDrainRefusal ? error.message : error instanceof Error ? error.name : "unknown"))
        .finally(() => arm(ran ? 600_000 : 60_000));
    }, ms);
    timer.unref?.();
  };
  arm(60_000);
  owner.__delegatusRoleHistoryDrain = { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
