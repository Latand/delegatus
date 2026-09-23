import type { EngineLimits } from "@/lib/types";

export interface CopilotQuotaBucket {
  entitlementRequests: number;
  remainingPercentage: number;
  resetDate: string | null;
  isUnlimitedEntitlement: boolean;
  overageAllowedWithExhaustedQuota: boolean;
}

export interface CopilotQuotaSnapshot {
  chat?: CopilotQuotaBucket;
  completions?: CopilotQuotaBucket;
  premium_interactions?: CopilotQuotaBucket;
  observedAt: number;
}

function gatingBuckets(snapshot: CopilotQuotaSnapshot): CopilotQuotaBucket[] {
  return [snapshot.chat, snapshot.premium_interactions]
    .filter((bucket): bucket is CopilotQuotaBucket => bucket !== undefined
      && Number.isFinite(bucket.entitlementRequests) && bucket.entitlementRequests > 0
      && !bucket.isUnlimitedEntitlement
      && Number.isFinite(bucket.remainingPercentage)
      && bucket.remainingPercentage >= 0 && bucket.remainingPercentage <= 100)
    .sort((left, right) => left.remainingPercentage - right.remainingPercentage);
}

function monthWindowMinutes(resetDate: string | null): number | null {
  if (resetDate === null) return null;
  const resetMs = Date.parse(resetDate);
  if (!Number.isFinite(resetMs)) return null;
  const priorDay = new Date(resetMs - 1);
  const previousMonthStart = Date.UTC(priorDay.getUTCFullYear(), priorDay.getUTCMonth(), 1);
  return Math.round((resetMs - previousMonthStart) / 60_000);
}

export function copilotLimitsFromSnapshot(snapshot: CopilotQuotaSnapshot): EngineLimits {
  const bucket = gatingBuckets(snapshot)[0];
  const resetMs = bucket?.resetDate ? Date.parse(bucket.resetDate) : Number.NaN;
  const validReset = Number.isFinite(resetMs) ? Math.floor(resetMs / 1000) : null;
  const windowMinutes = bucket ? monthWindowMinutes(bucket.resetDate) : null;
  return {
    session: null,
    weekly: bucket ? {
      usedPercent: 100 - bucket.remainingPercentage,
      resetsAt: validReset,
      windowMinutes,
      observedAt: snapshot.observedAt,
      source: "account",
    } : null,
    tiers: [],
    plan: null,
    capturedAt: Number.isFinite(snapshot.observedAt) ? snapshot.observedAt : null,
  };
}
