import { inflateRawSync } from "node:zlib";

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inspect OOXML in memory, without extracting paths onto the host. Both ZIP
 * directory and local headers must agree, and every member is inspected.
 * The caller's file limit also bounds total expanded bytes; unsupported,
 * encrypted, ZIP64 or damaged archives fail closed before any send. */
export function inspectOfficeZip(bytes: Buffer, maxBytes: number, inspect: (bytes: Buffer) => void): Set<string> {
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
    const filename = name.toString("utf8");
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
    const content = method === 0 ? encoded : inflateRawSync(encoded, { maxOutputLength: Math.max(1, maxBytes - total) });
    if (content.length !== expanded || crc32(content) !== bytes.readUInt32LE(position + 16)) return invalid();
    total += content.length;
    inspect(name);
    inspect(content);
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

/** XML stores text across runs and entity references. Inspect the visible
 * character sequence too, so encoding or rich-text runs cannot hide a token.
 * This is inspection only: no entity expansion, external reads or execution. */
export function officeXmlText(text: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("<", cursor);
    if (open === -1) { pieces.push(text.slice(cursor)); break; }
    pieces.push(text.slice(cursor, open));
    if (text.startsWith("<!--", open)) {
      const close = text.indexOf("-->", open + 4);
      if (close === -1) { pieces.push(text.slice(open + 4)); break; }
      cursor = close + 3;
      continue;
    }
    const cdata = text.startsWith("<![CDATA[", open);
    const close = text.indexOf(cdata ? "]]>" : ">", open + (cdata ? 9 : 1));
    if (close === -1) { pieces.push(text.slice(open + (cdata ? 9 : 0))); break; }
    if (cdata) pieces.push(text.slice(open + 9, close));
    else if (/^<(?:[\w.-]+:)?br(?:\s[^>]*)?\s*\/?\s*>$/i.test(text.slice(open, close + 1))) pieces.push("\n");
    else if (/^<(?:[\w.-]+:)?tab(?:\s[^>]*)?\s*\/?\s*>$/i.test(text.slice(open, close + 1))) pieces.push("\t");
    else if (/^<\/(?:[\w.-]+:)?(?:p|c|si|row|tr|tc|property)\s*>$/i.test(text.slice(open, close + 1))) pieces.push("\n");
    cursor = close + (cdata ? 3 : 1);
  }
  return pieces.join("").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
      if (name.startsWith("#")) {
        const point = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] ?? entity;
    });
}
