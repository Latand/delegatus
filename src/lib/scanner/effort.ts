import type { FileEntry } from "../types";
import { headRecordsResult, tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { recordValue, recordsValue, stringValue } from "./json";
import { readArgv } from "./process";

const effortCache = globalCache<[number, number, string | null]>("effort");

/** Union of all three CLI scales: codex minimal…ultra, claude low…max, and
    OpenClaw's `--thinking`, which adds `off` at the bottom and `adaptive` —
    a request to let the model choose, which is a recorded setting rather than
    a rung on the ladder. Copilot adds `none` at the bottom of its own ladder. */
const TIERS = new Set(["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive"]);

function normalizeEffort(value: string | null | undefined): string | null {
  const tier = value?.trim().toLowerCase() ?? "";
  return TIERS.has(tier) ? tier : null;
}

function pickEffort(entry: FileEntry, obj: Record<string, unknown>): string | null {
  if (entry.root === "codex-sessions" && obj.type === "turn_context") {
    const payload = recordValue(obj.payload);
    const direct = stringValue(payload?.effort);
    if (direct) return direct;
    const settings = recordValue(recordValue(payload?.collaboration_mode)?.settings);
    return stringValue(settings?.reasoning_effort);
  }
  if (entry.root === "copilot-sessions" && (obj.type === "session.start" || obj.type === "session.model_change")) {
    return stringValue(recordValue(obj.data)?.reasoningEffort);
  }
  if (entry.root === "openclaw-sessions" && obj.type === "thinking_level_change") {
    return stringValue(obj.thinkingLevel);
  }
  if (entry.root === "claude-projects" && obj.type === "assistant") {
    const message = recordValue(obj.message);
    const content = recordsValue(message?.content);
    if (content.some((item) => stringValue(item.type) === "thinking")) return "high";
  }
  return null;
}

/** Live-process argv: codex `-c model_reasoning_effort=X`, claude `--effort X`.
    Claude JSONL can still prove thinking use through assistant content blocks. */
function argvEffort(entry: FileEntry): string | null {
  if (entry.pid === null) return null;
  const argv = readArgv(entry.pid);
  for (let i = 0; i < argv.length - 1; i++) {
    if (entry.engine === "codex" && (argv[i] === "-c" || argv[i] === "--config")) {
      const match = argv[i + 1].match(/^model_reasoning_effort\s*=\s*"?([a-z]+)"?$/i);
      if (match) return match[1];
    }
    if (entry.engine === "claude" && argv[i] === "--effort") return argv[i + 1];
  }
  return null;
}

/**
 * Reasoning-effort tier of a transcript entry, or null when undetectable.
 * Codex uses turn_context. Claude uses explicit argv first, then JSONL thinking
 * blocks as a transcript-backed fallback.
 */
export function entryEffort(entry: FileEntry): string | null {
  return entryEffortResult(entry).value;
}

export interface EntryEffortResult {
  value: string | null;
  complete: boolean;
}

export function entryEffortResult(entry: FileEntry): EntryEffortResult {
  if (
    (entry.root !== "claude-projects" && entry.root !== "codex-sessions" && entry.root !== "openclaw-sessions" && entry.root !== "copilot-sessions")
    || !entry.path.endsWith(".jsonl")
  ) {
    return { value: null, complete: true };
  }
  const argv = normalizeEffort(argvEffort(entry));
  if (entry.root === "claude-projects" && argv) return { value: argv, complete: true };
  const mtimeMs = entry.mtime * 1000;
  const cached = effortCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return { value: cached[2] ?? argv, complete: true };
  let effort: string | null = null;
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  let complete = tail.complete;
  for (const obj of tail.records.reverse()) {
    effort = normalizeEffort(pickEffort(entry, obj));
    if (effort) break;
  }
  if (!effort) {
    const head = headRecordsResult(entry.path, entry.size, mtimeMs);
    complete &&= head.complete;
    for (const obj of head.records) {
      effort = normalizeEffort(pickEffort(entry, obj));
      if (effort) break;
    }
  }
  if (complete) effortCache.set(entry.path, [entry.size, mtimeMs, effort]);
  return { value: effort ?? argv, complete };
}

const serviceTierCache = globalCache<[number, number, string | null]>("serviceTier");
function normalizeServiceTier(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) return null;
  return value === "standard" ? "default" : value;
}

/** Codex thread settings survive structured starts, later turns and stopped sessions. */
export function entryServiceTier(entry: FileEntry): string | null {
  if (entry.engine !== "codex") return null;
  const argv = entry.pid === null ? [] : readArgv(entry.pid);
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-c" && argv[i] !== "--config") continue;
    const match = argv[i + 1].match(/^service_tier\s*=\s*"?([a-z][a-z0-9_-]{0,31})"?$/);
    if (match) return normalizeServiceTier(match[1]);
  }
  const mtimeMs = entry.mtime * 1000;
  const cached = serviceTierCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return cached[2];
  const pick = (records: Record<string, unknown>[]) => {
    for (const record of [...records].reverse()) {
      const payload = recordValue(record.payload);
      if (record.type !== "event_msg" || payload?.type !== "thread_settings_applied") continue;
      const tier = normalizeServiceTier(recordValue(payload.thread_settings)?.service_tier);
      if (tier) return tier;
    }
    return null;
  };
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  let tier = pick(tail.records);
  let complete = tail.complete;
  if (!tier) {
    const head = headRecordsResult(entry.path, entry.size, mtimeMs);
    tier = pick(head.records);
    complete &&= head.complete;
  }
  if (complete) serviceTierCache.set(entry.path, [entry.size, mtimeMs, tier]);
  return tier;
}

export function entryFast(entry: FileEntry): boolean | null {
  const tier = entryServiceTier(entry);
  return tier === null ? null : tier !== "default";
}
