import { expect, test } from "bun:test";
import estimates from "./usageEstimates.json";
import { apiCost, estimateShare, meterCost, planBudget, planWithoutFixedLimit } from "./subscriptionEstimate";
import { emptyTokens } from "./tokenUsage";

test("mixed Claude models use the rates for cache reads, both cache write durations, and output", () => {
  const opus = { input: 300_000, cacheRead: 68_600_000, cacheWrite: 900_000, cacheWrite1h: 100_000, output: 200_000, reasoning: 100_000 };
  const sonnet = { ...emptyTokens(), input: 100_000, cacheRead: 2_000_000, output: 50_000 };
  const usd = apiCost("claude-opus-5-5", "standard", opus)! + apiCost("claude-sonnet-5-5", "standard", sonnet)!;
  expect(usd).toBeCloseTo(24.62, 8);
  expect(meterCost("claude-opus-5-5", "fast", "claude", opus)).toBeCloseTo(47.44);
});

test("Codex metering uses published speed multipliers while API prices use the recorded service tier", () => {
  const counts = { ...emptyTokens(), input: 50_000, cacheRead: 4_930_000, cacheWrite: 100_000, cacheWrite1h: 20_000, output: 20_000 };
  expect(apiCost("gpt-6.1-sol", "priority", counts)).toBeCloseTo(1.986);
  expect(meterCost("gpt-6.1-sol", "priority", "codex", counts)).toBeCloseTo(2.4825);
  expect(apiCost("gpt-6.1-sol", "ultrafast", counts)).toBeCloseTo(5.958);
  expect(meterCost("gpt-6.1-sol", "ultrafast", "codex", counts)).toBeCloseTo(7.944);
  expect(apiCost("gpt-6.2-sol", "ultrafast", counts)).toBeCloseTo(2.979);
  expect(meterCost("gpt-6.2-sol", "ultrafast", "codex", counts)).toBeCloseTo(5.958);
  const mixed = meterCost("gpt-6.2-sol", "default", "codex", counts)! + meterCost("gpt-6-luna", "default", "codex", counts)!;
  expect(mixed).toBeCloseTo(1.0673);
  expect(apiCost("fixture-model", "standard", counts)).toBeNull();
  expect(meterCost("fixture-model", "standard", "codex", counts)).toBeNull();
});

test("weekly share combines measured rates and budget fallback with the full estimate range", () => {
  const budget = planBudget("claude", "max", "default_claude_max_20x")!;
  expect(budget).toEqual({ low: 900, mid: 1600, high: 2300, grade: "measured" });
  const mixed = estimateShare(160, 80, 10, budget);
  expect(mixed).toEqual({ weeklyPp: 15, range: { low: 7 + 80 / 2300 * 100, high: 13 + 80 / 900 * 100 },
    measured: 80, planned: 80, basis: "mixed", missingBudget: false, outsideBudget: true });
  expect(estimateShare(160, 0, null, budget)).toMatchObject({ weeklyPp: 10, basis: "plan", outsideBudget: false });
  expect(estimateShare(160, 144, 9, budget)).toMatchObject({ weeklyPp: 10, basis: "measured" });
  expect(estimateShare(160, 16, 1, budget)).toMatchObject({ weeklyPp: 10, basis: "plan" });
  expect(planBudget("claude", "max", null)).toMatchObject({ mid: 1000, grade: "inferred" });
  expect(planBudget("codex", "pro-lite", null)).toMatchObject({ mid: 360 });
  expect(planBudget("codex", null, null)).toBeNull();
  expect(planBudget("codex", "fixture-plan", null)).toBeNull();
  expect(estimateShare(160, 0, null, null)).toMatchObject({ weeklyPp: null, basis: null, range: null, missingBudget: true });
  expect(estimateShare(160, 80, 3, null)).toMatchObject({ weeklyPp: 3, basis: "measured", missingBudget: true });
  expect(planWithoutFixedLimit("enterprise")).toBe(true);
  expect(planWithoutFixedLimit("fixture-plan")).toBe(false);
  expect(planBudget("claude", "enterprise", null)).toBeNull();
});

test("the versioned data has distinct, sourced, dated rows and current promotions", () => {
  const today = new Date().toISOString().slice(0, 10);
  expect(estimates.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  const groups = [
    { rows: estimates.prices, keys: estimates.prices.map(row => [row.model, row.tier]) },
    { rows: estimates.meter, keys: estimates.meter.map(row => [row.engine, row.model, row.tier]) },
    { rows: estimates.budgets, keys: estimates.budgets.map(row => [row.engine, row.plan, row.window, row.planTier]) },
  ];
  for (const { rows, keys } of groups) {
    expect(new Set(keys.map(key => JSON.stringify(key))).size).toBe(rows.length);
    for (const row of rows) {
      expect(Object.hasOwn(estimates.sources, row.source)).toBe(true);
      expect(new Date(row.date).toISOString().slice(0, 10)).toBe(row.date);
      expect(row.date <= estimates.version.slice(0, 10)).toBe(true);
    }
  }
  for (const { until } of estimates.prices) {
    if (until) expect(today <= until).toBe(true);
  }
  for (const budget of estimates.budgets) {
    expect(budget.low > 0 && budget.low <= budget.mid && budget.mid <= budget.high).toBe(true);
    expect(["measured", "measured-thin", "inferred", "published"]).toContain(budget.grade);
  }
});
