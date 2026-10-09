import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import type { Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { TaskMutationPorts } from "./useTaskMutations";

/*
 * The orchestrator's expand button (operator, 2026-10-09: «оркестратор у нас
 * сейчас нет возможности его на весь экран развернуть, как раньше»).
 *
 * The seat's conversation used to open as a reader with its own «Open as a
 * full pane» button. #1898 (#1841) took the seat's conversation off the board,
 * and #2612 removed the full-pane button for every reader in favour of the
 * agent window. The button comes back on the seat's head and opens the seat's
 * conversation in that window, like any agent: listed with the other open
 * agents, with the one composer in its reader, and closing the window leaves
 * the board and the seat as they were.
 *
 * The real board renders the real seat through its `seat` slot, as the
 * project dashboard does, under the Viewer-level composer host, so the composer
 * that moves is the hoisted one production renders. The runtime plane and the
 * log tail are stubbed, the seat is handed its read, and no route or state
 * directory is touched.
 */

/* A desktop window: under 800 px tall the seat store starts every project folded. */
const dom = new HappyWindow({ url: "http://localhost/", width: 1440, height: 900 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  FocusEvent: dom.FocusEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
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

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");
const { KanbanSeat } = await import("./KanbanSeat");
const { READER_STORAGE_PREFIX } = await import("./readerMemory");
const { VoiceComposerHost } = await import("@/components/voice/VoiceComposerHost");
const { resetVoiceSlotsForTest } = await import("@/components/voice/voiceSlots");
const { setLocale, translate } = await import("@/lib/i18n");

const PROJECT = "atlas";
const SEAT = "conversation_orch";
const NOW = 1_800_000_000;
const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");

function conversation(name: string, title: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/transcripts/${name}.jsonl`, conversationId: `conversation_${name}`, title, project: PROJECT, root: "claude-projects", kind: "session", fmt: "claude",
    engine: "claude", mtime: NOW - 600, size: 12, activity: "idle", proc: null, pid: null, parent: null, model: "opus", effort: "high", pendingQuestion: null, waitingInput: null, name,
    ...extra,
  } as FileEntry;
}

/* The seat's conversation as the catalog carries it: its own first prompt is its title. */
const seatFile = conversation("orch", "You are the Orchestrator. Mode: standard. Keep at most 3 workers running at once", { activity: "live", proc: "running", pid: 4_242, mtime: NOW - 30 });
const builder = conversation("build-1", "Restore search results after the index rebuild");

const seatRead = {
  status: {
    seat: {
      project: PROJECT,
      seatEpoch: 2,
      conversationId: SEAT,
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

const seatRefs = { conversationIds: [SEAT], paths: [seatFile.path], previous: { conversationIds: [], paths: [] } };

const TASKS: BoardTask[] = [{
  id: "t-search", project: PROJECT, text: "Restore search results", status: "assigned", placement: "unplaced",
  assignments: [{ path: builder.path, conversationId: builder.conversationId, panePid: null, state: "handoff", error: null, at: "2026-09-19T10:00:00.000Z" }],
  createdAt: "2026-09-19T10:00:00.000Z", updatedAt: "2026-09-19T10:00:00.000Z", revision: REV(1),
} as BoardTask];

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/seat/status")) {
      return new Response(JSON.stringify({ project: PROJECT, designated: true, conversationId: SEAT, engine: "claude", model: "opus", accountId: "spare", rotation: null, context: null }));
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  globalThis.fetch = realFetch;
  resetVoiceSlotsForTest();
  setLocale("en");
});

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await tick(5);
}

/** The builder's agent was open from an earlier visit: the window's list has something besides the orchestrator. */
function seedOpenBuilder(): void {
  dom.localStorage.setItem(`${READER_STORAGE_PREFIX}${PROJECT}`, JSON.stringify([{ key: builder.conversationId, path: builder.path, folded: false }]));
}

async function mount(): Promise<HTMLElement> {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(host as never);
  const root = createRoot(host);
  roots.push(root);
  const files = [seatFile, builder];
  flushSync(() => root.render(
    <>
      <VoiceComposerHost files={files} />
      <KanbanBoard
        project={PROJECT}
        seatRefs={seatRefs}
        groups={[]}
        manual={[builder]}
        files={files}
        flows={[]}
        pipelines={[]}
        tasks={[]}
        allTasks={TASKS}
        drafts={[]}
        now={NOW}
        loaded
        catalogFailures={0}
        selection={new Set()}
        onOpenConversations={() => {}}
        mutationPorts={idlePorts}
        seat={(boardId) => (
          <KanbanSeat project={PROJECT} projectName="Atlas" projectCwd="/repos/atlas" files={files} tasks={TASKS} boardId={boardId} seatRead={seatRead} />
        )}
      />
    </>,
  ));
  await settle();
  return host;
}

const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
const seatHead = (host: HTMLElement) => host.querySelector<HTMLElement>(`[data-kanban-seat="${PROJECT}"] [data-seat-head]`);
const expandButton = (host: HTMLElement) => seatHead(host)?.querySelector<HTMLButtonElement>("[data-seat-window]") ?? null;
const agentWindow = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-agent-window]");
const segments = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>("[data-open-agent]")];
const shown = (host: HTMLElement) => agentWindow(host)?.querySelector<HTMLElement>(".reader-slot:not([data-incoming]) [data-kanban-reader]")?.dataset.kanbanReader ?? null;
const seatConversation = (host: HTMLElement) => host.querySelector<HTMLElement>(`[data-kanban-seat="${PROJECT}"] [data-orchestrator-conversation]`);
async function showing(host: HTMLElement, key: string): Promise<HTMLElement> {
  for (let waited = 0; waited < 3000 && shown(host) !== key; waited += 10) await tick(10);
  expect(shown(host)).toBe(key);
  return agentWindow(host)!.querySelector<HTMLElement>(`[data-kanban-reader="${key}"]`)!;
}
const isFocused = (element: Element | null) => element !== null && dom.document.activeElement === (element as never);

test("the seat's head carries the expand button again, in the head's own icon-button look, labelled in en and uk", async () => {
  const host = await mount();
  expect(seatHead(host)?.getAttribute("data-seat-head")).toBe("full");
  const button = expandButton(host);
  expect(button).toBeTruthy();
  expect(button!.className).toBe("icon-btn seat-dock seat-window");
  expect(button!.getAttribute("aria-label")).toBe(translate("en", "orchPanel.seatOpenWindow"));
  expect(button!.getAttribute("aria-label")).toBe("Open in the agent window");
  expect(button!.getAttribute("title")).toBe("Open in the agent window");
  /* The glyph the reader's full-pane button wore before #2612 removed it. */
  expect(button!.querySelector("svg")?.getAttribute("class") ?? "").toContain("lucide-maximize");
  /* It stands right before the fold, the head's last control. */
  expect(button!.nextElementSibling?.hasAttribute("data-seat-collapse")).toBe(true);
  /* Nothing is open yet. */
  expect(agentWindow(host)).toBeNull();

  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  dom.document.body.replaceChildren();
  setLocale("uk");
  const uk = await mount();
  expect(expandButton(uk)?.getAttribute("aria-label")).toBe("Відкрити у вікні агента");
  expect(expandButton(uk)?.getAttribute("title")).toBe("Відкрити у вікні агента");
});

test("pressing it opens the orchestrator in the agent window, listed with the other open agents, with its composer", async () => {
  seedOpenBuilder();
  const host = await mount();
  /* Before: the one composer of the seat's conversation is in the seat. */
  expect(seatConversation(host)?.querySelector("textarea")).toBeTruthy();

  click(expandButton(host));
  const reader = await showing(host, SEAT);
  expect(reader.dataset.role).toBe("orchestrator");
  /* The reader names it the way the seat does, never by its first prompt. */
  expect(reader.querySelector(".ch-title")?.textContent).toBe("Orchestrator");

  const list = agentWindow(host)!.querySelector<HTMLElement>(".aw-list")!;
  expect(segments(list).map((segment) => segment.dataset.openAgent)).toEqual([builder.conversationId, SEAT]);
  const row = segments(list).find((segment) => segment.dataset.openAgent === SEAT)!;
  expect(row.dataset.role).toBe("orchestrator");
  expect(row.querySelector(".or-name")?.textContent).toBe("Orchestrator");
  expect(row.querySelector("[data-open-agent-jump]")?.getAttribute("aria-current")).toBe("true");
  expect(list.querySelector("[data-open-agents-count]")?.textContent).toBe("2 agents open");

  /* Everything a full-screen agent has: its header and its composer, which left the seat for the window. */
  expect(reader.querySelector("[data-reader-close]")).toBeTruthy();
  expect(reader.querySelector("[data-reader-menu]")).toBeTruthy();
  expect(reader.querySelector("textarea")).toBeTruthy();
  expect(seatConversation(host)?.querySelector("textarea")).toBeNull();
  expect(agentWindow(host)!.querySelectorAll("textarea").length).toBe(1);

  /* A row brings another agent in; the orchestrator's composer goes back to the seat under the window. */
  click(segments(list).find((segment) => segment.dataset.openAgent === builder.conversationId)?.querySelector("[data-open-agent-jump]"));
  await showing(host, builder.conversationId!);
  expect(seatConversation(host)?.querySelector("textarea")).toBeTruthy();
  click(segments(agentWindow(host)!).find((segment) => segment.dataset.openAgent === SEAT)?.querySelector("[data-open-agent-jump]"));
  await showing(host, SEAT);
  expect(seatConversation(host)?.querySelector("textarea")).toBeNull();
});

test("closing the window returns to where the operator was: the board and the seat as they were, the keyboard on the expand button", async () => {
  const host = await mount();
  const seat = host.querySelector(`[data-kanban-seat="${PROJECT}"]`);
  const button = expandButton(host);
  flushSync(() => button!.focus());
  click(button);
  const reader = await showing(host, SEAT);

  click(reader.querySelector("[data-reader-close]"));
  await settle();
  expect(agentWindow(host)).toBeNull();
  /* The same seat, unfolded, with its composer back in it. */
  expect(host.querySelector(`[data-kanban-seat="${PROJECT}"]`)).toBe(seat);
  expect(seatHead(host)?.getAttribute("data-seat-head")).toBe("full");
  expect(seatConversation(host)?.querySelector("textarea")).toBeTruthy();
  expect(isFocused(expandButton(host))).toBe(true);
  /* Like any agent, it stays open behind the header's pill. */
  expect(host.querySelector("[data-open-agents-pill] .pill-words")?.textContent).toBe("1 agent");

  /* Escape does the same, and the button opens it again. */
  click(expandButton(host));
  await showing(host, SEAT);
  flushSync(() => {
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(agentWindow(host)).toBeNull();
  expect(seatConversation(host)?.querySelector("textarea")).toBeTruthy();
  expect(isFocused(expandButton(host))).toBe(true);
});

test("a folded seat keeps the button in its strip and opens the orchestrator from there", async () => {
  const host = await mount();
  click(host.querySelector("[data-seat-collapse]"));
  expect(seatHead(host)?.getAttribute("data-seat-head")).toBe("strip");
  const button = expandButton(host);
  expect(button).toBeTruthy();
  click(button);
  await showing(host, SEAT);
});
