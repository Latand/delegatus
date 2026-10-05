/*
 * Second-round design prototype (docs/design/own-message-steps.md): stepping
 * between the operator's own messages in the production conversation pane.
 * This is the arithmetic every variant shares; the controls differ only in
 * where they live.
 *
 * `tops` are the own messages' offsets inside the feed's scrolled content,
 * oldest first. The reading line is the scroll offset plus `pad`, the gap a
 * landed message keeps above itself.
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
  tops: readonly number[];
  /** Scroll offset of the feed. */
  scrollTop: number;
  /** Height of the feed's viewport. */
  viewport: number;
  /** The largest scroll offset the feed can take. */
  maxScroll: number;
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

const atBottom = (reading: StepReading) => reading.maxScroll - reading.scrollTop <= 1;

/** Index of the own message a step lands on, or null when there is none that way. */
export function stepTarget(reading: StepReading, direction: -1 | 1): number | null {
  const anchor = reading.scrollTop + reading.pad;
  if (direction < 0) {
    /* From the middle of a reply this is the message that reply answers. */
    for (let index = reading.tops.length - 1; index >= 0; index -= 1) {
      if (reading.tops[index]! < anchor - STEP_SLACK_PX) return index;
    }
    return null;
  }
  /* At the tail nothing below can come any closer to the reading line. */
  if (atBottom(reading)) return null;
  const index = reading.tops.findIndex((top) => top > anchor + STEP_SLACK_PX);
  return index === -1 ? null : index;
}

/** The scroll offset that puts own message `index` on the reading line. */
export function stepScrollTop(reading: StepReading, index: number): number {
  return Math.max(0, Math.min(reading.maxScroll, reading.tops[index]! - reading.pad));
}

export function stepState(reading: StepReading): StepState {
  const anchor = reading.scrollTop + reading.pad;
  /* At the tail the last messages cannot reach the reading line, so the one
     being read is the last that has started anywhere on screen. */
  const line = atBottom(reading) ? reading.scrollTop + reading.viewport - 1 : anchor + STEP_SLACK_PX;
  let position = 0;
  for (const top of reading.tops) if (top <= line) position += 1;
  return {
    position,
    total: reading.tops.length,
    olderUnloaded: reading.olderUnloaded,
    /* With older history unloaded, a step back from the oldest loaded message
       asks the feed for the page before it. */
    canPrev: stepTarget(reading, -1) !== null || reading.olderUnloaded,
    canNext: stepTarget(reading, 1) !== null,
  };
}

/** `3 / 7`, and `3 / 7+` while older history is unloaded. */
export function stepCountLabel(state: StepState): string {
  return `${state.position} / ${state.total}${state.olderUnloaded ? "+" : ""}`;
}
