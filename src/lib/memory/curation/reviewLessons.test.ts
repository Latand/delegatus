import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { leaveLessons, projectView, recordLessonRequest, roleMemoryCollection, roleScope, newRuleId } from "../roleStore";
import type { RuleSource, RoleMemoryRule } from "../roleTypes";
import { applyCuration, revertCuratorPass, type CurationApply } from "./apply";
import { claimPass, patchPass } from "./store";
import { readCuration } from "./read";
import { curatorBrief } from "./brief";
import { memoryProblemSignals } from "../roleProblems";

const PROJECT = "review-curation";
const NOW = Date.parse("2026-10-12T06:00:00Z");
const at = (delta = 0) => new Date(NOW + delta).toISOString();
const WHY = "Review found a missing combination in rendered evidence.";
const RULE = "For rendered changes, measure every supported width, theme and language before review.";
let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-review-curation-"));
  process.env.LLV_STATE_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function request(lane: string, taskId: string): RuleSource {
  const source = { project: PROJECT, pipelineId: lane, stageId: "fix", attempt: 1, roleId: "builder", fixRound: true, conversationId: `conversation_${lane}` };
  recordLessonRequest({ ...source, taskId, at: at() });
  return source;
}
function leave(lane: string, task: string, rule = RULE) {
  const source = request(lane, task);
  return leaveLessons({ request: source, source, lessons: [{ scope: "role", rule, why: WHY }], none: null, now: at() }).left[0].id;
}
function row(id: string): RoleMemoryRule {
  const row = roleMemoryCollection()!.get(`r:${id}`);
  if (row?.kind !== "rule") throw Error("rule missing");
  return row;
}
function input(orders: Record<string, string[]>, edits: Partial<CurationApply> = {}): CurationApply {
  return { scopes: Object.entries(orders).map(([scope, order]) => {
    const row = roleMemoryCollection()!.get(`s:${scope}`);
    return { scope, order, revision: row?.kind === "scope" ? row.revision : 0 };
  }), ...edits };
}
function scope() { return roleScope(PROJECT, "builder"); }
function active() { return projectView(PROJECT).scopes.flatMap(scope => scope.active); }

test("a curator move without a text edit preserves both tasks of an agent rewrite", () => {
  const id = leave("first", "task-one");
  const source = request("second", "task-two");
  leaveLessons({ request: source, source, lessons: [], rewrite: { id, rule: "For rendered changes, enumerate the supported matrix and measure every combination before review.", why: WHY }, none: null, now: at(1) });
  const pass = claimPass({ project: PROJECT, repoDir: root, now: NOW + 10 })!;
  applyCuration(pass, input({ [scope()]: [], "role:*:builder": [id] }, { move: [{ id, to: "role:*:builder", note: "Builders in every project perform the same rendered check." }] }), at(20));
  expect(row(id).revisedBy?.by).toBe("curator");
  expect(active().find(rule => rule.id === id)?.tasks).toBe(2);
});

test("curator merge joins two tasks into one candidate; Undo restores each task's own rule", () => {
  const one = leave("first", "task-one");
  const two = leave("second", "task-two", "For translated changes, measure every supported locale at each supported width before review.");
  const pass = claimPass({ project: PROJECT, repoDir: root, now: NOW + 10 })!;
  applyCuration(pass, input({ [scope()]: [one] }, { merge: [{ into: one, from: [two], rule: RULE, note: "These tasks missed combinations of one rendered matrix class." }] }), at(20));
  expect(active()).toHaveLength(1);
  expect(active()[0].tasks).toBe(2);
  patchPass(pass.id, { state: "succeeded", endedAt: at(30) });
  expect(revertCuratorPass(pass.id, at(40)).skipped).toEqual([]);
  expect(active().map(rule => rule.tasks)).toEqual([1, 1]);
});

test("split parts inherit the tasks behind a merged rule, with distinct tasks on paged reads", () => {
  const one = leave("first", "task-one");
  const two = leave("second", "task-two", "For translated changes, measure all locales at every supported width before review.");
  const pass = claimPass({ project: PROJECT, repoDir: root, now: NOW + 10 })!;
  applyCuration(pass, input({ [scope()]: [one] }, { merge: [{ into: one, from: [two], rule: RULE, note: "One rendered class across tasks." }] }), at(20));
  applyCuration(pass, input({ [scope()]: [one, `split:${one}:1`] }, { split: [{ id: one, note: "Separate viewport and locale checks while retaining both obligations.", parts: [
    { to: scope(), rule: "For rendered changes, measure every supported width before review." },
    { to: scope(), rule: "For translated changes, measure every supported language before review." },
  ] }] }), at(30));
  expect(active().map(rule => rule.tasks)).toEqual([2, 2]);
  const page = readCuration(pass, scope());
  if (!("rules" in page)) throw Error("scope page expected");
  expect(page.rules.filter(rule => rule.kind === "active").map(rule => rule.tasks)).toEqual([2, 2]);
  const brief = curatorBrief(PROJECT);
  for (const clause of ["different tasks wrote about one class", "tasks counts the tasks", "more tasks above one backed by fewer", "candidates for that role's template"]) expect(brief).toContain(clause);
});

test("another project's curator transfers a misfiled machine rule to its author and Undo restores it", () => {
  const source = request("misfiled", "task-one");
  const id = roleMemoryCollection(true)!.boundedPatch(4, tx => {
    const id = newRuleId(tx);
    tx.put({ kind: "rule", id, scope: "machine", state: "active", rule: "The locale list in config/supported-locales.js disagrees with the instructions.", why: WHY, hints: [], source, createdAt: at(), changedAt: at() });
    tx.put({ kind: "scope", scope: "machine", revision: 1, active: [id], history: [] });
    return id;
  });
  const pass = claimPass({ project: "another-curation-project", repoDir: root, now: NOW + 10 })!;
  const problem = { statement: "The supported locales disagree with the instructions.", evidence: "The required gate lists six locales and the instructions list four." };
  applyCuration(pass, input({ machine: [] }, { problem: [{ id, ...problem, note: "This is an observed project inconsistency." }] }), at(20));
  expect(row(id)).toMatchObject({ state: "archived", reason: "problem", problem });
  expect(memoryProblemSignals(PROJECT, [])).toHaveLength(1);
  expect(memoryProblemSignals("another-curation-project", [])).toEqual([]);
  patchPass(pass.id, { state: "succeeded", endedAt: at(30) });
  expect(revertCuratorPass(pass.id, at(40)).skipped).toEqual([]);
  expect(row(id).state).toBe("active");
  expect(row(id).problem).toBeUndefined();
  expect(memoryProblemSignals(PROJECT, [])).toEqual([]);
});

test("a newly created split part cannot file a concrete defect as a rule", () => {
  const id = leave("first", "task-one");
  const pass = claimPass({ project: PROJECT, repoDir: root, now: NOW + 10 })!;
  expect(() => applyCuration(pass, input({ [scope()]: [id, `split:${id}:1`] }, { split: [{ id, note: "Separate generic checks from concrete evidence.", parts: [
    { to: scope(), rule: RULE },
    { to: scope(), rule: "The locale list in config/supported-locales.js disagrees with the instructions." },
  ] }] }), at(20))).toThrow("answer problem");
  expect(active().map(rule => rule.id)).toEqual([id]);
  expect(row(id).rule).toBe(RULE);
});
