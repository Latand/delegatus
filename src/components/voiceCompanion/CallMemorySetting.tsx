"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { callDuration } from "./CompanionSpend";
import type { CallMemoryRow } from "@/lib/voiceCompanion/callMemoryTypes";

export function CallMemorySetting({ enabled, busy, onChange }: { enabled: boolean; busy: boolean; onChange(value: boolean): void }) {
  const { t, locale } = useLocale();
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
  const disabled = busy || writing;
  return <section data-call-memory className="mt-4 min-w-0 border-t border-border pt-3 text-[13px] [overflow-wrap:anywhere]">
    <label className="flex min-h-11 items-center justify-between gap-4 font-semibold">
      {t("voiceCompanion.memory.title")}
      <input type="checkbox" role="switch" checked={enabled} disabled={disabled} aria-label={t("voiceCompanion.memory.title")} onChange={event => onChange(event.target.checked)} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
    </label>
    <p className="text-muted">{t("voiceCompanion.memory.provider")}</p>
    <div role="status" className="mt-2 min-h-5 text-muted">{loading ? t("voiceCompanion.memory.loading") : error ? t("voiceCompanion.memory.error") : calls.length ? "" : t("voiceCompanion.memory.empty")}</div>
    {error ? <button type="button" onClick={() => void request()} disabled={writing} className="min-h-11 underline">{t("voiceCompanion.memory.retry")}</button> : null}
    <ul data-call-memory-list tabIndex={calls.length ? 0 : undefined} aria-label={t("voiceCompanion.memory.title")} className="max-h-[36dvh] space-y-3 overflow-y-auto overscroll-contain">
      {calls.map(({ sessionId, summary }) => <li key={sessionId} data-call-memory-row className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-start justify-between gap-2"><p className="min-w-0 font-semibold">{new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(summary.endedAt ?? summary.startedAt)} · {callDuration(Math.max(0,((summary.endedAt ?? summary.startedAt)-summary.startedAt)/1000))} · {summary.projects.join(", ")}</p><button type="button" disabled={disabled} onClick={() => void request({ sessionId })} className="min-h-11 shrink-0 px-2 underline disabled:opacity-50">{t("voiceCompanion.memory.forget")}</button></div>
        {summary.pending ? <p className="text-muted">{t("voiceCompanion.memory.pending")}</p> : summary.code && ["account","timeout","invalid","failed"].includes(summary.code) ? <p className="text-muted">{t(`voiceCompanion.memory.failed.${summary.code}`)}</p> : null}
        {(["asked","done","decided","open"] as const).map(key => summary[key].length ? <p key={key} className="mt-1"><span className="font-semibold">{t(`voiceCompanion.memory.${key}`)}: </span>{summary[key].join("; ")}</p> : null)}
        {summary.privateOmitted ? <p className="mt-1 text-muted">{t("voiceCompanion.memory.private")}</p> : null}
      </li>)}
    </ul>
    {calls.length ? <p className="mt-1 text-muted">{t("voiceCompanion.memory.scroll")}</p> : null}
    <button type="button" disabled={disabled || !retained} onClick={() => void request({ all: true })} className="min-h-11 px-2 underline disabled:opacity-50">{t("voiceCompanion.memory.forgetAll")}</button>
    <p className="text-muted">{t("voiceCompanion.memory.active")}</p>
  </section>;
}
