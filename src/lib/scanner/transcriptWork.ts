import fs from "node:fs";

import type { FileEntry } from "@/lib/types";
import type { TranscriptWork } from "@/lib/board/attemptWork";
import { globalCache } from "./caches";
import { TurnWindowTracker } from "./turnDuration";

/** A transcript larger than this is not read through: its working time stays unknown. */
export const TRANSCRIPT_WORK_MAX_BYTES = 128 * 1024 * 1024;
/** A single record longer than this cannot be a turn boundary (a pasted file or a tool dump); it is skipped unread. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
/** The bytes before a resume point that must still match for a grown file to count as the same transcript. */
const TAIL_CHECK_BYTES = 4096;
const CACHE_ENTRIES = 64;

/** What a read left behind: the tracker holds every complete line up to `offset`, so a file that only grew resumes from there. */
interface ReadState {
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  offset: number;
  skipping: boolean;
  tracker: TurnWindowTracker;
  tail: Buffer;
  result: TranscriptWork;
}

const cache = globalCache<ReadState>("transcript-work-v2", state => 512 + state.tail.length + state.result.windows.length * 96);
const inflight = new Map<string, Promise<TranscriptWork>>();

/** Bytes parsed by transcript reads since the process started: a re-ask of a grown file adds only what it appended. */
export const transcriptWorkRead = { bytes: 0 };

function boundaryRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pushLine(tracker: TurnWindowTracker, bytes: Buffer): void {
  if (bytes.length > MAX_LINE_BYTES) return;
  const line = bytes.toString("utf8");
  if (!line.trim()) return;
  const record = boundaryRecord(line);
  if (record) tracker.push(record);
}

async function readBytes(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) return null;
    filled += bytesRead;
  }
  return buffer;
}

/**
 * Every turn window of one conversation transcript, from its first byte to the
 * size the file has when the read begins. The scan's size is a lower bound: the
 * scan snapshot is minutes old and a live agent appends every few seconds, so a
 * file that grew since the scan is read to its present size; only one smaller
 * than the scan proves nothing. Records stream through the same window rules as
 * the scanner's last-turn read; no chunk waits on the event loop for more than
 * one megabyte of parsing.
 *
 * A read keeps its tracker and the byte offset after its last complete line. A
 * file that kept its identity and only grew resumes from there, so the re-ask
 * of a running attempt parses what was appended and nothing before it; the
 * bytes ahead of the offset must still match what was read, or the file is read
 * again from its start. Concurrent asks for one file share one read.
 */
export function transcriptWork(entry: Pick<FileEntry, "path" | "root" | "size" | "mtime">): Promise<TranscriptWork> {
  const key = `${entry.path}\0${entry.size}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = readTranscriptWork(entry).finally(() => { inflight.delete(key); });
    inflight.set(key, pending);
  }
  return pending;
}

async function readTranscriptWork(entry: Pick<FileEntry, "path" | "root" | "size" | "mtime">): Promise<TranscriptWork> {
  const unread: TranscriptWork = { windows: [], lastRecordAt: null, complete: false };
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl") || entry.size > TRANSCRIPT_WORK_MAX_BYTES) return unread;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(entry.path, "r");
    const before = await handle.stat();
    // The scan's size is a lower bound: a file that shrank or was replaced is unread, one that grew is read to its size now.
    if (!before.isFile() || before.size < entry.size || before.size > TRANSCRIPT_WORK_MAX_BYTES) return unread;
    const size = before.size;
    const cached = cache.get(entry.path);
    if (cached && cached.size === size && cached.mtimeMs === before.mtimeMs && cached.ino === before.ino && cached.dev === before.dev) return cached.result;
    const sameFile = !!cached && cached.ino === before.ino && cached.dev === before.dev && cached.size < size && cached.offset <= size;
    const resumeFrom = cached && sameFile
      && (cached.tail.length === 0 || (await readBytes(handle, cached.offset - cached.tail.length, cached.tail.length))?.equals(cached.tail) === true) ? cached : null;
    const tracker = resumeFrom ? resumeFrom.tracker.clone() : new TurnWindowTracker(entry.root === "codex-sessions");
    let consumed = resumeFrom?.offset ?? 0, skipping = resumeFrom?.skipping ?? false;
    let position = consumed, carry: Buffer = Buffer.alloc(0);
    const buffer = Buffer.alloc(CHUNK_BYTES);
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, size - position), position);
      if (bytesRead === 0) return unread;
      position += bytesRead;
      transcriptWorkRead.bytes += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let from = 0, newline = data.indexOf(10);
      while (newline >= 0) {
        if (skipping) skipping = false;
        else pushLine(tracker, data.subarray(from, newline));
        from = newline + 1;
        newline = data.indexOf(10, from);
      }
      consumed += from;
      carry = Buffer.from(data.subarray(from));
      if (carry.length > MAX_LINE_BYTES) { consumed += carry.length; carry = Buffer.alloc(0); skipping = true; }
    }
    const after = await handle.stat();
    // A file that shrank or was replaced mid-read proves nothing; one that only grew is the same transcript up to the size read.
    if (after.size < size) return unread;
    // A last line without its newline may still be growing: it counts toward this answer, never toward the state a later read resumes from.
    const answering = carry.length && !skipping ? tracker.clone() : tracker;
    if (answering !== tracker) pushLine(answering, carry);
    const result: TranscriptWork = {
      windows: answering.finish().map(window => [window.startedAt, window.endedAt] as const),
      lastRecordAt: answering.latestTimestamp,
      complete: true,
    };
    const tailLength = Math.min(TAIL_CHECK_BYTES, consumed);
    const tail = tailLength ? await readBytes(handle, consumed - tailLength, tailLength) : Buffer.alloc(0);
    if (!tail) return unread;
    cache.delete(entry.path);
    cache.set(entry.path, { size, mtimeMs: before.mtimeMs, ino: before.ino, dev: before.dev, offset: consumed, skipping, tracker, tail, result });
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    return result;
  } catch {
    return unread;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The turn time of a whole conversation: every generation of it (an archived
 * predecessor and its successor after an account migration share the
 * conversation id, and each is its own transcript) read and unioned. A
 * successor that copies history keeps the original timestamps, so overlapping
 * windows count once. An open window of an older generation ends at that
 * generation's own last record; only the newest generation can still be
 * working. One generation that cannot be read leaves the whole answer unread.
 */
export function combineTranscriptWork(works: readonly TranscriptWork[]): TranscriptWork {
  if (works.length === 1) return works[0]!;
  if (!works.length || works.some(work => !work.complete)) return { windows: [], lastRecordAt: null, complete: false };
  const lastRecordAt = works.reduce<number | null>((newest, work) => work.lastRecordAt === null ? newest : Math.max(newest ?? -Infinity, work.lastRecordAt), null);
  const windows: Array<[number, number | null]> = [];
  for (const work of works) {
    const newest = work.lastRecordAt === lastRecordAt;
    for (const [start, end] of work.windows) {
      const closed = end ?? (newest ? null : work.lastRecordAt);
      if (end === null && !newest && closed === null) continue;
      windows.push([start, closed]);
    }
  }
  windows.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number | null]> = [];
  for (const [start, end] of windows) {
    const last = merged.at(-1);
    if (last && (last[1] === null || start <= last[1])) last[1] = last[1] === null || end === null ? null : Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return { windows: merged, lastRecordAt, complete: true };
}

/** The transcripts of one conversation among the files the caller may see: those sharing its id, and those its migration links name. */
function generationsOf(seed: FileEntry, byConversation: ReadonlyMap<string, readonly FileEntry[]>, byPath: ReadonlyMap<string, FileEntry>): { files: FileEntry[]; linksResolved: boolean } {
  const files = new Map<string, FileEntry>();
  const queue = [seed];
  let linksResolved = true;
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file.path)) continue;
    files.set(file.path, file);
    if (file.conversationId) queue.push(...(byConversation.get(file.conversationId) ?? []));
    for (const link of [file.predecessorPath, file.migratedTo]) {
      if (!link) continue;
      const linked = byPath.get(link);
      if (linked) queue.push(linked);
      else linksResolved = false;
    }
  }
  return { files: [...files.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0), linksResolved };
}

/** The work of each requested identity (conversation id or transcript path) among the files the caller may see; null for one that resolves to nothing. */
export async function transcriptWorkFor(files: readonly FileEntry[], identities: readonly string[]): Promise<Record<string, TranscriptWork | null>> {
  const byIdentity = new Map<string, FileEntry>();
  const byConversation = new Map<string, FileEntry[]>();
  const byPath = new Map<string, FileEntry>();
  for (const file of files) {
    byPath.set(file.path, file);
    if (file.conversationId) byConversation.set(file.conversationId, [...(byConversation.get(file.conversationId) ?? []), file]);
    for (const identity of [file.conversationId, file.path]) if (identity && !byIdentity.has(identity)) byIdentity.set(identity, file);
  }
  const answer: Record<string, TranscriptWork | null> = {};
  const settled = new Map<string, TranscriptWork>();
  for (const identity of identities) {
    const seed = byIdentity.get(identity);
    if (!seed) { answer[identity] = null; continue; }
    const generations = generationsOf(seed, byConversation, byPath);
    const key = generations.files.map(file => file.path).join("\0");
    let work = settled.get(key);
    if (!work) {
      const reads: TranscriptWork[] = [];
      for (const file of generations.files) reads.push(await transcriptWork(file));
      work = generations.linksResolved ? combineTranscriptWork(reads) : { windows: [], lastRecordAt: null, complete: false };
      settled.set(key, work);
    }
    answer[identity] = work;
  }
  return answer;
}
