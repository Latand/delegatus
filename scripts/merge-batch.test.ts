import { expect, test, afterEach } from "bun:test";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { attributeBatchTests, compareBatchTests, fileFault, INCOMPLETE_FILE, parseReviewedPrs, batchMessage, touchedTests, noticePrs, git, patchId, MergeBatch, requiredVerdict, nextRefresh, MAX_REQUIRED_CHECK_POLLS, MAX_TEST_CONFIRMATION_RUNS } from "./merge-batch";
import type { TestRun, TestSite } from "./local-gate-tests";
import { readWorktreeProvenance } from "../src/lib/pipelines/worktreeProvenance";
import * as merger from "./merge-batch";
import { cleanupBatchFixtures, fixture, successfulCommand } from "./merge-batch.fixture";

afterEach(cleanupBatchFixtures);

const site = (name: string, file = "example.test.ts"): TestSite => ({ file, suite: "suite", name, kind: "test", occurrence: 0 });

const recorded = (failures: TestSite[] = [], passed: TestSite[] = []): TestRun => ({
  failures, passed, completed: [...new Set([...failures, ...passed].map(test => test.file))], elapsedMs: 0,
});

test("batch comparison permits pre-existing failures and judges new tests on the candidate", () => {
  const existing = site("existing"), added = site("added"), newFile = site("new file", "added.test.ts");
  expect(compareBatchTests(recorded([existing]), recorded([existing]))).toEqual({ preExisting: [existing], introduced: [], uncompared: [] });
  expect(compareBatchTests(recorded([existing]), recorded([added, newFile]))).toEqual({ preExisting: [], introduced: [added, newFile], uncompared: [] });
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

test("a round-four failure with earlier and later candidate passes is intermittent", async () => {
  const initial = site("initial"), delaying = site("delaying"), late = site("late intermittent");
  let runs = 0;
  const decision = await attributeBatchTests(recorded([], [initial, delaying, late]), recorded([initial], [late]), [12, 13],
    async () => {
      runs++;
      return recorded([initial, ...(runs >= 3 ? [delaying] : []), ...(runs === 4 ? [late] : [])], runs === 4 ? [] : [late]);
    }, async removed => removed.includes(13) ? recorded([], [initial, delaying]) : recorded([initial, delaying]));
  expect(runs).toBe(MAX_TEST_CONFIRMATION_RUNS);
  expect(decision.intermittent).toEqual([late]);
  expect(decision.attributed.map(entry => [entry.test, entry.prs])).toEqual([[initial, [13]], [delaying, [13]]]);
  expect(decision.attributed[1]!.confirmation).toEqual(["fail", "fail", "fail"]);
});

test.each([false, true])("a round-four failure needs only one observed candidate pass (earlier: %s)", async earlier => {
  const initial = site("initial"), delaying = site("delaying"), late = site("late intermittent");
  let runs = 0;
  const decision = await attributeBatchTests(recorded(), recorded([initial], earlier ? [late] : []), [12],
    async () => {
      runs++;
      return recorded([initial, ...(runs >= 3 ? [delaying] : []), ...(runs >= 4 && (earlier || runs !== 5) ? [late] : [])],
        !earlier && runs === 5 ? [late] : []);
    }, async () => recorded([], [initial, delaying]));
  expect(runs).toBe(MAX_TEST_CONFIRMATION_RUNS);
  expect(decision.intermittent).toEqual([late]);
  expect(decision.attributed.map(entry => entry.test)).toEqual([initial, delaying]);
});

test.each([4, 5, 6])("a round-%s failure without any candidate pass exhausts the budget and names the case", async firstFailure => {
  const initial = site("initial"), delaying = site("delaying"), late = site("late regression");
  let runs = 0;
  await expect(attributeBatchTests(recorded([], [late]), recorded([initial]), [12], async () => {
    runs++;
    return recorded([initial, ...(runs >= 3 ? [delaying] : []), ...(runs >= firstFailure ? [late] : [])]);
  }, async () => { throw new Error("must not attribute before confirmation completes"); }))
    .rejects.toThrow("Candidate confirmation budget exhausted with unclassified failures: example.test.ts > suite > late regression; batch not gated");
  expect(runs).toBe(MAX_TEST_CONFIRMATION_RUNS);
});

test("a between-test error first seen during confirmation is confirmed and attributed like a failing case", async () => {
  const failure = site("initial"), error = fileFault("example.test.ts", "<between-tests error> Error: late");
  // The initial file did not complete, so it supplies no pass for the later fault.
  const decision = await attributeBatchTests(recorded([], [failure]), { ...recorded([failure]), completed: [] }, [12, 13],
    async () => recorded([failure, error]), async removed => removed.includes(13) ? recorded([], [failure]) : recorded([failure, error]));
  expect(decision.attributed.map(entry => [entry.test.kind, entry.prs])).toEqual([["test", [13]], ["error", [13]]]);
});

test("a failure without clearing removal evidence holds the batch", async () => {
  const failure = site("new feature", "feature.test.ts");
  await expect(attributeBatchTests(recorded(), recorded([failure]), [12, 13, 14],
    async () => recorded([failure]), async () => recorded([failure])))
    .rejects.toThrow("Cannot establish attribution for feature.test.ts > suite > new feature; detectors retained; batch not gated"
      + " (rule: no removal clears it, so nothing narrows it to a PR)");
});

test("the all-removed control refuses a failure no single removal clears", async () => {
  const failure = site("reviewed invariant", "feature.test.ts");
  const calls: number[][] = [];
  await expect(attributeBatchTests(recorded(), recorded([failure]), [12, 13], async () => recorded([failure]),
    async removed => { calls.push(removed); return recorded([failure]); }))
    .rejects.toThrow("Cannot establish attribution for feature.test.ts > suite > reviewed invariant;");
  expect(calls).toEqual([[12], [13], [12, 13]]);
});

test("member-added tests name their owners when the retained detector cannot clear", async () => {
  const failure = site("added case");
  const decision = await attributeBatchTests(recorded(), recorded([failure]), [12, 13, 14],
    async () => recorded([failure]), async () => recorded(), undefined, {
      memberTests: async sites => {
        expect(sites).toEqual([failure]);
        return { preExisting: [], added: [{ test: failure, prs: [12, 14] }] };
      },
    });
  expect(decision.attributed).toEqual([{ test: failure, prs: [12, 14], reason: "member-specific: adds the failing test",
    confirmation: ["fail", "fail", "fail"], removals: [
      { removed: [12], outcome: "fail" }, { removed: [13], outcome: "fail" },
      { removed: [14], outcome: "fail" }, { removed: [12, 13, 14], outcome: "fail" },
    ] }]);
});

test("a cross-file namesake still needs removal evidence before it can be pre-existing", async () => {
  const moved = site("moved failure", "destination.test.ts");
  const original = { ...moved, file: "original.test.ts", suite: "original suite" };
  expect(compareBatchTests(recorded([original]), recorded([moved])).introduced).toEqual([moved]);
  expect(compareBatchTests(recorded([original], [moved]), recorded([moved])).introduced).toEqual([moved]);
  const decision = await attributeBatchTests(recorded([original]), recorded([moved]), [12, 13],
    async () => recorded([moved]), async removed => removed.includes(12) ? recorded([], [moved]) : recorded([moved]), undefined,
    { memberTests: async () => { throw new Error("clearing removal already proves the regression"); } });
  expect(decision.preExisting).toEqual([]);
  expect(decision.attributed.map(entry => [entry.prs, entry.reason])).toEqual([[[12], "test regression"]]);
});

test("an attribution refusal records its known decisions before throwing", async () => {
  const existing = site("existing"), regression = site("regression"), unknown = site("unknown");
  const snapshots: merger.BatchTestDecision[] = [];
  await expect(attributeBatchTests(recorded([existing], [regression, unknown]), recorded([existing, regression, unknown]), [12, 13],
    async () => recorded([existing, regression, unknown]),
    async removed => removed.includes(12) ? recorded([unknown], [regression]) : recorded([regression, unknown]), undefined,
    { record: decision => snapshots.push(structuredClone(decision)) })).rejects.toThrow("Cannot establish attribution");
  expect(snapshots.at(-1)!.preExisting).toEqual([existing]);
  expect(snapshots.at(-1)!.attributed.map(entry => [entry.test, entry.prs, entry.reason])).toEqual([[regression, [12], "test regression"]]);
  expect(snapshots.at(-1)!.unattributed!.map(entry => [entry.test, entry.confirmation, entry.removals.at(-1)]))
    .toEqual([[unknown, ["fail", "fail", "fail"], { removed: [12, 13], outcome: "fail" }]]);
});

test("a removal that cannot run retains the confirmed failure inventory", async () => {
  const failure = site("confirmed before removal");
  const snapshots: merger.BatchTestDecision[] = [];
  await expect(attributeBatchTests(recorded(), recorded([failure]), [12], async () => recorded([failure]),
    async () => { throw new Error("removal dependency gate cannot run"); }, undefined,
    { record: decision => snapshots.push(structuredClone(decision)) })).rejects.toThrow("removal dependency gate cannot run");
  expect(snapshots.at(-1)!.unattributed).toEqual([{ test: failure, prs: [], reason: "attribution pending",
    confirmation: ["fail", "fail", "fail"], removals: [] }]);
});

test("(a) native main's own file faults and failures are pre-existing; the same fault on a clean main file is new", async () => {
  const assertion = site("fails on main"), mainError = fileFault("example.test.ts", "<between-tests error> Error: page closed");
  const candidateError = fileFault("example.test.ts", "<between-tests error> waitFor: Target page, context or browser has been closed");
  expect(compareBatchTests(recorded([assertion, mainError]), recorded([assertion, candidateError])))
    .toEqual({ preExisting: [assertion, candidateError], introduced: [], uncompared: [] });
  expect(compareBatchTests(recorded([], [assertion]), recorded([candidateError])).introduced).toEqual([candidateError]);
  // Missing confirmations are no passing evidence: attribution cannot be proven.
  const failure = site("failure");
  await expect(attributeBatchTests(recorded(), recorded([failure]), [12], async () => recorded(),
    async () => recorded())).rejects.toThrow("Cannot establish attribution");
});

test("(a) a file native main cannot complete is compared only on the cases both sides completed", async () => {
  const incomplete = fileFault("browser.test.ts", INCOMPLETE_FILE), unreported = site("unreported on main", "browser.test.ts");
  // `passed` stands for what main's rerun of the named cases reported.
  const salvaged = site("main passed", "browser.test.ts"), candidateFault = fileFault("browser.test.ts", INCOMPLETE_FILE);
  const base = { ...recorded([incomplete], [salvaged]), completed: [] };
  const candidate = recorded([unreported, salvaged, candidateFault]);
  expect(compareBatchTests(base, candidate)).toEqual({ preExisting: [candidateFault], introduced: [salvaged], uncompared: [unreported] });
  const decision = await attributeBatchTests(base, recorded([unreported, candidateFault]), [12],
    async () => { throw new Error("nothing new to confirm"); }, async () => { throw new Error("must not attribute"); });
  expect(decision).toEqual({ preExisting: [candidateFault], intermittent: [], attributed: [], uncompared: [unreported] });
});

test("(a)(c) native main's named cases rerun alone when its file aborts, and decide the comparison", async () => {
  const incomplete = fileFault("value.test.ts", INCOMPLETE_FILE);
  const shared = site("shared invariant", "value.test.ts"), mainRed = site("red on main", "value.test.ts"), candidateOnly = site("new case", "value.test.ts");
  const base = { ...recorded([incomplete]), completed: [] };
  const probes: TestSite[][] = [], removals: TestSite[][] = [];
  const decision = await attributeBatchTests(base, recorded([shared, mainRed, candidateOnly]), [12, 13],
    async () => recorded([shared, mainRed, candidateOnly]),
    async (removed, _files, focus) => {
      removals.push(focus);
      // Removing #13 restores main's abort: only the named case reports.
      return removed.includes(13) ? { ...recorded([incomplete], [shared]), completed: [] } : recorded([shared, mainRed, candidateOnly]);
    },
    async sites => { probes.push(sites); return { ...recorded([mainRed], [shared]), completed: [] }; });
  expect(probes).toEqual([[shared, mainRed, candidateOnly]]);
  expect(removals).toEqual([[shared], [shared]]);
  expect(decision.preExisting).toEqual([mainRed]);
  expect(decision.uncompared).toEqual([candidateOnly]);
  expect(decision.attributed.map(entry => [entry.test.name, entry.prs, entry.reason])).toEqual([["shared invariant", [13], "test regression"]]);
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

test("gh 2.45 builds a batch with the same closing lines despite its unsupported JSON field", async () => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  f.views.get(12)!.closingIssuesReferences = [{ number: 112 }, { number: 113 }];
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view" && args[args.indexOf("--json") + 1]?.split(",").includes("closingIssuesReferences")) {
      throw new Error('Unknown JSON field: "closingIssuesReferences"\nAvailable fields:\n  baseRefName\n  body\n  headRefOid\n  number');
    }
    if (args[0] === "api" && args[1] === "graphql") return "112\n113";
    return f.gh(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, gh);
  const state = await batch.build(`12@${head}`);
  expect(state.rows.map(row => row.status)).toEqual(["clean"]);
  expect(state.rows[0]!.view.closingIssuesReferences).toEqual([{ number: 112 }, { number: 113 }]);
  expect(batch["body"](state).split("\n").filter(line => line.startsWith("Closes "))).toEqual(["Closes #112", "Closes #113"]);
  expect(calls.some(args => args[0] === "api" && args[1] === "graphql" && args.includes("--paginate"))).toBeTrue();
});

test.each(["missing flag", "help failed", "old metadata", "unknown version"])("gh without a required capability refuses before worktree or bootstrap: %s", async fault => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  const before = git(f.repo, ["worktree", "list", "--porcelain"]);
  const files = readdirSync(f.root).sort();
  const commands: string[][] = [], calls: string[][] = [];
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), async (_cwd, args) => {
    commands.push(args); return successfulCommand(args);
  }, async args => {
    calls.push(args);
    if (args[0] === "--version") {
      if (fault === "old metadata") return "gh version 2.17.0 (fixture)";
      if (fault === "unknown version") throw new Error("version unavailable");
      return f.gh(args);
    }
    if (args.join(" ") === "pr merge --help") {
      if (fault === "help failed") throw new Error("unknown command");
      return "Usage: gh pr merge [flags]\n  --rebase";
    }
    return f.gh(args);
  });
  const metadataMissing = ["old metadata", "unknown version"].includes(fault);
  await expect(batch.build(`12@${head}`)).rejects.toThrow(metadataMissing
    ? "Missing gh capability: pr view --json headRefOid (requires gh >= 2.18.0)"
    : "Missing gh capability: pr merge --match-head-commit (requires gh >= 2.13.0)");
  expect(calls).toEqual(metadataMissing ? [["--version"]] : [["--version"], ["pr", "merge", "--help"]]);
  expect(commands).toEqual([]);
  expect(git(f.repo, ["worktree", "list", "--porcelain"])).toBe(before);
  expect(readdirSync(f.root).sort()).toEqual(files);
});

test.each(["2.18.0", "3.0.0"])("gh %s can build at the metadata floor or a later major", async version => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, async args =>
    args[0] === "--version" ? `gh version ${version} (fixture)` : f.gh(args));
  const state = await batch.build(`12@${head}`);
  expect(state.rows.map(row => row.status)).toEqual(["clean"]);
  expect(batch["body"](state)).toContain("Closes #112");
});

test.each([0, 101])("GraphQL closing references preserve all %i issues in the batch body", async count => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  const references = Array.from({ length: count }, (_, index) => ({ number: index + 100 }));
  f.views.get(12)!.closingIssuesReferences = references;
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, async args => {
    if (args[0] === "api" && args[1] === "graphql") {
      expect(args).toContain("--paginate");
      expect(args).toContain("owner={owner}");
      expect(args).toContain("name={repo}");
      expect(args).toContain("number=12");
      expect(args[args.indexOf("--jq") + 1]).toBe(".data.repository.pullRequest.closingIssuesReferences.nodes[].number");
    }
    return f.gh(args);
  });
  const state = await batch.build(`12@${head}`);
  expect(state.rows[0]!.view.closingIssuesReferences).toEqual(references);
  expect(batch["body"](state).split("\n").filter(line => line.startsWith("Closes ")))
    .toEqual(references.map(issue => `Closes #${issue.number}`));
});

test.each(["refused", "invalid"])("an unreadable closing reference response refuses batch construction: %s", async fault => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "healthy");
  const commands: string[][] = [];
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), async (_cwd, args) => {
    commands.push(args); return successfulCommand(args);
  }, async args => {
    if (args[0] === "api" && args[1] === "graphql") {
      if (fault === "refused") throw new Error("GraphQL read refused");
      return "112\ninvalid";
    }
    return f.gh(args);
  });
  await expect(batch.build(`12@${head}`)).rejects.toThrow(fault === "refused" ? "GraphQL read refused" : "Invalid closing issue response");
  expect(commands).toEqual([]);
});

test("real squash accepts context drift, preserves reviewed patch and defers every conflict", async () => {
  const f = fixture();
  const clean = f.addPr(12, "story.txt", "first\nsecond changed\nthird\nfourth\nfifth\n");
  const conflict = f.addPr(13, "story.txt", "first\nsecond alternative\nthird\nfourth\nfifth\n");
  writeFileSync(join(f.repo, "story.txt"), "first\nsecond\nthird\nnew fourth\nfifth\n");
  git(f.repo, ["commit", "-am", "Context drift"]); git(f.repo, ["push", "origin", "main"]);
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), f.good, f.gh);
  const state = await batch.build(`12@${clean.slice(0, 9)},13@${conflict}`);
  expect(state.rows.map((row) => row.status)).toEqual(["clean", "deferred"]);
  expect(readWorktreeProvenance(state.work)).toMatchObject({ creator: "merge-batch", id: state.branch });
  expect(patchId(state.work, `${state.tip}^`, state.tip)).toBe(patchId(f.repo, f.base, clean));
  expect(git(state.work, ["show", `${state.tip}:story.txt`])).toStartWith("first\nsecond changed\nthird\nnew fourth");
  expect(git(f.repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
  expect(git(state.work, ["rev-list", "--count", `${state.base}..HEAD`])).toBe("1");
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

test("batch commit subjects and copied summaries use publication prose", () => {
  expect(batchMessage(12, "Виправити публікацію", "Fix GitHub publication text", []))
    .toBe("Fix GitHub publication text (#12)\n\nFix GitHub publication text\n");
  const message = batchMessage(12, "Виправити публікацію", "Виправлено публікацію", []);
  expect(message).toStartWith("Implement project changes (#12)");
  expect(message).not.toContain("публікацію");
});
