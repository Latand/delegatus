"use client";

import type { AsksYouSettingView } from "@/lib/asks/types";
import { useLocale, type TFunction } from "@/lib/i18n";

import { useAsksYouSetting } from "./asksYouSetting";
import { ProjectSettingRow } from "./ProjectSettingRow";

/** Dollars as the operator reads them; a spend under a cent says so. */
export function usd(amount: number, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount > 0 && amount < 0.01 ? `<${format.format(0.01)}` : format.format(amount);
}

/** The row's one muted line: what turning it on sends where, and the spend. */
export function asksYouHint(t: TFunction, view: AsksYouSettingView | null, locale: string, failed: boolean): string {
  if (failed) return t("asksYou.failed");
  if (!view) return t("asksYou.off");
  if (!view.keySource) return t("asksYou.noKey", { path: view.keyPath });
  if (!view.enabled) return t("asksYou.off");
  const values = { spent: usd(view.spentUsd, locale), cap: usd(view.capUsd, locale) };
  return view.capped > 0 || view.spentUsd >= view.capUsd ? t("asksYou.capped", values) : t("asksYou.on", values);
}

/*
 * "Asks you" (docs/research/attention-classifier.md §7): whether each agent's
 * turn-ending message goes to the classifier, for the whole installation. Off
 * by default; the hint says what leaves the machine and this month's spend. It
 * sits beside the project's switches in the board's ⋯ menu and the phone's ⋯
 * sheet. Without an OpenRouter key it cannot be turned on, and says where the
 * key goes.
 */
export function AsksYouRow({ variant, initial }: {
  variant: "menu" | "sheet" | "inline";
  /** A known answer, drawn without a read (the evidence drivers pass one). */
  initial?: AsksYouSettingView;
}) {
  const { t, locale } = useLocale();
  const setting = useAsksYouSetting(initial);
  const view = setting.view;
  const enabled = view?.enabled === true;
  return (
    <ProjectSettingRow
      label={t("asksYou.label")}
      hint={asksYouHint(t, view, locale, setting.failed)}
      enabled={enabled}
      disabled={!view || setting.saving || (!enabled && !view.keySource)}
      failed={setting.failed}
      variant={variant}
      rowProps={{ "data-asks-you": view === null ? undefined : enabled ? "on" : "off" }}
      switchProps={{ "data-asks-you-switch": "", onClick: setting.toggle }}
    />
  );
}
