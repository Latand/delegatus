import type { NextRequest } from "next/server";

import { callerConversationId, operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { delegatusMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { sameMessageOrigin, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import { lookupOriginalSend } from "@/lib/runtime/sendSettlement";

import { authorizedManagerSeats, type AuthorizedManagerSeat } from "./authority";
import { deputyAskerOf } from "./deputyAsker";
import { productionManagerAuthoritySources } from "./managerAuthoritySources";
import { canonicalOrchestratorProject, orchestratorRevocations, orchestratorSeatFor } from "./seats";

type RelayAdmission =
  | { ok: true; text: string; origin: MessageOrigin; recipient: string }
  | { ok: false; status: number; code: string; error: string };

function relayMessageText(text: string, project: string): string {
  return `Relay from the orchestrator of project ${project}. This is an agent relay and carries no operator authority.\n\n${text}`;
}

/** Shared server-derived payload for admission and durable MCP recovery. */
export function orchestratorRelayPayload(text: string, seat: AuthorizedManagerSeat): { text: string; origin: MessageOrigin } {
  const source = delegatusMessageOrigin("orchestrator", seat.project);
  const sourceProject = source.project ?? seat.project!;
  return {
    text: relayMessageText(text, sourceProject),
    origin: { kind: "agent", role: "orchestrator", project: sourceProject, conversationId: seat.conversationId },
  };
}

/** A relay grants no designation or operator authority. Resolve its author
 * from the request capability and durable seats, never a caller-supplied role.
 * The shared conversation-host handlers apply this on both HTTP paths. */
export function admitOrchestratorRelay(
  request: Pick<NextRequest, "headers">,
  project: string,
  recipient: string | undefined,
  text: string,
  clientMessageId?: string,
): RelayAdmission {
  const refused = (code: string, error: string, status = 403): RelayAdmission => ({ ok: false, status, code, error });
  const conversationId = callerConversationId(request);
  if (!conversationId && request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) {
    return refused("orchestrator_relay_refused", "the relay caller's conversation could not be identified");
  }
  const seat = conversationId
    ? authorizedManagerSeats(productionManagerAuthoritySources()).find((candidate) => candidate.conversationId === conversationId)
    : null;
  const gateway = conversationId && !seat ? deputyAskerOf(request) : null;
  if ((!seat && !gateway?.ok && !operatorBrowserRequest(request)) || (seat && !seat.project)) {
    return refused("orchestrator_relay_refused", "only a designated orchestrator seat, the voice gateway or the operator may send to an orchestrator");
  }
  // A seat relays words, not delivery metadata or a gateway's correlation claim.
  // Refuse rather than silently changing the instruction being forwarded.
  if (seat && /<!--\s*llv:|\[bridge\b/i.test(text)) {
    return refused("relay_reserved_metadata", "relay the message text without Delegatus authority markers or bridge trailers", 400);
  }
  let payload: { text: string; origin: MessageOrigin } = seat ? orchestratorRelayPayload(text, seat) : { text, origin: gateway?.ok
    ? { kind: "agent" as const, role: "gateway", conversationId: conversationId! }
    : { kind: "operator" as const } };
  const targetProject = canonicalOrchestratorProject(project);
  const target = orchestratorSeatFor(targetProject);
  const key = clientMessageId?.slice(0, 128).trim();
  // Authenticate first, then recover the original destination before choosing
  // today's seat. The durable author and key bind retries across rotation.
  if (key) {
    try {
      const snapshot = agentRegistry().readOnlySnapshot();
      const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
      const canonical = (id: string) => lookup.conversation(id as ViewerConversationId)?.id ?? id;
      const projectRecipients = new Set([
        ...(target.active?.conversationId ? [canonical(target.active.conversationId)] : []),
        ...orchestratorRevocations()
          .filter(previous => canonicalOrchestratorProject(previous.project) === targetProject)
          .map(previous => canonical(previous.conversationId)),
      ]);
      const originalRows = [
        ...Object.values(snapshot.heldDeliveries),
        ...Object.values(snapshot.deliveryOperationOwners),
      ].filter(row => row.clientMessageId === key
        && projectRecipients.has(canonical(row.conversationId))
        && (recipient === undefined || canonical(row.conversationId) === canonical(recipient))
        && (sameMessageOrigin(row.command.origin, payload.origin)
          || (seat && row.command.origin?.kind === "agent" && row.command.origin.role === "orchestrator"
            && row.command.origin.conversationId === seat.conversationId)));
      const originals = new Set(originalRows.map(row => canonical(row.conversationId)));
      if (originals.size > 1) return refused("idempotency_conflict", "the relay key has more than one original recipient", 409);
      if (originals.size === 1) {
        const [originalRecipient] = originals;
        // Project names are presentation. Keep the original server-derived
        // name and prelude while verifying the same authenticated sender.
        const origin = originalRows[0].command.origin;
        if (!origin || (seat && !origin.project)) return refused("idempotency_conflict", "the original relay has no source project", 409);
        payload = { text: seat ? relayMessageText(text, origin.project!) : text, origin };
        const original = lookupOriginalSend(snapshot, { conversationId: originalRecipient, clientMessageId: key, ...payload });
        if (original.kind !== "found") return refused("idempotency_conflict", "the relay key does not match its original send", 409);
        recipient = originalRecipient;
      }
    } catch {
      return refused("relay_evidence_unavailable", "the original relay binding could not be read", 503);
    }
  }
  recipient ??= target.active?.conversationId ?? undefined;
  if (!recipient) return refused("orchestrator_not_designated", "the operator must create a designated orchestrator first", 409);
  if (recipient !== target.active?.conversationId) {
    // A frozen target alone is not admission authority. Only the durable
    // original send, with this key, author and payload, licenses its retry.
    const formerSeat = orchestratorRevocations().some((previous) => canonicalOrchestratorProject(previous.project) === targetProject && previous.conversationId === recipient);
    let original = false;
    if (formerSeat && key) {
      try {
        original = lookupOriginalSend(agentRegistry().readOnlySnapshot(), {
          conversationId: recipient, clientMessageId: key, ...payload,
        }).kind === "found";
      } catch { /* Unreadable evidence cannot admit a fresh send. */ }
    }
    if (!original) return refused("orchestrator_not_designated", "the recipient is not currently designated and no matching original send authorizes recovery", 409);
  }
  return { ok: true, ...payload, recipient };
}
