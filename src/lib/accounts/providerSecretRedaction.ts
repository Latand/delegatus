import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { stateDir } from "@/lib/configDir";

type Fingerprint = { length: number; rolling: number; mac: string };
const REDACTION_KEY = "provider-redaction.key";
const REDACTION_RECORDS = "provider-redaction.json";

function privateRead(filename: string, maxBytes: number): Buffer | null {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes)
      throw new Error("Provider redaction store is unsafe");
    return fs.readFileSync(filename);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function redactionKey(root: string, create: boolean): Buffer | null {
  const filename = path.join(root, REDACTION_KEY);
  let key = privateRead(filename, 32);
  if (!key && create) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(filename, crypto.randomBytes(32), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    key = privateRead(filename, 32);
  }
  if (key && key.length !== 32) throw new Error("Provider redaction key is invalid");
  return key;
}

function fingerprints(root: string): Fingerprint[] {
  const data = privateRead(path.join(root, REDACTION_RECORDS), 1024 * 1024);
  if (!data) return [];
  const parsed = JSON.parse(data.toString("utf8")) as { version?: unknown; entries?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 4096
    || parsed.entries.some((entry) => !entry || typeof entry !== "object"
      || !Number.isInteger(entry.length) || entry.length < 1 || entry.length > 8192
      || !Number.isInteger(entry.rolling) || entry.rolling < 0 || entry.rolling > 0xffffffff
      || typeof entry.mac !== "string" || !/^[0-9a-f]{64}$/.test(entry.mac)))
    throw new Error("Provider redaction records are invalid");
  return parsed.entries as Fingerprint[];
}

function rollingHash(value: string, base: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (Math.imul(hash, base) + value.charCodeAt(index)) >>> 0;
  return hash;
}

function rollingBase(key: Buffer): number { return (key.readUInt32LE(0) | 257) >>> 0; }
function mac(value: string, key: Buffer): string { return crypto.createHmac("sha256", key).update(value).digest("hex"); }

/** Keep irreversible matching evidence before a credential is rotated or scrubbed. */
export function retainProviderRedactionSecrets(values: readonly string[]): void {
  const root = stateDir();
  const key = redactionKey(root, true)!;
  const base = rollingBase(key);
  const existing = fingerprints(root);
  const known = new Set(existing.map((entry) => `${entry.length}:${entry.mac}`));
  for (const value of values) {
    if (!value) continue;
    const escaped = JSON.stringify(value).slice(1, -1);
    for (const form of new Set([value, escaped, value.replaceAll("/", "\\/"), escaped.replaceAll("/", "\\/")])) {
      const digest = mac(form, key);
      const identity = `${form.length}:${digest}`;
      if (known.has(identity)) continue;
      existing.push({ length: form.length, rolling: rollingHash(form, base), mac: digest });
      known.add(identity);
    }
  }
  if (existing.length > 4096) throw new Error("Provider redaction record limit reached");
  const filename = path.join(root, REDACTION_RECORDS);
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: existing }), { mode: 0o600, flag: "wx" });
    const descriptor = fs.openSync(temporary, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filename);
    const directory = fs.openSync(root, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { fs.rmSync(temporary, { force: true }); }
}

function fingerprintMatchRanges(text: string, key: Buffer, records: Fingerprint[]): Array<[number, number]> {
  const base = rollingBase(key);
  const byLength = new Map<number, Map<number, Set<string>>>();
  for (const record of records) {
    let hashes = byLength.get(record.length);
    if (!hashes) { hashes = new Map(); byLength.set(record.length, hashes); }
    let digests = hashes.get(record.rolling);
    if (!digests) { digests = new Set(); hashes.set(record.rolling, digests); }
    digests.add(record.mac);
  }
  const ranges: Array<[number, number]> = [];
  for (const [length, hashes] of byLength) {
    if (length > text.length) continue;
    let power = 1;
    for (let index = 1; index < length; index += 1) power = Math.imul(power, base) >>> 0;
    let rolling = rollingHash(text.slice(0, length), base);
    for (let start = 0; start <= text.length - length; start += 1) {
      const digests = hashes.get(rolling);
      if (digests?.has(mac(text.slice(start, start + length), key))) ranges.push([start, start + length]);
      if (start + length < text.length) {
        rolling = (Math.imul((rolling - Math.imul(text.charCodeAt(start), power)) >>> 0, base)
          + text.charCodeAt(start + length)) >>> 0;
      }
    }
  }
  return ranges;
}

function applyRedactionRanges(text: string, ranges: Array<[number, number]>, marker: string): string {
  if (!ranges.length) return text;
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let output = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) { cursor = Math.max(cursor, end); continue; }
    output += text.slice(cursor, start) + marker;
    cursor = end;
  }
  return output + text.slice(cursor);
}

function redactFingerprintMatches(text: string, key: Buffer, records: Fingerprint[], marker: string): string {
  return applyRedactionRanges(text, fingerprintMatchRanges(text, key, records), marker);
}

/** Map JSON escape spellings back to their raw spans without rewriting other text. */
function decodedEscapeView(text: string): { decoded: string; spans: Array<[number, number]> } {
  let decoded = "";
  const spans: Array<[number, number]> = [];
  const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\" && text[index + 1] === "u" && /^[0-9a-f]{4}$/i.test(text.slice(index + 2, index + 6))) {
      decoded += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
      spans.push([index, index + 6]); index += 6;
    } else if (text[index] === "\\" && text[index + 1] && simple[text[index + 1]!] !== undefined) {
      decoded += simple[text[index + 1]!]!;
      spans.push([index, index + 2]); index += 2;
    } else {
      decoded += text[index]!;
      spans.push([index, index + 1]); index += 1;
    }
  }
  return { decoded, spans };
}

/** Read dedicated sidecars for redaction even when their mode needs repair. */
export function providerSecretsAtHome(home: string): string[] {
  const read = (name: string, maxBytes: number): string | null => {
    try {
      const file = path.join(home, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) return null;
      return fs.readFileSync(file, "utf8");
    } catch { return null; }
  };
  const values: string[] = [];
  const token = read(".provider-token", 4096);
  if (token) values.push(token);
  const headers = read(".provider-headers", 70_000);
  if (headers) {
    try {
      const parsed = JSON.parse(headers) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        for (const value of Object.values(parsed)) if (typeof value === "string" && value) values.push(value);
    } catch { /* malformed header file has no recoverable values */ }
  }
  const runtime = read(".provider-runtime", 100_000);
  if (runtime) {
    try {
      const parsed = JSON.parse(runtime) as { token?: unknown; headers?: unknown };
      if (typeof parsed.token === "string" && parsed.token) values.push(parsed.token);
      if (parsed.headers && typeof parsed.headers === "object" && !Array.isArray(parsed.headers))
        for (const value of Object.values(parsed.headers)) if (typeof value === "string" && value) values.push(value);
    } catch { /* malformed runtime file has no recoverable values */ }
  }
  return values;
}

function knownProviderSecrets(): string[] {
  let root: string;
  try { root = path.join(path.dirname(stateDir()), "accounts", "claude"); }
  catch { return []; }
  const values = new Set<string>();
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const home = path.join(root, entry.name);
      for (const value of providerSecretsAtHome(home)) values.add(value);
    }
  } catch { /* no account root */ }
  return [...values].sort((left, right) => right.length - left.length);
}

/** Covers arbitrary provider credentials in old transcripts and raw MCP tails. */
export function redactKnownProviderSecrets(text: string): string {
  const live = [...new Set(knownProviderSecrets().flatMap((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return [secret, escaped, secret.replaceAll("/", "\\/"), escaped.replaceAll("/", "\\/")];
  }))];
  let root: string;
  try { root = stateDir(); }
  catch { return live.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), text); }
  let records: Fingerprint[];
  let key: Buffer | null;
  try {
    records = fingerprints(root);
    key = records.length ? redactionKey(root, false) : null;
    if (records.length && !key) throw new Error("Provider redaction key is missing");
  } catch { return "[withheld]"; }
  const choices = ["[redacted]", "[withheld]", "[hidden]"];
  const safe = (candidate: string) => live.every((secret) => !candidate.includes(secret))
    && (!key || redactFingerprintMatches(candidate, key, records, "\u0000") === candidate);
  let marker = choices.find(safe);
  while (!marker || !safe(marker)) marker = `[${crypto.randomBytes(16).toString("hex")}]`;
  const current = live.reduce((result, secret) => result.replaceAll(secret, marker), text);
  if (!key) return current;
  const direct = fingerprintMatchRanges(current, key, records);
  const view = decodedEscapeView(current);
  const encoded = fingerprintMatchRanges(view.decoded, key, records)
    .map(([start, end]): [number, number] => [view.spans[start]![0], view.spans[end - 1]![1]]);
  return applyRedactionRanges(current, [...direct, ...encoded], marker);
}
