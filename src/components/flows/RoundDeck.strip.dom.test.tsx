import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Flow, Round } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { emptyStore } from "@/components/runtime/runtimeModel";

import type { DeckRound } from "./RoundDeck";

/* Archived deck panes keep their transcript and disclosure behavior while
 * suppressing controls and the composer, including unfinished old snapshots. */

const dom = new HappyWindow();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
    sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
    ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  });
}
bindDomGlobals();

function structuredRoot(): RuntimeSessionView {
  return { session: { hostKind: "claude-broker", host: "hosted", artifactPath: "/root.jsonl" } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true };
}
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: true, connection: "live", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: true, connection: "live", resyncedAt: null, store: emptyStore() }),
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: (path: string | null) => (path === "/root.jsonl" ? structuredRoot() : null),
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const realFetch = globalThis.fetch;
const { RoundDeck } = await import("./RoundDeck");

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  globalThis.fetch = realFetch;
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
});

/* Scanner-shaped Claude subagent reviewer transcript: proc/pid null. */
const subagent: FileEntry = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "project", title: "reviewer",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 1, size: 1, activity: "live",
  proc: null, pid: null, conversationId: "conv-child", model: "sonnet", pendingQuestion: null, waitingInput: null,
};

function round(over: Partial<Round> = {}): Round {
  return {
    n: 1, reviewerPath: "/child.jsonl", findingsPath: null, triggeredBy: "marker", readyNote: null,
    verdict: null, findingsCount: null, startedAt: "2026-07-12T00:00:00Z", reviewedAt: null, relayedAt: null, error: null,
    ...over,
  } as Round;
}

function flow(reviewerMode: Flow["reviewerMode"]): Flow {
  return {
    id: "flow-1", template: "implement-review-loop", project: "project", cwd: "/project", implementerPath: "/impl.jsonl",
    roles: { implementer: { engine: "claude", model: null, effort: null }, reviewer: { engine: "claude", model: null, effort: null } },
    baseRef: "base", baseMode: "head", mode: "auto", reviewerMode, roundLimit: 5, state: "reviewing", stateDetail: null,
    rounds: [], createdAt: "2026-07-12T00:00:00Z", closedAt: null,
  } as Flow;
}

function render(rounds: DeckRound[], reviewerMode: Flow["reviewerMode"] = "pane"): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const rootInstance = createRoot(host as unknown as HTMLElement);
  roots.add(rootInstance);
  // Exercise the expanded pane; a collapsed deck could hide an active control.
  dom.localStorage.setItem("llvReviewDeckCollapsed:flow-1", JSON.stringify({ v: "expanded", at: null }));
  flushSync(() => rootInstance.render(<RoundDeck flow={flow(reviewerMode)} rounds={rounds} focusRound={null} />));
  return host as unknown as HTMLElement;
}

const surface = (host: HTMLElement) => host.querySelector("[data-agent-control-strip]")?.getAttribute("data-strip-surface") ?? null;
const hasComposer = (host: HTMLElement) => host.querySelector("textarea") !== null;

test("an archived in-progress round has no agent controls or composer", () => {
  const host = render([{ key: "r1", round: round(), file: subagent }]);
  expect(host.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  expect(surface(host)).toBeNull();
  expect(hasComposer(host)).toBe(false);
});

test("a finished archived round has no agent controls or composer", () => {
  const host = render([{ key: "r1", round: round({ verdict: "APPROVE", reviewedAt: "2026-07-12T01:00:00Z" }), file: subagent }]);
  expect(host.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  expect(surface(host)).toBeNull();
  expect(hasComposer(host)).toBe(false);
});

test("a headless archive never mounts controls for an unfinished round", () => {
  const host = render([{ key: "r1", round: round(), file: subagent }], "headless");
  expect(host.querySelector("[data-review-deck-collapse]")).not.toBeNull();
  expect(surface(host)).toBeNull();
  expect(hasComposer(host)).toBe(false);
});


test.each([false, true])("expanded archive has no transcript or host mutation controls (running: %s)", running => {
  const writes: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") writes.push(init.method + " " + url);
    return Response.json({});
  }) as unknown as typeof fetch;
  const file = { ...subagent, activity: running ? "live" : "idle", proc: running ? "running" : null,
    pid: running ? 123 : null, renamable: true, waitingInput: { target: "pane", since: 1, screenTail: "Retained prompt", menu: null } } as FileEntry;
  const host = render([{ key: "r1", round: round(), file }]);
  expect(host.querySelector("[data-link-path]")).not.toBeNull();
  const controls = [...host.querySelectorAll("button, input, textarea")];
  const labels = controls.map(el => [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")].join(" ")).join("\n");
  expect(labels).not.toMatch(/Delete the conversation|Stop|Resume|Restart|Switch account|Rename|Send|Press Enter/i);
  expect(host.querySelector("[data-agent-control-strip], textarea, [data-session-title-edit]")).toBeNull();
  expect(writes).toEqual([]);
});


test("the phone can fold an expanded archive with a retained transcript", async () => {
  dom.happyDOM.setWindowSize({ width: 390, height: 844 });
  try {
    const host = render([{ key: "r1", round: round(), file: subagent }]);
    const collapse = host.querySelector<HTMLButtonElement>("nav [data-review-deck-collapse]");
    expect(collapse).not.toBeNull();
    flushSync(() => collapse!.click());
    for (let n = 0; n < 1000 && !host.querySelector("[data-review-deck-collapsed]"); n++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(host.querySelector("[data-review-deck-collapsed]")).not.toBeNull();
  } finally { dom.happyDOM.setWindowSize({ width: 1024, height: 768 }); }
});
