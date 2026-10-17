import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-memory-launch-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const { composeStageInput } = await import("@/lib/pipelines/stageInput");
const { resolveStageTestGuidance } = await import("@/lib/pipelines/testGuidance");
const { renderStagePrompt } = await import("@/lib/pipelines/prompts");
const { buildPipeline } = await import("@/lib/pipelines/store");
const { realExec } = await import("@/lib/workflows/provision");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { claudeStructuredHostOptions } = await import("@/lib/runtime/structuredSpawn");
const { MAX_STRUCTURED_TEXT_BYTES } = await import("@/lib/runtime/structuredContent");
const { activeRules, leaveLessons, recordLessonRequest } = await import("./roleStore");
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

for (const language of ["en", "uk"] as const) test(`a full ${language} stage prompt keeps every rule in its engine channel and creates no rule file`, async () => {
  const project = `launch-${language}`;
  let attempt = 0;
  for (const scope of ["role", "project", "machine"] as const) {
    for (let n = 0; n < 31; n++) {
      const source = { project, pipelineId: project, stageId: "build", attempt: ++attempt, roleId: "builder", fixRound: false, conversationId: `conversation_fixture_${attempt}` };
      recordLessonRequest({ ...source, at: "2026-10-11T00:00:00.000Z" });
      const rule = `${scope} ${n}: ${(language === "en" ? "words " : "літери ").repeat(60)}`.slice(0, 300);
      leaveLessons({ request: source, source, lessons: [{ scope, rule, why: "A previous stage used an unowned acknowledgement." }], none: null });
    }
  }
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Build {{task}} from {{prev.output}}", next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Builder guidance." } };
  const pipeline = buildPipeline({ id: project, task: "the task", spec: "Keep all the rules", project, repoDir: "/repo", stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = checkout;
  const guidance = resolveStageTestGuidance();
  const base = Buffer.byteLength(renderStagePrompt(pipeline, stage, stage.effectiveRole, "a", undefined, guidance)) - 1;
  const previous = "a".repeat(MAX_STRUCTURED_TEXT_BYTES - base);
  const expected = renderStagePrompt(pipeline, stage, stage.effectiveRole, previous, undefined, guidance);
  expect(Buffer.byteLength(expected)).toBe(MAX_STRUCTURED_TEXT_BYTES);
  const message = await composeStageInput(pipeline, stage, stage.effectiveRole, previous, checkout, realExec);
  expect(message).toBe(expected);
  const profile = emptyLaunchProfile({ cwd: checkout, learnedRules: { project, roleId: "builder" } });
  const options = await claudeStructuredHostOptions({ spec: { cwd: checkout, launchProfile: profile }, account: { home: sandbox, kind: "managed" } } as never, { env: {}, host: {} } as never);
  for (const scope of [`role:${project}:builder`, `project:${project}`, "machine"]) {
    expect(activeRules(scope).length).toBeGreaterThan(25);
    for (const rule of activeRules(scope)) {
      expect(options.appendSystemPrompt).toContain(`- [${rule.id}] ${rule.rule}`);
      expect(message).not.toContain(rule.rule);
      expect(JSON.stringify(profile)).not.toContain(rule.rule);
    }
  }
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "role-memory", "launch"))).toBe(false);
}, 60_000);

test("each clean engine start durably records its empty delivery", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const directory = path.join(sandbox, "empty-delivery-state");
  process.env.LLV_STATE_DIR = directory;
  try {
    const { learnedRulesForLaunchProfile } = await import("./roleLaunch");
    expect(await learnedRulesForLaunchProfile({ cleanMemory: true }, { engine: "codex", conversationId: "conversation_empty_start", cwd: checkout, home: sandbox })).toBeUndefined();
    expect(fs.existsSync(path.join(directory, "role-memory", "delivery.sqlite"))).toBe(true);
  } finally { process.env.LLV_STATE_DIR = previous; }
});
