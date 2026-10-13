import { attentionReason } from "@/components/attention";
import type { Pipeline } from "@/lib/pipelines/types";
import { prototypeReviewNotices } from "@/lib/prototypeReview/model";
import type { PrototypeReviewNotice } from "@/lib/prototypeReview/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { ConversationReasonKind, LaneReasonKind } from "./dismissalTypes";
import { conversationRouteKey, laneNeedKind, laneRouteKey, laneWaitCleared, type AttentionEscalationMark, type AttentionRouteMark } from "./routeTypes";

/*
 * Who answers a needs-you reason first (docs/design/attention-auto-resolve.md,
 * «Implementation plan for acceptance 3»): the operator, the project's
 * designated seat, or nobody because an automatic retry already owns it.
 * Pure and browser-safe; `/api/files` stamps the answer onto the conversation
 * or lane it names, and the reason model (`attentionReason`, `laneNeed`,
 * `pipelineAsks`) reads the stamp, so the header, both panels, the cards, the
 * rail and the project read count the same operator slice. The seat tick reads
 * the same stamps to wake the seat with the ask.
 */

/** A worker's reasons its project seat can act on with tools it already has:
    a prose ask (send_message reaches the asking conversation), a native
    question or plan (conversation_action answer chooses an option on that
    exact request), a memory kill (resume it or close it), and a tool
    permission the automatic answer could not settle (conversation_action
    permission). A delivery, a launch and an orchestrator's report are the
    operator's by what they are. */
export const SEAT_CONVERSATION_KINDS: ReadonlySet<ConversationReasonKind> = new Set(["ask", "question", "plan", "memory", "permission"]);

/** A conversation the product launched for an agent: a pipeline stage, a
    review round, or a delegated child. The registry's delegation record, as
    a failed launch and the permission guard read it. */
export function delegatedConversation(file: Pick<FileEntry, "durableLineage">): boolean {
  const lineage = file.durableLineage;
  if (!lineage || lineage.memberships.some((membership) => membership.kind === "orchestrator")) return false;
  return (lineage.depth ?? 0) > 0 || lineage.memberships.some((membership) => membership.kind === "pipeline" || membership.kind === "flow");
}

/**
 * A parked lane the engine will retry by itself: a provider quota or
 * condition wait that owes a fresh attempt once its reset passes. Nobody has
 * to answer it, and a control change or a different park cancels the retry,
 * which brings the lane back to whoever owns it.
 */
export function laneAwaitsAutomaticRetry(pipeline: Pipeline): boolean {
  if (pipeline.state !== "needs_decision") return false;
  const stageId = pipeline.cursor?.stageId;
  const attempt = stageId ? pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) : undefined;
  const wait = attempt?.providerWait;
  return Boolean(wait?.stageRetry && !wait.retryCancelled && Number.isFinite(Date.parse(wait.resumeAt)));
}

/**
 * Whether the operator reserved this wait for themselves: a lane they created
 * by hand that stopped after its last fix waits for their acceptance of a
 * head no reviewer saw. Every other spent review budget is the lane creator's
 * or the seat's to accept.
 */
export function laneReservedForOperator(pipeline: Pick<Pipeline, "srcConversationId">, kind: LaneReasonKind): boolean {
  return kind === "lane-review" && !pipeline.srcConversationId;
}

/** The decision rounds that still need an answer, by round id. A decided
    round's delivery warning keeps its own row while the original wait goes
    back to the seat. `tasks` carry the board summary and dismissal marks;
    taskless forms carry the seat notices the board draws. */
export function waitingRoundIds(tasks: readonly BoardTask[], seatDecisions: readonly PrototypeReviewNotice[] = []): Set<string> {
  return new Set(prototypeReviewNotices(tasks, seatDecisions).filter((notice) => !notice.undelivered).map((notice) => notice.reviewId));
}

export interface AttentionRoutingInputs {
  /** The designated seat of a canonical project whose tick can wake it, or
      null when the project has none (or its tick is off): then nothing is
      routed and the operator answers. */
  seatFor(project: string): string | null;
  canonicalProject(project: string): string;
  /** Whether a conversation holds or held a seat. Its asks are the seat's own
      questions to the operator, never a worker's. */
  isSeatConversation(conversationId: string): boolean;
  /** The seat's escalation of this exact wait, when it made one. */
  escalation(key: string): AttentionEscalationMark | null;
  /** Whether a decision round still waits on the operator: published, not
      decided, not dismissed and not replaced by a newer round. */
  formWaiting(reviewId: string): boolean;
}

/** Who answers a wait; null for the operator. */
export type AttentionRoute = AttentionRouteMark | null;

const OPERATOR: AttentionRoute = null;

/** The decision form's route while the round the seat escalated this wait to
    still waits on the operator, or null. It holds whether or not the seat can
    be woken now: the form's row is already the operator's one row for it. */
function formRoute(key: string, inputs: AttentionRoutingInputs): AttentionRoute {
  const escalation = inputs.escalation(key);
  if (!escalation || !inputs.formWaiting(escalation.reviewId)) return null;
  return { key, owner: "form", ...(escalation.seat ? { seat: escalation.seat } : {}), form: { taskId: escalation.taskId, reviewId: escalation.reviewId } };
}

/** A wait the seat answers. One its escalation handed back (the operator
    decided the round, dismissed it, or a newer round replaced it) names that
    round, so the seat is woken once more for the wait it holds again. */
function seatRoute(key: string, seat: string, inputs: AttentionRoutingInputs): AttentionRoute {
  const escalation = inputs.escalation(key);
  return { key, owner: "seat", seat, ...(escalation ? { returnedFrom: escalation.reviewId } : {}) };
}

/** Who answers one conversation's current reason; null for the operator. */
export function conversationRoute(file: FileEntry, now: number, inputs: AttentionRoutingInputs): AttentionRoute {
  const reason = attentionReason({ ...file, attentionRoute: undefined }, now);
  if (!reason || reason.report || !SEAT_CONVERSATION_KINDS.has(reason.kind) || !delegatedConversation(file)) return OPERATOR;
  if (file.conversationId && inputs.isSeatConversation(file.conversationId)) return OPERATOR;
  const key = conversationRouteKey(reason.id);
  const form = formRoute(key, inputs);
  if (form) return form;
  const seat = inputs.seatFor(inputs.canonicalProject(file.project));
  if (!seat || seat === file.conversationId) return OPERATOR;
  return seatRoute(key, seat, inputs);
}

/** Who answers what one lane waits on; null for the operator. */
export function laneRoute(pipeline: Pipeline, inputs: AttentionRoutingInputs): AttentionRoute {
  const kind = laneNeedKind(pipeline);
  if (!kind) return OPERATOR;
  /* A wait someone already cleared («Leave the PR open», a dismissed
     decision) is answered: nobody is woken for it, and the card says who
     cleared it (docs/design/calm-task-cards-build.md §7.3). */
  if (laneWaitCleared(pipeline)) return OPERATOR;
  const key = laneRouteKey(pipeline, kind);
  if (kind === "lane-decision" && laneAwaitsAutomaticRetry(pipeline)) return { key, owner: "system" };
  if (laneReservedForOperator(pipeline, kind)) return OPERATOR;
  const form = formRoute(key, inputs);
  if (form) return form;
  const seat = inputs.seatFor(inputs.canonicalProject(pipeline.project));
  if (!seat) return OPERATOR;
  return seatRoute(key, seat, inputs);
}

/**
 * Stamp each conversation and lane with who answers it. A stamp is replaced
 * on every projection, so a reason that changed carries none until it is
 * routed afresh, and a project whose seat went away routes nothing.
 */
export function stampAttentionRoutes(files: readonly FileEntry[], pipelines: readonly Pipeline[], now: number, inputs: AttentionRoutingInputs): void {
  for (const file of files) {
    delete file.attentionRoute;
    if (file.supersededBy || file.migratedTo) continue;
    const route = conversationRoute(file, now, inputs);
    if (route) file.attentionRoute = route;
  }
  for (const pipeline of pipelines) {
    delete pipeline.attentionRoute;
    const route = laneRoute(pipeline, inputs);
    if (route) pipeline.attentionRoute = route;
  }
}
