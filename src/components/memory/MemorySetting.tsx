"use client";
import { useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";
export function MemorySetting({ project }: { project: string }) {
  const { t } = useLocale();
  const [view, setView] = useState<{ project: string; enabled: boolean; capUsd: number; spentUsd: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/memory/settings?project=${encodeURIComponent(project)}`, { signal: abort.signal })
      .then(r => { if (!r.ok) throw Error(); return r.json(); })
      .then(v => setView({ ...v, project })).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
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
    {view?.project === project && <p className="mt-2 text-[13px] text-muted">{t("memory.spend", { spent: view.spentUsd.toFixed(3), cap: view.capUsd.toFixed(2) })}</p>}
    {error && <p role="alert">{t("telemetry.error")}</p>}
  </div>;
}
