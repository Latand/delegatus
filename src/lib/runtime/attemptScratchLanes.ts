import path from "node:path";
import { agentRegistry } from "@/lib/agent/registry";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { pipelineActivitySettled } from "@/lib/pipelines/types";
import { liveOrWaitingConversationCwds } from "@/lib/pipelines/worktreeSweep";

/** One read of every directory an open lane or a live conversation works in,
 * returned as a test for a candidate: a candidate that contains one of them or
 * lies inside one is in use. A lane that is not both closed and settled is open. */
export function openLaneUseCheck(): (directory: string) => boolean {
  const used = [
    ...loadPipelinesForList().filter(lane => lane.state !== "closed" && lane.state !== "completed" || !pipelineActivitySettled(lane))
      .flatMap(lane => [lane.worktreeDir, lane.repoDir]),
    ...liveOrWaitingConversationCwds(agentRegistry().worktreeProtectionSnapshot()),
  ].filter((other): other is string => !!other);
  return directory => used.some(other => other === directory || other.startsWith(directory + path.sep) || directory.startsWith(other + path.sep));
}
