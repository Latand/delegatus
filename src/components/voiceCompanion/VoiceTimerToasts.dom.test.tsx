import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse } from "@/test-helpers/onboardingDom";

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { TaskToastHost } = await import("@/components/tasks/taskToast");
const { VOICE_TIMERS_EVENT, VoiceTimerToasts } = await import("./VoiceTimerToasts");

const realFetch = globalThis.fetch;
const roots: Root[] = [];
let visibility = "visible";
Object.defineProperty(harness.dom.document, "visibilityState", { configurable: true, get: () => visibility });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  globalThis.fetch = realFetch;
  visibility = "visible";
  document.body.innerHTML = "";
});

function server(answers: { claimable: string[]; nextInMs: number | null }, claim: (id: string) => unknown = () => ({ claimed: true, text: "The 15-minute timer «tea», set at 10:05, is up." })) {
  const calls: Array<{ method: string; body: unknown }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { id: string } : null;
    calls.push({ method: init?.method ?? "GET", body });
    return jsonResponse(body ? claim(body.id) : answers);
  }) as typeof fetch;
  return calls;
}
async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(node); await new Promise(resolve => setTimeout(resolve, 5)); });
  return host;
}
const shown = (host: Element) => [...host.querySelectorAll("[role=status]")].map(row => row.textContent);

test("a visible tab reads, claims what it may show and toasts it once on the host beside it", async () => {
  const calls = server({ claimable: ["vt_a"], nextInMs: null });
  const host = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(calls.map(row => row.method)).toEqual(["GET", "POST"]);
  expect(calls[1]!.body).toEqual({ action: "claim", id: "vt_a", locale: "en" });
  expect(shown(host)).toEqual(["✓The 15-minute timer «tea», set at 10:05, is up."]);
  expect(host.querySelector("[data-task-toasts]")!.className).toContain("fixed");
});

test("a claim another tab won shows nothing here", async () => {
  server({ claimable: ["vt_a"], nextInMs: null }, () => ({ claimed: false }));
  const host = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(shown(host)).toEqual([]);
});

test("a hidden tab reads and claims nothing, and takes the toast on becoming visible", async () => {
  visibility = "hidden";
  const calls = server({ claimable: ["vt_a"], nextInMs: null });
  const host = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(calls).toEqual([]);
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(calls.map(row => row.method)).toEqual(["GET", "POST"]);
  expect(shown(host)).toHaveLength(1);
});

test("a call ending reads again, and a read that fails shows nothing and asks again later", async () => {
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const host = await mount(<><TaskToastHost floating /><VoiceTimerToasts /></>);
  expect(shown(host)).toEqual([]);
  const calls = server({ claimable: ["vt_a"], nextInMs: null });
  await act(async () => { window.dispatchEvent(new Event(VOICE_TIMERS_EVENT)); await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(calls.map(row => row.method)).toEqual(["GET", "POST"]);
  expect(shown(host)).toHaveLength(1);
});

test("the next timer's time arms one read", async () => {
  let reads = 0;
  globalThis.fetch = (async () => { reads += 1; return jsonResponse({ claimable: [], nextInMs: reads === 1 ? 300 : null }); }) as unknown as typeof fetch;
  await mount(<VoiceTimerToasts />);
  expect(reads).toBe(1);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  expect(reads).toBe(2);
});
