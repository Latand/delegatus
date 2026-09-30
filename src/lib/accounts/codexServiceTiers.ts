import fs from "node:fs";
import path from "node:path";
import type { AgentEngine } from "@/lib/agent/cli";

export const SERVICE_TIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export type CodexTierOffer = { id: string; name: string };
const cache = new Map<string, { key: string; models: unknown[] }>();

/** Catalog evidence only: missing or unreadable rows never imply availability. */
export function codexModelServiceTiers(home: string, model: string): CodexTierOffer[] | null {
  const file = path.join(home, "models_cache.json");
  try {
    const stat = fs.statSync(file);
    const key = `${stat.mtimeMs}:${stat.size}`;
    let record = cache.get(file);
    if (record?.key !== key) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      record = { key, models: Array.isArray(parsed.models) ? parsed.models : [] };
      cache.set(file, record);
    }
    const row = record.models.find((value): value is Record<string, unknown> => !!value && typeof value === "object" && (value as { slug?: unknown }).slug === model);
    if (!Array.isArray(row?.service_tiers)) return null;
    return row.service_tiers.filter((tier): tier is CodexTierOffer => !!tier && typeof tier.id === "string" && SERVICE_TIER_PATTERN.test(tier.id))
      .map(tier => ({ id: tier.id, name: typeof tier.name === "string" ? tier.name : tier.id }));
  } catch { return null; }
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
