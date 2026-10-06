import { ORCHESTRATOR_WIRE_FADE_MS, ORCHESTRATOR_WIRE_HOLD_MS, type LinkTone, type SeatAction } from "./orchestratorArrows";

/*
 * The orchestrator's wires on the kanban board (docs/design/orchestrator-arrows.md,
 * Variant 2): the seat is the source node, a wire runs along the bus above the
 * columns, down the gutter left of a column and into a port on the card, with
 * rounded corners, and never crosses a card. On the phone the gutter is the
 * left margin of the open tab.
 *
 * A wire exists only for a while after the seat acted on its card
 * (`ORCHESTRATOR_WIRE_HOLD_MS`), then fades. With no wire there is no layer:
 * no element, no listener, no observer and no geometry read.
 */

/** The board's own card flight (`fly()` in KanbanBoard.tsx); a move's wire lands with the card. */
const CARD_FLIGHT_MS = 450;
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
  /** When the seat last acted on the card, on this client's clock. */
  at: number;
  /** A move waits for the card's own flight. */
  showFrom: number;
  /** The action whose pulse has not played yet. */
  pending: SeatAction | null;
  group: SVGGElement | null;
  /** The ring of the last pulse and what it is drawn round, while it lasts. */
  ring: { node: SVGRectElement; round: HTMLElement } | null;
  /** The hold is over. The clock ends the wire; `fade` is only what that looks like. */
  fading: boolean;
  fade: Animation | null;
}

interface Point { x: number; y: number }
type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;
type Spot =
  | { wire: Wire; card: Box; column: Box; node: HTMLElement }
  | { wire: Wire; hidden: "above" | "below"; column: Box; view: Box; status: string }
  | { wire: Wire; hidden: "away"; status: string | null };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** Reduced motion, or a document that cannot animate: a wire appears and goes without motion. */
function reducedMotion(node: Element): boolean {
  return typeof node.animate !== "function" || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
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
  let seatFade: Animation | null = null;
  const stubs = new Map<string, { chip: HTMLElement; wire: SVGPathElement; fade: Animation[] | null }>();
  let seatDot: SVGCircleElement | null = null;
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

  const schedule = () => { if (layer && !frame) frame = window.requestAnimationFrame(() => { frame = 0; update(); }); };
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
    resized?.disconnect();
    resized = null;
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    for (const motion of [...motions, ...fades]) motion.cancel();
    motions.clear();
    fades.clear();
    layer.remove();
    layer = canvas = lines = shared = marks = null;
    seatDot = null;
    seatFade = null;
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
    if (card.top + 30 > bottom) return { wire, hidden: "below", column: columnRect, view: clip, status };
    if (card.bottom - 30 < top) return { wire, hidden: "above", column: columnRect, view: clip, status };
    return { wire, card, column: columnRect, node };
  }

  /** Where a wire leaves the seat: its right edge at the bus when the seat is at
      the side, the foot of its left edge when it is on top and on the phone. */
  function seatPort(seat: Box, side: boolean, columnTop: number): Point {
    if (side) return { x: seat.right, y: Math.max(seat.top + 12, Math.min(columnTop - 9, seat.bottom - 12)) };
    return { x: seat.left, y: seat.bottom - Math.min(14, seat.height / 2) };
  }

  /** Out of the seat, along the bus above the columns, down the gutter left of the column, into the card. */
  function gutter(seat: Box, side: boolean, column: Box, y: number, into: number, leftGutter: number): string {
    const r = 6;
    const trunk = phone ? column.left + 5 : column.left - 9;
    const turn = `V${y - r} Q${trunk},${y} ${trunk + r},${y} H${into}`;
    const bus = column.top - 9;
    const port = seatPort(seat, side, column.top);
    if (side) {
      if (Math.abs(bus - port.y) <= r) return `M${port.x},${port.y} H${trunk - r} Q${trunk},${port.y} ${trunk},${port.y + r} ${turn}`;
      const out = port.x + 10;
      const down = bus > port.y ? 1 : -1;
      return `M${port.x},${port.y} H${out - r} Q${out},${port.y} ${out},${port.y + r * down} V${bus - r * down} Q${out},${bus} ${out + r},${bus} H${trunk - r} Q${trunk},${bus} ${trunk},${bus + r} ${turn}`;
    }
    /* The seat on top, and the phone's seat card: out of the seat's left edge
       and down the board's left margin, clear of the row of column links under
       the seat; on the desktop then along the bus to the column's own gutter.
       The phone's left margin is the gutter of its one open column. */
    const spine = phone ? trunk : Math.min(leftGutter, seat.left - 9);
    const drop = `M${trunk},${Math.min(seat.bottom, y - r)} ${turn}`;
    if (port.x - spine < r) return drop;
    const start = `M${port.x},${port.y} H${spine + r} Q${spine},${port.y} ${spine},${port.y + r}`;
    if (Math.abs(trunk - spine) < 1) return `${start} ${turn}`;
    if (trunk - spine < 2 * r || bus - port.y < 2 * r) return drop;
    return `${start} V${bus - r} Q${spine},${bus} ${spine + r},${bus} H${trunk - r} Q${trunk},${bus} ${trunk},${bus + r} ${turn}`;
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
    let columnTop: number | null = null;
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
        wire.ring?.node.remove();
        wire.ring = null;
        /* A fade belongs to the group it ran on; a card that comes back into view starts one from the clock. */
        wire.fade?.cancel();
        wire.fade = null;
        if (spot && spot.hidden !== "away") {
          const entry = counts.get(spot.status) ?? { column: spot.column, view: spot.view, above: [], below: [] };
          entry[spot.hidden].push(wire);
          counts.set(spot.status, entry);
          columnTop ??= spot.column.top;
        }
        if (spot && wire.pending) {
          /* On the phone an action in another tab goes to that tab. */
          if (phone && spot.hidden === "away" && spot.status && !still) pulseTab(spot.status);
          wire.pending = null;
        }
        continue;
      }
      drawn += 1;
      columnTop ??= spot.column.top;
      const tone = tones.get(wire.taskId) ?? "idle";
      const port = { x: spot.card.left, y: portY(spot.card) };
      const d = gutter(seat!, side, spot.column, port.y, port.x - 3.5, leftGutter(spot.column));
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
        wire.ring?.node.remove();
        wire.ring = still ? null : pulse(action, group.children[0] as SVGPathElement, d, spot.node);
      } else if (wire.ring) {
        /* The ring stays on what it rings while the board scrolls under it. */
        if (wire.ring.node.isConnected && wire.ring.round.isConnected) ringAt(wire.ring.node, rect(wire.ring.round));
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
        stub.wire.setAttribute("d", gutter(seat, side, entry.column, y + 10, x, leftGutter(entry.column)));
        drawn += 1;
      }
    }
    for (const [key, stub] of stubs) if (!seenStubs.has(key)) { stub.chip.remove(); stub.wire.remove(); stubs.delete(key); }

    const port = seat && drawn && columnTop !== null && !phone ? seatPort(seat, side, columnTop) : null;
    if (port) {
      if (!seatDot) { seatDot = svg("circle", { r: 4.5, class: "oa-port", "data-seat": "" }); shared.append(seatDot); }
      seatDot.setAttribute("cx", String(port.x));
      seatDot.setAttribute("cy", String(port.y));
    } else { seatDot?.remove(); seatDot = null; }

    /* The seat's port fades with the last wire. */
    const allFading = wires.size > 0 && [...wires.values()].every((wire) => wire.fading);
    if (seatDot && allFading && !seatFade && !still) seatFade = fadeOut(seatDot, fadedFor(wires.values(), clock));
    else if (seatFade && (!allFading || !seatDot)) { seatFade.cancel(); seatFade = null; }

    counters.wires = drawn;
    counters.stubs = seenStubs.size;
    const spent = performance.now() - started;
    counters.totalMs += spent;
    counters.maxMs = Math.max(counters.maxMs, spent);
  }

  /* The variant's pulse: a new lane's wire grows from the seat, a dot runs down the wire, the card (or the lane) is ringed. */
  function ringAt(ring: SVGRectElement, box: Box) {
    ring.setAttribute("x", String(box.left - 3));
    ring.setAttribute("y", String(box.top - 3));
    ring.setAttribute("width", String(box.width + 6));
    ring.setAttribute("height", String(box.height + 6));
  }

  function pulse(action: SeatAction, path: SVGPathElement, d: string, card: HTMLElement): Wire["ring"] {
    if (!marks || !shared) return null;
    const grows = action.kind === "pipeline" || action.kind === "task";
    if (grows && typeof path.getTotalLength === "function") {
      const length = Math.max(1, path.getTotalLength());
      path.style.strokeDasharray = `${length}`;
      const grow = track(path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: 520, easing: "ease-out", fill: "both" }));
      const clear = () => { path.style.strokeDasharray = ""; grow.cancel(); };
      grow.finished.then(clear, clear);
    }
    const dot = document.createElement("span");
    dot.className = "oa-dot";
    dot.style.offsetPath = `path("${d}")`;
    dot.style.offsetRotate = "0deg";
    marks.append(dot);
    gone(track(dot.animate(
      [{ offsetDistance: "0%", opacity: 1 }, { offsetDistance: "100%", opacity: 1, offset: 0.9 }, { offsetDistance: "100%", opacity: 0 }],
      { duration: 820, delay: grows ? 160 : 0, easing: "ease-in-out", fill: "both" },
    )), dot);
    /* A moved card is ringed by the board as it lands. */
    if (action.kind === "move") return null;
    const round = (action.pipelineId ? card.querySelector<HTMLElement>(`[data-pipeline="${escape(action.pipelineId)}"]`) : null) ?? card;
    const ring = svg("rect", { rx: 14, class: "oa-ring" });
    ringAt(ring, rect(round));
    shared.before(ring);
    gone(track(ring.animate(
      [{ opacity: 0, strokeWidth: 8 }, { opacity: 1, strokeWidth: 2, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
      { duration: 2800, delay: 440, easing: "ease-out", fill: "both" },
    )), ring);
    return { node: ring, round };
  }

  function pulseTab(status: string) {
    const tab = root.querySelector<HTMLElement>(`[data-phone-kanban-tab="${escape(status)}"]`);
    if (tab && typeof tab.animate === "function") track(tab.animate([{ transform: "none" }, { transform: "scale(1.08)", offset: 0.3 }, { transform: "none" }], { duration: 700, delay: 440 }));
  }

  function drop(wire: Wire) {
    wire.fade?.cancel();
    wire.group?.remove();
    wire.ring?.node.remove();
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
      for (const action of actions) {
        const prior = wires.get(action.taskId);
        prior?.fade?.cancel();
        const showFrom = action.kind === "move" && !still && !prior?.group ? clock + CARD_FLIGHT_MS : clock;
        wires.set(action.taskId, { taskId: action.taskId, at: clock, showFrom, pending: action, group: prior?.group ?? null, ring: prior?.ring ?? null, fading: false, fade: null });
      }
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
