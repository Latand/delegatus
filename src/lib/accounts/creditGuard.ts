import type { EngineLimits } from "@/lib/types";

/** Paid balance, separate from the provider's usage-limit reset credits. */
export interface PaidCredits {
  hasCredits: boolean;
  balance: string | null;
  unlimited: boolean;
}

/** App-server snapshots use camelCase; native transcripts use snake_case. */
export function paidCredits(value: unknown): PaidCredits | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const hasCredits = row.hasCredits ?? row.has_credits;
  if (typeof hasCredits !== "boolean") return undefined;
  return { hasCredits, balance: typeof row.balance === "string" ? row.balance : null, unlimited: row.unlimited === true };
}

export function creditGuardUsedPercent(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.DELEGATUS_CODEX_CREDIT_GUARD_USED_PERCENT ?? env.LLV_CODEX_CREDIT_GUARD_USED_PERCENT);
  return Number.isFinite(configured) && configured > 0 && configured < 100 ? configured : 99;
}

/** A stale guarded balance stays stopped until a new reading proves headroom.
 * Passing a predicted reset alone cannot authorize paid usage. */
export function creditGuardBlock(engine: string, limits: EngineLimits | null | undefined,
  threshold = creditGuardUsedPercent()): { resetsAt: number | null } | null {
  if (engine !== "codex" || !limits?.credits?.hasCredits) return null;
  const windows = [limits.session, limits.weekly].filter(window => window && window.usedPercent >= threshold);
  if (!windows.length) return null;
  return { resetsAt: windows.every(window => window!.resetsAt !== null)
    ? Math.max(...windows.map(window => window!.resetsAt!)) : null };
}

/** Missing windows do not retract a reached cutoff. Only a live, authenticated
 * reading of that window can prove headroom; an explicit empty balance ends
 * the paid-credit policy. Keep each governing window independently. */
export function retainCreditGuardEvidence(previous: EngineLimits | null | undefined,
  current: EngineLimits | null, verified: boolean): EngineLimits | null {
  const credits = !verified && previous?.credits?.hasCredits ? previous.credits : current?.credits ?? previous?.credits;
  const guarded = creditGuardBlock("codex", previous);
  if (!current) return guarded ? previous! : null;
  const merged = { ...current, ...(credits ? { credits } : {}) };
  if (!guarded || credits?.hasCredits === false) return merged;
  for (const key of ["session", "weekly"] as const) {
    const old = previous?.[key];
    const fresh = current[key];
    if (old && old.usedPercent >= creditGuardUsedPercent()
      && (!verified || !fresh || !Number.isFinite(fresh.usedPercent) || fresh.usedPercent < 0 || fresh.usedPercent > 100)) merged[key] = old;
  }
  return merged;
}
