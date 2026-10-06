import type { CompanionEvent, CompanionMode, Delivery, Id, Proposal, Recipient } from "./contract";
import { admitDelegationProposal, type GateRefusal } from "./gate";

/**
 * The one reducer the voice companion reads (#2519, design note §6). It joins
 * the normalized events into what the companion draws: the character's phase,
 * the mouth level, the speech lines, the tool calls and the delegation.
 *
 * Runtime rules it enforces, whatever adapter produced the stream:
 *  - a duplicate `eventId` and an event of a retired generation change nothing;
 *  - transcripts are keyed by speaker and item, and a final replaces the
 *    provisional text;
 *  - a companion line's text is what the model generated; whether it was
 *    heard is a separate fact, read only from playback events, and a line
 *    whose playback was cut keeps its generated text marked as cut, with the
 *    milliseconds that played;
 *  - the mouth stays active until playback stops, whenever generation ended;
 *  - input speech interrupts playback and leaves delivered work alone;
 *  - a confirmation is shown only for an explicit request (the gate of
 *    `gate.ts`) and stays only while that request is the operator's last
 *    word: newer input, finished or not, or a corrected source withdraws it,
 *    and a later confirmation finds nothing to confirm;
 *  - a tool result, a settlement and an answer count only
 *    when they bind the whole frozen delivery: proposal, call, message key,
 *    recipient and operation.
 */

export type CompanionPhase = "offline" | "idle" | "listening" | "thinking" | "speaking";

export type LineSpeaker = "operator" | "companion";

/** How much of a companion line's audio played. An operator line is `none`. */
export type LinePlayback = "none" | "pending" | "playing" | "played" | "cut";

export interface SpeechLine {
  /** `speaker:itemId`, stable while the text streams. */
  key: string;
  speaker: LineSpeaker;
  itemId: Id;
  /** The transcript as generated (companion) or recognized (operator). */
  text: string;
  final: boolean;
  playback: LinePlayback;
  /** Audio that played before a cut; null unless `playback` is `cut`. */
  playedMs: number | null;
  /** Bumps when the line changes, so a view can expire it from its last change. */
  revision: number;
}

export interface ToolCallView {
  callId: Id;
  name: string;
  summary: string;
  status: "running" | "done" | "failed";
  result: string | null;
  revision: number;
}

export type DelegationStage =
  | "proposed"
  | "awaiting-confirmation"
  | "sending"
  | "queued"
  | "delivered"
  | "unknown"
  | "answered"
  | "refused"
  | "cancelled"
  | "failed";

export interface DelegationView {
  callId: Id;
  instruction: string;
  stage: DelegationStage;
  proposal: Proposal | null;
  /** The source input as it read when the proposal froze. */
  sourceText: string | null;
  delivery: Delivery | null;
  /** Why a proposal was refused before it reached the operator, or withdrawn while it waited. */
  refusal: GateRefusal | string | null;
  answer: { reportId: Id; status: "progress" | "result" | "question" | "blocked"; text: string } | null;
}

export interface CompanionState {
  mode: CompanionMode | null;
  generation: number;
  phase: CompanionPhase;
  /** Played-audio level in [0, 1]; changes every frame while speaking. */
  mouth: number;
  /** Milliseconds of the playing response that have played; moves with the mouth. */
  playedMs: number;
  /** Bumps on every change other than the level samples, so a view can skip
      rendering for a level sample. */
  revision: number;
  lines: readonly SpeechLine[];
  calls: readonly ToolCallView[];
  delegation: DelegationView | null;
  /** The response whose audio is playing, for an interrupt. */
  playing: { responseId: Id; itemId: Id } | null;
  error: string | null;
  seen: ReadonlySet<Id>;
  levelSeq: number;
  reports: ReadonlySet<Id>;
}

/** Lines kept for the static transcript; the companion shows only the newest. */
export const LINE_HISTORY = 40;
const CALL_HISTORY = 12;
const TEXT_LIMIT = 4_000;
const ID_LIMIT = 200;

export const INITIAL_COMPANION_STATE: CompanionState = {
  mode: null, generation: 0, phase: "offline", mouth: 0, playedMs: 0, revision: 0, lines: [], calls: [], delegation: null,
  playing: null, error: null, seen: new Set(), levelSeq: -1, reports: new Set(),
};

const validId = (value: unknown): value is Id => typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT;
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const bounded = (text: string) => (text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text);
const ms = (value: number) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

function wellFormed(event: CompanionEvent): boolean {
  return event.version === 1 && validId(event.sessionId) && validId(event.eventId)
    && Number.isInteger(event.generation) && event.generation >= 0
    && Number.isInteger(event.seq) && event.seq >= 0
    && Number.isFinite(event.atMs) && event.atMs >= 0;
}

function upsertLine(lines: readonly SpeechLine[], speaker: LineSpeaker, itemId: Id, revision: number, change: (line: SpeechLine) => Partial<SpeechLine>): readonly SpeechLine[] {
  const key = `${speaker}:${itemId}`;
  const index = lines.findIndex((line) => line.key === key);
  const current: SpeechLine = index === -1
    ? { key, speaker, itemId, text: "", final: false, playback: speaker === "operator" ? "none" : "pending", playedMs: null, revision }
    : lines[index]!;
  const next = { ...current, ...change(current), revision };
  if (index === -1) return [...lines, next].slice(-LINE_HISTORY);
  const copy = [...lines];
  copy[index] = next;
  return copy;
}

function upsertCall(calls: readonly ToolCallView[], callId: Id, revision: number, change: (call: ToolCallView | null) => ToolCallView | null): readonly ToolCallView[] {
  const index = calls.findIndex((call) => call.callId === callId);
  const next = change(index === -1 ? null : calls[index]!);
  if (!next) return calls;
  if (index === -1) return [...calls, { ...next, revision }].slice(-CALL_HISTORY);
  const copy = [...calls];
  copy[index] = { ...next, revision };
  return copy;
}

const sameRecipient = (left: Recipient, right: Recipient) =>
  left.project === right.project && left.conversationId === right.conversationId && left.seatEpoch === right.seatEpoch && left.engine === right.engine;

/** The frozen identity of a delivery, without its operation. */
const sameBinding = (left: Delivery, right: Delivery) =>
  left.clientMessageId === right.clientMessageId && left.proposalId === right.proposalId && left.callId === right.callId && sameRecipient(left.recipient, right.recipient);

/**
 * A settlement joins the confirmed delivery when its whole binding matches.
 * While the outcome is unknown (no operation yet), only a settlement that
 * recovers the original receipt, with its operation, is accepted.
 */
function settles(current: Delivery | null, incoming: Delivery): boolean {
  if (!current || !sameBinding(current, incoming) || !validId(incoming.operationId)) return false;
  return current.operationId === null || current.operationId === incoming.operationId;
}

/** An answer joins only a delivery whose operation is known and identical. */
const answers = (current: Delivery | null, incoming: Delivery) =>
  !!current && current.operationId !== null && sameBinding(current, incoming) && incoming.operationId === current.operationId;

const operatorInputs = (lines: readonly SpeechLine[]) =>
  lines.filter((line) => line.speaker === "operator").map((line) => ({ itemId: line.itemId, text: line.text, final: line.final }));

/**
 * A waiting proposal, read against the operator's lines as they are now. It is
 * withdrawn once the gate no longer admits it: the operator spoke again, or
 * the input it was frozen from reads differently.
 */
function standing(delegation: DelegationView | null, lines: readonly SpeechLine[]): DelegationView | null {
  if (!delegation?.proposal || delegation.stage !== "awaiting-confirmation") return delegation;
  const { proposal } = delegation;
  const verdict = admitDelegationProposal({
    sourceItemId: proposal.sourceItemId, instruction: proposal.instruction, inputs: operatorInputs(lines),
    ...(delegation.sourceText === null ? {} : { frozenSourceText: delegation.sourceText }),
  });
  return verdict.admit ? delegation : { ...delegation, stage: "cancelled", refusal: verdict.reason };
}

/** Marks the companion line that was playing as cut, keeping its generated text. */
function cut(lines: readonly SpeechLine[], itemId: Id, playedMs: number, revision: number) {
  return upsertLine(lines, "companion", itemId, revision, (line) => (line.playback === "played" ? {} : { playback: "cut", playedMs: ms(playedMs) }));
}

export function reduceCompanion(state: CompanionState, event: CompanionEvent): CompanionState {
  if (!wellFormed(event)) return state;
  if (event.generation < state.generation) return state;
  let base = state;
  if (event.generation > state.generation) {
    /* A reconnect retires proposal authority and every provisional line;
       delivered work stays visible and can still be answered. */
    const delegation = state.delegation && ["sending", "queued", "delivered", "unknown", "answered"].includes(state.delegation.stage) ? state.delegation : null;
    const lines = state.lines.filter((line) => line.final || line.playback === "cut")
      .map((line) => (line.playback === "playing" || line.playback === "pending" ? { ...line, playback: "cut" as const, playedMs: line.playback === "playing" ? state.playedMs : 0 } : line));
    base = { ...state, generation: event.generation, seen: new Set(), levelSeq: -1, playing: null, mouth: 0, playedMs: 0, delegation, lines,
      calls: state.calls.map((call) => (call.status === "running" ? { ...call, status: "failed" as const, result: null } : call)),
      phase: state.phase === "offline" ? "offline" : "idle" };
  }
  if (event.type === "playback.level") {
    if (event.seq <= base.levelSeq || base.playing?.responseId !== event.responseId) return base;
    return { ...base, mouth: clamp01(event.rms), playedMs: ms(event.playedMs), levelSeq: event.seq };
  }
  if (base.seen.has(event.eventId)) return base;
  const revision = base.revision + 1;
  const next = (change: Partial<CompanionState>): CompanionState =>
    ({ ...base, ...change, seen: new Set(base.seen).add(event.eventId), revision });

  switch (event.type) {
    case "session.ready":
      return next({ mode: event.mode, phase: "idle", error: null });
    case "session.closed": {
      const lines = base.playing ? cut(base.lines, base.playing.itemId, base.playedMs, revision) : base.lines;
      return next({ phase: "offline", playing: null, mouth: 0, lines, error: event.reason === "operator" ? null : event.reason });
    }
    case "input.speech.started": {
      /* Barge-in: the mouth stops at once. The line keeps the text that was
         generated, marked cut at the audio that had played; delivered work
         is untouched. */
      if (!validId(event.itemId)) return base;
      const cutLines = base.playing ? cut(base.lines, base.playing.itemId, base.playedMs, revision) : base.lines;
      const lines = upsertLine(cutLines, "operator", event.itemId, revision, () => ({}));
      return next({ phase: "listening", playing: null, mouth: 0, lines, delegation: standing(base.delegation, lines) });
    }
    case "input.speech.stopped":
      return next({ phase: base.phase === "listening" ? "thinking" : base.phase });
    case "transcript.delta": {
      if (!validId(event.itemId)) return base;
      const existing = base.lines.find((line) => line.key === `${event.speaker}:${event.itemId}`);
      if (existing?.final) return next({});
      const lines = upsertLine(base.lines, event.speaker, event.itemId, revision, (line) => ({ text: bounded(line.text + event.delta) }));
      return next({ lines, delegation: event.speaker === "operator" ? standing(base.delegation, lines) : base.delegation });
    }
    case "transcript.final": {
      if (!validId(event.itemId)) return base;
      /* The final transcript replaces the provisional text. It says nothing
         about playback, so a cut line stays cut. */
      const lines = upsertLine(base.lines, event.speaker, event.itemId, revision, () => ({ text: bounded(event.text), final: true }));
      return next({ lines, delegation: event.speaker === "operator" ? standing(base.delegation, lines) : base.delegation });
    }
    case "response.started":
      return next({ phase: base.phase === "listening" ? "listening" : base.phase === "speaking" ? "speaking" : "thinking" });
    case "response.generated":
      /* Generation ending says nothing about playback: the mouth follows the
         audio that is still being played. */
      return next(event.status === "failed" && !base.playing ? { phase: "idle" } : {});
    case "playback.started":
      if (!validId(event.itemId)) return base;
      return next({ phase: "speaking", playing: { responseId: event.responseId, itemId: event.itemId }, playedMs: 0,
        lines: upsertLine(base.lines, "companion", event.itemId, revision, () => ({ playback: "playing", playedMs: null })) });
    case "playback.stopped": {
      const line = base.lines.find((candidate) => candidate.key === `companion:${event.itemId}`);
      if (base.playing?.responseId !== event.responseId) {
        /* A barge-in already cut this line; the player's own count of what played is the better number. */
        if (line?.playback === "cut" && event.reason !== "ended") return next({ lines: upsertLine(base.lines, "companion", event.itemId, revision, () => ({ playedMs: ms(event.playedMs) })) });
        return next({});
      }
      const lines = event.reason === "ended"
        ? upsertLine(base.lines, "companion", event.itemId, revision, () => ({ playback: "played", playedMs: null }))
        : cut(base.lines, event.itemId, event.playedMs, revision);
      return next({ phase: "idle", playing: null, mouth: 0, lines });
    }
    case "tool.called":
      if (!validId(event.callId)) return base;
      return next({ phase: base.phase === "speaking" ? "speaking" : "thinking",
        calls: upsertCall(base.calls, event.callId, revision, (call) => call ?? { callId: event.callId, name: bounded(event.name).slice(0, 80), summary: bounded(event.summary).slice(0, 240), status: "running", result: null, revision }) });
    case "tool.result":
      return next({ calls: upsertCall(base.calls, event.callId, revision, (call) => (call && call.status === "running" ? { ...call, status: event.status, result: bounded(event.summary).slice(0, 240) } : null)) });
    case "delegation.tool.called": {
      if (!validId(event.callId)) return base;
      /* A tool call is a candidate and nothing more: it opens no delivery. */
      return next({ delegation: { callId: event.callId, instruction: bounded(event.instruction), stage: "proposed", proposal: null, sourceText: null, delivery: null, refusal: null, answer: null } });
    }
    case "delegation.confirmation.required": {
      const { proposal } = event;
      if (base.delegation?.callId !== proposal.callId || base.delegation.stage !== "proposed") return next({});
      /* The same gate the adapter applied, read against the lines this reducer
         holds: a confirmation for anything but an explicit request is refused. */
      const inputs = operatorInputs(base.lines);
      const verdict = admitDelegationProposal({ sourceItemId: proposal.sourceItemId, instruction: proposal.instruction, inputs });
      if (!verdict.admit) return next({ delegation: { ...base.delegation, stage: "refused", refusal: verdict.reason } });
      const sourceText = inputs.find((input) => input.itemId === proposal.sourceItemId)?.text ?? null;
      return next({ delegation: { ...base.delegation, stage: "awaiting-confirmation", proposal, sourceText, instruction: bounded(proposal.instruction) } });
    }
    case "delegation.confirmed": {
      const current = base.delegation;
      if (!current?.proposal || current.proposal.proposalId !== event.proposalId || current.stage !== "awaiting-confirmation") return next({});
      /* Only a tap confirms. Consent by speech is not admitted anywhere yet,
         so such a confirmation leaves the proposal waiting, and the delivery
         result an adapter sends after it finds no proposal in "sending". */
      if (event.via !== "tap") return next({});
      return next({ delegation: { ...current, stage: "sending" } });
    }
    case "delegation.tool.result": {
      const current = base.delegation;
      if (!current || current.callId !== event.callId) return next({});
      const { result } = event;
      if (!("delivery" in result)) {
        /* Cancel before admission has zero sends; after admission the work
           is already out and this result cannot recall it. */
        if (current.delivery || current.stage === "answered") return next({});
        return next({ delegation: { ...current, stage: result.status, refusal: result.status === "refused" ? result.code : current.refusal } });
      }
      /* A delivery exists only for the proposal the operator confirmed, to
         the recipient frozen in it, and a queued or delivered one names its operation. */
      const { delivery } = result;
      const proposal = current.proposal;
      const recovering = current.stage === "unknown" && result.status !== "unknown" && settles(current.delivery, delivery);
      if ((current.stage !== "sending" && !recovering) || !proposal || delivery.proposalId !== proposal.proposalId || delivery.callId !== proposal.callId
        || event.callId !== proposal.callId || !sameRecipient(delivery.recipient, proposal.recipient) || !validId(delivery.clientMessageId)
        || (result.status !== "unknown" && !validId(delivery.operationId))) return next({});
      return next({ delegation: { ...current, stage: result.status, delivery } });
    }
    case "delegation.delivery.settled": {
      const current = base.delegation;
      if (!current || current.stage === "answered" || !settles(current.delivery, event.delivery)) return next({});
      return next({ delegation: { ...current, stage: event.status, delivery: event.delivery } });
    }
    case "orchestrator.answer": {
      const current = base.delegation;
      /* Correlation is the whole delivery identity; a fresh report elsewhere
         in the conversation is not an answer to this request. */
      if (!current || !answers(current.delivery, event.delivery) || !validId(event.reportId) || base.reports.has(event.reportId)) return next({});
      return next({
        reports: new Set(base.reports).add(event.reportId),
        delegation: { ...current, stage: "answered", answer: { reportId: event.reportId, status: event.status, text: bounded(event.text) } },
      });
    }
    case "error":
      return next({ error: event.code, ...(event.recoverable ? {} : { phase: "offline", playing: null, mouth: 0 }) });
  }
}
