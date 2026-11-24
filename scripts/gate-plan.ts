import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SUPPORTED_CODEX_VERSIONS } from "../src/lib/accounts/codexVersions";
import { ALWAYS_IN_SCOPE, executedPaths, platformScope, workflowEntries } from "./ci-platform-scope";
import { cacheDirectory, checkEnvironment, dependencyTreeFingerprint, environmentFingerprint, fileFingerprint, fingerprint, GateCache } from "./gate-cache";

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
  privacySelfTests?: readonly string[];
  linux: boolean;
  runtime: boolean;
  native: boolean;
  linuxTests: readonly string[];
  runtimeTests: readonly string[];
  codexVersions: readonly string[];
}
export const isTest = (file: string) => /\.test\.[cm]?[jt]sx?$/.test(file) && !file.includes(".browser.test.");
const checkpointTest = /^scripts\/local-gate\.checkpoints(?:\.[^.]+)?\.test\.ts$/;
const lintable = (file: string) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(file);
/** Prose the compiler never reads. Anything else can change what it checks. */
export const proseOnly = (file: string) => /\.(?:md|mdx|txt)$/i.test(file);

export const NATIVE_GROUP = "native Codex";

/** Pure planning: discovery and process execution happen outside this function. */
export function plan(mode: Mode, changedFiles: readonly string[], env: PlanEnvironment): Step[] {
  changedFiles = [...new Set(changedFiles)];
  const files = changedFiles.filter(file => env.existing.has(file));
  const steps: Step[] = [];
  if (mode === "pre-commit") steps.push({ name: "staged whitespace", command: ["git", "diff", "--cached", "--check"] });
  if (mode === "pre-push") {
    steps.push({ name: "privacy", command: ["bun", "scripts/privacy-publication-gate.ts", "--base", env.base,
      "--require-known-values", "--check-commits", "--added-lines"] });
  }
  // A push that changes nothing (a read-only stage, a branch that only trails
  // main) has nothing a test could judge: whatever fails is already on main.
  // Privacy still reads every commit the push carries.
  if (mode === "pre-push" && changedFiles.length === 0) return steps;
  // Runtime builds generate Next's route/page validators before checking the
  // full project. Their build owns the single whole-program check.
  if (mode === "pre-push" && !env.runtime && !changedFiles.every(proseOnly)) steps.push(types());
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
  const touched = new Set(env.privacySelfTests);
  if (changedFiles.some(file => ["scripts/gate-cache.ts", "scripts/local-gate.fixture.ts", "scripts/gateTest.fixture.ts", "scripts/publicationHook.fixture.ts"].includes(file))) {
    for (const test of env.tests) if (checkpointTest.test(test)
      || /^scripts\/(?:local-gate(?:\.(?:receipts|hooks|publication|transport|git|lint|native|binding|runtime|execution|groups|invalidation)|-tests(?:\.[^.]+)?)?|eslint-changes|gate-cache)\.test\.ts$/.test(test)) touched.add(test);
  }
  if (changedFiles.some(file => ["scripts/owned-runner.integration.fixture.ts", "scripts/owned-runner.cleanup.ts"].includes(file))) {
    for (const test of env.tests) if (/^scripts\/owned-runner(?:\.[^.]+)+\.test\.ts$/.test(test)) touched.add(test);
  }
  if (changedFiles.includes("scripts/compiler-admission.fixture.ts")) {
    for (const test of env.tests) if (/^scripts\/compiler-admission(?:\.[^.]+)?\.test\.ts$/.test(test)) touched.add(test);
  }
  if (changedFiles.includes("scripts/local-gate-tests.fixture.ts")) {
    for (const test of env.tests) if (test.startsWith("scripts/local-gate-tests.") && isTest(test)) touched.add(test);
  }
  if (changedFiles.includes("scripts/local-gate-tests.ts")) {
    for (const test of env.tests) if (checkpointTest.test(test)) touched.add(test);
  }
  if (changedFiles.includes("src/lib/pipelines/engine.roleMemoryDispatch.fixture.ts")) {
    for (const test of env.tests) if (test.startsWith("src/lib/pipelines/engine.roleMemoryDispatch.") && isTest(test)) touched.add(test);
  }
  for (const file of files.filter(isTest)) touched.add(file);
  for (const file of files.filter(lintable)) {
    const stem = file.replace(/\.[^.]+$/, "");
    for (const test of env.tests) if (test.startsWith(`${stem}.`) && isTest(test)) touched.add(test);
  }
  if (changedFiles.some(file => file.startsWith(".githooks/") || file === "scripts/gate-slot.sh")) {
    for (const file of env.tests) if (/scripts\/(?:local-gate|gate-slot).*\.test\.ts$/.test(file)) touched.add(file);
  }
  // Both selections run the same per-file comparator against the same base.
  if (env.linux) for (const file of env.linuxTests) touched.delete(file);
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

type DiscoveryClosures = { privacy?: ReadonlySet<string>; platform?: ReadonlySet<string> };
export function discover(root: string, base: string, files: readonly string[], mode: Mode = "pre-push",
  tests = siblingTests(root, [...files, "scripts/local-gate.ts"]), closures: DiscoveryClosures = {}): PlanEnvironment {
  const existing = new Set(files.filter(file => existsSync(path.join(root, file))));
  const privacyTests = tests.filter(file => /^scripts\/privacy-.*\.test\.ts$/.test(file));
  let privacySelfTests: string[] = [];
  if (mode === "pre-push" && files.length && privacyTests.length) {
    const directlyChanged = files.some(file => file.startsWith("scripts/privacy-") || file.startsWith("scripts/generate-privacy-") ||
      file.startsWith("src/lib/privacy/") || [".github/workflows/privacy-publication.yml", ".github/workflows/privacy-tracker-audit.yml", ...ALWAYS_IN_SCOPE].includes(file));
    // The same import and execution closure as the required hosted check.
    if (directlyChanged) privacySelfTests = privacyTests;
    else {
      const inputs = closures.privacy ?? executedPaths(root, [...privacyTests, "test-preload.ts"]);
      if (files.some(file => inputs.has(file))) privacySelfTests = privacyTests;
    }
  }
  const platformFile = ".github/workflows/platform-tests.yml";
  const platform = workflow(root, "platform-tests.yml");
  const bun = workflow(root, "bun-runtime.yml");
  const runtimeEntries = workflowEntries(jobSource(bun.jobs["bun-runtime"]!));
  const runtimeChanged = files.some(file => file === "Dockerfile" || file.startsWith("src/runtime-host/") || file.startsWith("bin/"));
  return {
    base, existing, tests, privacySelfTests,
    // An empty diff is "run" to the CI scope, where skipping must be proven.
    // Here it is proven: nothing changed, so no platform job has a subject.
    linux: process.platform === "linux" && files.length > 0 && (closures.platform
      ? files.some(file => file === platformFile || ALWAYS_IN_SCOPE.includes(file) || file.startsWith("src/lib/proc/") || closures.platform!.has(file))
      : platformScope({ root, workflow: platformFile, prefixes: ["src/lib/proc/"], changed: files }).run),
    runtime: runtimeChanged,
    native: runtimeChanged,
    linuxTests: workflowEntries(platform.jobs["windows-platform"]!.steps.find(step => step.name === "Platform tests")!.run!).filter(isTest),
    runtimeTests: runtimeEntries.filter(isTest),
    codexVersions: SUPPORTED_CODEX_VERSIONS,
  };
}

/** A pending merge includes published main history from its incoming parent.
 * Judge lint against that shared history; incoming feature errors remain new. */
function preCommitComparisonBase(root: string): string {
  const base = git(root, ["merge-base", "HEAD", "origin/main"]);
  const pending = spawnSync("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD^{commit}"], { cwd: root, encoding: "utf8" });
  if (pending.status === 1) return base;
  if (pending.status !== 0) throw new Error(`git merge parent failed: ${pending.stderr.trim()}`);
  const parent = pending.stdout.trim();
  // Ambiguous merge-parent output keeps the existing comparison.
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parent)) return base;
  const shared = spawnSync("git", ["merge-base", parent, "origin/main"], { cwd: root, encoding: "utf8" });
  if (shared.status === 1) return base;
  if (shared.status !== 0) throw new Error(`git incoming comparison failed: ${shared.stderr.trim()}`);
  return shared.stdout.trim();
}

export const isBrowserTest = (file: string) => file.includes(".browser.test.");
const rawTest = /\.test\.[cm]?[jt]sx?$/;
const batchSource = /\.[cm]?[jt]sx?$/;

function rawTestCandidates(files: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const file of files) {
    if (file.startsWith("-") || file.split("/").includes("..")) throw new Error("Unsafe changed path");
    if (rawTest.test(file)) candidates.add(file);
    else if (batchSource.test(file)) {
      candidates.add(file.replace(batchSource, ".test.ts"));
      candidates.add(file.replace(batchSource, ".test.tsx"));
    }
  }
  return [...candidates].sort();
}

export function batchTests(files: readonly string[], exists: (file: string) => boolean, browser = true): string[] {
  return rawTestCandidates(files).filter(file => (browser || !isBrowserTest(file)) && exists(file));
}

function readGit(root: string, args: string[]): string {
  const result = spawnSync("git", ["--no-replace-objects", ...args], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.trim() || result.error?.message || result.status}`);
  return result.stdout;
}
const git = (root: string, args: string[]) => readGit(root, args).trimEnd();
const pathsFrom = (root: string, args: string[]) => readGit(root, args).split("\0").filter(Boolean);

export interface TreeTestEntry {
  mode: string;
  blob: string;
}

/** One literal tree read per distinct revision and candidate-path set. The
 * direct-sibling profile knows the exact entries it needs without a tree walk. */
export function reviewedTestReader(root: string, changed: readonly string[]) {
  const candidates = rawTestCandidates(changed);
  const revisions = new Map<string, ReadonlyMap<string, TreeTestEntry>>();
  return (revision: string) => {
    const cached = revisions.get(revision);
    if (cached) return cached;
    const entries = new Map<string, TreeTestEntry>();
    // Bound the argv size for large batches and protect pathspec syntax.
    for (let index = 0; index < candidates.length; index += 128) {
      const files = candidates.slice(index, index + 128);
      const wanted = new Set(files);
      for (const entry of pathsFrom(root, ["--literal-pathspecs", "ls-tree", "-z", revision, "--", ...files])) {
        const tab = entry.indexOf("\t");
        const file = entry.slice(tab + 1);
        if (!wanted.has(file)) continue;
        const [mode, type, object] = entry.slice(0, tab).split(" ");
        if (type === "tree") continue;
        entries.set(file, { mode: mode!, blob: type === "blob" ? object! : "" });
      }
    }
    revisions.set(revision, entries);
    return entries;
  };
}

export function selectTreeTests(paths: readonly string[], read: ReadonlyMap<string, TreeTestEntry>,
  owned?: ReadonlySet<string>): TreeTestFile[] {
  return batchTests(paths, file => read.has(file) && (!owned || owned.has(file))).map(file => ({ file, ...read.get(file)! }));
}

function selectDetectors(root: string, base: string, subject: string, files: readonly string[], reviewed: readonly ReviewedSubject[]): DetectorSelection {
  const changes = new Map<string, string[]>();
  const rows = reviewed.map(row => {
    const key = `${row.base}:${row.head}`;
    let own = changes.get(key);
    if (!own) {
      own = pathsFrom(root, ["diff", "--name-only", "-z", row.base, row.head, "--"]);
      changes.set(key, own);
    }
    return { ...row, own };
  });
  const paths = [...new Set([...files, ...rows.flatMap(row => row.own)])];
  const read = reviewedTestReader(root, paths);
  return { native: selectTreeTests(paths, read(subject)), main: selectTreeTests(paths, read(base)),
    reviewed: rows.map(row => ({ number: row.number, base: selectTreeTests(paths, read(row.base)),
      head: selectTreeTests(paths, read(row.head), new Set(row.own)) })) };
}

export function pinnedBunVersion(dockerfile: string): string {
  const pins = new Set([...dockerfile.matchAll(/npm install -g bun@(\d+\.\d+\.\d+)/g)].map(match => match[1]!));
  if (pins.size !== 1) throw new Error("Dockerfile must carry exactly one Bun pin");
  return [...pins][0]!;
}

const types = (): Step => ({ name: "types", command: ["bunx", "tsc", "--noEmit"], capped: true });
export type ReviewedSubject = { number: number; base: string; head: string };
type Operation = { profile: Mode; publishedTree?: string } |
  { profile: "batch"; base: string; subject?: string; browser?: boolean; detectorBrowser?: boolean; reviewed?: readonly ReviewedSubject[] };

const VERSION = 1;
type Profile = Mode | "batch";
type Producer = "hook" | "worker" | "trusted base" | "batch";
export interface GateCheck {
  readonly checkKey: string;
  readonly step: Step;
  readonly after: readonly string[];
  readonly runtime: { readonly executable: string; readonly bun: string | null; readonly codex: string | null };
  readonly files: readonly string[];
  readonly environment: "inherited" | "canonical isolated" | "batch isolated" | "trusted base";
  readonly cleanup: "owned" | "isolated" | "private build" | "reviewed corpus";
  readonly producer: Producer;
  readonly fresh: boolean;
}
interface PlanInputs {
  readonly version: typeof VERSION;
  readonly profile: Profile;
  readonly base: string;
  readonly subject: string;
  readonly tree: string;
  readonly changeClass: "staged" | "empty" | "prose" | "source" | "runtime";
  readonly changedPaths: readonly string[];
  readonly selector: string;
  readonly trustPolicy: string;
  readonly discovery: string;
}
interface DetectorSelection {
  readonly native: readonly TreeTestFile[];
  readonly main: readonly TreeTestFile[];
  readonly reviewed: readonly { number: number; base: readonly TreeTestFile[]; head: readonly TreeTestFile[] }[];
}
export type TreeTestFile = TreeTestEntry & { file: string };

export interface GatePlan extends PlanInputs {
  readonly planId: string;
  readonly requestId: string;
  readonly discoveryInputs: readonly (readonly [string, string])[];
  readonly checks: readonly GateCheck[];
  readonly detectors?: DetectorSelection;
}

const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function validPlan(value: unknown): value is GatePlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as GatePlan;
  return plan.version === VERSION && sha(plan.planId) && sha(plan.requestId) && Array.isArray(plan.discoveryInputs) &&
    plan.discoveryInputs.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === "string" && (sha(row[1]) || row[1] === "missing")) &&
    Array.isArray(plan.checks) && plan.checks.length > 0 &&
    plan.checks.every(check => check && sha(check.checkKey) && check.step && typeof check.step.name === "string" &&
      strings(check.step.command) && check.step.command.length > 0 && strings(check.after) && strings(check.files)) &&
    new Set(plan.checks.map(check => check.step.name)).size === plan.checks.length;
}

function freezePlan(plan: GatePlan): GatePlan {
  if (plan.detectors) {
    const { native, main, reviewed } = plan.detectors;
    for (const files of [native, main, ...reviewed.flatMap(row => [row.base, row.head])]) {
      files.forEach(Object.freeze);
      Object.freeze(files);
    }
    reviewed.forEach(Object.freeze);
    Object.freeze(reviewed);
    Object.freeze(plan.detectors);
  }
  for (const check of plan.checks) {
    Object.freeze(check.step.command);
    Object.freeze(check.step);
    Object.freeze(check.runtime);
    Object.freeze(check.after);
    Object.freeze(check.files);
    Object.freeze(check);
  }
  Object.freeze(plan.checks);
  Object.freeze(plan.changedPaths);
  return Object.freeze(plan);
}

function stepsForBatch(base: string, paths: string[], existing: ReadonlySet<string>, browser: boolean, detectorBrowser?: boolean): Step[] {
  const lint = paths.filter(file => batchSource.test(file) && existing.has(file));
  const tests = batchTests(paths, file => existing.has(file), browser);
  return [
    { name: "dependencies", command: ["bun", "install", "--frozen-lockfile"], capped: true },
    { ...types(), name: "tsc" },
    ...(lint.length ? [{ name: "eslint", command: ["bun", "scripts/eslint-changes.ts", "--base", base, ...lint], capped: true }] : []),
    ...(detectorBrowser === undefined && tests.length ? [{ name: "tests", command: ["bun", "test", ...tests.map(file => `./${file}`)], capped: true }] : []),
    { name: "privacy", command: ["bun", "scripts/privacy-publication-gate.ts", "--base", base, "--require-known-values", "--check-commits"], capped: true },
    ...(detectorBrowser === undefined ? [] : [
      { name: "reviewed detectors", command: ["bun", "test"], capped: true, selection: detectorBrowser ? "include browser" : "exclude browser" },
      { name: "test attribution", command: ["bun", "test"], capped: true, selection: "reported cases and omitted-member controls" },
    ]),
  ];
}

function effectiveStep(step: Step, execPath: string, env: NodeJS.ProcessEnv): Step {
  const command = [...step.command];
  if (path.basename(execPath) === "bun-container") {
    const executable = Bun.which(command[0]!, { PATH: env.PATH ?? "" });
    if (command[0] === "bun" && executable === "/usr/local/bin/bun") command[0] = execPath;
    // The installed compiler is already in the locked dependency tree.
    if (["types", "tsc"].includes(step.name) && executable === "/usr/local/bin/bunx") {
      command.splice(0, 2, "node", "node_modules/typescript/bin/tsc");
    }
  }
  return { ...step, command };
}

function identifyChecks(inputs: PlanInputs, steps: Step[], bindings: string, compilerInput: string, env: NodeJS.ProcessEnv, execPath: string,
  detectors?: DetectorSelection, bunPin?: string): GateCheck[] {
  const batch = inputs.profile === "batch";
  const names = new Set(steps.map(step => step.name));
  const build = new Set(["Viewer build", "MCP size budgets", "Viewer runtime", "runtime host", "runtime negative controls"]);
  return steps.map((definition, index) => {
    const { name } = definition;
    const inherited = ["privacy", "frozen install", "supply chain"].includes(name) ||
      inputs.profile === "pre-commit" && !definition.isolated;
    const environment = batch ? name === "privacy" ? "trusted base" : "batch isolated" : inherited ? "inherited" : "canonical isolated";
    const step = effectiveStep(definition, execPath, inherited || batch ? env : checkEnvironment(env));
    const corpus = ["reviewed detectors", "test attribution"].includes(name);
    const cleanup = corpus ? "reviewed corpus" : build.has(name) ? "private build" : !inherited || batch ? "isolated" : "owned";
    const producer = batch ? name === "privacy" ? "trusted base" : "batch" : name === "privacy" || inputs.profile === "pre-commit" ? "hook" : "worker";
    const fresh = batch || ["privacy", "staged whitespace", "frozen install", "supply chain"].includes(name);
    const prefix = name === "eslint" || name === "touched tests" || name === "Linux tests" ? 4 : step.command[1] === "test" ? 2 : step.command.length;
    const files = corpus && detectors
      ? [...new Set([...detectors.native, ...detectors.reviewed.flatMap(row => row.head)].map(entry => entry.file))]
      : step.command.slice(prefix).map(file => file.replace(/^\.\//, ""));
    const previous = steps[index - 1];
    const after = batch ? name === "reviewed detectors" ? ["privacy"] : name === "test attribution" ? ["reviewed detectors"]
      : previous ? [previous.name] : [] : [
        ...(step.group && names.has("frozen install") ? ["frozen install"] : []),
        ...(step.lane ? steps.slice(0, index).filter(other => other.lane === step.lane).slice(-1).map(other => other.name) : []),
        ...(inputs.profile === "pre-commit" && previous ? [previous.name] : []),
      ];
    const runtime = { executable: step.command[0]!,
      bun: step.pinned ? bunPin ?? "unresolved Dockerfile pin" : /bun(?:x|-container)?$/.test(step.command[0]!) ? Bun.version : null,
      codex: step.codex ?? null };
    const compiler = ["types", "tsc"].includes(name) ? compilerInput : null;
    const checkKey = fingerprint([VERSION, inputs.subject, inputs.tree, inputs.base, inputs.selector, inputs.trustPolicy, bindings, compiler,
      step.command, runtime, step.capped ?? false, step.selection ?? null, step.deferrable ?? false,
      environment, cleanup, producer, fresh, corpus ? inputs.discovery : null]);
    return { checkKey, step, files, after, runtime, environment, cleanup, producer, fresh };
  });
}

/** Read stable selection inputs first. An admitted child can validate the
 * parent's recorded discovery files by identity and reuse its immutable plan. */
export function gatePlan(root: string, operation: Operation, env: NodeJS.ProcessEnv = process.env, execPath = process.execPath,
  expectedPlanId?: string): GatePlan {
  const { profile } = operation;
  const batch = operation.profile === "batch" ? operation : undefined;
  const commit = (revision: string) => git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  const subject = commit(batch?.subject ?? "HEAD");
  const publishedTree = operation.profile !== "batch" && operation.publishedTree;
  const base = batch ? commit(batch.base) : profile === "pre-commit" ? preCommitComparisonBase(root)
    : publishedTree ? commit(publishedTree) : git(root, ["merge-base", subject, "origin/main"]);
  const tree = profile === "pre-commit" ? git(root, ["write-tree"]) : git(root, ["rev-parse", `${subject}^{tree}`]);
  const diff = (args: string[]) => pathsFrom(root, ["diff", "--name-only", "-z", ...args, "--"]);
  const dirty = batch || profile === "pre-commit" ? [] : [...new Set([
    ...diff([]), ...diff(["--cached"]), ...pathsFrom(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])];
  const files = [...new Set(batch ? diff([base, subject]) : profile === "pre-commit"
    ? diff(["--cached", "--diff-filter=ACMR"])
    : [...(publishedTree ? [] : diff(["--no-renames", `${base}...${subject}`])), ...dirty])];
  const changedPaths = [...new Set([...files, ...(batch ? diff(["--no-renames", base, subject])
    : profile === "pre-commit" ? diff(["--cached", "--no-renames"])
    : dirty.length ? [...diff(["--no-renames"]), ...diff(["--cached", "--no-renames"])] : [])])].sort();
  const selector = fingerprint([import.meta.path, path.join(import.meta.dir, "ci-platform-scope.ts"),
    path.resolve(import.meta.dir, "../src/lib/accounts/codexVersions.ts")].map(fileFingerprint));
  const trustPolicy = fingerprint([profile, ...[".githooks/pre-push", ".githooks/pre-commit", "scripts/local-gate-capabilities.json",
    "scripts/privacy-publication-gate.ts", "scripts/privacy-known-value-fingerprints.json"].map(file => fileFingerprint(path.join(root, file)))]);
  const paths = batch ? [...files.filter(file => batchSource.test(file)), ...rawTestCandidates(files)] : files;
  const existing = new Set(paths.filter(file => {
    const absolute = path.join(root, file);
    return batch ? existsSync(absolute) && statSync(absolute, { throwIfNoEntry: false })?.isFile() : existsSync(absolute);
  }));
  const siblings = batch ? [] : siblingTests(root, [...files, "scripts/local-gate.ts"]);
  // The slot wrapper supplies this default to both producers. Normalize its
  // absent form when naming the graph before that wrapper runs.
  const checkEnv = checkEnvironment({ ...env, NODE_OPTIONS: env.NODE_OPTIONS || "--max-old-space-size=11264" });
  const compilerInput = dependencyTreeFingerprint(root, "node_modules/typescript");
  const tools = [env.PATH, checkEnv.PATH].map(PATH => ["bun", "bunx", "node", "git"].map(tool => Bun.which(tool, { PATH: PATH ?? "" })));
  const runtimeBinding = [process.platform, process.arch, Bun.version, execPath, SUPPORTED_CODEX_VERSIONS,
    environmentFingerprint(checkEnv), compilerInput, tools];
  const requestId = fingerprint([VERSION, profile, subject, base, tree, changedPaths, selector, trustPolicy, runtimeBinding,
    files, [...existing], siblings, batch?.browser ?? false, batch?.detectorBrowser ?? false,
    batch?.reviewed?.map(row => [row.number, row.base, row.head])]);
  const cache = new GateCache<GatePlan>(cacheDirectory(root, "plans"), validPlan);
  if (expectedPlanId) {
    const cached = cache.find(candidate => candidate.planId === expectedPlanId && candidate.requestId === requestId &&
      candidate.discoveryInputs.every(([file, digest]) => fileFingerprint(path.join(root, file)) === digest));
    if (cached) return freezePlan(cached);
  }
  const platformWorkflow = ".github/workflows/platform-tests.yml";
  const platformInputs = batch ? new Set<string>() : executedPaths(root,
    workflowEntries(readFileSync(path.join(root, platformWorkflow), "utf8")));
  const privacyTests = siblings.filter(file => /^scripts\/privacy-.*\.test\.ts$/.test(file));
  const privacyInputs = !batch && profile === "pre-push" && privacyTests.length
    ? executedPaths(root, [...privacyTests, "test-preload.ts"]) : new Set<string>();
  const sourceInputs = [...new Set([...dirty.filter(file => batchSource.test(file)), ...platformInputs, ...privacyInputs,
    ...(batch ? [] : [platformWorkflow]), ".github/workflows/bun-runtime.yml", "Dockerfile", "bun.lock", "package.json",
    "node_modules/typescript/package.json", "node_modules/eslint/package.json"])]
    .map(file => [file, fileFingerprint(path.join(root, file))] as const);
  const bindings = fingerprint([runtimeBinding, sourceInputs]);
  const reviewed = batch?.reviewed?.map(row => ({ number: row.number, base: commit(row.base), head: commit(row.head) }));
  const runtime = files.some(file => file === "Dockerfile" || file.startsWith("src/runtime-host/") || file.startsWith("bin/"));
  const changeClass = profile === "pre-commit" ? "staged" : !files.length ? "empty"
    : files.every(proseOnly) ? "prose" : runtime ? "runtime" : "source";
  const inputs: PlanInputs = { version: VERSION, profile, subject, base, tree, changeClass, changedPaths, selector, trustPolicy,
    discovery: fingerprint([files, [...existing], siblings, bindings, batch?.browser ?? false, batch?.detectorBrowser ?? false, reviewed]) };
  const key = fingerprint(inputs);
  const stored = cache.read(key);
  const planId = (checks: readonly GateCheck[], detectors?: DetectorSelection) => fingerprint([key, checks, detectors]);
  if (stored) {
    const { planId: storedId, checks, detectors, requestId: _requestId, discoveryInputs: _discoveryInputs, ...header } = stored;
    if ((!expectedPlanId || expectedPlanId === storedId) && storedId === planId(checks, detectors) && fingerprint(header) === key)
      return freezePlan(stored);
  }
  const detectorBrowser = reviewed ? batch?.detectorBrowser ?? batch?.browser ?? false : undefined;
  const detectors = reviewed ? selectDetectors(root, base, subject, files, reviewed) : undefined;
  const steps = batch ? stepsForBatch(base, files, existing, batch.browser ?? false, detectorBrowser)
    : plan(profile as Mode, files, { ...discover(root, base, files, profile as Mode, siblings,
      { privacy: privacyInputs, platform: platformInputs }),
      existing, base: profile === "pre-commit" ? "HEAD" : base, lintBase: base });
  let bunPin: string | undefined;
  if (steps.some(step => step.pinned)) {
    try { bunPin = pinnedBunVersion(readFileSync(path.join(root, "Dockerfile"), "utf8")); }
    catch { /* Keep the required check. Its runtime preparation reports the error. */ }
  }
  const checks = identifyChecks(inputs, steps, bindings, compilerInput, env, execPath, detectors, bunPin);
  const built = { ...inputs, requestId, discoveryInputs: sourceInputs, checks, ...(detectors ? { detectors } : {}), planId: planId(checks, detectors) };
  cache.write(key, built);
  return freezePlan(built);
}
