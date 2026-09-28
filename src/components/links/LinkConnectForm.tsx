"use client";

import { useState } from "react";
import { useLocale } from "@/lib/i18n";

export function LinkConnectForm({ busy, onConnect }: { busy: boolean; onConnect: (input: { url: string; code: string; name: string }) => void }) {
  const { t } = useLocale();
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  return <form className="space-y-2 rounded-[8px] border border-border p-3" onSubmit={(event) => { event.preventDefault(); if (url && code && !busy) onConnect({ url, code, name }); }}>
    <h4 className="text-ui font-semibold text-primary">{t("links.connect")}</h4>
    <input aria-label={t("links.peerAddress")} type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://peer.example.test" className="h-11 w-full rounded-[8px] border border-border bg-raised px-3 text-ui text-primary" />
    <input aria-label={t("links.peerCode")} value={code} onChange={(event) => setCode(event.target.value)} placeholder="R4TZ7M-K7QM9-XTD2P" className="h-11 w-full rounded-[8px] border border-border bg-raised px-3 text-ui text-primary" />
    <input aria-label={t("links.peerName")} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("links.peerName")} className="h-11 w-full rounded-[8px] border border-border bg-raised px-3 text-ui text-primary" />
    <button type="submit" disabled={busy || !url || !code} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.connect")}</button>
  </form>;
}
