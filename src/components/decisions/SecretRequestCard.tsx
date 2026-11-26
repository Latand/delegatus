"use client";

import { ChevronDown, KeyRound, Loader2, Lock } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { ValueField } from "@/components/keys/ValueField";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { SecretRefusal } from "@/lib/secretRequests/types";
import { SECRET_BODY_TYPE, SECRET_REVISION_HEADER, secretFilename, secretTarget, type SecretActionAnswer, type SecretRequestView } from "@/lib/secretRequests/view";
import { DECISION_PRIMARY_BUTTON, FoldHeader, decisionClock } from "./DecisionCard";

export function secretRequestTitle(t: TFunction, request: SecretRequestView | { target: string }): string {
  return t("secretRequest.titleFor", { target: "target" in request ? request.target : secretTarget(request.destination.path, request.destination.key) });
}

type InputProblem = "format-token" | "format-line" | "env" | "long" | "short";

/** Why a typed value cannot be saved, or null when it can. */
function inputProblem(value: string, request: SecretRequestView): InputProblem | null {
  if (request.format === "token" ? /[^!-~]/.test(value) : /[\p{Cc}\p{Cs}]/u.test(value)) return request.format === "token" ? "format-token" : "format-line";
  if (request.destination.kind === "env" && /['\\$]/.test(value)) return "env";
  let bytes = 0;
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    length++;
  }
  if (bytes > 4096) return "long";
  return length >= (request.minLength ?? 1) ? null : "short";
}

function unencrypted(): boolean {
  if (typeof window === "undefined" || window.isSecureContext) return false;
  return !/^(?:localhost\.?|.*\.localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(window.location.hostname);
}

export function SecretRequestCard({ request, onCollapse, onUpdate }: {
  request: SecretRequestView;
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
  /* Said only while the typed value cannot be saved. */
  const [problem, setProblem] = useState<InputProblem | null>(null);
  const { destination, destinationRevision: revision, requester } = request;
  const fieldVersion = `${revision}:${request.state}`;
  const [previousFieldVersion, setPreviousFieldVersion] = useState(fieldVersion);
  if (fieldVersion !== previousFieldVersion) {
    setPreviousFieldVersion(fieldVersion);
    setValidRevision(null);
    setVisibleRevision(null);
    setProblem(null);
  }
  const title = secretRequestTitle(t, request);
  const target = secretTarget(destination.path, destination.key);
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
      setProblem(null);
      setValidRevision(null);
      setVisibleRevision(null);
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);

  const submit = async (kind: "value" | "decline") => {
    if (inflight.current || busy) return;
    const field = input.current;
    if (kind === "value" && (!ready || !field || inputProblem(field.value, request) !== null)) return;
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
      setProblem(null);
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
        onUpdate(answer, { text: t(kind === "value" ? "secretRequest.saved" : "secretRequest.declined", { target }) });
      } else {
        const code = response.status === 401 ? "operator_only"
          : response.status === 403 && answer.code !== "operator_only" ? "owner_required"
          : answer.code ?? "secret_request_unavailable";
        setError(code);
        const terminal = code === "secret_not_pending" || code === "secret_expired" || code === "operator_only" || code === "owner_required";
        const text = code === "secret_not_pending" || code === "secret_expired" ? t(`secretRequest.closed.${code}`, { target }) : t(`secretRequest.error.${code}`);
        onUpdate({ ...answer, code }, terminal ? { text, error: true } : undefined);
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
  const role = requester.stage ? t("secretRequest.role.stage")
    : requester.role === "orchestrator" || requester.role === "agent" ? t(`secretRequest.role.${requester.role}`) : t("secretRequest.role.agent");
  const source = [...new Set([requester.title, role].filter(Boolean))];
  const reason = request.purpose.split(/\r?\n/, 1)[0] ?? "";
  const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const row = "min-w-0 [overflow-wrap:anywhere]";
  return (
    <article data-decision-review={request.id} data-secret-request={request.id} className="flex min-w-0 shrink-0 flex-col overflow-hidden rounded-surface border border-accent/40 bg-card shadow-1">
      <FoldHeader title={title} frame="border-b border-border bg-accent-soft/60" row="flex min-w-0 items-start gap-1.5 px-3 py-2 hover:bg-accent-soft" onCollapse={onCollapse}>
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span data-secret-title="" className="min-w-0 flex-1 text-ui font-semibold text-primary [overflow-wrap:anywhere]">{title}</span>
        <time dateTime={new Date(request.createdAt).toISOString()} className="mt-0.5 shrink-0 text-caption tabular-nums text-muted">{decisionClock(new Date(request.createdAt).toISOString(), locale)}</time>
      </FoldHeader>
      <div className="flex min-w-0 flex-col gap-2 px-3 pb-1 pt-2 text-ui leading-snug text-primary">
        <p data-secret-reason="" className="m-0 truncate text-secondary" dir="auto" title={request.purpose}>{reason}</p>
        {unencrypted() ? <p role="status" className="m-0 text-label text-warning">{t("secretRequest.unencrypted")}</p> : null}
        <form onSubmit={(event) => { event.preventDefault(); void submit("value"); }} autoComplete="off" className="flex min-w-0 flex-col gap-1.5">
          <div className="relative flex min-w-0">
            <ValueField key={fieldVersion} ref={input} id={fieldId} aria-label={t("secretRequest.label")} placeholder={t("secretRequest.label")}
              aria-describedby={problem ? hintId : undefined} aria-invalid={problem ? true : undefined} disabled={busy} maxLength={4096}
              onInput={(event) => {
                const value = event.currentTarget.value;
                const found = inputProblem(value, request);
                setProblem(value ? found : null);
                setValidRevision(found === null ? revision : null);
                setError(null);
              }}
              onKeyDown={(event) => { if (event.key === "Escape" && revealed) { event.stopPropagation(); setVisibleRevision(null); } }}
              className={`min-h-9 w-full min-w-0 rounded-control border border-border bg-canvas px-2.5 pr-12 font-mono text-body text-primary placeholder:font-sans placeholder:text-muted [@media(pointer:coarse)]:min-h-11 ${focus}`}
              reveal={{ shown: revealed, label: t(revealed ? "secretRequest.hide" : "secretRequest.show"),
                toggle: () => setVisibleRevision(revealed ? null : revision),
                className: `absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-control text-muted hover:text-primary ${focus}` }} />
          </div>
          {problem ? <p id={hintId} data-secret-hint={problem} className="m-0 text-label text-warning [overflow-wrap:anywhere]">
            {problem === "short" ? t("secretRequest.invalid.short", { count: request.minLength ?? 1 }) : t(`secretRequest.invalid.${problem}`)}
          </p> : null}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button type="submit" data-secret-save="" disabled={!ready} className={DECISION_PRIMARY_BUTTON}>
              {action === "value" || request.state === "writing" ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("secretRequest.saving")}</> : t("secretRequest.save")}
            </button>
            <button type="button" data-secret-decline="" disabled={busy}
              className={`inline-flex h-9 items-center rounded-control px-2 text-ui font-semibold text-muted hover:text-primary disabled:opacity-45 [@media(pointer:coarse)]:h-11 ${focus}`}
              onClick={() => void submit("decline")}>{t(action === "decline" ? "secretRequest.declining" : "secretRequest.decline")}</button>
            <span role="img" data-secret-private="" aria-label={t("secretRequest.private")} title={t("secretRequest.private")} className="ml-auto inline-flex h-9 w-6 items-center justify-center text-muted">
              <Lock className="h-3.5 w-3.5" aria-hidden />
            </span>
          </div>
          {issue ? <p role="alert" className="m-0 text-label text-danger">{t(`secretRequest.error.${issue}`)}</p> : null}
        </form>
        <details data-secret-details="" className="group text-label text-secondary">
          <summary className={`flex min-h-7 w-fit cursor-pointer select-none list-none items-center gap-1 rounded-control font-semibold text-muted hover:text-primary [&::-webkit-details-marker]:hidden [@media(pointer:coarse)]:min-h-11 ${focus}`}>
            {t("secretRequest.details")}<ChevronDown className="h-3.5 w-3.5 group-open:rotate-180" aria-hidden />
          </summary>
          <dl className="m-0 mt-1 flex min-w-0 flex-col gap-1.5">
            <div className={row}>
              <dt className="font-semibold text-primary">{t("secretRequest.requester")}</dt>
              <dd className="m-0"><bdi>{source.join(" · ")}</bdi>{requester.seatTitle ? <> · <bdi>{t("secretRequest.via", { seat: requester.seatTitle })}</bdi></> : null}</dd>
            </div>
            {request.task ? <div className={row}><dt className="font-semibold text-primary">{t("secretRequest.task")}</dt>
              <dd className="m-0"><bdi>{request.task.title}</bdi></dd></div> : null}
            <div className={row}>
              <dt className="font-semibold text-primary">{t("secretRequest.destination")}</dt>
              <dd className="m-0 flex min-w-0 flex-col gap-0.5">
                <code className="font-mono" dir="ltr" data-secret-destination="">{destination.path}</code>
                <span>{effect} · {t(`secretRequest.git.${destination.git}`)}</span>
                <span>{t("secretRequest.readable")}</span>
                {request.lastSet ? <span>{t("secretRequest.lastSet", { at: date(request.lastSet.at), reference: `#secret-${request.lastSet.id.slice(3, 11)}` })}</span> : null}
                <span>{t("secretRequest.waitsUntil", { at: waitingUntil })}</span>
              </dd>
            </div>
            <div className={row}>
              <dt className="font-semibold text-primary">{t("secretRequest.purpose")}</dt>
              <dd className="m-0 whitespace-pre-line" dir="auto">{request.purpose}</dd>
            </div>
          </dl>
        </details>
      </div>
    </article>
  );
}
