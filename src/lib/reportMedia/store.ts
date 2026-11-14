import crypto from "node:crypto";
import { realpathSync, type promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { admittedAs, hiddenPathAllowed, inFencedStore, lexicalAllowedRoots, openAdmitted, realAllowedRoots, realpathAdmitted, resolveLocal, underRoot, type AllowedRoots } from "@/lib/artifact/localFile";
import { isEvidenceImage } from "@/lib/artifact/evidenceFormats";
import { SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";

import { REPORT_MEDIA_FILE, REPORT_MEDIA_ROWS, reportMediaIndex, reportMediaRoot, type ReportMediaRow } from "./lookup";
import { writtenPicturePaths } from "./paths";

/*
 * The report picture store. A stage report, a bridge report or a task names a
 * picture by the path it has in a lane checkout, a scratch directory or a
 * temp directory, and those are swept. When such a text is written, each
 * picture it names is copied here, and the path routes read the copy.
 *
 * What is copied is a raster under a root the path routes already serve, or
 * under one of the named temp roots: nothing an agent's text names elsewhere
 * is read. The bytes must agree with the extension.
 *
 * The store is small and temporary. One picture is at most `fileBytes`. A
 * copy named by a lane's report leaves `retentionMs` after that lane
 * finished. One that belongs to no lane is looked at once `retentionMs` have
 * passed since it was last named: while its picture still lies at its own
 * path it stays, and it leaves `retentionMs` after it was first found gone.
 * The whole store holds at most `totalBytes`, the pictures named longest ago
 * leaving first. A dropped picture is simply missing, and the text that
 * names it says so.
 */

const MIB = 1024 * 1024;
/** Pictures one written record may add; the rest are left where they are. */
export const REPORT_MEDIA_PER_RECORD = 64;
/** Bytes one written record may add. */
export const REPORT_MEDIA_BYTES_PER_RECORD = 64 * MIB;
/** A mention this recent needs no second write of the index. */
const FRESH_MENTION_MS = 3_600_000;
const STREAM_CHUNK = 256 * 1024;

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp",
};

export interface ReportMediaLimits {
  totalBytes: number;
  fileBytes: number;
  retentionMs: number;
}

/** When a lane finished; null while it has not; undefined when no such lane
    is recorded, and its pictures then age as those of no lane do. */
export type LaneFinishedAt = (lane: string) => number | null | undefined;

export interface KeepOptions {
  lane?: string;
  now?: number;
  limits?: ReportMediaLimits;
  laneFinishedAt?: LaneFinishedAt;
  /** The project a picture's directory belongs to. */
  projectOf?: (directory: string) => string | null;
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

/**
 * The temp directories a named picture may be copied from, beside the roots
 * the path routes serve: the service's own temp directory and `/tmp`, or the
 * colon-separated list in `LLV_REPORT_MEDIA_TEMP_ROOTS` (empty for none). A
 * stage's own temp directory lies in the stage scratch, which is served.
 */
export function reportMediaTempRoots(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const configured = env.LLV_REPORT_MEDIA_TEMP_ROOTS;
  const roots = configured === undefined ? [os.tmpdir(), "/tmp"] : configured.split(":");
  return [...new Set(roots.map((root) => root.trim()).filter((root) => path.isAbsolute(root)).map((root) => path.resolve(root)).filter((root) => root !== path.parse(root).root))];
}

/** The lane record's own answer: closed, and nothing of it still running. */
async function recordedLaneFinish(): Promise<LaneFinishedAt> {
  const [{ findPipelineRecord }, { pipelineActivitySettled }] = await Promise.all([import("@/lib/pipelines/store"), import("@/lib/pipelines/types")]);
  return (lane) => {
    const pipeline = findPipelineRecord(lane);
    if (!pipeline) return undefined;
    const closedAt = pipeline.closedAt ? Date.parse(pipeline.closedAt) : Number.NaN;
    return Number.isFinite(closedAt) && pipelineActivitySettled(pipeline) ? closedAt : null;
  };
}

/** The absolute picture paths these texts name, each once, in the order written. */
export function reportPicturePaths(texts: readonly (string | null | undefined)[]): string[] {
  return [...new Set(writtenPicturePaths(texts).map(resolveLocal))];
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

function real(directory: string): string | null {
  try {
    return realpathSync(directory);
  } catch {
    return null;
  }
}

/** The rows the limits keep. */
async function retained(rows: ReportMediaRow[], limits: ReportMediaLimits, now: number, laneFinishedAt: LaneFinishedAt): Promise<ReportMediaRow[]> {
  const kept: ReportMediaRow[] = [];
  const finishes = new Map<string, number | null | undefined>();
  for (const row of rows) {
    if (row.lane !== undefined && !finishes.has(row.lane)) finishes.set(row.lane, laneFinishedAt(row.lane));
    const finished = row.lane === undefined ? undefined : finishes.get(row.lane);
    if (finished === null) { kept.push(row); continue; }
    if (finished !== undefined) { if (now - finished <= limits.retentionMs) kept.push(row); continue; }
    if (now - row.at <= limits.retentionMs) { kept.push(row); continue; }
    /* With no lane to finish, the clock runs from the moment the picture is
       found gone from its own path. */
    if (row.goneAt === undefined) {
      if (await present(row.path)) kept.push(row);
      else kept.push({ ...row, goneAt: now });
    } else if (now - row.goneAt <= limits.retentionMs) kept.push(row);
  }
  kept.sort((left, right) => left.at - right.at || left.path.localeCompare(right.path));
  if (kept.length > REPORT_MEDIA_ROWS) kept.splice(0, kept.length - REPORT_MEDIA_ROWS);
  const sizes = new Map<string, { bytes: number; rows: number }>();
  let total = 0;
  for (const row of kept) {
    const size = sizes.get(row.file);
    if (size) size.rows += 1;
    else { sizes.set(row.file, { bytes: row.bytes, rows: 1 }); total += row.bytes; }
  }
  let from = 0;
  for (; from < kept.length && total > limits.totalBytes; from++) {
    const size = sizes.get(kept[from]!.file)!;
    if (--size.rows === 0) total -= size.bytes;
  }
  return from > 0 ? kept.slice(from) : kept;
}

/** Removes the copies no row names any more. A copy no row names that is
    younger than the retention stays: after an unreadable index it may be the
    only thing left of a picture, and a later write names it again. */
async function sweepFiles(rows: readonly ReportMediaRow[], limits: ReportMediaLimits, now: number, dropped: ReadonlySet<string>): Promise<void> {
  const named = new Set(rows.map((row) => row.file));
  for (const name of await fs.readdir(reportMediaRoot())) {
    const file = path.join(reportMediaRoot(), name);
    if (name.startsWith(".copy-")) { await fs.rm(file, { force: true }); continue; }
    if (!REPORT_MEDIA_FILE.test(name) || named.has(name)) continue;
    const aged = dropped.has(name) || await fs.stat(file).then((stat) => now - stat.mtimeMs > limits.retentionMs, () => false);
    if (aged) await fs.rm(file, { force: true });
  }
}

interface Admitted { handle: fsp.FileHandle; resolved: string; bytes: number; mtimeMs: number }

/**
 * Opens one named picture when it may be copied: it lies, as written and
 * with its links resolved, under a root the path routes serve or under a
 * named temp root, outside every fenced store; it is a regular raster file
 * of an allowed size. The caller reads and closes the descriptor.
 */
async function admitPicture(abs: string, lexical: AllowedRoots, realRoots: () => Promise<AllowedRoots>, temp: readonly string[], limits: ReportMediaLimits): Promise<Admitted | null> {
  if (!MIME[path.extname(abs).toLowerCase()] || underRoot(abs, reportMediaRoot())) return null;
  if (!hiddenPathAllowed(abs, lexical, temp)) return null;
  const served = admittedAs(abs, lexical);
  const inTemp = !inFencedStore(abs, lexical.fenced) && temp.some((root) => underRoot(abs, root));
  if (!served && !inTemp) return null;
  let handle: fsp.FileHandle | undefined;
  try {
    const resolved = await fs.realpath(abs);
    const roots = await realRoots();
    const realTemp = temp.map(real).filter((root): root is string => root !== null);
    if (!hiddenPathAllowed(resolved, roots, realTemp)) return null;
    const reachable = (served !== null && realpathAdmitted(served, resolved, roots))
      || (inTemp && !inFencedStore(resolved, roots.fenced)
        && (admittedAs(resolved, roots) !== null || realTemp.some(root => underRoot(resolved, root))));
    const store = real(reportMediaRoot());
    if (!reachable || !isEvidenceImage(resolved) || (store !== null && underRoot(resolved, store))) return null;
    handle = await openAdmitted(resolved);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limits.fileBytes) return null;
    const admitted = { handle, resolved, bytes: stat.size, mtimeMs: stat.mtimeMs };
    handle = undefined;
    return admitted;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Streams the open picture into the store under its content hash, a chunk
    at a time; null when its bytes are no picture of its extension or changed
    size on the way. */
async function copyPicture(admitted: Admitted, extension: string): Promise<string | null> {
  const staged = path.join(reportMediaRoot(), `.copy-${crypto.randomUUID()}`);
  const out = await fs.open(staged, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(STREAM_CHUNK);
  let position = 0;
  let agrees = false;
  try {
    for (;;) {
      const { bytesRead } = await admitted.handle.read(chunk, 0, STREAM_CHUNK, position);
      if (bytesRead <= 0) break;
      if (position === 0) agrees = sniffAgrees(MIME[extension]!, chunk.subarray(0, Math.min(bytesRead, SNIFF_BYTES)));
      if (!agrees || position + bytesRead > admitted.bytes) break;
      hash.update(chunk.subarray(0, bytesRead));
      await out.write(chunk, 0, bytesRead);
      position += bytesRead;
    }
    if (!agrees || position !== admitted.bytes) return null;
    await out.sync();
    const file = `${hash.digest("hex")}${extension}`;
    const target = path.join(reportMediaRoot(), file);
    /* A legacy file at this hash has no source proof. Publish the bytes just
       read, even when a copy already exists, before certifying this row. */
    await fs.rename(staged, target);
    return file;
  } finally {
    await out.close().catch(() => {});
    await fs.rm(staged, { force: true });
  }
}

/** Copies the pictures these texts name; see `keepWrittenPictures`. */
export function keepReportPictures(texts: readonly (string | null | undefined)[], options: KeepOptions = {}): Promise<string[]> {
  return keepWrittenPictures(writtenPicturePaths(texts), options);
}

/**
 * Copies the named pictures into the store, one at a time, and applies the
 * limits. A path that names no picture that may be copied is skipped, and so
 * is one whose copy is already of the same file. Returns the paths now kept.
 */
export async function keepWrittenPictures(written: readonly string[], options: KeepOptions = {}): Promise<string[]> {
  const now = options.now ?? Date.now();
  const limits = options.limits ?? reportMediaLimits();
  const paths = [...new Set(written.map(resolveLocal))];
  if (paths.length === 0) return [];
  const lexical = lexicalAllowedRoots();
  const temp = reportMediaTempRoots();
  let roots: Promise<AllowedRoots> | undefined;
  const realRoots = () => (roots ??= realAllowedRoots());
  /* Before the lock: which of the paths may be copied at all, and which the
     store already holds as they are. */
  const before = new Map((reportMediaIndex() ?? []).map((row) => [row.path, row] as const));
  const candidates: string[] = [];
  let pending = false;
  for (const named of paths) {
    if (candidates.length >= REPORT_MEDIA_PER_RECORD) break;
    const admitted = await admitPicture(named, lexical, realRoots, temp, limits);
    if (!admitted) continue;
    await admitted.handle.close().catch(() => {});
    candidates.push(named);
    const row = before.get(named);
    pending ||= !row || row.hiddenPathPolicy !== 1 || row.bytes !== admitted.bytes || row.mtimeMs !== admitted.mtimeMs || now - row.at > FRESH_MENTION_MS
      || (options.lane !== undefined && row.lane !== options.lane) || row.goneAt !== undefined;
  }
  if (candidates.length === 0) return [];
  if (!pending) return candidates;
  const laneFinishedAt = options.laneFinishedAt ?? await recordedLaneFinish();
  const projectOf = options.projectOf ?? (await import("@/lib/scanner/describe")).projectForCwd;
  await fs.mkdir(reportMediaRoot(), { recursive: true, mode: 0o700 });
  return withFileTransactionAsync(path.join(reportMediaRoot(), "owner"), "report media is busy", async () => {
    const index = reportMediaIndex();
    /* An index that cannot be read is set aside and rebuilt from the writes
       that follow; the copies stay. */
    if (index === null) await fs.rename(path.join(reportMediaRoot(), "index.json"), path.join(reportMediaRoot(), "index.unreadable")).catch(() => {});
    const rows = new Map((index ?? []).map((row) => [row.path, row] as const));
    const files = new Set([...rows.values()].map((row) => row.file));
    let budget = REPORT_MEDIA_BYTES_PER_RECORD;
    for (const named of candidates) {
      const admitted = await admitPicture(named, lexical, realRoots, temp, limits);
      if (!admitted) continue;
      try {
        const held = rows.get(named);
        const lane = options.lane ?? held?.lane;
        let file: string | null = held?.hiddenPathPolicy === 1 && held.bytes === admitted.bytes && held.mtimeMs === admitted.mtimeMs
          && await present(path.join(reportMediaRoot(), held.file)) ? held.file : null;
        if (file === null) {
          if (admitted.bytes > budget) continue;
          budget -= admitted.bytes;
          file = await copyPicture(admitted, path.extname(named).toLowerCase());
          if (file === null) continue;
        }
        rows.set(named, { path: named, file, bytes: admitted.bytes, mtimeMs: admitted.mtimeMs, at: now,
          ...(lane ? { lane } : {}), project: projectOf(path.dirname(admitted.resolved)) ?? null, hiddenPathPolicy: 1 });
      } finally {
        await admitted.handle.close().catch(() => {});
      }
    }
    const kept = await retained([...rows.values()], limits, now, laneFinishedAt);
    await saveRows(kept);
    const named = new Set(kept.map((row) => row.file));
    const dropped = new Set([...files].filter((file) => !named.has(file)));
    /* The directory is listed only when a copy left or the index was rebuilt. */
    if (dropped.size > 0 || index === null) await sweepFiles(kept, limits, now, dropped);
    const held = new Set(kept.map((row) => row.path));
    return candidates.filter((path) => held.has(path));
  });
}
