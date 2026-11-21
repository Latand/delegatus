import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withAgentConfigSandbox } from "../src/lib/runtime/agentConfigSandbox";
import { applyClaudeSpawnPolicy } from "../src/lib/agent/spawnPolicy";
import { agentCodexPublicationPolicy } from "../src/lib/git/agentPublicationIdentity";
import { git } from "./merge-batch";
import { MergeBatch, landingFixture, registerMergeBatchFixtures } from "./merge-batch.fixture";

registerMergeBatchFixtures();

test.each([
  ["claude", false], ["codex", false], ["claude", true], ["codex", true],
] as const)("%s merger verifies forge identity in a launched environment (worktree: %s)", async (engine, worktree) => {
  const f = landingFixture();
  const trailer = "Co-Authored-By: Tool <" + ["noreply", "example.invalid"].join("@") + ">";
  f.addPr(12, "a.txt", "good");
  git(f.repo, ["checkout", "topic-12"]);
  git(f.repo, ["commit", "--allow-empty", "-m", `Machine attribution\n\n${trailer}`]);
  const head = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "origin", `${head}:refs/pull/12/head`, `${head}:refs/heads/topic-12`]);
  f.views.get(12)!.headRefOid = head;
  git(f.repo, ["checkout", "main"]);
  let repo = f.repo;
  if (worktree) {
    repo = join(f.root, "linked");
    git(f.repo, ["worktree", "add", "-b", "merger", repo]);
  }
  const source: NodeJS.ProcessEnv = { ...process.env, HOME: f.root, TMPDIR: f.root, NODE_ENV: "test" };
  const env = withAgentConfigSandbox({ ...source }, source);
  if (engine === "claude") {
    const home = join(f.root, "claude");
    mkdirSync(home);
    const policy = applyClaudeSpawnPolicy(home, { publicationEnv: source });
    Object.assign(env, JSON.parse(readFileSync(policy.settingsPath, "utf8")).env);
  } else Object.assign(env, agentCodexPublicationPolicy({ include_only: ["PATH", "HOME"] }, source).set);
  const prior = { ...process.env };
  try {
    Object.assign(process.env, env);
    const batch = new MergeBatch(repo, f.batch.stateFile, f.batch.run, f.batch.gh, async () => {});
    const built = await batch.build(`12@${head}`);
    await batch.gate();
    // A private/no-reply address on a User still represents a person.
    f.forge.credential = "personal";
    f.forge.committerName = "Fixture Principal";
    f.forge.committerEmail = ["noreply", "fixture.example.invalid"].join("@");
    await expect(batch.land()).rejects.toThrow("verified machine principal");
    expect(f.calls.some((args) => args[1] === "merge" || args[1] === "create")).toBe(false);
    expect(git(f.repo, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0]).toBe(built.base);
    expect(batch.read().mergeIntent).toBeUndefined();
    // The identical gated batch can land after machine credentials are available.
    f.forge.credential = "installation";
    f.forge.committerName = "Forge Automation";
    f.forge.committerEmail = ["noreply", "forge.example.invalid"].join("@");
    const landed = await batch.land();
    const commit = landed.rows[0]!.commit;
    expect(git(f.repo, ["show", "-s", "--format=%an%n%ae%n%cn%n%ce", commit]))
      .toBe([env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL, f.forge.committerName, f.forge.committerEmail].join("\n"));
    expect(git(f.repo, ["show", "-s", "--format=%B", commit])).toContain(trailer);
    expect(f.commands.some((args) => args.includes("--check-commits"))).toBe(true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
}, 20_000);

test.each(["", "null", "{}", "other/fixture", "example/fixture-other", "other/example/fixture",
  "example/fixture\nother/fixture",
])("installation must prove access to the exact target before any batch publication: %j", async (response) => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  f.forge.installationResponse = response;
  await expect(f.batch.land()).rejects.toThrow("verified machine principal");
  expect(f.calls.some((args) => args[1] === "merge" || args[1] === "create")).toBe(false);
  expect(f.batch.read().published).toBeNull();
});

test.each(["personal", "app-user"] as const)("%s credentials cannot prove an installation principal", async (credential) => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  f.forge.credential = credential;
  await expect(f.batch.land()).rejects.toThrow("verified machine principal");
  expect(f.calls.some((args) => args[1] === "merge" || args[1] === "create")).toBe(false);
});

test.each([undefined, "other/fixture"])("an undeclared merger explains how to enable App routing before publication: %j", async (declared) => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  const batch = new MergeBatch(f.repo, f.batch.stateFile, async (cwd, args, env) => {
    if (args[0] !== "gh") return f.batch.run(cwd, args, env);
    if (args[1] === "api" && args[2] === "installation/repositories?per_page=100") {
      return { code: 1, output: "HTTP 403: private credential diagnostic" };
    }
    return { code: 0, output: await f.batch.gh(args.slice(1)) };
  }, undefined, async () => {});
  const previous = process.env.LLV_AGENT_FORGE_REPOSITORIES;
  if (declared === undefined) delete process.env.LLV_AGENT_FORGE_REPOSITORIES;
  else process.env.LLV_AGENT_FORGE_REPOSITORIES = declared;
  try {
    const built = await batch.build(`12@${head}`); await batch.gate();
    const refusal = await batch.land().catch(error => error as Error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("forge-app-repositories.json");
    expect((refusal as Error).message).toContain("running Delegatus state directory");
    expect((refusal as Error).message).toContain("JSON array of owner/name strings");
    expect((refusal as Error).message).toContain("launch a new merger");
    expect((refusal as Error).message).not.toMatch(/403|private credential diagnostic/);
    expect(f.calls.some(args => args[1] === "create" || args[1] === "merge")).toBeFalse();
    expect(batch.read().published).toBeNull();
    expect(batch.read().mergeIntent).toBeUndefined();
    expect(git(f.repo, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0]).toBe(built.base);
  } finally {
    if (previous === undefined) delete process.env.LLV_AGENT_FORGE_REPOSITORIES;
    else process.env.LLV_AGENT_FORGE_REPOSITORIES = previous;
  }
});

test("unreadable forge credentials refuse landing without disclosing diagnostics", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  f.forge.unavailable = true;
  await expect(f.batch.land()).rejects.toThrow("personal or unverified credentials refused");
  expect(f.calls.some((args) => args[1] === "merge" || args[1] === "create")).toBe(false);
});

test("a declared merger points to the App credential and installation when verification fails", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  const previous = process.env.LLV_AGENT_FORGE_REPOSITORIES;
  process.env.LLV_AGENT_FORGE_REPOSITORIES = "other/fixture,EXAMPLE/fixture";
  try {
    await f.batch.build(`12@${head}`); await f.batch.gate();
    f.forge.unavailable = true;
    const refusal = await f.batch.land().catch(error => error as Error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("encrypted App credential and repository installation");
    expect((refusal as Error).message).toContain("launch a new merger");
    expect((refusal as Error).message).not.toMatch(/add the repository|private credential diagnostic/);
    expect(f.calls.some(args => args[1] === "create" || args[1] === "merge")).toBeFalse();
    expect(f.batch.read().published).toBeNull();
    expect(f.batch.read().mergeIntent).toBeUndefined();
    f.forge.unavailable = false;
    const landed = await f.batch.land();
    expect(landed.rows[0]!.status).toBe("merged");
  } finally {
    if (previous === undefined) delete process.env.LLV_AGENT_FORGE_REPOSITORIES;
    else process.env.LLV_AGENT_FORGE_REPOSITORIES = previous;
  }
});

test("a real hosted fingerprint file notice drops its PR and lands the healthy remainder", async () => {
  const f = landingFixture("privacy-file");
  const value = "hosted-fingerprint-fixture-value";
  const badPath = `attack\nfile: a.txt:1 known_value\nprobe-${value}.txt`;
  const good = f.addPr(12, "a.txt", "healthy change");
  const bad = f.addPr(13, badPath, value);
  await f.batch.build(`12@${good},13@${bad}`);
  await f.batch.gate();
  const state = await f.batch.land();
  expect(state.rows.map((row) => row.status)).toEqual(["merged", "culprit"]);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain(badPath);
});
