import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  /** Passed after the Codex fixture path. */
  selection?: string;
  /** Consecutive steps with the same group run at once, under one phase marker. */
  group?: string;
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
  if (env.native && env.codexVersions.length) {
    // Only the engine files start the Codex executable, so only they run once
    // per supported version. The shared contracts read no executable: one run
    // judges them, and it is the long tail the hosted job can take.
    const native = { command: ["bun", "scripts/verify-native-codex-runtime.ts"], capped: true, isolated: true, pinned: true, group: NATIVE_GROUP };
    for (const version of env.codexVersions) steps.push({ ...native, name: `native Codex ${version}`, codex: version, selection: "--engine-only" });
    steps.push({ ...native, name: "native Codex shared contracts", codex: env.codexVersions[0], selection: "--shared-only", deferrable: true });
  }
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
  return env;
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
/** A cold cache installs under machine admission, which can hold it for as
    long as the machine is busy: the install ends by the push deadline too. */
async function install(command: string[], root: string, env: NodeJS.ProcessEnv, until: number): Promise<void> {
  const outcome = await execute(command, root, env, until);
  if (outcome.leaked) throw new ContainmentFailed(`installing ${command.at(-1)}`, outcome.leaked);
  if (outcome.stopped) throw new StoppedPreparing(outcome.ranMs ?? 0);
  if (outcome.code !== 0) throw new Error(`installing ${command.at(-1)} failed (${outcome.code})`);
}
async function pinnedRuntime(root: string, cache: string, until: number, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const version = pinnedBunVersion(readFileSync(path.join(root, "Dockerfile"), "utf8"));
  const current = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  if (current.status === 0 && current.stdout.trim() === version) return process.execPath;
  const prefix = path.join(cache, `bun-${version}`);
  const binary = path.join(prefix, "node_modules/.bin/bun");
  if (!existsSync(binary)) await install(["bash", "scripts/gate-slot.sh", "npm", "install", "--prefix", prefix, "--no-save", `bun@${version}`], root, env, until);
  const actual = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (actual.status !== 0 || actual.stdout.trim() !== version) throw new Error("cached Bun does not match Dockerfile pin");
  return binary;
}
export async function codexFixture(root: string, cache: string, version: string, until: number, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("native Codex local gate currently requires Linux x64/arm64");
  const prefix = path.join(cache, `codex-${version}`);
  const target = process.arch === "x64" ? "x86_64" : "aarch64";
  const binary = path.join(prefix, `node_modules/@openai/codex-linux-${process.arch}/vendor/${target}-unknown-linux-musl/bin/codex`);
  if (!existsSync(binary)) await install(["bash", path.join(root, "scripts/gate-slot.sh"), "npm", "install", "--prefix", prefix, "--no-save", "--ignore-scripts", `@openai/codex@${version}`], root, env, until);
  if (!existsSync(binary)) throw new Error("native Codex fixture was not installed");
  return binary;
}
/** Brings origin/main up to date unless the deadline comes first; planning
    then uses the origin/main already present. */
export async function fetchMain(root: string, until: number): Promise<"fetched" | "failed" | "stopped"> {
  const outcome = await execute(["git", "fetch", "origin", "main", "--quiet"], root, process.env, until, null);
  if (outcome.leaked) throw new ContainmentFailed("fetching origin/main", outcome.leaked);
  return outcome.stopped ? "stopped" : outcome.code === 0 ? "fetched" : "failed";
}

export interface PushDeadline { at: number; startedAt: number }

/** `LLV_GATE_PUSH_DEADLINE` (Unix ms) is set by a caller that kills the push
    at a limit of its own, as the controller's publication does. Everything
    that can wait on the network, on machine admission or on a check then ends
    by it: the fetch of origin/main, a cold-cache Bun or Codex install, and
    every step. Nothing starts once it has passed. Only local reads (git's own
    plumbing, planning) run outside it. Without it nothing is stopped and every
    step reaches its verdict. */
export function pushDeadline(env: Partial<NodeJS.ProcessEnv>, startedAt: number): PushDeadline | null {
  const raw = env.LLV_GATE_PUSH_DEADLINE;
  if (raw === undefined || raw === "") return null;
  const at = Number(raw);
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("LLV_GATE_PUSH_DEADLINE must be a Unix time in milliseconds");
  return { at, startedAt };
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
  constructor(what: string, leaked: string) {
    super(`${what} was stopped at the push deadline, but ${leaked}; stop them before pushing again`);
  }
}
class StoppedPreparing extends Error {
  constructor(readonly ranMs: number) { super("stopped while preparing"); }
}

function cgroupOf(pid: number | "self"): string | null {
  try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3) ?? null; }
  catch { return null; }
}
function live(pid: number): boolean {
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}
/** Every process that inherited this step's token, wherever it was reparented. */
function holders(token: string): number[] {
  const mark = `\0${STEP_TOKEN}=${token}\0`;
  let entries: string[] = [];
  try { entries = readdirSync("/proc").filter(name => /^\d+$/.test(name)); } catch { return []; }
  return entries.map(Number).filter(pid => {
    try { return `\0${readFileSync(`/proc/${pid}/environ`, "latin1")}`.includes(mark); } catch { return false; }
  });
}
function scopeMembers(scope: string): number[] {
  try { return readFileSync(path.join("/sys/fs/cgroup", scope, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; }
}
function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  let entries: string[] = [];
  try { entries = readdirSync("/proc").filter(name => /^\d+$/.test(name)); } catch { return []; }
  for (const name of entries) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
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
    this hook's own cgroup is never one of them. Resolves with what survived,
    or null once nothing did. */
async function stopStep(pid: number, token: string): Promise<string | null> {
  const own = cgroupOf("self");
  const scopes = new Set<string>();
  const sweep = () => {
    const members = [...new Set([pid, ...descendants(pid), ...holders(token)])].filter(live);
    for (const member of members) {
      const scope = cgroupOf(member);
      if (scope && scope !== own && scope.endsWith(".scope")) scopes.add(scope);
    }
    for (const member of members) { try { process.kill(member, "SIGKILL"); } catch { /* already gone */ } }
    // Reaches helpers that left the tree and dropped the token as well.
    for (const scope of scopes) { try { writeFileSync(path.join("/sys/fs/cgroup", scope, "cgroup.kill"), "1"); } catch { /* gone, or no cgroup.kill */ } }
  };
  sweep();
  const left = () => [...new Set([pid, ...holders(token), ...[...scopes].flatMap(scopeMembers)])].filter(live);
  for (let attempt = 1; attempt <= 60; attempt++) {
    await Bun.sleep(50);
    if (!left().length) return null;
    if (attempt % 10 === 0) sweep();
  }
  const survivors = left();
  return survivors.length ? `${survivors.length} of its processes (${survivors.slice(0, 8).join(", ")}) are still running${scopes.size ? ` in ${[...scopes].join(", ")}` : ""}` : null;
}

interface Outcome { code: number | null; stopped: boolean; ranMs: number | null; preparing?: boolean; leaked?: string }
/** `log` names the file for the step's output; null discards it; absent shows it. */
async function execute(command: string[], root: string, env: NodeJS.ProcessEnv, until: number, log?: string | null): Promise<Outcome> {
  if (until <= Date.now()) return { code: null, stopped: true, ranMs: null };
  const started = Date.now();
  const fd = log ? openSync(log, "w") : undefined;
  const token = `${process.pid}-${started}-${Math.random().toString(36).slice(2)}`;
  let stopping: Promise<string | null> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = fd ?? (log === null ? "ignore" : "inherit");
    const child = Bun.spawn({ cmd: command, cwd: root, env: { ...env, [STEP_TOKEN]: token }, stdio: [fd === undefined && log !== null ? "inherit" : "ignore", output, output] });
    // A child that already exited keeps nothing to stop, and its PID may be reused.
    if (Number.isFinite(until)) timer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) stopping = stopStep(child.pid, token); }, Math.max(0, until - Date.now()));
    const code = await child.exited;
    if (!stopping) return { code, stopped: false, ranMs: Date.now() - started };
    const leaked = await stopping;
    return { code: null, stopped: true, ranMs: Date.now() - started, ...(leaked ? { leaked } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
    if (fd !== undefined) closeSync(fd);
  }
}

export interface Prepared { command: string[]; env: NodeJS.ProcessEnv }
/** Prepares a step without running it past `until`; an installation the
    deadline stops is reported as a step that was being prepared. */
async function prepared(prepare: RunOptions["prepare"], step: Step, until: number): Promise<Prepared | Outcome> {
  if (until <= Date.now()) return { code: null, stopped: true, ranMs: null };
  try { return await prepare(step, until); }
  catch (error) { if (error instanceof StoppedPreparing) return { code: null, stopped: true, ranMs: error.ranMs, preparing: true }; throw error; }
}
const isOutcome = (value: Prepared | Outcome): value is Outcome => "stopped" in value;
interface RunOptions {
  root: string; deadline: PushDeadline | null; logDir: string; say?: (line: string) => void; ref?: string;
  /** Anything it waits on ends by `until`, through the installers above. */
  prepare: (step: Step, until: number) => Prepared | Promise<Prepared>;
}
/** Runs the plan in order. A group runs at once and is reported once all of
    it has settled. Resolves with the checks left to the hosted job. A member's
    own verdict carries a colon, so the publication never reads it as the
    phase the hook was in. */
export async function runSteps(mode: Mode, steps: readonly Step[], options: RunOptions): Promise<string[]> {
  const { root, deadline, logDir, prepare } = options;
  const say = options.say ?? ((line: string) => console.error(line));
  const deferred: string[] = [];
  // A stopped step is deferred when the hosted job also runs it, and is a
  // missing verdict otherwise.
  const until = deadline?.at ?? Infinity;
  const settle = (step: Step, outcome: Outcome) => {
    if (outcome.leaked) throw new ContainmentFailed(`"${step.name}"`, outcome.leaked);
    if (!outcome.stopped || !deadline) return outcome.code === 0;
    if (!step.deferrable) throw new NoVerdict(step, deadline, outcome);
    say(deferredLine(mode, step, deadline, outcome, options.ref));
    deferred.push(step.name);
    return true;
  };
  for (let index = 0; index < steps.length;) {
    const step = steps[index]!;
    let end = index + 1;
    if (step.group) while (end < steps.length && steps[end]!.group === step.group) end++;
    const group = steps.slice(index, end);
    index = end;
    say(`${mode}: ${step.group ?? step.name}`);
    if (!step.group) {
      const ready = await prepared(prepare, step, until);
      const outcome = isOutcome(ready) ? ready : await execute(ready.command, root, ready.env, until);
      if (!settle(step, outcome)) throw new Error(`${isOutcome(ready) ? step.name : ready.command[0]} failed (${outcome.code})`);
      continue;
    }
    // Grouped steps take their machine admission together and wait for none
    // of each other; each writes its own log, shown when it failed.
    const members = group.map(member => ({ member, log: path.join(logDir, `${member.name.replace(/[^\w.-]+/g, "-")}.log`) }));
    const outcomes = await Promise.all(members.map(async ({ member, log }) => {
      const ready = await prepared(prepare, member, until);
      return isOutcome(ready) ? ready : execute(ready.command, root, ready.env, until, log);
    }));
    const failed: string[] = [];
    let missing: NoVerdict | undefined;
    members.forEach(({ member, log }, at) => {
      const outcome = outcomes[at]!;
      try {
        if (settle(member, outcome)) {
          if (!outcome.stopped) say(`${mode}: ${member.name}: passed in ${seconds(outcome.ranMs ?? 0)}`);
          return;
        }
      } catch (error) { if (error instanceof NoVerdict) { missing ??= error; return; } throw error; }
      failed.push(member.name);
      if (existsSync(log)) say(readFileSync(log, "utf8").trimEnd());
      say(`${mode}: ${member.name}: failed (${outcome.code}) after ${seconds(outcome.ranMs ?? 0)}`);
    });
    if (failed.length) throw new Error(`${failed.join(", ")} failed`);
    if (missing) throw missing;
  }
  if (deferred.length) say(`${mode}: passed; left to the hosted job: ${deferred.join(", ")}`);
  return deferred;
}

/** The hook's last line and exit code for what stopped it: a missing verdict
    exits 75, anything else fails the gate. */
export function endingOf(mode: Mode, error: unknown): { line: string; code: number } {
  if (error instanceof NoVerdict) return { line: `${mode}: ${error.message}`, code: 75 };
  return { line: `${mode}: ${error instanceof Error ? error.message : error}; gate failed`, code: 1 };
}

async function main(mode: Mode): Promise<void> {
  if (process.env.LLV_SKIP_HOOKS === "1") return;
  const deadline = pushDeadline(process.env, Date.now());
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  let base = mode === "pre-commit" ? git(root, ["merge-base", "HEAD", "origin/main"]) : "HEAD";
  const until = deadline?.at ?? Infinity;
  if (mode === "pre-push") {
    const fetch = await fetchMain(root, until);
    if (fetch === "failed") console.warn("pre-push: fetch failed; using the last origin/main (base resolution must still succeed)");
    if (fetch === "stopped") console.warn("pre-push: fetch stopped at the push deadline; using the last origin/main");
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
  // Installed on first use, inside the step that needs it and by its deadline.
  let runtime: Promise<string> | undefined;
  const fixtures = new Map<string, Promise<string>>();
  const sandbox = mkdtempSync(path.join(gateTemporaryRoot(), "delegatus-local-gate-"));
  try {
    const isolated = isolatedEnvironment(sandbox, process.env);
    const privacyEnv = {
      ...process.env,
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(root, "scripts/privacy-known-value-fingerprints.json"),
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
    };
    const prepare = async (step: Step, until: number) => {
      const command = [...step.command];
      const env = { ...(step.isolated ? isolated : process.env) };
      if (step.name === "privacy") Object.assign(env, privacyEnv);
      if (step.pinned) {
        runtime ??= pinnedRuntime(root, cache, until);
        command[0] = await runtime;
        env.PATH = `${path.dirname(command[0])}${path.delimiter}${env.PATH ?? ""}`;
      }
      if (step.name === "runtime host") command.push("--runtime", command[0]!);
      if (step.codex) {
        // Members of one group share a version's install instead of racing on its prefix.
        if (!fixtures.has(step.codex)) fixtures.set(step.codex, codexFixture(root, cache, step.codex, until));
        command.push(await fixtures.get(step.codex)!, ...(step.selection ? [step.selection] : []));
      }
      if (step.name === "Viewer build") Object.assign(env, { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_RUNTIME_UI: "1" });
      // Missing named tests must not shrink a green `bun test` run.
      if (command[1] === "test") {
        if (command.length < 3) throw new Error("refusing an empty test list");
        for (const file of command.slice(2)) {
          if (!isTest(file) || !existsSync(path.resolve(root, file))) throw new Error(`missing or invalid test path: ${file}`);
        }
      }
      return { command: step.capped ? ["bash", "scripts/gate-slot.sh", ...command] : command, env };
    };
    const branch = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim();
    await runSteps(mode, steps, { root, deadline, logDir: sandbox, prepare, ...(branch ? { ref: branch } : {}) });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "pre-commit" && mode !== "pre-push") throw new Error("usage: local-gate.ts pre-commit|pre-push");
  try { await main(mode); } catch (error) {
    const { line, code } = endingOf(mode, error);
    console.error(line);
    process.exitCode = code;
  }
}
