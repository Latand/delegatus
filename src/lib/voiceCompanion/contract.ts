/**
 * The voice companion's event contract, version 1 (#2519,
 * docs/design/voice-companion-research.md §6).
 *
 * These are normalized application events. The simulator emits them from a
 * script; a future official-realtime adapter derives them from provider,
 * playback and delivery/report events. The window consumes one reducer over
 * this stream and has no branch for either source.
 *
 * Pure and dependency-free: the reducer runs in the browser and in tests.
 */

export type Id = string;
export type Locale = "en" | "uk";

export type Recipient = {
  project: Id;
  conversationId: Id;
  seatEpoch: number;
  engine: "claude" | "codex";
};

export type Proposal = {
  proposalId: Id;
  callId: Id;
  sourceItemId: Id;
  instruction: string;
  recipient: Recipient;
};

export type Delivery = {
  proposalId: Id;
  callId: Id;
  clientMessageId: Id;
  /** null while an unknown outcome awaits receipt recovery */
  operationId: Id | null;
  recipient: Recipient;
};

export type CompanionMode = "simulated" | "official-realtime";

export type Payload =
  | { type: "session.ready"; mode: CompanionMode }
  | { type: "session.closed"; reason: "operator" | "transport" | "error" }
  | { type: "input.speech.started"; itemId: Id }
  | { type: "input.speech.stopped"; itemId: Id }
  | { type: "transcript.delta"; speaker: "operator" | "companion"; itemId: Id; responseId?: Id; delta: string }
  | { type: "transcript.final"; speaker: "operator" | "companion"; itemId: Id; responseId?: Id; text: string }
  | { type: "response.started"; responseId: Id; itemId: Id }
  | { type: "response.generated"; responseId: Id; status: "completed" | "cancelled" | "failed" }
  | { type: "playback.started"; responseId: Id; itemId: Id }
  | { type: "playback.level"; responseId: Id; itemId: Id; rms: number; playedMs: number }
  | { type: "playback.stopped"; responseId: Id; itemId: Id; playedMs: number; reason: "ended" | "interrupted" | "muted" | "closed" }
  | { type: "delegation.tool.called"; callId: Id; sourceItemId: Id; instruction: string }
  | { type: "delegation.confirmation.required"; proposal: Proposal }
  | { type: "delegation.confirmed"; proposalId: Id; via: "tap" | "speech"; confirmationItemId?: Id }
  | {
      type: "delegation.tool.result";
      callId: Id;
      proposalId?: Id;
      result:
        | { status: "delivered" | "queued" | "unknown"; delivery: Delivery }
        | { status: "refused" | "cancelled"; code: string };
    }
  | { type: "delegation.delivery.settled"; delivery: Delivery; status: "delivered" | "failed" }
  | { type: "orchestrator.answer"; delivery: Delivery; reportId: Id; status: "progress" | "result" | "question" | "blocked"; text: string }
  | { type: "error"; code: string; recoverable: boolean };

export type CompanionEvent = Payload & {
  version: 1;
  /** local companion session, separate from provider IDs */
  sessionId: Id;
  /** changes on reconnect */
  generation: number;
  /** deduplication within generation */
  eventId: Id;
  /** adapter ordering within generation */
  seq: number;
  /** monotonic session time, useful for replay/measurement */
  atMs: number;
};

export type CompanionCommand =
  | { type: "confirmation"; proposalId: Id; decision: "send" | "cancel"; via: "tap" | "speech"; confirmationItemId?: Id }
  | { type: "interrupt"; responseId: Id }
  | { type: "mute"; muted: boolean };

export interface VoiceCompanionAdapter {
  readonly mode: CompanionMode;
  start(options: { locale: Locale; project: Id }): Promise<void>;
  subscribe(emit: (event: CompanionEvent) => void): () => void;
  command(command: CompanionCommand): Promise<void>;
  /** drains ownership cleanup; idempotent */
  close(): Promise<void>;
}

/** The presentation channel a confirmed voice delegation carries into the
    orchestrator's conversation. It tints the row and grants no authority. */
export const VOICE_DELEGATUS_CHANNEL = "voice-delegatus";
