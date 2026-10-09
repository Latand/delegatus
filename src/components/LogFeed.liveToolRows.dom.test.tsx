import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import type { SeatDeputyView } from "@/lib/orchestrator/deputyView";
import { enqueueOutbox, resetOutboxForTests } from "./conversation/outbox";
import { setLocale } from "@/lib/i18n";
import { appendRuntimeLiveTurnDelta, projectRuntimeLiveTurnItem, type RuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import { projectEngineHostEvent } from "@/lib/runtime/engineHostEvents";
import { applyEvent, emptyStore, type RuntimeSession, type RuntimeEnvelope } from "@/components/runtime/runtimeModel";

/**
 * Issue #1100: the FIRST live turn of a freshly spawned conversation. The
 * structured host streams prose and tool calls; the transcript tail has read
 * nothing yet. The pane must already show the tool calls, interleaved with the
 * prose in response order — and once the transcript echoes them, the live rows
 * yield to the canonical rows without duplicates.
 */

const dom = new HappyWindow({ width: 1280, height: 800 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, {
  ResizeObserver: TestResizeObserver,
  window: dom,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  IntersectionObserver: undefined,
});

const CONVERSATION_ID = "conversation_first_turn_1100";
const AT = (second: number) => `2026-08-23T08:30:${String(second).padStart(2, "0")}.000Z`;

/* The host's event stream for the first turn, projected by the real reducer
   helpers: a thought, a Read, a Bash that fails, more prose still streaming. */
function firstTurn(): RuntimeLiveTurn {
  let live = appendRuntimeLiveTurnDelta(null, "turn-first", "Reading the issue first.", AT(0));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "assistant", uuid: "uuid-text-1",
    message: { role: "assistant", content: [{ type: "text", text: "Reading the issue first." }] },
  }, "completed", AT(1));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "assistant", uuid: "uuid-tool-read",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/AGENTS.md" } }] },
  }, "completed", AT(2));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "user", uuid: "uuid-result-read",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read" }] },
  }, "completed", AT(3));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "assistant", uuid: "uuid-tool-bash",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "gh issue view 1100" } }] },
  }, "completed", AT(4));
  live = projectRuntimeLiveTurnItem(live, "turn-first", {
    type: "user", uuid: "uuid-result-bash",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", is_error: true }] },
  }, "completed", AT(5));
  live = appendRuntimeLiveTurnDelta(live, "turn-first", "The CLI is not authenticated, retrying", AT(6));
  return live!;
}

/* The transcript echo of that same turn, as the tail reads it a moment later. */
const TRANSCRIPT_ECHO = [
  { type: "user", uuid: "uuid-prompt", timestamp: AT(0), message: { role: "user", content: [{ type: "text", text: "Fix issue 1100" }] } },
  { type: "assistant", uuid: "uuid-text-1", timestamp: AT(1), message: { role: "assistant", content: [{ type: "text", text: "Reading the issue first." }] } },
  { type: "assistant", uuid: "uuid-tool-read", timestamp: AT(2), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/repo/AGENTS.md" } }] } },
  { type: "user", uuid: "uuid-result-read", timestamp: AT(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "# AGENTS" }] } },
  { type: "assistant", uuid: "uuid-tool-bash", timestamp: AT(4), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "gh issue view 1100" } }] } },
  { type: "user", uuid: "uuid-result-bash", timestamp: AT(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", is_error: true, content: "gh: not logged in" }] } },
].map((line) => JSON.stringify(line));

const session: RuntimeSession = {
  conversationId: CONVERSATION_ID,
  sessionKey: { engine: "claude", sessionId: "session-first-turn" },
  hostKind: "claude-broker",
  host: "hosted",
  turn: "running",
  provenance: "structured",
  revision: 9,
  attentionIds: [],
  recentReceipts: [],
  accountId: null,
  parentConversationId: null,
  flowId: null,
  workflowId: null,
  cwd: "/repo",
  artifactPath: null,
  capabilities: { steer: true, structuredAttention: true },
  activeTurnId: "turn-first",
  liveTurn: firstTurn(),
};

const tailState = { lines: [] as string[], linesStart: 0, loading: false, size: null as number | null, error: null as string | null };
/* The hosted session a test renders against; tests swap the live turn. */
const sessionState = { session };

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const actualDeputy = await import("./conversation/DeputyBlock");
const actualMobile = await import("@/hooks/useIsMobile");
let phone = false;
mock.module("@/hooks/useIsMobile", () => ({ ...actualMobile, useIsMobile: () => phone }));
mock.module("./conversation/DeputyBlock", () => ({ ...actualDeputy,
  DeputyBlock: () => <div data-deputy-block="fixture">Deputy answer</div>,
}));
const inertRuntime = { enabled: true, connection: "live" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => ({
    session: sessionState.session,
    uiState: "working",
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  }),
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: () => ({
    lines: tailState.lines,
    linesStart: tailState.linesStart,
    size: tailState.size ?? tailState.lines.length,
    loading: tailState.loading,
    error: tailState.error,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));
mock.module("@/hooks/useToolActivityCues", () => ({
  ...actualToolCues,
  useToolActivityCues: () => undefined,
}));

const { LogFeed } = await import("./LogFeed");
const { resetCanonicalAssistantClaimsForTests } = await import("./conversation/liveTurnHandoff");

const roots = new Set<Root>();
beforeEach(() => {
  phone = false;
  setLocale("en");
  dom.sessionStorage.clear();
  resetOutboxForTests();
  resetCanonicalAssistantClaimsForTests();
  tailState.lines = [];
  tailState.linesStart = 0;
  tailState.loading = false;
  tailState.size = null;
  tailState.error = null;
  sessionState.session = session;
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
  mock.module("./conversation/DeputyBlock", () => actualDeputy);
  mock.module("@/hooks/useIsMobile", () => actualMobile);
});

const file: FileEntry = {
  path: "/fixtures/claude/projects/-repo/session-first-turn.jsonl",
  root: "claude-projects",
  name: "session-first-turn.jsonl",
  project: "repo",
  title: "Fix issue 1100",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: Date.parse(AT(6)) / 1000,
  size: 1,
  activity: "live",
  proc: "running",
  pid: 7,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: CONVERSATION_ID,
} as FileEntry;

function render(deputies?: SeatDeputyView[]): { host: HTMLElement; root: Root; paint: () => void } {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  const paint = () => flushSync(() => {
    root.render(
      <LogFeed
        file={file}
        deputies={deputies}
        showSvc={false}
        lineFilter=""
        onStatus={() => undefined}
        paused
        follow={false}
        setFollow={() => undefined}
      />,
    );
  });
  paint();
  return { host: host as unknown as HTMLElement, root, paint };
}

function liveRows(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-live-turn]")].map((row) =>
    row.dataset.liveTool ? `tool:${row.dataset.liveTurnItemId}:${row.dataset.liveToolStatus}` : `prose:${row.dataset.liveTurnItemId ?? "streaming"}`);
}

test("the first live turn shows tool calls interleaved with prose before the transcript has read anything", () => {
  const { host } = render();
  /* No transcript rows at all: this is the launch window, tail unread. */
  expect(host.querySelectorAll("[data-feed-kind]").length).toBe(0);
  /* Every tool call of the turn is on screen, in response order, with its outcome. */
  expect(liveRows(host)).toEqual([
    "prose:uuid-text-1",
    "tool:toolu_read:ok",
    "tool:toolu_bash:err",
    "prose:streaming",
  ]);
  const bash = host.querySelector<HTMLElement>('[data-live-turn-item-id="toolu_bash"]')!;
  expect(bash.textContent).toContain("gh issue view 1100");
  expect(bash.textContent).toContain("error");
  const read = host.querySelector<HTMLElement>('[data-live-turn-item-id="toolu_read"]')!;
  expect(read.textContent).toContain("AGENTS.md");
});

test("once the transcript echoes the calls, the live tool rows yield without duplicates and the order stays stable", () => {
  tailState.lines = TRANSCRIPT_ECHO;
  const { host } = render();
  /* The canonical rows now carry the calls (a folded run of two tool cards). */
  const canonicalToolIds = [...host.querySelectorAll<HTMLElement>("[data-feed-kind]")]
    .filter((row) => row.dataset.feedKind === "tool" || row.dataset.feedKind === "cmd-group");
  expect(canonicalToolIds.length).toBeGreaterThan(0);
  /* Nothing is shown twice: the prose and both tool rows were claimed, only the
     still-streaming prose remains in the live tail, below the transcript. */
  expect(liveRows(host)).toEqual(["prose:streaming"]);
  expect(host.querySelectorAll('[data-live-turn-item-id="toolu_read"]').length).toBe(0);
  expect(host.querySelectorAll('[data-live-turn-item-id="toolu_bash"]').length).toBe(0);
  const all = [...host.querySelectorAll<HTMLElement>("[data-feed-kind], [data-live-turn]")];
  expect(all.at(-1)?.hasAttribute("data-live-turn")).toBeTrue();
});

test("a live tool row newer than every transcript record still yields to the row that carries its call id", () => {
  /* The transcript has the Bash call but not its result yet: the live row
     (finished, newer than anything in the file) is claimed by identity, and the
     canonical card is what shows the call now — still running, in its view. */
  tailState.lines = TRANSCRIPT_ECHO.slice(0, -1);
  const { host } = render();
  expect(liveRows(host)).toEqual(["prose:streaming"]);
  const rows = [...host.querySelectorAll<HTMLElement>("[data-feed-kind]")];
  expect(rows.some((row) => row.textContent?.includes("gh issue view 1100"))).toBeTrue();
});

/* Two calls issued in one message run in parallel: the Read settles first, the
   long Bash is still going. The rows keep response order, so the NEWEST row is
   the settled one and the running call sits above it. */
function parallelTurn(): RuntimeLiveTurn {
  let live = projectRuntimeLiveTurnItem(null, "turn-parallel", {
    type: "assistant", uuid: "uuid-parallel",
    message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_sleep", name: "Bash", input: { command: "sleep 30 && echo done" } },
      { type: "tool_use", id: "toolu_read_2", name: "Read", input: { file_path: "/repo/README.md" } },
    ] },
  }, "completed", AT(1));
  live = projectRuntimeLiveTurnItem(live, "turn-parallel", {
    type: "user", uuid: "uuid-result-read-2",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_2" }] },
  }, "completed", AT(2));
  return live!;
}

test("issue 1100 review: the status bar names the newest RUNNING tool, not a later parallel call that already settled", () => {
  sessionState.session = { ...session, activeTurnId: "turn-parallel", liveTurn: parallelTurn() };
  const { host } = render();
  expect(liveRows(host)).toEqual(["tool:toolu_sleep:run", "tool:toolu_read_2:ok"]);
  const bar = host.querySelector<HTMLElement>('[data-turn-status="running"]');
  expect(bar?.textContent).toContain("running sleep");
});


test("issue 1565: streamed old tools leave the tail when a later turn owns the transcript window", () => {
  let store = emptyStore();
  const scope = { type: "session" as const, id: CONVERSATION_ID };
  const ingest = (kind: string, payload: Record<string, unknown>, at: string, recordedOnly = false) => {
    const revision = (store.scopeHeads[`session:${CONVERSATION_ID}`] ?? 0) + 1;
    const result = applyEvent(store, { schemaVersion: 1, seq: revision, eventId: `event-${revision}`, scope,
      revision, kind, payload, ...(recordedOnly ? {} : { occurredAt: at }), recordedAt: at } as RuntimeEnvelope);
    if (result.outcome !== "applied") throw Error(result.outcome);
    store = result.store;
  };
  ingest("session-status", { ...session, liveTurn: null }, AT(0));
  for (const [id, second, recordedOnly] of [["old-mcp", 2, false], ["old-command", 3, true]] as const) {
    ingest("item", { conversationId: CONVERSATION_ID, turnId: "earlier-turn", phase: "completed",
      item: { type: "mcpToolCall", id, server: "viewer", tool: "board_snapshot", arguments: { clientRequestId: id }, status: "completed" } }, AT(second), recordedOnly);
  }
  sessionState.session = store.sessions[CONVERSATION_ID];
  const first = render();
  expect(first.host.querySelectorAll("[data-live-tool]").length).toBe(2);
  flushSync(() => first.root.unmount()); roots.delete(first.root); first.host.remove();
  ingest("item", { conversationId: CONVERSATION_ID, turnId: "later-turn", phase: "started",
    item: { type: "commandExecution", id: "current-command", command: "echo current", status: "inProgress" } }, AT(20));
  sessionState.session = store.sessions[CONVERSATION_ID];
  tailState.lines = [JSON.stringify({ type: "assistant", uuid: "later-reply", timestamp: AT(10),
    message: { role: "assistant", content: [{ type: "text", text: "Later turn response" }] } })];
  const { host } = render();
  expect(host.textContent).toContain("Later turn response");
  expect([...host.querySelectorAll("[data-live-turn-item-id]")].map(row => row.getAttribute("data-live-turn-item-id"))).toEqual(["current-command"]);
});


test("completed answer and reconnect retain the same DOM row until its delayed echo", () => {
  const answer = "An answer that stays visible.";
  const pending = { itemId: null, text: answer, phase: "streaming" as const, startedAt: AT(0), completedAt: null };
  sessionState.session = { ...session, liveTurn: { turnId: "delayed-turn", text: answer, items: [pending] } };
  const { host, paint } = render();
  const row = host.querySelector("[data-live-turn]")!;
  expect(row.textContent).toContain(answer);
  sessionState.session = { ...session, turn: "idle", liveTurn: { turnId: "delayed-turn", text: answer,
    items: [{ ...pending, itemId: "delayed-answer", phase: "awaiting-echo", completedAt: AT(1) }] } };
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(5), message: { content: "Next request" } })];
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(row);
  sessionState.session = { ...session, turn: "unknown", liveTurn: null };
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(row);
  tailState.lines = [...tailState.lines, JSON.stringify({ type: "assistant", uuid: "delayed-answer", timestamp: AT(1),
    message: { content: [{ type: "text", text: answer }] } })];
  paint();
  expect(host.querySelector('[data-feed-source-id="delayed-answer"]')).toBe(row);
  expect(host.querySelectorAll('[data-feed-source-id="delayed-answer"]')).toHaveLength(1);
  expect(row.textContent).toContain(answer);
  const following = host.querySelector('[data-feed-kind="user"]')!;
  expect(row.compareDocumentPosition(following) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});


test("composer follow-up stays after the answer while both echoes are pending", () => {
  const answer = "Answer before follow-up";
  sessionState.session = { ...session, liveTurn: { turnId: "before-follow-up", text: answer, items: [{
    itemId: "before-follow-up", text: answer, phase: "awaiting-echo", startedAt: AT(0), completedAt: AT(1), omittedChars: 42,
  }] } };
  enqueueOutbox(CONVERSATION_ID, { id: "follow-up", text: "My next request", images: 0, at: Date.parse(AT(5)) });
  const { host, paint } = render();
  const row = host.querySelector("[data-live-turn]")!;
  expect(row.querySelector("[data-live-turn-omitted-chars]")?.textContent).toContain("42");
  const followUp = host.querySelector("[data-message-row]")!.closest("[data-feed-kind]")!;
  expect(row.compareDocumentPosition(followUp) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  tailState.lines = [JSON.stringify({ type: "assistant", uuid: "before-follow-up", timestamp: AT(1),
    message: { content: [{ type: "text", text: answer }] } })];
  paint();
  expect(host.querySelector('[data-feed-source-id="before-follow-up"]')).toBe(row);
  expect(row.querySelector("[data-live-turn-omitted-chars]")).toBeNull();
  expect(row.compareDocumentPosition(followUp) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("one host message keeps prose before its same-timestamp tool", () => {
  const liveTurn = projectRuntimeLiveTurnItem(null, "one-message", {
    type: "assistant", uuid: "one-message-prose", message: { content: [
      { type: "text", text: "First the explanation." },
      { type: "tool_use", id: "one-message-tool", name: "Bash", input: { command: "pwd" } },
    ] },
  }, "completed", AT(1));
  sessionState.session = { ...session, liveTurn };
  expect(liveRows(render().host)).toEqual(["prose:one-message-prose", "tool:one-message-tool:run"]);
});

test("an idle snapshot retains observed text until its own echo arrives", () => {
  sessionState.session = { ...session, liveTurn: { turnId: "stranded", text: "Partial draft", items: [{
    itemId: null, text: "Partial draft", phase: "streaming", startedAt: AT(0), completedAt: null,
  }] } };
  const { host, paint } = render();
  const original = host.querySelector("[data-live-turn]");
  expect(host.querySelector("[data-live-turn-caret]")).not.toBeNull();
  sessionState.session = { ...sessionState.session, turn: "idle", liveTurn: null };
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(5), message: { content: "Later request" } })];
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(original);
  expect(host.querySelector("[data-live-turn-caret]")).toBeNull();
  tailState.lines = [...tailState.lines, JSON.stringify({ type: "assistant", uuid: "settled-draft", timestamp: AT(3), message: { content: [{ type: "text", text: "Partial draft completed" }] } })];
  paint();
  expect(host.querySelector('[data-feed-source-id="settled-draft"]')).toBe(original);
  expect(original?.textContent).toContain("Partial draft completed");
});

test("canonical text-tool-text fragments retain their source order at handoff", () => {
  const record = { type: "assistant", uuid: "fragmented-answer", timestamp: AT(1), message: { content: [
    { type: "text", text: "Before call" },
    { type: "tool_use", id: "fragmented-tool", name: "Bash", input: { command: "pwd" } },
    { type: "text", text: "After call" },
  ] } };
  sessionState.session = { ...session, liveTurn: projectRuntimeLiveTurnItem(null, "fragments", record, "completed", AT(1)) };
  const { host, paint } = render();
  tailState.lines = [JSON.stringify(record)];
  paint();
  expect([...host.querySelectorAll<HTMLElement>("[data-feed-kind]")].map(row => row.dataset.feedKind === "tool" ? "tool" : row.textContent?.includes("Before call") ? "before" : "after"))
    .toEqual(["before", "tool", "after"]);
});

test("all unclaimed replies remain readable in the shared scroller", () => {
  sessionState.session = { ...session, liveTurn: { turnId: "bounded", text: "Reply 39", items: Array.from({ length: 40 }, (_, i) => ({
    itemId: `bounded-${i}`, text: `Reply ${i}`, phase: "awaiting-echo" as const, startedAt: AT(i), completedAt: AT(i),
  })) } };
  const { host } = render();
  expect(host.querySelectorAll("[data-live-turn]")).toHaveLength(40);
  expect(host.querySelector("[data-live-turn-earlier]")).toBeNull();
});

test("streaming markdown holds unfinished fences and tables until completion", () => {
  const partial = "Patch:\n\n```ts\nconst x = 1;";
  sessionState.session = { ...session, liveTurn: appendRuntimeLiveTurnDelta(null, "markdown", partial, AT(1)) };
  const { host, paint } = render();
  const row = host.querySelector("[data-live-turn]")!;
  expect(row.textContent).toContain("const x = 1;");
  expect(row.querySelector("pre")).toBeNull();
  sessionState.session = { ...session, liveTurn: appendRuntimeLiveTurnDelta(sessionState.session.liveTurn, "markdown", "\n```\n\n| Name | Value |", AT(2)) };
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(row);
  expect(row.querySelector("pre")).not.toBeNull();
  expect(row.querySelector("table")).toBeNull();
  const complete = `${partial}\n\`\`\`\n\n| Name | Value |\n| --- | --- |\n| x | 1 |`;
  const record = { type: "assistant", uuid: "markdown-answer", timestamp: AT(3), message: { content: [{ type: "text", text: complete }] } };
  sessionState.session = { ...session, liveTurn: projectRuntimeLiveTurnItem(sessionState.session.liveTurn, "markdown", record, "completed", AT(3)) };
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(row);
  expect(row.querySelector("table")).not.toBeNull();
  tailState.lines = [JSON.stringify(record)];
  paint();
  expect(host.querySelector('[data-feed-source-id="markdown-answer"]')).toBe(row);
});

test("an event-first Codex echo shows one reply through reconnect and its identified mirror", () => {
  file.engine = "codex"; file.fmt = "codex";
  try {
    sessionState.session = { ...session, liveTurn: { turnId: "event-first", text: "Event-first reply", items: [{
      itemId: "event-first-reply", text: "Event-first reply", phase: "awaiting-echo", startedAt: AT(0), completedAt: AT(1),
    }] } };
    const { host, paint } = render();
    const original = host.querySelector("[data-live-turn]")!;
    const event = JSON.stringify({ type: "event_msg", timestamp: AT(1),
      payload: { type: "agent_message", message: "Event-first reply" } });
    const copies = () => [...host.querySelectorAll('[data-live-turn], [data-feed-kind="prose"]')]
      .filter(node => node.textContent?.includes("Event-first reply"));
    tailState.lines = [event];
    paint();
    expect(copies()).toHaveLength(1);
    expect(copies()[0] === original).toBe(true);
    sessionState.session = { ...session, turn: "unknown", liveTurn: null };
    paint();
    expect(copies()).toHaveLength(1);
    expect(copies()[0] === original).toBe(true);
    tailState.lines = [event, JSON.stringify({ type: "response_item", timestamp: "2026-08-23T08:30:01.007Z", payload: {
      type: "message", id: "event-first-reply", role: "assistant", content: [{ type: "output_text", text: "Event-first reply" }],
    } })];
    paint();
    expect(copies()).toHaveLength(1);
    expect(host.querySelector('[data-feed-source-id="event-first-reply"]') === original).toBe(true);
  } finally { file.engine = "claude"; file.fmt = "claude"; }
});

test("a coalesced Codex echo keeps the adopted row when its timestamp updates", () => {
  file.engine = "codex"; file.fmt = "codex";
  try {
    sessionState.session = { ...session, liveTurn: { turnId: "mirror", text: "Mirror reply", items: [{
      itemId: "mirror-reply", text: "Mirror reply", phase: "awaiting-echo", startedAt: AT(0), completedAt: AT(1),
    }] } };
    const { host, paint } = render();
    const original = host.querySelector("[data-live-turn]")!;
    const response = JSON.stringify({ type: "response_item", timestamp: AT(1), payload: {
      type: "message", id: "mirror-reply", role: "assistant", content: [{ type: "output_text", text: "Mirror reply" }],
    } });
    tailState.lines = [response];
    paint();
    expect(host.querySelector('[data-feed-source-id="mirror-reply"]') === original).toBe(true);
    sessionState.session = { ...sessionState.session, liveTurn: null };
    tailState.lines = [response, JSON.stringify({ type: "event_msg", timestamp: "2026-08-23T08:30:01.500Z",
      payload: { type: "agent_message", message: "Mirror reply" } })];
    paint();
    expect(host.querySelectorAll('[data-feed-source-id="mirror-reply"]')).toHaveLength(1);
    expect(host.querySelector('[data-feed-source-id="mirror-reply"]') === original).toBe(true);
    expect(original.isConnected).toBe(true);
  } finally { file.engine = "claude"; file.fmt = "claude"; }
});

test.each([1, 2, 3])("a completed reply keeps its node before a deputy started at second %s", (deputySecond) => {
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(0), message: { content: "Original request" } })];
  sessionState.session = { ...session, liveTurn: { turnId: "before-deputy", text: "Earlier reply", items: [{
    itemId: "earlier-reply", text: "Earlier reply", phase: "awaiting-echo", startedAt: AT(1), completedAt: AT(2),
  }] } };
  const { host, paint } = render([{ askId: "deputy", startedAt: AT(deputySecond), state: "ended" } as SeatDeputyView]);
  const row = host.querySelector("[data-live-turn]")!;
  const deputy = host.querySelector("[data-deputy-block]")!;
  const precedesDeputy = () => Boolean(row.compareDocumentPosition(deputy) & dom.Node.DOCUMENT_POSITION_FOLLOWING);
  expect(precedesDeputy()).toBe(true);
  expect(row.querySelector('[data-seat-speaker="resumes"]')).toBeNull();
  sessionState.session = { ...session, turn: "unknown", liveTurn: null };
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(row);
  expect(precedesDeputy()).toBe(true);
  tailState.lines = [...tailState.lines, JSON.stringify({ type: "assistant", uuid: "earlier-reply", timestamp: AT(2),
    message: { content: [{ type: "text", text: "Earlier reply" }] } })];
  paint();
  expect(host.querySelector('[data-feed-source-id="earlier-reply"]')).toBe(row);
  expect(precedesDeputy()).toBe(true);
  expect(row.querySelector('[data-seat-speaker="resumes"]')).toBeNull();
});

test.each([false, true])("pending replies retain the seat continuation after a deputy (phone=%s)", (mobile) => {
  phone = mobile;
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(0), message: { content: "Original request" } })];
  sessionState.session = { ...session, liveTurn: appendRuntimeLiveTurnDelta(null, "after-deputy", "Seat resumes", AT(2)) };
  const { host, paint } = render([{ askId: "deputy", startedAt: AT(1), state: "ended" } as SeatDeputyView]);
  const row = host.querySelector("[data-live-turn]")!;
  expect(row.querySelector('[data-seat-speaker="resumes"]')?.textContent).toContain("Original request");
  const record = { type: "assistant", uuid: "seat-reply", timestamp: AT(3), message: { content: [{ type: "text", text: "Seat resumes" }] } };
  sessionState.session = { ...session, liveTurn: projectRuntimeLiveTurnItem(sessionState.session.liveTurn, "after-deputy", record, "completed", AT(3)) };
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(row);
  expect(row.querySelector('[data-seat-speaker="resumes"]')?.textContent).toContain("Original request");
  tailState.lines = [...tailState.lines, JSON.stringify(record)];
  paint();
  expect(host.querySelector('[data-feed-source-id="seat-reply"]')).toBe(row);
  expect(row.querySelectorAll('[data-seat-speaker="resumes"]')).toHaveLength(1);
});

test("a pending seat reply keeps the live speaker lead while a deputy is active", () => {
  tailState.lines = [0, 2].map(second => JSON.stringify({ type: "user", timestamp: AT(second), message: { content: `Request ${second}` } }));
  sessionState.session = { ...session, liveTurn: appendRuntimeLiveTurnDelta(null, "active-deputy", "Seat reply", AT(3)) };
  const { host } = render([{ askId: "deputy", startedAt: AT(1), state: "active" } as SeatDeputyView]);
  expect(host.querySelector('[data-live-turn] [data-seat-speaker="live"]')).not.toBeNull();
});

test("runtime text omission does not duplicate an answer already retained by this pane", () => {
  const firstText = "First answer. " + "readable context ".repeat(4000);
  const secondText = "Second answer. " + "more context ".repeat(6000);
  const first = projectRuntimeLiveTurnItem(null, "large-turn", { type: "agentMessage", id: "first-large", text: firstText }, "completed", AT(0));
  sessionState.session = { ...session, liveTurn: first };
  const { host, paint } = render();
  const original = host.querySelector("[data-live-turn]");
  sessionState.session = { ...session, liveTurn: projectRuntimeLiveTurnItem(first, "large-turn",
    { type: "agentMessage", id: "second-large", text: secondText }, "completed", AT(1)) };
  paint();
  expect(host.querySelector('[data-live-turn-item-id="first-large"]')).toBe(original);
  expect(host.querySelectorAll("[data-live-turn]")).toHaveLength(2);
  expect(host.textContent).not.toContain("earlier step");
});

test("a missed completion adopts a citation-bearing streamed answer", () => {
  file.engine = "codex"; file.fmt = "codex";
  try {
    const answer = "Citation answer\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[contract]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>";
    sessionState.session = { ...session, liveTurn: appendRuntimeLiveTurnDelta(null, "citation-turn", answer, AT(0)) };
    const { host, paint } = render();
    const original = host.querySelector("[data-live-turn]");
    sessionState.session = { ...session, turn: "unknown", liveTurn: null };
    tailState.lines = [JSON.stringify({type:"response_item",timestamp:AT(1),payload:{type:"message",id:"citation-answer",role:"assistant",content:[{type:"output_text",text:answer}]}})];
    paint();
    const copies = [...host.querySelectorAll('[data-live-turn], [data-feed-kind="prose"]')].filter(node => node.textContent?.includes("Citation answer"));
    expect(copies).toHaveLength(1);
    expect(host.querySelector('[data-feed-source-id="citation-answer"]')).toBe(original);
  } finally { file.engine="claude"; file.fmt="claude"; }
});

test("event-first citation-bearing completion shows one reply", () => {
  file.engine = "codex"; file.fmt = "codex";
  try {
    const answer = "Event citation answer\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[contract]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>";
    sessionState.session = { ...session, liveTurn: {turnId:"event-citation-turn",text:answer,items:[{itemId:"event-citation-answer",text:answer,phase:"awaiting-echo",startedAt:AT(0),completedAt:AT(1)}]} };
    const { host, paint } = render();
    const original = host.querySelector("[data-live-turn]");
    tailState.lines = [JSON.stringify({type:"event_msg",timestamp:AT(1),payload:{type:"agent_message",message:answer}})];
    paint();
    const copies = [...host.querySelectorAll('[data-live-turn], [data-feed-kind="prose"]')].filter(node => node.textContent?.includes("Event citation answer"));
    expect(copies).toHaveLength(1);
    expect(host.querySelector('[data-feed-kind="mem-citation"]')).toBeNull();
    tailState.lines = [...tailState.lines, JSON.stringify({ type: "response_item", timestamp: AT(1), payload: { type: "message",
      id: "event-citation-answer", role: "assistant", content: [{ type: "output_text", text: answer }] } })];
    paint();
    expect(host.querySelector('[data-feed-kind="prose"]')).toBe(original);
    expect(host.querySelectorAll('[data-feed-kind="prose"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-feed-kind="mem-citation"]')).toHaveLength(1);
  } finally { file.engine="claude"; file.fmt="claude"; }
});


test("completion after a non-overlapping reconnect retains the already read opening and names the unseen gap", () => {
  const turnId = "gap-turn";
  const opening = "Already read opening.";
  let live = appendRuntimeLiveTurnDelta(null, turnId, opening, AT(0))!;
  sessionState.session = { ...session, liveTurn: live };
  const { host, paint } = render();
  const original = host.querySelector("[data-live-turn]")!;
  let full = opening;
  for (let index = 0; index < 9; index++) {
    const text = `${index}:` + "b".repeat(8190);
    full += text;
    const event = projectEngineHostEvent(CONVERSATION_ID, "codex:gap-thread", { kind: "delta", turnId, text, seq: index + 1 })!;
    live = appendRuntimeLiveTurnDelta(live, turnId, event.payload.text as string, AT(0))!;
  }
  sessionState.session = { ...session, turn: "unknown", liveTurn: live };
  paint();
  const completed = projectEngineHostEvent(CONVERSATION_ID, "codex:gap-thread", { kind: "item", turnId,
    item: { type: "agentMessage", id: "gap-answer", text: full }, phase: "completed", seq: 11 })!;
  expect(completed.payload.item).toMatchObject({ truncated: true, id: "gap-answer" });
  live = projectRuntimeLiveTurnItem(live, turnId, completed.payload.item, "completed", AT(1))!;
  sessionState.session = { ...session, turn: "idle", liveTurn: live };
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(original);
  expect(original.textContent).toContain(opening);
  expect(original.textContent).toContain("8:");
  expect(original.querySelector("[data-live-turn-omitted-chars]")?.textContent).toContain("8192");
  tailState.lines = [JSON.stringify({ type: "assistant", uuid: "gap-answer", timestamp: AT(1), message: { content: [{ type: "text", text: full }] } })];
  paint();
  expect(host.querySelector('[data-feed-source-id="gap-answer"]')).toBe(original);
  flushSync(() => original.querySelector<HTMLButtonElement>("button")!.click());
  expect(original.textContent).toContain(full);
  expect(original.querySelector("[data-live-turn-omitted-chars]")).toBeNull();
});


test("an observed reply survives later tool calls and reconnect until its own echo", () => {
  const turnId = "retained-before-tools";
  const record = { type: "assistant", uuid: "observed-before-tools", timestamp: AT(0),
    message: { content: [{ type: "text", text: "Already read reply" }] } };
  let live = projectRuntimeLiveTurnItem(null, turnId, record, "completed", AT(0));
  sessionState.session = { ...session, liveTurn: live };
  const { host, paint } = render();
  const original = host.querySelector('[data-live-turn-item-id="observed-before-tools"]')!;
  for (let index = 0; index < 9; index++) {
    live = projectRuntimeLiveTurnItem(live, turnId, { type: "assistant", uuid: `later-envelope-${index}`,
      message: { content: [{ type: "tool_use", id: `later-call-${index}`, name: "Bash", input: { command: "pwd" } }] } }, "completed", AT(index + 1));
    sessionState.session = { ...session, liveTurn: live };
    paint();
    expect(original.isConnected).toBe(true);
    expect(original.textContent).toContain("Already read reply");
  }
  expect(host.querySelectorAll("[data-live-tool]")).toHaveLength(8);
  expect(host.querySelector("[data-live-turn-earlier]")?.getAttribute("data-live-turn-earlier")).toBe("1");
  sessionState.session = { ...session, liveTurn: null };
  paint();
  expect(original.isConnected).toBe(true);
  tailState.lines = [JSON.stringify(record)];
  paint();
  expect(host.querySelector('[data-feed-source-id="observed-before-tools"]')).toBe(original);
  expect(host.querySelectorAll('[data-feed-source-id="observed-before-tools"]')).toHaveLength(1);
});


test("an event-first review hydrates from redacted capped display text", () => {
  file.engine = "codex"; file.fmt = "codex";
  try {
    const privateValue = "fixture-private-value";
    const text = "VERDICT: APPROVE\n\ncredential line with token=" + privateValue + " and "
      + "Details of the review remain readable. ".repeat(2200);
    const live = projectRuntimeLiveTurnItem(null, "display-review", { type: "agentMessage", id: "display-review-answer", text }, "completed", AT(1))!;
    expect(live.items![0].text).not.toContain(privateValue);
    sessionState.session = { ...session, liveTurn: live };
    const { host, paint } = render();
    const original = host.querySelector("[data-live-turn]");
    expect(host.textContent).not.toContain(privateValue);
    const event = JSON.stringify({ type: "event_msg", timestamp: AT(1), payload: { type: "agent_message", message: text } });
    tailState.lines = [event];
    paint();
    expect(host.querySelector("[data-live-turn]")).toBe(original);
    expect(original?.textContent).not.toContain(privateValue);
    expect(original?.textContent?.length).toBeLessThan(25_000);
    sessionState.session = { ...sessionState.session, liveTurn: null, turn: "unknown" };
    paint();
    expect(host.querySelector("[data-live-turn]")).toBe(original);
    expect(host.textContent).not.toContain(privateValue);
    tailState.lines = [event, JSON.stringify({ type: "response_item", timestamp: AT(1),
      payload: { type: "message", id: "display-review-answer", role: "assistant", content: [{ type: "output_text", text }] } })];
    paint();
    expect(host.querySelector('[data-feed-source-id="display-review-answer"]')).toBe(original);
    expect(host.querySelectorAll('[data-feed-kind="review"]')).toHaveLength(1);
    expect(host.textContent).not.toContain(privateValue);
  } finally { file.engine = "claude"; file.fmt = "claude"; }
});

/* A fresh mount (reload, new tab, another device) is handed every reply the
   host still keeps and watched none of them arrive. */
const oldReplies = (): RuntimeLiveTurn => [1, 2, 3].reduce<RuntimeLiveTurn | null>((live, second) => projectRuntimeLiveTurnItem(live, "old-turn", {
  type: "assistant", uuid: `old-reply-${second}`, message: { role: "assistant", content: [{ type: "text", text: `Old reply ${second}` }] },
}, "completed", AT(second)), null)!;
const feedRows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-feed-kind], [data-live-turn]")]
  .map(row => row.dataset.feedKind ?? `live:${row.dataset.liveTurnItemId ?? ""}`);

test("a fresh mount leaves replies the loaded window has moved past to their transcript records", () => {
  sessionState.session = { ...session, turn: "idle", liveTurn: oldReplies() };
  tailState.lines = [
    JSON.stringify({ type: "user", timestamp: AT(30), message: { content: "Latest request" } }),
    JSON.stringify({ type: "assistant", uuid: "latest-answer", timestamp: AT(31), message: { content: [{ type: "text", text: "Latest answer" }] } }),
  ];
  const { host, paint } = render();
  expect(feedRows(host)).toEqual(["user", "prose"]);
  expect(host.textContent).not.toContain("Old reply");
  // Later projections of the same snapshot keep them out as well.
  sessionState.session = { ...sessionState.session, revision: 10 };
  tailState.lines = [...tailState.lines, JSON.stringify({ type: "user", timestamp: AT(40), message: { content: "One more" } })];
  paint();
  expect(feedRows(host)).toEqual(["user", "prose", "user"]);
});

test("a fresh mount does not wedge an unrecorded old reply between loaded transcript rows", () => {
  sessionState.session = { ...session, turn: "idle", liveTurn: projectRuntimeLiveTurnItem(null, "old-turn", {
    type: "assistant", uuid: "never-recorded", message: { role: "assistant", content: [{ type: "text", text: "Unrecorded reply" }] },
  }, "completed", AT(2)) };
  tailState.lines = [[0, "user", "Request one"], [5, "assistant", "Answer one"], [8, "user", "Request two"], [9, "assistant", "Answer two"]]
    .map(([second, type, text]) => JSON.stringify({ type, uuid: `record-${second}`, timestamp: AT(second as number),
      message: { content: type === "user" ? text : [{ type: "text", text }] } }));
  const { host } = render();
  expect(feedRows(host)).toEqual(["user", "prose", "user", "prose"]);
  expect(host.textContent).not.toContain("Unrecorded reply");
});

test("a fresh mount judges snapshot replies only once its window has loaded", () => {
  sessionState.session = { ...session, turn: "idle", liveTurn: oldReplies() };
  tailState.loading = true;
  const stale = render();
  expect(feedRows(stale.host)).toEqual([]);
  tailState.loading = false;
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(30), message: { content: "Latest request" } })];
  stale.paint();
  expect(feedRows(stale.host)).toEqual(["user"]);

  // A failed first read settles `loading` and the lines land on the retry: bytes with no line yet are still unread.
  tailState.lines = [];
  tailState.size = 2048;
  tailState.error = "server unavailable";
  const settling = render();
  expect(feedRows(settling.host)).toEqual([]);
  tailState.size = null;
  tailState.error = null;
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(30), message: { content: "Latest request" } })];
  settling.paint();
  expect(feedRows(settling.host)).toEqual(["user"]);

  // The same snapshot over a window that has not reached those replies keeps every one.
  tailState.loading = true;
  tailState.lines = [];
  const current = render();
  tailState.loading = false;
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(0), message: { content: "The request" } })];
  current.paint();
  expect(feedRows(current.host)).toEqual(["user", "live:old-reply-1", "live:old-reply-2", "live:old-reply-3"]);
});

test("a reply that arrives after the mount stays until its echo although the window moves past it", () => {
  sessionState.session = { ...session, liveTurn: oldReplies() };
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(30), message: { content: "Latest request" } })];
  const { host, paint } = render();
  expect(feedRows(host)).toEqual(["user"]);
  sessionState.session = { ...session, liveTurn: projectRuntimeLiveTurnItem(oldReplies(), "old-turn", {
    type: "assistant", uuid: "watched-reply", message: { role: "assistant", content: [{ type: "text", text: "Watched reply" }] },
  }, "completed", AT(31)) };
  paint();
  tailState.lines = [...tailState.lines, JSON.stringify({ type: "user", timestamp: AT(35), message: { content: "Follow-up" } })];
  paint();
  expect(feedRows(host)).toEqual(["user", "live:watched-reply", "user"]);
});

test("the seat is named once above an uninterrupted run of its live rows", () => {
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(0), message: { content: "Review the queue" } })];
  let liveTurn = projectRuntimeLiveTurnItem(null, "seat-run", {
    type: "assistant", uuid: "seat-run-reply", message: { role: "assistant", content: [{ type: "text", text: "Looking at three files." }] },
  }, "completed", AT(2));
  for (const second of [3, 4, 5]) liveTurn = projectRuntimeLiveTurnItem(liveTurn, "seat-run", {
    type: "assistant", uuid: `seat-run-read-${second}`,
    message: { role: "assistant", content: [{ type: "tool_use", id: `seat-run-tool-${second}`, name: "Read", input: { file_path: `/repo/file-${second}.ts` } }] },
  }, "completed", AT(second));
  sessionState.session = { ...session, liveTurn };
  const { host } = render([{ askId: "deputy", startedAt: AT(1), state: "active" } as SeatDeputyView]);
  expect(liveRows(host)).toEqual(["prose:seat-run-reply", "tool:seat-run-tool-3:run", "tool:seat-run-tool-4:run", "tool:seat-run-tool-5:run"]);
  expect([...host.querySelectorAll<HTMLElement>("[data-seat-speaker]")].map(line => line.dataset.seatSpeaker)).toEqual(["resumes"]);
});

test("a run of live tool rows alone carries one seat line, above its first row", () => {
  tailState.lines = [JSON.stringify({ type: "user", timestamp: AT(2), message: { content: "Review the queue" } })];
  let liveTurn: RuntimeLiveTurn | null = null;
  for (let index = 0; index < 12; index += 1) liveTurn = projectRuntimeLiveTurnItem(liveTurn, "tool-run", {
    type: "assistant", uuid: `tool-run-${index}`,
    message: { role: "assistant", content: [{ type: "tool_use", id: `tool-run-call-${index}`, name: "Read", input: { file_path: `/repo/file-${index}.ts` } }] },
  }, "completed", AT(3 + index));
  sessionState.session = { ...session, liveTurn };
  const { host } = render([{ askId: "deputy", startedAt: AT(1), state: "active" } as SeatDeputyView]);
  expect(host.querySelectorAll("[data-live-turn]")).toHaveLength(8);
  expect(host.querySelector("[data-live-turn-earlier]")?.getAttribute("data-live-turn-earlier")).toBe("4");
  const lines = [...host.querySelectorAll<HTMLElement>("[data-seat-speaker]")];
  expect(lines.map(line => line.dataset.seatSpeaker)).toEqual(["live"]);
  const first = host.querySelector("[data-live-turn-earlier]")!;
  expect(lines[0]!.compareDocumentPosition(first) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a reply painted in flight keeps its node when it completes before the window's first line", () => {
  const pending = { itemId: null, text: "Written while the window loads.", phase: "streaming" as const, startedAt: AT(3), completedAt: null };
  sessionState.session = { ...session, liveTurn: { turnId: "unread-window", text: pending.text, items: [pending] } };
  tailState.size = 2048;
  tailState.error = "server unavailable";
  const { host, paint } = render();
  const row = host.querySelector("[data-live-turn]")!;
  expect(row.textContent).toContain(pending.text);
  sessionState.session = { ...session, liveTurn: { turnId: "unread-window", text: pending.text,
    items: [{ ...pending, itemId: "unread-window-answer", phase: "awaiting-echo", completedAt: AT(4) }] } };
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(row);
  tailState.size = null;
  tailState.error = null;
  tailState.lines = [0, 9].map(second => JSON.stringify({ type: "user", timestamp: AT(second), message: { content: `Request ${second}` } }));
  paint();
  expect(host.querySelector("[data-live-turn]")).toBe(row);
  expect(feedRows(host)).toEqual(["user", "live:unread-window-answer", "user"]);
});

const LONG_AT = (second: number) => new Date(Date.parse(AT(0)) + second * 1000).toISOString();
const codexLine = (second: number, payload: Record<string, unknown>) => JSON.stringify({ type: "response_item", timestamp: LONG_AT(second), payload });

/* Codex records carry reasoning ids beside message and call ids, so the capped
   claim set forgets a reply long before the host lets go of its descriptor. */
test.each([["stays loaded", false], ["leaves the loaded window", true]] as const)(
  "a watched reply is one row through 600 later steps of a Codex conversation while its record %s", (_name, trims) => {
    file.engine = "codex"; file.fmt = "codex";
    try {
      const reply = "Reply the pane watched arrive.";
      let live = projectRuntimeLiveTurnItem(null, "long-turn", { type: "agentMessage", id: "long-reply", text: reply }, "completed", LONG_AT(1))!;
      tailState.lines = [JSON.stringify({ type: "response_item", timestamp: LONG_AT(0), payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Start the long run" }] } })];
      sessionState.session = { ...session, liveTurn: live };
      const { host, paint } = render();
      expect(liveRows(host)).toEqual(["prose:long-reply"]);
      tailState.lines = [...tailState.lines, codexLine(1, { type: "message", id: "long-reply", role: "assistant", content: [{ type: "output_text", text: reply }] })];
      paint();
      const copies = () => [...host.querySelectorAll<HTMLElement>('[data-live-turn], [data-feed-kind="prose"]')].filter(node => node.textContent?.includes(reply));
      expect(copies()).toHaveLength(1);
      for (let step = 1; step <= 600; step += 1) {
        const second = 1 + step;
        live = projectRuntimeLiveTurnItem(live, "long-turn", { type: "commandExecution", id: `long-call-${step}`, command: "pwd", status: "completed" }, "completed", LONG_AT(second))!;
        sessionState.session = { ...session, liveTurn: live, revision: 9 + step };
        tailState.lines = [...tailState.lines,
          codexLine(second, { type: "reasoning", id: `long-reasoning-${step}`, summary: [{ type: "summary_text", text: `Thought ${step}` }] }),
          codexLine(second, { type: "function_call", name: "exec_command", call_id: `long-call-${step}`, arguments: JSON.stringify({ cmd: "pwd" }) }),
          codexLine(second, { type: "function_call_output", call_id: `long-call-${step}`, output: "/repo" })];
        if (trims && step === 100) {
          // The cap trims the front: the reply's record is no longer loaded.
          tailState.linesStart += 50;
          tailState.lines = tailState.lines.slice(50);
        }
        paint();
        const live_ = [...host.querySelectorAll<HTMLElement>("[data-live-turn]")].filter(node => node.textContent?.includes(reply));
        if (live_.length || copies().length > 1) throw new Error(`step ${step}: ${live_.length} live reply rows, ${copies().length} copies`);
      }
      const hostKeeps = (live.items ?? []).some(item => item.itemId === "long-reply");
      expect(hostKeeps).toBe(false);
    } finally { file.engine = "claude"; file.fmt = "claude"; }
  }, 240_000);

test("a bound reply keeps its transcript place before the reasoning that follows it", () => {
  file.engine = "codex"; file.fmt = "codex";
  try {
    const reply = "Reply before the next thought.";
    tailState.lines = [JSON.stringify({ type: "response_item", timestamp: LONG_AT(0), payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: "Do the thing" }] } })];
    sessionState.session = { ...session, liveTurn: projectRuntimeLiveTurnItem(null, "order-turn", { type: "agentMessage", id: "order-reply", text: reply }, "completed", LONG_AT(1)) };
    const order = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-feed-kind], [data-live-turn]")]
      .map(row => row.textContent?.includes(reply) ? "reply" : row.dataset.feedKind ?? "live");
    const watched = render();
    const node = watched.host.querySelector("[data-live-turn]")!;
    expect(order(watched.host)).toEqual(["user", "reply"]);
    tailState.lines = [...tailState.lines,
      codexLine(1, { type: "message", id: "order-reply", role: "assistant", content: [{ type: "output_text", text: reply }] }),
      codexLine(2, { type: "reasoning", id: "order-reasoning", summary: [{ type: "summary_text", text: "Considering the next step" }] }),
      codexLine(3, { type: "function_call", name: "exec_command", call_id: "order-call", arguments: JSON.stringify({ cmd: "pwd" }) })];
    watched.paint();
    expect(watched.host.querySelector('[data-feed-source-id="order-reply"]')).toBe(node);
    const fresh = render();
    expect(order(fresh.host).slice(0, 2)).toEqual(["user", "reply"]);
    expect(order(fresh.host).length).toBeGreaterThan(3);
    expect(order(watched.host)).toEqual(order(fresh.host));
  } finally { file.engine = "claude"; file.fmt = "claude"; }
});
