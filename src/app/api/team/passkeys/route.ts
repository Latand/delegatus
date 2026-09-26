import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, device, readJson, relyingParty, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { passkeyRegistrationOptions, registerPasskey, removePasskey } from "@/lib/team/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's passkeys, marked usable where they were made for this host. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const rp = relyingParty(req);
    return teamJson({
      available: rp !== null,
      passkeys: authed.store.passkeysFor(authed.live.member.id).map((passkey) => ({
        id: passkey.id,
        label: passkey.label,
        rpId: passkey.rpId,
        here: passkey.rpId === rp?.rpId,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
      })),
    });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

/** Register a passkey on this device: `{ step: "options" }`, then
    `{ step: "verify", id, response }`. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  const rp = relyingParty(req);
  if (!rp) return teamJson({ error: "passkeys need this Delegatus on a named HTTPS address", code: "passkey_unavailable" }, 409);
  try {
    const body = await readJson(req);
    if (body.step === "verify") {
      const passkey = await registerPasskey(authed.store, authed.live.member, body.id, body.response as never, rp, device(req));
      return teamJson({ ok: true, passkey: { id: passkey.id, label: passkey.label } });
    }
    return teamJson(await passkeyRegistrationOptions(authed.store, authed.live.member, rp));
  } catch (error) {
    return teamErrorResponse(error);
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const body = await readJson(req);
    const removed = typeof body.id === "string" && removePasskey(authed.store, authed.live.member, body.id);
    return removed ? teamJson({ ok: true }) : teamJson({ error: "no such passkey", code: "passkey_gone" }, 404);
  } catch (error) {
    return teamErrorResponse(error);
  }
}
