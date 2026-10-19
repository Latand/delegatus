import { assertCpuReadGuardSurvivesSpyRestoration, startAutoAndSettle } from "./engineEnvironment.fixture";
import { expect, spyOn, test, crypto, spawn, fs, os, path, activeDrain, DRAIN_LEASE_MS, initialAuto, writeAuto, initialCheck, SelfUpdateService, idleCheck, accountManager, realExec, engineModule, defaultPipelinePorts, pipelineClaudePermissionMode, tickPipelines, AgentRegistry, setAgentRegistryForTests, newRound, tickFlow, saveFlows, createPipelineFromRequest, registerPipelineTick, loadPipelines, savePipelines, pipelineIdentity, patchPipeline, RUN_STAGES, ORIGIN_MAIN_SHA, entry, harness, REMOTE_BRANCH, finishReported, realWorktreeLane, successorOnPullRequestBranch, create, publishHarness, PUBLISH_STAGES } from "./engine.fixture";
import type { ServiceDeps, Snapshot, PipelinePorts } from "./engine.fixture";
import { shortId } from "@/lib/shortIds";


test("default pane liveness keeps failed or unreadable tmux observations alive", async () => {
  const observations: Awaited<ReturnType<typeof import("@/lib/tmux").panePidMap>>[] = [
    { kind: "failure", error: "tmux snapshot unavailable" },
    { kind: "available", panes: new Map([[42, { target: "stage:0.0", paneId: "%42", windowName: "stage" }]]) },
    { kind: "available", panes: new Map() },
    { kind: "no-server" },
  ];
  const freshReads: boolean[] = [];
  const ports = defaultPipelinePorts({ panes: {
    snapshot: async () => null,
    observation: async fresh => { freshReads.push(fresh!); return observations.shift()!; },
  } });
  expect(await ports.paneAgentAlive("%42")).toBe(true);
  expect(await ports.paneAgentAlive("%42")).toBe(true);
  expect(await ports.paneAgentAlive("%42")).toBe(false);
  expect(await ports.paneAgentAlive("%42")).toBe(false);
  expect(freshReads).toEqual([true, true, true, true]);
});

test("default pipeline projections reuse one registry parse across the historical backlog", () => {
  const registryPath = path.join(process.env.LLV_STATE_DIR!, "projection-cache-agent-registry.json");
  const registry = new AgentRegistry(registryPath);
  setAgentRegistryForTests(registry);
  const reads = spyOn(registry, "readOnlySnapshot");
  const fileReads = spyOn(fs, "readFileSync");
  try {
    const ports = defaultPipelinePorts();
    for (let index = 0; index < 300; index += 1) {
      expect(ports.pipelineAdoptionCandidates(`historical-${index}`)).toEqual([]);
      expect(ports.spawnReceipt(`missing-${index}`)).toBeNull();
      expect(ports.pathForConversation(`conversation_${index}`)).toBeNull();
      expect(ports.getFlow(`flow-${index}`)).toBeNull();
    }
    expect(reads).toHaveBeenCalledTimes(1);
    expect(fileReads.mock.calls.filter(([filename]) =>
      filename === path.join(process.env.LLV_STATE_DIR!, "flows.json"))).toHaveLength(1);
  } finally {
    fileReads.mockRestore();
    reads.mockRestore();
    setAgentRegistryForTests(null);
  }
});

test("the CPU sample guard survives projection reader restoration", () => {
  // Check identity first so a broken fixture fails without touching procfs.
  assertCpuReadGuardSurvivesSpyRestoration();
});

test("a pipeline stage keeps its reserved account through a routing change before settlement", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pipeline-account-pin-registry.json"));
  const cwd = process.env.LLV_STATE_DIR!;
  setAgentRegistryForTests(registry);
  const resolveSpawn = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "available",
    account: {
      engine: "codex",
      accountId: "limited",
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  }));
  const reservations: Array<{ launchId: string; conversationId: string }> = [];
  try {
    const ports = defaultPipelinePorts();
    await expect(ports.spawnAgent({
      role: {
        roleId: "builder",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        access: "read-write",
        promptScaffold: "Builder guidance",
      },
      runtimeProfile: { access: "read-write", sandbox: "full" },
      cwd,
      project: "repo-00000000000000000000000000000001",
      requestedAccountId: null,
      title: "Build scoped change · build",
      ["prompt"]: "Build the scoped change",
      parentPath: null,
      clientAttemptId: "pipeline_account_pin_attempt",
      membership: {
        kind: "pipeline",
        containerId: "pipeline-account-pin",
        role: "builder",
        slot: "build:1",
        stageId: "build",
        stageOrder: 0,
        round: 1,
        parentConversationId: null,
      },
      creatorConversationId: null,
    }, (created) => {
      reservations.push(created);
      registry.commitMigrationIntent({
        engine: "codex",
        targetId: "healthy",
        origin: "manual",
        requestId: "pipeline-routing-change",
        expectedRevision: registry.engineRouting("codex").revision,
      });
      throw new Error("reservation captured");
    })).rejects.toThrow("reservation captured");
    const reservation = reservations[0];
    if (!reservation) throw new Error("pipeline reservation was not captured");
    const receipt = registry.snapshot().receipts[reservation.launchId]!;
    const settled = registry.stageStructuredSpawn(receipt.launchId, {
      key: { engine: "codex", sessionId: crypto.randomUUID() },
      artifactPath: path.join(cwd, "pinned-pipeline-stage.jsonl"),
      cwd,
      accountId: "limited",
      launchProfile: receipt.launchProfile,
      status: "starting",
      host: null,
      structuredHost: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: "spawn",
    });
    if (settled.kind !== "settled") throw new Error("pipeline settlement conflicted");

    expect(settled.receipt).toMatchObject({
      accountId: "limited",
      accountPin: true,
      launchProfile: expect.objectContaining({ title: "Build scoped change · build" }),
    });
    expect(settled.conversation).toMatchObject({ pinnedAccountId: "limited", migration: null });
  } finally {
    resolveSpawn.mockRestore();
    setAgentRegistryForTests(null);
  }
});

test("an automatically selected Claude stage remains eligible for ordinary conversation migration", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "claude-stage-migration-registry.json"));
  setAgentRegistryForTests(registry);
  const resolveSpawn = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "available",
    account: {
      engine: "claude", accountId: "limited", kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
    },
  }));
  try {
    let launchId: string | null = null;
    await expect(defaultPipelinePorts().spawnAgent({
      role: {
        roleId: "builder", engine: "claude", model: "fable", effort: "high",
        access: "read-write", promptScaffold: "Builder guidance",
      },
      runtimeProfile: { access: "read-write", sandbox: "full" },
      cwd: process.env.LLV_STATE_DIR!, project: "repo-00000000000000000000000000000001",
      requestedAccountId: null, title: "Build scoped change · build", prompt: "Build",
      parentPath: null, clientAttemptId: "claude_stage_migratable",
      membership: {
        kind: "pipeline", containerId: "claude-stage", role: "builder", slot: "build:1",
        stageId: "build", stageOrder: 0, round: 1, parentConversationId: null,
      },
      creatorConversationId: null,
    }, (reserved) => {
      launchId = reserved.launchId;
      throw new Error("reservation captured");
    })).rejects.toThrow("reservation captured");
    expect(launchId).not.toBeNull();
    const receipt = registry.snapshot().receipts[launchId!]!;
    expect(receipt).toMatchObject({ engine: "claude", accountId: "limited", accountPin: false });
    const settled = registry.stageStructuredSpawn(receipt.launchId, {
      key: { engine: "claude", sessionId: crypto.randomUUID() },
      artifactPath: path.join(process.env.LLV_STATE_DIR!, "claude-stage-migratable.jsonl"),
      cwd: process.env.LLV_STATE_DIR!, accountId: "limited", launchProfile: receipt.launchProfile,
      status: "starting", host: null, structuredHost: null, claimEpoch: 0,
      claimOwner: null, pendingAction: "spawn",
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind === "settled") expect(settled.conversation.pinnedAccountId).toBeNull();
  } finally {
    resolveSpawn.mockRestore();
    setAgentRegistryForTests(null);
  }
});

test("a concurrent pipeline replay and its recovery projections withhold staged identity (#1123)", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pipeline-phantom-replay-registry.json"));
  const cwd = process.env.LLV_STATE_DIR!;
  const previousCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = path.join(cwd, "codex-mcp-fixture");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[{\"name\":\"viewer\"}]'\n");
  fs.chmodSync(codexBinary, 0o755);
  process.env.LLV_CODEX_BINARY = codexBinary;
  setAgentRegistryForTests(registry);
  const resolveSpawn = spyOn(accountManager, "resolveSpawn").mockImplementation(() => ({
    engine: "codex",
    accountId: "pipeline-account",
    kind: "managed",
    home: cwd,
    transcriptRoot: cwd,
    env: { NODE_ENV: "test" },
  }));
  const input: Parameters<PipelinePorts["spawnAgent"]>[0] = {
    role: {
      roleId: "builder",
      engine: "codex" as const,
      model: "gpt-5.6-sol",
      effort: "xhigh",
      access: "read-write" as const,
      promptScaffold: "Builder guidance",
    },
    runtimeProfile: { access: "read-write", sandbox: "full" },
    cwd,
    project: "repo-00000000000000000000000000000001",
    requestedAccountId: null,
    title: "Build scoped change",
    "prompt": "Build the scoped change",
    parentPath: null,
    clientAttemptId: "pipeline_phantom_replay_attempt",
    membership: {
      kind: "pipeline" as const,
      containerId: "pipeline-phantom-replay",
      role: "builder",
      slot: "build:1",
      stageId: "build",
      stageOrder: 0,
      round: 1,
      parentConversationId: null,
    },
    creatorConversationId: null,
  };
  const reservations: Array<{ launchId: string; conversationId: string }> = [];

  try {
    const ports = defaultPipelinePorts();
    await expect(ports.spawnAgent(input, (created) => {
      reservations.push(created);
      throw new Error("reservation captured");
    })).rejects.toThrow("reservation captured");
    const reservation = reservations[0];
    if (!reservation) throw new Error("pipeline reservation was not captured");
    const receipt = registry.snapshot().receipts[reservation.launchId]!;
    const stagedPath = path.join(cwd, "provisional-stage.jsonl");
    registry.stageStructuredSpawn(receipt.launchId, {
      key: { engine: "codex", sessionId: "provisional-session" },
      artifactPath: stagedPath,
      cwd,
      accountId: "pipeline-account",
      launchProfile: receipt.launchProfile,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:provisional-session",
        process: { pid: process.pid, startIdentity: "provisional-session-host" },
        eventCursor: 0,
        protocolVersion: null,
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "structured-host:provisional-session-host",
      pendingAction: "spawn",
    });
    const parent = registry.ensureConversation("codex", path.join(cwd, "parent.jsonl"), "pipeline-account");
    registry.rememberMembership(receipt.conversationId, {
      kind: "pipeline",
      containerId: "pipeline-phantom-replay",
      role: "builder",
      slot: "adopt:build:1",
      stageId: "build",
      stageOrder: 0,
      round: 1,
      parentConversationId: parent.id,
    });

    const replay = await ports.spawnAgent(input, () => {});
    expect(replay).toMatchObject({
      launchId: receipt.launchId,
      conversationId: receipt.conversationId,
      sessionId: null,
      "transcript": null,
    });
    expect(ports.spawnReceipt(receipt.launchId)).toMatchObject({
      sessionId: null,
      "transcript": null,
    });
    expect(ports.pathForConversation(receipt.conversationId)).toBeNull();
    expect(ports.conversationIdForPath(stagedPath)).toBeNull();
    expect(ports.pipelineAdoptionCandidates("pipeline-phantom-replay")).toEqual([]);

    registry.finalizeStructuredSpawn(receipt.launchId);
    const completedPorts = defaultPipelinePorts();
    expect(completedPorts.spawnReceipt(receipt.launchId)).toMatchObject({
      sessionId: "provisional-session",
      "transcript": stagedPath,
    });
    expect(completedPorts.pathForConversation(receipt.conversationId)).toBe(stagedPath);
    expect(completedPorts.conversationIdForPath(stagedPath)).toBe(receipt.conversationId);
    expect(completedPorts.pipelineAdoptionCandidates("pipeline-phantom-replay")).toEqual([
      expect.objectContaining({
        sessionId: "provisional-session",
        agentPath: stagedPath,
      }),
    ]);
  } finally {
    if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousCodexBinary;
    resolveSpawn.mockRestore();
    setAgentRegistryForTests(null);
  }
});

test("a staged resume cannot hide its already-published transcript (#1123)", () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pipeline-staged-resume-registry.json"));
  const cwd = process.env.LLV_STATE_DIR!;
  const sessionId = crypto.randomUUID();
  const transcript = path.join(cwd, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
  const conversation = registry.ensureConversation("codex", transcript, "pipeline-account");
  setAgentRegistryForTests(registry);

  try {
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd,
      transport: "structured",
      accountId: "pipeline-account",
      conversationId: conversation.id,
      purpose: "resume-successor",
      launchProfile: { title: "Resume published session" },
    });
    if (begun.kind !== "created") throw new Error("resume receipt was unavailable");
    const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId },
      artifactPath: transcript,
      cwd,
      accountId: "pipeline-account",
      launchProfile: begun.receipt.launchProfile,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: `stdio:${sessionId}`,
        process: { pid: process.pid, startIdentity: "staged-resume-host" },
        eventCursor: 0,
        protocolVersion: null,
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "structured-host:staged-resume-host",
      pendingAction: "spawn",
    });
    if (staged.kind !== "settled") throw new Error("resume staging conflicted");

    const ports = defaultPipelinePorts();
    expect(ports.spawnReceipt(begun.receipt.launchId)).toMatchObject({
      sessionId: null,
      "transcript": null,
    });
    expect(ports.pathForConversation(conversation.id)).toBe(transcript);
    expect(ports.conversationIdForPath(transcript)).toBe(conversation.id);
  } finally {
    setAgentRegistryForTests(null);
  }
});

test("Claude pipeline roles keep autonomous tool access under read-only scope fences", () => {
  expect(pipelineClaudePermissionMode({
    roleId: "architect",
    engine: "claude",
    model: "fable",
    effort: "high",
    access: "read-only",
    promptScaffold: "Read-only architecture contract",
  })).toBe("bypassPermissions");
  expect(pipelineClaudePermissionMode({
    roleId: "architect",
    engine: "claude",
    model: "fable",
    effort: "high",
    access: "read-only",
    promptScaffold: "Read-only architecture contract",
  }, "restricted")).toBe("auto");
  expect(pipelineClaudePermissionMode({
    roleId: "builder",
    engine: "claude",
    model: "fable",
    effort: "high",
    access: "read-write",
    promptScaffold: "Builder contract",
  })).toBe("bypassPermissions");
  expect(pipelineClaudePermissionMode({
    roleId: "reviewer",
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    access: "read-only",
    promptScaffold: "Reviewer contract",
  })).toBeNull();
});

test("a fixer head probe stays outside the controller lease and a pause fences its review admission", async () => {
  const fixture = await realWorktreeLane("fixer-head-pause", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let work: Promise<unknown> | undefined;
  try {
    const { h, git, worktree } = fixture;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "fixed\n");
    await git(worktree, "add", "fix.txt");
    await git(worktree, "commit", "-m", "fix handed findings");
    h.setConversationActive(false);
    h.messages.set("/codex/stage-1.jsonl", { text: 'Checked.\n```json\n{"status":"fail","findings":["P2 — discovery in fix.txt:1"]}\n```', ts: Date.now() + 100_000_000 });
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    let intercepted = false;
    work = tickPipelines([entry("/codex/stage-1.jsonl")], { ...h.ports, exec: async (...args) => {
      if (!intercepted && args[0] === "git" && args[1][0] === "status") {
        intercepted = true; entered(); await held;
      }
      return await h.ports.exec(...args);
    } });
    await checking;
    expect(loadPipelines()[0]!.state).toBe("running");
    const paused = await Promise.race([patchPipeline(fixture.id, { action: "pause" }, h.ports), Bun.sleep(150).then(() => null)]);
    expect(paused).not.toBeNull();
    release(); await work;
    const lane = loadPipelines()[0]!;
    expect(lane.state).toBe("paused");
    expect(lane.lastPassedCommit).toBe(fixture.base);
    expect(lane.runs[0]!.attempts[0]!.acceptedForReview).not.toBe(true);
    expect(h.spawnInputs).toHaveLength(1);
  } finally {
    release(); await work;
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a fixer self-fail persists its branch adoption before returning to the pipeline branch", async () => {
  const fixture = await realWorktreeLane("fixer-self-fail-adoption", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ], "remote-branch");
  try {
    const { h, git, id, worktree, origin } = fixture;
    const lane = loadPipelines().find((item) => item.id === id)!;
    const source = "fix/self-fail-adoption";
    fs.writeFileSync(path.join(worktree, "fix.txt"), "fixed\n");
    (await git(worktree, "add", "fix.txt"));
    (await git(worktree, "commit", "-m", "fix handed findings"));
    const head = (await git(worktree, "rev-parse", "HEAD"));
    const exec = h.ports.exec;
    let adoptionObserved = false;
    let checkedCleanWorktree = false;
    let checkedLaneBranch = false;
    let switched = false;
    h.ports.exec = async (command, args, ...rest) => {
      if (command === "git" && args[0] === "switch" && args.at(-1) === lane.branch) {
        const stored = loadPipelines().find((item) => item.id === id)!;
        expect(stored.runs[0]!.attempts[0]!).toMatchObject({
          state: "committing",
          acceptedForReview: true,
          verdict: { status: "fail" },
          branchAdoption: { branch: source, head, target: lane.branch },
        });
        expect(stored.lastPassedCommit).toBe(lane.lastPassedCommit);
        adoptionObserved = true;
      }
      const result = await exec(command, args, ...rest);
      if (command === "git" && !switched) {
        if (args[0] === "status" && args[1] === "--porcelain") checkedCleanWorktree = true;
        else if (checkedCleanWorktree && args[0] === "branch" && args[1] === "--show-current") checkedLaneBranch = true;
        else if (checkedLaneBranch && args[0] === "rev-parse" && args[1] === "HEAD") {
          // The agent changes checkout after the fixer's clean-head observation.
          (await git(worktree, "switch", "-c", source));
          switched = true;
        }
      }
      return result;
    };
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "Handed findings fixed; checks passed.")], h.ports);
    await tickPipelines([], h.ports);
    const current = loadPipelines().find((item) => item.id === id)!;
    expect(adoptionObserved).toBe(true);
    expect(current.cursor?.stageId).toBe("review");
    expect(current.lastPassedCommit).toBe(head);
    expect((await git(worktree, "branch", "--show-current"))).toBe(lane.branch);
    expect((await git(origin, "rev-parse", `refs/heads/${lane.branch}`))).toBe(head);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each(["Another issue noticed", "Users cannot save", "rejected publication", "historical red tests"])("a fixer self-fail with a committed head goes to review with its findings as notes: %s", async (finding) => {
  const fixture = await realWorktreeLane("fixer-self-fail", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review {{prev.output}}", next: null },
  ], "remote-branch");
  try {
    const { h, git, worktree, origin } = fixture;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "fixed\n");
    await git(worktree, "add", "fix.txt");
    await git(worktree, "commit", "-m", "fix handed findings");
    const fixed = await git(worktree, "rev-parse", "HEAD");
    const hook = path.join(origin, "hooks", "pre-receive");
    if (finding === "rejected publication") fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    h.setConversationActive(false);
    const summary = finding === "historical red tests" ? "Regression tests failed on base and passed on head. No blockers." : "Handed findings fixed; checks passed.";
    h.messages.set("/codex/stage-1.jsonl", { text: `${summary}\n\`\`\`json\n${JSON.stringify({ status: "fail", findings: [`P2 — ${finding} in fix.txt:1`] })}\n\`\`\``, ts: Date.now() + 100_000_000 });
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    await tickPipelines([], h.ports);
    if (finding === "rejected publication") {
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      fs.unlinkSync(hook);
      expect((await patchPipeline(fixture.id, { action: "publish" }, h.ports)).error).toBeUndefined();
      await tickPipelines([], h.ports);
      await tickPipelines([], h.ports);
    }
    const current = loadPipelines()[0]!;
    expect(current.state).toBe("running");
    expect(current.cursor?.stageId).toBe("review");
    expect(current.lastPassedCommit).toBe(fixed);
    expect(current.runs[0]!.attempts[0]!.verdict?.status).toBe("fail");
    expect(current.cursor?.input).toContain("Fixer notes for the reviewer");
    expect(current.cursor?.input).toContain(`${finding} in fix.txt:1`);
    expect(await git(origin, "rev-parse", `refs/heads/${current.branch}`)).toBe(fixed);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs.at(-1)?.prompt).toContain(`${finding} in fix.txt:1`);
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
    expect(loadPipelines()[0]!.state).toBe("completed");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});


test.each([
  { label: "unchanged head", commit: false, mode: "apply-fixes", summary: "Could not finish handed work", verdict: "fail" },
  { label: "blocked build after commit", commit: true, mode: "apply-fixes", summary: "Blocked: cannot build because a dependency is unavailable", verdict: "fail" },
  { label: "blocked checks after commit", commit: true, mode: "apply-fixes", summary: "Cannot run required checks because the service is unavailable", verdict: "fail" },
  { label: "impossible handed finding", commit: true, mode: "apply-fixes", summary: "A handed finding is impossible within the specification", verdict: "fail" },
  { label: "plain builder", commit: true, mode: "plain", summary: "Checks passed", verdict: "fail" },
  { label: "operator decision", commit: true, mode: "apply-fixes", summary: "Operator must choose the scope", verdict: "needs_decision" },
  { label: "report prose blocked", commit: true, mode: "apply-fixes", summary: "Blocked: cannot run required checks because the service is unavailable.", verdict: "fail" },
])("fixer safety net parks $label with its reason", async ({ label, commit, mode, summary, verdict }) => {
  const fixture = await realWorktreeLane("fixer-blocked", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ]);
  try {
    if (commit) {
      fs.writeFileSync(path.join(fixture.worktree, "fix.txt"), "partial fix\n");
      await fixture.git(fixture.worktree, "add", "fix.txt");
      await fixture.git(fixture.worktree, "commit", "-m", "partial fix");
    }
    fixture.h.setConversationActive(false);
    const shortSummary = "Committed partial fixes; remaining discovery listed";
    const blocked = ["blocked build after commit", "blocked checks after commit", "impossible handed finding", "report prose blocked"].includes(label);
    const blockFields = blocked ? { blocked: true, blockedReason: label } : {};
    if (label === "report prose blocked") {
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.report = {
        seq: 1, at: fixture.h.ports.now(), actor: { kind: "agent", role: "builder", conversationId: "conversation_stage_1" },
        verdict: { status: "fail", ...blockFields, findings: [`P2 — ${label} in fix.txt:1`] }, summary: shortSummary,
        provenance: { head: await fixture.git(fixture.worktree, "rev-parse", "HEAD"), branch: lane.branch, uncommitted: [], pullRequest: null, outputs: [] }, calls: 1,
      };
      savePipelines([lane]);
    }
    fixture.h.messages.set("/codex/stage-1.jsonl", { text: `${summary}\n\`\`\`json\n${JSON.stringify({ status: verdict, ...blockFields, findings: [`P1 — ${label}`] })}\n\`\`\``, ts: Date.now() + 100_000_000 });
    if (label === "report prose blocked") {
      const message = fixture.h.messages.get("/codex/stage-1.jsonl")!;
      fixture.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", lastRecordAt: message.ts, message });
    }
    await tickPipelines([entry("/codex/stage-1.jsonl")], fixture.h.ports);
    const current = loadPipelines()[0]!;
    expect(current.state).toBe("needs_decision");
    expect(current.lastPassedCommit).toBe(fixture.base);
    expect(current.stateDetail).toContain(label);
    expect(current.runs[0]!.attempts[0]!.output).toContain(label === "report prose blocked" ? shortSummary : summary);
    expect(fixture.h.spawnInputs).toHaveLength(1);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each([
  { label: "structured blocker", commit: true, blocked: true, summary: "Partial repairs committed.", findings: ["P2 — discovery in fix.txt:1"], review: false },
  { label: "plain fail", commit: true, blocked: undefined, summary: "Handed findings fixed.", findings: ["P2 — discovery in fix.txt:1"], review: true },
  { label: "fail without findings", commit: true, blocked: false, summary: "Handed findings fixed.", findings: [], review: true },
  { label: "no new head", commit: false, blocked: undefined, summary: "Could not finish handed work.", findings: ["P1 — remaining finding"], review: false },
  { label: "prose never classifies", commit: true, blocked: false, summary: "Blocked: tests failed; cannot build. Quoted historical evidence.", findings: ["P2 — discovery in fix.txt:1"], review: true },
  { label: "long output blocked", commit: true, blocked: true, summary: "Evidence.\n".repeat(5_000) + "Blocked: dependency unavailable.", findings: ["P2 — discovery in fix.txt:1"], review: false },
  { label: "long output plain fail", commit: true, blocked: undefined, summary: "Evidence.\n".repeat(5_000) + "Blocked: quoted historical evidence.", findings: ["P2 — discovery in fix.txt:1"], review: true },
].flatMap((scenario) => ["fenced verdict", "recorded report", "reported plus fenced completion"].map((settlement) => ({ ...scenario, settlement }))))("a fixer routes $label through $settlement using structured state", async ({ label, commit, blocked, summary, findings, review, settlement }) => {
  const fixture = await realWorktreeLane("fixer-structured-blocker", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review {{prev.output}}", next: null },
  ]);
  try {
    const { h, git, worktree } = fixture;
    if (commit) {
      fs.writeFileSync(path.join(worktree, "fix.txt"), "fixed\n");
      await git(worktree, "add", "fix.txt");
      await git(worktree, "commit", "-m", "fix handed findings");
    }
    const fixed = await git(worktree, "rev-parse", "HEAD");
    const blockedReason = "Required check service is unavailable";
    const verdict = { status: "fail" as const, findings,
      ...(blocked !== undefined ? { blocked } : {}), ...(blocked ? { blockedReason } : {}) };
    if (settlement !== "fenced verdict") {
      // Exercise the real report normalizer and the durable store. The report
      // owns structured state even when the final fenced verdict disagrees.
      const result = await engineModule.reportStageCompletion({
        verdict: "fail", findings: findings.map((text) => ({ severity: "P2", text: text.slice(5) })),
        summary: "Short relay summary", ...(blocked !== undefined ? { blocked } : {}), ...(blocked ? { blockedReason } : {}),
      }, { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, h.ports);
      expect(result.error).toBeUndefined();
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.report?.verdict).toMatchObject({
        ...(blocked !== undefined ? { blocked } : {}), ...(blocked ? { blockedReason } : {}),
      });
    }
    h.setConversationActive(false);
    const fencedVerdict = settlement === "reported plus fenced completion"
      ? { status: "fail", findings, blocked: !blocked, ...(!blocked ? { blockedReason: "Fenced state is superseded by report" } : {}) }
      : verdict;
    const transcriptVerdict = settlement !== "recorded report"
      ? `\n\`\`\`json\n${JSON.stringify(fencedVerdict)}\n\`\`\`` : "";
    h.messages.set("/codex/stage-1.jsonl", { text: `${summary}${transcriptVerdict}`, ts: Date.now() + 100_000_000 });
    if (settlement !== "fenced verdict") {
      const message = h.messages.get("/codex/stage-1.jsonl")!;
      h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", lastRecordAt: message.ts, message });
    }
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    await tickPipelines([], h.ports);
    const current = loadPipelines()[0]!;
    const attempt = current.runs[0]!.attempts[0]!;
    expect(attempt.verdict?.status).toBe("fail");
    if (blocked !== undefined) expect(attempt.verdict?.blocked).toBe(blocked);
    if (!review) {
      expect(current.state).toBe("needs_decision");
      expect(current.cursor?.stageId).toBe("fix");
      expect(current.lastPassedCommit).toBe(fixture.base);
      expect(attempt.acceptedForReview).toBeUndefined();
      if (blocked) {
        expect(current.stateDetail).toContain(blockedReason);
        expect(attempt.verdict?.blockedReason).toBe(blockedReason);
      }
      expect(h.spawnInputs).toHaveLength(1);
      if (label === "long output blocked" && settlement === "fenced verdict") {
        expect(attempt.output?.length).toBe(32_000);
        expect(attempt.output).not.toContain("Blocked:");
      }
      return;
    }
    expect(current.state).toBe("running");
    expect(current.cursor?.stageId).toBe("review");
    expect(current.lastPassedCommit).toBe(fixed);
    expect(attempt.acceptedForReview).toBe(true);
    expect(current.cursor?.input).toContain("Fixer notes for the reviewer");
    for (const finding of findings) expect(current.cursor?.input).toContain(finding.slice(5));
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a read-only successor settles and advances when its handoff is in a clean Git worktree", async () => {
  const fixture = await realWorktreeLane("readonly-stage-input-handoff", [
    { id: "design", kind: "run", role: { roleId: "architect" }, access: "read-only", prompt: "Design", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review {{prev.output}}", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null },
  ]);
  try {
    const { git, h, id, worktree } = fixture;
    const design = "Design head\n" + "d".repeat(45_000);
    const sourceIgnore = fs.readFileSync(path.join(fixture.repo, ".gitignore"), "utf8");
    h.setConversationActive(false);
    expect(await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "architect", conversationId: "conversation_stage_1" }, h.ports))
      .toMatchObject({ report: { verdict: { status: "pass" } } });
    await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", design)], h.ports);
    await tickPipelines([], h.ports);

    expect(h.spawnInputs).toHaveLength(2);
    const handoff = h.spawnInputs[1]!.prompt.match(/Full previous output file: (.+)\n/)?.[1];
    expect(handoff).toBeDefined();
    expect(path.isAbsolute(handoff!)).toBe(true);
    expect(fs.readFileSync(handoff!, "utf8")).toBe(design);
    expect(sourceIgnore).not.toContain(".artifacts/pipeline-stage-inputs");
    expect((await git(worktree, "status", "--porcelain"))).toBe("");

    expect(await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_2" }, h.ports))
      .toMatchObject({ report: { verdict: { status: "pass" } } });
    await tickPipelines([finishReported(h, "/codex/stage-2.jsonl", "pass", "Reviewed")], h.ports);
    await tickPipelines([], h.ports);

    expect(loadPipelines().find((pipeline) => pipeline.id === id)?.state).toBe("running");
    expect(h.spawnInputs).toHaveLength(3);
    expect(h.spawnInputs[2]!.prompt).toContain("Build");
    expect((await git(worktree, "status", "--porcelain"))).toBe("");
  } finally {
    if (fs.existsSync(fixture.root)) fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each(["before intent", "after intent"])("a paused lane fences async branch adoption (%s)", async (boundary) => {
  const fixture = await realWorktreeLane("stage-adoption-pause", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let work: Promise<unknown> | undefined;
  try {
    const { git, h, id, worktree } = fixture;
    const lane = loadPipelines().find((item) => item.id === id)!;
    const source = "fix/async-adoption";
    await git(worktree, "switch", "-c", source);
    fs.writeFileSync(path.join(worktree, "build.txt"), "preserved stage work\n");
    await git(worktree, "add", "build.txt");
    await git(worktree, "commit", "-m", "stage work");
    const head = await git(worktree, "rev-parse", "HEAD");
    const exec = h.ports.exec;
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    let intercepted = false;
    h.ports.exec = async (command, args, ...rest) => {
      const pauseAt = args[0] === "merge-base" && args.includes("--is-ancestor")
        && (boundary === "after intent"
          ? Boolean(loadPipelines().find((item) => item.id === id)?.runs[0]?.attempts[0]?.branchAdoption)
          : args.includes(head));
      if (!intercepted && command === "git" && pauseAt) {
        intercepted = true;
        entered();
        await held;
      }
      return await exec(command, args, ...rest);
    };
    h.setConversationActive(false);
    work = tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await checking;
    const current = loadPipelines().find((item) => item.id === id)!;
    if (boundary === "after intent") expect(current.runs[0]!.attempts[0]!.branchAdoption).toMatchObject({ branch: source, head });
    const paused = await Promise.race([patchPipeline(id, { action: "pause" }, h.ports), Bun.sleep(150).then(() => null)]);
    expect(paused).not.toBeNull();
    expect(paused?.error).toBeUndefined();
    release();
    await work;
    const settled = loadPipelines().find((item) => item.id === id)!;
    expect(settled.state).toBe("paused");
    expect(settled.lastPassedCommit).toBe(fixture.base);
    expect(settled.cursor?.stageId).toBe("build");
    expect(await git(worktree, "branch", "--show-current")).toBe(source);
    expect(await git(worktree, "rev-parse", `refs/heads/${lane.branch}`)).toBe(fixture.base);
    expect(h.spawnInputs).toHaveLength(1);
  } finally {
    release();
    await work;
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each(["source", "destination"])("async branch adoption rechecks a newly acquired %s claim before committing", async (claimed) => {
  const fixture = await realWorktreeLane(`stage-adoption-claim-${claimed}`, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null },
  ]);
  try {
    const { git, h, id, worktree } = fixture;
    const lane = loadPipelines().find((item) => item.id === id)!;
    const source = "fix/claimed-stage";
    await git(worktree, "switch", "-c", source);
    fs.writeFileSync(path.join(worktree, "uncommitted.txt"), "preserve stage work\n");
    const head = await git(worktree, "rev-parse", "HEAD");
    const others = [lane];
    const exec = h.ports.exec;
    let acquired = false;
    const { commitAndAdoptStageBranch } = await import("./stageBranch");
    const result = await commitAndAdoptStageBranch(lane, "build", async (command, args, ...rest) => {
      const result = await exec(command, args, ...rest);
      if (!acquired && command === "git" && args[0] === "symbolic-ref") {
        const owner = structuredClone(lane);
        owner.id = "new-owner";
        owner.branch = "pipeline/new-owner";
        owner.delivery = { ...lane.delivery!, active: true, ownerId: owner.id,
          target: { ...lane.delivery!.target, branch: `refs/heads/${claimed === "source" ? source : lane.branch}` } };
        others.push(owner);
        acquired = true;
      }
      return result;
    }, () => others, undefined, () => {}, { branch: source, head, error: null });
    expect(acquired).toBe(true);
    expect(result.ok).toBe(false);
    expect(await git(worktree, "rev-parse", `refs/heads/${source}`)).toBe(head);
    expect(await git(worktree, "rev-parse", `refs/heads/${lane.branch}`)).toBe(fixture.base);
    expect(await git(worktree, "status", "--porcelain")).toContain("uncommitted.txt");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a stage's fresh pushed branch and PR are adopted before the next stage", async () => {
  const fixture = await realWorktreeLane("stage-branch-adoption", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], "remote-branch");
  try {
    const { git, h, id, origin, worktree } = fixture;
    const lane = loadPipelines().find((item) => item.id === id)!;
    const stageBranch = "fix/stage-created";
    (await git(worktree, "switch", "-c", stageBranch));
    fs.writeFileSync(path.join(worktree, "build.txt"), "stage work\n");
    (await git(worktree, "add", "build.txt"));
    (await git(worktree, "commit", "-m", "stage work"));
    (await git(worktree, "push", "origin", stageBranch));
    const head = (await git(worktree, "rev-parse", "HEAD"));
    const exec = h.ports.exec;
    h.ports.exec = (command, args, ...rest) => command === "gh"
      ? { code: 0, stdout: JSON.stringify([{ url: "https://forge.example/repo/pull/7", number: 7, state: "OPEN" }]), stderr: "" }
      : exec(command, args, ...rest);
    h.setConversationActive(false);
    expect(await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, h.ports)).toMatchObject({ report: { verdict: { status: "pass" } } });
    await tickPipelines([finishReported(h, "/codex/stage-1.jsonl", "pass", "Built")], h.ports);
    const adopted = loadPipelines().find((item) => item.id === id)!;
    expect(adopted.state).toBe("running");
    expect(adopted.cursor?.stageId).toBe("review");
    expect(adopted.lastPassedCommit).toBe(head);
    expect((await git(worktree, "branch", "--show-current"))).toBe(lane.branch);
    expect((await git(origin, "rev-parse", `refs/heads/${lane.branch}`))).toBe(head);
    expect((await git(origin, "rev-parse", `refs/heads/${stageBranch}`))).toBe(head);
    expect(adopted.runs[0]!.attempts[0]!.report?.provenance).toMatchObject({ head, branch: stageBranch, pullRequest: { number: 7 } });
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(2);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const shape of ["unrelated", "owned", "owned-checkout", "owned-destination", "protected", "forge-protected-alias", "forge-protected-url", "read-only"] as const) {
  test(`a stage on a ${shape} branch still parks without changing either tip`, async () => {
    const fixture = await realWorktreeLane(`stage-branch-${shape}`, [
      { id: "build", kind: "run", role: { roleId: shape === "read-only" ? "reviewer" : "builder" }, access: shape === "read-only" ? "read-only" : "read-write", prompt: "Build", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
    ], "remote-branch");
    try {
      const { git, h, id, repo, worktree } = fixture;
      const lane = loadPipelines().find((item) => item.id === id)!;
      const branch = shape === "protected" ? "master" : "fix/other-stage";
      if (shape === "unrelated") (await git(worktree, "switch", "--orphan", branch));
      else (await git(worktree, "switch", "-c", branch));
      fs.writeFileSync(path.join(worktree, "build.txt"), "keep stage work\n");
      (await git(worktree, "add", "build.txt"));
      (await git(worktree, "commit", "-m", "stage work"));
      const tip = (await git(worktree, "rev-parse", "HEAD"));
      if (shape.startsWith("forge-protected")) {
        const forgeUrl = "https://github.com/fixture/repo.git";
        const exec = h.ports.exec;
        h.ports.exec = (command, args, ...rest) => command === "git" && args[0] === "remote" && args[1] === "get-url" && args[2] === "origin"
          ? { code: 0, stdout: forgeUrl, stderr: "" } : exec(command, args, ...rest);
        lane.delivery!.target.remote = shape === "forge-protected-url" ? forgeUrl : "origin";
        savePipelines([lane]);
        const remoteExec = h.ports.provisionExec!;
        h.ports.provisionExec = async (command, args, ...rest) => {
          if (command === "timeout" && args.includes("ls-remote")) return { code: 0, stdout: `${tip}\trefs/heads/${branch}\n`, stderr: "" };
          if (command === "timeout" && args.includes("gh")) {
            expect(args).toContain(`repos/fixture/repo/branches/${encodeURIComponent(branch)}`);
            // The forge check must hold no registry mutation lease.
            const { withPipelineMutation } = await import("./store");
            await withPipelineMutation(() => {});
            return { code: 0, stdout: "true\n", stderr: "" };
          }
          return remoteExec(command, args, ...rest);
        };
      }
      if (shape === "owned" || shape === "owned-checkout" || shape === "owned-destination") {
        const owner = structuredClone(lane);
        owner.id = "87654321";
        Object.assign(owner, pipelineIdentity(owner.id, owner.task, owner.repoDir));
        owner.delivery!.target.branch = `refs/heads/${branch}`;
        owner.delivery!.ownerId = owner.id;
        owner.state = "needs_decision";
        if (shape === "owned-checkout") {
          lane.delivery!.target.branch = `refs/heads/${branch}`;
          lane.delivery!.active = false;
          lane.delivery!.publish = "disabled";
          fs.writeFileSync(path.join(worktree, "uncommitted.txt"), "keep uncommitted stage work\n");
        }
        if (shape === "owned-destination") {
          const destination = "delivery/shared";
          (await git(worktree, "branch", "-m", lane.branch, destination));
          lane.delivery!.target.branch = `refs/heads/${destination}`;
          lane.delivery!.active = false;
          lane.delivery!.publish = "disabled";
          owner.delivery!.target.branch = `refs/heads/${destination}`;
        }
        savePipelines([lane, owner]);
      }
      await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
      const parked = loadPipelines().find((item) => item.id === id)!;
      expect(parked.state).toBe("needs_decision");
      expect(parked.cursor?.stageId).toBe("build");
      expect(parked.lastPassedCommit).toBe(lane.lastPassedCommit);
      expect((await git(repo, "rev-parse", shape === "owned-destination" ? "refs/heads/delivery/shared" : `refs/heads/${lane.branch}`))).toBe(lane.lastPassedCommit);
      expect((await git(worktree, "rev-parse", `refs/heads/${branch}`))).toBe(tip);
      if (shape === "unrelated") expect(parked.stateDetail).toContain("does not descend");
      if (shape === "owned" || shape === "owned-checkout") expect(parked.stateDetail).toContain("another pipeline owns");
      if (shape === "owned-destination") expect(parked.stateDetail).toContain("adoption destination");
      if (shape === "protected") expect(parked.stateDetail).toContain("protected base branch");
      if (shape.startsWith("forge-protected")) expect(parked.stateDetail).toContain("protected forge branch");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const interruptedAfterMerge of [false, true]) {
  test(`a restarted controller finishes its recorded branch adoption (after merge: ${interruptedAfterMerge})`, async () => {
    const fixture = await realWorktreeLane("stage-branch-restart", [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
    ], "remote-branch");
    try {
      const { git, h, id, origin, worktree } = fixture;
      const lane = loadPipelines().find((item) => item.id === id)!;
      const source = "fix/interrupted-stage";
      (await git(worktree, "switch", "-c", source));
      fs.writeFileSync(path.join(worktree, "build.txt"), "recover stage work\n");
      (await git(worktree, "add", "build.txt"));
      (await git(worktree, "commit", "-m", "stage work"));
      const head = (await git(worktree, "rev-parse", "HEAD"));
      const exec = h.ports.exec;
      h.ports.exec = async (command, args, ...rest) => {
        if (command === "git" && args[0] === "merge" && args.includes("--ff-only")) {
          if (interruptedAfterMerge) await exec(command, args, ...rest);
          throw new Error("fixture controller interruption");
        }
        return exec(command, args, ...rest);
      };
      await expect(tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports)).rejects.toThrow("fixture controller interruption");
      const interrupted = loadPipelines().find((item) => item.id === id)!;
      expect(interrupted.lastPassedCommit).toBe(lane.lastPassedCommit);
      expect(interrupted.runs[0]!.attempts[0]!.branchAdoption).toEqual({ branch: source, head, target: lane.branch });
      expect((await git(worktree, "branch", "--show-current"))).toBe(lane.branch);
      h.ports.exec = exec;
      await tickPipelines([], h.ports);
      const recovered = loadPipelines().find((item) => item.id === id)!;
      expect(recovered.state).toBe("running");
      expect(recovered.cursor?.stageId).toBe("review");
      expect(recovered.lastPassedCommit).toBe(head);
      expect((await git(origin, "rev-parse", `refs/heads/${lane.branch}`))).toBe(head);
      expect((await git(worktree, "show", "HEAD:build.txt"))).toBe("recover stage work");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("a stage branch is adopted onto an owned delivery branch when the lane ref is absent", async () => {
  const fixture = await realWorktreeLane("stage-branch-delivery-only", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ], "remote-branch");
  try {
    const { git, h, id, origin, worktree } = fixture;
    const lane = loadPipelines().find((item) => item.id === id)!;
    const delivery = "fix/existing-pr";
    (await git(worktree, "branch", "-m", delivery));
    lane.delivery!.target.branch = `refs/heads/${delivery}`;
    savePipelines([lane]);
    (await git(worktree, "switch", "-c", "fix/new-stage"));
    fs.writeFileSync(path.join(worktree, "build.txt"), "stage work\n");
    (await git(worktree, "add", "build.txt"));
    (await git(worktree, "commit", "-m", "stage work"));
    const head = (await git(worktree, "rev-parse", "HEAD"));
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const adopted = loadPipelines().find((item) => item.id === id)!;
    expect(adopted.state).toBe("running");
    expect(adopted.cursor?.stageId).toBe("review");
    expect(adopted.lastPassedCommit).toBe(head);
    expect((await git(worktree, "branch", "--show-current"))).toBe(delivery);
    expect((await git(origin, "rev-parse", `refs/heads/${delivery}`))).toBe(head);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const previousState of ["completed", "closed"] as const) {
  test(`a successor lane on a pull request branch settles its passed stage after a ${previousState} lane`, async () => {
    const fixture = await successorOnPullRequestBranch(`stage-branch-successor-${previousState}`, previousState);
    try {
      const { git, h, id, origin, worktree, prBranch, head } = fixture;
      await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
      const settled = loadPipelines().find((item) => item.id === id)!;
      expect(settled.stateDetail ?? null).toBeNull();
      expect(settled).toMatchObject({ state: "running", lastPassedCommit: head, cursor: { stageId: "review" } });
      expect((await git(worktree, "branch", "--show-current"))).toBe(prBranch);
      expect((await git(origin, "rev-parse", `refs/heads/${prBranch}`))).toBe(head);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const previousState of ["running", "needs_decision"] as const) {
  test(`a successor lane is refused the pull request branch while the previous lane is ${previousState}`, async () => {
    const fixture = await successorOnPullRequestBranch(`stage-branch-successor-${previousState}`, previousState);
    try {
      const { git, h, worktree, lane, previous, prBranch, head } = fixture;
      const { commitAndAdoptStageBranch } = await import("./stageBranch");
      const result = await commitAndAdoptStageBranch(lane, "build", h.ports.exec, () => [lane, previous], undefined, () => {}, null);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("another pipeline owns the stage branch") });
      expect((await git(worktree, "rev-parse", `refs/heads/${prBranch}`))).toBe(head);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("a terminal lane whose delivery claim is still active keeps owning its branch", async () => {
  const fixture = await successorOnPullRequestBranch("stage-branch-successor-terminal-active", "completed");
  try {
    const { h, lane, previous } = fixture;
    previous.delivery = { ...previous.delivery!, active: true, publish: "enabled" };
    const { commitAndAdoptStageBranch } = await import("./stageBranch");
    const result = await commitAndAdoptStageBranch(lane, "build", h.ports.exec, () => [lane, previous], undefined, () => {}, null);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("another pipeline owns the stage branch") });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const removeOwnerSeed of [false, true]) {
test(`linked-worktree pipeline ownership refuses a foreign stage branch before committing (removed seed: ${removeOwnerSeed})`, async () => {
  const fixture = await realWorktreeLane(`stage-branch-linked-owner-${removeOwnerSeed}`, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ]);
  try {
    const { git, h, id, root, worktree } = fixture;
    const lane = loadPipelines().find((item) => item.id === id)!;
    const source = "fix/other-lane-owned";
    (await git(worktree, "switch", "-c", source));
    fs.writeFileSync(path.join(worktree, "uncommitted.txt"), "keep this work\n");
    const sourceTip = (await git(worktree, "rev-parse", `refs/heads/${source}`));
    const laneTip = (await git(worktree, "rev-parse", `refs/heads/${lane.branch}`));
    const seed = path.join(root, "owner-seed");
    (await git(worktree, "worktree", "add", "-b", "owner-seed", seed, lane.branch));
    const linked = path.join(root, "linked");
    (await git(seed, "worktree", "add", "-b", "other-lane-current", linked));
    if (removeOwnerSeed) (await git(worktree, "worktree", "remove", seed));
    const other = structuredClone(lane);
    other.id = "other-pipeline";
    other.repoDir = removeOwnerSeed ? seed : linked;
    other.worktreeDir = linked;
    other.branch = source;
    const { commitAndAdoptStageBranch } = await import("./stageBranch");

    const result = await commitAndAdoptStageBranch(lane, "build", h.ports.exec, () => [lane, other], undefined, () => {}, null);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("another pipeline owns the stage branch") });
    expect((await git(worktree, "rev-parse", `refs/heads/${source}`))).toBe(sourceTip);
    expect((await git(worktree, "rev-parse", `refs/heads/${lane.branch}`))).toBe(laneTip);
    expect((await git(worktree, "status", "--porcelain"))).toContain("uncommitted.txt");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
}

test("a busy-to-terminal stage retries settlement after collecting fresh branch protection", async () => {
  const fixture = await realWorktreeLane("stage-branch-busy", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ], "remote-branch");
  try {
    const { git, h, id, worktree } = fixture;
    (await git(worktree, "switch", "-c", "fix/busy-stage"));
    expect(await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, h.ports)).toMatchObject({ report: { verdict: { status: "pass" } } });
    const finished = h.finish("/codex/stage-1.jsonl", "pass");
    h.durableTurns.set(finished.path, { turn: "busy", message: h.messages.get(finished.path)! });
    let activeReads = 0;
    h.ports.conversationAgentActive = async () => {
      if (activeReads++ === 0) {
        // The protection pre-pass already read `busy`; terminal evidence lands
        // while it checks liveness, before settlement reads the turn again.
        h.durableTurns.set(finished.path, { turn: "terminal", message: h.messages.get(finished.path)! });
        return true;
      }
      return false;
    };
    await tickPipelines([finished], h.ports);
    const deferred = loadPipelines().find((item) => item.id === id)!;
    expect(deferred).toMatchObject({ state: "running", cursor: { stageId: "build", state: "committing" } });
    expect(deferred.runs[0]!.attempts[0]!.state).toBe("committing");
    const stageTip = (await git(worktree, "rev-parse", "refs/heads/fix/busy-stage"));
    h.ports.conversationAgentActive = async () => false;
    await tickPipelines([], h.ports);
    const adopted = loadPipelines().find((item) => item.id === id)!;
    expect(adopted).toMatchObject({ state: "running", cursor: { stageId: "review", state: "pending" } });
    expect(adopted.lastPassedCommit).toBe(stageTip);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a stage branch is adopted from durable terminal evidence before the scanner projects it", async () => {
  const fixture = await realWorktreeLane("stage-branch-durable-fallback", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ], "remote-branch");
  try {
    const { git, h, id, worktree } = fixture;
    (await git(worktree, "switch", "-c", "fix/durable-stage"));
    fs.writeFileSync(path.join(worktree, "build.txt"), "durable stage work\n");
    (await git(worktree, "add", "build.txt"));
    (await git(worktree, "commit", "-m", "stage work"));
    const head = (await git(worktree, "rev-parse", "HEAD"));
    finishReported(h, "/codex/stage-1.jsonl", "pass", "Built");
    await tickPipelines([], h.ports);
    expect(loadPipelines().find((item) => item.id === id)).toMatchObject({ state: "running", lastPassedCommit: head, cursor: { stageId: "review" } });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const interruption of [null, "before-ref", "after-ref"] as const) {
  test(`a divergent stage branch retaining accepted content is adopted without moving its source (${interruption ?? "uninterrupted"})`, async () => {
    const fixture = await realWorktreeLane("stage-branch-divergent", [
      { id: "brief", kind: "run", role: { roleId: "builder" }, prompt: "Brief", next: "build" },
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
    ], "remote-branch");
    try {
      const { git, h, id, base, origin, worktree } = fixture;
      fs.writeFileSync(path.join(worktree, "accepted.txt"), "accepted work\n");
      await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
      const lane = loadPipelines().find((item) => item.id === id)!;
      await tickPipelines([], h.ports);
      const source = "fix/divergent-stage";
      (await git(worktree, "switch", "-c", source, base));
      fs.writeFileSync(path.join(worktree, "accepted.txt"), "accepted work\n");
      (await git(worktree, "add", "accepted.txt"));
      (await git(worktree, "commit", "-m", "retain accepted work with fresh history"));
      fs.writeFileSync(path.join(worktree, "build.txt"), "stage work\n");
      (await git(worktree, "add", "build.txt"));
      (await git(worktree, "commit", "-m", "stage work"));
      (await git(worktree, "push", "origin", source));
      const head = (await git(worktree, "rev-parse", "HEAD"));
      const exec = h.ports.exec;
      if (interruption) h.ports.exec = async (command, args, ...rest) => {
        if (command === "git" && args[0] === "update-ref" && args.includes("pipeline: reconcile rebased stage")) {
          if (interruption === "after-ref") await exec(command, args, ...rest);
          throw new Error("fixture reconciliation interruption");
        }
        return exec(command, args, ...rest);
      };
      const finish = tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
      if (interruption) {
        await expect(finish).rejects.toThrow("fixture reconciliation interruption");
        expect(loadPipelines().find((item) => item.id === id)!.runs[1]!.attempts[0]!.branchAdoption).toMatchObject({ branch: source, head });
        h.ports.exec = exec;
        await tickPipelines([], h.ports);
      } else await finish;
      const adopted = loadPipelines().find((item) => item.id === id)!;
      expect(adopted.state).toBe("running");
      expect(adopted.cursor?.stageId).toBe("review");
      expect((await git(worktree, "rev-parse", "HEAD"))).toBe(adopted.lastPassedCommit);
      expect((await git(worktree, "merge-base", lane.lastPassedCommit, adopted.lastPassedCommit))).toBe(lane.lastPassedCommit);
      expect((await git(worktree, "merge-base", head, adopted.lastPassedCommit))).toBe(head);
      expect((await git(worktree, "rev-parse", `refs/heads/${source}`))).toBe(head);
      expect((await git(origin, "rev-parse", `refs/heads/${source}`))).toBe(head);
      expect((await git(origin, "rev-parse", `refs/heads/${lane.branch}`))).toBe(adopted.lastPassedCommit);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("a rebased builder reconciles accepted content and continues with fast-forward delivery", async () => {
  const fixture = await realWorktreeLane("rebase-reconcile", [
    { id: "brief", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Brief", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], undefined, false, true);
  try {
    const { git, h, id, repo, origin, worktree } = fixture;
    h.setConversationActive(false);
    fs.writeFileSync(path.join(worktree, ".gitignore"), "accepted-rule\n");
    fs.writeFileSync(path.join(worktree, "brief.md"), "accepted brief\n");
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const accepted = loadPipelines().find((item) => item.id === id)!.lastPassedCommit;
    const branch = loadPipelines().find((item) => item.id === id)!.branch;
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(accepted);
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(repo, "main.txt"), "new main\n");
    fs.writeFileSync(path.join(repo, "asset.bin"), crypto.randomBytes(1_200_000));
    (await git(repo, "add", "main.txt"));
    (await git(repo, "add", "asset.bin"));
    (await git(repo, "commit", "-m", "advance main"));
    (await git(repo, "push", "origin", "main"));
    (await git(worktree, "rebase", "origin/main"));
    fs.appendFileSync(path.join(worktree, ".gitignore"), "builder-rule\n");
    fs.appendFileSync(path.join(worktree, "brief.md"), "builder elaboration\n");
    fs.writeFileSync(path.join(worktree, "build.txt"), "builder content\n");
    (await git(worktree, "add", ".gitignore", "brief.md", "build.txt"));
    (await git(worktree, "commit", "-m", "build after rebase"));
    const rebased = (await git(worktree, "rev-parse", "HEAD"));
    const tree = (await git(worktree, "rev-parse", "HEAD^{tree}"));

    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);

    const current = loadPipelines().find((item) => item.id === id)!;
    expect(current.state).toBe("running");
    expect(current.cursor?.stageId).toBe("review");
    const reconciled = current.lastPassedCommit;
    expect((await git(worktree, "rev-parse", `${reconciled}^{tree}`))).toBe(tree);
    expect((await git(worktree, "rev-list", "--parents", "-n", "1", reconciled))).toBe(`${reconciled} ${rebased} ${accepted}`);
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(reconciled);
    expect(current.publishedCommit).toBe(reconciled);
    for (let n = 0; n < 4 && h.spawnInputs.length < 3; n += 1) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(3);
    await tickPipelines([h.finish("/codex/stage-3.jsonl", "pass")], h.ports);
    expect(loadPipelines().find((item) => item.id === id)!.state).toBe("completed");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each(["fenced verdict", "reported plus fenced completion"])("a fixer preserves an explicit current blocker when another check passed on head (%s)", async (settlement) => {
  const fixture = await realWorktreeLane("fixer-current-blocker", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ]);
  try {
    const { h, git, worktree, base } = fixture;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "fix committed\n");
    await git(worktree, "add", "fix.txt");
    await git(worktree, "commit", "-m", "committed partial fix");
    const lane = loadPipelines()[0]!;
    if (settlement === "reported plus fenced completion") {
      lane.runs[0]!.attempts[0]!.report = {
        seq: 1,
        at: h.ports.now(),
        actor: { kind: "agent", role: "builder", conversationId: "conversation_stage_1" },
        verdict: { status: "fail", blocked: true, blockedReason: "Required integration checks are unavailable", findings: ["P2 — unresolved integration failure"] },
        summary: "Blocked: required integration tests failed on base and still fail on head. TypeScript passed on head.",
        provenance: { head: await git(worktree, "rev-parse", "HEAD"), branch: lane.branch, uncommitted: [], pullRequest: null, outputs: [] },
        calls: 1,
      };
      savePipelines([lane]);
    }
    h.setConversationActive(false);
    const summary = "Blocked: required integration tests failed on base and still fail on head. TypeScript passed on head.";
    const verdict = `\n\`\`\`json\n${JSON.stringify({ status: "fail", blocked: true, blockedReason: "Required integration checks are unavailable", findings: ["P2 — unresolved integration failure"] })}\n\`\`\``;
    h.messages.set("/codex/stage-1.jsonl", { text: `${summary}${verdict}`, ts: Date.now() + 100_000_000 });
    if (settlement === "reported plus fenced completion") {
      const message = h.messages.get("/codex/stage-1.jsonl")!;
      h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", lastRecordAt: message.ts, message });
    }
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    const current = loadPipelines()[0]!;
    expect(current.state).toBe("needs_decision");
    expect(current.cursor?.stageId).toBe("fix");
    expect(current.lastPassedCommit).toBe(base);
    expect(current.runs[0]!.attempts[0]!.output).toContain("Blocked: required integration tests");
    expect(h.spawnInputs).toHaveLength(1);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a fenced fixer verdict keeps a blocker after the bounded relay output", async () => {
  const fixture = await realWorktreeLane("fixer-blocker-after-relay-limit", [
    { id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review {{prev.output}}", next: null },
  ]);
  try {
    const { h, git, worktree, base } = fixture;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "fix committed\n");
    await git(worktree, "add", "fix.txt");
    await git(worktree, "commit", "-m", "committed partial fix");
    const summary = `${"Verification details recorded. ".repeat(1200)}Blocked: cannot run required integration checks.`;
    h.setConversationActive(false);
    h.messages.set("/codex/stage-1.jsonl", {
      text: `${summary}\n\`\`\`json\n${JSON.stringify({ status: "fail", blocked: true, blockedReason: "Required integration checks are unavailable", findings: ["P2 — unresolved integration failure"] })}\n\`\`\``,
      ts: Date.now() + 100_000_000,
    });
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    const current = loadPipelines()[0]!;
    expect(current.state).toBe("needs_decision");
    expect(current.cursor?.stageId).toBe("fix");
    expect(current.lastPassedCommit).toBe(base);
    expect(current.cursor?.stageId).not.toBe("review");
    expect(h.spawnInputs).toHaveLength(1);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rewritten builder history parks with the dropped accepted commit and preserves delivery", async () => {
  const fixture = await realWorktreeLane("rebase-dropped", [
    { id: "brief", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Brief", next: "build" },
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null },
  ], undefined, false, true);
  try {
    const { git, h, id, repo, origin, worktree } = fixture;
    h.setConversationActive(false);
    fs.writeFileSync(path.join(worktree, "dropped.md"), "accepted content\n");
    (await git(worktree, "add", "dropped.md"));
    (await git(worktree, "commit", "-m", "accepted requirement"));
    const dropped = (await git(worktree, "rev-parse", "HEAD"));
    fs.writeFileSync(path.join(worktree, "kept.md"), "kept content\n");
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const accepted = loadPipelines().find((item) => item.id === id)!.lastPassedCommit;
    const branch = loadPipelines().find((item) => item.id === id)!.branch;
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(repo, "main.txt"), "new main\n");
    (await git(repo, "add", "main.txt"));
    (await git(repo, "commit", "-m", "advance main"));
    (await git(repo, "push", "origin", "main"));
    (await git(worktree, "rebase", "--onto", "origin/main", dropped));
    const rewritten = (await git(worktree, "rev-parse", "HEAD"));

    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);

    const parked = loadPipelines().find((item) => item.id === id)!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("dropped accepted commits");
    expect(parked.stateDetail).toContain(shortId(dropped));
    expect(parked.stateDetail).not.toContain(`dropped accepted commits: ${accepted}`);
    expect(parked.lastPassedCommit).toBe(accepted);
    expect((await git(worktree, "rev-parse", "HEAD"))).toBe(rewritten);
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(accepted);
    expect(h.spawnInputs).toHaveLength(2);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an owner publishes a review-fix commit before the passing review starts", async () => {
  const fixture = await realWorktreeLane("owner-review-fix", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null, onFail: { to: "review-fix", maxRounds: 2 } },
    { id: "review-fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix", next: "review" },
  ], undefined, false, true);
  try {
    const { git, h, id, origin, worktree } = fixture;
    const branch = loadPipelines().find((item) => item.id === id)!.branch;
    h.setConversationActive(false);
    fs.writeFileSync(path.join(worktree, "work.txt"), "build\n");
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const built = (await git(worktree, "rev-parse", "HEAD"));
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(built);
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(2);
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail")], h.ports);
    for (let n = 0; n < 4 && h.spawnInputs.length < 3; n += 1) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(3);
    fs.writeFileSync(path.join(worktree, "work.txt"), "fixed\n");
    const offline = `${origin}.offline`;
    fs.renameSync(origin, offline);
    await tickPipelines([h.finish("/codex/stage-3.jsonl", "pass")], h.ports);
    const fixed = (await git(worktree, "rev-parse", "HEAD"));
    expect(fixed).not.toBe(built);
    expect(loadPipelines().find((item) => item.id === id)).toMatchObject({
      state: "running", cursor: { stageId: "review-fix", state: "committing" }, lastPassedCommit: fixed,
    });
    expect(h.spawnInputs).toHaveLength(3);
    fs.renameSync(offline, origin);
    await tickPipelines([], h.ports);
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(fixed);
    for (let n = 0; n < 4 && h.spawnInputs.length < 4; n += 1) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(4);
    await tickPipelines([h.finish("/codex/stage-4.jsonl", "pass")], h.ports);
    const completed = loadPipelines().find((item) => item.id === id)!;
    expect(completed).toMatchObject({ state: "completed", lastPassedCommit: fixed, publishedCommit: fixed });
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(completed.lastPassedCommit);
  } finally {
    savePipelines([]);
    if (fs.existsSync(`${fixture.origin}.offline`)) fs.renameSync(`${fixture.origin}.offline`, fixture.origin);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an owner keeps a terminal read-only declared output local after publishing its builder head", async () => {
  const fixture = await realWorktreeLane("owner-review-output", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", outputs: ["review.md"], prompt: "Review", next: null },
  ], undefined, false, true);
  try {
    const { git, h, id, origin, worktree } = fixture;
    const branch = loadPipelines().find((item) => item.id === id)!.branch;
    h.setConversationActive(false);
    fs.writeFileSync(path.join(worktree, "work.txt"), "build\n");
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    const built = (await git(origin, "rev-parse", `refs/heads/${branch}`));
    for (let n = 0; n < 4 && h.spawnInputs.length < 2; n += 1) await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(worktree, "review.md"), "approved\n");
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
    const completed = loadPipelines().find((item) => item.id === id)!;
    expect(completed.state).toBe("completed");
    expect(completed.lastPassedCommit).not.toBe(built);
    expect(completed.publishedCommit).toBe(built);
    expect((await git(origin, "rev-parse", `refs/heads/${branch}`))).toBe(built);
    expect(completed.runs[1]!.attempts[0]!.outputBaseHead).toBe(built);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("skip carries a committed fix into review and completion without touching ignored work", async () => {
  const fixture = await realWorktreeLane("skip-keeps-fix", [
    { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ]);
  try {
    const { h, git, worktree, id, base } = fixture;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "accepted fix\n");
    fs.writeFileSync(path.join(worktree, "sentinel.tmp"), "untouched\n");
    (await git(worktree, "add", "fix.txt"));
    (await git(worktree, "commit", "-m", "fix B"));
    const fixed = (await git(worktree, "rev-parse", "HEAD"));
    expect(fixed).not.toBe(base);
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision")], h.ports);
    expect(loadPipelines().find((item) => item.id === id)!.state).toBe("needs_decision");
    expect((await patchPipeline(id, { action: "skip-stage" }, h.ports)).error).toBeUndefined();
    expect(loadPipelines().find((item) => item.id === id)!).toMatchObject({
      lastPassedCommit: fixed, cursor: { stageId: "review", state: "pending" },
    });
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(2);
    expect((await git(worktree, "rev-parse", "HEAD"))).toBe(fixed);
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
    expect(loadPipelines().find((item) => item.id === id)!).toMatchObject({ state: "completed", lastPassedCommit: fixed, cursor: null });
    expect(fs.readFileSync(path.join(worktree, "sentinel.tmp"), "utf8")).toBe("untouched\n");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("remote skip publishes the accepted head before its reviewer can start", async () => {
  const fixture = await realWorktreeLane("remote-skip", [
    { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], "remote-branch");
  try {
    fs.writeFileSync(path.join(fixture.worktree, "fix.txt"), "accepted\n");
    (await fixture.git(fixture.worktree, "add", "fix.txt"));
    (await fixture.git(fixture.worktree, "commit", "-m", "accepted fix"));
    const accepted = (await fixture.git(fixture.worktree, "rev-parse", "HEAD"));
    fixture.h.setConversationActive(false);
    await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", "needs_decision")], fixture.h.ports);
    expect((await patchPipeline(fixture.id, { action: "skip-stage" }, fixture.h.ports)).error).toBeUndefined();
    const waiting = loadPipelines().find((item) => item.id === fixture.id)!;
    expect(waiting).toMatchObject({ lastPassedCommit: accepted, cursor: { stageId: "fix", state: "committing" } });
    expect(waiting.runs[0]!.attempts[0]!.state).toBe("skipped");
    expect(fixture.h.spawnInputs).toHaveLength(1);
    expect(waiting.delivery!.operation!.state).toBe("pending");
    await tickPipelines([], fixture.h.ports);
    expect((await fixture.git(fixture.origin, "rev-parse", `refs/heads/${waiting.branch}`))).toBe(accepted);
    expect(loadPipelines().find((item) => item.id === fixture.id)!.cursor?.stageId).toBe("review");
    await tickPipelines([], fixture.h.ports);
    expect(fixture.h.spawnInputs).toHaveLength(2);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const completion of ["pass", "skip"] as const) {
  test(`an unreachable remote keeps a ${completion} successor behind the accepted head`, async () => {
    const fixture = await realWorktreeLane(`remote-${completion}-outage`, [
      { id: "fix", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Fix", next: "review" },
      { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
    ], "remote-branch");
    const offline = `${fixture.origin}.offline`;
    try {
      fs.writeFileSync(path.join(fixture.worktree, "fix.txt"), "accepted\n");
      if (completion === "skip") {
        (await fixture.git(fixture.worktree, "add", "fix.txt"));
        (await fixture.git(fixture.worktree, "commit", "-m", "accepted fix"));
      }
      fixture.h.setConversationActive(false);
      fs.renameSync(fixture.origin, offline);
      await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", completion === "pass" ? "pass" : "needs_decision")], fixture.h.ports);
      if (completion === "skip") {
        expect((await patchPipeline(fixture.id, { action: "skip-stage" }, fixture.h.ports)).error).toBeUndefined();
      }
      await tickPipelines([], fixture.h.ports);
      const waiting = loadPipelines().find((item) => item.id === fixture.id)!;
      const accepted = (await fixture.git(fixture.worktree, "rev-parse", "HEAD"));
      expect(waiting.lastPassedCommit).toBe(accepted);
      expect(waiting.publishedCommit).toBeNull();
      expect(waiting.cursor).toMatchObject({ stageId: "fix", state: "committing" });
      expect(fixture.h.spawnInputs).toHaveLength(1);
      fs.renameSync(offline, fixture.origin);
      await tickPipelines([], fixture.h.ports);
      await tickPipelines([], fixture.h.ports);
      expect((await fixture.git(fixture.origin, "rev-parse", `refs/heads/${waiting.branch}`))).toBe(accepted);
      expect(fixture.h.spawnInputs).toHaveLength(2);
    } finally {
      savePipelines([]);
      if (fs.existsSync(offline)) fs.renameSync(offline, fixture.origin);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("ordinary retry leaves dirty work for the next attempt", async () => {
  const fixture = await realWorktreeLane("retry-keeps-dirty", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null },
  ]);
  try {
    fs.writeFileSync(path.join(fixture.worktree, "draft.txt"), "unfinished\n");
    fixture.h.setConversationActive(false);
    await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", "fail")], fixture.h.ports);
    expect((await patchPipeline(fixture.id, { action: "retry-stage" }, fixture.h.ports)).error).toBeUndefined();
    expect(fs.readFileSync(path.join(fixture.worktree, "draft.txt"), "utf8")).toBe("unfinished\n");
    await tickPipelines([], fixture.h.ports);
    expect(fixture.h.spawnInputs).toHaveLength(2);
    expect((await fixture.git(fixture.worktree, "rev-parse", "HEAD"))).toBe(fixture.base);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a read-only architect pass commits its declared fix output through settlement", async () => {
  const fixture = await realWorktreeLane("architect-output", [
    { id: "fix", kind: "run", role: { roleId: "architect" }, access: "read-only", outputs: ["reports/fix.md"], prompt: "Write the fix", next: null },
  ]);
  try {
    fs.mkdirSync(path.join(fixture.worktree, "reports"));
    fs.writeFileSync(path.join(fixture.worktree, "reports", "fix.md"), "declared result\n");
    fs.writeFileSync(path.join(fixture.worktree, "sentinel.tmp"), "untouched\n");
    fixture.h.setConversationActive(false);
    await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", "pass")], fixture.h.ports);
    const current = loadPipelines().find((item) => item.id === fixture.id)!;
    expect(current.state).toBe("completed");
    expect(current.lastPassedCommit).not.toBe(fixture.base);
    expect((await fixture.git(fixture.worktree, "show", "--name-only", "--format=", "HEAD"))).toBe("reports/fix.md");
    expect(fs.readFileSync(path.join(fixture.worktree, "sentinel.tmp"), "utf8")).toBe("untouched\n");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fallback verdict preserves the pre-output PR head through real settlement and merge", async () => {
  const fixture = await realWorktreeLane("fallback-output-merge", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "critique" },
    { id: "critique", kind: "run", role: { roleId: "reviewer" }, access: "read-only", outputs: ["report.md"], prompt: "Review", next: null, onFail: { to: "build", maxRounds: 2 } },
  ]);
  try {
    const { git, h, id, worktree } = fixture;
    const admitted = loadPipelines().find((item) => item.id === id)!;
    admitted.delivery = {
      target: { repository: "acme/widgets", remote: "https://github.com/acme/widgets.git", branch: `refs/heads/${admitted.branch}`, pr: 11 },
      disposition: "owner", publish: "disabled", ownerId: id, epoch: 1, active: false, journal: [],
    };
    savePipelines([admitted]);
    fs.writeFileSync(path.join(worktree, "build.txt"), "accepted build\n");
    (await git(worktree, "add", "build.txt"));
    (await git(worktree, "commit", "-m", "accepted build"));
    const prHead = (await git(worktree, "rev-parse", "HEAD"));
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(worktree, "report.md"), "review passed\n");
    await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
    const completed = loadPipelines().find((item) => item.id === id)!;
    expect(completed.state).toBe("completed");
    expect(completed.lastPassedCommit).not.toBe(prHead);
    expect(completed.runs[1]!.attempts[0]!.report).toBeUndefined();
    expect(completed.runs[1]!.attempts[0]!.outputBaseHead).toBe(prHead);
    savePipelines([completed]);
    expect(loadPipelines().find((item) => item.id === id)!.runs[1]!.attempts[0]!.outputBaseHead).toBe(prHead);

    const { productionAutoMergePorts, MERGE_POLL_MS, MERGE_SETTLE_MS, MERGE_REASONS, lanePullRequest, mergeEligible, sweepAutoMerge } = await import("@/lib/forge/autoMerge");
    expect(mergeEligible(loadPipelines().find((item) => item.id === id)!)).toBe(true);
    expect(lanePullRequest(loadPipelines().find((item) => item.id === id)!)).toEqual({ repository: "acme/widgets", number: 11 });
    let clock = Date.parse(completed.closedAt!) + 1_000;
    let merged = false;
    const calls: string[][] = [];
    const ports = productionAutoMergePorts({
      now: () => clock,
      loadPipelines,
      setting: () => ({ enabled: true, changedAt: new Date(0).toISOString(), changedBy: "operator" }),
      cachedState: () => null,
      log: () => undefined,
      run: async (args) => {
        calls.push(args);
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
          state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: prHead, baseRefName: "main",
          mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: completed.closedAt }],
          mergeCommit: merged ? { oid: "f".repeat(40) } : null, mergedAt: merged ? new Date(clock).toISOString() : null,
        });
        if (args[0] === "api" && args[1] === "repos/acme/widgets/branches/main") return "[]";
        if (args[0] === "api" && args[1] === "repos/acme/widgets/pulls/11/reviews?per_page=100") return "";
        if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
        if (args[0] === "pr" && args[1] === "merge") { merged = true; return ""; }
        throw new Error(`unexpected gh ${args.join(" ")}`);
      },
    });
    /* The fake `gh` above stands in for the App write seam as well: no token is minted. */
    ports.write = (args) => ports.run(args);
    for (let poll = 0; poll < Math.ceil(MERGE_SETTLE_MS / MERGE_POLL_MS) + 3; poll += 1) {
      await sweepAutoMerge(ports);
      clock += MERGE_POLL_MS;
    }
    const settled = loadPipelines().find((item) => item.id === id)!;
    expect(settled.merge?.reason).not.toBe(MERGE_REASONS.headChanged);
    expect(settled.merge?.state).toBe("merged");
    expect(settled.merge?.chain).toEqual([prHead]);
    expect(calls.filter((args) => args[0] === "pr" && args[1] === "merge")).toHaveLength(1);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a skipped legacy architect publishes its declared output to the review flow", async () => {
  const fixture = await realWorktreeLane("legacy-architect-skip-review", [
    { id: "architect", kind: "run", role: { roleId: "architect" }, access: "read-only", outputs: ["fix.txt"], prompt: "Write fix", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review fix", next: null },
  ], "remote-branch", true);
  try {
    const { git, h, id, origin, worktree } = fixture;
    expect(loadPipelines().find((item) => item.id === id)!.stages[1]!.kind).toBe("review-loop");
    fs.writeFileSync(path.join(worktree, "fix.txt"), "accepted fix\n");
    fs.writeFileSync(path.join(worktree, "sentinel.tmp"), "untouched\n");
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision")], h.ports);
    expect((await patchPipeline(id, { action: "skip-stage" }, h.ports)).error).toBeUndefined();
    await tickPipelines([], h.ports);
    const skipped = loadPipelines().find((item) => item.id === id)!;
    const accepted = (await git(worktree, "rev-parse", "HEAD"));
    expect(accepted).not.toBe(fixture.base);
    expect(skipped).toMatchObject({ lastPassedCommit: accepted, cursor: { stageId: "review" } });
    expect(skipped.runs[0]!.attempts[0]!.state).toBe("skipped");
    expect((await git(worktree, "show", "--name-only", "--format=", "HEAD"))).toBe("fix.txt");
    expect((await git(origin, "rev-parse", `refs/heads/${skipped.branch}`))).toBe(accepted);
    await tickPipelines([], h.ports);
    const review = loadPipelines().find((item) => item.id === id)!;
    expect(review.state).toBe("running");
    expect(review.runs[1]!.attempts[0]).toMatchObject({ expectedReviewHeadSha: accepted, flowId: "flow-1" });
    expect(h.flowRequests).toHaveLength(1);
    expect(h.flowRequests[0]).toMatchObject({ implementerPath: "/codex/stage-1.jsonl", targetSha: accepted, headRef: skipped.branch, requireRemoteHead: true });
    expect(fs.readFileSync(path.join(worktree, "sentinel.tmp"), "utf8")).toBe("untouched\n");
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const publication of ["internal", "remote-branch"] as const) {
test(`a legacy architect repair commits its declared output before ${publication} review`, async () => {
  const fixture = await realWorktreeLane(`architect-review-repair-${publication}`, [
    { id: "architect", kind: "run", role: { roleId: "architect" }, access: "read-only", outputs: ["report.md"], prompt: "Write report", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review report", next: null },
  ], publication === "remote-branch" ? publication : undefined);
  const offline = `${fixture.origin}.offline`;
  try {
    fs.writeFileSync(path.join(fixture.worktree, "report.md"), "first report\n");
    fixture.h.setConversationActive(false);
    await tickPipelines([fixture.h.finish("/codex/stage-1.jsonl", "pass")], fixture.h.ports);
    await tickPipelines([], fixture.h.ports);
    const first = (await fixture.git(fixture.worktree, "rev-parse", "HEAD"));
    const flow = fixture.h.flows.get("flow-1")!;
    expect(flow).toBeDefined();
    const transcript = path.join(fixture.root, "architect-repair.jsonl");
    const sessionId = ["059f421e", "02e1", "73e0", "9b77", "bebde063f529"].join("-");
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: fixture.worktree } })}\n${JSON.stringify({
      timestamp: new Date(Date.now() + 1_000).toISOString(), type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "REVIEW_READY: repaired report" },
    })}\n`);
    const roles = { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "high" } };
    const firstRound = { ...newRound({ ...flow, roles, rounds: [] }, "marker", null), n: 1, startedAt: "2026-07-22T00:00:00Z", relayedAt: "2026-07-22T00:01:00Z" };
    Object.assign(flow, {
      template: "implement-review-loop",
      project: loadPipelines().find((item) => item.id === fixture.id)!.project,
      baseMode: "head",
      pausedState: null, stateDetail: null,
      cwd: fixture.worktree,
      implementerPath: transcript,
      requireRemoteHead: publication === "remote-branch",
      roles,
      mode: "auto", reviewerMode: "headless", state: "fixing", roundLimit: 5,
      createdAt: "2026-07-21T00:00:00Z",
      rounds: [firstRound],
    });
    saveFlows([flow]);
    fs.writeFileSync(path.join(fixture.worktree, "report.md"), "repaired report\n");
    fs.writeFileSync(path.join(fixture.worktree, "sentinel.tmp"), "keep me\n");
    const record = entry(transcript);
    record.size = fs.statSync(transcript).size;
    record.mtime = Date.now() / 1_000;
    if (publication === "remote-branch") fs.renameSync(fixture.origin, offline);
    expect(await tickFlow(flow, [record], new Map([[transcript, record]]), () => {})).toBe(true);
    const repaired = (await fixture.git(fixture.worktree, "rev-parse", "HEAD"));
    expect(repaired).not.toBe(first);
    if (publication === "remote-branch") {
      expect(flow.state).toBe("fixing");
      expect(flow.rounds).toHaveLength(1);
      fs.renameSync(offline, fixture.origin);
      saveFlows([flow]);
      expect(await tickFlow(flow, [record], new Map([[transcript, record]]), () => {})).toBe(true);
      expect((await fixture.git(fixture.origin, "rev-parse", `refs/heads/${loadPipelines().find((item) => item.id === fixture.id)!.branch}`))).toBe(repaired);
    }
    expect(flow.state).toBe("spawning");
    expect(flow.rounds[1]!.reviewHeadSha).toBe(repaired);
    expect(loadPipelines().find((item) => item.id === fixture.id)!.lastPassedCommit).toBe(repaired);
    expect((await fixture.git(fixture.worktree, "show", "--name-only", "--format=", "HEAD"))).toBe("report.md");
    expect(fs.readFileSync(path.join(fixture.worktree, "sentinel.tmp"), "utf8")).toBe("keep me\n");
  } finally {
    saveFlows([]);
    savePipelines([]);
    if (fs.existsSync(offline)) fs.renameSync(offline, fixture.origin);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
}

test("a new owner reviews the commit published after the producer turn ends", async () => {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-one-published-head-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const { realExec } = await import("@/lib/workflows/provision");
  const { realProvisionExec } = await import("./git");
  const git = async (cwd: string, ...args: string[]) => {
    const result = (await realExec("git", args, cwd));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(repo);
    (await git(root, "init", "--bare", "--initial-branch=main", origin));
    (await git(repo, "init", "--initial-branch=main"));
    (await git(repo, "config", "user.name", "Fixture"));
    (await git(repo, "config", "user.email", "noreply@example.com"));
    (await git(repo, "config", "commit.gpgSign", "false"));
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    (await git(repo, "add", "base.txt"));
    (await git(repo, "commit", "-m", "base"));
    (await git(repo, "remote", "add", "origin", origin));
    (await git(repo, "push", "origin", "main"));
    const base = (await git(repo, "rev-parse", "HEAD"));

    const h = harness();
    h.ports.exec = realExec;
    h.ports.provisionExec = realProvisionExec;
    const created = await createPipelineFromRequest({
      task: "One published head", repoDir: repo, baseRef: base,
      publication: "remote-branch", delivery: { branch: "refs/heads/feature/shared" },
      stages: [
        { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
        { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
      ],
    }, h.ports);
    if (!created.pipeline) throw new Error(created.error);
    const id = created.pipeline.id;
    await tickPipelines([], h.ports);
    const lane = loadPipelines().find((item) => item.id === id)!;
    expect((await git(lane.worktreeDir, "branch", "--show-current"))).toBe("feature/shared");
    expect((await realExec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${lane.branch}`], repo)).code).not.toBe(0);
    await tickPipelines([], h.ports);
    fs.writeFileSync(path.join(lane.worktreeDir, "work.txt"), "producer work\n");
    const ready = h.finish("/codex/stage-1.jsonl", "pass");
    ready.activity = "live";
    h.setConversationActive(true);
    await tickPipelines([ready], h.ports);
    expect(loadPipelines().find((item) => item.id === id)!.cursor?.stageId).toBe("build");
    expect(h.spawnInputs).toHaveLength(1);

    ready.activity = "idle";
    h.setConversationActive(false);
    await tickPipelines([ready], h.ports);
    const committed = (await git(lane.worktreeDir, "rev-parse", "HEAD"));
    expect(committed).not.toBe(base);
    expect(h.spawnInputs).toHaveLength(1);
    for (let n = 0; n < 5 && h.spawnInputs.length === 1; n += 1) await tickPipelines([], h.ports);
    expect((await git(origin, "rev-parse", "refs/heads/feature/shared"))).toBe(committed);
    expect(loadPipelines().find((item) => item.id === id)!.lastPassedCommit).toBe(committed);
    expect(h.spawnInputs).toHaveLength(2);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(2);
  } finally {
    savePipelines([]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const pin of ["automatic", "explicit", "legacy-draft", "legacy-unknown", "legacy-auto-retry", "crash-before-apply"] as const) {
  const pinned = pin === "explicit" || pin === "legacy-draft";
  test(`successor provisioning records its backup and respects the caller's base pin (${pin})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provision-published-"));
    const repo = path.join(root, "repo");
    const origin = path.join(root, "origin.git");
    const { realExec } = await import("@/lib/workflows/provision");
    const { realProvisionExec } = await import("./git");
    const git = async (cwd: string, ...args: string[]) => {
      const result = (await realExec("git", args, cwd));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(repo);
      (await git(repo, "init", "--initial-branch=main"));
      (await git(repo, "config", "user.name", "Fixture"));
      (await git(repo, "config", "user.email", "noreply"));
      (await git(repo, "config", "commit.gpgSign", "false"));
      (await git(repo, "commit", "--allow-empty", "-m", "pinned base"));
      const base = (await git(repo, "rev-parse", "HEAD"));
      (await git(root, "init", "--bare", "--initial-branch=main", origin));
      (await git(repo, "remote", "add", "origin", origin));
      (await git(repo, "push", "origin", "main"));
      (await git(repo, "checkout", "-b", "feature/provision"));
      (await git(repo, "commit", "--allow-empty", "-m", "published head"));
      (await git(repo, "push", "origin", "feature/provision"));
      const published = (await git(repo, "rev-parse", "HEAD"));
      (await git(repo, "commit", "--allow-empty", "-m", "unpublished leftover"));
      const leftover = (await git(repo, "rev-parse", "HEAD"));
      const h = harness();
      h.ports.exec = realExec;
      h.ports.provisionExec = realProvisionExec;
      const created = await createPipelineFromRequest({
        task: "Published successor", repoDir: repo, ...(pinned ? { baseRef: base } : {}),
        ...(pin === "legacy-draft" ? { autoStart: false } : {}),
        delivery: { branch: "refs/heads/feature/provision" },
        stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null }],
      }, h.ports);
      if (!created.pipeline) throw new Error(created.error);
      if (pin === "legacy-draft") {
        const legacy = loadPipelines().find((item) => item.id === created.pipeline!.id)!;
        delete legacy.baseRefPinned;
        savePipelines([legacy]);
        expect(await patchPipeline(legacy.id, { action: "start" }, h.ports)).toMatchObject({ pipeline: { state: "provisioning" } });
      }
      if (pin === "legacy-unknown" || pin === "legacy-auto-retry") {
        const legacy = loadPipelines().find((item) => item.id === created.pipeline!.id)!;
        delete legacy.baseRefPinned;
        legacy.baseBranch = "main";
        legacy.baseRef = base;
        legacy.lastPassedCommit = base;
        legacy.stateDetail = pin === "legacy-auto-retry" ? "failed automatic checkout" : null;
        if (pin === "legacy-auto-retry") legacy.state = "needs_decision";
        savePipelines([legacy]);
        if (pin === "legacy-auto-retry") {
          expect(await patchPipeline(legacy.id, { action: "retry-stage" }, h.ports)).toMatchObject({ pipeline: { state: "provisioning" } });
        }
      }
      if (pin === "crash-before-apply") {
        const { provisionPipelineWorktreeAsync } = await import("./git");
        const interrupted = await provisionPipelineWorktreeAsync({ ...created.pipeline, baseBranch: "main", baseRef: base }, realProvisionExec);
        expect(interrupted).toMatchObject({ ok: true, sha: published, preservedLocalRef: { sha: leftover } });
        // The checkout exists, but the controller did not persist its outcome.
      }
      await tickPipelines([], h.ports);
      const lane = loadPipelines().find((item) => item.id === created.pipeline!.id)!;
      expect(lane.state).toBe("running");
      expect((await git(lane.worktreeDir, "rev-parse", "HEAD"))).toBe(pinned ? base : published);
      expect((await git(repo, "rev-parse", "HEAD"))).toBe(leftover);
      const backup = (await git(repo, "for-each-ref", "--format=%(refname)", "refs/backup/provision-unpublished"));
      expect((await git(repo, "rev-parse", backup))).toBe(leftover);
      expect(lane.stateDetail).toContain(backup);
      expect(lane.delivery!.journal.some((entry) => entry.reason.includes(backup) && entry.reason.includes("1 unpublished commit"))).toBe(true);
      expect(loadPipelines().find((item) => item.id === lane.id)!.baseRefPinned ?? false).toBe(pinned);
    } finally {
      savePipelines([]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("delivery creation clamps the second target lane and replays its original key before provisioning", async () => {
  const h = harness();
  const request = { task: "Delivery owner", repoDir: "/repo", stages: RUN_STAGES as never, autoStart: false,
    ...REMOTE_BRANCH, delivery: { branch: "refs/heads/shared-review", rejectedHead: "a".repeat(40), pr: 637 } };
  const first = await createPipelineFromRequest(request, h.ports, { creationRequest: { key: "delivery-first", digest: "first" } });
  const second = await createPipelineFromRequest({ ...request, task: "Comparison", delivery: { ...request.delivery, remote: "origin", rejectedHead: "b".repeat(40) } }, h.ports,
    { creationRequest: { key: "delivery-second", digest: "second" } });
  expect(first.pipeline?.delivery).toMatchObject({ disposition: "owner", active: true, epoch: 1 });
  expect(second.pipeline).toMatchObject({ publication: "internal", delivery: { disposition: "comparison", publish: "disabled", ownerId: first.pipeline!.id, epoch: 1 } });
  const replay = await createPipelineFromRequest(request, h.ports, { creationRequest: { key: "delivery-first", digest: "first" } });
  expect(replay.pipeline?.id).toBe(first.pipeline?.id);
  expect(loadPipelines()).toHaveLength(2);
  expect(h.calls.some((call) => call.includes("worktree add"))).toBe(false);
  const denied = await patchPipeline(second.pipeline!.id, { action: "publish", acceptedSha: ORIGIN_MAIN_SHA }, h.ports);
  expect(denied.error).toContain(first.pipeline!.id);
  expect(h.calls.some((call) => call.startsWith("git push"))).toBe(false);
  const takeover = await patchPipeline(second.pipeline!.id, { action: "takeover", expectedOwner: first.pipeline!.id, expectedEpoch: 1, reason: "comparison selected" }, h.ports,
    { kind: "agent", role: "builder", conversationId: "conversation_requester" });
  expect(takeover.pipeline!.publication).toBeUndefined();
  expect(takeover.pipeline).toMatchObject({ delivery: { disposition: "owner", active: true, epoch: 2 } });
  expect(takeover.pipeline?.delivery?.journal.at(-1)?.conversationId).toBe("conversation_requester");
  expect((await patchPipeline(first.pipeline!.id, { action: "publish", acceptedSha: ORIGIN_MAIN_SHA }, h.ports)).error).toContain(second.pipeline!.id);
});

test("legacy publication admission processes bounded batches before provisioning and never strands the next batch", async () => {
  const h = harness();
  const template = await create(h.ports, RUN_STAGES as never, REMOTE_BRANCH);
  const legacy = Array.from({ length: 17 }, (_, index) => {
    const record = structuredClone(template);
    record.id = `legacy-${index.toString().padStart(2, "0")}`;
    Object.assign(record, pipelineIdentity(record.id, record.task, record.repoDir));
    delete record.delivery;
    return record;
  });
  savePipelines(legacy);
  await tickPipelines([], h.ports);
  const first = loadPipelines();
  expect(first.filter((pipeline) => pipeline.delivery)).toHaveLength(16);
  expect(first.at(-1)).toMatchObject({ state: "provisioning" });
  expect(first.some((pipeline) => pipeline.state === "needs_decision")).toBe(false);
  await tickPipelines([], h.ports);
  expect(loadPipelines().every((pipeline) => pipeline.delivery?.disposition === "owner")).toBe(true);
  expect(loadPipelines().some((pipeline) => pipeline.state === "needs_decision")).toBe(false);
});

test("a fail-park keeps delivery through retry and publishes the next pass without takeover", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.delivery).toMatchObject({ active: true, publish: "enabled", ownerId: pipeline.id, epoch: 1 });
  expect(parked.delivery!.journal.some((item) => item.kind === "release")).toBe(false);
  expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", publishedCommit: box.passedSha,
    cursor: { stageId: "review", state: "pending" }, delivery: { active: true, epoch: 1 } });
  expect(box.remote()).toBe(box.passedSha);
});

test("held pending cursors let the real controller idle and release one successor", async () => {
  const { FlowPipelineController } = await import("./controller");
  const h = harness();
  let held = true;
  let cycles = 0;
  const heartbeats: import("./controller").FlowPipelineControllerHeartbeat[] = [];
  h.ports.drainHold = () => held ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: Number.MAX_SAFE_INTEGER } : null;
  await create(h.ports);
  const controller = new FlowPipelineController({
    tickPipelines: (entries) => tickPipelines(entries, h.ports),
    tickFlows: async () => ({ changed: false }), scan: async () => ({ files: [], complete: true }),
    publishHeartbeat: (heartbeat) => {
      heartbeats.push(heartbeat);
      // Bound the old defect without leaving its microtask loop alive.
      if (heartbeat.state === "idle" && ++cycles === 12) held = false;
    },
  });
  const unregister = registerPipelineTick(() => controller.tick());
  try {
    await controller.tick();
    expect(controller.idle()).toBe(true);
    expect(cycles).toBe(1);
    expect(h.spawnInputs).toHaveLength(0);
    expect(heartbeats.at(-1)?.state).toBe("idle");
    held = false;
    await controller.tick();
    await controller.poll();
    expect(h.spawnInputs).toHaveLength(1);
    expect(controller.idle()).toBe(true);
  } finally { unregister(); }
});

test("automatic-update hold keeps a pending attempt and releases exactly one launch", async () => {
  const h = harness();
  let held = true;
  h.ports.drainHold = () => held ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: Number.MAX_SAFE_INTEGER } : null;
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.cursor?.state).toBe("pending");
  const attempt = waiting.runs[0]!.attempts[0]!;
  expect(attempt.state).toBe("pending");
  expect(attempt.spawnCalls ?? 0).toBe(0);
  const detail = waiting.stateDetail;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toBe(detail);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(0);
  held = false;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.n).toBe(attempt.n);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
});

test("CPU pressure holds a fresh stage start with a visible reason and releases exactly one launch", async () => {
  const h = harness();
  const { CpuPressureGate, DEFAULT_CPU_PRESSURE_POLICY } = await import("@/lib/runtime/cpuPressure");
  let pressure: number | null = 45;
  let clock = Date.parse("2026-10-06T12:00:00Z");
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => pressure, now: () => clock });
  const wakes: number[] = [];
  h.ports.cpuPressureHold = () => gate.check();
  h.ports.scheduleTick = (delayMs) => { wakes.push(delayMs); };
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const held = loadPipelines()[0]!;
  expect(held.cursor?.state).toBe("pending");
  expect(held.runs[0]!.attempts[0]!.spawnCalls ?? 0).toBe(0);
  expect(held.stateDetail).toBe("stage start held for CPU pressure since 2026-10-06T12:00:00.000Z (avg10 45% ≥ 30%)");
  expect(wakes).toContain(5_000);
  clock += 120_000;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toStartWith("stage start deferred by CPU pressure: held since 2026-10-06T12:00:00.000Z");
  // Below the release threshold the hold lasts ten seconds more.
  pressure = 4;
  await tickPipelines([], h.ports);
  clock += 9_000;
  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(0);
  clock += 1_000;
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const released = loadPipelines()[0]!;
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
  expect(released.runs[0]!.attempts).toHaveLength(1);
  expect(released.stateDetail ?? "").not.toContain("CPU pressure");
  // A launched stage is never held again: pressure returns and nothing respawns.
  pressure = 80;
  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
});

test("a failed CPU pressure sample admits the stage start", async () => {
  const h = harness();
  const { CpuPressureGate, DEFAULT_CPU_PRESSURE_POLICY } = await import("@/lib/runtime/cpuPressure");
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => { throw new Error("EACCES"); }, now: Date.now });
  h.ports.cpuPressureHold = () => gate.check();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
  expect(loadPipelines()[0]!.stateDetail ?? "").not.toContain("CPU pressure");
});

test("automatic drain holds a new embedded legacy review stage and releases once", async () => {
  const h = harness();
  let held = false;
  h.ports.drainHold = () => held ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: Number.MAX_SAFE_INTEGER } : null;
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "review-loop", reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "high" }, prompt: "Review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  h.setConversationActive(false);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  held = true;
  for (let i = 0; i < 3; i++) await tickPipelines([], h.ports);
  expect(h.flowRequests).toHaveLength(0);
  expect(loadPipelines()[0]!.cursor).toMatchObject({ stageId: "review", state: "pending" });
  held = false;
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.flowRequests).toHaveLength(1);
});

test.each([false, true])("automatic drain holds reserved custody with dead owner=%s and resumes its identity", async (deadOwner) => {
  const oldDrain = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  const h = harness();
  let held = false;
  let reserveOnly = true;
  h.ports.drainHold = () => held || (reserveOnly && !!loadPipelines()[0]?.runs[0]?.attempts[0]?.activation) ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: Number.MAX_SAFE_INTEGER } : null;
  try {
    await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const before = loadPipelines()[0]!;
    const reserved = before.runs[0]!.attempts[0]!.activation!;
    expect(reserved.phase).toBe("reserved");
    if (deadOwner) {
      reserved.owner = { pid: 2_147_483_647, startIdentity: "gone", bootEpoch: "gone" };
      savePipelines([before]);
    }
    held = true;
    await engineModule.drainStageActivations(h.ports);
    const after = loadPipelines()[0]!.runs[0]!.attempts[0]!.activation!;
    expect(after.id).toBe(reserved.id);
    expect(after.owner).toBeUndefined();
    expect(h.spawnInputs).toHaveLength(0);
    const { probeQuiet } = await import("@/lib/selfUpdate/quiet");
    expect((await probeQuiet({ busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot,
      { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: loadPipelines, presence: () => [] }, Date.now(), true)).quiet).toBe(true);
    held = false;
    reserveOnly = false;
    await engineModule.drainStageActivations(h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toBeUndefined();
  } finally {
    if (oldDrain === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
    else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = oldDrain;
  }
});

test("reserved activation rechecks update admission after waiting for the mutation lease", async () => {
  const oldDrain = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  const h = harness();
  let reserveOnly = true;
  let held = false;
  let scanned!: () => void;
  h.ports.drainHold = () => {
    scanned?.();
    return held || (reserveOnly && !!loadPipelines()[0]?.runs[0]?.attempts[0]?.activation)
      ? { id: "hold", target: "a".repeat(40), since: "2026-01-01T00:00:00Z", until: 0, persistent: true } : null;
  };
  let release!: () => void;
  let locking: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  try {
    await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const before = structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!);
    reserveOnly = false;
    const { withPipelineMutation } = await import("./store");
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    locking = withPipelineMutation(async () => { entered(); await gate; });
    await acquired;
    const scanning = new Promise<void>(resolve => { scanned = resolve; });
    draining = engineModule.drainStageActivations(h.ports);
    await scanning;
    held = true;
    release(); await locking; await draining;
    expect(h.spawnInputs).toHaveLength(0);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toEqual(before);
    held = false;
    await engineModule.drainStageActivations(h.ports);
    await engineModule.drainStageActivations(h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    expect(h.spawnInputs[0]!.clientAttemptId).toBe(before.activation!.clientAttemptId);
  } finally {
    release?.(); await locking; await draining;
    if (oldDrain === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
    else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = oldDrain;
  }
});

test("pipeline account admission retains reserved custody without parking or consuming a new launch key", async () => {
  const h = harness();
  const drain = await import("@/lib/selfUpdate/drain");
  const mutation = await import("@/lib/accounts/accountMutation");
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "legacy-held-admission.json"));
  setAgentRegistryForTests(registry);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(engine => ({ kind: "available", account: {
    engine, accountId: "account-a", kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  }}));
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockResolvedValue({ path: null } as never);
  const provision = await import("@/lib/workflows/provision");
  const execute = provision.realExec;
  const gitHead = spyOn(provision, "realExec").mockImplementation((command, args, ...rest) =>
    command === "git" && args.join(" ") === "rev-parse HEAD"
      ? { code: 0, stdout: ORIGIN_MAIN_SHA, stderr: "" } : execute(command, args, ...rest));
  const ports = defaultPipelinePorts();
  const keys: string[] = [];
  h.ports.drainHold = ports.drainHold;
  h.ports.spawnAgent = (input, reserve) => { keys.push(input.clientAttemptId); return ports.spawnAgent(input, reserve); };
  let resume!: () => void, entered!: () => void, queued!: () => void;
  const acquired = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { resume = r; });
  const waiting = new Promise<void>(r => { queued = r; });
  const nativeLock = mutation.withAccountMutationLockAsync;
  let locking: Promise<void> | undefined;
  let ticking: ReturnType<typeof tickPipelines> | undefined;
  let lock: ReturnType<typeof spyOn<typeof mutation, "withAccountMutationLockAsync">> | undefined;
  try {
    await create(h.ports); await tickPipelines([], h.ports);
    locking = nativeLock(async () => { entered(); await gate; }); await acquired;
    lock = spyOn(mutation, "withAccountMutationLockAsync").mockImplementation((...args) => { queued(); return nativeLock(...args); });
    ticking = tickPipelines([], h.ports); await waiting;
    drain.writeDrain(drain.drainFile(), { id: "legacy-admission", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    resume(); await locking; await ticking;
    expect(spawn).not.toHaveBeenCalled();
    expect(Object.values(registry.readOnlySnapshot().receipts)).toHaveLength(0);
    // Async Git now always drains a reserved activation outside the mutation
    // lease. The refused dispatch retains its counted key for exact replay.
    expect(loadPipelines()[0]!).toMatchObject({ state: "running", cursor: { state: "spawning" } });
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!).toMatchObject({ state: "spawning", spawnCalls: 1, activation: { phase: "reserved", replay: true } });
    drain.releaseDrain(drain.drainFile(), "legacy-admission");
    await tickPipelines([], h.ports);
    expect(spawn).toHaveBeenCalledTimes(1);
    const launched = spawn.mock.calls[0]![0];
    expect(launched.account.env.LLV_STAGE_GIT_WORKTREE).toBe(launched.spec.cwd);
    const receipt = launched.account.env.LLV_STAGE_GIT_RECEIPT!;
    expect(JSON.parse(fs.readFileSync(path.join(receipt, "start.json"), "utf8"))).toMatchObject({
      launchId: launched.receipt.launchId, head: ORIGIN_MAIN_SHA, worktree: launched.spec.cwd,
    });
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    expect(Object.values(registry.readOnlySnapshot().receipts)).toHaveLength(1);
  } finally {
    resume?.(); await locking; await ticking;
    lock?.mockRestore(); resolve.mockRestore(); client.mockRestore(); spawn.mockRestore(); gitHead.mockRestore();
    drain.releaseDrain(drain.drainFile(), "legacy-admission"); setAgentRegistryForTests(null);
  }
});

test.each(["early", "drain-switch-off"] as const)("managed %s admission holds actual pipeline launches across recovery until terminal status", async (admission) => {
  const h = harness();
  savePipelines([]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-pipeline-custody-"));
  const target = "a".repeat(40);
  const old = "b".repeat(40);
  let now = Date.parse("2026-01-01T00:00:00Z");
  let turns = admission === "early" ? 0 : 1;
  let requests = 0;
  let status: import("@/lib/runtime/contracts").ViewerDeploymentStatus | null = null;
  const rev = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
  writeAuto(path.join(dir, "auto.json"), { ...initialAuto(), enabled: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ slice: { ...initialCheck(), installed: rev(old), available: rev(target),
    check: { ...idleCheck(), state: "update-available", relation: "behind" } }, update: null }));
  const deps = { dir, now: () => now, env: {}, remote: "https://github.com/example/project", branch: "main", pollMinutes: 15,
    mode: async () => ({ mode: "managed", record: null, reason: null }), releaseTarget: () => ({ revision: old }),
    check: async () => ({ ok: true, installed: rev(old), available: rev(target), relation: "behind", ahead: 0, behind: 1, delta: null }),
    prepareCheckRepo: async () => dir, targetOnBranch: async () => true, describe: async (_repo: string, sha: string) => rev(sha),
    hostHealth: async () => ({ pid: 102, generation: { revision: old } }), web: { pid: 101, port: null, startedAt: "", revision: old },
    green: { read: async () => ({ state: "green" }) }, quiet: { runtimeSnapshot: async () => ({ sessions: turns ? [{ turn: "running", host: "hosted" }] : [] }), pipelines: loadPipelines, presence: () => [], memoryAvailableMb: () => 8192 },
    requestDeployment: async (body: import("@/lib/runtime/contracts").ViewerDeploymentRequest) => {
      requests++;
      status = { deploymentId: "deployment-test", idempotencyKey: body.idempotencyKey, requestedRevision: target, revision: target,
        phase: "admitted", terminal: false, candidate: null, previous: null, mcpRuntime: { candidate: null, previous: null, publications: [], health: [] }, health: [], error: null,
        owner: { pid: 102, startIdentity: null }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), revisionNumber: 1 };
      return { state: "accepted", deploymentId: "deployment-test", revision: target, replayed: false };
    },
    readDeployment: async () => status, findDeploymentByIdempotencyKey: async () => status,
  } as unknown as ServiceDeps;
  let service = new SelfUpdateService(deps);
  h.ports.drainHold = () => activeDrain(path.join(dir, "auto-drain.json"), now);
  try {
    await service.autoTick();
    if (admission === "drain-switch-off") { turns = 0; await service.autoTick(); }
    now += 60_000;
    await service.autoTick();
    expect(requests).toBe(1);
    await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] as never);
    if (admission === "drain-switch-off") await service.setAuto(false);
    for (let i = 0; i < 2; i++) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
    service.stop();
    now += DRAIN_LEASE_MS + 1;
    service = new SelfUpdateService(deps);
    await startAutoAndSettle(service);
    for (let i = 0; i < 2; i++) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
    expect(requests).toBe(1);
    status = { ...status!, phase: "rolled-back", terminal: true, revisionNumber: 2 };
    // A terminal receipt with mixed serving revisions still owns the drain.
    deps.web.revision = target;
    await service.refreshManaged();
    await service.snapshot();
    for (let i = 0; i < 2; i++) await tickPipelines([], h.ports);
    expect(h.ports.drainHold()).not.toBeNull();
    expect(h.spawnInputs).toHaveLength(0);
    deps.web.revision = old;
    await service.snapshot();
    expect(h.ports.drainHold()).toBeNull();
    for (let i = 0; i < 2; i++) await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(1);
  } finally { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});


async function detachedAttemptFixture(name: string) {
  const f = await realWorktreeLane(name, [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review", next: null },
  ], "remote-branch");
  const lane = loadPipelines().find(p => p.id === f.id)!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.launchId = `launch-${lane.id}`;
  savePipelines([lane]);
  const receipt = path.join(process.env.LLV_STATE_DIR!, "pipeline-git-attempts",
    crypto.createHash("sha256").update(attempt.launchId!).digest("hex"));
  fs.mkdirSync(receipt, { recursive: true });
  fs.writeFileSync(path.join(receipt, "base"), f.base);
  fs.writeFileSync(path.join(receipt, "start.json"), JSON.stringify({ launchId: attempt.launchId,
    worktree: f.worktree, head: f.base, startedAt: attempt.startedAt }));
  const { agentPublicationIdentityEnv } = await import("@/lib/git/agentPublicationIdentity");
  const source = { ...process.env, HOME: f.root, LLV_STAGE_GIT_RECEIPT: receipt, LLV_STAGE_GIT_WORKTREE: f.worktree };
  const env: NodeJS.ProcessEnv = { ...source, ...agentPublicationIdentityEnv(source),
    GIT_AUTHOR_DATE: new Date(Date.parse(attempt.startedAt!) + 1000).toISOString(),
    GIT_COMMITTER_DATE: new Date(Date.parse(attempt.startedAt!) + 1000).toISOString() };
  const detached = path.join(f.root, "detached");
  await f.git(f.worktree, "worktree", "add", "--detach", detached, f.base);
  const run = async (...args: string[]) => {
    const r = await realExec("git", args, detached, env);
    expect(r.code, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const commit = async (content = "attempt fix\n") => {
    fs.writeFileSync(path.join(detached, "fix.txt"), content);
    await run("add", "fix.txt");
    await run("commit", "-m", "attempt fix");
    return await run("rev-parse", "HEAD");
  };
  const finish = async () => {
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    await tickPipelines([finishReported(f.h, "/codex/stage-1.jsonl", "pass", "Fixed")], f.h.ports);
    return loadPipelines().find(p => p.id === f.id)!;
  };
  return { ...f, lane, attempt, receipt, env, detached, run, commit, finish };
}

test("attempt Git custody adopts a proved detached push before review", async () => {
  const f = await detachedAttemptFixture("attempt-git-detached");
  try {
    const fixed = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.base);
    const accepted = await f.finish();
    expect(accepted.lastPassedCommit).toBe(fixed);
    expect(accepted.runs[0]!.attempts[0]!.report?.provenance.head).toBe(fixed);
    expect(accepted.cursor?.stageId).toBe("review");
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(fixed);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(fixed);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody refuses an unproved detached push and fails the stage clearly", async () => {
  const f = await detachedAttemptFixture("attempt-git-unproved");
  try {
    // Same machine author and timestamp, created without this attempt's hooks.
    const r = await realExec("git", ["commit", "--allow-empty", "-m", "foreign"], f.detached,
      { ...f.env, GIT_CONFIG_COUNT: "0" });
    expect(r.code).toBe(0);
    const refused = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("not created in the attempt worktree");
    expect(await f.git(f.origin, "for-each-ref", "--format=%(objectname)", `refs/heads/${f.lane.branch}`)).toBe("");
    const failed = await f.finish();
    expect(failed.state).toBe("needs_decision");
    expect(failed.stateDetail).toContain("stage push refused");
    expect(failed.lastPassedCommit).toBe(f.base);
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.base);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const shape of ["foreign", "wrong-attempt", "missing-start", "malformed", "oversized", "mixed", "non-descendant", "remote-race", "remote-after-merge", "local-race", "pause", "claim-race", "dirty", "released"] as const) {
  test(`attempt Git custody preserves the fences for ${shape}`, async () => {
    const f = await detachedAttemptFixture(`attempt-git-${shape}`);
    try {
      if (shape === "non-descendant") await f.run("checkout", "--orphan", "unrelated");
      if (shape === "mixed") await f.git(f.detached, "commit", "--allow-empty", "-m", "unproved ancestor");
      const fixed = await f.commit();
      // An adversarial writer may bypass its hooks. Settlement still needs all
      // of the receipts, ancestry and window evidence before changing HEAD.
      await f.git(f.detached, "push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
      fs.mkdirSync(path.join(f.receipt, "pushes"), { recursive: true });
      fs.writeFileSync(path.join(f.receipt, "pushes", fixed), `refs/heads/${f.lane.branch}\n${f.origin}\n`);
      if (shape === "wrong-attempt") {
        const file = path.join(f.receipt, "start.json");
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), launchId: "another-attempt" }));
      }
      if (shape === "missing-start") fs.rmSync(path.join(f.receipt, "start.json"));
      if (shape === "malformed" || shape === "oversized") fs.writeFileSync(path.join(f.receipt, "start.json"), shape === "malformed" ? "{" : "x".repeat(8193));
      if (shape === "foreign") fs.rmSync(path.join(f.receipt, "commits", fixed), { force: true });
      if (shape === "dirty") fs.writeFileSync(path.join(f.worktree, "unsaved.txt"), "unsaved\n");
      if (shape === "released") {
        const stored = loadPipelines().find(p => p.id === f.id)!;
        stored.delivery!.active = false;
        savePipelines([stored]);
      }
      let reads = 0;
      let raced: string | null = null;
      const exec = f.h.ports.exec;
      if (["remote-race", "remote-after-merge", "local-race", "pause", "claim-race"].includes(shape)) f.h.ports.exec = async (command, args, ...rest) => {
        if (command === "git" && args[0] === "ls-remote" && ++reads === (shape === "remote-after-merge" ? 3 : 2)) {
          if (shape === "pause" || shape === "claim-race") {
            raced = shape;
            const stored = loadPipelines().find(p => p.id === f.id)!;
            if (shape === "pause") { stored.state = "paused"; stored.pausedState = "running"; savePipelines([stored]); }
            else savePipelines([stored, { ...structuredClone(stored), id: "racing-owner", state: "running", delivery: undefined }]);
            return exec(command, args, ...rest);
          }
          await f.git(f.detached, "commit", "--allow-empty", "-m", "racing work");
          raced = await f.git(f.detached, "rev-parse", "HEAD");
          if (shape === "remote-race" || shape === "remote-after-merge") await f.git(f.detached, "push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
          else await f.git(f.worktree, "commit", "--allow-empty", "-m", "lane raced");
        }
        return exec(command, args, ...rest);
      };
      const failed = await f.finish();
      if (["remote-race", "remote-after-merge", "local-race", "pause", "claim-race"].includes(shape)) expect(raced).not.toBeNull();
      expect(failed.state).toBe(shape === "pause" ? "paused" : "needs_decision");
      expect(failed.lastPassedCommit).toBe(f.base);
      expect(failed.cursor?.stageId).toBe("build");
      if (!["released", "pause", "claim-race"].includes(shape)) expect(failed.stateDetail).toContain("settling the stage push");
      if (shape !== "local-race") expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(shape === "remote-after-merge" ? fixed : f.base);
      expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(raced && (shape === "remote-race" || shape === "remote-after-merge") ? raced : fixed);
      if (shape === "dirty") expect(fs.readFileSync(path.join(f.worktree, "unsaved.txt"), "utf8")).toBe("unsaved\n");
    } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}


test("attempt Git custody replays its durable proof in a new controller process", async () => {
  const f = await detachedAttemptFixture("attempt-git-restart");
  try {
    const fixed = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    const script = `
      const { commitAndAdoptStageBranch } = await import("./src/lib/pipelines/stageBranch");
      const { realExec } = await import("./src/lib/workflows/provision");
      const p = JSON.parse(process.env.CUSTODY_FIXTURE);
      const a = p.runs[0].attempts[0];
      const result = await commitAndAdoptStageBranch(p, "build", realExec, () => [p], undefined,
        () => {}, null, undefined, undefined, a, new Date(Date.parse(a.startedAt) + 60000).toISOString());
      process.stdout.write(JSON.stringify(result));
    `;
    const replay = await realExec(process.execPath, ["-e", script], process.cwd(),
      { CUSTODY_FIXTURE: JSON.stringify(f.lane), LLV_STRUCTURED_HOSTS: "0" }, { timeoutMs: 30000 });
    expect(replay.code, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ ok: true, sha: fixed });
    expect((await f.finish()).lastPassedCommit).toBe(fixed);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});


test.each([256, 257])("attempt Git custody accepts every proved suffix commit (%i)", async (count) => {
  const f = await detachedAttemptFixture(`attempt-git-bound-${count}`);
  try {
    for (let n = 0; n < count; n++) await f.run("commit", "--allow-empty", "-m", `attempt change ${n}`);
    const fixed = await f.run("rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    const settled = await f.finish();
    expect(settled.lastPassedCommit).toBe(fixed);
    expect(settled.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 60000);


test("attempt Git custody rechecks activation after preparing the native guard", async () => {
  const f = await detachedAttemptFixture("attempt-git-activation-recheck");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "guard-activation-registry.json"));
  setAgentRegistryForTests(registry);
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({ kind: "available", account: {
    engine: "codex", accountId: "guard-account", kind: "managed", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" },
  }}));
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockResolvedValue({ path: null } as never);
  let reservations = 0;
  let launchId: string | null = null;
  try {
    await expect(defaultPipelinePorts().spawnAgent(f.h.spawnInputs[0]!, r => {
      launchId = r.launchId;
      if (++reservations === 2) throw new Error("activation paused while Git guard was prepared");
    })).rejects.toThrow("activation paused while Git guard was prepared");
    expect(reservations).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(registry.spawnReceipt(launchId!)?.state).toBe("failed");
  } finally {
    resolve.mockRestore(); client.mockRestore(); spawn.mockRestore(); setAgentRegistryForTests(null);
    savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true });
  }
});


test("attempt Git custody retries an unavailable remote before accepting the stage", async () => {
  const f = await detachedAttemptFixture("attempt-git-unavailable");
  try {
    const fixed = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    let available = false;
    const exec = f.h.ports.exec;
    f.h.ports.exec = (command, args, ...rest) => command === "git" && args[0] === "ls-remote" && !available
      ? { code: 128, stdout: "", stderr: "fixture remote unavailable" } : exec(command, args, ...rest);
    const waiting = await f.finish();
    expect(waiting.state).toBe("running");
    expect(waiting.cursor?.state).toBe("committing");
    expect(waiting.lastPassedCommit).toBe(f.base);
    expect(waiting.stateDetail).toContain("waiting for the delivery remote");
    available = true;
    await tickPipelines([], f.h.ports);
    const accepted = loadPipelines().find(p => p.id === f.id)!;
    expect(accepted.lastPassedCommit).toBe(fixed);
    expect(accepted.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});


test("attempt Git custody refuses a commit outside its owned scratch scope", async () => {
  const f = await detachedAttemptFixture("attempt-git-foreign-checkout");
  try {
    const scratch = path.join(f.root, "owned-scratch");
    fs.mkdirSync(scratch);
    f.env.TMPDIR = scratch;
    const { agentPublicationIdentityEnv } = await import("@/lib/git/agentPublicationIdentity");
    Object.assign(f.env, agentPublicationIdentityEnv(f.env));
    await f.commit();
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain("stage push refused");
    expect((await f.finish()).lastPassedCommit).toBe(f.base);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});


test("attempt Git custody restores report provenance after an interrupted fast-forward", async () => {
  const f = await detachedAttemptFixture("attempt-git-report-replay");
  try {
    const fixed = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    f.h.setConversationActive(false);
    await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: "builder", conversationId: "conversation_stage_1" }, f.h.ports);
    const stored = loadPipelines().find(p => p.id === f.id)!;
    const attempt = stored.runs[0]!.attempts[0]!;
    attempt.state = "committing";
    attempt.verdict = { status: "pass" };
    attempt.report!.provenance = { ...attempt.report!.provenance, state: "complete", head: f.base };
    stored.cursor!.state = "committing";
    savePipelines([stored]);
    // The Git effect survived; the controller's final row write did not.
    await f.git(f.worktree, "merge", "--ff-only", fixed);
    await tickPipelines([], f.h.ports);
    const accepted = loadPipelines().find(p => p.id === f.id)!;
    expect(accepted.lastPassedCommit).toBe(fixed);
    expect(accepted.runs[0]!.attempts[0]!.report?.provenance.head).toBe(fixed);
    expect(accepted.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["outside", "mixed", "malformed"] as const)("attempt Git custody revalidates full proof after a fast-forward replay: %s", async shape => {
  const f = await detachedAttemptFixture(`attempt-git-adopted-${shape}`);
  try {
    let candidate: string;
    if (shape === "outside") {
      const date = new Date(Date.parse(f.attempt.startedAt!) + 1000).toISOString();
      const result = await realExec("git", ["commit", "--allow-empty", "-m", "outside commit"], f.detached,
        { ...f.env, GIT_CONFIG_COUNT: "0", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      expect(result.code, result.stderr).toBe(0);
      candidate = (await f.git(f.detached, "rev-parse", "HEAD"));
    } else {
      candidate = await f.commit();
      if (shape === "mixed") {
        const date = new Date(Date.parse(f.attempt.startedAt!) + 2000).toISOString();
        const result = await realExec("git", ["commit", "--allow-empty", "-m", "outside ancestor"], f.detached,
          { ...f.env, GIT_CONFIG_COUNT: "0", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
        expect(result.code, result.stderr).toBe(0);
        candidate = (await f.git(f.detached, "rev-parse", "HEAD"));
      }
    }
    await f.git(f.worktree, "merge", "--ff-only", candidate);
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.worktree, f.env);
    expect(pushed.code, pushed.stderr).toBe(0);
    if (shape === "malformed") fs.writeFileSync(path.join(f.receipt, "commits", candidate), "not an empty receipt");
    const failed = await f.finish();
    expect(failed.state).toBe("needs_decision");
    expect(failed.stateDetail).toContain("settling the stage push");
    expect(failed.lastPassedCommit).toBe(f.base);
    expect(failed.cursor?.stageId).toBe("build");
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(candidate);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(candidate);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["unchanged", "absent"] as const)("attempt Git custody refuses an unconfirmed recorded candidate on an %s remote branch", async shape => {
  const f = await detachedAttemptFixture(`attempt-git-unconfirmed-${shape}`);
  try {
    const candidate = await f.commit();
    await f.git(f.origin, "update-ref", `refs/heads/${f.lane.branch}`, f.base);
    if (shape === "absent") await f.git(f.origin, "update-ref", "-d", `refs/heads/${f.lane.branch}`);
    // Model the hook's durable write before the repository hook or transport
    // refusal. Preserve that candidate while the delivery tip stays put.
    fs.mkdirSync(path.join(f.receipt, "pushes"), { recursive: true });
    fs.writeFileSync(path.join(f.receipt, "pushes", candidate), `refs/heads/${f.lane.branch}\n${f.origin}\n`);
    const failed = await f.finish();
    expect(failed.state).toBe("needs_decision");
    expect(failed.stateDetail).toContain("recorded push candidate was not confirmed");
    expect(failed.lastPassedCommit).toBe(f.base);
    expect(failed.cursor?.stageId).toBe("build");
    if (shape === "unchanged") expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(f.base);
    else {
      const branch = await realExec("git", ["show-ref", "--verify", `refs/heads/${f.lane.branch}`], f.origin);
      expect(branch.code).not.toBe(0);
    }
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test.each(["outside", "mixed"] as const)("attempt Git custody refuses a no-receipt remote suffix containing %s commits", async shape => {
  const f = await detachedAttemptFixture(`attempt-git-no-receipt-${shape}`);
  try {
    if (shape === "mixed") await f.commit();
    const date = new Date(Date.parse(f.attempt.startedAt!) + 2000).toISOString();
    const foreign = await realExec("git", ["commit", "--allow-empty", "-m", "outside commit"], f.detached,
      { ...f.env, GIT_CONFIG_COUNT: "0", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    expect(foreign.code, foreign.stderr).toBe(0);
    const candidate = await f.git(f.detached, "rev-parse", "HEAD");
    const pushed = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached,
      { ...f.env, GIT_CONFIG_COUNT: "0" });
    expect(pushed.code, pushed.stderr).toBe(0);
    await f.git(f.worktree, "merge", "--ff-only", candidate);
    const failed = await f.finish();
    expect(failed.state).toBe("needs_decision");
    expect(failed.stateDetail).toContain("settling the stage push");
    expect(failed.lastPassedCommit).toBe(f.base);
    expect(failed.cursor?.stageId).toBe("build");
    expect(await f.git(f.worktree, "rev-parse", "HEAD")).toBe(candidate);
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(candidate);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody settles a proved local commit without a remote push", async () => {
  const f = await detachedAttemptFixture("attempt-git-unpublished-local");
  try {
    const candidate = await f.commit();
    await f.git(f.worktree, "merge", "--ff-only", candidate);
    const accepted = await f.finish();
    expect(accepted.lastPassedCommit).toBe(candidate);
    expect(accepted.cursor?.stageId).toBe("review");
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(candidate);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody refuses a later rejected candidate despite an earlier confirmed push", async () => {
  const f = await detachedAttemptFixture("attempt-git-rejected-later-candidate");
  try {
    const first = await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    const second = await f.commit("attempt fix two\n");
    const hook = path.join(f.origin, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const rejected = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(rejected.code).not.toBe(0);
    fs.rmSync(hook);
    const refused = await f.finish();
    expect(refused.state).toBe("needs_decision");
    expect(refused.stateDetail).toContain("recorded push candidate was not confirmed");
    expect(refused.lastPassedCommit).toBe(f.base);
    expect(refused.cursor?.stageId).toBe("build");
    expect(await f.git(f.origin, "rev-parse", `refs/heads/${f.lane.branch}`)).toBe(first);
    expect(second).not.toBe(first);
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt Git custody settles the later candidate after a rejected push is retried", async () => {
  const f = await detachedAttemptFixture("attempt-git-retried-later-candidate");
  try {
    await f.commit();
    await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`);
    const second = await f.commit("attempt fix two\n");
    const hook = path.join(f.origin, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const rejected = await realExec("git", ["push", "origin", `HEAD:refs/heads/${f.lane.branch}`], f.detached, f.env);
    expect(rejected.code).not.toBe(0);
    fs.rmSync(hook);
    expect(await f.run("push", "origin", `HEAD:refs/heads/${f.lane.branch}`)).toBe("");
    const accepted = await f.finish();
    expect(accepted.lastPassedCommit).toBe(second);
    expect(accepted.cursor?.stageId).toBe("review");
  } finally { savePipelines([]); fs.rmSync(f.root, { recursive: true, force: true }); }
});


for (const stallMs of [0, 27_000]) test(`refresh completion advances its parent through the controller after a ${stallMs}ms stall`, async () => {
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `${stallMs === 0 ? "10000000" : "20000000"}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  const fixture = await realWorktreeLane("refresh-controller", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Refresh", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review resolution", next: null, onFail: { to: "build", maxRounds: 1 } },
  ]).finally(() => ids.mockRestore());
  try {
    const { h, id, worktree, git, base } = fixture;
    fs.writeFileSync(path.join(worktree, "resolution.txt"), "both sides preserved\n");
    await git(worktree, "add", "resolution.txt");
    await git(worktree, "commit", "-m", "Preserve the refresh resolution");
    const head = await git(worktree, "rev-parse", "HEAD");
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([], h.ports);
    const child = loadPipelines().find(lane => lane.id === id)!;
    child.delivery = { target: { repository: child.project, remote: "https://github.com/acme/widgets.git", branch: `refs/heads/${child.branch}`, pr: 11 },
      disposition: "owner", publish: "disabled", ownerId: id, epoch: 2, active: false, journal: [] };
    child.refreshOf = { pipelineId: "original", base };
    const parent = structuredClone(child);
    Object.assign(parent, { id: "original", state: "completed", cursor: null, closedAt: h.ports.now(), lastPassedCommit: base });
    Object.assign(parent, pipelineIdentity(parent.id, parent.task, parent.repoDir));
    delete parent.refreshOf;
    parent.runs.forEach(run => run.attempts.forEach(attempt => { attempt.state = "passed"; }));
    parent.delivery!.active = false;
    parent.delivery!.ownerId = parent.id;
    const { mergeAdmission, productionAutoMergePorts, sweepAutoMerge, resetAutoMergeForTests, MERGE_POLL_MS } = await import("@/lib/forge/autoMerge");
    const { FlowPipelineController } = await import("./controller");
    resetAutoMergeForTests();
    let clock = Date.parse(h.ports.now());
    const setting = () => ({ enabled: true, changedAt: new Date(0).toISOString(), changedBy: "operator" as const });
    const admitted = mergeAdmission(parent, clock, { setting, pullRequestOf: () => ({ repository: "acme/widgets", number: 11 }) });
    if (!("merge" in admitted)) throw new Error(admitted.reason);
    parent.merge = admitted.merge;
    parent.merge.state = "refreshing";
    parent.merge.refresh = { attempt: 0, base, head: base, key: "controller-refresh", digest: "c".repeat(64), requestedAt: new Date(clock).toISOString(), pipelineId: id };
    const { isStoredPipeline } = await import("./store");
    expect({ parent: isStoredPipeline(parent), child: isStoredPipeline(child) }).toEqual({ parent: true, child: true });
    savePipelines([parent, child]);
    let merged = false, pending = false;
    const writes: string[][] = [];
    const ports = productionAutoMergePorts({ now: () => clock, loadPipelines, setting, cachedState: () => null, log: () => undefined,
      run: async args => {
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
          state: merged ? "MERGED" : "OPEN", headRefOid: head, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: pending ? "IN_PROGRESS" : "COMPLETED", conclusion: pending ? "" : "SUCCESS" }],
          mergeCommit: merged ? { oid: "f".repeat(40) } : null, mergedAt: merged ? new Date(clock).toISOString() : null,
        });
        if (args[0] === "api" && args[1]?.includes("/reviews")) return "";
        if (args[0] === "api" && args[1]?.includes("/branches/")) return '["ci"]';
        if (args[0] === "repo") return '{"squashMergeAllowed":true}';
        throw new Error(`unexpected forge read ${args.join(" ")}`);
      },
      write: async args => { writes.push(args); merged = true; return ""; },
    });
    let events = [h.finish("/codex/stage-2.jsonl", "pass")];
    let sweep = Promise.resolve();
    const controller = new FlowPipelineController({ now: () => clock, monotonicNow: () => 0,
      tickPipelines: async () => {
        const entries = events; events = [];
        const result = await tickPipelines(entries, h.ports);
        // Model a Viewer stall after completion was persisted, before the global sweep.
        if (entries.length) clock += stallMs;
        return result;
      },
      tickFlows: async () => ({ changed: false }),
      sweepAutoMerge: () => { sweep = sweepAutoMerge(ports); },
    }, { maxPasses: 1 });
    const tick = async () => { await controller.tick(); await sweep; };
    pending = true;
    await tick();
    expect(loadPipelines().find(lane => lane.id === id)?.state).toBe("completed");
    await tick();
    expect(loadPipelines().find(lane => lane.id === "original")?.merge?.state).toBe("waiting-checks");
    expect(writes).toHaveLength(0);
    pending = false;
    for (let poll = 0; poll < 7; poll++) { clock += MERGE_POLL_MS; await tick(); }
    expect(loadPipelines().find(lane => lane.id === "original")?.merge).toMatchObject({ state: "merged", mergedHead: head });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(head);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
