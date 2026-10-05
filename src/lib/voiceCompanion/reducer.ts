import type { CompanionEvent, CompanionMode, Delivery, Id, Proposal } from "./contract";

/**
 * The one reducer the voice companion's window reads (#2519, design note §6).
 * It joins the normalized events into what the window draws: the character's
 * phase, the mouth level, the caption lines and the delegation's stage.
 *
 * Runtime rules it enforces, whatever adapter produced the stream:
 *  - a duplicate `eventId` and an event of a retired generation change nothing;
 *  - transcripts are keyed by speaker and item, and a final replaces the
 *    provisional text;
 *  - the mouth stays active until playback stops, whenever generation ended;
 *  - input speech interrupts playback and leaves delivered work alone;
 *  - a tool result, a settlement and an answer count only when they join the
 *    proposal the operator confirmed.
 */

export type CompanionPhase = "offline" | "idle" | "listening" | "thinking" | "speaking";

export type CaptionSpeaker = "operator" | "companion" | "orchestrator";

export interface CaptionLine {
  /** `speaker:itemId`, stable while the text streams. */
  key: string;
  speaker: CaptionSpeaker;
  text: string;
  final: boolean;
  /** Playback was cut before the line ended; the text is what was said. */
  interrupted: boolean;
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
  delivery: Delivery | null;
  answer: { reportId: Id; status: "progress" | "result" | "question" | "blocked"; text: string } | null;
}

export interface CompanionState {
  mode: CompanionMode | null;
  generation: number;
  phase: CompanionPhase;
  /** Played-audio level in [0, 1]; changes every frame while speaking. */
  mouth: number;
  /** Bumps on every change other than the mouth level, so a view can skip
      rendering for a level sample. */
  revision: number;
  lines: readonly CaptionLine[];
  delegation: DelegationView | null;
  /** The response whose audio is playing, for an interrupt. */
  playing: { responseId: Id; itemId: Id } | null;
  error: string | null;
  seen: ReadonlySet<Id>;
  levelSeq: number;
  reports: ReadonlySet<Id>;
}

/** Lines kept for the static transcript; the window shows the last few. */
export const CAPTION_HISTORY = 24;
const TEXT_LIMIT = 4_000;
const ID_LIMIT = 200;

export const INITIAL_COMPANION_STATE: CompanionState = {
  mode: null, generation: 0, phase: "offline", mouth: 0, revision: 0, lines: [], delegation: null,
  playing: null, error: null, seen: new Set(), levelSeq: -1, reports: new Set(),
};

const validId = (value: unknown): value is Id => typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT;
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const bounded = (text: string) => (text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text);

function wellFormed(event: CompanionEvent): boolean {
  return event.version === 1 && validId(event.sessionId) && validId(event.eventId)
    && Number.isInteger(event.generation) && event.generation >= 0
    && Number.isInteger(event.seq) && event.seq >= 0
    && Number.isFinite(event.atMs) && event.atMs >= 0;
}

function upsertLine(lines: readonly CaptionLine[], speaker: CaptionSpeaker, itemId: Id, change: (line: CaptionLine | null) => CaptionLine): readonly CaptionLine[] {
  const key = `${speaker}:${itemId}`;
  const index = lines.findIndex((line) => line.key === key);
  if (index === -1) return [...lines, change(null)].slice(-CAPTION_HISTORY);
  const next = [...lines];
  next[index] = change(lines[index]!);
  return next;
}

const sameDelivery = (left: Delivery | null, right: Delivery) =>
  !!left && left.clientMessageId === right.clientMessageId && left.proposalId === right.proposalId && left.callId === right.callId;

export function reduceCompanion(state: CompanionState, event: CompanionEvent): CompanionState {
  if (!wellFormed(event)) return state;
  if (event.generation < state.generation) return state;
  let base = state;
  if (event.generation > state.generation) {
    /* A reconnect retires proposal authority and every provisional line;
       delivered work stays visible and can still be answered. */
    const delegation = state.delegation && ["sending", "queued", "delivered", "unknown", "answered"].includes(state.delegation.stage) ? state.delegation : null;
    base = { ...state, generation: event.generation, seen: new Set(), levelSeq: -1, playing: null, mouth: 0, delegation,
      lines: state.lines.filter((line) => line.final), phase: state.phase === "offline" ? "offline" : "idle" };
  }
  if (event.type === "playback.level") {
    if (event.seq <= base.levelSeq || base.playing?.responseId !== event.responseId) return base;
    return { ...base, mouth: clamp01(event.rms), levelSeq: event.seq };
  }
  if (base.seen.has(event.eventId)) return base;
  const next = (change: Partial<CompanionState>): CompanionState =>
    ({ ...base, ...change, seen: new Set(base.seen).add(event.eventId), revision: base.revision + 1 });

  switch (event.type) {
    case "session.ready":
      return next({ mode: event.mode, phase: "idle", error: null });
    case "session.closed":
      return next({ phase: "offline", playing: null, mouth: 0, error: event.reason === "operator" ? null : event.reason });
    case "input.speech.started": {
      /* Barge-in: the mouth stops at once; the line that was playing stays,
         marked partial. Delivered work is untouched. */
      const lines = base.playing
        ? upsertLine(base.lines, "companion", base.playing.itemId, (line) => ({ key: `companion:${base.playing!.itemId}`, speaker: "companion", text: line?.text ?? "", final: true, interrupted: true }))
        : base.lines;
      return next({ phase: "listening", playing: null, mouth: 0, lines });
    }
    case "input.speech.stopped":
      return next({ phase: base.phase === "listening" ? "thinking" : base.phase });
    case "transcript.delta": {
      if (!validId(event.itemId)) return base;
      const key = `${event.speaker}:${event.itemId}`;
      const existing = base.lines.find((line) => line.key === key);
      if (existing?.final) return next({});
      return next({ lines: upsertLine(base.lines, event.speaker, event.itemId, (line) => ({ key, speaker: event.speaker, text: bounded((line?.text ?? "") + event.delta), final: false, interrupted: false })) });
    }
    case "transcript.final": {
      if (!validId(event.itemId)) return base;
      const key = `${event.speaker}:${event.itemId}`;
      const existing = base.lines.find((line) => line.key === key);
      /* A line cut by the operator keeps the words that were played. */
      if (existing?.interrupted) return next({});
      return next({ lines: upsertLine(base.lines, event.speaker, event.itemId, () => ({ key, speaker: event.speaker, text: bounded(event.text), final: true, interrupted: false })) });
    }
    case "response.started":
      return next({ phase: base.phase === "listening" ? "listening" : "thinking" });
    case "response.generated":
      /* Generation ending says nothing about playback: the mouth follows the
         audio that is still being played. */
      return next(event.status === "failed" && !base.playing ? { phase: "idle" } : {});
    case "playback.started":
      return next({ phase: "speaking", playing: { responseId: event.responseId, itemId: event.itemId } });
    case "playback.stopped": {
      if (base.playing?.responseId !== event.responseId) return next({});
      const lines = event.reason === "ended" ? base.lines
        : upsertLine(base.lines, "companion", event.itemId, (line) => ({ key: `companion:${event.itemId}`, speaker: "companion", text: line?.text ?? "", final: true, interrupted: true }));
      return next({ phase: "idle", playing: null, mouth: 0, lines });
    }
    case "delegation.tool.called": {
      if (!validId(event.callId)) return base;
      /* A tool call is a candidate and nothing more: it opens no delivery. */
      return next({ delegation: { callId: event.callId, instruction: bounded(event.instruction), stage: "proposed", proposal: null, delivery: null, answer: null } });
    }
    case "delegation.confirmation.required": {
      const { proposal } = event;
      if (base.delegation?.callId !== proposal.callId || base.delegation.stage !== "proposed") return next({});
      return next({ delegation: { ...base.delegation, stage: "awaiting-confirmation", proposal, instruction: bounded(proposal.instruction) } });
    }
    case "delegation.confirmed": {
      const current = base.delegation;
      if (!current?.proposal || current.proposal.proposalId !== event.proposalId || current.stage !== "awaiting-confirmation") return next({});
      return next({ delegation: { ...current, stage: "sending" } });
    }
    case "delegation.tool.result": {
      const current = base.delegation;
      if (!current || current.callId !== event.callId) return next({});
      const { result } = event;
      if (!("delivery" in result)) {
        /* Cancel before admission has zero sends; after admission the work
           is already out and this result cannot recall it. */
        if (current.delivery) return next({});
        return next({ delegation: { ...current, stage: result.status } });
      }
      /* A delivery exists only for the proposal the operator confirmed. */
      if (current.stage !== "sending" || current.proposal?.proposalId !== result.delivery.proposalId) return next({});
      return next({ delegation: { ...current, stage: result.status, delivery: result.delivery } });
    }
    case "delegation.delivery.settled": {
      const current = base.delegation;
      if (!current || !sameDelivery(current.delivery, event.delivery) || current.stage === "answered") return next({});
      return next({ delegation: { ...current, stage: event.status, delivery: event.delivery } });
    }
    case "orchestrator.answer": {
      const current = base.delegation;
      /* Correlation is the delivery identity; a fresh report elsewhere in the
         conversation is not an answer to this request. */
      if (!current || !sameDelivery(current.delivery, event.delivery) || !validId(event.reportId) || base.reports.has(event.reportId)) return next({});
      const text = bounded(event.text);
      return next({
        reports: new Set(base.reports).add(event.reportId),
        delegation: { ...current, stage: "answered", answer: { reportId: event.reportId, status: event.status, text } },
        lines: upsertLine(base.lines, "orchestrator", event.reportId, () => ({ key: `orchestrator:${event.reportId}`, speaker: "orchestrator", text, final: true, interrupted: false })),
      });
    }
    case "error":
      return next({ error: event.code, ...(event.recoverable ? {} : { phase: "offline", playing: null, mouth: 0 }) });
  }
}
