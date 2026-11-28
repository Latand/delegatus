import { expect, test } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { report, git } from "./merge-batch";
import { extendPr, landingFixture, limitTest, realTests, unchangedCulprit, installMergeBatchFixtures } from "./merge-batch.fixture";

installMergeBatchFixtures();

test("a changed detector keeps its assertions when another member replaces the contract", async () => {
  const f = landingFixture("green", realTests);
  f.seed("limit.js", "exports.limit = 1;\n");
  f.seed("limit.test.ts", limitTest(1));
  f.addPr(12, "limit.js", "exports.limit = 2;\n");
  const reviewed = extendPr(f, 12, { "limit.test.ts": limitTest(2) });
  const detector = f.addPr(13, "limit.test.ts", limitTest(1, "test('positive', () => expect(limit > 0).toBe(true));\n"));
  await f.batch.build(`12@${reviewed},13@${detector}`);
  const gated = await f.batch.gate();
  expect(gated.rows.map(row => row.status)).toEqual(["culprit", "clean"]);
  expect(gated.attributionLog.map(entry => [entry.test.name, entry.prs])).toEqual([["limit", [12]]]);
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["culprit", "merged"]);
  unchangedCulprit(f, 12, reviewed);
  expect(git(f.repo, ["show", "HEAD:limit.test.ts"])).toBe(limitTest(1, "test('positive', () => expect(limit > 0).toBe(true));\n").trimEnd());
}, 60_000);

test("an unchanged behavioural detector still withholds a regression beside a reviewed contract replacement", async () => {
  const f = landingFixture("green", realTests);
  f.seed("limit.js", "exports.limit = 1;\n");
  f.seed("limit.test.ts", limitTest(1));
  f.seed("adder.js", "exports.add = (a, b) => a + b;\n");
  f.seed("adder.test.ts", "const { test, expect } = require('bun:test');\n"
    + "test('adds', () => expect(require('./adder.js').add(5, 3)).toBe(8));\n");
  f.addPr(12, "limit.js", "exports.limit = 2;\n");
  const replacement = extendPr(f, 12, { "limit.test.ts": limitTest(2) });
  const bad = f.addPr(13, "adder.js", "exports.add = (a, b) => a - b;\n");
  const healthy = f.addPr(14, "healthy.txt", "healthy\n");
  await f.batch.build(`12@${replacement},13@${bad},14@${healthy}`);
  const gated = await f.batch.gate();
  expect(gated.rows.map(row => row.status)).toEqual(["clean", "culprit", "clean"]);
  expect(gated.attributionLog.map(entry => [entry.test.name, entry.prs])).toEqual([["adds", [13]]]);
  expect(gated.gated!.notApplicable.some(entry => entry.file === "adder.test.ts")).toBeFalse();
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "culprit", "merged"]);
  unchangedCulprit(f, 13, bad);
}, 60_000);

test("an unreviewed weakening of a built contract replacement cannot earn a receipt", async () => {
  const f = landingFixture("green", realTests);
  f.seed("limit.js", "exports.limit = 1;\n");
  f.seed("limit.test.ts", limitTest(1));
  f.addPr(12, "limit.js", "exports.limit = 2;\n");
  const replacement = extendPr(f, 12, { "limit.test.ts": limitTest(2) });
  const healthy = f.addPr(13, "healthy.txt", "healthy\n");
  const built = await f.batch.build(`12@${replacement},13@${healthy}`);
  writeFileSync(join(built.work, "limit.test.ts"), "const { test, expect } = require('bun:test');\ntest('limit', () => expect(true).toBe(true));\n");
  await expect(f.batch.gate()).rejects.toThrow("Batch worktree changed outside this run");
  expect(f.batch.read().gated).toBeNull();
  await expect(f.batch.land()).rejects.toThrow("Batch worktree changed outside this run");
  expect(f.calls.some(args => args[0] === "pr" && ["create", "merge", "close"].includes(args[1]!))).toBeFalse();
}, 60_000);

for (const scope of ["adjacent", "batch union"] as const) {
  test(`an older PR never installs its unchanged stale test (${scope})`, async () => {
    const sampled: string[] = [];
    const f = landingFixture("green", async (cwd, args, env) => {
      if (args[2] === "bun" && args[3] === "test" && args[4] === "./limit.test.ts") {
        sampled.push(readFileSync(join(cwd, "limit.test.ts"), "utf8"));
      }
      return realTests(cwd, args, env);
    });
    const moduleSource = (value: number, flag: boolean) => `exports.limit = ${value};\n// one\n// two\n// three\n// four\n// five\nexports.flag = ${flag};\n`;
    f.seed("limit.js", moduleSource(1, false));
    f.seed("limit.test.ts", limitTest(1));
    const older = scope === "adjacent" ? f.addPr(12, "limit.js", moduleSource(1, true))
      : f.addPr(12, "older.txt", "older");
    f.seed("limit.js", moduleSource(2, false));
    f.seed("limit.test.ts", limitTest(2));
    const current = limitTest(2, "test('limit is positive', () => expect(limit > 0).toBe(true));\n");
    const newer = f.addPr(13, "limit.test.ts", current);
    const healthy = f.addPr(14, "healthy.txt", "healthy");
    await f.batch.build(`12@${older},13@${newer},14@${healthy}`);
    const gated = await f.batch.gate();
    expect(gated.rows.map(row => [row.number, row.status, row.detail])).toEqual([[12, "clean", ""], [13, "clean", ""], [14, "clean", ""]]);
    expect(gated.gated!.candidate.prs.map(pr => pr.number)).toEqual([12, 13, 14]);
    expect(gated.attributionLog).toEqual([]);
    // The baseline is native main; candidate samples are the real merge.
    expect(sampled).toEqual([limitTest(2), current]);
    expect(readFileSync(join(gated.work, "limit.test.ts"), "utf8")).toBe(current);
    const landed = await f.batch.land();
    expect(landed.rows.map(row => row.status)).toEqual(["merged", "merged", "merged"]);
    expect(git(f.repo, ["show", "HEAD:limit.test.ts"])).toBe(current.trimEnd());
    expect(git(f.repo, ["show", "HEAD:limit.js"])).toBe(moduleSource(2, scope === "adjacent").trimEnd());
  }, 60_000);
}

test("a main contract update is carried into a reviewed detector without losing its independent added case", async () => {
  const f = landingFixture("green", realTests);
  f.seed("limit.js", "exports.limit = 1;\n");
  f.seed("limit.test.ts", limitTest(1));
  // The PR's own reviewed copy carries its added case and main's old assertion.
  const own = f.addPr(12, "limit.test.ts", limitTest(1, "test('limit is set', () => expect(limit).toBeDefined());\n"));
  f.seed("limit.js", "exports.limit = 2;\n");
  f.seed("limit.test.ts", limitTest(2));
  const healthy = f.addPr(14, "healthy.txt", "healthy");
  await f.batch.build(`12@${own},14@${healthy}`);
  expect(f.batch.read().rows.map(row => row.status)).toEqual(["clean", "clean"]);
  const state = await f.batch.gate();
  expect(state.gated!.tip).toBe(state.tip);
  expect(state.rows.map(row => [row.status, row.detail])).toEqual([["clean", ""], ["clean", ""]]);
  expect(state.attributionLog).toEqual([]);
  expect(state.gated!.adapted).toEqual([{ source: `#12@${own}`, file: "limit.test.ts",
    reason: "main contract update merged with the unchanged reviewed test patch" }]);
  expect(report(state)).toContain("Adapted reviewed detectors:");
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "merged"]);
  expect(git(f.repo, ["show", "HEAD:limit.test.ts"])).toBe(limitTest(2, "test('limit is set', () => expect(limit).toBeDefined());\n").trimEnd());
}, 60_000);

test("a main contract adaptation retains a PR's added regression through removal probes", async () => {
  const f = landingFixture("green", realTests);
  f.seed("limit.js", "exports.limit = 1;\n");
  f.seed("limit.test.ts", limitTest(1));
  const extra = "test('healthy companion', () => expect(require('./companion.js').value).toBe(1));\n";
  f.seed("companion.js", "exports.value = 1;\n");
  const detector = f.addPr(12, "limit.test.ts", limitTest(1, extra));
  f.seed("limit.js", "exports.limit = 2;\n");
  f.seed("limit.test.ts", limitTest(2));
  const bad = f.addPr(13, "companion.js", "exports.value = 0;\n");
  const healthy = f.addPr(14, "healthy.txt", "healthy\n");
  await f.batch.build(`12@${detector},13@${bad},14@${healthy}`);
  const state = await f.batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit", "clean"]);
  expect(state.attributionLog.map(entry => [entry.test.name, entry.prs])).toEqual([["healthy companion", [13]]]);
  expect(state.gated!.adapted).toHaveLength(1);
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "culprit", "merged"]);
  expect(git(f.repo, ["show", "HEAD:limit.test.ts"])).toBe(limitTest(2, extra).trimEnd());
  unchangedCulprit(f, 13, bad);
}, 60_000);

test("a main contract adaptation retains a reviewed strengthening of an existing assertion", async () => {
  const f = landingFixture("green", realTests);
  const companionTest = (assertion: string) => `test('companion', () => expect(require('./companion.js').value${assertion});\n`;
  f.seed("limit.js", "exports.limit = 1;\n");
  f.seed("companion.js", "exports.value = 1;\n");
  f.seed("limit.test.ts", limitTest(1, companionTest(" > 0).toBe(true)")));
  const strengthened = companionTest(").toBe(1)");
  const detector = f.addPr(12, "limit.test.ts", limitTest(1, strengthened));
  f.seed("limit.js", "exports.limit = 2;\n");
  f.seed("limit.test.ts", limitTest(2, companionTest(" > 0).toBe(true)")));
  const bad = f.addPr(13, "companion.js", "exports.value = 2;\n");
  const healthy = f.addPr(14, "healthy.txt", "healthy\n");
  await f.batch.build(`12@${detector},13@${bad},14@${healthy}`);
  const state = await f.batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit", "clean"]);
  expect(state.attributionLog.map(entry => [entry.test.name, entry.prs])).toEqual([["companion", [13]]]);
  expect(state.gated!.adapted).toHaveLength(1);
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "culprit", "merged"]);
  expect(git(f.repo, ["show", "HEAD:limit.test.ts"])).toBe(limitTest(2, strengthened).trimEnd());
  unchangedCulprit(f, 13, bad);
}, 60_000);

test("an overlapping main contract patch is deferred and cannot supersede another member's base copy", async () => {
  const f = landingFixture("green", realTests);
  f.seed("limit.js", "exports.limit = 1;\n");
  f.seed("limit.test.ts", limitTest(1));
  const reviewed = f.addPr(12, "limit.test.ts", limitTest(2));
  f.seed("limit.js", "exports.limit = 3;\n");
  f.seed("limit.test.ts", limitTest(3));
  const healthy = f.addPr(13, "healthy.txt", "healthy\n");
  await f.batch.build(`12@${reviewed},13@${healthy}`);
  // Build defers the conflicting patch; it supplies no replacement authority.
  const state = await f.batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["deferred", "clean"]);
  expect(state.gated!.adapted ?? []).toEqual([]);
  expect(state.gated!.notApplicable.some(entry => entry.reason.includes("superseded"))).toBeFalse();
}, 60_000);
