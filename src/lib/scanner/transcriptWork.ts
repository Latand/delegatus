import fs from "node:fs";

import type { FileEntry } from "@/lib/types";
import type { TranscriptWork } from "@/lib/board/attemptWork";
import { globalCache } from "./caches";
import { TurnWindowTracker } from "./turnDuration";

/** A transcript larger than this is not read through: its working time stays unknown. */
export const TRANSCRIPT_WORK_MAX_BYTES = 128 * 1024 * 1024;
/** A single record longer than this cannot be a turn boundary (a pasted file or a tool dump); it is skipped unread. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

const cache = globalCache<[number, number, TranscriptWork]>("transcript-work-v1");

function boundaryRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Every turn window of one conversation transcript, from its first byte to the
 * size the file has when the read begins. The scan's size is a lower bound: the
 * scan snapshot is minutes old and a live agent appends every few seconds, so a
 * file that grew since the scan is read to its present size; only one smaller
 * than the scan proves nothing. Records stream through the same window rules as
 * the scanner's last-turn read; no chunk waits on the event loop for more than
 * one megabyte of parsing. Cached by the size and mtime observed at the read,
 * so a transcript that did not move is read once.
 */
export async function transcriptWork(entry: Pick<FileEntry, "path" | "root" | "size" | "mtime">): Promise<TranscriptWork> {
  const unread: TranscriptWork = { windows: [], lastRecordAt: null, complete: false };
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl") || entry.size > TRANSCRIPT_WORK_MAX_BYTES) return unread;
  const tracker = new TurnWindowTracker(entry.root === "codex-sessions");
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(entry.path, "r");
    const before = await handle.stat();
    // The scan's size is a lower bound: a file that shrank or was replaced is unread, one that grew is read to its size now.
    if (!before.isFile() || before.size < entry.size || before.size > TRANSCRIPT_WORK_MAX_BYTES) return unread;
    const size = before.size;
    const cached = cache.get(entry.path);
    if (cached?.[0] === size && cached[1] === before.mtimeMs) return cached[2];
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const decoder = new TextDecoder("utf-8");
    let position = 0, rest = "", skipping = false;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, size - position), position);
      if (bytesRead === 0) return unread;
      position += bytesRead;
      rest += decoder.decode(buffer.subarray(0, bytesRead), { stream: position < size });
      let from = 0, newline = rest.indexOf("\n");
      while (newline >= 0) {
        const line = rest.slice(from, newline);
        from = newline + 1;
        if (skipping) skipping = false;
        else if (line.length <= MAX_LINE_CHARS && line.trim()) {
          const record = boundaryRecord(line);
          if (record) tracker.push(record);
        }
        newline = rest.indexOf("\n", from);
      }
      rest = rest.slice(from);
      if (rest.length > MAX_LINE_CHARS) { rest = ""; skipping = true; }
    }
    if (!skipping && rest.trim() && rest.length <= MAX_LINE_CHARS) {
      const record = boundaryRecord(rest);
      if (record) tracker.push(record);
    }
    const after = await handle.stat();
    // A file that shrank or was replaced mid-read proves nothing; one that only grew is the same transcript up to the size read.
    if (after.size < size) return unread;
    const result: TranscriptWork = {
      windows: tracker.finish().map(window => [window.startedAt, window.endedAt] as const),
      lastRecordAt: tracker.latestTimestamp,
      complete: true,
    };
    cache.set(entry.path, [size, before.mtimeMs, result]);
    return result;
  } catch {
    return unread;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The work of each requested identity (conversation id or transcript path) among the files the caller may see; null for one that resolves to nothing. */
export async function transcriptWorkFor(files: readonly FileEntry[], identities: readonly string[]): Promise<Record<string, TranscriptWork | null>> {
  const byIdentity = new Map<string, FileEntry>();
  for (const file of files) {
    for (const identity of [file.conversationId, file.path]) if (identity && !byIdentity.has(identity)) byIdentity.set(identity, file);
  }
  const answer: Record<string, TranscriptWork | null> = {};
  const settled = new Map<string, TranscriptWork>();
  for (const identity of identities) {
    const file = byIdentity.get(identity);
    if (!file) { answer[identity] = null; continue; }
    let work = settled.get(file.path);
    if (!work) { work = await transcriptWork(file); settled.set(file.path, work); }
    answer[identity] = work;
  }
  return answer;
}
