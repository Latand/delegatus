import { readReleaseProject } from "./store";
export function releaseStatus(project: string) {
  const row = readReleaseProject(project);
  const live = row.live ? { key: row.live.key, taskId: row.live.taskId, pipelineId: row.live.pipelineId, cut: row.live.cut, startedAt: row.live.startedAt } : null;
  const last = row.history.at(-1);
  return { live, lastRun: last ? { key: last.key, at: last.at, outcome: last.outcome, cut: last.cut, ...(last.reason ? { reason: last.reason } : {}) } : null,
    request: row.request, hold: row.hold, observation: row.observation, blocked: row.blocked };
}
export type ReleaseStatus = ReturnType<typeof releaseStatus>;
