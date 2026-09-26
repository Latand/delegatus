"use client";

import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Z } from "@/components/layers";
import { useModalLayer } from "@/components/modalLayer";
import { translate, type Locale } from "@/lib/i18n";

/* The team pages' few shared pieces. Every class is one the rest of the
   Viewer already uses (docs/design/viewer-design-system.md): one brand-filled
   action per screen, outlined secondary, text tertiary, the two radii. */

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export const BUTTON = {
  primary: `inline-flex h-10 items-center justify-center gap-2 rounded-control bg-brand px-4 text-ui font-semibold text-on-brand hover:opacity-90 disabled:opacity-50 max-sm:h-12 ${FOCUS}`,
  secondary: `inline-flex h-10 items-center justify-center gap-2 rounded-control border border-border bg-card px-4 text-ui font-semibold text-primary hover:border-strong hover:bg-sunken disabled:opacity-50 max-sm:h-12 ${FOCUS}`,
  text: `inline-flex min-h-8 items-center justify-center gap-1.5 rounded-control px-2 text-ui font-semibold text-secondary hover:text-primary disabled:opacity-50 max-sm:min-h-11 ${FOCUS}`,
  small: `inline-flex h-8 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-semibold text-primary hover:border-strong hover:bg-sunken disabled:opacity-50 max-sm:h-11 ${FOCUS}`,
  smallPrimary: `inline-flex h-8 items-center justify-center gap-1.5 rounded-control bg-brand px-3 text-ui font-semibold text-on-brand hover:opacity-90 disabled:opacity-50 max-sm:h-11 ${FOCUS}`,
  danger: `inline-flex h-8 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-semibold text-danger hover:border-danger/50 hover:bg-danger-soft disabled:opacity-50 max-sm:h-11 ${FOCUS}`,
} as const;

export const INPUT = `h-10 w-full rounded-control border border-border bg-canvas px-3 text-body text-primary outline-none placeholder:text-muted max-sm:h-12 ${FOCUS}`;

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label font-semibold text-secondary">{label}</span>
      {children}
      {hint ? <span className="text-caption leading-snug text-muted">{hint}</span> : null}
    </label>
  );
}

export type ApiAnswer<T> = { ok: true; body: T } | { ok: false; status: number; error: string; code: string | null };

/** JSON to a team route. Never throws: a network failure is an answer too. */
export async function teamRequest<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<ApiAnswer<T>> {
  try {
    const response = await fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
        code: typeof body.code === "string" ? body.code : null,
      };
    }
    return { ok: true, body: body as T };
  } catch {
    return { ok: false, status: 0, error: "network", code: "network" };
  }
}

function intlLocale(locale: Locale): string {
  return locale === "uk" ? "uk-UA" : "en-GB";
}

/** "2 min ago", "in 6 days": the nearest whole unit. Under a minute it is
    "just now": Intl's "now" reads as a contradiction beside a past-tense verb
    ("був(ла) зараз"). `long` spells the unit out, for a sentence that ends
    after the value, where the short "7 дн." would double the full stop. */
export function relativeTime(iso: string | null | undefined, locale: Locale, nowMs = Date.now(), style: "short" | "long" = "short"): string {
  if (!iso) return "";
  const deltaS = (Date.parse(iso) - nowMs) / 1000;
  if (!Number.isFinite(deltaS)) return "";
  const format = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto", style });
  const abs = Math.abs(deltaS);
  if (abs < 45) return translate(locale, "team.time.justNow");
  if (abs < 45 * 60) return format.format(Math.round(deltaS / 60), "minute");
  if (abs < 22 * 3600) return format.format(Math.round(deltaS / 3600), "hour");
  return format.format(Math.round(deltaS / 86400), "day");
}

export function clockTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function dayHeading(iso: string, locale: Locale, today: string, yesterday: string, nowMs = Date.now()): string {
  const date = new Date(iso);
  const key = (value: Date) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  if (key(date) === key(new Date(nowMs))) return today;
  if (key(date) === key(new Date(nowMs - 86_400_000))) return yesterday;
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: "long", day: "numeric", month: "long" }).format(date);
}

/** A dialog over the Team page: centred on the desktop, a bottom sheet on
    the phone. Escape, the scrim and × close it; Tab stays inside. */
export function TeamDialog({ title, onClose, children, closeLabel, testId }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeLabel: string;
  testId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalLayer({ containerRef: ref, onClose });
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={`fixed inset-0 ${Z.modal} flex items-end justify-center bg-black/35 sm:items-center sm:p-6`} onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-team-dialog={testId}
        className="flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-surface border border-border bg-card shadow-2 outline-none sm:max-w-[480px] sm:rounded-surface"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 max-sm:py-1.5">
          <h2 className="min-w-0 flex-1 truncate text-title font-bold text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label={closeLabel} className={`flex h-8 w-8 items-center justify-center rounded-control text-secondary hover:bg-sunken hover:text-primary max-sm:h-11 max-sm:w-11 ${FOCUS}`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4 pb-[max(16px,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
