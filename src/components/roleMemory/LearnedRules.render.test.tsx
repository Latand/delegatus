import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";

import { setLocale } from "@/lib/i18n";
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
