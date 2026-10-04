import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyClaudeSpawnPolicy } from "@/lib/agent/spawnPolicy";
import { withAgentConfigSandbox } from "@/lib/runtime/agentConfigSandbox";

import { statePath } from "@/lib/configDir";

import { FORGE_APP_REPOSITORIES_FILE, agentForgeWriteEnv, engineForgeWriteEnv, forgeAppRepositories, isForgeAppRepository } from "./agentForgeCredentials";
import { agentCodexPublicationPolicy, agentPublicationIdentityEnv } from "./agentPublicationIdentity";

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
const declaration = statePath(FORGE_APP_REPOSITORIES_FILE);
fs.mkdirSync(path.dirname(declaration), { recursive: true });
afterAll(() => fs.rmSync(declaration, { force: true }));
/* What this installation declared, as the launch reads it. */
const declare = (repositories: string[] | null) => (repositories ? fs.writeFileSync(declaration, JSON.stringify(repositories)) : fs.rmSync(declaration, { force: true }));
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

function launched(engine: Engine, declared: string[] | null): NodeJS.ProcessEnv {
  declare(declared);
  if (engine === "the engine's own writes") return { ...source, ...engineForgeWriteEnv(source) };
  const env = withAgentConfigSandbox({ ...source }, source);
  if (engine === "claude") {
    const home = fs.mkdtempSync(path.join(root, "claude-"));
    const policy = applyClaudeSpawnPolicy(home, { publicationEnv: source });
    return { ...env, ...JSON.parse(fs.readFileSync(policy.settingsPath, "utf8")).env };
  }
  if (engine === "codex") return { ...env, ...agentCodexPublicationPolicy({}, source).set as NodeJS.ProcessEnv };
  /* A Codex shell that passes PATH and what the policy sets and includes. */
  const set = agentCodexPublicationPolicy({ include_only: ["PATH", "HOME", "TMPDIR"] }, source).set as Record<string, string>;
  return { NODE_ENV: "test", PATH: source.PATH, HOME: source.HOME, TMPDIR: source.TMPDIR, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", ...set };
}

const sh = (args: string[], env: NodeJS.ProcessEnv, stdin = "") =>
  Bun.spawnSync(args, { cwd: repo, env, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);
const reset = () => { for (const file of [ghLog, operatorHelperLog]) fs.rmSync(file, { force: true }); };
const pushUrl = (remote: string, env: NodeJS.ProcessEnv) => sh(["git", "remote", "get-url", "--push", remote], env).stdout.toString().trim();

const REMOTES: Array<[string, string]> = [
  ["origin", "https://github.com/acme/widgets.git"], ["scp", `${at("git", "github.com")}:acme/widgets.git`],
  ["ssh", `ssh://${at("git", "github.com")}/acme/widgets.git`], ["elsewhere", "https://example.invalid/acme/widgets.git"],
  ["gadgets", `${at("git", "github.com")}:acme/gadgets.git`], ["sibling", "https://github.com/acme/widgets-site.git"],
];
Bun.spawnSync(["git", "init", "-q"], { cwd: repo, env: source });
for (const [name, url] of REMOTES) Bun.spawnSync(["git", "remote", "add", name, url], { cwd: repo, env: source });

/* Every `gh` command and every push question the comparison below asks. The
   covered kinds come first, then kinds the App holds no permission for. */
const GH_COMMANDS = [
  ["pr", "merge", "5", "--squash"], ["pr", "create", "--fill"], ["pr", "edit", "5", "--body", "b"], ["api", "-X", "PUT", "repos/acme/widgets/pulls/5/update-branch"],
  ["issue", "create", "-t", "t"], ["workflow", "run", "ci.yml"], ["run", "rerun", "9"], ["pr", "view", "5"], ["auth", "token"],
];
const UNCOVERED = GH_COMMANDS.slice(4);

/** Everything observable about one environment's GitHub traffic: each `gh`
    start as the stand-in logged it, each remote's push URL, and who answered
    the push credential. */
function transcript(env: NodeJS.ProcessEnv) {
  reset();
  const gh = GH_COMMANDS.map((args) => sh(["gh", ...args], env).exitCode);
  const started = lines(ghLog);
  reset();
  const urls = REMOTES.map(([name]) => pushUrl(name, env));
  const credential = sh(["git", "credential", "fill"], env, `url=${pushUrl("origin", env)}\n\n`).stdout.toString();
  return { gh, started, urls, credential, helper: lines(operatorHelperLog) };
}

describe.skipIf(!posix).each([...ENGINES])("a write to a declared repository through %s", (engine: Engine) => {
  const env = launched(engine, ["acme/widgets"]);
  const filtered = engine === "codex with a restrictive shell policy";
  /* A restrictive policy drops GH_CONFIG_DIR, as it always did: gh then reads
     its default configuration. */
  const config = filtered ? "" : operatorGh;

  test("finds the shim as gh, and no token variable", () => {
    expect(sh(["sh", "-c", "command -v gh"], env).stdout.toString().trim()).toBe(path.join(env.LLV_AGENT_FORGE_DIR!, "gh"));
    expect(env.LLV_AGENT_FORGE_REPOSITORIES).toBe("acme/widgets");
    expect(env.GH_TOKEN ?? env.GITHUB_TOKEN).toBeUndefined();
  });

  test("negative control: a covered write with no App credential fails with the message and gh is never started", () => {
    reset();
    for (const write of GH_COMMANDS.slice(0, 4)) {
      const result = sh(["gh", ...write], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("Delegatus refused this GitHub write to acme/widgets: no GitHub App credential is available for it.");
      expect(result.stderr.toString()).toContain("never with a person's credentials, so nothing was sent");
    }
    /* The stand-in gh logs every start. Nothing started: the operator's
       configuration directory was handed to no process for these writes. */
    expect(lines(ghLog)).toEqual([]);
  });

  test("a kind the App holds no permission for, and a read, reach gh as typed", () => {
    reset();
    for (const args of UNCOVERED) expect(sh(["gh", ...args], env).exitCode).toBe(0);
    expect(lines(ghLog)).toEqual(UNCOVERED.map((args) => `${args.join(" ")}|config=${config}|token=`));
  });

  test("a covered kind aimed at an undeclared repository reaches gh as typed", () => {
    reset();
    expect(sh(["gh", "pr", "merge", "5", "--repo", "acme/gadgets"], env).exitCode).toBe(0);
    expect(lines(ghLog)).toEqual([`pr merge 5 --repo acme/gadgets|config=${config}|token=`]);
  });

  test("a push to the declared repository is sent to the App's URL, whatever the remote's scheme, and nothing else is", () => {
    for (const remote of ["origin", "scp", "ssh"]) expect(pushUrl(remote, env)).toBe(APP_PUSH_URL);
    expect(sh(["git", "remote", "get-url", "origin"], env).stdout.toString().trim()).toBe("https://github.com/acme/widgets.git");
    /* Another forge, and another repository on GitHub, keep the URL they had. */
    expect(pushUrl("elsewhere", env)).toBe("https://example.invalid/acme/widgets.git");
    expect(pushUrl("gadgets", env)).toBe(`${at("git", "github.com")}:acme/gadgets.git`);
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

  test("a sibling whose name starts with the declared one is caught by the prefix and answered by the operator's helper", () => {
    reset();
    const url = pushUrl("sibling", env);
    expect(url).toBe(`https://${at("x-access-token", "github.com")}/acme/widgets-site.git`);
    const result = sh(["git", "credential", "fill"], env, `url=${url}\n\n`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(["password", "operator-fixture"].join("="));
    expect(lines(operatorHelperLog)).toEqual(["get"]);
  });

  test.skipIf(engine === "the engine's own writes")("the history guard still refuses to rewrite another author's commit", () => {
    const count = Number(env.GIT_CONFIG_COUNT);
    expect(env[`GIT_CONFIG_KEY_${count - 1}`]).toBe("core.hooksPath");
    expect(env[`GIT_CONFIG_VALUE_${count - 1}`]).toBe(env.LLV_AGENT_GIT_GUARD_DIR);
  });
});

/* The operator's other projects: this checkout is not declared. What its
   GitHub traffic looks like is compared, line for line, with the same commands
   in the environment the launch started from, which is what main gives it. */
describe.skipIf(!posix).each([...ENGINES])("an undeclared repository through %s", (engine: Engine) => {
  const filtered = engine === "codex with a restrictive shell policy";
  const before = (): NodeJS.ProcessEnv => {
    const env = { ...source };
    if (filtered) delete env.GH_CONFIG_DIR;
    return env;
  };

  test("with nothing declared the launch adds no shim, no rewrite and no variable of the App's", () => {
    const env = launched(engine, null);
    expect(Object.keys(env).filter((name) => name.startsWith("LLV_AGENT_FORGE"))).toEqual([]);
    expect(env.PATH).toBe(source.PATH);
    const keys = Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, index) => env[`GIT_CONFIG_KEY_${index}`]);
    expect(keys).toEqual(engine === "the engine's own writes" ? [] : ["core.hooksPath"]);
    expect(sh(["sh", "-c", "command -v gh"], env).stdout.toString().trim()).toBe(path.join(bin, "gh"));
    const expected = transcript(before());
    expect(transcript(env)).toEqual(expected);
    /* The comparison is not vacuous: every command started the stand-in gh,
       and the operator's helper answered the push. */
    expect(expected.started).toEqual(GH_COMMANDS.map((args) => `${args.join(" ")}|config=${filtered ? "" : operatorGh}|token=`));
    expect(expected.urls).toEqual(REMOTES.map(([, url]) => url));
    expect(expected.helper).toEqual(["get"]);
  });

  test("with another repository declared, this one's gh calls and pushes are what they were", () => {
    const env = launched(engine, ["acme/declared-elsewhere"]);
    expect(env.LLV_AGENT_FORGE_REPOSITORIES).toBe("acme/declared-elsewhere");
    expect(transcript(env)).toEqual(transcript(before()));
  });
});

describe.skipIf(!posix)("the declaration", () => {
  test("is a JSON array of owner/name in the state directory, and absent means none", () => {
    declare(null);
    expect(forgeAppRepositories()).toEqual([]);
    expect(agentForgeWriteEnv(source)).toEqual({});
    expect(engineForgeWriteEnv(source)).toEqual({});
    declare(["Acme/Widgets", "acme/gadgets", "Acme/Widgets"]);
    expect(forgeAppRepositories()).toEqual(["Acme/Widgets", "acme/gadgets"]);
    expect(isForgeAppRepository("acme/widgets")).toBe(true);
    expect(isForgeAppRepository("https://github.com/acme/gadgets.git")).toBe(true);
    expect(isForgeAppRepository("acme/widgets-site")).toBe(false);
    /* A remote spelled either way is rewritten. */
    const env = { ...source, ...agentForgeWriteEnv(source) };
    Bun.spawnSync(["git", "remote", "add", "cased", "https://github.com/Acme/Widgets.git"], { cwd: repo, env: source });
    expect(pushUrl("cased", env)).toBe(`https://${at("x-access-token", "github.com")}/Acme/Widgets.git`);
    expect(pushUrl("origin", env)).toBe(APP_PUSH_URL);
    Bun.spawnSync(["git", "remote", "remove", "cased"], { cwd: repo, env: source });
  });

  test.each([["{not json"], ['{"repositories":["acme/widgets"]}'], ['["acme/widgets", 7]'], ['["not a repository"]'], ['["https://example.invalid/acme/widgets"]']])(
    "a file that is not that list (%s) refuses the launch instead of reading as empty", (text) => {
      fs.writeFileSync(declaration, text);
      expect(() => forgeAppRepositories()).toThrow("must be a JSON array of owner/name strings");
      expect(() => agentPublicationIdentityEnv(source)).toThrow("forge-app-repositories.json");
    });
});

test.skipIf(!posix)("an environment launched from a launched environment carries each entry once", () => {
  declare(["acme/widgets"]);
  const first = withAgentConfigSandbox({ ...source }, source);
  const second = withAgentConfigSandbox({ ...first }, first);
  const keys = (env: NodeJS.ProcessEnv) => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => `${env[`GIT_CONFIG_KEY_${index}`]}=${env[`GIT_CONFIG_VALUE_${index}`]}`);
  expect(keys(second)).toEqual(keys(first));
  expect(second.PATH).toBe(first.PATH);
  expect(second.GH_CONFIG_DIR).toBe(operatorGh);
});

test.skipIf(!posix)("the operator's own terminal is untouched: no shim, no rewrite, their helper answers a push", () => {
  declare(["acme/widgets"]);
  withAgentConfigSandbox({ ...source }, source);
  reset();
  expect(sh(["sh", "-c", "command -v gh"], source).stdout.toString().trim()).toBe(path.join(bin, "gh"));
  expect(pushUrl("origin", source)).toBe("https://github.com/acme/widgets.git");
  expect(sh(["git", "credential", "fill"], source, "url=https://github.com/acme/widgets.git\n\n").stdout.toString()).toContain("username=operator");
  expect(sh(["gh", "pr", "merge", "5"], source).exitCode).toBe(0);
  expect(lines(ghLog)).toEqual([`pr merge 5|config=${operatorGh}|token=`]);
  /* Launching agents wrote under the cache directory only. */
  expect(fs.readFileSync(globalConfig, "utf8")).toBe(`[credential]\n\thelper = ${path.join(bin, "operator-helper")}\n`);
  expect(fs.readdirSync(operatorGh)).toEqual([]);
});

test.skipIf(!posix)("no token, key or identifier is written into the launch directory", () => {
  declare(["acme/widgets"]);
  const directory = agentForgeWriteEnv(source).LLV_AGENT_FORGE_DIR!;
  expect(fs.readdirSync(directory).sort()).toEqual(["forge-app-token.mjs", "forge-git-credential", "gh", "gh-config"]);
  expect(fs.readFileSync(path.join(directory, "forge-app-token.mjs"), "utf8")).toBe(fs.readFileSync(path.join(process.cwd(), "bin", "forge-app-token.mjs"), "utf8"));
  expect(fs.readdirSync(path.join(directory, "gh-config"))).toEqual([]);
  expect(fs.statSync(directory).mode & 0o077).toBe(0);
});
