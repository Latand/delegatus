import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { sessionIsLive } from "@/lib/team/sessions";
import { existingTeamStore } from "@/lib/team/store";

/*
 * Capability for the HTML report frame (/api/artifact/frame/<scope>/<file>).
 *
 * A report needs its relative CSS, images and scripts, and a sandboxed frame
 * loads them from an opaque origin: those requests are cross-site, carry no
 * SameSite cookie and cannot pass the same-origin gate every other route
 * applies. So the frame route authorizes by this token instead. It names ONE
 * directory — the report's own — and is minted only by the same-origin meta
 * read of /api/artifact, so a page that has not been handed a frame URL
 * cannot build one, and a frame that has been handed one reaches nothing
 * outside its report's directory. The signed kind binds the grant to the
 * admission policy that allowed the report.
 *
 * The key lives only in this process: a restart invalidates every scope, and
 * the preview simply mints a new one on its next open.
 * Team scopes also name the minting session. Every file read checks its live
 * membership, revocation and expiry without extending that session's idle age.
 * A solo scope stops working once the installation has an active team owner.
 */

const KEY_SLOT = "__llvArtifactFrameKey";
/** Long enough for a report left open through a working day. */
export const FRAME_SCOPE_TTL_MS = 12 * 60 * 60 * 1000;

function frameKey(): Buffer {
  const slot = globalThis as unknown as Record<string, Buffer | undefined>;
  slot[KEY_SLOT] ??= randomBytes(32);
  return slot[KEY_SLOT]!;
}

function sign(payload: string): string {
  return createHmac("sha256", frameKey()).update(payload).digest("base64url");
}

interface FrameGrant {
  directory: string;
  kind: "project" | "evidence";
  sessionId: string | null;
  workspaceProject: string | null;
}

/** A signed canonical directory, admission kind, expiry and minting session (or `-` for a solo install). */
export function mintFrameScope(directory: string, now: number = Date.now(), sessionId: string | null = null, kind: FrameGrant["kind"] = "project", workspaceProject: string | null = null): string {
  const encodedProject = workspaceProject === null ? "-" : Buffer.from(workspaceProject, "utf8").toString("base64url");
  const payload = `${Buffer.from(directory, "utf8").toString("base64url")}.${(now + FRAME_SCOPE_TTL_MS).toString(36)}.${sessionId ?? "-"}.${kind}.${encodedProject}`;
  return `${payload}.${sign(payload)}`;
}

/** The verified grant, or null when it is forged, altered or expired. */
export function verifyFrameScope(scope: string, now: number = Date.now()): FrameGrant | null {
  const parts = scope.split(".");
  if (parts.length !== 6) return null;
  const [dir, expiry, sessionId, kind, encodedProject, signature] = parts as [string, string, string, string, string, string];
  if (kind !== "project" && kind !== "evidence") return null;
  const expected = Buffer.from(sign(`${dir}.${expiry}.${sessionId}.${kind}.${encodedProject}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expiresAt = parseInt(expiry, 36);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  try {
    const store = existingTeamStore();
    if (sessionId === "-") {
      if (store?.hasActiveOwner()) return null;
    } else {
      const session = store?.session(sessionId);
      if (!session || !sessionIsLive(session, now) || store!.member(session.memberId)?.status !== "active") return null;
    }
  } catch { return null; } // Unreadable authority grants no file access.
  const directory = Buffer.from(dir, "base64url").toString("utf8");
  const workspaceProject = encodedProject === "-" ? null : Buffer.from(encodedProject, "base64url").toString("utf8");
  return path.isAbsolute(directory) || path.win32.isAbsolute(directory)
    ? { directory, kind, sessionId: sessionId === "-" ? null : sessionId, workspaceProject }
    : null;
}

/** The frame URL for `fileName` inside the scoped directory. */
export function frameUrl(scope: string, fileName: string): string {
  return `/api/artifact/frame/${scope}/${encodeURIComponent(fileName)}`;
}

/* Real types for what a report pulls in. The frame is an origin-less sandbox,
   so an executing type here can script only its own frame. */
const FRAME_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
};

export function frameMime(ext: string, fallback: string): string {
  return FRAME_MIME[ext.toLowerCase()] ?? fallback;
}

/**
 * The frame document's policy. `sandbox allow-scripts` without
 * `allow-same-origin` gives the document an opaque origin wherever it is
 * rendered — inside the preview's iframe or opened in its own tab — so its
 * scripts cannot read the viewer's DOM, storage or cookies, and every request
 * it makes to the viewer's API arrives cross-origin and is refused.
 */
export const FRAME_SANDBOX = "allow-scripts";

/** Evidence pages may load only resources routed through their signed directory. */
export function frameCsp(scope: string, origin: string, evidence: boolean): string {
  const sandbox = `sandbox ${FRAME_SANDBOX}`;
  if (!evidence) return sandbox;
  const resourceRoot = `${origin}/api/artifact/frame/${scope}/`;
  return `${sandbox}; default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; script-src ${resourceRoot} 'unsafe-inline'; style-src ${resourceRoot} 'unsafe-inline'; img-src ${resourceRoot} data:; font-src ${resourceRoot} data:; media-src ${resourceRoot}; connect-src ${resourceRoot}`;
}
