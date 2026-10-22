import type { ExternalRelayCompletion } from "./protocol";

export const OWNER_REQUEST_TIMEOUT_DETAIL = "Delegatus ran out of time before the work finished. Check the relay conversation for progress before retrying.";

export function ownerRequestTimeoutText(plainMax: number): string {
  const text = OWNER_REQUEST_TIMEOUT_DETAIL.length <= plainMax ? OWNER_REQUEST_TIMEOUT_DETAIL : "Ran out of time.";
  return text.slice(0, plainMax);
}

/** Status authority can carry this fixed plain notice, with no agent payload. */
export function isOwnerRequestTimeoutReply(body: ExternalRelayCompletion, plainMax: number): boolean {
  if (body.outcome !== "answered" || !body.answer) return false;
  const answer = body.answer;
  const empty = (value: unknown) => value === undefined || Array.isArray(value) && value.length === 0;
  return Object.keys(body).every(key => ["lease_id", "outcome", "answer", "duration_ms"].includes(key))
    && answer.action === "reply" && !!answer.text && answer.text === ownerRequestTimeoutText(plainMax)
    && (answer.format === undefined || answer.format === "plain")
    && empty(answer.buttons) && empty(answer.attachments) && empty(answer.mentions)
    && Object.keys(answer).every(key => ["action", "text", "reply_to", "format", "buttons", "attachments", "mentions"].includes(key));
}
