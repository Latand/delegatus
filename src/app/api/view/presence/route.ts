import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { upsertPresence } from "@/lib/view/presenceStore";
import { readBoundedJson, validatePresence, ViewValidationError } from "@/lib/view/validation";
import { headOf } from "@/lib/selfUpdate/release";
import { shortSha } from "@/lib/selfUpdate/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const serving = (async () => {
  const revision = process.env.LLV_HOT_STATE_RELEASE_REVISION || await headOf(process.cwd());
  return revision && /^[a-f0-9]{40}$/.test(revision) ? shortSha(revision) : null;
})();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  try {
    const payload = validatePresence(await readBoundedJson(request));
    const result = upsertPresence(payload);
    return NextResponse.json({ ok: true, accepted: result.accepted, viewSessionId: result.session.viewSessionId, serving: await serving }, { headers });
  } catch (error) {
    const known = error instanceof ViewValidationError ? error : new ViewValidationError("INVALID_REQUEST", "invalid request");
    return NextResponse.json({ error: known.code, message: known.message }, { status: known.status, headers });
  }
}
