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
/** Receives each member under its full name and the name of its package
 * (empty for the file itself, `outer/` for an embedded package). */
type Inspect = (name: string, bytes: Buffer, packagePrefix: string) => void;

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
 * encrypted, ZIP64, damaged, commented or too deeply nested archives and
 * embedded OLE compound files fail closed before any send. Returns the
 * top-level names. */
export function inspectOfficeZip(bytes: Buffer, maxBytes: number, inspect: Inspect): Set<string> {
  return inspectZip(bytes, { bytes: maxBytes, entries: OFFICE_MAX_ENTRIES }, inspect, "", 0);
}

function inspectZip(bytes: Buffer, budget: Budget, inspect: Inspect, prefix: string, depth: number): Set<string> {
  const invalid = (): never => { throw new Error("Office ZIP cannot be fully inspected"); };
  const end = endOfDirectory(bytes);
  // Office writers leave the archive comment empty. A comment could hold a
  // second archive whose directory other readers choose, so it is refused.
  if (end === -1 || end !== bytes.length - 22) return invalid();
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
    inspect(prefix + filename, content, prefix);
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
const MATH = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/math", "http://purl.oclc.org/ooxml/officeDocument/math"]);
const COMPATIBILITY = "http://schemas.openxmlformats.org/markup-compatibility/2006";
/* Namespaces whose elements may sit between pieces of one displayed run of
   text: Office math runs and markup-compatibility wrappers around content. */
const INLINE = new Set([...MATH, COMPATIBILITY]);

const wordValue = (tag: SaxesTagNS, local: string) => Object.values(tag.attributes).find(a => WORD.has(a.uri) && a.local === local)?.value;
/** A WordprocessingML on/off property: present without a value means on. */
const wordOn = (tag: SaxesTagNS) => !/^(?:0|false|off)$/i.test(wordValue(tag, "val") ?? "on");
const plainValue = (tag: SaxesTagNS, local: string) => Object.values(tag.attributes).find(a => a.uri === "" && a.local === local)?.value;

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
      const code = Number.parseInt(wordValue(tag, "char") ?? "", 16);
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

type XmlHandlers = {
  open(tag: SaxesTagNS, resolve: (prefix: string) => string | undefined): void;
  text(text: string): void;
  close(tag: SaxesTagNS): void;
};

/** Parse one XML part strictly: fatal decoding, a declared encoding that
 * matches the bytes, no document type and at most 256 levels of nesting. */
function parseOfficeXml(bytes: Buffer, handlers: XmlHandlers): number {
  const encoding = xmlEncoding(bytes);
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  parser.on("xmldecl", (decl) => {
    const declared = decl.encoding?.toLowerCase();
    if (declared && declared !== encoding && !(declared === "utf-16" && encoding !== "utf-8")) {
      throw new Error("Unsupported Office XML encoding");
    }
  });
  parser.on("doctype", () => { throw new Error("Office XML document types are unsupported"); });
  parser.on("opentagstart", () => {
    if (depth >= 256) throw new Error("Office XML nesting exceeds inspection limit");
  });
  parser.on("opentag", (tag) => {
    depth++;
    handlers.open(tag, prefix => tag.ns?.[prefix] ?? parser.resolve(prefix));
  });
  parser.on("text", handlers.text);
  parser.on("cdata", handlers.text);
  parser.on("closetag", (tag) => {
    depth--;
    handlers.close(tag);
  });
  parser.write(xml).close();
  return xml.length;
}

/** Which Word styles hide their text (`w:vanish`), from a package's styles part. */
export type WordStyles = {
  defaults?: boolean;
  possiblyHidden?: boolean;
  byId: Map<string, { basedOn?: string; vanish?: boolean }>;
  defaultOf: Map<string, string>;
};

/** Read a WordprocessingML styles part, or undefined for any other part. */
export function wordStyles(bytes: Buffer): WordStyles | undefined {
  const styles: WordStyles = { byId: new Map(), defaultOf: new Map() };
  const path: string[] = [];
  let entry: { basedOn?: string; vanish?: boolean } | undefined;
  const first: { tag?: SaxesTagNS } = {};
  parseOfficeXml(bytes, {
    open(tag) {
      first.tag ??= tag;
      const local = WORD.has(tag.uri) ? tag.local : "";
      const parent = path.at(-1), grand = path.at(-2), great = path.at(-3);
      if (local === "style" && parent === "styles" && path.length === 1) {
        const type = wordValue(tag, "type") ?? "paragraph", id = wordValue(tag, "styleId");
        entry = {};
        if (id !== undefined) {
          if (!styles.byId.has(`${type}:${id}`)) styles.byId.set(`${type}:${id}`, entry);
          if (/^(?:1|true|on)$/i.test(wordValue(tag, "default") ?? "") && !styles.defaultOf.has(type)) styles.defaultOf.set(type, id);
        }
      } else if (local === "basedOn" && parent === "style" && entry) entry.basedOn = wordValue(tag, "val");
      else if (local === "vanish") {
        if (wordOn(tag)) styles.possiblyHidden = true;
        if (parent === "rPr" && grand === "style" && entry) entry.vanish = wordOn(tag);
        else if (parent === "rPr" && grand === "rPrDefault" && great === "docDefaults") styles.defaults = wordOn(tag);
      }
      path.push(local);
    },
    text() {},
    close() { path.pop(); },
  });
  return first.tag && WORD.has(first.tag.uri) && first.tag.local === "styles" ? styles : undefined;
}

/** A style's own `w:vanish`, or the nearest one along its `basedOn` chain. */
function styleVanish(styles: WordStyles | undefined, type: string, id: string | undefined): boolean | undefined {
  for (let step = 0, current = id; styles && current !== undefined && step < 64; step++) {
    const entry = styles.byId.get(`${type}:${current}`);
    if (!entry) return undefined;
    if (entry.vanish !== undefined) return entry.vanish;
    current = entry.basedOn;
  }
  return undefined;
}

function relationships(bytes: Buffer): Array<{ type: string; target: string }> {
  const found: Array<{ type: string; target: string }> = [];
  parseOfficeXml(bytes, {
    open(tag) {
      const type = plainValue(tag, "Type"), target = plainValue(tag, "Target");
      if (tag.local === "Relationship" && type && target && plainValue(tag, "TargetMode") !== "External") found.push({ type, target });
    },
    text() {},
    close() {},
  });
  return found;
}

/** Resolve a relationship target against its source part, as a lower-case member name. */
function partName(source: string, target: string): string {
  let decoded = target;
  try { decoded = decodeURIComponent(target); } catch { /* keep the target as written */ }
  const segments = decoded.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return segments.join("/").toLowerCase();
}

const relationshipsName = (part: string) => {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
};

/** The styles part Word applies to the package's main document, found through
 * the package and document relationships as Word finds it. */
function packageWordStyles(members: Map<string, Buffer>): WordStyles | undefined {
  const root = members.get("_rels/.rels");
  const main = root && relationships(root).find(relationship => /\/officeDocument$/.test(relationship.type));
  if (!main) return undefined;
  const document = partName("", main.target);
  const documentRelationships = members.get(relationshipsName(document));
  const styles = documentRelationships && relationships(documentRelationships).find(relationship => /\/styles$/.test(relationship.type));
  const part = styles && members.get(partName(document, styles.target));
  return part && wordStyles(part);
}

function rejectWordImports(members: Array<[string, Buffer, string]>): void {
  for (const [name, bytes] of members) {
    if (name.toLowerCase().endsWith(".rels") && relationships(bytes).some(item => /\/aFChunk$/i.test(item.type))) {
      throw new Error("Word imported content is unsupported");
    }
    if (!/\.xml$/i.test(name)) continue;
    let imported = false;
    parseOfficeXml(bytes, { open(tag) { if (WORD.has(tag.uri) && tag.local === "altChunk") imported = true; }, text() {}, close() {} });
    if (imported) throw new Error("Word imported content is unsupported");
  }
}

/** The shared strings a workbook's cells index, from the part its relationships name. */
function packageSharedStrings(members: Map<string, Buffer>): string[] | undefined {
  const root = members.get("_rels/.rels");
  const main = root && relationships(root).find(relationship => /\/officeDocument$/.test(relationship.type));
  if (!main) return undefined;
  const workbook = partName("", main.target);
  const workbookRelationships = members.get(relationshipsName(workbook));
  const strings = workbookRelationships && relationships(workbookRelationships).find(relationship => /\/sharedStrings$/.test(relationship.type));
  const part = strings && members.get(partName(workbook, strings.target));
  return part && sharedStringTable(part);
}

/** The text of each `si` of a shared-strings part, by index: rich runs joined, phonetic guides left out. */
function sharedStringTable(bytes: Buffer): string[] {
  const table: string[] = [];
  let current: string | null = null;
  let inText = 0, inPhonetic = 0;
  parseOfficeXml(bytes, {
    open(tag) {
      if (!SHEET.has(tag.uri)) return;
      if (tag.local === "si") current = "";
      else if (tag.local === "t") inText++;
      else if (tag.local === "rPh") inPhonetic++;
    },
    text(text) { if (current !== null && inText && !inPhonetic) current += text; },
    close(tag) {
      if (!SHEET.has(tag.uri)) return;
      if (tag.local === "t") inText--;
      else if (tag.local === "rPh") inPhonetic--;
      else if (tag.local === "si" && current !== null) { table.push(current); current = null; }
    },
  });
  return table;
}

/** Inspect a package with {@link inspectOfficeZip} and hand every member, with
 * the text {@link officeXmlText} reads from it, to `visit`. Text is read once
 * the whole package has been checked, so the Word styles and the shared
 * strings of each package (the file itself or an embedded one) apply to all of
 * its parts. */
export function inspectOfficePackage(bytes: Buffer, maxBytes: number, visit: (name: string, bytes: Buffer, text: string | null, requiresConsent: boolean) => void): Set<string> {
  const members: Array<[string, Buffer, string]> = [];
  const names = inspectOfficeZip(bytes, maxBytes, (name, content, prefix) => { members.push([name, content, prefix]); });
  rejectWordImports(members);
  const packages = new Map<string, { styles: WordStyles | undefined; workbook: WorkbookContext }>();
  for (const [name, content, prefix] of members) {
    let own = packages.get(prefix);
    if (!own) {
      const parts = members.filter(member => member[2] === prefix);
      const byName = new Map(parts.map(([member, data]) => [member.slice(prefix.length).toLowerCase(), data] as const));
      own = {
        styles: packageWordStyles(byName),
        workbook: { sharedStrings: packageSharedStrings(byName), budget: { left: formulaReadingBudget(parts.reduce((total, [, data]) => total + data.length, 0)) } },
      };
      packages.set(prefix, own);
    }
    const inspection = officeXmlTextInspection(name, content, own.styles, own.workbook);
    visit(name, content, inspection.text, inspection.requiresConsent);
  }
  return names;
}

/* The displayed reading. Word, Excel and PowerPoint lay out only part of the
   text a part holds: hidden runs, the side of a tracked change the view does
   not show, field instructions, phonetic guides and the markup-compatibility
   content a consumer does not select stay out of the line around them, and a
   text box or drawing anchored inside a line forms its own story. A piece
   carries what decides whether it shows, and each reading keeps the pieces one
   consumer and one view would show. */
type Alternate = { branches: Array<{ requires: string[] | null }> };
type Need = { ns: string } | { alternate: Alternate; branch: number } | { never: true };
type WordParagraph = { style?: string; vanish?: boolean; special?: boolean; markStyle?: string; web?: boolean; deleted?: boolean; inserted?: boolean };
type WordRun = { paragraph?: WordParagraph; vanish?: boolean; originalVanish?: boolean; style?: string; web?: boolean };
type Kind = "p" | "pPr" | "mark" | "r" | "rPr" | "rPrChange" | "oldRPr" | undefined;
type Frame = {
  tag?: SaxesTagNS; kind: Kind; needs: Need[]; own: Need[]; story: number; runs: WordRun[]; flags: number;
  ignorable: ReadonlySet<string>; process: ReadonlySet<string>; alternate?: Alternate; paragraph?: WordParagraph; run?: WordRun;
};
type Piece = { text: string; needs: Need[]; story: number; runs: WordRun[]; flags: number; mark?: WordParagraph };
const DELETED = 1, INSERTED = 2, FIELD = 4;
const WORD_TEXT = new Set(["t", "delText", "instrText", "delInstrText"]);
const SHEET_RUN_CONTAINERS = new Set(["si", "is", "text", "r", "rPr", "rPh"]);
type View = "final" | "original" | "web";
/** Distinct namespaces a part may make a consumer choose between; 2^6 readings at most. */
const MAX_ALTERNATIVE_NAMESPACES = 6;
const MAX_DISPLAY_PIECES = 30_000;

function displayedText(styles: WordStyles | undefined) {
  const frames: Frame[] = [{ kind: undefined, needs: [], own: [], story: 0, runs: [], flags: 0, ignorable: new Set(), process: new Set() }];
  const pieces: Piece[] = [];
  const addPiece = (piece: Piece) => {
    if (pieces.length >= MAX_DISPLAY_PIECES) throw new Error("Office XML has too many text pieces to inspect within the synchronous work bound");
    pieces.push(piece);
  };
  let stories = 0;

  const runVanish = (run: WordRun) => run.vanish
    ?? styleVanish(styles, "character", run.style ?? styles?.defaultOf.get("character"))
    ?? styleVanish(styles, "paragraph", run.paragraph?.style ?? styles?.defaultOf.get("paragraph"))
    ?? styles?.defaults ?? false;
  const markVanish = (mark: WordParagraph) => mark.special || (mark.vanish
    ?? styleVanish(styles, "character", mark.markStyle)
    ?? styleVanish(styles, "paragraph", mark.style ?? styles?.defaultOf.get("paragraph"))
    ?? styles?.defaults ?? false);
  const hidden = (piece: Piece, view: View) => {
    if (piece.flags & FIELD) return true;
    if (piece.flags & (view === "original" ? INSERTED : DELETED)) return true;
    if (piece.runs.some(run => (view === "original" ? run.originalVanish ?? runVanish(run) : runVanish(run)) || (view === "web" && run.web))) return true;
    const mark = piece.mark;
    return !!mark && (markVanish(mark) || !!(view === "original" ? mark.inserted : mark.deleted) || (view === "web" && !!mark.web));
  };

  return {
    open(tag: SaxesTagNS, resolve: (prefix: string) => string | undefined) {
      const parent = frames.at(-1)!;
      const attribute = (uri: string, local: string) => Object.values(tag.attributes).find(a => a.uri === uri && a.local === local)?.value;
      const prefixes = (value: string | undefined) => value?.split(/[ \t\r\n]+/).filter(Boolean) ?? [];
      const uriOf = (prefix: string) => resolve(prefix) ?? `unbound:${prefix}`;
      const frame: Frame = { ...parent, tag, kind: undefined, own: parent.needs, alternate: undefined };
      const ignorable = prefixes(attribute(COMPATIBILITY, "Ignorable"));
      if (ignorable.length) frame.ignorable = new Set([...parent.ignorable, ...ignorable.map(uriOf)]);
      const process = prefixes(attribute(COMPATIBILITY, "ProcessContent"));
      if (process.length) frame.process = new Set([...parent.process, ...process.map(name => {
        const colon = name.indexOf(":");
        return colon === -1 ? name : `${uriOf(name.slice(0, colon))} ${name.slice(colon + 1)}`;
      })]);
      // A consumer that does not understand an ignorable namespace drops the
      // element, keeping only the children of one it was asked to process.
      if (tag.uri !== COMPATIBILITY && frame.ignorable.has(tag.uri)) {
        frame.own = [...parent.needs, { ns: tag.uri }];
        if (!frame.process.has(`${tag.uri} ${tag.local}`) && !frame.process.has(`${tag.uri} *`)) frame.needs = frame.own;
      }
      if (parent.alternate) {
        // A consumer shows the first choice whose namespaces it understands, else the fallback.
        const choice = tag.uri === COMPATIBILITY && tag.local === "Choice", fallback = tag.uri === COMPATIBILITY && tag.local === "Fallback";
        const need: Need = choice || fallback
          ? { alternate: parent.alternate, branch: parent.alternate.branches.push({ requires: choice ? prefixes(attribute("", "Requires")).map(uriOf) : null }) - 1 }
          : { never: true };
        frame.needs = frame.own = [...frame.needs, need];
      } else if (tag.uri === COMPATIBILITY && tag.local === "AlternateContent") frame.alternate = { branches: [] };

      const local = tag.local;
      if (WORD.has(tag.uri)) {
        const paragraph = parent.paragraph, run = parent.run;
        if (parent.kind === "pPr" && local === "pStyle") paragraph!.style = wordValue(tag, "val");
        else if (parent.kind === "pPr" && local === "rPr") frame.kind = "mark";
        else if (parent.kind === "mark") {
          if (local === "vanish") paragraph!.vanish = wordOn(tag);
          else if (local === "specVanish") paragraph!.special = wordOn(tag);
          else if (local === "rStyle") paragraph!.markStyle = wordValue(tag, "val");
          else if (local === "webHidden") paragraph!.web = wordOn(tag);
          else if (local === "del" || local === "moveFrom") paragraph!.deleted = true;
          else if (local === "ins" || local === "moveTo") paragraph!.inserted = true;
        } else if (parent.kind === "rPr" && local === "rPrChange") frame.kind = "rPrChange";
        else if (parent.kind === "rPrChange" && local === "rPr") frame.kind = "oldRPr";
        else if (parent.kind === "rPr" || parent.kind === "oldRPr") {
          if (local === "vanish" && parent.kind === "oldRPr") run!.originalVanish = wordOn(tag);
          else if (local === "vanish") run!.vanish = wordOn(tag);
          else if (local === "rStyle") run!.style = wordValue(tag, "val");
          else if (local === "webHidden") run!.web = wordOn(tag);
        } else if (local === "p") {
          frame.kind = "p";
          frame.paragraph = {};
        } else if (local === "pPr" && parent.kind === "p") frame.kind = "pPr";
        else if (local === "rPr" && parent.kind === "r") frame.kind = "rPr";
        else if (local === "del" || local === "moveFrom" || local === "delText") frame.flags |= DELETED;
        else if (local === "ins" || local === "moveTo") frame.flags |= INSERTED;
        else if (local === "instrText" || local === "delInstrText") frame.flags |= FIELD;
        else if (local === "drawing" || local === "pict" || local === "object" || local === "rt") frame.story = ++stories;
      } else if (SHEET.has(tag.uri) && local === "rPh") frame.story = ++stories;
      if ((WORD.has(tag.uri) || MATH.has(tag.uri)) && local === "r" && parent.kind !== "rPr" && parent.kind !== "mark") {
        frame.kind = "r";
        frame.run = { paragraph: frame.paragraph };
        frame.runs = [...parent.runs, frame.run];
      }
      frames.push(frame);
    },
    text(text: string) {
      const frame = frames.at(-1)!, tag = frame.tag;
      // Office lays out text only from its text leaves; characters written
      // straight into a run, a paragraph or an alternative container are not shown.
      if (!text || frame.alternate || (tag && ((WORD.has(tag.uri) && !WORD_TEXT.has(tag.local))
        || ((DRAWING.has(tag.uri) || MATH.has(tag.uri)) && tag.local !== "t") || (SHEET.has(tag.uri) && SHEET_RUN_CONTAINERS.has(tag.local))))) return;
      addPiece({ text, needs: frame.own, story: frame.story, runs: frame.runs, flags: frame.flags });
    },
    close(tag: SaxesTagNS) {
      const frame = frames.pop()!;
      const parent = frames.at(-1)?.tag;
      const boundary = SHEET.has(tag.uri) && (tag.local === "phoneticPr" || tag.local === "rPh") ? "" : officeBoundary(tag, parent).text;
      if (boundary) {
        addPiece({ text: boundary, needs: frame.own, story: frame.story, runs: frame.runs, flags: frame.flags,
          ...(frame.kind === "p" ? { mark: frame.paragraph } : {}) });
      }
    },
    /** Every distinct story of every reading, within `limit` characters. */
    readings(limit: number): string[] {
      const alternates = new Set<Alternate>(), namespaces = new Set<string>(), views = new Set<View>(["final"]);
      for (const piece of pieces) {
        for (const need of piece.needs) {
          if ("ns" in need) namespaces.add(need.ns);
          else if ("alternate" in need) alternates.add(need.alternate);
        }
        if (piece.flags & (DELETED | INSERTED) || piece.mark?.deleted || piece.mark?.inserted
          || piece.runs.some(run => run.originalVanish !== undefined)) views.add("original");
        if (piece.runs.some(run => run.web) || piece.mark?.web) views.add("web");
      }
      for (const alternate of alternates) for (const branch of alternate.branches) for (const uri of branch.requires ?? []) namespaces.add(uri);
      const conservativeStyleView = !!styles?.possiblyHidden;
      if (conservativeStyleView) views.add("original");
      const variable = [...namespaces];
      if (variable.length > MAX_ALTERNATIVE_NAMESPACES) throw new Error("Office XML offers too many markup-compatibility alternatives to inspect");
      const found = new Set<string>();
      let size = 0;
      for (let mask = 0; mask < 1 << variable.length; mask++) {
        const understood = new Set(variable.filter((_, index) => mask & (1 << index)));
        const chosen = new Map<Alternate, number>();
        for (const alternate of alternates) {
          const choice = alternate.branches.findIndex(branch => branch.requires?.every(uri => understood.has(uri)));
          chosen.set(alternate, choice !== -1 ? choice : alternate.branches.findIndex(branch => branch.requires === null));
        }
        const shows = (need: Need) => "ns" in need ? understood.has(need.ns) : "alternate" in need && chosen.get(need.alternate) === need.branch;
        for (const view of views) {
          const reading = new Map<number, string[]>();
          for (const piece of pieces) {
            if (!piece.needs.every(shows) || hidden(piece, view)
              || (conservativeStyleView && view === "original" && piece.runs.some(run => run.vanish === undefined))) continue;
            const story = reading.get(piece.story);
            if (story) story.push(piece.text);
            else reading.set(piece.story, [piece.text]);
          }
          for (const story of reading.values()) {
            const text = story.join("");
            if (found.has(text)) continue;
            size += text.length;
            if (size > limit) throw new Error("Office XML alternatives exceed the inspection limit");
            found.add(text);
          }
        }
      }
      return [...found];
    },
  };
}

/* What the cells of one workbook hold, for reading the text its formulas join. */
type WorkbookContext = {
  sharedStrings?: readonly string[];
  /** Characters of formula readings the whole package may produce. */
  budget?: { left: number };
};
/** The characters of formula readings a package may produce: the displayed-reading allowance. */
const formulaReadingBudget = (length: number) => 4 * length + (1 << 20);
const MAX_FORMULA_REFERENCES = 64;
const CELL_REFERENCE = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/;

/**
 * The text a formula puts together, as Excel would show it before any
 * function runs: each string literal and the stored text of each same-sheet
 * single-cell reference (`A1`, `$A$1`), in the order written and with nothing
 * between them. Ranges, references to another sheet or workbook, table
 * references and names are not read. Null when the formula names more cells
 * than {@link MAX_FORMULA_REFERENCES}, which cannot be read within the bound.
 */
export function formulaReading(formula: string, cellText: (reference: string) => string | undefined): { text: string; references: number } | null {
  let text = "";
  let references = 0;
  /* After a sheet qualifier or a range operator, the next token belongs to another sheet or a range. */
  let foreign = false;
  let index = 0;
  const quoted = (quote: string, from: number) => {
    let literal = "", end = from;
    for (; end < formula.length; end++) {
      if (formula[end] !== quote) { literal += formula[end]; continue; }
      if (formula[end + 1] !== quote) break;
      literal += quote;
      end++;
    }
    return { literal, next: end + 1 };
  };
  while (index < formula.length) {
    const char = formula[index]!;
    if (char === '"') {
      const { literal, next } = quoted('"', index + 1);
      text += literal;
      index = next;
      foreign = false;
    } else if (char === "'") {
      index = quoted("'", index + 1).next;
      foreign = true;
    } else if (char === "[") {
      let depth = 0;
      for (; index < formula.length; index++) {
        if (formula[index] === "[") depth++;
        else if (formula[index] === "]" && --depth === 0) { index++; break; }
      }
    } else if (/[A-Za-z0-9_.$\\]/.test(char)) {
      let end = index + 1;
      while (end < formula.length && /[A-Za-z0-9_.$\\]/.test(formula[end]!)) end++;
      const token = formula.slice(index, end);
      const after = formula[end];
      index = end;
      if (after === "!" || after === ":") { foreign = true; index++; continue; }
      if (foreign || after === "(" || after === "[") { foreign = false; continue; }
      if (!CELL_REFERENCE.test(token)) continue;
      if (++references > MAX_FORMULA_REFERENCES) return null;
      text += cellText(token.replace(/\$/g, "").toUpperCase()) ?? "";
    } else {
      index++;
      if (char === ":" || char === "!") foreign = true;
      else if (!/\s/.test(char)) foreign = false;
    }
  }
  return { text, references };
}

/** Join adjacent runs, retaining text inside leaves and real layout boundaries.
 * Readings are returned one line apart: one keeps every leaf's text as
 * written, the second trims XML whitespace from the edges of leaves outside
 * `xml:space="preserve"`, as Office does when it lays the text out, so a
 * whitespace-only run cannot split a token in both, and the third trims the
 * same way and also ends every element outside the run-bearing namespaces, so
 * neighbouring leaves cannot glue onto a token. The displayed readings follow:
 * each story of the text a consumer shows, in every view and for every set of
 * markup-compatibility namespaces it may understand, leaving out hidden runs
 * (directly or through `styles`), field instructions, the side of a tracked
 * change the view hides and unselected alternatives, so text Office does not
 * display cannot split a token it does. Those trim only a leaf that does not
 * itself preserve its spaces. Fatal decoding and parsing apply to XML parts
 * even after a secret is found. */
function officeXmlTextInspection(name: string, bytes: Buffer, styles?: WordStyles, workbook?: WorkbookContext): { text: string | null; requiresConsent: boolean } {
  if (!/\.(?:xml|rels|vml|svg)$/i.test(name) && !startsWithXml(bytes, xmlEncoding(bytes))) return { text: null, requiresConsent: false };
  const pieces: string[] = [];
  const compact: string[] = [];
  const separated: string[] = [];
  const attributes: string[] = [];
  const formulaLiterals: string[] = [];
  let formulaDepth = 0;
  let formulaText = "";
  let requiresConsent = false;
  /* A cell's stored text, by reference, and each formula as written: what a
     formula joins is read once the whole sheet is known, so a formula may name a later cell. */
  type Cell = { reference: string; type: string; value: string; inline: string; formula: string };
  let cell: Cell | null = null;
  let inValue = 0, inInline = 0, inText = 0, inPhonetic = 0;
  const storedText = new Map<string, string>();
  const formulas: string[] = [];
  const open: SaxesTagNS[] = [];
  const hasChild: boolean[] = [];
  const preserve: boolean[] = [];
  const ownPreserve: boolean[] = [];
  const pending: string[] = [];
  const shown = displayedText(styles);
  const trim = (text: string) => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const flush = (keepWhitespace: boolean) => {
    const text = pending.join("");
    pending.length = 0;
    if (!text || !(keepWhitespace || /[^ \t\r\n]/.test(text))) return;
    pieces.push(text);
    const trimmed = preserve.at(-1) ? text : trim(text);
    compact.push(trimmed);
    separated.push(trimmed);
    shown.text(ownPreserve.at(-1) ? text : trim(text));
  };

  const length = parseOfficeXml(bytes, {
    open(tag, resolve) {
      flush(false);
      if (hasChild.length) hasChild[hasChild.length - 1] = true;
      hasChild.push(false);
      let preserved = preserve.at(-1) ?? false, own = false;
      for (const attribute of Object.values(tag.attributes)) {
        if (attribute.uri === XML_NAMESPACE && attribute.local === "space") {
          preserved = attribute.value === "preserve";
          own = preserved;
        }
        if (attribute.uri !== "http://www.w3.org/2000/xmlns/") attributes.push(attribute.value);
      }
      preserve.push(preserved);
      ownPreserve.push(own);
      shown.open(tag, resolve);
      if (SHEET.has(tag.uri)) {
        if (tag.local === "c") cell = { reference: (plainValue(tag, "r") ?? "").toUpperCase(), type: plainValue(tag, "t") ?? "n", value: "", inline: "", formula: "" };
        else if (tag.local === "v") inValue++;
        else if (tag.local === "is") inInline++;
        else if (tag.local === "t") inText++;
        else if (tag.local === "rPh") inPhonetic++;
        else if (tag.local === "f") { formulaDepth++; formulaText = ""; }
      }
      if (tag.local === "numFmt") {
        const format = Object.values(tag.attributes).find(value => value.uri === "" && value.local === "formatCode")?.value;
        if (format) {
          const literals = format.split(";").map(section => section.replace(/\\(.)/g, "$1").replace(/"([^"]*)"/g, "$1"));
          formulaLiterals.push(...literals.filter(Boolean));
        }
      }
      open.push(tag);
    },
    text(text) {
      pending.push(text);
      if (formulaDepth) formulaText += text;
      if (cell) {
        if (inValue) cell.value += text;
        else if (inInline && inText && !inPhonetic) cell.inline += text;
      }
    },
    close(tag) {
      flush(!hasChild.pop());
      preserve.pop();
      ownPreserve.pop();
      open.pop();
      if (SHEET.has(tag.uri)) {
        if (tag.local === "v") inValue--;
        else if (tag.local === "is") inInline--;
        else if (tag.local === "t") inText--;
        else if (tag.local === "rPh") inPhonetic--;
        else if (tag.local === "f" && formulaDepth) {
          formulaDepth--;
          const literal = [...formulaText.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1]!.replace(/""/g, '"')).join("");
          if (literal) formulaLiterals.push(literal);
          if (cell && formulaText.trim()) cell.formula = formulaText;
          formulaText = "";
        } else if (tag.local === "c" && cell) {
          const stored = cell.type === "inlineStr" ? cell.inline : cell.type === "s" ? (/^\s*\d+\s*$/.test(cell.value) ? workbook?.sharedStrings?.[Number(cell.value)] : undefined) ?? "" : cell.value;
          if (cell.reference && stored) storedText.set(cell.reference, stored);
          if (cell.formula) formulas.push(cell.formula);
          cell = null;
        }
      }
      const { text, separated: apart } = officeBoundary(tag, open.at(-1));
      pieces.push(text);
      compact.push(text);
      separated.push(apart);
      shown.close(tag);
    },
  });
  /* What each formula joins from cells, one line each. A budget that runs out, or a
     formula too wide to read, leaves computed text nobody inspected: that needs consent. */
  const budget = workbook?.budget ?? { left: formulaReadingBudget(length) };
  const formulaReadings: string[] = [];
  for (const formula of formulas) {
    const reading = formulaReading(formula, reference => storedText.get(reference));
    if (!reading || reading.text.length > budget.left) { requiresConsent = true; break; }
    budget.left -= reading.text.length;
    if (reading.references && reading.text) formulaReadings.push(reading.text);
  }
  // Attribute values are separate from the displayed text and from each other.
  return { text: [pieces.join(""), compact.join(""), separated.join(""), ...shown.readings(4 * length + (1 << 20)), ...formulaLiterals, ...formulaReadings, ...attributes].join("\n"), requiresConsent };
}

export function officeXmlText(name: string, bytes: Buffer, styles?: WordStyles, workbook?: WorkbookContext): string | null {
  return officeXmlTextInspection(name, bytes, styles, workbook).text;
}
