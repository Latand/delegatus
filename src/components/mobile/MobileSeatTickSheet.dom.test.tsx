import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { ORCHESTRATOR_PROMPT_VERSION } from "@/lib/orchestrator/prompt";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";
import type { FileEntry } from "@/lib/types";

/*
 * The seat tick on the phone at 390 px (#1681): the row inside the live seat
 * sheet, and the compact sheet it opens.
 *
 * The claims are the phone's own:
 *
 *  - the row is IN the seat sheet's body, above «Edit the mandate», at the
 *    phone's 44 px, carrying the same summary and the same tone dot the
 *    desktop chip carries;
 *  - tapping it opens the tick sheet, whose × returns to the seat sheet — the
 *    way out is the way in, and neither is a history entry;
 *  - the sheet's footer holds Save, so it rides above the keyboard rather than
 *    scrolling with the interval field;
 *  - a save adopts the record the route read back, and a refusal rolls the
 *    display back with the server's own text.
 */

const dom = new HappyWindow({ innerWidth: 390, innerHeight: 844, url: "http://localhost/" });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement, HTMLSelectElement: dom.HTMLSelectElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: true, media: query, addEventListener() {}, removeEventListener() {},
});

const { MobileOrchestratorSheet } = await import("./MobileOrchestratorSheet");
const { setLocale } = await import("@/lib/i18n");
const { resetSeatTickSettingsCacheForTests } = await import("../orchestrator/useSeatTickSettings");
const { resetMaintainerRoleCacheForTests } = await import("../orchestrator/useMaintainerRole");
import type { OrchestratorPanelState } from "../orchestrator/seatState";

const PROJECT = "atlas";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function record(overrides: Partial<SeatTickSettingsAnswer> = {}): SeatTickSettingsAnswer {
  return {
    maintenance: {
      enabled: false, intervalHours: 3, defaultIntervalHours: 3, minIntervalHours: 1, maxIntervalHours: 168,
      updatedAt: null, setBy: null, live: null, lastRun: null,
      nextEligibleAt: null, nextRunAt: null, waitingOn: "off", pauseReason: null, runsError: null,
    },
    project: PROJECT,
    changed: false,
    at: new Date().toISOString(),
    actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
    settings: { project: PROJECT, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null },
    effective: { enabled: true, wakeIntervalMinutes: 60, reason: null, monitorPrompt: null, until: null, isDefault: true, configured: false, lapsed: false, updatedAt: null },
    defaults: { project: PROJECT, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null },
    defaultWakeIntervalMinutes: 60,
    monitorPromptLength: 0,
    cardText: null,
    policy: { checkIntervalMinutes: 5, staleAfterMinutes: 15, retryGuardWakes: 2 },
    state: { lastCheckAt: ago(3), lastWakeAt: null, lastWakeReasons: [], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
    stateError: null,
    lastRun: null,
    lastDelivery: null,
    journalError: null,
    ...overrides,
  };
}

function paused(): SeatTickSettingsAnswer {
  const base = record();
  return {
    ...base,
    settings: { ...base.settings, enabled: false, reason: "nothing to do until Monday", updatedAt: ago(120) },
    effective: { ...base.effective, enabled: false, reason: "nothing to do until Monday", isDefault: false, configured: true, updatedAt: ago(120) },
  };
}

const seat: OrchestratorSeat = {
  project: PROJECT,
  seatEpoch: 4,
  conversationId: "conversation_orchestrator",
  path: "/transcripts/orchestrator.jsonl",
  mandate: "run the board",
  promptVersion: ORCHESTRATOR_PROMPT_VERSION,
  predecessorConversationId: null,
  state: "active",
  intent: { clientRequestId: "req-11111111", mode: "spawn", launchId: "launch-1", error: null },
  designatedAt: "2026-09-18T09:00:00.000Z",
  activatedAt: "2026-09-18T09:00:02.000Z",
} as OrchestratorSeat;

const live: Extract<OrchestratorPanelState, { kind: "live" }> = {
  kind: "live",
  seat,
  conversationId: seat.conversationId!,
  liveness: "live",
  attention: null,
  bindFailure: null,
  rotation: null,
  transition: null,
} as never;

const file = {
  path: "/transcripts/orchestrator.jsonl", root: "claude-projects", name: "orchestrator.jsonl", project: PROJECT,
  title: "Run the board", engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: Date.now() / 1000,
  size: 1, activity: "live", proc: "running", pid: 3, conversationId: "conversation_orchestrator", model: "opus",
  cwd: "/repo/atlas", projectRoot: "/repo/atlas", pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

interface Recorded { url: string; method: string; body: Record<string, unknown> }

const realFetch = globalThis.fetch;
const requests: Recorded[] = [];
let getAnswer: SeatTickSettingsAnswer;
let putAnswers: Array<{ status: number; body: unknown }>;
/** How long the route takes to answer a write. */
let putDelay = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
  if (url.startsWith("/api/roles")) {
    /* The agent mapping the maintainer picker reads; the phone's tests do not
       write it, so only the read is answered. */
    return json({
      revision: "rev-1",
      launchChoices: [
        { engine: "claude", models: [{ id: "opus", label: "Opus 5.5", shortLabel: "Opus 5.5", use: "review", efforts: ["low", "medium", "high", "xhigh", "max"] }] },
        { engine: "codex", models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", shortLabel: "6.1-Sol", use: "review", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }] },
      ],
      roles: [{ id: "maintainer", name: "Maintainer", config: { engine: "codex", model: "gpt-6.1-sol", effort: "medium" } }],
    });
  }
  if (!url.startsWith("/api/monitor/seat-tick/settings")) return json({});
  if (method === "PUT") {
    const next = putAnswers.length > 1 ? putAnswers.shift()! : putAnswers[0]!;
    if (putDelay) await new Promise((resolve) => setTimeout(resolve, putDelay));
    return json(next.body, next.status);
  }
  return json(getAnswer);
}) as typeof fetch;

/* The card's own wiring, verbatim: the row swaps the sheet for the tick's and
   the tick sheet's close swaps it back (`MobileSeatCard`, `MobileFocusView`). */
function Host() {
  const [sheet, setSheet] = useState<"seat" | "tick">("seat");
  return (
    <MobileOrchestratorSheet
      project={PROJECT}
      projectName="Atlas"
      sheet={sheet}
      now={Date.now() / 1000}
      state={live}
      status={{ seat, pending: null, exists: true, viewerMcpRegistered: false }}
      file={file}
      incumbent={null}
      pendingMandate=""
      submitting={false}
      rotate={{ open: false, seat: null, vacated: false, opening: false, submitting: false, failure: null, onOpen() {}, onCancel() {}, onConfirm() {} }}
      tick={{ onOpen: () => setSheet("tick"), onClose: () => setSheet("seat") }}
      onConfirm={() => {}}
      onRecheck={() => {}}
      onOpenConversation={() => {}}
      onClose={() => {}}
    />
  );
}

const roots = new Set<Root>();
beforeEach(() => {
  resetSeatTickSettingsCacheForTests();
  resetMaintainerRoleCacheForTests();
  requests.length = 0;
  getAnswer = record();
  putAnswers = [{ status: 200, body: record() }];
  putDelay = 0;
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.document.body.style.overflow = "";
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = realFetch;
});

async function settle(root: Root, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => root.render(<Host />));
  }
}

async function mount(): Promise<Root> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(<Host />));
  await settle(root);
  return root;
}

const body = () => dom.document.body as unknown as HTMLElement;
const row = () => body().querySelector("[data-seat-tick-row]") as HTMLElement | null;
/** The label half of the row: the button that opens the tick sheet. */
const rowOpen = () => row()!.querySelector('[data-mobile2-open="tick"]') as HTMLButtonElement;
/** The switch half: its value text carries the closed summary the row used to print. */
const rowSwitch = () => row()!.querySelector('[role="slider"]') as HTMLElement;
const tickSheet = () => body().querySelector('[data-mobile2-sheet="tick"]') as HTMLElement | null;
const seatSheet = () => body().querySelector('[data-mobile2-sheet="seat"]') as HTMLElement | null;
const save = () => body().querySelector("[data-seat-tick-save]") as HTMLButtonElement | null;
const press = (button: HTMLButtonElement | null) => flushSync(() => button!.click());
const interval = () => body().querySelector("[data-seat-tick-interval]") as HTMLInputElement;
const reason = () => body().querySelector("[data-seat-tick-reason]") as HTMLTextAreaElement;
const summary = () => body().querySelector("[data-seat-tick-summary]")?.textContent ?? "";
const puts = () => requests.filter((entry) => entry.method === "PUT" && entry.url.startsWith("/api/monitor/seat-tick/settings"));

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  const props = (element as unknown as Record<string, { onChange(event: unknown): void }>)[key]!;
  element.value = value;
  flushSync(() => props.onChange({ target: element }));
}

async function openTick(root: Root): Promise<void> {
  flushSync(() => rowOpen().click());
  await settle(root);
  expect(tickSheet()).not.toBeNull();
}

test("the live seat sheet carries the tick as a row, above Edit the mandate, with the switch, the same summary and dot", async () => {
  getAnswer = record();
  await mount();
  const entry = row();
  expect(entry).not.toBeNull();
  expect(entry!.className).toContain("min-h-11");
  expect(rowOpen().textContent).toBe("Seat tick");
  expect(entry!.getAttribute("data-seat-tick-row")).toBe("healthy");
  /* The thumb names the stop; the desktop's closed summary, without its
     «Tick:» prefix, is the rest of the value text. */
  expect(rowSwitch().textContent).toBe("1 h");
  expect(rowSwitch().getAttribute("aria-valuetext")).toBe("every hour, the default. every 60 min · last check 3m ago");
  expect(entry!.querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("ok");
  /* Order inside the body: the identity block, then the tick, then the mandate. */
  const sheetBody = seatSheet()!.querySelector("[data-mobile2-sheet-body]")!;
  const order = [...sheetBody.querySelectorAll("[data-orchestrator-incumbent], [data-seat-tick-row], [data-orchestrator-edit-mandate]")]
    .map((element) => element.getAttribute("data-seat-tick-row") !== null
      ? "tick"
      : element.hasAttribute("data-orchestrator-edit-mandate") ? "mandate" : "identity");
  expect(order).toEqual(["identity", "tick", "mandate"]);
});

test("a paused tick reads as off on the row, with a muted dot, and the row never says healthy", async () => {
  getAnswer = paused();
  await mount();
  expect(row()!.getAttribute("data-seat-tick-row")).toBe("paused");
  expect(rowSwitch().textContent).toBe("off");
  expect(rowSwitch().getAttribute("aria-valuetext")).toContain("off since 2h ago");
  expect(row()!.querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("muted");
});

test("an enabled tick with no recent check reads as stale on the row while its face keeps the schedule", async () => {
  getAnswer = record({
    state: { lastCheckAt: ago(40), lastWakeAt: null, lastWakeReasons: [], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
  });
  const root = await mount();
  expect(row()!.getAttribute("data-seat-tick-row")).toBe("stale");
  expect(rowSwitch().textContent).toBe("1 h");
  expect(rowSwitch().getAttribute("aria-valuetext")).toContain("every 60 min · stale: last check 40m ago");
  await openTick(root);
  expect(body().querySelector("[data-seat-tick-status-detail]")?.textContent).toContain("Checks run every 5 min");
  expect(body().querySelector("[data-seat-tick-enabled]")?.getAttribute("aria-checked")).toBe("true");
});

test("the row opens the tick sheet, whose Save rides the footer, and whose × puts the seat sheet back", async () => {
  getAnswer = paused();
  const root = await mount();
  await openTick(root);
  /* One sheet at a time: the tick REPLACES the seat sheet. */
  expect(seatSheet()).toBeNull();
  const sheet = tickSheet()!;
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  expect(sheet.querySelector("h2")?.textContent).toBe("Seat tick · Atlas");
  /* Nothing changed, so there is no Save and no footer. */
  expect(save()).toBeNull();
  /* The status comes first, then the form bound to the stored record. */
  expect(sheet.querySelector("[data-mobile2-sheet-body] [data-seat-tick-status]")).not.toBeNull();
  /* Changing a field brings Save into the footer, outside the scrolling body:
     that is what keeps it above the keyboard when a field is focused. */
  type(reason(), "still waiting on Monday");
  expect(sheet.querySelector("[data-mobile2-sheet-body] [data-seat-tick-save]")).toBeNull();
  expect(sheet.querySelector("[data-seat-tick-save]")).not.toBeNull();
  expect(save()!.className).toContain("min-h-11");
  type(reason(), "nothing to do until Monday");
  expect(save()).toBeNull();
  /* The form is bound to the stored record. */
  expect(body().querySelector("[data-seat-tick-enabled]")?.getAttribute("aria-checked")).toBe("false");
  expect(reason().value).toBe("nothing to do until Monday");

  flushSync(() => (sheet.querySelector("[data-mobile2-close]") as HTMLButtonElement).click());
  await settle(root);
  expect(tickSheet()).toBeNull();
  expect(seatSheet()).not.toBeNull();
  expect(row()).not.toBeNull();
});

test("a save on the phone adopts the record the route read back", async () => {
  const root = await mount();
  await openTick(root);
  type(interval(), "15");
  type(reason(), "watching a release");
  const stored = record({ changed: true });
  stored.settings = { ...stored.settings, wakeIntervalMinutes: 15, reason: "watching a release", updatedAt: new Date().toISOString() };
  stored.effective = { ...stored.effective, wakeIntervalMinutes: 15, reason: "watching a release", isDefault: false, configured: true };
  putAnswers = [{ status: 200, body: stored }];
  press(save());
  await settle(root);

  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, wakeIntervalMinutes: 15, reason: "watching a release" });
  expect(summary()).toContain("every 15 min");
  expect(save()).toBeNull();
  expect(body().querySelector("[data-seat-tick-error]")).toBeNull();
});

const REQUIRED_REFUSAL = "instructions (reason) are required when the tick is disabled or its wake interval changes. Write what the seat should do and when it should stop; a quiet tick without instructions is indistinguishable from a broken one";
const OVER_LIMIT_REFUSAL = "instructions (reason) are 501 characters; the limit is 500. Nothing was stored — shorten the instructions and send them again";

test.each([
  ["en", REQUIRED_REFUSAL, "«Instructions for every wake» is required when disabling wakes or changing the cadence. Write what the agent should do"],
  ["uk", REQUIRED_REFUSAL, "«Вказівки на кожне пробудження» потрібні, щоб вимкнути пробудження або змінити інтервал."],
  ["en", OVER_LIMIT_REFUSAL, "«Instructions for every wake» is 501 characters; the limit is 500."],
  ["uk", OVER_LIMIT_REFUSAL, "«Вказівки на кожне пробудження» перевищують ліміт 500 символів: 501."],
] as const)("a refused save on the phone rolls the display back and shows the panel's own field name (%s)", async (locale, refusal, shown) => {
  setLocale(locale);
  try {
    getAnswer = record();
    const root = await mount();
    await openTick(root);
    type(interval(), "30");
    putAnswers = [{ status: 400, body: { error: refusal } }];
    press(save());
    await settle(root);

    expect(puts()).toHaveLength(1);
    expect(summary()).toContain(locale === "en" ? "every 60 min" : "кожні 60 хв");
    const error = body().querySelector("[data-seat-tick-error]");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain(shown);
    expect(error?.textContent).not.toContain("(reason)");
    /* The field being corrected keeps what was typed into it. */
    expect(interval().value).toBe("30");
  } finally {
    setLocale("en");
  }
});

/*
 * The board maintenance group on the phone (#2162): the same group in the same
 * place, with 44 px targets. The footer's one Save carries it together with
 * the tick, and a link on «N need you» hands the card to the board.
 */

const mGroup = () => body().querySelector("[data-seat-tick-maintenance]") as HTMLElement | null;
const mSwitch = () => body().querySelector("[data-seat-tick-maintenance-enabled]") as HTMLButtonElement;
const mInterval = () => body().querySelector("[data-seat-tick-maintenance-interval]") as HTMLInputElement | null;

test("the tick sheet carries the maintenance group with phone-sized targets and no Save of its own", async () => {
  const root = await mount();
  await openTick(root);
  const sheet = tickSheet()!;
  expect(sheet.querySelector("[data-mobile2-sheet-body] [data-seat-tick-maintenance]")).not.toBeNull();
  /* One Save for the panel: there is no second one in the group. */
  expect(sheet.querySelector("[data-seat-tick-maintenance-save]")).toBeNull();
  expect(mSwitch().className).toContain("h-7 w-12");
  expect(mInterval()).toBeNull();
  press(mSwitch());
  expect(mInterval()!.className).toContain("h-11");
  expect(mInterval()!.value).toBe("3");
  expect(mGroup()!.getAttribute("data-seat-tick-maintenance")).toBe("off");
  /* The agent picker's controls are phone-sized too. */
  const model = body().querySelector("[data-seat-tick-agent-model]") as HTMLSelectElement;
  expect(model.className).toContain("h-11");
  expect(model.value).toBe("gpt-6.1-sol");
});

test("a save on the phone carries maintenance in the footer Save, in one request with the tick", async () => {
  const root = await mount();
  await openTick(root);
  press(mSwitch());
  type(mInterval()!, "2");
  expect(save()).not.toBeNull();
  const stored = record({ changed: true });
  stored.maintenance = { ...stored.maintenance, enabled: true, intervalHours: 2, updatedAt: new Date().toISOString(), waitingOn: null, nextRunAt: new Date(Date.now() + 300_000).toISOString() };
  putAnswers = [{ status: 200, body: stored }];
  press(save());
  await settle(root);

  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, maintenance: { enabled: true, intervalHours: 2 } });
  expect(mGroup()!.getAttribute("data-seat-tick-maintenance")).toBe("on");
  expect(body().querySelector("[data-seat-tick-maintenance-summary]")?.textContent).toBe("Maintenance every 2 h · never run");
  expect(save()).toBeNull();
});

test("a refused save on the phone shows the module's words beside the Save, in the footer", async () => {
  const root = await mount();
  await openTick(root);
  press(mSwitch());
  type(mInterval()!, "9");
  putAnswers = [{ status: 400, body: { error: "maintenance must be an object" } }];
  press(save());
  await settle(root);
  expect(tickSheet()!.querySelector("[data-seat-tick-error]")?.textContent).toBe("maintenance must be an object");
  expect(mInterval()!.value).toBe("9");
  expect(save()).not.toBeNull();
});

test("N need you opens the last run's card through the board's own task-open event, from the status line", async () => {
  getAnswer = record();
  getAnswer.maintenance = {
    ...getAnswer.maintenance, enabled: true, waitingOn: "interval", nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastRun: {
      runId: "run-1", taskId: "hidden-done-card", conversationId: null, state: "succeeded",
      claimedAt: ago(120), launchedAt: ago(119), endedAt: ago(105), failure: null,
      counts: { writes: 3, tasks: 2, status: 1, closed: 1, created: 0, text: 1, details: 0, looks: 0 }, attentionCount: 2,
    },
  };
  const root = await mount();
  await openTick(root);
  expect(mGroup()!.textContent).toContain("Done");
  const link = body().querySelector("[data-seat-tick-status] [data-seat-tick-status-link=\"card\"]") as HTMLButtonElement;
  expect(link.textContent).toBe("2 need you");
  expect(link.className).toContain("min-h-11");
  const navigated: Array<{ kind?: string; id?: string }> = [];
  const listener = (event: Event) => navigated.push((event as CustomEvent).detail);
  dom.window.addEventListener("llv:mcp-navigate", listener as never);
  try {
    press(link);
  } finally {
    dom.window.removeEventListener("llv:mcp-navigate", listener as never);
  }
  expect(navigated).toEqual([{ kind: "task", id: "hidden-done-card" }]);
});

/* The switch in the row (docs/design/seat-tick-slider.md, the phone). */
function finger(type: string, x: number): void {
  const Ctor = (dom.PointerEvent ?? dom.MouseEvent) as unknown as new (type: string, init: Record<string, unknown>) => Event;
  const event = new Ctor(type, { bubbles: true, cancelable: true, pointerId: 3, pointerType: "touch", button: 0, clientX: x, clientY: 500 });
  flushSync(() => { rowSwitch().dispatchEvent(event); });
}

test("a tap on the switch opens the tick sheet, exactly as the label does, and writes nothing", async () => {
  const root = await mount();
  expect(rowSwitch().getAttribute("data-seat-tick-surface")).toBe("mobile");
  finger("pointerdown", 300);
  finger("pointermove", 306);
  finger("pointerup", 306);
  flushSync(() => rowSwitch().click());
  await settle(root);
  expect(tickSheet()).not.toBeNull();
  expect(puts()).toHaveLength(0);
});

test("a horizontal drag on the switch changes the stop from the row, without opening the sheet", async () => {
  const root = await mount();
  const stored = record({ changed: true });
  stored.settings = { ...stored.settings, enabled: false, reason: "off", updatedAt: new Date().toISOString() };
  stored.effective = { ...stored.effective, enabled: false, reason: "off", isDefault: false, configured: true, updatedAt: new Date().toISOString() };
  putAnswers = [{ status: 200, body: stored }];
  finger("pointerdown", 300);
  /* A step is 20 px; two of them, from the default, is off. */
  finger("pointermove", 280);
  finger("pointermove", 258);
  await new Promise((resolve) => setTimeout(resolve, 110));
  finger("pointerup", 258);
  flushSync(() => rowSwitch().click());
  await settle(root);
  expect(tickSheet()).toBeNull();
  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({
    project: PROJECT, enabled: false, untilMinutes: null,
    reason: "Turned off with the activity slider in the orchestrator header. Stays off until the operator moves the slider back.",
  });
  /* The row shows what the route read back. */
  expect(rowSwitch().textContent).toBe("off");
  expect(row()!.getAttribute("data-seat-tick-row")).toBe("paused");
});

test("a drag made while the row's previous write is in flight is written after it, and the thumb stays where it was released", async () => {
  const root = await mount();
  const at = new Date().toISOString();
  const tenMinutes = record({ changed: true });
  const ten = "The operator set the activity slider to «every 10 minutes».";
  const off = "Turned off with the activity slider in the orchestrator header. Stays off until the operator moves the slider back.";
  tenMinutes.settings = { ...tenMinutes.settings, wakeIntervalMinutes: 10, reason: ten, updatedAt: at };
  tenMinutes.effective = { ...tenMinutes.effective, wakeIntervalMinutes: 10, reason: ten, isDefault: false, configured: true, updatedAt: at };
  const stopped = record({ changed: true });
  stopped.settings = { ...stopped.settings, enabled: false, wakeIntervalMinutes: 10, reason: off, updatedAt: at };
  stopped.effective = { ...stopped.effective, enabled: false, wakeIntervalMinutes: 10, reason: off, isDefault: false, configured: true, updatedAt: at };
  putAnswers = [{ status: 200, body: tenMinutes }, { status: 200, body: stopped }];
  putDelay = 300;
  const swipe = async (to: number[]) => {
    finger("pointerdown", 300);
    for (const x of to) finger("pointermove", x);
    await new Promise((resolve) => setTimeout(resolve, 110));
    finger("pointerup", to[to.length - 1]!);
    flushSync(() => rowSwitch().click());
    await settle(root);
  };
  /* One step right is 10 min; three back from there, before it is answered, is off. */
  await swipe([310, 320]);
  expect(rowSwitch().getAttribute("aria-busy")).toBe("true");
  await swipe([280, 240]);
  expect(rowSwitch().textContent).toBe("off");
  await new Promise((resolve) => setTimeout(resolve, 900));
  await settle(root);
  expect(tickSheet()).toBeNull();
  expect(puts().map((entry) => entry.body)).toEqual([
    { project: PROJECT, enabled: true, wakeIntervalMinutes: 10, untilMinutes: null, reason: ten },
    { project: PROJECT, enabled: false, untilMinutes: null, reason: off },
  ]);
  expect(rowSwitch().textContent).toBe("off");
  expect(row()!.getAttribute("data-seat-tick-row")).toBe("paused");
});
