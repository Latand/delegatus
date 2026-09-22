import { describe, expect, test } from "bun:test";
import { changelogDelta, parseChangelog, summarizeDelta } from "./changelog";

const OLD = `# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Board placements are stored in SQLite so a restart keeps them
  where the operator left them (#1990)

## [1.2.2] — 2026-09-19

### Fixed

- The composer no longer loses a draft on reconnect (#1901)

## [1.2.1] — 2026-09-10

### Changed

- Tool rows read as one line (#1933)
`;

const NEW = `# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Board placements are stored in SQLite so a restart keeps them
  where the operator left them (#1990)
- A self-update prototype checks for a newer revision. It builds in place
  and restarts each process on request (#2007)

### Fixed

- A seat tick keeps one standing card per project (#2003)

## [1.2.3] — 2026-09-21

### Changed

- A state-mutating startup step runs only in the Viewer or the runtime host (#1905)
- Deploys verify the runtime host under the pinned Bun (#1254)

### Fixed

- Stale review exports no longer fill the temp quota (#1957)

## [1.2.2] — 2026-09-19

### Fixed

- The composer no longer loses a draft on reconnect (#1901)

## [1.2.1] — 2026-09-10

### Changed

- Tool rows read as one line (#1933)
`;

describe("parseChangelog", () => {
  test("reads version headings, typed sections and wrapped bullets as one line", () => {
    const versions = parseChangelog(NEW);
    expect(versions.map((version) => version.heading)).toEqual(["Unreleased", "1.2.3", "1.2.2", "1.2.1"]);
    const unreleased = versions[0]!;
    expect(unreleased.sections.map((section) => section.type)).toEqual(["Added", "Fixed"]);
    expect(unreleased.sections[0]!.items[0]).toBe(
      "Board placements are stored in SQLite so a restart keeps them where the operator left them (#1990)",
    );
    expect(unreleased.sections[0]!.items).toHaveLength(2);
  });

  test("ignores prose before the first version heading", () => {
    expect(parseChangelog("# Changelog\n\nNothing yet.\n")).toEqual([]);
  });
});

describe("changelogDelta", () => {
  test("takes a new version heading whole and only the new Unreleased items", () => {
    const delta = changelogDelta(OLD, NEW);
    expect(delta.headings).toEqual(["1.2.3"]);
    expect(delta.entries).toEqual([
      { type: "Added", text: "A self-update prototype checks for a newer revision. It builds in place and restarts each process on request (#2007)" },
      { type: "Fixed", text: "A seat tick keeps one standing card per project (#2003)" },
      { type: "Changed", text: "A state-mutating startup step runs only in the Viewer or the runtime host (#1905)" },
      { type: "Changed", text: "Deploys verify the runtime host under the pinned Bun (#1254)" },
      { type: "Fixed", text: "Stale review exports no longer fill the temp quota (#1957)" },
    ]);
  });

  test("compares Unreleased items after whitespace normalisation", () => {
    const rewrapped = OLD.replace("keeps them\n  where", "keeps   them where");
    expect(changelogDelta(rewrapped, OLD).entries).toEqual([]);
  });

  test("identical files give an empty delta", () => {
    const delta = changelogDelta(NEW, NEW);
    expect(delta.headings).toEqual([]);
    expect(delta.entries).toEqual([]);
  });

  test("a missing changelog on either side reads as empty", () => {
    expect(changelogDelta(null, NEW).headings).toEqual(["1.2.3", "1.2.2", "1.2.1"]);
    expect(changelogDelta(NEW, null).entries).toEqual([]);
  });
});

describe("summarizeDelta", () => {
  test("counts per type in first-seen order", () => {
    const summary = summarizeDelta(changelogDelta(OLD, NEW), 5);
    expect(summary.commitCount).toBe(5);
    expect(summary.entryCount).toBe(5);
    expect(summary.counts).toEqual([{ type: "Added", count: 1 }, { type: "Fixed", count: 2 }, { type: "Changed", count: 2 }]);
    expect(summary.groups.map((group) => [group.type, group.items.length])).toEqual([
      ["Added", 1],
      ["Fixed", 2],
      ["Changed", 2],
    ]);
  });

  test("keeps each item's first sentence", () => {
    const summary = summarizeDelta(changelogDelta(OLD, NEW), 5);
    expect(summary.groups[0]!.items[0]).toBe("A self-update prototype checks for a newer revision.");
  });

  test("cuts a long first sentence to at most 160 characters on a word boundary", () => {
    const long = `- ${"word ".repeat(60).trim()} (#1)`;
    const text = `## [Unreleased]\n\n### Added\n\n${long}\n`;
    const item = summarizeDelta(changelogDelta("", text), 1).groups[0]!.items[0]!;
    expect(item.length).toBeLessThanOrEqual(160);
    expect(item.endsWith(" word…")).toBe(true);
  });

  test("a long sentence drops its parenthetical asides, then ends on a clause boundary", () => {
    const item = [
      "- Attention requests, reply suggestions and per-project seat tick settings are",
      "  stored in SQLite (`state.sqlite`, collections `attention`,",
      "  `reply_suggestions` and `seat_tick_settings`) instead of `attention.json`,",
      "  `reply-suggestions.json` and `seat-tick-settings.json`. A write commits only",
      "  the rows it changed (#1905).",
    ].join("\n");
    const text = `## [Unreleased]\n\n### Changed\n\n${item}\n`;
    const cut = summarizeDelta(changelogDelta("", text), 1).groups[0]!.items[0]!;
    expect(cut).toBe("Attention requests, reply suggestions and per-project seat tick settings are stored in SQLite instead of `attention.json`…");
    expect(cut.length).toBeLessThanOrEqual(160);
  });

  test("shows eight items per type and counts the rest", () => {
    const bullets = Array.from({ length: 11 }, (_, index) => `- Change number ${index + 1} (#${index})`).join("\n");
    const summary = summarizeDelta(changelogDelta("", `## [Unreleased]\n\n### Changed\n\n${bullets}\n`), 11);
    expect(summary.groups[0]!.items).toHaveLength(8);
    expect(summary.groups[0]!.more).toBe(3);
  });

  test("says so when the commits carry no changelog entry", () => {
    const summary = summarizeDelta(changelogDelta(NEW, NEW), 1);
    expect(summary.commitCount).toBe(1);
    expect(summary.entryCount).toBe(0);
    expect(summary.groups).toEqual([]);
  });
});
