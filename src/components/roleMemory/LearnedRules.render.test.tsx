import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "@/lib/i18n";
import type { ScopeView } from "@/lib/memory/roleTypes";

import { RuleSection } from "./LearnedRules";

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
  expect(section(0)).toContain("data-rules-count");
});
