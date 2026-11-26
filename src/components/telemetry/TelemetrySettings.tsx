"use client";
import { createPortal } from "react-dom";
import { Z } from "@/components/layers";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSettingsWindowShown } from "@/components/settings/openSettings";
import { useLocale } from "@/lib/i18n";
import { telemetryNotice } from "../../../bin/telemetry-notice.mjs";
/* The event the install notice and every older caller open «Privacy» with; the Settings window answers it. */
export const OPEN_TELEMETRY_SETTINGS_EVENT = "delegatus:open-settings";
export const openTelemetrySettings = () => window.dispatchEvent(new Event(OPEN_TELEMETRY_SETTINGS_EVENT));
type Status = { locked: boolean; noticeDismissed: boolean };
/* Where the notice is drawn while the setup guide is open: the guide's own line above its footer. Fixed to the
   bottom of the window it lies on the guide's footer, and on a phone it takes the press meant for Continue. */
let guideSlot: HTMLElement | null = null;
const slotWatchers = new Set<() => void>();
function setGuideSlot(next: HTMLElement | null): void {
  if (guideSlot === next) return;
  guideSlot = next;
  for (const watcher of slotWatchers) watcher();
}
/** The setup guide's place for the notice: the dialog mounts it between its body and its footer. Empty, it takes no room. */
export function TelemetryNoticeSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    setGuideSlot(node);
    /* A guide that replaces another has registered its own place by the time the first one leaves. */
    return () => { if (guideSlot === node) setGuideSlot(null); };
  }, []);
  return <div ref={ref} data-telemetry-notice-slot="" className="contents" />;
}
/* The first-start disclosure of the install ping. Its button opens «Privacy», where the switches live;
   it steps aside while the Settings window is on screen, and into the setup guide while that is open. */
export function TelemetrySettingsHost() {
  const { t, locale } = useLocale();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const shown = useSettingsWindowShown();
  const slot = useSyncExternalStore((watcher) => { slotWatchers.add(watcher); return () => slotWatchers.delete(watcher); }, () => guideSlot, () => null);
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
  if (!status || status.locked || status.noticeDismissed || shown) return null;
  const failed = error ? <p role="alert">{t("telemetry.error")}</p> : null;
  /* The words are the terminal's too, so the tie is made here: a Ukrainian line never ends on a one-letter word. */
  const words = telemetryNotice[locale].replace(/(^|\s)([вузіайоясВУЗІАЙОЯС])\s/g, "$1$2\u00a0");
  if (slot) {
    const action = "inline-flex min-h-8 shrink-0 items-center rounded-[6px] font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11 max-sm:min-w-11";
    return createPortal(<aside data-telemetry-guide-notice="" className="flex shrink-0 items-center gap-x-4 border-t border-border bg-raised px-4 py-1.5 text-ui leading-[1.45] text-secondary max-sm:flex-col max-sm:items-stretch max-sm:pb-0 max-sm:pt-2.5">
      <div className="min-w-0 flex-1">
        <p>{words}</p>
        {failed}
      </div>
      <div className="flex shrink-0 gap-4">
        <button type="button" className={`${action} text-accent`} onClick={openTelemetrySettings}>{t("settings.section.privacy")}</button>
        <button type="button" className={`${action} text-primary`} onClick={() => void dismiss()}>{t("telemetry.dismiss")}</button>
      </div>
    </aside>, slot);
  }
  return createPortal(<aside data-telemetry-notice="" className={`fixed bottom-4 left-4 right-4 ${Z.toast} mx-auto max-w-2xl rounded-xl border border-border bg-canvas p-4 text-[13px] text-primary shadow-xl`}>
    <p>{words}</p>
    <div className="mt-2 flex gap-3">
      <button type="button" className="min-h-11 font-semibold text-accent" onClick={openTelemetrySettings}>{t("settings.section.privacy")}</button>
      <button type="button" className="min-h-11 min-w-11" onClick={() => void dismiss()}>{t("telemetry.dismiss")}</button>
    </div>
    {failed}
  </aside>, document.body);
}
