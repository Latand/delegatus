import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";

import { setLocale, translate } from "@/lib/i18n";
import type { RuleView, ScopeView } from "@/lib/memory/roleTypes";

import { RuleSection, RulesWindow } from "./LearnedRules";

/* The operator asked for little text in the rules window, so a scope's size
   against its bound is shown only once the scope nears it. */

const scope = (chars: number): ScopeView => ({ scope: "project:atlas", kind: "project", roleId: null, revision: 1, chars, bound: 10_000, addedToday: 0, active: [], left: [] });
const section = (chars: number) => renderToStaticMarkup(
  <RuleSection kind="project" title="Project" subtitle="Every role in this project" scope={scope(chars)} onDelete={() => {}} onRestore={() => {}} />,
);

test("a scope far from its bound shows no size", () => {
  setLocale("en");
  for (const chars of [0, 630, 7_999]) expect(section(chars)).not.toContain("data-rules-size");
});

test("a scope near its bound shows its fill", () => {
  setLocale("en");
  expect(section(8_000)).toContain("data-rules-size");
  expect(section(9_420)).toContain("9,420 / 10,000");
});

test("a section whose picker carries the counts shows none of its own", () => {
  setLocale("en");
  const withPicker = renderToStaticMarkup(
    <RuleSection kind="role" title="Role" subtitle="Only the chosen role in this project" scope={{ ...scope(0), kind: "role", roleId: "builder" }} picker={<div />} onDelete={() => {}} onRestore={() => {}} />,
  );
  expect(withPicker).not.toContain("data-rules-count");
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


test("both role levels and earlier text render with a return control", () => {
  setLocale("en");
  const rule: RuleView = { id: "one", rule: "Validate persisted ownership before replaying operations.", why: "An owner had changed before a replay.", state: "active", hints: [], roleId: "builder", fixRound: false, stageId: "build", fresh: false, createdAt: "today", changedAt: "today", versions: [{ id: "earlier", rule: "Check the owner before replay.", why: "A replay used an old owner.", hints: [], createdAt: "yesterday" }] };
  const markup = renderToStaticMarkup(<RuleSection kind="role" title="Role" subtitle="Chosen role" scope={{ ...scope(100), kind: "role", roleId: "builder", active: [rule] }} additionalScope={{ ...scope(100), scope: "role:*:builder", active: [{ ...rule, id: "every" }] }} focusRule="one" onDelete={() => {}} onRestore={() => {}} onRevert={() => {}} />);
  for (const text of ["This project", "Every project", "Earlier text · 1", "Check the owner before replay.", 'data-rule-revert="earlier"', "awaiting curator"]) expect(markup).toContain(text);
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


test("orchestrator and maintainer rules have named tabs and rows in both languages", async () => {
  const dom = new Window();
  dom.HTMLElement.prototype.scrollIntoView = () => {};
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  installActEnv();
  const oldFetch = globalThis.fetch;
  const roles = ["orchestrator", "maintainer"];
  const view = { project: "seat-window", enabled: true, scopes: roles.map(roleId => ({ ...scope(100), scope: `role:seat-window:${roleId}`, kind: "role", roleId, active: [{ id: roleId, rule: `Inspect settled evidence before the ${roleId} reports progress.`, why: "A report missed a completion proof.", state: "active", hints: [], roleId: "orchestrator", fixRound: false, stageId: "seat", fresh: false, createdAt: "today", changedAt: "today" }] })) };
  globalThis.fetch = (async () => Response.json(view)) as unknown as typeof fetch;
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    for (const locale of ["en", "uk"] as const) {
      await act(() => setLocale(locale));
      await act(async () => { root.render(<RulesWindow project="seat-window" onClose={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)); });
      // The window opens on Profile; exercise its real navigation to the rules.
      const allRules = [...dom.document.querySelectorAll("button")].find(button => button.textContent === translate(locale, "memoryProfile.allRules"))!;
      await act(() => allRules.click());
      const names = locale === "en" ? ["Orchestrator", "Maintainer"] : ["Оркестратор", "Доглядач дошки"];
      for (const [index, role] of roles.entries()) {
        const tab = dom.document.querySelector(`[data-rules-role="${role}"]`)!;
        expect(tab.textContent).toContain(names[index]!);
        await act(() => (tab as unknown as HTMLElement).click());
        expect(dom.document.querySelector(`[data-learned-rule="${role}"]`)?.textContent).toContain(`the ${role} reports progress`);
      }
    }
  } finally {
    await act(() => root.unmount());
    globalThis.fetch = oldFetch; setLocale("en");
    for (const [key, value] of prior) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    await dom.happyDOM.close();
  }
});

test("the swarm scope follows role-wide guidance and offers no local mutation controls", () => {
  const rule: RuleView = { id: "r_public", rule: "Read the project instruction files before changing code.", why: "", state: "active", hints: [], roleId: "builder", fixRound: false, stageId: "", fresh: false, createdAt: "2026-10-23", changedAt: "2026-10-23" };
  const swarm: ScopeView = { ...scope(80), scope: "swarm:builder", kind: "swarm", roleId: "builder", bound: 4000, active: [rule] };
  setLocale("en");
  const markup = renderToStaticMarkup(<RuleSection kind="role" title="Role" scope={null} additionalScope={{ ...scope(0), scope: "role:*:builder", kind: "role", roleId: "builder" }} swarm={swarm} focusRule={rule.id} onDelete={() => { throw Error("public rule mutation"); }} onRestore={() => {}} />);
  expect(markup.indexOf("data-rules-every-project")).toBeLessThan(markup.indexOf("data-rules-swarm"));
  expect(markup).toContain("Swarm rules · Builder on every install");
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
