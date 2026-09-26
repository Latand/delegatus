import crypto from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";

import { detectBrowser, requestSurface } from "@/lib/view/device";

import type { Member, MemberSession, SessionBrowser, SessionSurface, SignInMethod, TeamMode } from "./contract";
import { existingTeamStore, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, type TeamStore } from "./store";

/*
 * Member sessions (§3.2). The cookie holds 32 random bytes; the store holds
 * their sha256. A session is live while it is unrevoked, within its absolute
 * lifetime and used within the idle window, and while its member is active.
 * Every check reads the row, so a revocation takes effect on the next request.
 */

export const MEMBER_COOKIE = "llv_member";
const TOUCH_EVERY_MS = 60_000;

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

type RequestLike = Pick<NextRequest, "headers" | "cookies">;

export function requestDevice(req: Pick<NextRequest, "headers">): { surface: SessionSurface; browser: SessionBrowser } {
  const ua = req.headers.get("user-agent") ?? "";
  const lower = ua.toLowerCase();
  const browser: SessionBrowser = lower.includes("edg/") ? "edge" : detectBrowser(ua);
  return { surface: requestSurface(ua), browser };
}

/** Whether the request arrived over HTTPS, as the perimeter cookie decides it. */
export function requestIsHttps(req: Pick<NextRequest, "headers"> & { nextUrl?: URL }): boolean {
  return req.headers.get("x-forwarded-proto") === "https" || req.nextUrl?.protocol === "https:";
}

/** The mode this process reads right now. Never creates the store. */
export function teamMode(): TeamMode {
  const store = existingTeamStore();
  return store?.hasActiveOwner() ? "team" : "solo";
}

export interface LiveSession {
  session: MemberSession;
  member: Member;
}

export function sessionIsLive(session: MemberSession, nowMs: number): boolean {
  if (session.revokedAt) return false;
  if (Date.parse(session.expiresAt) <= nowMs) return false;
  return nowMs - Date.parse(session.lastSeenAt) < SESSION_IDLE_MS;
}

/** The live session a cookie value names, touching it at most once a minute. */
export function verifySessionValue(store: TeamStore, value: string | undefined | null, nowMs = Date.now()): LiveSession | null {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const session = store.session(sha256Hex(value));
  if (!session || !sessionIsLive(session, nowMs)) return null;
  const member = store.member(session.memberId);
  if (!member || member.status !== "active") return null;
  if (nowMs - Date.parse(session.lastSeenAt) >= TOUCH_EVERY_MS) {
    try {
      store.touchSession(session.id, new Date(nowMs).toISOString());
    } catch {
      /* a busy store must not sign anyone out; the next request touches it */
    }
  }
  return { session, member };
}

/** The live session of a request's cookie, or null (no store, no cookie, dead). */
export function requestSession(req: RequestLike, nowMs = Date.now()): LiveSession | null {
  const store = existingTeamStore();
  if (!store) return null;
  return verifySessionValue(store, req.cookies.get(MEMBER_COOKIE)?.value, nowMs);
}

/** Mints a new session. The cookie value is returned once and never stored. */
export function mintSession(
  store: TeamStore,
  memberId: string,
  method: SignInMethod,
  device: { surface: SessionSurface; browser: SessionBrowser },
  nowMs = Date.now(),
): { value: string; session: MemberSession } {
  const value = randomToken(32);
  const now = new Date(nowMs).toISOString();
  const session: MemberSession = {
    id: sha256Hex(value),
    memberId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(nowMs + SESSION_ABSOLUTE_MS).toISOString(),
    surface: device.surface,
    browser: device.browser,
    method,
    revokedAt: null,
  };
  store.insertSession(session);
  store.pruneSessions(nowMs);
  return { value, session };
}

export function setSessionCookie(response: NextResponse, value: string, secure: boolean): void {
  response.cookies.set({
    name: MEMBER_COOKIE,
    value,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    secure,
  });
}

export function clearSessionCookie(response: NextResponse, secure: boolean): void {
  response.cookies.set({ name: MEMBER_COOKIE, value: "", httpOnly: true, sameSite: "lax", path: "/", maxAge: 0, secure });
}
