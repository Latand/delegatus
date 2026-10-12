"use client";

import type { AccountLimits } from "@/hooks/useEngineAccounts";
import type { TFunction } from "@/lib/i18n";
import { quotaReadingFromAccountLimits, reconcileQuotaReadings, weeklyQuota } from "@/lib/rateLimit";

import { barColor } from "./LimitRow";
import { ReserveBar } from "./railFooterDensity";
import { formatResetClock, formatResetEta, windowLabel } from "./rateLimit";

/**
 * What is left of one account's weekly window, read the way the sidebar
 * footer's account lines read it (#2653): the account's own `limits` from
 * `/api/accounts`, reconciled by the same rule, coloured by the same
 * `barColor`. The account pickers draw it beside each account, so a chip and
 * the footer line of the same account always say the same number.
 */
export interface WeeklyLeft {
  /** Percent of the weekly window still left, 0..100. */
  left: number;
  /** The bar's colour: the engine's own while there is headroom, then warning and danger. */
  color: string;
  resetsAt: number | null;
  windowMinutes: number | null;
}

/** Null without a weekly reading: no bar and no percent, never a made-up 0 % or 100 %. */
export function accountWeeklyLeft(limits: AccountLimits | null | undefined, now: number, engineColor: string): WeeklyLeft | null {
  const weekly = weeklyQuota(reconcileQuotaReadings(null, quotaReadingFromAccountLimits(limits), now));
  if (!weekly) return null;
  const left = weekly.percent;
  return { left, color: barColor(left, engineColor), resetsAt: weekly.value.resetsAt, windowMinutes: weekly.value.windowMinutes ?? null };
}

/** The account's accessible weekly reading: «92% of the weekly limit left». */
export function weeklyLeftAria(t: TFunction, weekly: WeeklyLeft): string {
  return t("draft.accountWeeklyLeft", { percent: Math.round(weekly.left) });
}

/** The hover and long-press hint: the window, what is left and when it resets. The chip itself names no reset. */
export function weeklyLeftHint(t: TFunction, weekly: WeeklyLeft, now: number): string {
  return [
    `${windowLabel(t, "weekly", weekly.windowMinutes)} ${t("limits.left")} ${Math.round(weekly.left)}%`,
    weekly.resetsAt === null ? null : t("limits.reset", { eta: formatResetEta(weekly.resetsAt, now), at: formatResetClock(weekly.resetsAt, now) }),
  ].filter(Boolean).join(" · ");
}

/** The percent and its bar, drawn as the footer draws them: the number turns to the bar's colour once 30 % or less is left. */
export function WeeklyMeter({ weekly, barClassName = "w-6", className = "" }: { weekly: WeeklyLeft; barClassName?: string; className?: string }) {
  return (
    <span className={`flex shrink-0 items-center gap-1.5 ${className}`} data-weekly-meter="">
      <span data-weekly-percent="" className="whitespace-nowrap text-[11px] font-bold tabular-nums" style={{ color: weekly.left <= 30 ? weekly.color : "var(--color-primary)" }}>
        {Math.round(weekly.left)}%
      </span>
      <ReserveBar percent={weekly.left} color={weekly.color} className={barClassName} />
    </span>
  );
}

/**
 * A menu row's weekly column, the last thing in the row: every row's percent and bar end on the same edge
 * whatever the row says before it (a check, «ready», «current»), and a row with no reading keeps the room
 * empty, so the state words line up too. `shown` is false when no row of the list has a reading.
 */
export function WeeklyColumn({ weekly, shown }: { weekly: WeeklyLeft | null | undefined; shown: boolean }) {
  if (weekly) return <WeeklyMeter weekly={weekly} className="w-16 justify-end" />;
  return shown ? <span className="w-16 shrink-0" aria-hidden data-weekly-empty="" /> : null;
}
