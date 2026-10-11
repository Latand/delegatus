/**
 * The composer's own row (operator, 2026-10-11, task c1f9173a): the agent's
 * buttons and the conversation's state move out of the rows above the input
 * field, so the transcript keeps its 60%.
 *
 * - Nothing is drawn above the field at rest; «⋯ More actions» ends the
 *   bottom row with Interrupt, Compact, Re-check and the terminal command,
 *   which says it copies a command.
 * - Stop is its own button beside Send while the agent works, so Send stays
 *   Send and a message typed meanwhile still queues behind the turn.
 * - Three failed sends are one chip in that row; the list waits behind it,
 *   opens above the field, and «Retry failed» skips the send whose delivery
 *   is unconfirmed.
 * - The phone keeps its controls and gets one row above the field for the
 *   chip, which the open list replaces.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act, useSyncExternalStore } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { installTmuxComposerRuntimeForTests, resetTmuxComposerRuntimeForTests } from "@/test-helpers/tmuxComposerRuntime";

const dom = new Window({ width: 1440, height: 900 });
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Element: dom.Element,
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
/* The composer keeps each submission in IndexedDB before the wire (#1647):
   the process-local store the other composer suites use. */
const composerStorage = installComposerStorageForTests();
afterAll(() => composerStorage.uninstall());
let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile, media: query, addEventListener() {}, removeEventListener() {},
});

const listeners = new Set<() => void>();
let busReceipts: RuntimeReceipt[] = [];
let runtimeView: RuntimeSessionView | null = null;
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

import { resetOutboxForTests } from "./conversation/outbox";
import { RuntimeComposerReceipts, TmuxComposer } from "./TmuxComposer";

const realFetch = globalThis.fetch;
let requests: { url: string; body: unknown }[] = [];

beforeEach(() => {
  installTmuxComposerRuntimeForTests({
    useRuntimeView: () => useSyncExternalStore(subscribe, () => runtimeView, () => runtimeView),
    useRuntimeReceipts: () => useSyncExternalStore(subscribe, () => busReceipts, () => busReceipts),
  });
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  resetTmuxComposerRuntimeForTests();
  setLocale("en");
  mobile = false;
  globalThis.fetch = realFetch;
  busReceipts = [];
  runtimeView = null;
  notify();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

const CONVERSATION = "conv-row";

const receipt = (overrides: Partial<RuntimeReceipt> & { operationId: string }): RuntimeReceipt => ({
  idempotencyKey: `key-${overrides.operationId}`,
  conversationId: CONVERSATION,
  kind: "send",
  status: "delivered",
  text: "message",
  at: new Date().toISOString(),
  revision: 1,
  ...overrides,
});

/* Two settled failures and one send whose arrival nobody can confirm. */
const THREE_UNDELIVERED = [
  receipt({ operationId: "failed-one", status: "failed", reason: "dead-host", text: "first words", at: "2026-10-11T10:00:00.000Z" }),
  receipt({ operationId: "failed-two", status: "failed", reason: "dead-host", text: "second words", at: "2026-10-11T10:01:00.000Z" }),
  receipt({ operationId: "unconfirmed", status: "uncertain", text: "third words", at: "2026-10-11T10:02:00.000Z" }),
];

function view(working: boolean): RuntimeSessionView {
  return {
    session: {
      conversationId: CONVERSATION,
      sessionKey: { engine: "codex", sessionId: CONVERSATION },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: working ? "running" : "idle",
      provenance: "structured",
      revision: 1,
      attentionIds: [],
      recentReceipts: busReceipts,
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath: "/codex-row.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: working ? "turn-1" : null,
      liveTurn: working ? { turnId: "turn-1", text: "" } : null,
    },
    uiState: working ? "working" : "idle",
    attentions: [],
    receipts: busReceipts,
    legacy: false,
    structuredControlsEnabled: true,
  };
}

const file = (working: boolean): FileEntry => ({
  path: "/codex-row.jsonl", root: "codex-sessions", name: "codex-row.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
  size: 1, activity: working ? "live" : "idle", proc: "running", pid: null, conversationId: CONVERSATION,
  pendingQuestion: null, waitingInput: null,
} as FileEntry);

async function mount({ working = false, receipts = [] as RuntimeReceipt[] } = {}): Promise<{ host: HTMLElement; root: Root }> {
  busReceipts = receipts;
  runtimeView = view(working);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={file(working)} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  /* The row's places are published on the first commit; let them settle. */
  await settle(() => {});
  return { host, root };
}

const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** Hidden by its own attribute or by an ancestor's. */
const isHidden = (element: Element | null) => Boolean(element?.closest("[hidden]"));

const rowControls = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-composer-row-controls]");

async function openMore(host: HTMLElement): Promise<HTMLElement> {
  const more = rowControls(host)!.querySelector<HTMLButtonElement>("[data-composer-more-actions]")!;
  await settle(() => more.click());
  return document.querySelector<HTMLElement>('[data-testid="composer-more-actions-menu"]')!;
}

const menuLabels = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? "");

test("at rest nothing is drawn above the field: the agent's controls end the composer's bottom row", async () => {
  const { host, root } = await mount();
  try {
    /* No region above the input, no strip, no eye chip. */
    const region = host.querySelector('[data-testid="composer-accessories"]');
    expect(region === null || isHidden(region)).toBe(true);
    expect(host.querySelector("[data-selected-context]")).toBeNull();
    const row = rowControls(host);
    expect(row).not.toBeNull();
    /* The group keeps the strip's readable capability. */
    const group = row!.querySelector("[data-agent-control-strip]");
    expect(group?.getAttribute("data-strip-layout")).toBe("composer");
    expect(group?.getAttribute("data-strip-surface")).toBe("structured");
    expect(row!.querySelector("[data-composer-more-actions]")?.getAttribute("aria-label")).toBe(translate("en", "strip.moreActions"));
    /* Stop is there only while the agent works. */
    expect(host.querySelector("[data-composer-interrupt]")).toBeNull();
  } finally {
    flushSync(() => root.unmount());
  }
});

test("while the agent works Stop is its own button beside Send, and Send stays Send", async () => {
  const { host, root } = await mount({ working: true });
  try {
    const stop = host.querySelector<HTMLButtonElement>("[data-composer-interrupt]");
    expect(stop).not.toBeNull();
    expect(stop!.getAttribute("aria-label")).toBe(translate("en", "composer.interruptAria"));
    /* Beside Send, in the field's own controls, not in a row of its own. */
    const send = host.querySelector<HTMLButtonElement>("button[type=submit]")!;
    expect(stop!.closest("span.relative")!.nextElementSibling!.contains(send)).toBe(true);
    expect(rowControls(host)!.contains(stop)).toBe(false);

    /* A typed message still has Send, and Stop stays beside it. */
    const textarea = host.querySelector("textarea")!;
    const props = Object.entries(textarea).find(([key]) => key.startsWith("__reactProps"))![1] as { onChange: (event: unknown) => void };
    await settle(() => props.onChange({ target: { value: "queue this" }, currentTarget: { value: "queue this" } }));
    expect(host.querySelector("button[type=submit]")?.getAttribute("aria-label")).toBe(send.getAttribute("aria-label"));
    expect(host.querySelector("[data-composer-interrupt]")).not.toBeNull();

    /* And it interrupts this conversation. */
    await settle(() => host.querySelector<HTMLButtonElement>("[data-composer-interrupt]")!.click());
    expect(requests.some((request) => request.url.includes("interrupt") || JSON.stringify(request.body ?? "").includes("interrupt"))).toBe(true);
  } finally {
    flushSync(() => root.unmount());
  }
});

test("«⋯ More actions» holds Interrupt, Compact, Re-check and the terminal command, named for what it does (uk)", async () => {
  setLocale("uk");
  const { host, root } = await mount({ working: true });
  try {
    const menu = await openMore(host);
    expect(menu).not.toBeNull();
    const labels = menuLabels(menu);
    expect(labels.some((label) => label.includes("Перервати хід"))).toBe(true);
    expect(labels.some((label) => label.includes("Стиснути контекст"))).toBe(true);
    expect(labels.some((label) => label.includes("Перевірити хост"))).toBe(true);
    const terminal = labels.find((label) => label.includes("Скопіювати команду для терміналу"));
    expect(terminal).toBeDefined();
    expect(terminal).toContain(translate("uk", "attach.copyTerminalCommandHint"));
    expect(menu.textContent).not.toContain("Підключитися");
    /* The interrupt in the menu is the same action as the button. */
    expect(labels.findIndex((label) => label.includes("Перервати хід"))).toBe(0);
  } finally {
    flushSync(() => root.unmount());
  }
});

test("the terminal action copies a command and says so, in both locales", () => {
  expect(translate("en", "attach.copyTerminalCommand")).toBe("Copy terminal command");
  expect(translate("uk", "attach.copyTerminalCommand")).toBe("Скопіювати команду для терміналу");
  for (const locale of ["en", "uk"] as const) {
    expect(translate(locale, "attach.copyTerminalCommandHint").length).toBeGreaterThan(0);
    expect(translate(locale, "attach.dialogTitle")).not.toMatch(/Attach|Підключитися/);
  }
});

test("three failed sends are one chip in the bottom row; the list waits behind it and opens above the field", async () => {
  const { host, root } = await mount({ receipts: THREE_UNDELIVERED });
  try {
    const chip = rowControls(host)!.querySelector<HTMLButtonElement>("[data-receipts-chip]");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain(translate("en", "runtime.receipt.chip", { count: 3 }));
    expect(chip!.getAttribute("aria-expanded")).toBe("false");
    /* Nothing above the field: the list and the region it would take are hidden. */
    const stack = host.querySelector("[data-runtime-receipt-stack]")!;
    expect(isHidden(stack)).toBe(true);
    expect(isHidden(host.querySelector('[data-testid="composer-accessories"]'))).toBe(true);
    /* The status line still announces, from beside the chip. */
    const status = host.querySelector("[data-runtime-receipt-status]")!;
    expect(isHidden(status)).toBe(false);
    expect(rowControls(host)!.contains(status)).toBe(true);

    await settle(() => chip!.click());
    expect(chip!.getAttribute("aria-expanded")).toBe("true");
    expect(isHidden(stack)).toBe(false);
    expect(stack.hasAttribute("open")).toBe(true);
    expect(isHidden(host.querySelector('[data-testid="composer-accessories"]'))).toBe(false);
    /* Above the field: the region comes before the input unit in the form. */
    const unit = host.querySelector('[data-testid="composer-input-unit"]')!;
    expect(stack.compareDocumentPosition(unit) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stack.querySelector("[data-receipts-retry-failed]")?.textContent).toBe(translate("en", "bulk.retryFailed", { count: 2 }));

    /* The chip closes it again, and the list goes back behind it. */
    await settle(() => chip!.click());
    expect(isHidden(stack)).toBe(true);
  } finally {
    flushSync(() => root.unmount());
  }
});

test("«Retry failed» sends the settled failures again and skips the send whose delivery is unconfirmed", async () => {
  const retried: string[] = [];
  const mountNode = document.createElement("span");
  document.body.append(mountNode);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={THREE_UNDELIVERED}
      onRetry={(receipt) => retried.push(receipt.operationId)}
      onEdit={() => {}}
      onDiscard={() => {}}
      chipMount={mountNode}
    />,
  ));
  try {
    await settle(() => mountNode.querySelector<HTMLButtonElement>("[data-receipts-chip]")!.click());
    const retryAll = host.querySelector<HTMLButtonElement>("[data-receipts-retry-failed]")!;
    expect(retryAll.textContent).toBe(translate("en", "bulk.retryFailed", { count: 2 }));
    await settle(() => retryAll.click());
    /* Oldest first, the order they were typed. */
    expect(retried).toEqual(["failed-one", "failed-two"]);
    /* The unconfirmed send keeps its own Check delivery and Discard. */
    const unconfirmed = host.querySelector('[data-operation="unconfirmed"]');
    expect(unconfirmed?.querySelector("[data-receipt-discard]")).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
  }
});

test("«Retry failed» in the composer sends one retry at a time, oldest first, and holds the composer busy until the last answers", async () => {
  /* The newest failure first in the list, so the order is the composer's own. */
  const failures = [
    receipt({ operationId: "failed-late", status: "failed", reason: "dead-host", text: "typed second", at: "2026-10-11T10:05:00.000Z" }),
    receipt({ operationId: "failed-early", status: "failed", reason: "dead-host", text: "typed first", at: "2026-10-11T10:00:00.000Z" }),
    receipt({ operationId: "unconfirmed", status: "uncertain", text: "third words", at: "2026-10-11T10:06:00.000Z" }),
  ];
  const posted: string[] = [];
  const answers: (() => void)[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const match = /\/api\/runtime\/operations\/([^/?]+)$/.exec(url);
    if (!match || init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    const operationId = decodeURIComponent(match[1]!);
    posted.push(operationId);
    const original = failures.find((candidate) => candidate.operationId === operationId)!;
    await new Promise<void>((resolve) => answers.push(resolve));
    return { ok: true, status: 200, json: async () => ({ operationId, receipt: { ...original, status: "queued", revision: 2 } }) } as Response;
  }) as typeof fetch;
  const { host, root } = await mount({ receipts: failures });
  try {
    await settle(() => rowControls(host)!.querySelector<HTMLButtonElement>("[data-receipts-chip]")!.click());
    const retryAll = host.querySelector<HTMLButtonElement>("[data-receipts-retry-failed]")!;
    expect(retryAll.textContent).toBe(translate("en", "bulk.retryFailed", { count: 2 }));
    await settle(() => retryAll.click());
    /* The oldest goes first, and nothing else is on the wire until it answers. */
    expect(posted).toEqual(["failed-early"]);
    /* The later message's own Retry waits for the run. */
    const lateRetry = () => [...host.querySelectorAll<HTMLButtonElement>('[data-runtime-receipt-stack] [data-operation="failed-late"] button')]
      .find((button) => button.textContent === translate("en", "runtime.receipt.retry"));
    expect(lateRetry()?.disabled).toBe(true);
    await settle(() => answers.shift()!());
    expect(posted).toEqual(["failed-early", "failed-late"]);
    /* Still busy between the first answer and the last. */
    expect(host.querySelector<HTMLButtonElement>('[data-runtime-receipt-stack] [data-operation="failed-early"] [data-receipt-uncertain-retry]')?.disabled).toBe(true);
    await settle(() => answers.shift()!());
    /* The send whose delivery is unconfirmed is never retried. */
    expect(posted).toEqual(["failed-early", "failed-late"]);
    expect(answers).toHaveLength(0);
  } finally {
    flushSync(() => root.unmount());
  }
});

test("«Retry failed» stops at a refused retry, so a later message never goes ahead of an earlier one", async () => {
  const failures = [
    receipt({ operationId: "failed-early", status: "failed", reason: "dead-host", text: "typed first", at: "2026-10-11T10:00:00.000Z" }),
    receipt({ operationId: "failed-late", status: "failed", reason: "dead-host", text: "typed second", at: "2026-10-11T10:05:00.000Z" }),
  ];
  const posted: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const match = /\/api\/runtime\/operations\/([^/?]+)$/.exec(String(input));
    if (!match || init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    posted.push(decodeURIComponent(match[1]!));
    return { ok: false, status: 409, json: async () => ({ error: "refused" }) } as Response;
  }) as typeof fetch;
  const { host, root } = await mount({ receipts: failures });
  try {
    await settle(() => rowControls(host)!.querySelector<HTMLButtonElement>("[data-receipts-chip]")!.click());
    await settle(() => host.querySelector<HTMLButtonElement>("[data-receipts-retry-failed]")!.click());
    expect(posted).toEqual(["failed-early"]);
    expect(host.textContent).toContain(translate("en", "composer.deliveryRetryFailed"));
  } finally {
    flushSync(() => root.unmount());
  }
});

test("phone: the chip shares one row above the field, and the open list takes that row's place", async () => {
  mobile = true;
  setLocale("uk");
  const { host, root } = await mount({ receipts: THREE_UNDELIVERED });
  try {
    const line = host.querySelector<HTMLElement>("[data-composer-status-line]")!;
    expect(line).not.toBeNull();
    /* Inside the composer's own unit, above the field. */
    const unit = host.querySelector('[data-testid="composer-input-unit"]')!;
    expect(unit.firstElementChild).toBe(line);
    const chip = line.querySelector<HTMLButtonElement>("[data-receipts-chip]")!;
    expect(chip.textContent).toContain("Не доставлено: 3");
    /* The phone has no desktop bottom row and no separate Stop. */
    expect(rowControls(host)).toBeNull();
    expect(host.querySelector("[data-composer-interrupt]")).toBeNull();

    await settle(() => chip.click());
    expect(line.hidden).toBe(true);
    const stack = host.querySelector("[data-runtime-receipt-stack]")!;
    expect(isHidden(stack)).toBe(false);
    expect(stack.querySelector("[data-receipts-retry-failed]")?.textContent).toBe("Повторити невдалі (2)");
  } finally {
    flushSync(() => root.unmount());
  }
});
