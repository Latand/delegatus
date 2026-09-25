/**
 * Decides whether a platform job has anything to run on this pull request
 * (#1761, step 10).
 *
 * The macOS job bills at ten times an Ubuntu minute and the Windows leg at
 * twice, and both used to run on every pull request whatever it touched. They
 * run now only when the pull request changes a file they execute: every repo
 * path their workflow names (the test files, the inline `bun -e` imports, the
 * scripts they call), everything those files import or spawn by path, followed
 * transitively, plus the directories #1761 named for the platform and the
 * files that change what any of it resolves to.
 *
 *   bun scripts/ci-platform-scope.ts --workflow .github/workflows/macos-identity.yml \
 *     --prefix src/lib/proc/ --prefix src/lib/accounts/
 *
 * The changed files are the pull request's own change: the diff between the
 * merge commit the `pull_request` event checks out and its first parent, the
 * base branch it merges into. Anything this script cannot establish answers
 * `run=true`: no first parent, a failing `git diff`, an empty diff. Skipping is
 * the answer that has to be proven.
 *
 * The job this gates keeps its name and reports `skipped` when it has nothing
 * to run. GitHub counts a skipped job as a success for a required check, and
 * the project merge runner (`src/lib/forge/autoMerge.ts`) reads SKIPPED as
 * green, so every check name a head reported before is still present on the
 * next one. A workflow-level `paths:` filter would instead leave no check at
 * all, and the runner waits on a name it saw on an earlier head until it gives
 * up.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Files that change what every path below resolves to, or how it runs. */
export const ALWAYS_IN_SCOPE = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "scripts/ci-platform-scope.ts"];

const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`$]+)["'`]/g;
const PATH_LITERAL = /["'`]([\w@.\-/]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|py|sh))["'`]/g;
/** `path.join(import.meta.dir, "fixtures", "child.ts")`: a chain of literals
    anchored at the file's own directory, which may reach below or above it. */
const ANCHORED_PATH = /\bpath\.(?:join|resolve)\(\s*(?:import\.meta\.dirname|import\.meta\.dir|__dirname)((?:\s*,\s*["'`][^"'`$]*["'`])+)\s*,?\s*\)/g;
const STRING_LITERAL = /["'`]([^"'`$]*)["'`]/g;
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|py|sh)$/;
/** Erased before anything runs: `import type` and `export type` statements,
    and `import("./x").Name` written in a type position. */
const TYPE_ONLY_STATEMENT = /^\s*(?:import|export)\s+type\s[^;]*;/gm;
const TYPE_ONLY_IMPORT = /\bimport\s*\(\s*["'`][^"'`$]+["'`]\s*\)\s*\.(?!then\b|catch\b|finally\b)/g;
const WORKFLOW_PATH = /(?:^|[\s"'`=(:,])\.?\/?((?:src|bin|scripts|docs|evidence)\/[\w@.\-/]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|py|sh))/gm;

function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Every repo path a file may resolve `specifier` to, existing or not: a
    specifier whose file a pull request deleted still matches that deletion. */
function candidates(root: string, from: string, specifier: string): string[] {
  const bare = specifier.replace(/[?#].*$/, "");
  let base: string;
  if (bare.startsWith("@/")) base = path.join(root, "src", bare.slice(2));
  else if (bare.startsWith("./") || bare.startsWith("../")) base = path.resolve(path.dirname(from), bare);
  else return [];
  return SOURCE_EXTENSIONS.map((extension) => base + extension);
}

/** Repo-relative paths the given entry files execute, followed transitively
    through static and dynamic imports and through file paths they name. */
export function executedPaths(root: string, entries: readonly string[]): Set<string> {
  const reached = new Set<string>();
  const queue = entries.map((entry) => path.resolve(root, entry));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    reached.add(path.relative(root, file));
    if (!isFile(file)) continue;
    const source = fs.readFileSync(file, "utf8").replace(TYPE_ONLY_STATEMENT, "").replace(TYPE_ONLY_IMPORT, "");
    const targets: string[] = [];
    for (const match of source.matchAll(IMPORT_SPECIFIER)) targets.push(...candidates(root, file, match[1]!));
    for (const match of source.matchAll(ANCHORED_PATH)) {
      const segments = [...match[1]!.matchAll(STRING_LITERAL)].map((literal) => literal[1]!);
      if (SOURCE_FILE.test(segments.at(-1)!)) targets.push(path.join(path.dirname(file), ...segments));
    }
    /* An anchored chain is resolved whole above; its last segment is not also
       a bare name beside the file. */
    const text = source.replace(ANCHORED_PATH, "");
    for (const match of text.matchAll(PATH_LITERAL)) {
      const literal = match[1]!;
      if (literal.startsWith("@/") || literal.startsWith("./") || literal.startsWith("../")) {
        targets.push(...candidates(root, file, literal));
      } else if (!literal.includes("/") && !/\.test\.[cm]?[jt]sx?$/.test(literal)) {
        /* A bare name beside the file: a child script a test spawns by path. A
           test file named in a string is prose about it, and runs only when a
           job names it. */
        targets.push(path.join(path.dirname(file), literal));
      }
    }
    for (const target of targets) {
      if (!target.startsWith(root + path.sep)) continue;
      if (isFile(target)) {
        if (!visited.has(target)) queue.push(target);
      } else {
        reached.add(path.relative(root, target));
      }
    }
  }
  return reached;
}

/** The repo paths a workflow file names in its steps. */
export function workflowEntries(workflowText: string): string[] {
  return [...new Set([...workflowText.matchAll(WORKFLOW_PATH)].map((match) => match[1]!))];
}

export interface PlatformScope {
  run: boolean;
  reason: string;
}

export function platformScope(input: {
  root: string;
  workflow: string;
  prefixes: readonly string[];
  changed: readonly string[] | null;
}): PlatformScope {
  if (input.changed === null) return { run: true, reason: "the pull request's changed files could not be read" };
  if (input.changed.length === 0) return { run: true, reason: "the pull request's diff is empty" };
  const workflowText = fs.readFileSync(path.join(input.root, input.workflow), "utf8");
  const executed = executedPaths(input.root, workflowEntries(workflowText));
  for (const file of input.changed) {
    if (file === input.workflow || ALWAYS_IN_SCOPE.includes(file)) return { run: true, reason: `${file} changes how the job runs` };
    const prefix = input.prefixes.find((candidate) => file.startsWith(candidate));
    if (prefix) return { run: true, reason: `${file} is under ${prefix}` };
    if (executed.has(file)) return { run: true, reason: `${file} is executed by the job` };
  }
  return { run: false, reason: `none of ${input.changed.length} changed files is executed by the job (${executed.size} are)` };
}

/** The merge commit's own change against the base it merges into. */
export function changedInMergeCommit(root: string): string[] | null {
  const parents = spawnSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: root, encoding: "utf8" });
  if (parents.status !== 0 || parents.stdout.trim().split(/\s+/).length < 3) return null;
  const diff = spawnSync("git", ["diff", "--no-renames", "--name-only", "HEAD^1", "HEAD"], { cwd: root, encoding: "utf8" });
  if (diff.status !== 0) return null;
  return diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function main(argv: readonly string[]): void {
  let workflow: string | null = null;
  const prefixes: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--workflow") workflow = argv[++index] ?? null;
    else if (argv[index] === "--prefix") prefixes.push(argv[++index] ?? "");
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if (!workflow) throw new Error("--workflow is required");
  const root = path.resolve(import.meta.dir, "..");
  const scope = platformScope({ root, workflow, prefixes: prefixes.filter(Boolean), changed: changedInMergeCommit(root) });
  console.log(`${scope.run ? "run" : "skip"}: ${scope.reason}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${scope.run}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
