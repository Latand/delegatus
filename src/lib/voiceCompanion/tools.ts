import { READ_TOOL_NAMES, type CompanionBoardReads } from "./boardReads";
import type { CallRequest, CompanionAdmission, OperatorAttempt } from "./admission";
import { DELEGATION_REASONS, deliveryFailureReason } from "./delegationOutcome";
import { liveEndRefusal, requestText, VOICE_ASK_MAX_CHARS } from "./liveGate";
import { READ_SCHEMAS, validToolValue, type ToolProperty } from "./readSchemas";

export interface CompanionToolContext {
  project: string | null;
  sessionId: string;
  callId: string;
  delegationId: string;
  /** Confirmation visible when this backend answer turn was created. */
  confirmationProposalId?: string | null;
  /** The operator's Live turn when Live delegated. */
  sourceTurn?: number;
  /** The operator's latest attempt this delegation answers: later than `sourceTurn` once operator words were steered into it. */
  attempt?: OperatorAttempt;
  admission: CompanionAdmission;
  reads: CompanionBoardReads;
  read?(name: string, args: Record<string, unknown>): Promise<unknown>;
  endConversation(): void;
}
/** A strict schema lists every property as required; one the model may leave out is nullable. */

interface ToolEntry {
  name: string;
  description: string;
  capability: string;
  class: "board-read" | "call-read" | "delegation" | "session-control";
  parameters: { type: "object"; properties: Record<string, ToolProperty>; required: string[]; additionalProperties: false };
  handler(context: CompanionToolContext, args: Record<string, unknown>): unknown | Promise<unknown>;
}

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
  if (outcome.state === "awaiting_report") return { status: "awaiting_report", request: outcome.request.handle, sentMinutesAgo: outcome.request.sentMinutesAgo,
    progressReports: outcome.request.progressReports, ...(outcome.report ? { latestReport: outcome.report } : {}),
    speech: `${outcome.request.askedBack ? "Nothing new was sent: the orchestrator asked back about this request and waits for the operator. Relay its question from latestReport in its words; the operator's answer is a new ask."
      : "Nothing new was sent: the orchestrator already has this question and its answer has not arrived yet. Tell the operator in one short sentence that the answer is on its way. For news now, read orchestrator_messages."} If the operator's latest turn also asked something new, send only that new part as its own short ask with pending_request null.` };
  if (outcome.state === "answered") return { status: "answered", request: outcome.request.handle, ...(outcome.report ? { report: outcome.report } : {}),
    speech: outcome.report ? "Nothing was sent: the orchestrator already answered this. Answer from its report, keeping each fact with its own subject, in its words."
      : "Nothing was sent: the orchestrator already answered this. Read orchestrator_reports for its answer." };
  if (outcome.state === "awaiting") return { status: "awaiting_confirmation", reason: outcome.proposal.confirmation?.reason ?? "",
    speech: "Nothing has been sent. Tell the operator in one sentence what would be sent and why you ask, and ask whether to send it. Their spoken yes or no comes back through resolve_orchestrator_confirmation; the card's buttons answer it too." };
  const reason = DELEGATION_REASONS[outcome.code];
  if (outcome.code === "request_other_project") return { status: "refused", code: outcome.code, reason,
    speech: "Nothing was sent. The handle names a request to another project. If the operator asks this project something new, call again with pending_request null; if they repeat the other project's request, pass that project by name." };
  return { status: "refused", code: outcome.code, reason, speech: `Nothing was sent. Tell the operator this reason in plain words and add none: ${reason}` };
}

/** A waiting request as the backend sees it: its handle, its words and how long it has waited. */
export const waitingRequest = (request: CallRequest) => ({ request: request.handle, ask: request.instruction,
  sentMinutesAgo: request.sentMinutesAgo, progressReports: request.progressReports, ...(request.askedBack ? { orchestratorAskedBack: true } : {}) });

const READ_CAPABILITIES: Record<typeof READ_TOOL_NAMES[number], { capability: string; description: string }> = {
  list_tasks: { capability: "Board tasks: the project's tasks by status, newest first.", description: "Read the project's tasks by status, newest first." },
  get_task: { capability: "One task: its note, hold and steps.", description: "Read one project's task with its note, hold and steps. taskId is a handle returned by list_tasks." },
  list_pipelines: { capability: "Pipelines: the project's pipelines by state, newest first.", description: "Read the project's pipelines by state, newest first." },
  get_pipeline: { capability: "One pipeline: its stages and where each stands.", description: "Read one project's pipeline and its stages. pipelineId is a handle returned by list_pipelines." },
  agent_activity: { capability: "Running agents: who is working on the project now.", description: "Read agents currently working on this project and their conversation handles." },
  conversation_messages: { capability: "Conversation messages: any conversation of the selected project, newest first.", description: "Read a project conversation by its handle, including inactive conversations; follow the opaque cursor for older messages." },
  orchestrator_messages: { capability: "Orchestrator messages: what the selected project's current orchestrator said lately.", description: "Read the current orchestrator's conversation, newest first. By default only its own words; pass roles user and assistant to also see what it was sent. A project name selects another project's orchestrator." },
  search_transcripts: { capability: "Search: find project conversations by what was said in them.", description: "Search project conversation text. A project name selects another project; unknown or ambiguous names are refused." },
  read_prototype_review: { capability: "Prototype reviews: find waiting reviews by project or words, and read one compact round with every variant, question, recommendation and saved decision.", description: "With taskId null, find reviews by the operator's words in query (round title, variants, questions or task); query null lists waiting reviews. One match returns that round with complete descriptions, questions, options, recommendations, saved answers and exact comment, frame counts and available views. Several matches return taskId/reviewId rows. A supplied taskId selects its waiting or latest round; reviewId selects an earlier round. Pictures have not been viewed by this read. Makes no choice and sends nothing." },
  view_prototype_frame: { capability: "Prototype frames: compare up to three variants by view, width and language, through pictures the backend inspects.", description: "Use the same taskId or query from read_prototype_review, with up to three variant numbers, view words, width and language. Returns stored pictures in variant order, or their originals with original true. The backend receives each image; the speaking model speaks its description. Missing pictures are named explicitly. Say what a picture shows only after it was attached in this conversation, naming variant and view. Makes no decision and sends nothing." },
};

/** Definitions, execution allowlist, argument validation and project admission
 * have one owner. No general MCP tool inventory enters a voice session. */
export const COMPANION_TOOL_REGISTRY: readonly ToolEntry[] = [
  ...READ_TOOL_NAMES.map((name): ToolEntry => ({ name, class: "board-read",
    ...READ_CAPABILITIES[name],
    parameters: schema(READ_SCHEMAS[name]),
    handler: (context, args) => context.read ? context.read(name,args) : context.reads.call(context.reads.resolveProject(context.project, typeof args.project === "string" ? args.project : undefined),name,args),
  })),
  { name: "orchestrator_reports", capability: "Reports: what the orchestrator reported during this call, and which requests still wait for its answer.", class: "call-read",
    description: "Read this call's requests to the orchestrator, each with its handle, whether its answer arrived and the answering report whole, and the latest other reports, whole. Read it before sending when the operator asks about something already sent. Sends nothing.",
    parameters: schema(),
    handler: context => {
      const read = context.admission.callReports(context.sessionId);
      const waiting = read.requests.filter(row => row.state === "waiting_for_report").length;
      return { ...read, speech: `${read.requests.length} request(s) sent in this call, ${waiting} still waiting for the orchestrator's report; ${read.reports.length} other report(s) shown.` };
    } },
  { name: "reread_orchestrator_report", capability: "Read a report again: reads a report from this call to the operator once more, whole and in its own words.", class: "call-read",
    description: "When the operator asks to hear a report again, whole, or an answer the orchestrator already gave, call this instead of retelling it: the report is read to the operator from its own text, every item in order. report is a report handle (k…) or a request handle (r…) from orchestrator_reports, or null for the latest report of this call. Afterwards answer with one short sentence that introduces it and never restate its contents. Sends nothing.",
    parameters: schema({ report: { type: ["string", "null"], maxLength: 16, description: "A report or request handle from orchestrator_reports; null for the latest report of this call." } }),
    handler: (context, args) => {
      const result = context.admission.rereadReport(context.sessionId, typeof args.report === "string" && args.report.trim() ? args.report.trim() : null, context.delegationId);
      return result.status === "not_found" ? { status: "not_found", speech: "No such report in this call. Read orchestrator_reports for the handles, or say that no report has arrived yet." }
        : { status: "reading", report: result.report, speech: "The report is read to the operator from its own text right after your answer. Say one short sentence that introduces it; never restate, shorten or summarize it." };
    } },
  { name: "request_orchestrator_delegation", capability: "Send to the orchestrator: sends the operator's request to the project's orchestrator at once; its answer comes back to you as a report.", class: "delegation",
    description: `Send one short ask to the project's orchestrator when the operator explicitly asks to send work or a question to it, and the board, its messages and its reports cannot answer it. The instruction is the operator's latest request in their own words and language, at most ${VOICE_ASK_MAX_CHARS} characters: never translated, expanded, or bundled with earlier questions. It is delivered at once, with no confirmation. Asking first is the exception and your own judgment: set confirmation_reason to one short sentence only when the action is critical or hard to undo, or when you are unsure you understood the request; then nothing is sent until the operator answers. In every other case pass null. When the ask repeats or rephrases a request whose report has not arrived, pass its handle in pending_request: nothing is sent and the operator hears that the answer is on its way. When one turn repeats a waiting request and also asks something new, pass the repeat with its handle and send the new part as its own ask. Words that match a request already raised in an earlier turn are a repeat and send nothing, unless the operator explicitly asked to send it once more and you set asked_again: then it is sent again, also while its report is pending. Input transcripts are optional context.`,
    // The schema keeps the old envelope, so an overlong ask reaches the handler and is recomposed rather than failing validation.
    parameters: schema({ project: { ...READ_SCHEMAS.list_tasks.project, description: "null sends to the project currently in view. A name only when the operator named another project; never guess one." },
      instruction: { type: "string", minLength: 1, maxLength: 2_000, description: `One short ask, at most ${VOICE_ASK_MAX_CHARS} characters, in the operator's words and language.` },
      pending_request: { type: ["string", "null"], maxLength: 16, description: "The handle of a request still waiting for its report that this ask repeats or rephrases; null for a new question or new work." },
      confirmation_reason: { type: ["string", "null"], maxLength: 240, description: "Why the operator should confirm first, in the operator's language; null to send at once." },
      asked_again: { type: ["string", "null"], maxLength: 240, description: "Only when the operator, in their latest turn, explicitly asks to send once more a request you raised earlier in this call (sent or cancelled): one short sentence with what they asked. Otherwise null. Never set it to repeat a request on your own." } }),
    handler: async (context, args) => {
      const instruction = args.instruction as string;
      if ([...instruction.trim()].length > VOICE_ASK_MAX_CHARS) return { status: "too_long", speech: `Nothing was sent. The ask is longer than ${VOICE_ASK_MAX_CHARS} characters. Recompose it as one short ask in the operator's own words and language, with only their latest request, and call again.` };
      const project = context.reads.resolveProject(context.project,typeof args.project === "string" ? args.project : undefined);
      const pendingRequest = typeof args.pending_request === "string" && args.pending_request.trim() ? args.pending_request.trim() : undefined;
      const askedAgain = typeof args.asked_again === "string" && !!args.asked_again.trim();
      // Before a new send, the backend sees what already waits for a report, once per delegation.
      const unseen = pendingRequest || askedAgain ? [] : context.admission.unseenAwaiting(context.sessionId, context.delegationId, project);
      // The same words as a waiting request need no check: admission answers them as waiting.
      if (unseen.length && !unseen.some(request => requestText(request.instruction) === requestText(instruction))) {
        context.admission.showAwaiting(context.sessionId, context.delegationId, unseen.map(request => request.proposalId));
        return { status: "check_waiting", waiting: unseen.map(waitingRequest),
          speech: "Nothing was sent yet. These requests already wait for the orchestrator's report. If the operator's ask repeats or rephrases one of them, call again with pending_request set to its handle. If it is a new question or new work, call again with pending_request null." };
      }
      const before = new Set(context.admission.awaitingReports(context.sessionId).map(request => request.proposalId));
      const outcome = await context.admission.delegate(context.sessionId, context.callId, context.delegationId, instruction,
        { project, sourceTurn: context.sourceTurn, ...(pendingRequest ? { pendingRequest } : {}), ...(askedAgain ? { renewed: true, ...(context.attempt ? { attempt: context.attempt } : {}) } : {}), ...(typeof args.confirmation_reason === "string" && args.confirmation_reason.trim() ? { confirmation: args.confirmation_reason } : {}) });
      // A request this delegation sent is known to it.
      context.admission.showAwaiting(context.sessionId, context.delegationId,
        context.admission.awaitingReports(context.sessionId).map(request => request.proposalId).filter(proposalId => !before.has(proposalId)));
      // An answer already given is read again from the report's own text, never retold.
      if (outcome.state === "answered" && outcome.report && context.admission.rereadReport(context.sessionId, outcome.request.handle, context.delegationId).status !== "not_found")
        return { status: "answered", request: outcome.request.handle, report: outcome.report,
          speech: "Nothing was sent: the orchestrator already answered this, and its report is read to the operator from its own text right after your answer. Say one short sentence that introduces it; never restate, shorten or summarize it." };
      return spoken(outcome);
    } },
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
      context.admission.showAwaiting(context.sessionId, context.delegationId, [proposal.proposalId]);
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
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_TOOL_ARGUMENTS");
  const values = args as Record<string, unknown>;
  const properties = entry.parameters.properties;
  if (Object.keys(values).some(key => !Object.hasOwn(properties, key))
    || entry.parameters.required.some(key => !validToolValue(properties[key],values[key]))) throw new Error("INVALID_TOOL_ARGUMENTS");
  return entry.handler(context, values);
}
