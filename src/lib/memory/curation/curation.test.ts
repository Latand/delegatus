import * as pipelineStore from "@/lib/pipelines/store";
import * as admissionSources from "@/lib/monitor/seatTickAdmissionSources";
import { chooseSource } from "../fixtures/source";
import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, type AgentRegistryEntry, type RegistryFile } from "@/lib/agent/registry";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { stopWorktreeSweepWorker } from "@/lib/pipelines/worktreeSweepWorker";
import { defaultSeatTickSources } from "@/lib/monitor/seatTickSources";
import { input as tickInput } from "@/lib/boardMaintenance/testFixture";
import { roleIsClean } from "../eligibility";
import { ROLE_MEMORY_BOUND, CURATION_INTERVAL_MS, type RoleMemoryRule, type RuleSource } from "../roleTypes";
import { scopeChars } from "../roleConsolidate";
import { canonicalScope, joinMovedScopes, leaveLessons, newRuleId, projectView, recordLessonRequest, learnedRulesBlock, learnedRulesSnapshot, roleMemoryCollection, roleScope, projectScope, restoreRule, deleteRule, storedLessonTexts } from "../roleStore";
import { applyCuration, revertCuratorPass, type CurationApply } from "./apply";
import { claimPass, readPassAuthority, currentPassAuthority, machinePassAuthority, passForConversationAuthority, currentPass, curationPanelRuns, curationStatus, curationView, machinePass, patchPass, readPass, type CuratorPass } from "./store";
import { curatorCallerOf } from "./guard";
import { readCuration } from "./read";
import { productionCurationController } from "./run";
import { permitCuratorTool } from "@/lib/mcp/toolAllowlist";
import { reconcileSeatTick, runSeatTickCheck } from "@/lib/monitor/seatTickController";
import { emptySeatTickState } from "@/lib/monitor/types";
import { writeSeatTickState } from "@/lib/monitor/seatTickState";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import type { RoleMemoryRow } from "../roleTypes";
import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { seatTickWakeCommit, seatTickWakeCommitPlan } from "@/lib/monitor/seatTick";
import { recoverDeadStructuredConversation } from "@/lib/runtime/structuredRecovery";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { loadTasks } from "@/lib/tasks/store";
import { admitReservedLaunch } from "@/lib/tasks/launchMembership";
import { groupHideState } from "@/lib/tasks/groupHide";
import { commitTaskMembership } from "@/lib/tasks/membership";
import { recordMemoryDelivery } from "../deliveryLedger";

const PROJECT = "curation-fixture";
const NOW = Date.parse("2026-10-11T00:00:00Z");
const at = (delta = 0) => new Date(NOW + delta).toISOString();
const why = "An earlier attempt applied guidance at the wrong level.";
const text = "Inspect the requested scope before changing stored guidance.";
let dir: string, previous: string | undefined;
beforeEach(() => {
  resetProjectAliasesForTests();
  previous = process.env.LLV_STATE_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curation-check-"));
  process.env.LLV_STATE_DIR = dir;
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Run the repository checks before publication.\n");
});
async function cleanupFixture() {
  // The inherited disk-pressure source keeps a leased helper between reads.
  // End this fixture's helper before its state and lease record disappear.
  await stopWorktreeSweepWorker();
  process.env.LLV_STATE_DIR = previous;
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  resetProjectAliasesForTests();
}
afterEach(cleanupFixture);
function row(id: string): RoleMemoryRule {
  const held = roleMemoryCollection()!.get(`r:${id}`);
  if (held?.kind !== "rule") throw Error("rule missing");
  return held;
}
function fixture(scope = roleScope(PROJECT, "builder"), extra: Partial<RoleMemoryRule> = {}) {
  const source: RuleSource = { project: PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: ["conversation", "fixture"].join("_") };
  return roleMemoryCollection(true)!.boundedPatch(20, tx => {
    const id = extra.id ?? newRuleId(tx);
    tx.put({ kind: "rule", id, scope, rule: text, why, state: "active", hints: [], source, createdAt: at(), changedAt: at(), ...extra });
    const held = tx.get(`s:${scope}`);
    tx.put({ kind: "scope", scope, revision: held?.kind === "scope" ? held.revision + 1 : 1, history: held?.kind === "scope" ? held.history : [], active: [...(held?.kind === "scope" ? held.active : []), ...(extra.state && extra.state !== "active" ? [] : [id])] });
    return id;
  });
}
function pass(now = NOW, project = PROJECT) { return claimPass({ project, repoDir: dir, now })!; }
function input(scopes: Record<string, string[]>, edits: Partial<CurationApply> = {}): CurationApply {
  return { scopes: Object.entries(scopes).map(([scope, order]) => {
    const held = roleMemoryCollection()?.get(`s:${scope}`);
    return { scope, revision: held?.kind === "scope" ? held.revision : 0, order };
  }), ...edits };
}
function ended(p: CuratorPass, delta = 1000) { patchPass(p.id, { state: "succeeded", endedAt: at(delta) }); }

test("current curation selection and history ordering never copy the role archive", () => {
  fixture();
  const passes: CuratorPass[] = [];
  for (let i = 0; i < 8; i++) {
    const p = pass(NOW + i * (CURATION_INTERVAL_MS + 1000));
    passes.push(p);
    patchPass(p.id, { state: "succeeded", endedAt: at(i * (CURATION_INTERVAL_MS + 1000) + 1) });
  }
  const memory = roleMemoryCollection()!;
  memory.loadReadonly();
  const copied = spyOn(memory, "snapshot");
  try {
    expect(currentPass(PROJECT)).toBeNull();
    expect(curationView(PROJECT).passes.map(p => p.id)).toEqual(passes.map(p => p.id).reverse());
    const live = pass(NOW + 8 * (CURATION_INTERVAL_MS + 1000));
    copied.mockClear();
    expect(currentPass(PROJECT)?.id).toBe(live.id);
    expect(readPass(live.id)?.counts).toEqual(live.counts);
    expect(copied).not.toHaveBeenCalled();
    const selected = currentPass(PROJECT)!;
    selected.counts.calls = 999;
    selected.scopes.push("caller-only");
    expect(currentPass(PROJECT)?.counts.calls).toBe(0);
    expect(currentPass(PROJECT)?.scopes).not.toContain("caller-only");
    patchPass(live.id, { state: "succeeded", endedAt: at(9 * CURATION_INTERVAL_MS) });
    expect(currentPass(PROJECT)).toBeNull();
  } finally { copied.mockRestore(); }
});

test("the panel keeps the most recent completed pass beside a newer live pass", () => {
  fixture();
  const completed = pass();
  patchPass(completed.id, { state: "succeeded", endedAt: at(1000), conversationId: "conversation_previous" });
  const live = pass(NOW + CURATION_INTERVAL_MS + 2000);
  patchPass(live.id, { state: "running", conversationId: "conversation_live" });

  expect(curationPanelRuns(PROJECT)).toMatchObject({
    live: { id: live.id, state: "running", conversationId: "conversation_live" },
    last: { id: completed.id, state: "succeeded", conversationId: "conversation_previous" },
  });
});

test("a successful no-op pass leaves pressure as the trigger but cannot claim again before the interval", () => {
  const scope = roleScope(PROJECT, "builder");
  Array.from({ length: 30 }, (_, i) => fixture(scope, {
    rule: `Preserve the complete operational guidance for category ${i} before changing shared state. ${"additional guidance ".repeat(25)}`.slice(0, 300),
  }));
  const initial = pass();
  ended(initial);

  expect(curationStatus(PROJECT, NOW + 31 * 60_000)).toMatchObject({ due: false, trigger: "pressure", pressure: true, newLessons: 0 });
  expect(pass(NOW + 31 * 60_000)).toBeNull();
  expect(curationStatus(PROJECT, NOW + CURATION_INTERVAL_MS + 1001)).toMatchObject({ due: true, trigger: "pressure", pressure: true, newLessons: 0 });
});
function hostingFixture() {
  const registry = new AgentRegistry(path.join(dir, "registry.json"));
  const seats = new Map<string, { conversationId: string; seatEpoch: number; designatedAt: string; path: null }>();
  const lives = new Map<string, AgentLivenessRecord>();
  const bodies: Record<string, unknown>[] = [];
  const sources = { ...defaultSeatTickSources(), now: () => NOW, registry: () => registry,
    workerCounts: undefined,
    seatFor: (project: string) => ({ active: seats.get(project) ?? null, pending: null, history: [] }) as never,
    activeSeats: () => [...seats.keys()],
    pipelines: () => [...seats.keys()].map(project => ({ project, repoDir: dir }) as never),
    liveness: async ({ conversationId }: { conversationId?: string }) => lives.has(conversationId!) ? [lives.get(conversationId!)!] : [],
    latestDeployment: () => ({ state: "ok" as const, value: null }),
  };
  registry.conversation = () => ({ supersededBy: null, generations: [] }) as never;
  function seat(project = PROJECT, wakeAt = at(-1000)) {
    const conversationId = `conversation_seat_${project}`;
    seats.set(project, { conversationId, seatEpoch: seats.size + 1, designatedAt: at(-86_400_000), path: null });
    lives.set(conversationId, { conversationId, host: { state: "alive", pid: process.pid, kind: "structured" }, lifecycle: "waiting", reason: "host_alive_turn_idle" } as AgentLivenessRecord);
    writeSeatTickState(project, { ...emptySeatTickState(), seatEpoch: seats.get(project)!.seatEpoch, lastWakeAt: wakeAt });
    return conversationId;
  }
  const ports = { launch: async (body: Record<string, unknown>) => { bodies.push(body); return { status: 202, body: { state: "running", conversationId: "conversation_fixture_curator", launchId: "fixture" } }; },
    observe: async () => ({ state: "running" as const }), archive: () => {} };
  return { sources, seats, lives, bodies, seat, ports, controller: productionCurationController(sources, ports), tick: { ...tickInput(), project: PROJECT, now: NOW } };
}
// Helper lease records carry kernel identities on Linux.
test.skipIf(process.platform !== "linux")("curation fixture cleanup stops its recorded disk-pressure helper", async () => {
  const f = hostingFixture();
  await f.sources.diskPressure!();
  const records = fs.readdirSync(path.join(dir, "helpers")).filter(file => file.endsWith(".json"))
    .map(file => JSON.parse(fs.readFileSync(path.join(dir, "helpers", file), "utf8")))
    .filter(record => record.name === "worktree-sweep" && record.ownerPid === process.pid);
  expect(records).toHaveLength(1);
  const [record] = records;
  expect(record.ownerIdentity).toBe(captureProcessIdentity(process.pid).startIdentity);
  const identities = [captureProcessIdentity(record.pid, undefined, record.identity),
    captureProcessIdentity(record.group, undefined, record.groupIdentity)];
  for (const identity of identities) expect(processIdentityStatus(identity)).toBe("alive");

  await cleanupFixture();

  for (const identity of identities) expect(processIdentityStatus(identity)).toBe("dead");
  expect(fs.existsSync(dir)).toBe(false);
}, 15_000);

test("curator admission joins a hidden system task without an open board task", async () => {
  fixture(); const f = hostingFixture(); f.seat();
  expect(await f.controller.launchIfDue(f.tick)).toContain("launched");
  const body = f.bodies[0];
  expect(body.taskId).toBeString();
  // Exercise the real shared reservation membership prerequisite, including
  // the conversation which makes board:hidden alone insufficient.
  admitReservedLaunch({ engine: "codex", cwd: dir, explicitProject: PROJECT, clientAttemptId: String(body.clientAttemptId), role: "curator", taskIds: [String(body.taskId)] },
    { conversationId: "conversation_fixture_curator", launchId: "launch_fixture_curator" }, reason => { throw new Error(reason); }, {
      commit: input => commitTaskMembership(input, path.join(dir, "tasks.json")), pipelineContext: () => null, projectForCwd: () => PROJECT,
    });
  const tasks = loadTasks(path.join(dir, "tasks.json"));
  expect(tasks).toHaveLength(1);
  expect(tasks.filter(task => task.status !== "done")).toHaveLength(0);
  expect(tasks[0].assignments[0].conversationId).toBe("conversation_fixture_curator");
  expect(groupHideState(tasks[0], { members: [], pipelines: [] }).hidden).toBe(true);
  expect(readPass(String(body.clientAttemptId))?.conversationId).toBe("conversation_fixture_curator");
  expect(await f.controller.reconcile(PROJECT)).toBeNull();
  expect(loadTasks(path.join(dir, "tasks.json"))).toHaveLength(1);
});
test("the engines memory source pauses curator admission and preserves its store", async () => {
  fixture(); const f = hostingFixture(); f.seat();
  chooseSource("engines");
  const before = machinePass();
  expect(await f.controller.launchIfDue(f.tick)).toContain("paused, memory off");
  expect(f.bodies).toHaveLength(0); expect(machinePass()).toEqual(before);
  chooseSource("unchosen");
});

test("enabled settings with a gone designated host never launch or resume curation", async () => {
  fixture(); const f = hostingFixture(), id = f.seat();
  f.lives.set(id, { ...f.lives.get(id)!, host: { state: "gone", kind: "none", pid: null }, lifecycle: "gone" });
  expect(await f.controller.launchIfDue(f.tick)).toContain("seat");
  expect(f.bodies).toHaveLength(0); expect(machinePass()).toBeNull();
  const p = pass();
  expect(await f.controller.reconcile(PROJECT)).toContain("abandoned");
  expect(f.bodies).toHaveLength(0);
  expect(readPass(p.id)).toMatchObject({ state: "failed", failure: expect.stringContaining("abandoned") });
  expect(machinePass()).toBeNull();
});
test("a live seat needs a delivered wake within two configured intervals", async () => {
  fixture(); const f = hostingFixture();
  const interval = f.tick.settings.wakeIntervalMs;
  f.seat(PROJECT, at(-2 * interval - 1));
  expect(await f.controller.launchIfDue(f.tick)).toContain("wake");
  expect(f.bodies).toHaveLength(0); expect(machinePass()).toBeNull();
  writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 1, lastWakeAt: at(-2 * interval) });
  expect(await f.controller.launchIfDue(f.tick)).toContain("launched");
  expect(f.bodies).toHaveLength(1);
});
test("delayed confirmation keeps the delivery time for curator freshness", async () => {
  fixture(); const f = hostingFixture();
  const interval = f.tick.settings.wakeIntervalMs;
  f.seat(PROJECT, at(-interval - 1));
  const reachedAt = at(-2 * interval - 1);
  const commit = seatTickWakeCommitPlan({ kind: "wake", reasons: [{ kind: "interval", detail: "fixture" }], items: [], deferred: 0 } as never,
    { fingerprint: "fixture", eventsThrough: 0 })!;
  const delivered = seatTickWakeCommit(emptySeatTickState(), {
    ...commit,
  }, NOW, reachedAt);
  writeSeatTickState(PROJECT, { ...delivered, seatEpoch: 1 });
  expect(delivered.lastWakeAt).toBe(reachedAt);
  expect(await f.controller.launchIfDue(f.tick)).toContain("no eligible project");
  expect(f.bodies).toHaveLength(0);
  expect(machinePass()).toBeNull();
});
test("the machine pass chooses the most recently woken eligible project", async () => {
  fixture("machine"); const f = hostingFixture();
  f.seat(PROJECT, at(-20_000)); f.seat("newer-fixture", at(-1000));
  const gone = f.seat("gone-fixture", at());
  f.lives.set(gone, { ...f.lives.get(gone)!, host: { state: "gone", kind: "none", pid: null }, lifecycle: "gone" });
  expect(await f.controller.launchIfDue(f.tick)).toContain("launched");
  expect(f.bodies).toHaveLength(1);
  expect(f.bodies[0].project).toBe("newer-fixture");
  expect(machinePass()?.project).toBe("newer-fixture");
});
test("project-only rules are curated in their eligible project", async () => {
  fixture(); const f = hostingFixture(); f.seat(PROJECT, at(-20_000)); f.seat("empty-fixture", at());
  expect(await f.controller.launchIfDue(f.tick)).toContain("launched");
  expect(machinePass()?.project).toBe(PROJECT);
});
test("equal delivered wakes choose by project key regardless of sweep order", async () => {
  fixture("machine"); const f = hostingFixture(); f.seat("z-fixture"); f.seat("a-fixture");
  expect(await f.controller.launchIfDue({ ...f.tick, project: "z-fixture" })).toContain("launched");
  expect(machinePass()?.project).toBe("a-fixture");
});
test.each(["missing", "retired", "never-woken", "predecessor-epoch", "predecessor-time", "future-wake", "disabled", "shorter-interval", "unreadable-liveness"] as const)("%s seat evidence never hosts curation", async kind => {
  fixture(); const f = hostingFixture(); f.seat();
  if (kind === "missing") f.seats.clear();
  if (kind === "retired") f.sources.registry().conversation = () => ({ supersededBy: { conversationId: "conversation_successor" }, generations: [] }) as never;
  if (kind === "never-woken") writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 1 });
  if (kind === "predecessor-epoch") writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 2, lastWakeAt: at(-1000) });
  if (kind === "predecessor-time") f.seats.get(PROJECT)!.designatedAt = at();
  if (kind === "future-wake") writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 1, lastWakeAt: at(1) });
  if (kind === "disabled") { const read = f.sources.settings; f.sources.settings = project => ({ ...read(project), enabled: false }); }
  if (kind === "shorter-interval") {
    const read = f.sources.settings; f.sources.settings = project => ({ ...read(project), wakeIntervalMinutes: 10 });
    writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 1, lastWakeAt: at(-20 * 60_000 - 1) });
  }
  if (kind === "unreadable-liveness") f.sources.liveness = async () => { throw Error("fixture liveness unreadable"); };
  expect(await f.controller.launchIfDue(f.tick)).toContain("no eligible project");
  expect(f.bodies).toHaveLength(0); expect(machinePass()).toBeNull();
  const p = pass();
  expect(await f.controller.reconcile("another-fixture")).toContain("abandoned");
  expect(f.bodies).toHaveLength(0); expect(readPass(p.id)?.state).toBe("failed");
});
test("an incumbent that loses its host is abandoned from another project's restart sweep", async () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), f = hostingFixture();
  f.seat(); f.seat("other-fixture", at());
  const p = pass();
  applyCuration(p, input({ [scope]: [one] }, { rewrite: [{ id: one, rule: text + " Read its revision.", note: "Retain the revision check." }] }), at(100));
  patchPass(p.id, { state: "running", launchedAt: at(), conversationId: "conversation_fixture_curator", launchBody: { project: PROJECT, clientAttemptId: p.id } });
  let observations = 0;
  const controller = productionCurationController(f.sources, { ...f.ports, observe: async () => {
    observations++; f.seats.delete(PROJECT);
    return { state: "running" };
  } });
  expect(await controller.reconcile("other-fixture")).toContain("abandoned");
  expect(observations).toBe(1); expect(f.bodies).toHaveLength(0);
  expect(readPass(p.id)).toMatchObject({ state: "failed", failure: expect.stringContaining("abandoned"), counts: { rewritten: 1 } });
  expect(machinePass()).toBeNull();
  expect(row(one).rule).toBe(text + " Read its revision.");
  expect(await productionCurationController(f.sources, f.ports).reconcile("other-fixture")).toBeNull();
  revertCuratorPass(p.id, at(2000)); expect(row(one).rule).toBe(text);
});
test("deferred curator spawn rechecks host eligibility before admission", async () => {
  fixture(); const f = hostingFixture(); f.seat();
  let refused = false;
  const controller = productionCurationController(f.sources, { ...f.ports,
    launch: async (_body, ...args: unknown[]) => {
      f.seats.delete(PROJECT);
      try { (args[0] as (() => void) | undefined)?.(); }
      catch { refused = true; }
      return { status: refused ? 409 : 202, body: { state: "starting" } };
    },
  });
  expect(await controller.launchIfDue(f.tick)).toContain("abandoned");
  expect(refused).toBe(true);
  expect(machinePass()).toBeNull();
  expect(curationView(PROJECT).passes[0].failure).toContain("abandoned");
});
test("abandonment reason survives failed archive placement", async () => {
  fixture(); const f = hostingFixture(), p = pass();
  const controller = productionCurationController(f.sources, { ...f.ports, archive: () => { throw Error("fixture placement unavailable"); } });
  const detail = await controller.reconcile(PROJECT);
  expect(detail).toContain("abandoned: no designated seat"); expect(detail).toContain("archive placement pending");
  expect(readPass(p.id)?.failure).toBe("abandoned: no designated seat"); expect(machinePass()).toBeNull();
});
test("restart sweep settles an ineligible incumbent even without seats or open work", async () => {
  fixture(); const f = hostingFixture(), p = pass();
  const records = await reconcileSeatTick({ sources: { ...f.sources, tasks: () => [], archivedPipelines: () => [],
    lifecycleJournal: () => ({ version: 1, lastSeq: 0, events: [], retired: [] }),
    reports: undefined, recordDeploySnapshots: undefined, recordRuleReports: undefined, maintenanceRuns: () => [],
  }, curation: f.controller, maintenance: null, release: null, ownsTraffic: async () => true,
    recordSuccessions: () => [], reconcileSeat: () => null, appendRecord: () => {}, ensureCard: () => true });
  expect(records.some(record => record.project === PROJECT && record.detail?.includes("abandoned"))).toBe(true);
  expect(readPass(p.id)?.failure).toContain("abandoned");
  expect(machinePass()).toBeNull(); expect(f.bodies).toHaveLength(0);
});
function refusal(p: CuratorPass, edit: CurationApply, code: string) {
  const before = JSON.stringify(roleMemoryCollection()!.snapshot());
  try { applyCuration(p, edit, at(100)); throw Error("accepted invalid apply"); }
  catch (error) { expect((error as { code?: string }).code).toBe(code); }
  expect(JSON.stringify(roleMemoryCollection()!.snapshot())).toBe(before);
}

test("first pass, timed quiet pass, ten lessons and failed passes share the interval", () => {
  expect(curationStatus(PROJECT, NOW).due).toBe(false);
  fixture(); const p = pass(); expect(p).not.toBeNull(); expect(pass()).toBeNull();
  ended(p);
  expect(curationStatus(PROJECT, NOW + 1000 + CURATION_INTERVAL_MS - 1).due).toBe(false);
  expect(curationStatus(PROJECT, NOW + 1000 + CURATION_INTERVAL_MS).due).toBe(true);
  for (let n = 0; n < 10; n++) {
    const source: RuleSource = { project: PROJECT, pipelineId: "early", stageId: "build", attempt: n, roleId: "builder", fixRound: false, conversationId: ["conversation", "early"].join("_") };
    recordLessonRequest({ ...source, at: at(2000 + n) });
    leaveLessons({ request: source, source, lessons: [{ scope: "role", rule: `Inspect scope guidance before changing stored item ${n}.`, why }], none: null, now: at(2000 + n) });
    expect(curationStatus(PROJECT, NOW + 3000).due).toBe(false);
  }
  expect(pass(NOW + 3000)).toBeNull();
  const early = pass(NOW + CURATION_INTERVAL_MS + 1000); expect(early).not.toBeNull();
  patchPass(early.id, { state: "failed", endedAt: at(CURATION_INTERVAL_MS + 2000), failure: "no-account" });
  expect(curationStatus(PROJECT, NOW + 33 * 60_000).due).toBe(false);
  expect(curationStatus(PROJECT, NOW + 2 * CURATION_INTERVAL_MS + 2000).due).toBe(true);
});
test("claims serialize projects sharing a machine, with no live rules there is no pass", () => {
  fixture(); const first = pass();
  fixture(roleScope("other", "builder"));
  expect(claimPass({ project: "other", repoDir: dir, now: NOW })).toBeNull();
  expect(machinePass()?.id).toBe(first.id);
  ended(first);
  expect(claimPass({ project: "other", repoDir: dir, now: NOW })).not.toBeNull();
});
test.each(["succeeded", "failed"] as const)("a %s pass counts later lessons and rewrites at the same clock instant", state => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  if (state === "succeeded") applyCuration(p, input({ [scope]: [one] }), at());
  patchPass(p.id, { state, endedAt: at(1000), ...(state === "failed" ? { failure: "no-account" } : {}) });
  expect(curationStatus(PROJECT, NOW + 2000).newLessons).toBe(0);
  for (let n = 0; n < 10; n++) {
    const source: RuleSource = { project: PROJECT, pipelineId: "clock-boundary", stageId: "build", attempt: n, roleId: "builder", fixRound: false, conversationId: "clock-conversation" };
    recordLessonRequest({ ...source, at: at() });
    leaveLessons({ request: source, source, lessons: n % 2 ? [] : [{ scope: "role", rule: `Inspect stored guidance before applying condition ${n}.`, why }],
      ...(n % 2 ? { rewrite: { id: one, rule: `Inspect the current scope before applying condition ${n}.`, why } } : {}), none: null, now: at() });
    const status = curationStatus(PROJECT, NOW + 2000);
    expect(status.newLessons).toBe(n + 1);
    expect(status.due).toBe(false);
  }
  expect(pass(NOW + 2000)).toBeNull();
  expect(pass(NOW + CURATION_INTERVAL_MS + 1000)).not.toBeNull();
  expect(curationStatus(PROJECT, NOW + CURATION_INTERVAL_MS + 1000).newLessons).toBe(0);
});
test("curator reads and the window distinguish rewrites across the same clock instant", async () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  const shown = () => projectView(PROJECT).scopes.find(item => item.scope === scope)!.active.find(item => item.id === one)!;
  expect(shown().awaitingCuration).toBe(true);
  applyCuration(p, input({ [scope]: [one] }), at());
  expect(shown().awaitingCuration).toBe(false);
  const source: RuleSource = { project: PROJECT, pipelineId: "clock-read", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "clock-reader" };
  recordLessonRequest({ ...source, at: at() });
  leaveLessons({ request: source, source, lessons: [], rewrite: { id: one, rule: "Inspect the current readers before changing stored guidance.", why }, none: null, now: at() });
  expect(shown().awaitingCuration).toBe(true);
  const page = await readCuration(p, scope);
  expect("rules" in page && page.rules.find(item => item.id === one)?.newSincePass).toBe(true);
  ended(p);
  const next = pass(NOW + CURATION_INTERVAL_MS + 1000);
  applyCuration(next, input({ [scope]: [one] }), at());
  expect(shown().awaitingCuration).toBe(false);
  const reread = await readCuration(next, scope);
  expect("rules" in reread && reread.rules.find(item => item.id === one)?.newSincePass).toBe(false);
});
test.each([roleScope(PROJECT, "builder"), "role:*:builder"])("pass undo preserves a later agent rewrite at the same clock instant in %s", to => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: to === scope ? [one] : [], ...(to === scope ? {} : { [to]: [one] }) }, {
    rewrite: [{ id: one, rule: "Inspect the scope readers before changing stored guidance.", note: why }], ...(to === scope ? {} : { move: [{ id: one, to, note: "The target scope has the same readers." }] }),
  }), at());
  const source: RuleSource = { project: PROJECT, pipelineId: "clock-undo", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "clock-writer" };
  recordLessonRequest({ ...source, at: at() });
  const later = "Inspect current readers and scope ownership before changing stored guidance.";
  leaveLessons({ request: source, source, lessons: [], rewrite: { id: one, rule: later, why }, none: null, now: at() });
  ended(p);
  expect(revertCuratorPass(p.id, at(2000)).skipped).toEqual([one]);
  expect(row(one).rule).toBe(later);
  expect(row(one).scope).toBe(to);
});
test("pass undo preserves another curator's ranking at the same clock instant", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), two = fixture(scope), three = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [one, two, three] }), at());
  ended(p);
  const next = pass(NOW + CURATION_INTERVAL_MS + 1000);
  applyCuration(next, input({ [scope]: [two, one, three] }), at());
  ended(next, CURATION_INTERVAL_MS + 2000);
  expect(revertCuratorPass(p.id, at(CURATION_INTERVAL_MS + 3000)).skipped.sort()).toEqual([one, two, three].sort());
  expect(projectView(PROJECT).scopes.find(item => item.scope === scope)!.active.map(item => item.id)).toEqual([three, one, two]);
});
test("scope rereads retain departures from every call of the current pass", async () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), two = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [two] }, { archive: [{ id: one, reason: "stale", note: "The first old command was replaced." }] }), at(100));
  applyCuration(p, input({ [scope]: [] }, { archive: [{ id: two, reason: "task-specific", note: "The second row records one completed task." }] }), at(200));
  const page = await readCuration(p, scope);
  expect("rules" in page && page.rules.map(r => r.id).sort()).toEqual([one, two].sort());
});
test("read pages are revision bound and include scaffold, budget archives and prior text", async () => {
  const scope = roleScope(PROJECT, "builder");
  for (let n = 0; n < 80; n++) fixture(scope, { rule: `${text} ${"Read the stored record. ".repeat(8)} ${n}` });
  const archive = fixture(scope, { state: "archived", reason: "budget" });
  const p = pass(); const first = await readCuration(p, scope);
  if (!("cursor" in first)) throw Error("expected a scope page");
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(24_000);
  expect(first).toHaveProperty("scaffold"); expect(first.cursor).toBeTruthy();
  let cursor = first.cursor; const ids = first.rules.map(r => r.id);
  while (cursor) { const next = await readCuration(p, scope, cursor); if (!("rules" in next)) throw Error("expected a scope page"); ids.push(...next.rules.map(r => r.id)); cursor = next.cursor; }
  expect(ids).toContain(archive); expect(new Set(ids).size).toBe(ids.length);
  fixture(scope);
  await expect(readCuration(p, scope, first.cursor!)).rejects.toThrow(/changed/);
});
test("stale revisions and total-partition failures refuse atomically", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), two = fixture(scope), p = pass();
  refusal(p, input({ [scope]: [one] }), "CURATE_PARTITION");
  refusal(p, input({ [scope]: [one, one, two] }), "CURATE_PARTITION");
  const stale = input({ [scope]: [one, two] }); fixture(scope);
  refusal(p, stale, "CURATE_STALE");
  refusal(p, input({ [roleScope("other", "builder")]: [] }), "CURATE_SCOPE");
});
test.each(["task-specific", "stale", "in-code", "in-instructions", "no-reader", "contradicted", "duplicate"] as const)("archive %s retains text and an operator can return it", reason => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), two = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [two] }, { archive: [{ id: one, reason, note: "Current repository evidence makes this rule redundant.", ...(reason === "in-code" || reason === "in-instructions" ? { where: "AGENTS.md:1" } : {}), ...(reason === "contradicted" || reason === "duplicate" ? { against: two } : {}) }] }), at(100));
  expect(row(one).reason).toBe(reason); expect(storedLessonTexts()).toContain(text);
  restoreRule(one, at(200)); expect(row(one).state).toBe("active"); expect(row(one).keptByOperatorAt).toBe(at(200));
});
test("archive evidence, notes and active counterparts are required", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  refusal(p, input({ [scope]: [] }, { archive: [{ id: one, reason: "stale", note: "" }] }), "CURATE_INVALID");
  for (const where of [undefined, "missing.ts", "../elsewhere.ts"]) refusal(p, input({ [scope]: [] }, { archive: [{ id: one, reason: "in-code", note: "The test enforces the same condition.", where }] }), "CURATE_EVIDENCE");
  refusal(p, input({ [scope]: [] }, { archive: [{ id: one, reason: "contradicted", note: "The current instructions support its counterpart.", against: one }] }), "CURATE_INVALID");
});
test.each(["in-code", "in-instructions", "stale"] as const)("foreign recovery rejects host repository evidence for %s and preserves the archive", reason => {
  const foreign = roleScope("recovery-other", "builder");
  const id = fixture(foreign, { state: "archived", reason: "budget" });
  const p = pass();
  expect(p.scopes).toContain(foreign);
  const before = row(id);
  refusal(p, input({ [foreign]: [] }, { restore: [id], archive: [{ id, reason, where: "AGENTS.md:1", note: "This instruction file exists only in the sweep host." }] }), "CURATE_EVIDENCE");
  expect(row(id)).toEqual(before);
  ended(p);
  const ownerRepo = path.join(dir, "owner-repository");
  fs.mkdirSync(ownerRepo);
  fs.writeFileSync(path.join(ownerRepo, "AGENTS.md"), "Check the owning project's repository before retiring guidance.\n");
  const owner = claimPass({ project: "recovery-other", repoDir: ownerRepo, now: NOW + 2000 })!;
  applyCuration(owner, input({ [foreign]: [] }, { restore: [id], archive: [{ id, reason, where: "AGENTS.md:1", note: "The owning project's admitted repository supplies this evidence." }] }), at(3000));
  expect(row(id)).toMatchObject({ state: "archived", reason, where: "AGENTS.md:1" });
});

test("moving a foreign recovery rule to a shared scope cannot borrow the host's evidence", () => {
  const foreign = roleScope("recovery-other", "builder");
  const id = fixture(foreign, { state: "archived", reason: "budget" });
  const p = pass();
  applyCuration(p, input({ [foreign]: [], machine: [id] }, { restore: [id], move: [{ id, to: "machine", note: "Broaden the recovered condition to every project." }] }), at(100));
  refusal(p, input({ machine: [] }, { archive: [{ id, reason: "in-instructions", where: "AGENTS.md", note: "Attempt to use the host's file after a move." }] }), "CURATE_EVIDENCE");
  // Its original project remains part of the rule's provenance after a prior call.
  // Shared guidance can still be judged from its text without repository evidence.
  applyCuration(p, input({ machine: [] }, { archive: [{ id, reason: "stale", note: "The condition no longer applies across projects." }] }), at(200));
  expect(row(id)).toMatchObject({ state: "archived", reason: "stale" });
});

test("a shared part split from foreign recovery keeps its repository provenance", () => {
  const foreign = roleScope("recovery-other", "builder");
  const id = fixture(foreign, { state: "archived", reason: "budget", source: {
    project: "recovery-other", pipelineId: "foreign-fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_foreign",
  } });
  const p = pass();
  const result = applyCuration(p, input({ [foreign]: [], machine: [id, `split:${id}:1`] }, { restore: [id], split: [{
    id, note: "Preserve both obligations in shared guidance.", parts: [
      { to: "machine", rule: "Check ownership before writing shared state." },
      { to: "machine", rule: "Check the revision before writing shared state." },
    ],
  }] }), at(100));
  const child = result.placeholders[`split:${id}:1`];
  refusal(p, input({ machine: [id] }, { archive: [{ id: child, reason: "in-code", where: "AGENTS.md", note: "Attempt to retire a foreign condition using the host file." }] }), "CURATE_EVIDENCE");
  expect(row(child).state).toBe("active");
});
test.each([roleScope(PROJECT, "visual-critic"), "role:*:builder", projectScope(PROJECT), "machine"])("move to %s and undo restores both scope lists", to => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [], [to]: [one] }, { move: [{ id: one, to, note: "Every role at the target level acts on this guidance." }] }), at(100));
  expect(row(one).scope).toBe(to);
  if (to === "role:*:builder") {
    expect(learnedRulesBlock("other", "builder")).toContain(text);
    expect(learnedRulesBlock(PROJECT, "builder").split(text)).toHaveLength(2);
    expect(learnedRulesBlock(PROJECT, "visual-critic")).not.toContain(text);
  }
  ended(p); expect(revertCuratorPass(p.id, at(2000)).skipped).toEqual([]);
  const view = projectView(PROJECT);
  expect(view.scopes.find(s => s.scope === scope)!.active.map(r => r.id)).toEqual([one]);
  expect(view.scopes.find(s => s.scope === to)!.active).toEqual([]);
  expect(row(one).scope).toBe(scope);
});
test("moves and split parts refuse clean roles and foreign projects; widening needs a note", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  for (const to of [roleScope(PROJECT, "reviewer"), "role:*:curator", roleScope("other", "builder")]) {
    refusal(p, input({ [scope]: [], [to]: [one] }, { move: [{ id: one, to }] }), to.includes("other") ? "CURATE_SCOPE" : "CURATE_NO_READER");
    refusal(p, input({ [scope]: [one], [to]: [`split:${one}:1`] }, { split: [{ id: one, note: "Separate the readers at their levels.", parts: [{ to: scope, rule: text }, { to, rule: text }] }] }), to.includes("other") ? "CURATE_SCOPE" : "CURATE_NO_READER");
  }
  refusal(p, input({ [scope]: [], machine: [one] }, { move: [{ id: one, to: "machine" }] }), "CURATE_INVALID");
});
test("every pure move requires and retains its editorial reason", () => {
  const source = roleScope(PROJECT, "builder"), target = "role:*:builder", one = fixture(source), p = pass();
  refusal(p, input({ [source]: [], [target]: [one] }, { move: [{ id: one, to: target }] }), "CURATE_INVALID");
  applyCuration(p, input({ [source]: [], [target]: [one] }, { move: [{ id: one, to: target, note: "This applies to builders across every project." }] }), at(100));
  expect(row(one).scope).toBe(target);
  expect(row(one).note).toBe("This applies to builders across every project.");
  expect(projectView(PROJECT).scopes.find(scope => scope.scope === target)?.active.find(rule => rule.id === one)?.note).toBe("This applies to builders across every project.");
});
test("merge and move across scopes widens, saves versions and keeps the source recoverable", () => {
  const builder = roleScope(PROJECT, "builder"), critic = roleScope(PROJECT, "visual-critic"), project = projectScope(PROJECT);
  const one = fixture(builder), two = fixture(critic), p = pass();
  refusal(p, input({ [builder]: [one], [critic]: [] }, { merge: [{ into: one, from: [two], rule: text, note: "These two rules cover one class." }] }), "CURATE_NARROWS");
  const merged = "Inspect the scope and its current readers before changing stored guidance.";
  applyCuration(p, input({ [builder]: [], [critic]: [], [project]: [one] }, { move: [{ id: one, to: project, note: "Every role here uses this guidance." }], merge: [{ into: one, from: [two], rule: merged, note: "Every role here uses the combined condition." }] }), at(100));
  expect(row(one).rule).toBe(merged); expect(row(one).versions).toHaveLength(1);
  expect(row(two).mergedInto).toBe(one); expect(row(two).state).toBe("merged");
  ended(p); revertCuratorPass(p.id, at(2000));
  expect(row(one).rule).toBe(text); expect(row(two).state).toBe("active");
  expect(storedLessonTexts()).toContain(merged);
});
test("a merge target must survive every merge in the same call", () => {
  const scope = roleScope(PROJECT, "builder");
  const one = fixture(scope), two = fixture(scope), three = fixture(scope), p = pass();
  refusal(p, input({ [scope]: [three] }, { merge: [
    { into: two, from: [one], rule: text, note: "Combine the first two conditions." },
    { into: three, from: [two], rule: text, note: "Combine the remaining conditions." },
  ] }), "CURATE_PARTITION");
});
test.each([roleScope(PROJECT, "visual-critic"), projectScope(PROJECT)])("split under %s can be undone as one pass", to => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  const changed = "Inspect role-specific guidance before changing its stored scope.";
  const result = applyCuration(p, input({ [scope]: [one], [to]: [`split:${one}:1`] }, { split: [{ id: one, note: "Each part has its own readers; every role uses the project part.", parts: [{ to: scope, rule: changed }, { to, rule: text }] }] }), at(100));
  const part = result.placeholders[`split:${one}:1`];
  expect(row(part).splitFrom).toBe(one);
  const history = roleMemoryCollection()!.get(`s:${scope}`);
  expect(history?.kind === "scope" && history.history.at(-1)?.split).toEqual([{ id: one, parts: [one, part] }]);
  expect(history?.kind === "scope" && history.history.at(-1)?.rewritten).toEqual([{ id: one, version: row(one).versions![0] }]);
  ended(p); revertCuratorPass(p.id, at(2000));
  expect(row(one).rule).toBe(text); expect(row(part).reason).toBe("undone");
  expect(projectView(PROJECT).scopes.find(s => s.scope === to)!.active).toEqual([]);
});
test("curator edits accept generic Node.js and Next.js guidance", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  const rule = "Before changing Node.js or Next.js streaming behavior, test errors after the first write.";
  applyCuration(p, input({ [scope]: [one] }, { rewrite: [{ id: one, rule, note: "This validation applies to both runtime boundaries." }] }), at(100));
  expect(row(one).rule).toBe(rule);
});
test("operator-kept rules cannot be archived, split or merged away", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope, { keptByOperatorAt: at() }), two = fixture(scope), p = pass();
  refusal(p, input({ [scope]: [two] }, { archive: [{ id: one, reason: "stale", note: "The command was removed." }] }), "CURATE_KEPT");
  refusal(p, input({ [scope]: [two] }, { merge: [{ into: two, from: [one], rule: text, note: "One class covers both." }] }), "CURATE_KEPT");
  refusal(p, input({ [scope]: [one, two] }, { split: [{ id: one, note: "Two roles need different parts.", parts: [{ to: scope, rule: text }, { to: scope, rule: text }] }] }), "CURATE_KEPT");
});
test("large pass undo exceeds a small patch budget while preserving every rule and history", () => {
  const scope = roleScope(PROJECT, "builder");
  const ids = Array.from({ length: 50 }, (_, n) => fixture(scope, { rule: `${text} Condition ${n}.` }));
  const p = pass();
  for (let n = 0; n < 50; n++) applyCuration(p, input({ [scope]: ids }), at(100 + n));
  ended(p);
  expect(revertCuratorPass(p.id, at(2000)).skipped).toEqual([]);
  const held = roleMemoryCollection()!.get(`s:${scope}`);
  expect(held?.kind === "scope" && held.active).toEqual(ids);
  expect(held?.kind === "scope" && held.history.filter(h => h.pass === p.id).every(h => h.revertedAt === at(2000))).toBe(true);
  expect(ids.every(id => row(id).state === "active" && !row(id).curatedAt)).toBe(true);
}, 30_000);
test("identifier text, invalid lengths, deleted restores and versions are refused", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), removed = fixture(scope, { state: "archived", reason: "deleted" }), p = pass();
  for (const rule of ["Read the guidance for PR " + 17 + " before editing.", "short", "x".repeat(301)]) refusal(p, input({ [scope]: [one] }, { rewrite: [{ id: one, rule, note: "Make its condition clear." }] }), rule.includes("PR") ? "LESSON_ABOUT_ONE_TASK" : "CURATE_INVALID");
  refusal(p, input({ [scope]: [one, removed] }, { restore: [removed] }), "CURATE_RESTORE");
  applyCuration(p, input({ [scope]: [one] }, { rewrite: [{ id: one, rule: text + " Read its current revision.", note: "Make its condition clear." }] }), at(100));
  const version = row(one).versions![0];
  refusal(p, input({ [scope]: [one, version] }, { restore: [version] }), "CURATE_RESTORE");
});
test("restoring a budget archive participates in the order and cannot exceed the bound", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), restored = fixture(scope, { state: "archived", reason: "budget" }), p = pass();
  applyCuration(p, input({ [scope]: [restored, one] }, { restore: [restored] }), at(100));
  expect(row(restored).state).toBe("active");
  expect(projectView(PROJECT).scopes.find(s => s.scope === scope)!.active.map(r => r.id)).toEqual([one, restored]);
  const candidates = Array.from({ length: 40 }, () => fixture(scope, { state: "archived", reason: "budget", rule: "General guidance applies before writing stored scope records. ".repeat(5) }));
  refusal(p, input({ [scope]: [one, restored, ...candidates] }, { restore: candidates }), "CURATE_BOUND");
  expect(ROLE_MEMORY_BOUND).toBe(10_000);
});
test("pass undo skips a later writer, keeps new arrivals and reverses several calls", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), two = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [one, two] }, { rewrite: [{ id: one, rule: text + " Read the current revision.", note: "The revision also matters." }] }), at(100));
  applyCuration(p, input({ [scope]: [two] }, { archive: [{ id: one, reason: "stale", note: "The repository now enforces this condition." }] }), at(100));
  ended(p);
  deleteRule(two, at(2000)); const added = fixture(scope);
  const result = revertCuratorPass(p.id, at(3000));
  expect(result.skipped).toEqual([two]); expect(row(two).reason).toBe("deleted"); expect(row(one).rule).toBe(text); expect(row(one).state).toBe("active");
  expect(projectView(PROJECT).scopes.find(s => s.scope === scope)!.active.map(r => r.id)).toContain(added);
  expect(revertCuratorPass(p.id, at(4000))).toEqual(result);
  expect(readPass(p.id)!.counts.calls).toBe(2);
  patchPass(p.id, { revertedAt: undefined, skipped: undefined });
  expect(revertCuratorPass(p.id, at(5000))).toEqual(result);
});
test("pass undo crosses project succession without treating scope bookkeeping as a later edit", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  const originalScope = row(one).scope;
  applyCuration(p, input({ [scope]: [one] }, { rewrite: [{ id: one, rule: text + " Check the current revision.", note: "The revision identifies the current record." }] }), at(100));
  const curatedVersion = row(one).versions![0]!;
  ended(p);
  expect(persistProjectAliases([{ source: PROJECT, target: "curation-renamed", displayName: "curation-renamed" }])).toBe(true);
  expect(projectView("curation-renamed").scopes.flatMap(item => item.active).some(rule => rule.id === one)).toBe(true);

  expect(revertCuratorPass(p.id, at(2000))).toEqual({ skipped: [] });
  expect(row(one).rule).toBe(text);
  expect(row(one).scope).toBe(originalScope);
  expect(row(one).versions).toContain(curatedVersion);
  expect(row(one).versions).toHaveLength(2);
  const restoredScope = projectView("curation-renamed").scopes.find(item => item.scope === canonicalScope(originalScope));
  expect(restoredScope?.active.some(rule => rule.id === one)).toBe(true);
});
test("project succession keeps completed pass history, undo and the next-run cooldown under both names", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [one] }, { rewrite: [{ id: one, rule: text + " Check the current revision.", note: "The revision identifies the current record." }] }), at(100));
  ended(p);
  const laterSource: RuleSource = { project: PROJECT, pipelineId: "after-curation", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_after_curation" };
  recordLessonRequest({ ...laterSource, at: at(100) });
  leaveLessons({ request: laterSource, source: laterSource, lessons: [{ scope: "role", rule: "Check stored guidance against each newly observed condition.", why },], none: null, now: at(100) });
  expect(curationStatus(PROJECT, NOW + 200).newLessons).toBe(1);
  expect(persistProjectAliases([{ source: PROJECT, target: "curation-renamed", displayName: "curation-renamed" }])).toBe(true);

  const oldView = curationView(PROJECT, NOW + 1000);
  const newView = curationView("curation-renamed", NOW + 1000);
  expect(oldView.passes).toEqual(newView.passes);
  expect(oldView.passes.map(item => item.id)).toContain(p.id);
  expect(oldView.lastAt).toBe(at(1000));
  expect(newView.lastAt).toBe(oldView.lastAt);
  expect(newView.nextAt).toBe(oldView.nextAt);
  expect(curationStatus("curation-renamed", NOW + 200).newLessons).toBe(1);
  expect(curationStatus("curation-renamed", NOW + 1000 + CURATION_INTERVAL_MS - 1).due).toBe(false);
  expect(claimPass({ project: "curation-renamed", repoDir: dir, now: NOW + 1000 + CURATION_INTERVAL_MS - 1 })).toBeNull();
  projectView("curation-renamed");
  for (let attempt = 2; attempt <= 10; attempt += 1) {
    const source: RuleSource = { ...laterSource, project: "curation-renamed", attempt, pipelineId: "after-curation" };
    recordLessonRequest({ ...source, at: at(100) });
    leaveLessons({ request: source, source, lessons: [{ scope: "role", rule: `Check stored guidance before changing condition ${attempt}.`, why }], none: null, now: at(100) });
  }
  expect(curationStatus("curation-renamed", NOW + 20 * 60_000).due).toBe(false);
  expect(claimPass({ project: "curation-renamed", repoDir: dir, now: NOW + 20 * 60_000 })).toBeNull();
  expect(revertCuratorPass(p.id, at(2000))).toEqual({ skipped: [] });
});
test("project succession keeps a live pass visible and owned through either project name", () => {
  fixture(); const p = pass();
  expect(persistProjectAliases([{ source: PROJECT, target: "curation-renamed", displayName: "curation-renamed" }])).toBe(true);
  expect(claimPass({ project: "curation-renamed", repoDir: dir, now: NOW + 1 })).toBeNull();
  expect(projectView(PROJECT).curation?.passes[0]?.id).toBe(p.id);
  expect(projectView("curation-renamed").curation?.passes[0]?.id).toBe(p.id);
  expect(machinePass()?.id).toBe(p.id);
  ended(p);
  expect(projectView(PROJECT).curation?.passes[0]?.state).toBe("succeeded");
  expect(projectView("curation-renamed").curation?.passes[0]?.state).toBe("succeeded");
  expect(projectView("curation-renamed").curation?.lastAt).toBe(at(1000));
});
test("project succession preserves undo ordering between independently numbered scopes", () => {
  const sourceScope = roleScope(PROJECT, "builder"), targetProject = "curation-renamed";
  const sourceRules = Array.from({ length: 50 }, () => fixture(sourceScope));
  const sourcePass = pass();
  applyCuration(sourcePass, input({ [sourceScope]: sourceRules }), at(100));
  applyCuration(sourcePass, input({ [sourceScope]: sourceRules }), at(101));
  ended(sourcePass);

  const targetScope = roleScope(targetProject, "builder"), targetRule = fixture(targetScope);
  const targetPass = pass(NOW + 1, targetProject);
  const rewritten = "Inspect current scope history before changing stored rule guidance.";
  applyCuration(targetPass, input({ [targetScope]: [targetRule] }, {
    rewrite: [{ id: targetRule, rule: rewritten, note: "Clarify the condition for this scope." }],
  }), at(200));
  ended(targetPass, 200);

  expect(persistProjectAliases([{ source: PROJECT, target: targetProject, displayName: targetProject }])).toBe(true);
  projectView(targetProject);

  expect(revertCuratorPass(targetPass.id, at(3000))).toEqual({ skipped: [] });
  expect(row(targetRule).rule).toBe(text);
  expect(row(targetRule).why).toBe(why);
  expect(row(targetRule).scope).toBe(targetScope);
  expect(projectView(targetProject).scopes.find(scope => scope.scope === targetScope)!.active.map(rule => rule.id)).toContain(targetRule);
});
test("project succession counts destination lessons against their own claim history", () => {
  const sourceScope = roleScope(PROJECT, "builder"), targetProject = "curation-renamed";
  const sourceRules = Array.from({ length: 50 }, () => fixture(sourceScope));
  const sourcePass = pass();
  applyCuration(sourcePass, input({ [sourceScope]: sourceRules }), at(100));
  applyCuration(sourcePass, input({ [sourceScope]: sourceRules }), at(101));
  ended(sourcePass);

  const targetScope = roleScope(targetProject, "builder"), targetRule = fixture(targetScope);
  const targetPass = pass(NOW + 1, targetProject);
  applyCuration(targetPass, input({ [targetScope]: [targetRule] }), at(200));
  ended(targetPass, 200);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const source: RuleSource = { project: targetProject, pipelineId: "succession-lessons", stageId: "build", attempt, roleId: "builder", fixRound: false, conversationId: "succession-reader" };
    recordLessonRequest({ ...source, at: at(300 + attempt) });
    leaveLessons({ request: source, source, lessons: [{ scope: "role", rule: `Inspect destination scope history before changing condition ${attempt}.`, why }], none: null, now: at(300 + attempt) });
  }

  expect(persistProjectAliases([{ source: PROJECT, target: targetProject, displayName: targetProject }])).toBe(true);
  projectView(targetProject);

  const status = curationStatus(targetProject, NOW + 31 * 60_000);
  expect(status.newLessons).toBe(10);
  expect(status.due).toBe(false);
});
test("post-succession same-time curator rankings remain a later undo guard", () => {
  const sourceScope = roleScope(PROJECT, "builder"), targetProject = "curation-renamed";
  const sourceRules = Array.from({ length: 50 }, () => fixture(sourceScope));
  const sourcePass = pass();
  applyCuration(sourcePass, input({ [sourceScope]: sourceRules }), at(100));
  applyCuration(sourcePass, input({ [sourceScope]: sourceRules }), at(101));
  ended(sourcePass);

  const targetScope = roleScope(targetProject, "builder"), targetRule = fixture(targetScope);
  const targetPass = pass(NOW + 1, targetProject);
  const rewritten = "Inspect current scope history before changing stored rule guidance.";
  applyCuration(targetPass, input({ [targetScope]: [targetRule] }, {
    rewrite: [{ id: targetRule, rule: rewritten, note: "Clarify the condition for this scope." }],
  }), at(200));
  ended(targetPass, 200);

  expect(persistProjectAliases([{ source: PROJECT, target: targetProject, displayName: targetProject }])).toBe(true);
  projectView(targetProject);
  const laterPass = pass(NOW + CURATION_INTERVAL_MS + 5000, targetProject);
  const joinedOrder = projectView(targetProject).scopes.find(scope => scope.scope === targetScope)!.active.map(rule => rule.id);
  applyCuration(laterPass, input({ [targetScope]: joinedOrder }), at(200));
  ended(laterPass, CURATION_INTERVAL_MS + 6000);

  expect(revertCuratorPass(targetPass.id, at(CURATION_INTERVAL_MS + 7000))).toEqual({ skipped: [targetRule] });
  expect(row(targetRule).rule).toBe(rewritten);
});
test("a live pass reads and applies canonical scopes after project succession", async () => {
  const originalScope = roleScope(PROJECT, "builder"), one = fixture(originalScope), p = pass();
  const staleCursor = Buffer.from(JSON.stringify({ scope: originalScope, revision: 1, offset: 0 })).toString("base64url");
  expect(persistProjectAliases([{ source: PROJECT, target: "curation-renamed", displayName: "curation-renamed" }])).toBe(true);

  const renamedScope = roleScope("curation-renamed", "builder");
  const overview = await readCuration(p);
  if (!("scopes" in overview) || !overview.scopes) throw Error("expected the pass scope list");
  const listed = overview.scopes.find(item => item.scope === renamedScope);
  if (!listed) throw Error("successor scope is missing from the live pass");
  const current = roleMemoryCollection()?.get(`s:${renamedScope}`);
  expect(listed.revision).toBe(current?.kind === "scope" ? current.revision : -1);
  const read = await readCuration(p, renamedScope);
  if (!("rules" in read)) throw Error("expected the successor scope rules");
  expect(read.rules.some(rule => rule.kind === "active" && rule.id === one)).toBe(true);
  try { await readCuration(p, originalScope, staleCursor); throw Error("accepted a cursor from before succession"); }
  catch (error) { expect((error as { code?: string }).code).toBe("CURATE_STALE"); }

  const edit = input({ [renamedScope]: [one] }, { rewrite: [{ id: one, rule: text + " Follow the current scope revision.", note: "This remains useful to builders in every task." }] });
  expect(() => applyCuration(p, edit, at(100))).not.toThrow();
  const versionId = row(one).versions![0];
  expect(roleMemoryCollection()?.get(`r:${versionId}`)).toMatchObject({ kind: "rule", rule: text, versionOf: one });
  ended(p);
  expect(revertCuratorPass(p.id, at(2000)).skipped).toEqual([]);
  expect(row(one).rule).toBe(text);
  expect(row(one).versions).toHaveLength(2);
});
test("the v1 row kinds and optional metadata survive an apply, and clean curator has no injected rules", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [], "role:*:builder": [one] }, { move: [{ id: one, to: "role:*:builder", note: "Builders across projects use this guidance." }], rewrite: [{ id: one, rule: text + " Read its revision.", note: "The revision identifies the current record." }] }), at(100));
  const legacy = new SqliteStateCollection<RoleMemoryRow>(path.join(dir, "state.sqlite"), {
    collection: "role_memory", schemaVersion: 1, busyMessage: "fixture busy", clone: structuredClone,
    key: r => r.kind === "rule" ? `r:${r.id}` : r.kind === "scope" ? `s:${r.scope}` : `q:${r.pipelineId}:${r.stageId}:${r.attempt}`,
    decode: value => { const r = value as RoleMemoryRow; return ["rule", "scope", "request"].includes(r.kind) ? r : null; }, strictDecode: true,
  });
  const rows = legacy.snapshot();
  expect(rows.some(r => r.kind === "rule" && r.versionOf === one)).toBe(true);
  expect(rows.some(r => r.kind === "scope" && r.scope === "role:*:builder" && r.active.includes(one))).toBe(true);
  expect(roleIsClean("curator")).toBe(true);
});
test("a direct health check has no curator; tick hooks run around gathering and failures reach the journal", async () => {
  fixture(); const registry = new AgentRegistry(path.join(dir, "registry.json"));
  const events: string[] = [];
  let state = emptySeatTickState();
  const sources = { ...defaultSeatTickSources(), now: () => NOW, registry: () => registry,
    seatFor: () => ({ active: null, pending: null, history: [] }), activeSeats: () => [], pipelines: () => [], archivedPipelines: () => [],
    tasks: () => { events.push("gather"); return []; }, liveness: async () => [],
    lifecycleJournal: () => ({ version: 1 as const, lastSeq: 0, events: [], retired: [] }), latestDeployment: () => ({ state: "ok" as const, value: null }),
    retirementReport: () => null, reports: undefined, maintenanceRuns: () => [], recordRuleReports: undefined, recordDeploySnapshots: undefined,
    workerCounts: undefined,
  };
  const deps = { sources, policy: tickInput().policy, reconcileSeat: () => null,
    readState: () => state, writeState: (_project: string, value: typeof state) => { state = value; }, appendRecord: () => {}, ensureCard: () => true };
  await runSeatTickCheck(PROJECT, deps);
  expect(machinePass()).toBeNull();
  events.length = 0;
  const record = await runSeatTickCheck(PROJECT, { ...deps, curation: {
    reconcile: async () => { events.push("reconcile"); throw Error("fixture reconcile failed"); },
    launchIfDue: async () => { events.push("launch"); throw Error("fixture launch failed"); },
  } });
  expect(record?.detail).not.toContain("the check failed");
  expect(events[0]).toBe("reconcile");
  expect(events.indexOf("gather")).toBeLessThan(events.indexOf("launch"));
  expect(record?.detail).toContain("curation reconcile: fixture reconcile failed");
  expect(record?.detail).toContain("curation launch: fixture launch failed");
});
test("separate scope calls at one clock instant retain distinct counts and undo records", () => {
  const builder = roleScope(PROJECT, "builder"), project = projectScope(PROJECT);
  const one = fixture(builder), two = fixture(project), p = pass();
  for (const [scope, id] of [[builder, one], [project, two]]) applyCuration(p, input({ [scope]: [id] }, { rewrite: [{ id, rule: text + " Read its current revision.", note: "Retain the revision condition." }] }), at(100));
  expect(readPass(p.id)!.counts.calls).toBe(2);
  expect(readPass(p.id)!.counts.rewritten).toBe(2);
  ended(p); revertCuratorPass(p.id, at(2000));
  expect(row(one).rule).toBe(text); expect(row(two).rule).toBe(text);
});
test("a late launch answer cannot revive a completed pass or reopen mutation", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  ended(p);
  patchPass(p.id, { state: "running", conversationId: "conversation_late" });
  expect(readPass(p.id)!.state).toBe("succeeded");
  expect(machinePass()).toBeNull();
  refusal(p, input({ [scope]: [one] }), "CURATE_ENDED");
});
test("guard binds an early receipt and admits only the machine's live curator conversation", () => {
  fixture(); const p = pass(); const registry = new AgentRegistry(path.join(dir, "registry.json"));
  const snapshot = structuredClone(registry.readOnlySnapshot());
  const id = ["conversation", "curator"].join("_") as `conversation_${string}`;
  snapshot.conversations[id] = { id, agentRole: "curator", projectOwnership: { project: PROJECT }, generations: [], continuityPaths: [] } as never;
  snapshot.receipts.fixture = { conversationId: id, agentRole: "curator", clientAttemptId: p.id, explicitProject: PROJECT, state: "completed", launchId: "fixture", artifactPath: null } as never;
  expect(curatorCallerOf(id, snapshot).id).toBe(p.id);
  expect(() => curatorCallerOf(null, snapshot)).toThrow(/live curator/);
  snapshot.conversations[id].agentRole = "builder";
  expect(() => curatorCallerOf(id, snapshot)).toThrow(/not a curator/);
  snapshot.conversations[id].agentRole = "curator"; ended(p);
  expect(() => curatorCallerOf(id, snapshot)).toThrow(/live pass/);
  expect(permitCuratorTool("create_task", {})).toHaveProperty("allowed", false);
  expect(permitCuratorTool("curate_rules", { action: "apply" })).toHaveProperty("allowed", true);
  expect(permitCuratorTool("role_presets", {})).toHaveProperty("allowed", true);
  expect(permitCuratorTool("role_presets", { overrides: [] })).toHaveProperty("allowed", false);
});
test("the evaluation fixture receipt carries the claimed pass project", () => {
  fixture(); const p = pass(); const registry = new AgentRegistry(path.join(dir, "evaluation-registry.json"));
  const snapshot = structuredClone(registry.readOnlySnapshot());
  const id = ["conversation", "evaluation"].join("_") as `conversation_${string}`;
  snapshot.conversations[id] = { id, agentRole: "curator", projectOwnership: { project: p.project }, generations: [], continuityPaths: [] } as never;
  snapshot.receipts.fixture = { conversationId: id, agentRole: "curator", clientAttemptId: p.id, explicitProject: p.project,
    launchProfile: { project: p.project }, state: "completed", launchId: "fixture", artifactPath: null } as never;
  expect(curatorCallerOf(id, snapshot).id).toBe(p.id);
});
test("a curator receipt from another project cannot claim or authorize the pass", () => {
  fixture(); const p = pass(); const registry = new AgentRegistry(path.join(dir, "registry.json"));
  const snapshot = structuredClone(registry.readOnlySnapshot());
  const id = ["conversation", "foreign-curator"].join("_") as `conversation_${string}`;
  snapshot.conversations[id] = { id, agentRole: "curator", projectOwnership: { project: "foreign-project" }, generations: [], continuityPaths: [] } as never;
  snapshot.receipts.fixture = { conversationId: id, agentRole: "curator", clientAttemptId: p.id, explicitProject: "foreign-project", state: "completed", launchId: "fixture", artifactPath: null } as never;
  expect(() => curatorCallerOf(id, snapshot)).toThrow();
  expect(readPass(p.id)?.conversationId).toBeNull();
});
test("ordinary structured recovery cannot continue a curator pass after its seat disappears", async () => {
  fixture(); const f = hostingFixture(), p = pass(); const registry = f.sources.registry();
  const sessionId = "curator-recovery-fixture";
  const artifactPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-test");
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: dir, accountId: "codex-test", role: "curator" as never,
    clientAttemptId: p.id, explicitProject: PROJECT, transport: "structured", conversationId: conversation.id,
    launchProfile: { cwd: dir, project: PROJECT, role: "curator" as never, title: "Role memory curation" } });
  if (begun.kind !== "created") throw new Error("curator fixture receipt did not materialize");
  const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId }, artifactPath, cwd: dir,
    accountId: "codex-test", launchProfile: begun.receipt.launchProfile, status: "dead", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind !== "settled") throw new Error("curator fixture spawn did not settle");
  const conversationId = conversation.id;
  registry.conversation = AgentRegistry.prototype.conversation.bind(registry);
  expect(registry.conversation(conversationId)?.generations.at(-1)?.path).toBe(artifactPath);
  expect(registry.readOnlySnapshot().entries[`codex:${sessionId}`]?.status).toBe("dead");
  patchPass(p.id, { state: "running", launchedAt: at(), conversationId, launchId: begun.receipt.launchId });
  let spawns = 0;
  await expect(recoverDeadStructuredConversation({ path: artifactPath, conversationId }, {
    registry: registry as never, client: {} as RuntimeHostClient, transport: () => "structured", park: () => null,
    resolveAccount: () => ({ engine: "codex", accountId: "codex-test", kind: "managed", home: dir, transcriptRoot: dir, env: { NODE_ENV: "test" } }),
    spawn: async () => { spawns++; throw new Error("ineligible curator recovery spawned"); },
  })).rejects.toThrow(/curation pass abandoned/);
  expect(spawns).toBe(0);
  expect(readPass(p.id)).toMatchObject({ state: "failed", failure: expect.stringContaining("abandoned") });
  expect(machinePass()).toBeNull();
});
test("stubbed launch, restart reconcile and settle keep no board card", async () => {
  fixture(); let now = NOW, endedTurn = false; const bodies: Record<string, unknown>[] = [], archived: string[] = [];
  const f = hostingFixture(); f.seat();
  const sources = { ...f.sources, now: () => now };
  const controller = productionCurationController(sources, { launch: async body => { bodies.push(body); return { status: 202, body: { state: "running", conversationId: "fixture-curator", launchId: "fixture" } }; }, observe: async () => ({ state: endedTurn ? "ended" : "running", finalText: "Checked scopes; retained current rules." }), archive: p => { archived.push(p.id); } });
  const tick = { ...tickInput(), project: PROJECT };
  await controller.launchIfDue({ ...tick, settings: { ...tick.settings, enabled: false } }); expect(bodies).toHaveLength(0);
  sources.latestDeployment = () => ({ state: "ok", value: { terminal: false } as never });
  expect(await controller.launchIfDue(tick)).toContain("deployment"); expect(machinePass()).toBeNull();
  sources.latestDeployment = () => ({ state: "ok", value: null });
  expect(await controller.launchIfDue(tick)).toContain("launched"); await controller.launchIfDue(tick); expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ role: "curator", cwd: dir, mcpServers: ["viewer"] }); expect(bodies[0].taskId).toBeString();
  expect(loadTasks(path.join(dir, "tasks.json")).find(task => task.id === bodies[0].taskId)).toMatchObject({ status: "done", board: "hidden" });
  now += 1000; endedTurn = true; expect(await controller.reconcile(PROJECT)).toContain("settled"); expect(archived).toHaveLength(1); expect(machinePass()).toBeNull();
  expect(projectView(PROJECT).curation?.passes[0].state).toBe("succeeded");
});

test("pressure survives a failed pass, and the durable interval bounds retries after restart", async () => {
  const scope = roleScope(PROJECT, "builder");
  const ids = Array.from({ length: 26 }, (_, i) => fixture(scope, { rule: `Check ownership category ${i} before publication. ${"guidance ".repeat(29)}`.slice(0, 300), curatedAt: at() }));
  const initial = pass(); ended(initial);
  expect(curationStatus(PROJECT, NOW + 31 * 60_000).due).toBe(false);
  const added: string[] = [];
  for (let i = 0; i < 10; i++) {
    const source: RuleSource = { project: PROJECT, pipelineId: "pressure", stageId: "build", attempt: i + 1, roleId: "builder", fixRound: false, conversationId: "conversation_pressure" };
    recordLessonRequest({ ...source, at: at(2000 + i) });
    const lesson = leaveLessons({ request: source, source, lessons: [{ scope: "role", rule: `Inspect pending ownership category ${i} before writing. ${"guidance ".repeat(29)}`.slice(0, 300), why }], none: null, now: at(2000 + i) }).left[0]!;
    added.push(lesson.id);
    expect(lesson.archived.some(id => added.includes(id))).toBe(false);
    if (i === 0) expect(curationStatus(PROJECT, NOW + 31 * 60_000).due).toBe(false);
    if (i === 1) expect(curationStatus(PROJECT, NOW + 31 * 60_000)).toMatchObject({ due: false, pressure: true });
  }
  // Available curation integrates every lesson before any budget archive.
  expect(roleMemoryCollection()!.snapshot().filter(row => row.kind === "rule" && row.reason === "budget" && !row.curatedAt)).toEqual([]);
  const early = pass(NOW + CURATION_INTERVAL_MS + 1000);
  expect(early).not.toBeNull();
  patchPass(early.id, { state: "failed", endedAt: at(CURATION_INTERVAL_MS + 2000), failure: "fixture failure" });
  for (const id of added) expect(row(id).state).toBe("active");
  expect(pass(NOW + CURATION_INTERVAL_MS + 33 * 60_000)).toBeNull();
  const script = `import { curationStatus, claimPass } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; console.log(JSON.stringify({ due: curationStatus(${JSON.stringify(PROJECT)}, ${NOW + CURATION_INTERVAL_MS + 33 * 60_000}).due, claimed: !!claimPass({ project: ${JSON.stringify(PROJECT)}, repoDir: null, now: ${NOW + CURATION_INTERVAL_MS + 33 * 60_000} }) }));`;
  const restarted = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [exit, output, error] = await Promise.all([restarted.exited, new Response(restarted.stdout).text(), new Response(restarted.stderr).text()]);
  expect(exit).toBe(0); expect(error).toBe("");
  expect(JSON.parse(output)).toEqual({ due: false, claimed: false });
  const retried = pass(NOW + 2 * CURATION_INTERVAL_MS + 2000);
  expect(retried).not.toBeNull();
  const active = [...ids, ...added].filter(id => row(id).state === "active");
  applyCuration(retried, input({ [scope]: active.filter(id => !ids.slice(0, 6).includes(id)) }, {
    merge: [{ into: added[0], from: ids.slice(0, 6), rule: "Check ownership and pending guidance before publication or writing shared state.", note: "Integrate the shared ownership conditions before reducing the scope." }],
  }), at(2 * CURATION_INTERVAL_MS + 3000));
  for (const id of added) expect(row(id).curatedAt).toBeTruthy();
  expect(curationStatus(PROJECT, NOW + 2 * CURATION_INTERVAL_MS + 63 * 60_000).due).toBe(false);
});

test("aliased physical scopes share the pressure threshold within the interval", () => {
  const oldScope = roleScope(PROJECT, "builder");
  const currentProject = "curation-pressure-renamed";
  const currentScope = roleScope(currentProject, "builder");
  const rulesFor = (scope: string, prefix: string) => Array.from({ length: 15 }, (_, i) => fixture(scope, {
    rule: `${prefix} ${i}: ${"preserve the scoped operational guidance and verify ownership before applying changes. ".repeat(4)}`.slice(0, 300),
    curatedAt: at(),
  }));
  const oldRules = rulesFor(oldScope, "Retained prior rule");
  const currentRules = rulesFor(currentScope, "Current canonical rule");
  const priorPass = pass();
  ended(priorPass);

  const newLesson: RuleSource = { project: PROJECT, pipelineId: "alias-pressure", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_alias_pressure" };
  recordLessonRequest({ ...newLesson, at: at(2000) });
  leaveLessons({ request: newLesson, source: newLesson, lessons: [{ scope: "role", rule: "Inspect the merged role scope before the next write.", why }], none: null, now: at(2000) });

  expect(persistProjectAliases([{ source: PROJECT, target: currentProject, displayName: currentProject }])).toBe(true);
  const collection = roleMemoryCollection()!;
  const oldActive = collection.get(`s:${oldScope}`);
  const currentActive = collection.get(`s:${currentScope}`);
  if (oldActive?.kind !== "scope" || currentActive?.kind !== "scope") throw Error("aliased scope rows missing");
  const merged = [...oldActive.active, ...currentActive.active];
  expect(merged).toHaveLength(31);
  expect(scopeChars(oldActive.active.map(id => row(id)))).toBeLessThan(ROLE_MEMORY_BOUND * 0.9);
  expect(scopeChars(currentActive.active.map(id => row(id)))).toBeLessThan(ROLE_MEMORY_BOUND * 0.9);
  expect(scopeChars(merged.map(id => row(id)))).toBeGreaterThanOrEqual(ROLE_MEMORY_BOUND * 0.9);
  expect(oldRules.every(id => row(id).state === "active")).toBe(true);
  expect(currentRules.every(id => row(id).state === "active")).toBe(true);
  expect(curationStatus(currentProject, NOW + 31 * 60_000)).toMatchObject({ due: false, pressure: true, newLessons: 1 });
});

test("a scope containing only unseen lessons may exceed budget until a bounded curator partition commits", () => {
  const scope = roleScope(PROJECT, "builder");
  const ids = Array.from({ length: 30 }, (_, i) => fixture(scope, { rule: `Check pending category ${i} before publication. ${"guidance ".repeat(30)}`.slice(0, 300) }));
  const source: RuleSource = { project: PROJECT, pipelineId: "at-bound", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_bound" };
  recordLessonRequest({ ...source, at: at(2000) });
  const added = leaveLessons({ request: source, source, none: null, lessons: [{ scope: "role", rule: `Inspect new pending categories before writing. ${"guidance ".repeat(30)}`.slice(0, 300), why }], now: at(2000) }).left[0]!;
  expect(added.archived).toEqual([]);
  expect(added.scopeChars).toBeGreaterThan(ROLE_MEMORY_BOUND);
  const p = pass();
  refusal(p, input({ [scope]: [...ids, added.id] }), "CURATE_BOUND");
  expect(row(added.id).curatedAt).toBeUndefined();
  applyCuration(p, input({ [scope]: ids.slice(1).concat(added.id) }, { archive: [{ id: ids[0], reason: "stale", note: "An older obligation no longer applies to current readers." }] }));
  expect(projectView(PROJECT).scopes.find(s => s.scope === scope)!.chars).toBeLessThanOrEqual(ROLE_MEMORY_BOUND);
});


test("warm curation status skips payload reads and invalidates after a durable scope change", () => {
  const scope = roleScope(PROJECT, "builder");
  fixture(scope);
  curationStatus(PROJECT, NOW);
  const collection = roleMemoryCollection()!;
  const snapshot = spyOn(collection, "snapshot");
  const get = spyOn(collection, "get");
  try {
    curationStatus(PROJECT, NOW + 1);
    expect(snapshot).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    const writer = new Database(path.join(dir, "state.sqlite"));
    try { writer.exec("CREATE TABLE unrelated_fixture (value INTEGER)"); writer.exec("INSERT INTO unrelated_fixture VALUES (1)"); } finally { writer.close(); }
    curationStatus(PROJECT, NOW + 2);
    expect(get).not.toHaveBeenCalled();
    fixture(scope);
    get.mockClear();
    curationStatus(PROJECT, NOW + 2);
    expect(snapshot).not.toHaveBeenCalled(); expect(get).toHaveBeenCalled();
  } finally { snapshot.mockRestore(); get.mockRestore(); }
});


test("an interval-due pressured project is dispatched while a newer quiet project waits", async () => {
  const quiet = "quiet-fixture";
  fixture(roleScope(quiet, "builder"), { curatedAt: at() });
  ended(pass(NOW - 2 * 60 * 60_000, quiet), -60 * 60_000);
  const scope = roleScope(PROJECT, "builder");
  for (let i = 0; i < 26; i++) fixture(scope, { rule: `Inspect ownership category ${i}. ${"guidance ".repeat(35)}`.slice(0, 300), curatedAt: at() });
  ended(pass(NOW - 8 * 60 * 60_000), -7 * 60 * 60_000);
  for (let i = 0; i < 2; i++) fixture(scope, { rule: `Inspect pending category ${i}. ${"guidance ".repeat(35)}`.slice(0, 300) });
  expect(curationStatus(quiet, NOW).due).toBe(false);
  expect(curationStatus(PROJECT, NOW)).toMatchObject({ due: true, newLessons: 0 });
  const f = hostingFixture(); f.seat(PROJECT, at(-20_000)); f.seat(quiet, at(-1000));
  expect(await f.controller.launchIfDue(f.tick)).toContain("launched");
  expect(f.bodies).toHaveLength(1); expect(f.bodies[0].project).toBe(PROJECT);
});


test("a successful no-op leaves pressure but cannot relaunch at the old cooldown", async () => {
  const scope = roleScope(PROJECT, "builder");
  for (let i = 0; i < 32; i++) fixture(scope, { rule: `Inspect retained category ${i}. ${"guidance ".repeat(35)}`.slice(0, 300) });
  const first = pass(); ended(first);
  // Ending a turn does not rank scopes: only applyCuration stamps curatedAt.
  expect(curationStatus(PROJECT, NOW + 31 * 60_000)).toMatchObject({ pressure: true, due: false });
  expect(pass(NOW + 31 * 60_000)).toBeNull();
  const script = `import { curationStatus, claimPass } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; console.log(JSON.stringify({ before: !!claimPass({ project: ${JSON.stringify(PROJECT)}, repoDir: null, now: ${NOW + CURATION_INTERVAL_MS} }), at: !!claimPass({ project: ${JSON.stringify(PROJECT)}, repoDir: null, now: ${NOW + CURATION_INTERVAL_MS + 1000} }) }));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0); expect(error).toBe(""); expect(JSON.parse(output)).toEqual({ before: false, at: true });
});

test("curator off survives restart and is independent of board maintenance", async () => {
  const { defaultSeatTickSettings, writeSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
  fixture();
  writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), curation: { enabled: false, intervalHours: 12, updatedAt: at(), setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } });
  const f = hostingFixture(); f.seat();
  expect(await f.controller.launchIfDue(f.tick)).toContain("curator off");
  expect(f.bodies).toHaveLength(0); expect(pass()).toBeNull();
  const script = `import { claimPass } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; console.log(JSON.stringify(!!claimPass({ project: ${JSON.stringify(PROJECT)}, repoDir: null, now: ${NOW + 24 * 3600000} })));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exit).toBe(0); expect(JSON.parse(output)).toBe(false);
});

test("turning curator off while liveness is pending refuses deferred launch", async () => {
  const { defaultSeatTickSettings, writeSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
  fixture(); const f = hostingFixture(); f.seat();
  const original = f.sources.liveness;
  f.sources.liveness = async input => {
    const records = await original(input);
    writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), curation: { enabled: false, intervalHours: 6, updatedAt: at(), setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } });
    return records;
  };
  expect(await f.controller.launchIfDue(f.tick)).toContain("curator off"); expect(f.bodies).toHaveLength(0);
});


test("the configured twelve-hour interval survives a fresh process", async () => {
  const { defaultSeatTickSettings, writeSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
  fixture(); const first = pass(); ended(first);
  writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), curation: { enabled: true, intervalHours: 12, updatedAt: at(), setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } });
  const script = `import { claimPass } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; console.log(JSON.stringify({ six: !!claimPass({ project: ${JSON.stringify(PROJECT)}, repoDir: null, now: ${NOW + CURATION_INTERVAL_MS + 1000} }), twelve: !!claimPass({ project: ${JSON.stringify(PROJECT)}, repoDir: null, now: ${NOW + 2 * CURATION_INTERVAL_MS + 1000} }) }));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0); expect(error).toBe(""); expect(JSON.parse(output)).toEqual({ six: false, twelve: true });
});


test("the panel reads persisted conversation, counts, last result and next eligibility", async () => {
  const { curationAnswer } = await import("./answer");
  const { defaultSeatTickSettings, effectiveSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
  const id = fixture(); const p = pass();
  applyCuration(p, input({ [roleScope(PROJECT, "builder")]: [id] }), at(500));
  patchPass(p.id, { conversationId: "conversation_curator_result" }); ended(p);
  const settings = effectiveSeatTickSettings(defaultSeatTickSettings(PROJECT), NOW + 2000, 3600000);
  expect(curationAnswer(PROJECT, settings, NOW + 2000)).toMatchObject({ enabled: true, intervalHours: 6, live: null,
    lastRun: { id: p.id, state: "succeeded", conversationId: "conversation_curator_result", endedAt: at(1000), counts: { calls: 1 } },
    nextRunAt: at(1000 + CURATION_INTERVAL_MS), waitingOn: null });
  expect(curationAnswer(PROJECT, { ...settings, enabled: false }, NOW + 2000)).toMatchObject({ waitingOn: "wakes-off", nextRunAt: null });
});

test("an unreadable curation store keeps its timer controls and reports an error", async () => {
  const { curationAnswer } = await import("./answer");
  const store = await import("./store");
  const { defaultSeatTickSettings, effectiveSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
  const broken = spyOn(store, "curationPanelRuns").mockImplementation(() => { throw Error("fixture curation store unavailable"); });
  try {
    expect(curationAnswer(PROJECT, effectiveSeatTickSettings(defaultSeatTickSettings(PROJECT), NOW, 3600000), NOW)).toMatchObject({
      enabled: true, intervalHours: 6, nextRunAt: null, runsError: "fixture curation store unavailable" });
  } finally { broken.mockRestore(); }
});

test.each(["off","sqlite"] as const)("curator authority is equivalent through the keyed %s registry view", mode => {
  fixture(); const p = pass();
  const registry = new AgentRegistry(path.join(dir,"keyed-registry.json"),undefined,undefined,{sqliteMode:mode});
  const conversation = registry.ensureConversation("codex",path.join(dir,"curator.jsonl"),null);
  const begun = registry.beginSpawnRequest({engine:"codex",cwd:dir,accountId:null,role:"curator" as never,
    clientAttemptId:p.id,explicitProject:PROJECT,transport:"structured",conversationId:conversation.id,
    launchProfile:{cwd:dir,project:PROJECT,role:"curator" as never,title:"Role memory curation"}});
  if (begun.kind!=="created") throw new Error("fixture admission failed");
  const old = curatorCallerOf(conversation.id,registry.readOnlySnapshot());
  const full = spyOn(registry,"readOnlySnapshot");
  try {
    const narrowed = registry.curatorConversationSnapshot(conversation.id);
    expect(curatorCallerOf(conversation.id,narrowed).id).toBe(old.id);
    expect(Object.keys(narrowed.receipts)).toEqual([begun.receipt.launchId]);
    if (mode==="sqlite") expect(full).not.toHaveBeenCalled();
    narrowed.conversations[conversation.id].agentRole="builder";
    expect(()=>curatorCallerOf(conversation.id,narrowed)).toThrow(/not a curator/);
    expect(curatorCallerOf(conversation.id,registry.curatorConversationSnapshot(conversation.id)).id).toBe(old.id);
  } finally {full.mockRestore();}
});


test("a foreign read scope refuses before requesting pipeline history",async () => {
  fixture();const p=pass();
  const history=spyOn(pipelineStore,"pipelineSelectionSource").mockImplementation(()=>{throw new Error("history is unavailable");});
  try {
    await expect(readCuration(p,roleScope("foreign-project","builder"))).rejects.toMatchObject({code:"CURATE_SCOPE"});
    expect(history).not.toHaveBeenCalled();
  } finally {history.mockRestore();}
});


test("authority reads never decode scope history across tenfold growth and still see terminal transitions", async () => {
  fixture();
  const live = pass();
  patchPass(live.id, { state: "running", conversationId: "conversation_authority" });
  const memory = roleMemoryCollection()!;
  for (const count of [10, 100]) {
    memory.boundedPatch(2, tx => {
      const row = tx.get(`s:${roleScope(PROJECT, "builder")}`);
      if (row?.kind !== "scope") throw Error("missing scope");
      tx.put({ ...row, history: Array.from({ length: count }, (_, n) => ({ revision: n + 1, at: at(n), by: "curator" as const,
        pass: live.id, counts: { ...live.counts, calls: 1 }, before: [], added: [], merged: [], archived: [] })) });
    });
    const peer = new Database(path.join(dir, "state.sqlite"));
    try {
      const retained = Array.from({ length: count / 2 }, (_, n) => `curate_history_${n}`);
      for (const id of retained) peer.query("INSERT OR REPLACE INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES('role_memory_curation',?,?,100,1,0)")
        .run(`r:${id}`, JSON.stringify({ ...live, id, state: "succeeded", endedAt: at(1), conversationId: null }));
      peer.query("UPDATE state_rows SET value_json=json_set(value_json,'$.passes',json(?)),row_revision=row_revision+1 WHERE collection='role_memory_curation' AND row_key=?")
        .run(JSON.stringify([...retained, live.id]), `p:${PROJECT}`);
    } finally { peer.close(); }
    const get = spyOn(memory, "get"), range = spyOn(memory, "keyRange");
    const prototype = SqliteStateCollection.prototype as unknown as { decodeRow(json: string, db?: Database): unknown };
    const decode = prototype.decodeRow;
    let scopeDecodes = 0;
    const decoding = spyOn(prototype, "decodeRow").mockImplementation(function (this: typeof prototype, json, db) {
      if (JSON.parse(json)?.kind === "scope") scopeDecodes++;
      return decode.call(this, json, db);
    });
    try {
      expect(readPassAuthority(live.id)?.state).toBe("running");
      expect(currentPassAuthority(PROJECT)?.id).toBe(live.id);
      expect(machinePassAuthority()?.id).toBe(live.id);
      expect(passForConversationAuthority("conversation_authority")?.id).toBe(live.id);
      patchPass(live.id, { transcriptPath: "fixture-path" });
      expect(get).not.toHaveBeenCalled(); expect(range).not.toHaveBeenCalled();
      expect(scopeDecodes).toBe(0);
    } finally { get.mockRestore(); range.mockRestore(); decoding.mockRestore(); }
    expect(readPass(live.id)?.counts.calls).toBe(count);
    const cold = readPass(live.id)!;
    cold.counts.calls = -1;
    const scopes = spyOn(memory, "keyRange");
    try { expect(readPass(live.id)?.counts.calls).toBe(count); expect(scopes).not.toHaveBeenCalled(); }
    finally { scopes.mockRestore(); }
  }
  const child = Bun.spawn([process.execPath, "--eval", `import { readPass, readPassAuthority, machinePassAuthority } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; console.log(JSON.stringify({ state: readPassAuthority(${JSON.stringify(live.id)})?.state, id: machinePassAuthority()?.id, calls: readPass(${JSON.stringify(live.id)})?.counts.calls }));`], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toEqual({ state: "running", id: live.id, calls: 100 });
  patchPass(live.id, { state: "succeeded", endedAt: at(1000) });
  expect(readPassAuthority(live.id)?.state).toBe("succeeded");
  expect(machinePassAuthority()).toBeNull();
});
test("a curator archive, its undo and a split keep each rule's departure log for the weekly report", async () => {
  const { windowDepartures } = await import("../weeklyMetrics");
  const scope = roleScope(PROJECT, "builder");
  const kept = fixture(scope, { rule: `${text} Kept condition.` }), archived = fixture(scope, { rule: `${text} Archived condition.` }), split = fixture(scope, { rule: `${text} Split condition.`, departures: [{ at: at(-5000), reason: "stale", curated: true }] });
  const p = pass();
  const result = applyCuration(p, input({ [scope]: [kept, split, `split:${split}:1`] }, {
    archive: [{ id: archived, reason: "stale", note: "The named command was removed." }],
    split: [{ id: split, note: "Each part has its own condition.", parts: [{ to: scope, rule: `${text} First part.` }, { to: scope, rule: `${text} Second part.` }] }],
  }), at(100));
  expect(row(archived).departures).toEqual([{ at: at(100), reason: "stale", curated: true }]);
  expect(row(result.placeholders[`split:${split}:1`]).departures).toBeUndefined();
  const week = { from: at(0), to: at(1000) };
  const read = () => windowDepartures(roleMemoryCollection()!.snapshot() as never, week);
  expect(read()).toEqual({ evictions: { neverCurated: 0, curated: 0 }, adoptedArchived: 0, complete: true });
  // Undoing the pass after the week brings the rule back; the week's departure stays.
  ended(p); revertCuratorPass(p.id, at(2000));
  expect(row(archived).state).toBe("active");
  expect(row(archived).departures).toEqual([{ at: at(100), reason: "stale", curated: true }]);
  expect(read()).toEqual({ evictions: { neverCurated: 0, curated: 0 }, adoptedArchived: 0, complete: true });
  expect(windowDepartures(roleMemoryCollection()!.snapshot() as never, { from: at(1500), to: at(3000) }).complete).toBe(true);
});

test("an over-bound append requests a pass immediately and respects the machine claim", () => {
  const scope = roleScope(PROJECT, "builder");
  for (let i = 0; i < 32; i++) fixture(scope, { rule: `Preserve guidance category ${i}: ${"check durable evidence ".repeat(20)}`.slice(0, 300), curatedAt: at() });
  const initial = pass();
  ended(initial);
  const source: RuleSource = { project: PROJECT, pipelineId: "overflow", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_overflow" };
  recordLessonRequest({ ...source, at: at(2000) });
  const result = leaveLessons({ source, request: source, lessons: [{ scope: "role", rule: "Keep every condition when integrating a new operational lesson into existing guidance.", why }], none: null, now: at(2000) });
  expect(result.left[0].archived).toEqual([]);
  expect(projectView(PROJECT).scopes.find(s => s.scope === scope)!.active).toHaveLength(33);
  expect(curationStatus(PROJECT, NOW + 2000)).toMatchObject({ due: true, pressure: true, trigger: "pressure" });
  const next = pass(NOW + 2000);
  expect(next).not.toBeNull();
  expect(pass(NOW + 3000)).toBeNull();
});

test("a pass restores a budget archive by integrating all its conditions", () => {
  const scope = roleScope(PROJECT, "builder");
  const active = fixture(scope, { rule: "Check ownership before writing shared state." });
  const archived = fixture(scope, { rule: "Check the revision before writing shared state.", state: "archived", reason: "budget" });
  const p = pass();
  const integrated = "Check ownership and the revision before writing shared state.";
  applyCuration(p, input({ [scope]: [active] }, { restore: [archived], merge: [{ into: active, from: [archived], rule: integrated, note: "Both preconditions govern shared writes." }] }), at(100));
  expect(row(active).rule).toBe(integrated);
  expect(row(archived)).toMatchObject({ state: "merged", mergedInto: active });
  expect(readPass(p.id)!.counts).toMatchObject({ restored: 1, merged: 1 });
});

for (const count of [38, 39]) test.each(["missing", "retired", "unwoken", "gone", "unproven", "live"] as const)(`retention checks host admission with ${count} existing rules: %s`, kind => {
  const scope = roleScope(PROJECT, "builder");
  const ids = Array.from({ length: count }, (_, i) => fixture(scope, {
    id: `r_host_${String(i).padStart(3, "0")}`, createdAt: at(i), curatedAt: at(),
    rule: `Preserve condition category ${i}: ${"check durable evidence ".repeat(20)}`.slice(0, 300),
    ...(i === 0 ? { keptByOperatorAt: at(), createdAt: at(-3000) } : {}),
  }));
  expect(scopeChars(ids.map(row))).toBeLessThan(ROLE_MEMORY_BOUND * 1.25);
  const f = hostingFixture();
  f.seat();
  const registry = f.sources.registry();
  const identity = captureProcessIdentity(process.pid);
  const entry = {
    key: { engine: "codex", sessionId: "retention-seat" }, artifactPath: path.join(dir, "seat.jsonl"),
    cwd: dir, status: "idle", host: null, claimOwner: null, claimEpoch: 1, updatedAt: at(),
    structuredHost: { kind: "codex-app-server", process: kind === "unproven" ? null : {
      pid: process.pid, startIdentity: kind === "gone" ? "retired-process-identity" : identity.startIdentity,
    }, writerClaimEpoch: 1 },
  } as AgentRegistryEntry;
  registry.livenessConversationSnapshot = () => ({ entries: { seat: entry } }) as unknown as RegistryFile;
  if (kind === "missing") f.seats.clear();
  if (kind === "retired") registry.conversation = () => ({ supersededBy: { conversationId: "conversation_successor" } }) as never;
  if (kind === "unwoken") writeSeatTickState(PROJECT, { ...emptySeatTickState(), seatEpoch: 1 });
  const sources = spyOn(admissionSources, "defaultSeatTickAdmissionSources").mockReturnValue(f.sources);
  try {
    const source: RuleSource = { project: PROJECT, pipelineId: "host-retention", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_host_retention" };
    recordLessonRequest({ ...source, at: at(2000) });
    const incoming = leaveLessons({ source, request: source, lessons: [{ scope: "role", rule: `Preserve new conditions: ${"check complete obligations ".repeat(20)}`.slice(0, 300), why }], none: null, now: at(2000) }).left[0];
    const emergency = count === 39 && kind !== "live";
    expect(incoming.archived).toEqual(emergency ? [ids[1]] : []);
    expect(row(ids[0]).state).toBe("active");
    expect(row(incoming.id).state).toBe("active");
    expect(row(ids[1]).state).toBe(emergency ? "archived" : "active");
    if (emergency) expect(incoming.scopeChars).toBeLessThanOrEqual(ROLE_MEMORY_BOUND * 1.25);
    if (count === 39 && kind === "live") expect(incoming.scopeChars).toBeGreaterThan(ROLE_MEMORY_BOUND * 1.25);
  } finally { sources.mockRestore(); }
});

test("a busy curator permits emergency eviction by evidence while keeping the returned and incoming rules", () => {
  const scope = roleScope(PROJECT, "builder");
  const ids = Array.from({ length: 39 }, (_, i) => fixture(scope, {
    id: `r_emergency_${String(i).padStart(2, "0")}`, createdAt: at(i),
    rule: `Preserve condition category ${i}: ${"check durable evidence ".repeat(20)}`.slice(0, 300),
    curatedAt: i === 1 ? undefined : at(),
    ...(i === 0 ? { keptByOperatorAt: at(), createdAt: at(-3000) } : {}),
  }));
  const source: RuleSource = { project: PROJECT, pipelineId: "evidence", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_evidence" };
  recordLessonRequest({ ...source, at: at() });
  roleMemoryCollection()!.boundedPatch(128, tx => {
    const request = tx.get("q:evidence:build:1");
    if (request?.kind !== "request") throw Error("request missing");
    tx.put({ ...request, ruleIds: ids.filter((_, index) => index !== 1) });
  });
  pass();
  const incomingSource = { ...source, pipelineId: "emergency" };
  recordLessonRequest({ ...incomingSource, at: at(2000) });
  const incoming = leaveLessons({ source: incomingSource, request: incomingSource, lessons: [{ scope: "role", rule: "Preserve new conditions until the curator can integrate them with existing guidance.", why }], none: null, now: at(2000) }).left[0];
  expect(incoming.archived).toEqual([ids[1]]);
  expect(row(ids[0]).state).toBe("active");
  expect(row(incoming.id).state).toBe("active");
  expect(row(ids[1])).toMatchObject({ state: "archived", reason: "budget" });
  expect(row(ids[2]).state).toBe("active");
});

test.each(["unapplied", "applied"])("emergency retention credits application marks reported with the new lesson: %s", async usage => {
  const applied = usage === "applied";
  const scope = roleScope(PROJECT, "builder");
  const ids = Array.from({ length: 39 }, (_, i) => fixture(scope, {
    id: `r_${i.toString(16).padStart(16, "0")}`, createdAt: at(i),
    rule: `Preserve condition category ${i}: ${"check durable evidence ".repeat(20)}`.slice(0, 300),
  }));
  const source: RuleSource = { project: PROJECT, pipelineId: "application-evidence", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_application" };
  recordLessonRequest({ ...source, at: at() });
  roleMemoryCollection()!.boundedPatch(2, tx => {
    const request = tx.get("q:application-evidence:build:1");
    if (request?.kind !== "request") throw Error("request missing");
    tx.put({ ...request, ruleIds: ids });
  });
  pass();
  const incomingSource = { ...source, pipelineId: "application-append" };
  recordLessonRequest({ ...incomingSource, at: at(2000) });
  await recordMemoryDelivery({ engine: "codex", conversationId: incomingSource.conversationId, attempt: incomingSource, cwd: dir, nativeMemoryEnabled: false }, false,
    () => learnedRulesSnapshot(PROJECT, "builder"));
  const incoming = leaveLessons({ source: incomingSource, request: incomingSource, lessons: [{ scope: "role", rule: "Preserve new conditions until the curator can integrate them with existing guidance.", why }], none: null, applied: applied ? [ids[0]] : [], now: at(2000) }).left[0];
  expect(incoming.archived).toEqual([ids[applied ? 1 : 0]]);
  expect(row(ids[applied ? 0 : 1]).state).toBe("active");
  expect(row(ids[applied ? 1 : 0])).toMatchObject({ state: "archived", reason: "budget" });
});

test("the one-time sweep includes old archives across projects and keeps per-scope receipts across restart", async () => {
  const scope = roleScope(PROJECT, "builder"), foreign = roleScope("recovery-other", "builder");
  const active = fixture(scope, { id: "r_recovery_active", rule: "Check ownership before writing shared state." });
  const budget = fixture(scope, { id: "r_recovery_budget", rule: "Check the revision before writing shared state.", state: "archived", reason: "budget", changedAt: at(-1000) });
  const unexplained = fixture(foreign, { id: "r_recovery_unexplained", state: "archived", changedAt: at(-1000) });
  fixture(foreign, { id: "r_recovery_deleted", state: "archived", reason: "deleted" });
  fixture(foreign, { id: "r_recovery_version", state: "archived", reason: "budget", versionOf: unexplained });
  fixture(foreign, { id: "r_recovery_stale", state: "archived", reason: "stale" });
  const p = pass();
  expect(p.budgetSweepCandidates).toEqual({ [scope]: [budget], [foreign]: [unexplained] });
  const inventory = await readCuration(p);
  expect(inventory.budgetSweep).toEqual([{ scope, candidates: 1 }, { scope: foreign, candidates: 1 }]);
  expect(inventory.scopes.find(row => row.scope === foreign)).toMatchObject({ revision: 4, left: 3 });
  const page = await readCuration(p, foreign);
  if (!("rules" in page)) throw Error("scope page expected");
  expect(page.rules.some(row => row.id === unexplained && row.kind === "left")).toBe(true);
  const child = Bun.spawn([process.execPath, "--eval", `import { readPassAuthority } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; console.log(JSON.stringify(readPassAuthority(${JSON.stringify(p.id)})?.budgetSweepCandidates));`], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(output)).toEqual(p.budgetSweepCandidates);
  applyCuration(p, input({ [scope]: [active] }, { restore: [budget], merge: [{ into: active, from: [budget], rule: "Check ownership and the revision before writing shared state.", note: "Integrate both shared-write preconditions." }] }), at(100));
  applyCuration(p, input({ [foreign]: [unexplained] }, { restore: [unexplained] }), at(200));
  ended(p);
  const expected = [{ scope, candidates: 1, restored: 0, integrated: 1, remaining: 0 }, { scope: foreign, candidates: 1, restored: 1, integrated: 0, remaining: 0 }];
  expect(readPass(p.id)?.budgetSweep).toEqual(expected);
  deleteRule(unexplained, at(2000));
  expect(readPass(p.id)?.budgetSweep).toEqual(expected);
  const restarted = Bun.spawn([process.execPath, "--eval", `import { claimPass, readPass } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; const next = claimPass({ project: ${JSON.stringify(PROJECT)}, repoDir: null, now: ${NOW + CURATION_INTERVAL_MS + 3000} }); console.log(JSON.stringify({ sweep: next?.budgetSweepCandidates ?? null, prior: readPass(${JSON.stringify(p.id)})?.budgetSweep }));`], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [nextOutput, nextError, nextExit] = await Promise.all([new Response(restarted.stdout).text(), new Response(restarted.stderr).text(), restarted.exited]);
  expect({ exit: nextExit, error: nextError }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(nextOutput)).toEqual({ sweep: null, prior: expected });
});

test("an archive-only machine requests recovery and an incomplete pass retries without losing candidates", async () => {
  const scope = roleScope("recovery-only", "builder");
  const archived = fixture(scope, { id: "r_recovery_only", state: "archived", reason: "budget" });
  expect(curationStatus(PROJECT, NOW)).toMatchObject({ active: true, due: true });
  const first = pass();
  ended(first, CURATION_INTERVAL_MS + 1000);
  expect(readPassAuthority(first.id)).toMatchObject({ state: "failed", failure: "budget-sweep-incomplete: 1 scopes" });
  const child = Bun.spawn([process.execPath, "--eval", `import { claimPass } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; console.log(JSON.stringify(claimPass({ project: ${JSON.stringify(PROJECT)}, repoDir: null, now: ${NOW + CURATION_INTERVAL_MS + 2000} })));`], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(output)).toBeNull();
  const next = pass(NOW + 2 * CURATION_INTERVAL_MS + 2000);
  expect(next.budgetSweepCandidates).toEqual({ [scope]: [archived] });
  applyCuration(next, input({ [scope]: [] }, { restore: [archived], archive: [{ id: archived, reason: "stale", note: "The current implementation has removed the behavior behind this condition." }] }), at(2 * CURATION_INTERVAL_MS + 2100));
  ended(next, 2 * CURATION_INTERVAL_MS + 2200);
  expect(readPass(next.id)).toMatchObject({ state: "succeeded", budgetSweep: [{ scope, candidates: 1, restored: 0, integrated: 0, remaining: 1 }] });
  expect(pass(NOW + 3 * CURATION_INTERVAL_MS + 3000)).toBeNull();
});

test("curator budget archives require remaining pressure and keep a stated reason", () => {
  const scope = roleScope(PROJECT, "builder");
  const ids = Array.from({ length: 31 }, (_, i) => fixture(scope, { id: `r_budget_${String(i).padStart(2, "0")}`, rule: `Preserve guidance class ${i}: ${"check complete conditions ".repeat(15)}`.slice(0, 300) }));
  const last = fixture(scope, { id: "r_budget_last", rule: `Preserve final guidance: ${"check complete conditions ".repeat(15)}`.slice(0, 300) });
  const p = pass();
  const edit = { archive: [{ id: last, reason: "budget" as const, note: "After integrating related guidance, this condition still exceeds the scope budget and has the least task support." }] };
  applyCuration(p, input({ [scope]: ids }, edit), at(100));
  expect(row(last)).toMatchObject({ state: "archived", reason: "budget", note: edit.archive[0].note });
  restoreRule(last, at(200));
  refusal(p, input({ [scope]: [] }, { archive: ids.concat(last).map(id => ({ id, reason: "budget", note: "Remove all guidance for room." })) }), "CURATE_KEPT");
});

test("a curator cannot budget-archive guidance that fits after integration", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  refusal(p, input({ [scope]: [] }, { archive: [{ id: one, reason: "budget", note: "Attempt to remove useful guidance despite available room." }] }), "CURATE_BUDGET");
  expect(row(one).state).toBe("active");
});

test("emergency succession ranks duplicate guidance by the tasks being combined in that write", () => {
  const scope = roleScope(PROJECT, "builder"), oldProject = "succession-before";
  const ids = Array.from({ length: 40 }, (_, i) => fixture(scope, { id: `r_succession_${String(i).padStart(2, "0")}`, createdAt: at(-1000 + i), changedAt: at(i), rule: `Preserve guidance class ${i}: ${"check complete conditions ".repeat(15)}`.slice(0, 300) }));
  const duplicate = fixture(roleScope(oldProject, "builder"), { id: "r_succession_duplicate", rule: row(ids[0]).rule });
  for (const [pipelineId, project, ruleIds] of [["support-current", PROJECT, ids], ["support-old", oldProject, [duplicate]]] as const) {
    const source: RuleSource = { project, pipelineId, stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_succession" };
    recordLessonRequest({ ...source, at: at() });
    roleMemoryCollection()!.boundedPatch(2, tx => {
      const request = tx.get(`q:${pipelineId}:build:1`);
      if (request?.kind !== "request") throw Error("request missing");
      tx.put({ ...request, ruleIds: [...ruleIds] });
    });
  }
  pass();
  persistProjectAliases([{ source: oldProject, target: PROJECT, displayName: "Succession evidence" }]);
  joinMovedScopes(at(100));
  expect(row(duplicate)).toMatchObject({ state: "merged", mergedInto: ids[0] });
  expect(row(ids[0]).state).toBe("active");
  expect(row(ids[1])).toMatchObject({ state: "archived", reason: "budget" });
  const view = projectView(PROJECT).scopes.find(row => row.scope === scope)!;
  expect(view.active.find(row => row.id === ids[0])?.tasks).toBe(2);
});
