"use client";

/**
 * The arrival pulse (#1836 item 4).
 *
 * The operator's words: when `request_attention` moves the view, the thing it
 * landed on must glow and blink, so it is visible WHERE the view was taken —
 * temporarily. A board can hold a hundred cards and a camera that has just
 * glided somewhere says nothing about which of them was the point.
 *
 * It is a DOM decoration rather than component state on purpose. The landed
 * card belongs to whichever surface drew it — a kanban card, a scheme node, a
 * container heading, a task band — and every one of them already publishes a
 * selector for it through its own frame index (`pulseSelectorFor`). Marking
 * the element with an attribute here means the surfaces stay untouched, the
 * styling is one rule in the stylesheet, and the pulse plays identically on an
 * optimistic lane that the board only learned about a frame ago.
 *
 * It settles BY ITSELF: nothing has to be clicked, and nothing is left behind
 * if the element is replaced mid-pulse (a re-render swapping the node) — the
 * mark is removed from whatever still carries it when the timer fires, and
 * from every element the next pulse or a Return supersedes.
 */

/** How long the target stays marked. Long enough to find on a busy board,
    short enough that it is over before it becomes decoration. */
export const ARRIVAL_PULSE_MS = 4_000;

/** The marked state. `prefers-reduced-motion` turns the blink into a steady
    highlight for the same duration — a stylesheet decision, not a branch
    here, so both behave the same everywhere. */
export const ARRIVAL_PULSE_ATTRIBUTE = "data-attention-pulse";

/**
 * The two values the mark takes, and the reason it has two.
 *
 * A pulse must not move the thing it is pointing at. The stylesheet would like
 * the marked element to establish a stacking context so a neighbour's shadow
 * cannot cover the ring, and `position: relative` is how that is bought — but
 * the scheme's nodes and task bands are `position: absolute`, placed by
 * `left`/`top` and by transforms, and relative drops them into normal flow.
 * The element the camera just landed on would slide away under the ring.
 *
 * So the question is asked here, where the element is in hand: an element that
 * is already positioned is marked `on` and keeps every bit of its geometry; a
 * statically positioned one (a kanban card) is marked `lift`, for which
 * relative changes nothing and the paint order is worth having.
 */
export const ARRIVAL_PULSE_ON = "on";
export const ARRIVAL_PULSE_LIFT = "lift";

export interface ArrivalPulseOptions {
  /** Defaults to {@link ARRIVAL_PULSE_MS}. */
  durationMs?: number;
  /** The document to mark. Production passes none. */
  root?: Pick<Document, "querySelectorAll">;
  /** Test seams for the timer. */
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ArrivalPulse {
  /** Take the mark off now — a Return, or a newer arrival. */
  cancel(): void;
}

const NO_PULSE: ArrivalPulse = { cancel: () => {} };

/** The pulse currently playing in this document, so a second arrival replaces
    the first rather than leaving two cards lit at once. */
let playing: ArrivalPulse = NO_PULSE;

/** End whatever is playing — the Return half, and what a new arrival calls. */
export function cancelArrivalPulse(): void {
  playing.cancel();
  playing = NO_PULSE;
}

/**
 * Mark the landed target, and unmark it when the time is up.
 *
 * `selectors` are the board's own answers for the anchors the destination
 * resolved through; each may match nothing (an anchor this surface does not
 * draw), which is not an error — a pulse with nothing to mark is simply no
 * pulse at all.
 */
/**
 * Whether this element is in normal flow, and can therefore be lifted without
 * moving. Anything the engine cannot answer for — a document with no view, a
 * test DOM with no computed styles — is treated as positioned, because the
 * cost of guessing wrong that way is a ring that a neighbour may overlap, and
 * the cost of guessing wrong the other way is the card moving.
 */
function staticallyPositioned(element: Element): boolean {
  const view = element.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return false;
  let position: string | undefined;
  try {
    position = view.getComputedStyle(element).position;
  } catch {
    return false;
  }
  /* An engine that declares nothing for this element has told us it is in
     normal flow: `position` is `static` by initial value, and a DOM with no
     UA stylesheet answers the same thing as an empty string. */
  return position === "static" || position === "" || position === undefined;
}

export function startArrivalPulse(selectors: readonly (string | null | undefined)[], options: ArrivalPulseOptions = {}): ArrivalPulse {
  cancelArrivalPulse();
  const root = options.root ?? (typeof document === "undefined" ? null : document);
  if (!root) return NO_PULSE;

  const marked: Element[] = [];
  for (const selector of selectors) {
    if (!selector) continue;
    let found: ArrayLike<Element>;
    try {
      found = root.querySelectorAll(selector);
    } catch {
      /* A board that answered with a selector this engine cannot parse marks
         nothing; it must not take the arrival down with it. */
      continue;
    }
    for (const element of Array.from(found)) {
      if (marked.includes(element)) continue;
      element.setAttribute(ARRIVAL_PULSE_ATTRIBUTE, staticallyPositioned(element) ? ARRIVAL_PULSE_LIFT : ARRIVAL_PULSE_ON);
      marked.push(element);
    }
  }
  if (marked.length === 0) return NO_PULSE;

  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let done = false;
  const clear = () => {
    if (done) return;
    done = true;
    for (const element of marked) element.removeAttribute(ARRIVAL_PULSE_ATTRIBUTE);
  };
  const handle = setTimer(() => {
    clear();
    if (playing === pulse) playing = NO_PULSE;
  }, options.durationMs ?? ARRIVAL_PULSE_MS);
  const pulse: ArrivalPulse = {
    cancel: () => {
      clearTimer(handle);
      clear();
    },
  };
  playing = pulse;
  return pulse;
}
