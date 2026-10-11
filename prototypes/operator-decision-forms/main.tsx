/*
 * One frame of the operator decision forms prototype. The query string names
 * it: ?v=1|2|3&state=open|proto|answered&lang=uk|en&theme=light|dark.
 * The width picks the device: below 640 px it is the phone's seat screen,
 * otherwise the desktop board with the seat panel docked on top.
 *
 *   1 — «У розмові + стрічка»: the form stands in the feed at the message that
 *       asked; one line under the seat header lists every open decision.
 *   2 — «Над полем вводу»: open forms dock above the composer, one at a time;
 *       the feed keeps a short pointer at the message that asked.
 *   3 — «Колонка «Рішення»»: the reports column gets a Decisions tab that
 *       holds the forms; the feed keeps a short pointer.
 */
import {
  ArrowDown, ArrowRight, Bot, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GalleryHorizontalEnd,
  Maximize2, MessageCircleQuestionMark, Mic, MoreHorizontal, PanelLeft, Paperclip, Search, Send, ScrollText,
} from "lucide-react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

import { DecisionCard, type FormKind } from "./card";
import { COPY, type Copy, type Lang } from "./copy";

type Variant = "1" | "2" | "3";
type State = "open" | "proto" | "answered";

const params = new URLSearchParams(window.location.search);
const v = (params.get("v") ?? "1") as Variant;
const state = (params.get("state") ?? "open") as State;
const lang: Lang = params.get("lang") === "en" ? "en" : "uk";
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
document.documentElement.lang = lang;
const copy = COPY[lang];
const phone = window.innerWidth < 640;

/* What is open in each state: the seat's own form, a lane's prototype round
   and a third question that only the strip or the list names. */
const openForms: Array<{ kind: FormKind | "third"; title: string }> = [
  ...(state === "answered" ? [] : [{ kind: "seat" as const, title: copy.seatForm.title }]),
  { kind: "proto", title: copy.protoForm.title },
  { kind: "third", title: copy.thirdForm.title },
];

/* ── The feed ─────────────────────────────────────────────────────────── */

function SeatMessage({ time, children }: { time: string; children: ReactNode }) {
  return (
    <div data-feed-row="seat" className="flex min-w-0 gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-claude-soft text-claude" aria-hidden><Bot className="h-4 w-4" /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-label text-muted"><span className="font-semibold text-secondary">Claude</span> · {time}</span>
        {children}
      </div>
    </div>
  );
}

function OperatorMessage({ text }: { text: string }) {
  return (
    <div data-feed-row="operator" className="flex justify-end">
      <p className="m-0 max-w-[80%] rounded-surface bg-user px-3 py-2 text-body text-primary">{text}</p>
    </div>
  );
}

/** Variants 2 and 3 keep a short pointer where the seat asked. */
function Pointer({ answered }: { answered: boolean }) {
  if (answered) return <DecisionCard kind="seat" copy={copy} phone={phone} time="17:46" answered />;
  return (
    <span data-dc-pointer="" className="inline-flex min-h-8 max-w-full items-center gap-1.5 self-start rounded-control border border-accent/30 bg-accent-soft px-2 text-label font-semibold text-accent [@media(pointer:coarse)]:min-h-11">
      <MessageCircleQuestionMark className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate font-medium text-primary">{copy.seatForm.title}</span>
      <span className="shrink-0">· {v === "2" ? copy.answerBelow : copy.inColumn}</span>
      {v === "2" ? <ArrowDown className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />}
    </span>
  );
}

function Feed() {
  const answered = state === "answered";
  const inline = v === "1";
  return (
    <div data-feed="" className={`flex min-w-0 flex-col gap-4 ${phone ? "px-3 py-3" : "px-4 py-4"}`}>
      <SeatMessage time="17:30"><p className="m-0 text-body text-primary">{copy.seatEarlier}</p></SeatMessage>
      <OperatorMessage text={copy.operatorAsk} />
      <SeatMessage time="17:42">
        <p className="m-0 text-body text-primary">{copy.seatAsk}</p>
        {inline
          ? <div className={phone ? "-ml-[38px]" : "max-w-[640px]"}><DecisionCard kind="seat" copy={copy} phone={phone} columns={phone ? 1 : 2} time={answered ? "17:46" : "17:42"} answered={answered} subject={state === "open"} /></div>
          : <Pointer answered={answered} />}
      </SeatMessage>
      {answered ? <SeatMessage time="17:46"><p className="m-0 text-body text-primary">{copy.seatAck}</p></SeatMessage> : null}
    </div>
  );
}

/* ── Variant 1's strip ────────────────────────────────────────────────── */

function StripChip({ kind, title, pressed }: { kind: FormKind | "third"; title: string; pressed?: boolean }) {
  const Mark = kind === "proto" ? GalleryHorizontalEnd : MessageCircleQuestionMark;
  return (
    <button type="button" aria-pressed={pressed} data-dc-chip={kind} className={`inline-flex h-7 min-w-0 max-w-[260px] shrink items-center gap-1.5 rounded-control border px-2 text-label font-semibold ${pressed ? "border-accent bg-accent text-white" : "border-accent/30 bg-card text-primary"}`}>
      <Mark className={`h-3.5 w-3.5 shrink-0 ${pressed ? "" : "text-accent"}`} aria-hidden />
      <span className="min-w-0 truncate">{title}</span>
    </button>
  );
}

function Strip() {
  const n = openForms.length;
  const proto = state === "proto";
  if (phone) {
    const first = proto ? openForms.find((f) => f.kind === "proto")! : openForms[0]!;
    return (
      <div data-decision-strip={n} className="relative z-10 shrink-0 border-b border-border bg-accent-soft/60">
        <button type="button" aria-expanded={proto} className="flex h-11 w-full min-w-0 items-center gap-2 px-3 text-left">
          {first.kind === "proto" ? <GalleryHorizontalEnd className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : <MessageCircleQuestionMark className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
          <span className="shrink-0 rounded-full bg-accent px-1.5 text-caption font-bold leading-5 text-white tabular-nums">{n}</span>
          <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{first.title}</span>
          {proto ? <ChevronUp className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : <ChevronDown className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
        </button>
      </div>
    );
  }
  const shown = openForms.slice(0, 2);
  return (
    <div data-decision-strip={n} className="relative z-10 shrink-0 border-b border-border bg-accent-soft/40">
      <div className="flex h-10 min-w-0 items-center gap-1.5 px-4">
        <MessageCircleQuestionMark className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span className="shrink-0 text-label font-semibold text-accent">{copy.open}</span>
        <span className="mr-1 shrink-0 rounded-full bg-accent px-1.5 text-caption font-bold leading-4 text-white tabular-nums">{n}</span>
        {shown.map((f) => <StripChip key={f.kind} kind={f.kind} title={f.title} pressed={proto && f.kind === "proto"} />)}
        {n > shown.length ? <button type="button" className="inline-flex h-7 shrink-0 items-center rounded-control px-2 text-label font-semibold text-accent">{copy.more(n - shown.length)}</button> : null}
      </div>
      {proto ? <div data-dc-overlay="" className="absolute left-4 top-full mt-1 w-[640px]"><div className="rounded-surface shadow-2"><DecisionCard kind="proto" copy={copy} phone={false} columns={2} time="17:20" subject /></div></div> : null}
    </div>
  );
}

/** The phone opens a strip row over the transcript, under the strip. */
function PhoneStripPanel() {
  return (
    <div data-dc-overlay="" className="absolute inset-0 z-10 overflow-y-auto bg-black/30 p-2">
      <div className="overflow-hidden rounded-surface bg-card shadow-2">
        <p className="m-0 border-b border-border bg-accent-soft px-3 py-1.5 text-label text-muted">{copy.fromLane} {copy.protoForm.lane} · {copy.variantsCount(copy.protoForm.variants.length)} · 17:20</p>
        <DecisionCard kind="proto" copy={copy} phone time="17:20" headless framed={false} subject />
      </div>
    </div>
  );
}

/* ── Variant 2's dock ─────────────────────────────────────────────────── */

function Dock() {
  const n = openForms.length;
  const kind: FormKind = state === "proto" ? "proto" : state === "answered" ? "proto" : "seat";
  const at = openForms.findIndex((f) => f.kind === kind) + 1;
  const stepper = (
    <span className="flex shrink-0 items-center gap-0.5">
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-control text-muted [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"><ChevronLeft className="h-4 w-4" aria-hidden /></span>
      <span className="text-label font-semibold tabular-nums text-secondary">{copy.ofN(at, n)}</span>
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-control text-accent [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"><ChevronRight className="h-4 w-4" aria-hidden /></span>
    </span>
  );
  return (
    <div data-decision-dock={n} className={`flex min-h-0 shrink-0 flex-col border-t border-border ${phone ? "max-h-[52%]" : "max-h-[56%]"}`}>
      <DecisionCard kind={kind} copy={copy} phone={phone} columns={phone ? 1 : 2} time="17:42" stepper={stepper} framed={false} scroll subject />
    </div>
  );
}

/* ── Variant 3's column ───────────────────────────────────────────────── */

function DecisionList() {
  const expanded: FormKind = state === "proto" ? "proto" : state === "answered" ? "proto" : "seat";
  return (
    <div data-decision-list={openForms.length} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      {openForms.map((f) => f.kind === expanded
        ? <DecisionCard key={f.kind} kind={expanded} copy={copy} phone={phone} time={f.kind === "seat" ? "17:42" : "17:20"} subject narrow />
        : (
          <button key={f.kind} type="button" data-dc-row={f.kind} className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-surface border border-border bg-card px-3 text-left">
            {f.kind === "proto" ? <GalleryHorizontalEnd className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : <MessageCircleQuestionMark className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
            <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{f.title}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          </button>
        ))}
    </div>
  );
}

function Tabs({ active }: { active: "decisions" | "reports" }) {
  const tab = (id: "decisions" | "reports", label: string, count?: number) => (
    <button type="button" role="tab" aria-selected={active === id} className={`inline-flex h-9 items-center gap-1.5 border-b-2 px-2 text-ui font-semibold ${active === id ? "border-accent text-primary" : "border-transparent text-muted"}`}>
      {label}
      {count ? <span className="rounded-full bg-accent px-1.5 text-caption font-bold leading-4 text-white tabular-nums">{count}</span> : null}
    </button>
  );
  return <div role="tablist" className="flex shrink-0 items-end gap-2 border-b border-border px-2">{tab("decisions", copy.decisionsTab, openForms.length)}{tab("reports", copy.reportsTab)}</div>;
}

/* ── Reports ──────────────────────────────────────────────────────────── */

function Reports() {
  const tone = { status: "text-muted", blocked: "text-warning", done: "text-success", question: "text-accent" } as const;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {copy.reportLines.map((line) => (
        <div key={line.time} className="border-b border-border px-3 py-2.5">
          <div className="mb-1 text-label"><span className="tabular-nums text-muted">{line.time}</span> <span className={`font-semibold ${tone[line.tone]}`}>{line.kind}</span></div>
          <p className="m-0 text-ui text-primary">{line.text}</p>
        </div>
      ))}
    </div>
  );
}

/* ── Composer ─────────────────────────────────────────────────────────── */

function Composer() {
  if (phone) {
    return (
      <div className="shrink-0 border-t border-border bg-card px-3 pb-4 pt-2">
        <div className="flex min-h-11 items-center gap-2 rounded-[22px] border border-border bg-canvas pl-4 pr-1">
          <span className="min-w-0 flex-1 truncate text-body text-muted">{copy.composerPhone}</span>
          <span className="inline-flex h-11 w-11 items-center justify-center text-muted"><Mic className="h-5 w-5" aria-hidden /></span>
        </div>
      </div>
    );
  }
  return (
    <div className="shrink-0 border-t border-border px-3 py-2">
      <div className="flex h-11 items-center gap-2 rounded-control border border-border bg-canvas pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-body text-muted">{copy.composer}</span>
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-control border border-border text-muted"><Mic className="h-4 w-4" aria-hidden /></span>
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-control bg-accent/70 text-white"><Send className="h-4 w-4" aria-hidden /></span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-label text-muted">
        <span className="font-semibold text-secondary">Opus 5.5 · high</span>
        <Paperclip className="h-3.5 w-3.5" aria-hidden />
      </div>
    </div>
  );
}

/* ── Desktop ──────────────────────────────────────────────────────────── */

function SeatHeader() {
  return (
    <header className="shrink-0 border-b border-border px-3 py-2">
      <div className="flex h-7 items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden><Bot className="h-4 w-4" /></span>
        <strong className="text-ui text-primary">{copy.seat}</strong>
        <span className="text-label text-muted">{copy.project}</span>
        <span className="inline-flex items-center gap-1 text-label font-semibold text-success"><i className="inline-block h-1.5 w-1.5 rounded-full bg-success" />{copy.working}</span>
        <span className="flex-1" />
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-control bg-accent-soft text-accent"><ScrollText className="h-4 w-4" aria-hidden /></span>
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-control text-muted"><PanelLeft className="h-4 w-4" aria-hidden /></span>
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-control text-muted"><Maximize2 className="h-4 w-4" aria-hidden /></span>
        <span className="inline-flex h-7 items-center gap-1 rounded-control border border-border px-2 text-label font-semibold text-secondary"><ChevronUp className="h-3.5 w-3.5" aria-hidden />{copy.fold}</span>
      </div>
      <div className="mt-1 flex h-6 items-center gap-2 text-label">
        <span className="rounded-sm bg-claude-soft px-1.5 py-0.5 font-semibold text-claude">Claude</span>
        <span className="font-semibold text-primary">{copy.model}</span>
        <span className="flex-1" />
        <span className="rounded-control border border-border px-2 py-0.5 text-secondary">{copy.reports} · {copy.journal}</span>
        <span className="rounded-control border border-border px-2 py-0.5 text-secondary">{copy.rotate}</span>
        <span className="rounded-control border border-border px-2 py-0.5 text-secondary">{copy.stopHost}</span>
      </div>
    </header>
  );
}

function Desktop() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-primary">
      <aside className="flex w-[248px] shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-12 items-center gap-2 px-4 text-ui font-bold"><span className="h-5 w-5 rounded-full bg-brand" aria-hidden />Delegatus</div>
        <div className="mx-3 flex h-8 items-center gap-2 rounded-control border border-border px-2 text-label text-muted"><Search className="h-3.5 w-3.5" aria-hidden />…</div>
        <div className="mt-3 px-3 text-label font-semibold text-muted">{lang === "uk" ? "Проєкти" : "Projects"}</div>
        <div className="mx-2 mt-1 flex h-9 items-center justify-between rounded-control bg-sunken px-2 text-ui font-semibold">delegatus<span className="text-label font-normal text-muted">31 с</span></div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 text-ui">
          <strong>delegatus</strong>
          <span className="inline-flex items-center gap-1 text-label text-success"><i className="inline-block h-1.5 w-1.5 rounded-full bg-success" />{lang === "uk" ? "5 працюють" : "5 working"}</span>
          <span className="flex-1" />
          <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border px-2.5 text-label font-semibold"><i className="inline-block h-1.5 w-1.5 rounded-full bg-warning" />{lang === "uk" ? "Чекають на вас" : "Waiting for you"} <span className="tabular-nums">3</span></span>
        </div>
        <section data-seat-panel="" className="mx-4 mt-3 flex h-[690px] shrink-0 flex-col overflow-hidden rounded-surface border border-border bg-card shadow-1">
          <SeatHeader />
          <div className="flex min-h-0 flex-1">
            <div data-conversation="" className="flex min-h-0 min-w-0 flex-1 flex-col">
              {v === "1" ? <Strip /> : null}
              <div data-scroller="" className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden"><Feed /></div>
              {v === "2" ? <Dock /> : null}
              <Composer />
            </div>
            <aside data-reports="" className="flex w-[380px] shrink-0 flex-col border-l border-border">
              {v === "3" ? <><Tabs active="decisions" /><DecisionList /></> : <><div className="flex h-9 shrink-0 items-center border-b border-border px-3 text-ui font-semibold">{copy.reports}</div><Reports /></>}
            </aside>
          </div>
        </section>
        <div className="mx-4 mt-3 grid grid-cols-4 gap-3 opacity-70">
          {copy.boardColumns.map((c) => <div key={c} className="h-24 rounded-surface border border-border bg-card px-3 py-2 text-ui font-semibold">{c}</div>)}
        </div>
      </main>
    </div>
  );
}

/* ── Phone ────────────────────────────────────────────────────────────── */

function Phone() {
  const sheet = v === "3";
  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-card text-primary">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border pl-1 pr-1">
        <span className="inline-flex h-11 w-11 items-center justify-center text-secondary"><ChevronLeft className="h-5 w-5" aria-hidden /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-bold">{copy.phoneTitle}</span>
          <span className="truncate text-label text-success">{copy.phoneStatus}</span>
        </span>
        <span className="relative inline-flex h-11 w-11 items-center justify-center text-secondary">
          <ScrollText className="h-5 w-5" aria-hidden />
        </span>
        <span className="inline-flex h-11 w-11 items-center justify-center text-secondary"><MoreHorizontal className="h-5 w-5" aria-hidden /></span>
      </header>
      {v === "1" ? <Strip /> : null}
      {v === "3" ? (
        <button type="button" data-decision-strip={openForms.length} className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-accent-soft/60 px-3 text-left">
          <MessageCircleQuestionMark className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary">{copy.openCount(openForms.length)}</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        </button>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div data-scroller="" className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden"><Feed /></div>
        {v === "1" && state === "proto" ? <PhoneStripPanel /> : null}
      </div>
      {v === "2" ? <Dock /> : null}
      <Composer />
      {sheet ? (
        <div data-decision-sheet="" className="absolute inset-0 flex flex-col justify-end bg-black/40">
          <div className="flex max-h-[86%] min-h-0 flex-col rounded-t-[16px] bg-card shadow-2">
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border" aria-hidden />
            <Tabs active="decisions" />
            <DecisionList />
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(phone ? <Phone /> : <Desktop />);
export type { Copy };
