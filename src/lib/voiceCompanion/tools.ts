import { canonicalProject } from "@/lib/projects/aliases";
import { READ_TOOL_NAMES, type CompanionBoardReads } from "./boardReads";
import type { CompanionAdmission } from "./admission";
import { DELEGATION_REASONS, deliveryFailureReason } from "./delegationOutcome";
import { liveEndRefusal } from "./liveGate";

export interface CompanionToolContext {
  project: string;
  sessionId: string;
  callId: string;
  delegationId: string;
  /** Confirmation visible when this backend answer turn was created. */
  confirmationProposalId?: string | null;
  /** The operator's Live turn when Live delegated. */
  sourceTurn?: number;
  admission: CompanionAdmission;
  reads: CompanionBoardReads;
  endConversation(): void;
}
/** A strict schema lists every property as required; one the model may leave out is nullable. */
type ToolProperty = { type: "string" | readonly ["string", "null"]; description?: string; minLength?: number; maxLength?: number; enum?: readonly string[] };
interface ToolEntry {
  name: string;
  description: string;
  capability: string;
  class: "board-read" | "delegation" | "session-control";
  parameters: { type: "object"; properties: Record<string, ToolProperty>; required: string[]; additionalProperties: false };
  handler(context: CompanionToolContext, args: Record<string, unknown>): unknown | Promise<unknown>;
}
const handle = { type: "string" as const, minLength: 1, maxLength: 128 };
const schema = (properties: ToolEntry["parameters"]["properties"] = {}): ToolEntry["parameters"] =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SENT = { delivered: "Sent to the orchestrator.", queued: "Sent. It is queued for the orchestrator.",
  unknown: "The request was sent, and its delivery is not confirmed yet. Say exactly that." };
function spoken(outcome: Awaited<ReturnType<CompanionAdmission["delegate"]>>) {
  if (outcome.state === "sent") {
    if (outcome.status === "failed") {
      const reason = deliveryFailureReason(outcome.failureCode);
      return { status: "failed", delivery: outcome.status, code: outcome.failureCode, reason, speech: reason };
    }
    return { status: "sent", delivery: outcome.status, speech: SENT[outcome.status] };
  }
  if (outcome.state === "awaiting") return { status: "awaiting_confirmation", reason: outcome.proposal.confirmation?.reason ?? "",
    speech: "Nothing has been sent. Tell the operator in one sentence what would be sent and why you ask, and ask whether to send it. Their spoken yes or no comes back through resolve_orchestrator_confirmation; the card's buttons answer it too." };
  const reason = DELEGATION_REASONS[outcome.code];
  return { status: "refused", code: outcome.code, reason, speech: `Nothing was sent. Tell the operator this reason in plain words and add none: ${reason}` };
}

const READ_CAPABILITIES: Record<typeof READ_TOOL_NAMES[number], { capability: string; description: string }> = {
  list_tasks: { capability: "Board tasks: the project's tasks and their states.", description: "Read the project's tasks and their states." },
  get_task: { capability: "One task: its note, hold and steps.", description: "Read one project's task with its note, hold and steps. taskId is a handle returned by list_tasks." },
  list_pipelines: { capability: "Pipelines: the project's pipelines and their states.", description: "Read the project's pipelines and their states." },
  get_pipeline: { capability: "One pipeline: its stages and where each stands.", description: "Read one project's pipeline and its stages. pipelineId is a handle returned by list_pipelines." },
  agent_activity: { capability: "Running agents: who is working on the project now.", description: "Read agents currently working on this project and their conversation handles." },
  conversation_messages: { capability: "Agent messages: the latest messages of one running agent.", description: "Read the latest messages of one running agent in this project. conversationId is a handle returned by agent_activity. This reads agent messages; the voice session transcript is separate." },
};

/** Definitions, execution allowlist, argument validation and project admission
 * have one owner. No general MCP tool inventory enters a voice session. */
export const COMPANION_TOOL_REGISTRY: readonly ToolEntry[] = [
  ...READ_TOOL_NAMES.map((name): ToolEntry => ({ name, class: "board-read",
    ...READ_CAPABILITIES[name],
    parameters: schema(name === "get_task" ? { taskId: handle } : name === "get_pipeline" ? { pipelineId: handle }
      : name === "conversation_messages" ? { conversationId: handle } : {}),
    handler: (context, args) => context.reads.call(context.project, name, args),
  })),
  { name: "request_orchestrator_delegation", capability: "Send to the orchestrator: sends the operator's request to the project's orchestrator at once; its answer comes back to you as a report.", class: "delegation",
    description: "Send the complete request text to the project's orchestrator when the operator explicitly asks to send work to it. It is delivered at once, with no confirmation. Asking first is the exception and your own judgment: set confirmation_reason to one short sentence only when the action is critical or hard to undo, or when you are unsure you understood the request; then nothing is sent until the operator answers. In every other case pass null. Words that match a request already raised in an earlier turn are a repeat and send nothing, unless the operator asked again and you set asked_again. Input transcripts are optional context.",
    parameters: schema({ instruction: { type: "string", minLength: 1, maxLength: 2_000 },
      confirmation_reason: { type: ["string", "null"], maxLength: 240, description: "Why the operator should confirm first, in the operator's language; null to send at once." },
      asked_again: { type: ["string", "null"], maxLength: 240, description: "Only when the operator, in their latest turn, explicitly asks to send once more a request you raised earlier in this call (sent or cancelled): one short sentence with what they asked. Otherwise null. Never set it to repeat a request on your own." } }),
    handler: async (context, args) => spoken(await context.admission.delegate(context.sessionId, context.callId, context.delegationId, args.instruction as string,
      { sourceTurn: context.sourceTurn, ...(typeof args.asked_again === "string" && args.asked_again.trim() ? { renewed: true } : {}), ...(typeof args.confirmation_reason === "string" && args.confirmation_reason.trim() ? { confirmation: args.confirmation_reason } : {}) })) },
  { name: "resolve_orchestrator_confirmation", capability: "Confirmation answer: passes on the operator's yes or no to a request you asked about.", class: "delegation",
    description: "Pass on the operator's spoken answer to the confirmation that is waiting: send when they clearly agree, cancel when they decline or change their mind. When the answer is unclear, ask again and call nothing. A cancelled confirmation sends nothing; say so.",
    parameters: schema({ decision: { type: "string", enum: ["send", "cancel"] } }),
    handler: async (context, args) => {
      const proposal = context.admission.awaiting(context.sessionId, context.confirmationProposalId);
      if (!proposal) {
        // Speech that took the request back, or time, may have ended it before this answer arrived.
        const last = context.admission.lastAsked(context.sessionId);
        const ended = last ? context.admission.outcome(context.sessionId, last.proposalId) : null;
        return ended?.state === "refused" ? spoken(ended) : { status: "nothing_waiting", speech: "No confirmation is waiting. Nothing was sent by this answer." };
      }
      // The model resolved the operator's spoken answer. Admission still binds
      // the decision to this pending proposal and rechecks withdrawal and expiry.
      const answer = await context.admission.confirm(context.sessionId, { proposalId: proposal.proposalId, decision: args.decision as "send" | "cancel", via: "speech", sourceTurn: context.sourceTurn });
      return spoken(answer ?? context.admission.outcome(context.sessionId, proposal.proposalId));
    } },
  { name: "end_conversation", capability: "End the call: hangs up when the operator asks to finish the conversation.", class: "session-control",
    description: "End this entire voice conversation only after an explicit operator request to hang up or finish the call. Finishing a task, quoted words and conditional requests are insufficient. Offer a short goodbye before calling when possible.",
    parameters: schema(),
    // The description asks the model; this reads the operator's own words before anything ends.
    handler: context => {
      const code = liveEndRefusal(context.admission.session(context.sessionId).inputs, context.sourceTurn);
      if (code) return { status: "refused", code, speech: "The operator did not ask to end the call. The call continues." };
      context.endConversation();
      return { status: "ending", speech: "The conversation is ending." };
    } },
];

export const COMPANION_TOOLS = COMPANION_TOOL_REGISTRY.map(({ name, description, parameters }) =>
  ({ type: "function" as const, name, description, strict: true, parameters }));

export async function runCompanionTool(context: CompanionToolContext, name: string, args: unknown): Promise<unknown> {
  const entry = COMPANION_TOOL_REGISTRY.find(tool => tool.name === name);
  if (!entry) throw new Error("TOOL_NOT_ALLOWED");
  const session = context.admission.session(context.sessionId);
  if (session.closed) throw new Error("SESSION_CLOSED");
  if (canonicalProject(context.project) !== canonicalProject(session.project)) throw new Error("PROJECT_REFUSED");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_TOOL_ARGUMENTS");
  const values = args as Record<string, unknown>;
  const properties = entry.parameters.properties;
  if (Object.keys(values).some(key => !Object.hasOwn(properties, key))
    || entry.parameters.required.some(key => {
      const value = values[key]; const property = properties[key];
      if (value === null || value === undefined) return property.type === "string";
      return typeof value !== "string" || value.trim().length < (property.minLength ?? 0) || value.length > (property.maxLength ?? 2_000)
        || (!!property.enum && !property.enum.includes(value));
    })) throw new Error("INVALID_TOOL_ARGUMENTS");
  return entry.handler({ ...context, project: canonicalProject(session.project) }, values);
}
