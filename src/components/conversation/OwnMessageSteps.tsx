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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";

import { ownMessageRows } from "@/components/feed/scrollMemory";
import { useLocale } from "@/lib/i18n";

import { STEP_PAD_DESKTOP_PX, STEP_PAD_PHONE_PX, hasOlder, stepCountLabel, stepRowOffered, stepScrollTop, stepState, stepTarget, type StepReading, type StepState } from "./ownMessageStepModel";

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
  /** The feed is holding its tail. */
  atTail: boolean;
  /** Own messages in history that is loaded and not yet on the page. */
  olderOwn: number;
  /** Older history exists that the feed has not loaded. */
  olderUnloaded: boolean;
  /** The conversation is known to hold a message the operator wrote, on the
      page or not. One that has none (a pipeline stage's) never gets the row. */
  operatorWrote: boolean;
  /** A row's sender is still being read, so it may yet become an own message
      (a delivered Claude record before the ledger answers). */
  sendersPending: boolean;
  /** Changes whenever the rows on screen may have. */
  revision: unknown;
  /** The scroll that follows is the reader's, in this direction. */
  markReaderScroll: (direction: -1 | 1) => void;
  /** Resume the tail after an empty step that started there. */
  restoreTail: () => void;
  revealOlder: () => void;
}

export interface OwnSteps {
  /** The row has something to offer. */
  shown: boolean;
  step: (direction: -1 | 1) => void;
  /** Something else moved the feed (the way back to the tail, the reader):
      a landing being held and a step waiting for older history both end. */
  release: () => void;
  /** What the row shows. The row reads it itself, so a scroll redraws the row
      and never the feed. */
  subscribe: (listener: () => void) => () => void;
  read: () => StepState;
}

const EMPTY: StepState = { position: 0, total: 0, olderUnloaded: false, canPrev: false, canNext: false };
const sameState = (a: StepState, b: StepState) => (Object.keys(a) as (keyof StepState)[]).every((key) => a[key] === b[key]);

type FeedReading = Pick<OwnStepsFeed, "phone" | "atTail" | "olderOwn" | "olderUnloaded">;

function readFeed(scroller: HTMLElement, feed: FeedReading): { rows: readonly HTMLElement[]; reading: StepReading } {
  const box = scroller.getBoundingClientRect();
  /* A pane on the zoomed board is drawn smaller than it is laid out. */
  const scale = scroller.offsetHeight ? box.height / scroller.offsetHeight || 1 : 1;
  const rows = ownMessageRows(scroller);
  const scrollTop = scroller.scrollTop;
  return {
    rows,
    reading: {
      count: rows.length,
      top: (index) => (rows[index]!.getBoundingClientRect().top - box.top) / scale + scrollTop,
      scrollTop,
      viewport: scroller.clientHeight,
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
      atTail: feed.atTail,
      olderOwn: feed.olderOwn,
      olderUnloaded: feed.olderUnloaded,
      pad: feed.phone ? STEP_PAD_PHONE_PX : STEP_PAD_DESKTOP_PX,
    },
  };
}

/** One reading of the feed, as every scroll frame takes it: the cached own
    rows and a few bisections over them, whatever the conversation's length. */
export function readStepState(scroller: HTMLElement, feed: FeedReading): StepState {
  return stepState(readFeed(scroller, feed).reading);
}

/* Alt+↑ / Alt+↓. The composer keeps the bare arrows for its own history and
   nothing else takes Alt with an arrow. Several conversations can be on screen
   at once, so the keys go to the one the operator is in: the pane that holds
   the focus, or the only one there is while the focus is nowhere. A field, a
   list or a dialog outside the pane keeps its keys. */
interface KeyTarget { root: () => HTMLElement | null; step: (direction: -1 | 1) => void }
const keyTargets = new Set<KeyTarget>();
const onScreen = (root: HTMLElement | null): root is HTMLElement =>
  Boolean(root?.isConnected && root.getClientRects().length && !root.closest("[hidden], [inert]"));
export function isOwnMessageStepKey(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown");
}
function onStepKey(event: KeyboardEvent): void {
  if (!isOwnMessageStepKey(event) || event.defaultPrevented) return;
  const visible = [...keyTargets].filter((target) => onScreen(target.root()));
  const focused = document.activeElement;
  const nowhere = !focused || focused === document.body || focused === document.documentElement;
  const target = visible.find((candidate) => candidate.root()!.contains(focused)) ?? (nowhere && visible.length === 1 ? visible[0] : undefined);
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
  /* A scroll frame after this commit must use its sender verdict, even when
     React defers passive effects until after the browser has painted. */
  useLayoutEffect(() => { live.current = feed; });
  const enabled = feed.mount !== null;
  /* The count and the buttons change with every scroll, so they live outside
     React state and the row subscribes. Whether the row exists changes a few
     times in a conversation's life and is the only thing the feed redraws for. */
  const store = useRef<{ state: StepState; listeners: Set<() => void> }>({ state: EMPTY, listeners: new Set() });
  const [offered, setOffered] = useState<{ identity: string | null; offered: boolean } | null>(null);
  /* While a sender is still being read the total is not known, so the last
     one that was stays up, with the row's presence, and never passes through a
     wrong number; a conversation with none yet waits for the answer. Where the
     reader is stays live throughout. */
  const settled = useRef<{ identity: string | null; total: number; olderUnloaded: boolean; offered: boolean } | null>(null);
  const frame = useRef(0);
  const landing = useRef(0);
  const olderWait = useRef<{ identity: string | null; until: number; sendersSince: number | null; restoreTail: boolean } | null>(null);
  const olderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const subscribe = useCallback((listener: () => void) => {
    const { listeners } = store.current;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const read = useCallback(() => store.current.state, []);

  const publish = useCallback(() => {
    frame.current = 0;
    const now = live.current;
    const scroller = now.scroller.current;
    if (!scroller || !now.mount) return;
    let next = readStepState(scroller, now);
    if (!now.sendersPending) {
      settled.current = { identity: now.identity, total: next.total, olderUnloaded: next.olderUnloaded, offered: stepRowOffered(next, now.operatorWrote) };
    }
    const kept = settled.current?.identity === now.identity ? settled.current : null;
    if (kept) next = { ...next, total: kept.total, olderUnloaded: kept.olderUnloaded, position: Math.min(next.position, kept.total) };
    if (!sameState(store.current.state, next)) {
      store.current.state = next;
      for (const listener of [...store.current.listeners]) listener();
    }
    const show = kept?.offered ?? false;
    setOffered((previous) => previous && previous.identity === now.identity && previous.offered === show ? previous : { identity: now.identity, offered: show });
  }, []);
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(publish);
  }, [publish]);

  const release = useCallback(() => {
    landing.current += 1;
    olderWait.current = null;
    if (olderTimer.current !== null) clearTimeout(olderTimer.current);
    olderTimer.current = null;
  }, []);

  const finishEmptyStep = useCallback(() => {
    const wait = olderWait.current;
    const restore = wait?.identity === live.current.identity && wait?.restoreTail;
    release();
    if (restore) live.current.restoreTail();
    schedule();
  }, [release, schedule]);

  /* A failed read may never change the rows again. The deadline must end the
     wait without relying on another history revision to drive an effect. */
  const armOlderDeadline = useCallback(() => {
    if (olderTimer.current !== null) clearTimeout(olderTimer.current);
    olderTimer.current = null;
    const wait = olderWait.current;
    if (!wait || wait.sendersSince !== null) return;
    olderTimer.current = setTimeout(() => {
      olderTimer.current = null;
      if (olderWait.current !== wait) return;
      if (live.current.sendersPending) { wait.sendersSince ??= performance.now(); return; }
      finishEmptyStep();
    }, Math.max(0, wait.until - performance.now()));
  }, [finishEmptyStep]);

  /* Puts `row` on the reading line and keeps it there while the rows around
     it settle, letting go the moment anything else moves the feed. */
  const land = useCallback((row: HTMLElement) => {
    const token = landing.current += 1;
    const until = performance.now() + LAND_HOLD_MS;
    const place = (): boolean => {
      const now = live.current;
      const scroller = now.scroller.current;
      if (!scroller || landing.current !== token) return false;
      const { rows, reading } = readFeed(scroller, now);
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
      if (landing.current === token && exact >= reading.maxScroll && !now.atTail) now.restoreTail();
      return landing.current === token && exact < reading.maxScroll;
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
    const { rows, reading } = readFeed(scroller, now);
    const target = stepTarget(reading, direction);
    /* A disabled direction also does nothing through its shortcut. In
       particular it must leave an older-history wait free to finish. */
    if (target === null && (direction > 0 || !hasOlder(reading))) return;
    const restoreTail = now.atTail || (olderWait.current?.identity === now.identity && olderWait.current?.restoreTail === true);
    release();
    if (target !== null) land(rows[target]!);
    else if (direction < 0 && hasOlder(reading)) {
      /* The message before this one is in history the feed has not put on
         the page: ask for it, and finish the step when it is there. */
      now.markReaderScroll(-1);
      olderWait.current = { identity: now.identity, until: performance.now() + OLDER_WAIT_MS, sendersSince: null, restoreTail };
      armOlderDeadline();
      now.revealOlder();
    }
  }, [land, release, armOlderDeadline]);

  useEffect(() => {
    const scroller = live.current.scroller.current;
    if (!enabled || !scroller) return;
    const resize = new ResizeObserver(schedule);
    resize.observe(scroller);
    scroller.addEventListener("scroll", schedule, { passive: true });
    const releaseForInput = (event: Event) => {
      /* The pane's shortcut runs later on window. Preserve its pending walk
         until step() can retain ownership or leave a disabled direction alone. */
      if (event.type === "keydown") {
        const key = event as KeyboardEvent;
        if (isOwnMessageStepKey(key) || ["Alt", "Control", "Meta", "Shift"].includes(key.key)) return;
      }
      release();
    };
    for (const type of RELEASING_INPUTS) scroller.addEventListener(type, releaseForInput, { passive: true });
    schedule();
    return () => {
      resize.disconnect();
      scroller.removeEventListener("scroll", schedule);
      for (const type of RELEASING_INPUTS) scroller.removeEventListener(type, releaseForInput);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      release();
    };
  }, [enabled, schedule, release]);

  /* Another conversation in the same pane: nothing held or awaited for the
     one before it carries over. */
  useEffect(() => release, [feed.identity, release]);

  /* The rows changed: read again, and carry on a step back that was waiting
     for older history. A page can hold no own message at all, so the walk
     keeps asking until one appears or nothing older is left. The reader has
     not moved since the step (anything that moves the feed ends the wait), so
     the message sought is still the one before the reading line. */
  useEffect(() => {
    if (!enabled) return;
    schedule();
    const now = live.current;
    const scroller = now.scroller.current;
    if (olderWait.current === null || !scroller) return;
    /* A prepended Claude page may not have its operator bubbles until the
       ledger answers. Its bounded retries can outlast the history deadline,
       so that wait spends none of the time reserved for fetching pages. */
    const wait = olderWait.current;
    const time = performance.now();
    if (now.sendersPending) { wait.sendersSince ??= time; armOlderDeadline(); return; }
    if (wait.sendersSince !== null) {
      wait.until += time - wait.sendersSince;
      wait.sendersSince = null;
    }
    if (time >= wait.until) { finishEmptyStep(); return; }
    const { rows, reading } = readFeed(scroller, now);
    const target = stepTarget(reading, -1);
    if (target !== null) {
      release();
      land(rows[target]!);
    } else if (hasOlder(reading)) { armOlderDeadline(); now.revealOlder(); }
    else finishEmptyStep();
  }, [enabled, feed.revision, feed.atTail, feed.olderOwn, feed.olderUnloaded, feed.operatorWrote, feed.sendersPending, feed.identity, feed.phone, schedule, land, release, finishEmptyStep, armOlderDeadline]);

  const shown = enabled && offered !== null && offered.identity === feed.identity && offered.offered;
  const mount = feed.mount;
  useEffect(() => {
    if (!shown || !mount) return;
    return registerKeyTarget({ root: () => mount.parentElement, step });
  }, [shown, mount, step]);

  return { shown, step, release, subscribe, read };
}

const STEP_BUTTON = "inline-flex h-full min-w-11 items-center justify-center gap-1 rounded-[8px] text-label font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:opacity-40";

function StepButton({ direction, state, onStep, phone }: { direction: -1 | 1; state: StepState; onStep: (direction: -1 | 1) => void; phone: boolean }) {
  const { t } = useLocale();
  const Icon = direction < 0 ? ChevronUp : ChevronDown;
  const label = t(direction < 0 ? "feed.ownPrevious" : "feed.ownNext");
  const button = useRef<HTMLButtonElement | null>(null);
  const focused = useRef(false);
  const disabled = direction < 0 ? !state.canPrev : !state.canNext;
  /* Browsers drop a newly disabled button's focus onto body. Keep it in
     this pane so Alt+arrow still has an owner when several panes are open. */
  useLayoutEffect(() => {
    const element = button.current;
    if (disabled && focused.current && element && (document.activeElement === element || document.activeElement === document.body)) {
      element.closest<HTMLElement>("[data-own-steps]")?.focus({ preventScroll: true });
    }
  }, [disabled]);
  return (
    <button
      ref={button}
      type="button"
      data-own-step-control={direction < 0 ? "previous" : "next"}
      aria-label={label}
      title={`${label} · ${direction < 0 ? "Alt+↑" : "Alt+↓"}`}
      disabled={disabled}
      onFocus={() => { focused.current = true; }}
      onBlur={(event) => { if (!event.currentTarget.disabled || event.relatedTarget) focused.current = false; }}
      className={`${STEP_BUTTON} ${phone ? "flex-1 px-1" : "shrink-0 whitespace-nowrap px-2"}`}
      onClick={() => onStep(direction)}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className={phone ? "min-w-0 whitespace-normal break-words leading-3" : undefined}>
        {t(direction < 0 ? "feed.ownPreviousShort" : "feed.ownNextShort")}
      </span>
    </button>
  );
}

/**
 * The row itself: 36 px and its top border on the desktop, 44 px and its
 * border on the phone. `wayBack` is the feed's "to latest" control while the
 * phone needs both, so the two share this one row; its cell is
 * kept on the phone at the tail too, and the step buttons never move.
 * The row draws itself again on a scroll; the feed around it does not.
 */
export function OwnMessageStepRow({ steps, phone, wayBack }: { steps: OwnSteps; phone: boolean; wayBack?: ReactNode }) {
  const { t } = useLocale();
  const state = useSyncExternalStore(steps.subscribe, steps.read, steps.read);
  return (
    <div
      data-own-steps
      tabIndex={-1}
      className={`box-content flex shrink-0 items-center border-t border-border ${phone ? "h-11 px-1" : "h-9 justify-center px-2"}`}
    >
      {phone ? <span aria-hidden className="h-11 w-11 shrink-0" /> : null}
      <div className={`flex h-full items-center justify-center ${phone ? "min-w-0 flex-1 gap-0.5" : "gap-1"}`}>
        <StepButton direction={-1} state={state} onStep={steps.step} phone={phone} />
        <span
          data-own-step-control="count"
          aria-label={t(state.olderUnloaded ? "feed.ownCountOlder" : "feed.ownCount", { position: state.position, total: state.total })}
          title="Alt+↑ / Alt+↓"
          className={`shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted ${phone ? "px-0" : "px-2"}`}
        >
          {stepCountLabel(state)}
        </span>
        <StepButton direction={1} state={state} onStep={steps.step} phone={phone} />
      </div>
      {phone ? <span className="flex h-11 w-11 shrink-0 items-center justify-center">{wayBack}</span> : null}
    </div>
  );
}
