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

/** Inspect OOXML in memory, without extracting paths onto the host. Both ZIP
 * directory and local headers must agree, and every member is inspected.
 * The caller's file limit also bounds total expanded bytes; unsupported,
 * encrypted, ZIP64 or damaged archives fail closed before any send. */
export function inspectOfficeZip(bytes: Buffer, maxBytes: number, inspect: (name: string, bytes: Buffer) => void): Set<string> {
  const invalid = (): never => { throw new Error("Office ZIP cannot be fully inspected"); };
  let end = bytes.length - 22;
  let found = false;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) { found = true; break; }
  }
  if (!found) return invalid();
  const count = bytes.readUInt16LE(end + 10);
  const directory = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== count || !count || count > 4096
    || directory + bytes.readUInt32LE(end + 12) !== end) return invalid();
  const names = new Set<string>();
  const filenameDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const ranges: Array<[number, number]> = [];
  let position = directory;
  let total = 0;
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
    if (finish > directory || expanded > maxBytes - total) return invalid();
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
    total += content.length;
    inspect(filename, content);
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

function officeBoundary({ uri, local }: SaxesTagNS): string {
  switch (uri) {
    case "http://schemas.openxmlformats.org/wordprocessingml/2006/main":
    case "http://purl.oclc.org/ooxml/wordprocessingml/main":
      if (local === "tab" || local === "ptab") return "\t";
      return /^(p|br|cr|tr|tc)$/.test(local) ? "\n" : "";
    case "http://schemas.openxmlformats.org/drawingml/2006/main":
    case "http://purl.oclc.org/ooxml/drawingml/main":
      return /^(p|br|tr|tc)$/.test(local) ? "\n" : "";
    case "http://schemas.openxmlformats.org/spreadsheetml/2006/main":
    case "http://purl.oclc.org/ooxml/spreadsheetml/main":
      return /^(c|row|si|is|v|f)$/.test(local) ? "\n" : "";
    case "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties":
    case "http://purl.oclc.org/ooxml/officeDocument/customProperties":
      return local === "property" ? "\n" : "";
    default:
      return "";
  }
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** Join adjacent runs, retaining text inside leaves and real layout boundaries.
 * Two readings are returned, one line apart: one keeps every leaf's text as
 * written, the other trims XML whitespace from the edges of leaves outside
 * `xml:space="preserve"`, as Office does when it lays the text out, so a
 * whitespace-only run cannot split a token in both. Fatal decoding and
 * parsing apply to XML parts even after a secret is found. */
export function officeXmlText(name: string, bytes: Buffer): string | null {
  const encoding = xmlEncoding(bytes);
  if (!/\.(?:xml|rels|vml|svg)$/i.test(name) && !startsWithXml(bytes, encoding)) return null;
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const pieces: string[] = [];
  const compact: string[] = [];
  const attributes: string[] = [];
  const hasChild: boolean[] = [];
  const preserve: boolean[] = [];
  const pending: string[] = [];
  const flush = (keepWhitespace: boolean) => {
    const text = pending.join("");
    pending.length = 0;
    if (!text || !(keepWhitespace || /[^ \t\r\n]/.test(text))) return;
    pieces.push(text);
    compact.push(preserve.at(-1) ? text : text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""));
  };
  const boundary = (text: string) => { pieces.push(text); compact.push(text); };

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
    const separator = officeBoundary(tag);
    if (separator) boundary(separator);
  });
  parser.write(xml).close();
  // Attribute values are separate from the displayed text and from each other.
  return [pieces.join(""), compact.join(""), ...attributes].join("\n");
}
