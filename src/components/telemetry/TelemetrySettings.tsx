"use client";
import { createPortal } from "react-dom";
import { Z } from "@/components/layers";
import { useEffect, useRef, useState } from "react";
import { useSettingsWindowShown } from "@/components/settings/openSettings";
import { useLocale } from "@/lib/i18n";
import { telemetryNotice } from "../../../bin/telemetry-notice.mjs";
/* The event the install notice and every older caller open «Privacy» with; the Settings window answers it. */
export const OPEN_TELEMETRY_SETTINGS_EVENT = "delegatus:open-settings";
export const openTelemetrySettings = () => window.dispatchEvent(new Event(OPEN_TELEMETRY_SETTINGS_EVENT));
type Status = { locked: boolean; noticeDismissed: boolean };
/* The first-start disclosure of the install ping. Its button opens «Privacy», where the switches live;
   it steps aside while the Settings window is on screen. */
export function TelemetrySettingsHost() {
  const { t, locale } = useLocale();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const shown = useSettingsWindowShown();
  useEffect(() => {
    fetch("/api/telemetry").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setStatus).catch(() => setError(true));
  }, []);
  /* The dismissal shows at once (audit B25); a refusal puts the stored status back with the error. One write at a time. */
  const saving = useRef(false);
  const dismiss = async () => {
    if (saving.current || !status) return;
    saving.current = true;
    const before = status;
    setStatus({ ...before, noticeDismissed: true });
    setError(false);
    try {
      const r = await fetch("/api/telemetry", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ noticeDismissed: true }) });
      if (!r.ok) throw new Error();
      setStatus(await r.json());
    } catch { setStatus(before); setError(true); }
    finally { saving.current = false; }
  };
  if (typeof document === "undefined") return null;
  return createPortal(<>
    {status && !status.locked && !status.noticeDismissed && !shown && <aside data-telemetry-notice="" className={`fixed bottom-4 left-4 right-4 ${Z.toast} mx-auto max-w-2xl rounded-xl border border-border bg-canvas p-4 text-[13px] text-primary shadow-xl`}>
      <p>{telemetryNotice[locale]}</p>
      <div className="mt-2 flex gap-3">
        <button type="button" className="min-h-11 font-semibold text-accent" onClick={openTelemetrySettings}>{t("settings.section.privacy")}</button>
        <button type="button" className="min-h-11" onClick={() => void dismiss()}>{t("telemetry.dismiss")}</button>
      </div>
      {error && <p role="alert">{t("telemetry.error")}</p>}
    </aside>}
  </>, document.body);
}
