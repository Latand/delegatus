import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { candidateOf, commandRunner, git, report, type Candidate } from "./merge-batch";
import { MergeBatch, extendPr, landingFixture, realTests, reviewedDetectorsGreen, successfulCommand, testResult, unchangedCulprit, registerMergeBatchFixtures } from "./merge-batch.fixture";

registerMergeBatchFixtures();

const limitTest = (expected: number, extra = "") => "const { test, expect } = require('bun:test');\n"
  + `const { limit } = require('./limit.js');\ntest('limit', () => expect(limit).toBe(${expected}));\n// one\n// two\n// three\n${extra}`;

for (const order of [[12, 13], [13, 12]]) test(`reviewed contract replacement leaves unrelated PR copies out in order ${order}`, async () => {
  const f = landingFixture("green", realTests);
  const chipTest = (label: string) => "const { test, expect } = require('bun:test');\n"
    + `test('chip label', () => expect(require('./chip.js').label).toBe('${label}'));\n`;
  f.seed("chip.js", "exports.label = 'hourly';\n");
  f.seed("chip.test.tsx", chipTest("hourly"));
  f.addPr(12, "chip.js", "exports.label = 'switch';\n");
  const replacement = extendPr(f, 12, { "chip.test.tsx": chipTest("switch") });
  const unrelated = f.addPr(13, "unrelated.txt", "unrelated\n");
  const heads = new Map([[12, replacement], [13, unrelated]]);
  await f.batch.build(order.map(number => `${number}@${heads.get(number)}`).join(","));
  const gated = await f.batch.gate();
  expect(gated.rows.map(row => row.status)).toEqual(["clean", "clean"]);
  expect(gated.gated!.candidate.prs).toEqual(order.map(number => ({ number, head: heads.get(number)! })));
  expect(gated.gated!.tip).toBe(gated.tip);
  expect(gated.gated!.notApplicable).toEqual([]);
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "merged"]);
  expect(git(f.repo, ["show", "HEAD:chip.test.tsx"])).toBe(chipTest("switch").trimEnd());
}, 60_000);

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

test("round 1 landing confirms a newly discovered failure before publishing a fresh remainder", async () => {
  let runs = 0;
  const f = landingFixture("green", async (cwd, args, env) => {
    if (args[2] === "bun" && args[3] === "test") {
      const bad = existsSync(join(cwd, "check.js"));
      return realTests(cwd, args, { ...(env ?? process.env), SAMPLE: bad && ++runs === 1 ? "first" : "later" });
    }
    return successfulCommand(args);
  });
  f.seed("check.test.ts", "const { test, expect } = require('bun:test');\nconst fs = require('node:fs');\n"
    + "test('initial intermittent', () => expect(process.env.SAMPLE).not.toBe('first'));\n"
    // A skipped initial observation keeps this an attribution case; a pass would make it intermittent.
    + "test.skipIf(process.env.SAMPLE === 'first')('later regression', () => expect(fs.existsSync('check.js')).toBe(false));\n");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const bad = f.addPr(13, "check.js", "regression");
  await f.batch.build(`12@${healthy},13@${bad}`);
  await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map(row => row.status)).toEqual(["merged", "culprit"]);
  expect(state.attributionLog[0]!.test.name).toBe("later regression");
  expect(state.attributionLog[0]!.confirmation).toEqual(["fail", "fail", "fail"]);
  unchangedCulprit(f, 13, bad);
  await reviewedDetectorsGreen(f, [healthy, bad]);
}, 30_000);

test("round 2 landing retains a healthy new feature detector through native absence probes", async () => {
  const f = landingFixture("green", realTests);
  f.seed("config.js", "exports.factor = 2;\n");
  const feature = f.addPr(12, "feature.js", "const { factor } = require('./config.js');\nexports.double = x => x * factor;\n");
  const bad = f.addPr(13, "config.js", "exports.factor = 3;\n");
  const detector = f.addPr(14, "feature.test.ts", "const { test, expect } = require('bun:test');\n"
    + "const fs = require('node:fs');\nconst double = fs.existsSync('feature.js') ? require('./feature.js').double : undefined;\n"
    + "test('double', () => expect(double?.(2)).toBe(4));\n");
  const healthy = f.addPr(15, "healthy.txt", "healthy");
  await f.batch.build(`12@${feature},13@${bad},14@${detector},15@${healthy}`);
  await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map(row => row.status)).toEqual(["merged", "culprit", "merged", "merged"]);
  unchangedCulprit(f, 13, bad);
  expect(git(f.repo, ["log", "--reverse", "--format=%s", `${state.base}..HEAD`]).split("\n"))
    .toEqual(["Feature 12 (#12)", "Feature 14 (#14)", "Feature 15 (#15)"]);
  await reviewedDetectorsGreen(f, [feature, bad, detector, healthy]);
}, 30_000);

test("(b) round 4 main refresh skips a withheld PR's reviewed detector with a note and lands the rest", async () => {
  const f = landingFixture("green", realTests);
  f.seed("config.js", "exports.adjust = x => x;\n");
  f.seed("b.js", "const { adjust } = require('./config.js');\nexports.value = adjust(1);\n");
  f.addPr(12, "config.js", "exports.adjust = x => x / 2;\n");
  const detector = extendPr(f, 12, { "b.test.ts": "const { test, expect } = require('bun:test');\nconst b = require('./b.js');\ntest('B', () => expect(b.value).toBe(1));\n" });
  const bad = f.addPr(13, "b.js", "const { adjust } = require('./config.js');\nexports.value = adjust(2);\n");
  const healthy = f.addPr(14, "healthy.txt", "healthy");
  let refreshed = false;
  const gh = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "view" && args[2] === "99" && !refreshed) {
      refreshed = true;
      f.seed("main.txt", "advanced");
      f.views.get(12)!.headRefOid = f.base;
      return JSON.stringify({ state: "OPEN", headRefOid: batch.read().tip, mergeStateStatus: "BEHIND" });
    }
    if (args[0] === "pr" && args[1] === "edit") {
      const state = batch.read();
      expect(state.gated!.candidate.prs.map(pr => pr.number)).toEqual([13, 14]);
      expect(state.gated!.notApplicable).toEqual([{ source: `#12@${detector}`, file: "b.test.ts",
        reason: "#12 is not in this candidate; its reviewed detector is skipped" }]);
    }
    return f.batch.gh(args);
  };
  const batch = new MergeBatch(f.repo, f.batch.stateFile, realTests, gh, async () => {});
  await batch.build(`12@${detector},13@${bad},14@${healthy}`);
  await batch.gate();
  const state = await batch.land();
  expect(state.rows.map(row => row.status)).toEqual(["head-moved", "merged", "merged"]);
  expect(state.rows[0]!.head).toBe(detector);
  expect(state.attributionLog).toEqual([]);
  expect(report(state)).toContain(`Skipped test files:\n- #12@${detector}: b.test.ts: #12 is not in this candidate`);
}, 30_000);

test("reviewed patch scope survives main incorporating and then deleting its detector", async () => {
  const f = landingFixture("green", realTests);
  f.seed("config.js", "exports.adjust = x => x;\n");
  f.seed("b.js", "const { adjust } = require('./config.js');\nexports.value = adjust(1);\n");
  f.addPr(12, "config.js", "exports.adjust = x => x / 2;\n");
  const detector = extendPr(f, 12, { "reviewed.test.ts": "const { test, expect } = require('bun:test');\n"
    + "const b = require('./b.js');\ntest('B', () => expect(b.value).toBe(1));\n" });
  const bad = f.addPr(13, "b.js", "const { adjust } = require('./config.js');\nexports.value = adjust(2);\n");
  const healthy = f.addPr(14, "healthy.txt", "healthy");
  let refreshed = false;
  const gh = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "view" && args[2] === "99" && !refreshed) {
      refreshed = true;
      git(f.repo, ["merge", "--ff-only", detector]);
      rmSync(join(f.repo, "reviewed.test.ts"));
      f.seed("config.js", "exports.adjust = x => x;\n");
      f.views.get(12)!.isDraft = true;
      return JSON.stringify({ state: "OPEN", headRefOid: batch.read().tip, mergeStateStatus: "BEHIND" });
    }
    return f.batch.gh(args);
  };
  const batch = new MergeBatch(f.repo, f.batch.stateFile, realTests, gh, async () => {});
  await batch.build(`12@${detector},13@${bad},14@${healthy}`);
  const originalBase = batch.read().rows[0]!.reviewBase;
  await batch.gate();
  const state = await batch.land();
  // The withheld PR's detector stays in scope and is named as skipped.
  expect(state.rows.map(row => row.status)).toEqual(["head-moved", "merged", "merged"]);
  expect(state.rows[0]!.reviewBase).toBe(originalBase);
  expect(git(f.repo, ["merge-base", state.base, detector])).toBe(detector);
  expect(state.gated!.notApplicable.map(entry => [entry.source, entry.file])).toEqual([[`#12@${detector}`, "reviewed.test.ts"]]);
}, 30_000);

test("random event sequences publish only a validated membership at its latest carried tip", async () => {
  const totals = { culprit: 0, main: 0, head: 0, publications: 0, validations: 0 };
  for (let seed = 1; seed <= 12; seed++) {
    let randomState = seed;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState; };
    const events: ("culprit" | "main" | "head" | "none")[] = ["culprit", "main", "head", "main", "none", "none"];
    for (let index = events.length - 1; index > 0; index--) {
      const other = random() % (index + 1);
      [events[index], events[other]] = [events[other]!, events[index]!];
    }
    let failureFound = false, mainMoves = 0;
    let lastFullyValidated: Candidate | undefined;
    const f = landingFixture("green", async (cwd, args) => {
      const state = batch.read();
      if (cwd === state.work || args.includes("--paths")) event();
      if (args[2] === "bun" && args[3] === "test") {
        const fails = failureFound && existsSync(join(cwd, "property.js"));
        return testResult("property.test.ts", fails ? ["regression"] : [], fails ? [] : ["regression"]);
      }
      return successfulCommand(args);
    });
    f.seed("property.test.ts", "synthetic detector");
    const healthy = f.addPr(12, "healthy.txt", "healthy");
    const moving = f.addPr(13, "moving.txt", "moving");
    const bad = f.addPr(14, "property.js", "bad");
    const event = () => {
      const next = events.shift();
      if (next === "main") { f.seed(`advance-${++mainMoves}.txt`, "main advanced"); totals.main++; }
      if (next === "head") { f.views.get(13)!.headRefOid = f.base; totals.head++; }
      if (next === "culprit") { failureFound = true; totals.culprit++; }
    };
    const gh = async (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "view" && args[2] === "99" && events.length) {
        event();
        return JSON.stringify({ state: "OPEN", headRefOid: batch.read().tip, mergeStateStatus: "BEHIND" });
      }
      if (args[0] === "pr" && ["create", "edit", "merge"].includes(args[1]!) && !args.includes("--help")) {
        const state = batch.read(), published = candidateOf(state);
        expect(published.prs).toEqual(lastFullyValidated!.prs);
        expect(state.gated!.candidate).toEqual(lastFullyValidated!);
        expect(state.gated!.carried?.at(-1) ?? { main: state.gated!.candidate.main, tip: state.gated!.tip })
          .toMatchObject({ main: published.main, tip: state.tip });
        expect(published.main).toBe(git(f.repo, ["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0]!);
        for (const pr of published.prs) expect(f.views.get(pr.number)!.headRefOid).toBe(pr.head);
        expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${state.branch}`]).split(/\s/)[0]).toBe(state.tip);
        totals.publications++;
      }
      return f.batch.gh(args);
    };
    class ObservedBatch extends MergeBatch {
      override async gate() {
        const state = await super.gate();
        lastFullyValidated = structuredClone(state.gated!.candidate);
        totals.validations++;
        return state;
      }
    }
    const batch = new ObservedBatch(f.repo, f.batch.stateFile, f.batch.run, gh, async () => {});
    await batch.build(`12@${healthy},13@${moving},14@${bad}`);
    await batch.gate();
    const state = await batch.land();
    expect(events).toEqual([]);
    expect(state.rows.map(row => row.status)).toEqual(["merged", "head-moved", "culprit"]);
    unchangedCulprit(f, 14, bad);
  }
  expect(totals.culprit).toBe(12); expect(totals.main).toBe(24); expect(totals.head).toBe(12);
  expect(totals.publications).toBeGreaterThanOrEqual(24);
  expect(totals.validations).toBeGreaterThanOrEqual(12);
}, 120_000);

test("(b) a withheld reviewed detector with a missing module is skipped with a note", async () => {
  let moved = false;
  const f = landingFixture("green", async (cwd, args, env) => {
    if (!moved && args[2] === "bun" && args[3] === "test") {
      moved = true; f.views.get(12)!.headRefOid = f.base;
    }
    return realTests(cwd, args, env);
  });
  f.addPr(12, "feature.js", "exports.value = 1;\n");
  const reviewed = extendPr(f, 12, { "feature.test.ts": "const { test, expect } = require('bun:test');\n"
    + "const feature = require('./feature.js');\ntest('feature', () => expect(feature.value).toBe(1));\n" });
  const healthy = f.addPr(13, "healthy.txt", "healthy");
  await f.batch.build(`12@${reviewed},13@${healthy}`);
  const gated = await f.batch.gate();
  expect(gated.gated!.notApplicable).toEqual([{ source: `#12@${reviewed}`, file: "feature.test.ts",
    reason: "#12 is not in this candidate; its reviewed detector is skipped" }]);
  expect(report(gated)).toContain("Skipped test files:");
  const state = await f.batch.land();
  expect(state.rows.map(row => row.status)).toEqual(["head-moved", "merged"]);
  expect(state.rows[0]!.head).toBe(reviewed);
}, 30_000);

for (const fault of ["package", "runtime", "export"] as const) {
  test(`(b) a withheld detector's ${fault} load error is skipped with a note and the healthy PR lands`, async () => {
    const f = landingFixture("green", realTests);
    f.seed("feature.js", "exports.present = 1;\n");
    const contents = "const { test, expect } = require('bun:test');\n"
      + (fault === "package" ? "require('fixture-package-that-does-not-exist');\n"
        : fault === "runtime" ? "throw new Error('fixture runtime error');\n"
          : "const { absent } = require('./feature.js');\nif (!absent) throw new Error('export absent from the candidate');\n")
      + "test('fixture', () => expect(1).toBe(1));\n";
    const detector = f.addPr(12, "fault.test.ts", contents);
    const healthy = f.addPr(13, "healthy.txt", "healthy");
    f.views.get(12)!.isDraft = true;
    await f.batch.build(`12@${detector},13@${healthy}`);
    const gated = await f.batch.gate();
    expect(gated.gated!.notApplicable).toEqual([{ source: `#12@${detector}`, file: "fault.test.ts",
      reason: "#12 is not in this candidate; its reviewed detector is skipped" }]);
    const state = await f.batch.land();
    expect(state.rows.map(row => row.status)).toEqual(["head-moved", "merged"]);
  }, 30_000);
}

test("a receipt for another tuple cannot publish even when the built tip matches", async () => {
  const f = landingFixture("green");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  await f.batch.build(`12@${healthy}`);
  const state = await f.batch.gate();
  state.gated!.candidate.prs[0]!.head = state.base;
  f.batch.save(state);
  await expect(f.batch.land()).rejects.toThrow("exact candidate has not completed full validation");
  expect(f.calls.some(args => args[0] === "pr" && ["create", "merge"].includes(args[1]!))).toBeFalse();
}, 30_000);

test("(c) a retained PR deleting a module a native test loads is the only culprit; the rest lands", async () => {
  const f = landingFixture("green", realTests);
  f.seed("feature.js", "exports.value = 1;\n");
  f.seed("feature.test.ts", "const { test, expect } = require('bun:test');\n"
    + "const feature = require('./feature.js');\ntest('feature', () => expect(feature.value).toBe(1));\n");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const deletion = f.addPr(13, "other.txt", "other");
  extendPr(f, 13, { "feature.js": null });
  const head = f.views.get(13)!.headRefOid as string;
  await f.batch.build(`12@${healthy},13@${head}`);
  const gated = await f.batch.gate();
  expect(gated.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
  expect(gated.attributionLog.map(entry => [entry.test.kind, entry.test.file, entry.prs])).toEqual([["error", "feature.test.ts", [13]]]);
  const state = await f.batch.land();
  expect(state.rows.map(row => row.status)).toEqual(["merged", "culprit"]);
  expect(deletion).not.toBe(head);
  unchangedCulprit(f, 13, head);
}, 30_000);

test("a scoped batch lands in order despite an unrelated test load error on main", async () => {
  const sampled: string[] = [];
  const f = landingFixture("green", async (cwd, args, env) => {
    if (args[2] === "bun" && args[3] === "test") sampled.push(args[4]!);
    return realTests(cwd, args, env);
  });
  f.seed("unrelated.test.ts", "throw new Error('unrelated fixture load error');\n");
  f.seed("healthy.test.ts", "const { test, expect } = require('bun:test');\ntest('healthy', () => expect(1).toBe(1));\n");
  const first = f.addPr(12, "healthy.test.ts", readFileSync(join(f.repo, "healthy.test.ts"), "utf8") + "// reviewed detector\n");
  const second = f.addPr(13, "healthy.js", "exports.healthy = true;\n");
  await f.batch.build(`12@${first},13@${second}`);
  await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map(row => row.status)).toEqual(["merged", "merged"]);
  expect(git(f.repo, ["log", "--reverse", "--format=%s", `${state.base}..HEAD`]).split("\n"))
    .toEqual(["Feature 12 (#12)", "Feature 13 (#13)"]);
  expect(sampled.length).toBeGreaterThan(0);
  expect(new Set(sampled)).toEqual(new Set(["./healthy.test.ts"]));
  expect((await commandRunner(f.repo, [process.execPath, "test", "./healthy.test.ts"])).code).toBe(0);
}, 30_000);
