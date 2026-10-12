"use client";

import { useLocale } from "@/lib/i18n";

/** When a failed designation happened: one muted line under the banner title, 24-hour in every locale. */
export function FailureTime({ at }: { at?: string }) {
  const { locale } = useLocale();
  const timestamp = Date.parse(at ?? "");
  if (!at || !Number.isFinite(timestamp)) return null;
  const label = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(timestamp);
  return <time dateTime={at} className="mt-0.5 block text-caption text-muted" data-orchestrator-failure-time>{label}</time>;
}
