import fs from "node:fs";
import path from "node:path";

import { copilotLimitsFromSnapshot, type CopilotQuotaBucket, type CopilotQuotaSnapshot } from "./copilotQuota";
import type { LimitRead } from "@/lib/limits";

const MAX_FILES = 5;
const CHUNK_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 64 * 1024;
const QUOTA_KEY = '"quotaSnapshots"';
const QUOTA_KEY_BYTES = Buffer.from(QUOTA_KEY);
const TIMESTAMP_KEY_BYTES = Buffer.from('"timestamp"');

function newestSessionFiles(sessionStateDir: string): string[] {
  const root = sessionStateDir;
  let entries: { file: string; mtime: number }[] = [];
  try {
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name, "events.jsonl");
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) entries.push({ file, mtime: stat.mtimeMs });
      } catch { /* incomplete or removed session */ }
    }
  } catch { return []; }
  return entries.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file)).slice(0, MAX_FILES).map((entry) => entry.file);
}

function balancedObjectEnd(bytes: Buffer, start: number): number | null {
  if (bytes[start] !== 0x7b) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < bytes.length; index += 1) {
    const char = bytes[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === 0x5c) escaped = true;
      else if (char === 0x22) quoted = false;
      continue;
    }
    if (char === 0x22) quoted = true;
    else if (char === 0x7b) depth += 1;
    else if (char === 0x7d) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function quotaBucket(value: unknown): CopilotQuotaBucket | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.entitlementRequests !== "number" || typeof row.remainingPercentage !== "number"
    || typeof row.isUnlimitedEntitlement !== "boolean" || typeof row.overageAllowedWithExhaustedQuota !== "boolean") return undefined;
  return {
    entitlementRequests: row.entitlementRequests,
    remainingPercentage: row.remainingPercentage,
    resetDate: typeof row.resetDate === "string" ? row.resetDate : null,
    isUnlimitedEntitlement: row.isUnlimitedEntitlement,
    overageAllowedWithExhaustedQuota: row.overageAllowedWithExhaustedQuota,
  };
}

function envelopeTimestamp(lineSuffix: Buffer): number | null {
  const keyAt = lineSuffix.lastIndexOf(TIMESTAMP_KEY_BYTES);
  if (keyAt < 0) return null;
  let valueAt = keyAt + TIMESTAMP_KEY_BYTES.length;
  while (lineSuffix[valueAt] === 0x20 || lineSuffix[valueAt] === 0x09 || lineSuffix[valueAt] === 0x0d) valueAt += 1;
  if (lineSuffix[valueAt] !== 0x3a) return null;
  valueAt += 1;
  while (lineSuffix[valueAt] === 0x20 || lineSuffix[valueAt] === 0x09 || lineSuffix[valueAt] === 0x0d) valueAt += 1;
  if (lineSuffix[valueAt] === 0x22) {
    const valueStart = valueAt + 1;
    let escaped = false;
    for (let end = valueStart; end < lineSuffix.length; end += 1) {
      const byte = lineSuffix[end]!;
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) {
        const value = Date.parse(lineSuffix.subarray(valueStart, end).toString("utf8")) / 1000;
        return Number.isFinite(value) ? value : null;
      }
    }
    return null;
  }
  let end = valueAt;
  while (end < lineSuffix.length && ((lineSuffix[end]! >= 0x30 && lineSuffix[end]! <= 0x39) || lineSuffix[end] === 0x2e)) end += 1;
  const value = Number(lineSuffix.subarray(valueAt, end).toString("utf8"));
  return Number.isFinite(value) ? value : null;
}

type CandidateRead = { snapshot: CopilotQuotaSnapshot | null; bytesRead: number };

function readCandidate(fd: number, fileSize: number, keyAt: number, budget: number): CandidateRead {
  const candidateLength = Math.min(MAX_CANDIDATE_BYTES, fileSize - keyAt, budget);
  if (candidateLength <= 0) return { snapshot: null, bytesRead: 0 };
  const candidateBytes = Buffer.allocUnsafe(candidateLength);
  const candidateCount = fs.readSync(fd, candidateBytes, 0, candidateLength, keyAt);
  const bytes = candidateBytes.subarray(0, candidateCount);
  const colon = bytes.indexOf(0x3a, QUOTA_KEY_BYTES.length);
  if (colon < 0) return { snapshot: null, bytesRead: candidateCount };
  let objectStart = colon + 1;
  while (bytes[objectStart] === 0x20 || bytes[objectStart] === 0x09 || bytes[objectStart] === 0x0d) objectStart += 1;
  const objectEnd = balancedObjectEnd(bytes, objectStart);
  if (objectEnd === null) return { snapshot: null, bytesRead: candidateCount };

  let raw: Record<string, unknown>;
  try { raw = JSON.parse(bytes.subarray(objectStart, objectEnd).toString("utf8")) as Record<string, unknown>; }
  catch { return { snapshot: null, bytesRead: candidateCount }; }

  const suffixChunks: Buffer[] = [];
  let totalRead = candidateCount;
  let newlineAt = bytes.indexOf(0x0a, objectEnd);
  suffixChunks.push(bytes.subarray(objectEnd, newlineAt < 0 ? bytes.length : newlineAt));
  let position = keyAt + candidateCount;
  let lineEnded = newlineAt >= 0 || position >= fileSize;
  while (!lineEnded && totalRead < budget && position < fileSize) {
    const length = Math.min(CHUNK_BYTES, budget - totalRead, fileSize - position);
    if (length <= 0) break;
    const chunk = Buffer.allocUnsafe(length);
    const count = fs.readSync(fd, chunk, 0, length, position);
    if (count <= 0) break;
    position += count;
    totalRead += count;
    const lineEnd = chunk.indexOf(0x0a);
    suffixChunks.push(chunk.subarray(0, lineEnd < 0 ? count : lineEnd));
    lineEnded = lineEnd >= 0 || position >= fileSize;
  }
  if (!lineEnded) return { snapshot: null, bytesRead: totalRead };
  const timestamp = envelopeTimestamp(Buffer.concat(suffixChunks));
  if (timestamp === null) return { snapshot: null, bytesRead: totalRead };
  const chat = quotaBucket(raw.chat);
  const completions = quotaBucket(raw.completions);
  const premium = quotaBucket(raw.premium_interactions);
  if (!chat && !completions && !premium) return { snapshot: null, bytesRead: totalRead };
  return {
    snapshot: {
      observedAt: timestamp,
      ...(chat ? { chat } : {}),
      ...(completions ? { completions } : {}),
      ...(premium ? { premium_interactions: premium } : {}),
    },
    bytesRead: totalRead,
  };
}

function readLatestSnapshot(file: string): CopilotQuotaSnapshot | null {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    let readBytes = 0;
    let end = size;
    let overlap = Buffer.alloc(0);
    while (end > 0 && readBytes < MAX_FILE_BYTES) {
      const length = Math.min(CHUNK_BYTES, end, MAX_FILE_BYTES - readBytes);
      const chunk = Buffer.allocUnsafe(length);
      const start = end - length;
      const count = fs.readSync(fd, chunk, 0, length, start);
      if (count <= 0) break;
      readBytes += count;
      const current = chunk.subarray(0, count);
      const searchBytes = overlap.length ? Buffer.concat([current, overlap]) : current;
      let searchBefore = current.length - 1;
      while (searchBefore >= 0) {
        const keyAt = searchBytes.lastIndexOf(QUOTA_KEY_BYTES, searchBefore);
        if (keyAt < 0) break;
        const candidate = readCandidate(fd, size, start + keyAt, MAX_FILE_BYTES - readBytes);
        readBytes += candidate.bytesRead;
        if (candidate.snapshot) return candidate.snapshot;
        searchBefore = keyAt - 1;
      }
      overlap = Buffer.from(current.subarray(0, Math.min(current.length, QUOTA_KEY_BYTES.length - 1)));
      end = start;
    }
    return null;
  } finally { fs.closeSync(fd); }
}

export function readCopilotTranscriptQuotaSnapshot(sessionStateDir: string): CopilotQuotaSnapshot | null {
  let latest: CopilotQuotaSnapshot | null = null;
  for (const file of newestSessionFiles(sessionStateDir)) {
    const snapshot = readLatestSnapshot(file);
    if (snapshot && (!latest || snapshot.observedAt > latest.observedAt)) latest = snapshot;
  }
  return latest;
}

export function readCopilotTranscriptLimits(sessionStateDir: string, _now = Date.now()): LimitRead {
  const files = newestSessionFiles(sessionStateDir);
  const latest = readCopilotTranscriptQuotaSnapshot(sessionStateDir);
  if (latest) return { data: copilotLimitsFromSnapshot(latest), reason: null, source: "transcript" };
  return { data: null, reason: `no quotaSnapshots in newest ${files.length} session files`, source: "unavailable" };
}
