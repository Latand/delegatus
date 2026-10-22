"use client";

import { playSound, soundGraphFor, type SmallSoundId } from "@/lib/audio/synth";

/**
 * The tab's shared AudioContext, the pane geometry the cues pan by, the live
 * feeds that decide between near and distant typing, and the dictation pair.
 *
 * The agent lifecycle tunes that used to live here are gone: the sound map
 * (docs/design/sound-redesign.md) voices results and obligations from the
 * board and the needs-you queue instead, through `@/lib/audio`.
 */

/* Dictation cap cues: two quick pings near the cap, and a low fall when the
   recording auto-stops at the limit. */
export type ChimeKind = "dictWarn" | "dictStop";

const SOUND_KEY = "llvSound";

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* private mode: sound stays session-only */
  }
}

/* ---- pane geometry registry -------------------------------------------- */

/* Panes register their DOM node so the chime of a file can be panned to its
   on-screen position even though transitions are detected app-wide in Viewer. */
const paneEls = new Map<string, HTMLElement>();

export function registerPane(path: string, el: HTMLElement): () => void {
  paneEls.set(path, el);
  return () => {
    if (paneEls.get(path) === el) paneEls.delete(path);
  };
}

/** Stereo position of a pane: -1 hard left … 1 hard right, 0 when unmounted. */
export function panForPane(path: string): number {
  const el = paneEls.get(path);
  if (!el || typeof window === "undefined") return 0;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return 0;
  const center = rect.left + rect.width / 2;
  return Math.max(-1, Math.min(1, (center / window.innerWidth) * 2 - 1));
}

/* ---- live feeds ---------------------------------------------------------- */

/* A conversation whose feed is mounted AND running in this tab: a board pane
   in or near the viewport, the expanded overlay, the phone sheet. Only a live
   feed parses, so only a live feed can ring its own typing; every other live
   session is heard as the distant murmur (§4.4 of docs/design/sound-redesign.md).
   Reference-counted, because several surfaces can show one conversation. */
const liveFeeds = new Map<string, number>();

export function registerLiveFeed(conversationId: string): () => void {
  liveFeeds.set(conversationId, (liveFeeds.get(conversationId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (liveFeeds.get(conversationId) ?? 1) - 1;
    if (count > 0) liveFeeds.set(conversationId, count);
    else liveFeeds.delete(conversationId);
  };
}

export function hasLiveFeed(conversationId: string): boolean {
  return liveFeeds.has(conversationId);
}

/* ---- synthesis ---------------------------------------------------------- */

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/**
 * The tab's single AudioContext, shared with the sampled cue layer
 * (`@/lib/audio`). One context means ONE thing the autoplay policy has to
 * unlock: {@link primeAudio} resumes it and both the synthesized dictation
 * chimes and the earcons start working at the same moment. Browsers also cap how
 * many contexts a page may own, and a second one here would spend that budget
 * for nothing.
 */
export function sharedAudioContext(): AudioContext | null {
  return audioCtx();
}

/**
 * Autoplay policy keeps a fresh AudioContext suspended until a user gesture;
 * unlock it on the first interaction so later poll-driven chimes can play.
 * Returns the listener cleanup.
 */
export function primeAudio(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const unlock = () => {
    const audio = audioCtx();
    if (audio && audio.state !== "running") void audio.resume().catch(() => undefined);
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

const CHIME_SOUND: Record<ChimeKind, SmallSoundId> = { dictWarn: "dict-warn", dictStop: "dict-stop" };

/**
 * Plays one dictation cue panned to `pan` (-1…1), through the same synthesis
 * engine and graph as every other sound, at its fixed quiet level. Silently
 * dropped while the context is still locked by the autoplay policy
 * (primeAudio unlocks it on the first user interaction).
 */
export function chime(kind: ChimeKind, pan: number, delayMs = 0) {
  if (!soundEnabled()) return;
  const audio = audioCtx();
  if (!audio) return;
  if (audio.state !== "running") {
    void audio.resume().catch(() => undefined);
    return;
  }
  const graph = soundGraphFor(audio);
  const at = Math.max(audio.currentTime + 0.02, graph.settledAt) + delayMs / 1000;
  playSound(graph, CHIME_SOUND[kind], { at, volume: 1, pan });
}
