import type { EventSoundId } from "./synth";

/**
 * The sound map's cue ids, and the ONE table that binds the typing files
 * (docs/design/sound-redesign.md §3.1).
 *
 * Every cue name is what it tells the operator, never a sound description:
 * the event sounds are synthesized by `./synth` from their specs, and the
 * typing effect is the one recorded material, eight slices of one master take
 * shipped byte for byte. Nothing else in the app may name an audio file.
 */

export type AudioCue =
  /** S1: a tool call in a conversation on screen. */
  | "typing"
  /** S2: a tool call of an agent off screen, heard one room away. */
  | "distant-typing"
  /** S3–S9, ordered by priority in {@link EVENT_PRIORITY}. */
  | EventSoundId;

export const CUE_ASSET_DIR = "/audio/cues";

/** The kept typing effect: one slice drawn at random per tool call. */
export const TYPING_SLICES: readonly string[] = [
  "tool-tick-1.mp3", "tool-tick-2.mp3", "tool-tick-3.mp3", "tool-tick-4.mp3",
  "tool-tick-5.mp3", "tool-tick-6.mp3", "tool-tick-7.mp3", "tool-tick-8.mp3",
];

/** Each typing slice plays at this gain × cue volume (unchanged, §5.4). */
export const TYPING_GAIN = 0.5;

/** The event lane's order, highest first (§6.2). */
export const EVENT_PRIORITY: readonly EventSoundId[] = ["your-move", "fault", "reply", "released", "landed", "launched", "step"];

export function isTypingCue(cue: AudioCue): cue is "typing" | "distant-typing" {
  return cue === "typing" || cue === "distant-typing";
}

/** Rank on the event lane: higher wins. */
export function eventRank(cue: EventSoundId): number {
  return EVENT_PRIORITY.length - EVENT_PRIORITY.indexOf(cue);
}

/** The two sounds that need the operator duck the ambient music (§6.4). */
export function isPriorityCue(cue: AudioCue): boolean {
  return cue === "your-move" || cue === "fault";
}

export function typingAsset(pick: () => number = Math.random): string {
  const file = TYPING_SLICES[Math.min(TYPING_SLICES.length - 1, Math.floor(pick() * TYPING_SLICES.length))]!;
  return `${CUE_ASSET_DIR}/${file}`;
}

/** Every typing file, for warming. */
export function typingAssetAll(): string[] {
  return TYPING_SLICES.map((file) => `${CUE_ASSET_DIR}/${file}`);
}

/** One cue request: the cue, plus the stable identity it de-duplicates on. */
export interface CueRequest {
  cue: AudioCue;
  /**
   * Stable identity of the LOGICAL event — a tool call id, a launch id, an
   * attention request id, a stage attempt. Never a timestamp taken at call
   * time: the same event observed again after a refetch, a re-render or a
   * reconnect replay must produce the same string.
   */
  eventId: string;
  /** Stereo position, -1 hard left … 1 hard right. */
  pan?: number;
  /**
   * Scheduling offset for typing, so several calls from one parse read as a
   * cascade instead of a chord. Scheduled on the audio clock; the identity is
   * spent and the voice counted the moment the cue is requested.
   */
  delayMs?: number;
  /**
   * When the event itself happened (epoch ms), for the staleness rule (§6.1):
   * an event sounds only while it is younger than {@link CueRequest.maxAgeMs}.
   * Absent for what is observed live (typing, a reply, a launch).
   */
  occurredAt?: number;
  /** Staleness bound for `occurredAt`; 2 minutes unless the source says otherwise. */
  maxAgeMs?: number;
  /**
   * One decision can enter the needs-you queue as several records; the task
   * it belongs to names it once (§4.1). A key heard in the last 10 minutes
   * stays silent.
   */
  obligation?: string;
  /** The lane an S3 or S4 belongs to, so a landing supersedes its last step. */
  pipeline?: string;
  /** S2: how many agents are working off screen, which sets its pace (§5.5). */
  agentsOffScreen?: number;
  /** The settings panel previewing a sound: it plays at once, outside the lane. */
  preview?: boolean;
}
