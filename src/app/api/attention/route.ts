import { NextRequest, NextResponse } from "next/server";

import { attentionForDevice, raiseAttentionRequest } from "@/lib/attention/service";
import { MAX_ECHOED_IDS } from "@/lib/attention/targetRecords";
import { readBoundedJson, validateAttentionCreate } from "@/lib/attention/validation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { attentionFailure } from "./failure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** What this device should render right now, plus anything the clock just
    expired so the caller can say so once. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const deviceId = request.nextUrl.searchParams.get("deviceId");
  if (!deviceId) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "deviceId is required" }, { status: 400, headers });
  }
  /* The lanes this device is holding out of an earlier push (#1836), so the
     read can answer which of them the registry does not hold at all. Bounded
     and length-checked here rather than trusted: this is a query string. */
  const echoedPipelineIds = (request.nextUrl.searchParams.get("echoes") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id.length <= 128)
    .slice(0, MAX_ECHOED_IDS);
  try {
    return NextResponse.json({ ok: true, ...attentionForDevice(deviceId, { echoedPipelineIds }) }, { headers });
  } catch (error) {
    return attentionFailure(error);
  }
}

/** Raise a request. The root identity is resolved server-side (D4). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) {
    rejection.headers.set("Cache-Control", "no-store");
    return rejection;
  }
  try {
    const created = raiseAttentionRequest(validateAttentionCreate(await readBoundedJson(request)));
    return NextResponse.json({ ok: true, ...created }, { headers });
  } catch (error) {
    return attentionFailure(error);
  }
}
