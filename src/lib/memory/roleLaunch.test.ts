import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* A brief at the structured envelope's bound still launches with its learned
   rules, through the real renderer and composer: the composer leaves room for
   the pointer to the rules file, and no rule text lands in the checkout. The
   state directory and the checkout are private to this file. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-memory-launch-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { composeStageInput } = await import("@/lib/pipelines/stageInput");
const { renderStagePrompt } = await import("@/lib/pipelines/prompts");
const { buildPipeline } = await import("@/lib/pipelines/store");
const { realExec } = await import("@/lib/workflows/provision");
const { MAX_STRUCTURED_TEXT_BYTES } = await import("@/lib/runtime/structuredContent");
const { learnedRulesBlock, leaveLessons, recordLessonRequest } = await import("./roleStore");
const { learnedRulesReserve, withLearnedRules } = await import("./roleLaunch");
const { ROLE_MEMORY_BOUND, RULE_MAX_CHARS, WHY_MAX_CHARS } = await import("./roleTypes");
type PipelineStage = import("@/lib/pipelines/types").PipelineStage;

const checkout = path.join(sandbox, "worktree");
fs.mkdirSync(checkout);
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};
git("init", "--initial-branch=main");
git("config", "user.email", "pipeline-test");
git("config", "user.name", "Pipeline Test");
git("config", "commit.gpgSign", "false");
fs.writeFileSync(path.join(checkout, "tracked.txt"), "base\n");
git("add", "tracked.txt");
git("commit", "-m", "base");

function fixture(project: string) {
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Build {{task}} from {{prev.output}}", next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Builder guidance." } };
  const pipeline = buildPipeline({ id: `launch-${project}`, task: "the task", spec: "AC: keep the rules", project, repoDir: "/repo",
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = checkout;
  return { pipeline, stage };
}

/** Fills the role, project and machine scopes to their bound with distinct lessons in one language. */
function fill(project: string, language: "en" | "uk"): string[] {
  const letters = language === "uk" ? "абвгдежзиклмнопрстуфхцчшщюя" : "abcdefghijklmnopqrstuvwxyz";
  const word = (i: number, w: number) => Array.from({ length: 6 }, (_, k) => letters[(i * 7 + w * 3 + k * 5) % letters.length]).join("");
  const text = (i: number, max: number) => Array.from({ length: 60 }, (_, w) => word(i, w)).join(" ").slice(0, max - 6) + ` ${String(i).padStart(4, "0")}`;
  const rules: string[] = [];
  let attempt = 0;
  for (const scope of ["role", "project", "machine"] as const) {
    for (let round = 0; round < 8; round += 1) {
      attempt += 1;
      const request = { pipelineId: `p-${project}`, stageId: "fix", attempt };
      recordLessonRequest({ ...request, project, roleId: "builder", conversationId: `conversation_${project}_${attempt}`, at: "2026-10-07T12:00:00.000Z" });
      const lessons = [0, 1, 2].map((k) => ({ scope, rule: text(attempt * 3 + k, RULE_MAX_CHARS), why: text(attempt * 3 + k + 1000, WHY_MAX_CHARS) }));
      rules.push(...lessons.map((lesson) => lesson.rule));
      leaveLessons({ request, source: { project, pipelineId: request.pipelineId, stageId: "fix", attempt, roleId: "builder", fixRound: true, conversationId: `conversation_${project}_${attempt}` }, lessons, none: null });
    }
  }
  return rules;
}

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : entry.isFile() ? [full] : [];
  });
}

for (const language of ["en", "uk"] as const) test(`a ${language} brief at and near the envelope bound keeps its learned rules and writes none into the checkout`, async () => {
  const project = `launch-${language}`;
  const rules = fill(project, language);
  const block = learnedRulesBlock(project, "builder");
  /* Every scope is at its bound: the block is several times what a message holds. */
  expect(Buffer.byteLength(block)).toBeGreaterThan(3 * ROLE_MEMORY_BOUND * 0.8);
  const { pipeline, stage } = fixture(project);
  const base = Buffer.byteLength(renderStagePrompt(pipeline, stage, stage.effectiveRole, "a")) - 1;
  const reserve = learnedRulesReserve(block);
  for (const short of [0, 1, 37, reserve - 1, reserve, reserve + 1, 2_000]) {
    const previous = "a".repeat(MAX_STRUCTURED_TEXT_BYTES - short - base);
    expect(Buffer.byteLength(renderStagePrompt(pipeline, stage, stage.effectiveRole, previous))).toBe(MAX_STRUCTURED_TEXT_BYTES - short);
    /* Composed without the room, a message at the bound cannot carry its rules: the launch is refused, never sent without them. */
    if (short < reserve) expect(() => withLearnedRules(withoutReserve(previous), block)).toThrow(/no room for its learned rules/);
    const composed = await composeStageInput(pipeline, stage, stage.effectiveRole, previous, checkout, realExec, reserve);
    const message = withLearnedRules(composed, block);
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES);
    const file = /Learned rules \(Delegatus role memory\): in the file (\S+)\. Read the full file/.exec(message)?.[1];
    expect(file).toBeDefined();
    expect(fs.readFileSync(file!, "utf8")).toBe(block);
    expect(file!.startsWith(path.join(process.env.LLV_STATE_DIR!, "role-memory") + path.sep)).toBe(true);
  }
  const checkoutText = filesUnder(checkout).filter((file) => !file.includes(`${path.sep}.git${path.sep}objects`)).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const rule of rules.slice(-6)) expect(checkoutText).not.toContain(rule);

  function withoutReserve(previous: string): string {
    return renderStagePrompt(pipeline, stage, stage.effectiveRole, previous);
  }
}, 60_000);

test("a small block near the bound goes inline when it fits and as the pointer when it does not", async () => {
  const project = "launch-small";
  const request = { pipelineId: "p-small", stageId: "fix", attempt: 1 };
  recordLessonRequest({ ...request, project, roleId: "builder", conversationId: "conversation_small", at: "2026-10-07T12:00:00.000Z" });
  const rule = "When a change adds a branch for empty input, write the test for that branch in the same commit.";
  leaveLessons({ request, source: { project, pipelineId: "p-small", stageId: "fix", attempt: 1, roleId: "builder", fixRound: true, conversationId: "conversation_small" }, lessons: [{ scope: "role", rule, why: "An untested empty path failed review." }], none: null });
  const block = learnedRulesBlock(project, "builder");
  const { pipeline, stage } = fixture(project);
  const base = Buffer.byteLength(renderStagePrompt(pipeline, stage, stage.effectiveRole, "a")) - 1;
  const reserve = learnedRulesReserve(block);
  for (const short of [0, reserve, Buffer.byteLength(block) + 10_000]) {
    const previous = "a".repeat(MAX_STRUCTURED_TEXT_BYTES - short - base);
    const message = withLearnedRules(await composeStageInput(pipeline, stage, stage.effectiveRole, previous, checkout, realExec, reserve), block);
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES);
    expect(message.includes(rule) || /in the file \S+\. Read the full file/.test(message)).toBe(true);
  }
});
