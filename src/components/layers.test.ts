import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { above, CONTENT_MAX, LAYER, Z, type Layer } from "./layers";

const COMPONENTS = path.resolve(import.meta.dir);
const SCALE_MODULE = path.join(COMPONENTS, "layers.ts");

/**
 * Exact inventory of existing raw z-indexes, retained until those surfaces move
 * onto the scale. A changed or removed entry fails alongside new raw values.
 * The reasons below preserve existing stacking while repairing this inventory.
 */
const LEGACY_RAW_Z: Record<string, readonly string[]> = {
  "SoundToggle.tsx": ["z-50"],
  /* Reload banner, two notice stacks and two focus notices. */
  "Viewer.tsx": ["z-50", "z-50", "z-50", "z-40", "z-40"],
  "AccountBadge.tsx": ["z-[95]"],
  "mobile/MobileFocusView.tsx": ["z-[55]"],
  /* Body-mounted drag ghost stays above the phone's dock and sheets (#2421). */
  "mobile/phoneCardLift.ts": ['zIndex: "80'],
  /* Existing header-anchored attention dropdown (#2256). */
  "attention/AttentionPanel.tsx": ["z-50"],
  /* Jump strip stays above the transcript and its live-tail pill (#2756). */
  "LogFeed.tsx": ["z-20"],
  /* Browser-only pixel probe covers the fixture; never shipped as a surface. */
  "kanban/issue1695BrowserHarness.ts": ["z-index:2147483647"],
  "kanban/kanbanBoard.css": [
    "z-index: 60",
    "z-index: 58",
    "z-index: 65",
    "z-index: 70",
    "z-index: 80",
    "z-index: 70",
    /* Field, scrim, agent window and relay reader share reader=64 (#2661, #3024). */
    "z-index: 64",
    "z-index: 64",
    "z-index: 64",
    "z-index: 64",
    "z-index: 62",
  ],
};

export interface RawZ {
  /** The literal as written: `z-40`, `z-[60]`, `zIndex: 80`, `z-index: 64`. */
  text: string;
  value: number;
  line: number;
}

const PATTERNS: RegExp[] = [
  /* Tailwind: z-40, z-[60], -z-10, hover:z-30. */
  /(?<![\w[-])-?z-(\d+)(?![\w\]-])/g,
  /(?<![\w[-])-?z-\[(-?\d+)\]/g,
  /* A style object: zIndex: 80 (a literal, not a value taken from the scale). */
  /zIndex\s*:\s*["'`]?(-?\d+)/g,
  /* A stylesheet: z-index: 64. */
  /z-index\s*:\s*(-?\d+)/g,
];

/** Every raw z-index in a source text whose value lies above the content range. */
export function rawZIndexes(source: string): RawZ[] {
  const found: (RawZ & { at: number })[] = [];
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const value = Math.abs(Number(match[1]));
      if (value <= CONTENT_MAX) continue;
      const line = source.slice(0, match.index).split("\n").length;
      found.push({ text: match[0].replace(/\s+/g, " "), value, line, at: match.index });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...entry }) => entry);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".fixture.tsx")) out.push(full);
  }
  return out;
}

function rawZViolations(sources: Record<string, string>, legacy: Record<string, readonly string[]>) {
  const offenders: string[] = [];
  const stale: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const found = rawZIndexes(source);
    const expected = legacy[file];
    if (expected) {
      const texts = found.map((entry) => entry.text);
      if (JSON.stringify(texts) !== JSON.stringify(expected)) stale.push(`${file}: expected exactly ${JSON.stringify(expected)}, found ${JSON.stringify(texts)}`);
    } else {
      for (const entry of found) offenders.push(`${file}:${entry.line} ${entry.text} — take it from src/components/layers.ts`);
    }
  }
  for (const file of Object.keys(legacy)) {
    if (!(file in sources)) stale.push(`${file}: exempted file is missing`);
  }
  return { offenders, stale };
}

describe("the guard reads every spelling of a raw z-index", () => {
  test("Tailwind classes, style objects and stylesheets above the content range are found", () => {
    const source = [
      `<div className="fixed z-50" />`,
      `<div className="absolute z-[80] hover:z-30" />`,
      `<div style={{ zIndex: 95 }} />`,
      `.menu { z-index: 70; }`,
    ].join("\n");
    expect(rawZIndexes(source).map((entry) => entry.text)).toEqual(["z-50", "z-[80]", "z-30", "zIndex: 95", "z-index: 70"]);
  });

  test("unchanged exemptions and scale references pass both checks", () => {
    expect(rawZViolations({
      "legacy.tsx": '<div className="z-50" />',
      "scaled.tsx": '<div className={Z.popover} />',
    }, { "legacy.tsx": ["z-50"] })).toEqual({ offenders: [], stale: [] });
  });

  test("new raw values and every stale exemption are reported together", () => {
    expect(rawZViolations({
      "new.tsx": '<div className="z-50 z-[80]" />',
      "changed.css": '.menu { z-index: 70; }',
      "migrated.tsx": '<div className={Z.popover} />',
    }, {
      "changed.css": ["z-index: 60"],
      "migrated.tsx": ["z-50"],
      "removed.tsx": ["z-50"],
    })).toEqual({
      offenders: [
        "new.tsx:1 z-50 — take it from src/components/layers.ts",
        "new.tsx:1 z-[80] — take it from src/components/layers.ts",
      ],
      stale: [
        'changed.css: expected exactly ["z-index: 60"], found ["z-index: 70"]',
        'migrated.tsx: expected exactly ["z-50"], found []',
        "removed.tsx: exempted file is missing",
      ],
    });
  });

  test("content-range values, scale references and lookalikes pass", () => {
    const source = [
      `<div className="relative z-[1] z-10" />`,
      `<div style={{ zIndex: 10 - depth }} />`,
      `<div className={Z.popover} style={{ zIndex: LAYER.overlay }} />`,
      `<div className="size-40 lazy-40 fuzz-50" />`,
      `.card { z-index: 3; }`,
    ].join("\n");
    expect(rawZIndexes(source)).toEqual([]);
  });
});

describe("one layering scale", () => {
  test("the layers keep their documented order and sit above the content range", () => {
    const order: Layer[] = ["lifted", "sticky", "dock", "sheet", "reader", "modal", "popover", "overlay", "toast", "tooltip", "feedback"];
    expect(Object.keys(LAYER)).toEqual(order);
    const values = order.map((name) => LAYER[name]);
    expect(values[0]).toBeGreaterThan(CONTENT_MAX);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every layer's class carries the layer's number", () => {
    for (const [name, value] of Object.entries(LAYER)) expect(Z[name as Layer]).toBe(`z-[${value}]`);
  });

  test("an overlay opened from a modal outranks it, and a menu outranks both sheets and modals", () => {
    expect(LAYER.popover).toBeGreaterThan(LAYER.modal);
    expect(LAYER.overlay).toBeGreaterThan(LAYER.popover);
    expect(LAYER.modal).toBeGreaterThan(LAYER.sheet);
  });

  test("what a conversation opens draws above the full-screen surfaces that host it", () => {
    const css = fs.readFileSync(path.join(COMPONENTS, "kanban/kanbanBoard.css"), "utf8");
    const zOf = (selector: string): number => {
      const rule = css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";
      const value = rule.match(/z-index:\s*(\d+)/)?.[1];
      expect(value, `${selector} carries a z-index`).toBeDefined();
      return Number(value);
    };
    /* The agent window, its field and scrim, and the phone's reader screen. */
    for (const host of [".kb .aw-field", ".kb .aw-scrim", ".kb .reader-screen"]) expect(zOf(host)).toBe(LAYER.reader);
    expect(css).toMatch(/\.kb \.agent-window[^{]*\{[^}]*z-index:\s*64/);

    const stages = zOf(".kb .gsheet-scrim");
    const preview = above("reader");
    expect(LAYER.sheet).toBeLessThan(stages);
    expect(stages).toBeLessThan(LAYER.reader);
    expect(LAYER.reader).toBeLessThan(preview);
    expect(preview).toBeLessThan(LAYER.modal);
    /* The runtime menu and sheet are popovers: over every host. */
    expect(LAYER.popover).toBeGreaterThan(LAYER.reader);

    const source = (file: string) => fs.readFileSync(path.join(COMPONENTS, file), "utf8");
    expect(source("preview/ArtifactPreviewHost.tsx")).toContain('above("reader")');
    expect(rawZIndexes(source("RuntimePill.tsx"))).toEqual([]);
    expect(source("RuntimePill.tsx")).toContain("${Z.popover}");
  });

  test("no component under src/components uses a raw z-index outside the scale module", () => {
    const sources: Record<string, string> = {};
    for (const file of sourceFiles(COMPONENTS)) {
      if (file === SCALE_MODULE) continue;
      const rel = path.relative(COMPONENTS, file).split(path.sep).join("/");
      sources[rel] = fs.readFileSync(file, "utf8");
    }
    /* One assertion prints both groups even when new raw values are present. */
    expect(rawZViolations(sources, LEGACY_RAW_Z)).toEqual({ offenders: [], stale: [] });
  });
});
