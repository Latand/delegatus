import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { BACKUP_DIRECTORY, listBackups, runBackupPassInWorker, type BackupOutcome } from "@/lib/state/durability";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { waitForStateLock } from "@/lib/state/lockWait";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { historyEntryIdentity, historyEntryRows, historyReleasedKey, historyUndoKey, roleHistoryCollection, type StoredHistoryRow } from "./roleHistoryRows";
import { canonicalScope, roleMemoryCollection } from "./roleStore";
import { ROLE_MEMORY_HISTORY_LIMIT, type RoleMemoryRow, type RoleMemoryScopeRow } from "./roleTypes";
import { historyKeysOfToken, historyOfToken, historyTokenClaims, oldestOrdinaryHistoryKeys, releasedHistoryTokens, roleScopeRowKeys, scopeHistoryIdentities, scopeHistoryTail, scopeKeysWithDroppedHistory, scopeRowRevision, unclaimedHistoryTokens } from "./roleViewSource";

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

   Rows are removed only for a token recorded as released: the writer that
   took the entries back into a scope row committed that record with them,
   and the drain copies it beside the rows (`d:<token>`) when it next writes
   that scope, so the record outlives a scope row an earlier release removes.
   Rows nothing names or releases hold the only copy of their entries. They
   are joined into the scope their own scope moved to when the stored aliases
   name one, and kept otherwise. */

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
/** Why the last pass did not run or stopped, for the operator. */
let idle: string | null = null;

/* The operator's switch, and the backup that protects the move. Off unless
   the operator turned it on for this store. */
export interface RoleHistoryBackup { name: string; at: string; bytes: number }
type Setting = { enabled: boolean; at: string; backup?: RoleHistoryBackup };
/** How long the backup taken at turning on is kept out of backup retention. */
export const ROLE_HISTORY_BACKUP_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const RESTORE_NOTE = "restoring it returns the whole state database, every store in it, to that moment";
const KEPT_PREFIX = "role-memory-history-";
const settingFile = () => statePath("role-history-rows.json");
const backupDirectory = () => path.join(path.dirname(statePath("state.sqlite")), BACKUP_DIRECTORY);
function setting(): Setting | null {
  try { const value = JSON.parse(fs.readFileSync(settingFile(), "utf8")) as Setting; return value && typeof value === "object" ? value : null; }
  catch { return null; }
}
function writeSetting(value: Setting): void {
  const file = settingFile();
  withFileTransactionSync(file, "role memory history setting is busy", () => writeJsonDurably(file, value));
}
export function roleHistoryRowsEnabled(): boolean { return setting()?.enabled === true; }
/** The kept copy: a second name for the backup's file, outside the names
 * backup retention manages, so no retention pass removes it. */
function keptBackup(): (RoleHistoryBackup & { file: string }) | null {
  const backup = setting()?.backup;
  if (!backup || path.basename(backup.name) !== backup.name || !backup.name.startsWith(KEPT_PREFIX)) return null;
  const file = path.join(backupDirectory(), backup.name);
  try { return fs.statSync(file).size > 0 ? { ...backup, file } : null; } catch { return null; }
}
function releaseKeptBackup(): void {
  const kept = keptBackup();
  if (kept) fs.rmSync(kept.file, { force: true });
}

type TakeBackup = () => Promise<Map<string, BackupOutcome>>;
let takeBackup: TakeBackup = () => runBackupPassInWorker(path.dirname(statePath("state.sqlite")), new Map());
const takeBackupInWorker = takeBackup;
/** Tests only; `null` restores the backup pass in its worker. Seamed here
    because a route module may export only route fields. */
export function setRoleHistoryBackupPassForTests(pass: TakeBackup | null): void { takeBackup = pass ?? takeBackupInWorker; }
/** Turning the drain on takes a state backup through the product's backup
 * pass, which checks the copy's integrity before it keeps it, and keeps that
 * copy under a name of its own until the drain is turned off or thirty days
 * pass. A store that already has history rows is past the point a backup
 * guards and needs none. */
export async function setRoleHistoryRowsEnabled(enabled: boolean, options: { now?: number; takeBackup?: TakeBackup } = {}): Promise<void> {
  const now = options.now ?? Date.now(), at = new Date(now).toISOString();
  if (!enabled) { releaseKeptBackup(); writeSetting({ enabled: false, at }); idle = null; return; }
  const held = setting();
  if (storeHasHistoryRows()) { writeSetting({ enabled: true, at: held?.backup ? held.at : at, ...(held?.backup ? { backup: held.backup } : {}) }); return; }
  let outcome: BackupOutcome | undefined;
  try { outcome = (await (options.takeBackup ?? takeBackup)()).get("state.sqlite"); }
  catch (error) { throw new RoleHistoryDrainRefusal(`the state backup did not run (${error instanceof Error ? error.name : "unknown"}); nothing was turned on`); }
  // The pass answers "not-due" when it copied this database within the hour:
  // that copy went through the same integrity check when it was taken.
  const newest = listBackups(backupDirectory(), "state.sqlite")[0];
  const fresh = !!newest && newest.bytes > 0 && now - newest.at <= ROLE_HISTORY_BACKUP_AGE_MS;
  if (!newest || !fresh || outcome === undefined || !["taken", "not-due"].includes(outcome.state)) {
    throw new RoleHistoryDrainRefusal(`no state backup from the last hour could be taken (${outcome?.state ?? "no answer"}); `
      + (newest ? `the newest is ${newest.name} from ${new Date(newest.at).toISOString()}` : "there is none") + "; nothing was turned on");
  }
  releaseKeptBackup();
  const name = `${KEPT_PREFIX}${newest.name}`, kept = path.join(backupDirectory(), name);
  fs.rmSync(kept, { force: true });
  try { fs.linkSync(newest.file, kept); } catch { fs.copyFileSync(newest.file, kept); }
  writeSetting({ enabled: true, at, backup: { name, at: new Date(newest.at).toISOString(), bytes: newest.bytes } });
  idle = null;
}

function storeHasHistoryRows(): boolean {
  const history = roleHistoryCollection();
  return !!history && history.keyPage("", 1).length > 0;
}
/** Before the first entry of a store moves, the backup taken at turning on
 * must still be there and be at most an hour old: it is the way back to the
 * scope rows as they are now. */
export function assertRoleHistoryBackup(options: Pick<RoleHistoryDrainOptions, "now" | "newestBackupAt"> = {}): void {
  if (storeHasHistoryRows()) return;
  const at = (options.newestBackupAt ?? (() => { const kept = keptBackup(); return kept ? Date.parse(kept.at) : null; }))();
  if (at === null || (options.now ?? Date.now()) - at > ROLE_HISTORY_BACKUP_AGE_MS) {
    throw new RoleHistoryDrainRefusal(at === null
      ? "moving role memory history needs the state backup taken when it was turned on, and none is kept; turn it off and on again"
      : "the state backup taken when this was turned on is older than one hour and no entry has moved yet; turn it off and on again to take a new one");
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
  // Rows without a scope row are placed first, so their entries sit ahead of
  // whatever the target's scope row still holds when those move out.
  if (roleHistoryCollection() && adoptUnclaimedHistory()) return true;
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
      // The record of each token this scope released goes beside the rows too.
      for (const dropped of row.historyDropped ?? []) rows.push({ kind: "released", token: dropped.token, scope: row.scope, at: dropped.at });
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
      removed.push(historyReleasedKey(due.token));
    } });
    if (scopes.length || removed.length) return true;
  }
  // A release record whose scope row is gone: its entries live on in the
  // scope that took them, so its rows go the same way after the same wait.
  const claims = historyTokenClaims();
  for (const released of releasedHistoryTokens()) {
    if (claims.named.has(released.token) || claims.dropped.has(released.token) || now - Date.parse(released.at) < graceMs) continue;
    const removed: string[] = [];
    SqliteStateCollection.commitPatchesSync([
      { collection: memory as SqliteStateCollection<unknown>, records: [] },
      { collection: history as SqliteStateCollection<unknown>, records: [], deleteKeys: removed },
    ], { busyMessage: "role memory busy", beforeMerge: () => {
      const current = historyTokenClaims();
      if (current.named.has(released.token) || current.dropped.has(released.token)) return;
      removed.push(...historyKeysOfToken(released.token, PAGE));
      if (!removed.length) removed.push(historyReleasedKey(released.token));
    } });
    if (removed.length) return true;
  }
  return false;
}

/** Tokens whose rows could not be read whole (an undo payload is missing):
 * left in place and counted. */
const incomplete = new Set<string>();

/** Rows whose scope row is gone because a release before history rows joined
 * that scope into the one its project key moved to. The stored aliases name
 * the target. The rows' entries go to the front of the entries the target's
 * scope row holds, next to the ones the earlier join carried over, and the
 * rows leave in the same commit; the drain then moves the entries out like
 * any other. An entry the target already holds is not added again. One
 * write the size of the adopted token: it reads the target's stored entries
 * by identity only and never rewrites them. */
function adoptUnclaimedHistory(): boolean {
  const memory = roleMemoryCollection()!, history = roleHistoryCollection()!;
  for (const { token, scope } of unclaimedHistoryTokens()) {
    const into = scope ? canonicalScope(scope) : scope;
    if (!scope || into === scope || incomplete.has(token) || memory.get(`s:${scope}`)) continue;
    const scopes: RoleMemoryRow[] = [], removed: string[] = [];
    try {
      SqliteStateCollection.commitPatchesSync([
        { collection: memory as SqliteStateCollection<unknown>, records: scopes },
        { collection: history as SqliteStateCollection<unknown>, records: [], deleteKeys: removed },
      ], { busyMessage: "role memory busy", beforeMerge: () => {
        const target = memory.get(`s:${into}`);
        if (target?.kind !== "scope" || memory.get(`s:${scope}`)) return;
        const held = scopeHistoryIdentities(target);
        const earlier = historyOfToken(token).map(entry => ({ ...entry, revisionScope: entry.revisionScope ?? scope }))
          .filter(entry => !held.has(historyEntryIdentity(entry, target.scope)));
        if (earlier.length) scopes.push({ ...target, history: [...earlier, ...target.history] });
        removed.push(...historyKeysOfToken(token, Number.MAX_SAFE_INTEGER));
      } });
    } catch (error) {
      // One unreadable token must not stop the tokens after it.
      if (!(error instanceof Error) || error.message !== "memory scope changed while being read") throw error;
      incomplete.add(token);
      continue;
    }
    if (removed.length) return true;
  }
  return false;
}

/** Stored tokens that nothing names or releases: those an alias will place,
 * those nothing places, and those whose rows are incomplete. */
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

export const ROLE_HISTORY_RESTORE_NOTE = RESTORE_NOTE;
export function roleHistoryRowsStatus(): { enabled: boolean; backup: (RoleHistoryBackup & { present: boolean; restore: string; keptUntil: string }) | null; idle: string | null; unclaimed: number; incomplete: number } {
  const held = setting();
  const backup = held?.backup ?? null;
  return {
    enabled: held?.enabled === true,
    backup: backup ? { ...backup, present: keptBackup() !== null, restore: RESTORE_NOTE, keptUntil: new Date(Date.parse(held!.at) + ROLE_HISTORY_BACKUP_KEPT_MS).toISOString() } : null,
    idle: held?.enabled === true ? idle : null,
    unclaimed: unclaimedRoleHistoryTokens(),
    incomplete: incomplete.size,
  };
}

/** One look of the clock: a pass while the operator's switch is on and this
 * release serves traffic. The reason a pass did not run or stopped is kept
 * for the status. */
export async function roleHistoryDrainTick(active: () => Promise<boolean>, options: RoleHistoryDrainOptions & { pauseMs?: number } = {}): Promise<boolean> {
  const held = setting();
  if (held?.enabled !== true) { idle = null; return false; }
  if (held.backup && (options.now ?? Date.now()) - Date.parse(held.at) > ROLE_HISTORY_BACKUP_KEPT_MS) { releaseKeptBackup(); writeSetting({ enabled: true, at: held.at }); }
  if (!await active()) { idle = "this release does not serve traffic yet"; return false; }
  try {
    await drainRoleHistory({ ...options, active: roleHistoryRowsEnabled });
    idle = null;
  } catch (error) {
    idle = error instanceof RoleHistoryDrainRefusal ? error.message : `the last pass failed (${error instanceof Error ? error.name : "unknown"})`;
    throw error;
  }
  const unclaimed = unclaimedRoleHistoryTokens();
  if (unclaimed) console.warn("[role-memory] history rows kept without a scope row", unclaimed);
  return true;
}

const owner = globalThis as typeof globalThis & { __delegatusRoleHistoryDrain?: { stop(): void } };
/** Only the Viewer startup path starts this clock. Every minute it looks at
 * the operator's switch; after a pass it waits ten minutes. Steps of a pass
 * are spaced so the serving loop runs between them. */
export function startRoleHistoryDrain(ports: { active?: () => Promise<boolean> } = {}): void {
  if (owner.__delegatusRoleHistoryDrain) return;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const active = ports.active ?? (async () => (await import("@/lib/viewerInstrumentation")).viewerReleaseOwnsTraffic());
  const arm = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      let ran = false;
      void roleHistoryDrainTick(async () => !stopped && await active(), { pauseMs: 2_000 }).then(worked => { ran = worked; })
        .catch(error => console.warn("[role-memory] history drain unavailable", error instanceof RoleHistoryDrainRefusal ? error.message : error instanceof Error ? error.name : "unknown"))
        .finally(() => arm(ran ? 600_000 : 60_000));
    }, ms);
    timer.unref?.();
  };
  arm(60_000);
  owner.__delegatusRoleHistoryDrain = { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
