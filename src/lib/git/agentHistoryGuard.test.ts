import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentPublicationIdentityEnv } from "./agentPublicationIdentity";
import { controllerCommitIdentityEnv } from "./controllerCommitIdentity";
import { withAgentConfigSandbox } from "@/lib/runtime/agentConfigSandbox";

test("hooks stay in the shared home across a container-to-host launch and sandbox reapplication", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-shared-home-"));
  try {
    const sharedHome = path.join(root, "shared-home");
    const containerTemp = path.join(root, "container-only-temp");
    fs.mkdirSync(sharedHome);
    fs.mkdirSync(containerTemp);
    const source = { HOME: sharedHome, TMPDIR: containerTemp, NODE_ENV: "test" };
    const env = withAgentConfigSandbox({ ...source }, source);
    const hooks = env.GIT_CONFIG_VALUE_0!;
    expect(hooks.startsWith(sharedHome + path.sep)).toBe(true);
    expect(fs.statSync(path.join(hooks, "reference-transaction")).isFile()).toBe(true);
    const reapplied = agentPublicationIdentityEnv(env);
    expect(reapplied.GIT_CONFIG_COUNT).toBe("1");
    expect(reapplied.GIT_CONFIG_VALUE_0).toBe(hooks);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-guard-test-"));
  const source = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "absent") };
  const machine = { ...source, ...controllerCommitIdentityEnv() };
  const env = { ...source, ...agentPublicationIdentityEnv(source) };
  const run = (args: string[], child = env) => Bun.spawnSync(["git", ...args], { cwd: root, env: child, stdout: "pipe", stderr: "pipe" });
  const ok = (args: string[], child = env) => {
    const result = run(args, child);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  ok(["init", "-q", "-b", "main"]);
  ok(["commit", "--allow-empty", "-m", "base"]);
  return { root, source, machine, env, run, ok, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test.each(["default", "relative", "absolute", "environment"])("forwards %s repository hooks, including transaction input and rejection", (kind) => {
  const f = fixture();
  try {
    const hooks = kind === "default" ? ".git/hooks" : "custom-hooks";
    fs.mkdirSync(path.join(f.root, hooks), { recursive: true });
    if (kind === "environment") Object.assign(f.env, agentPublicationIdentityEnv({ ...f.source,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks }));
    else if (kind !== "default") f.ok(["config", "core.hooksPath", kind === "absolute" ? path.join(f.root, hooks) : hooks]);
    const originalConfig = f.ok(["config", "--local", "--list"], f.source);
    const write = (name: string, body: string) => fs.writeFileSync(path.join(f.root, hooks, name), "#!/bin/sh\n" + body, { mode: 0o700 });
    write("reference-transaction", 'printf "%s\\n" "$1" >> hook-events\ncat >> hook-events\n');
    write("commit-msg", 'printf "%s\\n" "Co-Authored-By: Tool <' + ["noreply", "example.invalid"].join("@") + '>" >> "$1"\n');
    f.ok(["commit", "--allow-empty", "-m", "new work"]);
    expect(fs.readFileSync(path.join(f.root, "hook-events"), "utf8")).toContain("prepared\n");
    expect(fs.readFileSync(path.join(f.root, "hook-events"), "utf8")).toContain("refs/heads/main");
    expect(f.ok(["log", "-1", "--format=%B"])).toContain("Co-Authored-By: Tool");
    const before = f.ok(["rev-parse", "HEAD"]);
    write("pre-commit", 'echo "repository hook refusal" >&2\nexit 7\n');
    const rejected = f.run(["commit", "--allow-empty", "-m", "refused"]);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain("repository hook refusal");
    expect(f.ok(["rev-parse", "HEAD"])).toBe(before);
    expect(f.ok(["config", "--local", "--list"], f.source)).toBe(originalConfig);
    const reapplied = agentPublicationIdentityEnv(f.env);
    expect(reapplied.GIT_CONFIG_COUNT).toBe(f.env.GIT_CONFIG_COUNT);
    expect(reapplied.LLV_AGENT_GIT_GUARD_DIR).toBe(f.env.LLV_AGENT_GIT_GUARD_DIR);
  } finally { f.close(); }
});

test("machine merges and rebases succeed while foreign history rewrites are refused", () => {
  const f = fixture();
  try {
    f.ok(["checkout", "-q", "-b", "topic"]);
    f.ok(["commit", "--allow-empty", "-m", "topic"]);
    f.ok(["checkout", "-q", "main"]);
    f.ok(["commit", "--allow-empty", "-m", "main"]);
    f.ok(["merge", "--no-ff", "topic", "-m", "merge"]);
    expect(f.ok(["log", "-1", "--format=%an%n%ae%n%cn%n%ce"])).toBe(Object.values(controllerCommitIdentityEnv()).join("\n"));
    f.ok(["checkout", "-q", "topic"]);
    f.ok(["rebase", "main"]);
    f.ok(["commit", "--allow-empty", "-m", "foreign"], { ...f.machine,
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: ["fixture", "example.invalid"].join("@") });
    const foreign = f.ok(["rev-parse", "HEAD"]);
    const refused = f.run(["rebase", "--force-rebase", "main"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain("add a new commit on top");
    expect(f.ok(["rev-parse", "refs/heads/topic"])).toBe(foreign);
  } finally { f.close(); }
});

test("detached inherited authors are protected, including author replacement", () => {
  const f = fixture();
  try {
    f.ok(["commit", "--allow-empty", "-m", "foreign"], { ...f.machine,
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: ["fixture", "example.invalid"].join("@") });
    f.ok(["checkout", "--detach", "-q"]);
    const before = f.ok(["rev-parse", "HEAD"]);
    const result = f.run(["commit", "--amend", "--allow-empty", "--reset-author", "--no-verify", "-m", "replacement"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("add a new commit on top");
    expect(f.ok(["rev-parse", "HEAD"])).toBe(before);
  } finally { f.close(); }
});

test("signed machine commits remain amendable when Git displays signatures", () => {
  const f = fixture();
  try {
    const key = path.join(f.root, "signing-key");
    const generated = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], { stdout: "pipe", stderr: "pipe" });
    expect(generated.exitCode).toBe(0);
    const allowed = path.join(f.root, "allowed-signers");
    fs.writeFileSync(allowed, "fixture " + fs.readFileSync(key + ".pub", "utf8"));
    for (const [name, value] of [["gpg.format", "ssh"], ["user.signingkey", key],
      ["gpg.ssh.allowedSignersFile", allowed], ["commit.gpgsign", "true"], ["log.showSignature", "true"], ["color.ui", "always"]]) f.ok(["config", name!, value!]);
    f.ok(["commit", "--allow-empty", "-m", "signed machine work"]);
    f.ok(["commit", "--amend", "--allow-empty", "-m", "revised signed machine work"]);
    expect(f.ok(["log", "-1", "--no-show-signature", "--no-color", "--format=%an%n%ae%n%cn%n%ce"])).toBe(Object.values(controllerCommitIdentityEnv()).join("\n"));
  } finally { f.close(); }
});

test.each(["cherry-pick", "reuse", "am"])("refuses %s that would create a commit with an inherited author", (operation) => {
  const f = fixture();
  try {
    f.ok(["checkout", "-q", "-b", "foreign"]);
    fs.writeFileSync(path.join(f.root, "work.txt"), "foreign work\n");
    f.ok(["add", "work.txt"]);
    f.ok(["commit", "-m", "foreign work"], { ...f.machine,
      GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: ["fixture", "example.invalid"].join("@") });
    const patch = path.join(f.root, "foreign.patch");
    fs.writeFileSync(patch, f.ok(["format-patch", "-1", "--stdout"]) + "\n");
    f.ok(["checkout", "-q", "main"]);
    const before = f.ok(["rev-parse", "HEAD"]);
    const result = f.run(operation === "cherry-pick" ? ["cherry-pick", "foreign"]
      : operation === "am" ? ["am", patch] : ["commit", "--allow-empty", "--no-verify", "-C", "foreign"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("add a new commit on top");
    expect(f.ok(["rev-parse", "HEAD"])).toBe(before);
  } finally { f.close(); }
});

test("configured machine names use Git's normalized identity", () => {
  const f = fixture();
  try {
    const env = { ...f.source, ...agentPublicationIdentityEnv({ ...f.source, DELEGATUS_PUBLICATION_NAME: " Build Agent's Tools " }) };
    f.ok(["commit", "--allow-empty", "-m", "configured work"], env);
    f.ok(["commit", "--amend", "--allow-empty", "-m", "configured amendment"], env);
    expect(f.ok(["log", "-1", "--format=%an"])).toBe("Build Agent's Tools");
    f.ok(["checkout", "-q", "-b", "machine-patch"], env);
    fs.writeFileSync(path.join(f.root, "machine.txt"), "machine work\n");
    f.ok(["add", "machine.txt"], env);
    f.ok(["commit", "-m", "machine patch"], env);
    const patch = path.join(f.root, "machine.patch");
    fs.writeFileSync(patch, f.ok(["format-patch", "-1", "--stdout"], env) + "\n");
    f.ok(["checkout", "-q", "main"], env);
    f.ok(["am", patch], env);
    expect(f.ok(["log", "-1", "--format=%an"])).toBe("Build Agent's Tools");
  } finally { f.close(); }
});

test("renaming and deleting branches preserves foreign commits without rewriting them", () => {
  const f = fixture();
  try {
    f.ok(["commit", "--allow-empty", "-m", "foreign"], { ...f.machine,
      GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: ["fixture", "example.invalid"].join("@") });
    const before = f.ok(["rev-parse", "HEAD"]);
    f.ok(["branch", "-m", "renamed"]);
    expect(f.ok(["rev-parse", "HEAD"])).toBe(before);
    f.ok(["branch", "temporary"]);
    f.ok(["branch", "-d", "temporary"]);
    expect(f.ok(["rev-parse", "HEAD"])).toBe(before);
  } finally { f.close(); }
});
