import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonical, inside, passwdHome, PROJECT_KIND, sealableProject, temporaryRoots } from "../../../bin/destructive-guard.mjs";
import { appConfigDir, stateDir } from "@/lib/configDir";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { listClaudeAccounts, legacyClaudeHome, claudeCapabilitiesRoot } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { knownProjectFileRoots } from "@/lib/scanner/projectDirectories";
import { projectCurationSnapshot } from "@/lib/projects/curation";
import { repositoryRootForPath } from "@/lib/projects/identity";
import { stableMcpRuntimeRoot } from "@/runtime-host/mcpRuntimeRelease";
import { jsonSpans, edit, removeArrayItems, tomlStatements } from "@/lib/memory/hookMigration";
import { toolsInLoginShell } from "@/lib/git/agentForgeCredentials";

export const DESTRUCTIVE_GUARD_PREFIX = "LLV_MANAGED_DESTRUCTIVE_GUARD=1 ";
type Env = Record<string, string | undefined>;
export type GuardPolicy = { v: number; digest: string; computedAt: string; home: string[]; sealed: { path: string; kind: string }[]; configured?: string[] };
const sha = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const managed = (value: unknown) => typeof value === "string" && value.startsWith(DESTRUCTIVE_GUARD_PREFIX);

function assertTestTarget(value: string) {
  if (process.env.NODE_ENV !== "test" && !process.argv.includes("test")) return;
  const actualHome = canonical(passwdHome());
  const privateHome = process.env.HOME && canonical(process.env.HOME) !== actualHome ? canonical(process.env.HOME) : null;
  const target = canonical(value), temporary = canonical(os.tmpdir());
  if (!(inside(target, temporary) || privateHome && (target === privateHome || inside(target, privateHome)))) throw Error("guard test target is outside its isolated home and temp directory");
}

function sourceFile(name: string) {
  const roots = [path.resolve(process.cwd(), "bin"), path.resolve(process.cwd(), "../../bin")];
  const directory = typeof import.meta.dir === "string" ? import.meta.dir
    : typeof import.meta.url === "string" && import.meta.url.startsWith("file:") ? path.dirname(fileURLToPath(import.meta.url)) : null;
  if (directory) roots.unshift(path.resolve(directory, "agent-guard"), path.resolve(directory, "../../../bin"), path.resolve(directory, "../bin"));
  for (const root of roots) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  throw new Error("destructive guard program is missing from release");
}
function atomic(file: string, text: string, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", mode);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function verified(file: string, text: string, mode: number) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== mode || stat.size !== Buffer.byteLength(text)) return false;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { return sha(fs.readFileSync(fd)) === sha(text); } finally { fs.closeSync(fd); }
  } catch { return false; }
}
export function publishDestructiveGuard(source: Env = process.env) {
  const script = sourceFile("destructive-guard.mjs"), wrapper = sourceFile("destructive-wrapper.sh"), fastRm = sourceFile("destructive-rm.sh");
  // Embed the same checked body once, with Bash's conditional builtin and no
  // second function dispatch. The inputs are shipped source, never commands.
  const start = "delegatus_guard_rm() {\n", end = '\n}\nif [ "${LLV_DESTRUCTIVE_GUARD_DEFINE_ONLY';
  if (!fastRm.includes(start) || !fastRm.includes(end)) throw Error("guard rm source is invalid");
  const body = fastRm.slice(fastRm.indexOf(start) + start.length, fastRm.indexOf(end)).replaceAll("[ ", "[[ ").replaceAll(" ]", " ]]");
  const shellEnv = sourceFile("destructive-shell-env.sh").replace("# DELEGATUS_RM_BODY", body);
  const version = sha(script + wrapper + fastRm + shellEnv).slice(0, 24);
  const root = path.join(source.HOME || os.homedir(), ".cache/delegatus/agent-guard");
  assertTestTarget(root);
  const directory = path.join(root, version);
  for (const [name, text, mode] of [["destructive-guard.mjs", script, 0o600], ["rm", fastRm, 0o700], ["shell-env.sh", shellEnv, 0o600], ...["slow-rm", "find", "rsync", "mv"].map(tool => [tool, wrapper, 0o700])] as [string, string, number][]) {
    const file = path.join(directory, name);
    if (!verified(file, text, mode)) { atomic(file, text, mode); if (!verified(file, text, mode)) throw Error("guard repair failed"); }
  }
  return { root, directory, version, program: path.join(directory, "destructive-guard.mjs"), policyFile: path.join(root, "policy.json") };
}

/** Explicit inputs let tests compute the production policy over a fake tree. */
export function computeDestructivePolicy(source: Env, options: { home?: string; projects?: string[]; accounts?: string[]; cwd?: string; previous?: GuardPolicy } = {}): GuardPolicy {
  const home = options.home ?? passwdHome();
  const config = source.XDG_CONFIG_HOME || path.join(home, ".config");
  const state = source.LLV_STATE_DIR || stateDir();
  const entries: { path: string; kind: string }[] = [];
  const add = (value: string | undefined, kind: string) => {
    if (!value || !path.isAbsolute(value)) return;
    for (const spelling of new Set([value, canonical(value)])) entries.push({ path: spelling, kind });
  };
  for (const name of ["delegatus", "agent-log-viewer", "live-log-viewer"]) add(path.join(config, name), "Delegatus configuration");
  add(state, "the Delegatus state directory");
  add(appConfigDir(), "Delegatus configuration");
  add(path.join(source.XDG_CACHE_HOME || path.join(home, ".cache"), "delegatus"), "Delegatus release cache");
  add(path.join(source.HOME || home, ".cache/delegatus"), "Delegatus release cache");
  add(stableMcpRuntimeRoot(source), "Delegatus runtime");
  for (const name of [".claude", ".claude.json", ".codex", ".ssh", ".gnupg", ".git-credentials", ".netrc"]) add(path.join(home, name), "an account or secrets directory");
  add(path.join(config, "gh"), "forge credentials"); add(path.join(config, "systemd/user"), "service files");
  for (const account of options.accounts ?? [...listClaudeAccounts().map(account => account.home), ...listCodexAccounts().map(account => account.home), legacyClaudeHome(), claudeCapabilitiesRoot()]) add(account, "an account's credentials");
  for (const account of [source.CODEX_HOME, source.CLAUDE_CONFIG_DIR, source.LLV_CODEX_HOME, source.LLV_CLAUDE_HOME]) add(account, "an account's credentials");
  // A catalogued session cwd can be the home, `/` or a temp root. Sealing one
  // of those as a project would refuse every delete beneath it.
  const homes = [...new Set([home, canonical(home)])], temporary = temporaryRoots([source.TMPDIR ?? ""]);
  for (const project of options.projects ?? [...knownProjectFileRoots(), ...projectCurationSnapshot().manualProjects.map(project => project.root)]) {
    if (!project || !path.isAbsolute(project)) continue;
    for (const spelling of new Set([project, canonical(project)])) if (sealableProject(spelling, homes, temporary)) entries.push({ path: spelling, kind: PROJECT_KIND });
  }
  let configured = options.previous?.configured ?? [];
  const file = path.join(state, "destructive-guard-protected.json");
  if (fs.existsSync(file)) {
    try {
      const list: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(list) || !list.every(value => typeof value === "string" && (path.isAbsolute(value) || value.startsWith("~/")))) throw Error("expected absolute path array");
      configured = list.map(value => value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
    } catch { guardOff("destructive-guard-protected.json is invalid; retaining the last valid list"); }
  }
  for (const value of configured) add(value, "an operator-protected directory");
  const protectedPaths = new Map<string, { path: string; kind: string }>();
  for (const entry of entries) {
    const previous = protectedPaths.get(entry.path);
    if (!previous || previous.kind === PROJECT_KIND && entry.kind !== PROJECT_KIND) protectedPaths.set(entry.path, entry);
  }
  const sealed = [...protectedPaths.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { v: 1, digest: sha(JSON.stringify({ home: homes, sealed, configured })), computedAt: new Date().toISOString(), home: homes, sealed, configured };
}
function guardOff(reason: string) {
  console.warn("[destructive guard]", reason);
  try {
    const directory = stateDir(), owner = process.env.LLV_STATE_OWNER, revision = process.env.LLV_HOT_STATE_RELEASE_REVISION;
    const root = fs.statSync(directory, { throwIfNoEntry: false });
    void import("@/lib/lifecycle/journal").then(({ appendLifecycleEvents }) => {
      if (stateDir() !== directory || process.env.LLV_STATE_OWNER !== owner || process.env.LLV_HOT_STATE_RELEASE_REVISION !== revision) return;
      const live = fs.statSync(directory, { throwIfNoEntry: false });
      if (root && (!live || live.dev !== root.dev || live.ino !== root.ino)) return;
      assertStateStartupMutation(directory, "record destructive guard status");
      appendLifecycleEvents([{ type: "destructive_guard_off", key: `destructive-guard-off:${sha(reason)}:${Math.floor(Date.now() / 30000)}`, at: new Date().toISOString(), summary: reason }]);
    }).catch(() => {});
  } catch { /* stderr remains available when status storage cannot be resolved */ }
}

function refreshPolicy(source: Env, installed: ReturnType<typeof publishDestructiveGuard>) {
  let previous: GuardPolicy | undefined;
  try { previous = JSON.parse(fs.readFileSync(installed.policyFile, "utf8")); } catch { /* first launch */ }
  const policy = computeDestructivePolicy(source, { previous });
  if (previous?.digest !== policy.digest || sha(JSON.stringify({ home: previous.home, sealed: previous.sealed, configured: previous.configured })) !== policy.digest) atomic(installed.policyFile, JSON.stringify(policy));
  const fastStamp = path.join(installed.root, "policy.stamp");
  let stamp = ""; try { stamp = fs.readFileSync(fastStamp, "utf8"); } catch { /* first launch */ }
  if (stamp !== policy.digest) atomic(fastStamp, policy.digest);
  return { policy, fastStamp };
}

export function agentDestructiveGuardEnv(source: Env, { cwd }: { cwd: string }): Env {
  if (process.platform === "win32") return {};
  try {
    const installed = publishDestructiveGuard(source);
    // Keep a union in the shared artifact: one launch must never unseal another
    // launch's project. Own roots provide the per-agent exception at evaluation.
    const { policy, fastStamp } = refreshPolicy(source, installed);
    // `/` means the launch named no working tree (an operator terminal). Its
    // hook and wrappers then own the project the session reports working in.
    const sessionRoot = !cwd || cwd === "/";
    const checkout = sessionRoot ? null : repositoryRootForPath(cwd);
    const ownCwd = sessionRoot ? undefined : checkout && fs.lstatSync(path.join(checkout, ".git"), { throwIfNoEntry: false })?.isFile() ? checkout : cwd;
    const candidates = [ownCwd, source.TMPDIR, source.LLV_AGENT_SANDBOX_ROOT, source.LLV_EVIDENCE_DIR].filter((value): value is string => !!value && path.isAbsolute(value) && !value.includes(":"));
    const own = [...new Set(candidates.map(canonical))].filter(root => !policy.home.some(home => home === root || inside(home, root)) && !policy.sealed.some(entry => entry.path === root && entry.kind !== PROJECT_KIND));
    const fast = own.filter(root => !policy.sealed.some(entry => inside(entry.path, root)));
    const inheritedPath = (source.PATH || process.env.PATH || "/usr/bin:/bin").split(path.delimiter).filter(entry => !/\/delegatus\/agent-guard\/[^/]+$/.test(entry));
    const boundPath = [installed.directory, ...inheritedPath].join(path.delimiter);
    const realRm = [...inheritedPath, "/usr/bin", "/bin"].filter(entry => path.isAbsolute(entry)).map(entry => path.join(entry, "rm")).find(file => {
      try { return fs.statSync(file).isFile() && !!(fs.statSync(file).mode & 0o111) && !/\/delegatus\/agent-guard\//.test(fs.realpathSync(file)); } catch { return false; }
    });
    const result: Env = { PATH: boundPath, LLV_DESTRUCTIVE_GUARD_BOUND_PATH: boundPath, LLV_DESTRUCTIVE_GUARD_RM: realRm, LLV_DESTRUCTIVE_GUARD_FAST_STAMP: fastStamp, LLV_DESTRUCTIVE_GUARD_POLICY_DIGEST: policy.digest,
      BASH_ENV: path.join(installed.directory, "shell-env.sh"), LLV_DESTRUCTIVE_GUARD_PREVIOUS_BASH_ENV: /\/delegatus\/agent-guard\//.test(source.BASH_ENV || "") ? source.LLV_DESTRUCTIVE_GUARD_PREVIOUS_BASH_ENV : source.BASH_ENV,
      LLV_DESTRUCTIVE_GUARD_DIR: installed.directory,
      LLV_DESTRUCTIVE_GUARD_POLICY: installed.policyFile, LLV_DESTRUCTIVE_GUARD_OWN: own.join(":"), LLV_DESTRUCTIVE_GUARD_FAST: fast.join(":"),
      LLV_DESTRUCTIVE_GUARD_SESSION_ROOT: sessionRoot ? "1" : undefined,
      LLV_DESTRUCTIVE_GUARD_JOURNAL: path.join(source.LLV_STATE_DIR || stateDir(), "destructive-guard/refusals.ndjson"),
      LLV_DESTRUCTIVE_GUARD_CALLER: source.LLV_SPAWN_CAPABILITY ? sha(source.LLV_SPAWN_CAPABILITY) : source.LLV_DESTRUCTIVE_GUARD_CALLER,
      LLV_DESTRUCTIVE_GUARD_BUN: source.LLV_DESTRUCTIVE_GUARD_BUN || (source.LLV_DOCKER_NSENTER_SHIMS === "1" ? "bun" : process.versions.bun ? process.execPath : "bun"), LLV_DESTRUCTIVE_GUARD_NESTED: "on" };
    const launch = Object.fromEntries(Object.entries({ ...source, HOME: source.HOME || os.homedir(), ...result }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    for (const shell of new Set([source.SHELL || "/bin/bash", "/bin/bash"])) {
      if (!path.isAbsolute(shell) || !fs.existsSync(shell)) continue;
      const found = toolsInLoginShell(shell, launch);
      for (const tool of ["rm", "find", "mv", "rsync"] as const) if (!found || found[tool] && found[tool] !== path.join(installed.directory, tool)) {
        result.LLV_DESTRUCTIVE_GUARD_NESTED = "off";
        guardOff(`nested guard off: ${shell} login profile resolves ${tool} outside the guard directory`);
      }
    }
    return Object.fromEntries(Object.entries(result).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error) { guardOff(`nested guard unavailable: ${error instanceof Error ? error.message : "installation failed"}`); return {}; }
}

function safeTarget(file: string, source: Env) {
  let target = file;
  try { target = fs.realpathSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (target !== file && ![passwdHome(), source.HOME].some(root => root && inside(target, canonical(root)))) throw Error("account config link is outside home");
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw Error("account config is not a regular private file");
  return target;
}
function replaceConfig(file: string, before: string, after: string, source: Env) {
  if (before === after) return;
  const target = safeTarget(file, source);
  const backup = path.join(source.LLV_STATE_DIR || stateDir(), "migrations/destructive-guard", sha(file).slice(0, 16), `${path.basename(file)}-${sha(before)}`);
  atomic(backup, before);
  if ((fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "") !== before || safeTarget(file, source) !== target) throw Error("account config changed during guard installation");
  atomic(target, after);
}
export function destructiveGuardHandler(source: Env = process.env) {
  const installed = publishDestructiveGuard(source);
  // Manual account sessions have no launch env. Pin the policy/journal paths.
  const command = `${DESTRUCTIVE_GUARD_PREFIX}LLV_DESTRUCTIVE_GUARD_POLICY=${quote(installed.policyFile)} LLV_DESTRUCTIVE_GUARD_JOURNAL=${quote(path.join(source.LLV_STATE_DIR || stateDir(), "destructive-guard/refusals.ndjson"))} bun ${quote(installed.program)} hook`;
  return { type: "command" as const, command, timeout: 10 };
}
export function guardTrust(group: { matcher: string; hooks: { command: string; type: string; timeout: number }[] }) {
  return "sha256:" + sha(JSON.stringify({ event_name: "pre_tool_use", hooks: group.hooks.map(handler => ({ async: false, command: handler.command, timeout: handler.timeout, type: handler.type })), matcher: group.matcher }));
}

export function ensureDestructiveGuard({ engine, home, source = process.env }: { engine: "claude" | "codex"; home: string; source?: Env }) {
  const accountOff = (reason: string) => guardOff(`${engine} account ${home}: ${reason}`);
  let handler: ReturnType<typeof destructiveGuardHandler>;
  try { refreshPolicy(source, publishDestructiveGuard(source)); handler = destructiveGuardHandler(source); }
  catch {
    accountOff("guard program could not be published; launch boundary is off");
    return { hook: engine === "claude" ? "per-launch" as const : "session" as const, nested: "off" as const,
      handler: { type: "command" as const, command: `${DESTRUCTIVE_GUARD_PREFIX}printf '%s\\n' 'Delegatus destructive guard is unavailable' >&2`, timeout: 10 } };
  }
  try {
    assertTestTarget(home);
    assertStateStartupMutation(source.LLV_STATE_DIR || stateDir(), "install destructive guard hooks");
    const filename = path.join(home, engine === "claude" ? "settings.json" : "hooks.json");
    // Missing managed Claude settings must keep the shared capability default.
    if (engine === "claude" && !fs.existsSync(filename) && canonical(home) !== canonical(source.LLV_CLAUDE_HOME || path.join(source.HOME || os.homedir(), ".claude"))) return { hook: "per-launch" as const, nested: "on" as const, handler };
    const target = safeTarget(filename, source), before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "{}";
    const data = JSON.parse(before);
    if (!data || typeof data !== "object" || Array.isArray(data) || data.hooks != null && (typeof data.hooks !== "object" || Array.isArray(data.hooks))) throw Error("invalid account hooks");
    if (engine === "claude" && (data.disableAllHooks === true || data.allowManagedHooksOnly === true)) accountOff("account disables the destructive guard for manual sessions");
    const groups = data.hooks?.PreToolUse ?? [];
    if (!Array.isArray(groups)) throw Error("invalid PreToolUse groups");
    const group = { matcher: "Bash", hooks: [handler] };
    const canonicalFile = canonical(filename);
    const receiptFile = path.join(source.LLV_STATE_DIR || stateDir(), "migrations/destructive-guard", sha(canonicalFile).slice(0, 16), "receipt.json");
    let recordedIndex = -1;
    let recordedTrust: string | undefined;
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      if (receipt.file === canonicalFile && Number.isSafeInteger(receipt.group) && receipt.group >= 0) {
        recordedIndex = receipt.group;
        if (typeof receipt.trust === "string") recordedTrust = receipt.trust;
      }
    } catch { /* first install */ }
    // A removed handler's position may now belong to a personal hook. Only
    // the managed prefix proves declaration ownership; lost markers get a
    // fresh group, while the receipt retires only our matching old trust.
    const owned = (_i: number, _h: number, command: unknown) => managed(command);
    let index = groups.findIndex((candidate, i) => candidate?.matcher === "Bash" && candidate?.hooks?.length === 1 && owned(i, 0, candidate.hooks[0]?.command));
    if (index < 0) index = groups.length;
    const tree = jsonSpans(before), span = tree.properties?.get("hooks")?.properties?.get("PreToolUse");
    const edits: { start: number; end: number; text?: string }[] = [];
    const disabled: string[] = [];
    for (const [i, candidate] of groups.entries()) {
      if (!Array.isArray(candidate?.hooks)) continue;
      const personal = candidate.hooks.filter((hook: { command?: unknown }, h: number) => !owned(i, h, hook?.command));
      if (personal.length !== candidate.hooks.length) {
        const handlers = span!.items![i].properties!.get("hooks")!.items!;
        if (i === index) edits.push({ start: handlers[0].start, end: handlers[0].end, text: JSON.stringify(handler) });
        else if (engine === "codex" && personal.length) {
          // Keep every personal byte and trust index. Retire only the managed
          // handler's trust; a new standalone group owns the current guard.
          for (const [h, hook] of candidate.hooks.entries()) if (owned(i, h, hook?.command)) disabled.push(`:pre_tool_use:${i}:${h}`);
        } else edits.push(...removeArrayItems(handlers, new Set(candidate.hooks.flatMap((hook: { command?: unknown }, h: number) => owned(i, h, hook?.command) ? [h] : []))));
      }
    }
    if (!span) {
      const hooks = tree.properties?.get("hooks");
      if (hooks) edits.push({ start: hooks.end - 1, end: hooks.end - 1, text: `${hooks.properties?.size ? "," : ""}"PreToolUse":[${JSON.stringify(group)}]` });
      else edits.push({ start: tree.end - 1, end: tree.end - 1, text: `${tree.properties?.size ? "," : ""}"hooks":{"PreToolUse":[${JSON.stringify(group)}]}` });
    } else if (index === groups.length) edits.push({ start: span.end - 1, end: span.end - 1, text: `${groups.length ? "," : ""}${JSON.stringify(group)}` });
    const next = edit(before, edits); JSON.parse(next);
    replaceConfig(filename, fs.existsSync(target) ? before : "", next, source);
    if (engine === "codex") {
      const configLink = path.join(home, "config.toml"), configTarget = safeTarget(configLink, source);
      const config = fs.existsSync(configTarget) ? fs.readFileSync(configTarget, "utf8") : "";
      const parsed = Bun.TOML.parse(config) as { features?: { hooks?: boolean; codex_hooks?: boolean }; hooks?: { state?: Record<string, unknown> } };
      const key = `${fs.realpathSync(filename)}:pre_tool_use:${index}:0`;
      const expected = { enabled: true, trusted_hash: guardTrust(group) };
      const disabledKeys = disabled.flatMap(suffix => Object.keys(parsed.hooks?.state ?? {}).filter(entry => entry.startsWith(fs.realpathSync(filename) + ":") && entry.endsWith(suffix)));
      const retiredKeys = Object.keys(parsed.hooks?.state ?? {}).filter(entry => {
        if (entry === key || disabledKeys.includes(entry)) return false;
        const match = /^(.*):pre_tool_use:(\d+):(\d+)$/.exec(entry);
        if (!match || canonical(match[1]) !== canonicalFile) return false;
        const previousTrust = Number(match[2]) === recordedIndex && Number(match[3]) === 0 && recordedTrust !== undefined && (parsed.hooks?.state?.[entry] as { trusted_hash?: string })?.trusted_hash === recordedTrust;
        return previousTrust || owned(Number(match[2]), Number(match[3]), groups[Number(match[2])]?.hooks?.[Number(match[3])]?.command);
      });
      if (JSON.stringify(parsed.hooks?.state?.[key]) !== JSON.stringify(expected) || retiredKeys.length || disabledKeys.some(key => (parsed.hooks?.state?.[key] as { enabled?: boolean })?.enabled !== false)) {
        const { headers, assignments } = tomlStatements(config);
        const removals: { start: number; end: number }[] = [];
        for (const [i, header] of headers.entries()) {
          const states = (header.table.hooks as { state?: object })?.state;
          if (states && Object.keys(states).some(entry => entry === key || disabledKeys.includes(entry) || retiredKeys.includes(entry))) {
            removals.push(header);
            for (const assignment of assignments) if (assignment.start >= header.end && assignment.start < (headers[i + 1]?.start ?? config.length)) removals.push(assignment);
          }
        }
        const nextConfig = edit(config, removals) + `\n[hooks.state.${JSON.stringify(key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(expected.trusted_hash)}\n` + disabledKeys.map(key => `\n[hooks.state.${JSON.stringify(key)}]\nenabled = false\n`).join("");
        Bun.TOML.parse(nextConfig); replaceConfig(configLink, config, nextConfig, source);
      }
      const verifiedTrust = (Bun.TOML.parse(fs.readFileSync(configLink, "utf8")) as { hooks?: { state?: Record<string, { enabled?: boolean; trusted_hash?: string }> } }).hooks?.state?.[key];
      if (verifiedTrust?.enabled !== true || verifiedTrust.trusted_hash !== expected.trusted_hash) throw Error("guard trust verification failed");
      if (parsed.features?.hooks === false || parsed.features?.codex_hooks === false) accountOff("account disables hooks for manual sessions");
    }
    // Re-read the actual disk declaration before reporting an account install.
    const installed = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (installed.hooks.PreToolUse[index]?.hooks?.[0]?.command !== handler.command) throw Error("guard verification failed");
    try { atomic(receiptFile, JSON.stringify({ v: 1, file: canonicalFile, group: index, trust: guardTrust(group) })); }
    catch { accountOff("account guard ownership receipt could not be refreshed"); }
    return { hook: "account" as const, nested: "on" as const, handler };
  } catch (error) {
    accountOff(`account hook uses launch fallback: ${error instanceof Error ? error.message : "verification failed"}`);
    return { hook: engine === "claude" ? "per-launch" as const : "session" as const, nested: "on" as const, handler };
  }
}

export function installDestructiveGuardForAccounts() {
  assertStateStartupMutation(stateDir(), "install destructive guard hooks");
  agentDestructiveGuardEnv(process.env, { cwd: process.cwd() });
  for (const home of new Set([legacyClaudeHome(), ...listClaudeAccounts().map(account => account.home)])) ensureDestructiveGuard({ engine: "claude", home });
  for (const home of new Set([process.env.LLV_CODEX_HOME || path.join(os.homedir(), ".codex"), ...listCodexAccounts().map(account => account.home)])) ensureDestructiveGuard({ engine: "codex", home });
}
