"use client";

/* The pieces the relay settings (ExternalRelaySection.tsx) and its clone block
   (CloneCreate.tsx) share. The board's own recipes: the seat tick panel's link,
   quiet action, its uppercase section head, and the primary button. Every
   control is 44 px on the phone. */
export const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
export const LINK = `inline-flex items-center gap-0.5 font-semibold text-accent underline-offset-2 hover:underline ${FOCUS}`;
export const QUIET = `inline-flex h-7 items-center gap-1.5 rounded-control px-1 text-ui font-semibold text-secondary hover:text-accent disabled:opacity-50 max-sm:min-h-11 ${FOCUS}`;
export const HEAD = "text-label font-semibold uppercase tracking-wide text-muted";
export const PRIMARY = `inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control bg-brand px-3 text-ui font-semibold text-on-brand shadow-1 hover:opacity-90 disabled:opacity-50 max-sm:h-11 ${FOCUS}`;

export async function call<T>(url: string, method: string, body?: object): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const result = response.status === 204 ? {} : await response.json();
    return response.ok ? { ok: true, value: result as T } : { ok: false, error: typeof result?.error === "string" ? result.error : "unavailable" };
  } catch { return { ok: false, error: "unavailable" }; }
}

/** The status dot of the seat tick panel, with the danger tone a refused pairing needs. */
export function Dot({ tone, className = "" }: { tone: "ok" | "warn" | "danger" | "muted"; className?: string }) {
  const fill = tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warning" : tone === "danger" ? "bg-danger" : "bg-muted";
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${fill} ${className}`} />;
}

export const alertLine = (text: string) => <p role="alert" className="rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-ui leading-4 text-danger">{text}</p>;

/** A relay-provided link is followed only when it is an ordinary web address. */
export function safeLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

export const ownerLine = (owner: { display_name: string; handle: string | null }) => owner.handle ? `${owner.display_name} (${owner.handle})` : owner.display_name;

/**
 * Opens a window while the click that asked for it is still running, which is
 * the only moment a browser lets a window open unasked. The window starts
 * blank and loses its link back to this page; it is pointed at the service's
 * page (a pairing's, or Telegram's for a new clone) once the answer has one.
 * Null when the browser refused.
 */
export function openBlankWindow(text: string): Window | null {
  try {
    const win = window.open("about:blank", "_blank");
    if (!win) return null;
    win.opener = null;
    try { win.document.body.textContent = text; } catch { /* a blank tab is fine */ }
    return win;
  } catch { return null; }
}
