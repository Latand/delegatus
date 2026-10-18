import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { effectiveCurationSetting, readSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { projectView, projectViewAsync, roleMemoryCollection } from "./roleStore";
import { otherProjectRoleRules, roleViewVersion } from "./roleViewSource";
import { claimPass, curationStatus, curationView, patchPass, readPass } from "./curation/store";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { readCuration } from "./curation/read";
import { performanceSites, performanceSpans } from "@/lib/performanceSpans";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import type { RoleMemoryRow, RoleMemoryRule, RoleMemoryScopeRow } from "./roleTypes";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const AT = new Date(NOW).toISOString();
const PROJECT = "view-fixture";
const SCOPE = `role:${PROJECT}:builder`;
let directory: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "role-view-"));
  process.env.LLV_STATE_DIR = directory;
  resetProjectAliasesForTests();
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  resetProjectAliasesForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});
function rule(id = "r_0000000000000001", scope = SCOPE, extra: Partial<RoleMemoryRule> = {}): RoleMemoryRule {
  return { kind: "rule", id, scope, rule: "Read the current revision before editing stored guidance.", why: "A stale revision loses a concurrent edit.", state: "active", hints: [],
    source: { project: PROJECT, pipelineId: "view-task", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "view-conversation" },
    createdAt: AT, changedAt: AT, ...extra };
}
function seed(rows: RoleMemoryRow[] = [rule()]) {
  const memory = roleMemoryCollection(true)!;
  memory.boundedPatch(rows.length * 2 + 4, tx => {
    const byScope = new Map<string, RoleMemoryRule[]>();
    for (const row of rows) {
      tx.put(row);
      if (row.kind === "rule") { const list = byScope.get(row.scope) ?? []; list.push(row); byScope.set(row.scope, list); }
    }
    for (const [scope, rules] of byScope) tx.put({ kind: "scope", scope, revision: 1, active: rules.filter(r => r.state === "active" && !r.versionOf).map(r => r.id), history: [] });
  });
  return memory;
}
function scope(): RoleMemoryScopeRow {
  const row = roleMemoryCollection()!.get(`s:${SCOPE}`);
  if (row?.kind !== "scope") throw Error("missing fixture scope");
  return row;
}
function measuredView() {
  const memory = roleMemoryCollection()!;
  const get = memory.get.bind(memory), range = memory.keyRange.bind(memory);
  let decoded = 0;
  const a = spyOn(memory, "get").mockImplementation(key => { const row = get(key); if (row) decoded++; return row; });
  const b = spyOn(memory, "keyRange").mockImplementation((...args) => { const rows = range(...args); decoded += rows.length; return rows; });
  const snapshot = spyOn(memory, "snapshot");
  try { const value = projectView(PROJECT, NOW); expect(snapshot).not.toHaveBeenCalled(); return { decoded, value }; }
  finally { a.mockRestore(); b.mockRestore(); snapshot.mockRestore(); }
}

test("one scope-history walk derives the same pass counts as individual reads, including duplicate receipts", async () => {
  const memory = seed([rule(), rule("r_0000000000000002", `project:${PROJECT}`)]);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const p = claimPass({ project: PROJECT, repoDir: null, now: NOW + i * 86_400_000 })!;
    ids.push(p.id); patchPass(p.id, { state: "succeeded", endedAt: AT });
  }
  const counts = { calls: 1, changed: 2, rewritten: 1, merged: 0, moved: 1, split: 0, archived: 0, restored: 0 };
  memory.boundedPatch(4, tx => {
    for (const name of [SCOPE, `project:${PROJECT}`]) {
      const row = tx.get(`s:${name}`) as RoleMemoryScopeRow;
      tx.put({ ...row, history: ids.flatMap((pass, index) => [
        { revision: index + 1, at: AT, by: "curator" as const, pass, counts: name === SCOPE ? counts : { ...counts, calls: 9 }, added: [], merged: [], archived: [] },
        { revision: index + 2, at: new Date(NOW + 1).toISOString(), by: "curator" as const, pass, counts: name === SCOPE ? counts : { ...counts, calls: 9 }, added: [], merged: [], archived: [], revertedAt: AT },
      ]) });
    }
  });
  const view = curationView(PROJECT, NOW);
  expect(view.passes.map(p => p.id)).toEqual(ids.toReversed());
  for (const pass of view.passes) expect(pass.counts).toEqual(readPass(pass.id)!.counts);
  expect(view.passes[0].counts).toEqual({ ...counts, calls: 2, changed: 4, rewritten: 2, moved: 2 });
  expect(projectView(PROJECT, NOW).curation?.passes.map(pass => pass.counts)).toEqual(view.passes.map(pass => pass.counts));
  (globalThis as typeof globalThis & { __llvProjectViews?: Map<string, unknown> }).__llvProjectViews?.clear();
  expect((await projectViewAsync(PROJECT, NOW)).curation?.passes.map(pass => pass.counts)).toEqual(view.passes.map(pass => pass.counts));
});

test("project view decoding is flat across tenfold retained passes and unrelated rules", () => {
  const memory = seed();
  const addPasses = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      const pass = claimPass({ project: PROJECT, repoDir: null, now: NOW + i * 86_400_000 })!;
      patchPass(pass.id, { state: "succeeded", endedAt: AT });
    }
    // Invalidate the status summary in both samples, independently of pass count.
    memory.boundedPatch(2, tx => { const row = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow; tx.put({ ...row, revision: row.revision + 1 }); });
  };
  addPasses(0, 5);
  const first = measuredView();
  addPasses(5, 50);
  const retained = measuredView();
  expect(retained.value.curation?.passes).toHaveLength(50);
  expect(retained.decoded).toBe(first.decoded);
  for (const count of [10, 100]) {
    memory.boundedPatch(count + 1, tx => { for (let i = 0; i < count; i++) tx.put(rule(`unrelated-${i}`, "role:elsewhere:reviewer")); });
    const changed = measuredView();
    expect(changed.decoded).toBeLessThanOrEqual(first.decoded);
    expect(changed.value).toEqual(retained.value);
  }
});

test("memo hits decode nothing, preserve time fields and refuse mutation of shared nested data", () => {
  seed();
  const first = measuredView();
  expect(first.value.scopes[0].active[0].fresh).toBe(true);
  expect(measuredView().decoded).toBe(0);
  expect(projectView(PROJECT, NOW + 1).curation?.nextAt).toBe(new Date(NOW + 1).toISOString());
  expect(first.value.curation?.nextAt).toBe(AT);
  expect(() => first.value.scopes[0].active.push(first.value.scopes[0].active[0])).toThrow();
  expect(projectView(PROJECT, NOW + 86_400_000).scopes[0].active[0].fresh).toBe(false);
  expect(projectView(PROJECT, NOW - 1).scopes[0].active[0].fresh).toBe(true);
});

test("the production view reader yields while projecting retained scope history", async () => {
  const memory = seed([rule(undefined, SCOPE, { curatedAt: AT })]);
  const largePrior = "previous rule payload ".repeat(500);
  memory.boundedPatch(2, tx => {
    const held = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
    tx.put({ ...held, curatedAt: AT, history: Array.from({ length: 32 }, (_, index) => ({
      revision: index + 1, at: AT, by: "operator" as const, added: [], merged: [], archived: [], before: [largePrior],
    })) });
  });
  const expected = projectView(PROJECT, NOW);
  (globalThis as typeof globalThis & { __llvProjectViews?: Map<string, unknown> }).__llvProjectViews?.clear();
  let yielded = false;
  const priorSpans = Math.max(0, ...performanceSpans.snapshot().records.map(record => record.sequence));
  const nextTurn = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
  const result = await projectViewAsync(PROJECT, NOW);
  await nextTurn;
  expect(yielded).toBe(true);
  expect(result).toEqual(expected);
  expect(performanceSpans.snapshot().records.some(record => record.sequence > priorSpans && performanceSites[record.site] === "memory.project-view" && record.kind === "sync" && !record.failed)).toBe(true);
  expect(result.scopes[0].revision).toBe(1);
  expect(result.scopes[0].active[0].awaitingCuration).toBe(false);
});

test("a refused cooperative refresh cannot publish a curation summary for its stale scope snapshot", async () => {
  const memory = seed();
  memory.boundedPatch(2, tx => {
    const held = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
    tx.put({ ...held, history: Array.from({ length: 32 }, (_, index) => ({
      revision: index + 1, at: AT, by: "operator" as const, added: [], merged: [], archived: [],
    })) });
  });
  const lesson = rule("committed-during-yield");
  const write = new Promise<void>(resolve => setImmediate(() => {
    memory.boundedPatch(3, tx => {
      const held = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
      tx.put(lesson);
      tx.put({ ...held, revision: held.revision + 1, active: [...held.active, lesson.id], history: [...held.history,
        { revision: held.revision + 1, at: new Date(NOW + 1).toISOString(), by: "agent", added: [lesson.id], merged: [], archived: [] }] });
    });
    resolve();
  }));
  const pending = projectViewAsync(PROJECT, NOW + 2);
  await expect(pending).rejects.toBeInstanceOf(StateSnapshotChangedError);
  await write;
  const next = await projectViewAsync(PROJECT, NOW + 2);
  expect(next.scopes.flatMap(item => item.active).map(item => item.id)).toContain(lesson.id);
  expect(next.curation).toMatchObject({ newLessons: 1 });
  const status = curationStatus(PROJECT, NOW + 2);
  expect(status).toMatchObject({ active: true, due: true, newLessons: 1 });
});

test("settings, kill switch and project succession invalidate warmed answers", () => {
  seed(); projectView(PROJECT, NOW);
  writeSeatTickSettings(PROJECT, { ...readSeatTickSettings(PROJECT), curation: { enabled: false, intervalHours: 6, updatedAt: AT,
    setBy: { kind: "unidentified", conversationId: null, project: null, seatEpoch: null } } });
  expect(effectiveCurationSetting(readSeatTickSettings(PROJECT)).enabled).toBe(false);
  expect(projectView(PROJECT, NOW).curation?.nextAt).toBeNull();
  const previous = process.env.LLV_ROLE_MEMORY;
  try { process.env.LLV_ROLE_MEMORY = "off"; expect(projectView(PROJECT, NOW).enabled).toBe(false); }
  finally { if (previous === undefined) delete process.env.LLV_ROLE_MEMORY; else process.env.LLV_ROLE_MEMORY = previous; }
  persistProjectAliases([{ source: PROJECT, target: "view-renamed", displayName: "Renamed fixture" }]);
  const moved = projectView(PROJECT, NOW);
  expect(moved.project).toBe("view-renamed");
  expect(moved.scopes[0].scope).toBe("role:view-renamed:builder");
  expect(moved.scopes[0].active[0].id).toBe(rule().id);
});

test("scope reads select other projects of the same role and reject foreign scopes and stale cursors", async () => {
  seed([rule(), rule("peer", "role:elsewhere:builder"), rule("cross", "role:*:builder"), rule("reviewer", "role:elsewhere:reviewer")]);
  const pass = claimPass({ project: PROJECT, repoDir: null, now: NOW })!;
  expect(otherProjectRoleRules(SCOPE).map(r => r.id)).toEqual(["peer"]);
  expect(otherProjectRoleRules(`role:${PROJECT}:build%`)).toEqual([]);
  const snapshot = spyOn(roleMemoryCollection()!, "snapshot");
  try {
    const overview = await readCuration(pass, undefined, undefined, NOW);
    if (!overview.scopes) throw Error("missing overview");
    expect(overview.scopes.find(s => s.scope === SCOPE)?.active).toBe(1);
    const read = await readCuration(pass, SCOPE, undefined, NOW);
    if (!("rules" in read)) throw Error("missing scope page");
    expect(read.rules.map(r => r.kind)).toEqual(["active", "other-project"]);
    expect(snapshot).not.toHaveBeenCalled();
    await expect(readCuration(pass, "role:foreign:builder", undefined, NOW)).rejects.toMatchObject({ code: "CURATE_SCOPE" });
    await expect(readCuration(pass, SCOPE, Buffer.from(JSON.stringify({ scope: SCOPE, revision: scope().revision - 1, offset: 0 })).toString("base64url"), NOW)).rejects.toMatchObject({ code: "CURATE_STALE" });
  } finally { snapshot.mockRestore(); }
});

async function child(script: string) {
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code) throw Error(`fixture child failed (${code}): ${stderr}`);
  return stdout.trim();
}
test("peer commits invalidate the memo and a restarted real reader derives the same answer", async () => {
  seed(); projectView(PROJECT, NOW);
  await child(`const {roleMemoryCollection}=await import('./src/lib/memory/roleStore');const c=roleMemoryCollection();c.boundedPatch(2,tx=>{const r=tx.get('r:r_0000000000000001');tx.put({...r,rule:'Recheck the persisted revision after another writer commits.'});});`);
  const fresh = projectView(PROJECT, NOW);
  expect(fresh.scopes[0].active[0].rule).toBe("Recheck the persisted revision after another writer commits.");
  const restarted = await child(`const {projectView}=await import('./src/lib/memory/roleStore');console.log(JSON.stringify(projectView('${PROJECT}',${NOW})));`);
  expect(JSON.parse(restarted)).toEqual(fresh);
}, 30_000);

test("the shared memo evicts the oldest project at its entry bound", () => {
  seed(); projectView(PROJECT, NOW);
  for (let i = 0; i < 16; i++) projectView(`empty-${i}`, NOW);
  expect(measuredView().decoded).toBeGreaterThan(0);
  expect(measuredView().decoded).toBe(0);
});

test("the shared memo also evicts by bytes below its entry bound", () => {
  seed([rule(), rule("large-shared", "machine", { rule: "Fixture text. ".repeat(80_000) })]);
  projectView(PROJECT, NOW);
  for (let i = 0; i < 9; i++) projectView(`byte-fixture-${i}`, NOW);
  expect(measuredView().decoded).toBeGreaterThan(0);
  expect(measuredView().decoded).toBe(0);
});

test("a failed refresh never serves or memoizes the previous revision", () => {
  const memory = seed(); projectView(PROJECT, NOW);
  memory.boundedPatch(2, tx => { const row = tx.get(`r:${rule().id}`) as RoleMemoryRule; tx.put({ ...row, rule: "Read the committed row again after a refused refresh." }); });
  const refused = spyOn(memory, "get").mockImplementation(() => { throw Error("fixture read refused"); });
  try { expect(() => projectView(PROJECT, NOW)).toThrow("fixture read refused"); }
  finally { refused.mockRestore(); }
  expect(performanceSpans.snapshot().records.some(record => performanceSites[record.site] === "memory.project-view" && record.failed)).toBe(true);
  expect(projectView(PROJECT, NOW).scopes[0].active[0].rule).toBe("Read the committed row again after a refused refresh.");
});

test("the real view carries its loop operation and synchronous span", () => {
  seed();
  const operations = spyOn(viewerLoopMonitor, "run");
  try {
    projectView(PROJECT, NOW);
    expect(operations.mock.calls.some(([name]) => name === "role-memory.view")).toBe(true);
    expect(performanceSpans.snapshot().records.some(record => performanceSites[record.site] === "memory.project-view" && record.kind === "sync" && !record.failed)).toBe(true);
  } finally { operations.mockRestore(); }
});

test("independently loaded server modules reuse the same immutable memo", async () => {
  seed();
  const first = projectView(PROJECT, NOW);
  const duplicate = await import(new URL("./roleStore.ts?view-bundle", import.meta.url).href) as typeof import("./roleStore");
  expect(duplicate.projectView(PROJECT, NOW).scopes).toBe(first.scopes);
  const source = await import(new URL("./roleViewSource.ts?view-reader", import.meta.url).href) as typeof import("./roleViewSource");
  expect(source.roleViewVersion()).toBe(roleViewVersion());
  await child(`const {roleMemoryCollection}=await import('./src/lib/memory/roleStore');roleMemoryCollection().boundedPatch(2,tx=>{const r=tx.get('r:r_0000000000000001');tx.put({...r,rule:'Recheck guidance after a commit from a separate process.'});});`);
  expect(source.roleViewVersion()).toBe(roleViewVersion());
  expect(duplicate.projectView(PROJECT, NOW).scopes[0].active[0].rule).toBe("Recheck guidance after a commit from a separate process.");
});

test("split task lineage reads a foreign ancestor's scope history after project succession", async () => {
  const oldScope = "role:old-foreign:builder";
  const memory = seed([
    rule(undefined, SCOPE, { splitFrom: "ancestor", splitAt: new Date(NOW + 5).toISOString() }),
    rule("ancestor", oldScope),
    rule("merged-parent", oldScope, { state: "merged", mergedInto: "ancestor", changedAt: new Date(NOW + 10).toISOString() }),
    { kind: "request", pipelineId: "foreign-task", stageId: "build", attempt: 1, project: "old-foreign", roleId: "builder", conversationId: "foreign-lineage", at: new Date(NOW + 2).toISOString(), ruleIds: ["merged-parent"], none: null },
  ]);
  memory.boundedPatch(2, tx => {
    const row = tx.get(`s:${oldScope}`) as RoleMemoryScopeRow;
    tx.put({ ...row, history: [
      { revision: 1, at: new Date(NOW + 1).toISOString(), by: "curator", added: [], merged: [{ from: "merged-parent", into: "ancestor" }], archived: [] },
      { revision: 2, at: new Date(NOW + 3).toISOString(), by: "agent", added: ["foreign-lesson"], merged: [], archived: [] },
    ] });
  });
  persistProjectAliases([{ source: "old-foreign", target: "new-foreign", displayName: "Foreign fixture" }]);
  const view = projectView(PROJECT, NOW + 4);
  expect(view.scopes[0].active[0].tasks).toBe(1);
  expect(view.curation?.newLessons).toBe(0);
  (globalThis as typeof globalThis & { __llvProjectViews?: Map<string, unknown> }).__llvProjectViews?.clear();
  expect((await projectViewAsync(PROJECT, NOW + 4)).curation?.newLessons).toBe(0);
});

test("project-view curation follows canonical curation scope ordering for conflicting receipts", async () => {
  const memory = seed([rule(), rule("project-rule", `project:${PROJECT}`)]);
  const pass = claimPass({ project: PROJECT, repoDir: null, now: NOW })!;
  patchPass(pass.id, { state: "succeeded", endedAt: AT });
  const projectCounts = { ...pass.counts, calls: 9 };
  const roleCounts = { ...pass.counts, calls: 1 };
  memory.boundedPatch(4, tx => {
    const role = tx.get(`s:${SCOPE}`) as RoleMemoryScopeRow;
    const project = tx.get(`s:project:${PROJECT}`) as RoleMemoryScopeRow;
    tx.put({ ...role, history: [
      { revision: 1, at: AT, by: "curator", pass: pass.id, counts: roleCounts, added: [], merged: [], archived: [] },
      { revision: 2, at: new Date(NOW + 1).toISOString(), by: "curator", pass: pass.id, counts: roleCounts, added: [], merged: [], archived: [], revertedAt: AT },
    ] });
    tx.put({ ...project, history: [
      { revision: 1, at: AT, by: "curator", pass: pass.id, counts: projectCounts, added: [], merged: [], archived: [] },
      { revision: 2, at: new Date(NOW + 1).toISOString(), by: "curator", pass: pass.id, counts: projectCounts, added: [], merged: [], archived: [], revertedAt: AT },
    ] });
  });
  const expected = readPass(pass.id)!.counts;
  expect(expected.calls).toBe(2);
  expect(projectView(PROJECT, NOW).curation?.passes[0]?.counts).toEqual(expected);
  (globalThis as typeof globalThis & { __llvProjectViews?: Map<string, unknown> }).__llvProjectViews?.clear();
  expect((await projectViewAsync(PROJECT, NOW)).curation?.passes[0]?.counts).toEqual(expected);
});

test("reopening the shared reader cannot reuse a token from before a peer commit", async () => {
  seed(); projectView(PROJECT, NOW);
  const primary = directory;
  const secondary = fs.mkdtempSync(path.join(os.tmpdir(), "role-view-peer-"));
  try {
    process.env.LLV_STATE_DIR = secondary;
    seed(); projectView(PROJECT, NOW);
    await child(`process.env.LLV_STATE_DIR=${JSON.stringify(primary)};const {roleMemoryCollection}=await import('./src/lib/memory/roleStore');roleMemoryCollection().boundedPatch(2,tx=>{const r=tx.get('r:r_0000000000000001');tx.put({...r,rule:'Reopen the authoritative reader after switching its state root.'});});`);
    process.env.LLV_STATE_DIR = primary;
    expect(projectView(PROJECT, NOW).scopes[0].active[0].rule).toBe("Reopen the authoritative reader after switching its state root.");
  } finally {
    process.env.LLV_STATE_DIR = primary;
    fs.rmSync(secondary, { recursive: true, force: true });
  }
});
