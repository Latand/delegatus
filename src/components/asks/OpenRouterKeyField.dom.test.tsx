import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import { OpenRouterKeyField } from "./OpenRouterKeyField";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, Node: dom.Node, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, Event: dom.Event });
installActEnv();
const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  globalThis.fetch = originalFetch; document.body.innerHTML = ""; localStorage.clear();
});

for (const lang of ["en", "uk"] as const) for (const status of [400, 500]) {
  test(`${lang}: rejected key (${status}) explains the cause and clears the input without echoing it`, async () => {
    setLocale(lang);
    const submitted = "fixture\u200Bkey";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({ key: submitted });
        return Response.json({ error: status === 400 ? "invalid_key" : "write_failed" }, { status });
      }
      throw new Error("the field reads nothing");
    }) as typeof fetch;
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<OpenRouterKeyField />); });
    const input = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.value = submitted;
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector("[role=alert]")?.textContent).toBe(translate(lang, status === 400 ? "providerKey.invalid" : "providerKey.failed"));
    expect(input.value).toBe("");
    expect(host.textContent).not.toContain(submitted);
  });
}
for (const lang of ["en", "uk"] as const) test(`${lang}: a saved key says so, tells the page, and leaves the field empty`, async () => {
  setLocale(lang);
  let told = 0;
  const tell = () => { told += 1; };
  window.addEventListener("delegatus:provider-key-changed", tell);
  globalThis.fetch = (async () => Response.json({ present: true, source: "file" })) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  let saved = 0;
  await act(async () => { root!.render(<OpenRouterKeyField onSaved={() => { saved += 1; }} />); });
  const input = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    input.value = "fixture-key";
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  window.removeEventListener("delegatus:provider-key-changed", tell);
  expect(host.querySelector("[role=status]")?.textContent).toBe(translate(lang, "providerKey.saved"));
  expect(input.value).toBe("");
  expect(told).toBe(1); expect(saved).toBe(1);
  expect(host.textContent).not.toContain("fixture-key");
});
