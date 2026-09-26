import { NextResponse, type NextRequest } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { MEMBER_REQUIRED_CODE, type TeamPublicInfo } from "./contract";
import { TeamError, type Device, type SignedIn } from "./members";
import { relyingPartyFor, type RelyingParty } from "./passkeys";
import { requestDevice, requestIsHttps, requestSession, setSessionCookie, type LiveSession } from "./sessions";
import { existingTeamStore, teamStore, type TeamStore } from "./store";

/* Route helpers for `src/app/api/team/**`. Every mutation runs the CSRF gate
   first, exactly as every other route does. */

export type TeamRequest = NextRequest;

const NO_STORE = { "Cache-Control": "no-store" };

export function teamJson<T>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function teamErrorResponse(error: unknown): NextResponse<{ error: string; code: string }> {
  if (error instanceof TeamError) return teamJson({ error: error.message, code: error.code }, error.status);
  console.error("[team] request failed", { reason: (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? "unknown" });
  return teamJson({ error: "the team store is unavailable", code: "team_unavailable" }, 503);
}

export function memberRequired(): NextResponse<{ error: string; code: string }> {
  return teamJson({ error: "sign in required", code: MEMBER_REQUIRED_CODE }, 401);
}

export function crossOrigin(req: NextRequest): NextResponse | null {
  return rejectCrossOrigin(req);
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function device(req: NextRequest): Device {
  return requestDevice(req);
}

export type Authed = { store: TeamStore; live: LiveSession };

/** The caller's live session in a team install, or the 401 to answer. */
export function requireMember(req: NextRequest): Authed | NextResponse {
  const store = existingTeamStore();
  if (!store) return memberRequired();
  const live = requestSession(req);
  return live ? { store, live } : memberRequired();
}

export function requireOwner(req: NextRequest): Authed | NextResponse {
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  if (authed.live.member.role !== "owner") return teamJson({ error: "only the owner can do this", code: "owner_required" }, 403);
  return authed;
}

/** The store for a sign-in endpoint: one exists only on a team install. */
export function signInStore(): TeamStore | NextResponse {
  const store = existingTeamStore();
  if (!store || !store.hasActiveOwner()) return teamJson({ error: "this Delegatus has no team", code: "solo_mode" }, 409);
  return store;
}

export { teamStore };

export function respondSignedIn(req: NextRequest, signedIn: SignedIn, extra: Record<string, unknown> = {}): NextResponse {
  const response = teamJson({ ok: true, me: { id: signedIn.member.id, name: signedIn.member.name }, ...extra });
  setSessionCookie(response, signedIn.cookie, requestIsHttps(req));
  return response;
}

export function relyingParty(req: NextRequest): RelyingParty | null {
  return relyingPartyFor(req.headers.get("host"), requestIsHttps(req));
}

/** The origin a link should carry: the one this request arrived on. */
export function requestOrigin(req: NextRequest): string {
  const host = req.headers.get("host") ?? req.nextUrl.host;
  return `${requestIsHttps(req) ? "https" : "http"}://${host}`;
}

const LOOPBACK_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?$/i;

/**
 * A link someone else can open: this request's origin, or the tailnet's when
 * the owner is on loopback (a link to 127.0.0.1 reaches nobody else). It
 * carries no access key: on a team install the perimeter lets anyone reach
 * `/join/`, and the session the link mints is the joiner's way past it from
 * then on (§9). The key would outlive the membership, so it goes into a link
 * only when `withAccessKey` says the link is the owner's own (their phone QR).
 */
export function shareableLink(req: NextRequest, pathname: string, { withAccessKey = false }: { withAccessKey?: boolean } = {}): string {
  const host = req.headers.get("host") ?? req.nextUrl.host;
  let base = requestOrigin(req);
  const tailnet = process.env.LLV_TS_URL;
  if (LOOPBACK_HOST.test(host) && tailnet) {
    try { base = new URL(tailnet).origin; } catch { /* keep the request origin */ }
  }
  const url = new URL(pathname, base);
  const token = process.env.LLV_TOKEN;
  if (token && withAccessKey) url.searchParams.set("k", token);
  return url.toString();
}

export async function telegramBot(): Promise<{ available: boolean; botUsername: string | null }> {
  try {
    const { telegramBotService } = await import("@/lib/telegram/bot/service");
    const status = telegramBotService().status();
    const username = status.bot?.username ?? null;
    const usable = status.connected && Boolean(username) && status.receiving !== "token_rejected" && status.receiving !== "webhook_elsewhere";
    return { available: usable, botUsername: usable ? username : null };
  } catch {
    return { available: false, botUsername: null };
  }
}

/** The host a person reached this Delegatus by, without its port. */
export function requestHostName(req: NextRequest): string {
  return (req.headers.get("host") ?? req.nextUrl.host).replace(/:\d+$/, "");
}

/** A configured HTTPS name to suggest when this request's address cannot use passkeys. */
export function passkeyAddress(): string | null {
  const configured = process.env.LLV_TS_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password || !relyingPartyFor(url.host, true)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function publicInfo(req: NextRequest): Promise<TeamPublicInfo> {
  const store = existingTeamStore();
  const mode = store?.hasActiveOwner() ? "team" : "solo";
  return {
    mode,
    hostName: requestHostName(req),
    methods: {
      approval: true,
      telegram: mode === "team" ? await telegramBot() : { available: false, botUsername: null },
      passkey: { available: mode === "team" && relyingParty(req) !== null, address: passkeyAddress() },
    },
  };
}
