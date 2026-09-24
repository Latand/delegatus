import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createTask, patchTask } from "./commands";
import { parseLucideIconImports } from "./lucideIconSource";
import { LUCIDE_ICON_ALIAS_LIST, LUCIDE_ICON_NAME_LIST, LUCIDE_REACT_VERSION } from "./lucideIconNames";
import { canonicalTaskIcon, lucideIconNames, readTaskIconInput, searchTaskIcons } from "./taskIcon";
import { taskIconNodes } from "./taskIconNodes";
import type { BoardTask } from "./types";

/* A task's icon (#2102): the name list, how a caller's key is read, what an
   unknown one is clamped to, and the create/update commands both surfaces use.
   Pure: no store or state directory is touched. */

const lucide = path.join(process.cwd(), "node_modules/lucide-react");

test("the committed name list is lucide-react's own, for the installed version", () => {
  const { names, aliases } = parseLucideIconImports(fs.readFileSync(path.join(lucide, "dist/esm/dynamicIconImports.mjs"), "utf8"));
  const version = (JSON.parse(fs.readFileSync(path.join(lucide, "package.json"), "utf8")) as { version: string }).version;
  /* Fails after a lucide-react bump until `bun scripts/generate-lucide-icon-names.ts` is run. */
  expect(LUCIDE_REACT_VERSION).toBe(version);
  expect(LUCIDE_ICON_NAME_LIST.trim().split(/\s+/)).toEqual(names);
  expect(LUCIDE_ICON_ALIAS_LIST.trim().split(/\s+/)).toEqual([...aliases].map(([alias, name]) => `${alias}:${name}`));
  expect(names.length).toBeGreaterThan(1000);
  expect(lucideIconNames()).toEqual(names);
});

test("case, the lucide: prefix, spaces, React export names and renamed icons all read as one stored name", () => {
  for (const key of ["bug", "Bug", "BUG", "lucide:bug", "Lucide: Bug", "lucide/bug", " bug ", "BugIcon", "LucideBug"]) {
    expect({ key, icon: canonicalTaskIcon(key) }).toEqual({ key, icon: "bug" });
  }
  for (const key of ["search-check", "search check", "Search Check", "SearchCheck", "search_check", "lucide:search-check"]) {
    expect({ key, icon: canonicalTaskIcon(key) }).toEqual({ key, icon: "search-check" });
  }
  /* A renamed icon's old name stores the name it points to. */
  expect(canonicalTaskIcon("alarm-check")).toBe("alarm-clock-check");
  expect(canonicalTaskIcon("AlertTriangle")).toBe("triangle-alert");
  expect(canonicalTaskIcon("Heading1")).toBe("heading-1");
  /* A size stays whole: `2x2` is one part of the name, never `2x-2`. */
  expect(canonicalTaskIcon("Grid2x2")).toBe("grid-2x2");
  expect(canonicalTaskIcon("Grid3x3Icon")).toBe("grid-3x3");
  expect(canonicalTaskIcon("definitely-not-an-icon")).toBeNull();
  expect(canonicalTaskIcon("../../etc/passwd")).toBeNull();
  expect(canonicalTaskIcon("")).toBeNull();
});

test("every lucide name, written as its React export, reads back as itself", () => {
  const pascal = (name: string) => name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  const lost = lucideIconNames().flatMap((name) => [pascal(name), `${pascal(name)}Icon`, `Lucide${pascal(name)}`]
    .filter((form) => canonicalTaskIcon(form) !== name)
    .map((form) => `${form} → ${canonicalTaskIcon(form)}, not ${name}`));
  expect(lost).toEqual([]);
});

test("an icon field sets, clears, or clamps to none with a note; it never refuses", () => {
  expect(readTaskIconInput("Rocket")).toEqual({ kind: "set", icon: "rocket" });
  for (const value of [null, undefined, "", "  ", "none", "None"]) expect(readTaskIconInput(value)).toEqual({ kind: "clear" });
  const unknown = readTaskIconInput("bugs");
  expect(unknown.kind).toBe("clamped");
  const note = unknown.kind === "clamped" ? unknown.note : "";
  expect(note).toContain('"bugs" is not a lucide icon name');
  expect(note).toContain("close names: bug");
  const odd = readTaskIconInput(42);
  expect(odd.kind).toBe("clamped");
  /* A long key is shortened in the note, so the answer stays small. */
  const long = readTaskIconInput("x".repeat(500));
  expect(long.kind === "clamped" && long.note.length).toBeLessThan(200);
});

test("search ranks the name itself, then names it starts, then word starts, and finds renamed icons by their old name", () => {
  expect(searchTaskIcons("bug").names.slice(0, 3)).toEqual(["bug", "bug-off", "bug-play"]);
  const rocket = searchTaskIcons("rock");
  expect(rocket.names[0]).toBe("rocket");
  expect(rocket.names).toContain("rocking-chair");
  /* Every name "check" starts comes before every name it only starts a word of. */
  const check = searchTaskIcons("check", 500).names;
  expect(check[0]).toBe("check");
  const lastPrefix = check.findLastIndex((name) => name.startsWith("check"));
  const firstWord = check.findIndex((name) => !name.startsWith("check") && name.includes("-check"));
  expect(lastPrefix).toBeLessThan(firstWord);
  expect(check).toContain("search-check");
  expect(searchTaskIcons("alert-triangle").names[0]).toBe("triangle-alert");
  expect(searchTaskIcons("Search Check").names[0]).toBe("search-check");
  const none = searchTaskIcons("zzzzqqq");
  expect(none).toEqual({ names: [], total: 0 });
  const limited = searchTaskIcons("arrow", 10);
  expect(limited.names).toHaveLength(10);
  expect(limited.total).toBeGreaterThan(10);
});

test("the drawing of an icon is lucide's own, and a name lucide does not have draws nothing", async () => {
  const icons = await taskIconNodes(["bug", "Rocket", "alarm-check", "nope", "../x", "bug"]);
  expect(Object.keys(icons)).toEqual(["bug", "Rocket", "alarm-check", "nope", "../x"]);
  expect(icons.bug?.[0]?.[0]).toBe("path");
  expect(icons.bug?.every(([tag, attrs]) => typeof tag === "string" && typeof attrs === "object")).toBe(true);
  expect(icons.Rocket?.length).toBeGreaterThan(0);
  expect(icons["alarm-check"]?.length).toBeGreaterThan(0);
  expect(icons.nope).toBeNull();
  expect(icons["../x"]).toBeNull();
});

const NOW = "2026-09-24T10:00:00.000Z";

test("create stores a normalised icon, and an unknown one creates the task without an icon and a note", () => {
  const created = createTask([], { project: "p", text: "Fix the crash", placement: "unplaced", icon: "lucide:Bug" }, [], { now: () => NOW, id: () => "a" });
  expect(created.ok && created.task.icon).toBe("bug");
  expect(created.ok && created.notes).toBeUndefined();
  const clamped = createTask([], { project: "p", text: "Ship it", placement: "unplaced", icon: "starship" }, [], { now: () => NOW, id: () => "b" });
  expect(clamped.ok).toBe(true);
  expect(clamped.ok && "icon" in clamped.task).toBe(false);
  expect(clamped.ok && clamped.notes?.[0]).toContain('"starship" is not a lucide icon name');
  const plain = createTask([], { project: "p", text: "No icon", placement: "unplaced" }, [], { now: () => NOW, id: () => "c" });
  expect(plain.ok && "icon" in plain.task).toBe(false);
});

test("an icon update is presentation: it keeps updatedAt, clears on none or an unknown name, and says why", () => {
  const base: BoardTask = { id: "a", project: "p", status: "inbox", text: "Release", placement: "unplaced", assignments: [], createdAt: NOW, updatedAt: NOW };
  const set = patchTask([base], "a", { icon: "Rocket" }, "2026-09-24T11:00:00.000Z");
  expect(set.ok && set.task).toMatchObject({ icon: "rocket", updatedAt: NOW });
  const tasks = set.ok ? set.tasks : [];
  const unknown = patchTask(tasks, "a", { icon: "rockettt" }, "2026-09-24T12:00:00.000Z");
  expect(unknown.ok).toBe(true);
  expect(unknown.ok && "icon" in unknown.task).toBe(false);
  expect(unknown.ok && unknown.notes?.[0]).toContain("rockettt");
  const cleared = patchTask(tasks, "a", { icon: "none" });
  expect(cleared.ok && "icon" in cleared.task).toBe(false);
  expect(cleared.ok && cleared.notes).toBeUndefined();
  /* With other work in the same patch, the patch is work and moves updatedAt. */
  const withText = patchTask(tasks, "a", { icon: "bug", text: "Release, fixed" }, "2026-09-24T13:00:00.000Z");
  expect(withText.ok && withText.task).toMatchObject({ icon: "bug", updatedAt: "2026-09-24T13:00:00.000Z" });
});
