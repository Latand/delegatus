/**
 * Where the voice companion's window may sit (#2519, design note §7).
 *
 * The rule: the window covers no control. It floats in the free rectangle
 * nearest the place it was asked for; when no free rectangle of its size
 * exists, it docks into a strip the application reflows around. Either way
 * it is the window that yields, on a drop and whenever the page changes
 * under it.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

/** What counts as a control the window must not cover. A host adds its own
    surfaces (a card that drags as a whole) through the window's `protect`. */
export const CONTROL_SELECTOR = [
  "a[href]", "button", "input", "select", "textarea", "summary", "[contenteditable='true']", "[draggable='true']",
  "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[role='switch']", "[role='checkbox']", "[role='option']",
].join(",");

/** The gap kept between the window and every control. */
export const CONTROL_CLEARANCE = 8;
/** The gap kept between the window and the viewport's edge. */
export const VIEWPORT_MARGIN = 8;

export function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

const inflate = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 });

/** Whether `rect` keeps `clearance` from every obstacle. */
export function isFree(rect: Rect, obstacles: readonly Rect[], clearance = CONTROL_CLEARANCE): boolean {
  const padded = inflate(rect, clearance);
  return obstacles.every((obstacle) => intersectionArea(padded, obstacle) === 0);
}

/** The top-left corners at which a window of `size` stays inside the viewport. */
function bounds(viewport: Size, size: Size, margin: number) {
  return { minX: margin, minY: margin, maxX: viewport.width - size.width - margin, maxY: viewport.height - size.height - margin };
}

export function clampToViewport(point: Point, viewport: Size, size: Size, margin = VIEWPORT_MARGIN): Point {
  const { minX, minY, maxX, maxY } = bounds(viewport, size, margin);
  return { x: Math.round(Math.min(Math.max(point.x, minX), Math.max(minX, maxX))), y: Math.round(Math.min(Math.max(point.y, minY), Math.max(minY, maxY))) };
}

/** The bottom-right corner: where the window asks to sit before anyone moved it. */
export function defaultAnchor(viewport: Size, size: Size, margin = 16): Point {
  return clampToViewport({ x: viewport.width - size.width - margin, y: viewport.height - size.height - margin }, viewport, size);
}

/**
 * The free position nearest `desired`, or null when the window fits nowhere.
 * A grid walk: the page has a few hundred controls and this runs on a drop or
 * a settled page change, never per frame.
 */
export function findPlacement(input: {
  viewport: Size;
  size: Size;
  obstacles: readonly Rect[];
  desired: Point;
  clearance?: number;
  margin?: number;
  step?: number;
}): Point | null {
  const { viewport, size, obstacles, desired, clearance = CONTROL_CLEARANCE, margin = VIEWPORT_MARGIN, step = 8 } = input;
  const { minX, minY, maxX, maxY } = bounds(viewport, size, margin);
  if (maxX < minX || maxY < minY) return null;
  const start = clampToViewport(desired, viewport, size, margin);
  const at = (point: Point): Rect => ({ ...point, ...size });
  if (isFree(at(start), obstacles, clearance)) return start;
  /* Only the obstacles the window could reach matter. */
  const padded = obstacles.map((obstacle) => inflate(obstacle, clearance));
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (let y = minY; y <= maxY; y += step) {
    const row = padded.filter((obstacle) => obstacle.y < y + size.height && obstacle.y + obstacle.height > y);
    for (let x = minX; x <= maxX; x += step) {
      const distance = (x - start.x) ** 2 + (y - start.y) ** 2;
      if (distance >= bestDistance) continue;
      const right = x + size.width;
      if (row.some((obstacle) => obstacle.x < right && obstacle.x + obstacle.width > x)) continue;
      best = { x, y };
      bestDistance = distance;
    }
  }
  return best;
}

export type Placement = { mode: "float"; at: Point } | { mode: "dock" };

/** Float at the nearest free rectangle, else dock. */
export function settlePlacement(input: Parameters<typeof findPlacement>[0]): Placement {
  const at = findPlacement(input);
  return at ? { mode: "float", at } : { mode: "dock" };
}
