import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/*
 * #1671 end to end on the phone: the real Viewer, its file poll, its bar and
 * the board under it. The badge in the bar and the Needs-you rows are one
 * queue (README §4.6), so what a swipe does to a pipeline row has to reach
 * both in the same tap — Hide through the optimistic pipeline record every
 * reader shares, Close lane through the held act the receipt owns — and a hide
 * the server refuses has to put both back. The pipeline PATCH is held open
 * here, so everything asserted before it answers is the optimistic render.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = "atlas";
const dom = new Window({ url: `http://localhost/#p=${PROJECT}`, width: 390, height: 844 });
const matchMedia = (query: string) => ({
  matches: String(query) === MOBILE_LAYOUT_QUERY || String(query).includes("pointer: coarse"),
  media: String(query), onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  location: dom.location,
  history: dom.history,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  matchMedia,
});
Object.assign(dom, { matchMedia });
(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  finished: Promise.resolve(), cancel() {}, finish() {}, addEventListener() {}, removeEventListener() {},
});
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

mock.module("@/hooks/runtimeBus", () => ({
  SNAPSHOT_URL: "/api/runtime/snapshot",
  STREAM_URL: "/api/runtime/stream",
  STREAM_RECONNECTED_EVENT: "llv:stream-reconnected",
  isRuntimeUiEnabled: () => false,
  getRuntimeBus: () => ({
    getState: () => ({ connection: "offline" }),
    subscribe: () => () => {},
    subscribeFilesRevision: () => () => {},
  }),
}));

const { Viewer } = await import("./Viewer");
const { resetFilesClientCacheForTests } = await import("@/hooks/useFiles");
const { pendingPipelineActs } = await import("./mobile/MobilePipelineScreen");
const { receipts } = await import("./mobile/MobileReceipt");
const { getMobileNav } = await import("./mobile/mobileNav");

const NOW = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();

const finished = {
  root: "claude-projects", name: "done.jsonl", path: "/repo/done.jsonl", project: PROJECT, title: "Write the release notes",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: NOW - 900, size: 2_048, activity: "recent",
  proc: null, pid: null, model: "opus", pendingQuestion: null, waitingInput: null, conversationId: "conversation_done",
} as unknown as FileEntry;

const lane = (id: string, task: string): Pipeline => ({
  id, task, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `lane/${id}`, baseBranch: "main", baseRef: "main",
  lastPassedCommit: "", stages: [{ id: "implement", kind: "run" }, { id: "review", kind: "review-loop" }],
  runs: [{ stageId: "review", attempts: [{ n: 2, state: "failed", verdict: { status: "fail", findings: ["one"] }, completedAt: iso(3_600) }] }],
  cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
  state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
  createdAt: iso(7_200), closedAt: null,
}) as unknown as Pipeline;

const PIPELINES = [lane("p-a", "Fast conversation switching"), lane("p-b", "Stage verdict recovery")];

const emptyBoard = (): BoardProjectStateV1 => ({
  schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {},
  prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
});
let board = emptyBoard();
let pipelineReply: ((body: Record<string, unknown>) => Promise<Response>) | null = null;
const pipelinePatches: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/files")) {
      return Response.json({
        files: [finished], projectCatalog: [{ project: PROJECT, conversations: 1 }], flows: [], pipelines: PIPELINES,
        workflows: [], tasks: [], systemHealth: { tmux: { status: "healthy" } },
      });
    }
    if (url.startsWith("/api/board")) {
      if (method !== "GET") {
        const body = JSON.parse(String(init?.body)) as { mutations?: BoardMutationV1[] };
        const reduced = applyBoardMutations(board, body.mutations ?? []);
        board = { ...reduced, schemaVersion: 1, revision: board.revision + 1, pathAliases: reduced.pathAliases ?? {} };
        return Response.json({ ok: true, applied: true, board });
      }
      return Response.json({ ok: true, board });
    }
    if (url.startsWith("/api/orchestrator/seat")) return Response.json({ seat: null, pending: null, exists: true });
    if (url.startsWith("/api/pipelines/") && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      pipelinePatches.push(body);
      if (pipelineReply) return pipelineReply(body);
      return Response.json({ ok: true, pipeline: PIPELINES.find((pipeline) => url.endsWith(pipeline.id)) });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  resetFilesClientCacheForTests();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  dom.location.hash = `#p=${PROJECT}`;
  dom.document.body.replaceChildren();
  board = emptyBoard();
  pipelineReply = null;
  pipelinePatches.length = 0;
  pendingPipelineActs.cancel();
  receipts.dismiss();
  getMobileNav().home();
  stubFetch();
});

afterEach(() => {
  if (mounted) {
    const root = mounted;
    mounted = null;
    act(() => root.unmount());
  }
  pendingPipelineActs.cancel();
  receipts.dismiss();
  globalThis.fetch = originalFetch;
  dom.document.body.replaceChildren();
});

async function mountViewer(): Promise<HTMLElement> {
  dom.localStorage.setItem("llvProject", PROJECT);
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  return host as unknown as HTMLElement;
}

async function until(check: () => boolean, maxMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > maxMs) throw new Error(`not reached within ${maxMs} ms`);
    await act(async () => { await Bun.sleep(15); });
  }
}

const row = (host: HTMLElement, id: string) => host.querySelector(`[data-mobile2-board] [data-mobile2-swipe-row="pipeline:${id}"]`) as HTMLElement | null;
const trayButton = (host: HTMLElement, id: string, key: string) =>
  host.querySelector(`[data-mobile2-swipe-row="pipeline:${id}"] [data-mobile2-swipe-action="${key}"]`) as HTMLElement;
const badge = (host: HTMLElement) => host.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? null;
const receiptText = () => dom.document.querySelector("[data-mobile2-receipt]")?.textContent ?? "";

function swipeLeft(target: HTMLElement): void {
  const card = target.querySelector("[data-mobile2-swipe-card] [data-mobile2-row]")!;
  for (const [type, x] of [["pointerdown", 350], ["pointermove", 340], ["pointermove", 150], ["pointerup", 150]] as const) {
    card.dispatchEvent(new dom.PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: 30, pointerId: 3, pointerType: "touch", isPrimary: true,
    }) as unknown as Event);
  }
}

test("phone: Hide takes a lane off the board and out of the bar's badge on the tap, and a refused hide puts both back", async () => {
  const host = await mountViewer();
  await until(() => row(host, "p-a") !== null && row(host, "p-b") !== null);
  expect(badge(host)).toBe("2");

  let refuse: (() => void) | null = null;
  pipelineReply = () => new Promise<Response>((resolve) => {
    refuse = () => resolve(new Response(JSON.stringify({ error: "the lane moved on" }), { status: 409 }));
  });
  act(() => swipeLeft(row(host, "p-a")!));
  act(() => trayButton(host, "p-a", "hide").click());

  /* The server has not answered, and the row and the count moved together. */
  expect(pipelinePatches).toEqual([{ action: "dismiss" }]);
  expect(row(host, "p-a")).toBeNull();
  expect(badge(host)).toBe("1");
  /* The queue sheet the badge opens lists the same one lane. */
  act(() => (host.querySelector('[data-mobile2-open="attention"]') as HTMLElement).click());
  const sheet = dom.document.querySelector('[data-mobile2-sheet="attention"]')!;
  expect(sheet).not.toBeNull();
  expect([...sheet.querySelectorAll("[data-mobile2-pipeline-row]")].map((el) => el.getAttribute("data-mobile2-pipeline-row"))).toEqual(["p-b"]);
  act(() => (sheet.querySelector("[data-mobile2-close]") as unknown as HTMLElement).click());

  await until(() => refuse !== null);
  await act(async () => { refuse!(); await Bun.sleep(20); });
  await until(() => row(host, "p-a") !== null);
  expect(badge(host)).toBe("2");
  expect(receiptText()).toContain("the lane moved on");
});

test("phone: Close lane leaves the board and the badge on the tap, sends nothing inside its receipt, and Restore brings both back", async () => {
  const host = await mountViewer();
  await until(() => row(host, "p-a") !== null && row(host, "p-b") !== null);
  expect(badge(host)).toBe("2");

  act(() => swipeLeft(row(host, "p-b")!));
  act(() => trayButton(host, "p-b", "closeLane").click());
  expect(row(host, "p-b")).toBeNull();
  expect(badge(host)).toBe("1");
  await act(async () => { await Bun.sleep(40); });
  expect(pipelinePatches).toEqual([]);

  act(() => (dom.document.querySelector('[data-mobile2-receipt-undo="restore"]') as unknown as HTMLElement).click());
  expect(row(host, "p-b")).not.toBeNull();
  expect(badge(host)).toBe("2");
  await act(async () => { await Bun.sleep(40); });
  expect(pipelinePatches).toEqual([]);
});
