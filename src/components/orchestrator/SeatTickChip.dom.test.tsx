import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";

/*
 * The seat tick chip and its popover on the desktop (#1681).
 *
 * What is held here is the issue's acceptance, claim for claim:
 *
 *  - the CONFIGURED face is the schedule and the dot is the ACTUAL state, so
 *    an enabled tick with a stale check renders as enabled and stale rather
 *    than as either one alone;
 *  - a save displays what was sent and then adopts what the route READ BACK,
 *    never the echo of the request;
 *  - a refused save rolls the displayed values back to the record, shows the
 *    server's own text inline, keeps the field the operator has to correct,
 *    and re-reads the record once instead of retrying the write;
 *  - Escape and an outside pointer close the popover and hand focus back;
 *  - nothing outside `<details>` carries an id, a key or a path.
 *
 * No claim here is about prompt text: the monitor note is the seat's own and
 * is read only on this surface.
 */

const dom = new HappyWindow({ innerWidth: 1280, innerHeight: 800 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement, HTMLSelectElement: dom.HTMLSelectElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const { SeatTickChip } = await import("./SeatTickChip");
const { resetSeatTickSettingsCacheForTests } = await import("./useSeatTickSettings");

const PROJECT = "viewer";
/* Every instant in a fixture is relative to the clock the component reads:
   the reading ages against `Date.now()`, so a pinned calendar date would
   drift by whatever the real date is. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function record(overrides: Partial<SeatTickSettingsAnswer> = {}): SeatTickSettingsAnswer {
  return {
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

/** A record on 30 minutes with a reason, as the route reads it back. */
function configured(overrides: Partial<SeatTickSettingsAnswer> = {}): SeatTickSettingsAnswer {
  const base = record();
  return {
    ...base,
    settings: { ...base.settings, wakeIntervalMinutes: 30, reason: "a release afternoon", updatedAt: ago(60), setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } },
    effective: { ...base.effective, wakeIntervalMinutes: 30, reason: "a release afternoon", isDefault: false, configured: true, updatedAt: ago(60) },
    ...overrides,
  };
}

interface Recorded { url: string; method: string; body: Record<string, unknown> }

const realFetch = globalThis.fetch;
const requests: Recorded[] = [];
/** What the next GET answers. */
let getAnswer: SeatTickSettingsAnswer;
/** How the GET fails, when it does: `500` is a refusal, `malformed` is a 200
    whose body is not the answer — a truncated reply, a proxy's own page. */
let getFails: false | 500 | "malformed" = false;
/** What the next PUT answers; a queue whose last entry repeats. */
let putAnswers: Array<{ status: number; body: unknown } | "throw">;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
  if (!url.startsWith("/api/monitor/seat-tick/settings")) return json({});
  if (method === "PUT") {
    const next = putAnswers.length > 1 ? putAnswers.shift()! : putAnswers[0]!;
    if (next === "throw") throw new Error("network dropped");
    return json(next.body, next.status);
  }
  if (getFails === 500) return json({ error: "seat tick settings are unreadable" }, 500);
  if (getFails === "malformed") return json({ ok: true });
  return json(getAnswer);
}) as typeof fetch;

const roots = new Set<Root>();
beforeEach(() => {
  resetSeatTickSettingsCacheForTests();
  requests.length = 0;
  getAnswer = record();
  getFails = false;
  putAnswers = [{ status: 200, body: record() }];
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const view = () => <SeatTickChip project={PROJECT} projectName="Viewer" />;

async function settle(root: Root, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => root.render(view()));
  }
}

async function mount(): Promise<{ root: Root }> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(view()));
  await settle(root);
  return { root };
}

const body = () => dom.document.body as unknown as HTMLElement;
const chip = () => body().querySelector("[data-seat-tick-chip]") as HTMLButtonElement;
const popover = () => body().querySelector("[data-seat-tick-popover]") as HTMLElement | null;
const field = <T extends HTMLElement>(selector: string) => body().querySelector(selector) as T;
const save = () => body().querySelector("[data-seat-tick-save]") as HTMLButtonElement;
const restore = () => body().querySelector("[data-seat-tick-restore]") as HTMLButtonElement | null;
const summary = () => body().querySelector("[data-seat-tick-summary]")?.textContent ?? "";
const sentence = () => body().querySelector("[data-seat-tick-sentence]")?.textContent ?? "";
const rows = () => [...body().querySelectorAll("[data-seat-tick-body] dl > div")].map((entry) => entry.textContent ?? "");
const puts = () => requests.filter((entry) => entry.method === "PUT");
const gets = () => requests.filter((entry) => entry.method === "GET");

/** A controlled field, typed through its own React props. */
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  const props = (element as unknown as Record<string, { onChange(event: unknown): void }>)[key]!;
  element.value = value;
  flushSync(() => props.onChange({ target: element }));
}

async function open(root: Root): Promise<void> {
  /* A real pointer focuses the button it lands on, and the layer's focus
     return is measured against that. */
  chip().focus();
  flushSync(() => chip().click());
  await settle(root);
  expect(popover()).not.toBeNull();
}

test("the closed chip is one face and one dot: the configured schedule, and the actual state beside it", async () => {
  getAnswer = configured();
  const { root } = await mount();
  expect(chip().getAttribute("data-seat-tick-chip")).toBe("healthy");
  expect(chip().textContent).toContain("every 30 min");
  expect(chip().querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("ok");
  /* One line, and it carries both halves. */
  expect(chip().getAttribute("title")).toBe("Tick: every 30 min · last check 3m ago");
  expect(popover()).toBeNull();

  await open(root);
  /* The form is bound to the STORED record, not to the defaults. */
  expect(field<HTMLInputElement>("[data-seat-tick-interval]").value).toBe("30");
  expect(field<HTMLTextAreaElement>("[data-seat-tick-reason]").value).toBe("a release afternoon");
  expect(field<HTMLButtonElement>("[data-seat-tick-enabled]").getAttribute("aria-checked")).toBe("true");
  /* Nothing to save until something changes; there IS something to restore. */
  expect(save().disabled).toBe(true);
  expect(restore()).not.toBeNull();
});

test("the actual state is read only, with an age per fact and the blocker named", async () => {
  getAnswer = record({
    state: {
      lastCheckAt: ago(3),
      lastWakeAt: ago(120),
      lastWakeReasons: ["interval"],
      outstandingWake: { preparedAt: ago(120), dispatch: "refused" },
      retryGuard: [],
      sourceGap: null,
      accountingGap: null,
    },
    lastDelivery: { at: ago(120), outcome: "deferred-outstanding" },
  });
  const { root } = await mount();
  await open(root);
  expect(body().querySelector("[data-seat-tick-body]")?.getAttribute("data-seat-tick-state")).toBe("blocked");
  expect(sentence()).toContain("Enabled, and the next wake is held back");
  expect(sentence()).toContain("unresolved wake since 2h ago");
  const read = rows().join(" | ");
  expect(read).toContain("Last check");
  expect(read).toContain("3m ago");
  expect(read).toContain("deferred, an attempt outstanding");
  /* An actual-state row is never an input. */
  expect(body().querySelectorAll("[data-seat-tick-body] dl input").length).toBe(0);
});

test("an enabled tick with no recent check renders as enabled AND stale, never as healthy or delivered", async () => {
  getAnswer = record({
    state: { lastCheckAt: ago(30), lastWakeAt: null, lastWakeReasons: [], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
  });
  const { root } = await mount();
  expect(chip().getAttribute("data-seat-tick-chip")).toBe("stale");
  /* The face still reports the schedule the tick is configured on. */
  expect(chip().textContent).toContain("hourly");
  expect(chip().querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("warn");
  await open(root);
  expect(field<HTMLButtonElement>("[data-seat-tick-enabled]").getAttribute("aria-checked")).toBe("true");
  expect(sentence()).toContain("Enabled, and stale");
  expect(sentence()).not.toContain("Enabled and checking");
  expect(summary()).toContain("stale: last check 30m ago");
});

test("a project the tick has never recorded says unknown rather than quiet", async () => {
  getAnswer = record({ state: null });
  const { root } = await mount();
  expect(chip().getAttribute("data-seat-tick-chip")).toBe("unknown");
  expect(chip().querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("unknown");
  await open(root);
  expect(sentence()).toBe("Actual state unknown: the tick has not recorded this project.");
  for (const entry of rows()) expect(entry).toContain("unknown");
});

test("a save displays what was sent and then adopts what the route read back", async () => {
  const { root } = await mount();
  await open(root);
  type(field<HTMLInputElement>("[data-seat-tick-interval]"), "30");
  type(field<HTMLTextAreaElement>("[data-seat-tick-reason]"), "a release afternoon");
  /* The record the route reads back is NOT what was sent: the module clamps,
     redacts and stamps, and the display has to follow the record. */
  putAnswers = [{
    status: 200,
    body: { ...configured({ changed: true }), settings: { ...configured().settings, reason: "a release afternoon (recorded)" } },
  }];
  flushSync(() => save().click());
  await settle(root);

  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, wakeIntervalMinutes: 30, reason: "a release afternoon" });
  expect(chip().textContent).toContain("every 30 min");
  expect(field<HTMLTextAreaElement>("[data-seat-tick-reason]").value).toBe("a release afternoon (recorded)");
  expect(save().disabled).toBe(true);
  expect(body().querySelector("[data-seat-tick-error]")).toBeNull();
});

test("a refused save rolls the display back, shows the server's own text, keeps the draft and re-reads the record once", async () => {
  getAnswer = configured();
  const { root } = await mount();
  await open(root);
  const before = chip().textContent;
  const readsBefore = gets().length;

  type(field<HTMLInputElement>("[data-seat-tick-interval]"), "600000");
  putAnswers = [{
    status: 400,
    body: { error: "wakeIntervalMinutes must be at most 525600; disable the tick instead of setting a longer interval" },
  }];
  flushSync(() => save().click());
  await settle(root);

  expect(puts()).toHaveLength(1);
  /* Rolled back: the chip and the summary are the record again. */
  expect(chip().textContent).toBe(before);
  expect(summary()).toContain("every 30 min");
  /* The module's words, verbatim, where the form is. */
  const error = body().querySelector("[data-seat-tick-error]");
  expect(error?.getAttribute("role")).toBe("alert");
  expect(error?.textContent).toBe("wakeIntervalMinutes must be at most 525600; disable the tick instead of setting a longer interval");
  /* The value that has to be corrected is still in hand. */
  expect(field<HTMLInputElement>("[data-seat-tick-interval]").value).toBe("600000");
  /* One re-read, and no second write. */
  expect(gets().length).toBe(readsBefore + 1);
  expect(puts()).toHaveLength(1);
});

test("a save whose reply is lost rolls back the same way and sends nothing more", async () => {
  getAnswer = configured();
  const { root } = await mount();
  await open(root);
  const readsBefore = gets().length;
  type(field<HTMLTextAreaElement>("[data-seat-tick-reason]"), "another reason");
  putAnswers = ["throw"];
  flushSync(() => save().click());
  await settle(root);

  expect(puts()).toHaveLength(1);
  expect(summary()).toContain("every 30 min");
  expect(body().querySelector("[data-seat-tick-error]")?.textContent).toContain("no answer");
  expect(gets().length).toBe(readsBefore + 1);
});

test("Restore default sends the default with no reason, and only while there is a setting to restore", async () => {
  getAnswer = configured();
  const { root } = await mount();
  await open(root);
  putAnswers = [{ status: 200, body: record({ changed: true }) }];
  flushSync(() => restore()!.click());
  await settle(root);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null });
  expect(chip().textContent).toContain("hourly");
  expect(restore()).toBeNull();
});

test("Escape and an outside pointer close the popover and hand focus back to the chip", async () => {
  const { root } = await mount();
  await open(root);
  flushSync(() => {
    dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
  });
  await settle(root, 2);
  expect(popover()).toBeNull();
  expect(dom.document.activeElement?.getAttribute("data-seat-tick-chip")).toBe("healthy");

  await open(root);
  flushSync(() => {
    dom.window.dispatchEvent(new dom.Event("pointerdown", { bubbles: true }) as never);
  });
  await settle(root, 2);
  expect(popover()).toBeNull();
});

test("a read that does not answer claims nothing about the tick, and neither does a 200 that is not the answer", async () => {
  getFails = 500;
  const refused = await mount();
  expect(chip().getAttribute("data-seat-tick-chip")).toBe("unknown");
  expect(chip().getAttribute("title")).toBe("Tick: could not be read");
  await open(refused.root);
  /* No record, so no form bound to one and no Actual rows asserting facts. */
  expect(body().querySelector("[data-seat-tick-details]")).toBeNull();
  expect(rows()).toEqual([]);

  /* The case that would otherwise crash the whole incumbent row: a readable
     200 carrying a body this client cannot read. */
  resetSeatTickSettingsCacheForTests();
  dom.document.body.replaceChildren();
  getFails = "malformed";
  await mount();
  expect(chip().getAttribute("data-seat-tick-chip")).toBe("unknown");
  expect(chip().getAttribute("title")).toBe("Tick: could not be read");
  expect(chip().textContent).toContain("—");
});

test("nothing outside Details carries an id, a key or a path", async () => {
  getAnswer = configured({
    cardText: "This project's seat tick is not on its default settings\n\nmonitor-ref: seat-tick-settings",
    settings: {
      ...configured().settings,
      monitorPrompt: "Look at the release lane first.",
      setBy: { kind: "agent", conversationId: "conversation_worker_sentinel", project: null, seatEpoch: null },
    },
    monitorPromptLength: 31,
    lastRun: { at: ago(3), verdict: "quiet", reasons: [], delivery: null, detail: "nothing owed" },
  });
  const { root } = await mount();
  await open(root);
  const details = body().querySelector("[data-seat-tick-details]")!;
  /* Closed by default, and the whole disclosure is where the ids live. */
  expect(details.hasAttribute("open")).toBe(false);
  expect(details.textContent).toContain("conversation_worker_sentinel");
  const outside = popover()!.cloneNode(true) as HTMLElement;
  outside.querySelector("[data-seat-tick-details]")?.remove();
  expect(outside.textContent).not.toContain("conversation_worker_sentinel");
  expect(outside.textContent).not.toContain("monitor-ref");
  expect(outside.textContent).not.toContain("/api/monitor/seat-tick");
  expect(chip().getAttribute("title")).not.toContain("conversation_worker_sentinel");
});
