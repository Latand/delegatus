/**
 * When each operator message to a conversation was first admitted.
 *
 * The record began as the store of the reply drafts a seat offered under its
 * own message (#1202), and keeps that store's name: the `reply_suggestions`
 * collection in `state.sqlite` and `reply-suggestions.json` before it. The
 * drafts are gone (every operator ask is a decision form now); the admission
 * receipts they kept stay, because Needs-you, the attention reconcile and the
 * bridge's open asks read them as "the operator wrote here since".
 *
 * Sets an older release stored are never read; the record's next write drops
 * their rows.
 */

export const REPLY_SUGGESTIONS_SCHEMA_VERSION = 1;

/** Operator messages whose admission moment is remembered, across every
    conversation. Only a message being re-delivered under a key it already used
    consults one, so this is a short replay window, not a history. */
export const REPLY_SUGGESTION_ADMISSION_CAPACITY = 128;

/** Bound on a remembered message key. The send paths already cap their own
    idempotency keys; the record refuses to grow past the same bound whatever
    reaches it. */
export const MAX_OPERATOR_MESSAGE_KEY_CHARS = 128;

/**
 * When one operator message was FIRST admitted (#1202 review round 2).
 *
 * A message the client re-delivers under the key it already used is the SAME
 * message, so its moment is remembered per key and reused by every replay.
 */
export interface ReplySuggestionAdmissionV1 {
  conversationId: string;
  /** The send path's own idempotency key for that message. */
  key: string;
  /** When the message was first admitted. */
  at: string;
}

export interface ReplySuggestionsFileV1 {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  admissions: ReplySuggestionAdmissionV1[];
}
