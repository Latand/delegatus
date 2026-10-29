import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { controllerCommitIdentityEnv } from "./controllerCommitIdentity";
import { DELEGATUS_COAUTHOR, REPOSITORY_IDENTITY, repositoryCommitIdentity, repositoryPublicationSource } from "./repositoryCommitIdentity";
import { agentCodexPublicationPolicy, agentPublicationIdentityEnv } from "./agentPublicationIdentity";
import { withAgentConfigSandbox } from "@/lib/runtime/agentConfigSandbox";
import { prepareAgentPublicationSpec, shellQuote, withSpawnCapability } from "@/lib/agent/cli";
import { prepareHeadlessPublication } from "@/lib/agent/headless";
import { applyClaudeSpawnPolicy } from "@/lib/agent/spawnPolicy";

async function fixture(repositoryName = "renamed-project") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-identity-"));
  const repo = path.join(root, repositoryName); fs.mkdirSync(repo);
  const source: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith("GIT_")).map(k => [k, undefined])), PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "xdg"),
    TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "global"),
    NODE_ENV: "test", ...controllerCommitIdentityEnv() };
  const run = async (args: string[], env: NodeJS.ProcessEnv = source, cwd = repo) => {
    const r = await realExec("git", args, cwd, { ...process.env, ...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith("GIT_")).map(k => [k, undefined])), ...env });
    expect(r.code, r.stderr).toBe(0); return r.stdout.trim();
  };
  await run(["init", "-q", "-b", "main"]);
  return { root, repo, source, run, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const email = ["fixture", "example.invalid"].join("@");

test.each(["local", "global", "included", "worktree"] as const)("repository identity reads %s user config, ignoring inherited and role identities", async kind => {
  const f = await fixture();
  try {
    const scope = kind === "global" ? "--global" : "--local";
    await f.run(["config", scope, "user.name", "Repository Fixture"]);
    await f.run(["config", scope, "user.email", email]);
    if (kind === "included") {
      await f.run(["config", "--unset", "user.name"]); await f.run(["config", "--unset", "user.email"]);
      const included = path.join(f.root, "included");
      fs.writeFileSync(included, `[user]\nname = Repository Fixture\nemail = ${email}\n`);
      await f.run(["config", "--global", "include.path", included]);
    }
    await f.run(["config", "author.name", "Role Fixture"]);
    await f.run(["config", "committer.email", ["other", "example.invalid"].join("@")]);
    let cwd = f.repo;
    if (kind === "worktree") {
      await f.run(["commit", "--allow-empty", "-qm", "base"]);
      cwd = path.join(f.root, "lane");
      await f.run(["worktree", "add", "-qb", "lane", cwd]);
      await f.run(["config", "extensions.worktreeConfig", "true"]);
      await f.run(["config", "user.name", "Shared Fixture"]);
      await f.run(["config", "--worktree", "user.name", "Repository Fixture"], f.source, cwd);
    }
    const before = await f.run(["config", "--local", "--list"]);
    const readSource = { ...f.source, GIT_DIR: path.join(f.root, "unrelated-git"), GIT_WORK_TREE: path.join(f.root, "unrelated-tree"),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Injected Fixture" };
    const identity = await repositoryCommitIdentity(cwd, realExec, readSource);
    expect(identity).toEqual({ env: { GIT_AUTHOR_NAME: "Repository Fixture", GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: "Repository Fixture", GIT_COMMITTER_EMAIL: email }, coauthor: DELEGATUS_COAUTHOR });
    expect(await f.run(["config", "--local", "--list"])).toBe(before);
  } finally { f.close(); }
});

test.each(["absent", "partial"])("repository identity keeps the machine fallback for %s user config", async kind => {
  const f = await fixture();
  try {
    if (kind === "partial") await f.run(["config", "user.name", "Repository Fixture"]);
    expect(await repositoryCommitIdentity(f.repo, realExec, f.source)).toEqual({ env: controllerCommitIdentityEnv(), coauthor: DELEGATUS_COAUTHOR });
  } finally { f.close(); }
});

test.each(["renamed-project", "renamed-project "])("checked-in privacy configuration preserves machine policy in %s", async repositoryName => {
  const f = await fixture(repositoryName);
  try {
    await f.run(["config", "user.name", "Repository Fixture"]); await f.run(["config", "user.email", email]);
    fs.writeFileSync(path.join(f.repo, "package.json"), JSON.stringify({ scripts: { "privacy:check": "bun scripts/privacy-publication-gate.ts" } }));
    fs.mkdirSync(path.join(f.repo, "scripts")); fs.writeFileSync(path.join(f.repo, "scripts/privacy-known-value-fingerprints.json"), "{}");
    const user = await repositoryPublicationSource(f.repo, f.source);
    // A retained launch binding from another repository cannot choose policy.
    user[REPOSITORY_IDENTITY] = JSON.stringify({ env: { GIT_AUTHOR_NAME: "Unrelated Fixture", GIT_AUTHOR_EMAIL: email }, coauthor: DELEGATUS_COAUTHOR });
    const source = await repositoryPublicationSource(f.repo, user);
    expect(source[REPOSITORY_IDENTITY]).toBeUndefined();
    expect(await repositoryCommitIdentity(f.repo, realExec, f.source)).toEqual({ env: controllerCommitIdentityEnv() });
    const env = agentPublicationIdentityEnv(source);
    expect(env.GIT_AUTHOR_NAME).toBe("Delegatus");
    await f.run(["commit", "--allow-empty", "-qm", "policy preserved"], { ...f.source, ...env });
    expect(await f.run(["log", "-1", "--format=%an%n%ae"])).toBe("Delegatus\n" + controllerCommitIdentityEnv().GIT_AUTHOR_EMAIL);
    expect(await f.run(["log", "-1", "--format=%B"])).not.toContain(DELEGATUS_COAUTHOR);
  } finally { f.close(); }
});

test.each(["claude", "codex"] as const)("%s settings and sandbox keep repository authorship and add one coauthor through real hooks", async engine => {
  const f = await fixture();
  try {
    await f.run(["config", "user.name", "Repository Fixture"]); await f.run(["config", "user.email", email]);
    const before = await f.run(["config", "--local", "--list"]);
    const source = await repositoryPublicationSource(f.repo, f.source);
    const env = withAgentConfigSandbox({ ...f.source }, source);
    if (engine === "codex") Object.assign(env, agentCodexPublicationPolicy({ include_only: ["PATH", "HOME"] }, source).set);
    else {
      const policy = applyClaudeSpawnPolicy(f.root, { cwd: f.repo, publicationEnv: source });
      Object.assign(env, JSON.parse(fs.readFileSync(policy.settingsPath, "utf8")).env);
    }
    await f.run(["commit", "--allow-empty", "-qm", "user work"], env);
    await f.run(["commit", "--amend", "--allow-empty", "--no-edit"], env);
    expect(await f.run(["log", "-1", "--format=%an%n%ae%n%cn%n%ce"])).toBe(["Repository Fixture", email, "Repository Fixture", email].join("\n"));
    expect((await f.run(["log", "-1", "--format=%B"])).split(DELEGATUS_COAUTHOR)).toHaveLength(2);
    expect(await f.run(["config", "--local", "--list"])).toBe(before);
  } finally { f.close(); }
});

test("identity read errors and hostile multiline values refuse without exposing values", async () => {
  const f = await fixture();
  try {
    await expect(repositoryCommitIdentity(f.repo, async () => ({ code: 128, stdout: "", stderr: "private diagnostic" }), f.source)).rejects.toThrow("values withheld");
    await f.run(["config", "user.name", "Fixture\nspoofed trailer"]); await f.run(["config", "user.email", email]);
    await expect(repositoryCommitIdentity(f.repo, realExec, f.source)).rejects.toThrow("Invalid repository Git identity (values withheld)");
    fs.writeFileSync(path.join(f.repo, "package.json"), "{broken");
    await expect(repositoryCommitIdentity(f.repo, realExec, f.source)).rejects.toThrow("publication configuration could not be read");
  } finally { f.close(); }
});

test.each([["malformed", "malformed private value"], ["null", "null"], ["forged", JSON.stringify({ env: {}, coauthor: "forged trailer" })]])("invalid retained %s identity binding refuses without logging its contents", (_shape, value) => {
  expect(() => agentPublicationIdentityEnv({ [REPOSITORY_IDENTITY]: value })).toThrow("Invalid repository Git identity (values withheld)");
});


test("terminal publication preserves literal identity text through shell and inline engine settings", async () => {
  const f = await fixture();
  try {
    const name = "Fixture '$& $(touch unexpected)";
    await f.run(["config", "user.name", name]); await f.run(["config", "user.email", email]);
    const script = path.join(f.root, "engine.mjs");
    fs.writeFileSync(script, `import { spawnSync } from "node:child_process";
const settings = JSON.parse(process.argv[3]);
const r = spawnSync("git", ["commit", "--allow-empty", "-qm", "terminal work"], { env: { ...process.env, ...settings.env }, stdio: "inherit" });
process.exit(r.status ?? 1);
`);
    const settings = { env: agentPublicationIdentityEnv(f.source), permissions: { deny: ["Edit"] } };
    const spec = await prepareAgentPublicationSpec({ engine: "claude", cwd: f.repo, windowName: "fixture",
      command: `${shellQuote(process.execPath)} ${shellQuote(script)} --settings ${shellQuote(JSON.stringify(settings))}`,
      publicationSettings: settings });
    const boot = withSpawnCapability(spec, "a".repeat(43));
    const result = await realExec("sh", ["-c", boot.command], f.repo, f.source);
    expect(result.code, result.stderr).toBe(0);
    expect(await f.run(["log", "-1", "--format=%an%n%ae"])).toBe(name + "\n" + email);
    expect(await f.run(["log", "-1", "--format=%B"])).toContain(DELEGATUS_COAUTHOR);
    expect(fs.existsSync(path.join(f.repo, "unexpected"))).toBe(false);
  } finally { f.close(); }
});

test("headless publication rebinds identity without losing existing engine restrictions", async () => {
  const f = await fixture();
  try {
    await f.run(["config", "user.name", "Repository Fixture"]); await f.run(["config", "user.email", email]);
    const prepared = await prepareHeadlessPublication({ command: "claude", args: ["--settings", JSON.stringify({ env: {}, permissions: { deny: ["Edit"] }, autoMemoryEnabled: false })],
      env: f.source, stdin: null, outputPath: null, sessionId: null, reviewerPath: null }, f.repo);
    expect(prepared.env.GIT_AUTHOR_NAME).toBe("Repository Fixture");
    const settings = JSON.parse(prepared.args[1]);
    expect(settings.permissions).toEqual({ deny: ["Edit"] }); expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.env.GIT_AUTHOR_EMAIL).toBe(email);
    fs.mkdirSync(path.join(f.repo, "scripts")); fs.writeFileSync(path.join(f.repo, "scripts/privacy-known-value-fingerprints.json"), "{}");
    fs.writeFileSync(path.join(f.repo, "package.json"), JSON.stringify({ scripts: { "privacy:check": "bun scripts/privacy-publication-gate.ts" } }));
    const rebound = await prepareHeadlessPublication(prepared, f.repo);
    expect(rebound.env.GIT_AUTHOR_NAME).toBe("Delegatus");
    expect(rebound.env[REPOSITORY_IDENTITY]).toBeUndefined();
    expect(JSON.parse(rebound.args[1]).env[REPOSITORY_IDENTITY]).toBeUndefined();
  } finally { f.close(); }
});
