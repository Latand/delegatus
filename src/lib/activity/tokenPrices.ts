import { addTokens, emptyTokens, tokenTotal, type TokenCounts } from "./tokenUsage";

/*
 * Extra E1 (docs/design/activity-token-usage.md §8): what the counted tokens
 * would cost at the providers' published API prices. Work on a subscription is
 * billed by plan, so the figure is a comparison and is never called spending.
 *
 * The table is kept by hand. Every rate is US dollars per million tokens, read
 * on PRICE_TABLE_DATE from the two pages in PRICE_SOURCES; update the date with
 * the rates. A model, or a tier of it, missing here has no published price and
 * reads «—». Rates are the short-prompt rates: Claude Haiku 5.5 above 100 000
 * prompt tokens and OpenAI prompts above 272 000 input tokens cost more, and
 * the counts are summed per hour, not per request, so the estimate can only
 * fall short there.
 */

export const PRICE_TABLE_DATE = "2026-10-18";
export const PRICE_SOURCES = [
  "https://platform.claude.com/docs/en/about-claude/pricing",
  "https://developers.openai.com/api/docs/pricing",
] as const;

/** Dollars per million tokens. `cacheWrite1h` is the one-hour cache write. */
export interface TokenRate { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number }
export type PriceTier = "standard" | "fast" | "flex" | "ultrafast";

/* Claude: cache writes are 1.25× input for five minutes and 2× for an hour;
   reads are 0.1× input except where the page names its own rate. Fast mode
   swaps the input and output rates and keeps the cache multipliers. */
const claude = (input: number, output: number, read = input / 10): TokenRate => ({ input, cacheRead: read, cacheWrite: input * 1.25, cacheWrite1h: input * 2, output });
/* OpenAI: no cache-write rate is published; written input is priced as input. */
const openai = (input: number, cached: number, output: number): TokenRate => ({ input, cacheRead: cached, cacheWrite: input, cacheWrite1h: input, output });

const RATES: Readonly<Record<string, Partial<Record<PriceTier, TokenRate>>>> = {
  "claude-fable-5-1": { standard: claude(10, 50, 0.25) },
  "claude-fable-5": { standard: claude(10, 50, 1) },
  "claude-opus-5-5": { standard: claude(4, 20, 0.2), fast: claude(8, 40, 0.4) },
  "claude-opus-5": { standard: claude(5, 25), fast: claude(10, 50) },
  "claude-opus-4-8": { standard: claude(5, 25), fast: claude(10, 50) },
  "claude-opus-4-7": { standard: claude(5, 25) },
  "claude-opus-4-6": { standard: claude(5, 25) },
  "claude-sonnet-5-5": { standard: claude(2, 10, 0.1) },
  "claude-sonnet-5": { standard: claude(2, 10) },
  "claude-sonnet-4-6": { standard: claude(3, 15) },
  "claude-sonnet-4-5": { standard: claude(3, 15) },
  "claude-haiku-5-5": { standard: claude(0.1, 0.5) },
  "claude-haiku-4-5": { standard: claude(1, 5) },
  "gpt-6-astra": { standard: openai(10, 1, 50), flex: openai(5, 0.5, 25), fast: openai(20, 2, 100), ultrafast: openai(60, 6, 300) },
  "gpt-6.1-sol": { standard: openai(2, 0.1, 10), flex: openai(1, 0.05, 5), fast: openai(4, 0.2, 20), ultrafast: openai(12, 0.6, 60) },
  "gpt-6-sol": { standard: openai(2, 0.2, 10), flex: openai(1, 0.1, 5), fast: openai(4, 0.4, 20) },
  "gpt-6-luna": { standard: openai(0.1, 0.01, 0.5), flex: openai(0.05, 0.005, 0.25), fast: openai(0.2, 0.02, 1) },
  "gpt-5.6-sol": { standard: openai(4, 0.4, 20), flex: openai(2, 0.2, 10), fast: openai(8, 0.8, 40) },
  "gpt-5.6-terra": { standard: openai(2, 0.2, 12), flex: openai(1, 0.1, 6), fast: openai(4, 0.4, 24) },
  "gpt-5.6-luna": { standard: openai(0.2, 0.02, 1.2), flex: openai(0.1, 0.01, 0.6), fast: openai(0.4, 0.04, 2.4) },
};

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
const modelKey = (model: string) => model.trim().toLowerCase().replace(/-\d{8}$/, "");

export function tokenRate(model: string, tier: string | null | undefined): TokenRate | null {
  const priced = priceTier(tier);
  return priced ? RATES[modelKey(model)]?.[priced] ?? null : null;
}

/** Dollars for one model and tier, or null when it has no published price. */
export function tokenCost(model: string, tier: string | null | undefined, counts: TokenCounts): number | null {
  const rate = tokenRate(model, tier);
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
