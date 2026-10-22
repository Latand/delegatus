import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "./configDir";
import { attachmentMegabytes, isComposerUploadRef, MAX_INBOX_FILE_BYTES, type ComposerUploadRef } from "./filePolicy";
import type { TeamActor } from "./team/contract";

// Uploads are private staging artifacts. Only the message admission links a
// completed body into the inbox. These bounds survive a Viewer restart.
const MAX_UPLOADS = 128;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const DEADLINE_MS = 15 * 60 * 1000;
const active = new Set<string>();

export class ComposerUploadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const composerUploadsDir = () => statePath("composer-uploads");
export function composerUploadOwner(actor: TeamActor): string {
  if (actor.kind === "member") return `member:${actor.memberId}`;
  if (actor.kind === "agent") return `agent:${actor.conversationId}`;
  if (actor.kind === "operator") return "operator";
  if (actor.kind === "service") return `service:${actor.service}`;
  throw new ComposerUploadError("sign in before attaching a file", 401);
}
export interface StoredComposerUpload extends ComposerUploadRef {
  path: string;
}

async function uploadEntries(root: string): Promise<string[]> {
  const directory = await fs.opendir(root);
  const entries: string[] = [];
  for await (const entry of directory) {
    entries.push(entry.name);
    if (entries.length > MAX_UPLOADS) break;
  }
  return entries;
}

async function reserveUpload(): Promise<{ id: string; directory: string }> {
  const root = composerUploadsDir();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await uploadEntries(root);
  // Refuse an unexpected oversized store instead of doing an unbounded sweep.
  if (entries.length > MAX_UPLOADS) throw new ComposerUploadError("upload staging is full; retry after older uploads expire", 503);
  const cutoff = Date.now() - RETAIN_MS;
  for (const entry of entries) {
    if (!/^[a-f0-9]{32}$/.test(entry)) continue;
    const directory = path.join(root, entry);
    if (active.has(directory)) continue;
    const stat = await fs.lstat(directory).catch(() => null);
    if (stat?.isDirectory() && stat.mtimeMs < cutoff) await fs.rm(directory, { recursive: true, force: true });
  }
  const id = crypto.randomUUID().replaceAll("-", "");
  const directory = path.join(root, id);
  await fs.mkdir(directory, { mode: 0o700 });
  active.add(directory);
  try {
    // Counting after the atomic reservation also bounds concurrent writers.
    if ((await uploadEntries(root)).length > MAX_UPLOADS) {
      throw new ComposerUploadError("upload staging is full; retry after older uploads expire", 503);
    }
    return { id, directory };
  } catch (error) {
    active.delete(directory);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function receiveComposerUpload(
  body: ReadableStream<Uint8Array>,
  owner: string,
  options: { expectedBytes?: number; signal?: AbortSignal; authorize?: () => void } = {},
): Promise<ComposerUploadRef> {
  const signal = AbortSignal.any([AbortSignal.timeout(DEADLINE_MS), ...(options.signal ? [options.signal] : [])]);
  const reader = body.getReader();
  let reservation: Awaited<ReturnType<typeof reserveUpload>>;
  try { reservation = await reserveUpload(); }
  catch (error) { await reader.cancel(error).catch(() => {}); reader.releaseLock(); throw error; }
  const { id, directory } = reservation;
  const partial = path.join(directory, "body.partial");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let cancelled: Promise<void> | undefined;
  const abort = () => { cancelled = reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  const digest = crypto.createHash("sha256");
  try {
    options.authorize?.();
    signal.throwIfAborted();
    if (options.expectedBytes !== undefined && (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 1)) {
      throw new ComposerUploadError("attachment is empty or its length is invalid");
    }
    if ((options.expectedBytes ?? 0) > MAX_INBOX_FILE_BYTES) {
      throw new ComposerUploadError(`attachment is too large (${attachmentMegabytes(MAX_INBOX_FILE_BYTES)} MB limit)`, 413);
    }
    handle = await fs.open(partial, "wx", 0o600);
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      options.authorize?.();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_INBOX_FILE_BYTES) throw new ComposerUploadError(`attachment is too large (${attachmentMegabytes(MAX_INBOX_FILE_BYTES)} MB limit)`, 413);
      // Bound synchronous hashing and await every disk write before reading
      // more. A network chunk can itself be larger than this working slice.
      for (let offset = 0; offset < part.value.length; offset += 256 * 1024) {
        const chunk = part.value.subarray(offset, offset + 256 * 1024);
        digest.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(chunk, written, chunk.length - written);
          signal.throwIfAborted();
          options.authorize?.();
          if (!result.bytesWritten) throw new Error("attachment write made no progress");
          written += result.bytesWritten;
        }
      }
    }
    if (!bytes || options.expectedBytes !== undefined && bytes !== options.expectedBytes) throw new ComposerUploadError("attachment upload was incomplete");
    await handle.sync();
    await handle.close(); handle = undefined;
    signal.throwIfAborted(); options.authorize?.();
    const ref = { id, bytes, sha256: digest.digest("hex") };
    await fs.rename(partial, path.join(directory, "body"));
    signal.throwIfAborted(); options.authorize?.();
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...ref, owner, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
    signal.throwIfAborted(); options.authorize?.();
    return ref;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await handle?.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await cancelled;
    reader.releaseLock();
    active.delete(directory);
  }
}

export async function resolveComposerUpload(value: unknown, owner: string): Promise<StoredComposerUpload> {
  if (!isComposerUploadRef(value)) throw new ComposerUploadError("invalid attachment upload reference");
  const directory = path.join(composerUploadsDir(), value.id);
  const manifest = path.join(directory, "manifest.json");
  const info = await fs.lstat(manifest);
  if (!info.isFile() || info.size > 2048) throw new ComposerUploadError("invalid attachment upload manifest");
  const record = JSON.parse(await fs.readFile(manifest, "utf8"));
  if (record.id !== value.id || record.bytes !== value.bytes || record.sha256 !== value.sha256 || record.owner !== owner
    || !Number.isFinite(record.createdAt) || Date.now() - record.createdAt > RETAIN_MS) {
    throw new ComposerUploadError("attachment upload is unavailable; attach the file again");
  }
  const filePath = path.join(directory, "body");
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.size !== value.bytes) throw new ComposerUploadError("attachment upload is incomplete");
  return { ...value, path: filePath };
}
