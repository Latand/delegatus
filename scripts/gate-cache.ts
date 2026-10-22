import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { systemBootEpoch } from "../src/lib/processIdentity";

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function fileFingerprint(file: string): string {
  return existsSync(file) && statSync(file).isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";
}
/** Include installed bytes: a lockfile alone cannot detect an edited compiler
 * or plugin. Bounded traversal follows package links, including an external
 * dependency directory, while breaking cycles. Hash large files in chunks.
 */
function treeFingerprint(directory: string, label: string, exclude: (relative: string) => boolean = () => false): string {
  const hash = createHash("sha256"), seen = new Set<string>();
  let entries = 0, bytes = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  const visit = (file: string, relative: string) => {
    if (exclude(relative)) return;
    if (++entries > 100_000) throw new Error("dependency fingerprint entry limit");
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${relative}:${readlinkSync(file)}\0`);
      const target = realpathSync(file);
      if (!seen.has(target)) { seen.add(target); visit(target, relative); }
    } else if (stat.isDirectory()) {
      hash.update(`dir:${relative}\0`);
      for (const child of readdirSync(file).sort()) visit(path.join(file, child), `${relative}/${child}`);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 2 * 1024 * 1024 * 1024) throw new Error("dependency fingerprint byte limit");
      // Installs sharing Bun's hard-linked cache flip group and other bits on
      // the same inode; only whether the owner may execute it reaches a check.
      hash.update(`file:${relative}:${stat.mode & 0o100 ? "x" : "-"}:${stat.size}\0`);
      const fd = openSync(file, "r");
      try { let count: number; while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
      finally { closeSync(fd); }
    } else throw new Error("unsupported dependency input");
  };
  if (existsSync(directory)) visit(directory, label);
  return hash.digest("hex");
}

export function installedFingerprint(root: string): string {
  return treeFingerprint(path.join(root, "node_modules"), "node_modules");
}

/** Git omits ignored compiler declarations, fixtures and configuration. Include
 * those bytes too. The compiler owns its incremental output; Git metadata and
 * installed dependencies have separate bindings in the receipt key.
 */
export function workingInputsFingerprint(root: string): string {
  return treeFingerprint(root, "checkout", relative => ["checkout/.git", "checkout/node_modules", "checkout/tsconfig.tsbuildinfo"].includes(relative));
}

export function cacheDirectory(root: string, family: string): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return path.join(common, "delegatus-gate", family);
}
/** Sources of the gate and its owned runner, excluding selected test inputs
 * (the immutable base already binds those). Follow imports without executing
 * modules; computed child entry points are explicitly listed here.
 */
export function gateToolFiles(root: string): string[] {
  const ts = new Bun.Transpiler({ loader: "ts" }), tsx = new Bun.Transpiler({ loader: "tsx" });
  const pending = ["scripts/local-gate.ts", "scripts/local-gate-tests.ts", "scripts/owned-runner.ts", "scripts/cpu-admission.ts", "scripts/test-child-guardian.ts", "scripts/test-child-ownership.preload.ts", "test-preload.ts"];
  const seen = new Set<string>();
  while (pending.length) {
    const relative = pending.pop()!;
    if (seen.has(relative)) continue;
    seen.add(relative);
    const file = path.join(root, relative);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    for (const imported of (file.endsWith(".tsx") ? tsx : ts).scanImports(readFileSync(file))) {
      if (!imported.path.startsWith(".") && !imported.path.startsWith("@/")) continue;
      const target = imported.path.startsWith("@/") ? path.join(root, "src", imported.path.slice(2)) : path.resolve(path.dirname(file), imported.path);
      const resolved = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, path.join(target, "index.ts")]
        .find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      if (resolved) pending.push(path.relative(root, resolved));
    }
  }
  return [...seen, "scripts/gate-slot.sh", "bunfig.toml", "tsconfig.json"].sort();
}

/** Isolation replaces these before a check reads them, or they only record
 * how this process was started. */
const ROOTS = new Set(["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "LLV_STATE_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR",
  "GEMINI_CLI_HOME", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "NODE_ENV", "LLV_VIEWER_CONTROL_URL"]);
const BOOKKEEPING = new Set(["PWD", "OLDPWD", "SHLVL", "_", "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MANAGERPID",
  "TERM", "COLORTERM", "PAGER", "GIT_PAGER", "GH_PAGER", "NO_COLOR", "FORCE_COLOR"]);
/** What a check may read, so its value is part of the key. */
const KEYED = /^(?:PATH|LANG|LANGUAGE|LC_[A-Z]+|TZ|USER|LOGNAME|SHELL|NODE_OPTIONS|BUN_[A-Z0-9_]+|CI|CHROME_BIN|PLAYWRIGHT_BROWSERS_PATH|GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM)|LLV_GATE_(?:BUN|CHECK_ENV))$/;
/** A commit identity that reaches a check is keyed by presence. Pre-push
 * checks receive none: the Viewer publishing a lane need not carry one, and
 * hosted CI has none either. */
const IDENTITY = /^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)$/;
/** Admission, placement and the signal boundary decide where and when a check
 * runs, never what it checks. The boundary's host epoch is keyed instead. */
const TRANSPORT = /^(?:LLV_SIGNAL_SANDBOX|LLV_(?:GATE|CPU|OWNED)_[A-Z0-9_]+|(?:LLV|DELEGATUS)_(?:AGENT_CPU|CPU_PRESSURE[A-Z0-9_]*|WORK_(?:SCOPE_)?CPU_QUOTA)|LLV_DOCKER_NSENTER_SHIMS|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|(?:HTTPS?|NO|ALL)_PROXY|(?:https?|no|all)_proxy|SSL_CERT_(?:FILE|DIR)|NODE_EXTRA_CA_CERTS)$/;
const declaredInputs = (env: Partial<NodeJS.ProcessEnv>) => new Set((env.LLV_GATE_CHECK_ENV ?? "").split(",").map(name => name.trim()).filter(Boolean));

/** One environment for every reusable check, whoever starts the hook: a stage
 * agent with its session, forge authority and Viewer endpoint, or the Viewer
 * publishing for it with its own settings, identity and push credentials.
 * None of that reaches a check. A caller hands further inputs by naming them in
 * LLV_GATE_CHECK_ENV, and they are keyed like the rest. Idempotent.
 */
export function checkEnvironment(env: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const declared = declaredInputs(env), result = {} as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (KEYED.test(name) || declared.has(name) || TRANSPORT.test(name) || ROOTS.has(name))) result[name] = value;
  }
  // The agent's forge directory shadows git and gh with credentialed shims.
  const forge = env.LLV_AGENT_FORGE_DIR ? path.resolve(env.LLV_AGENT_FORGE_DIR) : undefined;
  if (result.PATH !== undefined) result.PATH = result.PATH.split(path.delimiter)
    .filter(entry => !(entry && (path.resolve(entry) === forge || /[/\\]delegatus[/\\]agent-forge[/\\]/.test(`${path.resolve(entry)}/`)))).join(path.delimiter);
  return result;
}

/** The host a check ran on, read from the signal boundary when there is one:
 * its host epoch is the host's boot epoch, so a sandboxed producer and the
 * Viewer publishing on that host agree. Per-run boundary fields never count.
 */
export function hostEpoch(env: Partial<NodeJS.ProcessEnv>): string {
  if (env.LLV_SIGNAL_SANDBOX === undefined) return systemBootEpoch() ?? randomUUID();
  try {
    const boundary = JSON.parse(env.LLV_SIGNAL_SANDBOX) as { policyVersion?: unknown; hostEpoch?: unknown };
    if (boundary.policyVersion === 1 && typeof boundary.hostEpoch === "string" && boundary.hostEpoch) return boundary.hostEpoch;
  } catch { /* An unreadable boundary names no host. */ }
  return randomUUID();
}

/** Key everything that reaches a check from `env`, which is either a
 * checkEnvironment result or a test comparison's own inherited environment:
 * values for inputs, presence for a commit identity, the host epoch for the
 * signal boundary and the bytes of explicit Git configuration files.
 */
export function environmentFingerprint(env: Partial<NodeJS.ProcessEnv>): string {
  const inputs = Object.entries(env).filter(([name, value]) => value !== undefined && !ROOTS.has(name) && !BOOKKEEPING.has(name)
    && !IDENTITY.test(name) && (KEYED.test(name) || !TRANSPORT.test(name))
    && !/^(?:GIT_CONFIG(?:_COUNT|_PARAMETERS)?|GIT_CONFIG_(?:KEY|VALUE)_\d+|LLV_PRIVACY_[A-Z0-9_]+)$/.test(name))
    .map(([name, value]) => [name, name === "PATH" ? checkEnvironment({ PATH: value, LLV_AGENT_FORGE_DIR: env.LLV_AGENT_FORGE_DIR }).PATH : value])
    .filter(([name]) => name !== "LLV_AGENT_FORGE_DIR")
    .sort(([a], [b]) => a!.localeCompare(b!));
  const identity = Object.keys(env).filter(name => IDENTITY.test(name) && env[name] !== undefined).sort();
  const configuration = [env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_SYSTEM].map(file => {
    try { return file ? fileFingerprint(file) : "default"; }
    catch { return randomUUID(); } // Unreadable explicit configuration cannot certify reuse.
  });
  return fingerprint([inputs, identity, configuration, hostEpoch(env)]);
}

/** Each caller owns a namespace. Atomic, immutable-key records; corrupt,
 * oversized, expired or unavailable entries are misses. No values are logged.
 * Concurrent writers may briefly exceed the cap until the next write.
 */
export class GateCache<T> {
  constructor(readonly directory: string, private readonly valid: (value: unknown) => value is T, private readonly maxAgeMs = 7 * 24 * 60 * 60_000) {}
  read(key: string): T | undefined {
    try {
      const file = path.join(this.directory, `${fingerprint(key)}.json`);
      const stat = statSync(file);
      if (stat.size > 1024 * 1024 || Date.now() - stat.mtimeMs > this.maxAgeMs) return;
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (record.key === key && record.digest === fingerprint(record.value) && this.valid(record.value)) return record.value;
    } catch { /* Optional acceleration never authorizes a missing verdict. */ }
  }
  remove(key: string): void {
    try { rmSync(path.join(this.directory, `${fingerprint(key)}.json`), { force: true }); } catch { /* Miss on the next validated read. */ }
  }
  write(key: string, value: T): void {
    let temporary: string | undefined;
    try {
      const contents = JSON.stringify({ key, value, digest: fingerprint(value) });
      if (Buffer.byteLength(contents) > 1024 * 1024) return;
      mkdirSync(this.directory, { recursive: true });
      const files = readdirSync(this.directory).filter(file => /^(?:[a-f0-9]{64}\.json|\.write-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(file)).map(file => {
        const target = path.join(this.directory, file), stat = statSync(target);
        return { target, time: stat.mtimeMs, size: stat.size };
      }).sort((a, b) => b.time - a.time || a.target.localeCompare(b.target));
      let bytes = Buffer.byteLength(contents);
      for (const [index, file] of files.entries()) {
        bytes += file.size;
        if (index >= 255 || bytes > 32 * 1024 * 1024 || Date.now() - file.time > this.maxAgeMs) rmSync(file.target, { force: true });
      }
      temporary = path.join(this.directory, `.write-${randomUUID()}`);
      writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path.join(this.directory, `${fingerprint(key)}.json`));
    } catch { /* An unwritable cache costs a fresh run, never a gate refusal. */ }
    finally { if (temporary) try { rmSync(temporary, { force: true }); } catch { /* Cache cleanup cannot change the check verdict. */ } }
  }
}
