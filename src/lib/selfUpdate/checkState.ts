/* Folding one check outcome into what the surface shows (#2007). */
import type { CheckOutcome } from "./git";
import { idleCheck, type CheckState, type Revision } from "./types";

export interface CheckSlice { installed: Revision | null; available: Revision | null; check: CheckState }

export function initialCheck(): CheckSlice {
  return { installed: null, available: null, check: idleCheck() };
}

/** A failed check is its own state and keeps what the previous successful
    check found, so an outage never reads as "up to date" and never hides an
    update that was already seen. */
export function applyCheck(previous: CheckSlice, outcome: CheckOutcome, now: Date, pollMinutes: number): CheckSlice {
  const at = now.toISOString();
  const nextPollAt = new Date(now.getTime() + pollMinutes * 60_000).toISOString();
  if (!outcome.ok) {
    return {
      installed: outcome.installed ?? previous.installed,
      available: previous.available,
      /* A reason of ours travels as a code the client words; git's own
         line travels as it was printed. */
      check: { ...previous.check, state: "failed", at, error: outcome.code ? null : outcome.error, errorCode: outcome.code ?? null, nextPollAt },
    };
  }
  const available = outcome.relation === "behind" || outcome.relation === "diverged" ? outcome.available : null;
  return {
    installed: outcome.installed,
    available,
    check: {
      state: available ? "update-available" : "up-to-date",
      at,
      error: null,
      errorCode: null,
      nextPollAt,
      relation: outcome.relation,
      ahead: outcome.ahead,
      behind: outcome.behind,
      delta: available ? outcome.delta : null,
    },
  };
}
