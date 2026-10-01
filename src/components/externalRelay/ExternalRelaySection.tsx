"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { effortTierLabel } from "@/components/builderCopy";
import { accountConnected } from "@/components/onboarding/EnginesStep";
import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { effortScale } from "@/lib/agent/efforts";
import { defaultModelFor, ENGINE_MODELS } from "@/lib/agent/models";
import { KNOWN_RELAYS, verifyUrlAllowed, type KnownRelayInfo } from "@/lib/externalRelay/knownRelays";
import { useLocale, type TFunction } from "@/lib/i18n";

/**
 * The external relay's operator surface (docs/design/relay.md §B.9): pair
 * this install with a relay service, then choose per target the engine,
 * model, effort and concurrency that answer it, and read the poller state,
 * the last outcome and the last progress label. The settings dialog and the
 * setup guide's optional step both render it. Everything the relay service
 * sends (its name, the owner, target names, progress) is shown as plain text.
 */

export type RelayEngine = "claude" | "codex";
type Owner = { namespace: string; id: string; display_name: string; handle: string | null };
type Target = {
  id: string;
  name: string;
  answered_by: "install" | "service";
  fallback: "service" | "none";
  enabled: boolean;
  engine: RelayEngine | null;
  model: string | null;
  effort: string | null;
  project: string | null;
  concurrency: number;
  hardCapMinutes: number;
};
export type RelayView = {
  id: string;
  origin: string;
  name: string;
  description: string;
  owner: Owner;
  pairedAt: string;
  paused: boolean;
  targets: Target[];
};
export type PendingView = {
  id: string;
  origin: string;
  name: string;
  description: string;
  code: string;
  verify_url: string | null;
  expires_at: string;
  poll_interval_s: number;
  owner?: Owner;
};
type StatusRow = {
  id: string;
  state: { state: string; lastOutcome: string | null; lastOutcomeAt: string | null; lastProgress: { targetId: string; label: string; at: string } | null };
  running: Record<string, number>;
};
export type RelayState = { relays: RelayView[]; pending: PendingView[]; status: StatusRow[] };
type PairingStatus = { status: "pending" | "awaiting_install" | "completed" | "expired" | "denied" | "cancelled"; owner?: Owner; reason?: string };

const ERROR_KEYS: Record<string, Parameters<TFunction>[0]> = {
  invalid_address: "externalRelay.error.invalidAddress",
  http_public: "externalRelay.error.httpPublic",
  unreachable: "externalRelay.error.unreachable",
  unavailable: "externalRelay.error.unavailable",
  malformed: "externalRelay.error.malformed",
  too_large: "externalRelay.error.malformed",
  cross_origin: "externalRelay.error.crossOrigin",
  invalid_api_path: "externalRelay.error.crossOrigin",
  unsupported_version: "externalRelay.error.version",
  owner_changed: "externalRelay.error.ownerChanged",
  not_found: "externalRelay.error.notFound",
  staging: "externalRelay.error.staging",
  operator_only: "externalRelay.error.operatorOnly",
  owner_required: "externalRelay.error.operatorOnly",
  rate_limited: "externalRelay.error.rateLimited",
  refused_here: "externalRelay.error.refusedHere",
  local_error: "externalRelay.error.local",
};
export function relayErrorText(t: TFunction, code: string): string {
  const key = ERROR_KEYS[code];
  return key ? t(key) : t("externalRelay.error.other", { code });
}

const STATE_KEYS: Record<string, Parameters<TFunction>[0]> = {
  polling: "externalRelay.poller.polling",
  unreachable: "externalRelay.poller.unreachable",
  rate_limited: "externalRelay.poller.rateLimited",
  credential_rejected: "externalRelay.poller.credentialRejected",
  unsupported_version: "externalRelay.poller.unsupportedVersion",
  paused: "externalRelay.poller.paused",
};
const REASON_KEYS: Record<string, Parameters<TFunction>[0]> = {
  invalid_request: "externalRelay.reason.invalidRequest",
  unsupported_kind: "externalRelay.reason.invalidRequest",
  not_configured: "externalRelay.reason.notConfigured",
  disabled: "externalRelay.reason.disabled",
  busy: "externalRelay.reason.busy",
  no_capacity: "externalRelay.reason.noCapacity",
  profile_error: "externalRelay.reason.profileError",
  invalid_answer: "externalRelay.reason.invalidAnswer",
  agent_error: "externalRelay.reason.agentError",
  hard_cap: "externalRelay.reason.hardCap",
  profile_violation: "externalRelay.reason.profileViolation",
  install_restarted: "externalRelay.reason.installRestarted",
};
/** `answered`, `declined:<reason>`, `failed:<reason>`, `lease_lost`, `local_error` or `targets:<error code>`, as the poller records it. */
export function outcomeText(t: TFunction, outcome: string): string {
  const [kind, reason] = outcome.split(":");
  if (kind === "targets") return t("externalRelay.outcome.targets", { reason: relayErrorText(t, reason ?? "") });
  if (kind === "answered") return t("externalRelay.outcome.answered");
  if (kind === "lease_lost") return t("externalRelay.outcome.leaseLost");
  if (kind === "local_error") return t("externalRelay.outcome.localError");
  const why = reason ? (REASON_KEYS[reason] ? t(REASON_KEYS[reason]!) : reason) : "";
  return t(kind === "declined" ? "externalRelay.outcome.declined" : "externalRelay.outcome.failed", { reason: why });
}

/** A relay-provided link is followed only when it is an ordinary web address. */
function safeLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

/** Times and dates in the UI's language, as the rest of the interface writes them. */
const localeTag = (locale: string) => locale === "uk" ? "uk-UA" : "en-US";
const clock = (value: string, locale: string) => new Date(value).toLocaleTimeString(localeTag(locale));
const stamp = (value: string, locale: string) => new Date(value).toLocaleString(localeTag(locale));

const ownerLine = (owner: Owner) => owner.handle ? `${owner.display_name} (${owner.handle})` : owner.display_name;
const input = "h-11 w-full rounded-[8px] border border-border bg-raised px-3 text-ui text-primary disabled:opacity-50";
const primary = "min-h-11 rounded-[8px] bg-accent px-4 text-ui font-semibold text-white disabled:opacity-50";
const bordered = "min-h-11 rounded-[8px] border border-border px-3 text-ui font-semibold text-primary disabled:opacity-50";

async function call<T>(url: string, method: string, body?: object): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const result = response.status === 204 ? {} : await response.json();
    return response.ok ? { ok: true, value: result as T } : { ok: false, error: typeof result?.error === "string" ? result.error : "unavailable" };
  } catch { return { ok: false, error: "unavailable" }; }
}

/** The relay list, read on open and every few seconds while shown. */
export function useExternalRelay(): { state: RelayState | null; error: string | null; refresh: () => Promise<void> } {
  const [state, setState] = useState<RelayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const result = await call<RelayState>("/api/external-relay", "GET");
    if (!result.ok) setError(result.error);
    else if (!Array.isArray(result.value?.relays) || !Array.isArray(result.value.pending) || !Array.isArray(result.value.status)) setError("unavailable");
    else { setState(result.value); setError(null); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { state, error, refresh };
}

/** The built-in relays at once, then with what each service's descriptor says when it answers. */
function useKnownRelays(): KnownRelayInfo[] {
  const [known, setKnown] = useState<KnownRelayInfo[]>(() => KNOWN_RELAYS.map((relay) => ({ ...relay, description: null, iconUrl: null })));
  useEffect(() => {
    let active = true;
    void call<{ known: KnownRelayInfo[] }>("/api/external-relay/known", "GET").then((result) => {
      if (active && result.ok && Array.isArray(result.value?.known)) setKnown(result.value.known);
    });
    return () => { active = false; };
  }, []);
  return known;
}

/**
 * Opens the service's page while the click that asked for it is still running,
 * which is the only moment a browser lets a window open unasked. The window
 * starts blank and loses its link back to this page; it is pointed at the
 * service's page once the pairing has one. Null when the browser refused.
 */
function openPairingWindow(text: string): Window | null {
  try {
    const win = window.open("about:blank", "_blank");
    if (!win) return null;
    win.opener = null;
    try { win.document.body.textContent = text; } catch { /* a blank tab is fine */ }
    return win;
  } catch { return null; }
}

/**
 * Pairing (§A.3): the service's address, then its code and link while the
 * owner acts there, then "the relay service says this is <name>. Is this
 * you?" with Confirm and Cancel. A pending pairing the store still holds when
 * the surface opens is picked up where it stopped.
 */
export function RelayPairing({ resume, disabled = false, known = [], connected = [], onPaired, onChanged }: {
  resume: PendingView | null;
  disabled?: boolean;
  /** Relays offered with one button; one already connected, by origin, is left out. */
  known?: KnownRelayInfo[];
  connected?: string[];
  onPaired: (relay: RelayView) => void | Promise<void>;
  onChanged: () => void;
}) {
  const { t, locale } = useLocale();
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<PendingView | null>(resume);
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorFrom, setErrorFrom] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pendingId = pending?.id ?? null;
  const finished = status !== null && status.status !== "pending" && status.status !== "awaiting_install";
  useEffect(() => {
    if (!pendingId || finished) return;
    let active = true;
    const read = async () => {
      const result = await call<{ pairing: PairingStatus }>(`/api/external-relay/pairings/${encodeURIComponent(pendingId)}`, "GET");
      if (!active) return;
      if (result.ok) { setStatus(result.value.pairing); setError(null); } else setError(result.error);
    };
    void read();
    const poll = window.setInterval(() => void read(), Math.max(2, pending?.poll_interval_s ?? 3) * 1000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; window.clearInterval(poll); window.clearInterval(tick); };
  }, [pendingId, finished, pending?.poll_interval_s]);
  /** `via` names the control that asked, so its error is shown beside it; `win` is the window opened in that click. */
  const start = async (address: string, via: string, win: Window | null = null) => {
    setBusy(true); setError(null); setErrorFrom(via);
    const result = await call<{ pairing: PendingView }>("/api/external-relay/pairings", "POST", { url: address });
    setBusy(false);
    if (!result.ok) { win?.close(); setError(result.error); return; }
    const verify = safeLink(result.value.pairing.verify_url);
    const hosts = KNOWN_RELAYS.find((relay) => relay.origin === result.value.pairing.origin)?.verifyHosts;
    let landed = false;
    if (win && verify && verifyUrlAllowed(result.value.pairing.origin, hosts, verify)) {
      try { win.location.href = verify; landed = true; } catch { win.close(); }
    } else win?.close();
    setOpened(landed);
    setStatus(null);
    setPending(result.value.pairing);
    setNow(Date.now());
    onChanged();
  };
  const startKnown = (relay: KnownRelayInfo) => {
    if (busy || disabled) return;
    void start(relay.origin, relay.id, openPairingWindow(t("externalRelay.pairing.opening", { name: relay.name })));
  };
  const reset = () => { setPending(null); setStatus(null); setError(null); setOpened(false); };
  const cancel = async () => {
    if (!pending) return;
    setBusy(true); setError(null);
    const result = await call(`/api/external-relay/pairings/${encodeURIComponent(pending.id)}`, "DELETE");
    setBusy(false);
    if (!result.ok && result.error !== "not_found") { setError(result.error); return; }
    reset();
    onChanged();
  };
  const confirm = async () => {
    if (!pending || !status?.owner) return;
    setBusy(true); setError(null);
    const result = await call<{ relay: RelayView }>(`/api/external-relay/pairings/${encodeURIComponent(pending.id)}`, "POST", { ownerId: status.owner.id });
    if (!result.ok) { setBusy(false); setError(result.error); return; }
    await onPaired(result.value.relay);
    setBusy(false);
    reset();
    onChanged();
  };
  const expired = pending !== null && now >= Date.parse(pending.expires_at);
  const link = safeLink(pending?.verify_url ?? null);
  const errorText = (via: string | null) => error && errorFrom === via ? <p role="alert" className="rounded-[8px] bg-danger/10 px-3 py-2 text-ui text-danger">{relayErrorText(t, error)}</p> : null;
  const shownError = error ? <p role="alert" className="rounded-[8px] bg-danger/10 px-3 py-2 text-ui text-danger">{relayErrorText(t, error)}</p> : null;
  const offered = known.filter((relay) => !connected.includes(relay.origin));

  if (!pending) {
    return (
      <div data-external-relay-connect-area="" className="space-y-3">
        {offered.map((relay) => (
          <div key={relay.id} data-external-relay-known={relay.id} className="space-y-3 rounded-[8px] border border-border p-3">
            <div className="flex items-start gap-3">
              {relay.iconUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={relay.iconUrl} alt="" width={40} height={40} referrerPolicy="no-referrer" className="h-10 w-10 shrink-0 rounded-[8px] bg-sunken object-cover" />
                : <span aria-hidden data-external-relay-monogram="" className="grid h-10 w-10 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-body font-bold text-accent">{relay.name.slice(0, 1)}</span>}
              <div className="min-w-0">
                <p className="break-words font-semibold text-primary">{relay.name}</p>
                {relay.description ? <p className="mt-0.5 line-clamp-3 break-words text-ui text-muted">{relay.description}</p> : null}
              </div>
            </div>
            <button type="button" data-external-relay-connect-known={relay.id} disabled={busy || disabled} onClick={() => startKnown(relay)} className={`${primary} w-full sm:w-auto`}>{t("externalRelay.connectKnown", { name: relay.name })}</button>
            <p className="text-ui text-muted">{t("externalRelay.connectKnownLead", { name: relay.name })}</p>
            {errorText(relay.id)}
          </div>
        ))}
        <button type="button" data-external-relay-other-toggle="" aria-expanded={otherOpen} onClick={() => setOtherOpen((open) => !open)} className="min-h-11 rounded-[8px] text-ui font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{t("externalRelay.otherAddress")}</button>
        {otherOpen ? (
          <form data-external-relay-connect="" className="space-y-2 rounded-[8px] border border-border p-3" onSubmit={(event) => { event.preventDefault(); if (url.trim() && !busy && !disabled) void start(url.trim(), "manual"); }}>
            <h4 className="text-ui font-semibold text-primary">{t("externalRelay.connect")}</h4>
            <p className="text-ui text-muted">{t("externalRelay.connectLead")}</p>
            <input aria-label={t("externalRelay.address")} type="url" value={url} disabled={disabled} onChange={(event) => setUrl(event.target.value)} placeholder="https://relay.example" className={input} />
            {errorText("manual")}
            <button type="submit" disabled={busy || disabled || !url.trim()} className={primary}>{t("externalRelay.connect")}</button>
          </form>
        ) : null}
      </div>
    );
  }
  const ended = status && finished ? status.status : expired ? "expired" : null;
  return (
    <div data-external-relay-pairing={ended ?? status?.status ?? "pending"} className="space-y-2 rounded-[8px] border border-border bg-sunken p-3 text-ui">
      <p className="font-semibold text-primary">{pending.name} · {pending.origin}</p>
      {pending.description ? <p className="text-muted">{pending.description}</p> : null}
      {ended ? (
        <>
          <p role="status" className="text-primary">{t(ended === "denied" ? "externalRelay.pairing.denied" : ended === "cancelled" ? "externalRelay.pairing.cancelled" : ended === "completed" ? "externalRelay.pairing.completedElsewhere" : "externalRelay.pairing.expired")}</p>
          {status?.reason ? <p className="text-muted">{status.reason}</p> : null}
          <button type="button" onClick={reset} className={bordered}>{t("externalRelay.pairing.again")}</button>
        </>
      ) : status?.status === "awaiting_install" && status.owner ? (
        <>
          <p data-external-relay-owner="" className="text-primary">{t("externalRelay.pairing.ownerPrompt", { owner: ownerLine(status.owner) })}</p>
          {shownError}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void confirm()} className={primary}>{t("externalRelay.pairing.confirm")}</button>
            <button type="button" disabled={busy} onClick={() => void cancel()} className={bordered}>{t("externalRelay.pairing.notMe")}</button>
          </div>
        </>
      ) : (
        <>
          <p>{t("externalRelay.pairing.codePrompt")}</p>
          <code data-external-relay-code="" className="block select-all text-title font-bold tracking-wide text-primary">{pending.code}</code>
          {link ? <a href={link} target="_blank" rel="noopener noreferrer" data-external-relay-link={opened ? "again" : "open"} className="block break-all text-accent hover:underline">{t(opened ? "externalRelay.pairing.openLinkAgain" : "externalRelay.pairing.openLink")}</a> : null}
          <p className="text-muted">{t("externalRelay.pairing.expires", { time: clock(pending.expires_at, locale) })}</p>
          <p role="status" className="text-muted">{t("externalRelay.pairing.waiting")}</p>
          {shownError}
          <button type="button" disabled={busy} onClick={() => void cancel()} className={bordered}>{t("common.cancel")}</button>
        </>
      )}
    </div>
  );
}

function TargetRow({ relay, target, running, signedIn, busy, onChange, onRoute }: {
  relay: RelayView;
  target: Target;
  running: number;
  signedIn: Record<RelayEngine, boolean>;
  busy: boolean;
  onChange: (patch: Partial<Target>) => void;
  onRoute: (answeredBy: "install" | "service") => void;
}) {
  const { t } = useLocale();
  const scale = target.engine ? effortScale(target.engine, target.model) ?? [] : [];
  const noAccount = target.engine !== null && !signedIn[target.engine];
  const canAnswer = target.engine !== null && target.model !== null && !noAccount;
  const field = (label: string, control: ReactNode) => <label className="flex min-w-0 flex-col gap-1 text-ui font-semibold text-primary">{label}{control}</label>;
  return (
    <div data-external-relay-target={target.id} className="space-y-3 rounded-[8px] border border-border p-3 text-ui">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 break-words font-semibold text-primary">{target.name}</p>
        <p className="text-muted" data-external-relay-running={running}>{t("externalRelay.target.running", { count: running, max: target.concurrency })}</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field(t("externalRelay.target.engine"), (
          <select aria-label={`${t("externalRelay.target.engine")} · ${target.name}`} value={target.engine ?? ""} disabled={busy} className={input}
            onChange={(event) => { const engine = event.target.value as RelayEngine; onChange({ engine, model: defaultModelFor(engine), effort: null }); }}>
            {target.engine ? null : <option value="" disabled>{t("externalRelay.target.choose")}</option>}
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        ))}
        {field(t("externalRelay.target.model"), (
          <select aria-label={`${t("externalRelay.target.model")} · ${target.name}`} value={target.model ?? ""} disabled={busy || !target.engine} className={input}
            onChange={(event) => { const model = event.target.value; onChange({ model, effort: target.effort && target.engine && effortScale(target.engine, model)?.includes(target.effort) ? target.effort : null }); }}>
            {target.model ? null : <option value="" disabled>{t("externalRelay.target.choose")}</option>}
            {target.engine ? ENGINE_MODELS[target.engine].map((model) => <option key={model.id} value={model.id}>{model.label}</option>) : null}
          </select>
        ))}
        {field(t("externalRelay.target.effort"), (
          <select aria-label={`${t("externalRelay.target.effort")} · ${target.name}`} value={target.effort ?? ""} disabled={busy || !target.engine} className={input}
            onChange={(event) => onChange({ effort: event.target.value || null })}>
            <option value="">{t("externalRelay.target.effortDefault")}</option>
            {scale.map((effort) => <option key={effort} value={effort}>{effortTierLabel(t, effort)}</option>)}
          </select>
        ))}
        {field(t("externalRelay.target.concurrency"), (
          <select aria-label={`${t("externalRelay.target.concurrency")} · ${target.name}`} value={target.concurrency} disabled={busy} className={input}
            onChange={(event) => onChange({ concurrency: Number(event.target.value) })}>
            {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        ))}
      </div>
      <label className="flex min-h-11 items-center gap-3 text-primary">
        <input type="checkbox" data-external-relay-answered-by={target.answered_by} checked={target.answered_by === "install"} disabled={busy || relay.paused || (target.answered_by !== "install" && !canAnswer)}
          onChange={(event) => onRoute(event.target.checked ? "install" : "service")} />
        {t("externalRelay.target.answeredHere")}
      </label>
      {noAccount ? <p data-external-relay-no-account="" className="rounded-[8px] bg-warning-soft px-3 py-2 text-warning">{t("externalRelay.noAccount", { engine: target.engine === "codex" ? "Codex" : "Claude" })}</p> : null}
      {!target.engine || !target.model ? <p className="text-muted">{t("externalRelay.target.needsEngine")}</p> : null}
    </div>
  );
}

function RelayCard({ relay, status, signedIn, onChanged }: { relay: RelayView; status: StatusRow | null; signedIn: Record<RelayEngine, boolean>; onChanged: () => Promise<void> }) {
  const { t, locale } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);
  const act = async (url: string, method: string, body?: object) => {
    setBusy(true); setError(null);
    const result = await call<{ warned?: boolean }>(url, method, body);
    if (!result.ok) setError(result.error);
    else if (result.value.warned) setWarned(true);
    await onChanged();
    setBusy(false);
  };
  const base = `/api/external-relay/relays/${encodeURIComponent(relay.id)}`;
  const state = relay.paused ? "paused" : status?.state.state ?? "paused";
  const tone = state === "credential_rejected" || state === "unsupported_version" ? "bg-danger/10 text-danger" : state === "unreachable" || state === "rate_limited" ? "bg-warning-soft text-warning" : "bg-sunken text-primary";
  const progress = status?.state.lastProgress ?? null;
  const progressTarget = progress ? relay.targets.find((target) => target.id === progress.targetId)?.name ?? progress.targetId : null;
  return (
    <div data-external-relay={relay.id} className="space-y-3 rounded-[8px] border border-border p-3 text-ui">
      <div>
        <p className="break-words font-semibold text-primary">{relay.name} · {relay.origin}</p>
        {relay.description ? <p className="mt-1 text-muted">{relay.description}</p> : null}
        <p data-external-relay-paired-at="" className="mt-1 text-muted">{t("externalRelay.pairedAs", { owner: ownerLine(relay.owner), date: stamp(relay.pairedAt, locale) })}</p>
      </div>
      <p role="status" data-external-relay-state={state} className={`rounded-[8px] px-3 py-2 ${tone}`}>{t(STATE_KEYS[state] ?? "externalRelay.poller.paused")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">{t("externalRelay.lastOutcome")}</dt>
        <dd data-external-relay-last-outcome="" className="min-w-0 break-words text-primary">{status?.state.lastOutcome ? `${outcomeText(t, status.state.lastOutcome)}${status.state.lastOutcomeAt ? ` · ${clock(status.state.lastOutcomeAt, locale)}` : ""}` : t("externalRelay.none")}</dd>
        <dt className="text-muted">{t("externalRelay.lastProgress")}</dt>
        <dd data-external-relay-last-progress="" className="min-w-0 break-words text-primary">{progress ? `${progressTarget}: ${progress.label} · ${clock(progress.at, locale)}` : t("externalRelay.none")}</dd>
      </dl>
      {relay.targets.length ? relay.targets.map((target) => (
        <TargetRow key={target.id} relay={relay} target={target} running={status?.running[target.id] ?? 0} signedIn={signedIn} busy={busy}
          onChange={(patch) => void act(base, "PATCH", { target: { id: target.id, ...patch } })}
          onRoute={(answeredBy) => void act(`${base}/targets/${encodeURIComponent(target.id)}`, "PATCH", { answered_by: answeredBy })} />
      )) : <p className="text-muted">{t("externalRelay.noTargets")}</p>}
      {error ? <p role="alert" className="rounded-[8px] bg-danger/10 px-3 py-2 text-danger">{relayErrorText(t, error)}</p> : null}
      {warned ? <p role="status" className="rounded-[8px] bg-warning-soft px-3 py-2 text-warning">{t("externalRelay.removeWarning")}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void act(base, "PATCH", { paused: !relay.paused })} className={bordered}>{relay.paused ? t("externalRelay.resume") : t("externalRelay.pause")}</button>
        <button type="button" disabled={busy} onClick={() => void act(base, "DELETE")} className={bordered}>{t("externalRelay.disconnect")}</button>
      </div>
    </div>
  );
}

/**
 * The whole surface. `pairEngine`, from the setup guide, is the engine the
 * operator chose there: a new pairing's unset targets take it, with its
 * default model, so they can be switched to this install at once. A relay from
 * the built-in list is the first connection of its kind: with no engine chosen
 * the signed-in one is used (Claude first), and its targets are answered by
 * this install from the start.
 */
export function ExternalRelaySection({ pairEngine = null, pairDisabled = false, onPaired, onRelays }: { pairEngine?: RelayEngine | null; pairDisabled?: boolean; onPaired?: (relay: RelayView) => void; onRelays?: (count: number) => void }) {
  const { t } = useLocale();
  const { state, error, refresh } = useExternalRelay();
  const known = useKnownRelays();
  const relayCount = state?.relays.length ?? null;
  useEffect(() => { if (relayCount !== null) onRelays?.(relayCount); }, [relayCount, onRelays]);
  const claude = useEngineAccounts("claude");
  const codex = useEngineAccounts("codex");
  const signedIn = { claude: claude.accounts.some(accountConnected), codex: codex.accounts.some(accountConnected) };
  const paired = async (relay: RelayView) => {
    const builtIn = KNOWN_RELAYS.some((item) => item.origin === relay.origin);
    const engine = pairEngine ?? (builtIn ? (signedIn.claude ? "claude" : signedIn.codex ? "codex" : null) : null);
    if (engine)
      for (const target of relay.targets.filter((item) => item.engine === null)) {
        const set = await call(`/api/external-relay/relays/${encodeURIComponent(relay.id)}`, "PATCH", { target: { id: target.id, engine, model: defaultModelFor(engine) } });
        if (set.ok && builtIn && signedIn[engine] && target.answered_by !== "install")
          await call(`/api/external-relay/relays/${encodeURIComponent(relay.id)}/targets/${encodeURIComponent(target.id)}`, "PATCH", { answered_by: "install" });
      }
    await refresh();
    onPaired?.(relay);
  };
  const resume = state?.pending.filter((item) => Date.parse(item.expires_at) > Date.now()).at(-1) ?? null;
  return (
    <div data-external-relay-section="" className="space-y-3">
      {error && !state ? <p role="alert" className="rounded-[8px] bg-danger/10 px-3 py-2 text-ui text-danger">{relayErrorText(t, error)}</p> : null}
      {!state && !error ? <p className="text-ui text-muted">{t("common.loading")}</p> : null}
      {state ? (() => {
        const connected = state.relays.map((relay) => relay.origin);
        const cards = state.relays.map((relay) => (
          <RelayCard key={relay.id} relay={relay} status={state.status.find((row) => row.id === relay.id) ?? null} signedIn={signedIn} onChanged={refresh} />
        ));
        const pairing = <RelayPairing key="pairing" resume={resume} disabled={pairDisabled} known={known} connected={connected} onPaired={paired} onChanged={() => void refresh()} />;
        // The one-button connection leads while a built-in relay is still to connect.
        return known.some((relay) => !connected.includes(relay.origin)) ? [pairing, ...cards] : [...cards, pairing];
      })() : null}
    </div>
  );
}
