import path from "node:path";

import { forkClaudeHistory, HistorySecurityError } from "@/lib/accounts/migration/safeHistoryCopy";
import { agentRegistry } from "@/lib/agent/registry";
import { DEFAULT_SEAT_TICK_POLICY, seatTickPolicy, seatTurnProgressing } from "@/lib/monitor/seatTick";
import { defaultSeatTickSources, seatInput } from "@/lib/monitor/seatTickSources";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";
import { agentMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { commitTaskMembership } from "@/lib/tasks/membership";
import { loadTasks } from "@/lib/tasks/store";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { deputyDeliveryOrigin, type DeputyCommandPorts } from "./deputyCommand";
import { startDeputySweep } from "./deputySweep";
import { canonicalOrchestratorProject, orchestratorSeatFor } from "./seats";

/** A busy seat's transcript grows between the validation and the read; a
    snapshot fork tolerates growth, and a retry covers a rotation of the file
    under it. */
const FORK_ATTEMPTS = 3;
const OPEN_LANE_STATES = new Set(["provisioning", "running", "needs_decision", "needs_review", "paused"]);
const RECENT_TASK_MS = 10 * 60_000;

export function productionDeputyCommandPorts(): DeputyCommandPorts {
  const registry = agentRegistry();
  return {
    now: () => new Date(),
    activeSeat: (project) => orchestratorSeatFor(project).active,
    seatBusy: async (project) => {
      const seat = await seatInput(canonicalOrchestratorProject(project), seatTickPolicy() ?? DEFAULT_SEAT_TICK_POLICY, defaultSeatTickSources());
      return seat ? seatTurnProgressing(seat) : false;
    },
    seatGeneration: (seatConversationId) => {
      const conversation = registry.conversation(seatConversationId as ViewerConversationId);
      const generation = conversation?.generations.at(-1);
      if (!conversation || !generation) return null;
      return { engine: conversation.engine, path: generation.path, accountId: generation.accountId, launchProfile: generation.launchProfile };
    },
    fork: (input) => {
      /* The fork lands in the seat's own project directory, so the resumed
         session finds it under the seat's cwd and account. */
      const root = path.dirname(path.dirname(input.sourcePath));
      let lastError: unknown = null;
      for (let attempt = 0; attempt < FORK_ATTEMPTS; attempt += 1) {
        try {
          const result = forkClaudeHistory({ ...input, sourceRoot: root, targetRoot: root, snapshot: true });
          return { path: result.path, records: result.records, size: result.size };
        } catch (error) {
          lastError = error;
          if (!(error instanceof HistorySecurityError) || (error.code !== "history-integrity" && error.code !== "unsafe-source")) break;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
    registerConversation: ({ artifactPath, accountId, launchProfile }) =>
      registry.ensureForkedConversation("claude", artifactPath, accountId, launchProfile).id,
    joinSeatTask: ({ project, seatConversationId, seatPath, deputyConversationId, artifactPath, accountId }) => {
      /* The deputy joins the seat's own task (the seat-only task of #1841), so
         the scanner's admission finds its membership and mints no card. */
      const result = commitTaskMembership({
        project,
        origin: { kind: "conversation", key: deputyConversationId },
        identity: { conversationId: deputyConversationId, path: artifactPath, engine: "claude", accountId },
        inherit: [{ conversationId: seatConversationId, path: seatPath }],
        titled: true,
        title: "Orchestrator",
      });
      if (!result.ok) console.error("[deputy] seat task membership failed", result.status);
    },
    workContext: (project) => {
      const canonical = canonicalOrchestratorProject(project);
      const openLanes = loadPipelinesForList()
        .filter((pipeline) => OPEN_LANE_STATES.has(pipeline.state) && canonicalOrchestratorProject(pipeline.project) === canonical)
        .map((pipeline) => ({
          id: pipeline.id,
          title: pipeline.task.split(/\r?\n/, 1)[0] ?? "",
          state: pipeline.state,
          stage: pipeline.cursor?.stageId ?? null,
        }));
      const since = Date.now() - RECENT_TASK_MS;
      const recentTasks = loadTasks()
        .filter((task) => canonicalOrchestratorProject(task.project) === canonical && Date.parse(task.updatedAt) >= since)
        .map((task) => ({ id: task.id, title: task.text.split(/\r?\n/, 1)[0] ?? "", status: task.status }));
      return { openLanes, recentTasks };
    },
    deliver: async ({ conversationId, path: artifactPath, clientMessageId, text, images, origin }) => {
      const result = await enqueueStructuredMessage({
        path: artifactPath,
        conversationId,
        clientMessageId,
        text,
        images,
        origin: origin.kind === "agent"
          ? agentMessageOrigin(registry.readOnlySnapshot(), origin.conversationId, origin.role)
          : deputyDeliveryOrigin(origin),
      });
      if (!result) return { ok: false, error: "structured delivery is unavailable" };
      if (result.ok) return { ok: true };
      return { ok: false, error: result.error, ...(result.transportUncertain ? { uncertain: true as const } : {}) };
    },
    watch: () => startDeputySweep(),
  };
}
