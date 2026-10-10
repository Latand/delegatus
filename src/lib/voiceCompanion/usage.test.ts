import { expect, test } from "bun:test";
import { backendUsageUsd, BACKEND_RESPONSE_RESERVE_USD } from "./usage";

test("backend accounting includes cached input and the documented large-input premium", () => {
  expect(backendUsageUsd({ input_tokens: 10_000, input_tokens_details: { cached_tokens: 5_000 }, output_tokens: 2_000 })).toBeCloseTo(0.00155, 8);
  expect(backendUsageUsd({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 100_000 }, output_tokens: 512 })).toBeCloseTo(0.182384, 8);
  expect(backendUsageUsd({ input_tokens: 0, output_tokens: 0 })).toBe(0);
  for (const usage of [null, {}, { input_tokens: -1, output_tokens: 0 }, { input_tokens: 1.5, output_tokens: 0 },
    { input_tokens: 5, input_tokens_details: { cached_tokens: 6 }, output_tokens: 0 }]) expect(backendUsageUsd(usage)).toBeNull();
});

test("a cache write is billed at 1.25 times its input rate, and usage that cannot be read gives no figure", () => {
  expect(backendUsageUsd({ input_tokens: 10_000, input_tokens_details: { cached_tokens: 2_000, cache_write_tokens: 4_000 }, output_tokens: 0 })).toBeCloseTo(0.00092, 8);
  // The dearest documented response is the reservation itself: a whole context written to the cache.
  expect(backendUsageUsd({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1_000_000 }, output_tokens: 512 })).toBeCloseTo(0.250384, 8);
  expect(backendUsageUsd({ input_tokens: 1_050_000, input_tokens_details: { cache_write_tokens: 1_050_000 }, output_tokens: 512 })).toBeCloseTo(BACKEND_RESPONSE_RESERVE_USD, 8);
  for (const details of [{ cache_write_tokens: -1 }, { cache_write_tokens: 1.5 }, { cache_write_tokens: "many" }, { cached_tokens: 60, cache_write_tokens: 50 }, "none", 7])
    expect(backendUsageUsd({ input_tokens: 100, input_tokens_details: details, output_tokens: 0 })).toBeNull();
});

test("stored backend tokens reproduce the price across the long-context boundary", async () => {
  const { backendUsageTokens, LIVE_USD_PER_SECOND } = await import("./usage");
  expect(LIVE_USD_PER_SECOND * 60).toBe(0.05);
  for (const input of [272_000, 272_001]) {
    const usage = { input_tokens: input, input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 4000 }, output_tokens: 512 };
    const tokens = backendUsageTokens(usage)!;
    expect(tokens).toEqual({ input, cached: 2000, cacheWrite: 4000, output: 512 });
    const restored = { input_tokens: tokens.input, output_tokens: tokens.output,
      input_tokens_details: { cached_tokens: tokens.cached, cache_write_tokens: tokens.cacheWrite } };
    expect(backendUsageUsd(restored)).toBe(backendUsageUsd(usage));
    const rate = input === 272_000 ? 0.1 : 0.2;
    expect(backendUsageUsd(restored)).toBeCloseTo(((input - 6000) * rate + 4000 * rate * 1.25 + 2000 * rate / 10
      + 512 * (input === 272_000 ? 0.5 : 0.75)) / 1_000_000, 12);
  }
  expect(backendUsageTokens({ input_tokens: 10, output_tokens: 0 })).toEqual({ input: 10, cached: 0, cacheWrite: 0, output: 0 });
  expect(backendUsageTokens({ input_tokens: 10, output_tokens: 0, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 } })).toBeNull();
});
