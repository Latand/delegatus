import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ALWAYS_IN_SCOPE, changedSinceBase, executedPaths, platformScope, workflowEntries } from "./ci-platform-scope";

export type Mode = "pre-commit" | "pre-push";
export interface Step {
  name: string;
  command: string[];
  capped?: boolean;
  isolated?: boolean;
  pinned?: boolean;
  codex?: string;
}
export interface PlanEnvironment {
  base: string;
  lintBase?: string;
  existing: ReadonlySet<string>;
  tests: readonly string[];
  skippedMedia: readonly string[];
  linux: boolean;
  runtime: boolean;
  native: boolean;
  linuxTests: readonly string[];
  runtimeTests: readonly string[];
  codexVersions: readonly string[];
}
const isTest = (file: string) => /\.test\.[cm]?[jt]sx?$/.test(file) && !file.includes(".browser.test.");
const lintable = (file: string) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(file);
/** Prose the compiler never reads. Anything else can change what it checks. */
const proseOnly = (file: string) => /\.(?:md|mdx|txt)$/i.test(file);

/** Pure planning: discovery and process execution happen outside this function. */
export function plan(mode: Mode, changedFiles: readonly string[], env: PlanEnvironment): Step[] {
  const files = changedFiles.filter(file => env.existing.has(file));
  const skipped = new Set(env.skippedMedia);
  const privacyFiles = files.filter(file => !skipped.has(file));
  const steps: Step[] = [];
  if (mode === "pre-commit") steps.push({ name: "staged whitespace", command: ["git", "diff", "--cached", "--check"] });
  if (mode === "pre-push" || privacyFiles.length) {
    const command = ["bun", "scripts/privacy-publication-gate.ts", "--base", env.base, "--require-known-values"];
    if (mode === "pre-push") command.push("--check-commits");
    // With all media deferred, still inspect commit identities/messages. The
    // manifest is a safe non-empty selection for the gate's explicit-path API.
    if (mode === "pre-commit" || skipped.size) command.push("--paths", ...(privacyFiles.length ? privacyFiles : ["package.json"]));
    steps.push({ name: "privacy", command });
  }
  // A push that changes nothing (a read-only stage, a branch that only trails
  // main) has nothing a test could judge: whatever fails is already on main.
  // Privacy still reads every commit the push carries.
  if (mode === "pre-push" && changedFiles.length === 0) return steps;
  if (mode === "pre-push" && !changedFiles.every(proseOnly)) steps.push({ name: "types", command: ["bunx", "tsc", "--noEmit"], capped: true });
  const supplyChainChanged = changedFiles.some(file => ["package.json", "bun.lock", "security/audit-allowlist.json", "scripts/supply-chain-check.ts", "scripts/audit-with-retry.sh", ".github/workflows/supply-chain.yml"].includes(file));
  if (mode === "pre-push" && supplyChainChanged) {
    // Install the candidate graph before any later checks execute against
    // node_modules. The supply-chain script repeats a lockfile-only frozen
    // check before it audits.
    steps.unshift({ name: "frozen install", command: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"], capped: true });
  }
  const lintFiles = files.filter(lintable).map(file => `./${file}`);
  if (lintFiles.length) steps.push({ name: "eslint", command: ["bun", "scripts/eslint-changes.ts", "--base", env.lintBase ?? env.base, ...lintFiles], capped: true });
  if (mode === "pre-commit") return steps;
  const touched = new Set(files.filter(isTest));
  for (const file of files.filter(lintable)) {
    const stem = file.replace(/\.[^.]+$/, "");
    for (const test of env.tests) if (test.startsWith(`${stem}.`) && isTest(test)) touched.add(test);
  }
  if (changedFiles.some(file => file.startsWith(".githooks/") || file === "scripts/gate-slot.sh")) {
    for (const file of env.tests) if (/scripts\/(?:local-gate|gate-slot).*\.test\.ts$/.test(file)) touched.add(file);
  }
  if (touched.size) steps.push({ name: "touched tests", command: ["bun", "scripts/local-gate-tests.ts", "--base", env.base, ...[...touched].map(file => `./${file}`)], capped: true, isolated: true });
  if (env.linux) {
    steps.push({ name: "Linux backend", command: ["bun", "scripts/verify-platform-backend.ts", "--expect", "linux"], capped: true, isolated: true });
    // The same verdict rules as touched tests: a platform test that already
    // fails on the merge base is PRE-EXISTING and never blocks this push.
    steps.push({ name: "Linux tests", command: ["bun", "scripts/local-gate-tests.ts", "--base", env.base, ...env.linuxTests.map(file => `./${file}`)], capped: true, isolated: true });
  }
  if (env.runtime) {
    steps.push(
      { name: "runtime verdict tests", command: ["bun", "test", ...env.runtimeTests.map(file => `./${file}`)], capped: true, isolated: true, pinned: true },
      { name: "build MCP", command: ["bun", "scripts/build-mcp.ts"], capped: true, isolated: true, pinned: true },
      { name: "MCP size budgets", command: ["bun", "test", "./src/lib/mcp/answerSizes.test.ts"], capped: true, isolated: true, pinned: true },
      { name: "Viewer build", command: ["bun", "run", "build"], capped: true, isolated: true, pinned: true },
      { name: "Viewer runtime", command: ["bun", "scripts/verify-viewer-runtime.ts"], capped: true, isolated: true, pinned: true },
      { name: "runtime host", command: ["bun", "scripts/verify-runtime-host.ts"], capped: true, isolated: true, pinned: true },
      { name: "runtime negative controls", command: ["bun", "scripts/verify-bun-runtime-controls.ts"], capped: true, isolated: true, pinned: true },
    );
  }
  if (env.native) for (const version of env.codexVersions) steps.push({ name: `native Codex ${version}`, command: ["bun", "scripts/verify-native-codex-runtime.ts"], capped: true, isolated: true, pinned: true, codex: version });
  if (supplyChainChanged) {
    steps.push({ name: "audit retry tests", command: ["bun", "test", "./scripts/audit-with-retry.test.ts", "./scripts/supply-chain-check.test.ts"], capped: true, isolated: true });
    steps.push({ name: "supply chain", command: ["bun", "scripts/supply-chain-check.ts", "--base", env.base], capped: true });
  }
  return steps;
}

/** Match publication media by extension and magic bytes, including disguised
 * rasters. Read only the header; the privacy gate still performs the inspection.
 */
export function requiresMediaTools(file: string): boolean {
  if (/\.(?:bmp|jpe?g|png|tiff?|webp|avi|gif|m4v|mkv|mov|mp4|webm|mp3|wav)$/i.test(file)) return true;
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(12);
    const length = readSync(fd, bytes, 0, 12, 0);
    const prefix = bytes.subarray(0, length).toString("latin1");
    return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      || prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a") || prefix.startsWith("BM")
      || bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
      || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
      || (prefix.startsWith("RIFF") && ["AVI ", "WEBP"].includes(prefix.slice(8, 12)))
      || prefix.slice(4, 8) === "ftyp"
      || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  } finally { closeSync(fd); }
}

function rootViewerInputs(): string[] {
  // A deleted root input must still trigger the GET / proof.
  return ["src/app/page.tsx", "src/app/layout.tsx"];
}

interface Workflow { jobs: Record<string, { steps: Array<{ name?: string; run?: string }>; strategy?: { matrix?: { codex?: string[] } } }> }
function workflow(root: string, name: string): Workflow {
  return Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows", name), "utf8")) as Workflow;
}
const jobSource = (job: Workflow["jobs"][string]) => job.steps.map(step => step.run ?? "").join("\n");
function siblingTests(root: string, files: readonly string[]): string[] {
  const tests = new Set<string>();
  for (const dir of new Set(files.filter(lintable).map(file => path.dirname(file)))) {
    if (!existsSync(path.join(root, dir))) continue;
    for (const file of readdirSync(path.join(root, dir))) if (isTest(file)) tests.add(path.posix.join(dir, file));
  }
  return [...tests];
}

export function discover(root: string, base: string, files: readonly string[]): PlanEnvironment {
  const existing = new Set(files.filter(file => existsSync(path.join(root, file))));
  const mediaTools = ["tesseract", "ffmpeg", "ffprobe"].every(tool => Bun.which(tool));
  const skippedMedia = mediaTools ? [] : [...existing].filter(file => requiresMediaTools(path.join(root, file)));
  const platformFile = ".github/workflows/platform-tests.yml";
  const platform = workflow(root, "platform-tests.yml");
  const bun = workflow(root, "bun-runtime.yml");
  const runtimeEntries = workflowEntries(jobSource(bun.jobs["bun-runtime"]!));
  // The GET / leg of verify-viewer-runtime serves the built root route. Follow
  // the route and its layouts/components as additional runtime inputs.
  const viewerInputs = executedPaths(root, rootViewerInputs());
  const nativeScript = "scripts/verify-native-codex-runtime.ts";
  const nativeEntries = [nativeScript, ...workflowEntries(readFileSync(path.join(root, nativeScript), "utf8"))];
  const runtimePaths = executedPaths(root, runtimeEntries);
  const nativePaths = executedPaths(root, nativeEntries);
  const common = files.some(file => ALWAYS_IN_SCOPE.includes(file) || file === ".github/workflows/bun-runtime.yml");
  return {
    base, existing, skippedMedia, tests: siblingTests(root, [...files, "scripts/local-gate.ts"]),
    // An empty diff is "run" to the CI scope, where skipping must be proven.
    // Here it is proven: nothing changed, so no platform job has a subject.
    linux: process.platform === "linux" && files.length > 0 && platformScope({ root, workflow: platformFile, prefixes: ["src/lib/proc/"], changed: files }).run,
    runtime: common || files.some(file => runtimePaths.has(file) || viewerInputs.has(file) || ["Dockerfile", "src/instrumentation.ts"].includes(file) || /^next\.config\./.test(file) || file.startsWith("src/runtime-host/")),
    native: common || files.some(file => nativePaths.has(file)),
    linuxTests: workflowEntries(platform.jobs["windows-platform"]!.steps.find(step => step.name === "Platform tests")!.run!).filter(isTest),
    runtimeTests: runtimeEntries.filter(isTest),
    codexVersions: bun.jobs["native-codex-runtime"]!.strategy!.matrix!.codex!,
  };
}

/** A pipeline may inherit TMPDIR below live state/scratch. Nested runtime
 * probes replace TMPDIR again, losing that exemption. Use an OS temp root
 * outside the operator installation for the gate's whole sandbox tree.
 */
export function gateTemporaryRoot(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? tmpdir() : "/var/tmp";
}

/** Everything that might resolve state, including build imports, is sandboxed. */
export function isolatedEnvironment(root: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // Git exports these to hooks. Keeping them makes a fixture's `git -C`
  // operate on the pushing repository instead of the fixture repository.
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
  ]) delete env[key];
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  // Keep slots shared even when TMPDIR below becomes private to the test run:
  // /var/tmp is the one machine namespace both gate implementations lock in.
  env.LLV_GATE_LOCK_DIR = inherited.LLV_GATE_LOCK_DIR ?? "/var/tmp";
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "LLV_STATE_DIR", "TMPDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) {
    env[key] = path.join(root, key.toLowerCase());
    mkdirSync(env[key]!, { recursive: true });
  }
  delete env.LLV_STATE_OWNER;
  delete env.LLV_INBOX_DIR;
  delete env.DELEGATUS_STATE_DIR;
  // A Viewer that pushes for a lane carries its own interface language, its
  // launcher handoff and its token. Tests assert the defaults.
  for (const key of ["LLV_LANG", "LLV_LAUNCHER_REEXEC", "LLV_LAUNCHER_CHECKOUT", "LLV_TOKEN", "LLV_DEBUG", "DELEGATUS_DEBUG"]) delete env[key];
  env.NODE_ENV = "test";
  env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  return env;
}

function run(command: string[], root: string, env = process.env): void {
  const result = spawnSync(command[0]!, command.slice(1), { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} failed (${result.status ?? result.signal})`);
}
function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trimEnd();
}
export function pinnedBunVersion(dockerfile: string): string {
  const pins = new Set([...dockerfile.matchAll(/npm install -g bun@(\d+\.\d+\.\d+)/g)].map(match => match[1]!));
  if (pins.size !== 1) throw new Error("Dockerfile must carry exactly one Bun pin");
  return [...pins][0]!;
}
function pinnedRuntime(root: string, cache: string): string {
  const version = pinnedBunVersion(readFileSync(path.join(root, "Dockerfile"), "utf8"));
  const current = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  if (current.status === 0 && current.stdout.trim() === version) return process.execPath;
  const prefix = path.join(cache, `bun-${version}`);
  const binary = path.join(prefix, "node_modules/.bin/bun");
  if (!existsSync(binary)) run(["bash", "scripts/gate-slot.sh", "npm", "install", "--prefix", prefix, "--no-save", `bun@${version}`], root);
  const actual = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (actual.status !== 0 || actual.stdout.trim() !== version) throw new Error("cached Bun does not match Dockerfile pin");
  return binary;
}
function codexFixture(root: string, cache: string, version: string): string {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("native Codex local gate currently requires Linux x64/arm64");
  const prefix = path.join(cache, `codex-${version}`);
  const target = process.arch === "x64" ? "x86_64" : "aarch64";
  const binary = path.join(prefix, `node_modules/@openai/codex-linux-${process.arch}/vendor/${target}-unknown-linux-musl/bin/codex`);
  if (!existsSync(binary)) run(["bash", "scripts/gate-slot.sh", "npm", "install", "--prefix", prefix, "--no-save", "--ignore-scripts", `@openai/codex@${version}`], root);
  if (!existsSync(binary)) throw new Error("native Codex fixture was not installed");
  return binary;
}

function main(mode: Mode): void {
  if (process.env.LLV_SKIP_HOOKS === "1") return;
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  let base = mode === "pre-commit" ? git(root, ["merge-base", "HEAD", "origin/main"]) : "HEAD";
  if (mode === "pre-push") {
    const fetch = spawnSync("git", ["fetch", "origin", "main", "--quiet"], { cwd: root, stdio: "ignore" });
    if (fetch.status !== 0) console.warn("pre-push: fetch failed; using the last origin/main (base resolution must still succeed)");
    base = git(root, ["merge-base", "HEAD", "origin/main"]);
    const behind = Number(git(root, ["rev-list", "--count", "HEAD..origin/main"]));
    if (behind) console.warn(`pre-push: branch is ${behind} commit(s) behind origin/main; the hosted privacy gate may flag main-only commits. Merge origin/main before pushing.`);
  }
  const files = mode === "pre-commit"
    ? git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean)
    : [...new Set([
      ...(changedSinceBase(root, base) ?? (() => { throw new Error("cannot read push diff"); })()),
      ...git(root, ["diff", "--name-only", "-z"]).split("\0"),
      ...git(root, ["diff", "--cached", "--name-only", "-z"]).split("\0"),
      ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ].filter(Boolean))];
  const context = discover(root, base, files);
  // Pre-commit privacy retains its staged-only base. ESLint compares against
  // origin/main's merge base in both modes, including earlier branch commits.
  const privacyBase = mode === "pre-commit" ? "HEAD" : base;
  for (const file of context.skippedMedia) console.warn(`${mode}: media OCR deferred to required CI (tesseract/ffmpeg/ffprobe unavailable): ${file}`);
  const steps = plan(mode, files, { ...context, base: privacyBase, lintBase: base });
  if (mode === "pre-push" && !files.length) console.error(`pre-push: nothing changed since ${base.slice(0, 12)}; checking the pushed commits for privacy only`);
  const cache = path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "delegatus-gate");
  const runtime = steps.some(step => step.pinned) ? pinnedRuntime(root, cache) : process.execPath;
  const sandbox = mkdtempSync(path.join(gateTemporaryRoot(), "delegatus-local-gate-"));
  try {
    const isolated = isolatedEnvironment(sandbox, process.env);
    const privacyEnv = {
      ...process.env,
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(root, "scripts/privacy-known-value-fingerprints.json"),
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
    };
    for (const step of steps) {
      console.error(`${mode}: ${step.name}`);
      const command = [...step.command];
      const env = { ...(step.isolated ? isolated : process.env) };
      if (step.name === "privacy") Object.assign(env, privacyEnv);
      if (step.pinned) {
        command[0] = runtime;
        env.PATH = `${path.dirname(runtime)}${path.delimiter}${env.PATH ?? ""}`;
      }
      if (step.name === "runtime host") command.push("--runtime", runtime);
      if (step.codex) command.push(codexFixture(root, cache, step.codex));
      if (step.name === "Viewer build") Object.assign(env, { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_RUNTIME_UI: "1" });
      // Missing named tests must not shrink a green `bun test` run.
      if (command[1] === "test") {
        if (command.length < 3) throw new Error("refusing an empty test list");
        for (const file of command.slice(2)) {
          if (!isTest(file) || !existsSync(path.resolve(root, file))) throw new Error(`missing or invalid test path: ${file}`);
        }
      }
      run(step.capped ? ["bash", "scripts/gate-slot.sh", ...command] : command, root, env);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "pre-commit" && mode !== "pre-push") throw new Error("usage: local-gate.ts pre-commit|pre-push");
  try { main(mode); } catch (error) {
    console.error(`${mode}: ${error instanceof Error ? error.message : error}; gate failed`);
    process.exitCode = 1;
  }
}
