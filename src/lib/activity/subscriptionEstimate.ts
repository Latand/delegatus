import estimates from "./usageEstimates.json";
import { modelKey, priceTier, tokenCost as apiCost } from "./tokenPrices";
import type { TokenCounts } from "./tokenUsage";
import type { SpendBasis, SpendBudget, SpendEngine } from "./taskLimitSpendTypes";

export { apiCost };
export const ESTIMATE_VERSION = estimates.version;

const METERS = new Map(estimates.meter.map(row => [`${row.engine}:${row.model}:${row.tier}`, row.times]));

export function meterCost(model: string, tier: string, engine: string, counts: TokenCounts, priced?: number | null): number | null {
  const multiplier = METERS.get(`${engine}:${modelKey(model)}:${priceTier(tier)}`);
  if (multiplier === undefined) return priced === undefined ? apiCost(model, tier, counts) : priced;
  const standard = apiCost(model, "standard", counts);
  return standard === null ? null : standard * multiplier;
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

export function planWithoutFixedLimit(plan: string | null): boolean {
  return plan !== null && ["enterprise", "edu"].includes(planKey(plan));
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
