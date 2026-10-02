import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";

import { appendComposerDraft, TmuxComposer } from "./TmuxComposer";
import { publishSeatProject, seatDeputiesFor, resetSeatDeputiesForTests } from "./orchestrator/seatDeputies";
import { installTmuxComposerRuntimeForTests, resetTmuxComposerRuntimeForTests } from "@/test-helpers/tmuxComposerRuntime";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { addTaskChip, readTaskChips, resetTaskChipsForTests, reloadTaskChipsForTests } from "./orchestrator/taskChips";
import { setComposerAdmissionTimingForTests } from "./composerAdmissionDeadline";
import { composerSubmissionPayloads } from "@/lib/composerSubmissionPayloads";
import { translate } from "@/lib/i18n";
import { enqueueOutbox, readOutbox, resetOutboxForTests, updateOutbox } from "./conversation/outbox";
import { useOutboxRowActions } from "./conversation/OutboxBubbles";
import { messageRowModel } from "./conversation/messageRow";

/* Drive the production composer through its keyboard action. A stale busy
   hint must defer to the server's idle refusal and preserve the same draft
   through the ordinary delivery's admission or failure. */

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

const realFetch = globalThis.fetch;
const storage = installComposerStorageForTests();
afterAll(() => storage.uninstall());

beforeEach(() => {
  storage.reset();
  setRuntimeUiEnabledForTests(false);
});

afterEach(() => {
  setRuntimeUiEnabledForTests(null);
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
  resetSeatDeputiesForTests();
  resetTaskChipsForTests();
  resetTmuxComposerRuntimeForTests();
  setComposerAdmissionTimingForTests(null);
});

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
    await new Promise((r) => setTimeout(r, 0));
  });
};

const file = {
  path: "/codex.jsonl",
  root: "codex-sessions",
  name: "codex.jsonl",
  project: "viewer",
  title: "Codex",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "idle",
  proc: "running",
  pid: null,
  conversationId: "conv-queuefirst",
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry;


function parallel(host: HTMLElement) {
  const textarea = host.querySelector("textarea")!;
  const key = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onKeyDown(event: unknown): void }>)[key]!;
  props.onKeyDown({ key: "Enter", shiftKey: true, ctrlKey: true, metaKey: false, altKey: false,
    nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() {} });
}

function RetryParallelFallback({ entryId }: { entryId: string }) {
  const actions = useOutboxRowActions("conv-queuefirst", readOutbox("conv-queuefirst"));
  return <button data-retry-fallback onClick={() => actions.onRetry(entryId)}>Retry</button>;
}

for (const locale of ["en", "uk"] as const) for (const failure of [null, "wire", "ghost"] as const) {
  test(`parallel fallback keeps the draft until accepted (${locale}, ${failure})`, async () => {
    setLocale(locale);
    publishSeatProject("conv-queuefirst", "viewer");
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let settleWire: (value: Response) => void = () => {};
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
      if (url === "/api/orchestrator/ghost") {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: false, code: failure === "ghost" ? "deputy_limit" : "seat_not_busy", error: "refused" }, { status: 409 });
      }
      if (url === "/api/tmux" && init?.method === "POST") {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return await new Promise<Response>((resolve) => { settleWire = resolve; });
      }
      if (url.startsWith("/api/orchestrator/seat")) return Response.json({ seat: null });
      return Response.json({ targets: {}, operations: [], receipts: [] });
    }) as typeof fetch;
    const { host, root } = await renderInto(<TmuxComposer file={file} />);
    try {
      await settle(() => appendComposerDraft("conv-queuefirst", "keep this ask"));
      await settle(() => parallel(host));
      for (let i = 0; i < 60 && failure !== "ghost" && calls.length < 2; i++) await settle(() => {});
      expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("keep this ask");
      expect(calls[0]?.body).toMatchObject({ text: "keep this ask", seatConversationId: "conv-queuefirst" });
      if (failure === "ghost") {
        expect(calls).toHaveLength(1);
        expect(readOutbox("conv-queuefirst")).toHaveLength(0);
        return;
      }
      expect(calls).toHaveLength(2);
      await settle(() => {
        const form = host.querySelector("form")!;
        form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
        parallel(host);
      });
      expect(readOutbox("conv-queuefirst")).toHaveLength(1);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.body.text).toBe("keep this ask");
      await settle(() => settleWire(Response.json(failure === "wire" ? { ok: false, error: "refused" } : { ok: true })));
      await settle(() => {});
      expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(failure ? "keep this ask" : "");
      if (!failure) expect(host.textContent).toContain(translate(locale, "composer.parallelSentDirectly"));
    } finally { await act(async () => root.unmount()); }
  });
}

test("parallel retry keeps a refused fallback on its original key through remount", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  const ghosts: Record<string, unknown>[] = [];
  const wires: Record<string, unknown>[] = [];
  const answers: ((response: Response) => void)[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") {
      ghosts.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 });
    }
    if (url === "/api/tmux" && init?.method === "POST") {
      wires.push(JSON.parse(String(init.body)));
      return await new Promise<Response>((resolve) => { answers.push(resolve); });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const first = await renderInto(<TmuxComposer file={file} />);
  let firstUnmounted = false;
  try {
    await settle(() => appendComposerDraft("conv-queuefirst", "one logical ask"));
    await settle(() => parallel(first.host));
    for (let i = 0; i < 60 && wires.length < 1; i++) await settle(() => {});
    expect(wires).toHaveLength(1);
    const key = wires[0]?.idempotencyKey;
    await settle(() => answers[0]!(Response.json({ ok: false, error: "refused before admission" }, { status: 400 })));
    for (let i = 0; i < 30 && readOutbox("conv-queuefirst")[0]?.state !== "failed"; i++) await settle(() => {});
    const failed = readOutbox("conv-queuefirst")[0]!;
    expect((await composerSubmissionPayloads.restore({ conversationId: "conv-queuefirst", key: failed.id }))?.retry).toBe("resend");

    // The seat now reports busy, but this authored generation still belongs
    // to its failed row and must retry that envelope.
    await settle(() => parallel(first.host));
    for (let i = 0; i < 60 && wires.length < 2; i++) await settle(() => {});
    expect(ghosts).toHaveLength(1);
    expect(wires).toHaveLength(2);
    expect(wires[1]).toMatchObject({ idempotencyKey: key, text: "one logical ask" });
    await settle(() => answers[1]!(Response.json({ ok: true })));
    for (let i = 0; i < 60 && readOutbox("conv-queuefirst")[0]?.state !== "delivered"; i++) await settle(() => {});
    expect(readOutbox("conv-queuefirst")[0]?.state).toBe("delivered");
    await act(async () => first.root.unmount());
    firstUnmounted = true;

    // A remounted row keeps its original key and cannot replay an admitted ask.
    const remounted = await renderInto(<><TmuxComposer file={file} /><RetryParallelFallback entryId={failed.id} /></>);
    try {
      await settle(() => remounted.host.querySelector<HTMLButtonElement>("[data-retry-fallback]")!.click());
      expect(readOutbox("conv-queuefirst")).toHaveLength(1);
      expect(readOutbox("conv-queuefirst")[0]?.state).toBe("delivered");
      expect(wires).toHaveLength(2);
      expect(ghosts).toHaveLength(1);
    } finally { await act(async () => remounted.root.unmount()); }
  } finally { if (!firstUnmounted) await act(async () => first.root.unmount()); }
});

test("legacy idle fallback records refusals so Send and row Retry reuse its sealed key", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  const wires: Record<string, unknown>[] = [];
  const answers: ((response: Response) => void)[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 });
    if (url === "/api/tmux" && init?.method === "POST") {
      wires.push(JSON.parse(String(init.body)));
      return await new Promise<Response>((resolve) => { answers.push(resolve); });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const rendered = await renderInto(<TmuxComposer file={file} />);
  try {
    const textarea = rendered.host.querySelector("textarea")!;
    const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
    const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
    await settle(() => appendComposerDraft("conv-queuefirst", "legacy ask with image"));
    await settle(() => props.onPaste({ clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([new Uint8Array([1, 2, 3])], "ask.png", { type: "image/png" }) }] }, preventDefault() {} }));
    for (let i = 0; i < 10; i++) await settle(() => {});
    await settle(() => parallel(rendered.host));
    for (let i = 0; i < 60 && wires.length < 1; i++) await settle(() => {});
    expect(wires[0]?.images).toHaveLength(1);
    const key = wires[0]?.idempotencyKey;
    await settle(() => answers[0]!(Response.json({ ok: false, error: "refused before admission" }, { status: 400 })));
    for (let i = 0; i < 30 && readOutbox("conv-queuefirst")[0]?.state !== "failed"; i++) await settle(() => {});
    const entry = readOutbox("conv-queuefirst")[0]!;
    expect((await composerSubmissionPayloads.restore({ conversationId: "conv-queuefirst", key: entry.id }))?.retry).toBe("resend");
    expect((rendered.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("legacy ask with image");
    expect(rendered.host.querySelectorAll("img")).toHaveLength(1);

    await settle(() => rendered.host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    for (let i = 0; i < 60 && wires.length < 2; i++) await settle(() => {});
    expect(wires).toHaveLength(2);
    expect(wires[1]?.idempotencyKey).toBe(key);
    await settle(() => answers[1]!(Response.json({ ok: false, error: "still refused" }, { status: 400 })));
    for (let i = 0; i < 30 && readOutbox("conv-queuefirst")[0]?.state !== "failed"; i++) await settle(() => {});

    await settle(() => rendered.root.render(<><TmuxComposer file={file} /><RetryParallelFallback entryId={entry.id} /></>));
    await settle(() => rendered.host.querySelector<HTMLButtonElement>("[data-retry-fallback]")!.click());
    for (let i = 0; i < 60 && wires.length < 3; i++) await settle(() => {});
    expect(wires).toHaveLength(3);
    expect(wires[2]).toMatchObject({ idempotencyKey: key, text: "legacy ask with image" });
    expect(wires[2]?.images).toHaveLength(1);
    await settle(() => answers[2]!(Response.json({ ok: true })));
    for (let i = 0; i < 60 && readOutbox("conv-queuefirst")[0]?.state !== "delivered"; i++) await settle(() => {});
    expect((rendered.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(rendered.host.querySelectorAll("img")).toHaveLength(0);
    expect(readOutbox("conv-queuefirst")[0]?.state).toBe("delivered");
  } finally { await act(async () => rendered.root.unmount()); }
});


test("late idle fallback delivers to the original conversation after a card switch", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerGhost: (response: Response) => void = () => {};
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return await new Promise<Response>((resolve) => { answerGhost = resolve; });
    if (url === "/api/tmux" && init?.method === "POST") {
      wires.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  try {
    await settle(() => appendComposerDraft("conv-queuefirst", "original ask"));
    await settle(() => parallel(host));
    await settle(() => root.render(<TmuxComposer file={{ ...file, path: "/another.jsonl", conversationId: "other-card" }} />));
    await settle(() => appendComposerDraft("other-card", "other draft"));
    await settle(() => answerGhost(Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 })));
    for (let i = 0; i < 60 && !wires.length; i++) await settle(() => {});
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({ text: "original ask", path: file.path });
    for (let i = 0; i < 60 && sessionStorage.getItem("llvDraft:conv-queuefirst") !== null; i++) await settle(() => {});
    expect(sessionStorage.getItem("llvDraft:conv-queuefirst")).toBeNull();
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("other draft");
    expect(readOutbox("other-card")).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});

test("fallback survives a composer remount and consumes the retained draft once admitted", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let settleWire: (response: Response) => void = () => {};
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 });
    if (url === "/api/tmux" && init?.method === "POST") return await new Promise<Response>((resolve) => { settleWire = resolve; });
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  addTaskChip("viewer", { id: "t1", title: "First" });
  addTaskChip("viewer", { id: "t2", title: "Second" });
  const first = await renderInto(<TmuxComposer file={file} taskChipsFor="viewer" />);
  await settle(() => appendComposerDraft("conv-queuefirst", "retained ask"));
  await settle(() => parallel(first.host));
  for (let i = 0; i < 60 && !readOutbox("conv-queuefirst")[0]?.dispatchedAt; i++) await settle(() => {});
  expect(readOutbox("conv-queuefirst")[0]?.idleParallelDraft).toBe("retained ask");
  await act(async () => first.root.unmount());
  reloadTaskChipsForTests();
  addTaskChip("viewer", { id: "t2", title: "Second" });
  const second = await renderInto(<TmuxComposer file={file} taskChipsFor="viewer" />);
  try {
    expect((second.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("retained ask");
    await settle(() => settleWire(Response.json({ ok: true })));
    for (let i = 0; i < 10; i++) await settle(() => {});
    expect((second.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(readTaskChips("viewer")).toEqual([{ id: "t2", title: "Second" }]);
    expect(second.host.textContent).toContain(translate("en", "composer.parallelSentDirectly"));
  } finally { await act(async () => second.root.unmount()); }
});


test("a stale running structured view falls back through the ordinary runtime send with the same text", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  installTmuxComposerRuntimeForTests({ useRuntimeView: () => ({
    session: { conversationId: "conv-queuefirst", sessionKey: { engine: "claude", sessionId: "seat-session" },
      hostKind: "claude-broker", host: "hosted", turn: "running", accountId: null, capabilities: { imageInput: { supported: true } }, recentReceipts: [] },
    uiState: {}, attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true,
  }) as unknown as RuntimeSessionView });
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: false });
    if (url === "/api/orchestrator/ghost") return Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 });
    if (url === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body)); wires.push(body);
      return Response.json({ ok: true, operationId: "direct-ask", receipt: {
        conversationId: "conv-queuefirst", idempotencyKey: body.idempotencyKey, operationId: "direct-ask",
        kind: "send", status: "delivered", revision: 1, at: new Date().toISOString(), text: body.text,
      } });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  try {
    await settle(() => appendComposerDraft("conv-queuefirst", "structured ask"));
    await settle(() => parallel(host));
    for (let i = 0; i < 60 && !wires.length; i++) await settle(() => {});
    for (let i = 0; i < 60 && (host.querySelector("textarea") as HTMLTextAreaElement).value; i++) await settle(() => {});
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({ text: "structured ask", conversationId: "conv-queuefirst", policy: "interrupt-active" });
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(host.textContent).toContain(translate("en", "composer.parallelSentDirectly"));
  } finally { await act(async () => root.unmount()); }
});


for (const failFirst of [false, true]) test(`image-only fallback preserves its generation (${failFirst})`, async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerWire: (response: Response) => void = () => {};
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: false });
    if (url === "/api/orchestrator/ghost") return Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 });
    if (url === "/api/tmux" && init?.method === "POST") {
      wires.push(JSON.parse(String(init.body)));
      return await new Promise<Response>((resolve) => { answerWire = resolve; });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  try {
    const textarea = host.querySelector("textarea")!;
    const key = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
    const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[key]!;
    await settle(() => props.onPaste({ clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([new Uint8Array([1, 2, 3])], "ask.png", { type: "image/png" }) }] }, preventDefault() {} }));
    for (let i = 0; i < 10; i++) await settle(() => {});
    expect(host.querySelectorAll("img")).toHaveLength(1);
    await settle(() => parallel(host));
    for (let i = 0; i < 60 && !wires.length; i++) await settle(() => {});
    expect(wires).toHaveLength(1);
    expect(wires[0]?.images).toHaveLength(1);
    await settle(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    expect(readOutbox("conv-queuefirst")).toHaveLength(1);
    await settle(() => answerWire(Response.json(failFirst ? { ok: false, error: "refused" } : { ok: true }, { status: failFirst ? 400 : 200 })));
    for (let i = 0; i < 20; i++) await settle(() => {});
    if (failFirst) {
      expect(host.querySelectorAll("img")).toHaveLength(1);
      await settle(() => appendComposerDraft("conv-queuefirst", "new image question"));
      await settle(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      for (let i = 0; i < 60 && wires.length < 2; i++) await settle(() => {});
      expect(wires).toHaveLength(2);
      expect(wires[1]?.text).toBe("new image question");
      expect(wires[1]?.idempotencyKey).not.toBe(wires[0]?.idempotencyKey);
      await settle(() => answerWire(Response.json({ ok: true })));
      for (let i = 0; i < 20; i++) await settle(() => {});
    }
    expect(host.querySelectorAll("img")).toHaveLength(0);
    if (!failFirst) expect(host.textContent).toContain(translate("en", "composer.parallelSentDirectly"));
  } finally { await act(async () => root.unmount()); }
});


for (const mode of ["legacy-pending", "runtime-refused", "legacy-delivered", "legacy-late"] as const) {
  test(`offscreen fallback honors ordinary delivery evidence (${mode})`, async () => {
    publishSeatProject("conv-queuefirst", "viewer");
    if (mode === "legacy-late") setComposerAdmissionTimingForTests({ admissionDeadlineMs: 10, receiptReconciliationMs: 30, receiptPollIntervalMs: 1 });
    let answerLate: (response: Response) => void = () => {};
    if (mode === "runtime-refused") installTmuxComposerRuntimeForTests({ useRuntimeView: (candidate) => candidate.conversationId !== "conv-queuefirst" ? null : ({
      session: { conversationId: "conv-queuefirst", sessionKey: { engine: "claude", sessionId: "seat-session" }, hostKind: "claude-broker", host: "hosted", turn: "running", accountId: null,
        capabilities: { imageInput: { supported: true } }, recentReceipts: [] },
      uiState: {}, attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true,
    }) as unknown as RuntimeSessionView });
    let answerGhost: (response: Response) => void = () => {};
    const wires: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
      if (url === "/api/orchestrator/ghost") return await new Promise<Response>((resolve) => { answerGhost = resolve; });
      if ((url === "/api/tmux" || url === "/api/runtime/send") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); wires.push(body);
        if (mode === "legacy-delivered") return Response.json({ ok: true });
        if (mode === "legacy-late") return await new Promise<Response>((resolve) => { answerLate = resolve; });
        if (mode === "runtime-refused" && wires.length === 1) return Response.json({ ok: false, delivery: "refused", error: "refused before admission" }, { status: 503 });
        return Response.json({ ok: true, structured: true, operationId: "offscreen-direct", receipt: {
          conversationId: "conv-queuefirst", idempotencyKey: body.idempotencyKey, operationId: "offscreen-direct",
          kind: "send", status: mode === "legacy-pending" ? "pending" : "delivered", revision: 1, at: new Date().toISOString(), text: body.text,
        } });
      }
      return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
    }) as typeof fetch;
    const { host, root } = await renderInto(<TmuxComposer file={file} />);
    try {
      await settle(() => appendComposerDraft("conv-queuefirst", "offscreen ask"));
      await settle(() => parallel(host));
      await settle(() => root.render(<TmuxComposer file={{ ...file, path: "/another.jsonl", conversationId: "other-card" }} />));
      await settle(() => answerGhost(Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 })));
      for (let i = 0; i < 60 && !wires.length; i++) await settle(() => {});
      for (let i = 0; i < 10; i++) await settle(() => {});
      expect(wires).toHaveLength(1);
      expect(sessionStorage.getItem("llvDraft:conv-queuefirst")).toBe(mode === "legacy-delivered" ? null : "offscreen ask");
      const entry = readOutbox("conv-queuefirst")[0]!;
      expect(entry.dispatchedAt).toBeNumber();
      const payload = await composerSubmissionPayloads.restore({ conversationId: "conv-queuefirst", key: entry.id });
      if (mode === "legacy-pending") {
        expect(entry.state).toBe("delivering");
        expect(payload?.receipt?.status).toBe("pending");
      } else if (mode === "runtime-refused") {
        expect(entry.state).toBe("failed");
        expect(payload?.retry).toBe("resend");
        await settle(() => root.render(<TmuxComposer file={file} />));
        await settle(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
        for (let i = 0; i < 60 && wires.length < 2; i++) await settle(() => {});
        expect(wires).toHaveLength(2);
        expect(wires[1]?.idempotencyKey).toBe(wires[0]?.idempotencyKey);
        expect(readOutbox("conv-queuefirst")).toHaveLength(1);
      } else {
        if (mode === "legacy-late") {
          for (let i = 0; i < 30 && !readOutbox("conv-queuefirst")[0]?.deliveryUncertain; i++) await settle(() => {});
          expect(readOutbox("conv-queuefirst")[0]?.deliveryUncertain).toBe(true);
          expect(payload).not.toBeNull();
          await settle(() => answerLate(Response.json({ ok: true })));
          for (let i = 0; i < 20; i++) await settle(() => {});
        }
        expect(readOutbox("conv-queuefirst")[0]?.state).toBe("delivered");
        expect(readOutbox("conv-queuefirst")[0]?.deliveryUncertain).not.toBe(true);
        expect(await composerSubmissionPayloads.restore({ conversationId: "conv-queuefirst", key: entry.id })).toBeNull();
        await settle(() => root.render(<TmuxComposer file={file} />));
        for (let i = 0; i < 10; i++) await settle(() => {});
        expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
        expect(host.textContent).toContain(translate("en", "composer.parallelSentDirectly"));
        expect(host.textContent).not.toContain("Delivery outcome is unknown");
        expect(wires).toHaveLength(1);
      }
    } finally { await act(async () => root.unmount()); }
  });
}


test("a late parallel-self success settles its original draft and publishes the block after switching cards", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerGhost: (response: Response) => void = () => {};
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return await new Promise<Response>((resolve) => { answerGhost = resolve; });
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  try {
    await settle(() => appendComposerDraft("conv-queuefirst", "parallel original"));
    await settle(() => parallel(host));
    await settle(() => root.render(<TmuxComposer file={{ ...file, path: "/another.jsonl", conversationId: "other-card" }} />));
    await settle(() => appendComposerDraft("other-card", "other draft"));
    await settle(() => answerGhost(Response.json({ ok: true, deputy: {
      askId: "deputy-ask", seatConversationId: "conv-queuefirst", startedAt: new Date().toISOString(), state: "active",
      deputyConversationId: "parallel-self", ask: { text: "parallel original", origin: { kind: "operator" } },
    } })));
    expect(sessionStorage.getItem("llvDraft:conv-queuefirst")).toBeNull();
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("other draft");
    expect(seatDeputiesFor("conv-queuefirst")).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});


test("an image fallback admitted while unmounted settles its persisted tray on remount", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerWire: (response: Response) => void = () => {};
  let wires = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 });
    if (url === "/api/tmux" && init?.method === "POST") {
      wires++;
      return await new Promise<Response>((resolve) => { answerWire = resolve; });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const first = await renderInto(<TmuxComposer file={file} />);
  const textarea = first.host.querySelector("textarea")!;
  const key = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[key]!;
  await settle(() => props.onPaste({ clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([new Uint8Array([1, 2, 3])], "ask.png", { type: "image/png" }) }] }, preventDefault() {} }));
  for (let i = 0; i < 10; i++) await settle(() => {});
  expect(first.host.querySelectorAll("img")).toHaveLength(1);
  await settle(() => parallel(first.host));
  for (let i = 0; i < 60 && !wires; i++) await settle(() => {});
  expect(wires).toBe(1);
  const entry = readOutbox("conv-queuefirst")[0]!;
  expect(entry.idleParallelImageIds).toHaveLength(1);
  await act(async () => first.root.unmount());
  await settle(() => answerWire(Response.json({ ok: true })));
  for (let i = 0; i < 20; i++) await settle(() => {});
  expect(readOutbox("conv-queuefirst")[0]?.state).toBe("delivered");
  expect(await composerSubmissionPayloads.restore({ conversationId: "conv-queuefirst", key: entry.id })).toBeNull();
  const second = await renderInto(<TmuxComposer file={file} />);
  try {
    for (let i = 0; i < 20; i++) await settle(() => {});
    expect(second.host.querySelectorAll("img")).toHaveLength(0);
    expect(readOutbox("conv-queuefirst")[0]?.idleParallelDraft).toBeUndefined();
    expect(second.host.textContent).toContain(translate("en", "composer.parallelSentDirectly"));
    await settle(() => second.host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    expect(wires).toBe(1);
  } finally { await act(async () => second.root.unmount()); }
});


for (const status of ["delivered", "queued"] as const) for (const response of ["pending", "refused"] as const) {
test(`newer ${status} evidence survives stale offscreen ${response} response`, async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerGhost: (r: Response) => void = () => {};
  let answerWire: (r: Response) => void = () => {};
  let wired = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return await new Promise<Response>(r => { answerGhost = r; });
    if (url === "/api/tmux" && init?.method === "POST") { wired = true; return await new Promise<Response>(r => { answerWire = r; }); }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  try {
    await settle(() => appendComposerDraft("conv-queuefirst", "ask"));
    await settle(() => parallel(host));
    await settle(() => root.render(<TmuxComposer file={{ ...file, path: "/other.jsonl", conversationId: "other" }} />));
    await settle(() => answerGhost(Response.json({ ok:false, code:"seat_not_busy" }, { status:409 })));
    for (let i=0; i<60 && !wired; i++) await settle(() => {});
    expect(wired).toBe(true);
    const entry = readOutbox("conv-queuefirst")[0]!;
    const payload = await composerSubmissionPayloads.restore({ conversationId:"conv-queuefirst", key:entry.id });
    const delivered = { conversationId:"conv-queuefirst", idempotencyKey:entry.id, operationId:"op", kind:"send", status, revision:2, at:new Date().toISOString(), text:"ask" } as const;
    expect(await composerSubmissionPayloads.observe(payload!.ref, delivered)).toBe(true);
    updateOutbox("conv-queuefirst", entry.id, { state: status === "delivered" ? "delivered" : "delivering", deliveryReceipt:delivered });
    await settle(() => answerWire(response === "pending" ? Response.json({ ok:true, structured:true, operationId:"op", receipt:{ ...delivered, status:"pending", revision:1 } }) : Response.json({ ok:false, delivery:"refused" }, {status:503})));
    for (let i=0; i<10; i++) await settle(() => {});
    expect(readOutbox("conv-queuefirst")[0]?.state).toBe(status === "delivered" ? "delivered" : "delivering");
    expect(readOutbox("conv-queuefirst")[0]?.deliveryUncertain).not.toBe(true);
  } finally { await act(async () => root.unmount()); }
});

}


test("offscreen fallback consumes its text once and preserves an identical later draft on remount", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerGhost: (response: Response) => void = () => {};
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return await new Promise<Response>((resolve) => { answerGhost = resolve; });
    if (url === "/api/tmux" && init?.method === "POST") {
      wires.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  try {
    await settle(() => appendComposerDraft("conv-queuefirst", "original ask"));
    await settle(() => parallel(host));
    await settle(() => appendComposerDraft("conv-queuefirst", "original ask"));
    await settle(() => root.render(<TmuxComposer file={{ ...file, path: "/another.jsonl", conversationId: "other-card" }} />));
    await settle(() => appendComposerDraft("other-card", "other draft"));
    await settle(() => answerGhost(Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 })));
    for (let i = 0; i < 60 && !wires.length; i++) await settle(() => {});
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({ text: "original ask", path: file.path });
    for (let i = 0; i < 60 && !readOutbox("conv-queuefirst")[0]?.idleParallelTextSettled; i++) await settle(() => {});
    expect(sessionStorage.getItem("llvDraft:conv-queuefirst")).toBe("original ask");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("other draft");
    expect(readOutbox("other-card")).toHaveLength(0);
    await act(async () => root.unmount());
    const second = await renderInto(<TmuxComposer file={file} />);
    for (let i = 0; i < 10; i++) await settle(() => {});
    expect((second.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("original ask");
    await act(async () => second.root.unmount());
  } finally { await act(async () => root.unmount()); }
});


test("a pending parallel ask leaves ordinary send on another conversation available", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerGhost: (response: Response) => void = () => {};
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return await new Promise<Response>((resolve) => { answerGhost = resolve; });
    if (url === "/api/tmux" && init?.method === "POST") {
      wires.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  try {
    await settle(() => appendComposerDraft("conv-queuefirst", "original ask"));
    await settle(() => parallel(host));
    await settle(() => root.render(<TmuxComposer file={{ ...file, path: "/another.jsonl", conversationId: "other-card" }} />));
    await settle(() => appendComposerDraft("other-card", "other draft"));
    await settle(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    expect(readOutbox("other-card")).toHaveLength(1);
    for (let i = 0; i < 60 && !wires.length; i++) await settle(() => {});
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({ text: "other draft", path: "/another.jsonl" });
    await settle(() => answerGhost(Response.json({ ok: false, error: "refused" }, { status: 400 })));
    expect(sessionStorage.getItem("llvDraft:conv-queuefirst")).toBe("original ask");
  } finally { await act(async () => root.unmount()); }
});


test("a pending parallel ask keeps its single-submit fence across composer remounts", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerGhost: (response: Response) => void = () => {};
  let asks = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") { asks++; return await new Promise<Response>((resolve) => { answerGhost = resolve; }); }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const first = await renderInto(<TmuxComposer file={file} />);
  await settle(() => appendComposerDraft("conv-queuefirst", "original ask"));
  await settle(() => parallel(first.host));
  expect(asks).toBe(1);
  await act(async () => first.root.unmount());
  const second = await renderInto(<TmuxComposer file={file} />);
  try {
    await settle(() => parallel(second.host));
    await settle(() => second.host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    expect(asks).toBe(1);
    expect(readOutbox("conv-queuefirst")).toHaveLength(0);
    expect((second.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("original ask");
    await settle(() => answerGhost(Response.json({ ok: false, error: "refused" }, { status: 400 })));
    await settle(() => parallel(second.host));
    expect(asks).toBe(2);
    await settle(() => answerGhost(Response.json({ ok: false, error: "refused" }, { status: 400 })));
  } finally { await act(async () => second.root.unmount()); }
});


test("a late parallel-self success settles the remounted original image tray", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerGhost: (response: Response) => void = () => {};
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return await new Promise<Response>((resolve) => { answerGhost = resolve; });
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const first = await renderInto(<TmuxComposer file={file} />);
  const textarea = first.host.querySelector("textarea")!;
  const key = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[key]!;
  await settle(() => props.onPaste({ clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([new Uint8Array([1, 2, 3])], "ask.png", { type: "image/png" }) }] }, preventDefault() {} }));
  for (let i = 0; i < 10; i++) await settle(() => {});
  await settle(() => appendComposerDraft("conv-queuefirst", "original ask"));
  await settle(() => parallel(first.host));
  await act(async () => first.root.unmount());
  const second = await renderInto(<TmuxComposer file={file} />);
  try {
    expect(second.host.querySelectorAll("img")).toHaveLength(1);
    await settle(() => answerGhost(Response.json({ ok: true, deputy: {
      askId: "deputy-ask", seatConversationId: "conv-queuefirst", startedAt: new Date().toISOString(), state: "active",
      deputyConversationId: "parallel-self", ask: { text: "original ask", origin: { kind: "operator" } },
    } })));
    expect(second.host.querySelectorAll("img")).toHaveLength(0);
    expect((second.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(seatDeputiesFor("conv-queuefirst")).toHaveLength(1);
  } finally { await act(async () => second.root.unmount()); }
});


test("seat busy reads pause with the composer and hidden document, then refresh on reentry", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  const reads: AbortSignal[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith("/api/orchestrator/ghost?")) {
      reads.push(init!.signal!);
      return Response.json({ conversationId: "conv-queuefirst", busy: true });
    }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const { root } = await renderInto(<TmuxComposer file={file} pollPaused={true} viewActive={false} />);
  try {
    expect(reads).toHaveLength(0);
    await settle(() => root.render(<TmuxComposer file={file} pollPaused={true} viewActive={true} />));
    expect(reads).toHaveLength(0);
    await settle(() => root.render(<TmuxComposer file={file} pollPaused={false} viewActive={false} />));
    expect(reads).toHaveLength(0);
    await settle(() => root.render(<TmuxComposer file={file} />));
    expect(reads).toHaveLength(1);
    await settle(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    });
    expect(reads[0]?.aborted).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_050)); });
    expect(reads).toHaveLength(1);
    await settle(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    });
    expect(reads).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else delete (document as unknown as { visibilityState?: string }).visibilityState;
  }
});

function RecoverFallback({ entryId }: { entryId: string }) {
  const actions = useOutboxRowActions("conv-queuefirst", readOutbox("conv-queuefirst"));
  return <button data-recover onClick={() => actions.onClear?.(entryId)}>Recover</button>;
}

for (const withChips of [false, true]) test(`payload-loss recovery preserves retained fallback text (${withChips})`, async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  if (withChips) addTaskChip("viewer", { id: "t1", title: "Review task" });
  enqueueOutbox("conv-queuefirst", { id: "previous-wire", text: "previous", images: 0, at: Date.now() });
  updateOutbox("conv-queuefirst", "previous-wire", { state: "delivering", dispatchedAt: Date.now() });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: false });
    if (url === "/api/orchestrator/ghost") return Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 });
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const first = await renderInto(<TmuxComposer file={file} taskChipsFor={withChips ? "viewer" : undefined} />);
  await settle(() => appendComposerDraft("conv-queuefirst", "one ask"));
  const textarea = first.host.querySelector("textarea")!;
  const key = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[key]!;
  await settle(() => props.onPaste({ clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([new Uint8Array([1, 2, 3])], "ask.png", { type: "image/png" }) }] }, preventDefault() {} }));
  for (let i = 0; i < 10; i++) await settle(() => {});
  await settle(() => parallel(first.host));
  for (let i = 0; i < 60; i++) await settle(() => {});
  const prepared = readOutbox("conv-queuefirst").find(e => e.idleParallelDraft !== undefined)!;
  expect(prepared.state).toBe("queued");
  expect(prepared.preparing).toBeUndefined();
  expect((await composerSubmissionPayloads.restore({ conversationId: "conv-queuefirst", key: prepared.id }))?.envelope).toBeDefined();
  await act(async () => first.root.unmount());
  storage.reset(); // Simulate the payload store unavailable or evicted after reload.
  resetOutboxForTests();
  const second = await renderInto(<TmuxComposer file={file} taskChipsFor={withChips ? "viewer" : undefined} />);
  try {
    const entry = readOutbox("conv-queuefirst").find(e => e.idleParallelDraft !== undefined)!;
    expect(entry.needsReattach).toBe(true);
    const row = messageRowModel((key, args) => translate("en", key, args), entry);
    expect(row.failure?.action).toBe("return");
    expect((second.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("one ask");
    await settle(() => appendComposerDraft("conv-queuefirst", "later words"));
    await act(async () => { second.root.render(<><TmuxComposer file={file} taskChipsFor={withChips ? "viewer" : undefined} /><RecoverFallback entryId={entry.id} /></>); });
    await settle(() => (second.host.querySelector("[data-recover]") as HTMLButtonElement).click());
    expect((second.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("one ask\n\nlater words");
    expect(readOutbox("conv-queuefirst").some(candidate => candidate.id === entry.id)).toBeFalse();
  } finally { await act(async () => second.root.unmount()); }
});

test("remounted image-only fallback dedupes before payload hydration", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerWire: (response: Response) => void = () => {};
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: false });
    if (url === "/api/orchestrator/ghost") return Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 });
    if (url === "/api/tmux" && init?.method === "POST") { wires.push(JSON.parse(String(init.body))); return await new Promise<Response>((resolve)=>{ answerWire=resolve; }); }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const first = await renderInto(<TmuxComposer file={file} />);
  const textarea=first.host.querySelector("textarea")!;
  const key=Object.keys(textarea).find(key=>key.startsWith("__reactProps$"))!;
  const props=(textarea as unknown as Record<string,{ onPaste(event:unknown):void }>)[key]!;
  await settle(()=>props.onPaste({ clipboardData:{ items:[{ type:"image/png", getAsFile:()=>new dom.File([new Uint8Array([1,2,3])],"ask.png",{type:"image/png"}) }] }, preventDefault(){} }));
  for(let i=0;i<10;i++)await settle(()=>{});
  await settle(()=>parallel(first.host));
  for(let i=0;i<60 && !wires.length;i++)await settle(()=>{});
  expect(wires).toHaveLength(1);
  await act(async()=>first.root.unmount());
  let hydrate: ()=>void = ()=>{};
  const gate = new Promise<void>(resolve=>{ hydrate=resolve; });
  const listOriginal=composerSubmissionPayloads.list.bind(composerSubmissionPayloads);
  composerSubmissionPayloads.list=async(id)=>{ await gate; return listOriginal(id); };
  const second=await renderInto(<TmuxComposer file={file} />);
  try {
    expect(second.host.querySelectorAll("img")).toHaveLength(1);
    await settle(()=>second.host.querySelector("form")!.dispatchEvent(new dom.Event("submit",{bubbles:true,cancelable:true}) as unknown as Event));
    const newKeys=readOutbox("conv-queuefirst").map(e=>e.id);
    hydrate();
    composerSubmissionPayloads.list=listOriginal;
    await settle(()=>answerWire(Response.json({ok:true})));
    for(let i=0;i<60 && wires.length<2;i++) await settle(()=>{});
    expect(newKeys).toHaveLength(1);
    expect(wires).toHaveLength(1);
  } finally { hydrate(); composerSubmissionPayloads.list=listOriginal; await settle(()=>answerWire(Response.json({ok:true}))); await act(async()=>second.root.unmount()); }
});


test("older ordinary message remains ahead of offscreen fallback", async () => {
  publishSeatProject("conv-queuefirst", "viewer");
  let answerGhost: (response: Response) => void = () => {};
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/ghost?")) return Response.json({ conversationId: "conv-queuefirst", busy: true });
    if (url === "/api/orchestrator/ghost") return await new Promise<Response>((resolve) => { answerGhost = resolve; });
    if (url === "/api/tmux" && init?.method === "POST") { wires.push(JSON.parse(String(init.body))); return Response.json({ ok: true }); }
    return Response.json({ targets: {}, seat: null, operations: [], receipts: [] });
  }) as typeof fetch;
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  try {
    await settle(() => appendComposerDraft("conv-queuefirst", "new fallback"));
    await settle(() => parallel(host));
    await settle(() => enqueueOutbox("conv-queuefirst", {
      id: "older-message", text: "older ordinary", images: 0, at: Date.now() - 1000,
    }));
    await settle(() => root.render(<TmuxComposer file={{ ...file, path: "/another.jsonl", conversationId: "other-card" }} />));
    await settle(() => answerGhost(Response.json({ ok: false, code: "seat_not_busy" }, { status: 409 })));
    for (let i=0; i<60 && !wires.length; i++) await settle(() => {});
    expect(wires).toHaveLength(0);
    expect(readOutbox("conv-queuefirst").map(entry => entry.state)).toEqual(["queued", "queued"]);
    await settle(() => root.render(<TmuxComposer file={file} />));
    for (let i = 0; i < 60 && wires.length < 2; i++) await settle(() => {});
    expect(wires.map(wire => wire.text)).toEqual(["older ordinary", "new fallback"]);
  } finally { await act(async () => root.unmount()); }
});
