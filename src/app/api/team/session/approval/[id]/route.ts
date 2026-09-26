import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, device, readJson, respondSignedIn, signInStore, teamErrorResponse, teamJson } from "@/lib/team/http";
import { approvalState, challengeForRequester, completeApproval } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The waiting device polls `{ proof }`, and once approved sends
    `{ proof, complete: true }` for its cookie. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const store = signInStore();
  if (store instanceof NextResponse) return store;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const challenge = challengeForRequester(store, id, body.proof, "approval");
    if (!challenge) return teamJson({ state: "expired" });
    if (body.complete === true) return respondSignedIn(req, completeApproval(store, challenge, device(req)));
    return teamJson(approvalState(store, challenge));
  } catch (error) {
    return teamErrorResponse(error);
  }
}
