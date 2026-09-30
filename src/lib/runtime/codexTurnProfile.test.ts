import { expect, test } from "bun:test";
import { codexTurnProfile } from "./codexTurnProfile";
const catalog = { data: [{ id: "model-a", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
test("normal turns preserve model, effort, sticky and one-turn service tier provenance", () => {
  expect(codexTurnProfile({ model: "model-a", effort: "high", serviceTier: "default", serviceTierForTurn: "priority" }, {}, catalog))
    .toEqual({ model: "model-a", effort: "high", serviceTier: "default", serviceTierForTurn: "priority" });
  expect(codexTurnProfile({ serviceTier: null, serviceTierForTurn: null }, {}, catalog)).toEqual({ serviceTier: null, serviceTierForTurn: null });
  expect(codexTurnProfile({}, {}, catalog)).toEqual({});
  expect(codexTurnProfile({ fast: true }, {}, catalog)).toEqual({ serviceTierForTurn: "priority" });
});
test("invalid explicit profiles fail without a model or effort fallback", () => {
  expect(() => codexTurnProfile({ model: "missing" }, {}, catalog)).toThrow("model catalog");
  expect(() => codexTurnProfile({ effort: "warp" }, {}, catalog)).toThrow("effort is invalid");
  expect(() => codexTurnProfile({ effort: "low" }, {}, catalog)).toThrow("unavailable for this model");
  expect(() => codexTurnProfile({ serviceTier: "unsupported" }, {}, catalog)).toThrow("service tier is invalid");
});

test("thread tier persists exactly and the live catalog fails closed", async () => {
  const { launchServiceTier, assertCatalogOffersTier } = await import("./codexTurnProfile");
  expect(launchServiceTier({ fast: true, serviceTier: "ultrafast" })).toBe("ultrafast");
  expect(launchServiceTier({ fast: true })).toBe("priority");
  expect(launchServiceTier({ fast: false })).toBeUndefined();
  expect(launchServiceTier({ fast: false, serviceTier: "standard" })).toBe("default");
  const tiers = { data: [{ id: "gpt-6-astra", serviceTiers: [{ id: "priority" }, { id: "ultrafast" }] }] };
  expect(() => assertCatalogOffersTier(tiers, "gpt-6-astra", "ultrafast")).not.toThrow();
  expect(() => assertCatalogOffersTier(tiers, "gpt-6-astra", "warp")).toThrow("priority, ultrafast");
  expect(() => assertCatalogOffersTier(null, "gpt-6-astra", "ultrafast")).toThrow("catalog unavailable");
  expect(() => assertCatalogOffersTier(null, "gpt-6-astra", "default")).not.toThrow();
});
