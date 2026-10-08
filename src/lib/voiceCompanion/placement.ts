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
 *  - Unless the operator put it there, neither the character nor its lane
 *    covers a line of the page's text (the component counts the pictures of
 *    a feed's rows, their avatars, with it), and a surface that fills with rows (a
 *    conversation's feed) is kept clear as a whole, its empty part included,
 *    wherever a place outside it exists: the rows that arrive while it talks
 *    then arrive where nothing of the companion stands.
 *  - A control inside a surface that fills with rows is an obstacle along its
 *    whole track, its width over the surface's height: the component adds
 *    those rectangles, since a row that arrives or a scroll can put the
 *    control anywhere on it.
 *  - The lane sits on the side of the character that faces the middle of the
 *    screen, and the bubbles rise upward; near an edge the lane flips to the
 *    other side, and near the top the bubbles run downward, so nothing leaves
 *    the viewport. In a column too narrow for the lane beside the character,
 *    the lane stands above it and the bubbles rise away from it.
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
/** The lane heights tried, tallest first: the tallest that fits where the character may stand. */
export const LANE_HEIGHTS = [360, 340, 320, 300, 280, 260, 240, 220, 200, 180] as const;

/** `above`: the lane stands over the character, in a column too narrow for it beside the character. */
export type LaneSide = "left" | "right" | "above";
export type LaneDirection = "up" | "down";
/** `align`, for a lane above the character: the edge of the character the lane lines up with. */
export interface LaneLayout { side: LaneSide; direction: LaneDirection; rect: Rect; align?: "start" | "end" }

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
  const lane = { x: 0, y: 0, height: 0, side: "left" as LaneSide, direction: "up" as LaneDirection };
  sideLane(viewport, block.x, block.y, block.width, block.height, height, lane, width, margin);
  return { side: lane.side, direction: lane.direction, rect: { x: lane.x, y: lane.y, width, height: lane.height } };
}

/** `laneLayout` for a character at `x`, `y` of `width` by `tall`, written into `out` (the placement walk reuses one). */
function sideLane(viewport: Size, x: number, y: number, width: number, tall: number, height: number, out: { x: number; y: number; height: number; side?: LaneSide; direction?: LaneDirection }, laneWidth = BUBBLE_MAX_WIDTH, margin = VIEWPORT_MARGIN) {
  const leftX = x - LANE_GAP - laneWidth;
  const rightX = x + width + LANE_GAP;
  const fitsLeft = leftX >= margin;
  const fitsRight = rightX + laneWidth <= viewport.width - margin;
  const prefersLeft = x + width / 2 >= viewport.width / 2;
  const side: LaneSide = prefersLeft ? (fitsLeft || !fitsRight ? "left" : "right") : (fitsRight || !fitsLeft ? "right" : "left");
  const laneX = side === "left" ? Math.max(margin, leftX) : Math.min(rightX, viewport.width - margin - laneWidth);
  const bottom = y + tall;
  const roomUp = bottom - margin;
  const roomDown = viewport.height - margin - y;
  const direction: LaneDirection = roomUp >= height || roomUp >= roomDown ? "up" : "down";
  const laneHeight = Math.max(0, Math.min(height, direction === "up" ? roomUp : roomDown));
  out.x = Math.round(laneX);
  out.y = Math.round(direction === "up" ? bottom - laneHeight : y);
  out.height = Math.round(laneHeight);
  out.side = side;
  out.direction = direction;
}

/** The lane above a character at `block`, lined up with its left (`start`) or right (`end`) edge, or null where it would leave the viewport. */
export function laneAbove(viewport: Size, block: Rect, height: number, align: "start" | "end", width = BUBBLE_MAX_WIDTH, margin = VIEWPORT_MARGIN): LaneLayout | null {
  const x = align === "start" ? block.x : block.x + block.width - width;
  const y = block.y - LANE_GAP - height;
  if (x < margin || x + width > viewport.width - margin || y < margin) return null;
  return { side: "above", direction: "up", align, rect: { x: Math.round(x), y: Math.round(y), width, height } };
}

export type Placement =
  | { mode: "expanded"; at: Point; lane: LaneLayout }
  | { mode: "collapsed"; at: Point };

/**
 * What a set of rectangles covers, as a summed-area table over 2 px cells: whether a rectangle meets any of
 * them is then four reads, however many there are. A cell any rectangle reaches into counts as covered, and a
 * place counts every cell it reaches into, so a place may be refused for a rectangle up to 2 px away from it
 * (a quarter of the clearance kept from everything) and is never allowed over one.
 */
export class Occupancy {
  static readonly CELL = 2;
  private readonly table: Int32Array;
  private readonly columns: number;
  private readonly rows: number;
  constructor(viewport: Size, rects: readonly Rect[]) {
    const cell = Occupancy.CELL;
    const columns = Math.max(0, Math.ceil(viewport.width / cell));
    const rows = Math.max(0, Math.ceil(viewport.height / cell));
    this.columns = columns;
    this.rows = rows;
    const mask = new Uint8Array(columns * rows);
    for (const rect of rects) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const x0 = Math.max(0, Math.floor(rect.x / cell));
      const x1 = Math.min(columns, Math.ceil((rect.x + rect.width) / cell));
      const y0 = Math.max(0, Math.floor(rect.y / cell));
      const y1 = Math.min(rows, Math.ceil((rect.y + rect.height) / cell));
      if (x1 <= x0 || y1 <= y0) continue;
      for (let y = y0; y < y1; y += 1) mask.fill(1, y * columns + x0, y * columns + x1);
    }
    const stride = columns + 1;
    const table = new Int32Array(stride * (rows + 1));
    for (let y = 0; y < rows; y += 1) {
      let sum = 0;
      for (let x = 0; x < columns; x += 1) {
        sum += mask[y * columns + x]!;
        table[(y + 1) * stride + x + 1] = table[y * stride + x + 1]! + sum;
      }
    }
    this.table = table;
  }
  /** Whether the rectangle at `x`, `y` of `width` by `height` meets none of the rectangles. */
  free(x: number, y: number, width: number, height: number): boolean {
    const cell = Occupancy.CELL;
    if (width <= 0 || height <= 0) return true;
    const x0 = Math.max(0, Math.floor(x / cell));
    const x1 = Math.min(this.columns, Math.ceil((x + width) / cell));
    const y0 = Math.max(0, Math.floor(y / cell));
    const y1 = Math.min(this.rows, Math.ceil((y + height) / cell));
    if (x1 <= x0 || y1 <= y0) return true;
    const stride = this.columns + 1;
    const table = this.table;
    return table[y1 * stride + x1]! - table[y0 * stride + x1]! - table[y1 * stride + x0]! + table[y0 * stride + x0]! === 0;
  }
}

/**
 * The free place nearest `desired` for the character block and its lane.
 * Both keep off every control and off `text`, the lines of the page's text,
 * and first also off `rows`, the surfaces that fill with rows, whole; a lane
 * beside the character is tried at every height before one above it, and the
 * tallest that fits wins. With no such place the answer is null and the
 * companion collapses: it never takes a place over text by itself. A place
 * the operator asked for is found with no `text` and no `rows`. With
 * `outsideRows` (a request was sent, and its row is on its way into the
 * feed) the rows' surfaces are kept off whole, with no second pass. The answer
 * depends on nothing but the arguments, so one page gives one place.
 * A walk over a 4 px grid, each place read from the summed-area tables of
 * what it must keep off; it runs on a drop or a settled page change, never
 * per frame.
 */
export function placeExpanded(input: {
  viewport: Size; block: Size; obstacles: readonly Rect[]; text?: readonly Rect[]; rows?: readonly Rect[]; outsideRows?: boolean; desired: Point; heights?: readonly number[]; clearance?: number; step?: number;
}): Extract<Placement, { mode: "expanded" }> | null {
  const { viewport, block, obstacles, text = [], rows = [], outsideRows = false, desired, heights = LANE_HEIGHTS, clearance = CONTROL_CLEARANCE, step = 4 } = input;
  const start = clampToViewport(desired, viewport, block);
  const maxX = viewport.width - block.width - VIEWPORT_MARGIN;
  const maxY = viewport.height - block.height - VIEWPORT_MARGIN;
  if (maxX < VIEWPORT_MARGIN || maxY < VIEWPORT_MARGIN) return null;
  const pad = (rects: readonly Rect[]) => rects.map((rect) => inflate(rect, clearance));
  const kept = new Occupancy(viewport, [...pad(obstacles), ...pad(text)]);
  const away = rows.length ? new Occupancy(viewport, pad(rows)) : null;
  /* Candidates nearest first, so the first free one is the answer; the place asked for leads them. */
  const candidates = nearestFirst(start, { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN }, { x: maxX, y: maxY }, step);
  type Free = (x: number, y: number, width: number, height: number) => boolean;
  const outside: Free = (x, y, width, height) => kept.free(x, y, width, height) && (!away || away.free(x, y, width, height));
  const passes: Free[] = away && !outsideRows ? [outside, (x, y, width, height) => kept.free(x, y, width, height)] : [outside];
  const { width, height: tall } = block;
  /* The walk allocates nothing per candidate: the lane is read as numbers, and made an object once it is the answer. */
  const lane = { x: 0, y: 0, height: 0 };
  for (const free of passes) {
    /* Where the character itself may stand, read once for every lane tried. */
    const stands = candidates.filter((point) => free(point.x, point.y, width, tall));
    for (const height of heights) {
      for (const point of stands) {
        sideLane(viewport, point.x, point.y, width, tall, height, lane);
        if (lane.height >= height && free(lane.x, lane.y, BUBBLE_MAX_WIDTH, lane.height)) return { mode: "expanded", at: point, lane: laneLayout(viewport, { ...point, ...block }, height) };
      }
    }
    for (const height of heights) {
      for (const point of stands) {
        /* Lined up with the edge that faces the middle of the screen first. */
        const first: "start" | "end" = point.x + width / 2 < viewport.width / 2 ? "start" : "end";
        for (const align of [first, first === "start" ? "end" : "start"] as const) {
          const x = align === "start" ? point.x : point.x + width - BUBBLE_MAX_WIDTH;
          const y = point.y - LANE_GAP - height;
          if (x < VIEWPORT_MARGIN || x + BUBBLE_MAX_WIDTH > viewport.width - VIEWPORT_MARGIN || y < VIEWPORT_MARGIN || !free(x, y, BUBBLE_MAX_WIDTH, height)) continue;
          return { mode: "expanded", at: point, lane: laneAbove(viewport, { ...point, ...block }, height, align)! };
        }
      }
    }
  }
  return null;
}

/**
 * Whether a box of `size` that travels in a straight line from `from` to `to` meets any of `rects` on the way, its
 * two ends included: the segment against each rectangle grown by the box (a box at `p` meets a rectangle exactly
 * when `p` lies inside that grown rectangle), clipped slab by slab. A box that only touches an edge meets nothing.
 */
export function pathCrosses(from: Point, to: Point, size: Size, rects: readonly Rect[]): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return rects.some((rect) => {
    let enter = 0;
    let leave = 1;
    for (const [start, delta, low, high] of [[from.x, dx, rect.x - size.width, rect.x + rect.width], [from.y, dy, rect.y - size.height, rect.y + rect.height]] as const) {
      if (delta === 0) {
        if (start <= low || start >= high) return false;
        continue;
      }
      const a = (low - start) / delta;
      const b = (high - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
    }
    return enter < leave;
  });
}

/** The height a body that scrolls is cut at: the lowest of its lines' bottoms (`bottoms`, from its top) within
    `room`, so no line shows halved; with room for none, the first line; with no lines, the room itself. */
export function lineCut(bottoms: readonly number[], room: number): number {
  if (!bottoms.length) return room;
  const within = bottoms.filter((bottom) => bottom <= room + 0.5);
  return within.length ? Math.max(...within) : Math.min(...bottoms);
}

/** The free place nearest `desired` for the collapsed shape alone. */
export function placeCollapsed(input: { viewport: Size; size: Size; obstacles: readonly Rect[]; desired: Point; clearance?: number; step?: number }): Point | null {
  const { viewport, size, obstacles, desired, clearance = CONTROL_CLEARANCE, step = 4 } = input;
  const start = clampToViewport(desired, viewport, size);
  const max = { x: viewport.width - size.width - VIEWPORT_MARGIN, y: viewport.height - size.height - VIEWPORT_MARGIN };
  if (max.x < VIEWPORT_MARGIN || max.y < VIEWPORT_MARGIN) return null;
  const kept = new Occupancy(viewport, obstacles.map((obstacle) => inflate(obstacle, clearance)));
  return nearestFree(start, { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN }, max, step, (x, y) => kept.free(x, y, size.width, size.height));
}

/**
 * The first point `nearestFirst` would give that `free` admits, found without ordering the whole grid: the place
 * asked for first, then the grid in square rings around it, each ring read whole, until no point of a further
 * ring can stand nearer than the best one found. The tile is placed as a request goes out, while the hand-off
 * plays, and ordering every point of the viewport for a place asked for once took frames of its own.
 */
export function nearestFree(start: Point, min: Point, max: Point, step: number, free: (x: number, y: number) => boolean): Point | null {
  if (free(start.x, start.y)) return start;
  const columns = Math.floor((max.x - min.x) / step) + 1;
  const rows = Math.floor((max.y - min.y) / step) + 1;
  if (columns <= 0 || rows <= 0) return null;
  const column0 = Math.min(columns - 1, Math.max(0, Math.round((start.x - min.x) / step)));
  const row0 = Math.min(rows - 1, Math.max(0, Math.round((start.y - min.y) / step)));
  const reach = Math.max(column0, columns - 1 - column0, row0, rows - 1 - row0);
  const best = { found: false, x: 0, y: 0, distance: Number.POSITIVE_INFINITY };
  const consider = (column: number, row: number) => {
    if (column < 0 || row < 0 || column >= columns || row >= rows) return;
    const x = min.x + column * step;
    const y = min.y + row * step;
    const distance = (x - start.x) ** 2 + (y - start.y) ** 2;
    /* Ties go the way `nearestFirst` orders them: the smaller row, then the smaller column. */
    if (distance > best.distance || (distance === best.distance && (y > best.y || (y === best.y && x > best.x)))) return;
    if (free(x, y)) Object.assign(best, { found: true, x, y, distance });
  };
  for (let ring = 0; ring <= reach; ring += 1) {
    /* Every point of this ring lies at least (ring - 1) steps from the place asked for, which lies within a step of
       the ring's centre: once that is farther than the best found, nothing further can be nearer. */
    if (best.found && ((ring - 1) * step) ** 2 > best.distance) break;
    for (let column = column0 - ring; column <= column0 + ring; column += 1) { consider(column, row0 - ring); if (ring) consider(column, row0 + ring); }
    for (let row = row0 - ring + 1; row <= row0 + ring - 1; row += 1) { consider(column0 - ring, row); consider(column0 + ring, row); }
  }
  return best.found ? { x: best.x, y: best.y } : null;
}

/* The orders last computed, for the open block and for the collapsed shape: the grid and the place asked for
   change rarely, the page often. */
const ordered = new Map<string, Point[]>();
const ORDERS_KEPT = 4;

/** The grid points between `min` and `max`, `start` first and then by distance from it. */
function nearestFirst(start: Point, min: Point, max: Point, step: number): Point[] {
  const key = [start.x, start.y, min.x, min.y, max.x, max.y, step].join(",");
  const known = ordered.get(key);
  if (known) return known;
  /* Each point as one number, its squared distance from `start` and then its row and its column, sorted as numbers:
     ties go to the lower and then the left one, so the order never depends on the sort. A comparator over the tens
     of thousands of points a viewport holds took frames of its own. Rows and columns are counted from `min`, in
     steps; the distance is below 2^26 on any screen, which leaves the number exact. */
  const columns = Math.floor((max.x - min.x) / step) + 1;
  const rows = Math.floor((max.y - min.y) / step) + 1;
  const keys = new Float64Array(Math.max(0, columns) * Math.max(0, rows));
  let at = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = min.x + column * step;
      const y = min.y + row * step;
      keys[at++] = ((x - start.x) ** 2 + (y - start.y) ** 2) * 2 ** 24 + row * 2 ** 12 + column;
    }
  }
  keys.sort();
  const points: Point[] = [start];
  for (const key of keys) {
    const cell = key % 2 ** 24;
    points.push({ x: min.x + (cell % 2 ** 12) * step, y: min.y + Math.floor(cell / 2 ** 12) * step });
  }
  if (ordered.size >= ORDERS_KEPT) ordered.delete(ordered.keys().next().value!);
  ordered.set(key, points);
  return points;
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
