import { expect, test } from "bun:test";
import { ensureStagePullRequest } from "./stagePullRequest";
import type { ExecPort } from "@/lib/workflows/provision";
import { pipelineArtifactsDir } from "./store";
import { fs, os, path, realExec, engineModule, tickPipelines, loadPipelines, savePipelines, finishReported } from "./engine.fixture";
import { REMOTE, isBodyPatch, fixture, publishedHeadFixture } from "./stagePullRequest.fixture";

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


test.each([undefined, "Keep GitHub publications in English"])("PR creation derives or overrides its title without changing the board (%s)", async override => {
  const f = await fixture("Виправити публікацію результатів");
  try {
    const pipeline = loadPipelines().find(p => p.id === f.id)!;
    pipeline.prTitle = override;
    savePipelines([pipeline]);
    await f.commit();
    const p = await f.finish();
    const create = f.calls.find(args => args[0] === "pr" && args[1] === "create")!;
    expect(create[create.indexOf("--title") + 1]).toBe(override ?? "Stage implementation summary.");
    expect(p.task).toBe("Виправити публікацію результатів");
    expect(f.body()).toBe("Stage implementation summary.");
  } finally { f.close(); }
});


test("a foreign summary is omitted and its advisory hint survives settlement and storage", async () => {
  const f = await fixture();
  try {
    f.setExpectedBody("Implementation report omitted because its prose needs an English publication summary.");
    await f.commit();
    const p = await f.finish("Виправлено публікацію результатів.");
    expect(p.cursor?.stageId).toBe("review");
    expect(f.body()).not.toContain("Виправлено");
    expect(p.runs[0]!.attempts[0]!.publicationLanguageHints?.hints).toEqual([{ part: "body", line: 1 }]);
    expect(loadPipelines().find(p => p.id === f.id)!.runs[0]!.attempts[0]!.publicationLanguageHints).toEqual(p.runs[0]!.attempts[0]!.publicationLanguageHints);
  } finally { f.close(); }
});


test("a foreign explicit title is flagged without refusing the lane", async () => {
  const f = await fixture();
  try {
    const p = loadPipelines().find(p => p.id === f.id)!;
    p.prTitle = "Змінити публікацію";
    savePipelines([p]);
    await f.commit();
    const settled = await f.finish();
    expect(settled.cursor?.stageId).toBe("review");
    expect(settled.runs[0]!.attempts[0]!.publicationLanguageHints?.hints).toContainEqual({ part: "title", line: 1 });
  } finally { f.close(); }
});


test("C: controller creates and links a delivery PR before advancing to review", async () => {
  const f = await fixture();
  try {
    await f.commit();
    const p = await f.finish();
    expect(p.delivery?.target.pr).toBe(17);
    expect(p.cursor?.stageId).toBe("review");
    const create = f.calls.find(a => a[1] === "create")!;
    expect(create).toContain("--body-file"); expect(create[create.indexOf("--head") + 1]).toBe(p.branch);
    expect(create[create.indexOf("--base") + 1]).toBe(p.baseBranch);
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


test("linked PR accepts the published stage with the lane base", async () => {
  const f = await fixture();
  try {
    f.link(); await f.commit();
    const p = await f.finish();
    expect(p.state).toBe("running");
    expect(p.cursor).toMatchObject({ stageId: "review", state: "pending" });
    expect(p.runs[0]!.attempts[0]!.state).toBe("passed");
    expect(p.publishedCommit).toBe(await f.git(f.worktree, "rev-parse", "HEAD"));
    expect(f.calls.filter(args => args[1] === "create")).toHaveLength(0);
    expect(f.calls.find(args => args[1] === "view")).toContain("17");
  } finally { f.close(); }
});


test.each([false, true])("lane targeting main refuses a predecessor PR base and recovers after correction (linked: %s)", async linked => {
  const f = await fixture();
  try {
    if (linked) f.link(); else f.setExisting();
    f.setPrBase("pipeline/predecessor");
    await f.commit();
    const refused = await f.finish();
    expect(refused.baseBranch).toBe("main");
    expect(refused.state).toBe("needs_decision");
    expect(refused.cursor).toMatchObject({ stageId: "build", state: "committing" });
    expect(refused.stateDetail).toContain("baseRefName (expected the lane's baseBranch; correct the PR base before retrying)");
    expect(f.calls.filter(args => args[1] === "create" || isBodyPatch(args))).toHaveLength(0);
    expect(refused.runs.find(run => run.stageId === "review")!.attempts).toHaveLength(0);
    f.setPrBase("main");
    const retry = await engineModule.patchPipeline(f.id, { action: "publish" }, f.h.ports);
    expect(retry.error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    const recovered = loadPipelines().find(lane => lane.id === f.id)!;
    expect(recovered.delivery!.target.pr).toBe(17);
    expect(recovered.cursor?.stageId).toBe("review");
    expect(f.calls.filter(args => args[1] === "create" || isBodyPatch(args))).toHaveLength(0);
  } finally { f.close(); }
});


test.each(["main", "release"])("publication creates a PR against its configured %s base", async base => {
  const f = await publishedHeadFixture(false);
  const artifacts = pipelineArtifactsDir(f.pipeline.id);
  try {
    f.pipeline.baseBranch = base;
    f.attempt.output = "Stage implementation summary.";
    fs.mkdirSync(artifacts, { recursive: true });
    const calls: string[][] = [];
    let exists = false;
    const exec: ExecPort = async (command, args) => {
      expect(command).toBe("gh");
      calls.push(args);
      if (args[1] === "create") {
        expect(args[args.indexOf("--base") + 1]).toBe(base);
        expect(args[args.indexOf("--head") + 1]).toBe(f.row.headRefName);
        exists = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      expect(args[1]).toBe("list");
      return { code: 0, stdout: JSON.stringify(exists ? [{ ...f.row, baseRefName: base }] : []), stderr: "" };
    };
    expect(await ensureStagePullRequest(f.pipeline, f.attempt, exec, undefined, f.timing)).toEqual({ ok: true });
    expect(f.pipeline.delivery!.target.pr).toBe(17);
    expect(calls.map(args => args[1])).toEqual(["list", "create", "list"]);
  } finally { fs.rmSync(artifacts, { recursive: true, force: true }); f.close(); }
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
    fs.writeFileSync(path.join(scripts, "privacy-publication-gate.ts"), "console.log(\"known_value: 1\"); process.exit(1);\n");
    fs.copyFileSync(path.join(process.cwd(), "scripts/privacy-known-value-fingerprints.json"), path.join(f.worktree, "scripts/privacy-known-value-fingerprints.json"));
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
