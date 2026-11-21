import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { setLocale } from "@/lib/i18n";
import { translate } from "@/lib/i18n/core";
import { profileView } from "@/lib/memory/profile";
import { sampleMemory, sampleRule, sampleScope } from "@/lib/memory/profile.fixture";
import type { ProfilePartView } from "@/lib/memory/profileTypes";
import type { RoleMemoryProjectView } from "@/lib/memory/roleTypes";
import { MemoryProfile, profileLevels, type Selection } from "./MemoryProfile";
import { useMemoryProfile } from "./useMemoryProfile";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator });
afterAll(() => dom.happyDOM.close());

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** The column as the window mounts it: the hook's answer, the levels the data gives, one selection. */
function Column({ rules, onSelect, selected = null, mobile = false }: { rules: RoleMemoryProjectView | null; onSelect?: (selection: Selection) => void; selected?: Selection | null; mobile?: boolean }) {
  const profile = useMemoryProfile(rules?.project ?? "garden", "en", "sample");
  return <MemoryProfile rules={rules} profile={profile} levels={profileLevels(rules, profile.view)} selected={selected} mobile={mobile} onSelect={onSelect ?? (() => {})} />;
}

const part = (scope: string, headline: string, topics: ProfilePartView["answer"]["topics"] = []): ProfilePartView => ({
  scope, createdAt: "2026-01-01T10:00:00Z", durationMs: 1, model: "sample", promptVersion: 1, stale: false, answer: { headline, text: `${headline}, said in full.`, topics },
});

test("profileLevels lists the scopes the window can open, in the order the rules page used", () => {
  const rules = sampleMemory();
  const departed = { ...sampleRule("gone"), state: "archived" as const, reason: "deleted" as const };
  const view: RoleMemoryProjectView = { ...rules, scopes: [
    /* The store lists the every-project level first; this project's level must come ahead of it. */
    rules.scopes[1]!, rules.scopes[0]!,
    { ...sampleScope("role:garden:reviewer", []), left: [departed] },
    sampleScope("role:garden:architect", []),
    { ...sampleScope("swarm:builder", [sampleRule("public")]), kind: "swarm", roleId: "builder" },
    { ...sampleScope("swarm:reviewer", []), kind: "swarm", roleId: "reviewer" },
    rules.scopes[2]!, rules.scopes[3]!,
  ] };
  const levels = profileLevels(view, null);
  expect(levels.map(level => level.scope)).toEqual(["role:garden:builder", "role:*:builder", "role:garden:reviewer", "swarm:builder", "project:garden", "machine"]);
  expect(levels.find(level => level.scope === "role:garden:reviewer")).toMatchObject({ count: 0, left: 1 });
  expect(levels.map(level => level.scope)).not.toContain("role:garden:architect");
  expect(levels.map(level => level.scope)).not.toContain("swarm:reviewer");
  expect(levels.reduce((sum, level) => sum + level.count, 0)).toBe(view.scopes.reduce((sum, scope) => sum + scope.active.length, 0));
});

test("the project and the machine are listed with 0 when nothing is in them", () => {
  const empty: RoleMemoryProjectView = { project: "garden", enabled: true, scopes: [sampleScope("project:garden", []), sampleScope("machine", [])] };
  expect(profileLevels(empty, null).map(level => [level.scope, level.count])).toEqual([["project:garden", 0], ["machine", 0]]);
  expect(profileLevels(null, null)).toEqual([]);
});

test("before the rules arrive the saved profile's slices stand in, and a slice with nothing in it is left out", () => {
  const rules = sampleMemory();
  const base = profileView(rules, "en", "sample", null);
  const levels = profileLevels(null, base);
  expect(levels.map(level => level.scope)).toEqual(["role:garden:builder", "role:*:builder", "project:garden", "machine"]);
  expect(levels.every(level => level.left === 0)).toBe(true);
});

test("a run with no overall yet shows what is happening, and each pending level names itself once beside one placeholder bar", async () => {
  setLocale("en");
  const originalFetch = globalThis.fetch;
  const rules = sampleMemory();
  const container = document.createElement("div");
  const root = createRoot(container);
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
    flushSync(() => root.render(<Column rules={rules} />));
    await tick(); await tick();
    expect(container.textContent).toContain(translate("en", "memoryProfile.noneTitle"));
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-profile-summarize]")!.click());
    await tick(); await tick();
    const text = container.textContent ?? "";
    expect(text).not.toContain(translate("en", "memoryProfile.noneTitle"));
    expect(text).not.toContain(translate("en", "memoryProfile.noneText"));
    expect(text).toContain(translate("en", "memoryProfile.runningTitle"));
    const rows = [...container.querySelectorAll("[data-profile-level]")];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const name = row.querySelector("span span")!.textContent!;
      expect(row.textContent!.split(name).length - 1).toBe(1);
      expect(row.querySelectorAll("[aria-hidden] > span")).toHaveLength(1);
      expect(row.textContent).not.toContain(translate("en", "memoryProfile.noneText"));
    }
    release?.(); await tick(); await tick();
  } finally {
    flushSync(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a ready profile shows each level's headline and count; a level row selects its scope, a topic row selects its rules", async () => {
  setLocale("en");
  const originalFetch = globalThis.fetch;
  const rules = sampleMemory();
  const base = profileView(rules, "en", "sample", null);
  const overall = part("overall", "Clearer samples", [{ title: "Isolated tests", text: "Tests run apart.", ruleIds: ["one", "three"] }, { title: "Unlinked", ruleIds: [] }]);
  globalThis.fetch = (async () => Response.json({ ...base, overall, slices: base.slices.map(slice => slice.scope === "role:garden:builder" ? { ...slice, summary: part(slice.scope, "Builders check colors") } : slice) })) as unknown as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const chosen: Selection[] = [];
  try {
    flushSync(() => root.render(<Column rules={rules} onSelect={selection => chosen.push(selection)} />));
    await tick(); await tick();
    const rows = [...container.querySelectorAll<HTMLButtonElement>("[data-profile-level]")];
    expect(rows.map(row => row.getAttribute("data-profile-level"))).toEqual(["role:garden:builder", "role:*:builder", "project:garden", "machine"]);
    expect(rows[0]!.textContent).toContain("Builders check colors");
    expect(rows[0]!.textContent).toContain("Builder · This project");
    expect(rows.map(row => row.lastElementChild!.textContent)).toEqual(["2", "1", "1", "1"]);
    flushSync(() => rows[2]!.click());
    expect(chosen.at(-1)).toEqual({ kind: "level", scope: "project:garden" });
    const topics = [...container.querySelectorAll<HTMLButtonElement>("[data-profile-topic]")];
    expect(topics.map(topic => topic.disabled)).toEqual([false, true]);
    flushSync(() => topics[0]!.click());
    expect(chosen.at(-1)).toEqual({ kind: "topic", title: "Isolated tests", text: "Tests run apart.", ids: ["one", "three"], index: 0 });
  } finally {
    flushSync(() => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("the chosen row is current and carries the accent; a phone draws no row as chosen and ends each row in a chevron", async () => {
  setLocale("en");
  const originalFetch = globalThis.fetch;
  const rules = sampleMemory();
  const base = profileView(rules, "en", "sample", null);
  globalThis.fetch = (async () => Response.json({ ...base, overall: part("overall", "Clearer samples", [{ title: "Isolated tests", ruleIds: ["one"] }]) })) as unknown as typeof fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Column rules={rules} selected={{ kind: "level", scope: "machine" }} />));
    await tick(); await tick();
    expect([...container.querySelectorAll("[aria-current]")].map(row => row.getAttribute("data-profile-level"))).toEqual(["machine"]);
    expect(container.querySelector("svg")).toBeNull();
    flushSync(() => root.render(<Column rules={rules} selected={{ kind: "topic", title: "Isolated tests", ids: ["one"], index: 0 }} />));
    expect([...container.querySelectorAll("[aria-current]")].map(row => row.getAttribute("data-profile-topic"))).toEqual(["0"]);
    flushSync(() => root.render(<Column rules={rules} mobile />));
    expect(container.querySelector("[aria-current]")).toBeNull();
    expect(container.querySelectorAll("[data-profile-level] svg")).toHaveLength(4);
    expect(container.querySelectorAll("[data-profile-topic] svg")).toHaveLength(1);
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
      flushSync(() => root.render(<Column rules={rules} />));
      await tick(); await tick();
      expect(container.textContent).toContain(name);
      expect(container.textContent).not.toContain(model);
    } finally {
      flushSync(() => root.unmount()); globalThis.fetch = originalFetch;
    }
  });
}

test("while the first profile answer is pending the summary reads, offers no Summarize, and one request goes out even when the same rules are re-read", async () => {
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
  const draw = (value: typeof rules) => flushSync(() => root.render(<Column rules={value} />));
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
    flushSync(() => root.render(<Column rules={rules} />));
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

test("a failed profile read with pending rules does not invent empty memory or offer paid generation", async () => {
  setLocale("en");
  const originalFetch = globalThis.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const methods: string[] = [];
  globalThis.fetch = (async (_url, init) => { methods.push(init?.method ?? "GET"); return new Response("{}", { status: 500 }); }) as typeof fetch;
  try {
    flushSync(() => root.render(<Column rules={null} />));
    await tick(); await tick(); await tick();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain(translate("en", "memoryProfile.emptyTitle"));
    expect(container.textContent).not.toContain(translate("en", "memoryProfile.reading"));
    expect(container.querySelector("[data-profile-summarize]")).toBeNull();
    expect(container.querySelector("[data-profile-level]")).toBeNull();
    expect(methods).toEqual(["GET"]);
  } finally { flushSync(() => root.unmount()); globalThis.fetch = originalFetch; }
});
