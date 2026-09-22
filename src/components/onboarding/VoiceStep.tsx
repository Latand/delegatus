"use client";

import { Check, KeyRound, Lock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useLocale, type TFunction } from "@/lib/i18n";
import type { TranscribeBackend, TranscribeBackendInfo, TranscribeBackendOption } from "@/lib/transcribeBackend";

/**
 * Step 4, Voice (#2004, design §2.6): where dictation is transcribed. Choosing
 * a row saves it at once through the mic menu's own route; a live row takes
 * its key here, written by `PUT /api/transcribe/key` and never shown again;
 * one Check asks the real path and answers in a sentence. The same component
 * is the "Dictation" menu row, opened alone.
 */

const ORDER: readonly TranscribeBackend[] = ["local", "chatgpt", "elevenlabs", "soniox"];
type LiveProvider = "elevenlabs" | "soniox";
const LIVE_ENV: Record<LiveProvider, string> = { elevenlabs: "ELEVENLABS_API_KEY", soniox: "SONIOX_API_KEY" };
const isLive = (backend: TranscribeBackend): backend is LiveProvider => backend === "elevenlabs" || backend === "soniox";

const NAME_KEY: Record<TranscribeBackend, Parameters<TFunction>[0]> = {
  local: "onboarding.voice.name.local",
  chatgpt: "onboarding.voice.name.chatgpt",
  elevenlabs: "onboarding.voice.name.elevenlabs",
  soniox: "onboarding.voice.name.soniox",
};
const NOTE_KEY: Record<TranscribeBackend, Parameters<TFunction>[0]> = {
  local: "onboarding.voice.note.local",
  chatgpt: "onboarding.voice.note.chatgpt",
  elevenlabs: "onboarding.voice.note.elevenlabs",
  soniox: "onboarding.voice.note.soniox",
};
/* The provider's own name in the check sentence, never translated. */
const PROVIDER_NAME: Record<LiveProvider, string> = { elevenlabs: "ElevenLabs", soniox: "Soniox" };

export const TRANSCRIPTION_GUIDE_URL = "https://github.com/Latand/live-log-viewer-next/blob/main/docs/transcription.md#local-default--faster-whisper";

type CheckResult = { tone: "success" | "danger"; text: string };
type KeyNote = { provider: LiveProvider; kind: "saved" } | { provider: LiveProvider; kind: "failed"; reason: string };

function isInfo(value: unknown): value is TranscribeBackendInfo {
  return Boolean(value) && typeof value === "object" && typeof (value as TranscribeBackendInfo).backend === "string" && Array.isArray((value as TranscribeBackendInfo).options);
}

async function errorOf(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* no JSON body */
  }
  return `HTTP ${response.status}`;
}

async function readInfo(): Promise<TranscribeBackendInfo> {
  const response = await fetch("/api/transcribe/backend", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isInfo(body)) throw new Error("unreadable answer");
  return body;
}

/** The one-press check, per backend (design §2.6's table). */
export async function checkDictation(backend: TranscribeBackend, t: TFunction): Promise<CheckResult> {
  if (isLive(backend)) {
    const name = PROVIDER_NAME[backend];
    let response: Response;
    try {
      response = await fetch("/api/transcribe/token", { method: "POST" });
    } catch (error) {
      return { tone: "danger", text: t("onboarding.voice.result.failed", { reason: error instanceof Error ? error.message : String(error) }) };
    }
    /* The minted token is a real, short-lived credential: it is read for its
       presence and dropped here. */
    if (response.ok) return { tone: "success", text: t("onboarding.voice.result.liveOk", { name }) };
    if (response.status === 503) return { tone: "danger", text: t("onboarding.voice.result.liveNoKey", { name }) };
    if (response.status === 502) return { tone: "danger", text: t("onboarding.voice.result.liveRefused", { name, detail: await errorOf(response) }) };
    return { tone: "danger", text: t("onboarding.voice.result.failed", { reason: await errorOf(response) }) };
  }
  let info: TranscribeBackendInfo;
  try {
    info = await readInfo();
  } catch (error) {
    return { tone: "danger", text: t("onboarding.voice.result.failed", { reason: error instanceof Error ? error.message : String(error) }) };
  }
  const available = info.options.find((option) => option.id === backend)?.available ?? false;
  if (backend === "local") return available ? { tone: "success", text: t("onboarding.voice.result.localOk") } : { tone: "danger", text: t("onboarding.voice.result.localMissing") };
  return available ? { tone: "success", text: t("onboarding.voice.result.chatgptOk") } : { tone: "danger", text: t("onboarding.voice.result.chatgptMissing") };
}

function KeyArea({ provider, option, note, onSaved, onNote }: {
  provider: LiveProvider;
  option: TranscribeBackendOption | undefined;
  note: KeyNote | null;
  onSaved: (info: TranscribeBackendInfo) => void;
  onNote: (note: KeyNote | null) => void;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const source = option?.keySource ?? null;

  if (source === "env") {
    return <p data-voice-key-env={provider} className="text-ui text-secondary">{t("onboarding.voice.keyFromEnv", { var: LIVE_ENV[provider] })}</p>;
  }

  const save = async () => {
    const key = draft.trim();
    if (!key || saving) return;
    setSaving(true);
    onNote(null);
    try {
      const response = await fetch("/api/transcribe/key", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key }),
      });
      if (!response.ok) {
        onNote({ provider, kind: "failed", reason: await errorOf(response) });
        return;
      }
      const body: unknown = await response.json();
      /* The field is emptied the moment the server has the key. */
      setDraft("");
      setReplacing(false);
      onNote({ provider, kind: "saved" });
      if (isInfo(body)) onSaved(body);
    } catch (error) {
      onNote({ provider, kind: "failed", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const noteLine = note?.provider === provider ? (
    note.kind === "saved"
      ? <p data-voice-key-note="saved" className="flex items-center gap-1.5 text-ui text-success"><Check className="h-3.5 w-3.5 shrink-0" aria-hidden />{t("onboarding.voice.keySaved")}</p>
      : <p data-voice-key-note="failed" role="alert" className="text-ui text-danger">{t("onboarding.voice.keySaveFailed", { reason: note.reason })}</p>
  ) : null;

  if (source === "file" && !replacing) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="flex flex-wrap items-center gap-x-1.5 text-ui text-secondary">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <span>{t("onboarding.voice.keyOnFile")}</span>
          <span aria-hidden>·</span>
          <button type="button" data-voice-key-replace="" onClick={() => { setReplacing(true); onNote(null); }} className="rounded-[6px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11">
            {t("onboarding.voice.keyReplace")}
          </button>
        </p>
        {noteLine}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <form
        data-voice-key-field={provider}
        className="flex items-center gap-2 max-sm:flex-col max-sm:items-stretch"
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <label className="flex min-w-0 flex-1 items-center gap-2 max-sm:flex-col max-sm:items-stretch max-sm:gap-1">
          <span className="shrink-0 text-ui font-semibold text-secondary">{t("onboarding.voice.keyLabel")}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder={t("onboarding.voice.keyPlaceholder")}
            onChange={(event) => setDraft(event.currentTarget.value)}
            className="h-8 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2.5 text-ui text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:text-[16px]"
          />
        </label>
        <button
          type="button"
          data-voice-key-save=""
          onClick={() => void save()}
          disabled={!draft.trim() || saving}
          className="inline-flex h-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-card px-3 text-ui font-semibold text-primary hover:bg-sunken disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
        >
          {t("onboarding.voice.keySave")}
        </button>
      </form>
      {noteLine}
    </div>
  );
}

export function VoiceStep({ onSkip, onGoEngines }: {
  /** In the guide: "Keep the local default" marks the step skipped and moves on. */
  onSkip?: () => void;
  /** In the guide: the ChatGPT row's "sign in to Codex first" points at step 1. */
  onGoEngines?: () => void;
}) {
  const { t } = useLocale();
  const [info, setInfo] = useState<TranscribeBackendInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState<KeyNote | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    readInfo().then(setInfo, (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));
  }, []);
  useEffect(load, [load]);

  const choose = async (backend: TranscribeBackend) => {
    if (!info || info.lockedByEnv || info.backend === backend) return;
    const previous = info;
    setInfo({ ...info, backend });
    setSelectError(null);
    setResult(null);
    try {
      const response = await fetch("/api/transcribe/backend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend }),
      });
      if (!response.ok) {
        setInfo(previous);
        setSelectError(await errorOf(response));
        return;
      }
      const body: unknown = await response.json();
      if (isInfo(body)) setInfo(body);
    } catch (error) {
      setInfo(previous);
      setSelectError(error instanceof Error ? error.message : String(error));
    }
  };

  const check = async () => {
    if (!info || checking) return;
    setChecking(true);
    setResult(null);
    try {
      setResult(await checkDictation(info.backend, t));
    } finally {
      setChecking(false);
    }
  };

  if (!info) {
    return loadError ? (
      <div className="flex items-center gap-3 text-body text-secondary">
        <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden />
        <span className="min-w-0 flex-1">{t("onboarding.voice.result.failed", { reason: loadError })}</span>
        <button type="button" onClick={load} className="inline-flex h-8 shrink-0 items-center rounded-[8px] border border-border bg-card px-3 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
          {t("onboarding.phone.retry")}
        </button>
      </div>
    ) : (
      <div className="flex flex-col gap-2" aria-busy>
        {ORDER.map((id) => <div key={id} className="h-11 animate-pulse rounded-[8px] bg-sunken motion-reduce:animate-none" />)}
      </div>
    );
  }

  const optionOf = (id: TranscribeBackend) => info.options.find((option) => option.id === id);
  return (
    <div data-onboarding-voice="" className="flex max-w-[560px] flex-col gap-3">
      {info.lockedByEnv ? (
        <p className="flex items-center gap-2 rounded-[8px] bg-sunken px-3 py-2 text-ui text-secondary">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          {t("onboarding.voice.locked")}
        </p>
      ) : null}
      <div role="radiogroup" aria-label={t("onboarding.voice.heading")} className="flex flex-col overflow-hidden rounded-[12px] border border-border">
        {ORDER.map((id) => {
          const option = optionOf(id);
          const selected = info.backend === id;
          const detail = id === "local" && option && !option.available
            ? (
              <span className="text-ui text-warning">
                {t("onboarding.voice.localMissing")}{" "}
                <a href={TRANSCRIPTION_GUIDE_URL} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">{t("onboarding.voice.localHowTo")} →</a>
              </span>
            )
            : id === "chatgpt" && option && !option.available
              ? onGoEngines
                ? <button type="button" onClick={onGoEngines} className="self-start text-left text-ui text-warning hover:underline">{t("onboarding.voice.chatgptNoCodex")}</button>
                : <span className="text-ui text-warning">{t("onboarding.voice.chatgptNoCodex")}</span>
              : null;
          return (
            <div key={id} data-voice-backend={id} data-selected={selected ? "" : undefined} className={`flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0 ${selected ? "bg-accent-soft/40" : "bg-card"}`}>
              <label className={`flex min-h-6 items-start gap-2.5 max-sm:min-h-9 ${info.lockedByEnv ? "cursor-default" : "cursor-pointer"}`}>
                <input
                  type="radio"
                  name="onboarding-voice-backend"
                  value={id}
                  checked={selected}
                  disabled={info.lockedByEnv}
                  onChange={() => void choose(id)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)] max-sm:mt-1 max-sm:h-5 max-sm:w-5"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body font-semibold text-primary">{t(NAME_KEY[id])}</span>
                  <span className="text-ui text-secondary">{t(NOTE_KEY[id])}</span>
                </span>
              </label>
              {detail ? <div className="flex flex-col pl-[26px] max-sm:pl-0">{detail}</div> : null}
              {selected && isLive(id) ? (
                <div className="pl-[26px] max-sm:pl-0">
                  <KeyArea provider={id} option={option} note={keyNote} onSaved={setInfo} onNote={setKeyNote} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {selectError ? <p role="alert" className="text-ui text-danger">{t("onboarding.voice.selectFailed", { reason: selectError })}</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 max-sm:flex-col max-sm:items-stretch">
        <button
          type="button"
          data-voice-check=""
          disabled={checking}
          onClick={() => void check()}
          className="inline-flex h-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-card px-3.5 text-ui font-semibold text-primary hover:bg-sunken disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
        >
          {checking ? t("onboarding.voice.checking") : t("onboarding.voice.check")}
        </button>
        {result ? (
          <p data-voice-check-result="" data-tone={result.tone} role="status" className={`min-w-0 flex-1 basis-[16rem] text-body ${result.tone === "success" ? "text-success" : "text-danger"}`}>{result.text}</p>
        ) : null}
      </div>
      {onSkip ? (
        <button type="button" data-voice-skip="" onClick={onSkip} className="self-start rounded-[6px] text-ui font-semibold text-secondary hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11">
          {t("onboarding.voice.skip")}
        </button>
      ) : null}
    </div>
  );
}
