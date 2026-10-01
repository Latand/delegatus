import type { TaskStatus } from "@/lib/tasks/types";

/*
 * The desktop's card drag: the whole card is the handle, and the dragged card
 * follows the pointer at the display rate.
 *
 * The gesture has two phases. From the press until the pointer has moved
 * `DRAG_START_PX` it is a click in waiting: nothing is drawn, so a click without
 * movement does what it always did. Past it, the card is a drag, and the click
 * the release would leave behind is swallowed.
 *
 * Why today's drag was not smooth (measured in a recorded trace, see
 * `evidence/whole-card-drag/`): every `pointermove` wrote the ghost's `left` and
 * `top` (layout), read the source card's `getBoundingClientRect` (a forced
 * layout, right after the write), hid the ghost with `display: none` and called
 * `elementFromPoint` (a second forced layout and a style recalculation), and
 * showed it again. Three layouts per move on a 48-card board, so half the frames
 * were missed. The move path here does none of that:
 *
 *   - the ghost sits at `translate3d` on its own layer, one write per frame;
 *   - moves only record the pointer, and one `requestAnimationFrame` applies it;
 *   - the card's and the columns' rectangles are read once, when the drag
 *     starts (and again after a scroll), never in the move path;
 *   - the column under the pointer is found by comparing with those rectangles,
 *     so no hit test and no `display` toggle are needed;
 *   - while a card is held, the board takes no pointer events (CSS), so no
 *     hover restyles the cards the ghost passes over;
 *   - nothing is rendered by React: the hint is a node appended by hand.
 */

export const DRAG_START_PX = 8;

/** What a press on these may never start a drag from: text being edited, and the
    panes that exist to be read and selected. */
const NOT_A_HANDLE = "input, textarea, select, [contenteditable], .reader-slot, .stage-detail, [data-no-drag]";

/** Whether a press at `offsetX` on `target` may start a drag. The press on a
    scrollbar (the open Details text scrolls inside the card) is the scroller's. */
export function isCardHandle(event: { target: EventTarget | null; offsetX?: number }): boolean {
  const target = event.target as HTMLElement | null;
  if (!target?.closest) return true;
  if (target.closest(NOT_A_HANDLE)) return false;
  return !(target.scrollHeight > target.clientHeight && (event.offsetX ?? 0) >= target.clientWidth && target.clientWidth > 0);
}

export interface CardDragOptions {
  /** The card pressed. */
  element: HTMLElement;
  /** The board's root: the ghost and the hint live in it, and it carries `data-card-drag` while a card is held. */
  root: HTMLElement;
  status: TaskStatus;
  event: { clientX: number; clientY: number; pointerId: number };
  hint: string;
  /** The card was dropped over another column. */
  onDrop: (to: TaskStatus) => void;
  /** A drag began or ended: the board holds its own polling while it runs. */
  onActive: (active: boolean) => void;
}

interface ColumnRect { status: TaskStatus; element: HTMLElement; left: number; top: number; right: number; bottom: number }

export function startCardGesture(options: CardDragOptions): void {
  const { element, root, status } = options;
  const startX = options.event.clientX;
  const startY = options.event.clientY;
  const pointerId = options.event.pointerId;
  let started = false;
  let ghost: HTMLElement | null = null;
  let hint: HTMLElement | null = null;
  let origin = { left: 0, top: 0 };
  let columns: ColumnRect[] = [];
  let stale = false;
  let pointerX = startX;
  let pointerY = startY;
  let frame: number | null = null;
  let over: ColumnRect | null = null;

  /* A press is a click in waiting, and a hand that moves is not a text selection. */
  const noSelect = (event: Event) => { event.preventDefault(); };
  /* A link or an image would start the browser's own drag-and-drop, which takes the pointer away. */
  const noNativeDrag = (event: Event) => { event.preventDefault(); };
  document.addEventListener("selectstart", noSelect, true);
  element.addEventListener("dragstart", noNativeDrag, true);

  const measure = () => {
    stale = false;
    columns = [...root.querySelectorAll<HTMLElement>(".column[data-status]")].map((column) => {
      const rect = column.getBoundingClientRect();
      return { status: column.dataset.status as TaskStatus, element: column, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
  };
  const invalidate = () => { stale = true; schedule(); };

  const apply = () => {
    frame = null;
    if (!ghost) return;
    if (stale) measure();
    ghost.style.transform = `translate3d(${origin.left + pointerX - startX}px, ${origin.top + pointerY - startY}px, 0) rotate(1.5deg)`;
    const column = columns.find((rect) => pointerX >= rect.left && pointerX < rect.right && pointerY >= rect.top && pointerY < rect.bottom) ?? null;
    if (column === over) return;
    over?.element.classList.remove("drop");
    over = column;
    column?.element.classList.toggle("drop", column.status !== status);
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(apply); };

  const begin = () => {
    started = true;
    try { element.setPointerCapture(pointerId); } catch { /* capture is best-effort */ }
    window.getSelection()?.removeAllRanges();
    const rect = element.getBoundingClientRect();
    origin = { left: rect.left, top: rect.top };
    measure();
    ghost = element.cloneNode(true) as HTMLElement;
    ghost.querySelectorAll(".reader-slot").forEach((slot) => slot.replaceChildren());
    ghost.classList.add("ghost");
    ghost.classList.remove("dragging");
    ghost.style.setProperty("--w", `${element.offsetWidth}px`);
    ghost.style.transform = `translate3d(${origin.left}px, ${origin.top}px, 0) rotate(1.5deg)`;
    ghost.setAttribute("aria-hidden", "true");
    ghost.removeAttribute("data-id");
    hint = document.createElement("div");
    hint.className = "drag-hint";
    hint.textContent = options.hint;
    element.classList.add("dragging");
    root.setAttribute("data-card-drag", "");
    root.append(ghost, hint);
    window.addEventListener("scroll", invalidate, true);
    window.addEventListener("resize", invalidate);
    options.onActive(true);
    /* Another press's click is swallowed, the one this release leaves. */
    window.addEventListener("click", swallow, true);
  };

  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (!started) {
      if (Math.hypot(pointerX - startX, pointerY - startY) < DRAG_START_PX) return;
      begin();
    }
    schedule();
  };
  const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); };

  const finish = (cancel: boolean) => {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancelled, true);
    document.removeEventListener("keydown", escape, true);
    document.removeEventListener("selectstart", noSelect, true);
    element.removeEventListener("dragstart", noNativeDrag, true);
    if (frame !== null) cancelAnimationFrame(frame);
    if (!started) return;
    window.removeEventListener("scroll", invalidate, true);
    window.removeEventListener("resize", invalidate);
    /* The release's click comes right behind it, in the same task; one task later it is the operator's next. */
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    try { element.releasePointerCapture(pointerId); } catch { /* it may be gone already */ }
    element.classList.remove("dragging");
    root.removeAttribute("data-card-drag");
    ghost?.remove();
    hint?.remove();
    over?.element.classList.remove("drop");
    options.onActive(false);
    if (!cancel && over && over.status !== status) options.onDrop(over.status);
  };
  const up = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
  const cancelled = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(true); };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && started) {
      event.stopPropagation();
      finish(true);
    }
  };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancelled, true);
  document.addEventListener("keydown", escape, true);
}
