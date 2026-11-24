"use client";

import { useLocale } from "@/lib/i18n";
import type { EngineLimits, LimitsProvenance } from "@/lib/types";

import { barColor, LimitWindowLine, quotaAsOfHint } from "./LimitRow";
import { windowLabel } from "./rateLimit";
import { LINE_EDGE, ReserveBar, type SidebarFooterDensity } from "./railFooterDensity";
import { engineTintOf } from "./utils";

/**
 * Antigravity CLI quota row in the sidebar footer (docs/design/antigravity-engine.md §3.6).
 *
 * Antigravity exposes quota state when a 5-hour window is exhausted (`RESOURCE_EXHAUSTED`).
 * The row appears when an active session quota reading is present and disappears cleanly
 * once the reset window elapses.
 */
export function AntigravityFooterRow({ limits, limitsAccountId, now, provenance, density }: {
  density: SidebarFooterDensity;
  limits: EngineLimits | null;
  limitsAccountId: string | null;
  now: number;
  provenance?: LimitsProvenance;
}) {
  const { t, locale } = useLocale();
  const session = limits?.session ?? null;
  if (!session || !limitsAccountId) return null;
  if (session.resetsAt !== null && session.resetsAt <= now) return null;

  const tint = engineTintOf("antigravity");
  const left = Math.max(0, Math.min(100, 100 - session.usedPercent));
  const color = barColor(left, tint.color);
  const label = windowLabel(t, "session", session.windowMinutes);
  const summary = [
    "Antigravity",
    limits?.plan ?? null,
    `${label} ${t("limits.left")} ${Math.round(left)}%`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="relative" data-engine-limits="antigravity" data-limits-source={provenance?.source ?? "transcript"}>
      <div
        data-meter-line=""
        title={summary}
        className={`flex h-[26px] w-full items-center gap-1.5 ${LINE_EDGE} text-left`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span data-meter-name="" className="min-w-0 truncate text-[11.5px] font-semibold text-primary">Antigravity</span>
          <span role="img" aria-label="Antigravity" title="Antigravity" className="grid h-3 w-3 shrink-0 place-items-center">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tint.color }} />
          </span>
        </span>
        <span data-meter-value="" className="shrink-0 text-[11px] tabular-nums text-muted">
          {t("limits.left")} <span className="font-bold text-primary">{Math.round(left)}%</span>
        </span>
        <ReserveBar percent={left} color={color} />
      </div>
      {density === "detail" ? (
        <div data-limits-windows="" className={`${LINE_EDGE} pb-1`}>
          {limits?.plan ? (
            <span data-meter-note="" className="-mt-0.5 block truncate pb-0.5 text-[10px] leading-[13px] text-muted">
              Antigravity · {limits.plan}
            </span>
          ) : null}
          <LimitWindowLine
            label={label}
            window={session}
            engineColor={tint.color}
            now={now}
            staleHint={session.observedAt != null && now - session.observedAt > 300 ? quotaAsOfHint(session.observedAt, locale) : null}
          />
        </div>
      ) : null}
    </div>
  );
}
