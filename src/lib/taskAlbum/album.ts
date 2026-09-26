import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { allowedUnder, lexicalAllowedRoots, realAllowedRoots, resolveLocal, type AllowedRoots } from "@/lib/artifact/localFile";

import type { AlbumVia } from "./extract";
import type { AlbumSeenStore } from "./seen";
import { taskAlbumTranscripts, type AlbumSource, type TaskAlbumWorld } from "./sources";
import { indexTranscripts, readInlineImage, transcriptImages, type IndexedImage } from "./transcriptIndex";

/**
 * A task's album: every picture its agents looked at, were handed or named,
 * across all its conversations and pipeline stages, newest first. A picture
 * named by path is kept only while the file exists under a root the artifact
 * route serves; one whose bytes live in the transcript is always drawable.
 */

/** The newest pictures an album holds; older ones are left out. */
export const ALBUM_MAX_IMAGES = 1000;
export const ALBUM_PAGE_DEFAULT = 60;
export const ALBUM_PAGE_MAX = 200;
/** Bytes of transcript one album read may index. */
export const ALBUM_INDEX_BUDGET = 64 * 1024 * 1024;
/** Bytes of transcript one board summary may index across all its tasks. */
export const SUMMARY_INDEX_BUDGET = 24 * 1024 * 1024;

export interface AlbumItem {
  id: string;
  /** Where the bytes load from, relative to the Viewer's own origin. */
  src: string;
  /** The file's name, or null for bytes pasted or read with no file. */
  name: string | null;
  ts: number;
  via: AlbumVia;
  source: AlbumSource;
  isNew: boolean;
}

export interface AlbumPage {
  items: AlbumItem[];
  total: number;
  nextCursor: string | null;
  /** Transcripts are still being indexed: more may appear on the next read. */
  indexing: boolean;
  lastOpenedAt: number | null;
  newCount: number;
}

export interface AlbumSummary {
  count: number;
  newCount: number;
  newestAt: number | null;
}

export interface TaskAlbumDeps {
  world: TaskAlbumWorld;
  seen: AlbumSeenStore;
}

interface Collected {
  image: IndexedImage;
  transcriptPath: string;
  source: AlbumSource;
}

const STAT_TTL_MS = 20_000;
const MAX_STAT_ENTRIES = 20_000;
const fileChecks = new Map<string, { at: number; ok: boolean }>();

/** Whether a named file exists as a regular file under a served root, both
    as written and once its links are resolved. Cached briefly: a board
    summary asks about the same files every few seconds. */
async function drawableFile(pathname: string, lexical: AllowedRoots, real: () => Promise<AllowedRoots>): Promise<boolean> {
  const cached = fileChecks.get(pathname);
  if (cached && Date.now() - cached.at < STAT_TTL_MS) return cached.ok;
  let ok = false;
  if (allowedUnder(pathname, lexical)) {
    try {
      const resolved = await fs.realpath(pathname);
      ok = allowedUnder(resolved, await real()) && (await fs.stat(resolved)).isFile();
    } catch {
      ok = false;
    }
  }
  fileChecks.delete(pathname);
  fileChecks.set(pathname, { at: Date.now(), ok });
  while (fileChecks.size > MAX_STAT_ENTRIES) fileChecks.delete(fileChecks.keys().next().value!);
  return ok;
}

export function albumImageId(key: string): string {
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
}

/** Every indexed picture of a task, one per identity at its first sighting. */
async function collect(taskId: string, deps: TaskAlbumDeps, budget: number): Promise<{ collected: Collected[]; indexing: boolean; read: number }> {
  const transcripts = taskAlbumTranscripts(taskId, deps.world);
  const { complete, read } = await indexTranscripts(transcripts.map((transcript) => transcript.path), budget);
  const byKey = new Map<string, Collected>();
  for (const transcript of transcripts) {
    for (const image of transcriptImages(transcript.path)) {
      const held = byKey.get(image.key);
      if (!held || image.ts < held.image.ts) byKey.set(image.key, { image, transcriptPath: transcript.path, source: transcript.source });
    }
  }
  return { collected: [...byKey.values()], indexing: !complete, read };
}

/** The drawable pictures, newest first, capped. */
async function drawable(taskId: string, collected: Collected[]): Promise<Array<Collected & { src: string; file: string | null }>> {
  const lexical = lexicalAllowedRoots();
  let realRoots: Promise<AllowedRoots> | null = null;
  const real = () => (realRoots ??= realAllowedRoots());
  const ordered = [...collected].sort((a, b) => b.image.ts - a.image.ts || a.image.key.localeCompare(b.image.key));
  const out: Array<Collected & { src: string; file: string | null }> = [];
  for (const entry of ordered) {
    if (out.length >= ALBUM_MAX_IMAGES) break;
    const file = entry.image.path ? resolveLocal(entry.image.path) : null;
    if (file && (await drawableFile(file, lexical, real))) {
      out.push({ ...entry, file, src: `/api/artifact?${new URLSearchParams({ path: file }).toString()}` });
    } else if (entry.image.inline) {
      out.push({ ...entry, file: null, src: `/api/tasks/${encodeURIComponent(taskId)}/album/image?id=${albumImageId(entry.image.key)}` });
    }
  }
  return out;
}

function parseCursor(cursor: string | null | undefined): number {
  const value = Number(cursor);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function clampAlbumLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return ALBUM_PAGE_DEFAULT;
  return Math.min(ALBUM_PAGE_MAX, Math.max(1, Math.floor(value)));
}

export async function readTaskAlbum(
  taskId: string,
  options: { cursor?: string | null; limit?: number; budget?: number },
  deps: TaskAlbumDeps,
): Promise<AlbumPage> {
  const { collected, indexing } = await collect(taskId, deps, options.budget ?? ALBUM_INDEX_BUDGET);
  const images = await drawable(taskId, collected);
  const lastOpenedAt = deps.seen.lastOpened(taskId);
  const isNew = (ts: number) => lastOpenedAt === null || ts > lastOpenedAt;
  const start = parseCursor(options.cursor);
  const limit = options.limit ?? ALBUM_PAGE_DEFAULT;
  const page = images.slice(start, start + limit);
  return {
    items: page.map(({ image, source, src, file }) => ({
      id: albumImageId(image.key),
      src,
      name: file ? path.basename(file) : image.path ? path.basename(image.path) : null,
      ts: image.ts,
      via: image.via,
      source,
      isNew: isNew(image.ts),
    })),
    total: images.length,
    nextCursor: start + limit < images.length ? String(start + limit) : null,
    indexing,
    lastOpenedAt,
    newCount: images.filter(({ image }) => isNew(image.ts)).length,
  };
}

export async function taskAlbumSummaries(taskIds: readonly string[], deps: TaskAlbumDeps, budget = SUMMARY_INDEX_BUDGET): Promise<Record<string, AlbumSummary>> {
  const out: Record<string, AlbumSummary> = {};
  let left = budget;
  for (const taskId of taskIds) {
    /* Each task gets what the ones before it left; a later read continues
       where this one stopped. */
    const { collected, read } = await collect(taskId, deps, Math.max(0, left));
    left -= read;
    const images = await drawable(taskId, collected);
    const lastOpenedAt = deps.seen.lastOpened(taskId);
    out[taskId] = {
      count: images.length,
      newCount: images.filter(({ image }) => lastOpenedAt === null || image.ts > lastOpenedAt).length,
      newestAt: images[0]?.image.ts ?? null,
    };
  }
  return out;
}

/** The bytes of one of a task's inline pictures, by the id its album gave it. */
export async function readTaskAlbumImage(taskId: string, imageId: string, deps: TaskAlbumDeps): Promise<{ media: string; data: Buffer } | null> {
  const { collected } = await collect(taskId, deps, ALBUM_INDEX_BUDGET);
  const entry = collected.find(({ image }) => albumImageId(image.key) === imageId);
  if (!entry?.image.inline) return null;
  return readInlineImage(entry.transcriptPath, entry.image.inline.offset, entry.image.inline.ordinal);
}
