// Runs one heavy command from scripts/gate-slot.sh on the gate runner over SSH
// (docs/design/remote-gate-runner.md §8). The wrapper starts this client for a
// top-level call when a runner is configured; the client either runs the
// command remotely and exits with its verdict, or writes "here" to the
// wrapper's decision file and exits, after which the wrapper admits and runs
// the command on this machine exactly as before.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { machineHome } from "../../src/lib/runtime/cpuAdmission";
import { envClass } from "./env-classes";

/** Any environment, process.env included; the project's ProcessEnv type requires NODE_ENV. */
export type Env = Record<string, string | undefined>;
const asProcessEnv = (env: Env) => env as NodeJS.ProcessEnv;

export const HEALTH_TTL_MS = 60_000;
export const UNHEALTHY_MS = 30 * 60_000;
const MIN_FREE_KB = 10 * 1024 * 1024;
const MAX_RETURN_BYTES = 512 * 1024 * 1024;
/** Tests lower the bound on returned outputs; nothing else sets it. */
const returnLimit = (env: Env) => Math.min(MAX_RETURN_BYTES, Number(env.LLV_GATE_RUNNER_RETURN_LIMIT) || MAX_RETURN_BYTES);
const DECISION_LINES = 10_000;
const PRIVACY_ENTRIES = 256;

// ---------------------------------------------------------------- configuration

/** The passwd home: agents and their test commands change HOME and
 * XDG_CONFIG_HOME, and Bun's os.userInfo() follows HOME. */
export function configFile(env: Env): string {
  return env.LLV_GATE_RUNNER_CONFIG || path.join(machineHome(), ".config", "delegatus", "gate-runner.json");
}

export type Target = { alias: string } | { off: string } | null;
/** LLV_GATE_RUNNER, then LLV_GATE_RUNNER_CONFIG, then the passwd-home file. */
export function resolveTarget(env: Env): Target {
  const value = env.LLV_GATE_RUNNER?.trim();
  if (value === "off") return { off: "LLV_GATE_RUNNER=off" };
  if (value) return validAlias(value) ? { alias: value } : { off: `LLV_GATE_RUNNER is not an SSH alias: ${value.slice(0, 40)}` };
  const file = configFile(env);
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  try {
    const alias = (JSON.parse(text) as { ssh?: unknown }).ssh;
    if (typeof alias === "string" && validAlias(alias)) return { alias };
  } catch { /* malformed below */ }
  return { off: `${file} does not name an SSH alias` };
}
const validAlias = (alias: string) => /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/.test(alias);

export function cacheDirectory(env: Env): string {
  return env.LLV_GATE_RUNNER_CACHE || path.join(machineHome(), ".cache", "delegatus-gate");
}

// ---------------------------------------------------------------- eligibility

export interface ExportRecord { version: 1; checkout: string; head: string; repository: string }
export type Tree = { kind: "git"; root: string } | { kind: "export"; root: string; record: ExportRecord };
type Refusal = { reason: string };
const refused = (value: unknown): value is Refusal => typeof value === "object" && value !== null && "reason" in value;

function git(args: string[], options: { cwd?: string; env?: Env; input?: string } = {}): { ok: boolean; out: string; err: string } {
  const result = spawnSync("git", args, { cwd: options.cwd, env: asProcessEnv(options.env ?? gitEnvironment(process.env)), input: options.input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}
function gitOrThrow(step: string, args: string[], options: Parameters<typeof git>[1] = {}): string {
  const result = git(args, options);
  if (!result.ok) throw new Error(`${step}: git ${args[0]} failed: ${result.err.split("\n").at(-1) ?? ""}`);
  return result.out;
}
/** Git variables a hook exports would point the capture at the pushing repository. */
function gitEnvironment(env: Env): Env {
  const clean: Env = { ...env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(clean)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX|CONFIG.*|NAMESPACE|IMPLICIT_WORK_TREE|GRAFT_FILE|SHALLOW_FILE|REPLACE_REF_BASE|NO_REPLACE_OBJECTS)$/.test(key)) delete clean[key];
  return clean;
}

/** The nearest ancestor holding the wrapper and this runner, and what kind of checkout it is. */
export function findTree(cwd: string): Tree | Refusal {
  let dir: string;
  try { dir = fs.realpathSync(cwd); } catch { return { reason: "the working directory is unreadable" }; }
  for (;;) {
    if (fs.existsSync(path.join(dir, "scripts", "gate-slot.sh")) && fs.statSync(path.join(dir, "scripts", "gate-runner"), { throwIfNoEntry: false })?.isDirectory()) break;
    const parent = path.dirname(dir);
    if (parent === dir) return { reason: "not inside a checkout that has the gate runner" };
    dir = parent;
  }
  if (fs.existsSync(path.join(dir, ".git"))) {
    const top = git(["rev-parse", "--show-toplevel"], { cwd: dir });
    if (!top.ok) return { reason: "the checkout's git metadata is unreadable" };
    if (fs.realpathSync(top.out) !== dir) return { reason: "the checkout is nested in another work tree" };
    return { kind: "git", root: dir };
  }
  const recordFile = path.join(path.dirname(dir), "export.json");
  let record: ExportRecord;
  try { record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as ExportRecord; }
  catch { return { reason: "a copy without git metadata or an export record" }; }
  if (record.version !== 1 || record.checkout !== dir || !/^[0-9a-f]{40,64}$/.test(record.head ?? "") || typeof record.repository !== "string") return { reason: "the export record does not describe this checkout" };
  if (!git(["--git-dir", record.repository, "cat-file", "-e", `${record.head}^{commit}`]).ok) return { reason: "the exported commit is gone from its repository" };
  return { kind: "export", root: dir, record };
}

export interface Shape { name: string; driver: boolean; exportOk: boolean }
/** The commands v1 sends (§8.1). `argv` is the command the wrapper received. */
export function shapeOf(argv: string[], tree: Tree, cwd: string, env: Env): Shape | Refusal {
  const program = path.basename(argv[0] ?? "");
  const script = (index: number) => argv[index] ? path.relative(tree.root, path.resolve(cwd, argv[index]!)) : "";
  let shape: Shape | null = null;
  if (program === "bun" && script(1) === "scripts/local-gate.ts" && argv[2] === "pre-push" && argv[3] === "--admitted" && argv.length === 4) shape = { name: "pre-push", driver: false, exportOk: false };
  else if (program === "bun" && argv[1] === "test") shape = { name: "test", driver: argv.slice(2).some(arg => /\.browser\.test\.tsx$/.test(arg)), exportOk: true };
  else if (program === "bun" && argv[1] === "run" && argv[2] === "test") shape = { name: "test", driver: argv.slice(3).some(arg => /\.browser\.test\.tsx$/.test(arg)), exportOk: true };
  else if (program === "bunx" && argv[1] === "tsc") shape = { name: "tsc", driver: false, exportOk: true };
  else if (program === "bun" && script(1) === "scripts/local-gate-tests.ts") shape = { name: "local-gate-tests", driver: false, exportOk: false };
  else if (program === "bun" && script(1) === "scripts/eslint-changes.ts") shape = { name: "eslint-changes", driver: false, exportOk: false };
  else if (program === "bun" && script(1) === "scripts/capture-board-geometry.ts") {
    const out = env.BOARD_CAPTURE_DIR;
    if (!out || !path.isAbsolute(out) || !fs.statSync(out, { throwIfNoEntry: false })?.isDirectory() || inside(tree.root, out)) return { reason: "the geometry driver needs BOARD_CAPTURE_DIR, an existing directory outside the checkout" };
    shape = { name: "board-geometry", driver: true, exportOk: true };
  }
  if (!shape) return { reason: "not a command shape the runner takes" };
  if (tree.kind === "export" && !shape.exportOk) return { reason: `${shape.name} reads git history, which an export lacks` };
  return shape;
}

const inside = (root: string, target: string) => {
  const relative = path.relative(root, path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const fromCwd = (cwd: string, target: string) => {
  const relative = path.relative(cwd, target) || ".";
  return relative.startsWith("..") ? relative : `./${relative}`;
};

/** Absolute in-tree arguments become relative ones; anything leaving the tree runs here. */
export function mapArguments(argv: string[], root: string, cwd: string): string[] | Refusal {
  const mapped = [path.basename(argv[0]!)];
  for (const arg of argv.slice(1)) {
    const option = /^(--[A-Za-z0-9-]+=)(.*)$/.exec(arg);
    const [prefix, value] = option ? [option[1]!, option[2]!] : ["", arg];
    if (path.isAbsolute(value)) {
      if (!inside(root, value)) return { reason: "an argument names a path outside the checkout" };
      mapped.push(`${prefix}${fromCwd(cwd, path.resolve(value))}`);
      continue;
    }
    if (value.split(/[\\/]/).includes("..") && !inside(root, path.resolve(cwd, value))) return { reason: "an argument names a path outside the checkout" };
    mapped.push(arg);
  }
  return mapped;
}

/** The environment a run receives and the local directories its outputs return to. */
export function remoteEnvironment(env: Env, root: string, cwd: string): { env: Record<string, string>; outputs: Record<string, string> } | Refusal {
  const sent: Record<string, string> = {}, outputs: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    const kind = envClass(name);
    if (value === undefined || !kind || kind === "isolated" || kind === "never") continue;
    if (kind === "output-dir" && path.isAbsolute(value) && !inside(root, value)) { outputs[name] = path.resolve(value); continue; }
    if (path.isAbsolute(value)) {
      if (!inside(root, value)) return { reason: `${name} names a path outside the checkout` };
      sent[name] = fromCwd(cwd, path.resolve(value));
      continue;
    }
    if (kind === "input-path" && (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || !inside(root, path.resolve(cwd, value)))) return { reason: `${name} names something outside the checkout` };
    sent[name] = value;
  }
  const conflict = outputConflict(root, outputs);
  if (conflict) return { reason: conflict };
  return { env: sent, outputs };
}

// ---------------------------------------------------------------- health

export interface Health { checkedAt: number; healthy: boolean; reason?: string; main?: string; runs?: number; unhealthyUntil?: number }
const PROBE = [
  `printf 'bun=%s\\n' "$(~/.bun/bin/bun --version 2>/dev/null)"`,
  `printf 'disk=%s\\n' "$(df -Pk ~ 2>/dev/null | awk 'NR==2{print $4}')"`,
  `systemctl --user show-environment >/dev/null 2>&1 && echo manager=ok`,
  `printf 'main=%s\\n' "$(git --git-dir ~/mirror/delegatus.git rev-parse -q --verify refs/heads/main 2>/dev/null)"`,
  `printf 'runs=%s\\n' "$(ls ~/runs 2>/dev/null | wc -l)"`,
].join("; ");

/** What a reason may carry into output, the health file and the decision log:
 * no path, account, address or URL, whatever produced the text. */
export function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\b(host(?:name)?|server|to) ([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]*[A-Za-z0-9])\b/gi, "$1 <host>")
    .replace(/[^\s'"`<>()=:,;]+@[A-Za-z0-9.-]+/g, "<account>@<host>")
    .replace(/(^|[\s'"`(=:,;])~?\/[^\s'"`),;]*/g, "$1<path>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<address>")
    .replace(/(^|[^0-9A-Za-z:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9A-Za-z:])/gi, "$1<address>");
}

/** ssh's own diagnostics name the host, the account and the key: only their
 * kind is kept. */
export function sshFailure(status: number | null, stderr: string, timedOut: boolean): string {
  if (timedOut) return "ssh did not answer within 10 s";
  const text = stderr.toLowerCase();
  const kinds: [RegExp, string][] = [
    [/could not resolve hostname|name or service not known|temporary failure in name resolution|nodename nor servname/, "the runner's host name does not resolve"],
    [/host key verification failed|remote host identification has changed|no .* host key is known/, "the runner's host key is not the pinned one"],
    [/permission denied|too many authentication failures|no supported authentication methods/, "the runner refused this machine's key"],
    [/connection refused/, "the runner refused the connection"],
    [/timed out/, "the connection to the runner timed out"],
    [/no route to host|network is unreachable/, "the runner's network is unreachable"],
    [/connection closed|connection reset|broken pipe|kex_exchange_identification/, "the runner closed the connection"],
  ];
  const kind = kinds.find(([pattern]) => pattern.test(text))?.[1];
  return `ssh exited ${status ?? "on a signal"}${kind ? `: ${kind}` : ""}`;
}

function healthFile(env: Env) { return path.join(cacheDirectory(env), "runner-health.json"); }
export function readHealth(env: Env): Health | null {
  try { return JSON.parse(fs.readFileSync(healthFile(env), "utf8")) as Health; } catch { return null; }
}
function writeHealth(env: Env, health: Health): void {
  try {
    fs.mkdirSync(cacheDirectory(env), { recursive: true });
    const file = healthFile(env), next = `${file}.${process.pid}.next`;
    fs.writeFileSync(next, JSON.stringify(health.reason === undefined ? health : { ...health, reason: redact(health.reason) }));
    fs.renameSync(next, file);
  } catch { /* caching is off; every call probes */ }
}
/** Any runner-side failure keeps every caller here for 30 minutes, longer than
 * the publication's retries after 1, 5 and 15 minutes. */
export function markUnhealthy(env: Env, reason: string, now = Date.now()): void {
  writeHealth(env, { ...(readHealth(env) ?? { checkedAt: now }), healthy: false, reason, unhealthyUntil: now + UNHEALTHY_MS, checkedAt: now });
}

export function parseProbe(output: string, bunVersion: string): Omit<Health, "checkedAt"> {
  const fields = Object.fromEntries(output.split("\n").map(line => /^(\w+)=(.*)$/.exec(line.trim())).filter(Boolean).map(match => [match![1], match![2]]));
  const main = /^[0-9a-f]{40,64}$/.test(fields.main ?? "") ? fields.main : undefined;
  const reasons: string[] = [];
  if (fields.bun !== bunVersion) reasons.push(`the runner's Bun is ${fields.bun || "missing"}, this machine's ${bunVersion}`);
  if (!(Number(fields.disk) >= MIN_FREE_KB)) reasons.push("under 10 GB free on the runner");
  if (fields.manager !== "ok") reasons.push("the runner's user manager does not answer");
  if (!main) reasons.push("the runner's mirror is missing");
  return { healthy: reasons.length === 0, ...(reasons.length ? { reason: reasons.join("; ") } : {}), ...(main ? { main } : {}), runs: Number(fields.runs) || 0 };
}

function sshCommand(env: Env): string { return env.LLV_GATE_RUNNER_SSH || "ssh"; }
/** Never starts a connection master: a forked master would outlive this
 * command, and the caller's cleanup counts every survivor as a leak. */
function sshArgs(alias: string, command: string, extra: string[] = []): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ControlMaster=no", ...extra, alias, command];
}

export function health(env: Env, alias: string, now = Date.now()): Health {
  const cached = readHealth(env);
  if (cached?.unhealthyUntil && cached.unhealthyUntil > now) return { ...cached, healthy: false, reason: `marked unhealthy after a failed run (${cached.reason ?? "no reason recorded"}) until ${new Date(cached.unhealthyUntil).toISOString().slice(11, 16)}Z` };
  if (cached && !cached.unhealthyUntil && now - cached.checkedAt < HEALTH_TTL_MS && now >= cached.checkedAt) return cached;
  const result = spawnSync(sshCommand(env), sshArgs(alias, PROBE), { encoding: "utf8", timeout: 10_000, env: process.env });
  const answer: Health = result.status === 0
    ? { checkedAt: now, ...parseProbe(result.stdout ?? "", Bun.version) }
    : { checkedAt: now, healthy: false, reason: sshFailure(result.status, String(result.stderr ?? ""), !!result.error) };
  writeHealth(env, answer);
  return answer;
}

// ---------------------------------------------------------------- shipping the tree

export interface Shipment {
  tree: string; commit: string; head?: string; base?: string; parent?: string; bundle: string; changed: string[];
  /** The capture's own repository, its alternate and the commit the bundle leaves out. */
  gitDir: string; objects: string; prerequisite: string;
}

/** A bundle whose `refs/gate/tree` commit holds exactly the working tree.
 * Writes only into `scratch`: the checkout's index, refs and objects stay. */
export function ship(tree: Tree, scratch: string, mirrorMain: string | undefined): Shipment {
  const ship = path.join(scratch, "ship.git");
  const index = path.join(scratch, "index");
  const identity = { GIT_AUTHOR_NAME: "gate-run", GIT_AUTHOR_EMAIL: "gate-run@invalid", GIT_COMMITTER_NAME: "gate-run", GIT_COMMITTER_EMAIL: "gate-run@invalid", GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000" };
  const base = gitEnvironment(process.env);
  const objects = tree.kind === "git"
    ? path.join(gitOrThrow("capture", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: tree.root }), "objects")
    : path.join(fs.realpathSync(tree.record.repository), "objects");
  gitOrThrow("capture", ["init", "--quiet", "--bare", ship]);
  fs.writeFileSync(path.join(ship, "objects", "info", "alternates"), `${objects}\n`);
  const shipGit = (args: string[], extra: Env = {}) => gitOrThrow("capture", ["--git-dir", ship, ...args], { env: { ...base, ...identity, ...extra } });
  const has = (commit: string | undefined) => !!commit && git(["--git-dir", ship, "cat-file", "-e", `${commit}^{commit}`], { env: base }).ok;
  if (tree.kind === "git") {
    const head = gitOrThrow("capture", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: tree.root });
    const upstream = git(["rev-parse", "--verify", "-q", "refs/remotes/origin/main^{commit}"], { cwd: tree.root });
    if (!upstream.ok) throw new Error("capture: the checkout has no origin/main");
    const indexFile = gitOrThrow("capture", ["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: tree.root });
    // A fresh index would drop tracked files that match an ignore rule.
    if (fs.existsSync(indexFile)) {
      fs.copyFileSync(indexFile, index);
      // The original's time, truncated to the millisecond and so never later:
      // git compares content for every entry as new as the index file.
      const { atime, mtime } = fs.statSync(indexFile);
      fs.utimesSync(index, atime, mtime);
    }
    const captureEnv = { ...base, GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: path.join(ship, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    trustNoStat(tree.root, captureEnv);
    gitOrThrow("capture", [...STAT_TRUSTING_OFF, "add", "-A"], { cwd: tree.root, env: captureEnv });
    const treeId = gitOrThrow("capture", ["write-tree"], { cwd: tree.root, env: captureEnv });
    const commit = shipGit(["commit-tree", treeId, "-p", head, "-m", "gate-run"]);
    shipGit(["update-ref", "refs/gate/tree", commit]);
    shipGit(["update-ref", "refs/gate/head", head]);
    shipGit(["update-ref", "refs/gate/base", upstream.out]);
    const prerequisite = has(mirrorMain) ? mirrorMain! : shipGit(["merge-base", head, upstream.out]);
    const bundle = path.join(scratch, "run.bundle");
    shipGit(["bundle", "create", "--quiet", bundle, "refs/gate/tree", "refs/gate/head", "refs/gate/base", "--not", prerequisite]);
    return { tree: treeId, commit, head, base: upstream.out, bundle, changed: [], gitDir: ship, objects, prerequisite };
  }
  const exported = tree.record.head;
  shipGit(["read-tree", exported], { GIT_INDEX_FILE: index });
  const captureEnv = { ...base, GIT_DIR: ship, GIT_WORK_TREE: tree.root, GIT_INDEX_FILE: index };
  gitOrThrow("capture", [...STAT_TRUSTING_OFF, "add", "-A"], { cwd: tree.root, env: captureEnv });
  const treeId = gitOrThrow("capture", ["write-tree"], { cwd: tree.root, env: captureEnv });
  // The merge base with main lets the bundle leave out everything main has,
  // and the lane's changes are exactly what differs from it.
  const repositoryMain = git(["--git-dir", tree.record.repository, "merge-base", exported, "refs/remotes/origin/main"]);
  const parent = repositoryMain.ok ? repositoryMain.out : has(mirrorMain) ? mirrorMain! : null;
  if (!parent) throw new Error("capture: the export shares no commit with main");
  const commit = shipGit(["commit-tree", treeId, "-p", parent, "-m", "gate-run"]);
  shipGit(["update-ref", "refs/gate/tree", commit]);
  const bundle = path.join(scratch, "run.bundle");
  shipGit(["bundle", "create", "--quiet", bundle, "refs/gate/tree", "--not", parent]);
  const changed = shipGit(["diff", "--name-only", "-z", "--diff-filter=ACMRT", parent, commit]).split("\0").filter(Boolean);
  return { tree: treeId, commit, parent, bundle, changed, gitDir: ship, objects, prerequisite: parent };
}

/** Settings under which `add -A` would keep an entry's recorded blob without
 * reading the file. */
const STAT_TRUSTING_OFF = ["-c", "core.fsmonitor=false", "-c", "core.ignoreStat=false", "-c", "core.checkStat=default", "-c", "gc.auto=0"];

/** An assume-unchanged entry keeps its recorded blob whatever the file holds,
 * so the flag is cleared in the capture's own index copy. A skip-worktree
 * entry stands for a file this checkout does not have (a sparse checkout):
 * neither the old blob nor a deletion is the tree here, so such a checkout
 * runs here. */
function trustNoStat(root: string, env: Env): void {
  const entries = gitOrThrow("capture", ["ls-files", "-v", "-z"], { cwd: root, env }).split("\0").filter(Boolean);
  const assumed: string[] = [];
  for (const entry of entries) {
    const tag = entry[0]!, name = entry.slice(2);
    if (tag === "S" || tag === "s") throw new Error("capture: the checkout has skip-worktree entries (a sparse checkout), whose files are not here");
    if (tag !== tag.toUpperCase()) assumed.push(name);
  }
  if (assumed.length) gitOrThrow("capture", [...STAT_TRUSTING_OFF, "update-index", "--no-assume-unchanged", "-z", "--stdin"], { cwd: root, env, input: `${assumed.join("\0")}\0` });
}

// ---------------------------------------------------------------- privacy

function privacyKey(parts: string[]): string { return createHash("sha256").update(parts.join("\0")).digest("hex"); }
function readPrivacyCache(env: Env): Record<string, { ok: boolean; at: number; line?: string }> {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDirectory(env), "privacy-cache.json"), "utf8")); } catch { return {}; }
}
function writePrivacyCache(env: Env, cache: Record<string, { ok: boolean; at: number; line?: string }>): void {
  try {
    const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, PRIVACY_ENTRIES);
    const file = path.join(cacheDirectory(env), "privacy-cache.json"), next = `${file}.${process.pid}.next`;
    fs.mkdirSync(cacheDirectory(env), { recursive: true });
    fs.writeFileSync(next, JSON.stringify(Object.fromEntries(entries)));
    fs.renameSync(next, file);
  } catch { /* uncached */ }
}

/** The tree's own privacy gate, here, before anything leaves this machine.
 *
 * Its subject is the shipment, never the live checkout: the captured tree is
 * checked out from the capture's objects into scratch, the gate there is the
 * captured tree's own, and in a git work tree the scan's `HEAD` is the head
 * the bundle carries. Every blob the bundle carries outside that scan (an
 * earlier version a later commit replaced or deleted) and every path name it
 * carries are scanned as well. The cache key names only object ids, so an
 * edit made after capture can neither change the subject nor seed an entry. */
export function privacy(tree: Tree, shipment: Shipment, env: Env): { ok: true } | { ok: false; line: string; unfinished?: true } {
  const knownValues = env.LLV_PRIVACY_KNOWN_VALUES_FILE;
  let digest = "none";
  try { if (knownValues) digest = createHash("sha256").update(fs.readFileSync(knownValues)).digest("hex"); } catch { digest = "unreadable"; }
  const inline = createHash("sha256").update(`${env.LLV_PRIVACY_KNOWN_VALUES ?? ""}\0${env.LLV_PRIVACY_KNOWN_VALUES_FORMAT ?? ""}`).digest("hex");
  const key = privacyKey([tree.kind, shipment.commit, shipment.head ?? "", shipment.base ?? shipment.parent ?? "", shipment.prerequisite, digest, inline]);
  const cache = readPrivacyCache(env);
  const hit = cache[key];
  if (hit) return hit.ok ? { ok: true } : { ok: false, line: hit.line ?? "refused" };
  const budget = scanBudgetMs(env);
  const verdict = scanShipment(tree, shipment, env, Date.now() + budget, budget);
  // A configuration error, an unreadable capture or a scan that ran out of
  // time says nothing about the tree.
  if (verdict.ok || verdict.cacheable) cache[key] = { ok: verdict.ok, at: Date.now(), ...(verdict.ok ? {} : { line: verdict.line }) };
  writePrivacyCache(env, cache);
  return verdict.ok ? { ok: true } : { ok: false, line: verdict.line, ...(verdict.unfinished ? { unfinished: true as const } : {}) };
}

/** How long the scan may take. The tree's own gate needs about 150
 * CPU-seconds for a large lane, longer on a busy machine (§8.12), so it gets
 * what is left of the push budget less a minute for the run, or the
 * publication budget when there is none. Tests shorten it. */
export function scanBudgetMs(env: Env, now = Date.now()): number {
  const override = Number(env.LLV_GATE_RUNNER_SCAN_TIMEOUT_MS);
  if (override > 0) return override;
  const deadline = Number(env.LLV_GATE_PUSH_DEADLINE);
  if (env.LLV_GATE_PUSH_DEADLINE && Number.isFinite(deadline)) return Math.max(30_000, Math.floor(deadline - now - 60_000));
  return 15 * 60_000;
}

type ScanVerdict = { ok: true } | { ok: false; line: string; cacheable: boolean; unfinished?: true };

function scanShipment(tree: Tree, shipment: Shipment, env: Env, until: number, budget: number): ScanVerdict {
  const scratch = fs.mkdtempSync(path.join(path.dirname(shipment.gitDir), "privacy-"));
  try {
    const base = gitEnvironment(process.env);
    const captured = (args: string[], options: { env?: Env; input?: string } = {}) => git(["--git-dir", shipment.gitDir, ...args], { env: { ...base, ...options.env }, input: options.input });
    let from: string;
    if (tree.kind === "git") {
      const mergeBase = captured(["merge-base", shipment.head!, shipment.base!]);
      if (!mergeBase.ok) return { ok: false, line: "no merge base with origin/main", cacheable: false };
      from = mergeBase.out;
    } else from = shipment.parent!;

    // 1. The captured tree, checked out from the capture's objects.
    const scan = path.join(scratch, "tree");
    let gateArgs: string[];
    if (tree.kind === "git") {
      if (!git(["init", "--quiet", scan], { env: base }).ok) return { ok: false, line: "the capture could not be checked out for the scan", cacheable: false };
      fs.writeFileSync(path.join(scan, ".git", "objects", "info", "alternates"), `${path.join(shipment.gitDir, "objects")}\n${shipment.objects}\n`);
      const scanGit = (args: string[]) => git(["-C", scan, "-c", "core.hooksPath=/dev/null", ...args], { env: base });
      if (!scanGit(["update-ref", "--no-deref", "HEAD", shipment.head!]).ok || !scanGit(["read-tree", "--reset", "-u", shipment.tree]).ok) {
        return { ok: false, line: "the capture could not be checked out for the scan", cacheable: false };
      }
      gateArgs = ["--repository", scan, "--base", from, "--check-commits", "--require-known-values"];
    } else {
      fs.mkdirSync(scan);
      const checkout = captured(["read-tree", "--reset", "-u", shipment.tree], { env: { GIT_WORK_TREE: scan, GIT_INDEX_FILE: path.join(scratch, "index") } });
      if (!checkout.ok) return { ok: false, line: "the capture could not be checked out for the scan", cacheable: false };
      gateArgs = shipment.changed.length ? ["--repository", scan, "--require-known-values", "--paths", ...shipment.changed] : [];
    }
    const unfinished = (): ScanVerdict => ({ ok: false, line: `it did not finish within ${Math.round(budget / 1000)} s`, cacheable: false, unfinished: true });
    const gate = (args: string[]): ScanVerdict => {
      const left = until - Date.now();
      if (left <= 0) return unfinished();
      const result = spawnSync(process.execPath, [path.join(scan, "scripts", "privacy-publication-gate.ts"), ...args], {
        cwd: scan, encoding: "utf8", timeout: left, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
        env: asProcessEnv({ ...gitEnvironment(env), LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.join(scan, "scripts", "privacy-known-value-fingerprints.json"), LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr", LLV_GATE_RUNNER: "off" }),
      });
      if (result.status === 0) return { ok: true };
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || Date.now() >= until) return unfinished();
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const line = output.split("\n").map(text => text.trim()).filter(Boolean).at(-1) ?? `exit ${result.status ?? result.signal}`;
      return { ok: false, line: line.slice(0, 200), cacheable: result.status === 1 && !/configuration_error/.test(output) };
    };
    if (gateArgs.length) {
      const verdict = gate(gateArgs);
      if (!verdict.ok) return verdict;
    }

    // 2. What else the bundle carries: blobs outside that scan, and every name.
    const scanned = new Set<string>();
    const changed = captured(["diff", "--name-only", "-z", "--diff-filter=ACMRT", from, shipment.commit]);
    const listing = captured(["ls-tree", "-r", "-z", shipment.tree]);
    if (!changed.ok || !listing.ok) return { ok: false, line: "the capture's objects are unreadable", cacheable: false };
    const changedPaths = new Set(changed.out.split("\0").filter(Boolean));
    for (const entry of listing.out.split("\0").filter(Boolean)) {
      const match = /^\d+ blob ([0-9a-f]+)\t([^]*)$/.exec(entry);
      if (match && changedPaths.has(match[2]!)) scanned.add(match[1]!);
    }
    const tips = tree.kind === "git" ? ["refs/gate/tree", "refs/gate/head"] : ["refs/gate/tree"];
    const objects = captured(["rev-list", "--objects", ...tips, "--not", shipment.prerequisite, ...(tree.kind === "git" ? ["refs/gate/base"] : [])]);
    if (!objects.ok) return { ok: false, line: "the bundle's objects are unreadable", cacheable: false };
    const lines = objects.out.split("\n").filter(Boolean).map(line => /^([0-9a-f]{40,64})(?: (.*))?$/.exec(line));
    // A name git could not print on one line hides which object follows it.
    if (lines.some(match => !match)) return { ok: false, line: "the bundle carries a path name the scan cannot read", cacheable: true };
    const named = (lines as RegExpExecArray[]).filter(match => match[2] !== undefined);
    // rev-list names each object once; the commits' own changes name every
    // path any transmitted tree holds.
    const touched = captured(["log", "-z", "--format=", "--name-only", "-m", "--no-renames", ...tips, "--not", shipment.prerequisite, ...(tree.kind === "git" ? ["refs/gate/base"] : [])]);
    if (!touched.ok) return { ok: false, line: "the bundle's objects are unreadable", cacheable: false };
    const types = captured(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: named.map(match => `${match[1]}\n`).join("") });
    if (!types.ok) return { ok: false, line: "the bundle's objects are unreadable", cacheable: false };
    const blobs = new Set(types.out.split("\n").filter(line => line.endsWith(" blob")).map(line => line.split(" ")[0]!));
    const names = new Set(touched.out.split("\0").map(name => name.trim()).filter(Boolean));
    const unscanned: [string, string][] = [];
    for (const match of named) {
      if (match[2]) names.add(match[2]);
      if (blobs.has(match[1]!) && !scanned.has(match[1]!)) unscanned.push([match[1]!, match[2]!]);
    }
    const history = path.join(scratch, "history");
    const extra = path.join(history, "names.txt");
    fs.mkdirSync(history);
    fs.writeFileSync(extra, `${[...names].sort().join("\n")}\n`);
    // One layer per reuse of a name, so each blob keeps the name it travelled under.
    const layers: string[][] = [];
    const taken: Set<string>[] = [];
    for (const [id, name] of unscanned) {
      if (name.split("/").some(segment => segment === "" || segment === "." || segment === ".." || segment === ".git")) return { ok: false, line: "the bundle carries an unsafe path name", cacheable: true };
      let layer = taken.findIndex(set => !set.has(name));
      if (layer < 0) { layer = taken.length; taken.push(new Set()); layers.push([]); }
      taken[layer]!.add(name);
      const target = path.join(history, `layer-${layer}`, name);
      const body = spawnSync("git", ["--git-dir", shipment.gitDir, "cat-file", "blob", id], { env: asProcessEnv(base), maxBuffer: 256 * 1024 * 1024 });
      if (body.status !== 0) return { ok: false, line: "the bundle's objects are unreadable", cacheable: false };
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body.stdout);
      layers[layer]!.push(target);
    }
    if (!layers.length) return gate(["--repository", history, "--require-known-values", "--paths", extra]);
    for (const [index, files] of layers.entries()) {
      const verdict = gate(["--repository", path.join(history, `layer-${index}`), "--require-known-values", "--paths", ...files, ...(index === 0 ? [extra] : [])]);
      if (!verdict.ok) return verdict;
    }
    return { ok: true };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the stream

export type Control = { kind: "started" } | { kind: "setup-failed"; step: string; detail: string } | { kind: "end"; code: number; tree: string } | { kind: "no-verdict"; reason: string };
export function parseControl(text: string): Control | null {
  if (text === "started") return { kind: "started" };
  let match = /^setup-failed (\S+(?: check)?) ?(.*)$/.exec(text);
  if (match) return { kind: "setup-failed", step: match[1]!, detail: match[2] ?? "" };
  match = /^end (\d{1,3}) ([0-9a-f]{40,64})$/.exec(text);
  if (match) return { kind: "end", code: Number(match[1]), tree: match[2]! };
  match = /^no-verdict (.+)$/.exec(text);
  if (match) return { kind: "no-verdict", reason: match[1]! };
  return null;
}

/** Splits the session's standard error into the command's bytes and control
 * records. A record is "\n<nonce> <record>\n"; its leading newline is removed
 * with it, so the command's bytes arrive unchanged. */
export class Demux {
  private pending = Buffer.alloc(0);
  private readonly marker: Buffer;
  constructor(nonce: string, private readonly emit: (bytes: Buffer) => void, private readonly control: (record: Control | null, raw: string) => void) {
    this.marker = Buffer.from(`\n${nonce} `);
  }
  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const at = this.pending.indexOf(this.marker);
      if (at < 0) {
        const keep = Math.min(this.pending.length, this.marker.length - 1);
        // Hold back a tail that could be the start of a marker.
        let cut = this.pending.length - keep;
        for (let size = keep; size > 0; size--) {
          if (this.pending.subarray(this.pending.length - size).equals(this.marker.subarray(0, size))) { cut = this.pending.length - size; break; }
          if (size === 1) cut = this.pending.length;
        }
        if (cut > 0) { this.emit(this.pending.subarray(0, cut)); this.pending = this.pending.subarray(cut); }
        return;
      }
      const end = this.pending.indexOf(0x0a, at + this.marker.length);
      if (end < 0) {
        if (at > 0) { this.emit(this.pending.subarray(0, at)); this.pending = this.pending.subarray(at); }
        return;
      }
      if (at > 0) this.emit(this.pending.subarray(0, at));
      const raw = this.pending.subarray(at + this.marker.length, end).toString("utf8");
      this.control(parseControl(raw), raw);
      this.pending = this.pending.subarray(end + 1);
    }
  }
  end(): void { if (this.pending.length) this.emit(this.pending); this.pending = Buffer.alloc(0); }
}

// ---------------------------------------------------------------- returned outputs

export interface TarEntry { name: string; body: Buffer }
/** A ustar stream of regular files only; anything else refuses the whole return. */
export function readUstar(data: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  const text = (start: number, length: number) => { const raw = data.subarray(start, start + length); const nul = raw.indexOf(0); return raw.subarray(0, nul < 0 ? length : nul).toString("utf8"); };
  for (;;) {
    if (offset + 512 > data.length) throw new Error("the archive ends inside a header");
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return entries;
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (parseInt(text(offset + 148, 8).trim() || "x", 8) !== sum) throw new Error("an archive header fails its checksum");
    const type = String.fromCharCode(header[156]!);
    if (type !== "0" && type !== "\0") throw new Error(`an archive entry is not a regular file (type ${JSON.stringify(type)})`);
    const prefix = text(offset + 345, 155), base = text(offset + 0, 100);
    const name = prefix ? `${prefix}/${base}` : base;
    const size = parseInt(text(offset + 124, 12).trim() || "x", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("an archive entry has no valid size");
    offset += 512;
    if (offset + size > data.length) throw new Error("the archive ends inside an entry");
    entries.push({ name, body: Buffer.from(data.subarray(offset, offset + size)) });
    offset += Math.ceil(size / 512) * 512;
  }
}

/** Two output roots overlap when one is the other or lies inside it. */
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const realOrResolved = (target: string) => { try { return fs.realpathSync(target); } catch { return path.resolve(target); } };

/** Output directories that coincide, nest, or reach the checkout would let one
 * returned entry land under another root. */
export function outputConflict(root: string, outputs: Record<string, string>): string | null {
  const realRoot = realOrResolved(root);
  const names = Object.keys(outputs).sort();
  for (const [index, name] of names.entries()) {
    const real = realOrResolved(outputs[name]!);
    if (overlaps(real, realRoot)) return `${name} overlaps the checkout`;
    for (const other of names.slice(index + 1)) if (overlaps(real, realOrResolved(outputs[other]!))) return `${name} and ${other} name overlapping directories`;
  }
  return null;
}

/** Where each entry lands here, after every path and parent has been checked,
 * against this machine's files and against every other entry of the return. */
export function returnPlan(entries: TarEntry[], root: string, outputs: Record<string, string>): { target: string; body: Buffer }[] {
  const conflict = outputConflict(root, outputs);
  if (conflict) throw new Error(`refused: ${conflict}`);
  const plan: { target: string; body: Buffer; base: string }[] = [];
  for (const entry of entries) {
    const segments = entry.name.split("/");
    if (path.isAbsolute(entry.name) || entry.name.includes("\\") || segments.some(segment => segment === ".." || segment === "." || segment === "")) throw new Error(`refused entry name ${JSON.stringify(entry.name.slice(0, 120))}`);
    let base: string, rest: string[];
    if (segments[0] === "tree" && (segments[1] === "evidence" || segments[1] === ".artifacts") && segments.length > 2) { base = root; rest = segments.slice(1); }
    else if (segments[0] === "out" && segments[1] && Object.hasOwn(outputs, segments[1]) && segments.length > 2) { base = outputs[segments[1]]!; rest = segments.slice(2); }
    else throw new Error(`refused entry outside the output roots: ${entry.name.slice(0, 120)}`);
    plan.push({ target: path.join(base, ...rest), body: entry.body, base });
  }
  const targets = new Set<string>();
  for (const { target } of plan) {
    if (targets.has(target)) throw new Error(`refused: two entries write ${path.basename(target)}`);
    targets.add(target);
  }
  for (const { target, base } of plan) {
    for (let dir = path.dirname(target); dir.length > base.length && dir.startsWith(base); dir = path.dirname(dir)) {
      if (targets.has(dir)) throw new Error(`refused: ${path.relative(base, dir)} is both a file and a directory in the return`);
      const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) throw new Error(`refused: ${path.relative(base, dir)} exists here as something other than a directory`);
    }
    const stat = fs.lstatSync(base, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory() && !(stat.isSymbolicLink() && base !== root)) throw new Error("refused: an output root is not a directory");
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error(`refused: ${path.basename(target)} exists here as something other than a file`);
  }
  return plan.map(({ target, body }) => ({ target, body }));
}

/** Writes every file beside its target first; only when all are written are
 * they renamed into place. A failure before that removes what was staged and
 * the directories it made; a failed rename puts back what it replaced. */
export function applyReturn(plan: { target: string; body: Buffer }[]): void {
  const suffix = `.gate-runner-${process.pid}-${randomBytes(4).toString("hex")}`;
  const made: string[] = [], staged: { target: string; next: string; backup: string | null }[] = [];
  const rollback = () => {
    for (const { next, backup } of staged) { fs.rmSync(next, { force: true }); if (backup) fs.rmSync(backup, { force: true }); }
    for (const dir of made.reverse()) { try { fs.rmdirSync(dir); } catch { /* not empty or gone */ } }
  };
  try {
    for (const { target, body } of plan) {
      const missing: string[] = [];
      for (let dir = path.dirname(target); !fs.existsSync(dir); dir = path.dirname(dir)) missing.unshift(dir);
      for (const dir of missing) { fs.mkdirSync(dir); made.push(dir); }
      const next = `${target}${suffix}`;
      fs.writeFileSync(next, body, { mode: 0o644, flag: "wx" });
      const item = { target, next, backup: null as string | null };
      staged.push(item);
      if (fs.existsSync(target)) { item.backup = `${target}${suffix}.old`; fs.linkSync(target, item.backup); }
    }
  } catch (error) {
    rollback();
    throw error;
  }
  const done: typeof staged = [];
  try {
    for (const item of staged) { fs.renameSync(item.next, item.target); done.push(item); }
  } catch (error) {
    for (const { target, backup } of done.reverse()) { if (backup) fs.renameSync(backup, target); else fs.rmSync(target, { force: true }); }
    for (const item of done) item.backup = null;
    rollback();
    throw error;
  }
  for (const { backup } of staged) if (backup) fs.rmSync(backup, { force: true });
}

// ---------------------------------------------------------------- the decision log

export function logDecision(env: Env, decision: "remote" | "here" | "ineligible", reason: string, shape: string, kind: string, now = new Date()): void {
  try {
    const dir = cacheDirectory(env);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "runner-decisions.log");
    fs.appendFileSync(file, `${now.toISOString()}\t${decision}\t${redact(reason).replace(/[\t\n]+/g, " ")}\t${shape}\t${kind}\n`);
    if ((fs.statSync(file).size) > 4 * 1024 * 1024) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-DECISION_LINES);
      const next = `${file}.${process.pid}.next`;
      fs.writeFileSync(next, `${lines.join("\n")}\n`);
      fs.renameSync(next, file);
    }
  } catch { /* the log is a measurement, never a gate */ }
}

// ---------------------------------------------------------------- main

const say = (line: string) => { try { fs.writeSync(2, `${line}\n`); } catch { /* the caller went away */ } };
const write = (fd: number, bytes: Buffer) => { try { fs.writeSync(fd, bytes); } catch { /* the caller went away */ } };

interface Session { child: ChildProcess; started: boolean; ended: Control | null; startedAt: number }

async function remoteRun(alias: string, env: Env, id: string, treeId: string, onSession: (child: ChildProcess) => void): Promise<{ started: boolean; end: Control | null; setup: Control | null; sshCode: number | null; seconds: number }> {
  const nonce = randomBytes(32).toString("hex");
  const command = `~/.bun/bin/bun ~/runs/${id}/serve.ts run ~/runs/${id}`;
  // LogLevel=QUIET: ssh's own lines (a lost connection names the host) would
  // reach the caller mixed into the command's standard error.
  const child = spawn(sshCommand(env), sshArgs(alias, command, ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "LogLevel=QUIET"]), { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  onSession(child);
  const session: Session = { child, started: false, ended: null, startedAt: Date.now() };
  let setup: Control | null = null;
  const held: Buffer[] = [];
  child.stdin!.on("error", () => { /* the session ended */ });
  // The push budget travels with the nonce, measured as the session opens.
  const remaining = env.LLV_GATE_PUSH_DEADLINE ? Math.floor(Number(env.LLV_GATE_PUSH_DEADLINE) - Date.now()) : NaN;
  child.stdin!.write(`${nonce} ${Number.isFinite(remaining) ? Math.max(0, remaining) : "-"}\n`);
  const demux = new Demux(nonce, bytes => { if (session.started) write(2, bytes); }, record => {
    if (!record) return;
    if (record.kind === "started" && !session.started) {
      session.started = true; session.startedAt = Date.now();
      say(`gate-runner: running on the gate runner (run ${id}, tree ${treeId.slice(0, 12)})`);
      for (const bytes of held.splice(0)) write(1, bytes);
    } else if (record.kind === "setup-failed" && !session.started) setup = record;
    else if ((record.kind === "end" || record.kind === "no-verdict") && session.started && !session.ended) session.ended = record;
  });
  child.stdout!.on("data", (chunk: Buffer) => { if (session.started) write(1, chunk); else held.push(chunk); });
  child.stderr!.on("data", (chunk: Buffer) => demux.push(chunk));
  const code = await new Promise<number | null>(resolve => child.on("close", exit => resolve(exit)));
  demux.end();
  child.stdin!.end();
  return { started: session.started, end: session.ended, setup, sshCode: code, seconds: Math.round((Date.now() - session.startedAt) / 1000) };
}

/** Tests shorten the wait for `serve.ts remove`; nothing else sets it. */
const removeTimeout = (env: Env) => Math.min(60_000, Number(env.LLV_GATE_RUNNER_REMOVE_TIMEOUT_MS) || 60_000);

function sshSync(env: Env, alias: string, command: string, timeout: number, input?: Buffer) {
  return spawnSync(sshCommand(env), sshArgs(alias, command), { input, timeout, maxBuffer: MAX_RETURN_BYTES + 1024 * 1024, env: process.env });
}

async function main(argv: string[]): Promise<number> {
  const env = process.env;
  const cwd = process.cwd();
  const wrapper = path.join(path.dirname(import.meta.dir), "gate-slot.sh");
  let shapeName = "-", kind = "-";
  const here = (reason: string | null, decision: "here" | "ineligible"): number => {
    logDecision(env, decision, reason ?? "", shapeName, kind);
    if (reason && decision === "here") say(`gate-runner: running here: ${redact(reason)}`);
    if (env.LLV_GATE_RUNNER_DECISION) { fs.writeFileSync(env.LLV_GATE_RUNNER_DECISION, "here\n"); return 0; }
    const result = spawnSync("/bin/bash", [wrapper, ...argv], { stdio: "inherit", env: asProcessEnv({ ...env, LLV_GATE_RUNNER: "off" }) });
    return result.status ?? 128 + 15;
  };
  if (!argv.length) return here(null, "ineligible");
  if (env.NODE_ENV === "test") return here("inside a test run", "ineligible");
  const target = resolveTarget(env);
  if (!target) return here("no runner configured", "ineligible");
  if ("off" in target) return here(target.off, "ineligible");
  const tree = findTree(cwd);
  if (refused(tree)) return here(tree.reason, "ineligible");
  kind = tree.kind;
  const shape = shapeOf(argv, tree, cwd, env);
  if (refused(shape)) return here(shape.reason, "ineligible");
  shapeName = shape.name;
  const mapped = mapArguments(argv, tree.root, cwd);
  if (refused(mapped)) return here(mapped.reason, "ineligible");
  const remoteEnv = remoteEnvironment(env, tree.root, cwd);
  if (refused(remoteEnv)) return here(remoteEnv.reason, "ineligible");

  const status = health(env, target.alias);
  if (!status.healthy) return here(`the runner is unavailable: ${status.reason}`, "here");

  const scratch = fs.mkdtempSync(path.join(env.TMPDIR && fs.existsSync(env.TMPDIR) ? env.TMPDIR : "/tmp", "gate-runner-"));
  const id = randomBytes(6).toString("hex");
  let session: ChildProcess | null = null, uploaded = false, cancelled: NodeJS.Signals | null = null, phase: "prepare" | "run" | "outputs" = "prepare";
  let settle: ((code: number) => void) | null = null;
  /** Null once the runner confirmed the run is gone (or nothing was uploaded);
   * otherwise why not. The run's directory and lease then stay there, and the
   * runner's sweep removes them once the lease is 30 minutes old. */
  const remove = (): string | null => {
    if (!uploaded) return null;
    const result = sshSync(env, target.alias, `~/.bun/bin/bun ~/runs/${id}/serve.ts remove ~/runs/${id}`, removeTimeout(env));
    if (result.status === 0) return null;
    const cause = result.status === null ? "it did not finish in time" : `it exited ${result.status}`;
    markUnhealthy(env, "cleanup on the runner failed");
    say(`gate-runner: cleanup on the runner was not confirmed (${cause}); run ${id} stays there until the runner's sweep removes it`);
    return cause;
  };
  const cancel = (signal: NodeJS.Signals) => {
    if (cancelled) return;
    cancelled = signal;
    const code = signal === "SIGINT" ? 130 : 143;
    if (phase === "run" && session) {
      session.stdin?.end();
      const stop = sshSync(env, target.alias, `systemctl --user stop gate-run-${id}`, 15_000);
      session.kill("SIGTERM");
      if (stop.status !== 0) {
        say("gate-runner: no verdict: cancellation was not confirmed on the runner");
        markUnhealthy(env, "cancellation was not confirmed");
        remove(); fs.rmSync(scratch, { recursive: true, force: true });
        settle?.(75); return;
      }
    }
    remove(); fs.rmSync(scratch, { recursive: true, force: true });
    settle?.(code);
  };
  // A cancelled run's code is never a pass, so a failed cleanup there only
  // marks the runner and says so.
  const outcome = new Promise<number>(resolve => { settle = resolve; });
  process.on("SIGTERM", () => cancel("SIGTERM"));
  process.on("SIGINT", () => cancel("SIGINT"));

  const work = (async (): Promise<number> => {
    let shipment: Shipment;
    try { shipment = ship(tree, scratch, status.main); }
    catch (error) { return here(`capturing the tree failed: ${(error as Error).message}`, "here"); }
    if (cancelled) return -1;
    const verdict = privacy(tree, shipment, env);
    if (!verdict.ok) return here(verdict.unfinished ? `the privacy scan did not finish: ${verdict.line}` : `the privacy scan refused the tree: ${verdict.line}`, "here");
    if (cancelled) return -1;
    const manifest = {
      version: 1, id, kind: tree.kind, tree: shipment.tree,
      ...(tree.kind === "git" ? { head: shipment.head, base: shipment.base } : { parent: shipment.parent }),
      argv: mapped, cwd: path.relative(tree.root, fs.realpathSync(cwd)) || ".", shape: shape.name,
      env: remoteEnv.env, outputs: Object.keys(remoteEnv.outputs).sort(),
      chrome: !!env.CHROME_BIN,
    };
    const upload = path.join(scratch, "upload");
    fs.mkdirSync(upload);
    fs.writeFileSync(path.join(upload, "manifest.json"), JSON.stringify(manifest));
    fs.renameSync(shipment.bundle, path.join(upload, "run.bundle"));
    fs.copyFileSync(path.join(import.meta.dir, "serve.ts"), path.join(upload, "serve.ts"));
    const archive = spawnSync("tar", ["-cf", "-", "-C", upload, "manifest.json", "run.bundle", "serve.ts"], { maxBuffer: 1024 * 1024 * 1024 });
    if (archive.status !== 0) return here("packing the upload failed", "here");
    uploaded = true;
    const sent = sshSync(env, target.alias, `mkdir -p ~/runs/${id} && tar -xf - -C ~/runs/${id}`, 120_000, archive.stdout);
    if (cancelled) return -1;
    if (sent.status !== 0) {
      markUnhealthy(env, "the upload failed");
      remove();
      return here(`upload failed: ssh exited ${sent.status ?? "on timeout"}`, "here");
    }
    phase = "run";
    const result = await remoteRun(target.alias, env, id, shipment.tree, child => { session = child; });
    if (cancelled) return -1;
    if (!result.started) {
      markUnhealthy(env, "a run failed before it started");
      remove();
      const setup = result.setup as Extract<Control, { kind: "setup-failed" }> | null;
      return here(setup ? `${setup.step} failed: ${setup.detail}` : `the runner session failed before the command started (ssh exited ${result.sshCode})`, "here");
    }
    if (result.end?.kind === "no-verdict") {
      markUnhealthy(env, "a run gave no verdict");
      remove();
      say(`gate-runner: no verdict: ${redact(result.end.reason)}; nothing was judged`);
      logDecision(env, "remote", "no verdict", shapeName, kind);
      return 75;
    }
    const end = result.end as Extract<Control, { kind: "end" }> | null;
    if (!end || end.tree !== shipment.tree) {
      markUnhealthy(env, "a run lost its verdict");
      remove();
      say(`gate-runner: no verdict: the connection to the runner was lost after ${result.seconds} s; nothing was judged`);
      logDecision(env, "remote", "no verdict", shapeName, kind);
      return 75;
    }
    if (shape.driver) {
      phase = "outputs";
      const returned = returnOutputs(env, target.alias, id, tree.root, remoteEnv.outputs);
      if (returned) {
        markUnhealthy(env, "outputs were not returned");
        remove();
        say(`gate-runner: no verdict: outputs were not returned (${redact(returned)})`);
        logDecision(env, "remote", "outputs refused", shapeName, kind);
        return 75;
      }
    }
    // A pass is reported only once the runner confirmed the run is gone; a
    // failing code stays decisive either way.
    const cleanup = remove();
    if (cleanup && end.code === 0) {
      say(`gate-runner: no verdict: the run passed, but its cleanup on the runner was not confirmed (${cleanup})`);
      logDecision(env, "remote", "exit 0, cleanup not confirmed", shapeName, kind);
      return 75;
    }
    logDecision(env, "remote", `exit ${end.code}${cleanup ? ", cleanup not confirmed" : ""}`, shapeName, kind);
    return end.code;
  })();
  const code = await Promise.race([work.then(value => value < 0 ? outcome : value), outcome]);
  fs.rmSync(scratch, { recursive: true, force: true });
  return code;
}

/** Fetches, checks and writes the driver's outputs; returns a refusal or null. */
function returnOutputs(env: Env, alias: string, id: string, root: string, outputs: Record<string, string>): string | null {
  const result = sshSync(env, alias, `~/.bun/bin/bun ~/runs/${id}/serve.ts pack-outputs ~/runs/${id}`, 300_000);
  const limit = returnLimit(env);
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOBUFS") return `the outputs exceed ${limit} bytes`;
  if (result.status !== 0) return `pack-outputs exited ${result.status ?? "on timeout"}`;
  const data = result.stdout as Buffer;
  if (data.length > limit) return `the outputs exceed ${limit} bytes`;
  try {
    const plan = returnPlan(readUstar(data), root, outputs);
    applyReturn(plan);
    const deleted = /^deleted (.*)$/m.exec(String(result.stderr ?? ""));
    if (deleted) say(`gate-runner: the run deleted output files, not propagated here: ${deleted[1]!.slice(0, 300)}`);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
