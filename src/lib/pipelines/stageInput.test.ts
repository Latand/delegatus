import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeStageInput, composeStageText } from "./stageInput";
import { TaskPageWorker } from "@/lib/links/taskPageWorker";
import { leaveSeatLessons, recordLessonRequest, roleMemoryCollection, storedLessonRevision, withoutStoredLessons } from "@/lib/memory/roleStore";
import { hardenedRedact, BEARER_TOKEN } from "@/lib/view/compactText";
import { resolveStageTestGuidance } from "./testGuidance";
import { commitPipelineStage } from "./git";
import { buildPipeline } from "./store";
import type { PipelineStage } from "./types";
import { realExec } from "@/lib/workflows/provision";
import * as provision from "@/lib/workflows/provision";

const artifactState = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-inputs-"));
const laneRoot = path.join(artifactState, "worktree");
fs.mkdirSync(laneRoot);
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: laneRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
};
git("init", "--initial-branch=main");
git("config", "user.email", "pipeline-test");
git("config", "user.name", "Pipeline Test");
git("config", "commit.gpgSign", "false");
fs.writeFileSync(path.join(laneRoot, "tracked.txt"), "base\n");
git("add", "tracked.txt");
git("commit", "-m", "base");
let priorState: string | undefined;
beforeEach(() => {
  priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = artifactState;
});
afterEach(() => {
  if (priorState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = priorState;
});
afterAll(async () => {
  const { shutdownTaskPageWorker } = await import("@/lib/links/taskPageWorker");
  await shutdownTaskPageWorker();
  fs.rmSync(artifactState, { recursive: true, force: true });
});

function handoffFixture(prompt = "Build {{task}} from {{prev.output}}", spec = "AC: preserve the handoff") {
  const stage: PipelineStage = { id: "build", kind: "run", prompt, next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Follow {{task}} and {{prev.output}}." } };
  const pipeline = buildPipeline({ id: "handoff", task: "the task", spec, project: "viewer", repoDir: "/repo",
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = laneRoot;
  return { pipeline, stage };
}

test("a large multibyte specification is file-backed after the previous output", async () => {
  const spec = "Specification head\n" + "界".repeat(14_000);
  const { pipeline, stage } = handoffFixture(undefined, spec);
  const previous = "Previous head\n" + "🙂".repeat(12_000);
  const prompt = (await composeStageInput(pipeline, stage, stage.effectiveRole, previous));
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(32_000);
  for (const [label, full] of [["previous output", previous], ["specification", spec]]) {
    const file = prompt.match(new RegExp(`Full ${label} file: (.+)\\n`))?.[1];
    expect(file).toBeDefined();
    expect(path.isAbsolute(file!)).toBe(true);
    expect(fs.readFileSync(file!, "utf8")).toBe(full);
  }
  expect(prompt).toContain("Specification head");
  expect(prompt).toContain("Previous head");
  expect(prompt).not.toContain("�");
  for (const label of ["previous-output", "specification"]) {
    const file = prompt.match(new RegExp(`Full ${label === "previous-output" ? "previous output" : label} file: (.+)\\n`))?.[1];
    expect(file?.startsWith(path.join(laneRoot, ".artifacts", "pipeline-stage-inputs") + path.sep)).toBe(true);
    expect(file?.startsWith(path.join(artifactState, "pipeline-stage-inputs") + path.sep)).toBe(false);
  }
  expect((await composeStageInput(pipeline, stage, stage.effectiveRole, previous))).toBe(prompt);
});

test.each([
  { prompt: "Build {{task}} from {{prev.output}}", scaffold: "Follow {{task}} and {{prev.output}}.", previous: "Small output\nsecond line" },
  { prompt: "Build the task", scaffold: "Follow the task.", previous: "Small output\nsecond line" },
  { prompt: "Build {{task}} from {{prev.output}}", scaffold: "Follow {{task}} and {{prev.output}}.", previous: "" },
])("small stage inputs carry the branch and resolved test guidance ($prompt)", async ({ prompt, scaffold, previous }) => {
  const { pipeline, stage } = handoffFixture(prompt);
  stage.effectiveRole.promptScaffold = scaffold;
  const rendered = await composeStageInput(pipeline, stage, stage.effectiveRole, previous);
  expect(rendered).toContain(`Pipeline branch: ${pipeline.branch}.`);
  expect(rendered).toContain(`Commit your changes on ${pipeline.branch}`);
  expect(rendered).toContain(resolveStageTestGuidance());
});

test("the exact UTF-8 boundary stays inline and one byte over becomes a file reference", async () => {
  const { pipeline, stage } = handoffFixture("Build the design");
  stage.effectiveRole.promptScaffold = null;
  const framing = Buffer.byteLength((await composeStageInput(pipeline, stage, stage.effectiveRole, "x"))) - 1;
  const atBound = "x".repeat(32_000 - framing);
  const inline = (await composeStageInput(pipeline, stage, stage.effectiveRole, atBound));
  expect(Buffer.byteLength(inline)).toBe(32_000);
  expect(inline).not.toContain("Full previous output file:");
  const over = (await composeStageInput(pipeline, stage, stage.effectiveRole, atBound + "x"));
  expect(Buffer.byteLength(over)).toBeLessThanOrEqual(32_000);
  expect(over).toContain("Full previous output file:");
});

test("an entry stage can externalize just its specification", async () => {
  const { pipeline, stage } = handoffFixture("Build the task", "Spec head\n" + "界".repeat(14_000));
  const rendered = (await composeStageInput(pipeline, stage, stage.effectiveRole, ""));
  expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(32_000);
  expect(rendered).not.toContain("Full previous output file:");
  expect(rendered).toContain("Full specification file:");
});

test("a prompt beyond the reference budget preserves full stage input in one file", async () => {
  const { pipeline, stage } = handoffFixture("x".repeat(29_500));
  const rendered = (await composeStageInput(pipeline, stage, stage.effectiveRole, "Previous head\n" + "界".repeat(15_000)));
  expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(32_000);
  const promptFile = rendered.match(/Full stage prompt file: (.+)\n/)?.[1];
  expect(promptFile).toBeDefined();
  const fullPrompt = fs.readFileSync(promptFile!, "utf8");
  expect(fullPrompt).toContain("Previous head");
  expect(fullPrompt).toContain("AC: preserve the handoff");
  expect(rendered).not.toContain("Full specification file:");
});

test("controller artifacts stay outside read-only settlement in a repository without ignore rules", async () => {
  const { pipeline, stage } = handoffFixture("Build {{prev.output}}", "Spec " + "s".repeat(40_000));
  const previous = "Previous " + "p".repeat(40_000);
  const prompt = (await composeStageInput(pipeline, stage, stage.effectiveRole, previous));
  const head = git("rev-parse", "HEAD");

  expect(fs.existsSync(path.join(laneRoot, ".gitignore"))).toBe(false);
  expect(git("status", "--porcelain")).toBe("");
  expect(git("add", "--dry-run", "-A")).toBe("");
  expect((await commitPipelineStage(pipeline, stage.id, false, realExec, [], head))).toEqual({ ok: true, sha: head });
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(prompt).toContain("Full previous output file:");
  expect(prompt).toContain("Full specification file:");
});

test.each(["artifact root", "handoff directory"] as const)("large stage inputs reject a symlinked %s before writes or settlement can publish through it", async (linkAt) => {
  const repo = path.join(artifactState, `symlinked-${linkAt.replaceAll(" ", "-")}`);
  const publish = path.join(repo, "publish");
  fs.mkdirSync(publish, { recursive: true });
  fs.writeFileSync(path.join(publish, "tracked.txt"), "private repository content\n");
  fs.writeFileSync(path.join(publish, "preserve.txt"), "content that must survive\n");
  fs.writeFileSync(path.join(publish, ".gitignore"), "!*.md\n");
  const runGit = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  runGit("init", "--initial-branch=main");
  runGit("config", "user.email", "pipeline-test");
  runGit("config", "user.name", "Pipeline Test");
  runGit("config", "commit.gpgSign", "false");
  if (linkAt === "artifact root") {
    fs.symlinkSync("publish", path.join(repo, ".artifacts"), "dir");
  } else {
    fs.mkdirSync(path.join(repo, ".artifacts"), { recursive: true });
    fs.symlinkSync("../publish", path.join(repo, ".artifacts", "pipeline-stage-inputs"), "dir");
  }
  runGit("add", "-A");
  runGit("commit", "-m", "base");
  const head = runGit("rev-parse", "HEAD");

  const { pipeline, stage } = handoffFixture("Build {{prev.output}}", "Spec " + "s".repeat(40_000));
  pipeline.worktreeDir = repo;
  await expect((async () => (await composeStageInput(pipeline, stage, stage.effectiveRole, "Previous " + "p".repeat(40_000), repo)))()).rejects.toThrow(/pipeline controller artifact path must be a real directory/);
  expect(fs.readdirSync(publish).sort()).toEqual([".gitignore", "preserve.txt", "tracked.txt"]);
  expect(fs.readFileSync(path.join(publish, "tracked.txt"), "utf8")).toBe("private repository content\n");
  expect(fs.readFileSync(path.join(publish, "preserve.txt"), "utf8")).toBe("content that must survive\n");

  fs.mkdirSync(path.join(repo, "reports"));
  fs.writeFileSync(path.join(repo, "reports", "result.md"), "declared stage result\n");
  const settled = (await commitPipelineStage(pipeline, stage.id, linkAt === "artifact root", realExec, ["reports/result.md"], head));
  // Both aliases are refused before settlement can write through or publish
  // them. The declared report and existing alias contents remain on disk.
  expect(settled.ok).toBe(false);
  expect(runGit("rev-parse", "HEAD")).toBe(head);
  expect(fs.readFileSync(path.join(repo, "reports/result.md"), "utf8")).toBe("declared stage result\n");
  expect(fs.readFileSync(path.join(publish, "preserve.txt"), "utf8")).toBe("content that must survive\n");
});

test("large stage inputs reject a hardlinked ignore file without changing its external target", async () => {
  const external = path.join(artifactState, "operator-config.json");
  const repo = path.join(artifactState, "hardlinked-ignore");
  fs.mkdirSync(repo, { recursive: true });
  const runGit = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  runGit("init", "--initial-branch=main");
  runGit("config", "user.email", "pipeline-test");
  runGit("config", "user.name", "Pipeline Test");
  runGit("config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  runGit("add", "tracked.txt");
  runGit("commit", "-m", "base");
  fs.mkdirSync(path.join(repo, ".artifacts", "pipeline-stage-inputs"), { recursive: true });
  const ignoreFile = path.join(repo, ".artifacts", "pipeline-stage-inputs", ".gitignore");
  const original = '{"enabled":true}\n';
  fs.writeFileSync(external, original);
  fs.linkSync(external, ignoreFile);

  const { pipeline, stage } = handoffFixture("Build {{prev.output}}", "Spec " + "s".repeat(40_000));
  pipeline.worktreeDir = repo;
  await expect((async () => (await composeStageInput(pipeline, stage, stage.effectiveRole, "Previous " + "p".repeat(40_000), repo)))()).rejects.toThrow(/pipeline controller artifact ignore file must be a regular file with one link/);
  expect(fs.readFileSync(external, "utf8")).toBe(original);
  expect(() => JSON.parse(fs.readFileSync(external, "utf8"))).not.toThrow();
});

test.each(["symlink", "hardlink"] as const)("stage composition leaves a %s in Git info/exclude and its external JSON byte-identical", async (linkKind) => {
  const repo = path.join(artifactState, `linked-exclude-${linkKind}`);
  fs.mkdirSync(repo);
  const runGit = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  runGit("init", "--initial-branch=main");
  runGit("config", "user.email", "noreply@example.invalid");
  runGit("config", "user.name", "Fixture");
  runGit("config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  runGit("add", "tracked.txt");
  runGit("commit", "-m", "base");
  const exclude = runGit("rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  const external = path.join(artifactState, `external-${linkKind}.json`);
  const original = '{"enabled":true}\n';
  fs.writeFileSync(external, original);
  // The isolated Git template supplies no info directory or exclude file.
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.rmSync(exclude, { force: true });
  if (linkKind === "symlink") fs.symlinkSync(external, exclude);
  else fs.linkSync(external, exclude);

  const { pipeline, stage } = handoffFixture();
  pipeline.worktreeDir = repo;
  const previous = "Previous head\n" + "p".repeat(57_500);
  const delivered = (await composeStageInput(pipeline, stage, stage.effectiveRole, previous));
  const file = delivered.match(/Full previous output file: (.+)\n/)?.[1];
  expect(fs.readFileSync(file!, "utf8")).toBe(previous);
  expect(fs.readFileSync(external, "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(external, "utf8"))).toEqual({ enabled: true });
  expect(runGit("status", "--porcelain")).toBe("");
  expect(runGit("add", "--dry-run", "-A")).toBe("");
  const head = runGit("rev-parse", "HEAD");
  expect((await commitPipelineStage(pipeline, stage.id, false, realExec, [], head))).toEqual({ ok: true, sha: head });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "worker edit\n");
  runGit("add", "-A");
  expect((await commitPipelineStage(pipeline, stage.id, true, realExec))).toMatchObject({ ok: true });
  expect(runGit("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("tracked.txt");
  expect(fs.readFileSync(external, "utf8")).toBe(original);
});

test("read-write settlement never stages or commits controller artifacts", async () => {
  const { pipeline, stage } = handoffFixture("Build {{prev.output}}", "Spec " + "s".repeat(40_000));
  const previous = "Previous " + "p".repeat(40_000);
  const prompt = (await composeStageInput(pipeline, stage, stage.effectiveRole, previous));
  const head = git("rev-parse", "HEAD");

  expect(git("status", "--porcelain")).toBe("");
  expect(git("add", "--dry-run", "-A")).toBe("");
  expect((await commitPipelineStage(pipeline, stage.id, true, realExec))).toEqual({ ok: true, sha: head });
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("ls-files", "--", ".artifacts/pipeline-stage-inputs")).toBe("");
  expect(prompt).toContain("Full previous output file:");
  expect(prompt).toContain("Full specification file:");
});

test.each([false, true])("settlement excludes controller artifacts despite repository inclusion rules (read-write=%s)", async (allowCommit) => {
  const repo = path.join(artifactState, `inclusion-rules-${allowCommit}`);
  fs.mkdirSync(repo, { recursive: true });
  const runGit = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  runGit("init", "--initial-branch=main");
  runGit("config", "user.email", "pipeline-test");
  runGit("config", "user.name", "Pipeline Test");
  runGit("config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), "!*/\n!*.md\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  runGit("add", "tracked.txt", ".gitignore");
  runGit("commit", "-m", "base");
  const head = runGit("rev-parse", "HEAD");
  const { pipeline, stage } = handoffFixture("Build {{prev.output}}", "Spec " + "s".repeat(40_000));
  pipeline.worktreeDir = repo;
  const previous = "Previous " + "p".repeat(40_000);
  const prompt = (await composeStageInput(pipeline, stage, stage.effectiveRole, previous, repo));
  const artifactDirectory = path.join(repo, ".artifacts", "pipeline-stage-inputs");

  // Simulate a stage that changes the controller ignore file to re-include
  // Markdown. The settlement path itself must remain authoritative.
  fs.writeFileSync(path.join(artifactDirectory, ".gitignore"), "!*.md\n");
  expect(runGit("status", "--porcelain")).toContain(".artifacts/");
  const result = (await commitPipelineStage(pipeline, stage.id, allowCommit, realExec, [], head));

  expect(result).toEqual({ ok: true, sha: head });
  expect(runGit("rev-parse", "HEAD")).toBe(head);
  expect(runGit("ls-files", "--", ".artifacts/pipeline-stage-inputs")).toBe("");
  expect(prompt).toContain("Full previous output file:");
  expect(prompt).toContain("Full specification file:");
});

test("launch filtering executes stored privacy patterns away from the calling thread", async () => {
  const { roleMemoryCollection } = await import("@/lib/memory/roleStore");
  const lesson = "Preserve fixtureword evidence before publishing the final verification";
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
    kind: "rule", id: "r_stage_privacy", scope: "machine", rule: lesson, why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-10-14T00:00:00Z", changedAt: "2026-10-14T00:00:00Z",
  }));
  const { pipeline, stage } = handoffFixture(`Build {{task}}. ${lesson}`);
  const original = RegExp.prototype.exec;
  RegExp.prototype.exec = function (text: string) {
    if (this.source.includes("fixtureword")) throw new Error("launch privacy ran on the caller thread");
    return original.call(this, text);
  };
  try {
    const prompt = await composeStageInput(pipeline, stage, stage.effectiveRole, "");
    expect(prompt).toContain("[learned rule]");
    expect(prompt).not.toContain(lesson);
  } finally { RegExp.prototype.exec = original; }
}, 30_000);


const privacyLesson = "Inspect current ownership before changing retained worker state.";
const privacyReason = "An earlier operation used state after its owner had changed.";
function privacyFixture() {
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(artifactState, "privacy-state-"));
  return leaveSeatLessons({ source: { origin: "seat", project: "fixture", roleId: "orchestrator", fixRound: false, conversationId: "conversation_fixture" },
    lessons: [{ scope: "machine", rule: privacyLesson, why: privacyReason }], now: "2026-11-06T00:00:00Z" }).left[0]!.id;
}
const referenceFilter = (text: string) => hardenedRedact(withoutStoredLessons(text).replace(BEARER_TOKEN, "[redacted]"));

test.each(["inline", "previous", "specification", "fallback"] as const)("whole emitted fields equal the reference filter with bounded calls: %s", async mode => {
  privacyFixture();
  const { pipeline, stage } = handoffFixture(mode === "fallback" ? "x".repeat(32_000) : "Inspect current {{prev.output}}",
    (mode === "specification" ? "界".repeat(14_000) : "Specification") + " " + privacyLesson);
  const previous = mode === "inline" ? "ownership before changing retained worker state." : privacyLesson + "🙂".repeat(12_000);
  const context = { taskDetails: "Task details " + privacyLesson, handoffDigest: "Handoff " + privacyLesson, skillPaths: ["tracked.txt"] };
  const calls: Array<{ input: string; output: string }> = [];
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    const result = await real.call(this, request);
    if (request.kind === "filter" && typeof request.value === "string") calls.push({ input: request.value, output: result.value as string });
    return result;
  });
  try {
    const prompt = await composeStageInput(pipeline, stage, stage.effectiveRole, previous, laneRoot, realExec, 256, context);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(31_744);
    expect(calls).toHaveLength(mode === "inline" ? 1 : mode === "previous" ? 2 : mode === "specification" ? 3 : 4);
    expect(prompt).toBe(referenceFilter(calls.at(-1)!.input));
    expect(prompt).not.toContain(privacyLesson);
    for (const match of prompt.matchAll(/Full (?:previous output|specification|stage prompt) file: (.+)\n/g)) {
      const content = fs.readFileSync(match[1]!, "utf8");
      expect(content).not.toContain(privacyLesson);
      expect(calls.some(call => referenceFilter(call.input) === content)).toBe(true);
    }
    if (mode === "fallback") {
      const file = prompt.match(/Full stage prompt file: (.+)\n/)![1]!;
      const full = await composeStageText(pipeline, stage, stage.effectiveRole, previous, context);
      expect(fs.readFileSync(file, "utf8")).toBe(full);
    }
  } finally { worker.mockRestore(); }
});

test("redaction growth chooses a smaller complete candidate and refuses an oversized wrapper", async () => {
  const id = privacyFixture();
  const collection = roleMemoryCollection()!;
  const row = collection.get(`r:${id}`)!;
  if (row.kind !== "rule") throw Error("rule missing");
  collection.boundedPatch(1, tx => tx.put({ ...row, why: "elms" }));
  const { pipeline, stage } = handoffFixture("elms ".repeat(2_000), "界".repeat(14_000));
  const inputs: string[] = [];
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    if (request.kind === "filter" && typeof request.value === "string") inputs.push(request.value);
    return real.call(this, request);
  });
  try {
    const prompt = await composeStageInput(pipeline, stage, stage.effectiveRole, "🙂".repeat(12_000), laneRoot, realExec, 8_000);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(24_000);
    expect(inputs).toHaveLength(6);
    expect(inputs.some(input => Buffer.byteLength(input) <= 24_000 && Buffer.byteLength(referenceFilter(input)) > 24_000)).toBe(true);
    expect(prompt).not.toContain("elms");
    expect(prompt).toBe(referenceFilter(inputs.at(-1)!));
    await expect(composeStageInput(pipeline, stage, stage.effectiveRole, "", laneRoot, realExec, 31_990)).rejects.toThrow("Filtered stage input exceeds the message byte limit");
  } finally { worker.mockRestore(); }
});

test("whole candidate filtering withholds a lesson spanning the excerpt footer", async () => {
  privacyFixture();
  leaveSeatLessons({ source: { origin: "seat", project: "fixture", roleId: "orchestrator", fixRound: false, conversationId: "conversation_fixture" },
    lessons: [{ scope: "machine", rule: "edge Excerpt ends the file contains the full text", why: privacyReason }], now: "2026-11-06T00:00:00Z" });
  const { pipeline, stage } = handoffFixture("Build the task");
  const inputs: string[] = [];
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    if (request.kind === "filter" && typeof request.value === "string") inputs.push(request.value);
    return real.call(this, request);
  });
  try {
    const prompt = await composeStageInput(pipeline, stage, stage.effectiveRole, "p".repeat(507) + " edge " + "p".repeat(40_000));
    expect(inputs).toHaveLength(2);
    expect(inputs.at(-1)).toContain("edge\n[Excerpt ends;");
    expect(prompt).toBe(referenceFilter(inputs.at(-1)!));
    expect(prompt).not.toContain("edge\n[Excerpt ends;");
    expect(prompt).toContain("[learned rule]");
  } finally { worker.mockRestore(); }
});

for (const point of ["skills", "directory", "previous", "specification", "candidate", "inline-protection"] as const) {
  test.each(["request", "rule"] as const)(`privacy identity after ${point} await: %s`, async kind => {
    privacyFixture();
    const added = "Verify the silver orchard result before committing retained state.";
    const inline = point === "inline-protection";
    const { pipeline, stage } = handoffFixture("Build {{prev.output}}", inline ? added : "界".repeat(14_000) + "\n" + added);
    const previous = inline ? added : privacyLesson + "🙂".repeat(12_000) + added;
    const before = storedLessonRevision();
    let changed = false, calls = 0, executions = 0;
    const mutate = () => {
      if (changed) return;
      changed = true;
      if (kind === "request") recordLessonRequest({ pipelineId: "unrelated", stageId: "build", attempt: 1, project: "fixture", roleId: "builder", conversationId: "conversation_fixture", at: "2026-11-06T00:00:00Z" });
      else leaveSeatLessons({ source: { origin: "seat", project: "fixture", roleId: "orchestrator", fixRound: false, conversationId: "conversation_fixture" }, lessons: [{ scope: "machine", rule: added, why: privacyReason }], now: "2026-11-06T00:00:00Z" });
    };
    const real = TaskPageWorker.prototype.privacy;
    const invoke = realExec;
    const validate = point === "skills" ? spyOn(provision, "realExec").mockImplementation(async (...args) => {
      const result = await invoke(...args);
      if (args[1].includes("ls-tree")) mutate();
      return result;
    }) : undefined;
    const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
      const result = await real.call(this, request);
      calls++;
      if (calls === ({ previous: 1, specification: 2, candidate: 3 } as Partial<Record<typeof point, number>>)[point]) mutate();
      return result;
    });
    const exec: typeof realExec = async (...args) => {
      const result = await invoke(...args);
      if (++executions === 1 && (point === "directory" || point === "inline-protection")) mutate();
      return result;
    };
    try {
      const prompt = await composeStageInput(pipeline, stage, stage.effectiveRole, previous, laneRoot, exec, 0, { skillPaths: ["tracked.txt"] });
      expect(changed).toBe(true);
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(32_000);
      expect(storedLessonRevision() === before).toBe(kind === "request");
      if (kind === "request") expect(calls).toBe(inline ? 1 : 3);
      else {
        expect(calls).toBeGreaterThan(inline ? 1 : 3);
        expect(prompt).not.toContain(added);
        for (const match of prompt.matchAll(/Full (?:previous output|specification) file: (.+)\n/g)) expect(fs.readFileSync(match[1]!, "utf8")).not.toContain(added);
      }
    } finally { worker.mockRestore(); validate?.mockRestore(); }
  });
}

test.each(["inline", "artifact", "fallback"] as const)("untracked skills refuse before filtering on every composition path: %s", async mode => {
  privacyFixture();
  const { pipeline, stage } = handoffFixture(mode === "fallback" ? "x".repeat(40_000) : "Build the task");
  const worker = spyOn(TaskPageWorker.prototype, "privacy");
  try {
    await expect(composeStageInput(pipeline, stage, stage.effectiveRole, mode === "inline" ? "small" : "界".repeat(14_000), laneRoot, realExec, 0,
      { skillPaths: ["untracked-skill.md"] })).rejects.toThrow("Referenced skill is not tracked");
    expect(worker).not.toHaveBeenCalled();
  } finally { worker.mockRestore(); }
});
