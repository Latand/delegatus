/**
 * What a hidden tab may still fetch (#1994).
 *
 * A phone whose Viewer is in the background downloads nothing: nobody hears
 * or sees it, and the data is the operator's. A desktop tab in the background
 * is different — its agent chimes (waiting, returned, stalled) and its "(N)"
 * title count are how the operator learns that something finished while they
 * work in another tab, and both are derived from the board feed. So a hidden
 * desktop tab keeps the ETag-chained delta feed, at a slower cadence.
 *
 * A phone is told apart by what it is, not by how wide its window is: a
 * browser that reports itself mobile (User-Agent Client Hints), or one whose
 * primary pointer is coarse and that has no fine pointer at all. A narrow
 * desktop window is still a desktop; a touchscreen laptop with a trackpad
 * has a fine pointer and is a desktop too.
 */

export function phoneClassDevice(): boolean {
  if (typeof window === "undefined") return false;
  const hints = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (hints?.mobile === true) return true;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
}

export function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Hidden, and on a device where a hidden tab fetches nothing. */
export function hiddenTrafficSuspended(): boolean {
  return documentHidden() && phoneClassDevice();
}
