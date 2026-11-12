import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { clampPercent, type WindowKey } from "@/lib/burndown";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { KeyedRows, type KeyedRowsView } from "@/lib/state/keyedRows";
import type { DocumentRow } from "@/lib/state/legacyDocumentStore";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { smallStore } from "@/lib/state/smallStore";
import type { EngineLimits, LimitSample, LimitsSource, LimitWindow } from "@/lib/types";

/** Forward poll history for the burndown chart. Claude quota is a live-only
    snapshot with no transcript record, so its curve can only be built by
    persisting each poll here; the Codex curve is additionally backfilled from
    transcripts (see limits.ts). The prod viewer polls every 60s continuously,
    so this doubles as the sampler — no separate daemon.

    The history lives in `state.sqlite`, collection `limits_history` (#1870
    slice 8), imported once from `limits-history.json`:

      meta                  { version, codexAttributionVersion, since }
      series:<series>       one engine/account/window series, oldest first
      unattributed:<series> a quarantined legacy Codex series

    `<series>` is `<engine>|<accountId>|<window>`. A recorded sample rewrites
    only the series it extends; a poll that finds every series inside its
    five-minute gap writes nothing. Readers keep the rows per collection
    revision (`KeyedRows`): one series is one keyed read, and the whole
    history is read once and then followed through the change log. */

/** Keep just over a week so the weekly window is always fully covered. */
export const RETENTION_S = 8 * 24 * 3600;
/** One sample per engine/window per 5 minutes is plenty for the chart. */
const MIN_GAP_S = 5 * 60;
/** Hard cap per series so a stuck poller can never grow the file unbounded. */
const MAX_POINTS = 4000;

export const LIMITS_HISTORY_COLLECTION = "limits_history";
export const LIMITS_HISTORY_FILE_NAME = "limits-history.json";
const META_KEY = "meta";
const SERIES_PREFIX = "series:";
const UNATTRIBUTED_PREFIX = "unattributed:";

type EngineName = "claude" | "codex";
const WINDOWS: WindowKey[] = ["session", "weekly"];

interface HistoryFile {
  version: 1;
  /** Only samples collected with account attribution enter Codex series. */
  codexAttributionVersion: 1;
  /** Legacy values have no recoverable per-reading identity. Retain them for
   * inspection, outside every chart and calibration reader. */
  unattributedCodexSeries: Record<string, LimitSample[]>;
  /** ISO of the first sample ever recorded — the "history builds from" hint. */
  since: string | null;
  /** `${engine}|${accountId}|${window}` → samples, oldest first. */
  series: Record<string, LimitSample[]>;
}

type HistoryRow = { kind: "meta"; since: string | null } | { kind: "samples"; samples: LimitSample[] };

export function limitsHistoryPath(): string {
  return statePath(LIMITS_HISTORY_FILE_NAME);
}

function seriesKey(engine: EngineName, accountId: string, window: WindowKey): string {
  return `${engine}|${accountId}|${window}`;
}

function emptyHistory(): HistoryFile {
  return { version: 1, codexAttributionVersion: 1, unattributedCodexSeries: {}, since: null, series: {} };
}

function isSample(value: unknown): value is LimitSample {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<LimitSample>;
  return typeof s.t === "number" && Number.isFinite(s.t) && typeof s.remaining === "number" && Number.isFinite(s.remaining);
}

function samplesOf(value: unknown): LimitSample[] {
  return Array.isArray(value) ? value.filter(isSample) : [];
}

/** The legacy file as its reader always read it: an unrecognized file is an
    empty history, and Codex series written before account attribution move to
    the quarantine. */
function normalizeHistory(value: unknown): HistoryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyHistory();
  const raw = value as Partial<HistoryFile>;
  if (raw.version !== 1 || !raw.series || typeof raw.series !== "object") return emptyHistory();
  const series: Record<string, LimitSample[]> = {};
  const unattributedCodexSeries: Record<string, LimitSample[]> = {};
  for (const [key, entry] of Object.entries(raw.unattributedCodexSeries ?? {})) {
    if (key.startsWith("codex|") && Array.isArray(entry)) unattributedCodexSeries[key] = entry.filter(isSample);
  }
  for (const [key, entry] of Object.entries(raw.series)) {
    if (!Array.isArray(entry)) continue;
    const target = key.startsWith("codex|") && raw.codexAttributionVersion !== 1 ? unattributedCodexSeries : series;
    target[key] = entry.filter(isSample);
  }
  return { version: 1, codexAttributionVersion: 1, unattributedCodexSeries,
    since: typeof raw.since === "string" ? raw.since : null, series };
}

function historyRows(history: HistoryFile): DocumentRow[] {
  return [
    { key: META_KEY, value: { version: 1, codexAttributionVersion: 1, since: history.since } },
    ...Object.entries(history.series).map(([key, samples]) => ({ key: `${SERIES_PREFIX}${key}`, value: samples })),
    ...Object.entries(history.unattributedCodexSeries).map(([key, samples]) => ({ key: `${UNATTRIBUTED_PREFIX}${key}`, value: samples })),
  ];
}

function sinceOf(value: unknown): string | null {
  const since = (value as { since?: unknown } | null | undefined)?.since;
  return typeof since === "string" ? since : null;
}

function historyFromRows(rows: readonly DocumentRow[]): HistoryFile {
  const history = emptyHistory();
  for (const row of rows) {
    if (row.key === META_KEY) history.since = sinceOf(row.value);
    else if (row.key.startsWith(SERIES_PREFIX)) history.series[row.key.slice(SERIES_PREFIX.length)] = samplesOf(row.value);
    else if (row.key.startsWith(UNATTRIBUTED_PREFIX)) history.unattributedCodexSeries[row.key.slice(UNATTRIBUTED_PREFIX.length)] = samplesOf(row.value);
  }
  return history;
}

/** Retention and the cap, measured from the newest sample a series holds. */
function retained(samples: LimitSample[], nowS: number): LimitSample[] {
  const cutoff = nowS - RETENTION_S;
  let pruned = samples.filter((s) => s.t >= cutoff);
  if (pruned.length > MAX_POINTS) pruned = pruned.slice(pruned.length - MAX_POINTS);
  return pruned;
}

/** A series a rollback release extended merges with the one SQLite extended:
    every sample either side holds, once per timestamp, oldest first. */
function mergedSamples(held: unknown, incoming: unknown): LimitSample[] {
  const byTime = new Map<number, LimitSample>();
  for (const sample of [...samplesOf(held), ...samplesOf(incoming)]) if (!byTime.has(sample.t)) byTime.set(sample.t, sample);
  const merged = [...byTime.values()].sort((left, right) => left.t - right.t);
  return retained(merged, merged.at(-1)?.t ?? 0);
}

/** Import, reconcile and the rollback mirror. */
export const limitsHistoryDocumentStore = smallStore<HistoryFile>({
  collection: LIMITS_HISTORY_COLLECTION,
  empty: emptyHistory,
  parse: normalizeHistory,
  toRows: historyRows,
  fromRows: historyFromRows,
  toFile: (history) => history,
  mergeRow: (key, held, incoming) => {
    if (key === META_KEY) {
      const since = [sinceOf(held), sinceOf(incoming)].filter((value): value is string => value !== null).sort()[0] ?? null;
      return { version: 1, codexAttributionVersion: 1, since };
    }
    return mergedSamples(held, incoming);
  },
});

/* Constructed on first use: this module can be reached while the state
   modules are still initializing (an import cycle through the registry). */
let keyedRows: KeyedRows<HistoryRow> | null = null;
const rows = (): KeyedRows<HistoryRow> => keyedRows ??= new KeyedRows<HistoryRow>({
  collection: LIMITS_HISTORY_COLLECTION,
  prefixes: [META_KEY, SERIES_PREFIX, UNATTRIBUTED_PREFIX],
  busyMessage: "limits history is busy",
  decode: (key, value) => key === META_KEY ? { kind: "meta", since: sinceOf(value) } : { kind: "samples", samples: samplesOf(value) },
  importLegacy: (filePath, options) => limitsHistoryDocumentStore.importLegacy(filePath, options),
});

/* ----------------------------------------------------------------- reads */

let legacyRead: { filePath: string; signature: string; history: HistoryFile } | null = null;

function legacySignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : "missing";
  } catch {
    return null;
  }
}

/** The legacy file, for a process that runs before the import. A missing or
    unreadable file is simply an empty history, as it always was. */
function readLegacyHistory(filePath: string): HistoryFile {
  const signature = legacySignature(filePath);
  if (signature !== null && legacyRead?.filePath === filePath && legacyRead.signature === signature) return legacyRead.history;
  let history = emptyHistory();
  try {
    history = normalizeHistory(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch { /* first run, a tombstone or an unreadable file */ }
  if (signature !== null) legacyRead = { filePath, signature, history };
  return history;
}

function historyView(): KeyedRowsView<HistoryRow> | null {
  try {
    return rows().view(legacyDatabasePath(limitsHistoryPath()));
  } catch (error) {
    console.warn("[limits] history unavailable", error instanceof Error ? error.message : String(error));
    return null;
  }
}

function viewSamples(view: KeyedRowsView<HistoryRow>, key: string): LimitSample[] {
  const row = view.get(`${SERIES_PREFIX}${key}`);
  return row?.kind === "samples" ? row.samples : [];
}

/* The read copy is one live map per database: the same map at the same
   revision holds the same rows. */
let assembled: { rows: ReadonlyMap<string, HistoryRow>; revision: number; history: HistoryFile } | null = null;

/** The whole history. Series arrays are shared with the store's read copy:
    callers read them and never change them. */
export function readHistory(): HistoryFile {
  const filePath = limitsHistoryPath();
  const view = historyView();
  if (!view) return readLegacyHistory(filePath);
  try {
    const all = view.rows();
    if (assembled?.rows === all && assembled.revision === view.revision) return assembled.history;
    const history = emptyHistory();
    for (const [key, row] of all) {
      if (row.kind === "meta") history.since = row.since;
      else if (key.startsWith(SERIES_PREFIX)) history.series[key.slice(SERIES_PREFIX.length)] = row.samples;
      else history.unattributedCodexSeries[key.slice(UNATTRIBUTED_PREFIX.length)] = row.samples;
    }
    assembled = { rows: all, revision: view.revision, history };
    return history;
  } catch (error) {
    console.warn("[limits] history unavailable", error instanceof Error ? error.message : String(error));
    return emptyHistory();
  }
}

/** Read one engine/account/window series, pruned to the retention window. */
export function historySamples(engine: EngineName, accountId: string, window: WindowKey, now = Math.round(Date.now() / 1000)): LimitSample[] {
  const key = seriesKey(engine, accountId, window);
  const view = historyView();
  let arr: LimitSample[];
  try {
    arr = view ? viewSamples(view, key) : readLegacyHistory(limitsHistoryPath()).series[key] ?? [];
  } catch (error) {
    console.warn("[limits] history unavailable", error instanceof Error ? error.message : String(error));
    arr = [];
  }
  const cutoff = now - RETENTION_S;
  return arr.filter((s) => s.t >= cutoff);
}

/* ---------------------------------------------------------------- writes */

/** Whether a window may enter forward history. A Codex window read from a
    transcript rests on registry custody that a later unverified rebind
    quarantines, and a stored point keeps no path back to that custody, so only
    the account's own live probe answer is recorded. Transcript readings reach
    the chart through the backfill, which rechecks custody on every read.
    `source` is the read's provenance, for windows that carry none of their own. */
function recordable(engine: EngineName, win: LimitWindow, source: LimitsSource): boolean {
  return engine !== "codex" || (win.source ?? source) === "live";
}

/** Append the current remaining-quota values for an engine/account, one
    point per window. Downsampled to {@link MIN_GAP_S}, pruned to the retention
    window and capped, so the history stays small across a long-running viewer. */
export function recordLimitSample(engine: EngineName, accountId: string, limits: EngineLimits, source: LimitsSource, nowMs = Date.now()): void {
  recordLimitSamples(engine, [{ accountId, limits, source }], nowMs);
}

/** The account controller records one whole tick in one transaction. Only
    the series a sample extends are written. */
export function recordLimitSamples(engine: EngineName, entries: readonly { accountId: string; limits: EngineLimits; source: LimitsSource }[], nowMs = Date.now()): void {
  if (!entries.length) return;
  const nowS = Math.round(nowMs / 1000);
  const candidates: { key: string; sample: LimitSample }[] = [];
  for (const { accountId, limits, source } of entries) for (const window of WINDOWS) {
    const win = limits[window];
    if (!win || !Number.isFinite(win.usedPercent) || !recordable(engine, win, source)) continue;
    candidates.push({ key: seriesKey(engine, accountId, window), sample: { t: nowS, remaining: clampPercent(100 - win.usedPercent) } });
  }
  if (!candidates.length) return;
  const filePath = limitsHistoryPath();
  /* A poll inside every series' gap writes nothing. The read copy can only
     lag a commit, so a series it shows inside the gap is inside it. */
  const view = historyView();
  if (view) {
    try {
      const due = (key: string) => {
        const last = viewSamples(view, key).at(-1);
        return !last || nowS - last.t >= MIN_GAP_S;
      };
      if (!candidates.some(({ key }) => due(key))) return;
    } catch { /* the transaction below reads under the lease */ }
  }
  try {
    rows().write(filePath, (read) => {
      const working = new Map<string, LimitSample[]>();
      const records: DocumentRow[] = [];
      for (const { key, sample } of candidates) {
        const rowKey = `${SERIES_PREFIX}${key}`;
        const arr = working.get(rowKey) ?? samplesOf(read(rowKey));
        const last = arr[arr.length - 1];
        if (last && nowS - last.t < MIN_GAP_S) continue;
        const next = retained([...arr, sample], nowS);
        working.set(rowKey, next);
      }
      for (const [key, value] of working) records.push({ key, value });
      if (!records.length) return { records };
      if (sinceOf(read(META_KEY)) === null) {
        records.push({ key: META_KEY, value: { version: 1, codexAttributionVersion: 1, since: new Date(nowMs).toISOString() } });
      }
      return { records };
    });
  } catch (err) {
    // A busy database or an unpromoted release loses this one poll's point.
    console.warn("[limits] failed to persist history", err instanceof FileTransactionBusyError ? err.message : err);
  }
}

/** ISO time the forward history began (for the sparse-state hint), or null. */
export function historySince(): string | null {
  const view = historyView();
  if (!view) return readLegacyHistory(limitsHistoryPath()).since;
  try {
    const meta = view.get(META_KEY);
    return meta?.kind === "meta" ? meta.since : null;
  } catch (error) {
    console.warn("[limits] history unavailable", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/* ------------------------------------------------------- import, rollback */

/** Import `limits-history.json` now. The Viewer's activation calls this with
    `reconcile: true`. */
export function importLegacyLimitsHistory(filePath = limitsHistoryPath(), options: { reconcile: boolean } = { reconcile: true }) {
  return limitsHistoryDocumentStore.importLegacy(filePath, options);
}

/** Write `limits-history.json` from SQLite for a rollback release that
    predates the move. */
export function checkpointLimitsHistoryRollbackMirrorForDemotion(filePath = limitsHistoryPath()): void {
  limitsHistoryDocumentStore.checkpointRollbackMirror(filePath);
}

/** Test seam: forget every held row, the way a restarted process would. */
export function resetLimitsHistoryStoreForTests(): void {
  rows().resetForTests();
  legacyRead = null;
  assembled = null;
}
