import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Every test here writes a private state directory; nothing reaches the operator's state. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-memory-store-"));
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { appendRule, codePoints, sameRule, scopeChars } = await import("./roleConsolidate");
const { deleteRule, learnedRulesBlock, leaveLessons, projectView, recordLessonRequest, restoreRule, stageLessons } = await import("./roleStore");
const { roleMemoryEnabled } = await import("./settings");
const { canonicalProject, persistProjectAliases } = await import("@/lib/projects/aliases");
const { insertLearnedRules, renderLearnedRules } = await import("./roleRender");
const { withLearnedRules } = await import("./roleLaunch");
const { ROLE_MEMORY_BOUND } = await import("./roleTypes");
type RoleMemoryRule = import("./roleTypes").RoleMemoryRule;

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

test("only a repeat of the same rule deduplicates: two obligations and a contradiction stay two rules", () => {
  const atomic = rule("r_atomic", "When a change writes to the database, put every write of one operation into a single atomic commit.");
  const retry = rule("r_retry", "When a change writes to the database, make every write of one operation safe to retry idempotently.");
  expect(sameRule(atomic.rule, retry.rule)).toBe(false);
  const two = appendRule([atomic], retry, "2026-10-07T12:00:00.000Z");
  expect(two.active.map((entry) => entry.id)).toEqual(["r_atomic", "r_retry"]);
  expect(two.merged).toEqual([]);
  const always = rule("r_always", "Run the full test suite of the project before every push to the remote branch.");
  const never = rule("r_never", "Never run the full test suite of the project before every push to the remote branch.");
  expect(appendRule([always], never, "2026-10-07T12:00:00.000Z").active.map((entry) => entry.id)).toEqual(["r_always", "r_never"]);
  /* The same words, cased, spaced and punctuated differently, are one rule: the one already injected stays. */
  const repeat = rule("r_repeat", "  when a change writes to the DATABASE, put every write of one operation into a single atomic commit ");
  const deduped = appendRule([atomic, retry], repeat, "2026-10-07T12:00:00.000Z");
  expect(deduped.active.map((entry) => entry.id)).toEqual(["r_atomic", "r_retry"]);
  expect(deduped.merged).toEqual([{ from: "r_repeat", into: "r_atomic" }]);
  expect(deduped.changed).toEqual([expect.objectContaining({ id: "r_repeat", state: "merged", reason: "duplicate", mergedInto: "r_atomic" })]);
});

test("a scope over 10 000 characters is consolidated under the bound, and the dropped rule stays visible in history", () => {
  const project = PROJECT();
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
  expect(learnedRulesBlock(project, "builder")).toContain("Role rules · Builder on this project");
  expect(learnedRulesBlock(project, "builder")).toContain("Learned rules (Delegatus role memory): 1 role · 0 project · 1 machine");
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

test("memory is always on; only the installation's kill switch stops it", () => {
  expect(roleMemoryEnabled()).toBe(true);
  process.env.LLV_ROLE_MEMORY = "off";
  try { expect(roleMemoryEnabled()).toBe(false); } finally { delete process.env.LLV_ROLE_MEMORY; }
  expect(roleMemoryEnabled()).toBe(true);
});

test("the operator removes one rule and puts it back: it stays a record, and the scope's history says who did what", () => {
  const project = PROJECT();
  const rule = "When a change adds a branch for empty input, write the test for that branch in the same commit.";
  const [left] = leaveLessons({ request: request(), source: source(), none: null, lessons: [{ scope: "role", rule, why: "An untested empty path failed review." }] }).left;
  deleteRule(left!.id, "2026-10-07T13:00:00.000Z");
  let builder = projectView(project).scopes.find((scope) => scope.roleId === "builder")!;
  expect(builder.active).toEqual([]);
  expect(builder.left).toEqual([expect.objectContaining({ id: left!.id, state: "archived", reason: "deleted" })]);
  expect(learnedRulesBlock(project, "builder")).not.toContain(rule);
  restoreRule(left!.id, "2026-10-07T13:00:05.000Z");
  builder = projectView(project).scopes.find((scope) => scope.roleId === "builder")!;
  expect(builder.active.map((entry) => entry.id)).toEqual([left!.id]);
  expect(builder.left).toEqual([]);
  expect(learnedRulesBlock(project, "builder")).toContain(rule);
  expect(() => deleteRule("r_00000000")).toThrow(/no such rule/);
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
  const section = learnedRulesBlock(project, "builder").split("\n\n").find((part) => part.startsWith("Role rules · Builder on this project"))!;
  const items = section.split("\n").filter((line) => line.startsWith("- ["));
  expect(items).toEqual([`- [${left[0]!.id}] ${first} Why: An untested empty path failed review.`, `- [${left[1]!.id}] ${second} Why: The driver died on a socket path limit.`]);
});

test("a generated id that is already taken is drawn again: no lesson is ever overwritten, within one call or across scopes", () => {
  const project = PROJECT();
  const real = crypto.randomBytes.bind(crypto);
  let forced = 3;
  /* The first three draws all return one value: the second lesson of the call and a later lesson elsewhere collide with the first. */
  const spy = spyOn(crypto, "randomBytes").mockImplementation(((size: number) => forced-- > 0 ? Buffer.alloc(size, 7) : real(size)) as typeof crypto.randomBytes);
  try {
    const first = "When a change adds a branch for empty input, write the test for that branch in the same commit.";
    const second = "Give a browser started from a pipeline stage a short temporary directory for its sockets.";
    const third = "Read the project's instruction files before changing anything the brief does not name.";
    const one = leaveLessons({ request: request(1), source: source(1), none: null, lessons: [
      { scope: "role", rule: first, why: "An untested empty path failed review." },
      { scope: "project", rule: second, why: "The driver died on a socket path limit." },
    ] }).left;
    forced = 1;
    const two = leaveLessons({ request: request(2), source: source(2), none: null, lessons: [{ scope: "machine", rule: third, why: "A fence was crossed." }] }).left;
    const ids = [...one, ...two].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(3);
    const view = projectView(project);
    const text = (id: string) => view.scopes.flatMap((scope) => scope.active).find((entry) => entry.id === id);
    expect(text(ids[0]!)).toMatchObject({ rule: first, stageId: "fix", roleId: "builder" });
    expect(text(ids[1]!)).toMatchObject({ rule: second });
    expect(text(ids[2]!)).toMatchObject({ rule: third });
    expect(stageLessons(project).flatMap((row) => row.rules.map((entry) => entry.rule)).sort()).toEqual([first, second, third].sort());
  } finally {
    spy.mockRestore();
  }
});

test("project succession keeps every stored rule, its history and the stage lines under both keys, within the bound", () => {
  const old = `dir-${PROJECT()}-old`;
  const current = `repo-${PROJECT()}-current`;
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike"];
  const text = (key: string, i: number) => `${key} rule ${i}: ${words.map((word, w) => `${word}${(i * 37 + w * 11) % 991}`).join(" ")} ${"x".repeat(180)}`.slice(0, 300);
  const fill = (project: string, key: string, from: number, rounds: number) => {
    const ids: string[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const attempt = from + round;
      const req = { pipelineId: `p-${key}`, stageId: "fix", attempt };
      recordLessonRequest({ ...req, project, roleId: "builder", conversationId: `conversation_${key}_${attempt}`, at: new Date(Date.UTC(2026, 9, 7, 0, attempt)).toISOString() });
      const left = leaveLessons({ request: req, source: { ...source(attempt), project, pipelineId: `p-${key}`, conversationId: `conversation_${key}_${attempt}` }, none: null,
        lessons: [0, 1, 2].map((k) => ({ scope: "role" as const, rule: text(key, attempt * 3 + k), why: `Round ${attempt} of ${key}.` })),
        now: new Date(Date.UTC(2026, 9, 7, 0, attempt)).toISOString() }).left;
      ids.push(...left.map((entry) => entry.id));
    }
    return ids;
  };
  /* Both keys already hold lessons, each close to the bound. */
  const oldIds = fill(old, "old", 1, 6);
  const removed = oldIds[oldIds.length - 1]!;
  deleteRule(removed, "2026-10-07T01:00:00.000Z");
  const currentIds = fill(current, "current", 20, 6);
  expect(projectView(old).scopes.find((scope) => scope.roleId === "builder")!.active.length).toBeGreaterThan(10);

  expect(persistProjectAliases([{ source: old, target: current, displayName: "succession" }])).toBe(true);
  expect(canonicalProject(old)).toBe(current);

  for (const key of [old, current]) {
    const block = learnedRulesBlock(key, "builder");
    const builder = projectView(key).scopes.find((scope) => scope.roleId === "builder")!;
    expect(builder.scope).toBe(`role:${current}:builder`);
    expect(builder.chars).toBeLessThanOrEqual(ROLE_MEMORY_BOUND);
    /* The newest rules of both keys are injected; what the bound pushed out and what the operator removed stay in history. */
    expect(block).toContain(oldIds[oldIds.length - 2]!);
    expect(block).toContain(currentIds[currentIds.length - 1]!);
    expect(block).not.toContain(removed);
    const everything = [...builder.active, ...builder.left].map((entry) => entry.id);
    for (const id of [...oldIds, ...currentIds]) expect(everything).toContain(id);
    expect(builder.left).toContainEqual(expect.objectContaining({ id: removed, reason: "deleted" }));
    expect(builder.left.some((entry) => entry.reason === "budget")).toBe(true);
    expect(projectView(key).scopes.filter((scope) => scope.roleId === "builder")).toHaveLength(1);
    const lines = stageLessons(key);
    expect(lines.some((row) => row.pipelineId === "p-old")).toBe(true);
    expect(lines.some((row) => row.pipelineId === "p-current")).toBe(true);
  }
  /* The removed rule comes back into the merged scope, which keeps its bound. */
  restoreRule(removed, "2026-10-07T02:00:00.000Z");
  const merged = projectView(current).scopes.find((scope) => scope.roleId === "builder")!;
  expect(merged.active.map((entry) => entry.id)).toContain(removed);
  expect(merged.chars).toBeLessThanOrEqual(ROLE_MEMORY_BOUND);
});

test("rules that differ only by an operator or a flag stay two active rules on append and on succession; a true repeat still merges", () => {
  const pairs = [
    ["Reject a value when x > 0.", "Reject a value when x < 0."],
    ["Run every gate script under set -x when it fails without output.", "Run every gate script under set +x when it fails without output."],
    ["Compare the two digests with === before trusting a cached baseline.", "Compare the two digests with !== before trusting a cached baseline."],
  ] as const;
  for (const [a, b] of pairs) expect(sameRule(a, b)).toBe(false);
  expect(sameRule("Reject a value when x > 0.", "  reject a value when X>0 ")).toBe(true);

  const project = PROJECT();
  const left = leaveLessons({ request: request(), source: source(), none: null, lessons: pairs[0].map((rule) => ({ scope: "role" as const, rule, why: "A sign was flipped in review." })) }).left;
  expect(left.map((entry) => entry.state)).toEqual(["active", "active"]);
  const repeat = leaveLessons({ request: request(2), source: source(2), none: null, lessons: [{ scope: "role", rule: "reject a value when x>0", why: "Seen again." }] }).left[0]!;
  expect(repeat).toMatchObject({ state: "merged", mergedInto: left[0]!.id });
  const block = learnedRulesBlock(project, "builder");
  expect(block).toContain("x > 0");
  expect(block).toContain("x < 0");

  /* Succession joins a moved key's scope into the current one by the same comparison. */
  const old = `dir-${project}-flags-old`;
  const current = `repo-${project}-flags-current`;
  const leave = (key: string, attempt: number, rule: string) => {
    const req = { pipelineId: `p-${key}`, stageId: "fix", attempt };
    recordLessonRequest({ ...req, project: key, roleId: "builder", conversationId: `conversation_${key}_${attempt}`, at: "2026-10-07T12:00:00.000Z" });
    return leaveLessons({ request: req, source: { ...source(attempt), project: key, pipelineId: req.pipelineId, conversationId: `conversation_${key}_${attempt}` }, none: null,
      lessons: [{ scope: "role", rule, why: "A flag was flipped in review." }], now: new Date(Date.UTC(2026, 9, 7, 1, attempt)).toISOString() }).left[0]!;
  };
  const x = leave(old, 1, pairs[1][0]);
  const plus = leave(current, 2, pairs[1][1]);
  const again = leave(current, 3, pairs[1][0].toUpperCase());
  expect(persistProjectAliases([{ source: old, target: current, displayName: "flags" }])).toBe(true);
  const builder = projectView(current).scopes.find((scope) => scope.roleId === "builder")!;
  expect(builder.active.map((entry) => entry.id)).toEqual([x.id, plus.id]);
  expect(builder.left).toContainEqual(expect.objectContaining({ id: again.id, state: "merged", reason: "duplicate", mergedInto: x.id }));
});
