import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { link, mkdir, open, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";

import { statePath } from "@/lib/configDir";
import { structuredUserReference, structuredUserReferenceKey } from "@/lib/runtime/codexStructuredUserText";
import { parseMessageOrigin, type MessageOrigin, type DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { parseSelectedContextRef, type SelectedContextRef } from "./selectedContext";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { withFileTransaction } from "@/lib/state/fileTransaction";

export interface StructuredUserMetadata {
  version: 1;
  contentDigest: string | null;
  selectedContext: SelectedContextRef | null;
  origin: MessageOrigin | null;
  deliveryDedup?: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 16_384;

function directory(): string {
  return statePath("structured-user-metadata");
}

function validateReferences(refs: string[]): void {
  if (!Array.isArray(refs) || refs.length > 100 || refs.some((ref) => typeof ref !== "string" || !structuredUserReferenceKey(ref))) {
    throw new Error("invalid structured-user reference batch");
  }
}

function provenance(metadata: StructuredUserMetadata): DeliveredMessageProvenance {
  return {
    origin: metadata.origin?.kind ?? "operator",
    ...(metadata.origin?.kind === "operator" && metadata.origin.channel ? { channel: metadata.origin.channel } : {}),
    ...(metadata.origin?.role ? { senderRole: metadata.origin.role } : {}),
    ...(metadata.origin?.project ? { senderProject: metadata.origin.project } : {}),
    ...(metadata.origin?.conversationId ? { senderConversationId: metadata.origin.conversationId } : {}),
    ...(metadata.selectedContext ? { selectedContext: metadata.selectedContext } : {}),
  };
}

export function readStructuredUserProvenance(refs: string[]): Record<string, DeliveredMessageProvenance | null> {
  validateReferences(refs);
  return Object.fromEntries(refs.map((ref) => {
    try {
      return [ref, provenance(readStructuredUserMetadata(ref))];
    } catch { return [ref, null]; }
  }));
}

/** Sequential, bounded reads keep disk work off the request loop. */
export async function readStructuredUserProvenanceAsync(refs: string[]): Promise<Record<string, DeliveredMessageProvenance | null>> {
  validateReferences(refs);
  const result: Record<string, DeliveredMessageProvenance | null> = {};
  for (const ref of refs) {
    try { result[ref] = provenance(validateRecord(ref, await readRecordBody(filename(ref)))); }
    catch { result[ref] = null; }
  }
  return result;
}

async function readRecordBody(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > MAX_RECORD_BYTES) throw new Error("oversized record");
    return buffer.toString("utf8", 0, bytes);
  } finally { await file.close(); }
}

function filename(ref: string): string {
  const key = structuredUserReferenceKey(ref);
  if (!key) throw new Error("invalid structured-user metadata reference");
  const fingerprint = ref.split(".")[2];
  return join(directory(), `${ref[0]}-${key}${fingerprint ? `-${fingerprint}` : ""}.json`);
}

export function readStructuredUserMetadata(ref: string): StructuredUserMetadata {
  try {
    const path = filename(ref);
    if (statSync(path).size > MAX_RECORD_BYTES) throw new Error("oversized record");
    return validateRecord(ref, readFileSync(path, "utf8"));
  } catch {
    throw new Error("structured-user metadata reference is unavailable; the delivery context cannot be recovered");
  }
}

function validateRecord(ref: string, body: string): StructuredUserMetadata {
  const value = JSON.parse(body);
  const selectedContext = value.selectedContext === null ? null : parseSelectedContextRef(value.selectedContext);
  const origin = value.origin === null ? null : parseMessageOrigin(value.origin);
  if (value.version !== 1 || (value.selectedContext !== null && !selectedContext)
    || (value.origin !== null && !origin)
    || (value.contentDigest !== null && (typeof value.contentDigest !== "string" || !SHA256.test(value.contentDigest)))
    || (!ref.startsWith("h.") ? value.deliveryDedup !== structuredUserReferenceKey(ref) : value.deliveryDedup !== undefined)) {
    throw new Error("invalid record");
  }
  const record: StructuredUserMetadata = { version: 1, contentDigest: value.contentDigest, selectedContext, origin,
    ...(value.deliveryDedup ? { deliveryDedup: value.deliveryDedup } : {}) };
  if ((ref.startsWith("h.") || ref.split(".").length === 3) && metadataReference(record) !== ref) throw new Error("record mismatch");
  return record;
}

function metadataReference(record: StructuredUserMetadata): string {
  const hash = createHash("sha256").update(JSON.stringify(record)).digest();
  if (!record.deliveryDedup) return structuredUserReference(hash.toString("hex"), false);
  const origin = record.origin?.kind === "operator" ? "o" : record.origin?.kind === "agent" ? "a" : "d";
  // Delivery ids are recipient-scoped. Bind the shared record to its metadata
  // as well, while retaining the entire delivery hash for existing joins.
  // A 96-bit fingerprint keeps the line at 95 characters; immutable publication
  // and the body comparison below refuse a fingerprint collision.
  return `${origin}.${structuredUserReference(record.deliveryDedup, true).slice(2)}.${hash.toString("base64url").slice(0, 16)}`;
}

/** Immutable, durable-before-send publication. A retry may reuse identical
 * metadata, but cannot replace the selected card or image digest of a handle.
 * Files live in the shared state volume, independent of checkout and process. */
export async function persistStructuredUserMetadata(record: StructuredUserMetadata): Promise<string> {
  // Snapshot before the first await: caller mutation cannot change the bytes
  // associated with this immutable delivery identity.
  const ref = metadataReference(record);
  const path = filename(ref);
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES) throw new Error("structured-user metadata is too large");
  const parentPath = directory();
  return withViewerOperation("structured-user.publish", async () => {
    await mkdir(parentPath, { recursive: true, mode: 0o700 });
    return withFileTransaction(join(parentPath, "..", "structured-user-metadata-publication"), "structured-user publication is busy", async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      const fd = await open(temporary, "wx", 0o600);
      try {
        try {
          await fd.writeFile(body);
          await fd.sync();
        } finally { await fd.close(); }
        try { await link(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally { await unlink(temporary); }
      if (await readRecordBody(path) !== body) {
        throw new Error("structured-user delivery identity belongs to different metadata");
      }
      // Reuse renews the collection grace period, including retries after restart.
      const now = new Date();
      await utimes(path, now, now);
      const published = await open(path, "r");
      try { await published.sync(); } finally { await published.close(); }
      const parent = await open(parentPath, "r");
      try { await parent.sync(); } finally { await parent.close(); }
      return ref;
    });
  });
}
