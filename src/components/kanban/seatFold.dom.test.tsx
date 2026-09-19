import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

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
const { SEAT_STORAGE_KEY } = await import("./kanbanSeatStore");

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
