"use client";

import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";

import { UNCONFIRMED_RECEIPT_PREFIX } from "./messageRow";
import type { OutboxEntry } from "./outbox";

/**
 * The join from a transcript record to the operator's own row, computed IN THE
 * BROWSER (#1950 round 2, second round of fixes).
 *
 * The record names the delivery that wrote it — `dedup=sha256(<operation id>)`
 * on the structured-user marker — and the delivery path hands this browser the
 * other half of that pair the moment it answers: the admission response
 * carries the operation id beside the idempotency key the row is filed under,
 * and so does every receipt the stream publishes for it. Hashing the operation
 * ids the queue already holds therefore yields the same
 * `token → submission` map the registry serves over `/api/log/provenance`, for
 * every delivery this browser has heard about — with nothing in flight.
 *
 * That is the whole point. The server's map is authoritative and it is also a
 * response, and a response can be beaten to the screen by the record it
 * explains: while it was the only join, a document's record and an
 * attachment-only record painted a SECOND copy of the message for as long as
 * the round trip took. This map is in hand before the record can exist, since
 * the operation it names is the one the queue was told about.
 *
 * It does not replace the server's map, it precedes it. A delivery this
 * browser never heard an answer about — the send whose acknowledgement was
 * lost — has no operation id here, and only the registry can name it.
 */

/* One digest per operation id for the life of the tab. The queue is bounded
   and its ids are immutable, so this is a handful of entries that never need
   recomputing across the renders of one conversation. */
const tokens = new Map<string, string>();

function tokenFor(operationId: string): string {
  let token = tokens.get(operationId);
  if (token === undefined) {
    token = deliveryDedupToken(operationId);
    tokens.set(operationId, token);
  }
  return token;
}

/**
 * `dedup token → submission id` for every delivery in this queue whose
 * operation this browser can name.
 *
 * Both places an operation is recorded are read — the entry's own admission id
 * and the identity on the receipt projected onto it — because a receipt can
 * arrive for a key whose HTTP response never named an operation, and the row
 * it belongs to is the same row either way. A retry mints a fresh operation
 * under the SAME key, so several tokens may name one submission, which is
 * exactly right: the row is the message's, whichever attempt wrote it.
 */
export function localSubmissionJoin(entries: readonly OutboxEntry[]): ReadonlyMap<string, string> {
  const join = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.id) continue;
    for (const operationId of [entry.operationId, entry.deliveryReceipt?.operationId]) {
      if (!operationId) continue;
      /* The composer's own placeholder for a window that closed with nothing
         durable in it names no operation at all: hashing it would mint a
         token no record can ever carry. */
      if (operationId.startsWith(UNCONFIRMED_RECEIPT_PREFIX)) continue;
      join.set(tokenFor(operationId), entry.id);
    }
  }
  return join;
}

/**
 * Whether this browser can name the delivery behind a submission at all.
 *
 * True the moment an operation id comes back, by either route. False for the
 * one row that has none — the send whose acknowledgement was lost — which is
 * the only case where a record's own identity cannot be checked against the
 * queue without asking the registry.
 */
export function submissionNamesItsDelivery(entry: OutboxEntry): boolean {
  for (const operationId of [entry.operationId, entry.deliveryReceipt?.operationId]) {
    if (operationId && !operationId.startsWith(UNCONFIRMED_RECEIPT_PREFIX)) return true;
  }
  return false;
}
