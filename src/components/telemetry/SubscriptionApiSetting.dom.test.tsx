import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";

const dom = new Window({ url: "http://localhost" });
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, MouseEvent: dom.MouseEvent, localStorage: dom.localStorage });
const { SubscriptionApiSetting } = await import("./SubscriptionApiSetting");
const { setLocale, translate } = await import("@/lib/i18n");
const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; globalThis.fetch = originalFetch; setLocale("en"); });

for (const locale of ["en", "uk"] as const) test(`${locale}: off is visible with exact destinations; a refused consent write stays off`, async () => {
  setLocale(locale); const writes: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return Response.json({}, { status: 403 }); }
    return Response.json({ enabled: false, source: "default" });
  }) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<SubscriptionApiSetting />); });
  const toggle = document.querySelector<HTMLInputElement>('[role="switch"]')!;
  expect(toggle.checked).toBe(false); expect(toggle.disabled).toBe(false);
  expect(toggle.getAttribute("aria-label")).toBe(translate(locale, "subscriptionApi.label"));
  expect(document.body.textContent).toContain("api.anthropic.com/api/oauth/usage");
  expect(document.body.textContent).toContain("Claude Code");
  await act(async () => { toggle.click(); });
  expect(writes).toEqual([{ enabled: true }]); expect(toggle.checked).toBe(false);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
});
test("an unreadable setting cannot be enabled", async () => {
  globalThis.fetch = (async () => Response.json({}, { status: 500 })) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<SubscriptionApiSetting />); });
  expect(document.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
});
test("a committed consent with a lost acknowledgement is read back and can be revoked", async () => {
  let stored = false; let loseReply = true;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") {
      stored = JSON.parse(String(init.body)).enabled;
      if (loseReply) { loseReply = false; throw Error("reply lost"); }
    }
    return Response.json({ enabled: stored });
  }) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<SubscriptionApiSetting />); });
  const toggle = document.querySelector<HTMLInputElement>('[role="switch"]')!;
  await act(async () => { toggle.click(); });
  expect(stored).toBe(true); expect(toggle.checked).toBe(true);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => { toggle.click(); });
  expect(stored).toBe(false); expect(toggle.checked).toBe(false);
});
