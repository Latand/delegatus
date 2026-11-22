import type { AgentRegistry } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { readRuntimeSession, type RuntimeHostClient } from "@/lib/runtime/client";
import { publishStructuredHostProjection } from "@/lib/runtime/structuredDeliveryController";
import type { AgentProjection } from "./model";
import { requireAgentFilesRevision } from "./store";

export async function publishAgentProjection(registry: AgentRegistry, client: RuntimeHostClient | null,
  projection: AgentProjection, current: () => boolean): Promise<boolean> {
  if (!client || !projection.conversationId || !current()) return false;
  const session = await readRuntimeSession(client, { conversationId: projection.conversationId });
  if (!current() || !session || sessionKeyId(session.sessionKey) !== projection.entryKey) return false;
  const entry = registry.agentStateRead(file => file.entries[projection.entryKey]);
  if (!entry || !projection.facts.turn.determined || !projection.facts.owner.determined || !projection.facts.process.determined) return false;
  const writerClaim = entry.claimOwner ? `${entry.claimOwner}:${entry.structuredHost!.writerClaimEpoch}` : null;
  if (session.writerClaim && writerClaim !== session.writerClaim) return false;
  const host = projection.facts.process.value.status === "dead" ? "dead" : projection.facts.owner.value === "held" ? "hosted" : "unhosted";
  const turn = projection.facts.turn.value.state === "open" ? "running" : "idle";
  const activeTurnId = projection.facts.turn.value.localRef;
  let invalidateFiles = projection.pendingFilesRevision !== false;
  if (!invalidateFiles && (session.host !== host || session.turn !== turn || session.activeTurnId !== activeTurnId
    || (session.writerClaim ?? null) !== writerClaim)) {
    const marked = await registry.deliveryWriteOrBusy({ label: "agent-state.files-revision" },
      () => requireAgentFilesRevision(registry, projection.subject, projection.revision));
    if (!marked || !current()) return false;
    invalidateFiles = true;
  }
  await publishStructuredHostProjection(client, { scope: { type: "session", id: projection.conversationId }, kind: "session-status",
    expectedSessionRevision: session.revision,
    producer: { kind: "viewer", eventKey: `agent-state:${projection.subject}:${projection.revision}` },
    payload: { conversationId: projection.conversationId, sessionKey: entry.key, host, turn, activeTurnId,
      writerClaim, reconciliationRevision: projection.revision } }, invalidateFiles);
  return current();
}
