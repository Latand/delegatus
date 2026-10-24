import { AppServerCloudTransport, runCloudChecks } from "./cloud-checks";
import { cloudCheckConfig } from "./cloud-check-config";
import { checkExecutionSettings } from "./cloud-check-settings";
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { changedSinceBase, platformScope, workflowEntries } from "./ci-platform-scope";
import { cpuBudgetTimer, cpuInheritedWaitMs, cpuWaitBudget } from "../src/lib/runtime/cpuAdmissionBudget";
import { cacheDirectory, checkEnvironment, environmentFingerprint, fileFingerprint, fingerprint, GateCache, gateToolFiles, installedFingerprint, workingInputsFingerprint } from "./gate-cache";
import { publicationHookDeadline, publicationPushBudgetMs } from "../src/lib/pipelines/gateBudget";

export type Mode = "pre-commit" | "pre-push";
export interface Step {
  name: string;
  command: string[];
  capped?: boolean;
  isolated?: boolean;
  pinned?: boolean;
  codex?: string;
  /** Passed after the optional Codex fixture path. */
  selection?: string;
  /** Consecutive steps with the same group run at once, under one phase marker. */
  group?: string;
  /** Steps in one lane run in order; different lanes overlap. */
  lane?: string;
  /** A check the hosted job also runs: stopped at a caller's deadline, it is
      named as left to that job, never failed or dropped. */
  deferrable?: boolean;
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

export const NATIVE_GROUP = "native Codex";

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
    steps.splice(1, 0, { name: "frozen install", command: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"], capped: true });
  }
  const lintFiles = files.filter(lintable).map(file => `./${file}`);
  if (lintFiles.length) steps.push({ name: "eslint", command: ["bun", "scripts/eslint-changes.ts", "--base", env.lintBase ?? env.base, ...lintFiles], capped: mode === "pre-push" || lintFiles.length > 40 });
  if (mode === "pre-commit") return steps;
  const touched = new Set<string>();
  if (changedFiles.some(file => ["scripts/gate-cache.ts", "scripts/local-gate.fixture.ts"].includes(file))) {
    for (const test of env.tests) if (/^scripts\/(?:local-gate(?:\.receipts|-tests)?|eslint-changes|gate-cache)\.test\.ts$/.test(test)) touched.add(test);
  }
  for (const file of files.filter(isTest)) touched.add(file);
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
      { name: "Viewer build", command: ["bun", "run", "build"], capped: true, isolated: true, pinned: true },
      { name: "MCP size budgets", command: ["bun", "test", "./src/lib/mcp/answerSizes.test.ts"], capped: true, isolated: true, pinned: true },
      { name: "Viewer runtime", command: ["bun", "scripts/verify-viewer-runtime.ts"], capped: true, isolated: true, pinned: true },
      { name: "runtime host", command: ["bun", "scripts/verify-runtime-host.ts"], capped: true, isolated: true, pinned: true },
      { name: "runtime negative controls", command: ["bun", "scripts/verify-bun-runtime-controls.ts"], capped: true, isolated: true, pinned: true },
    );
  }
  if (env.native && env.codexVersions.length) {
    // Only the engine files start the Codex executable, so only they run once
    // per supported version. The shared contracts read no executable: one run
    // judges them, and it is the long tail the hosted job can take.
    const native = { command: ["bun", "scripts/verify-native-codex-runtime.ts"], capped: true, isolated: true, pinned: true, group: NATIVE_GROUP };
    for (const version of env.codexVersions) steps.push({ ...native, name: `native Codex ${version}`, codex: version, selection: "--engine-only" });
    steps.push({ ...native, name: "native Codex shared contracts", selection: "--shared-only", deferrable: true });
  }
  if (supplyChainChanged) {
    steps.push({ name: "audit retry tests", command: ["bun", "test", "./scripts/audit-with-retry.test.ts", "./scripts/supply-chain-check.test.ts"], capped: true, isolated: true });
    steps.push({ name: "supply chain", command: ["bun", "scripts/supply-chain-check.ts", "--base", env.base], capped: true });
  }
  for (const step of steps) {
    if (["privacy", "frozen install"].includes(step.name)) continue;
    step.lane = step.name === "types" || step.name === "eslint" ? "types and lint"
      : ["touched tests", "Linux backend", "Linux tests"].includes(step.name) ? "tests"
      : step.group === NATIVE_GROUP ? step.name
      : ["audit retry tests", "supply chain"].includes(step.name) ? "supply chain" : "runtime";
    step.group = "push checks";
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
  const runtimeChanged = files.some(file => file === "Dockerfile" || file.startsWith("src/runtime-host/") || file.startsWith("bin/"));
  return {
    base, existing, skippedMedia, tests: siblingTests(root, [...files, "scripts/local-gate.ts"]),
    // An empty diff is "run" to the CI scope, where skipping must be proven.
    // Here it is proven: nothing changed, so no platform job has a subject.
    linux: process.platform === "linux" && files.length > 0 && platformScope({ root, workflow: platformFile, prefixes: ["src/lib/proc/"], changed: files }).run,
    runtime: runtimeChanged,
    native: runtimeChanged,
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

/** The Viewer deliberately mounts /var/tmp read-only. Its controller-owned
 * Git hooks can use /tmp instead, without inheriting an operator scratch root.
 * Attempt creation directly so a permission or mount change cannot race a probe.
 */
export function createGateSandbox(
  platform: NodeJS.Platform = process.platform,
  create: (prefix: string) => string = mkdtempSync,
): string {
  try {
    return create(path.join(gateTemporaryRoot(platform), "delegatus-local-gate-"));
  } catch (error) {
    if (platform === "win32" || !["EROFS", "EACCES", "ENOENT"].includes((error as NodeJS.ErrnoException)?.code ?? "")) throw error;
    return create(path.join("/tmp", "delegatus-local-gate-"));
  }
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
  // Preserve explicit slot/queue overrides through isolation. Leave the
  // default unset: gate-slot keeps its shared /var/tmp locks, while the CPU
  // queue remains in the same writable machine cache as the Viewer.
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "LLV_STATE_DIR", "TMPDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) {
    env[key] = path.join(root, key.toLowerCase());
    mkdirSync(env[key]!, { recursive: true });
  }
  delete env.LLV_STATE_OWNER;
  delete env.LLV_GATE_STATE_DIR;
  delete env.LLV_INBOX_DIR;
  delete env.DELEGATUS_STATE_DIR;
  // A Viewer that pushes for a lane carries its own interface language, its
  // launcher handoff and its token. Tests assert the defaults.
  for (const key of ["LLV_LANG", "LLV_LAUNCHER_REEXEC", "LLV_LAUNCHER_CHECKOUT", "LLV_TOKEN", "LLV_DEBUG", "DELEGATUS_DEBUG"]) delete env[key];
  env.CLAUDE_CODE_TMPDIR = env.TMPDIR;
  env.NODE_ENV = "test";
  env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
  // An isolated check, its fixtures and comparator file runs stay on this
  // machine; a remote run already happens one level up (scripts/gate-runner).
  env.LLV_GATE_RUNNER = "off";
  return env;
}

/** One build and its consumers share a private tree. Next holds .next/lock
 * for the whole build; another verifier or an agent may be building the lane
 * already. Never contend on that output, remove its lock, or reuse its result.
 * Copy the current inputs, including staged/unstaged and new files; dependencies
 * are read-only and generated output belongs only to this invocation.
 */
export function createRuntimeCheckTree(root: string, sandbox: string): string {
  const tree = mkdtempSync(path.join(sandbox, "runtime-"));
  const generated = new Set(["node_modules", ".next", "dist", "tsconfig.tsbuildinfo"]);
  try {
    const files = new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
    for (const file of files) {
      if (generated.has(file.split("/")[0]!)) continue;
      const source = path.join(root, file);
      if (!existsSync(source)) continue; // A tracked deletion is a current input too.
      const target = path.join(tree, file);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    }
    symlinkSync(path.join(root, "node_modules"), path.join(tree, "node_modules"), "dir");
    return tree;
  } catch (error) {
    rmSync(tree, { recursive: true, force: true });
    throw error;
  }
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
/** A cold cache installs under machine admission; its queue wait extends
    the execution deadline, while cancellation still stops the installer. */
async function install(command: string[], root: string, env: NodeJS.ProcessEnv, until: number, cancel?: AbortSignal): Promise<void> {
  const outcome = await execute(command, root, env, until, undefined, cancel);
  if (outcome.leaked) throw new ContainmentFailed(`installing ${command.at(-1)}`, outcome.leaked, outcome.cancelled);
  if (outcome.stopped) throw new StoppedPreparing(outcome.ranMs ?? 0);
  if (outcome.code !== 0) throw new Error(`installing ${command.at(-1)} failed (${outcome.code})`);
}
async function pinnedRuntime(root: string, cache: string, until: number, cancel?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const version = pinnedBunVersion(readFileSync(path.join(root, "Dockerfile"), "utf8"));
  const current = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  if (current.status === 0 && current.stdout.trim() === version) return process.execPath;
  const prefix = path.join(cache, `bun-${version}`);
  const binary = path.join(prefix, "node_modules/.bin/bun");
  if (!existsSync(binary)) await install(["bash", "scripts/gate-slot.sh", "npm", "install", "--prefix", prefix, "--no-save", `bun@${version}`], root, env, until, cancel);
  const actual = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (actual.status !== 0 || actual.stdout.trim() !== version) throw new Error("cached Bun does not match Dockerfile pin");
  return binary;
}
export async function codexFixture(root: string, cache: string, version: string, until: number, env: NodeJS.ProcessEnv = process.env, cancel?: AbortSignal): Promise<string> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("native Codex local gate currently requires Linux x64/arm64");
  const prefix = path.join(cache, `codex-${version}`);
  const target = process.arch === "x64" ? "x86_64" : "aarch64";
  const binary = path.join(prefix, `node_modules/@openai/codex-linux-${process.arch}/vendor/${target}-unknown-linux-musl/bin/codex`);
  if (!existsSync(binary)) await install(["bash", path.join(root, "scripts/gate-slot.sh"), "npm", "install", "--prefix", prefix, "--no-save", "--ignore-scripts", `@openai/codex@${version}`], root, env, until, cancel);
  if (!existsSync(binary)) throw new Error("native Codex fixture was not installed");
  return binary;
}
/** Brings origin/main up to date unless the deadline comes first; planning
    then uses the origin/main already present. */
export async function fetchMain(root: string, until: number, deadline?: PushDeadline): Promise<"fetched" | "failed" | "stopped"> {
  const budget = cpuWaitBudget(process.env);
  try {
    const outcome = await execute(["git", "fetch", "origin", "main", "--quiet"], root, budget.env, until, null);
    if (outcome.leaked) throw new ContainmentFailed("fetching origin/main", outcome.leaked);
    return outcome.stopped ? "stopped" : outcome.code === 0 ? "fetched" : "failed";
  } finally {
    // Planning starts a fresh ledger; retain this completed wait before its
    // markers are removed, without changing the original execution budget.
    if (deadline) deadline.cpuWaitMs = (deadline.cpuWaitMs ?? 0) + budget.elapsed();
    budget.close();
  }
}

export interface PushDeadline { at: number; startedAt: number; cpuWaitMs?: number }

/** `LLV_GATE_PUSH_DEADLINE` (Unix ms) is set by a bounded caller such as the
    publication controller. Fetch, installs and checks use that execution
    deadline; CPU queue waits extend it. Nothing starts once its execution
    budget is spent. Local reads (Git plumbing, planning) run outside it.
    Without it main derives the repository's default budget after planning. */
export function pushDeadline(env: Partial<NodeJS.ProcessEnv>, startedAt: number, admitted = false): PushDeadline | null {
  const raw = env.LLV_GATE_PUSH_DEADLINE;
  if (raw === undefined || raw === "") return null;
  const at = Number(raw);
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("LLV_GATE_PUSH_DEADLINE must be a Unix time in milliseconds");
  // The slot supervisor starts a fresh ledger after admission. Read the
  // caller's completed admission interval before starting the check plan.
  const waited = admitted && env.LLV_GATE_ADMISSION_WAIT_ROOTS
    ? cpuInheritedWaitMs({ NODE_ENV: env.NODE_ENV ?? process.env.NODE_ENV, LLV_CPU_WAIT_ROOTS: env.LLV_GATE_ADMISSION_WAIT_ROOTS }) : 0;
  return { at: at + waited, startedAt };
}
const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
export function budgetSeconds(deadline: PushDeadline): number {
  return Math.max(0, Math.round((deadline.at - deadline.startedAt) / 1000));
}
/** Said for every check the push budget left to the hosted job. The colon
    keeps it from reading as a phase marker. */
export function deferredLine(mode: Mode, step: Step, deadline: PushDeadline, outcome: Pick<Outcome, "ranMs" | "preparing">, ref = "<branch>"): string {
  const when = outcome.ranMs === null ? "before it could start"
    : outcome.preparing ? `while it was being prepared after ${seconds(outcome.ranMs)}` : `after it had run ${seconds(outcome.ranMs)}`;
  return `${mode}: left to the hosted job: "${step.name}" was stopped ${when}, when the push budget of ${budgetSeconds(deadline)} s ran out; `
    + `its verdict comes from the "Bun runtime pin" workflow (gh workflow run bun-runtime.yml --ref ${ref})`;
}
/** A decisive step the caller's deadline stopped. The publication reads this
    line as an interrupted push (src/lib/pipelines/git.ts), not as a refusal. */
export const NO_VERDICT_PREFIX = "no verdict within the push budget of ";
export class NoVerdict extends Error {
  constructor(step: Step, deadline: PushDeadline, outcome: Pick<Outcome, "ranMs" | "preparing">) {
    const what = outcome.ranMs === null ? "could not start"
      : outcome.preparing ? `was stopped while it was being prepared after ${seconds(outcome.ranMs)}`
        : `was still running after ${seconds(outcome.ranMs)} and was stopped`;
    super(`${NO_VERDICT_PREFIX}${budgetSeconds(deadline)} s: "${step.name}" ${what}; nothing was judged`);
  }
}
/** A stopped step whose processes outlived the stop: the push fails, since a
    retry would start beside them. */
export class ContainmentFailed extends Error {
  constructor(what: string, leaked: string, cancelled = false) {
    super(`${what} was stopped ${cancelled ? "when another check in its group failed" : "at the push deadline"}, but ${leaked}; stop them before pushing again`);
  }
}
class StoppedPreparing extends Error {
  constructor(readonly ranMs: number) { super("stopped while preparing"); }
}

function cgroupOf(pid: number | "self"): string | null {
  try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3) ?? null; }
  catch { return null; }
}
/** Only ESRCH proves a process gone. /proc, where there is one, also tells a
    zombie (exited, waiting to be reaped) from a running process; unreadable
    metadata proves nothing, so the process counts as running. */
function live(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
}
function procEntries(): number[] | null {
  try { return readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number); } catch { return null; }
}
/** The wall-clock end of one stop. A process-table query is a synchronous
    `ps` where there is no /proc, so each one is capped by what is left. */
interface Cleanup { ends: number; late: boolean }
/** `ps` where there is no /proc (macOS); null when it cannot be read either,
    or not before the cleanup ends. */
function ps(columns: string[], cleanup: Cleanup, environment = false): string[] | null {
  const timeout = cleanup.ends - Date.now();
  if (timeout <= 0) { cleanup.late = true; return null; }
  const args = ["-A", "-ww", ...columns.flatMap(column => ["-o", `${column}=`])];
  // BSD ps appends the environment with -E, procps with the BSD-style `e`.
  if (environment) args.push(process.platform === "linux" ? "e" : "-E");
  const result = spawnSync("ps", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout, killSignal: "SIGKILL" });
  if (result.status !== 0 && Date.now() >= cleanup.ends) cleanup.late = true;
  return result.status === 0 ? result.stdout.split("\n").filter(line => line.trim()) : null;
}
/** Every process that inherited this step's token, wherever it was reparented;
    null when no process table could be read. */
function holders(token: string, cleanup: Cleanup): number[] | null {
  const entries = procEntries();
  if (!entries) {
    const mark = ` ${STEP_TOKEN}=${token}`;
    return ps(["pid", "command"], cleanup, true)?.flatMap(line => {
      const at = line.indexOf(mark), end = line.charAt(at + mark.length);
      return at >= 0 && (end === "" || end === " ") ? [Number(line.trim().split(/\s+/)[0])] : [];
    }) ?? null;
  }
  const mark = `\0${STEP_TOKEN}=${token}\0`;
  return entries.filter(pid => {
    try { return `\0${readFileSync(`/proc/${pid}/environ`, "latin1")}`.includes(mark); } catch { return false; }
  });
}
function scopeMembers(scope: string): number[] {
  try { return readFileSync(path.join("/sys/fs/cgroup", scope, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; }
}
/** The tree under `root`; null when no process table could be read. */
function descendants(root: number, cleanup: Cleanup): number[] | null {
  const children = new Map<number, number[]>();
  const adopt = (pid: number, parent: number) => children.set(parent, [...(children.get(parent) ?? []), pid]);
  const entries = procEntries();
  if (!entries) {
    const table = ps(["pid", "ppid"], cleanup);
    if (!table) return null;
    for (const line of table) { const [pid, parent] = line.trim().split(/\s+/).map(Number); adopt(pid!, parent!); }
  }
  for (const pid of entries ?? []) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      adopt(pid, Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch { /* exited while listed */ }
  }
  const found: number[] = [];
  for (let queue = [root]; queue.length;) for (const child of children.get(queue.shift()!) ?? []) { found.push(child); queue.push(child); }
  return found;
}
/** Each started step carries a token of its own in its environment. */
const STEP_TOKEN = "LLV_GATE_STEP";
/** Stops the step this hook started: its process tree, every process that
    inherited its token, and every transient scope those run in. The work can
    run in a run-*.scope the step's first PID is not in (gate-slot under a
    wrapper or nested in the step), so scopes are read from every member, and
    this hook's own cgroup is never one of them. Resolves by CLEANUP_MS,
    process-table queries included, with what survived, or null once nothing
    did. A process counts as gone only when that is proven: when no process
    table can be read in time, the step's helpers cannot be found, and that
    is what it resolves with. */
const CLEANUP_MS = 3_000;
async function stopStep(pid: number, token: string): Promise<string | null> {
  const own = cgroupOf("self");
  const scopes = new Set<string>(), signalled = new Set<number>([pid]);
  const cleanup: Cleanup = { ends: Date.now() + CLEANUP_MS, late: false };
  let blind = false;
  const sweep = () => {
    const tree = descendants(pid, cleanup), inherited = holders(token, cleanup);
    if (!tree || !inherited) blind = true;
    const members = [...new Set([pid, ...tree ?? [], ...inherited ?? []])].filter(live);
    for (const member of members) {
      signalled.add(member);
      const scope = cgroupOf(member);
      if (scope && scope !== own && scope.endsWith(".scope")) scopes.add(scope);
    }
    for (const member of members) { try { process.kill(member, "SIGKILL"); } catch { /* already gone, or refused: still counted below */ } }
    // Reaches helpers that left the tree and dropped the token as well.
    for (const scope of scopes) { try { writeFileSync(path.join("/sys/fs/cgroup", scope, "cgroup.kill"), "1"); } catch { /* gone, or no cgroup.kill */ } }
  };
  sweep();
  const left = () => {
    const inherited = holders(token, cleanup);
    if (!inherited) blind = true;
    return [...new Set([...signalled, ...inherited ?? [], ...[...scopes].flatMap(scopeMembers)])].filter(live);
  };
  let survivors = left();
  for (let attempt = 1; survivors.length && Date.now() < cleanup.ends; attempt++) {
    await Bun.sleep(Math.min(50, cleanup.ends - Date.now()));
    survivors = left();
    if (attempt % 10 === 0 && survivors.length) sweep();
  }
  const unlisted = blind ? `the processes it started could not be listed (no /proc, and ps ${cleanup.late ? `did not answer within ${seconds(CLEANUP_MS)}` : "failed"}), so they could not be proven stopped` : null;
  if (survivors.length) return `${survivors.length} of its processes (${survivors.slice(0, 8).join(", ")}) are still running${scopes.size ? ` in ${[...scopes].join(", ")}` : ""}${unlisted ? `, and ${unlisted}` : ""}`;
  return unlisted;
}

/** `cancelled`: stopped by `cancel`, never by the deadline. */
interface Outcome { code: number | null; stopped: boolean; ranMs: number | null; preparing?: boolean; leaked?: string; cancelled?: boolean }
/** `log` names the file for the step's output; null discards it; absent shows
    it. `cancel` stops the step at once, as the deadline would. */
async function execute(command: string[], root: string, env: NodeJS.ProcessEnv, until: number, log?: string | null, cancel?: AbortSignal): Promise<Outcome> {
  if (cancel?.aborted) return { code: null, stopped: true, ranMs: null, cancelled: true };
  if (until + cpuInheritedWaitMs(env) <= Date.now()) return { code: null, stopped: true, ranMs: null };
  const started = Date.now();
  const fd = log ? openSync(log, "w") : undefined;
  const token = `${process.pid}-${started}-${Math.random().toString(36).slice(2)}`;
  let stopping = false, cancelled = false, stopTimer: (() => void) | undefined, onCancel: (() => void) | undefined;
  const budget = cpuWaitBudget(env);
  try {
    const output = fd ?? (log === null ? "ignore" : "inherit");
    const child = Bun.spawn({ cmd: command, cwd: root, env: { ...budget.env, [STEP_TOKEN]: token }, stdio: [fd === undefined && log !== null ? "inherit" : "ignore", output, output] });
    let stopped!: (leaked: string | null) => void;
    const stop = new Promise<string | null>(resolve => { stopped = resolve; });
    // A child that already exited keeps nothing to stop, and its PID may be reused.
    const halt = (byCancel: boolean) => {
      if (stopping || child.exitCode !== null || child.signalCode) return;
      stopping = true; cancelled = byCancel;
      void stopStep(child.pid, token).then(stopped);
    };
    if (Number.isFinite(until)) {
      const initialWait = cpuInheritedWaitMs(env);
      stopTimer = cpuBudgetTimer(Math.max(0, until + initialWait - Date.now()), () => Math.max(budget.elapsed(), cpuInheritedWaitMs(env) - initialWait), () => halt(false));
    }
    if (cancel) cancel.addEventListener("abort", onCancel = () => halt(true), { once: true });
    // The stop's own answer is bounded; the child's exit is not when it refuses
    // the signal, so whichever comes first ends the wait.
    const code = await Promise.race([child.exited, stop.then(() => null)]);
    if (!stopping) return { code, stopped: false, ranMs: Date.now() - started };
    const leaked = await stop;
    // A survivor must not hold this hook open: the push ends with its report.
    if (leaked) child.unref();
    else await child.exited;
    return { code: null, stopped: true, ranMs: Date.now() - started, ...(leaked ? { leaked } : {}), ...(cancelled ? { cancelled } : {}) };
  } finally {
    stopTimer?.(); budget.close();
    if (onCancel) cancel!.removeEventListener("abort", onCancel);
    if (fd !== undefined) closeSync(fd);
  }
}

export interface Prepared { command: string[]; env: NodeJS.ProcessEnv; root?: string }

/** Only a complete comparator verdict can authorize a flaky phase retry.
 * New assertions, broken runners and failed cleanup remain decisive. */
function comparatorAllowsFlakyRetry(output: string): boolean {
  const summary = /^touched-tests: (\d+) new failures, \d+ pre-existing failures, \d+ fixed, \d+ removed\/skipped, (\d+) flaky$/m.exec(output);
  if (!summary || Number(summary[1]) < 1 || Number(summary[2]) < 1 || !/^FLAKY /m.test(output)) return false;
  const failures = output.split("\n").filter(line => line.startsWith("NEW "));
  return failures.length === Number(summary[1])
    && failures.every(line => /^NEW .+: <between-tests error> /.test(line))
    && !/gate error \(blocking\)|surviving owned processes|survived teardown|budget cleanup failed|guardian.*(?:failed|could not|surviving)/.test(output);
}

const comparableStep = (step: Step) => ["touched tests", "Linux tests", "native Codex shared contracts"].includes(step.name);
/** Prepares a step without running it past `until`; an installation the
    deadline stops is reported as a step that was being prepared. */
async function prepared(prepare: RunOptions["prepare"], step: Step, until: number, cancel?: AbortSignal, waitEnv = process.env): Promise<Prepared | Outcome> {
  if (cancel?.aborted) return { code: null, stopped: true, ranMs: null, cancelled: true };
  if (until + cpuInheritedWaitMs(waitEnv) <= Date.now()) return { code: null, stopped: true, ranMs: null };
  try { return await prepare(step, until, cancel, waitEnv); }
  catch (error) {
    if (error instanceof StoppedPreparing) return { code: null, stopped: true, ranMs: error.ranMs, preparing: true, ...(cancel?.aborted ? { cancelled: true } : {}) };
    throw error;
  }
}
const isOutcome = (value: Prepared | Outcome): value is Outcome => "stopped" in value;
interface PassRecord { at: string }
export interface StepPasses { reused(step: Step, until?: number): boolean; passed(step: Step): void }
/** Only checks with no output dependency are independent. The private build
 * and its consumers reuse together; a partial runtime run rebuilds afresh.
 * Privacy, install and advisory data always receive a fresh observation.
 */
export function stepPasses(root: string, base: string, steps: readonly Step[], say: (line: string) => void, env: NodeJS.ProcessEnv = process.env): StepPasses {
  const checkEnv = checkEnvironment(env);
  const store = new GateCache<PassRecord>(cacheDirectory(root, "passes"), (value): value is PassRecord =>
    !!value && typeof value === "object" && "at" in value && typeof value.at === "string" && Number.isFinite(Date.parse(value.at)));
  const toolRoot = path.resolve(import.meta.dir, "..");
  const toolFiles = gateToolFiles(toolRoot);
  const reusable = (step: Step) => !["privacy", "frozen install", "supply chain", "staged whitespace"].includes(step.name);
  let unavailableReason = "dirty worktree";
  const snapshot = () => {
    try {
      if (git(root, ["ls-files", "-v"]).split("\n").some(line => /^[a-zS] /.test(line))) return;
      const status = git(root, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
      if (status) { unavailableReason = "dirty worktree"; return; }
      if (git(root, ["merge-base", "HEAD", "origin/main"]) !== base) { unavailableReason = "base changed"; return; }
      const head = git(root, ["rev-parse", "HEAD"]), tree = git(root, ["rev-parse", "HEAD^{tree}"]);
      const runtimeCache = path.join(env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "delegatus-gate");
      const pins = steps.filter(step => step.pinned).length && existsSync(path.join(root, "Dockerfile"))
        ? [path.join(runtimeCache, `bun-${pinnedBunVersion(readFileSync(path.join(root, "Dockerfile"), "utf8"))}/node_modules/.bin/bun`)] : [];
      for (const version of new Set(steps.flatMap(step => step.codex ? [step.codex] : []))) {
        const target = process.arch === "x64" ? "x86_64" : "aarch64";
        pins.push(path.join(runtimeCache, `codex-${version}/node_modules/@openai/codex-linux-${process.arch}/vendor/${target}-unknown-linux-musl/bin/codex`));
      }
      const which = (name: string) => Bun.which(name, { PATH: checkEnv.PATH ?? "" });
      const tools = [process.execPath, which("bun"), which("bunx"), which("node"), which("git"), ...pins,
        ...["node_modules/.bun/lock", "node_modules/typescript/package.json", "node_modules/eslint/package.json"].map(file => path.join(root, file))];
      // Hash what the checks receive, never store its values. Execution roots,
      // deadlines and CPU tickets belong to a run, rather than its result.
      const environment = environmentFingerprint(checkEnv);
      const toolchain = [...tools.map(file => file ? fileFingerprint(file) : "missing"), ...toolFiles.map(file => fileFingerprint(path.join(toolRoot, file)))];
      return { head, tree, key: fingerprint([3, head, tree, base, spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: root, encoding: "utf8" }).stdout, Bun.version, process.platform, process.arch, toolchain, installedFingerprint(root), workingInputsFingerprint(root), environment,
        spawnSync("git", ["config", "--get-regexp", "^remote\\."], { cwd: root, encoding: "utf8" }).stdout] ) };
    } catch (error) { unavailableReason = error instanceof Error ? error.name : "input fingerprint unavailable"; return; }
  };
  const initial = snapshot();
  const key = (step: Step) => fingerprint([initial?.key, step]);
  const runtime = steps.filter(step => step.lane === "runtime");
  // Hold the complete runtime verdict for this invocation: eviction must not
  // make a consumer run after its private build was skipped.
  const runtimeRecords = new Map(runtime.map(step => [key(step), store.read(key(step))]));
  const runtimeComplete = runtime.every(step => runtimeRecords.get(key(step)));
  if (!initial) say("pre-push: pass reuse disabled: worktree is dirty or inputs could not be fingerprinted (" + unavailableReason + ")");
  const current = () => initial && snapshot()?.key === initial.key;
  return {
    reused(step, until = Infinity) {
      if (Date.now() >= until || !initial || !reusable(step) || (step.lane === "runtime" && !runtimeComplete)) return false;
      const record = step.lane === "runtime" ? runtimeRecords.get(key(step)) : store.read(key(step));
      if (!record || !current() || Date.now() >= until) return false;
      say(`pre-push: ${step.name}: reused pass from ${record.at} for tree ${initial.tree.slice(0, 12)} against base ${base.slice(0, 12)}; identical inputs, skipped`);
      return true;
    },
    passed(step) {
      if (initial && reusable(step) && current()) store.write(key(step), { at: new Date().toISOString() });
    },
  };
}

interface RunOptions {
  root: string; deadline: PushDeadline | null; logDir: string; say?: (line: string) => void; ref?: string;
  /** The other half of publication refused; stop owned work before returning. */
  cancel?: AbortSignal;
  passes?: StepPasses;
  /** Anything it waits on ends by `until`, or at once on `cancel`, through the
      installers above. */
  prepare: (step: Step, until: number, cancel?: AbortSignal, waitEnv?: NodeJS.ProcessEnv) => Prepared | Promise<Prepared>;
}
/** Runs the plan in order. A group runs at once and is reported once all of
    it has settled. Resolves with the checks left to the hosted job. A member's
    own verdict carries a colon, so the publication never reads it as the
    phase the hook was in. */
export async function runSteps(mode: Mode, steps: readonly Step[], options: RunOptions): Promise<string[]> {
  const { root, deadline, logDir, prepare } = options;
  const say = options.say ?? ((line: string) => console.error(line));
  const deferred: string[] = [];
  const budget = cpuWaitBudget(process.env);
  const withBudget = (env: NodeJS.ProcessEnv) => ({ ...env, LLV_CPU_WAIT_ROOTS: budget.env.LLV_CPU_WAIT_ROOTS });
  try {
    // A stopped step is deferred when the hosted job also runs it, and is a
    // missing verdict otherwise.
    const until = deadline ? deadline.at + (deadline.cpuWaitMs ?? 0) : Infinity;
    const runPrepared = async (step: Step, ready: Prepared, log: string | undefined, cancel?: AbortSignal): Promise<Outcome> => {
      const run = (destination: string | undefined) => execute(ready.command, ready.root ?? root, withBudget(ready.env), until, destination, cancel);
      const first = await run(log);
      if (mode !== "pre-push" || first.code !== 1 || first.stopped || first.leaked || cancel?.aborted
        || !comparableStep(step) || !log || !existsSync(log)) return first;
      const original = readFileSync(log, "utf8");
      if (!comparatorAllowsFlakyRetry(original)) return first;
      say(`${mode}: ${step.name}: comparator reported an intermittent diagnostic; retrying the check once in fresh isolation`);
      for (const line of original.split("\n").filter(line => line.startsWith("FLAKY "))) say(line);
      const retryLog = `${log}.retry`;
      const retry = await run(retryLog);
      if (retry.leaked) {
        if (existsSync(retryLog)) writeFileSync(log, readFileSync(retryLog));
        return retry;
      }
      if (retry.stopped || retry.cancelled) {
        // A retry without a verdict cannot erase the first decisive refusal,
        // even if another lane reached the group's deadline first.
        say(`${mode}: ${step.name}: failed (1); flaky retry got no verdict, retaining the comparator refusal`);
        for (const line of original.split("\n").filter(line => line.startsWith("NEW "))) say(line);
        return first;
      }
      if (existsSync(retryLog)) writeFileSync(log, readFileSync(retryLog));
      say(`${mode}: ${step.name}: automatic flaky retry ${retry.code === 0 ? "passed" : "failed"}`);
      return retry;
    };
    const settle = (step: Step, outcome: Outcome) => {
      if (outcome.leaked) throw new ContainmentFailed(`"${step.name}"`, outcome.leaked);
      if (!outcome.stopped || !deadline) return outcome.code === 0;
      if (!step.deferrable) throw new NoVerdict(step, deadline, outcome);
      say(deferredLine(mode, step, deadline, outcome, options.ref));
      deferred.push(step.name);
      return true;
    };
    for (let index = 0; index < steps.length;) {
      if (options.cancel?.aborted) return deferred;
      const step = steps[index]!;
      let end = index + 1;
      if (step.group) while (end < steps.length && steps[end]!.group === step.group) end++;
      const group = steps.slice(index, end);
      index = end;
      say(`${mode}: ${step.group ?? step.name}`);
      if (!step.group) {
        if (options.passes?.reused(step, until + cpuInheritedWaitMs(budget.env))) continue;
        const ready = await prepared(prepare, step, until, options.cancel, budget.env);
        const log = mode === "pre-push" && comparableStep(step) ? path.join(logDir, `${step.name.replace(/[^\w.-]+/g, "-")}.log`) : undefined;
        const outcome = isOutcome(ready) ? ready : await runPrepared(step, ready, log, options.cancel);
        if (log && existsSync(log)) {
          const output = readFileSync(log, "utf8").trimEnd();
          if (output) say(output);
        }
        if (outcome.cancelled) {
          if (outcome.leaked) throw new ContainmentFailed(`"${step.name}"`, outcome.leaked, true);
          return deferred;
        }
        if (!settle(step, outcome)) throw new Error(`${isOutcome(ready) ? step.name : ready.command[0]} failed (${outcome.code})`);
        if (!outcome.stopped && outcome.code === 0) options.passes?.passed(step);
        continue;
      }
      // Grouped steps take their machine admission together and wait for none
      // of each other; each writes its own log, shown when it failed.
      const members = group.map(member => ({ member, log: path.join(logDir, `${member.name.replace(/[^\w.-]+/g, "-")}.log`) }));
      // A member that cannot be prepared or started stops the rest of its group,
      // and the group is reported once every member has settled: nothing a
      // member started may outlive the hook unreported.
      const cancel = new AbortController(), errors = new Map<number, unknown>();
      const onCancel = () => cancel.abort();
      options.cancel?.addEventListener("abort", onCancel, { once: true });
      if (options.cancel?.aborted) cancel.abort();
      const lanes = new Map<string, Promise<Outcome | null>>();
      const pending = members.map(({ member, log }, at) => {
        const predecessor = member.lane ? lanes.get(member.lane) : undefined;
        const run = (async () => {
          await predecessor;
          if (cancel.signal.aborted) return { code: null, stopped: true, ranMs: null, cancelled: true };
          const started = Date.now();
          try {
            if (options.passes?.reused(member, until + cpuInheritedWaitMs(budget.env))) return { code: 0, stopped: false, ranMs: 0 };
            const ready = await prepared(prepare, member, until, cancel.signal, budget.env);
            const outcome = isOutcome(ready) ? ready : await runPrepared(member, ready, log, cancel.signal);
            if (!outcome.cancelled && !settle(member, outcome)) throw new Error(String(outcome.code));
            if (!outcome.stopped && ["touched tests", "Linux tests", "eslint"].includes(member.name) && existsSync(log)) say(readFileSync(log, "utf8").trimEnd());
            if (!outcome.stopped && !outcome.cancelled && outcome.code === 0) options.passes?.passed(member);
            if (!outcome.stopped) say(`${mode}: ${member.name}: passed in ${seconds(Date.now() - started)}`);
            return outcome;
          } catch (error) { errors.set(at, error); cancel.abort(); return null; }
        })();
        if (member.lane) lanes.set(member.lane, run);
        return run;
      });
      const outcomes = await Promise.all(pending);
      options.cancel?.removeEventListener("abort", onCancel);
      if (!errors.size) for (const [at, outcome] of outcomes.entries()) {
        if (outcome?.leaked) throw new ContainmentFailed(`"${members[at]!.member.name}"`, outcome.leaked, outcome.cancelled);
      }
      if (errors.size) {
        const [first, error] = [...errors][0]!, culprit = members[first]!.member.name;
        const reason = error instanceof Error ? error.message : String(error);
        if (!(error instanceof NoVerdict)) say(`${mode}: ${culprit}: failed (${reason})`);
        if (existsSync(members[first]!.log)) say(readFileSync(members[first]!.log, "utf8").trimEnd());
        let leak: ContainmentFailed | undefined;
        members.forEach(({ member }, at) => {
          const outcome = outcomes[at], other = errors.get(at);
          if (at !== first && other instanceof ContainmentFailed) leak ??= other;
          if (outcome?.leaked) leak ??= new ContainmentFailed(`"${member.name}"`, outcome.leaked, outcome.cancelled);
          if (outcome?.cancelled) say(`${mode}: ${member.name}: stopped when "${culprit}" failed; nothing was judged`);
        });
        if (leak) throw leak;
        if (error instanceof ContainmentFailed) throw error;
        if (error instanceof NoVerdict) throw error;
        throw new Error(`"${culprit}" failed: ${reason}`);
      }
    }
    if (deferred.length) say(`${mode}: passed; left to the hosted job: ${deferred.join(", ")}`);
    return deferred;
  } finally { budget.close(); }
}

/** The hook's last line and exit code for what stopped it: a missing verdict
    exits 75, anything else fails the gate. */
export function endingOf(mode: Mode, error: unknown): { line: string; code: number } {
  if (error instanceof NoVerdict) return { line: `${mode}: ${error.message}`, code: 75 };
  return { line: `${mode}: ${error instanceof Error ? error.message : error}; gate failed`, code: 1 };
}

/** Exits at once: a stopped step's survivor must not hold the push open. */
class AdmittedGateFailed extends Error {
  constructor(readonly code: number) { super(`admitted checks exited ${code}`); }
}

/** One ledger spans the slot handoff. Nested supervisors may create their
 * own ledgers; the admitted hook still credits this invocation's queue wait.
 * Cancellation remains owned by execute throughout admission and execution. */
export async function runAdmittedChecks(command: string[], root: string, env: NodeJS.ProcessEnv, deadline: PushDeadline | null, cancel?: AbortSignal): Promise<void> {
  const budget = cpuWaitBudget(env);
  console.error("pre-push: CPU admission for publication checks");
  try {
    const outcome = await execute(command, root, {
      ...budget.env, LLV_GATE_ADMISSION_WAIT_ROOTS: budget.env.LLV_CPU_WAIT_ROOTS,
      ...(deadline ? { LLV_GATE_PUSH_DEADLINE: String(deadline.at + (deadline.cpuWaitMs ?? 0)) } : {}),
      LLV_OWNED_RUN_TIMEOUT_MS: String(deadline ? Math.max(1, deadline.at + (deadline.cpuWaitMs ?? 0) - Date.now()) : 15 * 60 * 1000),
    }, Infinity, undefined, cancel);
    if (outcome.leaked) throw new ContainmentFailed("admitted checks", outcome.leaked, outcome.cancelled);
    if (outcome.cancelled) return;
    if (outcome.code !== 0) throw new AdmittedGateFailed(outcome.code ?? 1);
  } finally {
    console.error(`pre-push: publication checks CPU wait: ${Math.round(budget.elapsed())} ms (excluded from execution budget)`);
    budget.close();
  }
}

/** Both verdicts are mandatory. Refusal cancels the peer and waits for its
 * owned cleanup; a cleanup failure takes precedence over the initial refusal.
 * Preserve the original error so privacy keeps its refusal text and exit code.
 */
export async function runPushPair(privacy: (cancel: AbortSignal) => Promise<unknown>, checks: (cancel: AbortSignal) => Promise<unknown>): Promise<void> {
  const cancel = new AbortController();
  let first: unknown;
  let failed = false;
  const run = async (half: typeof privacy) => {
    try { await half(cancel.signal); }
    catch (error) {
      if (!failed) { failed = true; first = error; }
      cancel.abort();
      throw error;
    }
  };
  const results = await Promise.allSettled([run(privacy), run(checks)]);
  for (const result of results) if (result.status === "rejected" && result.reason instanceof ContainmentFailed) throw result.reason;
  if (failed) throw first;
}

export function endHook(mode: Mode, error: unknown): never {
  if (error instanceof AdmittedGateFailed) process.exit(error.code);
  const { line, code } = endingOf(mode, error);
  console.error(line);
  process.exit(code);
}

async function main(mode: Mode, admitted = false): Promise<void> {
  if (process.env.LLV_SKIP_HOOKS === "1") return;
  let deadline = pushDeadline(process.env, Date.now(), admitted);
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (mode === "pre-push" && process.env.LLV_GATE_PUSH_HEAD && process.env.LLV_GATE_PUSH_HEAD !== git(root, ["rev-parse", "HEAD"])) {
    throw new Error("pushed head differs from checkout");
  }
  let base = mode === "pre-commit" ? git(root, ["merge-base", "HEAD", "origin/main"]) : "HEAD";
  const until = deadline?.at ?? Infinity;
  if (mode === "pre-push" && !admitted) {
    const fetch = await fetchMain(root, until, deadline ?? undefined);
    if (fetch === "failed") console.warn("pre-push: fetch failed; using the last origin/main (base resolution must still succeed)");
    if (fetch === "stopped") console.warn("pre-push: fetch stopped at the push deadline; using the last origin/main");
    base = git(root, ["merge-base", "HEAD", "origin/main"]);
    const behind = Number(git(root, ["rev-list", "--count", "HEAD..origin/main"]));
    if (behind) console.warn(`pre-push: branch is ${behind} commit(s) behind origin/main; the hosted privacy gate may flag main-only commits. Merge origin/main before pushing.`);
  }
  if (admitted) base = git(root, ["merge-base", "HEAD", "origin/main"]);
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
  if (mode === "pre-push" && !deadline) {
    const startedAt = Date.now();
    deadline = { startedAt, at: publicationHookDeadline(publicationPushBudgetMs(files), startedAt) };
  }
  if (mode === "pre-push" && !files.length) console.error(`pre-push: nothing changed since ${base.slice(0, 12)}; checking the pushed commits for privacy only`);
  if (mode === "pre-push" && files.length && files.every(proseOnly)) console.error("pre-push: prose-only diff; types, lint and touched tests skipped because no compiler or executable source input changed");
  const cache = path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "delegatus-gate");
  // Installed on first use, inside the step that needs it and by its deadline.
  let runtime: Promise<string> | undefined;
  let runtimeTree: string | undefined;
  const fixtures = new Map<string, Promise<string>>();
  const sandbox = createGateSandbox();
  try {
    // Pre-push checks see one canonical environment, so a producer's pass and
    // the publication of the same tree share a key (scripts/gate-cache.ts).
    const isolated = isolatedEnvironment(sandbox, mode === "pre-push" ? checkEnvironment(process.env) : process.env);
    const privacyEnv = {
      ...process.env,
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(root, "scripts/privacy-known-value-fingerprints.json"),
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
    };
    const prepare = async (step: Step, until: number, cancel?: AbortSignal, waitEnv = process.env) => {
      const command = [...step.command];
      const env: NodeJS.ProcessEnv = { ...(step.isolated || mode === "pre-push" && !["privacy", "frozen install", "supply chain"].includes(step.name) ? isolated : process.env), LLV_CPU_WAIT_ROOTS: waitEnv.LLV_CPU_WAIT_ROOTS };
      if (step.name === "privacy") Object.assign(env, privacyEnv);
      if (step.pinned) {
        runtime ??= pinnedRuntime(root, cache, until, cancel, env);
        command[0] = await runtime;
        env.PATH = `${path.dirname(command[0])}${path.delimiter}${env.PATH ?? ""}`;
      }
      if (step.name === "runtime host") command.push("--runtime", command[0]!);
      if (step.codex) {
        // Members of one group share a version's install instead of racing on its prefix.
        if (!fixtures.has(step.codex)) fixtures.set(step.codex, codexFixture(root, cache, step.codex, until, env, cancel));
        command.push(await fixtures.get(step.codex)!);
      }
      if (step.selection) command.push(step.selection);
      if (step.selection === "--shared-only") env.LLV_GATE_COMPARE_BASE = base;
      if (step.name === "Viewer build") Object.assign(env, { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_RUNTIME_UI: "1" });
      // Missing named tests must not shrink a green `bun test` run.
      if (command[1] === "test") {
        if (command.length < 3) throw new Error("refusing an empty test list");
        for (const file of command.slice(2)) {
          if (!isTest(file) || !existsSync(path.resolve(root, file))) throw new Error(`missing or invalid test path: ${file}`);
        }
      }
      const usesBuild = ["Viewer build", "MCP size budgets", "Viewer runtime", "runtime host", "runtime negative controls"].includes(step.name);
      if (usesBuild) runtimeTree ??= createRuntimeCheckTree(root, sandbox);
      return { command: step.capped ? ["bash", "scripts/gate-slot.sh", ...command] : command, env, ...(usesBuild ? { root: runtimeTree } : {}) };
    };
    const branch = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim();
    const passes = admitted ? stepPasses(root, base, steps, console.error) : undefined;
    const options = { root, deadline, logDir: sandbox, prepare, passes, ...(branch ? { ref: branch } : {}) };
    if (mode === "pre-push" && !admitted) {
      const privacy = (cancel?: AbortSignal) => runSteps(mode, steps.filter(step => step.name === "privacy"), { ...options, cancel });
      const localChecks = (cancel: AbortSignal) => runAdmittedChecks(
        ["bash", "scripts/gate-slot.sh", process.execPath, "scripts/local-gate.ts", "pre-push", "--admitted"], root,
        { ...process.env, LLV_GATE_RUNNER: "off" }, deadline, cancel);
      const execution = process.env.LLV_GATE_EXECUTION ?? (await checkExecutionSettings(root, process.env.LLV_GATE_LANE_ID, process.env.LLV_GATE_STAGE_ID)).effective;
      if (execution !== "cloud" && execution !== "local") throw new Error("invalid check execution setting");
      const config = execution === "cloud" && steps.some(step => step.name !== "privacy")
        ? await cloudCheckConfig(root, process.env.LLV_GATE_LANE_ID, process.env.LLV_GATE_STAGE_ID) : null;
      const privacyHead = git(root, ["rev-parse", "HEAD"]);
      const checks = async (cancel: AbortSignal) => {
        if (!config) return localChecks(cancel);
        const head = git(root, ["rev-parse", "HEAD"]);
        if (head !== privacyHead) throw new Error("source changed during privacy checks");
        const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
        // A moving or dirty checkout cannot be mistaken for the pushed tree.
        if (git(root, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Cloud publication checks require a clean checkout");
        const destination = path.join(sandbox, "source.bundle");
        git(root, ["bundle", "create", destination, "HEAD", `^${base}`]);
        const bundle = readFileSync(destination).toString("base64");
        console.error("pre-push: Cloud checks");
        const code = await runCloudChecks({ head, tree, base, bundle, timeoutMs: Math.max(1, (deadline?.at ?? Date.now() + 15 * 60_000) - Date.now()) },
          new AppServerCloudTransport(config), async () => {
            console.error("pre-push: Cloud unavailable after confirmation; running the same checks locally once");
            await localChecks(cancel); return 0;
          }, cancel);
        if (git(root, ["rev-parse", "HEAD"]) !== head || git(root, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("source changed during Cloud checks");
        if (code !== 0) throw new AdmittedGateFailed(code);
      };
      if (steps.some(step => step.name !== "privacy")) {
        if (config) {
          await privacy();
          await checks(new AbortController().signal);
        } else await runPushPair(privacy, checks);
      } else await privacy();
    } else {
      await runSteps(mode, admitted ? steps.filter(step => step.name !== "privacy") : steps, options);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "pre-commit" && mode !== "pre-push") throw new Error("usage: local-gate.ts pre-commit|pre-push");
  try { await main(mode, process.argv[3] === "--admitted"); } catch (error) { endHook(mode, error); }
}
