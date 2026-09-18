import { expect, test } from "bun:test";

import {
  SEAT_TICK_FENCE_FLOOR_MS,
  SEAT_TICK_FENCE_WAKES,
  seatTickFenceBoundMs,
  seatTickFenceDetail,
  seatTickFenceLapsesAt,
  seatTickFenceSentence,
  seatTickFenceRetirableOnAge,
  seatTickFenceStands,
  seatTickHeldFence,
  seatTickReportedFence,
  seatTickWakeFence,
} from "./seatTickFence";
import { emptySeatTickState, type SeatTickOutstandingWake, type SeatTickProjectState, type SeatTickRetiredWake } from "./types";

const SEAT = ["conversation", "0f4c21b7729fbc9e"].join("_");
const OTHER = ["conversation", "5b7729fbc9e0f4c2"].join("_");
const MINUTE = 60_000;
const NOW = Date.parse("2026-09-18T07:00:00.000Z");

function wake(overrides: Partial<SeatTickOutstandingWake> = {}): SeatTickOutstandingWake {
  return {
    clientMessageId: "seat-tick:viewer:169:2026-09-10T05:33:29.256Z:child-terminal:fp-1",
    conversationId: SEAT,
    seatEpoch: 169,
    operationId: null,
    preparedAt: new Date(NOW - 30 * MINUTE).toISOString(),
    commit: { proposal: false, reasons: [], fingerprint: "fp-1", eventsThrough: 7, children: [] },
    ...overrides,
  };
}

function retired(overrides: Partial<SeatTickRetiredWake> = {}): SeatTickRetiredWake {
  return {
    wake: wake({ clientMessageId: "retired-key" }),
    retiredAt: new Date(NOW - 20 * MINUTE).toISOString(),
    supersededBy: { conversationId: OTHER, seatEpoch: 170 },
    reason: "seat-superseded",
    ...overrides,
  };
}

function row(overrides: Partial<SeatTickProjectState> = {}): SeatTickProjectState {
  return { ...emptySeatTickState(), ...overrides };
}

/* The bound is the project's own cadence, floored — so a project woken every
   twenty minutes is not fenced for a whole default hour beyond it, and one
   woken every minute does not give up on an attempt the delivery layer has not
   finished settling. */
test("the bound is two wake intervals, never under the floor", () => {
  expect(seatTickFenceBoundMs(90 * MINUTE)).toBe(SEAT_TICK_FENCE_WAKES * 90 * MINUTE);
  expect(seatTickFenceBoundMs(20 * MINUTE)).toBe(SEAT_TICK_FENCE_FLOOR_MS);
  expect(seatTickFenceBoundMs(MINUTE)).toBe(SEAT_TICK_FENCE_FLOOR_MS);
  for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(seatTickFenceBoundMs(nonsense)).toBe(SEAT_TICK_FENCE_FLOOR_MS);
  }
});

/* An attempt with no instant to measure from is inside its bound: an age bound
   may only end a fence it can date, and the check that reads the attempt is
   what stamps it. */
test("a fence stands until its bound is spent, and an undated one always stands", () => {
  const interval = 90 * MINUTE;
  const prepared = new Date(NOW - 3 * 60 * MINUTE).toISOString();
  expect(seatTickFenceStands(prepared, NOW, interval)).toBe(false);
  expect(seatTickFenceStands(prepared, NOW - MINUTE, interval)).toBe(true);
  expect(seatTickFenceStands(null, NOW, interval)).toBe(true);
  expect(seatTickFenceStands("not an instant", NOW, interval)).toBe(true);
  expect(seatTickFenceLapsesAt(prepared, interval)).toBe(new Date(Date.parse(prepared) + 3 * 60 * MINUTE).toISOString());
  expect(seatTickFenceLapsesAt(null, interval)).toBeNull();
});

/* The outstanding attempt is the project's one prepared attempt: while it
   stands no second wake is prepared beside it, whichever conversation it was
   addressed to. That is the "one wake in flight per seat" rule, and it is the
   half of the fence #1746 keeps. */
test("an outstanding attempt inside its bound fences, and past it does not", () => {
  const state = row({ outstandingWake: wake() });
  const fence = seatTickWakeFence(state, { conversationId: SEAT }, NOW, 60 * MINUTE);
  expect(fence).toMatchObject({ slot: "outstanding", clientMessageId: wake().clientMessageId, seatEpoch: 169 });
  expect(fence!.since).toBe(wake().preparedAt!);
  expect(fence!.lapsesAt).toBe(new Date(Date.parse(wake().preparedAt!) + 2 * 60 * MINUTE).toISOString());

  /* Addressed to a conversation that is not the seat — still one prepared
     attempt, still fencing, still bounded. */
  expect(seatTickWakeFence(row({ outstandingWake: wake({ conversationId: OTHER }) }), { conversationId: SEAT }, NOW, 60 * MINUTE)).not.toBeNull();

  const spent = NOW + 2 * 60 * MINUTE;
  expect(seatTickWakeFence(state, { conversationId: SEAT }, spent, 60 * MINUTE)).toBeNull();
});

/* A retired attempt fences only where its payload could still reach the
   conversation about to be woken (#1594) — and, now, only inside its bound. */
test("a retired attempt fences only the seat it was addressed to, and only inside its bound", () => {
  const state = row({ retiredWakes: [retired()] });
  expect(seatTickWakeFence(state, { conversationId: SEAT }, NOW, 60 * MINUTE)).toMatchObject({ slot: "retired", clientMessageId: "retired-key" });
  expect(seatTickWakeFence(state, { conversationId: OTHER }, NOW, 60 * MINUTE)).toBeNull();
  expect(seatTickWakeFence(state, null, NOW, 60 * MINUTE)).toBeNull();
  expect(seatTickWakeFence(state, { conversationId: SEAT }, NOW + 2 * 60 * MINUTE, 60 * MINUTE)).toBeNull();

  /* One retired before the instant existed is dated by its retirement. */
  const undated = retired({ wake: { ...wake({ clientMessageId: "old-key" }), preparedAt: undefined } });
  const fence = seatTickWakeFence(row({ retiredWakes: [undated] }), { conversationId: SEAT }, NOW, 60 * MINUTE);
  expect(fence!.since).toBe(undated.retiredAt);
});

/* Several can stand at once, and the answer has to be the one the project is
   actually waiting for: the last to lapse. */
test("the fence that lapses last is the one reported", () => {
  const older = retired({ wake: wake({ clientMessageId: "older", preparedAt: new Date(NOW - 50 * MINUTE).toISOString() }) });
  const state = row({ outstandingWake: wake({ clientMessageId: "newer", preparedAt: new Date(NOW - 10 * MINUTE).toISOString() }), retiredWakes: [older] });
  expect(seatTickWakeFence(state, { conversationId: SEAT }, NOW, 60 * MINUTE)).toMatchObject({ clientMessageId: "newer" });

  /* And once the newer one is gone, the older one's own remaining bound is
     what the project is waiting for — not "no fence". */
  expect(seatTickWakeFence(row({ retiredWakes: [older] }), { conversationId: SEAT }, NOW, 60 * MINUTE)).toMatchObject({ clientMessageId: "older" });
});

/* The sentence is the surface of all of this: a seat asking why it is not
   being woken has to read the key, the instant and the lapse without opening
   the accounting database (#1672, #1746). */
test("the fence says which key, since when and when it lapses", () => {
  const fence = seatTickWakeFence(row({ outstandingWake: wake() }), { conversationId: SEAT }, NOW, 60 * MINUTE)!;
  const sentence = seatTickFenceSentence(fence);
  expect(sentence).toContain("this tick is fenced");
  expect(sentence).toContain(fence.clientMessageId);
  expect(sentence).toContain("2026-09-18 06:30 UTC");
  expect(sentence).toContain("lapses at 2026-09-18 08:30 UTC");
  expect(sentence).toContain("retired unresolved");
  expect(seatTickFenceDetail(fence)).toBe(sentence);
  expect(seatTickFenceDetail(null)).toBe("no attempt is holding this project's wakes back");

  const undated = seatTickWakeFence(row({ outstandingWake: wake({ preparedAt: undefined }) }), { conversationId: SEAT }, NOW, 60 * MINUTE)!;
  expect(seatTickFenceSentence(undated)).toContain("once a check has an instant to measure its age from");
});

/* The other half of the bound, and the one that keeps "one wake in flight per
   seat" whole: a check may reach an attempt's age bound and still leave it
   outstanding, because its holder goes on accounting for the payload. The wake
   this check wanted to raise is refused, and the refusal has to name the key
   that kept it rather than read as a bare deferral. */
test("an attempt kept past its bound still fences, and the sentence says so instead of quoting a lapse gone by", () => {
  const held = seatTickHeldFence(wake(), NOW, 20 * MINUTE);
  expect(held).toMatchObject({ slot: "outstanding", keptPastBound: false, clientMessageId: wake().clientMessageId });

  /* Prepared three hours ago, on a project whose bound is one: spent. */
  const spent = seatTickHeldFence(wake({ preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() }), NOW, 20 * MINUTE);
  expect(spent.keptPastBound).toBe(true);
  expect(spent.lapsesAt).toBe(new Date(NOW - 2 * 60 * MINUTE).toISOString());
  const sentence = seatTickFenceSentence(spent);
  expect(sentence).toContain(spent.clientMessageId);
  expect(sentence).toContain("age bound was spent at 2026-09-18 05:00 UTC");
  expect(sentence).toContain("the next check retires it unresolved and may wake this project");
  expect(sentence).toContain("unless the layer holding it reports by then that it still has the payload");
  /* And it does not promise a release that is already in the past. */
  expect(sentence).not.toContain("the fence lapses at");

  /* An undated attempt is inside its bound wherever the clock is, so the
     sentence is the standing one. */
  expect(seatTickHeldFence(wake({ preparedAt: undefined }), NOW, 20 * MINUTE).keptPastBound).toBe(false);
});

/* The predicate the check acts on and every surface reports: three conditions,
   and the two that are not the clock are the duplicate the fence exists to
   prevent. */
test("an attempt is retirable on age only past its bound, unaccounted for, with no call out", () => {
  const spent = wake({ preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() });
  const interval = 20 * MINUTE;
  expect(seatTickFenceRetirableOnAge(spent, "uncertain", NOW, interval)).toBe(true);
  expect(seatTickFenceRetirableOnAge(spent, "unknown", NOW, interval)).toBe(true);
  expect(seatTickFenceRetirableOnAge(spent, "absent", NOW, interval)).toBe(true);
  expect(seatTickFenceRetirableOnAge(spent, "unreadable", NOW, interval)).toBe(true);
  expect(seatTickFenceRetirableOnAge(spent, null, NOW, interval)).toBe(true);

  /* A holder that still has the payload will deliver it; a settled one has been
     acted on already. Neither is a fence for an age bound to end. */
  for (const answer of ["retained", "landed", "dropped"]) {
    expect(seatTickFenceRetirableOnAge(spent, answer, NOW, interval)).toBe(false);
  }
  /* A transport call still out: retiring it puts a second wake beside a send
     that may be actuating. */
  expect(seatTickFenceRetirableOnAge({ ...spent, dispatch: { token: "t", state: "active" } }, "uncertain", NOW, interval)).toBe(false);
  /* And inside the bound nothing is retirable on age at all. */
  expect(seatTickFenceRetirableOnAge(wake(), "uncertain", NOW, 60 * MINUTE)).toBe(false);
});

/* What a surface that cannot ask the holders reports: the bounded fence, and
   otherwise the attempt the next check will run into, spent bound and all —
   because "no attempt is holding this project's wakes back" would be the mute
   tick told a new way while the row still carries one. */
test("the reported fence names an attempt past its bound while the row still carries it", () => {
  const spent = wake({ preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() });
  const interval = 20 * MINUTE;
  expect(seatTickWakeFence(row({ outstandingWake: spent }), { conversationId: SEAT }, NOW, interval)).toBeNull();
  const reported = seatTickReportedFence(row({ outstandingWake: spent }), { conversationId: SEAT }, NOW, interval)!;
  expect(reported).toMatchObject({ slot: "outstanding", clientMessageId: spent.clientMessageId, keptPastBound: true });

  /* Inside its bound the two readings are the same one. */
  const standing = row({ outstandingWake: wake() });
  expect(seatTickReportedFence(standing, { conversationId: SEAT }, NOW, 60 * MINUTE))
    .toEqual(seatTickWakeFence(standing, { conversationId: SEAT }, NOW, 60 * MINUTE));

  /* A retired attempt past its bound is nobody's fence: nothing will move it
     again, so there is nothing for a later check to run into. */
  const aged = retired({ wake: wake({ clientMessageId: "aged", preparedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() }), reason: "unresolved-age", supersededBy: null });
  expect(seatTickReportedFence(row({ retiredWakes: [aged] }), { conversationId: SEAT }, NOW, interval)).toBeNull();
});

/* A row with nothing prepared and nothing retired is quiet, and says so. */
test("an empty row has no fence", () => {
  expect(seatTickWakeFence(row(), { conversationId: SEAT }, NOW, 60 * MINUTE)).toBeNull();
});
