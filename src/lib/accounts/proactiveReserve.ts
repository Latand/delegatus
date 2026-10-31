import { gatingWindows, AUTO_BALANCE_FRESH_MS } from "./migration/quotaPolicy";
import { creditGuardBlock } from "./creditGuard";
import type { DurableQuotaObservation } from "./migration/contracts";

/** Discretionary work cannot use the ordinary selector's unknown fallback.
 * Every required window must be present, including the general week. */
export function proactiveAccountReserveError(accountId: string | null | undefined, allowed: readonly string[] | null,
  observation: DurableQuotaObservation | undefined, now: number, model?: string | null): string | null {
  if (!accountId || allowed !== null && !allowed.includes(accountId)) return "proactive account is outside the allowed pool";
  if (!observation || observation.accountId !== accountId || !observation.authenticated
    || observation.provenance.source !== "live" || observation.provenance.reason !== null || observation.provenance.staleSince !== null) return "proactive capacity requires a successful live observation";
  if ([observation.observedAt, observation.authCheckedAt].some(at => {
    const time = Date.parse(at);
    return !Number.isFinite(time) || now < time || now - time > AUTO_BALANCE_FRESH_MS;
  })) return "proactive capacity observation is stale";
  if (observation.limitReached || creditGuardBlock(observation.engine, observation.limits)) return "proactive account capacity is exhausted";
  const windows = gatingWindows(observation.engine, observation.limits, model);
  if (windows.some(({ value }) => !value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0
    || value.usedPercent > 100 || value.resetsAt !== null && (!Number.isSafeInteger(value.resetsAt) || value.resetsAt < 0))) {
    return "proactive capacity is missing a governing window";
  }
  return windows.some(({ value }) => value!.usedPercent >= 80) ? "proactive account reserve requires usage below 80%" : null;
}
