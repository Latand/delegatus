import { TRANSCRIPTION_LANGUAGES, transcriptionResult } from "./languages";
import type { TranscribeResponse } from "./types";

export async function openAiTranscribe(apiKey: string, file: File, language: string, request: typeof fetch = fetch): Promise<TranscribeResponse> {
  const form = new FormData();
  form.append("model", "gpt-transcribe");
  form.append("file", file, /\.[a-z0-9]+$/i.test(file.name) ? file.name : "dictation.webm");
  for (const code of TRANSCRIPTION_LANGUAGES) form.append("languages[]", code);
  try {
    const response = await request("https://api.openai.com/v1/audio/transcriptions", { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw Error("upstream");
    const body = await response.json();
    if (typeof body?.text !== "string" || (body.languages !== undefined && !Array.isArray(body.languages))) throw Error("shape");
    return transcriptionResult(body.text, (body.languages ?? []).map((row: { code?: unknown }) => row?.code), language);
  } catch { throw Error("OpenAI transcription unavailable"); }
}
