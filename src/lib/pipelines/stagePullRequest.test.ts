import { expect, test } from "bun:test";
import { fs, path, realExec, engineModule, tickPipelines, loadPipelines, savePipelines, finishReported, realWorktreeLane } from "./engine.fixture";

const REMOTE = "https://github.com/example/widgets.git";
async function fixture() {
  const f = await realWorktreeLane("stage-pr", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], "remote-branch");
  const p = loadPipelines().find(p => p.id === f.id)!;
  p.delivery!.target.remote = REMOTE; savePipelines([p]);
  const calls: string[][] = [];
  let exists = false, refuse = false, loseResponse = false;
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
        expect(fs.readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8")).toBe("Stage implementation summary.");
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
    const date = new Date(Date.parse(p.runs[0]!.attempts[0]!.startedAt!) + 1000).toISOString();
    const r = await realExec("git", ["commit", "--allow-empty", "-m", "stage output"], f.worktree,
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    expect(r.code, r.stderr).toBe(0);
  };
  return { ...f, calls, finish, commit, setPrShape: (shape: typeof prShape) => { exists = true; prShape = shape; }, setRace: (call: number, kind: "pause" | "release") => { race = { call, kind }; }, setMissing: () => { exists = false; }, setExisting: () => { exists = true; }, setRefused: () => { refuse = true; }, setLost: () => { loseResponse = true; },
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
