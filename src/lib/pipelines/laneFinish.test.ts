import { expect, test } from "bun:test";
import { buildPipeline } from "./store";
import type { PipelineStageAttempt } from "./types";
import { laneFinish } from "./laneFinish";

const DAY = 86400000;
function lane() {
  const p = buildPipeline({ id: "retention-clock", task: "Retention clock", project: "fixture", repoDir: "/srv/repository",
    stages: [], srcPath: null, srcConversationId: null, now: "2026-10-01T00:00:00Z" });
  p.state = "completed"; p.closedAt = "2026-10-02T00:00:00Z";
  return p;
}

test("retention starts at the latest close, attempt, release or settled merge", () => {
  const p = lane();
  p.runs = [{ stageId: "build", attempts: [{ state: "passed", completedAt: "2026-10-03T00:00:00Z" } as PipelineStageAttempt] }];
  expect(laneFinish(p, 7 * DAY)).toEqual({ finished: true, finishedAt: Date.parse("2026-10-03T00:00:00Z"), expiresAt: Date.parse("2026-10-10T00:00:00Z") });
  p.merge = { state: "merged", updatedAt: "2026-10-04T00:00:00Z" } as NonNullable<typeof p.merge>;
  expect(laneFinish(p, 7 * DAY)).toMatchObject({ expiresAt: Date.parse("2026-10-11T00:00:00Z") });
  p.merge.state = "queued";
  expect(laneFinish(p, 7 * DAY)).toEqual({ finished: false });
  p.merge.state = "merged"; p.merge.updatedAt = "2026-10-10T00:00:00Z";
  expect(laneFinish(p, 7 * DAY)).toMatchObject({ expiresAt: Date.parse("2026-10-17T00:00:00Z") });
  p.delivery = { journal: [{ kind: "release", at: "2026-10-11T00:00:00Z" }] } as NonNullable<typeof p.delivery>;
  expect(laneFinish(p, 7 * DAY)).toMatchObject({ expiresAt: Date.parse("2026-10-18T00:00:00Z") });
});

test("open lanes, missing close clocks and unfinished obligations never expire", () => {
  for (const state of ["running", "paused", "needs_decision"] as const) {
    const p = lane(); p.state = state; expect(laneFinish(p, DAY)).toEqual({ finished: false });
  }
  for (const change of [
    (p: ReturnType<typeof lane>) => { p.closedAt = null; },
    (p: ReturnType<typeof lane>) => { p.activationCloseRequested = true; },
    (p: ReturnType<typeof lane>) => { p.closeTeardown = { phase: "pending" } as NonNullable<typeof p.closeTeardown>; },
    (p: ReturnType<typeof lane>) => { p.unconfirmedHosts = [{}] as NonNullable<typeof p.unconfirmedHosts>; },
    (p: ReturnType<typeof lane>) => { p.runs = [{ stageId: "build", attempts: [{ state: "running" } as PipelineStageAttempt] }]; },
    (p: ReturnType<typeof lane>) => { p.runs = [{ stageId: "build", attempts: [{ state: "passed", unresolvedTermination: {} } as PipelineStageAttempt] }]; },
    (p: ReturnType<typeof lane>) => { p.merge = { state: "refreshing" } as NonNullable<typeof p.merge>; },
  ]) {
    const p = lane(); change(p); expect(laneFinish(p, DAY)).toEqual({ finished: false });
  }
});
