import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { controllerCommitIdentityEnv } from "@/lib/git/controllerCommitIdentity";
import { applyClaudeSpawnPolicy } from "@/lib/agent/spawnPolicy";
import { withAgentConfigSandbox } from "./agentConfigSandbox";

test("publication settings override inherited Git identities before environment filtering", () => {
  const email = ["no-reply", "build.example.invalid"].join("@");
  for (const prefix of ["DELEGATUS", "LLV"]) {
    const source: NodeJS.ProcessEnv = {
      NODE_ENV: "test", TMPDIR: os.tmpdir(),
      LLV_PUBLICATION_NAME: "Legacy Agent",
      LLV_PUBLICATION_EMAIL: ["noreply", "legacy.example.invalid"].join("@"),
      [`${prefix}_PUBLICATION_NAME`]: "Build Agent",
      [`${prefix}_PUBLICATION_EMAIL`]: email,
    };
    const env = withAgentConfigSandbox({
      NODE_ENV: "test",
      GIT_AUTHOR_NAME: "Inherited", GIT_COMMITTER_NAME: "Inherited",
      GIT_AUTHOR_EMAIL: ["author", "example.invalid"].join("@"),
      GIT_COMMITTER_EMAIL: ["committer", "example.invalid"].join("@"),
    }, source);
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: "Build Agent", GIT_COMMITTER_NAME: "Build Agent",
      GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
    });
    expect(source[`${prefix}_PUBLICATION_NAME`]).toBe("Build Agent");
  }
});

test.each([
  { LLV_PUBLICATION_EMAIL: ["personal", "example.invalid"].join("@") },
  { LLV_PUBLICATION_EMAIL: ["noreply", "github.com"].join("@") },
  { LLV_PUBLICATION_EMAIL: "" },
  { LLV_PUBLICATION_NAME: "Agent\nInjected" },
])("unsafe publication settings refuse the launch without exposing their values", (setting) => {
  expect(() => withAgentConfigSandbox({ NODE_ENV: "test" }, { NODE_ENV: "test", ...setting })).toThrow("Invalid agent publication identity");
});

test.each([
  ["claude", false], ["codex", false], ["claude", true], ["codex", true],
] as const)("%s agent commits override personal Git config and pass publication (configured: %s)", (engine, configured) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-publication-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const source: NodeJS.ProcessEnv = {
      NODE_ENV: "test", PATH: process.env.PATH, HOME: root, TMPDIR: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "absent-config"),
      ...(configured ? {
        LLV_PUBLICATION_NAME: "Build Agent",
        LLV_PUBLICATION_EMAIL: ["no-reply", "build.example.invalid"].join("@"),
      } : {}),
    };
    const run = (args: string[], env = source) => {
      const result = Bun.spawnSync(args, { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    run(["git", "init", "-q"]);
    run(["git", "config", "user.name", "Configured Fixture"]);
    const personal = ["configured", "example.invalid"].join("@");
    run(["git", "config", "user.email", personal]);
    run(["git", "commit", "--allow-empty", "-m", "base"], { ...source, ...controllerCommitIdentityEnv() });
    const base = run(["git", "rev-parse", "HEAD"]);
    const before = run(["git", "config", "--local", "--list"]);
    const accountHome = path.join(root, engine);
    const env = withAgentConfigSandbox({ ...source }, source, accountHome);
    if (engine === "claude") {
      fs.mkdirSync(accountHome, { recursive: true });
      const settingsPath = path.join(accountHome, "settings.json");
      const original = JSON.stringify({ env: {
        GIT_AUTHOR_NAME: "Inherited", GIT_AUTHOR_EMAIL: personal,
        GIT_COMMITTER_NAME: "Inherited", GIT_COMMITTER_EMAIL: personal,
      } });
      fs.writeFileSync(settingsPath, original);
      const policy = applyClaudeSpawnPolicy(accountHome, { publicationEnv: source });
      Object.assign(env, JSON.parse(original).env, JSON.parse(fs.readFileSync(policy.settingsPath, "utf8")).env);
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    }
    run(["git", "commit", "--allow-empty", "-m", "agent work\n\nCo-Authored-By: Tool <" + ["noreply", "example.invalid"].join("@") + ">"], env);
    const identity = configured ? {
      GIT_AUTHOR_NAME: "Build Agent", GIT_COMMITTER_NAME: "Build Agent",
      GIT_AUTHOR_EMAIL: source.LLV_PUBLICATION_EMAIL, GIT_COMMITTER_EMAIL: source.LLV_PUBLICATION_EMAIL,
    } : controllerCommitIdentityEnv();
    expect(run(["git", "log", "-1", "--format=%an%n%ae%n%cn%n%ce"])).toBe(
      [identity.GIT_AUTHOR_NAME, identity.GIT_AUTHOR_EMAIL, identity.GIT_COMMITTER_NAME, identity.GIT_COMMITTER_EMAIL].join("\n"),
    );
    expect(run(["git", "config", "--local", "--list"])).toBe(before);
    expect(run([process.execPath, path.resolve("scripts/privacy-publication-gate.ts"),
      "--repository", repo, "--base", base, "--check-commits"], env)).toContain("PRIVACY GATE: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
