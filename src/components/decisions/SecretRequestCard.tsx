"use client";

import { ChevronRight, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { ValueField } from "@/components/keys/ValueField";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { SecretRefusal } from "@/lib/secretRequests/types";
import { SECRET_BODY_TYPE, SECRET_REVISION_HEADER, secretFilename, type SecretActionAnswer, type SecretRequestNotice, type SecretRequestView } from "@/lib/secretRequests/view";
import { DECISION_PRIMARY_BUTTON, FoldHeader } from "./DecisionCard";

export function secretRequestTitle(t: TFunction, request: SecretRequestView): string {
  const filename = secretFilename(request.destination.path);
  return t("secretRequest.titleFor", { target: request.destination.key ? `${filename} → ${request.destination.key}` : filename });
}

export function SecretRequestAttentionRow({ notice, onOpen }: { notice: SecretRequestNotice; onOpen: () => void }) {
  const { t } = useLocale();
  return (
    <button type="button" data-needs-you-row={notice.id} onClick={onOpen}
      className="flex min-h-11 w-full items-center gap-2 rounded-control px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
      <KeyRound className="h-4 w-4 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1 text-ui font-semibold text-primary">{t("secretRequest.title")}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
    </button>
  );
}

function validInput(value: string, request: SecretRequestView): boolean {
  if (request.format === "token" ? /[^!-~]/.test(value) : /[\p{Cc}\p{Cs}]/u.test(value)) return false;
  if (request.destination.kind === "env" && /['\\$]/.test(value)) return false;
  let bytes = 0;
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    length++;
  }
  return bytes <= 4096 && length >= (request.minLength ?? 1);
}

function unencrypted(): boolean {
  if (typeof window === "undefined" || window.isSecureContext) return false;
  return !/^(?:localhost\.?|.*\.localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(window.location.hostname);
}

export function SecretRequestCard({ request, narrow, onCollapse, onUpdate }: {
  request: SecretRequestView;
  narrow: boolean;
  onCollapse: () => void;
  onUpdate: (answer: SecretActionAnswer, feedback?: { text: string; error?: true }) => void;
}) {
  const { t, locale } = useLocale();
  const hintId = useId();
  const fieldId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [validRevision, setValidRevision] = useState<string | null>(null);
  const [visibleRevision, setVisibleRevision] = useState<string | null>(null);
  const [action, setAction] = useState<"value" | "decline" | null>(null);
  const inflight = useRef(false);
  const [error, setError] = useState<SecretRefusal | null>(null);
  const { destination, destinationRevision: revision, requester } = request;
  const fieldVersion = `${revision}:${request.state}`;
  const [previousFieldVersion, setPreviousFieldVersion] = useState(fieldVersion);
  if (fieldVersion !== previousFieldVersion) {
    setPreviousFieldVersion(fieldVersion);
    setValidRevision(null);
    setVisibleRevision(null);
  }
  const title = secretRequestTitle(t, request);
  const filename = secretFilename(destination.path);
  const busy = action !== null || request.state === "writing";
  const ready = validRevision === revision && !busy;
  const revealed = visibleRevision === revision && !busy;
  const issue = error ?? (request.interrupted ? "secret_entry_interrupted" : null);
  const date = (at: number) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(at);
  const expiry = new Date(request.expiresAt);
  const waitingUntil = expiry.toDateString() === new Date().toDateString()
    ? new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(expiry)
    : date(request.expiresAt);

  useEffect(() => {
    const clear = () => {
      if (input.current) input.current.value = "";
      setValidRevision(null);
      setVisibleRevision(null);
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);

  const submit = async (kind: "value" | "decline") => {
    if (inflight.current || busy) return;
    const field = input.current;
    if (kind === "value" && (!ready || !field || !validInput(field.value, request))) return;
    inflight.current = true;
    setAction(kind);
    setError(null);
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      if (kind === "value" && field) bytes = new TextEncoder().encode(field.value);
      if (field) {
        field.value = "";
        field.type = "password";
      }
      setValidRevision(null);
      setVisibleRevision(null);
      let pending: Promise<Response>;
      try {
        pending = fetch(`/api/secret-requests/${encodeURIComponent(request.id)}/${kind}`, {
          method: "POST", cache: "no-store",
          ...(bytes ? { body: bytes, headers: { "content-type": SECRET_BODY_TYPE, [SECRET_REVISION_HEADER]: revision } } : {}),
        });
      } finally {
        bytes?.fill(0);
      }
      const response = await pending;
      const answer = await response.json() as SecretActionAnswer;
      if (response.ok) {
        onUpdate(answer, { text: kind === "value" ? t("secretRequest.saved", { filename }) : t("secretRequest.declined") });
      } else {
        const code = response.status === 401 ? "operator_only"
          : response.status === 403 && answer.code !== "operator_only" ? "owner_required"
          : answer.code ?? "secret_request_unavailable";
        setError(code);
        const terminal = code === "secret_not_pending" || code === "secret_expired" || code === "operator_only" || code === "owner_required";
        onUpdate({ ...answer, code }, terminal ? { text: t(`secretRequest.error.${code}`), error: true } : undefined);
      }
    } catch {
      setError("secret_request_unavailable");
    } finally {
      inflight.current = false;
      setAction(null);
    }
  };

  const previous = destination.previous;
  const effect = t(`secretRequest.effect.${destination.effect}`, {
    key: destination.key ?? "", filename,
    size: previous ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(previous.size / 1024) : "",
    at: previous ? date(previous.modifiedAt) : "",
  });
  const role = requester.stage ? t("secretRequest.stage", { stage: requester.stage.id, pipeline: requester.stage.pipelineId })
    : requester.role === "orchestrator" || requester.role === "agent" ? t(`secretRequest.role.${requester.role}`) : requester.role;
  const source = [...new Set([requester.title, role, requester.engine, requester.model].filter(Boolean))];
  const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  return (
    <div className="flex shrink-0 flex-col">
      <article data-decision-review={request.id} data-secret-request={request.id} className="min-w-0 rounded-surface border border-border bg-card">
        <FoldHeader title={title} frame="border-b border-border" row="flex min-h-11 items-start gap-2 px-3 py-2" onCollapse={onCollapse}>
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1 text-ui font-semibold text-primary [overflow-wrap:anywhere]">{title}</span>
        </FoldHeader>
        <div className="flex min-w-0 flex-col gap-1.5 px-3 py-1.5 text-ui leading-snug text-primary">
          <dl className="m-0 flex min-w-0 flex-col gap-1.5">
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <dt className="mr-1 inline font-semibold">{t("secretRequest.requester")} </dt>
              <dd className="m-0 inline"><bdi>{source.join(" · ")}</bdi>{requester.seatTitle ? <> · <bdi>{t("secretRequest.via", { seat: requester.seatTitle })}</bdi></> : null}{narrow ? "" : ` · ${date(request.createdAt)}`}</dd>
            </div>
            {request.task ? <div className="[overflow-wrap:anywhere]"><dt className="inline font-semibold">{t("secretRequest.task")} </dt>
              <dd className="m-0 inline"><bdi>{request.task.title}</bdi></dd></div> : null}
            <div className="min-w-0">
              <dt className="font-semibold">{t("secretRequest.destination")}</dt>
              <dd className="m-0 flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
                <code className="font-mono text-label" dir="ltr" data-secret-destination="">{destination.path}</code>
                <span>{effect} · {t(`secretRequest.git.${destination.git}`)}</span>
                {request.lastSet ? <span className="text-secondary">{t("secretRequest.lastSet", { at: date(request.lastSet.at), reference: `#secret-${request.lastSet.id.slice(3, 11)}` })}</span> : null}
              </dd>
            </div>
          </dl>
          <div className="min-w-0">
            <span className="font-semibold">{t("secretRequest.purpose")}</span>
            <blockquote className="m-0 mt-1 border-l-2 border-border pl-2 text-secondary [overflow-wrap:anywhere]" dir="auto">{request.purpose}</blockquote>
          </div>
          <p className="m-0 rounded-control bg-sunken px-2 py-1.5 text-pretty text-label text-secondary">{t("secretRequest.warning")}</p>
          {unencrypted() ? <p role="status" className="m-0 text-label text-warning">{t("secretRequest.unencrypted")}</p> : null}
          <form onSubmit={(event) => { event.preventDefault(); void submit("value"); }} autoComplete="off" className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={fieldId} className="font-semibold">{t("secretRequest.label")}</label>
            <div className="relative flex min-w-0">
              <ValueField key={fieldVersion} ref={input} id={fieldId} aria-describedby={hintId} disabled={busy} maxLength={4096}
                onInput={(event) => { setValidRevision(validInput(event.currentTarget.value, request) ? revision : null); setError(null); }}
                onKeyDown={(event) => { if (event.key === "Escape" && revealed) { event.stopPropagation(); setVisibleRevision(null); } }}
                className={`min-h-9 w-full min-w-0 rounded-control border border-border bg-canvas px-2.5 pr-12 font-mono text-body text-primary [@media(pointer:coarse)]:min-h-11 ${focus}`}
                reveal={{ shown: revealed, label: t(revealed ? "secretRequest.hide" : "secretRequest.show"),
                  toggle: () => setVisibleRevision(revealed ? null : revision),
                  className: `absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-control text-muted hover:text-primary ${focus}` }} />
            </div>
            <p id={hintId} className="m-0 text-label text-muted [overflow-wrap:anywhere]">
              {t(`secretRequest.format.${request.format}`)}{request.minLength ? ` · ${t("secretRequest.minimum", { count: request.minLength })}` : ""}
              {destination.kind === "env" ? ` · ${t("secretRequest.envFormat", { characters: "' \\ $" })}` : ""}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <button type="submit" data-secret-save="" disabled={!ready} className={DECISION_PRIMARY_BUTTON}>
                {action === "value" || request.state === "writing" ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("secretRequest.saving")}</> : t("secretRequest.save")}
              </button>
              <span className="text-label text-muted">{t("secretRequest.waitsUntil", { at: waitingUntil })}</span>
            </div>
            {issue ? <p role="alert" className="m-0 text-label text-danger">{t(`secretRequest.error.${issue}`)}</p> : null}
          </form>
        </div>
      </article>
      <div className="px-3">
        <button type="button" data-secret-decline="" disabled={busy}
          className={`min-h-8 rounded-control text-ui font-semibold text-muted hover:text-primary disabled:opacity-45 [@media(pointer:coarse)]:min-h-11 ${focus}`}
          onClick={() => void submit("decline")}>{t(action === "decline" ? "secretRequest.declining" : "secretRequest.decline")}</button>
      </div>
    </div>
  );
}
