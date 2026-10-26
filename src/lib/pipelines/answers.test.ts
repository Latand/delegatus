import { expect, test } from "bun:test";
import { attemptAnswers, laneAnswers, stageResultLine } from "./answers";
import type { Pipeline, PipelineStageAttempt, PipelineEdgeActivation } from "./types";

const attempt = (n: number, activatedBy: PipelineEdgeActivation | null = null, historical = false) => ({ n, activatedBy, historical }) as PipelineStageAttempt;
const lane = (...attempts: PipelineStageAttempt[]) => ({ id: "lane", runs: [{ stageId: "build", attempts }] }) as Pipeline;

test("fail edges answer the gate; pass edges and adopted helpers answer nothing", () => {
  for (const edge of ["fail", "pass"] as const) {
    const a = attempt(1, { stageId: "review", attempt: 2, edge });
    expect(attemptAnswers(lane(a), a)).toEqual(edge === "fail" ? { kind: "fix", pipelineId: "lane", stageId: "review", attempt: 2 } : null);
    a.historical = true;
    expect(attemptAnswers(lane(a), a)).toBeNull();
  }
});

test("own retry skips helpers, retains hand-launch activation, and takes precedence over fix", () => {
  const activation: PipelineEdgeActivation = { stageId: "review", attempt: 1, edge: "fail" };
  const first = attempt(1, activation), helper = attempt(2, activation, true), retry = attempt(3, { ...activation });
  retry.launchedBy = { actor: { kind: "operator" }, at: "2026-10-02T10:00:00.000Z" };
  expect(attemptAnswers(lane(first, helper, retry), retry)).toEqual({ kind: "retry", pipelineId: "lane", stageId: "build", attempt: 1 });
  retry.activatedBy = { ...activation, attempt: 2 };
  expect(attemptAnswers(lane(first, helper, retry), retry)).toEqual({ kind: "fix", pipelineId: "lane", stageId: "review", attempt: 2 });
  const start = attempt(1), next = attempt(2);
  expect(attemptAnswers(lane(start, next), next)?.kind).toBe("retry");
  expect(attemptAnswers(lane(), next)).toBeNull();
});

test("refresh answers its source lane and result is absent until written", () => {
  expect(laneAnswers(lane())).toBeNull();
  expect(laneAnswers({ ...lane(), refreshOf: { pipelineId: "source", base: "a".repeat(40) } })).toEqual({ kind: "refresh", pipelineId: "source" });
  expect(stageResultLine(null)).toBeNull();
  expect(stageResultLine(attempt(1))).toBeNull();
  const a = attempt(1);
  a.report = { result: "  Done.  " } as PipelineStageAttempt["report"];
  expect(stageResultLine(a)).toBe("Done.");
  a.report!.result = "  ";
  expect(stageResultLine(a)).toBeNull();
});
