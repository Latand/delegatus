"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";

async function readConsent(): Promise<boolean> {
  const response = await fetch("/api/subscription-api-consent", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error();
  const body = await response.json(); if (typeof body.enabled !== "boolean") throw Error();
  return body.enabled;
}
export function SubscriptionApiSetting() {
  const { t } = useLocale();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let disposed = false;
    readConsent().then(value => {
      if (!disposed) setEnabled(value);
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, []);
  const save = async (next: boolean) => {
    if (pending.current || enabled === null) return;
    pending.current = true; setSaving(true); setError(false);
    try {
      const response = await fetch("/api/subscription-api-consent", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw Error();
      const body = await response.json(); if (typeof body.enabled !== "boolean") throw Error();
      setEnabled(body.enabled);
    } catch {
      setError(true);
      // A lost acknowledgement can follow a durable write. Read the choice
      // before offering another change, including a subsequent revocation.
      try { setEnabled(await readConsent()); } catch { setEnabled(null); }
    }
    finally { pending.current = false; setSaving(false); }
  };
  return <section data-subscription-api="" className="mt-5 border-t border-border pt-4">
    <h3 className="text-sm font-semibold">{t("subscriptionApi.title")}</h3>
    <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-semibold">
      {t("subscriptionApi.label")}<input type="checkbox" role="switch" aria-label={t("subscriptionApi.label")} checked={enabled === true} disabled={enabled === null || saving} onChange={event => void save(event.target.checked)} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
    </label>
    <p className="my-3 break-words text-[13px] leading-relaxed">{t("subscriptionApi.usage")}</p>
    <p className="mt-2 text-[13px] text-muted">{t("subscriptionApi.default")}</p>
    <p className="my-3 break-words text-[13px] leading-relaxed">{t("subscriptionApi.memory")}</p>
    {error && <p role="alert" className="mt-3 text-sm">{t("telemetry.error")}</p>}
  </section>;
}
