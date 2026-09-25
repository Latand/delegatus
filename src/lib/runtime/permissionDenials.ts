import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import type { AgentRegistry } from "@/lib/agent/registry";
import { appendLifecycleEvents, type LifecycleEventInput } from "@/lib/lifecycle/journal";
import { allSeatConversations } from "@/lib/orchestrator/seats";
import { loadPipelinesForList, withPipelineMutation } from "@/lib/pipelines/store";
import type { Pipeline, PipelinePermissionDenial, PipelineStageAttempt } from "@/lib/pipelines/types";
import { StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";

import { permissionAttendance, type PermissionAttendance, type PermissionDenialRecord } from "./permissionGuard";

/**
 * The production side of the permission guard (#2215): who is attended, read
 * from the registry and the seat record, and where an automatic deny is
 * written down — the stage attempt the conversation runs, and the lifecycle
 * journal every orchestrator reads.
 */

/** Denials kept on one attempt; the journal keeps every one. */
const ATTEMPT_DENIAL_CAPACITY = 20;
/** Tries at the attempt write when the pipeline lease refuses it before
    admission, and the base pause between them. */
const ATTEMPT_WRITE_TRIES = 3;
const BUSY_RETRY_DELAY_MS = 250;

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

/** The newest live attempt the conversation runs, with its lineage; null when
    no stage runs it. Reads only. */
function locateAttempt(
  pipelines: readonly Pipeline[],
  conversationId: string,
  canonical: (id: string) => string,
): { pipeline: Pipeline; attempt: PipelineStageAttempt; lineage: StageLineage } | null {
  const target = canonical(conversationId);
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (let index = run.attempts.length - 1; index >= 0; index -= 1) {
        const attempt = run.attempts[index]!;
        if (attempt.historical || !attempt.conversationId || canonical(attempt.conversationId) !== target) continue;
        return {
          pipeline,
          attempt,
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

function appendDenial(attempt: PipelineStageAttempt, denial: PermissionDenialRecord): void {
  const denials = attempt.permissionDenials ?? [];
  if (denials.some((existing) => existing.requestId === denial.requestId)) return;
  const entry: PipelinePermissionDenial = {
    requestId: denial.requestId,
    tool: denial.tool,
    command: denial.command,
    reason: denial.reason,
    reasonType: denial.reasonType,
    mode: denial.mode,
    deniedAt: denial.deniedAt,
  };
  attempt.permissionDenials = [...denials, entry].slice(-ATTEMPT_DENIAL_CAPACITY);
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
  readPipelines?: () => readonly Pipeline[];
  appendLifecycle?: typeof appendLifecycleEvents;
  /** Pause before repeating an attempt write the lease refused. */
  busyRetryDelayMs?: number;
}

/** One line for the journal: which tool, why it was denied, the engine's reason. */
export function permissionDenialSummary(denial: Pick<PermissionDenialRecord, "tool" | "reason" | "mode">): string {
  const why = denial.mode === "unattended" ? "no one can approve it here" : "unanswered for 10 minutes";
  return `Denied ${denial.tool ?? "a tool"} permission (${why})${denial.reason ? `: ${denial.reason}` : ""}`;
}

export function permissionDenialRecorder(dependencies: PermissionDenialRecorderDependencies) {
  const mutate = dependencies.mutatePipelines ?? withPipelineMutation;
  const read = dependencies.readPipelines ?? loadPipelinesForList;
  const append = dependencies.appendLifecycle ?? appendLifecycleEvents;
  const retryDelayMs = dependencies.busyRetryDelayMs ?? BUSY_RETRY_DELAY_MS;
  const canonical = (id: string): string => id.startsWith("conversation_")
    ? dependencies.registry.canonicalConversationId(id as ViewerConversationId)
    : id;
  return async (denial: PermissionDenialRecord): Promise<void> => {
    /* The lineage comes from a read, which takes no lease, so the journal line
       names the stage even when the attempt write below cannot get in. The
       write still runs when the read found nothing: the cached read can trail
       an attempt that was just created. */
    let lineage: StageLineage | null = null;
    try {
      lineage = locateAttempt(read(), denial.conversationId, canonical)?.lineage ?? null;
    } catch (error) {
      console.error("[permission guard] pipelines could not be read for the denial's stage", error);
    }
    /* A lease held across a long controller pass refuses before admission;
       nothing ran, so the same write is safe to repeat. */
    for (let attempt = 1; attempt <= ATTEMPT_WRITE_TRIES; attempt += 1) {
      try {
        lineage = await mutate((pipelines, persist) => {
          const located = locateAttempt(pipelines, denial.conversationId, canonical);
          if (!located) return null;
          appendDenial(located.attempt, denial);
          persist([located.pipeline]);
          return located.lineage;
        }) ?? lineage;
        break;
      } catch (error) {
        if (error instanceof StoreBusyBeforeAdmissionError && attempt < ATTEMPT_WRITE_TRIES) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
          continue;
        }
        console.error("[permission guard] stage attempt could not record the denial", error);
        break;
      }
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
