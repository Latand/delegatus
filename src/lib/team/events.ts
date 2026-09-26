import crypto from "node:crypto";

import {
  type TeamActor,
  type TeamEvent,
  type TeamEventAction,
  type TeamEventDetail,
  type TeamEventSubject,
} from "./contract";
import { existingTeamStore, type EventQuery, type TeamStore } from "./store";

/*
 * Who did what (§3.7): one append-only table, written at the same places the
 * activity ledger's `recordOperatorRequest` already runs. Recording never
 * throws and never refuses the action it describes, the ledger's contract. An
 * install without a team records nothing, so a solo install keeps no audit it
 * never asked for.
 *
 * A row carries ids, a bounded title and a closed detail, and no message text.
 */

const TITLE_MAX = 120;
const PRUNE_EVERY = 64;
let writesSincePrune = 0;

let lastIdMs = 0;
let sequence = 0;

/** `<ms>-<sequence><random>`: sorts by time, and events of one millisecond
    in this process sort in the order they happened (a claim before the
    session it opens). */
export function eventId(nowMs: number): string {
  const ms = Math.max(nowMs, lastIdMs);
  sequence = ms === lastIdMs ? sequence + 1 : 0;
  lastIdMs = ms;
  return `${String(ms).padStart(13, "0")}-${sequence.toString(16).padStart(4, "0")}${crypto.randomBytes(2).toString("hex")}`;
}

function boundedTitle(title: string | null | undefined): string | null {
  const value = title?.replace(/\s+/g, " ").trim() ?? "";
  if (!value) return null;
  const chars = [...value];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("")}…` : value;
}

export interface TeamEventInput {
  actor: TeamActor;
  action: TeamEventAction;
  project?: string | null;
  subject?: TeamEventSubject | null;
  detail?: TeamEventDetail | null;
}

/** Appends to a given store; throws on a storage failure. */
export function appendTeamEvent(store: TeamStore, input: TeamEventInput, nowMs = Date.now()): TeamEvent {
  const event: TeamEvent = {
    id: eventId(nowMs),
    at: new Date(nowMs).toISOString(),
    actor: input.actor,
    action: input.action,
    project: input.project?.trim() || null,
    subject: input.subject ? { ...input.subject, title: boundedTitle(input.subject.title) } : null,
    detail: input.detail ?? null,
  };
  store.insertEvent(event);
  writesSincePrune += 1;
  if (writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0;
    store.pruneEvents(nowMs);
  }
  return event;
}

/**
 * Records an action taken on this install by a person (or by Delegatus on a
 * person's behalf, such as a Telegram join request). A no-op in solo mode.
 * An agent's own actions are not repeated here: its lineage and receipts
 * already say what it did, and the audit is for who among the people did
 * what. Never throws.
 */
export function recordTeamEvent(input: TeamEventInput, nowMs = Date.now()): void {
  if (input.actor.kind !== "member" && input.actor.kind !== "service") return;
  try {
    const store = existingTeamStore();
    if (!store || !store.hasActiveOwner()) return;
    appendTeamEvent(store, input, nowMs);
  } catch (error) {
    console.error("[team] event not recorded", { action: input.action, reason: (error as NodeJS.ErrnoException)?.code ?? "unavailable" });
  }
}

export function readTeamEvents(query: EventQuery): TeamEvent[] {
  const store = existingTeamStore();
  if (!store) return [];
  return store.events({ ...query, limit: Math.max(1, Math.min(200, query.limit)) });
}

/** The content digest a message author row keeps, for a join that has no
    submission id (the MCP read of a transcript). */
export function messageTextDigest(text: string): string {
  return crypto.createHash("sha256").update(text.trim()).digest("hex");
}

/**
 * Records which member sent a message, keyed by the submission's client
 * message id (the browser's own idempotency key). Never throws.
 */
export function recordMessageAuthor(input: {
  actor: TeamActor;
  clientMessageId: string;
  conversationId: string | null;
  text: string;
}, nowMs = Date.now()): void {
  if (input.actor.kind !== "member" || !input.clientMessageId) return;
  try {
    const store = existingTeamStore();
    if (!store) return;
    store.recordMessageAuthor({
      clientMessageId: input.clientMessageId,
      conversationId: input.conversationId,
      memberId: input.actor.memberId,
      at: new Date(nowMs).toISOString(),
      textDigest: input.text.trim() ? messageTextDigest(input.text) : null,
    });
  } catch (error) {
    console.error("[team] message author not recorded", { reason: (error as NodeJS.ErrnoException)?.code ?? "unavailable" });
  }
}
