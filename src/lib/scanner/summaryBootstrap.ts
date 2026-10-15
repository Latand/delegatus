import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { boardCursorScope } from "@/lib/boardEncoding";
import { gzipBody } from "@/lib/http/gzipBody";

/** Increment when the operator summary schema changes incompatibly. */
const VERSION = 1;
export const SUMMARY_BOOTSTRAP_FILE = "board-summary-bootstrap.bin";
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4096;
const CHUNK_BYTES = 256 * 1024;

export interface SummaryBootstrap {
  body: Uint8Array;
  gzip: Uint8Array;
  etag: string;
}
interface Manifest {
  version: number;
  scope: "operator-global-summary";
  etag: string;
  /** Absent in older artifacts, whose ETag is the body SHA-1. */
  bodyHash?: string;
  bodyBytes: number;
  gzipBytes: number;
  gzipHash: string;
}

/** Called only by the projection worker. Compression, decoding and hashing
 * stay there. One atomically replaced file binds the manifest and both bodies,
 * including when a predecessor and successor finish builds concurrently. */
export async function writeSummaryBootstrap(directory: string, body: string, etag: string, board?: { scope: string; epoch: string }): Promise<void> {
  const parsed = JSON.parse(body);
  const bodyHash = createHash("sha1").update(body).digest("hex");
  const expectedEtag = board
    ? `"${createHash("sha1").update(JSON.stringify([board.epoch, board.scope])).update(body).digest("hex")}"`
    : `"${bodyHash}"`;
  if (parsed.readProjection !== "board-summary" || parsed.systemHealth?.storage?.writes?.state !== "ok"
    || etag !== expectedEtag
    || (board && (parsed.boardProtocol !== 2 || parsed.boardScope !== boardCursorScope(board.epoch, board.scope)))) {
    throw new Error("summary bootstrap requires a healthy operator summary and its ETag");
  }
  const bytes = Buffer.from(body);
  if (bytes.length > MAX_BYTES) return;
  const gzip = await gzipBody(bytes);
  const manifest: Manifest = { version: VERSION, scope: "operator-global-summary", etag, bodyHash,
    bodyBytes: bytes.length, gzipBytes: gzip.length, gzipHash: createHash("sha256").update(gzip).digest("hex") };
  const metadata = Buffer.from(JSON.stringify(manifest));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.length);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${SUMMARY_BOOTSTRAP_FILE}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      // FileHandle.writev may write only part of a vector. writeFile consumes
      // every byte and advances the descriptor for the next part.
      for (const part of [prefix, metadata, bytes, gzip]) await handle.writeFile(part);
    } finally { await handle.close(); }
    await fs.rename(temporary, path.join(directory, SUMMARY_BOOTSTRAP_FILE));
  } finally { await fs.rm(temporary, { force: true }); }
}

function manifest(value: unknown): Manifest | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Manifest;
  return m.version === VERSION && m.scope === "operator-global-summary"
    && typeof m.etag === "string" && /^"[0-9a-f]{40}"$/.test(m.etag)
    && (m.bodyHash === undefined || (typeof m.bodyHash === "string" && /^[0-9a-f]{40}$/.test(m.bodyHash)))
    && typeof m.gzipHash === "string" && /^[0-9a-f]{64}$/.test(m.gzipHash)
    && Number.isSafeInteger(m.bodyBytes) && m.bodyBytes > 0 && m.bodyBytes <= MAX_BYTES
    && Number.isSafeInteger(m.gzipBytes) && m.gzipBytes > 0 && m.gzipBytes <= MAX_BYTES ? m : null;
}

async function readBytes(handle: FileHandle, size: number, position: number, algorithm?: string): Promise<{ bytes: Buffer; hash?: string }> {
  const bytes = Buffer.allocUnsafe(size);
  const hash = algorithm ? createHash(algorithm) : undefined;
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, Math.min(CHUNK_BYTES, size - offset), position + offset);
    if (!bytesRead) throw new Error("truncated summary bootstrap");
    hash?.update(bytes.subarray(offset, offset + bytesRead));
    offset += bytesRead;
  }
  return { bytes, hash: hash?.digest("hex") };
}

/** No body decoding, reserialization or compression on the Viewer. Hashing
 * follows bounded asynchronous reads, so validation yields between chunks.
 * Missing and incompatible caches use the ordinary first-build path. */
export async function readSummaryBootstrap(directory: string): Promise<SummaryBootstrap | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path.join(directory, SUMMARY_BOOTSTRAP_FILE), "r");
    const size = (await handle.stat()).size;
    if (size < 4 || size > 4 + MAX_MANIFEST_BYTES + 2 * MAX_BYTES) return null;
    const length = (await readBytes(handle, 4, 0)).bytes.readUInt32BE(0);
    if (!length || length > MAX_MANIFEST_BYTES) return null;
    const metadata = manifest(JSON.parse((await readBytes(handle, length, 4)).bytes.toString("utf8")));
    if (!metadata || size !== 4 + length + metadata.bodyBytes + metadata.gzipBytes) return null;
    const body = await readBytes(handle, metadata.bodyBytes, 4 + length, "sha1");
    if (body.hash !== (metadata.bodyHash ?? metadata.etag.slice(1, -1))) return null;
    const gzip = await readBytes(handle, metadata.gzipBytes, 4 + length + metadata.bodyBytes, "sha256");
    if (gzip.hash !== metadata.gzipHash) return null;
    return { body: body.bytes, gzip: gzip.bytes, etag: metadata.etag };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[board bootstrap] unusable cache; rebuilding");
    return null;
  } finally { await handle?.close(); }
}
