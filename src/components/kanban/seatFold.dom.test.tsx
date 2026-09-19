import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * Folding the board's orchestrator panel (issue #1802).
 *
 * The seat already had a collapsed state; what it did not have was a control an
 * operator could find, and a folded bar worth leaving on screen. So the two
 * things asserted here are the ones the operator asked for: the fold is a
 * labelled button, and folding keeps the seat readable — its state word, the
 * marker for a reply that landed while it was away — WITHOUT throwing away what
 * was half-typed into the composer.
 *
 * The harness follows `../orchestrator/OrchestratorPanel.dom.test.tsx`: the
 * runtime plane and the log tail are stubbed so nothing polls, and the seat is
 * handed its read rather than fetching one.
 */

/* The Previous seats rows print clock times; read them in one zone. */
process.env.TZ = "UTC";

/* A desktop window: under 800px tall the seat store starts every project
   folded, which is not the state these cases are about. */
const dom = new HappyWindow({ url: "http://localhost/", width: 1440, height: 900 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: false, connection: "off", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: false, connection: "off", resyncedAt: null, store: emptyStore() }),
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
  refreshRuntime: () => Promise.resolve(false),
}));
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { KanbanSeat } = await import("./KanbanSeat");
const { SEAT_STORAGE_KEY, SEAT_STORAGE_KEY_V1 } = await import("./kanbanSeatStore");
const { popoverLeft } = await import("./kanbanMenus");
const { MobilePreviousSeatsRow, MobilePreviousSeatsScreen } = await import("@/components/orchestrator/PreviousSeats");

const PROJECT = "atlas";
const CONVERSATION = "conversation_orch";
const LAST_REPLY = 1_760_000_100;

const seatFile = {
  path: "/transcripts/orch.jsonl",
  root: "claude-projects",
  name: "orch.jsonl",
  project: PROJECT,
  title: "Orchestrator",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: LAST_REPLY,
  size: 12,
  activity: "live",
  proc: "running",
  pid: 4_242,
  conversationId: CONVERSATION,
  model: "opus",
  lastAssistantMessageAt: LAST_REPLY,
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry;

const seatRead = {
  status: {
    seat: {
      project: PROJECT,
      seatEpoch: 2,
      conversationId: CONVERSATION,
      path: seatFile.path,
      mandate: "run it",
      promptVersion: 3,
      predecessorConversationId: null,
      state: "active",
      intent: { clientRequestId: "req-aaaaaaaa", mode: "spawn", launchId: "launch-a", error: null },
      designatedAt: "2026-09-19T10:00:00.000Z",
      activatedAt: "2026-09-19T10:00:01.000Z",
    },
    pending: null,
    exists: true,
    viewerMcpRegistered: true,
  },
  failed: false,
  refresh: async () => undefined,
} as never;

const realFetch = globalThis.fetch;
beforeEach(() => {
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/seat/status")) {
      return { ok: true, status: 200, json: async () => ({ project: PROJECT, designated: true, conversationId: CONVERSATION, engine: "claude", model: "opus", accountId: "spare", rotation: null, context: null }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
  }) as typeof fetch;
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  globalThis.fetch = realFetch;
  setLocale("en");
});

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountSeat(files: readonly FileEntry[] = [seatFile]): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(
    <KanbanSeat project={PROJECT} projectName="Atlas" projectCwd="/repos/atlas" files={files} boardId="board" seatRead={seatRead} />,
  ));
  return host as unknown as HTMLElement;
}

const foldButton = (host: HTMLElement) => host.querySelector("[data-seat-collapse]") as HTMLButtonElement;
const section = (host: HTMLElement) => host.querySelector(`[data-kanban-seat="${PROJECT}"]`) as HTMLElement;
const click = (element: HTMLElement) => flushSync(() => element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

test("the fold control is a labelled button, and folding is remembered in this browser", async () => {
  const host = mountSeat();
  await settle();

  const button = foldButton(host);
  /* Findable: the word rides the button, not only its tooltip. */
  expect(button.textContent).toContain(translate("en", "orchPanel.seatFoldWord"));
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(section(host).className).not.toContain("folded");

  click(button);
  expect(section(host).getAttribute("data-collapsed")).toBe("1");
  expect(section(host).className).toContain("folded");
  expect(foldButton(host).textContent).toContain(translate("en", "orchPanel.seatUnfoldWord"));
  expect(JSON.parse(dom.localStorage.getItem(SEAT_STORAGE_KEY) ?? "{}").collapsed).toEqual({ [PROJECT]: true });

  click(foldButton(host));
  expect(section(host).getAttribute("data-collapsed")).toBe("0");
});

test("the folded bar keeps the seat's state and the marker for a reply that landed while it was away", async () => {
  const host = mountSeat();
  await settle();

  const marker = () => host.querySelector("[data-seat-unread]");
  expect(marker()).toBeNull();

  click(foldButton(host));
  /* The state word survives the fold: the bar still says what the seat is
     doing, which is the whole reason to leave it on screen. */
  const badge = host.querySelector("[data-orchestrator-badge]");
  expect(badge).not.toBeNull();
  expect((badge?.textContent ?? "").trim().length).toBeGreaterThan(0);
  /* Nothing has replied since it was folded. */
  expect(marker()).toBeNull();

  /* A reply lands while the panel is away. */
  const roots2 = [...roots];
  flushSync(() => roots2[0]!.render(
    <KanbanSeat
      project={PROJECT}
      projectName="Atlas"
      projectCwd="/repos/atlas"
      files={[{ ...seatFile, lastAssistantMessageAt: LAST_REPLY + 60, mtime: LAST_REPLY + 60 } as FileEntry]}
      boardId="board"
      seatRead={seatRead}
    />,
  ));
  await settle();
  expect(marker()?.textContent).toContain(translate("en", "orchPanel.seatUnreadReply"));

  /* Unfolding reads it, so the marker is gone when it folds again. */
  click(foldButton(host));
  await settle();
  click(foldButton(host));
  expect(marker()).toBeNull();
});

test("a draft typed into the seat's composer survives a fold and an unfold", async () => {
  const host = mountSeat();
  await settle();

  const composer = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(composer).not.toBeNull();
  /* Typed the way this repo's other composer tests type: through the field's
     own React onChange, which is the handler a keystroke reaches. */
  const propsKey = Object.keys(composer).find((key) => key.startsWith("__reactProps$"))!;
  const props = (composer as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: "half a thought" } }));
  expect(composer.value).toBe("half a thought");

  click(foldButton(host));
  click(foldButton(host));
  await settle();

  /* The panel is hidden by CSS while folded and never unmounted, so this is the
     same field with the same characters in it. */
  const after = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(after).toBe(composer);
  expect(after.value).toBe("half a thought");
});

test("a folded seat whose read lands after the first render marks nothing until a reply actually moves", async () => {
  /* Production's path, which the cases above skip: the seat-read cache is empty
     after a reload, so the FIRST render of an already-folded seat has no status
     and no file — and therefore no reply timestamp. Whatever lands next is
     yesterday's reply, already read, and must not light the marker. */
  dom.localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ collapsed: { [PROJECT]: true } }));
  const pendingRead = { status: null, failed: false, refresh: async () => undefined } as never;

  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  const render = (read: never, files: readonly FileEntry[]) => flushSync(() => root.render(
    <KanbanSeat project={PROJECT} projectName="Atlas" projectCwd="/repos/atlas" files={files} boardId="board" seatRead={read} />,
  ));

  render(pendingRead, [seatFile]);
  await settle();
  const marker = () => (host as unknown as HTMLElement).querySelector("[data-seat-unread]");
  expect(section(host as unknown as HTMLElement).getAttribute("data-collapsed")).toBe("1");
  expect(marker()).toBeNull();

  /* The read answers a turn later; the seat is still folded. */
  render(seatRead, [seatFile]);
  await settle();
  expect(marker()).toBeNull();

  /* Only now does a reply land — that one is unread. */
  render(seatRead, [{ ...seatFile, lastAssistantMessageAt: LAST_REPLY + 60, mtime: LAST_REPLY + 60 } as FileEntry]);
  await settle();
  expect(marker()?.textContent).toContain(translate("en", "orchPanel.seatUnreadReply"));
});

/* ── #1841: placement, the collapsed shapes, and Previous seats ─────────── */

test("the seat docks at the side and back, remembered per browser, and each placement has its collapsed shape", async () => {
  const host = mountSeat();
  await settle();
  expect(section(host).getAttribute("data-placement")).toBe("top");
  const dock = () => host.querySelector("[data-seat-placement]") as HTMLButtonElement;
  expect(dock().getAttribute("aria-label")).toBe(translate("en", "orchPanel.dockSide"));

  /* Top, collapsed: the 40 px strip, without the project name or Rotate. */
  expect(foldButton(host).querySelector("svg")?.getAttribute("class")).toContain("lucide-chevron-up");
  click(foldButton(host));
  expect(host.querySelector("[data-seat-head]")?.getAttribute("data-seat-head")).toBe("strip");
  expect(host.querySelector(".seat-title .proj")).toBeNull();
  click(foldButton(host));
  expect(host.querySelector("[data-seat-head]")?.getAttribute("data-seat-head")).toBe("full");

  click(dock());
  expect(section(host).getAttribute("data-placement")).toBe("side");
  expect(section(host).className).toContain("side");
  expect(JSON.parse(dom.localStorage.getItem(SEAT_STORAGE_KEY) ?? "{}").placement).toBe("side");
  expect(host.querySelector('[data-seat-grip="width"]')?.getAttribute("aria-orientation")).toBe("vertical");
  expect(dock().getAttribute("aria-label")).toBe(translate("en", "orchPanel.dockTop"));
  /* The fold's arrow points where the panel goes: left, into the rail. */
  expect(foldButton(host).querySelector("svg")?.getAttribute("class")).toContain("lucide-chevron-left");

  /* Side, collapsed: the rail is one button that expands it. */
  click(foldButton(host));
  const rail = host.querySelector("[data-seat-rail]") as HTMLButtonElement;
  expect(rail).not.toBeNull();
  expect(rail.getAttribute("aria-expanded")).toBe("false");
  expect(rail.querySelector("[data-seat-rail-state]")).not.toBeNull();
  expect(host.querySelector("[data-seat-head]")).toBeNull();
  click(rail);
  expect(section(host).getAttribute("data-collapsed")).toBe("0");
  expect(host.querySelector("[data-seat-rail]")).toBeNull();

  click(dock());
  expect(section(host).getAttribute("data-placement")).toBe("top");
});

test("the v1 seat record carries its height and collapsed flags into v2 once", async () => {
  dom.localStorage.setItem(SEAT_STORAGE_KEY_V1, JSON.stringify({ height: 300, collapsed: { [PROJECT]: true } }));
  const host = mountSeat();
  await settle();
  expect(section(host).getAttribute("data-collapsed")).toBe("1");
  expect(JSON.parse(dom.localStorage.getItem(SEAT_STORAGE_KEY) ?? "{}")).toEqual({ height: 300, collapsed: { [PROJECT]: true }, placement: "top", width: null });
});

const withPrevious = (previous: unknown[], currentTaskId: string | null = "task-current") => ({
  ...(seatRead as unknown as { status: object }),
  status: { ...(seatRead as unknown as { status: object }).status, previous, currentTaskId },
}) as never;

const PREVIOUS = [
  { conversationId: "conversation_prev_new", path: null, title: "Manager seat, release week", engine: "claude", heldFrom: "2026-09-18T14:02:00.000Z", heldTo: "2026-09-19T03:10:00.000Z", taskId: "task-new" },
  { conversationId: "conversation_prev_old", path: null, title: null, engine: "codex", heldFrom: null, heldTo: "2026-09-18T14:02:00.000Z", taskId: "task-old" },
];
const TASKS = [
  { id: "task-current", project: PROJECT, text: "Current seat", details: "current notes", status: "assigned", assignments: [] },
  { id: "task-new", project: PROJECT, text: "Manager seat, release week", details: "release notes\nline two", status: "assigned", assignments: [] },
  { id: "task-old", project: PROJECT, text: "Old", details: "old notes", status: "done", assignments: [] },
] as never[];

function mountWith(read: never): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(
    <KanbanSeat project={PROJECT} projectName="Atlas" projectCwd="/repos/atlas" files={[seatFile]} tasks={TASKS} boardId="board" seatRead={read} />,
  ));
  return host as unknown as HTMLElement;
}

test("Previous seats: closed by default, counted, newest first under the live seat, one Notes row open at a time", async () => {
  const host = mountWith(withPrevious(PREVIOUS));
  await settle();
  expect(host.querySelector(".lock")).toBeNull();
  const control = host.querySelector("[data-previous-seats]") as HTMLButtonElement;
  expect(control.getAttribute("data-previous-seats")).toBe("2");
  expect(control.getAttribute("aria-label")).toBe(translate("en", "orchPanel.previousSeatsAria", { count: 2 }));
  expect(dom.document.querySelector("[data-previous-seats-popover]")).toBeNull();

  click(control);
  const popover = dom.document.querySelector("[data-previous-seats-popover]") as unknown as HTMLElement;
  expect(popover).not.toBeNull();
  const rows = [...popover.querySelectorAll("[data-seat-row]")].map((row) => row.getAttribute("data-seat-row"));
  expect(rows).toEqual([CONVERSATION, "conversation_prev_new", "conversation_prev_old"]);
  const newest = popover.querySelector('[data-seat-row="conversation_prev_new"]') as HTMLElement;
  expect(newest.querySelector("a")?.getAttribute("href")).toBe("#c=conversation_prev_new");
  expect(newest.textContent).toContain("Manager seat, release week");
  /* A revocation with no recorded start says only when it ended. */
  expect(popover.querySelector('[data-seat-row="conversation_prev_old"]')?.textContent).toContain("until ");
  /* No title on the revocation: the seat task's own title stands in. */
  expect(popover.querySelector('[data-seat-row="conversation_prev_old"]')?.textContent).toContain("Old");
  expect(popover.querySelector('[data-seat-row="conversation_prev_new"]')?.textContent).toContain("18 Sep 14:02 – 19 Sep 03:10 · 13 h");

  click(newest.querySelector("[data-seat-notes-toggle]") as HTMLElement);
  expect(popover.querySelectorAll("[data-seat-notes]").length).toBe(1);
  /* The open row's toggle says so; its chevron turns on that state. */
  expect(newest.querySelector("[data-seat-notes-toggle]")?.getAttribute("aria-expanded")).toBe("true");
  expect(newest.querySelector("[data-seat-notes-toggle] svg")).not.toBeNull();
  expect(newest.querySelector("[data-seat-notes]")?.textContent).toBe("release notes\nline two");
  click(popover.querySelector('[data-seat-row="conversation_prev_old"] [data-seat-notes-toggle]') as HTMLElement);
  expect(popover.querySelectorAll("[data-seat-notes]").length).toBe(1);
  expect(popover.querySelector('[data-seat-row="conversation_prev_old"] [data-seat-notes]')?.textContent).toBe("old notes");

  /* Escape closes it. */
  flushSync(() => (document as Document).dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  expect(dom.document.querySelector("[data-previous-seats-popover]")).toBeNull();
});

test("Previous seats is hidden at zero, and reads Seat notes when only the live seat has notes", async () => {
  const bare = mountWith(withPrevious([], null));
  await settle();
  expect(bare.querySelector("[data-previous-seats]")).toBeNull();
  const notesOnly = mountWith(withPrevious([]));
  await settle();
  const control = notesOnly.querySelector("[data-previous-seats]") as HTMLButtonElement;
  expect(control.textContent).toContain(translate("en", "orchPanel.seatNotesOnly"));
});

test("the popover sits under its control when right-aligning it would cross the panel's left edge", () => {
  /* Side placement at 1440: the panel starts at 248, the control ends at 394. */
  expect(popoverLeft({ left: 300, right: 394 }, 340, 1440, 248)).toBe(300);
  /* Top, expanded: right-aligned, as every other popover. */
  expect(popoverLeft({ left: 900, right: 1040 }, 340, 1440, 248)).toBe(700);
  /* Never past the viewport. */
  expect(popoverLeft({ left: 1300, right: 1330 }, 340, 1440, 1200)).toBe(1092);
  expect(popoverLeft({ left: 20, right: 60 }, 340, 1440)).toBe(8);
});

function mountNode(node: ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(node));
  return host as unknown as HTMLElement;
}

test("phone: the sheet row reads Seat notes with the live seat alone, and the list carries the live seat first", () => {
  const status = (read: never) => (read as unknown as { status: never }).status;
  /* No previous seats: the live seat's notes are still reachable. */
  const alone = mountNode(<MobilePreviousSeatsRow status={status(withPrevious([]))} onOpen={() => {}} />);
  const row = alone.querySelector("[data-mobile-previous-seats]") as HTMLElement;
  expect(row.getAttribute("data-mobile-previous-seats")).toBe("0");
  expect(row.textContent).toContain(translate("en", "orchPanel.seatNotesOnly"));
  expect(row.querySelector("svg.lucide-chevron-right")).not.toBeNull();
  /* Neither a task for the live seat nor a previous one: no row. */
  expect(mountNode(<MobilePreviousSeatsRow status={status(withPrevious([], null))} onOpen={() => {}} />).querySelector("[data-mobile-previous-seats]")).toBeNull();

  const list = mountNode(<MobilePreviousSeatsScreen status={status(withPrevious(PREVIOUS))} onBack={() => {}} />);
  const rows = [...list.querySelectorAll("[data-seat-row]")].map((node) => [node.getAttribute("data-seat-row"), node.getAttribute("data-seat-current")]);
  expect(rows).toEqual([[CONVERSATION, "1"], ["conversation_prev_new", "0"], ["conversation_prev_old", "0"]]);
  /* Back names the sheet it returns to. */
  expect(list.querySelector("[data-mobile-previous-back]")?.textContent?.trim()).toBe(translate("en", "orchPanel.title"));
});
