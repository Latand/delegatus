"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { Check, CircleX, Clock, Loader2, Send, TriangleAlert, X } from "lucide-react";
import { translate, useLocale, type Locale } from "@/lib/i18n";
import { MobileSheetFold } from "@/components/mobile/MobileSheet";
import { fileConfirmationSummary, fileConfirmationText, type FileConfirmationView } from "@/lib/telegram/bot/fileConfirmationContract";

/* The product's button recipe (SelfUpdateView): refusing is the primary, the send carries the warning tone. */
const BUTTON = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] border px-3.5 text-ui font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-55 pointer-coarse:h-11 max-sm:h-11 max-sm:w-full";
const TONE = {
  primary: "border-brand bg-brand text-on-brand hover:enabled:opacity-90 focus-visible:ring-accent/40",
  warning: "border-warning bg-card text-warning focus-visible:ring-warning/40",
} as const;

type Pressed = "send" | "decline";
type Shown = FileConfirmationView["state"];
const DOT: Record<Shown | "sending" | "declining", string> = {
  pending: "bg-warning", sending: "bg-accent", declining: "bg-accent", approved: "bg-accent", sent: "bg-success", rejected: "bg-muted",
  expired: "bg-muted", uncertain: "bg-warning", failed: "bg-danger", unavailable: "bg-muted",
};

const localeTag = (locale: Locale) => (locale === "uk" ? "uk-UA" : "en-GB");
const clock = (iso: string, locale: Locale) => new Intl.DateTimeFormat(localeTag(locale), { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const day = (iso: string, locale: Locale) => `${new Intl.DateTimeFormat(localeTag(locale), { day: "numeric", month: "long" }).format(new Date(iso))}, ${clock(iso, locale)}`;

/* A short name stays on one line; a long one may break anywhere, so it never pushes a phone page sideways. */
function named(text: string, names: string[]): ReactNode {
  const tokens = names.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!tokens.length) return text;
  const pattern = new RegExp(`(${tokens.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
  return text.split(pattern).map((part, index) => index % 2
    ? <span key={index} data-file-confirmation-name className={part.length <= 28 ? "whitespace-nowrap" : "[overflow-wrap:anywhere]"}>{part}</span>
    : part);
}

/* The state is a dot with a short popover beside it: the heading says the state in words, so colour is never alone.
   The target reaches into the card's padding so the dot stands on the Details chevron's centre line. */
/* `countdown` names the deadline of an open request: the minutes left are read when the popover opens. */
function StatusDot({ tone, word, detail, countdown }: { tone: string; word: string; detail: string | null; countdown?: string }) {
  const { locale } = useLocale();
  const [open, setOpen] = useState<string | null | false>(false);
  const host = useRef<HTMLDivElement>(null);
  const popover = useId();
  useEffect(() => {
    if (open === false) return;
    const away = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  return <div ref={host} className="relative -mr-1 shrink-0 pointer-coarse:-mr-3.5">
    <button type="button" data-file-confirmation-status aria-label={`${fileConfirmationText[locale].stateLabel}: ${word}`} aria-expanded={open !== false} aria-controls={open === false ? undefined : popover}
      onClick={() => setOpen(value => value !== false ? false
        : countdown ? fileConfirmationText[locale].minutesLeft(Math.max(0, Math.ceil((Date.parse(countdown) - Date.now()) / 60_000)), clock(countdown, locale)) : detail)}
      className="inline-flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:h-11 pointer-coarse:w-11">
      <span aria-hidden className={`h-2 w-2 rounded-full ${tone}`} />
    </button>
    {open !== false ? <div id={popover} data-file-confirmation-popover className="absolute right-full top-1/2 z-10 mr-1 flex w-max max-w-[220px] -translate-y-1/2 flex-col rounded-surface border border-border bg-raised px-3 py-2 shadow-2 sm:max-w-none sm:flex-row sm:items-baseline sm:gap-2 sm:whitespace-nowrap">
      <p className="text-ui font-semibold text-primary">{word}</p>
      {open ? <p className="text-label text-muted">{open}</p> : null}
    </div> : null}
  </div>;
}

function Card({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return <article data-file-confirmation-card className="flex flex-col gap-4 rounded-surface border border-border bg-card px-4 pb-1 pt-3 shadow-1 sm:px-5 sm:pt-4">
    <div className="flex min-h-6 items-center gap-2">
      <Send className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-label font-semibold text-secondary">Telegram</span>
      {status}
    </div>
    {children}
  </article>;
}

function Heading({ icon, announce, children }: { icon?: ReactNode; announce: boolean; children: ReactNode }) {
  return <h1 data-file-confirmation-heading className="flex items-start gap-2 text-title font-bold leading-snug text-balance text-primary">
    {icon}<span role={announce ? "status" : undefined}>{children}</span>
  </h1>;
}

const ICON = "mt-0.5 h-4 w-4 shrink-0";

/* Hashes, ids, paths and detector codes, behind one closed row (the sheet's own fold). */
function Details({ view, decidedAt }: { view: FileConfirmationView; decidedAt: string | null }) {
  const { locale } = useLocale();
  const words = fileConfirmationText[locale];
  const [open, setOpen] = useState(false);
  const number = new Intl.NumberFormat(localeTag(locale));
  type Row = [label: string, value: string | number | null | undefined, code?: boolean];
  const captionOf = (index: number) => view.options.document?.caption ?? view.options.images?.[index]?.caption;
  const fileRows = (file: FileConfirmationView["files"][number], index: number, caption: boolean): Row[] => [
    [words.requestedPath, file.path, true],
    [words.resolvedPath, file.resolvedPath && file.resolvedPath !== file.path ? file.resolvedPath : null, true],
    ["SHA-256", file.sha256, true],
    [words.size, `${number.format(file.bytes)} ${words.bytes}`],
    ...(caption ? [[words.caption, captionOf(index)] as Row] : []),
  ];
  const several = view.files.length > 1;
  const roots = [...new Set(view.reasons.flatMap(reason => reason.code === "document_outside_roots" ? reason.roots ?? [] : []))];
  const codes = [...new Set(view.reasons.map(reason => reason.code === "document_secret" && reason.secretClass ? `${reason.code} (${reason.secretClass}${reason.line ? `, ${words.line} ${reason.line}` : ""})` : reason.code))];
  const rows: Row[] = [
    ...(several ? [] : view.files.flatMap((file, index) => fileRows(file, index, false))),
    [words.chat, view.chatTitle],
    [words.chatId, view.chatId, true],
    [words.topic, view.topicId],
    [words.replyTo, view.options.replyToMessageId],
    ...(several ? [] : [[words.caption, captionOf(0)] as Row]),
    [words.format, words[view.options.format]],
    [words.silent, view.options.silent ? words.yes : words.no],
    [words.roots, roots.length ? roots.join(", ") : null, true],
    [words.codes, codes.join(", "), true],
    [words.created, day(view.createdAt, locale)],
    [words.decided, decidedAt ? day(decidedAt, locale) : null],
    [words.id, view.id, true],
    [words.expires, day(view.expiresAt, locale)],
    [words.digest, view.digest, true],
  ];
  const list = (entries: Row[]) => entries.filter(([, value]) => value !== null && value !== undefined && value !== "").map(([label, value, code]) => <div key={label} className="min-w-0">
    <dt className="text-label text-muted">{label}</dt>
    <dd data-file-confirmation-code={code ? "" : undefined} className={`${code ? "font-mono " : ""}whitespace-pre-wrap text-ui leading-[1.45] text-secondary [overflow-wrap:anywhere]`}>{value}</dd>
  </div>);
  /* The rule spans the card; the fold's own 16 px inset plus 4 px meets the card's 20 px text column at sm. */
  return <div data-file-confirmation-details className="-mx-4 border-t border-border pt-1 sm:-mx-5 sm:px-1">
    <MobileSheetFold id="details" title={translate(locale, "kanban.details")} open={open} onToggle={() => setOpen(value => !value)}>
      <dl className="flex flex-col gap-2 py-2 pl-3 pr-4">
        {several ? view.files.map((file, index) => <div key={index} className="flex flex-col gap-2">
          <p className="text-ui font-semibold text-primary [overflow-wrap:anywhere]">{file.filename}</p>
          {list(fileRows(file, index, true))}
        </div>) : null}
        {list(rows)}
      </dl>
    </MobileSheetFold>
  </div>;
}

export function TelegramFileConfirmationView({ view, busy, decidedAt: pressedAt, onDecide }: {
  view: FileConfirmationView; busy: Pressed | null; decidedAt?: string | null; onDecide(approve: boolean): void;
}) {
  const { locale } = useLocale();
  const words = fileConfirmationText[locale];
  const main = useRef<HTMLElement>(null);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(view.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [view.expiresAt]);
  const state = view.state === "pending" && expired ? "expired" : view.state;
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [state, busy]);
  const summary = fileConfirmationSummary(view, locale);
  const decidedAt = view.decidedAt ?? pressedAt ?? null;
  const time = decidedAt ? clock(decidedAt, locale) : null;
  const shown = state === "pending" && busy ? (busy === "send" ? "sending" : "declining") : state;
  const detail = state === "expired" ? words.at(clock(view.expiresAt, locale)) : (state === "sent" || state === "rejected") && time ? words.at(time) : null;
  const text = (sentence: string) => named(sentence, summary.names);
  let content: ReactNode;
  if (state === "pending") {
    content = <>
      <Heading icon={<TriangleAlert className={`${ICON} text-warning`} aria-hidden />} announce={false}>{text(summary.heading)}</Heading>
      <div className="flex flex-col gap-1 text-body text-secondary">
        <p data-file-confirmation-intro>{text(summary.intro)}</p>
        {summary.more ? <p>{summary.more}</p> : null}
      </div>
      {summary.reasons.length ? <ul data-file-confirmation-reasons className="flex flex-col gap-1.5 text-body text-primary">
        {summary.reasons.map((reason, index) => <li key={index} className="flex items-start gap-2">
          <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
          <span>{text(reason)}</span>
        </li>)}
      </ul> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-file-confirmation-refuse disabled={busy !== null} aria-busy={busy === "decline" || undefined} className={`${BUTTON} ${TONE.primary}`} onClick={() => onDecide(false)}>
          {busy === "decline" ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{words.declining}</> : words.refuse}
        </button>
        <button type="button" data-file-confirmation-send disabled={busy !== null} aria-busy={busy === "send" || undefined} className={`${BUTTON} ${TONE.warning}`} onClick={() => onDecide(true)}>
          {busy === "send" ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{words.sending}</> : words.approve}
        </button>
      </div>
    </>;
  } else {
    const [icon, heading, body]: [ReactNode, string, string[]] = state === "sent"
      ? [<Check key="i" className={`${ICON} text-success`} aria-hidden />, words.sentTitle(view.chatTitle), [words.sentBody(time, summary.approvedSubject, summary.warnings), words.usedUp]]
      : state === "rejected"
        ? [<X key="i" className={`${ICON} text-secondary`} aria-hidden />, words.rejectedTitle(view.chatTitle), [words.rejectedBody(time, summary.declinedSubject), words.usedUp]]
        : state === "expired"
          ? [<Clock key="i" className={`${ICON} text-muted`} aria-hidden />, words.expiredTitle, [words.expiredBody(clock(view.expiresAt, locale))]]
          : state === "uncertain"
            ? [<TriangleAlert key="i" className={`${ICON} text-warning`} aria-hidden />, words.uncertainTitle, [words.uncertainBody(view.chatTitle)]]
            : state === "failed"
              ? [<CircleX key="i" className={`${ICON} text-danger`} aria-hidden />, words.failedTitle, [words.failedBody]]
              : state === "approved"
                ? [<Loader2 key="i" className={`${ICON} animate-spin text-accent`} aria-hidden />, words.sending, []]
                : [<CircleX key="i" className={`${ICON} text-muted`} aria-hidden />, words.unavailableTitle, [words.unavailableBody]];
    content = <>
      <Heading icon={icon} announce>{text(heading)}</Heading>
      {body.length ? <div className="flex flex-col gap-1 text-body text-secondary">{body.map(line => <p key={line}>{text(line)}</p>)}</div> : null}
    </>;
  }
  return <Page ref={main}>
    <Card status={<StatusDot tone={DOT[shown]} word={words.status[shown]} detail={detail} countdown={state === "pending" && !busy ? view.expiresAt : undefined} />}>
      {content}
      <Details view={view} decidedAt={decidedAt} />
    </Card>
  </Page>;
}

function Page({ ref, children }: { ref?: Ref<HTMLElement>; children: ReactNode }) {
  return <main ref={ref} data-file-confirmation className="h-dvh overflow-y-auto bg-canvas px-4 pb-6 pt-4 text-primary text-pretty sm:px-8 sm:pt-6">
    <div className="mx-auto max-w-xl">{children}</div>
  </main>;
}

export function TelegramFileConfirmation() {
  const { locale } = useLocale();
  const words = fileConfirmationText[locale];
  const [view, setView] = useState<FileConfirmationView | null>(null);
  const [error, setError] = useState<"owner" | "unavailable" | null>(null);
  const [busy, setBusy] = useState<Pressed | null>(null);
  /* The time of the press, kept here only; the server's own record stays as it is. */
  const [pressedAt, setPressedAt] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const id = new URLSearchParams(window.location.search).get("id") ?? "";
    void fetch(`/api/telegram/bot/confirmation?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) { if (!controller.signal.aborted) setError(response.status === 401 || response.status === 403 ? "owner" : "unavailable"); return; }
      const loaded = await response.json() as FileConfirmationView;
      if (!controller.signal.aborted) setView(loaded);
    }).catch(() => { if (!controller.signal.aborted) setError("unavailable"); });
    return () => controller.abort();
  }, []);
  async function decide(approve: boolean) {
    if (!view || busy) return;
    setBusy(approve ? "send" : "decline");
    const pressed = new Date(Date.now()).toISOString();
    try {
      const response = await fetch("/api/telegram/bot/confirmation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: view.id, digest: view.digest, approve }) });
      const result = await response.json() as { code?: string };
      if (!response.ok) {
        setView({ ...view, state: result.code === "send_uncertain" || result.code === "action_failed" ? "uncertain" : "failed" });
        setError(response.status === 401 || response.status === 403 ? "owner" : null);
      } else { setPressedAt(pressed); setView({ ...view, state: approve ? "sent" : "rejected" }); }
    } catch { setView({ ...view, state: "uncertain" }); }
    finally { setBusy(null); }
  }
  if (error === "owner") {
    const next = typeof window === "undefined" ? "/telegram-file-confirmation" : window.location.pathname + window.location.search;
    return <Page><Card>
      <Heading announce>{words.ownerTitle}</Heading>
      <p className="text-body text-secondary">{words.ownerBody}</p>
      <div className="pb-3"><a className={`${BUTTON} ${TONE.primary}`} href={`/sign-in?next=${encodeURIComponent(next)}`}>{words.signIn}</a></div>
    </Card></Page>;
  }
  if (error) return <Page><Card>
    <Heading icon={<CircleX className={`${ICON} text-muted`} aria-hidden />} announce>{words.unavailableTitle}</Heading>
    <p className="pb-3 text-body text-secondary">{words.unavailableBody}</p>
  </Card></Page>;
  if (!view) return <Page><Card><p role="status" className="pb-3 text-body text-muted">{words.loading}</p></Card></Page>;
  return <TelegramFileConfirmationView view={view} busy={busy} decidedAt={pressedAt} onDecide={approve => { void decide(approve); }} />;
}
