import { expect, test } from "bun:test";
import { copilotLimitsFromSnapshot, type CopilotQuotaSnapshot } from "./copilotQuota";

const free: CopilotQuotaSnapshot = {
  observedAt: 1_790_000_000,
  chat: { entitlementRequests: 200, remainingPercentage: 99.8, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
  premium_interactions: { entitlementRequests: 0, remainingPercentage: 0, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
  completions: { entitlementRequests: 2000, remainingPercentage: 100, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
};

test("Copilot Free uses chat for the monthly gating window and ignores completions", () => {
  const limits = copilotLimitsFromSnapshot(free);
  expect(limits.weekly?.usedPercent).toBeCloseTo(0.2);
  expect(limits.weekly?.resetsAt).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
  expect(limits.weekly?.windowMinutes).toBe(30 * 1440);
  expect(limits.weekly?.observedAt).toBe(free.observedAt);
  expect(limits.session).toBeNull();
  expect(limits.tiers).toEqual([]);
  expect(limits.plan).toBeNull();
});

test("Copilot paid allowance gates on premium interactions when chat is unlimited", () => {
  const limits = copilotLimitsFromSnapshot({
    observedAt: free.observedAt,
    chat: { entitlementRequests: 0, remainingPercentage: 100, resetDate: null, isUnlimitedEntitlement: true, overageAllowedWithExhaustedQuota: true },
    premium_interactions: { entitlementRequests: 300, remainingPercentage: 10, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
  });
  expect(limits.weekly?.usedPercent).toBe(90);
});

test("the tighter eligible chat or premium bucket gates; completions never gate", () => {
  const limits = copilotLimitsFromSnapshot({
    observedAt: free.observedAt,
    chat: { entitlementRequests: 200, remainingPercentage: 50, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
    premium_interactions: { entitlementRequests: 300, remainingPercentage: 10, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
    completions: { entitlementRequests: 2000, remainingPercentage: 0, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
  });
  expect(limits.weekly?.usedPercent).toBe(90);
});

test("an exhausted completions bucket is ignored when chat is the only metered bucket", () => {
  const limits = copilotLimitsFromSnapshot({
    observedAt: free.observedAt,
    chat: { entitlementRequests: 200, remainingPercentage: 60, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
    completions: { entitlementRequests: 2000, remainingPercentage: 0, resetDate: "2026-10-01T00:00:00Z", isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: false },
  });
  expect(limits.weekly?.usedPercent).toBe(40);
});

test("all unlimited Copilot buckets produce no gating window", () => {
  const limits = copilotLimitsFromSnapshot({
    observedAt: free.observedAt,
    chat: { entitlementRequests: 0, remainingPercentage: 100, resetDate: null, isUnlimitedEntitlement: true, overageAllowedWithExhaustedQuota: true },
    premium_interactions: { entitlementRequests: 0, remainingPercentage: 100, resetDate: null, isUnlimitedEntitlement: true, overageAllowedWithExhaustedQuota: true },
    completions: { entitlementRequests: 0, remainingPercentage: 100, resetDate: null, isUnlimitedEntitlement: true, overageAllowedWithExhaustedQuota: true },
  });
  expect(limits.weekly).toBeNull();
});
