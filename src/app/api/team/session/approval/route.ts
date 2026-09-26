import { NextResponse, type NextRequest } from "next/server";

import { formatUserCode } from "@/lib/team/contract";
import { crossOrigin, device, signInStore, teamErrorResponse, teamJson } from "@/lib/team/http";
import { startApproval } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A new device asks to be approved (§5.2): it gets a short code to show and
    a proof only it holds, which it polls with. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const store = signInStore();
  if (store instanceof NextResponse) return store;
  try {
    const { challenge, proof } = startApproval(store, device(req));
    return teamJson({ id: challenge.id, proof, code: formatUserCode(challenge.userCode ?? ""), expiresAt: challenge.expiresAt });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
