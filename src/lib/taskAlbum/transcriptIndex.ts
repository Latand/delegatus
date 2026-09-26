import fs from "node:fs/promises";

import { extractLineImages, inlineImageAt, lineMayHoldImage, lineTimestamp, type AlbumVia, type PendingReads } from "./extract";

/**
 * The pictures of every transcript a task's album has read, kept per
 * transcript and advanced incrementally: each read picks up at the byte after
 * the last complete line it indexed, so opening an album again reads only what
 * was appended since. A transcript that shrank or was replaced (another inode)
 * is indexed again from the start.
 *
 * Work is bounded twice: every call carries a byte budget shared by all the
 * transcripts it touches (a long cold transcript is finished over several
 * opens, and the answer says it is still indexing), and the process keeps a
 * bounded number of transcripts, least recently used first out. Only the
 * pictures' identities are kept — never their bytes; an inline picture is read
 * back from its line when it is shown.
 */

export interface IndexedImage {
  key: string;
  via: AlbumVia;
  /** When the transcript first carried it, in ms. */
  ts: number;
  path?: string;
  inline?: { offset: number; ordinal: number; media: string; bytes: number };
}

interface TranscriptState {
  dev: number;
  ino: number;
  /** Byte just past the last complete line indexed. */
  offset: number;
  size: number;
  reads: PendingReads;
  images: IndexedImage[];
  keys: Set<string>;
  /** The newest timestamp seen, for a line that carries none. */
  lastTs: number;
}

const MAX_TRANSCRIPTS = 4000;
const MAX_IMAGES_PER_TRANSCRIPT = 2000;
const CHUNK_BYTES = 1024 * 1024;
/** A line longer than this is skipped unread; no picture record is that large. */
const MAX_LINE_BYTES = 48 * 1024 * 1024;

const states = new Map<string, TranscriptState>();

function remember(path: string, state: TranscriptState): void {
  states.delete(path);
  states.set(path, state);
  while (states.size > MAX_TRANSCRIPTS) states.delete(states.keys().next().value!);
}

function fresh(dev: number, ino: number, mtimeMs: number): TranscriptState {
  return { dev, ino, offset: 0, size: 0, reads: new Map(), images: [], keys: new Set(), lastTs: mtimeMs };
}

function indexLine(state: TranscriptState, text: string, offset: number): void {
  if (!lineMayHoldImage(text)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const ts = lineTimestamp(parsed as Record<string, unknown>) ?? state.lastTs;
  state.lastTs = Math.max(state.lastTs, ts);
  for (const image of extractLineImages(parsed, state.reads)) {
    if (state.keys.has(image.key) || state.images.length >= MAX_IMAGES_PER_TRANSCRIPT) continue;
    state.keys.add(image.key);
    state.images.push({
      key: image.key,
      via: image.via,
      ts,
      ...(image.path ? { path: image.path } : {}),
      ...(image.inline ? { inline: { offset, ...image.inline } } : {}),
    });
  }
}

/**
 * Advances one transcript's index by at most `budget` bytes and answers how
 * many bytes it read. `complete` is false while bytes remain.
 */
async function advance(path: string, budget: number): Promise<{ read: number; complete: boolean }> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    states.delete(path);
    return { read: 0, complete: true };
  }
  let state = states.get(path);
  if (!state || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.offset) state = fresh(stat.dev, stat.ino, stat.mtimeMs);
  remember(path, state);
  state.size = stat.size;
  if (state.offset >= stat.size) return { read: 0, complete: true };
  if (budget <= 0) return { read: 0, complete: false };

  let handle;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return { read: 0, complete: true };
  }
  let read = 0;
  let reachedEnd = false;
  try {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let lineStart = state.offset;
    let position = state.offset;
    let skipping = false;
    /* A line still being read when the budget runs out is finished, so an
       oversized record never pins the index in place; nothing after it is. */
    let stopped = false;
    while (!stopped && position < stat.size && (read < budget || pendingBytes > 0 || skipping)) {
      const want = Math.min(CHUNK_BYTES, stat.size - position, read < budget ? budget - read : CHUNK_BYTES);
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (bytesRead <= 0) break;
      read += bytesRead;
      let cursor = 0;
      const view = chunk.subarray(0, bytesRead);
      for (let newline = view.indexOf(10, cursor); newline !== -1; newline = view.indexOf(10, cursor)) {
        if (!skipping) {
          const tail = view.subarray(cursor, newline);
          const line = pendingBytes ? Buffer.concat([...pending, tail]) : tail;
          indexLine(state, line.toString("utf8"), lineStart);
        }
        pending = [];
        pendingBytes = 0;
        skipping = false;
        lineStart = position + newline + 1;
        state.offset = lineStart;
        cursor = newline + 1;
        if (read >= budget) {
          stopped = true;
          break;
        }
      }
      if (!stopped && cursor < view.length && !skipping) {
        pending.push(view.subarray(cursor));
        pendingBytes += view.length - cursor;
        if (pendingBytes > MAX_LINE_BYTES) {
          pending = [];
          pendingBytes = 0;
          skipping = true;
        }
      }
      position += bytesRead;
    }
    /* A last line with no newline yet is a record still being written: the
       offset stays before it and the next read takes it whole. */
    reachedEnd = state.offset >= stat.size || (!stopped && position >= stat.size);
  } finally {
    await handle.close();
  }
  return { read, complete: reachedEnd };
}

export interface IndexProgress {
  complete: boolean;
  /** Bytes this call read. */
  read: number;
}

/** Advances every transcript in turn under one shared byte budget. */
export async function indexTranscripts(paths: readonly string[], budget: number): Promise<IndexProgress> {
  let left = budget;
  let complete = true;
  for (const path of paths) {
    const { read, complete: done } = await advance(path, left);
    left -= read;
    if (!done) complete = false;
  }
  return { complete, read: budget - left };
}

/** The pictures indexed so far for a transcript, oldest first. */
export function transcriptImages(path: string): readonly IndexedImage[] {
  return states.get(path)?.images ?? [];
}

/** The bytes of an inline picture, read back from its line. */
export async function readInlineImage(path: string, offset: number, ordinal: number): Promise<{ media: string; data: Buffer } | null> {
  let handle;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return null;
  }
  try {
    const parts: Buffer[] = [];
    let total = 0;
    let position = offset;
    for (;;) {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
      if (bytesRead <= 0) break;
      const view = chunk.subarray(0, bytesRead);
      const newline = view.indexOf(10);
      parts.push(newline === -1 ? view : view.subarray(0, newline));
      total += newline === -1 ? bytesRead : newline;
      if (newline !== -1 || total > MAX_LINE_BYTES) break;
      position += bytesRead;
    }
    if (total > MAX_LINE_BYTES) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      return null;
    }
    const image = inlineImageAt(parsed, ordinal);
    return image ? { media: image.media, data: Buffer.from(image.data, "base64") } : null;
  } finally {
    await handle.close();
  }
}

/** Test seam: forget every transcript. */
export function resetTranscriptIndex(): void {
  states.clear();
}
