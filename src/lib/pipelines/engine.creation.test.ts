import { expect, spyOn, test, crypto, spawn, spawnSync, fs, os, path, monitorEventLoopDelay, Database, laneMovedAt, activeDrain, DRAIN_LEASE_MS, initialAuto, writeAuto, initialCheck, SelfUpdateService, idleCheck, idleUpdate, stoppedProcess, endRestartGate, restartGateFile, realExec, engineModule, adoptAttempt, defaultPipelinePorts, ensureTaskPipelineForAssignment, pipelineAttemptTargetForSource, setPipelineDismissal, tickPipelines, AgentRegistry, setAgentRegistryForTests, rawCreatePipelineFromRequest, createPipelineFromRequest, loadPipelines, savePipelines, pipelineIdentity, saveTasks, asStoredLegacyReviewLane, patchPipeline, closeAndDrain, RUN_STAGES, ORIGIN_MAIN_SHA, entry, harness, finishReported, realWorktreeLane, create, boardTask, FETCHED_SHA, slowRemote, provisionRetryClock, DNS_FAILURE, realProvisioningRepo } from "./engine.fixture";
import type { ServiceDeps, Snapshot, LauncherRecord, PipelinePorts } from "./engine.fixture";


test.each(["drain", "early-switch-off", "host-fallback"] as const)("a stage completes and its successor waits for both update roles: %s", async (admission) => {
  const h = harness();
  const dir = fs.mkdtempSync("/var/tmp/drain-pipeline-");
  const target = "a".repeat(40);
  const old = "b".repeat(40);
  let now = Date.parse("2026-01-01T00:00:00Z");
  const rev = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
  const record: LauncherRecord = { version: 1, checkout: process.cwd(), launcher: { pid: 100, startIdentity: "test", autoAdmission: 1 },
    releasePointer: path.join(dir, "release.json"), requestFile: path.join(dir, "request.json"), releasesDir: path.join(dir, "releases"),
    port: 45123, socket: path.join(dir, "runtime-host.sock"), updatedAt: new Date(now).toISOString(),
    web: { state: "healthy", pid: 101, startIdentity: "web-test", startedAt: new Date(now).toISOString(), requestId: null, revision: old.slice(0, 7), error: null },
    runtimeHost: { state: "healthy", pid: 102, startIdentity: "host-test", startedAt: new Date(now).toISOString(), requestId: null, revision: old.slice(0, 7), error: null } };
  writeAuto(path.join(dir, "auto.json"), { ...initialAuto(), enabled: true, green: { [target]: { state: "green" } }, rollbackCaptured: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ slice: initialCheck(), update: null, autoRollbackCaptured: true }));
  const snapshot = (): Snapshot => ({ mode: "checkout", unsupportedReason: null, installed: rev(target), available: null, check: idleCheck(), update: idleUpdate(), busy: null,
    serving: { web: rev(record.web.revision === target.slice(0, 7) ? target : old), runtimeHost: rev(record.runtimeHost.revision === target.slice(0, 7) ? target : old) },
    processes: { web: { ...stoppedProcess(), state: "healthy", lastHealthOk: true, tail: [] }, runtimeHost: { ...stoppedProcess(), state: "healthy", lastHealthOk: true, tail: [] } },
    meta: { branch: "main", remote: "https://github.com/example/project", checkout: null, pollMinutes: 15, serverTime: new Date(now).toISOString() } });
  const deps = { dir, now: () => now, env: {}, remote: "https://github.com/example/project", branch: "main", mode: async () => ({ mode: "checkout", record }),
    green: { read: async () => ({ state: "green" }) }, quiet: { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: loadPipelines, presence: () => [] },
    prune: async () => {}, findDeploymentByIdempotencyKey: async () => null,
    web: { pid: 101, port: 0, startedAt: "" }, processAlive: () => true, hostHealth: async () => ({ pid: 102 }),
    describe: async (_repo: string, sha: string) => rev(sha), buildEnv: () => ({}),
    createRunner: () => ({ state: idleUpdate(), restore: () => {}, start: async () => {}, retry: async () => {}, logPath: () => "" }),
    targetOnBranch: async () => true,
  } as unknown as ServiceDeps;
  const makeService = () => {
    const instance = new SelfUpdateService(deps);
    instance.snapshot = async () => snapshot();
    return instance;
  };
  let service = makeService();
  h.ports.drainHold = () => activeDrain(path.join(dir, "auto-drain.json"), now);
  try {
    await create(h.ports, [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "reviewer" }, prompt: "Verify", next: null },
    ] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    await service.autoTick();
    if (admission === "drain") {
      await service.autoTick();
      expect(h.ports.drainHold()).not.toBeNull();
    }
    expect(fs.existsSync(record.requestFile)).toBe(false);
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "built safely")], h.ports);
    if (admission === "drain") for (let i = 0; i < 3; i++) await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
    expect(loadPipelines()[0]!.cursor).toMatchObject({ stageId: "verify", state: "pending" });
    expect(h.spawnInputs).toHaveLength(1);
    await service.autoTick();
    now += 60_000;
    await service.autoTick();
    expect(JSON.parse(fs.readFileSync(record.requestFile, "utf8")).role).toBe("web");
    await tickPipelines([], h.ports);
    const identity = loadPipelines()[0]!.runs[1]!.attempts[0]!.n;
    endRestartGate(restartGateFile(record.requestFile), JSON.parse(fs.readFileSync(record.requestFile, "utf8")).autoGateId);
    const pending = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).autoPending;
    record.web = { ...record.web, requestId: pending.requestId, revision: target.slice(0, 7) };
    fs.rmSync(record.requestFile);
    await service.autoTick();
    if (admission === "early-switch-off") {
      expect(await service.setAuto(false)).toEqual({ ok: true });
      service.stop();
      now += DRAIN_LEASE_MS + 1;
      service = makeService();
      service.startAuto();
      expect(h.ports.drainHold()).not.toBeNull();
      await Bun.sleep(0);
    }
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    if (admission === "host-fallback") {
      await service.autoTick();
      now += 60_000;
      await service.autoTick();
      const hostRequest = JSON.parse(fs.readFileSync(record.requestFile, "utf8"));
      expect(hostRequest.role).toBe("runtime-host");
      endRestartGate(restartGateFile(record.requestFile), hostRequest.autoGateId);
      fs.rmSync(record.requestFile);
      record.runtimeHost = { ...record.runtimeHost, requestId: hostRequest.requestId,
        error: { kind: "fell-back", revision: old.slice(0, 7), detail: "candidate host failed" } };
      await service.autoTick();
      await tickPipelines([], h.ports);
      expect(h.spawnInputs).toHaveLength(1);
      service.stop();
      now += DRAIN_LEASE_MS + 1;
      service = makeService();
      await service.autoTick();
      await tickPipelines([], h.ports);
      expect(h.spawnInputs).toHaveLength(1);
      record.web.revision = old.slice(0, 7);
    } else record.runtimeHost.revision = target.slice(0, 7);
    await service.autoTick();
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.n).toBe(identity);
  } finally { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test.each([
  { prompt: "Build from {{prev.output}}", access: "read-write", sandbox: "full" },
  { prompt: "Build from {{prev.output}}", access: "read-write", sandbox: "restricted" },
  { prompt: "Build from {{prev.output}}", access: "read-only", sandbox: "full" },
  { prompt: "Build from {{prev.output}}", access: "read-only", sandbox: "restricted" },
  { prompt: "Build the approved design", access: "read-write", sandbox: "full" },
  { prompt: "Build the approved design", access: "read-write", sandbox: "restricted" },
  { prompt: "Build the approved design", access: "read-only", sandbox: "full" },
  { prompt: "Build the approved design", access: "read-only", sandbox: "restricted" },
] as const)("a 45 KB output launches with an in-lane file for $access/$sandbox (%s)", async ({ prompt, access, sandbox }) => {
  const h = harness();
  const { assertStructuredTextEnvelope } = await import("@/lib/runtime/structuredContent");
  const spawnAgent = h.ports.spawnAgent;
  h.ports.spawnAgent = (input, reserved) => {
    assertStructuredTextEnvelope(input.prompt);
    return spawnAgent(input, reserved);
  };
  const pipeline = await create(h.ports, [RUN_STAGES[0], { ...RUN_STAGES[1], prompt, access, sandbox }] as never,
    { repoDir: path.join(process.env.LLV_STATE_DIR!, "repo") });
  fs.mkdirSync(pipeline.worktreeDir, { recursive: true });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const design = "Design head\n" + "d".repeat(45_000);
  expect(await engineModule.reportStageCompletion({ verdict: "pass" },
    { kind: "agent", role: "architect", conversationId: "conversation_stage_1" }, h.ports)).toMatchObject({ report: { verdict: { status: "pass" } } });
  await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", design)], h.ports);
  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]!.state, loadPipelines()[0]!.stateDetail ?? "no pipeline state detail").toBe("running");
  expect(loadPipelines()[0]!.cursor?.state).toBe("running");
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.runtimeProfile).toMatchObject({ access, sandbox });
  const delivered = h.spawnInputs[1]!.prompt;
  expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(32_000);
  expect(delivered).toContain("Design head");
  const artifact = delivered.match(/Full previous output file: (.+)\n/)?.[1];
  expect(artifact).toBeDefined();
  expect(path.isAbsolute(artifact!)).toBe(true);
  expect(fs.readFileSync(artifact!, "utf8")).toBe(design);
  expect(artifact!.startsWith(path.join(h.spawnInputs[1]!.cwd, ".artifacts", "pipeline-stage-inputs") + path.sep)).toBe(true);
  expect(artifact!.startsWith(path.join(process.env.LLV_STATE_DIR!, "pipeline-stage-inputs") + path.sep)).toBe(false);
});

test.each(["expanded prompt", "role scaffold"] as const)("an oversized %s launches and settles with a byte-complete private prompt in real Git", async (overflow) => {
  const fixture = await realWorktreeLane(`full-stage-${overflow.replaceAll(" ", "-")}`, [
    { id: "design", kind: "run", role: { roleId: "architect" }, prompt: "Design", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" },
      "prompt": overflow === "expanded prompt" ? "{{task}}".repeat(100) : "Build {{task}}", next: null },
  ], undefined, false, false, { task: "t".repeat(500), spec: "AC: preserve every instruction" });
  try {
    const { h, git, worktree, id } = fixture;
    h.setConversationActive(false);
    h.setPaneAlive(false);
    const { assertStructuredTextEnvelope } = await import("@/lib/runtime/structuredContent");
    const { renderStagePrompt } = await import("./prompts");
    const { resolveStageTestGuidance } = await import("./testGuidance");
    const spawnAgent = h.ports.spawnAgent;
    h.ports.spawnAgent = (input, reserved) => {
      assertStructuredTextEnvelope(input.prompt);
      return spawnAgent(input, reserved);
    };
    const lane = loadPipelines().find((item) => item.id === id)!;
    const build = lane.stages.find((stage) => stage.id === "build")!;
    if (overflow === "role scaffold") {
      build.effectiveRole.promptScaffold = "Scaffold head\n" + "界".repeat(11_000) + "\n{{prev.output}}\nScaffold tail";
    }
    savePipelines([lane]);
    const previous = "Design head\n" + "🙂".repeat(12_000) + "\nDesign tail";
    const expected = renderStagePrompt(lane, build, build.effectiveRole, previous, undefined, resolveStageTestGuidance());
    expect(Buffer.byteLength(expected)).toBeGreaterThan(32_000);
    expect(await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "architect", conversationId: "conversation_stage_1" }, h.ports))
      .toMatchObject({ report: { verdict: { status: "pass" } } });
    const finished = finishReported(h, "/codex/stage-1.jsonl", "pass", previous);
    await tickPipelines([finished], h.ports);
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) {
      await tickPipelines([], h.ports);
      await engineModule.drainStageActivations(h.ports);
    }
    const running = loadPipelines().find((item) => item.id === id)!;
    expect(running.state, running.stateDetail ?? "no detail").toBe("running");
    expect(h.spawnInputs).toHaveLength(2);
    const delivered = h.spawnInputs[1]!.prompt;
    expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(32_000);
    const file = delivered.match(/Full stage prompt file: (.+)\n/)?.[1];
    expect(file).toBeDefined();
    expect(file!.startsWith(path.join(worktree, ".artifacts", "pipeline-stage-inputs") + path.sep)).toBe(true);
    expect(fs.readFileSync(file!, "utf8")).toBe(expected);
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    expect(expected).toContain("Role prompt scaffold:");
    expect(expected).toContain("Report this stage's completion with the Delegatus MCP tool stage_report");
    expect(expected).toContain(previous);
    expect((await git(worktree, "status", "--porcelain"))).toBe("");
    fs.writeFileSync(path.join(worktree, "result.txt"), "worker result\n");
    (await git(worktree, "add", "-A"));
    expect((await git(worktree, "diff", "--cached", "--name-only"))).toBe("result.txt");
    expect(await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_2" }, h.ports))
      .toMatchObject({ report: { verdict: { status: "pass" } } });
    await tickPipelines([finishReported(h, "/codex/stage-2.jsonl", "pass", "Built")], h.ports);
    expect(loadPipelines().find((item) => item.id === id)?.state).toBe("completed");
    expect((await git(worktree, "ls-files", "--", ".artifacts/pipeline-stage-inputs"))).toBe("");
    expect((await git(worktree, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))).toBe("result.txt");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each(["reviewer", "builder"])("large fail-edge findings launch the %s stage through the same file handoff", async (roleId) => {
  const h = harness();
  const repoDir = path.join(process.env.LLV_STATE_DIR!, "large-fail-edge-repo");
  const { assertStructuredTextEnvelope } = await import("@/lib/runtime/structuredContent");
  const spawnAgent = h.ports.spawnAgent;
  h.ports.spawnAgent = (input, reserved) => {
    assertStructuredTextEnvelope(input.prompt);
    return spawnAgent(input, reserved);
  };
  const pipeline = await create(h.ports, [
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null, onFail: { to: "fix", maxRounds: 1 } },
    { id: "fix", kind: "run", role: { roleId }, prompt: "Resolve {{prev.output}}", next: null },
  ] as never, { repoDir });
  fs.mkdirSync(pipeline.worktreeDir, { recursive: true });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const findings = Array.from({ length: 25 }, (_, n) => ({ severity: "P1" as const, text: `src/module.ts:${n + 1} ` + "f".repeat(1_800) }));
  expect(await engineModule.reportStageCompletion({ verdict: "fail", findings, summary: "Resolve every finding" },
    { kind: "agent", role: "reviewer", conversationId: "conversation_stage_1" }, h.ports)).toMatchObject({ report: { verdict: { status: "fail" } } });
  await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "fail", "Review result")], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(h.spawnInputs).toHaveLength(2);
  const prompt = h.spawnInputs[1]!.prompt;
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(32_000);
  const file = prompt.match(/Full previous output file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  const full = fs.readFileSync(file!, "utf8");
  expect(full).toContain("Resolve every finding");
  for (const finding of findings) expect(full).toContain(`P1 — ${finding.text}`);
});

test.each([
  { access: "read-write", sandbox: "full" },
  { access: "read-write", sandbox: "restricted" },
  { access: "read-only", sandbox: "full" },
  { access: "read-only", sandbox: "restricted" },
] as const)("pipeline stage runtime profile preserves access=$access with sandbox=$sandbox", async ({ access, sandbox }) => {
  const h = harness();
  await create(h.ports, [
    { id: "audit", kind: "run", engine: "codex", access, sandbox, prompt: "Audit", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  expect(h.spawnInputs[0]).toMatchObject({
    role: { access },
    runtimeProfile: { access, sandbox },
  });
  expect(h.spawnInputs[0]?.prompt).toContain(`Host access: ${sandbox}`);
});

test("read-only stages preserve declared outputs and tell the agent their write boundary", async () => {
  const h = harness();
  const pipeline = await create(h.ports, [
    {
      id: "audit",
      kind: "run",
      role: { roleId: "architect" },
      access: "read-only",
      outputs: ["reports/audit.md"],
      "prompt": "Audit",
      next: null,
    },
  ] as never);

  expect(pipeline.stages[0]?.outputs).toEqual(["reports/audit.md"]);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs[0]?.prompt).toContain("reports/audit.md");
  expect(h.spawnInputs[0]?.prompt).toContain("Do not commit");
});

test("declared outputs reject traversal, Git metadata, and duplicate normalized paths", async () => {
  const h = harness();
  savePipelines([]);
  const result = await createPipelineFromRequest({
    task: "Audit",
    repoDir: "/repo",
    src: "/codex/creator.jsonl",
    stages: [{
      id: "audit",
      kind: "run",
      access: "read-only",
      outputs: ["../outside.md", ".git/config", "reports/*.md", "reports/audit.md", "reports/audit.md/"],
      "prompt": "Audit",
      next: null,
    }],
  }, h.ports);

  expect(result.status).toBe(400);
  expect(result.violations?.map((violation) => violation.field)).toEqual([
    "stages[0].outputs[0]",
    "stages[0].outputs[1]",
    "stages[0].outputs[2]",
    "stages[0].outputs[4]",
  ]);

  const reviewOutput = await createPipelineFromRequest({
    task: "Review",
    repoDir: "/repo",
    src: "/codex/creator.jsonl",
    stages: [
      { id: "build", kind: "run", "prompt": "Build", next: "review" },
      { id: "review", kind: "review-loop", outputs: ["reports/review.md"], "prompt": "Review", next: null },
    ],
  }, h.ports);
  expect(reviewOutput.violations).toContainEqual(expect.objectContaining({
    field: "stages[1].outputs",
    message: "review-loop stage review cannot declare worktree outputs",
  }));

  const readWriteOutput = await createPipelineFromRequest({
    task: "Build",
    repoDir: "/repo",
    src: "/codex/creator.jsonl",
    stages: [{
      id: "build",
      kind: "run",
      access: "read-write",
      outputs: ["reports/build.md"],
      "prompt": "Build",
      next: null,
    }],
  }, h.ports);
  expect(readWriteOutput.violations).toContainEqual(expect.objectContaining({
    field: "stages[0].outputs",
    message: "stage build outputs require read-only access",
  }));
});

test("review-loop sandbox restriction reaches its reviewer flow", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "review-loop", access: "read-only", sandbox: "restricted", prompt: "Review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([], h.ports);

  expect(h.flowRequests[0]).toMatchObject({ reviewerSandbox: "restricted" });
});

test("pause and resume state details name the operator or calling agent (#1121)", async () => {
  const h = harness();
  const pipeline = await create(h.ports);

  const operatorPause = await patchPipeline(pipeline.id, { action: "pause" }, h.ports);
  expect(operatorPause.pipeline).toMatchObject({ state: "paused", stateDetail: "paused by operator" });
  const operatorResume = await patchPipeline(pipeline.id, { action: "resume" }, h.ports);
  expect(operatorResume.pipeline).toMatchObject({ state: "provisioning", stateDetail: "resumed by operator" });

  const agent = { kind: "agent" as const, role: "orchestrator", conversationId: "conversation_orchestrator" };
  const agentPause = await patchPipeline(pipeline.id, { action: "pause" }, h.ports, agent);
  expect(agentPause.pipeline).toMatchObject({
    state: "paused",
    stateDetail: "paused by orchestrator conversation_orchestrator",
  });
  const agentResume = await patchPipeline(pipeline.id, { action: "resume" }, h.ports, agent);
  expect(agentResume.pipeline).toMatchObject({
    state: "provisioning",
    stateDetail: "resumed by orchestrator conversation_orchestrator",
  });
});

test("new pipelines require an allowed creator transcript with an existing conversation", async () => {
  const h = harness();
  savePipelines([]);

  const missing = await rawCreatePipelineFromRequest({
    task: "Missing creator",
    repoDir: "/repo",
    autoStart: false,
    stages: [],
  }, h.ports);
  expect(missing).toMatchObject({
    error: "pipeline creator lineage is required; pass src",
    status: 400,
    violations: [{ field: "src", message: "pipeline creator lineage is required; pass src" }],
  });

  const invalidPath = await createPipelineFromRequest({
    task: "Invalid creator",
    repoDir: "/repo",
    src: "/outside/creator.jsonl",
    autoStart: false,
    stages: [],
  }, h.ports);
  /* #1026: the rejection names the roots that ARE accepted, so a caller holding
     a native Claude path is not left guessing which address the viewer records. */
  expect(invalidPath.status).toBe(400);
  expect(invalidPath.error).toStartWith("src path is not an allowed conversation transcript.");
  expect(invalidPath.error).toContain("shared/claude/projects");
  expect(invalidPath.error).toContain("~/.codex/sessions");
  expect(invalidPath.violations).toEqual([expect.objectContaining({ field: "src" })]);

  const unknownConversation = await createPipelineFromRequest({
    task: "Unknown creator",
    repoDir: "/repo",
    src: "/codex/unknown.jsonl",
    autoStart: false,
    stages: [],
  }, h.ports);
  expect(unknownConversation.status).toBe(400);
  expect(unknownConversation.error).toStartWith("src conversation does not exist.");
  expect(unknownConversation.error).toContain("~/.claude/projects");

  const created = await createPipelineFromRequest({
    task: "Known creator",
    repoDir: "/repo",
    src: "/codex/creator.jsonl",
    autoStart: false,
    stages: [],
  }, h.ports);
  expect(created.pipeline).toMatchObject({
    srcPath: "/codex/creator.jsonl",
    srcConversationId: "conversation_creator",
  });
});

/* #1026 — a Claude-engine caller knows its own native ~/.claude/projects path;
   every viewer record addresses the shared transcript store the home's projects
   dir links into. The two name one file, so the native address resolves — but
   only when that file really is mirrored, since inventing a shared path would
   mint a phantom conversation identity. */
test("a native Claude src path resolves through its shared-store mirror, and says so when there is none", async () => {
  const h = harness();
  savePipelines([]);
  const claudeHome = path.join(process.env.LLV_STATE_DIR!, "native-claude-home");
  const encoded = "-home-agent-repo";
  const mirrored = path.join(path.dirname(process.env.LLV_STATE_DIR!), "shared", "claude", "projects", encoded, "creator.jsonl");
  fs.mkdirSync(path.dirname(mirrored), { recursive: true });
  fs.writeFileSync(mirrored, "{}\n");
  const native = path.join(claudeHome, "projects", encoded, "creator.jsonl");
  const unmirrored = path.join(claudeHome, "projects", encoded, "stranger.jsonl");
  const ports: PipelinePorts = {
    ...h.ports,
    sourcePathAllowed: (pathname) => pathname === mirrored,
    conversationIdForPath: (pathname) => (pathname === mirrored ? "conversation_creator" : null),
  };
  const previousHome = process.env.LLV_CLAUDE_HOME;
  process.env.LLV_CLAUDE_HOME = claudeHome;
  try {
    const normalizedSrc = await rawCreatePipelineFromRequest({
      task: "Native creator path",
      repoDir: "/repo",
      autoStart: false,
      stages: [],
      src: native,
    }, ports);
    expect(normalizedSrc.pipeline).toMatchObject({ srcPath: mirrored, srcConversationId: "conversation_creator" });

    const nothingMirrored = await rawCreatePipelineFromRequest({
      task: "Native creator path without a mirror",
      repoDir: "/repo",
      autoStart: false,
      stages: [],
      src: unmirrored,
    }, ports);
    expect(nothingMirrored.pipeline).toBeUndefined();
    expect(nothingMirrored.status).toBe(400);
    expect(nothingMirrored.error).toContain("shared/claude/projects");
    expect(nothingMirrored.error).toContain("~/.codex/sessions");
  } finally {
    if (previousHome === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = previousHome;
  }
});

/* #1026 — the reported walk cost seven calls because each answer carried one
   constraint. Every constraint the request violates is now collected in one
   response, each naming its field and the shape that field expects. */
test("an invalid create answers with every violated constraint at once", async () => {
  const h = harness();
  savePipelines([]);
  const rejected = await createPipelineFromRequest({
    task: "Batched validation",
    repoDir: "/repo",
    autoStart: false,
    baseBranch: "main",
    stages: [
      { id: "not a url safe id", kind: "implement", prompt: "build", role: "builder" },
      { id: "review", kind: "review-loop", prompt: "", role: { roleId: "reviewer", engine: "codex" } },
    ],
  } as never, h.ports);

  expect(rejected.pipeline).toBeUndefined();
  expect(rejected.status).toBe(400);
  expect(rejected.violations?.map((violation) => violation.field)).toEqual([
    "stages[0].id",
    "stages[0].kind",
    "stages[0].role",
    "stages[1].prompt",
    "stages[1].role",
    "baseRef",
  ]);
  for (const violation of rejected.violations ?? []) expect(violation.expected).not.toBe("");
  /* One response, and it reads as one: the count, then field, message and
     expected shape for each violated constraint. */
  expect(rejected.error).toStartWith("6 validation errors — ");
  expect(rejected.error).toContain('stages[0].kind: stage kind must be run or review-loop (expected "run" | "review-loop")');
  expect(rejected.error).toContain("place runtime overrides on the stage");
  expect(rejected.error).toContain("baseRef: a draft baseBranch requires an explicit baseRef");
  expect(loadPipelines()).toEqual([]);
});

/* #1026 ask 3 — "review-loop stage requires a preceding run stage" read as an
   ordering rule and sent the caller reordering an array that was already in the
   right order. The defect is the missing pass edge. */
test("an unreachable review-loop names the stage and the next edge that would reach it", async () => {
  const h = harness();
  savePipelines([]);
  const rejected = await createPipelineFromRequest({
    task: "Unwired review loop",
    repoDir: "/repo",
    autoStart: false,
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: null },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
    ],
  }, h.ports);

  expect(rejected.pipeline).toBeUndefined();
  expect(rejected.error).toBe('review-loop stage review is unreachable: no run stage\'s next chain reaches it — set next: "review" on run stage build');
  expect(rejected.violations).toEqual([expect.objectContaining({ field: "stages[].next" })]);
  expect(rejected.error).not.toContain("requires a preceding run stage");
});

test("set-src repairs closed history and requires overwrite for existing lineage", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  pipeline.srcPath = null;
  pipeline.srcConversationId = null;
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = h.ports.now();
  savePipelines([pipeline]);

  const invalid = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/outside/creator.jsonl",
  } as never, h.ports);
  expect(invalid.status).toBe(400);
  expect(invalid.error).toStartWith("src path is not an allowed conversation transcript.");

  const repaired = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/codex/creator.jsonl",
  } as never, h.ports);
  expect(repaired.pipeline).toMatchObject({
    state: "closed",
    srcPath: "/codex/creator.jsonl",
    srcConversationId: "conversation_creator",
  });
  const repeated = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/codex/creator.jsonl",
  }, h.ports);
  expect(repeated.pipeline).toMatchObject({
    srcPath: "/codex/creator.jsonl",
    srcConversationId: "conversation_creator",
  });

  const blocked = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/codex/stage-1.jsonl",
  } as never, h.ports);
  expect(blocked).toEqual({ error: "pipeline creator lineage already exists; pass overwrite: true to replace it", status: 409 });

  const overwritten = await patchPipeline(pipeline.id, {
    action: "set-src",
    srcPath: "/codex/stage-1.jsonl",
    overwrite: true,
  } as never, h.ports);
  expect(overwritten.pipeline).toMatchObject({
    state: "closed",
    srcPath: "/codex/stage-1.jsonl",
    srcConversationId: "conversation_stage_1",
  });
});

test("link-task is idempotent for an existing task in the pipeline project", async () => {
  const h = harness();
  const task = boardTask("task-link-1");
  saveTasks([task]);
  const pipeline = await create(h.ports);

  const first = await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id }, h.ports);
  const duplicate = await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id }, h.ports);

  expect(first.pipeline?.taskIds).toEqual([task.id]);
  expect(duplicate.pipeline?.taskIds).toEqual([task.id]);
  expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);
});

test("task links reject project mismatches without persisting a change", async () => {
  const h = harness();
  const foreignTask = boardTask("task-foreign", "other-project");
  saveTasks([foreignTask]);
  const pipeline = await create(h.ports);

  const result = await patchPipeline(pipeline.id, { action: "link-task", taskId: foreignTask.id }, h.ports);

  expect(result).toEqual({ error: `task project does not match pipeline project: ${foreignTask.id}`, status: 400 });
  expect(loadPipelines()[0]!.taskIds).toEqual([]);
});

/* docs/design/linked-installs.md M.4 seam 1: pipeline state that starts work
   refuses a task another linked machine runs; on that machine the same calls
   pass. */
test("a task another linked machine runs refuses pipeline creation, link-task, a draft's start and a retry", async () => {
  const self = ["0a0a0a0a", "1111", "4111", "8111", "111111111111"].join("-");
  const peer = ["0b0b0b0b", "2222", "4222", "8222", "222222222222"].join("-");
  const selfFile = path.join(process.env.LLV_STATE_DIR!, "links/self.json");
  const writeSelf = (installId: string) => {
    fs.mkdirSync(path.dirname(selfFile), { recursive: true });
    fs.writeFileSync(selfFile, JSON.stringify({ v: 1, installId, label: "fixture", publicUrl: null, check: null }));
  };
  writeSelf(self);
  try {
    const h = harness();
    const elsewhere = { ...boardTask("task-runs-on-peer"), machine: peer };
    const here = { ...boardTask("task-runs-here"), machine: self };
    saveTasks([elsewhere, here]);
    savePipelines([]);
    const draftRequest = { repoDir: "/repo", autoStart: false, stages: [{ id: "run", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "run", next: null }] } as const;
    const refused = await createPipelineFromRequest({ ...draftRequest, task: "Refused", taskIds: [elsewhere.id] } as never, h.ports);
    expect(refused).toMatchObject({ status: 409, code: "TASK_RUNS_ELSEWHERE" });
    expect(loadPipelines()).toHaveLength(0);
    const draft = await createPipelineFromRequest({ ...draftRequest, task: "Draft", taskIds: [here.id] } as never, h.ports);
    expect(draft.pipeline?.state).toBe("draft");
    expect(await patchPipeline(draft.pipeline!.id, { action: "link-task", taskId: elsewhere.id }, h.ports)).toMatchObject({ status: 409, code: "TASK_RUNS_ELSEWHERE" });
    saveTasks([elsewhere, { ...here, machine: peer }]);
    expect(await patchPipeline(draft.pipeline!.id, { action: "start" }, h.ports)).toMatchObject({ status: 409, code: "TASK_RUNS_ELSEWHERE" });
    expect(loadPipelines().find((pipeline) => pipeline.id === draft.pipeline!.id)?.state).toBe("draft");

    saveTasks([elsewhere, here]);
    const created = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "retry me")], h.ports);
    const failed = loadPipelines().find((pipeline) => pipeline.id === created.id)!;
    expect(failed.state).toBe("needs_decision");
    savePipelines([{ ...failed, taskIds: [elsewhere.id] }]);
    expect(await patchPipeline(created.id, { action: "retry-stage" }, h.ports)).toMatchObject({ status: 409, code: "TASK_RUNS_ELSEWHERE" });
    // On the machine the task names, the same retry is admitted.
    writeSelf(peer);
    expect((await patchPipeline(created.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  } finally {
    fs.rmSync(selfFile, { force: true });
  }
});

test("a linked draft cannot move to a different task project", async () => {
  const h = harness();
  const task = boardTask("task-repo-move");
  saveTasks([task]);
  savePipelines([]);
  h.ports.projectForCwd = (cwd) => cwd === "/other" ? "other-project" : "viewer";
  const created = await createPipelineFromRequest({
    task: "Linked draft",
    taskIds: [task.id],
    repoDir: "/repo",
    autoStart: false,
    stages: [{ id: "run", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "run", next: null }],
  }, h.ports);

  const moved = await patchPipeline(created.pipeline!.id, { action: "update-draft", repoDir: "/other" }, h.ports);

  expect(moved).toEqual({ error: `task project does not match pipeline project: ${task.id}`, status: 400 });
  expect(loadPipelines()[0]).toMatchObject({ repoDir: "/repo", project: "viewer", taskIds: [task.id] });
});

test("a deleted task stays linked until unlink-task removes its stale id", async () => {
  const h = harness();
  const task = boardTask("task-stale");
  saveTasks([task]);
  const pipeline = await create(h.ports);
  await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id }, h.ports);
  saveTasks([]);

  expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);
  const result = await patchPipeline(pipeline.id, { action: "unlink-task", taskId: task.id }, h.ports);

  expect(result.pipeline?.taskIds).toEqual([]);
  expect(loadPipelines()[0]!.taskIds).toEqual([]);
});

/* #2187 §5.1: a pipeline marked as the one that finishes a linked task. */
test("finishesTask at creation marks linked tasks, and an id the pipeline does not link is dropped and named", async () => {
  const h = harness();
  const [first, second] = [boardTask("task-finish-1"), boardTask("task-finish-2")];
  saveTasks([first, second]);
  savePipelines([]);
  const stages = [{ id: "run", kind: "run" as const, role: { roleId: "builder" as const }, engine: "codex" as const, prompt: "run", next: null }];

  const every = await createPipelineFromRequest({ task: "All", taskIds: [first.id, second.id], finishesTask: true, repoDir: "/repo", autoStart: false, stages }, h.ports);
  expect(every.pipeline?.finishesTaskIds).toEqual([first.id, second.id]);
  expect(every.finishesTaskDropped).toBeUndefined();

  const some = await createPipelineFromRequest({ task: "Some", taskIds: [first.id], finishesTask: [first.id, "task-elsewhere"], repoDir: "/repo", autoStart: false, stages }, h.ports);
  expect(some.pipeline?.finishesTaskIds).toEqual([first.id]);
  expect(some.finishesTaskDropped).toEqual(["task-elsewhere"]);

  const none = await createPipelineFromRequest({ task: "None", taskIds: [first.id], repoDir: "/repo", autoStart: false, stages }, h.ports);
  expect(none.pipeline?.finishesTaskIds).toBeUndefined();
  expect(loadPipelines().map((pipeline) => pipeline.finishesTaskIds)).toEqual([[first.id, second.id], [first.id], undefined]);

  const malformed = await createPipelineFromRequest({ task: "Bad", taskIds: [first.id], finishesTask: "yes" as never, repoDir: "/repo", autoStart: false, stages }, h.ports);
  expect(malformed.status).toBe(400);
  expect(malformed.violations?.map((violation) => violation.field)).toContain("finishesTask");
});

test("link-task with finishes is an upsert of the flag, and unlink-task clears it", async () => {
  const h = harness();
  const task = boardTask("task-finish-link");
  saveTasks([task]);
  const pipeline = await create(h.ports);

  const marked = await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id, finishes: true }, h.ports);
  expect(marked.pipeline).toMatchObject({ taskIds: [task.id], finishesTaskIds: [task.id] });
  /* On a task already linked, the flag alone moves; absent leaves it. */
  const kept = await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id }, h.ports);
  expect(kept.pipeline?.finishesTaskIds).toEqual([task.id]);
  const cleared = await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id, finishes: false }, h.ports);
  expect(cleared.pipeline?.taskIds).toEqual([task.id]);
  expect(cleared.pipeline?.finishesTaskIds).toBeUndefined();

  await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id, finishes: true }, h.ports);
  const refused = await patchPipeline(pipeline.id, { action: "link-task", taskId: task.id, finishes: "yes" as never }, h.ports);
  expect(refused).toEqual({ error: "finishes must be a boolean", status: 400 });
  const unlinked = await patchPipeline(pipeline.id, { action: "unlink-task", taskId: task.id }, h.ports);
  expect(unlinked.pipeline?.taskIds).toEqual([]);
  expect(unlinked.pipeline?.finishesTaskIds).toBeUndefined();
  expect(loadPipelines()[0]!.finishesTaskIds).toBeUndefined();
});

test("pipeline creation validates and persists explicit taskIds atomically", async () => {
  const h = harness();
  const task = boardTask("task-create");
  saveTasks([task]);
  savePipelines([]);

  const created = await createPipelineFromRequest({
    task: "Bound pipeline",
    taskIds: [task.id, task.id],
    repoDir: "/repo",
    stages: RUN_STAGES as never,
  }, h.ports);

  expect(created.pipeline?.taskIds).toEqual([task.id]);
  expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);

  savePipelines([]);
  const missing = await createPipelineFromRequest({
    task: "Missing task",
    taskIds: ["task-missing"],
    repoDir: "/repo",
    stages: RUN_STAGES as never,
  }, h.ports);
  expect(missing).toEqual({ error: "task not found: task-missing", status: 400 });
  expect(loadPipelines()).toEqual([]);
});

test("auto-create rechecks task links inside the pipeline mutation", async () => {
  const h = harness();
  const task = boardTask("task-race");
  saveTasks([task]);
  savePipelines([]);

  const [explicit, automatic] = await Promise.all([
    createPipelineFromRequest({
      task: "Explicit owner",
      taskIds: [task.id],
      repoDir: "/repo",
      autoStart: false,
      stages: [{ id: "run", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "run", next: null }],
    }, h.ports),
    ensureTaskPipelineForAssignment(task, {
      repoDir: "/repo",
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      launchId: "launch-task-race",
      conversationId: "conversation_creator",
      srcPath: "/codex/creator.jsonl",
    }, h.ports),
  ]);

  expect(explicit.pipeline).toBeDefined();
  expect(automatic.pipeline?.id).toBe(explicit.pipeline?.id);
  expect(loadPipelines()).toHaveLength(1);
  expect(loadPipelines()[0]!.taskIds).toEqual([task.id]);
});

test("task spawn reserves one launch-correlated pipeline and reconciles its creator path", async () => {
  const h = harness();
  const task = boardTask("task-intent");
  saveTasks([task]);
  savePipelines([]);
  const pending = {
    repoDir: "/repo",
    engine: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-intent",
    conversationId: "conversation_stage_1",
    srcPath: null,
  };

  const reserved = await ensureTaskPipelineForAssignment(task, pending, h.ports);
  expect(reserved.pipeline).toMatchObject({
    taskIds: [task.id],
    creationIntent: { kind: "task-spawn", taskId: task.id, launchId: pending.launchId },
    srcPath: null,
    srcConversationId: pending.conversationId,
  });

  const materialized = await ensureTaskPipelineForAssignment(task, {
    ...pending,
    srcPath: "/codex/stage-1.jsonl",
  }, h.ports);
  const replayed = await ensureTaskPipelineForAssignment(task, {
    ...pending,
    srcPath: "/codex/stage-1.jsonl",
  }, h.ports);
  expect(materialized.pipeline?.id).toBe(reserved.pipeline?.id);
  expect(replayed.pipeline?.id).toBe(reserved.pipeline?.id);
  expect(loadPipelines()).toEqual([expect.objectContaining({
    id: reserved.pipeline?.id,
    srcPath: "/codex/stage-1.jsonl",
  })]);
});

test("pipeline tick recovers a reserved task creator path from its conversation", async () => {
  const h = harness();
  const task = boardTask("task-intent-recovery");
  saveTasks([task]);
  savePipelines([]);

  const reserved = await ensureTaskPipelineForAssignment(task, {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-recovery",
    conversationId: "conversation_stage_2",
    srcPath: null,
  }, h.ports);
  expect(reserved.pipeline?.srcPath).toBeNull();

  await tickPipelines([], h.ports);
  expect(loadPipelines()).toEqual([expect.objectContaining({
    id: reserved.pipeline?.id,
    srcPath: "/codex/stage-2.jsonl",
    srcConversationId: "conversation_stage_2",
  })]);
});

test("unlinking a task keeps its launch-correlated creation evidence", async () => {
  const h = harness();
  const task = boardTask("task-intent-unlink");
  saveTasks([task]);
  savePipelines([]);
  const reserved = await ensureTaskPipelineForAssignment(task, {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-unlink",
    conversationId: "conversation_stage_1",
    srcPath: null,
  }, h.ports);

  const unlinked = await patchPipeline(reserved.pipeline!.id, { action: "unlink-task", taskId: task.id }, h.ports);
  expect(unlinked.pipeline).toMatchObject({
    taskIds: [],
    creationIntent: { kind: "task-spawn", taskId: task.id, launchId: "launch-task-unlink" },
  });
  expect(loadPipelines()).toHaveLength(1);
});

test("a fresh task launch replaces one failed pending creation intent", async () => {
  const h = harness();
  const task = boardTask("task-intent-retry");
  saveTasks([task]);
  savePipelines([]);
  const first = await ensureTaskPipelineForAssignment(task, {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-failed",
    conversationId: "conversation_stage_1",
    srcPath: null,
  }, h.ports);
  h.ports.spawnReceipt = (launchId) => launchId === "launch-task-failed" ? {
    state: "failed",
    launchId,
    conversationId: "conversation_stage_1",
    sessionId: null,
    "transcript": null,
    paneId: null,
  } : null;

  const recovered = await ensureTaskPipelineForAssignment(task, {
    repoDir: "/repo",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    launchId: "launch-task-retry",
    conversationId: "conversation_stage_2",
    srcPath: "/codex/stage-2.jsonl",
  }, h.ports);

  expect(recovered.pipeline?.id).toBe(first.pipeline?.id);
  expect(loadPipelines()).toEqual([expect.objectContaining({
    creationIntent: { kind: "task-spawn", taskId: task.id, launchId: "launch-task-retry" },
    srcConversationId: "conversation_stage_2",
    srcPath: "/codex/stage-2.jsonl",
  })]);
});

test("adoptAttempt appends to the source stage after the cursor moved on", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  const sourceRun = pipeline.runs.find((run) => run.stageId === "plan")!;
  sourceRun.attempts.push({
    n: 1,
    state: "passed",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-source",
    conversationId: "conversation_source",
    sessionId: "session-source",
    agentPath: "/codex/source.jsonl",
    paneId: "%1",
    flowId: null,
    startedAt: "t0",
    completedAt: "t1",
    input: "original input",
    activatedBy: null,
    output: "source output",
    verdict: { status: "pass" },
    error: null,
  });
  pipeline.cursor = { stageId: "build", state: "running", input: "source output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } };
  const cursorBefore = structuredClone(pipeline.cursor);

  const adopted = adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_source",
    launchId: "launch-child",
    conversationId: "conversation_child",
    sessionId: "session-child",
    agentPath: "/codex/child.jsonl",
    paneId: "%2",
    startedAt: "t2",
  });

  expect(adopted).toMatchObject({ n: 2, state: "running", conversationId: "conversation_child", input: "original input" });
  expect(sourceRun.attempts).toHaveLength(2);
  expect(pipeline.cursor).toEqual(cursorBefore);
  expect(adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_source",
    launchId: "launch-child",
    conversationId: "conversation_child",
    sessionId: "session-child",
    agentPath: "/codex/child.jsonl",
    paneId: "%2",
    startedAt: "t2",
  })).toBe(adopted);
  expect(sourceRun.attempts).toHaveLength(2);
});

test("durable pipeline membership recovers one pending adoption", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  const sourceRun = pipeline.runs.find((run) => run.stageId === "plan")!;
  sourceRun.attempts.push({
    n: 1,
    state: "passed",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-source",
    conversationId: "conversation_source",
    sessionId: "session-source",
    agentPath: "/codex/source.jsonl",
    paneId: "%1",
    flowId: null,
    startedAt: "1970-01-01T00:10:00.000Z",
    completedAt: "1970-01-01T00:11:00.000Z",
    input: "original input",
    activatedBy: null,
    output: "source output",
    verdict: { status: "pass" },
    error: null,
  });
  pipeline.cursor = { stageId: "build", state: "running", input: "source output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } };
  pipeline.state = "paused";
  pipeline.pausedState = "running";
  savePipelines([pipeline]);
  expect(pipelineAttemptTargetForSource("conversation_source")).toEqual({
    pipelineId: pipeline.id,
    stageId: "plan",
    stageOrder: 0,
    role: "architect",
  });
  h.ports.pipelineAdoptionCandidates = () => [{
    stageId: "plan",
    sourceConversationId: "conversation_source",
    launchId: "launch-child",
    conversationId: "conversation_child",
    sessionId: "session-child",
    agentPath: "/codex/child.jsonl",
    paneId: null,
    startedAt: "1970-01-01T00:12:00.000Z",
  }];
  h.durableTurns.set("/codex/child.jsonl", { turn: "busy", message: null });

  await tickPipelines([entry("/codex/child.jsonl")], h.ports);
  await tickPipelines([entry("/codex/child.jsonl")], h.ports);

  const attempts = loadPipelines()[0]!.runs.find((run) => run.stageId === "plan")!.attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toMatchObject({ historical: true, conversationId: "conversation_child", state: "running" });
});

test("a terminal historical adoption settles without changing the cursor", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  const sourceRun = pipeline.runs.find((run) => run.stageId === "plan")!;
  sourceRun.attempts.push({
    n: 1,
    state: "passed",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-source",
    conversationId: "conversation_source",
    sessionId: "session-source",
    agentPath: "/codex/source.jsonl",
    paneId: "%1",
    flowId: null,
    startedAt: "1970-01-01T00:10:00.000Z",
    completedAt: "1970-01-01T00:11:00.000Z",
    input: "original input",
    activatedBy: null,
    output: "source output",
    verdict: { status: "pass" },
    error: null,
  });
  pipeline.cursor = { stageId: "build", state: "running", input: "source output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } };
  pipeline.state = "paused";
  pipeline.pausedState = "running";
  const cursorBefore = structuredClone(pipeline.cursor);
  const adopted = adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_source",
    launchId: "launch-child",
    conversationId: "conversation_child",
    sessionId: "session-child",
    agentPath: "/codex/child.jsonl",
    paneId: null,
    startedAt: "1970-01-01T00:12:00.000Z",
  })!;
  savePipelines([pipeline]);
  h.durableTurns.set("/codex/child.jsonl", {
    turn: "terminal",
    message: {
      text: "historical result\n\n```json\n{\"status\":\"pass\",\"findings\":[],\"confidence\":0.9}\n```",
      ts: 2_000_000,
    },
  });

  await tickPipelines([entry("/codex/child.jsonl")], h.ports);
  const settled = loadPipelines()[0]!;
  const historical = settled.runs.find((run) => run.stageId === "plan")!.attempts[1]!;
  expect(historical).toMatchObject({
    historical: true,
    state: "passed",
    completedAt: new Date(2_000_000).toISOString(),
    verdict: { status: "pass" },
    output: null,
  });
  expect(settled.cursor).toEqual(cursorBefore);
  expect(settled.state).toBe("paused");

  const afterFirst = JSON.stringify(settled);
  await tickPipelines([entry("/codex/child.jsonl")], h.ports);
  expect(JSON.stringify(loadPipelines()[0])).toBe(afterFirst);
  expect(adopted.conversationId).toBe("conversation_child");
});

test.each([
  { engine: "claude", model: "claude-sonnet-4-6", serviceTier: undefined },
  { engine: "codex", model: "gpt-6-sol", serviceTier: "priority" },
  { engine: "codex", model: "gpt-6-astra", serviceTier: "ultrafast" },
  { engine: "codex", model: "gpt-6-sol", serviceTier: undefined },
] as const)("historical adoption replaces the source tier with $engine/$model/$serviceTier", async ({ engine, model, serviceTier }) => {
  const runtime = { engine, model, effort: "high", ...(serviceTier ? { serviceTier } : {}) };
  const h = harness();
  const pipeline = await create(h.ports);
  const sourceRun = pipeline.runs.find((run) => run.stageId === "plan")!;
  sourceRun.attempts.push({
    n: 1,
    state: "passed",
    effectiveRole: {
      roleId: "architect",
      engine: "codex",
      model: "gpt-6-astra",
      effort: "high",
      serviceTier: "ultrafast",
      serviceTierSource: "role-default",
      preferredServiceTier: "ultrafast",
      access: "read-only",
      promptScaffold: "Architect guidance",
    },
    launchId: "launch-source-codex",
    conversationId: "conversation_source_codex",
    sessionId: "session-source-codex",
    agentPath: "/codex/source-cross-engine.jsonl",
    paneId: "%3",
    flowId: null,
    startedAt: "1970-01-01T00:10:00.000Z",
    completedAt: "1970-01-01T00:11:00.000Z",
    input: "original input",
    activatedBy: null,
    output: "source output",
    verdict: { status: "pass" },
    error: null,
  });
  pipeline.cursor = { stageId: "build", state: "running", input: "source output", activatedBy: { stageId: "plan", attempt: 1, edge: "pass" } };
  pipeline.state = "paused";
  pipeline.pausedState = "running";
  savePipelines([pipeline]);
  const registryPath = path.join(process.env.LLV_STATE_DIR!, "cross-engine-agent-registry.json");
  const registry = new AgentRegistry(registryPath);
  const begun = registry.beginSpawnRequest({
    engine,
    cwd: "/repo",
    accountId: "claude-test",
    parentConversationId: "conversation_source_codex",
    launchProfile: { model, effort: "high", serviceTier: serviceTier ?? null, title: "Adopt cross-engine pipeline stage" },
    memberships: [{
      kind: "pipeline",
      containerId: pipeline.id,
      role: "architect",
      slot: "adopt:plan:cross-engine",
      stageId: "plan",
      stageOrder: 0,
      round: null,
      parentConversationId: "conversation_source_codex",
      runtime: { engine, model, effort: "high" },
    }],
  });
  if (begun.kind !== "created") throw new Error("cross-engine spawn reservation conflicted");
  const childPath = `/${engine}/child-cross-engine.jsonl`;
  const childSessionId = crypto.randomUUID();
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine, sessionId: childSessionId },
    artifactPath: childPath,
    cwd: "/repo",
    accountId: "claude-test",
    launchProfile: begun.receipt.launchProfile,
    status: "starting",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  if (settled.kind !== "settled") throw new Error("cross-engine spawn settlement conflicted");
  const candidates = (() => {
    setAgentRegistryForTests(new AgentRegistry(registryPath));
    try {
      return defaultPipelinePorts().pipelineAdoptionCandidates(pipeline.id);
    } finally {
      setAgentRegistryForTests(null);
    }
  })();
  expect(candidates).toEqual([
    expect.objectContaining({
      sourceConversationId: "conversation_source_codex",
      conversationId: begun.receipt.conversationId,
      agentPath: childPath,
      runtime,
    }),
  ]);
  h.ports.pipelineAdoptionCandidates = () => candidates;
  const observedEngines: string[] = [];
  h.ports.durableTurnEvidence = async (observedEngine, transcriptPath) => {
    observedEngines.push(observedEngine);
    if (observedEngine !== engine || transcriptPath !== childPath) return null;
    return {
      turn: "terminal",
      message: {
        text: "cross-engine historical result\n\n```json\n{\"status\":\"pass\",\"findings\":[],\"confidence\":0.9}\n```",
        ts: Date.parse(begun.receipt.createdAt) + 1_000,
      },
    };
  };

  await tickPipelines([entry(childPath)], h.ports);

  expect(observedEngines).toContain(engine);
  const adopted = loadPipelines()[0]!.runs.find((run) => run.stageId === "plan")!.attempts[1]!;
  expect(adopted.effectiveRole).toMatchObject({
    roleId: "architect",
    ...runtime,
    access: "read-only",
  });
  expect(adopted.effectiveRole.serviceTier).toBe(serviceTier);
  expect(adopted.effectiveRole.serviceTierSource).toBeUndefined();
  expect(adopted.effectiveRole.preferredServiceTier).toBeUndefined();
  expect(pipeline.runs[0]!.attempts[0]!.effectiveRole.serviceTier).toBe("ultrafast");
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "plan")!.attempts[1]).toMatchObject({
    historical: true,
    state: "passed",
    verdict: { status: "pass" },
  });
});

test("historical adoption never replaces the operational retry predecessor", async () => {
  const h = harness();
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "retry me")], h.ports);
  const pipeline = loadPipelines()[0]!;
  const adopted = adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_stage_1",
    launchId: "launch-historical",
    conversationId: "conversation_historical",
    sessionId: "session-historical",
    agentPath: "/codex/historical.jsonl",
    paneId: null,
    startedAt: "1970-01-01T00:12:00.000Z",
  });
  expect(adopted?.historical).toBe(true);
  savePipelines([pipeline]);

  await patchPipeline(created.id, { action: "retry-stage" }, h.ports);
  await tickPipelines([], h.ports);

  expect(h.calls).toContain(`spawn:pipeline_${created.id}_plan_3:parent=/codex/creator.jsonl:supersedes=conversation_stage_1`);
});

test("creation validates the 1–8 stage conversation graph and optional roles", async () => {
  const { ports } = harness();
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [] }, ports)).status).toBe(400);
  /* v3 graph rules: edge targets must exist and pass edges stay acyclic. */
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "a", next: "missing" },
    { id: "b", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "b", next: null },
  ] }, ports)).error).toContain("must reference an existing stage");
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "a", next: "b" },
    { id: "b", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "b", next: "a" },
  ] }, ports)).error).toContain("cycle");
  const roleless = await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", prompt: "a", next: "b" },
    { id: "b", kind: "run", prompt: "b", next: null },
  ] }, ports);
  expect(roleless.pipeline?.stages[0]?.role).toBeUndefined();
  expect((await createPipelineFromRequest({ task: "x", repoDir: "/repo", stages: [
    { id: "a", kind: "run", role: { roleId: "builder" }, prompt: "a", next: "b" },
    { id: "b", kind: "run", role: { roleId: "builder", engine: "codex" }, prompt: "b", next: null },
  ] as never }, ports)).error).toContain("role only accepts roleId");
});

test("a merger stage resolves through production role lookup during pipeline normalization", async () => {
  const h = harness();
  savePipelines([]);
  const { pipelineRoleLookup } = await import("./roles");
  h.ports.roleLookup = pipelineRoleLookup;
  const stagePrompt = "Merge the reviewed batch";
  const promptKey = "prompt";
  const created = await createPipelineFromRequest({
    task: "Merge reviewed pull requests",
    repoDir: "/repo",
    autoStart: false,
    stages: [{
      id: "merge",
      kind: "run",
      role: { roleId: "merger", params: { prs: "12@abcdef1" } },
      [promptKey]: stagePrompt,
      next: null,
    }],
  }, h.ports);
  expect(created.pipeline?.stages[0]).toMatchObject({
    role: { roleId: "merger", params: { prs: "12@abcdef1" } },
    effectiveRole: {
      roleId: "merger",
      engine: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      access: "read-write",
      /* The batch procedure is the project's own; Delegatus names it in CONTRIBUTING.md. */
      promptScaffold: expect.stringContaining("Merge through the batch procedure the project's instruction files name"),
    },
  });
});

/* Every UI lane ends with a visual-critic stage: create_pipeline takes it, and
   its agent launches read-only on the role's own Claude Opus row. */
test("a visual-critic stage is accepted and launches read-only on the role's runtime", async () => {
  const h = harness();
  savePipelines([]);
  const { pipelineRoleLookup } = await import("./roles");
  h.ports.roleLookup = pipelineRoleLookup;
  await create(h.ports, [{ id: "shots", kind: "run", role: { roleId: "visual-critic" }, prompt: "Judge the frames", next: null }] as never);
  const expected = { roleId: "visual-critic", engine: "claude", model: "opus", effort: "high", access: "read-only" };
  expect(loadPipelines()[0]!.stages[0]).toMatchObject({ role: { roleId: "visual-critic" }, effectiveRole: { ...expected, promptScaffold: expect.stringContaining("You are a Visual-critic.") } });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs[0]).toMatchObject({ role: expected, runtimeProfile: { access: "read-only" } });
});

/* Visual judgement runs on Claude and the critic never writes, whoever asks:
   creation refuses a Codex runtime and read-write access, and an override that
   turns a writable builder stage into the critic launches it read-only. */
test("a visual-critic stage refuses Codex and read-write on create and override", async () => {
  const h = harness();
  savePipelines([]);
  const { pipelineRoleLookup } = await import("./roles");
  h.ports.roleLookup = pipelineRoleLookup;
  const critic = { id: "shots", kind: "run", role: { roleId: "visual-critic" }, prompt: "Judge the frames", next: null };
  const refusal = async (stage: Record<string, unknown>) => JSON.stringify(await createPipelineFromRequest(
    { task: "Ship pipelines", spec: "AC1", repoDir: "/repo", stages: [{ ...critic, ...stage }] as never, src: "/codex/creator.jsonl", publication: "internal" }, h.ports));
  expect(await refusal({ engine: "codex", model: "gpt-6.1-sol", effort: "high" })).toContain("visual-critic runs on claude only");
  expect(await refusal({ access: "read-write" })).toContain("role visual-critic is read-only; a stage cannot give it read-write access");
  expect(loadPipelines()).toEqual([]);

  const pipeline = await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null }] as never);
  expect(pipeline.stages[0]!.effectiveRole.access).toBe("read-write");
  const codex = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "build", role: { roleId: "visual-critic" }, engine: "codex", model: "gpt-6.1-sol" }, h.ports);
  expect(codex).toMatchObject({ status: 400, error: "visual-critic runs on claude only" });
  const edited = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "build", role: { roleId: "visual-critic" }, access: "read-write" }, h.ports);
  expect(edited.error).toBeUndefined();
  const expected = { roleId: "visual-critic", engine: "claude", model: "opus", effort: "high", access: "read-only" };
  expect(loadPipelines()[0]!.stages[0]).toMatchObject({ access: "read-only", effectiveRole: expected });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs[0]).toMatchObject({ role: expected, runtimeProfile: { access: "read-only" } });
});

test("review-loop onFail edges are rejected during creation and graph editing", async () => {
  const h = harness();
  savePipelines([]);
  const invalid = await createPipelineFromRequest({
    task: "Unreachable review fix edge",
    repoDir: "/repo",
    autoStart: false,
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null, onFail: { to: "build", maxRounds: 3 } },
    ],
  }, h.ports);

  expect(invalid).toMatchObject({
    error: "review-loop stage review does not support onFail",
    status: 400,
    violations: [{ field: "stages[].next", message: "review-loop stage review does not support onFail" }],
  });
  expect(loadPipelines()).toEqual([]);

  const valid = await createPipelineFromRequest({
    task: "Editable review graph",
    repoDir: "/repo",
    autoStart: false,
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
    ],
  }, h.ports);
  if (!valid.pipeline) throw new Error(valid.error);
  /* A new review-loop is converted at creation (#2187); the edit is refused
     on a stored legacy draft, which still carries one. */
  savePipelines([asStoredLegacyReviewLane(valid.pipeline, valid.convertedStages)]);

  const edited = await patchPipeline(valid.pipeline.id, {
    action: "set-edge",
    stageId: "review",
    edge: "fail",
    to: "build",
    maxRounds: 3,
  }, h.ports);
  expect(edited).toMatchObject({
    error: "review-loop stage review does not support onFail",
    status: 400,
  });
  expect(loadPipelines()[0]!.stages.find((stage) => stage.id === "review")!.onFail).toBeNull();
});

test("auto-start creation admits the record with its base unresolved and the controller fetches it (#1799)", async () => {
  const h = harness();
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Pinned base", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  /* The answer carries the branch the caller asked for and no commit: the
     base is still being resolved, and saying so is what lets the call return
     before the fetch it used to wait on. */
  expect(result.pipeline).toMatchObject({
    state: "provisioning",
    baseBranch: "main",
    baseRef: "",
    lastPassedCommit: "",
    stateDetail: "resolving the pipeline base and provisioning the worktree",
  });
  expect(loadPipelines()[0]).toMatchObject({ baseBranch: "main", baseRef: "", lastPassedCommit: "" });
  expect(h.calls.some((call) => call.includes("git fetch"))).toBe(false);

  await tickPipelines([], h.ports);

  expect(h.calls).toContain("timeout --signal=KILL 60s git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
  expect(loadPipelines()[0]).toMatchObject({
    state: "running",
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
    stateDetail: null,
  });
});

test("create answers before the base fetch finishes, and the lane starts from what the fetch produced (#1799)", async () => {
  const h = harness();
  savePipelines([]);
  const remote = slowRemote(h);

  const created = await createPipelineFromRequest({ task: "Answer at once", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  /* The call returned while the fetch that resolves its base had not even
     started, which is the whole of what the operator asked for. */
  expect(remote.fetched()).toBe(false);
  expect(created.pipeline).toMatchObject({ state: "provisioning", baseBranch: "main", baseRef: "", lastPassedCommit: "" });

  await tickPipelines([], h.ports);

  /* The controller is what pays for the fetch — and the lane starts from the
     commit that fetch produced, never from the ref the repository already had. */
  expect(remote.fetched()).toBe(true);
  expect(loadPipelines()[0]).toMatchObject({
    state: "running",
    baseBranch: "main",
    baseRef: FETCHED_SHA,
    lastPassedCommit: FETCHED_SHA,
    stateDetail: null,
  });
});

test("a handover creation admitted by the controller is provisioned in the same pass", async () => {
  const { queuePipelineCreation } = await import("./creationQueue");
  const h = harness();
  savePipelines([]);
  const remote = slowRemote(h);
  const created = await createPipelineFromRequest({ task: "Queued lane", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  expect(created.pipeline).toBeDefined();
  const queued = loadPipelines()[0]!;
  const target = queued.delivery!.target;
  savePipelines([]);
  queuePipelineCreation(queued, target, false, "fixture handover", h.ports.now());
  await tickPipelines([], h.ports);
  expect(remote.fetched()).toBe(true);
  expect(loadPipelines()[0]).toMatchObject({ id: queued.id, state: "running", baseRef: FETCHED_SHA });
});

test("a create that arrives while the controller is provisioning is not held behind it (#1799)", async () => {
  const h = harness();
  savePipelines([]);
  const remote = slowRemote(h, { held: true });
  const first = await createPipelineFromRequest({ task: "First lane", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  expect(first.pipeline).toBeDefined();

  /* The controller pass that provisions the first lane, in flight: its fetch
     and its worktree add happen before it takes the registry lease, so the
     lease this second create waits on is held only for the writes. Held
     across the provisioning instead — which is what it used to be — this is
     the twenty-five seconds the operator watched. */
  const pass = tickPipelines([], h.ports);
  const second = await createPipelineFromRequest({ task: "Second lane", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  /* Answered while the pass's fetch is still held open: a create queued
     behind the provisioning could not have answered at all. */
  const fetchedWhenAnswered = remote.fetched();
  remote.release();
  await pass;

  expect(fetchedWhenAnswered).toBe(false);
  expect(remote.fetched()).toBe(true);
  expect(second.pipeline).toMatchObject({ state: "provisioning", baseRef: "" });
  expect(loadPipelines().map((pipeline) => pipeline.state).sort()).toEqual(["provisioning", "running"]);
});

test("two delayed git children run off the synchronous port while status and append RPCs keep answering", async () => {
  const h = harness();
  savePipelines([]);
  for (const task of ["First delayed lane", "Second delayed lane"]) {
    expect((await createPipelineFromRequest({ task, repoDir: `/repo-${task.startsWith("First") ? "first" : "second"}`, stages: RUN_STAGES as never }, h.ports)).pipeline).toBeDefined();
  }
  const { UnixRuntimeHostClient } = await import("@/lib/runtime/client");
  const gitModule = await import("./git");
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provision-host-"));
  const socketPath = path.join(hostRoot, "host.sock");
  const host = spawn(process.execPath, ["run", "src/runtime-host/main.ts"], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: path.join(hostRoot, "home"),
      XDG_CONFIG_HOME: path.join(hostRoot, "config"),
      TMPDIR: hostRoot,
      LLV_STATE_DIR: path.join(hostRoot, "state"),
      LLV_RUNTIME_HOST_SOCKET: socketPath,
      LLV_RUNTIME_JOURNAL: path.join(hostRoot, "events.sqlite"),
      LLV_VIEWER_DEPLOYMENTS: "0",
      LLV_RUNTIME_LEGACY_SCHEDULER: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let hostLog = "";
  host.stdout.on("data", (chunk) => { hostLog += String(chunk); });
  host.stderr.on("data", (chunk) => { hostLog += String(chunk); });
  const hostExited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
  const baseExec = h.ports.exec;
  const delayArgs = ["-c", "alias.provision-delay=!sleep 1.7", "provision-delay"];
  const isFetch = (args: string[]) => args.includes("fetch");
  /* The synchronous port makes this a red test against the former pre-pass:
     a fetch there blocks the event loop for the whole delay. It is counted,
     and the count is the verdict. */
  let synchronousFetches = 0;
  h.ports.exec = (command, args, cwd) => {
    if (isFetch(args)) {
      synchronousFetches += 1;
      spawnSync("git", delayArgs);
    }
    return baseExec(command, args, cwd);
  };
  let active = 0;
  let peak = 0;
  h.ports.provisionExec = async (command, args, cwd, signal) => {
    if (isFetch(args)) {
      active += 1;
      peak = Math.max(peak, active);
      try {
        expect((await gitModule.realProvisionExec("git", delayArgs, process.cwd(), signal)).code).toBe(0);
      } finally { active -= 1; }
    }
    return baseExec(command, args, cwd);
  };
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const client = new UnixRuntimeHostClient(socketPath);
  const latencies: number[] = [];
  const rpcErrors: unknown[] = [];
  const probe = async () => {
    const started = performance.now();
    const results = await Promise.allSettled([
      client.operationStatus("provision-status"),
      client.append({ scope: "session:provision-test", kind: "delta", payload: { text: "hello" } }),
    ]);
    for (const result of results) if (result.status === "rejected") rpcErrors.push(result.reason);
    latencies.push(performance.now() - started);
  };
  let tick: Promise<unknown> | undefined;
  try {
    let ready = false;
    for (let retry = 0; retry < 100; retry += 1) {
      if (host.exitCode !== null || host.signalCode !== null) break;
      if (!fs.existsSync(socketPath)) { await Bun.sleep(50); continue; }
      try { await client.operationStatus("readiness"); ready = true; break; }
      catch { await Bun.sleep(50); }
    }
    if (!ready) throw new Error(`isolated host did not start: ${hostLog}`);
    delay.enable();
    await Bun.sleep(30);
    const first = probe();
    tick = tickPipelines([], h.ports);
    await first;
    for (let i = 0; i < 5; i += 1) { await Bun.sleep(100); await probe(); }
    await tick;
    await Bun.sleep(30);
    const maxDelayMs = delay.max / 1e6;
    /* RPC latency and event-loop delay are reported, never asserted (#1761):
       they measure the runner as much as the controller. Responsiveness is
       held by where the fetches ran: both on the asynchronous provisioning
       port, concurrently, and none on the synchronous one. */
    console.log(JSON.stringify({ provisioningResponsiveness: { maxRpcMs: Math.max(...latencies), maxDelayMs, peakChildren: peak, rpcErrors: rpcErrors.length } }));
    expect(rpcErrors).toEqual([]);
    expect(synchronousFetches).toBe(0);
    expect(peak).toBe(2);
    expect(loadPipelines().every((pipeline) => pipeline.state === "running")).toBe(true);
  } finally {
    await tick;
    delay.disable();
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
    const force = setTimeout(() => { if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL"); }, 1000);
    await hostExited;
    clearTimeout(force);
    fs.rmSync(hostRoot, { recursive: true, force: true });
  }
}, 15_000);

test("lanes in linked checkouts serialize Git writes through their common directory", async () => {
  const h = harness();
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-shared-provision-"));
  const source = path.join(root, "source");
  const linked = path.join(root, "linked");
  const origin = path.join(root, "origin.git");
  const { realExec } = await import("@/lib/workflows/provision");
  const { realProvisionExec } = await import("./git");
  const git = async (cwd: string, ...args: string[]) => {
    const result = (await realExec("git", args, cwd));
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(root, "clone", origin, source));
    (await git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "base"));
    (await git(source, "push", "origin", "main"));
    (await git(source, "worktree", "add", "-b", "linked", linked));
    // Advance the remote from an independent clone, leaving both local refs stale.
    const publisher = path.join(root, "publisher");
    (await git(root, "clone", origin, publisher));
    (await git(publisher, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "advance"));
    (await git(publisher, "push", "origin", "main"));
    const expected = (await git(publisher, "rev-parse", "HEAD"));
    const hook = path.join(source, ".git", "hooks", "reference-transaction");
    fs.writeFileSync(hook, '#!/bin/sh\nif [ "$1" = prepared ]; then sleep 0.1; fi\n', { mode: 0o755 });
    for (const repoDir of [source, linked]) {
      expect((await createPipelineFromRequest({ task: "Shared repository", repoDir, stages: RUN_STAGES as never }, h.ports)).pipeline).toBeDefined();
    }
    let writers = 0;
    let peakWriters = 0;
    h.ports.provisionExec = async (command, args, cwd, signal) => {
      const writes = args.includes("fetch") || args[0] === "worktree";
      if (writes) peakWriters = Math.max(peakWriters, ++writers);
      try { return await realProvisionExec(command, args, cwd, signal); }
      finally { if (writes) writers -= 1; }
    };
    await tickPipelines([], h.ports);
    expect(peakWriters).toBe(1);
    for (const pipeline of loadPipelines()) {
      expect(pipeline).toMatchObject({ state: "running", baseRef: expected, lastPassedCommit: expected });
      expect((await git(pipeline.worktreeDir, "rev-parse", "HEAD"))).toBe(expected);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

for (const disposition of ["close", "remove"] as const) {
  test(`${disposition} cancels an active provisioning child without a worktree or duplicate tick`, async () => {
    const h = harness();
    savePipelines([]);
    const created = await createPipelineFromRequest({ task: "Cancellable lane", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
    const id = created.pipeline!.id;
    const { realProvisionExec } = await import("./git");
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    let fetches = 0;
    let result: Awaited<ReturnType<typeof realProvisionExec>> | undefined;
    h.ports.provisionExec = async (command, args, cwd, signal) => {
      if (args.includes("fetch")) {
        fetches += 1;
        const child = realProvisionExec("git", ["-c", "alias.provision-delay=!sleep 5", "provision-delay"], process.cwd(), signal);
        started();
        result = await child;
        return result;
      }
      return (await h.ports.exec(command, args, cwd));
    };
    const tick = tickPipelines([], h.ports);
    try {
      await active;
      expect(await tickPipelines([], h.ports)).toEqual({ pipelines: [], changed: false });
      if (disposition === "close") {
        expect((await patchPipeline(id, { action: "close" }, h.ports)).pipeline?.state).toBe("closed");
      } else {
        // Cross-process removal is observed through the collection revision.
        savePipelines([]);
      }
      await tick;
      // Killed, not waited out: the five-second fetch ended on SIGKILL.
      expect(result?.stderr).toBe("command cancelled");
      expect(result?.signal).toBe("SIGKILL");
      expect(fetches).toBe(1);
      expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);
      if (disposition === "close") expect(loadPipelines()[0]).toMatchObject({ state: "closed", baseRef: "" });
      else expect(loadPipelines()).toEqual([]);
    } finally { await tick; }
  }, 10_000);
}

test("a completed provision loses its fence when ownership changes before the apply lease", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({ task: "Fenced outcome", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  const id = created.pipeline!.id;
  const { withPipelineMutation } = await import("./store");
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let checked!: () => void;
  const completed = new Promise<void>((resolve) => { checked = resolve; });
  h.ports.provisionExec = async (command, args, cwd) => {
    const result = (await h.ports.exec(command, args, cwd));
    if (args[0] === "rev-parse" && args[1] === "HEAD") checked();
    return result;
  };
  const mutation = withPipelineMutation(async (pipelines, persist) => {
    entered();
    await released;
    const current = pipelines.find((pipeline) => pipeline.id === id)!;
    current.delivery!.epoch += 1;
    current.delivery!.ownerId = "replacement-owner";
    current.delivery!.active = false;
    await persist();
  });
  await holding;
  const tick = tickPipelines([], h.ports);
  try {
    await completed;
    // Let the pre-pass finish and queue for the lease held above.
    await Bun.sleep(20);
  } finally { release(); }
  await mutation;
  await tick;
  expect(loadPipelines()[0]).toMatchObject({ state: "provisioning", baseRef: "", lastPassedCommit: "", delivery: { ownerId: "replacement-owner" } });
});

test("an unavailable remote parks the admitted pipeline with the words the refusal used (#1799)", async () => {
  const h = harness();
  savePipelines([]);
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => (command === "timeout" ? args.slice(args.indexOf("git") + 1) : args)[0] === "fetch"
    ? { code: 128, stdout: "", stderr: "origin unavailable" }
    : baseExec(command, args, cwd);

  const result = await createPipelineFromRequest({ task: "No remote", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  /* The create is answered — the remote is not consulted before an answer any
     more — and the reason the creation used to refuse with is what the lane
     parks on instead. */
  expect(result.pipeline).toMatchObject({ state: "provisioning", baseRef: "" });
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: "fetching origin/main: origin unavailable" });
  /* Never a stale ref: nothing was provisioned and no base was recorded. */
  expect(parked.baseRef).toBe("");
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);
});

test("a base fetch the resolver failed once is retried with backoff, and the lane starts (#2220)", async () => {
  const h = harness();
  savePipelines([]);
  const { scheduled, advance } = provisionRetryClock(h);
  const baseExec = h.ports.exec;
  let fetches = 0;
  h.ports.provisionExec = async (command, args, cwd) => {
    const gitArgs = command === "timeout" ? args.slice(args.indexOf("git") + 1) : args;
    if (gitArgs[0] === "fetch" && ++fetches === 1) return { code: 128, stdout: "", stderr: DNS_FAILURE };
    return baseExec(command, args, cwd);
  };
  await createPipelineFromRequest({ task: "Flaky resolver", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  await tickPipelines([], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("provisioning");
  expect(waiting.stateDetail).toContain("DNS lookup of github.com failed");
  expect(waiting.stateDetail).toContain("retry 1 at");
  expect(scheduled).toEqual([5_000]);
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);

  advance(5_000);
  await tickPipelines([], h.ports);
  expect(fetches).toBe(2);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", baseRef: ORIGIN_MAIN_SHA, stateDetail: null });
  expect(loadPipelines()[0]!.provisioningWait).toBeUndefined();
});

test("a lane waiting out its provisioning backoff is not provisioned early (#2220)", async () => {
  const h = harness();
  savePipelines([]);
  const { advance } = provisionRetryClock(h);
  const baseExec = h.ports.exec;
  let fetches = 0;
  h.ports.provisionExec = async (command, args, cwd) => {
    const gitArgs = command === "timeout" ? args.slice(args.indexOf("git") + 1) : args;
    if (gitArgs[0] === "fetch" && ++fetches === 1) return { code: 128, stdout: "", stderr: DNS_FAILURE };
    return baseExec(command, args, cwd);
  };
  await createPipelineFromRequest({ task: "Early tick", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  await tickPipelines([], h.ports);
  // An unrelated wake-up four seconds later leaves the backoff alone.
  advance(4_000);
  await tickPipelines([], h.ports);
  expect(fetches).toBe(1);
  expect(loadPipelines()[0]!.state).toBe("provisioning");
});

test("a missing base branch or a refused login parks on the first attempt, never retried (#2220)", async () => {
  for (const stderr of [
    "fatal: couldn't find remote ref refs/heads/main",
    "Permission denied (publickey).\nfatal: Could not read from remote repository.",
  ]) {
    const h = harness();
    savePipelines([]);
    const { scheduled } = provisionRetryClock(h);
    const baseExec = h.ports.exec;
    let fetches = 0;
    h.ports.provisionExec = async (command, args, cwd) => {
      const gitArgs = command === "timeout" ? args.slice(args.indexOf("git") + 1) : args;
      if (gitArgs[0] === "fetch") { fetches += 1; return { code: 128, stdout: "", stderr }; }
      return baseExec(command, args, cwd);
    };
    await createPipelineFromRequest({ task: "Real error", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
    await tickPipelines([], h.ports);
    expect(fetches).toBe(1);
    expect(scheduled).toEqual([]);
    expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: `fetching origin/main: ${stderr.trim()}` });
  }
});

test("a resolver that never recovers parks after the bounded budget and names the host and the fix (#2220)", async () => {
  const h = harness();
  savePipelines([]);
  const { scheduled, advance } = provisionRetryClock(h);
  const baseExec = h.ports.exec;
  let fetches = 0;
  h.ports.provisionExec = async (command, args, cwd) => {
    const gitArgs = command === "timeout" ? args.slice(args.indexOf("git") + 1) : args;
    if (gitArgs[0] === "fetch") { fetches += 1; return { code: 128, stdout: "", stderr: DNS_FAILURE }; }
    return baseExec(command, args, cwd);
  };
  await createPipelineFromRequest({ task: "Dead resolver", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  for (let pass = 0; pass < 20 && loadPipelines()[0]!.state === "provisioning"; pass += 1) {
    await tickPipelines([], h.ports);
    advance(scheduled.at(-1) ?? 0);
  }
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toMatch(/^gave up after 6 retries over 180s: DNS lookup of github\.com failed/);
  expect(parked.stateDetail).toContain("retry-stage");
  expect(parked.stateDetail).toContain("fetching origin/main: ssh: Could not resolve hostname github.com");
  expect(parked.provisioningWait).toBeUndefined();
  /* The whole wait is bounded: every backoff is at most a minute, and the
     sum of what was booked never exceeds the three-minute budget. */
  expect(Math.max(...scheduled)).toBeLessThanOrEqual(60_000);
  expect(scheduled.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(180_000);
  expect(fetches).toBe(scheduled.length + 1);
});

test("a ref lock another Git process holds is retried, and the lane provisions once it is released (#2115)", async () => {
  savePipelines([]);
  const { root, repo, git, realExec } = await realProvisioningRepo("ref-lock");
  try {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "complete file\n");
    (await git(repo, "add", "."));
    (await git(repo, "commit", "-m", "base"));
    const base = (await git(repo, "rev-parse", "HEAD"));
    const h = harness();
    const { scheduled, advance } = provisionRetryClock(h);
    const { realProvisionExec } = await import("./git");
    h.ports.exec = realExec;
    h.ports.provisionExec = realProvisionExec;
    const created = await createPipelineFromRequest({ task: "Concurrent lane", repoDir: repo, baseRef: base, stages: RUN_STAGES as never, publication: "internal" }, h.ports);
    const lane = created.pipeline!;
    const branch = lane.delivery?.disposition === "owner" ? lane.delivery.target.branch.replace(/^refs\/heads\//, "") : lane.branch;
    /* What a concurrent `git worktree add` or ref update leaves for a moment:
       the loose ref's lock file. */
    const lock = path.join(repo, ".git", "refs", "heads", `${branch}.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");

    await tickPipelines([], h.ports);
    const waiting = loadPipelines()[0]!;
    expect(waiting.state).toBe("provisioning");
    expect(waiting.stateDetail).toContain("a Git lock was held");
    expect(scheduled).toEqual([5_000]);

    fs.rmSync(lock);
    advance(5_000);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "running", baseRef: base, stateDetail: null });
    expect((await git(lane.worktreeDir, "rev-parse", "HEAD"))).toBe(base);
    expect(fs.readFileSync(path.join(lane.worktreeDir, "tracked.txt"), "utf8")).toBe("complete file\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("a failed attempt that already created the branch and worktree is adopted by the retry (#2115)", async () => {
  savePipelines([]);
  const { root, repo, git, realExec } = await realProvisioningRepo("adopt-created");
  try {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "complete file\n");
    (await git(repo, "add", "."));
    (await git(repo, "commit", "-m", "base"));
    const base = (await git(repo, "rev-parse", "HEAD"));
    const h = harness();
    const { advance } = provisionRetryClock(h);
    const { realProvisionExec } = await import("./git");
    h.ports.exec = realExec;
    let adds = 0;
    /* The add really runs and creates both, then reports the lock race the
       issue quotes: the branch and the worktree exist although git failed. */
    h.ports.provisionExec = async (command, args, cwd, signal) => {
      const result = await realProvisionExec(command, args, cwd, signal);
      if (args[0] === "worktree" && args[1] === "add" && ++adds === 1) {
        return { code: 128, stdout: "", stderr: `fatal: cannot lock ref 'refs/heads/${args[3]}': Unable to create '${repo}/.git/refs/heads/${args[3]}.lock': File exists.` };
      }
      return result;
    };
    const created = await createPipelineFromRequest({ task: "Adopt lane", repoDir: repo, baseRef: base, stages: RUN_STAGES as never, publication: "internal" }, h.ports);
    for (let pass = 0; pass < 3 && loadPipelines()[0]!.state === "provisioning"; pass += 1) {
      await tickPipelines([], h.ports);
      advance(60_000);
    }
    expect(loadPipelines()[0]).toMatchObject({ state: "running", baseRef: base });
    expect((await git(created.pipeline!.worktreeDir, "rev-parse", "HEAD"))).toBe(base);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("a checkout killed at its bound is finished by the retry instead of parking on its initialization lock (#2176)", async () => {
  savePipelines([]);
  const { root, repo, git, realExec } = await realProvisioningRepo("killed-checkout");
  const marker = path.join(root, "smudge-started");
  try {
    fs.writeFileSync(path.join(repo, ".gitattributes"), "tracked.txt filter=slow\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "complete file\n");
    (await git(repo, "add", "."));
    (await git(repo, "commit", "-m", "base"));
    const base = (await git(repo, "rev-parse", "HEAD"));
    /* A checkout that cannot finish inside its bound: the host under load. */
    (await git(repo, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`));
    (await git(repo, "config", "filter.slow.required", "true"));
    const h = harness();
    const { scheduled, advance } = provisionRetryClock(h);
    const { realProvisionExec } = await import("./git");
    h.ports.exec = realExec;
    // The production port, with the sixty-second checkout bound cut to half a second.
    h.ports.provisionExec = async (command, args, cwd, signal) => args[0] === "worktree" && args[1] === "add"
      ? realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal)
      : realProvisionExec(command, args, cwd, signal);
    const created = await createPipelineFromRequest({ task: "Loaded host", repoDir: repo, baseRef: base, stages: RUN_STAGES as never, publication: "internal" }, h.ports);
    const lane = created.pipeline!;

    await tickPipelines([], h.ports);
    expect(fs.existsSync(marker)).toBe(true);
    const waiting = loadPipelines()[0]!;
    expect(waiting.state).toBe("provisioning");
    expect(waiting.stateDetail).toContain("checkout interrupted or timed out");
    expect(scheduled).toEqual([5_000]);
    expect((await git(repo, "worktree", "list", "--porcelain"))).toContain("locked initializing");
    fs.writeFileSync(path.join(lane.worktreeDir, "keep.txt"), "untracked work survives\n");

    // The load passes; the retry finishes the checkout the killed one began.
    (await git(repo, "config", "filter.slow.smudge", "cat"));
    (await git(repo, "config", "filter.slow.clean", "cat"));
    advance(5_000);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "running", baseRef: base, stateDetail: null });
    expect(fs.readFileSync(path.join(lane.worktreeDir, "tracked.txt"), "utf8")).toBe("complete file\n");
    expect(fs.readFileSync(path.join(lane.worktreeDir, "keep.txt"), "utf8")).toBe("untracked work survives\n");
    expect((await git(repo, "worktree", "list", "--porcelain"))).not.toContain("locked");
    expect((await git(lane.worktreeDir, "status", "--porcelain", "--untracked-files=no"))).toBe("");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("interrupted checkout recovery preserves an untracked directory that blocks a tracked file", async () => {
  savePipelines([]);
  const { root, repo, git, realExec } = await realProvisioningRepo("interrupted-checkout-collision");
  const marker = path.join(root, "smudge-started");
  try {
    fs.writeFileSync(path.join(repo, ".gitattributes"), "tracked.txt filter=slow\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "complete file\n");
    (await git(repo, "add", "."));
    (await git(repo, "commit", "-m", "base"));
    const base = (await git(repo, "rev-parse", "HEAD"));
    (await git(repo, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`));
    (await git(repo, "config", "filter.slow.required", "true"));
    const h = harness();
    const { scheduled, advance } = provisionRetryClock(h);
    const { realProvisionExec } = await import("./git");
    h.ports.exec = realExec;
    h.ports.provisionExec = async (command, args, cwd, signal) => args[0] === "worktree" && args[1] === "add"
      ? realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal)
      : realProvisionExec(command, args, cwd, signal);
    const created = await createPipelineFromRequest({ task: "Collision recovery", repoDir: repo, baseRef: base, stages: RUN_STAGES as never, publication: "internal" }, h.ports);
    const lane = created.pipeline!;
    await tickPipelines([], h.ports);
    expect(fs.existsSync(marker)).toBe(true);
    const collision = path.join(lane.worktreeDir, "tracked.txt");
    fs.rmSync(collision, { recursive: true, force: true });
    fs.mkdirSync(collision);
    fs.writeFileSync(path.join(collision, "operator-note.txt"), "keep this operator file\n");
    (await git(repo, "config", "filter.slow.smudge", "cat"));
    (await git(repo, "config", "filter.slow.clean", "cat"));

    advance(5_000);
    await tickPipelines([], h.ports);

    expect(JSON.stringify(loadPipelines()[0])).toContain("untracked content blocking tracked paths");
    expect(fs.readFileSync(path.join(collision, "operator-note.txt"), "utf8")).toBe("keep this operator file\n");
    expect((await git(repo, "worktree", "list", "--porcelain"))).toContain("locked initializing");
    expect(scheduled).toEqual([5_000]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("interrupted checkout recovery parks before overwriting a tracked edit", async () => {
  savePipelines([]);
  const { root, repo, git, realExec } = await realProvisioningRepo("interrupted-checkout-edit");
  const marker = path.join(root, "smudge-started");
  try {
    fs.writeFileSync(path.join(repo, ".gitattributes"), "tracked.txt filter=slow\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "original operator file\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "complete file\n");
    (await git(repo, "add", "."));
    (await git(repo, "commit", "-m", "base"));
    const base = (await git(repo, "rev-parse", "HEAD"));
    (await git(repo, "config", "filter.slow.smudge", `printf ready > '${marker}'; sleep 120; cat`));
    (await git(repo, "config", "filter.slow.required", "true"));
    const h = harness();
    const { advance } = provisionRetryClock(h);
    const { realProvisionExec } = await import("./git");
    h.ports.exec = realExec;
    h.ports.provisionExec = async (command, args, cwd, signal) => args[0] === "worktree" && args[1] === "add"
      ? realProvisionExec("timeout", ["--signal=KILL", "0.5s", command, ...args], cwd, signal)
      : realProvisionExec(command, args, cwd, signal);
    const created = await createPipelineFromRequest({ task: "Edit recovery", repoDir: repo, baseRef: base, stages: RUN_STAGES as never, publication: "internal" }, h.ports);
    const lane = created.pipeline!;
    await tickPipelines([], h.ports);
    expect(fs.existsSync(marker)).toBe(true);
    const edited = path.join(lane.worktreeDir, "a.txt");
    fs.writeFileSync(edited, "operator edit to preserve\n");
    (await git(repo, "config", "filter.slow.smudge", "cat"));
    (await git(repo, "config", "filter.slow.clean", "cat"));

    advance(5_000);
    await tickPipelines([], h.ports);

    expect(JSON.stringify(loadPipelines()[0])).toContain("modified tracked path");
    expect(fs.readFileSync(edited, "utf8")).toBe("operator edit to preserve\n");
    expect((await git(repo, "worktree", "list", "--porcelain"))).toContain("locked initializing");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("repository admission fails before pipeline persistence or provisioning", async () => {
  const h = harness();
  savePipelines([]);
  h.ports.preflightRepo = () => ({ ok: false, code: "repo_unreadable", path: "/repo" });

  const result = await createPipelineFromRequest({ task: "Private repo", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  expect(result).toEqual({
    error: "repository is not readable: /repo",
    status: 403,
    code: "repo_unreadable",
    field: "repoDir",
    path: "/repo",
  });
  expect(loadPipelines()).toEqual([]);
  expect(h.calls).toEqual([]);
});

test("create, draft repo edits, and Start share canonical repository admission", async () => {
  const h = harness();
  const checked: string[] = [];
  h.ports.preflightRepo = (repoDir) => {
    checked.push(repoDir);
    return { ok: true, repoDir: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", worktreeParent: "/canonical" };
  };
  savePipelines([]);

  const created = await createPipelineFromRequest({ task: "Canonical", repoDir: "/alias", stages: RUN_STAGES as never, autoStart: false }, h.ports);
  expect(created.pipeline?.repoDir).toBe("/canonical/repo");

  h.ports.preflightRepo = (repoDir) => {
    checked.push(repoDir);
    if (repoDir === "/second") return { ok: true, repoDir: "/canonical/second", gitCommonDir: "/canonical/second/.git", worktreeParent: "/canonical" };
    return { ok: false, code: "git_metadata_unwritable", path: "/canonical/second/.git" };
  };
  const updated = await patchPipeline(created.pipeline!.id, { action: "update-draft", repoDir: "/second" }, h.ports);
  expect(updated.pipeline?.repoDir).toBe("/canonical/second");

  const blocked = await patchPipeline(created.pipeline!.id, { action: "start" }, h.ports);
  expect(blocked).toMatchObject({ status: 403, code: "git_metadata_unwritable", field: "repoDir" });
  expect(loadPipelines()[0]).toMatchObject({ state: "draft", repoDir: "/canonical/second" });
  expect(checked).toEqual(["/alias", "/second", "/canonical/second"]);
});

test("a parked provisioning retry reuses the pinned base and provisions again", async () => {
  const h = harness();
  savePipelines([]);
  const baseExec = h.ports.exec;
  let failWorktreeAdd = true;
  h.ports.exec = (command, args, cwd) => {
    if (args[0] === "worktree" && failWorktreeAdd) return { code: 128, stdout: "", stderr: "worktree unavailable" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && cwd?.includes("-pipeline-")) {
      return failWorktreeAdd
        ? { code: 128, stdout: "", stderr: "missing worktree" }
        : { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };
  const created = await createPipelineFromRequest({ task: "Recover provision", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({
    state: "needs_decision",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });

  failWorktreeAdd = false;
  const retried = await patchPipeline(created.pipeline!.id, { action: "retry-stage" }, h.ports);
  expect(retried.pipeline?.state).toBe("provisioning");
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", baseRef: ORIGIN_MAIN_SHA, lastPassedCommit: ORIGIN_MAIN_SHA });
});

test("controller recovery stamps an older unresolved provisioning record before creating its worktree", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Recover legacy provision",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, h.ports);
  const legacy = loadPipelines()[0]!;
  legacy.state = "provisioning";
  savePipelines([legacy]);

  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]).toMatchObject({
    id: created.pipeline!.id,
    state: "running",
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(h.calls).toContain("timeout --signal=KILL 60s git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
});

test("autoStart false persists a draft without provisioning or spawning", async () => {
  const h = harness();
  savePipelines([]);
  const result = await createPipelineFromRequest({
    task: "Review this draft",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, h.ports);

  expect(result.pipeline).toMatchObject({ state: "draft", cursor: { stageId: "plan", state: "pending", input: null, activatedBy: null } });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const persisted = loadPipelines()[0]!;
  expect(persisted.state).toBe("draft");
  expect(persisted.runs.every((run) => run.attempts.length === 0)).toBe(true);
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);
  expect(h.calls.some((call) => call.startsWith("spawn:"))).toBe(false);
});

test("set-position persists a finite world pin without changing pipeline execution state", async () => {
  const h = harness();
  const created = await create(h.ports);

  const moved = await patchPipeline(created.id, { action: "set-position", pos: { x: 1337, y: -240 } }, h.ports);

  expect(moved.pipeline).toMatchObject({ id: created.id, state: created.state, pos: { x: 1337, y: -240 } });
  expect(loadPipelines()[0]).toMatchObject({ pos: { x: 1337, y: -240 } });
  expect((await patchPipeline(created.id, { action: "set-position", pos: { x: Number.NaN, y: 1 } }, h.ports)).status).toBe(400);
});

test("dismiss and undismiss take a lane off the phone board and back without touching the lane (#1671)", async () => {
  const h = harness();
  const created = await create(h.ports);
  const before = loadPipelines()[0]!;
  const callsBefore = h.calls.length;

  const dismissed = await patchPipeline(created.id, { action: "dismiss" }, h.ports);
  expect(dismissed.error).toBeUndefined();
  const hiddenAt = dismissed.pipeline!.dismissedAt;
  expect(typeof hiddenAt).toBe("string");
  /* The lane itself is exactly what it was: state, cursor, runs, and the
     markers every other reader takes to mean closed. */
  const stored = loadPipelines()[0]!;
  expect(stored).toMatchObject({ state: before.state, closedAt: null, hiddenAt: before.hiddenAt ?? null, dismissedAt: hiddenAt });
  expect(stored.cursor).toEqual(before.cursor);
  expect(stored.runs).toEqual(before.runs);
  expect(h.calls.length).toBe(callsBefore);

  expect(stored.dismissedBy).toEqual({ kind: "operator" });

  /* A second dismissal stamps its own instant (docs/design/needs-attention.md
     §5): a lane that parked again after an earlier one is cleared for the
     decision it waits on now, so the phone no longer clears it first. */
  const again = (await patchPipeline(created.id, { action: "dismiss" }, h.ports, { kind: "agent", role: "orchestrator", conversationId: "conversation_seat" })).pipeline!;
  expect(Date.parse(again.dismissedAt!)).toBeGreaterThan(Date.parse(hiddenAt!));
  expect(again.dismissedBy).toEqual({ kind: "agent", conversationId: "conversation_seat", role: "orchestrator" });

  /* The dismissal service's own write carries the attribution it derived. */
  const serviced = await setPipelineDismissal(created.id, true, { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" }, h.ports, undefined, "The merger already holds this work");
  expect(loadPipelines()[0]!.dismissedNote).toBe("The merger already holds this work");
  expect(serviced.pipeline!.dismissedBy).toEqual({ kind: "manager", conversationId: "conversation_seat", role: "orchestrator" });

  /* A card drawn before the lane's last movement clears nothing: that
     decision is one the operator has not seen. The one it drew, it clears. */
  const ran = loadPipelines()[0]!;
  ran.runs[0]!.attempts.push({
    n: 1, state: "failed", effectiveRole: structuredClone(ran.stages[0]!.effectiveRole),
    launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-09-24T09:00:00.000Z", completedAt: "2026-09-24T09:30:00.000Z",
    input: null, activatedBy: null, output: null, verdict: null, error: null,
  });
  savePipelines([ran]);
  const lastMove = laneMovedAt(ran);
  expect(lastMove).toBe(Date.parse("2026-09-24T09:30:00.000Z"));
  const stale = await setPipelineDismissal(created.id, true, { kind: "operator", surface: "desktop" }, h.ports, lastMove - 1);
  expect(stale.moved).toBe(true);
  expect(loadPipelines()[0]!).toMatchObject({ dismissedAt: serviced.pipeline!.dismissedAt, dismissedBy: { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" } });
  const current = await setPipelineDismissal(created.id, true, { kind: "operator", surface: "desktop" }, h.ports, lastMove);
  expect(current.moved).toBeUndefined();
  expect(current.pipeline!.dismissedBy).toEqual({ kind: "operator", surface: "desktop" });

  const shown = await patchPipeline(created.id, { action: "undismiss" }, h.ports);
  expect(shown.pipeline!.dismissedAt).toBeNull();
  expect(shown.pipeline!.dismissedBy).toBeUndefined();
  expect(shown.pipeline!.dismissedNote).toBeUndefined();
  expect(loadPipelines()[0]!).toMatchObject({ state: before.state, dismissedAt: null });

  const closed = await closeAndDrain(created.id, { action: "close" }, h.ports);
  expect(closed.pipeline!.state).toBe("closed");
  for (const action of ["dismiss", "undismiss"] as const) {
    expect((await patchPipeline(created.id, { action }, h.ports)).status).toBe(409);
  }
  expect((await setPipelineDismissal(created.id, true, { kind: "operator" }, h.ports)).status).toBe(409);

  savePipelines([]);
  const draft = await createPipelineFromRequest({ task: "A draft", repoDir: "/repo", stages: RUN_STAGES as never, autoStart: false }, h.ports);
  expect((await patchPipeline(draft.pipeline!.id, { action: "dismiss" }, h.ports)).status).toBe(409);
  expect(loadPipelines()[0]!.dismissedAt).toBeUndefined();
});

test("attach-link and detach-link keep manual PR and issue links on a lane in any state, normalizing what a person types (#2059)", async () => {
  const h = harness();
  const created = await create(h.ports);
  const callsBefore = h.calls.length;
  /* The harness remote is not GitHub, so a bare number names nothing yet. */
  const bare = await patchPipeline(created.id, { action: "attach-link", link: "#2059" }, h.ports);
  expect(bare).toMatchObject({ status: 400, code: "WORK_LINK_INVALID" });
  expect(bare.error).toContain("owner/repo#2059");
  const stored = loadPipelines()[0]!;
  savePipelines([{ ...stored, delivery: { ...stored.delivery!, target: { ...stored.delivery!.target, remote: "https://github.com/acme/widgets.git" } } }]);

  for (const link of ["#2059", "2059", "https://github.com/acme/widgets/issues/2059"]) {
    const attached = await patchPipeline(created.id, { action: "attach-link", link }, h.ports);
    expect(attached.error).toBeUndefined();
  }
  expect(loadPipelines()[0]!.workLinks).toEqual([{ repository: "acme/widgets", number: 2059, kind: "issue", addedAt: expect.any(String), addedBy: "operator" }]);
  /* Nothing but the record moved: no host, git or forge call. */
  expect(h.calls.length).toBe(callsBefore);
  const again = await patchPipeline(created.id, { action: "attach-link", link: "acme/widgets#2059" }, h.ports);
  expect(again.unchanged).toBe(true);

  const agent = await patchPipeline(created.id, { action: "attach-link", link: ["PR 12", "other-org/tools#3"] }, h.ports, { kind: "agent", conversationId: "conversation_fixture", role: null } as never);
  expect(agent.pipeline!.workLinks!.map((link) => [link.repository, link.number, link.kind, link.addedBy])).toEqual([
    ["acme/widgets", 2059, "issue", "operator"], ["acme/widgets", 12, "pr", "agent"], ["other-org/tools", 3, null, "agent"],
  ]);

  const closed = await closeAndDrain(created.id, { action: "close" }, h.ports);
  expect(closed.pipeline!.state).toBe("closed");
  const detached = await patchPipeline(created.id, { action: "detach-link", link: ["12", "other-org/tools#3", "#2059"] }, h.ports);
  expect(detached.error).toBeUndefined();
  expect("workLinks" in loadPipelines()[0]!).toBe(false);
  expect((await patchPipeline(created.id, { action: "attach-link", link: "0" }, h.ports)).status).toBe(400);
  expect((await patchPipeline(created.id, { action: "attach-link" }, h.ports)).status).toBe(400);
});

test("an explicit draft base remains pinned when the draft starts", async () => {
  const h = harness();
  savePipelines([]);
  const explicitRef = "release-candidate";
  const created = await createPipelineFromRequest({
    task: "Pinned draft",
    repoDir: "/repo",
    baseBranch: "release",
    baseRef: explicitRef,
    stages: RUN_STAGES as never,
    autoStart: false,
  }, h.ports);

  expect(created.pipeline).toMatchObject({
    state: "draft",
    baseBranch: "release",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  const callsBeforeStart = h.calls.length;
  const started = await patchPipeline(created.pipeline!.id, { action: "start" }, h.ports);
  expect(started.pipeline).toMatchObject({
    state: "provisioning",
    baseBranch: "release",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  expect(h.calls.slice(callsBeforeStart)).toEqual([]);
});

test("starting a draft enters the existing provision and stage-spawn path", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Start after review",
    repoDir: "/repo",
    stages: RUN_STAGES as never,
    autoStart: false,
  }, h.ports);
  const id = created.pipeline!.id;

  const started = await patchPipeline(id, { action: "start" }, h.ports);
  /* Start answers with the base still unresolved too (#1799): the fetch it
     used to make ran inside the pipeline mutation, which is the lock every
     other writer waits on. */
  expect(started.pipeline).toMatchObject({
    state: "provisioning",
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
    stateDetail: "resolving the pipeline base and provisioning the worktree",
  });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({
    state: "running",
    baseBranch: "main",
    baseRef: ORIGIN_MAIN_SHA,
    lastPassedCommit: ORIGIN_MAIN_SHA,
  });
  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(true);
  expect(h.calls.some((call) => call.startsWith("spawn:"))).toBe(true);
  expect(h.spawnTitles).toEqual(["Start after review · plan"]);
});

test("long pipeline tasks keep distinct stage identifiers in every spawn title", async () => {
  const h = harness();
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "x".repeat(4_000),
    repoDir: "/repo",
    stages: RUN_STAGES as never,
  }, h.ports);
  expect(created.pipeline).toBeDefined();

  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "plan output")], h.ports);
  await tickPipelines([], h.ports); // spawn build

  expect(h.spawnTitles).toHaveLength(2);
  expect(h.spawnTitles[0]).toEndWith(" · plan");
  expect(h.spawnTitles[1]).toEndWith(" · build");
  expect(h.spawnTitles[0]).not.toBe(h.spawnTitles[1]);
  expect(h.spawnTitles.every((title) => title.length <= 120)).toBe(true);
});

test("role params are accepted, persisted on the stage, and type-checked", async () => {
  const { ports } = harness();
  savePipelines([]);
  const ok = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder", params: { mode: "tdd" } }, engine: "codex", prompt: "a", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "b", next: null },
  ] as never }, ports);
  expect(ok.pipeline?.stages[0]?.role).toEqual({ roleId: "builder", params: { mode: "tdd" } });

  savePipelines([]);
  const bad = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder", params: { mode: { nested: true } } }, engine: "codex", prompt: "a", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "b", next: null },
  ] as never }, ports);
  expect(bad.error).toContain("params must be strings or numbers");
});

test("a deployer stage is rejected at create with a 400", async () => {
  const { ports } = harness();
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "a", next: "ship" },
    { id: "ship", kind: "run", role: { roleId: "deployer" }, engine: "codex", prompt: "b", next: null },
  ] as never }, ports);
  expect(result.status).toBe(400);
  expect(result.error).toContain("not allowed in a pipeline");
});

test("invalid role param values fail canonical validation with a 400", async () => {
  const { ports } = harness();
  savePipelines([]);
  const badSelect = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder", params: { mode: "bananas" } }, engine: "codex", prompt: "a", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "b", next: null },
  ] as never }, ports);
  expect(badSelect.status).toBe(400);
  expect(badSelect.error).toContain("invalid role parameter: mode");

  savePipelines([]);
  const unknownKey = await createPipelineFromRequest({ task: "x", spec: "AC", repoDir: "/repo", stages: [
    { id: "build", kind: "run", role: { roleId: "builder", params: { bogus: "x" } }, engine: "codex", prompt: "a", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "b", next: null },
  ] as never }, ports);
  expect(unknownKey.status).toBe(400);
  expect(unknownKey.error).toContain("unknown role parameter: bogus");
});

test("linear run stages persist sessions, structured outputs, commits, and lineage", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports); // provision
  await tickPipelines([], h.ports); // spawn plan
  let current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({ sessionId: "session-1", conversationId: "conversation_stage_1", state: "running" });
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass", "plan output")], h.ports);
  current = loadPipelines()[0]!;
  expect(current.cursor?.stageId).toBe("build");
  expect(current.runs[0]!.attempts[0]!.output).toBe("plan output");
  await tickPipelines([], h.ports); // spawn build
  expect(h.calls.some((call) => call.includes("parent=/codex/stage-1.jsonl"))).toBe(true);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass", "build output")], h.ports);
  current = loadPipelines()[0]!;
  expect(current.state).toBe("completed");
  expect(current.lastPassedCommit).toBe(ORIGIN_MAIN_SHA);
});

test("pipeline stage membership is supplied before every stage spawn", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  expect(h.calls).toContain(`membership:pipeline:${pipeline.id}:plan:1:architect:0:round=1`);
});

test("controller ticks follow a stage conversation to its resumed transcript", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.ports.pathForConversation = (id) => id === "conversation_stage_1" ? "/codex/stage-1-resumed.jsonl" : null;
  const resumed = entry("/codex/stage-1-resumed.jsonl");
  resumed.activity = "live";

  await tickPipelines([resumed], h.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.agentPath).toBe(resumed.path);
});

test("controller ticks refresh durable paths for completed pipeline attempts", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.state = "completed";
  pipeline.cursor = null;
  pipeline.runs[0]!.attempts[0]!.agentPath = "/codex/stage-1-archived.jsonl";
  savePipelines([pipeline]);
  h.ports.pathForConversation = (id) => id === "conversation_stage_1" ? "/codex/stage-1-resumed.jsonl" : null;

  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.agentPath).toBe("/codex/stage-1-resumed.jsonl");
});

test("spawn reservations persist before actuation and concurrent creation waits for the controller mutation", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports); // provision
  let releaseSpawn!: () => void;
  let reserved!: () => void;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const reservation = new Promise<void>((resolve) => { reserved = resolve; });
  h.ports.spawnAgent = async (_input, onReserved) => {
    await onReserved({ launchId: "launch-durable", conversationId: "conversation_durable" });
    reserved();
    await spawnGate;
    return { launchId: "launch-durable", conversationId: "conversation_durable", sessionId: "session-durable", transcript: "/codex/durable.jsonl", paneId: "%9" };
  };

  const ticking = tickPipelines([], h.ports);
  await reservation;
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "spawning",
    launchId: "launch-durable",
    conversationId: "conversation_durable",
  });
  let creationSettled = false;
  const creating = createPipelineFromRequest({
    task: "Second pipeline",
    repoDir: "/repo",
    stages: [
      { id: "build", kind: "run", prompt: "build", next: "verify" },
      { id: "verify", kind: "run", prompt: "verify", next: null },
    ],
  }, h.ports).then((result) => { creationSettled = true; return result; });
  await Promise.resolve();
  expect(creationSettled).toBe(false);

  releaseSpawn();
  await ticking;
  expect((await creating).pipeline).toBeDefined();
  expect(loadPipelines()).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId).toBe("launch-durable");
});

test.each([false, true])("activation drain yields the lease regardless of the legacy flag (%s)", async (enabled) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const retry = structuredClone(loadPipelines()[0]!);
  retry.id = "pipeline-unrelated-retry";
  Object.assign(retry, pipelineIdentity(retry.id, retry.task, retry.repoDir));
  retry.state = "needs_decision";
  retry.delivery = undefined;
  savePipelines([...loadPipelines(), retry]);
  const oldWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS;
  const oldDrain = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  process.env.LLV_PIPELINE_LOCK_WAIT_MS = "20";
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = enabled ? "1" : "0";
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    entered();
    await gate;
    return spawn(input, onReserved);
  };
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  type LeaseProbe = { options: { collection: string }; filename: string; acquireLease(wait?: number): Promise<string>; releaseLease(token: string): Promise<void> };
  const prototype = SqliteStateCollection.prototype as unknown as LeaseProbe;
  const acquire = prototype.acquireLease;
  const relinquish = prototype.releaseLease;
  const starts = new Map<string, number>();
  const holds: number[] = [];
  const acquired = spyOn(prototype, "acquireLease").mockImplementation(async function(this: LeaseProbe, wait) {
    const token = await acquire.call(this, wait);
    if (this.options.collection === "pipelines") starts.set(token, performance.now());
    return token;
  });
  const released = spyOn(prototype, "releaseLease").mockImplementation(async function(this: LeaseProbe, token) {
    await relinquish.call(this, token);
    const start = starts.get(token);
    if (start !== undefined) { holds.push(performance.now() - start); starts.delete(token); }
  });
  const start = performance.now();
  const ticking = tickPipelines([], h.ports);
  await started;
  try {
    await Bun.sleep(100);
    const making = createPipelineFromRequest({ task: "Unrelated draft", repoDir: "/repo", autoStart: false, stages: [...RUN_STAGES] }, h.ports);
    expect((await making).pipeline).toBeDefined();
    const retrying = patchPipeline(retry.id, { action: "retry-stage" }, h.ports);
    expect((await retrying).error).toBeUndefined();
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    try { expect(db.query("SELECT count(*) AS n FROM state_leases WHERE collection='pipelines'").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  } finally {
    console.log(`spawn workload pending for ${(performance.now() - start).toFixed(1)}ms`);
    release();
    await ticking;
    acquired.mockRestore(); released.mockRestore();
    console.log(`activation drain=${enabled}: max collection lease hold=${Math.max(...holds).toFixed(1)}ms, holds=${holds.length}`);
    /* Whether the lease spans the pending spawn is read from the lease table
       while the spawn is still pending, above; the hold times are reported,
       never asserted (#1761). */
    expect(holds.length).toBeGreaterThan(0);
    if (oldWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS; else process.env.LLV_PIPELINE_LOCK_WAIT_MS = oldWait;
    if (oldDrain === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = oldDrain;
  }
});

test("a dirty read-only stage parks without staging repository changes", async () => {
  const h = harness();
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => args[0] === "status"
    ? { code: 0, stdout: " M forbidden.ts\n", stderr: "" }
    : baseExec(command, args, cwd);
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("read-only stage plan modified");
  expect(h.calls.some((call) => call.includes("git add"))).toBe(false);
});

test("restart after a bare spawn reservation parks instead of waiting forever", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: "spawning",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-reserved",
    conversationId: "conversation_reserved",
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt: h.ports.now(),
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.cursor = { stageId: "plan", state: "spawning", input: null, activatedBy: null };
  h.ports.spawnReceipt = () => ({
    state: "starting",
    launchId: "launch-reserved",
    conversationId: "conversation_reserved",
    sessionId: null,
    "transcript": null,
    paneId: null,
  });
  savePipelines([pipeline]);

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("cannot recover from receipt state starting");
});

test("transient structured spawn handshakes retry twice before parking (#1056)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let spawnCalls = 0;
  const delays: number[] = [];
  h.ports.spawnAgent = async () => {
    spawnCalls += 1;
    throw new Error("runtime host request timed out");
  };
  Object.assign(h.ports, {
    sleep: async (milliseconds: number) => { delays.push(milliseconds); },
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(3);
  expect(delays).toEqual([1_000, 1_000]);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("runtime host request timed out");
  expect(parked.stateDetail).toContain("2 retries");
});
