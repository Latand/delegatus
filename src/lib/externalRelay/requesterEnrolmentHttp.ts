import { NextRequest } from "next/server";
import { ledgerRowKey } from "@/lib/activity/humanInput";
import { readRequests } from "@/lib/activity/requestLedger";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { registryRowsMatching } from "@/lib/agent/sqliteRegistryStore";
import { OPERATOR_COOKIE, verifySoloBrowserSession } from "@/lib/agent/operatorSession";
import { storedOperatorRoot } from "@/lib/memory/operatorMemory";
import { authenticatedOwner, teamActor } from "@/lib/team/actor";
import { requestSession } from "@/lib/team/sessions";
import { existingTeamStore } from "@/lib/team/store";
import { ExternalRelayError } from "./errors";
import { selectOwnerDestination } from "./ownerDestination";
import { hasRequesterRelayCustody, liveOwnerRelayConversation } from "./ownerAuthority";
import type { RelayStore } from "./store";

const ownerRequired = () => new ExternalRelayError("owner_required", 403);

export function requesterBrowserAuthority(req: NextRequest) {
  return (store: RelayStore) => {
    if (req.signal.aborted) throw ownerRequired();
    const actor = teamActor(req);
    if (actor.kind === "operator" && verifySoloBrowserSession(req.cookies.get(OPERATOR_COOKIE)?.value))
      return { approvedBy: "operator", session: "operator", canStart: false };
    if (actor.kind !== "member") throw ownerRequired();
    const session = requestSession(req);
    if (session?.member.role !== "owner" || actor.memberId !== session.member.id) throw ownerRequired();
    const destination = selectOwnerDestination(store.relays);
    return { approvedBy: actor.memberId, session: session.session.id,
      canStart: !!destination.installationOwner && authenticatedOwner(req, destination.chatId) };
  };
}

export function requesterMcpAuthority(req: NextRequest) {
  const service = internalServiceClaim(req, { readOnly: true });
  if (service.claim !== "valid" || service.service !== "mcp") throw ownerRequired();
  const conversation = callerConversationId(req);
  if (!conversation) throw ownerRequired();
  const authorize = (store?: RelayStore) => {
    if (req.signal.aborted || callerConversationId(req) !== conversation || liveOwnerRelayConversation(conversation)
      || hasRequesterRelayCustody(conversation)) throw ownerRequired();
    const registry = agentRegistry();
    const snapshot = registry.readOnlySnapshot();
    const entry = readOnlyConversationLookupFromSnapshot(snapshot).conversation(conversation as `conversation_${string}`);
    const generation = entry?.generations.at(-1);
    if (!entry || entry.supersededBy || !generation || generation.archivedAt != null
      || !storedOperatorRoot(entry, snapshot.memberships[entry.id]) || generation.launchProfile.workspace) throw ownerRequired();
    const team = existingTeamStore();
    const owner = team?.owner();
    if (team && owner) {
      // Team members can also launch depth-zero conversations. The launch
      // event records the authenticated actor and distinguishes those roots.
      const started = team.events({ actions: ["agent.started"], subjectId: entry.id, limit: 2 });
      const launch = started[0]?.actor;
      const lastAuthor = team.latestConversationMember(entry.id);
      if (owner.status !== "active" || started.length !== 1 || launch?.kind !== "member"
        || launch.memberId !== owner.id || (lastAuthor && lastAuthor !== owner.id)) throw ownerRequired();
    } else {
      // The root stamp also covers local API launches. The solo request
      // ledger records the authenticated operator admission for its birth.
      const firstPath = entry.generations[0]?.path;
      const births = registryRowsMatching(snapshot, "receipts", "conversationId", entry.id).filter(row =>
        row.purpose === "launch" && row.operatorOrigin && row.key && row.artifactPath === firstPath);
      const birth = births[0];
      if (births.length !== 1 || !birth?.clientAttemptId) throw ownerRequired();
      const created = Date.parse(birth.createdAt);
      if (!Number.isFinite(created)) throw ownerRequired();
      const key = ledgerRowKey(`spawn:${birth.clientAttemptId}`);
      if (!readRequests(created - 60_000, created).rows.some(row => row.kind === "spawn" && row.author === "operator" && row.key === key))
        throw ownerRequired();
    }
    const destination = store && selectOwnerDestination(store.relays);
    return { approvedBy: "", session: "", canStart: !!owner?.telegram && destination?.installationOwner === true };
  };
  authorize();
  return { conversation, authorize };
}
