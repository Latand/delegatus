import type { DurableQuotaObservation } from "./migration/contracts";
const now = Date.parse("2026-10-22T00:00:00.000Z");
export function proactiveObservation(accountId = "account-limited"): DurableQuotaObservation {
  return { engine: "codex", accountId, authenticated: true, observedAt: new Date(now).toISOString(),
    authCheckedAt: new Date(now).toISOString(), bootId: "reserve-fixture", provenance: { source: "live", reason: null, staleSince: null },
    limits: { plan: "pro", capturedAt: now / 1_000, session: { usedPercent: 10, resetsAt: null }, weekly: { usedPercent: 20, resetsAt: null } } };
}
