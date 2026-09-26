import type { MessageAuthorClaim, PriorSubmission, TeamActor } from "./contract";
import { recordMessageAuthor } from "./events";
import { existingTeamStore } from "./store";
import { recordConversationEvent } from "./subjects";

/*
 * Who sent a message (sign-in-and-team §7.1), in two steps around the send.
 *
 * The submission id is chosen by the browser, and every browser can read the
 * ids of delivered messages from `/api/log/provenance`. Stamping it before the
 * host answered let a member name someone else's id — a message sent before
 * the team existed, a task send, an agent relay — and become its author even
 * though the host refused the reuse. So the claim is taken BEFORE the send,
 * only for an id no delivery record and no author row knows, and it is
 * settled AFTER, only when the host admitted the submission. A claim that is
 * never settled leaves nothing behind.
 *
 * `unknown` counts as fresh. It is the delivery record saying its history for
 * this conversation was compacted, so an absent id is not proof of nothing
 * sent; but the records that let the feed join an old message to its id are
 * the ones compaction removed, so a new send under such an id names only
 * itself. The author row is bound to the conversation, and the feed reads it
 * back only for that conversation.
 */

export function claimMessageAuthor(input: {
  actor: TeamActor;
  clientMessageId: string;
  conversationId: string | null;
  text: string;
  path?: string | null;
  priorSubmission: () => PriorSubmission;
}): MessageAuthorClaim | null {
  if (input.actor.kind !== "member") return null;
  const clientMessageId = input.clientMessageId.trim();
  if (!clientMessageId || !input.conversationId) return null;
  try {
    const store = existingTeamStore();
    if (!store) return null;
    /* The first author stands: a member's own retry finds its row here. */
    if (store.messageAuthors([clientMessageId]).size) return null;
    if (input.priorSubmission() === "admitted") return null;
  } catch {
    /* a record that cannot be read proves nothing fresh */
    return null;
  }
  return {
    actor: input.actor,
    clientMessageId,
    conversationId: input.conversationId,
    text: input.text,
    path: input.path ?? null,
  };
}

/** Records the claim once the host admitted the submission. Never throws. */
export function settleMessageAuthor(claim: MessageAuthorClaim | null): void {
  if (!claim) return;
  recordMessageAuthor({
    actor: claim.actor,
    clientMessageId: claim.clientMessageId,
    conversationId: claim.conversationId,
    text: claim.text,
  });
  recordConversationEvent({ actor: claim.actor, action: "message.sent", conversationId: claim.conversationId, path: claim.path });
}
