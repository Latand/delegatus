import { NextRequest } from "next/server";
import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import type { TeamActor } from "@/lib/team/contract";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { canonicalProject } from "@/lib/projects/aliases";
import { readBridgeReportLog } from "@/lib/bridge/store";
import { resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { CompanionDeliveryPaths } from "./admission";

export const companionDeliveryPaths: CompanionDeliveryPaths = {
  recipient(project) {
    const seat = orchestratorSeatFor(project).active;
    if (!seat?.conversationId) return null;
    const identity = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot()).conversation(seat.conversationId as ViewerConversationId);
    const engine = identity?.engine ?? seat.engine;
    return engine === "claude" || engine === "codex" ? { project: canonicalProject(project),
      conversationId: seat.conversationId, seatEpoch: seat.seatEpoch, engine } : null;
  },
  send: binding => sendCompanionMessage(binding),
  reports: project => readBridgeReportLog().reports.filter(report => report.project
    && canonicalProject(report.project) === canonicalProject(project)),
  async receipt(delivery) {
    const receipt = delivery.operationId ? await resolveSendReceipt(delivery.operationId) : null;
    if (!receipt || receipt.conversationId !== delivery.recipient.conversationId || receipt.clientMessageId !== delivery.clientMessageId) return "pending";
    return receipt.state === "in-flight" ? "pending" : receipt.state;
  },
};

export async function sendCompanionMessage(binding: Parameters<CompanionDeliveryPaths["send"]>[0],
  route: (req: NextRequest, options?: { actor: TeamActor }) => Promise<Response> = conversationHostPOST): ReturnType<CompanionDeliveryPaths["send"]> {
  const actor: TeamActor = binding.startedBy && "memberId" in binding.startedBy
    ? { kind: "member", memberId: binding.startedBy.memberId } : { kind: "operator" };
  const response = await route(new NextRequest("http://127.0.0.1/api/conversation-host", {
    method: "POST", headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ orchestratorRelayProject: binding.delivery.recipient.project, conversationId: binding.delivery.recipient.conversationId,
      text: binding.text, clientMessageId: binding.delivery.clientMessageId,
      policy: "steer-or-queue",
      voiceDelegatus: { sessionId: binding.sessionId, proposalId: binding.proposalId } }),
  }), { actor });
  const result = await response.json();
  if (response.status >= 400 && response.status < 500 && typeof result.code === "string")
    return { status: typeof result.operationId === "string" ? "unknown" : "failed",
      operationId: typeof result.operationId === "string" ? result.operationId : null, code: result.code };
  if (!response.ok || typeof result.operationId !== "string") throw new Error("DELIVERY_UNCONFIRMED");
  const receipt = await resolveSendReceipt(result.operationId);
  return { status: receipt?.state === "delivered" ? "delivered" : receipt?.state === "failed" ? "unknown" : "queued", operationId: result.operationId };
}
