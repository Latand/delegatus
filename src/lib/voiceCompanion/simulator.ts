import type { CompanionCommand, CompanionEvent, Delivery, Id, Payload, Proposal, Recipient, VoiceCompanionAdapter } from "./contract";

/**
 * The simulated voice companion (#2519, design note §6): a scripted
 * conversation emitted through the same adapter interface and the same
 * normalized events a real backend adapter produces. It touches no provider
 * endpoint, no microphone, no key, no state directory and no orchestrator:
 * the one effect a delegation has is a call to the `dispatch` seam it was
 * given, and that call happens only after a `confirmation` command says send.
 *
 * Time comes from a clock, so the same script runs on virtual time in a unit
 * test and on `requestAnimationFrame` in a browser capture.
 */

export interface SimClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Resolves on the next animation frame (or its virtual equivalent). */
  frame(): Promise<void>;
}

export function realClock(): SimClock {
  return {
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    frame: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  };
}

/** A clock whose waits return at once and move its own time forward. */
export function virtualClock(frameMs = 1000 / 60): SimClock {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms) => { at += ms; },
    frame: async () => { at += frameMs; },
  };
}

export type ScriptStep =
  | { kind: "pause"; ms: number }
  | { kind: "operator"; itemId: Id; text: string }
  | { kind: "companion"; itemId: Id; responseId: Id; text: string }
  /** The model proposes a delegation; the application asks for confirmation. */
  | { kind: "propose"; callId: Id; proposalId: Id; sourceItemId: Id; instruction: string }
  /** Waits for the `confirmation` command. Send continues the script; cancel
      plays `cancelled` and ends it. */
  | { kind: "confirm"; clientMessageId: Id; operationId: Id; settleAfterMs: number; cancelled: ScriptStep[] }
  | { kind: "answer"; reportId: Id; status: "progress" | "result" | "question" | "blocked"; text: string; afterMs: number };

export interface SimulatorOptions {
  script: readonly ScriptStep[];
  recipient: Recipient;
  clock?: SimClock;
  /** The simulated send seam. Called once per confirmed proposal, never else. */
  dispatch?: (delivery: Delivery, instruction: string) => void;
  sessionId?: Id;
}

export interface SimulatedCompanion extends VoiceCompanionAdapter {
  readonly mode: "simulated";
  /** Resolves when the script has played out or the session closed. */
  readonly finished: Promise<void>;
}

/* Speech pacing of the synthetic voice: one character per this many ms. */
const MS_PER_CHAR = 58;
const OPERATOR_MS_PER_CHAR = 46;
const VOWELS = new Set("aeiouyаеєиіїоуюяы");

/** The played-audio level of the synthetic voice at `playedMs` into `text`:
    open on vowels, nearly closed on consonants, shut on pauses. It exercises
    the mouth's animation and its synchronization with the captions; it proves
    nothing about phonetic accuracy. */
export function syntheticLevel(text: string, playedMs: number): number {
  const char = text[Math.floor(playedMs / MS_PER_CHAR)]?.toLowerCase();
  if (!char) return 0;
  const open = VOWELS.has(char) ? 0.78 : /\p{L}|\p{N}/u.test(char) ? 0.3 : 0.03;
  return Math.min(1, Math.max(0, open * (0.86 + 0.14 * Math.sin(playedMs / 37))));
}

/** Word boundaries of `text`, each chunk carrying its trailing space. */
const words = (text: string): string[] => text.match(/\S+\s*/g) ?? [];

export function createSimulatedCompanion(options: SimulatorOptions): SimulatedCompanion {
  const clock = options.clock ?? realClock();
  const sessionId = options.sessionId ?? "companion-sim-1";
  const listeners = new Set<(event: CompanionEvent) => void>();
  type Confirmation = Extract<CompanionCommand, { type: "confirmation" }>;
  /* One generation per start. A conversation that was ended can be started
     again: the script plays from its beginning under the next generation, and
     anything the earlier one still had in flight stops at its next step. */
  let generation = 0;
  let live = false;
  let seq = 0;
  let startedAt = 0;
  let muted = false;
  let interrupted: Id | null = null;
  let playing: Id | null = null;
  let pendingProposal: Proposal | null = null;
  let decide: ((command: Confirmation | null) => void) | null = null;
  let decided: Confirmation | null = null;
  let finish: () => void = () => undefined;
  let finished = new Promise<void>((resolve) => { finish = resolve; });
  const gone = (mine: number) => !live || generation !== mine;

  const emit = (payload: Payload) => {
    const event = { ...payload, version: 1 as const, sessionId, generation, eventId: `${sessionId}:${generation}:${seq}`, seq, atMs: Math.max(0, clock.now() - startedAt) } as CompanionEvent;
    seq += 1;
    for (const listener of [...listeners]) listener(event);
  };

  async function speakOperator(step: Extract<ScriptStep, { kind: "operator" }>, mine: number) {
    emit({ type: "input.speech.started", itemId: step.itemId });
    for (const word of words(step.text)) {
      await clock.sleep(word.length * OPERATOR_MS_PER_CHAR);
      if (gone(mine)) return;
      emit({ type: "transcript.delta", speaker: "operator", itemId: step.itemId, delta: word });
    }
    await clock.sleep(180);
    if (gone(mine)) return;
    emit({ type: "input.speech.stopped", itemId: step.itemId });
    emit({ type: "transcript.final", speaker: "operator", itemId: step.itemId, text: step.text });
  }

  async function speakCompanion(step: Extract<ScriptStep, { kind: "companion" }>, mine: number) {
    const { itemId, responseId, text } = step;
    emit({ type: "response.started", responseId, itemId });
    await clock.sleep(280);
    if (gone(mine)) return;
    emit({ type: "playback.started", responseId, itemId });
    playing = responseId;
    const chunks = words(text);
    const totalMs = text.length * MS_PER_CHAR;
    const playbackStart = clock.now();
    let spoken = 0;
    let chars = 0;
    let generated = false;
    for (;;) {
      await clock.frame();
      if (gone(mine)) return;
      const playedMs = clock.now() - playbackStart;
      if (interrupted === responseId || muted) {
        if (!generated) emit({ type: "response.generated", responseId, status: "cancelled" });
        emit({ type: "playback.stopped", responseId, itemId, playedMs, reason: muted ? "muted" : "interrupted" });
        interrupted = null;
        playing = null;
        return;
      }
      /* A word is captioned when the voice reaches it. */
      while (spoken < chunks.length && chars <= playedMs / MS_PER_CHAR) {
        emit({ type: "transcript.delta", speaker: "companion", itemId, responseId, delta: chunks[spoken]! });
        chars += chunks[spoken]!.length;
        spoken += 1;
      }
      /* Generation runs ahead of playback, as a real response does. */
      if (!generated && playedMs >= totalMs * 0.6) {
        generated = true;
        emit({ type: "response.generated", responseId, status: "completed" });
      }
      if (playedMs >= totalMs) break;
      emit({ type: "playback.level", responseId, itemId, rms: syntheticLevel(text, playedMs), playedMs });
    }
    playing = null;
    emit({ type: "playback.stopped", responseId, itemId, playedMs: totalMs, reason: "ended" });
    emit({ type: "transcript.final", speaker: "companion", itemId, responseId, text });
  }

  async function play(steps: readonly ScriptStep[], mine: number): Promise<void> {
    let delivery: Delivery | null = null;
    for (const step of steps) {
      if (gone(mine)) return;
      if (step.kind === "pause") await clock.sleep(step.ms);
      else if (step.kind === "operator") await speakOperator(step, mine);
      else if (step.kind === "companion") await speakCompanion(step, mine);
      else if (step.kind === "propose") {
        emit({ type: "delegation.tool.called", callId: step.callId, sourceItemId: step.sourceItemId, instruction: step.instruction });
        pendingProposal = { proposalId: step.proposalId, callId: step.callId, sourceItemId: step.sourceItemId, instruction: step.instruction, recipient: options.recipient };
        decided = null;
        emit({ type: "delegation.confirmation.required", proposal: pendingProposal });
      } else if (step.kind === "confirm") {
        const proposal = pendingProposal;
        if (!proposal) continue;
        const command = decided ?? await new Promise<Confirmation | null>((resolve) => { decide = resolve; });
        decide = null;
        if (gone(mine) || !command) return;
        pendingProposal = null;
        if (command.decision === "cancel") {
          emit({ type: "delegation.tool.result", callId: proposal.callId, proposalId: proposal.proposalId, result: { status: "cancelled", code: "operator_cancelled" } });
          await play(step.cancelled, mine);
          return;
        }
        emit({ type: "delegation.confirmed", proposalId: proposal.proposalId, via: command.via, ...(command.confirmationItemId ? { confirmationItemId: command.confirmationItemId } : {}) });
        delivery = { proposalId: proposal.proposalId, callId: proposal.callId, clientMessageId: step.clientMessageId, operationId: step.operationId, recipient: proposal.recipient };
        await clock.sleep(900);
        if (gone(mine)) return;
        /* The single send, after the confirmation and nowhere else. */
        options.dispatch?.(delivery, proposal.instruction);
        emit({ type: "delegation.tool.result", callId: proposal.callId, proposalId: proposal.proposalId, result: { status: "queued", delivery } });
        await clock.sleep(step.settleAfterMs);
        if (gone(mine)) return;
        emit({ type: "delegation.delivery.settled", delivery, status: "delivered" });
      } else if (step.kind === "answer") {
        if (!delivery) continue;
        await clock.sleep(step.afterMs);
        if (gone(mine)) return;
        emit({ type: "orchestrator.answer", delivery, reportId: step.reportId, status: step.status, text: step.text });
      }
    }
  }

  return {
    mode: "simulated",
    get finished() { return finished; },
    async start() {
      if (live) return;
      if (generation > 0) finished = new Promise<void>((resolve) => { finish = resolve; });
      generation += 1;
      live = true;
      seq = 0;
      muted = false;
      interrupted = playing = pendingProposal = decided = null;
      startedAt = clock.now();
      const mine = generation;
      const done = finish;
      emit({ type: "session.ready", mode: "simulated" });
      void play(options.script, mine).then(done, done);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async command(command) {
      if (!live) return;
      if (command.type === "mute") { muted = command.muted; return; }
      if (command.type === "interrupt") { interrupted = command.responseId; return; }
      /* Only the proposal on screen can be decided, and only once. */
      if (!pendingProposal || command.proposalId !== pendingProposal.proposalId || decided) return;
      decided = command;
      /* A tap on the proposal cuts the read-back short: the operator has answered it. */
      if (playing) interrupted = playing;
      decide?.(command);
    },
    async close() {
      if (!live) return;
      emit({ type: "session.closed", reason: "operator" });
      live = false;
      /* A proposal nobody answered dies with the session: nothing is sent. */
      pendingProposal = null;
      decide?.(null);
      finish();
    },
  };
}
