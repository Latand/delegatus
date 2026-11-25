import { expect, test, afterAll, afterEach, beforeAll } from "bun:test";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { report, git, MergeBatch, commandRunner, type CommandRunner } from "./merge-batch";
import { cleanupBatchFixtures, fixture, isolateBatchGateLocks, landingFixture, realTests, successfulCommand, unchangedCulprit } from "./merge-batch.fixture";

afterEach(cleanupBatchFixtures);
let restoreGateLocks: () => void;
beforeAll(() => { restoreGateLocks = isolateBatchGateLocks(); });
afterAll(() => restoreGateLocks());

for (const mode of ["new file", "added case"] as const) {
  test(`a member's failing ${mode} is omitted and the remainder passes the real attribution gate`, async () => {
    const f = landingFixture("green", realTests);
    const healthyTest = "const { test, expect } = require('bun:test');\ntest('existing case', () => expect(true).toBe(true));\n";
    if (mode === "added case") f.seed("feature.test.ts", healthyTest);
    const bad = f.addPr(12, "feature.test.ts", healthyTest + "test('new failing case', () => expect(false).toBe(true));\n");
    const healthy = f.addPr(13, "healthy.txt", "healthy\n");
    await f.batch.build(`12@${bad},13@${healthy}`);
    const state = await f.batch.gate();
    expect(state.rows.map(row => row.status)).toEqual(["culprit", "clean"]);
    expect(state.attributionLog.map(entry => [entry.test.name, entry.prs, entry.reason]))
      .toEqual([["new failing case", [12], "member-specific: adds the failing test"]]);
    expect(state.gated!.candidate.prs.map(pr => pr.number)).toEqual([13]);
    expect(state.testInventories![0]!.baseline.absent!.some(test => test.name === "new failing case")).toBeTrue();
    expect(report(state)).toContain("member-specific: adds the failing test");
    expect((await f.batch.land()).rows.map(row => row.status)).toEqual(["culprit", "merged"]);
    unchangedCulprit(f, 12, bad);
  }, 60_000);
}

test("a cross-file namesake passing the all-removed control names the implementation culprit", async () => {
  const f = landingFixture("green", realTests);
  f.seed("original.test.ts", "const { test, expect } = require('bun:test');\ntest('shared failure name', () => expect(false).toBe(true));\n");
  f.seed("feature.js", "exports.value = 0;\n");
  const implementation = f.addPr(12, "feature.js", "exports.value = 1;\n");
  const contents = "const { test, expect } = require('bun:test');\ntest('shared failure name', () => expect(require('./feature.js').value).toBe(0));\n";
  const detector = f.addPr(13, "destination.test.ts", contents);
  const built = await f.batch.build(`12@${implementation},13@${detector}`);
  const control = await f.batch["testSubject"](built, ["destination.test.ts"], [12, 13],
    { "destination.test.ts": Buffer.from(contents).toString("base64") });
  expect(control.failures).toEqual([]);
  expect(control.passed.map(site => site.name)).toEqual(["shared failure name"]);
  const state = await f.batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["culprit", "clean"]);
  expect(state.attributionLog.map(entry => [entry.prs, entry.reason])).toEqual([[[12], "test regression"]]);
  const decision = state.testInventories![0]!.decisions[0]!;
  expect(decision.preExisting).toEqual([]);
  expect(decision.attributed[0]!.removals).toEqual([
    { removed: [12], outcome: "pass" }, { removed: [13], outcome: "fail" },
  ]);
  expect(state.gated!.candidate.prs.map(pr => pr.number)).toEqual([13]);
  expect((await f.batch.land()).rows.map(row => row.status)).toEqual(["culprit", "merged"]);
  unchangedCulprit(f, 12, implementation);
}, 60_000);

test("two members adding namesakes both leave the batch while its healthy member lands", async () => {
  const f = landingFixture("green", realTests);
  const header = "const { test, expect } = require('bun:test');\n"
    + "test('first existing case', () => expect(true).toBe(true));\n";
  const gap = Array.from({ length: 12 }, (_, index) => `// unchanged separator ${index}\n`).join("");
  const footer = "test('last existing case', () => expect(true).toBe(true));\n";
  const failure = "test('joint new failing case', () => expect(false).toBe(true));\n";
  f.seed("feature.test.ts", header + gap + footer);
  const first = f.addPr(12, "feature.test.ts", header + failure + gap + footer);
  const second = f.addPr(13, "feature.test.ts", header + gap + failure + footer);
  const healthy = f.addPr(14, "healthy.txt", "healthy\n");
  const built = await f.batch.build(`12@${first},13@${second},14@${healthy}`);
  expect(built.rows.map(row => row.status)).toEqual(["clean", "clean", "clean"]);
  const state = await f.batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["culprit", "culprit", "clean"]);
  expect(state.attributionLog.map(entry => [entry.test.occurrence, entry.prs, entry.reason])).toEqual([
    [0, [12, 13], "member-specific: adds the failing test"],
    [1, [12, 13], "member-specific: adds the failing test"],
  ]);
  expect(state.gated!.candidate.prs.map(pr => pr.number)).toEqual([14]);
  expect(f.batch.read().testInventories![0]!.decisions[0]!.attributed).toHaveLength(2);
  expect((await f.batch.land()).rows.map(row => row.status)).toEqual(["culprit", "culprit", "merged"]);
  unchangedCulprit(f, 12, first);
  unchangedCulprit(f, 13, second);
}, 60_000);

test("a filtered-only native namesake cannot exempt a member's new failing file", async () => {
  const f = landingFixture("green", realTests);
  f.seed("original.test.ts", "const { test, expect } = require('bun:test');\n"
    + "let prepared = false;\n"
    + "test('prepare native state', () => { prepared = true; });\n"
    + "test.each([1])('expanded native %i', () => expect(prepared).toBe(true));\n");
  const contents = "const { test, expect } = require('bun:test');\n"
    + "test('expanded native 1', () => expect(false).toBe(true));\n";
  const bad = f.addPr(12, "destination.test.ts", contents);
  const healthy = f.addPr(13, "healthy.txt", "healthy\n");
  const built = await f.batch.build(`12@${bad},13@${healthy}`);
  const native = await f.batch["testSubject"](built, ["original.test.ts"]);
  expect(native.failures).toEqual([]);
  expect(native.passed.map(test => test.name)).toEqual(["prepare native state", "expanded native 1"]);
  const filtered = await f.batch["testSubject"](built, ["original.test.ts"], undefined, false,
    { sites: [], names: ["expanded native 1"] });
  expect(filtered.failures.map(test => test.name)).toEqual(["expanded native 1"]);
  const control = await f.batch["testSubject"](built, ["destination.test.ts"], [12, 13],
    { "destination.test.ts": Buffer.from(contents).toString("base64") });
  expect(control.failures.map(test => test.name)).toEqual(["expanded native 1"]);

  const state = await f.batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["culprit", "clean"]);
  expect(state.attributionLog.map(entry => [entry.test.name, entry.prs, entry.reason]))
    .toEqual([["expanded native 1", [12], "member-specific: adds the failing test"]]);
  const first = state.testInventories![0]!;
  expect(first.baseline.failures).toEqual([]);
  expect(first.baseline.passed.map(test => [test.file, test.name])).toContainEqual(["original.test.ts", "expanded native 1"]);
  expect(first.baseline.completed).toContain("original.test.ts");
  expect(first.decisions[0]!.preExisting).toEqual([]);
  expect(f.batch.read().testInventories![0]!.decisions).toEqual(first.decisions);
  expect(state.gated!.candidate.prs.map(pr => pr.number)).toEqual([13]);
  expect((await f.batch.land()).rows.map(row => row.status)).toEqual(["culprit", "merged"]);
  unchangedCulprit(f, 12, bad);
}, 60_000);

for (const mode of ["literal copy", "parameterized move", "parameterized copy"] as const) test(`a moved native failure appears in the receipt and batch body: ${mode}`, async () => {
  const f = landingFixture("green", realTests);
  const parameterized = mode !== "literal copy";
  const name = parameterized ? "parameterized 1" : "moved native failure";
  const contents = "const { test, expect } = require('bun:test');\n"
    + (parameterized ? "test.each([1])('parameterized %i', () => expect(false).toBe(true));\n"
      : "test('moved native failure', () => expect(false).toBe(true));\n");
  f.seed("original.test.ts", contents);
  const added = f.addPr(12, "destination.test.ts", contents);
  // Keep the copy case as well as a true rename whose runtime name is absent
  // from source. Both use native registrations rather than source parsing.
  const moved = mode === "parameterized move" ? extendPr(f, 12, { "original.test.ts": null }) : added;
  const healthy = f.addPr(13, "healthy.txt", "healthy\n");
  const built = await f.batch.build(`12@${moved},13@${healthy}`);
  const main = await f.batch["testSubject"](built, ["original.test.ts"]);
  expect(main.failures.map(site => site.name)).toEqual([name]);
  const state = await f.batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "clean"]);
  const first = state.testInventories![0]!;
  expect(first.baseline.failures.map(test => [test.file, test.name])).toContainEqual(["original.test.ts", name]);
  expect(first.baseline.registered!.map(test => [test.file, test.name])).toContainEqual(["original.test.ts", name]);
  expect(first.decisions[0]!.preExisting.map(test => [test.file, test.name])).toEqual([["destination.test.ts", name]]);
  expect(state.attributionLog).toEqual([]);
  expect(f.batch.read().testInventories![0]!.decisions[0]!.preExisting).toEqual(first.decisions[0]!.preExisting);
  expect(report(state)).toContain(`Pre-existing failures (permitted):\n- destination.test.ts >  > ${name}`);
  expect(f.batch["body"](state)).toContain(`Pre-existing failures (permitted):\n- destination.test.ts >  > ${name}`);
  expect((await f.batch.land()).rows.map(row => row.status)).toEqual(["merged", "merged"]);
}, 60_000);

test("a Bun preload retains a literal detector and refuses publication without proven attribution", async () => {
  const f = landingFixture("green", realTests);
  f.seed("bunfig.toml", '[test]\npreload = ["./hook.ts"]\n');
  f.seed("hook.ts", "const { beforeEach, expect } = require('bun:test');\n"
    + "const fs = require('node:fs');\n"
    + "beforeEach(() => expect(fs.existsSync('feature.js') ? require('./feature.js').value : undefined).toBe(1));\n");
  f.seed("feature.js", "exports.value = 1;\n");
  f.seed("feature.test.ts", "const { test, expect } = require('bun:test');\ntest('feature invariant', () => expect(1).toBe(1));\n");
  const main = git(f.repo, ["rev-parse", "main"]);
  const implementation = f.addPr(12, "feature.js", "exports.value = 2;\n");
  const contents = "const { test, expect } = require('bun:test');\ntest('feature invariant', () => expect(require('./feature.js').value).toBe(2));\n";
  const detector = f.addPr(14, "feature.test.ts", contents);
  await f.batch.build(`12@${implementation},14@${detector}`);
  await expect(f.batch.gate()).rejects.toThrow(/Cannot establish attribution for feature\.test\.ts > .* > feature invariant; detectors retained; batch not gated \(rule: no removal clears it/);
  const state = f.batch.read();
  expect(state.testInventories).toHaveLength(1);
  expect(state.testInventories![0]!.baseline.passed.map(test => test.name)).toEqual(["feature invariant"]);
  expect(state.testInventories![0]!.decisions).toHaveLength(1);
  expect(state.testInventories![0]!.decisions[0]!.unattributed!.map(entry => entry.test.name)).toEqual(["feature invariant"]);
  expect(report(state)).toContain("Unattributed failures (batch refused):");
  expect(state.testInventories![0]!.refusal).toContain("Cannot establish attribution");
  expect(state.gated).toBeNull();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "clean"]);
  expect(state.attributionLog).toHaveLength(0);
  expect(readFileSync(join(state.work, "feature.test.ts"), "utf8")).toBe(contents);
  expect(git(state.work, ["show", `${detector}:feature.test.ts`])).toBe(contents.trimEnd());
  const retained = await commandRunner(state.work, [process.execPath, "test", "./feature.test.ts"]);
  expect(retained.code).toBe(1);
  expect(retained.output).toContain("(fail) feature invariant");
  expect(f.calls.some(args => args[0] === "pr" && ["create", "merge", "close"].includes(args[1]!))).toBeFalse();
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${state.branch}`])).toBe("");
  expect(git(f.repo, ["rev-parse", "main"])).toBe(main);
  for (const [number, head] of [[12, implementation], [14, detector]] as const) {
    expect(git(f.repo, ["ls-remote", "origin", `refs/heads/topic-${number}`]).split(/\s/)[0]).toBe(head);
  }
}, 30_000);

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

function extendPr(f: ReturnType<typeof fixture>, number: number, changes: Record<string, string | null>): string {
  git(f.repo, ["checkout", `topic-${number}`]);
  for (const [file, contents] of Object.entries(changes)) {
    if (contents === null) rmSync(join(f.repo, file));
    else writeFileSync(join(f.repo, file), contents);
  }
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Complete reviewed patch"]);
  const head = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "origin", `${head}:refs/pull/${number}/head`, `${head}:refs/heads/topic-${number}`]);
  f.views.get(number)!.headRefOid = head;
  git(f.repo, ["checkout", "main"]);
  return head;
}

async function reviewedDetectorsGreen(f: ReturnType<typeof landingFixture>, heads: string[]) {
  const seen = new Set<string>();
  for (const head of ["HEAD", ...heads]) {
    const files = git(f.repo, ["ls-tree", "-r", "--name-only", head]).split("\n").filter(file => /\.test\.ts$/.test(file));
    for (const file of files) {
      const contents = git(f.repo, ["show", `${head}:${file}`]);
      const key = JSON.stringify([file, contents]);
      if (seen.has(key)) continue;
      seen.add(key);
      const path = join(f.repo, file), original = existsSync(path) ? readFileSync(path) : undefined;
      try {
        writeFileSync(path, contents);
        const result = await commandRunner(f.repo, [process.execPath, "test", `./${file}`], {
          ...process.env, LLV_STATE_DIR: join(f.root, "landed-check-state"),
        });
        expect(result.output).not.toContain("(fail)");
        expect(result.code).toBe(0);
      } finally {
        if (original) writeFileSync(path, original);
        else rmSync(path);
      }
    }
  }
  expect(git(f.repo, ["status", "--porcelain"])).toBe("");
}

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
  const run: CommandRunner = async (cwd, args, env) => {
    if (args[3] === "test" && cwd === f.batch.read().work && !refreshed) {
      refreshed = true;
      f.seed("main.txt", "advanced");
      f.views.get(12)!.headRefOid = f.base;
    }
    return realTests(cwd, args, env);
  };
  const batch = new MergeBatch(f.repo, f.batch.stateFile, run, f.batch.gh, async () => {});
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
  const run: CommandRunner = async (cwd, args, env) => {
    if (args[3] === "test" && cwd === f.batch.read().work && !refreshed) {
      refreshed = true;
      git(f.repo, ["merge", "--ff-only", detector]);
      rmSync(join(f.repo, "reviewed.test.ts"));
      f.seed("config.js", "exports.adjust = x => x;\n");
      f.views.get(12)!.isDraft = true;
    }
    return realTests(cwd, args, env);
  };
  const batch = new MergeBatch(f.repo, f.batch.stateFile, run, f.batch.gh, async () => {});
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

test("a receipt for another tuple has no bearing on landing the healthy built tip", async () => {
  const f = landingFixture("green");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  await f.batch.build(`12@${healthy}`);
  const state = await f.batch.gate();
  state.gated!.candidate.prs[0]!.head = state.base;
  f.batch.save(state);
  expect((await f.batch.land()).rows[0]!.status).toBe("merged");
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
