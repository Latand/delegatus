import fs from "node:fs";
import path from "node:path";

import type { LimitRead } from "@/lib/limits";
import { isValidAntigravitySessionId } from "@/lib/scanner/antigravityNative";

import {
  ANTIGRAVITY_QUOTA_WINDOW_MINUTES,
  antigravityLimitsFromExhaustion,
  parseAntigravityQuotaError,
  redactAntigravityQuotaMessage,
  type AntigravityQuotaExhaustion,
} from "./antigravityQuota";

const MAX_FILES = 5;
const CHUNK_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_CACHE = 32;
const EVENT_TYPE_MARKER = Buffer.from('"session.quota_exhausted"');

interface CachedExhaustionEntry {
  fingerprint: string;
  exhaustion: AntigravityQuotaExhaustion | null;
}

const fileExhaustionCache = new Map<string, CachedExhaustionEntry>();

function newestSessionFiles(sessionsDir: string): string[] {
  const entries: { file: string; mtime: number }[] = [];
  try {
    for (const name of fs.readdirSync(sessionsDir)) {
      if (!isValidAntigravitySessionId(name)) continue;
      const file = path.join(sessionsDir, name, "events.jsonl");
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) entries.push({ file, mtime: stat.mtimeMs });
      } catch { /* incomplete or removed session */ }
    }
  } catch {
    return [];
  }
  return entries
    .sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file))
    .slice(0, MAX_FILES)
    .map((entry) => entry.file);
}

function parseExhaustionRecord(line: string): AntigravityQuotaExhaustion | null {
  let raw: unknown;
  try { raw = JSON.parse(line); }
  catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.type !== "session.quota_exhausted") return null;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : {};
  const envelopeTsMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  const observedAtRaw = typeof data.observedAt === "number" && Number.isFinite(data.observedAt)
    ? Math.floor(data.observedAt)
    : Number.isFinite(envelopeTsMs)
      ? Math.floor(envelopeTsMs / 1000)
      : null;
  if (observedAtRaw === null || observedAtRaw <= 0) return null;
  const messageRaw = typeof data.message === "string" ? data.message : "";
  const reparsed = messageRaw ? parseAntigravityQuotaError(messageRaw, observedAtRaw * 1000) : null;
  const resetsAt = typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt)
    ? Math.floor(data.resetsAt)
    : reparsed?.resetsAt ?? null;
  const windowMinutes = typeof data.windowMinutes === "number" && Number.isFinite(data.windowMinutes) && data.windowMinutes > 0
    ? Math.round(data.windowMinutes)
    : ANTIGRAVITY_QUOTA_WINDOW_MINUTES;
  return {
    exhausted: true,
    resetsAt,
    windowMinutes,
    usedPercent: 100,
    observedAt: observedAtRaw,
    message: redactAntigravityQuotaMessage(messageRaw),
  };
}

function readLatestExhaustionInFile(file: string): AntigravityQuotaExhaustion | null {
  let fingerprint: string | null = null;
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) return null;
    if (stat.size <= BigInt(0)) return null;
    fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = fileExhaustionCache.get(file);
    if (cached && cached.fingerprint === fingerprint) {
      fileExhaustionCache.delete(file);
      fileExhaustionCache.set(file, cached);
      return cached.exhaustion ? { ...cached.exhaustion } : null;
    }
  } catch {
    return null;
  }

  let fd: number;
  try { fd = fs.openSync(file, "r"); }
  catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return null;
    let end = size;
    let readBytes = 0;
    let carry = Buffer.alloc(0);
    let found: AntigravityQuotaExhaustion | null = null;
    while (end > 0 && readBytes < MAX_FILE_BYTES) {
      const length = Math.min(CHUNK_BYTES, end, MAX_FILE_BYTES - readBytes);
      const chunk = Buffer.allocUnsafe(length);
      const start = end - length;
      const count = fs.readSync(fd, chunk, 0, length, start);
      if (count <= 0) break;
      readBytes += count;
      const current = chunk.subarray(0, count);
      const combined = carry.length ? Buffer.concat([current, carry]) : current;
      const hitStart = start === 0;
      let cursor = combined.length;
      while (cursor > 0) {
        const nl = combined.lastIndexOf(0x0a, cursor - 1);
        const lineStart = nl >= 0 ? nl + 1 : 0;
        const completeFromLeft = nl >= 0 || hitStart;
        if (!completeFromLeft) {
          carry = Buffer.from(combined.subarray(0, cursor));
          break;
        }
        const slice = combined.subarray(lineStart, cursor);
        if (slice.length > 0 && slice.indexOf(EVENT_TYPE_MARKER) >= 0) {
          const parsed = parseExhaustionRecord(slice.toString("utf8").trim());
          if (parsed) {
            found = parsed;
            break;
          }
        }
        cursor = nl;
        if (nl < 0) {
          carry = Buffer.alloc(0);
          break;
        }
      }
      if (found) break;
      if (cursor === 0) carry = Buffer.alloc(0);
      end = start;
    }
    if (fingerprint) {
      fileExhaustionCache.delete(file);
      fileExhaustionCache.set(file, { fingerprint, exhaustion: found ? { ...found } : null });
      while (fileExhaustionCache.size > MAX_FILE_CACHE) {
        const oldest = fileExhaustionCache.keys().next().value;
        if (oldest === undefined) break;
        fileExhaustionCache.delete(oldest);
      }
    }
    return found ? { ...found } : null;
  } finally {
    fs.closeSync(fd);
  }
}

function readLatestExhaustionAcrossFiles(files: readonly string[]): AntigravityQuotaExhaustion | null {
  let latest: AntigravityQuotaExhaustion | null = null;
  for (const file of files) {
    const candidate = readLatestExhaustionInFile(file);
    if (candidate && (!latest || candidate.observedAt > latest.observedAt)) {
      latest = candidate;
    }
  }
  return latest ? { ...latest } : null;
}

/**
 * Inspects at most the newest 5 `sessions/<id>/events.jsonl` backwards
 * (capped at 16 MiB per file, stat-cached for unchanged files) for the newest
 * `session.quota_exhausted` record. Always returns a fresh caller-owned copy.
 */
export function readAntigravityTranscriptQuotaExhaustion(sessionsDir: string): AntigravityQuotaExhaustion | null {
  return readLatestExhaustionAcrossFiles(newestSessionFiles(sessionsDir));
}

/**
 * Reads Antigravity transcript-backed quota limits for `/api/limits` and `QuotaController`.
 * Active exhaustion (before `resetsAt`) returns `source: "transcript"` with a 5-hour 100%-used
 * session window; expired exhaustion transitions cleanly back to `source: "unavailable"`.
 */
export function readAntigravityTranscriptLimits(
  sessionsDir: string,
  now = Date.now(),
  options: { tierName?: string | null } = {},
): LimitRead {
  const files = newestSessionFiles(sessionsDir);
  const latest = readLatestExhaustionAcrossFiles(files);
  if (!latest) {
    return {
      data: null,
      reason: `no quota exhaustion in newest ${files.length} session files`,
      source: "unavailable",
    };
  }
  const mapped = antigravityLimitsFromExhaustion(latest, { nowMs: now, tierName: options.tierName });
  if (mapped.active && mapped.limits) {
    return {
      data: mapped.limits,
      reason: null,
      source: "transcript",
    };
  }
  return {
    data: null,
    reason: "antigravity quota reset window elapsed",
    source: "unavailable",
  };
}
