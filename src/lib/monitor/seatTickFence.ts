import type { SeatTickOutstandingWake, SeatTickProjectState } from "./types";

/**
 * The fence: which attempt is holding this project's wakes back, since when,
 * and when it stops (#1746).
 *
 * A wake carries a stable key so that a send whose outcome is unknown is never
 * repeated blindly, and that is kept. What is not kept is the fence outliving
 * the attempt's own epoch or its age. A wake says "look at the board" and the
 * seat re-derives everything it acts on from bounded reads on every wake, so a
 * wake that arrives twice costs one redundant turn; a wake that never arrives
 * stops the conveyor. The Viewer's own seat spent three and a half hours
 * behind an attempt whose delivery no evidence could ever prove either way
 * (#1672), while every five-minute check computed `wake` and delivered
 * nothing.
 *
 * So the fence is bounded here, in one place, because three surfaces have to
 * agree about it: the check that defers a wake behind it, the diagnostic that
 * reports which attempt withholds, and the settings answer a seat reads when
 * it wants to know why it is not being woken. A fence each of them computed
 * for itself is how a mute tick becomes indistinguishable from a quiet one.
 */

/** Wake intervals an attempt may fence a seat for before it is retired as
    unresolved. Two: a fence longer than that has already cost the seat two
    wakes, which is more than the duplicate it is protecting against. */
export const SEAT_TICK_FENCE_WAKES = 2;

/**
 * The floor under the bound above.
 *
 * The delivery layer settles a send on its own deadline, and a send that
 * reached a seat mid-turn may rest for up to an hour before that settlement
 * decides anything (`SEND_SETTLEMENT_IN_TURN_CEILING_MS` in
 * `@/lib/runtime/sendSettlement`). A fence shorter than that would give up on
 * proving an attempt before the layer holding it has finished trying — turning
 * a wake that was about to be proven landed into a duplicate. Restated rather
 * than imported: the monitor may not reach into the runtime's constants, and
 * the number is a floor here, not the same decision.
 */
export const SEAT_TICK_FENCE_FLOOR_MS = 60 * 60_000;

/** How long one attempt may fence a project whose wakes run this far apart. */
export function seatTickFenceBoundMs(wakeIntervalMs: number): number {
  const bound = Number.isFinite(wakeIntervalMs) && wakeIntervalMs > 0 ? wakeIntervalMs * SEAT_TICK_FENCE_WAKES : 0;
  return Math.max(SEAT_TICK_FENCE_FLOOR_MS, bound);
}

export interface SeatTickFence {
  /** The key the fence is held under — the one an operator reads back off the
      delivery record, never the key of the wake being withheld. */
  clientMessageId: string;
  conversationId: string;
  seatEpoch: number;
  /** Which slot the fencing attempt sits in. A retired attempt fences only
      while the conversation it was addressed to is the seat again (#1594). */
  slot: "outstanding" | "retired";
  /** When the fencing attempt was prepared: since when this project's wakes
      are being held. Null only for an attempt written before the instant
      existed, which the next check stamps. */
  since: string | null;
  /** When it stops fencing, whatever its holder has said by then. Null while
      `since` is, because an age has to be measured from something. */
  lapsesAt: string | null;
  /** True when `lapsesAt` has passed and the attempt is STILL the row's
      outstanding one — because no check has read the row since, or because one
      did and declined to retire it: its holder went on accounting for the
      payload, or a transport call of its own had not returned. It fences until a
      check may move it, which is the one rule #1746 keeps whole, and the
      sentence below says that rather than quoting a lapse already gone by. */
  keptPastBound: boolean;
}

/** When an attempt prepared at `since` stops fencing, or null when there is no
    instant to measure from. */
export function seatTickFenceLapsesAt(since: string | null, wakeIntervalMs: number): string | null {
  const prepared = since ? Date.parse(since) : Number.NaN;
  return Number.isFinite(prepared) ? new Date(prepared + seatTickFenceBoundMs(wakeIntervalMs)).toISOString() : null;
}

/** Whether an attempt prepared at `since` is still inside its bound. An
    attempt with no instant to measure from is inside it: the age bound may
    only end a fence it can date. */
export function seatTickFenceStands(since: string | null, now: number, wakeIntervalMs: number): boolean {
  const prepared = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(prepared)) return true;
  return now - prepared < seatTickFenceBoundMs(wakeIntervalMs);
}

function fenceOf(slot: SeatTickFence["slot"], wake: SeatTickOutstandingWake, since: string | null, wakeIntervalMs: number,
  keptPastBound = false): SeatTickFence {
  return {
    clientMessageId: wake.clientMessageId,
    conversationId: wake.conversationId,
    seatEpoch: wake.seatEpoch,
    slot,
    since,
    lapsesAt: seatTickFenceLapsesAt(since, wakeIntervalMs),
    keptPastBound,
  };
}

/**
 * The attempt holding this project's next wake back, or null.
 *
 * Two attempts can fence, and for the same reason — a payload that could still
 * reach the conversation the tick is about to wake:
 *
 * - the outstanding one, whatever it is addressed to. It is the project's one
 *   prepared attempt, and while it stands no second wake is prepared beside
 *   it: that, not a permanent fence, is what keeps one wake in flight per seat.
 * - a retired one still addressed to the conversation that IS the seat — a
 *   seat re-designated back onto it (#1594).
 *
 * Both are bounded by age now. When several stand, the one that lapses last is
 * the answer, because that is the instant the project's wakes actually resume.
 */
export function seatTickWakeFence(
  state: Pick<SeatTickProjectState, "outstandingWake" | "retiredWakes">,
  seat: { conversationId: string | null } | null,
  now: number,
  wakeIntervalMs: number,
): SeatTickFence | null {
  const candidates: SeatTickFence[] = [];
  const outstanding = state.outstandingWake;
  if (outstanding) candidates.push(fenceOf("outstanding", outstanding, outstanding.preparedAt ?? null, wakeIntervalMs));
  for (const entry of state.retiredWakes ?? []) {
    if (!seat?.conversationId || entry.wake.conversationId !== seat.conversationId) continue;
    candidates.push(fenceOf("retired", entry.wake, entry.wake.preparedAt ?? entry.retiredAt, wakeIntervalMs));
  }
  const standing = candidates.filter((candidate) => seatTickFenceStands(candidate.since, now, wakeIntervalMs));
  if (!standing.length) return null;
  return standing.reduce((latest, candidate) => {
    if (!latest.lapsesAt) return latest;
    if (!candidate.lapsesAt) return candidate;
    return candidate.lapsesAt > latest.lapsesAt ? candidate : latest;
  });
}

/**
 * The holder answers that account for the payload, which no bound may overrule.
 *
 * `retained` is the one that matters: a layer that affirms it still HAS the
 * payload is going to deliver it, and retiring that would turn a wake still on
 * its way into a guaranteed duplicate. `landed` and `dropped` are settlements —
 * the check acts on them, and neither leaves anything for an age bound to do.
 */
const ACCOUNTED_FOR: ReadonlySet<string> = new Set(["retained", "landed", "dropped"]);

/**
 * Whether a check may retire this attempt on its age alone (#1746).
 *
 * Three conditions, and each of them is the fence doing a job worth keeping:
 * nothing has accounted for the payload either way, no transport call of its
 * own is out — a send mid-flight plus a second wake is two wakes to one seat,
 * the failure the fence exists for — and the whole bound has been spent,
 * measured from an instant the row records.
 *
 * The check acts on this; the diagnostic reports what it implies, so "this
 * attempt is holding the project's wakes back" is one reading rather than two.
 */
export function seatTickFenceRetirableOnAge(
  wake: SeatTickOutstandingWake,
  observed: string | null,
  now: number,
  wakeIntervalMs: number,
): boolean {
  if (observed !== null && ACCOUNTED_FOR.has(observed)) return false;
  if (wake.dispatch?.state === "active") return false;
  return !seatTickFenceStands(wake.preparedAt ?? null, now, wakeIntervalMs);
}

/**
 * The fence a caller that cannot ask the holders reports (#1746).
 *
 * The bounded fence when there is one, and otherwise the row's own outstanding
 * attempt if it still carries one: its bound is spent, so it is what a check
 * would run into, and whether that check may move it depends on an answer only
 * the check asks for. Read by the settings answer a seat consults when it wants
 * to know why it is not being woken, by the diagnostics, and by a check whose
 * prepare was refused — one reading, three surfaces.
 */
export function seatTickReportedFence(
  state: Pick<SeatTickProjectState, "outstandingWake" | "retiredWakes">,
  seat: { conversationId: string | null } | null,
  now: number,
  wakeIntervalMs: number,
): SeatTickFence | null {
  return seatTickWakeFence(state, seat, now, wakeIntervalMs)
    ?? (state.outstandingWake ? seatTickHeldFence(state.outstandingWake, now, wakeIntervalMs) : null);
}

/**
 * The fence a check ran into although the bound had been spent (#1746).
 *
 * A check that reaches its age bound may still leave an attempt outstanding —
 * its holder reports it queued, or a transport call of its own has not
 * returned — and then no replacement wake is prepared beside it, because one
 * wake in flight per seat is the rule the age bound was never meant to touch.
 * Read from the row the refusal left behind, so the deferral says which key
 * kept it rather than only that something did.
 */
export function seatTickHeldFence(wake: SeatTickOutstandingWake, now: number, wakeIntervalMs: number): SeatTickFence {
  const since = wake.preparedAt ?? null;
  return fenceOf("outstanding", wake, since, wakeIntervalMs, !seatTickFenceStands(since, now, wakeIntervalMs));
}

/** An instant an operator reads, to the minute, in the journal's own form. */
function stamp(at: string | null): string {
  return at ? `${at.slice(0, 16).replace("T", " ")} UTC` : "an instant the row does not record";
}

/**
 * Why this tick is mute, in one sentence (#1746).
 *
 * Every word of it is a fact an operator can check: which key the fence is
 * held under, since when, and when it lapses on its own. The journal line for
 * a deferred wake and the settings answer both carry this, so "the tick is
 * fenced" is never something that has to be inferred from a deferral count.
 */
export function seatTickFenceSentence(fence: SeatTickFence): string {
  const opening = `this tick is fenced by the wake prepared ${stamp(fence.since)} under key ${fence.clientMessageId}`
    + ", which is unresolved: no replacement wake is sent for this project until it settles";
  /* Past the bound and still outstanding: the lapse has been and gone, and
     quoting it as a future release would be the mute tick told a new way. What
     an operator needs instead is the reason a check declined to move it. */
  if (fence.keptPastBound) {
    return `${opening}, and its age bound was spent ${fence.lapsesAt ? `at ${stamp(fence.lapsesAt)}` : "before now"}`
      + ": the next check retires it unresolved and may wake this project, unless the layer holding it reports by then that it still has the payload"
      + ", or a transport call of its own has not returned";
  }
  return `${opening}, and the fence lapses ${fence.lapsesAt ? `at ${stamp(fence.lapsesAt)}` : "once a check has an instant to measure its age from"}`
    + ", after which the attempt is retired unresolved and the next check may wake";
}

/** The same fact for a caller that has to answer when there is no fence. */
export function seatTickFenceDetail(fence: SeatTickFence | null): string {
  return fence ? seatTickFenceSentence(fence) : "no attempt is holding this project's wakes back";
}
