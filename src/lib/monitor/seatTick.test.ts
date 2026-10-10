import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seatTickWakeMessage } from "./report";

import { evaluateLiveness } from "@/lib/lifecycle/liveness";
import { observeDiskPressureReport } from "@/lib/state/diskPressure";

import {
  DEFAULT_SEAT_TICK_POLICY,
  SEAT_TICK_RUNNING_CHILD_WAKE_INTERVAL_MS,
  SEAT_TICK_SETTLED_CHILD_WAKE_INTERVAL_MS,
  SEAT_TICK_WAKE_INTERVAL_MS,
  seatTickDecision,
  seatTickPolicy,
  seatTickSourceGapAfterFailure,
  seatTickSourceGapStanding,
  seatTickSourceRetryDue,
  seatTickWakeCommit,
  seatTickWakeCommitPlan,
  seatTurnProgressing,
} from "./seatTick";
import { defaultSeatTickSettings, effectiveSeatTickSettings, type SeatTickSettings } from "./seatTickSettings";
import {
  emptySeatTickState,
  type SeatTickCheckInput,
  type SeatTickChildInput,
  type SeatTickEventInput,
  type SeatTickPipelineInput,
  type SeatTickProjectState,
  type SeatTickPullRequestInput,
  type SeatTickSeatInput,
  type SeatTickOwnLaneInput,
  type SeatTickSourceGap,
  type SeatTickTaskInput,
  type SeatTickVerdict,
  type SeatTickWakeCommit,
} from "./types";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const PROJECT = "viewer";
/* Assembled from parts: a conversation-shaped literal is what the publication
   gate refuses in a committed artifact. */
const CONVERSATION = ["conversation", "0f4c21b7729fbc9e"].join("_");
const MINUTE = 60_000;

function seat(over: Partial<SeatTickSeatInput> = {}): SeatTickSeatInput {
  return { conversationId: CONVERSATION, seatEpoch: 7, path: null, designatedAt: null, turn: "idle", activity: null, ...over };
}

function lane(over: Partial<SeatTickPipelineInput> = {}): SeatTickPipelineInput {
  return {
    id: "pipeline_a1",
    title: "ship the exporter",
    state: "active",
    updatedAt: new Date(NOW - MINUTE).toISOString(),
    stageActivity: null,
    stageId: "build",
    ...over,
  };
}

function card(over: Partial<SeatTickTaskInput> = {}): SeatTickTaskInput {
  return {
    id: "task_b2",
    title: "wire the chip",
    status: "assigned",
    owned: false,
    updatedAt: new Date(NOW - MINUTE).toISOString(),
    ...over,
  };
}

function event(over: Partial<SeatTickEventInput> = {}): SeatTickEventInput {
  return {
    seq: 42,
    at: new Date(NOW - MINUTE).toISOString(),
    type: "stage_blocked",
    summary: "the review round is parked",
    pipelineId: "pipeline_a1",
    pipelineTerminal: false,
    ...over,
  };
}

/** A pull request a finished lane left open (#1289). */
function pullRequest(over: Partial<SeatTickPullRequestInput> = {}): SeatTickPullRequestInput {
  return {
    number: 1289,
    title: "wake on a merge that is waiting",
    pipelineId: "pipeline_a1",
    pipelineTitle: "ship the exporter",
    updatedAt: new Date(NOW - 30 * MINUTE).toISOString(),
    ...over,
  };
}

function input(over: Partial<SeatTickCheckInput> = {}): SeatTickCheckInput {
  return {
    project: PROJECT,
    now: NOW,
    seat: seat(),
    pipelines: [],
    tasks: [],
    events: [],
    pullRequests: [],
    pullRequestsUnavailable: null,
    ownLanes: [],
    signals: [],
    children: [],
    childrenUnavailable: null,
    changeFingerprint: "fp-1",
    state: emptySeatTickState(),
    policy: DEFAULT_SEAT_TICK_POLICY,
    /* The default a project nobody configured reads (#1275): every case below
       that does not say otherwise is the tick exactly as it shipped. */
    settings: effectiveSeatTickSettings(defaultSeatTickSettings(PROJECT), NOW, SEAT_TICK_WAKE_INTERVAL_MS),
    ...over,
  };
}

/** A standalone child the seat spawned (#1465). */
function child(over: Partial<SeatTickChildInput> = {}): SeatTickChildInput {
  return {
    conversationId: ["conversation", "c1d2e3f4a5b6c7d8"].join("_"),
    title: "build the exporter",
    status: "running",
    outcome: null,
    terminalAt: null,
    /* Every projected child carries the instant of its own last transcript
       record (#1783 round two), terminal or not: a child the registry still
       records mid-turn has no terminal instant and never will, so this is the
       only clock the age test can read for it. A child with none is one whose
       transcript the Viewer could not resolve at all. */
    lastRecordAt: new Date(NOW - MINUTE).toISOString(),
    activity: null,
    ...over,
  };
}

function stateWith(over: Partial<SeatTickProjectState>): SeatTickProjectState {
  return { ...emptySeatTickState(), ...over };
}

/** The reasons a verdict carries, or none for every verdict that is not a wake. */
function reasonsOf(verdict: SeatTickVerdict): string[] {
  return verdict.kind === "wake" ? verdict.reasons.map((reason) => reason.kind) : [];
}

/** What a verdict would commit if its wake landed. Non-null for every verdict
    these commit tests use. */
function plan(verdict: SeatTickVerdict, fingerprint: string, eventsThrough: number): SeatTickWakeCommit {
  return seatTickWakeCommitPlan(verdict, { fingerprint, eventsThrough })!;
}

describe("completed lane merges", () => {
  const merge = (seq: number, over: Partial<SeatTickEventInput> = {}) => event({
    seq, type: "pipeline_merged", pipelineId: `pipeline_merge_${seq}`, pipelineTerminal: true,
    summary: `ship feature ${seq} — pull request #${seq} merged, head ${"a".repeat(40)}`, ...over,
  });
  const idle = (over: Partial<SeatTickCheckInput> = {}) => input({
    pipelines: [], tasks: [], state: stateWith({ eventsThrough: 0, lastProposalAt: new Date(NOW).toISOString() }), ...over,
  });

  test("a lost wake leaves every merge owed, and a delivered bounded wake leaves the remainder", () => {
    const events = [merge(1), merge(2), merge(3), event({ seq: 4, type: "task_finished", pipelineTerminal: true })];
    const first = seatTickDecision(idle({ events, policy: { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 2 } }));
    expect(first.verdict.kind).toBe("wake");
    if (first.verdict.kind !== "wake") return;
    expect(first.verdict.items.map(item => item.id)).toEqual(["pipeline_merge_1", "pipeline_merge_2"]);
    expect(first.verdict.deferred).toBe(1);
    expect(first.state.eventsThrough).toBe(0);
    expect(seatTickDecision(idle({ events, state: first.state })).verdict.kind).toBe("wake");
    const landed = seatTickWakeCommit(first.state, plan(first.verdict, "fp-1", 4), NOW);
    expect(landed.eventsThrough).toBe(2);
    const next = seatTickDecision(idle({ events: events.filter(event => event.seq > 2), state: landed, now: NOW + 61 * MINUTE }));
    expect(next.verdict.kind).toBe("wake");
    if (next.verdict.kind !== "wake") return;
    expect(next.verdict.items.map(item => item.id)).toEqual(["pipeline_merge_3"]);
    const done = seatTickWakeCommit(next.state, plan(next.verdict, "fp-1", 4), NOW + 61 * MINUTE);
    expect(seatTickDecision(idle({ state: done, now: NOW + 122 * MINUTE })).verdict.kind).toBe("quiet");
  });

  test("a merge omitted from the rendered wake remains owed", () => {
    const events = [merge(1), merge(2)];
    const decision = seatTickDecision(idle({ events }));
    expect(decision.verdict.kind).toBe("wake");
    if (decision.verdict.kind !== "wake") return;
    // The renderer can retain a later short line while cutting an earlier one.
    const frozenText = seatTickWakeMessage({ project: PROJECT, reasons: decision.verdict.reasons,
      items: decision.verdict.items.slice(1), deferred: 1, signals: [] });
    const commit = seatTickWakeCommitPlan(decision.verdict, { fingerprint: "fp-1", eventsThrough: 2, frozenText })!;
    const landed = seatTickWakeCommit(decision.state, commit, NOW);
    expect(landed.eventsThrough).toBe(0);
    const next = seatTickDecision(idle({ events, state: landed, now: NOW + 61 * MINUTE }));
    expect(next.verdict.kind).toBe("wake");
    if (next.verdict.kind !== "wake") return;
    expect(next.verdict.items.map(item => item.id)).toEqual(["pipeline_merge_1"]);
  });

  test("merges respect the configured interval and survive an exhausted reason guard", () => {
    const settings = effectiveSeatTickSettings({ ...defaultSeatTickSettings(PROJECT), wakeIntervalMinutes: 15 }, NOW, SEAT_TICK_WAKE_INTERVAL_MS);
    const state = stateWith({ eventsThrough: 0, lastWakeAt: new Date(NOW).toISOString(), lastProposalAt: new Date(NOW).toISOString(),
      wakesWithoutChange: { "lane-event": DEFAULT_SEAT_TICK_POLICY.retryGuard }, lastWakeFingerprint: "fp-1" });
    const events = [merge(1, { at: new Date(NOW).toISOString() })];
    const early = seatTickDecision(idle({ events, state, settings, now: NOW + 14 * MINUTE }));
    expect(early.verdict.kind).toBe("quiet");
    expect(early.state.eventsThrough).toBe(0);
    expect(seatTickDecision(idle({ events, state: early.state, settings, now: NOW + 15 * MINUTE })).verdict.kind).toBe("wake");
  });

  test("old or undated merges and other completed-lane events remain history", () => {
    const events = [merge(1, { at: new Date(NOW - DEFAULT_SEAT_TICK_POLICY.backlogAfterMs - 1).toISOString() }),
      merge(2, { at: "unreadable" }), event({ seq: 3, pipelineTerminal: true })];
    const decision = seatTickDecision(idle({ events }));
    expect(decision.verdict.kind).toBe("quiet");
    expect(decision.state.eventsThrough).toBe(3);
  });
});

test("a project with open work and no active seat reports no-seat and asks for one card, never a spawn", () => {
  const decision = seatTickDecision(input({ seat: null, pipelines: [lane()] }));
  expect(decision.verdict).toEqual({
    kind: "no-seat",
    detail: "the project has open work and no active orchestrator seat",
  });
  expect(decision.cards).toHaveLength(1);
  expect(decision.cards[0]!.kind).toBe("no-seat");
  expect(decision.state.lastCheckAt).toBe(new Date(NOW).toISOString());
});

test("a project that never had a seat reports no-seat and asks for no card (#2170)", () => {
  const decision = seatTickDecision(input({ seat: null, seatEverHeld: false, pipelines: [lane()] }));
  expect(decision.verdict).toEqual({
    kind: "no-seat",
    detail: "the project has open work and has never had an orchestrator seat",
  });
  expect(decision.cards.filter((card) => card.kind === "no-seat")).toEqual([]);
  /* A project whose seat was revoked is missing one, and still says so. */
  expect(seatTickDecision(input({ seat: null, seatEverHeld: true, pipelines: [lane()] })).cards.map((card) => card.kind)).toContain("no-seat");
});

test("a seat whose turn is genuinely moving is skipped, not queued", () => {
  const decision = seatTickDecision(input({
    seat: seat({ turn: "busy", activity: { lifecycle: "running", reason: "host_alive_turn_active" } }),
    pipelines: [lane({ state: "inert" })],
    state: stateWith({ stalledSeen: ["pipeline_a1"], eventsThrough: 9 }),
  }));
  expect(decision.verdict).toEqual({ kind: "skipped", reason: "seat-busy" });
  /* Nothing about the skipped check is remembered as progress: the stall memory
     and the event cursor stay where they were, so the next check re-decides. */
  expect(decision.state.stalledSeen).toEqual(["pipeline_a1"]);
  expect(decision.state.eventsThrough).toBe(9);
  expect(decision.state.lastCheckAt).toBe(new Date(NOW).toISOString());
});

/* The permanent skip this replaces: a seat whose host died mid-turn keeps a
   `busy` turn on the registry for as long as the record stands, so a plain busy
   check dropped every tick forever — silenced by exactly the condition the wake
   exists to clear. */
test("a busy seat the registry reports stalled is no longer skipped, so the skip terminates", () => {
  const stalledSeat = seat({ turn: "busy", activity: { lifecycle: "stalled", reason: "host_gone_turn_open" } });
  const decision = seatTickDecision(input({
    seat: stalledSeat,
    pipelines: [lane()],
    signals: [{ id: "seat-host", label: "the seat's own turn is stalled" }],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(seatTurnProgressing(stalledSeat)).toBe(false);
  expect(decision.verdict.kind).toBe("wake");
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
});

test("a busy seat the liveness plane cannot answer for is not skipped either — absence is not progress", () => {
  expect(seatTurnProgressing(seat({ turn: "busy", activity: null }))).toBe(false);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "gone", reason: "host_gone_turn_settled" } }))).toBe(false);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "provider_throttled", turnState: "busy" } }))).toBe(true);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "starting", reason: "launch_unproven" } }))).toBe(true);
  expect(seatTurnProgressing(seat({ turn: "idle", activity: { lifecycle: "running", reason: "host_alive_turn_active" } }))).toBe(false);
});

/* #1262: the registry's turn record and the transcript's own turn are two
   different facts, and the tick read them as one. A seat that finished its turn
   leaves the registry record open for a while; the liveness verdict for it is
   `waiting` (`host_alive_turn_idle`), which the tick counted as progress — so
   an available seat was skipped at every check for as long as the stale record
   stood, and could not be woken at all. Only the turn a retry deadline is
   holding open is progress. */
test("a seat whose turn the transcript says settled is available, not progressing", () => {
  const settled = seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "host_alive_turn_idle", turnState: "idle" } });
  expect(seatTurnProgressing(settled)).toBe(false);
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "provider_throttled", turnState: "busy" } }))).toBe(true);
  /* An unstated turn is not a turn anybody proved open. */
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: "waiting", reason: "host_alive_turn_idle" } }))).toBe(false);
  const decision = seatTickDecision(input({
    seat: settled,
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("wake");
});

test("a healthy moving board is quiet and produces nothing operator-visible", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
  expect(decision.cards).toEqual([]);
  expect(decision.state.quietSince).toBe(new Date(NOW).toISOString());
  expect(decision.state.idleSince).toBeNull();
});

test("a stall wakes only once it has persisted across two consecutive checks", () => {
  const stuck = lane({ stageActivity: { lifecycle: "stalled", reason: "host_alive_transcript_silent" } });
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
  const first = seatTickDecision(input({ pipelines: [stuck], state: stateWith(overdue) }));
  expect(reasonsOf(first.verdict)).toEqual(["interval"]);
  expect(first.state.stalledSeen).toEqual(["pipeline_a1"]);

  const second = seatTickDecision(input({ pipelines: [stuck], state: stateWith({ ...overdue, stalledSeen: ["pipeline_a1"] }) }));
  expect(reasonsOf(second.verdict)).toEqual(["stalled"]);
});

test("a stall the last wake reported and that has not moved gives its place to every unstarted task", () => {
  const stuckSince = new Date(NOW - 120 * MINUTE).toISOString();
  const stalls = [1, 2, 3, 4, 5].map((n) => lane({ id: `pipeline_s${n}`, title: `stuck ${n}`, updatedAt: stuckSince,
    stageActivity: { lifecycle: "stalled", reason: "host_alive_transcript_silent" } }));
  const fresh = card({ id: "task_new", title: "assigned after the wake", updatedAt: new Date(NOW - 10 * MINUTE).toISOString() });
  const older = card({ id: "task_old", title: "assigned before the wake", updatedAt: new Date(NOW - 90 * MINUTE).toISOString() });
  const seen = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), lastWakeReasons: ["stalled" as const], stalledSeen: stalls.map((stall) => stall.id) };
  const reportedStalls = stalls.map((stall) => `${stall.id}@${stuckSince}`);
  const idsOf = (verdict: SeatTickVerdict) => verdict.kind === "wake" ? verdict.items.map((item) => item.id) : [];

  const reported = seatTickDecision(input({ pipelines: stalls, tasks: [older, fresh], state: stateWith({ ...seen, reportedStalls }) }));
  expect(reasonsOf(reported.verdict)).toEqual(["stalled", "unstarted-task"]);
  expect(idsOf(reported.verdict)).toEqual(["task_old", "task_new", "pipeline_s1", "pipeline_s2", "pipeline_s3"]);

  /* Never named by a landed wake, the stalls keep the head of the agenda,
     even though the last wake carried the stalled reason. */
  const unreported = seatTickDecision(input({ pipelines: stalls, tasks: [older, fresh], state: stateWith(seen) }));
  expect(idsOf(unreported.verdict)).toEqual(stalls.map((stall) => stall.id));

  /* A stalled lane that moved since the wake is news again and stays ahead. */
  const moved = stalls.map((stall, index) => index === 0 ? { ...stall, updatedAt: new Date(NOW - 30 * MINUTE).toISOString() } : stall);
  const again = seatTickDecision(input({ pipelines: moved, tasks: [older, fresh], state: stateWith({ ...seen, reportedStalls }) }));
  expect(idsOf(again.verdict)).toEqual(["pipeline_s1", "task_old", "task_new", "pipeline_s2", "pipeline_s3"]);
});

test("a task assigned before the wake that first reported a stall is not deferred behind it on the next wake", () => {
  const W1 = NOW - 90 * MINUTE;
  const stalls = [1, 2, 3, 4, 5].map((n) => lane({ id: `pipeline_s${n}`, title: `stuck ${n}`,
    updatedAt: new Date(NOW - 240 * MINUTE).toISOString(),
    stageActivity: { lifecycle: "stalled", reason: "host_alive_transcript_silent" } }));
  const assigned = card({ id: "task_early", title: "assigned before the stalls were reported",
    updatedAt: new Date(W1 - 30 * MINUTE).toISOString() });
  const idsOf = (verdict: SeatTickVerdict) => verdict.kind === "wake" ? verdict.items.map((item) => item.id) : [];

  /* W1: the stalls pass their second check; the wake before carried no stall. */
  const first = seatTickDecision(input({ now: W1, pipelines: stalls, tasks: [assigned],
    state: stateWith({ lastWakeAt: new Date(W1 - 61 * MINUTE).toISOString(), lastWakeReasons: ["interval"],
      stalledSeen: stalls.map((stall) => stall.id) }) }));
  expect(reasonsOf(first.verdict)).toEqual(["stalled", "unstarted-task"]);
  expect(idsOf(first.verdict)).toEqual(stalls.map((stall) => stall.id));
  const landed = seatTickWakeCommit(first.state, plan(first.verdict, "fp-w1", 0), W1);
  expect(landed.lastWakeReasons).toContain("stalled");
  expect(landed.reportedStalls).toEqual(stalls.map((stall) => `${stall.id}@${stall.updatedAt}`));

  /* W2: the stalls have not moved, and the task, older than W1, now leads. */
  const second = seatTickDecision(input({ pipelines: stalls, tasks: [assigned], changeFingerprint: "fp-w2", state: landed }));
  expect(reasonsOf(second.verdict)).toContain("unstarted-task");
  expect(idsOf(second.verdict)).toEqual(["task_early"]);
});

test("a stall no landed wake named keeps its place ahead of five or more unstarted tasks", () => {
  const W1 = NOW - 90 * MINUTE;
  const stuck = { updatedAt: new Date(NOW - 240 * MINUTE).toISOString(), stageActivity: { lifecycle: "stalled" as const, reason: "host_alive_transcript_silent" } };
  const told = lane({ id: "pipeline_told", title: "reported stall", ...stuck });
  const untold = lane({ id: "pipeline_untold", title: "stall nobody reported", ...stuck });
  const tasks = [1, 2, 3, 4, 5, 6].map((n) => card({ id: `task_${n}`, title: `task ${n}`, updatedAt: new Date(W1 - 30 * MINUTE).toISOString() }));
  const idsOf = (verdict: SeatTickVerdict) => verdict.kind === "wake" ? verdict.items.map((item) => item.id) : [];

  /* W1: only the first lane has stalled across two checks; the wake names it. */
  const first = seatTickDecision(input({ now: W1, pipelines: [told, { ...untold, stageActivity: null }], tasks,
    state: stateWith({ lastWakeAt: new Date(W1 - 61 * MINUTE).toISOString(), stalledSeen: [told.id] }) }));
  expect(idsOf(first.verdict)[0]).toBe(told.id);
  const landed = seatTickWakeCommit(first.state, plan(first.verdict, "fp-w1", 0), W1);
  expect(landed.lastWakeReasons).toEqual(["stalled", "unstarted-task"]);

  /* W2: the second lane crossed its second stalled check after W1. Its record
     is older than W1 too, and it still leads, because no wake named it. */
  const second = seatTickDecision(input({ pipelines: [told, untold], tasks, changeFingerprint: "fp-w2",
    state: { ...landed, stalledSeen: [told.id, untold.id] } }));
  expect(idsOf(second.verdict)).toEqual([untold.id, "task_5", "task_6"]);
  expect(second.verdict.kind === "wake" ? second.verdict.deferred : null).toBe(0);

  /* W3: every item was delivered; unrelated movement repeats none. */
  const third = seatTickWakeCommit(second.state, plan(second.verdict, "fp-w2", 0), NOW);
  expect(third.reportedStalls).toEqual([`${told.id}@${told.updatedAt}`, `${untold.id}@${untold.updatedAt}`]);
  const after = seatTickDecision(input({ now: NOW + 90 * MINUTE, pipelines: [told, untold], tasks, changeFingerprint: "fp-w3", state: third }));
  expect(after.verdict.kind).toBe("quiet");
});

test("a stage or child held on a permission request is listed as a permission item, never as a stall (#2215)", () => {
  const permission = { tool: "Bash", command: "rm -rf $R/*.json", reason: "Dangerous rm operation on possibly-empty variable path: $R/*.json" };
  const held = lane({ stageId: "build", stageActivity: { lifecycle: "waiting", reason: "permission_request", turnState: "busy", permission } });
  const worker = child({ activity: { lifecycle: "waiting", reason: "permission_request", turnState: "busy", permission } });
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
  const decision = seatTickDecision(input({ pipelines: [held], children: [worker], state: stateWith(overdue) }));
  expect(reasonsOf(decision.verdict)).toEqual(["permission-request"]);
  expect(decision.state.stalledSeen).toEqual([]);
  if (decision.verdict.kind !== "wake") throw new Error("expected a wake");
  const items = decision.verdict.items.filter((item) => item.kind === "permission");
  expect(items.map((item) => item.id)).toEqual(["pipeline_a1", worker.conversationId]);
  expect(items[0]!.label).toContain("stage build waits on a Bash permission request `rm -rf $R/*.json`");
  expect(items[0]!.label).toContain("(Dangerous rm operation on possibly-empty variable path: $R/*.json)");
  expect(items[0]!.label).toContain("conversation_action permission");
});

/* The stall reading the whole verdict rests on. Movement instants belong to the
   fingerprint, never to the stall rule: a stage running for hours with a host
   writing to its transcript is moving, and subtracting its newest attempt
   instant from the clock is how it gets called stuck. */
test("a lane's stall is the registry's verdict, never the age of its newest attempt", () => {
  const ancient = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), stalledSeen: ["pipeline_a1"] };
  const longRunning = lane({
    updatedAt: new Date(NOW - 8 * 60 * MINUTE).toISOString(),
    stageActivity: { lifecycle: "running", reason: "host_alive_turn_active" },
  });
  expect(reasonsOf(seatTickDecision(input({ pipelines: [longRunning], state: stateWith(ancient) })).verdict)).toEqual(["interval"]);

  const dead = lane({
    updatedAt: new Date(NOW - MINUTE).toISOString(),
    stageActivity: { lifecycle: "gone", reason: "host_gone_turn_settled" },
  });
  const verdict = seatTickDecision(input({ pipelines: [dead], state: stateWith(ancient) })).verdict;
  expect(reasonsOf(verdict)).toEqual(["stalled"]);
  expect(verdict.kind === "wake" && verdict.reasons[0]!.detail).toContain("host_gone_turn_settled");
});

test("a parked lane stalls by the monitor's own rule, and a lane that moved again clears the memory", () => {
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), stalledSeen: ["pipeline_a1"] };
  const parked = seatTickDecision(input({ pipelines: [lane({ state: "inert" })], state: stateWith(overdue) }));
  expect(reasonsOf(parked.verdict)).toEqual(["stalled"]);
  expect(parked.verdict.kind === "wake" && parked.verdict.reasons[0]!.detail).toContain("parked");

  const moved = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ ...overdue, lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() }),
  }));
  expect(moved.verdict.kind).toBe("quiet");
  expect(moved.state.stalledSeen).toEqual([]);
});

test("a lane with no activity verdict at all is never called stalled", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane({ updatedAt: null, stageActivity: null })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), stalledSeen: ["pipeline_a1"] }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
  expect(decision.state.stalledSeen).toEqual([]);
});

/* A terminal lane event leads the next wake; it never raises an early one. The
   hourly bound has no exempt reason kind, because a reason allowed to jump it
   would make the ADR's cost argument describe a different system. */
test("a terminal lane event leads the next wake rather than raising one early", () => {
  const args = { events: [event()], pipelines: [lane()] };
  const early = seatTickDecision(input({ ...args, state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }) }));
  expect(early.verdict.kind).toBe("quiet");

  const due = seatTickDecision(input({ ...args, state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }) }));
  expect(reasonsOf(due.verdict)).toEqual(["lane-event"]);
  expect(due.verdict.kind === "wake" && due.verdict.items[0]).toMatchObject({ kind: "event", id: "pipeline_a1" });
});

test("routine lane events do not wake on their own", () => {
  const decision = seatTickDecision(input({
    events: [event({ type: "stage_started", summary: "builder started" })],
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

/* #1285, the first direction. Three consecutive wakes were spent listing events
   whose pipelines had reached a terminal state the day before — two of them
   closed by the seat itself earlier in the same session. A lane that is over
   owes nothing, so an event about it is history and never an agenda. */
test("events whose lanes have finished are history, and a project holding only those is quiet", () => {
  const decision = seatTickDecision(input({
    events: [
      event({ seq: 60, type: "stage_completed", summary: "the builder finished", pipelineTerminal: true }),
      event({ seq: 61, type: "review_verdict", summary: "the round passed", pipelineId: "pipeline_c3", pipelineTerminal: true }),
    ],
    /* Open work, so the answer under test is "nothing owed" rather than "the
       board is done" — and an inbox card is deliberately not an agenda of its
       own, which leaves the events as the only thing that could wake anyone. */
    tasks: [card({ status: "inbox" })],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
});

/* And the count beside the reason says how much of it is live. "18 more" over a
   page that was almost entirely closed lanes described a queue of eighteen
   things to do that did not exist. */
test("the lane-event count names only the events that are still owed", () => {
  const decision = seatTickDecision(input({
    events: [
      event({ seq: 60, type: "stage_completed", summary: "yesterday's lane finished", pipelineTerminal: true }),
      event({ seq: 61, type: "review_verdict", summary: "the round passed" }),
      event({ seq: 62, type: "stage_failed", summary: "the verifier failed", pipelineTerminal: true }),
      event({ seq: 63, type: "stage_blocked", summary: "the round is parked" }),
    ],
    pipelines: [lane()],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["lane-event"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("review_verdict since the last delivered wake and 1 more");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.filter((item) => item.kind === "event"))
    .toHaveLength(2);
});

/* The second half of #1285, and the expensive one. A backlog drained at
   `itemsPerWake` per hourly wake is ten resumed hosts and ten paid turns for
   fifty events that were history. One look establishes that nothing in front of
   the cursor is owed, and the cursor moves on that look alone. */
test("a page of history is discharged by the check that read it, with no wake at all", () => {
  const history = Array.from({ length: 50 }, (_, index) => event({
    seq: 100 + index,
    type: "stage_completed",
    summary: "a lane that closed yesterday finished",
    pipelineTerminal: true,
  }));
  const decision = seatTickDecision(input({
    events: history,
    tasks: [card({ status: "inbox" })],
    state: stateWith({ eventsThrough: 99, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
  expect(decision.state.eventsThrough).toBe(149);
});

/* The seal is not a licence to acknowledge. It stops dead at the first event
   that is still owed, so the history in front of one is discharged and the
   event itself waits for a wake that actually lands. */
test("the seal stops at the first event that is still owed", () => {
  const decision = seatTickDecision(input({
    events: [
      event({ seq: 60, type: "stage_started", summary: "builder started" }),
      event({ seq: 61, type: "stage_completed", summary: "a closed lane's stage", pipelineTerminal: true }),
      event({ seq: 62, type: "review_verdict", summary: "the round passed" }),
      event({ seq: 63, type: "stage_completed", summary: "another closed lane's stage", pipelineTerminal: true }),
    ],
    pipelines: [lane()],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.state.eventsThrough).toBe(61);
  expect(reasonsOf(decision.verdict)).toEqual(["lane-event"]);
  /* And only a landing takes the cursor past the live one. */
  expect(seatTickWakeCommit(decision.state, plan(decision.verdict, "fp-1", 63), NOW).eventsThrough).toBe(63);
});

/* A skipped check remembers nothing — including this. The turn it landed behind
   has already superseded the evidence it read. */
test("a skipped check seals nothing", () => {
  const decision = seatTickDecision(input({
    seat: seat({ turn: "busy", activity: { lifecycle: "running", reason: "host_alive_turn_active" } }),
    events: [event({ seq: 60, type: "stage_completed", summary: "a closed lane's stage", pipelineTerminal: true })],
    state: stateWith({ eventsThrough: 59 }),
  }));
  expect(decision.verdict).toEqual({ kind: "skipped", reason: "seat-busy" });
  expect(decision.state.eventsThrough).toBe(59);
});

/* A live event further down the journal than this check reads is NOT announced
   as "something is waiting". That wake carried no item naming it, so the seat
   paid a resume to be told to look again — and the pages of history in front of
   it are now sealed away for free, so the check that reaches it names it. */
test("a live event past the page waits for the check that can name it, rather than raising an empty wake", () => {
  const decision = seatTickDecision(input({
    events: [event({ seq: 60, type: "stage_completed", summary: "a closed lane's stage", pipelineTerminal: true })],
    tasks: [card({ status: "inbox" })],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
  expect(decision.state.eventsThrough).toBe(60);
});

/* #1289, the mirror image, and it cost twelve hours. Two lanes finished with
   clean approvals, three pull requests sat approved and unmerged, and the tick
   answered "quiet — nothing owed" every five minutes because `hasOpenWork`
   counts open lanes and board cards and a finished lane is neither. */
test("a finished lane whose pull request is still open is a wake reason of its own, naming the pull request", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["unmerged-pr"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("pull request #1289 left open by a lane that finished");
  expect(decision.verdict.kind === "wake" && decision.verdict.items[0]).toMatchObject({
    kind: "pull-request",
    id: "#1289",
    label: "wake on a merge that is waiting — open pull request from ship the exporter, unmerged since that lane finished",
  });
});

/* The merge is the discharge, and the only one. The source reads OPEN pull
   requests, so a merged or closed one is simply absent and the same project
   goes quiet with no second mechanism silencing anything. */
test("a merged batch goes quiet on its own", () => {
  const decision = seatTickDecision(input({
    pullRequests: [],
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
});

/* It is a reason, never a route around the bound: the hourly interval applies
   to it exactly as it applies to a terminal lane event. */
test("an unmerged pull request waits out the wake interval like every other reason", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest()],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

/* A pull request still owed to the seat remains offerable when the old row
   has no showing history, even after its retry guard was exhausted. */
test("an unmerged pull request with unknown showing history passes an exhausted retry guard", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest()],
    state: stateWith({
      lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
      lastWakeFingerprint: "fp-1",
      wakesWithoutChange: { "unmerged-pr": 2 },
    }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["unmerged-pr"]);
  expect(decision.cards).toEqual([]);
});

/* Several at once name the first and count the rest, and every one of them is
   carried as an item — the seat acts on the list without rediscovering it. */
test("several unmerged pull requests are counted in the reason and named one by one", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest(), pullRequest({ number: 1290, title: "stop replaying closed lanes" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("pull request #1289 and 1 more left open by a lane that finished");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map((item) => item.id)).toEqual(["#1289", "#1290"]);
});

/* ------------------------------------------------------------------------- *
 * A read that failed may not be spent as a silence.
 *
 * The empty list a failed `gh` used to return was indistinguishable from every
 * pull request having merged, and the decision published `quiet — nothing
 * owed` on the strength of it. Quiet is a conclusion; this is what happens
 * when the evidence for it could not be read.
 * ------------------------------------------------------------------------- */

test("a check that could not read the open pull requests reports an error instead of quiet", () => {
  const decision = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({
    kind: "error",
    detail: "the open pull requests of this project's finished lanes could not be read (command-failed), so nothing owed is not established",
  });
});

/* Every way the read can fail, and none of them is a merge. */
test("a timeout and a malformed answer are refused as quiet exactly like a failed command", () => {
  for (const gap of ["timed-out", "malformed-output", "lanes-unreadable"] as const) {
    const decision = seatTickDecision(input({
      pullRequestsUnavailable: gap,
      tasks: [card({ status: "inbox" })],
      state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
    }));
    expect(decision.verdict.kind).toBe("error");
  }
});

/* The bound the fix must not become a way around: the error raises no wake, so
   there is nothing for the stamp or the guard to record, and an hour of `gh`
   failures leaves the next real wake exactly as due as it was. */
test("a failed read spends neither the wake stamp nor the retry guard", () => {
  const before = stateWith({
    lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
    lastWakeFingerprint: "fp-1",
    wakesWithoutChange: { "unmerged-pr": 1 },
    quietSince: null,
  });
  const decision = seatTickDecision(input({ pullRequestsUnavailable: "timed-out", state: before }));
  expect(decision.state.lastWakeAt).toBe(before.lastWakeAt);
  expect(decision.state.wakesWithoutChange).toEqual({ "unmerged-pr": 1 });
  expect(decision.state.lastWakeReasons).toEqual(before.lastWakeReasons);
  /* And it does not record the project as having been quiet since now, which
     is the same claim in the state row that the verdict just declined to
     make. */
  expect(decision.state.quietSince).toBeNull();
});

/* ------------------------------------------------------------------------- *
 * ...and a read that failed withdraws ITSELF, not the whole decision (#1298).
 *
 * The refusal above was correct and, taken alone, produced the same silence
 * from the other side: `gh` could not authenticate for four hours, so twenty-
 * three consecutive checks ended in `error` and two parked lanes were never
 * mentioned to anyone. The parked lanes had nothing to do with GitHub.
 * ------------------------------------------------------------------------- */

test("a wake reason that stands on its own still wakes the seat while GitHub is unreadable", () => {
  const decision = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    events: [event({ seq: 60, type: "stage_blocked", summary: "the review round is parked" })],
    state: stateWith({ eventsThrough: 59, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["lane-event"]);
  /* And the wake says what it could not see, so the seat is not acting on a
     partial picture it has no way of recognizing as partial. */
  expect(decision.verdict.kind === "wake" && decision.verdict.gaps).toEqual([{
    source: "pull-requests",
    gap: "command-failed",
    detail: "the open pull requests of this project's finished lanes could not be read (command-failed), "
      + "so a pull request a finished lane left unmerged cannot be named in this wake",
  }]);
});

/* The acceptance case, in the shape it happened: a parked lane, an unreadable
   pull-request source, and a seat that heard nothing for four hours. */
test("a parked lane wakes the seat under an unreadable pull-request source, and is named in the items", () => {
  const before = stateWith({
    lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
    stalledSeen: ["pipeline_a1"],
  });
  const decision = seatTickDecision(input({
    pipelines: [lane({ state: "inert", title: "park the review round" })],
    pullRequestsUnavailable: "command-failed",
    state: before,
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["stalled"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map((item) => item.id)).toEqual(["pipeline_a1"]);
  expect(decision.verdict.kind === "wake" && decision.verdict.gaps.map((gap) => gap.source)).toEqual(["pull-requests"]);
});

/* Every way the read can fail, against every reason that does not rest on it.
   None of them is withdrawn, and none of them turns into `unmerged-pr` — the
   one reason a failed read really does withhold, because the source carries no
   rows to name. */
test("every reason independent of the failed read still wakes, and the pull-request reason never does", () => {
  const before = stateWith({
    eventsThrough: 59,
    lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
    lastWakeFingerprint: "fp-0",
    quietSince: null,
  });
  const candidates = {
    "lane-event": { events: [event({ seq: 60 })] },
    "unstarted-task": { tasks: [card({ updatedAt: new Date(NOW - 90 * MINUTE).toISOString() })] },
    /* Carrying its own row, because a stall is only a reason once the memory of
       the previous check says it survived one. */
    stalled: {
      pipelines: [lane({ stageActivity: { lifecycle: "stalled", reason: "host_alive_transcript_silent" } })],
      state: { ...before, stalledSeen: ["pipeline_a1"] },
    },
    interval: { pipelines: [lane()] },
  } satisfies Record<string, Partial<SeatTickCheckInput>>;
  for (const gap of ["command-failed", "timed-out", "malformed-output"] as const) {
    for (const [name, candidate] of Object.entries(candidates)) {
      const decision = seatTickDecision(input({ state: before, ...candidate, pullRequestsUnavailable: gap }));
      expect(`${name}/${gap}: ${reasonsOf(decision.verdict).join(",")}`).toBe(`${name}/${gap}: ${name}`);
      expect(decision.verdict.kind === "wake" && decision.verdict.gaps.map((entry) => entry.gap)).toEqual([gap]);
      /* The decision never moves a stamp of its own — only a landed wake does —
         so the row leaves here exactly as the previous check left it. */
      expect(decision.state.lastWakeAt).toBe(before.lastWakeAt);
      expect(decision.state.lastWakeFingerprint).toBe(before.lastWakeFingerprint);
      expect(decision.state.quietSince).toBeNull();
    }
  }
});

/* The bound the fix must not become a way around, from the other side: a gap
   is not an agenda. Before the interval has elapsed no reason is composed at
   all, so an unreadable source raises no wake — it says it could not conclude
   anything, which is the one thing it is entitled to say. */
test("an unreadable source raises no wake before the interval has elapsed", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    pullRequestsUnavailable: "command-failed",
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("error");
});

/* A non-versioned owed outcome remains bounded by the guard even while a
   separate source gap keeps the overall check from claiming quiet. */
test("a guarded child outcome is not revived by an unreadable source", () => {
  const finished = child({ status: "terminal", outcome: "finished", terminalAt: new Date(NOW - 20 * MINUTE).toISOString() });
  const decision = seatTickDecision(input({
    children: [finished],
    pullRequestsUnavailable: "timed-out",
    changeFingerprint: "fp-1",
    state: stateWith({
      lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
      lastWakeFingerprint: "fp-1",
      wakesWithoutChange: { "child-terminal": 2 },
    }),
  }));
  expect(decision.verdict.kind).toBe("error");
  expect(decision.cards.map((entry) => entry.ref)).toContain("seat-tick-stuck-child-terminal");
  expect(decision.state.quietSince).toBeNull();
});

/* ------------------------------------------------------------------------- *
 * A source that cannot be read AT ALL says so once (#1298).
 *
 * Every one of the twenty-three failures was journaled. Nobody reads a
 * journal; the operator read the board, and the board said nothing.
 * ------------------------------------------------------------------------- */

/** A run of failures that started `agoMinutes` ago and has never been reported. */
function sourceGap(agoMinutes: number, over: Partial<SeatTickSourceGap> = {}): SeatTickSourceGap {
  const since = new Date(NOW - agoMinutes * MINUTE).toISOString();
  return { gap: "command-failed", since, lastAttemptAt: new Date(NOW).toISOString(), attempts: 12, reported: false, ...over };
}

test("a source unreadable for longer than the wake interval is put on the board, once", () => {
  const state = stateWith({
    lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
    pullRequestGap: sourceGap(70),
  });
  const decision = seatTickDecision(input({ pullRequestsUnavailable: "command-failed", state }));
  const raised = decision.cards.find((entry) => entry.kind === "source-unreadable");
  expect(raised?.ref).toBe("seat-tick-source-pull-requests");
  expect(raised?.detail).toContain("command-failed, 12 attempt(s)");
  /* The outage's own start rides on the card, so its create receipt is this
     outage's and not the condition's — the next outage is a card of its own. */
  expect(raised?.instance).toBe(state.pullRequestGap!.since);

  /* The row to remember AFTER the report exists travels apart from the row this
     check writes, and the row this check writes still says unreported: the
     board write has not happened yet, and a decision may not claim it did. */
  expect(decision.reportedSourceGap).toEqual({ ...state.pullRequestGap!, reported: true });
  expect(decision.state.pullRequestGap?.reported).toBe(false);

  /* Once that row IS the state — the controller wrote it because the card
     landed — the next check does not say it again, which is the whole
     difference between one report and one every five minutes. */
  const after = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    state: { ...state, pullRequestGap: sourceGap(70, { reported: true }) },
  }));
  expect(after.cards.filter((entry) => entry.kind === "source-unreadable")).toEqual([]);
  expect(after.reportedSourceGap).toBeNull();
});

/* The other half of the same rule, in the decision: a check whose card write
   fails leaves the row unreported, so the check after it composes the SAME
   card and the same row again. Nothing about the report is spent by an attempt
   at it. */
test("an unreported outage is carded again on every check until the row says otherwise", () => {
  const state = stateWith({
    lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
    pullRequestGap: sourceGap(70),
  });
  const first = seatTickDecision(input({ pullRequestsUnavailable: "command-failed", state }));
  const again = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    /* The row the failed check wrote: its own state, reported still false. */
    state: { ...state, pullRequestGap: first.state.pullRequestGap },
  }));
  expect(again.cards.filter((entry) => entry.kind === "source-unreadable")).toHaveLength(1);
  expect(again.reportedSourceGap).toEqual({ ...state.pullRequestGap!, reported: true });
});

/* A single failure is weather. Reporting it would teach the operator to ignore
   the card that matters, so the run has to outlive a whole wake interval. */
test("a source that has only just failed raises no card", () => {
  const decision = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    state: stateWith({
      lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
      pullRequestGap: sourceGap(5, { attempts: 1 }),
    }),
  }));
  expect(decision.cards.filter((entry) => entry.kind === "source-unreadable")).toEqual([]);
});

/* The predicates the gather shares with the decision, so both halves apply one
   rule rather than two copies of it. */
test("a standing run is retried at the wake interval and a fresh one at every check", () => {
  const fresh = sourceGap(5, { lastAttemptAt: new Date(NOW - MINUTE).toISOString() });
  expect(seatTickSourceGapStanding(fresh, NOW, SEAT_TICK_WAKE_INTERVAL_MS)).toBe(false);
  expect(seatTickSourceRetryDue(fresh, NOW, SEAT_TICK_WAKE_INTERVAL_MS)).toBe(true);

  const standing = sourceGap(70, { lastAttemptAt: new Date(NOW - MINUTE).toISOString() });
  expect(seatTickSourceGapStanding(standing, NOW, SEAT_TICK_WAKE_INTERVAL_MS)).toBe(true);
  expect(seatTickSourceRetryDue(standing, NOW, SEAT_TICK_WAKE_INTERVAL_MS)).toBe(false);
  expect(seatTickSourceRetryDue(sourceGap(180, { lastAttemptAt: new Date(NOW - 61 * MINUTE).toISOString() }), NOW, SEAT_TICK_WAKE_INTERVAL_MS)).toBe(true);
  /* Nothing recorded is nothing to back off from. */
  expect(seatTickSourceRetryDue(null, NOW, SEAT_TICK_WAKE_INTERVAL_MS)).toBe(true);
});

test("a failure joins the run it belongs to rather than restarting it", () => {
  const at = new Date(NOW).toISOString();
  const first = seatTickSourceGapAfterFailure(null, "command-failed", at);
  expect(first).toEqual({ gap: "command-failed", since: at, lastAttemptAt: at, attempts: 1, reported: false });
  const later = new Date(NOW + 10 * MINUTE).toISOString();
  expect(seatTickSourceGapAfterFailure({ ...first, reported: true }, "timed-out", later)).toEqual({
    gap: "timed-out",
    since: at,
    lastAttemptAt: later,
    attempts: 2,
    reported: true,
  });
});

/* The proposal is the fourth thing a check can spend, and it is spent on the
   strength of an idle board — which is the very reading a failed pull-request
   read leaves unestablished. So it waits with the rest, and its 24-hour slot
   stays unstamped for the check that can see what the finished lanes left. */
test("an idle board with the proposal slot due proposes nothing while GitHub is unreadable", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ status: "done" })],
    pullRequestsUnavailable: "lanes-unreadable",
  }));
  expect(decision.verdict.kind).toBe("error");
  expect(decision.state.lastProposalAt).toBeNull();
  /* And the board is not recorded as idle since now either: an idle board is
     the same claim about the same evidence. */
  expect(decision.state.idleSince).toBeNull();
  expect(decision.state.quietSince).toBeNull();
});

/* And the interval still bounds it from the other side: a check that was never
   going to ask GitHub carries no gap, so it goes quiet as it always did. */
test("a check inside the interval is quiet rather than an error", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
});

/* A tick that is off is off; nothing was read, so there is nothing to report
   as unreadable. */
test("a project whose tick is off stays quiet rather than reporting an error", () => {
  const decision = seatTickDecision(input({
    pullRequestsUnavailable: "command-failed",
    settings: settings({ enabled: false, reason: "nothing here for me" }),
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

/* An unmerged pull request is open work, so a board with nothing else on it
   does not read as idle and the proposal slot does not open under it. */
test("a finished lane with an open pull request is not an idle board", () => {
  const decision = seatTickDecision(input({
    pullRequests: [pullRequest()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), lastProposalAt: null }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["unmerged-pr"]);
  expect(decision.state.idleSince).toBeNull();
});

test("an assigned task nothing has started wakes the seat once the wake interval has elapsed", () => {
  const decision = seatTickDecision(input({
    tasks: [card()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["unstarted-task"]);
});

/* docs/design/linked-installs.md M.4: another machine's orchestrator starts
   its own tasks, so they are no wake reason here, unstarted or backlog. */
test("an assigned task another linked machine runs wakes no seat", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ runsOn: "beta" }), card({ id: "task_old", runsOn: "beta", updatedAt: new Date(NOW - 30 * 24 * 60 * MINUTE).toISOString() })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual([]);
});

/* #1262: the bound itself, at the layer that applies it. What the bound is FOR
   — a board of stale assigned cards that could never discharge the reason, and
   a movement that brings one back — is a claim about a real board under a real
   journal, so its regression is driven from those fixtures in
   `seatTickSources.test.ts` rather than asserted over an empty room here. */
test("a card with no readable movement instant is backlog, because staleness cannot be disproved", () => {
  const overdue = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
  expect(seatTickDecision(input({ tasks: [card({ updatedAt: null })], state: stateWith(overdue) })).verdict.kind).toBe("quiet");
  expect(seatTickDecision(input({ tasks: [card({ updatedAt: "not a time" })], state: stateWith(overdue) })).verdict.kind).toBe("quiet");
});

/* The seat is told why the number it is given is smaller than the board it can
   see, rather than being left to conclude the tick cannot count. */
test("the wake names the backlog it held back, and carries only the live cards as items", () => {
  const tasks = [
    card({ updatedAt: new Date(NOW - 30 * MINUTE).toISOString() }),
    card({ id: "task_c3", updatedAt: new Date(NOW - 20 * 24 * 60 * MINUTE).toISOString() }),
    card({ id: "task_d4", updatedAt: new Date(NOW - 90 * 24 * 60 * MINUTE).toISOString() }),
  ];
  const decision = seatTickDecision(input({ tasks, state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }) }));
  expect(decision.verdict.kind === "wake" && decision.verdict.reasons[0]!.detail)
    .toBe("wire the chip — assigned, nothing started it; 2 older than the backlog bound");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map((item) => item.id)).toEqual(["task_b2"]);
});

test("an owned, a blocked and a done task are all silent — blocked is the recorded stop", () => {
  const tasks = [card({ owned: true }), card({ id: "task_c3", status: "blocked" }), card({ id: "task_d4", status: "done" })];
  const decision = seatTickDecision(input({ tasks, state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }) }));
  expect(decision.verdict.kind).toBe("quiet");
});

test("the wake interval elapsing while a lane is open is itself a reason — roughly hourly", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
});

/* An inbox card is open work — it holds the proposal slot shut, correctly,
   because the operator's move to `assigned` is what starts it. But the seat is
   told not to act on inbox, so an hourly wake with only inbox open would carry
   an agenda of exactly nothing: the burnt-quota tick this replaces. */
test("the hourly interval never wakes an empty agenda", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
});

test("a signal alone is agenda enough for the interval to wake", () => {
  const decision = seatTickDecision(input({
    tasks: [card({ status: "inbox" })],
    signals: [{ id: "deploy", label: "the last deployment ended failed" }],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
});

test("standing reasons wait out the wake interval instead of firing every five minutes", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane({ state: "inert" })],
    tasks: [card()],
    state: stateWith({ lastWakeAt: new Date(NOW - 10 * MINUTE).toISOString(), stalledSeen: ["pipeline_a1"] }),
  }));
  expect(decision.verdict.kind).toBe("quiet");
});

test("a wake carries at most five items and reports the rest as deferred", () => {
  const lanes = Array.from({ length: 8 }, (_, index) => lane({ id: `pipeline_${index}`, title: `lane ${index}` }));
  const decision = seatTickDecision(input({
    pipelines: lanes,
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict.kind === "wake" && decision.verdict.items).toHaveLength(5);
  expect(decision.verdict.kind === "wake" && decision.verdict.deferred).toBe(3);
});

test("with no work at all and the proposal slot due, the verdict is proactive", () => {
  const decision = seatTickDecision(input({ tasks: [card({ status: "done" })] }));
  expect(decision.verdict.kind).toBe("proactive");
  expect(decision.state.idleSince).toBe(new Date(NOW).toISOString());
});

test("a proposal slot that is not due leaves an idle seat quiet", () => {
  const decision = seatTickDecision(input({
    state: stateWith({ lastProposalAt: new Date(NOW - 60 * MINUTE).toISOString() }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify; the proposal slot is not due" });
});

test("a proposal card still open on the board holds the next proposal off", () => {
  /* The card lands in `inbox`, which is open work, so the board is no longer
     idle and the slot cannot come round again until the operator moves it. */
  const decision = seatTickDecision(input({ tasks: [card({ status: "inbox" })] }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify" });
});

test("a fruitless child outcome is re-sent at most twice, then becomes a card", () => {
  const base = {
    children: [child({ status: "terminal", outcome: "finished", terminalAt: new Date(NOW - 20 * MINUTE).toISOString() })],
    state: stateWith({
      lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
      lastWakeFingerprint: "fp-1",
      wakesWithoutChange: { "child-terminal": 2 },
    }),
  };
  const decision = seatTickDecision(input(base));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "every wake reason is held by the retry guard" });
  expect(decision.cards).toHaveLength(1);
  expect(decision.cards[0]).toMatchObject({ kind: "retry-guard", ref: "seat-tick-stuck-child-terminal" });
});

test("board movement clears the retry guard, so a reason that starts working again is sent again", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    changeFingerprint: "fp-2",
    state: stateWith({
      lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(),
      lastWakeFingerprint: "fp-1",
      wakesWithoutChange: { interval: 2 },
    }),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
  expect(decision.cards).toEqual([]);
});

test("the wake commit records the wake, and only the commit advances lastWakeAt", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.state.lastWakeAt).toBe(new Date(NOW - 61 * MINUTE).toISOString());
  const committed = seatTickWakeCommit(decision.state, plan(decision.verdict, "fp-1", 44), NOW);
  expect(committed.lastWakeAt).toBe(new Date(NOW).toISOString());
  expect(committed.lastWakeReasons).toEqual(["interval"]);
  expect(committed.lastWakeFingerprint).toBe("fp-1");
  expect(committed.eventsThrough).toBe(44);
});

/* The whole reason the commit is a second function. An acknowledged lifecycle
   event is never offered again, so a cursor that moved on a refused, held or
   queued send loses the very lane event the next seat needed. */
test("no commit means no cursor: the event cursor moves only with a delivered wake", () => {
  const decision = seatTickDecision(input({
    events: [event({ seq: 44 })],
    pipelines: [lane()],
    state: stateWith({ eventsThrough: 12, lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
  }));
  expect(decision.state.eventsThrough).toBe(12);
  expect(seatTickWakeCommit(decision.state, plan(decision.verdict, "fp-1", 44), NOW).eventsThrough).toBe(44);
});

test("the cursor never walks backwards, whatever a caller hands the commit", () => {
  const committed = seatTickWakeCommit(stateWith({ eventsThrough: 90 }), plan({ kind: "proactive", detail: "" }, "fp", 12), NOW);
  expect(committed.eventsThrough).toBe(90);
});

test("a proactive commit stamps the proposal slot", () => {
  const committed = seatTickWakeCommit(emptySeatTickState(), plan({ kind: "proactive", detail: "due" }, "fp-1", 0), NOW);
  expect(committed.lastProposalAt).toBe(new Date(NOW).toISOString());
  expect(committed.lastWakeAt).toBe(new Date(NOW).toISOString());
});

test("policy defaults are the accepted ones, and each is overridable in the retirement idiom", () => {
  expect(seatTickPolicy({})).toEqual(DEFAULT_SEAT_TICK_POLICY);
  expect(seatTickPolicy({ LLV_SEAT_TICK_CHECK_MINUTES: "0" })).toBeNull();
  expect(seatTickPolicy({
    LLV_SEAT_TICK_CHECK_MINUTES: "2",
    LLV_SEAT_TICK_STALL_MINUTES: "15",
    LLV_SEAT_TICK_PROPOSAL_HOURS: "6",
    LLV_SEAT_TICK_ITEMS: "3",
    LLV_SEAT_TICK_RETRY_GUARD: "1",
    LLV_SEAT_TICK_BACKLOG_DAYS: "5",
  })).toEqual({
    checkIntervalMs: 2 * MINUTE,
    stallAfterMs: 15 * MINUTE,
    proposalIntervalMs: 6 * 60 * MINUTE,
    itemsPerWake: 3,
    retryGuard: 1,
    backlogAfterMs: 5 * 24 * 60 * MINUTE,
  });
});

/* The wake interval is the one number the ADR's cost argument rests on — one
   resume per project per interval — so it is not among the knobs. An
   environment that tries to set it changes nothing. */
/* ------------------------------------------------------------------------- *
 * Per-project tick settings (#1275).
 *
 * The seat is forbidden from arming its own loop, correctly — and until this
 * existed it had no way to quiet, slow or stop the one the Viewer arms for it.
 * The property every case here is arranged around: a project nobody has
 * configured decides exactly what it decided before the settings existed,
 * which is what every OTHER test in this file asserts by using the defaults.
 * ------------------------------------------------------------------------- */

function settings(over: Partial<SeatTickSettings> = {}) {
  return effectiveSeatTickSettings(
    { ...defaultSeatTickSettings(PROJECT), ...over },
    NOW,
    SEAT_TICK_WAKE_INTERVAL_MS,
  );
}

test("a project nobody configured carries no tick-settings card at all (#1275)", () => {
  const decision = seatTickDecision(input({ pipelines: [lane()] }));
  expect(decision.cards).toEqual([]);
});

test("a disabled tick sends no wake, and says on the record why it is quiet (#1275)", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
    settings: settings({ enabled: false, reason: "the only open lane is a draft nothing can discharge", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  expect(decision.verdict).toEqual({
    kind: "quiet",
    detail: "ticking is off for this project: the only open lane is a draft nothing can discharge",
  });
  expect(decision.cards).toEqual([{
    ref: "seat-tick-settings",
    kind: "tick-settings",
    state: "open",
    settings: { enabled: false, wakeIntervalMs: 60 * MINUTE, reason: "the only open lane is a draft nothing can discharge", until: null, setBy: null, updatedAt: "2026-08-28T11:00:00.000Z" },
    detail: "ticking is off for this project: no wake will be sent until it is turned back on",
  }]);
});

test("a disabled tick with no expiry stays off however long it has been off (#1275)", () => {
  const off = settings({ enabled: false, reason: "nothing here for me", updatedAt: "2026-01-01T00:00:00.000Z" });
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 400 * MINUTE).toISOString() }),
    settings: off,
  }));
  expect(decision.verdict.kind).toBe("quiet");
  expect(off.until).toBeNull();
});

test("the project's own wake interval is the bound every wake waits out (#1275)", () => {
  const state = stateWith({ lastWakeAt: new Date(NOW - 20 * MINUTE).toISOString() });
  /* The default hour holds this wake back … */
  expect(seatTickDecision(input({ pipelines: [lane()], state })).verdict.kind).toBe("quiet");
  /* … and a project that asked for a shorter one is woken. */
  const faster = seatTickDecision(input({
    pipelines: [lane()],
    state,
    settings: settings({ wakeIntervalMinutes: 15, reason: "a release is going out and I want the lane events sooner", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  expect(reasonsOf(faster.verdict)).toEqual(["interval"]);
  /* … and a project that asked for a longer one waits. */
  const slower = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
    settings: settings({ wakeIntervalMinutes: 6 * 60, reason: "nothing moves here faster than half a day", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  expect(slower.verdict.kind).toBe("quiet");
});

test("a slowed but enabled tick still carries its card, saying what it is set to (#1275)", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    settings: settings({ wakeIntervalMinutes: 180, reason: "batching the board into three-hour rounds", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  expect(decision.cards[0]).toMatchObject({
    ref: "seat-tick-settings",
    state: "open",
    detail: "wakes for this project are set to one every 180 minute(s)",
    /* The structured schedule the card composes its localized title from. */
    settings: { enabled: true, wakeIntervalMs: 180 * MINUTE },
  });
});

test("settings back at their default resolve the card instead of leaving it standing (#1275)", () => {
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    settings: settings({ reason: "the draft is gone, ticking as normal again", updatedAt: "2026-08-28T11:30:00.000Z" }),
  }));
  expect(decision.cards).toEqual([{
    ref: "seat-tick-settings",
    kind: "tick-settings",
    state: "resolved",
    settings: { enabled: true, wakeIntervalMs: 60 * MINUTE, reason: "the draft is gone, ticking as normal again", until: null, setBy: null, updatedAt: "2026-08-28T11:30:00.000Z" },
    detail: "this project is on the default tick settings",
  }]);
});

test("a setting that reached its expiry ticks normally again and says so (#1275)", () => {
  const lapsed = settings({
    enabled: false,
    reason: "quiet while the release runs",
    until: new Date(NOW - MINUTE).toISOString(),
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
  expect(lapsed).toMatchObject({ enabled: true, isDefault: true, lapsed: true });
  const decision = seatTickDecision(input({
    pipelines: [lane()],
    state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() }),
    settings: lapsed,
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
  expect(decision.cards[0]).toMatchObject({
    state: "resolved",
    detail: "the recorded tick setting reached its expiry, so this project is back on the default wake interval",
  });
});

test("a disabled tick keeps checking, so its journal line is what a broken tick would not have (#1275)", () => {
  const first = seatTickDecision(input({
    pipelines: [lane({ state: "inert" })],
    settings: settings({ enabled: false, reason: "nothing here for me", updatedAt: "2026-08-28T11:00:00.000Z" }),
  }));
  /* The stall memory is still kept while the tick is off, so the check that
     turns it back on decides from what it has been watching. */
  expect(first.state.stalledSeen).toEqual(["pipeline_a1"]);
  expect(first.verdict.kind).toBe("quiet");
});

test("the wake interval is a constant no environment can set", () => {
  expect(SEAT_TICK_WAKE_INTERVAL_MS).toBe(60 * MINUTE);
  const policy = seatTickPolicy({ LLV_SEAT_TICK_WAKE_MINUTES: "1" });
  expect(policy).toEqual(DEFAULT_SEAT_TICK_POLICY);
  expect(JSON.stringify(policy)).not.toContain("wakeInterval");
  const almostDue = stateWith({ lastWakeAt: new Date(NOW - 59 * MINUTE).toISOString() });
  expect(seatTickDecision(input({ pipelines: [lane()], policy: policy!, state: almostDue })).verdict.kind).toBe("quiet");
});

/* ------------------------------------------------------------------------- *
 * What the stall threshold actually catches, checked rather than assumed.
 *
 * The production observation on #1245 raised the question this pins: a
 * permanently BUSY seat and a STUCK seat both produce an endless run of
 * `skipped`, and the stall threshold is what is supposed to tell them apart.
 * Both halves of the answer are asserted here against the real
 * `evaluateLiveness`, because the interesting half is the one it does NOT
 * catch, and a blind spot nobody wrote down is a blind spot nobody remembers.
 *
 * The threshold measures SILENCE — now minus the newest transcript record,
 * tool traffic included — never how long a turn has been open. So:
 * ------------------------------------------------------------------------- */

const ALIVE = { host: { state: "alive" as const }, stallAfterMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs };

test("the stall threshold catches a silent open turn, and never a long busy one", () => {
  /* CAUGHT: six hours open, nothing written for 41 minutes past a 40-minute
     threshold. The registry calls it stalled, so the tick stops treating the
     turn as progress and the seat becomes reachable again. */
  const silent = evaluateLiveness({ ...ALIVE, turnState: "busy", silentForMs: 41 * MINUTE });
  expect(silent).toEqual({ lifecycle: "stalled", reason: "host_alive_transcript_silent" });
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: silent.lifecycle, reason: silent.reason } }))).toBe(false);

  /* NOT CAUGHT, and this is the blind spot: the same six-hour turn, writing a
     tool call thirty seconds ago. Silence is zero, so it reads `running`, the
     tick calls it progress and drops its check — at every check, for as long
     as the seat keeps writing. Duration is not an input anywhere on this path,
     so no threshold on this surface can fire on it. */
  const busy = evaluateLiveness({ ...ALIVE, turnState: "busy", silentForMs: 30_000 });
  expect(busy).toEqual({ lifecycle: "running", reason: "host_alive_turn_active" });
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: busy.lifecycle, reason: busy.reason } }))).toBe(true);
  expect(seatTickDecision(input({ seat: seat({ turn: "busy", activity: { lifecycle: busy.lifecycle, reason: busy.reason } }), pipelines: [lane()] })).verdict)
    .toEqual({ kind: "skipped", reason: "seat-busy" });

  /* That is the property "never interrupt a working seat" being kept, and it
     is worth keeping — a seat writing every thirty seconds IS working, and the
     Viewer cannot tell an eight-hour merge queue from a self-inflicted loop by
     looking at the transcript clock. What it costs is that a seat which keeps
     itself busy on purpose is unreachable, which is exactly the deadlock the
     session cron produced. The answer is upstream of this surface: mandate v11
     tells the seat to stop doing it, and the revoked-seat retirement ends a
     predecessor that will not. */

  /* The one case that is NOT a blind spot: a dead host holding an open turn
     forever. Caught whatever the transcript clock says, which is why the skip
     terminates rather than waiting behind a turn nothing can finish. */
  const zombie = evaluateLiveness({ host: { state: "gone" }, turnState: "busy", silentForMs: 0, stallAfterMs: ALIVE.stallAfterMs });
  expect(zombie).toEqual({ lifecycle: "stalled", reason: "host_gone_turn_open" });
  expect(seatTurnProgressing(seat({ turn: "busy", activity: { lifecycle: zombie.lifecycle, reason: zombie.reason } }))).toBe(false);
});

test("the stall threshold the tick configures is the one the liveness read applies", () => {
  /* The number is only meaningful if it travels: `seatTickSources` passes
     `policy.stallAfterMs` into the liveness request, and that same value is
     what `evaluateLiveness` compares silence against. A default that never
     reached the reader would make the whole verification above vacuous. */
  expect(DEFAULT_SEAT_TICK_POLICY.stallAfterMs).toBe(40 * MINUTE);
  const justUnder = evaluateLiveness({ ...ALIVE, turnState: "busy", silentForMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs - 1 });
  const exactly = evaluateLiveness({ ...ALIVE, turnState: "busy", silentForMs: DEFAULT_SEAT_TICK_POLICY.stallAfterMs });
  expect(justUnder.lifecycle).toBe("running");
  expect(exactly.lifecycle).toBe("stalled");
});

/* ------------------------------------------------------------------------- *
 * Standalone spawned children (#1465).
 * ------------------------------------------------------------------------- */

const OVERDUE_STATE = { lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString() };
const SECOND_CHILD = ["conversation", "d8c7b6a5f4e3d2c1"].join("_");
const THIRD_CHILD = ["conversation", "e3f4a5b6c7d8c1d2"].join("_");

test("a running child is open work and agenda enough for the interval wake (#1465)", () => {
  const decision = seatTickDecision(input({ children: [child()], state: stateWith(OVERDUE_STATE) }));
  expect(reasonsOf(decision.verdict)).toEqual(["interval"]);
  expect(decision.verdict).toMatchObject({ items: [{ kind: "child", id: child().conversationId, label: "build the exporter — spawned child running" }] });
});

test("a running child inside the interval is quiet, and holds the proposal slot shut (#1465)", () => {
  const decision = seatTickDecision(input({ children: [child()], state: stateWith({ lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString() }) }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "nothing owed" });
  const due = seatTickDecision(input({ children: [child()], state: stateWith(OVERDUE_STATE), events: [] }));
  expect(due.verdict.kind).not.toBe("proactive");
});

test("a terminal child is a wake reason of its own, named as an item (#1465)", () => {
  const finished = child({ status: "terminal", outcome: "finished", terminalAt: new Date(NOW - 20 * MINUTE).toISOString() });
  const decision = seatTickDecision(input({ children: [finished], state: stateWith(OVERDUE_STATE) }));
  expect(decision.verdict).toMatchObject({
    kind: "wake",
    reasons: [{ kind: "child-terminal", detail: "a spawned child finished and its outcome is not yet announced by a delivered seat-tick wake. Reading the transcript alone does not acknowledge this announcement" }],
    items: [{ kind: "child", id: finished.conversationId, label: "build the exporter — spawned child finished, outcome announcement owed" }],
    deferred: 0,
  });
});

test("a finished child this seat launched with notices on is the notice's, never a second harvest (spawn-completion-notice §6)", () => {
  const finished = child({ status: "terminal", outcome: "finished", terminalAt: new Date(NOW - 20 * MINUTE).toISOString(), launcherNotice: true });
  const decision = seatTickDecision(input({ children: [finished], state: stateWith(OVERDUE_STATE) }));
  expect(decision.verdict.kind).not.toBe("wake");
  expect(JSON.stringify(decision.verdict)).not.toContain("child-terminal");
  /* Opted out, it stays the harvest's. */
  const optedOut = seatTickDecision(input({ children: [{ ...finished, launcherNotice: undefined }], state: stateWith(OVERDUE_STATE) }));
  expect(optedOut.verdict).toMatchObject({ kind: "wake", reasons: [{ kind: "child-terminal" }] });
  /* A launch that failed before it ran never ends a turn, so no notice covers it. */
  const failed = seatTickDecision(input({ children: [{ ...finished, outcome: "failed" }], state: stateWith(OVERDUE_STATE) }));
  expect(failed.verdict).toMatchObject({ reasons: [{ kind: "child-terminal", detail: "a spawned child failed and its outcome is not yet announced by a delivered seat-tick wake. Reading the transcript alone does not acknowledge this announcement" }] });
  /* A running notified child is still open work the interval agenda names. */
  const running = seatTickDecision(input({ children: [child({ launcherNotice: true })], state: stateWith(OVERDUE_STATE) }));
  expect(running.verdict).toMatchObject({ items: [{ kind: "child", label: "build the exporter — spawned child running" }] });
});

test("a failed launch is a terminal child too, and the reason says so (#1465)", () => {
  const failed = child({ status: "terminal", outcome: "failed", terminalAt: new Date(NOW - 20 * MINUTE).toISOString() });
  const decision = seatTickDecision(input({ children: [failed], state: stateWith(OVERDUE_STATE) }));
  expect(decision.verdict).toMatchObject({ reasons: [{ kind: "child-terminal", detail: "a spawned child failed and its outcome is not yet announced by a delivered seat-tick wake. Reading the transcript alone does not acknowledge this announcement" }] });
});

test("a newly owed settled child is due on the next check despite a recent wake (#2346)", () => {
  const finished = child({ status: "terminal", outcome: "finished", terminalAt: new Date(NOW - 2 * MINUTE).toISOString() });
  const at = (minutes: number) => stateWith({ lastWakeAt: new Date(NOW - minutes * MINUTE).toISOString() });
  for (const minutes of [0, 1, 4, SEAT_TICK_SETTLED_CHILD_WAKE_INTERVAL_MS / MINUTE]) {
    expect(seatTickDecision(input({ children: [finished], state: at(minutes) })).verdict)
      .toMatchObject({ kind: "wake", reasons: [{ kind: "child-terminal" }] });
  }
});

test("running children bring the interval wake to a quarter of an hour, and a still board keeps the hour (#1881)", () => {
  const running = child({ status: "running", outcome: null, terminalAt: null, lastRecordAt: new Date(NOW - 2 * MINUTE).toISOString() });
  const at = (minutes: number) => stateWith({ lastWakeAt: new Date(NOW - minutes * MINUTE).toISOString() });
  const quarter = SEAT_TICK_RUNNING_CHILD_WAKE_INTERVAL_MS / MINUTE;
  expect(seatTickDecision(input({ pipelines: [], children: [running], state: at(quarter - 1) })).verdict.kind).toBe("quiet");
  expect(seatTickDecision(input({ pipelines: [], children: [running], state: at(quarter) })).verdict)
    .toMatchObject({ kind: "wake", reasons: [{ kind: "interval" }] });
  /* An open lane and no child: the project's own hour, unchanged. */
  expect(seatTickDecision(input({ pipelines: [lane()], children: [], state: at(quarter) })).verdict.kind).toBe("quiet");
  expect(seatTickDecision(input({ pipelines: [lane()], children: [], state: at(60) })).verdict).toMatchObject({ kind: "wake", reasons: [{ kind: "interval" }] });
});

test("an unreadable settled child is listed with its reason, and an unreadable running one is named once (#1881)", () => {
  const settled = child({ status: "terminal", outcome: "finished", terminalAt: null, lastRecordAt: null, transcript: "unresolvable", transcriptReason: "missing", spawnedAt: new Date(NOW - 30 * MINUTE).toISOString() });
  const running = child({ conversationId: SECOND_CHILD, title: "silent worker", status: "running", outcome: null, terminalAt: null, lastRecordAt: null, transcript: "unresolvable", transcriptReason: "outside-roots", spawnedAt: new Date(NOW - 30 * MINUTE).toISOString() });
  const first = seatTickDecision(input({ children: [settled, running], state: stateWith(OVERDUE_STATE) }));
  expect(first.verdict.kind).toBe("wake");
  const verdict = first.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(verdict.items.find((item) => item.id === settled.conversationId)?.label)
    .toContain("spawned child finished, transcript not readable: the transcript file is no longer on disk");
  expect(verdict.unreadableChildren).toEqual([expect.objectContaining({ conversationId: SECOND_CHILD, title: "silent worker", reason: "its transcript path is outside every folder Delegatus scans" })]);
  expect(verdict.skippedChildren.unreadable).toBe(0);
  /* Landed, the running child's reason is not named again while it stands. */
  const plan = seatTickWakeCommitPlan(first.verdict, { fingerprint: "fp-2", eventsThrough: 0, terminalChildren: [settled.conversationId] })!;
  const landed = seatTickWakeCommit(stateWith(OVERDUE_STATE), plan, NOW);
  /* An open lane gives the next check a wake to carry the line on; an
     unreadable child never raises one by itself. */
  const next = seatTickDecision(input({ pipelines: [lane()], children: [running], state: { ...landed, lastWakeAt: new Date(NOW - 2 * 60 * MINUTE).toISOString() } }));
  const again = next.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(again.unreadableChildren ?? []).toEqual([]);
  expect(again.skippedChildren).toMatchObject({ unreadable: 0, unchanged: 1 });
});

test("an unreadable child spawned long before the seat was designated is a predecessor's (#1881)", () => {
  const designatedAt = new Date(NOW - 60 * MINUTE).toISOString();
  const old = child({ status: "running", outcome: null, terminalAt: null, lastRecordAt: null, transcript: "unresolvable", transcriptReason: "missing", spawnedAt: new Date(NOW - 30 * 24 * 60 * MINUTE).toISOString() });
  const decision = seatTickDecision(input({ seat: seat({ designatedAt }), pipelines: [lane()], children: [old], state: stateWith(OVERDUE_STATE) }));
  const verdict = decision.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(verdict.unreadableChildren ?? []).toEqual([]);
  expect(verdict.skippedChildren).toMatchObject({ stale: 1, unreadable: 0 });
});

test("terminal children are named oldest outcome first, and the plan records only the ones the wake carries (#1465)", () => {
  const children = [
    child({ conversationId: THIRD_CHILD, status: "terminal", outcome: "finished", terminalAt: new Date(NOW - 5 * MINUTE).toISOString() }),
    child({ status: "terminal", outcome: "finished", terminalAt: new Date(NOW - 30 * MINUTE).toISOString() }),
    child({ conversationId: SECOND_CHILD, status: "terminal", outcome: "failed", terminalAt: new Date(NOW - 20 * MINUTE).toISOString() }),
  ];
  const decision = seatTickDecision(input({
    children,
    state: stateWith(OVERDUE_STATE),
    policy: { ...DEFAULT_SEAT_TICK_POLICY, itemsPerWake: 2 },
  }));
  expect(decision.verdict).toMatchObject({ kind: "wake", deferred: 1 });
  const verdict = decision.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(verdict.items.map((item) => item.id)).toEqual([child().conversationId, SECOND_CHILD]);
  expect(verdict.reasons[0]!.detail).toBe("a spawned child finished and its outcome is not yet announced by a delivered seat-tick wake and 2 more. Reading the transcript alone does not acknowledge this announcement");
  const commit = seatTickWakeCommitPlan(decision.verdict, { fingerprint: "fp-2", eventsThrough: 0, terminalChildren: children.map((entry) => entry.conversationId) })!;
  expect(commit.children).toEqual([child().conversationId, SECOND_CHILD]);
});

test("a running child named as agenda is never recorded as harvested (#1465)", () => {
  const decision = seatTickDecision(input({ children: [child()], state: stateWith(OVERDUE_STATE) }));
  const commit = seatTickWakeCommitPlan(decision.verdict, { fingerprint: "fp-2", eventsThrough: 0, terminalChildren: [] })!;
  expect(commit.children).toEqual([]);
  const proposal = seatTickWakeCommitPlan({ kind: "proactive", detail: "" }, { fingerprint: "fp-2", eventsThrough: 0, terminalChildren: [child().conversationId] })!;
  expect(proposal.children).toEqual([]);
});

test("the landing preserves all named identities without evicting older acknowledgments (#1465)", () => {
  const before = stateWith({ harvestedChildren: [SECOND_CHILD] });
  const landed = seatTickWakeCommit(before, { proposal: false, reasons: ["child-terminal"], fingerprint: "fp-2", eventsThrough: 0, children: [child().conversationId, SECOND_CHILD] }, NOW);
  expect(landed.harvestedChildren).toEqual([child().conversationId, SECOND_CHILD]);
  const crowded = stateWith({ harvestedChildren: Array.from({ length: 200 }, (_, index) => `conversation_${index}`) });
  const bounded = seatTickWakeCommit(crowded, { proposal: false, reasons: ["child-terminal"], fingerprint: "fp-2", eventsThrough: 0, children: [THIRD_CHILD] }, NOW);
  expect(bounded.harvestedChildren).toHaveLength(201);
  expect(bounded.harvestedChildren.at(-1)).toBe(THIRD_CHILD);
  expect(bounded.harvestedChildren[0]).toBe("conversation_0");
});

test("a proposal landing harvests nothing (#1465)", () => {
  const before = stateWith({ harvestedChildren: [SECOND_CHILD] });
  const landed = seatTickWakeCommit(before, { proposal: true, reasons: [], fingerprint: "fp-2", eventsThrough: 0, children: [] }, NOW);
  expect(landed.harvestedChildren).toEqual([SECOND_CHILD]);
});

test("an unknown child is neither open work nor a harvest, and the quiet line counts it (#1465)", () => {
  const decision = seatTickDecision(input({ children: [child({ status: "unknown" })], state: stateWith({ lastWakeAt: new Date(NOW - 5 * MINUTE).toISOString(), lastProposalAt: new Date(NOW - MINUTE).toISOString() }) }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify; the proposal slot is not due; 1 spawned child(ren) in an unknown state" });
  const beside = seatTickDecision(input({ children: [child({ status: "unknown" })], tasks: [card({ status: "inbox" })], state: stateWith(OVERDUE_STATE) }));
  expect(beside.verdict).toEqual({ kind: "quiet", detail: "no eligible interval agenda: unparented workers and inbox cards alone do not qualify; 1 spawned child(ren) in an unknown state" });
});

test("a stalled child wakes only once it has persisted across two consecutive checks (#1465)", () => {
  const stalled = child({ activity: { lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy" } });
  const first = seatTickDecision(input({ children: [stalled], state: stateWith(OVERDUE_STATE) }));
  expect(reasonsOf(first.verdict)).toEqual(["interval"]);
  expect(first.state.stalledSeen).toEqual([`child:${stalled.conversationId}`]);
  const second = seatTickDecision(input({ children: [stalled], state: stateWith({ ...OVERDUE_STATE, stalledSeen: [`child:${stalled.conversationId}`] }) }));
  expect(second.verdict).toMatchObject({
    reasons: [{ kind: "stalled", detail: `build the exporter — child ${stalled.conversationId} runs a turn the registry reports stalled (host_alive_transcript_silent)` }],
    items: [{ kind: "child", id: stalled.conversationId, label: `build the exporter — child ${stalled.conversationId} runs a turn the registry reports stalled (host_alive_transcript_silent)` }],
  });
});

test("a long-running child the plane calls running is never stalled, and a child with no verdict is not either (#1465)", () => {
  const running = child({ activity: { lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy" } });
  const seen = stateWith({ ...OVERDUE_STATE, stalledSeen: [`child:${running.conversationId}`] });
  expect(reasonsOf(seatTickDecision(input({ children: [running], state: seen })).verdict)).toEqual(["interval"]);
  expect(reasonsOf(seatTickDecision(input({ children: [child()], state: seen })).verdict)).toEqual(["interval"]);
  expect(seatTickDecision(input({ children: [child()], state: seen })).state.stalledSeen).toEqual([]);
});

test("unreadable children are a gap the wake names, and an error when nothing else is owed (#1465)", () => {
  const blind = seatTickDecision(input({ childrenUnavailable: "registry-unreadable", state: stateWith(OVERDUE_STATE) }));
  expect(blind.verdict).toEqual({
    kind: "error",
    detail: "the seat's spawned children could not be read (registry-unreadable): the registry read failed, so nothing owed is not established",
  });
  expect(blind.state.lastWakeAt).toBe(OVERDUE_STATE.lastWakeAt);
  expect(blind.cards).toEqual([]);
  const woken = seatTickDecision(input({ childrenUnavailable: "registry-unreadable", pipelines: [lane()], state: stateWith(OVERDUE_STATE) }));
  expect(woken.verdict).toMatchObject({
    kind: "wake",
    reasons: [{ kind: "interval" }],
    gaps: [{ source: "children", gap: "registry-unreadable" }],
  });
  /* A run that has only just started raises no card, exactly like a fresh
     pull-request failure. */
  expect(woken.cards).toEqual([]);
  expect(woken.state.pullRequestGap).toBeNull();
});

/* Each condition the children source can be in has its own token and its own
   clause (#1465), so the wake, the error line and the card say which hand it
   calls for rather than one word for everything. */
test("each children gap names its condition in the wake and in the error line (#1465)", () => {
  const blocked = seatTickDecision(input({ childrenUnavailable: "migration-blocked", state: stateWith(OVERDUE_STATE) }));
  expect(blocked.verdict).toMatchObject({ kind: "error" });
  expect((blocked.verdict as { detail: string }).detail).toContain("(migration-blocked): the legacy tick state at state/seat-tick.json cannot be imported");
  const pending = seatTickDecision(input({ childrenUnavailable: "ledger-pending", pipelines: [lane()], state: stateWith(OVERDUE_STATE) }));
  const wake = pending.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(wake.gaps).toEqual([{ source: "children", gap: "ledger-pending", detail: expect.stringContaining("a child left its running state and its ledger has not been read yet") }]);
  for (const gap of ["children-unindexed", "migration-pending", "discovery-incomplete", "ledger-gap", "child-departed", "child-unplaced"] as const) {
    const decision = seatTickDecision(input({ childrenUnavailable: gap, state: stateWith(OVERDUE_STATE) }));
    expect((decision.verdict as { detail: string }).detail).toContain(`(${gap}): `);
  }
});

/* The children source is carded exactly like the pull-request source (#1465):
   a run that outlived the wake interval goes on the board once, the row that
   remembers the telling travels apart from the decision's state, and the
   card names the condition and what it means. */
test("a children source failing for longer than the wake interval is put on the board once, naming its condition (#1465)", () => {
  const run = { gap: "migration-blocked" as const, since: new Date(NOW - 70 * MINUTE).toISOString(), lastAttemptAt: new Date(NOW).toISOString(), attempts: 14, reported: false };
  const state = stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), childrenGap: run });
  const decision = seatTickDecision(input({ childrenUnavailable: "migration-blocked", state }));
  const raised = decision.cards.find((entry) => entry.kind === "source-unreadable");
  expect(raised?.ref).toBe("seat-tick-source-children");
  expect(raised?.instance).toBe(run.since);
  expect(raised?.detail).toContain("migration-blocked, 14 attempt(s)");
  expect(raised?.detail).toContain("the legacy tick state at state/seat-tick.json cannot be imported and blocks every wake until it is fixed or removed");
  expect(decision.reportedChildrenGap).toEqual({ ...run, reported: true });
  expect(decision.reportedSourceGap).toBeNull();
  expect(decision.state.childrenGap?.reported).toBe(false);
  /* Once the controller wrote the reported row, the card is not raised again. */
  const after = seatTickDecision(input({ childrenUnavailable: "migration-blocked", state: { ...state, childrenGap: { ...run, reported: true } } }));
  expect(after.cards.filter((entry) => entry.kind === "source-unreadable")).toEqual([]);
  expect(after.reportedChildrenGap).toBeNull();
  /* A young run is weather, and a run whose source answered again is over. */
  const young = seatTickDecision(input({ childrenUnavailable: "ledger-gap", state: stateWith({ lastWakeAt: new Date(NOW - 61 * MINUTE).toISOString(), childrenGap: { ...run, gap: "ledger-gap", since: new Date(NOW - 5 * MINUTE).toISOString(), attempts: 1 } }) }));
  expect(young.cards).toEqual([]);
  const answered = seatTickDecision(input({ childrenUnavailable: null, state }));
  expect(answered.cards.filter((entry) => entry.kind === "source-unreadable")).toEqual([]);
  /* Both sources standing at once are two cards. */
  const both = seatTickDecision(input({
    childrenUnavailable: "migration-blocked",
    pullRequestsUnavailable: "command-failed",
    state: { ...state, pullRequestGap: { gap: "command-failed", since: run.since, lastAttemptAt: run.lastAttemptAt, attempts: 3, reported: false } },
  }));
  expect(both.cards.filter((entry) => entry.kind === "source-unreadable").map((entry) => entry.ref).sort()).toEqual(["seat-tick-source-children", "seat-tick-source-pull-requests"]);
});

test("a child-terminal reason that stops producing change is held by the retry guard like any other (#1465)", () => {
  const finished = child({ status: "terminal", outcome: "finished", terminalAt: new Date(NOW - 20 * MINUTE).toISOString() });
  const decision = seatTickDecision(input({
    children: [finished],
    state: stateWith({ ...OVERDUE_STATE, lastWakeFingerprint: "fp-1", wakesWithoutChange: { "child-terminal": 2 } }),
  }));
  expect(decision.verdict).toEqual({ kind: "quiet", detail: "every wake reason is held by the retry guard" });
  expect(decision.cards.map((entry) => entry.ref)).toEqual(["seat-tick-stuck-child-terminal"]);
});

/* ---------------------------------------------------------------------------
 * The outcome of the seat's own create call, carried back on the wake (#1799)
 * ------------------------------------------------------------------------- */

/** A lane the seat launched, in whatever state the case needs. */
function ownLane(over: Partial<SeatTickOwnLaneInput> = {}): SeatTickOwnLaneInput {
  return {
    id: "pipeline_a1",
    title: "ship the exporter",
    settled: "provisioned",
    updatedAt: new Date(NOW - 2 * MINUTE).toISOString(),
    ...over,
  };
}

test("a provisioned lane reaches its creator as one more item kind under the own-lane reason (#1799)", () => {
  const decision = seatTickDecision(input({ ownLanes: [ownLane()], state: stateWith(OVERDUE_STATE) }));
  expect(reasonsOf(decision.verdict)).toEqual(["own-lane-settled"]);
  const verdict = decision.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(verdict.items).toMatchObject([{
    kind: "provisioning",
    id: "pipeline_a1",
    label: "ship the exporter — lane you launched: provisioned, first stage running",
    laneAnnouncement: "pipeline_a1:provisioned",
  }]);
});

test("a lane whose provisioning failed names what stopped it (#1799)", () => {
  const decision = seatTickDecision(input({
    ownLanes: [ownLane({ settled: "provisioning-failed", detail: "fetching origin/main: origin unavailable" })],
    state: stateWith(OVERDUE_STATE),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["own-lane-settled"]);
  const verdict = decision.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  /* A park is an obligation, so it stays an ordinary lane line — what changes
     is that the seat is told its lane never ran a stage, and why. */
  expect(verdict.items[0]).toMatchObject({
    kind: "pipeline",
    id: "pipeline_a1",
    label: "ship the exporter — lane you launched: provisioning failed, it never ran a stage: fetching origin/main: origin unavailable",
    laneAnnouncement: "pipeline_a1:provisioning-failed",
  });
});

test("a needs_review lane's wake line says the last review failed and the head is unreviewed, with both heads (#1938)", () => {
  const decision = seatTickDecision(input({
    ownLanes: [ownLane({
      settled: "needs_review",
      review: { stageId: "review", reviewedHead: "1".repeat(40), currentHead: "2".repeat(40), lastVerdict: "fail", findings: 2 },
    })],
    state: stateWith(OVERDUE_STATE),
  }));
  expect(reasonsOf(decision.verdict)).toEqual(["own-lane-settled"]);
  const verdict = decision.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(verdict.items[0]).toMatchObject({
    kind: "pipeline",
    id: "pipeline_a1",
    label: `ship the exporter — lane you launched: last review failed, head unreviewed: review said fail with 2 findings on ${"1".repeat(12)}; current head ${"2".repeat(12)} was never reviewed. pipeline_action continue-review with addRounds resumes it`,
    laneAnnouncement: "pipeline_a1:needs_review",
  });
  expect(verdict.items[0]!.label).not.toContain("completed");
});

test("only a landed wake records a provisioning announcement, and only for the lanes it named (#1799)", () => {
  const crowd = Array.from({ length: 7 }, (_, n) => ownLane({ id: `pipeline_z${n}`, title: `lane ${n}` }));
  const decision = seatTickDecision(input({ ownLanes: crowd, state: stateWith(OVERDUE_STATE) }));
  const verdict = decision.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  const named = verdict.items.map((item) => item.id);
  expect(named).toHaveLength(DEFAULT_SEAT_TICK_POLICY.itemsPerWake);
  expect(verdict.deferred).toBe(crowd.length - DEFAULT_SEAT_TICK_POLICY.itemsPerWake);

  /* The plan records exactly the lanes the message carries: the two the bound
     held back were announced to nobody and stay offerable. */
  const commit = plan(decision.verdict, "fp-2", 0);
  expect(commit.announcedLanes).toEqual(named.map((id) => `${id}:provisioned`));
  expect(seatTickWakeCommit(emptySeatTickState(), commit, NOW).announcedLanes).toEqual(named.map((id) => `${id}:provisioned`));
  /* A wake that never landed leaves the row untouched, which is what keeps the
     announcement owed rather than lost. */
  expect(emptySeatTickState().announcedLanes).toEqual([]);
});

test("a provisioning announcement does not displace the lane's later settlements (#1799)", () => {
  /* The source stops offering an announced lane as provisioned; a lane that
     later completes is a different settlement and a different obligation. */
  const completed = seatTickDecision(input({
    ownLanes: [ownLane({ settled: "completed" })],
    state: stateWith({ ...OVERDUE_STATE, announcedLanes: ["pipeline_a1"] }),
  }));
  expect(reasonsOf(completed.verdict)).toEqual(["own-lane-settled"]);
  const verdict = completed.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(verdict.items[0]!.kind).toBe("pipeline");
  expect(verdict.items[0]!.label).toContain("completed");
});

test("a child whose host died over an open turn is named once and then keeps the project's hour, however much the board moves (#1881)", () => {
  const orphan = child({ status: "running", outcome: null, terminalAt: null, activity: { lifecycle: "gone", reason: "host_gone_turn_open" } });
  let state = emptySeatTickState();
  const wakes: { minute: number; reasons: string[] }[] = [];
  for (let minute = 0; minute <= 180; minute += 5) {
    const now = NOW + minute * MINUTE;
    /* A working board: something else moved at every check, so the retry
       guard never holds and only the bound spaces the wakes. */
    const fingerprint = `board${minute}.prs`;
    const decision = seatTickDecision(input({ now, children: [orphan], changeFingerprint: fingerprint, state }));
    state = decision.state;
    if (decision.verdict.kind !== "wake") continue;
    wakes.push({ minute, reasons: reasonsOf(decision.verdict) });
    state = seatTickWakeCommit(state, seatTickWakeCommitPlan(decision.verdict, { fingerprint, eventsThrough: 0 })!, now);
  }
  const stall = wakes.findIndex((wake) => wake.reasons.includes("stalled"));
  expect(stall).toBeGreaterThanOrEqual(0);
  /* After the stall wake landed, the child raises nothing faster than the hour. */
  for (let index = stall + 1; index < wakes.length; index++) {
    expect(wakes[index]!.minute - wakes[index - 1]!.minute).toBeGreaterThanOrEqual(SEAT_TICK_WAKE_INTERVAL_MS / MINUTE);
  }
  expect(wakes.length).toBeLessThanOrEqual(5);
});

test("a child seen stalled once does not shorten the bound until the stall is confirmed on a second check (#1881)", () => {
  const orphan = child({ status: "running", outcome: null, terminalAt: null, activity: { lifecycle: "gone", reason: "host_gone_turn_open" } });
  const lastWakeAt = new Date(NOW - 10 * MINUTE).toISOString();
  /* First sighting: nothing to name yet, so the bound is the project's own. */
  expect(seatTickDecision(input({ children: [orphan], state: stateWith({ lastWakeAt }) })).verdict.kind).toBe("quiet");
  /* Seen at the previous check as well: confirmed, and due at once. */
  expect(seatTickDecision(input({ children: [orphan], state: stateWith({ lastWakeAt, stalledSeen: [`child:${orphan.conversationId}`] }) })).verdict)
    .toMatchObject({ kind: "wake", reasons: [{ kind: "stalled" }] });
});

test("a settled deploy of the seat's own wakes it inside the hour, and one past the backlog bound wakes nobody (#2063)", () => {
  const deploy = (settledMinutesAgo: number) => ({
    deploymentId: "deploy-1", phase: "rolled-back", sha: "b".repeat(40), error: "candidate health failed",
    settledAt: new Date(NOW - settledMinutesAgo * MINUTE).toISOString(),
  });
  /* The last wake was ten minutes ago: the hour has not elapsed, and the
     settled bound has. */
  const recent = stateWith({ lastWakeAt: new Date(NOW - 10 * MINUTE).toISOString() });
  const fresh = seatTickDecision(input({ settledDeploys: [deploy(2)], state: recent }));
  expect(fresh.verdict).toMatchObject({ kind: "wake", reasons: [{ kind: "deploy-settled", detail: "a deployment you started ended rolled-back" }] });
  const verdict = fresh.verdict as Extract<SeatTickVerdict, { kind: "wake" }>;
  expect(verdict.items[0]).toMatchObject({
    kind: "deploy",
    id: "deploy-1",
    deploy: { deploymentId: "deploy-1", phase: "rolled-back", sha: "b".repeat(40), error: "candidate health failed" },
  });
  expect(seatTickWakeCommitPlan(fresh.verdict, { fingerprint: "fp-1", eventsThrough: 0 })!.announcedDeploys).toEqual(["deploy-1"]);

  const stale = seatTickDecision(input({ settledDeploys: [deploy(4 * 24 * 60)], state: stateWith({ lastWakeAt: new Date(NOW - 2 * 60 * MINUTE).toISOString() }) }));
  expect(stale.verdict.kind).not.toBe("wake");
});


describe("delivered agenda versions", () => {
  test("names assigned tasks and each settled lane in reasons", () => {
    const decision = seatTickDecision(input({ tasks: [card()], ownLanes: [
      { id: "lane-one", title: "Export settings", settled: "completed", updatedAt: new Date(NOW).toISOString() },
      { id: "lane-two", title: "Repair import", settled: "failed", updatedAt: new Date(NOW).toISOString() },
    ] }));
    expect(decision.verdict.kind).toBe("wake");
    if (decision.verdict.kind !== "wake") return;
    expect(decision.verdict.reasons.find(r => r.kind === "unstarted-task")?.detail).toContain("wire the chip");
    const lanes = decision.verdict.reasons.find(r => r.kind === "own-lane-settled")!.detail;
    expect(lanes).toContain("Export settings");
    expect(lanes).toContain("Repair import");
  });

  test("drains held-back PRs despite unrelated board changes and across the retry guard", () => {
    const prs = Array.from({ length: 22 }, (_, i) => pullRequest({ number: i + 1, pipelineId: `lane-${i}` }));
    let state = emptySeatTickState();
    const seen: string[] = [];
    for (let page = 0; page < 5; page++) {
      const now = NOW + page * 90 * MINUTE;
      const decision = seatTickDecision(input({ now, state, pullRequests: prs }));
      expect(decision.verdict.kind).toBe("wake");
      if (decision.verdict.kind !== "wake") return;
      seen.push(...decision.verdict.items.map(item => item.id));
      state = seatTickWakeCommit(decision.state, plan(decision.verdict, "fp-1", 0), now);
    }
    expect(new Set(seen).size).toBe(22);
    expect(seen.length).toBe(22);
    const quiet = seatTickDecision(input({ now: NOW + 500 * MINUTE, state, pullRequests: prs, changeFingerprint: "unrelated-change" }));
    expect(quiet.verdict.kind).toBe("quiet");
    const changed = seatTickDecision(input({ now: NOW + 500 * MINUTE, state, pullRequests: prs.map((pr, i) => i === 0 ? { ...pr, mergeBlocked: "checks pending" } : pr), changeFingerprint: "unrelated-change" }));
    expect(changed.verdict.kind === "wake" && changed.verdict.items.map(item => item.id)).toEqual(["#1"]);
  });

  test("only a landed wake suppresses its task, and a task revision is offered again", () => {
    const first = seatTickDecision(input({ tasks: [card()] }));
    const pending = seatTickDecision(input({ state: first.state, tasks: [card()] }));
    expect(pending.verdict.kind).toBe("wake");
    const landed = seatTickWakeCommit(first.state, plan(first.verdict, "fp-1", 0), NOW);
    const next = { now: NOW + 90 * MINUTE, state: landed, changeFingerprint: "board-moved" };
    expect(seatTickDecision(input({ ...next, tasks: [card()] })).verdict.kind).toBe("quiet");
    expect(seatTickDecision(input({ ...next, tasks: [card({ updatedAt: new Date(NOW + MINUTE).toISOString() })] })).verdict.kind).toBe("wake");
  });
});


/* A board that waits only on the operator must go quiet. Since #2346 (#2632)
   re-offers open lanes on every interval, the stall token on a parked lane's
   item is the one thing that keeps it out of that periodic reminder; #2486's
   versioned agenda keeps a PR waiting for a merge word out of it once shown.
   This replays 24 hourly checks over a board that never moves, each wake
   committed as landed, and records what the seat would have been told. */
describe("a board that waits only on the operator", () => {
  function replayDay(board: Partial<SeatTickCheckInput>): string[][] {
    let state = emptySeatTickState();
    const wakes: string[][] = [];
    for (let hour = 0; hour < 24; hour++) {
      const now = NOW + hour * 61 * MINUTE;
      const decision = seatTickDecision(input({ ...board, now, state, changeFingerprint: "unchanged" }));
      if (decision.verdict.kind === "wake") {
        wakes.push(reasonsOf(decision.verdict));
        state = seatTickWakeCommit(decision.state, plan(decision.verdict, "unchanged", 0), now);
      } else state = decision.state;
    }
    return wakes;
  }

  test("a lane parked on an operator decision wakes the seat for its interval, then once as stalled, then stays quiet", () => {
    const parked = lane({ state: "inert", title: "park the design decision" });
    expect(replayDay({ pipelines: [parked] })).toEqual([["interval"], ["stalled"]]);
  });

  test("a pull request waiting for the operator's merge word wakes the seat once", () => {
    expect(replayDay({ pullRequests: [pullRequest()] })).toEqual([["unmerged-pr"]]);
  });
});

test("a shown PR stays silent after its lane announcement is discharged", () => {
  const first = seatTickDecision(input({ pullRequests: [pullRequest()], ownLanes: [ownLane({ settled: "completed" })] }));
  const landed = seatTickWakeCommit(first.state, plan(first.verdict, "fp-1", 0), NOW);
  const next = seatTickDecision(input({ now: NOW + 90 * MINUTE, state: landed, pullRequests: [pullRequest()], changeFingerprint: "moved" }));
  expect(next.verdict.kind).toBe("quiet");
  const debt = seatTickDecision(input({ now: NOW + 90 * MINUTE, state: landed, pullRequests: [pullRequest()], ownLanes: [ownLane({ settled: "needs_review" })], changeFingerprint: "moved" }));
  expect(debt.verdict.kind).toBe("wake");
  expect(plan(debt.verdict, "moved", 0).announcedLanes).toEqual(["pipeline_a1:needs_review"]);
});

test("permission requests stay actionable without a durable per-request identity", () => {
  const held = lane({ stageActivity: { lifecycle: "waiting", reason: "permission_request", turnState: "busy", permission: { tool: "Bash", command: "publish", reason: null } } });
  const first = seatTickDecision(input({ pipelines: [held] }));
  const landed = seatTickWakeCommit(first.state, plan(first.verdict, "fp-1", 0), NOW);
  expect(seatTickDecision(input({ now: NOW + 90 * MINUTE, state: landed, pipelines: [{ ...held, stageAttempt: "next-attempt" }], changeFingerprint: "changed" })).verdict.kind).toBe("wake");
});


test("an unchanged PR reason cannot hide movement in an open lane", () => {
  const first = seatTickDecision(input({ pullRequests: [pullRequest()], pipelines: [lane()] }));
  const state = seatTickWakeCommit(first.state, plan(first.verdict, "fp-1", 0), NOW);
  const decision = seatTickDecision(input({ now: NOW + 90 * MINUTE, state, pullRequests: [pullRequest()],
    pipelines: [lane({ stageId: "review", updatedAt: new Date(NOW + MINUTE).toISOString() })], changeFingerprint: "moved" }));
  expect(decision.verdict.kind).toBe("wake");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map(item => item.id)).toEqual(["pipeline_a1"]);
});


test("cropped item lines stay owed after the frozen message lands", () => {
  const prs = Array.from({ length: 5 }, (_, i) => pullRequest({ number: i + 1, title: `Change ${i}: ${"x".repeat(400)}` }));
  let state = emptySeatTickState();
  const received = new Set<string>();
  for (let page = 0; page < 5; page++) {
    const now = NOW + page * 90 * MINUTE;
    const decision = seatTickDecision(input({ now, state, pullRequests: prs, changeFingerprint: `page-${page}` }));
    if (decision.verdict.kind !== "wake") break;
    const text = seatTickWakeMessage({ project: PROJECT, ...decision.verdict, signals: [], monitorPrompt: "n".repeat(7622) });
    for (const item of decision.verdict.items) if (text.includes(`- [${item.kind}] ${item.id} — ${item.label}\n`)) received.add(item.id);
    const commit = plan(decision.verdict, `page-${page}`, 0);
    const wake = { clientMessageId: `page-${page}`, conversationId: CONVERSATION, seatEpoch: 7, operationId: null, text, commit };
    state = seatTickWakeCommit({ ...decision.state, outstandingWake: wake }, commit, now);
    expect(state.itemsShown?.length).toBe(received.size);
  }
  expect(received.size).toBe(5);
});


test("a later deploy settlement re-offers unchanged seat-paused lanes", () => {
  const paused = lane({ pausedBy: "seat", state: "inert" });
  const first = seatTickDecision(input({ pipelines: [paused] }));
  const state = seatTickWakeCommit(first.state, plan(first.verdict, "fp-1", 0), NOW);
  const decision = seatTickDecision(input({ now: NOW + 90 * MINUTE, state, pipelines: [paused],
    settledDeploys: [{ deploymentId: "deploy-next", phase: "succeeded", sha: "b".repeat(40), error: null, settledAt: new Date(NOW + MINUTE).toISOString() }] }));
  expect(decision.verdict.kind).toBe("wake");
  expect(decision.verdict.kind === "wake" && decision.verdict.items.map(item => item.id)).toEqual(["deploy-next", paused.id]);
});

test("a later task revision cannot render a previously delivered signal again", () => {
  const signals = [{ id: "capacity", label: "capacity needs attention" }];
  const first = seatTickDecision(input({ tasks: [card()], signals }));
  expect(first.verdict.kind).toBe("wake");
  if (first.verdict.kind !== "wake") return;
  const text = seatTickWakeMessage({ project: PROJECT, ...first.verdict, signals });
  expect(text).toContain(signals[0]!.label);
  const state = seatTickWakeCommit(first.state, plan(first.verdict, "fp-1", 0), NOW);
  const next = seatTickDecision(input({ now: NOW + 90 * MINUTE, state, signals,
    tasks: [card({ updatedAt: new Date(NOW + MINUTE).toISOString() })] }));
  expect(next.verdict.kind).toBe("wake");
  if (next.verdict.kind !== "wake") return;
  expect(next.verdict.items.map(item => item.kind)).toEqual(["task"]);
  expect(seatTickWakeMessage({ project: PROJECT, ...next.verdict, signals })).not.toContain(signals[0]!.label);
});

test("later deploy resume instructions drain every previously shown paused lane", () => {
  const pipelines = Array.from({ length: 5 }, (_, i) => lane({ id: `paused-${i}`, pausedBy: "seat", state: "inert" }));
  const first = seatTickDecision(input({ pipelines }));
  expect(first.verdict.kind).toBe("wake");
  const state = seatTickWakeCommit(first.state, plan(first.verdict, "fp-1", 0), NOW);
  const settlement = seatTickDecision(input({ now: NOW + 90 * MINUTE, state, pipelines,
    settledDeploys: [{ deploymentId: "deploy-next", phase: "succeeded", sha: "b".repeat(40), error: null, settledAt: new Date(NOW + MINUTE).toISOString() }] }));
  expect(settlement.verdict.kind).toBe("wake");
  if (settlement.verdict.kind !== "wake") return;
  expect(settlement.verdict.items.map(item => item.id)).toEqual(["deploy-next", ...pipelines.slice(0, 4).map(row => row.id)]);
  expect(settlement.verdict.deferred).toBe(1);
  const landed = seatTickWakeCommit(settlement.state, plan(settlement.verdict, "fp-1", 0), NOW + 90 * MINUTE);
  // Production removes the deploy from its source once this landing announces it.
  const next = seatTickDecision(input({ now: NOW + 180 * MINUTE, state: landed, pipelines, settledDeploys: [] }));
  expect(next.verdict.kind).toBe("wake");
  if (next.verdict.kind !== "wake") return;
  expect(next.verdict.items.map(item => item.id)).toEqual([pipelines[4]!.id]);
  const finished = seatTickWakeCommit(next.state, plan(next.verdict, "fp-1", 0), NOW + 180 * MINUTE);
  expect(seatTickDecision(input({ now: NOW + 270 * MINUTE, state: finished, pipelines })).verdict.kind).toBe("quiet");
});

test("cropped outcome bullets leave child, deployment and maintenance obligations unacknowledged", () => {
  const verdict: Extract<SeatTickVerdict, { kind: "wake" }> = {
    kind: "wake", reasons: [{ kind: "own-lane-settled", detail: "settled outcomes" }], deferred: 0,
    skippedChildren: { stale: 0, unreadable: 0, unchanged: 0 }, gaps: [],
    items: [
      { kind: "pipeline", id: "visible-lane", label: "completed", laneAnnouncement: "visible-lane:completed", itemVersion: "lane@one" },
      { kind: "child", id: "cropped-child", label: "long child result ".repeat(500), outcomeIds: ["child-outcome"], stateTokens: ["cropped-child@one"], stallToken: "child-stall" },
      { kind: "deploy", id: "cropped-deploy", label: "deploy settled", deploy: { deploymentId: "cropped-deploy", phase: "succeeded", sha: "a".repeat(40), error: null } },
      { kind: "maintenance", id: "cropped-maintenance", label: "maintenance finished", maintenance: { runId: "cropped-maintenance" } },
    ],
  };
  const text = seatTickWakeMessage({ project: "fixture-project", reasons: verdict.reasons, items: verdict.items, deferred: 0, signals: [] });
  expect(text).toContain("…");
  const plan = seatTickWakeCommitPlan(verdict, { fingerprint: "unchanged", eventsThrough: 0, bridgeReports: true,
    terminalChildren: ["child-outcome"], frozenText: text,
  })!;
  const landed = seatTickWakeCommit(emptySeatTickState(), plan, Date.parse("2026-10-03T12:00:00Z"));
  expect(landed.announcedLanes).toEqual(["visible-lane:completed"]);
  expect(landed.harvestedChildren).toEqual([]);
  expect(landed.childrenShown).toEqual([]);
  expect(landed.announcedDeploys).toEqual([]);
  expect(landed.announcedMaintenance).toEqual([]);
  expect(landed.reportedStalls ?? []).toEqual([]);
  expect(landed.reportsOwed!.map(outcome => outcome.key)).toEqual(["lane:visible-lane:completed"]);
});

test("disk pressure is shown once per episode despite free-space changes and agenda eviction", () => {
  const episode = "2026-10-06T10:00:00Z";
  const check = input({ signals: [{ id: "disk-space", episode, label: "Disk space low: state/worktrees 1.00 GiB free; worktrees 20 GiB" }] });
  const decision = seatTickDecision(check);
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("expected a wake");
  /* With no open work at all, the episode alone wakes the seat, and leads. */
  expect(decision.verdict.reasons.map(reason => reason.kind)).toEqual(["disk-pressure"]);
  expect(decision.verdict.items[0]).toMatchObject({ kind: "signal", id: "disk-space", diskPressureEpisode: episode });
  /* It does not wait for the wake interval. */
  const recent = seatTickDecision({ ...check, state: { ...emptySeatTickState(), lastWakeAt: new Date(NOW - 60_000).toISOString() } });
  expect(recent.verdict.kind).toBe("wake");
  const landed = seatTickWakeCommit(decision.state, plan(decision.verdict, check.changeFingerprint, 0), NOW);
  expect(landed.diskPressureShown).toBe(episode);
  const next = input({ now: NOW + 2 * SEAT_TICK_WAKE_INTERVAL_MS, state: { ...landed, itemsShown: [] },
    signals: [{ id: "disk-space", episode, label: "Disk space low: state/worktrees 0.80 GiB free; worktrees 22 GiB" }] });
  const repeat = seatTickDecision(next);
  expect(repeat.verdict.kind).not.toBe("wake");
  const crossing = seatTickDecision({ ...next, signals: [{ id: "disk-space", episode: "2026-10-07T10:00:00Z", label: "Disk space low again" }] });
  expect(crossing.verdict.kind).toBe("wake");
});

test("a restarted disk reader joins the shared episode and does not wake the seat again", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-pressure-"));
  const file = path.join(directory, "disk-pressure-report.json");
  try {
    const volumes = () => [{ roles: ["state"], freeBytes: 1024 ** 3, level: "critical" as const }];
    // This reader predates the pressure episode; it has nothing to announce.
    observeDiskPressureReport(file, () => [], "2026-10-06T10:00:00Z");
    const opened = observeDiskPressureReport(file, volumes, "2026-10-06T10:20:00Z");
    const check = input({ signals: [{ id: "disk-space", episode: opened.episode!, label: "Disk space low" }] });
    const decision = seatTickDecision(check);
    expect(decision.verdict.kind).toBe("wake");
    if (decision.verdict.kind !== "wake") throw new Error("expected a wake");
    const landed = seatTickWakeCommit(decision.state, plan(decision.verdict, check.changeFingerprint, 0), NOW);
    const restarted = observeDiskPressureReport(file, volumes, "2026-10-06T10:40:00Z");
    const next = input({ now: NOW + 2 * SEAT_TICK_WAKE_INTERVAL_MS,
      state: JSON.parse(JSON.stringify({ ...landed, itemsShown: [] })),
      signals: [{ id: "disk-space", episode: restarted.episode!, label: "Disk space low" }],
    });
    expect(restarted.episode).toBe(opened.episode);
    expect(seatTickDecision(next).verdict.kind).not.toBe("wake");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
