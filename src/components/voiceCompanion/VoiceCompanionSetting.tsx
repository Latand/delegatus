"use client";

import { useEffect, useId, useState, type ChangeEvent, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { Z } from "@/components/layers";
import { useVoiceCompanionSettings } from "@/hooks/useVoiceCompanionSettings";
import { useLocale } from "@/lib/i18n";
import { companionErrorMessage } from "@/lib/voiceCompanion/errors";

import { spendTone, voiceMoney, voiceMonth } from "./CompanionSpend";
import { COMPANION_SETTINGS_EVENT } from "./hostSurfaces";

export const OPEN_VOICE_COMPANION_SETTINGS_EVENT = "delegatus:open-voice-companion-settings";
/** Opens the voice companion's settings: the header menu's Settings row and the companion's own failure notice. */
export const openVoiceCompanionSettings = () => window.dispatchEvent(new Event(OPEN_VOICE_COMPANION_SETTINGS_EVENT));

/**
 * The dialog behind «Voice Delegatus» on the header menu's Settings page, like
 * the install ping's beside it. It reads nothing until it is opened; the rows
 * inside read the settings while they are shown.
 */
export function VoiceCompanionSettingsHost() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_VOICE_COMPANION_SETTINGS_EVENT, show);
    return () => window.removeEventListener(OPEN_VOICE_COMPANION_SETTINGS_EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className={`fixed inset-0 ${Z.overlay} flex items-center justify-center bg-black/40 p-4`} onClick={() => setOpen(false)}>
      <section data-voice-companion-settings="" role="dialog" aria-modal="true" aria-labelledby="voice-companion-settings-title" className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-canvas p-5 text-primary shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-4"><h2 id="voice-companion-settings-title" className="text-lg font-semibold">{t("voiceCompanion.settings.label")}</h2><button type="button" autoFocus className="min-h-11 px-2" onClick={() => setOpen(false)}>{t("telemetry.close")}</button></div>
        <VoiceCompanionSetting />
      </section>
    </div>,
    document.body,
  );
}

/**
 * The voice companion's rows in its settings dialog (#2519 D): the switch, the
 * OpenAI key, and the monthly cap with the month's usage. On is the real voice;
 * there is no other backend to choose.
 *
 * The key field is write-only. What is typed goes to the Viewer once and is
 * cleared here; nothing ever comes back but where a key is taken from (a saved
 * file, the environment, nowhere), so there is no value to show or to reveal.
 */
export function VoiceCompanionSetting() {
  const { t, locale } = useLocale();
  const { settings, busy, error, update, saveKey } = useVoiceCompanionSettings(true);
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  /* What is being typed into the cap; null shows the saved one. */
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const ids = { key: useId(), keyHint: useId(), cap: useId(), capHint: useId() };
  const speech = locale === "uk" ? "uk" as const : "en" as const;
  const announce = () => window.dispatchEvent(new Event(COMPANION_SETTINGS_EVENT));
  const change = async (value: Parameters<typeof update>[0]) => { if (await update(value)) announce(); };
  const submitKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setKeySaved(false);
    const saved = await saveKey(key.trim());
    /* Cleared whatever the answer: a refused key is typed again, never kept in the page. */
    setKey("");
    if (saved) { setKeySaved(true); announce(); }
  };
  const commitCap = async () => {
    if (capDraft === null || !settings) return;
    const value = Number(capDraft.replace(",", "."));
    setCapDraft(null);
    if (capDraft.trim() === "" || !Number.isFinite(value) || value < 0 || value === settings.monthlyCapUsd) return;
    await change({ monthlyCapUsd: Math.round(value * 100) / 100 });
  };
  const money = voiceMoney;
  const lastCall = settings?.lastSession;
  const lastCallDuration = lastCall ? `${Math.floor(lastCall.seconds / 60)}:${String(Math.floor(lastCall.seconds % 60)).padStart(2, "0")}` : "";
  const lastCallDate = lastCall ? new Intl.DateTimeFormat(locale, { day: "numeric", month: speech === "uk" ? "long" : "short", timeZone: "UTC" }).format(new Date(lastCall.endedAt)) : "";
  const fromEnvironment = settings?.keySource === "env";
  /* The masked field holds what is being typed and nothing else: no saved key is ever put into it. */
  const typed = { type: "password", value: key, onChange: (event: ChangeEvent<HTMLInputElement>) => { setKey(event.target.value); setKeySaved(false); } } as const;
  const field = "min-h-9 w-full min-w-0 rounded-[8px] border border-border bg-well px-2.5 text-[13px] text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-55";
  return (
    <div className="mt-4" data-voice-companion-setting>
      <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-semibold">
        {t("voiceCompanion.settings.enable")}
        <input type="checkbox" role="switch" aria-label={t("voiceCompanion.settings.enable")} data-voice-companion-enable checked={settings?.enabled ?? false} disabled={busy || !settings} onChange={(event) => void change({ enabled: event.target.checked })} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
      </label>
      <p className="text-[13px] leading-relaxed text-muted">{t("voiceCompanion.settings.explanation")}</p>
      {settings?.enabled ? (
        <div className="mt-3 flex flex-col gap-4">
          <form className="min-w-0" onSubmit={(event) => void submitKey(event)} data-voice-companion-key data-key-source={settings.keySource}>
            <label htmlFor={ids.key} className="text-[13px] font-semibold text-primary">{t("voiceCompanion.settings.key")}</label>
            <div className="mt-1.5 flex gap-2">
              <input id={ids.key} {...typed} disabled={busy || fromEnvironment}
                autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-1p-ignore="" data-lpignore="true" aria-describedby={ids.keyHint}
                placeholder={t(settings.keySource === "file" ? "voiceCompanion.settings.key.replace" : "voiceCompanion.settings.key.placeholder")} className={field} />
              <button type="submit" disabled={busy || fromEnvironment || !key.trim()} className="min-h-9 shrink-0 rounded-[8px] border border-border px-3 text-[13px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45">{t("voiceCompanion.settings.key.save")}</button>
            </div>
            <p id={ids.keyHint} role="status" className="mt-1.5 text-[12px] leading-snug text-muted" data-voice-companion-key-status>
              <span className={settings.keySource === "missing" ? "" : "font-semibold text-primary"}>{keySaved ? t("voiceCompanion.settings.key.saved") : t(`voiceCompanion.settings.key.${settings.keySource}`)}</span>{" "}
              {fromEnvironment ? null : t("voiceCompanion.settings.key.kept")}
            </p>
          </form>
          <div className="min-w-0" data-voice-companion-cap>
            <label htmlFor={ids.cap} className="text-[13px] font-semibold text-primary">{t("voiceCompanion.settings.cap")}</label>
            <div className="mt-1.5 flex items-center gap-2">
              <span aria-hidden className="text-[13px] text-muted">$</span>
              <input id={ids.cap} type="text" inputMode="decimal" value={capDraft ?? String(settings.monthlyCapUsd)} disabled={busy} aria-describedby={ids.capHint}
                onChange={(event) => setCapDraft(event.target.value)} onBlur={() => void commitCap()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitCap(); } }}
                className={`${field} max-w-28 tabular-nums`} />
            </div>
            <p id={ids.capHint} role="status" className="mt-1.5 text-[12px] leading-snug text-muted tabular-nums" data-voice-companion-usage style={{ color: spendTone(settings.usageUsd, settings.monthlyCapUsd) ? `var(--color-${spendTone(settings.usageUsd, settings.monthlyCapUsd)})` : undefined }}>
              {t("voiceCompanion.settings.usage", { month: voiceMonth(locale, settings.month), spent: money(settings.usageUsd), cap: money(settings.monthlyCapUsd) })}
              {settings.reservedUsd > 0 ? ` ${t("voiceCompanion.settings.reserved", { held: money(settings.reservedUsd) })}` : ""}
            </p>
            {lastCall ? <p className="mt-1 text-[12px] leading-snug text-muted tabular-nums" data-voice-companion-last-call title={lastCall.incomplete ? t("voiceCompanion.spend.incomplete") : undefined}>
              {t(lastCall.incomplete ? "voiceCompanion.settings.lastCallIncomplete" : "voiceCompanion.settings.lastCall", { usd: money(lastCall.usd), duration: lastCallDuration, date: lastCallDate })}
            </p> : null}
            {settings.incomplete ? <p className="mt-1 text-[12px] leading-snug text-muted">{companionErrorMessage("FINALIZATION_INCOMPLETE", speech)}</p> : null}
            {settings.uncertainSession ? (
              <div className="mt-2 flex flex-col items-start gap-1.5" data-voice-companion-uncertain>
                <p role="alert" className="text-[12px] leading-snug text-danger">{companionErrorMessage("MINT_UNCERTAIN", speech)}</p>
                <button type="button" disabled={busy} onClick={() => void change({ releaseUncertainSession: true })} className="min-h-9 rounded-[8px] border border-border px-3 text-[13px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45">{t("voiceCompanion.settings.uncertain.release")}</button>
              </div>
            ) : null}
            {settings.usageUsd + settings.reservedUsd >= settings.monthlyCapUsd ? <p className="mt-1 text-[12px] leading-snug text-danger">{companionErrorMessage("CAP_REACHED", speech)}</p> : null}
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-3 text-[13px] text-danger" data-voice-companion-setting-error={error}>{companionErrorMessage(error, speech)}</p> : null}
    </div>
  );
}
