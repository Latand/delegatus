/* Keep a Changelog parsing and the delta between two revisions of CHANGELOG.md.
   Pure: no file or git access here. */

export interface ChangelogSection { type: string; items: string[] }
export interface ChangelogVersion { heading: string; sections: ChangelogSection[] }
export interface ChangelogEntry { type: string; text: string }
export interface ChangelogDelta { headings: string[]; entries: ChangelogEntry[] }
export interface DeltaGroup { type: string; items: string[]; more: number }
export interface DeltaSummary { line: string; groups: DeltaGroup[] }

const VERSION_HEADING = /^##\s+\[([^\]]+)\]/;
const TYPE_HEADING = /^###\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const ITEMS_PER_TYPE = 8;
const ITEM_CHARS = 160;

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

/* Every version heading present at the new revision and absent at the old one,
   whole, plus the Unreleased items the old revision did not have. */
export function changelogDelta(oldText: string | null, newText: string | null): ChangelogDelta {
  const before = parseChangelog(oldText ?? "");
  const after = parseChangelog(newText ?? "");
  const known = new Set(before.map((version) => version.heading));
  const entries: ChangelogEntry[] = [];
  const headings: string[] = [];

  const oldUnreleased = new Set(
    before.filter((version) => isUnreleased(version.heading))
      .flatMap((version) => version.sections.flatMap((section) => section.items)),
  );
  for (const version of after.filter((candidate) => isUnreleased(candidate.heading))) {
    for (const section of version.sections) {
      for (const text of section.items) if (!oldUnreleased.has(text)) entries.push({ type: section.type, text });
    }
  }
  for (const version of after) {
    if (isUnreleased(version.heading) || known.has(version.heading)) continue;
    headings.push(version.heading);
    for (const section of version.sections) {
      for (const text of section.items) entries.push({ type: section.type, text });
    }
  }
  return { headings, entries };
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?=\s+[A-Z(`"]|$)/.exec(text);
  const sentence = (match ? match[1]! : text).trim();
  return sentence.length <= ITEM_CHARS ? sentence : `${sentence.slice(0, ITEM_CHARS - 1)}…`;
}

export function summarizeDelta(delta: ChangelogDelta, commitCount: number): DeltaSummary {
  const commits = `${commitCount} ${commitCount === 1 ? "commit" : "commits"}`;
  if (delta.entries.length === 0) return { line: `${commits} · No changelog entries for these commits.`, groups: [] };
  const byType = new Map<string, string[]>();
  for (const entry of delta.entries) {
    const items = byType.get(entry.type) ?? [];
    items.push(entry.text);
    byType.set(entry.type, items);
  }
  const counts = [...byType].map(([type, items]) => `${items.length} ${type}`).join(", ");
  const entries = `${delta.entries.length} changelog ${delta.entries.length === 1 ? "entry" : "entries"}`;
  return {
    line: `${commits} · ${entries} (${counts})`,
    groups: [...byType].map(([type, items]) => ({
      type,
      items: items.slice(0, ITEMS_PER_TYPE).map(firstSentence),
      more: Math.max(0, items.length - ITEMS_PER_TYPE),
    })),
  };
}
