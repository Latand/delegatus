import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "seat-launch-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const { AgentRegistry } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");

test.each(["orchestrator", "maintainer"])("%s admission carries a text-free role selector", role => {
  const registry = new AgentRegistry(path.join(sandbox, `${role}.json`), undefined, undefined, { sqliteMode: "off" });
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: sandbox, role, explicitProject: "seat-project", transport: "structured" });
  if (begun.kind !== "created") throw new Error("fixture admission failed");
  expect(begun.receipt.launchProfile.learnedRules).toEqual({ project: "seat-project", roleId: role });
});

test("admission preserves pipeline selectors and excludes ordinary workers, clean profiles and unknown projects", () => {
  const registry = new AgentRegistry(path.join(sandbox, "guards.json"), undefined, undefined, { sqliteMode: "off" });
  const admit = (role: string, launchProfile = {}, explicitProject: string | null = "seat-project") => {
    const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: sandbox, role, explicitProject, launchProfile });
    if (begun.kind !== "created") throw new Error("fixture admission failed");
    return begun.receipt.launchProfile;
  };
  expect(admit("builder").learnedRules).toBeUndefined();
  expect(admit("verifier")).toMatchObject({ cleanMemory: true });
  expect(admit("verifier").learnedRules).toBeUndefined();
  expect(admit("orchestrator", { cleanMemory: true }).learnedRules).toBeUndefined();
  expect(admit("orchestrator", {}, null).learnedRules).toBeUndefined();
  const selector = { project: "pipeline-project", roleId: "builder" };
  expect(admit("orchestrator", { learnedRules: selector }).learnedRules).toEqual(selector);
  expect(admit("maintainer", { project: "profile-project" }, null).learnedRules).toEqual({ project: "profile-project", roleId: "maintainer" });
});

test.each(["codex", "claude"] as const)("%s legacy seat resumes gain their selector from durable ownership", engine => {
  const file = path.join(sandbox, `${engine}-legacy.json`);
  const registry = new AgentRegistry(file, undefined, undefined, { sqliteMode: "off" });
  const begun = beginLegacySpawnFixture(registry, { engine, cwd: sandbox, role: "orchestrator", explicitProject: "owned-project" });
  if (begun.kind !== "created") throw new Error("fixture admission failed");
  const sessionId = crypto.randomUUID();
  const transcript = path.join(sandbox, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify(engine === "codex" ? { type: "session_meta", payload: { id: sessionId } } : { sessionId }) + "\n");
  registry.completeSpawn(begun.receipt.launchId, { key: { engine, sessionId }, artifactPath: transcript, cwd: sandbox, accountId: "old-account", status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const conversation of Object.values(legacy.conversations) as import("@/lib/agent/registry").RegistryConversation[]) {
    for (const generation of conversation.generations) delete generation.launchProfile.learnedRules;
  }
  fs.writeFileSync(file, JSON.stringify(legacy));
  const resumedRegistry = new AgentRegistry(file, undefined, undefined, { sqliteMode: "off" });
  resumedRegistry.stampOrchestratorSeatIdentity({ project: "owned-project", seatEpoch: 1,
    conversationId: begun.receipt.conversationId, predecessorConversationId: null,
    designatedAt: "2026-10-12T09:00:00.000Z", activatedAt: "2026-10-12T09:00:01.000Z" });
  const resumed = beginLegacySpawnFixture(resumedRegistry, { engine, cwd: sandbox, purpose: "resume-successor", conversationId: begun.receipt.conversationId, expectedArtifactPath: transcript, role: "builder" });
  if (resumed.kind !== "created") throw new Error("fixture resume admission failed");
  expect(resumed.receipt.launchProfile.learnedRules).toEqual({ project: "owned-project", roleId: "orchestrator" });
});

test.each(["codex", "claude"] as const)("%s undesignated pipeline orchestrator keeps its clean memory fence on resume", async engine => {
  const file = path.join(sandbox, `${engine}-pipeline-orchestrator.json`);
  const registry = new AgentRegistry(file, undefined, undefined, { sqliteMode: "off" });
  const selector = { project: "pipeline-project", roleId: "builder" };
  const begun = beginLegacySpawnFixture(registry, {
    engine, cwd: sandbox, role: "orchestrator", explicitProject: "pipeline-project",
    launchProfile: { cleanMemory: true, learnedRules: selector },
    memberships: [{ kind: "pipeline", containerId: "pipeline-run", role: "orchestrator", slot: "review:1",
      stageId: "review", stageOrder: 1, round: 1, parentConversationId: null }],
  });
  if (begun.kind !== "created") throw new Error("fixture admission failed");
  const sessionId = crypto.randomUUID();
  const transcript = path.join(sandbox, `${sessionId}-pipeline.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify(engine === "codex" ? { type: "session_meta", payload: { id: sessionId } } : { sessionId }) + "\n");
  registry.completeSpawn(begun.receipt.launchId, { key: { engine, sessionId }, artifactPath: transcript, cwd: sandbox, accountId: "account", status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  const resumed = beginLegacySpawnFixture(registry, { engine, cwd: sandbox, purpose: "resume-successor", conversationId: begun.receipt.conversationId, expectedArtifactPath: transcript });
  if (resumed.kind !== "created") throw new Error("fixture resume failed");
  expect(resumed.receipt.launchProfile).toMatchObject({ cleanMemory: true, learnedRules: selector });
  const { learnedRulesForLaunchProfile } = await import("@/lib/memory/roleLaunch");
  expect(await learnedRulesForLaunchProfile(resumed.receipt.launchProfile)).toBeUndefined();
});
