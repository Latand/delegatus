import type { ExternalRelayRequester } from "./protocol";
import type { RelayTargetSettings } from "./store";

/**
 * What one relay answer may use (relay.md §B.6). Every requester gets the
 * same profile in this build: the engine's native web search and nothing
 * else. The requester is the input so a later tier (the owner's) can branch
 * on it; nothing is granted from it here.
 */
export type RelayAnswerProfile = { webSearch: boolean };
export function answerProfileFor(
  _requester: ExternalRelayRequester | null | undefined,
): RelayAnswerProfile {
  return { webSearch: true };
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
  requester.is_owner || requester.role === "admin";
