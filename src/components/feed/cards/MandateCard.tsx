"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { DelegatusMark } from "../../brand/BrandMark";
import { ChevronRight, RotateCw } from "../../icons";
import { hhmm } from "../../utils";
import { mandateSectionOpen, mandateSectionText, setMandateSectionOpen, type MandateSection } from "../../conversation/heldMandate";
import { MESSAGE_ACTION } from "../actionStyles";
import { CopyButton } from "../CopyButton";
import { mandateMessage } from "../mandateMessage";
import { mdBlocks, mdImages } from "../markdown";
import { tr, type MandateItem } from "../parse";

/** Conversation-scoped delivery identity, shared by the held card and its
 * transcript replacement. Later deliveries have their own row identity. */
export const MandateConversationContext = createContext<string | null>(null);

/**
 * The orchestrator seat's mandate, as the feed's own card (#1166).
 *
 * The operator never typed these 8 KB — the seat delivered them — so the row
 * says what it is (which mandate, how long, when it arrived) and keeps the text
 * folded away. A rotation handoff is a SECOND section of the same card, because
 * it is a second thing the seat said at creation, not a second message.
 *
 * Both sections mount their body only once opened: the point of the card is
 * that a conversation no longer pays 8 KB of markdown to show its first row.
 *
 * The qualifier is whatever the delivery evidence PROVED this mandate to be —
 * an approved default's version, the operator's own `custom` text, or nothing
 * at all when neither is provable. It travels with the delivery, so the dock
 * and the board's conversation pane name the same mandate the same way.
 */
export function MandateCard({ item }: { item: MandateItem }) {
  const identity = useContext(MandateConversationContext);
  const message = mandateMessage(item.text);
  const title = tr("mandateCard.title");
  const qualifier = item.mandate.kind === "version"
    ? tr("mandateCard.version", { version: item.mandate.version })
    : item.mandate.kind === "custom"
      ? tr("mandateCard.custom")
      : null;
  return (
    <div className="@container my-3 ml-9 overflow-hidden rounded-surface border border-border bg-card shadow-1" data-mandate-card>
      {/* One line where the card is wide enough for it; where it is not (the
          phone, the dock), the title keeps its row with the copy control and
          the time, and the meta takes the line under the title. Before, the
          row wrapped wherever it ran out: on a phone the meta began its own
          line with a dangling «·», and the copy control and time took a third
          line of their own, a 44 px tap target with nothing beside it. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3.5 pt-2" data-mandate-card-head>
        {/* The mandate is written by Delegatus itself, so it carries the product's mark. */}
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-sunken">
          <DelegatusMark size={20} />
        </span>
        <span className="min-w-0 text-[13px] font-semibold">{qualifier ? `${title} ${qualifier}` : title}</span>
        <span className="order-last basis-full pl-8.5 text-[11px] text-muted @lg:order-none @lg:basis-auto @lg:pl-0" data-mandate-card-meta>
          <span className="hidden @lg:inline" aria-hidden>· </span>
          {tr("mandateCard.lines", { count: message.lines })} · {tr("mandateCard.sent")}
        </span>
        {/* The coarse pointer's 44 px tap target reaches into the padding
            around the row instead of making the row 44 px tall. */}
        <span className="ml-auto flex shrink-0 items-center gap-1 [@media(pointer:coarse)]:-my-2">
          <CopyButton text={item.text} label={tr("feed.copyMd")} className={MESSAGE_ACTION} />
          {hhmm(item.ts) ? <span className="text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}
        </span>
      </div>
      <div className="px-3.5 pb-2.5 pt-1">
        <Section key={`${identity}\0mandate`} section="mandate" label={tr("mandateCard.readMandate")} text={message.mandate} />
        {message.handoff ? (
          <Section
            key={`${identity}\0handoff`}
            section="handoff"
            label={tr("mandateCard.handoff")}
            text={message.handoff}
            first={mdImages(message.mandate).length}
            icon={<RotateCw className="h-3 w-3 shrink-0 text-muted" aria-hidden />}
            className="mt-1.5 border-t border-border pt-1.5"
          />
        ) : null}
      </div>
    </div>
  );
}

function Section({
  section,
  label,
  text,
  first = 0,
  icon,
  className = "",
}: {
  section: MandateSection;
  label: string;
  text: string;
  /** The pictures the card drew before this section's. */
  first?: number;
  icon?: ReactNode;
  className?: string;
}) {
  const conversationKey = useContext(MandateConversationContext);
  const [open, setOpen] = useState(() => mandateSectionOpen(conversationKey, section));
  const [mounted, setMounted] = useState(open);
  const [displayedText, setDisplayedText] = useState(() => mandateSectionText(conversationKey, section) ?? text);
  return (
    <details
      open={open}
      className={`group/section text-[13px] ${className}`}
      onToggle={(event) => {
        const nowOpen = event.currentTarget.open;
        setOpen(nowOpen);
        // The server may have completed the provisional text while it was open.
        // Refresh on the next expansion; a hand-over preserves what was opened.
        const shownText = nowOpen && !open ? text : displayedText;
        if (nowOpen && !open) setDisplayedText(text);
        setMandateSectionOpen(conversationKey, section, nowOpen, shownText);
        if (nowOpen) setMounted(true);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-control py-0.5 text-[12.5px] font-semibold text-secondary hover:text-accent [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open/section:rotate-90" aria-hidden />
        {icon}
        <span>{label}</span>
      </summary>
      {mounted ? (
        <div className="mt-1 whitespace-pre-wrap break-words border-t border-border pt-1.5">{mdBlocks(displayedText, first)}</div>
      ) : null}
    </details>
  );
}
