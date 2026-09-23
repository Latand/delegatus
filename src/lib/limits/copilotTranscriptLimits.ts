import fs from "node:fs";
import path from "node:path";

import { copilotLimitsFromSnapshot, type CopilotQuotaBucket, type CopilotQuotaSnapshot } from "./copilotQuota";
import type { LimitRead } from "@/lib/limits";

const MAX_FILES = 5;
const CHUNK_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const QUOTA_KEY = '"quotaSnapshots"';

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

function balancedObjectEnd(text: string, start: number): number | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index + 1;
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

function envelopeTimestamp(linePrefix: string): number | null {
  const match = /"timestamp"\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|(\d+(?:\.\d+)?))/.exec(linePrefix);
  if (!match) return null;
  const value = match[1] ? Date.parse(match[1]) / 1000 : Number(match[2]);
  return Number.isFinite(value) ? value : null;
}

function snapshotInText(text: string): { snapshot: CopilotQuotaSnapshot; timestamp: number } | null {
  let cursor = text.length;
  while (cursor > 0) {
    const keyAt = text.lastIndexOf(QUOTA_KEY, cursor - 1);
    if (keyAt < 0) return null;
    const colon = text.indexOf(":", keyAt + QUOTA_KEY.length);
    const start = colon < 0 ? -1 : text.indexOf("{", colon + 1);
    const end = start < 0 ? null : balancedObjectEnd(text, start);
    if (end !== null) {
      const lineStart = text.lastIndexOf("\n", keyAt) + 1;
      const timestamp = envelopeTimestamp(text.slice(lineStart, keyAt));
      if (timestamp !== null) {
        try {
          const raw = JSON.parse(text.slice(start, end)) as Record<string, unknown>;
          const snapshot: CopilotQuotaSnapshot = {
            observedAt: timestamp,
            ...(quotaBucket(raw.chat) ? { chat: quotaBucket(raw.chat) } : {}),
            ...(quotaBucket(raw.completions) ? { completions: quotaBucket(raw.completions) } : {}),
            ...(quotaBucket(raw.premium_interactions) ? { premium_interactions: quotaBucket(raw.premium_interactions) } : {}),
          };
          if (snapshot.chat || snapshot.completions || snapshot.premium_interactions) return { snapshot, timestamp };
        } catch { /* malformed or truncated event; try an earlier record */ }
      }
    }
    cursor = keyAt;
  }
  return null;
}

function readLatestSnapshot(file: string): CopilotQuotaSnapshot | null {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    let readBytes = 0;
    let contents = Buffer.alloc(0);
    while (readBytes < Math.min(size, MAX_FILE_BYTES)) {
      const length = Math.min(CHUNK_BYTES, size - readBytes, MAX_FILE_BYTES - readBytes);
      const chunk = Buffer.allocUnsafe(length);
      const start = size - readBytes - length;
      const count = fs.readSync(fd, chunk, 0, length, start);
      if (count <= 0) break;
      contents = Buffer.concat([chunk.subarray(0, count), contents]);
      readBytes += count;
      const text = contents.toString("utf8");
      if (text.includes(QUOTA_KEY)) {
        const found = snapshotInText(text);
        if (found) return found.snapshot;
      }
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
