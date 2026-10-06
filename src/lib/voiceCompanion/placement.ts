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
 *  - A control inside a surface that fills with rows (a conversation's feed)
 *    is an obstacle along its whole track, its width over the surface's
 *    height: the component adds those rectangles, since a row that arrives or
 *    a scroll can put the control anywhere on it.
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
  "[role='separator']", "[role='slider']", "[role='scrollbar']",
].join(",");

/** A cursor that only says "nothing here takes the pointer". Anything else under
    the pointer is a control whatever its markup: a resize handle (`ew-resize`), a
    surface that drags (`grab`), a custom clickable (`pointer`). */
export const isPassiveCursor = (cursor: string): boolean => cursor === "auto" || cursor === "default" || cursor === "text" || cursor === "none" || cursor === "";

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
 * the tallest lane that fits anywhere wins. The character also keeps off
 * `text`, the lines of the page's text, wherever a place without any exists;
 * a page with no such place still keeps it off every control. The answer
 * depends on nothing but the arguments, so one page gives one place.
 * A grid walk; it runs on a drop or a settled page change, never per frame.
 */
export function placeExpanded(input: {
  viewport: Size; block: Size; obstacles: readonly Rect[]; text?: readonly Rect[]; desired: Point; heights?: readonly number[]; clearance?: number; step?: number;
}): Extract<Placement, { mode: "expanded" }> | null {
  const { viewport, block, obstacles, text = [], desired, heights = LANE_HEIGHTS, clearance = CONTROL_CLEARANCE, step = 8 } = input;
  const padded = obstacles.map((obstacle) => inflate(obstacle, clearance));
  const lines = text.map((line) => inflate(line, clearance));
  const free = (rect: Rect) => padded.every((obstacle) => intersectionArea(rect, obstacle) === 0);
  const start = clampToViewport(desired, viewport, block);
  const maxX = viewport.width - block.width - VIEWPORT_MARGIN;
  const maxY = viewport.height - block.height - VIEWPORT_MARGIN;
  if (maxX < VIEWPORT_MARGIN || maxY < VIEWPORT_MARGIN) return null;
  /* Candidates nearest first, so the first free one is the answer; the place asked for leads them. */
  const candidates = nearestFirst(start, { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN }, { x: maxX, y: maxY }, step);
  for (const avoid of lines.length ? [lines, []] : [[]]) {
    const clear = (rect: Rect) => avoid.every((line) => intersectionArea(rect, line) === 0);
    for (const height of heights) {
      for (const point of candidates) {
        const rect = { ...point, ...block };
        if (!free(rect) || !clear(rect)) continue;
        const lane = laneLayout(viewport, rect, height);
        if (lane.rect.height >= height && free(lane.rect)) return { mode: "expanded", at: point, laneHeight: height, lane };
      }
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
  if (isFree({ ...start, ...size }, obstacles, clearance)) return start;
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
/** A clause break is taken only when the bubble it closes holds at least this many characters. */
export const BUBBLE_CLAUSE_BREAK = 40;
/** A sentence cut by the limit carries at least this many words into the next bubble. */
export const BUBBLE_CARRY_WORDS = 2;

/* Words a bubble never ends on: articles, prepositions, conjunctions, auxiliaries and bare pronouns. */
const FUNCTION_WORDS = new Set((
  "a an the of to in on at for with by from as into onto over under about than then and or but nor so if that which who whose whom when while "
  + "because although though unless until since is are was were be been am do does did has have had can could will would shall should may might must "
  + "i you we they he she it its this these those my your our their his her not no "
  + "і й та а але чи або що щоб як який яка яке які якого якої якій яких яким коли доки поки бо тож тому якщо хоча ні не в у на з із зі до від для по за при про під над "
  + "через без між це цей ця ці той те ті свій своя своє свої його її їх ми ви він вона воно вони я ти би б же ж лише тільки ще вже дуже є був була було були"
).split(" "));
/* Words a clause starts with: a break before one of them reads as the end of a clause. */
const CLAUSE_OPENERS = new Set((
  "and but or so because which that who when while if although though unless until since "
  + "і й та а але чи або що щоб який яка яке які коли доки поки бо тож якщо хоча"
).split(" "));
const bare = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * Speech split into bubbles. A bubble closes at the end of a sentence once it
 * holds 48 characters, so short sentences share one. A sentence longer than a
 * bubble continues in the next one, cut where it reads best: at the last comma
 * or before the last conjunction that leaves the bubble at least 40
 * characters, otherwise at the last word that is no function word. A cut
 * carries at least two words on, so the next bubble never starts as a lone
 * word, and no bubble ends on a function word. The cut is chosen from what
 * came before it, so every bubble but the last stays as it is while a line
 * still streams. The last one would give up the carried words when it closes;
 * with `streams`, it holds only the words no later cut can carry on (those up
 * to the cut the limit would choose now, two words back at the least), so what
 * a bubble has shown it keeps, and the rest joins it or opens the next bubble
 * once the line has said which. A bubble with nothing settled yet is left out.
 */
export function splitSpeech(text: string, maxChars = BUBBLE_MAX_CHARS, streams = false): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  const length = (words: readonly string[]) => words.join("").trimEnd().length;
  for (const word of text.match(/\S+\s*/gu) ?? []) {
    const joined = current.join("");
    const sentenceEnded = joined.trim().length >= BUBBLE_SENTENCE_BREAK && /[.!?…]["”»)]?\s+$/u.test(joined);
    if (current.length && sentenceEnded) {
      chunks.push(joined.trim());
      current = [];
    } else if (current.length && length(current) + 1 + word.trimEnd().length > maxChars) {
      const at = clauseCut(current, word);
      chunks.push(current.slice(0, at + 1).join("").trim());
      current = current.slice(at + 1);
    }
    current.push(word);
  }
  /* A sentence that ended a bubble of 48 characters closes it with the next word: nothing of it moves on. */
  const closing = current.join("").trim().length >= BUBBLE_SENTENCE_BREAK && /[.!?…]["”»)]?\s+$/u.test(current.join(""));
  if (streams && !closing) current = current.slice(0, settledCut(current) + 1);
  if (current.join("").trim()) chunks.push(current.join("").trim());
  return chunks;
}

/** The index of the last word of an open bubble that every later cut leaves in it, or -1: the choice
    `clauseCut` would make among the words that already have two after them. More words only add later choices. */
function settledCut(words: readonly string[]): number {
  const reach = words.length - 1 - BUBBLE_CARRY_WORDS;
  const closes = (index: number) => !FUNCTION_WORDS.has(bare(words[index]!));
  const size = (index: number) => words.slice(0, index + 1).join("").trimEnd().length;
  const clause = (index: number) => /[,;:—–]\s*$/u.test(words[index]!) || CLAUSE_OPENERS.has(bare(words[index + 1]!));
  for (let index = reach; index >= 0; index -= 1) if (closes(index) && clause(index) && size(index) >= BUBBLE_CLAUSE_BREAK) return index;
  for (let index = reach; index >= 1; index -= 1) if (closes(index)) return index;
  return -1;
}

/** The index of the last word a bubble that overflowed keeps; the words after it move on with `next`. */
function clauseCut(words: readonly string[], next: string): number {
  const last = words.length - 1;
  const closes = (index: number) => !FUNCTION_WORDS.has(bare(words[index]!));
  const carries = (index: number) => last - index >= BUBBLE_CARRY_WORDS;
  const size = (index: number) => words.slice(0, index + 1).join("").trimEnd().length;
  const clause = (index: number) => /[,;:—–]\s*$/u.test(words[index]!) || CLAUSE_OPENERS.has(bare(words[index + 1] ?? next));
  for (let index = last; index >= 0; index -= 1) if (carries(index) && closes(index) && clause(index) && size(index) >= BUBBLE_CLAUSE_BREAK) return index;
  for (let index = last; index >= 1; index -= 1) if (carries(index) && closes(index)) return index;
  for (let index = last; index >= 1; index -= 1) if (closes(index)) return index;
  return last;
}
