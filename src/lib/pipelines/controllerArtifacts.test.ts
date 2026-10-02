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

test.each([
  { kind: "structured", layout: "root" }, { kind: "pipeline", layout: "root" },
  { kind: "structured", layout: "nested" }, { kind: "pipeline", layout: "nested" },
  { kind: "structured", layout: "linked" }, { kind: "pipeline", layout: "linked" },
] as const)("$kind handoffs stay private after restoring the tracked ignore before worker commit (layout=$layout)", ({ kind, layout }) => {
  const base = repository(`restore-ignore-${kind}-${layout}`);
  let repo = base.repo;
  let git = base.git;
  if (layout === "linked") {
    repo = path.join(root, `linked-${kind}`);
    base.git("worktree", "add", "-b", "worker", repo);
    git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    };
  }
  const cwd = layout === "nested" ? path.join(repo, "package[worker]") : repo;
  const ignore = path.relative(repo, path.join(cwd, CONTROLLER_ARTIFACT_DIRECTORY, ".gitignore"));
  fs.mkdirSync(path.dirname(path.join(repo, ignore)), { recursive: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "!*/\n!*.md\n");
  fs.writeFileSync(path.join(repo, ignore), "!*.md\n");
  git("add", "-A");
  git("commit", "-m", "controller ignore");
  const before = git("rev-parse", "HEAD");

  const legacy = path.join(cwd, CONTROLLER_ARTIFACT_DIRECTORY, "previous-output-old.md");
  const legacyText = "PRIVATE_LEGACY_SENTINEL\n" + "Prior private input\n".repeat(3_000);
  fs.writeFileSync(legacy, legacyText);
  git("add", "-A");

  const { text, delivered } = compose(kind, cwd);
  const file = delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(32_000);
  expect(fs.readFileSync(file!, "utf8")).toBe(text);
  git("restore", "--", ignore);
  expect(fs.readFileSync(path.join(repo, ignore), "utf8")).toBe("!*.md\n");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "ordinary worker change before settlement");

  expect(git("diff", "--name-only", before, "HEAD")).toBe("source.txt");
  expect(git("ls-files", "--", path.relative(repo, path.join(cwd, CONTROLLER_ARTIFACT_DIRECTORY)))).toBe(ignore);
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_INPUT_SENTINEL");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_LEGACY_SENTINEL");
  expect(git("show", "HEAD:source.txt")).toBe("worker result");
  expect(fs.readFileSync(file!, "utf8")).toBe(text);
  expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
});

test.each([
  { kind: "structured", link: "directory symlink" }, { kind: "pipeline", link: "directory symlink" },
  { kind: "structured", link: "ignore symlink" }, { kind: "pipeline", link: "ignore symlink" },
  { kind: "structured", link: "ignore hardlink" }, { kind: "pipeline", link: "ignore hardlink" },
] as const)("$kind composition refuses a private $link without modifying external JSON", ({ kind, link }) => {
  const { repo, git } = repository(`private-link-${kind}-${link.replaceAll(" ", "-")}`);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY, "private");
  const external = path.join(root, `external-${kind}-${link.replaceAll(" ", "-")}`);
  fs.mkdirSync(external);
  const target = path.join(external, ".gitignore");
  const original = '{"enabled":true}\n';
  fs.writeFileSync(target, original);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (link === "directory symlink") fs.symlinkSync(external, directory, "dir");
  else {
    fs.mkdirSync(directory);
    if (link === "ignore symlink") fs.symlinkSync(target, path.join(directory, ".gitignore"));
    else fs.linkSync(target, path.join(directory, ".gitignore"));
  }
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  expect(() => compose(kind, repo)).toThrow(/pipeline controller artifact (?:path|ignore file) must be/);
  expect(fs.readFileSync(target, "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ enabled: true });
  expect(fs.readdirSync(external)).toEqual([".gitignore"]);
  expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  expect(git("show", ":source.txt")).toBe("staged source");
});

test("separate output and specification handoffs stay private after restoring the tracked ignore", () => {
  const { repo, git } = repository("restore-part-ignores");
  const ignore = `${CONTROLLER_ARTIFACT_DIRECTORY}/.gitignore`;
  fs.mkdirSync(path.dirname(path.join(repo, ignore)), { recursive: true });
  fs.writeFileSync(path.join(repo, ignore), "!*.md\n");
  git("add", "-A");
  git("commit", "-m", "controller ignore");
  const before = git("rev-parse", "HEAD");
  const output = "PRIVATE_OUTPUT_SENTINEL\n" + "o".repeat(40_000);
  const spec = "PRIVATE_SPEC_SENTINEL\n" + "s".repeat(40_000);
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Build {{prev.output}}", next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Builder instructions" } };
  const pipeline = buildPipeline({ id: "part-ignores", task: "Build", spec, project: "fixture", repoDir: repo,
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = repo;
  const delivered = composeStageInput(pipeline, stage, stage.effectiveRole, output);
  const outputFile = delivered.match(/Full previous output file: (.+)\n/)?.[1];
  const specFile = delivered.match(/Full specification file: (.+)\n/)?.[1];
  expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(32_000);
  expect(fs.readFileSync(outputFile!, "utf8")).toBe(output);
  expect(fs.readFileSync(specFile!, "utf8")).toBe(spec);
  git("restore", "--", ignore);
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "ordinary worker change before settlement");
  expect(git("diff", "--name-only", before, "HEAD")).toBe("source.txt");
  expect(git("ls-files", "--", CONTROLLER_ARTIFACT_DIRECTORY)).toBe(ignore);
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_OUTPUT_SENTINEL");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_SPEC_SENTINEL");
  expect(fs.readFileSync(outputFile!, "utf8")).toBe(output);
  expect(fs.readFileSync(specFile!, "utf8")).toBe(spec);
});

test.each([
  { kind: "structured", guard: "*\n", safe: true }, { kind: "pipeline", guard: "*\n", safe: true },
  { kind: "structured", guard: "/pipeline-stage-inputs/\n", safe: true }, { kind: "pipeline", guard: "/pipeline-stage-inputs/\n", safe: true },
  { kind: "structured", guard: "!*.md\n", safe: false }, { kind: "pipeline", guard: "!*.md\n", safe: false },
  { kind: "structured", guard: "/pipeline-stage-inputs/\n!/pipeline-stage-inputs/\n", safe: false },
  { kind: "pipeline", guard: "/pipeline-stage-inputs/\n!/pipeline-stage-inputs/\n", safe: false },
] as const)("$kind legacy protection validates tracked ancestor exclusion before composition (safe=$safe, guard=$guard)", ({ kind, guard, safe }) => {
  const { repo, git } = repository(`tracked-ancestor-${kind}-${safe}-${Buffer.from(guard).toString("hex")}`);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const ancestor = ".artifacts/.gitignore";
  const leaf = `${CONTROLLER_ARTIFACT_DIRECTORY}/.gitignore`;
  fs.writeFileSync(path.join(repo, ancestor), guard);
  fs.writeFileSync(path.join(repo, leaf), "!*.md\n");
  git("add", "-f", ancestor, leaf);
  git("commit", "-m", "tracked ancestor ignore");
  const before = git("rev-parse", "HEAD");
  const legacy = path.join(directory, "old.md");
  const legacyText = "PRIVATE_LEGACY_SENTINEL\n";
  fs.writeFileSync(legacy, legacyText);
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  if (safe) {
    const { delivered, text } = compose(kind, repo);
    const file = delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
    expect(fs.readFileSync(file!, "utf8")).toBe(text);
    git("restore", "--", ancestor, leaf);
    git("add", "-A");
    git("commit", "-m", "ordinary worker change before settlement");
    expect(git("diff", "--name-only", before, "HEAD")).toBe("source.txt");
    expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_LEGACY_SENTINEL");
    expect(fs.readFileSync(file!, "utf8")).toBe(text);
  } else {
    expect(() => compose(kind, repo)).toThrow(/tracked ancestor ignore prevents safe legacy/);
    expect(fs.readdirSync(directory).sort()).toEqual([".gitignore", "old.md"]);
    expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  }
  expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
  expect(fs.readFileSync(path.join(repo, ancestor), "utf8")).toBe(guard);
});

test.each([
  { kind: "structured", link: "symlink" }, { kind: "pipeline", link: "symlink" },
  { kind: "structured", link: "hardlink" }, { kind: "pipeline", link: "hardlink" },
] as const)("$kind legacy protection refuses a $link ancestor ignore without external writes", ({ kind, link }) => {
  const { repo, git } = repository(`linked-ancestor-${kind}-${link}`);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const legacy = path.join(directory, "old.md");
  fs.writeFileSync(legacy, "PRIVATE_LEGACY_SENTINEL\n");
  const external = path.join(root, `ancestor-${kind}-${link}.json`);
  const original = '{"enabled":true}\n';
  fs.writeFileSync(external, original);
  const guard = path.join(repo, ".artifacts", ".gitignore");
  if (link === "symlink") fs.symlinkSync(external, guard);
  else fs.linkSync(external, guard);
  expect(() => compose(kind, repo)).toThrow(/pipeline controller artifact ignore file must be a regular file with one link/);
  expect(fs.readFileSync(external, "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(external, "utf8"))).toEqual({ enabled: true });
  expect(fs.readFileSync(legacy, "utf8")).toBe("PRIVATE_LEGACY_SENTINEL\n");
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
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

test.each(["structured", "pipeline"] as const)("a small %s launch repairs an inherited private child ignore before tracked-ignore restore", (kind) => {
  const { repo, git } = repository(`inherited-child-ignore-${kind}`);
  const sibling = path.join(repo, "sibling");
  fs.mkdirSync(sibling);
  const prior = compose(kind, sibling);
  const file = prior.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  const ignore = path.relative(repo, path.join(sibling, CONTROLLER_ARTIFACT_DIRECTORY, ".gitignore"));
  fs.writeFileSync(path.join(repo, ignore), "!*.md\n");
  git("add", "-f", ignore);
  git("commit", "-m", "tracked sibling ignore");
  const before = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(path.dirname(file!), ".gitignore"), "!*.md\n");
  git("add", "-f", path.relative(repo, file!));
  const cwd = path.join(repo, "worker");
  fs.mkdirSync(cwd);
  composeSmall(kind, cwd);
  expect(git("diff", "--cached", "--name-only")).toBe("");
  git("restore", "--", ignore);
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "ordinary worker change before settlement");
  expect(git("diff", "--name-only", before, "HEAD")).toBe("source.txt");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_INPUT_SENTINEL");
  expect(fs.readFileSync(file!, "utf8")).toBe(prior.text);
});

test.each([
  { kind: "structured", small: true, inherited: "root" }, { kind: "pipeline", small: true, inherited: "root" },
  { kind: "structured", small: false, inherited: "root" }, { kind: "pipeline", small: false, inherited: "root" },
  { kind: "structured", small: true, inherited: "sibling" }, { kind: "pipeline", small: true, inherited: "sibling" },
  { kind: "structured", small: false, inherited: "sibling" }, { kind: "pipeline", small: false, inherited: "sibling" },
] as const)("nested $kind launch protects temporarily ignored legacy $inherited handoffs (small=$small)", ({ kind, small, inherited }) => {
  const { repo, git } = repository(`ignored-legacy-${kind}-${small}-${inherited}`);
  const rootIgnore = "!*/\n!*.md\n";
  fs.writeFileSync(path.join(repo, ".gitignore"), rootIgnore);
  git("add", ".gitignore");
  git("commit", "-m", "repository inclusion rules");
  const priorCwd = inherited === "root" ? repo : path.join(repo, "sibling[worker]");
  const legacy = path.join(priorCwd, CONTROLLER_ARTIFACT_DIRECTORY, "previous-output-old.md");
  const legacyText = "PRIVATE_IGNORED_LEGACY_SENTINEL\n" + "Full prior context\n".repeat(3_000);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, legacyText);
  fs.writeFileSync(path.join(repo, ".gitignore"), `${rootIgnore}**/.artifacts/\n`);
  expect(git("ls-files", "--others", "--exclude-standard")).not.toContain("previous-output-old.md");
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  const cwd = path.join(repo, "worker");
  fs.mkdirSync(cwd);
  if (small) composeSmall(kind, cwd);
  else compose(kind, cwd);
  expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  expect(git("show", ":source.txt")).toBe("staged source");
  expect(fs.readFileSync(path.join(repo, "source.txt"), "utf8")).toBe("worker result\n");
  git("restore", "--", ".gitignore");
  git("add", "-A");
  git("commit", "-m", "ordinary worker change before settlement");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe(".gitignore\nsource.txt");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_IGNORED_LEGACY_SENTINEL");
  expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
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

test.each([
  { kind: "structured", small: true }, { kind: "pipeline", small: true },
  { kind: "structured", small: false }, { kind: "pipeline", small: false },
] as const)("$kind composition refuses non-round-tripping Git paths without losing staged work (small=$small)", ({ kind, small }) => {
  const { repo, git } = repository(`invalid-git-path-${kind}-${small}`);
  const directory = Buffer.concat([Buffer.from(`${repo}/sibling-`), Buffer.from([0xff]), Buffer.from(`/${CONTROLLER_ARTIFACT_DIRECTORY}`)]);
  fs.mkdirSync(directory, { recursive: true });
  const file = Buffer.concat([directory, Buffer.from("/old.md")]);
  const input = "PRIVATE_INVALID_UTF8_SENTINEL\n" + "Full context\n".repeat(3_000);
  fs.writeFileSync(file, input);
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only");
  expect(staged).toContain("old.md");
  fs.writeFileSync(path.join(repo, "source.txt"), "unstaged source\n");
  const cwd = path.join(repo, "worker");
  fs.mkdirSync(cwd);
  expect(() => { if (small) composeSmall(kind, cwd); else compose(kind, cwd); })
    .toThrow(/cannot safely decode controller artifact Git paths/);
  expect(git("diff", "--cached", "--name-only")).toBe(staged);
  expect(git("show", ":source.txt")).toBe("staged source");
  expect(fs.readFileSync(path.join(repo, "source.txt"), "utf8")).toBe("unstaged source\n");
  expect(fs.readFileSync(file, "utf8")).toBe(input);
  expect(fs.readdirSync(cwd)).toEqual([]);
  expect(git("show", "HEAD:source.txt")).toBe("base");
});

test.each([
  { kind: "structured", small: true }, { kind: "pipeline", small: true },
  { kind: "structured", small: false }, { kind: "pipeline", small: false },
] as const)("$kind composition preserves ordinary non-UTF-8 source paths (small=$small)", ({ kind, small }) => {
  const { repo, git } = repository(`ordinary-byte-path-${kind}-${small}`);
  const tracked = Buffer.concat([Buffer.from(`${repo}/source-`), Buffer.from([0xff])]);
  const untracked = Buffer.concat([Buffer.from(`${repo}/source-`), Buffer.from([0xfe])]);
  fs.writeFileSync(tracked, "tracked source\n");
  git("add", "-A");
  git("commit", "-m", "ordinary source with byte filename");
  fs.writeFileSync(untracked, "new source\n");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker source\n");
  const result = small ? composeSmall(kind, repo) : compose(kind, repo);
  git("add", "-A");
  git("commit", "-m", "ordinary worker source");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain(CONTROLLER_ARTIFACT_DIRECTORY);
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_INPUT_SENTINEL");
  expect(fs.readFileSync(tracked, "utf8")).toBe("tracked source\n");
  expect(fs.readFileSync(untracked, "utf8")).toBe("new source\n");
  expect(git("show", "HEAD:source.txt")).toBe("worker source");
  if (typeof result !== "string") {
    const file = result.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
    expect(fs.readFileSync(file!, "utf8")).toBe(result.text);
  }
});
