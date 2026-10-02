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
  { prompt: "Build {{task}} from {{prev.output}}", scaffold: "Follow {{task}} and {{prev.output}}.", previous: "Small output\nsecond line", hash: "467949fdef55331e85de5d0f0a471b121e85a28b952316024cee4ecce7c021af" },
  { prompt: "Build the task", scaffold: "Follow the task.", previous: "Small output\nsecond line", hash: "92c67166857ef9b34d61022729a6d04a99fdeed1fd973046ddca429baa30dfa3" },
  { prompt: "Build {{task}} from {{prev.output}}", scaffold: "Follow {{task}} and {{prev.output}}.", previous: "", hash: "05936aab04419797171b5821e30512dc035ae00a365a816c3ad1778568e59275" },
])("small stage inputs preserve the original renderer's bytes ($hash)", ({ prompt, scaffold, previous, hash }) => {
  const { pipeline, stage } = handoffFixture(prompt);
  stage.effectiveRole.promptScaffold = scaffold;
  const rendered = composeStageInput(pipeline, stage, stage.effectiveRole, previous);
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

test("a tight prompt shrinks the output excerpt before externalizing a small specification", () => {
  const { pipeline, stage } = handoffFixture("x".repeat(29_500));
  const rendered = composeStageInput(pipeline, stage, stage.effectiveRole, "Previous head\n" + "界".repeat(15_000));
  expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(32_000);
  expect(rendered).toContain("Previous head");
  expect(rendered).toContain("AC: preserve the handoff");
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
