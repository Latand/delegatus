import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";

import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";

/* Slice 4 of docs/design/memory-source-switch.md: the selector for the
   operator's own root conversations, their block, and the seat's pointer by
   position. Every state directory is private to this file. */
const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-memory-"));
let state = 0;
beforeEach(() => { process.env.LLV_STATE_DIR = path.join(sandbox, `state-${++state}`); fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true }); });
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { AgentRegistry } = await import("@/lib/agent/registry");
const { SOURCE_STATES, chooseSource, sourceTurnsEnginesOff } = await import("./fixtures/source");
const { learnedRulesForLaunchProfile, roleMemoryProfileForIdentity } = await import("./roleLaunch");
const { learnedRulesSnapshot, roleMemoryCollection } = await import("./roleStore");
const { renderLearnedRules } = await import("./roleRender");
const { operatorRootConversation, storedOperatorRoot } = await import("./operatorMemory");

const PROJECT = "operator-project";
const OPERATOR = { project: PROJECT, roleId: null, reader: "operator" };

function registryAt(name: string) {
  return new AgentRegistry(path.join(sandbox, `${name}-${state}.json`), undefined, undefined, { sqliteMode: "off" });
}
type Registry = ReturnType<typeof registryAt>;
type Request = Parameters<Registry["beginSpawnRequest"]>[0];

function launch(registry: Registry, overrides: Partial<Request> = {}) {
  const begun = registry.beginSpawnRequest({
    engine: "codex", cwd: "/repo", origin: { kind: "operator" }, explicitProject: PROJECT,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Operator conversation" }), ...overrides,
  } as Request);
  if (begun.kind !== "created") throw new Error("expected a fresh admission");
  return begun.receipt;
}

function settle(registry: Registry, launchId: string): ViewerConversationId {
  const sessionId = crypto.randomUUID();
  const settled = registry.settleSpawn(launchId, {
    key: { engine: "codex", sessionId }, artifactPath: `/sessions/${sessionId}.jsonl`, cwd: "/repo", accountId: "account",
    status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error(`settlement conflict: ${settled.code}`);
  return settled.conversation.id;
}

function resume(registry: Registry, conversationId: ViewerConversationId) {
  const begun = registry.beginSpawnRequest({
    engine: "codex", cwd: "/repo", conversationId, purpose: "resume-successor", origin: { kind: "successor" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Resume operator conversation" }),
  });
  if (begun.kind !== "created") throw new Error("expected a resume admission");
  return begun.receipt;
}

const rule = (id: string, scope: string, text: string) => ({
  kind: "rule" as const, id, scope, rule: text, why: "A seeded rule for the operator block.", state: "active" as const, hints: [],
  source: { origin: "seat" as const, project: PROJECT, roleId: "orchestrator" as const, fixRound: false as const, conversationId: "seed" },
  createdAt: "2026-10-22T00:00:00.000Z", changedAt: "2026-10-22T00:00:00.000Z",
});
function seedRules() {
  const rows = [
    rule("r_00000000000000a1", `project:${PROJECT}`, "Run the project's gate wrapper before reporting a heavy check."),
    rule("r_00000000000000a2", "machine", "Pin a closed control port before running any suite on this machine."),
    rule("r_00000000000000a3", `role:${PROJECT}:builder`, "Write the failing test before changing the builder's code."),
  ];
  roleMemoryCollection(true)!.boundedPatch(8, tx => {
    for (const row of rows) tx.put(row);
    for (const scope of new Set(rows.map(row => row.scope))) tx.put({ kind: "scope", scope, revision: 1, active: rows.filter(row => row.scope === scope).map(row => row.id), history: [] });
  });
}

test.each([...SOURCE_STATES])("an operator root launch in %s carries the operator selector only in Delegatus mode", source => {
  chooseSource(source);
  const receipt = launch(registryAt(`launch-${source}`));
  if (sourceTurnsEnginesOff(source)) expect(receipt.launchProfile.learnedRules).toEqual(OPERATOR);
  else expect(receipt.launchProfile.learnedRules).toBeUndefined();
});

test("delegated, role-bearing, clean, member and external launches never get the operator selector", () => {
  chooseSource("active");
  const registry = registryAt("guards");
  const parent = settle(registry, launch(registry).launchId);
  const cases: Partial<Request>[] = [
    { origin: { kind: "agent", conversationId: parent } },
    { origin: { kind: "external" } },
    { parentConversationId: parent },
    { role: "builder" },
    { launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Clean operator conversation", cleanMemory: true }) },
    { origin: { kind: "container", container: "pipeline", containerId: "pipeline_fixture", creatorConversationId: null } },
    { memberships: [{ kind: "pipeline", containerId: "pipeline_fixture", role: "builder", slot: "build:1", stageId: "build", stageOrder: 1, round: 1, parentConversationId: null }] as never },
    { explicitProject: null },
  ];
  for (const overrides of cases) expect(launch(registry, overrides).launchProfile.learnedRules?.reader).toBeUndefined();
  const stage = { project: "pipeline-project", roleId: null };
  expect(launch(registry, { origin: { kind: "container", container: "pipeline", containerId: "pipeline_fixture", creatorConversationId: null },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Role-less stage", learnedRules: stage }) }).launchProfile.learnedRules).toEqual(stage);
});

test("a resume re-derives the selector from the current source", () => {
  chooseSource("unchosen");
  const registry = registryAt("resume");
  const conversationId = settle(registry, launch(registry).launchId);
  expect(resume(registry, conversationId).launchProfile.learnedRules).toBeUndefined();
  chooseSource("draining");
  expect(resume(registry, conversationId).launchProfile.learnedRules).toEqual(OPERATOR);
  chooseSource("engines");
  expect(resume(registry, conversationId).launchProfile.learnedRules).toBeUndefined();
  chooseSource("active");
  expect(resume(registry, conversationId).launchProfile.learnedRules).toEqual(OPERATOR);
});

test("a delegated child resumed in Delegatus mode stays without the operator selector", () => {
  chooseSource("active");
  const registry = registryAt("delegated-resume");
  const parent = settle(registry, launch(registry).launchId);
  const child = settle(registry, launch(registry, { origin: { kind: "agent", conversationId: parent }, parentConversationId: parent }).launchId);
  expect(resume(registry, child).launchProfile.learnedRules).toBeUndefined();
});

test("restart adoption and migration re-derive the selector from the stored record", () => {
  const profile = emptyLaunchProfile({ cwd: "/repo" });
  chooseSource("active");
  expect(roleMemoryProfileForIdentity(profile, null, PROJECT, false, true)?.learnedRules).toEqual(OPERATOR);
  expect(roleMemoryProfileForIdentity(profile, null, PROJECT, false, false)).toBe(profile);
  chooseSource("importing");
  expect(roleMemoryProfileForIdentity(profile, null, PROJECT, false, true)).toBe(profile);
  const stale = emptyLaunchProfile({ cwd: "/repo", learnedRules: OPERATOR as never });
  expect(roleMemoryProfileForIdentity(stale, null, PROJECT, false, true)?.learnedRules).toBeUndefined();
  const root = { agentRole: null, delegationDepth: 0, generations: [{ launchProfile: { parentConversationId: null } }] };
  expect(storedOperatorRoot(root, [])).toBe(true);
  expect(storedOperatorRoot({ ...root, delegationDepth: null }, [])).toBe(false);
  expect(storedOperatorRoot({ ...root, agentRole: "builder" }, [])).toBe(false);
  expect(storedOperatorRoot({ ...root, generations: [{ launchProfile: { parentConversationId: "conversation_parent" } }] }, [])).toBe(false);
  expect(storedOperatorRoot(root, [{ kind: "pipeline" }])).toBe(false);
  expect(operatorRootConversation({ agentRole: null, parentConversationId: null, delegationDepth: 1, memberships: [] })).toBe(false);
});

test("the operator block holds project and machine rules under its own notice and pointer", async () => {
  chooseSource("active");
  seedRules();
  const block = await learnedRulesForLaunchProfile({ learnedRules: OPERATOR as never });
  expect(block).toContain("Pin a closed control port");
  expect(block).toContain("Run the project's gate wrapper");
  expect(block).not.toContain("Write the failing test");
  expect(block).toContain("Learned rules (Delegatus role memory): 1 project · 1 machine");
  expect(block).toContain("Earlier seats and agents on this machine left these.");
  expect(block).toContain("call leave_lesson with lesson and scope project or machine");
  expect(block).not.toContain("stage_report");
  expect(block).not.toContain("finished their stages");
  chooseSource("importing");
  expect(await learnedRulesForLaunchProfile({ learnedRules: OPERATOR as never })).toBeUndefined();
  chooseSource("engines");
  expect(await learnedRulesForLaunchProfile({ learnedRules: OPERATOR as never })).toBeUndefined();
});

test("a role-less stage keeps the stage block byte for byte in Delegatus mode", () => {
  chooseSource("active");
  const scopes = [`project:${PROJECT}`, "machine"].map(scope => ({ scope, rules: [] }));
  expect(learnedRulesSnapshot(PROJECT, null).block).toBe(renderLearnedRules(scopes));
  expect(learnedRulesSnapshot(PROJECT, null).block).toContain("When you report with stage_report");
});

test.each([...SOURCE_STATES.filter(source => source !== "engines")])("the seat's pointer in %s names the engines' memory as off only in Delegatus mode", source => {
  chooseSource(source);
  const block = learnedRulesSnapshot(PROJECT, "orchestrator").block;
  const off = "your engine's own memory is off on this installation, so leave_lesson is your only memory that lasts beyond this conversation";
  if (sourceTurnsEnginesOff(source)) {
    expect(block).toContain(off);
    expect(block).not.toContain("while your engine's own memory reaches one account");
  } else {
    expect(block).not.toContain(off);
    expect(block).toContain("while your engine's own memory reaches one account");
  }
  expect(block).toContain("create_task");
});

test("the seat block outside Delegatus mode is today's block byte for byte", () => {
  chooseSource("unchosen");
  const scopes = [`role:${PROJECT}:orchestrator`, "role:*:orchestrator", `project:${PROJECT}`, "machine"].map(scope => ({ scope, rules: [] }));
  expect(learnedRulesSnapshot(PROJECT, "orchestrator").block).toBe(renderLearnedRules(scopes));
  expect(renderLearnedRules(scopes, Infinity, { engineMemoryOff: true })).not.toBe(renderLearnedRules(scopes));
});
