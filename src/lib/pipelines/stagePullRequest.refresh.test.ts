import { expect, spyOn, test } from "bun:test";
import { ensureStagePullRequest } from "./stagePullRequest";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import type { ExecPort } from "@/lib/workflows/provision";
import { emptyRepositoryEntry, forgeCacheView, readForgeCache, updateForgeCache } from "@/lib/forge/cache";
import { resolvePipelineLink } from "./linkSource";
import { resolveDeliveryRemote } from "./git";
import { fs, os, path, realExec, tickPipelines, loadPipelines, savePipelines } from "./engine.fixture";
import { REMOTE, isBodyPatch, fixture, originalBudgetBody, fixSummary, finalBudgetFixFixture, withoutGitProof, publishedHeadFixture, forkFixture, unsafeSummary } from "./stagePullRequest.fixture";


test("PR refresh omits a localized fix report and records an advisory body hint", async () => {
  const f = await finalBudgetFixFixture();
  try {
    const p = await f.finish("Виправлено публікацію результатів.", 3);
    expect(f.body()).not.toContain("Виправлено");
    expect(f.body()).toContain("report omitted");
    expect(f.body().endsWith(originalBudgetBody)).toBe(true);
    expect(p.cursor?.activatedBy?.budgetRecheck).toBe(true);
    expect(p.runs[0]!.attempts.at(-1)!.publicationLanguageHints?.hints).toContainEqual({ part: "body", line: 1 });
  } finally { f.close(); }
});


for (const lost of [false, true]) test(`the final budget fix refreshes the PR head and reported checks before the terminal re-check (lost reply: ${lost})`, async () => {
  const f = await finalBudgetFixFixture();
  try {
    if (lost) f.setLost();
    const head = await f.git(f.worktree, "rev-parse", "HEAD");
    const p = await f.finish(fixSummary, 3);
    expect(p.state, p.stateDetail ?? undefined).toBe("running");
    expect(p.cursor?.activatedBy?.budgetRecheck).toBe(true);
    expect(p.runs.find(run => run.stageId === "review")!.attempts).toHaveLength(1);
    expect(f.body()).toContain(head);
    expect(f.body()).toContain(fixSummary);
    expect(f.body()).toContain("Last fix was not re-reviewed");
    expect(f.body().endsWith(originalBudgetBody)).toBe(true);
    expect(f.body()).toContain("supersedes earlier head, checks and review-status statements");
    expect(f.calls.filter(isBodyPatch)).toHaveLength(1);
    // Restart from the durable lane and the forge's observed body. Replaying
    // settlement must keep exactly one update and must not edit again.
    const observed = { number: 17, headRefName: p.branch, baseRefName: "main", state: "OPEN",
      isCrossRepository: false, headRefOid: head, body: f.body(), title: p.task };
    const replay = await realExec(process.execPath, ["-e", `
      const { loadPipelines } = await import("@/lib/pipelines/store");
      const { ensureStagePullRequest } = await import("@/lib/pipelines/stagePullRequest");
      const lane = loadPipelines().find(lane => lane.id === ${JSON.stringify(f.id)});
      const attempt = lane.runs.find(run => run.stageId === "build").attempts.at(-1);
      let writes = 0;
      const result = await ensureStagePullRequest(lane, attempt, async (command, args) => {
        if (command !== "gh" || args[1] !== "view") writes++;
        return { code: 0, stdout: ${JSON.stringify(JSON.stringify(observed))}, stderr: "" };
      });
      console.log(JSON.stringify({ result, writes }));
    `], process.cwd(), undefined, { timeoutMs: 15_000 });
    expect(replay.code, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout.trim())).toEqual({ result: { ok: true }, writes: 0 });
  } finally { f.close(); }
});


test("the final budget PR refresh uses REST when GraphQL Projects classic is unavailable", async () => {
  const f = await finalBudgetFixFixture();
  try {
    const summary = 'Verified résumé: "quoted", \\backslash, $value, `code`, {owner}, {repo}, {branch}.';
    const original = "Перевірено résumé & details.\n".repeat(1_000) + originalBudgetBody;
    f.setBody(original);
    const head = await f.git(f.worktree, "rev-parse", "HEAD");
    const p = await f.finish(summary, 3);
    expect(p.state, p.stateDetail ?? undefined).toBe("running");
    expect(p.cursor?.activatedBy?.budgetRecheck).toBe(true);
    expect(f.body()).toBe(`## Latest pipeline result\n\nHead: \`${head}\`\n\n**Last fix was not re-reviewed: review budget spent.**\n\n`
      + `Fix stage report (supersedes earlier head, checks and review-status statements):\n\n${summary}\n\n---\n\n${original}`);
    expect(f.calls.filter(isBodyPatch)).toHaveLength(1);
    expect(f.calls.some(args => args[0] === "pr" && args[1] === "edit")).toBe(false);
    expect(f.calls.flat().some(arg => arg.includes(summary))).toBe(false);
  } finally { f.close(); }
});


test.each(["exit", "throw", "unconfirmed"] as const)("a final budget PR body refresh failure is reported on the lane (%s)", async failure => {
  const f = await finalBudgetFixFixture();
  try {
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => {
      if (input[0] === "gh" && isBodyPatch(input[1])) {
        if (failure === "throw") throw new Error("forge unavailable");
        return { code: failure === "exit" ? 1 : 0, stdout: "", stderr: "forge refused" };
      }
      return exec(...input);
    };
    const p = await f.finish(fixSummary, 3);
    expect(p.state).toBe("needs_decision");
    const error = "the delivery pull request body refresh could not be verified; the stage cannot pass without it";
    expect(p.stateDetail).toContain(error);
    expect(p.runs.find(run => run.stageId === "build")!.attempts.at(-1)!.error).toContain(error);
    expect(p.runs.find(run => run.stageId === "review")!.attempts).toHaveLength(1);
    expect(f.body()).toBe(originalBudgetBody);
  } finally { f.close(); }
});


for (const text of [
  { kind: "path", value: "/home/" + "private-user/work" },
  { kind: "email", value: ["someone", "private.invalid"].join("@") },
  { kind: "credential", value: "ghp_" + "A".repeat(36) },
]) test(`the final budget fix refuses private report text before editing the PR (${text.kind})`, async () => {
  const f = await finalBudgetFixFixture();
  try {
    const p = await f.finish(text.value, 3);
    expect(p.state).toBe("needs_decision");
    expect(p.stateDetail).toContain("privacy");
    expect(p.stateDetail).not.toContain(text.value);
    expect(f.calls.filter(isBodyPatch)).toHaveLength(0);
    expect(f.body()).toBe(originalBudgetBody);
  } finally { f.close(); }
});


test("the final budget PR refresh keeps the repository's publication gate", async () => {
  const f = await finalBudgetFixFixture();
  try {
    const scripts = path.join(f.worktree, "scripts"); fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "console.log(\"known_value: 1\"); process.exit(1);\n");
    fs.copyFileSync(path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json"), path.join(f.worktree, "scripts/privacy-known-value-fingerprints.json"));
    await f.git(f.worktree, "add", "scripts");
    await f.commit();
    const p = await f.finish(fixSummary, 3);
    expect(p.state).toBe("needs_decision");
    expect(p.stateDetail).toContain("repository publication privacy gate");
    expect(f.calls.filter(isBodyPatch)).toHaveLength(0);
    expect(f.body()).toBe(originalBudgetBody);
  } finally { f.close(); }
});


test.each(["body", "title"] as const)("the final budget refresh adopts the matching PR with a missing %s diagnostic", async field => {
  const f = await finalBudgetFixFixture();
  try {
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => {
      const result = await exec(...input);
      if (input[0] === "gh" && input[1][1] === "view") {
        const row = JSON.parse(result.stdout); delete row[field];
        return { ...result, stdout: JSON.stringify(row) };
      }
      return result;
    };
    const p = await f.finish(fixSummary, 3);
    expect(p.state).toBe("running");
    expect(p.cursor?.activatedBy?.budgetRecheck).toBe(true);
    const error = p.runs.find(run => run.stageId === "build")!.attempts.at(-1)!.error;
    expect(error).toContain("inspection-error");
    expect(error).toContain(`"${field}":"missing"`);
    expect(f.calls.filter(isBodyPatch)).toHaveLength(0);
    expect(f.body()).toBe(originalBudgetBody);
  } finally { f.close(); }
});


for (const missing of ["body", "title"] as const) test.each(["available", "update"] as const)(`the final budget refresh checks %s text before adopting a PR missing ${missing}`, async source => {
  const f = await finalBudgetFixFixture();
  try {
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => {
      const result = await exec(...input);
      if (input[0] === "gh" && input[1][1] === "view") {
        const row = JSON.parse(result.stdout);
        delete row[missing];
        if (source === "available") row[missing === "body" ? "title" : "body"] = unsafeSummary;
        return { ...result, stdout: JSON.stringify(row) };
      }
      return result;
    };
    const lane = await f.finish(source === "update" ? unsafeSummary : fixSummary, 3);
    expect(lane.cursor?.stageId).toBe("build");
    const attempt = lane.runs[0]!.attempts.at(-1)!;
    expect(attempt.error).toContain("absolute-path");
    expect(attempt.error).not.toContain(unsafeSummary);
    expect(attempt.pullRequestInspection).toBeUndefined();
    expect(f.calls.some(isBodyPatch)).toBe(false);
  } finally { f.close(); }
});


for (const kind of ["pause", "release"] as const) for (const at of ["read", "edit", "verify"] as const) {
  test(`a ${kind} during the final PR body ${at} cannot complete stale settlement`, async () => {
    const f = await finalBudgetFixFixture();
    try {
      const exec = f.h.ports.exec;
      let reads = 0;
      f.h.ports.exec = async (...input) => {
        const result = await exec(...input);
        if (input[0] === "gh") {
          const operation = input[1][1];
          if (operation === "view") reads++;
          if ((at === "read" && reads === 1) || (at === "edit" && isBodyPatch(input[1])) || (at === "verify" && reads === 2)) {
            const p = loadPipelines().find(lane => lane.id === f.id)!;
            if (kind === "pause") { p.state = "paused"; p.pausedState = "running"; }
            else p.delivery!.active = false;
            savePipelines([p]);
          }
        }
        return result;
      };
      const p = await f.finish(fixSummary, 3);
      expect(p.state).not.toBe("completed");
      if (kind === "pause") expect(p.state).toBe("paused");
      else expect(p.delivery!.active).toBe(false);
      if (at === "read") expect(f.body()).toBe(originalBudgetBody);
      expect(p.runs.find(run => run.stageId === "review")!.attempts).toHaveLength(1);
    } finally { f.close(); }
  });
}


test.each([true, false])("published stage waits for lagging PR head then accepts it (linked: %s)", async linked => {
  const f = await publishedHeadFixture(linked);
  try {
    let reads = 0;
    const exec: ExecPort = async (command, args) => {
      expect(command).toBe("gh");
      expect(args[1]).toBe(linked ? "view" : "list");
      const row = { ...f.row, headRefOid: ++reads < 3 ? "2".repeat(40) : f.row.headRefOid };
      return { code: 0, stdout: JSON.stringify(linked ? row : [row]), stderr: "" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing)).toEqual({ ok: true });
    expect(reads).toBe(3);
    expect(f.waits).toEqual([1_000, 2_000]);
    expect(f.pipeline.delivery!.target.pr).toBe(17);
  } finally { f.close(); }
});


test.each([true, false])("published stage keeps the head mismatch refusal after bounded rereads (linked: %s)", async linked => {
  const f = await publishedHeadFixture(linked);
  try {
    const timeouts: number[] = [];
    const exec: ExecPort = async (_command, _args, _cwd, _env, options) => {
      timeouts.push(options!.timeoutMs!);
      const row = { ...f.row, headRefOid: "2".repeat(40) };
      return { code: 0, stdout: JSON.stringify(linked ? row : [row]), stderr: "" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing))
      .toEqual({ ok: false, error: "the delivery pull request differs in headRefOid" });
    expect(f.waits).toEqual([1_000, 2_000, 4_000, 8_000, 14_000]);
    expect(f.elapsed()).toBe(29_000);
    expect(timeouts).toEqual([30_000, 29_000, 27_000, 23_000, 15_000, 1_000]);
  } finally { f.close(); }
});


test.each(["exit", "throw", "json"] as const)("PR reread failure refuses publication immediately (%s)", async failure => {
  const f = await publishedHeadFixture();
  try {
    let reads = 0;
    const exec: ExecPort = async () => {
      if (++reads === 1) return { code: 0, stdout: JSON.stringify({ ...f.row, headRefOid: "2".repeat(40) }), stderr: "" };
      if (failure === "throw") throw new Error("forge transport unavailable");
      return { code: failure === "exit" ? 1 : 0, stdout: "invalid json", stderr: "forge read failed" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing)).toEqual({ ok: false,
      error: failure === "exit" ? "the delivery pull request lookup failed"
        : "the delivery pull request could not be verified; the stage cannot pass without it" });
    expect(reads).toBe(2);
    expect(f.waits).toEqual([1_000]);
  } finally { f.close(); }
});


test("a fork delivery reads its PR in the upstream repository and accepts its head in the fork", async () => {
  const f = await forkFixture();
  try {
    const calls: string[][] = [];
    const exec: ExecPort = async (command, args) => {
      expect(command).toBe("gh");
      calls.push(args);
      return { code: 0, stdout: JSON.stringify(f.row), stderr: "" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing)).toEqual({ ok: true });
    expect(calls).toEqual([["pr", "view", "17", "--repo", "example/widgets", "--json",
      "number,headRefName,baseRefName,state,headRefOid,isCrossRepository,headRepository,headRepositoryOwner"]]);
    expect(f.pipeline.delivery!.target.pr).toBe(17);
  } finally { f.close(); }
});


test.each([false, true])("a base change during the PR head reread refuses publication (fork: %s)", async fork => {
  const f = await (fork ? forkFixture() : publishedHeadFixture());
  try {
    let reads = 0;
    const exec: ExecPort = async (command, args) => {
      expect(command).toBe("gh");
      expect(args[1]).toBe("view");
      const row = ++reads === 1 ? { ...f.row, headRefOid: "2".repeat(40) }
        : { ...f.row, baseRefName: "pipeline/predecessor" };
      return { code: 0, stdout: JSON.stringify(row), stderr: "" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing)).toEqual({ ok: false,
      error: "the delivery pull request differs in baseRefName (expected the lane's baseBranch; correct the PR base before retrying)" });
    expect(reads).toBe(2);
    expect(f.waits).toEqual([1_000]);
  } finally { f.close(); }
});


test("a fork renamed in the forge cache keeps its identity from link preview through publication", async () => {
  const f = await publishedHeadFixture();
  const oldRepository = "old-fork/widgets";
  const previous = readForgeCache().data.repositories[oldRepository];
  try {
    updateForgeCache(data => { data.repositories[oldRepository] = { ...emptyRepositoryEntry(), canonical: "contributor/widgets" }; });
    const repoDir = f.pipeline.repoDir;
    for (const args of [
      ["remote", "set-url", "origin", REMOTE],
      ["remote", "add", "contributor", `https://github.com/${oldRepository}.git`],
    ]) {
      const result = await realExec("git", args, repoDir);
      expect(result.code, result.stderr).toBe(0);
    }
    const preview = await resolvePipelineLink("https://github.com/example/widgets/pull/17", repoDir, {
      exec: realExec, cache: forgeCacheView(), tasks: () => [], pipelines: () => [], projectForCwd: () => null, taskLinks: () => [],
      gh: async () => JSON.stringify({ number: 17, title: "Fork fix", state: "open", base: { ref: f.pipeline.baseBranch },
        head: { ref: f.row.headRefName, sha: f.row.headRefOid, repo: { full_name: "Contributor/Widgets" } } }),
    });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.source.head).toMatchObject({ repository: "contributor/widgets", remote: "contributor", fork: true });
    const input = preview.source.request.delivery!;
    const stored = await resolveDeliveryRemote(repoDir, input.remote, realExec, { allowLiteral: true });
    if (!stored.ok) throw new Error(stored.error);
    expect(stored.remote).toBe(`https://github.com/${oldRepository}.git`);
    f.pipeline.delivery!.target = { ...f.pipeline.delivery!.target, ...input, remote: stored.remote, repository: stored.repository };
    const row = { ...f.row, isCrossRepository: true, headRepository: { name: "Widgets" }, headRepositoryOwner: { login: "Contributor" } };
    const exec: ExecPort = async (command, args) => {
      expect(command).toBe("gh");
      expect(args.slice(0, 5)).toEqual(["pr", "view", "17", "--repo", "example/widgets"]);
      return { code: 0, stdout: JSON.stringify(row), stderr: "" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing)).toEqual({ ok: true });
    row.headRepositoryOwner.login = "unrelated";
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing))
      .toEqual({ ok: false, error: "the delivery pull request differs in headRepository (expected the delivery remote's repository)" });
  } finally {
    updateForgeCache(data => {
      if (previous) data.repositories[oldRepository] = previous;
      else delete data.repositories[oldRepository];
    });
    f.close();
  }
});


test.each([
  ["same repository", { isCrossRepository: false }, "isCrossRepository (expected the fork)"],
  ["another fork", { headRepositoryOwner: { login: "someone" } }, "headRepository (expected the delivery remote's repository)"],
  ["no head repository", { headRepository: null }, "headRepository (expected the delivery remote's repository)"],
] as const)("a fork delivery refuses an upstream PR whose head is elsewhere (%s)", async (_name, change, error) => {
  const f = await forkFixture();
  try {
    const exec: ExecPort = async () => ({ code: 0, stdout: JSON.stringify({ ...f.row, ...change }), stderr: "" });
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing))
      .toEqual({ ok: false, error: `the delivery pull request differs in ${error}` });
  } finally { f.close(); }
});


test("a same-repository delivery still refuses a cross-repository PR, and a fork delivery never opens one in the fork", async () => {
  const same = await publishedHeadFixture();
  try {
    const exec: ExecPort = async () => ({ code: 0, stdout: JSON.stringify({ ...same.row, isCrossRepository: true }), stderr: "" });
    expect(await ensureStagePullRequest(same.pipeline, same.attempt, withoutGitProof(exec), undefined, same.timing))
      .toEqual({ ok: false, error: "the delivery pull request differs in isCrossRepository (expected same repository)" });
  } finally { same.close(); }
  const fork = await forkFixture();
  try {
    delete fork.pipeline.delivery!.target.pr;
    let calls = 0;
    const exec: ExecPort = async () => { calls++; return { code: 0, stdout: "[]", stderr: "" }; };
    expect(await ensureStagePullRequest(fork.pipeline, fork.attempt, withoutGitProof(exec), undefined, fork.timing))
      .toEqual({ ok: false, error: "a fork delivery names no pull request; the lane cannot open one in the fork" });
    expect(calls).toBe(0);
  } finally { fork.close(); }
});


test("an initial gh failure has no head-lag evidence to retry", async () => {
  const f = await publishedHeadFixture();
  try {
    const exec: ExecPort = async () => ({ code: 1, stdout: "", stderr: "forge unavailable" });
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing))
      .toEqual({ ok: false, error: "the delivery pull request lookup failed" });
    expect(f.waits).toEqual([]);
  } finally { f.close(); }
});


test.each(["attempt", "epoch", "head", "pending", "failed", "review"] as const)("head lag is retried only for this attempt's successful publication (%s)", async stale => {
  const f = await publishedHeadFixture();
  try {
    const operation = f.pipeline.delivery!.operation!;
    if (stale === "attempt") operation.requestKey = "pass:build:99";
    if (stale === "epoch") operation.epoch++;
    if (stale === "head") operation.sha = "3".repeat(40);
    if (stale === "pending") operation.state = "pending";
    if (stale === "failed") operation.result = { ok: false, error: "push failed" };
    if (stale === "review") operation.passedStage = false;
    let reads = 0;
    const exec: ExecPort = async () => {
      reads++;
      return { code: 0, stdout: JSON.stringify({ ...f.row, headRefOid: "2".repeat(40) }), stderr: "" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing))
      .toEqual({ ok: false, error: "the delivery pull request differs in headRefOid" });
    expect(reads).toBe(1);
    expect(f.waits).toEqual([]);
  } finally { f.close(); }
});


test("the production head retry clock bounds slow lookups in a supervised process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-pr-deadline-"));
  const home = path.join(root, "home"), config = path.join(root, "config"), tmp = path.join(root, "tmp"), state = path.join(root, "state");
  fs.mkdirSync(home); fs.mkdirSync(config); fs.mkdirSync(tmp); fs.mkdirSync(state);
  const childSource = `
    import { ensureStagePullRequest } from ${JSON.stringify(path.resolve("src/lib/pipelines/stagePullRequest.ts"))};
    const head = "1".repeat(40);
    const attempt = { n: 1, effectiveRole: { access: "read-write" } };
    const pipeline = {
      id: "pipeline-fixture", worktreeDir: process.cwd(), baseRef: "0".repeat(40), baseBranch: "main",
      publishedCommit: head, lastPassedCommit: head, cursor: { stageId: "build" }, runs: [{ attempts: [attempt] }],
      delivery: { publish: "enabled", active: true, disposition: "owner", ownerId: "pipeline-fixture", epoch: 1,
        operation: { epoch: 1, sha: head, requestKey: "pass:build:1", state: "settled", passedStage: true,
          result: { ok: true, sha: head, remote: "published" } },
        target: { remote: "https://github.com/example/widgets.git", branch: "refs/heads/branch", pr: 17 } },
    };
    let reads = 0;
    const started = performance.now();
    const result = await ensureStagePullRequest(pipeline, attempt, async (_command, _args, _cwd, _env, _options) => {
      if (_command === "git") return { code: 1, stdout: "", stderr: "no fixture Git proof" };
      if (++reads > 1) await Bun.sleep(2_000);
      return { code: 0, stdout: JSON.stringify({ number: 17, headRefName: "branch", baseRefName: "main",
        state: "OPEN", isCrossRepository: false, headRefOid: "2".repeat(40) }), stderr: "" };
    });
    console.log(JSON.stringify({ result, reads, elapsedMs: Math.round(performance.now() - started) }));
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, TMPDIR: tmp, LLV_STATE_DIR: state,
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_STATE_OWNER: undefined },
    stdout: "pipe", stderr: "pipe",
  });
  let watchdogExpired = false;
  const watchdog = setTimeout(() => { watchdogExpired = true; child.kill("SIGKILL"); }, 28_000);
  try {
    const exitCode = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(watchdogExpired, `production retry exceeded the parent watchdog: ${stderr}`).toBe(false);
    expect(exitCode, stderr || stdout).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.result).toEqual({ ok: false, error: "the delivery pull request differs in headRefOid" });
    expect(result.reads).toBe(5);
    expect(result.elapsedMs).toBeLessThan(28_000);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 35_000);


test("each reread validates the PR's other fields before accepting its head", async () => {
  const f = await publishedHeadFixture();
  try {
    let reads = 0;
    const exec: ExecPort = async () => ({ code: 0, stderr: "", stdout: JSON.stringify(++reads === 1
      ? { ...f.row, headRefOid: "2".repeat(40) } : { ...f.row, state: "CLOSED" }) });
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing))
      .toEqual({ ok: false, error: "the delivery pull request differs in state (expected OPEN, received CLOSED)" });
    expect(reads).toBe(2);
    expect(f.waits).toEqual([1_000]);
  } finally { f.close(); }
});


test.each(["read", "sleep"] as const)("the head retry deadline includes slow %s time", async slow => {
  const f = await publishedHeadFixture();
  try {
    let reads = 0;
    const exec: ExecPort = async () => {
      if (++reads > 1) f.advance(29_000);
      return { code: 0, stdout: JSON.stringify({ ...f.row, headRefOid: "2".repeat(40) }), stderr: "" };
    };
    if (slow === "sleep") f.timing.sleep = async () => { f.advance(30_000); };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing))
      .toEqual({ ok: false, error: "the delivery pull request differs in headRefOid" });
    expect(f.elapsed()).toBe(30_000);
    expect(reads).toBe(slow === "sleep" ? 1 : 2);
  } finally { f.close(); }
});


test.each(["foreign", "divergent", "wrong-branch", "wrong-number", "missing-head"] as const)("a known %s PR refusal survives an unavailable forge and restart", async kind => {
  const f = await publishedHeadFixture();
  try {
    let reads = 0;
    const rejected: ExecPort = async (command, args) => {
      if (command === "gh") {
        reads++;
        return { code: 0, stderr: "", stdout: JSON.stringify({ ...f.row,
          ...(kind === "foreign" ? { isCrossRepository: true }
            : kind === "divergent" ? { headRefOid: "3".repeat(40) }
              : kind === "wrong-branch" ? { headRefName: "another-lane" }
                : kind === "wrong-number" ? { number: 18 }
                  : { headRefName: undefined, headRefOid: undefined }) }) };
      }
      if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "not an ancestor" };
      throw new Error("no further Git access is allowed");
    };
    const first = await ensureStagePullRequest(f.pipeline, f.attempt, rejected, undefined, f.timing);
    expect(first.ok).toBe(false);
    expect(f.pipeline.delivery!.pullRequestRefusal).toMatchObject({ epoch: 1, sha: f.row.headRefOid,
      number: kind === "wrong-number" ? 18 : 17 });
    expect(reads).toBe(kind === "foreign" || kind === "wrong-branch" || kind === "wrong-number" || kind === "missing-head" ? 1 : 6);

    const restarted = JSON.parse(JSON.stringify(f.pipeline)) as typeof f.pipeline;
    const retryAttempt = JSON.parse(JSON.stringify(f.attempt)) as typeof f.attempt;
    const unavailable: ExecPort = async command => {
      expect(command).toBe("gh");
      return { code: 1, stdout: "", stderr: "forge unavailable" };
    };
    const retry = await ensureStagePullRequest(restarted, retryAttempt, unavailable, undefined, f.timing);
    expect(retry).toEqual({ ok: false, error: f.pipeline.delivery!.pullRequestRefusal!.reason });
    expect(retryAttempt.error ?? "").not.toContain("publication verified by Git");
  } finally { f.close(); }
});


test("a corrected PR identity releases its old refusal only after exact stale-ancestor Git proof", async () => {
  const f = await publishedHeadFixture();
  try {
    const first: ExecPort = async command => ({ code: 0, stdout: JSON.stringify({ ...f.row, headRefName: "wrong-branch" }), stderr: "" });
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, first, undefined, f.timing)).toMatchObject({ ok: false });
    expect(f.pipeline.delivery!.pullRequestRefusal).toBeDefined();

    const stale = "2".repeat(40);
    const calls: string[] = [];
    const corrected: ExecPort = async (_command, args) => {
      calls.push(args[0]!);
      if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ ...f.row, headRefOid: stale }), stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-remote") return { code: 0, stdout: `${f.row.headRefOid}\trefs/heads/${f.pipeline.branch}\n`, stderr: "" };
      throw new Error(`unexpected command ${args[0]}`);
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, corrected, undefined, f.timing)).toEqual({ ok: true });
    expect(f.pipeline.delivery!.pullRequestRefusal).toBeUndefined();
    expect(f.attempt.error ?? "").not.toContain("the delivery pull request differs in headRefOid");
    expect(calls[0]).toBe("pr");
    expect(calls.slice(-2)).toEqual(["merge-base", "ls-remote"]);
  } finally { f.close(); }
});


test.each(["stale", "unavailable"] as const)("a final-fix PR body refresh deferred by %s forge state is reconciled once", async mode => {
  const f = await finalBudgetFixFixture();
  try {
    const beforeFix = loadPipelines().find(pipeline => pipeline.id === f.id)!;
    const oldHead = await f.git(f.origin, "rev-parse", `refs/heads/${beforeFix.branch}`);
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => {
      if (input[0] === "gh" && input[1][0] === "pr" && input[1][1] === "view") {
        if (mode === "unavailable") return { code: 1, stdout: "", stderr: "forge unavailable" };
        const result = await exec(...input);
        const row = JSON.parse(result.stdout);
        return { ...result, stdout: JSON.stringify({ ...row, headRefOid: oldHead }) };
      }
      return exec(...input);
    };
    const deferred = await f.finish(fixSummary, 3);
    expect(deferred.state).toBe("running");
    expect(deferred.delivery!.pendingPullRequestRefresh).toMatchObject({
      epoch: deferred.delivery!.epoch, sha: deferred.publishedCommit, number: 17, summary: fixSummary,
    });
    expect(f.body()).toBe(originalBudgetBody);
    expect(f.calls.filter(isBodyPatch)).toHaveLength(0);

    const refreshAttempt = deferred.runs.find(run => run.stageId === "build")!.attempts.at(-1)!;
    const recovered = await ensureStagePullRequest(deferred, refreshAttempt, exec, deferred.publishedCommit ?? undefined);
    expect(recovered).toEqual({ ok: true });
    expect(deferred.delivery!.pendingPullRequestRefresh).toBeUndefined();
    expect(f.body()).toContain(`Head: \`${deferred.publishedCommit}\``);
    expect(f.body()).toContain(fixSummary);
    expect(f.body()).toContain("Last fix was not re-reviewed");
    expect(f.body().endsWith(originalBudgetBody)).toBe(true);
    expect(f.calls.filter(isBodyPatch)).toHaveLength(1);
  } finally { f.close(); }
});


test.each([60 * 1024, 74_999])("F5: legacy output of %s characters has a durable controlled outcome across restart", async length => {
  const f = await finalBudgetFixFixture();
  try {
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => input[0] === "gh" && input[1][1] === "view"
      ? { code: 1, stdout: "", stderr: "forge unavailable" } : exec(...input);
    const lane = await f.finish(fixSummary, 3);
    const producer = lane.runs.find(run => run.stageId === "build")!.attempts.at(-1)!;
    producer.report!.summary = null;
    producer.output = "x".repeat(length);
    delete lane.delivery!.pendingPullRequestRefresh;
    savePipelines([lane]);
    const result = await ensureStagePullRequest(lane, producer, f.h.ports.exec, lane.publishedCommit ?? undefined);
    // The writer's real output must always be accepted by its durable reader.
    expect(() => savePipelines([lane])).not.toThrow();
    if (length > 60 * 1024) {
      expect(result).toMatchObject({ ok: false, privacy: { part: "body", check: "size", kind: "size" } });
      expect(lane.delivery!.pendingPullRequestRefresh).toBeUndefined();
    } else {
      expect(result).toEqual({ ok: true });
      expect(loadPipelines().find(row => row.id === lane.id)!.delivery!.pendingPullRequestRefresh?.summary.length).toBe(length);
    }
    expect(f.calls.filter(isBodyPatch)).toHaveLength(0);
    const restarted = await realExec(process.execPath, ["-e", `
      const { loadPipelines, savePipelines } = await import("@/lib/pipelines/store");
      const { ensureStagePullRequest } = await import("@/lib/pipelines/stagePullRequest");
      const lane = loadPipelines().find(row => row.id === ${JSON.stringify(f.id)});
      const producer = lane.runs.find(run => run.stageId === "build").attempts.at(-1);
      let writes = 0;
      const result = await ensureStagePullRequest(lane, producer, async (command, args) => {
        if (command === "git" && args[0] === "ls-remote") return { code: 0,
          stdout: lane.publishedCommit + String.fromCharCode(9) + lane.delivery.target.branch, stderr: "" };
        if (command === "gh" && args[1] === "view") return { code: 1, stdout: "", stderr: "forge unavailable" };
        writes++;
        throw new Error("unexpected write");
      }, lane.publishedCommit);
      savePipelines([lane]);
      console.log(JSON.stringify({ result, writes, length: lane.delivery.pendingPullRequestRefresh?.summary.length ?? null }));
    `], process.cwd(), undefined, { timeoutMs: 30_000 });
    expect(restarted.code, restarted.stderr).toBe(0);
    const replay = JSON.parse(restarted.stdout.trim());
    expect(replay.result).toEqual(result);
    expect(replay.writes).toBe(0);
    expect(replay.length).toBe(length > 60 * 1024 ? null : length);
  } finally { f.close(); }
}, 60_000);


test("a completed lane refreshes its deferred PR body after a process restart", async () => {
  const f = await finalBudgetFixFixture();
  const prFile = path.join(f.root, "pull-request.json");
  const replaceMarker = `${prFile}.replace-owner`;
  try {
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...input) => {
      if (input[0] === "gh" && input[1][0] === "pr" && input[1][1] === "view")
        return { code: 1, stdout: "", stderr: "forge unavailable" };
      return exec(...input);
    };
    const deferred = await f.finish(fixSummary, 3);
    expect(deferred.delivery!.pendingPullRequestRefresh).toBeDefined();
    deferred.state = "completed";
    deferred.closedAt = "2026-11-14T10:30:00.000Z";
    deferred.cursor = null;
    deferred.delivery!.active = false;
    delete deferred.delivery!.pendingPullRequestRefresh!.nextAttemptAt;
    savePipelines([deferred]);
    fs.writeFileSync(prFile, JSON.stringify({ number: 17, headRefName: deferred.branch, baseRefName: "main",
      state: "OPEN", isCrossRepository: false, headRefOid: deferred.publishedCommit,
      title: deferred.task, body: originalBudgetBody, patches: 0 }));

    const script = `
      import fs from "node:fs";
      import { productionAutoMergePorts, resetAutoMergeForTests, sweepAutoMerge } from ${JSON.stringify(path.resolve("src/lib/forge/autoMerge.ts"))};
      import { buildPipeline, createPipelineWithDelivery, loadPipelines, takeoverPipelineDelivery } from ${JSON.stringify(path.resolve("src/lib/pipelines/store.ts"))};
      resetAutoMergeForTests();
      const file = ${JSON.stringify(prFile)};
      const replaceMarker = ${JSON.stringify(replaceMarker)};
      let replaced = false;
      const exec = async (command, args) => {
        if (command === "bun") return { code: 0, stdout: "", stderr: "" };
        if (command !== "gh") throw new Error("unexpected executable");
        if (args[0] === "pr" && args[1] === "view") {
          if (fs.existsSync(replaceMarker) && !replaced) {
            try {
              const source = loadPipelines().find(row => row.id === ${JSON.stringify(deferred.id)});
              const successor = buildPipeline({ id: "d3e1beef", task: "Continue delivery", project: source.project,
                repoDir: source.repoDir, stages: source.stages, srcPath: null, srcConversationId: null,
                now: new Date().toISOString() });
              const comparison = await createPipelineWithDelivery(successor, source.delivery.target, true);
              const result = await takeoverPipelineDelivery(comparison.id, ${JSON.stringify(deferred.id)}, ${deferred.delivery!.epoch}, "test recovery", null);
              if (result.error) throw new Error(result.error);
              replaced = true;
            } catch (error) {
              throw error;
            }
          }
          return { code: 0, stdout: fs.readFileSync(file, "utf8"), stderr: "" };
        }
        if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
          const pr = JSON.parse(fs.readFileSync(file, "utf8"));
          pr.body = fs.readFileSync(args.find(value => value.startsWith("body=@")).slice(6), "utf8");
          pr.patches++;
          fs.writeFileSync(file, JSON.stringify(pr));
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error("unexpected forge command");
      };
      const ports = productionAutoMergePorts({ loadPipelines, exec, run: async () => { throw new Error("no merge read expected"); },
        pullRequestOf: lane => lane.delivery?.target.pr ? { repository: "example/widgets", number: lane.delivery.target.pr } : null,
        setting: () => ({ enabled: false, changedAt: null, changedBy: null }), log: () => {} });
      await sweepAutoMerge(ports);
      const rows = loadPipelines();
      const lane = rows.find(row => row.id === ${JSON.stringify(deferred.id)});
      const successor = rows.find(row => row.id === "d3e1beef");
      console.log(JSON.stringify({ pending: lane.delivery.pendingPullRequestRefresh ?? null, state: lane.state,
        owner: lane.delivery.ownerId, publish: lane.delivery.publish, epoch: lane.delivery.epoch,
        successor: successor ? { state: successor.state, owner: successor.delivery.ownerId,
          publish: successor.delivery.publish, active: successor.delivery.active, epoch: successor.delivery.epoch } : null }));
    `;
    fs.writeFileSync(replaceMarker, "replace owner");
    const refused = await realExec(process.execPath, ["-e", script], process.cwd(), undefined, { timeoutMs: 30_000 });
    fs.rmSync(replaceMarker, { force: true });
    expect(refused.code, refused.stderr).toBe(0);
    expect(JSON.parse(refused.stdout.trim())).toMatchObject({ state: "completed", owner: deferred.id,
      publish: "disabled", epoch: deferred.delivery!.epoch, pending: { sha: deferred.publishedCommit },
      successor: { state: "provisioning", owner: "d3e1beef", publish: "enabled", active: true,
        epoch: deferred.delivery!.epoch + 1 } });
    expect(JSON.parse(fs.readFileSync(prFile, "utf8")).patches).toBe(0);

    savePipelines([deferred]);
    fs.writeFileSync(prFile, JSON.stringify({ number: 17, headRefName: deferred.branch, baseRefName: "main",
      state: "OPEN", isCrossRepository: false, headRefOid: deferred.publishedCommit,
      title: deferred.task, body: originalBudgetBody, patches: 0 }));
    const result = await realExec(process.execPath, ["-e", script], process.cwd(), undefined, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ pending: null, state: "completed", owner: deferred.id,
      epoch: deferred.delivery!.epoch });
    const pr = JSON.parse(fs.readFileSync(prFile, "utf8"));
    expect(pr.patches).toBe(1);
    expect(pr.body).toContain(`Head: \`${deferred.publishedCommit}\``);
    expect(pr.body).toContain(fixSummary);
    expect(pr.body.endsWith(originalBudgetBody)).toBe(true);
    expect(loadPipelines().find(row => row.id === deferred.id)!.delivery!.pendingPullRequestRefresh).toBeUndefined();
  } finally { f.close(); }
}, 30_000);


test("head backoff carries the pipeline operation label across its await", async () => {
  const f = await publishedHeadFixture();
  try {
    let reads = 0;
    const exec: ExecPort = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ ...f.row,
      headRefOid: ++reads === 1 ? "2".repeat(40) : f.row.headRefOid }) });
    f.timing.sleep = async ms => {
      expect(viewerLoopMonitor.current()).toBe("pipelines.controller-job");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(viewerLoopMonitor.current()).toBe("pipelines.controller-job");
      f.advance(ms);
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, withoutGitProof(exec), undefined, f.timing)).toEqual({ ok: true });
  } finally { f.close(); }
});


test.each(["ancestor", "remote"] as const)("Git continuation revalidates delivery ownership after the %s await", async changedAt => {
  const f = await publishedHeadFixture();
  try {
    const steps: string[] = [];
    const exec: ExecPort = async (command, args) => {
      if (command === "gh") return { code: 0, stdout: JSON.stringify({ ...f.row, headRefOid: "2".repeat(40) }), stderr: "" };
      if (args[0] === "merge-base") {
        steps.push("ancestor");
        if (changedAt === "ancestor") f.pipeline.delivery!.epoch++;
        return { code: 0, stdout: "", stderr: "" };
      }
      expect(args[0]).toBe("ls-remote");
      steps.push("remote");
      f.pipeline.delivery!.ownerId = "replacement-owner";
      return { code: 0, stdout: `${f.row.headRefOid}\trefs/heads/${f.pipeline.branch}\n`, stderr: "" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing))
      .toEqual({ ok: false, error: "the delivery pull request differs in headRefOid" });
    expect(f.attempt.error ?? "").not.toContain("publication verified by Git");
    expect(steps).toEqual(changedAt === "ancestor" ? ["ancestor"] : ["ancestor", "remote"]);
  } finally { f.close(); }
});


test("Git continuation keeps the exact review head and the forge merge fence", async () => {
  const f = await fixture();
  const pullRequests = await import("./stagePullRequest");
  const verifier = spyOn(pullRequests, "ensureStagePullRequest");
  // The engine fixture already owns this spy; capture its implementation,
  // because a reference to the mutable mock would recurse after replacement.
  const verify = verifier.getMockImplementation()!;
  let clock = 0;
  verifier.mockImplementation(
    (pipeline, attempt, exec, head) => verify(pipeline, attempt, exec, head,
      { now: () => clock, sleep: async ms => { clock += ms; } }),
  );
  try {
    f.link();
    const oldHead = await f.git(f.worktree, "rev-parse", "HEAD");
    await f.commit();
    const head = await f.git(f.worktree, "rev-parse", "HEAD");
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (...args) => {
      const result = await exec(...args);
      if (args[0] !== "gh" || !args[1].some(arg => arg.includes("isCrossRepository"))) return result;
      expect(args[1].slice(0, 2)).toEqual(["pr", "view"]);
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), headRefOid: oldHead }) };
    };
    const p = await f.finish();
    expect(p.state).toBe("running");
    expect(p.cursor?.stageId).toBe("review");
    expect(p.lastPassedCommit).toBe(head);
    expect(p.publishedCommit).toBe(head);
    // Review starts from the exact published branch despite the stale forge.
    await tickPipelines([], f.h.ports);
    const reviewed = await f.finish("Reviewed the exact published commit.", 2);
    const review = reviewed.runs.find(run => run.stageId === "review")!.attempts[0]!;
    expect(review.report?.provenance.head).toBe(head);
    expect(review.verdict?.status).toBe("pass");
    expect(reviewed.lastPassedCommit).toBe(head);
    expect(reviewed.publishedCommit).toBe(head);
    const { decideMerge } = await import("@/lib/forge/autoMerge");
    const { MERGE_REASONS } = await import("@/lib/forge/mergeReasons");
    expect(decideMerge({ chain: [head] } as Parameters<typeof decideMerge>[0],
      { state: "OPEN", headRefOid: oldHead } as Parameters<typeof decideMerge>[1], [], 0))
      .toEqual({ kind: "block", reason: MERGE_REASONS.headChanged });
  } finally { verifier.mockImplementation(verify); f.close(); }
});


test("a published lane advances through real asynchronous PR head backoff", async () => {
  const f = await fixture();
  try {
    f.link(); await f.commit();
    const exec = f.h.ports.exec;
    let reads = 0, scheduledTurnRanDuringBackoff = false;
    f.h.ports.exec = async (...args) => {
      const isHeadLookup = args[0] === "gh" && args[1].some(arg => arg.includes("isCrossRepository"));
      if (isHeadLookup) {
        reads++;
        if (reads === 2) await new Promise(resolve => setTimeout(resolve, 50));
      }
      const result = await exec(...args);
      if (isHeadLookup && reads === 1) {
        const row = JSON.parse(result.stdout);
        setImmediate(() => { scheduledTurnRanDuringBackoff = reads === 1; });
        return { ...result, stdout: JSON.stringify({ ...row, headRefOid: "2".repeat(40) }) };
      }
      return result;
    };
    const p = await f.finish();
    expect(p.state).toBe("running");
    expect(p.cursor?.stageId).toBe("review");
    expect(reads).toBe(2);
    expect(scheduledTurnRanDuringBackoff).toBe(true);
  } finally { f.close(); }
}, 10_000);


test.each(["pause", "release"] as const)("a %s during the PR head reread cannot advance the lane", async kind => {
  const f = await fixture();
  try {
    f.link(); f.setPrShape("head"); f.setRace(2, kind); await f.commit();
    const p = await f.finish();
    expect(p.cursor?.stageId).toBe("build");
    expect(p.cursor?.state).toBe("committing");
    expect(p.runs.find(run => run.stageId === "review")?.attempts.length ?? 0).toBe(0);
    if (kind === "pause") expect(p.state).toBe("paused");
    else expect(p.delivery!.active).toBe(false);
  } finally { f.close(); }
}, 10_000);
