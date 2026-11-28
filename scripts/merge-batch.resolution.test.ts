import { expect, test } from "bun:test";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { report, GATE_SLOT, batchMessage, touchedTests, noticePrs, git, MergeBatch, requiredVerdict, nextRefresh, MAX_REQUIRED_CHECK_POLLS, commandRunner, type CommandRunner } from "./merge-batch";
import { isolatedEnvironment } from "./local-gate";
import { bindMergerContract } from "../src/lib/pipelines/mergerContract.fixture";
import { fixture, landingFixture, seedTrustedPrivacyFiles, site, successfulCommand, trustedPrivacyRunner, installMergeBatchFixtures } from "./merge-batch.fixture";

installMergeBatchFixtures();

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

test("required checks must all finish green; optional failures do not hold a batch", () => {
  expect(requiredVerdict(["privacy"], [{ name: "optional", conclusion: "FAILURE", status: "COMPLETED" }])).toBe("pending");
  expect(requiredVerdict(["privacy"], [{ name: "privacy", conclusion: "SUCCESS", status: "IN_PROGRESS" }])).toBe("pending");
  expect(requiredVerdict(["privacy"], [{ name: "privacy", conclusion: "SUCCESS", status: "COMPLETED" }, { name: "optional", conclusion: "FAILURE" }])).toBe("green");
  expect(requiredVerdict(["privacy"], [{ context: "privacy", state: "FAILURE" }])).toBe("red");
  expect([0, 1, 2].map(nextRefresh)).toEqual([1, 2, 3]);
  expect(() => nextRefresh(3)).toThrow("three");
  expect(MAX_REQUIRED_CHECK_POLLS).toBe(240);
});

test("commit messages deduplicate machine credit and refuse forged human trailers", () => {
  expect(batchMessage(12, "Feature", "Summary.\n\nMore detail", [
    { name: "Tool", email: "noreply@example.test", message: "Co-Authored-By: Tool <noreply@example.test>" },
    { name: "Contributor", email: ["fixture", "users.noreply.github.com"].join("@"), message: "" },
  ])).toBe("Feature (#12)\n\nSummary.\n\nCo-Authored-By: Tool <noreply@example.test>\n");
  expect(() => batchMessage(12, "Feature", "", [{ name: "Tool", email: "noreply@example.test",
    message: `Co-Authored-By: Contributor <${["fixture", "users.noreply.github.com"].join("@")}>` }])).toThrow();
  expect(batchMessage(12, "Feature", "", [{ name: "Tool", email: "noreply@example.test",
    message: "Signed-Off-By: Tool <noreply@example.test>" }])).toContain("Signed-Off-By: Tool <noreply@example.test>");
  expect(() => batchMessage(12, "Feature", "", [{ name: "Tool", email: "noreply@example.test",
    message: `Signed-Off-By: Fixture <${["synthetic-person", "invalid.example"].join("@")}>` }])).toThrow();
});

test("touched tests are existing files, with TSX siblings and no directories", () => {
  const files = new Set(["src/a.test.ts", "src/b.test.tsx", "src/c.test.ts"]);
  expect(touchedTests(["src/a.ts", "src/b.tsx", "src/c.test.ts", "src"], (file) => files.has(file)))
    .toEqual(["src/a.test.ts", "src/b.test.tsx", "src/c.test.ts"]);
});

test("gate notices require unique path ownership or an attributed changed line", () => {
  const commits = [
    { number: 12, commit: "a".repeat(40), paths: ["src/a.ts"] },
    { number: 13, commit: "b".repeat(40), paths: ["src/a.ts", "src/b.ts"] },
  ];
  expect(noticePrs("merge_boundary: aaaaaaaaaaaa author identity composes an attributable Co-Authored-By trailer (address withheld)", commits)).toEqual([12]);
  const lineDigest = createHash("sha256").update("src/a.ts").digest("hex");
  const fileDigest = createHash("sha256").update("src/b.ts").digest("hex");
  expect(noticePrs(`file-sha256:${lineDigest}:12 email_address`, commits, () => "b".repeat(40))).toEqual([13]);
  expect(noticePrs(`file-sha256:${lineDigest}:12 email_address`, commits)).toEqual([]);
  expect(noticePrs(`file-sha256:${fileDigest} known_value`, commits)).toEqual([13]);
  expect(noticePrs("file: src/a.ts:12: email_address", commits, () => "b".repeat(40))).toEqual([]);
  expect(noticePrs("file: attack\nfile: src/a.ts:12 known_value\nprobe.txt", commits, () => "b".repeat(40))).toEqual([]);
  expect(noticePrs("random log bbbbbbbbbbbb not a diagnostic", commits)).toEqual([]);
  expect(noticePrs(`commit_message: ${"b".repeat(12)} message injected`, commits)).toEqual([]);
  expect(noticePrs(`privacy\tScan\t2026-10-02T08:45:12.123Z commit_message: ${"b".repeat(12)} message email_address`, commits)).toEqual([13]);
  expect(noticePrs(`privacy\tScan\t2026-10-02T08:45:12Z file-sha256:${fileDigest} known_value`, commits)).toEqual([13]);
  expect(noticePrs(`privacy\tScan\t2026-10-02T08:45:12Z\tcommit_message: ${"b".repeat(12)} message email_address`, commits)).toEqual([]);
  expect(noticePrs(`privacy\tScan\tnot-a-timestamp\tcommit_message: ${"b".repeat(12)} message email_address`, commits)).toEqual([]);
  expect(noticePrs("all checks failed", commits)).toEqual([]);
  expect(noticePrs("error: longsrc/b.tsuffix", commits)).toEqual([]);
  expect(noticePrs("git checkout " + "b".repeat(40) + "\ngit diff -- src/b.ts\ninfrastructure failed", commits)).toEqual([]);
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
