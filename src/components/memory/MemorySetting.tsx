"use client";
import { useEffect, useState } from "react";
import type { MemorySettingView } from "@/lib/memory/viewTypes";
import { useLocale } from "@/lib/i18n";
export function MemorySetting({ project }: { project: string }) {
  const { t } = useLocale();
  const [view, setView] = useState<(MemorySettingView & { project: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => fetch(`/api/memory/settings?project=${encodeURIComponent(project)}`, { signal: abort.signal, cache: "no-store" })
      .then(r => { if (!r.ok) throw Error(); return r.json(); })
      .then(v => { setView({ ...v, project }); setError(false); }).catch(() => { if (!abort.signal.aborted) setError(true); });
    void refresh();
    window.addEventListener("delegatus:provider-key-changed", refresh);
    const timer = setInterval(refresh, 15000);
    return () => { abort.abort(); clearInterval(timer); window.removeEventListener("delegatus:provider-key-changed", refresh); };
  }, [project]);
  const save = async (enabled: boolean) => {
    setBusy(true); setError(false);
    try { const r = await fetch("/api/memory/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, enabled }) });
      if (!r.ok) throw Error(); setView({ ...await r.json(), project });
    } catch { setError(true); } finally { setBusy(false); }
  };
  return <div className="mt-5 border-t border-border pt-4" data-memory-setting>
    <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-semibold">{t("memory.label")}
      <input type="checkbox" role="switch" aria-label={t("memory.label")} checked={view?.project === project && view.enabled} disabled={busy || view?.project !== project} onChange={e => void save(e.target.checked)} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
    </label>
    <p className="text-[13px] leading-relaxed text-muted">{t("memory.explanation")}</p>
    {!error && view?.project === project && <>
      <p role="status" data-memory-status className="mt-2 text-[13px] leading-relaxed">{view.reasons.length ? view.reasons.map(reason => t(`memory.status.${reason}`)).join(" ") : t("memory.status.ready")}</p>
      <p data-memory-counts className="mt-2 text-[13px] leading-relaxed text-muted">{t("memory.counts", { month: view.month, ...view.counts })}</p>
      <p className="mt-2 text-[13px] text-muted">{t("memory.spend", { spent: view.spentUsd.toFixed(3), cap: view.capUsd.toFixed(2) })}</p></>}
    {error && <p role="alert">{t("memory.status.failed")}</p>}
  </div>;
}
