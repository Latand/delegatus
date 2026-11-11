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
  /** When a report last named the path. */
  at: number;
  /** When the picture was last seen at its own path. */
  seenAt: number;
  /** The lane whose report named it; absent for a text that belongs to none. */
  lane?: string;
}

export const REPORT_MEDIA_FILE = /^[a-f0-9]{64}\.(?:png|jpg|jpeg|gif|webp|avif|bmp)$/;
/** The index never grows past this; a larger one is read as empty. */
const INDEX_BYTES = 16 * 1024 * 1024;

function validRow(row: unknown): row is ReportMediaRow {
  if (!row || typeof row !== "object") return false;
  const { path: named, file, bytes, at, seenAt, lane } = row as Record<string, unknown>;
  return (lane === undefined || typeof lane === "string") && typeof named === "string" && path.isAbsolute(named) && typeof file === "string" && REPORT_MEDIA_FILE.test(file)
    && Number.isInteger(bytes) && (bytes as number) > 0 && Number.isFinite(at) && Number.isFinite(seenAt);
}

let held: { stamp: string; rows: ReportMediaRow[] } | null = null;

/** The store's rows; none while the store does not exist or cannot be read. */
export function reportMediaRows(): ReportMediaRow[] {
  const index = path.join(reportMediaRoot(), "index.json");
  try {
    const stat = fs.statSync(index);
    const stamp = `${index}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (held?.stamp === stamp) return held.rows;
    if (stat.size > INDEX_BYTES) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(index, "utf8"));
    const rows = Array.isArray(parsed) ? parsed.filter(validRow) : [];
    held = { stamp, rows };
    return rows;
  } catch {
    return [];
  }
}

/** The kept copy of a picture a report named by this path, or null. */
export function keptReportPicture(abs: string): string | null {
  const row = reportMediaRows().find((candidate) => candidate.path === abs);
  if (!row) return null;
  const copy = path.join(reportMediaRoot(), row.file);
  try {
    return fs.statSync(copy).isFile() ? copy : null;
  } catch {
    return null;
  }
}
