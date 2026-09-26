import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { isAsksMonthlyCap, writeAsksYouSettings } from "@/lib/asks/settings";
import type { AsksYouSettingView } from "@/lib/asks/types";
import { asksYouSettingView } from "@/lib/asks/view";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export interface AsksYouSettingResponse extends AsksYouSettingView {
  ok: true;
}

/** The "Asks you" switch (docs/research/attention-classifier.md §7): whether
    the last message of each agent's turn goes to the classifier, and this
    month's spend against the cap. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, ...asksYouSettingView() } satisfies AsksYouSettingResponse, { headers });
}

/** Only the operator turns it on: it decides what text leaves the machine. */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // fall through to the shape check
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const enabled = record?.enabled;
  const capUsd = record?.capUsd;
  const shapeOk = (enabled === undefined || typeof enabled === "boolean")
    && (capUsd === undefined || isAsksMonthlyCap(capUsd))
    && (enabled !== undefined || capUsd !== undefined);
  if (!shapeOk) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "enabled (boolean) or capUsd (USD, 0 to 50) is required" }, { status: 400, headers });
  }
  const written = writeAsksYouSettings({
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    ...(typeof capUsd === "number" ? { capUsd } : {}),
  });
  if (!written) return NextResponse.json({ error: "INTERNAL_ERROR", message: "could not persist the setting" }, { status: 500, headers });
  return NextResponse.json({ ok: true, ...asksYouSettingView() } satisfies AsksYouSettingResponse, { headers });
}
