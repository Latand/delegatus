"use client";

/**
 * Prototype for the three variants in docs/design/memory-in-conversation.md:
 * how the conversation shows Jev choosing memory for an operator's message, and
 * the memory it chose. One component, three drawings, behind `variant`.
 *
 * It reads one `MemorySelectionFixture` shaped like the phase 3 ledger offer
 * (§5) and calls no memory route. «Open» goes through the artifact preview, so
 * it never writes an `opened` outcome (§2.2). Nothing here is mounted by a
 * production component; the conversation window's evidence fixture composes it.
 *
 * `placement` says which part to draw, so the two halves of variant 1 on the
 * phone can sit in two slots of `UserMessageRow`:
 *   `line`    the collapsed element only;
 *   `detail`  the expanded body only (nothing while closed);
 *   `row`     both, in the order the variant reads them.
 */

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { BookText, Brain, ChevronDown, ChevronRight, ExternalLink, Sparkles, TriangleAlert } from "lucide-react";

import { EngineBadge, EngineMark } from "@/components/EngineMark";
import { formatDuration } from "@/components/feed/duration";
import { READING_MEASURE } from "@/components/feed/measure";
import { MobileSheet } from "@/components/mobile/MobileSheet";
import type { MobileSheetName } from "@/components/mobile/mobileNav";
import { openArtifactPreview } from "@/components/preview/previewBus";
import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale, type Locale, type TFunction } from "@/lib/i18n";

import { quoteHead } from "./deputyPlacement";

/** One memory Jev offered: a `memory_offers` row (channel "inject") joined to
    its `memory_entries` row. */
export interface MemoryOfferFixture {
  /** memory_offers.memory_id = memory_entries.id; the search_memory id. */
  memoryId: `m_${string}`;
  /** memory_entries.engine: who wrote the entry. */
  engine: "claude" | "codex" | "shared";
  /** memory_entries.kind; drawn only to name a shared entry. */
  kind: "preference" | "project_fact" | "reference" | "failure" | "instruction" | "skill";
  /** memory_entries.writtenAt, ISO 8601. */
  writtenAt: string;
  title: string;
  summary: string;
  /** memory_offers.score: Jev's probability; offered entries are 0.70–1. */
  score: number;
  /** Characters this entry took in the injected block (≤ 10 000 per message). */
  chars: number;
  /** Where «Open» goes: memory_entries.sourcePath and the anchor's line. */
  source: { path: string; line?: number };
  /** memory_offers.outcome / outcome_at. Carried for the build; no variant draws it. */
  outcome: null | { kind: "opened" | "cited"; at: string };
}

export type MemorySelectionState = "selecting" | "offered" | "none" | "skipped" | "failed";

export interface MemorySelectionFixture {
  /** memory_offers.request_id: one selection per operator message. */
  requestId: string;
  /** memory_offers.conversation_id. */
  conversationId: string;
  /** The operator message's row key in the feed (its delivery identity). */
  messageKey: string;
  state: MemorySelectionState;
  /** When the hook asked. Drives variant 3's fill. */
  startedAt: string;
  /** Absent while selecting. */
  settledAt?: string;
  /** Candidates Jev weighed; absent when unknown and when skipped. */
  considered?: number;
  /** skipped: why the gate closed; failed: what failed. */
  reason?: "short" | "machine" | "timeout" | "error" | "cap";
  /** offered only: 1–15 entries, highest score first, Σ chars ≤ 10 000. */
  offers: MemoryOfferFixture[];
}

export type MemoryVariant = 1 | 2 | 3;
export type MemoryPlacement = "line" | "detail" | "row";

/** Entries a variant shows expanded before «Show N more» (§2.2). Variant 3's
    phone sheet scrolls, so it shows all. */
const INITIAL_SHOWN: Record<MemoryVariant, number> = { 1: 5, 2: 6, 3: 6 };

const ENGINE_WORD: Record<string, string> = { claude: "Claude", codex: "Codex" };

const DAY_MS = 86_400_000;

function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** «today», «yesterday», `N d ago` up to six days, then «2 Oct» (§2.2). Days
    are counted in UTC so a frame reads the same wherever it is rendered. */
function formatDate(writtenAt: string, now: number, locale: Locale, t: TFunction): string {
  const written = Date.parse(writtenAt);
  const days = utcDay(now) - utcDay(written);
  if (days <= 0) return t("memory.today");
  if (days === 1) return t("memory.yesterday");
  if (days <= 6) return t("time.agoDay", { n: days });
  const sameYear = new Date(written).getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-US", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(written);
}

function formatScore(score: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "uk" ? "uk-UA" : "en-US", { style: "percent", maximumFractionDigits: 0 }).format(score);
}

function sharedWord(kind: MemoryOfferFixture["kind"], t: TFunction): string {
  return kind === "skill" ? t("memory.shared.skill") : t("memory.shared.instruction");
}

/** «Codex ×3 · Instructions ×1», in score order of first appearance. */
function sourceCounts(offers: MemoryOfferFixture[], t: TFunction): string {
  const counts = new Map<string, number>();
  for (const offer of offers) {
    const name = offer.engine === "shared" ? sharedWord(offer.kind, t) : ENGINE_WORD[offer.engine] ?? offer.engine;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => `${name} ×${n}`).join(" · ");
}

function durationMs(selection: MemorySelectionFixture): number | null {
  return selection.settledAt ? Date.parse(selection.settledAt) - Date.parse(selection.startedAt) : null;
}

/** What the collapsed element says, in words, for every state of every variant. */
interface LineCopy {
  /** Variant 2's bold label, «Memory». */
  label?: string;
  /** The words. */
  text: string;
  /** Variant 2's right-aligned duration. */
  duration?: string;
}

function failureWord(selection: MemorySelectionFixture): "timeout" | "error" | "cap" {
  return selection.reason === "error" || selection.reason === "cap" ? selection.reason : "timeout";
}

function lineCopy(variant: MemoryVariant, selection: MemorySelectionFixture, locale: Locale, t: TFunction): LineCopy {
  const count = selection.offers.length;
  const considered = selection.considered;
  const took = durationMs(selection);
  const seconds = took === null ? undefined : formatDuration(took);
  if (variant === 1) {
    switch (selection.state) {
      case "selecting": return { text: t("memory.v1.selecting") };
      case "offered": return { text: t("memory.v1.added", { count }) };
      case "none": return { text: t("memory.v1.none") };
      case "skipped": return { text: t("memory.v1.skipped") };
      case "failed": return { text: t(`memory.v1.failed.${failureWord(selection)}`) };
    }
  }
  if (variant === 2) {
    const label = t("memory.v2.label");
    switch (selection.state) {
      case "selecting":
        return { label, text: considered ? t("memory.v2.selecting", { count: considered }) : t("memory.v2.selectingPlain") };
      case "offered":
        return {
          label,
          text: [considered ? t("memory.v2.offered", { count, considered }) : t("memory.v2.offeredPlain", { count }), sourceCounts(selection.offers, t)].join(" · "),
          duration: seconds,
        };
      case "none":
        return { label, text: considered ? t("memory.v2.none", { count: considered }) : t("memory.v2.nonePlain"), duration: seconds };
      case "skipped": return { label, text: t("memory.v2.skipped") };
      case "failed": return { label, text: t(`memory.v2.failed.${failureWord(selection)}`) };
    }
  }
  switch (selection.state) {
    case "selecting": return { text: t("memory.v3.selecting") };
    case "offered": return { text: t("memory.v3.offered", { count }) };
    case "none": return { text: t("memory.v3.none") };
    case "skipped": return { text: t("memory.v3.skipped") };
    case "failed": return { text: t(`memory.v3.failed.${failureWord(selection)}`) };
  }
}

function announcement(selection: MemorySelectionFixture, t: TFunction): string {
  if (selection.state === "offered") return t("memory.announce.offered", { count: selection.offers.length });
  if (selection.state === "none") return t("memory.announce.none");
  if (selection.state === "failed") return t("memory.announce.failed");
  return "";
}

/** Bold the count in «Added 4 memories» (the count is the one number the line carries). */
function withBoldCount(text: string): ReactNode {
  const parts = text.split(/(\d+)/);
  return parts.map((part, index) => (index % 2 === 1 ? <b key={index} className="font-semibold">{part}</b> : part));
}

/** Freeze a looping or deadline animation at `phaseMs` for a deterministic frame;
    without it a late paint starts mid-way, so a fill always reaches its end at
    the deadline. */
function phaseStyle(phaseMs: number | undefined, elapsedMs: number): CSSProperties {
  return phaseMs === undefined
    ? { animationDelay: `-${elapsedMs}ms` }
    : { animationDelay: `-${phaseMs}ms`, animationPlayState: "paused" };
}

/* ───────────────────────────── shared pieces ───────────────────────────── */

function SharedGlyph({ kind, size = 12 }: { kind: MemoryOfferFixture["kind"]; size?: number }) {
  const Glyph = kind === "skill" ? Sparkles : BookText;
  return <Glyph style={{ width: size, height: size }} className="shrink-0" aria-hidden />;
}

/** Variant 1 and 3 badge: the engine mark and word in its tint, or the kind of
    a shared entry in the neutral one. */
function SourceBadge({ offer, t }: { offer: MemoryOfferFixture; t: TFunction }) {
  if (offer.engine !== "shared") return <EngineBadge engine={offer.engine} className="px-1.5 py-0.5 text-label font-semibold" />;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sunken px-1.5 py-0.5 text-label font-semibold text-secondary">
      <SharedGlyph kind={offer.kind} />
      {sharedWord(offer.kind, t)}
    </span>
  );
}

function Confidence({ offer, locale, t }: { offer: MemoryOfferFixture; locale: Locale; t: TFunction }) {
  const value = formatScore(offer.score, locale);
  return (
    <span className="tabular-nums" data-memory-score={value}>
      <span aria-hidden>{value}</span>
      <span className="sr-only">{t("memory.confidence", { value })}</span>
    </span>
  );
}

interface EntryContext {
  t: TFunction;
  locale: Locale;
  now: number;
  coarse: boolean;
  mobile: boolean;
  onOpen: (offer: MemoryOfferFixture) => void;
}

function entryAttributes(offer: MemoryOfferFixture, cx: EntryContext) {
  return {
    "data-memory-offer": offer.memoryId,
    "data-memory-engine": offer.engine,
    "data-memory-date": formatDate(offer.writtenAt, cx.now, cx.locale, cx.t),
    "data-memory-title": offer.title,
    "data-memory-summary": offer.summary,
  };
}

/** Variant 1 and 3 card (§3, variant 1 expanded): badge · date and confidence,
    the title, the summary, «Open». */
function MemoryCard({ offer, cx, tone }: { offer: MemoryOfferFixture; cx: EntryContext; tone: "card" | "inset" }) {
  const { t, locale, coarse, mobile } = cx;
  return (
    <li
      {...entryAttributes(offer, cx)}
      className={`list-none rounded-surface border border-border px-3 py-2 ${tone === "card" ? "bg-card" : "bg-canvas"}`}
    >
      <div className="flex items-center gap-1.5 text-label text-muted">
        <SourceBadge offer={offer} t={t} />
        <span className="tabular-nums">{formatDate(offer.writtenAt, cx.now, locale, t)}</span>
        <span className="ml-auto"><Confidence offer={offer} locale={locale} t={t} /></span>
      </div>
      <div className={`mt-1 text-body font-semibold text-primary [overflow-wrap:anywhere] ${mobile ? "line-clamp-2" : "truncate"}`} title={offer.title}>
        {offer.title}
      </div>
      <p className="mt-0.5 line-clamp-2 text-ui text-secondary [overflow-wrap:anywhere]">{offer.summary}</p>
      <div className="flex justify-end">
        <button
          type="button"
          data-memory-open
          aria-label={t("memory.openAria", { title: offer.title })}
          onClick={() => cx.onOpen(offer)}
          className={`-mr-1 inline-flex items-center gap-1 rounded-control px-1 text-label font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${coarse ? "h-11" : "h-6"}`}
        >
          {t("memory.open")}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </button>
      </div>
    </li>
  );
}

/** Variant 2 row: the engine mark, the title and confidence, then the date and
    the summary; «Open» is an icon button. */
function MemoryRow({ offer, cx }: { offer: MemoryOfferFixture; cx: EntryContext }) {
  const { t, locale, coarse, mobile } = cx;
  const date = formatDate(offer.writtenAt, cx.now, locale, t);
  const meta = offer.engine === "shared" ? `${sharedWord(offer.kind, t)} · ${date}` : date;
  return (
    <li {...entryAttributes(offer, cx)} className={`flex list-none items-start gap-2 py-1.5 ${coarse ? "min-h-11" : "min-h-9"}`}>
      <span
        className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center"
        data-memory-badge
        title={offer.engine === "shared" ? sharedWord(offer.kind, t) : ENGINE_WORD[offer.engine]}
      >
        {offer.engine === "shared" ? <SharedGlyph kind={offer.kind} size={14} /> : <EngineMark engine={offer.engine} size={14} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-semibold text-primary" title={offer.title}>{offer.title}</span>
          <span className="shrink-0 text-ui text-secondary"><Confidence offer={offer} locale={locale} t={t} /></span>
        </div>
        <div className={`text-label text-muted [overflow-wrap:anywhere] ${mobile ? "line-clamp-2" : "truncate"}`}>
          <span className="tabular-nums">{meta}</span> · {offer.summary}
        </div>
      </div>
      <button
        type="button"
        data-memory-open
        aria-label={t("memory.openAria", { title: offer.title })}
        title={t("memory.open")}
        onClick={() => cx.onOpen(offer)}
        className={`-mr-1.5 flex shrink-0 items-center justify-center rounded-control text-secondary opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 motion-reduce:transition-none ${coarse ? "-my-1.5 h-11 w-11" : "h-[22px] w-[22px]"}`}
      >
        <ExternalLink className="h-3 w-3" aria-hidden />
      </button>
    </li>
  );
}

/** «Show 9 more»: reveals the rest in place. */
function ShowMore({ hidden, onClick, cx, className = "" }: { hidden: number; onClick: () => void; cx: EntryContext; className?: string }) {
  if (hidden <= 0) return null;
  return (
    <button
      type="button"
      data-memory-more={hidden}
      onClick={onClick}
      className={`inline-flex items-center rounded-control px-1 text-label font-semibold text-muted hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${cx.coarse ? "h-11" : "h-6"} ${className}`}
    >
      {cx.t("memory.showMore", { count: hidden })}
    </button>
  );
}

/* ─────────────────────────────── the element ───────────────────────────── */

export interface MemorySelectionProps {
  selection: MemorySelectionFixture;
  variant: MemoryVariant;
  /** The frozen clock the relative dates read against. */
  now: number;
  /** Freeze the selecting animation at this many ms (the evidence driver). */
  phaseMs?: number;
  placement?: MemoryPlacement;
  /** Whether the memories are expanded; the caller owns it so the two halves of variant 1 agree. */
  open?: boolean;
  onToggle?: () => void;
  /** The reader opened it a moment ago: the body enters with `deputy-settle`. */
  animateOpen?: boolean;
  /** A live selection just settled: the new words fade in over 200 ms. */
  animateSettle?: boolean;
  /** The operator's message, for variant 3's panel and sheet titles. */
  messageText?: string;
}

export function MemorySelection(props: MemorySelectionProps) {
  const { selection, placement = "row" } = props;
  /* Machine-written deliveries never draw as an operator bubble, so there is nothing to attach to (§2.1). */
  if (selection.state === "skipped" && selection.reason === "machine") return null;
  return (
    <>
      {placement !== "detail" ? <MemoryLine {...props} /> : null}
      {placement !== "line" && props.open && selection.state === "offered" ? <MemoryDetail {...props} /> : null}
    </>
  );
}

function useEntryContext(now: number): EntryContext {
  const { t, locale } = useLocale();
  return {
    t,
    locale,
    now,
    coarse: useCoarsePointer(),
    mobile: useIsMobile(),
    onOpen: (offer) => openArtifactPreview(offer.source.line ? `${offer.source.path}:${offer.source.line}` : offer.source.path),
  };
}

function MemoryLine({ selection, variant, now, phaseMs, open = false, onToggle, animateSettle = false }: MemorySelectionProps) {
  const cx = useEntryContext(now);
  const { t, locale, coarse } = cx;
  const detailId = `memory-detail-${useId()}`;
  const [elapsedMs] = useState(() => Math.max(0, Date.now() - Date.parse(selection.startedAt)));
  const copy = lineCopy(variant, selection, locale, t);
  const selecting = selection.state === "selecting";
  const failed = selection.state === "failed";
  const expandable = selection.state === "offered";
  const spoken = copy.label ? `${copy.label} · ${copy.text}` : copy.text;
  const toggleWord = t(open ? "memory.toggleHide" : "memory.toggleShow");
  const settle = animateSettle && !selecting ? "memory-settle motion-reduce:animate-none" : "";
  const phase = phaseStyle(phaseMs, elapsedMs);
  const common = {
    "data-memory-line": "",
    "data-memory-selection": selection.state,
    "data-memory-variant": variant,
  };
  const live = <span role="status" aria-live="polite" className="sr-only">{announcement(selection, t)}</span>;
  const Wrap = (expandable ? "button" : "div") as "button";
  const wrapProps = expandable
    ? { type: "button" as const, "data-memory-toggle": "", "aria-expanded": open, "aria-controls": detailId, "aria-label": `${spoken}. ${toggleWord}`, onClick: onToggle }
    : { title: failed ? spoken : undefined };
  const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

  /* ── Variant 1 · «Under the message» ── */
  if (variant === 1) {
    const icon = failed
      ? <TriangleAlert className="h-3 w-3 shrink-0 text-warning" aria-hidden />
      : <Brain className={`h-3 w-3 shrink-0 ${selecting ? "text-accent" : "text-muted"}`} aria-hidden />;
    return (
      <div {...common} className={`flex min-w-0 max-w-full justify-end ${coarse ? "" : "mt-1"}`}>
        <Wrap
          {...wrapProps}
          className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-control px-1 text-label ${failed ? "text-secondary" : "text-muted"} ${coarse ? "h-11" : "h-6"} ${expandable ? `hover:bg-sunken ${focusRing}` : ""}`}
        >
          {icon}
          <span
            className={`min-w-0 truncate ${selecting ? "memory-sweep motion-reduce:animate-none" : settle}`}
            style={selecting ? phase : undefined}
            title={spoken}
          >
            {expandable ? withBoldCount(copy.text) : copy.text}
          </span>
          {expandable ? <ChevronDown className={`h-3 w-3 shrink-0 transition-transform duration-[120ms] motion-reduce:transition-none ${open ? "rotate-180" : ""}`} aria-hidden /> : null}
        </Wrap>
        {live}
      </div>
    );
  }

  /* ── Variant 2 · «Turn step» ── */
  if (variant === 2) {
    const glyph = selecting ? (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center gap-px" data-memory-dots aria-hidden>
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="memory-scan-dot h-1 w-1 rounded-full bg-accent motion-reduce:animate-none"
            style={phaseMs === undefined ? { animationDelay: `${dot * 200 - elapsedMs}ms` } : { animationDelay: `${dot * 200 - phaseMs}ms`, animationPlayState: "paused" }}
          />
        ))}
      </span>
    ) : failed ? (
      <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
    ) : (
      <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden />
    );
    return (
      <div {...common} className={`my-0.5 min-w-0 ${cx.mobile ? "" : "ml-9"}`}>
        <Wrap
          {...wrapProps}
          className={`flex w-full min-w-0 items-center gap-2 rounded-control text-left text-ui text-muted ${coarse ? "h-11" : "h-6"} ${expandable ? `hover:bg-sunken ${focusRing}` : ""}`}
        >
          {expandable
            ? <ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-[120ms] motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden />
            : <span className="h-3 w-3 shrink-0" aria-hidden />}
          {glyph}
          <span className={`min-w-0 flex-1 truncate text-secondary ${settle}`} title={spoken}>
            <span className="font-semibold">{copy.label}</span> · {copy.text}
          </span>
          {copy.duration ? <span className={`shrink-0 text-caption tabular-nums text-muted ${settle}`}>{copy.duration}</span> : null}
        </Wrap>
        {live}
      </div>
    );
  }

  /* ── Variant 3 · «Between you» ── */
  const marks: MemoryOfferFixture[] = [];
  for (const offer of selection.offers) {
    const identity = offer.engine === "shared" ? `shared:${offer.kind === "skill" ? "skill" : "instruction"}` : offer.engine;
    if (!marks.some((mark) => (mark.engine === "shared" ? `shared:${mark.kind === "skill" ? "skill" : "instruction"}` : mark.engine) === identity)) marks.push(offer);
  }
  const fillStyle = (side: "left" | "right"): CSSProperties => ({ transformOrigin: side, ...phase });
  const hairline = (side: "left" | "right") => (
    <span className={`relative h-px min-w-3 flex-1 ${failed ? "bg-warning/60" : "bg-border"}`} aria-hidden data-memory-hairline={side}>
      {selecting ? (
        <span className="memory-fill absolute inset-x-0 -top-px h-[3px] rounded-full bg-accent motion-reduce:animate-none" style={fillStyle(side)} />
      ) : null}
    </span>
  );
  return (
    <div
      {...common}
      className={`mx-auto my-2 flex w-full max-w-[min(100%,720px)] items-center gap-2 ${coarse ? "h-11" : "h-7"}`}
    >
      {hairline("left")}
      <Wrap
        {...wrapProps}
        className={`inline-flex min-w-0 max-w-[88%] items-center gap-1.5 rounded-control px-1.5 text-label ${failed ? "text-secondary" : "text-muted"} ${coarse ? "h-11" : "h-6"} ${expandable ? `hover:bg-sunken ${focusRing}` : ""}`}
      >
        {selecting ? <Brain className="h-3 w-3 shrink-0 text-accent" aria-hidden /> : null}
        {failed ? <TriangleAlert className="h-3 w-3 shrink-0 text-warning" aria-hidden /> : null}
        {expandable ? (
          <span className="flex shrink-0 items-center" data-memory-marks aria-hidden>
            {marks.slice(0, 3).map((mark, index) => (
              <span key={mark.memoryId} className={`relative flex h-4 w-4 items-center justify-center rounded-full bg-canvas ring-[1.5px] ring-canvas ${index ? "-ml-1" : ""}`}>
                {mark.engine === "shared" ? <SharedGlyph kind={mark.kind} /> : <EngineMark engine={mark.engine} size={12} />}
              </span>
            ))}
          </span>
        ) : null}
        <span className={`min-w-0 truncate ${settle}`} title={spoken}>{copy.text}</span>
        {expandable ? <ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-[120ms] motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden /> : null}
      </Wrap>
      {hairline("right")}
      {live}
    </div>
  );
}

function MemoryDetail({ selection, variant, now, onToggle, animateOpen = false, messageText = "" }: MemorySelectionProps) {
  const cx = useEntryContext(now);
  const { t } = cx;
  const [showAll, setShowAll] = useState(false);
  const enter = animateOpen ? "deputy-settle motion-reduce:animate-none" : "";
  const offers = selection.offers;
  const phoneSheet = variant === 3 && cx.mobile;
  const shown = showAll || phoneSheet ? offers : offers.slice(0, INITIAL_SHOWN[variant]);
  const hidden = offers.length - shown.length;
  const detailAttributes = { "data-memory-detail": "", "data-memory-variant": variant, "data-memory-count": offers.length };

  /* Variant 1: a right-aligned stack of cards at the bubble's width. */
  if (variant === 1) {
    return (
      <div {...detailAttributes} className={`mt-1 flex w-full flex-col items-end ${enter}`}>
        <ul data-memory-list className={`flex w-full flex-col gap-1.5 ${cx.mobile ? "max-w-[86%]" : "max-w-[min(75%,68ch)]"}`}>
          {shown.map((offer) => <MemoryCard key={offer.memoryId} offer={offer} cx={cx} tone="card" />)}
        </ul>
        <ShowMore hidden={hidden} onClick={() => setShowAll(true)} cx={cx} />
      </div>
    );
  }

  /* Variant 2: dense rows in the sunken block an expanded tool run uses. */
  if (variant === 2) {
    return (
      <div {...detailAttributes} className={`mb-1 min-w-0 ${cx.mobile ? "" : "ml-9"} ${enter}`}>
        <div className={`rounded-surface bg-sunken px-3 py-1 ${cx.mobile ? "" : READING_MEASURE}`}>
          <ul data-memory-list className="divide-y divide-border">
            {shown.map((offer) => <MemoryRow key={offer.memoryId} offer={offer} cx={cx} />)}
          </ul>
          <ShowMore hidden={hidden} onClick={() => setShowAll(true)} cx={cx} className="-ml-1" />
        </div>
      </div>
    );
  }

  /* Variant 3 on the phone: a bottom sheet, the production anatomy. */
  const head = quoteHead(messageText, 60);
  if (phoneSheet) {
    return (
      <div {...detailAttributes}>
        <MobileSheet name={"memory" as MobileSheetName} title={t("memory.v3.sheetTitle")} onClose={() => onToggle?.()}>
          <p className="truncate px-4 pb-2 text-ui text-muted">{head}</p>
          <ul data-memory-list className="flex flex-col gap-2 px-4 pb-3">
            {shown.map((offer) => <MemoryCard key={offer.memoryId} offer={offer} cx={cx} tone="card" />)}
          </ul>
        </MobileSheet>
      </div>
    );
  }

  /* Variant 3 on the desktop: a card panel under the divider. */
  return (
    <div
      {...detailAttributes}
      className={`@container mx-auto mb-2 w-full max-w-[760px] rounded-surface border border-border bg-card p-2 ${enter}`}
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-2 text-label text-muted">
        <span className="min-w-0 truncate">{t("memory.v3.panelTitle", { quote: quoteHead(messageText) })}</span>
        <button
          type="button"
          onClick={() => onToggle?.()}
          className={`shrink-0 rounded-control px-1 font-semibold hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${cx.coarse ? "h-11" : "h-6"}`}
        >
          {t("memory.v3.collapse")}
        </button>
      </div>
      <ul data-memory-list className="grid grid-cols-1 gap-2 @[560px]:grid-cols-2">
        {shown.map((offer) => <MemoryCard key={offer.memoryId} offer={offer} cx={cx} tone="inset" />)}
      </ul>
      <div className="flex justify-center">
        <ShowMore hidden={hidden} onClick={() => setShowAll(true)} cx={cx} />
      </div>
    </div>
  );
}
