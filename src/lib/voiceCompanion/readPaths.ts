import { loadTasksForList } from "@/lib/tasks/store";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { agentLivenessSnapshot, productionLivenessSources, type AgentLivenessSources } from "@/lib/lifecycle/liveness";
import { canonicalProject } from "@/lib/projects/aliases";
import { voiceConversationTail, type ViewerMcpDomainDependencies } from "@/lib/mcp/bindings";
import type { BoardReadPaths } from "./boardReads";

/** Reuses the board's completed scan generation. Observes liveness without
 * agent_activity's lifecycle-journal refresh; these tools write no state. */
export function createCompanionBoardReadPaths(dependencies: { liveness?: AgentLivenessSources; transcript?: Pick<ViewerMcpDomainDependencies, "pinnedTranscript" | "selectedContext"> } = {}): BoardReadPaths {
  return {
  tasks: () => loadTasksForList().map(row => ({ ...row, project: canonicalProject(row.project) })),
  pipelines: () => loadPipelinesForList().map(row => ({ ...row, project: canonicalProject(row.project),
    runs: row.runs.map(run => ({ ...run, attempts: run.attempts.map(attempt => ({ ...attempt, verdict: attempt.verdict?.status })) })) })),
  activity: async project => {
    const snapshot = await agentLivenessSnapshot({ project, liveOnly: true, limit: 200 }, dependencies.liveness ?? productionLivenessSources());
    return snapshot.conversations.flatMap(row => row.conversationId ? [{ conversationId: row.conversationId, project: canonicalProject(row.project), title: row.title, lifecycle: row.lifecycle }] : []);
  },
  messages: conversationId => voiceConversationTail(conversationId, dependencies.transcript),
  };
}
export const companionBoardReadPaths = createCompanionBoardReadPaths();
