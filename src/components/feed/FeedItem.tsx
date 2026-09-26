"use client";

import { TriangleAlert } from "lucide-react";
import { memo, type CSSProperties } from "react";
import { DelegatusMark } from "@/components/brand/BrandMark";
import { useLocale, type TFunction } from "@/lib/i18n";

import { useIsMobile } from "@/hooks/useIsMobile";
import type { MandateDelivery } from "@/lib/runtime/messageOrigin";

import { EngineMark } from "@/components/EngineMark";
import { Brain, ChevronUp, Check, Mail, Mic, X } from "../icons";
import { hhmm } from "../utils";
import { MESSAGE_ACTION } from "./actionStyles";
import { SelectedContextBadge } from "../SelectedContextBadge";
import { CopyButton } from "./CopyButton";
import { InboxImageCard } from "./InboxImage";
import { md, mdBlocks, mdImages } from "./markdown";
import { BUBBLE_MEASURE, READING_MEASURE } from "./measure";
import { UserMessageRow } from "./UserMessageRow";
import { useMessageProvenance, type ProvenanceLookup } from "./messageProvenance";
import { tr, type Item } from "./parse";
import { BlobCard } from "./cards/BlobCard";
import { CmdGroupCard } from "./cards/CmdGroupCard";
import { CompactBand } from "./cards/CompactBand";
import { ImageCard } from "./cards/ImageCard";
import { MandateCard } from "./cards/MandateCard";
import { MemCitationCard } from "./cards/MemCitationCard";
import { ProtocolMessageBody, parseProtocolPayload } from "./cards/ProtocolMessage";
import { ReviewCard } from "./cards/ReviewCard";
import { RecordCard } from "./cards/RecordCard";
import { SysMsgCard } from "./cards/SysMsgCard";
import { ToolCard, mobileClock } from "./cards/ToolCard";
import { WakeupCard } from "./cards/WakeupCard";
import { SpeakButton } from "./SpeakButton";
import { McpCallCard } from "../runtime/McpCallCard";
import { DeputyMark, useDeputyInk } from "../conversation/deputyInk";
import { quoteHead } from "../conversation/deputyPlacement";

/**
 * Resolves a row with delivery evidence (#1117). A delivered Claude system row
 * joins the ledger by engine message id — operator evidence becomes the
 * operator's own bubble, agent evidence the internal card naming the sender
 * role — and otherwise the occurrence join (pre-#1117 structured relays). A
 * plain user bubble (a legacy tmux paste on either engine) becomes the
 * internal card only when a settled agent delivery is joined to THIS row —
 * same text, nearest its settlement time — so an operator's own message that
 * repeats a relay's words stays the operator's. No evidence — no provider,
 * unknown id, scaffold row, the operator's own words — keeps the row untouched.
 *
 * One more class of evidence rides here (#1166): the SAME occurrence record can
 * say that its delivery was an orchestrator seat's mandate, and then the row is
 * the seat's own card. Because the fact belongs to the delivery rather than to
 * the text, an agent relay that repeats the mandate's bytes carries no such
 * record and stays the relay it is, and an operator who pastes them by hand
 * keeps their own bubble.
 *
 * The image viewer reads each row through this too, so it steps through the
 * pictures of the row as drawn (#2144).
 */
export function resolveDeliveredItem(item: Item, provenance: ProvenanceLookup): Item {
  if (item.structuredUserRef && (item.kind === "user" || item.kind === "tmsg")) {
    const resolved = provenance.forItem(item);
    if (resolved?.origin === "agent") return internalCard(item.ts, item.text, resolved);
    if (item.kind === "user" && resolved?.selectedContext) return { ...item, selectedContext: resolved.selectedContext };
    return item;
  }
  if (item.kind === "user") {
    /* A selected-context capture exists only on operator composer sends. */
    if (item.selectedContext) return item;
    const resolved = provenance.forItem(item);
    if (resolved?.mandate) return mandateCard(item.ts, item.text, resolved.mandate);
    if (resolved?.origin === "agent") return internalCard(item.ts, item.text, resolved);
    return item;
  }
  if (item.kind !== "sysmsg" || !item.deliveredMessage) return item;
  const resolved = provenance.forItem(item);
  if (resolved?.mandate) return mandateCard(item.deliveredMessage.ts, item.text, resolved.mandate);
  if (resolved?.origin === "agent") return internalCard(item.deliveredMessage.ts, item.text, resolved);
  if (resolved?.origin === "operator") {
    return {
      kind: "user",
      ts: item.deliveredMessage.ts,
      text: item.text,
      ...(resolved.selectedContext ? { selectedContext: resolved.selectedContext } : {}),
    };
  }
  return item;
}

function mandateCard(ts: unknown, text: string, mandate: MandateDelivery): Item {
  return { kind: "mandate", ts, text, mandate };
}

function internalCard(ts: unknown, text: string, sender: { senderRole?: string; senderProject?: string; senderConversationId?: string }): Item {
  return {
    kind: "tmsg",
    ts,
    dir: "in",
    peer: sender.senderRole ?? tr("render.agentPeer"),
    summary: "",
    text,
    internal: true,
    ...(sender.senderProject ? { senderProject: sender.senderProject } : {}),
    ...(sender.senderConversationId ? { senderConversationId: sender.senderConversationId } : {}),
  };
}

function agentRoleLabel(role: string, t: TFunction): string {
  switch (role.toLowerCase()) {
    case "orchestrator": return t("render.senderRoleOrchestrator");
    case "reviewer": return t("render.senderRoleReviewer");
    case "builder": return t("render.senderRoleBuilder");
    case "gateway": return t("render.senderRoleGateway");
    case "api-client": return t("render.senderRoleApiClient");
    case "controller":
    case "pipeline":
    case "flow":
    case "seat-tick": return "Delegatus";
    default: return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

/* Mobile v2 (#1439, lane 4): the engine mark is the only avatar left on the
   phone — a 16 px glyph in secondary colour beside the engine's name in the
   message header (README §5). Proper nouns, so no locale entry. */
export const ENGINE_LABEL: Record<"codex" | "claude" | "openclaw" | "copilot", string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  openclaw: "OpenClaw",
};

/* Memoized: feed items are immutable after buildFeed, so a pane re-render
   (poll tick, camera state, files refresh) skips re-parsing markdown for
   every message that did not change. The provenance lookup arrives by context,
   so a resolved map re-renders exactly the memoized consumers. */
export const FeedItem = memo(function FeedItem({ item: sourceItem, speakText, resumesAsk }: {
  item: Item;
  speakText?: string;
  /** Phone only: this seat row is the first after a parallel self's block, so
      its header also says which seat head it continues (null: the head has no
      text to quote). Absent: an ordinary row. */
  resumesAsk?: string | null;
}) {
  const { t } = useLocale();
  const provenance = useMessageProvenance();
  const isMobile = useIsMobile();
  /* Inside a deputy's block (docs/design/ghost-seat.md §6.2) the prose row is
     the seat's parallel self: outline mark, secondary ink. */
  const deputyInk = useDeputyInk();
  const item = resolveDeliveredItem(sourceItem, provenance);
  /* Mobile v2 (#1439, lane 4): no avatar column on the phone, so nothing lines
     up with one — the `ml-9` chrome indent goes with it. */
  const indent = isMobile ? "" : "ml-9 ";
  if (item.kind === "image") {
    const { kind: _kind, ...source } = item;
    return <ImageCard {...source} />;
  }
  if (item.kind === "inbox-image") return <InboxImageCard name={item.name} path={item.path} />;
  if (item.kind === "blob") return <BlobCard bytes={item.bytes} text={item.text} />;
  if (item.kind === "sysmsg") return <SysMsgCard label={item.label} text={item.text} />;
  if (item.kind === "mandate") return <MandateCard item={item} />;
  if (item.kind === "compact") return <CompactBand item={item} />;
  if (item.kind === "review") return <ReviewCard item={item} />;
  if (item.kind === "record") return <RecordCard item={item} />;
  if (item.kind === "mem-citation") return <MemCitationCard item={item} />;
  if (item.kind === "prose") {
    const cls = item.engine === "codex" ? "bg-codex" : item.engine === "openclaw" ? "bg-openclaw" : "bg-claude";
    const AvatarIcon = ({ className }: { className?: string }) => <EngineMark engine={item.engine} size={16} tone="inherit" className={className} />;
    /* Inside the filled circle the mark takes the fill ink, not white — white
       on the dark theme's engine tints is 2.6:1 (#1743) — and its cut-outs
       take the circle's own colour, so they stay holes. */
    const fillStyle = { "--engine-mark-cut": `var(--color-${item.engine === "codex" ? "codex" : item.engine === "openclaw" ? "openclaw" : "claude"})` } as CSSProperties;
    if (isMobile) {
      /* Mobile v2 (#1439, lane 4; README §2.6, §4.2): content gets the width.
         No avatar column. The message reads content first (#2148): a one-line caption
         (engine glyph, engine name, time), the prose at 15 px, and then the
         read-aloud and copy targets in one quiet row where the text ends.
         The targets keep 44 px; the row's negative margins give 12 px of that
         back to the gaps around it, where there is nothing else to hit.
         The read-aloud anchor (`data-tts-message`) wraps the whole message, so
         the control finds its text with `closest()` as on the desktop. */
      const time = mobileClock(item.ts);
      return (
        <div className="group/msg pt-2" data-mobile-message="agent" data-tts-message={`${item.engine}:${item.ts}`}>
          <div
            data-mobile-message-header
            data-seat-speaker={resumesAsk !== undefined ? "resumes" : undefined}
            className="mb-1 flex h-5 w-full min-w-0 items-center gap-1.5 text-label text-muted"
            title={resumesAsk ?? undefined}
          >
            {deputyInk ? <DeputyMark engine={item.engine} /> : <AvatarIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden />}
            {/* Inside a deputy's block the row is the parallel self's, and says so:
                the bare engine name is what the seat's own rows carry. */}
            <span data-mobile-message-speaker className="shrink-0 font-semibold text-secondary">{deputyInk ? t("deputy.participant") : ENGINE_LABEL[item.engine]}</span>
            {time ? <span className="shrink-0 tabular-nums">· {time}</span> : null}
            {/* The seat's one name on the phone stays this header, so the head
                it continues after a block joins it here (ghost-seat.md §6.1). */}
            {resumesAsk ? <span data-seat-continues className="min-w-0 truncate">{`· ${t("deputy.resumes", { ask: quoteHead(resumesAsk) })}`}</span> : null}
          </div>
          <div className={`w-full whitespace-pre-wrap break-words text-title leading-[1.45]${deputyInk ? " text-secondary" : ""}`}>
            <div className="contents" data-tts-body>{mdBlocks(item.text)}</div>
          </div>
          <div data-mobile-message-actions className="-mx-3 -my-1.5 flex h-11 items-center">
            {speakText ? <SpeakButton text={speakText} /> : null}
            <CopyButton text={item.text} label={tr("feed.copyMd")} className={MESSAGE_ACTION} />
          </div>
        </div>
      );
    }
    return (
      <div className="group/msg my-3 flex gap-2.5">
        {deputyInk ? <DeputyMark engine={item.engine} size={26} className="mt-1" /> : (
          <div className={`mt-1 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-[color:var(--engine-fill-ink)] ${cls}`} style={fillStyle}>
            <AvatarIcon className="h-3.5 w-3.5" aria-hidden />
          </div>
        )}
        {/* `data-tts-message` / `data-tts-body`: the anchors the read-aloud
            control uses to find the RENDERED text of this answer, so the
            karaoke highlight and click-to-seek of #1022 ride over the markdown
            already on screen instead of re-parsing it. The value is the answer's
            identity — the engine/timestamp pair `speakableAnswer` groups on —
            so a control on the first block of a multi-block answer can claim
            the rest of it and stop at the next answer. The body wrapper is
            `display: contents`, so it changes no layout.

            The answer is set at the reading measure (#2148), and its header
            row sits inside it, so the time and the controls end where the text
            ends. Tool calls and diffs are items of their own and keep the full
            width. */}
        <div className={`min-w-0 flex-1 ${READING_MEASURE} whitespace-pre-wrap break-words${deputyInk ? " text-secondary" : ""}`} data-tts-message={`${item.engine}:${item.ts}`}>
          {/* Issue #698: this cluster used to be `absolute right-0 top-0` over a
              body with no reserved gutter — on a coarse pointer the 44px buttons
              sat permanently at 60% opacity on the first lines of the message,
              and on desktop the same controls were invisible until hover. They
              now hold their own row above the text: they cover nothing at any
              width, and they are visible without a hover. */}
          <div className="mb-0.5 flex min-h-6 items-center gap-1">
            {hhmm(item.ts) ? <span className="text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              {speakText ? <SpeakButton text={speakText} /> : null}
              <CopyButton text={item.text} label={tr("feed.copyMd")} className={MESSAGE_ACTION} />
            </span>
          </div>
          <div className="contents" data-tts-body>{mdBlocks(item.text)}</div>
        </div>
      </div>
    );
  }
  /* A voice turn is the operator speaking, so it keeps the user side of the
     feed — but labelled and with the call's interleaved transcript folded away,
     because that tail repeats itself turn over turn and is only ever read when
     something sounded wrong. */
  if (item.kind === "voice") {
    /* Its copy control sits where the typed bubble's does: beside it on the
       desktop, under it at the trailing edge on the phone. */
    const copy = <CopyButton text={item.input || item.delta} label={tr("feed.copyMd")} className={MESSAGE_ACTION} />;
    return (
      <div className="group/msg my-3 flex flex-col items-end">
        <div className="flex w-full items-start justify-end gap-1.5">
          {isMobile ? null : <span className="mt-2 flex shrink-0">{copy}</span>}
          <div className={isMobile ? "max-w-[86%] rounded-surface bg-user px-3 py-[9px] text-title leading-[1.45]" : `${BUBBLE_MEASURE} rounded-surface bg-user px-4 py-2.5`}>
            <span className="mb-1 flex items-center gap-1 text-caption uppercase tracking-wide text-muted">
              <Mic className="h-3 w-3" aria-hidden />
              {tr("feed.voiceTurn")}
            </span>
            {item.input ? (
              <p className="whitespace-pre-wrap break-words">{item.input}</p>
            ) : null}
            {item.delta ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer list-none text-caption text-muted [&::-webkit-details-marker]:hidden">
                  {tr("feed.voiceContext")}
                </summary>
                <pre className="mt-1 whitespace-pre-wrap break-words text-label text-secondary">{item.delta}</pre>
              </details>
            ) : null}
          </div>
        </div>
        {isMobile ? <div data-mobile-message-actions className="-mr-3 -my-1.5 flex h-11 items-center">{copy}</div> : null}
      </div>
    );
  }
  if (item.kind === "user") {
    /* One renderer for the operator's own message, shared with the outbox row
       it replaces (send-latency slice 3): the message keeps one width, one
       opacity, one type size and one set of controls from the moment it is
       submitted to the moment the transcript carries it. */
    return <UserMessageRow text={item.text} selectedContext={item.selectedContext ?? null} sender={provenance.senderFor(sourceItem)} />;
  }
  if (item.kind === "tool" && item.mcp) return <McpCallCard event={item} />;
  if (item.kind === "tool" && item.wakeup) return <WakeupCard event={item} wakeup={item.wakeup} />;
  if (item.kind === "tool") return <ToolCard event={item} />;
  if (item.kind === "cmd-group") return <CmdGroupCard item={item} />;
  if (item.kind === "tmsg") {
    const protocol = parseProtocolPayload(item.text);
    const long = item.text.length > 420 || item.text.split("\n").length > 6;
    /* The row draws the summary's pictures before the text's. */
    const first = mdImages(item.summary).length;
    return (
      <div className={`my-3 ${indent}overflow-hidden rounded-surface border border-accent/25 bg-accent-soft shadow-1`}>
        <div className="flex items-center gap-2 px-3.5 pt-2">
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            {/* Internal traffic is relayed by Delegatus itself, so it carries the
                product's mark; a peer's own team message keeps the envelope. */}
            {item.internal ? <DelegatusMark size={20} /> : <Mail className="h-3.5 w-3.5" aria-hidden />}
          </span>
          {/* #1117: an MCP/structured relay says outright that it is internal
              traffic, and the peer pill names the sender ROLE, so the operator
              never mistakes it for their own words or for scaffold. */}
          {item.internal ? (
            <span className="rounded-full border border-accent/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
              {tr("render.internalTag")}
            </span>
          ) : null}
          {item.internal ? (
            <span className="min-w-0 text-[11px] font-semibold text-accent" data-agent-author data-agent-role={item.peer}>
              {t("render.agentLabel")}{item.peer === "agent" || item.peer === t("render.agentPeer") ? null : ` · ${agentRoleLabel(item.peer, t)}`}
              {item.senderProject ? <span className="inline-block max-w-full truncate whitespace-nowrap align-bottom" data-agent-project title={item.senderProject}>{` · ${item.senderProject}`}</span> : null}
              {item.senderConversationId ? <a className="ml-1 underline underline-offset-2" href={`#c=${encodeURIComponent(item.senderConversationId)}`} aria-label={tr("render.openSenderConversation")}>↗</a> : null}
            </span>
          ) : <><span className="text-[11px] font-semibold text-muted">{item.dir === "out" ? tr("render.toDir") : tr("render.fromDir")}</span>
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">{item.peer}</span></>}
          {item.delivery ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${item.delivery === "ok" ? "text-success" : "text-danger"}`}
              title={item.msgId ? `msg_id: ${item.msgId}` : undefined}
            >
              {item.delivery === "ok" ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
              {item.delivery === "ok" ? tr("render.delivered") : tr("render.notDelivered")}
            </span>
          ) : null}
          {hhmm(item.ts) ? <span className="ml-auto shrink-0 text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}
        </div>
        <div className="px-3.5 pb-2.5 pt-1">
          {protocol ? (
            <ProtocolMessageBody payload={protocol} />
          ) : (
            <>
              {item.summary ? <div className="text-[13px] font-bold">{md(item.summary)}</div> : null}
              {long ? (
                <details className="group/tmsg mt-0.5 whitespace-pre-wrap break-words text-[13px]">
                  <summary className="cursor-pointer list-none text-[12.5px] text-secondary [&::-webkit-details-marker]:hidden">
                    <span className="group-open/tmsg:hidden">
                      {item.text.slice(0, 260).trimEnd()}… <span className="font-semibold text-accent">{tr("common.showAll")}</span>
                    </span>
                    <span className="hidden items-center gap-1 text-[11px] font-semibold text-muted group-open/tmsg:inline-flex">
                      {tr("common.collapse")} <ChevronUp className="h-3 w-3" aria-hidden />
                    </span>
                  </summary>
                  {mdBlocks(item.text, first)}
                </details>
              ) : (
                <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px]">{mdBlocks(item.text, first)}</div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "tnote") {
    return (
      <div className={`my-0.5 ${indent}flex items-center gap-1.5 text-label text-muted`}>
        <Mail className="h-3 w-3 shrink-0" aria-hidden />
        {item.text}
      </div>
    );
  }
  if (item.kind === "think") {
    const available = item.availability === "available" || Boolean(item.text.trim());
    // Keep source identities for delayed live reasoning and prepend anchors;
    // an empty provider record has no visible row of its own.
    if (!available) return <span hidden data-empty-reasoning aria-hidden>
      {item.members?.map(member => <span key={member.sourceId} data-feed-key={member.anchorKey} data-feed-source-id={member.sourceId} />)}
    </span>;
    const count = item.members?.length ?? 1;
    return (
      <details className={`group relative my-0.5 ${indent}text-label text-muted`} data-reasoning-availability={available ? "available" : "unavailable"}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5" aria-label={`${t("render.reasoningGroup", { count })} · ${t(available ? "render.reasoningAvailable" : "render.reasoningUnavailable")}`}>
          {/* All source positions resolve to the compact header, including
              members prepended into a group whose first source changed. */}
          {item.members?.map((member) => (
            <span key={member.sourceId} data-feed-key={member.anchorKey} data-feed-source-id={member.sourceId} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-11" />
          ))}
          <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{t("render.reasoningGroup", { count })}</span>
          <span className="ml-auto text-[11px]">{t(available ? "render.reasoningAvailable" : "render.reasoningUnavailable")}</span>
          <ChevronUp className="h-3 w-3 shrink-0 rotate-180 group-open:rotate-0" aria-hidden />
        </summary>
        {available ? (
          <div className="whitespace-pre-wrap break-words pt-1 text-[13px] leading-relaxed text-secondary [overflow-wrap:anywhere]">{item.text}</div>
        ) : (
          <p className="break-words pb-1">{t("render.reasoningNotProvided")}</p>
        )}
      </details>
    );
  }

  if (item.kind === "turn-error") {
    /* The one row that must read as a failure with no assistant prose behind
       it (#1846 recurrence): a turn that ended unauthorized produced nothing
       else, so this row carries the whole story — what failed, what the
       provider said, and what the operator can do next. Same alert anatomy the
       question card uses, in the danger hue, and the phone drops the chrome
       indent like every other card. */
    /* Same clock the rest of the feed keeps: HH:MM on the phone, the full
       time on the desktop. */
    const clock = isMobile ? mobileClock(item.ts) : hhmm(item.ts);
    return (
      <div
        data-turn-error={item.reason}
        role="status"
        className={`my-3 ${indent}rounded-surface border border-danger/40 bg-danger-soft px-3 pb-2.5 pt-1`}
      >
        <div className="flex min-h-11 items-center gap-1.5 text-label font-bold text-danger">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{t(item.reason === "auth" ? "render.turnFailedAuth" : "render.turnFailed")}</span>
          {clock ? <span className="ml-auto shrink-0 font-normal tabular-nums">{clock}</span> : null}
        </div>
        {/* Every word here is the Viewer's own. A provider's error text is
            arbitrary prose that can quote whatever it rejected, so the row
            explains the failure rather than echoing it. */}
        <p className="break-words text-[13px] text-primary">
          {t(item.reason === "auth" ? "render.turnFailedAuthBody" : "render.turnFailedBody")}
        </p>
        {item.reason === "auth" ? (
          <p className="mt-1.5 break-words text-label text-secondary">{t("render.turnFailedAuthHint")}</p>
        ) : null}
        {(item.code || item.withheld) ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-label text-muted">
            {item.code ? (
              /* The recognized constant, never the record's bytes. */
              <code data-turn-error-code className="rounded-control bg-sunken px-1 py-0.5 font-mono text-[11px]">{item.code}</code>
            ) : null}
            {item.withheld ? <span className="min-w-0 break-words">{t("render.turnFailedWithheld")}</span> : null}
          </p>
        ) : null}
      </div>
    );
  }
  if (item.kind === "svc") return <div className="my-1 break-words text-[11.5px] text-muted">{item.text}</div>;
  if (item.kind === "note") return <div className="my-2 break-words text-[12.5px] text-muted">{md(item.text)}</div>;
  return <div className={`my-0.5 break-words text-[12.5px] ${item.err ? "text-danger" : "text-secondary"}`}>{item.text}</div>;
});
