import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { defaultSeatTickSources } from "@/lib/monitor/seatTickSources";
import { input as tickInput } from "@/lib/boardMaintenance/testFixture";
import { roleIsClean } from "../eligibility";
import { ROLE_MEMORY_BOUND, CURATION_INTERVAL_MS, type RoleMemoryRule, type RuleSource } from "../roleTypes";
import { leaveLessons, newRuleId, projectView, recordLessonRequest, learnedRulesBlock, roleMemoryCollection, roleScope, projectScope, restoreRule, deleteRule, storedLessonTexts } from "../roleStore";
import { applyCuration, revertCuratorPass, type CurationApply } from "./apply";
import { claimPass, curationStatus, machinePass, patchPass, readPass, type CuratorPass } from "./store";
import { curatorCallerOf } from "./guard";
import { readCuration } from "./read";
import { productionCurationController } from "./run";
import { permitCuratorTool } from "@/lib/mcp/toolAllowlist";
import { CURATOR_CHECKLIST } from "./brief";
import { runSeatTickCheck } from "@/lib/monitor/seatTickController";
import { emptySeatTickState } from "@/lib/monitor/types";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import type { RoleMemoryRow } from "../roleTypes";

const PROJECT = "curation-fixture";
const NOW = Date.parse("2026-10-11T00:00:00Z");
const at = (delta = 0) => new Date(NOW + delta).toISOString();
const why = "An earlier attempt applied guidance at the wrong level.";
const text = "Inspect the requested scope before changing stored guidance.";
let dir: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curation-check-"));
  process.env.LLV_STATE_DIR = dir;
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Run the repository checks before publication.\n");
});
afterEach(() => { process.env.LLV_STATE_DIR = previous; if (previous === undefined) delete process.env.LLV_STATE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });
function row(id: string): RoleMemoryRule {
  const held = roleMemoryCollection()!.get(`r:${id}`);
  if (held?.kind !== "rule") throw Error("rule missing");
  return held;
}
function fixture(scope = roleScope(PROJECT, "builder"), extra: Partial<RoleMemoryRule> = {}) {
  const source: RuleSource = { project: PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: ["conversation", "fixture"].join("_") };
  return roleMemoryCollection(true)!.boundedPatch(20, tx => {
    const id = newRuleId(tx);
    tx.put({ kind: "rule", id, scope, rule: text, why, state: "active", hints: [], source, createdAt: at(), changedAt: at(), ...extra });
    const held = tx.get(`s:${scope}`);
    tx.put({ kind: "scope", scope, revision: held?.kind === "scope" ? held.revision + 1 : 1, history: held?.kind === "scope" ? held.history : [], active: [...(held?.kind === "scope" ? held.active : []), ...(extra.state && extra.state !== "active" ? [] : [id])] });
    return id;
  });
}
function pass(now = NOW) { return claimPass({ project: PROJECT, repoDir: dir, now })!; }
function input(scopes: Record<string, string[]>, edits: Partial<CurationApply> = {}): CurationApply {
  return { scopes: Object.entries(scopes).map(([scope, order]) => {
    const held = roleMemoryCollection()?.get(`s:${scope}`);
    return { scope, revision: held?.kind === "scope" ? held.revision : 0, order };
  }), ...edits };
}
function ended(p: CuratorPass, delta = 1000) { patchPass(p.id, { state: "succeeded", endedAt: at(delta) }); }
function refusal(p: CuratorPass, edit: CurationApply, code: string) {
  const before = JSON.stringify(roleMemoryCollection()!.snapshot());
  try { applyCuration(p, edit, at(100)); throw Error("accepted invalid apply"); }
  catch (error) { expect((error as { code?: string }).code).toBe(code); }
  expect(JSON.stringify(roleMemoryCollection()!.snapshot())).toBe(before);
}

test("first pass, timed quiet pass, early ten lessons and failed-pass cooldown", () => {
  expect(curationStatus(PROJECT, NOW).due).toBe(false);
  fixture(); const p = pass(); expect(p).not.toBeNull(); expect(pass()).toBeNull();
  ended(p);
  expect(curationStatus(PROJECT, NOW + 1000 + CURATION_INTERVAL_MS - 1).due).toBe(false);
  expect(curationStatus(PROJECT, NOW + 1000 + CURATION_INTERVAL_MS).due).toBe(true);
  for (let n = 0; n < 10; n++) {
    const source: RuleSource = { project: PROJECT, pipelineId: "early", stageId: "build", attempt: n, roleId: "builder", fixRound: false, conversationId: ["conversation", "early"].join("_") };
    recordLessonRequest({ ...source, at: at(2000 + n) });
    leaveLessons({ request: source, source, lessons: [{ scope: "role", rule: `Inspect scope guidance before changing stored item ${n}.`, why }], none: null, now: at(2000 + n) });
    expect(curationStatus(PROJECT, NOW + 3000).due).toBe(n === 9);
  }
  expect(pass(NOW + 3000)).toBeNull();
  const early = pass(NOW + 31 * 60_000); expect(early).not.toBeNull();
  patchPass(early.id, { state: "failed", endedAt: at(32 * 60_000), failure: "no-account" });
  expect(curationStatus(PROJECT, NOW + 33 * 60_000).due).toBe(false);
  expect(curationStatus(PROJECT, NOW + 32 * 60_000 + CURATION_INTERVAL_MS).due).toBe(true);
});
test("claims serialize projects sharing a machine, with no live rules there is no pass", () => {
  fixture(); const first = pass();
  fixture(roleScope("other", "builder"));
  expect(claimPass({ project: "other", repoDir: dir, now: NOW })).toBeNull();
  expect(machinePass()?.id).toBe(first.id);
  ended(first);
  expect(claimPass({ project: "other", repoDir: dir, now: NOW })).not.toBeNull();
});
test("scope rereads retain departures from every call of the current pass", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), two = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [two] }, { archive: [{ id: one, reason: "stale", note: "The first old command was replaced." }] }), at(100));
  applyCuration(p, input({ [scope]: [] }, { archive: [{ id: two, reason: "task-specific", note: "The second row records one completed task." }] }), at(200));
  const page = readCuration(p, scope);
  expect("rules" in page && page.rules.map(r => r.id).sort()).toEqual([one, two].sort());
});
test("read pages are revision bound and include scaffold, budget archives and prior text", () => {
  const scope = roleScope(PROJECT, "builder");
  for (let n = 0; n < 80; n++) fixture(scope, { rule: `${text} ${"Read the stored record. ".repeat(8)} ${n}` });
  const archive = fixture(scope, { state: "archived", reason: "budget" });
  const p = pass(); const first = readCuration(p, scope);
  if (!("cursor" in first)) throw Error("expected a scope page");
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(24_000);
  expect(first).toHaveProperty("scaffold"); expect(first.cursor).toBeTruthy();
  let cursor = first.cursor; const ids = first.rules.map(r => r.id);
  while (cursor) { const next = readCuration(p, scope, cursor); if (!("rules" in next)) throw Error("expected a scope page"); ids.push(...next.rules.map(r => r.id)); cursor = next.cursor; }
  expect(ids).toContain(archive); expect(new Set(ids).size).toBe(ids.length);
  fixture(scope);
  expect(() => readCuration(p, scope, first.cursor!)).toThrow(/changed/);
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
  for (const to of [roleScope(PROJECT, "reviewer"), "role:*:curator", roleScope(PROJECT, "orchestrator"), roleScope(PROJECT, "maintainer"), roleScope("other", "builder")]) {
    refusal(p, input({ [scope]: [], [to]: [one] }, { move: [{ id: one, to }] }), to.includes("other") ? "CURATE_SCOPE" : "CURATE_NO_READER");
    refusal(p, input({ [scope]: [one], [to]: [`split:${one}:1`] }, { split: [{ id: one, note: "Separate the readers at their levels.", parts: [{ to: scope, rule: text }, { to, rule: text }] }] }), to.includes("other") ? "CURATE_SCOPE" : "CURATE_NO_READER");
  }
  refusal(p, input({ [scope]: [], machine: [one] }, { move: [{ id: one, to: "machine" }] }), "CURATE_INVALID");
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
test("the v1 row kinds and optional metadata survive an apply, and clean curator has no injected rules", () => {
  const scope = roleScope(PROJECT, "builder"), one = fixture(scope), p = pass();
  applyCuration(p, input({ [scope]: [], "role:*:builder": [one] }, { move: [{ id: one, to: "role:*:builder" }], rewrite: [{ id: one, rule: text + " Read its revision.", note: "The revision identifies the current record." }] }), at(100));
  const legacy = new SqliteStateCollection<RoleMemoryRow>(path.join(dir, "state.sqlite"), {
    collection: "role_memory", schemaVersion: 1, busyMessage: "fixture busy", clone: structuredClone,
    key: r => r.kind === "rule" ? `r:${r.id}` : r.kind === "scope" ? `s:${r.scope}` : `q:${r.pipelineId}:${r.stageId}:${r.attempt}`,
    decode: value => { const r = value as RoleMemoryRow; return ["rule", "scope", "request"].includes(r.kind) ? r : null; }, strictDecode: true,
  });
  const rows = legacy.snapshot();
  expect(rows.some(r => r.kind === "rule" && r.versionOf === one)).toBe(true);
  expect(rows.some(r => r.kind === "scope" && r.scope === "role:*:builder" && r.active.includes(one))).toBe(true);
  expect(roleIsClean("curator")).toBe(true);
  for (const outcome of ["task-specific", "stale", "in-code", "in-instructions", "no-reader", "contradicted"]) expect(CURATOR_CHECKLIST).toContain(outcome);
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
  snapshot.conversations[id] = { id, agentRole: "curator", generations: [], continuityPaths: [] } as never;
  snapshot.receipts.fixture = { conversationId: id, agentRole: "curator", clientAttemptId: p.id, state: "completed", launchId: "fixture", artifactPath: null } as never;
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
test("stubbed launch, restart reconcile and settle keep no board card", async () => {
  fixture(); let now = NOW, endedTurn = false; const bodies: Record<string, unknown>[] = [], archived: string[] = [];
  const registry = new AgentRegistry(path.join(dir, "registry.json"));
  const sources = { ...defaultSeatTickSources(), now: () => now, registry: () => registry, pipelines: () => [{ project: PROJECT, repoDir: dir } as never], latestDeployment: () => ({ state: "ok" as const, value: null }) };
  const controller = productionCurationController(sources, { launch: async body => { bodies.push(body); return { status: 202, body: { state: "running", conversationId: "fixture-curator", launchId: "fixture" } }; }, observe: async () => ({ state: endedTurn ? "ended" : "running", finalText: "Checked scopes; retained current rules." }), archive: p => { archived.push(p.id); } });
  const tick = { ...tickInput(), project: PROJECT };
  await controller.launchIfDue({ ...tick, settings: { ...tick.settings, enabled: false } }); expect(bodies).toHaveLength(0);
  sources.latestDeployment = () => ({ state: "ok", value: { terminal: false } as never });
  expect(await controller.launchIfDue(tick)).toContain("deployment"); expect(machinePass()).toBeNull();
  sources.latestDeployment = () => ({ state: "ok", value: null });
  expect(await controller.launchIfDue(tick)).toContain("launched"); await controller.launchIfDue(tick); expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ role: "curator", cwd: dir, mcpServers: ["viewer"] }); expect(bodies[0]).not.toHaveProperty("taskId");
  now += 1000; endedTurn = true; expect(await controller.reconcile(PROJECT)).toContain("settled"); expect(archived).toHaveLength(1); expect(machinePass()).toBeNull();
  expect(projectView(PROJECT).curation?.passes[0].state).toBe("succeeded");
});
