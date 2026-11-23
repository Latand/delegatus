import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database, type Statement } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { roleMemoryCollection, roleScope } from "./roleStore";
import { activeRoleRuleRows } from "./roleViewSource";
import type { RoleMemoryRule, RuleSource, ScopeHistoryEntry } from "./roleTypes";

const PROJECT = "active-rules-fixture";
const AT = "2026-10-11T00:00:00.000Z";
let dir: string, previous: string | undefined;
beforeEach(() => {
  resetProjectAliasesForTests();
  previous = process.env.LLV_STATE_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-active-rules-"));
  process.env.LLV_STATE_DIR = dir;
});
afterEach(() => {
  process.env.LLV_STATE_DIR = previous;
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  resetProjectAliasesForTests();
});

const source: RuleSource = { project: PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: ["conversation", "fixture"].join("_") };
function rule(scope: string, id: string, text: string, extra: Partial<RoleMemoryRule> = {}) {
  roleMemoryCollection(true)!.boundedPatch(20, tx => {
    tx.put({ kind: "rule", id, scope, rule: text, why: "An earlier attempt needed it.", state: "active", hints: [], source, createdAt: AT, changedAt: AT, ...extra });
  });
}
function scopeRow(scope: string, active: string[], history: ScopeHistoryEntry[] = []) {
  roleMemoryCollection(true)!.boundedPatch(20, tx => { tx.put({ kind: "scope", scope, revision: 1, active, history }); });
}
const ids = (rows: { id: string }[]) => rows.map(row => row.id).sort();
/** Executions of statements that decode a scope row's active membership; each
 * one parses a whole scope row, retained history included. */
function membershipDecodes(work: () => void): number {
  let decodes = 0;
  const real = Database.prototype.query, wrapped = new WeakSet<object>();
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    const statement = real.call(this, sql) as Statement;
    if (sql.includes("'$.active'") && !wrapped.has(statement)) {
      wrapped.add(statement);
      const all = statement.all.bind(statement);
      statement.all = ((...args: never[]) => { if (counting) decodes++; return all(...args); }) as typeof statement.all;
    }
    return statement;
  } as never);
  let counting = true;
  try { work(); return decodes; }
  finally { counting = false; spy.mockRestore(); }
}

test("search answers from current active membership", () => {
  const builder = roleScope(PROJECT, "builder"), reviewer = roleScope(PROJECT, "reviewer");
  rule(builder, "r_one", "Run the repository checks before publication.");
  rule(builder, "r_two", "Keep the change inside the named module.");
  rule(builder, "r_left", "Run the old checks.", { state: "archived" });
  rule(reviewer, "r_three", "Read the checks output before the verdict.");
  rule(roleScope("another-project", "builder"), "r_foreign", "Run the checks of another project.");
  scopeRow(builder, ["r_one", "r_two", "r_left"]);
  scopeRow(reviewer, ["r_three"]);
  scopeRow(roleScope("another-project", "builder"), ["r_foreign"]);
  expect(ids(activeRoleRuleRows({ project: PROJECT, limit: 20 }))).toEqual(["r_one", "r_three", "r_two"]);
  expect(ids(activeRoleRuleRows({ project: PROJECT, terms: ["checks"], limit: 20 }))).toEqual(["r_one", "r_three"]);
  expect(ids(activeRoleRuleRows({ project: PROJECT, terms: ["checks"], limit: 1 }))).toHaveLength(1);
  expect(ids(activeRoleRuleRows({ project: PROJECT, id: "r_two", limit: 20 }))).toEqual(["r_two"]);
  expect(ids(activeRoleRuleRows({ limit: 20 }))).toEqual(["r_foreign", "r_one", "r_three", "r_two"]);
  // Membership leaves with the scope row, whatever the rule row still says.
  scopeRow(builder, ["r_two"]);
  expect(ids(activeRoleRuleRows({ project: PROJECT, limit: 20 }))).toEqual(["r_three", "r_two"]);
  scopeRow(builder, ["r_two", "r_one"]);
  expect(ids(activeRoleRuleRows({ project: PROJECT, terms: ["Проверки"], limit: 20 }))).toEqual([]);
  expect(ids(activeRoleRuleRows({ project: PROJECT, limit: 20 }))).toEqual(["r_one", "r_three", "r_two"]);
});

test("a search over unchanged scopes decodes no scope row", () => {
  const builder = roleScope(PROJECT, "builder"), reviewer = roleScope(PROJECT, "reviewer");
  rule(builder, "r_one", "Run the repository checks before publication.");
  rule(reviewer, "r_two", "Read the checks output before the verdict.");
  scopeRow(builder, ["r_one"], [{ revision: 1, at: AT, by: "curator" } as unknown as ScopeHistoryEntry]);
  scopeRow(reviewer, ["r_two"]);
  expect(ids(activeRoleRuleRows({ project: PROJECT, limit: 20 }))).toEqual(["r_one", "r_two"]);
  const later = membershipDecodes(() => {
    for (let search = 0; search < 3; search++) expect(ids(activeRoleRuleRows({ project: PROJECT, terms: ["checks"], limit: 20 }))).toEqual(["r_one", "r_two"]);
  });
  expect(later).toBe(0);
  // A rewritten scope row is decoded once more, and only that row.
  scopeRow(reviewer, []);
  expect(membershipDecodes(() => expect(ids(activeRoleRuleRows({ project: PROJECT, limit: 20 }))).toEqual(["r_one"]))).toBe(1);
});
