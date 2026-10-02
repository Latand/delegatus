import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexShellPolicy } from "./codexShellPolicy";
import { agentCodexPublicationArgs, agentPublicationIdentityEnv } from "./agentPublicationIdentity";

test("native policy bridge issues only initialize and config/read and keeps diagnostics private", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-bridge-"));
  try {
    const binary = path.join(root, "fixture-codex");
    const methods = path.join(root, "methods.jsonl");
    fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nimport { createInterface } from 'node:readline';\nfor await (const line of createInterface({ input: process.stdin })) {\nconst request = JSON.parse(line); fs.appendFileSync(process.env.POLICY_METHODS, request.method+'\\n');\nif (!request.id) continue;\nconsole.log(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : { config: { shell_environment_policy: { inherit: 'core', include_only: ['PATH'], set: { OTHER: 'kept' } } } } }));\n}\n`, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: root, POLICY_METHODS: methods };
    expect(await readCodexShellPolicy(binary, root, env)).toEqual({ inherit: "core", include_only: ["PATH"], set: { OTHER: "kept" } });
    expect(fs.readFileSync(methods, "utf8").trim().split("\n")).toEqual(["initialize", "initialized", "config/read"]);
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "private diagnostic" >&2\nexit 1\n', { mode: 0o700 });
    await expect(readCodexShellPolicy(binary, root, env)).rejects.toThrow("Codex shell policy could not be read safely");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const nativeBinary = process.env.LLV_PUBLICATION_CODEX_TEST_BINARY;
test("a delayed native policy probe leaves the launcher's event loop responsive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-responsive-"));
  try {
    const binary = path.join(root, "fixture-codex");
    fs.writeFileSync(binary, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nfor await (const line of createInterface({ input: process.stdin })) {\nconst request = JSON.parse(line); if (!request.id) continue;\nif (request.method === 'initialize') await new Promise(resolve => setTimeout(resolve, 200));\nconsole.log(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : { config: {} } }));\n}\n`, { mode: 0o700 });
    const start = performance.now();
    const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - start), 20));
    const probe = Promise.resolve(readCodexShellPolicy(binary, root, { PATH: process.env.PATH, HOME: root, NODE_ENV: "test" }));
    const elapsed = await timer;
    await probe;
    expect(elapsed).toBeLessThan(150);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test.skipIf(!nativeBinary).each([false, true])("native Codex config overrides produce safe shell commits (keyed filters: %s)", async (keyedFilters) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-publication-native-"));
  try {
    const repo = path.join(root, "repo");
    const home = path.join(root, "codex");
    fs.mkdirSync(repo); fs.mkdirSync(home);
    const personal = ["configured", "example.invalid"].join("@");
    const original = '[shell_environment_policy]\ninherit="core"\n' + (keyedFilters
      ? '[shell_environment_policy.filters]\nPATH="include"\nHOME="include"\n"PRIVATE_*"="exclude"\n'
      : 'include_only=["PATH","HOME"]\nexclude=["PRIVATE_*"]\n')
      + '[shell_environment_policy.set]\nGIT_AUTHOR_EMAIL=' + JSON.stringify(personal)
      + '\nGIT_COMMITTER_EMAIL=' + JSON.stringify(personal) + '\nOTHER="kept"\n';
    const configPath = path.join(home, "config.toml");
    fs.writeFileSync(configPath, original);
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test", PATH: process.env.PATH, HOME: root, CODEX_HOME: home, TMPDIR: root,
      LLV_STATE_DIR: path.join(root, "state"), GIT_CONFIG_NOSYSTEM: "1",
      LLV_PUBLICATION_NAME: "Build Agent", LLV_PUBLICATION_EMAIL: ["no-reply", "build.example.invalid"].join("@"),
    };
    const raw = await readCodexShellPolicy(nativeBinary!, repo, env);
    const ignored = await readCodexShellPolicy(nativeBinary!, repo, env, [], { ignoreUserConfig: true }) as { set?: Record<string, string> };
    expect(ignored.set ?? {}).not.toHaveProperty("OTHER");
    const effective = await readCodexShellPolicy(nativeBinary!, repo, env, agentCodexPublicationArgs(raw, env)) as {
      set: Record<string, string>; include_only?: string[]; exclude?: string[]; filters?: Record<string, string>;
    };
    expect(effective.set).toMatchObject({ ...agentPublicationIdentityEnv(env), OTHER: "kept" });
    expect(keyedFilters ? effective.filters?.["private_*"] : effective.exclude).toEqual(keyedFilters ? "exclude" : ["PRIVATE_*"]);
    // Exercise Git after Codex's native config merge and its final inclusion
    // filter: `core` inherits PATH/HOME, then `set`, then include-only.
    const shellEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: env.PATH, HOME: env.HOME, ...effective.set };
    const included = effective.include_only ?? Object.entries(effective.filters ?? {}).filter(([, action]) => action === "include").map(([pattern]) => pattern);
    for (const key of Object.keys(shellEnv)) if (!included.some((pattern) => pattern.toLowerCase() === key.toLowerCase())) delete shellEnv[key];
    const run = (args: string[], childEnv = env) => {
      const result = Bun.spawnSync(args, { cwd: repo, env: childEnv, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    run(["git", "init", "-q"]);
    run(["git", "config", "user.name", "Configured Fixture"]);
    run(["git", "config", "user.email", personal]);
    run(["git", "commit", "--allow-empty", "-m", "base"], { ...env, ...agentPublicationIdentityEnv(env) });
    const base = run(["git", "rev-parse", "HEAD"]);
    run(["git", "commit", "--allow-empty", "-m", "agent work"], shellEnv);
    expect(run(["git", "log", "-1", "--format=%an%n%ae%n%cn%n%ce"])).toBe(Object.values(agentPublicationIdentityEnv(env)).join("\n"));
    expect(run([process.execPath, path.resolve("scripts/privacy-publication-gate.ts"), "--repository", repo, "--base", base, "--check-commits"])).toContain("PRIVACY GATE: PASS");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(run(["git", "config", "user.email"])).toBe(personal);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
