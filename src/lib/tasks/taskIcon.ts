import { LUCIDE_ICON_ALIAS_LIST, LUCIDE_ICON_NAME_LIST } from "./lucideIconNames";

/**
 * A task's icon (#2102) is a lucide icon name, stored kebab-case. Whatever a
 * caller writes is read generously: `Bug`, `bug`, `lucide:bug`, `BugIcon`,
 * `arrow down` and a renamed icon's old name all store one name. A value that
 * names no lucide icon is never refused; it is clamped to no icon, and the
 * answer carries a note saying so.
 *
 * This module holds the whole lucide name list, so the client reaches it only
 * through the picker's lazy import.
 */

let tables: { names: ReadonlySet<string>; list: readonly string[]; aliases: ReadonlyMap<string, string> } | null = null;
function iconTables() {
  if (!tables) {
    const list = LUCIDE_ICON_NAME_LIST.trim().split(/\s+/);
    const aliases = new Map(LUCIDE_ICON_ALIAS_LIST.trim().split(/\s+/).map((pair) => pair.split(":") as [string, string]));
    tables = { names: new Set(list), list, aliases };
  }
  return tables;
}

/** Every lucide icon name, sorted: the picker's search space. */
export function lucideIconNames(): readonly string[] {
  return iconTables().list;
}

/** The key as lucide writes names: lower-case words joined by single hyphens. */
function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The forms a key may stand for, in the order they are tried. */
function candidates(raw: string): string[] {
  const key = kebab(raw.trim().replace(/^lucide\s*[:/]\s*/i, ""));
  if (!key) return [];
  const forms = [key];
  /* A React export name: `LucideBug`, `BugIcon`. */
  if (key.startsWith("lucide-")) forms.push(key.slice("lucide-".length));
  if (key.endsWith("-icon")) forms.push(key.slice(0, -"-icon".length));
  /* `Heading1`, `Grid2x2`: lucide sets a number off with a hyphen, and keeps
     a size such as `2x2` whole, so a letter right after a digit is not split. */
  forms.push(...forms.map((form) => form.replace(/(?<!\d)([a-z])(\d)/g, "$1-$2")).filter((form) => !forms.includes(form)));
  return forms;
}

/** The stored name `raw` stands for, or null when it names no lucide icon. */
export function canonicalTaskIcon(raw: string): string | null {
  const { names, aliases } = iconTables();
  for (const form of candidates(raw)) {
    if (names.has(form)) return form;
    const renamed = aliases.get(form);
    if (renamed) return renamed;
  }
  return null;
}

/** Up to three names close to a key nothing matched, for the clamp note. */
function nearNames(raw: string): string[] {
  const key = candidates(raw)[0];
  if (!key || key.length < 3) return [];
  return iconTables().list
    .filter((name) => name.length >= 3 && (name.includes(key) || key.includes(name)))
    .sort((a, b) => Math.abs(a.length - key.length) - Math.abs(b.length - key.length) || a.localeCompare(b))
    .slice(0, 3);
}

/**
 * The picker's search: names holding the query, best first — the name itself,
 * then names it starts, then names with a word it starts, then the rest, each
 * group alphabetical. A renamed icon's old name finds it too. `total` counts
 * every match, of which `names` holds the first `limit`.
 */
export function searchTaskIcons(query: string, limit = 64): { names: string[]; total: number } {
  const { list, aliases } = iconTables();
  const key = kebab(query.trim().replace(/^lucide\s*[:/]\s*/i, ""));
  if (!key) return { names: list.slice(0, limit), total: list.length };
  const rank = (name: string) => (name === key ? 0 : name.startsWith(key) ? 1 : name.includes(`-${key}`) ? 2 : name.includes(key) ? 3 : 4);
  const best = new Map<string, number>();
  for (const name of list) {
    const value = rank(name);
    if (value < 4) best.set(name, value);
  }
  for (const [alias, name] of aliases) {
    const value = rank(alias);
    if (value < 4 && value < (best.get(name) ?? 4)) best.set(name, value);
  }
  const names = [...best].sort(([a, ra], [b, rb]) => ra - rb || a.localeCompare(b)).map(([name]) => name);
  return { names: names.slice(0, limit), total: names.length };
}

export type TaskIconInput =
  | { kind: "set"; icon: string }
  | { kind: "clear" }
  /** Named no lucide icon: stored as no icon, with this note in the answer. */
  | { kind: "clamped"; note: string };

/** What an `icon` field on a create or an update asks for. `null`, an empty
    string and `none` clear it. */
export function readTaskIconInput(value: unknown): TaskIconInput {
  if (value === null || value === undefined) return { kind: "clear" };
  if (typeof value !== "string") {
    return { kind: "clamped", note: "icon must be a lucide icon name such as \"bug\"; the task has no icon" };
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return { kind: "clear" };
  const icon = canonicalTaskIcon(trimmed);
  if (icon) return { kind: "set", icon };
  const near = nearNames(trimmed);
  const shown = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
  return {
    kind: "clamped",
    note: `icon "${shown}" is not a lucide icon name, so the task has no icon${near.length ? `; close names: ${near.join(", ")}` : ""}. Names are kebab-case, as listed at lucide.dev/icons.`,
  };
}
