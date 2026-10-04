import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyClaudeSpawnPolicy } from "@/lib/agent/spawnPolicy";
import { withAgentConfigSandbox } from "@/lib/runtime/agentConfigSandbox";

import { agentForgeWriteEnv, engineForgeWriteEnv } from "./agentForgeCredentials";
import { agentCodexPublicationPolicy } from "./agentPublicationIdentity";

/* The launched environment against real git and the real App helper, with a
   stand-in `gh`, a stand-in operator credential helper and a credential store
   that holds nothing. Each stand-in writes a line when it runs, so "the
   operator's credential was not used" is the absence of that line. No network:
   the helper refuses before it would reach GitHub. */
const posix = process.platform !== "win32";
/* Address-shaped fixtures are joined, never written out. */
const at = (user: string, host: string) => [user, host].join("@");
const APP_PUSH_URL = `https://${at("x-access-token", "github.com")}/acme/widgets.git`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-forge-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const bin = path.join(root, "bin");
const operatorGh = path.join(root, "operator-gh");
const ghLog = path.join(root, "gh.log");
const operatorHelperLog = path.join(root, "operator-helper.log");
const globalConfig = path.join(root, "gitconfig");
const repo = path.join(root, "repo");
fs.mkdirSync(bin);
fs.mkdirSync(operatorGh);
fs.mkdirSync(repo);
const script = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
/* What `gh` was started with: its configuration directory and whether a token
   variable was present, never a token's value. */
script("gh", `printf '%s|config=%s|token=%s\\n' "$*" "$GH_CONFIG_DIR" "\${GH_TOKEN:+set}" >> ${JSON.stringify(ghLog)}`);
/* The credential store has no item: `secret-tool lookup` prints nothing and fails. */
script("secret-tool", "exit 1");
script("operator-helper", `echo "$1" >> ${JSON.stringify(operatorHelperLog)}\nif [ "$1" = get ]; then echo username=operator; echo ${["password", "operator-fixture"].join("=")}; fi`);
fs.writeFileSync(globalConfig, `[credential]\n\thelper = ${path.join(bin, "operator-helper")}\n`);

const source: NodeJS.ProcessEnv = {
  NODE_ENV: "test", HOME: root, TMPDIR: root, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  GH_CONFIG_DIR: operatorGh, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0",
};

/* The last shape is no agent: it is what the engine merges over its own
   environment for the push that publishes a lane and for `gh pr create`. */
const ENGINES = ["claude", "codex", "codex with a restrictive shell policy", "the engine's own writes"] as const;
type Engine = typeof ENGINES[number];

function launched(engine: Engine): NodeJS.ProcessEnv {
  if (engine === "the engine's own writes") return { ...source, ...engineForgeWriteEnv(source) };
  const env = withAgentConfigSandbox({ ...source }, source);
  if (engine === "claude") {
    const home = fs.mkdtempSync(path.join(root, "claude-"));
    const policy = applyClaudeSpawnPolicy(home, { publicationEnv: source });
    return { ...env, ...JSON.parse(fs.readFileSync(policy.settingsPath, "utf8")).env };
  }
  if (engine === "codex") return { ...env, ...agentCodexPublicationPolicy({}, source).set as NodeJS.ProcessEnv };
  /* A Codex shell that passes nothing but what the policy sets and includes:
     the shim and the Git entries are among what it sets. */
  const set = agentCodexPublicationPolicy({ include_only: ["HOME", "TMPDIR"] }, source).set as Record<string, string>;
  return { NODE_ENV: "test", HOME: source.HOME, TMPDIR: source.TMPDIR, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", ...set };
}

const sh = (args: string[], env: NodeJS.ProcessEnv, stdin = "") =>
  Bun.spawnSync(args, { cwd: repo, env, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);
const reset = () => { for (const file of [ghLog, operatorHelperLog]) fs.rmSync(file, { force: true }); };

Bun.spawnSync(["git", "init", "-q"], { cwd: repo, env: source });
for (const [name, url] of [["origin", "https://github.com/acme/widgets.git"], ["scp", `${at("git", "github.com")}:acme/widgets.git`],
  ["ssh", `ssh://${at("git", "github.com")}/acme/widgets.git`], ["elsewhere", "https://example.invalid/acme/widgets.git"]]) {
  Bun.spawnSync(["git", "remote", "add", name!, url!], { cwd: repo, env: source });
}

describe.skipIf(!posix).each([...ENGINES])("a GitHub write through %s", (engine: Engine) => {
  const env = launched(engine);
  /* A restrictive policy drops both gh variables, as it always dropped
     GH_CONFIG_DIR: gh then reads its default configuration. */
  const filtered = engine === "codex with a restrictive shell policy";

  test("finds the shim as gh, and holds no account of its own", () => {
    expect(sh(["sh", "-c", "command -v gh"], env).stdout.toString().trim()).toBe(path.join(env.LLV_AGENT_FORGE_DIR!, "gh"));
    if (!filtered) {
      expect(env.GH_CONFIG_DIR).toBe(path.join(env.LLV_AGENT_FORGE_DIR!, "gh-config"));
      expect(fs.readdirSync(env.GH_CONFIG_DIR!)).toEqual([]);
    }
    expect(env.GH_TOKEN ?? env.GITHUB_TOKEN).toBeUndefined();
  });

  test("a read reaches gh with the configuration reads always had", () => {
    reset();
    expect(sh(["gh", "pr", "view", "5"], env).exitCode).toBe(0);
    expect(lines(ghLog)).toEqual([`pr view 5|config=${filtered ? "" : operatorGh}|token=`]);
  });

  test("negative control: a write with no App credential fails with the message and gh is never started", () => {
    reset();
    for (const write of [["pr", "merge", "5", "--squash"], ["pr", "create", "--fill"], ["api", "-X", "PUT", "repos/acme/widgets/pulls/5/update-branch"]]) {
      const result = sh(["gh", ...write], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("Delegatus refused this GitHub write to acme/widgets: no GitHub App credential is available for it.");
      expect(result.stderr.toString()).toContain("never with a person's credentials, so nothing was sent");
    }
    /* The stand-in gh logs every start. Nothing started: the operator's
       configuration directory was handed to no process for these writes. */
    expect(lines(ghLog)).toEqual([]);
  });

  test("gh auth token hands out nothing", () => {
    reset();
    const result = sh(["gh", "auth", "token"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(lines(ghLog)).toEqual([]);
  });

  test("a push to GitHub is sent to the App's URL, whatever the remote's scheme, and a fetch keeps its own", () => {
    expect(sh(["git", "remote", "get-url", "--push", "origin"], env).stdout.toString().trim()).toBe(APP_PUSH_URL);
    expect(sh(["git", "remote", "get-url", "origin"], env).stdout.toString().trim()).toBe("https://github.com/acme/widgets.git");
    for (const remote of ["scp", "ssh"]) {
      expect(sh(["git", "remote", "get-url", "--push", remote], env).stdout.toString().trim()).toBe(APP_PUSH_URL);
    }
    /* Another forge is not GitHub's to answer for. */
    expect(sh(["git", "remote", "get-url", "--push", "elsewhere"], env).stdout.toString().trim()).toBe("https://example.invalid/acme/widgets.git");
  });

  test("negative control: the push credential is refused and the operator's helper is never asked", () => {
    reset();
    const result = sh(["git", "credential", "fill"], env, `url=${APP_PUSH_URL}\n\n`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).not.toContain(["password", ""].join("="));
    expect(result.stderr.toString()).toContain("Delegatus refused this GitHub write to acme/widgets");
    /* The operator's helper logs every call. It is configured, and it is the
       one a fetch gets (next test); for the push URL it was never started. */
    expect(lines(operatorHelperLog)).toEqual([]);
  });

  test("a fetch still gets the credential it always got", () => {
    reset();
    const result = sh(["git", "credential", "fill"], env, "url=https://github.com/acme/widgets.git\n\n");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("username=operator");
    expect(lines(operatorHelperLog)).toEqual(["get"]);
  });

  test.skipIf(engine === "the engine's own writes")("the history guard still refuses to rewrite another author's commit", () => {
    const count = Number(env.GIT_CONFIG_COUNT);
    expect(env[`GIT_CONFIG_KEY_${count - 1}`]).toBe("core.hooksPath");
    expect(env[`GIT_CONFIG_VALUE_${count - 1}`]).toBe(env.LLV_AGENT_GIT_GUARD_DIR);
  });
});

test.skipIf(!posix)("an environment launched from a launched environment carries each entry once", () => {
  const first = withAgentConfigSandbox({ ...source }, source);
  const second = withAgentConfigSandbox({ ...first }, first);
  const keys = (env: NodeJS.ProcessEnv) => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => `${env[`GIT_CONFIG_KEY_${index}`]}=${env[`GIT_CONFIG_VALUE_${index}`]}`);
  expect(keys(second)).toEqual(keys(first));
  expect(second.PATH).toBe(first.PATH);
  /* Reads keep the operator's configuration, not the first agent's empty one. */
  expect(second.LLV_AGENT_FORGE_READ_CONFIG_DIR).toBe(operatorGh);
});

test.skipIf(!posix)("the operator's own terminal is untouched: no shim, no rewrite, their helper answers a push", () => {
  reset();
  expect(sh(["sh", "-c", "command -v gh"], source).stdout.toString().trim()).toBe(path.join(bin, "gh"));
  expect(sh(["git", "remote", "get-url", "--push", "origin"], source).stdout.toString().trim()).toBe("https://github.com/acme/widgets.git");
  expect(sh(["git", "credential", "fill"], source, "url=https://github.com/acme/widgets.git\n\n").stdout.toString()).toContain("username=operator");
  expect(sh(["gh", "pr", "merge", "5"], source).exitCode).toBe(0);
  expect(lines(ghLog)).toEqual([`pr merge 5|config=${operatorGh}|token=`]);
  /* Launching agents wrote under the cache directory only. */
  expect(fs.readFileSync(globalConfig, "utf8")).toBe(`[credential]\n\thelper = ${path.join(bin, "operator-helper")}\n`);
  expect(fs.readdirSync(operatorGh)).toEqual([]);
});

test.skipIf(!posix)("no token, key or identifier is written into the launch directory", () => {
  const directory = agentForgeWriteEnv(source).LLV_AGENT_FORGE_DIR!;
  expect(fs.readdirSync(directory).sort()).toEqual(["forge-app-token.mjs", "forge-git-credential", "gh", "gh-config"]);
  expect(fs.readFileSync(path.join(directory, "forge-app-token.mjs"), "utf8")).toBe(fs.readFileSync(path.join(process.cwd(), "bin", "forge-app-token.mjs"), "utf8"));
  expect(fs.statSync(directory).mode & 0o077).toBe(0);
});
