import { CONTROL_SELECTOR, intersectionArea, Occupancy, type Rect, type Size } from "@/lib/voiceCompanion/placement";

import { createPageVisibilityGuard } from "./voiceCompanion/pageVisibility";

/**
 * Where the caption stack stands (docs/design/sound-captions.md §5): on the
 * page's right edge, under the question toast, on the first place that keeps
 * clear of every line of text and every control, the way the voice popup keeps
 * to a free place. The geometry here is pure; `readObstacles` reads the page.
 *
 * A stack that fits nowhere folds its oldest toasts, newest kept: an old
 * caption is the one whose sound was heard longest ago. Before any place that
 * covers something, it tries in this order: the whole stack, then fewer toasts
 * down to the newest one, within `MAX_DROP` of the first line; the newest alone
 * anywhere down the window's height; the newest alone anywhere down the height,
 * moved leftward in steps while it stays in the window's right half. With no
 * free place at all it takes the place that covers the least for the `keep`
 * newest (2 in a wide window, 1 in a narrow one).
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
/** How far each leftward try moves the column, px. */
export const SHIFT_STEP = 8;
/** The gap kept between a toast and what it stands beside. */
export const CLEARANCE = 4;
/** The widest a toast is. */
export const TOAST_MAX_WIDTH = 300;
/** How far under its first line (the question toast's bottom) the stack may be pushed to find a free place. */
export const MAX_DROP = 320;
/** The window event the question toast sends once it stands on a new place, so the caption stack under it reads the page again. */
export const QUESTION_TOAST_PLACED = "delegatus:question-toast-placed";
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
  /** Whether the newest toast alone may take a free place anywhere down the window's height when none is free within `maxDrop`. Absent: it stays within `maxDrop`. */
  anywhere?: boolean;
  /** Whether the newest toast alone may move leftward, up to the window's middle, to find a free place. Absent: it keeps its right edge. */
  leftward?: boolean;
  /** The fewest toasts left on show before a covering place is taken instead of folding one more; 1 when absent. */
  keep?: number;
}

export interface StackPlace {
  top: number;
  /** How many of the oldest toasts stay folded. */
  fold: number;
  /** Whether the place keeps clear of every obstacle. */
  free: boolean;
  /** How far leftward from `right` the column stands, px; 0 on the column's own edge. */
  shift: number;
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

export function placeStack({ viewport, right, minTop, toasts, obstacles, maxDrop = MAX_DROP, keep = 1, anywhere = false, leftward = false }: PlaceStackInput): StackPlace {
  if (!toasts.length) return { top: minTop, fold: 0, free: true, shift: 0 };
  const occupancy = new Occupancy(viewport, obstacles);
  const last = (count: number) => toasts.slice(toasts.length - count);
  const height = (list: readonly Size[]) => list.reduce((sum, toast) => sum + toast.height, 0) + GAP * (list.length - 1);
  /* The tops a list may take: from the first line down `drop`, while it stays inside the window. */
  const tops = (list: readonly Size[], drop = maxDrop) => {
    const found: number[] = [];
    for (let top = minTop; top <= minTop + drop && top + height(list) <= viewport.height - GAP; top += STEP) found.push(top);
    return found;
  };
  const fits = (list: readonly Size[], at: number, top: number) => stackRects(viewport, at, top, list).every((rect) => occupancy.free(rect.x - CLEARANCE, rect.y - CLEARANCE, rect.width + CLEARANCE * 2, rect.height + CLEARANCE * 2));
  const floor = Math.min(toasts.length, Math.max(1, keep));
  /* The whole stack, then fewer down to the newest one, near the first line. */
  for (let count = toasts.length; count >= 1; count -= 1) {
    const list = last(count);
    for (const top of tops(list)) {
      if (fits(list, right, top)) return { top, fold: toasts.length - count, free: true, shift: 0 };
    }
  }
  /* The newest alone, anywhere down the window, on its own edge and then moved leftward while it stays in the right half. */
  const newest = last(1);
  const wide = Math.max(...newest.map((toast) => toast.width));
  const reach = leftward ? Math.max(0, viewport.width - right - wide - viewport.width / 2) : 0;
  for (let shift = 0; shift <= reach && (anywhere || leftward); shift += SHIFT_STEP) {
    for (const top of tops(newest, anywhere ? viewport.height : maxDrop)) {
      if (fits(newest, right + shift, top)) return { top, fold: toasts.length - 1, free: true, shift };
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
  return { top: best.top, fold: toasts.length - floor, free: false, shift: 0 };
}

/** The narrowest a question toast may be made, px: its title and one line of its text still read. */
export const NARROW_MIN = 220;
/** The occupancy grid is 2 px: an edge is cleared a cell further than its own coordinate. */
export const GRID_SLACK = 2;

/**
 * The width a toast of `size`, right-aligned and standing at `top`, must take to keep clear of the words and controls
 * it covers on its left (a tab's label at the foot of a header, say): its left edge moves to their right edge plus
 * `CLEARANCE` and a grid cell, and its text wraps. Null when nothing is covered, or when something covered reaches too far right to be
 * cleared by a toast at least `NARROW_MIN` wide. The caller measures the taller toast the width makes and places it again.
 */
export function widthClearOfLeft({ viewport, right, top, size, obstacles }: { viewport: Size; right: number; top: number; size: Size; obstacles: readonly Obstacle[] }): number | null {
  const edge = viewport.width - right;
  const box = { x: edge - size.width - CLEARANCE, y: top - CLEARANCE, width: size.width + CLEARANCE * 2, height: size.height + CLEARANCE * 2 };
  let clear = -Infinity;
  for (const obstacle of obstacles) {
    if (obstacle.width <= 0 || obstacle.height <= 0) continue;
    if (obstacle.x >= box.x + box.width || obstacle.x + obstacle.width <= box.x || obstacle.y >= box.y + box.height || obstacle.y + obstacle.height <= box.y) continue;
    clear = Math.max(clear, obstacle.x + obstacle.width + CLEARANCE + GRID_SLACK);
  }
  if (clear === -Infinity) return null;
  const width = Math.floor(edge - clear);
  return width >= NARROW_MIN && width < size.width ? width : null;
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
export function readObstacles(column: Element | null, right: number, options: { width?: number; skip?: string } = {}): Obstacle[] {
  const width = document.documentElement.clientWidth;
  const bandLeft = width - right - (options.width ?? TOAST_MAX_WIDTH) - CLEARANCE;
  /* The column itself, and what the caller names (the other stack, which this one is placed against and never over). */
  const own = (element: Element) => Boolean(column?.contains(element) || (options.skip && element.closest(options.skip)));
  const canRead = createPageVisibilityGuard();
  const clips = new Map<Element, DOMRect | null>();
  const obstacles: Obstacle[] = [];
  /* Whether `element` is what the page shows at any of five points of `rect` (a box half under the question toast still is): the first thing there that is not the column. */
  const shown = (element: Element, rect: Rect) => [[0.5, 0.5], [0.12, 0.5], [0.88, 0.5], [0.5, 0.2], [0.5, 0.8]].some(([across, down]) => {
    const hit = document.elementsFromPoint(rect.x + rect.width * across!, rect.y + rect.height * down!).find((candidate) => !own(candidate));
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
    if (!parent || !node.nodeValue?.trim() || own(parent) || !canRead(parent)) continue;
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
    if (own(control) || !canRead(control) || !visibleBox(control)) continue;
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
