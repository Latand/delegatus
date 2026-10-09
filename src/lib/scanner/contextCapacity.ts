import type { CtxConfidence, CtxSource } from "../types";
import { MODEL_REGISTRY_VERSION, normalizeModelKey, registryWindow, resolveRegistryKey } from "./modelRegistry";

export interface ContextCapacity {
  windowTokens: number;
  source: Exclude<CtxSource, "unknown">;
  confidence: Exclude<CtxConfidence, "unknown">;
  registryVersion?: string;
}

export interface ContextCapacityHints {
  runtimeWindow?: number | null;
  modes?: readonly string[];
  /** Fresh provider usage can disprove a nominal registry window. */
  reportedContextTokens?: number | null;
}

/** Registry overflow leaves capacity unknown; a runtime window is authoritative. */
export function usableContextCapacity(capacity: ContextCapacity | null, usedTokens: number | null): ContextCapacity | null {
  if (!capacity || capacity.windowTokens <= 0) return null;
  if (capacity.source !== "runtime" && usedTokens !== null && usedTokens > capacity.windowTokens) return null;
  return capacity;
}

/** Runtime capacity wins; explicit launch mode then qualifies the registry row.
 * Pure so the scanner, server advice and panel fallback share the definition. */
export function claudeCapacity(model: string | null, hints: ContextCapacityHints = {}): ContextCapacity | null {
  const runtimeWindow = hints.runtimeWindow;
  if (typeof runtimeWindow === "number" && Number.isFinite(runtimeWindow) && runtimeWindow > 0) {
    return { windowTokens: runtimeWindow, source: "runtime", confidence: "exact" };
  }
  const normalized = model ? normalizeModelKey(model) : null;
  if (!normalized) return null;
  const mode = hints.modes?.some((value) => value.toLowerCase().includes("context-1m-2025-08-07")) ? "1m" : normalized.mode;
  const windowTokens = registryWindow(resolveRegistryKey(normalized.key), mode);
  return usableContextCapacity(windowTokens === null ? null
    : { windowTokens, source: "registry", confidence: "approximate", registryVersion: MODEL_REGISTRY_VERSION }, hints.reportedContextTokens ?? null);
}

export function claudeCapacityHints(row: Record<string, unknown>): ContextCapacityHints {
  const message = row.message && typeof row.message === "object" ? row.message as Record<string, unknown> : {};
  const runtimeWindow = [message.context_window, message.model_context_window].find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
  return {
    runtimeWindow: typeof runtimeWindow === "number" ? runtimeWindow : null,
    modes: [row.beta, row.betas, message.beta, message.betas]
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is string => typeof value === "string"),
  };
}
