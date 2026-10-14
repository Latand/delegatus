/** Observed in Fish Audio's changelog on 2026-10-14; see docs/design/fish-audio-tts.md. */
export const FISH_AUDIO_MODELS = ["s2.1-pro-free", "s2.1-pro"] as const;
export type FishAudioModel = typeof FISH_AUDIO_MODELS[number];
export const FISH_AUDIO_FREE_UNTIL = "2026-11-30";
export function isFishAudioModel(value: unknown): value is FishAudioModel {
  return typeof value === "string" && (FISH_AUDIO_MODELS as readonly string[]).includes(value);
}
/** UTC is the local guard's boundary; the provider does not specify a timezone. */
export function fishAudioFreeEnded(now = Date.now()): boolean {
  return now >= Date.parse(`${FISH_AUDIO_FREE_UNTIL}T00:00:00Z`) + 86_400_000;
}
export function fishAudioFreeDate(locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${FISH_AUDIO_FREE_UNTIL}T00:00:00Z`));
}
