import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";

/* Audit B25: the install ping's switch and the notice's dismissal show at
   once; a second press while a write is out sends nothing, and a refusal puts
   the stored status back with the error. */

const dom = new Window({ url: "http://localhost" });
installActEnv();
const matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
(dom as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia;
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage, matchMedia, getComputedStyle: dom.getComputedStyle.bind(dom) });
const { TelemetrySettingsHost, openTelemetrySettings } = await import("./TelemetrySettings");
const { SettingsWindowHost } = await import("@/components/settings/SettingsWindow");
const { OnboardingDialog } = await import("@/components/onboarding/OnboardingDialog");
const { telemetryNotice } = await import("../../../bin/telemetry-notice.mjs");
const { translate } = await import("@/lib/i18n");
const originalFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; globalThis.fetch = originalFetch; });

function holdPuts(stored: { enabled: boolean; locked: boolean; noticeDismissed: boolean; swarmRules?: boolean }) {
  const puts: unknown[] = [];
  let release: (response: Response) => void = () => {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "PUT") return Response.json(stored);
    puts.push(JSON.parse(String(init.body)));
    return new Promise<Response>((resolve) => { release = resolve; });
  }) as typeof fetch;
  return { puts, answer: (response: Response) => act(async () => { release(response); await new Promise((resolve) => setTimeout(resolve, 0)); }) };
}

async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<><TelemetrySettingsHost /><SettingsWindowHost project={null} /></>); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const toggle = () => document.querySelector<HTMLButtonElement>("[data-telemetry-ping]")!;
const on = (element: Element) => element.getAttribute("aria-checked") === "true";
const open = async () => { await act(async () => { openTelemetrySettings(); await new Promise((resolve) => setTimeout(resolve, 0)); }); };

test("the switch flips at once and stays pressable, a second press sends nothing, and a refusal flips it back with the error", async () => {
  const server = holdPuts({ enabled: true, locked: false, noticeDismissed: true });
  await mount();
  await open();
  expect(on(toggle())).toBe(true);
  await act(async () => { toggle().click(); });
  expect(on(toggle())).toBe(false);
  expect(toggle().disabled).toBe(false);
  await act(async () => { toggle().click(); });
  expect(server.puts).toEqual([{ enabled: false }]);
  expect(on(toggle())).toBe(false);
  await server.answer(Response.json({ error: "read-only" }, { status: 500 }));
  expect(on(toggle())).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(translate("en", "telemetry.error"));
});

test("Got it hides the notice at once and a refusal shows it again with the error", async () => {
  const server = holdPuts({ enabled: true, locked: false, noticeDismissed: false });
  await mount();
  const dismiss = () => [...document.querySelectorAll("button")].find((button) => button.textContent === translate("en", "telemetry.dismiss"));
  expect(dismiss()).not.toBeUndefined();
  await act(async () => { dismiss()!.click(); });
  expect(dismiss()).toBeUndefined();
  expect(server.puts).toEqual([{ noticeDismissed: true }]);
  await server.answer(Response.json({ error: "read-only" }, { status: 500 }));
  expect(dismiss()).not.toBeUndefined();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(translate("en", "telemetry.error"));
});

test("the notice's button opens Privacy, and the notice steps aside while the window is on screen", async () => {
  holdPuts({ enabled: true, locked: false, noticeDismissed: false });
  await mount();
  const notice = () => document.querySelector("[data-telemetry-notice]");
  await act(async () => { [...notice()!.querySelectorAll("button")].find((button) => button.textContent === translate("en", "settings.section.privacy"))!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(document.querySelector("[data-settings-window] [data-telemetry-settings]")).not.toBeNull();
  expect(notice()).toBeNull();
  await act(async () => { document.querySelector<HTMLElement>("[data-settings-close]")!.click(); });
  expect(notice()).not.toBeNull();
});

test("environment-locked telemetry hides the automatic and settings notices", async () => {
  holdPuts({ enabled: false, locked: true, noticeDismissed: false });
  await mount();
  expect(document.querySelector("[data-telemetry-notice]") === null).toBe(true);
  await open();
  expect(toggle().disabled).toBe(true);
  expect(on(toggle())).toBe(false);
  expect(document.body.textContent).toContain(translate("en", "telemetry.locked"));
  await act(async () => { document.querySelector<HTMLElement>("[data-settings-details-toggle]")!.click(); });
  expect(document.body.textContent).not.toContain(telemetryNotice.en);
});

test("swarm consent starts off and a refused save restores it without changing ping consent", async () => {
  const server = holdPuts({ enabled: false, locked: true, noticeDismissed: true, swarmRules: false });
  await mount();
  await open();
  const swarm = document.querySelector<HTMLButtonElement>("[data-swarm-setting] [role=switch]")!;
  expect(on(swarm)).toBe(false);
  expect(swarm.disabled).toBe(false);
  await act(async () => { swarm.click(); });
  expect(on(swarm)).toBe(true);
  expect(server.puts).toEqual([{ swarmRules: true }]);
  await server.answer(Response.json({ error: "read-only" }, { status: 500 }));
  expect(on(swarm)).toBe(false);
  expect(on(toggle())).toBe(false);
  expect(toggle().disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(translate("en", "telemetry.error"));
});

/* Onboarding v2, slice 1 (A9): fixed to the bottom of the window the notice lay on the open guide's footer, and on
   a phone it took the press meant for Continue. While the guide is open the notice is the guide's own line above
   its footer; the fixed one waits until the guide closes. */

/* The telemetry route keeps what it is sent unless a refusal is set; every other route answers a machine with no agent tool, no bot and no marker. */
function serveGuide(stored: { enabled: boolean; locked: boolean; noticeDismissed: boolean }) {
  const server = { puts: [] as unknown[], refuse: false };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/telemetry")) {
      if (init?.method !== "PUT") return Response.json(stored);
      server.puts.push(JSON.parse(String(init.body)));
      if (server.refuse) return Response.json({ error: "read-only" }, { status: 500 });
      Object.assign(stored, JSON.parse(String(init.body)));
      return Response.json(stored);
    }
    if (url.includes("/api/onboarding")) return Response.json({ marker: null });
    if (url.includes("/api/telegram/bot")) return Response.json({ bot: { connected: false, bot: null, receiving: "stopped", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] } });
    if (url.includes("/api/roles")) return Response.json({ schemaVersion: 2, roles: [] });
    if (url.includes("/api/accounts/copilot")) return Response.json({ cli: { present: false, reason: null }, active: "", accounts: [] });
    return Response.json({ claude: { active: "", cli: "missing", accounts: [] }, codex: { active: "", cli: "missing", accounts: [] } });
  }) as typeof fetch;
  return server;
}

/* The Viewer's own arrangement: the notice host beside the guide, which leaves when it is closed. */
function GuideShell({ mode }: { mode: "guide" | "mapping" }) {
  const [open, setOpen] = useState(true);
  return <>
    <TelemetrySettingsHost />
    <SettingsWindowHost project={null} />
    {open ? <OnboardingDialog mode={mode} marker={null} onClose={() => setOpen(false)} /> : null}
  </>;
}

async function mountGuide(mode: "guide" | "mapping" = "guide"): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<GuideShell mode={mode} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const fixedNotice = () => document.querySelector("[data-telemetry-notice]");
const guideNotice = () => document.querySelector("[data-onboarding-dialog] [data-telemetry-guide-notice]");
const labels = (notice: Element | null) => [...(notice?.querySelectorAll("button") ?? [])].map((button) => button.textContent);
const press = (notice: Element | null, key: "settings.section.privacy" | "telemetry.dismiss") => act(async () => {
  [...notice!.querySelectorAll("button")].find((button) => button.textContent === translate("en", key))!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
const closeGuide = (locale: "en" | "uk" = "en") => act(async () => { document.querySelector<HTMLElement>(`[data-onboarding-dialog] button[aria-label="${translate(locale, "onboarding.close")}"]`)!.click(); });
const bothActions = [translate("en", "settings.section.privacy"), translate("en", "telemetry.dismiss")];

test("inside the open guide the notice is the guide's line above its footer with both actions, Continue lands, and the fixed notice returns once the guide is closed", async () => {
  const server = serveGuide({ enabled: true, locked: false, noticeDismissed: false });
  await mountGuide();
  expect(fixedNotice()).toBeNull();
  expect(document.querySelectorAll("[data-telemetry-guide-notice]").length).toBe(1);
  expect(guideNotice()!.querySelector("p")!.textContent).toBe(telemetryNotice.en);
  expect(labels(guideNotice())).toEqual(bothActions);
  /* Its place is the guide's own: after the step's body and directly before the footer that holds Continue. */
  const footer = document.querySelector("[data-onboarding-dialog] footer")!;
  expect(guideNotice()!.parentElement!.nextElementSibling).toBe(footer);
  expect(footer.querySelector("[data-onboarding-primary]")!.textContent).toBe(translate("en", "onboarding.continue"));
  await act(async () => { footer.querySelector<HTMLElement>("[data-onboarding-primary]")!.click(); });
  expect(document.querySelector("[data-onboarding-dialog]")!.getAttribute("data-onboarding-current")).toBe("project");
  expect(guideNotice()).not.toBeNull();
  await closeGuide();
  expect(document.querySelector("[data-onboarding-dialog]")).toBeNull();
  expect(document.querySelector("[data-telemetry-guide-notice]")).toBeNull();
  expect(fixedNotice()!.parentElement).toBe(document.body);
  expect(fixedNotice()!.querySelector("p")!.textContent).toBe(telemetryNotice.en);
  expect(labels(fixedNotice())).toEqual(bothActions);
  expect(server.puts.filter((body) => "noticeDismissed" in (body as object))).toEqual([]);
});

test("Got it inside the guide: a refusal puts the line back in the guide with the error, and a kept dismissal holds after the guide is closed", async () => {
  const server = serveGuide({ enabled: true, locked: false, noticeDismissed: false });
  await mountGuide();
  server.refuse = true;
  await press(guideNotice(), "telemetry.dismiss");
  expect(guideNotice()!.querySelector('[role="alert"]')!.textContent).toBe(translate("en", "telemetry.error"));
  expect(labels(guideNotice())).toEqual(bothActions);
  expect(fixedNotice()).toBeNull();
  server.refuse = false;
  await press(guideNotice(), "telemetry.dismiss");
  expect(server.puts).toEqual([{ noticeDismissed: true }, { noticeDismissed: true }]);
  expect(guideNotice()).toBeNull();
  /* The guide keeps its footer and its step. */
  expect(document.querySelector("[data-onboarding-dialog] footer [data-onboarding-primary]")).not.toBeNull();
  await closeGuide();
  expect(fixedNotice()).toBeNull();
  expect(document.querySelector("[data-telemetry-guide-notice]")).toBeNull();
});

test("Privacy inside the guide opens the Settings window, the line steps aside while it is on screen and comes back to the guide after", async () => {
  serveGuide({ enabled: true, locked: false, noticeDismissed: false });
  await mountGuide();
  await press(guideNotice(), "settings.section.privacy");
  expect(document.querySelector("[data-settings-window] [data-telemetry-settings]")).not.toBeNull();
  expect(guideNotice()).toBeNull();
  expect(fixedNotice()).toBeNull();
  await act(async () => { document.querySelector<HTMLElement>("[data-settings-close]")!.click(); });
  expect(guideNotice()).not.toBeNull();
  expect(fixedNotice()).toBeNull();
});

test("a guide with the notice already dismissed, or telemetry locked by the environment, draws no line", async () => {
  for (const stored of [{ enabled: true, locked: false, noticeDismissed: true }, { enabled: false, locked: true, noticeDismissed: false }]) {
    serveGuide(stored);
    await mountGuide();
    expect(document.querySelector("[data-onboarding-dialog]")).not.toBeNull();
    expect(document.querySelector("[data-telemetry-guide-notice]")).toBeNull();
    expect(fixedNotice()).toBeNull();
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  }
});

test("the same dialog opened on the agent mapping alone has no footer, and still holds the notice inside itself", async () => {
  serveGuide({ enabled: true, locked: false, noticeDismissed: false });
  await mountGuide("mapping");
  expect(document.querySelector("[data-onboarding-dialog]")!.getAttribute("data-onboarding-dialog")).toBe("mapping");
  expect(document.querySelector("[data-onboarding-dialog] footer")).toBeNull();
  expect(labels(guideNotice())).toEqual(bothActions);
  expect(fixedNotice()).toBeNull();
  await closeGuide();
  expect(labels(fixedNotice())).toEqual(bothActions);
});

test("in Ukrainian the notice keeps its words and ties each one-letter word to the next, in the guide and fixed", async () => {
  const { setLocale } = await import("@/lib/i18n");
  setLocale("uk");
  try {
    serveGuide({ enabled: true, locked: false, noticeDismissed: false });
    await mountGuide();
    for (const notice of [guideNotice, fixedNotice]) {
      const text = notice()!.querySelector("p")!.textContent!;
      expect(text.replaceAll("\u00a0", " ")).toBe(telemetryNotice.uk);
      expect(text).toContain("й\u00a0тип");
      expect(text).toContain("в\u00a0Налаштуваннях");
      expect(/(^|\s)[вузіайояс] /i.test(text)).toBe(false);
      if (notice === guideNotice) await closeGuide("uk");
    }
  } finally {
    setLocale("en");
  }
});
