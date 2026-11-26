import { expect, test, afterAll, afterEach, beforeAll } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync, chmodSync, copyFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { withAgentConfigSandbox } from "../src/lib/runtime/agentConfigSandbox";
import { applyClaudeSpawnPolicy } from "../src/lib/agent/spawnPolicy";
import { agentCodexPublicationPolicy } from "../src/lib/git/agentPublicationIdentity";
import { git, MergeBatch, commandRunner, type CommandRunner } from "./merge-batch";
import { batchView, cleanupBatchFixtures, fixture, isolateBatchGateLocks, landingFixture, restartBatch, seedTrustedPrivacyFiles, trustedPrivacyRunner } from "./merge-batch.fixture";

afterEach(cleanupBatchFixtures);
let restoreGateLocks: () => void;
beforeAll(() => { restoreGateLocks = isolateBatchGateLocks(); });
afterAll(() => restoreGateLocks());

/** The scanner's own runtime files: every relative module reachable from its imports and re-exports. */
function privacyScannerRuntimeFiles(entry = "scripts/privacy-publication-gate.ts", seen = new Set<string>()): string[] {
  if (seen.has(entry)) return [...seen];
  seen.add(entry);
  const source = readFileSync(join(import.meta.dir, "..", entry), "utf8");
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    privacyScannerRuntimeFiles(join(dirname(entry), `${match[1]!}.ts`).replaceAll("\\", "/"), seen);
  }
  return [...seen];
}

function seedRealTrustedPrivacyFiles(f: ReturnType<typeof fixture>): void {
  for (const file of [...privacyScannerRuntimeFiles(), "scripts/privacy-known-value-fingerprints.json"]) {
    mkdirSync(dirname(join(f.repo, file)), { recursive: true });
    copyFileSync(join(import.meta.dir, "..", file), join(f.repo, file));
  }
  f.seed("scripts/privacy-publication-gate.ts", readFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "utf8"));
  symlinkSync(join(import.meta.dir, "../node_modules"), join(f.repo, "node_modules"), "dir");
}

function realBodyPrivacyRunner(results: { code: number; output: string }[] = []): CommandRunner {
  return async (cwd, args, env) => {
    if (args[2] === "bun" && args[3] === "scripts/privacy-publication-gate.ts" && args.includes("--paths")) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, join(cwd, args[3]!), ...args.slice(4)],
        cwd,
        env: { ...process.env, ...env },
        stderr: "pipe",
        stdout: "pipe",
      });
      const scan = { code: result.exitCode ?? 1, output: result.stdout.toString() + result.stderr.toString() };
      results.push(scan);
      return scan;
    }
    return { code: 0, output: "" };
  };
}

test("the pinned main privacy scanner rejects an identity before the batch can publish", async () => {
  const personalEmail = ["synthetic-person", "invalid.example"].join("@");
  const trustedDirs: string[] = [];
  const f = landingFixture("green", undefined, (fixture) => {
    seedTrustedPrivacyFiles(fixture);
    return trustedPrivacyRunner(fixture, personalEmail, trustedDirs);
  });
  f.addPr(12, "identity.txt", personalEmail);
  git(f.repo, ["checkout", "topic-12"]);
  writeFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "export const weakened = true;\n");
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Weaken branch scanner"]);
  const head = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "--force", "origin", `${head}:refs/pull/12/head`, `${head}:refs/heads/topic-12`]);
  f.views.get(12)!.headRefOid = head;
  git(f.repo, ["checkout", "main"]);
  const built = await f.batch.build(`12@${head}`);
  const gated = await f.batch.gate();
  const landed = await f.batch.land();

  expect(built.rows[0]!.head).toBe(head);
  expect(gated.rows[0]!.status).toBe("culprit");
  expect(landed.published).toBeNull();
  expect(trustedDirs.length).toBeGreaterThan(0);
  expect(trustedDirs.every((directory) => directory !== built.work)).toBe(true);
  expect(f.calls.some((args) => args[1] === "create")).toBe(false);
  expect(git(f.repo, ["ls-remote", "origin", "refs/heads/merge-batch/" + built.branch.split("/").at(-1)])).toBe("");
});

test("a stale branch privacy scanner cannot block publication after pinned main passes", async () => {
  const trustedDirs: string[] = [];
  const f = landingFixture("green", undefined, (fixture) => {
    seedTrustedPrivacyFiles(fixture);
    return trustedPrivacyRunner(fixture, undefined, trustedDirs);
  });
  f.addPr(12, "a.txt", "healthy change");
  git(f.repo, ["checkout", "topic-12"]);
  writeFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "export const stale = true;\n");
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-m", "Refresh branch scanner"]);
  const movedHead = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "--force", "origin", `${movedHead}:refs/pull/12/head`, `${movedHead}:refs/heads/topic-12`]);
  f.views.get(12)!.headRefOid = movedHead;
  git(f.repo, ["checkout", "main"]);
  mkdirSync(join(f.repo, ".githooks"));
  const hook = join(f.repo, ".githooks/pre-push");
  writeFileSync(hook, "#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n  [ \"$remote_ref\" = refs/heads/main ] && exit 0\ndone\n[ \"${LLV_SKIP_HOOKS:-0}\" = 1 ]\n");
  chmodSync(hook, 0o755);
  git(f.repo, ["config", "core.hooksPath", ".githooks"]);
  await f.batch.build(`12@${movedHead}`);
  await f.batch.gate();
  const landed = await f.batch.land();

  expect(landed.rows[0]!.status).toBe("merged");
  expect(trustedDirs.length).toBe(3);
  expect(trustedDirs.every((directory) => directory !== landed.work)).toBe(true);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  const mergeCall = f.calls.find((args) => args[1] === "merge")!;
  expect(mergeCall[mergeCall.indexOf("--repo") + 1]).toBe("https://github.com/example/fixture");
});

test("the real main scanner publishes a healthy remainder with a stale branch hook", async () => {
  const scans: { code: number; output: string }[] = [];
  const f = landingFixture("attributed", undefined, (fixture) => {
    seedRealTrustedPrivacyFiles(fixture);
    return realBodyPrivacyRunner(scans);
  });
  f.addPr(12, "healthy.txt", "healthy remainder\n");
  git(f.repo, ["checkout", "topic-12"]);
  mkdirSync(join(f.repo, "scripts"), { recursive: true });
  writeFileSync(join(f.repo, "scripts/privacy-publication-gate.ts"), "export const stale = true;\n");
  git(f.repo, ["add", "scripts/privacy-publication-gate.ts"]);
  git(f.repo, ["commit", "--amend", "--no-edit"]);
  const movedHead = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "--force", "origin", `${movedHead}:refs/pull/12/head`, `${movedHead}:refs/heads/topic-12`]);
  f.views.get(12)!.headRefOid = movedHead;
  const rejected = f.addPr(13, "rejected.txt", "rejected change\n");
  mkdirSync(join(f.repo, ".githooks"));
  const hook = join(f.repo, ".githooks/pre-push");
  writeFileSync(hook, "#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n  [ \"$remote_ref\" = refs/heads/main ] && exit 0\ndone\n[ \"${LLV_SKIP_HOOKS:-0}\" = 1 ]\n");
  chmodSync(hook, 0o755);
  git(f.repo, ["config", "core.hooksPath", join(f.repo, ".githooks")]);
  git(f.repo, ["checkout", "main"]);

  const built = await f.batch.build(`12@${movedHead},13@${rejected}`);
  // The shared hook must refuse from the actual batch worktree without the
  // trusted-scanner bypass; a dry run leaves the remote untouched.
  const staleHook = await commandRunner(built.work, ["git", "push", "--dry-run", "origin", `${built.tip}:refs/heads/${built.branch}`],
    { ...process.env, LLV_SKIP_HOOKS: "0" });
  expect(staleHook.code).toBe(1);
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${built.branch}`])).toBe("");
  await f.batch.gate();
  const landed = await f.batch.land();

  expect(landed.rows.map((row) => row.status)).toEqual(["merged", "culprit"]);
  expect(scans).toHaveLength(2);
  for (const scan of scans) {
    expect(scan.code).toBe(0);
    expect(scan.output).toBe("PRIVACY GATE: PASS\n");
  }
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).toContain("scripts");
});

test("the real main scanner blocks a sensitive generated PR body before push", async () => {
  const scans: { code: number; output: string }[] = [];
  const f = landingFixture("green", undefined, (fixture) => {
    seedRealTrustedPrivacyFiles(fixture);
    return realBodyPrivacyRunner(scans);
  });
  const head = f.addPr(12, "healthy.txt", "healthy change\n");
  const sensitiveBody = ["synthetic-person", "invalid.example"].join("@");
  const built = await f.batch.build(`12@${head}`);
  await f.batch.gate();
  // Exercise the publication fence even if persisted metadata is corrupted.
  const state = f.batch.read();
  state.rows[0]!.view.closingIssuesReferences = [{ number: sensitiveBody as unknown as number }];
  f.batch.save(state);

  await expect(f.batch.land()).rejects.toThrow("Batch PR body failed the publication gate");
  expect(scans).toHaveLength(1);
  expect(scans[0]!.code).toBe(1);
  expect(scans[0]!.output).toContain("email_address: 1");
  expect(scans[0]!.output).not.toContain(sensitiveBody);
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${built.branch}`])).toBe("");
  expect(f.calls.some((args) => args[1] === "create")).toBe(false);
});

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

test("forge credentials are checked again immediately before the merge", async () => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "good");
  const gh = async (args: string[]): Promise<string> => {
    const result = await f.batch.gh(args);
    if (args[0] === "pr" && args[1] === "create") f.forge.credential = "personal";
    return result;
  };
  const batch = new MergeBatch(f.repo, f.batch.stateFile, f.batch.run, gh, async () => {});
  await batch.build(`12@${head}`); await batch.gate();
  await expect(batch.land()).rejects.toThrow("verified machine principal");
  expect(f.calls.filter((args) => args[0] === "api" && args[1] === "installation/repositories?per_page=100")).toHaveLength(4);
  expect(f.calls.some((args) => args[1] === "merge")).toBe(false);
  expect(batch.read().mergeIntent).toBeUndefined();
});

test("a personal attribution trailer makes only its PR the culprit", async () => {
  const f = landingFixture();
  const good12 = f.addPr(12, "a.txt", "healthy 12");
  f.addPr(13, "personal.txt", "rejected 13");
  const personalEmail = ["synthetic-person", "invalid.example"].join("@");
  git(f.repo, ["checkout", "topic-13"]);
  git(f.repo, ["commit", "--amend", "-m", `Feature 13\n\nCo-Authored-By: Fixture <${personalEmail}>`]);
  const personalHead = git(f.repo, ["rev-parse", "HEAD"]);
  git(f.repo, ["push", "--force", "origin", `${personalHead}:refs/pull/13/head`, `${personalHead}:refs/heads/topic-13`]);
  f.views.get(13)!.headRefOid = personalHead;
  git(f.repo, ["checkout", "main"]);
  const good14 = f.addPr(14, "c.txt", "healthy 14");

  await f.batch.build(`12@${good12},13@${personalHead},14@${good14}`);
  await f.batch.gate();
  const state = await f.batch.land();

  expect(state.rows.map((row) => row.status)).toEqual(["merged", "culprit", "merged"]);
  expect(f.calls.filter((args) => args[1] === "merge")).toHaveLength(1);
  for (const row of state.rows.filter((entry) => entry.status === "merged")) {
    expect(git(state.work, ["show", "-s", "--format=%B", row.commit])).not.toContain(personalEmail);
  }
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).toContain("a.txt");
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).toContain("c.txt");
  expect(git(f.repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain("personal.txt");
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

test.each(["candidate", "body"])("T5 refreshed %s privacy refusal prevents the next push and PR edit", async refused => {
  const f = landingFixture();
  const head = f.addPr(12, "a.txt", "healthy");
  await f.batch.build(`12@${head}`); await f.batch.gate();
  let moved = false, checked = 0;
  const gh = async (args: string[]) => {
    if (!moved && args[0] === "pr" && args[1] === "view" && args[2] === "99") {
      moved = true; f.seed("advance.txt", "main moved");
      return batchView(f, "SUCCESS", "BEHIND");
    }
    return f.batch.gh(args);
  };
  const run: CommandRunner = async (cwd, args, env) => {
    if (moved && args[3] === "scripts/privacy-publication-gate.ts") {
      checked++;
      if (args.includes(refused === "body" ? "--paths" : "--check-commits")) return { code: 1, output: "privacy refused" };
    }
    return f.batch.run(cwd, args, env);
  };
  await expect(restartBatch(f, gh, run).land()).rejects.toThrow("publication gate");
  const state = f.batch.read();
  expect(checked).toBe(refused === "body" ? 2 : 1);
  expect(state.gated!.carried).toHaveLength(1);
  expect(state.published).not.toBe(state.tip);
  expect(git(f.repo, ["ls-remote", "origin", `refs/heads/${state.branch}`]).split(/\s/)[0]).toBe(state.published!);
  expect(f.calls.filter(args => args[1] === "edit" || args[1] === "merge")).toEqual([]);
});
