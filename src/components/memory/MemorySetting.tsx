"use client";
import { useEffect, useRef, useState } from "react";
import type { MemorySettingView } from "@/lib/memory/viewTypes";
import { useLocale } from "@/lib/i18n";
type CompatibleView = Pick<MemorySettingView, "enabled"> & Partial<MemorySettingView> & { status?: "unavailable" };
export function MemorySetting({ project }: { project: string }) {
  const { t } = useLocale();
  const [view, setView] = useState<(CompatibleView & { project: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"read" | "save" | null>(null);
  const revision = useRef(0);
  const writing = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    writing.current = false;
    const refresh = async () => {
      if (writing.current) return;
      const current = ++revision.current;
      try {
        const r = await fetch(`/api/memory/settings?project=${encodeURIComponent(project)}`, { signal: abort.signal, cache: "no-store" });
        if (!r.ok) throw Error();
        const value = await r.json();
        if (current === revision.current && !abort.signal.aborted) { setView({ ...value, project }); setError(null); }
      } catch { if (current === revision.current && !abort.signal.aborted) setError("read"); }
    };
    void refresh();
    window.addEventListener("delegatus:provider-key-changed", refresh);
    const timer = setInterval(refresh, 15000);
    return () => { revision.current++; abort.abort(); clearInterval(timer); window.removeEventListener("delegatus:provider-key-changed", refresh); };
  }, [project]);
  const save = async (enabled: boolean) => {
    if (writing.current) return;
    writing.current = true;
    const current = ++revision.current;
    setBusy(true); setError(null);
    try { const r = await fetch("/api/memory/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, enabled }) });
      if (!r.ok) throw Error();
      const value = await r.json();
      if (current === revision.current) setView({ ...value, project });
    } catch { if (current === revision.current) setError("save"); }
    finally { writing.current = false; setBusy(false); }
  };
  return <div className="mt-5 border-t border-border pt-4" data-memory-setting>
    <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-semibold">{t("memory.label")}
      <input type="checkbox" role="switch" aria-label={t("memory.label")} checked={view?.project === project && view.enabled} disabled={busy || view?.project !== project} onChange={e => void save(e.target.checked)} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
    </label>
    <p className="text-[13px] leading-relaxed text-muted">{t("memory.explanation")}</p>
    {error && <p role="alert" className="mt-2 text-[13px] leading-relaxed">{t(error === "save" ? "memory.save.failed" : "memory.status.failed")}</p>}
    {error !== "read" && view?.project === project && <>
      <p role="status" data-memory-status className="mt-2 text-[13px] leading-relaxed">{view.status !== "unavailable" && view.reasons ? (view.reasons.length ? view.reasons.map(reason => t(`memory.status.${reason === "noKey" && view.staging ? "noKeyStaging" : reason}`)).join(" ") : t("memory.status.ready")) : t("memory.status.failed")}{view.lastTurn && <span data-memory-last-turn> {t(`memory.last.${view.lastTurn}`)}</span>}</p>
      {view.counts && view.month && <p data-memory-counts className="mt-2 text-[13px] leading-relaxed text-muted">{t("memory.counts", { month: view.month, ...view.counts })}</p>}
      {view.spentUsd !== undefined && view.capUsd !== undefined && <p className="mt-2 text-[13px] text-muted">{t("memory.spend", { spent: view.spentUsd.toFixed(3), cap: view.capUsd.toFixed(2) })}</p>}</>}
  </div>;
}
