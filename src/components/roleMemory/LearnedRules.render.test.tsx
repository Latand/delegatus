import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";

import { setLocale, translate } from "@/lib/i18n";
import { profileView } from "@/lib/memory/profile";
import type { MemoryProfileView } from "@/lib/memory/profileTypes";
import { ROLE_MEMORY_BOUND, type RoleMemoryProjectView, type RuleView, type ScopeView } from "@/lib/memory/roleTypes";

import { RuleSection, RulesWindow } from "./LearnedRules";

/* The operator asked for little text in the rules window, so a scope's size
   against its bound is shown only once the scope nears it. */

const scope = (chars: number): ScopeView => ({ scope: "project:atlas", kind: "project", roleId: null, revision: 1, chars, bound: ROLE_MEMORY_BOUND, addedToday: 0, active: [], left: [] });
const rule = (id: string, text = `Rule ${id} keeps its own words.`, roleId: string | null = "builder"): RuleView => ({ id, rule: text, why: `Why ${id} was left.`, state: "active", hints: [], roleId, fixRound: false, stageId: "build", fresh: false, createdAt: "2026-10-08T00:00:00.000Z", changedAt: "2026-10-08T00:00:00.000Z" });
const levelScope = (name: string, kind: ScopeView["kind"], roleId: string | null, active: RuleView[], left: RuleView[] = []): ScopeView => ({ ...scope(100), scope: name, kind, roleId, active, left });

type Mounted = { dom: Window; act: typeof act; posts: unknown[]; closed: number[]; key: (key: string, options?: { shiftKey?: boolean }) => Promise<void>; text: (selector: string) => string };

/** Mounts the real window over `view` in its own DOM, as a desktop or as a phone, and answers its fetches. */
async function withWindow(options: { view: RoleMemoryProjectView; project?: string; phone?: boolean; focusRule?: string; profile?: (base: MemoryProfileView) => MemoryProfileView }, check: (mounted: Mounted) => Promise<void>) {
  const dom = new Window();
  dom.HTMLElement.prototype.scrollIntoView = () => {};
  (dom as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({ matches: !!options.phone, media: query, addEventListener() {}, removeEventListener() {} });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  installActEnv();
  const oldFetch = globalThis.fetch;
  const posts: unknown[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return Response.json(options.view); }
    if (String(input).startsWith("/api/role-memory/profile")) {
      const base = profileView(options.view, "en", "sample", null);
      return Response.json(options.profile ? options.profile(base) : base);
    }
    return Response.json(options.view);
  }) as unknown as typeof fetch;
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const closed: number[] = [];
  const project = options.project ?? options.view.project;
  try {
    setLocale("en");
    await act(async () => { root.render(<RulesWindow project={project} focusRule={options.focusRule} onClose={() => closed.push(1)} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    await check({ dom, act, posts, closed,
      key: (key, init) => act(async () => { dom.window.dispatchEvent(new dom.KeyboardEvent("keydown", { key, ...init })); }),
      text: selector => dom.document.querySelector(selector)?.textContent ?? "" });
  } finally {
    await act(() => root.unmount());
    globalThis.fetch = oldFetch; setLocale("en");
    for (const [key, value] of prior) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    await dom.happyDOM.close();
  }
}
const press = (dom: Window, selector: string) => (dom.document.querySelector(selector) as unknown as HTMLElement).click();
const paneIds = (dom: Window) => [...dom.document.querySelectorAll("[data-level-pane] [data-learned-rule]")].map(row => row.getAttribute("data-learned-rule"));

/* Two roles, a swarm level, the project and an empty machine; the reviewer holds only a departed rule. */
const levelsView = (): RoleMemoryProjectView => ({ project: "atlas", enabled: true, scopes: [
  levelScope("role:atlas:builder", "role", "builder", [rule("b1"), rule("b2")]),
  levelScope("role:*:builder", "role", "builder", [rule("be1")]),
  levelScope("role:atlas:reviewer", "role", "reviewer", [], [{ ...rule("rv1", "A reviewer rule that left."), state: "archived", reason: "deleted" }]),
  levelScope("swarm:builder", "swarm", "builder", [rule("sw1", "Read the instruction files first.")]),
  levelScope("project:atlas", "project", null, [rule("p1")], [{ ...rule("p0", "A project rule that merged."), state: "merged", mergedInto: "p1" }]),
  levelScope("machine", "machine", null, []),
] });

const section = (chars: number) => renderToStaticMarkup(
  <RuleSection kind="project" title="Project" subtitle="Every role in this project" scope={scope(chars)} onDelete={() => {}} onRestore={() => {}} />,
);

test("a scope far from its bound shows no size", () => {
  setLocale("en");
  for (const chars of [0, 630, ROLE_MEMORY_BOUND * 0.8 - 1]) expect(section(chars)).not.toContain("data-rules-size");
});

test("a scope near its bound shows its fill", () => {
  setLocale("en");
  expect(section(ROLE_MEMORY_BOUND * 0.8)).toContain("data-rules-size");
  expect(section(ROLE_MEMORY_BOUND)).toContain(`${ROLE_MEMORY_BOUND.toLocaleString("en-US")} / ${ROLE_MEMORY_BOUND.toLocaleString("en-US")}`);
});

test("an empty kind says it is empty once; a kind with rules shows its count once", () => {
  setLocale("en");
  const rule: RuleView = { id: "r1", rule: "Check the bound before writing.", why: "A write past it was lost.", state: "active", hints: [], roleId: null, fixRound: false, stageId: "s1", fresh: false, createdAt: "2026-10-08T00:00:00.000Z", changedAt: "2026-10-08T00:00:00.000Z" };
  const bare = section(0);
  expect(bare).not.toContain("data-rules-count");
  expect(bare.split("No rules yet.").length - 1).toBe(1);
  const filled = renderToStaticMarkup(
    <RuleSection kind="project" title="Project" subtitle="Every role in this project" scope={{ ...scope(31), active: [rule] }} onDelete={() => {}} onRestore={() => {}} />,
  );
  expect(filled.match(/data-rules-count=""[^>]*>1</g)?.length).toBe(1);
  expect(filled).not.toContain("No rules yet.");
});


test("a role level's rules and earlier text render with a return control", () => {
  setLocale("en");
  const rule: RuleView = { id: "one", rule: "Validate persisted ownership before replaying operations.", why: "An owner had changed before a replay.", state: "active", hints: [], roleId: "builder", fixRound: false, stageId: "build", fresh: false, createdAt: "today", changedAt: "today", versions: [{ id: "earlier", rule: "Check the owner before replay.", why: "A replay used an old owner.", hints: [], createdAt: "yesterday" }] };
  const markup = renderToStaticMarkup(<RuleSection kind="role" title="Role" subtitle="Chosen role" scope={{ ...scope(100), kind: "role", roleId: "builder", active: [rule, { ...rule, id: "second" }] }} focusRule="one" onDelete={() => {}} onRestore={() => {}} onRevert={() => {}} />);
  for (const text of ["Earlier text · 1", "Check the owner before replay.", 'data-rule-revert="earlier"', "awaiting curator"]) expect(markup).toContain(text);
  expect(markup).toMatch(/data-rules-count=""[^>]*>2</);
  const rewritten = { ...rule, curatedAt: "2026-10-11T00:00:00.000Z", revisedBy: { by: "agent" as const, at: "2026-10-11T00:01:00.000Z", roleId: "builder" } };
  const revised = renderToStaticMarkup(<RuleSection kind="role" title="Role" subtitle="Chosen role" scope={{ ...scope(100), kind: "role", roleId: "builder", active: [rewritten] }} focusRule="one" onDelete={() => {}} onRestore={() => {}} />);
  expect(revised).toContain("awaiting curator");
  const sameClock = { ...rewritten, revisedBy: { ...rewritten.revisedBy, at: rewritten.curatedAt }, awaitingCuration: true };
  const pending = renderToStaticMarkup(<RuleSection kind="role" title="Role" subtitle="Chosen role" scope={{ ...scope(100), kind: "role", roleId: "builder", active: [sameClock] }} focusRule="one" onDelete={() => {}} onRestore={() => {}} />);
  expect(pending).toContain("awaiting curator");
  const reviewed = renderToStaticMarkup(<RuleSection kind="role" title="Role" subtitle="Chosen role" scope={{ ...scope(100), kind: "role", roleId: "builder", active: [{ ...rewritten, awaitingCuration: false }] }} focusRule="one" onDelete={() => {}} onRestore={() => {}} />);
  expect(reviewed).not.toContain("awaiting curator");
});

test("a curator rewrite and an agent rewrite each show their own role icon on the provenance line and on the earlier-version line", () => {
  setLocale("en");
  const earlier = (by: "agent" | "curator", roleId?: string) => ({ id: `earlier-${by}`, rule: "Check the owner before replay.", why: "A replay used an old owner.", hints: [], createdAt: "yesterday", revisedBy: { by, at: "2026-10-11T00:01:00.000Z", ...(roleId ? { roleId } : {}) } });
  const rule = (id: string, by: "agent" | "curator", roleId?: string): RuleView => ({ id, rule: "Validate persisted ownership before replaying operations.", why: "An owner had changed before a replay.", state: "active", hints: [], roleId: "builder", fixRound: false, stageId: "build", fresh: false, createdAt: "today", changedAt: "today", revisedBy: { by, at: "2026-10-11T00:01:00.000Z", ...(roleId ? { roleId } : {}) }, versions: [earlier(by, roleId)] });
  const html = (active: RuleView[]) => renderToStaticMarkup(<RuleSection kind="role" title="Role" subtitle="Chosen role" scope={{ ...scope(100), kind: "role", roleId: "builder", active }} focusRule={active[0]!.id} onDelete={() => {}} onRestore={() => {}} onRevert={() => {}} />);
  const marks = (markup: string, line: "provenance" | "versions") => {
    const [head, tail] = markup.split("data-rule-versions");
    const part = line === "versions" ? tail! : head!.slice(head!.indexOf("data-rule-provenance"));
    return [...part.matchAll(/data-role-avatar="([^"]+)"/g)].map(match => match[1]);
  };
  const curator = html([rule("c", "curator")]);
  expect(marks(curator, "provenance")).toEqual(["curator"]);
  expect(marks(curator, "versions")).toEqual(["curator"]);
  const agent = html([rule("a", "agent", "architect")]);
  expect(marks(agent, "provenance")).toEqual(["architect"]);
  expect(marks(agent, "versions")).toEqual(["architect"]);
});

test("the provenance line shows recurring tasks in both shipped languages", async () => {
  const base: RuleView = { id: "one", rule: "Measure every supported rendered combination before review.", why: "Review caught an omitted language at phone width.", state: "active", hints: [], roleId: "builder", fixRound: true, stageId: "fix", fresh: false, createdAt: "today", changedAt: "today" };
  // SSR uses the stable English hydration snapshot. Mount to verify the browser's chosen language.
  const dom = new Window();
  dom.HTMLElement.prototype.scrollIntoView = () => {};
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  installActEnv();
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    for (const locale of ["en", "uk"] as const) {
      await act(() => setLocale(locale));
      for (const tasks of [undefined, 1, 2, 3]) {
        await act(() => root.render(<RuleSection kind="role" title="Role" subtitle="Chosen role" scope={{ ...scope(100), kind: "role", roleId: "builder", active: [{ ...base, tasks }] }} focusRule="one" onDelete={() => {}} onRestore={() => {}} />));
        const markup = host.textContent ?? "";
        const phrase = locale === "en" ? `from ${tasks} tasks` : `з ${tasks} задач`;
        if (tasks && tasks >= 2) expect(markup).toContain(phrase);
        else expect(markup).not.toMatch(/from \d+ tasks|з \d+ задач/);
      }
    }
  } finally {
    await act(() => root.unmount());
    setLocale("en");
    for (const [key, value] of prior) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    await dom.happyDOM.close();
  }
});


test("each role level opens its rules in both languages", async () => {
  const roles = ["orchestrator", "maintainer"];
  const view = { project: "seat-window", enabled: true, scopes: roles.map(roleId => ({ ...scope(100), scope: `role:seat-window:${roleId}`, kind: "role" as const, roleId, active: [rule(roleId, `Inspect settled evidence before the ${roleId} reports progress.`, "orchestrator")] })) };
  await withWindow({ view, project: "seat-window" }, async ({ dom, act }) => {
    for (const locale of ["en", "uk"] as const) {
      await act(() => setLocale(locale));
      const names = locale === "en" ? ["Orchestrator", "Maintainer"] : ["Оркестратор", "Доглядач дошки"];
      for (const [index, role] of roles.entries()) {
        const row = dom.document.querySelector(`[data-profile-level="role:seat-window:${role}"]`)!;
        expect(row.textContent).toContain(names[index]!);
        await act(() => (row as unknown as HTMLElement).click());
        expect(dom.document.querySelector(`[data-learned-rule="${role}"]`)?.textContent).toContain(`the ${role} reports progress`);
      }
    }
  });
});

test("a swarm level says it is read only and offers no local mutation controls", () => {
  const rule: RuleView = { id: "r_public", rule: "Read the project instruction files before changing code.", why: "", state: "active", hints: [], roleId: "builder", fixRound: false, stageId: "", fresh: false, createdAt: "2026-10-23", changedAt: "2026-10-23" };
  const swarm: ScopeView = { ...scope(80), scope: "swarm:builder", kind: "swarm", roleId: "builder", bound: 4000, active: [rule] };
  setLocale("en");
  const markup = renderToStaticMarkup(<RuleSection kind="swarm" title="Swarm rules · Builder on every install" scope={swarm} focusRule={rule.id} onDelete={() => { throw Error("public rule mutation"); }} onRestore={() => {}} />);
  expect(markup).toContain("Swarm rules · Builder on every install");
  expect(markup.split("Public rules shipped with Delegatus.").length - 1).toBe(1);
  expect(markup).toContain("Read only");
  expect(markup).toContain(rule.rule);
  expect(markup).not.toContain("data-learned-rule-delete");
  expect(markup).not.toContain("data-rule-revert");
});

/* Audit B26: delete leaves at once, a refusal puts the rule back with the
   save error; restore and a text's revert are predicted the same way. */
test("a delete leaves the list at once while the write is held, and a refusal brings the rule back with the save error", async () => {
  const dom = new Window();
  dom.HTMLElement.prototype.scrollIntoView = () => {};
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  installActEnv();
  const oldFetch = globalThis.fetch;
  const rule = { id: "r_held", rule: "Check the export before the report.", why: "A report cited an old export.", state: "active", hints: [], roleId: null, fixRound: false, stageId: "seat", fresh: false, createdAt: "today", changedAt: "today" };
  const view = { project: "seat-window", enabled: true, scopes: [{ ...scope(100), scope: "project:seat-window", active: [rule] }] };
  const posts: unknown[] = [];
  let refuse: () => void = () => {};
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json(view);
    posts.push(JSON.parse(String(init.body)));
    await new Promise<void>((resolve) => { refuse = resolve; });
    return Response.json({ error: "busy" }, { status: 503 });
  }) as unknown as typeof fetch;
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () => { root.render(<RulesWindow project="seat-window" focusRule="r_held" onClose={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(dom.document.querySelector('[data-learned-rule="r_held"]')).not.toBeNull();
    await act(async () => { (dom.document.querySelector('[data-learned-rule-delete="r_held"]') as unknown as HTMLElement).click(); });
    expect(dom.document.querySelector('[data-learned-rule="r_held"]')).toBeNull();
    expect(posts).toEqual([{ project: "seat-window", action: "delete", ruleId: "r_held" }]);
    await act(async () => { refuse(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(dom.document.querySelector('[data-learned-rule="r_held"]')).not.toBeNull();
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toBe("The change was not saved. Try again.");
  } finally {
    await act(() => root.unmount());
    globalThis.fetch = oldFetch;
    for (const [key, value] of prior) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    await dom.happyDOM.close();
  }
});

test("the predicted reading restores a left rule and reverts a rule's text to the chosen version", async () => {
  const { predictedRules } = await import("./LearnedRules");
  const left = { id: "r_left", rule: "Old wording.", why: "w", state: "archived", reason: "deleted", hints: [], roleId: null, fixRound: false, stageId: "seat", fresh: false, createdAt: "today", changedAt: "today", versions: [{ id: "v_one", rule: "First wording.", why: "first why", hints: [] }] } as unknown as RuleView;
  const view = { project: "p", enabled: true, scopes: [{ ...scope(100), left: [left] }] };
  const restored = predictedRules(view, "restore", "r_left", "2026-10-16T12:00:00.000Z");
  expect(restored.scopes[0]!.left).toEqual([]);
  expect(restored.scopes[0]!.active.map((rule) => [rule.id, rule.state, rule.changedAt, "reason" in rule])).toEqual([["r_left", "active", "2026-10-16T12:00:00.000Z", false]]);
  const reverted = predictedRules(view, "revert", "v_one");
  expect(reverted.scopes[0]!.left[0]!.rule).toBe("First wording.");
  expect(predictedRules(view, "revert-pass", "r_left")).toBe(view);
});

/* Two deletes out at once, answered in each order: a refusal brings back its
   own rule alone, and the other delete stays drawn until its answer. */
for (const order of ["refusal first", "acceptance first"] as const) {
  test(`overlapping deletes: a refused one comes back alone, the other stays gone (${order})`, async () => {
    const dom = new Window();
    dom.HTMLElement.prototype.scrollIntoView = () => {};
    const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement };
    const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, globals);
    installActEnv();
    const oldFetch = globalThis.fetch;
    const rule = (id: string, text: string) => ({ id, rule: text, why: "A report cited an old export.", state: "active", hints: [], roleId: null, fixRound: false, stageId: "seat", fresh: false, createdAt: "today", changedAt: "today" });
    const first = rule("r_first", "Check the export before the report.");
    const second = rule("r_second", "Name the stage in every receipt.");
    const viewWith = (active: unknown[]) => ({ project: "seat-window", enabled: true, scopes: [{ ...scope(100), scope: "project:seat-window", active }] });
    const held = new Map<string, (response: Response) => void>();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json(viewWith([first, second]));
      const body = JSON.parse(String(init.body)) as { ruleId: string };
      return new Promise<Response>((resolve) => { held.set(body.ruleId, resolve); });
    }) as unknown as typeof fetch;
    const host = dom.document.createElement("div"); dom.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    const shown = () => ["r_first", "r_second"].filter((id) => dom.document.querySelector(`[data-learned-rule="${id}"]`));
    const answer = (id: string, response: Response) => act(async () => { held.get(id)!(response); await new Promise(resolve => setTimeout(resolve, 0)); });
    try {
      await act(async () => { root.render(<RulesWindow project="seat-window" focusRule="r_first" onClose={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(shown()).toEqual(["r_first", "r_second"]);
      await act(async () => { (dom.document.querySelector('[data-learned-rule-delete="r_first"]') as unknown as HTMLElement).click(); });
      await act(async () => { (dom.document.querySelector('[data-learned-rule-delete="r_second"]') as unknown as HTMLElement).click(); });
      expect(shown()).toEqual([]);
      if (order === "refusal first") {
        await answer("r_first", Response.json({ error: "busy" }, { status: 503 }));
        expect(shown()).toEqual(["r_first"]);
        await answer("r_second", Response.json(viewWith([first])));
      } else {
        await answer("r_second", Response.json(viewWith([first])));
        expect(shown()).toEqual([]);
        await answer("r_first", Response.json({ error: "busy" }, { status: 503 }));
      }
      expect(shown()).toEqual(["r_first"]);
      if (order === "acceptance first") expect(dom.document.querySelector('[role="alert"]')?.textContent).toBe("The change was not saved. Try again.");
    } finally {
      await act(() => root.unmount());
      globalThis.fetch = oldFetch;
      for (const [key, value] of prior) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
      await dom.happyDOM.close();
    }
  });
}

for (const cause of ["memorySource", "override"] as const) test(`rules stopped by ${cause === "memorySource" ? "the Settings row's engines position" : "the kill switch"} say which, in both languages`, async () => {
  const dom = new Window();
  dom.HTMLElement.prototype.scrollIntoView = () => {};
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  installActEnv();
  const oldFetch = globalThis.fetch;
  const view = { project: "paused-window", enabled: false, ...(cause === "memorySource" ? { pausedBy: "memorySource" } : {}), scopes: [{ ...scope(100), scope: "project:paused-window" }],
    curation: { lastAt: null, nextAt: null, newLessons: 0, passes: [] } };
  globalThis.fetch = (async () => Response.json(view)) as unknown as typeof fetch;
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    for (const lang of ["en", "uk"] as const) {
      setLocale(lang);
      await act(async () => { root.render(<RulesWindow key={lang} project="paused-window" onClose={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)); });
      const banner = dom.document.querySelector("[data-rules-window-off]")!;
      expect(banner.getAttribute("data-rules-window-off")).toBe(cause);
      expect(banner.textContent).toBe(translate(lang, cause === "memorySource" ? "roleMemory.pausedBySource" : "roleMemory.off"));
      if (cause === "memorySource") {
        /* It names the Settings row by its own title and leaves the override unnamed. */
        expect(banner.textContent).toContain(translate(lang, "memorySource.title"));
        expect(banner.textContent).not.toContain("LLV_ROLE_MEMORY");
      }
      expect(dom.document.querySelector("summary")!.textContent).toContain(translate(lang, cause === "memorySource" ? "roleMemory.paused" : "roleMemory.off"));
    }
  } finally {
    setLocale("en");
    await act(() => root.unmount());
    globalThis.fetch = oldFetch;
    for (const [key, value] of prior) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    await dom.happyDOM.close();
  }
});

test("on a desktop the window opens with the first level selected and swaps its pane on a press; no tab bar or role chips remain", async () => {
  await withWindow({ view: levelsView() }, async ({ dom, act }) => {
    const rows = [...dom.document.querySelectorAll("[data-profile-level]")].map(row => row.getAttribute("data-profile-level"));
    expect(rows).toEqual(["role:atlas:builder", "role:*:builder", "role:atlas:reviewer", "swarm:builder", "project:atlas", "machine"]);
    expect(dom.document.querySelector("[aria-current]")?.getAttribute("data-profile-level")).toBe("role:atlas:builder");
    expect(dom.document.querySelector("[data-level-pane]")?.getAttribute("data-level-pane")).toBe("role:atlas:builder");
    expect(paneIds(dom).sort()).toEqual(["b1", "b2"]);
    expect(dom.document.querySelector("[data-level-back]")).toBeNull();
    await act(async () => press(dom, '[data-profile-level="project:atlas"]'));
    expect(paneIds(dom)).toEqual(["p1"]);
    expect(dom.document.querySelector("[aria-current]")?.getAttribute("data-profile-level")).toBe("project:atlas");
    expect(dom.document.querySelectorAll("[data-memory-profile]")).toHaveLength(1);
    for (const gone of ["nav", "[data-rules-role]", "[role=tablist]", "[data-rules-every-project]", "[data-rules-swarm]", "[data-profile-slice]"]) expect(dom.document.querySelector(gone)).toBeNull();
    expect(dom.document.body.textContent).not.toContain("All rules");
    expect(dom.document.querySelector("#rules-window-title")!.textContent).toBe("Memory profile · atlas");
    expect(dom.document.querySelector("[data-rules-starts]")!.textContent).toBe(translate("en", "roleMemory.startsWithSwarm"));
  });
});

test("a level with no rules says so once in its pane, and its history keeps the way back", async () => {
  await withWindow({ view: levelsView() }, async ({ dom, act, posts }) => {
    await act(async () => press(dom, '[data-profile-level="machine"]'));
    expect(dom.document.querySelector("[data-level-pane]")!.textContent!.split("No rules yet.").length - 1).toBe(1);
    expect(dom.document.querySelector("[data-rules-count]")).toBeNull();
    await act(async () => press(dom, '[data-profile-level="role:atlas:reviewer"]'));
    expect(paneIds(dom)).toEqual([]);
    await act(async () => press(dom, "[data-rules-history]"));
    await act(async () => press(dom, '[data-left-rule-restore="rv1"]'));
    expect(posts).toEqual([{ project: "atlas", action: "restore", ruleId: "rv1" }]);
  });
});

test("a swarm level draws its rules read only, under one read-only line", async () => {
  await withWindow({ view: levelsView() }, async ({ dom, act }) => {
    await act(async () => press(dom, '[data-profile-level="swarm:builder"]'));
    const pane = dom.document.querySelector("[data-level-pane]")!;
    expect(pane.textContent!.split("Public rules shipped with Delegatus.").length - 1).toBe(1);
    expect(pane.querySelector("[data-learned-rule-delete]")).toBeNull();
    expect(pane.querySelector('[data-learned-rule="sw1"]')).not.toBeNull();
  });
});

test("on a phone the list is the first screen, a row opens its level behind a back control, and back restores the list's place and focus", async () => {
  await withWindow({ view: levelsView(), phone: true }, async ({ dom, act }) => {
    expect(dom.document.querySelector("[data-level-pane]")).toBeNull();
    expect(dom.document.querySelector("[data-memory-profile]")).not.toBeNull();
    expect(dom.document.querySelector("[aria-current]")).toBeNull();
    (dom.document.querySelector("[data-memory-profile]") as unknown as HTMLElement).scrollTop = 120;
    await act(async () => press(dom, '[data-profile-level="project:atlas"]'));
    expect(dom.document.querySelector("[data-memory-profile]")).toBeNull();
    expect(paneIds(dom)).toEqual(["p1"]);
    expect(dom.document.activeElement === dom.document.querySelector("[data-level-back]")).toBe(true);
    expect(dom.document.querySelector("[data-rules-window-close]")).not.toBeNull();
    await act(async () => press(dom, "[data-level-back]"));
    expect(dom.document.querySelector("[data-level-pane]")).toBeNull();
    expect((dom.document.querySelector("[data-memory-profile]") as unknown as HTMLElement).scrollTop).toBe(120);
    expect(dom.document.activeElement === dom.document.querySelector('[data-profile-level="project:atlas"]')).toBe(true);
  });
});

test("opened on a rule, the window lands on that rule's level and opens it; a rule that has left opens its level's history", async () => {
  await withWindow({ view: levelsView(), focusRule: "be1" }, async ({ dom }) => {
    expect(dom.document.querySelector("[aria-current]")?.getAttribute("data-profile-level")).toBe("role:*:builder");
    expect(dom.document.querySelector('[data-level-pane] [data-learned-rule="be1"]')?.hasAttribute("data-open")).toBe(true);
  });
  await withWindow({ view: levelsView(), focusRule: "rv1" }, async ({ dom }) => {
    expect(dom.document.querySelector("[aria-current]")?.getAttribute("data-profile-level")).toBe("role:atlas:reviewer");
    expect(dom.document.querySelector("[data-rules-history]")?.getAttribute("aria-expanded")).toBe("true");
    expect(dom.document.querySelector('[data-left-rule="rv1"]')?.hasAttribute("data-focused")).toBe(true);
  });
  await withWindow({ view: levelsView(), focusRule: "p1", phone: true }, async ({ dom }) => {
    expect(dom.document.querySelector("[data-memory-profile]")).toBeNull();
    expect(dom.document.querySelector("[data-level-pane]")?.getAttribute("data-level-pane")).toBe("project:atlas");
    expect(dom.document.querySelector('[data-learned-rule="p1"]')?.hasAttribute("data-open")).toBe(true);
  });
});

test("the counterpart link of a rule that left selects the counterpart's level and focuses that rule", async () => {
  await withWindow({ view: levelsView(), focusRule: "p0" }, async ({ dom, act }) => {
    expect(dom.document.querySelector("[aria-current]")?.getAttribute("data-profile-level")).toBe("project:atlas");
    await act(async () => press(dom, '[data-profile-level="machine"]'));
    await act(async () => press(dom, '[data-profile-level="project:atlas"]'));
    /* The focus is still on the departed rule, so its level opens its history again. */
    expect(dom.document.querySelector("[data-rules-history]")?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => press(dom, '[data-rule-counterpart="p1"]'));
    expect(dom.document.querySelector('[data-learned-rule="p1"]')?.hasAttribute("data-focused")).toBe(true);
  });
  const crossing = levelsView();
  crossing.scopes[4]!.left = [{ ...rule("p0", "A project rule that merged."), state: "merged", mergedInto: "b1" }];
  await withWindow({ view: crossing, focusRule: "p0" }, async ({ dom, act }) => {
    await act(async () => press(dom, '[data-rule-counterpart="b1"]'));
    expect(dom.document.querySelector("[aria-current]")?.getAttribute("data-profile-level")).toBe("role:atlas:builder");
    expect(dom.document.querySelector('[data-learned-rule="b1"]')?.hasAttribute("data-focused")).toBe(true);
  });
});

type Topics = NonNullable<NonNullable<MemoryProfileView["slices"][number]["summary"]>["answer"]["topics"]>;

test("an overall topic names itself once over one section per level with only its rules; a level's pill does the same for that level", async () => {
  const part = (scope: string, topics: Topics) => ({ scope, createdAt: "2026-10-08T10:00:00Z", durationMs: 1, model: "sample", promptVersion: 1, stale: false, answer: { headline: `Headline of ${scope}`, text: `Text of ${scope}.`, topics } });
  const profile = (base: MemoryProfileView): MemoryProfileView => ({ ...base,
    overall: part("overall", [{ title: "Colour checks", text: "Colours are checked before saving.", ruleIds: ["b1", "p1"] }]),
    slices: base.slices.map(slice => slice.scope === "role:atlas:builder" ? { ...slice, summary: part(slice.scope, [{ title: "Builder pill", ruleIds: ["b2"] }]) } : slice) });
  await withWindow({ view: levelsView(), profile }, async ({ dom, act }) => {
    await act(async () => press(dom, '[data-profile-topic="0"]'));
    const pane = dom.document.querySelector('[data-level-pane="topic"]')!;
    expect(pane.textContent!.split("Colour checks").length - 1).toBe(1);
    expect(pane.textContent).toContain("Colours are checked before saving.");
    expect([...pane.querySelectorAll("[data-rules-section]")].map(section => section.getAttribute("data-rules-scope-page"))).toEqual(["role:atlas:builder", "project:atlas"]);
    expect([...pane.querySelectorAll("[data-learned-rule]")].map(row => row.getAttribute("data-learned-rule"))).toEqual(["b1", "p1"]);
    expect(pane.querySelector("[data-rules-history]")).toBeNull();
    expect(dom.document.querySelector("[aria-current]")?.getAttribute("data-profile-topic")).toBe("0");
    await act(async () => press(dom, '[data-profile-level="role:atlas:builder"]'));
    await act(async () => press(dom, "[data-profile-pill]"));
    const pill = dom.document.querySelector('[data-level-pane="topic"]')!;
    expect(pill.textContent!.split("Builder pill").length - 1).toBe(1);
    expect([...pill.querySelectorAll("[data-learned-rule]")].map(row => row.getAttribute("data-learned-rule"))).toEqual(["b2"]);
    expect(dom.document.querySelector("[aria-current]")?.getAttribute("data-profile-level")).toBe("role:atlas:builder");
  });
});

test("a removal draws the undo in the row's place inside the pane", async () => {
  await withWindow({ view: levelsView() }, async ({ dom, act, posts }) => {
    await act(async () => press(dom, '[data-learned-rule-delete="b2"]'));
    expect(posts).toEqual([{ project: "atlas", action: "delete", ruleId: "b2" }]);
    expect(dom.document.querySelector("[data-level-pane] [data-rules-undo]")).not.toBeNull();
  });
});

test("the window is a modal: Tab wraps within it and Escape closes it once", async () => {
  await withWindow({ view: levelsView() }, async ({ dom, act, key, closed }) => {
    const frame = dom.document.querySelector("[data-rules-window]")!;
    const controls = ([...frame.querySelectorAll("button")] as unknown as HTMLButtonElement[]).filter(control => !control.disabled);
    expect(controls[0]!.hasAttribute("data-rules-window-close")).toBe(true);
    await act(async () => controls.at(-1)!.focus());
    await key("Tab");
    expect((dom.document.activeElement as unknown) === controls[0]).toBe(true);
    await key("Tab", { shiftKey: true });
    expect((dom.document.activeElement as unknown) === controls.at(-1)).toBe(true);
    await key("Escape");
    expect(closed).toHaveLength(1);
  });
});
