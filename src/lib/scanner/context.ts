import { nativeCompaction } from "../session/compaction";
import type { CtxUsage, FileEntry } from "../types";
import { tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { numberValue, recordValue, stringValue } from "./json";
import { claudeCapacity, claudeCapacityHints, type ContextCapacity } from "./contextCapacity";

const ctxCache = globalCache<[number, number, CtxUsage | null, string | null]>("ctx-v3");

function unknownUsage(usedTokens: number, observedAt: string): CtxUsage {
  return { usedTokens, windowTokens: null, pct: null, source: "unknown", confidence: "unknown", observedAt };
}

export function contextUsage(usedTokens: number | null, capacity: ContextCapacity | null, observedAt: string): CtxUsage | null {
  if (usedTokens === null || usedTokens <= 0) return null;
  if (!capacity || capacity.windowTokens <= 0) return unknownUsage(usedTokens, observedAt);
  if (capacity.source !== "runtime" && usedTokens > capacity.windowTokens) return unknownUsage(usedTokens, observedAt);
  const cap = capacity.source === "registry" ? 99 : 100;
  return {
    usedTokens,
    windowTokens: capacity.windowTokens,
    pct: Math.min(cap, Math.round((usedTokens / capacity.windowTokens) * 100)),
    source: capacity.source,
    confidence: capacity.confidence,
    ...(capacity.registryVersion ? { registryVersion: capacity.registryVersion } : {}),
    observedAt,
  };
}

function recordObservedAt(obj: Record<string, unknown>, fallback: string): string {
  const raw = stringValue(obj.timestamp);
  const millis = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : fallback;
}

function codexCtx(obj: Record<string, unknown>, fallbackObservedAt: string): CtxUsage | null {
  const payload = recordValue(obj.payload);
  if (!payload || stringValue(payload.type) !== "token_count") return null;
  const info = recordValue(payload.info);
  if (!info) return null;
  const usage = recordValue(info.last_token_usage) ?? recordValue(info.total_token_usage);
  const windowTokens = numberValue(info.model_context_window);
  if (!usage || windowTokens === null || windowTokens <= 0) return null;
  return contextUsage(
    numberValue(usage.total_tokens),
    { windowTokens, source: "runtime", confidence: "exact" },
    recordObservedAt(obj, fallbackObservedAt),
  );
}

function claudeCtx(obj: Record<string, unknown>, fallbackObservedAt: string, launchModel: string | null): CtxUsage | null {
  if (obj.type !== "assistant") return null;
  const message = recordValue(obj.message);
  const model = stringValue(message?.model);
  if (!message || !model || model === "<synthetic>") return null;
  const usage = recordValue(message.usage);
  if (!usage) return null;
  const used =
    (numberValue(usage.input_tokens) ?? 0) +
    (numberValue(usage.cache_read_input_tokens) ?? 0) +
    (numberValue(usage.cache_creation_input_tokens) ?? 0);
  return contextUsage(used, claudeCapacity(launchModel ?? model, claudeCapacityHints(obj)), recordObservedAt(obj, fallbackObservedAt));
}

/** Context usage from the newest in-band usage record. Capacity resolution is
    synchronous and stays bound to the same record as its token count. */
export function ctxFor(entry: FileEntry): CtxUsage | null {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const mtimeMs = entry.mtime * 1000;
  const cached = ctxCache.get(entry.path);
  const launchModel = entry.launchModel ?? null;
  if (cached?.[0] === entry.size && cached[1] === mtimeMs && cached[3] === launchModel) return cached[2];

  const fallbackObservedAt = new Date().toISOString();
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  let ctx: CtxUsage | null = null;
  for (const obj of tail.records.reverse()) {
    if (nativeCompaction(obj)) break;
    ctx = entry.root === "codex-sessions" ? codexCtx(obj, fallbackObservedAt) : claudeCtx(obj, fallbackObservedAt, launchModel);
    if (ctx) break;
  }
  if (tail.complete) ctxCache.set(entry.path, [entry.size, mtimeMs, ctx, launchModel]);
  return ctx;
}
