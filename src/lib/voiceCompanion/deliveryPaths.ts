import { NextRequest } from "next/server";
import { POST as orchestratorMessage } from "@/app/api/orchestrator/message/route";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { canonicalProject } from "@/lib/projects/aliases";
import { pageBridgeReports } from "@/lib/bridge/store";
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
  async send(binding) {
    const response = await orchestratorMessage(new NextRequest("http://127.0.0.1/api/orchestrator/message", {
      method: "POST", headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ project: binding.delivery.recipient.project, conversationId: binding.delivery.recipient.conversationId,
        text: binding.text, clientMessageId: binding.delivery.clientMessageId,
        voiceDelegatus: { sessionId: binding.sessionId, proposalId: binding.proposalId } }),
    }));
    const result = await response.json();
    if (!response.ok || typeof result.operationId !== "string") throw new Error("DELIVERY_UNCONFIRMED");
    const receipt = await resolveSendReceipt(result.operationId);
    return { status: receipt?.state === "delivered" ? "delivered" : receipt?.state === "failed" ? "unknown" : "queued", operationId: result.operationId };
  },
  reports: project => pageBridgeReports({ inProject: candidate => canonicalProject(candidate) === canonicalProject(project), limit: 100 }).reports,
  async receipt(delivery) {
    const receipt = delivery.operationId ? await resolveSendReceipt(delivery.operationId) : null;
    if (!receipt || receipt.conversationId !== delivery.recipient.conversationId || receipt.clientMessageId !== delivery.clientMessageId) return "pending";
    return receipt.state === "in-flight" ? "pending" : receipt.state;
  },
};
