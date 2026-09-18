/**
 * A send the server refused reads as refused, in the mounted composer (#1593).
 *
 * The operator's report: a message and its image ended under "Delivery outcome
 * is unknown / Automatic checking has stopped", with only a Re-check button,
 * for a send the route had turned away before anything was enqueued — no
 * journal row, no operation id, nothing on any wire. Nothing could ever settle
 * that bubble, and the bubble carried no control at all.
 *
 * Driven through the production composer: the real submit path, the real serial
 * dispatcher, the real outbox state. The wire answers what the route now
 * answers, and these cases read what the operator would see.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { useRuntimeReceiptsForArtifact, type RuntimeSessionView } from "@/hooks/useRuntime";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";
import { attachModeFor, capabilitiesFor } from "./agentCapabilities";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";
import { useAgentCapabilities } from "./useAgentCapabilities";

const dom = new Window();
installActEnv();
class ImmediateFileReader {
  result: string | null = null;
  error: null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  readAsDataURL(file: File): void {
    const mime = file.type || "image/png";
    this.result = `data:${mime};base64,${Buffer.from(file.name).toString("base64")}`;
    queueMicrotask(() => this.onload?.());
  }
}
Object.assign(globalThis, {
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  File: dom.File,
  FileReader: ImmediateFileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const structuredView: RuntimeSessionView = {
  session: {
    conversationId: "conv-refused",
    hostKind: "codex-app-server",
    host: "hosted",
    capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: true, perTurnModel: false } },
    recentReceipts: [],
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

import { LogFeed } from "./LogFeed";
import { setLogFeedDependenciesForTests } from "./logFeedDependencies";
import { TmuxComposer } from "./TmuxComposer";
import { enqueueOutbox, readOutbox, resetOutboxForTests, updateOutbox } from "./conversation/outbox";

const realFetch = globalThis.fetch;
const composerStorage = installComposerStorageForTests();
afterAll(() => composerStorage.uninstall());

beforeEach(() => {
  setLogFeedDependenciesForTests({ useLogTail: () => ({ lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null, paused: false, setPaused() {}, clear() {}, hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0 }) });
  setRuntimeUiEnabledForTests(false);
  setTmuxComposerRuntimeDependenciesForTests({
    useAgentCapabilities: (candidate) => {
      const real = useAgentCapabilities(candidate);
      if (candidate.path !== "/codex-refused.jsonl" && candidate.conversationId !== "conv-refused") return real;
      const options = { runtimeEnabled: true };
      return {
        caps: capabilitiesFor(candidate, structuredView, options),
        runtime: structuredView,
        structuredSession: structuredView,
        runtimeEnabled: true,
        attachMode: attachModeFor(candidate, structuredView, options),
      };
    },
    useRuntimeReceiptsForArtifact: (path, conversationId) => useRuntimeReceiptsForArtifact(path, conversationId),
  });
});

afterEach(() => {
  composerStorage.reset();
  setLogFeedDependenciesForTests(null);
  setTmuxComposerRuntimeDependenciesForTests(null);
  setRuntimeUiEnabledForTests(null);
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

const file: FileEntry = {
  path: "/codex-refused.jsonl", root: "codex-sessions", name: "codex-refused.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
  size: 1, activity: "idle", proc: "running", pid: null, conversationId: "conv-refused",
  model: "gpt-5.6-sol", effort: "high", fast: false, pendingQuestion: null, waitingInput: null,
} as FileEntry;

const cardId = file.conversationId!;
/** One of the route's five pre-enqueue refusals, verbatim. */
const REASON = "structured delivery ownership is unavailable for this conversation";

interface SendBody { idempotencyKey: string; text: string; images?: unknown[] }

/** Wire mock whose response is held until the returned `release` is called, so
    a case can put words in the composer while the request is still in flight. */
function gatedWire(sends: SendBody[], body: unknown, status = 503): () => void {
  let open = false;
  const waiters: Array<() => void> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: { body?: string }) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    if (url !== "/api/runtime/send") throw new Error(`unexpected request: ${url}`);
    sends.push(JSON.parse(init?.body ?? "{}") as SendBody);
    if (!open) await new Promise<void>((resolve) => waiters.push(resolve));
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as typeof fetch;
  return () => { open = true; for (const waiter of waiters.splice(0)) waiter(); };
}

async function renderInto(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    for (let turn = 0; turn < 8; turn += 1) await new Promise((r) => setTimeout(r, 1));
  });
};

function composerControls(host: HTMLElement) {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const type = (value: string) =>
    (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!
      .onChange({ target: { value } });
  const submit = () => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  return { type, submit };
}

const pasteImage = async (host: HTMLElement, tag: string) => {
  const textarea = host.querySelector("textarea")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const textareaProps = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  await settle(() => textareaProps.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([new TextEncoder().encode(`png-${tag}`)], `${tag}.png`, { type: "image/png" }) }] },
    preventDefault() {},
  }));
  for (let attempt = 0; attempt < 50 && host.querySelectorAll("img").length !== 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(host.querySelectorAll("img")).toHaveLength(1);
};

const surface = () => <><LogFeed file={file} showSvc={false} lineFilter="" onStatus={() => {}} paused={false} follow={false} setFollow={() => {}} /><TmuxComposer file={file} /></>;

test("a refused send puts its text and its image back in the composer and parks nothing", async () => {
  const sends: SendBody[] = [];
  const release = gatedWire(sends, { error: REASON, delivery: "refused" });
  const mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type("check the release status"));
    await pasteImage(mounted.host, "refused-image");
    await settle(() => composerControls(mounted.host).submit());
    expect(sends).toHaveLength(1);
    await settle(release);
    /* Not sent: nothing parked, nothing left in the queue, and the bubble is
       gone because the message is back where the operator can edit it. */
    expect(readOutbox(cardId)).toEqual([]);
    expect(mounted.host.querySelector("[data-outbox-entry]")).toBeNull();
    expect(mounted.host.querySelector('[data-outbox-wait="uncertain"]')).toBeNull();
    expect(mounted.host.querySelector("textarea")?.value).toBe("check the release status");
    expect(mounted.host.querySelectorAll("img")).toHaveLength(1);
    expect(mounted.host.querySelector('[data-testid="composer-status"]')?.textContent).toBe(REASON);
    /* ONE message, ONE place. An attachment-bearing send keeps a durable saved
       copy, and leaving it beside the returned draft would put the same
       message in two independently sendable places: sending the saved copy
       would deliver these words again and take the restored image out of the
       tray without saying so. The copy went with the bubble. */
    expect(mounted.host.querySelector(`[data-payload-key="${sends[0]!.idempotencyKey}"]`)).toBeNull();
    expect(mounted.host.querySelector("[data-payload-retry]")).toBeNull();
    expect(mounted.host.querySelector('[data-testid="composer-payload-recovery"]')).toBeNull();
    /* No second attempt: a refusal is not a retry loop. */
    expect(sends).toHaveLength(1);
  } finally { await act(async () => mounted.root.unmount()); }
});

test("the returned draft is still sendable — ending the saved copy does not fence its next attempt", async () => {
  const sends: SendBody[] = [];
  const release = gatedWire(sends, { error: REASON, delivery: "refused" });
  const mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type("resend me"));
    await pasteImage(mounted.host, "resent-image");
    await settle(() => composerControls(mounted.host).submit());
    await settle(release);
    expect(mounted.host.querySelector("textarea")?.value).toBe("resend me");
    /* The copy was discarded under the refused attempt's key. A queued
       submission mints a fresh key, so the tombstone cannot fence the retry —
       and if it could, the payload store would refuse to retain the bytes and
       this second send would never leave the composer. */
    globalThis.fetch = (async (input: string | URL | Request, init?: { body?: string }) => {
      const url = String(input);
      if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
      if (url !== "/api/runtime/send") throw new Error(`unexpected request: ${url}`);
      const body = JSON.parse(init?.body ?? "{}") as SendBody;
      sends.push(body);
      return { ok: true, status: 202, json: async () => ({
        ok: true,
        operationId: "operation-accepted",
        receipt: { operationId: "operation-accepted", idempotencyKey: body.idempotencyKey,
          conversationId: cardId, kind: "send", status: "queued", at: "2026-09-18T00:00:00.000Z", revision: 1 },
      }) } as Response;
    }) as typeof fetch;
    await settle(() => composerControls(mounted.host).submit());
    expect(sends).toHaveLength(2);
    expect(sends[1]!.idempotencyKey).not.toBe(sends[0]!.idempotencyKey);
    expect(sends[1]!.text).toContain("resend me");
    expect(sends[1]!.images).toHaveLength(1);
    expect(mounted.host.querySelector('[data-testid="composer-status"]')?.textContent).not.toBe(REASON);
  } finally { await act(async () => mounted.root.unmount()); }
});

test("a refusal answered after newer words keeps the bubble AND the saved copy, so the message is still in one place", async () => {
  const sends: SendBody[] = [];
  const release = gatedWire(sends, { error: REASON, delivery: "refused" });
  const mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type("the release notes with the screenshot"));
    await pasteImage(mounted.host, "kept-image");
    await settle(() => composerControls(mounted.host).submit());
    await settle(() => composerControls(mounted.host).type("words typed while it was in flight"));
    await settle(release);
    /* The draft could not come back — newer words hold the composer — so the
       bubble owns the message and its saved copy is the only thing that still
       carries the image. Discarding it here would lose the attachment. */
    const entry = readOutbox(cardId)[0];
    expect(entry?.state).toBe("failed");
    expect(entry?.error).toBe(REASON);
    expect(mounted.host.querySelector(`[data-payload-key="${sends[0]!.idempotencyKey}"]`)).not.toBeNull();
    expect(mounted.host.querySelector("[data-payload-retry]")).not.toBeNull();
    expect(mounted.host.querySelector("textarea")?.value).toBe("words typed while it was in flight");
  } finally { await act(async () => mounted.root.unmount()); }
});

test("an uncertain send keeps its saved copy, and that copy offers no retry", async () => {
  const sends: SendBody[] = [];
  const release = gatedWire(sends, { error: "host write failed", delivery: "uncertain" });
  const mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type("a message whose fate nobody knows"));
    await pasteImage(mounted.host, "uncertain-image");
    await settle(() => composerControls(mounted.host).submit());
    await settle(release);
    /* Untouched: the command may be on the wire, so the copy stays and
       nothing here offers to send it a second time. */
    expect(readOutbox(cardId)[0]?.deliveryUncertain).toBe(true);
    expect(mounted.host.querySelector(`[data-payload-key="${sends[0]!.idempotencyKey}"]`)).not.toBeNull();
    expect(mounted.host.querySelector("[data-payload-retry]")).toBeNull();
    expect(mounted.host.querySelector("[data-payload-discard]")).toBeNull();
  } finally { await act(async () => mounted.root.unmount()); }
});

test("a refusal answered after the operator started the next message keeps the bubble as a failure with its reason", async () => {
  const sends: SendBody[] = [];
  const release = gatedWire(sends, { error: REASON, delivery: "refused" });
  const mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type("first message"));
    await settle(() => composerControls(mounted.host).submit());
    expect(sends).toHaveLength(1);
    await settle(() => composerControls(mounted.host).type("words typed while it was in flight"));
    await settle(release);
    const entry = readOutbox(cardId)[0];
    expect(entry?.text).toBe("first message");
    expect(entry?.state).toBe("failed");
    expect(entry?.error).toBe(REASON);
    /* Never parked, so the bubble carries the ordinary retry and cancel. */
    expect(entry?.deliveryUncertain).toBeUndefined();
    const bubble = mounted.host.querySelector("[data-outbox-entry]")!;
    expect(bubble.textContent).toContain(REASON);
    expect(bubble.querySelector("[data-outbox-retry]")).not.toBeNull();
    expect(bubble.querySelector("[data-outbox-cancel]")).not.toBeNull();
    expect(bubble.querySelector("[data-outbox-clear]")).toBeNull();
    /* The newer words are untouched. */
    expect(mounted.host.querySelector("textarea")?.value).toBe("words typed while it was in flight");
  } finally { await act(async () => mounted.root.unmount()); }
});

test.each([
  ["a bodiless 503", {}],
  ["the route's own uncertain 503", { error: "host write failed", delivery: "uncertain" }],
])("%s still parks the message as unknown, exactly as before", async (_name, body) => {
  const sends: SendBody[] = [];
  const release = gatedWire(sends, body);
  const mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type("a genuinely uncertain message"));
    await settle(() => composerControls(mounted.host).submit());
    await settle(release);
    const entry = readOutbox(cardId)[0];
    expect(entry?.deliveryUncertain).toBe(true);
    expect(entry?.text).toBe("a genuinely uncertain message");
    const bubble = mounted.host.querySelector("[data-outbox-entry]")!;
    expect(bubble.getAttribute("data-outbox-wait")).toBe("uncertain");
    expect(bubble.querySelector("[data-outbox-retry], [data-outbox-cancel]")).toBeNull();
    /* The text stays with the bubble: the message may be on its way. */
    expect(mounted.host.querySelector("textarea")?.value).toBe("");
  } finally { await act(async () => mounted.root.unmount()); }
});

test("an already parked bubble that holds no operation id can be taken back to the composer", async () => {
  const sends: SendBody[] = [];
  gatedWire(sends, {});
  enqueueOutbox(cardId, { id: "key-parked", text: "the message nobody can settle", images: 0, at: Date.now() });
  updateOutbox(cardId, "key-parked", { state: "delivering", deliveryUncertain: true });
  const mounted = await renderInto(surface());
  try {
    const clear = mounted.host.querySelector<HTMLButtonElement>("[data-outbox-clear]")!;
    expect(clear).not.toBeNull();
    expect(clear.getAttribute("aria-label")).toBe(translate("en", "outbox.clearParked"));
    await settle(() => clear.click());
    expect(readOutbox(cardId)).toEqual([]);
    expect(mounted.host.querySelector("[data-outbox-entry]")).toBeNull();
    expect(mounted.host.querySelector("textarea")?.value).toBe("the message nobody can settle");
    /* Taking it back sends nothing. */
    expect(sends).toEqual([]);
  } finally { await act(async () => mounted.root.unmount()); }
});

test("a parked bubble an operation CAN address keeps its recovery controls and offers no clearing", async () => {
  const sends: SendBody[] = [];
  gatedWire(sends, {});
  enqueueOutbox(cardId, { id: "key-admitted", text: "admitted and unsettled", images: 0, at: Date.now() });
  updateOutbox(cardId, "key-admitted", { state: "delivering", deliveryUncertain: true, operationId: "operation-admitted" });
  const mounted = await renderInto(surface());
  try {
    const bubble = mounted.host.querySelector("[data-outbox-entry]")!;
    expect(bubble.querySelector("[data-outbox-clear], [data-outbox-retry], [data-outbox-cancel]")).toBeNull();
    expect(readOutbox(cardId)[0]?.operationId).toBe("operation-admitted");
  } finally { await act(async () => mounted.root.unmount()); }
});
