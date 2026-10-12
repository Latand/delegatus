"use client";

import { useNowSeconds } from "@/hooks/useNowSeconds";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { ApiCompanionUsage, CodexCompanionUsage, CompanionPlan, CompanionUsage, PlanWindow } from "@/lib/voiceCompanion/contract";
import { limitResetText } from "@/lib/voiceCompanion/errors";

export const voiceMoney = (usd: number) => usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
export function voiceMonth(locale: string, month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(date) : month;
}
export const spendTone = (spent: number, cap: number) => spent >= cap ? "danger" : spent >= cap * 0.8 ? "warning" : undefined;

/** The selected footer variant on the API: call and month above their shares of the cap. */
function ApiSpend({ usage }: { usage: ApiCompanionUsage }) {
  const { t, locale } = useLocale();
  const values = { usd: voiceMoney(usage.callUsd), month: voiceMonth(locale, usage.month), spent: voiceMoney(usage.monthUsd), cap: voiceMoney(usage.monthCapUsd) };
  const monthShare = usage.monthCapUsd > 0 ? Math.min(1, Math.max(0, usage.monthUsd / usage.monthCapUsd)) : usage.monthUsd > 0 ? 1 : 0;
  const callShare = usage.monthCapUsd > 0 ? Math.min(monthShare, Math.max(0, usage.callUsd / usage.monthCapUsd)) : usage.callUsd > 0 ? monthShare : 0;
  /* The two sums spent carry the weight and the cap stays muted, as variant 2 sets them. Each sum is placed by
     a marker the translation keeps where its own word order puts it. */
  const amounts = (key: MessageKey) => t(key, { ...values, usd: "\u0001usd\u0001", spent: "\u0001spent\u0001", cap: "\u0001cap\u0001" }).split("\u0001")
    .map((part, index) => index % 2 === 0 ? part
      : <span key={index} className={part === "cap" ? "vc-tr-spend-cap" : "vc-tr-spend-value"} data-spend-value={part}>{values[part as "usd" | "spent" | "cap"]}</span>);
  return <div role="group" className="vc-tr-spend" data-companion-spend data-final={usage.callFinal} data-incomplete={usage.callIncomplete}
    aria-label={t(usage.callIncomplete ? "voiceCompanion.spend.labelIncomplete" : "voiceCompanion.spend.label", values)}
    title={usage.callIncomplete ? t("voiceCompanion.spend.incomplete") : undefined}>
    <div className="vc-tr-spend-amounts" data-spend-amounts>
      <span>{amounts(usage.callIncomplete ? "voiceCompanion.spend.callIncomplete" : "voiceCompanion.spend.call")}</span>
      {" "}<span data-tone={spendTone(usage.monthUsd, usage.monthCapUsd)}>{amounts("voiceCompanion.spend.month")}</span>
    </div>
    <div className="vc-tr-spend-meter" data-companion-spend-meter role="meter" aria-label={t("voiceCompanion.spend.month", values)}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={monthShare * 100} aria-valuetext={t("voiceCompanion.spend.month", values)}>
      <span aria-hidden data-spend-month-fill style={{ transform: `scaleX(${monthShare})` }} />
      <span aria-hidden data-spend-call-fill style={{ transform: `scaleX(${callShare})` }} />
    </div>
  </div>;
}

/** A call's length as the clock shows it: 4:12, or 1:02:07 past an hour. */
export function callDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const [hours, minutes, rest] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}
/** The plan type as the accounts panel writes it. */
export const planName = (plan: CompanionPlan) => plan.type ? plan.type.charAt(0).toUpperCase() + plan.type.slice(1) : "Codex";
/** A window named by its length: 5 h, week, day. The number and its unit are joined by a no-break space, so a
 * narrow line never parts them. */
export function windowName(window: PlanWindow, t: TFunction): string {
  const minutes = window.windowMinutes;
  if (minutes === null) return t("voiceCompanion.usage.window");
  if (minutes === 10_080) return t("voiceCompanion.usage.week");
  if (minutes === 1_440) return t("voiceCompanion.usage.day");
  return (minutes % 60 === 0 ? t("voiceCompanion.usage.hours", { n: minutes / 60 }) : t("voiceCompanion.usage.minutes", { n: minutes })).replaceAll(" ", "\u00a0");
}
const percent = (value: number) => `${Math.round(value)}%`;
export const planWindows = (plan: CompanionPlan) => [plan.primary, plan.secondary].filter((window): window is PlanWindow => window !== null);
/** One window's tone: at its limit (or the plan's reached limit on its first window) danger, from 80% a warning. */
export const windowTone = (window: PlanWindow, plan: CompanionPlan) =>
  window.usedPercent >= 100 || (plan.limitReached && window === planWindows(plan)[0]) ? "danger" : window.usedPercent >= 80 ? "warning" : undefined;
export const planTone = (plan: CompanionPlan | null) => !plan ? undefined
  : plan.limitReached || planWindows(plan).some((window) => window.usedPercent >= 100) ? "danger" : (plan.primary?.usedPercent ?? 0) >= 80 ? "warning" : undefined;
/** Every window of the plan in one sentence, each with its reset, for a label or the settings. */
export function planSentence(plan: CompanionPlan, t: TFunction, locale: string, now: number): string {
  return planWindows(plan).map((window) => window.resetsAt === null
    ? t("voiceCompanion.usage.windowLabel", { window: windowName(window, t), used: percent(window.usedPercent) })
    : t("voiceCompanion.usage.windowLabelReset", { window: windowName(window, t), used: percent(window.usedPercent), reset: limitResetText(window.resetsAt, locale === "uk" ? "uk" : "en", now) })).join("; ");
}

/**
 * The selected footer variant (two figures above a thin meter) on Codex: the call's length on the server clock, and the plan window of
 * the Codex account the call runs on. The meter is that window's use; its teal
 * share is the rise since the call started, in the whole percents Codex
 * reports. The window is the whole account's use, its workers included, which
 * the label and the hint say.
 */
function CodexSpend({ usage }: { usage: CodexCompanionUsage }) {
  const { t, locale } = useLocale();
  /* Resets within a day read as a time, later ones as a date; before the clock ticks the reading's own time stands in. */
  const clock = useNowSeconds(60_000);
  const now = clock ? clock * 1000 : usage.plan?.observedAt ?? 0;
  const duration = callDuration(usage.callSeconds);
  const plan = usage.plan;
  const primary = plan?.primary ?? plan?.secondary ?? null;
  const used = primary ? Math.min(1, Math.max(0, primary.usedPercent / 100)) : 0;
  const start = primary && usage.planStartPercent !== null ? Math.min(used, Math.max(0, usage.planStartPercent / 100)) : used;
  const label = plan
    ? t("voiceCompanion.usage.label", { duration, plan: planName(plan), windows: planSentence(plan, t, locale, now) })
    : t("voiceCompanion.usage.labelPending", { duration });
  /* The figures carry the weight, the words keep the footer's tone and the second window is muted, as variant 2
     sets them. Each figure is placed by a marker the translation keeps where its own word order puts it. */
  const figures = (text: string, values: Record<string, string>) => text.split("\u0001").map((part, index) => index % 2 === 0
    ? part : <span key={index} className="vc-tr-spend-value" data-spend-value={part}>{values[part]}</span>);
  const windowText = (window: PlanWindow, first: boolean) => {
    const values = { used: percent(window.usedPercent) };
    const text = window.resetsAt !== null && first
      ? t("voiceCompanion.usage.windowFigureReset", { window: windowName(window, t), used: "\u0001used\u0001", reset: limitResetText(window.resetsAt, locale === "uk" ? "uk" : "en", now) })
      : t("voiceCompanion.usage.windowFigure", { window: windowName(window, t), used: "\u0001used\u0001" });
    return first ? figures(text, values) : <span key="second" className="vc-tr-spend-muted"> · {text.replaceAll("\u0001used\u0001", values.used)}</span>;
  };
  return <div role="group" className="vc-tr-spend" data-companion-spend data-final={usage.callFinal} data-limit={plan?.limitReached ? "" : undefined} aria-label={label}>
    <div className="vc-tr-spend-amounts" data-spend-amounts>
      <span data-spend-call>{figures(t("voiceCompanion.usage.call", { duration: "\u0001duration\u0001" }), { duration })}</span>
      {plan ? <span data-spend-plan data-tone={planTone(plan)} title={t("voiceCompanion.usage.account")}>
        {planName(plan)} · {planWindows(plan).map((window, index) => windowText(window, index === 0))}
      </span> : <span data-spend-plan className="vc-tr-spend-muted">{t("voiceCompanion.usage.pending")}</span>}
    </div>
    <div className="vc-tr-spend-meter" data-companion-spend-meter role="meter" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-valuetext={plan ? planSentence(plan, t, locale, now) : t("voiceCompanion.usage.pending")}>
      <span aria-hidden data-window-fill style={{ transform: `scaleX(${used})` }} />
      <span aria-hidden data-rise-fill style={{ transform: `translateX(${start * 100}%) scaleX(${used - start})` }} />
    </div>
  </div>;
}

/** The footer of the backend the call actually ran on: dollars on the API, the plan window on Codex. */
export function CompanionSpend({ usage }: { usage: CompanionUsage }) {
  return usage.backend === "codex" ? <CodexSpend usage={usage} /> : <ApiSpend usage={usage} />;
}
