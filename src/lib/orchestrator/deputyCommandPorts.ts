import { waitForStateLock } from "@/lib/state/lockWait";
import { withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { runtimeHostClient, readRuntimeSession } from "@/lib/runtime/client";
import { readEvidenceWithin } from "@/lib/runtime/evidence";
import { resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { applyConversationAction } from "@/lib/conversation/actions";
import { deputyMessageKey, productionDeputyPrincipal, reconcileDeputyAnswer } from "./deputies";
import path from "node:path";

import { forkClaudeHistory, HistorySecurityError } from "@/lib/accounts/migration/safeHistoryCopy";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";
import { agentMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { commitTaskMembership } from "@/lib/tasks/membership";
import { loadTasks } from "@/lib/tasks/store";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { deputyDeliveryOrigin, type DeputyCommandPorts } from "./deputyCommand";
import type { OrchestratorDeputy } from "./deputies";
import { deputyAnswered, deputyTerminalAnswer, readDeputyOwnLines, startDeputySweep } from "./deputySweep";
import { readDeputySeatBusy } from "./deputySeatBusy";
import { canonicalOrchestratorProject, orchestratorSeatFor } from "./seats";

/** A busy seat's transcript grows between the validation and the read; a
    snapshot fork tolerates growth, and a retry covers a rotation of the file
    under it. */
const FORK_ATTEMPTS = 3;
const OPEN_LANE_STATES = new Set(["provisioning", "running", "needs_decision", "needs_review", "paused"]);
const RECENT_TASK_MS = 10 * 60_000;

export function productionDeputyCommandPorts(dependencies: { registry?: AgentRegistry; client?: typeof runtimeHostClient } = {}): DeputyCommandPorts {
  const registry = dependencies.registry ?? agentRegistry();
  const reconcileCompletedAnswer = (deputy: OrchestratorDeputy): OrchestratorDeputy | null => {
    if (!deputy.deputyConversationId || !deputy.artifactPath) return null;
    const lines = readDeputyOwnLines(deputy);
    if (!lines || !deputyAnswered(lines)) return null;
    const answer = deputyTerminalAnswer(lines);
    if (!answer.result.finalText.trim()) return null;
    return reconcileDeputyAnswer(deputy.askId, deputy.attempt ?? 0, answer);
  };
  const reconcileCompletedAnswerUnderLock = (deputy: OrchestratorDeputy, guard: () => void) =>
    withAccountMutationLockAsync(() => {
      guard();
      return reconcileCompletedAnswer(deputy);
    }, { caller: "deputy retry answer" });
  return {
    now: () => new Date(),
    activeSeat: (project) => orchestratorSeatFor(project).active,
    seatBusy: async (project) => (await readDeputySeatBusy(project)).busy,
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
    registerConversation: ({ artifactPath, accountId, launchProfile, assertCurrent }) =>
      registry.deliveryWriteBatchOrBusy({ label: "registry.deputy-register" }, () => {
        assertCurrent?.();
        return registry.ensureForkedConversation("claude", artifactPath, accountId, launchProfile).id;
      }),
    joinSeatTask: async ({ project, seatConversationId, seatPath, deputyConversationId, artifactPath, accountId }) => {
      /* The deputy joins the seat's own task (the seat-only task of #1841), so
         the scanner's admission finds its membership and mints no card. */
      const result = await waitForStateLock("deputy.task-membership", () => commitTaskMembership({
        project,
        origin: { kind: "conversation", key: deputyConversationId },
        identity: { conversationId: deputyConversationId, path: artifactPath, engine: "claude", accountId },
        inherit: [{ conversationId: seatConversationId, path: seatPath }],
        titled: true,
        title: "Orchestrator",
      }), { subject: deputyConversationId });
      if (!result.ok) throw new Error(result.error);
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
      const authorityGuard = () => {
        if (!productionDeputyPrincipal(conversationId)) throw new Error("the parallel question is no longer authorized by its seat");
      };
      const result = await enqueueStructuredMessage({
        path: artifactPath,
        conversationId,
        clientMessageId,
        text,
        images,
        admissionGuard: authorityGuard, recoveryAuthorityGuard: authorityGuard,
        origin: origin.kind === "agent"
          ? agentMessageOrigin(registry.readOnlySnapshot(), origin.conversationId, origin.role)
          : deputyDeliveryOrigin(origin),
      });
      if (!result) return { ok: false, error: "structured delivery is unavailable" };
      if (result.ok) return { ok: true, outcome: result.outcome, operationId: result.operationId };
      return { ok: false, error: result.error, operationId: result.operationId, ...(result.transportUncertain ? { uncertain: true as const } : {}) };
    },
    imageRefsForRetry: deputy => {
      if (!deputy.deputyConversationId) return [];
      const admission = registry.deliveryAdmissionForKey(deputy.deputyConversationId, deputyMessageKey(deputy.askId, deputy.attempt ?? 0));
      if (admission.outcome !== "admitted") return [];
      return registry.deliverySnapshotForOperation(admission.operationId).heldDeliveries[admission.deliveryId]?.runtimeImages ?? [];
    },
    reconcileRetryAnswer: reconcileCompletedAnswer,
    prepareRetry: async (deputy, guard) => {
      guard();
      const alreadyCompleted = await reconcileCompletedAnswerUnderLock(deputy, guard);
      if (alreadyCompleted) return { ok: true, completed: alreadyCompleted };
      if (!deputy.deputyConversationId) return { ok: true };
      const client = (dependencies.client ?? runtimeHostClient)();
      if (!client) return { ok: false, error: "the runtime host is unavailable; the previous delivery cannot be checked" };
      const session = await readRuntimeSession(client, { conversationId: deputy.deputyConversationId });
      guard();
      const answeredAfterRead = await reconcileCompletedAnswerUnderLock(deputy, guard);
      if (answeredAfterRead) return { ok: true, completed: answeredAfterRead };
      if (session && !["dead", "unhosted"].includes(session.host)) {
        const stopped = await applyConversationAction({ conversationId: deputy.deputyConversationId,
          transcriptPath: deputy.artifactPath ?? "", action: "kill", operationId: `deputy_retry_stop_${deputy.askId}_${deputy.attempt ?? 0}` });
        guard();
        if (stopped.status !== 200) return { ok: false, error: "the previous parallel host could not be stopped" };
        const remaining = await readRuntimeSession(client, { conversationId: deputy.deputyConversationId });
        guard();
        const answeredWhileStopping = await reconcileCompletedAnswerUnderLock(deputy, guard);
        if (answeredWhileStopping) return { ok: true, completed: answeredWhileStopping };
        if (remaining && !["dead", "unhosted"].includes(remaining.host)) return { ok: false, error: "the previous parallel host is still stopping" };
      }
      const admitted = registry.deliveryAdmissionForKey(deputy.deputyConversationId, deputyMessageKey(deputy.askId, deputy.attempt ?? 0));
      if (admitted.outcome === "not-executed") return { ok: true };
      if (admitted.outcome !== "admitted") return { ok: false, error: "the previous delivery outcome could not be verified" };
      const journal = await readEvidenceWithin(() => client.operationStatus(admitted.operationId), 1_000,
        "the previous delivery journal could not be read");
      guard();
      const answeredAfterJournal = await reconcileCompletedAnswerUnderLock(deputy, guard);
      if (answeredAfterJournal) return { ok: true, completed: answeredAfterJournal };
      if (journal.readable && journal.value === null) {
        // No journal command exists. End only a reservation whose claim still
        // proves that no delivery attempt began, inside the admitted writer.
        const ended = await registry.deliveryWrite({ label: "deputy.retry-unclaimed", operationId: admitted.operationId }, () => {
          guard();
          const row = registry.deliverySnapshotForOperation(admitted.operationId).heldDeliveries[admitted.deliveryId];
          return row?.state === "assigned" && row.attempts === 0
            ? registry.terminalizeHeldDelivery(row.id, "parallel question stopped before its first delivery") : null;
        });
        if (!ended.acquired) return { ok: false, error: "the previous delivery could not be settled while its writer is busy" };
      }
      const receipt = await resolveSendReceipt(admitted.operationId, { registry, client, windowMs: 0 });
      guard();
      const answeredAfterReceipt = await reconcileCompletedAnswerUnderLock(deputy, guard);
      if (answeredAfterReceipt) return { ok: true, completed: answeredAfterReceipt };
      if (!receipt || receipt.state === "in-flight" || receipt.resend === "verify-first") {
        return { ok: false, error: receipt?.reason ?? "the previous delivery is still being checked" };
      }
      return { ok: true };
    },
    watch: () => startDeputySweep(),
  };
}
