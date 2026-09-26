"use client";

import { CheckCircle2, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useRuntimeSessionForConversation } from "@/hooks/useRuntime";
import { useLocale, type MessageKey } from "@/lib/i18n";
import type { McpCallLink } from "@/lib/mcp/presentation";
import type { SeatDeputyView } from "@/lib/orchestrator/deputyView";

import { ChevronDown, ChevronRight } from "../icons";
import { FeedItem } from "../feed/FeedItem";
import { GalleryOwnerProvider } from "../feed/Lightbox";
import { createFeedSession, type FeedSnapshot } from "../feed/parse";
import { DeputyInkContext, DeputyMark } from "./deputyInk";
import { quoteHead } from "./deputyPlacement";
import { LiveMcpLinkChip, LiveTurnRows, useConversationAvailability } from "./LiveTurnRows";
import { publishCanonicalAssistantClaims, useCanonicalAssistantClaims, visibleRuntimeLiveTurnItems } from "./liveTurnHandoff";
import { FeedMessageRow } from "./OutboxBubbles";

/**
 * The orchestrator's parallel self, as a block of the seat's own feed
 * (docs/design/ghost-seat.md §6.2, §6.3).
 *
 * Head: the ask, the ordinary operator bubble, drawn from the deputy record,
 * with «→ parallel self» and the outline mark on its meta line: the person
 * said it, so the bubble keeps its fill, and the line says who it went to.
 * Caption: the seat's engine mark in a dashed ring, «Orchestrator · parallel
 * self», the start time and the state. Body: the deputy's own rows, hanging
 * from a dashed edge — its canonical records read past the fork prefix, and
 * its in-flight rows from its runtime session through the feed's own
 * `LiveTurnRows` and claim handoff. Finished, the block collapses to one line
 * with the entity chips of what it touched; the chevron expands it again.
 */

const OUTCOME_KEYS: Record<NonNullable<SeatDeputyView["outcome"]>, MessageKey> = {
  done: "deputy.outcome.done",
  timeout: "deputy.outcome.timeout",
  "host-died": "deputy.outcome.hostDied",
  "seat-rotated": "deputy.outcome.seatRotated",
  failed: "deputy.outcome.failed",
};

/** How often a live, open block reads its own records. The in-flight rows
    stream through the runtime store; this only brings the canonical rows. */
export const DEPUTY_RECORDS_POLL_MS = 2_500;

export interface DeputyRecords {
  lines: string[];
  missing: boolean;
  loaded: boolean;
}

type RecordsFetch = (askId: string, signal: AbortSignal) => Promise<{ lines: string[]; missing: boolean }>;

const defaultFetch: RecordsFetch = async (askId, signal) => {
  const response = await fetch(`/api/orchestrator/ghost?askId=${encodeURIComponent(askId)}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`deputy records ${response.status}`);
  const body = await response.json() as { lines?: unknown; missing?: unknown };
  return {
    lines: Array.isArray(body.lines) ? body.lines.filter((line): line is string => typeof line === "string") : [],
    missing: body.missing === true,
  };
};
let recordsFetch: RecordsFetch = defaultFetch;

/** Test seam: the block's record reader. */
export function setDeputyRecordsFetchForTests(fetcher: RecordsFetch | null): void {
  recordsFetch = fetcher ?? defaultFetch;
}

/** The deputy's own records, read while the block is open: polled while it
    runs, read once when it has ended. */
function useDeputyRecords(askId: string, open: boolean, live: boolean): DeputyRecords {
  const [records, setRecords] = useState<DeputyRecords>({ lines: [], missing: false, loaded: false });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const answer = await recordsFetch(askId, controller.signal);
        setRecords((previous) => (previous.loaded && previous.missing === answer.missing
          && previous.lines.length === answer.lines.length && previous.lines.at(-1) === answer.lines.at(-1)
          ? previous
          : { ...answer, loaded: true }));
      } catch {
        /* A failed read keeps what the block had; the next poll asks again. */
      }
      if (live && !controller.signal.aborted) timer = setTimeout(() => { void read(); }, DEPUTY_RECORDS_POLL_MS);
    };
    void read();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [askId, open, live]);
  return records;
}

/** The operator's ask reached the deputy as its first record, with the
    parallel note under it; the block's head already shows the ask, so no
    operator-text record of the deputy is drawn again. Tool results stay: the
    tool cards pair with them. */
function withoutDeliveredAsk(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    if (!line.includes('"user"')) return true;
    try {
      const record = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
      if (record.type !== "user") return true;
      const content = record.message?.content;
      if (typeof content === "string") return false;
      return Array.isArray(content) && content.some((block) => (block as { type?: unknown })?.type === "tool_result");
    } catch {
      return true;
    }
  });
}

/** The entity chips of what the deputy touched. The labels are the ones
    `describeMcpCall` writes, so the chip draws them in the interface language
    through the same `mcpLinkLabel` every MCP chip reads. */
export function touchedLinks(touched: SeatDeputyView["touched"]): McpCallLink[] {
  return [
    ...touched.taskIds.map((id) => ({ kind: "task" as const, id, label: "Open task", href: `#task=${encodeURIComponent(id)}` })),
    ...touched.pipelineIds.map((id) => ({ kind: "pipeline" as const, id, label: "Open pipeline", href: `#pipeline=${encodeURIComponent(id)}` })),
    ...touched.conversationIds.map((id) => ({ kind: "conversation" as const, id, label: "Open conversation", href: `#c=${encodeURIComponent(id)}` })),
  ];
}

const EMPTY_FEED: FeedSnapshot = { items: [], hiddenServiceCount: 0 };

/** Local HH:MM of the moment the ask was sent. */
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function DeputyBlock({ deputy, engine = "claude" }: { deputy: SeatDeputyView; engine?: string }) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const availability = useConversationAvailability();
  const live = deputy.state !== "ended";
  const warn = deputy.outcome !== null && deputy.outcome !== "done";

  /* Open while live. Once it ends it collapses, unless the reader opened it by
     hand, or the pointer or focus is inside it — then it waits until they
     leave, so the answer is never pulled from under the reader. */
  const [manual, setManual] = useState<boolean | null>(null);
  const [inside, setInside] = useState(false);
  const [held, setHeld] = useState(false);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live && inside) setHeld(true);
    wasLive.current = live;
  }, [live, inside]);
  useEffect(() => {
    if (!inside && held) setHeld(false);
  }, [inside, held]);
  const open = manual ?? (live || held);
  /* The settle motion plays only for a change the reader sees happen: the
     block ended in view, or the reader toggled it. */
  const [initialOpen] = useState(open);
  const settle = open !== initialOpen || manual !== null ? " deputy-settle" : "";

  const records = useDeputyRecords(deputy.askId, open, live);
  const session = useMemo(
    () => createFeedSession({ engine: engine as "claude", fmt: "claude", showSvc: false, lineFilter: "" }),
    [deputy.askId, engine],
  );
  const ownLines = useMemo(() => withoutDeliveredAsk(records.lines), [records.lines]);
  const feed = useMemo(
    () => (ownLines.length ? session.feed(ownLines, 0, live) : EMPTY_FEED),
    [session, ownLines, live],
  );
  const claimsKey = `deputy:${deputy.askId}`;
  const claims = useCanonicalAssistantClaims(claimsKey);
  useEffect(() => {
    publishCanonicalAssistantClaims(claimsKey, feed.items);
  }, [claimsKey, feed.items]);
  const runtime = useRuntimeSessionForConversation(deputy.deputyConversationId, deputy.artifactPath)?.session ?? null;
  const liveItems = useMemo(
    () => (live ? visibleRuntimeLiveTurnItems(runtime?.liveTurn ?? null, feed.items, claims, runtime?.turn ?? null) : []),
    [live, runtime?.liveTurn, runtime?.turn, feed.items, claims],
  );

  const started = clock(deputy.startedAt);
  const stateWord = live
    ? t(deputy.state === "pending" ? "deputy.starting" : "deputy.working")
    : t(OUTCOME_KEYS[deputy.outcome ?? "done"]);
  const links = touchedLinks(deputy.touched);
  const line = deputy.result?.line || (live ? "" : t("deputy.noAnswer"));
  const toggleLabel = open ? t("deputy.collapse") : t("deputy.expand");
  const toggle = () => setManual(!open);
  const blockKey = `deputy:${deputy.askId}`;

  return (
    <section
      data-deputy-block={deputy.askId}
      data-deputy-state={deputy.state}
      data-deputy-open={open ? "true" : "false"}
      data-deputy-conversation={deputy.deputyConversationId ?? undefined}
      aria-label={t("deputy.participant")}
      className="relative my-2"
      onPointerEnter={() => setInside(true)}
      onPointerLeave={() => setInside(false)}
      onFocus={() => setInside(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInside(false);
      }}
    >
      {/* Head: the person really said it, so it is the one part not drawn in
          outline. Its meta line says where it went — to the parallel self,
          not to the seat — and a team install stamps the sender the route
          recorded in front of that. */}
      <div data-feed-key={`${blockKey}:head`} data-feed-kind="user" data-deputy-head>
        <div data-deputy-addressee className="-mb-2 flex min-h-5 items-center justify-end gap-1.5 text-label text-muted">
          {deputy.ask.sender ? (
            <span data-deputy-sender className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-accent" style={deputy.ask.sender.color ? { background: deputy.ask.sender.color } : undefined} aria-hidden />
              <span className="font-semibold text-secondary">{deputy.ask.sender.name}</span>
            </span>
          ) : null}
          <span aria-hidden>→</span>
          <DeputyMark engine={engine} />
          <span className="font-semibold text-secondary">{t("deputy.addressee")}</span>
        </div>
        <FeedMessageRow entry={null} canonical={{ text: deputy.ask.text }} />
      </div>

      {open ? (
        <DeputyCaption
          engine={engine}
          phone={phone}
          started={started}
          stateWord={stateWord}
          live={live}
          warn={warn}
          open={open}
          toggleLabel={toggleLabel}
          onToggle={toggle}
        />
      ) : (
        <div
          data-deputy-collapsed
          data-feed-key={`${blockKey}:line`}
          className={`relative flex min-w-0 items-start gap-2 text-label ${phone ? "min-h-11 py-1.5" : "min-h-7 py-1"}${settle}`}
        >
          {/* The whole line is the target: the button spans it, the chips sit
              above it and stay their own links. */}
          <button
            type="button"
            data-deputy-toggle
            aria-expanded={false}
            aria-label={toggleLabel}
            onClick={toggle}
            className="absolute inset-0 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <span className={`pointer-events-none flex shrink-0 items-center ${phone ? "" : "w-6.5 justify-center"}`}><DeputyMark engine={engine} /></span>
          <span className="pointer-events-none flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span data-deputy-short className="shrink-0 font-semibold text-secondary">{t("deputy.short")}</span>
            {started ? <span className="shrink-0 tabular-nums text-muted">{started}</span> : null}
            <span data-deputy-outcome={deputy.outcome ?? "done"} className={`inline-flex shrink-0 items-center gap-1 font-semibold ${warn ? "text-warning" : "text-success"}`}>
              {warn ? <CircleAlert className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
              {warn ? t(OUTCOME_KEYS[deputy.outcome!]) : null}
            </span>
            {/* The result keeps its own width on the desktop so the chips follow
                its last word; on the phone it takes its own two lines under the
                caption and the chips the line after, so the outcome is read
                whole. An ended-early run's line is the last thing it said, so
                it is marked as the last step, never as work in progress. */}
            <span
              data-deputy-result
              className={`min-w-0 ${phone ? "basis-full line-clamp-2" : "truncate"} ${warn ? "text-warning" : "text-secondary"}`}
              title={deputy.result?.line || undefined}
            >
              {warn && deputy.result?.line ? <span data-deputy-last-step className="text-muted">{`${t("deputy.lastStep")} `}</span> : null}
              {line}
            </span>
            {links.map((link) => (
              <span key={`${link.kind}:${link.id}`} className="pointer-events-auto relative z-10" data-deputy-chip={link.kind}>
                <LiveMcpLinkChip link={link} availability={availability} />
              </span>
            ))}
          </span>
          <span className={`pointer-events-none flex shrink-0 items-center justify-center text-muted ${phone ? "-mt-1.5 h-8 w-8" : "h-5 w-5"}`} aria-hidden>
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </div>
      )}

      {open ? (
        <div data-deputy-body className={`relative${phone ? " pl-3" : ""}${settle}`}>
          {/* The dashed edge spans the block's body, from the caption to its
              last row: in the avatar column on the desktop, at the gutter on
              the phone. */}
          <span
            data-deputy-edge
            aria-hidden
            className={`pointer-events-none absolute bottom-1 top-0 border-l-[1.5px] border-dashed border-strong ${phone ? "left-0" : "left-[12.25px]"}`}
          />
          <DeputyInkContext.Provider value>
            {records.missing ? (
              <div data-deputy-missing className={`${phone ? "" : "ml-9 "}py-1 text-caption text-muted`}>{t("deputy.transcriptRemoved")}</div>
            ) : null}
            {feed.items.map(({ key, anchorKey, item }) => (
              <div key={key} data-feed-key={`${blockKey}:${anchorKey ?? key}`} data-feed-kind={item.kind} data-deputy-row>
                <GalleryOwnerProvider value={item}>
                  <FeedItem item={item} />
                </GalleryOwnerProvider>
              </div>
            ))}
            {liveItems.length ? <LiveTurnRows items={liveItems} /> : null}
          </DeputyInkContext.Provider>
        </div>
      ) : null}
    </section>
  );
}

function DeputyCaption({ engine, phone, started, stateWord, live, warn, open, toggleLabel, onToggle }: {
  engine: string;
  phone: boolean;
  started: string;
  stateWord: string;
  live: boolean;
  warn: boolean;
  open: boolean;
  toggleLabel: string;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  return (
    <div data-deputy-caption className={`flex min-w-0 items-center gap-2 text-label text-muted ${phone ? "min-h-11" : "min-h-7"}`}>
      <span className={`flex shrink-0 items-center ${phone ? "" : "w-6.5 justify-center"}`}><DeputyMark engine={engine} /></span>
      <span data-deputy-title className="min-w-[7.5rem] shrink truncate font-semibold text-secondary">{t("deputy.participant")}</span>
      {started ? <span className="shrink-0 tabular-nums">{started}</span> : null}
      <span data-deputy-status className={`inline-flex shrink-0 items-center gap-1 font-semibold ${live ? "text-success" : warn ? "text-warning" : "text-secondary"}`}>
        {live ? <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden /> : null}
        {stateWord}
      </span>
      <button
        type="button"
        data-deputy-toggle
        aria-expanded={open}
        aria-label={toggleLabel}
        onClick={onToggle}
        className={`ml-auto inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "h-11 w-11" : "h-7 w-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"}`}
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * The seat's own participant line, over a seat row the window has to name
 * (docs/design/ghost-seat.md §6.1): the first seat row after a drawn block,
 * «Orchestrator · continuing «Go through the review…»», so the seat's answer is
 * never read as the answer to the ask above it; and the seat's live turn while
 * a parallel self streams beside it, «Orchestrator». The seat's own ink, in
 * the text column its rows already use.
 */
export function SeatSpeakerLine({ resumes }: { resumes?: { ask: string | null } }) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const ask = resumes?.ask ? quoteHead(resumes.ask) : null;
  return (
    <div
      data-seat-speaker={resumes ? "resumes" : "live"}
      className={`${phone ? "pt-2" : "-mb-2 ml-9 mt-3"} flex min-h-5 min-w-0 items-center gap-1.5 text-label text-muted`}
      title={resumes?.ask ?? undefined}
    >
      <span className="shrink-0 font-semibold text-secondary">{t("roleCopy.orchestrator.name")}</span>
      {ask ? <span className="min-w-0 truncate">{`· ${t("deputy.resumes", { ask })}`}</span> : null}
    </div>
  );
}
