import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { SeatDeputyView } from "@/lib/orchestrator/deputyView";
import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";
import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * The deputy's block in the seat's own feed (docs/design/ghost-seat.md §6):
 * one keyed list, the block pinned at its head by `startedAt`, its live rows
 * from its own runtime session, its canonical rows from its own records, the
 * seat's live turn still the last section, and the collapse to one line.
 */

const dom = new HappyWindow({ width: 1440, height: 900, url: "http://localhost/" });
const { MOBILE_LAYOUT_QUERY } = await import("@/lib/attention/eligibility");
/* The phone's layout query answers true while a test sets this. */
let phoneLayout = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: phoneLayout && query === MOBILE_LAYOUT_QUERY,
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
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  FocusEvent: dom.FocusEvent,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  IntersectionObserver: undefined,
});

const SESSION = "0a1b2c3d-4e5f-\x34a6b-8c7d-9e0f1a2b3c4d";
const at = (minute: number, second = 0) => `2026-09-26T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const user = (uuid: string, minute: number, text: string) => JSON.stringify({ type: "user", uuid, timestamp: at(minute), sessionId: SESSION, message: { role: "user", content: text } });
const assistant = (uuid: string, minute: number, content: unknown[], second = 0) => JSON.stringify({ type: "assistant", uuid, timestamp: at(minute, second), sessionId: SESSION, message: { id: `msg_${uuid}`, role: "assistant", content } });

/* The seat's transcript: an operator message, the seat's answer, then a later
   seat row written while the deputy ran. */
const seatLines = [
  user("u1", 30, "Review the queue"),
  assistant("a1", 35, [{ type: "text", text: "Looking at the queue now." }]),
  assistant("a2", 41, [{ type: "text", text: "Seat row written after the ask." }]),
];

/* The deputy's own records, as the route serves them past the fork prefix. */
const deputyLines = [
  user("g0", 39, "Add a task: reviewer for #2244\n\n---\n[Delegatus: you are the orchestrator's parallel self] …"),
  assistant("g1", 39, [{ type: "tool_use", id: "call_1", name: "mcp__viewer__create_task", input: { text: "Reviewer for #2244", project: "proj" } }], 20),
  JSON.stringify({ type: "user", uuid: "g2", timestamp: at(39, 22), sessionId: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: JSON.stringify({ taskId: "task_318" }) }] }] } }),
  assistant("g3", 39, [{ type: "text", text: "Created the task and linked it to lane #2244." }], 40),
];

const liveSessions = new Map<string, { liveTurn: { turnId: string; text: string; items: RuntimeLiveTurnItem[] } | null; turn: "running" | "idle" }>();

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: (conversationId: string | null) => {
    const live = conversationId ? liveSessions.get(conversationId) : undefined;
    return live ? { session: { conversationId, host: "hosted", turn: live.turn, liveTurn: live.liveTurn, capabilities: {} } } : null;
  },
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useToolActivityCues", () => ({
  ...actualToolCues,
  useToolActivityCues: () => undefined,
}));

const { LogFeed } = await import("../LogFeed");
const { setLogFeedDependenciesForTests } = await import("../logFeedDependencies");
const { setDeputyRecordsFetchForTests } = await import("./DeputyBlock");
const { resetCanonicalAssistantClaimsForTests } = await import("./liveTurnHandoff");

const roots = new Set<Root>();
let recordReads = 0;

beforeEach(() => {
  setLocale("en");
  phoneLayout = false;
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  liveSessions.clear();
  resetCanonicalAssistantClaimsForTests();
  recordReads = 0;
  setLogFeedDependenciesForTests({
    useLogTail: () => ({
      lines: seatLines,
      linesStart: 0,
      size: 1,
      loading: false,
      error: null,
      tickTime: null,
      paused: false,
      setPaused: () => undefined,
      clear: () => undefined,
      hasMore: false,
      loadingOlder: false,
      loadOlder: async () => 0,
      prependGen: 0,
    }),
  });
  setDeputyRecordsFetchForTests(async () => {
    recordReads += 1;
    return { lines: deputyLines, missing: false };
  });
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  setLogFeedDependenciesForTests(null);
  setDeputyRecordsFetchForTests(null);
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

const seatFile = {
  path: `/fixture/projects/-repo/${SESSION}.jsonl`,
  root: "claude-projects",
  name: `${SESSION}.jsonl`,
  project: "proj",
  title: "Orchestrator",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: Date.parse(at(41)),
  size: 1,
  activity: "live",
  proc: "running",
  pid: 7,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: "conversation_seat",
} as FileEntry;

function deputy(overrides: Partial<SeatDeputyView> = {}): SeatDeputyView {
  return {
    askId: "deputy_1",
    seatConversationId: "conversation_seat",
    deputyConversationId: "conversation_ghost",
    ask: { text: "Add a task: reviewer for #2244", images: 0, sender: null },
    artifactPath: "/fixture/projects/-repo/ghost.jsonl",
    forkRecordCount: 3,
    forkBytes: 1024,
    state: "active",
    startedAt: at(39),
    activatedAt: at(39, 2),
    endedAt: null,
    outcome: null,
    touched: { taskIds: [], pipelineIds: [], conversationIds: [] },
    result: null,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(deputies?: readonly SeatDeputyView[]): { host: HTMLElement; rerender: (next?: readonly SeatDeputyView[]) => void } {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(host as never);
  const root = createRoot(host);
  roots.add(root);
  const draw = (next?: readonly SeatDeputyView[]) => flushSync(() => {
    root.render(
      <LogFeed file={seatFile} showSvc={false} lineFilter="" onStatus={() => undefined} paused follow={false} setFollow={() => undefined} compact deputies={next} />,
    );
  });
  draw(deputies);
  return { host, rerender: draw };
}

/** Every keyed row of the window, in order, with which block it belongs to. */
function order(host: HTMLElement): string[] {
  const content = host.querySelector("[data-feed-state]")!;
  return [...content.children].flatMap((child) => {
    const element = child as HTMLElement;
    if (element.dataset.deputyBlock) return [`block:${element.dataset.deputyBlock}`];
    if (element.hasAttribute("data-live-turn-group")) return ["seat-live"];
    const text = element.textContent ?? "";
    /* A resumed row quotes the head it continues, so its own words decide. */
    if (text.includes("Seat row written after")) return ["seat:a2"];
    if (text.includes("Looking at the queue")) return ["seat:a1"];
    if (text.includes("Review the queue")) return ["seat:u1"];
    return [];
  });
}

test("a live deputy's block sits at its head, streams its own rows, and the seat's live turn stays last", async () => {
  liveSessions.set("conversation_seat", { turn: "running", liveTurn: { turnId: "seat-turn", text: "", items: [
    { itemId: null, text: "The seat is still answering the queue", phase: "streaming", startedAt: at(42), completedAt: null },
  ] } });
  liveSessions.set("conversation_ghost", { turn: "running", liveTurn: { turnId: "ghost-turn", text: "", items: [
    /* Claimed by the canonical record of the same words: never drawn twice. */
    { itemId: null, text: "Created the task and linked it to lane #2244.", phase: "awaiting-echo", startedAt: at(39, 30), completedAt: at(39, 40) },
    { itemId: "tool-live", text: "", phase: "awaiting-echo", startedAt: at(39, 50), completedAt: null, tool: { name: "mcp__viewer__list_pipelines", engine: "claude", status: "run", args: {} } },
  ] } });
  const { host } = mount([deputy()]);
  await settle();

  expect(order(host)).toEqual(["seat:u1", "seat:a1", "block:deputy_1", "seat:a2", "seat-live"]);
  const block = host.querySelector<HTMLElement>('[data-deputy-block="deputy_1"]')!;
  expect(block.dataset.deputyState).toBe("active");
  expect(block.querySelector("[data-deputy-head]")?.textContent).toContain("Add a task: reviewer for #2244");
  expect(block.querySelector("[data-deputy-caption]")?.textContent).toContain("Orchestrator · parallel self");
  expect(block.querySelector("[data-deputy-status]")?.textContent).toContain("working");
  expect(block.querySelector("[data-deputy-edge]")).not.toBeNull();
  /* Every row of the block is keyed under the deputy, for the viewport anchor. */
  const keys = [...block.querySelectorAll<HTMLElement>("[data-feed-key]")].map((row) => row.dataset.feedKey!);
  expect(keys.length).toBeGreaterThan(1);
  expect(keys.every((key) => key.startsWith("deputy:deputy_1:"))).toBe(true);
  /* The delivered ask is the head, never a second bubble; the note under it never shows. */
  expect((block.textContent ?? "").split("Add a task: reviewer for #2244").length - 1).toBe(1);
  expect(block.textContent).not.toContain("parallel self] …");
  /* Its canonical answer, its live tool row, and no duplicate of the claimed live prose. */
  expect(block.textContent).toContain("Created the task and linked it to lane #2244.");
  expect(block.textContent?.split("Created the task and linked it").length).toBe(2);
  expect(block.querySelector('[data-live-tool="mcp__viewer__list_pipelines"]')).not.toBeNull();
  /* The seat's own streaming row is outside the block. */
  expect(block.textContent).not.toContain("The seat is still answering");
  expect(recordReads).toBeGreaterThan(0);
});

test("a finished block collapses to one line with a chip per touched id, and expands back", async () => {
  const { host, rerender } = mount([deputy()]);
  await settle();
  rerender([deputy({ state: "ended", endedAt: at(41), outcome: "done", touched: { taskIds: ["task_318"], pipelineIds: ["pipeline_2244"], conversationIds: [] }, result: { line: "Created the task and linked it to lane #2244.", finalText: "" } })]);
  await settle();
  const block = host.querySelector<HTMLElement>('[data-deputy-block="deputy_1"]')!;
  expect(block.dataset.deputyOpen).toBe("false");
  expect(block.querySelector("[data-deputy-body]")).toBeNull();
  expect(block.querySelector("[data-deputy-result]")?.textContent).toBe("Created the task and linked it to lane #2244.");
  expect(block.querySelectorAll("[data-deputy-chip]").length).toBe(2);
  expect(block.querySelector('[data-deputy-chip="task"] a')?.getAttribute("href")).toBe("#task=task_318");
  /* The head stays: the collapsed line is the trace, kept where the ask was made. */
  expect(block.querySelector("[data-deputy-head]")).not.toBeNull();

  flushSync(() => block.querySelector<HTMLButtonElement>("[data-deputy-toggle]")!.click());
  await settle();
  expect(block.dataset.deputyOpen).toBe("true");
  expect(block.querySelectorAll("[data-deputy-row]").length).toBeGreaterThan(0);
});

test("a block that ends while the pointer is inside waits for it to leave", async () => {
  const { host, rerender } = mount([deputy()]);
  await settle();
  const block = host.querySelector<HTMLElement>('[data-deputy-block="deputy_1"]')!;
  flushSync(() => block.dispatchEvent(new dom.PointerEvent("pointerover", { bubbles: true }) as unknown as Event));
  rerender([deputy({ state: "ended", endedAt: at(41), outcome: "done", result: { line: "Done.", finalText: "Done." } })]);
  await settle();
  expect(block.dataset.deputyOpen).toBe("true");
  flushSync(() => block.dispatchEvent(new dom.PointerEvent("pointerout", { bubbles: true }) as unknown as Event));
  await settle();
  expect(host.querySelector<HTMLElement>('[data-deputy-block="deputy_1"]')!.dataset.deputyOpen).toBe("false");
});

test("a timed-out block draws the warning tone and names the outcome", async () => {
  const { host } = mount([deputy({ state: "ended", endedAt: at(54), outcome: "timeout", result: { line: "Still reading the lane…", finalText: "" } })]);
  await settle();
  const outcome = host.querySelector<HTMLElement>('[data-deputy-outcome="timeout"]')!;
  expect(outcome.className).toContain("text-warning");
  expect(outcome.textContent).toContain("ran out of 15 min");
});

test("an expanded block whose transcript is gone says so", async () => {
  setDeputyRecordsFetchForTests(async () => ({ lines: [], missing: true }));
  const { host } = mount([deputy({ state: "ended", endedAt: at(41), outcome: "done", result: { line: "Done.", finalText: "" } })]);
  await settle();
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-deputy-toggle]")!.click());
  await settle();
  expect(host.querySelector("[data-deputy-missing]")?.textContent).toContain("was removed");
});

test("a feed with no deputies renders the same DOM as before", async () => {
  const without = mount(undefined);
  await settle();
  const empty = mount([]);
  await settle();
  expect(empty.host.innerHTML).toBe(without.host.innerHTML);
  expect(without.host.querySelector("[data-deputy-block]")).toBeNull();
});

test("the ask is marked as sent to the parallel self, and the seat row after the block names the head it continues", async () => {
  const { host } = mount([deputy()]);
  await settle();
  const block = host.querySelector<HTMLElement>('[data-deputy-block="deputy_1"]')!;
  const addressee = block.querySelector<HTMLElement>("[data-deputy-head] [data-deputy-addressee]")!;
  expect(addressee.textContent).toBe("→parallel self");
  expect(addressee.querySelector("[data-deputy-mark]")).not.toBeNull();
  /* The seat's own rows before the block carry no caption; the first after it does. */
  const content = host.querySelector("[data-feed-state]")!;
  const children = [...content.children] as HTMLElement[];
  const next = children[children.indexOf(block) + 1]!;
  expect(next.textContent).toContain("Seat row written after the ask.");
  expect(next.querySelector('[data-seat-speaker="resumes"]')?.textContent).toBe("Orchestrator· continuing «Review the queue»");
  expect(content.querySelectorAll("[data-seat-speaker]").length).toBe(1);
});

test("while a parallel self streams, the seat's live turn names its participant and the two carets differ", async () => {
  liveSessions.set("conversation_seat", { turn: "running", liveTurn: { turnId: "seat-turn", text: "", items: [
    { itemId: "seat-live", text: "The seat is still answering the queue", phase: "streaming", startedAt: at(42), completedAt: null },
  ] } });
  liveSessions.set("conversation_ghost", { turn: "running", liveTurn: { turnId: "ghost-turn", text: "", items: [
    { itemId: "ghost-live", text: "Linking the task to the lane", phase: "streaming", startedAt: at(39, 50), completedAt: null },
  ] } });
  const { host } = mount([deputy()]);
  await settle();
  const seatLive = [...host.querySelector("[data-feed-state]")!.children].find((child) => child.hasAttribute("data-live-turn-group"))!;
  expect(seatLive.querySelector('[data-seat-speaker="live"]')?.textContent).toBe("Orchestrator");
  expect(seatLive.querySelector('[data-live-turn-caret="seat"]')?.className).toContain("bg-accent");
  const ghostCaret = host.querySelector('[data-deputy-block] [data-live-turn-caret]')!;
  expect(ghostCaret.getAttribute("data-live-turn-caret")).toBe("deputy");
  expect(ghostCaret.className).toContain("bg-secondary");
  expect(ghostCaret.className).not.toContain("bg-accent");
});

test("on the phone, a prose row inside the block is captioned as the parallel self, never with the bare engine name", async () => {
  phoneLayout = true;
  const { host } = mount([deputy()]);
  await settle();
  const speakers = [...host.querySelectorAll<HTMLElement>("[data-deputy-block] [data-mobile-message-speaker]")].map((speaker) => speaker.textContent);
  expect(speakers.length).toBeGreaterThan(0);
  expect(speakers.every((speaker) => speaker === "Orchestrator · parallel self")).toBe(true);
  /* The seat's own rows keep the engine's name. */
  const seatSpeakers = [...host.querySelectorAll<HTMLElement>("[data-mobile-message-speaker]")].filter((speaker) => !speaker.closest("[data-deputy-block]"));
  expect(seatSpeakers.map((speaker) => speaker.textContent)).toContain("Claude");
});

test("a collapsed line keeps its result whole on the phone and draws its chips in the interface language", async () => {
  setLocale("uk");
  phoneLayout = true;
  const { host } = mount([deputy({ state: "ended", endedAt: at(41), outcome: "done", touched: { taskIds: ["task_318"], pipelineIds: ["pipeline_2244"], conversationIds: ["conversation_x"] }, result: { line: "Створив задачу «Рев'юер для #2244» і прив'язав її до лейна #2244.", finalText: "" } })]);
  await settle();
  const result = host.querySelector<HTMLElement>("[data-deputy-result]")!;
  expect(result.className).toContain("line-clamp-2");
  expect(result.className).not.toContain("truncate");
  const chips = [...host.querySelectorAll<HTMLElement>("[data-deputy-chip]")].map((chip) => chip.textContent);
  expect(chips).toEqual(["Відкрити задачу", "Відкрити пайплайн", "Відкрити розмову"]);
  expect(host.querySelector("[data-deputy-addressee]")?.textContent).toBe("→паралельне я");
});

test("on the desktop the result keeps its own width, so the chips follow its last word", async () => {
  const { host } = mount([deputy({ state: "ended", endedAt: at(41), outcome: "done", touched: { taskIds: ["task_318"], pipelineIds: [], conversationIds: [] }, result: { line: "Created the task.", finalText: "" } })]);
  await settle();
  const result = host.querySelector<HTMLElement>("[data-deputy-result]")!;
  expect(result.className).not.toContain("grow");
  expect(result.className).toContain("truncate");
});

test("an ended-early line is marked as the last step", async () => {
  const { host } = mount([deputy({ state: "ended", endedAt: at(54), outcome: "timeout", result: { line: "Reading the account limits…", finalText: "" } })]);
  await settle();
  expect(host.querySelector("[data-deputy-result]")?.textContent).toBe("last step: Reading the account limits…");
  expect(host.querySelector("[data-deputy-last-step]")?.className).toContain("text-muted");
});
