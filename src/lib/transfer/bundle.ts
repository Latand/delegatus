import { createHash } from "node:crypto";
import zlib from "node:zlib";

import {
  TRANSFER_FORMAT, TRANSFER_VERSION,
  type BundleHeader, type BundleRecord, type DecodedBundle, type SectionHeader,
} from "./types";

/* The plain bundle (docs/design/install-memory-transfer.md §2.1): a gzip
   stream of JSON Lines. Line 1 is the header, then one record per line, then
   a trailer whose hash covers every byte before it. Each section's hash
   covers its record lines in order. */

/** The import refuses a bundle that declares more than this, uncompressed. */
export const MAX_BUNDLE_BYTES = 1024 ** 3;
const MAX_HEADER_LINE_BYTES = 16 * 1024 * 1024;

export class TransferBundleError extends Error {
  constructor(readonly code:
    | "not_a_bundle" | "bad_header" | "unsupported_version" | "too_large" | "truncated"
    | "record_too_long" | "bad_record" | "section_checksum" | "bundle_checksum", message: string) {
    super(message);
    this.name = "TransferBundleError";
  }
}

export interface EncodeSection {
  name: string;
  schema: number;
  summary: Record<string, unknown>;
  records: readonly { k: string; v: unknown }[];
}

export type EncodeInput = Omit<BundleHeader, "format" | "version" | "sections" | "bytes"> & { sections: readonly EncodeSection[] };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Plain bundle bytes. The header carries per-section counts, sizes and hashes
    and the uncompressed total, so each section is serialized before the header. */
export function encodeBundle(input: EncodeInput): Buffer {
  const sectionBodies = input.sections.map(section => {
    const text = section.records.map(record => `${JSON.stringify({ s: section.name, k: record.k, v: record.v } satisfies BundleRecord)}\n`).join("");
    const header: SectionHeader = {
      name: section.name, schema: section.schema, records: section.records.length,
      bytes: Buffer.byteLength(text), sha256: sha256(text), summary: section.summary,
    };
    return { header, text };
  });
  const recordCount = sectionBodies.reduce((sum, section) => sum + section.header.records, 0);
  const recordBytes = sectionBodies.reduce((sum, section) => sum + section.header.bytes, 0);
  const rest: Omit<EncodeInput, "sections"> = { exportId: input.exportId, createdAt: input.createdAt, product: input.product,
    projects: input.projects, accounts: input.accounts, environment: input.environment, notices: input.notices };
  /* The total depends on the header's own length, which holds the total:
     settle it in at most a few passes as the digit count stabilises. */
  let total = 0;
  let headerLine = "";
  let trailerLength = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const header: BundleHeader = { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, ...rest, bytes: total, sections: sectionBodies.map(section => section.header) };
    headerLine = `${JSON.stringify(header)}\n`;
    trailerLength = Buffer.byteLength(`${JSON.stringify({ end: true, records: recordCount, sha256: "0".repeat(64) })}\n`);
    const next = Buffer.byteLength(headerLine) + recordBytes + trailerLength;
    if (next === total) break;
    total = next;
  }
  const body = headerLine + sectionBodies.map(section => section.text).join("");
  const trailer = `${JSON.stringify({ end: true, records: recordCount, sha256: sha256(body) })}\n`;
  return zlib.gzipSync(Buffer.from(body + trailer, "utf8"), { level: 6 });
}

function parseHeader(line: string): BundleHeader {
  let header: BundleHeader;
  try { header = JSON.parse(line) as BundleHeader; }
  catch { throw new TransferBundleError("bad_header", "the bundle's first line is not a header"); }
  if (!header || typeof header !== "object" || header.format !== TRANSFER_FORMAT) throw new TransferBundleError("not_a_bundle", "this file is not a Delegatus transfer");
  if (header.version !== TRANSFER_VERSION) throw new TransferBundleError("unsupported_version", `this bundle uses format version ${String(header.version)}; this Delegatus reads version ${TRANSFER_VERSION}`);
  if (!Number.isSafeInteger(header.bytes) || header.bytes <= 0) throw new TransferBundleError("bad_header", "the bundle header declares no size");
  if (header.bytes > MAX_BUNDLE_BYTES) throw new TransferBundleError("too_large", "the bundle declares more than 1 GiB");
  if (!Array.isArray(header.sections) || header.sections.some(section => !section || typeof section.name !== "string"
    || !Number.isSafeInteger(section.records) || !Number.isSafeInteger(section.bytes) || typeof section.sha256 !== "string")) {
    throw new TransferBundleError("bad_header", "the bundle header lists a malformed section");
  }
  if (new Set(header.sections.map(section => section.name)).size !== header.sections.length) throw new TransferBundleError("bad_header", "the bundle header lists a section twice");
  for (const key of ["projects", "accounts", "environment"] as const) if (!Array.isArray(header[key])) throw new TransferBundleError("bad_header", `the bundle header has no ${key} list`);
  if (!Array.isArray(header.notices)) header.notices = [];
  return header;
}

/** Decompress with the declared total as the bound, then check every hash. */
export async function decodeBundle(bytes: Uint8Array): Promise<DecodedBundle> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new TransferBundleError("not_a_bundle", "this file is not a Delegatus transfer");
  const chunks: Buffer[] = [];
  let size = 0;
  let header: BundleHeader | null = null;
  await new Promise<void>((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    let failed = false;
    const fail = (error: Error) => { if (failed) return; failed = true; gunzip.destroy(); reject(error); };
    gunzip.on("data", (chunk: Buffer) => {
      if (failed) return;
      chunks.push(chunk);
      size += chunk.length;
      if (!header) {
        const joined = Buffer.concat(chunks);
        const newline = joined.indexOf(0x0a);
        if (newline < 0) {
          if (joined.length > MAX_HEADER_LINE_BYTES) fail(new TransferBundleError("bad_header", "the bundle header is too long"));
          return;
        }
        try { header = parseHeader(joined.subarray(0, newline).toString("utf8")); }
        catch (error) { fail(error as Error); return; }
      }
      if (header && size > header.bytes) fail(new TransferBundleError("too_large", "the bundle holds more bytes than it declares"));
    });
    gunzip.on("error", () => fail(new TransferBundleError(size ? "truncated" : "not_a_bundle", "the bundle's compressed stream is damaged")));
    gunzip.on("end", () => { if (!failed) resolve(); });
    gunzip.end(Buffer.from(bytes));
  });
  if (!header) throw new TransferBundleError("truncated", "the bundle ends before its header");
  const decodedHeader: BundleHeader = header;
  const plain = Buffer.concat(chunks, size);
  const text = plain.toString("utf8");
  if (!text.endsWith("\n")) throw new TransferBundleError("truncated", "the bundle ends mid-line");
  const headerCharEnd = text.indexOf("\n") + 1;
  const lastLineStart = text.lastIndexOf("\n", text.length - 2) + 1;
  let trailer: { end?: unknown; records?: unknown; sha256?: unknown } | null = null;
  try { trailer = JSON.parse(text.slice(lastLineStart, -1)); } catch { trailer = null; }
  if (!trailer || trailer.end !== true || lastLineStart < headerCharEnd) throw new TransferBundleError("truncated", "the bundle ends before its trailer");
  if (trailer.sha256 !== sha256(plain.subarray(0, Buffer.byteLength(text.slice(0, lastLineStart))))) {
    throw new TransferBundleError("bundle_checksum", "the bundle's checksum does not match its contents");
  }
  if (size !== decodedHeader.bytes) throw new TransferBundleError("truncated", "the bundle's size differs from its header");
  const recordText = text.slice(headerCharEnd, lastLineStart);
  const lines = recordText ? recordText.slice(0, -1).split("\n") : [];
  if (trailer.records !== lines.length) throw new TransferBundleError("truncated", "the bundle holds a different number of records than its trailer says");
  const records: BundleRecord[] = [];
  let index = 0;
  for (const section of decodedHeader.sections) {
    const hash = createHash("sha256");
    let bytesSeen = 0;
    for (let count = 0; count < section.records; count += 1) {
      const line = lines[index++];
      if (line === undefined) throw new TransferBundleError("truncated", `section ${section.name} ends early`);
      const lineBytes = Buffer.byteLength(line) + 1;
      if (lineBytes > section.bytes) throw new TransferBundleError("record_too_long", `a record in ${section.name} is longer than its section declares`);
      bytesSeen += lineBytes;
      hash.update(`${line}\n`);
      let record: BundleRecord;
      try { record = JSON.parse(line) as BundleRecord; }
      catch { throw new TransferBundleError("bad_record", `a record in ${section.name} is not JSON`); }
      if (!record || record.s !== section.name || typeof record.k !== "string" || !record.k.includes("|") || !("v" in record)) {
        throw new TransferBundleError("bad_record", `a record in ${section.name} is malformed`);
      }
      records.push(record);
    }
    if (bytesSeen !== section.bytes || hash.digest("hex") !== section.sha256) throw new TransferBundleError("section_checksum", `section ${section.name} does not match its checksum`);
  }
  if (index !== lines.length) throw new TransferBundleError("bad_record", "the bundle holds records outside its sections");
  return { header: decodedHeader, records, sha256: sha256(plain) };
}

/** `<part>|<key>` split at the first separator. */
export function splitRecordKey(k: string): { part: string; key: string } {
  const at = k.indexOf("|");
  return { part: k.slice(0, at), key: k.slice(at + 1) };
}
