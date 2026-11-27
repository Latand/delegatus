import { expect, test } from "bun:test";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { report, batchMessage, git, MergeBatch, commandRunner, candidateOf, type Candidate } from "./merge-batch";
import { extendPr, landingFixture, realTests, reviewedDetectorsGreen, successfulCommand, testResult, unchangedCulprit, installMergeBatchFixtures } from "./merge-batch.fixture";

installMergeBatchFixtures();

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

test("batch commit subjects and copied summaries use publication prose", () => {
  expect(batchMessage(12, "Виправити публікацію", "Fix GitHub publication text", []))
    .toBe("Fix GitHub publication text (#12)\n\nFix GitHub publication text\n");
  const message = batchMessage(12, "Виправити публікацію", "Виправлено публікацію", []);
  expect(message).toStartWith("Implement project changes (#12)");
  expect(message).not.toContain("публікацію");
});
