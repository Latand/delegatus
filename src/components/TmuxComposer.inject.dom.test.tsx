import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import { composerSubmissionSaving } from "@/lib/composerSubmissionPayloads";
import type { NativeQueueDependencies } from "@/hooks/useNativeQueue";
import type { NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";

import { messageRowRecovery } from "./conversation/rowRecovery";
import type { RuntimeAdmissionLookup, RuntimeSessionView } from "@/hooks/useRuntime";

import { agentCapabilitiesFromViews } from "./useAgentCapabilities";
import { writeProfile } from "./runtimeProfile";
import { adoptComposerState, appendComposerDraft, TmuxComposer } from "./TmuxComposer";
import { CONTEXT_AUTO_STORAGE_KEY } from "./composerContextMode";
import { resetRetainedQueueAdmissionsForTests } from "./retainedQueueAdmissions";
import { readOutbox, resetOutboxForTests } from "./conversation/outbox";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";
import { accessoryReserve, mobileComposerCeiling, mobileComposerUnitMax } from "@/lib/composerScroll";

/**
 * The composer's injection action, driven through the real component (#1560).
 *
 * The operator asked for a discoverable control that adds to the thread without
 * interrupting it, and asked for the existing submissions to stay exactly as
 * they are. Both halves are asserted here against the rendered composer rather
 * than against a hand-built capability object, so the REAL capability rules
 * decide what appears:
 *
 * - the action shows only when the host has advertised injection;
 * - choosing it posts to the injection endpoint and to nothing else — no send,
 *   no queue write, so no interrupt and no new turn can come from it;
 * - it stays available while the thread is idle, where a steer is refused,
 *   because idle injection is a supported outcome rather than a no-op;
 * - Enter and Alt+Enter keep their meanings.
 */

/** The composer decodes a staged attachment through a FileReader; this is the
    same queued stand-in the draft-attachment suite uses. */
class QueuedReader {
  static queue: QueuedReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL() { QueuedReader.queue.push(this); }
  static settleAll(dataUrl: string) {
    for (const reader of QueuedReader.queue.splice(0, QueuedReader.queue.length)) {
      reader.result = dataUrl;
      reader.onload?.();
    }
  }
}

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
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  File: dom.File,
  FileReader: QueuedReader,
  URL: dom.URL,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

/* A send or queue hand-off that carries a document keeps the complete
   submission in IndexedDB before it reaches the wire (#1647), so the
   documents these tests stage need the same process-local store the other
   attachment suites use. */
const composerStorage = installComposerStorageForTests();
afterAll(() => composerStorage.uninstall());

const CARD = "conv-inject";
const realFetch = globalThis.fetch;

let queueWrites: Record<string, unknown>[] = [];
let queueEntries: NativeQueueRecord[] = [];
let sends: Record<string, unknown>[] = [];
let steerSupported = true;
let turn: "running" | "idle" = "idle";
let nativeQueueCapable = true;
let injectCapable = true;
let injections: Record<string, unknown>[] = [];
let durableReceipts: Record<string, unknown>[] = [];
let injectAnswer: Record<string, unknown> = { ok: true, status: 202, receipt: { status: "queued" }, operationId: "inject-1" };
let holdInjection = false;
let rejectInjection = false;
let releaseInjection: (() => void) | null = null;
let admissionAnswer: RuntimeAdmissionLookup = { outcome: "unknown" };
let admissionLookups: { conversationId: string; key: string }[] = [];
let holdLookup = false;
let releaseLookup: (() => void) | null = null;

/** The journal's own answer, in the shape the route actually returns: the
    operation it committed, and a receipt carrying that operation's identity —
    which conversation, which idempotency key, which kind of command. The hook
    checks all of it before reading the verdict, so a stub that answers less than
    this is testing a contract the server does not have. */
function journalReceipt(body: Record<string, unknown>, status = "queued"): { status: number; body: Record<string, unknown> } {
  const operationId = `op-${String(body.idempotencyKey)}`;
  return {
    status: status === "rejected" ? 409 : 202,
    body: {
      operationId,
      receipt: {
        operationId,
        conversationId: body.conversationId,
        idempotencyKey: body.idempotencyKey,
        kind: "native-queue",
        status,
        revision: 1,
        at: "2026-09-10T11:00:00.000Z",
        admittedAt: "2026-09-10T11:00:00.000Z",
      },
    },
  };
}

const queueTransport: NativeQueueDependencies = {
  read: async () => ({ entries: queueEntries, native: { threadId: "thread-1", items: [], stale: false } }),
  write: async (body) => {
    queueWrites.push(body);
    return journalReceipt(body);
  },
};

/** A real runtime session view, so the REAL capability rules decide what the
    composer renders. A hand-built `caps` object would only be testing itself. */
function sessionView(): RuntimeSessionView {
  return {
    session: {
      conversationId: CARD,
      sessionKey: { engine: "codex", sessionId: "thread-1" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn,
      provenance: "structured",
      accountId: "acct-1",
      parentConversationId: null,
      cwd: null,
      artifactPath: "/codex.jsonl",
      capabilities: {
        steer: steerSupported,
        structuredAttention: true,
        nativeQueue: nativeQueueCapable,
        inject: injectCapable,
        /* A host that negotiated image input, so the composer's own attachment
           gate is open and what is under test is the queue path rather than the
           gate. */
        imageInput: { supported: true, mimes: ["image/png"] },
      },
      activeTurnId: turn === "running" ? "turn-live" : null,
      nativeQueueRevision: 0,
      attentionIds: [],
      recentReceipts: [],
      revision: 1,
    } as never,
    uiState: turn === "running" ? "working" : "idle",
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as never;
}

beforeEach(() => {
  observed = {};
  queueWrites = [];
  queueEntries = [];
  sends = [];
  steerSupported = true;
  turn = "idle";
  nativeQueueCapable = true;
  injectCapable = true;
  injections = [];
  durableReceipts = [];
  injectAnswer = { ok: true, status: 202, receipt: { status: "queued" }, operationId: "inject-1" };
  holdInjection = false;
  rejectInjection = false;
  releaseInjection = null;
  admissionAnswer = { outcome: "unknown" };
  admissionLookups = [];
  holdLookup = false;
  releaseLookup = null;
  /* These cases are about the one-shot action and the ordinary submissions
     beside it. With auto on, a running turn would put the composer in context
     mode and Enter would inject, so the suite pins auto off and keeps the mode
     manual (normal). The mode itself is covered by TmuxComposer.contextMode. */
  localStorage.setItem(CONTEXT_AUTO_STORAGE_KEY, "0");
  setRuntimeUiEnabledForTests(false);
  setTmuxComposerRuntimeDependenciesForTests({
    nativeQueue: queueTransport,
    lookupRuntimeAdmission: async (conversationId, key) => {
      admissionLookups.push({ conversationId, key });
      if (holdLookup) await new Promise<void>(resolve => { releaseLookup = resolve; });
      return admissionAnswer;
    },
    useAgentCapabilities: ((entry: FileEntry) =>
      agentCapabilitiesFromViews(entry, sessionView(), null, true)) as never,
    /* The DURABLE receipts the runtime has published for this card. This is how
       an injection's eventual fate reaches the composer — the POST answer only
       ever says it was admitted. */
    useRuntimeReceiptsForArtifact: (() => durableReceipts) as never,
    sendRuntimeMessage: (async (options: Record<string, unknown>) => {
      sends.push(options);
      return { ok: true, status: 202, operationId: "send-1", receipt: {
        operationId: "send-1", conversationId: options.conversationId,
        idempotencyKey: options.idempotencyKey, kind: "send", status: "queued",
        text: options.text, at: new Date().toISOString(), revision: 1,
      } };
    }) as never,
    injectRuntimeContext: (async (options: Record<string, unknown>) => {
      injections.push(options);
      /* A test may HOLD the answer, so the in-flight state of the composer is
         actually observable. A stub that resolves in the same tick would make
         "what does it say before the answer" untestable — and that window is
         exactly where an optimistic claim would live. */
      if (holdInjection) await new Promise<void>((resolve) => { releaseInjection = resolve; });
      if (rejectInjection) throw new Error("connection lost after admission");
      return injectAnswer;
    }) as never,
  });
});

afterEach(() => {
  setTmuxComposerRuntimeDependenciesForTests(null);
  setRuntimeUiEnabledForTests(null);
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetRetainedQueueAdmissionsForTests();
  resetOutboxForTests();
  composerStorage.reset();
});

/** Per-test fields of the conversation the board actually observed. */
let observed: Partial<FileEntry> = {};

const file = {
  path: "/codex.jsonl",
  root: "codex-sessions",
  name: "codex.jsonl",
  project: "viewer",
  title: "Codex",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "idle",
  proc: "running",
  pid: null,
  conversationId: CARD,
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry;

async function mount(): Promise<{ host: HTMLElement; root: Root }> {
  globalThis.fetch = (async (input: string) => {
    if (String(input) === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: {} }) } as Response;
    return new Promise(() => {}) as unknown as Response;
  }) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={{ ...file, ...observed }} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { host, root };
}

const settle = async (run: () => void) => {
  await act(async () => {
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** A submission that carries a document saves it to IndexedDB before the wire,
    which takes more than one turn; waits, bounded, for what it reaches. */
async function settleUntil(reached: () => boolean, run: () => void = () => {}): Promise<void> {
  await act(async () => {
    run();
    for (let turnIndex = 0; turnIndex < 50 && !reached(); turnIndex += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** React's delegated keydown is not delivered by a bare dispatch in happy-dom,
    so the handler is invoked the way a keypress would reach it. */
function press(textarea: HTMLTextAreaElement, key: string, modifiers: { altKey?: boolean; shiftKey?: boolean } = {}): void {
  const propsKey = Object.keys(textarea).find((candidate) => candidate.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onKeyDown(event: unknown): void }>)[propsKey]!;
  props.onKeyDown({
    key,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
    stopPropagation() {},
  });
}

/* The send menu renders through a portal into the composer's own document —
   the composer box is bounded and scrolls, and an in-flow menu was clipped by
   it (#1629) — so its actions are looked for in the document, not under the
   mount. */
const menuAction = (host: HTMLElement, label: string) =>
  [...host.ownerDocument.querySelectorAll("button")].find((button) => button.textContent?.includes(label));

/** The send menu opens on the send control's context menu, which is how the
    composer has always exposed its secondary submissions. */
async function openSendMenu(host: HTMLElement): Promise<void> {
  for (const node of host.querySelectorAll("span")) {
    const propsKey = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = propsKey
      ? (node as unknown as Record<string, { onContextMenu?: (event: unknown) => void }>)[propsKey]
      : null;
    if (typeof props?.onContextMenu !== "function") continue;
    await settle(() => props.onContextMenu!({ preventDefault() {}, stopPropagation() {} }));
    return;
  }
  throw new Error("the send control exposed no context menu");
}


const textarea = (host: HTMLElement) => host.querySelector("textarea")!;

async function type(host: HTMLElement, value: string): Promise<void> {
  const field = textarea(host);
  const propsKey = Object.keys(field).find((candidate) => candidate.startsWith("__reactProps$"))!;
  const props = (field as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
  await settle(() => props.onChange({ target: { value }, currentTarget: { value } }));
}

test("the injection action is offered, and choosing it posts only to the injection endpoint", async () => {
  turn = "running";
  const { host, root } = await mount();
  await type(host, "also read the migration notes");
  await openSendMenu(host);

  const action = menuAction(host, "Add to context");
  expect(action).toBeDefined();
  expect(action!.hasAttribute("disabled")).toBe(false);
  /* While a turn is running the hint says what actually happens to it. */
  expect(action!.textContent).toContain("without interrupting");

  await settle(() => action!.click());
  await settle(() => {});

  expect(injections).toHaveLength(1);
  expect(injections[0]).toMatchObject({
    conversationId: CARD,
    text: "also read the migration notes",
  });
  /* NOTHING ELSE WAS TOUCHED. A send here would interrupt the turn and a queue
     write would park the words until it ended; the action promises neither. */
  expect(sends).toEqual([]);
  expect(queueWrites).toEqual([]);
  /* The draft is cleared, exactly as the other submissions clear it. */
  expect(textarea(host).value).toBe("");
  root.unmount();
});

test("the action stays available while the thread is idle, where a steer is not", async () => {
  turn = "idle";
  const { host, root } = await mount();
  await type(host, "background material");
  await openSendMenu(host);

  const inject = menuAction(host, "Add to context");
  expect(inject!.hasAttribute("disabled")).toBe(false);
  /* Idle injection has its own honest description: it stores rather than joins. */
  expect(inject!.textContent).toContain("Stores it in the conversation");

  /* The steer action is the contrast: nothing is running, so it is refused. */
  const steer = menuAction(host, "Steer the running turn");
  expect(steer!.hasAttribute("disabled")).toBe(true);

  await settle(() => inject!.click());
  await settle(() => {});
  expect(injections).toHaveLength(1);
  expect(sends).toEqual([]);
  root.unmount();
});

test("a host that has not advertised injection offers no action at all", async () => {
  injectCapable = false;
  const { host, root } = await mount();
  await type(host, "nowhere to go");
  await openSendMenu(host);

  /* Not a disabled row: the capability was never observed, so the composer
     makes no offer it cannot keep. */
  expect(menuAction(host, "Add to context")).toBeUndefined();
  expect(menuAction(host, "Queue")).toBeDefined();
  root.unmount();
});

test("the existing submissions keep their meanings beside the new action", async () => {
  turn = "running";
  const { host, root } = await mount();
  await type(host, "answer me");

  /* Enter still sends, and a send still interrupts the running turn. */
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ policy: "interrupt-active" });
  expect(injections).toEqual([]);

  /* Alt+Enter still hands the draft to Codex's own queue. */
  await type(host, "later please");
  await settle(() => press(textarea(host), "Enter", { altKey: true }));
  await settle(() => {});
  expect(queueWrites).toHaveLength(1);
  expect(injections).toEqual([]);
  root.unmount();
});

/** Reaches the picker the composer renders and hands it a real document, the
    way the attachment suites do, so the staged state is the composer's own. */
async function stageFile(host: HTMLElement, name: string, body: string, finishRead = true): Promise<void> {
  let onFiles: ((files: File[]) => void) | null = null;
  for (const node of host.querySelectorAll("input")) {
    const propsKey = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = propsKey ? (node as unknown as Record<string, { onChange?: (event: unknown) => void; type?: string }>)[propsKey] : null;
    if (node.getAttribute("type") !== "file" || typeof props?.onChange !== "function") continue;
    const handler = props.onChange;
    await settle(() => handler({ target: { files: [new File([body], name, { type: "text/markdown" })], value: "" } }));
    if (finishRead) QueuedReader.settleAll(`data:text/markdown;base64,${Buffer.from(body).toString("base64")}`);
    await settle(() => {});
    return;
  }
  if (!onFiles) throw new Error("the composer rendered no file input");
}

test("a staged document rides the injection instead of being silently dropped", async () => {
  const { host, root } = await mount();
  await type(host, "use the attached spec");
  await stageFile(host, "spec.md", "# spec\n");
  await openSendMenu(host);

  const action = menuAction(host, "Add to context");
  /* A DOCUMENT IS NOT AN IMAGE. Images genuinely cannot ride a raw Responses
     item and are refused by name; a file is folded into the text as a path, so
     the action stays available and must actually carry it. */
  expect(action!.hasAttribute("disabled")).toBe(false);
  await settle(() => action!.click());
  await settle(() => {});

  expect(injections).toHaveLength(1);
  expect(injections[0]!.files).toMatchObject([{ name: "spec.md" }]);
  root.unmount();
});

test("an injection never carries images", async () => {
  const { host, root } = await mount();
  await type(host, "with a picture");
  await openSendMenu(host);
  const action = menuAction(host, "Add to context");
  expect(action!.hasAttribute("disabled")).toBe(false);
  await settle(() => action!.click());
  await settle(() => {});
  expect(injections).toHaveLength(1);
  expect(injections[0]!.images).toBeUndefined();
  root.unmount();
});

test("the composer reports a submission, not a placement it has not observed", async () => {
  turn = "running";
  holdInjection = true;
  const { host, root } = await mount();
  await type(host, "context please");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());

  /* WHILE THE REQUEST IS IN FLIGHT nothing may claim the text reached the
     thread. "Added to the running turn's input" is a statement about the
     engine, and at this moment the request has not even been answered. */
  const inFlight = host.textContent ?? "";
  expect(inFlight).toContain("Adding to context");
  expect(inFlight).not.toContain("Added to the running turn");

  await settle(() => releaseInjection?.());
  /* AND AFTER A SUCCESSFUL POST it says accepted, not delivered: the operation
     can still settle uncertain, because an empty engine acknowledgement proves
     nothing about the thread. The receipt carries the placement. */
  const settled = host.textContent ?? "";
  expect(settled).toContain("Accepted");
  expect(settled).not.toContain("Stored in the conversation context");
  root.unmount();
});

test("a refusal gives the draft back instead of reporting success", async () => {
  injectAnswer = { ok: false, status: 503, delivery: "refused", error: "structured delivery ownership is unavailable" };
  const { host, root } = await mount();
  await type(host, "give this back");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  await settle(() => {});

  expect(textarea(host).value).toBe("give this back");
  expect(host.textContent ?? "").toContain("structured delivery ownership is unavailable");
  root.unmount();
});

test("every send-menu action stays reachable: the menu scrolls instead of overflowing", async () => {
  turn = "running";
  const { host, root } = await mount();
  await type(host, "four actions now");
  await openSendMenu(host);

  const menu = host.ownerDocument.querySelector('[data-testid="composer-send-menu"]') as HTMLElement;
  expect(menu).toBeTruthy();
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  /* Queue, inject, steer and quick-ack: the most a Codex conversation offers. */
  expect(items.length).toBe(4);
  /* Bounded and scrollable, so the head of the list cannot be pushed past the
     top of a short viewport with no way to reach it. */
  expect(menu.style.maxHeight).toContain("100dvh");
  expect(menu.className).toContain("overflow-y-auto");
  root.unmount();
});

test("injection refuses a still-reading document without sending a reduced payload", async () => {
  const { host, root } = await mount();
  await type(host, "include the whole document");
  await stageFile(host, "reading.md", "content", false);
  await openSendMenu(host);
  const action = menuAction(host, "Add to context")!;
  await settle(() => action.click());
  expect(injections).toEqual([]);
  expect(textarea(host).value).toBe("include the whole document");
  root.unmount();
});

test("an accepted injection removes only its own documents and preserves later intake", async () => {
  holdInjection = true;
  const { host, root } = await mount();
  await type(host, "context");
  await stageFile(host, "first.md", "first");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  await stageFile(host, "later.md", "later");
  await settle(() => releaseInjection?.());
  expect(host.textContent).toContain("later.md");
  expect(host.textContent).not.toContain("first.md");
  expect(injections[0]!.files).toMatchObject([{ name: "first.md" }]);
  root.unmount();
});

/** Every request any path made that carried a document of this name. */
const carrying = (name: string) =>
  [...injections, ...sends, ...queueWrites].filter((request) =>
    Array.isArray(request.files) && (request.files as { name: string }[]).some((entry) => entry.name === name));

test("a document already on its way into the context cannot be submitted again while the request is pending", async () => {
  turn = "running";
  holdInjection = true;
  const { host, root } = await mount();
  await type(host, "read the notes");
  await stageFile(host, "design-notes.md", "# notes\n");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  expect(carrying("design-notes.md")).toHaveLength(1);

  /* The chip is still in the tray, so a second Add to context and an Enter
     both reach for it. Neither may carry it again: Codex does not deduplicate
     injections, and the Enter would interrupt the turn this action exists to
     leave alone. */
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  await type(host, "and answer me");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  expect(carrying("design-notes.md")).toHaveLength(1);
  expect(sends).toEqual([]);
  expect(queueWrites).toEqual([]);
  /* The refused Enter keeps what the operator typed. */
  expect(textarea(host).value).toBe("and answer me");

  await settle(() => releaseInjection?.());
  /* Accepted: the document left with the injection, so the fence lifts and
     the typed message sends on its own. */
  expect(host.textContent).not.toContain("design-notes.md");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  expect(sends).toHaveLength(1);
  expect(sends[0]!.files).toBeUndefined();
  expect(carrying("design-notes.md")).toHaveLength(1);
  root.unmount();
});

test.each([
  { ok: false, status: 503, delivery: "refused", error: "structured delivery ownership is unavailable" },
  { ok: false, status: 401, error: "sign in required" },
  { ok: false, status: 403, error: "origin refused" },
])("a refused injection leaves its document staged and sendable, beside documents added meanwhile: %j", async (answer) => {
  turn = "running";
  holdInjection = true;
  injectAnswer = answer;
  const { host, root } = await mount();
  await type(host, "read the notes");
  await stageFile(host, "design-notes.md", "# notes\n");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  await stageFile(host, "later.md", "later");

  await settle(() => releaseInjection?.());
  expect(textarea(host).value).toBe("read the notes");
  expect(readOutbox(CARD).filter((entry) => entry.intent === "context")).toEqual([]);
  expect(host.textContent ?? "").toContain(answer.error);
  expect(host.textContent).toContain("design-notes.md");
  expect(host.textContent).toContain("later.md");

  /* Nothing is held any more: the next send carries both documents, once. */
  await settleUntil(() => sends.length > 0, () => press(textarea(host), "Enter"));
  expect(sends).toHaveLength(1);
  expect((sends[0]!.files as { name: string }[]).map((entry) => entry.name)).toEqual(["design-notes.md", "later.md"]);
  expect(carrying("design-notes.md")).toHaveLength(2);
  root.unmount();
});

test.each([
  { ok: false, error: "network" },
  { ok: false, status: 503, delivery: "uncertain", error: "host connection lost" },
  { ok: false, status: 502 },
  { ok: false, status: 409, error: "idempotency-conflict" },
  { ok: false, status: 202, error: "receipt-identity-mismatch" },
  { ok: false, error: "network", reject: true },
])("an unanswered injection keeps its document under the original key: %j", async (answer) => {
  injectAnswer = answer;
  rejectInjection = "reject" in answer;
  const { host, root } = await mount();
  await type(host, "read the notes");
  await stageFile(host, "design-notes.md", "# notes\n");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  const key = String(injections[0]!.idempotencyKey);

  expect(textarea(host).value).toBe("");
  expect(host.textContent).toContain("design-notes.md");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  await type(host, "answer later");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => press(textarea(host), "Enter", { altKey: true }));
  expect(carrying("design-notes.md")).toHaveLength(1);
  expect(readOutbox(CARD).filter((entry) => entry.intent === "context")).toMatchObject([
    { id: key, deliveryUncertain: true },
  ]);
  await stageFile(host, "later.md", "later");

  // The journal's receipt settles that same operation, including its documents.
  durableReceipts = [{
    conversationId: CARD, idempotencyKey: key, operationId: "inject-observed",
    kind: "inject", status: "delivered", revision: 2,
    text: "read the notes", at: new Date().toISOString(),
  }];
  await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
  expect(host.textContent).not.toContain("design-notes.md");
  expect(host.textContent).toContain("later.md");
  expect(textarea(host).value).toBe("answer later");
  expect(readOutbox(CARD).find((entry) => entry.id === key)?.state).toBe("delivered");
  await settle(() => press(textarea(host), "Enter"));
  await settleUntil(() => sends.length > 0);
  expect(sends).toHaveLength(1);
  expect(sends[0]!.files).toMatchObject([{ name: "later.md" }]);
  expect(carrying("design-notes.md")).toHaveLength(1);
  root.unmount();
});

test.each([false, true])("an unanswered document remains fenced after remount (identity adopted: %j)", async (adopted) => {
  injectAnswer = { ok: false, error: "network" };
  if (adopted) observed = { conversationId: undefined };
  const first = await mount();
  await type(first.host, "read the notes");
  await stageFile(first.host, "design-notes.md", "# notes\n");
  await openSendMenu(first.host);
  await settle(() => menuAction(first.host, "Add to context")!.click());
  const key = String(injections[0]!.idempotencyKey);
  await settle(() => first.root.unmount());
  observed = { conversationId: CARD };
  const { host, root } = await mount();
  expect(host.textContent).toContain("design-notes.md");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  expect(carrying("design-notes.md")).toHaveLength(1);
  expect(readOutbox(CARD).filter((entry) => entry.intent === "context").map((entry) => entry.id)).toEqual([key]);
  durableReceipts = [{
    conversationId: CARD, idempotencyKey: key, operationId: "inject-observed",
    kind: "inject", status: "delivered", revision: 2,
    text: "read the notes", at: new Date().toISOString(),
  }];
  await settle(() => root.render(<TmuxComposer file={{ ...file, ...observed }} />));
  expect(host.textContent).not.toContain("design-notes.md");
  root.unmount();
});

test.each([
  { outcome: "refused", warm: false },
  { outcome: "accepted", warm: false },
  { outcome: "refused", warm: true },
  { outcome: "accepted", warm: true },
])("a pending injection releases its adopted document fence: %j", async ({ outcome, warm }) => {
  observed = { conversationId: warm ? CARD : undefined };
  holdInjection = true;
  const { host, root } = await mount();
  if (warm) {
    observed = { conversationId: undefined };
    await settle(() => root.render(<TmuxComposer file={{ ...file, ...observed }} />));
  }
  await type(host, "read the notes");
  await stageFile(host, "design-notes.md", "# notes\n");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  observed = { conversationId: CARD };
  await settle(() => root.render(<TmuxComposer file={{ ...file, ...observed }} />));
  expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).toContain(String(injections[0]!.idempotencyKey));
  await stageFile(host, "later.md", "later");
  injectAnswer = outcome === "refused"
    ? { ok: false, status: 503, delivery: "refused", error: "refused before admission" }
    : { ok: true, status: 202, operationId: "inject-accepted" };
  await settle(() => releaseInjection?.());
  expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).toBeNull();
  expect(host.textContent).toContain("later.md");
  if (outcome === "accepted") {
    expect(host.textContent).not.toContain("design-notes.md");
    expect(sessionStorage.getItem(`llvDraftFiles:${CARD}`)).not.toContain("design-notes.md");
  } else {
    expect(host.textContent).toContain("design-notes.md");
    expect(textarea(host).value).toBe("read the notes");
    expect(readOutbox(CARD).filter(entry => entry.intent === "context")).toEqual([]);
  }
  root.unmount();
});

/* #1652 × #1560: the queue hand-off and the durable save are the two
   submissions the attachment work added, and each can meet a pending Add to
   context. Neither may carry a document twice. */

test("Alt+Enter cannot hand Codex's queue a document that is on its way into the context", async () => {
  turn = "running";
  holdInjection = true;
  injectAnswer = { ok: false, status: 409, delivery: "refused", error: "the injection was refused" };
  const { host, root } = await mount();
  await type(host, "read the notes");
  await stageFile(host, "design-notes.md", "# notes\n");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  expect(carrying("design-notes.md")).toHaveLength(1);

  /* The chip is still in the tray while the injection is unanswered. The queue
     hand-off would take it along and clear it, so a refusal would find the
     document gone and an acceptance would find it queued a second time. */
  await type(host, "queue this for later");
  await settle(() => press(textarea(host), "Enter", { altKey: true }));
  await settle(() => {});
  expect(queueWrites).toEqual([]);
  expect(carrying("design-notes.md")).toHaveLength(1);
  expect(textarea(host).value).toBe("queue this for later");
  expect(host.textContent).toContain("design-notes.md");

  /* Refused: the document never left, so it is still staged and the fence
     lifts — the queue hand-off now carries it, once. */
  await settle(() => releaseInjection?.());
  expect(host.textContent).toContain("design-notes.md");
  await settleUntil(() => queueWrites.length > 0, () => press(textarea(host), "Enter", { altKey: true }));
  expect(queueWrites).toHaveLength(1);
  expect(queueWrites[0]!.files).toMatchObject([{ name: "design-notes.md" }]);
  expect(carrying("design-notes.md")).toHaveLength(2);
  root.unmount();
});

test("the send menu's Queue for Codex refuses a document an unanswered Add to context is carrying", async () => {
  turn = "running";
  holdInjection = true;
  const { host, root } = await mount();
  await type(host, "read the notes");
  await stageFile(host, "design-notes.md", "# notes\n");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());

  await type(host, "queue this for later");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Queue for Codex")!.click());
  await settle(() => {});
  expect(queueWrites).toEqual([]);
  expect(carrying("design-notes.md")).toHaveLength(1);
  expect(textarea(host).value).toBe("queue this for later");

  /* Accepted: the document left with the injection, and the queued words go
     on their own. */
  await settle(() => releaseInjection?.());
  expect(host.textContent).not.toContain("design-notes.md");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Queue for Codex")!.click());
  await settle(() => {});
  expect(queueWrites).toHaveLength(1);
  expect(queueWrites[0]!.files).toBeUndefined();
  expect(carrying("design-notes.md")).toHaveLength(1);
  root.unmount();
});

/** Holds every IndexedDB lock acquisition, which is where an ordinary send
    keeps its complete submission before the wire, until `release`. */
function holdComposerPayloadLocks(): { release: () => void; restore: () => void } {
  const navigator = globalThis.navigator as unknown as { locks: { request: (name: string, callback: (lock: unknown) => unknown) => Promise<unknown> } };
  const locks = navigator.locks;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (name: string, callback: (lock: unknown) => unknown) => gate.then(() => locks.request(name, callback)) },
  });
  return { release, restore: () => Object.defineProperty(navigator, "locks", { configurable: true, value: locks }) };
}

test("Add to context sends nothing while an ordinary send is still saving the same document", async () => {
  turn = "running";
  const held = holdComposerPayloadLocks();
  try {
    const { host, root } = await mount();
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    await settle(() => press(textarea(host), "Enter"));
    await settle(() => {});
    /* The save holds the draft and its document until it commits. */
    expect(composerSubmissionSaving(CARD)).toBe(true);
    expect(host.textContent).toContain("design-notes.md");
    expect(textarea(host).value).toBe("read the notes");

    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    await settle(() => {});
    expect(injections).toEqual([]);
    expect(textarea(host).value).toBe("read the notes");

    await settleUntil(() => sends.length > 0, held.release);
    expect(sends).toHaveLength(1);
    expect(injections).toEqual([]);
    expect(carrying("design-notes.md")).toHaveLength(1);
    root.unmount();
  } finally {
    held.restore();
  }
});

test("Add to context sends nothing while a large queue hand-off is still saving the same document", async () => {
  turn = "running";
  /* Large enough that the hand-off's envelope goes to IndexedDB, whose save
     begins with the authored digest. Holding the digest holds the save. */
  const body = "x".repeat(300_000);
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: (...args: Parameters<SubtleCrypto["digest"]>) => gate.then(() => digest(...args)),
  });
  try {
    const { host, root } = await mount();
    await type(host, "read the notes later");
    await stageFile(host, "large-notes.md", body);
    await settle(() => press(textarea(host), "Enter", { altKey: true }));
    await settle(() => {});
    expect(composerSubmissionSaving(CARD)).toBe(true);
    expect(host.textContent).toContain("large-notes.md");

    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    await settle(() => {});
    expect(injections).toEqual([]);
    expect(textarea(host).value).toBe("read the notes later");

    await settleUntil(() => queueWrites.length > 0, release);
    expect(queueWrites).toHaveLength(1);
    expect(injections).toEqual([]);
    expect(carrying("large-notes.md")).toHaveLength(1);
    root.unmount();
  } finally {
    delete (subtle as unknown as { digest?: unknown }).digest;
  }
});

/* #1689 review: the composer instance can move to another conversation while an
   Add to context is unanswered. Its answer belongs to the conversation that
   pressed it, and the one now on screen is left alone. */

const otherConversation = () => ({ ...file, ...observed, path: "/other.jsonl", conversationId: "conv-other" }) as FileEntry;

test("a refusal that lands after the composer moved to another conversation gives the words back to their own", async () => {
  turn = "running";
  holdInjection = true;
  injectAnswer = { ok: false, status: 409, delivery: "refused", error: "the injection was refused" };
  const first = await mount();
  await type(first.host, "context for the first conversation");
  await openSendMenu(first.host);
  await settle(() => menuAction(first.host, "Add to context")!.click());
  expect(injections).toHaveLength(1);

  await settle(() => first.root.render(<TmuxComposer file={otherConversation()} />));
  await settle(() => releaseInjection?.());
  expect(textarea(first.host).value).toBe("");
  expect(sessionStorage.getItem("llvDraft:conv-other")).toBeNull();
  expect(first.host.textContent).not.toContain("the injection was refused");
  first.root.unmount();

  /* Shown again, the first conversation has its words back. */
  const again = await mount();
  expect(textarea(again.host).value).toBe("context for the first conversation");
  again.root.unmount();
});

test("an acceptance that lands after the composer moved away takes its documents off the first conversation's tray", async () => {
  turn = "running";
  holdInjection = true;
  const first = await mount();
  await type(first.host, "read the notes");
  await stageFile(first.host, "design-notes.md", "# notes\n");
  await openSendMenu(first.host);
  await settle(() => menuAction(first.host, "Add to context")!.click());
  expect(sessionStorage.getItem(`llvDraftFiles:${CARD}`)).toContain("design-notes.md");

  await settle(() => first.root.render(<TmuxComposer file={otherConversation()} />));
  await settle(() => releaseInjection?.());
  expect(first.host.textContent).not.toContain("design-notes.md");
  first.root.unmount();

  /* The document went into the context: nothing asks for it to be attached again. */
  expect(sessionStorage.getItem(`llvDraftFiles:${CARD}`)).toBeNull();
  const again = await mount();
  expect(again.host.textContent).not.toContain("design-notes.md");
  expect(textarea(again.host).value).toBe("");
  again.root.unmount();
});


test("a context request that never reached the server returns its words and sendable document through the original key", async () => {
  rejectInjection = true;
  const { host, root } = await mount();
  try {
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    await type(host, "later words");
    admissionAnswer = { outcome: "not-executed" };
    await settle(() => messageRowRecovery(CARD)!.check(key));
    expect(admissionLookups).toEqual([{ conversationId: CARD, key }]);
    expect(textarea(host).value).toBe("later words\n\nread the notes");
    expect(host.textContent).toContain("design-notes.md");
    expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).toBeNull();
    expect(readOutbox(CARD).filter(entry => entry.intent === "context")).toEqual([]);
    expect(carrying("design-notes.md")).toHaveLength(1);
    await settleUntil(() => sends.length > 0, () => press(textarea(host), "Enter"));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.files).toMatchObject([{ name: "design-notes.md" }]);
  } finally { await act(async () => root.unmount()); }
});

test("a context admission lookup holds its documents until the original operation has a receipt", async () => {
  rejectInjection = true;
  const { host, root } = await mount();
  try {
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    admissionAnswer = { outcome: "admitted", operationId: "inject-found" };
    await settle(() => messageRowRecovery(CARD)!.check(key));
    expect(admissionLookups).toEqual([{ conversationId: CARD, key }]);
    expect(readOutbox(CARD)[0]).toMatchObject({ id: key, operationId: "inject-found", state: "delivering" });
    expect(readOutbox(CARD)[0]!.deliveryUncertain).toBeUndefined();
    expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).not.toBeNull();
    await type(host, "later words");
    await settle(() => press(textarea(host), "Enter"));
    expect(sends).toEqual([]);
    durableReceipts = [{ conversationId: CARD, idempotencyKey: key, operationId: "inject-found",
      kind: "inject", status: "delivered", revision: 2, at: new Date().toISOString() }];
    await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
    expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).toBeNull();
    expect(host.textContent).not.toContain("design-notes.md");
    await settleUntil(() => sends.length > 0, () => press(textarea(host), "Enter"));
    expect(sends[0]!.files).toBeUndefined();
    expect(carrying("design-notes.md")).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});

test("an unknown context lookup fences the same bytes after removal and reattachment, while allowing plain text", async () => {
  rejectInjection = true;
  const { host, root } = await mount();
  try {
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    await settle(() => messageRowRecovery(CARD)!.check(key));
    expect(admissionLookups).toEqual([{ conversationId: CARD, key }]);
    expect(readOutbox(CARD)[0]!.deliveryUncertain).toBe(true);
    await settle(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove design-notes.md"]')!.click());
    await type(host, "plain follow-up");
    await settleUntil(() => sends.length > 0, () => press(textarea(host), "Enter"));
    expect(sends[0]!.files).toBeUndefined();
    await stageFile(host, "renamed-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    await type(host, "with the same bytes");
    await settle(() => press(textarea(host), "Enter"));
    await settle(() => press(textarea(host), "Enter", { altKey: true }));
    expect(injections).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(queueWrites).toEqual([]);
    expect(textarea(host).value).toBe("with the same bytes");
  } finally { await act(async () => root.unmount()); }
});

test.each([undefined, "safe"])("a failed context receipt with resend=%j releases the same documents that Edit restores", async (resend) => {
  const { host, root } = await mount();
  try {
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    // Hold the request so the receipt carries the actual generated key.
    holdInjection = true;
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    const receipt = { conversationId: CARD, idempotencyKey: key, operationId: "inject-failed",
      kind: "inject", status: "failed", revision: 2, at: new Date().toISOString(), ...(resend ? { resend } : {}) };
    injectAnswer = { ok: false, status: 409, error: "failed", operationId: "inject-failed", receipt };
    durableReceipts = [receipt];
    await settle(() => releaseInjection?.());
    await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
    expect(readOutbox(CARD)[0]).toMatchObject({ state: "failed" });
    expect(readOutbox(CARD)[0]!.deliveryUncertain).toBeUndefined();
    expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).toBeNull();
    await settle(() => messageRowRecovery(CARD)!.editContext!(key));
    expect(textarea(host).value).toBe("read the notes");
    await settleUntil(() => sends.length > 0, () => press(textarea(host), "Enter"));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.files).toMatchObject([{ name: "design-notes.md" }]);
    expect(injections).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});

test("identity adoption merges document fences already owned by both identities", () => {
  sessionStorage.setItem("llvComposerOwner:/codex.jsonl", "provisional");
  sessionStorage.setItem("llvContextDocumentFences:provisional", JSON.stringify({ first: ["first-document"] }));
  sessionStorage.setItem(`llvContextDocumentFences:${CARD}`, JSON.stringify({ second: ["second-document"] }));
  adoptComposerState("/codex.jsonl", CARD);
  expect(JSON.parse(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)!)).toEqual({
    first: ["first-document"], second: ["second-document"],
  });
});


test.each(["identity", "conversation"])("a context lookup returning not-executed restores the owner after a %s change", async (change) => {
  rejectInjection = true;
  if (change === "identity") observed = { conversationId: undefined };
  const originalOwner = change === "identity" ? file.path : CARD;
  const { host, root } = await mount();
  try {
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    holdLookup = true;
    admissionAnswer = { outcome: "not-executed" };
    await settle(() => messageRowRecovery(originalOwner)!.check(key));
    expect(admissionLookups).toEqual([{ conversationId: CARD, key }]);
    if (change === "identity") {
      observed = {};
      await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
    } else {
      await settle(() => root.render(<TmuxComposer file={{ ...file, path: "/other.jsonl", conversationId: "conv-other" }} />));
    }
    await settle(() => releaseLookup?.());
    expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).toBeNull();
    expect(sessionStorage.getItem(`llvDraft:${CARD}`)).toBe("read the notes");
    expect(readOutbox(CARD).filter(entry => entry.intent === "context")).toEqual([]);
    if (change === "identity") expect(textarea(host).value).toBe("read the notes");
    else expect(textarea(host).value).toBe("");
    expect(injections).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});

test("a late delivered receipt consumes a reattached copy of the same document", async () => {
  rejectInjection = true;
  const { host, root } = await mount();
  try {
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    await settle(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove design-notes.md"]')!.click());
    await stageFile(host, "renamed-notes.md", "# notes\n");
    await stageFile(host, "different.md", "different bytes");
    durableReceipts = [{ conversationId: CARD, idempotencyKey: key, operationId: "inject-delivered",
      kind: "inject", status: "delivered", revision: 2, at: new Date().toISOString() }];
    await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
    expect(host.textContent).not.toContain("renamed-notes.md");
    expect(host.textContent).toContain("different.md");
    await type(host, "use the other document");
    await settleUntil(() => sends.length > 0, () => press(textarea(host), "Enter"));
    expect(sends[0]!.files).toMatchObject([{ name: "different.md" }]);
    expect(carrying("renamed-notes.md")).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});

test("a failed receipt requiring verification keeps its context row and document fenced", async () => {
  holdInjection = true;
  const { host, root } = await mount();
  try {
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    const receipt = { conversationId: CARD, idempotencyKey: key, operationId: "inject-unknown",
      kind: "inject", status: "failed", resend: "verify-first", revision: 2, at: new Date().toISOString() };
    injectAnswer = { ok: false, status: 409, operationId: "inject-unknown", receipt };
    durableReceipts = [receipt];
    await settle(() => releaseInjection?.());
    await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
    expect(readOutbox(CARD)[0]!.deliveryUncertain).toBe(true);
    await settle(() => messageRowRecovery(CARD)!.editContext!(key));
    expect(textarea(host).value).toBe("");
    expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).not.toBeNull();
    await type(host, "try again");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    expect(injections).toHaveLength(1);
    expect(host.textContent).not.toContain("Adding to context…");
  } finally { await act(async () => root.unmount()); }
});

test("a composer rereads a document fence released by another instance", async () => {
  rejectInjection = true;
  const first = await mount();
  let second: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    await type(first.host, "read the notes");
    await stageFile(first.host, "design-notes.md", "# notes\n");
    await openSendMenu(first.host);
    await settle(() => menuAction(first.host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    second = await mount();
    admissionAnswer = { outcome: "not-executed" };
    await settle(() => messageRowRecovery(CARD)!.check(key));
    expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).toBeNull();
    await type(first.host, "send the restored document");
    await settleUntil(() => sends.length > 0, () => press(textarea(first.host), "Enter"));
    expect(sends[0]!.files).toMatchObject([{ name: "design-notes.md" }]);
    expect(injections).toHaveLength(1);
  } finally {
    await act(async () => { first.root.unmount(); second?.root.unmount(); });
  }
});


test("a receipt arriving during a context lookup prevents a stale not-executed answer from restoring it", async () => {
  rejectInjection = true;
  const { host, root } = await mount();
  try {
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    holdLookup = true;
    admissionAnswer = { outcome: "not-executed" };
    await settle(() => messageRowRecovery(CARD)!.check(key));
    durableReceipts = [{ conversationId: CARD, idempotencyKey: key, operationId: "inject-observed",
      kind: "inject", status: "delivered", revision: 2, at: new Date().toISOString() }];
    await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
    await settle(() => releaseLookup?.());
    expect(textarea(host).value).toBe("");
    expect(host.textContent).not.toContain("design-notes.md");
    expect(readOutbox(CARD)[0]).toMatchObject({ state: "delivered" });
    expect(injections).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});

test("an admission lookup receipt for another key leaves the context unconfirmed", async () => {
  rejectInjection = true;
  const { host, root } = await mount();
  try {
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    const key = String(injections[0]!.idempotencyKey);
    admissionAnswer = { outcome: "admitted", operationId: "wrong-operation", receipt: {
      conversationId: CARD, idempotencyKey: "another-document", operationId: "wrong-operation",
      kind: "inject", status: "delivered", revision: 2, at: new Date().toISOString(),
    } };
    await settle(() => messageRowRecovery(CARD)!.check(key));
    expect(readOutbox(CARD)[0]!.deliveryUncertain).toBe(true);
    expect(host.textContent).toContain("design-notes.md");
    expect(sessionStorage.getItem(`llvContextDocumentFences:${CARD}`)).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});


test.each([false, true])("an unwritten document fence follows identity adoption (quota remains: %j)", async (quotaRemains) => {
  rejectInjection = true;
  observed = { conversationId: undefined };
  const { host, root } = await mount();
  const originalStorage = globalThis.sessionStorage;
  try {
    await type(host, "read the notes");
    await stageFile(host, "design-notes.md", "# notes\n");
    Object.assign(globalThis, { sessionStorage: {
      getItem: originalStorage.getItem.bind(originalStorage),
      removeItem: originalStorage.removeItem.bind(originalStorage),
      setItem: (key: string, value: string) => {
        if (key.startsWith("llvContextDocumentFences:")) throw new Error("storage quota exceeded");
        originalStorage.setItem(key, value);
      },
    } });
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    expect(sessionStorage.getItem(`llvContextDocumentFences:${file.path}`)).toBeNull();
    if (!quotaRemains) Object.assign(globalThis, { sessionStorage: originalStorage });
    observed = {};
    await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
    await settle(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove design-notes.md"]')!.click());
    await stageFile(host, "renamed-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    expect(injections).toHaveLength(1);
    Object.assign(globalThis, { sessionStorage: originalStorage });
    const key = String(injections[0]!.idempotencyKey);
    durableReceipts = [{ conversationId: CARD, idempotencyKey: key, operationId: "inject-observed",
      kind: "inject", status: "delivered", revision: 2, at: new Date().toISOString() }];
    await settle(() => root.render(<TmuxComposer file={{ ...file }} />));
    expect(host.textContent).not.toContain("renamed-notes.md");
  } finally {
    Object.assign(globalThis, { sessionStorage: originalStorage });
    await act(async () => root.unmount());
  }
});

test("a proven context refusal preserves words typed while the answer was pending", async () => {
  holdInjection = true;
  injectAnswer = { ok: false, status: 409, delivery: "refused", error: "refused before admission" };
  const { host, root } = await mount();
  try {
    await type(host, "original words");
    await stageFile(host, "design-notes.md", "# notes\n");
    await openSendMenu(host);
    await settle(() => menuAction(host, "Add to context")!.click());
    await type(host, "later words");
    await settle(() => releaseInjection?.());
    expect(textarea(host).value).toBe("later words\n\noriginal words");
    expect(readOutbox(CARD).filter(entry => entry.intent === "context")).toEqual([]);
    expect(host.textContent).toContain("design-notes.md");
    await settleUntil(() => sends.length > 0, () => press(textarea(host), "Enter"));
    expect(sends[0]!.text).toBe("later words\n\noriginal words");
  } finally { await act(async () => root.unmount()); }
});
