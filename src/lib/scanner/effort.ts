import type { FileEntry } from "../types";
import { agentRegistry, RegistryReadError } from "../agent/registry";
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

const serviceTierCache = globalCache<[number, number, string | null]>("serviceTier-v2");
function normalizeServiceTier(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) return null;
  return value === "standard" ? "default" : value;
}

/** Codex thread settings survive structured starts, later turns and stopped sessions. */
export function entryServiceTier(entry: FileEntry, durableTiers?: ReadonlyMap<string, string | null>): string | null {
  if (entry.engine !== "codex") return null;
  const argv = entry.pid === null ? [] : readArgv(entry.pid);
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-c" && argv[i] !== "--config") continue;
    const match = argv[i + 1].match(/^service_tier\s*=\s*"?([a-z][a-z0-9_-]{0,31})"?$/);
    if (match) return normalizeServiceTier(match[1]);
  }
  const mtimeMs = entry.mtime * 1000;
  const cached = serviceTierCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return cached[2] ?? durableServiceTier(entry, durableTiers);
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
  // An older head setting may have been overridden beyond both read windows.
  // When the tail cannot answer, use the durable profile rather than an old head setting.
  const tier = pick(tail.records);
  if (tail.complete) serviceTierCache.set(entry.path, [entry.size, mtimeMs, tier]);
  return tier ?? durableServiceTier(entry, durableTiers);
}

/** One registry walk per scan, including misses. Conversation generations win
    over continuity aliases and receipts in the same order as registry lookup. */
export function durableServiceTierIndex(registry = agentRegistry()): ReadonlyMap<string, string | null> {
  const tiers = new Map<string, string | null>();
  try {
    const snapshot = registry.readOnlySnapshot();
    const put = (pathname: string, profile: { serviceTier?: string | null; fast?: boolean | null }) => {
      if (!tiers.has(pathname)) tiers.set(pathname, normalizeServiceTier(profile.serviceTier)
        ?? (profile.fast === true ? "priority" : profile.fast === false ? "default" : null));
    };
    for (const conversation of Object.values(snapshot.conversations)) {
      for (const generation of conversation.generations) put(generation.path, generation.launchProfile);
      const current = conversation.generations.at(-1);
      if (current) for (const pathname of conversation.continuityPaths) put(pathname, current.launchProfile);
    }
    for (const receipt of Object.values(snapshot.receipts)) {
      if (receipt.artifactPath) put(receipt.artifactPath, receipt.launchProfile);
    }
  } catch (error) {
    if (!(error instanceof RegistryReadError)) throw error;
  }
  return tiers;
}

function durableServiceTier(entry: FileEntry, tiers?: ReadonlyMap<string, string | null>): string | null {
  if (tiers) return tiers.get(entry.path) ?? null;
  try {
    const profile = agentRegistry().launchProfileForPath(entry.path);
    return normalizeServiceTier(profile?.serviceTier)
      ?? (profile?.fast === true ? "priority" : profile?.fast === false ? "default" : null);
  } catch (error) {
    if (error instanceof RegistryReadError) return null;
    throw error;
  }
}
