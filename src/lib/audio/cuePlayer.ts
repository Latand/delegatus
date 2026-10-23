"use client";

import type { CueCaption } from "./captions";
import { isPriorityCue, isTypingCue, TYPING_GAIN, typingAsset, type AudioCue, type CueRequest } from "./cues";
import { createEventLane, type EventLane, type LaneTimers } from "./eventLane";
import type { EventSoundId } from "./synth";

/**
 * The cue player: one logical event in, at most one sound out
 * (docs/design/sound-redesign.md §6).
 *
 * - **de-duplication** on the caller's stable event identity, not on a time
 *   window. Every source is observed repeatedly by construction — a poll, a
 *   re-parsed transcript, a remounted pane, a reconnect replay — so "same
 *   identity, already considered" is the only rule that holds. An identity is
 *   spent the moment it is considered, whatever the outcome, so a muted event
 *   never sounds later;
 * - **staleness**: an event whose own time is older than its bound (2 minutes,
 *   5 for a deploy) is absorbed silently — a sound that arrives after the
 *   thing has been on screen for minutes is noise;
 * - **two pools**: typing (S1) has three voices of its own and the off-screen
 *   murmur (S2) one, so typing neither blocks nor is displaced by an event
 *   sound; every event sound (S3–S9) goes through the one event lane with its
 *   windows, gaps, caps and priority (`./eventLane`);
 * - **context**: a hidden tab, a phone, a connected voice call, the typing
 *   switch and the tab that owns event sounds each decide what may sound (§8);
 * - **silent degradation** while the autoplay policy holds the graph shut.
 */

/** One playing typing voice, as the transport hands it back. */
export interface CueVoiceHandle {
  stop(): void;
}

/** One playing event sound. */
export interface EventVoiceHandle {
  /** Fade out over 40 ms: a higher sound takes the lane. */
  cut(): void;
}

export interface TypingStartRequest {
  /** Bundled slice path. */
  src: string;
  /** Final playback gain of the near slice: routine gain × device volume. */
  gain: number;
  /** Stereo position, -1…1. */
  pan: number;
  /** Audio-clock offset before the first sample, in seconds. */
  delaySeconds: number;
  /** S2: the slice heard one room away. */
  distant: boolean;
  /** The transport calls this when the sound finishes on its own. */
  onEnded: () => void;
}

export interface EventStartRequest {
  sound: EventSoundId;
  /** Device volume, with any context attenuation multiplied in. */
  volume: number;
  pan: number;
  /** Events coalesced into this play. */
  batch: number;
}

export interface CueTransport {
  /**
   * Start one voice, or answer `null` when this device will not play audio
   * right now — the autoplay policy still holds, there is no audio graph, or
   * the asset has not decoded yet. Never throws.
   */
  startTyping(request: TypingStartRequest): CueVoiceHandle | null;
  startEvent(request: EventStartRequest): EventVoiceHandle | null;
}

export type CueOutcome =
  /** A voice started. */
  | "played"
  /** An event sound entered the lane; its window, gap or queue decides when. */
  | "scheduled"
  /** This exact logical event was already considered. */
  | "deduped"
  /** The event is older than its staleness bound. */
  | "stale"
  /** The overlap cap, the pace, the context or the obligation memory refused it. */
  | "dropped"
  /** Sound is off on this device, or this layer is. */
  | "disabled"
  /** The device would not play audio (autoplay policy, no audio graph). */
  | "blocked";

/** What the tab is doing right now, read per event (§8). */
export interface CueContext {
  /** The document is hidden. */
  hidden: boolean;
  /** A phone-class device. */
  phone: boolean;
  /** A voice call is connected in this tab. */
  voiceCall: boolean;
  /** This tab plays the device's event sounds (the most recently focused one). */
  ownsEvents(): boolean;
}

export interface CuePrefs {
  cuesEnabled: boolean;
  cueVolume: number;
  /** S1 and S2: «Agent typing». */
  typingEnabled: boolean;
}

/** Simultaneous typing voices: a burst still reads as a burst, not a chord. */
export const TYPING_VOICES = 3;
/**
 * Identities remembered for de-duplication. Bounded so a tab left open for a
 * week cannot grow this without limit; eviction is oldest-first.
 */
export const DEDUPE_CAPACITY = 2048;
/** An event older than this is absorbed silently, unless its source says otherwise. */
export const STALE_AFTER_MS = 2 * 60_000;
/** S2 stays quiet right after S1: the near layer already said it. */
export const NEAR_MASKS_DISTANT_MS = 1000;
/** During a call, the sounds that still play are 6 dB down (§8). */
const VOICE_CALL_FACTOR = 0.5;
/** During a call only results and obligations interrupt the companion. */
const QUIET_DURING_CALL = new Set<AudioCue>(["typing", "distant-typing", "step", "launched"]);

/** S2's pace: one slice every clamp(8 / √n, 3, 8) s for n agents off screen. */
export function distantIntervalMs(agentsOffScreen: number): number {
  return 1000 * Math.min(8, Math.max(3, 8 / Math.sqrt(Math.max(1, agentsOffScreen))));
}

const REAL_TIMERS: LaneTimers = {
  now: () => Date.now(),
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const IDLE_CONTEXT: CueContext = { hidden: false, phone: false, voiceCall: false, ownsEvents: () => true };

export interface CuePlayerOptions {
  transport: CueTransport;
  /** Device-local settings, read per event. */
  prefs: () => CuePrefs;
  context?: () => CueContext;
  timers?: LaneTimers;
  /** Called after S6 or S7 actually starts — the ambient loop ducks. */
  onPriorityCue?: (cue: AudioCue) => void;
  /**
   * Called after an event sound actually started and is audible (a non-null
   * handle at a volume above zero), never for a preview: the caption that says
   * what it announced. `captions` is empty when no request carried one. A cut
   * sound's replay (captions null in the lane) already showed its toast and
   * does not call this.
   */
  onPlayed?: (sound: EventSoundId, batch: number, captions: CueCaption[]) => void;
  dedupeCapacity?: number;
  /** Slice choice, injectable for tests. */
  pick?: () => number;
}

export interface CuePlayer {
  play(request: CueRequest): CueOutcome;
  /** Typing voices currently sounding. */
  activeVoices(): readonly AudioCue[];
  /** Empty the event lane's queue: mute, the master switch, a call connecting. */
  clearQueue(): void;
  /** Drops every remembered identity and stops every voice (page teardown). */
  reset(): void;
}

export function createCuePlayer(options: CuePlayerOptions): CuePlayer {
  const dedupeCapacity = options.dedupeCapacity ?? DEDUPE_CAPACITY;
  const timers = options.timers ?? REAL_TIMERS;
  const context = options.context ?? (() => IDLE_CONTEXT);
  const pick = options.pick ?? Math.random;
  /** Insertion-ordered, so eviction walks the oldest identity first. */
  const considered = new Set<string>();
  const typing = new Map<number, { cue: AudioCue; handle: CueVoiceHandle }>();
  let voiceSequence = 0;
  let lastNear = -Infinity;
  /* The pace (3 s at least) is longer than a slice, so S2 is one voice. */
  let lastDistant = -Infinity;

  const remember = (eventId: string): void => {
    considered.add(eventId);
    if (considered.size <= dedupeCapacity) return;
    for (const id of considered) {
      if (considered.size <= dedupeCapacity) break;
      considered.delete(id);
    }
  };

  const lane: EventLane = createEventLane({
    timers,
    start(sound, batch, captions) {
      /* Read at play time: a mute or a call that arrived while the sound
         waited in its window wins. */
      const prefs = options.prefs();
      const now = context();
      if (!prefs.cuesEnabled) return null;
      if (now.voiceCall && QUIET_DURING_CALL.has(sound)) return null;
      const handle = options.transport.startEvent({
        sound,
        volume: clampVolume(prefs.cueVolume) * (now.voiceCall ? VOICE_CALL_FACTOR : 1),
        pan: 0,
        batch,
      });
      if (handle && isPriorityCue(sound)) options.onPriorityCue?.(sound);
      if (handle && captions && prefs.cueVolume > 0) options.onPlayed?.(sound, batch, captions);
      return handle;
    },
  });

  function playTyping(request: CueRequest, prefs: CuePrefs, now: CueContext): CueOutcome {
    if (!prefs.typingEnabled || now.hidden || now.voiceCall) return "disabled";
    const distant = request.cue === "distant-typing";
    const clock = timers.now();
    if (distant) {
      if (now.phone) return "disabled";
      if (clock - lastDistant < distantIntervalMs(request.agentsOffScreen ?? 1)) return "dropped";
      if (clock - lastNear < NEAR_MASKS_DISTANT_MS) return "dropped";
    } else if (typing.size >= TYPING_VOICES) {
      return "dropped";
    }
    const key = ++voiceSequence;
    const delaySeconds = Math.max(0, request.delayMs ?? 0) / 1000;
    const handle = options.transport.startTyping({
      src: typingAsset(pick),
      gain: TYPING_GAIN * clampVolume(prefs.cueVolume),
      pan: distant ? (pick() * 2 - 1) * 0.3 : Math.max(-1, Math.min(1, request.pan ?? 0)),
      delaySeconds,
      distant,
      onEnded: () => { typing.delete(key); },
    });
    if (!handle) return "blocked";
    if (distant) {
      lastDistant = clock;
    } else {
      lastNear = clock + delaySeconds * 1000;
      typing.set(key, { cue: request.cue, handle });
    }
    return "played";
  }

  return {
    play(request: CueRequest): CueOutcome {
      if (considered.has(request.eventId)) return "deduped";
      remember(request.eventId);

      if (request.occurredAt !== undefined && timers.now() - request.occurredAt >= (request.maxAgeMs ?? STALE_AFTER_MS)) return "stale";
      const prefs = options.prefs();
      if (!prefs.cuesEnabled) return "disabled";
      const now = context();
      if (isTypingCue(request.cue)) return playTyping(request, prefs, now);
      if (request.preview) {
        const handle = options.transport.startEvent({ sound: request.cue, volume: clampVolume(prefs.cueVolume), pan: 0, batch: 1 });
        return handle ? "played" : "blocked";
      }

      /* A hidden phone has suspended its transport; nothing plays (§8). */
      if (now.phone && now.hidden) return "disabled";
      if (now.voiceCall && QUIET_DURING_CALL.has(request.cue)) return "disabled";
      /* One device, one sound per event: only the tab that owns them. */
      if (!now.ownsEvents()) return "dropped";
      const outcome = lane.request({ sound: request.cue, obligation: request.obligation, pipeline: request.pipeline, caption: request.caption });
      return outcome === "accepted" ? "scheduled" : "dropped";
    },

    activeVoices(): readonly AudioCue[] {
      return [...typing.values()].map((voice) => voice.cue);
    },

    clearQueue(): void {
      lane.clear();
    },

    reset(): void {
      for (const voice of typing.values()) voice.handle.stop();
      typing.clear();
      considered.clear();
      lane.reset();
      lastNear = -Infinity;
      lastDistant = -Infinity;
    },
  };
}

function clampVolume(volume: number): number {
  return Math.max(0, Math.min(1, volume));
}
