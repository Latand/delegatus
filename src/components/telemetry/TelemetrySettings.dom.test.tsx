import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
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
  const { telemetryNotice } = await import("../../../bin/telemetry-notice.mjs");
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
