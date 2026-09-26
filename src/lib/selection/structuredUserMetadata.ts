import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { statePath } from "@/lib/configDir";
import { structuredUserReference, structuredUserReferenceKey } from "@/lib/runtime/codexStructuredUserText";
import { parseMessageOrigin, type MessageOrigin, type DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { parseSelectedContextRef, type SelectedContextRef } from "./selectedContext";

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

export function readStructuredUserProvenance(refs: string[]): Record<string, DeliveredMessageProvenance | null> {
  if (!Array.isArray(refs) || refs.length > 100 || refs.some((ref) => typeof ref !== "string" || !structuredUserReferenceKey(ref))) {
    throw new Error("invalid structured-user reference batch");
  }
  return Object.fromEntries(refs.map((ref) => {
    try {
      const metadata = readStructuredUserMetadata(ref);
      return [ref, {
        origin: metadata.origin?.kind ?? "operator",
        ...(metadata.origin?.role ? { senderRole: metadata.origin.role } : {}),
        ...(metadata.origin?.project ? { senderProject: metadata.origin.project } : {}),
        ...(metadata.origin?.conversationId ? { senderConversationId: metadata.origin.conversationId } : {}),
        ...(metadata.selectedContext ? { selectedContext: metadata.selectedContext } : {}),
      }];
    } catch { return [ref, null]; }
  }));
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
    const value = JSON.parse(readFileSync(path, "utf8"));
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
  } catch {
    throw new Error("structured-user metadata reference is unavailable; the delivery context cannot be recovered");
  }
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
export function persistStructuredUserMetadata(record: StructuredUserMetadata): string {
  const ref = metadataReference(record);
  const path = filename(ref);
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES) throw new Error("structured-user metadata is too large");
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, body);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      try { linkSync(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const parent = openSync(directory(), "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { unlinkSync(temporary); }
  }
  if (JSON.stringify(readStructuredUserMetadata(ref)) !== body) {
    throw new Error("structured-user delivery identity belongs to different metadata");
  }
  return ref;
}
