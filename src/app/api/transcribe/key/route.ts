import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { LIVE_KEY_ENV, liveKeySource, transcribeBackendInfo, writeTranscribeKey, type TranscribeBackendInfo } from "@/lib/transcribeBackend";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_KEY_LENGTH = 512;

/**
 * Save a live dictation provider's key from the setup guide (#2004). The body
 * is never logged and the key is never answered back: the reply is the same
 * availability report `GET /api/transcribe/backend` gives. There is no GET on
 * this path, since nothing here is meant to be read.
 */
export async function PUT(req: NextRequest): Promise<NextResponse<TranscribeBackendInfo | (ApiError & { code?: string })>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { provider?: unknown; key?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const provider = body.provider;
  if (provider !== "elevenlabs" && provider !== "soniox") {
    return NextResponse.json({ error: "provider must be elevenlabs or soniox" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key || key.length > MAX_KEY_LENGTH || /[\r\n]/.test(key)) {
    return NextResponse.json({ error: `key must be one line of 1 to ${MAX_KEY_LENGTH} characters` }, { status: 400 });
  }
  if (liveKeySource(provider) === "env") {
    return NextResponse.json({ error: `the key comes from ${LIVE_KEY_ENV[provider]}`, code: "KEY_FROM_ENV" }, { status: 409 });
  }
  try {
    writeTranscribeKey(provider, key);
  } catch (error) {
    /* The error names the file, never its content. */
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
  return NextResponse.json(transcribeBackendInfo());
}
