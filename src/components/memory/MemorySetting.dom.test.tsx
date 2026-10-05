import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";
import { translate } from "@/lib/i18n";
import { MemorySetting } from "./MemorySetting";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event });
installActEnv();
const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  globalThis.fetch = originalFetch; document.body.innerHTML = "";
});

for (const enabled of [true, false]) test(`a previous release response keeps the project switch usable (${enabled})`, async () => {
  globalThis.fetch = (async () => Response.json({ enabled, capUsd: 1, spentUsd: .002 })) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySetting project="fixture-project" />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const control = host.querySelector<HTMLInputElement>("[role=switch]")!;
  expect(control).not.toBeNull(); expect(control.checked).toBe(enabled); expect(control.disabled).toBe(false);
  expect(host.querySelector("[data-memory-status]")?.textContent).toBe(translate("en", "memory.status.failed"));
  expect(host.querySelector("[data-memory-counts]")).toBeNull();
  expect(host.textContent).toContain("0.002");
});

test("a completed toggle survives an older refresh and refreshes pause during a write", async () => {
  const view = (enabled: boolean) => ({ enabled, reasons: enabled ? [] : ["projectOff"], capUsd: 1, spentUsd: 0 });
  let getCalls = 0;
  let resolveStale!: (response: Response) => void, resolveWrite!: (response: Response) => void;
  const stale = new Promise<Response>(resolve => { resolveStale = resolve; });
  const write = new Promise<Response>(resolve => { resolveWrite = resolve; });
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => init?.method === "PUT" ? write
    : (++getCalls === 1 ? Response.json(view(false)) : stale)) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySetting project="fixture-project" />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const control = host.querySelector<HTMLInputElement>("[role=switch]")!;
  expect(control.checked).toBe(false);
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); });
  expect(getCalls).toBe(2);
  await act(async () => { control.click(); });
  expect(control.disabled).toBe(true);
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); });
  expect(getCalls).toBe(2);
  await act(async () => { resolveWrite(Response.json(view(true))); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(control.checked).toBe(true);
  await act(async () => { resolveStale(Response.json(view(false))); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(control.checked).toBe(true);
  expect(host.querySelector("[data-memory-status]")?.textContent).toBe(translate("en", "memory.status.ready"));
});
