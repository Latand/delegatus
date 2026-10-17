import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { leaveLessons, projectView, recordLessonRequest, roleScope, roleMemoryCollection, learnedRulesBlock, lessonKnownValuesFile } from "./roleStore";
import { codePoints, ruleLine } from "./roleConsolidate";
import { CURATION_INTERVAL_MS, ROLE_MEMORY_BOUND } from "./roleTypes";
import type { StageRuleSource as RuleSource } from "./roleTypes";
import { applyCuration, revertCuratorPass } from "./curation/apply";
import { claimPass, patchPass } from "./curation/store";

const PROJECT = "review-lessons";
const RULE = "For rendered changes, check every supported width, theme and language before the first review.";
const REVISED = "For rendered changes, enumerate every supported width, theme and language and measure each combination before the first review.";
const WHY = "Review caught a missing combination in the rendered checks.";
let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.LLV_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-review-lessons-"));
  process.env.LLV_STATE_DIR = root;
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Run the repository checks before publication.\n");
});

afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function request(lane: string, taskId?: string, attempt = 1, at = "2026-10-12T06:00:00.000Z"): RuleSource {
  const source: RuleSource = { project: PROJECT, pipelineId: lane, stageId: "fix", attempt, roleId: "builder", fixRound: true, conversationId: `conversation_${lane}` };
  recordLessonRequest({ ...source, ...(taskId ? { taskId } : {}), at });
  return source;
}
function leave(source: RuleSource, rule = RULE, now?: string) {
  return leaveLessons({ request: source, source, lessons: [{ scope: "role", rule, why: WHY }], none: null, ...(now ? { now } : {}) }).left[0];
}
function rewrite(source: RuleSource, id: string) {
  return leaveLessons({ request: source, source, lessons: [], rewrite: { id, rule: REVISED, why: WHY }, none: null });
}
function builder() { return projectView(PROJECT).scopes.find(scope => scope.scope === roleScope(PROJECT, "builder"))!; }

test("two tasks rewriting one class produce one role-template candidate", () => {
  const one = leave(request("lane-one", "task-one"));
  rewrite(request("lane-two", "task-two"), one.id);
  const rules = builder().active;
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ id: one.id, rule: REVISED, tasks: 2 });
  expect(projectView(PROJECT).scopes.filter(scope => scope.kind === "role").flatMap(scope => scope.active).filter(rule => (rule.tasks ?? 0) >= 2)).toHaveLength(1);
});

test("duplicates from two tasks produce one candidate; two lanes of one task do not", () => {
  const one = leave(request("lane-one", "task-one"));
  const repeat = leave(request("lane-two", "task-two"));
  expect(repeat.mergedInto).toBe(one.id);
  expect(builder().active).toHaveLength(1);
  expect(builder().active[0].tasks).toBe(2);
  const other = leave(request("lane-three", "task-three"), "Before changing a delivery boundary, prove its recovery after a restart.");
  rewrite(request("lane-four", "task-three"), other.id);
  expect(builder().active.find(rule => rule.id === other.id)?.tasks).toBe(1);
  expect(builder().active.filter(rule => (rule.tasks ?? 0) >= 2)).toHaveLength(1);
});

test("a post-split rewrite adds recurrence only to the first part", () => {
  const scope = roleScope(PROJECT, "builder");
  const source = request("split-source", "task-a");
  const combined = leave(source, "For rendered changes, check every width and language before the first review.");
  const pass = claimPass({ project: PROJECT, repoDir: root, now: Date.parse("2026-10-12T06:01:00.000Z") });
  if (!pass) throw Error("curation pass was not admitted");
  const splitAt = "2026-10-12T06:01:00.000Z";
  const split = applyCuration(pass, {
    scopes: [{ scope, revision: projectView(PROJECT).scopes.find(item => item.scope === scope)!.revision, order: [combined.id, `split:${combined.id}:1`] }],
    split: [{ id: combined.id, note: "Width and language checks apply independently.", parts: [
      { to: scope, rule: "For rendered changes, check every supported width before the first review." },
      { to: scope, rule: "For rendered changes, check every supported language before the first review." },
    ] }],
  }, splitAt);
  const language = split.placeholders[`split:${combined.id}:1`]!;
  patchPass(pass.id, { state: "succeeded", endedAt: splitAt });

  const later = request("width-followup", "task-b", 1, "2026-10-12T06:02:00.000Z");
  rewrite(later, combined.id);

  const active = builder().active;
  expect(active.find(rule => rule.id === combined.id)?.tasks).toBe(2);
  expect(active.find(rule => rule.id === language)?.tasks).toBe(1);
  expect(active.filter(rule => (rule.tasks ?? 0) >= 2)).toHaveLength(1);
});

test("a merge after a split credits only its target and Undo restores both task counts", () => {
  const scope = roleScope(PROJECT, "builder");
  const combined = leave(request("split-merge-source", "task-a"), "For rendered changes, check every width and language before the first review.");
  const independent = leave(request("split-merge-independent", "task-c"), "Measure every viewport width before approving a rendered change.");
  const splitPass = claimPass({ project: PROJECT, repoDir: root, now: Date.parse("2026-10-12T06:01:00.000Z") });
  if (!splitPass) throw Error("split curation pass was not admitted");
  const splitAt = "2026-10-12T06:01:00.000Z";
  const split = applyCuration(splitPass, {
    scopes: [{ scope, revision: builder().revision, order: [combined.id, `split:${combined.id}:1`, independent.id] }],
    split: [{ id: combined.id, note: "Width and language checks apply independently.", parts: [
      { to: scope, rule: "For rendered changes, check each supported width before the first review." },
      { to: scope, rule: "For rendered changes, check each supported language before the first review." },
    ] }],
  }, splitAt);
  const language = split.placeholders[`split:${combined.id}:1`]!;
  patchPass(splitPass.id, { state: "succeeded", endedAt: splitAt });

  const mergeAt = new Date(Date.parse(splitAt) + CURATION_INTERVAL_MS).toISOString();
  const mergePass = claimPass({ project: PROJECT, repoDir: root, now: Date.parse(mergeAt) });
  if (!mergePass) throw Error("merge curation pass was not admitted");
  applyCuration(mergePass, {
    scopes: [{ scope, revision: builder().revision, order: [combined.id, language] }],
    merge: [{ into: combined.id, from: [independent.id], note: "The width rule covers the same obligation.", rule: "For rendered changes, check each width and measure it before the first review." }],
  }, mergeAt);
  patchPass(mergePass.id, { state: "succeeded", endedAt: mergeAt });

  const candidates = builder().active.filter(rule => (rule.tasks ?? 0) >= 2);
  expect(builder().active.find(rule => rule.id === combined.id)?.tasks).toBe(2);
  expect(builder().active.find(rule => rule.id === language)?.tasks).toBe(1);
  expect(candidates.map(rule => rule.id)).toEqual([combined.id]);

  revertCuratorPass(mergePass.id, new Date(Date.parse(mergeAt) + 1).toISOString());
  expect(builder().active.find(rule => rule.id === combined.id)?.tasks).toBe(1);
  expect(builder().active.find(rule => rule.id === language)?.tasks).toBe(1);
  expect(builder().active.filter(rule => (rule.tasks ?? 0) >= 2)).toEqual([]);
});

test("a merge that predates a split remains inherited by every split part", () => {
  const scope = roleScope(PROJECT, "builder");
  const originalRule = "For rendered changes, check every width and language before the first review.";
  const source = request("pre-split-source", "task-a", 1, "2026-10-12T06:00:00.000Z");
  const combined = leave(source, originalRule, "2026-10-12T06:00:00.000Z");
  const repeated = request("pre-split-repeat", "task-b", 1, "2026-10-12T06:00:30.000Z");
  const merged = leave(repeated, originalRule, "2026-10-12T06:00:30.000Z");
  expect(merged.mergedInto).toBe(combined.id);

  const splitPass = claimPass({ project: PROJECT, repoDir: root, now: Date.parse("2026-10-12T06:01:00.000Z") });
  if (!splitPass) throw Error("split curation pass was not admitted");
  const split = applyCuration(splitPass, {
    scopes: [{ scope, revision: builder().revision, order: [combined.id, `split:${combined.id}:1`] }],
    split: [{ id: combined.id, note: "Both parts retain the source evidence.", parts: [
      { to: scope, rule: "For rendered changes, check every width before the first review." },
      { to: scope, rule: "For rendered changes, check every language before the first review." },
    ] }],
  }, "2026-10-12T06:01:00.000Z");
  patchPass(splitPass.id, { state: "succeeded", endedAt: "2026-10-12T06:01:00.000Z" });
  const language = split.placeholders[`split:${combined.id}:1`]!;
  expect(builder().active.find(rule => rule.id === combined.id)?.tasks).toBe(2);
  expect(builder().active.find(rule => rule.id === language)?.tasks).toBe(2);
});

test("legacy request rows count pipelines, including repeated attempts of that pipeline", () => {
  const one = leave(request("legacy"));
  rewrite(request("legacy", undefined, 2), one.id);
  expect(builder().active[0].tasks).toBe(1);
  leave(request("another-legacy"), REVISED);
  expect(builder().active[0].tasks).toBe(2);
});

test.each(["uncurated", "curated", "operator-kept"])("an agent rewrite refreshes retention only for an %s rule", retention => {
  const target = leave(request("old", "task-one"));
  const collection = roleMemoryCollection()!;
  const stored = collection.get(`r:${target.id}`);
  if (stored?.kind !== "rule") throw Error("rule missing");
  if (retention !== "uncurated") collection.boundedPatch(2, tx => tx.put({ ...stored, ...(retention === "curated" ? { curatedAt: stored.createdAt } : { keptByOperatorAt: stored.createdAt }) }));
  const filler = `Check a boundary ${"before publishing ".repeat(16)}`.slice(0, 300);
  const cost = codePoints(ruleLine({ ...stored, rule: filler }));
  // Leave room for the expanded text, but not for one more full rule.
  const capacity = Math.floor((ROLE_MEMORY_BOUND - codePoints(ruleLine({ ...stored, rule: REVISED }))) / cost);
  const newer: string[] = [];
  for (let n = 0; n < capacity; n++) {
    const id = leave(request(`fill-${n}`, `fill-task-${n}`), `${filler.slice(0, 295)} ${n}`).id;
    newer.push(id);
    const row = collection.get(`r:${id}`);
    if (n > 0 && row?.kind === "rule") collection.boundedPatch(1, tx => tx.put({ ...row, curatedAt: row.createdAt }));
  }
  expect(builder().active.some(rule => rule.id === target.id)).toBe(true);
  const before = builder().active.map(rule => rule.id);
  rewrite(request("again", "task-two"), target.id);
  expect(builder().active.map(rule => rule.id)).toEqual(retention === "uncurated" ? [newer[0], target.id, ...before.filter(id => id !== target.id && id !== newer[0])] : before);
  leave(request("next", "task-next"), `Check a different boundary ${"before releasing ".repeat(17)}`.slice(0, 300));
  const after = builder();
  expect(after.active.some(rule => rule.id === target.id)).toBe(true);
  expect(after.left.some(rule => newer.includes(rule.id) && rule.reason === "budget")).toBe(true);
  if (retention === "uncurated") expect(learnedRulesBlock(PROJECT, "builder").indexOf(target.id)).toBeLessThan(learnedRulesBlock(PROJECT, "builder").indexOf(newer[0]));
});

test("privacy hints and known values survive a fix-round lesson and rewrite", () => {
  const email = ["fixture", "mail.example"].join("@");
  const home = ["", "home", "fixture", "text"].join("/");
  const one = leave(request("private", "task-one"), `Read fixture input from ${home} and contact ${email} before checking its shape.`);
  expect(one.hints).toEqual(expect.arrayContaining(["home_path", "email_address"]));
  const revised = `Check fixture input from ${home} and contact ${email} before reading its shape.`;
  const source = request("private-again", "task-two");
  const left = leaveLessons({ request: source, source, lessons: [], rewrite: { id: one.id, rule: revised, why: WHY }, none: null }).left[0];
  expect(left.hints).toEqual(expect.arrayContaining(["home_path", "email_address"]));
  expect(fs.readFileSync(lessonKnownValuesFile(), "utf8")).toContain(revised);
});
