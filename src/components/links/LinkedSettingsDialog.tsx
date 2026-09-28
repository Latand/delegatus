"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import { Z } from "@/components/layers";

import { OPEN_LINKED_SETTINGS_EVENT } from "./openLinkedSettings";

type State = {
  self: { label: string; publicUrl: string | null; check: { code: string; at: string } | null } | null;
  state: string | null;
  entry: { port: number; publishable: boolean };
  keyOn: boolean;
  tailnetUrl?: string | null;
};

function savedLanHttpAddress(publicUrl: string | null | undefined): boolean {
  if (!publicUrl) return false;
  try {
    const url = new URL(publicUrl);
    return url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "[::1]" && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  } catch { return false; }
}

export function LinkedSettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const [value, setValue] = useState<State | null>(null);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/links").then(async (response) => {
      if (!response.ok) throw new Error("settings unavailable");
      return response.json() as Promise<State>;
    }).then((state) => {
      if (!active) return;
      setValue(state);
      setAddress(state.self?.publicUrl ?? "");
      setLabel(state.self?.label ?? "");
    }).catch(() => { if (active) setError("unavailable"); });
    return () => { active = false; };
  }, []);
  const act = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "unavailable"); return; }
      setValue(result);
    } catch { setError("unavailable"); }
    finally { setBusy(false); }
  };
  const state = error ?? value?.state;
  const shown = state && ["needs-access-key", "needs-remote-entry", "http-public", "open-to-internet", "host-rewritten", "tls-failure", "unverified", "ok", "invalid-address", "save-conflict", "key-failed", "unavailable"].includes(state) ? state : null;
  const browserOrigin = typeof window !== "undefined" && !/^localhost$|^127\.|^\[::1\]$/.test(window.location.hostname) ? window.location.origin : null;
  return (
    <div className={`fixed inset-0 ${Z.modal} flex items-center justify-center bg-black/40 p-0 sm:p-8`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={t("links.title")} data-linked-settings="" className="flex h-full w-full max-w-[640px] flex-col overflow-hidden bg-canvas shadow-2 sm:h-auto sm:max-h-[90vh] sm:rounded-[12px] sm:border sm:border-border">
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-4">
          <h2 className="min-w-0 flex-1 text-title font-bold text-primary">{t("links.title")}</h2>
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-[8px] text-muted hover:bg-sunken"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          <div><h3 className="text-body font-semibold text-primary">{t("links.thisInstall")}</h3><p className="mt-1 text-ui text-muted">{t("links.intro")}</p></div>
          {value ? <p className="rounded-[8px] border border-border bg-sunken px-3 py-2 text-ui text-primary">{value.entry.publishable ? t("links.proxyTarget", { port: value.entry.port }) : t("links.noProxyTarget")}</p> : error ? null : <p className="text-ui text-muted">{t("common.loading")}</p>}
          <label className="block text-ui font-semibold text-primary">{t("links.label")}<input value={label} onChange={(event) => setLabel(event.target.value)} className="mt-1 block h-11 w-full rounded-[8px] border border-border bg-raised px-3 font-normal text-primary" /></label>
          <label className="block text-ui font-semibold text-primary">{t("links.address")}<input value={address} onChange={(event) => setAddress(event.target.value)} type="url" placeholder="https://delegatus.example.com" className="mt-1 block h-11 w-full rounded-[8px] border border-border bg-raised px-3 font-normal text-primary" /></label>
          {savedLanHttpAddress(value?.self?.publicUrl) ? <p data-linked-http-warning="" role="note" className="rounded-[8px] bg-warning-soft px-3 py-2 text-ui text-warning">{t("links.httpLanWarning")}</p> : null}
          {browserOrigin ? <button type="button" className="block text-left text-ui text-accent hover:underline" onClick={() => setAddress(browserOrigin)}>{t("links.usePage", { address: browserOrigin })}</button> : null}
          {value?.tailnetUrl ? <button type="button" className="block text-left text-ui text-accent hover:underline" onClick={() => setAddress(value.tailnetUrl!)}>{t("links.useTailnet", { address: value.tailnetUrl })}</button> : null}
          {shown ? <p role="status" data-linked-state={shown} className={`rounded-[8px] px-3 py-2 text-ui ${["needs-access-key", "needs-remote-entry", "open-to-internet", "http-public"].includes(shown) ? "bg-danger/10 text-danger" : "bg-sunken text-primary"}`}>{t(`links.state.${shown}` as "links.state.ok")}</p> : null}
          {value?.self?.check?.at ? <p className="text-ui text-muted">{t("links.checkedAt", { date: new Date(value.self.check.at).toLocaleString() })}</p> : null}
          <div className="flex flex-wrap gap-2">
            {!value?.keyOn ? <button type="button" disabled={busy} onClick={() => void act({ action: "key" })} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.turnOnKey")}</button> : null}
            <button type="button" disabled={busy || !value} onClick={() => void act({ action: "save", publicUrl: address, label })} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.save")}</button>
            <button type="button" disabled={busy || !value?.self?.publicUrl} onClick={() => void act({ action: "check" })} className="min-h-11 rounded-[8px] border border-border px-4 text-ui font-semibold text-primary disabled:opacity-50">{t("links.check")}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function LinkedSettingsHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_LINKED_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_LINKED_SETTINGS_EVENT, onOpen);
  }, []);
  return open ? <LinkedSettingsDialog onClose={() => setOpen(false)} /> : null;
}
