import { ownerRequesterTrigger, requesterTrigger, type ExternalRelayRequest, type ExternalRelayRequester } from "./protocol";
import type { PairedRelay, RelayTargetSettings } from "./store";
import type { OwnerBridgeContext } from "./ownerBridgeContext";
import { bindRequesterEntry, canonicalRelayProject, requesterEntries, type RelayRunEntry } from "./trustedRequesters";

/**
 * What one relay answer may use (relay.md §B.6). Every requester gets the
 * restricted profile as the default. Host access is selected separately by
 * elevatedRequesterFor, after strict wire parsing.
 */
export type RelayAnswerProfile = { webSearch: boolean; pageRead?: boolean; owner?: true; prototype?: string };

export type OwnerInstruction = { localContext?: import("./ownerOutboundContext").OwnerOutboundContext | null; messageId: string; text: string; requestText: string | null; bridgeReport?: OwnerBridgeContext | null; entry?: RelayRunEntry };
/** A verified Telegram private owner destination must match the paired user.
 * Group destinations and opaque requester keys carry no comparable user ID. */
export function ownerBindingRefusal(relay: Pick<PairedRelay, "owner">, request: ExternalRelayRequest): string | null {
  const chatId = request.owner_delivery?.chat_id;
  if (chatId !== undefined && chatId > 0 && relay.owner.namespace === "telegram" && String(chatId) !== relay.owner.id)
    return "Owner delivery does not match this relay's paired owner.";
  return null;
}

/** Only a verified ordinary owner trigger grants host access. */
export function ownerTierFor(target: Pick<RelayTargetSettings, "ownerTier">, request: ExternalRelayRequest): OwnerInstruction | null {
  if (target.ownerTier !== true || request.delivery === "guest") return null;
  const message = ownerRequesterTrigger(request.input);
  if (!message) return null;
  return { messageId: message.id, text: message.text, requestText: request.input.request_text };
}

export function elevatedRequesterFor(relay: PairedRelay, target: RelayTargetSettings, request: ExternalRelayRequest, relays: readonly PairedRelay[]) {
  const requester = request.input.requester;
  if (request.delivery === "guest" || !requester?.key || requester.is_anonymous_admin !== false
    || relay.paused !== false || target.enabled !== true || request.target_id !== target.id) return null;
  const message = requesterTrigger(request.input);
  if (!message) return null;
  const project = canonicalRelayProject(target.project);
  const entries = requesterEntries(relay, target).filter(entry => canonicalRelayProject(entry.project) === project);
  const matched = (requester.is_owner ? entries.find(entry => entry.kind === "paired-owner") : undefined)
    ?? entries.find(entry => entry.kind === "requester" && entry.key === requester.key);
  if (!matched) return null;
  const entry = bindRequesterEntry(relay, matched, relays);
  return {
    entry, source: matched.source,
    instruction: { messageId: message.id, text: message.text, requestText: request.input.request_text, entry },
  };
}
export function answerProfileFor(
  _requester: ExternalRelayRequester | null | undefined,
): RelayAnswerProfile {
  return { webSearch: true, pageRead: true };
}

/** Answers per member per hour in one chat when a target has no setting of its own. */
export const RELAY_MEMBER_ANSWERS_PER_HOUR = 10;
export const RELAY_MEMBER_LIMIT_WINDOW_MS = 60 * 60 * 1000;
/** The target's limit: its own setting, else the default; null or 0 is no limit. */
export function memberLimitFor(target: Pick<RelayTargetSettings, "memberLimitPerHour">): number | null {
  const value = target.memberLimitPerHour === undefined ? RELAY_MEMBER_ANSWERS_PER_HOUR : target.memberLimitPerHour;
  return value && value > 0 ? value : null;
}
/** The owner and chat admins, as the service's requester block says, are not counted. */
export const exemptFromMemberLimit = (requester: ExternalRelayRequester) =>
  requester.is_owner || requester.is_admin;
