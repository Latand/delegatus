import { TRANSCRIPTION_LANGUAGES, transcriptionResult } from "./languages";
import type { TranscriptionLanguage } from "./languages";

/**
 * Soniox realtime STT wire protocol, kept pure so the browser hook stays a
 * thin transport around it and the frame handling is unit-testable without a
 * socket. Documented contract (soniox.com/docs/stt/api-reference/websocket-api):
 *
 *  - the client opens `wss://stt-rt.soniox.com/transcribe-websocket` and sends
 *    one JSON start request, then raw audio as binary frames;
 *  - the server answers with `{ tokens: [{ text, is_final, … }], finished,
 *    error_code, error_message }` frames. Final tokens are emitted once and
 *    never change; non-final tokens are re-sent (and rewritten) every frame;
 *  - with endpoint detection on, a finished utterance arrives as its tokens
 *    turning final followed by a final `<end>` token — the segment boundary;
 *  - an empty frame from the client ends the stream, answered by `finished`.
 */

/** Soniox tokens are sub-word units, so a committed draft segment is only cut
    at the endpoint marker — never per token, which would spell words apart. */
const ENDPOINT_TOKEN = "<end>";

export const SONIOX_LIVE_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const SONIOX_LIVE_MODEL = "stt-rt-v5";

export interface SonioxStartRequest {
  api_key: string;
  model: string;
  audio_format: "pcm_s16le";
  sample_rate: number;
  num_channels: number;
  enable_endpoint_detection: boolean;
  language_hints: readonly TranscriptionLanguage[];
  language_hints_strict: true;
  enable_language_identification: true;
}

/**
 * The start request for a browser microphone stream. `api_key` carries the
 * server-minted temporary key — the real account key never leaves the server.
 */
export function sonioxStartRequest({ token, sampleRate }: {
  token: string;
  sampleRate: number;
  languageHints?: string[];
}): SonioxStartRequest {
  const request: SonioxStartRequest = {
    api_key: token,
    model: SONIOX_LIVE_MODEL,
    audio_format: "pcm_s16le",
    sample_rate: Math.round(sampleRate),
    num_channels: 1,
    /* Gives us utterance boundaries (`<end>`), which is what turns the live
       stream into draft-sized segments instead of one growing blob. */
    enable_endpoint_detection: true,
    language_hints: TRANSCRIPTION_LANGUAGES,
    language_hints_strict: true,
    enable_language_identification: true,
  };
  return request;
}

/** Finalized text of the utterance in progress, still short of its endpoint. */
export interface SonioxLiveState {
  finalText: string;
  language?: TranscriptionLanguage;
}

export interface SonioxLiveUpdate {
  state: SonioxLiveState;
  language?: TranscriptionLanguage;
  /** Segment closed by an endpoint token; ready to drop into the draft. Empty
      when this frame carried no boundary. */
  commit: string;
  /** What the mic overlay shows right now: carried finals plus the tail that
      is still being rewritten. */
  liveText: string;
  /** The server closed the stream (our empty frame, or its own session cap). */
  finished: boolean;
  error: string | null;
}

export function sonioxLiveInitialState(): SonioxLiveState {
  return { finalText: "" };
}

interface SonioxToken {
  language?: unknown;
  text?: unknown;
  is_final?: unknown;
}

interface SonioxFrame {
  tokens?: unknown;
  finished?: unknown;
  error_code?: unknown;
  error_message?: unknown;
}

/** Error frames carry a code plus a human message; normal frames send
    `error_code: null`, which is not a failure. */
function frameError(frame: SonioxFrame): string | null {
  const message = typeof frame.error_message === "string" ? frame.error_message.trim() : "";
  const code = frame.error_code;
  const failed = message.length > 0 || (code !== null && code !== undefined && code !== 0);
  if (!failed) return null;
  return message || `Soniox stream error ${String(code)}`;
}

/**
 * Folds one server frame into the live state. Returns null for anything that
 * is not a JSON object frame (binary keepalives, malformed text), which the
 * caller ignores exactly like the ElevenLabs path does.
 */
export function applySonioxFrame(state: SonioxLiveState, data: unknown): SonioxLiveUpdate | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const frame = parsed as SonioxFrame;

  let finalText = state.finalText;
  let tail = "";
  const segments: string[] = [];
  const languages: unknown[] = [state.language];
  for (const raw of Array.isArray(frame.tokens) ? frame.tokens : []) {
    if (!raw || typeof raw !== "object") continue;
    const token = raw as SonioxToken;
    if (typeof token.text !== "string" || !token.text) continue;
    languages.push(token.language);
    if (token.is_final !== true) {
      tail += token.text;
      continue;
    }
    if (token.text === ENDPOINT_TOKEN) {
      const segment = finalText.trim();
      if (segment) segments.push(segment);
      finalText = "";
      continue;
    }
    finalText += token.text;
  }

  const language = transcriptionResult("", languages).language;
  return {
    ...(language ? { language } : {}),
    state: { finalText, ...(finalText && language ? { language } : {}) },
    commit: segments.join(" "),
    /* Tokens carry their own spacing, so the seam needs no separator — only
       the leading space of a fresh segment is dropped, since the composer
       already puts one between the draft and the overlay. */
    liveText: (finalText + tail).replace(/^\s+/, ""),
    finished: frame.finished === true,
    error: frameError(frame),
  };
}
