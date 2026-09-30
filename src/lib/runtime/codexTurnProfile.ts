import { StructuredSendRefusedError } from "./engineHost";
import type { RuntimeSendSettings } from "./contracts";
import { isKnownEffortTier } from "@/lib/agent/efforts";

/** Validated fields for turn/start. Steering and native queued entries inherit. */
export function codexTurnProfile(settings: RuntimeSendSettings | undefined, defaults: { model?: string; effort?: string }, catalog: unknown): Record<string, unknown> {
  if (!settings) return defaults.effort ? { effort: defaults.effort } : {};
  const rows = catalog && typeof catalog === "object" && "data" in catalog && Array.isArray(catalog.data) ? catalog.data : [];
  const model = settings.model ?? defaults.model;
  const selected = rows.find(row => row && typeof row === "object" && (model ? row.id === model || row.model === model : row.isDefault === true));
  if (settings.model && !selected) throw new StructuredSendRefusedError("requested Codex model is not in the observed model catalog");
  const effort = settings.effort ?? defaults.effort;
  if (settings.effort && !isKnownEffortTier(settings.effort)) throw new StructuredSendRefusedError("requested Codex effort is invalid");
  if (settings.effort && Array.isArray(selected?.supportedReasoningEfforts)
    && !selected.supportedReasoningEfforts.some((row: { reasoningEffort?: string }) => row.reasoningEffort === effort)) throw new StructuredSendRefusedError("requested Codex effort is unavailable for this model");
  const result: Record<string, unknown> = { ...(settings.model ? { model: settings.model } : {}), ...(effort ? { effort } : {}) };
  for (const field of ["serviceTier", "serviceTierForTurn"] as const) {
    const tier = settings[field];
    if (tier === undefined) continue;
    if (tier !== null && !["auto", "default", "flex", "priority"].includes(tier)) throw new StructuredSendRefusedError("requested Codex service tier is invalid");
    result[field] = tier;
  }
  if (settings.fast !== undefined && settings.serviceTierForTurn === undefined) result.serviceTierForTurn = settings.fast ? "priority" : "default";
  return result;
}

/** Launch tiers belong to the thread, including every adoption and resume. */
export function launchServiceTier(profile: { serviceTier?: string | null; fast: boolean | null }): string | undefined {
  return profile.serviceTier === "standard" ? "default" : profile.serviceTier ?? (profile.fast === true ? "priority" : undefined);
}

export function assertCatalogOffersTier(catalog: unknown, model: string | undefined, tier: string | undefined): void {
  if (!tier || tier === "default" || tier === "standard") return;
  const rows = catalog && typeof catalog === "object" && "data" in catalog && Array.isArray(catalog.data) ? catalog.data : [];
  const row = rows.find(row => row && typeof row === "object" && (model ? row.id === model || row.model === model : row.isDefault === true));
  const offered = Array.isArray(row?.serviceTiers) ? row.serviceTiers.map((value: { id?: unknown }) => value?.id).filter((id: unknown) => typeof id === "string") : [];
  if (!offered.includes(tier)) throw new Error(`requested Codex service tier ${tier} is not offered for ${model ?? "default model"} on this account; offered: ${offered.join(", ") || "none (catalog unavailable)"}`);
}
