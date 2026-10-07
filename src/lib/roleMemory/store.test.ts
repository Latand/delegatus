import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Every test here writes a private state directory; nothing reaches the operator's state. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-memory-store-"));
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { appendRule, codePoints, nearDuplicate, scopeChars } = await import("./consolidate");
const { learnedRulesBlock, leaveLessons, projectView, recordLessonRequest, roleMemoryEnabled, setRoleMemoryEnabled, stageLessons } = await import("./store");
const { insertLearnedRules, renderLearnedRules } = await import("./render");
const { withLearnedRules } = await import("./launch");
const { ROLE_MEMORY_BOUND } = await import("./types");
type RoleMemoryRule = import("./types").RoleMemoryRule;

let n = 0;
const PROJECT = () => `project-${n}`;
beforeEach(() => { n += 1; });

const source = (attempt = 1) => ({ project: PROJECT(), pipelineId: `p${n}`, stageId: "fix", attempt, roleId: "builder", fixRound: true, conversationId: `conversation_${n}_${attempt}` });
function request(attempt = 1) {
  recordLessonRequest({ pipelineId: `p${n}`, stageId: "fix", attempt, project: PROJECT(), roleId: "builder", conversationId: `conversation_${n}_${attempt}`, at: "2026-10-07T12:00:00.000Z" });
  return { pipelineId: `p${n}`, stageId: "fix", attempt };
}
const rule = (id: string, text: string, createdAt = "2026-10-07T10:00:00.000Z"): RoleMemoryRule => ({
  kind: "rule", id, scope: "role:x:builder", rule: text, why: "it cost a review round", state: "active", hints: [],
  source: source(), createdAt, changedAt: createdAt,
});

test("the bound counts code points, so a Ukrainian rule costs what an English one does", () => {
  const en = rule("r_1", "a".repeat(200));
  const uk = rule("r_1", "я".repeat(200));
  expect(scopeChars([uk])).toBe(scopeChars([en]));
  expect(codePoints("я🙂")).toBe(2);
});

test("a lesson that restates an active rule merges with it, and the fuller text survives", () => {
  const older = rule("r_old", "Write the test for an empty input branch in the same commit as the branch.");
  const fuller = rule("r_new", "Write the test for an empty, missing or zero input branch in the same commit as the branch itself.");
  expect(nearDuplicate(older.rule, fuller.rule)).toBe(true);
  expect(nearDuplicate(older.rule, "Give a browser started from a stage a short temporary directory.")).toBe(false);
  const outcome = appendRule([older], fuller, "2026-10-07T12:00:00.000Z");
  expect(outcome.active.map((entry) => entry.id)).toEqual(["r_new"]);
  expect(outcome.merged).toEqual([{ from: "r_old", into: "r_new" }]);
  expect(outcome.changed.find((entry) => entry.id === "r_old")).toMatchObject({ state: "merged", reason: "duplicate", mergedInto: "r_new" });
  const shorter = appendRule([fuller], rule("r_short", older.rule), "2026-10-07T12:00:00.000Z");
  expect(shorter.active.map((entry) => entry.id)).toEqual(["r_new"]);
  expect(shorter.changed).toEqual([expect.objectContaining({ id: "r_short", state: "merged", mergedInto: "r_new" })]);
});

test("a scope over 10 000 characters is consolidated under the bound, and the dropped rule stays visible in history", () => {
  const project = PROJECT();
  setRoleMemoryEnabled(project, true);
  const distinct = (i: number) => `Rule ${i}: ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu"].map((word, w) => `${word}${(i * 31 + w * 7) % 997}`).join(" ")}`.slice(0, 300);
  let attempt = 0;
  let firstId = "";
  let firstArchived = false;
  while (!firstArchived && attempt < 100) {
    attempt += 1;
    const left = leaveLessons({ request: request(attempt), source: source(attempt), lessons: [{ scope: "role", rule: distinct(attempt), why: `Round ${attempt} taught it.` }], none: null, now: new Date(Date.UTC(2026, 9, 7, 0, attempt)).toISOString() }).left[0]!;
    if (attempt === 1) firstId = left.id;
    expect(left.scopeChars).toBeLessThanOrEqual(ROLE_MEMORY_BOUND);
    firstArchived = left.archived.includes(firstId);
  }
  expect(firstArchived).toBe(true);
  const builder = projectView(project).scopes.find((scope) => scope.roleId === "builder")!;
  expect(builder.chars).toBeLessThanOrEqual(ROLE_MEMORY_BOUND);
  expect(builder.active.some((entry) => entry.id === firstId)).toBe(false);
  expect(builder.left).toContainEqual(expect.objectContaining({ id: firstId, state: "archived", reason: "budget" }));
  expect(learnedRulesBlock(project, "builder")).not.toContain(firstId);
});

test("lessons join their scopes at once, with the source the server resolved, and the card reads them per attempt", () => {
  const project = PROJECT();
  const req = request();
  const result = leaveLessons({ request: req, source: source(), none: null, lessons: [
    { scope: "role", rule: "When a change adds a branch for empty input, write its test in the same commit.", why: "Review failed on an untested empty path." },
    { scope: "role", role: "visual-critic", rule: "Judge the narrow Ukrainian frame first; long labels clip there before anywhere else.", why: "A label clipped only at phone width." },
    { scope: "machine", rule: "Give a browser started from a stage a short temporary directory for its sockets.", why: "The driver died on a socket path limit." },
  ] });
  expect(result.left.map((entry) => entry.scope)).toEqual([`role:${project}:builder`, `role:${project}:visual-critic`, "machine"]);
  expect(learnedRulesBlock(project, "builder")).toContain("When a change adds a branch for empty input");
  expect(learnedRulesBlock(project, "builder")).toContain("Builder · this project");
  expect(learnedRulesBlock(project, "builder")).not.toContain("Judge the narrow Ukrainian frame");
  expect(learnedRulesBlock(project, "visual-critic")).toContain("Judge the narrow Ukrainian frame");
  expect(learnedRulesBlock(`${project}-other`, "builder")).toContain("short temporary directory");
  expect(stageLessons(project)).toEqual([expect.objectContaining({ pipelineId: req.pipelineId, stageId: "fix", attempt: 1, rules: [
    expect.objectContaining({ scope: "role", roleId: "builder" }), expect.objectContaining({ scope: "role", roleId: "visual-critic" }), expect.objectContaining({ scope: "machine", roleId: null }),
  ] })]);
  expect(() => leaveLessons({ request: req, source: source(), none: null, lessons: [{ scope: "project", rule: "One more rule that would be the fourth lesson.", why: "limit" }] })).toThrow(/at most 3/);
  expect(() => leaveLessons({ request: { ...req, attempt: 9 }, source: source(9), none: null, lessons: [] })).toThrow(/not asked/);
});

test("privacy hints mark a lesson and never refuse it", () => {
  request();
  /* A synthetic home path, assembled so the tree itself carries none. */
  const homePath = ["", "home", "somebody", "fixtures"].join("/");
  const left = leaveLessons({ request: request(), source: source(), none: null, lessons: [{ scope: "project", rule: `Read the fixture under ${homePath} before the run starts.`, why: "A path was missing." }] }).left[0]!;
  expect(left.hints).toContain("home_path");
  expect(left.state).toBe("active");
});

test("the switch is off for a project nobody switched on, and holds what the operator set", () => {
  const project = PROJECT();
  expect(roleMemoryEnabled(project)).toBe(false);
  setRoleMemoryEnabled(project, true);
  expect(roleMemoryEnabled(project)).toBe(true);
  setRoleMemoryEnabled(project, false);
  expect(roleMemoryEnabled(project)).toBe(false);
});

test("the block goes below the brief and above the controller's lines, and an oversized one is a file outside the checkout", () => {
  const prompt = ["Do the work.", "", "Role prompt scaffold:", "Builder guidance", "Design and UI stages publish variants with publish_prototype_review; …", "Report this stage's completion with the Delegatus MCP tool stage_report: …"].join("\n");
  const block = renderLearnedRules([{ scope: "machine", rules: [rule("r_a", "Give a browser started from a stage a short temporary directory.")] }]);
  const inline = withLearnedRules(prompt, block);
  expect(inline.indexOf("Builder guidance")).toBeLessThan(inline.indexOf("Learned rules"));
  expect(inline.indexOf("Learned rules")).toBeLessThan(inline.indexOf("Design and UI stages"));
  expect(insertLearnedRules("No anchors here.", block)).toBe(`No anchors here.\n\n${block}`);
  const huge = renderLearnedRules([{ scope: "machine", rules: Array.from({ length: 120 }, (_, i) => rule(`r_${i}`, `${"я".repeat(150)} ${i}`)) }]);
  const pointed = withLearnedRules(prompt, huge);
  expect(Buffer.byteLength(pointed)).toBeLessThanOrEqual(32_000);
  const file = /in the file (\S+)\. Read the full file/.exec(pointed)?.[1];
  expect(file?.startsWith(path.join(sandbox, "role-memory", "launch") + path.sep)).toBe(true);
  expect(fs.readFileSync(file!, "utf8")).toBe(huge);
  expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
  expect(withLearnedRules(prompt, null)).toBe(prompt);
});

test("two lessons stay two records with their own ids and render as two items, never one block of text", () => {
  /* Operator, 2026-10-07: «чтобы вот эти памяти, они были как отдельными фрагментами, не одна сплошная 10 000, а отдельные отрезки». */
  const project = PROJECT();
  const first = "When a change adds a branch for empty input, write the test for that branch in the same commit.";
  const second = "Give a browser started from a pipeline stage a short temporary directory for its sockets.";
  const { left } = leaveLessons({ request: request(), source: source(), none: null, lessons: [
    { scope: "role", rule: first, why: "An untested empty path failed review." },
    { scope: "role", rule: second, why: "The driver died on a socket path limit." },
  ] });
  expect(left).toHaveLength(2);
  expect(left[0]!.id).not.toBe(left[1]!.id);
  const builder = projectView(project).scopes.find((scope) => scope.roleId === "builder")!;
  expect(builder.active.map((rule) => [rule.id, rule.rule])).toEqual([[left[0]!.id, first], [left[1]!.id, second]]);
  expect(builder.active.every((rule) => rule.roleId === "builder" && rule.stageId === "fix")).toBe(true);
  /* The builder's own section; the machine scope is shared with the other tests in this file. */
  const section = learnedRulesBlock(project, "builder").split("\n\n").find((part) => part.startsWith("Builder · this project"))!;
  const items = section.split("\n").filter((line) => line.startsWith("- ["));
  expect(items).toEqual([`- [${left[0]!.id}] ${first} Why: An untested empty path failed review.`, `- [${left[1]!.id}] ${second} Why: The driver died on a socket path limit.`]);
});
