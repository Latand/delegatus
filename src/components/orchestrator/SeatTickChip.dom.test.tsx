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
const { resetMaintainerRoleCacheForTests } = await import("./useMaintainerRole");

const PROJECT = "viewer";
/* Every instant in a fixture is relative to the clock the component reads:
   the reading ages against `Date.now()`, so a pinned calendar date would
   drift by whatever the real date is. */
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

/* The agent mapping the maintainer picker reads and writes: `/api/roles`, with
   the launch catalogue the server offers. */
const effortsOf = (...tiers: string[]) => tiers;
const LAUNCH_CHOICES = [
  { engine: "claude", models: [
    { id: "opus", label: "Opus 5.5", shortLabel: "Opus 5.5", use: "review", efforts: effortsOf("low", "medium", "high", "xhigh", "max") },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", shortLabel: "Sonnet 5.5", use: "implement", efforts: effortsOf("low", "medium", "high", "xhigh", "max") },
  ] },
  { engine: "codex", models: [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", shortLabel: "6.1-Sol", use: "review", efforts: effortsOf("low", "medium", "high", "xhigh", "max", "ultra") },
    { id: "gpt-6-luna", label: "GPT-6-Luna", shortLabel: "6-Luna", use: "general", efforts: effortsOf("low", "medium", "high", "xhigh", "max") },
  ] },
];
let maintainerConfig: { engine: string; model: string; effort: string };
let rolesRevision: number;
/** How `/api/roles` PUT answers; the default applies the config. */
let rolesPut: null | { status: number; body: unknown };
let rolesGetFails = false;
const rolesCatalogue = () => ({
  revision: `rev-${rolesRevision}`,
  health: "ok",
  launchChoices: LAUNCH_CHOICES,
  roles: [{ id: "maintainer", name: "Maintainer", config: maintainerConfig }],
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
  if (url.startsWith("/api/roles")) {
    if (method === "PUT") {
      if (rolesPut) return json(rolesPut.body, rolesPut.status);
      const config = (body.overrides as { maintainer: { config: typeof maintainerConfig } }).maintainer.config;
      maintainerConfig = config;
      rolesRevision += 1;
      return json(rolesCatalogue());
    }
    return rolesGetFails ? json({ error: "unreadable" }, 500) : json(rolesCatalogue());
  }
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

/** Unmount and deregister, so a root is torn down exactly once and never
    after the DOM under it has been cleared. */
function unmount(root: Root): void {
  if (!roots.delete(root)) return;
  flushSync(() => root.unmount());
}

beforeEach(() => {
  resetSeatTickSettingsCacheForTests();
  resetMaintainerRoleCacheForTests();
  maintainerConfig = { engine: "codex", model: "gpt-6.1-sol", effort: "medium" };
  rolesRevision = 1;
  rolesPut = null;
  rolesGetFails = false;
  requests.length = 0;
  getAnswer = record();
  getFails = false;
  putAnswers = [{ status: 200, body: record() }];
});
afterEach(() => {
  for (const root of [...roots]) unmount(root);
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
const chip = () => body().querySelector("[data-seat-tick-chip]") as HTMLElement;
const popover = () => body().querySelector("[data-seat-tick-popover]") as HTMLElement | null;
const field = <T extends HTMLElement>(selector: string) => body().querySelector(selector) as T;
/** The panel's one Save: absent while nothing changed. */
const save = () => body().querySelector("[data-seat-tick-save]") as HTMLButtonElement | null;
const press = (button: HTMLButtonElement | null) => flushSync(() => button!.click());
const restore = () => body().querySelector("[data-seat-tick-restore]") as HTMLButtonElement | null;
const summary = () => body().querySelector("[data-seat-tick-summary]")?.textContent ?? "";
const detail = () => body().querySelector("[data-seat-tick-status-detail]")?.textContent ?? "";
const puts = () => requests.filter((entry) => entry.method === "PUT" && entry.url.startsWith("/api/monitor/seat-tick/settings"));
const rolePuts = () => requests.filter((entry) => entry.method === "PUT" && entry.url.startsWith("/api/roles"));
const gets = () => requests.filter((entry) => entry.method === "GET" && entry.url.startsWith("/api/monitor/seat-tick/settings"));

/** A controlled field, typed through its own React props. */
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  const props = (element as unknown as Record<string, { onChange(event: unknown): void }>)[key]!;
  element.value = value;
  flushSync(() => props.onChange({ target: element }));
}

async function open(root: Root): Promise<void> {
  /* A real pointer focuses the control it lands on, and the layer's focus
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
  expect(chip().textContent).toContain("30 min");
  expect(chip().getAttribute("aria-valuetext")).toBe("30 min, not a preset. every 30 min · last check 3m ago");
  expect(chip().querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("ok");
  /* One line, and it carries both halves. */
  expect(chip().getAttribute("title")).toBe("Tick: every 30 min · last check 3m ago\nDrag to change how often the seat wakes · click for settings");
  expect(popover()).toBeNull();

  await open(root);
  /* The form is bound to the STORED record, not to the defaults. */
  expect(field<HTMLInputElement>("[data-seat-tick-interval]").value).toBe("30");
  expect(field<HTMLTextAreaElement>("[data-seat-tick-reason]").value).toBe("a release afternoon");
  expect(field<HTMLButtonElement>("[data-seat-tick-enabled]").getAttribute("aria-checked")).toBe("true");
  /* Nothing to save until something changes, so there is no Save to see;
     there IS something to restore, and it says what it restores. */
  expect(save()).toBeNull();
  expect(restore()?.textContent).toBe("Restore tick defaults");
});

test("the status names the blocker once, with the last check beside the tick's own state", async () => {
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
  expect(summary()).toBe("Wakes every 60 min · last check 3m ago");
  expect(detail()).toBe("Next wake held: unresolved wake since 2h ago (dispatch refused)");
  /* Once: the blocker is not a sentence, a row and a Blocker row as well. */
  expect(popover()!.textContent!.split("unresolved wake").length - 1).toBe(1);
  expect(popover()!.textContent).not.toContain("Blocker");
  expect(popover()!.textContent).not.toContain("Actually");
  expect(body().querySelector("[data-seat-tick-body] dl")).toBeNull();
  /* The last delivery moved into Details. */
  const details = body().querySelector("[data-seat-tick-details]")!;
  expect(details.querySelector("[data-seat-tick-last-delivery]")?.textContent).toBe("Last delivery: deferred, an attempt outstanding · 2h ago");
  const outside = popover()!.cloneNode(true) as HTMLElement;
  outside.querySelector("[data-seat-tick-details]")?.remove();
  expect(outside.textContent).not.toContain("Last delivery");
});

test("the status block comes first, before any setting, with the wakes line and the maintenance line", async () => {
  getAnswer = configured();
  const { root } = await mount();
  await open(root);
  const order = [...body().querySelectorAll("[data-seat-tick-status], [data-seat-tick-enabled], [data-seat-tick-maintenance]")].map((node) =>
    node.hasAttribute("data-seat-tick-status") ? "status" : node.hasAttribute("data-seat-tick-enabled") ? "wakes" : "maintenance");
  expect(order).toEqual(["status", "wakes", "maintenance"]);
  const status = body().querySelector("[data-seat-tick-status]")!;
  expect(status.querySelector("[data-seat-tick-summary]")?.textContent).toBe("Wakes every 30 min · last check 3m ago");
  expect(status.querySelector("[data-seat-tick-maintenance-summary]")?.textContent).toBe("Maintenance off");
});

test("an enabled tick with no recent check renders as enabled AND stale, never as healthy or delivered", async () => {
  getAnswer = record({
    state: { lastCheckAt: ago(30), lastWakeAt: null, lastWakeReasons: [], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
  });
  const { root } = await mount();
  expect(chip().getAttribute("data-seat-tick-chip")).toBe("stale");
  /* The face still reports the schedule the tick is configured on. */
  expect(chip().textContent).toContain("1 h");
  expect(chip().getAttribute("aria-valuetext")).toBe("every hour, the default. every 60 min · stale: last check 30m ago");
  expect(chip().querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("warn");
  await open(root);
  expect(field<HTMLButtonElement>("[data-seat-tick-enabled]").getAttribute("aria-checked")).toBe("true");
  expect(summary()).toBe("Wakes every 60 min · stale: last check 30m ago");
  /* Stale is explained once, in the detail line. */
  expect(detail()).toBe("Checks run every 5 min, so the tick itself may be down.");
});

test("a project the tick has never recorded says unknown rather than quiet", async () => {
  getAnswer = record({ state: null });
  const { root } = await mount();
  expect(chip().getAttribute("data-seat-tick-chip")).toBe("unknown");
  expect(chip().querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("unknown");
  await open(root);
  expect(summary()).toBe("Wakes every 60 min · state unknown");
  expect(detail()).toBe("Actual state unknown: the tick has not recorded this project.");
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
  press(save());
  await settle(root);

  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, wakeIntervalMinutes: 30, reason: "a release afternoon" });
  expect(chip().textContent).toContain("30 min");
  expect(chip().getAttribute("aria-valuetext")).toBe("30 min, not a preset. every 30 min · last check 3m ago");
  expect(field<HTMLTextAreaElement>("[data-seat-tick-reason]").value).toBe("a release afternoon (recorded)");
  expect(save()).toBeNull();
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
  press(save());
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
  press(save());
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
  expect(chip().textContent).toContain("1 h");
  expect(chip().getAttribute("aria-valuetext")).toBe("every hour, the default. every 60 min · last check 3m ago");
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
  /* With no record there is no stop to drag from, so the title offers no drag
     and the cursor is the one a click gets. */
  expect(chip().getAttribute("title")).toBe("Tick: could not be read");
  expect(chip().className).toContain("cursor-pointer");
  expect(chip().className).not.toContain("cursor-grab");
  await open(refused.root);
  /* No record, so no form bound to one and no facts asserted. */
  expect(body().querySelector("[data-seat-tick-details]")).toBeNull();
  expect(summary()).toBe("Wakes could not be read");

  /* The case that would otherwise crash the whole incumbent row: a readable
     200 carrying a body this client cannot read.

     The first root is UNMOUNTED before the body is cleared: wiping
     `document.body` under a live root leaves React's later unmount calling
     `removeChild` on a node that is already gone, which reports as an
     uncaught DOMException and is indistinguishable from a real unmount
     regression in this component. */
  unmount(refused.root);
  resetSeatTickSettingsCacheForTests();
  getFails = "malformed";
  await mount();
  expect(chip().getAttribute("data-seat-tick-chip")).toBe("unknown");
  expect(chip().getAttribute("title")).toBe("Tick: could not be read");
  expect(chip().textContent).toContain("—");
});

test("an unreadable store is reported in the section and quoted only inside Details", async () => {
  /* A filesystem error names the path it failed to open. Invented here rather
     than lifted from a real run, and assembled so the literal never sits in
     the source as one string. */
  const path = ["/home", "someone", ".config", "agent-log-viewer", "state", "seat-tick.json"].join("/");
  getAnswer = configured({
    state: null,
    stateError: `EACCES: permission denied, open '${path}'`,
    journalError: `EACCES: permission denied, open '${path}l'`,
  });
  const { root } = await mount();
  await open(root);

  /* The FACT that each store failed is in the section — criterion 2 requires
     the section to say so. */
  const section = body().querySelector("[data-seat-tick-body]")!;
  expect(section.querySelector("[data-seat-tick-state-unreadable]")?.getAttribute("role")).toBe("status");
  expect(section.querySelector("[data-seat-tick-journal-unreadable]")?.getAttribute("role")).toBe("status");
  expect(detail()).toBe("Actual state unknown: the tick's record could not be read.");

  /* WHAT they said is behind the disclosure, with the rest of the raw record. */
  const details = body().querySelector("[data-seat-tick-details]")!;
  expect(details.querySelector("[data-seat-tick-state-error]")?.textContent).toContain(path);
  expect(details.querySelector("[data-seat-tick-journal-error]")?.textContent).toContain(path);
  const outside = popover()!.cloneNode(true) as HTMLElement;
  outside.querySelector("[data-seat-tick-details]")?.remove();
  expect(outside.textContent).not.toContain(path);
  expect(outside.textContent).not.toContain("EACCES");
  expect(chip().getAttribute("title")).not.toContain(path);
});

test("a non-finite interval is sent as typed, so the module refuses it instead of the tick silently restoring the default", async () => {
  getAnswer = configured();
  const { root } = await mount();
  await open(root);
  /* `Number("1e400")` is Infinity, which `JSON.stringify` writes as `null` —
     and the module reads `null` as «restore the default». So the entry has to
     reach the wire AS TYPED.

     `1e400` is the reachable case: it is a value a number input accepts.
     «abc» is not — the control rejects it and leaves the field empty, which
     already means «the default» and is the documented entry for it, asserted
     below so the narrowness is on the record rather than assumed. */
  putAnswers = [{ status: 400, body: { error: "wakeIntervalMinutes must be a positive number of minutes, or null for the default" } }];
  const input = field<HTMLInputElement>("[data-seat-tick-interval]");
  type(input, "1e400");
  press(save());
  await settle(root);
  const sent = puts().at(-1)!.body;
  expect(sent.wakeIntervalMinutes).toBe("1e400");
  expect(sent.wakeIntervalMinutes).not.toBeNull();
  /* Rolled back to the record, with the module's own words. */
  expect(summary()).toContain("every 30 min");
  expect(body().querySelector("[data-seat-tick-error]")?.textContent).toContain("must be a positive number of minutes");

  /* And the entry a number input cannot hold never becomes an interval at all. */
  type(input, "abc");
  expect(field<HTMLInputElement>("[data-seat-tick-interval]").value).toBe("");
});

test("the popover leaves with its chip rather than clamping to the viewport edge", async () => {
  const { root } = await mount();
  await open(root);
  /* The popover does not lock body scroll, so the surface under it scrolls
     while it is open; the placement math clamps a scrolled-away anchor back to
     the edge instead of following it off, so the chip's own visibility is what
     has to end the popover. */
  const anchor = chip() as unknown as { getBoundingClientRect: () => unknown };
  anchor.getBoundingClientRect = () => ({ top: -400, bottom: -376, left: 500, right: 600, width: 100, height: 24, x: 500, y: -400 });
  flushSync(() => {
    dom.window.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as never);
  });
  await settle(root, 2);
  expect(popover()).toBeNull();
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

/*
 * The board maintenance group inside the popover (#2162): its own switch and
 * interval over the `maintenance` block of the same settings answer, saved by
 * the panel's one Save together with the tick's fields and the maintainer's
 * agent.
 */

const mSwitch = () => body().querySelector("[data-seat-tick-maintenance-enabled]") as HTMLButtonElement;
const mInterval = () => body().querySelector("[data-seat-tick-maintenance-interval]") as HTMLInputElement | null;
const mGroup = () => body().querySelector("[data-seat-tick-maintenance]") as HTMLElement | null;
const mSummary = () => body().querySelector("[data-seat-tick-maintenance-summary]")?.textContent ?? "";
const mRows = () => Object.fromEntries([...body().querySelectorAll("[data-seat-tick-maintenance-row]")].map((entry) => [
  entry.getAttribute("data-seat-tick-maintenance-row"),
  entry.querySelectorAll("span")[1]?.textContent ?? "",
]));
const pick = <T extends HTMLElement>(selector: string) => body().querySelector(selector) as T;

/** A select changed the way a person changes it: its value, then a bubbling
    `change` the React root hears. */
function choose(element: HTMLSelectElement, value: string): void {
  element.value = value;
  flushSync(() => {
    element.dispatchEvent(new dom.Event("change", { bubbles: true }) as never);
  });
}

type MaintenanceBlock = SeatTickSettingsAnswer["maintenance"];
function withMaintenance(overrides: Partial<MaintenanceBlock>, base: SeatTickSettingsAnswer = record()): SeatTickSettingsAnswer {
  return { ...base, maintenance: { ...base.maintenance, ...overrides } };
}
const endedRun = (overrides: Partial<NonNullable<MaintenanceBlock["lastRun"]>> = {}): NonNullable<MaintenanceBlock["lastRun"]> => ({
  runId: "run-1", taskId: "card-from-the-last-run", conversationId: "conv-1", state: "succeeded",
  claimedAt: ago(200), launchedAt: ago(199), endedAt: ago(185), failure: null,
  counts: { writes: 14, tasks: 9, status: 4, closed: 2, created: 1, text: 5, details: 0, looks: 2 }, attentionCount: 3,
  ...overrides,
});

test("maintenance: off by default, the group follows the wakes with the agent line, the clause and no interval", async () => {
  const { root } = await mount();
  await open(root);
  const group = mGroup()!;
  expect(group.getAttribute("data-seat-tick-maintenance")).toBe("off");
  expect(group.textContent).toContain("Board maintenance");
  expect(mSummary()).toBe("Maintenance off");
  expect(mSwitch().getAttribute("aria-checked")).toBe("false");
  /* What the switch starts, on which agent, and the clause about the wakes. */
  expect(group.querySelector("[data-seat-tick-maintenance-about]")?.textContent).toBe("One Codex agent (GPT-6.1-Sol, medium) tidies task statuses and texts.");
  expect(group.textContent).toContain("starts from tick checks and pauses while wakes are off");
  /* The interval belongs to a maintenance that is on. */
  expect(mInterval()).toBeNull();
  expect(save()).toBeNull();
  expect(mRows()).toEqual({ last: "never", next: "none while maintenance is off" });
  const order = [...body().querySelectorAll("[data-seat-tick-status], [data-seat-tick-maintenance], [data-seat-tick-details]")].map((node) => node.tagName);
  expect(order).toEqual(["DIV", "DIV", "DETAILS"]);
});

test("maintenance: turning it on shows the interval, and the one Save sends only the maintenance change", async () => {
  const { root } = await mount();
  await open(root);
  press(mSwitch());
  expect(mInterval()!.value).toBe("3");
  type(mInterval()!, "6");
  expect(save()).not.toBeNull();
  putAnswers = [{
    status: 200,
    body: withMaintenance({ enabled: true, intervalHours: 6, updatedAt: ago(0), waitingOn: null, nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString() }, record({ changed: true })),
  }];
  press(save());
  await settle(root);

  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, maintenance: { enabled: true, intervalHours: 6 } });
  expect(rolePuts()).toHaveLength(0);
  /* The form shows what the route read back, and the group moved to «on». */
  expect(mGroup()!.getAttribute("data-seat-tick-maintenance")).toBe("on");
  expect(mSummary()).toMatch(/^Maintenance every 6 h · never run$/);
  expect(mInterval()!.value).toBe("6");
  expect(save()).toBeNull();
  expect(mRows().next).toMatch(/^first run at the next check, about \d{2}:\d{2}$/);
});

test("one Save carries the tick's fields and the maintenance fields in one request", async () => {
  const { root } = await mount();
  await open(root);
  type(field<HTMLInputElement>("[data-seat-tick-interval]"), "45");
  type(field<HTMLTextAreaElement>("[data-seat-tick-reason]"), "a release afternoon");
  press(mSwitch());
  expect(body().querySelectorAll("[data-seat-tick-save]")).toHaveLength(1);
  putAnswers = [{ status: 200, body: withMaintenance({ enabled: true }, configured({ changed: true })) }];
  press(save());
  await settle(root);
  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, wakeIntervalMinutes: 45, reason: "a release afternoon", maintenance: { enabled: true } });
});

test("restoring the tick defaults leaves an unsaved maintenance draft alone", async () => {
  getAnswer = configured();
  const { root } = await mount();
  await open(root);
  press(mSwitch());
  type(mInterval()!, "8");
  putAnswers = [{ status: 200, body: record({ changed: true }) }];
  press(restore());
  await settle(root);
  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, enabled: true, wakeIntervalMinutes: null, untilMinutes: null });
  /* The restore moved settings.updatedAt, as every write does; the maintenance
     fields still hold what was typed and still wait on the Save. */
  expect(mSwitch().getAttribute("aria-checked")).toBe("true");
  expect(mInterval()!.value).toBe("8");
  expect(save()).not.toBeNull();
});

test("maintenance: an empty interval is sent as null, the default, and a non-finite one goes as typed", async () => {
  getAnswer = withMaintenance({ enabled: true, intervalHours: 12, waitingOn: "interval" });
  const { root } = await mount();
  await open(root);
  expect(mInterval()!.value).toBe("12");
  type(mInterval()!, "");
  putAnswers = [{ status: 200, body: withMaintenance({ enabled: true, intervalHours: 3 }) }];
  press(save());
  await settle(root);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, maintenance: { intervalHours: null } });

  type(mInterval()!, "1e400");
  putAnswers = [{ status: 200, body: withMaintenance({ enabled: true, intervalHours: 3 }) }];
  press(save());
  await settle(root);
  expect(puts()[1]!.body).toEqual({ project: PROJECT, maintenance: { intervalHours: "1e400" } });
});

test("a refusal shows beside the Save in the server's words, and keeps what was typed", async () => {
  const { root } = await mount();
  await open(root);
  press(mSwitch());
  type(mInterval()!, "5");
  putAnswers = [{ status: 400, body: { error: "maintenance.intervalHours must be between 1 and 168" } }];
  press(save());
  await settle(root);

  expect(puts()).toHaveLength(1);
  const error = body().querySelector("[data-seat-tick-error]");
  expect(error?.getAttribute("role")).toBe("alert");
  expect(error?.textContent).toBe("maintenance.intervalHours must be between 1 and 168");
  expect(mInterval()!.value).toBe("5");
  /* The Save is still there to try again. */
  expect(save()).not.toBeNull();
});

test("maintenance: a run in progress is named with its start and its card", async () => {
  getAnswer = withMaintenance({
    enabled: true, waitingOn: "live-run",
    live: { ...endedRun({ state: "running", endedAt: null, taskId: "live-card" }), counts: endedRun().counts },
  });
  const { root } = await mount();
  await open(root);
  expect(mGroup()!.getAttribute("data-seat-tick-maintenance")).toBe("running");
  expect(mSummary()).toMatch(/^Maintenance running since \d{2}:\d{2}$/);
  expect(mRows().next).toBe("after the current run ends");
  expect(mGroup()!.querySelector("[data-seat-tick-maintenance-card]")).not.toBeNull();
});

test("maintenance: a succeeded run shows its time and count, and N need you opens the run's card from the status and the group", async () => {
  getAnswer = withMaintenance({ enabled: true, waitingOn: "interval", lastRun: endedRun(), nextRunAt: new Date(Date.now() + 3 * 3_600_000).toISOString() });
  const { root } = await mount();
  await open(root);
  expect(mSummary()).toMatch(/^Maintenance every 3 h · done \d{2}:\d{2}$/);
  expect(mRows().last).toMatch(/^Done \d{2}:\d{2} · 9 changed$/);
  expect(mRows().next).toMatch(/^about \d{2}:\d{2}$/);
  const line = body().querySelector("[data-seat-tick-status]")!.textContent!;
  expect(line).toMatch(/9 changed.*3 need you.*next ≈ \d{2}:\d{2}/);
  /* No id in the primary view. */
  expect(popover()!.textContent).not.toContain("card-from-the-last-run");

  const navigated: Array<{ kind?: string; id?: string }> = [];
  const listener = (event: Event) => navigated.push((event as CustomEvent).detail);
  dom.window.addEventListener("llv:mcp-navigate", listener as never);
  try {
    press(body().querySelector("[data-seat-tick-status] [data-seat-tick-status-link=\"card\"]") as HTMLButtonElement);
  } finally {
    dom.window.removeEventListener("llv:mcp-navigate", listener as never);
  }
  expect(navigated).toEqual([{ kind: "task", id: "card-from-the-last-run" }]);
  await settle(root, 2);
  expect(popover()).toBeNull();

  /* The same link in the group, which then has no second «open the card». */
  await open(root);
  const inGroup = mGroup()!.querySelector("[data-seat-tick-maintenance-link=\"card\"]") as HTMLButtonElement;
  expect(inGroup.textContent).toBe("3 need you");
  expect(mGroup()!.querySelector("[data-seat-tick-maintenance-card]")).toBeNull();
  dom.window.addEventListener("llv:mcp-navigate", listener as never);
  try {
    press(inGroup);
  } finally {
    dom.window.removeEventListener("llv:mcp-navigate", listener as never);
  }
  expect(navigated).toHaveLength(2);
});

test("maintenance: a failed run is a warning with its reason by kind, no engine detail, and the Accounts remedy for a missing account", async () => {
  getAnswer = withMaintenance({
    enabled: true, waitingOn: "interval", nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastRun: endedRun({ state: "failed", failure: { kind: "no-account", detail: "ENGINE_NOT_CONNECTED at /srv/engine/state.json" } }),
  });
  const { root } = await mount();
  await open(root);
  expect(mRows().last).toMatch(/^Failed \d{2}:\d{2} · no Codex account is available for this project$/);
  expect(body().querySelector("[data-seat-tick-maintenance-summary] [data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("warn");
  expect(body().querySelector("[data-seat-tick-status]")!.textContent).toMatch(/failed \d{2}:\d{2}no Codex account is available for this project.*Accounts.*retry ≈ \d{2}:\d{2}/);
  expect(popover()!.textContent).not.toContain("/srv/engine");
  expect(mGroup()!.querySelector("[data-seat-tick-maintenance-card]")).not.toBeNull();

  const asked: Array<{ engine?: string; accountId?: string }> = [];
  const listener = (event: Event) => asked.push((event as CustomEvent).detail);
  dom.window.addEventListener("llv:open-accounts", listener as never);
  try {
    press(mGroup()!.querySelector("[data-seat-tick-maintenance-link=\"accounts\"]") as HTMLButtonElement);
  } finally {
    dom.window.removeEventListener("llv:open-accounts", listener as never);
  }
  expect(asked).toEqual([{ engine: "codex", accountId: "" }]);
  await settle(root, 2);
  expect(popover()).toBeNull();

  /* Any other failure has no Accounts link. */
  unmount(root);
  resetSeatTickSettingsCacheForTests();
  getAnswer = withMaintenance({
    enabled: true, waitingOn: "interval", nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastRun: endedRun({ state: "failed", failure: { kind: "host-died", detail: "" } }),
  });
  const again = await mount();
  await open(again.root);
  expect(body().querySelector("[data-seat-tick-status-link=\"accounts\"]")).toBeNull();
});

test("maintenance: a no-account run on Claude names Claude and its Accounts link opens the Claude accounts", async () => {
  getAnswer = withMaintenance({
    enabled: true, waitingOn: "interval", nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastRun: endedRun({ state: "failed", failure: { kind: "no-account", detail: "", engine: "claude" } }),
  });
  const { root } = await mount();
  await open(root);
  expect(mRows().last).toMatch(/^Failed \d{2}:\d{2} · no Claude account is available for this project$/);
  expect(popover()!.textContent).not.toContain("no Codex account");
  const asked: Array<{ engine?: string; accountId?: string }> = [];
  const listener = (event: Event) => asked.push((event as CustomEvent).detail);
  dom.window.addEventListener("llv:open-accounts", listener as never);
  try {
    press(body().querySelector("[data-seat-tick-status-link=\"accounts\"]") as HTMLButtonElement);
  } finally {
    dom.window.removeEventListener("llv:open-accounts", listener as never);
  }
  expect(asked).toEqual([{ engine: "claude", accountId: "" }]);
});

test("maintenance: wakes off pauses it, and the panel says so in the status and the next-run row", async () => {
  getAnswer = withMaintenance({
    enabled: true, waitingOn: "wakes-off", pauseReason: "paused while wakes are off", lastRun: endedRun(), nextRunAt: null,
  }, record({
    settings: { ...record().settings, enabled: false, reason: "quiet", updatedAt: ago(120) },
    effective: { ...record().effective, enabled: false, reason: "quiet", isDefault: false, configured: true, updatedAt: ago(120) },
  }));
  const { root } = await mount();
  await open(root);
  expect(mSummary()).toMatch(/^Maintenance every 3 h · done/);
  expect(body().querySelector("[data-seat-tick-status]")!.textContent).toContain("paused while wakes are off");
  expect(mRows().next).toBe("paused while wakes are off");
  expect(body().querySelector("[data-seat-tick-maintenance-summary] [data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("muted");
});

test("maintenance: a held launch says why, and an unreadable run store warns while the setting stays editable", async () => {
  getAnswer = withMaintenance({ enabled: true, waitingOn: "deployment", nextRunAt: new Date(Date.now() + 300_000).toISOString(), runsError: "store unreadable" });
  const { root } = await mount();
  await open(root);
  expect(mRows().next).toBe("held while a deployment runs");
  expect(body().querySelector("[data-seat-tick-maintenance-unreadable]")?.textContent).toContain("The setting still works");
  expect(mSwitch().disabled).toBe(false);
  expect(mInterval()!.disabled).toBe(false);
});

/*
 * Progressive disclosure: a field is shown while it does something.
 */

test("the panel offers instructions for every wake even at the default cadence", async () => {
  const { root } = await mount();
  await open(root);
  const instruction = field<HTMLTextAreaElement>("[data-seat-tick-reason]");
  expect(instruction).not.toBeNull();
  expect(instruction.closest("label")?.textContent).toContain("Instructions for every wake");
  expect(instruction.closest("label")?.textContent).toContain("The agent receives these instructions on every wake");
  type(instruction, "Handle the inbox by priority.");
  press(save());
  await settle(root);
  expect(puts()[0]!.body).toMatchObject({ reason: "Handle the inbox by priority." });
});

test("the interval is hidden while the wake switch is off, and Until appears only off the defaults", async () => {
  const { root } = await mount();
  await open(root);
  /* On the defaults: the interval, and nothing to expire or explain. */
  expect(body().querySelector("[data-seat-tick-interval]")).not.toBeNull();
  expect(body().querySelector("[data-seat-tick-until]")).toBeNull();
  expect(body().querySelector("[data-seat-tick-reason]")).not.toBeNull();
  expect(restore()).toBeNull();

  /* Typing an interval leaves the defaults: Until and Reason arrive. */
  type(field<HTMLInputElement>("[data-seat-tick-interval]"), "30");
  expect(body().querySelector("[data-seat-tick-until]")).not.toBeNull();
  expect(body().querySelector("[data-seat-tick-reason]")).not.toBeNull();
  /* Clearing it returns to the defaults and they go again. */
  type(field<HTMLInputElement>("[data-seat-tick-interval]"), "");
  expect(body().querySelector("[data-seat-tick-until]")).toBeNull();

  /* Off leaves the defaults too, and an interval does nothing while off. */
  press(field<HTMLButtonElement>("[data-seat-tick-enabled]"));
  expect(body().querySelector("[data-seat-tick-interval]")).toBeNull();
  expect(body().querySelector("[data-seat-tick-until]")).not.toBeNull();
  expect(body().querySelector("[data-seat-tick-reason]")).not.toBeNull();
  /* The same for maintenance. */
  expect(mInterval()).toBeNull();
});

test("the interval hint appears only when the typed value is below the check cadence", async () => {
  const { root } = await mount();
  await open(root);
  const hint = () => body().querySelector("[data-seat-tick-interval-hint]");
  expect(hint()).toBeNull();
  type(field<HTMLInputElement>("[data-seat-tick-interval]"), "2");
  expect(hint()?.textContent).toBe("Checks run every 5 min, so a shorter interval means a wake at every check.");
  type(field<HTMLInputElement>("[data-seat-tick-interval]"), "30");
  expect(hint()).toBeNull();
});

/*
 * The maintainer's agent: the same `maintainer` row Settings → agent mapping
 * edits, offered from the launch catalogue and saved with the rest.
 */

const engineSelect = () => pick<HTMLSelectElement>("[data-seat-tick-agent-engine]");
const modelSelect = () => pick<HTMLSelectElement>("[data-seat-tick-agent-model]");
const effortSelect = () => pick<HTMLSelectElement>("[data-seat-tick-agent-effort]");
const optionsOf = (select: HTMLSelectElement) => [...select.querySelectorAll("option")].map((option) => option.getAttribute("value"));

test("the agent picker shows the stored runtime and offers only the launch catalogue", async () => {
  const { root } = await mount();
  await open(root);
  expect([engineSelect().value, modelSelect().value, effortSelect().value]).toEqual(["codex", "gpt-6.1-sol", "medium"]);
  expect(optionsOf(engineSelect())).toEqual(["claude", "codex"]);
  expect(optionsOf(modelSelect())).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
  expect(optionsOf(effortSelect())).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(save()).toBeNull();
});

test("choosing a model and an effort writes the maintainer row once, with the revision, and nothing to the tick", async () => {
  const { root } = await mount();
  await open(root);
  choose(modelSelect(), "gpt-6-luna");
  /* The ladder follows the model: Luna has no `ultra`. */
  expect(optionsOf(effortSelect())).toEqual(["low", "medium", "high", "xhigh", "max"]);
  choose(effortSelect(), "high");
  expect(mGroup()!.querySelector("[data-seat-tick-maintenance-about]")?.textContent).toBe("One Codex agent (GPT-6-Luna, high) tidies task statuses and texts.");
  press(save());
  await settle(root);

  expect(puts()).toHaveLength(0);
  expect(rolePuts()).toHaveLength(1);
  expect(rolePuts()[0]!.body).toEqual({
    expectedRevision: "rev-1",
    overrides: { maintainer: { config: { engine: "codex", model: "gpt-6-luna", effort: "high" } } },
  });
  /* Saved: the picker shows the record and the Save is gone. */
  expect([modelSelect().value, effortSelect().value]).toEqual(["gpt-6-luna", "high"]);
  expect(save()).toBeNull();
});

test("an effort the new model lacks lands on the nearest tier it has, and an engine change picks a model of that engine", async () => {
  maintainerConfig = { engine: "codex", model: "gpt-6.1-sol", effort: "ultra" };
  const { root } = await mount();
  await open(root);
  choose(modelSelect(), "gpt-6-luna");
  expect(effortSelect().value).toBe("max");
  choose(engineSelect(), "claude");
  expect(optionsOf(modelSelect())).toEqual(["opus", "claude-sonnet-5-5"]);
  expect(optionsOf(modelSelect())).toContain(modelSelect().value);
  expect(optionsOf(effortSelect())).toContain(effortSelect().value);
  press(save());
  await settle(root);
  const sent = (rolePuts()[0]!.body.overrides as { maintainer: { config: { engine: string; model: string; effort: string } } }).maintainer.config;
  expect(sent.engine).toBe("claude");
  expect(LAUNCH_CHOICES.find((choice) => choice.engine === "claude")!.models.map((model) => model.id)).toContain(sent.model);
});

test("a refused agent write keeps the choice, names the refusal beside the picker and leaves the tick's save alone", async () => {
  const { root } = await mount();
  await open(root);
  choose(effortSelect(), "high");
  type(field<HTMLInputElement>("[data-seat-tick-interval]"), "30");
  type(field<HTMLTextAreaElement>("[data-seat-tick-reason]"), "a release afternoon");
  rolesPut = { status: 400, body: { error: "invalid codex effort" } };
  putAnswers = [{ status: 200, body: configured({ changed: true }) }];
  press(save());
  await settle(root);
  /* The tick write landed on its own, and the agent write did not. */
  expect(puts()).toHaveLength(1);
  expect(rolePuts()).toHaveLength(1);
  expect(body().querySelector("[data-seat-tick-agent-error]")?.textContent).toBe("invalid codex effort");
  expect(effortSelect().value).toBe("high");
  expect(chip().textContent).toContain("30 min");
  expect(chip().getAttribute("aria-valuetext")).toBe("30 min, not a preset. every 30 min · last check 3m ago");
  /* Only the agent change is still waiting. */
  expect(save()).not.toBeNull();
});

test("a stale mapping revision shows the current value and asks again instead of overwriting it", async () => {
  const { root } = await mount();
  await open(root);
  choose(effortSelect(), "high");
  maintainerConfig = { engine: "codex", model: "gpt-6-luna", effort: "low" };
  rolesRevision += 1;
  rolesPut = { status: 409, body: rolesCatalogue() };
  press(save());
  await settle(root);
  expect(body().querySelector("[data-seat-tick-agent-error]")?.textContent).toContain("changed meanwhile");
  expect(modelSelect().value).toBe("gpt-6-luna");
});

test("when the agent mapping cannot be read, the picker is not offered and Settings is named", async () => {
  rolesGetFails = true;
  const { root } = await mount();
  await open(root);
  expect(body().querySelector("[data-seat-tick-agent]")).toBeNull();
  expect(body().querySelector("[data-seat-tick-agent-unreadable]")?.textContent).toContain("Settings → agent mapping");
  expect(mGroup()!.querySelector("[data-seat-tick-maintenance-about]")?.textContent).toBe("One agent tidies task statuses and texts.");
});

test("the board's tick notice opens this project's panel and no other", async () => {
  const { root } = await mount();
  expect(popover()).toBeNull();
  const { requestSeatTickPanel } = await import("./openSeatTick");
  flushSync(() => requestSeatTickPanel("another-project"));
  await settle(root, 2);
  expect(popover()).toBeNull();
  flushSync(() => requestSeatTickPanel(PROJECT));
  await settle(root, 2);
  expect(popover()).not.toBeNull();
});

test("a request that arrived before the chip mounted opens it on mount, and only once", async () => {
  /* A folded seat has no chip: the seat unfolds on the request and the chip
     mounts with its header. */
  const { requestSeatTickPanel, resetPendingSeatTickPanel } = await import("./openSeatTick");
  resetPendingSeatTickPanel();
  requestSeatTickPanel(PROJECT);
  const { root } = await mount();
  await settle(root, 2);
  expect(popover()).not.toBeNull();
  /* The request was spent: a chip mounting later does not reopen it. */
  const { takePendingSeatTickPanel } = await import("./openSeatTick");
  expect(takePendingSeatTickPanel(PROJECT)).toBe(false);
});

test("maintenance: an answer from a server with no timer block renders no group at all", async () => {
  const old = record() as Partial<SeatTickSettingsAnswer>;
  delete old.maintenance;
  getAnswer = old as SeatTickSettingsAnswer;
  const { root } = await mount();
  await open(root);
  expect(mGroup()).toBeNull();
  expect(body().querySelector("[data-seat-tick-details]")).not.toBeNull();
});
