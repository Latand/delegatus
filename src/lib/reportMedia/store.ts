import crypto from "node:crypto";
import { realpathSync, type promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { fencedStores, inFencedStore, openAdmitted, resolveLocal } from "@/lib/artifact/localFile";
import { isEvidenceImage } from "@/lib/artifact/evidenceFormats";
import { SNIFF_BYTES, sniffAgrees } from "@/lib/artifact/serve";
import { withFileTransaction } from "@/lib/state/fileTransaction";

import { REPORT_MEDIA_FILE, reportMediaRoot, reportMediaRows, type ReportMediaRow } from "./lookup";
import { writtenPicturePaths } from "./paths";

/*
 * The report picture store. A stage report, a bridge report or a task names a
 * picture by the path it has in a lane checkout, a scratch directory or a
 * temp directory, and those are swept. When such a text is written, each
 * picture it names is copied here, and the path routes read the copy.
 *
 * What is copied is what the text names and the service can read: a raster
 * whose bytes agree with its extension, wherever it lies outside the stores
 * that answer through their own routes. The text is written by the operator
 * or by an agent the operator runs, and it is the operator who reads it.
 *
 * The store is small and temporary. One picture is at most `fileBytes`. A
 * copy named by a lane's report leaves `retentionMs` after that lane
 * finished; one that belongs to no lane leaves `retentionMs` after it was
 * last named or last seen at its own path. The whole store holds at most
 * `totalBytes`, the pictures named longest ago leaving first. A dropped
 * picture is simply missing, and the text that names it says so.
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

/** When a lane finished; null while it has not; undefined when no such lane
    is recorded, and its pictures then age as those of no lane do. */
export type LaneFinishedAt = (lane: string) => number | null | undefined;

export interface KeepOptions {
  lane?: string;
  now?: number;
  limits?: ReportMediaLimits;
  laneFinishedAt?: LaneFinishedAt;
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

/** The rows the limits keep. */
async function retained(rows: ReportMediaRow[], limits: ReportMediaLimits, now: number, laneFinishedAt: LaneFinishedAt): Promise<ReportMediaRow[]> {
  const kept: ReportMediaRow[] = [];
  const finishes = new Map<string, number | null | undefined>();
  for (const row of rows) {
    if (row.lane !== undefined && !finishes.has(row.lane)) finishes.set(row.lane, laneFinishedAt(row.lane));
    const finished = row.lane === undefined ? undefined : finishes.get(row.lane);
    if (finished === null) kept.push(row);
    else if (finished !== undefined) { if (now - finished <= limits.retentionMs) kept.push(row); }
    else if (now - Math.max(row.at, row.seenAt) <= limits.retentionMs) kept.push(row);
    /* With no lane to finish, the clock runs from the moment the picture is
       gone from its own path. */
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

/** Reads one picture through a pinned descriptor; null when the path names no
    readable raster of an allowed size, or one a fenced store holds. */
async function readPicture(abs: string, limits: ReportMediaLimits): Promise<Buffer | null> {
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) return null;
  let handle: fsp.FileHandle | undefined;
  try {
    const resolved = await fs.realpath(abs);
    const closed = [...new Set([...fencedStores(), reportMediaRoot()].flatMap((store) => [store, realOr(store)]))];
    if (!isEvidenceImage(resolved) || inFencedStore(abs, closed) || inFencedStore(resolved, closed)) return null;
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

function realOr(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Copies the pictures these texts name into the store and applies the limits.
 * A path that names no readable picture is skipped. Returns the paths now
 * kept from these texts.
 */
export async function keepReportPictures(texts: readonly (string | null | undefined)[], options: KeepOptions = {}): Promise<string[]> {
  const now = options.now ?? Date.now();
  const limits = options.limits ?? reportMediaLimits();
  const paths = reportPicturePaths(texts).slice(0, REPORT_MEDIA_PER_TEXT);
  if (paths.length === 0) return [];
  const read: Array<{ path: string; data: Buffer }> = [];
  for (const named of paths) {
    const data = await readPicture(named, limits);
    if (data) read.push({ path: named, data });
  }
  if (read.length === 0) return [];
  const laneFinishedAt = options.laneFinishedAt ?? await recordedLaneFinish();
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
      /* A lane's claim on a picture outlasts a later mention from no lane. */
      const lane = options.lane ?? rows.get(named)?.lane;
      rows.set(named, { path: named, file, bytes: data.length, at: now, seenAt: now, ...(lane ? { lane } : {}) });
    }
    const kept = await retained([...rows.values()], limits, now, laneFinishedAt);
    await saveRows(kept);
    await sweepFiles(kept);
    const held = new Set(kept.map((row) => row.path));
    return read.map((entry) => entry.path).filter((named) => held.has(named));
  });
}
