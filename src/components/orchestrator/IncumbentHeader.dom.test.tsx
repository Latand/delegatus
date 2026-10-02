import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { resetLocaleForTests, setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { installActEnv } from "@/test-helpers/actEnv";

import { IncumbentHeader } from "./IncumbentHeader";

/* The seat header names the model and the tier the way the composer's pill
   does: the catalogue label and the locale's tier word, never the stored
   launch alias («opus · high»). */

const dom = new Window({ url: "http://127.0.0.1:8899/" });
installActEnv();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
  resetLocaleForTests();
});

async function render(model: string, effort: string, engine: "claude" | "codex" = "claude"): Promise<HTMLElement> {
  globalThis.fetch = (async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <IncumbentHeader
      project="repo-alpha"
      projectName="Alpha"
      incumbent={{ designated: true, engine, model, effort, accountId: null, context: null } as never}
      promptVersion={null}
      file={{ path: "/tmp/seat.jsonl", engine, model } as FileEntry}
      catalog={null}
      predecessorConversationId={null}
      rotating={false}
      opening={false}
      onRotate={() => {}}
    />,
  ));
  return container;
}

const modelNode = (scope: HTMLElement) => scope.querySelector("[data-orchestrator-model]") as HTMLElement;

test("the header names the alias by its catalogue label and the tier by the English word", async () => {
  setLocale("en");
  const scope = await render("opus", "high");
  expect(modelNode(scope).textContent).toBe(`Opus 5.5 · ${translate("en", "reasoningTier.high")}`);
  expect(modelNode(scope).getAttribute("data-orchestrator-model")).toBe("opus");
  expect(modelNode(scope).textContent).not.toContain("opus ");
});

test("the Ukrainian header reads the tier in Ukrainian", async () => {
  setLocale("uk");
  const scope = await render("opus", "high");
  expect(translate("uk", "reasoningTier.high")).not.toBe(translate("en", "reasoningTier.high"));
  expect(modelNode(scope).textContent).toBe(`Opus 5.5 · ${translate("uk", "reasoningTier.high")}`);
});

test("a Codex model keeps its stored id", async () => {
  setLocale("en");
  const scope = await render("gpt-6.1-sol", "xhigh", "codex");
  expect(modelNode(scope).textContent).toBe(`gpt-6.1-sol · ${translate("en", "reasoningTier.xhigh")}`);
});
