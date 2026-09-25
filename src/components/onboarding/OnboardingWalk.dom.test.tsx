import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * #2166 §3.8: the interface walk. It starts by itself once, when the current
 * project's seat is live on an install that is not an `existing-install` and
 * whose walk never ran; Skip, Escape and the last button write `walk`, and the
 * menu row starts it again, or opens the guide where no seat is live.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  CustomEvent: dom.CustomEvent,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const LIVE_SEAT = {
  seat: {
    project: "todo-cli", seatEpoch: 1, conversationId: "conv-seat", path: "/tmp/seat.jsonl", mandate: "m", promptVersion: 27,
    state: "active", intent: { clientRequestId: "r1", mode: "spawn" }, designatedAt: "2026-09-25T10:00:00.000Z",
  },
  pending: null,
  exists: true,
  viewerMcpRegistered: true,
  previous: [],
};

let seatBody: unknown = { seat: null, pending: null, exists: false, previous: [] };
const puts: unknown[] = [];
Object.assign(globalThis, {
  fetch: (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/orchestrator/seat")) return Promise.resolve(new Response(JSON.stringify(seatBody), { status: 200 }));
    if (url.includes("/api/onboarding") && init?.method === "PUT") {
      const patch = JSON.parse(String(init.body)) as { walk?: string };
      puts.push(patch);
      return Promise.resolve(new Response(JSON.stringify({ marker: { ...marker("fresh"), walk: patch.walk ?? null } }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  },
});

const { OnboardingWalk, walkLayout, WALK_EDGE } = await import("./OnboardingWalk");
const { publishOnboarding, resetOnboardingSnapshotForTests } = await import("./useOnboarding");
const { startInterfaceWalk } = await import("./walkStop");
const { resetOrchestratorSeatCacheForTests } = await import("@/components/orchestrator/useOrchestratorSeat");
const { ORCHESTRATOR_DRAFT_EVENT } = await import("@/components/orchestrator/draftPrefill");
type Marker = import("@/lib/onboarding/marker").OnboardingMarker;

function marker(kind: "fresh" | "existing", walk: Marker["walk"] = null): Marker {
  return {
    schemaVersion: 1, completedAt: "2026-09-25T10:00:00.000Z", dismissedAt: kind === "existing" ? "2026-09-25T10:00:00.000Z" : null,
    reason: kind === "existing" ? "existing-install" : null, steps: {} as Marker["steps"], lastHealth: null, walk,
  };
}

afterAll(() => { void dom.happyDOM.close(); });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetOrchestratorSeatCacheForTests();
  resetOnboardingSnapshotForTests();
  puts.length = 0;
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function mount(props: { project: string | null; mobile?: boolean }): Promise<void> {
  act(() => root.render(<OnboardingWalk project={props.project} mobile={props.mobile ?? false} />));
  await settle();
}

const popover = () => document.querySelector<HTMLElement>("[data-walk-popover]");
const click = (element: Element | null) => act(() => { (element as HTMLElement).click(); });

test("a fresh install starts the walk once its seat is live, and Skip writes walk: skipped", async () => {
  seatBody = { seat: null, pending: null, exists: false, previous: [] };
  act(() => publishOnboarding({ loaded: true, marker: marker("fresh"), guideOpen: false }));
  await mount({ project: "todo-cli" });
  expect(popover()).toBeNull();

  /* The seat turns live: the next read says so. */
  act(() => root.unmount());
  resetOrchestratorSeatCacheForTests();
  seatBody = LIVE_SEAT;
  const drafts: unknown[] = [];
  const onDraft = (event: Event) => drafts.push((event as CustomEvent).detail);
  window.addEventListener(ORCHESTRATOR_DRAFT_EVENT, onDraft);
  root = createRoot(host);
  await mount({ project: "todo-cli" });
  window.removeEventListener(ORCHESTRATOR_DRAFT_EVENT, onDraft);
  expect(popover()?.getAttribute("data-walk-popover")).toBe("1");
  expect(popover()?.textContent).toContain("This is your orchestrator");
  /* The desktop opens the project's Board with its seat expanded, through the guide's own "Open it" request. */
  expect(drafts).toEqual([{ project: "todo-cli", launch: null }]);
  /* Focus moves into the popover. */
  expect(document.activeElement?.hasAttribute("data-walk-primary")).toBe(true);

  click(document.querySelector("[data-walk-skip]"));
  await settle();
  expect(popover()).toBeNull();
  expect(puts).toEqual([{ walk: "skipped" }]);

  /* A reload: the marker now says skipped, and the live seat starts nothing. */
  act(() => root.unmount());
  root = createRoot(host);
  await mount({ project: "todo-cli" });
  expect(popover()).toBeNull();
});

test("the walk waits while the setup guide is open", async () => {
  seatBody = LIVE_SEAT;
  act(() => publishOnboarding({ loaded: true, marker: marker("fresh"), guideOpen: true }));
  await mount({ project: "todo-cli" });
  expect(popover()).toBeNull();
  act(() => publishOnboarding({ guideOpen: false }));
  await settle();
  expect(popover()?.getAttribute("data-walk-popover")).toBe("1");
});

test("an existing install never starts it by itself; the menu row does", async () => {
  seatBody = LIVE_SEAT;
  act(() => publishOnboarding({ loaded: true, marker: marker("existing"), guideOpen: false }));
  await mount({ project: "todo-cli" });
  expect(popover()).toBeNull();
  act(() => startInterfaceWalk());
  await settle();
  expect(popover()?.getAttribute("data-walk-popover")).toBe("1");
});

test("the menu row opens the guide where no seat is live, and on the Overview", async () => {
  seatBody = { seat: null, pending: null, exists: false, previous: [] };
  act(() => publishOnboarding({ loaded: true, marker: marker("existing"), guideOpen: false }));
  const opened: unknown[] = [];
  const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener("llv:open-onboarding", onOpen);
  await mount({ project: "todo-cli" });
  act(() => startInterfaceWalk());
  await settle();
  expect(popover()).toBeNull();
  expect(opened).toEqual([{ mode: "guide", step: null }]);
  act(() => root.unmount());
  root = createRoot(host);
  await mount({ project: null });
  act(() => startInterfaceWalk());
  await settle();
  expect(opened).toHaveLength(2);
  window.removeEventListener("llv:open-onboarding", onOpen);
});

test("three stops, then Give it the first task focuses the seat composer and writes walk: done", async () => {
  const seat = document.createElement("section");
  seat.setAttribute("data-walk-anchor", "seat");
  seat.innerHTML = '<div data-orchestrator-conversation="conv-seat"><form><textarea></textarea></form></div>';
  document.body.appendChild(seat);
  seatBody = LIVE_SEAT;
  act(() => publishOnboarding({ loaded: true, marker: marker("fresh"), guideOpen: false }));
  await mount({ project: "todo-cli" });
  click(document.querySelector("[data-walk-primary]"));
  expect(popover()?.getAttribute("data-walk-popover")).toBe("2");
  expect(popover()?.textContent).toContain("Its work shows up on the board");
  click(document.querySelector("[data-walk-primary]"));
  expect(popover()?.getAttribute("data-walk-popover")).toBe("3");
  expect(popover()?.textContent).toContain("Show this again from the menu: Interface walk.");
  expect(document.querySelector("[data-walk-primary]")?.textContent).toBe("Give it the first task");
  click(document.querySelector("[data-walk-primary]"));
  await settle();
  expect(popover()).toBeNull();
  expect(puts).toEqual([{ walk: "done" }]);
  expect(document.activeElement).toBe(seat.querySelector("textarea"));
});

test("Escape skips from any stop, wherever focus is", async () => {
  seatBody = LIVE_SEAT;
  act(() => publishOnboarding({ loaded: true, marker: marker("fresh"), guideOpen: false }));
  await mount({ project: "todo-cli" });
  click(document.querySelector("[data-walk-primary]"));
  act(() => { document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
  await settle();
  expect(popover()).toBeNull();
  expect(puts).toEqual([{ walk: "skipped" }]);
});

test("the phone's third stop gives the dock the press, which opens the seat's conversation", async () => {
  const dock = document.createElement("button");
  dock.setAttribute("data-walk-anchor", "seat");
  let pressed = 0;
  dock.addEventListener("click", () => { pressed += 1; });
  document.body.appendChild(dock);
  seatBody = LIVE_SEAT;
  act(() => publishOnboarding({ loaded: true, marker: marker("fresh"), guideOpen: false }));
  await mount({ project: "todo-cli", mobile: true });
  expect(popover()?.textContent).toContain("Tap here to write to it");
  click(document.querySelector("[data-walk-primary]"));
  click(document.querySelector("[data-walk-primary]"));
  expect(popover()?.textContent).toContain("a count appears here");
  click(document.querySelector("[data-walk-primary]"));
  await settle();
  expect(pressed).toBe(1);
});

/* ── Placement ─────────────────────────────────────────────────────────── */

const inside = (pop: { left: number; top: number; width: number }, height: number, viewport: { width: number; height: number }) =>
  pop.left >= 0 && pop.top >= 0 && pop.left + pop.width <= viewport.width && pop.top + height <= viewport.height;

test("the spotlight stays in its pane and the popover on screen", () => {
  const viewport = { width: 1280, height: 800 };
  const pane = { left: 248, top: 0, right: 1280, bottom: 800 };
  /* The board frame starts flush with the pane: the 4 px margin is clipped, never drawn over the rail. */
  const board = walkLayout({ anchor: { left: 248, top: 380, right: 1280, bottom: 800 }, pane, viewport, popHeight: 210, phone: false });
  expect(board.hole).toEqual({ left: 248, top: 376, right: 1280, bottom: 800 });
  expect(inside(board.pop, 210, viewport)).toBe(true);
  expect(board.pop.left).toBeGreaterThanOrEqual(pane.left + WALK_EDGE);
  /* No room below, and the board holds it: over the board's lower part, without a pointer (mockup walk-2). */
  expect(board.pop.top).toBe(800 - 210 - WALK_EDGE);
  expect(board.arrow).toBeNull();
  /* A short anchor with no room below: above it, pointing down. */
  const low = walkLayout({ anchor: { left: 400, top: 700, right: 900, bottom: 760 }, pane, viewport, popHeight: 210, phone: false });
  expect(low.pop.top).toBe(696 - WALK_EDGE - 210);
  expect(low.arrow?.edge).toBe("bottom");

  /* The composer: the popover under it, pointing up at it. */
  const composer = walkLayout({ anchor: { left: 278, top: 326, right: 1250, bottom: 376 }, pane, viewport, popHeight: 170, phone: false });
  expect(composer.pop.top).toBe(376 + 4 + WALK_EDGE);
  expect(composer.arrow?.edge).toBe("top");

  /* The island in the corner: right-aligned, under it. */
  const needs = walkLayout({ anchor: { left: 1160, top: 8, right: 1268, bottom: 36 }, pane, viewport, popHeight: 230, phone: false });
  expect(needs.pop.left + needs.pop.width).toBeLessThanOrEqual(1280 - WALK_EDGE);
  expect(inside(needs.pop, 230, viewport)).toBe(true);

  /* The phone: the full width less 12 px on each side, above the dock. */
  const phone = { width: 390, height: 844 };
  const dock = walkLayout({ anchor: { left: 12, top: 780, right: 378, bottom: 824 }, pane: { left: 0, top: 0, right: 390, bottom: 844 }, viewport: phone, popHeight: 190, phone: true });
  expect(dock.pop).toEqual({ left: 12, top: 780 - 4 - WALK_EDGE - 190, width: 366 });
  expect(dock.arrow?.edge).toBe("bottom");

  /* A missing anchor: centred, no spotlight. */
  const missing = walkLayout({ anchor: null, pane, viewport, popHeight: 200, phone: false });
  expect(missing.hole).toBeNull();
  expect(missing.pop).toEqual({ left: 470, top: 300, width: 340 });
});
