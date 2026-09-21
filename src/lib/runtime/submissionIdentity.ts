import { createHash } from "node:crypto";

import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type RegistryFile,
} from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

/*
 * WHICH SUBMISSION a transcript row is the record OF (#1950 round 2).
 *
 * The feed used to answer that by comparing TEXT, and text cannot answer it.
 * A document send reaches the agent as the operator's words plus the inbox
 * paths the route folded in, so the record never carries the text the row
 * shows; an attachment-only send carries no text at all; and two submissions
 * of the same words are two messages that a text comparison cannot tell
 * apart — which is how an unrelated arrival settled a send whose outcome
 * nobody had established.
 *
 * The delivery path already writes an identity that answers it exactly. Every
 * structured Codex delivery stamps `dedup=sha256(<operation id>)` onto the
 * canonical structured-user record (#1366), and the registry keeps, per
 * operation, the CLIENT message id that admitted it — the browser's own
 * idempotency key, which is also the outbox row's id. Composing the two gives
 * the feed a per-row join from the transcript to the submission, with no text
 * in it anywhere:
 *
 *     transcript row → dedup token → operation → client message id → row
 *
 * Read-side only. Nothing here writes, and every failure degrades to an empty
 * map: a row with no identity binds exactly as it did before.
 */

/** The token `codexAppServerHost` stamps onto a delivered structured-user
    record. Hashing is the host's decision — the marker names the operation
    without publishing it — and this module only has to agree with it. */
export function deliveryDedupToken(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}

export interface SubmissionIdentityDependencies {
  registrySnapshot?: () => RegistryFile;
}

/**
 * `dedup token → client message id` for the conversation that owns
 * `transcriptPath`.
 *
 * Scoped to the one conversation, so a browser is never handed the keys of
 * sends it did not make. A retry mints a fresh operation under the SAME client
 * message id, and both operations map to that one submission — which is the
 * point: the row is the message's, whichever attempt finally wrote it.
 */
export function submissionIdentities(
  transcriptPath: string,
  dependencies: SubmissionIdentityDependencies = {},
): Record<string, string> {
  if (!transcriptPath) return {};
  let snapshot: RegistryFile;
  try {
    snapshot = (dependencies.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()))();
  } catch {
    return {};
  }
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const conversation = lookup.conversationForPath(transcriptPath);
  if (!conversation) return {};
  const identities: Record<string, string> = {};
  const record = (operationId: unknown, clientMessageId: unknown, conversationId: unknown): void => {
    if (typeof operationId !== "string" || !operationId) return;
    if (typeof clientMessageId !== "string" || !clientMessageId) return;
    if (typeof conversationId !== "string" || !conversationId.startsWith("conversation_")) return;
    if (lookup.canonicalConversationId(conversationId as ViewerConversationId) !== conversation.id) return;
    identities[deliveryDedupToken(operationId)] = clientMessageId;
  };
  for (const [operationId, owner] of Object.entries(snapshot.deliveryOperationOwners ?? {})) {
    record(operationId, owner?.clientMessageId, owner?.conversationId);
  }
  /* The reservation carries the same pair while it is alive. Owners outlive
     it, so this adds nothing for a settled send — and it is what answers for
     a delivery admitted by a build that wrote no owner row. */
  for (const delivery of Object.values(snapshot.heldDeliveries ?? {})) {
    record(delivery?.command?.operationId, delivery?.clientMessageId, delivery?.conversationId);
  }
  return identities;
}
