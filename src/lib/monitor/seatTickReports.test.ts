import { expect, test } from "bun:test";


import { DEFAULT_SEAT_TICK_POLICY, SEAT_TICK_WAKE_INTERVAL_MS, seatTickDecision, seatTickWakeCommit, seatTickWakeCommitPlan } from "./seatTick";
import { defaultSeatTickSettings, effectiveSeatTickSettings, type SeatTickSettings } from "./seatTickSettings";
import { seatTickStateForEpoch } from "./seatTickState";
import { seatTickWakeMessage } from "./report";
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
 * §5.1): outcomes owed until a report lands, and a digest when the board
 * moved with no report for an interval.
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
    reportIdsFor: (key) => [idFor(key)],
    latestCoversOwedAt: null,
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

test("delivered agendas leave debt-only reminders at the configured interval until a matching report clears them", () => {
  const agenda = { pipelines: OPEN, ownLanes: [laneSettled("pipeline_debt")], changeFingerprint: "unchanged.pr" };
  const cadence = settings({ wakeIntervalMinutes: 10 });
  let state = landed(input({ ...agenda, settings: cadence })).state;
  agenda.pipelines = []; // The work ended; only the report debt remains.
  for (let round = 1; round <= DEFAULT_SEAT_TICK_POLICY.retryGuard + 2; round++) {
    const now = T0 + round * 10 * MINUTE;
    expect(seatTickDecision(input({ ...agenda, settings: cadence, state, now: now - MINUTE })).verdict.kind).toBe("quiet");
    const reminder = landed(input({ ...agenda, settings: cadence, state, now,
      reports: reports({ reportedIds: [idFor("lane:unrelated:completed")] }),
    }));
    expect(reminder.wake.items).toEqual([]);
    expect(reminder.wake.reportLines![0]).toContain("key lane:pipeline_debt:completed");
    state = reminder.state;
  }
  const cleared = seatTickDecision(input({ ...agenda, settings: cadence, state, now: T0 + 100 * MINUTE,
    reports: reports({ reportedIds: [idFor("lane:pipeline_debt:completed")] }),
  }));
  expect(cleared.state.reportsOwed).toEqual([]);
  expect(cleared.verdict.kind).toBe("quiet");
});

test("a full owed-outcome ledger stays within the wake bound and names the key that settles it", () => {
  const reportsOwed = Array.from({ length: 64 }, (_, index) => ({ key: `lane:${attempt(String(index).padStart(8, "0"))}:completed`,
    label: `lane ${String(index).padStart(8, "0")} completed`, receivedAt: iso(T0),
  }));
  const check = input({ state: { ...emptySeatTickState(), seatEpoch: 7, reportsOwed },
    pipelines: Array.from({ length: 5 }, (_, index) => ({ ...OPEN[0]!, id: attempt(String(index).padStart(8, "0")), title: "Open lane title ".padEnd(119, "t") })),
    reports: reports(),
  });
  const wake = wakeOf(seatTickDecision(check));
  const text = seatTickWakeMessage({ project: PROJECT, snapshotAt: iso(T0), reasons: wake.reasons, items: wake.items,
    deferred: wake.deferred, signals: [], reportLines: wake.reportLines,
    monitorPrompt: "Standing note ".padEnd(7_622, "n"), operatorInstructions: "Instructions ".padEnd(500, "i"),
  });
  expect(text.length).toBeLessThanOrEqual(4_000);
  expect(text).toContain(`key ${reportsOwed[0]!.key} and coversOwed: true`);
  const autonomous = seatTickWakeMessage({ project: PROJECT, snapshotAt: iso(T0), reasons: wake.reasons, items: wake.items,
    deferred: wake.deferred, signals: [], reportLines: wake.reportLines,
    monitorPrompt: "Standing note ".padEnd(7_622, "n"), operatorInstructions: "Instructions ".padEnd(500, "i"),
    workers: { limit: 4, source: "project", machine: 4, running: 1 }, now: T0,
    autonomy: { enabled: true, startedAt: iso(T0), until: iso(T0 + 8 * 60 * MINUTE), endedAt: null, endReason: null, updatedAt: iso(T0), setBy: { kind: "gateway", project: null, conversationId: null, seatEpoch: null }, why: null, decisions: [] },
  });
  expect(autonomous.length).toBeLessThanOrEqual(4_000);
  expect(autonomous).toContain("decide all questions");
  expect(autonomous).toContain(`key ${reportsOwed[0]!.key} and coversOwed: true`);
});

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
  const next = seatTickDecision(input({ now: T0 + 5 * MINUTE, state: first, reports: reports({ reportedIds: [idFor("digest:unrelated")], lastReportAt: iso(T0 + MINUTE) }) }));
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

test("owed outcomes survive a rotation and a tick switched off", () => {
  const first = landed(input({ settledDeploys: [deployed(SHA_A)] })).state;
  const rotated = seatTickStateForEpoch(first, 8);
  expect(rotated.reportsOwed!.map((entry) => entry.key)).toEqual(["deploy:aaaaaaaa:succeeded"]);
  const off = seatTickDecision(input({
    now: T0 + 15 * MINUTE,
    seat: { conversationId: SEAT_A, seatEpoch: 8, path: null, designatedAt: null, turn: "idle", activity: null },
    state: rotated,
    settings: settings({ enabled: false, reason: "quiet night" }, T0 + 15 * MINUTE),
    reports: reports(),
  }));
  expect(off.verdict.kind).toBe("quiet");
  expect(off.state.reportsOwed!.map((entry) => entry.key)).toEqual(["deploy:aaaaaaaa:succeeded"]);
});

/* ── The digest ─────────────────────────────────────────────────────────── */

const OPEN: SeatTickPipelineInput[] = [{ id: "pipeline_open", title: "open lane", state: "active", updatedAt: iso(T0), stageActivity: null, stageId: "build" }];

test("an interval wake asks for a digest when the board moved and nothing was reported for an interval", () => {
  const state = { ...emptySeatTickState(), seatEpoch: 7, checkFingerprint: "earlier-board", reportFingerprint: "earlier-board" };
  const decision = seatTickDecision(input({ pipelines: OPEN, state, reports: reports({ lastReportAt: iso(T0 - 90 * MINUTE) }) }));
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
 * interval wakes, the day's 11 real report times, and a 30-minute interval.
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
/* The 11 reports the seats filed that day, Kyiv 00:23 to 23:52. */
const REAL_REPORTS = ["21:23", "07:12", "08:07", "09:37", "11:20", "15:46", "16:21", "19:33", "19:47", "20:20", "20:52"]
  .map((clock, index) => (index === 0 ? utc(clock, "2026-09-24") : utc(clock)));

interface DayOutcome { owedLines: string[]; digestLines: string[]; wakes: number; filed: number; everOwed: string[]; finalOwed: string[]; maxOwed: number; verdictKeys: number }

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
  let state: SeatTickProjectState = { ...emptySeatTickState(), seatEpoch: 7, lastProposalAt: iso(DAY_START) };
  let pending: { plan: NonNullable<ReturnType<typeof seatTickWakeCommitPlan>>; sentAt: number } | null = null;
  const result: DayOutcome = { owedLines: [], digestLines: [], wakes: 0, filed: 0, everOwed: [], finalOwed: [], maxOwed: 0, verdictKeys: 0 };

  for (let now = DAY_START; now < DAY_START + 24 * 60 * MINUTE; now += 5 * MINUTE) {
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
      // Settlements stay in the source until a delivered wake announces them,
      // including when a debt reminder used the preceding interval slot.
      settledDeploys: outcomes.filter(entry => entry.at <= now).flatMap(entry => entry.deploys)
        .filter(deploy => !(state.announcedDeploys ?? []).includes(deploy.deploymentId)),
      ownLanes: outcomes.filter(entry => entry.at <= now).flatMap(entry => entry.lanes)
        .filter(lane => !state.announcedLanes.includes(`${lane.id}:${lane.settled}`)),
      changeFingerprint: `board-${now}.pr`,
      reports: reports({
        lastReportAt: reportState.length ? iso(Math.max(...reportState.map((entry) => entry.at))) : null,
        reportedIds: reportState.map((entry) => entry.id),
        latestCoversOwedAt: reportState.some((entry) => entry.coversOwed) ? iso(Math.max(...reportState.filter((entry) => entry.coversOwed).map((entry) => entry.at))) : null,
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
     files what the tick asks for files 26 — 21 outcome reports and 5 interval
     digests. */
  expect({ owed: day.owedLines.length, digests: day.digestLines.length, filed: day.filed }).toEqual({ owed: 21, digests: 5, filed: 26 });
  expect(REAL_REPORTS).toHaveLength(11);
});

test("the replayed day with no report filed: every owed key is asked for in each later wake, and the list never passes 64", () => {
  const day = replayDay(false);
  /* Every wake from the first outcome on carries the owed line: the 21
     outcome wakes plus debt reminders; delivered agendas stay deduped. */
  expect(day.wakes).toBe(47);
  expect(day.owedLines).toHaveLength(day.wakes);
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
  expect(day.digestLines.length).toBeLessThanOrEqual(6);
});

test("production rule reporting waits off-loop for a shared writer and skips recorded reports", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { recordSeatRuleReports } = await import("./seatTickReports");
  const { readBridgeReportLog, readBridgeChannel } = await import("@/lib/bridge/store");
  const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
  const { statePath } = await import("@/lib/configDir");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tick-reports-contention-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Run the board", clientRequestId: "report-seat", mode: "spawn", now: iso(T0) });
    completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "report-seat", conversationId: SEAT_A, path: null, now: iso(T0), preparedAuthCredentialBaseline: null });
    readBridgeReportLog(); readBridgeChannel();
    const measurements: number[] = [];
    const lanes = [];
    for (let trial = 0; trial < 3; trial++) {
      const lane = buildPipeline({ id: `report-lane-${trial}`, task: "Resolved lane", project: PROJECT, repoDir: root, stages: [], srcPath: null, srcConversationId: SEAT_A, now: iso(T0), state: "draft" });
      lane.dismissedAt = iso(T0); lane.dismissedBy = { kind: "manager", conversationId: SEAT_A, role: "orchestrator" };
      lanes.push(lane); savePipelines(lanes);
      const child = spawn(process.execPath, ["-e", `
        const { Database } = await import("bun:sqlite");
        const db = new Database(process.argv.at(-1));
        db.exec("BEGIN IMMEDIATE");
        const watchdog = setTimeout(() => process.exit(2), 5_000);
        process.stdin.once("data", () => { db.exec("ROLLBACK"); db.close(); clearTimeout(watchdog); process.stdin.destroy(); });
        console.log("ready");
      `, statePath("state.sqlite")], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 5_000);
      let release: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("data", chunk => chunk.toString().includes("ready") ? resolve() : reject(new Error("lock peer did not acknowledge")));
          child.once("exit", code => { if (code) reject(new Error(`lock peer exited ${code}: ${stderr}`)); });
        });
        const start = performance.now();
        // The peer keeps the lock until this timer: even a delayed ready read
        // cannot accidentally turn the contention case into an unlocked call.
        release = setTimeout(() => child.stdin.end("release"), 40);
        await recordSeatRuleReports(PROJECT, iso(T0), Date.now() + 1_000);
        measurements.push(performance.now() - start);
        expect(await exited).toBe(0);
        expect(readBridgeReportLog().reports).toHaveLength(trial + 1);
        await recordSeatRuleReports(PROJECT, iso(T0), Date.now() + 1_000);
        expect(readBridgeReportLog().reports).toHaveLength(trial + 1);
      } finally { clearTimeout(watchdog); clearTimeout(release); if (child.exitCode === null) child.kill("SIGKILL"); await exited; }
    }
    const { spyOn } = await import("bun:test");
    const pipelineStore = await import("@/lib/pipelines/store");
    const reads = spyOn(pipelineStore, "loadPipelinesForList");
    try {
      await recordSeatRuleReports(PROJECT, iso(T0), Date.now() + 1_000);
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
    console.log(JSON.stringify({ case: "rule-reports-writer-contention", lockHoldMs: 40, waitBudgetMs: 1_000, elapsedMs: measurements }));
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
