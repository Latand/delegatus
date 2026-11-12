import crypto from "node:crypto";
import fs from "node:fs";

import type { AppServerRateLimits, AppServerResetCreditOutcome } from "@/lib/accounts/codexAppServer";
import { statePath } from "@/lib/configDir";
import {
  openJournalCollection,
  readableJournal,
  writableJournal,
  type JournalLocation,
  type JournalRow,
} from "@/lib/state/journalCollection";
import {
  importLegacyCollection,
  legacyDatabasePath,
  writeLegacyRollbackMirror,
  type LegacyCollectionSpec,
  type LegacyImportHooks,
  type LegacyImportOutcome,
  type LegacyReconcileSummary,
} from "@/lib/state/legacyImport";
import { waitForStateLock } from "@/lib/state/lockWait";
import { readStateRowsPage, type SqliteStateCollection } from "@/lib/state/sqliteStateStore";

/**
 * Append-only record of every usage-limit reset redemption the Viewer attempted
 * (issue #1373): who asked, when, for which account, what the backend answered,
 * and the window before and after. A reset credit is a spend; the record is
 * what makes it accountable after the fact. Nothing decides from this journal —
 * it is a REPORT, so an unreadable journal answers with an empty list rather
 * than blocking a redemption or a read.
 *
 * Stored in `state.sqlite` (#1870 slice 8), collection `reset_credits`:
 *
 *   meta        { nextSeq }
 *   e:<seq>     one entry, zero-padded so key order is the order of redemption
 *
 * The legacy `codex-reset-credits.ndjson` rotated to `.1` past 2 MB and its
 * reader showed only the current file, so the import reads the current file
 * and leaves `.1` where it is. The collection keeps the newest
 * {@link RESET_CREDIT_RETENTION} entries, about what the 2 MB rotation held.
 */

const JOURNAL_NAME = "codex-reset-credits.ndjson";
export const RESET_CREDIT_COLLECTION = "reset_credits";
const BUSY = "the reset credit journal is busy";
const ENTRY_PREFIX = "e:";
const META_KEY = "meta";
/** Entries kept; each is about 450 bytes, so this is the legacy 2 MB rotation. */
export const RESET_CREDIT_RETENTION = 4_096;

export type ResetCreditActor =
  | { kind: "operator" }
  | { kind: "agent"; conversationId: string };

/** The governing window at one moment: the fullest window the probe reported. */
export interface ResetCreditWindowSummary {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface ResetCreditJournalEntry {
  at: string;
  engine: "codex";
  accountId: string;
  accountKind: "legacy" | "managed";
  actor: ResetCreditActor;
  idempotencyKey: string;
  /** The backend's answer, or `consume_failed` when no answer arrived. */
  outcome: AppServerResetCreditOutcome | "consume_failed";
  /** True when the pre-read showed no credit and nothing was sent. */
  refusedLocally: boolean;
  before: { availableCount: number | null; window: ResetCreditWindowSummary | null };
  after: { availableCount: number | null; window: ResetCreditWindowSummary | null } | null;
  /** Redacted failure text when `outcome` is `consume_failed`. */
  detail: string | null;
}

function journalFile(): string {
  return statePath(JOURNAL_NAME);
}

function journalLocation(filePath = journalFile()): JournalLocation {
  return {
    collection: RESET_CREDIT_COLLECTION,
    database: legacyDatabasePath(filePath),
    legacyPath: filePath,
    busyMessage: BUSY,
    importLegacy: (options) => importLegacyResetCreditJournal(filePath, options),
  };
}

/** The window a reset would open: the fullest one the snapshot carries. */
export function governingWindowSummary(rateLimits: AppServerRateLimits | null | undefined): ResetCreditWindowSummary | null {
  if (!rateLimits) return null;
  const windows = [rateLimits.primary, rateLimits.secondary].filter((window) => window !== null);
  const governing = windows.sort((left, right) => right.usedPercent - left.usedPercent)[0];
  return governing ? { usedPercent: governing.usedPercent, resetsAt: governing.resetsAt, windowDurationMins: governing.windowDurationMins } : null;
}

function entryKey(seq: number): string {
  return `${ENTRY_PREFIX}${String(seq).padStart(12, "0")}`;
}

function nextSeqOf(collection: SqliteStateCollection<JournalRow>): number {
  const meta = collection.get(META_KEY)?.value as { nextSeq?: unknown } | undefined;
  return Number.isSafeInteger(meta?.nextSeq) && (meta!.nextSeq as number) > 0 ? meta!.nextSeq as number : 1;
}

function appendPatch(location: JournalLocation, collection: SqliteStateCollection<JournalRow>, entry: ResetCreditJournalEntry) {
  const seq = nextSeqOf(collection);
  /* The new entry is the newest, so the committed ones past RETENTION - 1 go. */
  const deleteKeys = readStateRowsPage(location.database, location.collection, {
    prefix: ENTRY_PREFIX, descending: true, offset: RESET_CREDIT_RETENTION - 1, limit: 16, keysOnly: true,
  })?.rows.map((row) => row.key) ?? [];
  return {
    records: [{ key: entryKey(seq), value: entry }, { key: META_KEY, value: { nextSeq: seq + 1 } }],
    deleteKeys,
  };
}

/** Appends one entry; resolves false when the write failed so the caller can
    say the redemption happened but its record did not. */
export async function appendResetCreditJournal(entry: ResetCreditJournalEntry): Promise<boolean> {
  const location = journalLocation();
  try {
    await waitForStateLock("reset-credits.append", () => {
      const collection = writableJournal(location);
      collection.patchSync(() => appendPatch(location, collection, entry));
    }, { waitMs: 5_000, subject: RESET_CREDIT_COLLECTION });
    return true;
  } catch (error) {
    console.error("[reset-credits] journal append failed", error);
    return false;
  }
}

function isEntry(value: unknown): value is ResetCreditJournalEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ResetCreditJournalEntry>;
  return typeof record.at === "string" && record.engine === "codex" && typeof record.accountId === "string"
    && typeof record.outcome === "string" && typeof record.idempotencyKey === "string" && typeof record.actor === "object" && record.actor !== null;
}

function legacyEntries(text: string): ResetCreditJournalEntry[] {
  const entries: ResetCreditJournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      /* a torn tail line is not a record */
    }
  }
  return entries;
}

/** Newest entries first, at most `limit`; a missing or damaged journal reads as empty. */
export function readResetCreditJournal(limit = 20): ResetCreditJournalEntry[] {
  try {
    const location = journalLocation();
    if (!readableJournal(location)) {
      let text: string;
      try { text = fs.readFileSync(location.legacyPath, "utf8"); } catch { return []; }
      return legacyEntries(text).reverse().slice(0, Math.max(0, limit));
    }
    if (limit <= 0) return [];
    const entries: ResetCreditJournalEntry[] = [];
    for (let offset = 0; entries.length < limit; offset += 256) {
      const page = readStateRowsPage(location.database, location.collection, {
        prefix: ENTRY_PREFIX, descending: true, offset, limit: 256,
      });
      for (const row of page?.rows ?? []) {
        try {
          const value = (JSON.parse(row.valueJson ?? "null") as JournalRow | null)?.value;
          if (isEntry(value)) entries.push(value);
        } catch { /* a damaged row is not a record */ }
        if (entries.length >= limit) break;
      }
      if (!page || page.rows.length < 256) break;
    }
    return entries;
  } catch {
    return [];
  }
}

/* ---------------------------------------------------- import and rollback */

function identity(entry: ResetCreditJournalEntry): string {
  return crypto.createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/** Fold entries a rollback release appended back in: a union, counted per
    occurrence, appended after every stored entry in file order. */
function mergeLegacyEntries(filePath: string, entries: readonly ResetCreditJournalEntry[], options: { fenceOwner: boolean; consumedSha256?: string }): LegacyReconcileSummary {
  const location = journalLocation(filePath);
  const collection = openJournalCollection(location);
  const summary: LegacyReconcileSummary = { added: 0, replaced: 0, removed: 0, kept: 0, keys: [], conflicts: [], spared: [] };
  collection.patchSync(() => {
    const held = new Map<string, number>();
    for (let offset = 0; ; offset += 4096) {
      const page = readStateRowsPage(location.database, location.collection, { prefix: ENTRY_PREFIX, limit: 4096, offset });
      for (const row of page?.rows ?? []) {
        const value = (JSON.parse(row.valueJson ?? "null") as JournalRow | null)?.value;
        if (isEntry(value)) held.set(identity(value), (held.get(identity(value)) ?? 0) + 1);
      }
      if (!page || page.rows.length < 4096) break;
    }
    const added = entries.filter((entry) => {
      const left = held.get(identity(entry)) ?? 0;
      if (left > 0) { held.set(identity(entry), left - 1); summary.kept += 1; return false; }
      return true;
    });
    if (added.length === 0) return { records: [] };
    const first = nextSeqOf(collection);
    const records: JournalRow[] = added.map((entry, index) => ({ key: entryKey(first + index), value: entry }));
    summary.added = added.length;
    summary.keys.push(...records.map((row) => row.key));
    return { records: [...records, { key: META_KEY, value: { nextSeq: first + added.length } }] };
  }, {
    fenceOwner: options.fenceOwner,
    ...(options.consumedSha256 ? { afterPersist: (db) => {
      const result = db.query("UPDATE state_imports SET reconciled_sha256 = ? WHERE collection = ?").run(options.consumedSha256!, RESET_CREDIT_COLLECTION);
      if (result.changes !== 1) throw new Error(`missing import evidence for ${RESET_CREDIT_COLLECTION} reconciliation`);
    } } : {}),
  });
  return summary;
}

/** The ledger's import spec, for the import driver and its tests. */
export function resetCreditLegacyCollection(filePath = journalFile()): LegacyCollectionSpec<ResetCreditJournalEntry[]> {
  return {
    collection: RESET_CREDIT_COLLECTION,
    schemaVersion: 1,
    migrationId: "codex-reset-credits-ndjson-v1",
    legacyPath: filePath,
    decode: (bytes) => ({ ok: true, value: legacyEntries(bytes.toString("utf8")) }),
    parse: (raw) => (Array.isArray(raw) ? raw : []).filter(isEntry),
    toRows: (entries) => [
      ...entries.map((entry, index) => ({ key: entryKey(index + 1), value: entry })),
      { key: META_KEY, value: { nextSeq: entries.length + 1 } },
    ].map((row) => ({ key: row.key, value: row, controllerActive: true })),
    reconcile: (entries, _baseline, options) => mergeLegacyEntries(filePath, entries, options),
    mirrorBody: () => {
      const collection = openJournalCollection(journalLocation(filePath));
      let mirror: { body: unknown; revision: number; text: string } | null = null;
      collection.checkpointMirror((rows, revision) => {
        const entries = rows.filter((row) => row.key.startsWith(ENTRY_PREFIX)).sort((a, b) => a.key < b.key ? -1 : 1)
          .map((row) => row.value).filter(isEntry);
        mirror = { body: entries, revision, text: entries.map((entry) => `${JSON.stringify(entry)}\n`).join("") };
      });
      return mirror!;
    },
  };
}

/** Import `codex-reset-credits.ndjson` now. The Viewer's activation calls this
    with `reconcile: true`. */
export function importLegacyResetCreditJournal(
  filePath = journalFile(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return importLegacyCollection(resetCreditLegacyCollection(filePath), options);
}

/** Write `codex-reset-credits.ndjson` from SQLite for a rollback release that
    predates the move. */
export function checkpointResetCreditJournalRollbackMirrorForDemotion(filePath = journalFile()): void {
  writeLegacyRollbackMirror(resetCreditLegacyCollection(filePath));
}
