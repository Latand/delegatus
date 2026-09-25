import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import { changedInMergeCommit, executedPaths, platformScope, workflowEntries } from "./ci-platform-scope";

const repositoryRoot = path.join(import.meta.dir, "..");
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-platform-scope-"));
  sandboxes.push(root);
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

const WORKFLOW = ".github/workflows/platform.yml";

/** A job that runs one test, which reaches a module through each edge kind. */
function fixture(): string {
  return tree({
    [WORKFLOW]: "jobs:\n  leg:\n    steps:\n      - run: bun test src/feature.test.ts\n",
    "src/feature.test.ts": 'import { feature } from "./feature";\nimport path from "node:path";\nconst child = path.join(import.meta.dir, "child.ts");\n',
    "src/feature.ts": [
      'import { helper } from "@/lib/helper";',
      'import type { Shape } from "./shapes";',
      'export type { Other } from "./otherShapes";',
      'type Ports = import("./ports").Ports;',
      'const lazy = () => import("./lazy");',
      'const pairedTest = "elsewhere.test.ts";',
      'import { gone } from "./gone";',
      "export const feature = helper;",
    ].join("\n"),
    "src/lib/helper.ts": 'import { deep } from "../deep";\nexport const helper = deep;\n',
    "src/deep.ts": "export const deep = 1;\n",
    "src/shapes.ts": "export type Shape = 1;\n",
    "src/otherShapes.ts": "export type Other = 1;\n",
    "src/ports.ts": "export type Ports = 1;\n",
    "src/lazy.ts": "export const lazy = 1;\n",
    "src/child.ts": "console.log(1);\n",
    "src/unrelated.ts": "export const unrelated = 1;\n",
    "src/elsewhere.test.ts": "export {};\n",
  });
}

function decide(root: string, changed: string[] | null, prefixes: string[] = []) {
  return platformScope({ root, workflow: WORKFLOW, prefixes, changed });
}

test("a change to anything the job imports, transitively, or spawns by path runs it", () => {
  const root = fixture();
  for (const file of ["src/feature.test.ts", "src/feature.ts", "src/lib/helper.ts", "src/deep.ts", "src/lazy.ts", "src/child.ts"]) {
    expect({ file, run: decide(root, [file]).run }).toEqual({ file, run: true });
  }
});

test("a change the job never executes skips it, type-only imports and prose included", () => {
  const root = fixture();
  for (const file of ["src/unrelated.ts", "src/shapes.ts", "src/otherShapes.ts", "src/ports.ts", "src/elsewhere.test.ts", "docs/notes.md"]) {
    expect({ file, run: decide(root, [file]).run }).toEqual({ file, run: false });
  }
  expect(decide(root, ["src/unrelated.ts", "docs/notes.md"]).reason).toContain("none of 2 changed files");
});

test("deleting a module the job still imports runs it", () => {
  // src/gone.ts does not exist: the pull request deleted it.
  expect(decide(fixture(), ["src/gone.ts"]).run).toBe(true);
});

test("the workflow, the lockfile, the manifests and the named directories always run it", () => {
  const root = fixture();
  for (const file of [WORKFLOW, "package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "scripts/ci-platform-scope.ts"]) {
    expect({ file, run: decide(root, [file]).run }).toEqual({ file, run: true });
  }
  expect(decide(root, ["src/lib/proc/new.ts"]).run).toBe(false);
  expect(decide(root, ["src/lib/proc/new.ts"], ["src/lib/proc/"])).toEqual({ run: true, reason: "src/lib/proc/new.ts is under src/lib/proc/" });
});

test("a diff it cannot read, or an empty one, runs the job", () => {
  const root = fixture();
  expect(decide(root, null).run).toBe(true);
  expect(decide(root, []).run).toBe(true);
});

test("the changed files are the merge commit's own change against the base it merges into", () => {
  const root = tree({ "src/base.ts": "export const base = 1;\n" });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  // A pull request with no merge commit yet has no first parent to compare against.
  expect(changedInMergeCommit(root)).toBeNull();
  git("checkout", "--quiet", "-b", "change");
  fs.writeFileSync(path.join(root, "src", "changed.ts"), "export const changed = 1;\n");
  fs.renameSync(path.join(root, "src", "base.ts"), path.join(root, "src", "moved.ts"));
  git("add", "-A");
  git("commit", "--quiet", "-m", "change");
  git("checkout", "--quiet", "main");
  fs.writeFileSync(path.join(root, "src", "main-only.ts"), "export const mainOnly = 1;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "main moved on");
  git("merge", "--quiet", "--no-ff", "-m", "merge", "change");
  // Both sides of a rename, and nothing main did on its own.
  expect(changedInMergeCommit(root)!.sort()).toEqual(["src/base.ts", "src/changed.ts", "src/moved.ts"]);
});

test("the real platform jobs reach the modules they run and not the board", () => {
  const macosWorkflow = ".github/workflows/macos-identity.yml";
  const windowsWorkflow = ".github/workflows/platform-tests.yml";
  const macos = executedPaths(repositoryRoot, workflowEntries(fs.readFileSync(path.join(repositoryRoot, macosWorkflow), "utf8")));
  const windows = executedPaths(repositoryRoot, workflowEntries(fs.readFileSync(path.join(repositoryRoot, windowsWorkflow), "utf8")));
  /* The subjects #1761's directory list for macOS left out, and the inline
     kernel probe's own imports. */
  for (const file of ["src/lib/limits.ts", "src/lib/agent/cli.ts", "src/lib/proc/darwinArgv.ts", "src/lib/accounts/claudeCredentials.ts"]) {
    expect({ file, reached: macos.has(file) }).toEqual({ file, reached: true });
  }
  for (const file of ["scripts/verify-platform-backend.ts", "src/lib/proc/windows.ts", "src/runtime-host/runtimeHostFence.ts", "bin/server-runtime.test.ts"]) {
    expect({ file, reached: windows.has(file) }).toEqual({ file, reached: true });
  }
  for (const reached of [macos, windows]) expect(reached.has("src/components/kanban/KanbanBoard.tsx")).toBe(false);
  expect(platformScope({ root: repositoryRoot, workflow: macosWorkflow, prefixes: [], changed: ["src/components/kanban/KanbanBoard.tsx"] }).run).toBe(false);
  expect(platformScope({ root: repositoryRoot, workflow: windowsWorkflow, prefixes: [], changed: ["src/lib/limits.ts"] }).run).toBe(false);
});

test("each platform job keeps its name and is skipped only on a scope that ran and said no", () => {
  for (const [file, job, name] of [
    ["macos-identity.yml", "darwin-identity", undefined],
    ["platform-tests.yml", "windows-platform", "Windows (native)"],
  ] as const) {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", file), "utf8")) as {
      on: Record<string, unknown>;
      jobs: Record<string, { name?: string; needs?: string; if?: string; outputs?: Record<string, string>; steps: Array<{ run?: string }> }>;
    };
    // No workflow-level path filter: the check must report on every pull request.
    expect(JSON.stringify(workflow.on)).not.toContain("paths");
    expect(workflow.jobs[job]!.name).toBe(name);
    expect(workflow.jobs[job]!.needs).toBe("scope");
    expect(workflow.jobs[job]!.if).toBe("${{ !cancelled() && (github.event_name != 'pull_request' || needs.scope.result != 'success' || needs.scope.outputs.run == 'true') }}");
    expect(workflow.jobs.scope!.outputs).toEqual({ run: "${{ steps.scope.outputs.run }}" });
    expect(workflow.jobs.scope!.steps.some((step) => step.run?.includes(`--workflow .github/workflows/${file}`))).toBe(true);
  }
  const platform = Bun.YAML.parse(fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "platform-tests.yml"), "utf8")) as {
    jobs: Record<string, { if?: string; needs?: string }>;
  };
  // The Linux leg is cheap and stays unconditional.
  expect(platform.jobs["linux-platform"]).not.toHaveProperty("if");
  expect(platform.jobs["linux-platform"]).not.toHaveProperty("needs");
});
