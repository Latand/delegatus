import type { RegistryConversation } from "@/lib/agent/registry";
import { activeOrchestratorSeats, seatWorkspaceFromMessage } from "@/lib/orchestrator/seats";
import type { TeamStore } from "./store";
import { conversationWorkspaceReach, memberWorkspacePrincipal, workspacePrincipalAllows } from "./workspacePrincipal";

/**
 * Whether a caller under member reach keeps the Telegram bot tools.
 *
 * A seat belongs to its project, and so does the Telegram grant on its record:
 * it stays usable while a member's message fences the seat. Only the project's
 * current seat holds it, never a worker of the seat, and only while the member
 * behind the fence still has the project. A seat a person designated for a
 * member is outside this rule and stays without the tools.
 *
 * The grant brings the chats the agent route serves any caller; this adds no
 * chat scoping of its own.
 */
export function seatHoldsTelegramGrant(conversationId: string | null, store: TeamStore | null,
  lookup: (id: string) => RegistryConversation | null): boolean {
  const reach = conversationWorkspaceReach(lookup, conversationId, store);
  // Only a fence a message put up: a conversation a member launched keeps its
  // binding, and the grant with it stays out, whoever designated it a seat.
  if (!reach.principal || !reach.fromMessage || !store) return false;
  const seat = activeOrchestratorSeats().find(candidate => candidate.conversationId === conversationId);
  if (!seat || seat.telegramGrant !== true || (seat.workspace && !seatWorkspaceFromMessage(seat))) return false;
  const principal = memberWorkspacePrincipal(store, reach.principal.memberId, seat.project);
  return Boolean(principal && workspacePrincipalAllows(principal, seat.project, store));
}
