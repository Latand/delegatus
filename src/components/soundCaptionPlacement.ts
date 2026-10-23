import { CONTROL_SELECTOR, intersectionArea, Occupancy, type Rect, type Size } from "@/lib/voiceCompanion/placement";

import { createPageVisibilityGuard } from "./voiceCompanion/pageVisibility";

/**
 * Where the caption stack stands (docs/design/sound-captions.md §5): on the
 * page's right edge, under the question toast, on the first place that keeps
 * clear of every line of text and every control, the way the voice popup keeps
 * to a free place. The geometry here is pure; `readObstacles` reads the page.
 *
 * A stack that fits nowhere folds its oldest toasts, newest kept: an old
 * caption is the one whose sound was heard longest ago. With no place free for
 * the `keep` newest (2 in a wide window, 1 in a narrow one), it takes the place
 * that covers the least.
 */

/** A rectangle the stack keeps off, with what covering it costs: a control weighs more than a line of text. */
export interface Obstacle extends Rect { weight: number }

/** The weight of a line of text and of a control. */
export const TEXT_WEIGHT = 1;
export const CONTROL_WEIGHT = 8;
/** From this window width the stack keeps two toasts on show before it covers anything; under it, one. Matches the 240 px toast of the stylesheet. */
export const WIDE_WINDOW = 1100;
/** A control larger than this (a card's whole title row, a tab) is kept off by what it shows, its text and icons: a toast over its blank part hides nothing. */
export const SMALL_CONTROL_AREA = 6000;
/** The gap kept between a toast and what it stands beside. */
export const CLEARANCE = 4;
/** The widest a toast is. */
export const TOAST_MAX_WIDTH = 300;
/** How far under its first line (the question toast's bottom) the stack may be pushed to find a free place. */
export const MAX_DROP = 320;
/** `NodeFilter.SHOW_TEXT`, by value: a test window has no `NodeFilter` global. */
const SHOW_TEXT = 4;
const STEP = 4;
/** What hiding one line of text costs, whatever part of it is hidden; a control costs `CONTROL_WEIGHT` times as much. A line cut by a few px is as unread as one cut by many. */
const HIDDEN_COST = 1000;
/** What each px a covering place sits below the first line costs: a 100 px drop weighs under one line of text (`HIDDEN_COST`). */
const DROP_COST = 8;
const GAP = 8;

export interface PlaceStackInput {
  viewport: Size;
  /** The column's right edge, px from the viewport's right. */
  right: number;
  /** The first line the column may start on. */
  minTop: number;
  /** The toasts' sizes, oldest first. */
  toasts: readonly Size[];
  obstacles: readonly Obstacle[];
  /** Overrides `MAX_DROP`. */
  maxDrop?: number;
  /** The fewest toasts left on show before a covering place is taken instead of folding one more; 1 when absent. */
  keep?: number;
}

export interface StackPlace {
  top: number;
  /** How many of the oldest toasts stay folded. */
  fold: number;
  /** Whether the place keeps clear of every obstacle. */
  free: boolean;
}

/** The rectangles `toasts` take with the column's top at `top`, right-aligned, one `GAP` apart. */
export function stackRects(viewport: Size, right: number, top: number, toasts: readonly Size[]): Rect[] {
  let y = top;
  return toasts.map((toast) => {
    const rect = { x: viewport.width - right - toast.width, y, width: toast.width, height: toast.height };
    y += toast.height + GAP;
    return rect;
  });
}

const inflate = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 });

export function placeStack({ viewport, right, minTop, toasts, obstacles, maxDrop = MAX_DROP, keep = 1 }: PlaceStackInput): StackPlace {
  if (!toasts.length) return { top: minTop, fold: 0, free: true };
  const occupancy = new Occupancy(viewport, obstacles);
  const last = (count: number) => toasts.slice(toasts.length - count);
  const height = (list: readonly Size[]) => list.reduce((sum, toast) => sum + toast.height, 0) + GAP * (list.length - 1);
  /* The tops a list may take: from the first line down `maxDrop`, while it stays inside the window. */
  const tops = (list: readonly Size[]) => {
    const found: number[] = [];
    for (let top = minTop; top <= minTop + maxDrop && top + height(list) <= viewport.height - GAP; top += STEP) found.push(top);
    return found;
  };
  const floor = Math.min(toasts.length, Math.max(1, keep));
  for (let count = toasts.length; count >= floor; count -= 1) {
    const list = last(count);
    for (const top of tops(list)) {
      if (stackRects(viewport, right, top, list).every((rect) => occupancy.free(rect.x - CLEARANCE, rect.y - CLEARANCE, rect.width + CLEARANCE * 2, rect.height + CLEARANCE * 2))) {
        return { top, fold: toasts.length - count, free: true };
      }
    }
  }
  /* No free place for the `keep` newest: the one in the same search that covers the least, the nearest to the first line on a tie. */
  const kept = last(floor);
  let best = { top: minTop, cost: Infinity };
  for (const top of tops(kept).length ? tops(kept) : [minTop]) {
    const rects = stackRects(viewport, right, top, kept).map((rect) => inflate(rect, CLEARANCE));
    let cost = (top - minTop) * DROP_COST;
    for (const obstacle of obstacles) {
      const area = rects.reduce((sum, rect) => sum + intersectionArea(rect, obstacle), 0);
      if (area > 0) cost += obstacle.weight * HIDDEN_COST + area / 100;
    }
    if (cost < best.cost) best = { top, cost };
  }
  return { top: best.top, fold: toasts.length - floor, free: false };
}

/** The part of a box a pointer can reach: cut to the viewport and to every clipping ancestor from `within` up. */
function reachable(within: Element | null, box: { left: number; top: number; right: number; bottom: number }, width: number, clips: Map<Element, DOMRect | null>): Rect | null {
  let left = Math.max(box.left, 0);
  let top = Math.max(box.top, 0);
  let right = Math.min(box.right, width);
  let bottom = Math.min(box.bottom, window.innerHeight);
  for (let parent = within; parent && right - left >= 1 && bottom - top >= 1; parent = parent.parentElement) {
    if (!clips.has(parent)) {
      const style = getComputedStyle(parent);
      clips.set(parent, style.overflowX !== "visible" || style.overflowY !== "visible" ? parent.getBoundingClientRect() : null);
    }
    const clip = clips.get(parent);
    if (!clip) continue;
    left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
  }
  return right - left < 1 || bottom - top < 1 ? null : { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The lines of text, the icons and the small controls (up to `SMALL_CONTROL_AREA`) a column `TOAST_MAX_WIDTH` wide
 * at `right` could stand on: the ones in its band of the page that a person can see (a scrim's or a window's cover
 * hides what is under it) and, for a control, reach. A larger control counts by the icons it holds; its text is
 * read with the page's. `column` is left out, and never counts as covering what is under it.
 */
export function readObstacles(column: Element | null, right: number): Obstacle[] {
  const width = document.documentElement.clientWidth;
  const bandLeft = width - right - TOAST_MAX_WIDTH - CLEARANCE;
  const canRead = createPageVisibilityGuard();
  const clips = new Map<Element, DOMRect | null>();
  const obstacles: Obstacle[] = [];
  /* Whether `element` is what the page shows at any of five points of `rect` (a box half under the question toast still is): the first thing there that is not the column. */
  const shown = (element: Element, rect: Rect) => [[0.5, 0.5], [0.12, 0.5], [0.88, 0.5], [0.5, 0.2], [0.5, 0.8]].some(([across, down]) => {
    const hit = document.elementsFromPoint(rect.x + rect.width * across!, rect.y + rect.height * down!).find((candidate) => !column?.contains(candidate));
    return Boolean(hit) && (element.contains(hit!) || hit!.contains(element));
  });
  /* A `display: contents` wrapper (a conversation's messages sit in them) has no box and reads as hidden: its nearest ancestor with one draws it. */
  const visibleBox = (element: Element) => {
    let box = element;
    while (box.parentElement && getComputedStyle(box).display === "contents") box = box.parentElement;
    return box.checkVisibility?.({ contentVisibilityAuto: true, checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  };
  const walker = document.createTreeWalker(document.body, SHOW_TEXT);
  const range = document.createRange();
  const seen = new Map<Element, boolean>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue?.trim() || column?.contains(parent) || !canRead(parent)) continue;
    if (!seen.has(parent)) seen.set(parent, parent.tagName !== "STYLE" && parent.tagName !== "SCRIPT" && visibleBox(parent));
    if (!seen.get(parent)) continue;
    range.selectNodeContents(node);
    for (const line of range.getClientRects?.() ?? []) {
      if (line.right <= bandLeft) continue;
      const rect = reachable(parent, line, width, clips);
      if (rect && rect.x + rect.width > bandLeft && shown(parent, rect)) obstacles.push({ ...rect, weight: TEXT_WEIGHT });
    }
  }
  for (const control of document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
    if (column?.contains(control) || !canRead(control) || !visibleBox(control)) continue;
    if (getComputedStyle(control).pointerEvents === "none") continue;
    const box = control.getBoundingClientRect();
    if (box.right <= bandLeft) continue;
    const rect = reachable(control.parentElement, box, width, clips);
    if (!rect || !shown(control, rect)) continue;
    if (rect.width * rect.height <= SMALL_CONTROL_AREA) {
      obstacles.push({ ...rect, weight: CONTROL_WEIGHT });
      continue;
    }
    for (const icon of control.querySelectorAll("svg, img")) {
      const iconBox = icon.getBoundingClientRect();
      if (iconBox.right <= bandLeft || icon.parentElement?.closest("svg") || !canRead(icon)) continue;
      const iconRect = reachable(icon.parentElement, iconBox, width, clips);
      if (iconRect && shown(icon, iconRect)) obstacles.push({ ...iconRect, weight: TEXT_WEIGHT });
    }
  }
  return obstacles;
}
