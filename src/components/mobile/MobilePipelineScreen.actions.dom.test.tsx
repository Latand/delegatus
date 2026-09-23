import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { PipelineActionKind } from "@/components/kanban/stagesModel";

/*
 * The phone's pipeline actions (#2072 slice 6, phone-kanban §3.13; mobile v2
 * lane 7 before it, README §4.7, §2 rule 9). The acceptance this file exists
 * for is the one that is easy to fake: the answers inside a stage (Retry,
 * Skip, One more round, Close lane) and the bar's ⋯ (Pause, Resume, Close
 * lane) must send the SAME requests the desktop board's ⋯ menu sends through
 * `usePipelineActions` — retry and skip naming the stage and attempt the
 * operator saw, One more round reading the revision first — act on the tap
 * that names them with no confirmation prompt, and Skip and Close must carry
 * their inverse in the receipt.
 *
 * So each test drives BOTH over one recording fetch and compares the requests:
 * the phone's screen, and the desktop menu's intent built the way
 * `KanbanBoard`'s pipeline menu builds it, for the same pipeline in the same
 * state. A phone control that invented its own request cannot pass.
 *
 * The two the engine cannot take back — `skip-stage` advances the cursor, and
 * a closed lane has no re-open — are held for the receipt's own window, so the
 * inverse is a real cancellation rather than a button that always answers 409.
 * The window closing sends exactly what the desktop sent.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const runtime = {
  enabled: false,
  connection: "live" as ConnectionState,
  lastEventAt: null as number | null,
  resyncedAt: null,
  store: emptyStore(),
  structuredHostsEnabled: false,
};
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => runtime,
  useRuntime: () => runtime,
  useRuntimeSelector: (selector: (state: typeof runtime) => unknown) => selector(runtime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobilePipelineScreen, createPendingPipelineActs } = await import("./MobilePipelineScreen");
const { usePipelineActions } = await import("@/components/kanban/usePipelineActions");
const { browserPipelinePorts } = await import("@/components/kanban/pipelinePorts");
const { pipelineActionOptions } = await import("@/components/kanban/stagesModel");
const { stageNames } = await import("@/components/pipelines/pipelineModel");
const { createMobileNav, MobileNavContext } = await import("./mobileNav");
const { receipts } = await import("./MobileReceipt");
const { useLocale } = await import("@/lib/i18n");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;

/** Every PATCH either surface issues, in order, and the pipeline reads. */
interface Patch { url: string; method: string; body: unknown }
let patches: Patch[] = [];
let reads: string[] = [];
/** The record the route serves: what a read answers and a PATCH echoes. */
let served: Pipeline | null = null;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (init?.method === "PATCH") {
    patches.push({ url, method: "PATCH", body: JSON.parse(String(init.body)) });
    return json({ pipeline: served });
  }
  if (url.startsWith("/api/pipelines/")) {
    reads.push(url);
    return json({ pipeline: served, stageDigests: {}, revision: "rev-7" });
  }
  return json({ roles: [] });
}) as unknown as typeof fetch;

const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  fetch: recordingFetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; patches = []; reads = []; served = null; receipts.dismiss(); });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); });

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

function nav() {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "http://localhost/#p=atlas" }];
  let index = 0;
  return createMobileNav({
    history: {
      get state() { return entries[index]!.state; },
      pushState(state, _unused, url) { entries.splice(index + 1); entries.push({ state, url: url ?? entries[index]!.url }); index += 1; },
      replaceState(state, _unused, url) { entries[index] = { state, url: url ?? entries[index]!.url }; },
      back() { if (index > 0) index -= 1; },
    },
    href: () => entries[index]!.url,
    onPopstate: () => () => {},
  });
}

function mount(node: React.ReactNode, store = nav()): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<MobileNavContext.Provider value={store}>{node}</MobileNavContext.Provider>));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const body = () => dom.document.body as unknown as HTMLElement;
const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
};

const NOW = 1_800_000_000;
const at = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();

const REVIEW_FILE = file("/repo/review.jsonl");
function file(path: string): FileEntry {
  return {
    root: "claude-projects", name: path.split("/").pop(), path, project: "atlas", title: "Review round 3", engine: "claude",
    kind: "session", fmt: "claude", parent: null, mtime: NOW - 60, size: 2_048, activity: "idle", proc: null, pid: null,
    model: "opus", pendingQuestion: null, waitingInput: null, conversationId: null,
  } as unknown as FileEntry;
}

const ROLE = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: null });

function pipeline(state: Pipeline["state"]): Pipeline {
  return {
    id: "p2", task: "Fast conversation switching", taskIds: [], project: "atlas", repoDir: "/repo", worktreeDir: "/repo-w",
    branch: "lane/p2", baseBranch: "main", baseRef: "", lastPassedCommit: "",
    stages: [
      { id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "p", next: "review", access: "read-write", effectiveRole: ROLE("builder") },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "p", next: null, onFail: { to: "implement", maxRounds: 3 }, access: "read-only", effectiveRole: ROLE("reviewer") },
    ],
    runs: [{
      stageId: "review",
      attempts: [{
        n: 3, state: "failed", effectiveRole: ROLE("reviewer"), launchId: null, conversationId: null, sessionId: null, agentPath: REVIEW_FILE.path, paneId: null,
        flowId: null, startedAt: at(4_200), completedAt: at(3_600), input: null, activatedBy: null, output: null,
        verdict: { status: "fail", findings: ["one", "two"] }, error: null,
      }],
    }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state, pausedState: state === "paused" ? "running" : null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: at(7_200), closedAt: null,
    ...(state === "needs_review"
      ? { cursor: null, reviewPending: { stageId: "review", attempt: 3, fixStageId: "implement", fixAttempt: 1, reviewedHead: "4f1c2a9d11", currentHead: "9b2e7d4c22", verdict: "fail", findings: 2 } }
      : {}),
  } as unknown as Pipeline;
}

/** The phone screen with a held-act store whose window this test closes. */
function phone(state: Pipeline["state"]) {
  let due: (() => void) | null = null;
  const acts = createPendingPipelineActs(
    { set: (callback) => { due = callback; return 1; }, clear: () => { due = null; } },
  );
  served = pipeline(state);
  const store = nav();
  store.push({ kind: "pipeline", id: "p2" });
  const host = mount(
    <MobilePipelineScreen pipeline={pipeline(state)} files={[REVIEW_FILE]} now={NOW} onOpenConversation={() => {}} acts={acts} />,
    store,
  );
  return {
    host,
    acts,
    store,
    /** An answer inside the stage. */
    answer: (action: string) => click(q(host, `[data-answer-action="${action}"]`)),
    /** A row of the bar's ⋯ sheet. */
    menu: async (key: string) => {
      click(q(host, '[data-mobile2-open="menu"]'));
      await settle();
      click(q(body(), `[data-mobile2-pipeline-menu] [data-mobile2-pipeline-action="${key}"]`));
    },
    /** The receipt's four seconds elapse. */
    closeWindow: () => { const run = due; due = null; if (run) flushSync(run); },
    windowOpen: () => due !== null,
  };
}

/**
 * The desktop board's ⋯ menu for the same pipeline: each item's intent is
 * built from `pipelineActionOptions` exactly as `KanbanBoard`'s pipeline menu
 * builds it, and sent through the same `usePipelineActions`.
 */
function desktop(state: Pipeline["state"]) {
  let select: ((action: PipelineActionKind) => void) | null = null;
  const record = pipeline(state);
  function Menu() {
    const { t } = useLocale();
    const { start } = usePipelineActions(browserPipelinePorts, () => 0, t);
    const names = stageNames(t, record);
    select = (action) => {
      const option = pipelineActionOptions(record).find((candidate) => candidate.action === action)!;
      const stageName = option.stageId ? names.get(option.stageId) ?? option.stageId : null;
      start({ pipelineId: record.id, title: record.task, action: option.action, stageId: option.stageId, stageName, expectedAttempt: option.attempt });
    };
    return null;
  }
  mount(<Menu />);
  return { choose: (action: PipelineActionKind) => select!(action) };
}

/** A request without its idempotency key, which each intent mints afresh. */
const request = (index: number) => {
  const { clientRequestId: _key, ...rest } = patches[index]!.body as Record<string, unknown>;
  return { url: patches[index]!.url, body: rest };
};
test("Retry stage, answered inside the stage, acts on the tap and sends the desktop menu's guarded retry", async () => {
  const screen = phone("needs_decision");
  screen.answer("retry-stage");
  await settle();
  expect(patches.length).toBe(1);
  expect(request(0).body).toEqual({ action: "retry-stage", expectedStageId: "review", expectedAttempt: 3 });
  /* The receipt names what happened, in the desktop's words. */
  expect(q(body(), "[data-mobile2-receipt]")!.textContent).toContain(translate("en", "kanban.pipelineAct.done.retry-stage", { title: "Fast conversation switching", stage: "Review" }));

  desktop("needs_decision").choose("retry-stage");
  await settle();
  expect(patches.length).toBe(2);
  expect(request(0)).toEqual(request(1));
  /* One tap, one act: nothing asked the operator to confirm it. */
  expect(screen.host.textContent).not.toContain("?");
});

test("One more round reads the revision the operator saw and grants exactly one round, as the desktop menu does", async () => {
  const screen = phone("needs_review");
  screen.answer("continue-review");
  await settle();
  expect(reads).toEqual(["/api/pipelines/p2"]);
  expect(patches.length).toBe(1);
  expect(request(0).body).toEqual({ action: "continue-review", addRounds: 1, expectedRevision: "rev-7" });
  expect(typeof (patches[0]!.body as { clientRequestId?: unknown }).clientRequestId).toBe("string");
  expect(q(body(), "[data-mobile2-receipt]")!.textContent).toContain(translate("en", "kanban.pipelineAct.done.continue-review", { title: "Fast conversation switching" }));

  desktop("needs_review").choose("continue-review");
  await settle();
  expect(patches.length).toBe(2);
  expect(request(0)).toEqual(request(1));
});

test("Pause and Resume from the bar's ⋯ send the desktop menu's request", async () => {
  for (const [state, key] of [["running", "pause"], ["paused", "resume"]] as const) {
    patches = [];
    const screen = phone(state);
    await screen.menu(key);
    await settle();
    expect(patches.length).toBe(1);
    expect(request(0).body).toEqual({ action: key });
    desktop(state).choose(key);
    await settle();
    expect(request(0)).toEqual(request(1));
    for (const root of roots) flushSync(() => root.unmount());
    roots = [];
  }
});

test("Skip stage is held for the receipt's window: Retry stage cancels it, and the window closing sends the desktop menu's guarded skip", async () => {
  const screen = phone("needs_decision");
  screen.answer("skip-stage");
  await settle();

  /* Nothing has gone out yet: the receipt is the window. */
  expect(patches).toEqual([]);
  const receipt = q(body(), "[data-mobile2-receipt]")!;
  expect(receipt.textContent).toContain(translate("en", "mobile2.pipeline.skipped"));
  const inverse = q(receipt, "[data-mobile2-receipt-undo]")!;
  expect(inverse.getAttribute("data-mobile2-receipt-undo")).toBe("retryStage");
  expect(inverse.textContent).toBe(translate("en", "mobile2.receipt.retryStage"));
  /* While it is held, neither answer takes another tap. */
  expect(Array.from(screen.host.querySelectorAll("[data-answer-action]")).every((button) => (button as unknown as HTMLButtonElement).disabled)).toBe(true);

  /* Taking the inverse cancels the act outright — the engine never sees it. */
  click(inverse);
  await settle();
  expect(patches).toEqual([]);
  expect(screen.windowOpen()).toBe(false);
  expect(Array.from(screen.host.querySelectorAll("[data-answer-action]")).some((button) => (button as unknown as HTMLButtonElement).disabled)).toBe(false);

  /* Skipping again and letting the window close sends the desktop's own request. */
  screen.answer("skip-stage");
  screen.closeWindow();
  await settle();
  expect(patches.length).toBe(1);
  expect(request(0).body).toEqual({ action: "skip-stage", expectedStageId: "review", expectedAttempt: 3 });

  desktop("needs_decision").choose("skip-stage");
  await settle();
  expect(patches.length).toBe(2);
  expect(request(0)).toEqual(request(1));
});

test("Close lane — in the review stage or the ⋯ — is held, leaves the screen, and its Restore cancels it", async () => {
  for (const [state, how] of [["needs_review", "answer"], ["completed", "menu"]] as const) {
    patches = [];
    receipts.dismiss();
    const screen = phone(state);
    expect(screen.store.getState().stack.at(-1)).toEqual({ kind: "pipeline", id: "p2" });
    if (how === "answer") screen.answer("close");
    else await screen.menu("archive");
    await settle();

    expect(patches).toEqual([]);
    const receipt = q(body(), "[data-mobile2-receipt]")!;
    expect(receipt.textContent).toContain(translate("en", "mobile2.pipeline.archived"));
    const inverse = q(receipt, "[data-mobile2-receipt-undo]")!;
    expect(inverse.getAttribute("data-mobile2-receipt-undo")).toBe("restore");
    expect(screen.acts.getClosing()).toEqual(["p2"]);

    click(inverse);
    await settle();
    expect(patches).toEqual([]);
    expect(screen.acts.getClosing()).toEqual([]);

    if (how === "answer") screen.answer("close");
    else await screen.menu("archive");
    screen.closeWindow();
    await settle();
    expect(patches.length).toBe(1);
    expect(request(0).body).toEqual({ action: "close" });
    for (const root of roots) flushSync(() => root.unmount());
    roots = [];
  }
  /* The desktop menu's close is the same request. */
  patches = [];
  desktop("needs_review").choose("close");
  await settle();
  expect(request(0).body).toEqual({ action: "close" });
});

test("a refusal the route explained comes back on the receipt in the danger tone, with the desktop's Retry", async () => {
  const refusing = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push({ url: String(input), method: "PATCH", body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ error: "the worktree is locked" }), { status: 409, headers: { "content-type": "application/json" } });
    }
    return recordingFetch(input, init);
  }) as unknown as typeof fetch;
  G.fetch = refusing;
  try {
    const screen = phone("needs_decision");
    screen.answer("retry-stage");
    await settle();
    const receipt = q(body(), "[data-mobile2-receipt]")!;
    expect(receipt.getAttribute("data-mobile2-receipt-error")).toBe("true");
    expect(receipt.textContent).toContain("the worktree is locked");
    const retry = q(receipt, '[data-mobile2-receipt-undo="act"]')!;
    expect(retry.textContent).toBe(translate("en", "kanban.retry"));
  } finally {
    G.fetch = recordingFetch;
  }
});

test("a lane hidden from the board offers Show on board, which sends undismiss and nothing else (#1671)", async () => {
  const hidden = { ...pipeline("needs_decision"), dismissedAt: at(60) } as Pipeline;
  const host = mount(
    <MobilePipelineScreen pipeline={hidden} files={[REVIEW_FILE]} now={NOW} onOpenConversation={() => {}} acts={createPendingPipelineActs({ set: () => 1, clear: () => {} })} />,
  );
  const show = q(host, '[data-mobile2-pipeline-action="showOnBoard"]')!;
  expect(show).not.toBeNull();
  expect(show.textContent).toContain(translate("en", "mobile2.pipeline.showOnBoard"));
  expect(show.className).toContain("min-h-11");
  click(show);
  await settle();
  expect(patches.map((patch) => patch.body)).toEqual([{ action: "undismiss" }]);
  expect(q(body(), "[data-mobile2-receipt]")!.textContent).toContain(translate("en", "mobile2.pipeline.shownOnBoard"));

  /* A lane still on the board has nothing to bring back. */
  const onBoard = mount(<MobilePipelineScreen pipeline={pipeline("needs_decision")} files={[REVIEW_FILE]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(onBoard, '[data-mobile2-pipeline-action="showOnBoard"]')).toBeNull();
});

test("a second held act sends the first rather than dropping it, and a held act's own sender is what goes out", () => {
  /* The screen disables its own answers while an act is held, so the second
     act comes from somewhere else — another pipeline's screen, the same tab. */
  const sent: string[] = [];
  let due: (() => void) | null = null;
  const acts = createPendingPipelineActs(
    { set: (callback) => { due = callback; return 1; }, clear: () => { due = null; } },
    (act) => { sent.push(`${act.pipelineId}:${act.action}`); },
  );
  acts.begin({ pipelineId: "p2", action: "skip-stage", send: () => { sent.push("p2:guarded-skip"); } });
  expect(sent).toEqual([]);
  acts.begin({ pipelineId: "p7", action: "close" });
  expect(sent).toEqual(["p2:guarded-skip"]);
  const run = due as (() => void) | null;
  run?.();
  expect(sent).toEqual(["p2:guarded-skip", "p7:close"]);
  /* A cancelled act is never sent, and the store is empty afterwards. */
  acts.begin({ pipelineId: "p9", action: "close" });
  acts.cancel();
  expect(sent).toEqual(["p2:guarded-skip", "p7:close"]);
  expect(acts.getState()).toBeNull();
});
