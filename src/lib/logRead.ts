import fs from "node:fs/promises";

import { MAX_CHUNK, pathAllowed } from "@/lib/scanner/roots";
import type { LogChunk } from "@/lib/types";

const NEWLINE = 0x0a;

/** The most bytes one older-history read may return. A client asks for more
    than a tail window (`MAX_CHUNK`) so a transcript full of screenshots comes
    back in a handful of reads instead of dozens; the server owns the cap. */
export const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

/** The size of an older-history read: the caller's `bytes` held between one
    tail window and `HISTORY_MAX_BYTES`, a tail window when it names none. */
export function historyReadBytes(requested: string | null): number {
  const asked = requested === null ? MAX_CHUNK : Math.floor(Number(requested));
  if (!Number.isFinite(asked)) return MAX_CHUNK;
  return Math.min(HISTORY_MAX_BYTES, Math.max(MAX_CHUNK, asked));
}
const SCAN_PIECE = 64 * 1024;

/* The absolute index of the first newline in [from, to), or null. Reads in
   small pieces so a bounded scan never allocates the whole span. */
async function firstNewline(fh: fs.FileHandle, from: number, to: number): Promise<number | null> {
  const piece = Buffer.alloc(Math.min(SCAN_PIECE, Math.max(0, to - from)));
  let at = from;
  while (at < to) {
    const { bytesRead } = await fh.read(piece, 0, Math.min(piece.length, to - at), at);
    if (bytesRead === 0) return null;
    const hit = piece.subarray(0, bytesRead).indexOf(NEWLINE);
    if (hit >= 0) return at + hit;
    at += bytesRead;
  }
  return null;
}

/* Whether `offset` begins a record: the file start, or the byte before it is
   the newline that closed the previous record. */
async function startsRecord(fh: fs.FileHandle, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const one = Buffer.alloc(1);
  const { bytesRead } = await fh.read(one, 0, 1, offset - 1);
  return bytesRead === 1 && one[0] === NEWLINE;
}

function sequenceBytes(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

/* Accept only prefixes of valid UTF-8: malformed bytes must still reach the
   ordinary replacement decoder, rather than pinning a cursor forever. */
function validPrefix(buf: Buffer, start: number, end: number): boolean {
  for (let at = start + 1; at < end; at += 1) {
    const byte = buf[at];
    if (byte < 0x80 || byte > 0xbf) return false;
    if (at === start + 1) {
      const lead = buf[start];
      if (lead === 0xe0 && byte < 0xa0 || lead === 0xed && byte > 0x9f
        || lead === 0xf0 && byte < 0x90 || lead === 0xf4 && byte > 0x8f) return false;
    }
  }
  return true;
}

/* Decode a bounded byte range with complete characters at both edges. Three
   lookbehind bytes identify a character crossing `from`; that character goes
   to the preceding history page. A trailing partial character stays on disk
   for the next forward poll, even at a temporarily incomplete append. No
   decoder state is shared between requests. */
async function readUtf8Slice(fh: fs.FileHandle, from: number, to: number): Promise<{ start: number; end: number; data: string }> {
  if (to <= from) return { start: from, end: from, data: "" };
  const readStart = Math.max(0, from - 3);
  const buf = Buffer.alloc(to - readStart);
  let length = 0;
  while (length < buf.length) {
    const { bytesRead } = await fh.read(buf, length, buf.length - length, readStart + length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  let end = length;
  for (let at = Math.max(0, length - 3); at < length; at += 1) {
    if (at + sequenceBytes(buf[at]) > length && validPrefix(buf, at, length)) {
      end = at;
      break;
    }
  }
  let start = from - readStart;
  for (let at = Math.max(0, start - 3); at < start; at += 1) {
    const after = at + sequenceBytes(buf[at]);
    if (after > start && after <= end && validPrefix(buf, at, after)) {
      start = after;
      break;
    }
  }
  if (start >= end) return { start: from, end: from, data: "" };
  return { start: readStart + start, end: readStart + end, data: buf.subarray(start, end).toString("utf-8") };
}

/** Backward history uses the same byte boundaries as forward polls. `offset`
    and `start` both name the next `before` cursor, including any character
    excluded at this page's leading edge. */
export async function readHistoryChunk(pathname: string, beforeInput: number, bytes = MAX_CHUNK, allowed: (pathname: string) => boolean = pathAllowed): Promise<LogChunk | null> {
  let stat;
  try {
    stat = await fs.stat(pathname);
  } catch {
    stat = null;
  }
  if (!pathname || !stat?.isFile() || !allowed(pathname)) return null;
  const size = stat.size;
  const before = Math.min(size, Number.isFinite(beforeInput) ? Math.max(0, beforeInput) : 0);
  const from = Math.max(0, before - bytes);
  const fh = await fs.open(pathname, "r");
  try {
    const slice = await readUtf8Slice(fh, from, before);
    if (!slice.data) return { offset: before, start: before, size, data: "" };
    return { offset: slice.start, start: slice.start, size, data: slice.data };
  } finally {
    await fh.close();
  }
}

/**
 * Forward tail read shared by /api/log and the batched /api/logs: `offset`
 * continues a poll, the very first read of a large file jumps to the last
 * MAX_CHUNK bytes. `budget` caps how many bytes this read may return — a
 * batch response splits one byte budget across many files, and a file that
 * ran out of budget gets an idle chunk at its current offset so the client
 * simply catches up on the next tick. Returns null for a path outside the
 * whitelisted roots (or one that is not a file); a route that admits more
 * than the roots passes its own `allowed`.
 *
 * The bounded catch-up only ever skips whole records (#1498). An agent
 * reading a rendered frame appends one record larger than the window — the
 * base64 sits in the transcript twice — and jumping into its middle handed
 * the client a partial line it could only drop, so the operator's feed lost
 * the picture. A record is served from its first byte however long it is,
 * and a subscriber already inside a record is handed the rest of it before
 * any jump; only a subscriber on a record boundary with ordinary records
 * behind it is jumped to the live window, as before.
 */
export async function readTailChunk(pathname: string, offsetInput: number, budget = MAX_CHUNK, allowed: (pathname: string) => boolean = pathAllowed): Promise<LogChunk | null> {
  let stat;
  try {
    stat = await fs.stat(pathname);
  } catch {
    stat = null;
  }
  if (!pathname || !stat?.isFile() || !allowed(pathname)) return null;
  const size = stat.size;

  let offset = offsetInput;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (offset > size) offset = 0;

  let want = Math.min(MAX_CHUNK, Math.max(0, budget), Math.max(0, size - offset));
  if (want === 0) return { offset, start: offset, size, data: "" };

  const fh = await fs.open(pathname, "r");
  try {
    /* A disconnected live subscriber can return with a very old offset. Bound
       every forward catch-up to the live tail window so reconnect churn cannot
       replay a multi-hundred-megabyte transcript through the Viewer event loop.
       Older feed pages remain available through the backward history route. */
    if (size - offset > MAX_CHUNK) {
      const target = size - MAX_CHUNK;
      const boundary = await firstNewline(fh, offset, Math.min(target, offset + MAX_CHUNK));
      if (boundary === null) {
        /* The record at `offset` spans the live window: serve it in sequence. */
      } else if (!(await startsRecord(fh, offset))) {
        /* The subscriber holds the head of this record: hand it the tail and
           stop at the boundary, so the partial line it carries stays whole.
           The next read starts on a record and jumps from there. */
        want = Math.min(want, boundary + 1 - offset);
      } else {
        offset = target;
        want = Math.min(MAX_CHUNK, Math.max(0, budget), size - offset);
      }
    }
    const slice = await readUtf8Slice(fh, offset, offset + want);
    return {
      offset: slice.end,
      start: slice.start,
      size,
      data: slice.data,
    };
  } finally {
    await fh.close();
  }
}
