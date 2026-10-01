import type { TaskStatus } from "@/lib/tasks/types";

/*
 * Hold to lift, drag to a column: the phone's card drag (operator, 2026-10-02).
 *
 * A finger held on a task card for `CARD_LIFT_MS` without moving lifts it: the
 * card is copied into a ghost that follows the finger, the original dims, and a
 * dock with the four columns appears at the bottom of the screen. The release
 * decides:
 *
 *   over a column other than its own   the task moves there (the usual receipt);
 *   within `LIFT_SLOP_PX` of the lift  today's menu opens, as a hold always did;
 *   anywhere else                      nothing happens, the card is back.
 *
 * Before the lift the board owns the finger: a vertical pan is the column
 * scrolling and a horizontal one is the pager, so a finger that moves
 * `SWIPE_LOCK_PX` before the hold is up is no hold at all (`usePress`).
 *
 * After it, this module owns the finger. The browser would start scrolling on
 * the first move, so a lifted finger's `touchmove` is cancelled, and the guard
 * that does it is armed at the press, not at the lift: a listener added to a
 * touch already under way is not one the browser waits for.
 *
 * The move path is the desktop's (`kanban/cardDrag.ts`): the ghost moves by
 * `translate3d`, once a frame, with the card's and the dock's rectangles read
 * once at the lift, and the dock's highlight is a data attribute written
 * only when the tile under the finger changes. Nothing is rendered by React per
 * move; the dock itself is one small component fed by `liftStore`, so the lift
 * does not render the board.
 */

export const CARD_LIFT_MS = 350;
/** A release this close to where the lift happened is "in place". */
export const LIFT_SLOP_PX = 8;

export interface Lift { from: TaskStatus }

let current: Lift | null = null;
const listeners = new Set<() => void>();
export const liftStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  get(): Lift | null { return current; },
};
function publish(next: Lift | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** Whether a finger is lifted: `touchmove` is cancelled while it is. */
let lifted = false;

/** Cancels the browser's scroll under a lifted finger. Armed when the press
    starts and disarmed when it ends. */
export function armTouchGuard(element: HTMLElement): () => void {
  const guard = (event: Event) => { if (lifted && event.cancelable) event.preventDefault(); };
  element.addEventListener("touchmove", guard, { passive: false });
  return () => element.removeEventListener("touchmove", guard);
}

export interface CardLiftOptions {
  /** The pressed card, as it sits in the column. */
  element: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  status: TaskStatus;
  /** Released over another column. */
  onDrop: (to: TaskStatus) => void;
  /** Released where it was lifted. */
  onMenu: () => void;
  /** The lift is over, however it ended. */
  onEnd: () => void;
}

interface Tile { status: TaskStatus; element: HTMLElement; left: number; top: number; right: number; bottom: number }

export function beginCardLift(options: CardLiftOptions): void {
  const { element, pointerId, status } = options;
  const rect = element.getBoundingClientRect();
  const ghost = element.cloneNode(true) as HTMLElement;
  ghost.setAttribute("data-phone-lift-ghost", "");
  ghost.setAttribute("aria-hidden", "true");
  ghost.removeAttribute("data-phone-card-frame");
  Object.assign(ghost.style, {
    position: "fixed", left: "0", top: "0", margin: "0", width: `${rect.width}px`, zIndex: "80", pointerEvents: "none",
    boxShadow: "var(--shadow-2)", opacity: "0.96", borderRadius: "12px", willChange: "transform",
    transform: `translate3d(${rect.left}px, ${rect.top}px, 0) scale(1.02)`,
  });
  const dimmed = element.style.opacity;
  element.style.opacity = "0.35";
  element.setAttribute("data-lifted", "");
  document.body.appendChild(ghost);
  lifted = true;
  let tiles: Tile[] | null = null;
  let over: Tile | null = null;
  let pointerX = options.x;
  let pointerY = options.y;
  let frame: number | null = null;
  let done = false;

  const measure = () => {
    tiles = [...document.querySelectorAll<HTMLElement>("[data-phone-dock-tile]")].map((tile) => {
      const box = tile.getBoundingClientRect();
      return { status: tile.getAttribute("data-phone-dock-tile") as TaskStatus, element: tile, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    });
  };
  const apply = () => {
    frame = null;
    ghost.style.transform = `translate3d(${rect.left + pointerX - options.x}px, ${rect.top + pointerY - options.y}px, 0) scale(1.02)`;
    if (!tiles || !tiles.length) measure();
    const tile = tiles!.find((box) => pointerX >= box.left && pointerX < box.right && pointerY >= box.top && pointerY < box.bottom) ?? null;
    if (tile === over) return;
    over?.element.removeAttribute("data-over");
    over = tile && tile.status !== status ? tile : null;
    over?.element.setAttribute("data-over", "");
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(apply); };

  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    schedule();
  };
  const finish = (release: boolean, event?: PointerEvent) => {
    if (done) return;
    done = true;
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancelled, true);
    if (frame !== null) cancelAnimationFrame(frame);
    const target = over;
    const inPlace = event ? Math.hypot(event.clientX - options.x, event.clientY - options.y) < LIFT_SLOP_PX : false;
    lifted = false;
    ghost.remove();
    document.body.removeAttribute("data-card-drag");
    element.removeAttribute("data-lifted");
    element.style.opacity = dimmed;
    target?.element.removeAttribute("data-over");
    publish(null);
    options.onEnd();
    if (!release) return;
    if (target) options.onDrop(target.status);
    else if (inPlace) options.onMenu();
  };
  const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(true, event); };
  const cancelled = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancelled, true);
  publish({ from: status });
  /* The dock is measured in the first frame after it is drawn, and the board's
     animations are paused in the next: one frame's work is the ghost and the
     dock, and the restyle of every live glyph is the next frame's, so neither
     frame is the long task the two would be together. */
  schedule();
  requestAnimationFrame(() => { if (!done) document.body.setAttribute("data-card-drag", ""); });
}
