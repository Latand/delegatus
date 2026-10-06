import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import { KeyPanel, KeyStateWord, MemoryPanel, MemoryReadingProvider, MemoryStateWord } from "./MemoryPage";

/* Shared memory's page and the key's page of the header menu, over stubs of
   the product's own two endpoints. */

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

const COUNTS = { decisions: 214, delivered: 61, prepared: 69, noCandidates: 48, noMatches: 97, skipped: 12, failed: 5 };
const ZERO = { decisions: 0, delivered: 0, prepared: 0, noCandidates: 0, noMatches: 0, skipped: 0, failed: 0 };
type Handler = (url: string, init?: RequestInit) => unknown;
/** Answers memory at `/api/memory/settings` and the key at `/api/asks-you/key`; a Response passes through. */
function serve(memory: Handler, key: Handler = () => ({ present: true, source: "file" })) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const answer = await (url.includes("/api/asks-you/key") ? key(url, init) : memory(url, init));
    return answer instanceof Response ? answer : Response.json(answer);
  }) as typeof fetch;
}
async function render(project = "fixture-project") {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => {
    root!.render(<MemoryReadingProvider project={project}><MemoryStateWord /><MemoryStateWord short /><KeyStateWord /><MemoryPanel /><KeyPanel /></MemoryReadingProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return host;
}
const view = (state: "working" | "off" | "noKey" | "capped", extra: object = {}) => ({
  enabled: state !== "off",
  reasons: [...(state === "off" ? ["projectOff"] : []), ...(state === "noKey" || state === "capped" ? [state] : [])],
  keySource: state === "noKey" ? null : "file", capUsd: 5, spentUsd: state === "capped" ? 5 : state === "noKey" ? 0 : 1.214, month: "2026-10",
  counts: state === "noKey" ? ZERO : COUNTS, ...extra,
});
const switchOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-memory-switch]")!;

for (const lang of ["en", "uk"] as const) test(`${lang}: each state reads as a word beside its dot, and the page agrees with it`, async () => {
  setLocale(lang);
  for (const state of ["working", "off", "noKey", "capped"] as const) {
    serve(() => view(state), () => ({ present: state !== "noKey", source: state === "noKey" ? null : "file" }));
    const host = await render();
    const word = host.querySelector("[data-memory-state]")!;
    expect(word.getAttribute("data-memory-state")).toBe(state);
    const date = lang === "uk" ? "1 листопада" : "November 1";
    expect(word.textContent).toBe(state === "working" ? translate(lang, "memoryState.working", { count: 61 })
      : state === "capped" ? translate(lang, "memoryState.capped", { date }) : translate(lang, `memoryState.${state}`));
    expect(host.querySelectorAll("[data-memory-state]")[1]!.textContent).toBe(translate(lang, "memoryState.short", { state: translate(lang, `memoryState.short.${state}`) }));
    expect(switchOf(host).getAttribute("aria-checked")).toBe(String(state !== "off"));
    const reason = host.querySelector("[data-memory-reason]");
    expect(reason?.getAttribute("data-memory-reason") ?? null).toBe(state === "noKey" || state === "capped" ? state : null);
    if (state === "capped") expect(reason!.textContent).toBe(translate(lang, "memoryPage.reason.capped", { cap: "$5", date }));
    /* A blocked switch that is on turns amber, so it does not read as working. */
    expect(switchOf(host).querySelector("span")!.className.includes("bg-warning")).toBe(state === "noKey" || state === "capped");
    /* A blocked month of zeros is hidden; the rest show three numbers. */
    expect(host.querySelector("[data-memory-numbers]") !== null).toBe(state !== "noKey");
    expect(host.textContent).not.toContain("Jev");
    expect(host.textContent).not.toMatch(/decisions|2026-10|\$\d+\.\d{3}/);
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
  }
});

for (const lang of ["en", "uk"] as const) test(`${lang}: the numbers, the month and the five counters behind Details`, async () => {
  setLocale(lang);
  serve(() => view("working"));
  const host = await render();
  const numbers = [...host.querySelectorAll("[data-memory-numbers] b")].map(node => node.textContent);
  expect(numbers).toEqual(["61", "214", "$1.21"]);
  expect(host.querySelector("[data-memory-numbers]")!.textContent).toContain(translate(lang, "memoryPage.spentOf", { cap: "$5" }));
  /* In the menu, Details ends the scope's line. */
  expect(host.querySelector("[data-memory-scope]")!.textContent).toBe(`${translate(lang, "memoryPage.scope", { month: lang === "uk" ? "жовтень" : "October" })} ${translate(lang, "memoryPage.details")}`);
  expect(host.querySelector("[data-memory-scope] [data-memory-details]")).not.toBeNull();
  expect(host.querySelector("[data-memory-table]")).toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-memory-details]")!.click(); });
  const cells = [...host.querySelectorAll("[data-memory-table] dt, [data-memory-table] dd")].map(node => node.textContent);
  expect(cells).toEqual([
    translate(lang, "memoryPage.picked"), "69", translate(lang, "memoryPage.noCandidates"), "48", translate(lang, "memoryPage.noMatches"), "97",
    translate(lang, "memoryPage.skipped"), "12", translate(lang, "memoryPage.failed"), "5",
  ]);
});

for (const lang of ["en", "uk"] as const) test(`${lang}: without a key, «Enter the key» opens the product's key field where it was pressed`, async () => {
  setLocale(lang);
  let saved = false;
  serve(() => view(saved ? "working" : "noKey"), (_url, init) => {
    if (init?.method === "PUT") { saved = true; return { present: true, source: "file" }; }
    return { present: saved, source: saved ? "file" : null };
  });
  const host = await render();
  const reason = host.querySelector("[data-memory-reason]")!;
  expect(reason.textContent).toContain(translate(lang, "memoryPage.reason.noKey"));
  expect(reason.querySelector("input")).toBeNull();
  await act(async () => { reason.querySelector<HTMLButtonElement>("[data-memory-enter-key]")!.click(); });
  const input = host.querySelector<HTMLInputElement>("[data-memory-reason] [data-provider-key] input")!;
  expect(input).not.toBeNull();
  await act(async () => {
    input.value = "fixture-key";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector("[data-memory-reason] form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelector("[data-memory-state]")!.getAttribute("data-memory-state")).toBe("working");
  expect(host.querySelector("[data-memory-reason]")).toBeNull();
  expect(host.textContent).not.toContain("fixture-key");
});

for (const lang of ["en", "uk"] as const) test(`${lang}: unavailable status keeps the saved switch usable through GET and PUT`, async () => {
  setLocale(lang);
  let enabled = true;
  serve((_url, init) => {
    if (init?.method === "PUT") enabled = JSON.parse(String(init.body)).enabled;
    return { enabled, status: "unavailable" };
  });
  const host = await render();
  const control = switchOf(host);
  expect(control.disabled).toBe(false); expect(control.getAttribute("aria-checked")).toBe("true");
  await act(async () => { control.click(); });
  expect(enabled).toBe(false); expect(control.getAttribute("aria-checked")).toBe("false"); expect(control.disabled).toBe(false);
  expect(host.querySelector("[data-memory-reason]")?.textContent).toBe(translate(lang, "memoryPage.reason.unknown"));
  expect(host.querySelector("[data-memory-state]")!.getAttribute("data-memory-state")).toBe("unknown");
  expect(host.querySelector("[data-memory-numbers]")).toBeNull();
});

for (const lang of ["en", "uk"] as const) test(`${lang}: a failed PUT says so under the switch and keeps the saved state and numbers`, async () => {
  setLocale(lang);
  serve((_url, init) => init?.method === "PUT" ? Response.json({ error: "write_failed" }, { status: 500 }) : view("working"));
  const host = await render();
  const numbers = host.querySelector("[data-memory-numbers]")!.textContent;
  await act(async () => { switchOf(host).click(); });
  expect(switchOf(host).disabled).toBe(false); expect(switchOf(host).getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("[data-memory-setting]")!.textContent).toContain(translate(lang, "memory.save.failed"));
  expect(host.querySelector("[data-memory-state]")!.getAttribute("data-memory-state")).toBe("working");
  expect(host.querySelector("[data-memory-numbers]")!.textContent).toBe(numbers);
});

for (const lang of ["en", "uk"] as const) test(`${lang}: staging without a key directs both pages to production and draws no field`, async () => {
  setLocale(lang);
  serve(() => ({ ...view("noKey"), reasons: ["noKey", "notOwner"], staging: true }), () => ({ present: false, source: null, staging: true }));
  const host = await render();
  expect(host.querySelector("[data-memory-reason]")!.textContent).toBe(translate(lang, "memoryPage.reason.noKeyStaging"));
  expect(host.querySelector("[data-memory-enter-key]")).toBeNull();
  expect(host.querySelector("[data-provider-key]")).toBeNull();
  expect(host.querySelector("[data-key-page]")!.textContent).toContain(translate(lang, "providerKey.staging"));
});

for (const lang of ["en", "uk"] as const) test(`${lang}: the key page: Saved with Replace, Missing with the field, the environment with neither`, async () => {
  setLocale(lang);
  for (const key of [{ present: true, source: "file" }, { present: false, source: null }, { present: true, source: "env" }] as const) {
    serve(() => view("working"), () => key);
    const host = await render();
    const page = host.querySelector("[data-key-page]")!;
    expect(page.textContent).toContain(translate(lang, "keyPage.for"));
    expect(page.querySelector("[data-key-state]")!.textContent).toBe(translate(lang, key.present ? "keyPage.saved" : "keyPage.missing"));
    if (key.source === "file") {
      expect(page.querySelector("input")).toBeNull();
      await act(async () => { page.querySelector<HTMLButtonElement>("[data-key-replace]")!.click(); });
      expect(page.querySelector("input")).not.toBeNull();
    } else if (key.source === null) {
      expect(page.querySelector("input")).not.toBeNull();
    } else {
      expect(page.querySelector("input")).toBeNull();
      expect(page.querySelector("[data-key-replace]")).toBeNull();
      expect(page.textContent).toContain(translate(lang, "keyPage.env"));
    }
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
  }
});

for (const enabled of [true, false]) test(`a previous release response keeps the project switch usable (${enabled})`, async () => {
  serve(() => ({ enabled, capUsd: 1, spentUsd: .002 }));
  const host = await render();
  const control = switchOf(host);
  expect(control.getAttribute("aria-checked")).toBe(String(enabled)); expect(control.disabled).toBe(false);
  expect(host.querySelector("[data-memory-reason]")?.textContent).toBe(translate("en", "memoryPage.reason.unknown"));
  expect(host.querySelector("[data-memory-numbers]")).toBeNull();
});

test("a completed toggle survives an older refresh and refreshes pause during a write", async () => {
  const state = (enabled: boolean) => ({ enabled, reasons: enabled ? [] : ["projectOff"], capUsd: 1, spentUsd: 0, month: "2026-10", counts: COUNTS });
  let getCalls = 0;
  let resolveStale!: (response: Response) => void, resolveWrite!: (response: Response) => void;
  const stale = new Promise<Response>(resolve => { resolveStale = resolve; });
  const write = new Promise<Response>(resolve => { resolveWrite = resolve; });
  serve((_url, init) => init?.method === "PUT" ? write : (++getCalls === 1 ? state(false) : stale));
  const host = await render();
  expect(switchOf(host).getAttribute("aria-checked")).toBe("false");
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); });
  expect(getCalls).toBe(2);
  await act(async () => { switchOf(host).click(); });
  expect(switchOf(host).disabled).toBe(true);
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); });
  expect(getCalls).toBe(2);
  await act(async () => { resolveWrite(Response.json(state(true))); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(switchOf(host).getAttribute("aria-checked")).toBe("true");
  await act(async () => { resolveStale(Response.json(state(false))); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(switchOf(host).getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("[data-memory-state]")!.getAttribute("data-memory-state")).toBe("working");
});

for (const lang of ["en", "uk"] as const) test(`${lang}: a refresh that fails after a good read says so on the page and on both rows, and the next good read clears it`, async () => {
  setLocale(lang);
  let fail = false;
  serve(() => fail ? Response.json({ error: "read_failed" }, { status: 500 }) : view("working"));
  const host = await render();
  const words = () => [...host.querySelectorAll("[data-memory-state]")].map((word) => word.getAttribute("data-memory-state"));
  expect(words()).toEqual(["working", "working"]);
  expect(host.querySelector("[role=alert]")).toBeNull();

  fail = true;
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(words()).toEqual(["unknown", "unknown"]);
  expect(host.querySelector("[data-memory-page]")!.getAttribute("data-memory-tone")).toBe("unknown");
  expect(host.querySelector("[data-memory-page] [role=alert]")?.textContent).toBe(translate(lang, "memoryPage.reason.unknown"));
  expect(host.querySelector("[data-memory-numbers]")).toBeNull();
  /* The switch still shows the last setting read. */
  expect(switchOf(host).getAttribute("aria-checked")).toBe("true");

  fail = false;
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(words()).toEqual(["working", "working"]);
  expect(host.querySelector("[data-memory-page] [role=alert]")).toBeNull();
  expect(host.querySelector("[data-memory-reason]")).toBeNull();
  expect(host.querySelector("[data-memory-numbers]")).not.toBeNull();
});
