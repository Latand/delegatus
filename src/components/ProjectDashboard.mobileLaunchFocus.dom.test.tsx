import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useEffect, useMemo, useState } from "react";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { FileEntry } from "@/lib/types";

/*
 * Launching an agent from the phone's draft screen (mobile v2 §3.3). The draft
 * is the conversation on top of the navigation stack; once the agent is
 * launched, that screen has to BECOME the new agent's conversation — in place
 * and from the first frame — and keep following it when the server replaces
 * the provisional `spawn:<launchId>` card with the scanned transcript. Before
 * the fix the stale `draft::` screen stayed on top, the focus view fell back to
 * the most attention-worthy conversation (the previous one) and Back needed
 * two taps.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inertRuntime = { enabled: false, connection: "live" as const, resyncedAt: null, store: emptyStore(), structuredHostsEnabled: false, lastEventAt: null };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => inertRuntime,
  useRuntime: () => inertRuntime,
  useRuntimeSelector: (selector: (state: typeof inertRuntime) => unknown) => selector(inertRuntime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
/* The Viewer paints the launch overlay into every mounted `useFiles`; this
   stands in for that seam. */
const actualFiles = await import("@/hooks/useFiles");
const overlayListeners = new Set<(file: FileEntry) => void>();
mock.module("@/hooks/useFiles", () => ({
  ...actualFiles,
  applySpawnedConversationSnapshot: (file: FileEntry) => { flushSync(() => { for (const listener of overlayListeners) listener(file); }); },
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { getMobileNav, resetMobileNavForTests, topScreen } = await import("@/components/mobile/mobileNav");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
});
const negotiation = {
  dirs: ["/repo"], cwd: "/repo", spawnTransport: "structured",
  imageInput: {
    claude: { supported: true, reason: null, formats: ["image/png"], maxImages: 2, maxRawBytesPerImage: 3, maxEncodedBytesPerRequest: 8 },
    codex: { supported: true, reason: null, formats: ["image/png"], maxImages: 2, maxRawBytesPerImage: 3, maxEncodedBytesPerRequest: 8 },
  },
};
const { resetOrchestratorSeatCacheForTests } = await import("@/components/orchestrator/useOrchestratorSeat");
let rotateSeat: (() => void) | null = null;
let seatBody: unknown = { exists: false, seat: null, pending: null };
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/orchestrator/rotate" && init?.method === "POST") {
      rotateSeat?.();
      return jsonResponse({ ok: true, state: "path-pending", launched: true, transport: "structured", launchId: LAUNCH_ID, conversationId: NEW_CONVERSATION, path: null, initialMessage: "queued" }, 202);
    }
    if (url.startsWith("/api/orchestrator/seat")) return jsonResponse(seatBody);
    if (url.startsWith("/api/board")) {
      return jsonResponse({ board: {
        schemaVersion: 1, revision: 1, updatedAt: new Date(0).toISOString(), pathAliases: {}, explicitManual: [],
        prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false, seenAt: {} },
      } });
    }
    if (url === "/api/spawn" && init?.method === "POST") {
      return jsonResponse({
        ok: true, state: "path-pending", transport: "structured", launched: true, path: null,
        launchId: LAUNCH_ID, conversationId: NEW_CONVERSATION, initialMessage: "queued", target: null,
      }, 202);
    }
    if (url.startsWith("/api/spawn?")) return jsonResponse(negotiation);
    if (url === "/api/accounts") return jsonResponse({ claude: { active: "main", accounts: [] } });
    if (url === "/api/roles") return jsonResponse({}, 404);
    if (url.startsWith("/api/conversations")) return jsonResponse({ items: [], nextCursor: null });
    if (url.startsWith("/api/limits")) return jsonResponse({}, 503);
    return jsonResponse({});
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useFiles", () => actualFiles);
});

const PROJECT = "atlas";
const PREVIOUS_QUESTION = "Which format?";
const DRAFT = "launch-focus-draft";
const LAUNCH_ID = "launch-2410";
const NEW_CONVERSATION = "conversation_new_agent";
const NEW_PATH = "/repo/sessions/new-agent.jsonl";
const NOW = Math.floor(Date.now() / 1000);

const entry = (over: Partial<FileEntry> & { path: string }): FileEntry => ({
  root: "claude-projects", name: over.path.split("/").pop(), project: PROJECT,
  title: "A conversation", engine: "claude", kind: "session", fmt: "claude", parent: null,
  mtime: NOW - 120, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
  pendingQuestion: null, waitingInput: null, conversationId: `conversation_${over.path}`,
  ...over,
} as unknown as FileEntry);

/* The conversation the operator had open before launching. It is waiting on an
   answer, so the focus view's own fallback (the most attention-worthy node)
   would pick it over the freshly launched agent. */
const previous = entry({
  path: "/repo/sessions/previous.jsonl", title: "The previous conversation", mtime: NOW - 600,
  activity: "live", proc: "running", pid: 4_402,
  lastTurn: { startedAt: (NOW - 900) * 1_000, endedAt: null },
  pendingQuestion: {
    kind: "question", toolUseId: "toolu-format", transcriptPath: "/repo/sessions/previous.jsonl", pid: 4_402, paneTarget: null,
    askedAt: new Date((NOW - 540) * 1_000).toISOString(),
    questions: [{ question: PREVIOUS_QUESTION, header: "Format", multiSelect: false, options: [] }],
  },
} as unknown as Partial<FileEntry> & { path: string });
const scanned = entry({
  path: NEW_PATH, title: "The new agent", conversationId: NEW_CONVERSATION, activity: "live", proc: "running", pid: 5_001, mtime: NOW,
  lastTurn: { startedAt: NOW * 1_000, endedAt: null },
} as unknown as Partial<FileEntry> & { path: string });

/* The Viewer's file list: the scanned rows plus whatever overlay and server
   projection this case has put in. */
let setScanned: (files: FileEntry[]) => void = () => {};
const NONE: never[] = [];
let initialFiles = [previous];
const noop = () => {};
function Host() {
  const [base, setBase] = useState<FileEntry[]>(initialFiles);
  const [overlay, setOverlay] = useState<FileEntry | null>(null);
  useEffect(() => {
    const listener = (file: FileEntry) => setOverlay(file);
    overlayListeners.add(listener);
    setScanned = setBase;
    return () => { overlayListeners.delete(listener); };
  }, []);
  const files = useMemo(
    () => (overlay && !base.some((file) => file.conversationId === overlay.conversationId) ? [...base, overlay] : base),
    [base, overlay],
  );
  return (
    <ProjectDashboard
      files={files} flows={NONE} pipelines={NONE} workflows={NONE} tasks={NONE}
      project={PROJECT} loaded openNonce={0} archived={false}
      catalogKnown catalogConversationCount={2} projectCwd="/repo"
      onArchive={noop} onUnarchive={noop} onOpenSearch={noop}
    />
  );
}

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  initialFiles = [previous];
  resetOrchestratorSeatCacheForTests();
  rotateSeat = null;
  seatBody = { exists: false, seat: null, pending: null };
  overlayListeners.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.location.hash = "#p=" + encodeURIComponent(PROJECT);
  resetMobileNavForTests();
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;

/** The title the phone's conversation screen names, from the pane it mounts. */
const paneText = (root: HTMLElement) => q(root, '[data-testid="mobile-focused-pane"]')?.textContent ?? "";

async function launchFromDraft(): Promise<HTMLElement> {
  dom.sessionStorage.setItem(`llvDrafts:${PROJECT}`, JSON.stringify([DRAFT]));
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(<Host />));
  roots.push(root);
  const host = container as unknown as HTMLElement;
  expect(await waitFor(() => q(host, "[data-mobile2-screen=\"board\"]") !== null)).toBe(true);
  flushSync(() => getMobileNav().push({ kind: "chat", id: `draft::${DRAFT}` }));
  expect(await waitFor(() => q(host, "textarea") !== null)).toBe(true);
  await settle();
  const textarea = q(host, "textarea") as unknown as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: "Ship the fix" } }));
  flushSync(() => q(host, "form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  return host;
}

test("launching from the draft screen lands on the new agent, never the previous conversation", async () => {
  const host = await launchFromDraft();
  expect(await waitFor(() => topScreen(getMobileNav().getState()).kind === "chat" && !(topScreen(getMobileNav().getState()) as { id: string }).id.startsWith("draft::"))).toBe(true);
  await settle();
  /* The draft screen became the conversation: one entry over the board, not
     the conversation pushed over a draft that stays underneath it. */
  expect(getMobileNav().getState().stack).toEqual([{ kind: "board" }, { kind: "chat", id: `spawn:${LAUNCH_ID}` }]);
  expect(q(host, '[data-testid="mobile-focused-pane"]')).not.toBeNull();
  expect(paneText(host)).not.toContain(PREVIOUS_QUESTION);
});

test("the screen follows the conversation when the scanned transcript replaces the provisional card", async () => {
  const host = await launchFromDraft();
  expect(await waitFor(() => topScreen(getMobileNav().getState()).kind === "chat" && !(topScreen(getMobileNav().getState()) as { id: string }).id.startsWith("draft::"))).toBe(true);
  await settle();

  /* The transcript materializes: the server's projection drops `spawn:` for the scanned row. */
  flushSync(() => setScanned([previous, scanned]));
  await settle();

  expect(paneText(host)).not.toContain(PREVIOUS_QUESTION);
  expect(host.textContent).toContain("The new agent");
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: NEW_PATH });
});

test("one Back from the launched conversation reaches the board", async () => {
  await launchFromDraft();
  expect(await waitFor(() => topScreen(getMobileNav().getState()).kind === "chat" && !(topScreen(getMobileNav().getState()) as { id: string }).id.startsWith("draft::"))).toBe(true);
  await settle();
  flushSync(() => getMobileNav().back());
  await settle();
  expect(topScreen(getMobileNav().getState()).kind).toBe("board");
});


test("opening a provisional seat without a draft retains its identity across a scan gap and transcript adoption", async () => {
  const provisional = entry({ path: `spawn:${LAUNCH_ID}`, title: "The new seat", conversationId: NEW_CONVERSATION });
  initialFiles = [previous, provisional];
  seatBody = { exists: true, pending: null, seat: { project: PROJECT, conversationId: NEW_CONVERSATION, path: provisional.path, state: "active", mandate: "Run the board", promptVersion: 44, designatedAt: new Date().toISOString(), intent: { launchId: LAUNCH_ID, clientRequestId: "seat-open-fixture", mode: "spawn" } } };
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(<Host />));
  const host = container as unknown as HTMLElement;
  expect(await waitFor(() => q(host, '[data-mobile2-seat-open]') !== null)).toBe(true);
  const row = q(host, '[data-mobile2-seat-open]')!;
  flushSync(() => row.click());
  await settle();
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: provisional.path });
  expect(host.textContent).toContain("The new seat");
  const frames: string[] = [];
  const observer = new dom.MutationObserver(() => frames.push(paneText(host)));
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  // The placeholder can disappear one scan before its same-ID transcript arrives.
  flushSync(() => setScanned([previous]));
  await settle();
  expect(paneText(host)).not.toContain(PREVIOUS_QUESTION);
  expect(host.textContent).toContain("The new seat");
  flushSync(() => setScanned([{ ...previous, mtime: NOW + 100 }, scanned]));
  await settle();
  expect(getMobileNav().getState().stack).toEqual([{ kind: "board" }, { kind: "chat", id: NEW_PATH }]);
  expect(host.textContent).toContain("The new agent");
  expect(frames.some((frame) => frame.includes(PREVIOUS_QUESTION))).toBe(false);
  observer.disconnect();
  // A later deliberate choice is authoritative even while seat polling continues.
  flushSync(() => getMobileNav().replace({ kind: "chat", id: previous.path }));
  await settle();
  expect(paneText(host)).toContain(PREVIOUS_QUESTION);
  flushSync(() => setScanned([{ ...previous, mtime: NOW + 200 }, { ...scanned }]));
  await settle();
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: previous.path });
});


test("rotation from the conversation menu replaces navigation once and follows the successor without a predecessor frame", async () => {
  const seat = (file: FileEntry) => ({ exists: true, pending: null, seat: { project: PROJECT, seatEpoch: file === previous ? 1 : 2, conversationId: file.conversationId, path: file.path, state: "active", mandate: "Run the board", promptVersion: 44, designatedAt: new Date().toISOString(), intent: { launchId: file === previous ? null : LAUNCH_ID, clientRequestId: "rotation-menu-fixture", mode: "spawn" } } });
  seatBody = seat(previous);
  const provisional = entry({ path: `spawn:${LAUNCH_ID}`, title: "The rotated seat", conversationId: NEW_CONVERSATION });
  rotateSeat = () => { seatBody = seat(provisional); flushSync(() => setScanned([previous, provisional])); };
  getMobileNav().push({ kind: "chat", id: previous.path });
  const container = dom.document.createElement("div"); dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element); roots.push(root);
  flushSync(() => root.render(<Host />));
  const host = container as unknown as HTMLElement;
  const click = async (selector: string) => {
    expect(await waitFor(() => q(host, selector) !== null)).toBe(true);
    flushSync(() => q(host, selector)!.click()); await settle();
  };
  await click('[data-mobile2-open="menu"]');
  await click('[data-testid="mobile-menu-seat"]');
  await click('[data-orchestrator-rotate]');
  await click('[data-orchestrator-confirm]');
  expect(await waitFor(() => host.textContent?.includes("The rotated seat") ?? false)).toBe(true);
  expect(getMobileNav().getState().stack).toEqual([{ kind: "board" }, { kind: "chat", id: provisional.path }]);
  const frames: string[] = [];
  const observer = new dom.MutationObserver(() => frames.push(paneText(host)));
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  flushSync(() => setScanned([{ ...previous, mtime: NOW + 100 }, scanned]));
  await settle();
  expect(getMobileNav().getState().stack).toEqual([{ kind: "board" }, { kind: "chat", id: NEW_PATH }]);
  expect(host.textContent).toContain("The new agent");
  expect(frames.some((frame) => frame.includes(PREVIOUS_QUESTION))).toBe(false);
  observer.disconnect();
  flushSync(() => root.unmount()); roots = [];
  initialFiles = [previous, scanned];
  const reopened = createRoot(container as unknown as Element); roots.push(reopened);
  flushSync(() => reopened.render(<Host />)); await settle();
  expect(host.textContent).toContain("The new agent");
  expect(paneText(host)).not.toContain(PREVIOUS_QUESTION);
  await click('[data-mobile2-back]');
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "board" });
});
