import { currentSeat } from "./seatChannel";
import type { NextRequest } from "next/server";

import { callerConversationId, operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, deliveryRegistryEntriesForKey, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { delegatusMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { messageOriginProject, sameMessageOrigin, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import { lookupOriginalSend, type SendReceipt } from "@/lib/runtime/sendSettlement";
import { admittedVoiceBinding } from "@/lib/voiceCompanion/admission";
import { ownerRelayPayload, ownerRelayTargetMatches } from "@/lib/externalRelay/ownerAuthority";

import { authorizedManagerSeats, type AuthorizedManagerSeat } from "./authority";
import { deputyAskerOf } from "./deputyAsker";
import { productionManagerAuthoritySources } from "./managerAuthoritySources";
import { relayMessageText } from "./relayText";
import { canonicalOrchestratorProject, orchestratorRevocations, orchestratorSeatFor } from "./seats";

type RelayAdmission =
  | { ok: true; text: string; origin: MessageOrigin; recipient: string; operationId?: string; terminalReceipt?: SendReceipt; voiceRecoveryReceipt?: SendReceipt }
  | { ok: false; status: number; code: string; error: string };

/** Shared server-derived payload for admission and durable MCP recovery. */
export function orchestratorRelayPayload(text: string, seat: AuthorizedManagerSeat): { text: string; origin: MessageOrigin } {
  const source = delegatusMessageOrigin("orchestrator", seat.project);
  // Bound presentation before constructing either copy of the payload. The
  // registry must retain exactly the label MCP bound before HTTP dispatch.
  const sourceProject = messageOriginProject(source.project?.slice(0, 120).trim())
    ?? messageOriginProject(seat.project?.slice(0, 120).trim())
    ?? "Unnamed project";
  return {
    text: relayMessageText(text, sourceProject),
    origin: { kind: "agent", role: "orchestrator", project: sourceProject, conversationId: seat.conversationId },
  };
}

/** A seat relay grants no designation or operator authority. Resolve its author
 * from the request capability and durable seats, never a caller-supplied role.
 * The shared conversation-host handlers apply this on both HTTP paths.
 * `inProcessPerson` is set only by `conversationHostPOST` after it rechecked the
 * operator or member an in-process caller (voice delivery) passed as its actor;
 * no header or body can set it. */
export function admitOrchestratorRelay(
  request: Pick<NextRequest, "headers">,
  project: string,
  recipient: string | undefined,
  text: string,
  clientMessageId?: string,
  voice?: { sessionId: string; proposalId: string },
  inProcessPerson = false,
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
  const owner = conversationId && !seat && !gateway?.ok ? ownerRelayPayload(text, conversationId) : null;
  const operator = !conversationId && (inProcessPerson || operatorBrowserRequest(request));
  if ((!seat && !gateway?.ok && !owner && !operator) || (seat && !seat.project)) {
    return refused("orchestrator_relay_refused", "only a designated orchestrator seat, the voice gateway, a verified owner relay or the operator may send to an orchestrator");
  }
  // A seat relays words, not delivery metadata or a gateway's correlation claim.
  // Refuse rather than silently changing the instruction being forwarded.
  if (seat && /<!--\s*llv:|\[bridge\b/i.test(text)) {
    return refused("relay_reserved_metadata", "relay the message text without Delegatus authority markers or bridge trailers", 400);
  }
  let payload: { text: string; origin: MessageOrigin } = seat ? orchestratorRelayPayload(text, seat) : owner ?? { text, origin: gateway?.ok
    ? { kind: "agent" as const, role: "gateway", conversationId: conversationId! }
    : { kind: "operator" as const } };
  let voiceBinding: ReturnType<typeof admittedVoiceBinding> = null;
  if (voice) {
    if (seat || gateway?.ok || owner || !operator) return refused("voice_admission_refused", "voice delegation requires the operator's confirmed proposal");
    try { voiceBinding = admittedVoiceBinding({ ...voice, project: canonicalOrchestratorProject(project), recipient, key: clientMessageId?.slice(0, 128).trim(), text }); }
    catch { return refused("voice_evidence_unavailable", "the confirmed proposal could not be read", 503); }
    if (!voiceBinding) return refused("voice_admission_refused", "the voice send does not match a confirmed proposal", 409);
    payload = { text, origin: { kind: "operator", channel: "voice-delegatus" } };
  }
  const resolved = resolveOrchestratorRelay(project, recipient, payload, text, clientMessageId, seat ?? undefined, voiceBinding);
  // Recover the frozen recipient before comparing report custody. A retry may
  // settle the original source seat's receipt after its designation rotates.
  if (owner && !ownerRelayTargetMatches(conversationId!, project, resolved.ok ? resolved.recipient : recipient)) {
    return refused("owner_report_seat_unavailable", "the quoted report's source seat is unavailable for this handoff; explain the failure and ask the owner to open that project's seat", 409);
  }
  return resolved;
}

/** Recipient and durable recovery shared by local and authenticated link relays.
 * This is an in-process admission seam; HTTP headers cannot name its payload. */
export function resolveOrchestratorRelay(
  project: string,
  recipient: string | undefined,
  payload: { text: string; origin: MessageOrigin },
  text: string,
  clientMessageId?: string,
  seat?: AuthorizedManagerSeat,
  voiceBinding: ReturnType<typeof admittedVoiceBinding> = null,
): RelayAdmission {
  const refused = (code: string, error: string, status = 403): RelayAdmission => ({ ok: false, status, code, error });
  const targetProject = canonicalOrchestratorProject(project);
  const target = orchestratorSeatFor(targetProject);
  const key = clientMessageId?.slice(0, 128).trim();
  const formerRecipient = recipient !== undefined && orchestratorRevocations().some(previous =>
    canonicalOrchestratorProject(previous.project) === targetProject && previous.conversationId === recipient);
  let operationId: string | undefined;
  let terminalReceipt: SendReceipt | undefined;
  let voiceRecoveryReceipt: SendReceipt | undefined;
  // Authenticate first, then recover the original destination before choosing
  // today's seat. The durable author and key bind retries across rotation.
  if (key) {
    try {
      const snapshot = agentRegistry().readOnlySnapshot();
      const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
      const canonical = (id: string) => lookup.canonicalConversationId(id as ViewerConversationId);
      const projectRecipients = new Set([
        ...(target.active?.conversationId ? [canonical(target.active.conversationId)] : []),
        ...orchestratorRevocations()
          .filter(previous => canonicalOrchestratorProject(previous.project) === targetProject)
          .map(previous => canonical(previous.conversationId)),
      ]);
      const keyRows = withViewerOperation("orchestrator.relay-recovery", () => performanceSpans.sync("relay.select", () => [
        ...deliveryRegistryEntriesForKey(snapshot, "heldDeliveries", key, [...projectRecipients]),
        ...deliveryRegistryEntriesForKey(snapshot, "deliveryOperationOwners", key, [...projectRecipients]),
      ].map(([, row]) => row))).filter(row => row.clientMessageId === key
        && projectRecipients.has(canonical(row.conversationId))
        && (recipient === undefined || formerRecipient || canonical(row.conversationId) === canonical(recipient)));
      const originalRows = keyRows.filter(row => sameMessageOrigin(row.command.origin, payload.origin)
        || (seat && row.command.origin?.kind === "agent" && row.command.origin.role === "orchestrator"
          && row.command.origin.conversationId === seat.conversationId));
      if (recipient !== undefined && keyRows.length && !originalRows.length)
        return refused("idempotency_conflict", "the relay key belongs to another sender", 409);
      const originals = new Set(originalRows.map(row => canonical(row.conversationId)));
      if (originals.size > 1) return refused("idempotency_conflict", "the relay key has more than one original recipient", 409);
      if (originals.size === 1) {
        const [originalRecipient] = originals;
        // Project names are presentation. Keep the original server-derived
        // name and prelude while verifying the same authenticated sender.
        const origin = originalRows[0].command.origin;
        if (!origin || (seat && !origin.project)) return refused("idempotency_conflict", "the original relay has no source project", 409);
        payload = { text: origin.kind === "agent" && origin.role === "orchestrator" && origin.project ? relayMessageText(text, origin.project)
          : origin.kind === "agent" && origin.role === "owner-relay" ? payload.text : text, origin };
        const original = lookupOriginalSend(snapshot, { conversationId: originalRecipient, clientMessageId: key, ...payload });
        if (original.kind !== "found") return refused("idempotency_conflict", "the relay key does not match its original send", 409);
        operationId = original.operationId;
        if (voiceBinding) voiceRecoveryReceipt = original.receipt;
        terminalReceipt = original.receipt;
        recipient = originalRecipient;
      }
    } catch {
      return refused("relay_evidence_unavailable", "the original relay binding could not be read", 503);
    }
  }
  if (recipient && !operationId && recipient !== target.active?.conversationId
    && orchestratorRevocations().some(previous => canonicalOrchestratorProject(previous.project) === targetProject && previous.conversationId === recipient)) {
    recipient = currentSeat(targetProject)?.conversationId ?? undefined;
  }
  recipient ??= currentSeat(targetProject)?.conversationId ?? undefined;
  if (voiceBinding && !operationId && (target.active?.conversationId !== voiceBinding.proposal.recipient.conversationId
    || target.active?.seatEpoch !== voiceBinding.proposal.recipient.seatEpoch)) {
    return refused("voice_seat_changed", "the orchestrator changed before delivery admission", 409);
  }
  if (!recipient) return refused("orchestrator_not_designated", "the operator must create a designated orchestrator first", 409);
  if (recipient !== target.active?.conversationId) {
    // A frozen target alone is not admission authority. Only the durable
    // original send, with this key, author and payload, licenses its retry.
    const formerSeat = orchestratorRevocations().some((previous) => canonicalOrchestratorProject(previous.project) === targetProject && previous.conversationId === recipient);
    let original = false;
    if (formerSeat && key && operationId) original = true;
    else if (formerSeat && key) {
      try {
        original = lookupOriginalSend(agentRegistry().readOnlySnapshot(), {
          conversationId: recipient, clientMessageId: key, ...payload,
        }).kind === "found";
      } catch { /* Unreadable evidence cannot admit a fresh send. */ }
    }
    if (!original) return refused("orchestrator_not_designated", "the recipient is not currently designated and no matching original send authorizes recovery", 409);
  }
  return { ok: true, ...payload, recipient, ...(operationId ? { operationId } : {}),
    ...(voiceRecoveryReceipt ? { voiceRecoveryReceipt } : {}),
    ...(terminalReceipt ? { terminalReceipt } : {}) };
}

/** Remote senders must be a designated seat of this shared project. */
export function linkedRelayCaller(request: Pick<NextRequest, "headers">, project: string): AuthorizedManagerSeat | null {
  const conversationId = callerConversationId(request);
  return conversationId ? authorizedManagerSeats(productionManagerAuthoritySources())
    .find(seat => seat.conversationId === conversationId && !!seat.project && canonicalOrchestratorProject(seat.project) === canonicalOrchestratorProject(project)) ?? null : null;
}
