/*
 * The short sounds that mark a voice session connecting and disconnecting (item 5 of
 * docs/design/voice-delegatus-live-feedback.md). Two sine tones through one gain, made by the page itself: no file,
 * no fetch, no decoding. A cue is best effort and never fails a session, and the header's sound switch governs it.
 */

import { readAudioPrefs } from "@/lib/audio/prefs";

export const CUE_TONES = { low: 660, high: 990 } as const;
/** Quiet: well under the voice. */
export const CUE_PEAK_GAIN = 0.05;
const TONE_S = 0.07;
const GAP_S = 0.02;
const ATTACK_S = 0.008;
const FLOOR = 0.0001;
/** A cue that sounds as the page leaves is let finish before its context closes. */
export const CUE_CLOSE_MS = 300;

export interface CompanionCues {
  /** On the Talk tap, the user activation the browser needs: opens the context. */
  prepare(): void;
  connect(): void;
  disconnect(): void;
  /** Closes the context. */
  dispose(): void;
}

export function createBrowserCues(
  factory: () => AudioContext = () => new AudioContext(),
  enabled: () => boolean = () => readAudioPrefs().cuesEnabled,
): CompanionCues {
  let context: AudioContext | null = null;
  const open = (): AudioContext | null => {
    try {
      if (!context || context.state === "closed") context = factory();
      return context;
    } catch { return null; }
  };
  const play = (hz: readonly [number, number]) => {
    try {
      if (!enabled()) return;
      const audio = open();
      if (!audio) return;
      void audio.resume?.().catch?.(() => undefined);
      const gain = audio.createGain();
      gain.connect(audio.destination);
      const begin = audio.currentTime;
      hz.forEach((frequency, index) => {
        const at = begin + index * (TONE_S + GAP_S);
        const oscillator = audio.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        gain.gain.setValueAtTime(FLOOR, at);
        gain.gain.linearRampToValueAtTime(CUE_PEAK_GAIN, at + ATTACK_S);
        gain.gain.exponentialRampToValueAtTime(FLOOR, at + TONE_S);
        oscillator.start(at);
        oscillator.stop(at + TONE_S + 0.01);
      });
    } catch { /* silence is the fallback */ }
  };
  return {
    prepare() { open(); },
    connect() { play([CUE_TONES.low, CUE_TONES.high]); },
    disconnect() { play([CUE_TONES.high, CUE_TONES.low]); },
    dispose() {
      const audio = context;
      context = null;
      if (audio) setTimeout(() => { try { void audio.close().catch(() => undefined); } catch { /* already closed */ } }, CUE_CLOSE_MS);
    },
  };
}
