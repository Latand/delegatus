import { expect, test } from "bun:test";
import { prototypeCriticGate } from "./criticGate";
import { criticLane, criticAttempt } from "./criticGate.fixture";

test("a caller needs a lane, its publishing stage and a separate visual critic", () => {
  expect(prototypeCriticGate(null, "publish")).toEqual({ ok: false, missing: "this caller is not a stage of a prototype lane" });
  const lane = criticLane();
  expect(prototypeCriticGate(lane, "outside").ok).toBe(false);
  expect(prototypeCriticGate(lane, "critic").ok).toBe(false);
  lane.stages.splice(1, 1);
  expect(prototypeCriticGate(lane, "publish")).toEqual({ ok: false, missing: "this lane has no visual-critic stage" });
});
test("not run, running, skipped and needs_decision critics refuse with a missing reason", () => {
  const lane = criticLane();
  for (const state of ["running", "pending", "skipped", "failed"] as const) {
    criticAttempt(lane).state = state;
    if (state === "failed") criticAttempt(lane).verdict!.status = "needs_decision";
    const result = prototypeCriticGate(lane, "publish");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain("critic");
  }
  lane.runs[0]!.attempts = [];
  expect(prototypeCriticGate(lane, "publish")).toEqual({ ok: false, missing: "visual-critic stage critic has not passed: not run yet" });
});
test("the latest non-historical critic pass supplies provenance", () => {
  const lane = criticLane();
  lane.runs[0]!.attempts.push({ ...criticAttempt(lane), n: 2, historical: true, state: "failed" });
  expect(prototypeCriticGate(lane, "publish")).toEqual({ ok: true, pass: { pipelineId: "prototype-lane", stageId: "critic", attempt: 1, outcome: "passed" } });
});
test("a failed critic is fixed only by its passed fix started after that failure", () => {
  const lane = criticLane();
  criticAttempt(lane).state = "failed"; criticAttempt(lane).verdict!.status = "fail";
  expect(prototypeCriticGate(lane, "publish")).toEqual({ ok: true, pass: { pipelineId: "prototype-lane", stageId: "critic", attempt: 1, outcome: "fixed", fixStageId: "proto-fix", fixAttempt: 1 } });
  const fix = lane.runs[1]!.attempts[0]!;
  fix.startedAt = "2026-10-12T09:00:00Z";
  expect(prototypeCriticGate(lane, "publish").ok).toBe(false);
  fix.startedAt = "2026-10-12T10:02:00Z"; fix.historical = true;
  expect(prototypeCriticGate(lane, "publish").ok).toBe(false);
  delete fix.historical; fix.state = "running";
  expect(prototypeCriticGate(lane, "publish").ok).toBe(false);
});
test("a later unpassed critic attempt invalidates its earlier pass and fix", () => {
  const lane = criticLane();
  lane.runs[0]!.attempts.push({ ...criticAttempt(lane), n: 2, state: "running" });
  expect(prototypeCriticGate(lane, "publish").ok).toBe(false);
});


test("an eligible passed fix remains evidence when the fix has another unfinished attempt", () => {
  const lane = criticLane(); criticAttempt(lane).state = "failed"; criticAttempt(lane).verdict!.status = "fail";
  lane.runs[1]!.attempts.push({ ...lane.runs[1]!.attempts[0]!, n: 2, state: "running", completedAt: null });
  expect(prototypeCriticGate(lane, "publish")).toEqual({ ok: true, pass: { pipelineId: "prototype-lane", stageId: "critic", attempt: 1, outcome: "fixed", fixStageId: "proto-fix", fixAttempt: 1 } });
});
