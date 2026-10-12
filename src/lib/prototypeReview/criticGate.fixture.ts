import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

/** A small lane record; no host, registry or lifecycle work. */
export function criticLane(): Pipeline {
  const attempt = (state: string, startedAt: string, completedAt: string, status = "pass") => ({ n: 1, state, startedAt, completedAt, verdict: { status } });
  return {
    id: "prototype-lane",
    stages: [
      { id: "publish", effectiveRole: { roleId: "architect" } },
      { id: "critic", effectiveRole: { roleId: "visual-critic" }, onFail: { to: "proto-fix", maxRounds: 2, onExhausted: "advance" } },
      { id: "proto-fix", effectiveRole: { roleId: "architect" } },
    ],
    runs: [
      { stageId: "critic", attempts: [attempt("passed", "2026-10-12T10:00:00Z", "2026-10-12T10:01:00Z")] },
      { stageId: "proto-fix", attempts: [attempt("passed", "2026-10-12T10:02:00Z", "2026-10-12T10:03:00Z")] },
    ],
  } as unknown as Pipeline;
}
export const criticAttempt = (lane: Pipeline): PipelineStageAttempt => lane.runs[0]!.attempts.at(-1)!;
