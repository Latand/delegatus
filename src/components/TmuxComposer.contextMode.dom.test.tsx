import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";
import { setRuntimeBusForTests, setRuntimeUiEnabledForTests, type RuntimeBus, type RuntimeBusState } from "@/hooks/runtimeBus";
import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";
import type { NativeQueueDependencies } from "@/hooks/useNativeQueue";
import type { NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";
import type { RuntimeSessionView } from "@/hooks/useRuntime";

import { agentCapabilitiesFromViews } from "./useAgentCapabilities";
import { TmuxComposer } from "./TmuxComposer";
import { CONTEXT_AUTO_STORAGE_KEY, CONTEXT_EXIT_AFTER_MS } from "./composerContextMode";
import { withComposerSubmission } from "@/lib/composerSubmissionPayloads";
import { resetRetainedQueueAdmissionsForTests } from "./retainedQueueAdmissions";
import { readOutbox, resetOutboxForTests } from "./conversation/outbox";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";

/**
 * Context mode, driven through the real composer (docs/design/composer-context-mode.md).
 * Auto is on here, the shipped default: the first turn reading a mount sees is
 * adopted with no delay, so a conversation that mounts running shows context
 * mode without a timer. The one-shot action and the ordinary submissions are
 * covered by TmuxComposer.inject, which pins auto off.
 */

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
  URL: dom.URL,
});
let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile, media: query, addEventListener() {}, removeEventListener() {},
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
let engine: "codex" | "claude" = "codex";
let releaseInjection: (() => void) | null = null;

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
      sessionKey: { engine, sessionId: "thread-1" },
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
  releaseInjection = null;
  engine = "codex";
  mobile = false;
  setRuntimeUiEnabledForTests(false);
  setTmuxComposerRuntimeDependenciesForTests({
    nativeQueue: queueTransport,
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


const toggle = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-composer-context-toggle]");
const modeOf = (host: HTMLElement) =>
  host.querySelector("[data-testid=composer-input-unit] > div")!.getAttribute("data-composer-mode");
const sendButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Add to the agent's context") || button.getAttribute("aria-label") === "Send to the agent");

/** The Send control: the composer's one submit button, reaching the form's own
    handler the way a click does. */
async function clickSend(host: HTMLElement): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>("button[type=submit]");
  if (!button) throw new Error("the composer rendered no submit control");
  await settle(() => button.click());
}

async function rerender(root: Root): Promise<void> {
  await act(async () => {
    root.render(<TmuxComposer file={{ ...file, ...observed }} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const contextRows = () => readOutbox(CARD).filter((entry) => entry.intent === "context");

test("the toggle is offered on a Codex conversation that can inject, off while idle and on while a turn runs", async () => {
  const idle = await mount();
  expect(toggle(idle.host)).not.toBeNull();
  expect(toggle(idle.host)!.getAttribute("aria-pressed")).toBe("false");
  expect(toggle(idle.host)!.hasAttribute("aria-disabled")).toBe(false);
  expect(modeOf(idle.host)).toBeNull();
  idle.root.unmount();
  document.body.replaceChildren();

  turn = "running";
  const running = await mount();
  expect(toggle(running.host)!.getAttribute("aria-pressed")).toBe("true");
  expect(toggle(running.host)!.getAttribute("data-composer-context-toggle")).toBe("on");
  running.root.unmount();
});

test("a host without injection shows the toggle disabled and never enters context by itself", async () => {
  injectCapable = false;
  turn = "running";
  const { host, root } = await mount();
  expect(toggle(host)).not.toBeNull();
  expect(toggle(host)!.getAttribute("aria-disabled")).toBe("true");
  expect(toggle(host)!.getAttribute("aria-pressed")).toBe("false");
  expect(modeOf(host)).toBeNull();
  /* A tap says why, as text, and changes nothing. */
  await settle(() => toggle(host)!.click());
  expect(toggle(host)!.getAttribute("aria-pressed")).toBe("false");
  expect(host.textContent).toContain(translate("en", "inject.unsupported"));
  await type(host, "an ordinary message");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  expect(sends).toHaveLength(1);
  expect(injections).toEqual([]);
  root.unmount();
});

test("a Claude conversation has no toggle and no announcement region", async () => {
  engine = "claude";
  turn = "running";
  observed = { engine: "claude", fmt: "claude" } as Partial<FileEntry>;
  const { host, root } = await mount();
  expect(toggle(host)).toBeNull();
  expect(host.querySelector("[data-testid=composer-context-announcement]")).toBeNull();
  root.unmount();
});

test("in context mode the box, the input and the send control carry the state", async () => {
  turn = "running";
  const { host, root } = await mount();
  expect(modeOf(host)).toBe("context");
  expect(textarea(host).getAttribute("placeholder")).toContain("add to the agent's context");
  expect(sendButton(host)).toBeDefined();
  expect(host.querySelector("[data-testid=composer-context-announcement]")).not.toBeNull();
  root.unmount();
});

test("in Ukrainian the state reads in the operator's language", async () => {
  setLocale("uk");
  turn = "running";
  const { host, root } = await mount();
  const placeholder = textarea(host).getAttribute("placeholder")!;
  expect(placeholder).not.toContain("add to the agent's context");
  expect(placeholder.length).toBeGreaterThan(3);
  root.unmount();
});

test("Enter in context mode posts only to the injection endpoint and files a delivering row before the answer", async () => {
  turn = "running";
  holdInjection = true;
  const { host, root } = await mount();
  await type(host, "the schema lives in db/schema.sql");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});

  expect(injections).toHaveLength(1);
  expect(injections[0]).toMatchObject({ conversationId: CARD, text: "the schema lives in db/schema.sql" });
  expect(sends).toEqual([]);
  expect(queueWrites).toEqual([]);
  expect(textarea(host).value).toBe("");
  const rows = contextRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "delivering", intent: "context", contextTurn: "running", text: "the schema lives in db/schema.sql" });

  await settle(() => releaseInjection?.());
  await settle(() => {});
  expect(contextRows()).toHaveLength(1);
  expect(contextRows()[0]!.operationId).toBe("inject-1");
  expect(sends).toEqual([]);
  root.unmount();
});

test("the Send control injects too, and stays off the send and queue paths", async () => {
  turn = "running";
  const { host, root } = await mount();
  await type(host, "one more constraint");
  await clickSend(host);
  await settle(() => {});
  expect(injections).toHaveLength(1);
  expect(sends).toEqual([]);
  expect(queueWrites).toEqual([]);
  root.unmount();
});

test("Alt+Enter still hands the draft to Codex's own queue in context mode", async () => {
  turn = "running";
  const { host, root } = await mount();
  await type(host, "do this after");
  await settle(() => press(textarea(host), "Enter", { altKey: true }));
  await settle(() => {});
  expect(queueWrites).toHaveLength(1);
  expect(injections).toEqual([]);
  root.unmount();
});

test("a manual press turns context off and Enter then sends a normal message", async () => {
  turn = "running";
  const { host, root } = await mount();
  await settle(() => toggle(host)!.click());
  expect(toggle(host)!.getAttribute("aria-pressed")).toBe("false");
  expect(modeOf(host)).toBeNull();
  await type(host, "stop and do this instead");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  expect(sends).toHaveLength(1);
  expect(injections).toEqual([]);
  root.unmount();
});

test("a refusal withdraws the row and gives the draft back", async () => {
  turn = "running";
  injectAnswer = { ok: false, status: 409, error: "attention" };
  const { host, root } = await mount();
  await type(host, "words that must survive");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  expect(injections).toHaveLength(1);
  expect(contextRows()).toEqual([]);
  expect(textarea(host).value).toBe("words that must survive");
  root.unmount();
});

test("a lost answer keeps the row unconfirmed and does not hand the draft back", async () => {
  turn = "running";
  injectAnswer = { ok: false, status: 0, error: "network" };
  const { host, root } = await mount();
  await type(host, "maybe arrived");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  const rows = contextRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.deliveryUncertain).toBe(true);
  expect(textarea(host).value).toBe("");
  /* A second press has nothing to send, so no second insertion can follow. */
  await settle(() => press(textarea(host), "Enter"));
  expect(injections).toHaveLength(1);
  root.unmount();
});

test("losing the capability while context is shown blocks Enter with the reason and keeps the draft", async () => {
  turn = "running";
  const { host, root } = await mount();
  expect(modeOf(host)).toBe("context");
  await type(host, "held back");
  injectCapable = false;
  await rerender(root);
  /* The mode on screen stays, and a shown mode can always be left. */
  expect(modeOf(host)).toBe("context");
  expect(toggle(host)!.hasAttribute("aria-disabled")).toBe(false);
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  expect(injections).toEqual([]);
  expect(sends).toEqual([]);
  expect(queueWrites).toEqual([]);
  expect(textarea(host).value).toBe("held back");
  expect(host.textContent).toContain("cannot add context now");
  root.unmount();
});

test("the dispatcher never sends a context row, held, answered or reloaded", async () => {
  turn = "running";
  holdInjection = true;
  const { host, root } = await mount();
  await type(host, "context only");
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  await settle(() => releaseInjection?.());
  await settle(() => {});
  root.unmount();
  document.body.replaceChildren();

  /* A reload: the in-memory queue is gone, the persisted row is read back. */
  resetOutboxForTests();
  turn = "idle";
  const again = await mount();
  await settle(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sends).toEqual([]);
  expect(queueWrites).toEqual([]);
  expect(injections).toHaveLength(1);
  for (const row of contextRows()) expect(row.state === "queued").toBe(false);
  again.root.unmount();
});

test("the send menu carries the auto setting as a checkbox, and unchecking it keeps the mode where it is", async () => {
  turn = "running";
  const { host, root } = await mount();
  await openSendMenu(host);
  const item = menuAction(host, "Switch with the agent's turn")!;
  expect(item).toBeDefined();
  expect(item.getAttribute("role")).toBe("menuitemcheckbox");
  expect(item.getAttribute("aria-checked")).toBe("true");

  await settle(() => item.click());
  expect(localStorage.getItem(CONTEXT_AUTO_STORAGE_KEY)).toBe("0");
  expect(menuAction(host, "Switch with the agent's turn")!.getAttribute("aria-checked")).toBe("false");
  /* What is displayed stays put, and the toggle no longer claims to follow the agent. */
  expect(modeOf(host)).toBe("context");
  expect(toggle(host)!.textContent).not.toContain("auto");
  root.unmount();
});

test("a Ukrainian composer names the toggle and its state in Ukrainian", async () => {
  setLocale("uk");
  turn = "running";
  const { host, root } = await mount();
  expect(toggle(host)!.getAttribute("aria-label")).toBe(translate("uk", "composer.context.toggleAria"));
  expect(host.textContent).toContain(translate("uk", "composer.context.toggle"));
  root.unmount();
});

test("a submission being saved holds the mode across a debounced turn boundary, then the flip lands", async () => {
  turn = "running";
  const { host, root } = await mount();
  expect(modeOf(host)).toBe("context");

  let releaseSave!: () => void;
  const saving = withComposerSubmission(CARD, () => new Promise<void>((resolve) => { releaseSave = resolve; }));
  turn = "idle";
  await rerender(root);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, CONTEXT_EXIT_AFTER_MS + 100)); });
  await rerender(root);
  expect(toggle(host)!.getAttribute("data-composer-context-toggle")).toBe("on");
  expect(modeOf(host)).toBe("context");

  releaseSave();
  await saving;
  await rerender(root);
  expect(toggle(host)!.getAttribute("data-composer-context-toggle")).not.toBe("on");
  expect(modeOf(host)).toBeNull();
  root.unmount();
});

/* A bus whose connection the test drives. One frozen state per connection:
   `useSyncExternalStore` compares snapshots by identity. */
const offlineState: RuntimeBusState = {
  enabled: true,
  structuredHostsEnabled: true,
  connection: "offline" satisfies ConnectionState,
  resyncedAt: null,
  lastEventAt: null,
  store: emptyStore(),
};
const offlineBus: RuntimeBus = {
  getState: () => offlineState,
  subscribe: () => () => {},
  subscribeFilesRevision: () => () => {},
  start: () => {},
  stop: () => {},
  refresh: async () => true,
};

test("with the runtime offline, context mode refuses before anything is filed and keeps the draft", async () => {
  turn = "running";
  mobile = true;
  setRuntimeBusForTests(offlineBus);
  const fetches: string[] = [];
  const { host, root } = await mount();
  const mountFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    fetches.push(String(input));
    return mountFetch(input as never);
  }) as unknown as typeof fetch;
  expect(modeOf(host)).toBe("context");
  await type(host, "words that must stay");

  /* The phone's slot is not Queue: nothing here waits for a reconnect. */
  const slot = host.querySelector<HTMLButtonElement>("[data-mobile2-send]")!;
  expect(slot.getAttribute("data-mobile2-send")).toBe("send");
  expect(slot.textContent).not.toContain("Queue");
  /* The offline placeholder wins over the context one, in its context wording. */
  expect(textarea(host).getAttribute("placeholder")).toContain("offline");
  expect(textarea(host).getAttribute("placeholder")).not.toContain("delivered on reconnect");
  /* The reason is on screen before any press. */
  expect(host.querySelector("[data-testid=composer-send-blocked]")?.textContent).toContain("runtime is offline");

  await settle(() => press(textarea(host), "Enter"));
  await clickSend(host);
  await settle(() => {});
  expect(injections).toEqual([]);
  expect(sends).toEqual([]);
  expect(queueWrites).toEqual([]);
  expect(fetches.filter((url) => url.startsWith("/api/runtime/"))).toEqual([]);
  expect(contextRows()).toEqual([]);
  expect(textarea(host).value).toBe("words that must stay");
  expect(host.textContent).toContain("runtime is offline");
  root.unmount();
  setRuntimeBusForTests(null);
});
