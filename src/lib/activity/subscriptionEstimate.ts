import estimates from "./usageEstimates.json";
import { modelKey, priceTier, tokenCost as apiCost, tokenRate } from "./tokenPrices";
import type { TokenCounts } from "./tokenUsage";
import type { SpendBasis, SpendBudget, SpendEngine } from "./taskLimitSpendTypes";

export { apiCost };
// Price edits invalidate persisted task equivalents even when the editorial
// snapshot label was accidentally left unchanged.
import { createHash } from "node:crypto";

export function estimateVersionAt(date: string): string {
  const applicable = estimates.prices.filter(row => (row.effectiveFrom ?? row.date) <= date && (!row.until || date <= row.until));
  return `${estimates.version}:${createHash("sha256").update(JSON.stringify(applicable)).digest("hex").slice(0,16)}`;
}
export const ESTIMATE_VERSION = estimateVersionAt(new Date().toISOString().slice(0,10));

const METERS = new Map(estimates.meter.map(row => [`${row.engine}:${row.model}:${row.tier}`, row.times]));

export function meterCost(model: string, tier: string, engine: string, counts: TokenCounts, priced?: number | null): number | null {
  const multiplier = METERS.get(`${engine}:${modelKey(model)}:${priceTier(tier)}`);
  if (engine !== "codex") return priced === undefined ? apiCost(model, tier, counts) : priced;
  const standard = tokenRate(model, "standard"), service = tokenRate(model,tier);
  if (!standard) return priced === undefined ? apiCost(model,tier,counts) : priced;
  // Subscription calibration predates the provider's separate cache-write
  // tariff. Preserve that meter unit: cache writes use ordinary input weight.
  const rate = multiplier === undefined ? service ?? standard : standard;
  return (counts.input * rate.input + counts.cacheRead * rate.cacheRead
    + counts.cacheWrite * rate.input + counts.output * rate.output) / 1e6 * (multiplier ?? 1);
}

export function reportedPlan(value: string | null | undefined): string | null {
  const plan = value?.trim();
  return plan && plan.toLowerCase() !== "unknown" ? plan : null;
}

const planKey = (plan: string) => plan.trim().toLowerCase().replace(/[-_ ]/g, "");
const budgetKey = (engine: string, plan: string, window: string, tier: string | null | undefined) =>
  `${engine}:${planKey(plan)}:${window}:${tier ?? ""}`;
const BUDGETS = new Map<string, SpendBudget>(estimates.budgets.map(row => [
  budgetKey(row.engine, row.plan, row.window, row.planTier), {
    low: row.low, mid: row.mid, high: row.high, grade: row.grade as SpendBudget["grade"],
  },
]));

export function planBudget(engine: SpendEngine, plan: string | null, tier: string | null, window = "weekly"): SpendBudget | null {
  if (!plan) return null;
  return BUDGETS.get(budgetKey(engine, plan, window, tier)) ?? BUDGETS.get(budgetKey(engine, plan, window, null)) ?? null;
}

export function planWithoutFixedLimit(plan: string | null, finiteWindowObserved = false): boolean {
  return plan !== null && ["enterprise", "edu"].includes(planKey(plan)) && !finiteWindowObserved;
}

export function shareBasis(measured: number, planned: number): SpendBasis | null {
  if (measured + planned === 0) return null;
  const fraction = measured / (measured + planned);
  return fraction >= 0.9 ? "measured" : fraction <= 0.1 ? "plan" : "mixed";
}

export function estimateShare(weight: number, ratedWeight: number, measuredPp: number | null, budget: SpendBudget | null) {
  const measured = measuredPp === null ? 0 : Math.min(weight, ratedWeight);
  const unrated = Math.max(0, weight - measured);
  const planned = budget ? unrated : 0;
  const observed = measuredPp ?? 0;
  const fromBudget = (limit: number) => planned / limit * 100;
  const basis = shareBasis(measured, planned);
  return {
    measured, planned, basis,
    weeklyPp: basis === null ? null : observed + (budget ? fromBudget(budget.mid) : 0),
    range: basis === null ? null : {
      low: 0.7 * observed + (budget ? fromBudget(budget.high) : 0),
      high: 1.3 * observed + (budget ? fromBudget(budget.low) : 0),
    },
    outsideBudget: Boolean(budget && measured > 0 &&
      (observed < measured / budget.high * 100 || observed > measured / budget.low * 100)),
    missingBudget: !budget && (weight === 0 || unrated > weight * 1e-10),
  };
}
