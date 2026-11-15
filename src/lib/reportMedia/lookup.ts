import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

/*
 * The read side of the report picture store: which copy stands for a path a
 * report wrote. Kept apart from the writer so the path routes can ask without
 * loading it.
 */

export const reportMediaRoot = () => statePath("report-media");

/** One path a report named and the copy kept for it. */
export interface ReportMediaRow {
  /** The absolute path the report wrote. */
  path: string;
  /** The copy's name in the store: the content hash and the picture's extension. */
  file: string;
  bytes: number;
  /** The picture's modification time when it was copied. */
  mtimeMs: number;
  /** When a report last named the path. */
  at: number;
  /** When the picture was first found gone from its own path, once its age
      made the store look. */
  goneAt?: number;
  /** The lane whose report named it; absent for a text that belongs to none. */
  lane?: string;
  /** The project the picture lay in; null where it lay in none. */
  project: string | null;
  /** Version 1: both source paths passed hidden-component admission when
      these bytes were copied. Absent on legacy copies with unknown sources. */
  hiddenPathPolicy?: 1;
}

export const REPORT_MEDIA_FILE = /^[a-f0-9]{64}\.(?:png|jpg|jpeg|gif|webp|avif|bmp)$/;
/** Paths the index holds; past it the ones named longest ago leave. */
export const REPORT_MEDIA_ROWS = 10_000;
/** A larger index than these rows can make is not this store's. */
const INDEX_BYTES = 32 * 1024 * 1024;

function validRow(row: unknown): row is ReportMediaRow {
  if (!row || typeof row !== "object") return false;
  const { path: named, file, bytes, mtimeMs, at, goneAt, lane, project, hiddenPathPolicy } = row as Record<string, unknown>;
  return typeof named === "string" && path.isAbsolute(named) && typeof file === "string" && REPORT_MEDIA_FILE.test(file)
    && Number.isInteger(bytes) && (bytes as number) > 0 && Number.isFinite(mtimeMs) && Number.isFinite(at)
    && (goneAt === undefined || Number.isFinite(goneAt)) && (lane === undefined || typeof lane === "string")
    && (project === null || typeof project === "string") && (hiddenPathPolicy === undefined || hiddenPathPolicy === 1);
}

let held: { stamp: string; rows: ReportMediaRow[] | null } | null = null;

/** The store's rows: none while there is no index, and null when the index
    is there and cannot be read as one. */
export function reportMediaIndex(): ReportMediaRow[] | null {
  const index = path.join(reportMediaRoot(), "index.json");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(index);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const stamp = `${index}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (held?.stamp === stamp) return held.rows;
  let rows: ReportMediaRow[] | null = null;
  try {
    const parsed: unknown = stat.size > INDEX_BYTES ? null : JSON.parse(fs.readFileSync(index, "utf8"));
    if (Array.isArray(parsed) && parsed.length <= REPORT_MEDIA_ROWS && parsed.every(validRow)) rows = parsed;
  } catch {
    rows = null;
  }
  held = { stamp, rows };
  return rows;
}

/** The rows a reader may use; an unreadable index answers with none. */
export function reportMediaRows(): ReportMediaRow[] {
  return reportMediaIndex() ?? [];
}

/** Raw metadata, including legacy rows. Callers must admit the copy before reading it. */
export function keptReportRow(abs: string): { row: ReportMediaRow; copy: string } | null {
  const row = reportMediaRows().find((candidate) => candidate.path === abs);
  if (!row) return null;
  const copy = path.join(reportMediaRoot(), row.file);
  try {
    return fs.statSync(copy).isFile() ? { row, copy } : null;
  } catch {
    return null;
  }
}

/** The kept copy of a picture a report named by this path, or null. */
export function keptReportPicture(abs: string): string | null {
  const kept = keptReportRow(abs);
  return kept?.row.hiddenPathPolicy === 1 ? kept.copy : null;
}

/** Store paths, including direct hash requests and resolved aliases, need a
    row proving that the copied bytes passed source admission. Legacy rows
    cannot establish what a deleted alias originally resolved to. */
export function reportMediaCopyAllowed(candidate: string): boolean {
  const root = reportMediaRoot();
  const stores = [root];
  try { stores.push(fs.realpathSync(root)); } catch { /* No resolved store yet. */ }
  for (const store of new Set(stores)) {
    if (candidate !== store && !candidate.startsWith(store + path.sep)) continue;
    const file = path.relative(store, candidate);
    if (!REPORT_MEDIA_FILE.test(file) || !reportMediaRows().some(row => row.file === file && row.hiddenPathPolicy === 1)) return false;
  }
  return true;
}
