import { NextRequest, NextResponse } from "next/server";

import { currentSelf, saveAddress, checkSavedAddress } from "@/lib/links/self";
import { tokensMatch } from "@/lib/authToken";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
import { isStagingMode } from "@/lib/staging";
import { getToken } from "../../../../bin/tailscale.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function view() {
  return { ...currentSelf(), keyOn: Boolean(process.env.LLV_TOKEN), tailnetUrl: process.env.LLV_TS_URL?.split("?")[0] ?? null };
}

// The operator must be able to save the first public Host from the page opened
// at that Host. Keep this exception local to Settings and require the access
// key itself, since the usual Host pin has not been established yet.
function settingsRejection(req: NextRequest): NextResponse | null {
  const rejection = rejectCrossOrigin(req);
  if (!rejection) return null;
  if (currentSelf().self?.publicUrl || !process.env.LLV_TOKEN) return rejection;
  const key = process.env.LLV_TOKEN;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!tokensMatch(req.cookies.get("llv_auth")?.value ?? "", key) && !tokensMatch(bearer ?? "", key)) return rejection;
  const host = req.headers.get("host");
  if (!host) return rejection;
  const origin = req.headers.get("origin");
  if (origin) {
    try { if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return rejection; }
    catch { return rejection; }
  }
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return rejection;
  return null;
}

export function GET(req: NextRequest): NextResponse {
  const rejection = settingsRejection(req);
  if (rejection) return rejection;
  return NextResponse.json(view());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = settingsRejection(req);
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
