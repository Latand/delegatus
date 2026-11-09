"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { ActionsRow, BUTTON, DANGER_TEXT, TEXT_ACTION, TextRow, ValueRow } from "@/components/settings/settingsRows";
import { spokenDuration } from "./CompanionSpend";
import type { CallMemoryRow } from "@/lib/voiceCompanion/callMemoryTypes";

/** The remembered calls: read while the section is shown, one write at a time, and a forgotten call waits for the server. */
export function useCallMemory() {
  const [calls, setCalls] = useState<CallMemoryRow[]>([]);
  const [retained, setRetained] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [writing, setWriting] = useState(false);
  const sequence = useRef(0);
  const request = useCallback(async (body?: { sessionId: string } | { all: true }) => {
    const current = ++sequence.current;
    setError(false);
    if (body) setWriting(true);
    try {
      const response = await fetch("/api/voice-companion/memory", { cache: "no-store", ...(body ? { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error("unavailable");
      const result = await response.json() as { calls: CallMemoryRow[]; retained?: number };
      if (current === sequence.current) { setCalls(result.calls); setRetained(result.retained ?? result.calls.length); }
    } catch { if (current === sequence.current) setError(true); }
    finally { if (current === sequence.current) { setLoading(false); setWriting(false); } }
  }, []);
  useEffect(() => { let disposed = false; queueMicrotask(() => { if (!disposed) void request(); }); return () => { disposed = true; sequence.current++; }; }, [request]);
  return { calls, retained, loading, error, writing, request };
}
export type CallMemory = ReturnType<typeof useCallMemory>;

/** What the row says while there is no list to open. */
export function CallMemoryStatus({ memory }: { memory: CallMemory }) {
  const { t } = useLocale();
  const { loading, error, calls, writing, request } = memory;
  return <>
    <TextRow tone="muted" role="status" attrs={{ "data-call-memory-status": "" }}>{loading ? t("voiceCompanion.memory.loading") : error ? t("voiceCompanion.memory.error") : calls.length ? "" : t("voiceCompanion.memory.empty")}</TextRow>
    {error ? <ActionsRow><button type="button" onClick={() => void request()} disabled={writing} className={BUTTON}>{t("voiceCompanion.memory.retry")}</button></ActionsRow> : null}
  </>;
}

/** The page behind «Remembered calls»: a call's date, length and project, what was said and its Forget. */
export function CallMemoryPage({ memory }: { memory: CallMemory }) {
  const { t, locale } = useLocale();
  const { calls, retained, loading, error, writing, request } = memory;
  return <div data-call-memory="">
    {loading || error || !calls.length ? <CallMemoryStatus memory={memory} /> : null}
    <ul data-call-memory-list="" aria-label={t("voiceCompanion.memory.title")} className="m-0 list-none p-0">
      {calls.map(({ sessionId, summary }, at) => <li key={sessionId} data-call-memory-row="" className={at ? "border-t border-border" : ""}>
        <ValueRow
          value={<span className="tabular-nums">{new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(summary.endedAt ?? summary.startedAt)} · {spokenDuration(((summary.endedAt ?? summary.startedAt) - summary.startedAt) / 1000, t)} · {summary.projects.join(", ")}</span>}
          action={<button type="button" disabled={writing} onClick={() => void request({ sessionId })} className={TEXT_ACTION}>{t("voiceCompanion.memory.forget")}</button>}
        >
          {summary.pending ? <span className="text-ui leading-snug text-muted">{t("voiceCompanion.memory.pending")}</span> : summary.code && ["account", "timeout", "invalid", "failed"].includes(summary.code) ? <span className="text-ui leading-snug text-muted">{t(`voiceCompanion.memory.failed.${summary.code}`)}</span> : null}
          {(["asked", "done", "decided", "open"] as const).map(key => summary[key].length ? <span key={key} className="block text-ui leading-snug text-primary"><span className="font-semibold">{t(`voiceCompanion.memory.${key}`)}: </span>{summary[key].join("; ")}</span> : null)}
          {summary.privateOmitted ? <span className="text-ui leading-snug text-muted">{t("voiceCompanion.memory.private")}</span> : null}
        </ValueRow>
      </li>)}
    </ul>
    <ActionsRow note={t("voiceCompanion.memory.active")}>
      <button type="button" disabled={writing || !retained} onClick={() => void request({ all: true })} className={DANGER_TEXT}>{t("voiceCompanion.memory.forgetAll")}</button>
    </ActionsRow>
  </div>;
}
