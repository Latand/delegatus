import { expect, test } from "bun:test";

import { canonicalTaskIcon } from "./taskIcon";
import { DEFAULT_TASK_ICON, displayTaskIcon, SUGGESTED_TASK_ICONS, suggestTaskIcon, TASK_ICON_RULES } from "./taskIconSuggest";

/* The keyword map a task without an icon is drawn with (#2102). */

test("the issue's examples: bug/fix, phone/mobile, deploy/release and review", () => {
  expect(suggestTaskIcon("Fix the crash when a card folds")).toBe("bug");
  expect(suggestTaskIcon("Bug: the composer loses its draft")).toBe("bug");
  expect(suggestTaskIcon("Repair old links in the release notes")).toBe("bug");
  expect(suggestTaskIcon("Phone board keeps scrolling")).toBe("smartphone");
  expect(suggestTaskIcon("Mobile Overview cards")).toBe("smartphone");
  expect(suggestTaskIcon("Deploy the runtime host")).toBe("rocket");
  expect(suggestTaskIcon("Release 1.4 notes")).toBe("rocket");
  expect(suggestTaskIcon("Review the pipeline graph")).toBe("search-check");
});

test("a stem matches the words it starts and a whole word only itself; the first rule wins", () => {
  expect(suggestTaskIcon("Fixes for flaky tests")).toBe("bug");
  expect(suggestTaskIcon("Flaky e2e runs")).toBe("flask-conical");
  /* "ui" is a whole word, never the start of "build" or "guide". */
  expect(suggestTaskIcon("New UI for the list")).toBe("palette");
  expect(suggestTaskIcon("Quiet evening")).toBeNull();
  /* Order decides between two rules: a fix to the phone board is a bug. */
  expect(suggestTaskIcon("Fix the phone board")).toBe("bug");
  /* Only the first line is the title. */
  expect(suggestTaskIcon("Quiet title\nfix the crash below")).toBeNull();
  expect(suggestTaskIcon("")).toBeNull();
  expect(suggestTaskIcon("e2e-flaky suite")).toBe("flask-conical");
});

test("Ukrainian titles are read too, and a common word that shares a stem is not mistaken for one", () => {
  expect(suggestTaskIcon("Виправити помилку в картці")).toBe("bug");
  expect(suggestTaskIcon("Деплой на сервер")).toBe("rocket");
  expect(suggestTaskIcon("Телефонна дошка")).toBe("smartphone");
  expect(suggestTaskIcon("Рев'ю пайплайна")).toBe("search-check");
  /* The fix comes first, before the release its notes belong to. */
  expect(suggestTaskIcon("Полагодити старі посилання в нотатках до випуску")).toBe("bug");
  expect(suggestTaskIcon("Спростити аркуш налаштувань експорту")).toBe("wrench");
  /* "багато" (many) starts like "баг" and is not a bug. */
  expect(suggestTaskIcon("Багато вкладок")).toBeNull();
});

test("the same title always gives the same icon, and every icon the map names is a lucide name", () => {
  expect(suggestTaskIcon("Deploy the phone build")).toBe(suggestTaskIcon("Deploy the phone build"));
  for (const icon of SUGGESTED_TASK_ICONS) expect({ icon, canonical: canonicalTaskIcon(icon) }).toEqual({ icon, canonical: icon });
  expect(new Set(TASK_ICON_RULES.map((rule) => rule.icon)).size).toBe(TASK_ICON_RULES.length);
});

test("a task draws its stored icon, else the suggestion, else the quiet default; the suggestion is never stored", () => {
  expect(displayTaskIcon("rocket", "Fix the crash")).toEqual({ icon: "rocket", source: "stored" });
  expect(displayTaskIcon(null, "Fix the crash")).toEqual({ icon: "bug", source: "suggested" });
  expect(displayTaskIcon(undefined, "Quiet evening")).toEqual({ icon: DEFAULT_TASK_ICON, source: "default" });
  expect(displayTaskIcon("", "Quiet evening")).toEqual({ icon: DEFAULT_TASK_ICON, source: "default" });
});
