import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";

const dom = new Window({ url: "http://localhost" });
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, MouseEvent: dom.MouseEvent, localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom) });
const { PrivacySection } = await import("./PrivacySection");
const { setLocale, translate } = await import("@/lib/i18n");
const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; globalThis.fetch = originalFetch; setLocale("en"); });

for (const locale of ["en", "uk"] as const) test(`${locale}: off is visible with exact destinations; a refused consent write stays off`, async () => {
  setLocale(locale); const writes: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return Response.json({}, { status: 403 }); }
    return Response.json({ enabled: false, source: "default" });
  }) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PrivacySection />); });
  const toggle = document.querySelector<HTMLElement>('[data-subscription-api] [role="switch"]')!;
  const checked = () => document.querySelector('[data-subscription-api] [role="switch"]')!.getAttribute("aria-checked") === "true";
  expect(checked()).toBe(false); expect((toggle as HTMLButtonElement).disabled).toBe(false);
  expect(toggle.getAttribute("aria-label")).toBe(translate(locale, "subscriptionApi.label"));
  /* The endpoints are in «Details», whole. */
  expect(document.body.textContent).not.toContain("api.anthropic.com/api/oauth/usage");
  await act(async () => { document.querySelector<HTMLElement>("[data-settings-details-toggle]")!.click(); });
  expect(document.body.textContent).toContain("api.anthropic.com/api/oauth/usage");
  expect(document.body.textContent).toContain("api.anthropic.com/v1/messages");
  expect(document.body.textContent).toContain("Claude Code");
  await act(async () => { toggle.click(); });
  expect(writes).toEqual([{ enabled: true }]); expect(checked()).toBe(false);
  expect(document.querySelector('[data-subscription-api] [role="alert"]')).not.toBeNull();
});
test("an unreadable setting cannot be enabled", async () => {
  globalThis.fetch = (async () => Response.json({}, { status: 500 })) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PrivacySection />); });
  expect(document.querySelector<HTMLButtonElement>('[data-subscription-api] [role="switch"]')!.disabled).toBe(true);
  expect(document.querySelector('[data-subscription-api] [role="alert"]')).not.toBeNull();
});
test("a committed consent with a lost acknowledgement is read back and can be revoked", async () => {
  let stored = false; let loseReply = true;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      stored = JSON.parse(String(init.body)).enabled;
      if (loseReply) { loseReply = false; throw Error("reply lost"); }
    }
    return Response.json({ enabled: stored });
  }) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PrivacySection />); });
  const toggle = document.querySelector<HTMLElement>('[data-subscription-api] [role="switch"]')!;
  const checked = () => document.querySelector('[data-subscription-api] [role="switch"]')!.getAttribute("aria-checked") === "true";
  await act(async () => { toggle.click(); });
  expect(stored).toBe(true); expect(checked()).toBe(true);
  expect(document.querySelector('[data-subscription-api] [role="alert"]')).not.toBeNull();
  await act(async () => { toggle.click(); });
  expect(stored).toBe(false); expect(checked()).toBe(false);
});

test("the consent moves at once and takes no second press while its write is out", async () => {
  const writes: unknown[] = []; let answer: (response: Response) => void = () => {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return new Promise<Response>((resolve) => { answer = resolve; }); }
    return Response.json({ enabled: false });
  }) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PrivacySection />); });
  const toggle = document.querySelector<HTMLButtonElement>('[data-subscription-api] [role="switch"]')!;
  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => { toggle.click(); });
  expect(writes).toEqual([{ enabled: true }]);
  await act(async () => { answer(Response.json({ enabled: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector('[data-subscription-api] [role="alert"]')).toBeNull();
});
test("the swarm line names the anonymous counts, and the rows hold no native checkbox", async () => {
  globalThis.fetch = (async (url: unknown) => String(url).includes("telemetry") ? Response.json({ enabled: true, locked: false, noticeDismissed: true, swarmRules: false }) : Response.json({ enabled: false })) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PrivacySection />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(document.querySelector("[data-swarm-setting]")?.textContent).toContain(translate("en", "settings.privacy.swarmHint"));
  expect(document.querySelector("input")).toBeNull();
  expect([...document.querySelectorAll('[role="switch"]')]).toHaveLength(3);
});
