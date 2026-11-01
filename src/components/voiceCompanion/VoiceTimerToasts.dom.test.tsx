import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse } from "@/test-helpers/onboardingDom";

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { TASK_TOAST_MS, TaskToastHost } = await import("@/components/tasks/taskToast");
const { VISIBLE_TIMER_TOASTS, VOICE_TIMERS_EVENT, VoiceTimerToasts } = await import("./VoiceTimerToasts");

const realFetch = globalThis.fetch;
const roots: Root[] = [];
let visibility = "visible";
Object.defineProperty(harness.dom.document, "visibilityState", { configurable: true, get: () => visibility });

/* The window's timers run on this clock and nothing else: a test moves it with `advance`. */
const clock = { now: 0, nextId: 1, due: new Map<number, { at: number; run: () => void }>() };
const realTimers = { set: window.setTimeout, clear: window.clearTimeout };
beforeEach(() => {
  clock.now = 0;
  clock.due.clear();
  window.setTimeout = ((run: () => void, delay = 0) => { const id = clock.nextId++; clock.due.set(id, { at: clock.now + delay, run }); return id; }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { clock.due.delete(id); }) as typeof window.clearTimeout;
});
/** Runs what the promises and React have queued, on no clock at all. */
async function flush() {
  await act(async () => { for (let turn = 0; turn < 12; turn += 1) await new Promise<void>(resolve => { setImmediate(resolve); }); });
}
async function advance(to: number) {
  for (;;) {
    const next = [...clock.due.entries()].filter(([, entry]) => entry.at <= to).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) break;
    clock.due.delete(next[0]);
    clock.now = Math.max(clock.now, next[1].at);
    next[1].run();
    await flush();
  }
  clock.now = to;
}
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  window.setTimeout = realTimers.set;
  window.clearTimeout = realTimers.clear;
  globalThis.fetch = realFetch;
  visibility = "visible";
  document.body.innerHTML = "";
});

const TEXT = "The 15-minute timer «tea», set at 10:05, is up.";
function server(answers: { claimable: string[]; nextInMs: number | null }, claim: (id: string) => unknown = () => ({ claimed: true, text: TEXT, lease: 1 })) {
  const calls: Array<{ method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method: init?.method ?? "GET", body });
    if (body?.action === "shown") return jsonResponse({ shown: true });
    return jsonResponse(body ? claim(String(body.id)) : answers);
  }) as typeof fetch;
  return calls;
}
/** A fetch this test answers by hand, so state can change while it is on its way. */
function heldServer() {
  const calls: Array<{ body: Record<string, unknown> | null; signal: AbortSignal | null | undefined; answer(value: unknown): void; refuse(): void }> = [];
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ body, signal: init?.signal, answer: value => resolve(jsonResponse(value)), refuse: () => reject(new Error("aborted")) });
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as typeof fetch;
  return calls;
}
const actions = (calls: Array<{ body: Record<string, unknown> | null }>) => calls.map(row => row.body?.action ?? "read");
async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(node); });
  await flush();
  return { host, root };
}
const shown = (host: Element) => [...host.querySelectorAll("[role=status]")].map(row => row.textContent);
const hide = async () => { visibility = "hidden"; await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); await flush(); };
const reveal = async () => { visibility = "visible"; await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); await flush(); };

test("a visible tab reads, claims what it may show, toasts it once on the host beside it and says so", async () => {
  const calls = server({ claimable: ["vt_a"], nextInMs: null });
  const { host } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(actions(calls)).toEqual(["read", "claim", "shown"]);
  expect(calls[1]!.body).toEqual({ action: "claim", id: "vt_a", locale: "en" });
  expect(calls[2]!.body).toEqual({ action: "shown", id: "vt_a", lease: 1 });
  expect(shown(host)).toEqual([`✓${TEXT}`]);
  expect(host.querySelector("[data-task-toasts]")!.className).toContain("fixed");
});

test("a claim another tab won shows nothing here and says nothing", async () => {
  const calls = server({ claimable: ["vt_a"], nextInMs: null }, () => ({ claimed: false }));
  const { host } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(shown(host)).toEqual([]);
  expect(actions(calls)).toEqual(["read", "claim"]);
});

test("a screen with no host says nothing was shown, so the toast's lease runs out and it stays owed", async () => {
  const calls = server({ claimable: ["vt_a"], nextInMs: null });
  await mount(<VoiceTimerToasts />);
  expect(actions(calls)).toEqual(["read", "claim"]);
});

test("a hidden tab reads and claims nothing, and takes the toast on becoming visible", async () => {
  visibility = "hidden";
  const calls = server({ claimable: ["vt_a"], nextInMs: null });
  const { host } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(calls).toEqual([]);
  await reveal();
  expect(actions(calls)).toEqual(["read", "claim", "shown"]);
  expect(shown(host)).toHaveLength(1);
});

test("a tab hidden during its read claims nothing, and reads again when visible", async () => {
  const calls = heldServer();
  const { host } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(actions(calls)).toEqual(["read"]);
  await hide();
  expect(calls[0]!.signal?.aborted).toBe(true);
  expect(actions(calls)).toEqual(["read"]);
  await reveal();
  expect(actions(calls)).toEqual(["read", "read"]);
  calls[1]!.answer({ claimable: ["vt_a"], nextInMs: null });
  await flush();
  calls[2]!.answer({ claimed: true, text: TEXT, lease: 1 });
  await flush();
  expect(shown(host)).toEqual([`✓${TEXT}`]);
  expect(actions(calls)).toEqual(["read", "read", "claim", "shown"]);
});

test("a read that answers after the tab went hidden claims nothing", async () => {
  const calls = heldServer();
  await mount(<VoiceTimerToasts />);
  // Hidden with no event yet: the read's answer is what finds it out.
  visibility = "hidden";
  calls[0]!.answer({ claimable: ["vt_a"], nextInMs: null });
  await flush();
  expect(actions(calls)).toEqual(["read"]);
});

test("a tab hidden during its claim shows nothing and says nothing, so the lease brings the toast back", async () => {
  const calls = heldServer();
  const { host } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  calls[0]!.answer({ claimable: ["vt_a"], nextInMs: null });
  await flush();
  expect(actions(calls)).toEqual(["read", "claim"]);
  visibility = "hidden";
  calls[1]!.answer({ claimed: true, text: TEXT, lease: 1 });
  await flush();
  expect(shown(host)).toEqual([]);
  expect(actions(calls)).toEqual(["read", "claim"]);
});

test("a tab unmounted during its claim shows nothing and says nothing", async () => {
  const calls = heldServer();
  const { host, root } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  calls[0]!.answer({ claimable: ["vt_a"], nextInMs: null });
  await flush();
  await act(async () => { root.render(<TaskToastHost floating />); });
  await flush();
  expect(calls[1]!.signal?.aborted).toBe(true);
  calls[1]!.answer({ claimed: true, text: TEXT, lease: 1 });
  await flush();
  expect(shown(host)).toEqual([]);
  expect(actions(calls)).toEqual(["read", "claim"]);
});

test("a server that lost the first answer that a toast showed is told again on the next read", async () => {
  const calls: Array<{ action: unknown }> = [];
  let answerShown = false;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ action: body?.action ?? "read" });
    if (body?.action === "shown") { if (!answerShown) throw new Error("offline"); return jsonResponse({ shown: true }); }
    return jsonResponse(body ? { claimed: true, text: TEXT, lease: 7 } : { claimable: calls.length === 1 ? ["vt_a"] : [], nextInMs: null });
  }) as typeof fetch;
  const { host } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(calls.map(row => row.action)).toEqual(["read", "claim", "shown"]);
  answerShown = true;
  await act(async () => { window.dispatchEvent(new Event(VOICE_TIMERS_EVENT)); });
  await flush();
  expect(calls.map(row => row.action)).toEqual(["read", "claim", "shown", "shown", "read"]);
  expect(shown(host)).toHaveLength(1);
});

test("five timers at once show three, then the rest as those leave, each once and each said only when shown", async () => {
  const waiting = ["vt_1", "vt_2", "vt_3", "vt_4", "vt_5"];
  const calls: Array<{ action: unknown; id: unknown }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ action: body?.action ?? "read", id: body?.id });
    if (body?.action === "shown") return jsonResponse({ shown: true });
    if (body?.action === "claim") { waiting.splice(waiting.indexOf(String(body.id)), 1); return jsonResponse({ claimed: true, text: `Timer ${String(body.id)}`, lease: 1 }); }
    return jsonResponse({ claimable: [...waiting], nextInMs: null });
  }) as typeof fetch;
  const { host } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  const everShown = new Set(shown(host));
  expect(shown(host)).toHaveLength(VISIBLE_TIMER_TOASTS);
  expect(waiting).toEqual(["vt_4", "vt_5"]);
  expect(calls.filter(row => row.action === "shown").map(row => row.id)).toEqual(["vt_1", "vt_2", "vt_3"]);
  await advance(TASK_TOAST_MS - 1);
  expect(shown(host)).toHaveLength(VISIBLE_TIMER_TOASTS);
  expect(waiting).toEqual(["vt_4", "vt_5"]);
  await advance(TASK_TOAST_MS);
  for (const row of shown(host)) everShown.add(row);
  expect(waiting).toEqual([]);
  expect(shown(host).length).toBeLessThanOrEqual(VISIBLE_TIMER_TOASTS);
  expect([...everShown].sort()).toEqual(["vt_1", "vt_2", "vt_3", "vt_4", "vt_5"].map(id => `✓Timer ${id}`));
  expect(calls.filter(row => row.action === "shown").map(row => row.id)).toEqual(["vt_1", "vt_2", "vt_3", "vt_4", "vt_5"]);
  await advance(2 * TASK_TOAST_MS);
  expect(shown(host)).toEqual([]);
});

test("a call ending reads again, and a read that fails shows nothing and asks again later", async () => {
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const { host } = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(shown(host)).toEqual([]);
  const calls = server({ claimable: ["vt_a"], nextInMs: null });
  await act(async () => { window.dispatchEvent(new Event(VOICE_TIMERS_EVENT)); });
  await flush();
  expect(actions(calls)).toEqual(["read", "claim", "shown"]);
  expect(shown(host)).toHaveLength(1);
});

test("the next timer's time arms one read, on the fixed clock", async () => {
  let reads = 0;
  globalThis.fetch = (async () => { reads += 1; return jsonResponse({ claimable: [], nextInMs: reads === 1 ? 300 : null }); }) as unknown as typeof fetch;
  await mount(<VoiceTimerToasts />);
  expect(reads).toBe(1);
  await advance(299);
  expect(reads).toBe(1);
  await advance(300);
  expect(reads).toBe(2);
  await advance(59_000);
  expect(reads).toBe(2);
  await advance(60_300);
  expect(reads).toBe(3);
});
