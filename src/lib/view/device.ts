import type { BrowserKind, DeviceKind } from "./types";

/* The device and browser rules, shared by the presence heartbeat (in the
   browser) and the activity ledger (on the server, from a request's
   User-Agent). Pure: no window, no navigator. */

export function detectBrowser(ua: string): BrowserKind {
  const s = ua.toLowerCase();
  if (s.includes("firefox") || s.includes("fxios")) return "firefox";
  /* Edge and other Chromium skins are not "chrome" for our purposes. */
  if (s.includes("edg/") || s.includes("opr/")) return "other";
  if (s.includes("crios") || s.includes("chrome") || s.includes("chromium")) return "chrome";
  /* Chrome's UA also contains "safari", so this must come after the chrome test. */
  if (s.includes("safari")) return "safari";
  return "other";
}

export function detectDeviceKind(ua: string, coarsePointer: boolean, width: number): DeviceKind {
  const s = ua.toLowerCase();
  if (s.includes("ipad") || (s.includes("tablet") && !s.includes("mobi")) || (coarsePointer && width >= 768 && width <= 1280)) return "tablet";
  if (s.includes("mobi") || s.includes("iphone") || s.includes("android") || (coarsePointer && width < 768)) return "mobile";
  return "desktop";
}

/** Where an operator request came from, as far as the server can tell. */
export type RequestSurface = "desktop" | "tablet" | "phone" | "other";

/**
 * The surface of a request, from its User-Agent alone: the server sees no
 * pointer and no viewport, so it applies {@link detectDeviceKind}'s user-agent
 * rules. A caller with no browser user agent (a script calling the
 * same-origin API) is `other`. Delegatus ships no native desktop app, so a
 * desktop browser is the only desktop surface there is.
 */
export function requestSurface(userAgent: string | null | undefined): RequestSurface {
  const ua = userAgent?.trim() ?? "";
  if (!/^mozilla\//i.test(ua)) return "other";
  const kind = detectDeviceKind(ua, false, 0);
  return kind === "mobile" ? "phone" : kind;
}
