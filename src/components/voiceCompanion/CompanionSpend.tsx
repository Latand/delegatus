"use client";

import { useLocale, type MessageKey } from "@/lib/i18n";
import type { CompanionUsage } from "@/lib/voiceCompanion/contract";

export const voiceMoney = (usd: number) => usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
export function voiceMonth(locale: string, month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(date) : month;
}
export const spendTone = (spent: number, cap: number) => spent >= cap ? "danger" : spent >= cap * 0.8 ? "warning" : undefined;

/** The selected footer variant: call and month above their shares of the cap. */
export function CompanionSpend({ usage }: { usage: CompanionUsage }) {
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
