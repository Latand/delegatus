import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { installComposerStorageForTests } from "@/test-helpers/composerStorage";
import { Window } from "happy-dom";
import { useSyncExternalStore } from "react";
import { composerSubmissionPayloads } from "@/lib/composerSubmissionPayloads";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import {
  setComposerAdmissionTimingForTests,
} from "./composerAdmissionDeadline";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";

const dom = new Window();
Object.assign(globalThis, {
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
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
const mobileViewport = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobileViewport && query.includes("max-width"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

import { TmuxComposer } from "./TmuxComposer";
import { OutboxBubbles } from "./conversation/OutboxBubbles";
import { messageRowRecovery } from "./conversation/rowRecovery";
import { readOutbox, resetOutboxForTests, retryOutbox, useOutbox } from "./conversation/outbox";
import { attachModeFor, capabilitiesFor } from "./agentCapabilities";
import type { RuntimeSessionView } from "@/hooks/useRuntime";

/* Attachment submissions are kept in IndexedDB before they reach the wire. */
const composerStorage = installComposerStorageForTests();
afterAll(() => composerStorage.uninstall());

beforeEach(() => {
  setRuntimeUiEnabledForTests(false);
  setLocale("uk"); localStorage.clear(); sessionStorage.clear(); resetOutboxForTests();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  setComposerAdmissionTimingForTests({ admissionDeadlineMs: 8, receiptReconciliationMs: 40,
    receiptPollIntervalMs: 5, admissionObservationIntervalMs: 10 });
});
afterEach(() => {
  composerStorage.reset();
  setTmuxComposerRuntimeDependenciesForTests(null);
  setComposerAdmissionTimingForTests(null);
  setRuntimeUiEnabledForTests(null);
});

function fileFor(conversationId: string): FileEntry {
  return {
    path: `/${conversationId}.jsonl`,
    root: "codex-sessions",
    name: `${conversationId}.jsonl`,
    project: "viewer",
    title: conversationId,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250 && !condition(); attempt += 1) await sleep(4);
  expect(condition()).toBe(true);
}
const submitButton = (host: HTMLElement) => host.querySelector('button[type="submit"]') as HTMLButtonElement;
async function untilSendEnabled(host: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 100 && submitButton(host).disabled; attempt += 1) await sleep(3);
  expect(submitButton(host).disabled).toBe(false);
}


function Harness({ file, active = true }: { file: FileEntry; active?: boolean }) {
  const entries = useOutbox(file.conversationId!);
  return <><OutboxBubbles cardId={file.conversationId!} entries={entries} /><TmuxComposer file={file} viewActive={active} /></>;
}
async function scenario(name: string, run: (fixture: Awaited<ReturnType<typeof mountScenario>>) => Promise<void>, fault: "lost" | "outage" = "lost") {
  const fixture = await mountScenario(name, fault);
  try { await run(fixture); }
  finally { fixture.close(); }
}
async function mountScenario(name: string, fault: "lost" | "outage") {
  const conversationId = `conversation-recovery-${name}`;
  const original = "Synthetic confirmed message";
  const state = { sends: 0, lookups: 0, exposed: false, receipt: null as RuntimeReceipt | null,
    receipts: [] as RuntimeReceipt[], listeners: new Set<() => void>(),
    lookup: null as null | ((signal?: AbortSignal) => Promise<import("@/hooks/useRuntime").RuntimeAdmissionLookup>) };
  const view = { session: { conversationId, hostKind: "codex-app-server", host: "hosted", turn: "idle",
    capabilities: { imageInput: { supported: true } }, recentReceipts: [] }, uiState: {}, attentions: [], receipts: [],
    legacy: false, structuredControlsEnabled: true } as unknown as RuntimeSessionView;
  setTmuxComposerRuntimeDependenciesForTests({
    refreshRuntime: async () => false, useRuntimeReceiptsForArtifact: () => useSyncExternalStore(
      listener => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
      () => state.receipts, () => state.receipts),
    useAgentCapabilities: candidate => {
      const options = { runtimeEnabled: true };
      return { caps: capabilitiesFor(candidate, view, options), runtime: view, structuredSession: view,
        runtimeEnabled: true, attachMode: attachModeFor(candidate, view, options) };
    },
    sendRuntimeMessage: async options => {
      state.sends += 1;
      state.receipt = { operationId: "operation-recovery", conversationId, idempotencyKey: options.idempotencyKey,
        kind: "send", status: "delivered", text: options.text, at: new Date().toISOString(), revision: 3 };
      return fault === "outage" ? { ok: false, error: "runtime host is unavailable" } : new Promise(() => {});
    },
    lookupRuntimeAdmission: async (id, key, signal) => {
      state.lookups += 1; expect(id).toBe(conversationId);
      if (!state.receipt) return { outcome: "unknown" };
      expect(key).toBe(state.receipt.idempotencyKey);
      if (state.lookup) return state.lookup(signal);
      return state.exposed ? { outcome: "admitted", operationId: state.receipt.operationId, receipt: state.receipt } : { outcome: "unknown" };
    },
  });
  globalThis.fetch = (async input => String(input) === "/api/tmux/targets" ? Response.json({ targets: {} }) : Response.json({}, { status: 404 })) as typeof fetch;
  sessionStorage.setItem(`llvDraft:${conversationId}`, original);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = (file = fileFor(conversationId), active = true) => flushSync(() => root.render(<Harness file={file} active={active} />));
  render(); await untilSendEnabled(host);
  if (name === "attachment") {
    const input = host.querySelector("textarea")!;
    const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
    props.onPaste({ clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File(["synthetic-image"], "image.png", { type: "image/png" }) }] }, preventDefault() {} });
    await until(() => Boolean(host.querySelector('[data-testid="attachment-tile"][data-status="ready"]')));
  }
  flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await until(() => readOutbox(conversationId)[0]?.state === "failed");
  expect(readOutbox(conversationId)[0]?.deliveryUncertain).toBe(true);
  const key = readOutbox(conversationId)[0]!.id;
  const writeDraft = (value: string) => {
    const textarea = host.querySelector("textarea")!;
    const propsKey = Object.keys(textarea).find(key => key.startsWith("__reactProps$"))!;
    const props = (textarea as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
    flushSync(() => props.onChange({ target: { value } }));
  };
  const delivered = async () => {
    for (let attempt = 0; attempt < 250 && readOutbox(conversationId)[0]?.state !== "delivered"; attempt += 1) await sleep(4);
    await sleep(15);
    expect(readOutbox(conversationId)[0]?.state).toBe("delivered");
    expect(host.querySelectorAll("[data-message-row]")).toHaveLength(1);
    expect(host.textContent).not.toContain(translate("uk", "composer.deliveryUnconfirmed"));
    expect(state.sends).toBe(1);
  };
  return { state, host, root, render, conversationId, key, writeDraft, delivered,
    publish(receipts: RuntimeReceipt[]) { flushSync(() => { state.receipts = receipts; for (const listener of state.listeners) listener(); }); },
    close() { flushSync(() => root.unmount()); host.remove(); } };
}

test("a delivered original key recovers automatically after a lost answer and absent recent tail", async () => {
  await scenario("original", async fixture => {
    fixture.writeDraft("Keep my newer draft"); fixture.state.exposed = true;
    await fixture.delivered();
    expect((fixture.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Keep my newer draft");
    expect(sessionStorage.getItem(`llvPendingSend:${fixture.conversationId}`)).toBeNull();
  });
});

test("receipt outage recovers after both confirmation windows without resending", async () => {
  await scenario("outage", async fixture => {
    fixture.state.lookup = async () => { throw new Error("receipt service unavailable"); };
    await sleep(40);
    expect(readOutbox(fixture.conversationId)[0]?.deliveryUncertain).toBe(true);
    expect(readOutbox(fixture.conversationId)[0]?.text).toBe("Synthetic confirmed message");
    expect(sessionStorage.getItem(`llvPendingSend:${fixture.conversationId}`)).toContain(fixture.key);
    fixture.state.lookup = null; fixture.state.exposed = true; await fixture.delivered();
  }, "outage");
});

test("Retry before confirmation and Check racing a held automatic read never send twice", async () => {
  await scenario("race", async fixture => {
    flushSync(() => retryOutbox(fixture.conversationId, fixture.key));
    await sleep(15); expect(fixture.state.sends).toBe(1);
    let release!: (answer: import("@/hooks/useRuntime").RuntimeAdmissionLookup) => void;
    fixture.state.lookup = () => new Promise(resolve => { release = resolve; });
    await until(() => Boolean(release));
    const reads = fixture.state.lookups;
    flushSync(() => messageRowRecovery(fixture.conversationId)!.check(fixture.key));
    await sleep(10); expect(fixture.state.lookups).toBe(reads);
    release({ outcome: "admitted", receipt: fixture.state.receipt!, operationId: fixture.state.receipt!.operationId });
    fixture.state.lookup = null; fixture.state.exposed = true; await fixture.delivered();
    flushSync(() => retryOutbox(fixture.conversationId, fixture.key));
    await sleep(15); expect(fixture.state.sends).toBe(1);
  });
});

test("visibility cancels held reads and restarts original-key observation", async () => {
  await scenario("visibility", async fixture => {
    let signal: AbortSignal | undefined;
    fixture.state.lookup = async current => { signal = current; return new Promise(() => {}); };
    await until(() => Boolean(signal));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    expect(signal!.aborted).toBe(true);
    const reads = fixture.state.lookups; await sleep(25); expect(fixture.state.lookups).toBe(reads);
    fixture.state.lookup = null; fixture.state.exposed = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    await fixture.delivered();
  });
});

test("remount and transcript-path migration retain the original-key fence", async () => {
  await scenario("remount", async fixture => {
    fixture.writeDraft("Draft survives a remount");
    flushSync(() => fixture.root.render(null));
    fixture.state.exposed = true;
    fixture.render({ ...fileFor(fixture.conversationId), path: "/moved-transcript.jsonl" });
    await fixture.delivered();
    expect((fixture.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Draft survives a remount");
  });
});

test("inactive views discard held answers and recover on activation", async () => {
  await scenario("inactive", async fixture => {
    let release!: (answer: import("@/hooks/useRuntime").RuntimeAdmissionLookup) => void;
    fixture.state.lookup = () => new Promise(resolve => { release = resolve; });
    await until(() => Boolean(release));
    fixture.render(fileFor(fixture.conversationId), false);
    release({ outcome: "admitted", receipt: fixture.state.receipt!, operationId: fixture.state.receipt!.operationId });
    await sleep(25); expect(readOutbox(fixture.conversationId)[0]?.state).toBe("failed");
    fixture.state.lookup = null; fixture.state.exposed = true;
    fixture.render(); await fixture.delivered();
  });
});


test("a retained attachment receives the canonical receipt in storage and in its live bubble", async () => {
  await scenario("attachment", async fixture => {
    const retained = await composerSubmissionPayloads.restore({ conversationId: fixture.conversationId, key: fixture.key });
    expect(retained?.submission.images).toHaveLength(1);
    fixture.writeDraft("Later attachment draft"); fixture.state.exposed = true;
    await fixture.delivered();
    expect(await composerSubmissionPayloads.restore({ conversationId: fixture.conversationId, key: fixture.key })).toBeNull();
    expect((fixture.host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Later attachment draft");
  });
});

test("authoritative non-execution retires uncertainty while preserving the original message", async () => {
  await scenario("not-executed", async fixture => {
    fixture.state.lookup = async () => ({ outcome: "not-executed" });
    await until(() => readOutbox(fixture.conversationId)[0]?.deliveryUncertain === undefined);
    expect(readOutbox(fixture.conversationId)[0]).toMatchObject({ id: fixture.key, text: "Synthetic confirmed message", state: "failed" });
    expect(fixture.host.textContent).not.toContain(translate("uk", "composer.deliveryUnconfirmed"));
    expect(fixture.state.sends).toBe(1);
  });
});

test("a held lower revision cannot replace newer terminal stream evidence", async () => {
  await scenario("revision", async fixture => {
    let release!: (answer: import("@/hooks/useRuntime").RuntimeAdmissionLookup) => void;
    fixture.state.lookup = () => new Promise(resolve => { release = resolve; });
    await until(() => Boolean(release));
    fixture.publish([{ ...fixture.state.receipt!, revision: 4 }]);
    await fixture.delivered();
    release({ outcome: "admitted", operationId: fixture.state.receipt!.operationId,
      receipt: { ...fixture.state.receipt!, revision: 2, status: "queued" } });
    await sleep(20); expect(readOutbox(fixture.conversationId)[0]?.state).toBe("delivered");
  });
});

test("identity changes discard late answers and a return recovers the retained key", async () => {
  await scenario("identity", async fixture => {
    let release!: (answer: import("@/hooks/useRuntime").RuntimeAdmissionLookup) => void;
    fixture.state.lookup = () => new Promise(resolve => { release = resolve; });
    await until(() => Boolean(release));
    fixture.render(fileFor("conversation-successor"));
    release({ outcome: "admitted", receipt: fixture.state.receipt!, operationId: fixture.state.receipt!.operationId });
    await sleep(20);
    expect(readOutbox(fixture.conversationId)[0]?.state).toBe("failed");
    expect(readOutbox("conversation-successor")).toEqual([]);
    fixture.state.lookup = null; fixture.state.exposed = true; fixture.render(); await fixture.delivered();
  });
});


test("confirmation persisted while hiding is projected into the live bubble on return", async () => {
  await scenario("attachment", async fixture => {
    const observe = composerSubmissionPayloads.observe.bind(composerSubmissionPayloads);
    let hidden = false;
    composerSubmissionPayloads.observe = async (ref, receipt) => {
      const accepted = await observe(ref, receipt);
      if (!hidden) {
        hidden = true;
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
      }
      return accepted;
    };
    try {
      fixture.state.exposed = true; await until(() => hidden);
      expect(readOutbox(fixture.conversationId)[0]?.state).toBe("failed");
      expect((await composerSubmissionPayloads.restore({ conversationId: fixture.conversationId, key: fixture.key }))?.receipt?.status).toBe("delivered");
    } finally { composerSubmissionPayloads.observe = observe; }
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    await fixture.delivered();
  });
});

test("non-execution saved while hiding retires uncertainty on return", async () => {
  await scenario("attachment", async fixture => {
    const refuse = composerSubmissionPayloads.refuse.bind(composerSubmissionPayloads);
    let hidden = false;
    composerSubmissionPayloads.refuse = async (ref, refusal) => {
      const accepted = await refuse(ref, refusal);
      if (accepted && !hidden) {
        hidden = true;
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
      }
      return accepted;
    };
    try {
      fixture.state.lookup = async () => ({ outcome: "not-executed" });
      await until(() => hidden);
      expect(readOutbox(fixture.conversationId)[0]?.deliveryUncertain).toBe(true);
      expect((await composerSubmissionPayloads.restore({ conversationId: fixture.conversationId, key: fixture.key }))?.refusal).not.toBeNull();
    } finally { composerSubmissionPayloads.refuse = refuse; }
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    await until(() => readOutbox(fixture.conversationId)[0]?.deliveryUncertain === undefined);
    expect(readOutbox(fixture.conversationId)[0]).toMatchObject({ id: fixture.key, state: "failed" });
    expect(fixture.host.textContent).not.toContain(translate("uk", "composer.deliveryUnconfirmed"));
    expect(fixture.state.sends).toBe(1);
  });
});
