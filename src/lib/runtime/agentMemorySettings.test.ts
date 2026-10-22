import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { setProjectAgentMemoryMax, projectAgentMemoryMax } from "@/lib/projects/settings";
import { loadRoleOverrides, saveRoleOverrides, ROLE_OVERRIDES_SCHEMA_VERSION } from "@/lib/roles/store";
import { agentMemoryScopes, agentMemoryCapForPlan } from "./agentMemorySettings";
import { GIB, planAgentMemory, invalidateAgentScopeProbe } from "./agentMemory";
import { assertAgentMemoryMax } from "./agentMemoryConfig";
import { normalizeStages } from "@/lib/pipelines/engine";
import { pipelineStageRuntimeProfile } from "@/lib/pipelines/stageSandbox";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memory-settings-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = directory;
afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  invalidateAgentScopeProbe();
  fs.rmSync(directory, { recursive: true, force: true });
});
const env = { NODE_ENV: "test", DELEGATUS_AGENT_MEMORY: "watchdog", DELEGATUS_AGENT_MEMORY_MAX: "3G", DELEGATUS_AGENT_MEMORY_RESERVE: "8G" } as const;
const ports = { totalBytes: 16 * GIB, probe: () => null, runner: () => "" };

test.skipIf(process.platform === "win32")("scoped settings survive a fresh process and the launch receipt replays its effective cap", async () => {
  expect(setProjectAgentMemoryMax("project-memory", 5 * GIB)).toBe(true);
  saveRoleOverrides({ builder: { config: { agentMemoryMaxBytes: 6 * GIB } } });
  expect(loadRoleOverrides().schemaVersion).toBe(6);
  expect(ROLE_OVERRIDES_SCHEMA_VERSION).toBe(6);
  const profile = emptyLaunchProfile({ cwd: directory, agentMemoryMaxBytes: 12 * GIB, agentMemoryRoleParams: { domain: "frontend" } });
  const scopes = agentMemoryScopes({ cwd: directory, project: "project-memory", role: "builder", profile });
  expect(scopes).toEqual({ project: 5 * GIB, role: 6 * GIB, stage: 12 * GIB });
  const plan = planAgentMemory({ engine: "codex", sessionKey: "memory-fixture", liveAgents: 2, memoryScopes: scopes }, env, ports);
  const cap = agentMemoryCapForPlan(plan);
  expect(cap).toMatchObject({ limitBytes: 8 * GIB, requestedBytes: 12 * GIB, source: "stage", clamped: true, enforced: true });
  const registryFile = path.join(directory, "registry.json");
  const registry = new AgentRegistry(registryFile, undefined, undefined, { sqliteMode: "off" });
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: directory, transport: "structured", launchProfile: profile, role: "builder" });
  await registry.recordSpawnMemoryCapOffLoop(begun.receipt.launchId, cap);
  const child = Bun.spawn([process.execPath, "-e", `
    import { AgentRegistry } from './src/lib/agent/registry';
    import { spawnResponseForReceipt } from './src/lib/agent/spawnResponse';
    import { projectAgentMemoryMax } from './src/lib/projects/settings';
    import { agentMemoryScopes } from './src/lib/runtime/agentMemorySettings';
    const registry = new AgentRegistry(process.argv[1], undefined, undefined, { sqliteMode: 'off' });
    const receipt = registry.spawnReceipt(process.argv[2]);
    console.log(JSON.stringify({ response: spawnResponseForReceipt(receipt),
      scopes: agentMemoryScopes({ cwd: receipt.cwd, project: 'project-memory', role: receipt.agentRole, profile: receipt.launchProfile }),
      project: projectAgentMemoryMax('project-memory') }));
  `, registryFile, begun.receipt.launchId], { stdout: "pipe", stderr: "pipe" });
  try {
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const replay = JSON.parse(output);
    expect(replay.response.memoryCap).toEqual(cap);
    expect(replay.scopes).toEqual(scopes);
    expect(replay.project).toBe(5 * GIB);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  // A subsequent launch reads current defaults; the old receipt is immutable evidence.
  expect(setProjectAgentMemoryMax("project-memory", 7 * GIB)).toBe(true);
  saveRoleOverrides({});
  expect(agentMemoryScopes({ cwd: directory, project: "project-memory", role: "builder" }).project).toBe(7 * GIB);
  expect(spawnResponseForReceipt(registry.spawnReceipt(begun.receipt.launchId)!).memoryCap).toEqual(cap);
});

test("invalid scope values refuse and null resets inheritance without losing other settings", () => {
  for (const value of [0, -1, GIB - 1, 2 ** 40 + 1, 1.5, Infinity, NaN, "8G", {}, false]) {
    expect(() => assertAgentMemoryMax(value)).toThrow("integer bytes");
    expect(() => setProjectAgentMemoryMax("project-memory", value as number)).toThrow();
    expect(() => saveRoleOverrides({ builder: { config: { agentMemoryMaxBytes: value as number } } })).toThrow();
    expect(() => planAgentMemory({ engine: "codex", sessionKey: "invalid", liveAgents: 1, memoryScopes: { stage: value as number } }, env, ports)).toThrow();
  }
  for (const value of [GIB, 2 ** 40, null]) expect(() => assertAgentMemoryMax(value)).not.toThrow();
  expect(setProjectAgentMemoryMax("project-memory", null)).toBe(true);
  expect(projectAgentMemoryMax("project-memory")).toBeNull();
  expect(agentMemoryScopes({ cwd: directory, project: "project-memory" }).project).toBeNull();
  expect(agentMemoryCapForPlan(planAgentMemory({ engine: "codex", sessionKey: "off", liveAgents: 1, memoryScopes: { stage: 12 * GIB } }, { NODE_ENV: "test", DELEGATUS_AGENT_MEMORY: "off" }, ports)))
    .toMatchObject({ enforced: false, limitBytes: null });
});

test("stage normalization refuses invalid caps and copies the validated request into the launch profile", () => {
  const lookup = () => ({ engine: "codex" as const, model: "gpt-6-sol", effort: "high", promptScaffold: "Build the task." });
  for (const cap of [0, -1, "8G", 2 ** 40 + 1, {}, false, GIB + .5]) {
    const parsed = normalizeStages([{ id: "build", kind: "run", prompt: "Implement the task", next: null, agentMemoryMaxBytes: cap }], lookup);
    expect(parsed.violations?.some(row => row.field === "stages[0].agentMemoryMaxBytes")).toBe(true);
    expect(parsed.stages).toBeUndefined();
  }
  for (const cap of [GIB, 12 * GIB, 2 ** 40, null]) {
    const parsed = normalizeStages([{ id: "build", kind: "run", prompt: "Implement the task", next: null, agentMemoryMaxBytes: cap }], lookup);
    expect(parsed.error).toBeUndefined();
    expect(pipelineStageRuntimeProfile(parsed.stages![0]!)).toMatchObject({ agentMemoryMaxBytes: cap });
  }
});
