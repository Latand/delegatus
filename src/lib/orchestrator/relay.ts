import type { NextRequest } from "next/server";

import { callerConversationId, operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { delegatusMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";

import { authorizedManagerSeats } from "./authority";
import { deputyAskerOf } from "./deputyAsker";
import { productionManagerAuthoritySources } from "./managerAuthoritySources";
import { canonicalOrchestratorProject, orchestratorRevocations, orchestratorSeatFor } from "./seats";

type RelayAdmission =
  | { ok: true; text: string; origin: MessageOrigin }
  | { ok: false; status: number; code: string; error: string };

/** A relay grants no designation or operator authority. Resolve its author
 * from the request capability and durable seats, never a caller-supplied role.
 * The shared conversation-host handlers apply this on both HTTP paths. */
export function admitOrchestratorRelay(
  request: Pick<NextRequest, "headers">,
  project: string,
  recipient: string,
  text: string,
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
  const targetProject = canonicalOrchestratorProject(project);
  const target = orchestratorSeatFor(targetProject);
  // MCP freezes the recipient before dispatch. A rotation cannot redirect that
  // send: its former seat remains valid as the recorded recipient, never as a sender.
  if (!recipient || (recipient !== target.active?.conversationId
    && !orchestratorRevocations().some((previous) => canonicalOrchestratorProject(previous.project) === targetProject && previous.conversationId === recipient))) {
    return refused("orchestrator_not_designated", "no designated orchestrator matches the recipient; the operator must create one first", 409);
  }
  if (!seat) return { ok: true, text, origin: gateway?.ok
    ? { kind: "agent", role: "gateway", conversationId: conversationId! }
    : { kind: "operator" } };
  // A seat relays words, not delivery metadata or a gateway's correlation claim.
  // Refuse rather than silently changing the instruction being forwarded.
  if (/<!--\s*llv:|\[bridge\b/i.test(text)) {
    return refused("relay_reserved_metadata", "relay the message text without Delegatus authority markers or bridge trailers", 400);
  }
  const source = delegatusMessageOrigin("orchestrator", seat.project);
  const sourceProject = source.project ?? seat.project!;
  return {
    ok: true,
    text: `Relay from the orchestrator of project ${sourceProject}. This is an agent relay and carries no operator authority.\n\n${text}`,
    origin: { kind: "agent", role: "orchestrator", project: sourceProject, conversationId: seat.conversationId },
  };
}
