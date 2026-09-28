"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import { Z } from "@/components/layers";

import { OPEN_LINKED_SETTINGS_EVENT } from "./openLinkedSettings";
import { LinkConnectForm } from "./LinkConnectForm";

type State = {
  self: { label: string; publicUrl: string | null; check: { code: string; at: string } | null } | null;
  state: string | null;
  entry: { port: number; publishable: boolean };
  keyOn: boolean;
  tailnetUrl?: string | null;
};
type SharedState = { shared: { v: 1; all: boolean; projects: string[] }; known: { key: string; name: string }[]; states: { id: string; label: string; projects: { key: string; name: string; state: string }[] }[] };
type PeerState = { peers: { id: string; label: string; url: string; state: string; error: string | null; lastCall: number | null }[] };
type GrantState = { grants: { id: string; label: string; requests: number; today: number; sevenDays: number; lastUsed: number | null }[] };
type CodeState = { id: string; expiresAt: number; wrongAttempts: number; used: boolean; burned: boolean };

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
  const [notice, setNotice] = useState<string | null>(null);
  const [shared, setShared] = useState<SharedState | null>(null);
  const [peers, setPeers] = useState<PeerState | null>(null);
  const [grants, setGrants] = useState<GrantState | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [codeStatus, setCodeStatus] = useState<CodeState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const codeFinished = code !== null && (codeStatus?.used === true || now >= code.expiresAt);
  useEffect(() => {
    if (!code || codeFinished) return;
    let active = true;
    let refreshed = false;
    const id = code.code.slice(0, 6);
    const read = async () => {
      try {
        const response = await fetch("/api/links/codes");
        if (!response.ok) return;
        const result = await response.json() as { codes: CodeState[] };
        if (active) {
          const status = result.codes.find((row) => row.id === id) ?? null;
          if (status?.used && !refreshed) {
            refreshed = true;
            void refresh().catch(() => setError("unavailable"));
          }
          setCodeStatus(status);
        }
      } catch { /* The next open-panel read retries. */ }
    };
    void read();
    const poll = window.setInterval(() => void read(), 3000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; window.clearInterval(poll); window.clearInterval(tick); };
  }, [code?.code, codeFinished]);
  const refresh = async () => {
    const [s, p, g] = await Promise.all([fetch("/api/links/shared"), fetch("/api/links/peers"), fetch("/api/links/grants")]);
    if (!s.ok || !p.ok || !g.ok) throw new Error("unavailable");
    setShared(await s.json() as SharedState);
    setPeers(await p.json() as PeerState);
    setGrants(await g.json() as GrantState);
  };
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
    void refresh().catch(() => { if (active) setError("unavailable"); });
    return () => { active = false; };
  }, []);
  const act = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "unavailable"); await refresh().catch(() => {}); return; }
      setValue(result);
    } catch { setError("unavailable"); }
    finally { setBusy(false); }
  };
  const linkedAction = async (url: string, method: "POST" | "PATCH" | "DELETE", body?: object): Promise<boolean> => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "unavailable"); await refresh().catch(() => {}); return false; }
      if (url === "/api/links/codes" && result.code) { setCodeStatus(null); setCode(result); setNow(Date.now()); }
      if (result.warned === true) setNotice("remove-warning");
      await refresh();
      return true;
    } catch { setError("unavailable"); return false; }
    finally { setBusy(false); }
  };
  const share = (change: { all: boolean } | { project: string; enabled: boolean }) => void linkedAction("/api/links/shared", "PATCH", change);
  const projects = shared ? [...new Map<string, { key: string; name: string; local: boolean }>([
    ...shared.states.flatMap((peer) => peer.projects.map((project) => [project.key, { key: project.key, name: project.name, local: false }] as const)),
    ...shared.known.map((project) => [project.key, { ...project, local: true }] as const),
  ]).values()].sort((a, b) => a.name.localeCompare(b.name)) : [];
  const state = error ?? value?.state;
  const shown = state && ["needs-access-key", "needs-remote-entry", "http-public", "open-to-internet", "host-rewritten", "tls-failure", "unverified", "ok", "invalid-address", "save-conflict", "key-failed", "unavailable"].includes(state) ? state : null;
  const linkError = error && !shown ? (
    error === "invalid-code" ? t("links.error.invalidCode") :
    error === "peer-open" ? t("links.error.peerOpen") :
    error === "unreachable" ? t("links.error.unreachable") :
    error === "not-delegatus" || error === "version" ? t("links.error.version") :
    error === "already-linked" ? t("links.error.alreadyLinked") :
    error === "code-spent" ? t("links.error.codeSpent") :
    error === "rate-limited" ? t("links.error.rateLimited") :
    error === "revoked" ? t("links.error.revoked") :
    error === "store-changed" ? t("links.error.storeChanged") :
    error === "grant-cleanup-needed" ? t("links.error.grantCleanupNeeded") :
    error === "cannot-share" ? t("links.cannotShare") :
    error === "unauthorized" ? t("links.error.unauthorized") : t("links.state.unavailable")
  ) : null;
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
          {linkError ? <p role="alert" className="rounded-[8px] bg-danger/10 px-3 py-2 text-ui text-danger">{linkError}</p> : null}
          {notice ? <p role="status" className="rounded-[8px] bg-warning-soft px-3 py-2 text-ui text-warning">{t("links.removeWarning")}</p> : null}
          {value?.self?.check?.at ? <p className="text-ui text-muted">{t("links.checkedAt", { date: new Date(value.self.check.at).toLocaleString() })}</p> : null}
          <div className="flex flex-wrap gap-2">
            {!value?.keyOn ? <button type="button" disabled={busy} onClick={() => void act({ action: "key" })} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.turnOnKey")}</button> : null}
            <button type="button" disabled={busy || !value} onClick={() => void act({ action: "save", publicUrl: address, label })} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.save")}</button>
            <button type="button" disabled={busy || !value?.self?.publicUrl} onClick={() => void act({ action: "check" })} className="min-h-11 rounded-[8px] border border-border px-4 text-ui font-semibold text-primary disabled:opacity-50">{t("links.check")}</button>
          </div>
          <section className="space-y-3 border-t border-border pt-5" aria-label={t("links.pairing")}>
            <h3 className="text-body font-semibold text-primary">{t("links.pairing")}</h3>
            <p className="text-ui text-muted">{t("links.pairingDescription")}</p>
            <button type="button" disabled={busy || !value?.keyOn || !value.self?.publicUrl || ["needs-remote-entry", "http-public", "open-to-internet"].includes(value.state ?? "")} onClick={() => void linkedAction("/api/links/codes", "POST")} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.allow")}</button>
            {code ? <div className="rounded-[8px] border border-border bg-sunken p-3 text-ui" data-pair-code=""><p>{t("links.codePrompt")}</p><code className="mt-2 block select-all text-title font-bold tracking-wide text-primary">{code.code}</code><p className="mt-2 text-muted">{t("links.codeExpires", { date: new Date(code.expiresAt).toLocaleTimeString() })}</p><p role="status" data-code-state={codeStatus?.burned ? "burned" : codeStatus?.used ? "used" : now >= code.expiresAt ? "expired" : "open"} className="mt-2 text-muted">{codeStatus?.burned ? t("links.codeBurned") : codeStatus?.used ? t("links.codeUsed") : now >= code.expiresAt ? t("links.codeExpired") : codeStatus?.wrongAttempts ? t("links.wrongAttempts", { count: codeStatus.wrongAttempts }) : t("links.noWrongAttempts")}</p><button type="button" disabled={busy} onClick={() => { void linkedAction(`/api/links/codes?id=${encodeURIComponent(code.code.slice(0, 6))}`, "DELETE").then((removed) => { if (removed) { setCode(null); setCodeStatus(null); } }); }} className="mt-2 min-h-11 rounded-[8px] border border-border px-3">{t("links.cancelCode")}</button></div> : null}
            <LinkConnectForm busy={busy} onConnect={(input) => void linkedAction("/api/links/peers", "POST", input)} />
            {peers?.peers.map((peer) => <div key={peer.id} className="rounded-[8px] border border-border p-3 text-ui" data-linked-peer={peer.state}>
              <p className="font-semibold text-primary">{peer.label} · {peer.state === "revoked" ? t("links.revoked") : peer.url}</p>
              {peer.lastCall ? <p className="mt-1 text-muted">{t("links.syncedAt", { date: new Date(peer.lastCall).toLocaleString() })}</p> : null}
              {peer.error ? <p className="text-danger">{peer.error}</p> : null}
              <div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={() => void linkedAction(`/api/links/peers/${encodeURIComponent(peer.id)}`, "POST")} className="min-h-11 rounded-[8px] border border-border px-3 text-primary disabled:opacity-50">{t("links.syncNow")}</button><button type="button" disabled={busy} onClick={() => void linkedAction(`/api/links/peers/${encodeURIComponent(peer.id)}`, "DELETE")} className="min-h-11 rounded-[8px] border border-border px-3 text-primary">{t("links.remove")}</button></div>
            </div>)}
            {grants?.grants.map((grant) => <div key={grant.id} className="flex items-center justify-between gap-2 rounded-[8px] border border-border p-3 text-ui"><span>{grant.label} · {t("links.counts", { today: grant.today, seven: grant.sevenDays })}</span><button type="button" disabled={busy} onClick={() => void linkedAction(`/api/links/grants?id=${encodeURIComponent(grant.id)}`, "DELETE")} className="min-h-11 rounded-[8px] border border-border px-3">{t("links.revoke")}</button></div>)}
          </section>
          <section className="space-y-3 border-t border-border pt-5" aria-label={t("links.sharedProjects")}>
            <h3 className="text-body font-semibold text-primary">{t("links.sharedProjects")}</h3>
            <p className="text-ui text-muted">{t("links.shareDefault")}</p>
            <label className="flex min-h-11 items-center gap-3 text-ui text-primary"><input type="checkbox" checked={shared?.shared.all ?? false} disabled={busy || !shared} onChange={(event) => share({ all: event.target.checked })} />{t("links.shareAll")}</label>
            {projects.map((project) => <div key={project.key} className="rounded-[8px] border border-border px-3 py-2 text-ui" data-shared-project={project.key}>
              <label className="flex min-h-10 items-center gap-3 text-primary"><input type="checkbox" checked={project.local && (shared!.shared.all || shared!.shared.projects.includes(project.key))} disabled={busy || !project.local || shared!.shared.all} onChange={(event) => share({ project: project.key, enabled: event.target.checked })} /><span>{project.name}</span></label>
              {shared?.states.map((peer) => { const state = peer.projects.find((row) => row.key === project.key)?.state; return state ? <p key={peer.id} className="pl-7 text-muted" data-share-state={state}>{t(state === "linked" ? "links.linked" : state === "only-here" ? "links.onlyHere" : "links.onlyThere", { peer: peer.label })}</p> : null; })}
            </div>)}
            {shared && !shared.known.length ? <p className="text-ui text-muted">{t("links.cannotShare")}</p> : null}
          </section>
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
