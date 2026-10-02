import { withoutUnsupportedApiCredentials } from "../src/lib/environmentIsolation";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { domainToASCII } from "node:url";
import { inflateSync } from "node:zlib";

import { decodeHTMLStrict } from "entities";

import {
  compactSensitiveText,
  fingerprintKey,
  knownValueFingerprint,
  parseKnownValues,
  type KnownValue,
  type KnownValueFingerprint,
} from "./generate-privacy-known-value-fingerprints";

export { compactSensitiveText } from "./generate-privacy-known-value-fingerprints";

export type FindingClass =
  | "configuration_error"
  | "credential"
  | "email_address"
  | "home_path"
  | "inspection_error"
  | "known_value"
  | "media_live_source"
  | "private_network"
  | "provenance_invalid"
  | "provenance_missing"
  | "resource_identifier"
  | "tool_unavailable"
  | "transcript_content"
  | "unsafe_path";

type ProvenanceAsset = {
  classification?: unknown;
  description?: unknown;
  expectedFindingClasses?: unknown;
  generator?: unknown;
  generatorRuntime?: unknown;
  generatorSha256?: unknown;
  generatorVersion?: unknown;
  path?: unknown;
  sha256?: unknown;
  source?: unknown;
  sourceDigests?: unknown;
};

const allowedClassifications = new Set([
  "adversarial-synthetic",
  "redacted-placeholder",
  "synthetic",
]);
const adversarialFindingClasses = new Set<FindingClass>([
  "credential",
  "email_address",
  "home_path",
  "private_network",
  "resource_identifier",
  "transcript_content",
]);
const rasterExtensions = new Set([".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const animatedExtensions = new Set([".avi", ".gif", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const audioExtensions = new Set([".mp3", ".wav"]);
const textExtensions = new Set([
  ".cjs", ".conf", ".css", ".csv", ".env", ".graphql", ".htm", ".html", ".ini", ".js", ".json",
  ".jsx", ".lock", ".md", ".mdx", ".mjs", ".properties", ".sh", ".svg", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml", ".zsh",
]);
const textBasenames = new Set(["CODEOWNERS", "Dockerfile", "LICENSE", "Makefile", "README"]);
const maxPublicationBytes = 32 * 1024 * 1024;
const maxVideoStreams = 16;
const supportedGeneratorRuntime = "bun-1.3.3";
const credentialInputPattern = new RegExp([
  String.raw`<in`,
  String.raw`put\b(?=[^>]*(?:type\s*=\s*["']?password|name\s*=\s*["']?(?:api[_-]?key|password|secret|token)))`,
  String.raw`(?=[^>]*value\s*=\s*(?:["'][^"']{4,}["']|[^\s"'=<>]{4,}))[^>]*>`,
].join(""), "i");

type SafePathResult = {
  metadata?: ReturnType<typeof lstatSync>;
  status: "missing" | "safe" | "symlink";
};

type MediaKind = "animated" | "audio" | "png" | "raster";

function safePath(path: string): SafePathResult {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(root);
  } catch {
    return { status: "missing" };
  }
  if (metadata.isSymbolicLink()) return { status: "symlink" };
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      metadata = lstatSync(current);
    } catch {
      return { status: "missing" };
    }
    if (metadata.isSymbolicLink()) return { status: "symlink" };
  }
  return { metadata, status: "safe" };
}

function readSafeRegularFile(path: string): Buffer {
  const result = safePath(path);
  if (result.status !== "safe" || !result.metadata?.isFile()) throw new Error("unsafe file path");
  return readFileSync(resolve(path));
}

function loadKnownValues(): { error: boolean; fingerprints: KnownValueFingerprint[]; values: KnownValue[] } {
  let values: KnownValue[];
  try {
    const format = process.env.LLV_PRIVACY_KNOWN_VALUES_FORMAT ?? "plain";
    if (format !== "plain" && format !== "jsonl") throw new Error("invalid known-value format");
    const jsonLines = format === "jsonl";
    values = parseKnownValues(process.env.LLV_PRIVACY_KNOWN_VALUES ?? "", jsonLines);
    const file = process.env.LLV_PRIVACY_KNOWN_VALUES_FILE;
    if (file) values.push(...parseKnownValues(readSafeRegularFile(file).toString("utf8"), jsonLines));
    values = values.filter((entry) => entry.value.length >= 4);
  } catch {
    return { error: true, fingerprints: [], values: [] };
  }
  const fingerprints = new Map<string, KnownValueFingerprint>();
  for (const value of values) {
    const fingerprint = knownValueFingerprint(value);
    if (fingerprint) fingerprints.set(fingerprintKey(fingerprint), fingerprint);
  }
  const fingerprintFile = process.env.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE;
  if (fingerprintFile) {
    try {
      const catalog = JSON.parse(readSafeRegularFile(fingerprintFile).toString("utf8")) as {
        fingerprints?: unknown;
        normalization?: unknown;
        schemaVersion?: unknown;
      };
      if (catalog.schemaVersion !== 1 || catalog.normalization !== "nfkc-lower-alnum-v1" || !Array.isArray(catalog.fingerprints)) {
        return { error: true, fingerprints: [], values: [] };
      }
      for (const candidate of catalog.fingerprints) {
        if (typeof candidate !== "object" || candidate === null) return { error: true, fingerprints: [], values: [] };
        const fingerprint = candidate as Partial<KnownValueFingerprint>;
        if (!Number.isSafeInteger(fingerprint.length) || (fingerprint.length ?? 0) < 4 || (fingerprint.length ?? 0) > 512) {
          return { error: true, fingerprints: [], values: [] };
        }
        if (typeof fingerprint.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint.sha256)) {
          return { error: true, fingerprints: [], values: [] };
        }
        if (fingerprint.exactOnly !== undefined && typeof fingerprint.exactOnly !== "boolean") {
          return { error: true, fingerprints: [], values: [] };
        }
        const valid = fingerprint as KnownValueFingerprint;
        fingerprints.set(fingerprintKey(valid), valid);
      }
    } catch {
      return { error: true, fingerprints: [], values: [] };
    }
  }
  return {
    error: false,
    fingerprints: [...fingerprints.values()],
    values,
  };
}

const knownValues = loadKnownValues();

function configuredOcrLanguages(): string | undefined {
  const languages = (process.env.LLV_PRIVACY_OCR_LANGUAGES ?? "eng").trim();
  return /^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/i.test(languages) ? languages : undefined;
}

function extensionMediaKind(path: string): MediaKind | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "png";
  if (rasterExtensions.has(extension)) return "raster";
  if (animatedExtensions.has(extension)) return "animated";
  return undefined;
}

function signatureMediaKind(bytes: Buffer): MediaKind | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "raster";
  const prefix = bytes.subarray(0, 12).toString("latin1");
  if (prefix.startsWith("ID3")
    || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WAVE") return "audio";
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "animated";
  if (prefix.startsWith("BM")) return "raster";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
    || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return "raster";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "AVI ") return "animated";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
    const webpChunks = bytes.subarray(12).toString("latin1");
    return webpChunks.includes("ANIM") || webpChunks.includes("ANMF") ? "animated" : "raster";
  }
  if (bytes.length >= 8 && bytes.subarray(4, 8).toString("latin1") === "ftyp") return "animated";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "animated";
  return undefined;
}

function mediaKind(path: string): MediaKind | undefined {
  try {
    const signature = signatureMediaKind(readFileSync(path));
    if (signature === "audio" && !audioExtensions.has(extname(path).toLowerCase())) return undefined;
    return signature ?? extensionMediaKind(path);
  } catch {
    return extensionMediaKind(path);
  }
}

function requestedPaths(arguments_: string[]): string[] | undefined {
  const separator = arguments_.indexOf("--paths");
  return separator === -1 ? undefined : arguments_.slice(separator + 1);
}

function argumentValue(arguments_: string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function gitPaths(repository: string, arguments_: string[]): { error: boolean; paths: string[] } {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repository, ...arguments_],
    env: withoutUnsupportedApiCredentials(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return { error: true, paths: [] };
  return {
    error: false,
    paths: result.stdout.toString().split("\0").filter(Boolean),
  };
}

function changedPaths(arguments_: string[], repository: string): { error: boolean; paths: string[] } {
  const baseIndex = arguments_.indexOf("--base");
  const base = baseIndex === -1 ? "origin/main" : arguments_[baseIndex + 1];
  if (!base || base.startsWith("--")) return { error: true, paths: [] };
  const commands = [
    ["diff", "--name-only", "--diff-filter=ACMRT", "-z", `${base}...HEAD`],
    ["diff", "--name-only", "--diff-filter=ACMRT", "-z"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const paths = new Set<string>();
  for (const command of commands) {
    const result = gitPaths(repository, command);
    if (result.error) return { error: true, paths: [] };
    for (const path of result.paths) paths.add(resolve(repository, path));
  }
  return { error: false, paths: [...paths] };
}

function addFinding(findings: Map<FindingClass, number>, finding: FindingClass): void {
  findings.set(finding, (findings.get(finding) ?? 0) + 1);
}

function decodePercentEncoding(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function decodeHtmlEntities(text: string): string {
  return decodeHTMLStrict(text);
}

function decodeCommonMarkEscapes(text: string): string {
  return text.replaceAll(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function removeDefaultIgnorables(text: string): string {
  return text.replaceAll(/\p{Default_Ignorable_Code_Point}/gu, "");
}

/** Keep source positions only for characters a decoding step leaves untouched. */
function decodeWithOffsets(
  text: string,
  decode: (value: string) => string,
  tokens: RegExp,
  offsets?: number[],
): string {
  const decoded = decode(text);
  if (!offsets || decoded === text) return decoded;
  const nextOffsets: number[] = [];
  let cursor = 0;
  const mapped = text.replace(tokens, (token: string, index: number) => {
    for (; cursor < index; cursor += 1) nextOffsets.push(offsets[cursor]);
    const replacement = decode(token);
    for (let i = 0; i < replacement.length; i += 1) {
      nextOffsets.push(replacement === token ? offsets[index + i] : -1);
    }
    cursor = index + token.length;
    return replacement;
  });
  for (; cursor < text.length; cursor += 1) nextOffsets.push(offsets[cursor]);
  offsets.length = decoded.length;
  // A decoder shape outside the mapped tokens still gets scanned in full,
  // but cannot confer a RAW exemption without proven source correspondence.
  for (let i = 0; i < decoded.length; i += 1) offsets[i] = mapped === decoded ? nextOffsets[i] : -1;
  return decoded;
}

function decodeSensitiveText(text: string, preserveDefaultIgnorables: boolean, offsets?: number[]): { error: boolean; text: string } {
  const strip = preserveDefaultIgnorables ? (value: string): string => value
    : (value: string): string => decodeWithOffsets(value, removeDefaultIgnorables, /\p{Default_Ignorable_Code_Point}/gu, offsets);
  let decoded = strip(text);
  for (let pass = 0; pass < 16; pass += 1) {
    const next = strip(
      decodeWithOffsets(
        decodeWithOffsets(
          decodeWithOffsets(decoded, decodePercentEncoding, /(?:%[0-9a-f]{2})+/gi, offsets),
          decodeHtmlEntities, /&[^&;\s]*;/g, offsets,
        ),
        decodeCommonMarkEscapes, /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, offsets,
      ),
    );
    if (next === decoded) return { error: false, text: decoded };
    decoded = next;
  }
  return { error: true, text: decoded };
}

export function canonicalSensitiveText(text: string): { error: boolean; text: string } {
  return decodeSensitiveText(text, false);
}

function visibleMarkdownText(text: string, sourceOffsets?: number[]): string {
  let visible = "";
  const append = (start: number, end: number): void => {
    visible += text.slice(start, end);
    if (sourceOffsets) {
      for (let index = start; index < end; index += 1) sourceOffsets.push(index);
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const labelStart = text[cursor] === "["
      ? cursor
      : (text[cursor] === "!" && text[cursor + 1] === "[" ? cursor + 1 : -1);
    if (labelStart === -1) {
      append(cursor, cursor + 1);
      cursor += 1;
      continue;
    }
    let labelEnd = labelStart + 1;
    let labelDepth = 0;
    for (; labelEnd < text.length; labelEnd += 1) {
      if (text[labelEnd] === "\\" && labelEnd + 1 < text.length) {
        labelEnd += 1;
        continue;
      }
      if (text[labelEnd] === "[") labelDepth += 1;
      if (text[labelEnd] !== "]") continue;
      if (labelDepth === 0) break;
      labelDepth -= 1;
    }
    if (labelEnd >= text.length || text[labelEnd + 1] !== "(") {
      append(cursor, cursor + 1);
      cursor += 1;
      continue;
    }
    let destinationEnd = labelEnd + 2;
    let destinationDepth = 0;
    for (; destinationEnd < text.length; destinationEnd += 1) {
      if (text[destinationEnd] === "\\" && destinationEnd + 1 < text.length) {
        destinationEnd += 1;
        continue;
      }
      if (text[destinationEnd] === "(") {
        destinationDepth += 1;
        continue;
      }
      if (text[destinationEnd] !== ")") continue;
      if (destinationDepth === 0) break;
      destinationDepth -= 1;
    }
    if (destinationEnd >= text.length) {
      append(cursor, cursor + 1);
      cursor += 1;
      continue;
    }
    append(labelStart + 1, labelEnd);
    cursor = destinationEnd + 1;
  }
  return visible;
}

/**
 * The views of a text the gate reads: the decoded source, and the same text
 * with the markdown that can hide a character from a reader taken out. Both
 * are scanned whole. Nothing is ever subtracted from them for being
 * uninteresting — a caller that exempts something exempts an occurrence
 * detection already reported, never a span of text before detection runs.
 */
function sensitiveTextViews(text: string): { error: boolean; views: [string, string] } {
  const canonical = canonicalSensitiveText(text);
  const decoded = canonical.text.replaceAll("\0", "\n");
  const withoutMarkup = visibleMarkdownText(decoded).replaceAll(/<[^>]*>/g, "").replaceAll(/[\[\]*_`~]/g, "");
  return { error: canonical.error, views: [decoded, withoutMarkup] };
}

function normalizedSensitiveText(text: string): { compact: string; error: boolean; exactSearchable: string; searchable: string } {
  const { error, views } = sensitiveTextViews(text);
  const [decoded, withoutMarkup] = views;
  return {
    compact: `${compactSensitiveText(decoded)}\0${compactSensitiveText(withoutMarkup)}`,
    error,
    searchable: `${decoded}\n${withoutMarkup}`,
    // Preserve separators and attributes; rendered markup projection can join
    // characters that were split in the publication source.
    exactSearchable: decoded.normalize("NFKC").toLocaleLowerCase("en-US"),
  };
}

function matchesKnownFingerprint(text: string, exactOnly = false): boolean {
  const fingerprintsByLength = new Map<number, Set<string>>();
  for (const fingerprint of knownValues.fingerprints) {
    if ((fingerprint.exactOnly === true) !== exactOnly) continue;
    const hashes = fingerprintsByLength.get(fingerprint.length) ?? new Set<string>();
    hashes.add(fingerprint.sha256);
    fingerprintsByLength.set(fingerprint.length, hashes);
  }
  for (const [length, hashes] of fingerprintsByLength) {
    if (length > text.length) continue;
    for (let index = 0; index <= text.length - length; index += 1) {
      const digest = createHash("sha256").update(text.slice(index, index + length)).digest("hex");
      if (hashes.has(digest)) return true;
    }
  }
  return false;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function metadataStrings(bytes: Buffer): string[] {
  if (bytes.length > 1024 * 1024) throw new Error("metadata limit exceeded");
  const strings: string[] = [...(bytes.toString("latin1").match(/[\x20-\x7e]{4,}/g) ?? [])];
  const utf8 = bytes.toString("utf8");
  if (!utf8.includes("\ufffd")) strings.push(utf8);
  for (const alignment of [0, 1]) {
    const end = bytes.length - ((bytes.length - alignment) % 2);
    if (end - alignment < 8) continue;
    const aligned = bytes.subarray(alignment, end);
    strings.push(aligned.toString("utf16le"));
    const swapped = Buffer.from(aligned);
    swapped.swap16();
    strings.push(swapped.toString("utf16le"));
  }
  return strings;
}

function internationalText(data: Buffer): string[] {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 1 || keywordEnd + 4 > data.length) throw new Error("invalid iTXt keyword");
  const compressionFlag = data[keywordEnd + 1];
  const compressionMethod = data[keywordEnd + 2];
  if ((compressionFlag !== 0 && compressionFlag !== 1) || compressionMethod !== 0) {
    throw new Error("invalid iTXt compression");
  }
  const languageEnd = data.indexOf(0, keywordEnd + 3);
  if (languageEnd === -1) throw new Error("invalid iTXt language");
  const translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd === -1) throw new Error("invalid iTXt translation");
  const encodedText = data.subarray(translatedEnd + 1);
  const text = compressionFlag === 1
    ? inflateSync(encodedText, { maxOutputLength: 1024 * 1024 })
    : encodedText;
  return [
    data.subarray(0, keywordEnd).toString("latin1"),
    data.subarray(keywordEnd + 3, languageEnd).toString("ascii"),
    data.subarray(languageEnd + 1, translatedEnd).toString("utf8"),
    text.toString("utf8"),
  ];
}

function pngMetadata(bytes: Buffer): { animated?: boolean; error: boolean; liveSource?: boolean; text: string } {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { error: true, text: "" };
  }
  const values: string[] = [];
  let animated = false;
  let liveSource = false;
  let offset = 8;
  let iendOffset = -1;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 16 * 1024 * 1024 || end > bytes.length) return { error: true, text: "" };
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      return { error: true, text: "" };
    }
    if (type === "acTL") {
      if (animated || data.length !== 8 || data.readUInt32BE(0) < 1) return { error: true, text: "" };
      animated = true;
    }
    if (type === "tEXt") {
      const separator = data.indexOf(0);
      if (separator > 0 && data.subarray(0, separator).toString("latin1") === "capture-source"
        && data.subarray(separator + 1).toString("latin1").startsWith("live-")) {
        liveSource = true;
      }
      values.push(data.toString("latin1"));
    }
    if (type === "iTXt") {
      try {
        const decoded = internationalText(data);
        values.push(...decoded);
        if (decoded[0] === "capture-source" && decoded[3].startsWith("live-")) liveSource = true;
      } catch {
        return { error: true, text: "" };
      }
    }
    if (type === "zTXt") {
      const separator = data.indexOf(0);
      if (separator === -1 || data[separator + 1] !== 0) return { error: true, text: "" };
      try {
        const keyword = data.subarray(0, separator).toString("latin1");
        const decoded = inflateSync(data.subarray(separator + 2), { maxOutputLength: 1024 * 1024 }).toString("latin1");
        values.push(keyword, decoded);
        if (keyword === "capture-source" && decoded.startsWith("live-")) liveSource = true;
      } catch {
        return { error: true, text: "" };
      }
    }
    if (type === "iCCP") {
      const separator = data.indexOf(0);
      if (separator < 1 || separator + 2 > data.length || data[separator + 1] !== 0) {
        return { error: true, text: "" };
      }
      try {
        values.push(data.subarray(0, separator).toString("latin1"));
        const profile = inflateSync(data.subarray(separator + 2), { maxOutputLength: 1024 * 1024 });
        values.push(...metadataStrings(profile));
      } catch {
        return { error: true, text: "" };
      }
    }
    if (type === "eXIf") {
      try {
        values.push(...metadataStrings(data));
      } catch {
        return { error: true, text: "" };
      }
    }
    offset = end;
    if (type === "IEND") {
      if (length !== 0) return { error: true, text: "" };
      iendOffset = end;
      break;
    }
  }
  if (iendOffset === -1) return { error: true, text: "" };
  if (iendOffset < bytes.length) {
    try {
      values.push(...metadataStrings(bytes.subarray(iendOffset)));
    } catch {
      return { error: true, text: "" };
    }
  }
  if (values.some((value) => value.includes("capture-source\0live-"))) liveSource = true;
  return { animated, error: false, liveSource, text: values.join("\n") };
}

function inspectRasterMetadata(path: string, kind: MediaKind | undefined): Set<FindingClass> {
  if (kind !== "png" && kind !== "raster") return new Set();
  try {
    const bytes = readFileSync(path);
    if (kind === "png") {
      const metadata = pngMetadata(bytes);
      if (metadata.error) return new Set(["inspection_error"]);
      const findings = sensitiveClasses(metadata.text);
      if (metadata.animated) findings.add("inspection_error");
      if (metadata.liveSource) findings.add("media_live_source");
      return findings;
    }
    if (bytes.length > 32 * 1024 * 1024) return new Set(["inspection_error"]);
    const printableMetadata = bytes.toString("latin1").match(/[\x20-\x7e]{4,}/g)?.join("\n") ?? "";
    return sensitiveClasses(printableMetadata);
  } catch {
    return new Set(["inspection_error"]);
  }
}

type EmailOccurrence = {
  address: string;
  domain: string;
  index: number;
  localPart: string;
};

/* A mailbox the way RFC 5322 spells one. The local part is a dot-atom or a
   quoted string, and the quoted form may carry spaces, dots and a second `@`
   inside the quotes — it reaches a person exactly like the plain form, so
   detection reads both rather than only the shape that is easy to match. */
const quotedLocalPart = /"(?:[^"\\\r\n]|\\.)*"/;
const dotAtomLocalPart = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+/;
// These contextual code points belong to valid IDNA labels. Detection keeps
// them; the unit exemption below depends only on its positive ASCII boundary.
const idnaDomainLabel = String.raw`(?:[A-Z0-9\p{L}\p{M}\p{N}\p{Default_Ignorable_Code_Point}\u00B7\u0375\u05F3\u05F4\u0F0B\u30FB-]|\\x[0-9a-f]{2})+`;
const idnaDomainSeparator = String.raw`[.\u3002\uFF0E\uFF61]`;
const emailDomain = new RegExp(
  `(${idnaDomainLabel}(?:${idnaDomainSeparator}${idnaDomainLabel})+)`,
  "iu",
);
const emailAddressSource =
  `(${quotedLocalPart.source}|${dotAtomLocalPart.source})@${emailDomain.source}`;

// Only complete RAW package-version tokens earn this exemption. Detection
// keeps every view intact; source correspondence is checked per occurrence.
const packageVersionSource = String.raw`[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?`;
const packageVersionBoundary = String.raw`(?=$|[\x09-\x0d "'\x60)\],;:\\])`;

const rawPackageVersion = new RegExp(`${packageVersionSource}${packageVersionBoundary}`, "y");

function isEscapedAsciiControlBoundary(text: string, offset: number): boolean {
  if (offset + 1 === text.length) return true;
  const escape = /^\\(?:([bfnrtv])|x([0-9a-f]{2})|u([0-9a-f]{4})|u\{([0-9a-f]{1,6})\})/i.exec(text.slice(offset));
  if (!escape) return false;
  const simpleEscapes: Record<string, number> = { b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };
  const codePoint = escape[1]
    ? simpleEscapes[escape[1].toLowerCase()]
    : Number.parseInt(escape[2] ?? escape[3] ?? escape[4], 16);
  return codePoint <= 0x20 || codePoint === 0x7f;
}
const packageVersionFollowing = /^[\x09-\x0d "'`)\],;:\\]$/;

/* RFC 6761 reserves `.test` for exactly this and guarantees it can never
   resolve to anyone — the same reason `.invalid` is already skipped here.
   Flagging it made fixture addresses in test files indistinguishable from a
   real one, which teaches everybody to wave the gate through. */
function domainNamesNobody(domain: string): boolean {
  // Keep reserved fixture-domain handling separate from the unit exemption.
  let asciiDomain: string;
  try {
    asciiDomain = domainToASCII(domain);
  } catch {
    // Some runtimes throw for rejected IDNA input. It earns no exemption.
    return false;
  }
  if (!asciiDomain) return false;
  const lowered = asciiDomain.toLowerCase();
  return lowered === "example.com" || lowered === "example.net" || lowered === "example.org"
    || lowered.endsWith(".invalid") || lowered.endsWith(".test");
}

/* Exempt only one ASCII instance label (including systemd hex escapes) and
   one non-delegated unit type. The positive boundary makes this independent
   of which Unicode/IDNA continuations the mailbox matcher can consume. */
const systemdUnitDomain = /^(?:[A-Z0-9-]|\\x[0-9a-f]{2})+\.(?:service|socket|scope|slice|timer|mount|automount|path|device|swap)$/i;
const systemdUnitBoundary = /^[\x09-\x0d /"'`)\],;:]$/;

type EmailTextView = {
  text: string;
  source?: { text: string; offsets: number[]; raw: { text: string; offsets: number[] } };
};

function markdownEmailView(decoded: string, raw: { text: string; offsets: number[] }): EmailTextView {
  const offsets: number[] = [];
  const visible = visibleMarkdownText(decoded, offsets);
  const parts: string[] = [];
  const keptOffsets: number[] = [];
  const append = (start: number, end: number): void => {
    parts.push(visible.slice(start, end));
    for (let index = start; index < end; index += 1) keptOffsets.push(offsets[index]);
  };
  let start = 0;
  for (const match of visible.matchAll(/<[^>]*>|[\[\]*_`~]/g)) {
    append(start, match.index);
    start = match.index + match[0].length;
  }
  append(start, visible.length);
  return {
    text: parts.join(""),
    source: {
      text: decoded, offsets: keptOffsets,
      raw: { text: raw.text, offsets: keptOffsets.map((offset) => raw.offsets[offset]) },
    },
  };
}

function emailTextViews(text: string): EmailTextView[] {
  const views: EmailTextView[] = [{ text }];
  for (const preserveDefaultIgnorables of [true, false]) {
    const offsets = Array.from({ length: text.length }, (_, index) => index);
    const decodedText = decodeSensitiveText(text, preserveDefaultIgnorables, offsets).text;
    const decoded = preserveDefaultIgnorables ? decodedText : decodedText.replaceAll("\0", "\n");
    const raw = { text, offsets };
    views.push({ text: decoded, source: {
      text: decoded, offsets: Array.from({ length: decoded.length }, (_, index) => index), raw,
    } }, markdownEmailView(decoded, raw));
  }
  return views;
}

function rawPackageVersionEnd(text: string, domainStart: number, source?: EmailTextView["source"]): number | undefined {
  const start = domainStart - 1; // Include the @: an encoded separator earns no exemption.
  const rawStart = source ? source.raw.offsets[start] : start;
  if (rawStart === undefined || rawStart < 0) return undefined;
  const rawText = source ? source.raw.text : text;
  if (rawText[rawStart] !== "@") return undefined;
  rawPackageVersion.lastIndex = rawStart + 1;
  const version = rawPackageVersion.exec(rawText)?.[0];
  if (!version || version.endsWith(".")) return undefined;
  const end = start + 1 + version.length;
  if (text.slice(start, end) !== "@" + version) return undefined;
  if (source) {
    for (let i = start; i < end; i += 1) {
      if (source.raw.offsets[i] !== rawStart + i - start) return undefined;
    }
  }
  const following = text[end];
  if (following === "\\") {
    if (!isEscapedAsciiControlBoundary(text, end)) return undefined;
  } else if (following !== undefined && !packageVersionFollowing.test(following)
    && !(following === "." && (text[end + 1] === undefined || /^[\x09-\x0d ]$/.test(text[end + 1])))) {
    return undefined;
  }
  return end;
}

/** Every mailbox in the text that reaches a person, in the order they appear. */
function* emailOccurrences(text: string, source?: EmailTextView["source"]): Generator<EmailOccurrence> {
  const pattern = new RegExp(emailAddressSource, "giu");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const following = text[pattern.lastIndex];
    const exemptVersionEnd = !match[1].startsWith('"')
      ? rawPackageVersionEnd(text, pattern.lastIndex - match[2].length, source)
      : undefined;
    if (exemptVersionEnd !== undefined) {
      pattern.lastIndex = exemptVersionEnd;
      continue;
    }
    // A quoted mailbox can contain another real address. Systemd names have
    // unquoted local parts, so that outer mailbox earns no unit exemption.
    if (!match[1].startsWith('"') && systemdUnitDomain.test(match[2])) {
      const boundary = following === undefined || systemdUnitBoundary.test(following);
      if (!source && boundary) continue;
      // Projection cannot create an exemption: the same source domain and
      // its original boundary must qualify too. A removed Markdown delimiter
      // may leave a sentence-ending period, never a domain continuation.
      if (source && (boundary || (following === "."
        && (text[pattern.lastIndex + 1] === undefined || /^[\x09-\x0d ]$/.test(text[pattern.lastIndex + 1]))))) {
        const sourceStart = source.offsets[pattern.lastIndex - match[2].length];
        const sourceEnd = source.offsets[pattern.lastIndex - 1] + 1;
        const sourceFollowing = source.text[sourceEnd];
        if (source.text.slice(sourceStart, sourceEnd) === match[2]
          && (sourceFollowing === undefined || systemdUnitBoundary.test(sourceFollowing))) continue;
      }
    }
    if (domainNamesNobody(match[2])) continue;
    yield { address: match[0], domain: match[2], index: match.index, localPart: match[1] };
  }
}

function hasEmailAddress(text: string, source?: EmailTextView["source"]): boolean {
  return emailOccurrences(text, source).next().done !== true;
}

export function sensitiveClasses(text: string): Set<FindingClass> {
  const findings = new Set<FindingClass>();
  const { compact, error, exactSearchable, searchable: searchableText } = normalizedSensitiveText(text);
  if (error) findings.add("inspection_error");
  const normalizedText = searchableText.toLocaleLowerCase("en-US");
  if (knownValues.values.some((entry) => entry.exactOnly
    ? exactSearchable.includes(entry.value.normalize("NFKC").toLocaleLowerCase("en-US"))
    : normalizedText.includes(entry.value.toLocaleLowerCase("en-US")))
    || matchesKnownFingerprint(compact) || matchesKnownFingerprint(exactSearchable, true)) {
    findings.add("known_value");
  }
  const unixHomePattern = /(?:^|[\s"'(=:/])\/(?:home|Users)\/([A-Za-z0-9._-]+)(?:\/|$)/gm;
  for (let match = unixHomePattern.exec(searchableText); match; match = unixHomePattern.exec(searchableText)) {
    if (match[1].toLowerCase() === "user") continue;
    findings.add("home_path");
    break;
  }
  const windowsHomePattern = /(?:^|[\s"'(])[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)(?:\\|$)/gim;
  for (let match = windowsHomePattern.exec(searchableText); match; match = windowsHomePattern.exec(searchableText)) {
    if (match[1].toLowerCase() === "user") continue;
    findings.add("home_path");
    break;
  }
  // Decode encoded boundaries without removing their default-ignorable code
  // points. Both the original and decoded characters must meet the unit rule.
  if (emailTextViews(text).some((view) => hasEmailAddress(view.text, view.source))) findings.add("email_address");
  const credentialAssignmentPattern = /(?:api[_-]?(?:key|token)|access[_-]?token|authorization|password|secret)\s*[:=]\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|[^\s"'`]{12,})/i;
  if (credentialAssignmentPattern.test(searchableText)) {
    findings.add("credential");
  }
  if (/\b(?:github_pat_|gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/.test(searchableText)) {
    findings.add("credential");
  }
  const separator = String.raw`[^a-z0-9\r\n]{1,8}`;
  const splitTokenPrefix = new RegExp([
    `g${separator}i${separator}t${separator}h${separator}u${separator}b${separator}p${separator}a${separator}t`,
    `g${separator}h${separator}[pousr]`,
    `x${separator}o${separator}x${separator}[baprs]`,
    `s${separator}k`,
  ].join("|") + String.raw`[^a-z0-9\r\n]{0,8}?[_-][^a-z0-9\r\n]*`, "gi");
  for (const line of searchableText.split(/\r?\n/)) {
    splitTokenPrefix.lastIndex = 0;
    for (let match = splitTokenPrefix.exec(line); match; match = splitTokenPrefix.exec(line)) {
      const compactTail = compactSensitiveText(line.slice(match.index));
      if (/^(?:githubpat|gh[pousr]|xox[baprs]|sk)[a-z0-9]{12,}/i.test(compactTail)) {
        findings.add("credential");
        break;
      }
    }
    if (findings.has("credential")) break;
  }
  if (/\bauthorization\s*[:=]\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(searchableText)) {
    findings.add("credential");
  }
  if (/https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(searchableText)) {
    findings.add("credential");
  }
  if (credentialInputPattern.test(searchableText)) {
    findings.add("credential");
  }
  if (/\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/.test(searchableText)) {
    findings.add("private_network");
  }
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(searchableText)) {
    findings.add("resource_identifier");
  }
  if (/(?:^|\n)\s*(?:assistant|prompt|transcript|user)\s*:\s*\S/im.test(searchableText)) {
    findings.add("transcript_content");
  }
  return findings;
}

function inspectText(path: string, kind: MediaKind | undefined): Set<FindingClass> {
  if (kind) return new Set();
  try {
    const contents = readFileSync(path);
    const utf8 = contents.toString("utf8");
    const views = [utf8];
    const startsUtf32LittleEndian = contents.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0x00, 0x00]));
    const startsUtf32BigEndian = contents.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0xfe, 0xff]));
    const startsLittleEndian = !startsUtf32LittleEndian
      && contents.length >= 2
      && contents[0] === 0xff
      && contents[1] === 0xfe;
    const startsBigEndian = !startsUtf32BigEndian
      && contents.length >= 2
      && contents[0] === 0xfe
      && contents[1] === 0xff;
    let supportedEncoding = false;
    if (startsLittleEndian || startsBigEndian) {
      const payload = Buffer.from(contents.subarray(2));
      if (payload.length % 2 === 0) {
        if (startsBigEndian) payload.swap16();
        try {
          views.push(new TextDecoder("utf-16le", { fatal: true }).decode(payload));
          supportedEncoding = true;
        } catch {
          supportedEncoding = false;
        }
      }
    } else if (!startsUtf32LittleEndian && !startsUtf32BigEndian) {
      try {
        views[0] = new TextDecoder("utf-8", { fatal: true }).decode(contents);
        supportedEncoding = true;
      } catch {
        supportedEncoding = false;
      }
    }
    if (contents.includes(0) && !startsLittleEndian && !startsBigEndian) {
      for (const alignment of [0, 1]) {
        const end = contents.length - ((contents.length - alignment) % 2);
        if (end - alignment < 4) continue;
        const aligned = contents.subarray(alignment, end);
        views.push(aligned.toString("utf16le"));
        const swapped = Buffer.from(aligned);
        swapped.swap16();
        views.push(swapped.toString("utf16le"));
      }
    }
    const findings = sensitiveClasses(views.join("\n"));
    const extension = extname(path).toLowerCase();
    const textLike = textExtensions.has(extension) || textBasenames.has(basename(path));
    const controlBytes = contents.reduce((count, byte) => {
      const allowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
      return count + (byte < 0x20 && !allowedWhitespace ? 1 : 0);
    }, 0);
    const excessiveControlBytes = !startsLittleEndian
      && !startsBigEndian
      && controlBytes > 0
      && controlBytes * 8 > contents.length;
    const unsupportedBinary = !textLike && (!supportedEncoding || controlBytes > 0);
    const invalidTextEncoding = textLike && (!supportedEncoding || excessiveControlBytes);
    if (unsupportedBinary || invalidTextEncoding) findings.add("inspection_error");
    return findings;
  } catch {
    return new Set(["inspection_error"]);
  }
}

function inspectRaster(path: string, kind: MediaKind | undefined): Set<FindingClass> {
  if (kind !== "png" && kind !== "raster") return new Set();
  if (!Bun.which("tesseract")) return new Set(["tool_unavailable"]);
  const languages = configuredOcrLanguages();
  if (!languages) return new Set(["configuration_error"]);
  const result = Bun.spawnSync({
    cmd: ["tesseract", path, "stdout", "-l", languages],
    env: withoutUnsupportedApiCredentials(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return new Set(["inspection_error"]);
  return sensitiveClasses(result.stdout.toString());
}

function inspectAnimated(path: string, kind: MediaKind | undefined): Set<FindingClass> {
  if (kind !== "animated") return new Set();
  if (!Bun.which("ffprobe") || !Bun.which("ffmpeg") || !Bun.which("tesseract")) {
    return new Set(["tool_unavailable"]);
  }
  const languages = configuredOcrLanguages();
  if (!languages) return new Set(["configuration_error"]);
  const probe = Bun.spawnSync({
    cmd: [
      "ffprobe",
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v",
      "-show_entries",
      "format=duration:format_tags:stream=duration,nb_frames,nb_read_frames:stream_tags",
      "-of",
      "json",
      path,
    ],
    env: withoutUnsupportedApiCredentials(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (probe.exitCode !== 0) return new Set(["inspection_error"]);
  const findings = sensitiveClasses(probe.stdout.toString());
  let formatDuration = 0;
  let streams: Array<{ duration?: unknown; nb_frames?: unknown; nb_read_frames?: unknown }>;
  try {
    const metadata = JSON.parse(probe.stdout.toString()) as {
      format?: { duration?: unknown };
      streams?: unknown;
    };
    formatDuration = Number(metadata.format?.duration);
    if (!Number.isFinite(formatDuration) || formatDuration < 0) formatDuration = 0;
    if (!Array.isArray(metadata.streams) || metadata.streams.length === 0 || metadata.streams.length > maxVideoStreams
      || metadata.streams.some((stream) => typeof stream !== "object" || stream === null || Array.isArray(stream))) {
      findings.add("inspection_error");
      return findings;
    }
    streams = metadata.streams as Array<{ duration?: unknown; nb_frames?: unknown; nb_read_frames?: unknown }>;
  } catch {
    return new Set([...findings, "inspection_error"]);
  }
  const fractions = [0, 0.25, 0.5, 0.75, 0.95];
  for (const [streamOrdinal, stream] of streams.entries()) {
    let duration = Number(stream.duration);
    if (!Number.isFinite(duration) || duration < 0) duration = formatDuration;
    let frameCount = 0;
    for (const candidate of [stream.nb_read_frames, stream.nb_frames]) {
      const count = Number(candidate);
      if (!Number.isSafeInteger(count) || count < 1) continue;
      frameCount = count;
      break;
    }
    if (duration === 0 && frameCount === 0) {
      findings.add("inspection_error");
      continue;
    }
    const samples = duration > 0
      ? fractions.map((fraction) => ({ kind: "time" as const, value: (duration * fraction).toFixed(3) }))
      : fractions.map((fraction) => ({
        kind: "frame" as const,
        value: Math.floor((frameCount - 1) * fraction).toString(),
      }));
    const uniqueSamples = new Map(samples.map((sample) => [`${sample.kind}:${sample.value}`, sample]));
    for (const sample of uniqueSamples.values()) {
      const inputArguments = sample.kind === "time"
        ? ["-ss", sample.value, "-i", path]
        : ["-i", path];
      const filterArguments = sample.kind === "frame" ? ["-vf", `select=eq(n\\,${sample.value})`] : [];
      const frame = Bun.spawnSync({
        cmd: [
          "ffmpeg",
          "-v",
          "error",
          ...inputArguments,
          "-map",
          `0:v:${streamOrdinal}`,
          ...filterArguments,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        env: withoutUnsupportedApiCredentials(process.env),
        stderr: "pipe",
        stdout: "pipe",
      });
      if (frame.exitCode !== 0 || frame.stdout.length === 0) {
        findings.add("inspection_error");
        continue;
      }
      const ocr = Bun.spawnSync({
        cmd: ["tesseract", "stdin", "stdout", "-l", languages],
        env: withoutUnsupportedApiCredentials(process.env),
        stdin: frame.stdout,
        stderr: "pipe",
        stdout: "pipe",
      });
      if (ocr.exitCode !== 0) {
        findings.add("inspection_error");
        continue;
      }
      for (const finding of sensitiveClasses(ocr.stdout.toString())) findings.add(finding);
    }
  }
  return findings;
}

type ProvenanceResult = {
  expectedFindingClasses: Set<FindingClass>;
  status: "invalid" | "missing" | "valid";
};

type ReproducedAsset = {
  asset: ProvenanceAsset;
  sha256: string;
};

const reproducedCatalogs = new Map<string, Map<string, ReproducedAsset> | undefined>();

function pathIsWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function canonicalPathIsWithin(root: string, candidate: string): boolean {
  if (safePath(root).status !== "safe" || safePath(candidate).status !== "safe") return false;
  return pathIsWithin(realpathSync(root), realpathSync(candidate));
}

function repositoryRelativePath(root: string, candidate: string): string | undefined {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.split(sep).join("/");
}

function collectReproducedAssets(root: string, directory: string, assets: Map<string, ReproducedAsset>): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!collectReproducedAssets(root, path, assets)) return false;
      continue;
    }
    if (!entry.isFile() || entry.name !== "privacy-manifest.json") continue;
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { assets?: unknown; schemaVersion?: unknown };
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.assets)) return false;
    for (const candidate of manifest.assets) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
      const asset = candidate as ProvenanceAsset;
      if (typeof asset.path !== "string" || asset.path.length === 0 || isAbsolute(asset.path)) return false;
      const assetPath = resolve(dirname(path), asset.path);
      const key = repositoryRelativePath(root, assetPath);
      if (!key || assets.has(key) || !canonicalPathIsWithin(root, assetPath)) return false;
      const metadata = safePath(assetPath);
      if (metadata.status !== "safe" || !metadata.metadata?.isFile()) return false;
      assets.set(key, {
        asset,
        sha256: createHash("sha256").update(readFileSync(assetPath)).digest("hex"),
      });
    }
  }
  return true;
}

function reproduceTrustedGenerator(generatorBytes: Buffer): Map<string, ReproducedAsset> | undefined {
  const generatorHash = createHash("sha256").update(generatorBytes).digest("hex");
  if (reproducedCatalogs.has(generatorHash)) return reproducedCatalogs.get(generatorHash);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "llv-privacy-generator-"));
  let catalog: Map<string, ReproducedAsset> | undefined;
  try {
    const scriptsDirectory = join(temporaryRoot, "scripts");
    mkdirSync(scriptsDirectory, { recursive: true });
    const isolatedGenerator = join(scriptsDirectory, "generate-privacy-placeholders.ts");
    writeFileSync(isolatedGenerator, generatorBytes);
    const generation = Bun.spawnSync({
      cmd: [process.execPath, isolatedGenerator],
      cwd: temporaryRoot,
      env: withoutUnsupportedApiCredentials(process.env),
      stderr: "pipe",
      stdout: "pipe",
    });
    if (generation.exitCode === 0) {
      const generatedAssets = new Map<string, ReproducedAsset>();
      if (collectReproducedAssets(temporaryRoot, temporaryRoot, generatedAssets)) catalog = generatedAssets;
    }
  } catch {
    catalog = undefined;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
  reproducedCatalogs.set(generatorHash, catalog);
  return catalog;
}

function matchesTrustedReproduction(
  path: string,
  generatorPath: string,
  asset: ProvenanceAsset,
  inspectionRoot: string | undefined,
): boolean {
  if (!repositoryRoot || !inspectionRoot || typeof asset.generatorSha256 !== "string") return false;
  const relativeGenerator = repositoryRelativePath(inspectionRoot, generatorPath);
  const relativeAsset = repositoryRelativePath(inspectionRoot, path);
  if (!relativeGenerator || !relativeAsset) return false;
  const trustedGeneratorPath = resolve(repositoryRoot, relativeGenerator);
  if (!canonicalPathIsWithin(repositoryRoot, trustedGeneratorPath)) return false;
  const trustedGenerator = safePath(trustedGeneratorPath);
  if (trustedGenerator.status !== "safe" || !trustedGenerator.metadata?.isFile()) return false;
  const trustedGeneratorBytes = readFileSync(trustedGeneratorPath);
  const trustedHash = createHash("sha256").update(trustedGeneratorBytes).digest("hex");
  if (trustedHash !== asset.generatorSha256) return false;
  const reproduced = reproduceTrustedGenerator(trustedGeneratorBytes)?.get(relativeAsset);
  return reproduced !== undefined
    && reproduced.sha256 === asset.sha256
    && isDeepStrictEqual(reproduced.asset, asset);
}

function assetExistsInTrustedBase(
  manifestPath: string,
  asset: ProvenanceAsset,
  inspectionRoot: string | undefined,
  trustedBase: string | undefined,
): boolean {
  if (!inspectionRoot || !trustedBase || trustedBase.startsWith("--")) return false;
  if (!canonicalPathIsWithin(inspectionRoot, manifestPath)) return false;
  const relativeManifest = relative(resolve(inspectionRoot), resolve(manifestPath));
  if (relativeManifest === "" || relativeManifest === ".." || relativeManifest.startsWith(`..${sep}`) || isAbsolute(relativeManifest)) {
    return false;
  }
  const result = Bun.spawnSync({
    cmd: ["git", "-C", inspectionRoot, "show", `${trustedBase}:${relativeManifest.split(sep).join("/")}`],
    env: withoutUnsupportedApiCredentials(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return false;
  try {
    const manifest = JSON.parse(result.stdout.toString()) as { assets?: unknown; schemaVersion?: unknown };
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.assets)) return false;
    const trustedAsset = manifest.assets.find((candidate) => {
      return typeof candidate === "object" && candidate !== null
        && (candidate as ProvenanceAsset).path === asset.path;
    });
    return trustedAsset !== undefined && isDeepStrictEqual(trustedAsset, asset);
  } catch {
    return false;
  }
}

function currentRepositoryRoot(): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--show-toplevel"],
    env: withoutUnsupportedApiCredentials(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  const root = result.stdout.toString().trim();
  return root.length > 0 ? resolve(root) : undefined;
}

const repositoryRoot = currentRepositoryRoot();

function provenanceFor(path: string, inspectionRoot = repositoryRoot, trustedBase?: string): ProvenanceResult {
  const manifestPath = join(dirname(path), "privacy-manifest.json");
  const invalid: ProvenanceResult = { expectedFindingClasses: new Set(), status: "invalid" };
  const manifestPathResult = safePath(manifestPath);
  if (manifestPathResult.status === "missing") return { expectedFindingClasses: new Set(), status: "missing" };
  if (manifestPathResult.status !== "safe" || !manifestPathResult.metadata?.isFile()) return invalid;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      assets?: unknown;
      schemaVersion?: unknown;
    };
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.assets)) return invalid;
    const asset = manifest.assets.find((candidate): candidate is ProvenanceAsset => {
      if (typeof candidate !== "object" || candidate === null) return false;
      return (candidate as ProvenanceAsset).path === basename(path);
    });
    if (!asset) return invalid;
    if (typeof asset.classification !== "string" || !allowedClassifications.has(asset.classification)) return invalid;
    if (typeof asset.description !== "string" || asset.description.trim().length < 12) return invalid;
    if (typeof asset.generator !== "string" || asset.generator.length === 0 || isAbsolute(asset.generator)) return invalid;
    const generatorPath = resolve(dirname(manifestPath), asset.generator);
    const provenanceRoot = inspectionRoot && canonicalPathIsWithin(inspectionRoot, path) ? inspectionRoot : dirname(manifestPath);
    if (!canonicalPathIsWithin(provenanceRoot, generatorPath)) return invalid;
    const generatorMetadata = safePath(generatorPath);
    if (generatorMetadata.status !== "safe" || !generatorMetadata.metadata?.isFile()) return invalid;
    const generatorBytes = readFileSync(generatorPath);
    if (asset.generatorRuntime !== supportedGeneratorRuntime) return invalid;
    const runtimeVersion = supportedGeneratorRuntime.slice("bun-".length);
    const escapedRuntimeVersion = runtimeVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const runtimeDeclaration = new RegExp(`\\bPRIVACY_GENERATOR_RUNTIME\\s*=\\s*["']${escapedRuntimeVersion}["']`);
    if (!runtimeDeclaration.test(generatorBytes.toString("utf8"))) return invalid;
    if (typeof asset.generatorVersion !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(asset.generatorVersion)) return invalid;
    const escapedVersion = asset.generatorVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const versionDeclaration = new RegExp(`\\bPRIVACY_GENERATOR_VERSION\\s*=\\s*["']${escapedVersion}["']`);
    if (!versionDeclaration.test(generatorBytes.toString("utf8"))) return invalid;
    if (typeof asset.generatorSha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.generatorSha256)) return invalid;
    const generatorHash = createHash("sha256").update(generatorBytes).digest("hex");
    if (generatorHash !== asset.generatorSha256) return invalid;
    const expectedSource = asset.classification === "redacted-placeholder" ? "redacted-live-capture" : "deterministic-generator";
    if (asset.source !== expectedSource) return invalid;
    if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) return invalid;
    const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actualHash !== asset.sha256) return invalid;
    if (!Array.isArray(asset.sourceDigests) || asset.sourceDigests.length === 0 || asset.sourceDigests.length > 16) return invalid;
    const sourceDigests = new Set<string>();
    for (const digest of asset.sourceDigests) {
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || digest === actualHash) return invalid;
      sourceDigests.add(digest);
    }
    if (sourceDigests.size !== asset.sourceDigests.length) return invalid;
    if (asset.classification !== "adversarial-synthetic") {
      if (asset.expectedFindingClasses !== undefined) return invalid;
      if (!matchesTrustedReproduction(path, generatorPath, asset, inspectionRoot)) return invalid;
      return { expectedFindingClasses: new Set(), status: "valid" };
    }
    if (!assetExistsInTrustedBase(manifestPath, asset, inspectionRoot, trustedBase)) return invalid;
    const fixtureDirectory = dirname(path).split(/[\\/]/).some((segment) => /(?:^|-)fixtures?$/.test(segment));
    if (!fixtureDirectory || !Array.isArray(asset.expectedFindingClasses) || asset.expectedFindingClasses.length === 0) return invalid;
    const expectedFindingClasses = new Set<FindingClass>();
    for (const finding of asset.expectedFindingClasses) {
      if (typeof finding !== "string" || !adversarialFindingClasses.has(finding as FindingClass)) return invalid;
      expectedFindingClasses.add(finding as FindingClass);
    }
    if (expectedFindingClasses.size !== asset.expectedFindingClasses.length) return invalid;
    return { expectedFindingClasses, status: "valid" };
  } catch {
    return invalid;
  }
}

/**
 * Hashes a complete vendor directory as an ordered stream of relative paths,
 * portable executable-bit state, byte lengths, and file bytes. The directory
 * is rejected when any entry is a symlink or a non-file/non-directory node,
 * so a trusted digest authenticates the complete tree shape and contents.
 */
export function trustedVendorRootDigest(root: string): string | null {
  const rootResult = safePath(root);
  if (rootResult.status !== "safe" || !rootResult.metadata?.isDirectory()) return null;
  const files: Array<{ executable: boolean; relativePath: string }> = [];
  const pending = [""];
  try {
    while (pending.length > 0) {
      const relativeDirectory = pending.pop()!;
      const directory = join(root, relativeDirectory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relativeEntry = join(relativeDirectory, entry.name);
        const absoluteEntry = join(root, relativeEntry);
        const entryResult = safePath(absoluteEntry);
        if (entryResult.status !== "safe") return null;
        if (entry.isDirectory() && entryResult.metadata?.isDirectory()) {
          pending.push(relativeEntry);
        } else if (entry.isFile() && entryResult.metadata?.isFile()) {
          files.push({ executable: (Number(entryResult.metadata.mode) & 0o111) !== 0, relativePath: relativeEntry });
        } else {
          return null;
        }
      }
    }
    if (files.length === 0) return null;
    const digest = createHash("sha256");
    files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
    for (const file of files) {
      const bytes = readFileSync(join(root, file.relativePath));
      const portablePath = file.relativePath.split(sep).join("/");
      digest.update("file\0");
      digest.update(portablePath);
      digest.update("\0");
      digest.update(file.executable ? "x" : "-");
      digest.update("\0");
      digest.update(String(bytes.length));
      digest.update("\0");
      digest.update(bytes);
      digest.update("\0");
    }
    return digest.digest("hex");
  } catch {
    return null;
  }
}

export function trustedVendorRootMatches(root: string, expectedDigest: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) return false;
  return trustedVendorRootDigest(root) === expectedDigest;
}

/**
 * The reviewed chigwell/telegram-mcp v3.2.22 tree plus the issue #1059 patches
 * that remove invite-link mutation tools from the read-only registry and cap
 * dialog pagination. This digest is trusted scanner policy: candidate content
 * cannot update it.
 */
export const TRUSTED_TELEGRAM_VENDOR_ROOT_DIGEST = "8f3238a84139bff7ef88f522c60affc5880183f9f23048a39e124191c5e6619d";
export const TRUSTED_TELEGRAM_VENDOR_EXEMPT_FINDING_CLASSES: ReadonlySet<FindingClass> = new Set(["credential", "home_path"]);

const trustedTelegramVendor = {
  digest: TRUSTED_TELEGRAM_VENDOR_ROOT_DIGEST,
  exemptFindingClasses: TRUSTED_TELEGRAM_VENDOR_EXEMPT_FINDING_CLASSES,
  relativeRoot: "vendor/telegram-mcp",
};

function trustedVendorExemptions(path: string, inspectionRoot: string | undefined): ReadonlySet<FindingClass> {
  if (!inspectionRoot) return new Set();
  const vendorRoot = join(inspectionRoot, ...trustedTelegramVendor.relativeRoot.split("/"));
  if (!canonicalPathIsWithin(vendorRoot, path)) return new Set();
  return trustedVendorRootMatches(vendorRoot, trustedTelegramVendor.digest)
    ? trustedTelegramVendor.exemptFindingClasses
    : new Set();
}

export function inspectPaths(
  paths: string[],
  configurationError = false,
  requireKnownValues = false,
  inspectionRoot = repositoryRoot,
  trustedBase?: string,
  attributionNotices: string[] = [],
): Map<FindingClass, number> {
  const findings = new Map<FindingClass, number>();
  if (knownValues.error || configurationError || (requireKnownValues && knownValues.fingerprints.length === 0)) {
    addFinding(findings, "configuration_error");
  }
  for (const path of paths) {
    const pathResult = safePath(path);
    if (pathResult.status === "symlink" || (pathResult.status === "safe" && !pathResult.metadata?.isFile())) {
      addFinding(findings, "unsafe_path");
      continue;
    }
    if (pathResult.status === "missing" || !pathResult.metadata) {
      addFinding(findings, "inspection_error");
      continue;
    }
    if (pathResult.metadata.size > maxPublicationBytes) {
      addFinding(findings, "inspection_error");
      continue;
    }
    const pathFindings = new Set<FindingClass>();
    const kind = mediaKind(path);
    for (const finding of inspectRasterMetadata(path, kind)) pathFindings.add(finding);
    for (const finding of inspectRaster(path, kind)) pathFindings.add(finding);
    for (const finding of inspectAnimated(path, kind)) pathFindings.add(finding);
    for (const finding of inspectText(path, kind)) pathFindings.add(finding);
    if (kind && kind !== "audio") {
      const provenance = provenanceFor(path, inspectionRoot, trustedBase);
      if (provenance.status === "missing") pathFindings.add("provenance_missing");
      if (provenance.status === "invalid") pathFindings.add("provenance_invalid");
      if (provenance.status === "valid" && provenance.expectedFindingClasses.size > 0) {
        const actualAdversarial = new Set([...pathFindings].filter((finding) => adversarialFindingClasses.has(finding)));
        const matches = actualAdversarial.size === provenance.expectedFindingClasses.size
          && [...actualAdversarial].every((finding) => provenance.expectedFindingClasses.has(finding));
        if (matches) {
          for (const finding of provenance.expectedFindingClasses) pathFindings.delete(finding);
        } else {
          pathFindings.add("provenance_invalid");
        }
      }
    }
    const vendorExemptions = trustedVendorExemptions(path, inspectionRoot);
    for (const finding of vendorExemptions) pathFindings.delete(finding);
    for (const finding of pathFindings) {
      addFinding(findings, finding);
      const repositoryPath = relative(inspectionRoot ?? resolve("."), path).split(sep).join("/");
      if (!repositoryPath || repositoryPath.startsWith("../") || isAbsolute(repositoryPath)) continue;
      let lines: number[] = [];
      if (!kind) {
        try {
          lines = readFileSync(path, "utf8").split(/\r?\n/)
            .flatMap((line, index) => sensitiveClasses(line).has(finding) ? [index + 1] : []);
        } catch { /* The aggregate finding still carries a path-only notice. */ }
      }
      const pathDigest = createHash("sha256").update(repositoryPath).digest("hex");
      if (lines.length) {
        attributionNotices.push(...lines.map((line) => `file-sha256:${pathDigest}:${line} ${finding}`));
      } else {
        attributionNotices.push(`file-sha256:${pathDigest} ${finding}`);
      }
    }
  }
  return findings;
}

export function formatPrivacyReport(findings: Map<FindingClass, number>, notices: string[] = []): string {
  if (findings.size === 0) {
    return "PRIVACY GATE: PASS\n";
  }
  const lines = ["PRIVACY GATE: FAIL"];
  for (const [finding, count] of [...findings].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`${finding}: ${count}`);
  }
  /* File notices carry only a digest of the relative path and an optional
     line, so neither sensitive contents nor sensitive filename components
     reach public check logs. */
  lines.push(...notices);
  return `${lines.join("\n")}\n`;
}

const COMMIT_HASH = /^[0-9a-f]{40}$/;

const commitMessageFindingClasses = new Set<FindingClass>([
  "credential",
  "email_address",
  "home_path",
  "known_value",
]);

/**
 * Attribution trailers naming a TOOL rather than a person.
 *
 * A commit message is a publication surface and its trailers are the one part
 * of it a human never writes by hand, so they need a rule of their own. The
 * general vendor carve-out requires the exact local part `noreply`/`no-reply`.
 * The forge's automated sign-off uses one additional role address: the
 * `support` local part on its own `github.com` domain. Other local parts remain
 * attributable, including `<id>+<handle>@users.noreply.github.com`, which is
 * an account handle with a number in front of it.
 *
 * The exemption names an address the scan already found, never a span of text
 * to skip: three rounds of narrowing what to remove before scanning each left
 * another shape that survived the removal. So an address is dropped from the
 * result only when it is one of these role mailboxes AND it sits on a
 * machine-attribution trailer inside the trailer block. Everything else on
 * that line — a second address, a home path, a credential — was read anyway.
 */
const MACHINE_ATTRIBUTION_TRAILER = /^(?:co-authored-by|signed-off-by)[ \t]*:/i;
const FORGE_ROLE_LOCAL_PART = "support";
const FORGE_DOMAIN = "github.com";

function isMachineAttributionAddress(occurrence: EmailOccurrence): boolean {
  /* No vendor signs off with a quoted local part, and treating one as the same
     mailbox as the plain form would mean unquoting RFC 5322 inside a gate that
     has to fail closed, so a quoted role name stays attributable. */
  if (occurrence.localPart.startsWith('"')) return false;
  const localPart = occurrence.localPart.toLowerCase();
  if (localPart === "noreply" || localPart === "no-reply") return true;
  return localPart === FORGE_ROLE_LOCAL_PART && occurrence.domain.toLowerCase() === FORGE_DOMAIN;
}

/* Git reads a trailer block as a message's last paragraph: a run of
   `Token: value` lines that a blank line separates from everything before it,
   each token starting the line. A line anywhere else with the same shape is
   body prose, and prose is where people quote other people's addresses. */
const COMMIT_TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*:[ \t]*\S/;

/* `git cherry-pick -x` writes this line into the trailer block it copies, and
   git still reads that block as one — it is a prefix git generates itself. A
   block does not stop being a block because git annotated it. */
const CHERRY_PICK_TRAILER_LINE = /^\(cherry picked from commit [0-9a-f]{7,64}\)[ \t]*$/;

function isTrailerLine(line: string): boolean {
  return COMMIT_TRAILER_LINE.test(line) || CHERRY_PICK_TRAILER_LINE.test(line);
}

/* One commit message can carry several. A squash merge writes every commit of
   a pull request into one message — each behind a `* <subject>` bullet, the
   forge's own co-author paragraph behind a horizontal rule — and each of those
   messages keeps the trailer block it was written with. So git's rule reads
   every message the text concatenates, not only the last one. The bullets
   count only when the text IS that concatenation, which the forge marks by
   bulleting the paragraph right after the title; a body that merely holds a
   list is one message and keeps one trailer block. */
const EMBEDDED_MESSAGE_BULLET = /^\*[ \t]\S/;
const EMBEDDED_MESSAGE_RULE = /^-{3,}[ \t]*$/;

type MessageParagraph = { end: number; start: number };

function messageParagraphs(lines: string[]): MessageParagraph[] {
  const found: MessageParagraph[] = [];
  let start: number | undefined;
  for (let index = 0; index <= lines.length; index += 1) {
    if (index < lines.length && lines[index].trim() !== "") {
      if (start === undefined) start = index;
      continue;
    }
    if (start !== undefined) found.push({ end: index, start });
    start = undefined;
  }
  return found;
}

/** The line numbers that sit inside a trailer block, of any embedded message. */
function trailerBlockLines(lines: string[]): Set<number> {
  const paragraphs = messageParagraphs(lines);
  const concatenated = paragraphs.length > 1
    && EMBEDDED_MESSAGE_BULLET.test(lines[paragraphs[1].start]);
  const block = new Set<number>();
  let segment: MessageParagraph[] = [];
  const closeSegment = (): void => {
    const last = segment.at(-1);
    /* A message's first paragraph is its subject, never its trailers. */
    if (last === undefined || segment.length < 2) return;
    for (let index = last.start; index < last.end; index += 1) {
      if (!isTrailerLine(lines[index])) return;
    }
    for (let index = last.start; index < last.end; index += 1) block.add(index);
  };
  for (const paragraph of paragraphs) {
    const rule = paragraph.end - paragraph.start === 1
      && EMBEDDED_MESSAGE_RULE.test(lines[paragraph.start]);
    const bullet = concatenated && EMBEDDED_MESSAGE_BULLET.test(lines[paragraph.start]);
    if (segment.length > 0 && (rule || bullet)) {
      closeSegment();
      segment = [];
    }
    segment.push(paragraph);
  }
  closeSegment();
  return block;
}

/* Occurrences arrive in ascending order, so one cursor walks the line starts
   alongside them; counting newlines per occurrence would be quadratic in the
   size of a commit message, and a commit message is written by whoever opens
   the pull request. */
function* addressLines(
  view: string,
  lines: string[],
  source?: EmailTextView["source"],
): Generator<{ line: number; occurrence: EmailOccurrence }> {
  let line = 0;
  let nextLineStart = lines[0].length + 1;
  for (const occurrence of emailOccurrences(view, source)) {
    while (line + 1 < lines.length && occurrence.index >= nextLineStart) {
      line += 1;
      nextLineStart += lines[line].length + 1;
    }
    yield { line, occurrence };
  }
}

export type CommitAddressReview = { attributable: string[]; exempt: string[] };

/**
 * Every address detected in a commit message, split by the one exemption.
 *
 * Detection reads the whole message, in the same views of it the gate reads
 * for any other publication surface, and the split happens afterwards on what
 * detection reported. An address the exemption does not name stays
 * attributable wherever it sits, including on the same line as an exempt one.
 */
export function commitMessageAddressReview(message: string): CommitAddressReview {
  const attributable = new Set<string>();
  const exempt = new Set<string>();
  for (const { text: view, source } of emailTextViews(message)) {
    const lines = view.split("\n");
    const block = trailerBlockLines(lines);
    for (const { line, occurrence } of addressLines(view, lines, source)) {
      const attributed = !block.has(line)
        || !MACHINE_ATTRIBUTION_TRAILER.test(lines[line])
        || !isMachineAttributionAddress(occurrence);
      (attributed ? attributable : exempt).add(occurrence.address);
    }
  }
  return { attributable: [...attributable], exempt: [...exempt] };
}

/* The commits the branch adds, newest first, one full hash per line. A hash
   holds no newline, so this read has no boundary to guess at — which is why
   the messages are fetched one at a time below rather than packed into this
   same stream. `--no-abbrev-commit` neutralises a checkout that configured
   `log.abbrevCommit`, and the shape check is what makes each hash safe to
   hand back to git as an argument. */
function branchCommitHashes(repository: string, base: string): string[] | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repository, "log", "--no-abbrev-commit", "--format=%H", `${base}..HEAD`],
    env: withoutUnsupportedApiCredentials(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  const hashes = result.stdout.toString().split("\n").filter((line) => line !== "");
  return hashes.every((hash) => COMMIT_HASH.test(hash)) ? hashes : undefined;
}

/* One commit's message, the whole of stdout. Asking for exactly one commit is
   what removes the ambiguity: no delimiter has to survive the message, so no
   message can be read as anything but a message. */
function commitMessage(repository: string, commit: string): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repository, "log", "-1", "--format=%B", commit, "--"],
    env: withoutUnsupportedApiCredentials(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/**
 * The messages this branch publishes when it is pushed.
 *
 * The range is `base..HEAD` — the commits the branch ADDS. It read
 * `base...HEAD` until #1315, and to `git log` the three-dot form is the
 * SYMMETRIC difference — not the ancestry cut the identical spelling means to
 * the `git diff` in `changedPaths`, which is how it got here. So every commit
 * already on the protected base but not on the branch was scanned too, and a
 * finding on one of them is reported against this pull request. Those messages
 * were published when they landed; this branch neither wrote them nor can
 * change them, and a branch that is merely BEHIND the base inherited every one
 * of them.
 *
 * That is what made the forge's "Update branch" button useless against such a
 * finding: the button merges the base tip, another merge lands on the base
 * seconds later, the gate resolves its base to the newer tip, and the branch
 * is behind again with the same finding nobody on it can fix.
 *
 * The identity half below has always read `base..HEAD`; the two halves of
 * `--check-commits` now read the same commits.
 */
export function commitMessageFindings(
  repository: string,
  base: string,
  notices?: string[],
): Map<FindingClass, number> {
  const findings = new Map<FindingClass, number>();
  const commits = branchCommitHashes(repository, base);
  if (commits === undefined) {
    addFinding(findings, "inspection_error");
    notices?.push("commit_message: range unreadable");
    return findings;
  }
  /* The hashes and the messages are read separately on purpose. One stream of
     `%H%x00%B%x00` carries no length, so the reader has to decide where each
     message ends, and until this round it decided by SHAPE: a chunk of forty
     lowercase hex characters was the next hash. A raw commit whose entire
     message is such a value — git writes one without a terminal newline when
     it is handed one — was therefore read as a hash and never scanned, and a
     value the gate knows passed the check. Nothing is inferred now: git is
     asked for the hashes, and then for each message by its hash. */
  for (const commit of commits) {
    const message = commitMessage(repository, commit);
    if (message === undefined) {
      addFinding(findings, "inspection_error");
      notices?.push(`commit_message: ${commit.slice(0, 12)} message unreadable`);
      continue;
    }
    const messageFindings = sensitiveClasses(message);
    if (messageFindings.has("email_address")) {
      const { attributable, exempt } = commitMessageAddressReview(message);
      if (exempt.length > 0 && attributable.length === 0) messageFindings.delete("email_address");
    }
    const reported: FindingClass[] = [];
    for (const finding of messageFindings) {
      if (!commitMessageFindingClasses.has(finding)) continue;
      addFinding(findings, finding);
      reported.push(finding);
    }
    /* The notice names WHERE the finding is and never WHAT it is: this report
       is published as a check run's log on a public repository, and a report
       that quoted the address or the path to prove it leaked, leaks it.
       `git show -s <commit>` names it to whoever is fixing it. */
    if (reported.length > 0) {
      const classes = reported.sort((left, right) => left.localeCompare(right)).join(", ");
      notices?.push(`commit_message: ${commit.slice(0, 12)} message ${classes}`);
    }
  }
  return findings;
}

export type MergeBoundaryReview = { findings: Map<FindingClass, number>; notices: string[] };

type CommitIdentity = {
  address: string;
  commit: string;
  field: "author" | "committer";
  name: string;
  parentCount: number;
};

/* The forge's account namespace, `<id>+<handle>` or `<handle>` at the no-reply
   host of its own domain. The forge issues that address for one purpose: so a
   contributor's own address stays unpublished when their commits are. An
   identity on this host therefore names an account, and the account is already
   public on the pull request the moment it is opened — the composed trailer
   discloses nothing the contribution has not disclosed. Which account it is
   does not matter here, so no account is written down and none is read from
   the checkout. */
const FORGE_ACCOUNT_DOMAIN = `users.noreply.${FORGE_DOMAIN}`;
const COMPOSED_ATTRIBUTION_TRAILER = "Co-authored-by";

function isForgeAccountAddress(address: string): boolean {
  const separator = address.lastIndexOf("@");
  if (separator === -1) return false;
  return address.slice(separator + 1).toLowerCase() === FORGE_ACCOUNT_DOMAIN;
}

/* The mailbox the forge writes as COMMITTER on a merge commit it composes —
   the "Update branch" button or a merge run from the pull request page. It is
   the forge's own web-flow identity: it names the forge, it is the same address
   on every repository, and it identifies nobody. The account that pressed the
   button is the AUTHOR, and the rule above already reads that field.
   Stated here rather than left to the message rules: the merge boundary is the
   identity path, and an identity question is answered by identity rules. The
   machine-attribution mailbox rule reaches the same verdict on this address
   through the trailer the review composes below, so the gate's verdict on a
   forge-composed merge is what it was — but it was reached by a rule about
   MESSAGES, and narrowing that rule would have silently taken the forge's own
   merges with it.
   Like every exemption here, this one names an ADDRESS the scan already found
   and never skips a read: an identity is a name as well as a mailbox, and a
   commit can be committed under this mailbox with anything at all in the name
   beside it. That name is scanned, and a person in it is reported. */
const FORGE_COMPOSER_ADDRESS = ["noreply", FORGE_DOMAIN].join("@");

function isForgeComposerMailbox(address: string): boolean {
  return address.toLowerCase() === FORGE_COMPOSER_ADDRESS;
}

function isForgeComposerIdentityAddress(address: string, identity: CommitIdentity): boolean {
  return identity.field === "committer"
    && isForgeComposerMailbox(identity.address)
    && isForgeComposerMailbox(address);
}

function isForgeComposerAddress(address: string, identity: CommitIdentity): boolean {
  return identity.parentCount > 1 && isForgeComposerIdentityAddress(address, identity);
}

/** Each distinct identity git recorded on the commits the merge will squash. */
function branchIdentities(repository: string, base: string): CommitIdentity[] | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repository, "log", "--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce", `${base}..HEAD`],
    env: withoutUnsupportedApiCredentials(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  const identities: CommitIdentity[] = [];
  /* An identity carries no newline — git refuses to record one — so a commit
     is a line and its six fields are NUL-separated within it. */
  for (const line of result.stdout.toString().split("\n")) {
    if (line === "") continue;
    const [commit, parents, authorName, authorAddress, committerName, committerAddress] = line.split("\0");
    if (committerAddress === undefined) return undefined;
    const parentCount = parents === "" ? 0 : parents.split(" ").length;
    const sameIdentity = committerName === authorName && committerAddress === authorAddress;
    /* Equal identities compose one finding. The forge mailbox is
       field-sensitive, so represent that pair as its committer record. */
    if (sameIdentity && isForgeComposerMailbox(committerAddress)) {
      identities.push({ address: committerAddress, commit, field: "committer", name: committerName, parentCount });
      continue;
    }
    identities.push({ address: authorAddress, commit, field: "author", name: authorName, parentCount });
    if (sameIdentity) continue;
    identities.push({ address: committerAddress, commit, field: "committer", name: committerName, parentCount });
  }
  return identities;
}

/* Read recorded identity fields in an attribution trailer. Field boundaries
   stay whitespace: synthetic angle brackets would hide a Markdown-obfuscated
   address as an HTML tag in the rendered-text inspection. */
function composedAttributionMessage(identity: CommitIdentity): string {
  return `squash merge\n\n${COMPOSED_ATTRIBUTION_TRAILER}: ${identity.name} ${identity.address}\n`;
}

/**
 * The identities the forge will publish in the commit it composes at merge.
 *
 * `--check-commits` reads the messages the branch carries, and the commit that
 * lands on the default branch is none of them: a squash merge writes a new
 * message and lifts every identity git recorded on the branch commits into a
 * `Co-authored-by:` trailer of its own. Nothing had ever read those identities,
 * so an address on no message at all reached the public history as a trailer.
 *
 * Git records an author and a committer on every commit and a commit cannot be
 * made without them, so the question is never whether an identity publishes but
 * whose. Three answers publish nobody: an account on the forge's no-reply host,
 * which the forge issues so that the account's own address is not what its
 * commits carry; the forge's own web-flow mailbox on a real merge commit the
 * forge composed; and the machine-attribution mailboxes the trailer rule
 * already names. Every other identity is a person, and is reported exactly as
 * an address in a file is.
 *
 * The no-reply host is read only here, on the identities the merge composes.
 * A commit message that writes such an address into a trailer by hand, or into
 * its body, keeps the narrow reading the trailer rule gives it — this is the
 * merge-boundary identity path, and it widens nothing else.
 */
export function mergeBoundaryReview(repository: string, base: string): MergeBoundaryReview {
  const findings = new Map<FindingClass, number>();
  const notices: string[] = [];
  const identities = branchIdentities(repository, base);
  if (identities === undefined) {
    addFinding(findings, "inspection_error");
    /* A failure of this check names itself too. It is one of two reads behind
       one flag, and a bare `inspection_error: 1` said which of them failed only
       to whoever went and read the source. */
    notices.push("merge_boundary: range unreadable");
    return { findings, notices };
  }
  for (const identity of identities) {
    const { attributable } = commitMessageAddressReview(composedAttributionMessage(identity));
    /* The composed trailer rules classify any exact `noreply` local part as
       machine attribution. For the forge's web-flow mailbox, the commit graph
       is the additional proof: a zero- or one-parent commit did not come from
       the forge's merge composer and remains attributable. */
    const unverifiedForgeComposer = isForgeComposerIdentityAddress(identity.address, identity)
      && !isForgeComposerAddress(identity.address, identity);
    const publishes = unverifiedForgeComposer || attributable.some((address) => {
      return !isForgeAccountAddress(address) && !isForgeComposerAddress(address, identity);
    });
    if (!publishes) continue;
    addFinding(findings, "email_address");
    /* The notice names the commit, the field and the trailer, and never the
       address: this report is itself published — a check run's log on a public
       repository — and a report that quotes the address to prove it leaked,
       leaks it. `git show -s <commit>` names it to whoever is fixing it. */
    notices.push(
      `merge_boundary: ${identity.commit.slice(0, 12)} ${identity.field} identity`
      + ` composes an attributable ${COMPOSED_ATTRIBUTION_TRAILER} trailer (address withheld)`,
    );
  }
  return { findings, notices };
}

export function reportPrivacyFindings(findings: Map<FindingClass, number>, notices: string[] = []): void {
  process.stdout.write(formatPrivacyReport(findings, notices));
  if (findings.size === 0) return;
  process.exitCode = 1;
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const repositoryArgument = argumentValue(arguments_, "--repository");
  const inspectionRoot = repositoryArgument ? resolve(repositoryArgument) : (repositoryRoot ?? resolve("."));
  const trustedBase = argumentValue(arguments_, "--base") ?? "origin/main";
  const repositoryPath = safePath(inspectionRoot);
  const repositoryError = repositoryPath.status !== "safe" || !repositoryPath.metadata?.isDirectory();
  const explicitPaths = requestedPaths(arguments_);
  const selection = explicitPaths === undefined
    ? changedPaths(arguments_, inspectionRoot)
    : {
      error: explicitPaths.length === 0,
      paths: explicitPaths.map((path) => isAbsolute(path) ? path : resolve(inspectionRoot, path)),
    };
  const notices: string[] = [];
  const pathFindings = inspectPaths(
    selection.paths,
    selection.error || repositoryError,
    arguments_.includes("--require-known-values"),
    inspectionRoot,
    trustedBase,
    notices,
  );
  if (arguments_.includes("--check-commits")) {
    for (const [finding, count] of commitMessageFindings(inspectionRoot, trustedBase, notices)) {
      pathFindings.set(finding, (pathFindings.get(finding) ?? 0) + count);
    }
    /* The branch commits publish their messages when they are pushed; the merge
       publishes a commit composed from their identities. Both are the commit
       surface, so one flag reads both. */
    const boundary = mergeBoundaryReview(inspectionRoot, trustedBase);
    for (const [finding, count] of boundary.findings) {
      pathFindings.set(finding, (pathFindings.get(finding) ?? 0) + count);
    }
    notices.push(...boundary.notices);
  }
  reportPrivacyFindings(pathFindings, notices);
}
