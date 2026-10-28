import { expect, test } from "bun:test";
import { ensureStagePullRequest } from "./stagePullRequest";
import { engineForgeWriteEnv } from "@/lib/git/agentForgeCredentials";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import type { ExecPort } from "@/lib/workflows/provision";
import { fs, os, path, realExec, engineModule, tickPipelines, loadPipelines, savePipelines, finishReported, realWorktreeLane } from "./engine.fixture";

const REMOTE = "https://github.com/example/widgets.git";
const isBodyPatch = (args: string[]) => args[0] === "api" && args[1] === "-X" && args[2] === "PATCH";
test.each(["publisher", "conflicting"])("native stage fixtures choose their own Git identity in the %s environment", async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-git-environment-"));
  try {
    const home = path.join(root, "home"), hooks = path.join(root, "hooks");
    fs.mkdirSync(home); fs.mkdirSync(hooks);
    const hook = path.join(hooks, "pre-commit"), config = path.join(home, ".gitconfig");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const configText = `[core]\n hooksPath = ${hooks.replaceAll("\\", "/")}\n`;
    fs.writeFileSync(config, configText);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: home,
      TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"), GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks };
    // realExec overlays process.env; undefined must remove inherited values.
    for (const key of Object.keys(env)) if (/^GIT_(?:AUTHOR_|COMMITTER_)/.test(key)) env[key] = undefined;
    if (mode === "conflicting") Object.assign(env, {
      GIT_AUTHOR_NAME: "Ambient", GIT_COMMITTER_NAME: "Ambient",
      GIT_AUTHOR_EMAIL: ["ambient", "example.invalid"].join("@"),
      GIT_COMMITTER_EMAIL: ["ambient", "example.invalid"].join("@"),
      DELEGATUS_PUBLICATION_NAME: "Fixture Agent",
      DELEGATUS_PUBLICATION_EMAIL: ["noreply", "fixture.invalid"].join("@"),
    });
    // Each file owns its engine fixture's lifecycle, so run them separately.
    for (const [file, pattern] of [
      ["engine.ports.test.ts", "^a successor lane on a pull request branch settles its passed stage after a (completed|closed) lane$"],
      ["stagePullRequest.test.ts", "^C: controller creates and links a delivery PR before advancing to review$"],
    ]) {
      const result = await realExec(process.execPath, ["test", `./src/lib/pipelines/${file}`, `--test-name-pattern=${pattern}`],
        process.cwd(), env, { timeoutMs: 20_000 });
      expect(result.code, result.stdout + result.stderr).toBe(0);
    }
    expect(fs.readFileSync(config, "utf8")).toBe(configText);
    expect(fs.readFileSync(hook, "utf8")).toBe("#!/bin/sh\nexit 99\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);

async function fixture(task?: string, reviewBudget = false) {
  const f = await realWorktreeLane("stage-pr", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null,
      ...(reviewBudget ? { onFail: { to: "build", maxRounds: 1 } } : {}) },
  ], "remote-branch", false, false, { task: task ?? "stage-pr" });
  const p = loadPipelines().find(p => p.id === f.id)!;
  p.delivery!.target.remote = REMOTE; savePipelines([p]);
  const calls: string[][] = [];
  let exists = false, refuse = false, loseResponse = false;
  let expectedBody = "Stage implementation summary.";
  let body = "";
  let prShape: "fork" | "head" | "ambiguous" | "closed" | "merged" | "branch" | "number" | undefined;
  let race: { call: number; kind: "pause" | "release" } | undefined;
  f.h.ports.exec = async (command, args, cwd, env, options) => {
    // The fake forge's delivery repository is the native fixture origin.
    if (command === "git" && args[0] === "remote" && args[1] === "get-url" && args.at(-1) === REMOTE)
      return { code: 0, stdout: `${f.origin}\n`, stderr: "" };
    if (command === "gh") {
      // Provenance observations are independent of the delivery guarantee.
      // Only count the controller's exact PR lookup/create/patch awaits here.
      if (args[1] !== "create" && args[1] !== "edit" && !isBodyPatch(args) && !args.some(arg => arg.includes("isCrossRepository")))
        return { code: 1, stdout: "", stderr: "fixture has no observed pull request" };
      calls.push(args);
      if (race?.call === calls.length) {
        const current = loadPipelines().find(p => p.id === f.id)!;
        if (race.kind === "pause") { current.state = "paused"; current.pausedState = "running"; }
        else current.delivery!.active = false;
        savePipelines([current]);
      }
      if (args[0] === "pr" && (args[1] === "list" || args[1] === "view")) {
        const row = { body, title: p.task, number: prShape === "number" ? 18 : 17, headRefName: prShape === "branch" ? "other-head" : p.branch, baseRefName: "main", state: prShape === "closed" ? "CLOSED" : prShape === "merged" ? "MERGED" : "OPEN", isCrossRepository: prShape === "fork",
          headRefOid: prShape === "head" ? "f".repeat(40) : await f.git(f.origin, "rev-parse", `refs/heads/${p.branch}`) };
        if (args[1] === "view") return { code: exists ? 0 : 1, stdout: exists ? JSON.stringify(row) : "", stderr: "" };
        const base = args.indexOf("--base");
        return { code: 0, stdout: JSON.stringify(exists && (base < 0 || args[base + 1] === row.baseRefName) && row.state === "OPEN"
          ? (prShape === "ambiguous" ? [row, { ...row, number: 18 }] : [row]) : []), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        if (refuse) return { code: 1, stdout: "", stderr: "forge refused" };
        expect(fs.readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8")).toBe(expectedBody);
        body = expectedBody;
        exists = true;
        return loseResponse ? { code: null, stdout: "", stderr: "response lost" } : { code: 0, stdout: "https://github.com/example/widgets/pull/17\n", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "edit")
        return { code: 1, stdout: "", stderr: "GraphQL: Projects (classic) is being deprecated (repository.pullRequest.projectCards)" };
      if (isBodyPatch(args)) {
        expect(args[3]).toBe("repos/example/widgets/pulls/17");
        expect(env).toEqual(engineForgeWriteEnv());
        const field = args[args.indexOf("-F") + 1]!;
        expect(field.startsWith("body=@")).toBe(true);
        if (refuse) return { code: 1, stdout: "", stderr: "forge refused" };
        body = fs.readFileSync(field.slice("body=@".length), "utf8");
        return { code: loseResponse ? null : 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected forge call: ${args.join(" ")}`);
    }
    return realExec(command, args.map(a => a === REMOTE ? f.origin : a), cwd, env, options);
  };
  const finish = async (summary = "Stage implementation summary.", n = 1, verdict: "pass" | "fail" = "pass") => {
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict, summary,
      ...(verdict === "fail" ? { findings: [{ severity: "P2" as const, text: "Update the checks." }] } : {}) },
    { kind: "agent", role: n === 2 ? "reviewer" : "builder", conversationId: `conversation_stage_${n}` }, f.h.ports);
    await tickPipelines([finishReported(f.h, `/codex/stage-${n}.jsonl`, verdict, summary)], f.h.ports);
    return loadPipelines().find(p => p.id === f.id)!;
  };
  const commit = async () => {
    await f.git(f.worktree, "commit", "--allow-empty", "-m", "stage output");
  };
  return { ...f, calls, finish, commit, body: () => body, setBody: (value: string) => { body = value; }, setExpectedBody: (body: string) => { expectedBody = body; }, setPrShape: (shape: typeof prShape) => { exists = true; prShape = shape; }, setRace: (call: number, kind: "pause" | "release") => { race = { call, kind }; }, setMissing: () => { exists = false; }, setExisting: () => { exists = true; }, setRefused: (value = true) => { refuse = value; }, setLost: () => { loseResponse = true; },
    link: (successor = true) => {
      const current = loadPipelines().find(lane => lane.id === f.id)!;
      current.delivery!.target.pr = 17;
      if (successor) current.baseBranch = p.branch;
      savePipelines([current]); exists = true;
    },
    close: () => { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); } };
}

const originalBudgetBody = "Producer implementation notes. 7 tests passed; independent review to come.\n\n---\nGenerated with Delegatus.";
const fixSummary = "Fixed the checks. 9 tests passed; typecheck passed.";

async function finalBudgetFixFixture() {
  const f = await fixture(undefined, true);
  try {
    f.setExpectedBody(originalBudgetBody);
    await f.commit();
    expect((await f.finish(originalBudgetBody)).cursor?.stageId).toBe("review");
    await tickPipelines([], f.h.ports);
    expect((await f.finish("Checks need updating.", 2, "fail")).cursor?.stageId).toBe("build");
    await tickPipelines([], f.h.ports);
    await f.commit();
    return f;
  } catch (error) { f.close(); throw error; }
}

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
    const summary = 'Перевірено résumé: "quoted", \\backslash, $value, `code`, {owner}, {repo}, {branch}.';
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
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "process.exit(1);\n");
    await f.git(f.worktree, "add", "scripts/privacy-publication-gate.ts");
    await f.commit();
    const p = await f.finish(fixSummary, 3);
    expect(p.state).toBe("needs_decision");
    expect(p.stateDetail).toContain("repository publication privacy gate");
    expect(f.calls.filter(isBodyPatch)).toHaveLength(0);
    expect(f.body()).toBe(originalBudgetBody);
  } finally { f.close(); }
});

test.each(["body", "title"] as const)("the final budget refresh refuses an unreadable existing PR %s", async field => {
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
    expect(p.state).toBe("needs_decision");
    expect(p.stateDetail).toContain("body refresh could not read its existing text");
    expect(f.calls.filter(isBodyPatch)).toHaveLength(0);
    expect(f.body()).toBe(originalBudgetBody);
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

async function publishedHeadFixture(linked = true) {
  const f = await fixture();
  const pipeline = loadPipelines().find(p => p.id === f.id)!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  const head = "1".repeat(40);
  pipeline.lastPassedCommit = pipeline.publishedCommit = head;
  pipeline.delivery!.operation = { id: "published-stage", epoch: pipeline.delivery!.epoch, sha: head,
    requestKey: `pass:${pipeline.cursor!.stageId}:${attempt.n}`, passedStage: true,
    state: "settled", result: { ok: true, sha: head, remote: "published" } };
  if (linked) pipeline.delivery!.target.pr = 17;
  const row = { number: 17, headRefName: pipeline.branch, baseRefName: pipeline.baseBranch,
    state: "OPEN", isCrossRepository: false, headRefOid: head };
  let clock = 0;
  const waits: number[] = [];
  const timing = { now: () => clock, sleep: async (ms: number) => { waits.push(ms); clock += ms; } };
  return { ...f, pipeline, attempt, row, timing, waits, advance: (ms: number) => { clock += ms; }, elapsed: () => clock };
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
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing)).toEqual({ ok: true });
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
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing))
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
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing)).toEqual({ ok: false,
      error: failure === "exit" ? "the delivery pull request lookup failed"
        : "the delivery pull request could not be verified; the stage cannot pass without it" });
    expect(reads).toBe(2);
    expect(f.waits).toEqual([1_000]);
  } finally { f.close(); }
});

test("an initial gh failure has no head-lag evidence to retry", async () => {
  const f = await publishedHeadFixture();
  try {
    const exec: ExecPort = async () => ({ code: 1, stdout: "", stderr: "forge unavailable" });
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing))
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
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing))
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
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing))
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
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing))
      .toEqual({ ok: false, error: "the delivery pull request differs in headRefOid" });
    expect(f.elapsed()).toBe(30_000);
    expect(reads).toBe(slow === "sleep" ? 1 : 2);
  } finally { f.close(); }
});

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
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing)).toEqual({ ok: true });
  } finally { f.close(); }
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

test("C: controller creates and links a delivery PR before advancing to review", async () => {
  const f = await fixture();
  try {
    await f.commit();
    const p = await f.finish();
    expect(p.delivery?.target.pr).toBe(17);
    expect(p.cursor?.stageId).toBe("review");
    const create = f.calls.find(a => a[1] === "create")!;
    expect(create).toContain("--body-file"); expect(create[create.indexOf("--head") + 1]).toBe(p.branch);
  } finally { f.close(); }
});

test("C: an existing delivery PR is discovered without another create", async () => {
  const f = await fixture();
  try {
    f.setExisting(); await f.commit();
    expect((await f.finish()).delivery?.target.pr).toBe(17);
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(0);
    expect(f.calls.filter(a => a[1] === "edit")).toHaveLength(0);
  } finally { f.close(); }
});

test.each([true, false])("linked PR accepts the published stage regardless of lane base (successor: %s)", async successor => {
  const f = await fixture();
  try {
    f.link(successor); await f.commit();
    const p = await f.finish();
    expect(p.state).toBe("running");
    expect(p.cursor).toMatchObject({ stageId: "review", state: "pending" });
    expect(p.runs[0]!.attempts[0]!.state).toBe("passed");
    expect(p.publishedCommit).toBe(await f.git(f.worktree, "rev-parse", "HEAD"));
    expect(f.calls.filter(args => args[1] === "create")).toHaveLength(0);
    expect(f.calls.find(args => args[1] === "view")).toContain("17");
  } finally { f.close(); }
});

test.each([false, true])("an unchanged successor still verifies its linked PR (closed: %s)", async closed => {
  const f = await fixture();
  try {
    f.link(); if (closed) f.setPrShape("closed");
    const p = await f.finish();
    expect(p.lastPassedCommit).toBe(p.baseRef);
    expect(p.state).toBe(closed ? "needs_decision" : "running");
    expect(p.cursor?.stageId).toBe(closed ? "build" : "review");
    expect(f.calls.find(args => args[1] === "view")).toContain("17");
    if (closed) expect(p.stateDetail).toContain("state (expected OPEN, received CLOSED)");
  } finally { f.close(); }
});

test.each([
  ["closed", "state"], ["merged", "state"], ["fork", "isCrossRepository"],
  ["head", "headRefOid"], ["branch", "headRefName"], ["number", "number"],
] as const)("linked PR refuses a mismatched %s with its field", async (shape, field) => {
  const f = await fixture();
  try {
    f.link(); f.setPrShape(shape); await f.commit();
    const p = await f.finish();
    expect(p.state).toBe("needs_decision");
    expect(p.cursor).toMatchObject({ stageId: "build", state: "committing" });
    expect(p.stateDetail).toContain(field);
    expect(f.calls.filter(args => args[1] === "create")).toHaveLength(0);
  } finally { f.close(); }
}, 40_000);

test.each(["skip-stage", "retry-stage", "publish"] as const)("blocked linked PR admits %s after publication settled", async action => {
  const f = await fixture();
  try {
    f.link(); f.setPrShape("closed"); await f.commit();
    const parked = await f.finish();
    expect(parked.state).toBe("needs_decision");
    expect(parked.delivery?.operation).toMatchObject({ state: "settled", passedStage: false, result: { ok: true } });
    // Split controller and Git phases as the serving scheduler does. An old
    // successful push must not revive a later PR refusal between seat reads.
    let entered!: () => void, release!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const exec = f.h.ports.exec;
    const ticking = tickPipelines([], { ...f.h.ports, exec: async (...args) => {
      if (args[0] === "gh" && args[1].some(arg => arg.includes("isCrossRepository"))) { entered(); await held; }
      return exec(...args);
    } });
    let result: Awaited<ReturnType<typeof engineModule.patchPipeline>>;
    try {
      await Promise.race([checking, ticking]);
      result = await engineModule.patchPipeline(f.id, { action }, f.h.ports);
    } finally { release(); await ticking; }
    expect(result.error).toBeUndefined();
    if (action === "skip-stage") {
      await engineModule.settlePendingRemoteActions(f.h.ports);
      const skipped = loadPipelines().find(lane => lane.id === f.id)!;
      expect(skipped.remoteAction?.error).toBeUndefined();
      expect(skipped.cursor?.stageId).toBe("review");
      expect(skipped.runs[0]!.attempts[0]!.state).toBe("skipped");
    } else {
      expect(result.pipeline?.state).toBe("running");
      f.setPrShape(undefined);
      await tickPipelines([], f.h.ports);
      expect(loadPipelines().find(lane => lane.id === f.id)!.cursor?.stageId).toBe("review");
    }
  } finally { f.close(); }
});

test("a successor PR refusal accepts a guarded decision answer", async () => {
  const f = await fixture();
  try {
    f.link(); f.setPrShape("closed"); await f.commit();
    const parked = await f.finish();
    expect(parked.state).toBe("needs_decision");
    const { pipelineRevision } = await import("./store");
    const result = await engineModule.patchPipeline(f.id, { action: "resolve-decision",
      clientRequestId: "successor-pr-answer", answer: "Check the delivery pull request again.",
      expectedStageId: "build", expectedAttempt: 1, expectedRevision: pipelineRevision(parked) },
    f.h.ports, { kind: "operator" });
    expect(result.error).toBeUndefined();
    expect(result.pipeline?.state).toBe("running");
    expect(result.pipeline?.decisionAnswers).toHaveLength(1);
  } finally { f.close(); }
});

test("a terminal PR refusal stays parked after controller restart and accepts skip-stage", async () => {
  const f = await fixture();
  try {
    f.link(); await f.commit(); await f.finish();
    await tickPipelines([], f.h.ports);
    f.setPrShape("closed");
    const parked = await f.finish("Review passed.", 2);
    expect(parked.state).toBe("needs_decision");
    expect(parked.cursor).toMatchObject({ stageId: "review", state: "committing" });
    const driver = `
      const { defaultPipelinePorts, tickPipelines, patchPipeline } = await import("@/lib/pipelines/engine");
      const { loadPipelines } = await import("@/lib/pipelines/store");
      const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
      const { realExec } = await import("@/lib/workflows/provision");
      registerPipelineTick(async () => {});
      let forgeReads = 0;
      const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(f.h.ports.now())},
        conversationAgentActive: async () => false, conversationDeliveryOutstanding: () => false,
        paneAgentAlive: async () => false, stageHostResident: async () => false,
        durableTurnEvidence: async () => null, remoteActionSupported: () => true,
        exec: async (command, args, cwd, env, options) => {
          if (command === "gh") { forgeReads++; return { code: 1, stdout: "", stderr: "" }; }
          return realExec(command, args.map(arg => arg === ${JSON.stringify(REMOTE)} ? ${JSON.stringify(f.origin)} : arg), cwd, env, options);
        } };
      await tickPipelines([], ports);
      const lane = loadPipelines().find(lane => lane.id === ${JSON.stringify(f.id)});
      const result = await patchPipeline(lane.id, { action: "skip-stage", expectedStageId: "review", expectedAttempt: 1 }, ports);
      console.log(JSON.stringify({ state: lane.state, forgeReads, error: result.error ?? null, action: result.pipeline?.remoteAction?.action }));
    `;
    const result = await realExec(process.execPath, ["-e", driver], process.cwd(), {
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_CONTROL_URL: "http://127.0.0.1:1",
    }, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ state: "needs_decision", forgeReads: 0, error: null, action: "skip-stage" });
    await engineModule.settlePendingRemoteActions(f.h.ports);
    const skipped = loadPipelines().find(lane => lane.id === f.id)!;
    expect(skipped.remoteAction?.error).toBeUndefined();
    expect(skipped.state).toBe("completed");
    expect(skipped.runs[1]!.attempts[0]!.state).toBe("skipped");
  } finally { f.close(); }
});

test("C: a lost creation response recovers the PR from the delivery branch", async () => {
  const f = await fixture();
  try {
    f.setLost(); await f.commit();
    const p = await f.finish(); expect(p.delivery?.target.pr).toBe(17); expect(p.cursor?.stageId).toBe("review");
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(1);
  } finally { f.close(); }
});

test("C: a refused PR cannot leave a passing stage without a linked PR", async () => {
  const f = await fixture();
  try {
    f.setRefused(); await f.commit();
    const p = await f.finish(); expect(p.state).toBe("needs_decision"); expect(p.cursor?.stageId).toBe("build");
    expect(p.runs[0]!.attempts[0]!.state).toBe("needs_decision");
    expect(p.runs[0]!.attempts[0]!.publicationTextRepair).toBeUndefined();
    expect(p.stateDetail).toContain("pull request"); expect(p.delivery?.target.pr).toBeUndefined();
  } finally { f.close(); }
});

test.each([
  { kind: "path", privateText: "/home/" + "private-user/work" },
  { kind: "email", privateText: ["someone", "private.invalid"].join("@") },
  { kind: "credential", privateText: "ghp_" + "A".repeat(36) },
])("C: private stage text cannot reach a PR write ($kind)", async ({ privateText }) => {
  const f = await fixture();
  try {
    await f.commit();
    const p = await f.finish(privateText);
    expect(p.state).toBe("needs_decision"); expect(p.cursor?.stageId).toBe("build");
    expect(p.stateDetail).toContain("privacy"); expect(f.calls.filter(a => a[1] === "create")).toHaveLength(0);
    expect(p.stateDetail).not.toContain(privateText);
  } finally { f.close(); }
});


for (const kind of ["pause", "release"] as const) for (const call of [1, 2, 3]) {
  test(`C: ${kind} during forge await ${call} cannot accept a stale PR result`, async () => {
    const f = await fixture();
    try {
      await f.commit(); f.setRace(call, kind);
      const p = await f.finish();
      expect(p.delivery?.target.pr).toBeUndefined();
      expect(p.cursor?.stageId).toBe("build");
      if (kind === "pause") expect(p.state).toBe("paused");
      else expect(p.delivery?.active).toBe(false);
      expect(f.calls.filter(a => a[1] === "create").length).toBeLessThanOrEqual(call === 1 ? 0 : 1);
    } finally { f.close(); }
  });
}

test("C: the repository's privacy gate can refuse otherwise public summary text", async () => {
  const f = await fixture();
  try {
    const scripts = path.join(f.worktree, "scripts"); fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "process.exit(1);\n");
    await f.git(f.worktree, "add", "scripts"); await f.commit();
    const p = await f.finish();
    expect(p.state).toBe("needs_decision"); expect(p.stateDetail).toContain("repository publication privacy gate");
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(0);
  } finally { f.close(); }
});

test.each([{ terminalOutput: false }, { terminalOutput: true }])("C: a migrated lane gets its PR before review finishes (local output=$terminalOutput)", async ({ terminalOutput }) => {
  const f = await fixture();
  try {
    await f.commit(); f.setExisting();
    await f.finish();
    const current = loadPipelines().find(p => p.id === f.id)!;
    delete current.delivery!.target.pr;
    if (terminalOutput) { delete current.publication; current.stages[1]!.outputs = ["review.md"]; }
    savePipelines([current]);
    // Simulate a lane built by the older controller; its PR is absent too.
    f.setMissing();
    await tickPipelines([], f.h.ports);
    if (terminalOutput) fs.writeFileSync(path.join(f.worktree, "review.md"), "Review passed.\n");
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass", summary: "Review passed." },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_2" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-2.jsonl", "pass", "Review passed.")], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.delivery?.target.pr).toBe(17);
    expect(done.state).toBe("completed");
  } finally { f.close(); }
});


test("C: retrying a legacy terminal-output forge refusal never publishes its local report commit", async () => {
  const f = await fixture();
  try {
    await f.commit(); f.setExisting();
    await f.finish();
    const current = loadPipelines().find(p => p.id === f.id)!;
    delete current.delivery!.target.pr;
    delete current.publication;
    current.stages[1]!.outputs = ["review.md"];
    savePipelines([current]);
    f.setExpectedBody("Review passed.");
    f.setMissing();
    await tickPipelines([], f.h.ports);
    fs.writeFileSync(path.join(f.worktree, "review.md"), "Review passed.\n");
    const publishedHead = await f.git(f.origin, "rev-parse", `refs/heads/${current.branch}`);
    f.setRefused();
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass", summary: "Review passed." },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_2" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-2.jsonl", "pass", "Review passed.")], f.h.ports);
    const refused = loadPipelines().find(p => p.id === f.id)!;
    expect(refused.state).toBe("needs_decision");
    expect(refused.lastPassedCommit).toBe(publishedHead);
    expect(refused.runs[1]!.attempts[0]!.state).toBe("needs_decision");
    expect(refused.runs[1]!.attempts[0]!.terminalOutputPublication).toMatchObject({ pullRequestHead: publishedHead });
    expect(refused.runs[1]!.attempts[0]!.terminalOutputPublication!.localSha).not.toBe(publishedHead);

    f.setRefused(false); f.setExisting();
    expect((await engineModule.patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${current.branch}`)).toBe(publishedHead);
    const retried = loadPipelines().find(p => p.id === f.id)!;
    expect(retried.lastPassedCommit).toBe(publishedHead);
    expect(retried.runs[1]!.attempts[0]!.terminalOutputPublication).toBeUndefined();
    expect(retried.delivery?.target.pr).toBe(17);
    expect(retried.state).toBe("completed");
  } finally { f.close(); }
});

test("a legacy privacy rewrite checkpoint removes the old terminal marker before report delivery and survives restart", async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.worktree, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(f.worktree, "scripts/privacy-publication-gate.ts"), "// Controlled privacy gate fixture.\n");
    const initialExec = f.h.ports.exec;
    f.h.ports.exec = async (command, args, cwd, env, options) => command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")
      ? { code: 0, stdout: "PRIVACY GATE: PASS\n", stderr: "" }
      : initialExec(command, args, cwd, env, options);
    await f.git(f.worktree, "add", "scripts/privacy-publication-gate.ts");
    await f.commit(); f.setExisting();
    await f.finish();
    const current = loadPipelines().find(p => p.id === f.id)!;
    delete current.delivery!.target.pr;
    delete current.publication;
    current.stages[1]!.outputs = ["review.md"];
    current.runs[0]!.attempts[0]!.paneId = null;
    savePipelines([current]);
    f.setMissing();
    await tickPipelines([], f.h.ports);
    fs.writeFileSync(path.join(f.worktree, "review.md"), "Review passed.\n");
    const publishedHead = await f.git(f.origin, "rev-parse", `refs/heads/${current.branch}`);
    f.setRefused();
    f.setExpectedBody("Review passed.");
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass", summary: "Review passed.", result: "Review result", taskSummary: { headline: "Reviewed", text: "Review complete." } },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_2" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-2.jsonl", "pass", "Review passed.")], f.h.ports);
    const legacyRefusal = loadPipelines().find(p => p.id === f.id)!;
    const owner = legacyRefusal.runs[1]!.attempts[0]!;
    expect(owner.terminalOutputPublication).toMatchObject({ pullRequestHead: publishedHead });
    expect(owner.terminalOutputPublication!.localSha).not.toBe(publishedHead);
    const localReportSha = owner.terminalOutputPublication!.localSha;

    const originalExec = f.h.ports.exec;
    let gateCalls = 0;
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")) gateCalls++;
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts") && args.at(-1)?.endsWith("body.md"))
        return { code: 1, stdout: "PRIVACY GATE: FAIL\nknown_value: 1\n", stderr: "" };
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts"))
        return { code: 0, stdout: "PRIVACY GATE: PASS\n", stderr: "" };
      return originalExec(command, args, cwd, env, options);
    };
    f.setRefused(false); f.setMissing(); f.setExpectedBody(publicSummary);
    expect(fs.existsSync(path.join(f.worktree, "scripts/privacy-publication-gate.ts"))).toBe(true);
    f.h.ports.resumeSeveredTurn = async () => {
      const report = await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
        { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
      expect(report.error).toBeUndefined();
      f.h.setConversationActive(false);
      const checkpoint = loadPipelines().find(p => p.id === f.id)!;
      const saved = checkpoint.runs[1]!.attempts[0]!;
      expect(saved.publicationTextRepair).toMatchObject({ state: "answered", sha: localReportSha });
      expect(saved.report?.result).toBe("Review result");
      expect(saved.report?.taskSummary).toEqual({ headline: "Reviewed", text: "Review complete." });
      expect(saved.terminalOutputPublication).toBeUndefined();
      expect(checkpoint.lastPassedCommit).toBe(localReportSha);
      return true;
    };
    expect((await engineModule.patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);

    const checkpoint = loadPipelines().find(p => p.id === f.id)!;
    const checkpointAttempt = checkpoint.runs[1]!.attempts[0]!;
    expect(gateCalls).toBeGreaterThan(0);
    expect(checkpointAttempt.publicationTextRepair).toMatchObject({ state: "answered", pullRequestHead: publishedHead });
    expect(checkpointAttempt.terminalOutputPublication).toBeUndefined();

    const reload = await realExec(process.execPath, ["-e", `
      const { loadPipelines } = await import("@/lib/pipelines/store");
      const { defaultPipelinePorts, settlePendingStageGit } = await import("@/lib/pipelines/engine");
      const { realExec } = await import("@/lib/workflows/provision");
      const lane = loadPipelines().find(item => item.id === ${JSON.stringify(f.id)});
      const attempt = lane.runs[1].attempts[0];
      const head = attempt.publicationTextRepair.pullRequestHead;
      const branch = lane.delivery.target.branch.replace(/^refs\\/heads\\//, "");
      const at = Date.parse(attempt.publicationTextRepair.answeredAt) + 1_000;
      await settlePendingStageGit({ ...defaultPipelinePorts(), now: () => new Date(at).toISOString(),
        conversationAgentActive: async () => false, conversationDeliveryOutstanding: () => false,
        durableTurnEvidence: async () => ({ turn: "terminal", message: { ts: at, text: "Rewrite completed." } }),
        exec: async (command, args, cwd, env, options) => command === "gh"
          ? { code: 0, stdout: JSON.stringify([{ number: 17, headRefName: branch, baseRefName: lane.baseBranch,
            state: "OPEN", isCrossRepository: false, headRefOid: head }]), stderr: "" }
          : realExec(command, args, cwd, env, options) });
      const settled = loadPipelines().find(item => item.id === ${JSON.stringify(f.id)});
      const saved = settled.runs[1].attempts[0];
      console.log(JSON.stringify({ state: settled.state, lastPassedCommit: settled.lastPassedCommit,
        repair: saved.publicationTextRepair, terminalOutputPublication: saved.terminalOutputPublication,
        pullRequest: settled.delivery.target.pr }));
    `], process.cwd(), process.env, { timeoutMs: 15_000 });
    expect(reload.code, reload.stderr).toBe(0);
    const persisted = JSON.parse(reload.stdout.trim());
    expect(persisted.state).toBe("completed");
    expect(persisted.pullRequest).toBe(17);
    expect(persisted.terminalOutputPublication).toBeUndefined();
    expect(persisted.lastPassedCommit).toBe(localReportSha);

    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.state).toBe("completed");
    expect(done.runs[1]!.attempts[0]!.terminalOutputPublication).toBeUndefined();
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${current.branch}`)).toBe(publishedHead);
  } finally { f.close(); }
});

test("C: summary fingerprint inspection lets an independent scheduler advance", async () => {
  const { pipelinePublicationTextSafe } = await import("./git");
  let progressed = 0;
  let heartbeat: ReturnType<typeof setImmediate>;
  const tick = () => { progressed++; heartbeat = setImmediate(tick); };
  heartbeat = setImmediate(tick);
  try {
    const inspected = await pipelinePublicationTextSafe("Public implementation detail. ".repeat(100));
    expect(progressed).toBeGreaterThan(1);
    expect(inspected).not.toBeNull();
  } finally { clearImmediate(heartbeat); }
});


test.each(["fork", "head", "ambiguous"] as const)("C: an unrelated PR result is refused (%s)", async shape => {
  const f = await fixture();
  try {
    await f.commit(); f.setPrShape(shape);
    const p = await f.finish();
    expect(p.state).toBe("needs_decision"); expect(p.delivery?.target.pr).toBeUndefined();
    expect(f.calls.filter(a => a[1] === "create")).toHaveLength(0);
  } finally { f.close(); }
}, 40_000);


test("C: a publishing delivery without a supported PR service cannot pass", async () => {
  const f = await fixture();
  try {
    const p = loadPipelines().find(p => p.id === f.id)!;
    p.lastPassedCommit = "1".repeat(40);
    p.delivery!.target.remote = "https://forge.invalid/example/widgets.git";
    const { ensureStagePullRequest } = await import("./stagePullRequest");
    const result = await ensureStagePullRequest(p, p.runs[0]!.attempts[0]!, realExec);
    expect(result.ok).toBe(false);
  } finally { f.close(); }
});


test.each(([
  ["body", "/home/" + "private-user/evidence", "absolute-path"],
  ["title", ["someone", "private.invalid"].join("@"), "email"],
  ["body", "ghp_" + "A".repeat(36), "credential"],
  ["body", "%" + "25".repeat(20) + "41", "decode"],
  ["body", "", "size"],
  ["body", "a".repeat(60 * 1024 + 1), "size"],
] as const).map(([part, value, kind], index) => ({ part, value, kind, index })))("PR text diagnostic redacts $part/$kind ($index)", async ({ part, value, kind }) => {
  const { inspectPullRequestText } = await import("./stagePullRequest");
  const result = await inspectPullRequestText(part, value);
  expect(result).toMatchObject({ ok: false, privacy: { part, kind } });
  if (!result.ok) {
    expect(result.error).toContain("[redacted]");
    if (value) expect(result.error).not.toContain(value);
  }
});

const unsafeSummary = "Evidence: /home/" + "private-user/evidence";
const publicSummary = "Verified ORM write_uid/create_uid/calculated_by_id fields. 42 tests passed. Revision " + "ab12".repeat(10) + ".";

async function rewritingFixture() {
  const f = await fixture();
  const sends: Array<Parameters<NonNullable<typeof f.h.ports.resumeSeveredTurn>>[0]> = [];
  f.h.ports.resumeSeveredTurn = async input => { sends.push(input); f.h.setConversationActive(true); return true; };
  await f.commit();
  const before = loadPipelines().find(p => p.id === f.id)!;
  before.runs[0]!.attempts[0]!.paneId = null;
  savePipelines([before]);
  const initial = await f.finish(unsafeSummary);
  const read = () => loadPipelines().find(p => p.id === f.id)!;
  const answer = async (summary: string) => {
    const report = await engineModule.reportStageCompletion({ verdict: "pass", summary },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    expect(report.error).toBeUndefined();
    f.h.setConversationActive(false);
    await tickPipelines([finishReported(f.h, "/codex/stage-1.jsonl", "pass", summary)], f.h.ports);
    return read();
  };
  return { ...f, sends, initial, read, answer };
}

test("PR summary rewrite preserves attempt, accepted SHA, verdict and provenance", async () => {
  const f = await rewritingFixture();
  try {
    const initial = f.initial;
    expect(initial.state).toBe("running");
    expect(initial.stateDetail).toContain("absolute-path");
    expect(initial.runs[0]!.attempts[0]!.error).toContain("body [redacted]");
    const { projectPipelineEvents } = await import("@/lib/lifecycle/projector");
    const events = projectPipelineEvents([initial]);
    const refusal = events.find(event => event.key.includes("summary-rewrite:"))!;
    const { isTerminalHighSignalEvent } = await import("@/lib/lifecycle/vocabulary");
    expect(refusal.summary).toContain("absolute-path");
    expect(isTerminalHighSignalEvent(refusal.type)).toBe(true); // The seat's actual wake filter.
    const answered = structuredClone(initial);
    answered.runs[0]!.attempts[0]!.publicationTextRepair!.state = "answered";
    expect(projectPipelineEvents([answered]).find(event => event.key === refusal.key)?.summary).toBe(refusal.summary);
    const exhausted = structuredClone(initial);
    exhausted.runs[0]!.attempts[0]!.publicationTextRepair!.state = "exhausted";
    const exhaustedRefusal = projectPipelineEvents([exhausted]).find(event => event.key.includes("summary-rewrite:"))!;
    expect(exhaustedRefusal.key).not.toBe(refusal.key);
    expect(isTerminalHighSignalEvent(exhaustedRefusal.type)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(unsafeSummary);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]!.text).toContain("absolute-path");
    expect(f.sends[0]!.text).not.toContain(unsafeSummary);
    expect(f.calls.some(call => call[1] === "create")).toBe(false);
    const original = structuredClone(initial.runs[0]!.attempts[0]!.report!);
    f.setExpectedBody(publicSummary);
    const done = await f.answer(publicSummary);
    expect(done.cursor?.stageId).toBe("review");
    expect(done.lastPassedCommit).toBe(initial.lastPassedCommit);
    expect(done.runs[0]!.attempts).toHaveLength(1);
    const report = done.runs[0]!.attempts[0]!.report!;
    expect(report.verdict).toEqual(original.verdict);
    expect(report.provenance).toEqual(original.provenance);
    expect(report.summary).toBe(publicSummary);
    expect(f.calls.filter(call => call[1] === "create")).toHaveLength(1);
  } finally { f.close(); }
});

test("two refused summary rewrites park with the class; retry-stage asks again on the same attempt", async () => {
  const f = await rewritingFixture();
  try {
    await f.answer(unsafeSummary);
    expect(f.sends).toHaveLength(2);
    const exhausted = await f.answer(unsafeSummary);
    expect(exhausted.state).toBe("needs_decision");
    expect(exhausted.stateDetail).toContain("absolute-path");
    expect(exhausted.stateDetail).toContain("budget exhausted");
    expect(f.sends).toHaveLength(2);
    const retried = await engineModule.patchPipeline(f.id, { action: "retry-stage" }, f.h.ports);
    expect(retried.error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(3);
    expect(f.sends[2]!.clientMessageId).not.toBe(f.sends[0]!.clientMessageId);
    f.setExpectedBody(publicSummary);
    const done = await f.answer(publicSummary);
    expect(done.cursor?.stageId).toBe("review");
    expect(done.runs[0]!.attempts).toHaveLength(1);
    expect(done.lastPassedCommit).toBe(exhausted.lastPassedCommit);
  } finally { f.close(); }
});

test("a refused task title asks the seat to correct it and sends no producer rewrite", async () => {
  const f = await fixture(unsafeSummary);
  try {
    const sends: string[] = [];
    f.h.ports.resumeSeveredTurn = async input => { sends.push(input.text); return true; };
    await f.commit();
    const parked = await f.finish();
    expect(parked.stateDetail).toContain("title [redacted]");
    expect(parked.stateDetail).toContain("pipeline task");
    expect(parked.stateDetail).not.toContain(unsafeSummary);
    expect(sends).toEqual([]);
  } finally { f.close(); }
});

test("summary rewrite rejects verdict changes and cannot accept a new commit", async () => {
  const f = await rewritingFixture();
  try {
    const refused = await engineModule.reportStageCompletion({ verdict: "fail", summary: "Changed outcome" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    expect(refused.code).toBe("STAGE_REPORT_SUMMARY_ONLY");
    const stranger = await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
      { kind: "agent", role: "builder", conversationId: "unrelated-conversation" }, f.h.ports);
    expect(stranger.code).toBe("STAGE_REPORT_NOT_AN_ATTEMPT");
    fs.writeFileSync(path.join(f.worktree, "extra.txt"), "Extra change.\n");
    await tickPipelines([], f.h.ports);
    expect(f.read().state).toBe("needs_decision");
    expect(f.read().stateDetail).toContain("unchanged clean accepted head");
    expect(f.calls.some(call => call[1] === "create")).toBe(false);
  } finally { f.close(); }
});

test("ORM identifiers, counts and a full SHA pass every real PR text check", async () => {
  const f = await fixture();
  try {
    const gate = path.join(process.cwd(), "scripts/privacy-publication-gate.ts");
    const fingerprints = path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json");
    const scripts = path.join(f.worktree, "scripts"); fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "// Fixture uses the real gate through its exec port.\n");
    await f.git(f.worktree, "add", "scripts");
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (command, args, cwd, env, options) => command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")
      ? realExec(process.execPath, [gate, ...args.slice(1)], cwd, { ...env, LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints }, options)
      : exec(command, args, cwd, env, options);
    await f.commit(); f.setExpectedBody(publicSummary);
    const done = await f.finish(publicSummary);
    expect(done.cursor?.stageId).toBe("review");
    expect(done.delivery?.target.pr).toBe(17);
  } finally { f.close(); }
});


test("a fresh controller process honors the persisted summary rewrite budget", async () => {
  const f = await rewritingFixture();
  try {
    await f.answer(unsafeSummary); // Second request is durable before restart.
    const submitted = await engineModule.reportStageCompletion({ verdict: "pass", summary: unsafeSummary },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    expect(submitted.error).toBeUndefined();
    const at = Date.parse(submitted.report!.at) + 1_000;
    const driver = `
      const { defaultPipelinePorts, settlePendingStageGit } = await import("@/lib/pipelines/engine");
      const { loadPipelines } = await import("@/lib/pipelines/store");
      const { realExec } = await import("@/lib/workflows/provision");
      const sends = [];
      const ports = { ...defaultPipelinePorts(), now: () => new Date(${at}).toISOString(),
        conversationAgentActive: async () => false, conversationDeliveryOutstanding: () => false,
        durableTurnEvidence: async () => ({ turn: "terminal", message: { ts: ${at}, text: "Rewrite completed." } }),
        resumeSeveredTurn: async input => { sends.push(input.clientMessageId); return true; },
        exec: async (command, args, cwd, env, options) => command === "gh"
          ? { code: 0, stdout: "[]", stderr: "" }
          : realExec(command, args.map(arg => arg === ${JSON.stringify(REMOTE)} ? ${JSON.stringify(f.origin)} : arg), cwd, env, options) };
      await settlePendingStageGit(ports);
      const lane = loadPipelines().find(lane => lane.id === ${JSON.stringify(f.id)});
      console.log(JSON.stringify({ state: lane.state, rounds: lane.runs[0].attempts[0].publicationTextRepair.rounds, sends }));
    `;
    const result = await realExec(process.execPath, ["-e", driver], process.cwd(), {
      ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR,
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_RUNTIME_HOST_CONTROL_URL: "http://127.0.0.1:1",
    }, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ state: "needs_decision", rounds: 2, sends: [] });
    expect(f.read().stateDetail).toContain("absolute-path");
    expect(f.read().lastPassedCommit).toBe(f.initial.lastPassedCommit);
  } finally { f.close(); }
});

test.each(["known-value", "unavailable"] as const)("repository PR text refusal identifies its class (%s) and withholds raw output", async mode => {
  const f = await fixture();
  try {
    const scripts = path.join(f.worktree, "scripts"); fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "// Controlled gate fixture.\n");
    await f.git(f.worktree, "add", "scripts");
    const exec = f.h.ports.exec;
    f.h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "bun" && args[0]?.endsWith("privacy-publication-gate.ts")) {
        if (mode === "unavailable") throw Object.assign(new Error("private diagnostic"), { code: "ENOENT" });
        if (args.at(-1)?.endsWith("body.md")) return { code: 1,
          stdout: "PRIVACY GATE: FAIL\nknown_value: 1\n" + unsafeSummary, stderr: unsafeSummary };
        return { code: 0, stdout: "PRIVACY GATE: PASS\n", stderr: "" };
      }
      return exec(command, args, cwd, env, options);
    };
    await f.commit();
    const parked = await f.finish();
    expect(parked.stateDetail).toContain(mode === "known-value" ? "body [redacted]" : "title [redacted]");
    expect(parked.stateDetail).toContain(mode === "known-value" ? "known-value" : "inspection-error");
    expect(parked.stateDetail).not.toContain(unsafeSummary);
    expect(f.calls.some(call => call[1] === "create")).toBe(false);
  } finally { f.close(); }
});

test("a summary rewrite that never reports expires with the original named refusal", async () => {
  const f = await rewritingFixture();
  try {
    f.h.advanceWallClock(10 * 60_000);
    f.h.setConversationActive(false);
    await tickPipelines([], f.h.ports);
    expect(f.read().state).toBe("needs_decision");
    expect(f.read().stateDetail).toContain("absolute-path");
    expect(f.read().stateDetail).toContain("ten minutes");
    expect(f.sends).toHaveLength(1);
  } finally { f.close(); }
});


test("a legacy terminal-output PR refusal rewrites the producer summary while its output commit stays local", async () => {
  const f = await fixture();
  try {
    await f.commit(); f.setExisting(); await f.finish();
    const current = loadPipelines().find(p => p.id === f.id)!;
    delete current.delivery!.target.pr;
    delete current.publication;
    current.stages[1]!.outputs = ["review.md"];
    current.runs[0]!.attempts[0]!.report!.summary = unsafeSummary;
    savePipelines([current]); f.setMissing();
    await tickPipelines([], f.h.ports);
    fs.writeFileSync(path.join(f.worktree, "review.md"), "Review passed.\n");
    f.h.setConversationActive(false);
    const sends: string[] = [];
    f.h.ports.resumeSeveredTurn = async input => { sends.push(input.conversationId); f.h.setConversationActive(true); return true; };
    await engineModule.reportStageCompletion({ verdict: "pass", summary: "Review passed." },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_2" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-2.jsonl", "pass", "Review passed.")], f.h.ports);
    const rewriting = loadPipelines().find(p => p.id === f.id)!;
    expect(sends).toEqual(["conversation_stage_1"]);
    const accepted = rewriting.lastPassedCommit;
    const remote = await f.git(f.origin, "rev-parse", `refs/heads/${rewriting.branch}`);
    expect(remote).not.toBe(accepted);
    f.setExpectedBody(publicSummary);
    expect((await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports)).error).toBeUndefined();
    f.h.setConversationActive(false);
    await tickPipelines([finishReported(f.h, "/codex/stage-1.jsonl", "pass", publicSummary)], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.state).toBe("completed");
    expect(done.lastPassedCommit).toBe(accepted);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${done.branch}`)).toBe(remote);
  } finally { f.close(); }
});


test("a summary reported during rewrite delivery survives the settlement fence", async () => {
  const f = await fixture();
  try {
    await f.commit();
    const lane = loadPipelines().find(p => p.id === f.id)!;
    lane.runs[0]!.attempts[0]!.paneId = null; savePipelines([lane]);
    let calls = 0;
    f.h.ports.resumeSeveredTurn = async () => {
      calls++;
      const result = await engineModule.reportStageCompletion({ verdict: "pass", summary: publicSummary },
        { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
      expect(result.error).toBeUndefined();
      return true;
    };
    f.setExpectedBody(publicSummary);
    await f.finish(unsafeSummary);
    await tickPipelines([], f.h.ports);
    const done = loadPipelines().find(p => p.id === f.id)!;
    expect(done.cursor?.stageId).toBe("review");
    expect(done.runs[0]!.attempts[0]!.report!.summary).toBe(publicSummary);
    expect(calls).toBe(1);
  } finally { f.close(); }
});


test("a detector match across title and body keeps its actual class", async () => {
  const { inspectPullRequestText } = await import("./stagePullRequest");
  const title = "password:", body = "a".repeat(20);
  expect(await inspectPullRequestText("title", title)).toEqual({ ok: true });
  expect(await inspectPullRequestText("body", body)).toEqual({ ok: true });
  const combined = await inspectPullRequestText("title/body", title + "\n" + body);
  expect(combined).toMatchObject({ ok: false, privacy: { part: "title/body", kind: "credential", check: "staticSensitiveClasses" } });
  expect(JSON.stringify(combined)).not.toContain(body);
});


test("a static refusal locates its decoded line without quoting the match", async () => {
  const { inspectPullRequestText } = await import("./stagePullRequest");
  const result = await inspectPullRequestText("body", "Public result.\nEvidence:\n/home/" + "private-user/evidence");
  expect(result).toMatchObject({ ok: false, privacy: { kind: "absolute-path", line: 3 } });
  if (!result.ok) expect(result.error).toContain("decoded line 3");
});
