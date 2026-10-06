import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import { OpenRouterKeySetting } from "./OpenRouterKeySetting";

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
      return Response.json({ present: false, source: null });
    }) as typeof fetch;
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<OpenRouterKeySetting />); });
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
for (const lang of ["en", "uk"] as const) for (const source of [null, "file", "env"]) {
  test(`${lang}: staging explains the shared production key and hides the form (${source})`, async () => {
    setLocale(lang);
    globalThis.fetch = (async () => Response.json({ present: source !== null, source, staging: true })) as unknown as typeof fetch;
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<OpenRouterKeySetting />); });
    expect(host.querySelector("form") === null).toBe(true);
    expect(host.querySelector("input") === null).toBe(true);
    expect(host.textContent).toContain(translate(lang, "providerKey.staging"));
    expect(host.textContent).not.toContain(translate(lang, "providerKey.shared"));
    expect(host.textContent).toContain(translate(lang, source === "env" ? "providerKey.env" : source === "file" ? "providerKey.fileStatus" : "providerKey.missingStatus"));
  });
}
for (const lang of ["en", "uk"] as const) test(`${lang}: environment key hides the local-save instructions`, async () => {
  setLocale(lang);
  globalThis.fetch = (async () => Response.json({ present: true, source: "env" })) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<OpenRouterKeySetting />); });
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain(translate(lang, "providerKey.env"));
  expect(host.textContent).not.toContain(translate(lang, "providerKey.shared"));
});
