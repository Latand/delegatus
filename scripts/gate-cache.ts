import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

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
      hash.update(`file:${relative}:${stat.mode & 0o777}:${stat.size}\0`);
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

/** Hash all remaining environment inputs, including caller-specific test flags.
 * These exclusions are per-invocation transport, scheduling and sandbox roots;
 * the runner replaces roots before any cached check executes.
 */
export function environmentFingerprint(env: NodeJS.ProcessEnv): string {
  const roots = new Set(["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "TMP", "TEMP", "PWD", "OLDPWD", "SHLVL", "_", "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "NODE_ENV",
    "CODEX_HOME", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "GEMINI_CLI_HOME",
    "LLV_STATE_DIR", "LLV_STATE_OWNER", "LLV_INBOX_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "DELEGATUS_STATE_DIR",
    "LLV_VIEWER_CONTROL_URL", "LLV_LANG", "LLV_TOKEN", "LLV_DEBUG", "DELEGATUS_DEBUG", "LLV_LAUNCHER_REEXEC", "LLV_LAUNCHER_CHECKOUT",
    // Caller identity and Git transport do not choose the verification program.
    // Publication still runs its own authorization and credential gates.
    "CODEX_CI", "CODEX_VERSION", "CODEX_MANAGED_BY_BUN", "CODEX_MANAGED_PACKAGE_ROOT",
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE",
    "LLV_STAGE_GIT_WORKTREE", "LLV_STAGE_GIT_RECEIPT",
    "LLV_AGENT_FORGE_DIR", "LLV_AGENT_FORGE_REPOSITORIES", "LLV_AGENT_GIT_GUARD_DIR",
    "TERM", "COLORTERM", "PAGER", "GIT_PAGER", "GH_PAGER", "NO_COLOR", "FORCE_COLOR",
    // Both shell hooks and isolatedEnvironment remove these Git overlays.
    "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]);
  const inputs = Object.entries(env).filter(([name, value]) => value !== undefined && !roots.has(name)
    && !/^(?:LLV_CPU_|LLV_GATE_|LLV_OWNED_|LLV_PRIVACY_|GIT_CONFIG_(?:KEY|VALUE)_\d+$)/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const configuration = [env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_SYSTEM].map(file => {
    try { return file ? fileFingerprint(file) : "default"; }
    catch { return randomUUID(); } // Unreadable explicit configuration cannot certify reuse.
  });
  return fingerprint([inputs, configuration]);
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
