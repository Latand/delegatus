import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { stopWorktreeSweepWorker } from "@/lib/pipelines/worktreeSweepWorker";
import { planRoleMemory } from "@/lib/transfer/roleMemory";
import { PARTS } from "@/lib/transfer/sections";
import { takeSourceSnapshot } from "@/lib/transfer/stores";
import { applyCuration, revertCuratorPass, type CurationApply } from "./curation/apply";
import { claimPass, curationScopes, curationStatus, patchPass } from "./curation/store";
import { drainRoleHistory, drainRoleHistoryStep, ROLE_HISTORY_BACKUP_AGE_MS, RoleHistoryDrainRefusal, roleHistoryRowsEnabled, setRoleHistoryRowsEnabled, unclaimedRoleHistoryTokens } from "./roleHistoryDrain";
import { ROLE_HISTORY_COLLECTION } from "./roleHistoryRows";
import { joinMovedScopes, leaveLessons, projectView, recordLessonRequest, roleMemoryCollection, roleScope } from "./roleStore";
import { activeRoleRuleRows, projectViewRows, projectViewRowsCooperatively, roleScopePassLastAt, roleScopeReadMetadata, scopeRowForRewrite, scopeRowWithHistory } from "./roleViewSource";
import { ROLE_MEMORY_HISTORY_LIMIT, type RoleMemoryRule, type RoleMemoryScopeRow, type RuleSource, type ScopeHistoryEntry } from "./roleTypes";

const PROJECT = "history-rows-fixture";
const NOW = Date.parse("2026-10-11T00:00:00Z");
const at = (delta = 0) => new Date(NOW + delta).toISOString();
const text = "Inspect the requested scope before changing stored guidance.";
const why = "An earlier attempt applied guidance at the wrong level.";
const source: RuleSource = { project: PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" };
let dir: string, previous: string | undefined;
beforeEach(() => {
  resetProjectAliasesForTests();
  previous = process.env.LLV_STATE_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-history-rows-"));
  process.env.LLV_STATE_DIR = dir;
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Run the repository checks before publication.\n");
});
afterEach(async () => {
  await stopWorktreeSweepWorker();
  process.env.LLV_STATE_DIR = previous;
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  resetProjectAliasesForTests();
});

/** Bytes this thread asked the kernel for, the counter the Viewer's loop
 * monitor reports as readBytes. Linux only. */
const linux = process.platform === "linux";
function readBytes<T>(work: () => T): { value: T; bytes: number } {
  const counter = () => Number(/rchar: (\d+)/.exec(fs.readFileSync("/proc/thread-self/io", "utf8"))![1]);
  const before = counter();
  const value = work();
  return { value, bytes: counter() - before };
}

function rule(id: string, scope: string, extra: Partial<RoleMemoryRule> = {}): RoleMemoryRule {
  return { kind: "rule", id, scope, rule: text, why, state: "active", hints: [], source, createdAt: at(), changedAt: at(), ...extra };
}
/** Entries shaped like a long-lived scope's: mostly lessons, and curator
 * calls whose undo payload is about `undoBytes` each. */
function entries(count: number, undoBytes: number, scope: string): ScopeHistoryEntry[] {
  return Array.from({ length: count }, (_, index): ScopeHistoryEntry => index % 4 === 3
    ? { revision: index + 1, at: at(index * 1000), by: "curator", pass: `p_${index % 12}`, counts: { calls: 1, changed: 1, rewritten: 0, merged: 0, moved: 0, split: 0, archived: 0, restored: 0 },
        before: ["r_00000000000000aa"], prior: [{ id: "r_00000000000000aa", version: null, fields: { ...rule("r_00000000000000aa", scope), note: "n".repeat(undoBytes) } as never }], created: [], added: [], merged: [], archived: [] }
    : { revision: index + 1, at: at(index * 1000), by: "agent", added: [`r_${String(index).padStart(16, "0")}`], merged: index % 8 === 1 ? [{ from: "r_00000000000000bb", into: "r_00000000000000aa" }] : [], archived: [] });
}
function seed(scope: string, history: ScopeHistoryEntry[], active = ["r_00000000000000aa"]): RoleMemoryScopeRow {
  const row: RoleMemoryScopeRow = { kind: "scope", scope, revision: history.length, active, history, curatedAt: at() };
  roleMemoryCollection(true)!.patchSync(() => ({ records: [rule("r_00000000000000aa", scope, { rule: "Keep the amber fixture readable for every later reader." }), row] }));
  return row;
}
const stored = (scope: string) => roleMemoryCollection()!.get(`s:${scope}`) as RoleMemoryScopeRow;
const whole = (scope: string) => scopeRowWithHistory(stored(scope), { undo: true });
function historyRowKeys(): string[] {
  const db = new Database(path.join(dir, "state.sqlite"), { readonly: true });
  try { return db.query<{ row_key: string }, [string]>("SELECT row_key FROM state_rows WHERE collection=? ORDER BY row_key").all(ROLE_HISTORY_COLLECTION).map(row => row.row_key); }
  finally { db.close(); }
}
/** A state backup taken just now, as the drain requires before its first step. */
const backedUp = { newestBackupAt: () => Date.now() };
const drainAll = (graceMs = 0, now?: number) => drainRoleHistory({ minEntries: 1, graceMs, now, newestBackupAt: () => now ?? Date.now() });

test("the drain keeps every history entry and continues from the stored rows after a stop", async () => {
  const scope = roleScope(PROJECT, "builder");
  const original = seed(scope, entries(300, 2_000, scope));
  // One bounded step, then nothing: the process stopped here.
  expect(drainRoleHistoryStep({ after: "" }, { minEntries: 1, maxEntries: 70, ...backedUp })).toBe(true);
  expect(stored(scope).history).toHaveLength(230);
  expect(stored(scope).historyRows).toMatchObject({ next: 70, count: 70 });
  expect(JSON.stringify(whole(scope).history)).toBe(JSON.stringify(original.history));
  // A new process holds no cursor and no memory of the first step.
  expect(await drainRoleHistory({ minEntries: 1, maxEntries: 70, ...backedUp })).toBe(4);
  expect(stored(scope).history).toEqual([]);
  expect(stored(scope).historyRows).toMatchObject({ next: 300, count: 300, ordinary: 225 });
  expect(JSON.stringify(whole(scope))).toBe(JSON.stringify(original));
  expect(historyRowKeys().filter(key => key.startsWith("h:"))).toHaveLength(300);
  expect(historyRowKeys().filter(key => key.startsWith("u:"))).toHaveLength(75);
  expect(await drainAll()).toBe(0);
});

test("one transaction of the drain is bounded by bytes as well as entries", () => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(40, 20_000, scope));
  expect(drainRoleHistoryStep({ after: "" }, { minEntries: 1, maxBytes: 50_000, ...backedUp })).toBe(true);
  // Two 20 KB curator calls and the lessons around them fit; the third call would pass the bound.
  expect(stored(scope).historyRows!.count).toBe(11);
});

test("a short recent tail stays in the scope row until it is worth a write", async () => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(8, 100, scope));
  expect(await drainRoleHistory(backedUp)).toBe(0);
  expect(stored(scope).history).toHaveLength(8);
});

test.each([["every entry in rows", 1024], ["rows and a tail still in the scope row", 50]] as const)("readers answer the same from history rows as from the scope row: %s", async (_name, moved) => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(120, 500, scope));
  const answers = async () => ({
    metadata: roleScopeReadMetadata(scope, "p_3"), otherPass: roleScopeReadMetadata(scope, "p_none"), last: roleScopePassLastAt(scope, "p_7"),
    search: activeRoleRuleRows({ project: PROJECT, terms: ["amber"], limit: 10 }),
    status: curationStatus(PROJECT, NOW, undefined, undefined, false),
    scopes: curationScopes(PROJECT).map(row => ({ ...row, history: row.history.map(entry => ({ ...entry, prior: undefined })) })),
    view: projectView(PROJECT, NOW).scopes,
    rows: projectViewRows(PROJECT).map(row => row.kind === "scope" ? { ...row, history: row.history.map(entry => ({ ...entry, prior: undefined })) } : row),
    cooperative: await projectViewRowsCooperatively(PROJECT),
  });
  const before = await answers();
  expect(before.metadata.hasPass).toBe(true);
  expect(drainRoleHistoryStep({ after: "" }, { minEntries: 1, maxEntries: moved, ...backedUp })).toBe(true);
  expect(stored(scope).history).toHaveLength(Math.max(0, 120 - moved));
  const after = await answers();
  expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify({ ...before,
    scopes: before.scopes.map(row => ({ ...row, historyRows: undefined })), rows: before.rows })));
});

test.skipIf(!linux)("reads of current content cost the same whatever history a scope retains", async () => {
  const small = roleScope(PROJECT, "builder"), large = roleScope(PROJECT, "reviewer");
  seed(small, entries(400, 200, small));
  roleMemoryCollection(true)!.patchSync(() => ({ records: [{ kind: "scope", scope: large, revision: 400, active: ["r_00000000000000aa"], history: entries(400, 60_000, large), curatedAt: at() }] }));
  const body = (scope: string) => Buffer.byteLength(JSON.stringify(stored(scope)));
  const largeBody = body(large);
  expect(largeBody).toBeGreaterThan(6_000_000);
  expect(await drainAll()).toBeGreaterThan(0);
  expect(body(large)).toBeLessThan(1_000);
  // Each read is the first one after the write: no digest or view is held yet.
  const cost = {
    small: readBytes(() => roleScopeReadMetadata(small, "p_3")).bytes,
    large: readBytes(() => roleScopeReadMetadata(large, "p_3")).bytes,
  };
  expect(Math.abs(cost.large - cost.small)).toBeLessThan(largeBody / 20);
  expect(cost.large).toBeLessThan(largeBody / 20);
  roleMemoryCollection(true)!.boundedPatch(4, tx => { tx.put({ ...stored(small), revision: 401 }); tx.put({ ...stored(large), revision: 401 }); });
  const search = readBytes(() => activeRoleRuleRows({ project: PROJECT, terms: ["amber"], limit: 10 }));
  expect(search.value.map(found => found.id)).toEqual(["r_00000000000000aa"]);
  expect(search.bytes).toBeLessThan(largeBody / 10);
  roleMemoryCollection(true)!.boundedPatch(4, tx => { tx.put({ ...stored(large), revision: 402 }); });
  const view = readBytes(() => projectViewRows(PROJECT));
  expect(view.value.find(row => row.kind === "scope" && row.scope === large)).toMatchObject({ revision: 402 });
  expect(view.bytes).toBeLessThan(largeBody / 10);
});

test("writers append to the scope row and a later drain keeps the order", async () => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(40, 300, scope));
  await drainAll();
  recordLessonRequest({ ...source, at: at(100_000) });
  const left = leaveLessons({ request: source, source, lessons: [{ scope: "role", rule: "Read the stored revision before each write to shared guidance.", why }], none: null, now: at(100_000) });
  expect(left.left).toHaveLength(1);
  expect(stored(scope).history).toHaveLength(1);
  expect(stored(scope).historyRows).toMatchObject({ count: 40 });
  const appended = whole(scope).history;
  expect(appended).toHaveLength(41);
  expect(appended.at(-1)).toMatchObject({ by: "agent", added: [left.left[0]!.id] });
  await drainAll();
  expect(stored(scope).history).toEqual([]);
  expect(JSON.stringify(whole(scope).history)).toBe(JSON.stringify(appended));
});

function pass(now = NOW) { return claimPass({ project: PROJECT, repoDir: dir, now })!; }
function curate(scopes: Record<string, string[]>, edits: Partial<CurationApply> = {}): CurationApply {
  return { scopes: Object.entries(scopes).map(([scope, order]) => ({ scope, revision: stored(scope)?.revision ?? 0, order })), ...edits };
}

test("a curator pass applied before the drain is undone from history rows", async () => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(30, 300, scope));
  const p = pass();
  const rewritten = "Keep the amber fixture readable and name the reader it serves.";
  applyCuration(p, curate({ [scope]: ["r_00000000000000aa"] }, { rewrite: [{ id: "r_00000000000000aa", rule: rewritten, note: "Name the reader." }] }), at(200_000));
  patchPass(p.id, { state: "succeeded", endedAt: at(201_000) });
  expect((roleMemoryCollection()!.get("r:r_00000000000000aa") as RoleMemoryRule).rule).toBe(rewritten);
  await drainAll();
  expect(stored(scope).history).toEqual([]);
  const moved = historyRowKeys();
  expect(revertCuratorPass(p.id, at(300_000), { refreshKnownValues: false }).skipped).toEqual([]);
  expect((roleMemoryCollection()!.get("r:r_00000000000000aa") as RoleMemoryRule).rule).toBe("Keep the amber fixture readable for every later reader.");
  // The undo marked its entry inside a whole history and stored the scope that way.
  expect(stored(scope).historyRows).toBeUndefined();
  expect(stored(scope).historyDropped).toHaveLength(1);
  expect(stored(scope).history).toHaveLength(31);
  expect(stored(scope).history.at(-1)).toMatchObject({ pass: p.id, revertedAt: at(300_000) });
  // Inside the grace period the released rows stay beside the new ones.
  await drainAll(3_600_000, NOW + 400_000);
  expect(stored(scope).history).toEqual([]);
  expect(moved.every(key => historyRowKeys().includes(key))).toBe(true);
  // After it they are removed, and the record of the release with them.
  await drainAll();
  expect(stored(scope).historyDropped).toBeUndefined();
  expect(stored(scope).history).toEqual([]);
  expect(whole(scope).history.at(-1)).toMatchObject({ pass: p.id, revertedAt: at(300_000) });
  expect(historyRowKeys().some(key => moved.includes(key))).toBe(false);
  expect(historyRowKeys().filter(key => key.startsWith("h:"))).toHaveLength(31);
});

test.skipIf(!linux)("a curator apply costs the same whatever undo payloads its scopes retain", async () => {
  // Two projects with the same rules and entries; one retains 400 times the undo bytes.
  const cost = async (project: string, undoBytes: number) => {
    const scope = roleScope(project, "builder"), other = roleScope(project, "reviewer");
    seed(scope, entries(200, undoBytes, scope));
    roleMemoryCollection(true)!.patchSync(() => ({ records: [{ kind: "scope", scope: other, revision: 200, active: [], history: entries(200, undoBytes, other) }] }));
    const retained = Buffer.byteLength(JSON.stringify(stored(scope))) + Buffer.byteLength(JSON.stringify(stored(other)));
    await drainAll();
    const p = claimPass({ project, repoDir: dir, now: NOW })!;
    const applied = readBytes(() => applyCuration(p, curate({ [scope]: ["r_00000000000000aa"] }), at(300_000)));
    expect(applied.value.counts).toMatchObject({ calls: 1 });
    expect(whole(scope).history.at(-1)).toMatchObject({ pass: p.id, by: "curator" });
    expect(stored(other).revision).toBe(200);
    patchPass(p.id, { state: "succeeded", endedAt: at(301_000) });
    return { retained, bytes: applied.bytes };
  };
  const small = await cost("history-rows-small", 100), large = await cost("history-rows-large", 40_000);
  expect(large.retained).toBeGreaterThan(small.retained * 20);
  expect(large.retained).toBeGreaterThan(4_000_000);
  expect(Math.abs(large.bytes - small.bytes)).toBeLessThan(256 * 1024);
});

test("a scope joined after its project key moved carries both whole histories", async () => {
  const from = "role:history-rows-old:builder", into = "role:history-rows-new:builder";
  const source = seed(from, entries(20, 300, from));
  roleMemoryCollection(true)!.patchSync(() => ({ records: [{ kind: "scope", scope: into, revision: 12, active: [], history: entries(12, 300, into) }] }));
  const target = stored(into);
  await drainAll();
  expect(stored(from).history).toEqual([]);
  expect(persistProjectAliases([{ source: "history-rows-old", target: "history-rows-new", displayName: "history-rows-new" }])).toBe(true);
  joinMovedScopes(at(400_000));
  expect(roleMemoryCollection()!.get(`s:${from}`)).toBeNull();
  const joined = stored(into);
  expect(joined.historyRows).toBeUndefined();
  expect(joined.historyDropped).toHaveLength(2);
  expect(joined.history).toHaveLength(33);
  expect(joined.history.slice(0, 20).map(entry => ({ ...entry, revisionScope: undefined }))).toEqual(source.history.map(entry => ({ ...entry, revisionScope: undefined })));
  expect(joined.history.slice(20, 32).map(entry => ({ ...entry, revisionScope: undefined }))).toEqual(target.history.map(entry => ({ ...entry, revisionScope: undefined })));
  await drainAll();
  expect(JSON.stringify(whole(into).history)).toBe(JSON.stringify(joined.history));
  expect(historyRowKeys().filter(key => key.startsWith("h:"))).toHaveLength(33);
});

test("the retained window of entries without a pass spans history rows and the scope row", async () => {
  const scope = roleScope(PROJECT, "builder");
  const lesson = (index: number): ScopeHistoryEntry => ({ revision: index + 1, at: at(index), by: "agent", added: [], merged: [], archived: [] });
  seed(scope, Array.from({ length: ROLE_MEMORY_HISTORY_LIMIT }, (_, index) => lesson(index)));
  await drainAll();
  roleMemoryCollection(true)!.boundedPatch(2, tx => { tx.put({ ...stored(scope), history: Array.from({ length: 30 }, (_, index) => lesson(ROLE_MEMORY_HISTORY_LIMIT + index)) }); });
  await drainAll();
  const kept = whole(scope).history;
  expect(kept).toHaveLength(ROLE_MEMORY_HISTORY_LIMIT);
  expect(kept[0]!.revision).toBe(31);
  expect(kept.at(-1)!.revision).toBe(ROLE_MEMORY_HISTORY_LIMIT + 30);
  expect(stored(scope).historyRows).toMatchObject({ count: ROLE_MEMORY_HISTORY_LIMIT, ordinary: ROLE_MEMORY_HISTORY_LIMIT });
}, 60_000);

test("an install export carries each scope with its whole history in its row", async () => {
  const scope = roleScope(PROJECT, "builder");
  const original = seed(scope, entries(60, 400, scope));
  await drainAll();
  const snapshot = takeSourceSnapshot(dir, dir);
  try {
    const part = PARTS.find(candidate => candidate.id === "rows:role_memory")!;
    const exported = part.collect(snapshot).find(row => row.key === `s:${scope}`)!;
    expect(JSON.stringify(exported.value)).toBe(JSON.stringify(original));
  } finally { snapshot.close(); }
});

/* A process of the release before history rows: it reads the scope row,
   appends to `history` and writes the row back, knowing nothing of rows. */
function earlierReleaseAppend(scope: string, entry: ScopeHistoryEntry) {
  roleMemoryCollection(true)!.boundedPatch(8, tx => {
    const held = tx.get(`s:${scope}`) as RoleMemoryScopeRow;
    tx.put({ ...held, revision: entry.revision, history: [...held.history, entry] });
  });
}

test("a write by an earlier release keeps the scope's history rows and loses no entry", async () => {
  const scope = roleScope(PROJECT, "builder");
  const original = seed(scope, entries(50, 300, scope));
  await drainAll();
  const named = stored(scope).historyRows;
  const late: ScopeHistoryEntry = { revision: 51, at: at(900_000), by: "agent", added: ["r_00000000000000cc"], merged: [], archived: [] };
  earlierReleaseAppend(scope, late);
  expect(stored(scope).historyRows).toEqual(named);
  expect(JSON.stringify(whole(scope).history)).toBe(JSON.stringify([...original.history, late]));
  await drainAll();
  expect(JSON.stringify(whole(scope).history)).toBe(JSON.stringify([...original.history, late]));
});

/* The earlier release joins two scope rows as it reads them, entries in the
   scope rows only, and removes the moved one. */
function earlierReleaseJoin(from: string, into: string) {
  roleMemoryCollection(true)!.boundedPatch(8, tx => {
    const source = tx.get(`s:${from}`) as RoleMemoryScopeRow, target = tx.get(`s:${into}`) as RoleMemoryScopeRow;
    tx.put({ ...target, revision: 21, history: [...source.history, ...target.history, { revision: 21, at: at(950_000), by: "succession", added: [], merged: [], archived: [] }] });
    tx.delete(`s:${from}`);
  });
}

test("rows left by an earlier release's scope join go to the scope the stored aliases name", async () => {
  const from = "role:history-rows-old:builder", into = "role:history-rows-new:builder";
  const source = seed(from, entries(20, 300, from));
  roleMemoryCollection(true)!.patchSync(() => ({ records: [{ kind: "scope", scope: into, revision: 12, active: [], history: entries(12, 300, into) }] }));
  const target = stored(into);
  await drainAll();
  expect(persistProjectAliases([{ source: "history-rows-old", target: "history-rows-new", displayName: "history-rows-new" }])).toBe(true);
  earlierReleaseJoin(from, into);
  expect(stored(into).historyRows).toMatchObject({ count: 12 });
  expect(unclaimedRoleHistoryTokens()).toBe(1);
  await drainAll(3_600_000, NOW + 960_000);
  expect(unclaimedRoleHistoryTokens()).toBe(0);
  const joined = whole(into).history;
  expect(joined).toHaveLength(33);
  expect(JSON.stringify(joined.slice(0, 20).map(entry => ({ ...entry, revisionScope: undefined })))).toBe(JSON.stringify(source.history.map(entry => ({ ...entry, revisionScope: undefined }))));
  expect(joined.slice(0, 20).every(entry => entry.revisionScope === from)).toBe(true);
  expect(JSON.stringify(joined.slice(20, 32))).toBe(JSON.stringify(target.history));
  expect(joined.at(-1)).toMatchObject({ by: "succession" });
});

test("rows whose scope is gone and that no alias places are kept and counted", async () => {
  const from = "role:history-rows-old:builder", into = "role:history-rows-new:builder";
  seed(from, entries(20, 300, from));
  roleMemoryCollection(true)!.patchSync(() => ({ records: [{ kind: "scope", scope: into, revision: 12, active: [], history: entries(12, 300, into) }] }));
  await drainAll();
  const before = historyRowKeys();
  earlierReleaseJoin(from, into);
  await drainAll();
  expect(before.every(key => historyRowKeys().includes(key))).toBe(true);
  expect(whole(into).history).toHaveLength(13);
  expect(unclaimedRoleHistoryTokens()).toBe(1);
});

test("a history its readers refuse stays in the scope row", async () => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(20, 300, scope));
  roleMemoryCollection(true)!.boundedPatch(2, tx => { tx.put({ ...stored(scope), history: [null] } as unknown as RoleMemoryScopeRow); });
  expect(await drainAll()).toBe(0);
  expect(stored(scope).history).toEqual([null] as never);
  expect(historyRowKeys()).toEqual([]);
});

test.each([["absent", {}], ["null", { prior: null }], ["an empty array", { prior: [] }], ["an array", { prior: [{ id: "r_00000000000000aa", version: null, fields: { state: "active" } }] }]] as const)(
  "an entry whose undo payload is %s is stored and read back exactly", async (_name, extra) => {
  const scope = roleScope(PROJECT, "builder");
  const entry = { revision: 1, at: at(), by: "curator", pass: "p_exact", before: [], ...extra, created: [], added: [], merged: [], archived: [] } as unknown as ScopeHistoryEntry;
  const original = seed(scope, [entry, { revision: 2, at: at(1000), by: "agent", added: [], merged: [], archived: [] }]);
  await drainAll();
  expect(stored(scope).history).toEqual([]);
  expect(JSON.stringify(whole(scope))).toBe(JSON.stringify(original));
  // A reader that leaves undo payloads out still sees what the scope row itself held.
  const read = scopeRowWithHistory(stored(scope)).history[0]!;
  expect("prior" in read).toBe(Array.isArray(extra && (extra as { prior?: unknown }).prior) ? false : "prior" in extra);
  // An undo of that pass reads the scope without failing.
  expect(() => scopeRowForRewrite(stored(scope), at(2000))).not.toThrow();
});

test("an import that merges into a scope with history rows records the rows it replaces", () => {
  const scope = roleScope(PROJECT, "builder");
  const held: RoleMemoryScopeRow = { kind: "scope", scope, revision: 3, active: ["r_00000000000000aa"], history: entries(3, 100, scope) };
  const arriving = rule("r_00000000000000dd", scope, { rule: "Name the reader each stored rule serves before it is written." });
  const incoming = [{ key: `r:${arriving.id}`, value: arriving }, { key: `s:${scope}`, value: { kind: "scope", scope, revision: 1, active: [arriving.id], history: [] } }];
  const plan = planRoleMemory(incoming, new Map([[`s:${scope}`, JSON.stringify(held)]]), { now: at(5000), released: new Map([[`s:${scope}`, "00112233aabbccdd"]]) });
  const merged = plan.writes.find(write => write.key === `s:${scope}`)!.value as RoleMemoryScopeRow;
  expect(merged.history.at(-1)).toMatchObject({ by: "transfer", added: [arriving.id] });
  expect(merged.historyDropped).toEqual([{ token: "00112233aabbccdd", at: at(5000) }]);
});

test("the first step on a store is refused without a state backup from the last hour", async () => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(40, 300, scope));
  const options = { minEntries: 1, now: NOW };
  expect(() => drainRoleHistoryStep({ after: "" }, options)).toThrow(RoleHistoryDrainRefusal);
  expect(() => drainRoleHistoryStep({ after: "" }, { ...options, newestBackupAt: () => NOW - 2 * ROLE_HISTORY_BACKUP_AGE_MS })).toThrow("state backup");
  expect(stored(scope).history).toHaveLength(40);
  expect(historyRowKeys()).toEqual([]);
  expect(drainRoleHistoryStep({ after: "" }, { ...options, maxEntries: 10, newestBackupAt: () => NOW - 60_000 })).toBe(true);
  // A store that already has history rows is past the point the backup guards.
  expect(drainRoleHistoryStep({ after: "" }, { ...options, maxEntries: 10 })).toBe(true);
  expect(stored(scope).historyRows).toMatchObject({ count: 20 });
});

test("the drain stays off until the operator turns it on, and turning it on needs the backup", () => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(40, 300, scope));
  expect(roleHistoryRowsEnabled()).toBe(false);
  expect(() => setRoleHistoryRowsEnabled(true, { now: NOW })).toThrow(RoleHistoryDrainRefusal);
  expect(roleHistoryRowsEnabled()).toBe(false);
  setRoleHistoryRowsEnabled(true, { now: NOW, newestBackupAt: () => NOW - 60_000 });
  expect(roleHistoryRowsEnabled()).toBe(true);
  setRoleHistoryRowsEnabled(false);
  expect(roleHistoryRowsEnabled()).toBe(false);
});

test("a refused scope row is not read again until it changes", async () => {
  const scope = roleScope(PROJECT, "builder");
  seed(scope, entries(20, 300, scope));
  roleMemoryCollection(true)!.boundedPatch(2, tx => { tx.put({ ...stored(scope), history: [null] } as unknown as RoleMemoryScopeRow); });
  await drainAll();
  const memory = roleMemoryCollection()!, get = spyOn(memory, "get");
  try {
    await drainAll();
    expect(get.mock.calls.filter(([key]) => key === `s:${scope}`)).toHaveLength(0);
    roleMemoryCollection(true)!.boundedPatch(2, tx => { tx.put({ ...stored(scope), history: entries(20, 300, scope) }); });
    get.mockClear();
    await drainAll();
    expect(get.mock.calls.filter(([key]) => key === `s:${scope}`).length).toBeGreaterThan(0);
  } finally { get.mockRestore(); }
  expect(stored(scope).history).toEqual([]);
});

/* A scope row holds only its newest entries, so code that reads `.history`
   of a row it took from the store, or writes a scope row it built itself,
   is wrong in a way no type shows. Whole histories come from
   `scopeRowWithHistory` and its callers in roleViewSource; appends go through
   `scopeRowWithEntry`. This list is every production file that touches a
   scope's history and how many lines do; a change here means a new reader or
   writer, to be checked against those two accessors before the count moves. */
const HISTORY_TOUCHES: Record<string, number> = {
  "scripts/memory-replay.ts": 1,
  "scripts/replay-viewer-readers.ts": 1,
  "src/lib/memory/curation/apply.ts": 7,
  "src/lib/memory/curation/store.ts": 2,
  "src/lib/memory/importLifecycle.ts": 1,
  "src/lib/memory/roleHistoryDrain.ts": 7,
  "src/lib/memory/roleHistoryRows.ts": 4,
  "src/lib/memory/roleStore.ts": 9,
  "src/lib/memory/roleTypes.ts": 1,
  "src/lib/memory/roleViewSource.ts": 7,
  "src/lib/transfer/exporter.ts": 1,
  "src/lib/transfer/importer.ts": 6,
  "src/lib/transfer/roleMemory.ts": 2,
  "src/lib/transfer/sections.ts": 1,
  "src/runtime-host/candidateStateDataset.ts": 2,
};
test("every production touch of a scope's history is a reviewed one", () => {
  const root = path.join(import.meta.dir, "..", "..", "..");
  const found: Record<string, number> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== "fixtures" && entry.name !== "node_modules") walk(relative); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.(test|fixture|cases)\.tsx?$/.test(entry.name)) continue;
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      if (!/RoleMemoryScopeRow|roleMemoryCollection|RoleMemoryRow\b/.test(source)) continue;
      const lines = source.split("\n").filter(line => /\.history\b|\bhistory:/.test(line) && !/^\s*(\/\/|\/?\*)/.test(line)).length;
      if (lines) found[relative] = lines;
    }
  };
  for (const directory of ["src/lib", "src/app", "src/runtime-host", "scripts"]) walk(directory);
  expect(found).toEqual(HISTORY_TOUCHES);
});
