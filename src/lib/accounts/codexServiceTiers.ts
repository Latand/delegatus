import fs from "node:fs";
import path from "node:path";
import type { AgentEngine } from "@/lib/agent/cli";

export const SERVICE_TIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export type CodexTierOffer = { id: string; name: string };
const cache = new Map<string, { key: string; models: unknown[] }>();

function catalogModels(home: string): unknown[] | null {
  const file = path.join(home, "models_cache.json");
  try {
    const stat = fs.statSync(file);
    const key = `${stat.mtimeMs}:${stat.size}`;
    let record = cache.get(file);
    if (record?.key !== key) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      record = { key, models: Array.isArray(parsed.models) ? parsed.models : [] };
      cache.set(file, record);
      while (cache.size > 64) cache.delete(cache.keys().next().value!);
    }
    return record.models;
  } catch { return null; }
}

function catalogRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Catalog evidence only: missing or unreadable rows never imply availability. */
export function codexModelServiceTiers(home: string, model: string): CodexTierOffer[] | null {
  const row = catalogModels(home)?.find(value => catalogRow(value) && value.slug === model);
  if (!catalogRow(row)) return null;
  // Older native caches expose speed names rather than service-tier records.
  // An explicit service_tiers array (including an empty one) is authoritative.
  if (!Array.isArray(row.service_tiers)) {
    if (!Array.isArray(row.additional_speed_tiers)) return null;
    const ids = new Set(row.additional_speed_tiers.flatMap(value =>
      value === "fast" ? ["priority"] : value === "ultrafast" ? ["ultrafast"] : []));
    return [...ids].map(id => ({ id, name: id }));
  }
  return row.service_tiers.filter((tier): tier is CodexTierOffer => !!tier && typeof tier.id === "string" && SERVICE_TIER_PATTERN.test(tier.id))
    .map(tier => ({ id: tier.id, name: typeof tier.name === "string" ? tier.name : tier.id }));
}

export type TierDiagnosticAccount = {
  id: string; label?: string; tiers: string[] | null; alternativeModels: string[];
};

/** Describe only the accounts evaluated by the caller's existing admission rule. */
export function serviceTierRefusal(accounts: readonly TierDiagnosticAccount[], model: string, tier: string, accountId?: string | null, selection: "pinned" | "selected" = "pinned"): string {
  const scope = accountId ? `${selection} account ${JSON.stringify(accountId)}` : "allowed accounts";
  const details = accounts.map(account => {
    const name = account.label ? `${JSON.stringify(account.label)} (${account.id})` : JSON.stringify(account.id);
    const offered = account.tiers === null ? "unknown (catalog unavailable)" : [...new Set(account.tiers)].sort().join(", ") || "none";
    const alternatives = [...new Set(account.alternativeModels)].sort();
    return `account ${name}: ${model} offered: ${offered}${alternatives.length ? `; ${tier} offered for other models on this account: ${alternatives.join(", ")}` : ""}`;
  });
  return `no evaluated account offers serviceTier ${tier} for model ${model}; evaluated ${scope}: ${details.join("; ") || "none"}`;
}

export function codexServiceTierRefusal(accounts: readonly { id: string; home: string; label?: string }[], model: string, tier: string, accountId?: string | null, selection: "pinned" | "selected" = "pinned"): string {
  return serviceTierRefusal(accounts.map(account => ({
    id: account.id, label: account.label,
    tiers: codexModelServiceTiers(account.home, model)?.map(value => value.id) ?? null,
    alternativeModels: (catalogModels(account.home) ?? []).filter(catalogRow)
      .filter(row => typeof row.slug === "string" && row.slug !== model && Array.isArray(row.service_tiers)
        && row.service_tiers.some(value => catalogRow(value) && value.id === tier)).map(row => row.slug as string),
  })), model, tier, accountId, selection);
}

export function tierOffers(accounts: readonly { id: string; home: string }[], model: string, tier: string) {
  const offering: string[] = [], lacking: string[] = [];
  const offered = new Set<string>();
  for (const account of accounts) {
    const tiers = codexModelServiceTiers(account.home, model) ?? [];
    for (const value of tiers) offered.add(value.id);
    ((tier === "default" || tier === "standard" || tiers.some(value => value.id === tier)) ? offering : lacking).push(account.id);
  }
  return { offering, lacking, offered: [...offered].sort() };
}

/** Turbo's tiers, fastest first (docs/design/turbo-mode.md §2.2). */
export type TurboTier = "ultrafast" | "priority";

/** The fastest tier this account's catalog lists for the model, or null when it lists neither. */
export function fastestTier(home: string, model: string): TurboTier | null {
  const ids = new Set((codexModelServiceTiers(home, model) ?? []).map(tier => tier.id));
  return ids.has("ultrafast") ? "ultrafast" : ids.has("priority") ? "priority" : null;
}

const TIER_RANK: Record<string, number> = { flex: 0, default: 1, standard: 1, priority: 2, ultrafast: 3 };

/** Whether moving from `from` to `to` is faster. No tier is the default; an unknown id is left alone. */
export function raisesTier(from: string | null | undefined, to: string): boolean {
  const before = TIER_RANK[from ?? "default"];
  const after = TIER_RANK[to];
  return before !== undefined && after !== undefined && after > before;
}

export class CodexServiceTierUnavailableError extends Error {
  readonly code = "service_tier_unavailable";
}

export type LaunchTier = { tier: string | null; required: boolean; source: "explicit" | "fast" | "role-default" | null };
export function codexLaunchTier(input: {
  engine: AgentEngine; model: string | null; fast: unknown; serviceTier: unknown;
  roleDefault?: string | null; roleDefaultApplies: boolean;
}): LaunchTier | { error: string } {
  const explicit = input.serviceTier !== undefined && input.serviceTier !== null;
  if (explicit && (typeof input.serviceTier !== "string" || !SERVICE_TIER_PATTERN.test(input.serviceTier))) return { error: "serviceTier must be a catalog tier id" };
  if (explicit && input.engine !== "codex") return { error: "serviceTier is Codex only" };
  if (explicit && input.fast != null && (input.fast === true ? input.serviceTier !== "priority" : input.serviceTier !== "default" && input.serviceTier !== "standard")) return { error: "fast and serviceTier disagree: fast:true is serviceTier priority; send one of them" };
  const tier = explicit ? input.serviceTier as string : input.fast === true && input.engine === "codex" ? "priority"
    : input.fast == null && input.roleDefaultApplies && input.engine === "codex" ? input.roleDefault ?? null : null;
  if (tier && !input.model) return { error: "serviceTier needs a model: the account's default model is only known after launch" };
  return { tier, required: explicit || input.fast === true, source: explicit ? "explicit" : tier ? input.fast === true ? "fast" : "role-default" : null };
}
