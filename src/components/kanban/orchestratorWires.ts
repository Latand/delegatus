import { ORCHESTRATOR_WIRE_FADE_MS, ORCHESTRATOR_WIRE_HOLD_MS, type LinkTone, type SeatAction } from "./orchestratorArrows";

/*
 * The orchestrator's wires on the kanban board (docs/design/orchestrator-arrows.md,
 * Variant 2): the seat is the source node, a wire runs down the gutter left of a
 * column and into a port on the card, with rounded corners, and never crosses a
 * card. Its route is the one with the fewest bends, then the shortest, that the
 * board leaves clear (docs/design/orchestrator-wire-routing.md §5). On the phone
 * the gutter is the left margin of the open tab.
 *
 * A wire exists only for a while after the seat acted on its card
 * (`ORCHESTRATOR_WIRE_HOLD_MS`), then fades. With no wire there is no layer:
 * no element, no listener, no observer and no geometry read.
 *
 * A wire is drawn in two pieces (docs/research/orchestrator-wires-hover-scroll.md §3).
 * The seat's piece is the whole route, cut where the column shows. The card's
 * piece is the run down the gutter into the port, inside a box the size of the
 * column's visible part, and that box and the piece in it ride the scrollers
 * that hold the card: a `ScrollTimeline` moves them on the compositor, in the
 * frame the cards move. A scroll moved by script alone reached the card a frame
 * or more late. A script that scrolls from a frame callback moves the scroller
 * after the frame read its timelines; for that frame the rider stands where the
 * scroller is. Without `ScrollTimeline` nothing rides and the wire is redrawn
 * after each scroll, as before.
 *
 * Each piece has a transparent stroke wider than the wire to take the pointer:
 * hovering it names the task, a click, a tap or Enter goes to it. A wire is
 * drawn only inside the part of the board that shows (the boxes that clip the
 * columns), so neither it nor its hit stroke lies over the seat or the app's
 * sidebar once the board scrolls sideways, and no hit stroke covers a column tab.
 */

/** The board's own card flight (`fly()` in KanbanBoard.tsx); a move's wire lands with the card. */
const CARD_FLIGHT_MS = 450;
/** A port closer than this to the column's visible edge is clipped: its card is counted at the edge. */
const PORT_CLEARANCE = 6;
/** A scroller shorter than this has no room for a count (26 px and its margins): the column is out of view. */
const MIN_VIEW = 38;
/** A port beside a folded strip's title stands this far past its last letter, so the dot covers none of it. */
const PORT_GAP = 8;
/** The rounded corner of every bend. */
const CORNER = 6;
/** How far a card's box reaches left of the column over the gutter: the hit stroke's half width past the trunk. */
const GUTTER_REACH = 16;
/** Half the hit stroke's width (`.oa-hit` in kanbanBoard.css). */
const HIT_HALF = 6;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const SVG = "http://www.w3.org/2000/svg";
/** Everything: a clip path is this square with holes cut in it. */
const EVERYWHERE = "M-1e6,-1e6 H1e6 V1e6 H-1e6 Z";
/** Scroll-driven animations carry this id, so the driver can tell them from the pulses and fades. */
export const WIRE_RIDE_ID = "oa-ride";

export interface WiresHost {
  /** The board's root element; the layer is its child. */
  root: HTMLElement;
  phone: boolean;
  /** The pointer or the keyboard is on the wire to this task; `anchor` is where its name goes. `null` when it left. */
  onHover?(taskId: string | null, anchor: Element | null): void;
  /** A click, a tap, Enter or Space on the wire to this task. */
  onJump?(taskId: string): void;
  /** The accessible name of the wire to this task. */
  label?(taskId: string): string;
}

export interface WiresStats { updates: number; totalMs: number; maxMs: number; rectReads: number; wires: number; stubs: number; elements: number }

export interface OrchestratorWires {
  /** The seat acted: show (or restart) the wire of each card. */
  act(actions: readonly SeatAction[]): void;
  /** The tone of each card the seat runs, from the link rule. */
  setTones(tones: ReadonlyMap<string, LinkTone>): void;
  /** The board rendered: cards may have moved. Nothing happens with no wire shown. */
  sync(): void;
  /** Ring the card of this task's wire, as an action's pulse does, once it is in view. */
  ring(taskId: string): void;
  readonly active: boolean;
  destroy(): void;
  /** For the rendered-evidence driver: readings and a clock it can move. */
  readonly probe: {
    stats(reset?: boolean): WiresStats;
    /** Age every wire by `ms`, as if that much of its hold had passed. */
    advance(ms: number): void;
    /** Stop the layer's clock and pause its motion, the pulses at `ms` into them when given. */
    freeze(ms?: number): void;
    /** Run every pulse to its end and let the clock go on. */
    settle(): void;
  };
}

interface Wire {
  taskId: string;
  /** When the seat last acted on the card, from the action's record, on the layer's clock. */
  at: number;
  /** A move waits for the card's own flight. */
  showFrom: number;
  /** The action whose pulse has not played yet. */
  pending: SeatAction | null;
  /** The seat's piece: the whole route, cut where the column shows. */
  group: SVGGElement | null;
  /** The card's piece: the gutter run, the turn and the port, in its column's box. */
  end: SVGGElement | null;
  /** The column whose box holds `end`. */
  column: string | null;
  /** Where its route leaves the seat. */
  exit: string | null;
  /** Ring the card on the next pass. */
  ringNext: boolean;
  /** The ring of the last pulse and what it is drawn round, while it lasts. */
  ring: { node: SVGRectElement; round: HTMLElement } | null;
  /** Everything the last pulse made. A paused pulse never ends by itself, so the wire ends it. */
  pulse: Pulse | null;
  /** The hold is over. The clock ends the wire; `fade` is only what that looks like. */
  fading: boolean;
  fade: Animation[] | null;
}

interface Pulse { nodes: Element[]; motions: Animation[]; paths: SVGPathElement[] }
interface Point { x: number; y: number }
type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;
/* `bounds` is the part of the board that shows: the viewport cut by every box that clips the columns. */
type Spot =
  | { wire: Wire; card: Box; column: Box; node: HTMLElement; view: Box; body: HTMLElement; box: Box; bounds: Box; status: string }
  | { wire: Wire; hidden: "above" | "below"; column: Box; view: Box; bounds: Box; status: string }
  | { wire: Wire; hidden: "away"; status: string | null };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** Reduced motion, or a document that cannot animate: a wire appears and goes without motion. */
function reducedMotion(node: Element): boolean {
  return typeof node.animate !== "function" || (typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches);
}

function escape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

type Axis = "block" | "inline";
type TimelineClass = new (options: { source: Element; axis: Axis }) => AnimationTimeline;
/** Scroll-driven animations (Chromium 115+, Safari 26+); TypeScript's DOM library does not name them yet. */
const scrollTimeline = () => {
  const found = (globalThis as { ScrollTimeline?: unknown }).ScrollTimeline;
  return typeof found === "function" ? (found as TimelineClass) : null;
};

/** One scroller that moves a card, on one axis: how far it can go and where it is. */
interface Scroll { source: Element; axis: Axis; range: number; offset: number }
/** A box moved by one scroller's timeline, so what it holds moves with that scroller's content.
    `keyed` names the keyframes it was last given: the scroller's range, or the offset it is held at. */
interface Rider { source: Element; axis: Axis; keyed: string; node: HTMLDivElement; animation: Animation | null }
/** Riders nested outermost first, and inside them a shift that undoes the offsets read when the
    pieces were drawn: at that moment the riders and the shift cancel out, and from there the riders
    carry the pieces as far as the scrollers go. */
interface Ride { outer: HTMLDivElement; shift: HTMLDivElement; riders: Rider[]; key: string }
/** A column's box: the card's pieces of the wires into it, cut to the column's visible part. */
interface Piece { ride: Ride; clip: HTMLDivElement; origin: HTMLDivElement; inner: Ride; canvas: SVGSVGElement; cut: SVGClipPathElement; box: Box; seen: boolean; scrolls: { outer: Scroll[]; inner: Scroll[] } }

const ids = new WeakMap<Element, number>();
let lastId = 0;
const idOf = (node: Element) => { let id = ids.get(node); if (id === undefined) ids.set(node, id = ++lastId); return id; };
const rideKey = (scrolls: readonly Scroll[]) => scrolls.map((scroll) => `${idOf(scroll.source)}${scroll.axis}`).join(" ");
let layerCount = 0;

/** The boxes the operator can scroll that move `from` (itself among them), innermost first, and on
    which axis. An overflow kept hidden only moves by script, which redraws in its own frame. */
function scrollableOf(from: Element): { source: Element; axis: Axis }[] {
  const out: { source: Element; axis: Axis }[] = [];
  const page = document.scrollingElement;
  for (let node: Element | null = from; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll" || overflow === "overlay" || (node === page && overflow === "visible");
    if (scrolls(style.overflowY)) out.push({ source: node, axis: "block" });
    if (scrolls(style.overflowX)) out.push({ source: node, axis: "inline" });
  }
  return out;
}

/** The length of a wire's path (its moves, runs and rounded corners), without asking the browser,
    which would lay the page out again in the middle of a pass. */
export function pathLength(d: string): number {
  let length = 0;
  let at = { x: 0, y: 0 };
  for (const [, op, args] of d.matchAll(/([MHVQ])\s*([^MHVQ]*)/g)) {
    const n = args!.trim().split(/[\s,]+/).map(Number);
    if (op === "M") at = { x: n[0]!, y: n[1]! };
    else if (op === "H") { length += Math.abs(n[0]! - at.x); at = { x: n[0]!, y: at.y }; }
    else if (op === "V") { length += Math.abs(n[0]! - at.y); at = { x: at.x, y: n[0]! }; }
    else {
      const [cx, cy, x, y] = n as [number, number, number, number];
      let last = at;
      for (let step = 1; step <= 8; step++) {
        const t = step / 8;
        const point = { x: (1 - t) ** 2 * at.x + 2 * (1 - t) * t * cx + t * t * x, y: (1 - t) ** 2 * at.y + 2 * (1 - t) * t * cy + t * t * y };
        length += Math.hypot(point.x - last.x, point.y - last.y);
        last = point;
      }
      at = { x, y };
    }
  }
  return length;
}

function div(attribute: string): HTMLDivElement {
  const node = document.createElement("div");
  node.setAttribute(attribute, "");
  return node;
}

const boxPath = (box: Pick<Box, "left" | "top" | "right" | "bottom">) => `M${box.left},${box.top} H${box.right} V${box.bottom} H${box.left} Z`;
const boxOf = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right: Math.max(left, right), bottom: Math.max(top, bottom), width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
const meet = (a: Box, b: Box) => boxOf(Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
const CLIPS = new Set(["hidden", "clip", "auto", "scroll", "overlay"]);

/** The boxes round `from` (itself among them) that cut off what they hold, and on which axis. The
    document's own overflow is the viewport's. */
function clippingOf(from: Element): { node: Element; x: boolean; y: boolean }[] {
  const out: { node: Element; x: boolean; y: boolean }[] = [];
  for (let node: Element | null = from; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const paint = /paint|strict|content/.test(style.contain ?? "");
    const x = paint || CLIPS.has(style.overflowX), y = paint || CLIPS.has(style.overflowY);
    if (x || y) out.push({ node, x, y });
  }
  return out;
}

export function createOrchestratorWires(host: WiresHost): OrchestratorWires {
  const { root, phone } = host;
  const wires = new Map<string, Wire>();
  let tones: ReadonlyMap<string, LinkTone> = new Map();
  const counters = { updates: 0, totalMs: 0, maxMs: 0, rectReads: 0, wires: 0, stubs: 0 };
  /* Pulses, and the fades apart from them: the driver runs a pulse to its end, never a fade. */
  const motions = new Set<Animation>();
  const fades = new Set<Animation>();

  const uid = `oa-${++layerCount}`;

  /* Everything below exists only while a wire does. */
  let layer: HTMLDivElement | null = null;
  /* What rides the scrollers the seat and the cards share: everything. */
  let top: Ride | null = null;
  let canvas: SVGSVGElement | null = null;
  let defs: SVGDefsElement | null = null;
  /* The cut every hit stroke of the seat's pieces takes: the column tabs and a strip's controls, and
     everything outside the board's visible part. */
  let blocksCut: SVGClipPathElement | null = null;
  /* The cut a count's dashed wire takes: everything outside the board's visible part. */
  let reachCut: SVGClipPathElement | null = null;
  let lines: SVGGElement | null = null;
  let shared: SVGGElement | null = null;
  let marks: HTMLDivElement | null = null;
  /* Where the pointer rests on a wire, for the name's bubble. */
  let pointer: HTMLSpanElement | null = null;
  let resized: ResizeObserver | null = null;
  let motionQuery: MediaQueryList | null = null;
  const pieces = new Map<string, Piece>();
  /* Which boxes scroll, read once and again only after a render or a resize: a scroll changes where
     they stand, never whether they scroll. */
  const scrollable = new Map<Element, { source: Element; axis: Axis }[]>();
  /** The scrollers that move `from` with room to scroll, innermost first, and where each stands now. */
  function scrollersOf(from: Element | null): Scroll[] {
    if (!from) return [];
    let found = scrollable.get(from);
    if (!found) scrollable.set(from, found = scrollableOf(from));
    const out: Scroll[] = [];
    for (const { source, axis } of found) {
      const range = axis === "block" ? source.scrollHeight - source.clientHeight : source.scrollWidth - source.clientWidth;
      if (range > 0) out.push({ source, axis, range, offset: axis === "block" ? source.scrollTop : source.scrollLeft });
    }
    return out;
  }
  /* Which boxes clip the columns, kept as `scrollable` is; and where they stand, read once a pass. */
  const clipping = new Map<Element, { node: Element; x: boolean; y: boolean }[]>();
  const passBounds = new Map<Element, Box>();
  /** The part of the board that shows round `column`: the viewport cut by the boxes that clip it. */
  function boundsOf(column: HTMLElement): Box {
    const from = column.parentElement ?? column;
    let found = passBounds.get(from);
    if (found) return found;
    let list = clipping.get(from);
    if (!list) clipping.set(from, list = clippingOf(from));
    let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
    for (const { node, x, y } of list) {
      const box = rect(node);
      if (x) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (y) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    passBounds.set(from, found = boxOf(left, top, right, bottom));
    return found;
  }
  const stubs = new Map<string, { chip: HTMLElement; wire: SVGPathElement; hit: SVGPathElement; hidden: Wire[]; exit: string; fade: Animation[] | null }>();
  /* The wire or count under the pointer or the keyboard, and what put it there. */
  let hovered: { key: string; hit: Element; focus: boolean } | null = null;
  /* The phone's tab pulses, one a tab. */
  const tabPulses = new Map<string, Animation>();
  /* The seat's ports, one where each route leaves it, and the fade each has once every wire fades. */
  const seatDots: { node: SVGCircleElement; fade: Animation | null }[] = [];
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let offset = 0;
  let frozenAt: number | null = null;

  const now = () => frozenAt ?? Date.now() + offset;
  const rect = (node: Element) => { counters.rectReads += 1; return node.getBoundingClientRect(); };
  const seatNode = () => root.querySelector<HTMLElement>(phone ? "[data-mobile2-seat-card]" : "[data-kanban-seat]");
  const cardNode = (taskId: string) => root.querySelector<HTMLElement>(phone ? `[data-phone-card="task:${escape(taskId)}"]` : `.card[data-id="task:${escape(taskId)}"]`);
  const columnNode = (node: Element) => node.closest<HTMLElement>(phone ? "[data-phone-kanban-column]" : "section.column[data-status]");
  const portY = (card: Box) => card.top + (phone ? 20 : 22);
  const reduced = () => reducedMotion(root);

  function track(animation: Animation, set = motions): Animation {
    set.add(animation);
    const done = () => set.delete(animation);
    animation.finished.then(done, done);
    if (document.hidden) animation.pause();
    return animation;
  }
  /** The fade of a node whose wires' hold ended `elapsed` ms ago. */
  function fadeOut(node: Element, elapsed: number): Animation {
    const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ORCHESTRATOR_WIRE_FADE_MS, easing: "ease-in", fill: "forwards" });
    fade.currentTime = Math.max(0, elapsed);
    if (frozenAt !== null) fade.pause();
    return track(fade, fades);
  }
  const fadedFor = (members: Iterable<Wire>, clock: number) => Math.min(...[...members].map((wire) => clock - (wire.at + ORCHESTRATOR_WIRE_HOLD_MS)));
  function gone(animation: Animation, node: Element) { void animation.finished.then(() => node.remove(), () => node.remove()); }
  /** End a wire's pulse where it is: in a hidden tab it is paused and would otherwise outlive every
      action that follows, one dot and one ring each. */
  function endPulse(wire: Wire) {
    const pulse = wire.pulse;
    if (!pulse) return;
    wire.pulse = null;
    for (const motion of pulse.motions) { motion.cancel(); motions.delete(motion); }
    for (const node of pulse.nodes) node.remove();
    for (const path of pulse.paths) path.style.strokeDasharray = "";
    wire.ring = null;
  }

  /* ── Riding the scrollers ─────────────────────────────────────────────── */
  function makeRide(scrolls: readonly Scroll[]): Ride {
    const shift = div("data-oa-shift");
    const nodes = scrolls.map(() => div("data-oa-ride"));
    nodes.forEach((node, index) => node.append(nodes[index + 1] ?? shift));
    return { outer: nodes[0] ?? shift, shift, key: rideKey(scrolls), riders: scrolls.map((scroll, index) => ({ source: scroll.source, axis: scroll.axis, keyed: "", node: nodes[index]!, animation: null })) };
  }
  const dropRide = (ride: Ride) => { for (const rider of ride.riders) rider.animation?.cancel(); };
  /** Where `rider`'s timeline stands, in pixels of a scroller whose range is `range`: the offset it read
      when this frame began. `null` before it has read one. */
  const timelineAt = (rider: Rider, range: number) => {
    const time = rider.animation?.timeline?.currentTime as { value?: unknown } | number | null | undefined;
    const percent = typeof time === "number" ? time : typeof time?.value === "number" ? time.value : null;
    return percent === null ? null : (percent / 100) * range;
  };
  /** Bring `ride` to these scrollers (outermost first): rebuilt round what it holds when the set
      changed, each rider's keyframes the scroller's range, and the shift the offsets read now. */
  function syncRide(ride: Ride | null, scrolls: readonly Scroll[], place: (outer: HTMLDivElement) => void, x = 0, y = 0): Ride {
    let next = ride;
    if (!next || next.key !== rideKey(scrolls)) {
      next = makeRide(scrolls);
      if (ride) {
        const focused = document.activeElement;
        next.shift.append(...ride.shift.childNodes);
        ride.outer.replaceWith(next.outer);
        dropRide(ride);
        if (focused && focused !== document.activeElement && next.shift.contains(focused)) (focused as HTMLElement).focus?.({ preventScroll: true });
      } else place(next.outer);
    }
    const Timeline = scrollTimeline();
    next.riders.forEach((rider, index) => {
      const { range, offset } = scrolls[index]!;
      if (!Timeline) return;
      /* A script that moved the scroller after this frame read its timelines (from a frame callback)
         leaves the timeline a step behind the offset this pass read. Chromium mostly paints the rider at
         the new offset and now and then at the timeline's, so no shift fits both. Until a frame begins
         with the timeline read again, the rider stands still at the offset this pass read. */
      const read = timelineAt(rider, range);
      const held = read !== null && Math.abs(read - offset) > 0.5;
      const keyed = held ? `at ${offset}` : `${range}`;
      if (rider.keyed === keyed) return;
      rider.keyed = keyed;
      const to = (at: number) => rider.axis === "block" ? `translateY(${-at}px)` : `translateX(${-at}px)`;
      const frames = held ? [{ transform: to(offset) }, { transform: to(offset) }] : [{ transform: "none" }, { transform: to(range) }];
      if (rider.animation?.effect) (rider.animation.effect as KeyframeEffect).setKeyframes(frames);
      else rider.animation = rider.node.animate(frames, { timeline: new Timeline({ source: rider.source, axis: rider.axis }), fill: "both", id: WIRE_RIDE_ID });
    });
    for (const scroll of scrolls) {
      if (scroll.axis === "block") y += scroll.offset;
      else x += scroll.offset;
    }
    const transform = x || y ? `translate(${x}px, ${y}px)` : "";
    if (next.shift.style.transform !== transform) next.shift.style.transform = transform;
    return next;
  }

  function makePiece(): Piece {
    const clip = div("data-oa-clip");
    const origin = div("data-oa-origin");
    const canvas = svg("svg", {});
    const inner = makeRide([]);
    inner.shift.append(canvas);
    origin.append(inner.outer);
    clip.append(origin);
    const ride = makeRide([]);
    ride.shift.append(clip);
    marks!.before(ride.outer);
    const cut = svg("clipPath", { id: `${uid}-cut-${pieces.size}-${idOf(clip)}`, clipPathUnits: "userSpaceOnUse" });
    cut.append(svg("path", { "clip-rule": "evenodd" }));
    defs!.append(cut);
    return { ride, clip, origin, inner, canvas, cut, box: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, seen: true, scrolls: { outer: [], inner: [] } };
  }
  function dropPiece(key: string, piece: Piece) {
    release(piece.ride.outer, null);
    dropRide(piece.ride);
    dropRide(piece.inner);
    piece.ride.outer.remove();
    piece.cut.remove();
    pieces.delete(key);
  }

  /* ── Pointer and keyboard ─────────────────────────────────────────────── */
  /** Focus inside a node about to go returns to the board. */
  function release(node: Element, taskId: string | null) {
    if (!node.contains(document.activeElement)) return;
    const back = root.querySelector<HTMLElement>(".board-frame") ?? (taskId ? cardNode(taskId) : null) ?? root;
    back.focus?.({ preventScroll: true });
  }
  const hitOf = (target: EventTarget | null) => (target as Element | null)?.closest?.("[data-oa-hit]") ?? null;
  /** The task a hit stroke leads to: its wire's, or for a count the hidden card nearest the column's edge. */
  function taskOf(key: string): string | null {
    if (key.startsWith("wire:")) return wires.has(key.slice(5)) ? key.slice(5) : null;
    const stub = stubs.get(key.slice(6));
    if (!stub) return null;
    const above = key.endsWith(":above");
    let best: { taskId: string; edge: number } | null = null;
    for (const wire of stub.hidden) {
      const node = cardNode(wire.taskId);
      if (!node) continue;
      const box = rect(node);
      const edge = above ? -box.bottom : box.top;
      if (!best || edge < best.edge) best = { taskId: wire.taskId, edge };
    }
    return best?.taskId ?? null;
  }
  /** Mark the hovered wire and both its ends, or the hovered count, and dim the rest. */
  function paintHover() {
    if (!layer) return;
    for (const node of layer.querySelectorAll("[data-hover]")) node.removeAttribute("data-hover");
    const key = hovered?.key ?? null;
    layer.toggleAttribute("data-hovering", key !== null);
    if (!key) return;
    let exit: string | null = null;
    if (key.startsWith("wire:")) {
      const wire = wires.get(key.slice(5));
      for (const node of [wire?.group, wire?.end]) node?.setAttribute("data-hover", "");
      exit = wire?.exit ?? null;
    } else {
      const stub = stubs.get(key.slice(6));
      for (const node of [stub?.wire, stub?.chip]) node?.setAttribute("data-hover", "");
      exit = stub?.exit ?? null;
    }
    for (const dot of seatDots) if (dot.node.getAttribute("data-exit") === exit) dot.node.setAttribute("data-hover", "");
  }
  function hover(next: typeof hovered, anchor: Element | null) {
    const was = hovered?.key ?? null;
    hovered = next;
    paintHover();
    const taskId = next ? taskOf(next.key) : null;
    if (taskId || was !== null) host.onHover?.(taskId, taskId ? anchor : null);
  }
  /** A wire or a count that went takes its hover with it. */
  function unhover(key: string) { if (hovered?.key === key) hover(null, null); }
  const onPointerOver = (event: PointerEvent) => {
    const hit = hitOf(event.target);
    const key = hit?.getAttribute("data-oa-hit");
    if (!hit || !key || !marks || !pointer || (hovered?.key === key && hovered.hit === hit)) return;
    const origin = marks.getBoundingClientRect();
    pointer.style.left = `${event.clientX - origin.left}px`;
    pointer.style.top = `${event.clientY - origin.top}px`;
    hover({ key, hit, focus: false }, pointer);
  };
  const onPointerOut = (event: PointerEvent) => {
    const hit = hitOf(event.target);
    if (!hit || hovered?.hit !== hit || hovered.focus || hitOf(event.relatedTarget) === hit) return;
    hover(null, null);
  };
  const onFocusIn = (event: FocusEvent) => {
    const hit = hitOf(event.target);
    const key = hit?.getAttribute("data-oa-hit");
    if (!hit || !key) return;
    const wire = wires.get(key.slice(5));
    hover({ key, hit, focus: true }, wire?.end?.querySelector(".oa-port") ?? hit);
  };
  const onFocusOut = (event: FocusEvent) => { if (hovered?.hit === hitOf(event.target)) hover(null, null); };
  const jump = (hit: Element | null) => {
    const key = hit?.getAttribute("data-oa-hit");
    const taskId = key ? taskOf(key) : null;
    if (taskId) host.onJump?.(taskId);
  };
  const onClick = (event: MouseEvent) => jump(hitOf(event.target));
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const hit = hitOf(event.target);
    if (!hit) return;
    event.preventDefault();
    jump(hit);
  };

  const schedule = () => { if (layer && !frame) frame = window.requestAnimationFrame(() => { frame = 0; update(); }); };
  /* A render or a resize may have changed which boxes scroll or clip. */
  const relayout = () => { scrollable.clear(); clipping.clear(); schedule(); };
  /* Reduced motion switched on while a wire shows: every pulse and fade stops where it is, the wires
     stay still, and a wire whose hold is over goes at once. */
  const onMotionPreference = () => {
    if (!layer) return;
    if (reduced()) {
      for (const motion of [...motions, ...fades]) motion.cancel();
      motions.clear();
      fades.clear();
      for (const wire of wires.values()) { wire.fade = null; endPulse(wire); }
      for (const stub of stubs.values()) stub.fade = null;
      tabPulses.clear();
      for (const dot of seatDots) dot.fade = null;
    }
    expire();
    schedule();
  };
  const onVisibility = () => {
    if (!layer) return;
    layer.toggleAttribute("data-paused", document.hidden);
    for (const motion of [...motions, ...fades]) { if (document.hidden) motion.pause(); else if (motion.playState === "paused") motion.play(); }
    expire();
    schedule();
  };

  function mount() {
    if (layer) return;
    layer = document.createElement("div");
    layer.setAttribute("data-orchestrator-wires", "");
    layer.toggleAttribute("data-paused", document.hidden);
    /* Only the card pieces' hit strokes are for assistive technology: each is a link to its task. */
    canvas = svg("svg", { "aria-hidden": "true" });
    defs = svg("defs", {});
    blocksCut = svg("clipPath", { id: `${uid}-blocks`, clipPathUnits: "userSpaceOnUse" });
    blocksCut.append(svg("path", { "clip-rule": "evenodd", d: EVERYWHERE }));
    reachCut = svg("clipPath", { id: `${uid}-reach`, clipPathUnits: "userSpaceOnUse" });
    reachCut.append(svg("path", { d: EVERYWHERE }));
    defs.append(blocksCut, reachCut);
    lines = svg("g", {});
    shared = svg("g", {});
    canvas.append(defs, lines, shared);
    marks = div("data-oa-marks");
    marks.setAttribute("aria-hidden", "true");
    pointer = document.createElement("span");
    pointer.className = "oa-anchor";
    marks.append(pointer);
    top = makeRide([]);
    top.shift.append(canvas, marks);
    layer.append(top.outer);
    root.append(layer);
    layer.addEventListener("pointerover", onPointerOver);
    layer.addEventListener("pointerout", onPointerOut);
    layer.addEventListener("focusin", onFocusIn);
    layer.addEventListener("focusout", onFocusOut);
    layer.addEventListener("click", onClick);
    layer.addEventListener("keydown", onKey);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", relayout);
    document.addEventListener("visibilitychange", onVisibility);
    motionQuery = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
    motionQuery?.addEventListener?.("change", onMotionPreference);
    /* A seat or a column that changes size moves the cards without a render. */
    if (typeof ResizeObserver === "function") {
      resized = new ResizeObserver(relayout);
      resized.observe(root);
    }
  }

  function unmount() {
    if (!layer) return;
    window.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", relayout);
    document.removeEventListener("visibilitychange", onVisibility);
    motionQuery?.removeEventListener?.("change", onMotionPreference);
    motionQuery = null;
    resized?.disconnect();
    resized = null;
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    for (const motion of [...motions, ...fades]) motion.cancel();
    motions.clear();
    fades.clear();
    tabPulses.clear();
    if (hovered) hover(null, null);
    release(layer, null);
    for (const [key, piece] of pieces) dropPiece(key, piece);
    if (top) dropRide(top);
    layer.remove();
    layer = canvas = defs = blocksCut = reachCut = lines = shared = marks = pointer = top = null;
    seatDots.length = 0;
    stubs.clear();
    scrollable.clear();
    clipping.clear();
    counters.wires = counters.stubs = 0;
  }

  function locate(wire: Wire): Spot {
    const node = cardNode(wire.taskId);
    const column = node ? columnNode(node) : null;
    if (!node || !column) return { wire, hidden: "away", status: null };
    const status = column.dataset.status ?? column.dataset.phoneKanbanColumn ?? "";
    const body = phone ? column : node.closest<HTMLElement>(".col-body");
    const card = rect(node);
    /* A column that is not displayed (a narrow board's other tabs) has no box. */
    if (!card.width || !body) return { wire, hidden: "away", status };
    const view = rect(body);
    const columnRect = phone ? view : rect(column);
    const bounds = boundsOf(column);
    const top = Math.max(view.top, bounds.top);
    const bottom = Math.min(view.bottom, bounds.bottom);
    /* A port the board has scrolled sideways out of view: a wire to it would cross the seat or the sidebar. */
    if (card.left < bounds.left + PORT_CLEARANCE || card.left > bounds.right - 8) return { wire, hidden: "away", status };
    const clip = boxOf(Math.max(columnRect.left, bounds.left), top, Math.min(columnRect.right, bounds.right), bottom);
    /* A port the column has scrolled out of view would be painted over the column's header or past its foot. */
    const port = portY(card);
    /* A scroller with no room for a count shows nothing of the column but its header. */
    if (bottom - top < MIN_VIEW) return { wire, hidden: "away", status };
    if (port > bottom - PORT_CLEARANCE) return { wire, hidden: "below", column: columnRect, view: clip, bounds, status };
    if (port < top + PORT_CLEARANCE) return { wire, hidden: "above", column: columnRect, view: clip, bounds, status };
    return { wire, card, column: columnRect, node, view: clip, body, box: view, bounds, status };
  }

  /** Where a wire leaves the seat for the bus or the margin: its right edge at the bus when the seat
      is at the side, never higher than a corner under its top; the foot of its left edge when it is on
      top and on the phone. */
  function seatPort(seat: Box, side: boolean, columnTop: number): Point {
    if (side) return { x: seat.right, y: Math.max(seat.top + CORNER, Math.min(columnTop - 9, seat.bottom - 12)) };
    return { x: seat.left, y: seat.bottom - Math.min(14, seat.height / 2) };
  }

  /** The seat folded on top and at rest, as the operator sees it: the strip has no fill and no frame
      (kanbanBoard.css, #2148), so the seat is its avatar and title, the port clear of the title's last
      letter, and the strip's other controls stand in a route's way as the column links do. A strip that
      needs the operator, failed or holds an unread reply has its frame back, and its box is the seat. */
  function quietStrip(node: HTMLElement): { seat: Box; blocks: Box[] } | null {
    if (node.dataset.collapsed !== "1" || node.querySelector(".seat-title .state.needs, .seat-title .state.failed, .seat-unread")) return null;
    const head = node.querySelector<HTMLElement>(".seat-head");
    const avatar = head?.querySelector(".av")?.parentElement;
    const title = head?.querySelector<HTMLElement>(".seat-title");
    if (!head || !avatar || !title) return null;
    const [a, t] = [rect(avatar), rect(title)];
    const left = Math.min(a.left, t.left), top = Math.min(a.top, t.top), right = Math.max(a.right, t.right) + PORT_GAP, bottom = Math.max(a.bottom, t.bottom);
    const blocks = [...head.children].filter((child) => child !== avatar && child !== title && !child.classList.contains("grow")).map(rect).filter((box) => box.width > 0 && box.height > 0);
    return { seat: { left, top, right, bottom, width: right - left, height: bottom - top }, blocks };
  }

  /** Whether the straight run from `a` to `b` touches one of `blocks`: the row of column links or tabs
      between a seat on top and the columns. */
  const crosses = (blocks: readonly Box[], a: Point, b: Point) => blocks.some((box) =>
    Math.max(a.x, b.x) >= box.left - 2 && Math.min(a.x, b.x) <= box.right + 2 && Math.max(a.y, b.y) >= box.top - 2 && Math.min(a.y, b.y) <= box.bottom + 2);

  /** The route with the fewest bends that the board leaves clear, then the shortest
      (docs/design/orchestrator-wire-routing.md §5): straight out of a side seat into a card of the
      column beside it; one elbow down the gutter from the bottom of a seat on top that spans it; two out
      of the seat's side that faces the gutter, or along the bus from a side seat; three round the row of
      column links along the bus; four out of the side and round the row's end, or the margin route,
      whichever is shorter, when nothing else is clear. Every route but the
      straight one ends down the column's gutter into the card's port. */
  function route(seat: Box, side: boolean, column: Box, y: number, into: number, leftGutter: number, blocks: readonly Box[]): { d: string; exit: Point; trunk: number | null; turn: string } {
    const routed = routeOnly(seat, side, column, y, into, leftGutter, blocks);
    return routed.d.includes("Q") ? { ...routed, trunk: phone ? column.left + 5 : column.left - 9, turn: routed.d.slice(routed.d.lastIndexOf(" V") + 1) } : { ...routed, trunk: null, turn: "" };
  }
  function routeOnly(seat: Box, side: boolean, column: Box, y: number, into: number, leftGutter: number, blocks: readonly Box[]): { d: string; exit: Point } {
    const r = CORNER;
    const trunk = phone ? column.left + 5 : column.left - 9;
    /* The last corner never runs past the port: on the phone the port is 3.5 px from the gutter. */
    const last = Math.max(1, Math.min(r, into - trunk));
    const turn = `V${y - last} Q${trunk},${y} ${trunk + last},${y} H${into}`;
    const bus = column.top - 9;
    if (side) {
      /* The column beside the seat: nothing stands between them. */
      if (column.left - seat.right <= 24 && y >= seat.top + r && y <= seat.bottom - r) return { d: `M${seat.right},${y} H${into}`, exit: { x: seat.right, y } };
      const port = seatPort(seat, side, column.top);
      if (Math.abs(bus - port.y) <= r) return { d: `M${port.x},${port.y} H${trunk - r} Q${trunk},${port.y} ${trunk},${port.y + r} ${turn}`, exit: port };
      const out = port.x + 10;
      const down = bus > port.y ? 1 : -1;
      return { d: `M${port.x},${port.y} H${out - r} Q${out},${port.y} ${out},${port.y + r * down} V${bus - r * down} Q${out},${bus} ${out + r},${bus} H${trunk - r} Q${trunk},${bus} ${trunk},${bus + r} ${turn}`, exit: port };
    }
    const foot = seat.bottom;
    if (!phone) {
      /* One elbow: the seat spans the gutter, so the wire drops from its bottom edge. */
      if (trunk >= seat.left + r && trunk <= seat.right - r && y - r > foot && !crosses(blocks, { x: trunk, y: foot }, { x: trunk, y })) {
        return { d: `M${trunk},${foot} ${turn}`, exit: { x: trunk, y: foot } };
      }
      /* Two: out of the seat's side that faces the gutter, at its foot. */
      const low = seat.bottom - Math.min(14, seat.height / 2);
      const facing = trunk < seat.left - r ? seat.left : trunk > seat.right + r ? seat.right : null;
      if (facing !== null && y - r > low + r && !crosses(blocks, { x: facing, y: low }, { x: trunk, y: low }) && !crosses(blocks, { x: trunk, y: low }, { x: trunk, y })) {
        const sign = trunk < facing ? -1 : 1;
        return { d: `M${facing},${low} H${trunk - sign * r} Q${trunk},${low} ${trunk},${low + r} ${turn}`, exit: { x: facing, y: low } };
      }
      /* Three: down from the point of the seat's bottom nearest the gutter that clears the links, along the bus under them, down the gutter. */
      if (bus - foot >= 2 * r && y - r > bus + r) {
        const span = (x: number) => Math.min(seat.right - r, Math.max(seat.left + r, x));
        const x = [span(trunk), ...blocks.flatMap((box) => [span(box.right + 2 * r), span(box.left - 2 * r)])]
          .filter((x) => !crosses(blocks, { x, y: foot }, { x, y: bus }) && !crosses(blocks, { x, y: bus }, { x: trunk, y: bus }))
          .sort((a, b) => Math.abs(a - trunk) - Math.abs(b - trunk))[0];
        if (x !== undefined && Math.abs(x - trunk) >= 2 * r) {
          const sign = trunk < x ? -1 : 1;
          return { d: `M${x},${foot} V${bus - r} Q${x},${bus} ${x + sign * r},${bus} H${trunk - sign * r} Q${trunk},${bus} ${trunk},${bus + r} ${turn}`, exit: { x, y: foot } };
        }
      }
    }
    /* The margin route, when a row of tabs spans the board under the seat, and the phone's seat card:
       out of the seat's left edge and down the board's left margin, clear of the row; on the desktop
       then along the bus to the column's own gutter. The phone's left margin is the gutter of its one
       open column. */
    const port = seatPort(seat, side, column.top);
    const spine = phone ? trunk : Math.min(leftGutter, seat.left - 9);
    const dropAt = { x: trunk, y: Math.min(seat.bottom, y - r) };
    const drop = { d: `M${dropAt.x},${dropAt.y} ${turn}`, exit: dropAt };
    if (port.x - spine < r) return drop;
    const start = `M${port.x},${port.y} H${spine + r} Q${spine},${port.y} ${spine},${port.y + r}`;
    if (Math.abs(trunk - spine) < 1) return { d: `${start} ${turn}`, exit: port };
    if (trunk - spine < 2 * r || bus - port.y < 2 * r) return drop;
    /* Four: out of the seat's side, past the end of the row of links, down to the bus under them and
       back along it to the gutter. A folded strip takes it when the row starts under its avatar; it has
       the margin route's bends, so it is drawn only where it is the shorter. */
    if (!phone && y - r > bus + r) {
      const low = seat.bottom - Math.min(14, seat.height / 2);
      const around = blocks.flatMap((box) => [box.right + 2 * r, box.left - 2 * r])
        .filter((x) => (x >= seat.right + r || x <= seat.left - r) && Math.abs(x - trunk) >= 2 * r)
        .map((x) => ({ x, facing: x > seat.right ? seat.right : seat.left }))
        .filter(({ x, facing }) => !crosses(blocks, { x: facing, y: low }, { x, y: low }) && !crosses(blocks, { x, y: low }, { x, y: bus }) && !crosses(blocks, { x, y: bus }, { x: trunk, y: bus }))
        .sort((a, b) => Math.abs(a.x - a.facing) + Math.abs(a.x - trunk) - Math.abs(b.x - b.facing) - Math.abs(b.x - trunk))[0];
      if (around && Math.abs(around.x - around.facing) + Math.abs(around.x - trunk) < port.x - spine + trunk - spine) {
        const { x, facing } = around;
        const out = x > facing ? 1 : -1;
        const back = trunk > x ? 1 : -1;
        return { d: `M${facing},${low} H${x - out * r} Q${x},${low} ${x},${low + r} V${bus - r} Q${x},${bus} ${x + back * r},${bus} H${trunk - back * r} Q${trunk},${bus} ${trunk},${bus + r} ${turn}`, exit: { x: facing, y: low } };
      }
    }
    return { d: `${start} V${bus - r} Q${spine},${bus} ${spine + r},${bus} H${trunk - r} Q${trunk},${bus} ${trunk},${bus + r} ${turn}`, exit: port };
  }

  function update() {
    if (!layer || !top || !canvas || !lines || !shared || !marks || !blocksCut || !reachCut) return;
    const started = performance.now();
    counters.updates += 1;
    const seatElement = seatNode();
    const origin = rect(layer);
    const riding = scrollTimeline() !== null;
    const clock = now();
    const still = reduced();
    let drawn = 0;
    const seenStubs = new Set<string>();
    const counts = new Map<string, { column: Box; view: Box; bounds: Box; above: Wire[]; below: Wire[] }>();
    const side = !phone && seatElement?.dataset.placement === "side";
    const strip = seatElement && !side && !phone ? quietStrip(seatElement) : null;
    const seat = strip?.seat ?? (seatElement ? rect(seatElement) : null);
    /* The column links or tabs, read once a pass. Routes go round them and a quiet strip's controls only
       under a seat on top; the hit strokes are cut at them in every placement, as a 12 px stroke beside
       the row would otherwise take a tab's edge. */
    const tabs = [...root.querySelectorAll<HTMLElement>(phone ? "[data-phone-kanban-tab]" : ".tabs-nav button")].map(rect).filter((box) => box.width > 0);
    const blocks: Box[] = side || phone ? [] : [...tabs, ...(strip?.blocks ?? [])];
    passBounds.clear();
    /* The board's visible part round every column a wire or a count runs into. */
    let reach: Box | null = null;
    /* Inside the layer every coordinate is the viewport's, whatever the board's root is placed by. The
       scrollers that hold the seat and the columns both carry everything; a page scrolled under a seat on
       top moves the whole wire. */
    const firstColumn = riding && seatElement ? root.querySelector(phone ? "[data-phone-kanban-column]" : "section.column[data-status]") : null;
    const common = firstColumn ? scrollersOf(seatElement).filter((scroll) => scroll.source.contains(firstColumn)).reverse() : [];
    const commonKeys = new Set(common.map((scroll) => rideKey([scroll])));
    /* Where the routes leave the seat: wires to one column leave at one point. */
    const exits = new Map<string, Point>();
    const routeTo = (column: Box, bounds: Box, y: number, into: number) => {
      const routed = route(seat!, side, column, y, into, leftGutter(column, bounds), blocks);
      const exit = `${routed.exit.x},${routed.exit.y}`;
      exits.set(exit, routed.exit);
      return { ...routed, exit };
    };
    /* The board's left margin, read once a pass and only for a seat that is not at the side. A first
       column the board has scrolled out of view leaves the margin at the board's visible edge. */
    let margin: number | null = null;
    const leftGutter = (column: Box, bounds: Box) => {
      if (side || phone) return column.left - 9;
      if (margin === null) {
        const first = root.querySelector<HTMLElement>("section.column[data-status]");
        const box = first ? rect(first) : null;
        margin = box && box.width ? box.left - 9 : column.left - 9;
      }
      return Math.min(Math.max(margin, bounds.left + HIT_HALF), column.left - 9);
    };
    /* A column's box rides the scrollers that hold its cards and not the seat; the card's piece in it
       rides the column's own scroll. Read once a pass for each column a wire runs into. */
    for (const piece of pieces.values()) piece.seen = false;
    const pieceOf = (spot: Extract<Spot, { card: Box }>) => {
      let piece = pieces.get(spot.status);
      if (!piece) pieces.set(spot.status, piece = makePiece());
      else if (piece.seen) return piece;
      piece.seen = true;
      /* Read now, written once every card has been read. */
      const chain = riding ? scrollersOf(spot.body) : [];
      piece.scrolls = { outer: chain.filter((scroll) => scroll.source !== spot.body && !commonKeys.has(rideKey([scroll]))).reverse(), inner: chain.filter((scroll) => scroll.source === spot.body) };
      piece.box = meet(boxOf(phone ? spot.box.left : spot.column.left - GUTTER_REACH, spot.box.top, spot.box.right, spot.box.bottom), spot.bounds);
      return piece;
    };

    for (const wire of wires.values()) {
      const spot = seat && clock >= wire.showFrom ? locate(wire) : null;
      if (spot && "bounds" in spot) reach = reach ? boxOf(Math.min(reach.left, spot.bounds.left), Math.min(reach.top, spot.bounds.top), Math.max(reach.right, spot.bounds.right), Math.max(reach.bottom, spot.bounds.bottom)) : spot.bounds;
      if (!spot || "hidden" in spot) {
        wire.group?.remove();
        wire.group = null;
        if (wire.end) { release(wire.end, wire.taskId); wire.end.remove(); }
        wire.end = null;
        wire.column = null;
        unhover(`wire:${wire.taskId}`);
        /* A dot and a ring belong to the wire they ran on. */
        endPulse(wire);
        /* A fade belongs to the group it ran on; a card that comes back into view starts one from the clock. */
        for (const fade of wire.fade ?? []) fade.cancel();
        wire.fade = null;
        if (spot && spot.hidden !== "away") {
          const entry = counts.get(spot.status) ?? { column: spot.column, view: spot.view, bounds: spot.bounds, above: [], below: [] };
          entry[spot.hidden].push(wire);
          counts.set(spot.status, entry);
        }
        if (spot && wire.pending) {
          /* On the phone an action in another tab goes to that tab. */
          if (phone && spot.hidden === "away" && spot.status && !still) pulseTab(spot.status);
          wire.pending = null;
        }
        continue;
      }
      drawn += 1;
      const tone = tones.get(wire.taskId) ?? "idle";
      const port = { x: spot.card.left, y: portY(spot.card) };
      const routed = routeTo(spot.column, spot.bounds, port.y, port.x - 3.5);
      const d = routed.d;
      const piece = pieceOf(spot);
      /* A straight wire from a seat beside the column rides with its card the whole way. */
      if (routed.trunk === null) piece.box = boxOf(Math.max(spot.bounds.left, Math.min(piece.box.left, seat!.right)), piece.box.top, piece.box.right, piece.box.bottom);
      /* The card's piece runs down the gutter from the top of the column's content, so however far the
         column scrolls before the next pass, it reaches the box's top edge. */
      const end = routed.trunk === null ? d : `M${routed.trunk},${Math.min(spot.box.top - spot.body.scrollTop, port.y - CORNER)} ${routed.turn}`;
      let group = wire.group;
      if (!group) {
        group = wire.group = svg("g", { "data-wire": wire.taskId });
        group.append(svg("path", { class: "oa-wire" }), svg("path", { class: "oa-flow" }), svg("path", { class: "oa-hit", "data-oa-hit": `wire:${wire.taskId}`, "clip-path": `url(#${blocksCut.id})` }));
        lines.append(group);
        (group.children[1] as SVGElement).style.animationDelay = `-${Math.round(performance.now() % 700)}ms`;
      }
      let tail = wire.end;
      if (!tail) {
        tail = wire.end = svg("g", { "data-wire-end": wire.taskId });
        tail.append(
          svg("path", { class: "oa-wire", "aria-hidden": "true" }), svg("path", { class: "oa-flow", "aria-hidden": "true" }), svg("circle", { r: 3.5, class: "oa-port", "aria-hidden": "true" }),
          svg("path", { class: "oa-hit", "data-oa-hit": `wire:${wire.taskId}`, tabindex: 0, role: "link" }),
        );
      }
      if (tail.parentNode !== piece.canvas) piece.canvas.append(tail);
      wire.column = spot.status;
      wire.exit = routed.exit;
      group.setAttribute("clip-path", `url(#${piece.cut.id})`);
      if (wire.fading && !wire.fade && !still) wire.fade = [group, tail].map((node) => fadeOut(node, clock - (wire.at + ORCHESTRATOR_WIRE_HOLD_MS)));
      for (const node of [group, tail]) {
        node.dataset.tone = tone;
        node.toggleAttribute("data-flow", tone === "live");
      }
      const [full, flow] = [group.children[0] as SVGPathElement, group.children[1] as SVGPathElement];
      const [own, ownFlow, dot, hit] = [tail.children[0] as SVGPathElement, tail.children[1] as SVGPathElement, tail.children[2]!, tail.children[3]!];
      for (const path of [full, flow, group.children[2]!]) path.setAttribute("d", d);
      for (const path of [own, ownFlow, hit]) path.setAttribute("d", end);
      dot.setAttribute("cx", String(port.x));
      dot.setAttribute("cy", String(port.y));
      const label = host.label?.(wire.taskId);
      if (label && hit.getAttribute("aria-label") !== label) hit.setAttribute("aria-label", label);
      /* A flowing wire's dashes run on across the cut: the card's piece starts its pattern where the
         whole route has it at the same point. */
      if (tone === "live") {
        const extra = pathLength(d) - pathLength(end);
        const delay = parseFloat(flow.style.animationDelay) + (extra * 700) / 24;
        ownFlow.style.animationDelay = `-${Math.round((((-delay) % 700) + 700) % 700)}ms`;
      }
      if (wire.pending) {
        const action = wire.pending;
        wire.pending = null;
        endPulse(wire);
        if (!still) pulse(wire, action, [full, own], d, spot.node, spot.view, piece);
      } else if (wire.ringNext) {
        endPulse(wire);
        if (!still) ringCard(wire, wire.pulse = { nodes: [], motions: [], paths: [] }, spot.node, null, spot.view, piece);
      } else if (wire.ring) {
        /* The ring stays on what it rings while the board scrolls under it, inside the column's visible part. */
        if (wire.ring.node.isConnected && wire.ring.round.isConnected) ringAt(wire.ring.node, rect(wire.ring.round), spot.view);
        else { wire.ring.node.remove(); wire.ring = null; }
      }
      wire.ringNext = false;
    }

    /* Cards the column has scrolled past are counted at its edge, one dashed wire for all of them. */
    for (const [status, entry] of counts) {
      for (const where of ["above", "below"] as const) {
        const hidden = entry[where];
        if (!hidden.length || !seat) continue;
        const key = `${status}:${where}`;
        seenStubs.add(key);
        let stub = stubs.get(key);
        if (!stub) {
          const chip = document.createElement("span");
          chip.className = "oa-stub";
          const wire = svg("path", { class: "oa-wire", "data-stub": "", "clip-path": `url(#${reachCut.id})` });
          const hit = svg("path", { class: "oa-hit", "data-oa-hit": `count:${key}`, "clip-path": `url(#${blocksCut.id})` });
          stub = { chip, wire, hit, hidden, exit: "", fade: null };
          stubs.set(key, stub);
          marks.append(chip);
          shared.append(wire, hit);
        }
        stub.hidden = hidden;
        stub.chip.textContent = `${where === "above" ? "↑" : "↓"} +${hidden.length}`;
        const y = where === "above" ? entry.view.top + 6 : entry.view.bottom - 26;
        const x = entry.column.left + (phone ? 14 : 10);
        stub.chip.style.left = `${Math.round(x)}px`;
        stub.chip.style.top = `${Math.round(y)}px`;
        /* A count fades with the last of the wires it stands for. */
        const fading = hidden.every((wire) => wire.fading);
        if (fading && !stub.fade && !still) stub.fade = [fadeOut(stub.chip, fadedFor(hidden, clock)), fadeOut(stub.wire, fadedFor(hidden, clock))];
        else if (!fading && stub.fade) { for (const fade of stub.fade) fade.cancel(); stub.fade = null; }
        const routed = routeTo(entry.column, entry.bounds, y + 10, x);
        stub.wire.setAttribute("d", routed.d);
        stub.exit = routed.exit;
        /* Its hit stroke stops in the column's padding, short of the cards. */
        stub.hit.setAttribute("d", route(seat, side, entry.column, y + 10, entry.column.left + (phone ? 10 : 3), leftGutter(entry.column, entry.bounds), blocks).d);
        drawn += 1;
      }
    }
    for (const [key, stub] of stubs) if (!seenStubs.has(key)) { stub.chip.remove(); stub.wire.remove(); stub.hit.remove(); stubs.delete(key); unhover(`count:${key}`); }

    /* Each column's box where it shows. The seat's pieces are drawn in the board's visible part (from the
       seat's own edge) outside those boxes, and their hit strokes and the counts' also outside the column
       tabs and a strip's controls. */
    const region = reach && seat ? boxOf(side ? Math.min(reach.left, seat.right) : reach.left, Math.min(reach.top, seat.top), reach.right, reach.bottom) : null;
    const within = region ? boxPath(region) : EVERYWHERE;
    const holes = (side || phone ? tabs : blocks).map((box) => region ? meet(box, region) : box).filter((box) => box.width > 0 && box.height > 0).map(boxPath).join(" ");
    blocksCut.firstElementChild!.setAttribute("d", holes ? `${within} ${holes}` : within);
    reachCut.firstElementChild!.setAttribute("d", within);
    top = syncRide(top, common, () => {}, -origin.left, -origin.top);
    for (const [key, piece] of pieces) {
      if (!piece.seen) { dropPiece(key, piece); continue; }
      piece.ride = syncRide(piece.ride, piece.scrolls.outer, () => {});
      piece.inner = syncRide(piece.inner, piece.scrolls.inner, () => {});
      const { left, top: boxTop, right, bottom } = piece.box;
      Object.assign(piece.clip.style, { left: `${left}px`, top: `${boxTop}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - boxTop)}px` });
      Object.assign(piece.origin.style, { left: `${-left}px`, top: `${-boxTop}px`, width: `${window.innerWidth}px`, height: `${window.innerHeight}px` });
      piece.cut.firstElementChild!.setAttribute("d", `${within} ${boxPath(piece.box)}`);
    }

    /* A port on the seat where each route leaves it; the phone's seat card has none. */
    const ports = seat && drawn && !phone ? [...exits] : [];
    for (const dot of seatDots.splice(ports.length)) { dot.fade?.cancel(); dot.node.remove(); }
    ports.forEach(([key, port], index) => {
      const dot = seatDots[index] ??= { node: shared!.appendChild(svg("circle", { r: 4.5, class: "oa-port", "data-seat": "" })), fade: null };
      dot.node.setAttribute("cx", String(port.x));
      dot.node.setAttribute("cy", String(port.y));
      dot.node.setAttribute("data-exit", key);
    });

    /* The seat's ports fade with the last wire. */
    const allFading = wires.size > 0 && [...wires.values()].every((wire) => wire.fading);
    for (const dot of seatDots) {
      if (allFading && !dot.fade && !still) dot.fade = fadeOut(dot.node, fadedFor(wires.values(), clock));
      else if (dot.fade && !allFading) { dot.fade.cancel(); dot.fade = null; }
    }
    paintHover();

    counters.wires = drawn;
    counters.stubs = seenStubs.size;
    const spent = performance.now() - started;
    counters.totalMs += spent;
    counters.maxMs = Math.max(counters.maxMs, spent);
  }

  /* The variant's pulse: a new lane's wire grows from the seat, a dot runs down the wire, the card (or the lane) is ringed. */
  function ringAt(ring: SVGRectElement, box: Box, clip: Box) {
    const top = Math.max(box.top - 3, clip.top);
    const bottom = Math.min(box.bottom + 3, clip.bottom);
    ring.setAttribute("x", String(box.left - 3));
    ring.setAttribute("y", String(top));
    ring.setAttribute("width", String(box.width + 6));
    ring.setAttribute("height", String(Math.max(0, bottom - top)));
    /* A sliver at the column's edge rings nothing. */
    if (bottom - top < 8) ring.setAttribute("visibility", "hidden");
    else ring.removeAttribute("visibility");
  }

  function pulse(wire: Wire, action: SeatAction, paths: [SVGPathElement, SVGPathElement], d: string, card: HTMLElement, clip: Box, piece: Piece) {
    if (!marks) return;
    const made: Pulse = { nodes: [], motions: [], paths: [] };
    wire.pulse = made;
    const grows = action.kind === "pipeline" || action.kind === "task";
    const [full, own] = paths;
    if (grows && typeof full.getTotalLength === "function") {
      const length = Math.max(1, full.getTotalLength());
      const ownLength = Math.max(1, own.getTotalLength());
      /* The card's piece grows with the whole route: the offset that reveals the route up to a point
         reveals the piece up to the same point, and its gap hides the rest. */
      full.style.strokeDasharray = `${length}`;
      own.style.strokeDasharray = `${ownLength} ${length + ownLength}`;
      made.paths.push(full, own);
      for (const path of paths) {
        const grow = track(path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: 520, easing: "ease-out", fill: "both" }));
        made.motions.push(grow);
        /* A pulse that was ended has cleared the path already, and the path may be growing again. */
        const clear = () => { if (wires.get(wire.taskId)?.pulse === made) { path.style.strokeDasharray = ""; grow.cancel(); } };
        grow.finished.then(clear, clear);
      }
    }
    const dot = document.createElement("span");
    dot.className = "oa-dot";
    dot.style.offsetPath = `path("${d}")`;
    dot.style.offsetRotate = "0deg";
    marks.append(dot);
    const run = track(dot.animate(
      [{ offsetDistance: "0%", opacity: 1 }, { offsetDistance: "100%", opacity: 1, offset: 0.9 }, { offsetDistance: "100%", opacity: 0 }],
      { duration: 820, delay: grows ? 160 : 0, easing: "ease-in-out", fill: "both" },
    ));
    gone(run, dot);
    made.nodes.push(dot);
    made.motions.push(run);
    /* A moved card is ringed by the board as it lands. */
    if (action.kind === "move") return;
    ringCard(wire, made, card, action.pipelineId, clip, piece, 440);
  }

  /** Ring the card, or the lane on it, inside its column's box. */
  function ringCard(wire: Wire, made: Pulse, card: HTMLElement, pipelineId: string | null, clip: Box, piece: Piece, delay = 0) {
    const round = (pipelineId ? card.querySelector<HTMLElement>(`[data-pipeline="${escape(pipelineId)}"]`) : null) ?? card;
    const ring = svg("rect", { rx: 14, class: "oa-ring", "aria-hidden": "true" });
    ringAt(ring, rect(round), clip);
    piece.canvas.append(ring);
    const rings = track(ring.animate(
      [{ opacity: 0, strokeWidth: 8 }, { opacity: 1, strokeWidth: 2, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
      { duration: 2800, delay, easing: "ease-out", fill: "both" },
    ));
    gone(rings, ring);
    made.nodes.push(ring);
    made.motions.push(rings);
    wire.ring = { node: ring, round };
  }

  function pulseTab(status: string) {
    const tab = root.querySelector<HTMLElement>(`[data-phone-kanban-tab="${escape(status)}"]`);
    if (!tab || typeof tab.animate !== "function") return;
    /* One pulse a tab: a paused one is replaced, never added to. */
    const prior = tabPulses.get(status);
    if (prior) { prior.cancel(); motions.delete(prior); }
    tabPulses.set(status, track(tab.animate([{ transform: "none" }, { transform: "scale(1.08)", offset: 0.3 }, { transform: "none" }], { duration: 700, delay: 440 })));
  }

  function drop(wire: Wire) {
    for (const fade of wire.fade ?? []) fade.cancel();
    endPulse(wire);
    wire.group?.remove();
    if (wire.end) { release(wire.end, wire.taskId); wire.end.remove(); }
    wires.delete(wire.taskId);
    unhover(`wire:${wire.taskId}`);
  }

  /** End every wire whose hold and fade are over, start the fade of those whose
      hold is over, and arm the timer for the next change. The clock decides;
      an animation only shows it, so a wire ends whether or not it is painted. */
  function expire() {
    if (timer) clearTimeout(timer);
    timer = null;
    const clock = now();
    const still = reduced() || document.hidden;
    let next = Infinity;
    for (const wire of [...wires.values()]) {
      const until = wire.at + ORCHESTRATOR_WIRE_HOLD_MS;
      if (clock >= until + (still ? 0 : ORCHESTRATOR_WIRE_FADE_MS)) drop(wire);
      else if (clock >= until) { wire.fading = true; next = Math.min(next, until + ORCHESTRATOR_WIRE_FADE_MS); }
      else next = Math.min(next, until, clock < wire.showFrom ? wire.showFrom : Infinity);
    }
    if (!wires.size) return void unmount();
    if (Number.isFinite(next) && frozenAt === null) timer = setTimeout(() => { expire(); update(); }, Math.max(16, next - clock));
  }

  return {
    act(actions) {
      /* With no seat on this board there is nothing to draw a wire from. */
      if (!actions.length || !seatNode()) return;
      const clock = now();
      const still = reduced();
      let fresh = false;
      for (const action of actions) {
        /* The action's own time on the layer's clock: a wire read late has only the rest of its minute. */
        const at = Math.min(clock, action.at + (frozenAt === null ? offset : frozenAt - Date.now()));
        const prior = wires.get(action.taskId);
        if (clock - at >= ORCHESTRATOR_WIRE_HOLD_MS || (prior && prior.at >= at)) continue;
        for (const fade of prior?.fade ?? []) fade.cancel();
        const showFrom = action.kind === "move" && !still && !prior?.group ? clock + CARD_FLIGHT_MS : clock;
        wires.set(action.taskId, {
          taskId: action.taskId, at, showFrom, pending: action, group: prior?.group ?? null, end: prior?.end ?? null, column: prior?.column ?? null, exit: prior?.exit ?? null,
          ringNext: false, ring: prior?.ring ?? null, pulse: prior?.pulse ?? null, fading: false, fade: null,
        });
        fresh = true;
      }
      if (!fresh) return;
      mount();
      expire();
      update();
    },
    setTones(next) { tones = next; schedule(); },
    sync: relayout,
    ring(taskId) {
      const wire = wires.get(taskId);
      if (!wire || reduced()) return;
      wire.ringNext = true;
      schedule();
    },
    get active() { return wires.size > 0; },
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const wire of [...wires.values()]) drop(wire);
      unmount();
    },
    probe: {
      stats(reset = false) {
        const snapshot = { ...counters, elements: layer ? layer.querySelectorAll("*").length : 0 };
        if (reset) Object.assign(counters, { updates: 0, totalMs: 0, maxMs: 0, rectReads: 0 });
        return snapshot;
      },
      advance(ms) {
        if (frozenAt !== null) frozenAt += ms;
        else offset += ms;
        expire();
        update();
      },
      freeze(ms) {
        frozenAt = now();
        if (timer) clearTimeout(timer);
        timer = null;
        for (const motion of motions) { motion.pause(); if (ms !== undefined) motion.currentTime = ms; }
        for (const fade of fades) fade.pause();
        layer?.setAttribute("data-paused", "");
      },
      settle() {
        if (frozenAt !== null) offset = frozenAt - Date.now();
        frozenAt = null;
        for (const motion of [...motions]) { try { motion.finish(); } catch { motion.cancel(); } }
        for (const fade of fades) if (!document.hidden) fade.play();
        layer?.toggleAttribute("data-paused", document.hidden);
        expire();
        update();
      },
    },
  };
}
