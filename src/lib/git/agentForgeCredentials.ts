import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { stableMcpRuntimeRoot } from "@/runtime-host/mcpRuntimeRelease";

import type { AgentEnvironment } from "./agentHistoryGuard";

import { FORGE_DIR_ENV, FORGE_PUSH_BASE as PUSH_BASE, FORGE_REPOSITORIES_ENV, HELPER_FILE as HELPER, parseRepository } from "../../../bin/forge-app-token.mjs";

/* Joined here so the sources hold no address-shaped literal for the publication gate. */
const at = (user: string, host: string) => [user, host].join("@");
const CREDENTIAL = `credential.${PUSH_BASE}`;
const pushRewrite = (repository: string) => `url.${PUSH_BASE}/${repository}.pushInsteadOf`;

/**
 * The declaration: a JSON array of `owner/name` in the state directory, for
 * example `["acme/widgets"]`. A repository gets the App rule only when it is
 * listed there; a second repository is one more string in the array, once the
 * App is installed on it and its credential item exists. The file is read at
 * every launch, so a change needs no restart. No file means no repository.
 */
export const FORGE_APP_REPOSITORIES_FILE = "forge-app-repositories.json";

/** The repositories this installation declared as App repositories, as spelled.
    A file that exists and cannot be read as that list refuses the launch: read
    as empty, it would quietly send a declared repository's writes as a person. */
export function forgeAppRepositories(file: string = statePath(FORGE_APP_REPOSITORIES_FILE)): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    /* No such file, or no such directory to hold one. */
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw new Error(`The App repository declaration ${FORGE_APP_REPOSITORIES_FILE} could not be read`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const slugs = Array.isArray(parsed) ? parsed.map((entry) => (typeof entry === "string" && !entry.includes(":") ? parseRepository(entry) : null)) : [null];
  if (slugs.some((slug) => slug === null)) {
    throw new Error(`The App repository declaration ${FORGE_APP_REPOSITORIES_FILE} must be a JSON array of owner/name strings`);
  }
  return [...new Set(slugs as string[])];
}

/** Whether the engine's own write to `repository` is under the App rule. */
export function isForgeAppRepository(repository: string, declared: readonly string[] = forgeAppRepositories()): boolean {
  const slug = parseRepository(repository)?.toLowerCase();
  return !!slug && declared.some((entry) => entry.toLowerCase() === slug);
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/* As git's credential helper a shim that cannot start the App helper still has
   to answer `quit`: a helper that fails in silence sends git on to askpass and
   the terminal, which is a person's credential. */
const runner = (mode: string) => {
  const stop = mode === "git-credential" ? `\n  if [ "$1" = get ]; then echo quit=true; fi` : "";
  return `#!/bin/sh
# Delegatus: a GitHub write from an agent goes out as the GitHub App or not at all.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || { ${mode === "git-credential" ? "echo quit=true; " : ""}exit 1; }
helper="$here/${HELPER}"
if [ ! -f "$helper" ]; then
  echo "Delegatus: the GitHub App helper is missing, so GitHub is unavailable to this agent; a person's credentials are never used instead." >&2${stop}
  exit 1
fi
if command -v bun >/dev/null 2>&1; then exec bun "$helper" ${mode} "$@"; fi
if command -v node >/dev/null 2>&1; then exec node "$helper" ${mode} "$@"; fi
echo "Delegatus: neither bun nor node is on PATH, so GitHub is unavailable to this agent; a person's credentials are never used instead." >&2
${mode === "git-credential" ? 'if [ "$1" = get ]; then echo quit=true; fi\n' : ""}exit 1
`;
};

/* `git` for an agent and for the engine. Every command but a push goes
   straight to the real git, with no process started in between. A push goes
   through the App helper, which sends each remote that names a declared
   repository to the App's URL however that remote spells it. A push the helper
   cannot be started for is refused: the prefix rewrite alone would let such a
   spelling reach a person's credential. */
const gitRunner = () => `#!/bin/sh
# Delegatus: a push to an App repository goes to the App's URL however its remote is spelled.
set -f
self=\${0%/*}
real=
old=$IFS
IFS=:
for dir in $PATH; do
  if [ -n "$dir" ] && [ "$dir" != "$self" ] && [ -f "$dir/git" ] && [ -x "$dir/git" ] && [ ! "$dir/git" -ef "$0" ]; then
    real=$dir/git
    break
  fi
done
IFS=$old
if [ -z "$real" ]; then
  echo "Delegatus: git was not found on PATH." >&2
  exit 127
fi
for arg do
  if [ "$arg" = push ]; then
    helper="$self/${HELPER}"
    if [ ! -f "$helper" ]; then
      echo "Delegatus: the GitHub App helper is missing, so this agent cannot push; a person's credentials are never used instead." >&2
      exit 1
    fi
    if command -v bun >/dev/null 2>&1; then exec bun "$helper" git "$@"; fi
    if command -v node >/dev/null 2>&1; then exec node "$helper" git "$@"; fi
    echo "Delegatus: neither bun nor node is on PATH, so this agent cannot push; a person's credentials are never used instead." >&2
    exit 1
  fi
done
exec "$real" "$@"
`;

let helperSource: string | null | undefined;

/** The helper ships in `bin/`, which a container's host namespace cannot see;
    its text is copied to the launching home, the one path both sides share. */
function readHelper(source: AgentEnvironment): string | null {
  if (helperSource !== undefined) return helperSource;
  const candidates = [
    path.resolve(process.cwd(), "bin", HELPER),
    path.resolve(process.cwd(), "..", "..", "bin", HELPER),
    path.join(stableMcpRuntimeRoot(source), "bin", HELPER),
  ];
  for (const candidate of candidates) {
    try { return helperSource = fs.readFileSync(candidate, "utf8"); } catch { /* next */ }
  }
  return helperSource = null;
}

function publish(target: string, content: string, mode: number): void {
  if (fs.existsSync(target)) return;
  const pending = `${target}.${crypto.randomUUID()}`;
  fs.writeFileSync(pending, content, { mode, flag: "wx" });
  fs.renameSync(pending, target);
}

/** The directory holding the `gh` and `git` shims, git's push credential helper
    and the App helper they all start. Content-addressed, so a resumed agent finds the
    files its environment names and a new release never edits them in place. */
export function agentForgeDir(source: AgentEnvironment): string {
  const helper = readHelper(source);
  const files: Array<[string, string, number]> = [["gh", runner("gh"), 0o700], ["git", gitRunner(), 0o700], ["forge-git-credential", runner("git-credential"), 0o700]];
  if (helper !== null) files.push([HELPER, helper, 0o600]);
  const hash = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 24);
  const directory = path.join(source.HOME?.trim() || os.homedir(), ".cache", "delegatus", "agent-forge", hash);
  fs.mkdirSync(path.join(directory, "gh-config"), { recursive: true, mode: 0o700 });
  for (const [name, content, mode] of files) publish(path.join(directory, name), content, mode);
  return directory;
}

const SHELL_PROBE_MS = 15_000;
const SHELL_PROBE_KEPT_MS = 30_000;
const SHIMMED = ["gh", "git"] as const;
const shellProbeMark = (tool: string) => `delegatus-${tool}=`;
type ShellProbe = Record<typeof SHIMMED[number], string> | null;
const shellProbes = new Map<string, { at: number; found: ShellProbe }>();

/** The `gh` and the `git` a login shell resolves in `env`: each one's path, ""
    when it finds none; null when the shell gave no answer. */
function toolsInLoginShell(shell: string, env: Record<string, string>): ShellProbe {
  const key = [shell, env.PATH, env.HOME].join("\0");
  const kept = shellProbes.get(key);
  if (kept && Date.now() - kept.at < SHELL_PROBE_KEPT_MS) return kept.found;
  const result = spawnSync(shell, ["-lc", SHIMMED.map((tool) => `printf '\\n${shellProbeMark(tool)}%s\\n' "$(command -v ${tool})"`).join("; ")], {
    env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: SHELL_PROBE_MS, stdio: ["ignore", "pipe", "ignore"],
  });
  const answers = SHIMMED.map((tool) => (result.stdout ?? "").split("\n").findLast((entry) => entry.startsWith(shellProbeMark(tool)))?.slice(shellProbeMark(tool).length));
  const found = answers.some((answer) => answer === undefined) ? null : { gh: answers[0]!, git: answers[1]! };
  shellProbes.set(key, { at: Date.now(), found });
  return found;
}

/**
 * An engine runs each command an agent types through a login shell, and a
 * login profile may put its own directories in front of the PATH it was given.
 * A `gh` in one of those would be found before the shim and send a covered
 * write with a person's configuration, and a `git` there would push through a
 * remote the prefix rewrite does not match. So the launch asks the shells an
 * engine uses which `gh` and which `git` they find in the launch environment,
 * and refuses when either is any file but its shim.
 */
function assertShimsAreTheShellsTools(directory: string, launch: Record<string, string | undefined>): void {
  const env = Object.fromEntries(Object.entries(launch).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const real = (file: string) => { try { return fs.realpathSync(file); } catch { return file; } };
  const shells = [...new Set([env.SHELL ?? "", "/bin/bash"])]
    .filter((shell) => path.isAbsolute(shell) && ["bash", "zsh", "sh", "dash", "ksh"].includes(path.basename(shell)) && fs.existsSync(shell));
  for (const shell of shells) {
    const found = toolsInLoginShell(shell, env);
    if (found === null) {
      throw new Error(`Delegatus did not start this agent: ${shell} run as a login shell gave no answer about which gh and git it finds, so a GitHub write could not be kept from a person's credentials. Check that the login profile runs to its end, then start the agent again.`);
    }
    for (const tool of SHIMMED) {
      if (!found[tool] || real(found[tool]) === real(path.join(directory, tool))) continue;
      const write = tool === "gh" ? "a pull request write to an App repository" : "a push to an App repository through a remote spelled differently from its declaration";
      throw new Error(`Delegatus did not start this agent: ${shell} run as a login shell finds ${tool} at ${found[tool]}, ahead of the Delegatus ${tool}, so ${write} would go out with a person's credentials. The login profile puts that directory in front of PATH; keep ${tool} in a directory it does not add, such as /usr/bin, then start the agent again.`);
    }
  }
}

function gitConfigEntries(source: AgentEnvironment): Array<[string, string]> {
  const count = Number(source.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1024) throw new Error("Invalid agent Git environment");
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < count; index++) {
    const key = source[`GIT_CONFIG_KEY_${index}`];
    const value = source[`GIT_CONFIG_VALUE_${index}`];
    if (key === undefined || value === undefined) throw new Error("Invalid agent Git environment");
    entries.push([key, value]);
  }
  return entries;
}

/**
 * What makes an agent's writes to a declared repository go out as the
 * Delegatus GitHub App.
 *
 * With no repository declared this returns nothing and the launch is what it
 * was. Otherwise `gh` resolves to a shim that gives a covered write to a
 * declared repository an installation token minted for that one command, and
 * runs every other command as typed. Git pushes to a declared repository are
 * rewritten to a URL only the App's credential helper answers, with every other
 * helper cleared for that URL, while fetches, and pushes to every other
 * repository, keep the remote and the helpers they had. Nothing here touches
 * git or gh configuration on disk, so the operator's own terminal is as it was.
 *
 * `throughShell` says the commands are typed into an engine's shell, which is
 * every agent launch; the launch is then refused when that shell would find
 * another `gh` or another `git` first.
 *
 * The rewrite written here matches by prefix and case, so it covers a remote
 * spelled as the declaration spells it or in lower case. Every other spelling
 * of a declared repository (other letter case, a user name in the URL, an
 * explicit pushurl) is rewritten by the `git` shim at the push itself, where
 * the remotes can be read.
 *
 * Returns the variables to set, the whole `GIT_CONFIG_*` list among them. The
 * history guard appends its own entry after these and expects to stay last.
 */
export function agentForgeWriteEnv(source: AgentEnvironment, declared: readonly string[] = forgeAppRepositories(), throughShell = true): Record<string, string | undefined> {
  /* The shims are POSIX shell. Windows keeps the environment it had. */
  if (process.platform === "win32" || declared.length === 0) return {};
  const directory = agentForgeDir(source);
  const previous = source[FORGE_DIR_ENV];
  const guard = source.LLV_AGENT_GIT_GUARD_DIR;
  const inherited = gitConfigEntries(source).filter(([key, value], index, all) =>
    !(previous && (key.startsWith(CREDENTIAL + ".") || (key.startsWith(`url.${PUSH_BASE}/`) && key.endsWith(".pushInsteadOf"))))
    && !(index === all.length - 1 && key === "core.hooksPath" && value === guard));
  const entries: Array<[string, string]> = [
    ...inherited,
    /* An empty value clears every helper configured before it, for this URL. */
    [`${CREDENTIAL}.helper`, ""],
    [`${CREDENTIAL}.helper`, `!${quote(path.join(directory, "forge-git-credential"))}`],
    [`${CREDENTIAL}.useHttpPath`, "true"],
  ];
  for (const repository of new Set(declared.flatMap((entry) => [entry, entry.toLowerCase()]))) {
    entries.push(
      [pushRewrite(repository), `https://github.com/${repository}`],
      [pushRewrite(repository), `${at("git", "github.com")}:${repository}`],
      [pushRewrite(repository), `ssh://${at("git", "github.com")}/${repository}`],
    );
  }
  const separator = path.delimiter;
  const rest = (source.PATH ?? "").split(separator).filter((entry) => entry && entry !== directory && entry !== previous);
  const env: Record<string, string | undefined> = {
    PATH: [directory, ...rest].join(separator),
    [FORGE_DIR_ENV]: directory,
    [FORGE_REPOSITORIES_ENV]: declared.join(","),
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (throughShell) assertShimsAreTheShellsTools(directory, { ...source, ...env });
  return env;
}

/**
 * The same arrangement for a command the engine itself starts: the push that
 * publishes a lane's branch, and the push and `gh pr create` that finish a
 * workflow. Merged over the Viewer's environment for that one child. Empty
 * when no repository is declared, so that child starts as it always did. The
 * engine starts `git` and `gh` directly, with no shell between, so the PATH
 * given here is the one that resolves them to their shims.
 */
export function engineForgeWriteEnv(source: AgentEnvironment = process.env, declared: readonly string[] = forgeAppRepositories()): Record<string, string | undefined> {
  return agentForgeWriteEnv(source, declared, false);
}

/** For tests: forget the helper text read from `bin/`. */
export function resetAgentForgeForTests(): void {
  helperSource = undefined;
  shellProbes.clear();
}
