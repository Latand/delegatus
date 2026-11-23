import { inflateRawSync } from "node:zlib";
import { SaxesParser, type SaxesTagNS } from "saxes";

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
type InflateInfo = { buffer: Buffer; engine: { bytesWritten: number } };

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

/** Embedded packages may nest this deep below the file itself: a chart
 * workbook inside a DOCX is level 1, a DOCX with a chart inside a PPTX level 2. */
export const OFFICE_MAX_NESTING = 2;
const OFFICE_MAX_ENTRIES = 4096;
/* OLE compound files (embedded objects, ActiveX, VBA, legacy .doc/.xls) keep
   their content in a sector chain and often compressed, so a byte scan cannot
   see it. */
const COMPOUND_FILE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_NAME = /\.(?:zip|jar|epub|xps|oxps|thmx|xlsb|xlam|od[tspg]|(?:doc|dot|xls|xlt|ppt|pot|pps|ppa|sld|vsd|vss|vst)[xm])$/i;

type Budget = { bytes: number; entries: number };

const END_OF_DIRECTORY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** The end-of-central-directory record whose comment ends the bytes, or -1. */
function endOfDirectory(bytes: Buffer): number {
  // A negative offset would count back from the end.
  if (bytes.length < 22) return -1;
  const floor = Math.max(0, bytes.length - 65557);
  for (let end = bytes.lastIndexOf(END_OF_DIRECTORY, bytes.length - 22); end >= floor; end = end ? bytes.lastIndexOf(END_OF_DIRECTORY, end - 1) : -1) {
    if (end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) return end;
  }
  return -1;
}

/** A member that is itself a ZIP, by its leading signature, its name or a
 * trailing directory record, has to be opened and inspected in turn. */
function embeddedZip(name: string, bytes: Buffer): boolean {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x0403, 0x0605, 0x0807].includes(bytes.readUInt16BE(2))) return true;
  return ZIP_NAME.test(name) || endOfDirectory(bytes) !== -1;
}

/** Inspect OOXML in memory, without extracting paths onto the host. Both ZIP
 * directory and local headers must agree, and every member is inspected.
 * A member that is itself a ZIP package is opened and inspected the same way,
 * up to {@link OFFICE_MAX_NESTING} levels, and its members reach `inspect` as
 * `outer/inner` names. The caller's byte limit bounds the expanded bytes of
 * every level together, and 4096 entries bound them all. Unsupported,
 * encrypted, ZIP64, damaged or too deeply nested archives and embedded OLE
 * compound files fail closed before any send. Returns the top-level names. */
export function inspectOfficeZip(bytes: Buffer, maxBytes: number, inspect: (name: string, bytes: Buffer) => void): Set<string> {
  return inspectZip(bytes, { bytes: maxBytes, entries: OFFICE_MAX_ENTRIES }, inspect, "", 0);
}

function inspectZip(bytes: Buffer, budget: Budget, inspect: (name: string, bytes: Buffer) => void, prefix: string, depth: number): Set<string> {
  const invalid = (): never => { throw new Error("Office ZIP cannot be fully inspected"); };
  const end = endOfDirectory(bytes);
  if (end === -1) return invalid();
  const count = bytes.readUInt16LE(end + 10);
  const directory = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== count || !count || count > budget.entries
    || directory + bytes.readUInt32LE(end + 12) !== end) return invalid();
  budget.entries -= count;
  const names = new Set<string>();
  const filenameDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const ranges: Array<[number, number]> = [];
  let position = directory;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) return invalid();
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10);
    const compressed = bytes.readUInt32LE(position + 20), expanded = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const next = position + 46 + nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    const local = bytes.readUInt32LE(position + 42);
    if (next > end || !nameLength || (flags & ~0x080e) || ![0, 8].includes(method)
      || bytes.readUInt16LE(position + 34) || compressed === 0xffffffff || expanded === 0xffffffff
      || local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) return invalid();
    const name = bytes.subarray(position + 46, position + 46 + nameLength);
    const filename = filenameDecoder.decode(name);
    if (names.has(filename) || bytes.readUInt16LE(local + 26) !== nameLength
      || !name.equals(bytes.subarray(local + 30, local + 30 + nameLength))) return invalid();
    names.add(filename);
    const start = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    let finish = start + compressed;
    if (finish > directory || expanded > budget.bytes) return invalid();
    if (flags & 8) {
      const descriptor = finish + (finish + 4 <= directory && bytes.readUInt32LE(finish) === 0x08074b50 ? 4 : 0);
      if (descriptor + 12 > directory || bytes.readUInt32LE(descriptor) !== bytes.readUInt32LE(position + 16)
        || bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== expanded) return invalid();
      finish = descriptor + 12;
    } else if (bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(position + 16)
      || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== expanded) return invalid();
    const encoded = bytes.subarray(start, start + compressed);
    let content = encoded;
    if (method === 8) {
      // With `info`, zlib also returns its engine; the Node typings lack that overload.
      const inflated = inflateRawSync(encoded, { info: true, maxOutputLength: Math.max(1, expanded) }) as unknown as InflateInfo;
      // Trailing bytes after the deflate stream would escape inspection.
      if (inflated.engine.bytesWritten !== compressed) return invalid();
      content = inflated.buffer;
    }
    if (content.length !== expanded || crc32(content) !== bytes.readUInt32LE(position + 16)) return invalid();
    budget.bytes -= content.length;
    inspect(prefix + filename, content);
    if (content.subarray(0, COMPOUND_FILE.length).equals(COMPOUND_FILE)) return invalid();
    if (embeddedZip(filename, content)) {
      if (depth >= OFFICE_MAX_NESTING) return invalid();
      inspectZip(content, budget, inspect, `${prefix}${filename}/`, depth + 1);
    }
    ranges.push([local, finish]);
    position = next;
  }
  if (position !== end) return invalid();
  let covered = 0;
  for (const [start, finish] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start !== covered) return invalid();
    covered = finish;
  }
  if (covered !== directory) return invalid();
  return names;
}

const xmlWhitespaceByte = (byte: number | undefined) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const xmlStartByte = (byte: number | undefined) => byte === 0x3c || xmlWhitespaceByte(byte);

function xmlEncoding(bytes: Buffer): "utf-8" | "utf-16le" | "utf-16be" {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (xmlStartByte(bytes[0]) && bytes[1] === 0)) return "utf-16le";
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && xmlStartByte(bytes[1]))) return "utf-16be";
  return "utf-8";
}

function startsWithXml(bytes: Buffer, encoding: ReturnType<typeof xmlEncoding>): boolean {
  if (encoding === "utf-8") {
    let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    while (xmlWhitespaceByte(bytes[index])) index++;
    return bytes[index] === 0x3c;
  }
  const read = encoding === "utf-16le" ? bytes.readUInt16LE.bind(bytes) : bytes.readUInt16BE.bind(bytes);
  let index = bytes.length >= 2 && read(0) === 0xfeff ? 2 : 0;
  while (index + 1 < bytes.length && xmlWhitespaceByte(read(index))) index += 2;
  return index + 1 < bytes.length && read(index) === 0x3c;
}

const WORD = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
const DRAWING = new Set(["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"]);
const SHEET = new Set(["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"]);
const CUSTOM_PROPERTIES = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/custom-properties", "http://purl.oclc.org/ooxml/officeDocument/customProperties"]);
/* Namespaces whose elements may sit between pieces of one displayed run of
   text: Office math runs and markup-compatibility wrappers around content. */
const INLINE = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/math", "http://purl.oclc.org/ooxml/officeDocument/math",
  "http://schemas.openxmlformats.org/markup-compatibility/2006"]);

/** What closing `tag` adds to the text. `text` serves both run-joining
 * readings; `separated` also ends every element of a namespace without text
 * runs, so leaves such as properties, chart values and comments stay apart. */
function officeBoundary(tag: SaxesTagNS, parent: SaxesTagNS | undefined): { text: string; separated: string } {
  const both = (text: string) => ({ text, separated: text });
  const { uri, local } = tag;
  if (WORD.has(uri)) {
    if (local === "tab" || local === "ptab") return both("\t");
    if (local === "noBreakHyphen") return both("-");
    if (local === "sym") {
      // Symbol fonts map their glyphs at F000-F0FF; either way a character shows.
      const code = Number.parseInt(Object.values(tag.attributes).find(a => WORD.has(a.uri) && a.local === "char")?.value ?? "", 16);
      return both(Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code) : "");
    }
    return both(/^(p|br|cr|tr|tc)$/.test(local) ? "\n" : "");
  }
  if (DRAWING.has(uri)) return both(/^(p|br|tr|tc)$/.test(local) ? "\n" : "");
  // Only a rich run, its text and its properties join; every other element
  // (cell, string, comment, author, header, defined name) stands apart.
  if (SHEET.has(uri)) return both(local === "r" || local === "t" || local === "rPr" || (parent?.local === "rPr" && SHEET.has(parent.uri)) ? "" : "\n");
  if (CUSTOM_PROPERTIES.has(uri)) return both(local === "property" ? "\n" : "");
  return { text: "", separated: INLINE.has(uri) ? "" : "\n" };
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** Join adjacent runs, retaining text inside leaves and real layout boundaries.
 * Three readings are returned, one line apart: one keeps every leaf's text as
 * written, the second trims XML whitespace from the edges of leaves outside
 * `xml:space="preserve"`, as Office does when it lays the text out, so a
 * whitespace-only run cannot split a token in both, and the third trims the
 * same way and also ends every element outside the run-bearing namespaces, so
 * neighbouring leaves cannot glue onto a token. Fatal decoding and parsing
 * apply to XML parts even after a secret is found. */
export function officeXmlText(name: string, bytes: Buffer): string | null {
  const encoding = xmlEncoding(bytes);
  if (!/\.(?:xml|rels|vml|svg)$/i.test(name) && !startsWithXml(bytes, encoding)) return null;
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const pieces: string[] = [];
  const compact: string[] = [];
  const separated: string[] = [];
  const attributes: string[] = [];
  const open: SaxesTagNS[] = [];
  const hasChild: boolean[] = [];
  const preserve: boolean[] = [];
  const pending: string[] = [];
  const flush = (keepWhitespace: boolean) => {
    const text = pending.join("");
    pending.length = 0;
    if (!text || !(keepWhitespace || /[^ \t\r\n]/.test(text))) return;
    pieces.push(text);
    const trimmed = preserve.at(-1) ? text : text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
    compact.push(trimmed);
    separated.push(trimmed);
  };

  const parser = new SaxesParser({ xmlns: true });
  parser.on("xmldecl", (decl) => {
    const declared = decl.encoding?.toLowerCase();
    if (declared && declared !== encoding && !(declared === "utf-16" && encoding !== "utf-8")) {
      throw new Error("Unsupported Office XML encoding");
    }
  });
  parser.on("doctype", () => { throw new Error("Office XML document types are unsupported"); });
  parser.on("opentagstart", () => {
    if (hasChild.length >= 256) throw new Error("Office XML nesting exceeds inspection limit");
  });
  parser.on("opentag", (tag) => {
    flush(false);
    if (hasChild.length) hasChild[hasChild.length - 1] = true;
    hasChild.push(false);
    open.push(tag);
    let preserved = preserve.at(-1) ?? false;
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === XML_NAMESPACE && attribute.local === "space") preserved = attribute.value === "preserve";
      if (attribute.uri !== "http://www.w3.org/2000/xmlns/") attributes.push(attribute.value);
    }
    preserve.push(preserved);
  });
  parser.on("text", (text) => { pending.push(text); });
  parser.on("cdata", (text) => { pending.push(text); });
  parser.on("closetag", (tag) => {
    flush(!hasChild.pop());
    preserve.pop();
    open.pop();
    const { text, separated: apart } = officeBoundary(tag, open.at(-1));
    pieces.push(text);
    compact.push(text);
    separated.push(apart);
  });
  parser.write(xml).close();
  // Attribute values are separate from the displayed text and from each other.
  return [pieces.join(""), compact.join(""), separated.join(""), ...attributes].join("\n");
}
