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

test("level cards follow the All rules order and a topic list says which topic it belongs to", async () => {
  setLocale("en");
  const originalFetch = globalThis.fetch;
  const rules = sampleMemory();
  /* The store lists the every-project level first; the page must put this project's level ahead of it. */
  const reordered = { ...rules, scopes: [rules.scopes[1]!, rules.scopes[0]!, ...rules.scopes.slice(2)] };
  const container = document.createElement("div");
  const root = createRoot(container);
  const headings: Array<[string, string | undefined]> = [];
  const base = profileView(reordered, "en", "sample", null);
  const overall = { scope: "overall", createdAt: "2026-01-01T10:00:00Z", durationMs: 1, model: "sample", promptVersion: 1, stale: false,
    answer: { headline: "Clearer samples", text: "Agents check sample colors.", topics: [{ title: "Isolated tests", text: "Tests run apart.", ruleIds: ["one", "three"] }] } };
  globalThis.fetch = (async () => Response.json({ ...base, overall })) as unknown as typeof fetch;
  try {
    flushSync(() => root.render(<MemoryProfile rules={reordered} renderRules={(scope, ids, heading) => { headings.push([scope.scope, heading?.title]); return <div data-rules-stub="">{ids?.join(",")}</div>; }} />));
    await tick(); await tick();
    const names = [...container.querySelectorAll("[data-profile-slice]")].map(slice => slice.querySelector("h4")!.textContent);
    expect(names).toEqual([
      `${translate("en", "roleMemory.roleSection")} · ${translate("en", "memoryProfile.thisProject")}`,
      `${translate("en", "roleMemory.roleSection")} · ${translate("en", "memoryProfile.everyProject")}`,
      translate("en", "roleMemory.projectSection"), translate("en", "roleMemory.machineSection"),
    ].map((name, index) => index < 2 ? name.replace(translate("en", "roleMemory.roleSection"), "Builder") : name));
    expect(container.textContent).not.toMatch(/\b(AM|PM)\b/);
    const topic = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent!.startsWith("Isolated tests"));
    expect(topic).toBeDefined();
    flushSync(() => topic!.click());
    expect(headings.slice(-2).map(([, title]) => title)).toEqual(["Isolated tests", "Isolated tests"]);
  } finally {
    flushSync(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

for (const [model, name] of [["claude-opus-5-5", "Opus 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]]) {
  test(`profile footer names the stored ${name} model`, async () => {
    setLocale("en");
    const originalFetch = globalThis.fetch;
    const rules = sampleMemory();
    const base = profileView(rules, "en", "claude-opus-5-5", null);
    const container = document.createElement("div");
    const root = createRoot(container);
    globalThis.fetch = (async () => Response.json({ ...base, overall: {
      scope: "overall", model, createdAt: "2026-01-01", durationMs: 1, promptVersion: 1, stale: false,
      answer: { headline: "Clearer samples", text: "Agents check sample colors.", topics: [] },
    } })) as unknown as typeof fetch;
    try {
      flushSync(() => root.render(<MemoryProfile rules={rules} renderRules={() => null} />));
      await tick(); await tick();
      expect(container.textContent).toContain(name);
      expect(container.textContent).not.toContain(model);
    } finally {
      flushSync(() => root.unmount()); globalThis.fetch = originalFetch;
    }
  });
}

test("while the first profile answer is pending the card reads, offers no Summarize, and one request goes out even when the same rules are re-read", async () => {
  setLocale("en");
  const originalFetch = globalThis.fetch;
  const rules = sampleMemory();
  const container = document.createElement("div");
  const root = createRoot(container);
  const reads: string[] = [];
  let answer: (() => void) | undefined;
  globalThis.fetch = (async (url, init) => {
    reads.push(`${init?.method ?? "GET"} ${String(url)}`);
    await new Promise<void>(resolve => { answer = resolve; });
    return Response.json(profileView(rules, "en", "sample", null));
  }) as typeof fetch;
  const draw = (value: typeof rules) => flushSync(() => root.render(<MemoryProfile rules={value} renderRules={() => <div />} />));
  try {
    draw(rules);
    await tick();
    expect(container.textContent).toContain(translate("en", "memoryProfile.reading"));
    expect(container.textContent).not.toContain(translate("en", "memoryProfile.noneTitle"));
    expect(container.querySelector("[data-profile-summarize]")).toBeNull();
    draw({ ...rules, scopes: rules.scopes.map(scope => ({ ...scope })) });
    await tick();
    expect(reads.length).toBe(1);
    answer?.(); await tick(); await tick();
    expect(container.textContent).toContain(translate("en", "memoryProfile.noneTitle"));
    expect(container.querySelector("[data-profile-summarize]")).not.toBeNull();
    expect(reads.length).toBe(1);
    expect(reads.every(read => read.startsWith("GET "))).toBe(true);
  } finally {
    flushSync(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a refused first profile read ends the reading state, shows the error with a way to try again, and sends no summarization", async () => {
  setLocale("en");
  const originalFetch = globalThis.fetch;
  const rules = sampleMemory();
  const container = document.createElement("div");
  const root = createRoot(container);
  const reads: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    reads.push(init?.method ?? "GET");
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    flushSync(() => root.render(<MemoryProfile rules={rules} renderRules={() => <div />} />));
    await tick(); await tick(); await tick();
    expect(container.textContent).not.toContain(translate("en", "memoryProfile.reading"));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector("[data-profile-summarize]")).not.toBeNull();
    expect(reads.includes("POST")).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});
