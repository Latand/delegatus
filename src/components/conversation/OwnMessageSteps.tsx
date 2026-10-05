"use client";

/*
 * Stepping between the operator's own messages (docs/design/own-message-steps.md):
 * a row of its own between the feed and the composer, with "Previous mine", a
 * count and "Next mine". The row costs feed height and nothing else.
 *
 * The feed owns the reading. It marks the rows it renders as the operator's
 * bubble (`data-own-message`), says when a scroll is the reader's and reveals
 * older history; this file turns that into a position, a landing and a row.
 */

import { ChevronDown, ChevronUp } from "@/components/icons";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { useLocale } from "@/lib/i18n";

import { STEP_PAD_DESKTOP_PX, STEP_PAD_PHONE_PX, stepCountLabel, stepScrollTop, stepState, stepTarget, type StepReading, type StepState } from "./ownMessageStepModel";

const OWN_ROW = "[data-own-message]";
/** Rows off screen are laid out at an estimated height, so a landing is held
    this long while the rows around it take their real one. */
const LAND_HOLD_MS = 500;
/** How long a step back keeps asking for older history before it gives up. */
const OLDER_WAIT_MS = 15_000;
const RELEASING_INPUTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

export interface OwnStepsFeed {
  scroller: RefObject<HTMLDivElement | null>;
  /** The slot the pane keeps for the row. Null: this feed offers no steps. */
  mount: HTMLElement | null;
  /** The conversation being read; what is held for one is never shown for another. */
  identity: string | null;
  phone: boolean;
  /** Older history exists that the feed has not revealed. */
  olderUnloaded: boolean;
  /** A row's sender is still being read, so it may yet become an own message
      (a delivered Claude record before the ledger answers). */
  sendersPending: boolean;
  /** Changes whenever the rows on screen may have. */
  revision: unknown;
  /** The scroll that follows is the reader's, in this direction. */
  markReaderScroll: (direction: -1 | 1) => void;
  revealOlder: () => void;
}

export interface OwnSteps {
  /** The row has something to offer: two own messages or more. */
  shown: boolean;
  state: StepState;
  step: (direction: -1 | 1) => void;
}

const EMPTY: StepState = { position: 0, total: 0, olderUnloaded: false, canPrev: false, canNext: false };
const sameState = (a: StepState, b: StepState) => (Object.keys(a) as (keyof StepState)[]).every((key) => a[key] === b[key]);

function readFeed(scroller: HTMLElement, phone: boolean, olderUnloaded: boolean): { rows: HTMLElement[]; reading: StepReading } {
  const box = scroller.getBoundingClientRect();
  /* A pane on the zoomed board is drawn smaller than it is laid out. */
  const scale = scroller.offsetHeight ? box.height / scroller.offsetHeight || 1 : 1;
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>(OWN_ROW));
  return {
    rows,
    reading: {
      tops: rows.map((row) => (row.getBoundingClientRect().top - box.top) / scale + scroller.scrollTop),
      scrollTop: scroller.scrollTop,
      viewport: scroller.clientHeight,
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
      olderUnloaded,
      pad: phone ? STEP_PAD_PHONE_PX : STEP_PAD_DESKTOP_PX,
    },
  };
}

/* Alt+↑ / Alt+↓. The composer keeps the bare arrows for its own history and
   nothing else takes Alt with an arrow. Several conversations can be on screen
   at once, so the keys go to the one the operator is in: the pane that holds
   the focus, or the only one there is. */
interface KeyTarget { root: () => HTMLElement | null; step: (direction: -1 | 1) => void }
const keyTargets = new Set<KeyTarget>();
const onScreen = (root: HTMLElement | null): root is HTMLElement =>
  Boolean(root?.isConnected && root.getClientRects().length && !root.closest("[hidden], [inert]"));
function onStepKey(event: KeyboardEvent): void {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const visible = [...keyTargets].filter((target) => onScreen(target.root()));
  const focused = document.activeElement;
  const target = visible.find((candidate) => candidate.root()!.contains(focused)) ?? (visible.length === 1 ? visible[0] : undefined);
  if (!target) return;
  event.preventDefault();
  target.step(event.key === "ArrowUp" ? -1 : 1);
}
function registerKeyTarget(target: KeyTarget): () => void {
  if (!keyTargets.size) window.addEventListener("keydown", onStepKey);
  keyTargets.add(target);
  return () => {
    keyTargets.delete(target);
    if (!keyTargets.size) window.removeEventListener("keydown", onStepKey);
  };
}

export function useOwnMessageSteps(feed: OwnStepsFeed): OwnSteps {
  const live = useRef(feed);
  useEffect(() => { live.current = feed; });
  const enabled = feed.mount !== null;
  const [state, setState] = useState<StepState>(EMPTY);
  /* What the row shows. While a sender is still being read the count is not
     known, so the last one that was stays up and never passes through a wrong
     number; a conversation with none yet waits for the answer. */
  const [held, setHeld] = useState<{ identity: string | null; state: StepState } | null>(null);
  const frame = useRef(0);
  const landing = useRef(0);
  const olderWait = useRef<number | null>(null);

  const publish = useCallback(() => {
    frame.current = 0;
    const now = live.current;
    const scroller = now.scroller.current;
    const next = scroller && now.mount ? stepState(readFeed(scroller, now.phone, now.olderUnloaded).reading) : EMPTY;
    setState((previous) => sameState(previous, next) ? previous : next);
    if (now.sendersPending) return;
    setHeld((previous) => previous && previous.identity === now.identity && sameState(previous.state, next) ? previous : { identity: now.identity, state: next });
  }, []);
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(publish);
  }, [publish]);

  /* Puts `row` on the reading line and keeps it there while the rows around
     it settle, letting go the moment the reader scrolls. */
  const land = useCallback((row: HTMLElement) => {
    const token = landing.current += 1;
    const until = performance.now() + LAND_HOLD_MS;
    const place = (): boolean => {
      const now = live.current;
      const scroller = now.scroller.current;
      if (!scroller || landing.current !== token) return false;
      const { rows, reading } = readFeed(scroller, now.phone, now.olderUnloaded);
      const index = rows.indexOf(row);
      if (index === -1) return false;
      /* Scroll offsets are whole pixels. On the phone the row has to start at
         the feed's top edge or just under it (#1978), never a fraction above. */
      const exact = stepScrollTop(reading, index);
      const wanted = now.phone ? Math.floor(exact) : Math.round(exact);
      if (Math.abs(wanted - scroller.scrollTop) >= 1) {
        now.markReaderScroll(wanted > scroller.scrollTop ? 1 : -1);
        scroller.scrollTop = wanted;
      }
      /* A message that cannot reach the line ends at the tail, and the tail
         is the feed's own to hold. */
      return exact < reading.maxScroll;
    };
    if (!place()) return;
    const hold = () => {
      if (performance.now() < until && place()) requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
  }, []);

  const step = useCallback((direction: -1 | 1) => {
    const now = live.current;
    const scroller = now.scroller.current;
    if (!scroller || !now.mount) return;
    const { rows, reading } = readFeed(scroller, now.phone, now.olderUnloaded);
    const target = stepTarget(reading, direction);
    olderWait.current = null;
    if (target !== null) land(rows[target]!);
    else if (direction < 0 && reading.olderUnloaded) {
      /* The message before this one is in history the feed has not revealed:
         ask for it, and finish the step when it is on the page. */
      olderWait.current = performance.now() + OLDER_WAIT_MS;
      now.revealOlder();
    }
  }, [land]);

  useEffect(() => {
    const scroller = live.current.scroller.current;
    if (!enabled || !scroller) return;
    const release = (event: Event) => {
      if (!event.isTrusted) return;
      landing.current += 1;
      olderWait.current = null;
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(scroller);
    scroller.addEventListener("scroll", schedule, { passive: true });
    for (const type of RELEASING_INPUTS) scroller.addEventListener(type, release, { passive: true });
    schedule();
    return () => {
      resize.disconnect();
      scroller.removeEventListener("scroll", schedule);
      for (const type of RELEASING_INPUTS) scroller.removeEventListener(type, release);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      landing.current += 1;
      olderWait.current = null;
    };
  }, [enabled, schedule]);

  /* The rows changed: read again, and carry on a step back that was waiting
     for older history. A page can hold no own message at all, so the walk
     keeps asking until one appears or nothing older is left. */
  useEffect(() => {
    if (!enabled) return;
    schedule();
    const now = live.current;
    const scroller = now.scroller.current;
    if (olderWait.current === null || !scroller) return;
    if (performance.now() > olderWait.current) { olderWait.current = null; return; }
    const { rows, reading } = readFeed(scroller, now.phone, now.olderUnloaded);
    const target = stepTarget(reading, -1);
    if (target !== null) {
      olderWait.current = null;
      land(rows[target]!);
    } else if (reading.olderUnloaded) now.revealOlder();
    else olderWait.current = null;
  }, [enabled, feed.revision, feed.olderUnloaded, feed.sendersPending, feed.identity, feed.phone, schedule, land]);

  const shownState = held && held.identity === feed.identity ? held.state : EMPTY;
  const shown = enabled && shownState.total >= 2;
  const mount = feed.mount;
  useEffect(() => {
    if (!shown || !mount) return;
    return registerKeyTarget({ root: () => mount.parentElement, step });
  }, [shown, mount, step]);

  return {
    shown,
    /* The count is the held one; which way there is to go is always live. */
    state: { ...shownState, canPrev: state.canPrev, canNext: state.canNext },
    step,
  };
}

const STEP_BUTTON = "inline-flex h-full min-w-11 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[8px] px-2 text-label font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:opacity-40";

function StepButton({ direction, state, onStep }: { direction: -1 | 1; state: StepState; onStep: (direction: -1 | 1) => void }) {
  const { t } = useLocale();
  const Icon = direction < 0 ? ChevronUp : ChevronDown;
  const label = t(direction < 0 ? "feed.ownPrevious" : "feed.ownNext");
  return (
    <button
      type="button"
      data-own-step-control={direction < 0 ? "previous" : "next"}
      aria-label={label}
      title={`${label} · ${direction < 0 ? "Alt+↑" : "Alt+↓"}`}
      disabled={direction < 0 ? !state.canPrev : !state.canNext}
      className={STEP_BUTTON}
      onClick={() => onStep(direction)}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {t(direction < 0 ? "feed.ownPreviousShort" : "feed.ownNextShort")}
    </button>
  );
}

/**
 * The row itself: 36 px and its top border on the desktop, 44 px and its
 * border on the phone. `wayBack` is the feed's "to latest" control while the
 * phone needs both, so the two share this one row; its cell is
 * kept on the phone at the tail too, and the step buttons never move.
 */
export function OwnMessageStepRow({ steps, phone, wayBack }: { steps: OwnSteps; phone: boolean; wayBack?: ReactNode }) {
  const { t } = useLocale();
  const { state } = steps;
  return (
    <div
      data-own-steps
      className={`box-content flex shrink-0 items-center border-t border-border ${phone ? "h-11 px-1" : "h-9 justify-center px-2"}`}
    >
      {phone ? <span aria-hidden className="h-11 w-11 shrink-0" /> : null}
      <div className={`flex h-full items-center justify-center gap-1 ${phone ? "min-w-0 flex-1" : ""}`}>
        <StepButton direction={-1} state={state} onStep={steps.step} />
        <span
          data-own-step-control="count"
          aria-label={t(state.olderUnloaded ? "feed.ownCountOlder" : "feed.ownCount", { position: state.position, total: state.total })}
          title="Alt+↑ / Alt+↓"
          className={`shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted ${phone ? "px-1" : "px-2"}`}
        >
          {stepCountLabel(state)}
        </span>
        <StepButton direction={1} state={state} onStep={steps.step} />
      </div>
      {phone ? <span className="flex h-11 w-11 shrink-0 items-center justify-center">{wayBack}</span> : null}
    </div>
  );
}
