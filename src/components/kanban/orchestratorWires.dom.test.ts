import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { ORCHESTRATOR_WIRE_FADE_MS, ORCHESTRATOR_WIRE_HOLD_MS } from "./orchestratorArrows";
import { createOrchestratorWires, type OrchestratorWires } from "./orchestratorWires";

/* The layer's life: nothing while no wire is shown, one wire per card for the
   hold, and nothing left behind after it. Geometry is the browser driver's. */

let dom: Window;
let reduce = true;
/* The reduced-motion query's change listeners, as the layer attached them. */
const motionListeners = new Set<() => void>();
const layers: OrchestratorWires[] = [];
beforeEach(() => {
  dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
  Object.assign(globalThis, { window: dom, document: dom.document });
  reduce = true;
  motionListeners.clear();
  Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({
    get matches() { return reduce; },
    addEventListener(_type: string, listener: () => void) { motionListeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { motionListeners.delete(listener); },
  }) });
});
afterEach(async () => {
  layers.splice(0).forEach((layer) => layer.destroy());
  document.body.replaceChildren();
  await dom.happyDOM.waitUntilComplete();
  dom.close();
});

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} }) as DOMRect;

function board(options: { seat?: boolean } = {}) {
  const root = document.createElement("div");
  root.className = "kb";
  root.innerHTML = `${options.seat === false ? "" : '<section data-kanban-seat="atlas" data-placement="side"></section>'}
    <section class="column" data-status="assigned"><div class="col-body">
      <article class="card" data-id="task:a"></article><article class="card" data-id="task:b"></article><article class="card" data-id="task:far"></article>
    </div></section>`;
  document.body.append(root);
  const place = (selector: string, box: DOMRect) => { const node = root.querySelector<HTMLElement>(selector); if (node) node.getBoundingClientRect = () => box; };
  place("[data-kanban-seat]", rect(0, 60, 360, 820));
  place(".column", rect(400, 80, 300, 800));
  place(".col-body", rect(400, 120, 300, 760));
  place('[data-id="task:a"]', rect(412, 130, 276, 120));
  place('[data-id="task:b"]', rect(412, 262, 276, 120));
  place('[data-id="task:far"]', rect(412, 2_000, 276, 120));
  const layer = createOrchestratorWires({ root, phone: false });
  layers.push(layer);
  const node = () => root.querySelector<HTMLElement>("[data-orchestrator-wires]");
  const drawn = () => [...root.querySelectorAll("[data-orchestrator-wires] g[data-wire]")].map((group) => group.getAttribute("data-wire"));
  return { root, layer, node, drawn };
}

test("with no action there is no layer, and a sync or a tone update mounts none", () => {
  const { layer, node } = board();
  layer.sync();
  layer.setTones(new Map([["a", "live"]]));
  expect(node()).toBeNull();
  expect(layer.active).toBe(false);
});

test("an action draws the card's wire from the seat into its port, rounded, with the card's tone", () => {
  const { layer, node, drawn, root } = board();
  layer.setTones(new Map([["a", "needs"]]));
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1", at: Date.now() }]);
  expect(layer.active).toBe(true);
  expect(drawn()).toEqual(["a"]);
  const group = root.querySelector("g[data-wire]")!;
  expect(group.getAttribute("data-tone")).toBe("needs");
  const d = group.querySelector("path.oa-wire")!.getAttribute("d")!;
  /* Out of the seat's right edge, down the gutter left of the column, into the card's left edge. */
  expect(d.startsWith("M360,")).toBe(true);
  expect(d).toContain("Q391,");
  expect(d.endsWith("H408.5")).toBe(true);
  expect(node()!.querySelectorAll(".oa-port[data-seat]").length).toBe(1);
});

test("a card the column has scrolled past is counted at the column's edge", () => {
  const { layer, drawn, node } = board();
  layer.act([{ kind: "stage", taskId: "far", pipelineId: "p1", at: Date.now() }, { kind: "stage", taskId: "a", pipelineId: "p2", at: Date.now() }]);
  expect(drawn()).toEqual(["a"]);
  expect([...node()!.querySelectorAll(".oa-stub")].map((chip) => chip.textContent)).toEqual(["↓ +1"]);
});

test("the wire goes when its hold is over, and the layer with the last wire", () => {
  const { layer, node, drawn } = board();
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1", at: Date.now() }]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 1_000);
  expect(drawn()).toEqual(["a"]);
  layer.act([{ kind: "pipeline", taskId: "b", pipelineId: "p2", at: Date.now() }]);
  expect(drawn()).toEqual(["a", "b"]);
  layer.probe.advance(1_000);
  expect(drawn()).toEqual(["b"]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS);
  expect(node()).toBeNull();
  expect(layer.active).toBe(false);
});

test("a new action on the same card starts its minute again", () => {
  const { layer, drawn, root } = board();
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1", at: Date.now() }]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 5_000);
  layer.act([{ kind: "stage", taskId: "a", pipelineId: "p1", at: Date.now() }]);
  expect(root.querySelectorAll("g[data-wire]").length).toBe(1);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 5_000);
  expect(drawn()).toEqual(["a"]);
  layer.probe.advance(5_000);
  expect(drawn()).toEqual([]);
});

test("with motion, the hold is followed by a fade, and the clock ends the wire whether or not the fade ran", () => {
  reduce = false;
  const fades: { node: Element; frames: Keyframe[]; timing: KeyframeAnimationOptions; cancelled: boolean }[] = [];
  for (const prototype of [dom.HTMLElement.prototype, dom.SVGElement.prototype]) {
    Object.defineProperty(prototype, "animate", { configurable: true, value(this: Element, frames: Keyframe[], timing: KeyframeAnimationOptions) {
      const call = { node: this, frames, timing, cancelled: false };
      fades.push(call);
      return { currentTime: 0, playState: "running", finished: new Promise(() => {}), cancel() { call.cancelled = true; }, pause() {}, play() {}, finish() {} };
    } });
  }
  const { layer, drawn, node } = board();
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null, at: Date.now() }]);
  const opacity = () => fades.filter((call) => !call.cancelled && call.frames.length === 2 && "opacity" in call.frames[1]! && call.frames[1]!.opacity === 0 && call.timing.duration === ORCHESTRATOR_WIRE_FADE_MS);
  expect(opacity()).toHaveLength(0);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS);
  expect(drawn()).toEqual(["a"]);
  /* The wire's group and the seat's port, which goes with the last wire. */
  expect(opacity().map((call) => call.node.getAttribute("data-wire") ?? call.node.getAttribute("class"))).toEqual(["a", "oa-port"]);
  /* A new action during the fade brings the wire back whole. */
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null, at: Date.now() }]);
  expect(opacity()).toHaveLength(0);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS + ORCHESTRATOR_WIRE_FADE_MS);
  expect(node()).toBeNull();
});

test("a board with no seat draws nothing", () => {
  const { layer, node } = board({ seat: false });
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1", at: Date.now() }]);
  expect(node()).toBeNull();
  expect(layer.active).toBe(false);
});

test("destroy takes the layer and its listeners away", () => {
  const { layer, node } = board();
  const added: string[] = [];
  const removed: string[] = [];
  const add = dom.addEventListener.bind(dom);
  const remove = dom.removeEventListener.bind(dom);
  dom.addEventListener = ((type: string, ...rest: unknown[]) => { added.push(type); return (add as (...args: unknown[]) => void)(type, ...rest); }) as typeof dom.addEventListener;
  dom.removeEventListener = ((type: string, ...rest: unknown[]) => { removed.push(type); return (remove as (...args: unknown[]) => void)(type, ...rest); }) as typeof dom.removeEventListener;
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1", at: Date.now() }]);
  expect(added.sort()).toEqual(["resize", "scroll"]);
  layer.destroy();
  expect(node()).toBeNull();
  expect(removed.sort()).toEqual(["resize", "scroll"]);
});

test("a wire's minute runs from the action's own time: read late it holds only what is left, past the minute it never shows", () => {
  const { layer, drawn, node } = board();
  layer.act([{ kind: "move", taskId: "a", pipelineId: null, at: Date.now() - 5 * 60_000 }]);
  expect(node()).toBeNull();
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null, at: Date.now() - 30_000 }]);
  expect(drawn()).toEqual(["a"]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 30_000 - 1_000);
  expect(drawn()).toEqual(["a"]);
  layer.probe.advance(1_500);
  expect(node()).toBeNull();
});

test("an older action read after a newer one leaves the newer minute as it is; a newer one restarts it", () => {
  const { layer, drawn } = board();
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null, at: Date.now() - 10_000 }]);
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null, at: Date.now() - 40_000 }]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 10_000 + 500);
  expect(drawn()).toEqual([]);
  layer.act([{ kind: "stage", taskId: "b", pipelineId: null, at: Date.now() - 50_000 }]);
  layer.act([{ kind: "stage", taskId: "b", pipelineId: null, at: Date.now() }]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 1_000);
  expect(drawn()).toEqual(["b"]);
});

test("a card whose port the column has scrolled under its header is counted at the edge, never drawn over the header", () => {
  const { layer, drawn, node, root } = board();
  /* The scroller starts at 120; the card's top is 30 px above it, so its port (top + 22) would sit over the header. */
  root.querySelector<HTMLElement>('[data-id="task:a"]')!.getBoundingClientRect = () => rect(412, 90, 276, 120);
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null, at: Date.now() }]);
  expect(drawn()).toEqual([]);
  expect([...node()!.querySelectorAll(".oa-stub")].map((chip) => chip.textContent)).toEqual(["↑ +1"]);
  /* Scrolled back so its port is inside the scroller, the card has its wire, and the port is below the scroller's top. */
  root.querySelector<HTMLElement>('[data-id="task:a"]')!.getBoundingClientRect = () => rect(412, 110, 276, 120);
  /* A later action: in the same millisecond it would be read as the one already shown. */
  layer.probe.advance(1_000);
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null, at: Date.now() }]);
  expect(drawn()).toEqual(["a"]);
  const cy = Number(root.querySelector("g[data-wire] .oa-port")!.getAttribute("cy"));
  expect(cy).toBeGreaterThanOrEqual(120 + 6);
});

test("reduced motion switched on during a pulse stops every motion and fade, and the listener goes with the layer", () => {
  reduce = false;
  const calls: { node: Element; cancelled: boolean; reject: (reason: unknown) => void }[] = [];
  for (const prototype of [dom.HTMLElement.prototype, dom.SVGElement.prototype]) {
    Object.defineProperty(prototype, "animate", { configurable: true, value(this: Element) {
      let reject: (reason: unknown) => void = () => {};
      const finished = new Promise((_resolve, fail) => { reject = fail; });
      finished.catch(() => {});
      const call = { node: this, cancelled: false, reject };
      calls.push(call);
      return { currentTime: 0, playState: "running", finished, cancel() { call.cancelled = true; reject(new Error("cancelled")); }, pause() {}, play() {}, finish() {} };
    } });
  }
  const { layer, drawn, node } = board();
  expect(motionListeners.size).toBe(0);
  layer.act([{ kind: "stage", taskId: "a", pipelineId: "p1", at: Date.now() }]);
  expect(motionListeners.size).toBe(1);
  const running = () => calls.filter((call) => !call.cancelled);
  expect(running().length).toBeGreaterThan(0);
  reduce = true;
  for (const listener of [...motionListeners]) listener();
  expect(running()).toEqual([]);
  expect(drawn()).toEqual(["a"]);
  /* The hold still ends the wire, at once and without a fade, and the listener is gone at rest. */
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS);
  expect(running()).toEqual([]);
  expect(node()).toBeNull();
  expect(motionListeners.size).toBe(0);
});

test("reduced motion switched on during a fade ends the faded wire at once", () => {
  reduce = false;
  for (const prototype of [dom.HTMLElement.prototype, dom.SVGElement.prototype]) {
    Object.defineProperty(prototype, "animate", { configurable: true, value() {
      return { currentTime: 0, playState: "running", finished: new Promise(() => {}), cancel() {}, pause() {}, play() {}, finish() {} };
    } });
  }
  const { layer, node } = board();
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null, at: Date.now() }]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS + ORCHESTRATOR_WIRE_FADE_MS / 2);
  expect(node()).not.toBeNull();
  reduce = true;
  for (const listener of [...motionListeners]) listener();
  expect(node()).toBeNull();
  expect(motionListeners.size).toBe(0);
});

test("repeated actions in a hidden tab keep one pulse a wire, and the hold's end and destroy leave none", () => {
  reduce = false;
  const calls: { node: Element; cancelled: boolean; paused: boolean }[] = [];
  for (const prototype of [dom.HTMLElement.prototype, dom.SVGElement.prototype]) {
    Object.defineProperty(prototype, "animate", { configurable: true, value(this: Element) {
      let reject: (reason: unknown) => void = () => {};
      /* A paused animation never finishes: only a cancel settles it. */
      const finished = new Promise((_resolve, fail) => { reject = fail; });
      finished.catch(() => {});
      const call = { node: this, cancelled: false, paused: false };
      calls.push(call);
      return { currentTime: 0, get playState() { return call.paused ? "paused" : "running"; }, finished, cancel() { call.cancelled = true; reject(new Error("cancelled")); }, pause() { call.paused = true; }, play() { call.paused = false; }, finish() {} };
    } });
  }
  let hidden = true;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const { layer, node, root } = board();
  const live = () => calls.filter((call) => !call.cancelled);
  const marks = () => root.querySelectorAll(".oa-dot, .oa-ring").length;
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: null, at: Date.now() }]);
  const one = { marks: marks(), motions: live().length };
  expect(one.marks).toBe(2);
  for (let round = 0; round < 12; round++) {
    layer.probe.advance(10_000);
    layer.act([{ kind: round % 2 ? "stage" : "pipeline", taskId: "a", pipelineId: null, at: Date.now() }]);
  }
  expect(marks()).toBe(one.marks);
  expect(live().length).toBeLessThanOrEqual(one.motions);
  expect(live().every((call) => call.paused)).toBe(true);
  /* The last action grows no wire, and the growth it replaced left the path whole. */
  expect(root.querySelector<SVGPathElement>("g[data-wire] path.oa-wire")!.style.strokeDasharray).toBe("");
  /* Back in view, only the last action's pulse is there to play. */
  hidden = false;
  document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
  expect(marks()).toBe(one.marks);
  expect(live().filter((call) => !call.paused).length).toBe(live().length);
  /* One wire's hold ends in the hidden tab while another still shows: its pulse goes with it. */
  hidden = true;
  document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
  layer.probe.advance(30_000);
  layer.act([{ kind: "stage", taskId: "b", pipelineId: null, at: Date.now() }]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 30_000);
  expect([...root.querySelectorAll("g[data-wire]")].map((group) => group.getAttribute("data-wire"))).toEqual(["b"]);
  expect(marks()).toBe(2);
  expect(live().length).toBe(2);
  layer.destroy();
  expect(node()).toBeNull();
  expect(live()).toEqual([]);
  expect(document.querySelectorAll(".oa-dot, .oa-ring").length).toBe(0);
});

describe("route geometry across the board's layouts", () => {
  /* docs/design/orchestrator-wire-routing.md: for each layout of the case study,
     the number of bends (rounded corners, `Q` in the path) and no straight run
     through a card, the seat panel or a row of column links. The boxes are the
     case study's own, measured in the browser at the layouts named. */
  beforeEach(() => { dom.happyDOM.setViewport({ width: 1920, height: 1080 }); });

  type R = [left: number, top: number, right: number, bottom: number];
  const box = ([left, top, right, bottom]: R) => ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON() {} }) as DOMRect;

  /* A desktop board: the seat, the columns (each with its scroller from 46 px under its top), the cards, and the row of column links. */
  /* A seat folded on top: its head's avatar, title and the controls at its right, and the state the title shows. */
  type Strip = { avatar: R; title: R; controls: R[]; state?: "working" | "needs" };
  function layout(spec: { seat: R; placement: "top" | "side"; columns: Record<string, R>; cards: Record<string, [status: string, box: R]>; links?: R[]; strip?: Strip }) {
    const root = document.createElement("div");
    root.className = "kb";
    const links = (spec.links ?? []).map((_, index) => `<button data-link="${index}"></button>`).join("");
    const head = spec.strip ? `<div data-orchestrator-panel><header class="seat-head"><span class="relative"><span class="av"></span></span><span class="seat-title"><strong></strong><span class="state ${spec.strip.state ?? "working"}"></span></span><span class="grow"></span>${
      spec.strip.controls.map((_, index) => `<button data-control="${index}"></button>`).join("")}</header></div>` : "";
    root.innerHTML = `<section data-kanban-seat="atlas" data-placement="${spec.placement}" data-collapsed="${spec.strip ? 1 : 0}">${head}</section>
      ${links ? `<div class="tabs-nav jump">${links}</div>` : ""}
      ${Object.keys(spec.columns).map((status) => `<section class="column" data-status="${status}"><div class="col-body">${
        Object.entries(spec.cards).filter(([, [at]]) => at === status).map(([id]) => `<article class="card" data-id="task:${id}"></article>`).join("")
      }</div></section>`).join("")}`;
    document.body.append(root);
    const place = (node: Element | null, at: R) => { if (node) (node as HTMLElement).getBoundingClientRect = () => box(at); };
    place(root.querySelector("[data-kanban-seat]"), spec.seat);
    if (spec.strip) {
      place(root.querySelector(".av")!.parentElement, spec.strip.avatar);
      place(root.querySelector(".seat-title"), spec.strip.title);
      spec.strip.controls.forEach((at, index) => place(root.querySelector(`[data-control="${index}"]`), at));
    }
    spec.links?.forEach((at, index) => place(root.querySelector(`[data-link="${index}"]`), at));
    for (const [status, at] of Object.entries(spec.columns)) {
      place(root.querySelector(`.column[data-status="${status}"]`), at);
      place(root.querySelector(`.column[data-status="${status}"] .col-body`), [at[0], at[1] + 46, at[2], at[3]]);
    }
    for (const [id, [, at]] of Object.entries(spec.cards)) place(root.querySelector(`[data-id="task:${id}"]`), at);
    const layer = createOrchestratorWires({ root, phone: false });
    layers.push(layer);
    const act = (...ids: string[]) => layer.act(ids.map((taskId) => ({ kind: "pipeline" as const, taskId, pipelineId: `p-${taskId}`, at: Date.now() })));
    const wire = (id: string) => root.querySelector(`g[data-wire="${id}"] path.oa-wire`)?.getAttribute("d") ?? null;
    const stub = () => root.querySelector("path.oa-wire[data-stub]")?.getAttribute("d") ?? null;
    const seatPorts = () => [...root.querySelectorAll(".oa-port[data-seat]")].map((port) => `M${port.getAttribute("cx")},${port.getAttribute("cy")}`);
    return { act, wire, stub, seatPorts, spec };
  }

  /* The path's corners as a polyline: every M/H/V end and every Q end point. */
  function points(d: string): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    let at = { x: 0, y: 0 };
    for (const [, op, args] of d.matchAll(/([MHVQ])\s*([^MHVQ]*)/g)) {
      const n = args!.trim().split(/[\s,]+/).map(Number);
      if (op === "M") at = { x: n[0]!, y: n[1]! };
      else if (op === "H") at = { x: n[0]!, y: at.y };
      else if (op === "V") at = { x: at.x, y: n[0]! };
      else at = { x: n[2]!, y: n[3]! };
      out.push(at);
    }
    return out;
  }
  const bends = (d: string) => (d.match(/Q/g) ?? []).length;
  const length = (d: string) => Math.round(points(d).reduce((sum, p, i, all) => (i ? sum + Math.hypot(p.x - all[i - 1]!.x, p.y - all[i - 1]!.y) : 0), 0));
  /** Whether any straight run of the path passes through the inside of a box (1.5 px inset). */
  function through(d: string, boxes: R[]): boolean {
    const list = points(d);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!;
      for (let s = 0; s <= 40; s++) {
        const x = a.x + ((b.x - a.x) * s) / 40, y = a.y + ((b.y - a.y) * s) / 40;
        if (boxes.some(([l, t, r, bt]) => x > l + 1.5 && x < r - 1.5 && y > t + 1.5 && y < bt - 1.5)) return true;
      }
    }
    return false;
  }
  /* A folded strip with no frame is its avatar, its title and its controls; anything else is its box. */
  const obstacles = (spec: ReturnType<typeof layout>["spec"]) => [
    ...(spec.strip ? [spec.strip.avatar, spec.strip.title, ...spec.strip.controls] : [spec.seat]), ...Object.values(spec.cards).map(([, at]) => at), ...(spec.links ?? []),
  ];
  /** How far a seat port stands from the avatar and title of a folded strip: 0 on their edge. */
  const offStrip = (strip: Strip, port: string) => {
    const [x, y] = port.slice(1).split(",").map(Number) as [number, number];
    const [l, t, r, b] = [Math.min(strip.avatar[0], strip.title[0]), Math.min(strip.avatar[1], strip.title[1]), Math.max(strip.avatar[2], strip.title[2]), Math.max(strip.avatar[3], strip.title[3])];
    return Math.hypot(Math.max(l - x, 0, x - r), Math.max(t - y, 0, y - b));
  };
  /** How far two paths run within 2 px of each other: `trunk` along their common start, the stem of a
      tree, and `elsewhere`, where a shared run hides which wire goes where. */
  function shared(a: string, b: string): { trunk: number; elsewhere: number } {
    const walk = (d: string) => {
      const out: { x: number; y: number; at: number }[] = [];
      let at = 0;
      points(d).forEach((p, i, all) => {
        if (!i) return;
        const from = all[i - 1]!, span = Math.hypot(p.x - from.x, p.y - from.y);
        for (let s = 0; s < span; s++) out.push({ x: from.x + ((p.x - from.x) * s) / span, y: from.y + ((p.y - from.y) * s) / span, at: at + s });
        at += span;
      });
      return out;
    };
    const [one, other] = [walk(a), walk(b)];
    const together = a.split(" ")[0] === b.split(" ")[0];
    let trunk = 0, elsewhere = 0;
    for (const p of one) {
      const near = other.filter((q) => Math.hypot(p.x - q.x, p.y - q.y) < 2);
      if (!near.length) continue;
      if (together && near.some((q) => Math.abs(q.at - p.at) <= 3)) trunk += 1;
      else elsewhere += 1;
    }
    return { trunk, elsewhere };
  }

  /* The operator's board (2026-10-07) as the fixture draws it at 1920 × 1080, the wide mode: the seat on
     top, open, centred over the columns; Inbox starts left of it (routes.json, 1920-top-en-*). */
  const WIDE = {
    seat: [564, 60, 1604, 870] as R,
    columns: { inbox: [268, 882, 623, 1080] as R, assigned: [639, 882, 1159, 1080] as R, blocked: [1175, 882, 1529, 1080] as R, done: [1545, 882, 1900, 1080] as R },
  };

  test("seat on top over the target's gutter (the operator's case): one elbow down from the seat's foot, through nothing", () => {
    const { act, wire, spec } = layout({ ...WIDE, placement: "top", cards: { a: ["assigned", [652, 935, 1146, 1245]] } });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(1);
    expect(d.startsWith("M630,870 ")).toBe(true);
    expect(through(d, obstacles(spec))).toBe(false);
    expect(length(d)).toBeLessThan(120);
  });

  test("seat on top, target column left of it: two elbows out of the seat's left side", () => {
    const { act, wire, spec } = layout({ ...WIDE, placement: "top", cards: { a: ["inbox", [281, 935, 610, 1192]] } });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(2);
    expect(d.startsWith(`M${WIDE.seat[0]},`)).toBe(true);
    expect(through(d, obstacles(spec))).toBe(false);
  });

  test("seat on top narrowed by its width grip, target column right of it: two elbows out of the seat's right side", () => {
    const { act, wire, spec } = layout({ ...WIDE, seat: [784, 60, 1384, 870], placement: "top", cards: { a: ["done", [1558, 935, 1888, 1060]] } });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(2);
    expect(d.startsWith("M1384,")).toBe(true);
    expect(through(d, obstacles(spec))).toBe(false);
  });

  /* 1440 × 900 beside the sidebar: the scrolling board, its row of column links under the seat (1440-top-en-*). */
  const SCROLL = {
    seat: [324, 60, 1364, 735] as R,
    columns: { inbox: [264, 787, 544, 1571] as R, assigned: [556, 787, 1036, 1571] as R, blocked: [1048, 787, 1328, 1571] as R },
    links: [[264, 747, 330, 775], [332, 747, 429, 775], [431, 747, 507, 775], [509, 747, 574, 775]] as R[],
  };

  test("a row of column links under the gutter: round it along the bus, three elbows, never through a link", () => {
    const { act, wire, spec } = layout({ ...SCROLL, placement: "top", cards: { a: ["assigned", [569, 840, 1023, 1150]] } });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(3);
    expect(through(d, obstacles(spec))).toBe(false);
  });

  test("a row of column links clear of the gutter: one elbow", () => {
    const { act, wire, spec } = layout({ ...SCROLL, placement: "top", cards: { a: ["blocked", [1061, 840, 1315, 1150]] } });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(1);
    expect(through(d, obstacles(spec))).toBe(false);
  });

  /* The seat at the side, 1440 × 900: the row of column links above the columns (1440-side-en-*). */
  const SIDE = {
    seat: [34, 48, 414, 900] as R,
    columns: { inbox: [430, 100, 710, 884] as R, assigned: [722, 100, 1202, 884] as R },
    links: [[430, 60, 496, 88], [498, 60, 595, 88], [597, 60, 673, 88], [675, 60, 740, 88]] as R[],
  };

  test("seat at the side, card in the column beside it: a straight wire", () => {
    const { act, wire, spec } = layout({ ...SIDE, placement: "side", cards: { a: ["inbox", [443, 153, 697, 442]] } });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(0);
    expect(through(d, obstacles(spec))).toBe(false);
  });

  test("seat at the side, card in a farther column: two elbows along the bus, over no card", () => {
    const { act, wire, spec } = layout({ ...SIDE, placement: "side", cards: { a: ["assigned", [735, 153, 1189, 460]], b: ["inbox", [443, 153, 697, 600]] } });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(2);
    expect(through(d, obstacles(spec))).toBe(false);
  });

  test("seat at the side with the columns flush with its top (1920, wide): two elbows, no hook back above the seat", () => {
    const { act, wire, spec } = layout({
      seat: [34, 48, 414, 1080], placement: "side",
      columns: { inbox: [434, 60, 733, 1060], assigned: [749, 60, 1269, 1060] },
      cards: { a: ["assigned", [762, 113, 1256, 423]], b: ["inbox", [447, 113, 720, 402]] },
    });
    act("a", "b");
    const [a, b] = ["a", "b"].map((id) => wire(id)!);
    expect(bends(a)).toBe(2);
    expect(bends(b)).toBe(0);
    /* Every horizontal run goes one way: right. */
    for (const d of [a, b]) {
      const xs = points(d).map((p) => p.x);
      expect(xs.every((x, i) => !i || x >= xs[i - 1]!)).toBe(true);
      expect(through(d, obstacles(spec))).toBe(false);
    }
  });

  test("several wires at once: two cards of one column share their trunk from the seat, a drop to another column shares nothing", () => {
    const { act, wire, seatPorts, spec } = layout({ ...WIDE, placement: "top", cards: {
      a: ["assigned", [652, 935, 1146, 1040]], b: ["assigned", [652, 1050, 1146, 1075]], c: ["blocked", [1188, 935, 1517, 1060]], i: ["inbox", [281, 935, 610, 1060]],
    } });
    act("a", "b", "c", "i");
    const [a, b, c, i] = ["a", "b", "c", "i"].map((id) => wire(id)!);
    for (const d of [a, b, c, i]) expect(through(d, obstacles(spec))).toBe(false);
    expect([a, b, c, i].map(bends)).toEqual([1, 1, 1, 2]);
    /* One trunk for a column: the same start; different columns: different starts. */
    expect(a.split(" ")[0]).toBe(b.split(" ")[0]);
    expect(new Set([a, c, i].map((d) => d.split(" ")[0])).size).toBe(3);
    /* A port on the seat at each of the three exits. */
    expect(seatPorts().sort()).toEqual([a, c, i].map((d) => d.split(" ")[0]!).sort());
    expect(shared(a, b).trunk).toBeGreaterThan(50);
    for (const [one, other] of [[a, b], [a, c], [a, i], [b, c], [b, i], [c, i]]) expect(shared(one!, other!).elsewhere).toBe(0);
    for (const [one, other] of [[a, c], [a, i], [c, i]]) expect(shared(one!, other!).trunk).toBe(0);
  });

  test("seat on top narrowed, two target columns on its left: one exit, a shared run from it as their trunk, each down its own gutter", () => {
    /* 1920-top-narrow-*-several: Inbox and In progress both lie left of the seat, Waiting under it. */
    const { act, wire, seatPorts, spec } = layout({ ...WIDE, seat: [764, 60, 1404, 870], placement: "top", cards: {
      i: ["inbox", [281, 935, 610, 1060]], a: ["assigned", [652, 935, 1146, 1040]], c: ["blocked", [1188, 935, 1517, 1060]],
    } });
    act("i", "a", "c");
    const [i, a, c] = ["i", "a", "c"].map((id) => wire(id)!);
    for (const d of [i, a, c]) expect(through(d, obstacles(spec))).toBe(false);
    expect([i, a, c].map(bends)).toEqual([2, 2, 1]);
    /* Both leave the foot of the seat's left side; the drop leaves its bottom edge at its own gutter. */
    expect(i.startsWith("M764,856 ")).toBe(true);
    expect(a.startsWith("M764,856 ")).toBe(true);
    expect(c.startsWith("M1166,870 ")).toBe(true);
    expect(seatPorts().sort()).toEqual(["M1166,870", "M764,856"]);
    /* The trunk is the run from the exit to the nearer gutter (764 to 630); past it nothing is shared. */
    expect(shared(a, i).trunk).toBeGreaterThan(120);
    expect(shared(a, i).trunk).toBeLessThan(140);
    for (const [one, other] of [[i, a], [a, i], [i, c], [a, c]]) expect(shared(one!, other!).elsewhere).toBe(0);
    for (const other of [i, a]) expect(shared(c, other).trunk).toBe(0);
  });

  test("seat at the side, several columns: every bus wire leaves the one exit and shares the bus as its trunk, nothing after its gutter", () => {
    /* 1440-side-*-several. */
    const { act, wire, seatPorts, spec } = layout({ ...SIDE, columns: { ...SIDE.columns, blocked: [1214, 100, 1494, 884] }, placement: "side", cards: {
      i: ["inbox", [443, 153, 697, 442]], a: ["assigned", [735, 153, 1189, 460]], b: ["assigned", [735, 475, 1189, 700]], c: ["blocked", [1227, 153, 1481, 442]],
    } });
    act("i", "a", "b", "c");
    const [i, a, b, c] = ["i", "a", "b", "c"].map((id) => wire(id)!);
    for (const d of [i, a, b, c]) expect(through(d, obstacles(spec))).toBe(false);
    expect([i, a, b, c].map(bends)).toEqual([0, 2, 2, 2]);
    expect(new Set([a, b, c].map((d) => d.split(" ")[0])).size).toBe(1);
    expect(seatPorts().sort()).toEqual([a, i].map((d) => d.split(" ")[0]!).sort());
    /* The bus from the seat to In progress's gutter (414 to 713) carries all three. */
    expect(shared(c, a).trunk).toBeGreaterThan(280);
    const pairs = [[i, a], [i, b], [i, c], [a, b], [a, c], [b, c]];
    for (const [one, other] of pairs) { expect(shared(one!, other!).elsewhere).toBe(0); expect(shared(other!, one!).elsewhere).toBe(0); }
    for (const other of [a, b, c]) expect(shared(i, other).trunk).toBe(0);
  });

  test("a card scrolled out below its column: the count's wire takes the same one-elbow route", () => {
    const { act, stub, spec } = layout({ ...WIDE, placement: "top", cards: { far: ["assigned", [652, 1400, 1146, 1600]] } });
    act("far");
    const d = stub()!;
    expect(bends(d)).toBe(1);
    expect(through(d, obstacles(spec))).toBe(false);
  });

  test("a card scrolled out above its column: the count sits at the scroller's top, one elbow down from the seat's foot", () => {
    /* 1920-top-*-hidden-above. */
    const { act, stub, spec } = layout({ ...WIDE, placement: "top", cards: { far: ["assigned", [652, 600, 1146, 800]] } });
    act("far");
    const d = stub()!;
    expect(document.querySelector(".oa-stub")!.textContent).toBe("↑ +1");
    expect(bends(d)).toBe(1);
    expect(d.startsWith("M630,870 ")).toBe(true);
    /* Into the count, 16 px under the scroller's top (882 + 46). */
    expect(points(d).at(-1)).toEqual({ x: 649, y: 944 });
    expect(through(d, obstacles(spec))).toBe(false);
    expect(length(d)).toBeLessThan(100);
  });

  test("a card scrolled out above its column in the other layouts: the count's wire takes the layout's own route", () => {
    const above = (spec: Parameters<typeof layout>[0], status: string) => {
      const column = spec.columns[status]!;
      const made = layout({ ...spec, cards: { far: [status, [column[0] + 13, column[1] - 300, column[2] - 13, column[1] - 100]] } });
      made.act("far");
      const d = made.stub()!;
      expect(document.querySelector(".oa-stub")!.textContent).toBe("↑ +1");
      expect(points(d).at(-1)).toEqual({ x: column[0] + 10, y: column[1] + 46 + 16 });
      /* The card itself is out of sight, above the scroller: the seat and the links are what is in the way. */
      expect(through(d, obstacles({ ...spec, cards: {} }))).toBe(false);
      if (spec.strip) expect(made.seatPorts().every((port) => offStrip(spec.strip!, port) <= 8)).toBe(true);
      document.body.replaceChildren();
      return d;
    };
    /* 1440-top-*-hidden-above: round the row of links. */
    expect(bends(above({ ...SCROLL, placement: "top", cards: {} }, "assigned"))).toBe(3);
    /* 1440-top-folded-*-hidden-above: from the strip's title, round the end of the row of links. */
    const folded = above({ ...FOLDED_SCROLL, placement: "top", cards: {} }, "assigned");
    expect(bends(folded)).toBe(4);
    expect(folded.startsWith("M447,81 H580 Q586,81 586,87 V139 ")).toBe(true);
    /* 1920-top-folded-*-hidden-above: out of the strip's title to the gutter. */
    const strip = above({ ...FOLDED_WIDE, placement: "top", cards: {} }, "assigned");
    expect(bends(strip)).toBe(2);
    expect(strip.startsWith("M451,81 ")).toBe(true);
    /* 1440-side-*-hidden-above: along the bus. */
    const bus = above({ ...SIDE, placement: "side", cards: {} }, "assigned");
    expect(bends(bus)).toBe(2);
    expect(bus.startsWith("M414,91 ")).toBe(true);
    /* 1000-top-*-hidden-above: the tabs board, out of the seat's left side. */
    const tabs = above({ seat: [260, 135, 988, 177], placement: "top", columns: { assigned: [260, 237, 988, 700] },
      links: [[260, 189, 439, 225], [443, 189, 622, 225], [626, 189, 805, 225], [809, 189, 988, 225]], cards: {} }, "assigned");
    expect(bends(tabs)).toBe(2);
    expect(tabs.startsWith("M260,163 ")).toBe(true);
  });

  /* The seat on top folded to its strip: a transparent box 42 px tall across the board (…-top-folded-en-*).
     With nothing for the operator it has no fill and no frame; what shows is the avatar and the title at
     its left and two buttons at its right, read in the browser at the same layouts. */
  const FOLDED_WIDE = {
    seat: [268, 60, 1900, 102] as R,
    strip: { avatar: [269, 68, 295, 94], title: [303, 72, 443, 90], controls: [[1782, 67, 1810, 95], [1818, 67, 1899, 95]] } as Strip,
    columns: { inbox: [268, 114, 623, 1080] as R, assigned: [639, 114, 1159, 1080] as R, blocked: [1175, 114, 1529, 1080] as R, done: [1545, 114, 1900, 1080] as R },
  };
  const FOLDED_SCROLL = {
    seat: [264, 60, 1424, 102] as R,
    strip: { avatar: [265, 68, 291, 94], title: [299, 72, 439, 90], controls: [[1306, 67, 1334, 95], [1342, 67, 1423, 95]] } as Strip,
    columns: { inbox: [264, 154, 544, 938] as R, assigned: [556, 154, 1036, 938] as R, blocked: [1048, 154, 1328, 938] as R },
    links: [[264, 114, 330, 142], [332, 114, 429, 142], [431, 114, 507, 142], [509, 114, 574, 142]] as R[],
  };

  test("the folded strip on the wide board: out of its avatar to the column left of it, out past its title to the others, no port on empty space", () => {
    const { act, wire, seatPorts, spec } = layout({ ...FOLDED_WIDE, placement: "top", cards: {
      i: ["inbox", [281, 167, 610, 420]], a: ["assigned", [652, 167, 1146, 440]], b: ["assigned", [652, 489, 1146, 700]], c: ["blocked", [1188, 167, 1517, 420]],
    } });
    act("i", "a", "b", "c");
    const [i, a, b, c] = ["i", "a", "b", "c"].map((id) => wire(id)!);
    for (const d of [i, a, b, c]) expect(through(d, obstacles(spec))).toBe(false);
    expect([i, a, b, c].map(bends)).toEqual([2, 2, 2, 2]);
    expect(i.startsWith("M269,81 ")).toBe(true);
    /* 8 px past the title's last letter, level with the avatar's middle. */
    for (const d of [a, b, c]) expect(d.startsWith("M451,81 ")).toBe(true);
    expect([i, a, c].map(length).every((px) => px < 860)).toBe(true);
    expect(length(a)).toBeLessThan(310);
    expect(seatPorts().sort()).toEqual(["M269,81", "M451,81"]);
    for (const port of seatPorts()) expect(offStrip(spec.strip!, port)).toBeLessThanOrEqual(8);
    for (const [one, other] of [[i, a], [i, c], [a, c], [a, b], [b, c]]) expect(shared(one!, other!).elsewhere).toBe(0);
  });

  test("the folded strip over the row of column links: out past its title, round the row's end in four elbows where the margin route is longer", () => {
    const { act, wire, seatPorts, spec } = layout({ ...FOLDED_SCROLL, placement: "top", cards: {
      i: ["inbox", [277, 207, 531, 460]], a: ["assigned", [569, 207, 1023, 500]], b: ["assigned", [569, 529, 1023, 700]], c: ["blocked", [1061, 207, 1315, 460]],
    } });
    act("i", "a", "b", "c");
    const [i, a, b, c] = ["i", "a", "b", "c"].map((id) => wire(id)!);
    for (const d of [i, a, b, c]) expect(through(d, obstacles(spec))).toBe(false);
    expect([i, a, b, c].map(bends)).toEqual([2, 4, 4, 2]);
    expect(i.startsWith("M265,81 ")).toBe(true);
    /* Out past the title, down 12 px past the last link to the bus under the row, back to the gutter. */
    expect(a.startsWith("M447,81 H580 Q586,81 586,87 V139 ")).toBe(true);
    expect(b.startsWith("M447,81 H580 Q586,81 586,87 V139 ")).toBe(true);
    expect(c.startsWith("M447,81 ")).toBe(true);
    /* The margin route out of the avatar has as many bends and runs 451 px. */
    expect(length(a)).toBeLessThan(340);
    expect(seatPorts().sort()).toEqual(["M265,81", "M447,81"]);
    for (const port of seatPorts()) expect(offStrip(spec.strip!, port)).toBeLessThanOrEqual(8);
    for (const [one, other] of [[i, a], [i, c], [a, c], [a, b], [b, c]]) expect(shared(one!, other!).elsewhere).toBe(0);
  });

  test("a folded strip that needs the operator has its frame back: its box is the seat, and a drop leaves its bottom edge", () => {
    const { act, wire, seatPorts } = layout({ ...FOLDED_WIDE, strip: { ...FOLDED_WIDE.strip, state: "needs" }, placement: "top", cards: { a: ["assigned", [652, 167, 1146, 440]] } });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(1);
    expect(d.startsWith("M630,102 ")).toBe(true);
    expect(seatPorts()).toEqual(["M630,102"]);
  });

  test("a column whose scroller shows a few pixels under its header draws no count over the header", () => {
    /* 1280 × 800, the seat on top open: the columns start 4 px above the window's foot (1280-top-en-hidden-below). */
    const { act, stub } = layout({
      seat: [264, 95, 1264, 695], placement: "top", columns: { assigned: [556, 747, 1036, 1396] },
      links: [[264, 707, 337, 735], [339, 707, 442, 735], [444, 707, 527, 735], [529, 707, 601, 735]],
      cards: { far: ["assigned", [569, 900, 1023, 1100]] },
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    act("far");
    expect(stub()).toBeNull();
  });

  test("a full-width row of tabs under the seat: no route through it, the margin route stays", () => {
    /* 1000 × 700, the tabs mode (1000-top-en-*). */
    const { act, wire, spec } = layout({
      seat: [260, 135, 988, 177], placement: "top", columns: { assigned: [260, 237, 988, 700] },
      links: [[260, 189, 439, 225], [443, 189, 622, 225], [626, 189, 805, 225], [809, 189, 988, 225]], cards: { a: ["assigned", [273, 290, 975, 576]] },
    });
    act("a");
    const d = wire("a")!;
    expect(bends(d)).toBe(2);
    expect(through(d, obstacles(spec))).toBe(false);
  });

  test("the phone: the last corner never runs past the card's port", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section data-mobile2-seat-card></section><div data-phone-kanban-column="assigned"><article data-phone-card="task:a"></article></div>`;
    document.body.append(root);
    const place = (selector: string, at: R) => { root.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => box(at); };
    place("[data-mobile2-seat-card]", [12, 58, 378, 116]);
    place("[data-phone-kanban-column]", [0, 169, 390, 787]);
    place("[data-phone-card]", [12, 177, 334, 319]);
    const layer = createOrchestratorWires({ root, phone: true });
    layers.push(layer);
    layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p", at: Date.now() }]);
    const d = root.querySelector("g[data-wire] path.oa-wire")!.getAttribute("d")!;
    /* The corner into the port ends at or before the port: no run back to the left. */
    const [corner, end] = points(d).slice(-2);
    expect(corner!.x).toBeLessThanOrEqual(end!.x);
    expect(bends(d)).toBe(2);
  });
});
