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
  const renamed = input();
  renamed.pipelines[0]!.title = "renamed build check";
  renamed.pipelines[0]!.updatedAt = new Date(now + 240_000).toISOString();
  const metadataMove = seatTickDecision({ ...renamed, now: now + 300_000, state: committed });
  expect((metadataMove.verdict.kind === "wake" ? metadataMove.verdict.items : []).filter(item => item.stallToken)).toHaveLength(0);
  const moved = input();
  moved.pipelines[0].stageActivity!.lastRecordAt = new Date(now + 60_000).toISOString();
  const later = seatTickDecision({ ...moved, now: now + 660_000, state: committed });
  expect(later.verdict.kind === "wake" && later.verdict.items.some(item => item.stallToken)).toBe(true);
});

test("active idle episodes survive unrelated history rotation and a new record starts one fresh alert", () => {
  const conversation = (id: string, lastRecordAt: string) => ({
    id, title: id, state: "active" as const, updatedAt: lastRecordAt, stageId: "build",
    stageActivity: { lifecycle: "stalled" as const, reason: "host_alive_transcript_silent", conversationId: id, lastRecordAt, verified: true, activity: { state: "idle" as const, check: null, idleForMs: 660_000 } },
  });
  const first = input();
  const aRecord = new Date(now - 660_000).toISOString();
  first.pipelines = [conversation("lane_a", aRecord), conversation("lane_b", aRecord)];
  let decision = seatTickDecision(first);
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("initial idle episodes must wake");
  let state = seatTickWakeCommit(decision.state, seatTickWakeCommitPlan(decision.verdict, { fingerprint: "initial", eventsThrough: 0 })!, now);

  for (let episode = 1; episode <= 2_000; episode++) {
    const at = now + episode * 660_000;
    const bRecord = new Date(at - 660_000).toISOString();
    const check = input();
    check.now = at;
    check.pipelines = [conversation("lane_a", aRecord), conversation("lane_b", bRecord)];
    decision = seatTickDecision({ ...check, state });
    expect(decision.verdict.kind).toBe("wake");
    if (decision.verdict.kind !== "wake") throw new Error("new idle episode must wake");
    state = seatTickWakeCommit(decision.state, seatTickWakeCommitPlan(decision.verdict, { fingerprint: `episode-${episode}`, eventsThrough: 0 })!, at);
  }

  expect(state.reportedStalls).toContain(`lane_a@${aRecord}`);
  expect(state.reportedStalls).toHaveLength(2);
  const unchanged = input();
  unchanged.now = now + 2_001 * 660_000;
  unchanged.pipelines = [conversation("lane_a", aRecord), conversation("lane_b", new Date(unchanged.now - 660_000).toISOString())];
  decision = seatTickDecision({ ...unchanged, state });
  expect(decision.verdict.kind).toBe("wake");
  if (decision.verdict.kind !== "wake") throw new Error("new B episode must wake");
  expect(decision.verdict.items.filter(item => item.stallToken?.startsWith("lane_a@")).length).toBe(0);

  const movedAt = new Date(unchanged.now - 660_000 + 1_000).toISOString();
  const moved = { ...unchanged, pipelines: [conversation("lane_a", movedAt), unchanged.pipelines[1]!] };
  const resumed = seatTickDecision({ ...moved, state });
  expect(resumed.verdict.kind).toBe("wake");
  if (resumed.verdict.kind !== "wake") throw new Error("new A episode must wake");
  expect(resumed.verdict.items.filter(item => item.stallToken?.startsWith("lane_a@")).map(item => item.stallToken)).toEqual([`lane_a@${movedAt}`]);
  const resumedState = seatTickWakeCommit(resumed.state, seatTickWakeCommitPlan(resumed.verdict, { fingerprint: "a-moved", eventsThrough: 0 })!, unchanged.now);
  const afterDelivery = seatTickDecision({ ...moved, now: unchanged.now + 300_000, state: resumedState });
  expect(afterDelivery.verdict.kind === "wake" ? afterDelivery.verdict.items.filter(item => item.stallToken?.startsWith("lane_a@")) : []).toHaveLength(0);
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
    check.seat!.activity = { verified: true, lifecycle: "running", reason: "host_alive_transcript_active", turnState: "busy" };
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
