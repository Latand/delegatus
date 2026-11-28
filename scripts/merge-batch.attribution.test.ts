import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { report, git, MergeBatch, commandRunner, type CommandRunner } from "./merge-batch";
import { extendPr, fixture, landingFixture, realTests, site, unchangedCulprit, installMergeBatchFixtures } from "./merge-batch.fixture";

installMergeBatchFixtures();

test("PR removal keeps the reviewed regression test when its author is healthy", async () => {
  const f = fixture();
  f.seed("adder.js", "exports.add = (a, b) => a + b;\n");
  const source = f.addPr(12, "adder.js", "exports.add = (a, b) => a - b;\n");
  const detector = f.addPr(13, "adder.test.ts", [
    "const { add } = require('./adder');",
    "const { test, expect } = require('bun:test');",
    "test('adds', () => expect(add(5, 3)).toBe(8));",
    "",
  ].join("\n"));
  const runner: CommandRunner = async (cwd, args, env) => {
    if (args[0] === "git" && args[1] === "bisect") {
      return commandRunner(cwd, args, env);
    }
    if (args[2] === "bun" && args[3] === "test") {
      return commandRunner(cwd, args.slice(2), env);
    }
    return { code: 0, output: "" };
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  const built = await batch.build(`12@${source},13@${detector}`);
  const state = await batch.gate();
  expect(state.rows.map((row) => row.status)).toEqual(["culprit", "clean"]);
  expect(state.gated?.tip).toBe(state.tip);
  expect(existsSync(join(state.work, "adder.test.ts"))).toBe(true);
  expect(git(state.work, ["show", `${state.tip}:adder.js`])).toContain("a + b");
  expect(built.gated).toBeNull();
});

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
  await expect(f.batch.land()).rejects.toThrow("Run gate before land");
  expect(f.calls.some(args => args[0] === "pr" && ["create", "merge", "close"].includes(args[1]!))).toBeFalse();
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${state.branch}`])).toBe("");
  expect(git(f.repo, ["rev-parse", "main"])).toBe(main);
  for (const [number, head] of [[12, implementation], [14, detector]] as const) {
    expect(git(f.repo, ["ls-remote", "origin", `refs/heads/topic-${number}`]).split(/\s/)[0]).toBe(head);
  }
}, 30_000);

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
