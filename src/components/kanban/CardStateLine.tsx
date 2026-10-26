"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { browserZone, clockText } from "@/components/activity/format";
import { TooltipBubble, type BubblePosition } from "@/components/TooltipBubble";
import { humanizeDuration } from "@/components/turnDuration";
import { fmtAgeSeconds } from "@/components/utils";
import { useLocale } from "@/lib/i18n";
import type { TaskPriority } from "@/lib/tasks/types";

import { cardStatePopover, cardStateText, type CardState } from "./cardState";
import { progressLine, TaskProgressBar, type CardProgress } from "./TaskProgressBar";

/*
 * The closed card's one state line (docs/design/calm-task-cards-build.md
 * §5.3): a status dot in the owner's tone, one sentence saying who has the
 * card and what stopped, and its age. Where the card's motion says it best
 * (working, a hold, a pause), the motion line is the sentence. The dot opens a
 * one-line popover, the owner and how long, by hover, focus or tap.
 */

/** The card holding the dot: a bubble with a second line stays inside it rather than reach over the card above. */
const withinCard = (dot: Element | null) => dot?.closest(".card")?.getBoundingClientRect() ?? null;

/* Beside the state line (docs/design/card-progress-estimate/prototype/README.md,
   «Where the desktop popover opens»): the bubble's top level with the line, 4px
   above it, 12px after the words of every row it spans, its right edge and
   bottom 4px inside its card, so on a narrow column its words wrap there. Where
   the row under the state line holds words beside it, it rises a pixel at a
   time while it still spans the state line, into the band between the title
   and that row; set beside, it takes the compact padding that lets two lines
   fit that band. Where nothing fits it opens above or below the dot as before. */
const POP_INSET = 4;
const POP_AFTER_WORDS = 12;
const POP_MIN_WIDTH = 120;
const POP_MAX_WIDTH = 320;
const POP_WINDOW_EDGE = 8;

/** What the bubble must not cover in its card: every line of words, every icon and the bar. */
function cardInk(card: Element): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  for (const element of card.querySelectorAll("svg, img, .task-progress, .card-state-dot")) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  return rects;
}

export function besideStateLine(dot: Element, bubble: HTMLElement): BubblePosition | null {
  const card = dot.closest(".card");
  const line = dot.closest(".card-state");
  if (!card || !line) return null;
  const box = card.getBoundingClientRect();
  const lineBox = line.getBoundingClientRect();
  const ink = cardInk(card);
  const floor = Math.max(box.top + POP_INSET, POP_WINDOW_EDGE);
  const ceiling = Math.min(box.bottom - POP_INSET, window.innerHeight - POP_WINDOW_EDGE);
  const rightEdge = Math.min(box.right - POP_INSET, window.innerWidth - POP_WINDOW_EDGE);
  const inkRight = (top: number, bottom: number) => ink.reduce((right, rect) => rect.top < bottom && rect.bottom > top ? Math.max(right, rect.right) : right, lineBox.left);
  bubble.dataset.beside = "";
  let maxWidth = POP_MAX_WIDTH;
  const sized = (width: number) => { maxWidth = width; bubble.style.maxWidth = `${width}px`; return bubble.getBoundingClientRect(); };
  for (let top = Math.floor(lineBox.top - POP_INSET); top >= floor; top -= 1) {
    /* Width, then height, then the rows spanned settle within a few rounds. */
    let size = sized(POP_MAX_WIDTH);
    let left = 0;
    for (let round = 0; round < 4; round += 1) {
      left = Math.ceil(inkRight(top, top + size.height) + POP_AFTER_WORDS);
      size = sized(Math.max(POP_MIN_WIDTH, Math.min(POP_MAX_WIDTH, Math.floor(rightEdge - left))));
    }
    if (top + size.height <= ceiling && left + size.width <= rightEdge + 0.5 && inkRight(top, top + size.height) + POP_AFTER_WORDS <= left + 0.5) return { left, top, maxWidth };
    /* Rising further would leave the state line. */
    if (top - 1 + size.height < lineBox.bottom) break;
  }
  delete bubble.dataset.beside;
  bubble.style.maxWidth = "";
  return null;
}

/** The dot and its popover. On the phone's card face, which is one button, it is passive. */
export function CardStateDot({ state, nowMs, title, interactive, estimate }: { state: CardState; nowMs: number; title: string; interactive: boolean; estimate?: CardProgress }) {
  const { t } = useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false);
  const [open, setOpen] = useState(false);
  const placeBeside = useCallback((bubble: HTMLElement) => ref.current ? besideStateLine(ref.current, bubble) : null, []);
  const within = useCallback(() => withinCard(ref.current), []);
  const age = state.sinceMs === null ? "" : humanizeDuration(Math.max(0, (nowMs - state.sinceMs) / 1000));
  const words = cardStatePopover(t, state, age).replace(/\s+$/, "");
  /* The bar beside the dot prints no number: its value, age and author are the popover's second line. */
  const estimateWords = estimate ? progressLine(t, estimate.progress, nowMs) : null;
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
      data-progress={estimate ? "" : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${t("cardState.dotAria", { title })}: ${words}${estimateWords ? `. ${estimateWords}` : ""}`}
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
        <TooltipBubble anchorRef={ref} side="top" align="left" className="card-state-pop" within={estimate ? within : undefined} place={placeBeside}>
          <span data-card-state-pop={state.owner}>{words}</span>
          {estimateWords ? <span className="card-state-pop-estimate" data-card-progress-line="">{estimateWords}</span> : null}
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

export function CardStateLine({ state, nowMs, title, motion, priority, spend, onToggle, expanded, phone = false, progress }: {
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
  /** The agent's estimate for the task, drawn as a short bar beside the dot; absent when nobody reported one. */
  progress?: CardProgress;
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
      <CardStateDot state={state} nowMs={nowMs} title={title} interactive={!phone} estimate={progress} />
      {progress ? <TaskProgressBar info={progress} title={title} nowMs={nowMs} /> : null}
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
