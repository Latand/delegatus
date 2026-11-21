import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { text as streamText } from "node:stream/consumers";
import { GATE_SLOT, INCOMPLETE_FILE, MAX_REQUIRED_CHECK_POLLS, MAX_TEST_CONFIRMATION_RUNS, attributeBatchTests, batchMessage, commandRunner, compareBatchTests, fileFault, git, localGateCommands, nextRefresh, noticePrs, parseReviewedPrs, patchId, report, requiredVerdict, touchedTests, type CommandRunner } from "./merge-batch";
import type { TestRun, TestSite } from "./local-gate-tests";
import { isolatedEnvironment } from "./local-gate";
import { readWorktreeProvenance } from "../src/lib/pipelines/worktreeProvenance";
import * as merger from "./merge-batch";
import { bindGateCheckRoot, runGateCheckTool } from "../src/lib/runtime/gateCheckTool";
import { resolveGateRun } from "../src/lib/runtime/gateCheckRecord";
import { ownFixtureTree, stopFixtureTree } from "../src/lib/testing/fixtureProcess";
import { MergeBatch, extendPr, fixture, fixtureRoot, landingFixture, seedTrustedPrivacyFiles, successfulCommand, testResult, trustedPrivacyRunner, registerMergeBatchFixtures } from "./merge-batch.fixture";

registerMergeBatchFixtures();

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

test.each([
  { phase: "gate", locked: false },
  { phase: "land", locked: false },
  { phase: "gate", locked: true },
  { phase: "land", locked: true },
])("a native $phase failure remains available by run ID after the batch exits (locked: $locked)", async ({ phase, locked }) => {
  const root = fixtureRoot("batch-wait-");
  const binding = bindGateCheckRoot(root)!;
  const state = fixtureRoot("batch-state-");
  const lock = join(state, "merge-batch.json.lock");
  const owner = join(lock, "fixture-owner");
  if (locked) {
    mkdirSync(lock);
    writeFileSync(owner, "existing owner");
  }
  const result = await commandRunner(root, [process.execPath, join(import.meta.dir, "merge-batch.ts"), phase], {
    ...isolatedEnvironment(join(root, "isolated"), process.env), TMPDIR: state,
    LLV_GATE_CHECK_LAUNCH_ROOT: binding.root, LLV_GATE_CHECK_ROOT: binding.physicalRoot,
    LLV_GATE_CHECK_ROOT_DIRECTORY_IDENTITY: binding.rootDirectoryIdentity,
  });
  expect(result.code).toBe(1);
  const runId = /runId=([a-f0-9]{64})/.exec(result.output)?.[1];
  expect(runId).toBeDefined();
  const response = await runGateCheckTool({ runId, reason: phase }, binding, new AbortController().signal);
  expect(response.success).toBe(true);
  expect(JSON.parse(response.contentItems[0]!.text)).toMatchObject({
    terminal: true, code: 1, runId, tail: expect.stringContaining(locked ? "EEXIST" : "ENOENT"),
  });
  expect(existsSync(lock)).toBe(locked);
  if (locked) expect(readFileSync(owner, "utf8")).toBe("existing owner");
});

test.each([
  { phase: "gate", result: "refused" },
  { phase: "land", result: "completed" },
  { phase: "land", result: "recorder lost" },
])("one native $phase wait observes $result across separate roots", async ({ phase, result }) => {
  const f = fixture();
  const launch = join(f.root, "launch");
  const state = join(f.root, "batch");
  const bin = join(f.root, "bin");
  for (const directory of [launch, state, bin]) mkdirSync(directory);
  const binding = bindGateCheckRoot(launch)!;
  const stateFile = join(state, "merge-batch.json");
  const lock = stateFile + ".lock";
  const batch = new MergeBatch(f.repo, stateFile, f.good, f.gh);
  const head = f.addPr(12, "unused.txt", "draft fixture");
  f.views.get(12)!.isDraft = true;
  await batch.build(`12@${head}`);
  if (phase === "land") await batch.gate();

  // The production CLI blocks inside an external command with the lock held.
  // A local barrier lets the test attach before supplying the command result.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      entered.resolve();
      await release.promise;
      return new Response(null, { status: 204 });
    },
  });
  const abort = new AbortController();
  const barrier = join(bin, "barrier.ts");
  writeFileSync(barrier, 'const response = await fetch(process.env.BATCH_FIXTURE_BARRIER!); if (!response.ok) process.exit(1);\nexport {};\n');
  const realGit = Bun.which("git")!;
  // A launched Git shim must resolve its delegate outside this fixture bin.
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$BATCH_FIXTURE_PHASE" = gate ] && [ "$PWD" = "$BATCH_FIXTURE_REPO" ] && [ "$*" = "rev-parse --path-format=absolute --git-common-dir" ]; then
  "$BATCH_FIXTURE_BUN" "$BATCH_FIXTURE_SCRIPT" || exit 1
  printf '%s\\n' "different common directory"
  exit 0
fi
PATH="$BATCH_FIXTURE_PATH" exec "$BATCH_FIXTURE_GIT" "$@"
`, { mode: 0o700 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "repo view")
    "$BATCH_FIXTURE_BUN" "$BATCH_FIXTURE_SCRIPT" || exit 1
    printf '%s\\n' "example/fixture" ;;
  "api repos/example/fixture/branches/main/protection")
    printf '%s\\n' '{"required_status_checks":{"strict":true,"contexts":["privacy"]}}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  const env = {
    ...isolatedEnvironment(join(f.root, "isolated"), process.env), TMPDIR: state, PATH: `${bin}:${process.env.PATH}`,
    LLV_GATE_CHECK_LAUNCH_ROOT: binding.root, LLV_GATE_CHECK_ROOT: binding.physicalRoot,
    LLV_GATE_CHECK_ROOT_DIRECTORY_IDENTITY: binding.rootDirectoryIdentity,
    BATCH_FIXTURE_BARRIER: server.url.href, BATCH_FIXTURE_REPO: f.repo, BATCH_FIXTURE_PHASE: phase,
    BATCH_FIXTURE_GIT: realGit, BATCH_FIXTURE_PATH: process.env.PATH, BATCH_FIXTURE_BUN: process.execPath, BATCH_FIXTURE_SCRIPT: barrier,
  };
  const command = [process.execPath, join(import.meta.dir, "merge-batch.ts"), phase];
  const child = ownFixtureTree(spawn(command[0]!, command.slice(1), { cwd: f.repo, env, stdio: ["ignore", "pipe", "pipe"] }));
  const closed = once(child, "close").then(([code]) => code as number | null);
  const stdout = streamText(child.stdout);
  const stderr = streamText(child.stderr);
  try {
    const ready = setTimeout(() => entered.reject(new Error("Batch did not reach its barrier")), 10_000);
    try {
      await Promise.race([entered.promise, closed.then(async code => {
        throw new Error(`Batch exited before reaching its barrier (${code}): ${await stderr}`);
      })]);
    } finally { clearTimeout(ready); }
    expect(existsSync(lock)).toBe(true);
    const [entry] = readdirSync(join(launch, ".gate-runs"));
    const runId = entry!.replace(/\.json$/, "");
    const record = resolveGateRun(launch, runId);
    const args = { runId, reason: phase };
    const readFresh = async (mode: "expire" | "read") => {
      const reader = await commandRunner(import.meta.dir, [process.execPath, "-e", `
        import { bindGateCheckRoot, runGateCheckTool } from "../src/lib/runtime/gateCheckTool";
        const [root, args, mode] = process.argv.slice(-3);
        if (mode === "expire") {
          let now = 0;
          const schedule = setTimeout;
          Object.defineProperty(performance, "now", { value: () => now });
          globalThis.setTimeout = (callback) => {
            now = 24 * 60 * 60_000;
            return schedule(callback, 0);
          };
        }
        const result = await runGateCheckTool(JSON.parse(args!), bindGateCheckRoot(root!), new AbortController().signal);
        console.log(JSON.stringify(result));
      `, launch, JSON.stringify(args), mode], env);
      expect(reader.code).toBe(0);
      return JSON.parse(reader.output);
    };
    let settled = false;
    const waiting = runGateCheckTool(args, binding, abort.signal).then(answer => { settled = true; return answer; });
    const expired = await readFresh("expire");
    expect(expired.success).toBe(true);
    expect(JSON.parse(expired.contentItems[0].text)).toMatchObject({ terminal: false, outcome: "unknown", state: "running", code: 124, runId });
    expect(settled).toBe(false);
    expect(existsSync(lock)).toBe(true);

    if (result === "recorder lost") {
      await stopFixtureTree(child);
      await closed;
      // Abort only as a bounded red control if owner loss fails to wake the wait.
      const deadline = setTimeout(() => abort.abort(), 5_000);
      try {
        const answer = await waiting;
        const late = await readFresh("read");
        expect(answer.success).toBe(false);
        expect(answer.contentItems[0]!.text).toContain(`(runId=${runId}): gate recorder ownership unavailable; no exit result recorded`);
        expect(late).toEqual(answer);
        expect((await stdout).match(/runId=[a-f0-9]{64}/g)).toEqual([`runId=${runId}`]);
        expect(resolveGateRun(launch, runId)).toEqual(record);
        expect(existsSync(`${record.log}.gate/exit`)).toBe(false);
        expect(existsSync(lock)).toBe(true);
      } finally { clearTimeout(deadline); }
      return;
    }

    const contention = await commandRunner(f.repo, command, env);
    expect(contention.code).toBe(1);
    expect(contention.output).toContain("EEXIST");
    expect(settled).toBe(false);
    expect(existsSync(lock)).toBe(true);
    release.resolve();
    const answer = await waiting;
    const code = result === "completed" ? 0 : 1;
    expect(answer.success).toBe(true);
    expect(JSON.parse(answer.contentItems[0]!.text)).toMatchObject({ terminal: true, code, runId });
    expect(existsSync(lock)).toBe(false);
    expect(await closed).toBe(code);
    expect((await stdout).match(/runId=[a-f0-9]{64}/g)).toEqual([`runId=${runId}`]);
    expect(await readFresh("read")).toEqual(answer);
  } finally {
    abort.abort();
    try { await stopFixtureTree(child); }
    finally {
      release.resolve();
      await server.stop(true);
    }
    await closed;
  }
}, 20_000);

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
  const runner: CommandRunner = async (cwd, args, env) => args[3]?.endsWith("eslint-changes.ts")
    ? commandRunner(cwd, args.slice(2), env) : { code: 0, output: "" };
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
  const runner: CommandRunner = async (cwd, args, env) => {
    if (args[0] === "git" && args[1] === "bisect") {
      return commandRunner(cwd, ["git", "bisect", "run", "node", "-e", "process.exit(require('node:fs').existsSync('bad.txt') ? 1 : 0)"], env);
    }
    return { code: args[2] === "bunx" && args[3] === "tsc" && existsSync(join(cwd, "bad.txt")) ? 1 : 0, output: "" };
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${a},13@${bad},14@${c}`);
  await expect(batch.gate()).rejects.toThrow("tsc gate cannot run");
  expect(batch.read().rows.map(row => row.status)).toEqual(["clean", "clean", "clean"]);
  expect(batch.read().gated).toBeNull();
});

test("batch gate samples fresh native main for every candidate after removal", async () => {
  const f = fixture();
  f.seed("existing.test.ts", "baseline test version");
  const a = f.addPr(12, "good.txt", "good");
  const b = f.addPr(13, "bad.txt", "bad");
  const c = f.addPr(14, "existing.test.ts", "candidate test version");
  let baselineRuns = 0, validatedRemainder = false;
  const runner: CommandRunner = async (cwd, args) => {
    if (args[2] === "bun" && args[3] === "test") {
      const file = args[4]!.replace(/^\.\//, "");
      const native = readFileSync(join(cwd, file), "utf8") === "baseline test version";
      if (native) baselineRuns++;
      else if (!existsSync(join(cwd, "bad.txt"))) validatedRemainder = true;
      return testResult(file, native || !existsSync(join(cwd, "bad.txt")) ? ["pre-existing"] : ["pre-existing", "regression"],
        native || !existsSync(join(cwd, "bad.txt")) ? ["regression"] : []);
    }
    return successfulCommand(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${a},13@${b},14@${c}`);
  const state = await batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit", "clean"]);
  expect(baselineRuns).toBeGreaterThan(1);
  expect(validatedRemainder).toBeTrue();
  expect(state.gated?.tip).toBe(state.tip);
  expect(state.rows[1]!.head).toBe(b);
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(b);
});

test("a hard gate refusal invalidates a previously gated tip", async () => {
  const f = fixture();
  const head = f.addPr(12, "healthy.txt", "healthy");
  let broken = false;
  const runner: CommandRunner = async (_cwd, args) => broken && args[2] === "bunx"
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
    if (args[2] === "bun" && args[3] === "test") {
      const file = args[4]!.replace(/^\.\//, "");
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
  expect(state.attributionLog[0]!.test.name).toBe("B");
  expect(report(state)).toContain("B; candidate failed; confirmations fail, fail, fail");
  expect(report(state)).toContain("without #13: pass");
  expect(state.gated?.tip).toBe(state.tip);
  expect(existsSync(join(state.work, "bad.ts"))).toBeFalse();
}, 30_000);

function betweenTestError(result: ReturnType<typeof testResult>, message: string) {
  return { ...result, code: 1, output: `# Unhandled error between tests\n-------------------------------\nerror: ${message}\n-------------------------------\n 1 error\n` };
}

test("(a)(c)(d) main's own red never stops the batch; a newly broken case drops only its PR; gates run one at a time through gate-slot.sh", async () => {
  const f = fixture();
  f.seed("board.ts", "export const board = 1;\n");
  f.seed("board.test.ts", "native board detector");
  f.seed("panel.ts", "export const panel = 1;\n");
  f.seed("panel.test.ts", "native panel detector");
  const healthy = f.addPr(12, "board.ts", "export const board = 2;\n");
  extendPr(f, 12, { "panel.ts": "export const panel = 2;\n", "healthy.txt": "healthy" });
  const reviewed = f.views.get(12)!.headRefOid as string;
  const culprit = f.addPr(13, "bad.txt", "bad");
  const other = f.addPr(14, "other.txt", "other");
  let inFlight = 0, maxInFlight = 0;
  const wrappers = new Set<string>(), testEnvs: NodeJS.ProcessEnv[] = [];
  const runner: CommandRunner = async (cwd, args, env) => {
    expect(args[0]).toBe("/bin/bash"); wrappers.add(args[1]!);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await Bun.sleep(1);
    inFlight--;
    if (args[2] !== "bun" || args[3] !== "test") return successfulCommand(args);
    testEnvs.push(env!);
    const file = args[4]!.replace(/^\.\//, "");
    const main = !existsSync(join(cwd, "healthy.txt")) && !existsSync(join(cwd, "bad.txt")) && !existsSync(join(cwd, "other.txt"));
    if (file === "panel.test.ts") {
      // Native main's browser-backed run dies before writing its report.
      return main ? { code: 1, output: "error: Target page, context or browser has been closed\n" }
        : testResult(file, ["never completed on main"], ["panel"]);
    }
    const broken = existsSync(join(cwd, "bad.txt"));
    return betweenTestError(testResult(file, ["main red", ...(broken ? ["regression"] : [])], broken ? [] : ["regression"]),
      "waitFor: Target page, context or browser has been closed");
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${reviewed},13@${culprit},14@${other}`);
  const state = await batch.gate();
  expect(state.rows.map(row => row.status)).toEqual(["clean", "culprit", "clean"]);
  expect(state.gated?.candidate.prs.map(pr => pr.number)).toEqual([12, 14]);
  expect(state.attributionLog.map(entry => [entry.test.name, entry.prs, entry.reason])).toEqual([["regression", [13], "test regression"]]);
  const text = report(state);
  expect(text).toContain("Pre-existing failures (permitted):\n- board.test.ts > suite > main red\n- board.test.ts >  > <between-tests error>");
  expect(text).toContain("Not compared (native main could not complete the file):\n- panel.test.ts > suite > never completed on main");
  expect([...wrappers]).toEqual([GATE_SLOT]);
  expect(maxInFlight).toBe(1);
  for (const env of testEnvs) {
    expect(env.LLV_VIEWER_CONTROL_URL).toBe("http://127.0.0.1:9");
    expect(env.HOME).toBe(join(dirname(env.LLV_STATE_DIR!), "home"));
    expect(env.LLV_STATE_OWNER).toBeUndefined();
  }
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(culprit);
}, 60_000);

test("(d) concurrent gate requests still run one at a time inside the slot wrapper", async () => {
  const f = fixture();
  const head = f.addPr(12, "a.txt", "a");
  let inFlight = 0, maxInFlight = 0;
  const order: string[] = [];
  const runner: CommandRunner = async (_cwd, args) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`start ${args.at(-1)}`);
    await Bun.sleep(5);
    order.push(`end ${args.at(-1)}`);
    inFlight--;
    return { code: args.at(-1) === "first" ? 1 : 0, output: "" };
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${head}`);
  const results = await Promise.all(["first", "second", "third"].map(name => batch.bisectSubject({ id: "tsc", args: ["bunx", "tsc", name] })));
  expect(results.map(result => result.code)).toEqual([1, 0, 0]);
  expect(maxInFlight).toBe(1);
  expect(order).toEqual(["start first", "end first", "start second", "end second", "start third", "end third"]);
});

test("(e) full browser campaigns are opt-in and are named as skipped by default", async () => {
  const f = fixture();
  f.seed("kanban.browser.test.tsx", "browser driver");
  const head = f.addPr(12, "kanban.browser.test.tsx", "browser driver with a new describe block");
  const sampled: string[] = [];
  const runner: CommandRunner = async (_cwd, args) => {
    if (args[2] === "bun" && args[3] === "test") sampled.push(args[4]!);
    return successfulCommand(args);
  };
  const batch = new MergeBatch(f.repo, join(f.root, "merge-batch.json"), runner, f.gh);
  await batch.build(`12@${head}`);
  const lean = await batch.gate({ browser: false });
  expect(sampled).toEqual([]);
  expect(lean.gated!.notApplicable).toEqual([{ source: "native candidate", file: "kanban.browser.test.tsx",
    reason: "full browser campaign: opt in with gate --browser" }]);
  expect(localGateCommands(lean.work, lean.base).some(gate => gate.id === "tests")).toBeFalse();
  expect(localGateCommands(lean.work, lean.base, true).find(gate => gate.id === "tests")!.args).toEqual(["bun", "test", "./kanban.browser.test.tsx"]);
  const opted = await batch.gate({ browser: true });
  expect(opted.gated!.notApplicable).toEqual([]);
  expect(sampled).toContain("./kanban.browser.test.tsx");
});

function privacyScannerRuntimeFiles(entry = "scripts/privacy-publication-gate.ts", seen = new Set<string>()): string[] {
  if (seen.has(entry)) return [...seen];
  seen.add(entry);
  const source = readFileSync(join(import.meta.dir, "..", entry), "utf8");
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    privacyScannerRuntimeFiles(join(dirname(entry), `${match[1]!}.ts`).replaceAll("\\", "/"), seen);
  }
  return [...seen];
}

function seedRealTrustedPrivacyFiles(f: ReturnType<typeof fixture>): void {
  for (const file of [...privacyScannerRuntimeFiles(), "scripts/privacy-known-value-fingerprints.json"]) {
    mkdirSync(dirname(join(f.repo, file)), { recursive: true });
    copyFileSync(join(import.meta.dir, "..", file), join(f.repo, file));
  }
  f.seed("scripts/privacy-publication-gate.ts", readFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "utf8"));
  symlinkSync(join(import.meta.dir, "../node_modules"), join(f.repo, "node_modules"), "dir");
}

function realBodyPrivacyRunner(results: { code: number; output: string }[] = []): CommandRunner {
  return async (cwd, args, env) => {
    if (args[2] === "bun" && args[3] === "scripts/privacy-publication-gate.ts" && args.includes("--paths")) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, join(cwd, args[3]!), ...args.slice(4)],
        cwd,
        env: { ...process.env, ...env },
        stderr: "pipe",
        stdout: "pipe",
      });
      const scan = { code: result.exitCode ?? 1, output: result.stdout.toString() + result.stderr.toString() };
      results.push(scan);
      return scan;
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
  const scans: { code: number; output: string }[] = [];
  const f = landingFixture("attributed", undefined, (fixture) => {
    seedRealTrustedPrivacyFiles(fixture);
    return realBodyPrivacyRunner(scans);
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
  git(f.repo, ["config", "core.hooksPath", join(f.repo, ".githooks")]);
  git(f.repo, ["checkout", "main"]);

  const built = await f.batch.build(`12@${movedHead},13@${rejected}`);
  // The shared hook must refuse from the actual batch worktree without the
  // trusted-scanner bypass; a dry run leaves the remote untouched.
  const staleHook = await commandRunner(built.work, ["git", "push", "--dry-run", "origin", `${built.tip}:refs/heads/${built.branch}`],
    { ...process.env, LLV_SKIP_HOOKS: "0" });
  expect(staleHook.code).toBe(1);
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${built.branch}`])).toBe("");
  await f.batch.gate();
  const landed = await f.batch.land();

  expect(landed.rows.map((row) => row.status)).toEqual(["merged", "culprit"]);
  expect(scans).toHaveLength(2);
  for (const scan of scans) {
    expect(scan.code).toBe(0);
    expect(scan.output).toBe("PRIVACY GATE: PASS\n");
  }
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).toContain("scripts");
});

test("the real main scanner blocks a sensitive generated PR body before push", async () => {
  const scans: { code: number; output: string }[] = [];
  const f = landingFixture("green", undefined, (fixture) => {
    seedRealTrustedPrivacyFiles(fixture);
    return realBodyPrivacyRunner(scans);
  });
  const head = f.addPr(12, "healthy.txt", "healthy change\n");
  const sensitiveBody = ["synthetic-person", "invalid.example"].join("@");
  const built = await f.batch.build(`12@${head}`);
  await f.batch.gate();
  // Exercise the publication fence even if persisted metadata is corrupted.
  const state = f.batch.read();
  state.rows[0]!.view.closingIssuesReferences = [{ number: sensitiveBody as unknown as number }];
  f.batch.save(state);

  await expect(f.batch.land()).rejects.toThrow("Batch PR body failed the publication gate");
  expect(scans).toHaveLength(1);
  expect(scans[0]!.code).toBe(1);
  expect(scans[0]!.output).toContain("email_address: 1");
  expect(scans[0]!.output).not.toContain(sensitiveBody);
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${built.branch}`])).toBe("");
  expect(f.calls.some((args) => args[1] === "create")).toBe(false);
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
