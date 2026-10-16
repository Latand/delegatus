import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import type { CompanionSettings } from "@/lib/voiceCompanion/storage";

import { useVoiceCompanionSettings, type VoiceCompanionSettingsHook } from "./useVoiceCompanionSettings";

/* Audit B24: a voice companion setting shows at once and locks nothing; a
   refusal puts the stored value back, unless a newer write answered over it. */

const dom = new Window();
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement });

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let seen: VoiceCompanionSettingsHook | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  seen = null;
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

const STORED = { enabled: true, callMemory: false, backend: "openai", monthlyCapUsd: 10, keySource: "file", keyEnvironment: "OPENAI_API_KEY", month: "2026-10", usageUsd: 1, reservedUsd: 0, incomplete: false, uncertainSession: false } as unknown as CompanionSettings;

function holdPuts() {
  const puts: unknown[] = [];
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "PUT") return Response.json(STORED);
    puts.push(JSON.parse(String(init.body)));
    return new Promise<Response>((resolve) => { pending.push(resolve); });
  }) as typeof fetch;
  return { puts, answer: (index: number, response: Response) => act(async () => { pending[index]!(response); await new Promise((resolve) => setTimeout(resolve, 0)); }) };
}

async function mount(): Promise<void> {
  function Harness() { seen = useVoiceCompanionSettings(true); return null; }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); await new Promise((resolve) => setTimeout(resolve, 10)); });
}

test("a setting shows at once without marking the panel busy, and a refusal puts the stored value back with the code", async () => {
  const server = holdPuts();
  await mount();
  expect(seen!.settings?.monthlyCapUsd).toBe(10);
  let saving: Promise<boolean> = Promise.resolve(true);
  await act(async () => { saving = seen!.update({ monthlyCapUsd: 25 }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(seen!.settings?.monthlyCapUsd).toBe(25);
  expect(seen!.busy).toBe(false);
  expect(server.puts).toEqual([{ monthlyCapUsd: 25 }]);
  await server.answer(0, Response.json({ code: "CAP_INVALID" }, { status: 400 }));
  expect(await saving).toBe(false);
  expect(seen!.settings?.monthlyCapUsd).toBe(10);
  expect(seen!.error).toBe("CAP_INVALID");
});

test("an older refusal does not undo a newer setting that the server kept", async () => {
  const server = holdPuts();
  await mount();
  await act(async () => { void seen!.update({ callMemory: true }); void seen!.update({ enabled: false }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect([seen!.settings?.callMemory, seen!.settings?.enabled]).toEqual([true, false]);
  await server.answer(1, Response.json({ ...STORED, callMemory: true, enabled: false }));
  await server.answer(0, Response.json({ code: "COMPANION_UNAVAILABLE" }, { status: 503 }));
  expect([seen!.settings?.callMemory, seen!.settings?.enabled]).toEqual([true, false]);
});

test("releasing an uncertain session still waits for the server", async () => {
  const server = holdPuts();
  await mount();
  await act(async () => { void seen!.update({ releaseUncertainSession: true }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(seen!.busy).toBe(true);
  await server.answer(0, Response.json({ ...STORED }));
  expect(seen!.busy).toBe(false);
});

test("two refused writes together leave the stored values, not the first press's prediction", async () => {
  const server = holdPuts();
  await mount();
  await act(async () => { void seen!.update({ callMemory: true }); void seen!.update({ enabled: false }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect([seen!.settings?.callMemory, seen!.settings?.enabled]).toEqual([true, false]);
  await server.answer(0, Response.json({ code: "COMPANION_UNAVAILABLE" }, { status: 503 }));
  /* The first refusal drops its own press only; the second stays drawn. */
  expect([seen!.settings?.callMemory, seen!.settings?.enabled]).toEqual([false, false]);
  await server.answer(1, Response.json({ code: "COMPANION_UNAVAILABLE" }, { status: 503 }));
  expect([seen!.settings?.callMemory, seen!.settings?.enabled]).toEqual([false, true]);
});

test("an older accepted write answering after a newer refusal is kept", async () => {
  const server = holdPuts();
  await mount();
  await act(async () => { void seen!.update({ callMemory: true }); void seen!.update({ enabled: false }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await server.answer(1, Response.json({ code: "COMPANION_UNAVAILABLE" }, { status: 503 }));
  await server.answer(0, Response.json({ ...STORED, callMemory: true }));
  expect([seen!.settings?.callMemory, seen!.settings?.enabled]).toEqual([true, true]);
});
