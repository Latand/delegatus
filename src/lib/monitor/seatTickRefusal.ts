import type { DeliveryOutcome } from "@/lib/delivery";
import { redactBounded } from "./redact";
import type { SeatTickProjectState, SeatTickRefusalRun } from "./types";

/**
 * The delivery refusals that waiting cannot change, and what the tick does
 * about them.
 *
 * A wake the delivery layer refuses is normally kept under its original key
 * and re-dispatched each check until it lands, the record proves it never
 * actuated, or its age bound retires it. That is right for a refusal that may
 * clear — a host that is starting, an account switch in flight. It is wrong for
 * a seat that can never take a wake again: in production a seat whose host had
 * been gone a fortnight was re-dispatched every check, fenced its project for
 * the whole age bound, retired, and was sent a fresh wake by the next check,
 * for ever.
 *
 * The set is deliberately narrow and matched on the delivery layer's own
 * words, because anything it admits is released at once. A refusal outside it
 * stays on the uncertain and age-bound path, which is the safe default.
 */
export const SEAT_TICK_PERMANENT_REFUSALS = [
  {
    /* The registry refuses to resume a conversation whose account migration
       cannot be rebased. Reached bare from the send, and as the cause after the
       deliverability record's own sentence — "the conversation host was
       reclaimed; automatic resume did not establish a deliverable host: …" —
       which is the no-host-remains-and-resume-is-refused shape. The bare
       reclaimed sentence, with no cause or another cause, is NOT here: a resume
       that failed for want of an account or a spawn may succeed later. */
    reason: "migration-prevents-resume",
    label: "the conversation's account migration prevents resuming it, and no deliverable host remains",
    matches: (error: string) => error.includes("conversation migration prevents resume succession"),
  },
  {
    /* The seat's conversation has a successor. The delivery layer answers the
       bare "superseded" from its own guard, and the deliverability record's
       sentence when a structured send reads it. A seat designation that still
       names a superseded conversation will never be delivered to. */
    reason: "conversation-superseded",
    label: "the seat's conversation was superseded by a successor",
    matches: (error: string) => error === "superseded" || error === "conversation was superseded by a successor",
  },
] as const;

export type SeatTickPermanentRefusalReason = typeof SEAT_TICK_PERMANENT_REFUSALS[number]["reason"];

/** Consecutive attempts released on the same permanent reason after which the
    tick stops preparing wakes for the project. */
export const SEAT_TICK_REFUSAL_CIRCUIT = 3;

const REFUSAL_DETAIL_LIMIT = 300;

export interface SeatTickPermanentRefusal {
  reason: SeatTickPermanentRefusalReason;
  label: string;
  detail: string;
}

/**
 * The permanent refusal this outcome is, or null.
 *
 * Only a refusal that also proves nothing was actuated qualifies — no
 * operation handle, no actuation started, no verify-first resend. That is the
 * same evidence the accounting already takes as a refused dispatch, and it is
 * what lets the attempt be released under its original key.
 */
export function seatTickPermanentRefusal(outcome: DeliveryOutcome): SeatTickPermanentRefusal | null {
  if (outcome.ok || outcome.operationId || outcome.actuation === "started" || outcome.resend === "verify-first") return null;
  const error = (outcome.error ?? "").trim();
  const entry = SEAT_TICK_PERMANENT_REFUSALS.find((candidate) => candidate.matches(error));
  return entry ? { reason: entry.reason, label: entry.label, detail: redactBounded(error, REFUSAL_DETAIL_LIMIT) } : null;
}

/** What a refusal run is counted against. */
export interface SeatTickRefusalBasis {
  seatEpoch: number;
  lastWakeAt: string | null;
  settingsUpdatedAt: string | null;
}

/** The run as it still stands against `basis`, or null once a landing, a
    rotation or a settings write has ended it. */
export function seatTickActiveRefusalRun(state: Pick<SeatTickProjectState, "refusals">, basis: SeatTickRefusalBasis | null): SeatTickRefusalRun | null {
  const run = state.refusals;
  if (!run || !basis) return null;
  if (!Number.isSafeInteger(run.count) || run.count < 1 || typeof run.reason !== "string") return null;
  if (run.seatEpoch !== basis.seatEpoch || run.lastWakeAt !== basis.lastWakeAt || run.settingsUpdatedAt !== basis.settingsUpdatedAt) return null;
  return run;
}

/** The run after one more attempt was released on `refusal`. */
export function seatTickNextRefusalRun(
  state: Pick<SeatTickProjectState, "refusals">,
  basis: SeatTickRefusalBasis,
  refusal: SeatTickPermanentRefusal,
  attempt: { clientMessageId: string; preparedAt: string },
  at: string,
): SeatTickRefusalRun {
  const active = seatTickActiveRefusalRun(state, basis);
  const count = active && active.reason === refusal.reason ? active.count + 1 : 1;
  return { reason: refusal.reason, count, detail: refusal.detail, clientMessageId: attempt.clientMessageId,
    preparedAt: attempt.preparedAt, refusedAt: at, ...basis };
}

export function seatTickRefusalCircuitOpen(run: SeatTickRefusalRun | null): boolean {
  return !!run && run.count >= SEAT_TICK_REFUSAL_CIRCUIT;
}

function labelFor(reason: string): string {
  return SEAT_TICK_PERMANENT_REFUSALS.find((entry) => entry.reason === reason)?.label ?? reason;
}

/** Why the circuit holds this project's wakes, in one sentence for the journal
    and the card. */
export function seatTickRefusalCircuitSentence(run: SeatTickRefusalRun): string {
  return `the delivery layer refused ${run.count} consecutive attempts for a reason waiting cannot change (${labelFor(run.reason)}),`
    + " so the tick prepares no new wake for this project until a wake lands, the seat is rotated, or the project's tick settings are written;"
    + " the seat designation and its tick settings are left as they are";
}

/** The card's account of the newest refused attempt. */
export function seatTickRefusalCardDetail(run: SeatTickRefusalRun): string {
  const circuit = seatTickRefusalCircuitOpen(run) ? ` ${capitalized(seatTickRefusalCircuitSentence(run))}.` : "";
  return `The wake prepared ${run.preparedAt.slice(0, 16).replace("T", " ")} UTC under key ${run.clientMessageId}`
    + ` was refused at its re-dispatch for a reason waiting cannot change: ${labelFor(run.reason)} ("${run.detail}").`
    + " It was released under its original key and no longer holds back this project's wakes."
    + ` ${run.count === 1 ? "This is the first attempt" : `This is attempt ${run.count} in a row`} refused this way.${circuit}`
    + " The seat itself needs an operator action: rotate the seat to a conversation that can take wakes, or repair it and write the project's tick settings to re-enable";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The journal clause for an attempt released on a permanent refusal. */
export function seatTickRefusalReleaseDetail(refusal: SeatTickPermanentRefusal, run: SeatTickRefusalRun): string {
  return `the wake was re-dispatched under its original key and the delivery layer refused it for a reason waiting cannot change`
    + ` (${refusal.reason}: ${refusal.detail}); nothing was actuated, so the attempt is released as refused under its original key,`
    + " nothing it named is acknowledged, and it no longer holds back this project's wakes; the seat needs an operator action"
    + (seatTickRefusalCircuitOpen(run) ? `; ${seatTickRefusalCircuitSentence(run)}` : `; ${run.count} consecutive attempt${run.count === 1 ? "" : "s"} refused this way`);
}
