import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { ORCHESTRATOR_WIRE_FADE_MS, ORCHESTRATOR_WIRE_HOLD_MS } from "./orchestratorArrows";
import { createOrchestratorWires, type OrchestratorWires } from "./orchestratorWires";

/* The layer's life: nothing while no wire is shown, one wire per card for the
   hold, and nothing left behind after it. Geometry is the browser driver's. */

let dom: Window;
let reduce = true;
const layers: OrchestratorWires[] = [];
beforeEach(() => {
  dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
  Object.assign(globalThis, { window: dom, document: dom.document });
  reduce = true;
  Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} }) });
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
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1" }]);
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
  layer.act([{ kind: "stage", taskId: "far", pipelineId: "p1" }, { kind: "stage", taskId: "a", pipelineId: "p2" }]);
  expect(drawn()).toEqual(["a"]);
  expect([...node()!.querySelectorAll(".oa-stub")].map((chip) => chip.textContent)).toEqual(["↓ +1"]);
});

test("the wire goes when its hold is over, and the layer with the last wire", () => {
  const { layer, node, drawn } = board();
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1" }]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 1_000);
  expect(drawn()).toEqual(["a"]);
  layer.act([{ kind: "pipeline", taskId: "b", pipelineId: "p2" }]);
  expect(drawn()).toEqual(["a", "b"]);
  layer.probe.advance(1_000);
  expect(drawn()).toEqual(["b"]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS);
  expect(node()).toBeNull();
  expect(layer.active).toBe(false);
});

test("a new action on the same card starts its minute again", () => {
  const { layer, drawn, root } = board();
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1" }]);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS - 5_000);
  layer.act([{ kind: "stage", taskId: "a", pipelineId: "p1" }]);
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
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null }]);
  const opacity = () => fades.filter((call) => !call.cancelled && call.frames.length === 2 && "opacity" in call.frames[1]! && call.frames[1]!.opacity === 0 && call.timing.duration === ORCHESTRATOR_WIRE_FADE_MS);
  expect(opacity()).toHaveLength(0);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS);
  expect(drawn()).toEqual(["a"]);
  /* The wire's group and the seat's port, which goes with the last wire. */
  expect(opacity().map((call) => call.node.getAttribute("data-wire") ?? call.node.getAttribute("class"))).toEqual(["a", "oa-port"]);
  /* A new action during the fade brings the wire back whole. */
  layer.act([{ kind: "stage", taskId: "a", pipelineId: null }]);
  expect(opacity()).toHaveLength(0);
  layer.probe.advance(ORCHESTRATOR_WIRE_HOLD_MS + ORCHESTRATOR_WIRE_FADE_MS);
  expect(node()).toBeNull();
});

test("a board with no seat draws nothing", () => {
  const { layer, node } = board({ seat: false });
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1" }]);
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
  layer.act([{ kind: "pipeline", taskId: "a", pipelineId: "p1" }]);
  expect(added.sort()).toEqual(["resize", "scroll"]);
  layer.destroy();
  expect(node()).toBeNull();
  expect(removed.sort()).toEqual(["resize", "scroll"]);
});
