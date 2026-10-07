import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";

/*
 * The seat tick switch in the orchestrator's header (variant 4 of
 * docs/design/seat-tick-slider.md), held claim for claim:
 *
 *  - a press that does not move past the threshold opens the settings the chip
 *    opened and writes nothing; one that does is a drag and never opens them;
 *  - a release writes the nearest stop once, through the settings route, with
 *    the expiry cleared and the reason rule of the design;
 *  - a value that is not a preset, and a temporary one, read as what they are;
 *  - the keyboard steps preview and write once.
 *
 * The route here applies a change the way the module does (the reason it
 * requires off the default, the fields it clears on the default), so what the
 * control shows after a write is a read-back and never the echo of a send.
 */

const dom = new HappyWindow({ innerWidth: 1280, innerHeight: 800 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement, HTMLSelectElement: dom.HTMLSelectElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});
/** Whether the page asks for less motion. */
let reduceMotion = false;
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: reduceMotion && query.includes("prefers-reduced-motion"), media: query, addEventListener() {}, removeEventListener() {},
});

const { SeatTickChip } = await import("./SeatTickChip");
const { resetSeatTickSettingsCacheForTests } = await import("./useSeatTickSettings");
const { resetMaintainerRoleCacheForTests } = await import("./useMaintainerRole");
const { setLocale } = await import("@/lib/i18n");

const PROJECT = "viewer";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const gateway = { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null };

interface Row { enabled: boolean; wakeIntervalMinutes: number | null; reason: string | null; until: string | null }
const DEFAULT_ROW: Row = { enabled: true, wakeIntervalMinutes: null, reason: null, until: null };
/** The stored record. */
let row: Row;

function answer(): SeatTickSettingsAnswer {
  const isDefault = row.enabled && row.wakeIntervalMinutes === null;
  const updatedAt = isDefault && !row.reason ? null : ago(60);
  return {
    maintenance: {
      enabled: false, intervalHours: 3, defaultIntervalHours: 3, minIntervalHours: 1, maxIntervalHours: 168,
      updatedAt: null, setBy: null, live: null, lastRun: null,
      nextEligibleAt: null, nextRunAt: null, waitingOn: "off", pauseReason: null, runsError: null,
    },
    project: PROJECT,
    changed: false,
    at: new Date().toISOString(),
    actor: gateway,
    settings: { project: PROJECT, ...row, monitorPrompt: null, updatedAt, setBy: updatedAt ? gateway : null },
    effective: {
      enabled: row.enabled, wakeIntervalMinutes: row.wakeIntervalMinutes ?? 60, reason: row.reason, monitorPrompt: null, until: row.until,
      isDefault, configured: updatedAt !== null, lapsed: false, updatedAt,
    },
    defaults: { project: PROJECT, ...DEFAULT_ROW, monitorPrompt: null, updatedAt: null, setBy: null },
    defaultWakeIntervalMinutes: 60,
    monitorPromptLength: 0,
    cardText: null,
    policy: { checkIntervalMinutes: 5, staleAfterMinutes: 15, retryGuardWakes: 2 },
    state: { lastCheckAt: ago(3), lastWakeAt: null, lastWakeReasons: [], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
    stateError: null,
    lastRun: null,
    lastDelivery: null,
    journalError: null,
  } as SeatTickSettingsAnswer;
}

const REFUSAL = "instructions (reason) are required when the tick is disabled or its wake interval changes. Write what the seat should do and when it should stop; a quiet tick without instructions is indistinguishable from a broken one";
const realFetch = globalThis.fetch;
const writes: Array<Record<string, unknown>> = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** How long the route takes to answer a write, and a refusal it gives instead. */
let putDelay = 0;
let refuse: string | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/roles")) return json({ revision: "rev-1", health: "ok", launchChoices: [], roles: [] });
  if (!url.startsWith("/api/monitor/seat-tick/settings")) return json({});
  if ((init?.method ?? "GET") !== "PUT") return json(answer());
  const change = JSON.parse(String(init!.body)) as Record<string, unknown>;
  writes.push(change);
  if (putDelay) await new Promise((resolve) => setTimeout(resolve, putDelay));
  if (refuse) return json({ error: refuse }, 400);
  const next: Row = { ...row };
  if ("enabled" in change) next.enabled = change.enabled as boolean;
  if ("wakeIntervalMinutes" in change) next.wakeIntervalMinutes = change.wakeIntervalMinutes as number | null;
  if ("reason" in change) next.reason = change.reason as string | null;
  if ("untilMinutes" in change) next.until = change.untilMinutes === null ? null : new Date(Date.now() + Number(change.untilMinutes) * 60_000).toISOString();
  const isDefault = next.enabled && next.wakeIntervalMinutes === null;
  if (!isDefault && !next.reason) return json({ error: REFUSAL }, 400);
  if (isDefault) next.until = null;
  row = next;
  return json({ ...answer(), changed: true });
}) as typeof fetch;

const roots = new Set<Root>();
beforeEach(() => {
  resetSeatTickSettingsCacheForTests();
  resetMaintainerRoleCacheForTests();
  setLocale("en");
  reduceMotion = false;
  writes.length = 0;
  putDelay = 0;
  refuse = null;
  row = { ...DEFAULT_ROW };
});
afterEach(() => {
  for (const root of [...roots]) {
    roots.delete(root);
    flushSync(() => root.unmount());
  }
  dom.document.body.replaceChildren();
});
afterAll(() => {
  globalThis.fetch = realFetch;
  setLocale("en");
});

const view = () => <SeatTickChip project={PROJECT} projectName="Viewer" />;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(root: Root, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await sleep(0);
    flushSync(() => root.render(view()));
  }
}

async function mount(): Promise<Root> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(view()));
  await settle(root);
  return root;
}

/** A new mount over a record the test just replaced: the hook keeps the last
    answer it read, so only a fresh one reads the new record. */
async function remount(): Promise<Root> {
  for (const root of [...roots]) {
    roots.delete(root);
    flushSync(() => root.unmount());
  }
  dom.document.body.replaceChildren();
  resetSeatTickSettingsCacheForTests();
  return mount();
}

const body = () => dom.document.body as unknown as HTMLElement;
const control = () => body().querySelector('[role="slider"]') as HTMLElement;
const thumb = () => control().querySelector("[data-seat-tick-thumb]") as HTMLElement;
const popover = () => body().querySelector("[data-seat-tick-popover]") as HTMLElement | null;
const position = () => Number(control().getAttribute("aria-valuenow"));

type Pointer = "mouse" | "touch" | "pen";
const X0 = 400;
function pointer(type: string, kind: Pointer, x: number): void {
  const Ctor = (dom.PointerEvent ?? dom.MouseEvent) as unknown as new (type: string, init: Record<string, unknown>) => Event;
  const event = new Ctor(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: kind, button: 0, clientX: x, clientY: 300 });
  flushSync(() => { control().dispatchEvent(event); });
}
/** A move is a continuous event, so React renders it on its own turn. */
const rendered = () => sleep(8);
const click = () => flushSync(() => control().click());
const key = (name: string) => flushSync(() => {
  control().dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as Event);
});

/**
 * One whole gesture, the way a browser delivers it: press, the moves, a rest
 * so the release is not read as a flick, the release, and the click a release
 * on the same element is followed by.
 */
async function drag(root: Root, by: number[], options: { kind?: Pointer; rest?: number } = {}): Promise<void> {
  const kind = options.kind ?? "mouse";
  pointer("pointerdown", kind, X0);
  for (const dx of by) pointer("pointermove", kind, X0 + dx);
  await sleep(options.rest ?? 110);
  pointer("pointerup", kind, X0 + (by[by.length - 1] ?? 0));
  click();
  await settle(root);
}

const SET_10 = "The operator set the activity slider to «every 10 minutes».";
const SET_4H = "The operator set the activity slider to «every 4 hours».";
const OFF = "Turned off with the activity slider in the orchestrator header. Stays off until the operator moves the slider back.";

test("the control is a slider that names itself, its range and the settings it opens", async () => {
  await mount();
  const slider = control();
  expect(slider.getAttribute("tabindex")).toBe("0");
  expect(slider.getAttribute("aria-label")).toBe("Seat tick activity");
  expect(slider.getAttribute("aria-valuemin")).toBe("0");
  expect(slider.getAttribute("aria-valuemax")).toBe("3");
  expect(slider.getAttribute("aria-valuenow")).toBe("2");
  expect(slider.getAttribute("aria-valuetext")).toBe("every hour, the default. every 60 min · last check 3m ago");
  expect(slider.getAttribute("aria-haspopup")).toBe("dialog");
  expect(slider.getAttribute("aria-expanded")).toBe("false");
  expect(thumb().textContent).toBe("1 h");
  expect(thumb().getAttribute("data-seat-tick-thumb")).toBe("preset");
  /* The health dot is the control's last child, outside the pill. */
  const dot = slider.querySelector("[data-seat-tick-dot]")!;
  expect(dot.getAttribute("data-seat-tick-dot")).toBe("ok");
  expect(slider.querySelector("[data-seat-tick-track]")!.contains(dot)).toBe(false);
});

test("a press that does not move opens the same settings and writes nothing; a second one closes them", async () => {
  const root = await mount();
  await drag(root, []);
  expect(popover()).not.toBeNull();
  expect(popover()!.querySelector("[data-seat-tick-enabled]")).not.toBeNull();
  expect(control().getAttribute("aria-expanded")).toBe("true");
  await drag(root, []);
  expect(popover()).toBeNull();
  expect(writes).toEqual([]);
});

test("a mouse drags past 4 px and a finger past 8 px; under that the press is still a click", async () => {
  const root = await mount();
  /* Exactly on the threshold is not past it. */
  await drag(root, [4]);
  expect(popover()).not.toBeNull();
  await drag(root, [-4]);
  expect(popover()).toBeNull();

  await drag(root, [8], { kind: "touch" });
  expect(popover()).not.toBeNull();
  await drag(root, [8], { kind: "pen" });
  expect(popover()).toBeNull();
  expect(writes).toEqual([]);

  /* Past it the press is a drag: it never opens the settings, even when it
     ends nearest the stop it started on. */
  await drag(root, [5]);
  await drag(root, [9], { kind: "touch" });
  expect(popover()).toBeNull();
  expect(writes).toEqual([]);

  /* And far enough to reach the next stop, it writes it. */
  await drag(root, [12, 14], { kind: "touch" });
  expect(writes).toHaveLength(1);
  expect(writes[0]!.wakeIntervalMinutes).toBe(10);
});

test("the thumb follows the pointer while it is held, previewing the stop it would land on", async () => {
  await mount();
  pointer("pointerdown", "mouse", X0);
  pointer("pointermove", "mouse", X0 - 30);
  await rendered();
  expect(control().getAttribute("data-seat-tick-switch")).toBe("dragging");
  /* 30 px of a 20 px step, from the default at 2. */
  expect(position()).toBe(0.5);
  expect(thumb().textContent).toBe("4 h");
  expect(control().getAttribute("aria-valuetext")).toBe("every 4 hours");
  pointer("pointermove", "mouse", X0 - 31);
  await rendered();
  expect(thumb().textContent).toBe("off");
  /* The control is the handle: travel is clamped to the ends. */
  pointer("pointermove", "mouse", X0 + 400);
  await rendered();
  expect(position()).toBe(3);
  pointer("pointercancel", "mouse", X0 + 400);
  await rendered();
  expect(control().getAttribute("data-seat-tick-switch")).toBe("rest");
  expect(position()).toBe(2);
  expect(writes).toEqual([]);
});

test("each stop writes its schedule once, clears the expiry, and the switch replaces and clears its own sentence", async () => {
  const root = await mount();
  await drag(root, [10, 20]);
  expect(writes).toEqual([{ project: PROJECT, enabled: true, wakeIntervalMinutes: 10, untilMinutes: null, reason: SET_10 }]);
  expect(thumb().textContent).toBe("10 min");
  expect(position()).toBe(3);

  await drag(root, [-30, -62]);
  expect(writes[1]).toEqual({ project: PROJECT, enabled: false, untilMinutes: null, reason: OFF });
  expect(thumb().textContent).toBe("off");

  await drag(root, [10, 19]);
  expect(writes[2]).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: 240, untilMinutes: null, reason: SET_4H });
  expect(thumb().textContent).toBe("4 h");

  /* Back on the default the sentence the switch wrote is cleared, so an hourly
     tick does not keep delivering «set to every 4 hours». */
  await drag(root, [10, 21]);
  expect(writes[3]).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null, reason: null });
  expect(row).toEqual(DEFAULT_ROW);
  expect(writes).toHaveLength(4);
});

test("a move made while the previous write is in flight is written after it, and never opens the settings", async () => {
  putDelay = 400;
  const root = await mount();
  await drag(root, [10, 20]);
  expect(control().getAttribute("aria-busy")).toBe("true");
  /* From 10 min, back to off before the route has answered. */
  await drag(root, [-30, -62]);
  expect(popover()).toBeNull();
  /* The thumb stays where it was released while it waits its turn. */
  expect(position()).toBe(0);
  await sleep(1000);
  await settle(root);
  expect(popover()).toBeNull();
  expect(writes).toEqual([
    { project: PROJECT, enabled: true, wakeIntervalMinutes: 10, untilMinutes: null, reason: SET_10 },
    /* Measured against the record the first write came back with: the
       switch's own sentence is replaced. */
    { project: PROJECT, enabled: false, untilMinutes: null, reason: OFF },
  ]);
  expect(row).toEqual({ enabled: false, wakeIntervalMinutes: 10, reason: OFF, until: null });
  expect(control().getAttribute("data-seat-tick-stop")).toBe("0");
  expect(thumb().textContent).toBe("off");
});

test("a keyboard step committed while a write is in flight waits for it too", async () => {
  putDelay = 300;
  const root = await mount();
  await drag(root, [10, 20]);
  key("ArrowLeft");
  key("ArrowLeft");
  key("ArrowLeft");
  key("Enter");
  await settle(root);
  expect(popover()).toBeNull();
  expect(position()).toBe(0);
  await sleep(800);
  await settle(root);
  expect(writes.map((write) => write.enabled)).toEqual([true, false]);
  expect(thumb().textContent).toBe("off");
  expect(popover()).toBeNull();
});

test("of several moves during one write only the last is sent, and nothing when it ends where that write lands", async () => {
  putDelay = 300;
  const root = await mount();
  await drag(root, [10, 20]);
  await drag(root, [-30, -62]);
  await drag(root, [10, 19]);
  expect(popover()).toBeNull();
  await sleep(800);
  await settle(root);
  expect(writes.map((write) => write.wakeIntervalMinutes)).toEqual([10, 240]);
  expect(thumb().textContent).toBe("4 h");

  /* To 10 min, off while that is in flight, then back to 10 min: the record
     the write comes back with already holds it. */
  writes.length = 0;
  await drag(root, [10, 40]);
  await drag(root, [-30, -62]);
  await drag(root, [30, 62]);
  await sleep(800);
  await settle(root);
  expect(writes.map((write) => write.wakeIntervalMinutes)).toEqual([10]);
  expect(thumb().textContent).toBe("10 min");
  expect(popover()).toBeNull();
});

test("a move the route refuses rolls the thumb back and opens the settings with the server's own words; a move queued behind it is dropped", async () => {
  putDelay = 300;
  refuse = REFUSAL;
  const root = await mount();
  await drag(root, [10, 20]);
  await drag(root, [-30, -62]);
  await sleep(800);
  await settle(root);
  expect(writes).toHaveLength(1);
  expect(popover()).not.toBeNull();
  expect(popover()!.querySelector("[data-seat-tick-error]")).not.toBeNull();
  expect(thumb().textContent).toBe("1 h");
  expect(position()).toBe(2);
  expect(row).toEqual(DEFAULT_ROW);
});

test("a reason a person wrote is never sent over, on any stop", async () => {
  row = { enabled: true, wakeIntervalMinutes: 240, reason: "a release afternoon", until: null };
  const root = await mount();
  await drag(root, [-10, -20]);
  expect(writes[0]).toEqual({ project: PROJECT, enabled: false, untilMinutes: null });
  await drag(root, [30, 60]);
  expect(writes[1]).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: 10, untilMinutes: null });
  await drag(root, [-10, -20]);
  expect(writes[2]).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null });
  expect(row.reason).toBe("a release afternoon");
});

test("the sentence is written in the interface language, and the other language's is still the switch's own", async () => {
  row = { enabled: true, wakeIntervalMinutes: 10, reason: SET_10, until: null };
  setLocale("uk");
  const root = await mount();
  expect(control().getAttribute("aria-label")).toBe("Активність тікера оркестратора");
  expect(thumb().textContent).toBe("10 хв");
  await drag(root, [-30, -60]);
  expect(writes[0]).toEqual({
    project: PROJECT, enabled: false, untilMinutes: null,
    reason: "Вимкнено повзунком активності в шапці оркестратора. Лишається вимкненим, доки оператор не пересуне повзунок.",
  });
  expect(thumb().textContent).toBe("вимк.");
  await drag(root, [10, 20]);
  expect(writes[1]!.reason).toBe("Оператор поставив повзунок активності на «кожні 4 години».");
  setLocale("en");
  await settle(root);
  await drag(root, [10, 20]);
  expect(writes[2]).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null, reason: null });
});

test("a flick carries to the end the slow drag would not reach", async () => {
  row = { enabled: true, wakeIntervalMinutes: 10, reason: "a release afternoon", until: null };
  const root = await mount();
  /* 24 px is a little over one stop; released at rest it lands on 1 h. */
  await drag(root, [-12, -24]);
  expect(writes[0]).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null });

  row = { enabled: true, wakeIntervalMinutes: 10, reason: "a release afternoon", until: null };
  const again = await remount();
  /* The same distance released while still moving goes on to off. A last move
     with no distance, which browsers deliver, does not hide the speed. */
  await drag(again, [-8, -16, -24, -24], { rest: 0 });
  expect(writes[1]).toEqual({ project: PROJECT, enabled: false, untilMinutes: null });
});

test("a release on the stop already set writes nothing, and leaves an expiry alone", async () => {
  const until = new Date(Date.now() + 150 * 60_000).toISOString();
  row = { enabled: true, wakeIntervalMinutes: 10, reason: "a release afternoon", until };
  const root = await mount();
  await drag(root, [-30, -4]);
  await drag(root, [30, 40]);
  expect(writes).toEqual([]);
  expect(row.until).toBe(until);
  /* A real move is the one thing that clears it. */
  await drag(root, [-10, -20]);
  expect(writes).toEqual([{ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null }]);
  expect(row.until).toBeNull();
});

test("Escape during a drag puts the thumb back and writes nothing", async () => {
  const root = await mount();
  pointer("pointerdown", "mouse", X0);
  pointer("pointermove", "mouse", X0 + 20);
  await rendered();
  expect(position()).toBe(3);
  key("Escape");
  expect(position()).toBe(2);
  pointer("pointerup", "mouse", X0 + 20);
  click();
  await settle(root);
  expect(writes).toEqual([]);
  expect(popover()).toBeNull();
});

test("a value that is not a preset sits between the stops, says its exact number and wears a dashed thumb", async () => {
  row = { enabled: true, wakeIntervalMinutes: 15, reason: "a release afternoon", until: null };
  await mount();
  expect(thumb().textContent).toBe("15 min");
  expect(thumb().getAttribute("data-seat-tick-thumb")).toBe("custom");
  expect(thumb().getAttribute("style")).toContain("dashed");
  expect(position()).toBe(2.77);
  expect(control().getAttribute("aria-valuetext")).toBe("15 min, not a preset. every 15 min · last check 3m ago");

  for (const [minutes, word, low, high] of [[120, "2 h", 1.49, 1.51], [720, "12 h", 0.2, 0.99], [90, "90 min", 1.01, 1.99], [5, "5 min", 3, 3], [20160, "14 d", 0.2, 0.2]] as const) {
    row = { enabled: true, wakeIntervalMinutes: minutes, reason: "a release afternoon", until: null };
    await remount();
    expect(thumb().textContent).toBe(word);
    expect(thumb().getAttribute("data-seat-tick-thumb")).toBe("custom");
    expect(position()).toBeGreaterThanOrEqual(low);
    expect(position()).toBeLessThanOrEqual(high);
  }
});

test("a temporary setting shows the hourglass outside the pill and says until when", async () => {
  row = { enabled: true, wakeIntervalMinutes: 10, reason: "a release afternoon", until: new Date(Date.now() + 150 * 60_000).toISOString() };
  await mount();
  expect(thumb().textContent).toBe("10 min");
  expect(thumb().getAttribute("data-seat-tick-thumb")).toBe("preset");
  const glass = control().querySelector("[data-seat-tick-until]")!;
  expect(glass).not.toBeNull();
  expect(control().querySelector("[data-seat-tick-track]")!.contains(glass)).toBe(false);
  expect(control().getAttribute("aria-valuetext")).toMatch(/^every 10 minutes, until (\d+ \w+, )?\d\d:\d\d\. every 10 min · last check 3m ago$/);
});

test("arrows preview and write once after the last one; Enter writes a pending step at once", async () => {
  row = { enabled: false, wakeIntervalMinutes: null, reason: "a release afternoon", until: null };
  const root = await mount();
  key("ArrowRight");
  key("ArrowUp");
  key("PageUp");
  expect(control().getAttribute("data-seat-tick-switch")).toBe("pending");
  expect(position()).toBe(3);
  expect(thumb().textContent).toBe("10 min");
  expect(control().getAttribute("aria-valuetext")).toBe("every 10 minutes");
  expect(writes).toEqual([]);
  await sleep(760);
  await settle(root);
  expect(writes).toEqual([{ project: PROJECT, enabled: true, wakeIntervalMinutes: 10, untilMinutes: null }]);

  key("ArrowLeft");
  key("ArrowDown");
  key("Enter");
  await settle(root);
  expect(writes[1]).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: 240, untilMinutes: null });
  await sleep(760);
  expect(writes).toHaveLength(2);

  key("End");
  expect(position()).toBe(3);
  key("Home");
  expect(position()).toBe(0);
  key("PageDown");
  expect(position()).toBe(0);
  /* Escape drops the step; nothing is written when its time comes. */
  key("Escape");
  expect(control().getAttribute("data-seat-tick-switch")).toBe("rest");
  expect(position()).toBe(1);
  await sleep(760);
  expect(writes).toHaveLength(2);
});

test("Enter and Space open the settings while no step is pending", async () => {
  const root = await mount();
  key("Enter");
  await settle(root);
  expect(popover()).not.toBeNull();
  key(" ");
  await settle(root);
  expect(popover()).toBeNull();
  expect(writes).toEqual([]);
});

test("from a value between stops an arrow goes to the neighbouring stop in that direction", async () => {
  row = { enabled: true, wakeIntervalMinutes: 15, reason: "a release afternoon", until: null };
  await mount();
  key("ArrowLeft");
  expect(position()).toBe(2);
  expect(thumb().textContent).toBe("1 h");
  key("Escape");
  key("ArrowRight");
  expect(position()).toBe(3);
  expect(thumb().textContent).toBe("10 min");
  key("Escape");
  expect(writes).toEqual([]);
});

test("with less motion asked for the thumb is drawn where it is, with no spring", async () => {
  reduceMotion = true;
  await mount();
  expect(control().style.getPropertyValue("--tick-pos")).toBe("2.0000");
  pointer("pointerdown", "mouse", X0);
  pointer("pointermove", "mouse", X0 + 10);
  await rendered();
  expect(control().style.getPropertyValue("--tick-pos")).toBe("2.5000");
  expect(control().style.getPropertyValue("--tick")).toBe("color-mix(in oklch, var(--tick-3) 50%, var(--tick-2))");
  pointer("pointercancel", "mouse", X0 + 10);
  await rendered();
  expect(control().style.getPropertyValue("--tick-pos")).toBe("2.0000");
});

test("otherwise the thumb travels: it trails the pointer and has arrived a moment after the release", async () => {
  const root = await mount();
  pointer("pointerdown", "mouse", X0);
  pointer("pointermove", "mouse", X0 + 20);
  await rendered();
  /* The target moved at once; the drawn thumb has not jumped there. */
  expect(position()).toBe(3);
  expect(Number(control().style.getPropertyValue("--tick-pos"))).toBeLessThan(2.6);
  await sleep(110);
  const trailing = Number(control().style.getPropertyValue("--tick-pos"));
  expect(trailing).toBeGreaterThan(2.3);
  pointer("pointerup", "mouse", X0 + 20);
  click();
  await settle(root);
  await sleep(700);
  expect(control().style.getPropertyValue("--tick-pos")).toBe("3.0000");
  expect(control().style.getPropertyValue("--tick")).toBe("var(--tick-3)");
});
