"use client";

import { useCallback, useEffect, useState, useRef, type ReactNode } from "react";

import { effortTierLabel } from "@/components/builderCopy";
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
  memberLimitPerHour?: number | null;
};
export type RelayView = {
  ownerApi?: import("@/lib/externalRelay/ownerApi").OwnerApiView;
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
const DELIVERY_KEYS = {
  accepted: "externalRelay.answers.delivery.accepted",
  refused: "externalRelay.answers.delivery.refused",
  unconfirmed: "externalRelay.answers.delivery.unconfirmed",
} as const;
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

type AnswerSummary = {
  requestId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  state: "running" | "finished";
  outcome: string | null;
  delivery: keyof typeof DELIVERY_KEYS | null;
  request: string;
  answer: string | null;
};
type AnswerRecord = Omit<AnswerSummary, "request" | "answer"> & {
  engine: string | null;
  model: string | null;
  answer: { action: string; text: string; reply_to: string | null } | null;
  input: unknown;
};
type ReceivedInput = {
  conversation?: { id?: unknown; author?: { key?: unknown; name?: unknown }; text?: unknown }[];
  respond_to?: unknown;
  request_text?: unknown;
  requester?: { key?: unknown; is_admin?: unknown; is_owner?: unknown; is_anonymous_admin?: unknown } | null;
  tools?: unknown[];
};
/** The message a received input answers, its author's name, and the request text, all as plain strings. */
function receivedMessage(input: unknown): { text: string; author: string | null } {
  const value = (input && typeof input === "object" ? input : {}) as ReceivedInput;
  const conversation = Array.isArray(value.conversation) ? value.conversation : [];
  const trigger = conversation.find((message) => message?.id === value.respond_to);
  const parts = [typeof trigger?.text === "string" ? trigger.text : null, typeof value.request_text === "string" ? value.request_text : null].filter(Boolean);
  return { text: parts.join("\n\n"), author: typeof trigger?.author?.name === "string" ? trigger.author.name : null };
}
const seconds = (ms: number | null) => ms === null ? null : (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);

/**
 * The target's recent answers (relay.md §B.9): a list of the exchanges this
 * install kept, newest first, and one exchange opened read-only in place.
 * Every field the service or a chat participant wrote is shown as plain text.
 */
function RecentAnswers({ relayId, targetId }: { relayId: string; targetId: string }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ answers: AnswerSummary[]; retentionDays: number } | null>(null);
  const [shown, setShown] = useState<AnswerRecord | "gone" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/external-relay/relays/${encodeURIComponent(relayId)}/targets/${encodeURIComponent(targetId)}/answers`;
  useEffect(() => {
    if (!open) return;
    let active = true;
    void call<{ answers: AnswerSummary[]; retentionDays: number }>(base, "GET").then((result) => {
      if (!active) return;
      if (result.ok && Array.isArray(result.value?.answers)) { setList(result.value); setError(null); }
      else setError(result.ok ? "unavailable" : result.error);
    });
    return () => { active = false; };
  }, [open, base]);
  const show = async (requestId: string) => {
    const result = await call<{ answer: AnswerRecord }>(`${base}/${encodeURIComponent(requestId)}`, "GET");
    if (result.ok) { setShown(result.value.answer); setError(null); }
    else if (result.error === "not_found") setShown("gone");
    else setError(result.error);
  };
  const days = list?.retentionDays ?? 30;
  const outcome = (row: { state: string; outcome: string | null }) => row.state === "running" || !row.outcome ? t("externalRelay.answers.running") : outcomeText(t, row.outcome);
  const record = shown && shown !== "gone" ? shown : null;
  const received = record ? receivedMessage(record.input) : null;
  const requester = record ? ((record.input && typeof record.input === "object" ? record.input : {}) as ReceivedInput).requester : null;
  const tools = record ? ((record.input && typeof record.input === "object" ? record.input : {}) as ReceivedInput).tools : undefined;
  const term = "text-muted";
  const detail = "min-w-0 break-words text-primary";
  return (
    <div data-external-relay-answers={targetId} className="space-y-2">
      <button type="button" aria-expanded={open} data-external-relay-answers-toggle="" onClick={() => { setOpen((value) => !value); setShown(null); }}
        className="min-h-11 rounded-[8px] text-ui font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        {t("externalRelay.answers.open")}
      </button>
      {open ? (
        <div className="space-y-2 rounded-[8px] border border-border bg-sunken p-3">
          {error ? <p role="alert" className="rounded-[8px] bg-danger/10 px-3 py-2 text-danger">{relayErrorText(t, error)}</p> : null}
          {shown ? (
            <div data-external-relay-exchange={record?.requestId ?? "gone"} className="space-y-3">
              <button type="button" onClick={() => setShown(null)} className={bordered}>{t("externalRelay.answers.back")}</button>
              {record && received ? (
                <>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className={term}>{t("externalRelay.answers.received")}</dt>
                    <dd className={detail}>{stamp(record.startedAt, locale)}</dd>
                    {record.durationMs !== null ? <><dt className={term}>{t("externalRelay.answers.took")}</dt><dd className={detail}>{t("externalRelay.answers.seconds", { seconds: seconds(record.durationMs) ?? "" })}</dd></> : null}
                    {record.engine ? <><dt className={term}>{t("externalRelay.answers.answeredWith")}</dt><dd className={detail}>{[record.engine === "codex" ? "Codex" : "Claude", (record.engine === "codex" || record.engine === "claude" ? ENGINE_MODELS[record.engine].find((model) => model.id === record.model)?.label : null) ?? record.model].filter(Boolean).join(" · ")}</dd></> : null}
                    <dt className={term}>{t("externalRelay.answers.outcome")}</dt>
                    <dd data-external-relay-exchange-outcome={record.outcome ?? "running"} className={detail}>{outcome(record)}</dd>
                    {record.delivery ? <><dt className={term}>{t("externalRelay.answers.delivery")}</dt><dd className={detail}>{t(DELIVERY_KEYS[record.delivery])}</dd></> : null}
                    {requester && typeof requester.is_admin === "boolean" ? <><dt className={term}>{t("externalRelay.answers.askedBy")}</dt><dd className={detail}>{[received.author, t(requester.is_admin === true ? "externalRelay.answers.role.admin" : "externalRelay.answers.role.member"), requester.is_owner === true ? t("externalRelay.answers.role.owner") : null, requester.is_anonymous_admin === true ? t("externalRelay.answers.role.anonymous") : null].filter(Boolean).join(" · ")}</dd></> : null}
                    {Array.isArray(tools) && tools.length ? <><dt className={term}>{t("externalRelay.answers.tools")}</dt><dd className={detail}>{tools.length}</dd></> : null}
                  </dl>
                  <section className="space-y-1">
                    <h5 className="font-semibold text-primary">{t("externalRelay.answers.request")}</h5>
                    <p data-external-relay-exchange-request="" className="whitespace-pre-wrap break-words rounded-[8px] bg-raised px-3 py-2 text-primary">{received.text || t("externalRelay.none")}</p>
                  </section>
                  <section className="space-y-1">
                    <h5 className="font-semibold text-primary">{t("externalRelay.answers.answer")}</h5>
                    <p data-external-relay-exchange-answer={record.answer?.action ?? "none"} className="whitespace-pre-wrap break-words rounded-[8px] bg-raised px-3 py-2 text-primary">
                      {record.answer?.action === "reply" ? record.answer.text : record.answer?.action === "handoff" ? t("externalRelay.answers.handedOff") : record.answer?.action === "ignore" ? t("externalRelay.answers.ignored") : t("externalRelay.answers.noAnswer")}
                    </p>
                  </section>
                  <details className="space-y-1">
                    <summary className="min-h-11 cursor-pointer content-center font-semibold text-primary">{t("externalRelay.answers.input")}</summary>
                    <pre data-external-relay-exchange-input="" className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-raised p-3 font-mono text-[12px] text-primary">{JSON.stringify(record.input, null, 2)}</pre>
                  </details>
                </>
              ) : <p className="text-muted">{t("externalRelay.answers.gone")}</p>}
            </div>
          ) : list === null ? (
            error ? null : <p className="text-muted">{t("common.loading")}</p>
          ) : (
            <>
              <p className="text-muted">{t("externalRelay.answers.kept", { days })}</p>
              {list.answers.length ? (
                <ul data-external-relay-answer-list="" className="space-y-2">
                  {list.answers.map((row) => (
                    <li key={row.requestId}>
                      <button type="button" data-external-relay-answer={row.requestId} onClick={() => void show(row.requestId)}
                        className="block min-h-11 w-full space-y-1 rounded-[8px] border border-border bg-raised px-3 py-2 text-left hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="font-semibold text-primary">{outcome(row)}</span>
                          <span className="text-muted">{stamp(row.startedAt, locale)}{row.durationMs !== null ? ` · ${t("externalRelay.answers.seconds", { seconds: seconds(row.durationMs) ?? "" })}` : ""}</span>
                        </span>
                        {row.request ? <span className="block break-words text-primary">{row.request}</span> : null}
                        {row.answer ? <span className="block break-words text-muted">{row.answer}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p data-external-relay-answers-empty="" className="text-muted">{t("externalRelay.answers.empty", { days })}</p>}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Answers per member per hour in each chat (relay.md §B.8). The field shows
 * the default until the operator sets a number; an empty field or 0 is no
 * limit. It is saved when the field loses focus or on Enter.
 */
function MemberLimitField({ target, busy, onChange }: { target: Target; busy: boolean; onChange: (patch: Partial<Target>) => void }) {
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
    if ((value || null) !== (stored || null)) onChange({ memberLimitPerHour: value });
  };
  return (
    <label className="flex min-w-0 flex-col gap-1 text-ui font-semibold text-primary">
      {t("externalRelay.target.memberLimit")}
      <input type="number" inputMode="numeric" min={0} max={1000} step={1} data-external-relay-member-limit="" disabled={busy}
        aria-label={`${t("externalRelay.target.memberLimit")} · ${target.name}`} placeholder={t("externalRelay.target.memberLimitNone")}
        value={editing ? draft : shown} className={input}
        onFocus={() => { setDraft(shown); setEditing(true); }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
      <span className="text-ui font-normal text-muted">{t("externalRelay.target.memberLimitHint")}</span>
    </label>
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
        <div className="sm:col-span-2"><MemberLimitField target={target} busy={busy} onChange={onChange} /></div>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-primary">
        <input type="checkbox" data-external-relay-answered-by={target.answered_by} checked={target.answered_by === "install"} disabled={busy || relay.paused || (target.answered_by !== "install" && !canAnswer)}
          onChange={(event) => onRoute(event.target.checked ? "install" : "service")} />
        {t("externalRelay.target.answeredHere")}
      </label>
      {noAccount ? <p data-external-relay-no-account="" className="rounded-[8px] bg-warning-soft px-3 py-2 text-warning">{t("externalRelay.noAccount", { engine: target.engine === "codex" ? "Codex" : "Claude" })}</p> : null}
      {!target.engine || !target.model ? <p className="text-muted">{t("externalRelay.target.needsEngine")}</p> : null}
      <RecentAnswers relayId={relay.id} targetId={target.id} />
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
      {relay.ownerApi ? <OwnerKeyRow relay={relay} onChange={() => void onChanged()} /> : null}
      {error ? <p role="alert" className="rounded-[8px] bg-danger/10 px-3 py-2 text-danger">{relayErrorText(t, error)}</p> : null}
      {warned ? <p role="status" className="rounded-[8px] bg-warning-soft px-3 py-2 text-warning">{t("externalRelay.removeWarning")}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void act(base, "PATCH", { paused: !relay.paused })} className={bordered}>{relay.paused ? t("externalRelay.resume") : t("externalRelay.pause")}</button>
        <button type="button" disabled={busy} onClick={() => void act(base, "DELETE")} className={bordered}>{t("externalRelay.disconnect")}</button>
      </div>
    </div>
  );
}

export function OwnerKeyRow({ relay, onChange }: { relay: RelayView; onChange: () => void }) {
  const { t } = useLocale(); const typedKey = useRef(""); const keyInput = useRef<HTMLInputElement>(null); const [hasKey, setHasKey] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const view = relay.ownerApi!;
  async function submit(method: "PUT" | "DELETE") {
    const typed = typedKey.current; typedKey.current = ""; if (keyInput.current) keyInput.current.value = ""; setHasKey(false); setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/external-relay/relays/${encodeURIComponent(relay.id)}/owner-key`, { method,
        ...(method === "PUT" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: typed }) } : {}) });
      if (!response.ok) { const body = await response.json(); setError(typeof body.error === "string" ? body.error : "local_error"); }
      else onChange();
    } catch { setError("unreachable"); }
    finally { setBusy(false); }
  }
  return <div data-owner-key-row className="space-y-2 rounded-[8px] border border-border p-3">
    <p className="font-semibold">{t("externalRelay.ownerKey.label")}</p>
    <p role="status" className="text-muted">{t(`externalRelay.ownerKey.${view.state}`)}{view.expiresAt ? ` · ${view.expiresAt}` : ""}</p>
    <div className="flex flex-wrap gap-2">
      <input data-owner-key-input type="password" autoComplete="off" aria-label={t("externalRelay.ownerKey.label")} className={input} ref={keyInput} onChange={(event) => { typedKey.current = event.target.value; setHasKey(!!event.target.value); }} />
      <button data-owner-key-save type="button" className={bordered} disabled={busy || !hasKey} onClick={() => void submit("PUT")}>{t("externalRelay.ownerKey.save")}</button>
      {view.state === "bound" ? <button type="button" className={bordered} disabled={busy} onClick={() => void submit("DELETE")}>{t("externalRelay.ownerKey.remove")}</button> : null}
      <a href={view.keyUrl} target="_blank" rel="noopener noreferrer" className={bordered}>{t("externalRelay.ownerKey.create")}</a>
    </div>
    {error ? <p role="alert" className="text-danger">{relayErrorText(t, error)}</p> : null}
  </div>;
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
