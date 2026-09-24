import { expect, test } from "bun:test";

import { readTaskColorInput, renderTaskColorRule, TASK_COLOR_RULE } from "./colorRule";
import { canonicalTaskIcon } from "./taskIcon";
import { TASK_COLORS } from "./types";

/* The colour and icon rule every new task is created by. Pure: no store or
   state directory is touched. */

test("the rule names every task colour once, in first-match order, each with lucide icons", () => {
  expect(TASK_COLOR_RULE.map((line) => line.color)).toEqual(["coral", "amber", "violet", "sky", "teal", "pink", "lime", "slate"]);
  expect([...TASK_COLOR_RULE.map((line) => line.color)].sort()).toEqual([...TASK_COLORS].sort());
  for (const { color, icons } of TASK_COLOR_RULE) {
    expect({ color, count: icons.length >= 2 && icons.length <= 3 }).toEqual({ color, count: true });
    /* An example the store would clamp to no icon teaches nothing. */
    for (const icon of icons) expect({ color, icon: canonicalTaskIcon(icon) }).toEqual({ color, icon });
  }
});

test("the rendered rule says first match wins and carries every line", () => {
  const rule = renderTaskColorRule();
  expect(rule).toStartWith("Colour and icon rule, first match wins: coral = a bug, a regression");
  for (const { color, covers, icons } of TASK_COLOR_RULE) expect(rule).toContain(`${color} = ${covers} (icons such as ${icons.join(", ")})`);
});

test("a colour field sets, clears, or clamps to none with a note; it never refuses", () => {
  expect(readTaskColorInput("slate")).toEqual({ kind: "set", color: "slate" });
  expect(readTaskColorInput(" Coral ")).toEqual({ kind: "set", color: "coral" });
  for (const value of [null, undefined, "", "  ", "none", "None"]) expect(readTaskColorInput(value)).toEqual({ kind: "clear" });
  const unknown = readTaskColorInput("mauve");
  expect(unknown).toEqual({ kind: "clamped", note: 'color "mauve" is not one of coral, amber, lime, teal, sky, violet, pink, slate, so the task has no colour' });
  expect(readTaskColorInput({ name: "slate" }).kind).toBe("clamped");
  const long = readTaskColorInput("x".repeat(500));
  expect(long.kind === "clamped" && long.note.length).toBeLessThan(160);
});
