import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function fixtureGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]) delete clean[key];
  for (const key of Object.keys(clean)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete clean[key];
  return clean;
}
export function createHookFixture(root: string, roots: string[], realLint = false, controlledClock = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "hooks-e2e-")); roots.push(dir);
  for (const leaf of [".githooks", "scripts", "shims", ".github/workflows"]) mkdirSync(path.join(dir, leaf), { recursive: true });
  for (const hook of ["pre-commit", "pre-push"]) copyFileSync(path.join(root, ".githooks", hook), path.join(dir, ".githooks", hook));
  symlinkSync(path.join(root, "scripts/local-gate.ts"), path.join(dir, "scripts/local-gate.ts"));
  if (realLint) {
    symlinkSync(path.join(root, "scripts/eslint-changes.ts"), path.join(dir, "scripts/eslint-changes.ts"));
    symlinkSync(path.join(root, "eslint.config.mjs"), path.join(dir, "eslint.config.mjs"));
    symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  }
  for (const file of ["gate-slot.sh", "verify-native-codex-runtime.ts"]) copyFileSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  const gateSlot = path.join(dir, "scripts/gate-slot.sh");
  if (controlledClock) {
    const gateSlotSource = readFileSync(gateSlot, "utf8").replace("run() {\n", "run() {\n  if [[ \"${2:-}\" == scripts/local-gate.ts ]]; then set -- \"$1\" --preload \"$HOOK_CLOCK\" \"${@:2}\"; fi\n");
    writeFileSync(gateSlot, gateSlotSource);
  }
  symlinkSync(path.join(root, "scripts/owned-runner.ts"), path.join(dir, "scripts/owned-runner.ts"));
  symlinkSync(path.join(root, "scripts/cpu-admission.ts"), path.join(dir, "scripts/cpu-admission.ts"));
  for (const file of ["platform-tests.yml", "bun-runtime.yml"]) copyFileSync(path.join(root, ".github/workflows", file), path.join(dir, ".github/workflows", file));
  const log = path.join(dir, ".git", "commands.jsonl");
  const clock = path.join(dir, "controlled-clock.ts");
  writeFileSync(clock, "Date.now = () => Number(process.env.HOOK_CLOCK_NOW);\n");
  writeFileSync(path.join(dir, "record.ts"), `import { appendFileSync, mkdtempSync, rmSync } from "node:fs"; import { execFileSync } from "node:child_process"; import { tmpdir } from "node:os"; import path from "node:path"; const fixture = mkdtempSync(path.join(tmpdir(), "hook-child-git-")); try { execFileSync("git", ["init", "--bare", fixture], { stdio: "pipe" }); } finally { rmSync(fixture, { recursive: true, force: true }); } appendFileSync(process.env.HOOK_LOG!, JSON.stringify({ args: process.argv.slice(2), now: Date.now(), state: process.env.LLV_STATE_DIR, home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, tmp: process.env.TMPDIR, known: process.env.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE, gitDir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE, workTree: process.env.GIT_WORK_TREE, commonDir: process.env.GIT_COMMON_DIR, configCount: process.env.GIT_CONFIG_COUNT, configKey: process.env.GIT_CONFIG_KEY_0, deadline: process.env.LLV_GATE_PUSH_DEADLINE, ownedBudget: process.env.LLV_OWNED_RUN_TIMEOUT_MS, names: Object.keys(process.env).sort(), path: process.env.PATH }) + "\\n"); if (process.env.HOOK_FAIL && process.argv.includes(process.env.HOOK_FAIL)) process.exit(19);`);
  for (const name of ["bun", "bunx"]) {
    const shim = path.join(dir, "shims", name);
    writeFileSync(shim, '#!/bin/bash\nif [[ "$1" == scripts/local-gate.ts ]]; then if [[ -n "${HOOK_CLOCK:-}" ]]; then exec "$HOOK_BUN" --preload "$HOOK_CLOCK" "$@"; fi; exec "$HOOK_BUN" "$@"; fi\nif [[ "$1" == scripts/eslint-changes.ts && "$HOOK_REAL_LINT" == 1 ]]; then exec "$HOOK_BUN" "$@"; fi\nif [[ -n "${HOOK_CLOCK:-}" ]]; then exec "$HOOK_BUN" --preload "$HOOK_CLOCK" "$HOOK_RECORD" "$@"; fi\nexec "$HOOK_BUN" "$HOOK_RECORD" "$@"\n'); chmodSync(shim, 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...fixtureGitEnv(), PATH: `${path.join(dir, "shims")}:${process.env.PATH}`, HOOK_LOG: log, HOOK_RECORD: path.join(dir, "record.ts"), ...(controlledClock ? { HOOK_CLOCK: clock, HOOK_CLOCK_NOW: "1900000000000" } : {}), HOOK_BUN: process.execPath, LLV_GATE_BUN: process.execPath, LLV_GATE_LOCK_DIR: path.join(dir, ".git", "cpu-gate"), GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "noreply@example.invalid", LLV_SKIP_HOOKS: "0",
    // Checks see only the gate's canonical environment; the fixture's own seams are declared inputs.
    LLV_GATE_CHECK_ENV: "HOOK_LOG,HOOK_RECORD,HOOK_BUN,HOOK_FAIL,HOOK_CLOCK,HOOK_CLOCK_NOW,HOOK_REAL_LINT,PEER_PASSED,CHECK_PID,HELPER_PID,QUEUE_PROBE" };
  delete env.LLV_GATE_PUSH_DEADLINE;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null");
  writeFileSync(path.join(dir, "package.json"), "{}"); writeFileSync(path.join(dir, "example.ts"), "export const value = 1;\n");
  writeFileSync(path.join(dir, "example.test.ts"), "// hook fixture\n"); git("add", "."); git("commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD"); git("config", "core.hooksPath", ".githooks");
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; now?: number; state?: string; home?: string; config?: string; tmp?: string; known?: string; gitDir?: string; index?: string; workTree?: string; commonDir?: string; configCount?: string; configKey?: string; deadline?: string; ownedBudget?: string; names: string[]; path?: string });
  return { dir, env: { ...env, HOOK_REAL_LINT: realLint ? "1" : "0" }, git, calls };
}

/** The variable names a Claude stage agent carries (values are stand-ins), and
 * a Viewer process environment the publication hook env is derived from. */
export function agentEnvironments(base: Partial<NodeJS.ProcessEnv>, forge: string) {
  const producer: NodeJS.ProcessEnv = { ...base, PATH: `${forge}${path.delimiter}${base.PATH}`, AI_AGENT: "claude-code", CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_CODE_EXECPATH: "/opt/claude", CLAUDE_CODE_MESSAGING_SOCKET: "/run/messaging.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "session-token-stand-in", CLAUDE_CODE_SESSION_ATTENDED: "0", CLAUDE_CODE_SESSION_ID: "session-1", CLAUDE_CODE_TMPDIR: "/tmp/agent",
    CLAUDE_CONFIG_DIR: "/agent/claude", CLAUDE_EFFORT: "high", CLAUDE_PID: "4242", COREPACK_ENABLE_AUTO_PIN: "0", GH_CONFIG_DIR: path.join(forge, "gh-config"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: path.join(forge, "forge-git-credential"), GIT_EDITOR: "true",
    GIT_AUTHOR_NAME: "Agent", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Agent", GIT_COMMITTER_EMAIL: "noreply@example.invalid",
    LLV_AGENT_FORGE_DIR: forge, LLV_AGENT_FORGE_REPOSITORIES: "owner/repository", LLV_AGENT_GIT_GUARD_DIR: "/agent/guard", LLV_GATE_CPU_PRIORITY_SOURCE: "stage",
    LLV_PRIVACY_KNOWN_VALUES_FILE: "/agent/lessons.json", LLV_SPAWN_CAPABILITY: "capability-stand-in", LLV_STAGE_GIT_RECEIPT: "/agent/receipt",
    LLV_STAGE_GIT_WORKTREE: "/agent/worktree", LLV_STATE_DIR: "/agent/state", LLV_STRUCTURED_HOST: "host-1", LLV_VIEWER_PORT: "8898", NODE_ENV: "production",
    NoDefaultCurrentDirectoryInExePath: "1", TMPDIR: "/agent/tmp", XDG_CONFIG_HOME: "/agent/config", CODEX_THREAD_ID: "thread-1" };
  const viewer: NodeJS.ProcessEnv = { ...base, LLV_STATE_OWNER: "viewer", LLV_LANG: "uk", LLV_TOKEN: "viewer-token-stand-in", NODE_ENV: "production", PORT: "8898",
    HOSTNAME: "0.0.0.0", NEXT_RUNTIME: "nodejs", MANAGERPID: "1", INVOCATION_ID: "viewer-unit", TELEGRAM_BOT_TOKEN: "bot-token-stand-in" };
  return { producer, viewer };
}
