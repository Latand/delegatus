"use client";

import { AlertTriangle, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, Pause, Play, RotateCcw, Unplug } from "lucide-react";
import { useCallback, useEffect, useState, useRef, type ReactNode } from "react";

import { effortTierLabel } from "@/components/builderCopy";
import { EngineRadioGroup } from "@/components/draft/AgentLaunchControls";
import { EffortScale } from "@/components/EffortPills";
import { EngineMark } from "@/components/EngineMark";
import { BAR_MENU_ROW, BarMenuGroup, BarMoreMenu } from "@/components/ProjectBar";
import { SettingSwitch } from "@/components/ProjectSettingRow";
import { MeterLine } from "@/components/railFooterDensity";
import { Select } from "@/components/ui/Select";
import { accountConnected } from "@/components/onboarding/EnginesStep";
import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { effortScale } from "@/lib/agent/efforts";
import { defaultModelFor, ENGINE_MODELS } from "@/lib/agent/models";
import { KNOWN_RELAYS, verifyUrlAllowed, type KnownRelayInfo } from "@/lib/externalRelay/knownRelays";
import { RELAY_MEMBER_ANSWERS_PER_HOUR } from "@/lib/externalRelay/profile";
import { useLocale, type TFunction } from "@/lib/i18n";

/**
 * The external relay's operator surface (docs/design/relay.md §B.9): pair
 * this install with a relay service, then choose per target the engine,
 * model, effort and concurrency that answer it, and read the poller state,
 * the last outcome and the last progress. The settings dialog and the setup
 * guide's optional step both render it, drawn with the board's own rows,
 * switches, selects and ⋯ menu. It holds settings only: what a relay's chats
 * said opens from the conversation list. Everything the relay service sends
 * (its name, the owner, target names, progress) is shown as plain text.
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
  memberLimitPerHour?: number | null;
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
  member_limit: "externalRelay.reason.memberLimit",
};
/** `answered`, `declined:<reason>`, `failed:<reason>`, `lease_lost`, `local_error` or `targets:<error code>`, as the poller records it. */
export function outcomeText(t: TFunction, outcome: string): string {
  const [kind, reason] = outcome.split(":");
  if (kind === "targets") return t("externalRelay.outcome.targets", { reason: relayErrorText(t, reason ?? "") });
  if (kind === "compacted" && ["compacted", "started_fresh", "nothing_to_compact"].includes(reason ?? "")) return t(`externalRelay.compact.${reason}` as Parameters<TFunction>[0]);
  if (kind === "answered") return t("externalRelay.outcome.answered");
  if (kind === "lease_lost") return t("externalRelay.outcome.leaseLost");
  if (kind === "local_error") return t("externalRelay.outcome.localError");
  if (kind === "declined" && reason === "handoff") return t("externalRelay.outcome.handoff");
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

/** Times and dates in the UI's language on the board's 24-hour clock, to the minute; a date names its year only outside this one. */
const localeTag = (locale: string) => locale === "uk" ? "uk-UA" : "en-US";
const clock = (value: string, locale: string) => new Date(value).toLocaleTimeString(localeTag(locale), { hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = (value: string, locale: string) => {
  const date = new Date(value);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return date.toLocaleString(localeTag(locale), { year, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};

const ownerLine = (owner: Owner) => owner.handle ? `${owner.display_name} (${owner.handle})` : owner.display_name;
const modelLabel = (engine: RelayEngine | null, model: string | null) => engine && model ? ENGINE_MODELS[engine].find((item) => item.id === model)?.label ?? model : null;

/* The board's own recipes: the seat tick panel's link, quiet action and number
   field, its uppercase section head, and the primary button. Every control is
   44 px on the phone. */
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const LINK = `inline-flex items-center gap-0.5 font-semibold text-accent underline-offset-2 hover:underline ${FOCUS}`;
const QUIET = `inline-flex h-7 items-center gap-1.5 rounded-control px-1 text-ui font-semibold text-secondary hover:text-accent disabled:opacity-50 max-sm:min-h-11 ${FOCUS}`;
const NUMBER = `h-7 rounded-control border border-border bg-card px-2 text-ui text-primary tabular-nums disabled:opacity-50 max-sm:h-11 max-sm:text-body ${FOCUS}`;
const HEAD = "text-label font-semibold uppercase tracking-wide text-muted";
const PRIMARY = `inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control bg-brand px-3 text-ui font-semibold text-on-brand shadow-1 hover:opacity-90 disabled:opacity-50 max-sm:h-11 ${FOCUS}`;
const PHONE_SELECT = "max-sm:h-11 max-sm:text-body";

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

/** The status dot of the seat tick panel, with the danger tone a refused pairing needs. */
function Dot({ tone, className = "" }: { tone: "ok" | "warn" | "danger" | "muted"; className?: string }) {
  const fill = tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warning" : tone === "danger" ? "bg-danger" : "bg-muted";
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${fill} ${className}`} />;
}

const alertLine = (text: string) => <p role="alert" className="rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-ui leading-4 text-danger">{text}</p>;

/** The relay's mark: the service's icon, or the first letter of its name. */
function RelayMark({ name, icon = null }: { name: string; icon?: string | null }) {
  return icon
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={icon} alt="" width={32} height={32} referrerPolicy="no-referrer" className="h-8 w-8 shrink-0 rounded-[8px] bg-sunken object-cover" />
    : <span aria-hidden data-external-relay-monogram="" className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-ui font-bold text-accent">{name.slice(0, 1)}</span>;
}

/** The service's name with its address beside it, cut by the row. */
function RelayName({ name, origin }: { name: string; origin: string }) {
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className="min-w-0 break-words text-ui font-semibold text-primary">{name}</span>
      <span className="min-w-0 truncate text-caption text-muted">{origin.replace(/^https?:\/\//, "")}</span>
    </p>
  );
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
 * Pairing (§A.3): the offered relay as one row (its mark, name, one line about
 * it, Connect), «Other address» as a link opening an address field beside its
 * button, then the code and the link while the owner acts there, then "the
 * relay service says this is <name>. Is this you?" with Confirm and Cancel. A
 * pending pairing the store still holds when the surface opens is picked up
 * where it stopped.
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
  const errorText = (via: string | null) => error && errorFrom === via ? alertLine(relayErrorText(t, error)) : null;
  const shownError = error ? alertLine(relayErrorText(t, error)) : null;
  const offered = known.filter((relay) => !connected.includes(relay.origin));

  if (!pending) {
    return (
      <div data-external-relay-connect-area="" className="flex min-w-0 flex-col gap-2.5">
        {offered.map((relay) => (
          <div key={relay.id} data-external-relay-known={relay.id} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2.5 max-sm:flex-wrap">
              <RelayMark name={relay.name} icon={relay.iconUrl} />
              <div className="min-w-0 flex-1">
                <p className="break-words text-ui font-semibold text-primary">{relay.name}</p>
                {relay.description ? <p className="line-clamp-2 break-words text-caption leading-4 text-muted">{relay.description}</p> : null}
              </div>
              <button type="button" data-external-relay-connect-known={relay.id} disabled={busy || disabled} onClick={() => startKnown(relay)} className={`${PRIMARY} max-sm:w-full`}>
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.connectKnown", { name: relay.name })}
              </button>
            </div>
            <p className="text-caption leading-4 text-muted">{t("externalRelay.connectKnownLead", { name: relay.name })}</p>
            {errorText(relay.id)}
          </div>
        ))}
        <button type="button" data-external-relay-other-toggle="" aria-expanded={otherOpen} onClick={() => setOtherOpen((open) => !open)} className={`${LINK} h-7 self-start text-ui max-sm:min-h-11`}>
          {otherOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}{t("externalRelay.otherAddress")}
        </button>
        {otherOpen ? (
          <form data-external-relay-connect="" className="flex min-w-0 flex-col gap-1.5" onSubmit={(event) => { event.preventDefault(); if (url.trim() && !busy && !disabled) void start(url.trim(), "manual"); }}>
            <h4 className="sr-only">{t("externalRelay.connect")}</h4>
            <p className="text-caption leading-4 text-muted">{t("externalRelay.connectLead")}</p>
            <div className="flex min-w-0 items-center gap-1.5 max-sm:flex-col max-sm:items-stretch">
              <input aria-label={t("externalRelay.address")} type="url" value={url} disabled={disabled} onChange={(event) => setUrl(event.target.value)} placeholder="https://relay.example"
                className={`h-8 min-w-0 rounded-control border border-border bg-card px-2 text-ui text-primary disabled:opacity-50 max-sm:h-11 max-sm:text-body sm:flex-1 ${FOCUS}`} />
              <button type="submit" disabled={busy || disabled || !url.trim()} className={PRIMARY}>{t("externalRelay.connect")}</button>
            </div>
            {errorText("manual")}
          </form>
        ) : null}
      </div>
    );
  }
  const ended = status && finished ? status.status : expired ? "expired" : null;
  return (
    <div data-external-relay-pairing={ended ?? status?.status ?? "pending"} className="flex min-w-0 flex-col gap-2 text-ui">
      <div className="flex min-w-0 items-center gap-2.5">
        <RelayMark name={pending.name} />
        <div className="min-w-0 flex-1">
          <RelayName name={pending.name} origin={pending.origin} />
          {pending.description ? <p className="line-clamp-2 break-words text-caption leading-4 text-muted">{pending.description}</p> : null}
        </div>
      </div>
      {ended ? (
        <>
          <p role="status" className="flex items-start gap-1.5 text-primary"><Dot tone={ended === "denied" ? "danger" : "muted"} className="mt-[5px]" />{t(ended === "denied" ? "externalRelay.pairing.denied" : ended === "cancelled" ? "externalRelay.pairing.cancelled" : ended === "completed" ? "externalRelay.pairing.completedElsewhere" : "externalRelay.pairing.expired")}</p>
          {status?.reason ? <p className="pl-3 text-caption leading-4 text-muted">{status.reason}</p> : null}
          <button type="button" onClick={reset} className={`${QUIET} self-start`}><RotateCcw className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.pairing.again")}</button>
        </>
      ) : status?.status === "awaiting_install" && status.owner ? (
        <>
          <p data-external-relay-owner="" className="text-primary">{t("externalRelay.pairing.ownerPrompt", { owner: ownerLine(status.owner) })}</p>
          {shownError}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void confirm()} className={PRIMARY}><Check className="h-3.5 w-3.5" aria-hidden />{t("externalRelay.pairing.confirm")}</button>
            <button type="button" disabled={busy} onClick={() => void cancel()} className={QUIET}>{t("externalRelay.pairing.notMe")}</button>
          </div>
        </>
      ) : (
        <>
          <p role="status" className="flex items-start gap-1.5 text-primary"><Dot tone="warn" className="mt-[5px]" />{t("externalRelay.pairing.waiting")}</p>
          <p className="pl-3 text-caption leading-4 text-muted">{t("externalRelay.pairing.codePrompt")}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-3">
            <code data-external-relay-code="" className="select-all font-mono text-title font-bold tracking-wide text-primary">{pending.code}</code>
            {link ? <a href={link} target="_blank" rel="noopener noreferrer" data-external-relay-link={opened ? "again" : "open"} className={`${LINK} text-ui max-sm:min-h-11`}>{t(opened ? "externalRelay.pairing.openLinkAgain" : "externalRelay.pairing.openLink")}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden /></a> : null}
          </div>
          <p className="pl-3 text-caption leading-4 text-muted">{t("externalRelay.pairing.expires", { time: clock(pending.expires_at, locale) })}</p>
          {shownError}
          <button type="button" disabled={busy} onClick={() => void cancel()} className={`${QUIET} self-start`}>{t("common.cancel")}</button>
        </>
      )}
    </div>
  );
}

type Actions = {
  busy: boolean;
  patchTarget: (target: Target, patch: Partial<Target>) => void;
  route: (target: Target, answeredBy: "install" | "service") => void;
};

/**
 * Answers per member per hour in each chat (relay.md §B.8). The field shows
 * the default until the operator sets a number; an empty field or 0 is no
 * limit. It is saved when the field loses focus or on Enter.
 */
function MemberLimitField({ target, actions }: { target: Target; actions: Actions }) {
  const { t } = useLocale();
  const stored = target.memberLimitPerHour === undefined ? RELAY_MEMBER_ANSWERS_PER_HOUR : target.memberLimitPerHour;
  const shown = stored ? String(stored) : "";
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const save = () => {
    setEditing(false);
    const text = draft.trim();
    const value = text === "" ? null : Number(text);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1000)) { setDraft(shown); return; }
    if ((value || null) !== (stored || null)) actions.patchTarget(target, { memberLimitPerHour: value });
  };
  return (
    <input type="number" inputMode="numeric" min={0} max={1000} step={1} data-external-relay-member-limit="" disabled={actions.busy}
      aria-label={`${t("externalRelay.target.memberLimit")} · ${target.name}`} placeholder={t("externalRelay.target.memberLimitNone")}
      value={editing ? draft : shown} className={`${NUMBER} w-24 text-right`}
      onFocus={() => { setDraft(shown); setEditing(true); }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
  );
}

/** One label-value row of an open target, as the seat tick panel lays its settings out. */
function SettingLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-h-7 min-w-0 items-center gap-2 text-ui text-primary">
      <span className="min-w-0 flex-1">{label}</span>
      {children}
    </label>
  );
}

/**
 * A target as one folded row: its engine's mark, its name, what runs it and
 * how many are running, its limit, its effort ladder, and «Answered by this
 * install» as the board's switch. Unfolded in place, the row holds the engine
 * pills, model and effort of the new-agent form, the concurrency, the member
 * limit with who it exempts, and what the target still needs.
 */
function TargetRow({ relay, target, running, signedIn, actions, open, onOpen }: {
  relay: RelayView;
  target: Target;
  running: number;
  signedIn: Record<RelayEngine, boolean>;
  actions: Actions;
  open: boolean;
  onOpen: () => void;
}) {
  const { t } = useLocale();
  const scale = target.engine ? effortScale(target.engine, target.model) ?? [] : [];
  const noAccount = target.engine !== null && !signedIn[target.engine];
  const canAnswer = target.engine !== null && target.model !== null && !noAccount;
  const limit = target.memberLimitPerHour === undefined ? RELAY_MEMBER_ANSWERS_PER_HOUR : target.memberLimitPerHour;
  const configured = target.engine !== null && target.model !== null;
  const load = [t("externalRelay.target.running", { count: running, max: target.concurrency }), limit ? t("externalRelay.target.perHour", { count: limit }) : null].filter(Boolean).join(" · ");
  const here = target.answered_by === "install";
  const name = (key: Parameters<TFunction>[0]) => `${t(key)} · ${target.name}`;
  return (
    <div data-external-relay-target={target.id} data-open={open ? "" : undefined} className={`flex min-w-0 flex-col border-t border-border first:border-t-0 ${open ? "pb-2.5" : ""}`}>
      <div className="flex min-h-9 min-w-0 items-center gap-2 max-sm:min-h-11">
        <button type="button" aria-expanded={open} onClick={onOpen} data-external-relay-target-fold=""
          className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-control px-1 text-left hover:bg-sunken max-sm:min-h-11 ${FOCUS}`}>
          {target.engine ? <EngineMark engine={target.engine} size={14} /> : <Dot tone="muted" className="mx-1" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="line-clamp-2 break-words text-ui font-semibold leading-4 text-primary" title={target.name}>{target.name}</span>
            <span data-external-relay-running={running} className={`flex min-w-0 items-center gap-1 text-caption ${noAccount ? "text-warning" : "text-muted"}`}>
              {noAccount ? <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> : null}
              {configured ? (
                <>
                  <span className="shrink-0">{modelLabel(target.engine, target.model)}</span>
                  {target.effort ? <EffortScale effort={target.effort} color={`var(--color-${target.engine}-mark)`} /> : null}
                  <span className="min-w-0 truncate">{` · ${load}`}</span>
                </>
              ) : <span className="min-w-0 truncate">{t("externalRelay.target.needsEngine")}</span>}
            </span>
          </span>
          {open ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />}
        </button>
        <SettingSwitch enabled={here} size="responsive" aria-label={name("externalRelay.target.answeredHere")} title={t("externalRelay.target.answeredHere")}
          data-external-relay-answered-by={target.answered_by} disabled={actions.busy || relay.paused || (!here && !canAnswer)}
          onClick={() => actions.route(target, here ? "service" : "install")} />
      </div>
      {open ? (
        <div className="flex min-w-0 flex-col gap-1.5 pl-7 pt-1 max-sm:pl-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 max-sm:flex-col max-sm:items-stretch">
            <div role="group" data-external-relay-engine="" aria-label={name("externalRelay.target.engine")} className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:px-3 max-sm:[&_button]:text-ui">
              <EngineRadioGroup engine={(target.engine ?? "") as RelayEngine} disabled={actions.busy}
                onChange={(next) => { const engine = next as RelayEngine; if (engine !== target.engine) actions.patchTarget(target, { engine, model: defaultModelFor(engine), effort: null }); }} />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Select aria-label={name("externalRelay.target.model")} title={t("externalRelay.target.model")} value={target.model ?? ""} disabled={actions.busy || !target.engine} className={`min-w-0 flex-1 ${PHONE_SELECT}`}
                onChange={(event) => { const model = event.target.value; actions.patchTarget(target, { model, effort: target.effort && target.engine && effortScale(target.engine, model)?.includes(target.effort) ? target.effort : null }); }}>
                {target.model ? null : <option value="" disabled>{t("externalRelay.target.choose")}</option>}
                {target.engine ? ENGINE_MODELS[target.engine].map((model) => <option key={model.id} value={model.id}>{model.label}</option>) : null}
              </Select>
              <Select aria-label={name("externalRelay.target.effort")} title={t("externalRelay.target.effort")} value={target.effort ?? ""} disabled={actions.busy || !target.engine} className={`min-w-0 max-sm:flex-1 sm:w-28 ${PHONE_SELECT}`}
                onChange={(event) => actions.patchTarget(target, { effort: event.target.value || null })}>
                <option value="">{t("externalRelay.target.effortDefault")}</option>
                {scale.map((effort) => <option key={effort} value={effort}>{effortTierLabel(t, effort)}</option>)}
              </Select>
            </div>
          </div>
          <SettingLine label={t("externalRelay.target.concurrency")}>
            <Select aria-label={name("externalRelay.target.concurrency")} value={target.concurrency} disabled={actions.busy} className={`w-14 max-sm:w-20 ${PHONE_SELECT}`}
              onChange={(event) => actions.patchTarget(target, { concurrency: Number(event.target.value) })}>
              {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
            </Select>
          </SettingLine>
          <SettingLine label={t("externalRelay.target.memberLimit")}>
            <MemberLimitField target={target} actions={actions} />
          </SettingLine>
          <p className="text-caption leading-4 text-muted">{t("externalRelay.target.memberLimitHint")}</p>
          {noAccount ? (
            <p data-external-relay-no-account="" className="flex items-start gap-1.5 text-caption leading-4 text-warning">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
              <span className="min-w-0">{t("externalRelay.noAccount", { engine: target.engine === "codex" ? "Codex" : "Claude" })}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One paired relay (relay.md §B.9): its mark, name, address and who it is
 * paired as, with pause or resume and disconnect behind its ⋯; the poller's
 * state as a status line with its dot; the last request and the last progress
 * as the sidebar's meter lines; then one folded row per target. What the
 * relay's chats said is never shown here: those conversations are listed with
 * the others (the sidebar's entry for the service) and open in the agent window.
 */
function RelayCard({ relay, status, signedIn, onChanged }: { relay: RelayView; status: StatusRow | null; signedIn: Record<RelayEngine, boolean>; onChanged: () => Promise<void> }) {
  const { t, locale } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const act = async (url: string, method: string, body?: object) => {
    setBusy(true); setError(null);
    const result = await call<{ warned?: boolean }>(url, method, body);
    if (!result.ok) setError(result.error);
    else if (result.value.warned) setWarned(true);
    await onChanged();
    setBusy(false);
  };
  const base = `/api/external-relay/relays/${encodeURIComponent(relay.id)}`;
  const actions: Actions = {
    busy,
    patchTarget: (target, patch) => void act(base, "PATCH", { target: { id: target.id, ...patch } }),
    route: (target, answeredBy) => void act(`${base}/targets/${encodeURIComponent(target.id)}`, "PATCH", { answered_by: answeredBy }),
  };
  const state = relay.paused ? "paused" : status?.state.state ?? "paused";
  const tone = state === "polling" ? "ok" : state === "credential_rejected" || state === "unsupported_version" ? "danger" : state === "unreachable" || state === "rate_limited" ? "warn" : "muted";
  const progress = status?.state.lastProgress ?? null;
  const progressTarget = progress ? relay.targets.find((target) => target.id === progress.targetId)?.name ?? progress.targetId : null;
  const outcome = status?.state.lastOutcome ? `${outcomeText(t, status.state.lastOutcome)}${status.state.lastOutcomeAt ? ` · ${clock(status.state.lastOutcomeAt, locale)}` : ""}` : t("externalRelay.none");
  return (
    <div data-external-relay={relay.id} className="flex min-w-0 flex-col gap-2 text-ui">
      <div className="flex min-w-0 items-start gap-2.5">
        <RelayMark name={relay.name} />
        <div className="min-w-0 flex-1">
          <RelayName name={relay.name} origin={relay.origin} />
          <p data-external-relay-paired-at="" className="truncate text-caption leading-4 text-muted" title={relay.description || undefined}>{t("externalRelay.pairedAs", { owner: ownerLine(relay.owner), date: stamp(relay.pairedAt, locale) })}</p>
        </div>
        <span data-external-relay-menu="" className="max-sm:[&_[data-bar-more]]:h-11 max-sm:[&_[data-bar-more]]:w-11">
          <BarMoreMenu rows={(close) => (
            <BarMenuGroup name="relay">
              <button type="button" data-external-relay-pause="" disabled={busy} onClick={() => { close(); void act(base, "PATCH", { paused: !relay.paused }); }} className={`${BAR_MENU_ROW} max-sm:min-h-11`}>
                {relay.paused ? <Play className="h-[15px] w-[15px] shrink-0 text-secondary" aria-hidden /> : <Pause className="h-[15px] w-[15px] shrink-0 text-secondary" aria-hidden />}
                {relay.paused ? t("externalRelay.resume") : t("externalRelay.pause")}
              </button>
              <button type="button" data-external-relay-disconnect="" disabled={busy} onClick={() => { close(); void act(base, "DELETE"); }} className={`${BAR_MENU_ROW} max-sm:min-h-11`}>
                <Unplug className="h-[15px] w-[15px] shrink-0 text-secondary" aria-hidden />{t("externalRelay.disconnect")}
              </button>
            </BarMenuGroup>
          )} />
        </span>
      </div>
      <div className="flex min-w-0 flex-col">
        {/* The meter line's 22px, kept as padding around each 16px line, so a state that wraps keeps its dot on the first line and its gap to the line below. */}
        <p role="status" data-external-relay-state={state} className={`flex min-w-0 items-start gap-1.5 py-[3px] text-[11.5px] font-semibold leading-4 ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "text-primary"}`}>
          <Dot tone={tone} className="mt-[5px]" /><span className="min-w-0 break-words">{t(STATE_KEYS[state] ?? "externalRelay.poller.paused")}</span>
        </p>
        <MeterLine label={t("externalRelay.lastOutcome")} value={<span data-external-relay-last-outcome="">{outcome}</span>} percent={null} color="" bar={false} />
        {progress ? <MeterLine label={t("externalRelay.lastProgress")} value={<span data-external-relay-last-progress="" title={progress.label}>{`${progressTarget} · ${clock(progress.at, locale)}`}</span>} percent={null} color="" bar={false} /> : null}
      </div>
      {relay.targets.length ? (
        <div className="flex min-w-0 flex-col">
          <div className="flex items-baseline justify-end pb-0.5"><span className={HEAD}>{t("externalRelay.target.answeredHere")}</span></div>
          {relay.targets.map((target) => (
            <TargetRow key={target.id} relay={relay} target={target} running={status?.running[target.id] ?? 0} signedIn={signedIn} actions={actions}
              open={open === target.id} onOpen={() => setOpen((value) => value === target.id ? null : target.id)} />
          ))}
        </div>
      ) : <p className="text-caption text-muted">{t("externalRelay.noTargets")}</p>}
      {error ? alertLine(relayErrorText(t, error)) : null}
      {warned ? <p role="status" className="flex items-start gap-1.5 text-caption leading-4 text-warning"><AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />{t("externalRelay.removeWarning")}</p> : null}
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
    <div data-external-relay-section="" className="flex flex-col gap-4 [&>[data-external-relay]~[data-external-relay]]:border-t [&>[data-external-relay]~[data-external-relay]]:border-border [&>[data-external-relay]~[data-external-relay]]:pt-4">
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
