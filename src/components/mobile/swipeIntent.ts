/*
 * What a finger on a board row means (#1671), decided in one pure place so
 * `MobileSwipeRow` only wires events to it.
 *
 * The row sits on `touch-action: pan-y`, so the browser keeps vertical
 * scrolling and answers a vertical pan with `pointercancel`; the row never has
 * to guess at a scroll. What is left to decide here:
 *
 *   - the lock: a gesture is nothing until it has moved 8 px, and it is a row
 *     swipe only if it moved further across than down;
 *   - where the card sits under the finger: never right of rest, and past the
 *     tray at a quarter of the finger's travel, so the edge is felt;
 *   - the release: open once half the tray shows, or on a leftward flick; a
 *     rightward flick closes;
 *   - one open row at a time, across the whole tab.
 *
 * A revealed button still has to be tapped. There is no swipe-all-the-way-to-
 * act, which is what keeps a casual gesture from acting.
 */

/** Movement under this many pixels is still a tap, or a long-press. */
export const SWIPE_LOCK_PX = 8;
/** Share of the tray that must show for a release to leave it open. */
export const SWIPE_OPEN_SHARE = 0.5;
/** Release speed, in px/ms, that decides on its own which way the tray goes. */
export const SWIPE_FLICK_PX_PER_MS = 0.3;
/** One tray button's width. */
export const SWIPE_ACTION_WIDTH = 72;
/** A press held this long without moving opens the row's actions sheet. */
export const LONG_PRESS_MS = 450;
/** Only the last stretch of a drag says how fast it was released. */
const VELOCITY_WINDOW_MS = 100;
/** Samples closer together than this cannot measure a speed. */
const VELOCITY_MIN_SPAN_MS = 16;

export type SwipeLock = "x" | "y" | null;

/** Which way a gesture goes once it has moved far enough to say; null before. */
export function swipeLock(dx: number, dy: number): SwipeLock {
  const across = Math.abs(dx);
  const down = Math.abs(dy);
  if (across < SWIPE_LOCK_PX && down < SWIPE_LOCK_PX) return null;
  return across > down ? "x" : "y";
}

/** The card's offset (negative is left) for a finger `dx` from where the drag
    began, `base` being where the card sat then: 0 closed, `-width` open. */
export function swipeOffset(base: number, dx: number, width: number): number {
  const raw = base + dx;
  if (raw >= 0) return 0;
  if (raw >= -width) return raw;
  return -(width + (-raw - width) / 4);
}

/** Whether a release at `offset`, moving at `velocity` px/ms, leaves the tray open. */
export function swipeReleaseOpen(offset: number, velocity: number, width: number): boolean {
  if (velocity <= -SWIPE_FLICK_PX_PER_MS) return true;
  if (velocity >= SWIPE_FLICK_PX_PER_MS) return false;
  return -offset >= width * SWIPE_OPEN_SHARE;
}

export interface SwipeSample {
  x: number;
  t: number;
}

/** Keeps the samples a release speed is read from. */
export function trackSwipe(samples: readonly SwipeSample[], sample: SwipeSample): SwipeSample[] {
  return [...samples, sample].filter((item) => sample.t - item.t <= VELOCITY_WINDOW_MS);
}

/** Horizontal speed over the kept samples, in px/ms; 0 when they span too
    little time to say. */
export function swipeVelocity(samples: readonly SwipeSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = last.t - first.t;
  return span < VELOCITY_MIN_SPAN_MS ? 0 : (last.x - first.x) / span;
}

/** Which row's tray is open; opening one closes whichever was. */
export interface SwipeOpenStore {
  getState(): string | null;
  subscribe(listener: () => void): () => void;
  open(id: string): void;
  /** Closes `id` if it is the open row, or whichever row is open when omitted. */
  close(id?: string): void;
}

export function createSwipeOpenStore(): SwipeOpenStore {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  const set = (next: string | null): void => {
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    getState: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (id) => set(id),
    close(id) {
      if (id === undefined || id === current) set(null);
    },
  };
}

/** The tab's one open row. */
export const swipeRows: SwipeOpenStore = createSwipeOpenStore();
