import { expect, test } from "bun:test";
import { backendUsageUsd } from "./usage";

test("backend accounting includes cached input and the documented large-input premium", () => {
  expect(backendUsageUsd({ input_tokens: 10_000, input_tokens_details: { cached_tokens: 5_000 }, output_tokens: 2_000 })).toBeCloseTo(0.00155, 8);
  expect(backendUsageUsd({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 100_000 }, output_tokens: 512 })).toBeCloseTo(0.182384, 8);
  expect(backendUsageUsd({ input_tokens: 0, output_tokens: 0 })).toBe(0);
  for (const usage of [null, {}, { input_tokens: -1, output_tokens: 0 }, { input_tokens: 1.5, output_tokens: 0 },
    { input_tokens: 5, input_tokens_details: { cached_tokens: 6 }, output_tokens: 0 }]) expect(backendUsageUsd(usage)).toBeNull();
});
