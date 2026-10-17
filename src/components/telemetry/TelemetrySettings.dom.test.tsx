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
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, localStorage: dom.localStorage });
const { TelemetrySettingsHost, openTelemetrySettings } = await import("./TelemetrySettings");
const { translate } = await import("@/lib/i18n");
const originalFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; globalThis.fetch = originalFetch; });

function holdPuts(stored: { enabled: boolean; locked: boolean; noticeDismissed: boolean }) {
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
  await act(async () => { root!.render(<TelemetrySettingsHost />); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const toggle = () => document.querySelector<HTMLInputElement>('input[role="switch"]')!;

test("the switch flips at once and stays pressable, a second press sends nothing, and a refusal flips it back with the error", async () => {
  const server = holdPuts({ enabled: true, locked: false, noticeDismissed: true });
  await mount();
  await act(async () => { openTelemetrySettings(); });
  expect(toggle().checked).toBe(true);
  await act(async () => { toggle().click(); });
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(false);
  await act(async () => { toggle().click(); });
  expect(server.puts).toEqual([{ enabled: false }]);
  expect(toggle().checked).toBe(false);
  await server.answer(Response.json({ error: "read-only" }, { status: 500 }));
  expect(toggle().checked).toBe(true);
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
