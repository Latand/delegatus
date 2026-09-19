import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { projectLaunchConversations } from "@/lib/agent/spawnProjection";
import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

/**
 * Issue #1793 — a delivered launch prompt never reads "Delivering".
 *
 * The subject is the ROTATION shape: a successor orchestrator seat is launched
 * with a long mandate, and the message actually delivered to the agent is that
 * mandate wrapped in a role/handoff scaffold, so the launch's echo identity is
 * not its display prompt. The launch is driven exactly as production drives it
 * — a real registry receipt, a real held delivery settled `delivered`, and the
 * PRODUCTION projection (`projectLaunchConversations`) deriving the card facts
 * and then the adopted conversation's transient facts — and the window is
 * rendered at each step.
 *
 * Two things are asserted once the receipt says the initial message was
 * delivered: the launch bubble never reads "Delivering" again (the chip reads
 * the receipt), and the mandate renders exactly once beside the transcript's
 * own first user record.
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
const outbox = await import("./conversation/outbox");
const { resetOutboxForTests } = outbox;
/** A reseed admitted well after its conversation's transcript began. */
const admittedAtForReseed = Date.parse("2026-09-19T05:00:00.000Z");

/* An invented generation id, assembled so no literal identifier is
   committed. */
const SESSION_ID = ["5c0b17e2", "44a1", "4e90", "9b3c", "1793abcdef01"].join("-");

/** The rotation mandate the operator sees — long, as every mandate is. */
const MANDATE = [
  "You are the viewer's built-in Manager: the agent that owns the board and runs",
  "the whole conveyor through the viewer's own HTTP API and MCP tools.",
  "",
  ...Array.from({ length: 40 }, (_, index) => `Standing rule ${index + 1}: keep every worker visible and controllable in the Viewer.`),
].join("\n");

/** What the launch actually DELIVERS: the mandate with the rotation's role
    preamble in front of it and its handoff section appended behind it. The
    echo identity the bubble waits for is therefore never the display prompt. */
const ECHO = [
  "You are the Orchestrator. Drive work through the production Viewer MCP tools.",
  "",
  "Mode: standard",
  "Maximum workers: 3",
  "",
  MANDATE,
  "",
  "## Handoff",
  "Supersedes the predecessor seat; its open lanes are listed below.",
].join("\n");

/* The registry stamps its receipts from the system clock, so the window's
   clock is anchored on the admission the receipt actually recorded. */
let admittedAt = 0;
let deliveredAt = 0;
let now = 0;
const originalDateNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let ticks: Array<() => void> = [];
let directory = "";

const roots = new Set<Root>();
beforeEach(() => {
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
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1793-rotation-launch-"));
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  Date.now = originalDateNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

/** The rotation launch, as the registry records it: a structured launch whose
    durable display payload carries the raw mandate and the scaffolded echo,
    and whose initial message is held, delivered, and then scrubbed. */
function rotationLaunch() {
  const artifactPath = path.join(directory, `${SESSION_ID}.jsonl`);
  const registry = new AgentRegistry(
    path.join(directory, "agent-registry.json"),
    undefined,
    undefined,
    { sqliteMode: "off", now: () => now },
  );
  const begun = beginLegacySpawnFixture(registry, {
    engine: "claude",
    cwd: directory,
    transport: "structured",
    accountId: "handoff-account",
    accountPin: true,
    clientAttemptId: "rotation_1793_successor",
    requestDigest: "d".repeat(64),
    launchProfile: emptyLaunchProfile({ cwd: directory, title: "Orchestrator seat after rotation" }),
    launchDisplay: { prompt: MANDATE, images: 0, echo: ECHO },
  });
  if (begun.kind !== "created") throw new Error("expected a structured launch receipt");
  admittedAt = Date.parse(begun.receipt.createdAt);
  /* The rotation's initial message reached the agent nineteen seconds after
     admission — the interval the operator's own receipt showed. */
  deliveredAt = admittedAt + 19_000;
  now = admittedAt;
  const delivery = registry.holdDelivery(
    begun.receipt.conversationId,
    ECHO,
    `spawn_${begun.receipt.launchId}`,
    "text",
    [],
    null,
    { operationId: `spawn_message_${begun.receipt.launchId}`, kind: "send", origin: { kind: "operator" } },
  );
  return { registry, artifactPath, deliveryId: delivery.id, launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId };
}

/** Bind the launch to its transcript and settle the receipt's initial message
    `delivered`, exactly as the delivery queue does once the agent has it. */
function deliverAndMaterialize(launch: ReturnType<typeof rotationLaunch>): void {
  now = deliveredAt;
  fs.writeFileSync(launch.artifactPath, `${JSON.stringify({ type: "user", message: { role: "user", content: ECHO } })}\n`);
  launch.registry.reconcileConversations([{
    engine: "claude",
    path: launch.artifactPath,
    accountId: "handoff-account",
    launchProfile: emptyLaunchProfile({ cwd: directory }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: new Date(deliveredAt).toISOString(),
  }]);
  launch.registry.settleSpawn(launch.launchId, {
    key: { engine: "claude", sessionId: SESSION_ID },
    artifactPath: launch.artifactPath,
    cwd: directory,
    accountId: "handoff-account",
    launchProfile: emptyLaunchProfile({ cwd: directory }),
    status: "unhosted",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  launch.registry.recordDeliveryOutcome(launch.deliveryId, "delivered");
}

/** The scanned transcript row of the successor seat. */
function transcriptRow(
  launch: ReturnType<typeof rotationLaunch>,
  overrides: Partial<FileEntry> = {},
): FileEntry {
  return {
    path: launch.artifactPath,
    root: "claude-projects",
    name: `${SESSION_ID}.jsonl`,
    project: "repo",
    title: "Orchestrator seat after rotation",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: deliveredAt / 1000,
    size: 2,
    activity: "live",
    activityReason: "jsonl_turn_open",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    conversationId: launch.conversationId,
    generation: 1,
    spawnOrigin: "viewer",
    /* The seat's own transcript: the host wrote its first record sixteen
       seconds after the launch was admitted. */
    sessionStartedAt: new Date(admittedAt + 16_000).toISOString(),
    lastTurn: { startedAt: deliveredAt, endedAt: null },
    lastAssistantMessageAt: null,
    ...overrides,
  } as FileEntry;
}

/** One pass of the PRODUCTION launch projection over the scanned files, with
    its facts folded onto the rows exactly as `/api/files` folds them. */
function project(launch: ReturnType<typeof rotationLaunch>, files: FileEntry[], atMs: number): FileEntry[] {
  const projection = projectLaunchConversations(files, launch.registry.snapshot(), atMs);
  const projected = [...files, ...projection.cards];
  for (const file of projected) {
    const facts = projection.facts.get(file.path);
    if (facts) file.launch = facts;
  }
  return projected;
}

function render(file: FileEntry, root?: Root): { host: HTMLElement; root: Root } {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const mounted = root ?? createRoot(host as unknown as HTMLElement);
  roots.add(mounted);
  flushSync(() => {
    mounted.render(
      <LogFeed
        file={file}
        showSvc={false}
        lineFilter=""
        onStatus={() => undefined}
        paused
        follow={false}
        setFollow={() => undefined}
      />,
    );
  });
  flushSync(() => {
    for (const tick of ticks) tick();
  });
  return { host: host as unknown as HTMLElement, root: mounted };
}

function rerender(root: Root, file: FileEntry): void {
  flushSync(() => {
    root.render(
      <LogFeed
        file={file}
        showSvc={false}
        lineFilter=""
        onStatus={() => undefined}
        paused
        follow={false}
        setFollow={() => undefined}
      />,
    );
  });
  flushSync(() => {
    for (const tick of ticks) tick();
  });
}

/** Every rendering of the launch mandate the window can show at once. */
function mandateRenderings(host: HTMLElement): number {
  return host.querySelectorAll('[data-outbox-entry], [data-feed-kind="tmsg"], [data-feed-kind="user"]').length;
}

function outboxStatuses(host: HTMLElement): string[] {
  return [...host.querySelectorAll("[data-outbox-status]")].map((node) => node.textContent ?? "");
}

/** The rendered tail of a seat already several turns into its work: the
    mandate is the transcript's FIRST record and is nowhere in it. */
function laterTail(): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      uuid: "uuid-answer",
      timestamp: new Date(deliveredAt + 60_000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "Seat is up. Reading the board." }] },
    }),
  ];
}

test("issue 1793: a rotation launch whose receipt says delivered never reads Delivering", () => {
  const launch = rotationLaunch();

  /* The initial message is still queued: the launch owns the window, shows the
     mandate once, and "Delivering" is the honest word for it. */
  now = admittedAt + 5_000;
  const [card] = project(launch, [], now);
  const { host, root } = render(card!);
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(1);
  expect(outboxStatuses(host).join(" ")).toContain("Delivering");
  expect(mandateRenderings(host)).toBe(1);

  /* One poll later the seat is already working: the message reached the agent
     nineteen seconds after admission, the transcript materialized, and the
     seat's first assistant turn landed — so the projection has already retired
     the transient launch facts from the row. The mandate is the transcript's
     first record, far above the rendered tail of a busy seat.

     The receipt said delivered. The bubble must not still say Delivering. */
  deliverAndMaterialize(launch);
  tailLines = laterTail();
  now = deliveredAt + 120_000;
  const [answered] = project(launch, [transcriptRow(launch, { lastAssistantMessageAt: deliveredAt + 60_000 })], now);
  expect(answered!.launch).toBeUndefined();
  rerender(root, answered!);
  expect(outboxStatuses(host).join(" ")).not.toContain("Delivering");
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
  /* And the mandate is not rendered at all here: the transcript's own record
     for it is far above this tail, and a second bubble would be a duplicate. */
  expect(mandateRenderings(host)).toBe(0);
});

test("issue 1793: the launch bubble never doubles the transcript's own first user record", () => {
  const launch = rotationLaunch();

  now = admittedAt + 5_000;
  const [card] = project(launch, [], now);
  const { host, root } = render(card!);
  expect(mandateRenderings(host)).toBe(1);

  /* The transcript carries the mandate as its first user record — the
     scaffolded echo, which is NOT the mandate the bubble displays — and the
     receipt says delivered. Exactly one rendering, and no Delivering chip. */
  deliverAndMaterialize(launch);
  tailLines = [JSON.stringify({
    type: "user",
    uuid: "uuid-mandate",
    timestamp: new Date(deliveredAt).toISOString(),
    message: { role: "user", content: [{ type: "text", text: ECHO }] },
  })];
  now = deliveredAt + 1_000;
  const [adopted] = project(launch, [transcriptRow(launch)], now);
  rerender(root, adopted!);
  expect(outboxStatuses(host).join(" ")).not.toContain("Delivering");
  expect(mandateRenderings(host)).toBe(1);

  /* The seat answers, the projection retires the launch facts, and the
     transcript record stays the mandate's one rendering. */
  now = deliveredAt + 120_000;
  const [answered] = project(launch, [transcriptRow(launch, { lastAssistantMessageAt: deliveredAt + 60_000 })], now);
  rerender(root, answered!);
  expect(answered!.launch).toBeUndefined();
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
  expect(mandateRenderings(host)).toBe(1);
});


test("issue 1793: a launch reseeded into a conversation that already had a transcript keeps its bubble", () => {
  const { retireLaunchOutboxOnTranscriptTurn, seedLaunchOutbox, readOutbox, visibleOutbox } = outbox;
  const cardId = "conversation_reseed_1793";
  const owner = { conversationId: cardId, generation: 2 } as const;
  /* The conversation has been running for an hour; the reseed is admitted now
     and its message is still queued behind the turn the agent is in. Board
     task 226e7bb5 (#641) is this case in the opposite direction — its bubble
     must survive until its own delayed echo, whatever the transcript shows. */
  const transcriptStartedAt = admittedAtForReseed - 3_600_000;
  seedLaunchOutbox(cardId, {
    id: "launch_reseed_1793",
    text: "Continue with the second half of the plan.",
    images: 0,
    at: admittedAtForReseed,
    owner,
    state: "delivering",
  });
  retireLaunchOutboxOnTranscriptTurn(cardId, {
    owner,
    startedAt: transcriptStartedAt,
    assistantTurnAt: admittedAtForReseed + 1_000,
  });
  expect(readOutbox(cardId)[0]?.adoptedAt).toBeUndefined();
  expect(visibleOutbox(readOutbox(cardId), new Map(), admittedAtForReseed + 2_000, owner)).toHaveLength(1);
});
