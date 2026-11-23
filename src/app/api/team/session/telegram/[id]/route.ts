import { NextResponse, type NextRequest } from "next/server";

import { challengeForRequester } from "@/lib/team/members";
import { crossOrigin, device, readJson, respondSignedIn, signInStore, teamErrorResponse, teamJson } from "@/lib/team/http";
import { completeTelegram, confirmTelegram, telegramState, voidTelegram } from "@/lib/team/telegramSignIn";
import { revokeOwnerRuns } from "@/lib/externalRelay/ownerRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ proof }` polls; `{ proof, action: "confirm", code }` types back the
    code the bot sent to whoever pressed Start; `{ proof, action: "complete" }`
    takes the cookie once that code confirmed a known member (or the owner
    approved a join); `{ proof, action: "not-me" }` voids the request when the
    name shown is someone else's. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const store = signInStore();
  if (store instanceof NextResponse) return store;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const challenge = challengeForRequester(store, id, body.proof, "telegram");
    if (!challenge) return teamJson({ state: "expired" });
    if (body.action === "confirm") {
      const linking = challenge.payload?.purpose === "link";
      const prior = linking ? store.owner()?.telegram?.userId : undefined;
      const result = confirmTelegram(store, challenge, body.code);
      if (linking && store.owner()?.telegram?.userId !== prior) await revokeOwnerRuns();
      return teamJson(result);
    }
    if (body.action === "complete") return respondSignedIn(req, completeTelegram(store, challenge, device(req)));
    if (body.action === "not-me") {
      voidTelegram(store, challenge);
      return teamJson({ state: "denied" });
    }
    return teamJson(telegramState(store, challenge));
  } catch (error) {
    return teamErrorResponse(error);
  }
}
