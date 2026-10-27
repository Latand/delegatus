import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Locale } from "@/lib/i18n/core";
import { profileView } from "@/lib/memory/profile";
import { sampleMemory } from "@/lib/memory/profile.fixture";
import { useMemoryProfile } from "./useMemoryProfile";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator });
afterAll(() => dom.happyDOM.close());

test("changing locale during a stream releases the old send and reads the new cache", async () => {
  const originalFetch = globalThis.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const rules = sampleMemory();
  let cancelled = false;
  globalThis.fetch = (async (url, init) => {
    if (init?.method === "POST") {
      return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener("abort", () => {
          cancelled = true;
          controller.error(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      } }));
    }
    const locale = new URL(String(url), "http://localhost").searchParams.get("locale") as Locale;
    return Response.json(profileView(rules, locale, "sample", null));
  }) as typeof fetch;
  function Probe({ locale }: { locale: Locale }) {
    const profile = useMemoryProfile("garden", locale, "sample");
    return <><output>{profile.view?.locale}</output><button disabled={profile.running} onClick={() => void profile.summarize()}>Summarize</button></>;
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    flushSync(() => root.render(<Probe locale="en" />));
    await tick(); await tick();
    flushSync(() => container.querySelector("button")!.click());
    await tick();
    expect(container.querySelector("button")!.disabled).toBe(true);
    flushSync(() => root.render(<Probe locale="uk" />));
    await tick(); await tick();
    expect(cancelled).toBe(true);
    expect(container.querySelector("output")!.textContent).toBe("uk");
    expect(container.querySelector("button")!.disabled).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});
