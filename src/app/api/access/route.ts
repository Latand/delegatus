import { NextRequest, NextResponse } from "next/server";

import { currentTailnetUrl, readPhoneAccess, viewerPortFor, type AccessResponse } from "@/lib/access/phoneAccess";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { accessKeyWithheld } from "@/lib/team";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The proxy already gates every request (including this one) behind the same
// token, so any caller that reaches this handler is already authorized to see
// it. Guarded with rejectCrossOrigin anyway as defense in depth against DNS
// rebinding, since this route is the one place that hands back the secret URL.
export async function GET(req: NextRequest): Promise<NextResponse<AccessResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const read = await readPhoneAccess(viewerPortFor(req.url));
  /* On a team install a member gets the address and never the key in it: the
     key would outlive their membership, and their phone signs in instead. */
  const tailnetUrl = currentTailnetUrl();
  return NextResponse.json({ tailnetUrl: tailnetUrl && accessKeyWithheld(req) ? withoutAccessKey(tailnetUrl) : tailnetUrl, phone: read.phone, phoneError: read.error });
}

function withoutAccessKey(link: string): string | null {
  try {
    const url = new URL(link);
    url.searchParams.delete("k");
    return url.toString();
  } catch {
    return null;
  }
}
