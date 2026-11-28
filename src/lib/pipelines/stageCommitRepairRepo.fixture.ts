import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecPort, ExecResult } from "@/lib/workflows/provision";
import type { Pipeline } from "./types";

export const OUTPUT = "evidence/draft/prototype.diff.txt";

const ESLINT = path.resolve("node_modules/.bin/eslint");
export type HookMode = "broken" | "tool-missing" | "tool-missing-after-check" | "privacy-unconfigured" | "timeout-after-check"
  | "eslint-unconfigured-after-check" | "lints-nested";

/** A repository of its own, with a pre-commit hook that refuses staged
    whitespace the way the project's gate words it, or, in a named mode, fails
    the ways review rounds found: a broken slot, a missing tool, an unconfigured
    privacy gate or linter, a timeout, a diagnostic in another file. */
export function hookedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-commit-repair-repo-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  for (const directory of [home, repo]) fs.mkdirSync(directory);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(root, "xdg"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") });
  const calls: string[] = [];
  const exec: ExecPort = (command, args, cwd, overrides) => {
    calls.push(`${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
  };
  const run = (...args: string[]) => {
    const result = exec("git", args, repo) as ExecResult;
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  run("init", "--initial-branch=main");
  fs.writeFileSync(path.join(repo, "source.ts"), "export const value = 1;\n");
  run("add", "source.ts");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "initial");
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), [
    "#!/bin/sh",
    "if [ -f \"$(git rev-parse --git-dir)/hook-broken\" ]; then echo 'gate-slot: no slot became free within 600s' >&2; exit 1; fi",
    "if [ -f \"$(git rev-parse --git-dir)/hook-tool-missing\" ]; then echo \"checking $(git diff --cached --name-only)\" >&2; llv-test-tool-that-is-not-installed; exit 1; fi",
    "if [ -f \"$(git rev-parse --git-dir)/hook-tool-missing-after-check\" ]; then git diff --cached --check >&2; llv-test-tool-that-is-not-installed; exit 1; fi",
    /* The project's own gate order: staged whitespace, then privacy, here with
       a fingerprints file that does not exist, so the gate cannot judge. */
    `if [ -f "$(git rev-parse --git-dir)/hook-privacy-unconfigured" ]; then git diff --cached --check >&2; LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE="$(git rev-parse --git-dir)/missing-fingerprints.json" '${process.execPath}' '${path.resolve("scripts/privacy-publication-gate.ts")}' --base HEAD --require-known-values --paths $(git diff --cached --name-only) >&2; exit 1; fi`,
    /* Review round five: a check that times out, and a linter with no configuration, each after a genuine whitespace hit. */
    "if [ -f \"$(git rev-parse --git-dir)/hook-timeout-after-check\" ]; then git diff --cached --check >&2; timeout --verbose 0.02s sleep 1; exit 1; fi",
    `if [ -f "$(git rev-parse --git-dir)/hook-eslint-unconfigured-after-check" ]; then git diff --cached --check >&2; '${ESLINT}' $(git diff --cached --name-only) >&2; exit 1; fi`,
    /* A lint of a file the stage did not stage, whose name ends like one it did. */
    `if [ -f "$(git rev-parse --git-dir)/hook-lints-nested" ]; then '${ESLINT}' --no-config-lookup --rule 'no-unused-vars:error' nested/source.js >&2 || exit 1; fi`,
    "if ! out=$(git diff --cached --check 2>&1); then echo \"pre-commit: staged whitespace — $out\" >&2; exit 1; fi",
    "",
  ].join("\n"), { mode: 0o755 });
  const subject = {
    id: "12345678", task: "task", taskIds: [], project: "viewer", repoDir: repo, worktreeDir: repo,
    branch: "main", baseBranch: "", baseRef: "", lastPassedCommit: run("rev-parse", "HEAD"),
    stages: [], runs: [], cursor: null, state: "running", pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: "now", closedAt: null,
  } as unknown as Pipeline;
  return { root, repo, env, exec, run, calls, subject, hookMode: (mode: HookMode) => fs.writeFileSync(path.join(repo, ".git", `hook-${mode}`), "") };
}

export function writeOutput(repo: string, relative: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), content);
}

/** What a real hook in `mode` prints when it refuses a declared output with a trailing space. */
export async function realRefusal(mode: HookMode): Promise<string> {
  const { commitPipelineStage } = await import("./git");
  const box = hookedRepo();
  try {
    box.hookMode(mode);
    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote \n");
    const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    if (refused.ok) throw new Error(`the ${mode} hook accepted the commit`);
    expect(refused.commitRefusal).toEqual({ paths: [OUTPUT] });
    expect(box.run("rev-parse", "HEAD")).toBe(box.subject.lastPassedCommit!);
    return refused.error.slice("committing the passed stage: ".length);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
}

/** What a real hook prints when it lints `nested/source.js` while the stage staged only `source.js`. */
export async function nestedSuffixRefusal(): Promise<string> {
  const { commitPipelineStage } = await import("./git");
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, "source.js"), "export const value = 1;\n");
    writeOutput(box.repo, "nested/source.js", "const unused = 1;\n");
    box.run("add", "source.js", "nested/source.js");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "two sources");
    box.hookMode("lints-nested");
    fs.writeFileSync(path.join(box.repo, "source.js"), "export const value = 2;\n");
    const refused = await commitPipelineStage(box.subject, "build", true, box.exec);
    if (refused.ok) throw new Error("the lints-nested hook accepted the commit");
    expect(refused.commitRefusal).toEqual({ paths: ["source.js"] });
    return refused.error.slice("committing the passed stage: ".length);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
}
