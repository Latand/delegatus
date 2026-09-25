import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import type { AgentRegistry } from "@/lib/agent/registry";
import { appendLifecycleEvents, type LifecycleEventInput } from "@/lib/lifecycle/journal";
import { allSeatConversations } from "@/lib/orchestrator/seats";
import { withPipelineMutation } from "@/lib/pipelines/store";
import type { Pipeline, PipelinePermissionDenial } from "@/lib/pipelines/types";

import { permissionAttendance, type PermissionAttendance, type PermissionDenialRecord } from "./permissionGuard";

/**
 * The production side of the permission guard (#2215): who is attended, read
 * from the registry and the seat record, and where an automatic deny is
 * written down — the stage attempt the conversation runs, and the lifecycle
 * journal every orchestrator reads.
 */

/** Denials kept on one attempt; the journal keeps every one. */
const ATTEMPT_DENIAL_CAPACITY = 20;

export function resolvePermissionAttendance(
  registry: AgentRegistry,
  conversationId: string,
  seats: () => { conversationIds: readonly string[] } | null = allSeatConversations,
): PermissionAttendance {
  const canonical = conversationId.startsWith("conversation_")
    ? registry.canonicalConversationId(conversationId as ViewerConversationId)
    : conversationId;
  const snapshot = registry.readOnlySnapshot();
  const conversation = snapshot.conversations[canonical];
  const held = seats();
  const seat = held?.conversationIds.some((id) => id === canonical || id === conversationId) ?? false;
  return permissionAttendance({
    memberships: snapshot.memberships[canonical] ?? [],
    delegationDepth: conversation?.delegationDepth ?? null,
    seat,
  });
}

interface StageLineage {
  project: string;
  pipelineId: string;
  stageId: string;
  attempt: number;
  role: string | null;
}

/** Appends the denial to the newest live attempt the conversation runs, and
    returns that attempt's lineage; null when no stage runs it. */
function recordOnAttempt(pipelines: Pipeline[], denial: PermissionDenialRecord, canonical: (id: string) => string): { pipeline: Pipeline; lineage: StageLineage } | null {
  const target = canonical(denial.conversationId);
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (let index = run.attempts.length - 1; index >= 0; index -= 1) {
        const attempt = run.attempts[index]!;
        if (attempt.historical || !attempt.conversationId || canonical(attempt.conversationId) !== target) continue;
        const entry: PipelinePermissionDenial = {
          requestId: denial.requestId,
          tool: denial.tool,
          command: denial.command,
          reason: denial.reason,
          reasonType: denial.reasonType,
          mode: denial.mode,
          deniedAt: denial.deniedAt,
        };
        const denials = attempt.permissionDenials ?? [];
        if (!denials.some((existing) => existing.requestId === denial.requestId)) {
          attempt.permissionDenials = [...denials, entry].slice(-ATTEMPT_DENIAL_CAPACITY);
        }
        return {
          pipeline,
          lineage: {
            project: pipeline.project,
            pipelineId: pipeline.id,
            stageId: run.stageId,
            attempt: attempt.n,
            role: attempt.effectiveRole?.roleId ?? null,
          },
        };
      }
    }
  }
  return null;
}

function conversationProject(registry: AgentRegistry, conversationId: string): string | null {
  if (!conversationId.startsWith("conversation_")) return null;
  const conversation = registry.conversation(conversationId as ViewerConversationId);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  try {
    return conversationProjectKey(conversation.projectOwnership, generation.launchProfile);
  } catch {
    return null;
  }
}

export interface PermissionDenialRecorderDependencies {
  registry: AgentRegistry;
  mutatePipelines?: typeof withPipelineMutation;
  appendLifecycle?: typeof appendLifecycleEvents;
}

/** One line for the journal: which tool, why it was denied, the engine's reason. */
export function permissionDenialSummary(denial: Pick<PermissionDenialRecord, "tool" | "reason" | "mode">): string {
  const why = denial.mode === "unattended" ? "no one can approve it here" : "unanswered for 10 minutes";
  return `Denied ${denial.tool ?? "a tool"} permission (${why})${denial.reason ? `: ${denial.reason}` : ""}`;
}

export function permissionDenialRecorder(dependencies: PermissionDenialRecorderDependencies) {
  const mutate = dependencies.mutatePipelines ?? withPipelineMutation;
  const append = dependencies.appendLifecycle ?? appendLifecycleEvents;
  const canonical = (id: string): string => id.startsWith("conversation_")
    ? dependencies.registry.canonicalConversationId(id as ViewerConversationId)
    : id;
  return async (denial: PermissionDenialRecord): Promise<void> => {
    let lineage: StageLineage | null = null;
    try {
      lineage = await mutate((pipelines, persist) => {
        const recorded = recordOnAttempt(pipelines, denial, canonical);
        if (!recorded) return null;
        persist([recorded.pipeline]);
        return recorded.lineage;
      });
    } catch (error) {
      /* The journal line below is still worth writing without the lineage. */
      console.error("[permission guard] stage attempt could not record the denial", error);
    }
    const event: LifecycleEventInput = {
      key: `permission-denied:${denial.conversationId}:${denial.requestId}`,
      type: "permission_denied",
      at: denial.deniedAt,
      project: lineage?.project ?? conversationProject(dependencies.registry, denial.conversationId),
      pipelineId: lineage?.pipelineId ?? null,
      stageId: lineage?.stageId ?? null,
      attempt: lineage?.attempt ?? null,
      conversationId: denial.conversationId,
      role: lineage?.role ?? null,
      summary: permissionDenialSummary(denial),
    };
    append([event]);
  };
}
