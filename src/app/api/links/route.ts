import { NextRequest, NextResponse } from "next/server";

import { currentSelf, saveAddress, checkSavedAddress } from "@/lib/links/self";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
import { isStagingMode } from "@/lib/staging";
import { getToken } from "../../../../bin/tailscale.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function view() {
  return { ...currentSelf(), keyOn: Boolean(process.env.LLV_TOKEN), tailnetUrl: process.env.LLV_TS_URL?.split("?")[0] ?? null };
}

export function GET(req: NextRequest): NextResponse {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  return NextResponse.json(view());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  if (accessKeyWithheld(req)) return NextResponse.json({ error: "owner-required" }, { status: 403 });
  if (isStagingMode()) return NextResponse.json({ error: "staging" }, { status: 409 });
  let body: { action?: unknown; publicUrl?: unknown; label?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid-json" }, { status: 400 }); }
  if (body.action === "key") {
    try {
      const token = process.env.LLV_TOKEN || (await getToken()).token;
      process.env.LLV_TOKEN = token;
      const response = NextResponse.json(view());
      response.cookies.set({ name: "llv_auth", value: token, httpOnly: true, sameSite: "lax", path: "/", maxAge: 2_592_000, secure: req.headers.get("x-forwarded-proto") === "https" });
      return response;
    } catch { return NextResponse.json({ error: "key-failed" }, { status: 500 }); }
  }
  if (body.action === "check") {
    const check = await checkSavedAddress();
    return NextResponse.json({ ...view(), check });
  }
  if (body.action === "save" && typeof body.publicUrl === "string" &&
      (body.label === undefined || typeof body.label === "string")) {
    const saved = await saveAddress(body.publicUrl, body.label as string | undefined);
    if (saved.refusal) return NextResponse.json({ error: saved.refusal }, { status: 409 });
    return NextResponse.json(view());
  }
  return NextResponse.json({ error: "invalid-action" }, { status: 400 });
}
