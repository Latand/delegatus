import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";
import type { RoleMemoryProjectView } from "@/lib/memory/roleTypes";
import { RulesWindow } from "./LearnedRules";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement });
dom.HTMLElement.prototype.scrollIntoView = () => {};
installActEnv();
afterAll(() => dom.happyDOM.close());

function rules(project: string): RoleMemoryProjectView {
  return { project, enabled: true, scopes: [{
    scope: `project:${project}`, kind: "project", roleId: null, revision: 1,
    chars: 40, bound: 12000, addedToday: 0, left: [],
    active: [{ id: "r_1234abcd", rule: "Retain the first completed rules reading.", why: "A slow read still contains useful rules.",
      state: "active", hints: [], roleId: null, fixRound: false, stageId: "build", fresh: false,
      createdAt: "2026-01-01T00:00:00.000Z", changedAt: "2026-01-01T00:00:00.000Z" }],
  }] };
}

type Reading = { project: string; signal: AbortSignal; finish: (view: RoleMemoryProjectView) => void };

async function withRulesWindow(project: string, check: (controls: {
  reads: Reading[]; profileReads: string[]; posts: string[]; poll: () => Promise<void>; expire: () => Promise<void>; render: (project: string) => Promise<void>;
}) => Promise<void>, cachedProfile = false) {
  const original = { fetch: globalThis.fetch, interval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    timeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  type Timer = ReturnType<typeof setInterval>;
  const intervals = new Map<Timer, { delay: number | undefined; run: () => void }>();
  const timeouts = new Map<Timer, () => void>();
  const ownedTimers = new Set<Timer>();
  const reads: Reading[] = [];
  const profileReads: string[] = [];
  const posts: string[] = [];
  const invoke = (handler: TimerHandler, args: unknown[]) => { if (typeof handler === "function") handler(...args); };
  globalThis.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = {} as Timer; ownedTimers.add(id);
    intervals.set(id, { delay, run: () => invoke(handler, args) }); return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: Timer) => { intervals.delete(id); }) as typeof clearInterval;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== 60000) return Reflect.apply(original.timeout, globalThis, [handler, delay, ...args]);
    const id = {} as Timer; ownedTimers.add(id); timeouts.set(id, () => invoke(handler, args)); return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: Timer) => {
    if (ownedTimers.has(id)) timeouts.delete(id);
    else Reflect.apply(original.clearTimeout, globalThis, [id]);
  }) as typeof clearTimeout;
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const requested = new URL(String(url), "http://localhost").searchParams.get("project")!;
    if (init?.method === "POST") posts.push(String(url));
    if (String(url).startsWith("/api/role-memory?")) return new Promise<Response>((resolve, reject) => {
      reads.push({ project: requested, signal: init!.signal!, finish: view => resolve(Response.json(view)) });
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    profileReads.push(requested);
    return Promise.resolve(Response.json({ project: requested, locale: "en", enabled: true,
      model: "sample", ruleCount: 1, changes: { added: 0, rewritten: 0, removed: 0 },
      overall: cachedProfile ? { scope: "overall", createdAt: "2026-01-01T10:00:00Z", durationMs: 1, model: "sample", promptVersion: 1, stale: false,
        answer: { headline: "Saved project overview", text: "Read the saved overview while the rules arrive.", topics: [{ title: "Saved rule topic", text: "A known rule.", ruleIds: ["r_1234abcd"] }] } } : null,
      slices: [], stale: false, run: null }));
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async (project: string) => { await act(async () => { root.render(<RulesWindow project={project} onClose={() => {}} />); }); };
  try {
    setLocale("en"); await render(project);
    await check({ reads, render, profileReads, posts,
      poll: async () => { await act(async () => { for (const timer of [...intervals.values()]) if (timer.delay === 15000) timer.run(); }); },
      expire: async () => { await act(async () => { for (const [id, run] of [...timeouts]) { timeouts.delete(id); run(); } }); },
    });
  } finally {
    await act(async () => { root.unmount(); }); host.remove();
    globalThis.fetch = original.fetch; globalThis.setInterval = original.interval; globalThis.clearInterval = original.clearInterval;
    globalThis.setTimeout = original.timeout; globalThis.clearTimeout = original.clearTimeout;
  }
}

test("a rules read slower than a poll interval still opens the profile and rules tabs", () => withRulesWindow("slow-rules-poll", async ({ reads, poll }) => {
  expect(document.querySelector("[data-rules-window-loading]")).not.toBeNull();
  await poll();
  await act(async () => { reads[0]!.finish(rules("slow-rules-poll")); });
  expect(document.querySelector("[data-rules-window-loading]")).toBeNull();
  expect(document.querySelector("[data-memory-profile]")).not.toBeNull();
  expect(reads).toHaveLength(1);
  const allRules = [...document.querySelectorAll("button")].find(button => button.textContent === "All rules")!;
  await act(async () => { allRules.click(); });
  expect(document.body.textContent).toContain("Retain the first completed rules reading.");
  await poll(); expect(reads).toHaveLength(2);
  expect(document.querySelector("[data-rules-window-loading]")).toBeNull();
  await act(async () => { reads[1]!.finish(rules("slow-rules-poll")); });
}));

test("a stalled rules read expires and the next poll can recover", () => withRulesWindow("stalled-rules-poll", async ({ reads, poll, expire }) => {
  await poll(); expect(reads).toHaveLength(1);
  await expire(); expect(reads[0]!.signal.aborted).toBe(true);
  expect(document.querySelector("[role=alert]")).not.toBeNull();
  await poll(); expect(reads).toHaveLength(2);
  await act(async () => { reads[1]!.finish(rules("stalled-rules-poll")); });
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(document.querySelector("[data-memory-profile]")).not.toBeNull();
}));

test("switching projects aborts the old read and immediately reads the new project", () => withRulesWindow("previous-rules-project", async ({ reads, render }) => {
  await render("next-rules-project");
  expect(reads).toHaveLength(2); expect(reads[0]!.signal.aborted).toBe(true);
  expect(reads[1]!.project).toBe("next-rules-project");
  await act(async () => { reads[1]!.finish(rules("next-rules-project")); });
  expect(document.querySelector("[data-memory-profile]")).not.toBeNull();
  expect(document.querySelector("#rules-window-title")!.textContent).toContain("next-rules-project");
}));


test("a cached profile opens before the first rules response without enabling paid generation or rule drilldown", () => withRulesWindow("cold-rules-profile", async ({ reads, profileReads, posts, poll }) => {
  expect(reads).toHaveLength(1);
  expect(profileReads).toHaveLength(1);
  expect(document.querySelector("[data-profile-ready]")).not.toBeNull();
  expect(document.body.textContent).toContain("Saved project overview");
  expect(document.querySelector("[data-profile-summarize]")).toBeNull();
  const topic = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Saved rule topic"))!;
  expect(topic.disabled).toBe(true);
  await poll();
  expect(reads).toHaveLength(1);
  expect(document.body.textContent).toContain("Saved project overview");
  await act(async () => { reads[0]!.finish(rules("cold-rules-profile")); });
  expect(document.querySelector("[data-profile-summarize]")).not.toBeNull();
  expect(topic.disabled).toBe(false);
  await act(async () => { topic.click(); });
  expect(document.body.textContent).toContain("Retain the first completed rules reading.");
  expect(posts).toHaveLength(0);
}, true));
