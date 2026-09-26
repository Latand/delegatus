/**
 * Who authored a structured/MCP-delivered message (#1117).
 *
 * Every structured delivery flows through one admission chokepoint, and the
 * feed cannot tell the operator's own words from inter-agent relays without a
 * durable authorship fact stamped there. This module is that fact's vocabulary:
 *
 *  - `operator` — typed (or spoken) by the human on a Viewer surface.
 *  - `agent`    — sent by another session through MCP `send_message`, a flow
 *    relay, or a delegated spawn's first message. `role` names the sender as
 *    the server attributed it (orchestrator, reviewer, a role preset id, …).
 *
 * Scaffold rows carry NO origin: absence means "no delivery evidence", and the
 * feed keeps rendering such rows exactly as before. Classification must never
 * guess, so parsing drops anything it cannot validate; nothing is coerced.
 *
 * Pure and dependency-free on purpose: the Codex marker decode runs in the
 * browser feed parser, so this module must not pull in Node-only helpers.
 */

import type { SelectedContextRef } from "@/lib/selection/selectedContext";

export interface MessageOrigin {
  kind: "operator" | "agent";
  /** Sender role for agent origins, as attributed server-side at admission.
      Bounded to one marker-safe token so it can ride the structured-user
      marker and a journaled ledger record without a second escaping scheme. */
  role?: string;
  /** Captured from the sending conversation at admission, never from message text. */
  project?: string;
  conversationId?: string;
}

/**
 * The feed-facing authorship of one delivered message, keyed by the transcript
 * row's engine message id: the wire shape of `/api/log/provenance` and the
 * value the renderer resolves a delivered system row with. Client-safe on
 * purpose — the server join module and the browser share this one type.
 */
export interface DeliveredMessageProvenance {
  origin: "operator" | "agent";
  senderRole?: string;
  senderProject?: string;
  senderConversationId?: string;
  /** Carried through for operator rows so the bubble renders the same
      selected-card badge the composer showed at submission (#844). */
  selectedContext?: SelectedContextRef;
  /** Present when THIS delivery is an orchestrator seat's mandate (#1166).
      A seat is created by delivering its mandate, so the 8 KB lands in the
      transcript as an ordinary message; the delivery's own client-message
      identity is what sets this. Render-time only: nothing about the transcript
      or the delivery changes. */
  mandate?: MandateDelivery;
  /**
   * WHICH submission this row is the record of (#1950 round 2): the client
   * message id the delivery was admitted under — the browser's own
   * idempotency key, which is also the id of the outbox row the operator is
   * looking at. The feed binds the transcript's record into that row by this
   * and nothing else, so a document send (whose delivered text carries inbox
   * paths the row never showed), an attachment-only send (which has no text
   * at all) and two sends of the same words each bind to their own row.
   *
   * Client-safe: the key was minted in this browser and names one send of one
   * conversation. Absent when the record's own delivery cannot be named, and
   * absence binds nothing — never "probably this one".
   */
  submissionId?: string;
}

/**
 * WHICH mandate a delivery carried, as far as the evidence proves it (#1166).
 *
 * `version` names an approved default and `custom` the operator's own text.
 * `unqualified` is the honest third answer, and the reason this is a union
 * rather than a nullable number: the delivery IS a seat's mandate — its
 * identity says so — and nothing available names which one. The card then says
 * "Mandate" and claims nothing further.
 */
export type MandateDelivery =
  | { kind: "version"; version: number }
  | { kind: "custom" }
  | { kind: "unqualified" };

/**
 * One delivered message's occurrence evidence: the join for deliveries that
 * leave no per-row identity — a legacy tmux paste on either engine, a flow
 * relay, a pre-#1117 structured send. `textDigest` is the registry's content
 * digest of the delivered text (see `messageTextDigest`) and `deliveredAt`
 * its settlement time, so the feed can attach the evidence to exactly ONE
 * transcript row: the nearest-in-time row carrying the same text. The time is
 * what makes the join occurrence-specific — an operator's own message that
 * happens to repeat a relay's text stays the operator's.
 */
export interface DeliveredMessageOccurrence extends DeliveredMessageProvenance {
  textDigest: string;
  deliveredAt: string;
  /** The delivery's stable client-message id, when its transport reserved one
      (a structured send, a flow round's relay). Server-side join key only: two
      evidence stores that recorded the same delivery agree on it, so their
      occurrences collapse to one before serialization. Stripped from the
      wire shape. */
  clientMessageId?: string;
}

/** What the composer routes stamp on a caller that is not a Viewer page: a
    script or an agent holding the operator's token. Admitted the same, but
    never the operator's words. */
export const API_CLIENT_ORIGIN: MessageOrigin = { kind: "agent", role: "api-client" };

/** Same grammar as the other opaque marker tokens: no whitespace, no `>`. */
const ROLE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const CONVERSATION_ID = /^conversation_[A-Za-z0-9_-]{1,120}$/;

export function messageOriginRole(value: unknown): string | undefined {
  return typeof value === "string" && ROLE_TOKEN.test(value) ? value : undefined;
}

export function messageOriginProject(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 120
    && !value.startsWith("/") && !value.startsWith("\\") && !/[\u0000-\u001f<>]/.test(value) ? value : undefined;
}

export function messageOriginConversationId(value: unknown): string | undefined {
  return typeof value === "string" && CONVERSATION_ID.test(value) ? value : undefined;
}

/**
 * Validate an untrusted origin — a request body, a journal payload, a replayed
 * record. Returns null when the value is not an origin at all; a corrupt role
 * costs only the role, never the record's authorship kind.
 */
export function parseMessageOrigin(value: unknown): MessageOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.kind !== "operator" && body.kind !== "agent") return null;
  const role = body.kind === "agent" ? messageOriginRole(body.role) : undefined;
  const project = body.kind === "agent" ? messageOriginProject(body.project) : undefined;
  const conversationId = body.kind === "agent" ? messageOriginConversationId(body.conversationId) : undefined;
  return { kind: body.kind, ...(role ? { role } : {}), ...(project ? { project } : {}), ...(conversationId ? { conversationId } : {}) };
}
