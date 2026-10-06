import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync, copyFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { withAgentConfigSandbox } from "../src/lib/runtime/agentConfigSandbox";
import { applyClaudeSpawnPolicy } from "../src/lib/agent/spawnPolicy";
import { agentCodexPublicationPolicy } from "../src/lib/git/agentPublicationIdentity";
import { report, attributeBatchTests, compareBatchTests, parseReviewedPrs, batchMessage, touchedTests, noticePrs, git, patchId, MergeBatch, localGateCommands, requiredVerdict, nextRefresh, MAX_REQUIRED_CHECK_POLLS, MAX_TEST_CONFIRMATION_RUNS, commandRunner, type CommandRunner } from "./merge-batch";
import type { TestRun, TestSite } from "./local-gate-tests";
import * as merger from "./merge-batch";

const site = (name: string, file = "example.test.ts"): TestSite => ({ file, suite: "suite", name, kind: "test", occurrence: 0 });
const recorded = (failures: TestSite[] = [], passed: TestSite[] = []): TestRun => ({
  failures, passed, completed: [...new Set([...failures, ...passed].map(test => test.file))], elapsedMs: 0,
});

test("batch comparison permits pre-existing failures and judges new tests on the candidate", () => {
  const existing = site("existing"), added = site("added"), newFile = site("new file", "added.test.ts");
  expect(compareBatchTests(recorded([existing]), recorded([existing]))).toEqual({ preExisting: [existing], introduced: [] });
  expect(compareBatchTests(recorded([existing]), recorded([added, newFile]))).toEqual({ preExisting: [], introduced: [added, newFile] });
});

test("recorded batch results name one culprit among three after bounded confirmation", async () => {
  const failure = site("regression"), calls: number[][] = [];
  const decision = await attributeBatchTests(recorded([], [failure]), recorded([failure]), [12, 13, 14],
    async () => recorded([failure]), async removed => {
      calls.push(removed);
      return removed.includes(13) ? recorded([], [failure]) : recorded([failure]);
    });
  expect(decision.attributed.map(entry => entry.prs)).toEqual([[13]]);
  expect(calls).toEqual([[12], [13], [14]]);
  expect(decision.attributed[0]!.confirmation).toEqual(["fail", "fail", "fail"]);
});

test("recorded integration evidence keeps an unrelated PR out of the culprit set", async () => {
  const failure = site("combined changes");
  for (const mode of ["together", "independent"] as const) {
    const decision = await attributeBatchTests(recorded([], [failure]), recorded([failure]), [12, 13, 14],
      async () => recorded([failure]), async removed => {
        const fails = mode === "together" ? !removed.includes(12) && !removed.includes(13)
          : !removed.includes(12) || !removed.includes(13);
        return fails ? recorded([failure]) : recorded([], [failure]);
      });
    expect(decision.attributed[0]!.prs).toEqual([12, 13]);
    expect(decision.attributed[0]!.reason).toBe("integration: needs both");
  }
});

test("a candidate failure that passes a confirmation is reported as intermittent", async () => {
  const failure = site("intermittent");
  let runs = 0;
  const decision = await attributeBatchTests(recorded(), recorded([failure]), [12], async () =>
    ++runs === 2 ? recorded([], [failure]) : recorded([failure]), async () => { throw new Error("must not attribute"); });
  expect(runs).toBe(3);
  expect(decision.intermittent).toEqual([failure]);
  expect(decision.attributed).toEqual([]);
});

test("confirmation discovers and attributes a failure skipped in the initial candidate", async () => {
  const first = site("initial intermittent"), later = site("later regression");
  let runs = 0;
  const decision = await attributeBatchTests(recorded([], [first, later]), recorded([first]), [12, 13],
    async () => { runs++; return recorded([later], [first]); },
    async removed => removed.includes(13) ? recorded([], [first, later]) : recorded([later], [first]));
  expect(runs).toBe(4);
  expect(decision.intermittent).toEqual([first]);
  expect(decision.attributed.map(entry => entry.test)).toEqual([later]);
  expect(decision.attributed[0]!.prs).toEqual([13]);
  expect(decision.attributed[0]!.confirmation).toEqual(["fail", "fail", "fail"]);
});

test("confirmation reports baseline failures first seen during a full rerun", async () => {
  const initial = site("intermittent"), existing = site("existing");
  const decision = await attributeBatchTests(recorded([existing]), recorded([initial]), [12],
    async () => recorded([existing], [initial]), async () => { throw new Error("must not attribute"); });
  expect(decision.preExisting).toEqual([existing]);
  expect(decision.intermittent).toEqual([initial]);
});

test("late discoveries exhaust a bounded confirmation budget and cannot approve", async () => {
  const initial = site("initial");
  const failures = [initial];
  let runs = 0;
  await expect(attributeBatchTests(recorded(), recorded(failures.slice()), [12], async () => {
    failures.push(site(`discovery ${++runs}`));
    return recorded(failures.slice());
  }, async () => { throw new Error("must not attribute before confirmation completes"); })).rejects.toThrow("confirmation budget exhausted");
  expect(runs).toBe(MAX_TEST_CONFIRMATION_RUNS);
});

test("between-test errors discovered during confirmation remain hard failures", async () => {
  const failure = site("initial"), error: TestSite = { ...site("load error"), kind: "error" };
  await expect(attributeBatchTests(recorded(), recorded([failure]), [12], async () => recorded([error], [failure]),
    async () => { throw new Error("must not attribute"); })).rejects.toThrow("between-test error");
});

test("multiple faulty test authors retain integration evidence and exclude unrelated PRs", async () => {
  const failure = site("faulty assertion");
  const decision = await attributeBatchTests(recorded(), recorded([failure]), [12, 13, 14],
    async () => recorded([failure]), async () => recorded([failure]), {
      owners: () => [12, 13],
      independent: () => true,
      without: async removed => ({ run: removed.includes(12) && removed.includes(13) ? recorded() : recorded([failure]),
        absent: removed.includes(12) && removed.includes(13) }),
    });
  expect(decision.attributed[0]!.prs).toEqual([12, 13]);
  expect(decision.attributed[0]!.reason).toBe("integration: needs both; test change regression");
  expect(decision.attributed[0]!.removals.filter(entry => entry.corpus === "native")).toEqual([
    { removed: [12, 13], outcome: "absent", corpus: "native" },
    { removed: [13], outcome: "fail", corpus: "native" },
    { removed: [12], outcome: "fail", corpus: "native" },
  ]);
});

test("native absence alone cannot attribute a healthy feature detector to its author", async () => {
  const failure = site("new feature", "feature.test.ts");
  await expect(attributeBatchTests(recorded(), recorded([failure]), [12, 13, 14],
    async () => recorded([failure]), async () => recorded([failure]), {
      owners: () => [14], independent: () => false,
      without: async removed => ({ run: removed.includes(14) ? recorded() : recorded([failure]), absent: removed.includes(14) }),
    })).rejects.toThrow("Insufficient test-change attribution");
});

test("literal test evidence admits self-contained assertions and refuses project inputs", () => {
  const valid = "const { test, expect } = require('bun:test');\ntest('invariant', () => expect(1).toBe(2));\n";
  expect(merger.literalAssertionFile(valid)).toBeTrue();
  expect(merger.literalAssertionFile("import { test, expect } from 'bun:test';\ntest('invariant', () => { expect('a').toEqual('b'); });")).toBeTrue();
  for (const contents of [
    "const { double } = require('./adder.js');\n" + valid,
    valid.replace("expect(1)", "expect(process.env.VALUE)"),
    valid.replace("expect(1)", "expect(double?.(2))"),
    valid.replace("toBe(2)", "toMatchSnapshot()"),
    valid.replace("() =>", "async () =>"),
    valid.replace("{ test, expect }", "{ test, expect, mock }"),
    valid.replace("test('invariant'", "test.only('invariant'"),
    valid.replace("toBe(2)", "toBe(require('./value.js'))"),
    valid.replace("expect(1).toBe(2)", "expect(1).toBe(2); return require('./value.js')"),
  ]) expect(merger.literalAssertionFile(contents)).toBeFalse();
});

test("between-test errors and missing confirmation tests remain hard failures", async () => {
  const failure = site("failure"), error: TestSite = { ...site("load error"), kind: "error" };
  expect(() => compareBatchTests(recorded([error]), recorded([failure]))).toThrow("baseline: between-test error");
  expect(() => compareBatchTests(recorded(), recorded([error]))).toThrow("candidate: between-test error");
  await expect(attributeBatchTests(recorded(), recorded([failure]), [12], async () => recorded(),
    async () => recorded())).rejects.toThrow("incomplete test file");
});

const octoberSixFailures: TestSite[] = [
  site("Codex canonical root conversation and fork recovery (#708) > five recoverable failures in a row leave one fork artifact and one operation identity", "src/lib/accounts/migration/coordinator.test.ts"),
  site("startup socket recovery retains a partially adopted host and drains its held send once", "src/lib/runtime/startup.test.ts"),
  site("scheduled startup retry continues through the retained Codex host", "src/lib/runtime/startup.test.ts"),
  site("a Claude spawn born on a non-routed account (http viewer transport) > starts its first turn on that account and materializes its transcript (no drain)", "src/lib/runtime/structuredSpawn.integration.test.ts"),
  site("a Claude spawn born on a non-routed account (http viewer transport) > starts its first turn on that account and materializes its transcript (a drain running before staging)", "src/lib/runtime/structuredSpawn.integration.test.ts"),
  site("a Claude spawn born on a non-routed account (http viewer transport) > starts its first turn on that account and materializes its transcript (a drain committed after staging)", "src/lib/runtime/structuredSpawn.integration.test.ts"),
  site("a Claude spawn born on a non-routed account (stdio viewer transport) > starts its first turn on that account and materializes its transcript (no drain)", "src/lib/runtime/structuredSpawn.integration.test.ts"),
  site("a Claude spawn born on a non-routed account (stdio viewer transport) > starts its first turn on that account and materializes its transcript (a drain running before staging)", "src/lib/runtime/structuredSpawn.integration.test.ts"),
  site("a Claude spawn born on a non-routed account (stdio viewer transport) > starts its first turn on that account and materializes its transcript (a drain committed after staging)", "src/lib/runtime/structuredSpawn.integration.test.ts"),
].map(test => {
  const ancestry = test.name.split(" > ");
  return { ...test, suite: ancestry.slice(0, -1).join(" > "), name: ancestry.at(-1)! };
});

test("October 6 reduced identities decide six pre-existing and three attributed", async () => {
  const candidate = recorded(octoberSixFailures);
  const base = recorded(octoberSixFailures.slice(3));
  const decision = await attributeBatchTests(base, candidate, [12, 13, 14], async () => candidate,
    async removed => removed.includes(13) ? recorded(octoberSixFailures.slice(3), octoberSixFailures.slice(0, 3)) : candidate);
  expect(decision.preExisting).toHaveLength(6);
  expect(decision.attributed).toHaveLength(3);
  expect(decision.attributed.every(entry => entry.prs.join() === "13")).toBeTrue();
});

test("review inputs require unique PRs and unambiguous hexadecimal heads", () => {
  expect(parseReviewedPrs("12@abcdef1, 13@1234567")).toEqual([
    { number: 12, reviewed: "abcdef1" }, { number: 13, reviewed: "1234567" },
  ]);
  for (const input of ["", "12", "0@abcdef1", "12@HEAD", "12@abcdef1,12@1234567", "12@abcdef1,"]) {
    expect(() => parseReviewedPrs(input)).toThrow();
  }
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function githubFailedLog(output: string): string {
  return output.split("\n").map((line) => `privacy\tScan\t2026-10-02T08:45:12Z ${line}`).join("\n");
}

function testResult(file: string, failures: string[] = [], passed: string[] = ["fixture"]) {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const cases = [...failures.map(name => ({ name, failed: true })), ...passed.map(name => ({ name, failed: false }))];
  return { code: failures.length ? 1 : 0, output: "", report: `<testsuites tests="${cases.length}" failures="${failures.length}">
    ${cases.map(test => `<testcase file="${escape(file)}" classname="suite" name="${escape(test.name)}">${test.failed ? '<failure message="assertion"/>' : ""}</testcase>`).join("")}</testsuites>` };
}
function successfulCommand(args: string[]) {
  return args[1] === "bun" && args[2] === "test" ? testResult(args[3]!.replace(/^\.\//, "")) : { code: 0, output: "" };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "merge-batch-test-"));
  roots.push(root);
  const remote = join(root, "origin.git"), repo = join(root, "repo");
  mkdirSync(repo);
  git(root, ["init", "--bare", remote]);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Tool"]);
  git(repo, ["config", "user.email", "noreply@example.test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["remote", "add", "origin", remote]);
  writeFileSync(join(repo, "story.txt"), "first\nsecond\nthird\nfourth\nfifth\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "Initial"]); git(repo, ["push", "origin", "main"]);
  let base = git(repo, ["rev-parse", "HEAD"]);
  const views = new Map<number, Record<string, unknown>>();
  const addPr = (number: number, file: string, content: string) => {
    git(repo, ["checkout", "-B", `topic-${number}`, base]);
    writeFileSync(join(repo, file), content);
    git(repo, ["add", "."]); git(repo, ["commit", "-m", `Feature ${number}`]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["push", "origin", `${sha}:refs/pull/${number}/head`, `${sha}:refs/heads/topic-${number}`]);
    views.set(number, { number, title: `Feature ${number}`, body: "Summary.", state: "OPEN", isDraft: false,
      baseRefName: "main", headRefOid: sha, headRefName: `topic-${number}`, closingIssuesReferences: [{ number: number + 100 }], headRepository: { name: "fixture" } });
    git(repo, ["checkout", "main"]);
    return sha;
  };
  const seed = (file: string, content: string) => {
    git(repo, ["checkout", "main"]);
    writeFileSync(join(repo, file), content);
    git(repo, ["add", "."]); git(repo, ["commit", "-m", `Seed ${file}`]); git(repo, ["push", "origin", "main"]);
    base = git(repo, ["rev-parse", "HEAD"]);
  };
  const gh = async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(views.get(Number(args[2])));
    throw new Error(`Unexpected GH request: ${args.slice(0, 2).join(" ")}`);
  };
  const good: CommandRunner = async (_cwd, args) => successfulCommand(args);
  return { root, repo, get base() { return base; }, views, addPr, seed, gh, good };
}

test("real squash accepts context drift, preserves reviewed patch and defers every conflict", async () => {
  const f = fixture();
  const clean = f.addPr(12, "story.txt", "first\nsecond changed\nthird\nfourth\nfifth\n");
  const conflict = f.addPr(13, "story.txt", "first\nsecond alternative\nthird\nfourth\nfifth\n");
  writeFileSync(join(f.repo, "story.txt"), "first\nsecond\nthird\nnew fourth\nfifth\n");
  git(f.repo, ["commit", "-am", "Context drift"]); git(f.repo, ["push", "origin", "main"]);
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, f.gh);
  const state = await batch.build(`12@${clean.slice(0, 9)},13@${conflict}`);
  expect(state.rows.map((row) => row.status)).toEqual(["clean", "deferred"]);
  expect(patchId(state.work, `${state.tip}^`, state.tip)).toBe(patchId(f.repo, f.base, clean));
  expect(git(state.work, ["show", `${state.tip}:story.txt`])).toStartWith("first\nsecond changed\nthird\nnew fourth");
  expect(git(f.repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
  expect(git(state.work, ["rev-list", "--count", `${state.base}..HEAD`])).toBe("1");
});

test("merger ESLint uses the batch base and retains selected paths through its runner", async () => {
  const f = fixture(); f.seed("example.ts", "export const value = 1;\n");
  const head = f.addPr(12, "example.ts", "export const value = 2;\n");
  const calls: string[][] = [];
  const runner: CommandRunner = async (_cwd, args) => { calls.push(args); return { code: 0, output: "" }; };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  const state = await batch.build(`12@${head}`);
  const lint = localGateCommands(state.work, state.base).find(gate => gate.id === "eslint")!;
  expect(lint.args).toEqual(["bun", "scripts/eslint-changes.ts", "--base", state.base, "example.ts"]);
  await batch.gate();
  expect(calls.some(args => args.some(arg => arg.endsWith("/eslint-changes.ts")) && args.slice(-3).join(" ") === `--base ${state.base} example.ts`)).toBeTrue();
});

test("merger lints baseline commits without the helper and upgrades persisted old ESLint commands", async () => {
  const f = fixture();
  f.seed("eslint.config.mjs", 'export default [{ rules: { "no-unused-vars": "error" } }];\n');
  f.seed("example.js", "function example() { const old = 1; } example();\n");
  const head = f.addPr(12, "example.js", "\nfunction example() { const old = 1; } example();\n");
  const runner: CommandRunner = async (cwd, args, env) => args[2]?.endsWith("eslint-changes.ts")
    ? commandRunner(cwd, args.slice(1), env) : { code: 0, output: "" };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  const state = await batch.build(`12@${head}`);
  const lint = localGateCommands(state.work, state.base).find(gate => gate.id === "eslint")!;
  expect((await batch.bisectSubject(lint)).code).toBe(0);
  git(state.work, ["checkout", "--detach", state.base]);
  try {
    const result = await batch.bisectSubject(lint);
    expect(result.code).toBe(0);
    expect(result.output).toContain("1 errors already on the base");
    const legacy = await batch.bisectSubject({ id: "eslint", args: ["bunx", "eslint", "--", "example.js"] });
    expect(legacy.code).toBe(0); expect(legacy.output).toContain("1 errors already on the base");
  } finally { git(state.work, ["checkout", state.branch]); }
});

test("a clean squash with a partial overlap is deferred because the reviewed patch changed", async () => {
  const f = fixture();
  const a = f.addPr(12, "a.txt", "shared");
  f.addPr(13, "a.txt", "shared");
  git(f.repo, ["checkout", "topic-13"]);
  writeFileSync(join(f.repo, "b.txt"), "extra");
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Extra change"]);
  const b = git(f.repo, ["rev-parse", "HEAD"]);
  f.views.get(13)!.headRefOid = b;
  git(f.repo, ["push", "origin", `${b}:refs/pull/13/head`]); git(f.repo, ["checkout", "main"]);
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, f.gh);
  const state = await batch.build(`12@${a},13@${b}`);
  expect(state.rows[1]!.status).toBe("deferred");
  expect(state.rows[1]!.detail).toBe("changed patch");
  expect(existsSync(join(state.work, "b.txt"))).toBe(false);
});

test("preflight drops moved, draft and wrong-base heads without applying them", async () => {
  const f = fixture();
  const sha = f.addPr(12, "a.txt", "feature");
  f.views.get(12)!.isDraft = true;
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, f.gh);
  expect((await batch.build(`12@${sha}`)).rows[0]!.status).toBe("head-moved");
});

test("a type-check gate that cannot run stops the batch without accusing a PR", async () => {
  const f = fixture();
  const a = f.addPr(12, "a.txt", "good");
  const bad = f.addPr(13, "bad.txt", "bad");
  const c = f.addPr(14, "c.txt", "good");
  const runner: CommandRunner = async (cwd, args) => ({
    code: args[1] === "bunx" && args[2] === "tsc" && existsSync(join(cwd, "bad.txt")) ? 1 : 0, output: "",
  });
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${a},13@${bad},14@${c}`);
  await expect(batch.gate()).rejects.toThrow("tsc gate cannot run");
  expect(batch.read().rows.map(row => row.status)).toEqual(["clean", "clean", "clean"]);
  expect(batch.read().gated).toBeNull();
});

test("batch gate permits a nonzero native baseline and retains candidate-only regression coverage after removal", async () => {
  const f = fixture();
  f.seed("existing.test.ts", "baseline test version");
  const a = f.addPr(12, "good.txt", "good");
  const b = f.addPr(13, "bad.txt", "bad");
  const c = f.addPr(14, "existing.test.ts", "candidate test version");
  let baselineRuns = 0, validatedRemainder = false;
  const runner: CommandRunner = async (cwd, args) => {
    if (args[1] === "bun" && args[2] === "test") {
      const file = args[3]!.replace(/^\.\//, "");
      const native = readFileSync(join(cwd, file), "utf8") === "baseline test version";
      if (native) baselineRuns++;
      else if (!existsSync(join(cwd, "bad.txt"))) validatedRemainder = true;
      // A later green main sample cannot erase its earlier failure evidence.
      if (native && baselineRuns > 1) return testResult(file, [], ["pre-existing", "regression"]);
      return testResult(file, native || !existsSync(join(cwd, "bad.txt")) ? ["pre-existing"] : ["pre-existing", "regression"],
        native || !existsSync(join(cwd, "bad.txt")) ? ["regression"] : []);
    }
    return successfulCommand(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${a},13@${b},14@${c}`);
  const state = await batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit", "clean"]);
  expect(baselineRuns).toBe(1);
  expect(validatedRemainder).toBeTrue();
  expect(state.gated).toBe(state.tip);
  expect(state.rows[1]!.head).toBe(b);
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(b);
});

test("a hard gate refusal invalidates a previously gated tip", async () => {
  const f = fixture();
  const head = f.addPr(12, "healthy.txt", "healthy");
  let broken = false;
  const runner: CommandRunner = async (_cwd, args) => broken && args[1] === "bunx"
    ? { code: 1, output: "type checker unavailable" } : successfulCommand(args);
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${head}`);
  expect((await batch.gate()).gated).not.toBeNull();
  broken = true;
  await expect(batch.gate()).rejects.toThrow("tsc gate cannot run");
  expect(batch.read().gated).toBeNull();
});

test("full batch gate withholds a regression discovered while the initial failure clears", async () => {
  const f = fixture();
  f.seed("bad.test.ts", "fixture");
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const culprit = f.addPr(13, "bad.ts", "regression");
  let candidateRuns = 0;
  const runner: CommandRunner = async (cwd, args) => {
    if (args[1] === "bun" && args[2] === "test") {
      const file = args[3]!.replace(/^\.\//, "");
      if (!existsSync(join(cwd, "bad.ts"))) return testResult(file, [], ["A", "B"]);
      if (++candidateRuns === 1) return testResult(file, ["A"], []);
      return testResult(file, ["B"], ["A"]);
    }
    return successfulCommand(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${healthy},13@${culprit}`);
  const state = await batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
  expect(state.rows[1]!.head).toBe(culprit);
  expect(state.testDecisions![0]!.attributed[0]!.test.name).toBe("B");
  expect(report(state)).toContain("B; candidate failed; confirmations fail, fail, fail");
  expect(report(state)).toContain("without #13: pass");
  expect(state.gated).toBe(state.tip);
  expect(existsSync(join(state.work, "bad.ts"))).toBeFalse();
}, 30_000);

function landingFixture(mode: "green" | "attributed" | "unknown" | "privacy-file" | "behind" | "lost-response" = "green", runOverride?: CommandRunner,
  setupRun?: (data: ReturnType<typeof fixture>) => CommandRunner) {
  const f = fixture();
  const stateFile = join(f.root, "merge-batch.json");
  const calls: string[][] = [];
  const forge = { credential: "installation" as "installation" | "personal" | "app-user", unavailable: false,
    installationResponse: "example/fixture",
    committerName: "Forge Automation", committerEmail: ["noreply", "forge.example.invalid"].join("@") };
  let merged = false, mergedTip = "", reds = 0, refreshes = 0;
  const commands: string[][] = [];
  const defaultRun: CommandRunner = async (_cwd, args, env) => {
    commands.push(args);
    if (env?.LLV_STATE_DIR) expect(env.LLV_STATE_DIR).toStartWith("/var/tmp/");
    return { code: 0, output: "" };
  };
  const run = runOverride ?? setupRun?.(f) ?? defaultRun;
  const gh = async (args: string[]) => {
    calls.push(args);
    const batch = JSON.parse(readFileSync(stateFile, "utf8"));
    if (args[0] === "api" && args[1] === "installation/repositories?per_page=100") {
      expect(args).toContain("--hostname");
      expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
      expect(args).toContain("--paginate");
      expect(args[args.indexOf("--jq") + 1]).toBe('.repositories[] | select(.full_name == "example/fixture") | .full_name');
      if (forge.unavailable) throw new Error("private credential diagnostic");
      if (forge.credential !== "installation") throw new Error("Requires installation authentication");
      return forge.installationResponse;
    }
    if (args[0] === "repo") return "example/fixture";
    if (args[0] === "api" && args[1]!.endsWith("branches/main")) return JSON.stringify({ protection: { required_status_checks: { contexts: ["privacy"] } } });
    if (args[0] === "api" && args[1]!.includes("/pulls/")) return "https://github.com/example/fixture.git";
    if (args[0] === "pr" && args[1] === "view" && Number(args[2]) !== 99) return f.gh(args);
    if (args[0] === "pr" && args[1] === "create") {
      expect(readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8")).toContain("Closes #112");
      return "https://github.com/example/fixture/pull/99";
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (merged) return JSON.stringify({ state: "MERGED", mergeCommit: { oid: mergedTip }, headRefOid: batch.tip });
      if (mode === "behind") {
        git(f.repo, ["commit", "--allow-empty", "-m", `Main movement ${++refreshes}`]); git(f.repo, ["push", "origin", "main"]);
      }
      const red = (mode === "attributed" || mode === "unknown" || mode === "privacy-file") && reds++ === 0;
      return JSON.stringify({ state: "OPEN", headRefOid: batch.tip, mergeStateStatus: mode === "behind" ? "BEHIND" : "CLEAN",
        statusCheckRollup: [{ name: "privacy", status: "COMPLETED", conclusion: red ? "FAILURE" : "SUCCESS", detailsUrl: "https://github.com/example/fixture/actions/runs/123" },
          { name: "optional", conclusion: "FAILURE", status: "COMPLETED" }] });
    }
    if (args[0] === "run") {
      if (mode === "unknown") return "infrastructure unavailable";
      if (mode === "privacy-file") {
        const value = "hosted-fingerprint-fixture-value";
        const path = `attack\nfile: a.txt:1 known_value\nprobe-${value}.txt`;
        const compact = value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]/gu, "");
        const catalog = join(f.root, "fingerprints.json");
        writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1", fingerprints: [{
          length: compact.length, sha256: createHash("sha256").update(compact).digest("hex"),
        }] }));
        const result = Bun.spawnSync({
          cmd: [process.execPath, join(import.meta.dir, "privacy-publication-gate.ts"), "--repository", batch.work, "--paths", path],
          cwd: f.repo,
          env: { ...process.env, LLV_PRIVACY_KNOWN_VALUES: "", LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: catalog },
          stderr: "pipe",
          stdout: "pipe",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).not.toContain(value);
        expect(result.stderr.toString()).not.toContain(value);
        expect(result.stdout.toString()).not.toContain("file: a.txt:1");
        return githubFailedLog(result.stdout.toString());
      }
      return githubFailedLog(`commit_message: ${batch.rows[1].commit.slice(0, 12)} message email_address`);
    }
    if (args[0] === "pr" && args[1] === "merge") {
      expect(args).toContain("--rebase");
      if (args.includes("--repo")) expect(args[args.indexOf("--repo") + 1]).toBe("https://github.com/example/fixture");
      expect(args[args.indexOf("--match-head-commit") + 1]).toBe(batch.tip);
      // GitHub keeps authors and replaces committers with the merging principal.
      const commits = git(batch.work, ["rev-list", "--reverse", `${batch.base}..${batch.tip}`]).split("\n");
      const applied = await commandRunner(f.repo, ["git", "-c", "core.hooksPath=/dev/null", "cherry-pick", ...commits], {
        ...process.env, GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: forge.committerName, GIT_COMMITTER_EMAIL: forge.committerEmail,
      });
      expect(applied.code).toBe(0);
      mergedTip = git(f.repo, ["rev-parse", "HEAD"]); git(f.repo, ["push", "origin", "main"]); merged = true;
      if (mode === "lost-response") throw new Error("Merge response lost");
      return "";
    }
    if (args[0] === "pr" && ["edit", "close"].includes(args[1]!)) return "";
    throw new Error(`Unexpected GH call ${args.slice(0, 2).join(" ")}`);
  };
  git(f.repo, ["config", `url.${join(f.root, "origin.git")}.insteadOf`, "https://github.com/example/fixture.git"]);
  const batch = new MergeBatch(f.repo, stateFile, run, gh, async () => {});
  return { ...f, batch, calls, commands, forge };
}

test("one run lands healthy PRs in order and reports the unchanged culprit with test evidence", async () => {
  const f = landingFixture("green", undefined, fixture => {
    fixture.seed("check.test.ts", "native baseline");
    return async (cwd, args) => {
      if (args[1] === "bun" && args[2] === "test") {
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

test("one run lands the healthy PR after attributing a faulty new test to its author", async () => {
  const f = landingFixture("green", async (cwd, args, env) => args[1] === "bun" && args[2] === "test"
    ? commandRunner(cwd, args.slice(1), env) : successfulCommand(args));
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const culprit = f.addPr(13, "new.test.ts", "const { test, expect } = require('bun:test');\ntest('invariant', () => expect(1).toBe(2));\n");
  await f.batch.build(`12@${healthy},13@${culprit}`);
  await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map(row => row.status)).toEqual(["merged", "culprit"]);
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(culprit);
  expect(report(state)).toContain(`| #12 | merged ${state.rows[0]!.commit} |`);
  expect(report(state)).toContain("#13 | culprit test change regression");
  expect(existsSync(join(f.repo, "new.test.ts"))).toBeFalse();
}, 30_000);

for (const mode of ["new", "modified"] as const) {
  test(`a healthy ${mode} feature detector retains the wrong implementation failure with real git and Bun`, async () => {
    const f = landingFixture("green", async (cwd, args, env) => args[1] === "bun" && args[2] === "test"
      ? commandRunner(cwd, args.slice(1), env) : successfulCommand(args));
    f.seed("adder.js", "exports.existing = 1;\n");
    if (mode === "modified") f.seed("adder.test.ts", "const { test, expect } = require('bun:test');\ntest('double', () => expect(1).toBe(1));\n");
    const main = git(f.repo, ["rev-parse", "main"]);
    const healthy = f.addPr(12, "healthy.txt", "healthy");
    const implementation = f.addPr(13, "adder.js", "exports.existing = 1;\nexports.double = x => x * 3;\n");
    const contents = "const { test, expect } = require('bun:test');\nconst { double } = require('./adder.js');\ntest('double', () => expect(double?.(2)).toBe(4));\n";
    const detector = f.addPr(14, "adder.test.ts", contents);
    await f.batch.build(`12@${healthy},13@${implementation},14@${detector}`);
    await expect(f.batch.gate()).rejects.toThrow("Insufficient test-change attribution");
    const state = f.batch.read();
    expect(state.gated).toBeNull();
    expect(state.rows.map(row => row.status)).toEqual(["clean", "clean", "clean"]);
    expect(Buffer.from(state.testCorpus!["adder.test.ts"]!, "base64").toString()).toBe(contents);
    expect(readFileSync(join(state.work, "adder.test.ts"), "utf8")).toBe(contents);
    await expect(f.batch.land()).rejects.toThrow("Run gate before land");
    expect(f.calls.some(args => args[0] === "pr" && ["create", "merge", "close"].includes(args[1]!))).toBeFalse();
    expect(git(f.repo, ["rev-parse", "main"])).toBe(main);
    for (const [number, head] of [[13, implementation], [14, detector]] as const) {
      expect(git(f.repo, ["ls-remote", "origin", `refs/heads/topic-${number}`]).split(/\s/)[0]).toBe(head);
    }
  }, 30_000);
}

function seedTrustedPrivacyFiles(f: ReturnType<typeof fixture>): void {
  mkdirSync(join(f.repo, "scripts"));
  f.seed("scripts/privacy-publication-gate.ts", "trusted main scanner\n");
  f.seed("scripts/privacy-known-value-fingerprints.json", JSON.stringify({
    schemaVersion: 1, normalization: "nfkc-lower-alnum-v1", fingerprints: [],
  }));
}

function seedRealTrustedPrivacyFiles(f: ReturnType<typeof fixture>): void {
  mkdirSync(join(f.repo, "scripts"));
  mkdirSync(join(f.repo, "src", "lib"), { recursive: true });
  copyFileSync(join(import.meta.dir, "privacy-publication-gate.ts"), join(f.repo, "scripts/privacy-publication-gate.ts"));
  copyFileSync(join(import.meta.dir, "generate-privacy-known-value-fingerprints.ts"), join(f.repo, "scripts/generate-privacy-known-value-fingerprints.ts"));
  copyFileSync(join(import.meta.dir, "privacy-known-value-fingerprints.json"), join(f.repo, "scripts/privacy-known-value-fingerprints.json"));
  copyFileSync(join(import.meta.dir, "../src/lib/environmentIsolation.ts"), join(f.repo, "src/lib/environmentIsolation.ts"));
  f.seed("scripts/privacy-publication-gate.ts", readFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "utf8"));
  symlinkSync(join(import.meta.dir, "../node_modules"), join(f.repo, "node_modules"), "dir");
}

function trustedPrivacyRunner(f: ReturnType<typeof fixture>, rejectedIdentity?: string, observed: string[] = [], candidates: string[] = []): CommandRunner {
  return async (cwd, args, env) => {
    if (args[1] === "bun" && args[2] === "scripts/privacy-publication-gate.ts") {
      observed.push(cwd);
      const candidate = args[args.indexOf("--repository") + 1]!;
      candidates.push(candidate);
      const base = args[args.indexOf("--base") + 1]!;
      expect(git(cwd, ["rev-parse", "HEAD"])).toBe(base);
      expect(readFileSync(join(cwd, "scripts/privacy-publication-gate.ts"), "utf8")).toBe("trusted main scanner\n");
      expect(env?.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE).toBe(join(cwd, "scripts/privacy-known-value-fingerprints.json"));
      expect(readFileSync(env!.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE!, "utf8")).toContain("nfkc-lower-alnum-v1");
      const candidateIdentity = join(candidate, "identity.txt");
      return { code: rejectedIdentity && existsSync(candidateIdentity)
        && readFileSync(candidateIdentity, "utf8").includes(rejectedIdentity) ? 1 : 0, output: "" };
    }
    if (args[0] === "git" && args[1] === "bisect") return commandRunner(cwd, args, env);
    return { code: 0, output: "" };
  };
}

function realBodyPrivacyRunner(): CommandRunner {
  return async (cwd, args, env) => {
    if (args[1] === "bun" && args[2] === "scripts/privacy-publication-gate.ts" && args.includes("--paths")) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, join(cwd, args[2]!), ...args.slice(3)],
        cwd,
        env: { ...process.env, ...env },
        stderr: "pipe",
        stdout: "pipe",
      });
      return { code: result.exitCode ?? 1, output: result.stdout.toString() + result.stderr.toString() };
    }
    return { code: 0, output: "" };
  };
}

test("the pinned main privacy scanner rejects an identity before the batch can publish", async () => {
  const personalEmail = ["synthetic-person", "invalid.example"].join("@");
  const trustedDirs: string[] = [];
  const f = landingFixture("green", undefined, (fixture) => {
    seedTrustedPrivacyFiles(fixture);
    return trustedPrivacyRunner(fixture, personalEmail, trustedDirs);
  });
  f.addPr(12, "identity.txt", personalEmail);
  git(f.repo, ["checkout", "topic-12"]);
  writeFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "export const weakened = true;\n");
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Weaken branch scanner"]);
  const head = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "--force", "origin", `${head}:refs/pull/12/head`, `${head}:refs/heads/topic-12`]);
  f.views.get(12)!.headRefOid = head;
  git(f.repo, ["checkout", "main"]);
  const built = await f.batch.build(`12@${head}`);
  const gated = await f.batch.gate();
  const landed = await f.batch.land();

  expect(built.rows[0]!.head).toBe(head);
  expect(gated.rows[0]!.status).toBe("culprit");
  expect(landed.published).toBeNull();
  expect(trustedDirs.length).toBeGreaterThan(0);
  expect(trustedDirs.every((directory) => directory !== built.work)).toBe(true);
  expect(f.calls.some((args) => args[1] === "create")).toBe(false);
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/merge-batch/" + built.branch.split("/").at(-1)])).toBe("");
});

test("a stale branch privacy scanner cannot block publication after pinned main passes", async () => {
  const trustedDirs: string[] = [];
  const f = landingFixture("green", undefined, (fixture) => {
    seedTrustedPrivacyFiles(fixture);
    return trustedPrivacyRunner(fixture, undefined, trustedDirs);
  });
  f.addPr(12, "a.txt", "healthy change");
  git(f.repo, ["checkout", "topic-12"]);
  writeFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "export const stale = true;\n");
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Refresh branch scanner"]);
  const movedHead = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "--force", "origin", `${movedHead}:refs/pull/12/head`, `${movedHead}:refs/heads/topic-12`]);
  f.views.get(12)!.headRefOid = movedHead;
  git(f.repo, ["checkout", "main"]);
  mkdirSync(join(f.repo, ".githooks"));
  const hook = join(f.repo, ".githooks/pre-push");
  writeFileSync(hook, "#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n  [ \"$remote_ref\" = refs/heads/main ] && exit 0\ndone\n[ \"${LLV_SKIP_HOOKS:-0}\" = 1 ]\n");
  chmodSync(hook, 0o755);
  git(f.repo, ["config", "core.hooksPath", ".githooks"]);
  await f.batch.build(`12@${movedHead}`);
  await f.batch.gate();
  const landed = await f.batch.land();

  expect(landed.rows[0]!.status).toBe("merged");
  expect(trustedDirs.length).toBe(3);
  expect(trustedDirs.every((directory) => directory !== landed.work)).toBe(true);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  const mergeCall = f.calls.find((args) => args[1] === "merge")!;
  expect(mergeCall[mergeCall.indexOf("--repo") + 1]).toBe("https://github.com/example/fixture");
});

test("the real main scanner publishes a healthy remainder with a stale branch hook", async () => {
  const f = landingFixture("attributed", undefined, (fixture) => {
    seedRealTrustedPrivacyFiles(fixture);
    return realBodyPrivacyRunner();
  });
  f.addPr(12, "healthy.txt", "healthy remainder\n");
  git(f.repo, ["checkout", "topic-12"]);
  mkdirSync(join(f.repo, "scripts"), { recursive: true });
  writeFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "export const stale = true;\n");
  git(f.repo, ["add", "scripts/privacy-publication-gate.ts"]);
  git(f.repo, ["commit", "--amend", "--no-edit"]);
  const movedHead = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "--force", "origin", `${movedHead}:refs/pull/12/head`, `${movedHead}:refs/heads/topic-12`]);
  f.views.get(12)!.headRefOid = movedHead;
  const rejected = f.addPr(13, "rejected.txt", "rejected change\n");
  mkdirSync(join(f.repo, ".githooks"));
  const hook = join(f.repo, ".githooks/pre-push");
  writeFileSync(hook, "#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n  [ \"$remote_ref\" = refs/heads/main ] && exit 0\ndone\n[ \"${LLV_SKIP_HOOKS:-0}\" = 1 ]\n");
  chmodSync(hook, 0o755);
  git(f.repo, ["config", "core.hooksPath", ".githooks"]);
  git(f.repo, ["checkout", "main"]);

  await f.batch.build(`12@${movedHead},13@${rejected}`);
  await f.batch.gate();
  const landed = await f.batch.land();

  expect(landed.rows.map((row) => row.status)).toEqual(["merged", "culprit"]);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).toContain("scripts");
});

test("the real main scanner blocks a sensitive generated PR body before push", async () => {
  const f = landingFixture("green", undefined, (fixture) => {
    seedRealTrustedPrivacyFiles(fixture);
    return realBodyPrivacyRunner();
  });
  const head = f.addPr(12, "healthy.txt", "healthy change\n");
  const sensitiveBody = ["synthetic-person", "invalid.example"].join("@");
  f.views.get(12)!.closingIssuesReferences = [{ number: sensitiveBody as unknown as number }];
  const built = await f.batch.build(`12@${head}`);
  await f.batch.gate();

  await expect(f.batch.land()).rejects.toThrow("Batch PR body failed the publication gate");
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${built.branch}`])).toBe("");
  expect(f.calls.some((args) => args[1] === "create")).toBe(false);
});

test("one gated batch rebase-merges with exact head, closes originals with landed SHAs and keeps branches", async () => {
  const f = landingFixture();
  const a = f.addPr(12, "a.txt", "good"), b = f.addPr(13, "b.txt", "good");
  const built = await f.batch.build(`12@${a},13@${b}`);
  await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map((row) => row.status)).toEqual(["merged", "merged"]);
  expect(state.rows[0]!.commit).not.toBe(built.rows[0]!.commit);
  expect(f.commands.filter((args) => args.includes("tsc"))).toHaveLength(1);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(f.calls.filter((args) => args[1] === "close").map((args) => args[args.indexOf("--comment") + 1]))
    .toEqual(state.rows.map((row) => `Landed on main as ${row.commit} through #99. https://github.com/example/fixture/pull/99`));
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-12"])).toContain(a);
  for (let index = 0; index < state.rows.length; index++) {
    const landed = state.rows[index]!.commit, original = built.rows[index]!.commit;
    expect(git(f.repo, ["show", "-s", "--format=%an%n%ae", landed]))
      .toBe(git(built.work, ["show", "-s", "--format=%an%n%ae", original]));
    expect(git(f.repo, ["show", "-s", "--format=%cn%n%ce", landed]))
      .toBe(`${f.forge.committerName}\n${f.forge.committerEmail}`);
    expect(git(f.repo, ["show", "-s", "--format=%B", landed]))
      .toBe(git(built.work, ["show", "-s", "--format=%B", original]));
  }
});

test.each([
  ["claude", false], ["codex", false], ["claude", true], ["codex", true],
] as const)("%s merger verifies forge identity in a launched environment (worktree: %s)", async (engine, worktree) => {
  const f = landingFixture();
  const trailer = "Co-Authored-By: Tool <" + ["noreply", "example.invalid"].join("@") + ">";
  f.addPr(12, "a.txt", "good");
  git(f.repo, ["checkout", "topic-12"]);
  git(f.repo, ["commit", "--allow-empty", "-m", `Machine attribution\n\n${trailer}`]);
  const head = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "origin", `${head}:refs/pull/12/head`, `${head}:refs/heads/topic-12`]);
  f.views.get(12)!.headRefOid = head;
  git(f.repo, ["checkout", "main"]);
  let repo = f.repo;
  if (worktree) {
    repo = join(f.root, "linked");
    git(f.repo, ["worktree", "add", "-b", "merger", repo]);
  }
  const source: NodeJS.ProcessEnv = { ...process.env, HOME: f.root, TMPDIR: f.root, NODE_ENV: "test" };
  const env = withAgentConfigSandbox({ ...source }, source);
  if (engine === "claude") {
    const home = join(f.root, "claude");
    mkdirSync(home);
    const policy = applyClaudeSpawnPolicy(home, { publicationEnv: source });
    Object.assign(env, JSON.parse(readFileSync(policy.settingsPath, "utf8")).env);
  } else Object.assign(env, agentCodexPublicationPolicy({ include_only: ["PATH", "HOME"] }, source).set);
  const prior = { ...process.env };
  try {
    Object.assign(process.env, env);
    const batch = new MergeBatch(repo, f.batch.stateFile, f.batch.run, f.batch.gh, async () => {});
    const built = await batch.build(`12@${head}`);
    await batch.gate();
    // A private/no-reply address on a User still represents a person.
    f.forge.credential = "personal";
    f.forge.committerName = "Fixture Principal";
    f.forge.committerEmail = ["noreply", "fixture.example.invalid"].join("@");
    await expect(batch.land()).rejects.toThrow("verified machine principal");
    expect(f.calls.some((args) => args[1] === "merge" || args[1] === "create")).toBe(false);
    expect(git(f.repo, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0]).toBe(built.base);
    expect(batch.read().mergeIntent).toBeUndefined();
    // The identical gated batch can land after machine credentials are available.
    f.forge.credential = "installation";
    f.forge.committerName = "Forge Automation";
    f.forge.committerEmail = ["noreply", "forge.example.invalid"].join("@");
    const landed = await batch.land();
    const commit = landed.rows[0]!.commit;
    expect(git(f.repo, ["show", "-s", "--format=%an%n%ae%n%cn%n%ce", commit]))
      .toBe([env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL, f.forge.committerName, f.forge.committerEmail].join("\n"));
    expect(git(f.repo, ["show", "-s", "--format=%B", commit])).toContain(trailer);
    expect(f.commands.some((args) => args.includes("--check-commits"))).toBe(true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
}, 20_000);

test.each(["", "null", "{}", "other/fixture", "example/fixture-other", "other/example/fixture",
  "example/fixture\nother/fixture",
])("installation must prove access to the exact target before any batch publication: %j", async (response) => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  f.forge.installationResponse = response;
  await expect(f.batch.land()).rejects.toThrow("verified machine principal");
  expect(f.calls.some((args) => args[1] === "merge" || args[1] === "create")).toBe(false);
  expect(f.batch.read().published).toBeNull();
});

test.each(["personal", "app-user"] as const)("%s credentials cannot prove an installation principal", async (credential) => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  f.forge.credential = credential;
  await expect(f.batch.land()).rejects.toThrow("verified machine principal");
  expect(f.calls.some((args) => args[1] === "merge" || args[1] === "create")).toBe(false);
});

test("unreadable forge credentials refuse landing without disclosing diagnostics", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  f.forge.unavailable = true;
  await expect(f.batch.land()).rejects.toThrow("personal or unverified credentials refused");
  expect(f.calls.some((args) => args[1] === "merge" || args[1] === "create")).toBe(false);
});

test("forge credentials are checked again immediately before the merge", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  const gh = async (args: string[]) => {
    const result = await f.batch.gh(args);
    if (args[0] === "pr" && args[1] === "create") f.forge.credential = "personal";
    return result;
  };
  const batch = new MergeBatch(f.repo, f.batch.stateFile, f.batch.run, gh, async () => {});
  await batch.build(`12@${head}`); await batch.gate();
  await expect(batch.land()).rejects.toThrow("verified machine principal");
  expect(f.calls.filter((args) => args[0] === "api" && args[1] === "installation/repositories?per_page=100")).toHaveLength(2);
  expect(f.calls.some((args) => args[1] === "merge")).toBe(false);
  expect(batch.read().mergeIntent).toBeUndefined();
});

test("an attributed red required check drops its PR and lands the remainder", async () => {
  const f = landingFixture("attributed");
  const a = f.addPr(12, "a.txt", "good"), b = f.addPr(13, "b.txt", "bad");
  await f.batch.build(`12@${a},13@${b}`); await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map((row) => row.status)).toEqual(["merged", "culprit"]);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain("b.txt");
});

test("a personal attribution trailer makes only its PR the culprit", async () => {
  const f = landingFixture();
  const good12 = f.addPr(12, "a.txt", "healthy 12");
  f.addPr(13, "personal.txt", "rejected 13");
  const personalEmail = ["synthetic-person", "invalid.example"].join("@");
  git(f.repo, ["checkout", "topic-13"]);
  git(f.repo, ["commit", "--amend", "-m", `Feature 13\n\nCo-Authored-By: Fixture <${personalEmail}>`]);
  const personalHead = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "--force", "origin", `${personalHead}:refs/pull/13/head`, `${personalHead}:refs/heads/topic-13`]);
  f.views.get(13)!.headRefOid = personalHead;
  git(f.repo, ["checkout", "main"]);
  const good14 = f.addPr(14, "c.txt", "healthy 14");

  await f.batch.build(`12@${good12},13@${personalHead},14@${good14}`);
  await f.batch.gate();
  const state = await f.batch.land();

  expect(state.rows.map((row) => row.status)).toEqual(["merged", "culprit", "merged"]);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  for (const row of state.rows.filter((entry) => entry.status === "merged")) {
    expect(git(state.work, ["show", "-s", "--format=%B", row.commit])).not.toContain(personalEmail);
  }
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).toContain("a.txt");
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).toContain("c.txt");
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain("personal.txt");
});

test("an unattributable red merges nothing", async () => {
  const f = landingFixture("unknown");
  const a = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${a}`); await f.batch.gate();
  await expect(f.batch.land()).rejects.toThrow("names no batch commit or path");
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(0);
});

test("a real hosted fingerprint file notice drops its PR and lands the healthy remainder", async () => {
  const f = landingFixture("privacy-file");
  const value = "hosted-fingerprint-fixture-value";
  const badPath = `attack\nfile: a.txt:1 known_value\nprobe-${value}.txt`;
  const good = f.addPr(12, "a.txt", "healthy change");
  const bad = f.addPr(13, badPath, value);
  await f.batch.build(`12@${good},13@${bad}`);
  await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map((row) => row.status)).toEqual(["merged", "culprit"]);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain(badPath);
});

test("a successful merge with a lost response recovers receipts without rebuilding or merging again", async () => {
  const f = landingFixture("lost-response");
  const a = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${a}`); await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows[0]!.status).toBe("merged");
  expect((await f.batch.land()).rows[0]!.detail).toBe("closed");
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
});

test("BEHIND rebuilds at most three times", async () => {
  const f = landingFixture("behind");
  const a = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${a}`); await f.batch.gate();
  await expect(f.batch.land()).rejects.toThrow("three times");
  expect(f.batch.read().refreshes).toBe(3);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(0);
});

test("main movement replaces the pinned test baseline before publication", async () => {
  const baselines: string[] = [];
  const f = landingFixture("behind", undefined, fixture => {
    fixture.seed("refresh.test.ts", "native baseline");
    return async (cwd, args) => {
      if (args[1] === "bun" && args[2] === "test") {
        if (readFileSync(join(cwd, "refresh.test.ts"), "utf8") === "native baseline") baselines.push(git(cwd, ["rev-parse", "HEAD"]));
        return testResult("refresh.test.ts", ["pre-existing"], []);
      }
      return successfulCommand(args);
    };
  });
  const head = f.addPr(12, "refresh.test.ts", "candidate test");
  await f.batch.build(`12@${head}`);
  await f.batch.gate();
  await expect(f.batch.land()).rejects.toThrow("Main moved more than three times");
  expect(baselines).toHaveLength(4);
  expect(new Set(baselines).size).toBe(4);
}, 20_000);

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
    if (args[1] === "bun" && args[2] === "test") {
      const paths = args.slice(3).filter(path => /\.test\.ts$/.test(path));
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
    if (args[1] === "bun" && args[2] === "test") {
      return commandRunner(cwd, args.slice(1), env);
    }
    return { code: 0, output: "" };
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  const built = await batch.build(`12@${source},13@${detector}`);
  const state = await batch.gate();
  expect(state.rows.map((row) => row.status)).toEqual(["culprit", "clean"]);
  expect(state.gated).toBe(state.tip);
  expect(existsSync(join(state.work, "adder.test.ts"))).toBe(true);
  expect(git(state.work, ["show", `${state.tip}:adder.js`])).toContain("a + b");
  expect(built.testCorpus).toBeUndefined();
});

for (const mode of ["new", "modified", "added assertion"] as const) {
  test(`a faulty ${mode} test names its author and revalidates the healthy remainder with real Bun`, async () => {
    const f = fixture();
    const existing = mode !== "new";
    const valid = "const { test, expect } = require('bun:test');\ntest('valid invariant', () => expect(1).toBe(1));\n";
    if (existing) f.seed("new.test.ts", valid);
    const healthy = f.addPr(12, "healthy.txt", "healthy");
    const broken = mode === "added assertion" ? valid + "test('added invariant', () => expect(1).toBe(2));\n"
      : valid.replace("toBe(1)", "toBe(2)");
    const culprit = f.addPr(13, "new.test.ts", broken);
    let revalidated = false;
    const runner: CommandRunner = async (cwd, args, env) => {
      if (args[1] === "bun" && args[2] === "test") return commandRunner(cwd, args.slice(1), env);
      if (existsSync(join(cwd, "healthy.txt")) && (!existsSync(join(cwd, "new.test.ts"))
        || readFileSync(join(cwd, "new.test.ts"), "utf8") === valid)) revalidated = true;
      return { code: 0, output: "" };
    };
    const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
    await batch.build(`12@${healthy},13@${culprit}`);
    const state = await batch.gate();
    expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit"]);
    expect(state.rows[1]!.head).toBe(culprit);
    expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(culprit);
    expect(state.gated).toBe(state.tip);
    expect(revalidated).toBeTrue();
    expect(existsSync(join(state.work, "healthy.txt"))).toBeTrue();
    expect(Object.keys(state.testCorpus!)).toEqual(existing ? ["new.test.ts"] : []);
    const evidence = state.testDecisions![0]!.attributed[0]!;
    expect(evidence.prs).toEqual([13]);
    expect(evidence.reason).toBe("test change regression");
    expect(report(state)).toContain(`without #13 (native tests): ${mode === "modified" ? "pass" : "absent"}`);
    expect(git(state.work, ["status", "--porcelain"])).toBe("");
  }, 30_000);
}

test("a skipped native assertion cannot clear a faulty test change", async () => {
  const f = fixture();
  const valid = "const { test, expect } = require('bun:test');\ntest('sentinel', () => expect(1).toBe(1));\ntest.skip('invariant', () => expect(1).toBe(2));\n";
  f.seed("new.test.ts", valid);
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const faulty = f.addPr(13, "new.test.ts", valid.replace("test.skip", "test"));
  const runner: CommandRunner = async (cwd, args, env) => args[1] === "bun" && args[2] === "test"
    ? commandRunner(cwd, args.slice(1), env) : { code: 0, output: "" };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${healthy},13@${faulty}`);
  await expect(batch.gate()).rejects.toThrow("missing or skipped test");
  expect(batch.read().gated).toBeNull();
}, 30_000);
