"use client";

import { useLocale } from "@/lib/i18n";
import type { CompanionUsage } from "@/lib/voiceCompanion/contract";

export const voiceMoney = (usd: number) => usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
export function voiceMonth(locale: string, month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(date) : month;
}
export const spendTone = (spent: number, cap: number) => spent >= cap ? "danger" : spent >= cap * 0.8 ? "warning" : undefined;

/** Variant 1: the call and month in the transcript's header, including after hangup. */
export function CompanionSpend({ usage }: { usage: CompanionUsage }) {
  const { t, locale } = useLocale();
  const values = { usd: voiceMoney(usage.callUsd), month: voiceMonth(locale, usage.month), spent: voiceMoney(usage.monthUsd), cap: voiceMoney(usage.monthCapUsd) };
  const amounts = (text: string) => text.split(/((?:<)?\$[\d,.]+)/u).map((part, index) => part.includes("$") ? <span className="vc-tr-spend-value" key={index}>{part}</span> : part);
  return <div role="group" className="vc-tr-spend" data-companion-spend data-final={usage.callFinal} data-incomplete={usage.callIncomplete}
    aria-label={t(usage.callIncomplete ? "voiceCompanion.spend.labelIncomplete" : "voiceCompanion.spend.label", values)}
    title={usage.callIncomplete ? t("voiceCompanion.spend.incomplete") : undefined}>
    <span>{amounts(t(usage.callIncomplete ? "voiceCompanion.spend.callIncomplete" : "voiceCompanion.spend.call", values))}</span>
    {" · "}<span data-tone={spendTone(usage.monthUsd, usage.monthCapUsd)}>{amounts(t("voiceCompanion.spend.month", values))}</span>
  </div>;
}
