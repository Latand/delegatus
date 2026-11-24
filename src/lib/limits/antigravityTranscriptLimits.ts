import fs from "node:fs";
import path from "node:path";

import type { LimitRead } from "@/lib/limits";
import { isValidAntigravitySessionId } from "@/lib/scanner/antigravityNative";

import {
  ANTIGRAVITY_QUOTA_WINDOW_MINUTES,
  antigravityLimitsFromExhaustion,
  parseAntigravityResetSeconds,
  redactAntigravityQuotaMessage,
  type AntigravityQuotaExhaustion,
} from "./antigravityQuota";

const MAX_FILES = 5;
const CHUNK_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_CACHE = 32;
const MAX_DIR_CACHE = 32;
const DIR_SCAN_CACHE_TTL_MS = 30_000;
const EVENT_TYPE_MARKER = Buffer.from('"session.quota_exhausted"');

interface CachedExhaustionEntry {
  fingerprint: string;
  exhaustion: AntigravityQuotaExhaustion | null;
}

interface CachedDirEntry {
  dirFingerprint: string;
  scannedAtMonoMs: number;
  files: string[];
}

interface SessionFileCandidate {
  file: string;
  stat: fs.BigIntStats;
}

interface FileExhaustionResult {
  exhaustion: AntigravityQuotaExhaustion | null;
  readError: boolean;
}

const fileExhaustionCache = new Map<string, CachedExhaustionEntry>();
const dirScanCache = new Map<string, CachedDirEntry>();

function dirFingerprintOf(sessionsDir: string): string | null {
  try {
    const stat = fs.statSync(sessionsDir, { bigint: true });
    if (!stat.isDirectory()) return null;
    // Include nlink and size so adding/removing a session subdirectory invalidates
    // immediately even within the same coarse filesystem timestamp tick.
    return `${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

function fileFingerprintOf(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function cacheDirTopFiles(sessionsDir: string, dirFingerprint: string, files: string[]): void {
  dirScanCache.delete(sessionsDir);
  dirScanCache.set(sessionsDir, {
    dirFingerprint,
    scannedAtMonoMs: performance.now(),
    files: files.slice(0, MAX_FILES),
  });
  while (dirScanCache.size > MAX_DIR_CACHE) {
    const oldest = dirScanCache.keys().next().value;
    if (oldest === undefined) break;
    dirScanCache.delete(oldest);
  }
}

/** Keeps the cached top-N recent session list current when a live Antigravity host
 * creates or appends to a transcript file, avoiding full directory scans on polls. */
export function noteAntigravitySessionActivity(sessionsDir: string, transcriptFile: string): void {
  const dirFp = dirFingerprintOf(sessionsDir);
  if (!dirFp) return;
  const cached = dirScanCache.get(sessionsDir);
  const existing = cached ? cached.files.filter((item) => item !== transcriptFile) : [];
  cacheDirTopFiles(sessionsDir, dirFp, [transcriptFile, ...existing].slice(0, MAX_FILES));
}

function newestSessionFiles(sessionsDir: string): SessionFileCandidate[] {
  const dirFp = dirFingerprintOf(sessionsDir);
  if (!dirFp) {
    dirScanCache.delete(sessionsDir);
    return [];
  }
  const nowMono = performance.now();
  const cached = dirScanCache.get(sessionsDir);
  if (cached && cached.dirFingerprint === dirFp && nowMono - cached.scannedAtMonoMs < DIR_SCAN_CACHE_TTL_MS) {
    dirScanCache.delete(sessionsDir);
    dirScanCache.set(sessionsDir, cached);
    const live: SessionFileCandidate[] = [];
    for (const file of cached.files) {
      try {
        const stat = fs.statSync(file, { bigint: true });
        if (stat.isFile()) live.push({ file, stat });
      } catch { /* session removed */ }
    }
    if (live.length === cached.files.length) {
      return live;
    }
  }

  const entries: { file: string; stat: fs.BigIntStats }[] = [];
  try {
    for (const name of fs.readdirSync(sessionsDir)) {
      if (!isValidAntigravitySessionId(name)) continue;
      const file = path.join(sessionsDir, name, "events.jsonl");
      try {
        const stat = fs.statSync(file, { bigint: true });
        if (stat.isFile()) entries.push({ file, stat });
      } catch { /* incomplete or removed session */ }
    }
  } catch {
    return [];
  }
  const top = entries
    .sort((a, b) => (b.stat.mtimeNs > a.stat.mtimeNs ? 1 : b.stat.mtimeNs < a.stat.mtimeNs ? -1 : b.file.localeCompare(a.file)))
    .slice(0, MAX_FILES);
  cacheDirTopFiles(sessionsDir, dirFp, top.map((entry) => entry.file));
  return top;
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
  const resetsAt = typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt)
    ? Math.floor(data.resetsAt)
    : messageRaw ? parseAntigravityResetSeconds(messageRaw, observedAtRaw * 1000) : null;
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

function readLatestExhaustionInFile(file: string, knownStat?: fs.BigIntStats): FileExhaustionResult {
  let fingerprint: string | null = null;
  try {
    const stat = knownStat ?? fs.statSync(file, { bigint: true });
    if (!stat.isFile()) return { exhaustion: null, readError: false };
    if (stat.size <= BigInt(0)) return { exhaustion: null, readError: false };
    fingerprint = fileFingerprintOf(stat);
    const cached = fileExhaustionCache.get(file);
    if (cached && cached.fingerprint === fingerprint) {
      fileExhaustionCache.delete(file);
      fileExhaustionCache.set(file, cached);
      return { exhaustion: cached.exhaustion ? { ...cached.exhaustion } : null, readError: false };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { exhaustion: null, readError: code !== "ENOENT" };
  }

  let fd: number;
  try { fd = fs.openSync(file, "r"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { exhaustion: null, readError: code !== "ENOENT" };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return { exhaustion: null, readError: false };
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
    return { exhaustion: found ? { ...found } : null, readError: false };
  } catch {
    // Isolate per-file I/O failures (e.g. EIO) so one unreadable transcript never
    // fails other sessions or other engines, and never poison the stat cache.
    return { exhaustion: null, readError: true };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function readLatestExhaustionAcrossFiles(
  files: readonly SessionFileCandidate[],
): { latest: AntigravityQuotaExhaustion | null; readErrors: number } {
  let latest: AntigravityQuotaExhaustion | null = null;
  let readErrors = 0;
  for (const candidate of files) {
    const result = readLatestExhaustionInFile(candidate.file, candidate.stat);
    if (result.readError) readErrors += 1;
    if (result.exhaustion && (!latest || result.exhaustion.observedAt > latest.observedAt)) {
      latest = result.exhaustion;
    }
  }
  return { latest: latest ? { ...latest } : null, readErrors };
}

/**
 * Inspects at most the newest 5 `sessions/<id>/events.jsonl` backwards
 * (capped at 16 MiB per file, stat-cached for unchanged files and directory listings)
 * for the newest `session.quota_exhausted` record. Always returns a fresh caller-owned copy.
 */
export function readAntigravityTranscriptQuotaExhaustion(sessionsDir: string): AntigravityQuotaExhaustion | null {
  return readLatestExhaustionAcrossFiles(newestSessionFiles(sessionsDir)).latest;
}

/**
 * Reads Antigravity transcript-backed quota limits for `/api/limits` and `QuotaController`.
 * Active exhaustion (before `resetsAt`) returns `source: "transcript"` with a 5-hour 100%-used
 * session window; expired exhaustion transitions cleanly back to `source: "unavailable"`.
 * Per-file I/O errors are isolated and never throw.
 */
export function readAntigravityTranscriptLimits(
  sessionsDir: string,
  now = Date.now(),
  options: { tierName?: string | null } = {},
): LimitRead {
  const files = newestSessionFiles(sessionsDir);
  const { latest, readErrors } = readLatestExhaustionAcrossFiles(files);
  if (!latest) {
    return {
      data: null,
      reason: readErrors > 0
        ? "antigravity transcript read error"
        : `no quota exhaustion in newest ${files.length} session files`,
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
    reason: readErrors > 0
      ? "antigravity transcript read error"
      : "antigravity quota reset window elapsed",
    source: "unavailable",
  };
}
