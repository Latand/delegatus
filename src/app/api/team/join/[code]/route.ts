import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, device, readJson, respondSignedIn, teamErrorResponse, teamJson } from "@/lib/team/http";
import { previewJoin, redeemJoin } from "@/lib/team/members";
import { existingTeamStore } from "@/lib/team/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ code: string }> };

/** What a link is, before anyone uses it: who invited, whose phone hand-off,
    or the host's recovery. An expired, used or unknown code says only that. */
export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    const store = existingTeamStore();
    const { code } = await ctx.params;
    return teamJson(store ? previewJoin(store, code) : { valid: false });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

/** Uses the link: joins as a new member, signs this phone in as the member
    who handed it off, or signs in as (or becomes) the owner. */
export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    const store = existingTeamStore();
    if (!store) return teamJson({ error: "this link was already used or has expired", code: "link_invalid" }, 410);
    const { code } = await ctx.params;
    const body = await readJson(req);
    return respondSignedIn(req, redeemJoin(store, code, body.name, device(req)));
  } catch (error) {
    return teamErrorResponse(error);
  }
}
