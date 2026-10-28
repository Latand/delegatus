"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { browserZone, clockText } from "@/components/activity/format";
import { TooltipBubble } from "@/components/TooltipBubble";
import { humanizeDuration } from "@/components/turnDuration";
import { fmtAgeSeconds } from "@/components/utils";
import { useLocale } from "@/lib/i18n";
import type { TaskPriority } from "@/lib/tasks/types";

import { cardStatePopover, cardStateText, type CardState } from "./cardState";

/*
 * The closed card's one state line (docs/design/calm-task-cards-build.md
 * §5.3): a status dot in the owner's tone, one sentence saying who has the
 * card and what stopped, and its age. Where the card's motion says it best
 * (working, a hold, a pause), the motion line is the sentence. The dot opens a
 * one-line popover, the owner and how long, by hover, focus or tap.
 */

/** The dot and its popover. On the phone's card face, which is one button, it is passive. */
export function CardStateDot({ state, nowMs, title, interactive }: { state: CardState; nowMs: number; title: string; interactive: boolean }) {
  const { t } = useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false);
  const [open, setOpen] = useState(false);
  const age = state.sinceMs === null ? "" : humanizeDuration(Math.max(0, (nowMs - state.sinceMs) / 1000));
  const words = cardStatePopover(t, state, age).replace(/\s+$/, "");
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  if (!interactive) return <span className="card-state-dot" data-owner={state.owner} aria-hidden />;
  return (
    <span
      ref={ref}
      className="card-state-dot"
      data-owner={state.owner}
      data-card-state-dot=""
      role="button"
      tabIndex={0}
      aria-label={`${t("cardState.dotAria", { title })}: ${words}`}
      aria-expanded={open}
      /* A mouse opens it by hovering; a tap focuses and clicks it, so only the click toggles it. */
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setOpen(false); }}
      onPointerDown={() => { pressed.current = true; }}
      onFocus={() => { if (!pressed.current) setOpen(true); }}
      onBlur={() => { pressed.current = false; setOpen(false); }}
      onClick={(event) => { event.stopPropagation(); pressed.current = false; setOpen((value) => !value); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }
      }}
    >
      {open ? (
        <TooltipBubble anchorRef={ref} side="top" align="left" className="card-state-pop">
          <span data-card-state-pop={state.owner}>{words}</span>
        </TooltipBubble>
      ) : null}
    </span>
  );
}

/** High and low only, a status mark with no action: normal draws nothing, and the ⋯ menu is where priority changes. */
export function PriorityMark({ priority }: { priority: TaskPriority }) {
  const { t } = useLocale();
  if (priority === "normal") return null;
  return (
    <span className="prio-mark" role="img" data-priority={priority} aria-label={t(`kanban.priorityMark.${priority}`)} title={t(`kanban.priorityMark.${priority}`)}>
      {priority === "high" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
    </span>
  );
}

export function CardStateLine({ state, nowMs, title, motion, priority, spend, onToggle, expanded, phone = false }: {
  state: CardState;
  nowMs: number;
  /** The card's title, for the dot's and the toggle's labels. */
  title: string;
  /** The card's motion line, drawn when the state has no sentence of its own. */
  motion: ReactNode;
  priority?: TaskPriority;
  /** The task's limit spend marks (TaskSpendMarks), at the line's end before the priority mark. */
  spend?: ReactNode;
  /** Desktop: the line opens and closes the card. */
  onToggle?: () => void;
  expanded?: boolean;
  /** The phone's card face is one button: nothing in it is a control. */
  phone?: boolean;
}) {
  const { t, locale } = useLocale();
  const clock = (ms: number) => clockText(ms, locale, browserZone());
  const text = cardStateText(t, state, clock);
  const timed = state.subject.kind === "lane" && state.subject.lane.retryAtMs !== null;
  const age = text && !timed && state.sinceMs !== null ? fmtAgeSeconds(Math.max(0, (nowMs - state.sinceMs) / 1000)) : "";
  const prio = priority ? <PriorityMark priority={priority} /> : null;
  const sentence = text ? (
    <span className="card-state-words" data-card-state-text="">
      {text}
      {age ? <span className="card-state-age"> · {age}</span> : null}
    </span>
  ) : <span className="card-state-words motion" data-card-state-text="">{motion}</span>;
  return (
    <div className={`card-state${phone ? " phone" : ""}`} data-card-state={state.owner} data-card-state-subject={state.subject.kind}>
      <CardStateDot state={state} nowMs={nowMs} title={title} interactive={!phone} />
      {onToggle && !phone ? (
        <button
          type="button"
          className="card-state-toggle"
          data-card-state-toggle=""
          aria-expanded={Boolean(expanded)}
          title={t(expanded ? "kanban.collapseCardShort" : "kanban.expandCardShort")}
          onClick={onToggle}
        >
          {sentence}
        </button>
      ) : sentence}
      {spend}
      {prio}
    </div>
  );
}
