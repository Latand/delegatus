"use client";

import type { ReactNode } from "react";

import { DelegatusBadge } from "@/components/brand/BrandMark";
import { useLocale, type Locale } from "@/lib/i18n";

/**
 * The frame of the pages a signed-out person sees (sign-in-and-team §10.1):
 * the canvas, one card, the emblem, and the language switch. No board
 * skeleton and no rail, so nothing of the install shows before sign-in.
 *
 * The switch changes this browser only (`setLocale`). The install's own
 * language is the owner's, written by the toggle inside the app; a visitor
 * who is not signed in does not get to change it.
 */
export function AuthShell({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="h-full overflow-y-auto bg-canvas" data-team-auth={testId}>
      <div className="flex min-h-full flex-col">
        <div className="flex justify-end px-4 pt-3 sm:hidden">
          <LocaleSwitch />
        </div>
        <main className="flex flex-1 items-center justify-center px-4 py-6 sm:py-12">
          <section className="w-full max-w-[400px] rounded-surface bg-card px-6 pb-6 pt-7 sm:border sm:border-border sm:shadow-1 max-sm:px-5">
            <div className="mb-4 flex justify-center">
              <DelegatusBadge size={64} />
            </div>
            {children}
          </section>
        </main>
        <div className="hidden justify-end px-6 pb-5 sm:flex">
          <LocaleSwitch />
        </div>
      </div>
    </div>
  );
}

/* The same small pill on every screen size. On the phone each half keeps a
   44 px touch target through an invisible hit area around it, so the switch
   stays the lightest thing on the page. */
function LocaleSwitch() {
  const { locale, t, setLocale } = useLocale();
  const options: Locale[] = ["en", "uk"];
  return (
    <div role="group" aria-label={t("lang.aria")} className="flex items-center rounded-full border border-border bg-card p-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={locale === option}
          data-team-locale={option}
          onClick={() => setLocale(option)}
          className={`relative min-h-7 rounded-full px-2.5 text-label font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:after:absolute max-sm:after:-inset-x-1.5 max-sm:after:-inset-y-2 max-sm:after:content-[''] ${locale === option ? "bg-sunken text-primary" : "text-muted hover:text-primary"}`}
        >
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function AuthTitle({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="mb-5 text-center">
      <h1 className="text-balance text-title font-bold text-primary">{title}</h1>
      {subtitle ? <p className="mt-1 text-balance text-label text-muted">{subtitle}</p> : null}
    </div>
  );
}

export function AuthError({ text }: { text: string | null }) {
  return text ? <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-ui text-danger">{text}</p> : null;
}
