import usageEstimates from "./usageEstimates.json";
import { addTokens, emptyTokens, tokenTotal, type TokenCounts } from "./tokenUsage";

/*
 * Extra E1 (docs/design/activity-token-usage.md §8): what the counted tokens
 * would cost at the providers' published API prices. Work on a subscription is
 * billed by plan, so the figure is a comparison and is never called spending.
 *
 * Rates in usageEstimates.json are USD per million tokens at short-context
 * prices. Hourly counts cannot distinguish which prompts crossed the
 * long-context thresholds.
 */

export const PRICE_TABLE_DATE = usageEstimates.prices.reduce((latest, row) => row.date > latest ? row.date : latest, "");
export const PRICE_SOURCES = [...new Set(usageEstimates.prices.map(row => usageEstimates.sources[row.source as keyof typeof usageEstimates.sources]))]
  .flatMap(source => "url" in source ? [source.url] : []);

/** Dollars per million tokens. `cacheWrite1h` is the one-hour cache write. */
export interface TokenRate { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number }
export type PriceTier = "standard" | "fast" | "flex" | "ultrafast";

const RATES = new Map(usageEstimates.prices.map(row => {
  const { input, cachedInput, cacheWrite5m, cacheWrite1h, cacheWrite30m, cacheWrite12h, output } = row;
  const claude = row.model.startsWith("claude-");
  return [`${row.model}:${row.tier}:${row.effectiveFrom ?? row.date}`, {
    input, cacheRead: cachedInput, output,
    cacheWrite: cacheWrite5m ?? cacheWrite30m ?? (claude ? input * 1.25 : input),
    cacheWrite1h: cacheWrite1h ?? cacheWrite12h ?? (claude ? input * 2 : input),
  }];
}));

/** Provider price dates follow the Pacific calendar used for published cutovers. */
export function pricingDateAt(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The tier a recorded speed or service tier is billed at; null when the
    table cannot tell. Claude records `standard` or `fast`; Codex records its
    service tier, where `default` is standard and Priority was renamed Fast. */
export function priceTier(tier: string | null | undefined): PriceTier | null {
  switch ((tier ?? "standard").toLowerCase()) {
    case "standard": case "default": case "auto": return "standard";
    case "fast": case "priority": return "fast";
    case "flex": return "flex";
    case "ultrafast": return "ultrafast";
    default: return null;
  }
}

/** A dated snapshot id (`claude-haiku-4-5-20251001`) prices as its model. */
export const modelKey = (model: string) => model.trim().toLowerCase().replace(/-\d{8}$/, "");

const TIMELINES = new Map<string, Array<(typeof usageEstimates.prices)[number]>>();
for (const row of usageEstimates.prices) {
  const key = `${modelKey(row.model)}:${row.tier}`;
  const timeline = TIMELINES.get(key) ?? [];
  timeline.push(row);
  TIMELINES.set(key, timeline);
}
for (const timeline of TIMELINES.values()) timeline.sort((a,b) => (a.effectiveFrom ?? a.date).localeCompare(b.effectiveFrom ?? b.date));

export function tokenRate(model: string, tier: string | null | undefined, pricingDate = pricingDateAt(Date.now())): TokenRate | null {
  const priced = priceTier(tier);
  if (!priced) return null;
  const timeline = TIMELINES.get(`${modelKey(model)}:${priced}`);
  let row: (typeof usageEstimates.prices)[number] | undefined;
  for (const item of timeline ?? []) {
    if ((item.effectiveFrom ?? item.date) > pricingDate) break;
    if (!item.until || pricingDate <= item.until) row = item;
  }
  return row ? RATES.get(`${row.model}:${row.tier}:${row.effectiveFrom ?? row.date}`) ?? null : null;
}

/** Dollars for one model and tier, or null when it has no published price. */
export function tokenCost(model: string, tier: string | null | undefined, counts: TokenCounts, pricingDate?: string): number | null {
  const rate = tokenRate(model, tier, pricingDate);
  if (!rate) return null;
  const write5m = Math.max(0, counts.cacheWrite - counts.cacheWrite1h);
  return (counts.input * rate.input + counts.cacheRead * rate.cacheRead + write5m * rate.cacheWrite
    + counts.cacheWrite1h * rate.cacheWrite1h + counts.output * rate.output) / 1e6;
}

export interface CostEstimate {
  /** Dollars for the priced tokens. */
  usd: number;
  /** Counts with no published price, left out of `usd`. */
  unpriced: TokenCounts;
  /** Models (with any tier) that had no price. */
  unpricedModels: string[];
}

export function estimateCost(rows: ReadonlyArray<{ model: string; tier: string; counts: TokenCounts }>): CostEstimate {
  let usd = 0;
  const unpriced = emptyTokens();
  const models = new Set<string>();
  for (const row of rows) {
    const cost = tokenCost(row.model, row.tier, row.counts);
    if (cost === null) {
      if (tokenTotal(row.counts) > 0) { addTokens(unpriced, row.counts); models.add(row.model); }
    } else usd += cost;
  }
  return { usd, unpriced, unpricedModels: [...models].sort() };
}

/** Per model, across its tiers: dollars, or null when no tokens of it were priced. */
export function costByModel(rows: ReadonlyArray<{ model: string; tier: string; counts: TokenCounts }>): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const row of rows) {
    const cost = tokenCost(row.model, row.tier, row.counts);
    const prior = out.get(row.model);
    out.set(row.model, cost === null ? prior ?? null : (prior ?? 0) + cost);
  }
  return out;
}

export type PricedKind = "input" | "cacheRead" | "cacheWrite" | "output";

/** Per kind, across models and tiers: dollars, or null when no tokens of
    that kind were priced. Cache writes split into their five-minute and
    one-hour rates. */
export function costByKind(rows: ReadonlyArray<{ model: string; tier: string; counts: TokenCounts }>): Record<PricedKind, number | null> {
  const out: Record<PricedKind, number | null> = { input: null, cacheRead: null, cacheWrite: null, output: null };
  const add = (kind: PricedKind, usd: number) => { out[kind] = (out[kind] ?? 0) + usd; };
  for (const row of rows) {
    const rate = tokenRate(row.model, row.tier);
    if (!rate) continue;
    const { counts } = row;
    if (counts.input) add("input", counts.input * rate.input / 1e6);
    if (counts.cacheRead) add("cacheRead", counts.cacheRead * rate.cacheRead / 1e6);
    const write5m = Math.max(0, counts.cacheWrite - counts.cacheWrite1h);
    if (counts.cacheWrite) add("cacheWrite", (write5m * rate.cacheWrite + counts.cacheWrite1h * rate.cacheWrite1h) / 1e6);
    if (counts.output) add("output", counts.output * rate.output / 1e6);
  }
  return out;
}
