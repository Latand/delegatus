"use client";

import { useId, useState } from "react";

import { openKeys } from "@/components/keys/openKeys";
import { useNowSeconds } from "@/hooks/useNowSeconds";
import { useVoiceCompanionSettings } from "@/hooks/useVoiceCompanionSettings";
import { useLocale } from "@/lib/i18n";
import { companionErrorMessage, limitResetText } from "@/lib/voiceCompanion/errors";
import { CallMemoryPage, CallMemoryStatus, useCallMemory } from "@/components/voiceCompanion/CallMemorySetting";
import { callDuration, planName, planTone, planWindows, spendTone, voiceMoney, voiceMonth, windowName, windowTone } from "@/components/voiceCompanion/CompanionSpend";
import { COMPANION_SETTINGS_EVENT } from "@/components/voiceCompanion/hostSurfaces";
import { VoiceDevicesSetting } from "@/components/voiceCompanion/VoiceDevicesSetting";
import { useVoiceTools, VoiceToolPage, VoiceToolRows } from "@/components/voiceCompanion/VoiceToolsSetting";

import type { SettingsSub } from "./openSettings";
import { BlockRow, BUTTON, ChoiceRow, DetailsRow, FIELD, FieldRow, Gone, LinkRow, Literal, RefusalLine, Rows, SectionHead, SwitchRow, TextRow } from "./settingsRows";

/* A page's rows reach the foot of the sheet, so its actions can stand there. */
const FILL = "flex flex-1 flex-col";
type Control = "enabled" | "backend" | "cap" | "callMemory" | "timerTelegram" | "release";

/**
 * «Voice Delegatus» in the Settings window (#2519 D): on or off, how the voice
 * talks, the devices, Telegram for timers, call memory and the tools. Through
 * the API it needs the OpenAI key and keeps the monthly cap; on Codex V3 it runs
 * on a managed account's subscription, and nothing on this page mentions a key
 * or spend. The key is entered in «Keys» (docs/design/keys-settings.md §4): its
 * row says where the key comes from and opens «Keys» on it.
 */
export function VoiceSection({ sub, go, back }: { sub: SettingsSub | null; go: (sub: SettingsSub) => void; back: () => void }) {
  const { t, locale } = useLocale();
  const { settings, busy, error, update } = useVoiceCompanionSettings(true);
  const memory = useCallMemory();
  const tools = useVoiceTools();
  const speech = locale === "uk" ? "uk" as const : "en" as const;
  /* A refusal reads beside the control that was pressed, so it is in view where the person's eyes are. */
  const [pressed, setPressed] = useState<Control | null>(null);
  const change = async (value: Parameters<typeof update>[0], control: Control) => {
    setPressed(control);
    if (await update(value)) window.dispatchEvent(new Event(COMPANION_SETTINGS_EVENT));
  };
  const refusal = (control: Control | null) => error && pressed === control
    ? <RefusalLine attrs={{ "data-voice-companion-setting-error": error }}>{companionErrorMessage(error, speech)}</RefusalLine> : null;

  if (sub?.id === "cap") return settings ? <CapPage settings={settings} change={change} refusal={refusal("cap")} /> : null;
  if (sub?.id === "calls") return <div data-voice-companion-settings="" className={FILL}><Rows><CallMemoryPage memory={memory} /></Rows></div>;
  if (sub?.id === "tool") {
    const name = sub.arg ?? "";
    /* A tool removed from under its own page, or a first read that failed: the section again, with its list or its retry. */
    if (tools.view ? !Object.hasOwn(tools.view.servers, name) : !tools.loading) return <Gone back={back} />;
    return <div data-voice-companion-settings="" className={FILL}><VoiceToolPage name={name} tools={tools} /></div>;
  }

  const api = settings?.backend === "api";
  const cap = settings?.monthlyCapUsd ?? 0;
  const spent = (settings?.usageUsd ?? 0) + (settings?.reservedUsd ?? 0);
  const lastRetained = memory.calls[0]?.summary;
  const keyDot = settings?.keySource === "missing" ? "warn" as const : "ok" as const;
  return (
    <div data-voice-companion-settings="" className={FILL}>
      <Rows data-voice-companion-setting="">
        <SwitchRow
          label={t("voiceCompanion.settings.enable")}
          hint={t("settings.voice.enableHint")}
          enabled={settings?.enabled ?? false}
          disabled={!settings}
          onToggle={() => void change({ enabled: !settings?.enabled }, "enabled")}
          switchAttrs={{ "data-voice-companion-enable": "" }}
        >{refusal("enabled")}</SwitchRow>
        {settings?.enabled ? (
          <>
            <ChoiceRow
              label={t("voiceCompanion.settings.backend")}
              wide
              value={settings.backend}
              attrs={{ "data-voice-companion-backend": settings.backend }}
              selectAttrs={{ "data-voice-backend-select": "" }}
              onChange={(backend) => void change({ backend: backend as "api" | "codex" }, "backend")}
              options={[{ value: "api", label: t("voiceCompanion.settings.backend.api") }, { value: "codex", label: t("voiceCompanion.settings.backend.codex") }]}
            >
              {settings.backend === "codex" ? <CodexLines settings={settings} /> : null}
            </ChoiceRow>
            {/* An API choice held without its key draws the backend serving it now; staying on it is a decision of its own, and a select fires nothing on the value it shows. */}
            {settings.held ? (
              <div data-voice-companion-held="" data-settings-unit="">
                <TextRow tone="warning">{t("settings.voice.held")}</TextRow>
                <BlockRow>
                  <span className="flex flex-wrap items-center gap-2">
                    <button type="button" data-voice-companion-held-key="" className={BUTTON} onClick={() => openKeys("openai")}>{t("openaiServices.addKey")}</button>
                    <button type="button" data-voice-companion-stay="" className={BUTTON} onClick={() => void change({ backend: "codex" }, "backend")}>{t("settings.voice.stayOnCodex")}</button>
                  </span>
                </BlockRow>
              </div>
            ) : null}
            {refusal("backend")}
            {api ? (
              <>
                <LinkRow
                  attrs={{ "data-voice-companion-key": "", "data-key-source": settings.keySource }}
                  buttonAttrs={{ "data-voice-companion-open-keys": "" }}
                  label={t("settings.voice.key")}
                  dot={{ tone: keyDot, note: t(`settings.voice.keyNote.${settings.keySource}`) }}
                  value={t(`settings.voice.keyWord.${settings.keySource}`)}
                  hint={t("settings.opensKeys")}
                  onOpen={() => openKeys("openai")}
                />
                <LinkRow
                  attrs={{ "data-voice-companion-cap-row": "" }}
                  sub="cap:"
                  label={t("voiceCompanion.settings.cap")}
                  value={voiceMoney(cap)}
                  hint={<span style={{ color: spendTone(settings.usageUsd, cap) ? `var(--color-${spendTone(settings.usageUsd, cap)})` : undefined }}>{t("voiceCompanion.settings.usage", { month: voiceMonth(locale, settings.month), spent: voiceMoney(settings.usageUsd), cap: voiceMoney(cap) })}</span>}
                  onOpen={() => go({ id: "cap", title: t("voiceCompanion.settings.cap") })}
                />
                {spent >= cap ? <TextRow tone="danger">{companionErrorMessage("CAP_REACHED", speech)}</TextRow> : null}
              </>
            ) : null}
            {settings.uncertainSession ? (
              <div data-voice-companion-uncertain="" data-settings-unit="">
                <TextRow tone="danger" role="alert">{t("settings.voice.uncertain")}</TextRow>
                <BlockRow><button type="button" disabled={busy} className={BUTTON} onClick={() => void change({ releaseUncertainSession: true }, "release")}>{t("voiceCompanion.settings.uncertain.release")}</button></BlockRow>
                {refusal("release")}
              </div>
            ) : null}
          </>
        ) : null}
        <VoiceDevicesSetting />
        {settings ? (
          <SwitchRow
            attrs={{ "data-timer-telegram": "" }}
            label={t("voiceCompanion.timerTelegram.title")}
            hint={t("voiceCompanion.timerTelegram.hint")}
            enabled={settings.timerTelegram === true}
            onToggle={() => void change({ timerTelegram: !settings.timerTelegram }, "timerTelegram")}
          >{refusal("timerTelegram")}</SwitchRow>
        ) : null}
        <SectionHead title={t("voiceCompanion.memory.title")} />
        {settings ? (
          <SwitchRow
            attrs={{ "data-call-memory": "" }}
            label={t("settings.voice.remember")}
            hint={t("settings.voice.rememberHint")}
            enabled={settings.callMemory ?? true}
            disabled={memory.writing}
            onToggle={() => void change({ callMemory: !(settings.callMemory ?? true) }, "callMemory")}
          >{refusal("callMemory")}</SwitchRow>
        ) : null}
        {memory.loading || memory.error ? <CallMemoryStatus memory={memory} /> : (
          <LinkRow
            attrs={{ "data-call-memory-row-open": "" }}
            sub="calls:"
            label={t("settings.voice.calls")}
            value={String(memory.retained)}
            hint={lastRetained ? t("settings.voice.lastCall", { date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(lastRetained.endedAt ?? lastRetained.startedAt) }) : t("voiceCompanion.memory.empty")}
            onOpen={() => go({ id: "calls", title: t("settings.voice.calls") })}
          />
        )}
        <VoiceToolRows tools={tools} onOpen={(name, title) => go({ id: "tool", arg: name, title })} />
        {refusal(null)}
        <DetailsRow lines={[
          settings?.enabled && api ? { label: t("settings.voice.detail.api"), value: settings.keySource === "env" ? t("voiceCompanion.settings.key.env") : <>{t("settings.voice.detail.apiLine")} <Literal text="OPENAI_API_KEY" /></> } : null,
          { label: t("voiceCompanion.settings.label"), value: t("voiceCompanion.settings.explanation") },
          { label: t("settings.voice.detail.summaries"), value: t("voiceCompanion.memory.provider") },
        ]} />
      </Rows>
    </div>
  );
}

function CodexLines({ settings }: { settings: NonNullable<ReturnType<typeof useVoiceCompanionSettings>["settings"]> }) {
  const { t, locale } = useLocale();
  const speech = locale === "uk" ? "uk" as const : "en" as const;
  const call = settings.lastCodexSession;
  const plan = call?.plan ?? null;
  const clock = useNowSeconds(60_000);
  const now = clock ? clock * 1000 : plan?.observedAt ?? 0;
  const date = call ? new Intl.DateTimeFormat(locale, { day: "numeric", month: speech === "uk" ? "long" : "short" }).format(new Date(call.endedAt)) : "";
  const windows = plan ? planWindows(plan) : [];
  /* The window that runs out first says when it comes back. */
  const tightest = windows.reduce<(typeof windows)[number] | null>((most, window) => !most || window.usedPercent > most.usedPercent ? window : most, null);
  const [before, after = ""] = plan ? t("voiceCompanion.settings.planUsed", { plan: planName(plan), windows: "\u0001" }).split("\u0001") : [""];
  return (
    <div data-voice-companion-codex="" className="flex flex-col gap-0.5 px-5 pb-1.5 text-ui leading-snug text-muted tabular-nums settings-sheet:px-4">
      <p data-voice-companion-last-call="" data-settings-unit="">{call ? t("voiceCompanion.settings.lastCodexCall", { duration: callDuration(call.seconds), date }) : t("voiceCompanion.settings.noCall")}</p>
      {/* The plan in one line: what each window has used, its figure emphasised, and when the fullest one resets. */}
      {plan ? (
        <p data-voice-companion-plan="" data-settings-unit="" data-tone={planTone(plan)} className="text-secondary">
          {before}
          {windows.map((window, index) => {
            const figureTone = windowTone(window, plan);
            return (
              <span key={index} data-plan-window="" className="whitespace-nowrap">
                {index ? ", " : ""}{windowName(window, t)} <span className="font-semibold text-primary" data-plan-figure="" data-tone={figureTone} style={{ color: figureTone ? `var(--color-${figureTone})` : undefined }}>{`${Math.round(window.usedPercent)}%`}</span>
              </span>
            );
          })}
          {after}
          {tightest && tightest.resetsAt !== null ? <span data-plan-reset="">{" · "}{t("voiceCompanion.settings.planReset", { window: windowName(tightest, t), reset: limitResetText(tightest.resetsAt, speech, now) })}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** The cap's field, which commits on blur or Enter and shows at once, with what the month used. */
function CapPage({ settings, change, refusal }: {
  settings: NonNullable<ReturnType<typeof useVoiceCompanionSettings>["settings"]>;
  change: (value: { monthlyCapUsd: number }, control: "cap") => Promise<void>;
  refusal: React.ReactNode;
}) {
  const { t, locale } = useLocale();
  const speech = locale === "uk" ? "uk" as const : "en" as const;
  /* What is being typed; null shows the saved one. */
  const [draft, setDraft] = useState<string | null>(null);
  const hint = useId();
  const commit = async () => {
    if (draft === null) return;
    const value = Number(draft.replace(",", "."));
    setDraft(null);
    if (draft.trim() === "" || !Number.isFinite(value) || value < 0 || value === settings.monthlyCapUsd) return;
    await change({ monthlyCapUsd: Math.round(value * 100) / 100 }, "cap");
  };
  const last = settings.lastSession;
  const lastDuration = last ? `${Math.floor(last.seconds / 60)}:${String(Math.floor(last.seconds % 60)).padStart(2, "0")}` : "";
  const lastDate = last ? new Intl.DateTimeFormat(locale, { day: "numeric", month: speech === "uk" ? "long" : "short", timeZone: "UTC" }).format(new Date(last.endedAt)) : "";
  const tone = spendTone(settings.usageUsd, settings.monthlyCapUsd);
  return (
    <div data-voice-companion-settings="" className={FILL}>
      <Rows data-voice-companion-cap="">
        <FieldRow label={t("voiceCompanion.settings.cap")}>
          <span aria-hidden className="text-body text-muted">$</span>
          <input type="text" inputMode="decimal" data-voice-companion-cap-input="" aria-label={t("voiceCompanion.settings.cap")} value={draft ?? String(settings.monthlyCapUsd)} aria-describedby={hint}
            onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } }}
            className={`${FIELD} tabular-nums`} />
        </FieldRow>
        {refusal}
        <TextRow tone="muted" role="status" attrs={{ "data-voice-companion-usage": "", id: hint }}>
          <span style={{ color: tone ? `var(--color-${tone})` : undefined }}>
            {t("voiceCompanion.settings.usage", { month: voiceMonth(locale, settings.month), spent: voiceMoney(settings.usageUsd), cap: voiceMoney(settings.monthlyCapUsd) })}
            {settings.reservedUsd > 0 ? ` ${t("voiceCompanion.settings.reserved", { held: voiceMoney(settings.reservedUsd) })}` : ""}
          </span>
        </TextRow>
        {last ? (
          <TextRow tone="muted" attrs={{ "data-voice-companion-last-call": "" }}>
            <span title={last.incomplete ? t("voiceCompanion.spend.incomplete") : undefined}>{t(last.incomplete ? "voiceCompanion.settings.lastCallIncomplete" : "voiceCompanion.settings.lastCall", { usd: voiceMoney(last.usd), duration: lastDuration, date: lastDate })}</span>
          </TextRow>
        ) : null}
        {settings.incomplete ? <TextRow tone="muted">{companionErrorMessage("FINALIZATION_INCOMPLETE", speech)}</TextRow> : null}
        {settings.usageUsd + settings.reservedUsd >= settings.monthlyCapUsd ? <TextRow tone="danger">{companionErrorMessage("CAP_REACHED", speech)}</TextRow> : null}
      </Rows>
    </div>
  );
}
