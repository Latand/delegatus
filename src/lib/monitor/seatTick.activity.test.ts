import { expect, test } from "bun:test";
import { DEFAULT_SEAT_TICK_POLICY, SEAT_TICK_WAKE_INTERVAL_MS, seatTickDecision, seatTickWakeCommit, seatTickWakeCommitPlan } from "./seatTick";
import { defaultSeatTickSettings, effectiveSeatTickSettings } from "./seatTickSettings";
import { emptySeatTickState, type SeatTickCheckInput } from "./types";
const now = Date.parse("2026-10-12T12:00:00Z");
function input(): SeatTickCheckInput {
  return { project: "fixture", now, seat: { conversationId: "conversation_seat", seatEpoch: 1, turn: "idle", activity: null }, pipelines: [{ id: "pipeline_one", title: "build check", state: "active", updatedAt: new Date(now-60_000).toISOString(), stageId: "build", stageActivity: { lifecycle: "stalled", reason: "host_alive_transcript_silent", conversationId: "conversation_one", lastRecordAt: new Date(now-660_000).toISOString(), verified: true, activity: { state: "idle", check: null, idleForMs: 660_000 } } }], tasks: [], events: [], pullRequests: [], ownLanes: [], signals: [], children: [], changeFingerprint: "one", state: { ...emptySeatTickState(), lastWakeAt: new Date(now - 60_000).toISOString(), lastFingerprint: "one" }, policy: DEFAULT_SEAT_TICK_POLICY, settings: effectiveSeatTickSettings(defaultSeatTickSettings("fixture"), now, SEAT_TICK_WAKE_INTERVAL_MS) } as unknown as SeatTickCheckInput;
}
test("verified ten-minute idle wakes on first sighting, once per record, and a later stretch wakes again", () => {
  const first = input();
  const decision = seatTickDecision(first);
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("idle must wake");
  const item = decision.verdict.items.find(item => item.stallToken);
  expect(item?.stallToken).toBe(`conversation_one@${first.pipelines[0].stageActivity!.lastRecordAt}`);
  expect(item?.label).toContain("стоїть 11 хв");
  const committed = seatTickWakeCommit(decision.state, seatTickWakeCommitPlan(decision.verdict, { fingerprint: "one", eventsThrough: 0 })!, now);
  const next = seatTickDecision({ ...first, now: now + 300_000, state: committed });
  expect((next.verdict.kind === "wake" ? next.verdict.items : []).filter(item => item.stallToken)).toHaveLength(0);
  const moved = input();
  moved.pipelines[0].stageActivity!.lastRecordAt = new Date(now + 60_000).toISOString();
  const later = seatTickDecision({ ...moved, now: now + 660_000, state: committed });
  expect(later.verdict.kind === "wake" && later.verdict.items.some(item => item.stallToken)).toBe(true);
});
test("an hour checking and an unverified projected stall produce no stall wake", () => {
  for (const activity of [{ state: "checking", check: "bun test", idleForMs: null }, { state: "idle", check: null, idleForMs: 660_000 }] as const) {
    const check = input();
    check.state.stalledSeen = ["pipeline_one"];
    Object.assign(check.pipelines[0].stageActivity!, { activity, verified: activity.state === "checking" });
    const decision = seatTickDecision(check);
    expect((decision.verdict.kind === "wake" ? decision.verdict.items : []).filter(item => item.stallToken)).toHaveLength(0);
  }
  expect(DEFAULT_SEAT_TICK_POLICY.stallAfterMs).toBe(600_000);
});


test("a verified idle child wakes immediately and its unchanged record is shown once", () => {
  const check = input();
  const activity = check.pipelines[0].stageActivity!;
  check.pipelines = [];
  check.children = [{ conversationId: "conversation_child", title: "child check", status: "running", outcome: null, terminalAt: null, lastRecordAt: activity.lastRecordAt!, activity: { ...activity, conversationId: "conversation_child" } }];
  const first = seatTickDecision(check);
  expect(first.verdict.kind).toBe("wake");
  if (first.verdict.kind !== "wake") throw new Error("idle child must wake");
  expect(first.verdict.items[0]).toMatchObject({ kind: "child", stallToken: `conversation_child@${activity.lastRecordAt}` });
  const state = seatTickWakeCommit(first.state, seatTickWakeCommitPlan(first.verdict, { fingerprint: "one", eventsThrough: 0 })!, now);
  const next = seatTickDecision({ ...check, now: now + 300_000, state });
  expect((next.verdict.kind === "wake" ? next.verdict.items : []).filter(item => item.stallToken)).toHaveLength(0);
});


for (const child of [false, true]) {
  test(`verified idle ${child ? "child" : "stage"} notifies a busy seat once`, () => {
    const check = input();
    check.seat!.turn = "busy";
    check.seat!.activity = { lifecycle: "running", reason: "host_alive_transcript_active", turnState: "busy", hostState: "alive", silentForMs: 1_000, stalledForMs: null };
    if (child) {
      const activity = check.pipelines[0].stageActivity!;
      check.pipelines = [];
      check.children = [{ conversationId: "conversation_child", title: "child check", status: "running", outcome: null, terminalAt: null, lastRecordAt: activity.lastRecordAt!, activity: { ...activity, conversationId: "conversation_child" } }];
    }
    const first = seatTickDecision(check);
    expect(first.verdict.kind).toBe("wake");
    if (first.verdict.kind !== "wake") throw new Error("verified idle must notify the busy seat");
    expect(first.verdict.items.some(item => item.stallToken)).toBe(true);
    const state = seatTickWakeCommit(first.state, seatTickWakeCommitPlan(first.verdict, { fingerprint: "one", eventsThrough: 0 })!, now);
    expect(seatTickDecision({ ...check, now: now + 300_000, state }).verdict).toMatchObject({ kind: "skipped", reason: "seat-busy" });
  });
}
