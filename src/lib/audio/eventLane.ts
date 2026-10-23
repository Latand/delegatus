import type { CueCaption } from "./captions";
import { eventRank } from "./cues";
import { SOUNDS, type EventSoundId } from "./synth";

/**
 * The timing rules of docs/design/sound-redesign.md §6.1–§6.2, live.
 *
 *   request ─ obligation memory ─ class gate (window, gap, cap)
 *           ─ a landing supersedes its lane's last step
 *           ─ one event lane (priority, cut, queue) ─ transport
 *
 * Everything runs on an injected clock and timer, so the rules are tested on
 * a fake one; the prototype's planner (docs/prototypes/sounds/lane.js) is the
 * offline twin of this module and the two answer the same cases.
 */

export interface LaneTimers {
  /** Milliseconds, the clock every window and gap is measured on. */
  now(): number;
  schedule(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** A sound sounding on the lane, as the transport hands it back. */
export interface LaneVoice {
  /** Fade out at once (40 ms): a higher sound takes the lane. */
  cut(): void;
}

export interface EventLaneOptions {
  timers: LaneTimers;
  /**
   * Start one sound now for `batch` coalesced events; null when it cannot play.
   * `captions` are the joined requests' own, in arrival order (empty when none
   * carried one); null for a cut sound's replay, which already showed its toast.
   */
  start(sound: EventSoundId, batch: number, captions: CueCaption[] | null): LaneVoice | null;
  /** How long a sound holds the lane, ms. */
  lengthMs?: (sound: EventSoundId) => number;
}

/** §6.1: coalescing window, minimum gap after a play, plays per minute (ms). */
export const LANE_RULES: Record<EventSoundId, { window?: number; gap?: number; perMinute?: number }> = {
  "your-move": { window: 3000, gap: 5000, perMinute: 6 },
  fault: { window: 3000, gap: 10_000, perMinute: 3 },
  reply: { window: 1500 },
  released: {},
  landed: { window: 5000, gap: 8000 },
  step: { window: 2000, gap: 6000, perMinute: 6 },
  launched: { gap: 1000 },
};
/** A decision already heard stays silent this long, whichever record it comes back as. */
export const OBLIGATION_MEMORY_MS = 10 * 60_000;
/** A lane landing makes its last step's sound redundant. */
export const STEP_SUPERSEDED_WITHIN_MS = 10_000;
/**
 * Only the two sounds that need the operator cut what is playing. A result
 * waits its turn by priority: S5 arriving mid-S4 plays after it (§6.2's own
 * example), which a general «higher cuts lower» rule would break.
 */
const CUTS = new Set<EventSoundId>(["your-move", "fault"]);
/** Frequent or self-caused: a few seconds late they say nothing. */
const DROPPED_WHEN_BUSY = new Set<EventSoundId>(["step", "launched"]);
/** The lane's queue forgets a play older than this. */
export const QUEUE_BOUND_MS = 15_000;
/** Breath between one sound's end and the next queued one. */
export const QUEUE_PAUSE_MS = 150;
/** Remembered obligations, bounded for a tab left open for a week. */
const OBLIGATION_CAPACITY = 512;

export interface LaneRequest {
  sound: EventSoundId;
  obligation?: string;
  pipeline?: string;
  /** What the sound announces, for its caption; it never changes how the sound plays. */
  caption?: CueCaption;
}

export type LaneOutcome = "accepted" | "obligation-heard";

export interface EventLane {
  request(request: LaneRequest): LaneOutcome;
  /** Mute, the master switch or a call connecting: forget every queued play. */
  clear(): void;
  /** The sound holding the lane, if any (tests, diagnostics). */
  playing(): EventSoundId | null;
  /** Stop every timer (page teardown). */
  reset(): void;
}

/** One element per joined request, so every place that changes `n` changes this the same way. */
interface Joined { pipeline: string | null; caption: CueCaption | null }
interface Batch { n: number; pipelines: string[]; captions: Joined[] }
interface ClassState {
  open: Batch | null;
  waiting: Batch | null;
  lastPlay: number;
  minute: number[];
}
interface Queued { sound: EventSoundId; n: number; since: number; replay: boolean; captions: CueCaption[] | null }

export function createEventLane(options: EventLaneOptions): EventLane {
  const { timers } = options;
  const lengthMs = options.lengthMs ?? ((sound: EventSoundId) => SOUNDS[sound].length * 1000);
  const classes = new Map<EventSoundId, ClassState>();
  const obligationHeard = new Map<string, number>();
  /** pipeline → when its landing left the gate. */
  const landings = new Map<string, number>();
  const pending = new Set<unknown>();

  const later = (ms: number, run: () => void): void => {
    const handle = timers.schedule(() => {
      pending.delete(handle);
      run();
    }, Math.max(0, ms));
    pending.add(handle);
  };
  const stateOf = (sound: EventSoundId): ClassState => {
    let state = classes.get(sound);
    if (!state) {
      state = { open: null, waiting: null, lastPlay: -Infinity, minute: [] };
      classes.set(sound, state);
    }
    return state;
  };

  // ── Stage 1: each class's gate ───────────────────────────────────────

  /**
   * Coalescing is trailing: a burst opens a window and one play leaves when
   * it closes, carrying the burst's size. After a play the class is quiet for
   * its gap; everything inside the gap becomes at most one more play at the
   * gap's end. A class at its per-minute cap waits for the minute to free up,
   * except S3, which drops.
   */
  function release(sound: EventSoundId, slot: "open" | "waiting"): void {
    const rule = LANE_RULES[sound];
    const state = stateOf(sound);
    const batch = state[slot];
    state[slot] = null;
    if (!batch || batch.n <= 0) return;
    const now = timers.now();

    if (sound === "step" && batch.pipelines.length) {
      const kept = batch.pipelines.filter((pipeline) => !landedRecently(pipeline, now));
      batch.n -= batch.pipelines.length - kept.length;
      batch.pipelines = kept;
      batch.captions = batch.captions.filter((joined) => joined.pipeline === null || kept.includes(joined.pipeline));
      if (batch.n <= 0) return;
    }

    if (rule.perMinute) {
      state.minute = state.minute.filter((played) => played > now - 60_000);
      if (state.minute.length >= rule.perMinute) {
        if (sound === "step") return;
        if (state.waiting) {
          state.waiting.n += batch.n;
          state.waiting.pipelines.push(...batch.pipelines);
          state.waiting.captions.push(...batch.captions);
        } else {
          state.waiting = batch;
          later(state.minute[0]! + 60_000 - now, () => release(sound, "waiting"));
        }
        return;
      }
      state.minute.push(now);
    }
    state.lastPlay = now;
    if (sound === "landed") for (const pipeline of batch.pipelines) landings.set(pipeline, now);
    arrive({ sound, n: batch.n, since: now, replay: false, captions: captionsOf(batch.captions) });
  }

  /** The captions a released batch carries, in arrival order. */
  function captionsOf(joined: Joined[]): CueCaption[] {
    const captions: CueCaption[] = [];
    for (const entry of joined) if (entry.caption) captions.push(entry.caption);
    return captions;
  }

  /** A landing that left the gate within 10 s, or is waiting in it now. */
  function landedRecently(pipeline: string, now: number): boolean {
    for (const [id, at] of landings) if (now - at > STEP_SUPERSEDED_WITHIN_MS) landings.delete(id);
    if (landings.has(pipeline)) return true;
    const landed = classes.get("landed");
    return Boolean(landed?.open?.pipelines.includes(pipeline) || landed?.waiting?.pipelines.includes(pipeline));
  }

  /** A landing takes its lane's step out of a batch still in the gate. */
  function supersedeStep(pipeline: string): void {
    const step = classes.get("step");
    for (const batch of [step?.open, step?.waiting]) {
      if (!batch) continue;
      const before = batch.pipelines.length;
      batch.pipelines = batch.pipelines.filter((id) => id !== pipeline);
      batch.captions = batch.captions.filter((joined) => joined.pipeline !== pipeline);
      batch.n -= before - batch.pipelines.length;
    }
  }

  // ── Stage 2: the one event lane ──────────────────────────────────────

  let playing: { sound: EventSoundId; n: number; replay: boolean; voice: LaneVoice; end: unknown } | null = null;
  const queue = new Map<EventSoundId, Queued>();
  let resumeTimer: unknown = null;

  function begin(item: Queued): void {
    const voice = options.start(item.sound, item.n, item.captions);
    if (!voice) return;
    const end = timers.schedule(() => {
      pending.delete(end);
      playing = null;
      scheduleResume();
    }, lengthMs(item.sound));
    pending.add(end);
    playing = { sound: item.sound, n: item.n, replay: item.replay, voice, end };
  }

  function enqueue(item: Queued): void {
    const queued = queue.get(item.sound);
    if (queued) {
      queued.n += item.n;
      /* A replay carries null; it only stays null while nothing with a caption joins it. */
      if (item.captions || queued.captions) queued.captions = [...(queued.captions ?? []), ...(item.captions ?? [])];
    } else queue.set(item.sound, { ...item });
  }

  function arrive(item: Queued): void {
    if (!playing && !queue.size) return begin(item);
    if (playing && CUTS.has(item.sound) && eventRank(item.sound) > eventRank(playing.sound)) {
      const cut = playing;
      playing = null;
      cut.voice.cut();
      timers.cancel(cut.end);
      pending.delete(cut.end);
      /* A cut sound replays once in full afterwards; a cut step is gone. */
      if (cut.sound !== "step" && !cut.replay) enqueue({ sound: cut.sound, n: cut.n, since: timers.now(), replay: true, captions: null });
      begin(item);
      if (!playing) scheduleResume();
      return;
    }
    if (playing && DROPPED_WHEN_BUSY.has(item.sound)) return;
    enqueue(item);
    if (!playing) scheduleResume();
  }

  function scheduleResume(): void {
    if (resumeTimer !== null || !queue.size) return;
    const handle = timers.schedule(() => {
      pending.delete(handle);
      resumeTimer = null;
      resume();
    }, QUEUE_PAUSE_MS);
    resumeTimer = handle;
    pending.add(handle);
  }

  function resume(): void {
    if (playing) return;
    const now = timers.now();
    for (const [sound, item] of queue) if (now - item.since > QUEUE_BOUND_MS) queue.delete(sound);
    let next: Queued | null = null;
    for (const item of queue.values()) if (!next || eventRank(item.sound) > eventRank(next.sound)) next = item;
    if (!next) return;
    queue.delete(next.sound);
    begin(next);
    if (!playing) scheduleResume();
  }

  return {
    request({ sound, obligation, pipeline, caption }) {
      const now = timers.now();
      if (obligation) {
        const heard = obligationHeard.get(obligation);
        if (heard !== undefined && now - heard < OBLIGATION_MEMORY_MS) return "obligation-heard";
        obligationHeard.delete(obligation);
        obligationHeard.set(obligation, now);
        for (const [key, at] of obligationHeard) {
          if (obligationHeard.size <= OBLIGATION_CAPACITY && now - at < OBLIGATION_MEMORY_MS) break;
          obligationHeard.delete(key);
        }
      }
      if (sound === "landed" && pipeline) supersedeStep(pipeline);

      const rule = LANE_RULES[sound];
      const state = stateOf(sound);
      const join = (batch: Batch) => {
        batch.n += 1;
        if (pipeline) batch.pipelines.push(pipeline);
        batch.captions.push({ pipeline: pipeline ?? null, caption: caption ?? null });
      };
      const fresh = (): Batch => ({ n: 1, pipelines: pipeline ? [pipeline] : [], captions: [{ pipeline: pipeline ?? null, caption: caption ?? null }] });
      if (state.open) {
        join(state.open);
      } else if (state.waiting) {
        join(state.waiting);
      } else if (now < state.lastPlay + (rule.gap ?? 0)) {
        state.waiting = fresh();
        later(state.lastPlay + rule.gap! - now, () => release(sound, "waiting"));
      } else if (rule.window) {
        state.open = fresh();
        later(rule.window, () => release(sound, "open"));
      } else {
        state.open = fresh();
        release(sound, "open");
      }
      return "accepted";
    },

    clear() {
      queue.clear();
      if (resumeTimer !== null) {
        timers.cancel(resumeTimer);
        pending.delete(resumeTimer);
        resumeTimer = null;
      }
    },

    playing: () => playing?.sound ?? null,

    reset() {
      for (const handle of pending) timers.cancel(handle);
      pending.clear();
      classes.clear();
      obligationHeard.clear();
      landings.clear();
      queue.clear();
      playing = null;
      resumeTimer = null;
    },
  };
}
