/**
 * Task chips in the orchestrator composer, driven through the REAL composer and
 * read off the bytes that go on the wire.
 *
 * A chip is a reference the card's button put beside the draft, never text in
 * the input. Several can be added, each is removable, and a send carries every
 * one to the seat as a structured `{ id, title }` on the same selected-context
 * record the conversation reference rides, plus one plain line the seat reads in
 * its turn. The conversation reference keeps working beside them.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { OutboxBubbles } from "./conversation/OutboxBubbles";
import { composerSubmissionPayloads } from "@/lib/composerSubmissionPayloads";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { SelectedContextRef } from "@/lib/selection/selectedContext";
import type { FileEntry } from "@/lib/types";
import { installTmuxComposerRuntimeForTests, resetTmuxComposerRuntimeForTests } from "@/test-helpers/tmuxComposerRuntime";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const COMPOSING = "conversation_composing_chips";
const WORKER = "conversation_worker_chips";
const SELECTED_A = "conversation_selected_a";
const PATH_A = "fixtures/projects/atlas/worker-a.jsonl";
const TASK_A = ["11111111", "2222", "4333", "8444", "555555555555"].join("-");
const TASK_B = ["66666666", "7777", "4888", "8999", "000000000000"].join("-");

function structuredView(conversationId: string): RuntimeSessionView {
  return {
    session: {
      conversationId,
      hostKind: "codex-app-server",
      host: "hosted",
      capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: false, perTurnModel: false } },
      recentReceipts: [],
    },
    uiState: {},
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as unknown as RuntimeSessionView;
}

import { appendComposerDraft, TmuxComposer } from "./TmuxComposer";
import { VoiceComposerHost } from "./voice/VoiceComposerHost";
import { resetVoiceSlotsForTest } from "./voice/voiceSlots";
const { resetOutboxForTests, readOutbox } = await import("./conversation/outbox");
const { resetManagerIdentityForTest } = await import("./voice/managerIdentity");
const { viewBus } = await import("@/hooks/viewPresenceBus");
const { addTaskChip, readTaskChips, resetTaskChipsForTests } = await import("./orchestrator/taskChips");

const { publishSeatProject, resetSeatDeputiesForTests, seatDeputiesFor } = await import("./orchestrator/seatDeputies");
const realFetch = globalThis.fetch;
let roots: Root[] = [];
/** What `/api/runtime/send` answers: the route's pre-enqueue refusal when set. */
let refuseSends = false;
let sent: { text: string; selectedContext?: SelectedContextRef & { tasks?: { id: string; title: string }[] } }[] = [];

function fileFor(conversationId: string, name: string): FileEntry {
  return {
    path: `/${name}.jsonl`, root: "codex-sessions", name: `${name}.jsonl`, project: "atlas",
    title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
    size: 1, activity: "idle", proc: "running", pid: null, conversationId,
    pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/orchestrator/seat?project=atlas") return json({ seat: null, pending: null, exists: false });
    if (url === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; selectedContext?: SelectedContextRef; conversationId: string; idempotencyKey: string };
      sent.push({ text: body.text ?? "", selectedContext: body.selectedContext });
      if (refuseSends) {
        return new Response(JSON.stringify({ error: "structured delivery ownership is unavailable for this conversation", delivery: "refused" }), { status: 503, headers: { "content-type": "application/json" } });
      }
      const operationId = `op-${sent.length}`;
      return json({ operationId, receipt: { status: "delivered", operationId,
        conversationId: body.conversationId, idempotencyKey: body.idempotencyKey,
        kind: "send", text: body.text, at: new Date().toISOString(), revision: 1 } });
    }
    return json({});
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetVoiceSlotsForTest();
  installTmuxComposerRuntimeForTests({
    useRuntimeView: (file) => file.conversationId === COMPOSING || file.conversationId === WORKER ? structuredView(file.conversationId) : null,
  });
  resetSeatDeputiesForTests();
  sent = [];
  refuseSends = false;
  resetManagerIdentityForTest();
  resetTaskChipsForTests();
  stubFetch();
  viewBus.reportIdentity({ viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" });
  viewBus.reportContext({ project: "atlas", board: { renderedRevision: null, durableRevision: null, sync: "unavailable" } });
  viewBus.reportCards([{ path: PATH_A, conversationId: SELECTED_A, project: "atlas", label: "Worker A" }]);
  viewBus.reportSlice({ mode: "list", focusedPath: null, selectedPaths: [], visiblePaths: [], camera: null });
});

afterEach(async () => {
  resetSeatDeputiesForTests();
  resetTmuxComposerRuntimeForTests();
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  resetVoiceSlotsForTest();
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
  resetManagerIdentityForTest();
  resetTaskChipsForTests();
  viewBus.reportIdentity(null);
  viewBus.reportCards([]);
});

async function mountComposer(conversationId = COMPOSING, taskChipsFor: string | null | undefined = "atlas", hoisted = false): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<>{hoisted ? <VoiceComposerHost /> : null}<TmuxComposer file={fileFor(conversationId, "composing_chips")} {...(taskChipsFor ? { taskChipsFor } : {})} /></>);
    await new Promise((r) => setTimeout(r, 0));
  });
  return host as unknown as HTMLElement;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function sendThrough(host: HTMLElement, conversationId: string, text: string): Promise<void> {
  await act(async () => {
    appendComposerDraft(conversationId, text);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (host.querySelector("form") as HTMLFormElement)
      .dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    for (let tick = 0; tick < 12; tick += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

const chips = (host: HTMLElement) => [...host.querySelectorAll("[data-task-chip]")];

test("a hoisted seat composer renders and sends its explicit task chips when seat discovery is unavailable", async () => {
  // The normal fetch stub reports no discoverable seat. The dock already knows
  // this composer's seat identity and must carry it through the real host.
  const host = await mountComposer(COMPOSING, "atlas", true);
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Fix the mobile board" }); });
  await settle();
  const visibleChips = chips(host).length;
  await sendThrough(host, COMPOSING, "start this one");
  expect(visibleChips).toBe(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.selectedContext?.tasks).toEqual([{ id: TASK_A, title: "Fix the mobile board" }]);
  expect(sent[0]!.text).toContain(TASK_A);
  expect(readTaskChips("atlas")).toEqual([]);
});

test("a chip the card added shows above the input with its title and a remove control; the input stays empty", async () => {
  const host = await mountComposer();
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Fix the mobile board", color: "teal" }); });
  await settle();

  expect(chips(host)).toHaveLength(1);
  expect(chips(host)[0]!.getAttribute("data-task-chip")).toBe(TASK_A);
  expect(chips(host)[0]!.textContent).toContain("Fix the mobile board");
  expect(chips(host)[0]!.getAttribute("aria-label")).toContain("Fix the mobile board");
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  expect(host.querySelector(`[data-task-chip-remove="${TASK_A}"]`)).not.toBeNull();
});

test("several chips stack, and × removes only its own", async () => {
  const host = await mountComposer();
  await act(async () => {
    addTaskChip("atlas", { id: TASK_A, title: "First task" });
    addTaskChip("atlas", { id: TASK_B, title: "Second task" });
  });
  await settle();
  expect(chips(host).map((chip) => chip.getAttribute("data-task-chip"))).toEqual([TASK_A, TASK_B]);

  await act(async () => {
    (host.querySelector(`[data-task-chip-remove="${TASK_A}"]`) as HTMLElement).click();
  });
  await settle();
  expect(chips(host).map((chip) => chip.getAttribute("data-task-chip"))).toEqual([TASK_B]);
  expect(readTaskChips("atlas").map((chip) => chip.id)).toEqual([TASK_B]);
});

test("clicking a chip's title opens the task on the board", async () => {
  const opened: { project: string; id: string }[] = [];
  const { onTaskChipOpen } = await import("./orchestrator/taskChips");
  const off = onTaskChipOpen((request) => opened.push(request));
  const host = await mountComposer();
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Fix the mobile board" }); });
  await settle();
  await act(async () => { (host.querySelector(`[data-task-chip-open="${TASK_A}"]`) as HTMLElement).click(); });
  off();
  expect(opened).toEqual([{ project: "atlas", id: TASK_A }]);
});

test("a send carries every chip as a task reference, with one plain line each for the seat, and clears them", async () => {
  const host = await mountComposer();
  await act(async () => {
    addTaskChip("atlas", { id: TASK_A, title: "Fix the mobile board" });
    addTaskChip("atlas", { id: TASK_B, title: "Second task" });
  });
  await settle();
  await sendThrough(host, COMPOSING, "start this one");

  expect(sent).toHaveLength(1);
  expect(sent[0]!.selectedContext?.tasks).toEqual([
    { id: TASK_A, title: "Fix the mobile board" },
    { id: TASK_B, title: "Second task" },
  ]);
  /* The operator's words are his; the seat also reads one line per task. */
  expect(sent[0]!.text).toContain("start this one");
  expect(sent[0]!.text).toContain(TASK_A);
  expect(sent[0]!.text).toContain(TASK_B);
  expect(sent[0]!.text.trimEnd().endsWith("start this one")).toBe(true);
  expect(chips(host)).toHaveLength(0);
  expect(readTaskChips("atlas")).toEqual([]);
});

test("after a send the delivered echo shows the operator's words, never the reference lines", async () => {
  const host = await mountComposer();
  const title = "request_attention: the target blinks (#1696)";
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title }); });
  await settle();
  await sendThrough(host, COMPOSING, "start this one");

  /* The seat did read the lines; the composer's own rows must not show them. */
  expect(sent[0]!.text).toContain("[task reference —");
  expect(sent[0]!.selectedContext?.tasks).toEqual([{ id: TASK_A, title }]);
  const deliveries = host.querySelector("[data-testid=composer-deliveries]");
  expect(deliveries).not.toBeNull();
  expect(deliveries!.textContent).toContain("start this one");
  expect(deliveries!.textContent).not.toContain("task reference");
  expect(host.textContent).not.toContain("[task reference —");
});

test("the sent row remembers the chips, so the history shows what the message was about", async () => {
  const host = await mountComposer();
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Fix the mobile board" }); });
  await settle();
  await sendThrough(host, COMPOSING, "start this one");

  const entry = readOutbox(COMPOSING).at(-1);
  expect(entry?.text).toBe("start this one");
  expect(entry?.selectedContext?.tasks).toEqual([{ id: TASK_A, title: "Fix the mobile board" }]);
});

test("a selected conversation still travels beside the chips", async () => {
  viewBus.reportSlice({ mode: "list", focusedPath: PATH_A, selectedPaths: [PATH_A], visiblePaths: [], camera: null });
  const host = await mountComposer();
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Fix the mobile board" }); });
  await settle();
  await sendThrough(host, COMPOSING, "start this one");

  expect(sent[0]!.selectedContext).toMatchObject({ state: "selected", conversationId: SELECTED_A, tasks: [{ id: TASK_A }] });
});

test("a send with no chips has no tasks field and no reference lines", async () => {
  const host = await mountComposer();
  await sendThrough(host, COMPOSING, "plain message");
  expect(sent[0]!.text).toBe("plain message");
  expect(sent[0]!.selectedContext).not.toHaveProperty("tasks");
});

test("a conversation that is not the orchestrator seat shows no chips and sends none", async () => {
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Fix the mobile board" }); });
  const host = await mountComposer(WORKER, "");
  expect(chips(host)).toHaveLength(0);
  await sendThrough(host, WORKER, "hello worker");
  expect(sent[0]!.text).toBe("hello worker");
  expect(sent[0]!.selectedContext).not.toHaveProperty("tasks");
  expect(readTaskChips("atlas")).toHaveLength(1);
});

test("a send the route refuses puts the words back and the chips with them", async () => {
  refuseSends = true;
  const host = await mountComposer();
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Fix the mobile board" }); });
  await settle();
  await sendThrough(host, COMPOSING, "start this one");
  await act(async () => { for (let tick = 0; tick < 12; tick += 1) await new Promise((r) => setTimeout(r, 0)); });

  expect(sent).toHaveLength(1);
  expect(sent[0]!.selectedContext?.tasks).toEqual([{ id: TASK_A, title: "Fix the mobile board" }]);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("start this one");
  expect(readTaskChips("atlas").map((chip) => chip.id)).toEqual([TASK_A]);
  expect(chips(host).map((chip) => chip.getAttribute("data-task-chip"))).toEqual([TASK_A]);
});


test("ordinary Send preserves a task refreshed while attachment preparation saves", async () => {
  const storage = installComposerStorageForTests();
  const originalRetain = composerSubmissionPayloads.retain.bind(composerSubmissionPayloads);
  let release!: () => void;
  const retain = spyOn(composerSubmissionPayloads, "retain").mockImplementation(async (...args) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return originalRetain(...args);
  });
  try {
    const host = await mountComposer();
    await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Original" }); });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
    await act(async () => { props.onChange({ target: { files: [new dom.File(["bytes"], "fixture.txt", { type: "text/plain" })], value: "fixture.txt" } }); });
    for (let i = 0; i < 20; i++) await settle();
    await sendThrough(host, COMPOSING, "start this one");
    expect(release).toBeDefined();
    await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Updated" }); addTaskChip("atlas", { id: TASK_B, title: "Later" }); release(); });
    for (let i = 0; i < 20; i++) await settle();
    expect(sent[0]?.selectedContext?.tasks).toEqual([{ id: TASK_A, title: "Original" }]);
    expect(readTaskChips("atlas")).toEqual([{ id: TASK_A, title: "Updated" }, { id: TASK_B, title: "Later" }]);
  } finally { retain.mockRestore(); storage.uninstall(); }
});

test("an ordinary send refusal keeps the snapshot when later chips occupy the composer", async () => {
  const host = await mountComposer();
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  globalThis.fetch = (async (...args) => {
    if (String(args[0]) === "/api/runtime/send") {
      await new Promise<void>((resolve) => { release = resolve; });
      refuseSends = true;
    }
    return originalFetch(...args);
  }) as typeof fetch;
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Original" }); });
  await sendThrough(host, COMPOSING, "start this one");
  await act(async () => {
    for (let i = 0; i < 8; i++) addTaskChip("atlas", { id: `later_${i}`, title: `Later ${i}` });
    release();
  });
  for (let i = 0; i < 12; i++) await settle();
  expect(readTaskChips("atlas")).toHaveLength(8);
  expect(readOutbox(COMPOSING)[0]).toMatchObject({ state: "failed", selectedContext: { tasks: [{ id: TASK_A, title: "Original" }] } });
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
});


test("a rotated seat no longer takes project chips in the old conversation", async () => {
  let seat = COMPOSING;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args) => String(args[0]) === "/api/orchestrator/seat?project=atlas"
    ? new Response(JSON.stringify({ exists: true, seat: { conversationId: seat } }), { headers: { "content-type": "application/json" } })
    : originalFetch(...args)) as typeof fetch;
  const host = await mountComposer(COMPOSING, null);
  await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "First" }); });
  for (let i = 0; i < 6; i++) await settle();
  expect(chips(host)).toHaveLength(1);
  seat = WORKER;
  resetManagerIdentityForTest();
  await act(async () => { addTaskChip("atlas", { id: TASK_B, title: "New seat's task" }); });
  for (let i = 0; i < 6; i++) await settle();
  expect(chips(host)).toHaveLength(0);
  await sendThrough(host, COMPOSING, "ordinary worker words");
  expect(sent[0]?.selectedContext?.tasks).toBeUndefined();
  expect(readTaskChips("atlas")).toHaveLength(2);
});

test("the parked task row restores its chips before Attach again removes the row", async () => {
  const host = await mountComposer();
  const { enqueueOutbox, updateOutbox } = await import("./conversation/outbox");
  await act(async () => { enqueueOutbox(COMPOSING, { id: "parked-task", text: "start this one", images: 1, preparing: true, at: Date.now(), selectedContext: { state: "none", tasks: [{ id: TASK_A, title: "Original" }] } }); updateOutbox(COMPOSING, "parked-task", { state: "failed", needsReattach: true, preparing: undefined }); });
  const feed = document.createElement("div");
  document.body.append(feed);
  const feedRoot = createRoot(feed);
  roots.push(feedRoot);
  await act(async () => { feedRoot.render(<OutboxBubbles cardId={COMPOSING} entries={readOutbox(COMPOSING)} />); });
  const restore = feed.querySelector<HTMLButtonElement>('[data-outbox-clear="parked-task"]');
  expect(restore).not.toBeNull();
  await act(async () => { restore!.click(); });
  expect(readOutbox(COMPOSING)).toEqual([]);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("start this one");
  expect(readTaskChips("atlas")).toEqual([{ id: TASK_A, title: "Original" }]);
});


test("a seat rotation is observed after the identity TTL even when the chip list never changes", async () => {
  let seat = COMPOSING;
  let refresh!: () => void;
  const originalInterval = globalThis.setInterval;
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number, ...args: unknown[]) => {
    if (callback.name === "refreshSeat") refresh = callback;
    return originalInterval(callback, delay, ...args);
  }) as typeof setInterval);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args) => String(args[0]) === "/api/orchestrator/seat?project=atlas"
    ? new Response(JSON.stringify({ exists: true, seat: { conversationId: seat } }), { headers: { "content-type": "application/json" } })
    : originalFetch(...args)) as typeof fetch;
  try {
    const host = await mountComposer(COMPOSING, null);
    await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Original" }); });
    for (let i = 0; i < 6; i++) await settle();
    expect(chips(host)).toHaveLength(1);
    const captured = readTaskChips("atlas");
    seat = WORKER;
    resetManagerIdentityForTest();
    await act(async () => { refresh(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(readTaskChips("atlas")).toBe(captured);
    expect(chips(host)).toHaveLength(0);
    await sendThrough(host, COMPOSING, "ordinary worker words");
    expect(sent[0]?.selectedContext?.tasks).toBeUndefined();
    expect(readTaskChips("atlas")).toBe(captured);
  } finally { timer.mockRestore(); }
});


for (const refused of [false, true]) {
  test(`parallel ask carries task references and ${refused ? "restores a refused snapshot" : "keeps later chips"}`, async () => {
    installTmuxComposerRuntimeForTests({ useRuntimeView: (file) => ({ ...structuredView(file.conversationId!), session: { ...structuredView(file.conversationId!).session, turn: "running" } }) as RuntimeSessionView });
    publishSeatProject(COMPOSING, "atlas");
    let resolveGhost!: (response: Response) => void;
    let ask: { text: string } | null = null;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === "/api/orchestrator/ghost") {
        ask = JSON.parse(String(init?.body)) as { text: string };
        return new Promise<Response>((resolve) => { resolveGhost = resolve; });
      }
      return fetchBefore(input as RequestInfo, init);
    }) as typeof fetch;
    const host = await mountComposer();
    await act(async () => { addTaskChip("atlas", { id: TASK_A, title: "Fix __init__.py (#42)" }); appendComposerDraft(COMPOSING, "start this one"); });
    await act(async () => { host.querySelector("textarea")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true }) as unknown as Event); });
    expect(ask).not.toBeNull();
    expect(ask!.text).toContain(TASK_A);
    expect(ask!.text).toContain('title "Fix __init__.py (#42)"');
    expect(ask!.text).toEndWith("start this one");
    expect(readTaskChips("atlas").map((chip) => chip.id)).toEqual([TASK_A]);
    await act(async () => { addTaskChip("atlas", { id: TASK_B, title: "Later task" }); });
    await act(async () => { resolveGhost(new Response(JSON.stringify(refused ? { ok: false, error: "refused" } : { ok: true, deputy: {
      askId: "deputy_task", seatConversationId: COMPOSING, deputyConversationId: "conversation_task_deputy", ask: { text: ask!.text, images: 0, sender: null, origin: { kind: "operator" } },
      artifactPath: "fixtures/deputy.jsonl", forkRecordCount: 0, forkBytes: 0, state: "active", startedAt: new Date().toISOString(), activatedAt: null, endedAt: null, outcome: null,
      touched: { taskIds: [], pipelineIds: [], conversationIds: [] }, result: null,
    } }), { headers: { "content-type": "application/json" }, status: refused ? 409 : 200 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(readTaskChips("atlas").map((chip) => chip.id)).toEqual(refused ? [TASK_A, TASK_B] : [TASK_B]);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(refused ? "start this one" : "");
    if (!refused) expect(seatDeputiesFor(COMPOSING)[0]!.ask.text).toBe(ask!.text);
  });
}
