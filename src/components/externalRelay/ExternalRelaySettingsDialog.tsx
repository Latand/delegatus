"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { Z } from "@/components/layers";
import { useLocale } from "@/lib/i18n";

import { ExternalRelaySection } from "./ExternalRelaySection";
import { OPEN_EXTERNAL_RELAY_SETTINGS_EVENT } from "./openExternalRelaySettings";

/** The external relay's settings (docs/design/relay.md §B.9), in the shell the linked-installs settings use. */
export function ExternalRelaySettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={`fixed inset-0 ${Z.modal} flex items-center justify-center bg-black/40 p-0 sm:p-8`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={t("externalRelay.title")} data-external-relay-settings="" className="flex h-full w-full max-w-[640px] flex-col overflow-hidden bg-canvas shadow-2 sm:h-auto sm:max-h-[90vh] sm:rounded-[12px] sm:border sm:border-border">
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-4">
          <h2 className="min-w-0 flex-1 text-title font-bold text-primary">{t("externalRelay.title")}</h2>
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-[8px] text-muted hover:bg-sunken"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          <p className="text-ui text-muted">{t("externalRelay.intro")}</p>
          <ExternalRelaySection />
        </div>
      </section>
    </div>
  );
}

export function ExternalRelaySettingsHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EXTERNAL_RELAY_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EXTERNAL_RELAY_SETTINGS_EVENT, onOpen);
  }, []);
  return open ? <ExternalRelaySettingsDialog onClose={() => setOpen(false)} /> : null;
}
