import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle, typeInto } from "@/test-helpers/onboardingDom";
import type { CompanionEvent, Payload, VoiceCompanionAdapter } from "@/lib/voiceCompanion/contract";
import type { CompanionSettings } from "@/lib/voiceCompanion/storage";

/*
 * The voice companion's product seams (#2519 C, D, H): the shell's mount, the
 * settings rows and the store the floating component reads. The routes are
 * stubbed with the answers the real ones give. No session route may be asked
 * for anything here: mounting, enabling and a refused Talk start no call.
 */

const harness = installOnboardingDom();
installActEnv();
/* The floating component reads the page through the window's own globals. */
const view = harness.dom as unknown as Window & typeof globalThis;
Object.assign(globalThis, {
  innerWidth: 1440, innerHeight: 900,
  getComputedStyle: view.getComputedStyle.bind(view), addEventListener: view.addEventListener.bind(view), removeEventListener: view.removeEventListener.bind(view),
  MutationObserver: view.MutationObserver, NodeFilter: view.NodeFilter,
});
const { createRoot } = await import("react-dom/client");
const { VoiceCompanionHost } = await import("./VoiceCompanionHost");
const { VoiceCompanionSetting } = await import("./VoiceCompanionSetting");
const { COMPANION_SETTINGS_EVENT } = await import("./hostSurfaces");
const { createCompanionStore } = await import("@/hooks/useVoiceCompanion");
const { companionErrorMessage } = await import("@/lib/voiceCompanion/errors");

const FAKE_KEY = ["fixture", "voice", "value", "42"].join("-");
const settingsOf = (over: Partial<CompanionSettings> = {}): CompanionSettings => ({
  enabled: false, backend: "official-realtime", monthlyCapUsd: 20, keySource: "missing", keyEnvironment: "OPENAI_API_KEY",
  month: "2026-10", usageUsd: 0, reservedUsd: 0, incomplete: false, ...over,
});

/** The settings and key routes over one document, as the Viewer serves them. */
function routes(initial: CompanionSettings) {
  const document = { ...initial };
  harness.setRoute((url, init) => {
    const path = new URL(url, "http://127.0.0.1:8898").pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    if (path === "/api/voice-companion/settings") { if (body) Object.assign(document, body); return jsonResponse(document); }
    if (path === "/api/voice-companion/key") {
      if (document.keySource === "env") return jsonResponse({ code: "KEY_FROM_ENV" }, 409);
      document.keySource = "file";
      return jsonResponse(document);
    }
    if (path === "/api/orchestrator/seat") return jsonResponse({ seat: null, pending: null, lastFailure: null, exists: true, viewerMcpRegistered: false, previous: [], currentTask: null, all: null });
    return undefined;
  });
  return document;
}
const sessionCalls = () => harness.calls.filter((call) => call.url.includes("/api/voice-companion/session"));

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
});
async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(node));
  await act(async () => settle());
  return host;
}
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => settle());
};

test("off by default the shell mounts nothing, and on a phone it does not even read the settings", async () => {
  routes(settingsOf());
  await mount(<VoiceCompanionHost project="atlas" mobile={false} />);
  expect(document.querySelector("[data-voice-companion]")).toBeNull();
  expect(harness.calls.map((call) => call.url)).toEqual(["/api/voice-companion/settings"]);
  await act(async () => mounted!.root.unmount());
  mounted!.host.remove();
  mounted = null;

  routes(settingsOf({ enabled: true, backend: "demo" }));
  await mount(<VoiceCompanionHost project="atlas" mobile />);
  expect(document.querySelector("[data-voice-companion]")).toBeNull();
  expect(harness.calls).toEqual([]);
});

test("turned on, it mounts without starting a call; Talk with no key or a reached cap is refused in words and no session is asked for", async () => {
  for (const [over, code] of [[{ keySource: "missing" }, "NO_KEY"], [{ keySource: "file", usageUsd: 19.8, reservedUsd: 0.27 }, "CAP_REACHED"]] as const) {
    routes(settingsOf({ enabled: true, ...over }));
    await mount(<VoiceCompanionHost project="atlas" mobile={false} />);
    const companion = document.querySelector<HTMLElement>("[data-voice-companion]");
    expect(companion?.dataset.mode).toBe("official-realtime");
    expect(companion?.dataset.phase).toBe("offline");
    expect(sessionCalls()).toEqual([]);
    await click(document.querySelector("[data-companion-talk]"));
    const notice = document.querySelector<HTMLElement>(`[data-companion-notice][data-code="${code}"]`);
    expect(notice?.querySelector(".vc-notice-text")?.textContent).toBe(companionErrorMessage(code, "en"));
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.querySelector("[data-companion-open-settings]")).toBeTruthy();
    expect(document.querySelector("[data-voice-companion]")?.hasAttribute("data-starting")).toBe(false);
    expect(sessionCalls()).toEqual([]);
    await act(async () => mounted!.root.unmount());
    mounted!.host.remove();
    mounted = null;
  }
});

test("on a view with no project, Talk says to open one and starts nothing", async () => {
  routes(settingsOf({ enabled: true, backend: "demo" }));
  await mount(<VoiceCompanionHost project={null} mobile={false} />);
  await click(document.querySelector("[data-companion-talk]"));
  expect(document.querySelector('[data-companion-notice][data-code="NO_PROJECT"] .vc-notice-text')?.textContent).toBe(companionErrorMessage("NO_PROJECT", "en"));
  expect(document.querySelector<HTMLElement>("[data-voice-companion]")?.dataset.phase).toBe("offline");
  expect(sessionCalls()).toEqual([]);
});

test("the settings rows: the switch reveals the rest, the key is sent once and never shown again, the cap is saved, the demo is a choice", async () => {
  const stored = routes(settingsOf());
  let announced = 0;
  const heard = () => { announced += 1; };
  window.addEventListener(COMPANION_SETTINGS_EVENT, heard);
  try {
    const host = await mount(<VoiceCompanionSetting />);
    const section = host.querySelector("[data-voice-companion-setting]")!;
    expect(section.querySelector<HTMLInputElement>("[data-voice-companion-enable]")!.checked).toBe(false);
    expect(section.querySelector("[data-voice-companion-key], [data-voice-companion-cap], [data-voice-companion-backend]")).toBeNull();
    await click(section.querySelector("[data-voice-companion-enable]"));
    expect(stored.enabled).toBe(true);
    expect(announced).toBe(1);

    const form = section.querySelector<HTMLFormElement>("[data-voice-companion-key]")!;
    const input = form.querySelector<HTMLInputElement>("input")!;
    expect(input.type).toBe("password");
    expect(form.dataset.keySource).toBe("missing");
    await act(async () => typeInto(input, FAKE_KEY));
    await click(form.querySelector('button[type="submit"]'));
    const keyCalls = harness.calls.filter((call) => call.url === "/api/voice-companion/key");
    expect(keyCalls).toEqual([{ url: "/api/voice-companion/key", method: "PUT", body: { key: FAKE_KEY } }]);
    expect(form.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(section.querySelector<HTMLFormElement>("[data-voice-companion-key]")!.dataset.keySource).toBe("file");
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(FAKE_KEY);

    const cap = section.querySelector<HTMLInputElement>("[data-voice-companion-cap] input")!;
    expect(cap.value).toBe("20");
    await act(async () => typeInto(cap, "35,5"));
    await act(async () => { cap.dispatchEvent(new window.Event("focusout", { bubbles: true })); });
    await act(async () => settle());
    expect(stored.monthlyCapUsd).toBe(35.5);
    expect(section.querySelector("[data-voice-companion-usage]")?.textContent).toContain("$35.50");

    await click(section.querySelector('[data-backend="demo"]'));
    expect(stored.backend).toBe("demo");
    expect(section.querySelector('[data-backend="demo"]')?.getAttribute("aria-checked")).toBe("true");
    expect(harness.calls.filter((call) => call.method === "PUT" && call.url === "/api/voice-companion/settings").map((call) => call.body)).toEqual([{ enabled: true }, { monthlyCapUsd: 35.5 }, { backend: "demo" }]);
    expect(sessionCalls()).toEqual([]);
  } finally { window.removeEventListener(COMPANION_SETTINGS_EVENT, heard); }
});

test("a key from the environment takes precedence: it is said so and the field is closed", async () => {
  routes(settingsOf({ enabled: true, keySource: "env" }));
  const host = await mount(<VoiceCompanionSetting />);
  const form = host.querySelector<HTMLFormElement>("[data-voice-companion-key]")!;
  expect(form.dataset.keySource).toBe("env");
  expect(form.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(form.querySelector("[data-voice-companion-key-status]")?.textContent).toContain("OPENAI_API_KEY");
  expect(harness.calls.filter((call) => call.url === "/api/voice-companion/key")).toEqual([]);
});

test("the store renders nothing for a level sample, resets on a new session and holds an old error back until the next session is ready", async () => {
  const listeners = new Set<(event: CompanionEvent) => void>();
  let session = 0;
  let seq = 0;
  let closes = 0;
  const emit = (payload: Payload, sessionId = `session-${session}`) => {
    const event = { ...payload, version: 1, sessionId, generation: 1, eventId: `event-${seq}`, seq: seq += 1, atMs: seq } as CompanionEvent;
    for (const listener of [...listeners]) listener(event);
  };
  let ready: (() => void) | null = null;
  const adapter: VoiceCompanionAdapter = {
    mode: "official-realtime",
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => new Promise<void>((resolve) => { session += 1; ready = () => { emit({ type: "session.ready", mode: "official-realtime" }); resolve(); }; }),
    command: async () => undefined,
    close: async () => { closes += 1; },
  };
  const store = createCompanionStore(adapter);
  const disconnect = store.connect();
  let renders = 0;
  let levels = 0;
  store.subscribe(() => { renders += 1; });
  store.onLevel(() => { levels += 1; });

  const first = store.start({ locale: "en", project: "atlas" });
  expect(store.awaiting()).toBe(true);
  ready!();
  await first;
  expect([store.awaiting(), store.get().phase]).toEqual([false, "idle"]);
  emit({ type: "transcript.final", speaker: "companion", itemId: "line", text: "Hello." });
  emit({ type: "playback.started", responseId: "response", itemId: "line" });
  const before = renders;
  for (let sample = 0; sample < 30; sample += 1) emit({ type: "playback.level", responseId: "response", itemId: "line", rms: 0.2 + sample / 100, playedMs: sample * 16 });
  expect(renders).toBe(before);
  expect(levels).toBe(30);
  emit({ type: "error", code: "PROVIDER_ERROR", recoverable: false });
  expect([store.get().error, store.get().phase]).toEqual(["PROVIDER_ERROR", "offline"]);

  const second = store.start({ locale: "en", project: "atlas" });
  /* The state still holds the first conversation and its error; the flag says they are not this one's. */
  expect([store.awaiting(), store.get().error]).toEqual([true, "PROVIDER_ERROR"]);
  ready!();
  await second;
  expect([store.awaiting(), store.get().error, store.get().lines.length, store.get().phase]).toEqual([false, null, 0, "idle"]);
  /* A late event of the retired session changes nothing. */
  emit({ type: "session.closed", reason: "transport" }, "session-1");
  expect(store.get().phase).toBe("idle");

  disconnect();
  expect(closes).toBe(1);
  expect(listeners.size).toBe(0);
});
