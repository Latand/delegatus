import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { companionOperator } from "@/lib/voiceCompanion/http";
import { requestSession } from "@/lib/team/sessions";
import { existingTeamStore } from "@/lib/team/store";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { voiceToolHub } from "./hub";
import { proposalSchema, selectionSchema, secretsSchema, serverName } from "./contracts";
import { VoiceToolsError } from "./store";

export function voiceToolsOperator(req: NextRequest): NextResponse | null {
  const rejection = companionOperator(req);
  if (rejection) return rejection;
  const session = requestSession(req);
  if (!session) return failure("OPERATOR_REQUIRED", 401);
  const member = existingTeamStore()?.member(session.member.id);
  if (!member || member.status !== "active" || member.role !== "owner") return failure("OPERATOR_REQUIRED", 403);
  if (!["passkey", "telegram"].includes(session.session.method)) return failure("OPERATOR_REQUIRED", 401);
  return null;
}
const common = { name: serverName, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) };
const browserSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["approve", "reject", "remove", "disable", "dry-run"]), ...common }).strict(),
  z.object({ action: z.literal("configure"), ...common, tools: selectionSchema.optional(), askBeforeActing: z.boolean().optional(), reapprove: z.literal(true).optional() }).strict(),
  z.object({ action: z.literal("secrets"), secrets: secretsSchema }).strict(),
  z.object({ action: z.literal("propose"), proposal: proposalSchema }).strict(),
]);
const mcpSchema = z.object({ action: z.enum(["list", "status", "propose"]), proposal: proposalSchema.optional(),
  clientRequestId: z.string().min(1).max(256), conversationId: z.string().max(200).nullable() }).strict();
async function body(req: NextRequest): Promise<unknown> {
  if (!req.body) throw new VoiceToolsError("INVALID_REQUEST");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 96_000) throw new VoiceToolsError("INVALID_REQUEST");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}
function failure(code: string, status = 409) { return NextResponse.json({ code }, { status, headers: { "Cache-Control": "no-store" } }); }
function invalidBody(error: z.ZodError) {
  return failure(error.issues.some(issue => issue.path[0] === "proposal") ? "INVALID_PROPOSAL" : "INVALID_REQUEST", 400);
}
export function voiceToolsFailure(error: unknown) {
  const code = error instanceof VoiceToolsError ? error.code : "VOICE_TOOLS_UNAVAILABLE";
  return failure(code, code === "OPERATOR_REQUIRED" ? 403 : code.startsWith("INVALID") ? 400 : 409);
}
export async function readVoiceTools(req: NextRequest) {
  const rejection = voiceToolsOperator(req); if (rejection) return rejection;
  try {
    const view = await voiceToolHub().store.view();
    const recheck = voiceToolsOperator(req); if (recheck) return recheck;
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return voiceToolsFailure(error); }
}
export async function changeVoiceTools(req: NextRequest) {
  const rejection = voiceToolsOperator(req); if (rejection) return rejection;
  try {
    const parsed = browserSchema.safeParse(await body(req));
    if (!parsed.success) return invalidBody(parsed.error);
    // Reading the body can await a disconnected or newly revoked member.
    const recheck = voiceToolsOperator(req); if (recheck) return recheck;
    const input = parsed.data;
    const hub = voiceToolHub();
    const authorize = () => { if (voiceToolsOperator(req)) throw new VoiceToolsError("OPERATOR_REQUIRED"); };
    if (input.action === "propose") await hub.store.propose(input.proposal, { kind: "operator", conversationId: null, at: new Date().toISOString() }, authorize);
    else if (input.action === "secrets") await hub.store.saveSecrets(input.secrets, authorize);
    else if (input.action === "dry-run") await hub.dryRun(input.name, input.digest, req.signal, authorize);
    else await hub.store.operatorChange(input.name, input.digest, input.action, input.action === "configure" ? { tools: input.tools, askBeforeActing: input.askBeforeActing, reapprove: input.reapprove } : {}, authorize);
    return await readVoiceTools(req);
  } catch (error) { return voiceToolsFailure(error); }
}
/** The MCP transport can propose; this route has no approval or execution branch. */
export async function mcpVoiceTools(req: NextRequest) {
  const rejection = rejectCrossOrigin(req); if (rejection) return rejection;
  const claim = internalServiceClaim(req, { readOnly: true });
  if (claim.claim !== "valid" || claim.service !== "mcp") return failure("MCP_REQUIRED", 403);
  try {
    const parsed = mcpSchema.safeParse(await body(req));
    if (!parsed.success) return invalidBody(parsed.error);
    const input = parsed.data;
    const hub = voiceToolHub();
    if (input.action === "propose") {
      if (!input.proposal) return failure("INVALID_REQUEST", 400);
      await hub.store.propose(input.proposal, { kind: "conversation", conversationId: input.conversationId, at: new Date().toISOString() });
    }
    return NextResponse.json(await hub.store.view(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return voiceToolsFailure(error); }
}
