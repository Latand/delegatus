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
}

export const REPORT_MEDIA_FILE = /^[a-f0-9]{64}\.(?:png|jpg|jpeg|gif|webp|avif|bmp)$/;
/** Paths the index holds; past it the ones named longest ago leave. */
export const REPORT_MEDIA_ROWS = 10_000;
/** A larger index than these rows can make is not this store's. */
const INDEX_BYTES = 32 * 1024 * 1024;

function validRow(row: unknown): row is ReportMediaRow {
  if (!row || typeof row !== "object") return false;
  const { path: named, file, bytes, mtimeMs, at, goneAt, lane, project } = row as Record<string, unknown>;
  return typeof named === "string" && path.isAbsolute(named) && typeof file === "string" && REPORT_MEDIA_FILE.test(file)
    && Number.isInteger(bytes) && (bytes as number) > 0 && Number.isFinite(mtimeMs) && Number.isFinite(at)
    && (goneAt === undefined || Number.isFinite(goneAt)) && (lane === undefined || typeof lane === "string")
    && (project === null || typeof project === "string");
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

/** The row and the kept copy of a picture a report named by this path. */
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
  return keptReportRow(abs)?.copy ?? null;
}
