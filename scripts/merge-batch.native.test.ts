import { expect, test, afterAll, afterEach, beforeAll } from "bun:test";
import { writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { report, fileFault, INCOMPLETE_FILE, git, MAX_REQUIRED_CHECK_POLLS, commandRunner } from "./merge-batch";
import { cleanupBatchFixtures, fixture, isolateBatchGateLocks, landingFixture, reviewedDetectorsGreen, successfulCommand, testResult, unchangedCulprit } from "./merge-batch.fixture";

afterEach(cleanupBatchFixtures);
let restoreGateLocks: () => void;
beforeAll(() => { restoreGateLocks = isolateBatchGateLocks(); });
afterAll(() => restoreGateLocks());

test("one run lands healthy PRs in order and reports the unchanged culprit with test evidence", async () => {
  const f = landingFixture("green", undefined, fixture => {
    fixture.seed("check.test.ts", "native baseline");
    return async (cwd, args) => {
      if (args[2] === "bun" && args[3] === "test") {
        return testResult("check.test.ts", existsSync(join(cwd, "bad.txt")) ? ["regression", "pre-existing"] : ["pre-existing"],
          existsSync(join(cwd, "bad.txt")) ? [] : ["regression"]);
      }
      return successfulCommand(args);
    };
  });
  const a = f.addPr(12, "check.test.ts", "candidate regression coverage");
  const bad = f.addPr(13, "bad.txt", "bad");
  const c = f.addPr(14, "healthy.txt", "healthy");
  await f.batch.build(`12@${a},13@${bad},14@${c}`);
  await f.batch.gate();
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "culprit", "merged"]);
  expect(git(f.repo, ["log", "--reverse", "--format=%s", `${landed.base}..HEAD`]).split("\n")).toEqual(["Feature 12 (#12)", "Feature 14 (#14)"]);
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(bad);
  const summary = report(landed);
  expect(summary).toContain(`| #12 | merged ${landed.rows[0]!.commit} |`);
  expect(summary).toContain("#13 | culprit test regression: check.test.ts > suite > regression");
  expect(summary).toContain("Pre-existing failures (permitted):\n- check.test.ts > suite > pre-existing");
  expect(summary).toContain("confirmations fail, fail, fail; without #12: fail; without #13: pass; without #14: fail");
});

for (const restored of ["assertion", "file"] as const) {
  test(`round 3 removal restores a native ${restored} and withholds both regressions before landing`, async () => {
    const f = landingFixture("green", async (cwd, args, env) => args[2] === "bun" && args[3] === "test"
      ? commandRunner(cwd, args.slice(2), env) : successfulCommand(args));
    f.seed("a.js", "exports.value = 1;\n");
    f.seed("b.js", "exports.value = 1;\n");
    const aTest = "const { test, expect } = require('bun:test');\nconst a = require('./a.js');\ntest('A', () => expect(a.value).toBe(1));\n";
    const bTest = "const b = require('./b.js');\ntest('B', () => expect(b.value).toBe(1));\n";
    const firstTestFile = restored === "assertion" ? "check.test.ts" : "a.test.ts";
    f.seed(firstTestFile, restored === "assertion" ? aTest + bTest : aTest);
    if (restored === "file") f.seed("restored.test.ts", "const { test, expect } = require('bun:test');\n" + bTest);
    f.addPr(12, "a.js", "exports.value = 2;\n");
    git(f.repo, ["checkout", "topic-12"]);
    if (restored === "assertion") writeFileSync(join(f.repo, "check.test.ts"), aTest);
    else rmSync(join(f.repo, "restored.test.ts"));
    git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Remove second detector"]);
    const first = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "origin", `${first}:refs/pull/12/head`, `${first}:refs/heads/topic-12`]);
    f.views.get(12)!.headRefOid = first;
    git(f.repo, ["checkout", "main"]);
    const second = f.addPr(13, "b.js", "exports.value = 2;\n");
    const healthy = f.addPr(14, "healthy.txt", "healthy");
    await f.batch.build(`12@${first},13@${second},14@${healthy}`);
    const gated = await f.batch.gate();
    expect(gated.rows.map(row => row.status)).toEqual(["culprit", "culprit", "clean"]);
    const evidence = gated.attributionLog.find(entry => entry.test.name === "B")!;
    expect(evidence.prs).toEqual([13]);
    expect(evidence.confirmation).toEqual(["fail", "fail", "fail"]);
    expect(evidence.removals.find(sample => sample.removed.join() === "13")!.outcome).toBe("pass");
    const landed = await f.batch.land();
    expect(landed.rows.map(row => row.status)).toEqual(["culprit", "culprit", "merged"]);
    expect(git(f.repo, ["log", "--format=%s", `${landed.base}..HEAD`])).toBe("Feature 14 (#14)");
    for (const [number, head] of [[12, first], [13, second]] as const) {
      expect(landed.rows.find(row => row.number === number)!.head).toBe(head);
      expect(git(f.repo, ["ls-remote", "origin", `refs/heads/topic-${number}`]).split(/\s/)[0]).toBe(head);
    }
    const native = await commandRunner(f.repo, [process.execPath, "test", `./${firstTestFile}`, ...(restored === "file" ? ["./restored.test.ts"] : [])]);
    expect(native.code).toBe(0);
    expect(native.output).toContain("2 pass");
    expect(report(landed)).toContain("#13 | culprit test regression");
    await reviewedDetectorsGreen(f, [first, second, healthy]);
  }, 30_000);
}

for (const outcome of ["regression", "pre-existing", "between-test error"] as const) {
  test(`a non-test culprit restores the only selected native file and preserves its ${outcome} verdict`, async () => {
    const f = landingFixture("green", async (cwd, args, env) => {
      if (args[0] === "git" && args[1] === "bisect") {
        // Supply recorded non-test attribution; the native test samples below
        // still use real Git subjects and Bun, with no forge outside the fixture.
        const state = f.batch.read();
        git(cwd, ["update-ref", "refs/bisect/bad", state.rows[0]!.commit]);
        return { code: 0, output: "" };
      }
      if (args[2] === "bun" && args[3] === "test") return commandRunner(cwd, args.slice(2), env);
      if (args.some(arg => arg.endsWith("/eslint-changes.ts")) && existsSync(join(cwd, "bad.js"))) return { code: 1, output: "fixture lint regression" };
      return successfulCommand(args);
    });
    f.seed("b.js", `exports.value = ${outcome === "pre-existing" ? 2 : 1};\n`);
    const contents = "const { test, expect } = require('bun:test');\nconst b = require('./b.js');\ntest('B', () => expect(b.value).toBe(1));\n"
      + (outcome === "between-test error" ? "if (b.value === 2) throw new Error('restored fixture error');\n" : "");
    f.seed("b.test.ts", contents);
    f.addPr(12, "bad.js", "exports.fixture = true;\n");
    git(f.repo, ["checkout", "topic-12"]);
    rmSync(join(f.repo, "b.test.ts"));
    git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Remove sole detector"]);
    const first = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "origin", `${first}:refs/pull/12/head`, `${first}:refs/heads/topic-12`]);
    f.views.get(12)!.headRefOid = first;
    git(f.repo, ["checkout", "main"]);
    const second = f.addPr(13, "b.js", `exports.value = ${outcome === "pre-existing" ? 3 : 2};\n`);
    const healthy = f.addPr(14, "healthy.txt", "healthy");
    await f.batch.build(`12@${first},13@${second},14@${healthy}`);
    // A file fault main does not produce is a newly broken case: it is
    // confirmed and drops only the PR whose removal clears it.
    const gated = await f.batch.gate();
    expect(gated.gated?.candidate.main).toBe(gated.base);
    if (outcome === "pre-existing") {
      expect(gated.rows.map(row => row.status)).toEqual(["culprit", "clean", "clean"]);
      expect(report(gated)).toContain("Pre-existing failures (permitted):\n- b.test.ts");
      expect(gated.attributionLog).toHaveLength(0);
    } else {
      expect(gated.rows.map(row => row.status)).toEqual(["culprit", "culprit", "clean"]);
      expect(gated.attributionLog[0]!.confirmation).toEqual(["fail", "fail", "fail"]);
    }
    const landed = await f.batch.land();
    expect(landed.rows[2]!.status).toBe("merged");
    expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-12"]).split(/\s/)[0]).toBe(first);
    if (outcome !== "pre-existing") expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(second);
  }, 30_000);
}

for (const mode of ["green", "behind"] as const) {
  test(`native selection retains a deleted test path after a reviewed head moves (${mode})`, async () => {
    let moved = false;
    const f = landingFixture(mode, async (cwd, args, env) => {
      if (args[2] === "bun" && args[3] === "test") {
        if (!moved && readFileSync(join(cwd, "a.js"), "utf8").includes("2")) {
          moved = true;
          f.views.get(12)!.headRefOid = f.base;
        }
        return commandRunner(cwd, args.slice(2), env);
      }
      return successfulCommand(args);
    });
    f.seed("a.js", "exports.value = 1;\n");
    f.seed("b.js", "exports.value = 1;\n");
    f.seed("a.test.ts", "const { test, expect } = require('bun:test');\nconst a = require('./a.js');\ntest('A', () => expect(a.value).toBe(1));\n");
    f.seed("restored.test.ts", "const { test, expect } = require('bun:test');\nconst b = require('./b.js');\ntest('B', () => expect(b.value).toBe(1));\n");
    const author = f.addPr(12, "restored.test.ts", "removed");
    git(f.repo, ["checkout", "topic-12"]);
    rmSync(join(f.repo, "restored.test.ts"));
    git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Delete detector"]);
    const removed = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "origin", `${removed}:refs/pull/12/head`, `${removed}:refs/heads/topic-12`]);
    f.views.get(12)!.headRefOid = removed;
    git(f.repo, ["checkout", "main"]);
    const second = f.addPr(13, "b.js", "exports.value = 2;\n");
    const first = f.addPr(14, "a.js", "exports.value = 2;\n");
    const healthy = f.addPr(15, "healthy.txt", "healthy");
    expect(author).not.toBe(removed);
    await f.batch.build(`12@${removed},13@${second},14@${first},15@${healthy}`);
    const gated = await f.batch.gate();
    expect(gated.rows.map(row => row.status)).toEqual(["head-moved", "culprit", "culprit", "clean"]);
    expect(gated.gated?.candidate.prs.map(pr => pr.number)).toEqual([15]);
    expect(gated.rows[0]!.paths).toEqual([]);
    if (mode === "behind") {
      const bounded = f.batch.read(); bounded.landPolls = MAX_REQUIRED_CHECK_POLLS - 2; f.batch.save(bounded);
      await expect(f.batch.land()).rejects.toThrow("polling bound");
      expect(f.batch.read().attributionLog.some(entry => entry.test.file === "restored.test.ts")).toBeTrue();
      return;
    }
    const landed = await f.batch.land();
    expect(landed.rows[3]!.status).toBe("merged");
    expect(git(f.repo, ["log", "--format=%s", `${landed.base}..HEAD`])).toBe("Feature 15 (#15)");
    expect((await commandRunner(f.repo, [process.execPath, "test", "./a.test.ts", "./restored.test.ts"])).code).toBe(0);
  }, 60_000);
}

test("(a)(c) a case native main completes before aborting still names its culprit with the real sampler", async () => {
  const f = landingFixture("green", async (cwd, args, env) => args[2] === "bun" && args[3] === "test"
    ? commandRunner(cwd, args.slice(2), env) : successfulCommand(args));
  f.seed("value.js", "exports.value = 1;\n");
  f.seed("abort.txt", "main aborts this file\n");
  f.seed("value.test.ts", "const { test, expect } = require('bun:test');\nconst { existsSync } = require('node:fs');\nconst { join } = require('node:path');\n"
    + "test('shared invariant', () => expect(require('./value.js').value).toBe(1));\n"
    + "test('main aborts', () => { if (existsSync(join(__dirname, 'abort.txt'))) process.exit(1); });\n");
  const main = await commandRunner(f.repo, [process.execPath, "test", "./value.test.ts"]);
  expect(main.code).toBe(1);
  expect(main.output).not.toContain("1 pass");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  f.addPr(13, "value.js", "exports.value = 2;\n");
  git(f.repo, ["checkout", "topic-13"]);
  git(f.repo, ["rm", "-q", "abort.txt"]); git(f.repo, ["commit", "-m", "Stop aborting"]);
  const regression = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "origin", `${regression}:refs/pull/13/head`, `${regression}:refs/heads/topic-13`]);
  f.views.get(13)!.headRefOid = regression;
  git(f.repo, ["checkout", "main"]);
  await f.batch.build(`12@${healthy},13@${regression}`);
  const gated = await f.batch.gate();
  expect(gated.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
  const evidence = gated.attributionLog.find(entry => entry.test.name === "shared invariant")!;
  expect(evidence.prs).toEqual([13]);
  expect(evidence.confirmation).toEqual(["fail", "fail", "fail"]);
  // Without #13 the file aborts again; the case it reached still passes.
  expect(evidence.removals).toEqual([{ removed: [12], outcome: "fail" }, { removed: [13], outcome: "pass" }]);
  // On the rebuilt candidate main's own abort is the only red, and pre-existing.
  const final = gated.gated!.decisions.at(-1)!;
  expect(final.attributed).toEqual([]);
  expect(final.preExisting).toEqual([fileFault("value.test.ts", INCOMPLETE_FILE)]);
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "culprit"]);
  expect(git(f.repo, ["log", "--format=%s", `${landed.base}..HEAD`])).toBe("Feature 12 (#12)");
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(regression);
  expect(report(landed)).toContain("#13 | culprit test regression: value.test.ts > ");
}, 60_000);

test("(a)(c) a named case main aborts on does not erase another named case's baseline with the real sampler", async () => {
  const f = landingFixture("green", async (cwd, args, env) => args[2] === "bun" && args[3] === "test"
    ? commandRunner(cwd, args.slice(2), env) : successfulCommand(args));
  f.seed("value.js", "exports.value = 1;\n");
  f.seed("value.test.ts", "const { test, expect } = require('bun:test');\nconst { value } = require('./value.js');\n"
    + "test('shared invariant', () => expect(value).toBe(1));\n"
    + "test('main aborts', () => { if (value === 1) process.exit(1); expect(value).toBe(1); });\n");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const regression = f.addPr(13, "value.js", "exports.value = 2;\n");
  await f.batch.build(`12@${healthy},13@${regression}`);
  const gated = await f.batch.gate();
  expect(gated.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
  // Both named cases fail on the candidate; together they abort main again,
  // so each runs alone there and the shared invariant keeps its pass.
  const evidence = gated.attributionLog.find(entry => entry.test.name === "shared invariant")!;
  expect(evidence.prs).toEqual([13]);
  expect(evidence.removals).toEqual([{ removed: [12], outcome: "fail" }, { removed: [13], outcome: "pass" }]);
  expect(gated.attributionLog.some(entry => entry.test.name === "main aborts")).toBe(false);
  const final = gated.gated!.decisions.at(-1)!;
  expect(final.attributed).toEqual([]);
  expect(final.preExisting).toEqual([fileFault("value.test.ts", INCOMPLETE_FILE)]);
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "culprit"]);
  expect(git(f.repo, ["log", "--format=%s", `${landed.base}..HEAD`])).toBe("Feature 12 (#12)");
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(regression);
}, 60_000);

test("(a)(c) a namesake main aborts on does not erase a completed occurrence's baseline with the real sampler", async () => {
  const f = landingFixture("green", async (cwd, args, env) => args[2] === "bun" && args[3] === "test"
    ? commandRunner(cwd, args.slice(2), env) : successfulCommand(args));
  f.seed("value.js", "exports.value = 1;\n");
  f.seed("value.test.ts", "const { test, expect } = require('bun:test');\nconst { value } = require('./value.js');\n"
    + "test('shared invariant', () => expect(value).toBe(1));\n"
    + "test('shared invariant', () => { if (value === 1) process.exit(1); expect(value).toBe(1); });\n");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const regression = f.addPr(13, "value.js", "exports.value = 2;\n");
  await f.batch.build(`12@${healthy},13@${regression}`);
  const gated = await f.batch.gate();
  expect(gated.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
  // A name filter runs both occurrences, so each runs without its namesake's
  // body: the first keeps its pass on main, the one main aborts on stays
  // uncompared.
  const evidence = gated.attributionLog.filter(entry => entry.test.name === "shared invariant");
  expect(evidence.map(entry => entry.test.occurrence)).toEqual([0]);
  expect(evidence[0]!.prs).toEqual([13]);
  expect(evidence[0]!.removals).toEqual([{ removed: [12], outcome: "fail" }, { removed: [13], outcome: "pass" }]);
  const final = gated.gated!.decisions.at(-1)!;
  expect(final.attributed).toEqual([]);
  expect(final.preExisting).toEqual([fileFault("value.test.ts", INCOMPLETE_FILE)]);
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "culprit"]);
  expect(git(f.repo, ["log", "--format=%s", `${landed.base}..HEAD`])).toBe("Feature 12 (#12)");
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(regression);
  expect(readdirSync(dirname(f.batch.stateFile)).filter(name => name.startsWith("merge-occurrence-"))).toEqual([]);
}, 60_000);

test("(a)(c) a skipped namesake does not shift the completed occurrence main runs alone with the real sampler", async () => {
  const f = landingFixture("green", async (cwd, args, env) => args[2] === "bun" && args[3] === "test"
    ? commandRunner(cwd, args.slice(2), env) : successfulCommand(args));
  f.seed("value.js", "exports.value = 1;\n");
  f.seed("value.test.ts", "const { test, expect } = require('bun:test');\nconst { value } = require('./value.js');\n"
    + "test.skip('shared invariant', () => {});\n"
    + "test('shared invariant', () => expect(value).toBe(1));\n"
    + "test('shared invariant', () => { if (value === 1) process.exit(1); expect(value).toBe(1); });\n");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const regression = f.addPr(13, "value.js", "exports.value = 2;\n");
  await f.batch.build(`12@${healthy},13@${regression}`);
  const gated = await f.batch.gate();
  expect(gated.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
  // JUnit numbers the skipped case 0, the preload never sees it: occurrence 1
  // still runs alone on main and keeps its pass there.
  const evidence = gated.attributionLog.filter(entry => entry.test.name === "shared invariant");
  expect(evidence.map(entry => entry.test.occurrence)).toEqual([1]);
  expect(evidence[0]!.prs).toEqual([13]);
  expect(evidence[0]!.removals).toEqual([{ removed: [12], outcome: "fail" }, { removed: [13], outcome: "pass" }]);
  const final = gated.gated!.decisions.at(-1)!;
  expect(final.attributed).toEqual([]);
  expect(final.preExisting).toEqual([fileFault("value.test.ts", INCOMPLETE_FILE)]);
  const landed = await f.batch.land();
  expect(landed.rows.map(row => row.status)).toEqual(["merged", "culprit"]);
  expect(git(f.repo, ["log", "--format=%s", `${landed.base}..HEAD`])).toBe("Feature 12 (#12)");
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(regression);
  expect(readdirSync(dirname(f.batch.stateFile)).filter(name => name.startsWith("merge-occurrence-"))).toEqual([]);
}, 60_000);

for (const mode of ["new", "modified"] as const) {
  test(`a ${mode} feature detector distinguishes an added test from an existing invariant with real git and Bun`, async () => {
    const f = landingFixture("green", async (cwd, args, env) => args[2] === "bun" && args[3] === "test"
      ? commandRunner(cwd, args.slice(2), env) : successfulCommand(args));
    f.seed("adder.js", "exports.existing = 1;\n");
    if (mode === "modified") f.seed("adder.test.ts", "const { test, expect } = require('bun:test');\ntest('double', () => expect(1).toBe(1));\n");
    const main = git(f.repo, ["rev-parse", "main"]);
    const healthy = f.addPr(12, "healthy.txt", "healthy");
    const implementation = f.addPr(13, "adder.js", "exports.existing = 1;\nexports.double = x => x * 3;\n");
    const contents = "const { test, expect } = require('bun:test');\nconst { double } = require('./adder.js');\ntest('double', () => expect(double?.(2)).toBe(4));\n";
    const detector = f.addPr(14, "adder.test.ts", contents);
    await f.batch.build(`12@${healthy},13@${implementation},14@${detector}`);
    if (mode === "new") {
      const state = await f.batch.gate();
      expect(state.rows.map(row => row.status)).toEqual(["clean", "clean", "culprit"]);
      expect(state.attributionLog.map(entry => [entry.test.name, entry.prs, entry.reason]))
        .toEqual([["double", [14], "member-specific: adds the failing test"]]);
      expect(state.gated!.candidate.prs.map(pr => pr.number)).toEqual([12, 13]);
      expect((await f.batch.land()).rows.map(row => row.status)).toEqual(["merged", "merged", "culprit"]);
      unchangedCulprit(f, 14, detector);
      return;
    }
    await expect(f.batch.gate()).rejects.toThrow("Cannot establish attribution");
    const state = f.batch.read();
    expect(state.gated).toBeNull();
    expect(state.rows.map(row => row.status)).toEqual(["clean", "clean", "clean"]);
    expect(git(state.work, ["show", `${detector}:adder.test.ts`])).toBe(contents.trimEnd());
    expect(readFileSync(join(state.work, "adder.test.ts"), "utf8")).toBe(contents);
    expect(f.calls.some(args => args[0] === "pr" && ["create", "merge", "close"].includes(args[1]!))).toBeFalse();
    expect(git(f.repo, ["rev-parse", "main"])).toBe(main);
    for (const [number, head] of [[13, implementation], [14, detector]] as const) {
      expect(git(f.repo, ["ls-remote", "origin", `refs/heads/topic-${number}`]).split(/\s/)[0]).toBe(head);
    }
  }, 30_000);
}
