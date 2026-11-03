import { NextRequest, NextResponse } from "next/server";

import { resolveService } from "@/lib/openaiServices/policy";
import { TRANSCRIPTION_LANGUAGES } from "@/lib/transcribe/languages";
import { CAP_SECONDS } from "@/lib/dictationTimer";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readElevenLabsApiKey, readSonioxApiKey } from "@/lib/transcribeBackend";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Short-lived credential for the browser's realtime STT WebSocket. The client
   asks for one on every dictation start; a non-200 answer just means "no live
   mode here" and the client falls back to record-then-transcribe, so this
   route never needs to be soft about failures. Whichever provider is active,
   the account key stays on this side — only the minted token is handed out. */
const ELEVENLABS_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const SONIOX_TOKEN_URL = "https://api.soniox.com/v1/auth/temporary-api-key";
/* Long enough that a prewarmed token survives the hover-to-press gap, short
   enough that a leaked one is worthless within minutes. */
const SONIOX_TOKEN_TTL_S = 300;
/* One dictation can run to the recording cap; the margin covers the trailing
   frames after the client's stop. */
const SONIOX_SESSION_CAP_S = CAP_SECONDS + 60;

export interface LiveTokenResponse {
  token: string;
  provider: "elevenlabs" | "soniox" | "openai";
  expiresAt?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse<LiveTokenResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const resolution = resolveService("dictation");
  const backend = resolution.effective;
  if (backend === "openai") return openAiToken(resolution.apiKey);
  if (backend !== "elevenlabs" && backend !== "soniox") {
    return NextResponse.json(
      { error: "live transcription is only available with the elevenlabs or soniox backend" },
      { status: 409 },
    );
  }
  return backend === "soniox" ? sonioxToken() : elevenLabsToken();
}

async function elevenLabsToken(): Promise<NextResponse<LiveTokenResponse | ApiError>> {
  const key = readElevenLabsApiKey();
  if (!key) {
    return NextResponse.json(
      { error: "missing ElevenLabs key (~/.config/agent-log-viewer/elevenlabs-api-key or ELEVENLABS_API_KEY)" },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(ELEVENLABS_TOKEN_URL, {
      method: "POST",
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `ElevenLabs token: HTTP ${res.status}` }, { status: 502 });
    }
    const json = (await res.json()) as { token?: unknown };
    if (typeof json.token !== "string" || !json.token) {
      return NextResponse.json({ error: "ElevenLabs token: response had no token" }, { status: 502 });
    }
    return NextResponse.json({ token: json.token, provider: "elevenlabs" });
  } catch (error) {
    return NextResponse.json(
      { error: `ElevenLabs token: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

/* Soniox's realtime socket authenticates with an api_key in the start request,
   so the browser needs a credential of its own: a temporary key minted here,
   scoped to one transcription stream and expiring in minutes. */
async function sonioxToken(): Promise<NextResponse<LiveTokenResponse | ApiError>> {
  const key = readSonioxApiKey();
  if (!key) {
    return NextResponse.json(
      { error: "missing Soniox key (~/.config/agent-log-viewer/soniox-api-key or SONIOX_API_KEY)" },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(SONIOX_TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        usage_type: "transcribe_websocket",
        expires_in_seconds: SONIOX_TOKEN_TTL_S,
        single_use: true,
        max_session_duration_seconds: SONIOX_SESSION_CAP_S,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Soniox token: HTTP ${res.status}` }, { status: 502 });
    }
    const json = (await res.json()) as { api_key?: unknown };
    /* Never fall back to the account key: a malformed answer means no live
       mode, and the client quietly records-then-transcribes instead. */
    if (typeof json.api_key !== "string" || !json.api_key || json.api_key === key) {
      return NextResponse.json({ error: "Soniox token: response had no temporary key" }, { status: 502 });
    }
    return NextResponse.json({ token: json.api_key, provider: "soniox" });
  } catch (error) {
    return NextResponse.json(
      { error: `Soniox token: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

async function openAiToken(key: string | null): Promise<NextResponse<LiveTokenResponse | ApiError>> {
  if (!key) return NextResponse.json({ error: "missing OpenAI key" }, { status: 503 });
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 120 }, session: { type: "transcription", audio: { input: {
        transcription: { model: "gpt-live-transcribe", languages: TRANSCRIPTION_LANGUAGES, delay: "low" }, turn_detection: null,
      } } } }),
    });
    if (!response.ok) throw Error("upstream");
    const body = await response.json();
    if (typeof body?.value !== "string" || !body.value.trim() || /[\s\p{Cc}]/u.test(body.value) || body.value.includes(key) || typeof body.expires_at !== "number" || !Number.isFinite(body.expires_at) || body.expires_at <= Date.now() / 1000) throw Error("invalid");
    return NextResponse.json({ token: body.value, provider: "openai", expiresAt: body.expires_at }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "OpenAI live transcription unavailable" }, { status: 502 }); }
}
