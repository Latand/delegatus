import { proposalSchema } from "@/lib/voiceTools/contracts";
import type { McpToolArgs, McpToolPayload } from "./server";
import { McpToolRefusal } from "./server";
import type { ViewerControlDependencies } from "./bindings";

/** Every MCP caller is an agent here, including the voice gateway. */
export async function voiceTools(args: McpToolArgs, control: ViewerControlDependencies, conversationId: string | null): Promise<McpToolPayload> {
  if (!["list", "status", "propose"].includes(String(args.action))) {
    throw new McpToolRefusal("Open the voice settings to approve, reject, probe or remove a server.", { code: "voice_tools_operator_required" });
  }
  if (Object.keys(args).some(key => !["action", "proposal", "clientRequestId"].includes(key))) throw new McpToolRefusal("Invalid voice tools request.", { code: "INVALID_REQUEST" });
  const parsed = args.action === "propose" ? proposalSchema.safeParse(args.proposal) : null;
  if (parsed && !parsed.success) throw new McpToolRefusal("Invalid voice tools proposal. Put credentials in the voice settings only.", { code: "INVALID_PROPOSAL" });
  return control.post("/api/voice-tools/proposals", { action: args.action, clientRequestId: args.clientRequestId, conversationId,
    ...(parsed?.success ? { proposal: parsed.data } : {}) });
}
