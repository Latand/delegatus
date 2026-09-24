/* Keep a Changelog parsing and the delta between two revisions of
   CHANGELOG.md (#2007). Pure: no file or git access here. */
import { linkDefinitions, resolveReferences } from "./changelogMarkup";
import type { DeltaSummary } from "./types";

export interface ChangelogSection { type: string; items: string[] }
export interface ChangelogVersion { heading: string; sections: ChangelogSection[] }
export interface ChangelogEntry { type: string; text: string }
export interface ChangelogDelta { headings: string[]; entries: ChangelogEntry[] }

const VERSION_HEADING = /^##\s+\[([^\]]+)\]/;
const TYPE_HEADING = /^###\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
export const ITEMS_PER_TYPE = 8;

export function parseChangelog(text: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = [];
  let version: ChangelogVersion | null = null;
  let section: ChangelogSection | null = null;
  let item: string[] | null = null;
  const flush = () => {
    if (item && section) section.items.push(normalise(item.join(" ")));
    item = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const versionMatch = VERSION_HEADING.exec(line);
    if (versionMatch) {
      flush();
      version = { heading: versionMatch[1]!.trim(), sections: [] };
      versions.push(version);
      section = null;
      continue;
    }
    if (!version) continue;
    const typeMatch = TYPE_HEADING.exec(line);
    if (typeMatch) {
      flush();
      section = { type: typeMatch[1]!, items: [] };
      version.sections.push(section);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && section) {
      flush();
      item = [bullet[1]!];
      continue;
    }
    if (line.trim() === "") { flush(); continue; }
    if (item && /^\s/.test(raw)) item.push(line.trim());
  }
  flush();
  return versions;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isUnreleased(heading: string): boolean {
  return heading.toLowerCase() === "unreleased";
}

/** Every version heading present at the new revision and absent at the old
    one, whole, plus the Unreleased items the old revision did not have. An
    entry's reference-style links (`[#2096]`) are rewritten as inline links
    from the new revision's own definitions, so each entry carries its
    targets. */
export function changelogDelta(oldText: string | null, newText: string | null): ChangelogDelta {
  const before = parseChangelog(oldText ?? "");
  const after = parseChangelog(newText ?? "");
  const known = new Set(before.map((version) => version.heading));
  const definitions = linkDefinitions(newText ?? "");
  const entries: ChangelogEntry[] = [];
  const headings: string[] = [];
  const add = (type: string, text: string) => entries.push({ type, text: resolveReferences(text, definitions) });

  const oldUnreleased = new Set(
    before.filter((version) => isUnreleased(version.heading))
      .flatMap((version) => version.sections.flatMap((section) => section.items)),
  );
  for (const version of after.filter((candidate) => isUnreleased(candidate.heading))) {
    for (const section of version.sections) {
      for (const text of section.items) if (!oldUnreleased.has(text)) add(section.type, text);
    }
  }
  for (const version of after) {
    if (isUnreleased(version.heading) || known.has(version.heading)) continue;
    headings.push(version.heading);
    for (const section of version.sections) {
      for (const text of section.items) add(section.type, text);
    }
  }
  return { headings, entries };
}

export function summarizeDelta(delta: ChangelogDelta, commitCount: number): DeltaSummary {
  const byType = new Map<string, string[]>();
  for (const entry of delta.entries) {
    const items = byType.get(entry.type) ?? [];
    items.push(entry.text);
    byType.set(entry.type, items);
  }
  return {
    commitCount,
    entryCount: delta.entries.length,
    counts: [...byType].map(([type, items]) => ({ type, count: items.length })),
    groups: [...byType].map(([type, items]) => ({
      type,
      /* Whole: the surface shows each item's lead and expands the rest
         (`splitItem`), which a cut made here could only do mid-markup. */
      items: items.slice(0, ITEMS_PER_TYPE),
      more: Math.max(0, items.length - ITEMS_PER_TYPE),
    })),
  };
}
