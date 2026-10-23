import { AUTO_BALANCE_THRESHOLD, gatingWindows } from "./migration/quotaPolicy";
import type { DurableQuotaObservation } from "./migration/contracts";
import { creditGuardBlock } from "./creditGuard";

const FRESH_QUOTA_MS = 5 * 60 * 1_000;

export type HeadlessAccountSelection =
  | { kind: "available"; accountId: string }
  | { kind: "exhausted"; resetsAt: number | null }
  | { kind: "unavailable" };

type SelectableAccount = { id: string; authPresent: boolean };

type Capacity =
  | { kind: "available"; remaining: number; resetsAt: number | null }
  /** `passedResetsAt`: every exhausted window named a reset and the latest
      has already passed, though the reading is still fresh. */
  | { kind: "exhausted"; resetsAt: number | null; passedResetsAt?: number }
  | { kind: "unavailable" }
  | { kind: "unknown" };

function capacity(observation: DurableQuotaObservation | undefined, now: number, model?: string | null, paidCredits = false): Capacity {
  if (!observation) return { kind: "unknown" };
  const guarded = creditGuardBlock(observation.engine, observation.limits);
  if (guarded && !paidCredits) return { kind: "exhausted", ...guarded };
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
  if (paidCredits) return { kind: "available", remaining: 0, resetsAt: null };
  /* The provider's own word that the limit is reached holds without a window
     to read beside it (a workspace member's reading can carry none); it names
     no reset, and holds only while the live reading is fresh. */
  const reached = observationFresh && observation.provenance.source === "live" && observation.limitReached === true;
  if (!observation.limits) return reached ? { kind: "exhausted", resetsAt: null } : { kind: "unknown" };
  /* A tier weekly (issues #1358, #1796) gates an unattended spawn like the
     general week does, but only the tier the spawn's own model draws on
     (issue #1431); an unstated model resolves to the launch default. */
  const windows = gatingWindows(observation.engine, observation.limits, model)
    .map((entry) => entry.value)
    .filter((window) => window !== null && window !== undefined);
  if (!windows.length || windows.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 || (window.resetsAt !== null && (!Number.isSafeInteger(window.resetsAt) || window.resetsAt < 0)))) {
    return reached ? { kind: "exhausted", resetsAt: null } : { kind: "unknown" };
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
  /* The provider's own word that the limit is reached outranks windows that
     still show room; it holds only while the reading is fresh, like they do. */
  if (remaining > 0 && !reached) {
    const binding = windows.filter((window) => 100 - window.usedPercent === remaining);
    return { kind: "available", remaining, resetsAt: binding.every((window) => window.resetsAt !== null && window.resetsAt > nowSeconds)
      ? Math.max(...binding.map((window) => window.resetsAt!)) : null };
  }
  if (!exhaustedWindows.length) return { kind: "exhausted", resetsAt: null };
  if (copilotTranscript && exhaustedWindows.some((window) => window.resetsAt === null || window.resetsAt <= nowSeconds)) return { kind: "unknown" };
  if (exhaustedWindows.some((window) => window.resetsAt === null)) return { kind: "exhausted", resetsAt: null };
  if (exhaustedWindows.some((window) => window.resetsAt! <= nowSeconds)) {
    return { kind: "exhausted", resetsAt: null, passedResetsAt: Math.max(...exhaustedWindows.map((window) => window.resetsAt!)) };
  }
  return { kind: "exhausted", resetsAt: Math.max(...exhaustedWindows.map((window) => window.resetsAt!)) };
}

/**
 * One account's quota verdict with the reading it rests on. A stage guard
 * hold compares `observedAt` with the reading that confirmed the hold, so an
 * aged copy of that reading never counts as new evidence of capacity. An
 * exhausted reading whose named reset has passed while it is still fresh keeps
 * that reset here, so a hold built from it ends at once.
 */
export function accountQuotaVerdict(observations: DurableQuotaObservation[], accountId: string, now = Date.now(),
  model?: string | null): { capacity: Capacity["kind"]; resetsAt: number | null; observedAt: string | null } {
  const observation = observations.find((item) => item.accountId === accountId);
  const verdict = capacity(observation, now, model);
  return { capacity: verdict.kind, resetsAt: verdict.kind === "exhausted" ? verdict.resetsAt ?? verdict.passedResetsAt ?? null : null,
    observedAt: observation?.observedAt ?? null };
}

/**
 * Selects an authenticated account for an unattended spawn. Confirmed fresh
 * headroom wins, then an account whose quota is unknown. Exhaustion is only
 * reported when every authenticated account has a fresh zero-capacity sample
 * or is held by the paid-credit guard.
 *
 * Within each retry tier, accounts above the existing balance threshold (25%
 * remaining in EVERY governing window) spend their soonest binding reset first.
 * The binding window has the least headroom; tied binding windows use their
 * latest reset. If any adequately provisioned candidate lacks a future binding
 * reset, that whole group uses headroom order. This is a total order even with
 * three accounts and partial reset data. Equal resets, or no adequate account,
 * use most headroom, then the routing preference, then account id. No capacity
 * is refused by this ranking; smaller balances remain available fallbacks.
 */
export function selectHeadlessAccount(
  accounts: SelectableAccount[],
  observations: DurableQuotaObservation[],
  preferredId: string | null | undefined,
  excludedIds: string[],
  now = Date.now(),
  /** The model this launch names, so capacity is judged on its own window. */
  model?: string | null,
  /** Project-scoped approval, supplied only by the project account selector. */
  paidCredits?: (accountId: string) => boolean,
): HeadlessAccountSelection {
  const byAccount = new Map(observations.map((observation) => [observation.accountId, observation]));
  const excluded = new Set(excludedIds);
  const candidates = accounts
    .filter((account) => account.authPresent)
    .map((account) => ({ account, capacity: capacity(byAccount.get(account.id), now, model, paidCredits?.(account.id)) }))
    .filter((candidate) => candidate.capacity.kind !== "unavailable");
  if (!candidates.length) return { kind: "unavailable" };
  for (const attempted of [false, true]) {
    const tier = candidates.filter((candidate) => excluded.has(candidate.account.id) === attempted);
    const available = tier
      .flatMap((candidate) => candidate.capacity.kind === "available" ? [{ account: candidate.account, ...candidate.capacity }] : []);
    const adequate = available.filter((candidate) => candidate.remaining > AUTO_BALANCE_THRESHOLD);
    const resetOrder = adequate.length > 0 && adequate.every((candidate) => candidate.resetsAt !== null);
    available.sort((left, right) => {
      const leftAdequate = left.remaining > AUTO_BALANCE_THRESHOLD;
      const rightAdequate = right.remaining > AUTO_BALANCE_THRESHOLD;
      return Number(rightAdequate) - Number(leftAdequate)
        || (resetOrder && leftAdequate && rightAdequate ? left.resetsAt! - right.resetsAt! : 0)
        || right.remaining - left.remaining
        || Number(right.account.id === preferredId) - Number(left.account.id === preferredId)
        || left.account.id.localeCompare(right.account.id);
    });
    if (available[0]) return { kind: "available", accountId: available[0].account.id };
    const unknown = tier
      .filter((candidate) => candidate.capacity.kind === "unknown")
      .sort((left, right) => Number(right.account.id === preferredId) - Number(left.account.id === preferredId) || left.account.id.localeCompare(right.account.id));
    if (unknown[0]) return { kind: "available", accountId: unknown[0].account.id };
  }
  const resets = candidates.flatMap((candidate) => candidate.capacity.kind === "exhausted" && candidate.capacity.resetsAt !== null ? [candidate.capacity.resetsAt] : []);
  return { kind: "exhausted", resetsAt: resets.length ? Math.min(...resets) : null };
}
