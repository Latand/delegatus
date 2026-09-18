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
const { resetSeatTickSettingsCacheForTests } = await import("../orchestrator/useSeatTickSettings");
import type { OrchestratorPanelState } from "../orchestrator/seatState";

const PROJECT = "atlas";
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
  if (!url.startsWith("/api/monitor/seat-tick/settings")) return json({});
  if (method === "PUT") {
    const next = putAnswers.length > 1 ? putAnswers.shift()! : putAnswers[0]!;
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
      viewerMcpRegistered={false}
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
  requests.length = 0;
  getAnswer = record();
  putAnswers = [{ status: 200, body: record() }];
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
const row = () => body().querySelector("[data-seat-tick-row]") as HTMLButtonElement | null;
const tickSheet = () => body().querySelector('[data-mobile2-sheet="tick"]') as HTMLElement | null;
const seatSheet = () => body().querySelector('[data-mobile2-sheet="seat"]') as HTMLElement | null;
const save = () => body().querySelector("[data-seat-tick-save]") as HTMLButtonElement;
const interval = () => body().querySelector("[data-seat-tick-interval]") as HTMLInputElement;
const reason = () => body().querySelector("[data-seat-tick-reason]") as HTMLTextAreaElement;
const summary = () => body().querySelector("[data-seat-tick-summary]")?.textContent ?? "";
const puts = () => requests.filter((entry) => entry.method === "PUT");

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  const props = (element as unknown as Record<string, { onChange(event: unknown): void }>)[key]!;
  element.value = value;
  flushSync(() => props.onChange({ target: element }));
}

async function openTick(root: Root): Promise<void> {
  flushSync(() => row()!.click());
  await settle(root);
  expect(tickSheet()).not.toBeNull();
}

test("the live seat sheet carries the tick as a row, above Edit the mandate, with the same summary and dot", async () => {
  getAnswer = record();
  await mount();
  const entry = row();
  expect(entry).not.toBeNull();
  expect(entry!.className).toContain("min-h-11");
  expect(entry!.getAttribute("data-mobile2-open")).toBe("tick");
  expect(entry!.getAttribute("data-seat-tick-row")).toBe("healthy");
  /* The desktop's closed summary without its «Tick:» prefix — the sheet has
     already said which seat this is. */
  expect(entry!.textContent).toContain("every 60 min · last check 3m ago");
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
  expect(row()!.textContent).toContain("off since 2h ago");
  expect(row()!.querySelector("[data-seat-tick-dot]")?.getAttribute("data-seat-tick-dot")).toBe("muted");
});

test("an enabled tick with no recent check reads as stale on the row while its face keeps the schedule", async () => {
  getAnswer = record({
    state: { lastCheckAt: ago(40), lastWakeAt: null, lastWakeReasons: [], outstandingWake: null, retryGuard: [], sourceGap: null, accountingGap: null },
  });
  const root = await mount();
  expect(row()!.getAttribute("data-seat-tick-row")).toBe("stale");
  expect(row()!.textContent).toContain("every 60 min");
  expect(row()!.textContent).toContain("stale: last check 40m ago");
  await openTick(root);
  expect(body().querySelector("[data-seat-tick-sentence]")?.textContent).toContain("Enabled, and stale");
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
  /* Save is in the footer, outside the scrolling body: that is what keeps it
     above the keyboard when the interval field is focused. */
  expect(sheet.querySelector("[data-mobile2-sheet-body] [data-seat-tick-save]")).toBeNull();
  expect(save()).not.toBeNull();
  expect(save().className).toContain("min-h-11");
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
  flushSync(() => save().click());
  await settle(root);

  expect(puts()).toHaveLength(1);
  expect(puts()[0]!.body).toEqual({ project: PROJECT, wakeIntervalMinutes: 15, reason: "watching a release" });
  expect(summary()).toContain("every 15 min");
  expect(save().disabled).toBe(true);
  expect(body().querySelector("[data-seat-tick-error]")).toBeNull();
});

test("a refused save on the phone rolls the display back and shows the module's own words", async () => {
  getAnswer = record();
  const root = await mount();
  await openTick(root);
  type(interval(), "30");
  putAnswers = [{
    status: 400,
    body: { error: "a reason is required when the tick is disabled or its wake interval is changed; a quiet tick with no recorded reason is indistinguishable from a broken one" },
  }];
  flushSync(() => save().click());
  await settle(root);

  expect(puts()).toHaveLength(1);
  expect(summary()).toContain("every 60 min");
  const error = body().querySelector("[data-seat-tick-error]");
  expect(error?.getAttribute("role")).toBe("alert");
  expect(error?.textContent).toContain("a reason is required when the tick is disabled or its wake interval is changed");
  /* The field being corrected keeps what was typed into it. */
  expect(interval().value).toBe("30");
});
