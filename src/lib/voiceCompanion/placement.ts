/**
 * Where the voice companion may sit and where its bubbles go (#2519, design
 * note §9). Pure geometry, shared by the component and the tests.
 *
 * The companion is a character with a lane beside it. The lane is the
 * rectangle its speech bubbles and call elements may occupy; it is reserved
 * whole, so what the bubbles cover is decided when the character is placed
 * and not when a bubble arrives. The rules:
 *
 *  - The character and its lane cover no control: they take the free place
 *    nearest the one asked for, keeping 8 px from every control. A shorter
 *    lane is tried before giving up; with no free place for any lane the
 *    companion collapses to its small shape, which takes the nearest free
 *    place for itself.
 *  - The lane sits on the side of the character that faces the middle of the
 *    screen, and the bubbles rise upward; near an edge the lane flips to the
 *    other side, and near the top the bubbles run downward, so nothing leaves
 *    the viewport.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

/** What counts as a control the companion must not cover. A host adds its own
    surfaces (a card that drags as a whole) through the companion's `protect`. */
export const CONTROL_SELECTOR = [
  "a[href]", "button", "input", "select", "textarea", "summary", "[contenteditable='true']", "[draggable='true']",
  "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[role='switch']", "[role='checkbox']", "[role='option']",
].join(",");

/** The gap kept between the companion and every control. */
export const CONTROL_CLEARANCE = 8;
/** The gap kept between the companion and the viewport's edge. */
export const VIEWPORT_MARGIN = 8;
/** The gap between the character and its lane. */
export const LANE_GAP = 10;

/** A speech bubble is at most this wide and this many lines tall. */
export const BUBBLE_MAX_WIDTH = 280;
export const BUBBLE_MAX_LINES = 4;
/** The characters one bubble holds before the sentence continues in the next. */
export const BUBBLE_MAX_CHARS = 116;
/** The lane heights tried, tallest first. */
export const LANE_HEIGHTS = [360, 260, 180] as const;

export type LaneSide = "left" | "right";
export type LaneDirection = "up" | "down";
export interface LaneLayout { side: LaneSide; direction: LaneDirection; rect: Rect }

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

export function clampToViewport(point: Point, viewport: Size, size: Size, margin = VIEWPORT_MARGIN): Point {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  return { x: Math.round(Math.min(Math.max(point.x, margin), maxX)), y: Math.round(Math.min(Math.max(point.y, margin), maxY)) };
}

/** The bottom-right corner: where the character asks to sit before anyone moved it. */
export function defaultAnchor(viewport: Size, size: Size, margin = 16): Point {
  return clampToViewport({ x: viewport.width - size.width - margin, y: viewport.height - size.height - margin }, viewport, size);
}

/**
 * The lane beside a character at `block`. It faces the middle of the screen
 * and flips at an edge; bubbles rise unless the lane would leave the top, and
 * then run downward. A viewport too short for the lane either way shortens it.
 */
export function laneLayout(viewport: Size, block: Rect, height: number, width = BUBBLE_MAX_WIDTH, margin = VIEWPORT_MARGIN): LaneLayout {
  const leftX = block.x - LANE_GAP - width;
  const rightX = block.x + block.width + LANE_GAP;
  const fitsLeft = leftX >= margin;
  const fitsRight = rightX + width <= viewport.width - margin;
  const prefersLeft = block.x + block.width / 2 >= viewport.width / 2;
  const side: LaneSide = prefersLeft ? (fitsLeft || !fitsRight ? "left" : "right") : (fitsRight || !fitsLeft ? "right" : "left");
  const x = side === "left" ? Math.max(margin, leftX) : Math.min(rightX, viewport.width - margin - width);
  const bottom = block.y + block.height;
  const roomUp = bottom - margin;
  const roomDown = viewport.height - margin - block.y;
  const direction: LaneDirection = roomUp >= height || roomUp >= roomDown ? "up" : "down";
  const laneHeight = Math.max(0, Math.min(height, direction === "up" ? roomUp : roomDown));
  const y = direction === "up" ? bottom - laneHeight : block.y;
  return { side, direction, rect: { x: Math.round(x), y: Math.round(y), width, height: Math.round(laneHeight) } };
}

export type Placement =
  | { mode: "expanded"; at: Point; laneHeight: number; lane: LaneLayout }
  | { mode: "collapsed"; at: Point };

/**
 * The free place nearest `desired` for the character block and its lane:
 * the tallest lane that fits anywhere wins. A grid walk; it runs on a drop or
 * a settled page change, never per frame.
 */
export function placeExpanded(input: {
  viewport: Size; block: Size; obstacles: readonly Rect[]; desired: Point; heights?: readonly number[]; clearance?: number; step?: number;
}): Extract<Placement, { mode: "expanded" }> | null {
  const { viewport, block, obstacles, desired, heights = LANE_HEIGHTS, clearance = CONTROL_CLEARANCE, step = 8 } = input;
  const padded = obstacles.map((obstacle) => inflate(obstacle, clearance));
  const free = (rect: Rect) => padded.every((obstacle) => intersectionArea(rect, obstacle) === 0);
  const start = clampToViewport(desired, viewport, block);
  const maxX = viewport.width - block.width - VIEWPORT_MARGIN;
  const maxY = viewport.height - block.height - VIEWPORT_MARGIN;
  if (maxX < VIEWPORT_MARGIN || maxY < VIEWPORT_MARGIN) return null;
  /* Candidates nearest first, so the first free one is the answer. */
  const candidates = nearestFirst(start, { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN }, { x: maxX, y: maxY }, step);
  for (const height of heights) {
    for (const point of candidates) {
      const rect = { ...point, ...block };
      if (!free(rect)) continue;
      const lane = laneLayout(viewport, rect, height);
      if (lane.rect.height >= height && free(lane.rect)) return { mode: "expanded", at: point, laneHeight: height, lane };
    }
  }
  return null;
}

/** The free place nearest `desired` for the collapsed shape alone. */
export function placeCollapsed(input: { viewport: Size; size: Size; obstacles: readonly Rect[]; desired: Point; clearance?: number; step?: number }): Point | null {
  const { viewport, size, obstacles, desired, clearance = CONTROL_CLEARANCE, step = 8 } = input;
  const start = clampToViewport(desired, viewport, size);
  const max = { x: viewport.width - size.width - VIEWPORT_MARGIN, y: viewport.height - size.height - VIEWPORT_MARGIN };
  if (max.x < VIEWPORT_MARGIN || max.y < VIEWPORT_MARGIN) return null;
  return nearestFirst(start, { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN }, max, step).find((point) => isFree({ ...point, ...size }, obstacles, clearance)) ?? null;
}

/** The grid points between `min` and `max`, `start` first and then by distance from it. */
function nearestFirst(start: Point, min: Point, max: Point, step: number): Point[] {
  const points: Point[] = [start];
  for (let y = min.y; y <= max.y; y += step) for (let x = min.x; x <= max.x; x += step) points.push({ x, y });
  const distance = (point: Point) => (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  return points.sort((left, right) => distance(left) - distance(right));
}

/** A sentence that ends a bubble holding at least this many characters closes it. */
export const BUBBLE_SENTENCE_BREAK = 48;

/**
 * Speech split into bubbles. A bubble closes at the end of a sentence once it
 * holds 48 characters, so short sentences share one; a sentence longer than a
 * bubble continues in the next one at a word boundary. The split reads only
 * what came before, so a line that is still streaming never moves a word out
 * of a bubble already shown.
 */
export function splitSpeech(text: string, maxChars = BUBBLE_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const word of text.match(/\S+\s*/gu) ?? []) {
    const sentenceEnded = current.trim().length >= BUBBLE_SENTENCE_BREAK && /[.!?…]["”»)]?\s+$/u.test(current);
    if (current && (current.trimEnd().length + 1 + word.trimEnd().length > maxChars || sentenceEnded)) {
      chunks.push(current.trim());
      current = "";
    }
    current += word;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
