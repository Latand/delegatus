import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-creator-source-"));
for (const name of ["STATE_DIR", "AGENT_REGISTRY_SQLITE", "SPAWN_CAPABILITY", "VIEWER_CONTROL_URL", "RUNTIME_HOST_SOCKET"]) {
  delete process.env[`DELEGATUS_${name}`];
  delete process.env[`LLV_${name}`];
}
for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_CLAUDE_HOME", "LLV_CODEX_HOME", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.LLV_STATE_DIR = path.join(process.env.XDG_CONFIG_HOME!, "delegatus", "state");
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
setSystemTime(new Date("2026-10-27T10:00:00Z"));
let sequence = 0;
const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `${(++sequence).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);

const { createManagedClaudeAccount, sharedClaudeProjectsRoot } = await import("@/lib/accounts/claude");
const { AgentRegistry, setAgentRegistryForTests, identityMaterializationFence, normalizeRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { captureProcessIdentity } = await import("@/lib/processIdentity");
const { defaultPipelinePorts, resolvePipelineCreatorLineage } = await import("@/lib/pipelines/engine");
const { loadTasks } = await import("@/lib/tasks/store");
const { beginDeputy, recordDeputyFork, activateDeputy } = await import("@/lib/orchestrator/deputies");
const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
const { loadPipelines } = await import("@/lib/pipelines/store");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { viewerMcpBindings, viewerMcpRecoverableTools, productionDomainDependencies } = await import("./bindings");
const { runAsMcpHttpCaller } = await import("./callerContext");
const { NextRequest } = await import("next/server");
const { soloBrowserSession } = await import("@/lib/agent/operatorSession");
const { POST: createPipelineHttp } = await import("@/app/api/pipelines/route");
const { projectForCwd } = await import("@/lib/scanner/describe");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const unregisterTick = registerPipelineTick(async () => {});
const account = createManagedClaudeAccount("Account B", undefined, { id: "fixture-secondary" });

afterAll(() => {
  unregisterTick();
  setAgentRegistryForTests(null);
  ids.mockRestore();
  setSystemTime();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const scenarios = (["off", "sqlite"] as const).flatMap(mode =>
  (["own", "foreign", "archived", "deputy"] as const).map(source => [mode, source] as const));
test.each(scenarios)("authenticated account-local pipeline creator (%s, %s)", async (sqliteMode, source) => {
  const directory = path.join(sandbox, `${sqliteMode}-${source}`);
  fs.mkdirSync(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-27T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-27T10:00:00Z" } }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture.invalid", "commit", "-q", "--allow-empty", "-m", "Fixture base");
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode });
  setAgentRegistryForTests(registry);
  const sessionId = sqliteMode === "off" ? "00000000-0000-0000-0000-000000000001" : "00000000-0000-0000-0000-000000000002";
  const transcript = path.join(account.projectsDir, `-fixture-${sqliteMode}-${source}`, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", sessionId, cwd: directory, message: { role: "user", content: "Fixture" } }) + "\n");
  const launchProfile = emptyLaunchProfile({ title: "Exercise creator source", cwd: directory, project: projectForCwd(directory) });
  const entry = { key: { engine: "claude" as const, sessionId }, artifactPath: transcript, cwd: directory,
    accountId: account.id, launchProfile, status: "live" as const, host: null,
    structuredHost: { kind: "claude-broker" as const, endpoint: "fixture", process: captureProcessIdentity(process.pid),
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "fixture-writer", pendingAction: "spawn" as const };
  try {
    const launch = registry.beginSpawnRequest({ engine: "claude", transport: "structured", cwd: directory,
      role: "orchestrator", accountId: account.id, origin: { kind: "operator" }, launchProfile });
    if (launch.kind !== "created") throw new Error("fixture launch was refused");
    expect(registry.stageStructuredSpawn(launch.receipt.launchId, entry).kind).toBe("settled");
    expect(registry.spawnReceipt(launch.receipt.launchId)?.state).toBe("path-pending");
    const ports = defaultPipelinePorts();
    expect(ports.sourcePathAllowed(transcript)).toBe(true);
    expect(fs.existsSync(sharedClaudeProjectsRoot())).toBe(false);
    expect(resolvePipelineCreatorLineage(transcript, ports).error).toStartWith("src conversation does not exist.");

    const resume = registry.beginSpawnRequest({ engine: "claude", transport: "structured", cwd: directory,
      purpose: "resume-successor", conversationId: launch.receipt.conversationId, accountId: account.id, launchProfile });
    if (resume.kind !== "created") throw new Error("fixture resume was refused");
    expect(registry.stageStructuredSpawn(resume.receipt.launchId, entry).kind).toBe("settled");
    expect(registry.finalizeStructuredSpawn(resume.receipt.launchId).kind).toBe("settled");
    // Finalizing a successor leaves the original launch receipt untouched.
    expect(registry.spawnReceipt(launch.receipt.launchId)?.state).toBe("path-pending");
    const completed = defaultPipelinePorts();
    expect(resolvePipelineCreatorLineage(transcript, completed)).toEqual({ lineage: {
      srcPath: transcript, srcConversationId: launch.receipt.conversationId,
    } });
    expect(completed.pathForConversation(launch.receipt.conversationId)).toBe(transcript);
    const restarted = execFileSync(process.execPath, ["-e", `
      const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry");
      const { defaultPipelinePorts } = await import("./src/lib/pipelines/engine");
      const registry = new AgentRegistry(${JSON.stringify(registry.filename)}, undefined, undefined, { sqliteMode: ${JSON.stringify(sqliteMode)} });
      setAgentRegistryForTests(registry);
      process.stdout.write(JSON.stringify(defaultPipelinePorts().conversationIdForPath(${JSON.stringify(transcript)})));
      registry.close();
    `], { encoding: "utf8", timeout: 30_000 });
    expect(JSON.parse(restarted)).toBe(launch.receipt.conversationId);
    // A held snapshot remains private after finalization elsewhere.
    expect(ports.conversationIdForPath(transcript)).toBeNull();

    let callerPath = transcript;
    let callerConversation = launch.receipt.conversationId;
    let callerLaunch = resume.receipt.launchId;
    if (source === "foreign" || source === "deputy") {
      const otherSession = sqliteMode === "off" ? "00000000-0000-0000-0000-000000000011" : "00000000-0000-0000-0000-000000000012";
      const otherPath = path.join(path.dirname(transcript), `${otherSession}.jsonl`);
      fs.writeFileSync(otherPath, JSON.stringify({ type: "user", sessionId: otherSession, cwd: directory, message: { role: "user", content: "Other" } }) + "\n");
      const other = registry.beginSpawnRequest({ engine: "claude", transport: "structured", cwd: directory, role: "orchestrator",
        accountId: account.id, origin: { kind: "operator" }, launchProfile });
      if (other.kind !== "created") throw new Error("other launch refused");
      expect(registry.stageStructuredSpawn(other.receipt.launchId, { ...entry, key: { engine: "claude", sessionId: otherSession }, artifactPath: otherPath }).kind).toBe("settled");
      expect(registry.finalizeStructuredSpawn(other.receipt.launchId).kind).toBe("settled");
      callerPath = otherPath;
      callerConversation = other.receipt.conversationId;
      callerLaunch = other.receipt.launchId;
    }
    if (source === "archived") {
      const nextSession = sqliteMode === "off" ? "00000000-0000-0000-0000-000000000021" : "00000000-0000-0000-0000-000000000022";
      const nextPath = path.join(path.dirname(transcript), `${nextSession}.jsonl`);
      fs.writeFileSync(nextPath, JSON.stringify({ type: "user", sessionId: nextSession, cwd: directory, message: { role: "user", content: "Successor" } }) + "\n");
      const operationId = `generation-migration-${sqliteMode}`;
      const providerReceipt = { operationId, nativeId: nextSession, path: nextPath, continuityPaths: [], historyHash: "fixture",
        host: { kind: "claude-stream" as const, identity: "successor-host", epoch: 1, verifiedAt: new Date().toISOString() } };
      registry.setConversationMigration(launch.receipt.conversationId, { intentId: "fixture-migration", phase: "verifying", targetId: account.id,
        revision: 1, error: null, operationId, providerReceipt, updatedAt: new Date().toISOString() });
      registry.commitSuccessor(launch.receipt.conversationId, { id: nextSession, path: nextPath, accountId: account.id }, 1, operationId, providerReceipt);
      const nextResume = registry.beginSpawnRequest({ engine: "claude", transport: "structured", cwd: directory, purpose: "resume-successor",
        conversationId: launch.receipt.conversationId, accountId: account.id, launchProfile });
      if (nextResume.kind !== "created") throw new Error("successor resume refused");
      expect(registry.stageStructuredSpawn(nextResume.receipt.launchId, { ...entry, key: { engine: "claude", sessionId: nextSession }, artifactPath: nextPath }).kind).toBe("settled");
      expect(registry.finalizeStructuredSpawn(nextResume.receipt.launchId).kind).toBe("settled");
      expect(registry.conversationForPath(transcript)?.generations.at(-1)?.path).toBe(nextPath);
      expect(registry.conversationForPath(transcript)?.generations.find(g => g.path === transcript)?.archivedAt).not.toBeNull();
      callerPath = nextPath;
      callerLaunch = nextResume.receipt.launchId;
    }
    const project = projectForCwd(directory)!;
    const intent = { project, clientRequestId: `creator-seat-${sqliteMode}-${source}` };
    beginOrchestratorSeatIntent({ ...intent, mandate: "Own fixture work", mode: "existing", conversationId: source === "deputy" ? launch.receipt.conversationId : callerConversation });
    completeOrchestratorSeatIntent({ ...intent, conversationId: source === "deputy" ? launch.receipt.conversationId : callerConversation, path: source === "deputy" ? transcript : callerPath });
    if (source === "deputy") {
      const begun = beginDeputy({ project, seatConversationId: launch.receipt.conversationId,
        seatEpoch: orchestratorSeatFor(project).active!.seatEpoch, seatPath: transcript,
        clientRequestId: `deputy-${sqliteMode}`, ask: { text: "Exercise deputy lineage", images: 0, sender: null } });
      if (begun.kind !== "begun") throw new Error("fixture deputy was refused");
      recordDeputyFork(begun.deputy.askId, { deputyConversationId: callerConversation, artifactPath: callerPath, forkRecordCount: 0 });
      expect(activateDeputy(begun.deputy.askId)?.state).toBe("active");
    }
    const capability = registry.rotateSpawnCapabilityForReceipt(callerLaunch);
    const service = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore(), undefined, { recovery: viewerMcpRecoverableTools() });
    const args = { task: "Exercise account creator", spec: "Retain authenticated lineage", repoDir: directory,
      baseRef: git("rev-parse", "HEAD"), autoStart: false, stages: [{ id: "build", kind: "run", prompt: "Build fixture", next: null }] };
    const beforeCreates = loadPipelines().length;
    for (const selection of ["explicit", "inferred"] as const) {
      const answer = await runAsMcpHttpCaller({ capability }, () => service.callTool("create_pipeline", {
        ...args, clientRequestId: `${sqliteMode}-${source}-${selection}`, ...(selection === "explicit" ? { src: callerPath } : {}),
      }));
      expect(answer.ok, JSON.stringify(answer)).toBe(true);
      if (!answer.ok) throw new Error(answer.error);
      expect(loadPipelines().find(row => row.id === answer.pipelineId)).toMatchObject(source === "deputy"
        ? { srcPath: transcript, srcConversationId: launch.receipt.conversationId, srcDeputyConversationId: callerConversation }
        : { srcPath: callerPath, srcConversationId: callerConversation });
    }
    expect(loadPipelines()).toHaveLength(beforeCreates + 2);
    const count = loadPipelines().length;
    for (const selection of ["explicit", "inferred"] as const) {
      const refused = await runAsMcpHttpCaller({ capability: "invalid-fixture-capability" }, () => service.callTool("create_pipeline", {
        ...args, clientRequestId: `${sqliteMode}-${source}-unidentified-${selection}`, ...(selection === "explicit" ? { src: callerPath } : {}),
      }));
      expect(refused).toMatchObject({ ok: false, code: "caller_unidentified" });
    }
    expect(loadPipelines()).toHaveLength(count);

    if (source === "foreign" || source === "archived") {
      for (const recoverable of [true, false]) {
        const receipts = new MemoryMcpReceiptStore();
        const claim = spyOn(receipts, "claim");
        const boundary = createMcpToolService(viewerMcpBindings(), receipts, undefined,
          recoverable ? { recovery: viewerMcpRecoverableTools() } : {});
        const tasks = loadTasks();
        const pipelines = loadPipelines();
        const queued = () => fs.readdirSync(path.join(process.env.LLV_STATE_DIR!, "pipeline-creation-queue"), { recursive: true, encoding: "utf8" });
        const queueBefore = fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "pipeline-creation-queue")) ? queued() : [];
        const refused = await runAsMcpHttpCaller({ capability }, () => boundary.callTool("create_pipeline", {
          ...args, src: transcript, clientRequestId: `${sqliteMode}-${source}-hostile-${recoverable}`,
        }));
        expect(refused).toMatchObject({ ok: false, code: "caller_source_mismatch" });
        expect(claim).not.toHaveBeenCalled();
        expect(loadPipelines()).toEqual(pipelines);
        expect(loadTasks()).toEqual(tasks);
        expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "pipeline-creation-queue")) ? queued() : []).toEqual(queueBefore);
        claim.mockRestore();
      }
      // The older HTTP surface also refuses these agent-originated writes.
      const pipelines = loadPipelines();
      const tasks = loadTasks();
      const response = await createPipelineHttp(new NextRequest("http://127.0.0.1/api/pipelines", {
        method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json",
          cookie: `llv_operator=${soloBrowserSession()}`, "x-llv-spawn-capability": capability },
        body: JSON.stringify({ ...args, src: transcript }),
      }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
      expect(loadPipelines()).toEqual(pipelines);
      expect(loadTasks()).toEqual(tasks);
      return;
    }
    // A completed record must attest to the exact withheld identity.
    const original = registry.snapshot();
    for (const mismatch of ["conversation", "key", "path", "unfinished"] as const) {
      const hostile = normalizeRegistry(structuredClone(original));
      const receipt = hostile.receipts[resume.receipt.launchId]!;
      if (mismatch === "conversation") receipt.conversationId = "conversation_foreign";
      if (mismatch === "key") receipt.key = { engine: "claude", sessionId: "00000000-0000-0000-0000-000000000003" };
      if (mismatch === "path") receipt.artifactPath = transcript + ".foreign";
      if (mismatch === "unfinished") receipt.state = "path-pending";
      const fence = identityMaterializationFence(hostile);
      expect(fence.allowsPath(transcript), mismatch).toBe(false);
      expect(fence.pathForConversation(launch.receipt.conversationId), mismatch).toBeNull();
      expect(fence.allowsReceipt(hostile.receipts[launch.receipt.launchId]!)).toBe(false);
    }
    if (source === "own") {
      // Change the assumed generation while each launch resolver is awaiting.
      for (const boundary of ["binding", "recovery"] as const) {
        const observed = structuredClone(registry.snapshot());
        const domain = { ...productionDomainDependencies, registrySnapshot: () => observed };
        const before = loadPipelines();
        const tasks = loadTasks();
        const pending = runAsMcpHttpCaller({ capability }, () => boundary === "binding"
          ? viewerMcpBindings(undefined, undefined, domain).create_pipeline({ ...args, src: transcript, clientRequestId: `race-${boundary}-${sqliteMode}` })
          : viewerMcpRecoverableTools(domain).create_pipeline!.bind({ ...args, src: transcript, clientRequestId: `race-${boundary}-${sqliteMode}` }));
        const generations = observed.conversations[callerConversation]!.generations;
        generations.push({ ...generations[0]!, id: "successor", path: transcript + ".successor" });
        await expect(pending).rejects.toMatchObject({ details: { code: "caller_source_mismatch" } });
        expect(loadPipelines()).toEqual(before);
        expect(loadTasks()).toEqual(tasks);
      }
    }
  } finally {
    setAgentRegistryForTests(null);
    registry.close();
  }
});
