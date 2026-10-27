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
const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);

const { createManagedClaudeAccount, sharedClaudeProjectsRoot } = await import("@/lib/accounts/claude");
const { AgentRegistry, setAgentRegistryForTests, identityMaterializationFence, normalizeRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { captureProcessIdentity } = await import("@/lib/processIdentity");
const { defaultPipelinePorts, resolvePipelineCreatorLineage } = await import("@/lib/pipelines/engine");
const { loadPipelines } = await import("@/lib/pipelines/store");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { viewerMcpBindings, viewerMcpRecoverableTools } = await import("./bindings");
const { runAsMcpHttpCaller } = await import("./callerContext");
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

test.each(["off", "sqlite"] as const)("a completed account-local resume publishes pipeline src despite a stale launch (%s)", async (sqliteMode) => {
  const directory = path.join(sandbox, sqliteMode);
  fs.mkdirSync(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-27T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-27T10:00:00Z" } }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture.invalid", "commit", "-q", "--allow-empty", "-m", "Fixture base");
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode });
  setAgentRegistryForTests(registry);
  const sessionId = sqliteMode === "off" ? "00000000-0000-0000-0000-000000000001" : "00000000-0000-0000-0000-000000000002";
  const transcript = path.join(account.projectsDir, `-fixture-${sqliteMode}`, `${sessionId}.jsonl`);
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

    const project = projectForCwd(directory)!;
    const intent = { project, clientRequestId: `creator-seat-${sqliteMode}` };
    beginOrchestratorSeatIntent({ ...intent, mandate: "Own fixture work", mode: "existing", conversationId: launch.receipt.conversationId });
    completeOrchestratorSeatIntent({ ...intent, conversationId: launch.receipt.conversationId, path: transcript });
    const capability = registry.rotateSpawnCapabilityForReceipt(resume.receipt.launchId);
    const service = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore(), undefined, { recovery: viewerMcpRecoverableTools() });
    const args = { task: "Exercise account creator", spec: "Retain authenticated lineage", repoDir: directory,
      baseRef: git("rev-parse", "HEAD"), autoStart: false, stages: [{ id: "build", kind: "run", prompt: "Build fixture", next: null }] };
    for (const source of ["explicit", "inferred"] as const) {
      const answer = await runAsMcpHttpCaller({ capability }, () => service.callTool("create_pipeline", {
        ...args, clientRequestId: `${sqliteMode}-${source}`, ...(source === "explicit" ? { src: transcript } : {}),
      }));
      expect(answer.ok, JSON.stringify(answer)).toBe(true);
      if (!answer.ok) throw new Error(answer.error);
      expect(loadPipelines().find(row => row.id === answer.pipelineId)).toMatchObject({ srcPath: transcript, srcConversationId: launch.receipt.conversationId });
    }
    const count = loadPipelines().length;
    for (const source of ["explicit", "inferred"] as const) {
      const refused = await runAsMcpHttpCaller({ capability: "invalid-fixture-capability" }, () => service.callTool("create_pipeline", {
        ...args, clientRequestId: `${sqliteMode}-unidentified-${source}`, ...(source === "explicit" ? { src: transcript } : {}),
      }));
      expect(refused).toMatchObject({ ok: false, code: "caller_unidentified" });
    }
    expect(loadPipelines()).toHaveLength(count);

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
  } finally {
    setAgentRegistryForTests(null);
    registry.close();
  }
});
