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
/** Long month, and no era word after the year (Ukrainian appends "р."), so a sentence ending on the date does not end in "..". Parts join with no-break spaces so the date wraps as one piece. */
export function fishAudioFreeDate(locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .formatToParts(new Date(`${FISH_AUDIO_FREE_UNTIL}T00:00:00Z`))
    .filter((part) => part.type !== "literal" || !/\p{L}/u.test(part.value))
    .map((part) => part.value.replace(/ /g, "\u00a0"))
    .join("")
    .trim();
}
const TTS_PROVIDER_NAMES: Record<string, string> = { openai: "OpenAI", elevenlabs: "ElevenLabs", soniox: "Soniox", fishaudio: "Fish Audio" };
/** Display name of a read-aloud provider; an unknown id is shown as it came. */
export function ttsProviderName(id: string): string {
  return TTS_PROVIDER_NAMES[id] ?? id;
}
