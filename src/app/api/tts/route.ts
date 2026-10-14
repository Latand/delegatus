import { NextRequest, NextResponse } from "next/server";

import { readBounded, voiceRefusal, providerErrorMessage } from "@/lib/ttsVoices";
import { redactSecrets } from "@/lib/review";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { MAX_TTS_TEXT_LENGTH, isPcmTtsBackend } from "@/lib/tts";
import { activeTtsOption, readFishAudioApiKey, readOpenAiApiKey, resolveTtsBackend, ttsBackendInfo, type TtsBackend, type TtsBackendOption } from "@/lib/ttsBackend";
import { readElevenLabsApiKey, readSonioxApiKey } from "@/lib/transcribeBackend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const SONIOX_SPEECH_URL = "https://tts-rt.soniox.com/tts";
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_SYNTHESES = 3;
let activeSyntheses = 0;
const sonioxStarts: number[] = [];
function sonioxDelay(): number {
  const now = Date.now();
  while (sonioxStarts.length && sonioxStarts[0]! <= now - 60_000) sonioxStarts.shift();
  return sonioxStarts.length >= 100 ? Math.max(1, Math.ceil((sonioxStarts[0]! + 60_000 - now) / 1000)) : 0;
}
function safeRetryAfter(value: string | null): string {
  const seconds = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : 1;
  return String(Math.max(1, Math.min(60, Math.ceil(seconds))));
}

function admitSynthesis(): (() => void) | null {
  if (activeSyntheses >= MAX_CONCURRENT_SYNTHESES) return null;
  activeSyntheses += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSyntheses -= 1;
  };
}

function boundedAudioStream(body: ReadableStream<Uint8Array>, release: () => void, signal: AbortSignal, clientSignal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let finished = false;
  let abort: () => void;
  const finish = () => { if (finished) return; finished = true; signal.removeEventListener("abort", abort); release(); };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (finished) return;
        finish();
        void reader.cancel().catch(() => undefined);
        if (clientSignal.aborted) controller.close();
        else controller.error(new DOMException("speech stream timed out", "TimeoutError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) { finish(); controller.close(); return; }
        bytes += result.value.byteLength;
        if (bytes > MAX_AUDIO_BYTES) {
          finish(); void reader.cancel().catch(() => undefined);
          controller.error(new Error("TTS audio exceeded 32 MB")); return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        if (finished) return;
        finish(); controller.error(error);
      }
    },
    async cancel(reason) { finish(); await reader.cancel(reason); },
  });
}

/** One provider request, using the configured voice without fallback. */
function synthesisRequest(
  backend: TtsBackend,
  option: TtsBackendOption,
  apiKey: string,
  text: string,
  fast = false,
): { url: string; headers: Record<string, string>; body: string } {
  if (backend === "openai") {
    return {
      url: OPENAI_SPEECH_URL,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: option.model, voice: option.voice, input: text, response_format: "mp3" }),
    };
  }
  if (backend === "fishaudio") {
    return {
      url: "https://api.fish.audio/v1/tts",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", model: option.model },
      body: JSON.stringify({ text, format: "pcm", sample_rate: 24000, latency: "balanced", ...(option.voice === "default" ? {} : { reference_id: option.voice }) }),
    };
  }
  if (backend === "soniox") {
    return {
      url: SONIOX_SPEECH_URL,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: option.model,
        voice: option.voice,
        language: option.language ?? "en",
        audio_format: fast ? "pcm_s16le" : "mp3",
        ...(fast ? { sample_rate: 24000 } : {}),
        text,
      }),
    };
  }
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(option.voice)}/stream?output_format=pcm_24000`,
    headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/pcm" },
    body: JSON.stringify({ model_id: option.model, text }),
  };
}

/**
 * What the route ACTUALLY billed, on every synthesis it answers.
 *
 * The client's copy of the configuration is fetched once per page load, so a
 * tab left open across a provider switch (another tab, or a restart under a new
 * `LLV_TTS_BACKEND`) believes a backend the server no longer uses — and would
 * cache the returned audio under a voice identity that never spoke it (#1024).
 * The response says who spoke, and the client keys the cache and names the
 * provider from that. Percent-encoded, because a configured voice name is
 * arbitrary text and a header value is not.
 */
function billedBy(backend: TtsBackend, option: TtsBackendOption, fast = false): Record<string, string> {
  return {
    "x-tts-backend": backend,
    "x-tts-model": encodeURIComponent(option.model),
    "x-tts-voice": encodeURIComponent(option.voice),
    "x-tts-language": encodeURIComponent(option.language ?? ""),
    "x-tts-encoding": fast ? "pcm_s16le" : "mp3",
    ...(fast ? { "x-tts-sample-rate": "24000", "x-tts-channels": "1" } : {}),
  };
}

export async function GET(): Promise<NextResponse<{ available: boolean }>> {
  const info = ttsBackendInfo();
  return NextResponse.json({ available: info.options.find((option) => option.id === info.backend)?.available === true });
}

export async function POST(req: NextRequest): Promise<Response> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const backend = resolveTtsBackend();
  const option = activeTtsOption();
  const apiKey =
    backend === "openai" ? readOpenAiApiKey() : backend === "soniox" ? readSonioxApiKey() : backend === "fishaudio" ? readFishAudioApiKey() : readElevenLabsApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: "text-to-speech is unavailable", keyPath: option.keyPath }, { status: 503 });
  }

  if (backend === "fishaudio" && option.model === "s2.1-pro-free" && option.freeEnded) {
    return NextResponse.json({ error: "Fish Audio's free model ended on 2026-11-30; choose S2.1 Pro (paid)", code: "fishaudio-free-ended" }, { status: 410 });
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "expected a JSON object" }, { status: 400 });
  }
  const body = parsed as { text?: unknown; mode?: unknown };
  if (body.mode !== undefined && body.mode !== "soniox-pcm" && body.mode !== "pcm") return NextResponse.json({ error: "invalid speech mode" }, { status: 400 });
  const fast = body.mode === "soniox-pcm" || body.mode === "pcm";
  if ((fast && !isPcmTtsBackend(backend)) || ((backend === "fishaudio" || backend === "elevenlabs") && body.mode !== "pcm")) return NextResponse.json({ error: "speech backend changed; refresh configuration" }, { status: 409 });
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text must be a non-empty string" }, { status: 400 });
  }
  if (body.text.length > MAX_TTS_TEXT_LENGTH) {
    return NextResponse.json({ error: `text is too long (${MAX_TTS_TEXT_LENGTH} character limit)` }, { status: 413 });
  }
  const text = redactSecrets(body.text.trim());
  if (backend === "soniox" && new TextEncoder().encode(text).byteLength > 4800) {
    return NextResponse.json({ error: "text is too long (4800 UTF-8 byte limit)" }, { status: 413 });
  }
  const delay = backend === "soniox" ? sonioxDelay() : 0;
  if (delay) return NextResponse.json({ error: "speech request rate exceeded" }, { status: 429, headers: { "retry-after": String(delay) } });
  const release = admitSynthesis();
  if (!release) return NextResponse.json({ error: "another read-aloud is in progress" }, { status: 429 });

  const request = synthesisRequest(backend, option, apiKey, text, fast);
  if (backend === "soniox") sonioxStarts.push(Date.now());
  let upstream: Response;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
  try {
    upstream = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal,
    });
  } catch {
    release();
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json(
      { error: `${backend} TTS request failed` },
      { status: 502 },
    );
  }

  if (signal.aborted) { void upstream.body?.cancel().catch(() => undefined); release(); return new Response(null, { status: 499 }); }
  if (!upstream.ok || !upstream.body) {
    const payload = upstream.body ? await readBounded(upstream.body, 8192, signal) : null;
    release();
    const refusal = voiceRefusal(backend, upstream.status, payload);
    if (refusal) return NextResponse.json({ error: `${backend} does not know voice «${option.voice}»`, code: "voice-not-found", voice: option.voice }, { status: 422 });
    const message = backend === "elevenlabs" ? providerErrorMessage(payload, apiKey) : null;
    const status = ((backend === "soniox" && [400, 401, 402, 403, 429].includes(upstream.status)) || (["fishaudio", "elevenlabs"].includes(backend) && [400, 401, 402, 403, 404, 429].includes(upstream.status))) ? upstream.status : 502;
    return NextResponse.json({ error: message ?? `${backend} TTS failed (HTTP ${upstream.status})`, ...(backend === "fishaudio" && option.model === "s2.1-pro-free" && [402, 403, 404].includes(upstream.status) ? { code: "fishaudio-free-refused" } : {}) }, {
      status, headers: status === 429 ? { "retry-after": safeRetryAfter(upstream.headers.get("retry-after")) } : {},
    });
  }

  let contentType = upstream.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if ((backend === "fishaudio" || backend === "elevenlabs") && (contentType.startsWith("audio/") || contentType === "application/octet-stream")) contentType = "audio/pcm";
  if (!contentType.startsWith("audio/") || (fast && contentType !== "audio/pcm")) {
    void upstream.body.cancel().catch(() => undefined);
    release();
    return NextResponse.json({ error: `${backend} TTS returned invalid audio` }, { status: 502 });
  }
  const contentLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
    void upstream.body.cancel().catch(() => undefined);
    release();
    return NextResponse.json({ error: `${backend} TTS audio is too large` }, { status: 502 });
  }
  const boundedBody = boundedAudioStream(upstream.body, release, signal, req.signal);

  return new Response(boundedBody, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      ...billedBy(backend, option, fast),
    },
  });
}
