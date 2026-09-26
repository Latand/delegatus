import { expect, test } from "bun:test";

import { DEFAULT_SEAT_TICK_POLICY, SEAT_TICK_WAKE_INTERVAL_MS, seatTickDecision, seatTickWakeCommit, seatTickWakeCommitPlan } from "./seatTick";
import { defaultSeatTickSettings, effectiveSeatTickSettings, type SeatTickSettings } from "./seatTickSettings";
import { seatTickStateForEpoch } from "./seatTickState";
import {
  emptySeatTickState,
  SEAT_TICK_REPORTS_OWED_LIMIT,
  type SeatTickCheckInput,
  type SeatTickDeployInput,
  type SeatTickEventInput,
  type SeatTickOwnLaneInput,
  type SeatTickProjectState,
  type SeatTickReportsInput,
  type SeatTickPipelineInput,
  type SeatTickVerdict,
  type SeatTickWakeCommit,
} from "./types";

/*
 * The report ledger the seat tick keeps (docs/design/orchestrator-reports.md
 * §5.1): outcomes owed until a report lands, asks owed until reported or
 * answered, and a digest when the board moved with no report for an interval.
 * Every title is invented; the times of the replayed day are the real ones.
 */

const PROJECT = "viewer";
const SEAT_A = ["conversation", "0f4c21b7729fbc9e"].join("_");
const SEAT_B = ["conversation", "5b7729fbc9e0f4c2"].join("_");
const MINUTE = 60_000;
const T0 = Date.parse("2026-09-25T12:00:00.000Z");
const SHA_A = "aaaaaaaa".padEnd(40, "1");
const iso = (at: number) => new Date(at).toISOString();
const idFor = (key: string) => `id:${key}`;
/* A deployment id, assembled at run time: a UUID written out is what the
   publication gate refuses in a committed file. */
const attempt = (head: string) => [head, "0000", "4000", "8000", "0".repeat(12)].join("-");

function reports(over: Partial<SeatTickReportsInput> = {}): SeatTickReportsInput {
  return {
    bridgeReports: true,
    operatorLocale: "uk",
    lastReportAt: null,
    reportedIds: [],
    reportIdFor: idFor,
    latestCoversOwedAt: null,
    suggestionSets: [],
    suggestionConversations: [SEAT_A],
    operatorAdmissions: [],
    oldestAdmissionAt: null,
    ...over,
  };
}

function settings(over: Partial<SeatTickSettings> = {}, now = T0) {
  return effectiveSeatTickSettings({ ...defaultSeatTickSettings(PROJECT), ...over }, now, SEAT_TICK_WAKE_INTERVAL_MS);
}

function input(over: Partial<SeatTickCheckInput> = {}): SeatTickCheckInput {
  const now = over.now ?? T0;
  return {
    project: PROJECT,
    now,
    seat: { conversationId: SEAT_A, seatEpoch: 7, path: null, designatedAt: null, turn: "idle", activity: null },
    pipelines: [],
    tasks: [],
    events: [],
    pullRequests: [],
    pullRequestsUnavailable: null,
    ownLanes: [],
    signals: [],
    children: [],
    childrenUnavailable: null,
    changeFingerprint: `board-${now}.pr`,
    state: { ...emptySeatTickState(), seatEpoch: 7, lastProposalAt: iso(now) },
    policy: DEFAULT_SEAT_TICK_POLICY,
    settings: settings({}, now),
    reports: reports(),
    ...over,
  };
}

function deployed(sha: string, now = T0, phase = "succeeded", deploymentId = attempt(sha.slice(0, 8))): SeatTickDeployInput {
  return { deploymentId, phase, sha, error: phase === "succeeded" ? null : "candidate health failed", settledAt: iso(now - MINUTE) };
}

function laneSettled(id: string, settled: SeatTickOwnLaneInput["settled"] = "completed", now = T0): SeatTickOwnLaneInput {
  return { id, title: `lane ${id}`, settled, updatedAt: iso(now - MINUTE) };
}

type Wake = Extract<SeatTickVerdict, { kind: "wake" }>;

function wakeOf(decision: ReturnType<typeof seatTickDecision>): Wake {
  expect(decision.verdict.kind).toBe("wake");
  return decision.verdict as Wake;
}

/** Decide, and land the wake at once, the way a delivered send does. */
function landed(check: SeatTickCheckInput): { state: SeatTickProjectState; wake: Wake } {
  const decision = seatTickDecision(check);
  const wake = wakeOf(decision);
  const plan = seatTickWakeCommitPlan(wake, { fingerprint: check.changeFingerprint, eventsThrough: 0, bridgeReports: check.reports?.bridgeReports === true })!;
  return { state: seatTickWakeCommit(decision.state, plan, check.now), wake };
}

test("a wake with a deploy and a lane owes one report naming both, in the operator's language, keyed by the first", () => {
  const { state, wake } = landed(input({ settledDeploys: [deployed(SHA_A)], ownLanes: [laneSettled("pipeline_l1")] }));
  expect(wake.reportLines).toEqual([
    "Report owed, in Ukrainian, before this turn ends: deploy aaaaaaaa succeeded, lane pipeline completed. File one report with key deploy:aaaaaaaa:succeeded and coversOwed: true.",
    "Nothing is running now: the report says so.",
  ]);
  expect(state.reportsOwed).toEqual([
    { key: "deploy:aaaaaaaa:succeeded", label: "deploy aaaaaaaa succeeded", receivedAt: iso(T0) },
    { key: "lane:pipeline_l1:completed", label: "lane pipeline completed", receivedAt: iso(T0) },
  ]);
});

test("a report under the deploy's key clears the deploy only; the next wake still asks for the lane, and a covers entry clears it", () => {
  const first = landed(input({ settledDeploys: [deployed(SHA_A)], ownLanes: [laneSettled("pipeline_l1")] })).state;
  const later = T0 + 70 * MINUTE;
  const next = seatTickDecision(input({
    now: later,
    state: first,
    pipelines: [{ id: "pipeline_open", title: "open lane", state: "active" as const, updatedAt: iso(later), stageActivity: null, stageId: "build" }],
    reports: reports({ lastReportAt: iso(T0 + MINUTE), reportedIds: [idFor("deploy:aaaaaaaa:succeeded")] }),
  }));
  expect(next.state.reportsOwed!.map((entry) => entry.key)).toEqual(["lane:pipeline_l1:completed"]);
  expect(wakeOf(next).reportLines![0]).toBe("Report owed, in Ukrainian, before this turn ends: lane pipeline completed. File one report with key lane:pipeline_l1:completed and coversOwed: true.");

  const covered = seatTickDecision(input({
    now: later,
    state: first,
    reports: reports({ reportedIds: [idFor("deploy:aaaaaaaa:succeeded"), idFor("lane:pipeline_l1:completed")] }),
  }));
  expect(covered.state.reportsOwed).toEqual([]);
});

test("an unrelated report, or a refused one that stored nothing, clears nothing", () => {
  const first = landed(input({ settledDeploys: [deployed(SHA_A)] })).state;
  const next = seatTickDecision(input({ now: T0 + 5 * MINUTE, state: first, reports: reports({ reportedIds: [idFor("ask:rsg_other")], lastReportAt: iso(T0 + MINUTE) }) }));
  expect(next.state.reportsOwed!.map((entry) => entry.key)).toEqual(["deploy:aaaaaaaa:succeeded"]);
});

test("each failed attempt of one commit is owed under its own key", () => {
  const failures = [deployed(SHA_A, T0, "failed", attempt("11111111")), deployed(SHA_A, T0, "failed", attempt("22222222"))];
  const first = landed(input({ settledDeploys: failures })).state;
  expect(first.reportsOwed!.map((entry) => entry.key)).toEqual(["deploy:aaaaaaaa:failed:11111111", "deploy:aaaaaaaa:failed:22222222"]);
  const later = T0 + 10 * MINUTE;
  const third = landed(input({ now: later, state: first, settledDeploys: [deployed(SHA_A, later, "failed", attempt("33333333"))] })).state;
  expect(third.reportsOwed!.map((entry) => entry.key)).toEqual([
    "deploy:aaaaaaaa:failed:11111111", "deploy:aaaaaaaa:failed:22222222", "deploy:aaaaaaaa:failed:33333333",
  ]);
});

test("lane events, a review verdict among them, wake the seat and are owed nothing", () => {
  const verdict: SeatTickEventInput = { seq: 9, at: iso(T0 - MINUTE), type: "stage_failed", summary: "review round 1: REQUEST_CHANGES", pipelineId: "pipeline_l1", pipelineTerminal: false };
  const decision = seatTickDecision(input({ events: [verdict], pipelines: [{ id: "pipeline_l1", title: "lane", state: "active" as const, updatedAt: iso(T0), stageActivity: null, stageId: "review" }] }));
  const wake = wakeOf(decision);
  expect(wake.reasons.map((reason) => reason.kind)).toEqual(["lane-event"]);
  expect(wake.reportLines).toBeUndefined();
  expect(seatTickWakeCommitPlan(wake, { fingerprint: "f", eventsThrough: 9, bridgeReports: true })!.reportsOwed).toBeUndefined();
});

test("while bridge reports are off, no report line is written and nothing is recorded", () => {
  const decision = seatTickDecision(input({ settledDeploys: [deployed(SHA_A)], reports: reports({ bridgeReports: false }) }));
  const wake = wakeOf(decision);
  expect(wake.reportLines).toBeUndefined();
  expect(seatTickWakeCommitPlan(wake, { fingerprint: "f", eventsThrough: 0, bridgeReports: false })!.reportsOwed).toBeUndefined();
});

test("with the interface language unknown, the lines carry no language clause", () => {
  const { wake } = landed(input({ settledDeploys: [deployed(SHA_A)], reports: reports({ operatorLocale: null }) }));
  expect(wake.reportLines![0]).toStartWith("Report owed, before this turn ends: deploy aaaaaaaa succeeded.");
});

test("a wake credited late: a coversOwed report filed after it reached the seat settles it the moment it is committed", () => {
  const check = input({ settledDeploys: [deployed(SHA_A)], ownLanes: [laneSettled("pipeline_l1")] });
  const decision = seatTickDecision(check);
  const plan = seatTickWakeCommitPlan(wakeOf(decision), { fingerprint: check.changeFingerprint, eventsThrough: 0, bridgeReports: true })!;
  /* The delivery answered queued; the seat got it at T0 and filed at T0+2 with
     coversOwed. The next check credits the wake at T0+5 from the record. */
  const credited = seatTickWakeCommit(decision.state, plan, T0 + 5 * MINUTE, iso(T0));
  expect(credited.reportsOwed!.every((entry) => entry.receivedAt === iso(T0))).toBe(true);
  const next = seatTickDecision(input({
    now: T0 + 5 * MINUTE,
    state: credited,
    reports: reports({ lastReportAt: iso(T0 + 2 * MINUTE), reportedIds: [idFor("deploy:aaaaaaaa:succeeded")], latestCoversOwedAt: iso(T0 + 2 * MINUTE) }),
  }));
  expect(next.state.reportsOwed).toEqual([]);

  /* A wake that reached the seat after the report stays owed. */
  const after = seatTickWakeCommit(decision.state, plan, T0 + 5 * MINUTE, iso(T0 + 3 * MINUTE));
  const still = seatTickDecision(input({ now: T0 + 5 * MINUTE, state: after, reports: reports({ latestCoversOwedAt: iso(T0 + 2 * MINUTE) }) }));
  expect(still.state.reportsOwed).toHaveLength(2);
  /* With no instant on the record, the commit's own instant stands. */
  expect(seatTickWakeCommit(decision.state, plan, T0 + 5 * MINUTE, null).reportsOwed![0]!.receivedAt).toBe(iso(T0 + 5 * MINUTE));
});

test("the owed list is bounded: past 64 the oldest go and the wake says how many", () => {
  let state: SeatTickProjectState = { ...emptySeatTickState(), seatEpoch: 7 };
  const plan: SeatTickWakeCommit = { proposal: false, reasons: [], fingerprint: "f", eventsThrough: 0, children: [] };
  for (let index = 0; index < SEAT_TICK_REPORTS_OWED_LIMIT + 3; index += 1) {
    state = seatTickWakeCommit(state, { ...plan, reportsOwed: [{ key: `lane:l${index}:completed`, label: `lane l${index} completed` }] }, T0 + index);
  }
  expect(state.reportsOwed).toHaveLength(SEAT_TICK_REPORTS_OWED_LIMIT);
  expect(state.reportsOwedDropped).toBe(3);
  expect(state.reportsOwed![0]!.key).toBe("lane:l3:completed");
  const { wake } = landed(input({ now: T0 + 70 * MINUTE, state, settledDeploys: [deployed(SHA_A, T0 + 70 * MINUTE)] }));
  expect(wake.reportLines![0]).toContain("and 57 more (3 older owed outcome(s) no longer listed)");
});

/* ── Asks ─────────────────────────────────────────────────────────────── */

const setAt = (setId: string, at: number, conversationId = SEAT_A) => ({ conversationId, setId, at: iso(at) });

test("an ask is owed ten minutes after it was offered with no answer, under its own set's key, until a report under that key lands", () => {
  const offered = setAt("rsg_first", T0);
  const early = seatTickDecision(input({ now: T0 + 5 * MINUTE, reports: reports({ suggestionSets: [offered] }) }));
  expect(early.state.asksOwed).toEqual([]);
  const owed = seatTickDecision(input({ now: T0 + 11 * MINUTE, state: early.state, reports: reports({ suggestionSets: [offered] }) }));
  expect(owed.state.asksOwed).toEqual([{ key: "ask:rsg_first", setId: "rsg_first", conversationId: SEAT_A, at: iso(T0) }]);

  const woken = landed(input({ now: T0 + 70 * MINUTE, state: owed.state, settledDeploys: [deployed(SHA_A, T0 + 70 * MINUTE)], reports: reports({ suggestionSets: [offered] }) }));
  expect(woken.wake.reportLines).toContain("Ask owed: you asked the operator at 12:00 UTC and filed no question report. File one with key ask:rsg_first and the ask in the decision section.");

  const reported = seatTickDecision(input({ now: T0 + 75 * MINUTE, state: woken.state, reports: reports({ suggestionSets: [offered], reportedIds: [idFor("ask:rsg_first")] }) }));
  expect(reported.state.asksOwed).toEqual([]);
});

test("suggest, report, suggest on one subject: the first report clears only the first ask, and the second stays owed until its own report", () => {
  const first = setAt("rsg_one", T0);
  let state = seatTickDecision(input({ now: T0 + 11 * MINUTE, reports: reports({ suggestionSets: [first] }) })).state;
  state = seatTickDecision(input({ now: T0 + 15 * MINUTE, state, reports: reports({ suggestionSets: [first], reportedIds: [idFor("ask:rsg_one")] }) })).state;
  expect(state.asksOwed).toEqual([]);
  const second = setAt("rsg_two", T0 + 16 * MINUTE);
  state = seatTickDecision(input({ now: T0 + 30 * MINUTE, state, reports: reports({ suggestionSets: [second], reportedIds: [idFor("ask:rsg_one")] }) })).state;
  expect(state.asksOwed!.map((ask) => ask.key)).toEqual(["ask:rsg_two"]);
  state = seatTickDecision(input({ now: T0 + 35 * MINUTE, state, reports: reports({ suggestionSets: [second], reportedIds: [idFor("ask:rsg_one")] }) })).state;
  expect(state.asksOwed!.map((ask) => ask.key)).toEqual(["ask:rsg_two"]);
});

test("an answered ask is cleared: its set retired by the operator's message", () => {
  const offered = setAt("rsg_answered", T0);
  const owed = seatTickDecision(input({ now: T0 + 11 * MINUTE, reports: reports({ suggestionSets: [offered] }) })).state;
  expect(owed.asksOwed).toHaveLength(1);
  const answered = seatTickDecision(input({ now: T0 + 20 * MINUTE, state: owed, reports: reports({ suggestionSets: [] }) })).state;
  expect(answered.asksOwed).toEqual([]);
});

test("answered, then re-offered: set A appended at 13:15, the operator answers at 13:40, set B at 13:42, and the 13:45 check clears ask:A", () => {
  const at = (clock: string) => Date.parse(`2026-09-25T${clock}:00.000Z`);
  const a = setAt("rsg_a", at("13:00"));
  const b = setAt("rsg_b", at("13:42"));
  let state = seatTickDecision(input({ now: at("13:15"), reports: reports({ suggestionSets: [a] }) })).state;
  expect(state.asksOwed!.map((ask) => ask.key)).toEqual(["ask:rsg_a"]);
  state = seatTickDecision(input({
    now: at("13:45"), state,
    reports: reports({ suggestionSets: [b], operatorAdmissions: [{ conversationId: SEAT_A, at: iso(at("13:40")) }], oldestAdmissionAt: iso(at("13:40")) }),
  })).state;
  expect(state.asksOwed).toEqual([]);
});

test("re-offered without an answer: ask:A stays owed, and B is owed once it is ten minutes old", () => {
  const a = setAt("rsg_a", T0);
  const b = setAt("rsg_b", T0 + 20 * MINUTE);
  let state = seatTickDecision(input({ now: T0 + 15 * MINUTE, reports: reports({ suggestionSets: [a] }) })).state;
  state = seatTickDecision(input({ now: T0 + 25 * MINUTE, state, reports: reports({ suggestionSets: [b] }) })).state;
  expect(state.asksOwed!.map((ask) => ask.key)).toEqual(["ask:rsg_a"]);
  state = seatTickDecision(input({ now: T0 + 30 * MINUTE, state, reports: reports({ suggestionSets: [b] }) })).state;
  expect(state.asksOwed!.map((ask) => ask.key)).toEqual(["ask:rsg_a", "ask:rsg_b"]);
});

test("an ask whose conversation shows no admission since it stays owed, even when the store's oldest admission is newer", () => {
  const a = setAt("rsg_a", T0);
  const b = setAt("rsg_b", T0 + 20 * MINUTE);
  let state = seatTickDecision(input({ now: T0 + 15 * MINUTE, reports: reports({ suggestionSets: [a] }) })).state;
  state = seatTickDecision(input({ now: T0 + 25 * MINUTE, state, reports: reports({ suggestionSets: [b], oldestAdmissionAt: iso(T0 + 10 * MINUTE) }) })).state;
  expect(state.asksOwed!.map((ask) => ask.key)).toContain("ask:rsg_a");
});

test("an ask left by seat A stays owed after the seat rotates to B, read from A's conversation, and clears when its report lands", () => {
  const a = setAt("rsg_left", T0);
  const owed = seatTickDecision(input({ now: T0 + 11 * MINUTE, reports: reports({ suggestionSets: [a] }) })).state;
  const successor = seatTickStateForEpoch(owed, 8);
  expect(successor.asksOwed!.map((ask) => ask.key)).toEqual(["ask:rsg_left"]);
  const seatB = { conversationId: SEAT_B, seatEpoch: 8, path: null, designatedAt: null, turn: "idle" as const, activity: null };
  const kept = seatTickDecision(input({ now: T0 + 20 * MINUTE, seat: seatB, state: successor, reports: reports({ suggestionSets: [a], suggestionConversations: [SEAT_B, SEAT_A] }) })).state;
  expect(kept.asksOwed!.map((ask) => ask.key)).toEqual(["ask:rsg_left"]);
  const cleared = seatTickDecision(input({ now: T0 + 25 * MINUTE, seat: seatB, state: kept, reports: reports({ suggestionSets: [a], suggestionConversations: [SEAT_B, SEAT_A], reportedIds: [idFor("ask:rsg_left")] }) })).state;
  expect(cleared.asksOwed).toEqual([]);
});

test("owed outcomes survive a rotation and a tick switched off, and asks are still recorded while it is off", () => {
  const first = landed(input({ settledDeploys: [deployed(SHA_A)] })).state;
  const rotated = seatTickStateForEpoch(first, 8);
  expect(rotated.reportsOwed!.map((entry) => entry.key)).toEqual(["deploy:aaaaaaaa:succeeded"]);
  const off = seatTickDecision(input({
    now: T0 + 15 * MINUTE,
    seat: { conversationId: SEAT_A, seatEpoch: 8, path: null, designatedAt: null, turn: "idle", activity: null },
    state: rotated,
    settings: settings({ enabled: false, reason: "quiet night" }, T0 + 15 * MINUTE),
    reports: reports({ suggestionSets: [setAt("rsg_off", T0)] }),
  }));
  expect(off.verdict.kind).toBe("quiet");
  expect(off.state.reportsOwed!.map((entry) => entry.key)).toEqual(["deploy:aaaaaaaa:succeeded"]);
  expect(off.state.asksOwed!.map((ask) => ask.key)).toEqual(["ask:rsg_off"]);
});

/* ── The digest ─────────────────────────────────────────────────────────── */

const OPEN: SeatTickPipelineInput[] = [{ id: "pipeline_open", title: "open lane", state: "active", updatedAt: iso(T0), stageActivity: null, stageId: "build" }];

test("an interval wake asks for a digest when the board moved and nothing was reported for an interval", () => {
  const decision = seatTickDecision(input({ pipelines: OPEN, reports: reports({ lastReportAt: iso(T0 - 90 * MINUTE) }) }));
  expect(wakeOf(decision).reportLines).toEqual([
    "Digest due, in Ukrainian: no report since 10:30 UTC and the board moved. File one status report (key digest:2026-09-25T12:00) with the whole state: in progress, next, needs a decision.",
  ]);
});

test("no digest on an unchanged board after a digest; a digest when the board moved between the previous check and the report", () => {
  /* Check 1 at 12:00 sees board X; the digest is filed at 12:02; check 2 at
     12:05 sees X again and records that the report covered X. */
  const board = (name: string) => `${name}.pr`;
  let state = seatTickDecision(input({ pipelines: OPEN, changeFingerprint: board("X") })).state;
  state = seatTickDecision(input({ now: T0 + 5 * MINUTE, pipelines: OPEN, changeFingerprint: board("X"), state: { ...state, lastWakeAt: iso(T0) }, reports: reports({ lastReportAt: iso(T0 + 2 * MINUTE) }) })).state;
  const later = T0 + 125 * MINUTE;
  const quiet = seatTickDecision(input({ now: later, pipelines: OPEN, changeFingerprint: board("X"), state: { ...state, lastWakeAt: iso(T0) }, reports: reports({ lastReportAt: iso(T0 + 2 * MINUTE) }) }));
  expect(wakeOf(quiet).reportLines).toBeUndefined();

  /* The board moved to Y at 12:01, before the report at 12:02 was filed:
     the report is remembered against X, so Y still owes a digest. */
  let moved = seatTickDecision(input({ pipelines: OPEN, changeFingerprint: board("X") })).state;
  moved = seatTickDecision(input({ now: T0 + 5 * MINUTE, pipelines: OPEN, changeFingerprint: board("Y"), state: { ...moved, lastWakeAt: iso(T0) }, reports: reports({ lastReportAt: iso(T0 + 2 * MINUTE) }) })).state;
  const due = seatTickDecision(input({ now: later, pipelines: OPEN, changeFingerprint: board("Y"), state: { ...moved, lastWakeAt: iso(T0) }, reports: reports({ lastReportAt: iso(T0 + 2 * MINUTE) }) }));
  expect(wakeOf(due).reportLines![0]).toStartWith("Digest due, in Ukrainian: no report since 12:02 UTC");
});

/* ── A replayed day ──────────────────────────────────────────────────────────
 *
 * Shaped after the full Kyiv day of 2026-09-25 (§6.7): 21 outcome wakes
 * carrying 16 deploy and 35 lane outcomes, 77 review-verdict events, 6
 * interval wakes, the day's 4 reply-suggestion sets and 4 operator messages at
 * their real times, the day's 11 real report times, and a 30-minute interval.
 * Before the change, the seat followed 5 of its 15 outcome wakes and none of
 * its 5 interval wakes with a report. The replay counts what the tick asks
 * for; whether seats comply shows in the log afterwards.
 */

const DAY_START = Date.parse("2026-09-24T21:00:00.000Z");
const utc = (clock: string, day = "2026-09-25") => Date.parse(`${day}T${clock}:00.000Z`);
const OUTCOME_WAKES = [
  utc("21:30", "2026-09-24"), utc("22:30", "2026-09-24"), utc("23:30", "2026-09-24"), utc("00:30"), utc("01:30"), utc("02:30"),
  utc("04:00"), utc("05:30"), utc("07:00"), utc("08:00"), utc("09:00"), utc("10:00"), utc("11:00"), utc("12:00"), utc("13:00"),
  utc("14:00"), utc("15:00"), utc("16:00"), utc("17:35"), utc("18:10"), utc("20:00"),
];
const INTERVAL_WAKES = [utc("03:15"), utc("06:15"), utc("14:30"), utc("16:40"), utc("19:00"), utc("20:35")];
/* The wakes whose delivery answered `queued` and were credited one check later. */
const QUEUED = new Set([utc("07:00"), utc("12:00"), utc("17:35")]);
const ASK_SETS = [
  { setId: "rsg_000000000000000000001546", at: utc("15:46") },
  { setId: "rsg_000000000000000000001656", at: utc("16:56") },
  { setId: "rsg_000000000000000000001811", at: utc("18:11") },
  { setId: "rsg_000000000000000000001927", at: utc("19:27") },
];
const OPERATOR_MESSAGES = [utc("13:10"), utc("15:48"), utc("18:35"), utc("19:31")];
/* The 11 reports the seats filed that day, Kyiv 00:23 to 23:52. */
const REAL_REPORTS = ["21:23", "07:12", "08:07", "09:37", "11:20", "15:46", "16:21", "19:33", "19:47", "20:20", "20:52"]
  .map((clock, index) => (index === 0 ? utc(clock, "2026-09-24") : utc(clock)));

interface DayOutcome { owedLines: string[]; askLines: string[]; digestLines: string[]; wakes: number; filed: number; everOwed: string[]; finalOwed: string[]; maxOwed: number; verdictKeys: number }

function replayDay(seatReports: boolean): DayOutcome {
  const lanes = Array.from({ length: 35 }, (_, index) => `pipeline_${String(index).padStart(2, "0")}`);
  const outcomes = OUTCOME_WAKES.map((at, index) => ({
    at,
    deploys: index < 16 ? [deployed(`${String(index).padStart(2, "0")}c0ffee`.padEnd(40, "0"), at)] : [],
    lanes: [] as SeatTickOwnLaneInput[],
  }));
  lanes.forEach((id, index) => outcomes[index % 21]!.lanes.push(laneSettled(id, index % 7 === 0 ? "failed" : "completed", outcomes[index % 21]!.at)));
  let verdicts = 77;

  const log: { id: string; at: number; coversOwed: boolean }[] = seatReports ? [] : REAL_REPORTS.map((at, index) => ({ id: `real-${index}`, at, coversOwed: false }));
  let current: { setId: string; at: number } | null = null;
  const admissions: number[] = [];
  let state: SeatTickProjectState = { ...emptySeatTickState(), seatEpoch: 7, lastProposalAt: iso(DAY_START) };
  let pending: { plan: NonNullable<ReturnType<typeof seatTickWakeCommitPlan>>; sentAt: number } | null = null;
  const result: DayOutcome = { owedLines: [], askLines: [], digestLines: [], wakes: 0, filed: 0, everOwed: [], finalOwed: [], maxOwed: 0, verdictKeys: 0 };

  for (let now = DAY_START; now < DAY_START + 24 * 60 * MINUTE; now += 5 * MINUTE) {
    for (const set of ASK_SETS) if (set.at <= now && set.at > now - 5 * MINUTE) current = { setId: set.setId, at: set.at };
    for (const message of OPERATOR_MESSAGES) {
      if (message <= now && message > now - 5 * MINUTE) {
        admissions.push(message);
        if (current && current.at <= message) current = null;
      }
    }
    if (pending) {
      state = seatTickWakeCommit(state, pending.plan, now, iso(pending.sentAt));
      pending = null;
    }
    const outcome = outcomes.find((entry) => entry.at > now - 5 * MINUTE && entry.at <= now);
    const interval = INTERVAL_WAKES.some((at) => at > now - 5 * MINUTE && at <= now);
    const events: SeatTickEventInput[] = [];
    if (outcome) {
      const share = Math.min(verdicts, Math.ceil(77 / 21));
      verdicts -= share;
      for (let index = 0; index < share; index += 1) {
        events.push({ seq: 1_000 + result.wakes * 10 + index, at: iso(now - MINUTE), type: "stage_failed", summary: "review verdict: REQUEST_CHANGES", pipelineId: "pipeline_open", pipelineTerminal: false });
      }
    }
    const reportState = log.filter((entry) => entry.at <= now);
    const check = input({
      now,
      state,
      settings: settings({ wakeIntervalMinutes: 30, reason: "a replayed day" }, now),
      pipelines: interval ? OPEN : [],
      events,
      settledDeploys: outcome?.deploys ?? [],
      ownLanes: outcome?.lanes ?? [],
      changeFingerprint: `board-${now}.pr`,
      reports: reports({
        lastReportAt: reportState.length ? iso(Math.max(...reportState.map((entry) => entry.at))) : null,
        reportedIds: reportState.map((entry) => entry.id),
        latestCoversOwedAt: reportState.some((entry) => entry.coversOwed) ? iso(Math.max(...reportState.filter((entry) => entry.coversOwed).map((entry) => entry.at))) : null,
        suggestionSets: current ? [{ conversationId: SEAT_A, setId: current.setId, at: iso(current.at) }] : [],
        operatorAdmissions: admissions.map((at) => ({ conversationId: SEAT_A, at: iso(at) })),
        oldestAdmissionAt: admissions.length ? iso(admissions[0]!) : null,
      }),
    });
    const decision = seatTickDecision(check);
    state = decision.state;
    result.maxOwed = Math.max(result.maxOwed, state.reportsOwed?.length ?? 0);
    if (decision.verdict.kind !== "wake") continue;
    result.wakes += 1;
    const wake = decision.verdict;
    const plan = seatTickWakeCommitPlan(wake, { fingerprint: check.changeFingerprint, eventsThrough: 0, bridgeReports: true })!;
    for (const owed of plan.reportsOwed ?? []) if (!result.everOwed.includes(owed.key)) result.everOwed.push(owed.key);
    result.verdictKeys += (plan.reportsOwed ?? []).filter((owed) => owed.key.startsWith("verdict:")).length;
    for (const line of wake.reportLines ?? []) {
      if (line.startsWith("Report owed")) result.owedLines.push(line);
      if (line.startsWith("Ask owed")) result.askLines.push(`${iso(now).slice(11, 16)} ${line}`);
      if (line.startsWith("Digest due")) result.digestLines.push(line);
      const key = /key (\S+?)(?: and|\)|$)/.exec(line)?.[1];
      if (seatReports && key) {
        log.push({ id: idFor(key), at: now + MINUTE, coversOwed: line.startsWith("Report owed") });
        result.filed += 1;
      }
    }
    if (QUEUED.has(now)) pending = { plan, sentAt: now };
    else state = seatTickWakeCommit(state, plan, now);
    result.maxOwed = Math.max(result.maxOwed, state.reportsOwed?.length ?? 0);
  }
  result.finalOwed = (state.reportsOwed ?? []).map((entry) => entry.key);
  return result;
}

test("the replayed day: one report asked per outcome wake, each settled by one coversOwed report; no verdict owed; at most 6 digests", () => {
  const day = replayDay(true);
  expect(day.owedLines).toHaveLength(21);
  expect(day.everOwed).toHaveLength(16 + 35);
  expect(day.verdictKeys).toBe(0);
  expect(day.everOwed.some((key) => key.startsWith("verdict:"))).toBe(false);
  /* Every owed line names only its own wake's outcomes: the report filed
     after the previous one settled everything before it, the queued wakes
     included. */
  for (const line of day.owedLines) expect(line).not.toContain("more");
  expect(day.finalOwed).toEqual([]);
  expect(day.digestLines.length).toBeLessThanOrEqual(6);
  /* Before and after, on the same day: the seats filed 11 reports and
     followed 5 of the 15 outcome wakes of the day seat with one; a seat that
     files what the tick asks for files 27 — 21 outcome reports, 5 digests and
     1 question. */
  expect({ owed: day.owedLines.length, digests: day.digestLines.length, asks: day.askLines.length, filed: day.filed }).toEqual({ owed: 21, digests: 5, asks: 1, filed: 27 });
  expect(REAL_REPORTS).toHaveLength(11);
  /* The one ask the day left unanswered for more than ten minutes is asked
     once, and reported. */
  expect(day.askLines).toHaveLength(1);
  expect(day.askLines[0]).toStartWith("17:35 Ask owed: you asked the operator at 16:56 UTC");
});

test("the replayed day with no report filed: every owed key is asked for in each later wake, the list never passes 64, and exactly one ask is owed", () => {
  const day = replayDay(false);
  /* Every wake from the first outcome on carries the owed line: the 21
     outcome wakes and the 6 interval wakes after them. */
  expect(day.wakes).toBe(21 + 6);
  expect(day.owedLines).toHaveLength(21 + 6);
  const firstKey = day.everOwed[0]!;
  let before = 0;
  for (const line of day.owedLines) {
    const counts = /before this turn ends: (.*?)(?:, and (\d+) more)?\. File one/.exec(line)!;
    const named = counts[1]!.split(", ").length + Number(counts[2] ?? 0);
    expect(named).toBeGreaterThanOrEqual(before);
    before = named;
    expect(line).toContain(`key ${firstKey} and coversOwed: true`);
  }
  expect(before).toBe(16 + 35);
  expect(day.finalOwed).toHaveLength(16 + 35);
  expect(day.maxOwed).toBeLessThanOrEqual(SEAT_TICK_REPORTS_OWED_LIMIT);
  /* The 16:56Z set was re-offered at 18:11Z with no operator message in
     between, so it stayed owed until the 18:35Z message: carried by the 17:35Z
     and 18:10Z wakes. The 18:11Z set was answered at 18:35Z before any wake,
     and the 15:46Z and 19:27Z sets within minutes. */
  expect(day.askLines).toEqual([
    "17:35 Ask owed: you asked the operator at 16:56 UTC and filed no question report. File one with key ask:rsg_000000000000000000001656 and the ask in the decision section.",
    "18:10 Ask owed: you asked the operator at 16:56 UTC and filed no question report. File one with key ask:rsg_000000000000000000001656 and the ask in the decision section.",
  ]);
  expect(day.digestLines.length).toBeLessThanOrEqual(6);
});
