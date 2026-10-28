import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test.each([
  "docs/design/task-board-integration/artifact/index.html",
  "docs/design/mobile-v2/prototype/index.html",
])("prototype title names Delegatus: %s", (file) => {
  const title = read(file).match(/<title>([\s\S]*?)<\/title>/)?.[1];
  expect(title).toContain("Delegatus");
  expect(title).not.toContain("Agent Log Viewer");
});

test.each([
  "src/components/ui/SectionHeader.tsx",
  "src/components/workflows/WorkflowStrip.tsx",
])("retired UI without an importer stays removed: %s", (file) => {
  expect(fs.existsSync(path.join(root, file))).toBe(false);
});

test.each([
  "scripts/capture-board-density.ts",
  "scripts/fixtures/board-density.tsx",
  "scripts/capture-layering.ts",
  "scripts/capture-issue-1418-accounts-dialog.ts",
  "scripts/capture-issue-1586-task-bands.ts",
  "scripts/capture-issue-1625-catalog-focus.ts",
  "scripts/readable-tool-shots.tsx",
  "scripts/evidence-crown-capture.ts",
  "scripts/evidence-crown-browser.cjs",
])("uncalled capture stays retired: %s", (file) => {
  expect(fs.existsSync(path.join(root, file))).toBe(false);
});

test("shared capture entry points remain available", () => {
  for (const file of [
    "scripts/capture-board-geometry.ts",
    "scripts/capture-directory.ts",
    "scripts/capture-readme-media.ts",
    "src/components/kanban/kanbanBoard.browser.test.tsx",
    "src/components/conversation/conversationWindow.browser.test.tsx",
    "src/components/mobile/issue1671Evidence.browser.test.tsx",
  ]) expect(fs.existsSync(path.join(root, file))).toBe(true);
});

test.each(["dist", "dist/esm"])("upstream Next preserves concatenated module id zero (%s)", (build) => {
  // The retired local patch changed a truthiness test to a null check. Exercise
  // the installed guard in both shipped builds, so zero cannot disappear again.
  const source = read(`node_modules/next/${build}/build/webpack/plugins/flight-manifest-plugin.js`);
  const guard = source.match(/if \((concatenatedModId[^)]*)\)\s*\{\s*recordModule\(concatenatedModId, clientEntryMod\)/)?.[1];
  expect(guard).toBeDefined();
  const records = new Function("concatenatedModId", `return ${guard};`) as (id: number | null) => boolean;
  expect(records(0)).toBe(true);
  expect(records(1)).toBe(true);
  expect(records(null)).toBe(false);
  const manifest = JSON.parse(read("package.json"));
  expect(Object.keys(manifest.patchedDependencies).some((name) => name.startsWith("next@"))).toBe(false);
  expect(fs.readdirSync(path.join(root, "patches")).some((name) => name.startsWith("next-"))).toBe(false);
});
