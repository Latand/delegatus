"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import { Z } from "@/components/layers";

import { OPEN_LINKED_SETTINGS_EVENT } from "./openLinkedSettings";
import { LinkConnectForm } from "./LinkConnectForm";
import { LinkCopyButton } from "./LinkCopyButton";
import { LinkStep } from "./LinkStep";
import { connectErrorMessage, isDrawnState, linkSeverity, peerErrorMessage, requestErrorMessage } from "./linkSeverity";
import { mintRefusalMessage } from "./mintRefusal";

type State = {
  self: { label: string; publicUrl: string | null; check: { code: string; at: string } | null } | null;
  state: string | null;
  entry: { port: number; publishable: boolean; localVouches?: boolean };
  keyOn: boolean;
  tailnetUrl?: string | null;
};
type SharedState = { shared: { v: 1; all: boolean; projects: string[] }; known: { key: string; name: string }[]; states: { id: string; label: string; projects: { key: string; name: string; state: string }[] }[] };
type PeerState = { peers: { id: string; label: string; url: string; state: string; error: string | null; lastCall: number | null }[] };
type GrantState = { grants: { id: string; label: string; created: number; requests: number; today: number; sevenDays: number; lastUsed: number | null; lastCall?: number | null; state?: string; error?: string | null }[] };
type Role = "accept" | "connect";
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
  // One error per source, so each answer shows where the action was taken.
  const [loadError, setLoadError] = useState(false);
  const [linkReadError, setLinkReadError] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [connectedTo, setConnectedTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shared, setShared] = useState<SharedState | null>(null);
  const [peers, setPeers] = useState<PeerState | null>(null);
  const [grants, setGrants] = useState<GrantState | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number; address: string | null } | null>(null);
  const [codeStatus, setCodeStatus] = useState<CodeState | null>(null);
  const [mintRefusal, setMintRefusal] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const grantsAtMint = useRef<Set<string>>(new Set());
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
            void refresh().catch(() => setLoadError(true));
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
    }).catch(() => { if (active) setLoadError(true); });
    let readingLinks = false;
    const readLinks = () => {
      if (document.hidden || readingLinks) return;
      readingLinks = true;
      void refresh().then(() => { if (active) setLinkReadError(false); }).catch(() => { if (active) setLinkReadError(true); })
        .finally(() => { readingLinks = false; });
    };
    readLinks();
    const timer = window.setInterval(readLinks, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  // The role is picked once, when the first answers are in: a machine with a
  // saved address or someone connected to it accepts, any other connects.
  const ready = loadError || linkReadError || (value !== null && grants !== null);
  useEffect(() => {
    if (role === null && ready) setRole(value?.self?.publicUrl || grants?.grants.length ? "accept" : "connect");
  }, [ready]);
  const act = async (body: object) => {
    setBusy(true);
    setSelfError(null);
    try {
      const response = await fetch("/api/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setSelfError(result.error ?? "unavailable"); await refresh().catch(() => {}); return; }
      setValue(result);
    } catch { setSelfError("unavailable"); }
    finally { setBusy(false); }
  };
  const linkedAction = async (url: string, method: "POST" | "PATCH" | "DELETE", body?: object): Promise<boolean> => {
    setBusy(true); setLinkError(null); setNotice(null);
    try {
      const response = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json();
      if (!response.ok) { setLinkError(result.error ?? "unavailable"); await refresh().catch(() => {}); return false; }
      if (result.warned === true) setNotice("remove-warning");
      await refresh();
      return true;
    } catch { setLinkError("unavailable"); return false; }
    finally { setBusy(false); }
  };
  // A failed connect is answered under the connect form, never in the line that
  // reports this install's own address.
  const connect = async (input: { url: string; code: string; name: string }) => {
    setBusy(true); setConnectError(null); setConnectedTo(null); setLinkError(null); setNotice(null);
    try {
      const response = await fetch("/api/links/peers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const result = await response.json() as { peer?: { label?: string }; error?: string };
      if (!response.ok) { setConnectError(result.error ?? "unavailable"); await refresh().catch(() => {}); return; }
      setConnectedTo(result.peer?.label ?? input.name ?? input.url);
      await refresh().catch(() => {});
    } catch { setConnectError("unavailable"); }
    finally { setBusy(false); }
  };
  // A refused mint is answered next to the button that asked, and the saved
  // address's state is re-read because the mint ran a fresh check.
  const allow = async () => {
    setBusy(true); setLinkError(null); setNotice(null); setMintRefusal(null);
    try {
      const response = await fetch("/api/links/codes", { method: "POST" });
      const result = await response.json() as { code?: string; expiresAt?: number; error?: string };
      if (!response.ok || !result.code || typeof result.expiresAt !== "number") {
        setMintRefusal(result.error ?? "unavailable");
        const view = await fetch("/api/links").then((reply) => reply.ok ? reply.json() as Promise<State> : null).catch(() => null);
        if (view) setValue(view);
        return;
      }
      grantsAtMint.current = new Set(grants?.grants.map((grant) => grant.id));
      setCodeStatus(null); setCode({ code: result.code, expiresAt: result.expiresAt, address: value?.self?.publicUrl ?? null }); setNow(Date.now());
      await refresh().catch(() => {});
    } catch { setMintRefusal("unavailable"); }
    finally { setBusy(false); }
  };
  const share = (change: { all: boolean } | { project: string; enabled: boolean }) => void linkedAction("/api/links/shared", "PATCH", change);
  const projects = shared ? [...new Map<string, { key: string; name: string; local: boolean }>([
    ...shared.states.flatMap((peer) => peer.projects.map((project) => [project.key, { key: project.key, name: project.name, local: false }] as const)),
    ...shared.known.map((project) => [project.key, { ...project, local: true }] as const),
  ]).values()].sort((a, b) => a.name.localeCompare(b.name)) : [];
  const state = selfError ?? value?.state;
  const shown = isDrawnState(state) ? state : null;
  const severity = shown ? linkSeverity(shown, value?.entry.localVouches) : null;
  const savedAddress = value?.self?.publicUrl ?? null;
  const selfRequestError = selfError && !shown ? requestErrorMessage(t, selfError) : null;
  const browserOrigin = typeof window !== "undefined" && !/^localhost$|^127\.|^\[::1\]$/.test(window.location.hostname) ? window.location.origin : null;
  const codeState = codeStatus?.burned ? "burned" : codeStatus?.used ? "used" : code && now >= code.expiresAt ? "expired" : "open";
  const newGrant = code && codeStatus?.used ? (grants?.grants ?? []).filter((grant) => !grantsAtMint.current.has(grant.id)).sort((a, b) => b.created - a.created)[0] ?? null : null;
  const stateText = shown === "unverified" && severity === "warning" ? t("links.state.unverified")
    : shown === "unverified" ? t("links.state.unverifiedBlocking", { port: value?.entry.port ?? 0 })
    : shown ? t(`links.state.${shown}` as "links.state.ok") : null;
  const stateStyle = severity === "ok" ? "bg-success-soft text-success" : severity === "warning" ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger";
  const pickRole = (next: Role) => setRole(next);
  const roles: { id: Role; title: string; hint: string }[] = [
    { id: "accept", title: t("links.role.accept"), hint: t("links.role.acceptHint") },
    { id: "connect", title: t("links.role.connect"), hint: t("links.role.connectHint") },
  ];
  const noGrantsOrPeers = peers !== null && grants !== null && !peers.peers.length && !grants.grants.length;
  return (
    <div className={`fixed inset-0 ${Z.modal} flex items-center justify-center bg-black/40 p-0 sm:p-8`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={t("links.title")} data-linked-settings="" className="flex h-full w-full max-w-[640px] flex-col overflow-hidden bg-canvas shadow-2 sm:h-auto sm:max-h-[90vh] sm:rounded-[12px] sm:border sm:border-border">
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-4">
          <h2 className="min-w-0 flex-1 text-title font-bold text-primary">{t("links.title")}</h2>
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-[8px] text-muted hover:bg-sunken"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          <p className="text-ui text-muted">{t("links.intro")}</p>
          {loadError || linkReadError ? <p role="alert" data-linked-state="unavailable" data-linked-severity="error" className="rounded-[8px] bg-danger-soft px-3 py-2 text-ui text-danger">{t("links.state.unavailable")}</p> : null}
          {shown === "open-to-internet" ? <p data-linked-banner="" role="note" className="rounded-[8px] bg-danger-soft px-3 py-2 text-ui text-danger">{t("links.state.open-to-internet")}</p> : null}
          <div role="radiogroup" aria-label={t("links.role.label")} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {roles.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={role === option.id}
                data-linked-role={option.id}
                tabIndex={role === option.id || (role === null && option.id === "accept") ? 0 : -1}
                disabled={role === null}
                onClick={() => pickRole(option.id)}
                onKeyDown={(event) => {
                  if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
                    event.preventDefault();
                    pickRole(option.id === "accept" ? "connect" : "accept");
                    (event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-linked-role="${option.id === "accept" ? "connect" : "accept"}"]`))?.focus();
                  }
                }}
                className={`min-h-11 rounded-[8px] border px-3 py-2 text-left ${role === option.id ? "border-accent bg-accent/5" : "border-border"}`}
              >
                <span className="block text-body font-semibold text-primary">{option.title}</span>
                <span className="mt-1 block text-ui text-muted">{option.hint}</span>
              </button>
            ))}
          </div>
          {role === null && !loadError ? <p className="text-ui text-muted">{t("common.loading")}</p> : null}
          <div hidden={role !== "accept"} data-linked-panel="accept">
            <ol className="space-y-5" aria-label={t("links.pairing")}>
              <LinkStep n={1} title={t("links.accept.step1")}>
                <p className="text-ui text-muted">{t("links.accept.step1Body")}</p>
                {value ? <p className="rounded-[8px] border border-border bg-sunken px-3 py-2 text-ui text-primary">{value.entry.publishable ? t("links.proxyTarget", { port: value.entry.port }) : t("links.noProxyTarget")}</p> : loadError ? null : <p className="text-ui text-muted">{t("common.loading")}</p>}
                <label className="block text-ui font-semibold text-primary">{t("links.label")}<input value={label} onChange={(event) => setLabel(event.target.value)} className="mt-1 block h-11 w-full rounded-[8px] border border-border bg-raised px-3 font-normal text-primary" /></label>
                <label className="block text-ui font-semibold text-primary">{t("links.address")}<input value={address} onChange={(event) => setAddress(event.target.value)} type="url" placeholder="https://delegatus.example.com" className="mt-1 block h-11 w-full rounded-[8px] border border-border bg-raised px-3 font-normal text-primary" /></label>
                {savedLanHttpAddress(savedAddress) ? <p data-linked-http-warning="" role="note" className="rounded-[8px] bg-warning-soft px-3 py-2 text-ui text-warning">{t("links.httpLanWarning")}</p> : null}
                {browserOrigin ? <button type="button" className="block text-left text-ui text-accent hover:underline" onClick={() => setAddress(browserOrigin)}>{t("links.usePage", { address: browserOrigin })}</button> : null}
                {value?.tailnetUrl ? <button type="button" className="block text-left text-ui text-accent hover:underline" onClick={() => setAddress(value.tailnetUrl!)}>{t("links.useTailnet", { address: value.tailnetUrl })}</button> : null}
                {shown && severity && stateText ? <div role={severity === "error" ? "alert" : "status"} data-linked-state={shown} data-linked-severity={severity} className={`space-y-1 rounded-[8px] px-3 py-2 text-ui ${stateStyle}`}>
                  {severity === "blocking" ? <p className="font-semibold">{t("links.severity.blocking")}</p> : severity === "warning" ? <p className="font-semibold">{t("links.severity.warning")}</p> : null}
                  <p>{stateText}</p>
                  {severity === "warning" && savedAddress ? <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 break-words">{t("links.checkFromOther", { address: savedAddress })}</p><LinkCopyButton text={savedAddress} label={t("links.copyAddress")} /></div> : null}
                </div> : null}
                {selfRequestError ? <p role="alert" data-linked-severity="error" className="rounded-[8px] bg-danger-soft px-3 py-2 text-ui text-danger">{selfRequestError}</p> : null}
                {value?.self?.check?.at ? <p className="text-ui text-muted">{t("links.checkedAt", { date: new Date(value.self.check.at).toLocaleString() })}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {!value?.keyOn ? <button type="button" disabled={busy} onClick={() => void act({ action: "key" })} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.turnOnKey")}</button> : null}
                  <button type="button" disabled={busy || !value} onClick={() => void act({ action: "save", publicUrl: address, label })} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.save")}</button>
                  <button type="button" disabled={busy || !value?.self?.publicUrl} onClick={() => void act({ action: "check" })} className="min-h-11 rounded-[8px] border border-border px-4 text-ui font-semibold text-primary disabled:opacity-50">{t("links.check")}</button>
                </div>
              </LinkStep>
              <LinkStep n={2} title={t("links.accept.step2")} waiting={value !== null && !savedAddress}>
                <p className="text-ui text-muted">{value !== null && !savedAddress ? t("links.accept.step2Waiting") : t("links.accept.step2Body")}</p>
                <p className="text-ui text-muted">{t("links.pairingDescription")}</p>
                <button type="button" disabled={busy || !value?.keyOn || !value.self?.publicUrl || ["needs-remote-entry", "http-public", "open-to-internet"].includes(value.state ?? "")} onClick={() => void allow()} className="min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50">{t("links.allow")}</button>
                {mintRefusal ? <p role="alert" data-linked-mint-refusal={mintRefusal} className="rounded-[8px] bg-danger-soft px-3 py-2 text-ui text-danger">{mintRefusalMessage(t, mintRefusal)}</p> : null}
              </LinkStep>
              <LinkStep n={3} title={t("links.accept.step3")} waiting={!code}>
                {code ? <>
                  <p className="text-ui text-muted">{t("links.accept.step3Body")}</p>
                  <div className="space-y-2 rounded-[8px] border border-border bg-sunken p-3 text-ui" data-pair-code="">
                    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
                      {code.address ? <>
                        <span className="text-muted">{t("links.codeAddress")}</span>
                        <span data-pair-address="" className="break-all font-mono select-all text-primary">{code.address}</span>
                        <LinkCopyButton text={code.address} label={t("links.copyAddress")} />
                      </> : null}
                      <span className="text-muted">{t("links.codeLabel")}</span>
                      <code data-pair-code-value="" className="break-all select-all text-title font-bold tracking-wide text-primary">{code.code}</code>
                      <LinkCopyButton text={code.code} label={t("links.copyCode")} />
                    </div>
                    <p className="text-muted">{t("links.codeExpires", { date: new Date(code.expiresAt).toLocaleTimeString() })}</p>
                    {newGrant ? <p role="status" data-code-state="used" data-linked-connected="" className="rounded-[8px] bg-success-soft px-3 py-2 text-success">{t("links.connectedHere", { name: newGrant.label })}</p>
                      : <p role="status" data-code-state={codeState} className="text-muted">{codeState === "burned" ? t("links.codeBurned") : codeState === "used" ? t("links.codeUsed") : codeState === "expired" ? t("links.codeExpired") : codeStatus?.wrongAttempts ? t("links.wrongAttempts", { count: codeStatus.wrongAttempts }) : t("links.noWrongAttempts")}</p>}
                    <button type="button" disabled={busy} onClick={() => { void linkedAction(`/api/links/codes?id=${encodeURIComponent(code.code.slice(0, 6))}`, "DELETE").then((removed) => { if (removed) { setCode(null); setCodeStatus(null); } }); }} className="min-h-11 rounded-[8px] border border-border px-3">{t("links.cancelCode")}</button>
                  </div>
                </> : <p className="text-ui text-muted">{t("links.accept.step3Waiting")}</p>}
              </LinkStep>
            </ol>
          </div>
          <div hidden={role !== "connect"} data-linked-panel="connect">
            <ol className="space-y-5" aria-label={t("links.pairing")}>
              <LinkStep n={1} title={t("links.connectStep.step1")}>
                <p className="text-ui text-muted">{t("links.connectStep.step1Body")}</p>
              </LinkStep>
              <LinkStep n={2} title={t("links.connectStep.step2")}>
                <p className="text-ui text-muted">{t("links.connectStep.step2Body")}</p>
                <LinkConnectForm busy={busy} onConnect={(input) => void connect(input)} />
                {connectError ? <p role="alert" data-linked-connect-error={connectError} className="rounded-[8px] bg-danger-soft px-3 py-2 text-ui text-danger">{connectErrorMessage(t, connectError)}</p> : null}
              </LinkStep>
              <LinkStep n={3} title={t("links.connectStep.step3")} waiting={!connectedTo}>
                {connectedTo ? <p role="status" data-linked-connected="" className="rounded-[8px] bg-success-soft px-3 py-2 text-ui text-success">{t("links.connectedThere", { name: connectedTo })}</p> : <p className="text-ui text-muted">{t("links.connectStep.step3Waiting")}</p>}
              </LinkStep>
            </ol>
          </div>
          <section className="space-y-3 border-t border-border pt-5" aria-label={t("links.connectedMachines")}>
            <h3 className="text-body font-semibold text-primary">{t("links.connectedMachines")}</h3>
            {linkError ? <p role="alert" className="rounded-[8px] bg-danger-soft px-3 py-2 text-ui text-danger">{requestErrorMessage(t, linkError)}</p> : null}
            {notice ? <p role="status" className="rounded-[8px] bg-warning-soft px-3 py-2 text-ui text-warning">{t("links.removeWarning")}</p> : null}
            {noGrantsOrPeers ? <p className="text-ui text-muted">{t("links.connectedMachinesEmpty")}</p> : null}
            {peers?.peers.map((peer) => <div key={peer.id} className="rounded-[8px] border border-border p-3 text-ui" data-linked-peer={peer.state}>
              <p className="font-semibold text-primary">{t("links.peerRow", { name: peer.label })}</p>
              <p className="text-muted">{peer.state === "revoked" ? t("links.revoked") : peer.url}</p>
              <p className="mt-1 text-muted" data-linked-sync={peer.state === "failing" ? "failing" : peer.lastCall ? "synced" : "waiting"}>{peer.lastCall ? t("links.syncedAt", { date: new Date(peer.lastCall).toLocaleString() }) : t("links.syncWaiting")}</p>
              {peer.error ? <p className="mt-1 text-danger" data-linked-peer-error={peer.error}>{peerErrorMessage(t, peer.error, peer.label)}</p> : null}
              <div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={() => void linkedAction(`/api/links/peers/${encodeURIComponent(peer.id)}`, "POST")} className="min-h-11 rounded-[8px] border border-border px-3 text-primary disabled:opacity-50">{t("links.syncNow")}</button><button type="button" disabled={busy} onClick={() => void linkedAction(`/api/links/peers/${encodeURIComponent(peer.id)}`, "DELETE")} className="min-h-11 rounded-[8px] border border-border px-3 text-primary">{t("links.remove")}</button></div>
            </div>)}
            {grants?.grants.map((grant) => <div key={grant.id} data-linked-grant="" className="flex items-center justify-between gap-2 rounded-[8px] border border-border p-3 text-ui"><div><p>{t("links.grantRow", { name: grant.label })} · {t("links.counts", { today: grant.today, seven: grant.sevenDays })}</p><p className="mt-1 text-muted" data-linked-sync={grant.error ? "failing" : grant.lastCall ? "synced" : "waiting"}>{grant.lastCall ? t("links.syncedAt", { date: new Date(grant.lastCall).toLocaleString() }) : t("links.syncWaiting")}</p>{grant.error ? <p className="mt-1 text-danger" data-linked-grant-error={grant.error}>{peerErrorMessage(t, grant.error, grant.label)}</p> : null}</div><button type="button" disabled={busy} onClick={() => void linkedAction(`/api/links/grants?id=${encodeURIComponent(grant.id)}`, "DELETE")} className="min-h-11 rounded-[8px] border border-border px-3">{t("links.revoke")}</button></div>)}
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
