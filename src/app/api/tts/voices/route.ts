import { NextRequest, NextResponse } from "next/server";
import { isTtsBackend, readFishAudioApiKey, readOpenAiApiKey, ttsBackendInfo } from "@/lib/ttsBackend";
import { readElevenLabsApiKey, readSonioxApiKey } from "@/lib/transcribeBackend";
import { fetchTtsVoices, VoiceListError } from "@/lib/ttsVoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const backend = req.nextUrl.searchParams.get("backend");
  if (!isTtsBackend(backend)) return NextResponse.json({ error: "invalid backend" }, { status: 400 });
  const option = ttsBackendInfo().options.find((o) => o.id === backend)!;
  const key = backend === "elevenlabs" ? readElevenLabsApiKey() : backend === "soniox" ? readSonioxApiKey() : backend === "fishaudio" ? readFishAudioApiKey() : readOpenAiApiKey();
  if (!key) return NextResponse.json({ error: "text-to-speech is unavailable", code: "missing-key", keyPath: option.keyPath }, { status: 503 });
  if (backend === "openai") return NextResponse.json({ error: "OpenAI has no voice list", code: "no-list" }, { status: 404 });
  try { return NextResponse.json(await fetchTtsVoices(backend, option, key, req.signal), { headers: { "cache-control": "no-store" } }); }
  catch (error) {
    return NextResponse.json({ error: error instanceof VoiceListError ? error.message : "Could not reach the voice provider", code: error instanceof VoiceListError ? error.code : "unreachable" }, { status: 502 });
  }
}
