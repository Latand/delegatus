"use client";
import { createPortal } from "react-dom";
import { Z } from "@/components/layers";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { telemetryNotice } from "../../../bin/telemetry-notice.mjs";
import { SubscriptionApiSetting } from "./SubscriptionApiSetting";
export const openTelemetrySettings = () => window.dispatchEvent(new Event("delegatus:open-settings"));
type Status = { enabled: boolean; locked: boolean; noticeDismissed: boolean; swarmRules: boolean };
/* The disclosure dialog behind «Install ping» on the header's Settings page
   contains the ping and direct subscription API consent. Shared memory and
   provider keys have their own settings rows. */
export function TelemetrySettingsHost() {
  const { t, locale } = useLocale();
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<false | "general" | "swarm">(false);
  const swarmSetting = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("delegatus:open-settings", show);
    fetch("/api/telemetry").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setStatus).catch(() => setError("general"));
    return () => window.removeEventListener("delegatus:open-settings", show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  useEffect(() => {
    if (error === "swarm") swarmSetting.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  /* The switch and the notice's dismissal show at once (audit B25); a refusal
     puts the stored status back with the error. One write at a time. */
  const saving = useRef(false);
  const save = async (update: Partial<Status>) => {
    if (saving.current || !status) return;
    saving.current = true;
    const before = status;
    setStatus({ ...before, ...update });
    setError(false);
    try {
      const r = await fetch("/api/telemetry", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) });
      if (!r.ok) throw new Error();
      setStatus(await r.json());
    } catch { setStatus(before); setError(update.swarmRules === undefined ? "general" : "swarm"); }
    finally { saving.current = false; }
  };
  if (typeof document === "undefined") return null;
  return createPortal(<>
    {status && !status.locked && !status.noticeDismissed && !open && <aside data-telemetry-notice="" className={`fixed bottom-4 left-4 right-4 ${Z.toast} mx-auto max-w-2xl rounded-xl border border-border bg-canvas p-4 text-[13px] text-primary shadow-xl`}>
      <p>{telemetryNotice[locale]}</p>
      <div className="mt-2 flex gap-3">
        <button type="button" className="min-h-11 font-semibold text-accent" onClick={() => setOpen(true)}>{t("headerMenu.ping")}</button>
        <button type="button" className="min-h-11" onClick={() => void save({ noticeDismissed: true })}>{t("telemetry.dismiss")}</button>
      </div>
      {error && <p role="alert">{t("telemetry.error")}</p>}
    </aside>}
    {open && <div className={`fixed inset-0 ${Z.overlay} flex items-center justify-center bg-black/40 p-4`} onClick={() => setOpen(false)}>
      <section data-telemetry-settings="" role="dialog" aria-modal="true" aria-labelledby="telemetry-title" className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-canvas p-5 text-primary shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4"><h2 id="telemetry-title" className="text-lg font-semibold">{t("headerMenu.ping")}</h2><button type="button" autoFocus className="min-h-11 px-2" onClick={() => setOpen(false)}>{t("telemetry.close")}</button></div>
        {status && !status.locked && <p className="my-4 text-[13px] leading-relaxed">{telemetryNotice[locale]}</p>}
        {status && <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-semibold">
          {t("telemetry.label")}<input type="checkbox" role="switch" aria-label={t("telemetry.label")} checked={status.enabled} disabled={status.locked} onChange={e => void save({ enabled: e.target.checked })} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
        </label>}
        {status?.locked && <p className="mt-3 text-[13px] text-muted">{t("telemetry.locked")}</p>}
        {error === "general" && <p role="alert" className="mt-3 text-sm">{t("telemetry.error")}</p>}
        <SubscriptionApiSetting />
        <div ref={swarmSetting} data-swarm-setting="" className="mt-4 border-t border-border pt-4">
          {status && <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-semibold">
            {t("telemetry.swarm.label")}<input type="checkbox" role="switch" aria-label={t("telemetry.swarm.label")} checked={status.swarmRules ?? false} onChange={e => void save({ swarmRules: e.target.checked })} className="h-6 w-10 shrink-0 accent-[var(--accent)]" />
          </label>}
          {error === "swarm" && <p role="alert" className="mt-2 text-sm">{t("telemetry.error")}</p>}
          <p className="mt-2 text-[13px] leading-relaxed text-secondary">{t("telemetry.swarm.description")}</p>
        </div>
      </section>
    </div>}
  </>, document.body);
}
