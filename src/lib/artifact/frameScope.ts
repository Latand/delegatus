import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
 * outside its report's directory.
 *
 * The key lives only in this process: a restart invalidates every scope, and
 * the preview simply mints a new one on its next open.
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

/** `<base64url(dir)>.<expiry>.<signature>` for an absolute directory. */
export function mintFrameScope(directory: string, now: number = Date.now()): string {
  const payload = `${Buffer.from(directory, "utf8").toString("base64url")}.${(now + FRAME_SCOPE_TTL_MS).toString(36)}`;
  return `${payload}.${sign(payload)}`;
}

/** The directory a scope grants, or null when it is forged, altered or expired. */
export function verifyFrameScope(scope: string, now: number = Date.now()): string | null {
  const parts = scope.split(".");
  if (parts.length !== 3) return null;
  const [dir, expiry, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(`${dir}.${expiry}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expiresAt = parseInt(expiry, 36);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  const directory = Buffer.from(dir, "base64url").toString("utf8");
  return directory.startsWith("/") ? directory : null;
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
export const FRAME_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals";
