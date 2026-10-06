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

/*
 * The live path whole (#2519 C, G, H): the shell's mount, the real adapter, the
 * production session route and the session service over the local fake provider.
 * Only the browser's media objects are stand-ins; nothing leaves the process.
 */
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
  const storage = new CompanionStorage();
  storage.updateSettings({ enabled: true });
  const provider = new FakeLiveProvider();
  const sent: string[] = [];
  const admission = new CompanionAdmission(storage, {
    recipient: project => ({ project, conversationId: `conversation_${project}`, seatEpoch: 1, engine: "claude" }),
    send: async binding => { sent.push(binding.delivery.clientMessageId); return { status: "queued", operationId: `operation-${sent.length}` }; }, reports: () => [] });
  const reads = new CompanionBoardReads({ tasks: () => ["project-a", "project-b"].map(project => ({ id: `task-${project}`, project, text: `Task of ${project}`, status: "open" })),
    pipelines: () => [], activity: async () => [], messages: async () => [] });
  const service = new CompanionLiveSessions(storage, admission, reads, provider, { key: () => FAKE_KEY, timers: false, closeTimeoutMs: 20 });
  setCompanionSessionsForTests(service);
  const track = { enabled: true, stops: 0, stop() { this.stops += 1; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const stand: Record<string, unknown> = {
    RTCPeerConnection: class extends EventTarget {
      iceGatheringState = "complete"; connectionState = "connected"; localDescription = { sdp: "v=0\r\n" };
      addTrack() {} createDataChannel() { return Object.assign(new EventTarget(), { close() {} }); }
      async createOffer() { return {}; } async setLocalDescription() {} async setRemoteDescription() {} close() {}
    },
    AudioContext: class { state = "running"; async resume() {} async close() {} createAnalyser() { return { fftSize: 512, getFloatTimeDomainData() {} }; } createMediaStreamSource() { return { connect() {} }; } },
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
  const document = settingsOf({ enabled: true, keySource: "file" });
  harness.setRoute(async (url, init) => {
    const target = new URL(url, "http://127.0.0.1:8898");
    if (target.pathname === "/api/voice-companion/settings") return jsonResponse(document);
    if (target.pathname === "/api/orchestrator/seat") {
      const project = target.searchParams.get("project");
      return jsonResponse({ seat: { project, conversationId: `conversation_${project}`, seatEpoch: 1, engine: "claude" }, pending: null, lastFailure: null, exists: true, viewerMcpRegistered: true, previous: [], currentTask: null, all: null });
    }
    if (target.pathname !== "/api/voice-companion/session") return jsonResponse({ error: "not routed in this test" }, 404);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { action?: string } : null;
    const lost = body?.action === "command" ? failing.command : null;
    if (lost === "before") { failing.command = null; return jsonResponse({ code: "COMPANION_UNAVAILABLE" }, 502); }
    const request = new NextRequest(`http://127.0.0.1${target.pathname}${target.search}`, { method: init?.method ?? "GET", headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin" }, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const answer = await (body ? route.POST(request) : route.GET(request));
    if (lost === "after") { failing.command = null; return jsonResponse({ code: "COMPANION_UNAVAILABLE" }, 502); }
    return answer;
  });
  const propose = async (providerId: string, instruction: string) => {
    /* Live delegates to the server; its backend proposes, then speaks. */
    provider.responder = (request, index) => request.input.some(item => item.type === "function_call_output") ? backendResponse(`resp_${index}`, [message("The proposal is on the card.")])
      : backendResponse(`resp_${index}`, [functionCall(`call-${instruction}`, "request_orchestrator_delegation", { instruction })]);
    provider.replay(providerId, delegationCreated(`delegation-${instruction}`, 100));
    /* The adapter reads the Viewer every half second. */
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
  };
  return {
    storage, provider, sent, failing, propose, service, trackStops: () => track.stops,
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

test("another project in view, or none, ends the live conversation: no read, no proposal and no paid start follows it there", async () => {
  const live = await liveHarness();
  try {
    await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
    expect(live.starts()).toBe(0);
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    const [first] = Object.values(live.storage.read().sessions);
    expect([live.starts(), first.project, first.closed]).toEqual([1, "project-a", false]);
    await live.propose(live.provider.sessions[0].id, "Review the plan");
    expect(document.querySelector<HTMLElement>("[data-companion-delegation]")?.dataset.stage).toBe("awaiting-confirmation");
    const proposal = Object.values(live.storage.read().sessions[first.id].proposals)[0].proposal;

    await act(async () => mounted!.root.render(<VoiceCompanionHost project="project-b" mobile={false} />));
    await pause(200);
    expect(live.storage.read().sessions[first.id].closed).toBe(true);
    expect(live.provider.attached).toBe(0);
    /* The companion of project B is idle: no session was started for it. */
    expect(document.querySelector<HTMLElement>("[data-voice-companion]")?.dataset.phase).toBe("offline");
    expect(document.querySelector("[data-companion-delegation]")).toBeNull();
    expect(live.starts()).toBe(1);
    /* The provider still speaking for the old session reads nothing of project A. */
    const answers = live.provider.commands.length;
    const asked = live.provider.requests.length;
    live.provider.replay(live.provider.sessions[0].id, { type: "session.delegation.created", event_id: "late-read", offset_ms: 9_000, delegation: { id: "late", type: "delegation", target: "client" } });
    await pause();
    expect([live.provider.commands.length, live.provider.requests.length]).toEqual([answers, asked]);
    /* The proposal made in A cannot be sent any more. */
    await live.service.command(first.id, { type: "confirmation", proposalId: proposal.proposalId, decision: "send", via: "tap" }).catch(() => undefined);
    expect(live.sent).toEqual([]);
    expect(live.storage.read().sessions[first.id].proposals[proposal.proposalId].state).toBe("cancelled");

    /* B talks only after its own tap, and to its own project. */
    await click(document.querySelector("[data-companion-talk]"));
    await pause();
    const second = Object.values(live.storage.read().sessions).find((row) => !row.closed)!;
    expect([live.starts(), second.project]).toEqual([2, "project-b"]);
    await act(async () => mounted!.root.render(<VoiceCompanionHost project={null} mobile={false} />));
    await pause(200);
    expect(Object.values(live.storage.read().sessions).every((row) => row.closed)).toBe(true);
    expect(live.starts()).toBe(2);
  } finally { await unmountNow(); await live.release(); }
});

test("a Send whose request or reply is lost says delivery is not confirmed, keeps the card, and another tap delivers once", async () => {
  for (const lost of ["before", "after"] as const) {
    const live = await liveHarness();
    try {
      await mount(<VoiceCompanionHost project="project-a" mobile={false} />);
      await click(document.querySelector("[data-companion-talk]"));
      await pause();
      await live.propose(live.provider.sessions[0].id, "Review the plan");
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
