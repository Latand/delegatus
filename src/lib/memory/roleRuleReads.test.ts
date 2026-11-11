import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rule-reads-"));
process.env.LLV_STATE_DIR = path.join(root, "initial");
const { resetProjectAliasesForTests } = await import("@/lib/projects/aliases");
const { learnedRulesSnapshot, roleMemoryCollection, roleScope, stageLessons, storedLessonPatterns, storedLessonTexts, withoutStoredLessonsIn } = await import("./roleStore");
const { memoryProblemSignals, readMemoryProblem } = await import("./roleProblems");
import type { LessonRequestRow, RoleMemoryRule, RoleMemoryScopeRow, ScopeHistoryEntry } from "./roleTypes";

const PROJECT = "rule-reads-fixture";
const AT = "2026-10-11T00:00:00.000Z";
let generation = 0;
beforeEach(() => {
  resetProjectAliasesForTests();
  process.env.LLV_STATE_DIR = path.join(root, String(++generation));
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
});
afterEach(() => resetProjectAliasesForTests());
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const source = { project: PROJECT, pipelineId: "p", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "c" };
const LESSON = "Keep the amber ledger readable for every later reader of the fixture";
function rule(id: string, scope: string, extra: Partial<RoleMemoryRule> = {}): RoleMemoryRule {
  return { kind: "rule", id, scope, rule: LESSON, why: "An earlier attempt left the ledger unreadable.", state: "active", hints: [], source, createdAt: AT, changedAt: AT, ...extra } as RoleMemoryRule;
}
/** A scope like a long-lived one: its row is nearly all retained history. */
function seed(): { scope: string; scopeBytes: number } {
  const scope = roleScope(PROJECT, "builder");
  const history = Array.from({ length: 300 }, (_, index): ScopeHistoryEntry => ({ revision: index + 1, at: AT, by: "curator", pass: `p_${index % 5}`, before: [], created: [], added: [], merged: [], archived: [],
    prior: [{ id: "r_00000000000000aa", version: null, fields: { note: "n".repeat(20_000) } as never }] }));
  const row: RoleMemoryScopeRow = { kind: "scope", scope, revision: 300, active: ["r_00000000000000aa"], history };
  const request: LessonRequestRow = { kind: "request", pipelineId: "p", stageId: "build", attempt: 1, project: PROJECT, roleId: "builder", conversationId: "c", at: AT, ruleIds: ["r_00000000000000aa"], none: null,
    problem: { statement: "The fixture ledger disagrees with its index.", evidence: "Two totals differ." } } as LessonRequestRow;
  roleMemoryCollection(true)!.patchSync(() => ({ records: [rule("r_00000000000000aa", scope), rule("r_00000000000000bb", scope, { state: "archived", rule: "Read the stored ledger revision before each shared write" }), row, request] }));
  return { scope, scopeBytes: Buffer.byteLength(JSON.stringify(row)) };
}

/** Bytes of stored JSON this thread turned into objects during the work: what
 * the Viewer's loop monitor reports as decodedJsonBytes. */
function decodedBytes<T>(work: () => T): { value: T; bytes: number } {
  const real = JSON.parse;
  let bytes = 0;
  const spy = spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof text === "string") bytes += text.length;
    return real(text, reviver);
  }) as typeof JSON.parse);
  try { return { value: work(), bytes }; } finally { spy.mockRestore(); }
}

test("the privacy matcher reads rule rows and decodes no scope row", () => {
  const { scopeBytes } = seed();
  expect(scopeBytes).toBeGreaterThan(6_000_000);
  const texts = decodedBytes(() => storedLessonTexts());
  expect(texts.value).toContain(LESSON);
  expect(texts.value).toContain("Read the stored ledger revision before each shared write");
  expect(texts.bytes).toBeLessThan(64 * 1024);
  const matched = decodedBytes(() => ({ patterns: storedLessonPatterns().length, text: withoutStoredLessonsIn(`before ${LESSON} after`) }));
  expect(matched.value).toEqual({ patterns: 3, text: "before [learned rule] after" });
  expect(matched.bytes).toBeLessThan(64 * 1024);
});

test("a stage's learned rules and a card's lessons are read without any scope history", () => {
  const { scope } = seed();
  const snapshot = decodedBytes(() => learnedRulesSnapshot(PROJECT, "builder"));
  expect(snapshot.value.rules.map(found => found.id)).toEqual(["r_00000000000000aa"]);
  expect(snapshot.value.scopes.find(held => held.scope === scope)?.revisions).toEqual([{ scope, revision: 300, revisionScope: scope }]);
  expect(snapshot.bytes).toBeLessThan(64 * 1024);
  const lessons = decodedBytes(() => stageLessons(PROJECT));
  expect(lessons.value).toMatchObject([{ pipelineId: "p", stageId: "build", attempt: 1, rules: [{ id: "r_00000000000000aa", rule: LESSON }] }]);
  expect(lessons.bytes).toBeLessThan(64 * 1024);
});

test("reported problems are read from the rows that carry one", () => {
  seed();
  const signals = decodedBytes(() => memoryProblemSignals(PROJECT, []));
  const problem = signals.value.find(signal => signal.id.startsWith("memory-problem:"))!;
  expect(problem).toMatchObject({ actionable: true });
  expect(signals.bytes).toBeLessThan(64 * 1024);
  const read = decodedBytes(() => readMemoryProblem(PROJECT, problem.id));
  expect(read.value).toEqual({ statement: "The fixture ledger disagrees with its index.", evidence: "Two totals differ." });
  expect(read.bytes).toBeLessThan(64 * 1024);
});

test("a rule row that cannot be read refuses the privacy check", () => {
  seed();
  roleMemoryCollection(true)!.patchSync(() => ({ records: [{ kind: "rule", id: "r_00000000000000cc", scope: "machine", rule: 7 } as never] }));
  expect(() => storedLessonTexts()).toThrow(expect.objectContaining({ code: "LESSON_PRIVACY_UNAVAILABLE" }));
});
