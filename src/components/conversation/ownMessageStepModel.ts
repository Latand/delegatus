/*
 * Stepping between the operator's own messages in a conversation
 * (docs/design/own-message-steps.md). This is the arithmetic; the feed supplies
 * the reading and the row above the composer shows the result.
 *
 * The own messages on the page are read by index, oldest first, as offsets
 * inside the feed's scrolled content. Rows stack in document order, so those
 * offsets never decrease and every answer here is a bisection: a handful of
 * reads however long the conversation is. The reading line is the scroll
 * offset plus `pad`, the gap a landed message keeps above itself.
 */

/** The desktop keeps a little air above a landed message. */
export const STEP_PAD_DESKTOP_PX = 8;
/** The phone's feed comes to rest with a row starting exactly at its top edge
    (#1978) and moves itself there after any reader scroll, so a step lands on
    that boundary and the feed has nothing to correct. */
export const STEP_PAD_PHONE_PX = 0;
/** Sub-pixel layout and a row a pixel or two past the line count as "at" it. */
export const STEP_SLACK_PX = 6;

export interface StepReading {
  /** Own messages on the page. */
  count: number;
  /** Offset of own message `index` on the page, never smaller than the one before it. */
  top: (index: number) => number;
  /** Scroll offset of the feed. */
  scrollTop: number;
  /** Height of the feed's viewport. */
  viewport: number;
  /** The largest scroll offset the feed can take. */
  maxScroll: number;
  /** The feed is holding its tail. This is the feed's own state: a phone feed
      that follows the tail rests up to a row short of the very end (#1978). */
  atTail: boolean;
  /** Own messages in history that is loaded and not yet on the page. */
  olderOwn: number;
  /** Older history exists and is not loaded. */
  olderUnloaded: boolean;
  /** The gap a landed message keeps under the feed's top edge. */
  pad: number;
}

export interface StepState {
  /** 1-based position of the own message being read, 0 before the first. */
  position: number;
  total: number;
  olderUnloaded: boolean;
  canPrev: boolean;
  canNext: boolean;
}

/** The first own message on the page whose offset is `past` the mark, or `count`. */
function firstPast(reading: StepReading, past: (top: number) => boolean): number {
  let low = 0;
  let high = reading.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (past(reading.top(middle))) high = middle; else low = middle + 1;
  }
  return low;
}

/** An own message may exist before the first one on the page. */
export const hasOlder = (reading: StepReading): boolean => reading.olderOwn > 0 || reading.olderUnloaded;

/** Index of the own message a step lands on, or null when the page has none that way. */
export function stepTarget(reading: StepReading, direction: -1 | 1): number | null {
  const anchor = reading.scrollTop + reading.pad;
  if (direction < 0) {
    /* From the middle of a reply this is the message that reply answers. */
    const index = firstPast(reading, (top) => top >= anchor - STEP_SLACK_PX) - 1;
    return index < 0 ? null : index;
  }
  /* At the tail nothing below can come any closer to the reading line. */
  if (reading.atTail) return null;
  const index = firstPast(reading, (top) => top > anchor + STEP_SLACK_PX);
  return index === reading.count ? null : index;
}

/** The scroll offset that puts own message `index` on the reading line. */
export function stepScrollTop(reading: StepReading, index: number): number {
  return Math.max(0, Math.min(reading.maxScroll, reading.top(index) - reading.pad));
}

export function stepState(reading: StepReading): StepState {
  const anchor = reading.scrollTop + reading.pad;
  /* At the tail the last messages cannot reach the reading line, so the one
     being read is the last that has started anywhere on screen. */
  const line = reading.atTail ? reading.scrollTop + reading.viewport - 1 : anchor + STEP_SLACK_PX;
  return {
    position: reading.olderOwn + firstPast(reading, (top) => top > line),
    total: reading.olderOwn + reading.count,
    olderUnloaded: reading.olderUnloaded,
    /* A step back from the oldest message on the page asks the feed for the
       history before it. */
    canPrev: stepTarget(reading, -1) !== null || hasOlder(reading),
    canNext: stepTarget(reading, 1) !== null,
  };
}

/** Whether the row has anything to offer. Two own messages are something to
    step between. With history still unloaded the count is open, so the row
    stays while the conversation holds a message of the operator's at all: one
    already counted, or one the conversation is known to have (`operatorWrote`).
    A conversation walked to its start with fewer than two has no row. */
export function stepRowOffered(state: StepState, operatorWrote: boolean): boolean {
  return state.total >= 2 || (state.olderUnloaded && (state.total >= 1 || operatorWrote));
}

/** `3 / 7`, and `3 / 7+` while older history is unloaded. */
export function stepCountLabel(state: StepState): string {
  return `${state.position} / ${state.total}${state.olderUnloaded ? "+" : ""}`;
}
