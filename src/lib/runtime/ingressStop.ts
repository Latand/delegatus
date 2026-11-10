/**
 * Where a message-bearing request stopped without being admitted, in a fixed
 * vocabulary.
 *
 * Incident 2026-11-09: one operator send passed the send route's bookkeeping
 * and never got a delivery reservation, and nothing recorded which step turned
 * it away. A later lookup under its key could only say `not-executed`, which
 * is the same answer a request that never reached the server gets. The two
 * need different repairs: a refusal has a reason the operator can act on, and
 * a transport loss has none.
 *
 * So every exit of `POST /api/runtime/send` (and steer and inject) that ends
 * without an admitted operation names the boundary it stopped at and a reason
 * code. The pair rides on the response, is written as one diagnostic line
 * through the Viewer's own log, and is kept for the admission lookup, which
 * then answers `not-executed` together with the refusal it recorded. A lookup
 * that finds no stop for a key the registry never saw is the transport-loss
 * case: the request never reached the route, or never finished its first
 * step.
 *
 * Codes and ids only. Message text, attachment names and account names never
 * enter a stop record or its log line.
 */

/** The ordered steps of the send route, earliest first. */
export type IngressBoundary =
  /** Validation, inbox staging and attachment admission. */
  | "intake"
  /** Recording which member may write to the conversation. */
  | "authority"
  /** The operator ledgers and author claim written before the hand-off. */
  | "bookkeeping"
  /** Delivery admission: the reservation and the journal command. */
  | "admission"
  /** The direct runtime command, when no structured delivery owns the send. */
  | "dispatch";

export type IngressStopReason =
  /** The command itself was malformed (text, size, fields). */
  | "command-invalid"
  /** An image was refused: its type, its size or its count. */
  | "image-refused"
  /** A file attachment was refused: its type, its size or its count. */
  | "file-refused"
  | "inbox-unavailable"
  | "authority-unrecorded"
  | "bookkeeping-failed"
  /** Admission turned the message away before anything was reserved. */
  | "refused-before-reservation"
  /** Admission answered a failure after its reservation existed. */
  | "failed-after-reservation"
  | "ownership-unavailable"
  | "host-unavailable"
  /** The call threw while the message may have been on its way. */
  | "outcome-unknown"
  | "idempotency-conflict";

/** Every reason a stop can carry, for readers that check a reply. */
export const INGRESS_STOP_REASONS: readonly IngressStopReason[] = [
  "command-invalid", "image-refused", "file-refused", "inbox-unavailable", "authority-unrecorded",
  "bookkeeping-failed", "refused-before-reservation", "failed-after-reservation", "ownership-unavailable",
  "host-unavailable", "outcome-unknown", "idempotency-conflict",
];

export const INGRESS_BOUNDARIES: readonly IngressBoundary[] = ["intake", "authority", "bookkeeping", "admission", "dispatch"];

export interface IngressStop {
  boundary: IngressBoundary;
  reason: IngressStopReason;
}

export interface IngressStopRecord extends IngressStop {
  conversationId: string;
  clientMessageId: string;
  kind: string;
  status: number;
  /** The route's own delivery classification on the same response. */
  delivery: "refused" | "uncertain" | null;
  ingressAt: string;
  at: string;
}

/** How many recent stops the lookup can name. Older keys still answer from the
    registry; only the reason is forgotten. */
export const INGRESS_STOP_CAPACITY = 512;

/* One owner: the Viewer process that served the request. A restart forgets the
   reasons and keeps the log lines, and the lookup's own verdict never depends
   on this map. Insertion order is the eviction order. */
const stops = new Map<string, IngressStopRecord>();

function stopKey(conversationId: string, clientMessageId: string): string {
  return `${conversationId}\u0000${clientMessageId}`;
}

type IngressStopLog = (line: string, fields: Record<string, unknown>) => void;
let log: IngressStopLog = (line, fields) => console.warn(line, fields);

/**
 * Remembers one stop and writes its diagnostic line. Never throws: a request
 * that has already answered must not fail on its own diagnostics.
 */
export function recordIngressStop(record: IngressStopRecord): void {
  try {
    const key = stopKey(record.conversationId, record.clientMessageId);
    stops.delete(key);
    stops.set(key, record);
    while (stops.size > INGRESS_STOP_CAPACITY) {
      const oldest = stops.keys().next().value;
      if (oldest === undefined) break;
      stops.delete(oldest);
    }
    log("[runtime ingress] message stopped before admission", {
      conversationId: record.conversationId,
      clientMessageId: record.clientMessageId,
      kind: record.kind,
      boundary: record.boundary,
      reason: record.reason,
      status: record.status,
      delivery: record.delivery,
      ingressAt: record.ingressAt,
      at: record.at,
    });
  } catch { /* Diagnostics never change a delivery answer. */ }
}

/** The last stop recorded for this key in this process, if any. */
export function ingressStopFor(conversationId: string, clientMessageId: string): IngressStopRecord | null {
  return stops.get(stopKey(conversationId, clientMessageId)) ?? null;
}

/** A later admission under the same key outranks the stop it replaced. */
export function forgetIngressStop(conversationId: string, clientMessageId: string): void {
  stops.delete(stopKey(conversationId, clientMessageId));
}

export function resetIngressStopsForTests(logger?: IngressStopLog): void {
  stops.clear();
  log = logger ?? ((line, fields) => console.warn(line, fields));
}
