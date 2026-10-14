import type { TranscribeResponse } from "./types";

/** All dictation transports and native voice instructions share this set. */
export const TRANSCRIPTION_LANGUAGES = Object.freeze(["uk", "ru", "en"] as const);
export type TranscriptionLanguage = typeof TRANSCRIPTION_LANGUAGES[number];

const LANGUAGE_ALIASES = new Map<string, TranscriptionLanguage>([["ukr", "uk"], ["rus", "ru"], ["eng", "en"]]);

function allowedLanguage(value: unknown): TranscriptionLanguage | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return TRANSCRIPTION_LANGUAGES.find(language => language === code) ?? LANGUAGE_ALIASES.get(code);
}

/** Single-language providers follow the UI locale; absent/unsupported hints
 * choose the first allowed language. Regional and ISO-639-3 codes normalize. */
export function transcriptionLanguage(value?: unknown): TranscriptionLanguage {
  return allowedLanguage(value) ?? TRANSCRIPTION_LANGUAGES[0];
}

/** Retain provider text, tagging an unexpected code with the preferred allowed
 * language. This is metadata normalization, with no claim to repair spelling.
 * Providers that return no language keep the existing text-only response. */
export function transcriptionResult(text: unknown, languages: readonly unknown[], preferred?: unknown): TranscribeResponse {
  const result: TranscribeResponse = { text: typeof text === "string" ? text : "" };
  const reported = languages.filter(code => typeof code === "string" && code.trim());
  if (reported.length) {
    result.language = reported.some(code => !allowedLanguage(code))
      ? transcriptionLanguage(preferred)
      : transcriptionLanguage(reported[0]);
  }
  return result;
}

/** GPT-Live consumes audio natively and exposes no STT language field. Both
 * the API and Codex voice paths receive these shared recognition instructions. */
export const VOICE_RECOGNITION_LANGUAGES = `Speech recognition languages: ${TRANSCRIPTION_LANGUAGES.join(", ")}. Recognize and transcribe the operator's speech only in those languages, preserving the spoken wording and script. For ambiguous speech, choose one of those languages; ask for clarification when you cannot understand it.`;
