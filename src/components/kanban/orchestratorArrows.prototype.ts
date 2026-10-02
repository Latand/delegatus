import { translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * Design prototype, not product code (docs/design/orchestrator-arrows.md).
 *
 * Three ways to draw the orchestrator's links to the tasks it runs and to
 * animate what it does, laid over the real board as one fixed layer. Only the
 * kanban evidence fixture mounts it (`?scenario=orchestrator-arrows&arrows=N`),
 * and the kanban browser driver photographs it. The link model at the top is
 * the part a product slice would keep; the overlay below reads the board's
 * DOM, which a product slice would replace with the board's own card refs.
 *
 *   1  On demand: no wires at rest, a port on each card the seat runs; hover
 *      or focus the seat (or a card) and curved arrows fan out from it.
 *   2  Live graph: the seat at the side, wires always drawn along the column
 *      gutters to a port on each card, running lanes flowing.
 *   3  Action trails: nothing at rest; each action draws a one-shot arc from
 *      the seat and leaves an entry in an operations line beside the seat.
 */

export type ArrowVariant = 1 | 2 | 3;
export type LinkTone = "live" | "needs" | "idle";

/** One card the seat runs, and why: a lane it made, or an agent it spawned. */
export interface OrchestratorLink {
  taskId: string;
  via: "pipeline" | "spawn";
  pipelineId: string | null;
  tone: LinkTone;
}

const TONE_RANK: Record<LinkTone, number> = { idle: 0, live: 1, needs: 2 };

function pipelineTone(state: Pipeline["state"]): LinkTone {
  if (state === "needs_decision" || state === "needs_review") return "needs";
  if (state === "running" || state === "provisioning") return "live";
  return "idle";
}

/**
 * The cards the seat runs, from records `/api/files` already carries: a lane
 * whose `srcConversationId` (or the deputy that made it for the seat) is a seat
 * conversation, and a conversation on the task whose durable lineage names a
 * seat conversation as its parent. Done tasks are left out. One link per task,
 * the most urgent tone winning, a lane before a spawn at equal tone.
 */
export function orchestratorLinks(input: {
  seatConversationIds: readonly (string | null | undefined)[];
  pipelines: readonly Pipeline[];
  tasks: readonly BoardTask[];
  files: readonly FileEntry[];
}): OrchestratorLink[] {
  const seat = new Set(input.seatConversationIds.filter((id): id is string => !!id));
  if (!seat.size) return [];
  const open = new Map(input.tasks.filter((task) => task.status !== "done").map((task) => [task.id, task] as const));
  const links = new Map<string, OrchestratorLink>();
  const offer = (link: OrchestratorLink) => {
    const prior = links.get(link.taskId);
    const rank = TONE_RANK[link.tone] - (prior ? TONE_RANK[prior.tone] : -1);
    if (rank > 0 || (rank === 0 && prior?.via === "spawn" && link.via === "pipeline")) links.set(link.taskId, link);
  };
  for (const pipeline of input.pipelines) {
    if (pipeline.hiddenAt || pipeline.state === "closed" || pipeline.state === "draft") continue;
    if (!seat.has(pipeline.srcConversationId ?? "") && !seat.has(pipeline.srcDeputyConversationId ?? "")) continue;
    for (const taskId of pipeline.taskIds ?? []) {
      if (open.has(taskId)) offer({ taskId, via: "pipeline", pipelineId: pipeline.id, tone: pipelineTone(pipeline.state) });
    }
  }
  const byId = new Map<string, FileEntry>();
  const byPath = new Map<string, FileEntry>();
  for (const file of input.files) {
    if (!seat.has(file.durableLineage?.parentConversationId ?? "")) continue;
    if (file.conversationId) byId.set(file.conversationId, file);
    byPath.set(file.path, file);
  }
  for (const task of open.values()) {
    for (const assignment of task.assignments) {
      const file = (assignment.conversationId ? byId.get(assignment.conversationId) : undefined) ?? (assignment.path ? byPath.get(assignment.path) : undefined);
      if (!file) continue;
      const tone: LinkTone = file.waitingInput || file.pendingQuestion ? "needs" : file.activity === "live" ? "live" : "idle";
      offer({ taskId: task.id, via: "spawn", pipelineId: null, tone });
    }
  }
  return [...links.values()];
}

/* ── The overlay ─────────────────────────────────────────────────────────── */

export type OrchestratorAction =
  | { kind: "move"; taskId: string; from: TaskStatus; to: TaskStatus; before: DOMRect | null }
  | { kind: "pipeline"; taskId: string; pipelineId: string }
  | { kind: "stage"; taskId: string; pipelineId: string; stage: string };

export interface ArrowsOverlay {
  setLinks(links: OrchestratorLink[]): void;
  /** Draw `action`; resolves when its motion has finished. */
  play(action: OrchestratorAction): Promise<void>;
  /** Pause every motion this layer started at `ms` into it (the driver's frames). */
  freeze(ms: number): void;
  /** Run every motion this layer started to its end. */
  settle(): void;
  /** What the layer's own geometry passes cost since the last reset. */
  stats(reset?: boolean): { updates: number; totalMs: number; maxMs: number; rectReads: number; wires: number; stubs: number };
  destroy(): void;
}

type Locale = "en" | "uk";
const TEXT: Record<Locale, Record<string, string>> = {
  en: {
    moved: "Orchestrator: {from} → {to}",
    pipeline: "Orchestrator started a pipeline",
    stage: "Orchestrator launched {stage}",
    more: "+{count}",
    feedMoved: "moved «{title}» to {to}",
    feedPipeline: "started a pipeline on «{title}»",
    feedStage: "launched {stage} on «{title}»",
    now: "now",
  },
  uk: {
    moved: "Оркестратор: {from} → {to}",
    pipeline: "Оркестратор запустив пайплайн",
    stage: "Оркестратор запустив {stage}",
    more: "+{count}",
    feedMoved: "переніс «{title}» у {to}",
    feedPipeline: "запустив пайплайн на «{title}»",
    feedStage: "запустив {stage} на «{title}»",
    now: "щойно",
  },
};

const SVG = "http://www.w3.org/2000/svg";
/* Only the board's own tokens. A wire is the board's pipeline edge (`.pedge`):
   dashed is drawn-but-not-travelled, solid is a link, and a live link flows
   the way `.pedge.live` does (`kb-edge-flow`). */
const STYLE = `
[data-oa-layer]{position:fixed;inset:0;z-index:40;pointer-events:none}
[data-oa-layer] svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.oa-wire{fill:none;stroke:var(--color-accent);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.oa-wire[data-tone=idle]{stroke:color-mix(in srgb,var(--color-muted) 55%,transparent)}
.oa-wire[data-tone=needs]{stroke:var(--color-warning)}
.oa-wire[data-stub]{stroke-dasharray:5 4}
.oa-flow{fill:none;stroke:var(--color-accent);stroke-width:2.25;stroke-linecap:round;stroke-dasharray:7 5;animation:oa-flow 700ms linear infinite}
@keyframes oa-flow{to{stroke-dashoffset:-24}}
.oa-port{fill:var(--color-card);stroke:var(--color-accent);stroke-width:1.5}
.oa-port[data-tone=idle]{stroke:color-mix(in srgb,var(--color-muted) 55%,transparent)}
.oa-port[data-tone=needs]{stroke:var(--color-warning);fill:var(--color-warning-soft)}
.oa-port[data-seat]{fill:var(--color-accent)}
.oa-head{fill:var(--color-accent)}
.oa-ring{fill:none;stroke:color-mix(in srgb,var(--color-accent) 60%,transparent);stroke-width:2}
.oa-ghost{fill:none;stroke:var(--border-strong);stroke-width:1.5;stroke-dasharray:5 4}
.oa-chip{position:absolute;white-space:nowrap;padding:2px 8px;border-radius:var(--radius-control);background:var(--color-raised);border:1px solid color-mix(in srgb,var(--color-accent) 35%,var(--border-default));box-shadow:var(--shadow-2);font:600 var(--text-label)/1.5 var(--font-sans);color:var(--color-accent)}
.oa-stub{position:absolute;padding:0 6px;border-radius:var(--radius-control);background:var(--surface-card);border:1px solid var(--border-default);font:700 var(--text-caption)/18px var(--font-sans);color:var(--color-secondary)}
.oa-dot{position:absolute;left:0;top:0;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--color-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--color-accent) 22%,transparent)}
.oa-feed{position:absolute;display:flex;gap:6px;align-items:center;overflow:hidden;pointer-events:auto}
.oa-feed[data-phone]{background:var(--color-card)}
.oa-feed button{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 8px;border-radius:var(--radius-control);background:var(--color-card);border:1px solid var(--border-default);font:500 var(--text-label)/1.6 var(--font-sans);color:var(--color-secondary)}
.oa-feed button[data-fresh]{color:var(--color-accent);border-color:color-mix(in srgb,var(--color-accent) 35%,var(--border-default))}
.oa-feed[data-phone] button{border:0;padding:0;background:none}
.oa-feed time{font-variant-numeric:tabular-nums;color:var(--color-muted);margin-right:5px}
@media (prefers-reduced-motion: reduce){.oa-flow{animation:none}}
`;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

interface Point { x: number; y: number }
interface Shown { link: OrchestratorLink; card: DOMRect; column: DOMRect; status: string }
interface Unseen { link: OrchestratorLink; hidden: "above" | "below" | "away"; column: DOMRect | null; view: DOMRect | null; status: string | null }

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));
}

export function mountOrchestratorArrows(options: {
  variant: ArrowVariant;
  links: OrchestratorLink[];
  titles: Record<string, string>;
  locale?: Locale;
}): ArrowsOverlay {
  const { variant } = options;
  const locale: Locale = options.locale ?? "en";
  const text = (key: string, params: Record<string, string | number> = {}) => fill(TEXT[locale][key] ?? key, params);
  const status = (value: TaskStatus) => translate(locale, `kanban.status.${value}`);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let links = options.links;
  /* Variant 1 draws for the seat or the card under the pointer; 2 always; 3 never at rest. */
  let reveal: "all" | string | null = variant === 2 ? "all" : null;
  const counters = { updates: 0, totalMs: 0, maxMs: 0, rectReads: 0, wires: 0, stubs: 0 };
  const motions: Animation[] = [];
  const feed: { at: Date; taskId: string; line: string }[] = [];

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  const layer = document.createElement("div");
  layer.dataset.oaLayer = String(variant);
  const canvas = svg("svg", { "aria-hidden": "true" });
  const defs = svg("defs", {});
  const head = svg("marker", { id: "oa-head", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  head.append(svg("path", { d: "M0,0 L8,4 L0,8 z", class: "oa-head" }));
  /* Variant 1's wires pass behind the cards they do not end at. */
  const cut = svg("mask", { id: "oa-cut", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 10000, height: 10000 });
  defs.append(head, cut);
  const still = svg("g", variant === 1 ? { mask: "url(#oa-cut)" } : {});
  const moving = svg("g", {});
  const behind = svg("g", { mask: "url(#oa-cut)" });
  canvas.append(defs, still, behind, moving);
  const chips = document.createElement("div");
  const feedRow = document.createElement("div");
  feedRow.className = "oa-feed";
  feedRow.hidden = true;
  layer.append(canvas, chips, feedRow);
  document.body.append(layer);

  const phone = () => !!document.querySelector("[data-phone-kanban]");
  const seatNode = () => document.querySelector<HTMLElement>(phone() ? "[data-mobile2-seat-card]" : "[data-kanban-seat]");
  const cardNode = (taskId: string) => document.querySelector<HTMLElement>(phone()
    ? `[data-phone-card="task:${CSS.escape(taskId)}"]`
    : `[data-kanban-board] .card[data-id="task:${CSS.escape(taskId)}"]`);
  const columnNode = (node: Element) => node.closest<HTMLElement>(phone() ? "[data-phone-kanban-column]" : "section.column[data-status]");
  const rect = (node: Element) => { counters.rectReads += 1; return node.getBoundingClientRect(); };
  const strip = (seat: DOMRect) => seat.width > seat.height * 2.5;
  const portY = (card: DOMRect) => card.top + (phone() ? 20 : 22);

  /* At the side, the bus runs in the gap above the columns. */
  let busY = 0;
  /** The seat's one output port: under its mark on top and on the phone, on its right edge at the side. */
  function seatPort(seat: DOMRect): Point {
    return strip(seat) ? { x: seat.left + (phone() ? 40 : 22), y: seat.bottom } : { x: seat.right, y: busY || seat.top + 56 };
  }

  function locate(link: OrchestratorLink): Shown | Unseen {
    const node = cardNode(link.taskId);
    if (!node) return { link, hidden: "away", column: null, view: null, status: null };
    const column = columnNode(node);
    const body = phone() ? column : node.closest<HTMLElement>(".col-body");
    const card = rect(node);
    const view = body ? rect(body) : new DOMRect(0, 0, innerWidth, innerHeight);
    const columnRect = column ? rect(column) : view;
    const state = column?.dataset.status ?? column?.dataset.phoneKanbanColumn ?? null;
    const top = Math.max(view.top, 0);
    const bottom = Math.min(view.bottom, innerHeight);
    const clip = new DOMRect(columnRect.left, top, columnRect.width, bottom - top);
    if (card.right < 0 || card.left > innerWidth - 8 || view.right < 0 || view.left > innerWidth - 8) return { link, hidden: "away", column: columnRect, view: clip, status: state };
    if (card.top + 30 > bottom) return { link, hidden: "below", column: columnRect, view: clip, status: state };
    if (card.bottom - 30 < top) return { link, hidden: "above", column: columnRect, view: clip, status: state };
    return { link, card, column: columnRect, status: state ?? "" };
  }

  /** Variants 1 and 3: one curve from the seat's port into the card's left edge. */
  function curve(from: Point, to: Point): string {
    if (to.y > from.y + 8) {
      const drop = Math.max(40, (to.y - from.y) * 0.6);
      const reach = Math.min(80, Math.max(18, (to.x - from.x) * 0.5));
      return `M${from.x},${from.y} C${from.x},${from.y + drop} ${to.x - reach},${to.y} ${to.x - 2},${to.y}`;
    }
    const lift = Math.min(from.y, to.y) - 60;
    return `M${from.x},${from.y} C${from.x + 80},${lift} ${to.x - 80},${lift} ${to.x - 2},${to.y}`;
  }

  /** Variant 2: out of the seat, along a bus, down the gutter left of the column, into the card. */
  function gutter(seat: DOMRect, column: DOMRect, y: number, into: number): string {
    const r = 6;
    const trunk = phone() ? column.left + 5 : column.left - 9;
    const turn = `V${y - r} Q${trunk},${y} ${trunk + r},${y} H${into}`;
    if (strip(seat)) return `M${trunk},${seat.bottom} ${turn}`;
    const port = seatPort(seat);
    const bus = Math.max(port.y, column.top - 9);
    if (bus <= port.y + r) return `M${port.x},${port.y} H${trunk - r} Q${trunk},${port.y} ${trunk},${port.y + r} ${turn}`;
    const out = port.x + 10;
    return `M${port.x},${port.y} H${out - r} Q${out},${port.y} ${out},${port.y + r} V${bus - r} Q${out},${bus} ${out + r},${bus} H${trunk - r} Q${trunk},${bus} ${trunk},${bus + r} ${turn}`;
  }

  const kept = new Map<string, SVGElement>();
  const stubs = new Map<string, HTMLElement>();
  const seen = new Set<string>();
  function keep<T extends SVGElement>(key: string, make: () => T, parent: SVGElement = still): T {
    let node = kept.get(key) as T | undefined;
    if (!node) { node = make(); kept.set(key, node); parent.append(node); }
    seen.add(key);
    return node;
  }

  function cutCards() {
    const boxes = [...document.querySelectorAll(phone() ? "[data-phone-card]" : "[data-kanban-board] .card[data-id]")].map(rect);
    cut.replaceChildren(svg("rect", { x: 0, y: 0, width: 10000, height: 10000, fill: "white" }),
      ...boxes.map((box) => svg("rect", { x: box.left, y: box.top, width: box.width, height: box.height, rx: 12, fill: "black" })));
  }

  function update() {
    const started = performance.now();
    counters.updates += 1;
    seen.clear();
    const seenStubs = new Set<string>();
    const seatElement = seatNode();
    const seat = seatElement ? rect(seatElement) : null;
    let wires = 0;
    const columns = document.querySelectorAll(phone() ? "[data-phone-kanban-column]" : "[data-kanban-board] section.column[data-status]");
    busY = columns[0] ? rect(columns[0]).top - 9 : 0;
    for (const column of columns) resized.observe(column);
    if (seat && variant !== 3) {
      const spots = links.map(locate);
      const showAll = reveal === "all";
      if (variant === 1 && reveal) cutCards();
      for (const spot of spots) {
        if ("hidden" in spot) continue;
        const tone = spot.link.tone;
        const port = { x: spot.card.left, y: portY(spot.card) };
        const dot = keep(`port:${spot.link.taskId}`, () => svg("circle", { r: 3.5, class: "oa-port" }), moving);
        dot.setAttribute("cx", String(port.x));
        dot.setAttribute("cy", String(port.y));
        dot.dataset.tone = tone;
        if (!showAll && reveal !== spot.link.taskId) continue;
        wires += 1;
        const d = variant === 2 ? gutter(seat, spot.column, port.y, port.x - 3.5) : curve(seatPort(seat), { x: port.x - 3, y: port.y });
        const wire = keep(`wire:${spot.link.taskId}`, () => svg("path", { class: "oa-wire" }));
        wire.setAttribute("d", d);
        wire.dataset.tone = tone;
        if (variant === 1) wire.setAttribute("marker-end", "url(#oa-head)");
        if (variant === 2 && tone === "live" && !reduced) {
          const flow = keep(`flow:${spot.link.taskId}`, () => {
            const node = svg("path", { class: "oa-flow" });
            node.style.animationDelay = `-${Math.round(performance.now() % 700)}ms`;
            return node;
          });
          flow.setAttribute("d", d);
        }
      }
      /* Cards the column has scrolled past are counted at its edge, not wired one by one. */
      if (showAll) {
        const counts = new Map<string, { column: DOMRect; view: DOMRect; above: number; below: number }>();
        for (const spot of spots) {
          if (!("hidden" in spot) || spot.hidden === "away" || !spot.column || !spot.view || !spot.status) continue;
          const entry = counts.get(spot.status) ?? { column: spot.column, view: spot.view, above: 0, below: 0 };
          entry[spot.hidden] += 1;
          counts.set(spot.status, entry);
        }
        for (const [state, entry] of counts) {
          for (const side of ["above", "below"] as const) {
            if (!entry[side]) continue;
            const key = `${state}:${side}`;
            seenStubs.add(key);
            let chip = stubs.get(key);
            if (!chip) { chip = document.createElement("span"); chip.className = "oa-stub"; stubs.set(key, chip); chips.append(chip); }
            chip.textContent = `${side === "above" ? "↑" : "↓"} ${text("more", { count: entry[side] })}`;
            const y = side === "above" ? entry.view.top + 6 : entry.view.bottom - 26;
            const x = entry.column.left + (phone() ? 14 : 10);
            chip.style.left = `${Math.round(x)}px`;
            chip.style.top = `${Math.round(y)}px`;
            wires += 1;
            const d = variant === 2 ? gutter(seat, entry.column, y + 10, x) : curve(seatPort(seat), { x: x - 3, y: y + 10 });
            const wire = keep(`stub:${key}`, () => svg("path", { class: "oa-wire", "data-stub": "" }));
            wire.setAttribute("d", d);
            wire.dataset.tone = "idle";
          }
        }
        if (!(variant === 2 && strip(seat))) {
          const port = seatPort(seat);
          const seatDot = keep("seat", () => svg("circle", { r: 4.5, class: "oa-port", "data-seat": "" }), moving);
          seatDot.setAttribute("cx", String(port.x));
          seatDot.setAttribute("cy", String(port.y));
        }
      }
    }
    for (const [key, node] of kept) if (!seen.has(key)) { node.remove(); kept.delete(key); }
    for (const [key, chip] of stubs) if (!seenStubs.has(key)) { chip.remove(); stubs.delete(key); }
    if (variant === 3) placeFeed(seat);
    counters.wires = wires;
    counters.stubs = seenStubs.size;
    const spent = performance.now() - started;
    counters.totalMs += spent;
    counters.maxMs = Math.max(counters.maxMs, spent);
  }

  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
  addEventListener("scroll", schedule, { capture: true, passive: true });
  addEventListener("resize", schedule);
  /* A product slice runs this from the board's own layout pass instead (the one that flies moved cards). */
  const observer = new MutationObserver((records) => { if (records.some((record) => !layer.contains(record.target))) schedule(); });
  observer.observe(document.body, { childList: true, subtree: true });
  /* A column that widens or narrows moves its cards without a mutation. */
  const resized = new ResizeObserver(schedule);

  /* Variant 1: the seat or a card under the pointer, or holding focus, reveals its wires. */
  const onPointer = (event: Event) => {
    if (variant !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    let next: typeof reveal = null;
    if (target?.closest("[data-kanban-seat], [data-mobile2-seat-card]")) next = "all";
    else {
      const card = target?.closest<HTMLElement>("[data-kanban-board] .card[data-id], [data-phone-card]");
      const id = (card?.dataset.id ?? card?.dataset.phoneCard ?? "").replace(/^task:/, "");
      if (id && links.some((link) => link.taskId === id)) next = id;
    }
    if (next !== reveal) { reveal = next; schedule(); }
  };
  document.addEventListener("pointerover", onPointer);
  document.addEventListener("focusin", onPointer);

  function track(animation: Animation): Animation { motions.push(animation); return animation; }
  function gone(animation: Animation, node: Element) { void animation.finished.then(() => node.remove(), () => {}); }

  function placeChip(label: string, at: Point, delay: number) {
    const chip = document.createElement("span");
    chip.className = "oa-chip";
    chip.textContent = label;
    chips.append(chip);
    chip.style.left = `${Math.round(Math.max(6, Math.min(at.x, innerWidth - chip.offsetWidth - 6)))}px`;
    chip.style.top = `${Math.round(Math.max(4, at.y))}px`;
    gone(track(chip.animate(
      [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none", offset: 0.06 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }],
      { duration: 3400, delay, easing: "ease-out", fill: "both" },
    )), chip);
  }

  function drawIn(d: string, attrs: Record<string, string>, parent: SVGElement, duration = 520, hold = 2600) {
    const path = svg("path", { d, class: "oa-wire", ...attrs });
    parent.append(path);
    const length = Math.max(1, path.getTotalLength());
    if (attrs["stroke-dasharray"]) {
      gone(track(path.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: duration + hold, fill: "both" })), path);
      return;
    }
    path.style.strokeDasharray = `${length}`;
    gone(track(path.animate(
      [{ strokeDashoffset: length, opacity: 1 }, { strokeDashoffset: 0, opacity: 1, offset: duration / (duration + hold) }, { strokeDashoffset: 0, opacity: 1, offset: 0.85 }, { strokeDashoffset: 0, opacity: 0 }],
      { duration: duration + hold, easing: "ease-out", fill: "both" },
    )), path);
  }

  function travel(d: string, delay: number, duration: number) {
    if (reduced) return;
    const dot = document.createElement("span");
    dot.className = "oa-dot";
    dot.style.offsetPath = `path("${d}")`;
    dot.style.offsetRotate = "0deg";
    chips.append(dot);
    gone(track(dot.animate(
      [{ offsetDistance: "0%", opacity: 1 }, { offsetDistance: "100%", opacity: 1, offset: 0.9 }, { offsetDistance: "100%", opacity: 0 }],
      { duration, delay, easing: "ease-in-out", fill: "both" },
    )), dot);
  }

  function ring(box: DOMRect, delay: number) {
    const outline = svg("rect", { x: box.left - 3, y: box.top - 3, width: box.width + 6, height: box.height + 6, rx: 14, class: "oa-ring" });
    moving.append(outline);
    gone(track(outline.animate(
      [{ opacity: 0, strokeWidth: 8 }, { opacity: 1, strokeWidth: 2, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
      { duration: 2800, delay, easing: "ease-out", fill: "both" },
    )), outline);
  }

  function feedLine(action: OrchestratorAction): string {
    const raw = options.titles[action.taskId] ?? action.taskId;
    const title = raw.length > 34 ? `${raw.slice(0, 33)}…` : raw;
    if (action.kind === "move") return text("feedMoved", { title, to: status(action.to) });
    if (action.kind === "pipeline") return text("feedPipeline", { title });
    return text("feedStage", { title, stage: action.stage });
  }

  /* Variant 3: the newest actions beside the seat (over its status line on the phone). */
  function placeFeed(seat: DOMRect | null) {
    if (!seat || !feed.length) { feedRow.hidden = true; return; }
    feedRow.hidden = false;
    const nowLine = phone() ? document.querySelector("[data-mobile2-seat-now]") : null;
    if (nowLine) {
      const box = rect(nowLine);
      feedRow.dataset.phone = "";
      Object.assign(feedRow.style, { left: `${box.left}px`, top: `${box.top - 1}px`, width: `${Math.max(box.width, seat.right - box.left - 56)}px`, height: `${box.height + 2}px` });
    } else {
      const title = seatNode()?.querySelector(".seat-title, h2, [data-seat-title]");
      const after = title ? rect(title).right + 120 : seat.left + 190;
      Object.assign(feedRow.style, { left: `${after}px`, top: `${seat.top + seat.height / 2 - 11}px`, width: `${Math.max(200, seat.right - after - 340)}px` });
    }
  }
  function renderFeed() {
    feedRow.replaceChildren(...feed.slice(0, phone() ? 1 : 3).map((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      if (index === 0) button.dataset.fresh = "";
      const time = document.createElement("time");
      time.textContent = index === 0 ? text("now") : entry.at.toTimeString().slice(0, 5);
      button.append(time, entry.line);
      button.title = entry.line;
      button.dataset.oaFeed = entry.taskId;
      button.addEventListener("pointerenter", () => {
        const seat = seatNode();
        const card = cardNode(entry.taskId);
        if (!seat || !card) return;
        const box = rect(card);
        drawIn(curve(seatPort(rect(seat)), { x: box.left - 3, y: portY(box) }), { "marker-end": "url(#oa-head)" }, moving, 320, 1800);
        ring(box, 0);
      });
      return button;
    }));
    update();
  }

  async function play(action: OrchestratorAction): Promise<void> {
    update();
    const seatElement = seatNode();
    if (!seatElement) return;
    const seat = rect(seatElement);
    const started = motions.length;
    const node = cardNode(action.taskId);
    const card = node ? rect(node) : null;
    const onScreen = card && card.top < innerHeight - 30 && card.bottom > 30 && card.left < innerWidth - 30 && card.right > 0 ? card : null;
    const tab = phone() && !onScreen ? document.querySelector<HTMLElement>(`[data-phone-kanban-tab="${action.kind === "move" ? action.to : columnNode(node ?? document.body)?.dataset.phoneKanbanColumn ?? ""}"]`) : null;
    const lane = onScreen && action.kind !== "move" && node ? node.querySelector<HTMLElement>(`[data-pipeline="${CSS.escape(action.pipelineId)}"]`) : null;
    const focus = lane ? rect(lane) : onScreen;
    const caption = action.kind === "move" ? text("moved", { from: status(action.from), to: status(action.to) })
      : action.kind === "pipeline" ? text("pipeline") : text("stage", { stage: action.stage });

    if (variant === 3) {
      feed.unshift({ at: new Date(), taskId: action.taskId, line: feedLine(action) });
      feed.length = Math.min(feed.length, 3);
      renderFeed();
    }
    let target: Point | null = null;
    if (onScreen) target = { x: onScreen.left - 3, y: portY(onScreen) };
    else if (tab) { const box = rect(tab); target = { x: box.left + box.width / 2, y: box.bottom - 6 }; }
    if (!target) return;
    const column = node && onScreen ? columnNode(node) : null;
    const path = variant === 2 && onScreen && column ? gutter(seat, rect(column), target.y, target.x - 0.5) : curve(seatPort(seat), target);

    if (action.kind === "move" && action.before && onScreen) {
      /* The board has already flown the card; 2 lets the old branch go, 3 leaves a ghost where it stood. */
      if (variant === 2) {
        const from = document.elementsFromPoint(action.before.left + 4, action.before.top + 4).find((el) => el.matches("section.column[data-status], [data-phone-kanban-column]"));
        if (from) {
          const ghost = svg("path", { d: gutter(seat, from.getBoundingClientRect(), portY(action.before), action.before.left - 4), class: "oa-ghost" });
          moving.append(ghost);
          gone(track(ghost.animate([{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }], { duration: 1400, easing: "ease-in", fill: "both" })), ghost);
        }
      }
      if (variant === 3) {
        const shown = new DOMRect(action.before.left, Math.max(action.before.top, 0), action.before.width, Math.min(action.before.height, 96));
        if (shown.top < innerHeight - 20) {
          const box = svg("rect", { x: shown.left, y: shown.top, width: shown.width, height: shown.height, rx: 12, class: "oa-ghost" });
          moving.append(box);
          gone(track(box.animate([{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: 3200, fill: "both" })), box);
        }
        const from = { x: shown.left + shown.width / 2, y: Math.min(shown.top + 24, innerHeight - 10) };
        const to = { x: onScreen.left + onScreen.width / 2, y: onScreen.top + 8 };
        const lift = Math.min(from.y, to.y) - 50;
        drawIn(`M${from.x},${from.y} C${from.x},${lift} ${to.x},${lift} ${to.x},${to.y}`, { "marker-end": "url(#oa-head)", "stroke-dasharray": "5 4" }, moving);
      }
    }

    /* One clock for all three: the wire (or the pulse) reaches the card at about 0.6 s, the ring and the caption follow. */
    if (variant === 2) {
      if (action.kind === "pipeline") drawIn(path, {}, moving, 520, 2400);
      travel(path, action.kind === "pipeline" ? 160 : 0, 820);
    } else {
      drawIn(path, { "marker-end": "url(#oa-head)" }, variant === 1 ? behind : moving);
      travel(path, 120, 680);
    }
    if (variant === 1 || variant === 3) cutCards();
    const delay = 440;
    if (focus) {
      ring(focus, delay);
      placeChip(caption, { x: focus.left + 10, y: lane ? focus.bottom - 10 : focus.top - 12 }, delay);
    } else if (tab) {
      const box = rect(tab);
      placeChip(caption, { x: box.left + box.width / 2 - 90, y: box.bottom + 8 }, delay);
      track(tab.animate([{ transform: "none" }, { transform: "scale(1.08)", offset: 0.3 }, { transform: "none" }], { duration: 700, delay, fill: "both" }));
    }
    await Promise.all(motions.slice(started).map((motion) => motion.finished.catch(() => undefined)));
  }

  update();
  return {
    setLinks(next) { links = next; schedule(); },
    play,
    freeze(ms) {
      for (const motion of motions) { motion.pause(); motion.currentTime = ms; }
      for (const motion of document.getAnimations()) {
        const target = (motion.effect as KeyframeEffect | null)?.target;
        if (target instanceof Element && target.classList.contains("oa-flow")) { motion.pause(); motion.currentTime = ms; }
      }
    },
    settle() {
      for (const motion of motions.splice(0)) motion.finish();
      for (const motion of document.getAnimations()) if (motion.playState === "paused") motion.play();
    },
    stats(reset = false) {
      const snapshot = { ...counters };
      if (reset) Object.assign(counters, { updates: 0, totalMs: 0, maxMs: 0, rectReads: 0 });
      return snapshot;
    },
    destroy() {
      observer.disconnect();
      resized.disconnect();
      removeEventListener("scroll", schedule, { capture: true });
      removeEventListener("resize", schedule);
      document.removeEventListener("pointerover", onPointer);
      document.removeEventListener("focusin", onPointer);
      if (frame) cancelAnimationFrame(frame);
      layer.remove();
      style.remove();
    },
  };
}
