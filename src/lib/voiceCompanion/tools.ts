import { canonicalProject } from "@/lib/projects/aliases";
import { READ_TOOL_NAMES, type CompanionBoardReads } from "./boardReads";
import type { CompanionAdmission } from "./admission";
import { liveEndRefusal } from "./liveGate";

export interface CompanionToolContext {
  project: string;
  sessionId: string;
  callId: string;
  delegationId: string;
  /** The operator's Live turn when Live delegated. */
  sourceTurn?: number;
  admission: CompanionAdmission;
  reads: CompanionBoardReads;
  endConversation(): void;
}
interface ToolEntry {
  name: string;
  description: string;
  class: "board-read" | "proposal" | "session-control";
  parameters: { type: "object"; properties: Record<string, { type: "string"; minLength: number; maxLength: number }>; required: string[]; additionalProperties: false };
  handler(context: CompanionToolContext, args: Record<string, unknown>): unknown | Promise<unknown>;
}
const handle = { type: "string" as const, minLength: 1, maxLength: 128 };
const schema = (properties: ToolEntry["parameters"]["properties"] = {}): ToolEntry["parameters"] =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

/** Definitions, execution allowlist, argument validation and project admission
 * have one owner. No general MCP tool inventory enters a voice session. */
export const COMPANION_TOOL_REGISTRY: readonly ToolEntry[] = [
  ...READ_TOOL_NAMES.map((name): ToolEntry => ({ name, class: "board-read",
    description: `Read ${name.replaceAll("_", " ")} on the current project. Summarize calmly; never speak handles.`,
    parameters: schema(name === "get_task" ? { taskId: handle } : name === "get_pipeline" ? { pipelineId: handle }
      : name === "conversation_messages" ? { conversationId: handle } : {}),
    handler: (context, args) => context.reads.call(context.project, name, args),
  })),
  { name: "request_orchestrator_delegation", class: "proposal",
    description: "Propose the complete request text only when the operator explicitly asks to send work to the orchestrator. Sends nothing. The operator must tap Send on the full-text card. Input transcripts are optional context.",
    parameters: schema({ instruction: { type: "string", minLength: 1, maxLength: 2_000 } }),
    handler: (context, args) => {
      const proposal = context.admission.propose(context.sessionId, context.callId, context.delegationId, args.instruction as string, context.sourceTurn);
      const last = context.admission.events(context.sessionId, 0).at(-1);
      const code = last?.type === "delegation.tool.result" && "code" in last.result ? last.result.code : "not_admitted";
      return proposal ? { status: "awaiting_tap", speech: "A proposal is shown. Nothing has been sent." }
        : { status: "refused", code, speech: code === "no_orchestrator" ? "This project has no designated orchestrator. Nothing was sent." : "This proposal was refused. Nothing was sent." };
    } },
  { name: "end_conversation", class: "session-control",
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
    || entry.parameters.required.some(key => typeof values[key] !== "string"
      || (values[key] as string).trim().length < properties[key].minLength
      || (values[key] as string).length > properties[key].maxLength)) throw new Error("INVALID_TOOL_ARGUMENTS");
  return entry.handler({ ...context, project: canonicalProject(session.project) }, values);
}
