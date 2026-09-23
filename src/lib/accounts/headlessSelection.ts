import { gatingWindows } from "./migration/quotaPolicy";
import type { DurableQuotaObservation } from "./migration/contracts";

const FRESH_QUOTA_MS = 5 * 60 * 1_000;

export type HeadlessAccountSelection =
  | { kind: "available"; accountId: string }
  | { kind: "exhausted"; resetsAt: number | null }
  | { kind: "unavailable" };

type SelectableAccount = { id: string; authPresent: boolean };

type Capacity =
  | { kind: "available"; remaining: number }
  | { kind: "exhausted"; resetsAt: number | null }
  | { kind: "unavailable" }
  | { kind: "unknown" };

function capacity(observation: DurableQuotaObservation | undefined, now: number, model?: string | null): Capacity {
  if (!observation) return { kind: "unknown" };
  const observedAt = Date.parse(observation.observedAt);
  const authCheckedAt = Date.parse(observation.authCheckedAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(authCheckedAt) || now < observedAt || now < authCheckedAt) {
    return { kind: "unknown" };
  }
  const observationFresh = now - observedAt <= FRESH_QUOTA_MS;
  const authFresh = now - authCheckedAt <= FRESH_QUOTA_MS;
  const copilotTranscript = observation.engine === "copilot" && observation.provenance.source === "transcript";
  /* Freshness is decided before auth: an old negative auth probe says unknown,
     preserving the account as a fallback while its next probe is pending. */
  if (!authFresh || (!observationFresh && !copilotTranscript)) return { kind: "unknown" };
  if (!observation.authenticated) return observationFresh ? { kind: "unavailable" } : { kind: "unknown" };
  if (!observation.limits) return { kind: "unknown" };
  /* A tier weekly (issues #1358, #1796) gates an unattended spawn like the
     general week does, but only the tier the spawn's own model draws on
     (issue #1431); an unstated model resolves to the launch default. */
  const windows = gatingWindows(observation.engine, observation.limits, model)
    .map((entry) => entry.value)
    .filter((window) => window !== null && window !== undefined);
  if (!windows.length || windows.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 || (window.resetsAt !== null && (!Number.isSafeInteger(window.resetsAt) || window.resetsAt < 0)))) {
    return { kind: "unknown" };
  }
  const remaining = Math.min(...windows.map((window) => 100 - window.usedPercent));
  const nowSeconds = Math.floor(now / 1_000);
  const exhaustedWindows = windows.filter((window) => window.usedPercent >= 100);
  /* Copilot writes a new monthly snapshot after model calls. Stale partial
     balances become unknown; a stale 100% window with a future reset remains a
     stop signal until that reset. A missing or passed reset is unknown. */
  const staleCopilotExhaustion = copilotTranscript && !observationFresh && remaining <= 0
    && exhaustedWindows.length > 0
    && exhaustedWindows.every((window) => window.resetsAt !== null && window.resetsAt > nowSeconds)
    && now - authCheckedAt <= FRESH_QUOTA_MS;
  if (!observationFresh && !staleCopilotExhaustion) {
    return { kind: "unknown" };
  }
  /* Codex transcript reconciliation remains authoritative only for terminal
     exhaustion; ordinary transcript percentages remain unknown. */
  if (observation.provenance.source !== "live"
    && !(copilotTranscript && (observationFresh || staleCopilotExhaustion))
    && !(observation.provenance.source === "transcript" && observationFresh && remaining <= 0)) return { kind: "unknown" };
  if (remaining > 0) return { kind: "available", remaining };
  if (copilotTranscript && exhaustedWindows.some((window) => window.resetsAt === null || window.resetsAt <= nowSeconds)) return { kind: "unknown" };
  if (exhaustedWindows.some((window) => window.resetsAt === null || window.resetsAt <= nowSeconds)) return { kind: "exhausted", resetsAt: null };
  return { kind: "exhausted", resetsAt: Math.max(...exhaustedWindows.map((window) => window.resetsAt!)) };
}

/**
 * Selects an authenticated account for an unattended spawn. Confirmed fresh
 * headroom wins, then an account whose quota is unknown. Exhaustion is only
 * reported when every authenticated account has a fresh zero-capacity sample.
 */
export function selectHeadlessAccount(
  accounts: SelectableAccount[],
  observations: DurableQuotaObservation[],
  preferredId: string | null | undefined,
  excludedIds: string[],
  now = Date.now(),
  /** The model this launch names, so capacity is judged on its own window. */
  model?: string | null,
): HeadlessAccountSelection {
  const byAccount = new Map(observations.map((observation) => [observation.accountId, observation]));
  const excluded = new Set(excludedIds);
  const candidates = accounts
    .filter((account) => account.authPresent)
    .map((account) => ({ account, capacity: capacity(byAccount.get(account.id), now, model) }))
    .filter((candidate) => candidate.capacity.kind !== "unavailable");
  if (!candidates.length) return { kind: "unavailable" };
  for (const attempted of [false, true]) {
    const tier = candidates.filter((candidate) => excluded.has(candidate.account.id) === attempted);
    const available = tier
      .flatMap((candidate) => candidate.capacity.kind === "available" ? [{ ...candidate, remaining: candidate.capacity.remaining }] : [])
      .sort((left, right) => right.remaining - left.remaining || Number(right.account.id === preferredId) - Number(left.account.id === preferredId) || left.account.id.localeCompare(right.account.id));
    if (available[0]) return { kind: "available", accountId: available[0].account.id };
    const unknown = tier
      .filter((candidate) => candidate.capacity.kind === "unknown")
      .sort((left, right) => Number(right.account.id === preferredId) - Number(left.account.id === preferredId) || left.account.id.localeCompare(right.account.id));
    if (unknown[0]) return { kind: "available", accountId: unknown[0].account.id };
  }
  const resets = candidates.flatMap((candidate) => candidate.capacity.kind === "exhausted" && candidate.capacity.resetsAt !== null ? [candidate.capacity.resetsAt] : []);
  return { kind: "exhausted", resetsAt: resets.length ? Math.min(...resets) : null };
}
