import { expect, test } from "bun:test";
import { fs, os, path, realExec, engineModule, tickPipelines, loadPipelines, savePipelines, finishReported, realWorktreeLane } from "./engine.fixture";

const REMOTE = "https://github.com/example/widgets.git";
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

async function fixture(task?: string) {
  const f = await realWorktreeLane("stage-pr", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], "remote-branch", false, false, { task: task ?? "stage-pr" });
  const p = loadPipelines().find(p => p.id === f.id)!;
  p.delivery!.target.remote = REMOTE; savePipelines([p]);
  const calls: string[][] = [];
  let exists = false, refuse = false, loseResponse = false;
  let expectedBody = "Stage implementation summary.";
  let prShape: "fork" | "head" | "ambiguous" | undefined;
  let race: { call: number; kind: "pause" | "release" } | undefined;
  f.h.ports.exec = async (command, args, cwd, env, options) => {
    if (command === "gh") {
      // Provenance observations are independent of the delivery guarantee.
      // Only count the controller's exact PR lookup/create awaits here.
      if (args[1] !== "create" && !args.some(arg => arg.includes("isCrossRepository")))
        return { code: 1, stdout: "", stderr: "fixture has no observed pull request" };
      calls.push(args);
      if (race?.call === calls.length) {
        const current = loadPipelines().find(p => p.id === f.id)!;
        if (race.kind === "pause") { current.state = "paused"; current.pausedState = "running"; }
        else current.delivery!.active = false;
        savePipelines([current]);
      }
      if (args[0] === "pr" && args[1] === "list") {
        const row = { number: 17, headRefName: p.branch, baseRefName: "main", state: "OPEN", isCrossRepository: prShape === "fork",
          headRefOid: prShape === "head" ? "f".repeat(40) : await f.git(f.origin, "rev-parse", `refs/heads/${p.branch}`) };
        return { code: 0, stdout: JSON.stringify(exists ? (prShape === "ambiguous" ? [row, { ...row, number: 18 }] : [row]) : []), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        if (refuse) return { code: 1, stdout: "", stderr: "forge refused" };
        expect(fs.readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8")).toBe(expectedBody);
        exists = true;
        return loseResponse ? { code: null, stdout: "", stderr: "response lost" } : { code: 0, stdout: "https://github.com/example/widgets/pull/17\n", stderr: "" };
      }
      throw new Error(`unexpected forge call: ${args.join(" ")}`);
    }
    return realExec(command, args.map(a => a === REMOTE ? f.origin : a), cwd, env, options);
  };
  const finish = async (summary = "Stage implementation summary.") => {
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass", summary }, { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-1.jsonl", "pass", summary)], f.h.ports);
    return loadPipelines().find(p => p.id === f.id)!;
  };
  const commit = async () => {
    await f.git(f.worktree, "commit", "--allow-empty", "-m", "stage output");
  };
  return { ...f, calls, finish, commit, setExpectedBody: (body: string) => { expectedBody = body; }, setPrShape: (shape: typeof prShape) => { exists = true; prShape = shape; }, setRace: (call: number, kind: "pause" | "release") => { race = { call, kind }; }, setMissing: () => { exists = false; }, setExisting: () => { exists = true; }, setRefused: () => { refuse = true; }, setLost: () => { loseResponse = true; },
    close: () => { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); } };
}

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
});


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
