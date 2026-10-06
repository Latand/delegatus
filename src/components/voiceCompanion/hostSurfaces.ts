import type { Rect } from "@/lib/voiceCompanion/placement";

/**
 * What the desktop shell tells the voice companion about its own surfaces
 * (#2519, design note §9 "Stated behaviour"). The product mount and the
 * evidence fixture pass the same three values, so the placement the driver
 * measures is the one the product computes.
 */

/** Surfaces the shell treats as controls beyond what a selector of buttons finds:
    a board card drags as a whole, and the feed's way-back strip is one control. */
export const COMPANION_PROTECT = ".kb .card,[data-feed-jump-strip]";
/** Surfaces that fill with rows carrying their own controls: a conversation's feed. */
export const COMPANION_ROWS = "[data-log-feed-scroller]";
/* While the reader is away from a feed's end, the feed shows a strip under itself with the way back. */
const FEED_STRIP_HEIGHT = 44;

/** Room kept for a feed's way-back strip before the strip exists. Once it is shown it is protected as
    the control it is, and the two readings give the same rectangle. */
export function companionReserved(): Rect[] {
  return [...document.querySelectorAll<HTMLElement>(COMPANION_ROWS)].flatMap((feed) => {
    const box = feed.getBoundingClientRect();
    const shown = [...document.querySelectorAll<HTMLElement>("[data-feed-jump-strip]")].some((strip) => Math.abs(strip.getBoundingClientRect().top - box.bottom) < 2);
    return shown || box.height <= FEED_STRIP_HEIGHT ? [] : [{ x: box.x, y: box.bottom - FEED_STRIP_HEIGHT, width: box.width, height: FEED_STRIP_HEIGHT }];
  });
}

/** Sent on the window when the settings surface saved a change, so the mounted companion reads it at once. */
export const COMPANION_SETTINGS_EVENT = "delegatus:voice-companion-settings";
