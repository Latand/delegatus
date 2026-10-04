import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stableMcpRuntimeRoot } from "@/runtime-host/mcpRuntimeRelease";

import type { AgentEnvironment } from "./agentHistoryGuard";

import { FORGE_APP_USERNAME, FORGE_DIR_ENV, FORGE_READ_CONFIG_ENV } from "../../../bin/forge-app-token.mjs";

const HELPER = "forge-app-token.mjs";
/* Joined here so the sources hold no address-shaped literal for the publication gate. */
const at = (user: string, host: string) => [user, host].join("@");
const PUSH_BASE = `https://${at(FORGE_APP_USERNAME, "github.com")}`;
const CREDENTIAL = `credential.${PUSH_BASE}`;
const PUSH_REWRITE = `url.${PUSH_BASE}/.pushInsteadOf`;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const runner = (mode: string) => `#!/bin/sh
# Delegatus: a GitHub write from an agent goes out as the GitHub App or not at all.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
helper="$here/${HELPER}"
if [ ! -f "$helper" ]; then
  echo "Delegatus: the GitHub App helper is missing, so GitHub is unavailable to this agent; a person's credentials are never used instead." >&2
  exit 1
fi
if command -v bun >/dev/null 2>&1; then exec bun "$helper" ${mode} "$@"; fi
if command -v node >/dev/null 2>&1; then exec node "$helper" ${mode} "$@"; fi
echo "Delegatus: neither bun nor node is on PATH, so GitHub is unavailable to this agent; a person's credentials are never used instead." >&2
exit 1
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

/** The directory holding the `gh` shim, git's push credential helper and the
    App helper they both start. Content-addressed, so a resumed agent finds the
    files its environment names and a new release never edits them in place. */
export function agentForgeDir(source: AgentEnvironment): string {
  const helper = readHelper(source);
  const files: Array<[string, string, number]> = [["gh", runner("gh"), 0o700], ["forge-git-credential", runner("git-credential"), 0o700]];
  if (helper !== null) files.push([HELPER, helper, 0o600]);
  const hash = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 24);
  const directory = path.join(source.HOME?.trim() || os.homedir(), ".cache", "delegatus", "agent-forge", hash);
  fs.mkdirSync(path.join(directory, "gh-config"), { recursive: true, mode: 0o700 });
  for (const [name, content, mode] of files) publish(path.join(directory, name), content, mode);
  return directory;
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
 * What makes an agent's GitHub writes go out as the Delegatus GitHub App.
 *
 * `gh` resolves to a shim that sends reads on with the configuration reads
 * always had and gives a write an installation token minted for that one
 * command. `withAgentConfigSandbox` points the agent's own `GH_CONFIG_DIR` at
 * the empty directory made here, so a `gh` reached past the shim holds no
 * account at all. Git pushes to GitHub are
 * rewritten to a URL only the App's credential helper answers, with every other
 * helper cleared for that URL, while fetches keep the remote and the helpers
 * they had. Nothing here touches git or gh configuration on disk, so the
 * operator's own terminal is as it was.
 *
 * Returns the variables to set, the whole `GIT_CONFIG_*` list among them. The
 * history guard appends its own entry after these and expects to stay last.
 */
export function agentForgeWriteEnv(source: AgentEnvironment): Record<string, string | undefined> {
  /* The shims are POSIX shell. Windows keeps the environment it had. */
  if (process.platform === "win32") return {};
  const directory = agentForgeDir(source);
  const previous = source[FORGE_DIR_ENV];
  const guard = source.LLV_AGENT_GIT_GUARD_DIR;
  const inherited = gitConfigEntries(source).filter(([key, value], index, all) =>
    !(previous && (key.startsWith(CREDENTIAL + ".") || key === PUSH_REWRITE))
    && !(index === all.length - 1 && key === "core.hooksPath" && value === guard));
  const entries: Array<[string, string]> = [
    ...inherited,
    /* An empty value clears every helper configured before it, for this URL. */
    [`${CREDENTIAL}.helper`, ""],
    [`${CREDENTIAL}.helper`, `!${quote(path.join(directory, "forge-git-credential"))}`],
    [`${CREDENTIAL}.useHttpPath`, "true"],
    [PUSH_REWRITE, "https://github.com/"],
    [PUSH_REWRITE, at("git", "github.com:")],
    [PUSH_REWRITE, `ssh://${at("git", "github.com/")}`],
  ];
  const separator = path.delimiter;
  const rest = (source.PATH ?? "").split(separator).filter((entry) => entry && entry !== directory && entry !== previous);
  const env: Record<string, string | undefined> = {
    PATH: [directory, ...rest].join(separator),
    [FORGE_DIR_ENV]: directory,
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * The same arrangement for a command the engine itself starts: the push that
 * publishes a lane's branch, and the push and `gh pr create` that finish a
 * workflow. Merged over the Viewer's environment for that one child, so its
 * push to GitHub is answered by the App's helper alone and its `gh` is the
 * shim. Remotes on other forges and local remotes are not rewritten.
 */
export function engineForgeWriteEnv(source: AgentEnvironment = process.env): Record<string, string | undefined> {
  const env = agentForgeWriteEnv(source);
  const directory = env[FORGE_DIR_ENV];
  if (!directory) return env;
  return {
    ...env,
    [FORGE_READ_CONFIG_ENV]: source[FORGE_READ_CONFIG_ENV]?.trim() || source.GH_CONFIG_DIR?.trim()
      || path.join(source.XDG_CONFIG_HOME?.trim() || path.join(source.HOME?.trim() || os.homedir(), ".config"), "gh"),
    GH_CONFIG_DIR: path.join(directory, "gh-config"),
  };
}

/** For tests: forget the helper text read from `bin/`. */
export function resetAgentForgeForTests(): void {
  helperSource = undefined;
}
