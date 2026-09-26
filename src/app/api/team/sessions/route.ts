import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, readJson, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { onlineWithin, signOutSession } from "@/lib/team/members";
import { sessionIsLive } from "@/lib/team/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live sessions: the caller's own, and everyone's for the owner (§6.9). The
    id a browser sees is a prefix of the stored hash, enough to act on. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { store, live } = authed;
    const now = Date.now();
    const owner = live.member.role === "owner";
    const sessions = store.sessionsFor(owner ? null : live.member.id)
      .filter((session) => sessionIsLive(session, now))
      .map((session) => ({
        id: session.id.slice(0, 16),
        memberId: session.memberId,
        surface: session.surface,
        browser: session.browser,
        method: session.method,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        online: onlineWithin(session.lastSeenAt, now),
        current: session.id === live.session.id,
      }));
    return teamJson({ sessions });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

/** `{ id }` signs one session out, `{ all: true }` every session of the
    caller except this one. A member ends their own; the owner ends anyone's. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { store, live } = authed;
    const body = await readJson(req);
    const owner = live.member.role === "owner";
    const candidates = store.sessionsFor(owner ? null : live.member.id).filter((session) => !session.revokedAt);
    const targets = body.all === true
      ? candidates.filter((session) => session.memberId === live.member.id && session.id !== live.session.id)
      : candidates.filter((session) => typeof body.id === "string" && body.id.length >= 16 && session.id.startsWith(body.id));
    if (!targets.length) return teamJson({ error: "no such session", code: "session_gone" }, 404);
    for (const session of targets) signOutSession(store, live.member, session, Date.now(), session.memberId === live.member.id);
    return teamJson({ ok: true, ended: targets.length });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
