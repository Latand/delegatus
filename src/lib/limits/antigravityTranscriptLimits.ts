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

const MAX_INCREMENTAL_NEW_DIRS = 64;

interface CachedExhaustionEntry {
  fingerprint: string;
  exhaustion: AntigravityQuotaExhaustion | null;
}

interface CachedTopFile {
  file: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}

interface CachedDirEntry {
  dirFingerprint: string;
  fullScanAtMonoMs: number;
  /** Session directory names observed at the last scan (null when seeded only via
   * `noteAntigravitySessionActivity` before any directory listing ran). */
  knownNames: Set<string> | null;
  files: CachedTopFile[];
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

function toCachedTopFile(candidate: SessionFileCandidate): CachedTopFile {
  return {
    file: candidate.file,
    dev: candidate.stat.dev,
    ino: candidate.stat.ino,
    mtimeNs: candidate.stat.mtimeNs,
    size: candidate.stat.size,
  };
}

function isCachedTopFileIntact(prev: CachedTopFile, stat: fs.BigIntStats): boolean {
  return stat.isFile()
    && stat.dev === prev.dev
    && stat.ino === prev.ino
    && stat.mtimeNs >= prev.mtimeNs
    && stat.size >= prev.size;
}

function cacheDirTopFiles(
  sessionsDir: string,
  dirFingerprint: string,
  files: CachedTopFile[],
  knownNames: Set<string> | null,
  fullScanAtMonoMs: number,
): void {
  dirScanCache.delete(sessionsDir);
  dirScanCache.set(sessionsDir, {
    dirFingerprint,
    fullScanAtMonoMs,
    knownNames,
    files: files.slice(0, MAX_FILES),
  });
  while (dirScanCache.size > MAX_DIR_CACHE) {
    const oldest = dirScanCache.keys().next().value;
    if (oldest === undefined) break;
    dirScanCache.delete(oldest);
  }
}

/** Keeps the cached top-N recent session list and known session set current when
 * a live Antigravity host creates or appends to a transcript file, avoiding
 * full directory scans on subsequent polls. */
export function noteAntigravitySessionActivity(sessionsDir: string, transcriptFile: string): void {
  const dirFp = dirFingerprintOf(sessionsDir);
  if (!dirFp) return;
  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(transcriptFile, { bigint: true });
    if (!stat.isFile()) {
      dirScanCache.delete(sessionsDir);
      return;
    }
  } catch {
    dirScanCache.delete(sessionsDir);
    return;
  }
  const cached = dirScanCache.get(sessionsDir);
  const previous = cached?.files.find((item) => item.file === transcriptFile);
  if (previous && !isCachedTopFileIntact(previous, stat)) {
    dirScanCache.delete(sessionsDir);
    return;
  }
  const existing = cached ? cached.files.filter((item) => item.file !== transcriptFile) : [];
  const sessionName = path.basename(path.dirname(transcriptFile));
  const nextKnown = cached?.knownNames ? new Set(cached.knownNames) : null;
  if (nextKnown && isValidAntigravitySessionId(sessionName)) {
    nextKnown.add(sessionName);
  }
  const updated = [toCachedTopFile({ file: transcriptFile, stat }), ...existing]
    .sort((a, b) => (b.mtimeNs > a.mtimeNs ? 1 : b.mtimeNs < a.mtimeNs ? -1 : b.file.localeCompare(a.file)))
    .slice(0, MAX_FILES);
  cacheDirTopFiles(
    sessionsDir,
    dirFp,
    updated,
    nextKnown,
    cached?.fullScanAtMonoMs ?? performance.now(),
  );
}

function sortTopSessionCandidates(candidates: SessionFileCandidate[]): SessionFileCandidate[] {
  return candidates
    .sort((a, b) => (b.stat.mtimeNs > a.stat.mtimeNs ? 1 : b.stat.mtimeNs < a.stat.mtimeNs ? -1 : b.file.localeCompare(a.file)))
    .slice(0, MAX_FILES);
}

function newestSessionFiles(sessionsDir: string): SessionFileCandidate[] {
  const dirFp = dirFingerprintOf(sessionsDir);
  if (!dirFp) {
    dirScanCache.delete(sessionsDir);
    return [];
  }
  const nowMono = performance.now();
  const cached = dirScanCache.get(sessionsDir);
  if (cached && cached.dirFingerprint === dirFp && nowMono - cached.fullScanAtMonoMs < DIR_SCAN_CACHE_TTL_MS) {
    dirScanCache.delete(sessionsDir);
    dirScanCache.set(sessionsDir, cached);
    const live: SessionFileCandidate[] = [];
    let intact = true;
    for (const prev of cached.files) {
      try {
        const stat = fs.statSync(prev.file, { bigint: true });
        if (isCachedTopFileIntact(prev, stat)) {
          live.push({ file: prev.file, stat });
        } else {
          intact = false;
          break;
        }
      } catch {
        intact = false;
        break;
      }
    }
    if (intact && live.length === cached.files.length) {
      const top = sortTopSessionCandidates(live);
      cached.files = top.map(toCachedTopFile);
      return top;
    }
  }

  let dirEntries: string[];
  try {
    dirEntries = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  // Incremental path: when we already scanned this directory and ONLY genuinely
  // new session names appeared (no deletions, no same-name directory replacement,
  // and every cached top-N file kept its dev/ino with monotonic mtime/size),
  // stat ONLY the newly appeared sessions plus the <= MAX_FILES cached top files.
  // On ANY deletion, same-name replacement, or top-N inode/mtime/size regression,
  // rebuild the top-N set from disk so a promoted 6th-newest session is never missed.
  if (cached?.knownNames && nowMono - cached.fullScanAtMonoMs < DIR_SCAN_CACHE_TTL_MS) {
    const currentNames = new Set<string>();
    const addedNames: string[] = [];
    for (const name of dirEntries) {
      if (!isValidAntigravitySessionId(name)) continue;
      currentNames.add(name);
      if (!cached.knownNames.has(name)) addedNames.push(name);
    }
    let anyDeleted = false;
    for (const prevName of cached.knownNames) {
      if (!currentNames.has(prevName)) {
        anyDeleted = true;
        break;
      }
    }
    if (!anyDeleted && addedNames.length > 0 && addedNames.length <= MAX_INCREMENTAL_NEW_DIRS) {
      const seenFiles = new Set<string>();
      const candidates: SessionFileCandidate[] = [];
      let cachedTopIntact = true;
      for (const prev of cached.files) {
        const name = path.basename(path.dirname(prev.file));
        if (!currentNames.has(name)) {
          cachedTopIntact = false;
          break;
        }
        try {
          const stat = fs.statSync(prev.file, { bigint: true });
          if (isCachedTopFileIntact(prev, stat)) {
            candidates.push({ file: prev.file, stat });
            seenFiles.add(prev.file);
          } else {
            cachedTopIntact = false;
            break;
          }
        } catch {
          cachedTopIntact = false;
          break;
        }
      }
      if (cachedTopIntact) {
        const confirmedNames = new Set(currentNames);
        for (const name of addedNames) {
          const file = path.join(sessionsDir, name, "events.jsonl");
          if (seenFiles.has(file)) continue;
          try {
            const stat = fs.statSync(file, { bigint: true });
            if (stat.isFile()) {
              candidates.push({ file, stat });
              seenFiles.add(file);
            } else {
              confirmedNames.delete(name);
            }
          } catch {
            // Directory created before `events.jsonl` landed; leave it unknown so
            // a subsequent scan picks it up once the file appears.
            confirmedNames.delete(name);
          }
        }
        const top = sortTopSessionCandidates(candidates);
        cacheDirTopFiles(sessionsDir, dirFp, top.map(toCachedTopFile), confirmedNames, cached.fullScanAtMonoMs);
        return top;
      }
    }
  }

  const entries: SessionFileCandidate[] = [];
  const knownNames = new Set<string>();
  for (const name of dirEntries) {
    if (!isValidAntigravitySessionId(name)) continue;
    const file = path.join(sessionsDir, name, "events.jsonl");
    try {
      const stat = fs.statSync(file, { bigint: true });
      if (stat.isFile()) {
        entries.push({ file, stat });
        knownNames.add(name);
      }
    } catch { /* incomplete or removed session */ }
  }
  const top = sortTopSessionCandidates(entries);
  cacheDirTopFiles(sessionsDir, dirFp, top.map(toCachedTopFile), knownNames, nowMono);
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
