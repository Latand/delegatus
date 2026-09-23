"use client";

import { type Locale, translate, useLocale } from "@/lib/i18n";
import type { LimitWindow } from "@/lib/types";
import { formatResetClock, formatResetEta } from "./rateLimit";

export function barColor(leftPercent: number, engineColor: string): string {
  if (leftPercent <= 10) return "var(--color-danger)";
  if (leftPercent <= 30) return "var(--color-warning)";
  return engineColor;
}

export function LimitRow({ label, window: value, engineColor, now, staleHint }: {
  label: string;
  window: LimitWindow | null;
  engineColor: string;
  now: number;
  staleHint?: string | null;
}) {
  const { t, locale } = useLocale();
  if (!value) return null;
  const left = Math.max(0, Math.min(100, 100 - value.usedPercent));
  const color = barColor(left, engineColor);
  return (
    <div className="mt-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold text-primary">{label}</span>
        <span className="text-[11px] text-muted">
          {t("limits.left")} <span className={`font-bold tabular-nums ${left <= 30 ? "" : "text-primary"}`} style={left <= 30 ? { color } : undefined}>{Math.round(left)}%</span>
        </span>
      </div>
      <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-sunken">
        <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: Math.max(left, 1.5) + "%", backgroundColor: color }} />
      </div>
      {value.resetsAt || staleHint ? (
        <div className="mt-[3px] text-[10px] leading-none text-muted">
          {value.resetsAt ? t("limits.reset", { eta: formatResetEta(value.resetsAt, now), at: formatResetClock(value.resetsAt, now) }) : null}
          {value.resetsAt && staleHint ? " · " : null}
          {staleHint}
        </div>
      ) : null}
    </div>
  );
}

export function quotaAsOfHint(observedAt: number | null | undefined, locale: Locale): string | null {
  if (observedAt == null) return null;
  return translate(locale, "limits.asOf", { time: new Date(observedAt * 1000).toLocaleTimeString(locale === "uk" ? "uk-UA" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) });
}
