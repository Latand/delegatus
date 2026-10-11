import { attentionReason } from "@/components/attention";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import type { ConversationReasonKind, LaneReasonKind } from "./dismissalTypes";
import { conversationRouteKey, laneNeedKind, laneRouteKey, type AttentionEscalationMark, type AttentionRouteMark } from "./routeTypes";

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
    a prose ask (send_message reaches the asking conversation), a memory kill
    (resume it or close it), and a tool permission the automatic answer could
    not settle (conversation_action permission). A native question or plan
    waits on a control only the conversation's own surface answers, so it
    stays the operator's; a delivery, a launch and an orchestrator's report are
    the operator's by what they are. */
export const SEAT_CONVERSATION_KINDS: ReadonlySet<ConversationReasonKind> = new Set(["ask", "memory", "permission"]);

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
}

export interface AttentionRoute {
  route: AttentionRouteMark | null;
  escalation: AttentionEscalationMark | null;
}

const OPERATOR: AttentionRoute = { route: null, escalation: null };

/** A wait a seat answers, or the operator's once that seat escalated it. */
function seatRoute(key: string, seat: string, inputs: AttentionRoutingInputs): AttentionRoute {
  const escalation = inputs.escalation(key);
  return escalation ? { route: null, escalation } : { route: { key, owner: "seat", seat }, escalation: null };
}

/** Who answers one conversation's current reason; both null for the operator. */
export function conversationRoute(file: FileEntry, now: number, inputs: AttentionRoutingInputs): AttentionRoute {
  const reason = attentionReason({ ...file, attentionRoute: undefined, attentionEscalation: undefined }, now);
  if (!reason || reason.report || !SEAT_CONVERSATION_KINDS.has(reason.kind) || !delegatedConversation(file)) return OPERATOR;
  if (file.conversationId && inputs.isSeatConversation(file.conversationId)) return OPERATOR;
  const seat = inputs.seatFor(inputs.canonicalProject(file.project));
  if (!seat || seat === file.conversationId) return OPERATOR;
  return seatRoute(conversationRouteKey(reason.id), seat, inputs);
}

/** Who answers what one lane waits on; both null for the operator. */
export function laneRoute(pipeline: Pipeline, inputs: AttentionRoutingInputs): AttentionRoute {
  const kind = laneNeedKind(pipeline);
  if (!kind) return OPERATOR;
  const key = laneRouteKey(pipeline, kind);
  if (kind === "lane-decision" && laneAwaitsAutomaticRetry(pipeline)) return { route: { key, owner: "system" }, escalation: null };
  const seat = inputs.seatFor(inputs.canonicalProject(pipeline.project));
  if (!seat || laneReservedForOperator(pipeline, kind)) return OPERATOR;
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
    delete file.attentionEscalation;
    if (file.supersededBy || file.migratedTo) continue;
    const { route, escalation } = conversationRoute(file, now, inputs);
    if (route) file.attentionRoute = route;
    if (escalation) file.attentionEscalation = escalation;
  }
  for (const pipeline of pipelines) {
    delete pipeline.attentionRoute;
    delete pipeline.attentionEscalation;
    const { route, escalation } = laneRoute(pipeline, inputs);
    if (route) pipeline.attentionRoute = route;
    if (escalation) pipeline.attentionEscalation = escalation;
  }
}
