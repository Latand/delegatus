"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";

type KeyView = { present: boolean; source: "env" | "file" | null };
/** One installation key, shared by Asks-you and memory. Never read into an input. */
export function OpenRouterKeySetting() {
  const { t } = useLocale();
  const id = useId();
  const [view, setView] = useState<KeyView | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/asks-you/key", { signal: abort.signal, cache: "no-store" })
      .then(r => { if (!r.ok) throw Error(); return r.json(); }).then(setView)
      .catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, []);
  const save = async () => {
    const submitted = input.current?.value ?? "";
    if (input.current) input.current.value = "";
    setHasKey(false); setBusy(true); setError(false); setSaved(false);
    try {
      const response = await fetch("/api/asks-you/key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: submitted }) });
      if (!response.ok) throw Error();
      setView(await response.json()); setSaved(true);
      window.dispatchEvent(new Event("delegatus:provider-key-changed"));
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <div data-provider-key className="mt-5 border-t border-border pt-4">
    <label htmlFor={id} className="text-sm font-semibold">{t("providerKey.label")}</label>
    <p role="status" className="mt-2 text-[13px] leading-relaxed text-muted">{view ? t(view.source === "env" ? "providerKey.env" : view.present ? "providerKey.file" : "providerKey.missing") : t("providerKey.loading")}</p>
    <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("providerKey.shared")}</p>
    {view?.source !== "env" && <form className="mt-2 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void save(); }}>
      <input id={id} type="password" autoComplete="off" spellCheck={false} ref={input} maxLength={4096}
        disabled={!view || busy} onChange={e => { setHasKey(Boolean(e.target.value.trim())); setSaved(false); }}
        className="min-h-11 min-w-0 flex-1 rounded border border-border bg-canvas px-3" />
      <button type="submit" disabled={!view || busy || !hasKey} className="min-h-11 rounded border border-border px-3 text-sm">{t("providerKey.save")}</button>
    </form>}
    {saved && <p role="status" className="mt-2 text-[13px]">{t("providerKey.saved")}</p>}
    {error && <p role="alert" className="mt-2 text-[13px]">{t("providerKey.failed")}</p>}
  </div>;
}
