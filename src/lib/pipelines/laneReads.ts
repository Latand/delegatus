import type { Pipeline, StageFinding } from "./types";
import { latestAttempt } from "./stageChip";

/* Two reads of a lane the boards and the lane feed a linked install publishes
   share. They hold no React, so the server can call them. */

/** When the lane last moved, in ms: the newest start or end of any of its
    attempts, else when it was created. The age every density prints. */
export function pipelineMovedAtMs(pipeline: Pipeline): number | null {
  let latest = 0;
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      for (const at of [attempt.startedAt, attempt.completedAt]) {
        const ms = Date.parse(at ?? "");
        if (Number.isFinite(ms) && ms > latest) latest = ms;
      }
    }
  }
  if (latest) return latest;
  const created = Date.parse(pipeline.createdAt ?? "");
  return Number.isFinite(created) ? created : null;
}

/** A finding list as the stage reported it: ranked when it was, else the
    plain strings with no rank. */
export function stageFindings(pipeline: Pipeline, stageId: string): StageFinding[] {
  const attempt = latestAttempt(pipeline, stageId);
  return attempt?.report?.verdict.rankedFindings
    ?? attempt?.verdict?.rankedFindings
    ?? (attempt?.report?.verdict.findings ?? attempt?.verdict?.findings ?? []).map((text) => ({ severity: null, text }));
}
