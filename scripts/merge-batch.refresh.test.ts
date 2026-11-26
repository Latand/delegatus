import { expect, test, afterAll, afterEach, beforeAll } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { report, git, MAX_REQUIRED_CHECK_POLLS, commandRunner, type CommandRunner, candidateOf } from "./merge-batch";
import { isolatedEnvironment } from "./local-gate";
import { batchView, cleanupBatchFixtures, FIXED_CARRY_TIME, isolateBatchGateLocks, landingFixture, restartBatch, successfulCommand, testResult, unchangedCulprit } from "./merge-batch.fixture";

afterEach(cleanupBatchFixtures);
let restoreGateLocks: () => void;
beforeAll(() => { restoreGateLocks = isolateBatchGateLocks(); });
afterAll(() => restoreGateLocks());

test("T1 four main-only moves carry the original validation, rerun publication privacy and merge the fourth tip", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "value.ts", "export const value = 1;\n");
  await f.batch.build(`12@${head}`);
  const validated = structuredClone((await f.batch.gate()).gated!);
  f.commands.length = 0;
  let moves = 0;
  const published: string[] = [];
  const gh = async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view" && args[2] === "99" && moves < 4) {
      f.seed(`advance-${++moves}.txt`, "main movement");
      return batchView(f, "SUCCESS", "BEHIND");
    }
    if (args[0] === "pr" && ["create", "edit"].includes(args[1]!)) published.push(f.batch.read().tip);
    return f.batch.gh(args);
  };
  const state = await restartBatch(f, gh).land();
  expect(state.refreshes).toBe(0);
  expect(state.gated!.candidate).toEqual(validated.candidate);
  expect(state.gated!.tip).toBe(validated.tip);
  expect(state.gated!.members).toEqual(validated.members);
  expect(state.gated!.carried).toHaveLength(4);
  expect(state.gated!.carried!.every(entry => entry.at === FIXED_CARRY_TIME)).toBeTrue();
  expect(new Set(state.gated!.carried!.map(entry => entry.main)).size).toBe(4);
  expect(state.gated!.carried!.map(entry => entry.tip)).toEqual(published.slice(1));
  expect(f.commands.filter(args => args.includes("--check-commits"))).toHaveLength(5);
  expect(f.commands.filter(args => args.includes("--paths"))).toHaveLength(5);
  expect(f.commands.some(args => args.includes("tsc") || args.some(arg => arg.endsWith("eslint-changes.ts")) || args[3] === "test")).toBeFalse();
  expect(f.calls.find(args => args[1] === "merge")!.at(-1)).toBe(state.gated!.carried!.at(-1)!.tip);
  expect(report(state)).toContain(`Fully validated: ${JSON.stringify(validated.candidate)}`);
  expect(report(state)).toContain(`Carried: main ${state.base}`);
}, 30_000);

test.each([false, true])("T2 main moves during tests; conflict=%s determines whether the remainder needs a full gate", async conflict => {
  let moved = false, baselines = 0, types = 0;
  const f = landingFixture("green", async (cwd, args) => {
    if (args.includes("tsc")) types++;
    if (args[2] === "bun" && args[3] === "test") {
      if (readFileSync(join(cwd, "refresh.test.ts"), "utf8") === "native baseline") baselines++;
      if (!moved && cwd === f.batch.read().work) {
        moved = true;
        f.seed(conflict ? "story.txt" : "advance.txt", conflict ? "conflicting story\n" : "main moved");
      }
      return testResult("refresh.test.ts");
    }
    return successfulCommand(args);
  });
  f.seed("refresh.test.ts", "native baseline");
  const head = f.addPr(12, "refresh.test.ts", "candidate test");
  const other = f.addPr(13, "story.txt", "reviewed story\n");
  const built = await f.batch.build(`12@${head},13@${other}`);
  const state = await restartBatch(f).gate();
  expect(types).toBe(conflict ? 2 : 1);
  expect(baselines).toBe(conflict ? 2 : 1);
  expect(state.refreshes).toBe(conflict ? 1 : 0);
  expect(state.rows.map(row => row.status)).toEqual(["clean", conflict ? "deferred" : "clean"]);
  expect(state.gated!.candidate.main).toBe(conflict ? state.base : built.base);
  expect(state.gated!.carried).toHaveLength(conflict ? 0 : 1);
  expect((await restartBatch(f).land()).rows[0]!.status).toBe("merged");
}, 20_000);

test("a member head moving during hosted checks stays open and the rebuilt tip gets its own checks", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy"), other = f.addPr(13, "b.txt", "moving");
  const built = await f.batch.build(`12@${head},13@${other}`);
  f.commands.length = 0;
  let moved = false;
  const gh = async (args: string[]) => {
    const result = await f.batch.gh(args);
    if (!moved && args[0] === "pr" && args[1] === "view" && args[2] === "99") {
      moved = true; f.views.get(13)!.headRefOid = f.base;
    }
    return result;
  };
  const state = await restartBatch(f, gh).land();
  expect(state.rows.map(row => row.status)).toEqual(["merged", "head-moved"]);
  expect(state.refreshes).toBe(1);
  expect(f.commands).toHaveLength(4);
  expect(state.gated).toBeNull();
  expect(f.calls.find(args => args[1] === "merge")!.at(-1)).toBe(state.tip);
  expect(state.tip).not.toBe(built.tip);
  expect(f.calls.filter(args => args[1] === "close").map(args => args[2])).toEqual(["12"]);
});

test("an unattributable hosted red on a refreshed tip stops without local work across restarts", async () => {
  const f = landingFixture();
  const a = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${a}`); await f.batch.gate();
  let moved = false, fallbackLogs = 0;
  const gh = async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view" && args[2] === "99") {
      if (!moved) { moved = true; f.seed("advance.txt", "new main"); return batchView(f, "SUCCESS", "BEHIND"); }
      return batchView(f, "FAILURE");
    }
    if (args[0] === "run") { fallbackLogs++; return "unattributable hosted failure"; }
    return f.batch.gh(args);
  };
  f.commands.length = 0;
  await expect(restartBatch(f, gh).land()).rejects.toThrow("Cannot attribute red required checks");
  expect(f.commands.filter(args => args.includes("tsc"))).toHaveLength(0);
  expect(f.batch.read().refreshes).toBe(0);
  expect(f.batch.read().gated!.carried).toHaveLength(1);
  await expect(restartBatch(f, gh).land()).rejects.toThrow("Cannot attribute red required checks");
  expect(f.commands.filter(args => args.includes("tsc"))).toHaveLength(0);
  expect(fallbackLogs).toBe(2);
  expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
});

test("the finite land bound and carried evidence survive a fresh process adapter", async () => {
  const f = landingFixture("behind");
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  const state = f.batch.read(); state.landPolls = MAX_REQUIRED_CHECK_POLLS - 2; f.batch.save(state);
  await expect(restartBatch(f).land()).rejects.toThrow("polling bound");
  const exhausted = f.batch.read();
  expect(exhausted.landPolls).toBe(MAX_REQUIRED_CHECK_POLLS);
  expect(exhausted.refreshes).toBe(0);
  expect(exhausted.gated!.carried).toHaveLength(2);
  const commands = f.commands.length;
  const cliRoot = join(f.root, "cli"); mkdirSync(cliRoot);
  const ghFile = join(cliRoot, "gh");
  writeFileSync(ghFile, '#!/bin/sh\ncase "$1" in\nrepo) echo "example/fixture" ;;\napi) echo \'{"required_status_checks":{"contexts":["privacy"],"strict":true}}\' ;;\n*) exit 91 ;;\nesac\n');
  chmodSync(ghFile, 0o755);
  const result = await commandRunner(f.repo, [process.execPath, join(import.meta.dir, "merge-batch.ts"), "land"], {
    ...isolatedEnvironment(join(cliRoot, "isolation"), process.env), TMPDIR: f.root, PATH: `${cliRoot}:${process.env.PATH}`,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9",
  });
  expect(result.code).toBe(1); expect(result.output).toContain("polling bound");
  expect(f.commands).toHaveLength(commands);
  expect(f.batch.read().gated!.carried).toEqual(exhausted.gated!.carried);
  expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
});

test.each([false, true])("a legacy receipt is reusable only on its exact tuple, main moved=%s", async moved => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  const state = f.batch.read(); delete state.gated!.members; delete state.gated!.carried; f.batch.save(state);
  if (moved) f.seed("advance.txt", "main moved");
  f.commands.length = 0;
  const landed = await restartBatch(f).land();
  expect(landed.refreshes).toBe(0);
  expect(landed.gated).toEqual(moved ? null : state.gated);
  expect(f.commands.filter(args => args.includes("tsc"))).toHaveLength(0);
});

test.each(["candidate privacy", "body privacy", "create", "edit", "reviews", "merge refusal"])("main movement during %s is rebuilt and merged only at the newest hosted-checked tip", async boundary => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  // An initial main move ensures that the edit path has a prior publication.
  let moved = false, preparedEdit = false;
  const advance = () => { moved = true; f.seed("advance-race.txt", "main moved during await"); };
  const gh = async (args: string[]) => {
    if (boundary === "edit" && !preparedEdit && args[0] === "pr" && args[1] === "view" && args[2] === "99") {
      preparedEdit = true; f.seed("advance-edit.txt", "prepare edit"); return batchView(f, "SUCCESS", "BEHIND");
    }
    if (!moved && boundary === "merge refusal" && args[1] === "merge" && !args.includes("--help")) { advance(); throw new Error("strict protection refused stale main"); }
    const result = await f.batch.gh(args);
    if (!moved && ((args[0] === "pr" && args[1] === boundary) || (boundary === "reviews" && args[1]?.includes("/99/reviews?")))) advance();
    return result;
  };
  const run: CommandRunner = async (cwd, args, env) => {
    const result = await f.batch.run(cwd, args, env);
    if (!moved && args[3] === "scripts/privacy-publication-gate.ts" && ((boundary === "candidate privacy" && args.includes("--check-commits"))
      || (boundary === "body privacy" && args.includes("--paths")))) advance();
    return result;
  };
  const state = await restartBatch(f, gh, run).land();
  expect(moved).toBeTrue(); expect(state.refreshes).toBe(0);
  const carries = state.gated!.carried!;
  expect(carries.at(-1)!.main).toBe(state.base);
  expect(f.calls.findLast(args => args[1] === "merge")!.at(-1)).toBe(carries.at(-1)!.tip);
  expect(state.rows[0]!.status).toBe("merged");
}, 30_000);

test("random event sequences merge only a current reviewed membership with a green tip", async () => {
  const totals = { culprit: 0, main: 0, head: 0, publications: 0 };
  for (let seed = 1; seed <= 12; seed++) {
    let randomState = seed;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState; };
    const events: ("culprit" | "main" | "head" | "none")[] = ["culprit", "main", "head", "main", "none", "none"];
    for (let index = events.length - 1; index > 0; index--) {
      const other = random() % (index + 1);
      [events[index], events[other]] = [events[other]!, events[index]!];
    }
    let failureFound = false, mainMoves = 0, greenTip = "";
    const f = landingFixture();
    const healthy = f.addPr(12, "healthy.txt", "healthy");
    const moving = f.addPr(13, "moving.txt", "moving");
    const bad = f.addPr(14, "bad.txt", "bad");
    const gh = async (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "view" && args[2] === "99" && args[4]?.includes("statusCheckRollup")) {
        const state = f.batch.read();
        const next = events.shift();
        if (next === "main") {
          f.seed(`advance-${++mainMoves}.txt`, "main advanced");
          totals.main++;
          return batchView(f, "SUCCESS", "BEHIND");
        }
        if (next === "head") {
          f.views.get(13)!.headRefOid = f.base;
          totals.head++;
          return batchView(f, "SUCCESS", "BEHIND");
        }
        if (next === "culprit") {
          failureFound = true;
          f.views.get(14)!.statusCheckRollup = [{ name: "privacy", status: "COMPLETED", conclusion: "FAILURE" }];
          totals.culprit++;
        }
        if (failureFound && state.rows[2]!.status === "clean") return batchView(f, "FAILURE");
        if (events.length) return batchView(f, "");
        greenTip = state.tip;
        return batchView(f);
      }
      if (args[0] === "pr" && ["create", "edit", "merge"].includes(args[1]!) && !args.includes("--help")) {
        const state = f.batch.read(), published = candidateOf(state);
        expect(state.gated).toBeNull();
        expect(published.main).toBe(git(f.repo, ["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0]!);
        for (const pr of published.prs) expect(f.views.get(pr.number)!.headRefOid).toBe(pr.head);
        expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${state.branch}`]).split(/\s/)[0]).toBe(state.tip);
        if (args[1] === "merge") expect(args.at(-1)).toBe(greenTip);
        totals.publications++;
      }
      return f.batch.gh(args);
    };
    const batch = restartBatch(f, gh);
    await batch.build(`12@${healthy},13@${moving},14@${bad}`);
    const state = await batch.land();
    expect(events).toEqual([]);
    expect(state.rows.map(row => row.status)).toEqual(["merged", "head-moved", "culprit"]);
    unchangedCulprit(f, 14, bad);
  }
  expect(totals.culprit).toBe(12); expect(totals.main).toBe(24); expect(totals.head).toBe(12);
  expect(totals.publications).toBeGreaterThanOrEqual(24);
}, 120_000);
