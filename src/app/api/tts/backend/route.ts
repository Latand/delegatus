import { NextRequest, NextResponse } from "next/server";

import { isFishAudioModel } from "@/lib/fishAudio";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isTtsBackend, TTS_BACKENDS, ttsBackendInfo, writeTtsBackend, writeTtsByLanguage, writeFishAudioModel, type TtsBackendInfo } from "@/lib/ttsBackend";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<TtsBackendInfo>> {
  return NextResponse.json(ttsBackendInfo());
}

export async function POST(req: NextRequest): Promise<NextResponse<TtsBackendInfo | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: { backend?: unknown; model?: unknown; byLanguage?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "expected a JSON object" }, { status: 400 });
  if (body.byLanguage !== undefined) {
    if (body.byLanguage !== true || body.backend !== undefined || body.model !== undefined) return NextResponse.json({ error: "invalid language routing selection" }, { status: 400 });
    if (ttsBackendInfo().lockedByEnv) return NextResponse.json({ error: "selection is locked by LLV_TTS_BACKEND" }, { status: 409 });
    writeTtsByLanguage(true);
    return NextResponse.json(ttsBackendInfo());
  }
  if (!isTtsBackend(body.backend)) return NextResponse.json({ error: `backend must be one of ${TTS_BACKENDS.join(", ")}` }, { status: 400 });
  if (body.model !== undefined && (body.backend !== "fishaudio" || !isFishAudioModel(body.model))) return NextResponse.json({ error: "invalid Fish Audio model" }, { status: 400 });
  const info = ttsBackendInfo();
  if (body.model !== undefined && info.options.find((option) => option.id === "fishaudio")?.modelLockedByEnv) return NextResponse.json({ error: "model is locked by LLV_TTS_FISHAUDIO_MODEL" }, { status: 409 });
  if (info.lockedByEnv && (body.model === undefined || body.backend !== info.backend)) return NextResponse.json({ error: "selection is locked by LLV_TTS_BACKEND" }, { status: 409 });
  if (isFishAudioModel(body.model)) writeFishAudioModel(body.model);
  if (!info.lockedByEnv) { writeTtsBackend(body.backend); writeTtsByLanguage(false); }
  return NextResponse.json(ttsBackendInfo());
}
