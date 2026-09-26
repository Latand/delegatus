import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, device, readJson, relyingParty, respondSignedIn, signInStore, teamErrorResponse, teamJson } from "@/lib/team/http";
import { passkeySignInOptions, signInWithPasskey } from "@/lib/team/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign in with a passkey (§5.4): `{ step: "options" }`, then
    `{ step: "verify", id, response }` with the browser's assertion. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const store = signInStore();
  if (store instanceof NextResponse) return store;
  const rp = relyingParty(req);
  if (!rp) return teamJson({ error: "passkeys need this Delegatus on a named HTTPS address", code: "passkey_unavailable" }, 409);
  try {
    const body = await readJson(req);
    if (body.step === "verify") {
      return respondSignedIn(req, await signInWithPasskey(store, body.id, body.response as never, rp, device(req)));
    }
    return teamJson(await passkeySignInOptions(rp));
  } catch (error) {
    return teamErrorResponse(error);
  }
}
