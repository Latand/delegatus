import { expect, test, afterAll, afterEach, beforeAll } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { report, git, MergeBatch, MAX_REQUIRED_CHECK_POLLS, commandRunner, type CommandRunner, candidateOf } from "./merge-batch";
import { isolatedEnvironment } from "./local-gate";
import { batchView, cleanupBatchFixtures, FIXED_CARRY_TIME, isolateBatchGateLocks, landingFixture, restartBatch, review, successfulCommand, testResult, unchangedCulprit } from "./merge-batch.fixture";

afterEach(cleanupBatchFixtures);
let restoreGateLocks: () => void;
beforeAll(() => { restoreGateLocks = isolateBatchGateLocks(); });
afterAll(() => restoreGateLocks());

test("one batch rebase-merges without a local receipt with exact head, closes originals with landed SHAs and keeps branches", async () => {
  const f = landingFixture();
  const a = f.addPr(12, "a.txt", "good"), b = f.addPr(13, "b.txt", "good");
  const built = await f.batch.build(`12@${a},13@${b}`);
  const state = await f.batch.land();
  expect(state.rows.map((row) => row.status)).toEqual(["merged", "merged"]);
  expect(state.rows[0]!.commit).not.toBe(built.rows[0]!.commit);
  expect(state.gated).toBeNull();
  expect(f.commands).toHaveLength(2);
  expect(f.commands[0]).toContain("--check-commits");
  expect(f.commands[1]).toContain("--paths");
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

test("an attributed red required check drops its PR and lands the remainder", async () => {
  const f = landingFixture("attributed");
  const a = f.addPr(12, "a.txt", "good"), b = f.addPr(13, "b.txt", "bad");
  await f.batch.build(`12@${a},13@${b}`); await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map((row) => row.status)).toEqual(["merged", "culprit"]);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain("b.txt");
});

test("an unattributable red merges nothing", async () => {
  const f = landingFixture("unknown");
  const a = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${a}`); await f.batch.gate();
  await expect(f.batch.land()).rejects.toThrow("Cannot attribute red required checks");
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(0);
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

test("a red required check names a member only on its reviewed head, then rebuilds and waits for the remainder", async () => {
  const f = landingFixture();
  const healthy = f.addPr(12, "healthy.txt", "healthy");
  const bad = f.addPr(13, "bad.txt", "bad");
  const built = await f.batch.build(`12@${healthy},13@${bad}`);
  let waited = 0;
  const seen: string[] = [];
  const gh = async (args: string[]) => {
    if (args[1]?.endsWith("/protection")) return JSON.stringify({ required_status_checks: { contexts: ["typecheck"], strict: true } });
    if (args[0] === "pr" && args[1] === "view" && args[3] === "--json" && args[4]?.endsWith("statusCheckRollup")) {
      const number = Number(args[2]);
      const conclusion = number === 13 ? "FAILURE" : "SUCCESS";
      return JSON.stringify({ number, headRefOid: f.views.get(number)!.headRefOid,
        statusCheckRollup: [{ name: "typecheck", status: "COMPLETED", conclusion }] });
    }
    if (args[0] === "pr" && args[1] === "view" && args[2] === "99" && args[4]?.includes("statusCheckRollup")) {
      const state = f.batch.read();
      seen.push(state.tip);
      return batchView(f, state.tip === built.tip ? "FAILURE" : waited ? "SUCCESS" : "").replaceAll('"privacy"', '"typecheck"');
    }
    return f.batch.gh(args);
  };
  const batch = new MergeBatch(f.repo, f.batch.stateFile, f.batch.run, gh, async () => {
    waited++;
    expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
  });
  const state = await batch.land();
  expect(waited).toBe(1);
  expect(seen).toEqual([built.tip, state.tip, state.tip]);
  expect(state.rows.map(row => row.status)).toEqual(["merged", "culprit"]);
  expect(state.rows[1]!.detail).toBe("typecheck: failed on reviewed head");
  expect(state.hostedAttribution).toEqual([{ candidate: candidateOf(built), tip: built.tip, check: "typecheck", prs: [13], source: "reviewed head" }]);
  expect(f.calls.find(args => args[1] === "merge")!.at(-1)).toBe(state.tip);
  expect(state.gated).toBeNull();
  expect(f.commands).toHaveLength(4);
  unchangedCulprit(f, 13, bad);
});

test.each(["wrong head", "different check", "pending rerun"])("hosted attribution refuses %s evidence", async evidence => {
  const f = landingFixture();
  const head = f.addPr(12, "healthy.txt", "healthy");
  const built = await f.batch.build(`12@${head}`);
  const gh = async (args: string[]) => {
    if (args[1]?.endsWith("/protection")) return JSON.stringify({ required_status_checks: { contexts: ["typecheck"], strict: true } });
    if (args[0] === "pr" && args[1] === "view" && args[4]?.endsWith("statusCheckRollup")) {
      return JSON.stringify({ number: 12, headRefOid: evidence === "wrong head" ? built.base : head,
        statusCheckRollup: [{ name: evidence === "different check" ? "runtime-gate" : "typecheck",
          status: evidence === "pending rerun" ? "IN_PROGRESS" : "COMPLETED", conclusion: "FAILURE" }] });
    }
    if (args[0] === "pr" && args[1] === "view" && args[2] === "99") return batchView(f, "FAILURE").replaceAll('"privacy"', '"typecheck"');
    return f.batch.gh(args);
  };
  await expect(restartBatch(f, gh).land()).rejects.toThrow(`Cannot attribute red required checks on ${built.tip}: typecheck`);
  expect(f.batch.read().rows[0]!.status).toBe("clean");
  expect(f.batch.read().hostedAttribution).toBeUndefined();
  expect(f.calls.some(args => args[1] === "merge" || args[1] === "close")).toBeFalse();
  expect(f.commands).toHaveLength(2);
});

test("a single moved member cannot publish or merge its reviewed patch", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "healthy.txt", "healthy");
  const built = await f.batch.build(`12@${head}`);
  f.views.get(12)!.headRefOid = built.base;
  const state = await f.batch.land();
  expect(state.rows[0]!.status).toBe("head-moved");
  expect(state.tip).toBe(built.base);
  expect(f.calls.some(args => ["create", "merge", "close"].includes(args[1]!) && !args.includes("--help"))).toBeFalse();
  expect(f.commands).toEqual([]);
});

test("a failed build cannot be reported as an empty landed batch", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "healthy.txt", "healthy");
  const broken = restartBatch(f, async args => {
    if (args[0] === "api" && args[1] === "graphql") throw new Error("closing references unavailable");
    return f.batch.gh(args);
  });
  await expect(broken.build(`12@${head}`)).rejects.toThrow("closing references unavailable");
  await expect(restartBatch(f).land()).rejects.toThrow("Batch build did not complete");
  expect(f.batch.read().landed).toBeFalse();
  expect(f.commands).toEqual([]);
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

test("T6 a late human request drops its member; a bot request survives the rebuilt batch", async () => {
  const f = landingFixture();
  const a = f.addPr(12, "a.txt", "healthy"), b = f.addPr(13, "b.txt", "human veto"), c = f.addPr(14, "c.txt", "bot request");
  await f.batch.build(`12@${a},13@${b},14@${c}`); await f.batch.gate();
  f.commands.length = 0;
  const gh = async (args: string[]) => {
    if (args[0] === "api" && args[1]!.includes("/reviews?")) {
      expect(args).toContain("--paginate");
      if (args[1]!.includes("/13/")) return review("reviewer-a", "CHANGES_REQUESTED");
      if (args[1]!.includes("/14/")) return review("automation[bot]", "CHANGES_REQUESTED");
      return "";
    }
    return f.batch.gh(args);
  };
  const state = await restartBatch(f, gh).land();
  expect(state.rows.map(row => row.status)).toEqual(["merged", "culprit", "merged"]);
  expect(state.rows[1]!.detail).toBe("review: human change request outstanding");
  expect(state.refreshes).toBe(1);
  expect(f.commands.filter(args => args.includes("tsc"))).toHaveLength(0);
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/topic-13"]).split(/\s/)[0]).toBe(b);
});

test.each([
  { name: "paginated late human", reviews: [...Array.from({ length: 100 }, () => review("automation[bot]", "COMMENTED")), review("reviewer-a", "CHANGES_REQUESTED")], blocked: true },
  { name: "approval clears the same human", reviews: [review("reviewer-a", "CHANGES_REQUESTED"), review("REVIEWER-A", "APPROVED")], blocked: false },
  { name: "dismissal clears the same human", reviews: [review("reviewer-a", "CHANGES_REQUESTED"), review("reviewer-a", "DISMISSED")], blocked: false },
  { name: "comment leaves a human request standing", reviews: [review("reviewer-a", "CHANGES_REQUESTED"), review("reviewer-a", "COMMENTED")], blocked: true },
  { name: "pending leaves a human request standing", reviews: [review("reviewer-a", "CHANGES_REQUESTED"), review("reviewer-a", "PENDING")], blocked: true },
  { name: "another human cannot clear a request", reviews: [review("reviewer-a", "CHANGES_REQUESTED"), review("reviewer-b", "APPROVED")], blocked: true },
  { name: "unknown author cannot be cleared by another", reviews: [review(null, "CHANGES_REQUESTED"), review("reviewer-a", "APPROVED")], blocked: true },
  { name: "typed bot request", reviews: [review("automation", "CHANGES_REQUESTED", true)], blocked: false },
  { name: "bot suffix request", reviews: [review("automation[bot]", "CHANGES_REQUESTED")], blocked: false },
  { name: "aggregate request without proof", reviews: [], blocked: true, decision: "CHANGES_REQUESTED" },
  { name: "aggregate request proven to be a bot", reviews: [review("automation[bot]", "CHANGES_REQUESTED")], blocked: false, decision: "CHANGES_REQUESTED" },
])("pre-merge review rule: $name", async ({ reviews, blocked, decision }) => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  f.views.get(12)!.reviewDecision = decision;
  let reads = 0;
  const gh = async (args: string[]) => {
    if (args[0] === "api" && args[1]!.includes("/12/reviews?")) {
      reads++; expect(args).toContain("--paginate");
      expect(args.at(-1)).toBe('.[] | {reviewer: .user.login, isBot: (.user.type == "Bot"), state} | @json');
      return reviews.join("\n");
    }
    return f.batch.gh(args);
  };
  const state = await restartBatch(f, gh).land();
  expect(reads).toBe(1);
  expect(state.rows[0]!.status).toBe(blocked ? "culprit" : "merged");
  expect(f.calls.filter(args => args[1] === "merge")).toHaveLength(blocked ? 0 : 1);
});

test.each([false, true])("the batch PR itself observes the human rule, bot=%s", async bot => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  const gh = async (args: string[]) => {
    if (args[0] === "api" && args[1]!.includes("/99/reviews?")) return review(bot ? "automation[bot]" : "reviewer-a", "CHANGES_REQUESTED");
    return f.batch.gh(args);
  };
  if (bot) expect((await restartBatch(f, gh).land()).landed).toBeTrue();
  else {
    await expect(restartBatch(f, gh).land()).rejects.toThrow("Batch review: human change request outstanding");
    expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
  }
});

test.each([12, 99])("unreadable or malformed reviews for PR %s fail closed", async number => {
  for (const raw of [undefined, "{", "null", '{}', review("reviewer-a", "unknown")]) {
    const f = landingFixture();
    const head = f.addPr(12, "a.txt", "healthy");
    await f.batch.build(`12@${head}`); await f.batch.gate();
    const gh = async (args: string[]) => {
      if (args[0] === "api" && args[1]!.includes(`/${number}/reviews?`)) {
        if (raw === undefined) throw new Error("review read unavailable");
        return raw;
      }
      return f.batch.gh(args);
    };
    await expect(restartBatch(f, gh).land()).rejects.toThrow();
    expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
    expect(f.batch.read().mergeIntent).toBeUndefined();
  }
}, 30_000);

test.each([0, 3])("a later review-read failure preserves membership and its cap across a process restart (%s spent)", async spent => {
  const f = landingFixture();
  const vetoed = f.addPr(12, "vetoed.txt", "human vetoed patch"), healthy = f.addPr(13, "healthy.txt", "healthy");
  await f.batch.build(`12@${vetoed},13@${healthy}`); await f.batch.gate();
  const state = f.batch.read(); state.refreshes = spent; f.batch.save(state);
  let unreadable = true;
  const gh = async (args: string[]) => {
    if (args[0] === "api" && args[1]?.includes("/12/reviews?")) return review("reviewer-a", "CHANGES_REQUESTED");
    if (unreadable && args[0] === "api" && args[1]?.includes("/13/reviews?")) throw new Error("review read unavailable");
    return f.batch.gh(args);
  };
  await expect(restartBatch(f, gh).land()).rejects.toThrow("review read unavailable");
  const interrupted = f.batch.read();
  expect(interrupted.rows.map(row => row.status)).toEqual(["clean", "clean"]);
  expect(interrupted.refreshes).toBe(spent);
  expect(interrupted.gated).toEqual(state.gated);
  expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
  // A new process runs the real gate state machine with isolated fixture
  // command results and the same forge heads. Its receipt must include both
  // patches still present in the tip; no partial removal may be certified.
  const source = `import { MergeBatch } from ${JSON.stringify(join(import.meta.dir, "merge-batch.ts"))};
    const views = new Map(${JSON.stringify([...f.views])});
    await new MergeBatch(${JSON.stringify(f.repo)}, ${JSON.stringify(f.batch.stateFile)},
      async () => ({code: 0, output: ""}), async args => {
        if (args[0] === "api" && args[1] === "graphql") {
          const number = Number(args.find(arg => arg.startsWith("number=")).slice(7));
          return views.get(number).closingIssuesReferences.map(issue => issue.number).join("\\n");
        }
        return JSON.stringify(views.get(Number(args[2])));
      }).gate();`;
  const result = await commandRunner(f.repo, [process.execPath, "-e", source], {
    ...isolatedEnvironment(join(f.root, "restart-gate"), process.env), TMPDIR: f.root,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9",
  });
  expect(result.code).toBe(0);
  expect(f.batch.read().gated!.members!.map(member => member.number)).toEqual([12, 13]);
  unreadable = false;
  if (spent === 0) {
    const landed = await restartBatch(f, gh).land();
    expect(landed.refreshes).toBe(1);
    expect(landed.rows.map(row => row.status)).toEqual(["culprit", "merged"]);
    expect(existsSync(join(f.repo, "vetoed.txt"))).toBeFalse();
    expect(existsSync(join(f.repo, "healthy.txt"))).toBeTrue();
  } else {
    await expect(restartBatch(f, gh).land()).rejects.toThrow("Membership revalidation required more than three times");
    expect(f.batch.read().revalidationExhausted).toBeTrue();
    expect(f.batch.read().gated).toBeNull();
    const retry = await commandRunner(f.repo, [process.execPath, join(import.meta.dir, "merge-batch.ts"), "gate", "--local"], {
      ...isolatedEnvironment(join(f.root, "exhausted-gate"), process.env), TMPDIR: f.root,
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9",
    });
    expect(retry.code).toBe(1); expect(retry.output).toContain("Membership revalidation required more than three times");
    expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
  }
}, 30_000);

test("a restarted gate refuses partial persisted membership while its removed patch remains in the tip", async () => {
  const f = landingFixture();
  const vetoed = f.addPr(12, "vetoed.txt", "human vetoed patch"), healthy = f.addPr(13, "healthy.txt", "healthy");
  await f.batch.build(`12@${vetoed},13@${healthy}`); await f.batch.gate();
  const state = f.batch.read();
  state.rows[0]!.status = "culprit";
  state.rows[0]!.detail = "review: human change request outstanding";
  state.gated = null; state.refreshes = 1; f.batch.save(state);
  const result = await commandRunner(f.repo, [process.execPath, join(import.meta.dir, "merge-batch.ts"), "gate", "--local"], {
    ...isolatedEnvironment(join(f.root, "partial-gate"), process.env), TMPDIR: f.root,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9",
  });
  expect(result.code).toBe(1); expect(result.output).toContain("tip does not match its clean membership");
  expect(f.batch.read().gated).toBeNull();
  await expect(restartBatch(f).land()).rejects.toThrow("Batch tip does not match its clean membership");
  expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
});

test("authority changing while reviews await prevents the exact-tip merge", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  const gh = async (args: string[]) => {
    const result = await f.batch.gh(args);
    if (args[0] === "api" && args[1]!.includes("/99/reviews?")) f.forge.credential = "personal";
    return result;
  };
  await expect(restartBatch(f, gh).land()).rejects.toThrow("verified machine principal");
  expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
});

test.each(["publication", "merge"])("the final %s guard refuses worktree changes after an awaited check", async boundary => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  const tamper = () => writeFileSync(join(f.batch.read().work, "unreviewed.txt"), "unreviewed change");
  const run: CommandRunner = async (cwd, args, env) => {
    const result = await f.batch.run(cwd, args, env);
    if (boundary === "publication" && args.includes("--paths")) tamper();
    return result;
  };
  const gh = async (args: string[]) => {
    const result = await f.batch.gh(args);
    if (boundary === "merge" && args[1]?.includes("/99/reviews?")) tamper();
    return result;
  };
  await expect(restartBatch(f, gh, run).land()).rejects.toThrow("Batch worktree changed outside this run");
  expect(f.calls.some(args => args[1] === "merge")).toBeFalse();
  if (boundary === "publication") expect(f.batch.read().published).toBeNull();
});

test.each([false, undefined])("missing strict protection refuses every publication effect: %j", async strict => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  const gh = async (args: string[]) => args[0] === "api" && args[1]!.endsWith("/protection")
    ? JSON.stringify({ required_status_checks: { contexts: ["privacy"], strict } }) : f.batch.gh(args);
  await expect(restartBatch(f, gh).land()).rejects.toThrow("strict required checks");
  expect(f.batch.read().published).toBeNull();
  expect(f.calls.some(args => args[1] === "create" || args[1] === "merge")).toBeFalse();
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

test("membership revalidation cap remains durable and does not certify an exhausted candidate", async () => {
  const f = landingFixture();
  const a = f.addPr(12, "a.txt", "healthy"), b = f.addPr(13, "b.txt", "moving");
  await f.batch.build(`12@${a},13@${b}`); await f.batch.gate();
  const state = f.batch.read(); state.refreshes = 3; f.batch.save(state);
  f.views.get(13)!.isDraft = true;
  await expect(restartBatch(f).land()).rejects.toThrow("Membership revalidation required more than three times");
  expect(f.batch.read().gated).toBeNull();
  expect(f.batch.read().refreshes).toBe(3);
  expect(f.batch.read().revalidationExhausted).toBeTrue();
  await expect(restartBatch(f).land()).rejects.toThrow("Membership revalidation required more than three times");
  const result = await commandRunner(f.repo, [process.execPath, join(import.meta.dir, "merge-batch.ts"), "gate", "--local"], {
    ...isolatedEnvironment(join(f.root, "restart-gate"), process.env), TMPDIR: f.root,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9",
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain("Membership revalidation required more than three times");
  expect(f.batch.read().gated).toBeNull();
  expect(f.calls.some(args => args[1] === "create" || args[1] === "merge")).toBeFalse();
});

test.each(["patch", "order", "head"])("landing refuses changed immutable membership %s", async change => {
  const f = landingFixture();
  const a = f.addPr(12, "a.txt", "healthy"), b = f.addPr(13, "b.txt", "other");
  await f.batch.build(`12@${a},13@${b}`); await f.batch.gate();
  const state = f.batch.read();
  if (change === "patch") state.rows[0]!.patch = "bad";
  else if (change === "head") state.rows[0]!.head = b;
  else state.rows.reverse();
  state.gated = null;
  f.batch.save(state);
  await expect(restartBatch(f).land()).rejects.toThrow(change === "order" ? "tip does not match its clean membership" : "does not match its reviewed head");
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
