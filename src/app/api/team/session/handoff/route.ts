import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, requireMember, shareableLink, teamErrorResponse, teamJson } from "@/lib/team/http";
import { createHandoff } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Sign in my phone" (§5.2): a ten-minute link that signs whoever opens it
    in as the member who asked. The QR draws it; nothing else shows it. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { challenge, code } = createHandoff(authed.store, authed.live.member);
    return teamJson({ url: shareableLink(req, `/join/${code}`), expiresAt: challenge.expiresAt });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
