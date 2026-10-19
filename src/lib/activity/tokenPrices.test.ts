import { expect, test } from "bun:test";
import { costByKind, costByModel, estimateCost, priceTier, PRICE_TABLE_DATE, tokenCost, tokenRate } from "./tokenPrices";
import type { TokenCounts } from "./tokenUsage";

const million = (counts: Partial<TokenCounts>): TokenCounts => ({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 1, ...counts });

test("the table carries the date its rates were read", () => {
  expect(PRICE_TABLE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("Claude rates split five-minute and one-hour cache writes and use the model's own read rate", () => {
  // Opus 5.5: $4 input, $5 5-minute write, $8 1-hour write, $0.20 read, $20 output.
  const counts = million({ input: 1e6, cacheRead: 1e6, cacheWrite: 3e6, cacheWrite1h: 1e6, output: 1e6, reasoning: 5e5 });
  expect(tokenCost("claude-opus-5-5", "standard", counts)).toBeCloseTo(4 + 0.2 + 2 * 5 + 8 + 20, 6);
  // Fable 5.1 reads at 0.025× input; Sonnet 5.5 at 0.05×.
  expect(tokenRate("claude-fable-5-1", "standard")?.cacheRead).toBe(0.25);
  expect(tokenRate("claude-sonnet-5-5", "standard")?.cacheRead).toBe(0.1);
  expect(tokenRate("claude-haiku-4-5", "standard")?.cacheRead).toBeCloseTo(0.1, 9);
});

test("reasoning is part of output and never priced twice", () => {
  const plain = tokenCost("gpt-6.1-sol", null, million({ output: 1e6 }));
  const reasoned = tokenCost("gpt-6.1-sol", null, million({ output: 1e6, reasoning: 1e6 }));
  expect(plain).toBe(10);
  expect(reasoned).toBe(plain);
});

test("tiers map recorded speeds and service tiers; an unknown tier has no price", () => {
  expect(["standard", "default", null, undefined].map(priceTier)).toEqual(["standard", "standard", "standard", "standard"]);
  expect(priceTier("priority")).toBe("fast");
  expect(priceTier("FAST")).toBe("fast");
  expect(priceTier("ultrafast")).toBe("ultrafast");
  expect(priceTier("scale")).toBeNull();
  expect(tokenCost("gpt-6-astra", "priority", million({ input: 1e6 }))).toBe(20);
  expect(tokenCost("claude-opus-5-5", "fast", million({ input: 1e6, output: 1e6 }))).toBe(48);
  // A tier the provider does not publish for that model is unpriced, never priced as standard.
  expect(tokenCost("gpt-6-luna", "ultrafast", million({ input: 1e6 }))).toBeNull();
  expect(tokenCost("claude-sonnet-5-5", "fast", million({ input: 1e6 }))).toBeNull();
});

test("dated snapshot ids price as their model; unknown and synthetic models read as unpriced", () => {
  expect(tokenCost("claude-haiku-4-5-20251001", "standard", million({ input: 1e6 }))).toBe(1);
  expect(tokenCost("unknown", "standard", million({ input: 1e6 }))).toBeNull();
  expect(tokenCost("fixture-model", "standard", million({ input: 1e6 }))).toBeNull();
});

test("an estimate sums priced rows and keeps unpriced counts and models apart", () => {
  const rows = [
    { model: "claude-opus-5-5", tier: "standard", counts: million({ input: 1e6 }) },
    { model: "gpt-6-luna", tier: "standard", counts: million({ output: 2e6 }) },
    { model: "mystery-model", tier: "standard", counts: million({ input: 5, output: 7 }) },
    { model: "gpt-6-luna", tier: "ultrafast", counts: million({ input: 3 }) },
    { model: "empty-model", tier: "standard", counts: million({}) },
  ];
  const estimate = estimateCost(rows);
  expect(estimate.usd).toBeCloseTo(4 + 1, 9);
  expect(estimate.unpriced).toMatchObject({ input: 8, output: 7, requests: 2 });
  expect(estimate.unpricedModels).toEqual(["gpt-6-luna", "mystery-model"]);
  const byModel = costByModel(rows);
  expect(byModel.get("claude-opus-5-5")).toBe(4);
  expect(byModel.get("gpt-6-luna")).toBeCloseTo(1, 9);
  expect(byModel.get("mystery-model")).toBeNull();
  expect(estimateCost([])).toEqual({ usd: 0, unpriced: million({ requests: 0 }), unpricedModels: [] });
});

test("per-kind costs add up to the estimate and leave a kind with no priced tokens empty", () => {
  const rows = [
    { model: "claude-opus-5-5", tier: "standard", counts: million({ input: 1e6, cacheRead: 2e6, cacheWrite: 3e6, cacheWrite1h: 1e6, output: 1e6 }) },
    { model: "gpt-6.1-sol", tier: "default", counts: million({ input: 1e6, cacheRead: 1e6, output: 1e6 }) },
    { model: "mystery-model", tier: "standard", counts: million({ input: 9e6 }) },
  ];
  const kinds = costByKind(rows);
  expect(kinds.input).toBeCloseTo(4 + 2, 9);
  expect(kinds.cacheRead).toBeCloseTo(0.4 + 0.1, 9);
  expect(kinds.cacheWrite).toBeCloseTo(2 * 5 + 8, 9);
  expect(kinds.output).toBeCloseTo(20 + 10, 9);
  const sum = Object.values(kinds).reduce<number>((total, value) => total + (value ?? 0), 0);
  expect(sum).toBeCloseTo(estimateCost(rows).usd, 9);
  expect(costByKind([{ model: "gpt-6-luna", tier: "standard", counts: million({ output: 1e6 }) }])).toMatchObject({ input: null, cacheRead: null, cacheWrite: null });
});

test("models the providers publish are priced, retired Claude and older OpenAI rows included", () => {
  // Opus 4.5 $5/$25; Opus 4.1 and Opus 4 $15/$75; GPT-5.5 $5 input, $0.50 cached, $30 output.
  expect(tokenCost("claude-opus-4-5-20251101", "standard", million({ input: 1e6, output: 1e6 }))).toBe(30);
  expect(tokenCost("claude-opus-4-1-20250805", "standard", million({ input: 1e6, cacheRead: 1e6, output: 1e6 }))).toBeCloseTo(15 + 1.5 + 75, 9);
  expect(tokenCost("claude-opus-4", "standard", million({ input: 1e6 }))).toBe(15);
  expect(tokenCost("claude-sonnet-4-20250514", "standard", million({ input: 1e6, output: 1e6 }))).toBe(18);
  expect(tokenCost("claude-3-5-haiku-20241022", "standard", million({ input: 1e6, output: 1e6 }))).toBeCloseTo(4.8, 9);
  expect(tokenCost("gpt-5.5", "standard", million({ input: 1e6, cacheRead: 1e6, output: 1e6 }))).toBeCloseTo(5 + 0.5 + 30, 9);
  expect(tokenCost("gpt-5.5", "priority", million({ output: 1e6 }))).toBe(75);
  expect(tokenCost("gpt-5.4-nano", "priority", million({ input: 1e6 }))).toBeNull();
  expect(tokenCost("gpt-5-mini", "flex", million({ input: 1e6 }))).toBe(0.125);
  expect(tokenCost("gpt-5.3-codex", "flex", million({ input: 1e6 }))).toBeNull();
});
