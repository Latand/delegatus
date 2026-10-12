import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { setLocale } from "@/lib/i18n";
import { translate } from "@/lib/i18n/core";
import { profileView } from "@/lib/memory/profile";
import { sampleMemory } from "@/lib/memory/profile.fixture";
import { MemoryProfile } from "./MemoryProfile";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator });
afterAll(() => dom.happyDOM.close());

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("a run with no overall yet shows what is happening, names each pending level once, and a topic list keeps one way back", async () => {
  setLocale("en");
  const originalFetch = globalThis.fetch;
  const rules = sampleMemory();
  const container = document.createElement("div");
  const root = createRoot(container);
  const drills: boolean[] = [];
  let release: (() => void) | undefined;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") {
      const frame = { ...profileView(rules, "en", "sample", null), run: { state: "running", startedAt: "2026-01-01", errors: [] } };
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(frame) + "\n"));
        release = () => controller.close();
      } }));
    }
    return Response.json(profileView(rules, "en", "sample", null));
  }) as typeof fetch;
  try {
    flushSync(() => root.render(<MemoryProfile rules={rules} onDrill={open => drills.push(open)} renderRules={scope => <div data-rules-stub="">{scope.scope}</div>} />));
    await tick(); await tick();
    expect(container.textContent).toContain(translate("en", "memoryProfile.noneTitle"));
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-profile-summarize]")!.click());
    await tick(); await tick();
    const text = container.textContent ?? "";
    expect(text).not.toContain(translate("en", "memoryProfile.noneTitle"));
    expect(text).not.toContain(translate("en", "memoryProfile.noneText"));
    expect(text).toContain(translate("en", "memoryProfile.runningTitle"));
    for (const slice of container.querySelectorAll("[data-profile-slice]")) {
      const name = slice.querySelector("h4")!.textContent!;
      expect(slice.textContent!.split(name).length - 1).toBe(1);
      expect(slice.querySelector("[aria-hidden]")).not.toBeNull();
    }
    release?.(); await tick(); await tick();
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-profile-slice] button")!.click());
    expect(drills.at(-1)).toBe(true);
    expect([...container.querySelectorAll("button")].filter(button => button.textContent!.includes(translate("en", "memoryProfile.back"))).length).toBe(1);
    expect(container.textContent).not.toContain(translate("en", "roleMemory.startsWith"));
  } finally {
    flushSync(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});
