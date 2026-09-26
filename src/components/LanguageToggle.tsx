"use client";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

/** Compact EN/UK switch in the rail header; persists to localStorage and to
    the operator's server-side setting, which agents read. */
export function LanguageToggle() {
  const { locale, t, chooseLocale } = useLocale();
  const isMobile = useIsMobile();
  const next = locale === "en" ? "uk" : "en";
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-card px-2 text-[10.5px] font-bold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isMobile ? "min-h-11 min-w-11" : "h-[26px]"
      }`}
      title={t("lang.aria")}
      aria-label={t("lang.aria")}
      onClick={() => chooseLocale(next)}
    >
      {locale.toUpperCase()}
    </button>
  );
}
