import { open } from "node:fs/promises";

import { globalCache } from "@/lib/scanner/caches";

import { type ChatPullRequests, chatPullRequestForUrl, MAX_CHAT_PULL_REQUESTS } from "./chatPullRequests";
import type { ForgeCacheView } from "./workLinks";

const MAX_NATIVE_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_LINK_RECORD_BYTES = 4096;
const MAX_CACHED_FILES = 128;
const EMPTY = Buffer.alloc(0);
const MARKER = Buffer.from('"pr-link"');

type NativeLinks = { urls: string[]; partial: boolean };
const reads = globalCache<{ identity: string; result: Promise<NativeLinks> }>("chat-native-pr-links");

async function scanLinks(file: Awaited<ReturnType<typeof open>>, size: number): Promise<NativeLinks> {
  const start = Math.max(0, size - MAX_NATIVE_BYTES);
  const urls = new Set<string>();
  let remainder: Buffer | null = start ? null : EMPTY;
  let overLimit = false;
  const accept = (line: Buffer) => {
    if (!line.includes(MARKER)) return;
    try {
      const record = JSON.parse(line.toString("utf8"));
      if (record?.type !== "pr-link" || typeof record.prUrl !== "string") return;
      // Keep the last occurrence of each native attachment in file order.
      urls.delete(record.prUrl);
      urls.add(record.prUrl);
      if (urls.size > MAX_CHAT_PULL_REQUESTS) {
        urls.delete(urls.values().next().value!);
        overLimit = true;
      }
    } catch { /* A growing transcript can contain an unfinished line. */ }
  };

  if (start < size) {
    for await (const chunk of file.createReadStream({
      start, end: size - 1, highWaterMark: CHUNK_BYTES, autoClose: false,
    })) {
      const bytes: Buffer = chunk;
      let lineStart = 0;
      for (let lf = bytes.indexOf(10); lf !== -1; lf = bytes.indexOf(10, lineStart)) {
        const length = lf - lineStart;
        if (remainder && remainder.length + length <= MAX_LINK_RECORD_BYTES) {
          const line = bytes.subarray(lineStart, lf);
          accept(remainder.length ? Buffer.concat([remainder, line]) : line);
        }
        remainder = EMPTY;
        lineStart = lf + 1;
      }
      const tail = bytes.subarray(lineStart);
      remainder = remainder && remainder.length + tail.length <= MAX_LINK_RECORD_BYTES
        ? Buffer.concat([remainder, tail]) : null;
    }
    if (remainder?.length) accept(remainder);
  }
  return { urls: [...urls].reverse(), partial: start > 0 || overLimit };
}

/** Read native link records only after the caller authorizes the transcript.
 * Async I/O and bounded per-line storage keep large transcripts off the request
 * thread's synchronous read path. Concurrent readers share the same scan. */
export async function readNativeChatPullRequests(path: string, forge: ForgeCacheView): Promise<ChatPullRequests | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const identity = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    let read = reads.get(path);
    if (read?.identity !== identity) {
      const result = scanLinks(file, stat.size).catch(error => {
        if (reads.get(path)?.result === result) reads.delete(path);
        throw error;
      });
      read = { identity, result };
      reads.delete(path);
      reads.set(path, read);
      if (reads.size > MAX_CACHED_FILES) reads.delete(reads.keys().next().value!);
    }
    const { urls, partial } = await read.result;
    const unique = new Map<string, ChatPullRequests["items"][number]>();
    for (const url of urls) {
      const pr = chatPullRequestForUrl(url, forge);
      if (pr && !unique.has(pr.url)) unique.set(pr.url, pr);
    }
    return { items: [...unique.values()], partial };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}
