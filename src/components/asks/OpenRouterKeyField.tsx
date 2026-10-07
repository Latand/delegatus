"use client";
import { useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";

/** The field that stores the one installation key Asks-you and shared memory
    share, opened where the header menu asks for it. Never read into an input:
    the field starts empty and is emptied again on every submit. */
export function OpenRouterKeyField({ size = "menu", onSaved }: { size?: "menu" | "sheet"; onSaved?: () => void }) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"providerKey.failed" | "providerKey.invalid" | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    const submitted = input.current?.value ?? "";
    if (input.current) input.current.value = "";
    setHasKey(false); setBusy(true); setError(null); setSaved(false);
    try {
      const response = await fetch("/api/asks-you/key", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: submitted }) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(response.status === 400 && body.error === "invalid_key" ? "providerKey.invalid" : "providerKey.failed");
        return;
      }
      setSaved(true);
      window.dispatchEvent(new Event("delegatus:provider-key-changed"));
      onSaved?.();
    } catch { setError("providerKey.failed"); }
    finally { setBusy(false); }
  };
  const sheet = size === "sheet";
  const control = sheet ? "min-h-11 text-body" : "h-7 text-[11.5px]";
  return <div data-provider-key="" className="flex w-full flex-col gap-1">
    <form className="flex w-full gap-1" onSubmit={e => { e.preventDefault(); void save(); }}>
      <input type="password" autoComplete="off" spellCheck={false} ref={input} maxLength={4096} aria-label={t("providerKey.label")}
        disabled={busy} onChange={e => { setHasKey(Boolean(e.target.value.trim())); setSaved(false); }}
        className={`${control} min-w-0 flex-1 rounded-[7px] border border-border bg-canvas px-2 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`} />
      <button type="submit" disabled={busy || !hasKey}
        className={`${control} shrink-0 whitespace-nowrap rounded-[7px] border border-border bg-card px-2.5 font-semibold text-primary hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}>{t("providerKey.save")}</button>
    </form>
    {saved && <p role="status" className={sheet ? "text-label" : "text-[11px]"}>{t("providerKey.saved")}</p>}
    {error && <p role="alert" className={`${sheet ? "text-label" : "text-[11px]"} leading-snug text-danger`}>{t(error)}</p>}
  </div>;
}
