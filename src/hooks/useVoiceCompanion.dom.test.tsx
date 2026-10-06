import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useVoiceCompanion, type VoiceCompanionHook } from "./useVoiceCompanion";
import { useVoiceCompanionSettings, type VoiceCompanionSettingsHook } from "./useVoiceCompanionSettings";
import type { CompanionEvent, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";

const dom = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
const overrides = { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const saved = new Map<string, { present: boolean; value: unknown }>();
const originalFetch = globalThis.fetch;
beforeAll(() => {
  for (const [key, value] of Object.entries(overrides)) { saved.set(key, { present: key in globals, value: globals[key] }); globals[key] = value; }
});
afterAll(() => {
  for (const [key, value] of saved) { if (value.present) globals[key] = value.value; else delete globals[key]; }
  globalThis.fetch = originalFetch;
  dom.close();
});

test("typed hooks start only on request, reset a new session, release ownership, and keep keys out of settings state", async () => {
  let starts = 0, closes = 0, session = 0;
  const listeners = new Set<(event: CompanionEvent) => void>();
  const adapter: VoiceCompanionAdapter = { mode: "simulated", subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async () => {
      starts++; session++;
      const event: CompanionEvent = { type: "session.ready", mode: "simulated", sessionId: `session-${session}`, version: 1, generation: 1, seq: 1, eventId: `ready-${session}`, atMs: 0 };
      for (const listener of listeners) listener(event);
    }, command: async () => {}, close: async () => { closes++; } };
  globalThis.fetch = (async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    return Response.json(body?.key ? { code: "KEY_FROM_ENV" } : { enabled: false, backend: "demo", monthlyCapUsd: 0, keySource: "missing",
      keyEnvironment: "OPENAI_API_KEY", month: "2026-10", usageUsd: 0, reservedUsd: 0, incomplete: false }, { status: body?.key ? 409 : 200 });
  }) as typeof fetch;
  const seen: { voice: VoiceCompanionHook | null; settings: VoiceCompanionSettingsHook | null } = { voice: null, settings: null };
  function Harness() { seen.voice = useVoiceCompanion(adapter); seen.settings = useVoiceCompanionSettings(true); return null; }
  const root = createRoot(dom.document.createElement("div"));
  try {
    await act(async () => { root.render(<Harness />); });
    expect(starts).toBe(0);
    expect(seen.voice!.state.phase).toBe("offline");
    await act(async () => { await seen.voice!.start({ project: "fixture", locale: "en" }); });
    expect(starts).toBe(1);
    expect(seen.voice!.state.phase).toBe("idle");
    await act(async () => { await seen.voice!.start({ project: "another-fixture", locale: "uk" }); });
    expect(seen.voice!.state.generation).toBe(1);
    expect(seen.voice!.state.seen.has("ready-1")).toBe(false);
    await act(async () => { expect(await seen.settings!.saveKey("synthetic-credential")).toBe(false); });
    expect(seen.settings!.error).toBe("KEY_FROM_ENV");
    expect(JSON.stringify(seen.settings!.settings)).not.toContain("synthetic-credential");
  } finally { await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; }
  expect(closes).toBe(1);
  expect(listeners.size).toBe(0);
});
