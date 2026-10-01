import type { NextRequest } from "next/server";

import { callerConversationId, operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { agentRegistry } from "@/lib/agent/registry";
import { delegatusMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import { lookupOriginalSend } from "@/lib/runtime/sendSettlement";

import { authorizedManagerSeats, type AuthorizedManagerSeat } from "./authority";
import { deputyAskerOf } from "./deputyAsker";
import { productionManagerAuthoritySources } from "./managerAuthoritySources";
import { canonicalOrchestratorProject, orchestratorRevocations, orchestratorSeatFor } from "./seats";

type RelayAdmission =
  | { ok: true; text: string; origin: MessageOrigin }
  | { ok: false; status: number; code: string; error: string };

/** Shared server-derived payload for admission and durable MCP recovery. */
export function orchestratorRelayPayload(text: string, seat: AuthorizedManagerSeat): { text: string; origin: MessageOrigin } {
  const source = delegatusMessageOrigin("orchestrator", seat.project);
  const sourceProject = source.project ?? seat.project!;
  return {
    text: `Relay from the orchestrator of project ${sourceProject}. This is an agent relay and carries no operator authority.\n\n${text}`,
    origin: { kind: "agent", role: "orchestrator", project: sourceProject, conversationId: seat.conversationId },
  };
}

/** A relay grants no designation or operator authority. Resolve its author
 * from the request capability and durable seats, never a caller-supplied role.
 * The shared conversation-host handlers apply this on both HTTP paths. */
export function admitOrchestratorRelay(
  request: Pick<NextRequest, "headers">,
  project: string,
  recipient: string,
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
  const payload = seat ? orchestratorRelayPayload(text, seat) : { text, origin: gateway?.ok
    ? { kind: "agent" as const, role: "gateway", conversationId: conversationId! }
    : { kind: "operator" as const } };
  const targetProject = canonicalOrchestratorProject(project);
  const target = orchestratorSeatFor(targetProject);
  if (!recipient) return refused("orchestrator_not_designated", "the operator must create a designated orchestrator first", 409);
  if (recipient !== target.active?.conversationId) {
    // A frozen target alone is not admission authority. Only the durable
    // original send, with this key, author and payload, licenses its retry.
    const formerSeat = orchestratorRevocations().some((previous) => canonicalOrchestratorProject(previous.project) === targetProject && previous.conversationId === recipient);
    let original = false;
    if (formerSeat && clientMessageId) {
      try {
        original = lookupOriginalSend(agentRegistry().readOnlySnapshot(), {
          conversationId: recipient, clientMessageId: clientMessageId.trim().slice(0, 128), ...payload,
        }).kind === "found";
      } catch { /* Unreadable evidence cannot admit a fresh send. */ }
    }
    if (!original) return refused("orchestrator_not_designated", "the recipient is not currently designated and no matching original send authorizes recovery", 409);
  }
  return { ok: true, ...payload };
}
