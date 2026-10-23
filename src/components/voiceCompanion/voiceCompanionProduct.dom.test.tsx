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
const { OPEN_VOICE_COMPANION_SETTINGS_EVENT, VoiceCompanionSetting, VoiceCompanionSettingsHost } = await import("./VoiceCompanionSetting");
const { OPEN_KEYS_EVENT } = await import("@/components/keys/openKeys");
const { COMPANION_SETTINGS_EVENT } = await import("./hostSurfaces");
const { createCompanionStore, RESUME_RECHECK_MS } = await import("@/hooks/useVoiceCompanion");
const { translate } = await import("@/lib/i18n/core");
const { LAYER } = await import("@/components/layers");
const { companionErrorMessage } = await import("@/lib/voiceCompanion/errors");
const { PHONE_VOICE_STORAGE_KEY, readPhoneVoice, resetPhoneVoiceForTests, showPhoneVoice } = await import("./phoneVoiceStore");

const FAKE_KEY = ["fixture", "voice", "value", "42"].join("-");
const settingsOf = (over: Partial<CompanionSettings> = {}): CompanionSettings => ({
  enabled: false, callMemory: true, backend: "api", monthlyCapUsd: 20, keySource: "missing", keyEnvironment: "OPENAI_API_KEY",
  month: "2026-10", usageUsd: 0, reservedUsd: 0, incomplete: false, uncertainSession: false, ...over,
});

/** The settings and key routes over one document, as the Viewer serves them. */
function routes(initial: CompanionSettings) {
  const document = { ...initial };
  harness.setRoute((url, init) => {
    const path = new URL(url, "http://127.0.0.1:8898").pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    if (path === "/api/voice-companion/memory") return jsonResponse({ calls: [] });
    if (path === "/api/voice-companion/settings") {
      if (body?.releaseUncertainSession === true) document.uncertainSession = false;
      else if (body) Object.assign(document, body);
      return jsonResponse(document);
    }
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
/** The backend rows' controls; the «Microphone and speakers» section has its own test (VoiceDevicesSetting.dom.test.tsx). */
const settingsControls = (section: Element) => [...section.querySelectorAll("input, button, select")].filter(control => !control.closest("[data-voice-devices]"));
const sessionCalls = () => harness.calls.filter((call) => call.url.includes("/api/voice-companion/session"));

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
  localStorage.removeItem(PHONE_VOICE_STORAGE_KEY);
  resetPhoneVoiceForTests();
});
async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  /* The shell's resources footer, whose arrival the companion waits for before it first appears; beside the
     root, which the render empties. */
  const footer = document.createElement("div");
  footer.setAttribute("data-resources-footer", "");
  host.append(footer);
  document.body.append(host);
  const container = document.createElement("div");
  host.append(container);
  const root = createRoot(container);
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

test("off by default the shell mounts nothing on either surface; on the phone, turned on, it mounts the head and no desktop window, and asks for no session", async () => {
  routes(settingsOf());
  await mount(<VoiceCompanionHost project="atlas" mobile={false} />);
  expect(document.querySelector("[data-voice-companion]")).toBeNull();
  expect(harness.calls.map((call) => call.url)).toEqual(["/api/voice-companion/settings"]);
  await unmountNow();

  /* The phone reads the settings as the desktop does, and while off mounts nothing and offers nothing to show. */
  routes(settingsOf());
  await mount(<VoiceCompanionHost project="atlas" mobile />);
  expect(document.querySelector("[data-phone-voice], [data-voice-companion]")).toBeNull();
  expect(harness.calls.map((call) => call.url)).toEqual(["/api/voice-companion/settings"]);
  expect(readPhoneVoice().available).toBe(false);
  await unmountNow();

  routes(settingsOf({ enabled: true, keySource: "file" }));
  await mount(<VoiceCompanionHost project="atlas" mobile />);
  const head = document.querySelector<HTMLElement>("[data-phone-voice]");
  expect(head?.dataset.phase).toBe("offline");
  expect(head?.dataset.mode).toBe("official-realtime");
  expect(head?.querySelector("[data-phone-voice-head]")?.getAttribute("aria-label")).toBe(`Delegatus · ${translate("en", "voiceCompanion.phase.offline")}`);
  expect(document.querySelector("[data-voice-companion]")).toBeNull();
  expect(readPhoneVoice()).toEqual({ hidden: false, side: "right", available: true });
  expect(sessionCalls()).toEqual([]);
  await unmountNow();
  expect(readPhoneVoice().available).toBe(false);
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

test("on Codex, Talk with no key and a spent dollar cap asks the session route, and a refusal at the plan limit names its reset", async () => {
  const live = await liveHarness();
  const resetsAt = Math.floor(Date.now() / 1000) + 7_200;
  /* No key anywhere and a spent dollar cap from an earlier build: neither stops a call on the subscription. */
  const settings = settingsOf({ enabled: true, backend: "codex", keySource: "missing", usageUsd: 25 });
  harness.setRoute((url) => {
    const path = new URL(url, "http://127.0.0.1:8898").pathname;
    if (path === "/api/voice-companion/memory") return jsonResponse({ calls: [] });
    if (path === "/api/voice-companion/settings") return jsonResponse(settings);
    if (path === "/api/orchestrator/seat") return jsonResponse({ seat: null, pending: null, lastFailure: null, exists: true, viewerMcpRegistered: false, previous: [], currentTask: null, all: null });
    if (path === "/api/voice-companion/session") return jsonResponse({ code: "CODEX_LIMIT_REACHED", resetsAt }, 409);
    return undefined;
  });
  try {
    await mount(<VoiceCompanionHost project="atlas" mobile={false} />);
    const companion = document.querySelector<HTMLElement>("[data-voice-companion]");
    expect(companion?.dataset.mode).toBe("official-realtime");
    expect(companion?.dataset.phase).toBe("offline");
    expect(sessionCalls()).toEqual([]);
    await click(document.querySelector("[data-companion-talk]"));
    await pause(120);
    /* The start reaches the route with no key read; the refused request is then released by its own id. */
    expect(sessionCalls().map((call) => (call.body as { action?: string }).action)).toEqual(["start", "close"]);
    expect(document.querySelector('[data-companion-notice][data-code="NO_KEY"], [data-companion-notice][data-code="CAP_REACHED"]')).toBeNull();
    const notice = document.querySelector<HTMLElement>('[data-companion-notice][data-code="CODEX_LIMIT_REACHED"]');
    expect(notice?.querySelector(".vc-notice-text")?.textContent).toBe(companionErrorMessage("CODEX_LIMIT_REACHED", "en", { resetsAt }));
    expect(notice?.querySelector(".vc-notice-text")?.textContent).toContain("The first one resets: ");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(live.trackStops()).toBe(1);
  } finally { await unmountNow(); await live.release(); }
});

test("the first placement is on screen and a change of project preserves the companion root", async () => {
  routes(settingsOf({ enabled: true, keySource: "file" }));
  /* The root stands at −9999 px, hidden, until its first placement. That placement is committed with the root's
     transition off (`data-move="jump"`), which a timer lifts 280 ms later: read before then, the root that has just
     become visible shows how it got there. Shown with its transition on, it would travel from off screen. */
  const placedAt = () => {
    const root = document.querySelector<HTMLElement>("[data-voice-companion]")!;
    return { root, placed: root.hasAttribute("data-placed"), move: root.getAttribute("data-move"), transform: root.style.transform };
  };
  const host = await mount(<VoiceCompanionHost project="atlas" mobile={false} />);
  const first = placedAt();
  expect({ ...first, root: null }).toEqual({ root: null, placed: true, move: "jump", transform: expect.not.stringContaining("-9999") });
  /* Browser context changes preserve the mounted companion. */
  await act(async () => mounted!.root.render(<VoiceCompanionHost project="borealis" mobile={false} />));
  await act(async () => settle());
  const second = placedAt();
  expect(host.querySelectorAll("[data-voice-companion]").length).toBe(1);
  expect(second.root).toBe(first.root);
  expect({ ...second, root: null }).toEqual({ root: null, placed: true, move: "jump", transform: expect.not.stringContaining("-9999") });
  /* And once the jump is over, the root's own transition is back for the moves that follow. */
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(placedAt().move).toBeNull();
});

test("on a view with no project, Talk says to open one and starts nothing", async () => {
  routes(settingsOf({ enabled: true }));
  await mount(<VoiceCompanionHost project={null} mobile={false} />);
  await click(document.querySelector("[data-companion-talk]"));
  expect(document.querySelector('[data-companion-notice][data-code="NO_PROJECT"] .vc-notice-text')?.textContent).toBe(companionErrorMessage("NO_PROJECT", "en"));
  expect(document.querySelector<HTMLElement>("[data-voice-companion]")?.dataset.phase).toBe("offline");
  expect(sessionCalls()).toEqual([]);
});

test("the settings rows: the switch reveals the choice of voice with the API chosen, its key opens «Keys» on the OpenAI key, its cap is saved; Codex shows the last call and its plan window and asks for no key", async () => {
  const stored = routes(settingsOf());
  let announced = 0;
  const heard = () => { announced += 1; };
  const asked: unknown[] = [];
  const askedKeys = (event: Event) => asked.push((event as CustomEvent).detail);
  window.addEventListener(COMPANION_SETTINGS_EVENT, heard);
  window.addEventListener(OPEN_KEYS_EVENT, askedKeys);
  try {
    const host = await mount(<VoiceCompanionSetting />);
    const section = host.querySelector("[data-voice-companion-setting]")!;
    expect(section.querySelector<HTMLInputElement>("[data-voice-companion-enable]")!.checked).toBe(false);
    expect(section.querySelector("[data-voice-companion-key], [data-voice-companion-cap], [data-voice-companion-backend]")).toBeNull();
    await click(section.querySelector("[data-voice-companion-enable]"));
    expect(stored.enabled).toBe(true);
    expect(announced).toBe(1);

    /* The key is entered in «Keys»: this row says where it comes from and opens that page on it. */
    const keyRow = section.querySelector<HTMLElement>("[data-voice-companion-key]")!;
    expect(keyRow.dataset.keySource).toBe("missing");
    expect(keyRow.querySelector("input, form")).toBeNull();
    expect(keyRow.querySelector("[data-voice-companion-key-status]")?.textContent).toContain(translate("en", "voiceCompanion.settings.key.missing"));
    await click(keyRow.querySelector("[data-voice-companion-open-keys]"));
    expect(asked).toEqual([{ key: "openai" }]);
    expect(harness.calls.filter((call) => call.url === "/api/voice-companion/key")).toEqual([]);

    const cap = section.querySelector<HTMLInputElement>("[data-voice-companion-cap] input")!;
    expect(cap.value).toBe("20");
    await act(async () => typeInto(cap, "35,5"));
    await act(async () => { cap.dispatchEvent(new window.Event("focusout", { bubbles: true })); });
    await act(async () => settle());
    expect(stored.monthlyCapUsd).toBe(35.5);
    expect(section.querySelector("[data-voice-companion-usage]")?.textContent).toContain("$35.50");

    /* On is a real voice, the API or Codex V3, and never a demo: one two-option choice beside the key and the cap. */
    const choice = section.querySelector<HTMLElement>("[role='radiogroup'][data-voice-companion-backend]")!;
    expect([...choice.querySelectorAll<HTMLInputElement>("input[type='radio']")].map((radio) => [radio.value, radio.checked])).toEqual([["api", true], ["codex", false]]);
    expect([choice.querySelector("[data-voice-backend='api'] label")!.textContent, choice.querySelector("[data-voice-backend='codex'] label")!.textContent]).toEqual(["Through the API (with a key)", "Codex V3 (subscription)"]);
    expect(settingsControls(section)).toHaveLength(7);
    expect(section.querySelector("[data-call-memory]")).not.toBeNull();
    expect(section.textContent).not.toMatch(/demo|демо/iu);
    expect(harness.calls.filter((call) => call.method === "PUT" && call.url === "/api/voice-companion/settings").map((call) => call.body)).toEqual([{ enabled: true }, { monthlyCapUsd: 35.5 }]);

    /* Codex chosen: the key and the cap close and nothing asks for a key; the last Codex call shows with its plan window. */
    const now = Math.floor(Date.now() / 1000);
    stored.lastCodexSession = { seconds: 471, endedAt: Date.UTC(2026, 9, 10, 9), plan: { type: "pro", primary: { usedPercent: 23, resetsAt: now + 7_200, windowMinutes: 300 }, secondary: { usedPercent: 77, resetsAt: now + 4 * 86_400, windowMinutes: 10_080 }, limitReached: false, observedAt: now * 1000 } };
    await click(choice.querySelector("input[value='codex']"));
    expect(stored.backend).toBe("codex");
    expect(section.querySelector("[data-voice-companion-key], [data-voice-companion-cap], [data-voice-companion-usage]")).toBeNull();
    const codex = section.querySelector<HTMLElement>("[data-voice-backend='codex'] [data-voice-companion-codex]")!;
    expect(codex.querySelector("[data-voice-companion-last-call]")?.textContent).toBe("Last call: 7:51 · Oct 10.");
    /* The plan reads as one short line a window, its figure emphasised, between the whole-account note and the muted
       reading time; times are the board's 24-hour form and a window's number never parts from its unit. */
    const planBlock = codex.querySelector<HTMLElement>("[data-voice-companion-plan]")!;
    expect([...planBlock.children].map((node) => node.textContent)).toEqual([
      "Pro plan, the whole account with its agents",
      expect.stringMatching(/^5\u00a0h 23%, resets \d\d:\d\d$/u),
      expect.stringMatching(/^week 77%, resets [A-Z][a-z]{2} \d{1,2}$/u),
      expect.stringMatching(/^As of \d\d:\d\d\.$/u),
    ]);
    expect([...planBlock.querySelectorAll<HTMLElement>("[data-plan-figure]")].map((node) => [node.textContent, node.className.includes("font-semibold")])).toEqual([["23%", true], ["77%", true]]);
    expect([planBlock.firstElementChild!.className.includes("text-muted"), planBlock.lastElementChild!.className.includes("text-muted"), planBlock.children[1]!.className.includes("text-muted")]).toEqual([true, true, false]);
    expect(planBlock.textContent).not.toMatch(/AM|PM/u);
    expect(settingsControls(section)).toHaveLength(5);
    expect(codex.textContent).not.toMatch(/\bkey\b|OpenAI|\$/iu);
    expect(harness.calls.filter((call) => call.method === "PUT" && call.url === "/api/voice-companion/settings").map((call) => call.body)).toEqual([{ enabled: true }, { monthlyCapUsd: 35.5 }, { backend: "codex" }]);
    expect(sessionCalls()).toEqual([]);
  } finally { window.removeEventListener(COMPANION_SETTINGS_EVENT, heard); window.removeEventListener(OPEN_KEYS_EVENT, askedKeys); }
});

test("a session a lost mint answer may have opened is said in settings, and only the operator's release lets a new call start", async () => {
  const stored = routes(settingsOf({ enabled: true, keySource: "file", usageUsd: 0.27, incomplete: true, uncertainSession: true }));
  const host = await mount(<VoiceCompanionSetting />);
  const notice = host.querySelector("[data-voice-companion-uncertain]");
  expect(notice?.textContent).toContain(companionErrorMessage("MINT_UNCERTAIN", "en"));
  expect(notice?.textContent).not.toMatch(/five minutes/u);
  await click(notice!.querySelector("button"));
  expect(harness.calls.filter((call) => call.method === "PUT" && call.url === "/api/voice-companion/settings").map((call) => call.body)).toEqual([{ releaseUncertainSession: true }]);
  expect(stored.uncertainSession).toBe(false);
  expect(host.querySelector("[data-voice-companion-uncertain]")).toBeNull();
  expect(sessionCalls()).toEqual([]);
});

test("a key from the environment takes precedence: it is said so, with no field, and «Keys» still opens on it", async () => {
  routes(settingsOf({ enabled: true, keySource: "env" }));
  const host = await mount(<VoiceCompanionSetting />);
  const keyRow = host.querySelector<HTMLElement>("[data-voice-companion-key]")!;
  expect(keyRow.dataset.keySource).toBe("env");
  expect(keyRow.querySelector("input")).toBeNull();
  expect(keyRow.querySelector("[data-voice-companion-key-status]")?.textContent).toContain("OPENAI_API_KEY");
  expect(keyRow.querySelector("[data-voice-companion-open-keys]")).not.toBeNull();
  expect(harness.calls.filter((call) => call.url === "/api/voice-companion/key")).toEqual([]);
});

test("«Open Keys» closes the settings dialog, so the menu's «Keys» page is not under it", async () => {
  routes(settingsOf({ enabled: true, keySource: "file" }));
  await mount(<VoiceCompanionSettingsHost />);
  await act(async () => { window.dispatchEvent(new Event(OPEN_VOICE_COMPANION_SETTINGS_EVENT)); });
  await act(async () => settle());
  expect(document.querySelector("[data-voice-companion-settings]")).not.toBeNull();
  await click(document.querySelector("[data-voice-companion-open-keys]"));
  expect(document.querySelector("[data-voice-companion-settings]")).toBeNull();
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

/*
 * The live path whole (#2519 C, G, H): the shell's mount, the real adapter, the
 * production session route and the session service over the local fake provider.
 * Only the browser's media objects are stand-ins; nothing leaves the process.
 */
test("the store offers a call back only after a drop that followed speech, keeps it through a failed reconnect, and withdraws it when the Viewer refuses", async () => {
  const listeners = new Set<(event: CompanionEvent) => void>();
  let seq = 0;
  const emit = (sessionId: string, payload: Payload) => {
    const event = { ...payload, version: 1, sessionId, generation: 1, eventId: `event-${seq}`, seq: seq += 1, atMs: seq } as CompanionEvent;
    for (const listener of [...listeners]) listener(event);
  };
  let next: { id: string; failure: string | null } = { id: "call-1", failure: null };
  let offered: { sessionId: string; project: string | null } | null = null;
  const adapter: VoiceCompanionAdapter = {
    mode: "official-realtime",
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: async () => {
      if (next.failure) { emit(`local-${seq}`, { type: "session.ready", mode: "official-realtime" }); emit(`local-${seq - 1}`, { type: "error", code: next.failure, recoverable: false }); throw new Error(next.failure); }
      emit(next.id, { type: "session.ready", mode: "official-realtime" });
    },
    command: async () => undefined,
    close: async () => undefined,
    resumable: async () => offered,
  };
  const store = createCompanionStore(adapter);
  const disconnect = store.connect();
  await act(async () => settle());
  expect(store.get().resumable).toBeNull();

  /* A drop before anything was said, and a hang-up after speech, offer nothing. */
  await store.start({ locale: "en", project: "atlas" });
  emit("call-1", { type: "session.closed", reason: "transport", incomplete: false });
  expect(store.get().resumable).toBeNull();
  next = { id: "call-2", failure: null };
  await store.start({ locale: "en", project: "atlas" });
  emit("call-2", { type: "transcript.final", speaker: "operator", itemId: "said", text: "Check the build." });
  emit("call-2", { type: "session.closed", reason: "operator", incomplete: false });
  expect(store.get().resumable).toBeNull();

  /* A lost connection after speech offers the call, and the lines stay. */
  next = { id: "call-3", failure: null };
  await store.start({ locale: "en", project: "atlas" });
  emit("call-3", { type: "transcript.final", speaker: "operator", itemId: "said", text: "Check the build." });
  emit("call-3", { type: "error", code: "CONNECTION_LOST", recoverable: false });
  expect(store.get().resumable).toEqual({ sessionId: "call-3", project: null });
  expect(store.get().lines.map((line) => line.text)).toEqual(["Check the build."]);

  /* A reconnect whose request is lost keeps the offer and the lines; one the Viewer refuses withdraws it. */
  next = { id: "call-4", failure: "COMPANION_UNAVAILABLE" };
  await expect(store.start({ locale: "en", project: "atlas", resume: "call-3" })).rejects.toThrow("COMPANION_UNAVAILABLE");
  expect([store.get().resumable?.sessionId, store.get().reconnected]).toEqual(["call-3", false]);
  expect(store.get().lines.map((line) => line.text)).toEqual(["Check the build."]);
  next = { id: "call-4", failure: "SESSION_UNAVAILABLE" };
  await expect(store.start({ locale: "en", project: "atlas", resume: "call-3" })).rejects.toThrow("SESSION_UNAVAILABLE");
  expect([store.get().resumable, store.get().reconnected, store.get().error]).toEqual([null, false, "SESSION_UNAVAILABLE"]);

  /* A reconnect that goes through continues the lines under a newer generation; the next fresh call starts empty. */
  emit("call-3", { type: "session.closed", reason: "transport", incomplete: false });
  offered = { sessionId: "call-3", project: "atlas" };
  disconnect();
  const reloaded = createCompanionStore(adapter);
  const release = reloaded.connect();
  await act(async () => settle());
  expect(reloaded.get().resumable).toEqual({ sessionId: "call-3", project: "atlas" });
  next = { id: "call-5", failure: null };
  await reloaded.start({ locale: "en", project: "atlas", resume: "call-3" });
  expect([reloaded.get().resumable, reloaded.get().reconnected, reloaded.get().phase]).toEqual([null, true, "idle"]);
  emit("call-5", { type: "transcript.final", speaker: "companion", itemId: "said", text: "Back again." });
  expect(reloaded.get().lines.map((line) => line.text)).toEqual(["Back again."]);
  next = { id: "call-6", failure: null };
  await reloaded.start({ locale: "en", project: "atlas" });
  expect([reloaded.get().lines.length, reloaded.get().reconnected]).toEqual([0, false]);
  expect(reloaded.get().resumable).toBeNull();
  release();
});

test("the store asks the Viewer again while it answers that nothing dropped, at most three times, and after a drop that left no lines", async () => {
  const listeners = new Set<(event: CompanionEvent) => void>();
  const emit = (sessionId: string, payload: Payload) => {
    const event = { ...payload, version: 1, sessionId, generation: 1, eventId: `event-${sessionId}-${payload.type}`, seq: 1, atMs: 1 } as CompanionEvent;
    for (const listener of [...listeners]) listener(event);
  };
  const delays: number[] = [];
  let due: (() => void) | null = null;
  const schedule = (run: () => void, ms: number) => { delays.push(ms); due = run; return () => { if (due === run) due = null; }; };
  const fire = async () => { const run = due; due = null; run?.(); await act(async () => settle()); };
  let answers: Array<{ sessionId: string; project: string | null } | null | "fails"> = [];
  let asked = 0;
  const adapter: VoiceCompanionAdapter = {
    mode: "official-realtime",
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: async () => { emit("call-2", { type: "session.ready", mode: "official-realtime" }); },
    command: async () => undefined,
    close: async () => undefined,
    resumable: async () => { asked += 1; const answer = answers.shift() ?? null; if (answer === "fails") throw new Error("offline"); return answer; },
  };

  /* Null, a failed question, then the call: offered on the third recheck's answer, no remount. */
  answers = [null, "fails", { sessionId: "call-1", project: "atlas" }];
  const store = createCompanionStore(adapter, { schedule });
  const release = store.connect();
  await act(async () => settle());
  expect([asked, store.get().resumable, delays]).toEqual([1, null, [RESUME_RECHECK_MS]]);
  await fire();
  expect([asked, store.get().resumable]).toEqual([2, null]);
  await fire();
  expect([asked, store.get().resumable, due]).toEqual([3, { sessionId: "call-1", project: "atlas" }, null]);

  /* A resumed part drops before anything is said here: the store asks instead of reading its empty lines. */
  await store.start({ locale: "en", project: "atlas", resume: "call-1" });
  expect([store.get().reconnected, store.get().lines.length]).toEqual([true, 0]);
  answers = [{ sessionId: "call-2", project: "atlas" }];
  emit("call-2", { type: "session.closed", reason: "transport", incomplete: false });
  await act(async () => settle());
  expect([asked, store.get().resumable]).toEqual([4, { sessionId: "call-2", project: "atlas" }]);
  /* A hang-up asks nothing. */
  await store.start({ locale: "en", project: "atlas" });
  emit("call-2", { type: "session.closed", reason: "operator", incomplete: false });
  await act(async () => settle());
  expect(asked).toBe(4);
  release();

  /* A Viewer that keeps answering null is asked four times in all, then left alone. */
  answers = [];
  asked = 0;
  const quiet = createCompanionStore(adapter, { schedule });
  const gone = quiet.connect();
  await act(async () => settle());
  for (let recheck = 0; recheck < 5; recheck += 1) await fire();
  expect([asked, quiet.get().resumable, due]).toEqual([4, null, null]);
  gone();
});

async function liveHarness() {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voice-live-dom-"));
  const before = { state: process.env.LLV_STATE_DIR, config: process.env.XDG_CONFIG_HOME, key: process.env.OPENAI_API_KEY };
  Object.assign(process.env, { LLV_STATE_DIR: path.join(stateRoot, "state"), XDG_CONFIG_HOME: path.join(stateRoot, "config"), OPENAI_API_KEY: "" });
  const { NextRequest } = await import("next/server");
  const { FakeLiveProvider, backendResponse, delegationCreated, functionCall, message } = await import("@/lib/voiceCompanion/fakeProvider");
  const { CompanionBoardReads } = await import("@/lib/voiceCompanion/boardReads");
  const { CompanionStorage } = await import("@/lib/voiceCompanion/storage");
  const { CompanionAdmission } = await import("@/lib/voiceCompanion/admission");
  const { CompanionLiveSessions } = await import("@/lib/voiceCompanion/liveSession");
  const { setCompanionSessionsForTests } = await import("@/lib/voiceCompanion/server");
  const route = await import("@/app/api/voice-companion/session/route");
  const callsRoute = await import("@/app/api/voice-companion/calls/route");
  const storage = new CompanionStorage();
  storage.updateSettings({ enabled: true });
  const provider = new FakeLiveProvider();
  const sent: string[] = [];
  const reportList: import("@/lib/bridge/types").BridgeReportV1[] = [];
  const admission = new CompanionAdmission(storage, {
    recipient: project => ({ project, conversationId: `conversation_${project}`, seatEpoch: 1, engine: "claude" }),
    send: async binding => { sent.push(binding.delivery.clientMessageId); return { status: "queued", operationId: `operation-${sent.length}` }; }, reports: () => reportList });
  const reads = new CompanionBoardReads({
    call: async (_name, args) => ({ tasks: ["project-a", "project-b"].filter(project => project === args.project).map(project => ({ id: `task-${project}`, project, text: `Task of ${project}`, status: "inbox" })) }),
    projectFor: async () => "project-a", recipient: project => `conversation_${project}`, resolveProject: current => current ?? "project-a",
    review: () => { throw new Error("REVIEW_NOT_FOUND"); }, frame: async () => { throw new Error("FRAME_NOT_FOUND"); },
  });
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => FAKE_KEY, timers: false, closeTimeoutMs: 20 });
  setCompanionSessionsForTests(service);
  const track = { enabled: true, stops: 0, stop() { this.stops += 1; } };
  /* The cues' tones: every oscillator any AudioContext was asked for, by the frequency it was given. */
  const tones: number[] = [];
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  /* Every peer the media opened, so a test can lose the browser's connection as a network drop does. */
  const peers: Array<{ connectionState: string; changed: Array<() => void> }> = [];
  const stand: Record<string, unknown> = {
    RTCPeerConnection: class extends EventTarget {
      changed: Array<() => void> = [];
      constructor() { super(); peers.push(this); }
      addEventListener(type: string, listener: () => void) { if (type === "connectionstatechange") this.changed.push(listener); }
      iceGatheringState = "complete"; connectionState = "connected"; localDescription = { sdp: "v=0\r\n" };
      addTrack() {} createDataChannel() { return Object.assign(new EventTarget(), { close() {} }); }
      async createOffer() { return {}; } async setLocalDescription() {} async setRemoteDescription() {} close() {}
    },
    AudioContext: class {
      state = "running"; currentTime = 0; destination = {}; async resume() {} async close() {}
      createAnalyser() { return { fftSize: 512, getFloatTimeDomainData() {} }; } createMediaStreamSource() { return { connect() {} }; }
      createGain() { const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }; return { gain: param, connect() {} }; }
      createOscillator() { return { type: "", frequency: { set value(hz: number) { tones.push(hz); } }, connect() {}, start() {}, stop() {} }; }
    },
    Audio: class { autoplay = false; paused = true; muted = false; srcObject: unknown = null; pause() {} async play() {} },
    MediaStream: class {},
    /* The media samples its levels once and is not called back: no audio plays here. */
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined,
  };
  const restore = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(stand)) { restore.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => stream }, configurable: true });
  /** fail: "before" loses the request on its way in; "after" loses the reply to a request the Viewer handled. */
  const failing: { command: "before" | "after" | null } = { command: null };
  /** `start`: held until the test settles it, as a slow mint holds a real start. */
  const holding: { start: Promise<void> | null; command: Promise<void> | null } = { start: null, command: null };
  const document = settingsOf({ enabled: true, keySource: "file" });
  harness.setRoute(async (url, init) => {
    const target = new URL(url, "http://127.0.0.1:8898");
    if (target.pathname === "/api/voice-companion/settings") return jsonResponse(document);
    if (target.pathname === "/api/orchestrator/seat") {
      const project = target.searchParams.get("project");
      return jsonResponse({ seat: { project, conversationId: `conversation_${project}`, seatEpoch: 1, engine: "claude" }, pending: null, lastFailure: null, exists: true, viewerMcpRegistered: true, previous: [], currentTask: null, all: null });
    }
    if (target.pathname === "/api/voice-companion/calls") return callsRoute.GET(new NextRequest(`http://127.0.0.1${target.pathname}`, { headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin" } }));
    if (target.pathname === "/api/voice-companion/resume") {
      const resume = await import("@/app/api/voice-companion/resume/route");
      return resume.GET(new NextRequest(`http://127.0.0.1${target.pathname}${target.search}`, { method: "GET", headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin" } }));
    }
    if (target.pathname !== "/api/voice-companion/session") return jsonResponse({ error: "not routed in this test" }, 404);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { action?: string } : null;
    if (body?.action === "start" && holding.start) await holding.start;
    if (body?.action === "command" && holding.command) await holding.command;
    const lost = body?.action === "command" ? failing.command : null;
    if (lost === "before") { failing.command = null; return jsonResponse({ code: "COMPANION_UNAVAILABLE" }, 502); }
    const request = new NextRequest(`http://127.0.0.1${target.pathname}${target.search}`, { method: init?.method ?? "GET", headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin" }, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const answer = await (body ? route.POST(request) : route.GET(request));
    if (lost === "after") { failing.command = null; return jsonResponse({ code: "COMPANION_UNAVAILABLE" }, 502); }
    return answer;
  });
  /** `reason` is the model asking the operator first; without it the request goes at once. */
  const propose = async (providerId: string, instruction: string, reason: string | null = null) => {
    /* Live delegates to the server; its backend raises the request, then speaks. */
    provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("The request is on the card.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${instruction}`, "request_orchestrator_delegation", { instruction, confirmation_reason: reason })]);
    provider.replay(providerId, delegationCreated(`delegation-${instruction}`, 100));
    /* The adapter reads the Viewer every half second. */
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
  };
  /** The operator's spoken answer to the confirmation that waits, passed on by the backend's second tool. */
  const answer = async (providerId: string, decision: "send" | "cancel") => {
    provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("Done.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-answer-${index}`, "resolve_orchestrator_confirmation", { decision })]);
    provider.replay(providerId, delegationCreated(`delegation-answer-${decision}`, 4_000));
    /* The adapter reads the Viewer every half second. */
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
  };
  return {
    storage, provider, sent, failing, propose, answer,
    /** The orchestrator's report on the newest request sent, correlated the way the bridge correlates it. */
    report(body: string, project = "project-a") {
      const id = `report-${reportList.length + 1}`;
      reportList.push({ id, key: id, seq: reportList.length + 1, at: new Date(Date.now() + 1).toISOString(), class: "completed", body, project, correlatesDirective: sent[sent.length - 1],
        origin: { kind: "manager", conversationId: `conversation_${project}`, role: "orchestrator" } });
    }, service, holding, trackStops: () => track.stops,
    /** The browser's network goes: its newest peer connection fails. */
    dropMedia() { const peer = peers.at(-1)!; peer.connectionState = "failed"; for (const listener of peer.changed) listener(); },
    /** Operator and voice speech on a provider session, each turn its own timed fragment. */
    say(providerId: string, turns: Array<["operator" | "voice", string]>, from = 0) {
      turns.forEach(([speaker, text], index) => provider.replay(providerId, { type: speaker === "operator" ? "session.input_transcript.delta" : "session.output_transcript.delta",
        event_id: `${providerId}-turn-${from + index}`, delta: text, start_ms: (from + index) * 4000, end_ms: (from + index) * 4000 + 3000 }));
    }, trackEnabled: () => track.enabled, tones,
    starts: () => harness.calls.filter((call) => (call.body as { action?: string } | null)?.action === "start").length,
    async release() {
      for (const row of Object.values(storage.read().sessions)) if (!row.closed) await service.close(row.id);
      setCompanionSessionsForTests(undefined);
      for (const [name, descriptor] of restore) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
      Reflect.deleteProperty(navigator, "mediaDevices");
      for (const [name, value] of [["LLV_STATE_DIR", before.state], ["XDG_CONFIG_HOME", before.config], ["OPENAI_API_KEY", before.key]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      fs.rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}
const unmountNow = async () => {
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  await act(async () => root.unmount());
  await act(async () => settle());
  host.remove();
};
const pause = (ms = 60) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test("project switches and null context preserve the same live call, transcript and microphone until true unmount", async () => {
  const live = await liveHarness();
  let closed = false, seq = 0;
  const events: CompanionEvent[] = [];
  const emit = (payload: Payload) => events.push({ ...payload, version: 1, sessionId: "same-call", generation: 1, seq: ++seq, eventId: `same-${seq}`, atMs: seq } as CompanionEvent);
  harness.setRoute((url, init) => {
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/voice-companion/memory") return jsonResponse({ calls: [] });
    if (path === "/api/voice-companion/settings") return jsonResponse(settingsOf({ enabled: true, keySource: "file" }));
    if (path === "/api/orchestrator/seat") return jsonResponse({ seat: { project: "atlas", conversationId: "conversation_atlas", seatEpoch: 1, engine: "claude" }, exists: true });
    if (path !== "/api/voice-companion/session") return undefined;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.action === "start") {
      emit({ type: "session.ready", mode: "official-realtime" });
      emit({ type: "transcript.final", speaker: "operator", itemId: "input", text: "Keep this conversation open." });
      return jsonResponse({ sessionId: "same-call", sdp: "fake-answer" });
    }
    if (body?.action === "close") { closed = true; emit({ type: "session.closed", reason: "operator" }); }
    return jsonResponse(body ? { ok: true } : { events });
  });
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    const companion = document.querySelector<HTMLElement>("[data-voice-companion]")!;
    const transcript = document.querySelector("[data-companion-transcript]")?.textContent;
    expect(transcript).toContain("Keep this conversation open.");
    for (const project of ["project-b", null, "project-a"]) {
      await act(async () => mounted!.root.render(<VoiceCompanionHost project={project} mobile={false} />));
      await pause(200);
      expect(document.querySelector("[data-voice-companion]") === companion).toBe(true);
      expect(document.querySelector("[data-companion-transcript]")?.textContent).toBe(transcript);
      expect(closed).toBe(false);
      expect(live.trackStops()).toBe(0);
      expect(live.starts()).toBe(1);
      expect(companion.dataset.phase).not.toBe("offline");
      const contexts = sessionCalls().filter(call => (call.body as { action?: string } | null)?.action === "context");
      expect(contexts.at(-1)?.body).toEqual({ action: "context", sessionId: "same-call", project });
    }
    await unmountNow();
    await pause(100);
    expect(closed).toBe(true);
    expect(live.trackStops()).toBeGreaterThan(0);
  } finally { await unmountNow(); await live.release(); }
});

test("a call whose chosen microphone is gone names the microphone it uses in the status block and says the default was taken", async () => {
  const live = await liveHarness();
  const voiceDevices = await import("@/lib/audio/voiceDevices");
  const track = { enabled: true, stop() {}, label: "Default - Headset Mic", getSettings: () => ({ deviceId: "default" }) };
  const devices = [
    { deviceId: "default", kind: "audioinput", label: "Default - Headset Mic", groupId: "g1" },
    { deviceId: "mic-headset", kind: "audioinput", label: "Headset Mic", groupId: "g1" },
  ];
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }), enumerateDevices: async () => devices,
  } });
  voiceDevices.setVoiceDeviceChoice("input", { id: "usb-gone", label: "USB Microphone" });
  try {
    await mount(<VoiceCompanionHost project="atlas" mobile={false} />);
    expect(document.querySelector("[data-companion-mic]")).toBeNull();
    await click(document.querySelector("[data-companion-talk]"));
    await pause(300);
    const line = document.querySelector("[data-companion-mic]");
    expect(line?.textContent).toBe("Headset Mic");
    expect(document.querySelector("[data-companion-phase]")?.hasAttribute("aria-hidden")).toBe(true);
    const mute = document.querySelector<HTMLElement>(".vc-btn[aria-pressed]")!;
    expect(mute.getAttribute("aria-label")).toBe(`${translate("en", "voiceCompanion.mute")} · ${translate("en", "voiceCompanion.micInUse", { name: "Headset Mic" })}`);
    const notice = document.querySelector('[data-companion-notice][data-code="MICROPHONE_FALLBACK"]');
    expect(notice?.querySelector(".vc-notice-text")?.textContent).toBe(companionErrorMessage("MICROPHONE_FALLBACK", "en"));
    expect(notice?.querySelector("[data-companion-open-settings]")).toBeTruthy();
    expect(voiceDevices.voiceDeviceChoice("input")?.id).toBe("usb-gone");
    await click(document.querySelector("[data-companion-end]"));
    await pause(200);
    expect(document.querySelector("[data-companion-mic]")).toBeNull();
    expect(voiceDevices.activeVoiceInput()).toBeNull();
  } finally {
    voiceDevices.setVoiceDeviceChoice("input", null);
    voiceDevices.configureVoiceDeviceStorage(undefined);
    await unmountNow(); await live.release();
  }
});

for (const backend of ["codex", "api"] as const) test(`a ${backend} call that closes ${backend === "codex" ? "at its plan limit says nothing of a reserved cost" : "without final usage says its reserved cost is retained"}`, async () => {
  const live = await liveHarness();
  let seq = 0;
  const events: CompanionEvent[] = [];
  const emit = (payload: Payload) => events.push({ ...payload, version: 1, sessionId: "limit-call", generation: 1, seq: ++seq, eventId: `limit-${seq}`, atMs: seq } as CompanionEvent);
  harness.setRoute((url, init) => {
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/voice-companion/memory") return jsonResponse({ calls: [] });
    if (path === "/api/voice-companion/settings") return jsonResponse(settingsOf({ enabled: true, backend, keySource: backend === "api" ? "file" : "missing" }));
    if (path === "/api/orchestrator/seat") return jsonResponse({ seat: null, pending: null, lastFailure: null, exists: true, viewerMcpRegistered: false, previous: [], currentTask: null, all: null });
    if (path !== "/api/voice-companion/session") return undefined;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.action === "start") {
      emit({ type: "session.ready", mode: "official-realtime" });
      emit({ type: "usage.updated", usage: backend === "codex"
        ? { backend: "codex", callSeconds: 42, callFinal: true, planStartPercent: 97, plan: { type: "pro", primary: { usedPercent: 100, resetsAt: 2000000100, windowMinutes: 300 }, secondary: null, limitReached: true, observedAt: 1 } }
        : { backend: "api", callUsd: 0.75, callFinal: false, callIncomplete: true, month: "2026-10", monthUsd: 1, monthCapUsd: 20 } });
      /* An earlier server marked every Codex close incomplete; the notice must still belong to the API alone. */
      emit({ type: "session.closed", reason: backend === "codex" ? "limit" : "transport", incomplete: true });
      return jsonResponse({ sessionId: "limit-call", sdp: "fake-answer" });
    }
    return jsonResponse(body ? { ok: true } : { events });
  });
  try {
    await mount(<VoiceCompanionHost project="atlas" mobile={false} />);
    await click(document.querySelector("[data-companion-talk]"));
    await pause(300);
    expect(document.querySelector<HTMLElement>("[data-voice-companion]")?.dataset.phase).toBe("offline");
    const notice = document.querySelector('[data-companion-notice][data-code="FINALIZATION_INCOMPLETE"]');
    if (backend === "codex") expect(notice?.textContent ?? null).toBeNull();
    else expect(notice?.querySelector(".vc-notice-text")?.textContent).toBe(companionErrorMessage("FINALIZATION_INCOMPLETE", "en"));
  } finally { await unmountNow(); await live.release(); }
});

test("a request to the orchestrator goes out at once with no button; one the model asks about waits with its reason and takes a spoken yes or no", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    const cards = () => [...document.querySelectorAll<HTMLElement>("[data-companion-delegation]")];
    const provider = live.provider.sessions[0].id;
    /* The default: delivered before the operator could tap anything, and the card says what was sent and where it stands. */
    await live.propose(provider, "Review the plan");
    expect(live.sent).toHaveLength(1);
    expect(cards().map((card) => [card.dataset.stage, card.querySelector("[data-companion-instruction]")?.textContent])).toEqual([["queued", "Review the plan"]]);
    expect(document.querySelector("[data-companion-send], [data-companion-cancel], [data-companion-confirm-reason]")).toBeNull();
    expect(cards()[0]!.querySelector(".vc-deleg-title")?.textContent).toBe(translate("en", "voiceCompanion.stage.queued"));
    /* The exception: the model's reason, both ways to answer, and nothing sent while it waits. */
    await live.propose(provider, "Delete the old presets", "Deleting cannot be undone.");
    const waiting = cards().at(-1)!;
    expect(waiting.dataset.stage).toBe("awaiting-confirmation");
    expect(waiting.querySelector("[data-companion-confirm-reason]")?.textContent).toBe("Deleting cannot be undone.");
    expect(waiting.querySelector("[data-companion-confirm-hint]")?.textContent).toBe(translate("en", "voiceCompanion.confirmHint"));
    expect(waiting.querySelectorAll("[data-companion-send], [data-companion-cancel]")).toHaveLength(2);
    expect(live.sent).toHaveLength(1);
    const arrivalOf = (card: HTMLElement) => Number(card.closest<HTMLElement>("[data-floater]")!.dataset.arrival);
    const asked = arrivalOf(waiting);
    /* A spoken yes updates the waiting card in place and retains the earlier delivered request. */
    await live.answer(provider, "send");
    expect(live.sent).toHaveLength(2);
    expect(cards().map((card) => [card.dataset.stage, card.querySelector("[data-companion-instruction]")?.textContent])).toEqual([["queued", "Review the plan"], ["queued", "Delete the old presets"]]);
    expect(arrivalOf(cards().at(-1)!)).toBe(asked);
    expect(document.querySelector("[data-companion-send]")).toBeNull();
    /* A spoken no sends nothing, and the card says so in words. */
    await live.propose(provider, "Stop every agent", "I am not sure this is what you meant.");
    expect(cards().at(-1)!.dataset.stage).toBe("awaiting-confirmation");
    const askedAgain = arrivalOf(cards().at(-1)!);
    await live.answer(provider, "cancel");
    const declined = cards().at(-1)!;
    expect(arrivalOf(declined)).toBe(askedAgain);
    expect([declined.dataset.stage, declined.querySelector("[data-companion-withdrawn]")?.textContent]).toEqual(["cancelled", translate("en", "voiceCompanion.declined")]);
    expect(live.sent).toHaveLength(2);
  } finally { await unmountNow(); await live.release(); }
});

test("two visible confirmations keep Send, Cancel, retry and a spoken/tapped race bound to their own proposal", async () => {
  for (const firstDecision of ["send", "cancel"] as const) {
    const live = await liveHarness();
    try {
      await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
      await click(document.querySelector("[data-companion-talk]"));
      await pause();
      const provider = live.provider.sessions[0]!.id;
      await live.propose(provider, "Review plan A", "Plan A needs your approval.");
      await live.propose(provider, "Delete presets B", "Deleting presets needs your approval.");
      const cards = () => [...document.querySelectorAll<HTMLElement>("[data-companion-delegation]")];
      const cardFor = (instruction: string) => cards().find((card) => card.querySelector("[data-companion-instruction]")?.textContent === instruction)!;
      expect(cards().filter((card) => card.dataset.stage === "awaiting-confirmation")).toHaveLength(2);

      const cardA = cardFor("Review plan A");
      if (firstDecision === "send") {
        /* A lost first request exposes the error and retry only on A. */
        live.failing.command = "before";
        await click(cardA.querySelector("[data-companion-send]"));
        await pause(700);
        expect(cardFor("Review plan A").querySelector('[data-companion-delegation-notice="DELIVERY_UNCONFIRMED"]')?.textContent).toBe(companionErrorMessage("SEND_UNCONFIRMED", "en"));
        expect(cardFor("Delete presets B").querySelector('[data-companion-delegation-notice="DELIVERY_UNCONFIRMED"]')).toBeNull();
        await click(cardFor("Review plan A").querySelector("[data-companion-send]"));
        await pause(700);
        expect(cardFor("Review plan A").dataset.stage).toBe("queued");
        expect(cardFor("Delete presets B").dataset.stage).toBe("awaiting-confirmation");
        expect(live.sent).toHaveLength(1);

        /* A model answer and the tap race through the same production admission for B's proposal. */
        const [session] = Object.values(live.storage.read().sessions);
        const proposalB = Object.values(session.proposals).find((row) => row.proposal.instruction === "Delete presets B")!.proposal;
        await Promise.all([
          click(cardFor("Delete presets B").querySelector("[data-companion-send]")),
          live.service.command(session.id, { type: "confirmation", proposalId: proposalB.proposalId, decision: "send", via: "speech", confirmationItemId: "spoken-answer-B" }),
        ]);
        await pause(300);
        expect(cardFor("Delete presets B").dataset.stage).toBe("queued");
        expect(live.sent).toHaveLength(2);
      } else {
        await click(cardA.querySelector("[data-companion-cancel]"));
        await pause(500);
        expect(cards().some((card) => card.dataset.stage === "cancelled")).toBe(true);
        expect(cardFor("Delete presets B").dataset.stage).toBe("awaiting-confirmation");
        expect(live.sent).toHaveLength(0);
      }
    } finally { await unmountNow(); await live.release(); }
  }
}, 15_000);

test("a tapped Send or Cancel draws its stage at once while the request is still on its way, and takes no second tap", async () => {
  for (const decision of ["send", "cancel"] as const) {
    const live = await liveHarness();
    let release = () => {};
    try {
      await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
      await click(document.querySelector("[data-companion-talk]"));
      await pause();
      await live.propose(live.provider.sessions[0].id, "Review the plan", "Two plans exist.");
      const card = () => document.querySelector<HTMLElement>("[data-companion-delegation]");
      expect(card()?.dataset.stage).toBe("awaiting-confirmation");
      live.holding.command = new Promise<void>((resolve) => { release = resolve; });
      await click(card()!.querySelector(decision === "send" ? "[data-companion-send]" : "[data-companion-cancel]"));
      await pause(700);
      /* The request is held: the card already reads as the tap asked, the buttons are gone and nothing was admitted. */
      expect(card()?.dataset.stage).toBe(decision === "send" ? "sending" : "cancelled");
      expect(card()!.querySelector("[data-companion-send], [data-companion-cancel], [data-companion-confirm-body]")).toBeNull();
      if (decision === "send") {
        expect(card()!.querySelector("[data-companion-instruction]")?.textContent).toBe("Review the plan");
        expect(card()!.querySelector("[data-companion-track]")).not.toBeNull();
      }
      expect(live.sent).toEqual([]);
      live.holding.command = null;
      release();
      await pause(700);
      expect(card()?.dataset.stage).toBe(decision === "send" ? "queued" : "cancelled");
      expect(live.sent).toHaveLength(decision === "send" ? 1 : 0);
    } finally { release(); await unmountNow(); await live.release(); }
  }
}, 15_000);

test("a Send whose request or reply is lost says delivery is not confirmed, keeps the card, and another tap delivers once", async () => {
  for (const lost of ["before", "after"] as const) {
    const live = await liveHarness();
    try {
      await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
      await click(document.querySelector("[data-companion-talk]"));
      await pause();
      await live.propose(live.provider.sessions[0].id, "Review the plan", "Two plans exist.");
      const card = () => document.querySelector<HTMLElement>("[data-companion-delegation]");
      expect(card()?.dataset.stage).toBe("awaiting-confirmation");
      live.failing.command = lost;
      await click(card()!.querySelector("[data-companion-send]"));
      await pause(700);
      if (lost === "before") {
        /* Nothing was admitted: the card stands, says so in words, and both buttons take a tap again. */
        expect(live.sent).toEqual([]);
        expect(card()?.dataset.stage).toBe("awaiting-confirmation");
        expect(card()!.querySelector('[data-companion-delegation-notice="DELIVERY_UNCONFIRMED"]')?.textContent).toBe(companionErrorMessage("SEND_UNCONFIRMED", "en"));
        expect(card()!.querySelector<HTMLButtonElement>("[data-companion-send]")!.disabled).toBe(false);
        expect(card()!.querySelector<HTMLButtonElement>("[data-companion-cancel]")!.disabled).toBe(false);
        expect(card()!.querySelector("[data-companion-instruction]")?.textContent).toBe("Review the plan");
        await click(card()!.querySelector("[data-companion-send]"));
        await pause(700);
      }
      /* Admitted once, whichever way the first answer was lost; the card moved on by itself. */
      expect(live.sent).toHaveLength(1);
      expect(card()?.dataset.stage).toBe("queued");
      expect(card()!.querySelector("[data-companion-send]")).toBeNull();
      const [session] = Object.values(live.storage.read().sessions);
      const held = Object.values(session.proposals)[0];
      await live.service.command(session.id, { type: "confirmation", proposalId: held.proposal.proposalId, decision: "send", via: "tap" });
      expect(live.sent).toEqual([held.delivery!.clientMessageId]);
    } finally { await unmountNow(); await live.release(); }
  }
});

test("collapsed during a muted conversation, the shape keeps a hang-up that ends the media and the session", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    await click(document.querySelector('[data-voice-companion] [aria-pressed]'));
    expect(live.provider.commands.some((row) => row.type === "session.input_audio.mute")).toBe(true);
    await click(document.querySelector("[data-companion-collapse]"));
    const companion = document.querySelector<HTMLElement>("[data-voice-companion]")!;
    expect(companion.hasAttribute("data-collapsed")).toBe(true);
    expect(companion.dataset.phase).not.toBe("offline");
    const end = companion.querySelector<HTMLButtonElement>(".vc-shape-end[data-companion-end]");
    expect(end?.getAttribute("aria-label")).toBe("End conversation");
    expect(end?.tabIndex).toBe(0);
    await click(end);
    await pause(200);
    expect(companion.dataset.phase).toBe("offline");
    expect(Object.values(live.storage.read().sessions).every((row) => row.closed)).toBe(true);
    expect(live.provider.attached).toBe(0);
    expect(live.trackStops()).toBeGreaterThan(0);
    /* Ended, the shape is only the shape again. */
    expect(companion.querySelector("[data-companion-end]")).toBeNull();
  } finally { await unmountNow(); await live.release(); }
});

test("the lost-send line is said in both languages", () => {
  expect(companionErrorMessage("SEND_UNCONFIRMED", "en")).toContain("not confirmed");
  expect(companionErrorMessage("SEND_UNCONFIRMED", "uk")).toContain("не підтверджено");
});

test("no settings path reaches a simulator: a demo an earlier server still reports mounts the real voice, and no product module imports the simulator or its scripts", async () => {
  routes({ ...settingsOf({ enabled: true, keySource: "file" }), backend: "demo" } as unknown as CompanionSettings);
  await mount(<VoiceCompanionHost project="atlas" mobile={false} />);
  expect(document.querySelector<HTMLElement>("[data-voice-companion]")?.dataset.mode).toBe("official-realtime");
  expect(document.querySelector("[data-companion-sim], .vc-sim")).toBeNull();

  /* The simulator and the scenario scripts are test fixtures and rendered-evidence drivers: only tests, fixtures
     and the two modules themselves name them. */
  const fs = await import("node:fs");
  const path = await import("node:path");
  const sources: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const at = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (/\.(ts|tsx|mjs)$/u.test(entry.name)) sources.push(at);
    }
  };
  walk(path.resolve("src"));
  const own = new Set(["simulator.ts", "scenarios.ts"].map((name) => path.resolve("src/lib/voiceCompanion", name)));
  const importers = sources
    .filter((file) => !own.has(file) && !/\.(test|fixture)\.tsx?$/u.test(file) && !/\.browser\.test\.tsx?$/u.test(file))
    .filter((file) => /from\s+["'](?:@\/lib\/voiceCompanion|\.{1,2}(?:\/[\w.]+)*)\/(?:simulator|scenarios)["']|import\(\s*["'][^"']*voiceCompanion\/(?:simulator|scenarios)["']/u.test(fs.readFileSync(file, "utf8")));
  expect(importers.map((file) => path.relative(process.cwd(), file))).toEqual([]);
});

test("a tap on the character opens the whole conversation from the session record, with each call collapsed, and the connect and disconnect sounds play once each", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    const grip = () => document.querySelector<HTMLElement>("[data-voice-companion] [data-grip]")!;
    /* Before any conversation there is nothing to open. */
    expect(grip().hasAttribute("aria-expanded")).toBe(false);
    expect(live.tones).toEqual([]);
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    /* Connected: one rising pair, once. */
    expect(live.tones).toEqual([660, 990]);
    await live.propose(live.provider.sessions[0].id, "Review the plan");
    expect(live.tones).toEqual([660, 990]);

    expect(grip().getAttribute("aria-expanded")).toBe("false");
    await click(grip());
    await pause();
    const view = document.querySelector<HTMLElement>("[data-companion-transcript-view]")!;
    expect(grip().getAttribute("aria-expanded")).toBe("true");
    expect(view).toBeTruthy();
    const calls = [...view.querySelectorAll<HTMLElement>("[data-transcript-call]")];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.querySelector("[data-transcript-toggle]")?.getAttribute("aria-expanded")).toBe("false");
      expect(call.querySelector("[data-transcript-detail]")).toBeNull();
    }
    /* The request the model raised is listed, and opens to the instruction it sent. */
    const request = view.querySelector<HTMLElement>('[data-transcript-call="request_orchestrator_delegation"]')!;
    expect(request.textContent).not.toContain("Review the plan");
    await click(request.querySelector("[data-transcript-toggle]"));
    expect(request.querySelector("[data-transcript-detail]")?.textContent).toContain("Review the plan");
    /* The tap that opened it closes it, and so does Escape. */
    await click(grip());
    expect(document.querySelector("[data-companion-transcript-view]")).toBeNull();
    await click(grip());
    await pause();
    await act(async () => { document.querySelector("[data-companion-transcript-view]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelector("[data-companion-transcript-view]")).toBeNull();

    /* Hanging up: one falling pair, once, and the record stays readable. */
    await click(document.querySelector("[data-companion-end]"));
    await pause(200);
    expect(live.tones).toEqual([660, 990, 990, 660]);
    await click(grip());
    await pause();
    expect(document.querySelector("[data-companion-transcript-view] [data-transcript-call]")).toBeTruthy();
    expect(live.tones).toEqual([660, 990, 990, 660]);
    /* The next Talk closes the old record and sounds its own connect. */
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    expect(document.querySelector("[data-companion-transcript-view]")).toBeNull();
    expect(live.tones).toEqual([660, 990, 990, 660, 660, 990]);
  } finally { await unmountNow(); await live.release(); }
});

test("after a reload the character opens the newest retained call, and one picker opens each earlier call with its requests, delivery and orchestrator link", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    const grip = () => document.querySelector<HTMLElement>("[data-voice-companion] [data-grip]")!;
    for (const instruction of ["Review the plan", "Check the build"]) {
      await click(document.querySelector("[data-companion-talk]"));
      await pause();
      await live.propose(live.provider.sessions.at(-1)!.id, instruction);
      await click(document.querySelector("[data-companion-end]"));
      await pause(200);
    }
    expect(live.sent).toHaveLength(2);
    /* A reload: a new page with no call of its own. */
    await unmountNow();
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    await pause(200);
    expect(grip().getAttribute("aria-expanded")).toBe("false");
    await click(grip());
    await pause(200);
    const view = () => document.querySelector<HTMLElement>("[data-companion-transcript-view]")!;
    const opened = async () => {
      const request = view().querySelector<HTMLElement>('[data-transcript-call="request_orchestrator_delegation"]')!;
      expect(request.querySelector("[data-transcript-request]")?.getAttribute("data-stage")).toBe("queued");
      await click(request.querySelector("[data-transcript-toggle]"));
      return request.querySelector<HTMLElement>("[data-transcript-detail]")!;
    };
    const newest = await opened();
    expect(newest.textContent).toContain("Check the build");
    expect(newest.querySelector<HTMLAnchorElement>("a[data-transcript-orchestrator]")?.getAttribute("href")).toBe("#c=conversation_project-a");
    const picker = view().querySelector<HTMLSelectElement>("select[data-transcript-calls]")!;
    expect([...picker.options].map((option) => option.value)).toEqual(Object.values(live.storage.read().sessions).sort((a, b) => b.createdAt - a.createdAt).map((row) => row.id));
    expect(picker.value).toBe(picker.options[0]!.value);
    await act(async () => { picker.value = picker.options[1]!.value; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    await pause(200);
    expect(view().querySelector<HTMLSelectElement>("select[data-transcript-calls]")!.value).toBe(picker.options[1]!.value);
    expect((await opened()).textContent).toContain("Review the plan");
    /* Nothing was started or sent for reading. */
    expect(live.sent).toHaveLength(2);
    expect(live.provider.sessions).toHaveLength(2);
  } finally { await unmountNow(); await live.release(); }
}, 20_000);

test("a dropped call keeps its conversation on screen, offers the same call in one tap, and the reconnect continues it with its context", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    const first = live.provider.sessions[0].id;
    live.say(first, [["operator", "Check the search lane."], ["voice", "The search lane passed its verifier."]]);
    await pause(700);
    /* The provider's session ends mid-call. */
    live.provider.disconnect(first);
    await pause(700);
    const lost = document.querySelector<HTMLElement>('[data-companion-notice][data-code="CONNECTION_LOST"]');
    expect(lost?.textContent).toContain(companionErrorMessage("CONNECTION_LOST", "en"));
    expect(document.querySelector('[data-companion-notice][data-code="PROVIDER_ERROR"]')).toBeNull();
    /* What was said stays: in the lane's record and in the call's whole record. */
    expect(document.querySelector("[data-companion-transcript]")?.textContent).toContain("Check the search lane.");
    await click(document.querySelector("[data-voice-companion] [data-grip]"));
    await pause();
    expect(document.querySelector("[data-companion-transcript-view]")?.textContent).toContain("Check the search lane.");
    /* The panel says the connection dropped, where a hung-up call says it ended. */
    expect(document.querySelector(".vc-tr-sub")?.textContent).toContain("connection dropped");
    expect(document.querySelector(".vc-tr-sub")?.textContent).not.toContain("ended");
    await click(document.querySelector("[data-voice-companion] [data-grip]"));
    /* Reconnect is the one filled action while the call is offered; Talk, which starts a new call, steps back. */
    expect(document.querySelector("[data-companion-resume]")?.hasAttribute("data-primary")).toBe(true);
    expect(document.querySelector("[data-companion-talk]")?.hasAttribute("data-quiet")).toBe(true);

    /* One tap continues the same call. */
    await click(document.querySelector("[data-companion-resume]"));
    await pause(300);
    const starts = sessionCalls().map((call) => call.body as { action?: string; resume?: string } | null).filter((body) => body?.action === "start");
    expect(starts.at(-1)?.resume).toBe(Object.values(live.storage.read().sessions).find((row) => row.providerId === first)?.id);
    expect(live.provider.sessions).toHaveLength(2);
    expect(live.provider.sessions[1].memory).toContain("operator: Check the search lane.");
    expect(live.provider.sessions[1].memory).toContain("voice: The search lane passed its verifier.");
    expect(document.querySelector<HTMLElement>("[data-voice-companion]")?.dataset.phase).not.toBe("offline");
    const restored = document.querySelector<HTMLElement>('[data-companion-notice][data-code="CONNECTION_RESTORED"]');
    expect(restored?.textContent).toContain(companionErrorMessage("CONNECTION_RESTORED", "en"));
    /* The good news carries a confirming mark, not the alert's circled exclamation. */
    expect(restored?.querySelector(".vc-notice-icon svg.lucide-check")).not.toBeNull();
    expect(restored?.querySelector(".vc-notice-icon svg.lucide-circle-alert")).toBeNull();
    expect(document.querySelector('[data-companion-notice][data-code="CONNECTION_LOST"]')).toBeNull();
    expect(document.querySelector("[data-companion-resume]")).toBeNull();
    expect(document.querySelector("[data-companion-transcript]")?.textContent).toContain("Check the search lane.");
    /* The record now holds both parts of the call and marks the reconnect between them. */
    live.say(live.provider.sessions[1].id, [["operator", "Then deploy it."]], 5);
    await pause(700);
    await click(document.querySelector("[data-voice-companion] [data-grip]"));
    await pause();
    const view = document.querySelector<HTMLElement>("[data-companion-transcript-view]")!;
    expect(view.textContent).toContain("Check the search lane.");
    expect(view.textContent).toContain("Then deploy it.");
    expect(view.querySelector("[data-transcript-resumed]")?.textContent).toBe(translate("en", "voiceCompanion.reconnected"));
  } finally { await unmountNow(); await live.release(); }
});

test("review: a transcript stays current when the orchestrator answers after the voice session ended", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    const grip = () => document.querySelector<HTMLElement>("[data-voice-companion] [data-grip]")!;
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    await live.propose(live.provider.sessions[0].id, "Review the plan");
    expect(live.sent).toHaveLength(1);
    await click(document.querySelector("[data-companion-end]"));
    await pause(200);
    await click(grip());
    await pause();
    const view = () => document.querySelector<HTMLElement>("[data-companion-transcript-view]")!;
    expect(view().querySelector("[data-transcript-answer]")).toBeNull();
    const startsBefore = live.starts();
    const providerSessions = live.provider.sessions.length;
    live.report("The plan holds; two small notes.");
    /* The adapter's observer reads the Viewer every two seconds once the voice is gone. */
    await pause(4_500);
    expect(view().querySelector("[data-transcript-answer]")?.textContent).toContain("The plan holds");
    expect(view().querySelector("[data-transcript-answer] .vc-tr-copy")).toBeTruthy();
    /* Still offline, and nothing was started or sent to the provider for it. */
    expect(document.querySelector("[data-companion-talk]")).toBeTruthy();
    expect([live.starts(), live.provider.sessions.length]).toEqual([startsBefore, providerSessions]);
  } finally { await unmountNow(); await live.release(); }
}, 20_000);


test("false playback stop and restart keep streaming words, bubble nodes, arrivals and older report cards", async () => {
  const { VoiceCompanion } = await import("./VoiceCompanion");
  const listeners = new Set<(event: CompanionEvent) => void>();
  let seq = 0;
  const publish = (payload: Payload) => {
    const event = { ...payload, version: 1 as const, sessionId: "stable-call", generation: 1, seq: ++seq, eventId: `stable-${seq}`, atMs: seq } as CompanionEvent;
    for (const listener of listeners) listener(event);
  };
  const emit = async (payload: Payload) => act(async () => { publish(payload); await settle(); });
  const adapter: VoiceCompanionAdapter = { mode: "simulated", subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async () => { publish({ type: "session.ready", mode: "simulated" }); }, command: async () => {}, close: async () => {} };
  await mount(<VoiceCompanion adapter={adapter} project="atlas" locale="en" />);
  await click(document.querySelector("[data-companion-talk]"));
  await emit({ type: "orchestrator.report", reportId: "older", status: "result", text: "The earlier report stays.", at: 0, project: "atlas" });
  const recipient = { project: "atlas", conversationId: "conversation_atlas", seatEpoch: 1, engine: "claude" as const };
  const delivery = { proposalId: "p-answer", callId: "c-answer", clientMessageId: "voice-answer", operationId: "operation-answer", recipient };
  await emit({ type: "delegation.tool.called", callId: delivery.callId, sourceItemId: "delegation", instruction: "Review the plan" });
  await emit({ type: "delegation.sending", proposal: { ...delivery, sourceItemId: "delegation", instruction: "Review the plan", authority: "live-model" } });
  await emit({ type: "delegation.tool.result", callId: delivery.callId, result: { status: "delivered", delivery } });
  for (const reportId of ["answer-1", "answer-2"]) await emit({ type: "orchestrator.answer", delivery, reportId, status: "progress", text: reportId });
  expect([...document.querySelectorAll('[data-kind="answer"] [data-companion-answer]')].map(node => node.textContent)).toEqual(["answer-1", "answer-2"]);
  await emit({ type: "delegation.tool.called", callId: "waiting", sourceItemId: "delegation", instruction: "Review the second plan" });
  await emit({ type: "delegation.confirmation.required", proposal: { proposalId: "p-waiting", callId: "waiting", sourceItemId: "delegation", instruction: "Review the second plan", recipient, authority: "live-model", confirmation: { reason: "Two plans exist." } } });
  const waiting = document.querySelector<HTMLElement>('[data-floater="delegation:waiting"]')!;
  expect(waiting).toBeTruthy();
  const waitingArrival = waiting.dataset.arrival;
  const snapshot = () => new Map([...document.querySelectorAll<HTMLElement>('[data-floater^="companion:long#"]')].map(node => [node.dataset.floater!, { node, arrival: node.dataset.arrival, text: node.querySelector(".vc-text")!.textContent }]));
  await emit({ type: "transcript.delta", speaker: "companion", itemId: "long", delta: "A complete sentence about the current work and the checks we need. ".repeat(5) + "The orchestrator replied. The plan holds, with one gap: last month's saved" });
  await emit({ type: "playback.started", responseId: "audio-1", itemId: "long" });
  const before = snapshot();
  expect(before.size).toBe(1);
  await emit({ type: "playback.stopped", responseId: "audio-1", itemId: "long", playedMs: 400, reason: "ended" });
  const paused = snapshot();
  expect(paused.size).toBeGreaterThan(before.size);
  await emit({ type: "playback.started", responseId: "audio-2", itemId: "long", playedMs: 400 });
  const resumed = snapshot();
  expect([...resumed.keys()]).toEqual([...paused.keys()]);
  for (const [key, value] of paused) { expect(resumed.get(key)?.node === value.node).toBe(true); expect(resumed.get(key)?.arrival).toBe(value.arrival); expect(resumed.get(key)?.text).toBe(value.text); }
  expect(document.querySelector('[data-floater="report:older"]')).toBeTruthy();
  expect(document.querySelector('[data-leaving] [data-companion-report]')).toBeNull();
  await emit({ type: "playback.stopped", responseId: "audio-2", itemId: "long", playedMs: 450, reason: "interrupted" });
  expect([...snapshot().keys()]).toEqual([...paused.keys()]);
  expect(document.querySelector('[data-floater="delegation:waiting"]') === waiting).toBe(true);
  await emit({ type: "delegation.confirmed", proposalId: "p-waiting", via: "tap" });
  expect(document.querySelector('[data-floater="delegation:waiting"]') === waiting).toBe(true);
  expect(waiting.dataset.arrival).toBe(waitingArrival);
  for (let index = 1; index <= 5; index++) await emit({ type: "orchestrator.report", reportId: `new-${index}`, status: "result", text: `New report ${index}`, at: index, project: "atlas" });
  expect(document.querySelectorAll('[data-floater][data-kind="speech"]').length).toBe(6);
  expect(document.querySelectorAll('[data-floater][data-kind="answer"], [data-floater][data-kind="report"]').length).toBe(4);
  expect(document.querySelector('[data-floater="delegation:waiting"]') === waiting).toBe(true);
});

test("an orchestrator message card in the lane keeps more than 4000 characters and its localized label", async () => {
  const { VoiceCompanion } = await import("./VoiceCompanion");
  const { setLocale } = await import("@/lib/i18n");
  for (const locale of ["en", "uk"] as const) {
    await act(async () => setLocale(locale));
    const listeners = new Set<(event: CompanionEvent) => void>(); let seq = 0;
    const publish = (payload: Payload) => {
      const event = { ...payload, version: 1, sessionId: "whole-message", generation: 1, seq: ++seq, eventId: `whole-${seq}`, atMs: seq } as CompanionEvent;
      for (const listener of listeners) listener(event);
    };
    const adapter: VoiceCompanionAdapter = { mode: "simulated", subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      start: async () => { publish({ type: "session.ready", mode: "simulated" }); }, command: async () => {}, close: async () => {} };
    await mount(<VoiceCompanion adapter={adapter} project="atlas" locale={locale} />);
    await click(document.querySelector("[data-companion-talk]"));
    const text = "Whole message line.\n".repeat(400);
    await act(async () => { publish({ type: "orchestrator.report", reportId: "whole", status: "message", text, at: 0, project: "atlas" }); await settle(); });
    const card = document.querySelector("[data-companion-report]")!;
    expect(card.textContent).toContain(locale === "uk" ? "Повідомлення" : "Message");
    expect(card.querySelector("[data-companion-answer]")!.textContent).toBe(text);
    await unmountNow();
  }
  await act(async () => setLocale("en"));
});


test("one poll preserves the order of standalone reports and answers to different requests", async () => {
  const { VoiceCompanion } = await import("./VoiceCompanion");
  const listeners = new Set<(event: CompanionEvent) => void>();
  let seq = 0;
  const publish = (payload: Payload) => {
    const event = { ...payload, version: 1 as const, sessionId: "report-burst", generation: 1, seq: ++seq, eventId: `report-${seq}`, atMs: seq } as CompanionEvent;
    for (const listener of listeners) listener(event);
  };
  const adapter: VoiceCompanionAdapter = { mode: "simulated", subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async () => { publish({ type: "session.ready", mode: "simulated" }); }, command: async () => {}, close: async () => {} };
  await mount(<VoiceCompanion adapter={adapter} project="atlas" locale="en" />);
  await click(document.querySelector("[data-companion-talk]"));
  const recipient = { project: "atlas", conversationId: "conversation_atlas", seatEpoch: 1, engine: "claude" as const };
  const request = (callId: string) => {
    const delivery = { proposalId: `p-${callId}`, callId, clientMessageId: `voice-${callId}`, operationId: `operation-${callId}`, recipient };
    publish({ type: "delegation.tool.called", callId, sourceItemId: "delegation", instruction: "Review the plan" });
    publish({ type: "delegation.sending", proposal: { ...delivery, sourceItemId: "delegation", instruction: "Review the plan", authority: "live-model" } });
    publish({ type: "delegation.tool.result", callId, result: { status: "delivered", delivery } });
    return delivery;
  };
  let earlier!: ReturnType<typeof request>;
  let later!: ReturnType<typeof request>;
  await act(async () => { earlier = request("earlier"); later = request("later"); await settle(); });
  await act(async () => {
    publish({ type: "orchestrator.report", reportId: "first", status: "result", text: "First", at: 1, project: "atlas" });
    publish({ type: "orchestrator.answer", reportId: "second", status: "result", text: "Second", delivery: later });
    publish({ type: "orchestrator.answer", reportId: "third", status: "result", text: "Third", delivery: earlier });
    await settle();
  });
  expect([...document.querySelectorAll('.vc-stack > [data-floater] [data-companion-answer]')].map(node => node.textContent)).toEqual(["First", "Second", "Third"]);
});

test("a burst of reports holds the lane against the speech after it: older reports leave only from the far end, by their cap", async () => {
  const { VoiceCompanion, REPORT_CAP } = await import("./VoiceCompanion");
  const listeners = new Set<(event: CompanionEvent) => void>();
  let seq = 0;
  const publish = (payload: Payload) => {
    const event = { ...payload, version: 1 as const, sessionId: "report-room", generation: 1, seq: ++seq, eventId: `room-${seq}`, atMs: seq } as CompanionEvent;
    for (const listener of listeners) listener(event);
  };
  const emit = async (payload: Payload) => act(async () => { publish(payload); await settle(); });
  const adapter: VoiceCompanionAdapter = { mode: "simulated", subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async () => { publish({ type: "session.ready", mode: "simulated" }); }, command: async () => {}, close: async () => {} };
  /* Every element 72 px tall: four report cards fill a lane of at most 360 px, so the speech that follows finds no room. */
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return this.matches("[data-floater]") ? 72 : height.get!.call(this); } });
  try {
    await mount(<VoiceCompanion adapter={adapter} project="atlas" locale="en" />);
    await click(document.querySelector("[data-companion-talk]"));
    const held = () => [...document.querySelectorAll<HTMLElement>('.vc-stack > [data-floater^="report:"]')].map(node => node.dataset.floater!.slice("report:".length));
    await emit({ type: "transcript.final", speaker: "operator", itemId: "ask", text: "Read me the reports." });
    for (let index = 1; index <= REPORT_CAP + 2; index++) {
      await emit({ type: "orchestrator.report", reportId: `r${index}`, status: "result", text: `Report ${index}`, at: index, project: "atlas" });
      expect(held(), `after report ${index}`).toEqual(Array.from({ length: Math.min(index, REPORT_CAP) }, (_, at) => `r${Math.max(0, index - REPORT_CAP) + at + 1}`));
    }
    for (let index = 1; index <= 3; index++) {
      await emit({ type: "response.started", responseId: `said-${index}`, itemId: `said-${index}` });
      await emit({ type: "transcript.final", speaker: "companion", itemId: `said-${index}`, responseId: `said-${index}`, text: `Report ${index + 2} said aloud.` });
      await emit({ type: "playback.started", responseId: `said-${index}`, itemId: `said-${index}` });
      await emit({ type: "playback.stopped", responseId: `said-${index}`, itemId: `said-${index}`, playedMs: 1_200, reason: "ended" });
      expect(held(), `after the companion's line ${index}`).toEqual(["r3", "r4", "r5", "r6"]);
    }
    /* The operator's own words take their room as before: the oldest report leaves from the far end and the newest holds. */
    await emit({ type: "transcript.final", speaker: "operator", itemId: "next", text: "And the billing lane?" });
    expect(document.querySelector('.vc-stack > [data-floater^="operator:next#"]'), "the operator's new words are shown").toBeTruthy();
    expect(held().at(-1)).toBe("r6");
    expect(held()[0], "an older report left from the far end").not.toBe("r3");
  } finally { Object.defineProperty(HTMLElement.prototype, "offsetHeight", height); }
});

test("phone settings retain the month and last call in both languages, including incomplete usage", async () => {
  const { setLocale } = await import("@/lib/i18n");
  try {
    for (const locale of ["en", "uk"] as const) {
      routes(settingsOf({ enabled: true, usageUsd: 0.91, lastSession: { usd: 0.4, seconds: 471, endedAt: Date.UTC(2026, 9, 10), incomplete: true } }));
      await act(async () => setLocale(locale));
      await mount(<><VoiceCompanionHost project="atlas" mobile /><VoiceCompanionSetting /></>);
      expect(document.querySelector("[data-voice-companion]")).toBeNull();
      expect(document.querySelector("[data-voice-companion-setting]")).toBeTruthy();
      expect(document.querySelector("[data-companion-spend-meter]")).toBeNull();
      expect(document.querySelector("[data-voice-companion-usage]")?.textContent).toContain(locale === "en" ? "October" : "жовтень");
      const last = document.querySelector<HTMLElement>("[data-voice-companion-last-call]")!;
      expect(last.textContent).toContain("$0.40 · 7:51");
      expect(last.textContent).toContain(locale === "en" ? "Last call: estimated" : "Остання розмова: орієнтовно");
      expect(last.title).toContain("OpenAI");
      await unmountNow();
    }
  } finally { await act(async () => setLocale("en")); }
});

test("on Codex, before any call the settings say so, and a plan at its limit is said in the danger tone", async () => {
  routes(settingsOf({ enabled: true, backend: "codex" }));
  const host = await mount(<VoiceCompanionSetting />);
  expect(host.querySelector("[data-voice-companion-last-call]")?.textContent).toBe("No call yet.");
  expect(host.querySelector("[data-voice-companion-plan]")).toBeNull();
  await unmountNow();
  const now = Math.floor(Date.now() / 1000);
  routes(settingsOf({ enabled: true, backend: "codex", lastCodexSession: { seconds: 65, endedAt: Date.UTC(2026, 9, 10, 9), plan: { type: "plus", primary: { usedPercent: 100, resetsAt: now + 3_600, windowMinutes: 300 }, secondary: null, limitReached: true, observedAt: now * 1000 } } }));
  const limited = await mount(<VoiceCompanionSetting />);
  const window = limited.querySelector<HTMLElement>("[data-voice-companion-plan]")!;
  expect(window.dataset.tone).toBe("danger");
  expect(window.children[1]!.textContent).toMatch(/^5\u00a0h 100%, resets \d\d:\d\d$/u);
  expect(window.querySelector<HTMLElement>("[data-plan-figure]")!.dataset.tone).toBe("danger");
});

test("phone settings on Codex keep the last Codex call and its plan window in both languages, with no meter and no key", async () => {
  const { setLocale } = await import("@/lib/i18n");
  const now = Math.floor(Date.now() / 1000);
  const plan = { type: "pro", primary: { usedPercent: 23, resetsAt: now + 7_200, windowMinutes: 300 }, secondary: { usedPercent: 77, resetsAt: now + 4 * 86_400, windowMinutes: 10_080 }, limitReached: false, observedAt: now * 1000 };
  try {
    for (const locale of ["en", "uk"] as const) {
      routes(settingsOf({ enabled: true, backend: "codex", lastCodexSession: { seconds: 471, endedAt: Date.UTC(2026, 9, 10, 9), plan } }));
      await act(async () => setLocale(locale));
      await mount(<><VoiceCompanionHost project="atlas" mobile /><VoiceCompanionSetting /></>);
      expect(document.querySelector("[data-voice-companion]")).toBeNull();
      expect(document.querySelector("[data-voice-companion-setting]")).toBeTruthy();
      expect(document.querySelector("[data-companion-spend-meter]")).toBeNull();
      expect(document.querySelector("[data-voice-companion-key], [data-voice-companion-cap]")).toBeNull();
      expect(document.querySelector("[data-voice-companion-last-call]")?.textContent).toBe(locale === "en" ? "Last call: 7:51 · Oct 10." : "Остання розмова: 7:51 · 10 жовтня.");
      const lines = [...document.querySelector<HTMLElement>("[data-voice-companion-plan]")!.children].map((node) => node.textContent);
      expect(lines.slice(0, 2)).toEqual(locale === "en" ? ["Pro plan, the whole account with its agents", expect.stringMatching(/^5\u00a0h 23%, resets \d\d:\d\d$/u)]
        : ["План Pro, увесь акаунт разом з агентами", expect.stringMatching(/^5\u00a0год 23%, оновлення \d\d:\d\d$/u)]);
      /* The weekly reset is a date; in Ukrainian its month is written in full. */
      expect(lines[2]).toMatch(locale === "en" ? /^week 77%, resets [A-Z][a-z]{2} \d{1,2}$/u : /^тиждень 77%, оновлення \d{1,2} [а-яіїєґ]+$/u);
      expect(lines[3]).toMatch(locale === "en" ? /^As of \d\d:\d\d\.$/u : /^Станом на \d\d:\d\d\.$/u);
      await unmountNow();
    }
  } finally { await act(async () => setLocale("en")); }
});

/*
 * The phone's head (docs/design/phone-voice-head-build.md): shown and hidden from this browser's storage, Hide
 * ending a call by unmounting, a project change keeping the call, and nothing but Talk starting one.
 */
const phoneHead = () => document.querySelector<HTMLElement>("[data-phone-voice]");
/** Opens the head's popover and taps one of its rows. */
const phoneRow = async (row: "talk" | "hide" | "end" | "mute") => {
  if (!document.querySelector("[data-phone-voice-pop]")) await click(document.querySelector("[data-phone-voice-head]"));
  await click(document.querySelector(`[data-phone-voice-${row}]`));
};

test("phone: a hidden head stays hidden across a reload, mounts nothing and asks for no session; «Показати голос» brings it back with no call", async () => {
  routes(settingsOf({ enabled: true, keySource: "file" }));
  localStorage.setItem(PHONE_VOICE_STORAGE_KEY, JSON.stringify({ hidden: true, side: "left" }));
  await mount(<VoiceCompanionHost project="atlas" mobile />);
  expect(phoneHead()).toBeNull();
  expect(harness.calls.map((call) => call.url)).toEqual(["/api/voice-companion/settings"]);
  expect(readPhoneVoice()).toEqual({ hidden: true, side: "left", available: true });
  /* A reload: the page forgets what it held, and the storage says hidden still. */
  await unmountNow();
  resetPhoneVoiceForTests();
  await mount(<VoiceCompanionHost project="atlas" mobile />);
  expect(phoneHead()).toBeNull();
  expect(readPhoneVoice().hidden).toBe(true);

  await act(async () => showPhoneVoice());
  await act(async () => settle());
  expect(phoneHead()?.dataset.phase).toBe("offline");
  expect(phoneHead()?.dataset.side).toBe("left");
  expect(JSON.parse(localStorage.getItem(PHONE_VOICE_STORAGE_KEY)!)).toEqual({ hidden: false, side: "left" });
  await unmountNow();
  resetPhoneVoiceForTests();
  await mount(<VoiceCompanionHost project="atlas" mobile />);
  expect(phoneHead()).not.toBeNull();
  expect(sessionCalls()).toEqual([]);

  /* A browser that refuses the write keeps the choice for the page. */
  const setItem = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(localStorage), "setItem");
  Object.defineProperty(localStorage, "setItem", { value: () => { throw new Error("QuotaExceededError"); }, configurable: true });
  try {
    await phoneRow("hide");
    expect(phoneHead()).toBeNull();
    expect(readPhoneVoice().hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(PHONE_VOICE_STORAGE_KEY)!)).toEqual({ hidden: false, side: "left" });
  } finally {
    Reflect.deleteProperty(localStorage, "setItem");
    if (setItem && localStorage.setItem !== setItem.value) Object.defineProperty(localStorage, "setItem", { ...setItem, configurable: true });
  }
});

test("phone: Hide during a call ends it: the microphone is muted and stopped, the session closed and the head gone; Hide while the start is in flight opens no session", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile />);
    await phoneRow("talk");
    await pause(200);
    expect(live.starts()).toBe(1);
    expect(phoneHead()?.dataset.phase).not.toBe("offline");
    expect(live.trackStops()).toBe(0);
    await phoneRow("hide");
    await pause(300);
    expect(phoneHead()).toBeNull();
    expect(readPhoneVoice().hidden).toBe(true);
    expect(live.trackEnabled()).toBe(false);
    expect(live.trackStops()).toBeGreaterThan(0);
    expect(sessionCalls().map((call) => (call.body as { action?: string } | null)?.action)).toContain("close");
    expect(Object.values(live.storage.read().sessions).every((row) => row.closed)).toBe(true);
    expect(live.provider.attached).toBe(0);
  } finally { await unmountNow(); await live.release(); }

  resetPhoneVoiceForTests();
  localStorage.removeItem(PHONE_VOICE_STORAGE_KEY);
  const held = await liveHarness();
  let release = () => {};
  held.holding.start = new Promise<void>((resolve) => { release = resolve; });
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile />);
    await phoneRow("talk");
    await pause(60);
    expect(phoneHead()?.hasAttribute("data-starting")).toBe(true);
    await phoneRow("hide");
    expect(phoneHead()).toBeNull();
    release();
    await pause(300);
    const actions = sessionCalls().map((call) => call.body as { action?: string; requestId?: string; sessionId?: string } | null);
    const start = actions.find((body) => body?.action === "start") as { requestId?: string };
    /* Closed by the start's own request id before the session existed, and the session the start then got is closed too. */
    expect(actions.some((body) => body?.action === "close" && body.requestId === start.requestId)).toBe(true);
    expect(Object.values(held.storage.read().sessions).every((row) => row.closed)).toBe(true);
    expect(held.provider.attached).toBe(0);
    expect(held.trackStops()).toBeGreaterThan(0);
    expect(held.starts()).toBe(1);
  } finally { release(); await unmountNow(); await held.release(); }
});

test("phone: a lost network keeps the call's history, the menu offers Reconnect, and after a reload the dropped call is still offered, readable and resumed", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile />);
    await phoneRow("talk");
    await pause(200);
    const first = live.provider.sessions[0].id;
    live.say(first, [["operator", "Check the search lane."], ["voice", "The search lane passed its verifier."]]);
    await pause(700);
    /* The browser's network goes: the peer connection fails, and the Viewer is told the call dropped. */
    live.dropMedia();
    await pause(700);
    const closes = sessionCalls().map((call) => call.body as { action?: string; reason?: string } | null).filter((body) => body?.action === "close");
    expect(closes.at(-1)?.reason).toBe("transport");
    expect(document.querySelector("[data-phone-voice-bubble]")?.textContent?.replace(/\u00a0/gu, " ")).toBe(companionErrorMessage("CONNECTION_LOST", "en"));
    await click(document.querySelector("[data-phone-voice-head]"));
    expect(document.querySelector("[data-phone-voice-resume]")).toBeTruthy();
    await click(document.querySelector("[data-phone-voice-transcript]"));
    await pause();
    expect(document.querySelector("[data-companion-transcript-view]")?.textContent).toContain("Check the search lane.");
    await unmountNow();

    /* A reload: a new head, a new adapter, nothing in memory. The Viewer still offers the call and its record. */
    await mount(<VoiceCompanionHost project="project-a" mobile />);
    await pause(200);
    await click(document.querySelector("[data-phone-voice-head]"));
    expect(document.querySelector("[data-phone-voice-resume]")).toBeTruthy();
    await click(document.querySelector("[data-phone-voice-transcript]"));
    await pause();
    expect(document.querySelector("[data-companion-transcript-view]")?.textContent).toContain("Check the search lane.");
    await act(async () => { document.querySelector("[data-companion-transcript-view]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await click(document.querySelector("[data-phone-voice-head]"));
    await click(document.querySelector("[data-phone-voice-resume]"));
    await pause(300);
    expect(live.provider.sessions).toHaveLength(2);
    expect(live.provider.sessions[1].memory).toContain("operator: Check the search lane.");
    expect(phoneHead()?.dataset.phase).not.toBe("offline");
    expect(document.querySelector("[data-phone-voice-bubble]")?.textContent?.replace(/\u00a0/gu, " ")).toBe(companionErrorMessage("CONNECTION_RESTORED", "en"));
  } finally { await unmountNow(); await live.release(); }
});

test("phone: a live call names its microphone in the head's popover and the head says the default was taken; the line goes with the call", async () => {
  const live = await liveHarness();
  const voiceDevices = await import("@/lib/audio/voiceDevices");
  const track = { enabled: true, stop() {}, label: "Default - Headset Mic", getSettings: () => ({ deviceId: "default" }) };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    enumerateDevices: async () => [
      { deviceId: "default", kind: "audioinput", label: "Default - Headset Mic", groupId: "g1" },
      { deviceId: "mic-headset", kind: "audioinput", label: "Headset Mic", groupId: "g1" },
    ],
  } });
  voiceDevices.setVoiceDeviceChoice("input", { id: "usb-gone", label: "USB Microphone" });
  try {
    await mount(<VoiceCompanionHost project="atlas" mobile />);
    await phoneRow("talk");
    await pause(300);
    expect(document.querySelector("[data-phone-voice-words]")?.textContent?.replace(/[\s\u200b]+/g, " ")).toContain(companionErrorMessage("MICROPHONE_FALLBACK", "en"));
    await click(document.querySelector("[data-phone-voice-head]"));
    expect(document.querySelector("[data-phone-voice-mic]")?.textContent).toBe(translate("en", "voiceCompanion.micInUse", { name: "Headset Mic" }));
    expect(document.querySelector("[data-phone-voice-settings]")).toBeTruthy();
    await phoneRow("end");
    await pause(200);
    await click(document.querySelector("[data-phone-voice-head]"));
    expect(document.querySelector("[data-phone-voice-mic]")).toBeNull();
  } finally {
    voiceDevices.setVoiceDeviceChoice("input", null);
    voiceDevices.configureVoiceDeviceStorage(undefined);
    await unmountNow(); await live.release();
  }
});

test("phone: a project change, and a view with no project, keep the same head and the same live call", async () => {
  const live = await liveHarness();
  let closed = false, seq = 0;
  const events: CompanionEvent[] = [];
  const emit = (payload: Payload) => events.push({ ...payload, version: 1, sessionId: "phone-call", generation: 1, seq: ++seq, eventId: `phone-${seq}`, atMs: seq } as CompanionEvent);
  harness.setRoute((url, init) => {
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/voice-companion/memory") return jsonResponse({ calls: [] });
    if (path === "/api/voice-companion/settings") return jsonResponse(settingsOf({ enabled: true, keySource: "file" }));
    if (path === "/api/orchestrator/seat") return jsonResponse({ seat: { project: "atlas", conversationId: "conversation_atlas", seatEpoch: 1, engine: "claude" }, exists: true });
    if (path !== "/api/voice-companion/session") return undefined;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.action === "start") {
      emit({ type: "session.ready", mode: "official-realtime" });
      return jsonResponse({ sessionId: "phone-call", sdp: "fake-answer" });
    }
    if (body?.action === "close") { closed = true; emit({ type: "session.closed", reason: "operator" }); }
    return jsonResponse(body ? { ok: true } : { events });
  });
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile />);
    await phoneRow("talk");
    await pause();
    const head = phoneHead()!;
    expect(head.dataset.phase).not.toBe("offline");
    for (const project of ["project-b", null, "project-a"]) {
      await act(async () => mounted!.root.render(<VoiceCompanionHost project={project} mobile />));
      await pause(200);
      expect(phoneHead() === head).toBe(true);
      expect(closed).toBe(false);
      expect(live.trackStops()).toBe(0);
      expect(live.starts()).toBe(1);
      expect(head.dataset.phase).not.toBe("offline");
      const contexts = sessionCalls().filter(call => (call.body as { action?: string } | null)?.action === "context");
      expect(contexts.at(-1)?.body).toEqual({ action: "context", sessionId: "phone-call", project });
    }
  } finally { await unmountNow(); await live.release(); }
});

test("the switch that turns the voice on names no surface, in both languages", () => {
  for (const language of ["en", "uk"] as const) expect(translate(language, "voiceCompanion.settings.enable")).not.toMatch(/desktop|десктоп|комп/iu);
});

test("phone: a live or starting call keeps the head above every layer a phone surface paints (image preview, search, full-screen dialogs); with no call it stays at the dock", async () => {
  const live = await liveHarness();
  let release = () => {};
  live.holding.start = new Promise<void>((resolve) => { release = resolve; });
  const level = () => Number(phoneHead()?.style.zIndex);
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile />);
    expect(level()).toBe(LAYER.dock);
    await phoneRow("talk");
    await pause(60);
    expect(phoneHead()?.hasAttribute("data-starting")).toBe(true);
    /* Starting already holds the microphone: the sign is above the preview (overlay) and below the toasts. */
    expect(level()).toBeGreaterThan(LAYER.overlay);
    expect(level()).toBeLessThan(LAYER.toast);
    release();
    await pause(200);
    expect(phoneHead()?.dataset.phase).not.toBe("offline");
    expect(level()).toBeGreaterThan(LAYER.overlay);
    await phoneRow("end");
    await pause(300);
    expect(phoneHead()?.dataset.phase).toBe("offline");
    expect(level()).toBe(LAYER.dock);
  } finally { release(); await unmountNow(); await live.release(); }
});

test("phone: a tap on the head, a drag, Hide and Show start no call; only Talk does", async () => {
  routes(settingsOf({ enabled: true, keySource: "file" }));
  await mount(<VoiceCompanionHost project="atlas" mobile />);
  /* A tap opens the popover: Talk, then Hide, and nothing else. */
  await click(document.querySelector("[data-phone-voice-head]"));
  const rows = [...document.querySelectorAll("[data-phone-voice-pop] [role='menuitem']")].map((row) => row.textContent);
  expect(rows).toEqual([translate("en", "voiceCompanion.talk"), translate("en", "voiceCompanion.hide")]);
  await click(document.querySelector("[data-phone-voice-head]"));
  expect(document.querySelector("[data-phone-voice-pop]")).toBeNull();
  /* A drag to the other side: the side is kept, and the popover does not open. */
  const head = document.querySelector<HTMLElement>("[data-phone-voice-head]")!;
  const pointer = (type: string, x: number) => head.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientX: x, clientY: 600 } as PointerEventInit));
  await act(async () => { pointer("pointerdown", 1400); pointer("pointermove", 900); pointer("pointermove", 40); });
  expect(phoneHead()?.hasAttribute("data-dragging")).toBe(true);
  expect(document.querySelectorAll("[data-phone-voice-slot]").length).toBe(2);
  await act(async () => { pointer("pointerup", 40); head.click(); });
  await act(async () => settle());
  expect(phoneHead()?.dataset.side).toBe("left");
  expect(document.querySelector("[data-phone-voice-pop]")).toBeNull();
  await phoneRow("hide");
  expect(phoneHead()).toBeNull();
  await act(async () => showPhoneVoice());
  await act(async () => settle());
  expect(phoneHead()?.dataset.side).toBe("left");
  expect(sessionCalls()).toEqual([]);
  /* With no project in view, Talk says to open one, in the bubble, and still starts nothing. */
  await act(async () => mounted!.root.render(<VoiceCompanionHost project={null} mobile />));
  await phoneRow("talk");
  expect(document.querySelector("[data-phone-voice-bubble]")?.textContent?.replace(/\u00a0/gu, " ")).toBe(companionErrorMessage("NO_PROJECT", "en"));
  expect(sessionCalls()).toEqual([]);
});
