import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";
import type { SpawnOutcome } from "./draftSpawn";
import { setLocale, translate } from "@/lib/i18n";
import { emptyStore } from "@/components/runtime/runtimeModel";

/**
 * The starting window of a structured launch (#1397 / #1398): a pipeline
 * stage's conversation while its first message is still queued and the launch
 * is reconciling. The window is driven the way the board drives it — the
 * `spawn:<launchId>` placeholder first, the same placeholder once the host has
 * written the first transcript records, then the scanned transcript row that
 * adopts the launch — and two things are asserted at every step:
 *
 *  - the stage's INTERNAL prompt renders exactly once (#1398): the optimistic
 *    launch bubble before the transcript has it, the transcript's own relay
 *    card after, never both and never two cards for the one message the
 *    rollout journals twice;
 *  - "working…" carries a running duration (#1397), anchored on the launch
 *    admission while no transcript turn exists and never running backwards
 *    once the later transcript anchor appears, in the footer indicator and in
 *    the header WORKING badge alike.
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
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  window: dom,
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

let tailLines: string[] = [];

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: () => ({
    lines: tailLines,
    linesStart: 0,
    size: tailLines.length,
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
}));
mock.module("@/hooks/useToolActivityCues", () => ({
  ...actualToolCues,
  useToolActivityCues: () => undefined,
}));

const { LogFeed } = await import("./LogFeed");
const { CardStatusBadge } = await import("./CardStatusBadge");
const { resetOutboxForTests, seedLaunchOutbox } = await import("./conversation/outbox");
const { createSpawnAttempt, provisionalSpawnFile } = await import("./draftSpawn");
const { seatMandateDelivery, seatProvisionalFile } = await import("./orchestrator/useSeatConfirm");
const { resetHeldMandatesForTests } = await import("./conversation/heldMandate");
const { resetMessageProvenanceCacheForTests } = await import("./feed/messageProvenance");
const { messageTextDigest } = await import("@/lib/runtime/messageTextDigest");

/* The launch was admitted at T0; the host journals the first record eight
   seconds later. A timer anchored on that record would read eight seconds
   less than one anchored on the admission — the two anchors are told apart. */
const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const RECORD_AT = T0 + 8_000;
const PROMPT = "You are the Builder.\n\nPinned task: the starting window renders the stage prompt exactly once.";
const INTERNAL = "<!-- llv:structured-user origin=agent sender=builder -->\n" + PROMPT;

/* The agent's first visible reply, six seconds after the prompt landed: the
   scanner's assistant evidence, on which the projection retires the launch
   facts while the turn is still open. */
const ANSWER_AT = RECORD_AT + 6_000;

/* The rollout journals the stage prompt twice: the persisted user item and
   the 0.151 thread lifecycle's item_completed echo of the very same item. */
const transcriptRecords = [
  JSON.stringify({
    timestamp: new Date(RECORD_AT).toISOString(),
    type: "response_item",
    payload: { type: "message", id: "item_user_starting_window", role: "user", content: [{ type: "input_text", text: INTERNAL }] },
  }),
  JSON.stringify({
    timestamp: new Date(RECORD_AT + 176).toISOString(),
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: "thread_starting_window",
      turn_id: "turn_starting_window",
      item: {
        type: "UserMessage",
        id: "item_user_starting_window",
        client_id: "spawn_message_launch_starting_window",
        content: [{ type: "text", text: INTERNAL, text_elements: [] }],
      },
      started_at_ms: RECORD_AT + 176,
      completed_at_ms: RECORD_AT + 176,
    },
  }),
];
const answeredRecords = [
  ...transcriptRecords,
  JSON.stringify({
    timestamp: new Date(ANSWER_AT).toISOString(),
    type: "response_item",
    payload: { type: "message", id: "item_assistant_starting_window", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reading the pipeline spec first." }] },
  }),
];

let now = T0;
const originalDateNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let ticks: Array<() => void> = [];

const roots = new Set<Root>();
beforeEach(() => {
  now = T0;
  Date.now = () => now;
  ticks = [];
  // @ts-expect-error test double: every 1 Hz timer in the window is driven by hand
  globalThis.setInterval = (fn: () => void) => {
    ticks.push(fn);
    return ticks.length;
  };
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
  setLocale("en");
  tailLines = [];
  dom.sessionStorage.clear();
  resetOutboxForTests();
  resetHeldMandatesForTests();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  Date.now = originalDateNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

function launchFacts(conversationId: string, launchId: string, overrides: Partial<StructuredSpawnCardState> = {}): StructuredSpawnCardState {
  return {
    launchId,
    clientAttemptId: null,
    accountId: null,
    conversationId,
    generation: 1,
    state: "reconciling",
    initialMessage: "queued",
    retrySafe: false,
    error: null,
    admittedAt: T0,
    promptAt: T0,
    promptImages: 0, prompt: PROMPT,
    promptEcho: PROMPT,
    ...overrides,
  };
}

/** The board's projection of the launch while no transcript is scanned. */
function placeholder(conversationId: string, launchId: string): FileEntry {
  return {
    path: `spawn:${launchId}`,
    root: "codex-sessions",
    name: `spawn:${launchId}`,
    project: "project",
    title: "Builder",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: T0 / 1000,
    size: 0,
    activity: "live",
    activityReason: "structured_spawn_reconciling",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    conversationId,
    generation: 1,
    spawnOrigin: "viewer",
    spawn: launchFacts(conversationId, launchId),
  } as FileEntry;
}

/** The scanned transcript row the board most often shows first (the agent's
    first reply follows the first record within one poll): the first user
    record opened a turn, the assistant evidence is on the row, and the
    projection has already retired every launch fact from it — no chips, no
    admission instant, only the transcript. */
function answered(conversationId: string, launchId: string): FileEntry {
  const { spawn: _spawn, ...rest } = placeholder(conversationId, launchId);
  return {
    ...rest,
    path: `/sessions/${launchId}.jsonl`,
    name: `${launchId}.jsonl`,
    mtime: ANSWER_AT / 1000,
    size: 3,
    activityReason: "jsonl_turn_open",
    lastTurn: { startedAt: RECORD_AT, endedAt: null },
    lastAssistantMessageAt: ANSWER_AT,
  } as FileEntry;
}

/** The scanned transcript row caught before the agent answered: the first
    user record opened a turn, the delivery receipt settled, the launch still
    rides as chips. */
function adopted(conversationId: string, launchId: string): FileEntry {
  const { spawn: _spawn, ...rest } = placeholder(conversationId, launchId);
  return {
    ...rest,
    path: `/sessions/${launchId}.jsonl`,
    name: `${launchId}.jsonl`,
    mtime: RECORD_AT / 1000,
    size: 2,
    activityReason: "jsonl_turn_open",
    lastTurn: { startedAt: RECORD_AT, endedAt: null },
    lastAssistantMessageAt: null,
    launch: launchFacts(conversationId, launchId, {
      state: "recovered",
      initialMessage: "delivered",
      deliveredAt: RECORD_AT,
      promptImages: undefined, prompt: undefined,
      promptAt: undefined,
    }),
  } as FileEntry;
}

function render(file: FileEntry, root?: Root): { host: HTMLElement; root: Root } {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const mounted = root ?? createRoot(host as unknown as HTMLElement);
  roots.add(mounted);
  flushSync(() => {
    mounted.render(
      <>
        <CardStatusBadge file={file} />
        <LogFeed
          file={file}
          showSvc={false}
          lineFilter=""
          onStatus={() => undefined}
          paused
          follow={false}
          setFollow={() => undefined}
        />
      </>,
    );
  });
  return { host: host as unknown as HTMLElement, root: mounted };
}

function rerender(root: Root, file: FileEntry): void {
  flushSync(() => {
    root.render(
      <>
        <CardStatusBadge file={file} />
        <LogFeed
          file={file}
          showSvc={false}
          lineFilter=""
          onStatus={() => undefined}
          paused
          follow={false}
          setFollow={() => undefined}
        />
      </>,
    );
  });
  /* The 1 Hz timers re-read the clock. */
  flushSync(() => {
    for (const tick of ticks) tick();
  });
}

/** Every rendering of the prompt the window can show: the optimistic launch
    bubble, the transcript's relay card, a transcript user bubble. */
function promptRenderings(host: HTMLElement): number {
  return host.querySelectorAll('[data-outbox-entry], [data-feed-kind="tmsg"], [data-feed-kind="user"]').length;
}

function footerTimer(host: HTMLElement): string | null {
  return host.querySelector('[data-turn-status="running"] [role="timer"]')?.textContent ?? null;
}

function headerBadge(host: HTMLElement): string | null {
  return dom.document.querySelector('[data-card-status="running"]')?.textContent ?? null;
}

test("issue 1398: the stage's INTERNAL prompt renders exactly once before and after its transcript record lands", () => {
  const conversationId = "conversation_prompt_once";
  const launchId = "launch_prompt_once";
  now = T0 + 45_000;

  /* Reconciling, first message queued, nothing journaled yet: the optimistic
     launch bubble is the prompt's one rendering. */
  const { host, root } = render(placeholder(conversationId, launchId));
  expect(host.querySelector("[data-launch-chips]")?.getAttribute("data-launch-state")).toBe("reconciling");
  expect(host.querySelector("[data-launch-chips]")?.getAttribute("data-launch-initial")).toBe("queued");
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(1);
  expect(promptRenderings(host)).toBe(1);

  /* The host journals the prompt (twice, as the rollout does) while the board
     still projects the reconciling placeholder: the durable transcript row
     wins and the optimistic bubble retires: one INTERNAL card. */
  tailLines = transcriptRecords;
  now = T0 + 53_000;
  rerender(root, placeholder(conversationId, launchId));
  const internalCards = host.querySelectorAll('[data-feed-kind="tmsg"]');
  expect(internalCards).toHaveLength(1);
  expect(internalCards[0]?.textContent).toContain("internal");
  expect(internalCards[0]?.textContent).toContain("builder");
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
  expect(promptRenderings(host)).toBe(1);

  /* The scanned transcript adopts the launch: still exactly one. */
  now = T0 + 60_000;
  rerender(root, adopted(conversationId, launchId));
  expect(host.querySelectorAll('[data-feed-kind="tmsg"]')).toHaveLength(1);
  expect(promptRenderings(host)).toBe(1);

  /* The agent answers and the launch facts retire from the row: still one. */
  tailLines = answeredRecords;
  now = T0 + 70_000;
  rerender(root, answered(conversationId, launchId));
  expect(host.querySelectorAll('[data-feed-kind="tmsg"]')).toHaveLength(1);
  expect(promptRenderings(host)).toBe(1);
});

test("issue 1397: working… carries the elapsed time from the launch admission and never runs backwards", () => {
  const conversationId = "conversation_elapsed";
  const launchId = "launch_elapsed";
  now = T0 + 45_000;

  /* Reconciling, first message queued, no transcript turn: the footer says
     working… with a running duration, and so does the header WORKING badge. */
  const { host, root } = render(placeholder(conversationId, launchId));
  const footer = host.querySelector('[data-turn-status="running"]');
  expect(footer?.textContent).toContain("working…");
  expect(footerTimer(host)).toBe("45s");
  expect(headerBadge(host)).toContain("working");
  expect(headerBadge(host)).toContain("45s");

  /* The first transcript record lands eight seconds after the admission, the
     agent answers within the same poll, and the board flips the placeholder
     to the scanned row in ONE render: its open turn starts at the record, it
     carries the assistant evidence, and the projection has already retired
     every launch fact from it. The counter keeps counting from the admission
     — never the record's own 52s. */
  tailLines = answeredRecords;
  now = T0 + 60_000;
  rerender(root, answered(conversationId, launchId));
  expect(host.querySelector("[data-launch-chips]")).toBeNull();
  expect(footerTimer(host)).toBe("1m");
  expect(footerTimer(host)).not.toBe("52s");
  expect(headerBadge(host)).toContain("1m");
  expect(headerBadge(host)).not.toContain("52s");

  /* Ticking on, still from the admission. */
  now = T0 + 61_000;
  rerender(root, answered(conversationId, launchId));
  expect(footerTimer(host)).toBe("1m 1s");
  expect(headerBadge(host)).toContain("1m 1s");
});

test("issue 1397: a poll that still carries the launch chips on the open turn is the same work, and its retirement is no jump either", () => {
  const conversationId = "conversation_elapsed_chips";
  const launchId = "launch_elapsed_chips";
  now = T0 + 45_000;
  const { host, root } = render(placeholder(conversationId, launchId));
  expect(footerTimer(host)).toBe("45s");
  expect(headerBadge(host)).toContain("45s");

  /* The board caught the scanned row before the agent answered: the launch
     still rides it as chips, the open turn starts at the record. */
  tailLines = transcriptRecords;
  now = T0 + 53_000;
  rerender(root, adopted(conversationId, launchId));
  expect(host.querySelector("[data-launch-chips]")).not.toBeNull();
  expect(footerTimer(host)).toBe("53s");
  expect(headerBadge(host)).toContain("53s");

  /* The agent answers and the chips retire, same open turn: still the admission. */
  tailLines = answeredRecords;
  now = T0 + 60_000;
  rerender(root, answered(conversationId, launchId));
  expect(host.querySelector("[data-launch-chips]")).toBeNull();
  expect(footerTimer(host)).toBe("1m");
  expect(headerBadge(host)).toContain("1m");
});

test("a seat's mandate in the launch window is Delegatus's collapsed card, never the operator's bubble", () => {
  const conversationId = "conversation_seat_mandate";
  const launchId = "launch_seat_mandate";
  const base = placeholder(conversationId, launchId);
  const seat = { ...base, spawn: launchFacts(conversationId, launchId, { mandate: { kind: "version", version: 1 } }) } as FileEntry;
  const { host, root } = render(seat);

  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(host.querySelector("[data-mandate-card]")!.textContent).not.toContain("Pinned task");
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
  expect(host.querySelector("[data-launch-chips]")).not.toBeNull();

  /* Adopted with the display fields retired but the tail not yet read: the
     held card is still the one first message. */
  rerender(root, adopted(conversationId, launchId));
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);

  /* The tail's first row, before any delivery evidence names it a mandate: the
     held card stays the one first message and the row is not painted as the
     operator's bubble meanwhile. */
  tailLines = operatorRecords;
  rerender(root, adopted(conversationId, launchId));
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(0);

  /* Evidence that never names a mandate cannot hide the row for good: the
     agent's first prose releases it. */
  tailLines = operatorAnswered;
  rerender(root, answered(conversationId, launchId));
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(0);
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(1);
});

test("an ordinary operator launch keeps its own bubble and shows no mandate card", () => {
  const { host } = render(placeholder("conversation_operator_launch", "launch_operator_launch"));
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(0);
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(1);
});

/* The first message of a new agent or seat (#2006): from the first paint to the
   transcript hand-over it is one normal row. The launch-recovery envelope the
   runtime parks in `receipt.error` during healthy setup is fed to the render
   layer on purpose, so the projection's own gate is not what these prove. */
const ENVELOPE = "structured launch recovery: " + JSON.stringify({
  phase: "uncertain",
  startedAt: 1,
  checks: 2,
  nextTryAt: 2,
  reason: "first-message acknowledgement pending",
});
const OPERATOR_PROMPT = "Fix the failing export test.\n\nThe pinned task is in the card.";
const MANDATE = "You are the orchestrator for this project.\n\nPinned mandate: keep the board moving.";

const operatorRecords = [
  JSON.stringify({
    timestamp: new Date(RECORD_AT).toISOString(),
    type: "response_item",
    payload: { type: "message", id: "item_user_first_message", role: "user", content: [{ type: "input_text", text: OPERATOR_PROMPT }] },
  }),
];
const operatorAnswered = [
  ...operatorRecords,
  JSON.stringify({
    timestamp: new Date(ANSWER_AT).toISOString(),
    type: "response_item",
    payload: { type: "message", id: "item_assistant_first_message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Looking at the export test." }] },
  }),
];

function launchedOutcome(conversationId: string, launchId: string): Extract<SpawnOutcome, { kind: "launched" }> {
  return {
    kind: "launched",
    durable: "confirming",
    target: "",
    path: null,
    conversationId,
    launchId,
    structured: true,
    state: "path-pending",
    initialMessage: "queued",
  };
}

/** Everything the first-message invariant forbids: the envelope's text, any
    JSON object, and any red element. The failed state alone may be red: the
    bubble's failure line and the launch chips that say the launch failed. */
function assertCleanFirstMessage(host: HTMLElement, { failed = false }: { failed?: boolean } = {}): void {
  const text = host.textContent ?? "";
  expect(text).not.toContain("structured launch recovery");
  expect(text).not.toContain('"phase"');
  expect(text).not.toContain('"startedAt"');
  expect(text).not.toContain('{"');
  const red = [...host.querySelectorAll('[class*="danger"]')].filter((element) => (
    !failed || !element.closest("[data-outbox-failure], [data-launch-chip]")
  ));
  expect(red.map((element) => element.outerHTML)).toEqual([]);
}

function firstMessageRows(host: HTMLElement, firstLine: string): Element[] {
  return [...host.querySelectorAll("[data-message-row]")].filter((row) => (row.textContent ?? "").includes(firstLine));
}

const OPERATOR_FIRST_LINE = "Fix the failing export test.";

/** One row carries the prompt and it is the very node seen at the first paint.
    Compared as booleans: a failing `toEqual` on DOM nodes prints the whole tree. */
function expectSameRow(host: HTMLElement, firstNode: Element): void {
  const rows = firstMessageRows(host, OPERATOR_FIRST_LINE);
  expect(rows.length).toBe(1);
  expect(rows[0] === firstNode).toBe(true);
}

test("plain spawn: the first message is the prompt bubble from the first paint to the transcript", () => {
  const conversationId = "conversation_first_plain";
  const launchId = "launch_first_plain";
  const facts = (overrides: Partial<StructuredSpawnCardState> = {}) => launchFacts(conversationId, launchId, {
    ["prompt"]: OPERATOR_PROMPT,
    promptEcho: OPERATOR_PROMPT,
    ...overrides,
  });
  const card = (spawn: StructuredSpawnCardState) => ({ ...placeholder(conversationId, launchId), spawn }) as FileEntry;

  now = T0 + 2_000;
  const { host, root } = render(card(facts({ error: ENVELOPE })));
  assertCleanFirstMessage(host);
  const rows = firstMessageRows(host, OPERATOR_FIRST_LINE);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.getAttribute("data-message-row")).toBe("pending");
  expect(host.querySelector('[data-launch-chip="error"]')).toBeNull();
  const firstNode = rows[0]!;

  now = T0 + 4_000;
  rerender(root, card(facts({ state: "recovered", initialMessage: "delivered", deliveredAt: T0 + 3_000, error: ENVELOPE })));
  assertCleanFirstMessage(host);
  expectSameRow(host, firstNode);

  /* The board publishes the scanned row a poll before the window has read its
     tail: the launch bubble is still the one first message in that gap. */
  tailLines = [];
  now = RECORD_AT + 500;
  const adoptedRow = {
    ...adopted(conversationId, launchId),
    launch: facts({ state: "recovered", initialMessage: "delivered", deliveredAt: RECORD_AT, error: ENVELOPE, promptImages: undefined, prompt: undefined, promptAt: undefined }),
  } as FileEntry;
  rerender(root, adoptedRow);
  assertCleanFirstMessage(host);
  expectSameRow(host, firstNode);

  tailLines = operatorRecords;
  now = RECORD_AT + 1_000;
  rerender(root, adoptedRow);
  assertCleanFirstMessage(host);
  expectSameRow(host, firstNode);

  tailLines = operatorAnswered;
  now = ANSWER_AT + 1_000;
  rerender(root, answered(conversationId, launchId));
  assertCleanFirstMessage(host);
  expectSameRow(host, firstNode);
  expect(host.textContent).toContain("Looking at the export test.");
});

test("plain spawn, browser-only first paint: the draft pane's own seed and card give one clean bubble", () => {
  const conversationId = "conversation_first_browser";
  const launchId = "launch_first_browser";
  const attempt = createSpawnAttempt("attempt_first_browser", T0, {
    title: "Builder",
    engine: "codex",
    model: "",
    cwd: "/work/project",
    effort: "",
    fast: null,
    accountId: "",
    ["prompt"]: OPERATOR_PROMPT,
    images: [],
    src: "",
  });
  const outcome = launchedOutcome(conversationId, launchId);
  /* The two writes DraftAgentPane makes on a launched answer, in its order. */
  seedLaunchOutbox(conversationId, { id: launchId, text: attempt.prompt, images: 0, at: attempt.at });
  const provisional = provisionalSpawnFile(attempt, outcome, "project")!;
  expect(provisional.spawn?.error).toBeNull();

  const { host } = render(provisional);
  assertCleanFirstMessage(host);
  expect(firstMessageRows(host, OPERATOR_FIRST_LINE)).toHaveLength(1);
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(0);
});

test("failed launch: the only red is the failure sentence", () => {
  const conversationId = "conversation_first_failed";
  const launchId = "launch_first_failed";
  const failed = (overrides: Partial<StructuredSpawnCardState> = {}) => ({
    ...placeholder(conversationId, launchId),
    spawn: launchFacts(conversationId, launchId, {
      ["prompt"]: OPERATOR_PROMPT,
      promptEcho: OPERATOR_PROMPT,
      state: "failed",
      initialMessage: "failed",
      retrySafe: true,
      error: "runtime host unavailable",
      ...overrides,
    }),
  }) as FileEntry;

  const { host, root } = render(failed());
  assertCleanFirstMessage(host, { failed: true });
  expect(firstMessageRows(host, OPERATOR_FIRST_LINE)).toHaveLength(1);
  expect(host.querySelectorAll("[data-outbox-failure]")).toHaveLength(1);
  expect(host.querySelector("[data-outbox-status]")?.textContent).not.toContain("runtime host unavailable");
  const chip = host.querySelector('[data-launch-chip="error"]')!;
  expect(host.querySelectorAll('[data-launch-chip="error"]')).toHaveLength(1);
  expect(chip.textContent).toBe(translate("en", "spawnCard.failedDetail"));
  expect(chip.getAttribute("title")).toContain("runtime host unavailable");

  /* Recovery stopped: the stopped-recovery variant reads the same way. */
  rerender(root, failed({ state: "reconciling", initialMessage: "queued", retrySafe: false, recoveryStopped: true, error: "recovery gave up after 12 checks" }));
  assertCleanFirstMessage(host, { failed: true });
  expect(host.querySelectorAll('[data-launch-chip="error"]')).toHaveLength(1);
});

test("seat confirm: the mandate is one card from the first paint and never the operator's bubble", () => {
  const conversationId = "conversation_first_seat";
  const launchId = "launch_first_seat";
  const provisional = seatProvisionalFile({
    clientRequestId: "request_first_seat",
    at: T0,
    project: "project",
    body: { project: "project", mandate: MANDATE, promptVersion: 1 },
    launch: {
      draft: { engine: "codex", model: "", effort: "", speed: "", launchAccountId: null } as never,
      cwd: "/work/project",
      firstMessage: MANDATE,
    },
    outcome: launchedOutcome(conversationId, launchId),
  })!;
  expect(provisional.spawn?.mandate).toEqual({ kind: "version", version: 1 });

  const { host, root } = render(provisional);
  assertCleanFirstMessage(host);
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
  expect(host.textContent).not.toContain("Pinned mandate");

  /* The files poll brings the server's card: same launch, the envelope still
     parked in its error field, the mandate now named by the projection. */
  now = T0 + 3_000;
  rerender(root, {
    ...placeholder(conversationId, launchId),
    spawn: launchFacts(conversationId, launchId, { mandate: { kind: "version", version: 1 }, error: ENVELOPE, prompt: MANDATE, promptEcho: MANDATE }),
  } as FileEntry);
  assertCleanFirstMessage(host);
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);

  /* Adoption strips prompt and mandate from the launch facts a poll before the
     window has read the transcript's tail: the card stays the one first
     message in that gap. */
  tailLines = [];
  now = RECORD_AT + 500;
  rerender(root, adopted(conversationId, launchId));
  assertCleanFirstMessage(host);
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);

  /* The tail's first row lands before the delivery evidence has answered: the
     card stays and the row is not painted as the operator's bubble. */
  tailLines = operatorRecords;
  now = RECORD_AT + 1_000;
  rerender(root, adopted(conversationId, launchId));
  assertCleanFirstMessage(host);
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(0);
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
});

test("seat confirm: a window mounted after adoption still shows the card the first mount rendered", () => {
  const conversationId = "conversation_first_seat_remount";
  const launchId = "launch_first_seat_remount";
  const first = render({
    ...placeholder(conversationId, launchId),
    spawn: launchFacts(conversationId, launchId, { mandate: { kind: "version", version: 1 }, prompt: MANDATE, promptEcho: MANDATE }),
  } as FileEntry);
  expect(first.host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  flushSync(() => first.root.unmount());
  roots.delete(first.root);

  /* The phone's focus view re-resolves the conversation when its path flips: a
     new feed whose launch facts have already lost the prompt and the mandate. */
  tailLines = [];
  now = RECORD_AT + 500;
  const { host } = render(adopted(conversationId, launchId));
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(0);
});

test("seat confirm: the transcript's record takes over as the card once the delivery evidence names it", async () => {
  const conversationId = "conversation_first_seat_evidence";
  const launchId = "launch_first_seat_evidence";
  const realFetch = globalThis.fetch;
  let answerEvidence: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { answerEvidence = resolve; });
  globalThis.fetch = (async () => {
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: {}, occurrences: [{ textDigest: messageTextDigest(OPERATOR_PROMPT), deliveredAt: new Date(RECORD_AT).toISOString(), origin: "agent", mandate: { kind: "version", version: 1 } }] }),
    } as Response;
  }) as unknown as typeof fetch;
  try {
    resetMessageProvenanceCacheForTests();
    const { host, root } = render({
      ...placeholder(conversationId, launchId),
      spawn: launchFacts(conversationId, launchId, { mandate: { kind: "version", version: 1 }, prompt: OPERATOR_PROMPT, promptEcho: OPERATOR_PROMPT }),
    } as FileEntry);
    expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);

    tailLines = operatorRecords;
    now = RECORD_AT + 1_000;
    rerender(root, adopted(conversationId, launchId));
    expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(0);

    answerEvidence();
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-user-bubble]")).toHaveLength(0);
    expect(host.textContent).not.toContain("Fix the failing export test");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("seat confirm without a version names the card unqualified until the poll says more", () => {
  const provisional = seatProvisionalFile({
    clientRequestId: "request_first_seat_custom",
    at: T0,
    project: "project",
    body: { project: "project", mandate: MANDATE },
    launch: {
      draft: { engine: "claude", model: "", effort: "", speed: "", launchAccountId: null } as never,
      cwd: "/work/project",
      firstMessage: MANDATE,
    },
    outcome: launchedOutcome("conversation_first_seat_custom", "launch_first_seat_custom"),
  })!;
  expect(provisional.spawn?.mandate).toEqual({ kind: "unqualified" });
  const { host } = render(provisional);
  expect(host.querySelectorAll("[data-mandate-card]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
});

test("a seat confirm names its mandate by the approved version, or leaves it unqualified when edited", () => {
  expect(seatMandateDelivery(3)).toEqual({ kind: "version", version: 3 });
  expect(seatMandateDelivery(undefined)).toEqual({ kind: "unqualified" });
  expect(seatMandateDelivery("3")).toEqual({ kind: "unqualified" });
});
