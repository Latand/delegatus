/**
 * The voice companion's event contract, version 1 (#2519,
 * docs/design/voice-companion-research.md §6).
 *
 * These are normalized application events. The simulator emits them from a
 * script; the official-realtime adapter derives them from provider,
 * playback and delivery/report events. The companion consumes one reducer
 * over this stream and has no branch for either source.
 *
 * Transcript events carry the text the model generated. Generation runs ahead
 * of playback and carries no word timing, so a transcript says nothing about
 * which words were heard; playback events alone say how much audio played.
 *
 * Pure and dependency-free: the reducer runs in the browser and in tests.
 */

import type { SessionTranscriptRecord } from "./transcriptRecord";
import type { RetainedCall } from "./callHistoryTypes";

export type Id = string;
export type Locale = "en" | "uk";

export type Recipient = {
  project: Id;
  conversationId: Id;
  seatEpoch: number;
  engine: "claude" | "codex";
};

export type Proposal = {
  authority?: "live-model";
  proposalId: Id;
  callId: Id;
  sourceItemId: Id;
  instruction: string;
  recipient: Recipient;
  /** Present when the model asked for the operator's answer before sending, with its short reason. */
  confirmation?: { reason: string };
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

/** One window of the paying account's plan, as Codex reports it. */
export interface PlanWindow {
  usedPercent: number;
  /** Unix seconds; null when Codex gave no reset. */
  resetsAt: number | null;
  windowMinutes: number | null;
}
/** The plan of the Codex account a call runs on. It is that whole account's
 * use, its workers included, and names nothing but the plan type. */
export interface CompanionPlan {
  type: string | null;
  primary: PlanWindow | null;
  secondary: PlanWindow | null;
  limitReached: boolean;
  observedAt: number;
}
/** A call on the API: what it cost against the monthly cap. */
export interface ApiCompanionUsage {
  backend?: "api";
  callUsd: number;
  callFinal: boolean;
  callIncomplete: boolean;
  month: string;
  monthUsd: number;
  monthCapUsd: number;
}
/** A call on Codex: its length and the plan window of the account it runs on. */
export interface CodexCompanionUsage {
  backend: "codex";
  /** The call's length on the server clock, from the voice's start to its close. */
  callSeconds: number;
  /** The call has ended and its length is final. */
  callFinal: boolean;
  plan: CompanionPlan | null;
  /** The primary window's use at the call's first reading: the meter's rise starts there. */
  planStartPercent: number | null;
}
/** The figures of the backend a call actually ran on. */
export type CompanionUsage = ApiCompanionUsage | CodexCompanionUsage;

export type Payload =
  | { type: "usage.updated"; usage: CompanionUsage }
  | { type: "context.updated"; project: string | null }
  | { type: "session.ready"; mode: CompanionMode }
  | { type: "session.closed"; reason: "operator" | "tool" | "cap" | "limit" | "transport" | "error"; incomplete?: boolean }
  | { type: "input.speech.started"; itemId: Id }
  | { type: "input.speech.stopped"; itemId: Id }
  | { type: "transcript.delta"; speaker: "operator" | "companion"; itemId: Id; responseId?: Id; delta: string }
  | { type: "transcript.final"; speaker: "operator" | "companion"; itemId: Id; responseId?: Id; text: string }
  /** Whole display segment; final marks a display boundary, never consent. */
  | { type: "transcript.snapshot"; speaker: "operator" | "companion"; itemId: Id; text: string; final: boolean; startMs?: number; endMs?: number }
  | { type: "response.started"; responseId: Id; itemId: Id }
  | { type: "response.generated"; responseId: Id; status: "completed" | "cancelled" | "failed" }
  /** A started playback names the line it plays. The same response again names
   * the line its audio turned out to belong to, with what has played so far. */
  | { type: "playback.started"; responseId: Id; itemId: Id; playedMs?: number }
  | { type: "playback.level"; responseId: Id; itemId: Id; rms: number; playedMs: number }
  | { type: "playback.stopped"; responseId: Id; itemId: Id; playedMs: number; reason: "ended" | "interrupted" | "muted" | "closed" }
  | { type: "tool.called"; callId: Id; name: string; summary: string }
  | { type: "tool.result"; callId: Id; status: "done" | "failed"; summary: string }
  | { type: "delegation.tool.called"; callId: Id; sourceItemId: Id; instruction: string }
  /** The default: the model raised the delegation with no confirmation asked, and delivery starts at once. */
  | { type: "delegation.sending"; proposal: Proposal }
  /** The exception: the model asked for the operator's answer first. */
  | { type: "delegation.confirmation.required"; proposal: Proposal }
  | { type: "delegation.retargeted"; proposalId: Id; recipient: Recipient }
  | { type: "delegation.confirmed"; proposalId: Id; via: "tap" | "speech"; confirmationItemId?: Id }
  | {
      type: "delegation.tool.result";
      callId: Id;
      proposalId?: Id;
      result:
        | { status: "delivered" | "queued" | "unknown"; delivery: Delivery }
        | { status: "refused" | "cancelled"; code: string };
    }
  | { type: "delegation.delivery.settled"; delivery: Delivery; status: "delivered" | "failed"; code?: string }
  | { type: "orchestrator.report"; reportId: Id; status: "progress" | "result" | "question" | "blocked" | "message"; text: string; at: number; project: string }
  | { type: "orchestrator.answer"; delivery: Delivery; reportId: Id; status: "progress" | "result" | "question" | "blocked"; text: string }
  /** `resetsAt` (Unix seconds) names when a refused plan limit resets. */
  | { type: "error"; code: string; recoverable: boolean; resetsAt?: number };

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
  /** Updates browser context on the same call, including while it starts. */
  setProject?(project: string | null): Promise<void>;
  subscribe(emit: (event: CompanionEvent) => void): () => void;
  command(command: CompanionCommand): Promise<void>;
  /** drains ownership cleanup; idempotent */
  close(): Promise<void>;
  /** Optional read-only delivery observation, including after media hangup. */
  refresh?(): Promise<void>;
  /** The whole conversation of the latest session, still readable after it ended; null before the first. */
  transcript?(sessionId?: Id): Promise<SessionTranscriptRecord | null>;
  /** The operator's retained calls, newest first, each with what it did; `transcript(sessionId)` opens one. Read
   * when a page opens, so a reload keeps the history the page itself never saw. */
  calls?(): Promise<RetainedCall[]>;
  /** Unmount also releases delivery observation. */
  dispose?(): Promise<void>;
}

/** The presentation channel a voice delegation carries into the
    orchestrator's conversation. It tints the row and grants no authority. */
export const VOICE_DELEGATUS_CHANNEL = "voice-delegatus";
