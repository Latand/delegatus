import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { AsksYouSettingView } from "@/lib/asks/types";

/* The "Asks you" switch (docs/research/attention-classifier.md §7): off by
   default, its hint says what leaves the machine, it cannot be turned on
   without a key, and once on it shows this month's spend against the cap. */

const dom = new HappyWindow({ url: "http://127.0.0.1:8899/" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event });

const { AsksYouRow } = await import("./AsksYouRow");
const { resetAsksYouSettingForTests } = await import("./asksYouSetting");

const realFetch = globalThis.fetch;
let root: Root | null = null;
let view: AsksYouSettingView;
let writes: unknown[] = [];

function settingView(overrides: Partial<AsksYouSettingView> = {}): AsksYouSettingView {
  return { enabled: false, keySource: "file", keyPath: "$HOME/.config/agent-log-viewer/openrouter-api-key", month: "2026-09", spentUsd: 0, capUsd: 1, calls: 0, capped: 0, ...overrides };
}

beforeEach(() => {
  writes = [];
  view = settingView();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== "/api/asks-you") return new Response("{}", { status: 404 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { enabled: boolean };
      writes.push(body);
      view = { ...view, enabled: body.enabled };
    }
    return new Response(JSON.stringify({ ok: true, ...view }));
  }) as typeof fetch;
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  resetAsksYouSettingForTests();
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<AsksYouRow variant="menu" />));
  return host;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Bun.sleep(5);
}

test("is off by default and says what turning it on sends, and where", async () => {
  const host = mount();
  await settle();
  const toggle = host.querySelector("[data-asks-you-switch]") as HTMLButtonElement;
  expect(host.querySelector("[data-asks-you]")!.getAttribute("data-asks-you")).toBe("off");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(host.textContent).toContain("Off, for all projects. When on, the last message of each agent's turn is sent to Jev on OpenRouter");

  toggle.click();
  await settle();
  expect(writes).toEqual([{ enabled: true }]);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("This month $0.00 of $1.00.");
});

test("without an OpenRouter key it cannot be turned on, and says where the key goes", async () => {
  view = settingView({ keySource: null });
  const host = mount();
  await settle();
  expect((host.querySelector("[data-asks-you-switch]") as HTMLButtonElement).disabled).toBe(true);
  expect(host.textContent).toContain("Needs an OpenRouter key: set OPENROUTER_API_KEY or put the key in $HOME/.config/agent-log-viewer/openrouter-api-key.");
});

test("a spent cap says so", async () => {
  view = settingView({ enabled: true, spentUsd: 1, capped: 3 });
  const host = mount();
  await settle();
  expect(host.textContent).toContain("This month's cap is reached ($1.00 of $1.00)");
});
