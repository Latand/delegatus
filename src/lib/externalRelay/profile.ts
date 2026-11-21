import type { ExternalRelayRequest, ExternalRelayRequester } from "./protocol";
import type { RelayTargetSettings } from "./store";
import type { OwnerBridgeContext } from "./ownerBridgeContext";

/**
 * What one relay answer may use (relay.md §B.6). Every requester gets the
 * restricted profile: the engine's native web search. Owner host access is
 * selected separately by ownerTierFor, after strict wire parsing.
 */
export type RelayAnswerProfile = { webSearch: boolean; pageRead?: boolean; owner?: true; prototype?: string };

export type OwnerInstruction = { localContext?: import("./ownerOutboundContext").OwnerOutboundContext | null; messageId: string; text: string; requestText: string | null; bridgeReport?: OwnerBridgeContext | null };
/** An owner claim is authoritative only when it names the author of the triggering message. */
export function requesterIsVerifiedOwner(request: ExternalRelayRequest): boolean {
  const requester = request.input.requester;
  if (!requester || requester.is_owner !== true || requester.is_anonymous_admin !== false) return false;
  const message = request.input.respond_to ? request.input.conversation.find(m => m.id === request.input.respond_to) : undefined;
  return !!message && !message.author.self && message.author.key === requester.key;
}
/** Keep prompt and chain identity tied to the author of the message being answered. */
export function effectiveRequester(request: ExternalRelayRequest): ExternalRelayRequest["input"]["requester"] {
  const requester = request.input.requester;
  const trigger = request.input.respond_to && request.input.conversation.find(message => message.id === request.input.respond_to);
  if (!requester || !trigger || trigger.author.self) return requester;
  if (requester.key === trigger.author.key || requester.is_owner !== true) return requester;
  return { ...requester, key: trigger.author.key, is_admin: false, can_restrict_members: false,
    can_delete_messages: false, is_owner: false, is_anonymous_admin: false };
}
/** Only the triggering message authored by the service-identified owner grants host access. */
export function ownerTierFor(target: Pick<RelayTargetSettings, "ownerTier">, request: ExternalRelayRequest): OwnerInstruction | null {
  if (target.ownerTier !== true) return null;
  if (!requesterIsVerifiedOwner(request)) return null;
  const message = request.input.respond_to ? request.input.conversation.find(m => m.id === request.input.respond_to) : undefined;
  if (!message) return null;
  return { messageId: message.id, text: message.text, requestText: request.input.request_text };
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
