import crypto from "node:crypto";
import type { promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { admittedAs, lexicalAllowedRoots, openAdmitted, realAllowedRoots, realpathAdmitted, resolveLocal, underRoot, type AllowedRoots } from "@/lib/artifact/localFile";
import { isEvidenceImage } from "@/lib/artifact/evidenceFormats";
import { SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import { withFileTransaction } from "@/lib/state/fileTransaction";

import { REPORT_MEDIA_FILE, reportMediaRoot, reportMediaRows, type ReportMediaRow } from "./lookup";

/*
 * The report picture store. A stage report or a task names a picture by the
 * path it has in a lane checkout or a scratch directory, and those are removed
 * when the lane ends. When such a text is written, each picture it names is
 * copied here, and the path routes read the copy once the picture is gone
 * from its own path.
 *
 * The store is small and temporary. One picture is at most `fileBytes`; a
 * copy is dropped `retentionMs` after the picture was last seen at its own
 * path or last named; and the whole store holds at most `totalBytes`, the
 * longest-unnamed copies leaving first. A dropped picture is simply missing,
 * and the text that names it shows it as not available.
 */

const MIB = 1024 * 1024;
/** Pictures one written text may add; the rest are left where they are. */
export const REPORT_MEDIA_PER_TEXT = 64;

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp",
};

export interface ReportMediaLimits {
  totalBytes: number;
  fileBytes: number;
  retentionMs: number;
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 1 GiB in all, 16 MiB a picture, 7 days; each has its own variable. */
export function reportMediaLimits(env: Readonly<Record<string, string | undefined>> = process.env): ReportMediaLimits {
  return {
    totalBytes: Math.floor(positive(env.LLV_REPORT_MEDIA_MAX_BYTES, 1024 * MIB)),
    fileBytes: Math.floor(positive(env.LLV_REPORT_MEDIA_MAX_FILE_BYTES, 16 * MIB)),
    retentionMs: positive(env.LLV_REPORT_MEDIA_RETENTION_DAYS, 7) * 86_400_000,
  };
}

/* An absolute or home-relative path that ends in a picture extension, as a
   text writes it bare, as a link target or as a file URL. It starts where no
   path character precedes it, so the tail of a relative path is left alone. */
const PICTURE_PATH = /(?<![\w.~/\\-])(?:file:\/\/)?(~?\/[^\s"'`<>()[\]{}|*,;]+?\.(?:png|jpe?g|gif|webp|avif|bmp))(?![\w/-])/gi;

/** Every string a record holds, at any depth: the texts of a structured
    report, whose pictures are named in its fields. */
export function recordTexts(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) recordTexts(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) recordTexts(item, into);
  return into;
}

/** The picture paths these texts name, each once, in the order written. */
export function reportPicturePaths(texts: readonly (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PICTURE_PATH)) found.add(resolveLocal(match[1]!));
  }
  return [...found];
}

async function saveRows(rows: ReportMediaRow[]): Promise<void> {
  const next = path.join(reportMediaRoot(), "index.next");
  await fs.rm(next, { force: true });
  await fs.writeFile(next, JSON.stringify(rows), { flag: "wx", mode: 0o600, flush: true });
  await fs.rename(next, path.join(reportMediaRoot(), "index.json"));
}

async function present(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The rows the limits keep. A row past its age stays while its picture still
    lies at its own path: the clock runs from the moment it is gone. */
async function retained(rows: ReportMediaRow[], limits: ReportMediaLimits, now: number): Promise<ReportMediaRow[]> {
  const kept: ReportMediaRow[] = [];
  for (const row of rows) {
    if (now - Math.max(row.at, row.seenAt) <= limits.retentionMs) kept.push(row);
    else if (await present(row.path)) kept.push({ ...row, seenAt: now });
  }
  kept.sort((left, right) => left.at - right.at || left.path.localeCompare(right.path));
  const total = () => [...new Map(kept.map((row) => [row.file, row.bytes])).values()].reduce((sum, bytes) => sum + bytes, 0);
  while (kept.length > 0 && total() > limits.totalBytes) kept.shift();
  return kept;
}

/** Removes every copy no row names, and what an interrupted write left. */
async function sweepFiles(rows: readonly ReportMediaRow[]): Promise<void> {
  const named = new Set(rows.map((row) => row.file));
  for (const name of await fs.readdir(reportMediaRoot())) {
    if ((REPORT_MEDIA_FILE.test(name) && !named.has(name)) || name.startsWith(".copy-")) {
      await fs.rm(path.join(reportMediaRoot(), name), { force: true });
    }
  }
}

/** Reads one admitted picture through a pinned descriptor; null when it is no
    readable picture of an allowed size under the roots the path routes serve. */
async function readPicture(abs: string, lexical: AllowedRoots, real: () => Promise<AllowedRoots>, limits: ReportMediaLimits): Promise<Buffer | null> {
  const mime = MIME[path.extname(abs).toLowerCase()];
  const admission = admittedAs(abs, lexical);
  if (!mime || !admission || underRoot(abs, reportMediaRoot())) return null;
  let handle: fsp.FileHandle | undefined;
  try {
    const resolved = await fs.realpath(abs);
    if (!realpathAdmitted(admission, resolved, await real()) || !isEvidenceImage(resolved)) return null;
    handle = await openAdmitted(resolved);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limits.fileBytes) return null;
    const data = await handle.readFile();
    return data.length === stat.size && sniffAgrees(mime, data.subarray(0, SNIFF_BYTES)) ? data : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Copies the pictures these texts name into the store and applies the limits.
 * A path that names no readable picture is skipped; nothing here fails the
 * write of the text itself. Returns the paths now kept from these texts.
 */
export async function keepReportPictures(texts: readonly (string | null | undefined)[], now: number = Date.now(), limits: ReportMediaLimits = reportMediaLimits()): Promise<string[]> {
  const paths = reportPicturePaths(texts).slice(0, REPORT_MEDIA_PER_TEXT);
  if (paths.length === 0) return [];
  const lexical = lexicalAllowedRoots();
  let roots: Promise<AllowedRoots> | undefined;
  const real = () => (roots ??= realAllowedRoots());
  const read: Array<{ path: string; data: Buffer }> = [];
  for (const named of paths) {
    const data = await readPicture(named, lexical, real, limits);
    if (data) read.push({ path: named, data });
  }
  if (read.length === 0) return [];
  await fs.mkdir(reportMediaRoot(), { recursive: true, mode: 0o700 });
  return withFileTransaction(path.join(reportMediaRoot(), "owner.lock"), "report media is busy", async () => {
    const rows = new Map(reportMediaRows().map((row) => [row.path, row] as const));
    for (const { path: named, data } of read) {
      const file = `${crypto.createHash("sha256").update(data).digest("hex")}${path.extname(named).toLowerCase()}`;
      const target = path.join(reportMediaRoot(), file);
      if (!await present(target)) {
        const staged = path.join(reportMediaRoot(), `.copy-${crypto.randomUUID()}`);
        await fs.writeFile(staged, data, { flag: "wx", mode: 0o600, flush: true });
        await fs.rename(staged, target);
      }
      rows.set(named, { path: named, file, bytes: data.length, at: now, seenAt: now });
    }
    const kept = await retained([...rows.values()], limits, now);
    await saveRows(kept);
    await sweepFiles(kept);
    const held = new Set(kept.map((row) => row.path));
    return read.map((entry) => entry.path).filter((named) => held.has(named));
  });
}

/** The same, for a caller that must not wait or fail: a write of a report or
    a task goes on whatever happens to its pictures. */
export function keepReportPicturesSoon(texts: readonly (string | null | undefined)[]): void {
  if (reportPicturePaths(texts).length === 0) return;
  void keepReportPictures(texts).catch((error) => {
    console.warn(`[report-media] pictures were not kept: ${error instanceof Error ? error.message : String(error)}`);
  });
}
