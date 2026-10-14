import { transcriptionLanguage, transcriptionResult } from "./languages";
import type { TranscribeResponse } from "./types";

/* ElevenLabs Scribe batch STT. The realtime scribe_v2 model is WebSocket-only;
   for the record-then-transcribe flow the batch endpoint takes the webm as-is. */
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVENLABS_MODEL = process.env.LLV_ELEVENLABS_STT_MODEL || "scribe_v1";
const UPSTREAM_TIMEOUT_S = 90;

export async function elevenLabsTranscribe(apiKey: string, file: File, language: string): Promise<TranscribeResponse> {
  const form = new FormData();
  form.append("model_id", ELEVENLABS_MODEL);
  form.append("file", file, "dictation.webm");
  form.append("language_code", transcriptionLanguage(language));
  const res = await fetch(ELEVENLABS_STT_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_S * 1000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { text?: unknown; language_code?: unknown };
  return transcriptionResult(json.text, [json.language_code], language);
}
