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
 */

/** The board's own card flight (`fly()` in KanbanBoard.tsx); a move's wire lands with the card. */
const CARD_FLIGHT_MS = 450;
/** A port closer than this to the column's visible edge is clipped: its card is counted at the edge. */
const PORT_CLEARANCE = 6;
/** A scroller shorter than this has no room for a count (26 px and its margins): the column is out of view. */
const MIN_VIEW = 38;
/** The rounded corner of every bend. */
const CORNER = 6;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const SVG = "http://www.w3.org/2000/svg";

export interface WiresHost {
  /** The board's root element; the layer is its child. */
  root: HTMLElement;
  phone: boolean;
}

export interface WiresStats { updates: number; totalMs: number; maxMs: number; rectReads: number; wires: number; stubs: number; elements: number }

export interface OrchestratorWires {
  /** The seat acted: show (or restart) the wire of each card. */
  act(actions: readonly SeatAction[]): void;
  /** The tone of each card the seat runs, from the link rule. */
  setTones(tones: ReadonlyMap<string, LinkTone>): void;
  /** The board rendered: cards may have moved. Nothing happens with no wire shown. */
  sync(): void;
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
  group: SVGGElement | null;
  /** The ring of the last pulse and what it is drawn round, while it lasts. */
  ring: { node: SVGRectElement; round: HTMLElement } | null;
  /** Everything the last pulse made. A paused pulse never ends by itself, so the wire ends it. */
  pulse: Pulse | null;
  /** The hold is over. The clock ends the wire; `fade` is only what that looks like. */
  fading: boolean;
  fade: Animation | null;
}

interface Pulse { nodes: Element[]; motions: Animation[]; path: SVGPathElement }
interface Point { x: number; y: number }
type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;
type Spot =
  | { wire: Wire; card: Box; column: Box; node: HTMLElement; view: Box }
  | { wire: Wire; hidden: "above" | "below"; column: Box; view: Box; status: string }
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

export function createOrchestratorWires(host: WiresHost): OrchestratorWires {
  const { root, phone } = host;
  const wires = new Map<string, Wire>();
  let tones: ReadonlyMap<string, LinkTone> = new Map();
  const counters = { updates: 0, totalMs: 0, maxMs: 0, rectReads: 0, wires: 0, stubs: 0 };
  /* Pulses, and the fades apart from them: the driver runs a pulse to its end, never a fade. */
  const motions = new Set<Animation>();
  const fades = new Set<Animation>();

  /* Everything below exists only while a wire does. */
  let layer: HTMLDivElement | null = null;
  let canvas: SVGSVGElement | null = null;
  let lines: SVGGElement | null = null;
  let shared: SVGGElement | null = null;
  let marks: HTMLDivElement | null = null;
  let resized: ResizeObserver | null = null;
  let motionQuery: MediaQueryList | null = null;
  const stubs = new Map<string, { chip: HTMLElement; wire: SVGPathElement; fade: Animation[] | null }>();
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
    pulse.path.style.strokeDasharray = "";
    wire.ring = null;
  }

  const schedule = () => { if (layer && !frame) frame = window.requestAnimationFrame(() => { frame = 0; update(); }); };
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
    layer.setAttribute("aria-hidden", "true");
    layer.toggleAttribute("data-paused", document.hidden);
    canvas = svg("svg", {});
    lines = svg("g", {});
    shared = svg("g", {});
    canvas.append(lines, shared);
    marks = document.createElement("div");
    layer.append(canvas, marks);
    root.append(layer);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", onVisibility);
    motionQuery = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
    motionQuery?.addEventListener?.("change", onMotionPreference);
    /* A seat or a column that changes size moves the cards without a render. */
    if (typeof ResizeObserver === "function") {
      resized = new ResizeObserver(schedule);
      resized.observe(root);
    }
  }

  function unmount() {
    if (!layer) return;
    window.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule);
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
    layer.remove();
    layer = canvas = lines = shared = marks = null;
    seatDots.length = 0;
    stubs.clear();
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
    const top = Math.max(view.top, 0);
    const bottom = Math.min(view.bottom, window.innerHeight);
    if (card.right < 0 || card.left > window.innerWidth - 8 || view.right < 8 || view.left > window.innerWidth - 8) return { wire, hidden: "away", status };
    const clip: Box = { left: columnRect.left, right: columnRect.right, width: columnRect.width, top, bottom, height: bottom - top };
    /* A port the column has scrolled out of view would be painted over the column's header or past its foot. */
    const port = portY(card);
    /* A scroller with no room for a count shows nothing of the column but its header. */
    if (bottom - top < MIN_VIEW) return { wire, hidden: "away", status };
    if (port > bottom - PORT_CLEARANCE) return { wire, hidden: "below", column: columnRect, view: clip, status };
    if (port < top + PORT_CLEARANCE) return { wire, hidden: "above", column: columnRect, view: clip, status };
    return { wire, card, column: columnRect, node, view: clip };
  }

  /** Where a wire leaves the seat for the bus or the margin: its right edge at the bus when the seat
      is at the side, never higher than a corner under its top; the foot of its left edge when it is on
      top and on the phone. */
  function seatPort(seat: Box, side: boolean, columnTop: number): Point {
    if (side) return { x: seat.right, y: Math.max(seat.top + CORNER, Math.min(columnTop - 9, seat.bottom - 12)) };
    return { x: seat.left, y: seat.bottom - Math.min(14, seat.height / 2) };
  }

  /** Whether the straight run from `a` to `b` touches one of `blocks`: the row of column links or tabs
      between a seat on top and the columns. */
  const crosses = (blocks: readonly Box[], a: Point, b: Point) => blocks.some((box) =>
    Math.max(a.x, b.x) >= box.left - 2 && Math.min(a.x, b.x) <= box.right + 2 && Math.max(a.y, b.y) >= box.top - 2 && Math.min(a.y, b.y) <= box.bottom + 2);

  /** The route with the fewest bends that the board leaves clear, then the shortest
      (docs/design/orchestrator-wire-routing.md §5): straight out of a side seat into a card of the
      column beside it; one elbow down the gutter from the bottom of a seat on top that spans it; two out
      of the seat's side that faces the gutter, or along the bus from a side seat; three round the row of
      column links along the bus; and the margin route when nothing else is clear. Every route but the
      straight one ends down the column's gutter into the card's port. */
  function route(seat: Box, side: boolean, column: Box, y: number, into: number, leftGutter: number, blocks: readonly Box[]): { d: string; exit: Point } {
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
    return { d: `${start} V${bus - r} Q${spine},${bus} ${spine + r},${bus} H${trunk - r} Q${trunk},${bus} ${trunk},${bus + r} ${turn}`, exit: port };
  }

  function update() {
    if (!layer || !canvas || !lines || !shared || !marks) return;
    const started = performance.now();
    counters.updates += 1;
    const seatElement = seatNode();
    const origin = rect(layer);
    /* Inside the layer every coordinate is the viewport's, whatever the board's root is placed by. */
    canvas.style.transform = marks.style.transform = origin.left || origin.top ? `translate(${-origin.left}px, ${-origin.top}px)` : "";
    const clock = now();
    const still = reduced();
    let drawn = 0;
    const seenStubs = new Set<string>();
    const counts = new Map<string, { column: Box; view: Box; above: Wire[]; below: Wire[] }>();
    const seat = seatElement ? rect(seatElement) : null;
    const side = !phone && seatElement?.dataset.placement === "side";
    /* The row of column links or tabs a seat on top stands above, read once a pass. */
    const blocks: Box[] = side || phone ? [] : [...root.querySelectorAll<HTMLElement>(".tabs-nav button")].map(rect).filter((box) => box.width > 0);
    /* Where the routes leave the seat: wires to one column leave at one point. */
    const exits = new Map<string, Point>();
    const routeTo = (column: Box, y: number, into: number) => {
      const routed = route(seat!, side, column, y, into, leftGutter(column), blocks);
      exits.set(`${routed.exit.x},${routed.exit.y}`, routed.exit);
      return routed.d;
    };
    /* The board's left margin, read once a pass and only for a seat that is not at the side. */
    let margin: number | null = null;
    const leftGutter = (column: Box) => {
      if (side || phone) return column.left - 9;
      if (margin === null) {
        const first = root.querySelector<HTMLElement>("section.column[data-status]");
        const box = first ? rect(first) : null;
        margin = box && box.width ? box.left - 9 : column.left - 9;
      }
      return Math.min(margin, column.left - 9);
    };

    for (const wire of wires.values()) {
      const spot = seat && clock >= wire.showFrom ? locate(wire) : null;
      if (!spot || "hidden" in spot) {
        wire.group?.remove();
        wire.group = null;
        /* A dot and a ring belong to the wire they ran on. */
        endPulse(wire);
        /* A fade belongs to the group it ran on; a card that comes back into view starts one from the clock. */
        wire.fade?.cancel();
        wire.fade = null;
        if (spot && spot.hidden !== "away") {
          const entry = counts.get(spot.status) ?? { column: spot.column, view: spot.view, above: [], below: [] };
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
      const d = routeTo(spot.column, port.y, port.x - 3.5);
      let group = wire.group;
      if (!group) {
        group = wire.group = svg("g", { "data-wire": wire.taskId });
        group.append(svg("path", { class: "oa-wire" }), svg("path", { class: "oa-flow" }), svg("circle", { r: 3.5, class: "oa-port" }));
        lines.append(group);
        (group.children[1] as SVGElement).style.animationDelay = `-${Math.round(performance.now() % 700)}ms`;
      }
      if (wire.fading && !wire.fade && !still) wire.fade = fadeOut(group, clock - (wire.at + ORCHESTRATOR_WIRE_HOLD_MS));
      group.dataset.tone = tone;
      group.toggleAttribute("data-flow", tone === "live");
      group.children[0]!.setAttribute("d", d);
      group.children[1]!.setAttribute("d", d);
      group.children[2]!.setAttribute("cx", String(port.x));
      group.children[2]!.setAttribute("cy", String(port.y));
      if (wire.pending) {
        const action = wire.pending;
        wire.pending = null;
        endPulse(wire);
        if (!still) pulse(wire, action, group.children[0] as SVGPathElement, d, spot.node, spot.view);
      } else if (wire.ring) {
        /* The ring stays on what it rings while the board scrolls under it, inside the column's visible part. */
        if (wire.ring.node.isConnected && wire.ring.round.isConnected) ringAt(wire.ring.node, rect(wire.ring.round), spot.view);
        else { wire.ring.node.remove(); wire.ring = null; }
      }
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
          const wire = svg("path", { class: "oa-wire", "data-stub": "" });
          stub = { chip, wire, fade: null };
          stubs.set(key, stub);
          marks.append(chip);
          shared.append(wire);
        }
        stub.chip.textContent = `${where === "above" ? "↑" : "↓"} +${hidden.length}`;
        const y = where === "above" ? entry.view.top + 6 : entry.view.bottom - 26;
        const x = entry.column.left + (phone ? 14 : 10);
        stub.chip.style.left = `${Math.round(x)}px`;
        stub.chip.style.top = `${Math.round(y)}px`;
        /* A count fades with the last of the wires it stands for. */
        const fading = hidden.every((wire) => wire.fading);
        if (fading && !stub.fade && !still) stub.fade = [fadeOut(stub.chip, fadedFor(hidden, clock)), fadeOut(stub.wire, fadedFor(hidden, clock))];
        else if (!fading && stub.fade) { for (const fade of stub.fade) fade.cancel(); stub.fade = null; }
        stub.wire.setAttribute("d", routeTo(entry.column, y + 10, x));
        drawn += 1;
      }
    }
    for (const [key, stub] of stubs) if (!seenStubs.has(key)) { stub.chip.remove(); stub.wire.remove(); stubs.delete(key); }

    /* A port on the seat where each route leaves it; the phone's seat card has none. */
    const ports = seat && drawn && !phone ? [...exits.values()] : [];
    for (const dot of seatDots.splice(ports.length)) { dot.fade?.cancel(); dot.node.remove(); }
    ports.forEach((port, index) => {
      const dot = seatDots[index] ??= { node: shared!.appendChild(svg("circle", { r: 4.5, class: "oa-port", "data-seat": "" })), fade: null };
      dot.node.setAttribute("cx", String(port.x));
      dot.node.setAttribute("cy", String(port.y));
    });

    /* The seat's ports fade with the last wire. */
    const allFading = wires.size > 0 && [...wires.values()].every((wire) => wire.fading);
    for (const dot of seatDots) {
      if (allFading && !dot.fade && !still) dot.fade = fadeOut(dot.node, fadedFor(wires.values(), clock));
      else if (dot.fade && !allFading) { dot.fade.cancel(); dot.fade = null; }
    }

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

  function pulse(wire: Wire, action: SeatAction, path: SVGPathElement, d: string, card: HTMLElement, clip: Box) {
    if (!marks || !shared) return;
    const made: Pulse = { nodes: [], motions: [], path };
    wire.pulse = made;
    const grows = action.kind === "pipeline" || action.kind === "task";
    if (grows && typeof path.getTotalLength === "function") {
      const length = Math.max(1, path.getTotalLength());
      path.style.strokeDasharray = `${length}`;
      const grow = track(path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: 520, easing: "ease-out", fill: "both" }));
      made.motions.push(grow);
      /* A pulse that was ended has cleared the path already, and the path may be growing again. */
      const clear = () => { if (wires.get(wire.taskId)?.pulse === made) { path.style.strokeDasharray = ""; grow.cancel(); } };
      grow.finished.then(clear, clear);
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
    const round = (action.pipelineId ? card.querySelector<HTMLElement>(`[data-pipeline="${escape(action.pipelineId)}"]`) : null) ?? card;
    const ring = svg("rect", { rx: 14, class: "oa-ring" });
    ringAt(ring, rect(round), clip);
    shared.before(ring);
    const rings = track(ring.animate(
      [{ opacity: 0, strokeWidth: 8 }, { opacity: 1, strokeWidth: 2, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
      { duration: 2800, delay: 440, easing: "ease-out", fill: "both" },
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
    wire.fade?.cancel();
    endPulse(wire);
    wire.group?.remove();
    wires.delete(wire.taskId);
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
        prior?.fade?.cancel();
        const showFrom = action.kind === "move" && !still && !prior?.group ? clock + CARD_FLIGHT_MS : clock;
        wires.set(action.taskId, { taskId: action.taskId, at, showFrom, pending: action, group: prior?.group ?? null, ring: prior?.ring ?? null, pulse: prior?.pulse ?? null, fading: false, fade: null });
        fresh = true;
      }
      if (!fresh) return;
      mount();
      expire();
      update();
    },
    setTones(next) { tones = next; schedule(); },
    sync: schedule,
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
