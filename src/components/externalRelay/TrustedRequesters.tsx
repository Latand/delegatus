"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";
import type { RequesterOperation, RequesterProposalView, RequesterView } from "@/lib/externalRelay/requesterEnrolmentContract";
import type { RelayGrantStatus } from "@/lib/externalRelay/settingsView";
import { FOCUS, PRIMARY, QUIET } from "./relayUi";

const endpoint = "/api/external-relay/trusted-requesters";
type Code = { code: string; expiresAt: string };
type Candidate = NonNullable<RequesterView["pending"]>["candidate"];

async function api<T>(query = "", body?: object): Promise<T> {
  const response = await fetch(endpoint + query, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, confirmed: true }),
  } : { cache: "no-store" });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

function IssuedCode({ value }: { value: Code }) {
  const { t, locale } = useLocale();
  return <div className="space-y-1 text-ui">
    <p>{t("externalRelay.requesters.share")}</p>
    <code data-requester-code="" className="inline-block select-all rounded-control bg-sunken px-2 py-1 text-primary">{value.code}</code>
    <p className="text-caption text-muted">{t("externalRelay.requesters.expires", { time: new Date(value.expiresAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) })}</p>
  </div>;
}

/** A date and time never wraps inside itself, even in a narrow panel. */
function When({ time }: { time: string }) {
  const { locale } = useLocale();
  return <span data-requester-time="" className="whitespace-nowrap">{new Date(time).toLocaleString(locale)}</span>;
}

function Confirm({ action, label, target, project, candidate = null, busy, accept, cancel }: {
  action: RequesterOperation["action"]; label: string; target: string; project: string | null;
  candidate?: Candidate; busy: boolean; accept: () => void; cancel: () => void;
}) {
  const { t } = useLocale();
  const heading = t(`externalRelay.requesters.action.${action}`);
  return <div role="alertdialog" aria-label={heading} data-requester-confirm={action}
    className="space-y-2 rounded-control border border-warning bg-warning-soft p-2.5 text-ui text-primary">
    <p className="break-words font-semibold">{heading} · {label}</p>
    <p className="break-words">{target} · {project ?? t("externalRelay.requesters.unassigned")}</p>
    {candidate && <p data-requester-candidate="" className="break-words">{[candidate.name, candidate.chatTitle].filter(Boolean).join(" · ")} · <When time={candidate.at} /></p>}
    {action === "confirm" && candidate ? <p>{t("externalRelay.requesters.verify")}</p> : null}
    {action === "confirm" ? <p>{t("externalRelay.requesters.reach")}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" autoFocus disabled={busy} className={QUIET} onClick={cancel}>{t("common.cancel")}</button>
      <button type="button" disabled={busy} className={PRIMARY} onClick={accept}>{heading}</button>
    </div>
  </div>;
}

export function TrustedRequesters({ relay, target, project, grantStatus }: { relay: string; target: string; project: string | null; grantStatus: RelayGrantStatus }) {
  const { t, locale } = useLocale();
  const [view, setView] = useState<RequesterView | null>(null);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<Code | null>(null);
  const [confirm, setConfirm] = useState<{ operation: RequesterOperation; label: string; viewed: RequesterView; subjectProject: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = useCallback(async (includeHistory = true) => {
    const next = await api<RequesterView>(`?${new URLSearchParams({ relay, target, ...(includeHistory ? {} : { history: "0" }) })}`);
    if (next.relay !== relay || next.target !== target) throw new Error("Invalid requester settings");
    return next;
  }, [relay, target]);

  useEffect(() => {
    let active = true;
    void load().then(next => { if (active) setView(next); }).catch(() => { if (active) setView(null); });
    return () => { active = false; };
  }, [load, project]);

  // A pending enrolment, here or in another session, is watched until it settles or expires.
  const watched = view?.pending?.id ?? (view?.otherSession ? `other:${view.otherSession.expiresAt}` : undefined);
  useEffect(() => {
    if (!watched) return;
    let active = true;
    const key = (current: RequesterView | null) => current?.pending?.id ?? (current?.otherSession ? `other:${current.otherSession.expiresAt}` : undefined);
    const timer = setInterval(() => {
      void load(false).then(next => {
        if (active) setView(current => key(current) === watched ? { ...next, history: current?.history ?? [] } : current);
      }).catch((error: unknown) => {
        if (active && error instanceof Error && ["401", "403"].includes(error.message)) {
          setView(null);
          setIssued(null);
        }
      });
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [load, watched]);

  if (!view) return <div className="flex justify-between gap-2 text-caption text-muted">
    <span>{t("externalRelay.target.grant.label")}</span>
    <span data-external-relay-grant-status={grantStatus}>{t(`externalRelay.target.grant.${grantStatus}`)}</span>
  </div>;
  const pending = view.pending;
  function ask(operation: RequesterOperation, subject: string, subjectProject = view!.project) {
    setError(false);
    setConfirm({ operation, label: subject, viewed: view!, subjectProject });
  }
  async function apply() {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      const result = await api<{ issued: Code | null }>("", { operation: confirm.operation,
        revision: confirm.viewed.revision, project: confirm.viewed.project });
      setIssued(result.issued);
      setLabel("");
      setConfirm(null);
      setView(await load());
    } catch {
      setError(true);
      setConfirm(null);
      const fresh = await load().catch(() => null);
      if (fresh) setView(fresh);
    } finally { setBusy(false); }
  }
  return <section data-trusted-requesters="" className="space-y-2 border-t border-border py-2">
    <h4 className="text-ui font-semibold text-primary">{t("externalRelay.target.grant.label")}</h4>
    {view.entries.length === 0 ? <p className="text-caption text-muted">{t("externalRelay.requesters.empty")}</p> :
      <ul className="space-y-1">
        {view.entries.map(entry => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-sunken p-2">
          <div className="min-w-0 break-words">
            <p className="text-ui font-semibold text-primary">{entry.label}</p>
            <p className="break-words text-caption text-muted">{[
              t(`externalRelay.requesters.kind.${entry.kind}`), t(`externalRelay.requesters.tier.${entry.tier}`),
              t(`externalRelay.requesters.state.${entry.active ? "active" : "suspended"}`), entry.project,
            ].filter(Boolean).join(" · ")} · <When time={entry.addedAt} /></p>
          </div>
          <button type="button" className={QUIET} disabled={busy} onClick={() => ask({ action: "remove", relay, target, entryId: entry.id }, entry.label, entry.project)}>
            {t("externalRelay.requesters.action.remove")}</button>
        </li>)}
      </ul>}
    {pending ? <div data-requester-pending={pending.status} className="space-y-2 rounded-control border border-border p-2">
      <p className="break-words text-ui font-semibold">{pending.label} · {t(`externalRelay.requesters.status.${pending.status}`)}</p>
      {issued && pending.status === "waiting" && <IssuedCode value={issued} />}
      {pending.candidate && <p className="break-words text-ui">{[pending.candidate.name, pending.candidate.chatTitle].filter(Boolean).join(" · ")} · <When time={pending.candidate.at} /></p>}
      {pending.status === "candidate" && <p className="text-ui">{t("externalRelay.requesters.verify")}</p>}
      <div className="flex flex-wrap gap-3">
        {pending.status === "candidate" && view.canStart && <button type="button" className={PRIMARY} disabled={busy}
          onClick={() => ask({ action: "confirm", relay, target, entryId: pending.id }, pending.label)}>{t("externalRelay.requesters.action.confirm")}</button>}
        <button type="button" className={QUIET} disabled={busy} onClick={() => ask({ action: "decline", relay, target, entryId: pending.id }, pending.label)}>
          {t("externalRelay.requesters.action.decline")}</button>
      </div>
    </div> : view.otherSession ? <p data-requester-pending="other-session" className="text-ui text-muted">
      {t("externalRelay.requesters.otherSession", { time: new Date(view.otherSession.expiresAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) })}
    </p> : view.project && view.canStart ? <form className="flex flex-wrap items-center gap-2"
      onSubmit={event => { event.preventDefault(); if (label.trim()) ask({ action: "start_enrolment", relay, target, label: label.trim() }, label.trim()); }}>
      <input className={`min-h-9 min-w-0 flex-1 rounded-control border border-border bg-canvas px-2 text-ui max-sm:min-h-11 ${FOCUS}`} aria-label={t("externalRelay.requesters.label")} placeholder={t("externalRelay.requesters.label")}
        maxLength={128} value={label} disabled={busy} onChange={event => setLabel(event.target.value)} />
      <button type="submit" className={PRIMARY} disabled={busy || !label.trim()}>{t("externalRelay.requesters.action.start_enrolment")}</button>
    </form> : <p className="text-caption text-muted">{t(view.project ? "externalRelay.requesters.signIn" : "externalRelay.requesters.noProject")}</p>}
    {confirm && <Confirm action={confirm.operation.action} label={confirm.label} target={confirm.viewed.targetName} project={confirm.subjectProject}
      candidate={confirm.operation.action === "confirm" || confirm.operation.action === "decline" ? confirm.viewed.pending?.candidate : null}
      busy={busy} accept={() => void apply()} cancel={() => setConfirm(null)} />}
    {error && <p role="alert" className="text-ui text-warning">{t("externalRelay.requesters.error")}</p>}
    {view.history.length > 0 && <details className="text-caption text-muted">
      <summary className="cursor-pointer">{t("externalRelay.requesters.history")}</summary>
      <ul className="mt-1 space-y-1">{view.history.map((row, index) => <li key={index} className="break-words">
        <When time={row.time} /> · {t(`externalRelay.requesters.audit.${row.action as "start_enrolment" | "confirm" | "decline" | "remove" | "expired" | "earlier-switch"}`)} · {row.label}
      </li>)}</ul>
    </details>}
  </section>;
}

export function TrustedRequesterProposal({ id, close }: { id: string; close: () => void }) {
  const { t } = useLocale();
  const [proposal, setProposal] = useState<RequesterProposalView | null>(null);
  const [issued, setIssued] = useState<Code | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void api<RequesterProposalView>(`?proposal=${encodeURIComponent(id)}`).then(result => { if (active) setProposal(result); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id]);

  async function accept() {
    if (busy || saved) return;
    setBusy(true);
    try {
      const result = await api<{ issued: Code | null }>("", { proposalId: id });
      setIssued(result.issued);
      setSaved(true);
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  return <section className="space-y-2" data-requester-proposal="">
    {proposal && !saved && <Confirm action={proposal.operation.action} label={proposal.label} target={proposal.targetName}
      project={proposal.project} candidate={proposal.candidate} busy={busy} accept={() => void accept()} cancel={close} />}
    {saved && (issued ? <IssuedCode value={issued} /> : <p role="status">{t("externalRelay.requesters.saved")}</p>)}
    {error && <p role="alert" className="text-ui text-warning">{t("externalRelay.requesters.error")}</p>}
  </section>;
}
