import { assertCpuReadGuardSurvivesSpyRestoration } from "./engineEnvironment.fixture";
import { expect, spyOn, test, crypto, fs, path, accountManager, engineModule, defaultPipelinePorts, pipelineClaudePermissionMode, tickPipelines, AgentRegistry, setAgentRegistryForTests, loadPipelines, savePipelines, pipelineIdentity, patchPipeline, entry, finishReported, realWorktreeLane, successorOnPullRequestBranch } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";
import { bindHostExitWriter, recordHostExit, recordHostStop, withHostStopOrigin } from "@/lib/runtime/hostExit";
import { captureProcessIdentity } from "@/lib/processIdentity";

test("pipeline death evidence waits for the independent native waiter's receipt", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pending-exit-agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const identity = { pid: 2147482599, startIdentity: "fixture-pending-exit-port", bootEpoch: "fixture-boot" };
  const binding = fs.mkdtempSync(path.join(process.env.TMPDIR!, "pending-exit-port-"));
  setAgentRegistryForTests(registry);
  try {
    const launch = registry.beginSpawn("codex", "fixtures", { title: "Pending native exit fixture" });
    const sessionId = "00000000-0000-0000-0000-000000000000";
    registry.stageStructuredSpawn(launch.launchId, { key: { engine: "codex", sessionId }, artifactPath: `fixtures/rollout-2026-10-25T00-00-00-${sessionId}.jsonl`,
      cwd: "fixtures", accountId: null, status: "dead", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null,
      structuredHost: { kind: "codex-app-server", process: identity, exitProcess: identity, endpoint: "stdio:fixture",
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: "open-turn", pendingAttention: [], activeFlags: [] } });
    bindHostExitWriter(binding, identity, captureProcessIdentity(process.pid));
    const ports = defaultPipelinePorts();
    expect(await ports.conversationHostUnavailableSince!(launch.conversationId)).toBeUndefined();
    expect(await ports.conversationHostProcess!(launch.conversationId)).toMatchObject({ state: "unknown" });
    recordHostExit(identity, null, "SIGKILL");
    expect(await ports.conversationHostUnavailableSince!(launch.conversationId)).toBeTruthy();
    expect(await ports.conversationHostProcess!(launch.conversationId)).toMatchObject({ state: "gone" });
    expect(ports.conversationHostEnded!(launch.conversationId, launch.launchId)).toBe("exit: signal SIGKILL; no Delegatus stop recorded");
  } finally { setAgentRegistryForTests(null); registry.close(); fs.rmSync(binding, { recursive: true, force: true }); }
});

for (const sqliteMode of ["off", "sqlite"] as const) test(`a warmed pipeline projection retains reclaimed launch evidence (${sqliteMode})`, () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `reclaimed-exit-${sqliteMode}.json`), undefined, undefined, { sqliteMode });
  setAgentRegistryForTests(registry);
  const native = { pid: 2147482598, startIdentity: `reclaimed-exit-${sqliteMode}`, bootEpoch: "fixture-boot" };
  const next = { ...native, startIdentity: `successor-${sqliteMode}` };
  const key = { engine: "codex" as const, sessionId: `reclaimed-exit-${sqliteMode}` };
  const host = { kind: "codex-app-server" as const, process: native, exitProcess: native, endpoint: "stdio:fixture",
    eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: "open-turn", pendingAttention: [], activeFlags: [] };
  try {
    const launch = registry.beginSpawn("codex", "fixtures", { title: "Reclaimed native exit fixture" });
    registry.stageStructuredSpawn(launch.launchId, { key, artifactPath: "fixtures/reclaimed.jsonl", cwd: "fixtures", accountId: null,
      status: "dead", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: host });
    const ports = defaultPipelinePorts();
    expect(ports.conversationHostEnded!(launch.conversationId, launch.launchId)).toContain("status unavailable");
    withHostStopOrigin({ path: "pipeline-stage-stop", operationId: "reclaimed-exit-operation" }, () => recordHostStop(native, "SIGTERM", "fallback"));
    recordHostExit(native, 23, null);
    registry.setStructuredHost(key, { ...host, process: next, exitProcess: next });
    expect(registry.spawnReceipt(launch.launchId)?.hostExit?.exit?.code).toBe(23);
    const expected = "exit: code 23; stopped by pipeline-stage-stop (reclaimed-exit-operation)";
    expect(ports.conversationHostEnded!(launch.conversationId, launch.launchId)).toBe(expected);
    expect(defaultPipelinePorts().conversationHostEnded!(launch.conversationId, launch.launchId)).toBe(expected);
  } finally { setAgentRegistryForTests(null); registry.close(); }
});

for (const sqliteMode of ["off", "sqlite"] as const) test(`late predecessor exit stays bound to its pending launch before another mutation (${sqliteMode})`, () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `late-predecessor-${sqliteMode}.json`), undefined, undefined, { sqliteMode });
  const binding = fs.mkdtempSync(path.join(process.env.TMPDIR!, "late-predecessor-"));
  setAgentRegistryForTests(registry);
  const predecessor = { pid: 2147482595, startIdentity: `late-predecessor-${sqliteMode}`, bootEpoch: "fixture-boot" };
  const successor = { ...predecessor, startIdentity: `late-successor-${sqliteMode}` };
  const key = { engine: "codex" as const, sessionId: `late-predecessor-${sqliteMode}` };
  const host = { kind: "codex-app-server" as const, process: predecessor, exitProcess: predecessor, endpoint: "stdio:fixture",
    eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: "open-turn", pendingAttention: [], activeFlags: [] };
  try {
    const launch = registry.beginSpawn("codex", "fixtures", { title: "Late predecessor exit fixture" });
    registry.stageStructuredSpawn(launch.launchId, { key, artifactPath: "fixtures/late-predecessor.jsonl", cwd: "fixtures", accountId: null,
      status: "dead", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: host });
    bindHostExitWriter(binding, predecessor, captureProcessIdentity(process.pid));
    const warmed = defaultPipelinePorts();
    expect(warmed.conversationHostEnded!(launch.conversationId, launch.launchId)).toContain("status unavailable");
    registry.setStructuredHost(key, { ...host, process: successor, exitProcess: successor });
    expect(registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]?.pendingHostExits).toEqual([{ process: predecessor, launchId: launch.launchId }]);
    withHostStopOrigin({ path: "pipeline-stage-stop", operationId: "late-predecessor-operation" }, () => recordHostStop(predecessor, "SIGKILL", "fallback"));
    recordHostExit(predecessor, null, "SIGKILL");
    recordHostExit(successor, 99, null);
    expect(registry.spawnReceipt(launch.launchId)?.hostExit).toBeUndefined();
    const expected = "exit: signal SIGKILL; stopped by pipeline-stage-stop (late-predecessor-operation)";
    expect(warmed.conversationHostEnded!(launch.conversationId, launch.launchId)).toBe(expected);
    expect(defaultPipelinePorts().conversationHostEnded!(launch.conversationId, launch.launchId)).toBe(expected);
  } finally { setAgentRegistryForTests(null); registry.close(); fs.rmSync(binding, { recursive: true, force: true }); }
});

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


test.each(["preparation", "transport"] as const)("spawn admission rechecks its lane cutoff after %s yields", async boundary => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `deadline-registry-${boundary}.json`));
  setAgentRegistryForTests(registry);
  let clock = 1_000;
  const monotonic = spyOn(performance, "now").mockImplementation(() => clock);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "claude", accountId: "fixture-account", kind: "managed", home: process.env.LLV_STATE_DIR!,
    transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  }});
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  let dispatched = false;
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    await Promise.resolve();
    clock += 3_000;
    await input.authorize?.();
    dispatched = true;
    return { path: null } as never;
  });
  let reservations = 0;
  try {
    await expect(defaultPipelinePorts().spawnAgent({
      role: { roleId: "builder", engine: "claude", model: "fable", effort: "high", access: "read-write", promptScaffold: "" },
      runtimeProfile: { access: "read-write", sandbox: "full" }, cwd: process.env.LLV_STATE_DIR!,
      project: "repo-00000000000000000000000000000001", requestedAccountId: null,
      title: "Build", prompt: "Build", parentPath: null, clientAttemptId: `lane_deadline_${boundary}`,
      spawnAdmissionDeadline: clock + 3_000,
      membership: { kind: "pipeline", containerId: "deadline-lane", role: "builder", slot: "build:1",
        stageId: "build", stageOrder: 0, round: 1, parentConversationId: null }, creatorConversationId: null,
    }, async () => {
      if (++reservations === 2 && boundary === "preparation") {
        await Promise.resolve(); clock += 3_000;
      }
    })).rejects.toThrow("lane deadline exhausted");
    expect(dispatched).toBe(false);
    expect(spawn.mock.calls.length).toBe(boundary === "preparation" ? 0 : 1);
    const receipt = registry.spawnReceiptForClientAttempt(`lane_deadline_${boundary}`);
    if (boundary === "preparation") expect(receipt?.state).toBe("failed");
  } finally {
    monotonic.mockRestore(); resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); spawn.mockRestore();
    setAgentRegistryForTests(null); registry.close();
  }
});
