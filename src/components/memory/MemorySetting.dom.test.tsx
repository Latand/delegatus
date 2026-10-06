import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import { MemorySetting } from "./MemorySetting";
import { OpenRouterKeySetting } from "@/components/asks/OpenRouterKeySetting";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event });
installActEnv();
const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  globalThis.fetch = originalFetch; document.body.innerHTML = "";
  localStorage.clear(); setLocale("en");
});

for (const lang of ["en", "uk"] as const) test(`${lang}: unavailable status keeps the saved switch usable through GET and PUT`, async () => {
  setLocale(lang);
  let enabled = true;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") enabled = JSON.parse(String(init.body)).enabled;
    return Response.json({ enabled, status: "unavailable" });
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySetting project="fixture-project" />); });
  const control = host.querySelector<HTMLInputElement>("[role=switch]")!;
  expect(control.disabled).toBe(false); expect(control.checked).toBe(true);
  await act(async () => { control.click(); });
  expect(enabled).toBe(false); expect(control.checked).toBe(false); expect(control.disabled).toBe(false);
  expect(host.querySelector("[data-memory-status]")?.textContent).toBe(translate(lang, "memory.status.failed"));
  expect(host.querySelector("[data-memory-counts]")).toBeNull();
  expect(host.textContent).not.toContain("$");
});

for (const lang of ["en", "uk"] as const) test(`${lang}: a failed PUT explains saving and retains the saved switch`, async () => {
  setLocale(lang);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => init?.method === "PUT"
    ? Response.json({ error: "write_failed" }, { status: 500 })
    : Response.json({ enabled: true, status: "unavailable" })) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySetting project="fixture-project" />); });
  const control = host.querySelector<HTMLInputElement>("[role=switch]")!;
  await act(async () => { control.click(); });
  expect(control.disabled).toBe(false); expect(control.checked).toBe(true);
  expect(host.querySelector("[role=alert]")?.textContent).toBe(translate(lang, "memory.save.failed"));
  expect(host.querySelector("[data-memory-status]")?.textContent).toBe(translate(lang, "memory.status.failed"));
});

for (const lang of ["en", "uk"] as const) test(`${lang}: staging without a key directs both rows to production settings`, async () => {
  setLocale(lang);
  globalThis.fetch = (async (url: unknown) => Response.json(String(url).includes("/api/asks-you/key")
    ? { present: false, source: null, staging: true }
    : { enabled: true, reasons: ["noKey", "notOwner"], staging: true })) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<><MemorySetting project="fixture-project" /><OpenRouterKeySetting /></>); });
  const status = host.querySelector("[data-memory-status]")?.textContent;
  expect(status).toContain(translate(lang, "memory.status.noKeyStaging"));
  expect(status).not.toContain(translate(lang, "memory.status.noKey"));
  expect(host.querySelector("[data-provider-key] input")).toBeNull();
  expect(host.textContent).toContain(translate(lang, "providerKey.staging"));
  expect(host.textContent).not.toContain(translate(lang, "providerKey.shared"));
});

for (const lang of ["en", "uk"] as const) test(`${lang}: failed PUT keeps the last status, counts and budget beside the save error`, async () => {
  setLocale(lang);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => init?.method === "PUT"
    ? Response.json({ error: "write_failed" }, { status: 500 })
    : Response.json({ enabled: true, reasons: [], month: "2026-10", spentUsd: .125, capUsd: 1,
      counts: { decisions: 3, delivered: 2, prepared: 1, noCandidates: 0, noMatches: 0, skipped: 0, failed: 0 } })) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySetting project="fixture-project" />); });
  const counts = host.querySelector("[data-memory-counts]")?.textContent;
  await act(async () => { host.querySelector<HTMLInputElement>("[role=switch]")!.click(); });
  expect(host.querySelector("[role=alert]")?.textContent).toBe(translate(lang, "memory.save.failed"));
  expect(host.querySelector("[data-memory-status]")?.textContent).toBe(translate(lang, "memory.status.ready"));
  expect(host.querySelector("[data-memory-counts]")?.textContent).toBe(counts);
  expect(host.textContent).toContain(translate(lang, "memory.spend", { spent: "0.125", cap: "1.00" }));
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
