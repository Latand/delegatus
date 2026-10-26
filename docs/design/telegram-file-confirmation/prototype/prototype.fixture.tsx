"use client";

/*
 * Prototype: the owner's confirmation of one Telegram file send
 * (docs/design/telegram-file-confirmation.md), redrawn on the product's
 * components, tokens and type after the visual audit ranked the page worst
 * (docs/audits/codex-ui-visual-audit.md on the audit lane's branch, surface 1). Three numbered variants of
 * the one decision the page exists for, each printed with its number and name
 * in the frame. Invented fixture data; no product code changes.
 *
 * The query string picks what is drawn:
 *   ?variant=1|2|3&lang=uk|en&theme=light|dark&state=pending|sent
 * The driver presses the page's own controls for the opened states
 * (the «Details» fold, the status dot's popover). See README.md.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Check, FileJson, Send, TriangleAlert, X } from "lucide-react";

import { setLocale, translate, type Locale } from "@/lib/i18n";
import { MobileSheetFold } from "@/components/mobile/MobileSheet";

/* ---------- what is drawn ---------- */

const params = new URLSearchParams(location.search);
const LANG: Locale = params.get("lang") === "en" ? "en" : "uk";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const VARIANT = ([1, 2, 3] as const).find((n) => String(n) === params.get("variant")) ?? 1;
const STATE: "pending" | "sent" = params.get("state") === "sent" ? "sent" : "pending";

document.documentElement.dataset.theme = THEME;
document.documentElement.lang = LANG;
try { localStorage.setItem("llv_lang", LANG); } catch { /* opaque origin */ }
setLocale(LANG);
const L = (en: string, uk: string) => (LANG === "uk" ? uk : en);

/* A frozen clock: the request was made at 15:00 Kyiv time, the owner opens
   the page two minutes later, and the request lives ten minutes. */
const NOW_MS = Date.parse("2026-10-22T12:02:00.000Z");
Date.now = () => NOW_MS;
const ZONE = "Europe/Kyiv";
const LOCALE_TAG = LANG === "uk" ? "uk-UA" : "en-GB";
const clock = (iso: string) => new Intl.DateTimeFormat(LOCALE_TAG, { hour: "2-digit", minute: "2-digit", timeZone: ZONE }).format(new Date(iso));
const day = (iso: string) => new Intl.DateTimeFormat(LOCALE_TAG, { day: "numeric", month: "long", timeZone: ZONE }).format(new Date(iso));
const size = (bytes: number) => `${new Intl.NumberFormat(LOCALE_TAG, { maximumFractionDigits: 1 }).format(bytes / 1024)} ${L("KB", "КБ")}`;

/* ---------- the invented request (the shape of FileConfirmationView) ---------- */

const REQUEST = {
  id: "fc_7k2m9q4r1z",
  digest: "9f2c41a7d3b85e60".repeat(4),
  chatId: "-1002233445566",
  chatTitle: "Orbit Reports",
  topicId: 7,
  replyToMessageId: 42,
  format: "html" as const,
  silent: true,
  file: {
    filename: "weekly-report.json",
    path: "/srv/orbit/handoff/weekly-report.json",
    resolvedPath: "/srv/orbit/.codex/auth.json",
    sha256: "b7e3c9a14d2f8e6b".repeat(4),
    bytes: 2458,
  },
  caption: L("Weekly report, 20–26 October", "Тижневий звіт за 20–26 жовтня"),
  createdAt: "2026-10-22T12:00:00.000Z",
  expiresAt: "2026-10-22T12:10:00.000Z",
  decidedAt: "2026-10-22T12:03:00.000Z",
  roots: ["/srv/orbit/handoff"],
  codes: ["document_forbidden_path", "document_outside_roots", "document_secret"],
};

const WARNINGS = [
  L("The file is inside the hidden folder .codex.", "Файл лежить у прихованій теці .codex."),
  L("It is outside the folders sends are allowed from (handoff).", "Він поза теками, з яких дозволено надсилати (handoff)."),
  L("It looks like it holds a private key (line 1).", "Схоже, у ньому приватний ключ (рядок 1)."),
];
const MINUTES_LEFT = Math.ceil((Date.parse(REQUEST.expiresAt) - NOW_MS) / 60_000);

const VARIANT_NAME: Record<1 | 2 | 3, string> = {
  1: L("Question and two buttons", "Питання і дві кнопки"),
  2: L("Warning first, safe choice first", "Спершу застереження, безпечний вибір першим"),
  3: L("Like a permission prompt", "Як запит дозволу"),
};

/* ---------- the product's button recipe (SelfUpdateView) ---------- */

const BUTTON = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] border px-3.5 text-ui font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-55 pointer-coarse:h-11 max-sm:h-11 max-sm:w-full";
const TONE = {
  secondary: "border-border bg-card text-primary hover:enabled:border-strong focus-visible:ring-accent/40",
  primary: "border-brand bg-brand text-on-brand hover:enabled:opacity-90 focus-visible:ring-accent/40",
  warning: "border-warning bg-card text-warning focus-visible:ring-warning/40",
} as const;
/* The permission prompt's pair (PermissionActions, touch size). */
const PERMISSION = "inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[8px] px-3 text-ui font-semibold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/* ---------- the pieces every variant shares ---------- */

/* The request's state is a dot with a short popover (the operator's standing
   rule): the word and the deadline live in the popover, the heading says the
   state in words, so colour is never alone. The popover opens into the band
   above the card, where nothing is written. */
function StatusDot({ state }: { state: "pending" | "sent" }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  const word = state === "pending" ? L("Awaiting your decision", "Очікує вашого рішення") : L("Sent", "Надіслано");
  const detail = state === "pending"
    ? L(`${MINUTES_LEFT} min left, until ${clock(REQUEST.expiresAt)}`, `ще ${MINUTES_LEFT} хв, до ${clock(REQUEST.expiresAt)}`)
    : L(`At ${clock(REQUEST.decidedAt)}, this confirmation is used up`, `О ${clock(REQUEST.decidedAt)}, це підтвердження використано`);
  return (
    <div ref={host} className="relative shrink-0" data-proto-new>
      <button
        type="button"
        data-proto-status
        aria-label={`${L("State", "Стан")}: ${word}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <span aria-hidden className={`h-2 w-2 rounded-full ${state === "pending" ? "bg-warning" : "bg-success"}`} />
      </button>
      {open ? (
        <div role="dialog" aria-label={word} data-proto-popover className="absolute bottom-full right-0 z-10 mb-1 w-max max-w-[260px] rounded-surface border border-border bg-raised px-3 py-2 shadow-2">
          <p className="text-ui font-semibold text-primary">{word}</p>
          <p className="text-label text-muted">{detail}</p>
        </div>
      ) : null}
    </div>
  );
}

/* The card's first row: where this came from, and the state. */
function Kicker({ state }: { state: "pending" | "sent" }) {
  return (
    <div className="flex min-h-6 items-center gap-2" data-proto-new>
      <Send className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-label font-semibold text-secondary">{L("Telegram · an agent's request", "Telegram · запит від агента")}</span>
      <StatusDot state={state} />
    </div>
  );
}

/* Hashes, ids, paths and detector codes, behind one closed row (the sheet's own fold). */
function Details() {
  const [open, setOpen] = useState(false);
  const rows: Array<[string, string]> = [
    [L("Requested path", "Запитаний шлях"), REQUEST.file.path],
    [L("Resolved file", "Фактичний файл"), REQUEST.file.resolvedPath],
    ["SHA-256", REQUEST.file.sha256],
    [L("Size", "Розмір"), `${REQUEST.file.bytes} ${L("bytes", "байт")}`],
    [L("Chat", "Чат"), `${REQUEST.chatTitle} · ${REQUEST.chatId}`],
    [L("Topic", "Тема"), String(REQUEST.topicId)],
    [L("Reply to message", "Відповідь на повідомлення"), String(REQUEST.replyToMessageId)],
    [L("Caption", "Підпис"), REQUEST.caption],
    [L("Caption format", "Формат підпису"), "HTML"],
    [L("Silent delivery", "Без сповіщення"), L("yes", "так")],
    [L("Allowed folders", "Дозволені теки"), REQUEST.roots.join(", ")],
    [L("Detector codes", "Коди детекторів"), REQUEST.codes.join(", ")],
    [L("Requested", "Запит"), `${day(REQUEST.createdAt)}, ${clock(REQUEST.createdAt)} · ${REQUEST.id}`],
    [L("Valid until", "Діє до"), `${day(REQUEST.expiresAt)}, ${clock(REQUEST.expiresAt)}`],
    [L("Digest", "Дайджест"), REQUEST.digest],
  ];
  return (
    <div className="-mx-4 border-t border-border pt-1 sm:-mx-5" data-proto-new data-proto-details>
      <MobileSheetFold id="details" title={translate(LANG, "kanban.details")} value={rows.length} open={open} onToggle={() => setOpen((value) => !value)}>
        <dl className="flex flex-col gap-2 py-2 pl-3 pr-4">
          {rows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-label text-muted">{label}</dt>
              <dd className="font-mono text-ui leading-[1.45] text-secondary [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      </MobileSheetFold>
    </div>
  );
}

function Sentences({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5 text-body text-primary">{children}</div>;
}

/* ---------- variant 1: the question, then its two answers ---------- */

function Variant1({ state }: { state: "pending" | "sent" }) {
  return (
    <>
      <Kicker state={state} />
      {state === "pending" ? (
        <>
          <h1 className="text-title font-bold leading-snug text-primary" data-proto-new data-proto-heading>
            {L(`Send ${REQUEST.file.filename} to ${REQUEST.chatTitle}?`, `Надіслати ${REQUEST.file.filename} у ${REQUEST.chatTitle}?`)}
          </h1>
          <p className="text-body text-secondary" data-proto-new>
            {L("Delegatus held the send over three warnings. Approval sends the file once.", "Delegatus зупинив надсилання через три застереження. Підтвердження надсилає файл один раз.")}
          </p>
          <div className="flex flex-wrap gap-2" data-proto-new data-proto-actions>
            <button type="button" data-proto-send className={`${BUTTON} ${TONE.primary}`}>{L("Send once", "Надіслати один раз")}</button>
            <button type="button" data-proto-refuse className={`${BUTTON} ${TONE.secondary}`}>{L("Don't send", "Не надсилати")}</button>
          </div>
          <section aria-label={L("Why we ask", "Чому запитуємо")} className="rounded-surface border border-warning/45 bg-warning-soft px-3 pb-3 pt-1" data-proto-new>
            <div className="flex min-h-9 items-center gap-1.5 text-label font-bold text-warning">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{L("Why we ask", "Чому запитуємо")}</span>
            </div>
            <Sentences>{WARNINGS.map((text) => <p key={text}>{text}</p>)}</Sentences>
          </section>
        </>
      ) : (
        <>
          <h1 className="text-title font-bold leading-snug text-primary" data-proto-new data-proto-heading>
            {L(`Sent to ${REQUEST.chatTitle}`, `Надіслано у ${REQUEST.chatTitle}`)}
          </h1>
          <p className="text-body text-secondary" data-proto-new>
            {L(`${REQUEST.file.filename} went out at ${clock(REQUEST.decidedAt)}. This confirmation is used up.`, `${REQUEST.file.filename} надіслано о ${clock(REQUEST.decidedAt)}. Це підтвердження використано.`)}
          </p>
        </>
      )}
      <Details />
    </>
  );
}

/* ---------- variant 2: the strongest warning leads, and the safe answer is the primary one ---------- */

function Variant2({ state }: { state: "pending" | "sent" }) {
  return (
    <>
      <Kicker state={state} />
      {state === "pending" ? (
        <>
          <h1 className="flex items-start gap-2 text-title font-bold leading-snug text-primary" data-proto-new data-proto-heading>
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span>{L("This file looks like it holds a private key", "Схоже, у цьому файлі приватний ключ")}</span>
          </h1>
          <p className="text-body text-secondary" data-proto-new>
            {L(`An agent wants to send ${REQUEST.file.filename} to ${REQUEST.chatTitle}. Delegatus held it because:`, `Агент хоче надіслати ${REQUEST.file.filename} у ${REQUEST.chatTitle}. Delegatus зупинив надсилання, бо:`)}
          </p>
          <ul className="flex flex-col gap-1.5 text-body text-primary" data-proto-new>
            {WARNINGS.map((text) => (
              <li key={text} className="flex items-start gap-2">
                <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2" data-proto-new data-proto-actions>
            <button type="button" data-proto-refuse className={`${BUTTON} ${TONE.primary}`}>{L("Don't send", "Не надсилати")}</button>
            <button type="button" data-proto-send className={`${BUTTON} ${TONE.warning}`}>{L("Send anyway, once", "Усе одно надіслати один раз")}</button>
          </div>
        </>
      ) : (
        <>
          <h1 className="flex items-start gap-2 text-title font-bold leading-snug text-primary" data-proto-new data-proto-heading>
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <span>{L(`Sent anyway to ${REQUEST.chatTitle}`, `Усе одно надіслано у ${REQUEST.chatTitle}`)}</span>
          </h1>
          <p className="text-body text-secondary" data-proto-new>
            {L(`You approved ${REQUEST.file.filename} at ${clock(REQUEST.decidedAt)} despite three warnings. This confirmation is used up.`, `Ви підтвердили ${REQUEST.file.filename} о ${clock(REQUEST.decidedAt)} попри три застереження. Це підтвердження використано.`)}
          </p>
        </>
      )}
      <Details />
    </>
  );
}

/* ---------- variant 3: the feed's permission prompt, with the file as an attachment row ---------- */

function Variant3({ state }: { state: "pending" | "sent" }) {
  const fileRow = (
    <div className="flex items-center gap-2.5 rounded-control border border-border bg-card px-3 py-2" data-proto-new>
      <FileJson className="h-5 w-5 shrink-0 text-secondary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-semibold text-primary">{REQUEST.file.filename}</p>
        <p className="truncate text-ui text-muted">{L(`${size(REQUEST.file.bytes)} · to ${REQUEST.chatTitle}`, `${size(REQUEST.file.bytes)} · у ${REQUEST.chatTitle}`)}</p>
      </div>
    </div>
  );
  return (
    <>
      <Kicker state={state} />
      {state === "pending" ? (
        <section aria-label={translate(LANG, "mobile2.feed.needsYou")} className="rounded-surface border border-warning/45 bg-warning-soft px-3 pb-3 pt-1" data-proto-new>
          <div className="flex min-h-9 items-center gap-1.5 text-label font-bold text-warning">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{translate(LANG, "mobile2.feed.needsYou")}</span>
          </div>
          <div className="flex flex-col gap-3">
            {fileRow}
            <h1 className="text-title font-semibold leading-snug text-primary" data-proto-heading>{L("Let the agent send it?", "Дозволити агентові надіслати його?")}</h1>
            <Sentences>{WARNINGS.map((text) => <p key={text}>{text}</p>)}</Sentences>
            <div className="flex gap-2" data-proto-actions>
              <button type="button" data-proto-send className={`${PERMISSION} bg-success`}><Check className="h-4 w-4" aria-hidden />{translate(LANG, "attention.permissionAllowOnce")}</button>
              <button type="button" data-proto-refuse className={`${PERMISSION} bg-danger`}><X className="h-4 w-4" aria-hidden />{translate(LANG, "attention.permissionDeny")}</button>
            </div>
          </div>
        </section>
      ) : (
        <section aria-label={L("Allowed", "Дозволено")} className="rounded-surface border border-success/45 bg-success-soft px-3 pb-3 pt-1" data-proto-new>
          <div className="flex min-h-9 items-center gap-1.5 text-label font-bold text-success">
            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{L(`Allowed at ${clock(REQUEST.decidedAt)}`, `Дозволено о ${clock(REQUEST.decidedAt)}`)}</span>
          </div>
          <div className="flex flex-col gap-3">
            {fileRow}
            <h1 className="text-title font-semibold leading-snug text-primary" data-proto-heading>{L("Sent. This confirmation is used up.", "Надіслано. Це підтвердження використано.")}</h1>
          </div>
        </section>
      )}
      <Details />
    </>
  );
}

/* ---------- the page ---------- */

const VARIANTS = { 1: Variant1, 2: Variant2, 3: Variant3 } as const;

function Page() {
  const Variant = VARIANTS[VARIANT];
  useEffect(() => { document.body.dataset.protoReady = "1"; }, []);
  return (
    <main data-proto-page className="h-dvh overflow-y-auto bg-canvas px-4 pb-6 pt-4 text-primary sm:px-8 sm:pt-6">
      <div className="mx-auto max-w-xl">
        <p data-proto-caption className="text-ui font-semibold text-secondary">
          {L(`Variant ${VARIANT} · ${VARIANT_NAME[VARIANT]}`, `Варіант ${VARIANT} · ${VARIANT_NAME[VARIANT]}`)}
        </p>
        {/* The band under the caption is where the status popover opens. */}
        <article data-proto-card className="mt-16 flex flex-col gap-4 rounded-surface border border-border bg-card px-4 pb-1 pt-3 shadow-1 sm:px-5 sm:pt-4">
          <Variant state={STATE} />
        </article>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
