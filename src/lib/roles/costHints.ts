/**
 * Cost hints for the agent mapping (#1876, design §4.4). The Viewer holds no
 * prices, so the hint is an ordinal built from what it does know: the model's
 * size class and the effort tier. Client-safe: no node:* imports.
 */

import type { RoleEngine } from "./types";

export type CostClass = "light" | "moderate" | "heavy" | "very-heavy";

/* Small = 1, mid = 2, large = 3. Codex slugs match by prefix so a dated or
   suffixed id lands on its family. */
const MODEL_SIZE: readonly (readonly [RegExp, 1 | 2 | 3])[] = [
  [/^haiku\b/, 1],
  [/^gpt-5\.6-luna\b/, 1],
  [/^sonnet\b/, 2],
  [/^gpt-5\.6-terra\b/, 2],
  [/^(opus|fable)\b/, 3],
  [/^gpt-5\.6-sol\b/, 3],
  [/^gpt-6-astra\b/, 3],
];

/** Size class of a catalogued model; an uncatalogued one counts as large. */
export function modelSizeClass(model: string): 1 | 2 | 3 {
  const id = model.trim().toLowerCase();
  return MODEL_SIZE.find(([pattern]) => pattern.test(id))?.[1] ?? 3;
}

const EFFORT_RANK: Record<string, number> = { minimal: 0, low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 4 };

/** Rank of an effort tier on the canonical order; an unknown tier counts as high. */
export function effortRank(effort: string): number {
  return EFFORT_RANK[effort.trim().toLowerCase()] ?? 2;
}

/** Weight = 2 × size + effort. */
export function costWeight(config: { model: string; effort: string }): number {
  return 2 * modelSizeClass(config.model) + effortRank(config.effort);
}

/** ≤ 3 light, 4–6 moderate, 7–8 heavy, ≥ 9 very heavy. */
export function costClass(config: { model: string; effort: string }): CostClass {
  const weight = costWeight(config);
  if (weight <= 3) return "light";
  if (weight <= 6) return "moderate";
  if (weight <= 8) return "heavy";
  return "very-heavy";
}

/** One quota window as the accounts API projects it. */
export type HeadroomWindow = { usedPercent: number; label: "session" | "weekly" | string };

/**
 * The tightest window a model draws on: the session and weekly windows, plus a
 * per-model tier window whose tier names the model's family (`opus` for
 * `seven_day_opus`). Null when the account reported none.
 */
export function tightestHeadroom(
  engine: RoleEngine,
  model: string,
  limits: {
    session?: { usedPercent: number } | null;
    weekly?: { usedPercent: number } | null;
    tiers?: readonly { usedPercent: number; tier: string; label?: string | null }[];
  } | null | undefined,
): { window: string; percentLeft: number } | null {
  if (!limits) return null;
  const family = engine === "claude" ? model.trim().toLowerCase().split(/[-\s]/)[0]! : model.trim().toLowerCase();
  const candidates: { window: string; used: number }[] = [];
  if (limits.session) candidates.push({ window: "session", used: limits.session.usedPercent });
  if (limits.weekly) candidates.push({ window: "weekly", used: limits.weekly.usedPercent });
  for (const tier of limits.tiers ?? []) {
    if (family && tier.tier.toLowerCase().includes(family)) candidates.push({ window: tier.label?.trim() || "weekly", used: tier.usedPercent });
  }
  const valid = candidates.filter((candidate) => Number.isFinite(candidate.used));
  if (!valid.length) return null;
  const tightest = valid.reduce((worst, candidate) => candidate.used > worst.used ? candidate : worst);
  return { window: tightest.window, percentLeft: Math.max(0, Math.min(100, Math.round(100 - tightest.used))) };
}
