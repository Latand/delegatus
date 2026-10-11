import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stage-spawn-restart-"));
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { captureProcessIdentity } = await import("@/lib/processIdentity");
const { RuntimeHostUnavailableError } = await import("@/lib/runtime/client");
const { recoverStagedStructuredLaunch, spawnStructuredConversation, stagedLaunchRecovery, STAGED_RECOVERY_BUDGET_MS } = await import("@/lib/runtime/structuredSpawn");
const { createPipelineFromRequest, defaultPipelinePorts, patchPipeline, tickPipelines } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
const { registerPipelineTick } = await import("./controllerSignal");
type PipelinePorts = import("./engine").PipelinePorts;
type RuntimeHostClient = import("@/lib/runtime/client").RuntimeHostClient;
type RuntimeOperationResult = import("@/lib/runtime/contracts").RuntimeOperationResult;

registerPipelineTick(async () => {});
afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const HEAD = "a".repeat(40);

async function fixture(unstaged = false, admissionRestarts = 0) {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "launch-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  let clock = Date.now();
  let unavailable = true;
  let starts = 0;
  let messages = 0;
  let probes = 0;
  let launchId = "";
  let artifactPath = "";
  const restartDuringAdmission = admissionRestarts > 0;
  const operations = new Map<string, RuntimeOperationResult>();
  const record = (id: string, conversationId: string, status: "queued" | "delivered") => {
    const result = { receipt: { operationId: id, conversationId, status }, replayed: false } as RuntimeOperationResult;
    operations.set(id, result);
    return result;
  };
  const client = {
    command: async (command) => {
      if (admissionRestarts-- > 0) {
        expect(starts).toBe(0);
        throw new RuntimeHostUnavailableError("runtime host is unavailable");
      }
      if (restartDuringAdmission) unavailable = false;
      return record(command.operationId!, command.conversationId!, "queued");
    },
    operationStatus: async (id) => {
      probes++;
      if (unavailable) throw new RuntimeHostUnavailableError("runtime host is unavailable");
      return operations.get(id) ?? null;
    },
    transitionOperation: async (id, status) => record(id, operations.get(id)!.receipt.conversationId, status as "delivered"),
  } as RuntimeHostClient;
  const real = () => defaultPipelinePorts();
  const ports: PipelinePorts = {
    exec: async (_command, args) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "remote") return { code: 0, stdout: "https://forge.example/repo.git\n", stderr: "" };
      if (args[0] === "ls-remote") return { code: 0, stdout: `${HEAD}\trefs/heads/${loadPipelines()[0]?.branch}\n`, stderr: "" };
      return { code: 0, stdout: args[0] === "rev-parse" ? `${HEAD}\n` : "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: () => ({ engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: "Builder guidance" }),
    spawnAgent: async (input, reserve) => {
      const profile = emptyLaunchProfile({ cwd: root });
      const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: root, transport: "structured", launchProfile: profile, memberships: [input.membership] });
      if (begun.kind !== "created") throw new Error("fixture launch was not created");
      launchId = begun.receipt.launchId;
      await reserve({ launchId, conversationId: begun.receipt.conversationId });
      if (unstaged) {
        registry.releaseStructuredSpawnAdmissionOwner(launchId, begun.receipt.admissionOwner!);
        registry.preserveSpawnArtifactOwnership(launchId, "structured launch recovery: " + JSON.stringify({
          phase: "unpublished", startedAt: clock, checks: 0, nextTryAt: clock, reason: "runtime host is unavailable",
        }));
        return { launchId, conversationId: begun.receipt.conversationId, sessionId: null, transcript: null, paneId: null };
      }
      artifactPath = path.join(root, `${starts + 1}.jsonl`);
      const threadId = randomUUID();
      const response = await spawnStructuredConversation({ engine: "codex", receipt: begun.receipt, registry, client, prompt: "Build",
        spec: { engine: "codex", command: "codex", cwd: root, windowName: "fixture", launchProfile: profile },
        account: { engine: "codex", accountId: "account-a", kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" } },
      }, {
        now: () => clock,
        sleep: async ms => { clock += ms; },
        startHost: async () => {
          starts++;
          return { identity: { threadId, path: artifactPath }, health: async () => ({ status: "idle" }), release: async () => {},
            sessionMaterializationEvidence: async () => ({ state: "materialized" }),
          } as unknown as import("@/lib/runtime/structuredSpawn").SpawnedStructuredHost;
        },
        bindHost: async (store, key, _host, owner, epoch) => {
          const entry = store.readOnlySnapshot().entries[`codex:${key.sessionId}`]!;
          store.setStructuredHostClaimed(key, { ...entry.structuredHost!, process: captureProcessIdentity(process.pid) }, "idle", owner, epoch);
          return () => {};
        },
        publishHost: async () => {
          if (unavailable) throw new RuntimeHostUnavailableError("runtime host is unavailable");
          return async () => {};
        },
        deliverFirst: async () => {
          messages++;
          record(`spawn_message_${launchId}`, begun.receipt.conversationId, "delivered");
          fs.writeFileSync(artifactPath, JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n");
        },
      });
      return { launchId, conversationId: begun.receipt.conversationId, sessionId: null, transcript: response.path ?? null, paneId: null };
    },
    spawnReceipt: id => real().spawnReceipt(id),
    spawnReceiptState: id => registry.readOnlySnapshot().receipts[id]?.state ?? null,
    failStageLaunch: (id, conversation, reason) => real().failStageLaunch!(id, conversation, reason),
    claimSpawnRetry: (id, claim) => real().claimSpawnRetry(id, claim),
    recoverStagedLaunch: async (id, eligible) => { await recoverStagedStructuredLaunch(id, registry, client, { eligible, now: () => clock }); },
    paneAgentAlive: async () => false,
    stopStageAgent: async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "not-running" }),
    stageHostResident: async () => false,
    conversationAgentActive: async () => null,
    conversationHostProcess: id => real().conversationHostProcess!(id),
    transcriptPresent: pathname => fs.existsSync(pathname),
    pathForConversation: () => null,
    pipelineAdoptionCandidates: () => [],
    sourcePathAllowed: pathname => pathname === "/codex/creator.jsonl",
    conversationIdForPath: () => "conversation_creator",
    durableTurnEvidence: async () => null,
    lastMessage: () => null,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    createFlow: async () => ({ error: "fixture has no flow" }),
    patchFlow: () => ({}), closeFlow: async () => ({}), getFlow: () => null, findFlow: () => null,
    projectForCwd: () => "viewer",
    worktreePresent: () => true,
    scheduleTick: () => {},
    now: () => new Date(clock).toISOString(), monotonicNow: () => clock,
  };
  const created = await createPipelineFromRequest({ task: "Recover the stage launch", spec: "Recover or safely retry", publication: "internal", repoDir: root, src: "/codex/creator.jsonl",
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, prompt: "Verify", next: null },
    ],
  }, ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], ports);
  await tickPipelines([], ports);
  if (!launchId) throw new Error(loadPipelines()[0]?.stateDetail ?? "fixture stage did not launch");
  const original = registry.readOnlySnapshot().receipts[launchId]!;
  if (!unstaged && !original.key) throw new Error(original.error ?? loadPipelines()[0]?.stateDetail ?? "fixture host was not bound");
  const attempt = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;
  const park = () => {
    const pipelines = loadPipelines();
    const pipeline = pipelines[0]!;
    const a = pipeline.runs[0]!.attempts[0]!;
    // Older controllers rebound the reserved identity before the file existed.
    a.agentPath = original.artifactPath;
    a.sessionId = original.key?.sessionId ?? null;
    a.state = "needs_decision";
    a.error = "stage spawn recovery stopped: runtime host recovery exhausted after 0 checks; original launch retained";
    pipeline.state = "needs_decision";
    pipeline.stateDetail = a.error;
    savePipelines(pipelines);
  };
  const loseHost = () => {
    const entry = registry.readOnlySnapshot().entries[`codex:${original.key!.sessionId}`]!;
    registry.upsert({ ...entry, claimOwner: null, status: "dead", structuredHost: { ...entry.structuredHost!, process: null } });
  };
  return { registry, client, ports, original, attempt, park, loseHost,
    advance: (ms: number) => { clock += ms; }, restore: () => { unavailable = false; },
    starts: () => starts, messages: () => messages, probes: () => probes };
}

test("a stage launch interrupted before its first message recovers after the runtime host returns", async () => {
  const f = await fixture();
  try {
    expect(f.attempt().state).toBe("spawning");
    expect(f.messages()).toBe(0);
    f.advance(61_000);
    await tickPipelines([], f.ports);
    expect(f.attempt().state).toBe("spawning");
    f.restore();
    for (let n = 0; n < 2; n++) { f.advance(61_000); await tickPipelines([], f.ports); }
    expect(f.attempt()).toMatchObject({ state: "running", launchId: f.original.launchId, spawnCalls: 1 });
    expect(f.starts()).toBe(1);
    expect(f.messages()).toBe(1);
  } finally { setAgentRegistryForTests(null); }
});

test("a runtime host restart before native spawn completes the original launch once the host returns", async () => {
  const f = await fixture(false, 3);
  try {
    expect(f.attempt()).toMatchObject({ state: "running", launchId: f.original.launchId, spawnCalls: 1 });
    expect(f.starts()).toBe(1);
    expect(f.messages()).toBe(1);
  } finally { setAgentRegistryForTests(null); }
});

test("a controller without the lost host still probes recovery, including a first check after restart downtime", async () => {
  const f = await fixture();
  try {
    f.loseHost();
    f.advance(STAGED_RECOVERY_BUDGET_MS + 1_000);
    await tickPipelines([], f.ports);
    expect(f.probes()).toBeGreaterThan(0);
    expect(stagedLaunchRecovery(f.registry.readOnlySnapshot().receipts[f.original.launchId])?.checks).toBe(1);
    expect(loadPipelines()[0]!.state).toBe("running");
    f.restore();
    f.advance(61_000);
    await tickPipelines([], f.ports);
    expect(stagedLaunchRecovery(f.registry.readOnlySnapshot().receipts[f.original.launchId])?.checks).toBe(2);
  } finally { setAgentRegistryForTests(null); }
});

test.each([false, true])("an exhausted launch with a missing reserved transcript permits retry-stage (explicit launch: %s)", async explicit => {
  const f = await fixture();
  try {
    f.loseHost(); f.park();
    const request = { action: "retry-stage" as const, ...(explicit ? { stageId: "build", launchId: f.original.launchId } : {}) };
    const result = await patchPipeline(loadPipelines()[0]!.id, request, f.ports);
    expect(result.error).toBeUndefined();
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.state).toBe("failed");
    await tickPipelines([], f.ports);
    const next = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(next.n).toBe(2);
    expect(next.launchId).not.toBe(f.original.launchId);
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.retryClaim).toBeDefined();
    expect(f.registry.recoverStructuredSpawnFromEvidence(f.original.launchId).kind).toBe("conflict");
  } finally { setAgentRegistryForTests(null); }
});

test("retry-stage keeps a launch with a live host fenced even when its reserved transcript is absent", async () => {
  const f = await fixture();
  try {
    f.park();
    const result = await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, f.ports);
    expect(result.error).toContain("path-pending");
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.state).toBe("path-pending");
    expect(f.starts()).toBe(1);
  } finally { setAgentRegistryForTests(null); }
});

test("a transcript arriving at the registry failure boundary cancels the retry", async () => {
  const f = await fixture();
  const fail = f.registry.failNeverStartedStageSpawnNow.bind(f.registry);
  const boundary = spyOn(f.registry, "failNeverStartedStageSpawnNow").mockImplementation((...args) => {
    fs.writeFileSync(f.original.artifactPath!, "{}\n");
    return fail(...args);
  });
  try {
    f.loseHost(); f.park();
    const result = await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, f.ports);
    expect(result.error).toContain("path-pending");
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.state).toBe("path-pending");
    expect(f.starts()).toBe(1);
  } finally { boundary.mockRestore(); setAgentRegistryForTests(null); }
});

test("a queued first-message lookup fences replacement by a controller that lost its host", async () => {
  const f = await fixture();
  const lookup = f.client.operationStatus.bind(f.client);
  f.client.operationStatus = async id => id === `spawn_message_${f.original.launchId}`
    ? { receipt: { operationId: id, conversationId: f.original.conversationId, status: "queued" }, replayed: false } as RuntimeOperationResult
    : lookup(id);
  try {
    f.loseHost(); f.restore();
    f.advance(61_000);
    await tickPipelines([], f.ports);
    expect(stagedLaunchRecovery(f.registry.readOnlySnapshot().receipts[f.original.launchId])?.phase).toBe("uncertain");
    f.park();
    const result = await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, f.ports);
    expect(result.error).toContain("path-pending");
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.retryClaim).toBeUndefined();
  } finally { setAgentRegistryForTests(null); }
});

test.each(["uncertainty", "writer"] as const)("recovery retains newer %s recorded at its persistence boundary", async boundary => {
  const f = await fixture();
  const persist = f.registry.preserveSpawnArtifactOwnership.bind(f.registry);
  let raced = false;
  const seam = spyOn(f.registry, "preserveSpawnArtifactOwnership").mockImplementation((...args) => {
    const incoming = stagedLaunchRecovery({ error: args[1] });
    if (!raced && incoming?.checks === 1 && incoming.phase === "unpublished") {
      raced = true;
      if (boundary === "writer") {
        expect(f.registry.claimStructuredHost(f.original.key!, captureProcessIdentity(process.pid), { allowUnhosted: true })).not.toBeNull();
      } else {
        const latest = stagedLaunchRecovery(f.registry.readOnlySnapshot().receipts[f.original.launchId])!;
        persist(f.original.launchId, "structured launch recovery: " + JSON.stringify({ ...latest, phase: "uncertain", reason: "first-message dispatch is unconfirmed" }));
      }
    }
    return persist(...args);
  });
  try {
    f.loseHost(); f.restore(); f.advance(61_000);
    await tickPipelines([], f.ports);
    expect(raced).toBe(true);
    expect(stagedLaunchRecovery(f.registry.readOnlySnapshot().receipts[f.original.launchId])).toMatchObject({
      phase: boundary === "writer" ? "unpublished" : "uncertain", checks: 0,
    });
    f.park();
    expect((await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, f.ports)).error).toContain("path-pending");
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.retryClaim).toBeUndefined();
  } finally { seam.mockRestore(); setAgentRegistryForTests(null); }
});

test("retry-stage replaces an exhausted reservation with no transcript, host or registry generation", async () => {
  const f = await fixture(true);
  try {
    f.park();
    expect(f.original.key).toBeNull();
    expect(f.registry.readOnlySnapshot().conversations[f.original.conversationId]?.generations ?? []).toHaveLength(0);
    const result = await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage", stageId: "build", launchId: f.original.launchId }, f.ports);
    expect(result.error).toBeUndefined();
    await tickPipelines([], f.ports);
    const next = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(next.n).toBe(2);
    expect(next.launchId).not.toBe(f.original.launchId);
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.retryClaim).toBeDefined();
  } finally { setAgentRegistryForTests(null); }
});

test("recovery exhaustion with no agent settles the receipt and retry-stage launches a fresh attempt", async () => {
  const f = await fixture(true);
  try {
    for (let n = 0; n < 11; n++) { f.advance(61_000); await tickPipelines([], f.ports); }
    expect(f.probes()).toBeGreaterThan(0);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.state).toBe("failed");
    const result = await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, f.ports);
    expect(result.error).toBeUndefined();
    await tickPipelines([], f.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: 2, spawnCalls: 1 });
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.launchId).not.toBe(f.original.launchId);
  } finally { setAgentRegistryForTests(null); }
});

test.each(["uncertain", "delivered", "transcript", "unverified", "survivor", "replacement", "same-path"] as const)("retry preserves %s evidence that an agent might exist", async evidence => {
  const f = await fixture();
  try {
    f.loseHost(); f.park();
    if (evidence === "uncertain" || evidence === "delivered") {
      const recovery = stagedLaunchRecovery(f.registry.readOnlySnapshot().receipts[f.original.launchId])!;
      f.registry.preserveSpawnArtifactOwnership(f.original.launchId, "structured launch recovery: " + JSON.stringify({ ...recovery, phase: evidence }));
    } else if (evidence === "transcript") {
      fs.writeFileSync(f.original.artifactPath!, "{}\n");
    } else {
      const entry = f.registry.readOnlySnapshot().entries[`codex:${f.original.key!.sessionId}`]!;
      f.registry.upsert({ ...entry, ...(evidence === "same-path"
        ? { key: { engine: "codex", sessionId: randomUUID() }, status: "idle", structuredHost: { ...entry.structuredHost!, process: captureProcessIdentity(process.pid) } }
        : evidence === "unverified"
        ? { structuredHost: { ...entry.structuredHost!, process: { pid: process.pid, startIdentity: null } } }
        : evidence === "replacement" ? { structuredHostOperationId: "other" }
        : { structuredTerminationSurvivors: [captureProcessIdentity(process.pid)] }) });
    }
    const result = await patchPipeline(loadPipelines()[0]!.id, { action: "retry-stage" }, f.ports);
    expect(result.error).toContain("path-pending");
    expect(f.registry.readOnlySnapshot().receipts[f.original.launchId]?.retryClaim).toBeUndefined();
    expect(f.starts()).toBe(1);
  } finally { setAgentRegistryForTests(null); }
});
