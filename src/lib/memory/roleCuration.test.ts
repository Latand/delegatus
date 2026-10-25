import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-curation-"));
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const store = await import("./roleStore");
const { appendRule, scopeChars } = await import("./roleConsolidate");
const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
type Row = import("./roleTypes").RoleMemoryRow;
type Rule = import("./roleTypes").RoleMemoryRule;
const oldText = "Validate every persisted acknowledgement against the operation that owns it.";
const newText = "Validate persisted acknowledgements against their operation and current owner before replay.";
const why = "A replay used an acknowledgement belonging to an earlier owner.";
let attempt = 0;
function request(project = "curation-trial", roleId = "builder") {
  const source = { project, pipelineId: "curation-trial", stageId: "build", attempt: ++attempt, roleId, fixRound: false, conversationId: `conversation_trial_${attempt}` };
  store.recordLessonRequest({ ...source, at: "2026-10-11T00:00:00.000Z" });
  return { request: source, source, none: null };
}

test("a rewrite keeps its id and level, versions its old text, and can be reverted without losing either text", () => {
  const first = store.leaveLessons({ ...request(), lessons: [{ scope: "role", rule: oldText, why }] }).left[0]!;
  const before = store.projectView("curation-trial").scopes.find(s => s.scope === first.scope)!;
  const rewritten = store.leaveLessons({ ...request(), lessons: [], rewrite: { id: first.id, rule: newText, why } });
  expect(rewritten.left[0]).toMatchObject({ id: first.id, scope: first.scope, action: "rewrite" });
  const after = store.projectView("curation-trial").scopes.find(s => s.scope === first.scope)!;
  expect(after.revision).toBe(before.revision + 1);
  expect(after.active.map(r => r.id)).toEqual(before.active.map(r => r.id));
  expect(after.active[0]).toMatchObject({ rule: newText, versions: [expect.objectContaining({ rule: oldText })] });
  expect(after.left).toEqual([]);
  expect(JSON.stringify(after)).not.toContain("conversation_trial");
  expect(store.storedLessonTexts()).toContain(oldText);
  expect(store.storedLessonTexts()).toContain(newText);
  const version = rewritten.left[0]!.version!;
  expect(() => store.restoreRule(version)).toThrow(/version/i);
  expect(() => store.leaveLessons({ ...request(), lessons: [], rewrite: { id: version, rule: oldText, why } })).toThrow(/readable/i);
  store.revertRule(version);
  const reverted = store.projectView("curation-trial").scopes.find(s => s.scope === first.scope)!.active[0]!;
  expect(reverted.rule).toBe(oldText);
  // The text now in force is not offered as an earlier text; only the rewrite it replaced is.
  expect(reverted.versions).toEqual([expect.objectContaining({ rule: newText })]);
  expect(store.storedLessonTexts()).toContain(newText);
});

function fixtureRows() {
  // The v1 decoder accepts only the original three kinds, including versions.
  return new SqliteStateCollection<Row>(path.join(sandbox, "state.sqlite"), {
    collection: "role_memory", schemaVersion: 1, busyMessage: "fixture busy", clone: structuredClone,
    key: row => row.kind === "rule" ? `r:${row.id}` : row.kind === "scope" ? `s:${row.scope}` : `q:${row.pipelineId}:${row.stageId}:${row.attempt}`,
    decode: value => {
      const row = value as Row;
      return ["rule", "scope", "request"].includes(row.kind) ? row : null;
    }, strictDecode: true,
  });
}

test("a start reads exactly its four scopes across projects and never another role's rules", () => {
  const fixtures = [
    ["role:boundary-p:builder", "This builder performs repository-specific preparation."],
    ["role:*:builder", "Every builder checks the ownership of each write."],
    ["project:boundary-p", "Every agent here checks the repository publication gate."],
    ["machine", "Every agent checks that local helper processes remain owned."],
    ["role:boundary-p:visual-critic", "The visual critic inspects the rendered motion window."],
    ["role:*:visual-critic", "Visual critics inspect legibility at narrow widths."],
    ["role:boundary-q:builder", "Builders elsewhere use a different repository workflow."],
    ["project:boundary-q", "Every agent elsewhere checks that project's gate."],
  ];
  const template = fixtureRows().snapshot().find((row): row is Rule => row.kind === "rule" && row.state === "active" && !row.versionOf)!;
  fixtureRows().boundedPatch(40, tx => fixtures.forEach(([scope, rule], index) => {
    const id = `r_boundary_${index}`;
    tx.put({ ...template, id, scope: scope!, rule: rule!, versions: [], revisedBy: undefined, state: "active" });
    tx.put({ kind: "scope", scope: scope!, revision: 1, history: [], active: [id] });
  }));
  expect(store.readableScopes("boundary-p", "builder")).toEqual(["role:boundary-p:builder", "role:*:builder", "project:boundary-p", "machine"]);
  for (const project of ["boundary-p", "boundary-q"]) {
    const block = store.learnedRulesBlock(project, "builder");
    expect(block).toContain(fixtures[1]![1]!);
    expect(block).not.toContain(fixtures[4]![1]!);
    expect(block).not.toContain(fixtures[5]![1]!);
  }
  const block = store.learnedRulesBlock("boundary-p", "builder");
  fixtures.forEach(([, rule], index) => index < 4 ? expect(block).toContain(rule!) : expect(block).not.toContain(rule!));
  expect(block).toContain("Builder on every project");
  expect(store.learnedRulesBlock("boundary-p", "visual-critic")).not.toContain(fixtures[1]![1]!);
});

test("curated and uncurated rules share headroom while duplicates retain their order", () => {
  const make = (id: string, extra: Partial<Rule> = {}): Rule => ({ kind: "rule", id, scope: "role:retention:builder", rule: `${id} ${"word ".repeat(10)}`, why, hints: [], state: "active", source: request().source, createdAt: "2026-10-11T00:00:00.000Z", changedAt: "2026-10-11T00:00:00.000Z", ...extra });
  const best = make("best", { curatedAt: "now" });
  const low = make("low", { curatedAt: "now" });
  const old = make("old");
  const incoming = make("incoming");
  const result = appendRule([low, best, old], incoming, "now", scopeChars([best, low, old, incoming]) - 1);
  expect(result.archived).toEqual([]);
  expect(result.active.map(r => r.id)).toEqual([old.id, incoming.id, low.id, best.id]);
  const repeat = appendRule([old, incoming, low, best], { ...make("repeat"), rule: old.rule }, "now");
  expect(repeat.active.map(r => r.id)).toEqual([incoming.id, old.id, low.id, best.id]);
});

test("a rewrite outside the stage's four scopes leaves its request open", () => {
  const other = request("other-project", "visual-critic");
  const first = store.leaveLessons({ ...other, lessons: [{ scope: "role", rule: oldText, why }] }).left[0]!;
  const own = request("builder-project", "builder");
  expect(() => store.leaveLessons({ ...own, lessons: [], rewrite: { id: first.id, rule: newText, why } })).toThrow(/readable/i);
  expect(store.leaveLessons({ ...own, lessons: [], none: "The existing guidance covers this stage." }).none).toBeTruthy();
  expect(store.learnedRulesBlock(other.source.project, "visual-critic")).toContain(oldText);
});

test("rewrites preserve the project, machine and cross-project role levels", () => {
  for (const level of ["project", "machine"] as const) {
    const first = store.leaveLessons({ ...request("level-rewrite"), lessons: [{ scope: level, rule: oldText, why }] }).left[0]!;
    const changed = store.leaveLessons({ ...request("level-rewrite"), lessons: [], rewrite: { id: first.id, rule: newText, why } }).left[0]!;
    expect(changed.scope).toBe(first.scope);
    expect(changed.id).toBe(first.id);
  }
  const changed = store.leaveLessons({ ...request("boundary-p"), lessons: [], rewrite: { id: "r_boundary_1", rule: newText, why } }).left[0]!;
  expect(changed.scope).toBe("role:*:builder");
  expect(store.learnedRulesBlock("boundary-q", "builder")).toContain(newText);
});

test("Return protects a rule while a subsequent append repairs an old writer's tail order", () => {
  const source = request("retention-store");
  const a = store.leaveLessons({ ...source, lessons: [{ scope: "role", rule: oldText, why }] }).left[0]!;
  const b = store.leaveLessons({ ...request("retention-store"), lessons: [{ scope: "role", rule: newText, why }] }).left[0]!;
  store.deleteRule(a.id);
  store.restoreRule(a.id);
  const rows = fixtureRows();
  rows.boundedPatch(8, tx => {
    const kept = tx.get(`r:${b.id}`) as Rule;
    tx.put({ ...kept, curatedAt: "now" });
  });
  const c = store.leaveLessons({ ...request("retention-store"), lessons: [{ scope: "role", rule: "Keep every externally launched helper bound to the operation that owns its lifetime.", why }] }).left[0]!;
  const scope = store.projectView("retention-store").scopes.find(s => s.scope === a.scope)!;
  expect(scope.active.map(rule => rule.id)).toEqual([c.id, b.id, a.id]);
  expect(store.learnedRulesBlock("retention-store", "builder").indexOf(a.id)).toBeLessThan(store.learnedRulesBlock("retention-store", "builder").indexOf(b.id));
  expect(rows.snapshot().filter(row => row.kind === "rule" && row.versionOf).length).toBeGreaterThan(0);
});

test("a project succession preserves the curation and operator priority of a duplicate", async () => {
  const current = store.leaveLessons({ ...request("priority-current"), lessons: [{ scope: "role", rule: oldText, why }] }).left[0]!;
  const old = store.leaveLessons({ ...request("priority-old"), lessons: [{ scope: "role", rule: oldText, why }] }).left[0]!;
  store.deleteRule(old.id);
  store.restoreRule(old.id);
  fixtureRows().boundedPatch(8, tx => {
    const row = tx.get(`r:${old.id}`) as Rule;
    tx.put({ ...row, curatedAt: "2026-10-11T00:00:00.000Z" });
  });
  const { persistProjectAliases } = await import("@/lib/projects/aliases");
  expect(persistProjectAliases([{ source: "priority-old", target: "priority-current", displayName: "Priority fixture" }])).toBe(true);
  const view = store.projectView("priority-current").scopes.find(s => s.scope === current.scope)!;
  expect(view.active).toHaveLength(1);
  const kept = fixtureRows().snapshot().find((row): row is Rule => row.kind === "rule" && row.id === view.active[0]!.id)!;
  expect(kept.keptByOperatorAt).toBeTruthy();
  expect(kept.curatedAt).toBeTruthy();
});

test("an engine start preserves aliased scopes for available curation without changing the store", async () => {
  const template = fixtureRows().snapshot().find((row): row is Rule => row.kind === "rule" && row.state === "active" && !row.versionOf)!;
  const currentScope = "role:alias-budget-current:builder";
  const oldScope = "role:alias-budget-old:builder";
  const rules = [currentScope, oldScope].flatMap((scope, group) => Array.from({ length: 8 }, (_, n): Rule => ({
    ...template, id: `r_alias_budget_${group}_${n}`, scope,
    rule: `Check durable ownership category ${group} variation ${n} before every replay. ${"Check each receipt. ".repeat(34)}`,
    versions: [], revisedBy: undefined, curatedAt: group ? "2026-10-11T00:00:00.000Z" : undefined,
    keptByOperatorAt: undefined, state: "active",
  })));
  fixtureRows().boundedPatch(40, tx => {
    for (const row of rules) tx.put(row);
    for (const scope of [currentScope, oldScope]) tx.put({ kind: "scope", scope, revision: 1, history: [], active: rules.filter(row => row.scope === scope).map(row => row.id) });
  });
  const { persistProjectAliases } = await import("@/lib/projects/aliases");
  expect(persistProjectAliases([{ source: "alias-budget-old", target: "alias-budget-current", displayName: "Alias bound fixture" }])).toBe(true);
  const before = fixtureRows().snapshot();
  const block = store.learnedRulesBlock("alias-budget-current", "builder");
  const selected = rules.filter(row => block.includes(`[${row.id}]`));
  expect(scopeChars(selected)).toBeGreaterThan(10_000);
  expect(selected).toHaveLength(rules.length);
  for (const row of rules.filter(row => !row.curatedAt)) expect(block).toContain(row.rule);
  expect(fixtureRows().snapshot()).toEqual(before);
});
