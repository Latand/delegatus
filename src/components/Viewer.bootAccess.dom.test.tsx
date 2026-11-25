import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { viewBus } from "@/hooks/viewPresenceBus";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/*
 * The access check decides which SAVED data this document may show. The
 * Viewer's own reads authorize themselves and never wait for it, and a failed
 * or slow check never takes a live board off the screen. Every case mounts the
 * real Viewer with the 64-hex scope the server mints for every confirmed
 * browser, which the other Viewer tests (they answer `scope: null`) do not.
 */

installActEnv();
const dom = new Window({ url: "http://localhost/" });
let hidden = false;
Object.defineProperty(dom.document, "hidden", { configurable: true, get: () => hidden });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, history: dom.history,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent, MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const matchMedia = (query: string) => ({
  matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
});
Object.assign(globalThis, { matchMedia });
Object.assign(dom, { matchMedia });
(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  finished: Promise.resolve(), cancel() {}, finish() {}, addEventListener() {}, removeEventListener() {},
});

const { setRuntimeUiEnabledForTests } = await import("@/hooks/runtimeBus");
const { Viewer } = await import("@/components/Viewer");
const { resetFilesClientCacheForTests } = await import("@/hooks/useFiles");
const { persistedBoard, resetPendingOpensForTest } = await import("@/hooks/useBoardState");
const { readBoardBootAuthority, boardBootRetired, boardBootScopeFor, clearBoardBootOnSignOut, recheckBoardBoot, resetBoardBootAuthorityForTests, setBoardBootRetryClockForTests } = await import("@/lib/client/boardBootAuthority");

const PROJECT = "atlas";
const SCOPE = "c".repeat(64);
const OTHER_SCOPE = "d".repeat(64);
const originalFetch = globalThis.fetch;
const CARD_PATH = "/sessions/alpha.jsonl";
const board: BoardProjectStateV1 = {
  schemaVersion: 1, revision: 3, updatedAt: new Date(0).toISOString(), pathAliases: {}, explicitManual: [CARD_PATH],
  prefs: { manual: [CARD_PATH], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
};
const CARD_TITLE = "Run the atlas board.";
const conversation = {
  path: CARD_PATH, root: "claude-projects", name: "alpha.jsonl", project: PROJECT, title: CARD_TITLE,
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "live", proc: null,
  pid: null, model: null, pendingQuestion: null, waitingInput: null,
};

type Answer = "ok" | "fail" | "throw" | "denied";
type Confirmed = { scope: string; team: boolean; projects?: string[] };
let access: (call: number) => Answer | Confirmed;
let filesAnswer: "ok" | "fail";
/* A card makes the first board render cost seconds; only cases that look at one ask for it. */
let withCard = false;
let boardAnswer: "ok" | "fail";
let served: BoardProjectStateV1 = board;
let accessCalls = 0;
let calls: string[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.split("?")[0]!);
    if (url === "/api/team?view=board-access") {
      accessCalls += 1;
      const answer = access(accessCalls);
      if (answer === "throw") throw new TypeError("network down");
      if (answer === "fail") return new Response("unavailable", { status: 503 });
      if (answer === "denied") return new Response("{}", { status: 401 });
      if (answer === "ok") return Response.json({ scope: SCOPE, projects: null, team: false });
      return Response.json({ scope: answer.scope, projects: answer.projects ?? [PROJECT], team: answer.team });
    }
    if (url.startsWith("/api/files")) {
      if (filesAnswer === "fail") return new Response("upstream is down", { status: 500 });
      return new Response(JSON.stringify({ files: withCard ? [conversation] : [], projectCatalog: [{ project: PROJECT, conversations: withCard ? 1 : 0 }] }));
    }
    if (url.startsWith("/api/orchestrator/seat")) return new Response(JSON.stringify({ seat: null, pending: null, exists: true }));
    if (url.startsWith("/api/board")) {
      if (boardAnswer === "fail") return new Response("board store unavailable", { status: 500 });
      /* A real in-memory layout: the Viewer writes to it as it opens a project,
         and a write answered with anything but its result is retried forever. */
      if ((init?.method ?? "GET").toUpperCase() === "GET") return Response.json({ ok: true, board: served });
      const body = JSON.parse(String(init?.body)) as { mutations?: BoardMutationV1[] };
      served = { ...applyBoardMutations(served, body.mutations ?? []), revision: served.revision + 1 };
      return Response.json({ ok: true, applied: true, board: served });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;
let reloads = 0;
beforeEach(() => {
  setRuntimeUiEnabledForTests(false);
  resetFilesClientCacheForTests();
  resetBoardBootAuthorityForTests();
  resetPendingOpensForTest();
  dom.localStorage.clear();
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.location.hash = "";
  dom.document.body.replaceChildren();
  hidden = false;
  access = () => "ok";
  filesAnswer = "ok";
  withCard = false;
  boardAnswer = "ok";
  served = board;
  accessCalls = 0;
  calls = [];
  reloads = 0;
  (dom.location as unknown as { reload: () => void }).reload = () => { reloads += 1; };
  stubFetch();
});
afterEach(() => {
  if (mounted) { const root = mounted; mounted = null; act(() => root.unmount()); }
  resetBoardBootAuthorityForTests();
  setRuntimeUiEnabledForTests(null);
  globalThis.fetch = originalFetch;
});

async function mountViewer(): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  return host as unknown as HTMLElement;
}
/* Every wait here is on something the page does, counted in turns of the event
   loop and never in milliseconds, so a slow runner needs more turns and no
   case depends on how long one takes. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 5_000; turn += 1) {
    if (condition()) return;
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
  }
  throw new Error(`never reached: ${what}`);
}
const readsStarted = () => ["/api/files", "/api/board", "/api/orchestrator/seat"].every(url => calls.includes(url));
const shell = (host: HTMLElement) => host.querySelector("[data-boot-shell]") !== null;
const skeleton = (host: HTMLElement) => host.querySelector("[data-kanban-skeleton]") !== null;
const seat = (host: HTMLElement) => host.querySelector("[data-orchestrator-panel]") !== null;
const catalogError = (host: HTMLElement) => host.querySelector('[data-catalog-error="true"]') !== null;
/** A retry delay the page scheduled, which the test runs when it chooses. */
type Scheduled = { delay: number; run: () => void; cancelled: boolean; fired: boolean };
function holdRetries(): Scheduled[] {
  const scheduled: Scheduled[] = [];
  setBoardBootRetryClockForTests({
    set: (run, delay) => {
      const entry: Scheduled = { delay, run: () => { entry.fired = true; run(); }, cancelled: false, fired: false };
      scheduled.push(entry);
      return entry;
    },
    clear: handle => { (handle as Scheduled).cancelled = true; },
  });
  return scheduled;
}
const pending = (scheduled: Scheduled[]) => scheduled.filter(entry => !entry.fired && !entry.cancelled);

test("a failed access check never blanks the Viewer: the catalog failure is visible and the catalog was requested", async () => {
  access = () => "throw";
  filesAnswer = "fail";
  const host = await mountViewer();
  await until(() => catalogError(host) && accessCalls >= 1, "the catalog failure notice after a failed check");
  expect(shell(host)).toBe(false);
  expect(catalogError(host)).toBe(true);
  expect(calls).toContain("/api/files");
  expect(readBoardBootAuthority()).toBeNull();
});

test("the catalog, layout and seat are requested before the access check answers, and render without it", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/team?view=board-access") { calls.push("/api/team"); await held; }
    return original(input, init);
  }) as unknown as typeof fetch;
  const host = await mountViewer();
  await until(() => readsStarted() && calls.includes("/api/team") && seat(host), "the three reads and the seat card while the check is held");
  expect(readBoardBootAuthority()).toBeNull();
  expect(shell(host)).toBe(false);
  release();
  await until(() => readBoardBootAuthority()?.scope === SCOPE, "the released access answer");
  expect(seat(host)).toBe(true);
});

test("a failing check asks again after 1, 2, 4 and then 8 seconds, with the board on screen throughout, and a confirmed answer stops the retries", async () => {
  const scheduled = holdRetries();
  access = (call) => call < 5 ? "fail" : "ok";
  const host = await mountViewer();
  await until(() => seat(host) && scheduled.length === 1, "the first retry");
  expect(readBoardBootAuthority()).toBeNull();
  for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
    await until(() => scheduled.length === index + 1, `retry ${index + 1} scheduled`);
    expect(scheduled[index]!.delay).toBe(delay);
    expect(accessCalls).toBe(index + 1);
    expect(seat(host)).toBe(true);
    /* Nothing runs the retry but the test: no second request is in flight. */
    expect(pending(scheduled)).toHaveLength(1);
    await act(async () => { scheduled[index]!.run(); });
  }
  await until(() => readBoardBootAuthority()?.scope === SCOPE, "the confirmed answer");
  expect(accessCalls).toBe(5);
  expect(scheduled.map(entry => entry.delay)).toEqual([1_000, 2_000, 4_000, 8_000]);
  expect(pending(scheduled)).toHaveLength(0);
  expect(seat(host)).toBe(true);
});

test("with a confirmed scope, a failed layout read still renders the cards and the seat and reports the board unavailable", async () => {
  boardAnswer = "fail";
  withCard = true;
  const reports = spyOn(viewBus, "reportContext");
  try {
    const host = await mountViewer();
    const unavailable = () => reports.mock.calls.some(([context]) => (context as { board?: { sync?: string } }).board?.sync === "unavailable");
    await until(() => readBoardBootAuthority()?.scope === SCOPE && unavailable() && host.textContent!.includes(CARD_TITLE), "the failed layout read, with its card on screen");
    expect(calls).toContain("/api/board");
    expect(skeleton(host)).toBe(false);
    expect(seat(host)).toBe(true);
    expect(host.textContent).toContain(CARD_TITLE);
  } finally {
    reports.mockRestore();
  }
});

test("a team tab that hides and returns while the check fails keeps its board on screen", async () => {
  access = (call) => call === 1 ? { scope: SCOPE, team: true } : "throw";
  withCard = true;
  const host = await mountViewer();
  await until(() => readBoardBootAuthority()?.team === true && seat(host) && host.textContent!.includes(CARD_TITLE), "the confirmed team board");
  await act(async () => { hidden = true; dom.document.dispatchEvent(new dom.Event("visibilitychange")); });
  expect(shell(host)).toBe(false);
  expect(host.querySelector("div.hidden")).toBeNull();
  await act(async () => { hidden = false; dom.document.dispatchEvent(new dom.Event("visibilitychange")); });
  await until(() => accessCalls > 1, "the check on return");
  /* Joins the check the return started, so the failed answer has landed. */
  await act(async () => { await recheckBoardBoot(); });
  expect(shell(host)).toBe(false);
  expect(host.querySelector("div.hidden")).toBeNull();
  expect(seat(host)).toBe(true);
  expect(host.textContent).toContain(CARD_TITLE);
  expect(readBoardBootAuthority()?.scope).toBe(SCOPE);
  expect(boardBootRetired()).toBe(false);
});

test("a recheck that names another identity ends the document and starts a new one", async () => {
  access = (call) => call === 1 ? "ok" : { scope: OTHER_SCOPE, team: false };
  const host = await mountViewer();
  await until(() => readBoardBootAuthority()?.scope === SCOPE && seat(host), "the confirmed board");
  await act(async () => { await recheckBoardBoot(true); });
  expect(boardBootRetired()).toBe(true);
  expect(reloads).toBe(1);
  expect(shell(host)).toBe(true);
  expect(seat(host)).toBe(false);
});

test("a recheck the server refuses ends the document and clears what was saved for it, remembered names included", async () => {
  access = (call) => call === 1 ? "ok" : "denied";
  const host = await mountViewer();
  await until(() => readBoardBootAuthority()?.scope === SCOPE, "the confirmed scope");
  dom.localStorage.setItem("llvBoards", JSON.stringify({ scope: SCOPE, boards: [] }));
  dom.localStorage.setItem("llvProjectNames", JSON.stringify({ [PROJECT]: "Stored fixture name" }));
  await act(async () => { await recheckBoardBoot(true); });
  expect(boardBootRetired()).toBe(true);
  expect(dom.localStorage.getItem("llvBoards")).toBeNull();
  expect(dom.localStorage.getItem("llvProjectNames")).toBeNull();
  expect(shell(host)).toBe(true);
  expect(seat(host)).toBe(false);
});

test("signing out ends the document and clears the saved layout and the remembered names", async () => {
  const host = await mountViewer();
  await until(() => readBoardBootAuthority()?.scope === SCOPE && seat(host), "the confirmed board");
  dom.localStorage.setItem("llvBoards", JSON.stringify({ scope: SCOPE, boards: [] }));
  dom.localStorage.setItem("llvProjectNames", JSON.stringify({ [PROJECT]: "Stored fixture name" }));
  await act(async () => { await clearBoardBootOnSignOut(); });
  expect(boardBootRetired()).toBe(true);
  expect(dom.localStorage.getItem("llvBoards")).toBeNull();
  expect(dom.localStorage.getItem("llvProjectNames")).toBeNull();
  expect(shell(host)).toBe(true);
});

/* A project list moves while the person stays the same: a placement, a new
   conversation in a project no workspace holds. That changes what saved data
   may show, never who is looking, so the document keeps its board. */
test("a recheck that only widens the project list keeps the board mounted and reloads nothing", async () => {
  access = (call) => call === 1 ? { scope: SCOPE, team: true, projects: [PROJECT] } : { scope: SCOPE, team: true, projects: [PROJECT, "btlas"] };
  withCard = true;
  const host = await mountViewer();
  await until(() => readBoardBootAuthority()?.team === true && seat(host) && host.textContent!.includes(CARD_TITLE), "the confirmed team board");
  const first = readBoardBootAuthority();
  expect(boardBootScopeFor("btlas")).toBeNull();
  await act(async () => { await recheckBoardBoot(true); });
  expect(readBoardBootAuthority()).not.toBe(first);
  expect(readBoardBootAuthority()?.projects).toEqual([PROJECT, "btlas"]);
  expect(boardBootScopeFor("btlas")).toBe(SCOPE);
  expect(boardBootScopeFor(PROJECT)).toBe(SCOPE);
  expect(reloads).toBe(0);
  expect(boardBootRetired()).toBe(false);
  expect(shell(host)).toBe(false);
  expect(seat(host)).toBe(true);
  expect(host.textContent).toContain(CARD_TITLE);
});

test("a recheck that narrows the project list stops showing the removed project's saved layout and keeps the board", async () => {
  access = (call) => call === 1 ? { scope: SCOPE, team: true, projects: [PROJECT] } : { scope: SCOPE, team: true, projects: [] };
  withCard = true;
  dom.localStorage.setItem("llvBoards", JSON.stringify({ scope: SCOPE, boards: [[PROJECT, board]] }));
  const host = await mountViewer();
  await until(() => readBoardBootAuthority()?.team === true && seat(host) && host.textContent!.includes(CARD_TITLE), "the confirmed team board");
  expect(boardBootScopeFor(PROJECT)).toBe(SCOPE);
  /* The Viewer has also written its own revision of the layout under this scope. */
  expect(persistedBoard(PROJECT)).toBeDefined();
  await act(async () => { await recheckBoardBoot(true); });
  expect(readBoardBootAuthority()?.projects).toEqual([]);
  expect(boardBootScopeFor(PROJECT)).toBeNull();
  expect(persistedBoard(PROJECT)).toBeUndefined();
  expect(reloads).toBe(0);
  expect(boardBootRetired()).toBe(false);
  expect(shell(host)).toBe(false);
  expect(seat(host)).toBe(true);
});
