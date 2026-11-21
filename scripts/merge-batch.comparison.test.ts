import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GATE_SLOT, INCOMPLETE_FILE, MAX_REQUIRED_CHECK_POLLS, commandRunner, fileFault, git, report, type CommandRunner } from "./merge-batch";
import { isolatedEnvironment } from "./local-gate";
import { bindMergerContract } from "../src/lib/pipelines/mergerContract.fixture";
import { MergeBatch, extendPr, fixture, landingFixture, realTests, reviewedDetectorsGreen, seedTrustedPrivacyFiles, successfulCommand, testResult, trustedPrivacyRunner, unchangedCulprit, registerMergeBatchFixtures } from "./merge-batch.fixture";

registerMergeBatchFixtures();

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
    await expect(f.batch.land()).rejects.toThrow("Run gate before land");
    expect(f.calls.some(args => args[0] === "pr" && ["create", "merge", "close"].includes(args[1]!))).toBeFalse();
    expect(git(f.repo, ["rev-parse", "main"])).toBe(main);
    for (const [number, head] of [[13, implementation], [14, detector]] as const) {
      expect(git(f.repo, ["ls-remote", "origin", `refs/heads/topic-${number}`]).split(/\s/)[0]).toBe(head);
    }
  }, 30_000);
}

test("a deferred conflict only fast-forwards its original branch after landing, then needs independent review", async () => {
  const resolutionCandidates: string[] = [];
  const f = landingFixture("green", undefined, (fixture) => {
    seedTrustedPrivacyFiles(fixture);
    return trustedPrivacyRunner(fixture, undefined, [], resolutionCandidates);
  });
  const a = f.addPr(12, "story.txt", "first\nsecond accepted\nthird\nfourth\nfifth\n");
  const b = f.addPr(13, "story.txt", "first\nsecond alternative\nthird\nfourth\nfifth\n");
  await f.batch.build(`12@${a},13@${b}`); await f.batch.gate(); await f.batch.land();
  let state = await f.batch.resolve(13);
  expect(state.rows[1]!.status).toBe("deferred");
  const work = state.resolving!.work;
  writeFileSync(join(work, "story.txt"), "first\nsecond resolved\nthird\nfourth\nfifth\n");
  git(work, ["add", "story.txt"]);
  state = await f.batch.resolve(13);
  expect(state.rows[1]!.status).toBe("needs-review");
  expect(resolutionCandidates).toContain(work);
  const sha = state.rows[1]!.resolution!;
  expect(git(work, ["rev-list", "--parents", "-n", "1", sha]).split(" ")).toHaveLength(3);
  expect(git(work, ["ls-remote", "origin", "refs/heads/topic-13"])).toContain(sha);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(git(work, ["show", "--remerge-diff", "--format=", sha])).toContain("second resolved");
});

test.each(["same repository", "case folded without suffix", "foreign repository"] as const)("guarded deferred resolution: %s", async mode => {
  const f = landingFixture();
  const a = f.addPr(12, "story.txt", "first\nsecond accepted\nthird\nfourth\nfifth\n");
  const b = f.addPr(13, "story.txt", "first\nsecond alternative\nthird\nfourth\nfifth\n");
  await f.batch.build(`12@${a},13@${b}`); await f.batch.gate(); await f.batch.land();
  // Model a merger-only lane rooted before the PR and main's accepted change.
  // All PR objects came from the script's pull-ref fetch, with no branch proof.
  git(f.repo, ["checkout", "-b", "pipeline/merger", f.base]);
  git(f.repo, ["update-ref", "-d", "refs/remotes/origin/topic-13"]);
  const laneHead = git(f.repo, ["rev-parse", "HEAD"]);
  const remote = mode === "foreign repository" ? "https://github.com/other/fixture.git"
    : mode === "case folded without suffix" ? "https://github.com/EXAMPLE/FIXTURE" : "https://github.com/example/fixture.git";
  git(f.repo, ["config", `url.${join(f.root, "origin.git")}.insteadOf`, remote]);
  const gh = async (args: string[]) => args[0] === "api" && args[1] === "repos/example/fixture/pulls/13"
    ? remote : f.batch.gh(args);
  const batch = new MergeBatch(f.repo, f.batch.stateFile, f.batch.run, gh);
  const trace = join(f.root, "git-trace.log");
  const contract = await bindMergerContract(f.repo, `merger-resolve-${mode.replaceAll(" ", "-")}`,
    { ...process.env, TMPDIR: f.root, GIT_TRACE: trace });
  const saved = Object.fromEntries(Object.keys(contract.env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, contract.env);
    let state = await batch.resolve(13);
    expect(state.rows[1]!.status).toBe("deferred");
    const work = state.resolving!.work;
    expect(git(work, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/topic-13"])).toBe("");
    writeFileSync(join(work, "story.txt"), "first\nsecond resolved\nthird\nfourth\nfifth\n");
    git(work, ["add", "story.txt"]);
    if (mode === "foreign repository") {
      await expect(batch.resolve(13)).rejects.toThrow("Resolution branch is outside origin; no branch pushed");
      state = batch.read();
      expect(state.rows[1]!.status).toBe("deferred");
      expect(report(state)).toContain("needs-review pending resolution");
      expect(git(work, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/topic-13"])).toBe("");
      expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(b);
      const commands = readFileSync(trace, "utf8");
      expect(commands).not.toContain("fetch origin +refs/heads/topic-13:");
      expect(commands).not.toContain(`ls-remote ${remote}`);
      expect(commands).not.toContain(`push ${remote}`);
    } else {
      state = await batch.resolve(13);
      const row = state.rows[1]!, sha = row.resolution!;
      expect(row.status).toBe("needs-review");
      expect(report(state)).toContain(`needs-review ${sha}`);
      expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(sha);
      expect(git(work, ["rev-parse", "refs/remotes/origin/topic-13"])).toBe(b);
      git(work, ["merge-base", "--is-ancestor", b, sha]);
      expect(readFileSync(join(contract.receipt, "pushes", sha), "utf8")).toBe(`refs/heads/topic-13\n${join(f.root, "origin.git")}\n`);
      expect(state.resolving).toBeUndefined();
      const commands = readFileSync(trace, "utf8");
      const fetched = commands.indexOf("fetch origin +refs/heads/topic-13:refs/remotes/origin/topic-13");
      const checked = commands.indexOf(`ls-remote ${remote}`);
      expect(fetched).toBeGreaterThanOrEqual(0);
      expect(checked).toBeGreaterThan(fetched);
    }
    expect(existsSync(join(contract.receipt, "refused"))).toBe(false);
    expect(await contract.settle()).toBeNull();
    expect(git(f.repo, ["rev-parse", "HEAD"])).toBe(laneHead);
    expect(f.calls.filter(args => args[1] === "merge")).toHaveLength(1);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(contract.receipt, { recursive: true, force: true });
  }
});

test("deferred resolutions run their own touched tests and block a failed resolution", async () => {
  const testRuns: string[][] = [];
  let resolutionWork = "";
  const runner: CommandRunner = async (cwd, args) => {
    if (args[2] === "bun" && args[3] === "test") {
      const paths = args.slice(4).filter(path => /\.test\.ts$/.test(path));
      testRuns.push(paths);
      if (cwd === resolutionWork && paths.some((path) => path.includes("story.test.ts"))) {
        return { code: 1, output: "resolution test failed" };
      }
    }
    return successfulCommand(args);
  };
  const f = landingFixture("green", runner);
  f.seed("story.ts", "export const value = 'first';\n");
  const conflict = f.addPr(13, "story.ts", "export const value = 'alternative';\n");
  f.seed("story.ts", "export const value = 'accepted';\n");
  f.seed("story.test.ts", "throw new Error('resolution regression');\n");
  const clean = f.addPr(12, "a.test.ts", "if (true) {}\n");
  const batch = f.batch;
  await batch.build(`12@${clean},13@${conflict}`);
  await batch.gate();
  await batch.land();
  const state = await batch.resolve(13);
  const work = state.resolving!.work;
  resolutionWork = work;
  writeFileSync(join(work, "story.ts"), "export const value = 'resolved';\n");
  git(work, ["add", "story.ts"]);

  await expect(batch.resolve(13)).rejects.toThrow("Resolution failed tests; no branch pushed");
  expect(testRuns.some((paths) => paths.length === 1 && paths[0]!.includes("a.test.ts"))).toBe(true);
  expect(testRuns.some((paths) => paths.some((path) => path.includes("story.test.ts")))).toBe(true);
  expect(git(work, ["ls-remote", "origin", "refs/heads/topic-13"])).toContain(conflict);
});

for (const shape of ["pre-existing", "bundled-only", "file-error", "new-failure"] as const) {
  test(`resolution native-main per-file comparison: ${shape}`, async () => {
    const samples: { cwd: string; head: string; home: string; temp: string; state: string }[] = [];
    const f = landingFixture("green", async (cwd, args, env) => {
      // The gate invokes /bin/bash, GATE_SLOT, then the command. Execute the
      // fixture tests in the enclosing test service, as the other real samplers do.
      if (args[2] !== "bun" || args[3] !== "test") return successfulCommand(args);
      expect(args.slice(0, 2)).toEqual(["/bin/bash", GATE_SLOT]);
      expect(args).toContain("--timeout=60000");
      const files = args.slice(4).filter(arg => /\.test\.ts$/.test(arg));
      expect(files).toHaveLength(1);
      expect(env!.LLV_VIEWER_CONTROL_URL).toBe("http://127.0.0.1:9");
      samples.push({ cwd, head: git(cwd, ["rev-parse", "HEAD"]), home: env!.HOME!, temp: env!.TMPDIR!, state: env!.LLV_STATE_DIR! });
      return commandRunner(cwd, args.slice(2), env);
    });
    const imports = "const { test, expect, afterAll } = require('bun:test');\n";
    const marker = imports + "globalThis.mergeBundleFixture = true;\ntest('setup', () => expect(true).toBe(true));\n";
    const existing = shape === "pre-existing" ? ["what needs one project to write into is absent, never faked"]
      : shape === "bundled-only" ? ["original-key payload checks"]
      : shape === "file-error" ? Array.from({ length: 8 }, (_, i) => `switching main failure ${i}`) : [];
    const artefacts = shape === "bundled-only" ? 8 : shape === "file-error" ? 16 : 0;
    f.seed("story.js", "exports.value = 'first';\n");
    f.seed("a.test.ts", marker);
    f.seed("story.test.ts", imports
      + (shape === "file-error" ? "afterAll(() => { if (globalThis.mergeBundleFixture) throw new Error('bundle-only file error'); });\n" : "")
      + existing.map(name => `test(${JSON.stringify(name)}, () => expect(false).toBe(true));\n`).join("")
      + Array.from({ length: artefacts }, (_, i) => `test('bundle-only assertion ${i}', () => expect(globalThis.mergeBundleFixture).toBeUndefined());\n`).join("")
      + "test('resolution invariant', () => expect(require('./story.js').value).not.toBe('resolved regression'));\n");
    f.addPr(13, "story.js", "exports.value = 'alternative';\n");
    // Both files belong to the resolution's touched inventory.
    git(f.repo, ["checkout", "topic-13"]);
    writeFileSync(join(f.repo, "a.test.ts"), marker + "// Reviewed setup coverage.\n");
    git(f.repo, ["commit", "-am", "Setup coverage"]);
    const conflict = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "origin", `${conflict}:refs/pull/13/head`, `${conflict}:refs/heads/topic-13`]);
    f.views.get(13)!.headRefOid = conflict;
    f.seed("story.js", "exports.value = 'accepted';\n");
    const clean = f.addPr(12, "healthy.txt", "healthy\n");
    await f.batch.build(`12@${clean},13@${conflict}`);
    await f.batch.gate(); await f.batch.land();
    const state = await f.batch.resolve(13), work = state.resolving!.work;
    const main = state.resolving!.main;
    expect(main).not.toBe(state.base); // Landing moved main after the batch baseline.
    writeFileSync(join(work, "story.js"), `exports.value = '${shape === "new-failure" ? "resolved regression" : "resolved"}';\n`);
    git(work, ["add", "story.js"]);
    if (artefacts) {
      const sandbox = join(f.root, "bundled-control");
      const env = { ...isolatedEnvironment(sandbox, process.env), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9" };
      const bundled = await commandRunner(work, ["bun", "test", "./a.test.ts", "./story.test.ts"], env);
      expect(bundled.code).not.toBe(0);
      expect(bundled.output).toContain(shape === "file-error" ? "bundle-only file error" : "bundle-only assertion");
    }
    samples.length = 0;
    if (shape === "new-failure") {
      await expect(f.batch.resolve(13)).rejects.toThrow("Resolution failed tests; no branch pushed");
    } else await f.batch.resolve(13);
    const result = f.batch.read(), row = result.rows[1]!, receipt = row.resolutionTests!;
    expect(receipt.main).toBe(main);
    expect(receipt.tip).toBe(row.resolution!);
    expect(receipt.files).toEqual(["a.test.ts", "story.test.ts"]);
    expect(samples.filter(sample => sample.cwd !== work)).toHaveLength(2);
    expect(new Set(samples.filter(sample => sample.cwd !== work).map(sample => sample.head))).toEqual(new Set([main]));
    expect(new Set(samples.map(sample => sample.home)).size).toBe(samples.length);
    expect(new Set(samples.map(sample => sample.temp)).size).toBe(samples.length);
    expect(new Set(samples.map(sample => sample.state)).size).toBe(samples.length);
    expect(receipt.decision.preExisting.map(site => site.name)).toEqual(existing);
    expect(receipt.decision.uncompared).toEqual([]);
    const summary = report(result);
    expect(summary).toContain(`Resolution #13: ${row.resolution}; native main ${main}; per-file comparison:`);
    for (const name of existing) expect(summary).toContain(name);
    if (shape === "new-failure") {
      expect(row.status).toBe("deferred");
      expect(receipt.confirmed.map(entry => [entry.test.name, entry.confirmation]))
        .toEqual([["resolution invariant", ["fail", "fail", "fail"]]]);
      expect(summary).toContain("New resolution failures (publication withheld):\n- story.test.ts");
      expect(git(work, ["ls-remote", "origin", "refs/heads/topic-13"])).toContain(conflict);
      // A repair samples main again and replaces the failed attempt's receipt.
      samples.length = 0;
      writeFileSync(join(work, "story.js"), "exports.value = 'resolved';\n");
      git(work, ["add", "story.js"]);
      const repaired = await f.batch.resolve(13), repairedRow = repaired.rows[1]!;
      expect(repairedRow.status).toBe("needs-review");
      expect(repairedRow.resolution).not.toBe(row.resolution);
      expect(repairedRow.resolutionTests!.tip).toBe(repairedRow.resolution!);
      expect(repairedRow.resolutionTests!.confirmed).toEqual([]);
      expect(samples.filter(sample => sample.cwd !== work)).toHaveLength(2);
      expect(git(work, ["ls-remote", "origin", "refs/heads/topic-13"])).toContain(repairedRow.resolution!);
    } else {
      expect(row.status).toBe("needs-review");
      expect(receipt.confirmed).toEqual([]);
      expect(git(work, ["ls-remote", "origin", "refs/heads/topic-13"])).toContain(row.resolution!);
      expect(summary).not.toContain("bundle-only file error");
      expect(summary).not.toContain("bundle-only assertion");
    }
  }, 60_000);
}

for (const mainCase of ["absent", "unreported", "skipped"] as const) {
  test(`resolution withholds a failing case in native main's incomplete file (${mainCase})`, async () => {
    const f = landingFixture("green", async (cwd, args, env) => args[2] === "bun" && args[3] === "test"
      ? commandRunner(cwd, args.slice(2), env) : successfulCommand(args));
    const imports = "const { test, expect } = require('bun:test');\n";
    f.seed("story.js", "exports.value = 'first';\n");
    f.seed("story.test.ts", imports + (mainCase === "unreported"
      ? "test('new resolution assertion', () => process.exit(1));\n"
      : "test('main abort', () => process.exit(1));\n"
        + (mainCase === "skipped" ? "test.skip('new resolution assertion', () => expect(false).toBe(true));\n" : "")));
    f.addPr(13, "story.js", "exports.value = 'alternative';\n");
    git(f.repo, ["checkout", "topic-13"]);
    writeFileSync(join(f.repo, "story.test.ts"), imports + "test('new resolution assertion', () => expect(false).toBe(true));\n");
    git(f.repo, ["commit", "-am", "New resolution assertion"]);
    const conflict = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "origin", `${conflict}:refs/pull/13/head`, `${conflict}:refs/heads/topic-13`]);
    f.views.get(13)!.headRefOid = conflict;
    f.seed("story.js", "exports.value = 'accepted';\n");
    const clean = f.addPr(12, "healthy.txt", "healthy\n");
    await f.batch.build(`12@${clean},13@${conflict}`);
    await f.batch.gate(); await f.batch.land();
    const state = await f.batch.resolve(13), work = state.resolving!.work;
    writeFileSync(join(work, "story.js"), "exports.value = 'resolved';\n");
    git(work, ["add", "story.js"]);

    await expect(f.batch.resolve(13)).rejects.toThrow(mainCase === "absent"
      ? "Resolution failed tests; no branch pushed" : "Resolution test comparison incomplete; no branch pushed");
    const result = f.batch.read(), row = result.rows[1]!, receipt = row.resolutionTests!;
    expect(row.status).toBe("deferred");
    expect(receipt.main).toBe(state.resolving!.main);
    if (mainCase === "absent") {
      expect(receipt.decision.uncompared).toEqual([]);
      expect(receipt.confirmed.map(entry => [entry.test.name, entry.confirmation]))
        .toEqual([["new resolution assertion", ["fail", "fail", "fail"]]]);
      expect(report(result)).toContain("New resolution failures (publication withheld):\n- story.test.ts");
    } else {
      expect(receipt.decision.uncompared!.map(site => site.name)).toEqual(["new resolution assertion"]);
      expect(receipt.confirmed).toEqual([]);
      expect(report(result)).toContain("Unresolved resolution failures (publication withheld):\n- story.test.ts");
    }
    expect(git(work, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(conflict);
  }, 60_000);
}

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
