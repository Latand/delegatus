import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

/* docs/design/orchestrator-reports.md §4.2: the toggle writes the choice to
   the server; a page load adopts the server's language when another device
   chose it, and reports what it shows as `detected` when the server has none.
   Storage stays the boot cache. */

const dom = new Window({ url: "http://127.0.0.1:8899/" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage });

const { chooseLocale, getLocale, resetLocaleForTests, setLocale, syncOperatorLocale } = await import("./index");

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let server: { locale: { value: string } | null; timeZone: { value: string } | null } = { locale: null, timeZone: null };

beforeEach(() => {
  calls = [];
  dom.localStorage.clear();
  resetLocaleForTests();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, ...server }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

test("the toggle writes the choice to the server as chosen, with the time zone; rendering a language writes nothing", async () => {
  setLocale("en");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual([]);
  chooseLocale("uk");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(dom.localStorage.getItem("llv_lang")).toBe("uk");
  expect(calls).toEqual([{ url: "/api/operator/settings", method: "PUT", body: { locale: "uk", source: "chosen", timeZone: zone } }]);
});

test("a load adopts the server's language without writing it back", async () => {
  dom.localStorage.setItem("llv_lang", "en");
  server = { locale: { value: "uk" }, timeZone: { value: zone } };
  await syncOperatorLocale();
  expect(getLocale()).toBe("uk");
  expect(dom.localStorage.getItem("llv_lang")).toBe("uk");
  expect(calls.map((call) => call.method)).toEqual(["GET"]);
});

test("with nothing on the server, a load reports what it shows as detected; once per load", async () => {
  dom.localStorage.setItem("llv_lang", "uk");
  server = { locale: null, timeZone: null };
  await syncOperatorLocale();
  await syncOperatorLocale();
  expect(calls).toEqual([
    { url: "/api/operator/settings", method: "GET", body: null },
    { url: "/api/operator/settings", method: "PUT", body: { locale: "uk", source: "detected", timeZone: zone } },
  ]);
});
