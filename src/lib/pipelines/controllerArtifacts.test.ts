import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { composeStructuredFirstMessage } from "@/lib/runtime/structuredFirstMessage";
import { CONTROLLER_ARTIFACT_DIRECTORY } from "./controllerArtifacts";
import { renderStagePrompt } from "./prompts";
import { composeStageInput } from "./stageInput";
import { buildPipeline } from "./store";
import type { PipelineStage } from "./types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-controller-artifacts-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function repository(name: string, unborn = false) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.invalid");
  git("config", "commit.gpgSign", "false");
  if (!unborn) {
    fs.writeFileSync(path.join(repo, "source.txt"), "base\n");
    git("add", "source.txt");
    git("commit", "-m", "base");
  }
  return { repo, git };
}

function compose(kind: "structured" | "pipeline", cwd: string) {
  const text = "PRIVATE_INPUT_SENTINEL\n" + "Full context 🙂\n".repeat(3_000);
  if (kind === "structured") {
    return { text, delivered: composeStructuredFirstMessage(text, cwd) };
  }
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "{{task}}".repeat(100), next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Complete builder instructions" } };
  const pipeline = buildPipeline({ id: "private-index", task: "t".repeat(500), spec: "AC", project: "fixture", repoDir: cwd,
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = cwd;
  return { text: renderStagePrompt(pipeline, stage, stage.effectiveRole, text), delivered: composeStageInput(pipeline, stage, stage.effectiveRole, text) };
}

function composeSmall(kind: "structured" | "pipeline", cwd: string) {
  if (kind === "structured") return composeStructuredFirstMessage("small message", cwd);
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Build", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: null } };
  const pipeline = buildPipeline({ id: "small-index", task: "Small task", project: "fixture", repoDir: cwd,
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = cwd;
  const delivered = composeStageInput(pipeline, stage, stage.effectiveRole, "");
  expect(delivered).toBe(renderStagePrompt(pipeline, stage, stage.effectiveRole, ""));
  return delivered;
}

test.each([
  { kind: "structured", nested: false, unborn: false },
  { kind: "pipeline", nested: false, unborn: false },
  { kind: "structured", nested: true, unborn: false },
  { kind: "pipeline", nested: true, unborn: false },
  { kind: "structured", nested: false, unborn: true },
  { kind: "pipeline", nested: false, unborn: true },
] as const)("$kind composition protects pre-staged handoffs from ordinary worker commits (nested=$nested, unborn=$unborn)", ({ kind, nested, unborn }) => {
  const { repo, git } = repository(`staged-${kind}-${nested}-${unborn}`, unborn);
  const cwd = nested ? path.join(repo, "package[worker]") : repo;
  const directory = path.join(cwd, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const oldFile = path.join(directory, "old-private-input.md");
  const oldText = "PRIVATE_STAGED_SENTINEL\n" + "Prior handoff\n".repeat(3_000);
  fs.writeFileSync(oldFile, oldText);
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "-A");
  fs.writeFileSync(path.join(repo, "source.txt"), "unstaged source\n");
  expect(git("diff", "--cached", "--name-only")).toContain("old-private-input.md");

  const { text, delivered } = compose(kind, cwd);
  expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(32_000);
  const file = delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toBe(text);
  expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  expect(git("show", ":source.txt")).toBe("staged source");
  expect(fs.readFileSync(path.join(repo, "source.txt"), "utf8")).toBe("unstaged source\n");
  expect(fs.readFileSync(oldFile, "utf8")).toBe(oldText);
  git("add", "-A");
  git("commit", "-m", "ordinary worker change");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_STAGED_SENTINEL");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_INPUT_SENTINEL");
});

test("a tracked controller ignore file remains tracked while private staged inputs are removed", () => {
  const { repo, git } = repository("tracked-ignore");
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, ".gitignore"), "!*.md\n");
  git("add", "-A");
  git("commit", "-m", "controller ignore");
  fs.writeFileSync(path.join(directory, "old.md"), "PRIVATE_STAGED_SENTINEL\n");
  git("add", "-A");
  compose("structured", repo);
  expect(git("diff", "--cached", "--name-only")).toBe("");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-files", "--", CONTROLLER_ARTIFACT_DIRECTORY)).toBe(`${CONTROLLER_ARTIFACT_DIRECTORY}/.gitignore`);
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_STAGED_SENTINEL");
});

test("composition refuses a committed input namespace before creating private files or changing its ignore file", () => {
  const { repo, git } = repository("tracked-input");
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, ".gitignore"), "!*.md\n");
  fs.writeFileSync(path.join(directory, "tracked.md"), "repository content\n");
  git("add", "-A");
  git("commit", "-m", "tracked namespace");
  expect(() => compose("structured", repo)).toThrow(/committed files in the private controller artifact directory/);
  expect(fs.readdirSync(directory).sort()).toEqual([".gitignore", "tracked.md"]);
  expect(fs.readFileSync(path.join(directory, ".gitignore"), "utf8")).toBe("!*.md\n");
  expect(git("status", "--porcelain")).toBe("");
});

test.each([
  { kind: "structured", ignore: "missing" }, { kind: "pipeline", ignore: "missing" },
  { kind: "structured", ignore: "reinclude" }, { kind: "pipeline", ignore: "reinclude" },
  { kind: "structured", ignore: "catchall" }, { kind: "pipeline", ignore: "catchall" },
] as const)("a small $kind launch clears old private staging before an ordinary worker commit (ignore=$ignore)", ({ kind, ignore }) => {
  const { repo, git } = repository(`small-${kind}-${ignore}`);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  if (ignore !== "missing") fs.writeFileSync(path.join(directory, ".gitignore"), ignore === "reinclude" ? "!*.md\n" : "*\n");
  fs.writeFileSync(path.join(directory, "old.md"), "PRIVATE_STAGED_SENTINEL\n");
  git("add", "-f", `${CONTROLLER_ARTIFACT_DIRECTORY}/old.md`);
  composeSmall(kind, repo);
  expect(git("diff", "--cached", "--name-only")).toBe("");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
  expect(fs.readFileSync(path.join(directory, "old.md"), "utf8")).toBe("PRIVATE_STAGED_SENTINEL\n");
});

test.each([
  { kind: "structured", small: true, inherited: "root" }, { kind: "pipeline", small: true, inherited: "root" },
  { kind: "structured", small: false, inherited: "root" }, { kind: "pipeline", small: false, inherited: "root" },
  { kind: "structured", small: true, inherited: "sibling" }, { kind: "pipeline", small: true, inherited: "sibling" },
  { kind: "structured", small: false, inherited: "sibling" }, { kind: "pipeline", small: false, inherited: "sibling" },
] as const)("nested $kind launch protects inherited $inherited handoffs before ordinary worker commits (small=$small)", ({ kind, small, inherited }) => {
  const { repo, git } = repository(`inherited-${kind}-${small}-${inherited}`);
  const cwd = path.join(repo, "worker");
  const priorCwd = inherited === "root" ? repo : path.join(repo, "sibling");
  fs.mkdirSync(cwd);
  fs.mkdirSync(priorCwd, { recursive: true });
  const prior = compose(kind, priorCwd);
  const file = prior.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  git("add", "-f", path.relative(repo, file!));
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  fs.writeFileSync(path.join(repo, "source.txt"), "unstaged source\n");
  if (small) composeSmall(kind, cwd);
  else compose(kind, cwd);
  expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  expect(git("show", ":source.txt")).toBe("staged source");
  expect(fs.readFileSync(file!, "utf8")).toBe(prior.text);
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
});

test.each(["structured", "pipeline"] as const)("%s composition protects the real Git index when its cwd is a directory alias", (kind) => {
  const { repo, git } = repository(`alias-${kind}`);
  const alias = path.join(root, `cwd-alias-${kind}`);
  fs.symlinkSync(repo, alias, "dir");
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "old.md"), "PRIVATE_STAGED_SENTINEL\n");
  git("add", "-A");
  const { delivered, text } = compose(kind, alias);
  const file = delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  expect(fs.readFileSync(file!, "utf8")).toBe(text);
  expect(git("diff", "--cached", "--name-only")).toBe("");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
});

test.each(["structured", "pipeline"] as const)("a nested %s launch repairs an exposed untracked parent handoff", (kind) => {
  const { repo, git } = repository(`untracked-parent-${kind}`);
  const prior = compose(kind, repo);
  const file = prior.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  fs.unlinkSync(path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY, ".gitignore"));
  const cwd = path.join(repo, "worker");
  fs.mkdirSync(cwd);
  composeSmall(kind, cwd);
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
  expect(fs.readFileSync(file!, "utf8")).toBe(prior.text);
});

test("inherited namespace discovery refuses a symlinked ancestor before repairing an external ignore file", () => {
  const { repo, git } = repository("external-ancestor");
  const external = path.join(root, "external-namespace");
  const directory = path.join(external, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const original = '{"enabled":true}\n';
  fs.writeFileSync(path.join(directory, ".gitignore"), original);
  fs.symlinkSync(external, path.join(repo, "alias"), "dir");
  // A crafted index can name a descendant even when the filesystem ancestor
  // is a symlink. Git discovery must not authorize writes through that alias.
  const blob = git("hash-object", "-w", path.join(repo, "source.txt"));
  git("update-index", "--add", "--cacheinfo", `100644,${blob},alias/${CONTROLLER_ARTIFACT_DIRECTORY}/old.md`);
  expect(() => compose("structured", repo)).toThrow(/pipeline controller artifact path must be a real directory/);
  expect(fs.readFileSync(path.join(directory, ".gitignore"), "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(path.join(directory, ".gitignore"), "utf8"))).toEqual({ enabled: true });
  expect(fs.readdirSync(directory)).toEqual([".gitignore"]);
});
