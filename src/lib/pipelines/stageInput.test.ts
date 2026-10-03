import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeStageInput } from "./stageInput";
import { commitPipelineStage } from "./git";
import { buildPipeline } from "./store";
import type { PipelineStage } from "./types";
import { realExec } from "@/lib/workflows/provision";

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
afterAll(() => fs.rmSync(artifactState, { recursive: true, force: true }));

function handoffFixture(prompt = "Build {{task}} from {{prev.output}}", spec = "AC: preserve the handoff") {
  const stage: PipelineStage = { id: "build", kind: "run", prompt, next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Follow {{task}} and {{prev.output}}." } };
  const pipeline = buildPipeline({ id: "handoff", task: "the task", spec, project: "viewer", repoDir: "/repo",
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = laneRoot;
  return { pipeline, stage };
}

test("a large multibyte specification is file-backed after the previous output", () => {
  const spec = "Specification head\n" + "界".repeat(14_000);
  const { pipeline, stage } = handoffFixture(undefined, spec);
  const previous = "Previous head\n" + "🙂".repeat(12_000);
  const prompt = composeStageInput(pipeline, stage, stage.effectiveRole, previous);
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
  expect(composeStageInput(pipeline, stage, stage.effectiveRole, previous)).toBe(prompt);
});

test.each([
  { prompt: "Build {{task}} from {{prev.output}}", scaffold: "Follow {{task}} and {{prev.output}}.", previous: "Small output\nsecond line", hash: "6fd6aab212e5dd76ff104d971bbf34bbab75f35ca72155e917a41623c4cc3145" },
  { prompt: "Build the task", scaffold: "Follow the task.", previous: "Small output\nsecond line", hash: "e0bb08c8b7b4907c537bd85b2be4e163754dcedd3bde2e38925b8ae15a9867f8" },
  { prompt: "Build {{task}} from {{prev.output}}", scaffold: "Follow {{task}} and {{prev.output}}.", previous: "", hash: "baae7dc471e407d3d6f445d400a88e068eb2e87129b54a5ce056d2ffe73ca1d8" },
])("small stage inputs preserve the original renderer's bytes ($hash)", ({ prompt, scaffold, previous, hash }) => {
  const { pipeline, stage } = handoffFixture(prompt);
  stage.effectiveRole.promptScaffold = scaffold;
  const rendered = composeStageInput(pipeline, stage, stage.effectiveRole, previous);
  expect(rendered).toContain(`Pipeline branch: ${pipeline.branch}.`);
  expect(rendered).toContain(`Commit your changes on ${pipeline.branch}`);
  // SHA-256 snapshots captured from the base renderer, including all framing.
  expect(crypto.createHash("sha256").update(rendered).digest("hex")).toBe(hash);
});

test("the exact UTF-8 boundary stays inline and one byte over becomes a file reference", () => {
  const { pipeline, stage } = handoffFixture("Build the design");
  stage.effectiveRole.promptScaffold = null;
  const framing = Buffer.byteLength(composeStageInput(pipeline, stage, stage.effectiveRole, "x")) - 1;
  const atBound = "x".repeat(32_000 - framing);
  const inline = composeStageInput(pipeline, stage, stage.effectiveRole, atBound);
  expect(Buffer.byteLength(inline)).toBe(32_000);
  expect(inline).not.toContain("Full previous output file:");
  const over = composeStageInput(pipeline, stage, stage.effectiveRole, atBound + "x");
  expect(Buffer.byteLength(over)).toBeLessThanOrEqual(32_000);
  expect(over).toContain("Full previous output file:");
});

test("an entry stage can externalize just its specification", () => {
  const { pipeline, stage } = handoffFixture("Build the task", "Spec head\n" + "界".repeat(14_000));
  const rendered = composeStageInput(pipeline, stage, stage.effectiveRole, "");
  expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(32_000);
  expect(rendered).not.toContain("Full previous output file:");
  expect(rendered).toContain("Full specification file:");
});

test("a prompt beyond the reference budget preserves full stage input in one file", () => {
  const { pipeline, stage } = handoffFixture("x".repeat(29_500));
  const rendered = composeStageInput(pipeline, stage, stage.effectiveRole, "Previous head\n" + "界".repeat(15_000));
  expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(32_000);
  const promptFile = rendered.match(/Full stage prompt file: (.+)\n/)?.[1];
  expect(promptFile).toBeDefined();
  const fullPrompt = fs.readFileSync(promptFile!, "utf8");
  expect(fullPrompt).toContain("Previous head");
  expect(fullPrompt).toContain("AC: preserve the handoff");
  expect(rendered).not.toContain("Full specification file:");
});

test("controller artifacts stay outside read-only settlement in a repository without ignore rules", () => {
  const { pipeline, stage } = handoffFixture("Build {{prev.output}}", "Spec " + "s".repeat(40_000));
  const previous = "Previous " + "p".repeat(40_000);
  const prompt = composeStageInput(pipeline, stage, stage.effectiveRole, previous);
  const head = git("rev-parse", "HEAD");

  expect(fs.existsSync(path.join(laneRoot, ".gitignore"))).toBe(false);
  expect(git("status", "--porcelain")).toBe("");
  expect(git("add", "--dry-run", "-A")).toBe("");
  expect(commitPipelineStage(pipeline, stage.id, false, realExec, [], head)).toEqual({ ok: true, sha: head });
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(prompt).toContain("Full previous output file:");
  expect(prompt).toContain("Full specification file:");
});

test.each(["artifact root", "handoff directory"] as const)("large stage inputs reject a symlinked %s before writes or settlement can publish through it", (linkAt) => {
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
  expect(() => composeStageInput(pipeline, stage, stage.effectiveRole, "Previous " + "p".repeat(40_000), repo))
    .toThrow(/pipeline controller artifact path must be a real directory/);
  expect(fs.readdirSync(publish).sort()).toEqual([".gitignore", "preserve.txt", "tracked.txt"]);
  expect(fs.readFileSync(path.join(publish, "tracked.txt"), "utf8")).toBe("private repository content\n");
  expect(fs.readFileSync(path.join(publish, "preserve.txt"), "utf8")).toBe("content that must survive\n");

  fs.mkdirSync(path.join(repo, "reports"));
  fs.writeFileSync(path.join(repo, "reports", "result.md"), "declared stage result\n");
  const settled = commitPipelineStage(pipeline, stage.id, linkAt === "artifact root", realExec, ["reports/result.md"], head);
  // Both aliases are refused before settlement can write through or publish
  // them. The declared report and existing alias contents remain on disk.
  expect(settled.ok).toBe(false);
  expect(runGit("rev-parse", "HEAD")).toBe(head);
  expect(fs.readFileSync(path.join(repo, "reports/result.md"), "utf8")).toBe("declared stage result\n");
  expect(fs.readFileSync(path.join(publish, "preserve.txt"), "utf8")).toBe("content that must survive\n");
});

test("large stage inputs reject a hardlinked ignore file without changing its external target", () => {
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
  expect(() => composeStageInput(pipeline, stage, stage.effectiveRole, "Previous " + "p".repeat(40_000), repo))
    .toThrow(/pipeline controller artifact ignore file must be a regular file with one link/);
  expect(fs.readFileSync(external, "utf8")).toBe(original);
  expect(() => JSON.parse(fs.readFileSync(external, "utf8"))).not.toThrow();
});

test.each(["symlink", "hardlink"] as const)("stage composition leaves a %s in Git info/exclude and its external JSON byte-identical", (linkKind) => {
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
  fs.unlinkSync(exclude);
  if (linkKind === "symlink") fs.symlinkSync(external, exclude);
  else fs.linkSync(external, exclude);

  const { pipeline, stage } = handoffFixture();
  pipeline.worktreeDir = repo;
  const previous = "Previous head\n" + "p".repeat(57_500);
  const delivered = composeStageInput(pipeline, stage, stage.effectiveRole, previous);
  const file = delivered.match(/Full previous output file: (.+)\n/)?.[1];
  expect(fs.readFileSync(file!, "utf8")).toBe(previous);
  expect(fs.readFileSync(external, "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(external, "utf8"))).toEqual({ enabled: true });
  expect(runGit("status", "--porcelain")).toBe("");
  expect(runGit("add", "--dry-run", "-A")).toBe("");
  const head = runGit("rev-parse", "HEAD");
  expect(commitPipelineStage(pipeline, stage.id, false, realExec, [], head)).toEqual({ ok: true, sha: head });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "worker edit\n");
  runGit("add", "-A");
  expect(commitPipelineStage(pipeline, stage.id, true, realExec)).toMatchObject({ ok: true });
  expect(runGit("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("tracked.txt");
  expect(fs.readFileSync(external, "utf8")).toBe(original);
});

test("read-write settlement never stages or commits controller artifacts", () => {
  const { pipeline, stage } = handoffFixture("Build {{prev.output}}", "Spec " + "s".repeat(40_000));
  const previous = "Previous " + "p".repeat(40_000);
  const prompt = composeStageInput(pipeline, stage, stage.effectiveRole, previous);
  const head = git("rev-parse", "HEAD");

  expect(git("status", "--porcelain")).toBe("");
  expect(git("add", "--dry-run", "-A")).toBe("");
  expect(commitPipelineStage(pipeline, stage.id, true, realExec)).toEqual({ ok: true, sha: head });
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("ls-files", "--", ".artifacts/pipeline-stage-inputs")).toBe("");
  expect(prompt).toContain("Full previous output file:");
  expect(prompt).toContain("Full specification file:");
});

test.each([false, true])("settlement excludes controller artifacts despite repository inclusion rules (read-write=%s)", (allowCommit) => {
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
  const prompt = composeStageInput(pipeline, stage, stage.effectiveRole, previous, repo);
  const artifactDirectory = path.join(repo, ".artifacts", "pipeline-stage-inputs");

  // Simulate a stage that changes the controller ignore file to re-include
  // Markdown. The settlement path itself must remain authoritative.
  fs.writeFileSync(path.join(artifactDirectory, ".gitignore"), "!*.md\n");
  expect(runGit("status", "--porcelain")).toContain(".artifacts/");
  const result = commitPipelineStage(pipeline, stage.id, allowCommit, realExec, [], head);

  expect(result).toEqual({ ok: true, sha: head });
  expect(runGit("rev-parse", "HEAD")).toBe(head);
  expect(runGit("ls-files", "--", ".artifacts/pipeline-stage-inputs")).toBe("");
  expect(prompt).toContain("Full previous output file:");
  expect(prompt).toContain("Full specification file:");
});
