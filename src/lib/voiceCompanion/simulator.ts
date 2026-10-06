import type { CompanionCommand, CompanionEvent, Delivery, Id, Payload, Proposal, Recipient, VoiceCompanionAdapter } from "./contract";
import { admitDelegationProposal, type OperatorInput } from "./gate";

/**
 * The simulated voice companion (#2519, design note §6): a scripted
 * conversation emitted through the same adapter interface and the same
 * normalized events a real backend adapter produces. It touches no provider
 * endpoint, no microphone, no key, no state directory and no orchestrator:
 * the one effect a delegation has is a call to the `dispatch` seam it was
 * given, and that call happens only after the explicit-request gate admitted
 * the proposal and a `confirmation` command said send.
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

export interface ScriptedCall { callId: Id; name: string; summary: string; durationMs: number; outcome: "done" | "failed"; result: string }

export type ScriptStep =
  | { kind: "pause"; ms: number }
  | { kind: "operator"; itemId: Id; text: string }
  /** The companion answers. `bargeIn` has the operator start speaking once
      that much audio has played, which cuts the playback. */
  | { kind: "companion"; itemId: Id; responseId: Id; text: string; bargeIn?: { afterMs: number; itemId: Id; text: string } }
  /** Read-only tool calls, started together and finished each on its own time. */
  | { kind: "tools"; calls: readonly ScriptedCall[] }
  /** The model proposes a delegation; the application gate decides whether
      the operator is asked to confirm it. */
  | { kind: "propose"; callId: Id; proposalId: Id; sourceItemId: Id; instruction: string }
  /** Waits for the `confirmation` command. Send continues the script; cancel
      plays `cancelled` and ends it. A refused proposal skips this step. */
  | { kind: "confirm"; clientMessageId: Id; operationId: Id; settleAfterMs: number; cancelled: ScriptStep[];
      /** The send's outcome stays unknown: no receipt names its operation, nothing settles and no answer can join it. */
      unconfirmed?: boolean }
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

/* Pacing of the synthetic voice. Playback: one character per this many ms.
   Generation runs several times faster and starts first, as a real response
   does, so the transcript is complete long before the audio ends. */
export const MS_PER_CHAR = 58;
const GENERATION_MS_PER_CHAR = 14;
const FIRST_AUDIO_MS = 260;
const OPERATOR_MS_PER_CHAR = 46;
const VOWELS = new Set("aeiouyаеєиіїоуюяы");

/** The played-audio level of the synthetic voice at `playedMs` into `text`:
    open on vowels, nearly closed on consonants, shut on pauses. It exercises
    the mouth's animation; it proves nothing about phonetic accuracy. */
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
  /* The source input as it read when the pending proposal froze. */
  let pendingSource = "";
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

  /* What the gate reads: the operator's inputs of this generation, as heard. */
  let inputs: OperatorInput[] = [];
  const standing = (proposal: Proposal) =>
    admitDelegationProposal({ sourceItemId: proposal.sourceItemId, instruction: proposal.instruction, inputs, frozenSourceText: pendingSource });
  const heard = (itemId: Id, change: Partial<OperatorInput>) => {
    const index = inputs.findIndex((input) => input.itemId === itemId);
    if (index === -1) inputs.push({ itemId, text: "", final: false, ...change });
    else inputs[index] = { ...inputs[index]!, ...change };
    /* Anything the operator says after the preview, finished or not, withdraws
       it: the proposal leaves and an earlier or later Send finds nothing. */
    const proposal = pendingProposal;
    if (!proposal) return;
    const verdict = standing(proposal);
    if (verdict.admit) return;
    pendingProposal = null;
    decided = null;
    emit({ type: "delegation.tool.result", callId: proposal.callId, proposalId: proposal.proposalId, result: { status: "cancelled", code: verdict.reason } });
  };

  async function speakOperator(itemId: Id, text: string, mine: number, started = false) {
    if (!started) emit({ type: "input.speech.started", itemId });
    heard(itemId, {});
    let sofar = "";
    for (const word of words(text)) {
      await clock.sleep(word.length * OPERATOR_MS_PER_CHAR);
      if (gone(mine)) return;
      sofar += word;
      heard(itemId, { text: sofar });
      emit({ type: "transcript.delta", speaker: "operator", itemId, delta: word });
    }
    await clock.sleep(180);
    if (gone(mine)) return;
    emit({ type: "input.speech.stopped", itemId });
    heard(itemId, { text, final: true });
    emit({ type: "transcript.final", speaker: "operator", itemId, text });
  }

  /**
   * One response. Generation and playback run side by side on one frame loop:
   * the transcript streams at generation speed and is final (then the response
   * is generated) while the audio still plays, as the provider's lifecycle
   * orders them. Playback alone decides the mouth, and a cut playback leaves
   * the generated transcript as it was.
   */
  async function speakCompanion(step: Extract<ScriptStep, { kind: "companion" }>, mine: number) {
    const { itemId, responseId, text, bargeIn } = step;
    emit({ type: "response.started", responseId, itemId });
    const chunks = words(text);
    const audioMs = text.length * MS_PER_CHAR;
    const startedAt = clock.now();
    let streamed = 0;
    let streamedChars = 0;
    let generated = false;
    let playbackAt: number | null = null;
    for (;;) {
      await clock.frame();
      if (gone(mine)) return;
      const elapsed = clock.now() - startedAt;
      while (!generated && streamed < chunks.length && streamedChars <= elapsed / GENERATION_MS_PER_CHAR) {
        emit({ type: "transcript.delta", speaker: "companion", itemId, responseId, delta: chunks[streamed]! });
        streamedChars += chunks[streamed]!.length;
        streamed += 1;
      }
      if (!generated && streamed === chunks.length) {
        generated = true;
        emit({ type: "transcript.final", speaker: "companion", itemId, responseId, text });
        emit({ type: "response.generated", responseId, status: "completed" });
      }
      if (playbackAt === null) {
        if (elapsed < FIRST_AUDIO_MS) continue;
        playbackAt = clock.now();
        playing = responseId;
        emit({ type: "playback.started", responseId, itemId });
      }
      const playedMs = clock.now() - playbackAt;
      const bargedIn = !!bargeIn && playedMs >= bargeIn.afterMs;
      if (bargedIn) {
        emit({ type: "input.speech.started", itemId: bargeIn.itemId });
        /* Heard at once: speech that has only started already withdraws a waiting proposal. */
        heard(bargeIn.itemId, {});
      }
      if (bargedIn || interrupted === responseId || muted) {
        /* The player stops; what was generated stays generated. */
        if (!generated) emit({ type: "response.generated", responseId, status: "cancelled" });
        emit({ type: "playback.stopped", responseId, itemId, playedMs, reason: muted && !bargedIn ? "muted" : "interrupted" });
        interrupted = null;
        playing = null;
        if (bargedIn) await speakOperator(bargeIn.itemId, bargeIn.text, mine, true);
        return;
      }
      if (playedMs >= audioMs) break;
      emit({ type: "playback.level", responseId, itemId, rms: syntheticLevel(text, playedMs), playedMs });
    }
    playing = null;
    emit({ type: "playback.stopped", responseId, itemId, playedMs: audioMs, reason: "ended" });
  }

  async function runTools(step: Extract<ScriptStep, { kind: "tools" }>, mine: number) {
    const startedAt = clock.now();
    const open = new Map<Id, ScriptedCall>();
    for (const call of step.calls) {
      emit({ type: "tool.called", callId: call.callId, name: call.name, summary: call.summary });
      open.set(call.callId, call);
      await clock.sleep(90);
      if (gone(mine)) return;
    }
    while (open.size) {
      await clock.frame();
      if (gone(mine)) return;
      for (const call of [...open.values()]) {
        if (clock.now() - startedAt < call.durationMs) continue;
        open.delete(call.callId);
        emit({ type: "tool.result", callId: call.callId, status: call.outcome, summary: call.result });
      }
    }
  }

  async function play(steps: readonly ScriptStep[], mine: number): Promise<void> {
    let delivery: Delivery | null = null;
    for (const step of steps) {
      if (gone(mine)) return;
      if (step.kind === "pause") await clock.sleep(step.ms);
      else if (step.kind === "operator") await speakOperator(step.itemId, step.text, mine);
      else if (step.kind === "companion") await speakCompanion(step, mine);
      else if (step.kind === "tools") await runTools(step, mine);
      else if (step.kind === "propose") {
        emit({ type: "delegation.tool.called", callId: step.callId, sourceItemId: step.sourceItemId, instruction: step.instruction });
        decided = null;
        /* The gate, before anything is shown: only an explicit request becomes a proposal. */
        const verdict = admitDelegationProposal({ sourceItemId: step.sourceItemId, instruction: step.instruction, inputs });
        if (!verdict.admit) {
          pendingProposal = null;
          emit({ type: "delegation.tool.result", callId: step.callId, result: { status: "refused", code: verdict.reason } });
          continue;
        }
        pendingProposal = { proposalId: step.proposalId, callId: step.callId, sourceItemId: step.sourceItemId, instruction: step.instruction, recipient: options.recipient };
        pendingSource = inputs.find((input) => input.itemId === step.sourceItemId)?.text ?? "";
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
        emit({ type: "delegation.confirmed", proposalId: proposal.proposalId, via: "tap" });
        await clock.sleep(900);
        if (gone(mine)) return;
        /* Admission, read again at the send: the frozen proposal must still be what the operator last asked for. */
        const admission = standing(proposal);
        if (!admission.admit) {
          emit({ type: "delegation.tool.result", callId: proposal.callId, proposalId: proposal.proposalId, result: { status: "cancelled", code: admission.reason } });
          continue;
        }
        delivery = { proposalId: proposal.proposalId, callId: proposal.callId, clientMessageId: step.clientMessageId, operationId: step.unconfirmed ? null : step.operationId, recipient: proposal.recipient };
        /* The single send, after the confirmation and nowhere else. */
        options.dispatch?.(delivery, proposal.instruction);
        if (step.unconfirmed) {
          emit({ type: "delegation.tool.result", callId: proposal.callId, proposalId: proposal.proposalId, result: { status: "unknown", delivery } });
          delivery = null;
          continue;
        }
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
      inputs = [];
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
      /* A tap is the only confirmation there is. A spoken one has to be a
         later completed input admitted as consent to the proposal on screen
         (note §5, step 2), and nothing here admits one: a speech command is
         dropped whatever item it names, so it neither sends nor cancels. */
      if (command.via !== "tap") return;
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
