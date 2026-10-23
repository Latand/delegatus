"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { onOpenKeys, openKeys } from "@/components/keys/openKeys";
import { Z } from "@/components/layers";
import { useNowSeconds } from "@/hooks/useNowSeconds";
import { useVoiceCompanionSettings } from "@/hooks/useVoiceCompanionSettings";
import { useLocale } from "@/lib/i18n";
import { companionErrorMessage, limitResetText } from "@/lib/voiceCompanion/errors";

import { callDuration, planName, planTone, planWindows, spendTone, voiceMoney, voiceMonth, windowName, windowTone } from "./CompanionSpend";
import { CallMemorySetting } from "./CallMemorySetting";
import { VoiceDevicesSetting } from "./VoiceDevicesSetting";
import { VoiceToolsSetting } from "./VoiceToolsSetting";
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
    /* «Open Keys» on the OpenAI key hands the screen to the menu's «Keys» page. */
    const stopKeys = onOpenKeys(() => setOpen(false));
    return () => { stopKeys(); window.removeEventListener(OPEN_VOICE_COMPANION_SETTINGS_EVENT, show); };
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
        <VoiceToolsSetting />
      </section>
    </div>,
    document.body,
  );
}

/**
 * The voice companion's rows in its settings dialog (#2519 D): the switch and,
 * while it is on, how the voice talks. Through the API it needs the OpenAI key
 * and keeps the monthly cap with the month's usage; on Codex V3 it runs on a
 * managed account's subscription, and the rows show the last call with that
 * account's plan window and ask for no key. The API is the default.
 *
 * The OpenAI key is entered in «Keys» (docs/design/keys-settings.md §4):
 * this row says where the key is taken from (a saved file, the environment,
 * nowhere) and opens «Keys» on it.
 */
export function VoiceCompanionSetting() {
  const { t, locale } = useLocale();
  const { settings, busy, error, update } = useVoiceCompanionSettings(true);
  /* What is being typed into the cap; null shows the saved one. */
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const ids = { cap: useId(), capHint: useId(), backend: useId() };
  const speech = locale === "uk" ? "uk" as const : "en" as const;
  const announce = () => window.dispatchEvent(new Event(COMPANION_SETTINGS_EVENT));
  /* A refusal reads beside the control that was pressed, so it is in view where the person's eyes are. */
  const [pressed, setPressed] = useState<"enabled" | "backend" | "cap" | "callMemory" | "release" | null>(null);
  const change = async (value: Parameters<typeof update>[0], control: NonNullable<typeof pressed>) => { setPressed(control); if (await update(value)) announce(); };
  const refusal = (control: typeof pressed) => error && pressed === control ? <p role="alert" className="mt-1.5 text-[13px] text-danger" data-voice-companion-setting-error={error}>{companionErrorMessage(error, speech)}</p> : null;
  const commitCap = async () => {
    if (capDraft === null || !settings) return;
    const value = Number(capDraft.replace(",", "."));
    setCapDraft(null);
    if (capDraft.trim() === "" || !Number.isFinite(value) || value < 0 || value === settings.monthlyCapUsd) return;
    await change({ monthlyCapUsd: Math.round(value * 100) / 100 }, "cap");
  };
  const money = voiceMoney;
  const lastCall = settings?.lastSession;
  const lastCallDuration = lastCall ? `${Math.floor(lastCall.seconds / 60)}:${String(Math.floor(lastCall.seconds % 60)).padStart(2, "0")}` : "";
  const lastCallDate = lastCall ? new Intl.DateTimeFormat(locale, { day: "numeric", month: speech === "uk" ? "long" : "short", timeZone: "UTC" }).format(new Date(lastCall.endedAt)) : "";
  const codexCall = settings?.lastCodexSession;
  const plan = codexCall?.plan ?? null;
  const clock = useNowSeconds(60_000);
  const now = clock ? clock * 1000 : plan?.observedAt ?? 0;
  const codexCallDate = codexCall ? new Intl.DateTimeFormat(locale, { day: "numeric", month: speech === "uk" ? "long" : "short" }).format(new Date(codexCall.endedAt)) : "";
  const readAt = plan ? new Intl.DateTimeFormat(locale, now - plan.observedAt < 86_400_000 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(plan.observedAt)) : "";
  const tone = planTone(plan);
  const field = "min-h-9 w-full min-w-0 rounded-[8px] border border-border bg-well px-2.5 text-[13px] text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-55";
  return (
    <div className="mt-4" data-voice-companion-setting>
      <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-semibold">
        {t("voiceCompanion.settings.enable")}
        <input type="checkbox" role="switch" aria-label={t("voiceCompanion.settings.enable")} data-voice-companion-enable checked={settings?.enabled ?? false} disabled={busy || !settings} onChange={(event) => void change({ enabled: event.target.checked }, "enabled")} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
      </label>
      <p className="text-[13px] leading-relaxed text-muted">{t("voiceCompanion.settings.explanation")}</p>
      {refusal("enabled")}
      {settings?.enabled ? (
        <div className="mt-3 flex flex-col gap-3">
          {/* The two ways a call can talk, as the voice step of onboarding chooses a dictation backend: what the
              choice needs opens under the option chosen, so the key and the cap show only for the API. */}
          <div role="radiogroup" aria-label={t("voiceCompanion.settings.backend")} data-voice-companion-backend={settings.backend} className="flex flex-col overflow-hidden rounded-[12px] border border-border">
            {(["api", "codex"] as const).map((backend) => {
              const selected = settings.backend === backend;
              return (
                <div key={backend} data-voice-backend={backend} data-selected={selected ? "" : undefined} className={`flex min-w-0 flex-col gap-3 border-b border-border px-3 py-2.5 last:border-b-0 ${selected ? "bg-accent-soft/40" : "bg-card"}`}>
                  <label className="flex min-h-6 cursor-pointer items-center gap-2.5 max-sm:min-h-9">
                    <input type="radio" name={ids.backend} value={backend} checked={selected} disabled={busy} onChange={() => void change({ backend }, "backend")} className="h-4 w-4 shrink-0 accent-[var(--color-accent)] max-sm:h-5 max-sm:w-5" />
                    <span className="text-[13px] font-semibold text-primary">{t(backend === "api" ? "voiceCompanion.settings.backend.api" : "voiceCompanion.settings.backend.codex")}</span>
                  </label>
                  {selected && backend === "api" ? (
                    <div className="flex min-w-0 flex-col gap-4 pl-[26px] max-sm:pl-0">
                      <div className="min-w-0" data-voice-companion-key data-key-source={settings.keySource}>
                        <p className="text-[13px] font-semibold text-primary">{t("voiceCompanion.settings.key")}</p>
                        <p role="status" className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-snug text-muted" data-voice-companion-key-status>
                          <span className={settings.keySource === "missing" ? "" : "font-semibold text-primary"}>{t(`voiceCompanion.settings.key.${settings.keySource}`)}</span>
                          <span aria-hidden>·</span>
                          <button type="button" data-voice-companion-open-keys="" onClick={() => openKeys("openai")} className="min-h-9 rounded-[6px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11">{t("keys.open")}</button>
                        </p>
                      </div>
                      <div className="min-w-0" data-voice-companion-cap>
                        <label htmlFor={ids.cap} className="text-[13px] font-semibold text-primary">{t("voiceCompanion.settings.cap")}</label>
                        <div className="mt-1.5 flex items-center gap-2">
                          <span aria-hidden className="text-[13px] text-muted">$</span>
                          <input id={ids.cap} type="text" inputMode="decimal" value={capDraft ?? String(settings.monthlyCapUsd)} disabled={busy} aria-describedby={ids.capHint}
                            onChange={(event) => setCapDraft(event.target.value)} onBlur={() => void commitCap()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commitCap(); } }}
                            className={`${field} max-w-28 tabular-nums`} />
                        </div>
                        {refusal("cap")}
                        <p id={ids.capHint} role="status" className="mt-1.5 text-[12px] leading-snug text-muted tabular-nums" data-voice-companion-usage style={{ color: spendTone(settings.usageUsd, settings.monthlyCapUsd) ? `var(--color-${spendTone(settings.usageUsd, settings.monthlyCapUsd)})` : undefined }}>
                          {t("voiceCompanion.settings.usage", { month: voiceMonth(locale, settings.month), spent: money(settings.usageUsd), cap: money(settings.monthlyCapUsd) })}
                          {settings.reservedUsd > 0 ? ` ${t("voiceCompanion.settings.reserved", { held: money(settings.reservedUsd) })}` : ""}
                        </p>
                        {lastCall ? <p className="mt-1 text-[12px] leading-snug text-muted tabular-nums" data-voice-companion-last-call title={lastCall.incomplete ? t("voiceCompanion.spend.incomplete") : undefined}>
                          {t(lastCall.incomplete ? "voiceCompanion.settings.lastCallIncomplete" : "voiceCompanion.settings.lastCall", { usd: money(lastCall.usd), duration: lastCallDuration, date: lastCallDate })}
                        </p> : null}
                        {settings.incomplete ? <p className="mt-1 text-[12px] leading-snug text-muted">{companionErrorMessage("FINALIZATION_INCOMPLETE", speech)}</p> : null}
                        {settings.usageUsd + settings.reservedUsd >= settings.monthlyCapUsd ? <p className="mt-1 text-[12px] leading-snug text-danger">{companionErrorMessage("CAP_REACHED", speech)}</p> : null}
                      </div>
                    </div>
                  ) : null}
                  {selected && backend === "codex" ? (
                    <div className="flex min-w-0 flex-col gap-1 pl-[26px] max-sm:pl-0" data-voice-companion-codex>
                      <p className="text-[12px] leading-snug text-muted tabular-nums" data-voice-companion-last-call>
                        {codexCall ? t("voiceCompanion.settings.lastCodexCall", { duration: callDuration(codexCall.seconds), date: codexCallDate }) : t("voiceCompanion.settings.noCall")}
                      </p>
                      {/* The plan as the footer sets it: one short line a window with its figure emphasised, the
                          whole-account note once above them and the reading time muted below. */}
                      {plan ? <div className="mt-1 flex flex-col gap-0.5 tabular-nums" data-voice-companion-plan data-tone={tone}>
                        <p className="text-[12px] leading-snug text-muted">{t("voiceCompanion.settings.planHead", { plan: planName(plan) })}</p>
                        {planWindows(plan).map((window, index) => {
                          const used = `${Math.round(window.usedPercent)}%`;
                          const figureTone = windowTone(window, plan);
                          const text = window.resetsAt === null
                            ? t("voiceCompanion.usage.windowFigure", { window: windowName(window, t), used: "\u0001" })
                            : t("voiceCompanion.usage.windowFigureReset", { window: windowName(window, t), used: "\u0001", reset: limitResetText(window.resetsAt, speech, now) });
                          return <p key={index} className="text-[13px] leading-snug text-secondary" data-plan-window>
                            {text.split("\u0001").map((part, at) => at === 0 ? part : [<span key="figure" className="font-semibold text-primary" data-plan-figure data-tone={figureTone} style={{ color: figureTone ? `var(--color-${figureTone})` : undefined }}>{used}</span>, part])}
                          </p>;
                        })}
                        <p className="text-[12px] leading-snug text-muted">{t("voiceCompanion.settings.asOf", { time: readAt })}</p>
                      </div> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {refusal("backend")}
          {settings.uncertainSession ? (
            <div className="mt-2 flex flex-col items-start gap-1.5" data-voice-companion-uncertain>
              <p role="alert" className="text-[12px] leading-snug text-danger">{companionErrorMessage("MINT_UNCERTAIN", speech)}</p>
              <button type="button" disabled={busy} onClick={() => void change({ releaseUncertainSession: true }, "release")} className="min-h-9 rounded-[8px] border border-border px-3 text-[13px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45">{t("voiceCompanion.settings.uncertain.release")}</button>
              {refusal("release")}
            </div>
          ) : null}
        </div>
      ) : null}
      <VoiceDevicesSetting />
      {settings ? <CallMemorySetting enabled={settings.callMemory ?? true} busy={busy} onChange={callMemory => void change({ callMemory }, "callMemory")} refusal={refusal("callMemory")} /> : null}
      {refusal(null)}
    </div>
  );
}
