import { seedForgeCommitAccount } from "@/test-helpers/forgeCommitAccount";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecPort } from "@/lib/workflows/provision";
import { hookedRepo, nestedSuffixRefusal, OUTPUT, realRefusal, writeOutput } from "./stageCommitRepairRepo.fixture";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-commit-repair-git-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = state;
seedForgeCommitAccount();
afterAll(() => {
  fs.rmSync(state, { recursive: true, force: true });
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
});
const { commitPipelineStage, provisionPipelineWorktree, provisionPipelineWorktreeAsync } = await import("./git");
const { realExec } = await import("@/lib/workflows/provision");

test.each(["sync", "async"] as const)("%s provisioning supports the first hooked commit in a fresh worktree", async mode => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, "package.json"), "{}\n");
    fs.writeFileSync(path.join(box.repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(box.repo, "scripts"));
    fs.writeFileSync(path.join(box.repo, "scripts/lint.ts"), 'import { ESLint } from "eslint";\nconst results = await new ESLint().lintFiles(["source.ts"]);\nif (results.some(result => result.errorCount)) process.exit(1);\n');
    fs.copyFileSync(path.resolve("eslint.config.mjs"), path.join(box.repo, "eslint.config.mjs"));
    box.run("add", ".");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "lint configuration");
    fs.symlinkSync(path.resolve("node_modules"), path.join(box.repo, "node_modules"), "dir");
    const subject = { ...box.subject, branch: "lane", baseBranch: "main", baseRef: box.run("rev-parse", "HEAD"), worktreeDir: path.join(box.root, "lane") };
    expect(fs.existsSync(subject.worktreeDir)).toBe(false);
    const provisioned = mode === "sync"
      ? await provisionPipelineWorktree(subject, box.exec)
      : await provisionPipelineWorktreeAsync(subject, (command, args, cwd) => Promise.resolve(box.exec(command, args, cwd)));
    expect(provisioned).toMatchObject({ ok: true });
    fs.writeFileSync(path.join(box.repo, ".git/hooks/pre-commit"), `#!/bin/sh\n'${process.execPath}' --no-install scripts/lint.ts\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(subject.worktreeDir, "source.ts"), "export const value = 2;\n");
    expect((await box.exec("git", ["add", "source.ts"], subject.worktreeDir)).code).toBe(0);
    const commit = await box.exec("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "first stage change"], subject.worktreeDir);
    expect(commit, commit.stderr).toMatchObject({ code: 0 });
    // Exercise real lint refusal too, so a silently skipped hook cannot pass.
    fs.writeFileSync(path.join(subject.worktreeDir, "source.ts"), "export const value: any = 2;\n");
    await box.exec("git", ["add", "source.ts"], subject.worktreeDir);
    const refused = await box.exec("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "invalid stage change"], subject.worktreeDir);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).not.toContain("Cannot find module");
    expect(box.calls.join("\n")).not.toContain("bun install");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([["sync", "changed"], ["async", "changed"], ["sync", "absent"], ["async", "absent"]] as const)("%s provisioning privately installs lane dependencies before the first hook (%s source manifest)", async (mode, manifest) => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, ".gitignore"), "node_modules/\n");
    fs.mkdirSync(path.join(box.repo, "tool"));
    fs.writeFileSync(path.join(box.repo, "tool/package.json"), JSON.stringify({ name: "fixture-tool", version: "1.0.0", bin: { "fixture-lint": "lint.js" } }));
    fs.writeFileSync(path.join(box.repo, "tool/lint.js"), '#!/usr/bin/env bun\nif (require("node:fs").readFileSync("source.ts", "utf8").includes("any")) process.exit(1);\n', { mode: 0o755 });
    fs.writeFileSync(path.join(box.repo, "package.json"), JSON.stringify({ dependencies: { "fixture-tool": "file:./tool" } }));
    const lock = await box.exec("bun", ["install", "--lockfile-only", "--ignore-scripts"], box.repo);
    expect(lock, lock.stderr).toMatchObject({ code: 0 });
    box.run("add", ".");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "local hook dependency");
    const subject = { ...box.subject, branch: "lane", baseBranch: "main", baseRef: box.run("rev-parse", "HEAD"), worktreeDir: path.join(box.root, "lane") };
    // The source changed after the accepted base. Its installed tools cannot
    // satisfy the lane, even if copying them would keep writes isolated.
    if (manifest === "absent") fs.unlinkSync(path.join(box.repo, "package.json"));
    else fs.writeFileSync(path.join(box.repo, "package.json"), "{}\n");
    fs.mkdirSync(path.join(box.repo, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(box.repo, "node_modules/source-only"), "preserved\n");
    const provisioned = mode === "sync"
      ? await provisionPipelineWorktree(subject, box.exec)
      : await provisionPipelineWorktreeAsync(subject, async (command, args, cwd) => await box.exec(command, args, cwd));
    expect(provisioned).toMatchObject({ ok: true });
    expect(fs.lstatSync(path.join(subject.worktreeDir, "node_modules")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(subject.worktreeDir, "node_modules/source-only"))).toBe(false);
    expect(fs.readFileSync(path.join(box.repo, "node_modules/source-only"), "utf8")).toBe("preserved\n");
    expect(box.calls).toContain("bun install --frozen-lockfile --ignore-scripts --backend=copyfile");
    fs.writeFileSync(path.join(box.repo, ".git/hooks/pre-commit"), "#!/bin/sh\nnode_modules/.bin/fixture-lint\n", { mode: 0o755 });
    for (const [content, allowed] of [["export const value = 2;\n", true], ["export const value: any = 2;\n", false]] as const) {
      fs.writeFileSync(path.join(subject.worktreeDir, "source.ts"), content);
      await box.exec("git", ["add", "source.ts"], subject.worktreeDir);
      const committed = await box.exec("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "hooked change"], subject.worktreeDir);
      expect(committed.code === 0, committed.stderr).toBe(allowed);
    }
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("private installation copies cached package files before writable use", async () => {
  const box = hookedRepo();
  try {
    const original = "module.exports = 'original';\n";
    const archive = path.join(box.root, "dependency.tgz");
    await Bun.write(archive, new Bun.Archive({
      "package/package.json": JSON.stringify({ name: "fixture-cache", version: "1.0.0", main: "index.js" }),
      "package/index.js": original,
    }, { compress: "gzip" }));
    fs.writeFileSync(path.join(box.repo, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(box.repo, "package.json"), JSON.stringify({ dependencies: { "fixture-cache": `file:${archive}` } }));
    const exec: ExecPort = (command, args, cwd, env, options) => box.exec(command, args, cwd,
      { ...env, BUN_INSTALL_CACHE_DIR: path.join(box.root, "cache") }, options);
    const installed = await exec("bun", ["install", "--ignore-scripts", "--backend=hardlink"], box.repo);
    expect(installed, installed.stderr).toMatchObject({ code: 0 });
    const sourceFile = path.join(box.repo, "node_modules/fixture-cache/index.js");
    const sourceStat = fs.statSync(sourceFile, { bigint: true });
    expect(sourceStat.nlink > BigInt(1)).toBe(true);
    box.run("add", ".");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "cached dependency");
    const subject = { ...box.subject, branch: "lane", baseBranch: "main", baseRef: box.run("rev-parse", "HEAD"), worktreeDir: path.join(box.root, "lane") };
    fs.writeFileSync(path.join(box.repo, "package.json"), "{}\n");
    expect(await provisionPipelineWorktree(subject, exec)).toMatchObject({ ok: true });
    const localFile = path.join(subject.worktreeDir, "node_modules/fixture-cache/index.js");
    fs.writeFileSync(localFile, "module.exports = 'lane';\n");
    expect(fs.readFileSync(sourceFile, "utf8")).toBe(original);
    const localStat = fs.statSync(localFile, { bigint: true });
    expect(localStat.dev === sourceStat.dev && localStat.ino === sourceStat.ino).toBe(false);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["sync", "async"] as const)("%s provisioning refuses a failed private install and preserves the parent", async mode => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(box.repo, "package.json"), "{}\n");
    box.run("add", ".");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "package inputs");
    const subject = { ...box.subject, branch: "lane", baseBranch: "main", baseRef: box.run("rev-parse", "HEAD"), worktreeDir: path.join(box.root, "lane") };
    // Missing source inputs must select an install, never a parent snapshot.
    fs.unlinkSync(path.join(box.repo, "package.json"));
    fs.mkdirSync(path.join(box.repo, "node_modules"));
    fs.writeFileSync(path.join(box.repo, "node_modules/source-only"), "preserved\n");
    const exec: ExecPort = (command, args, cwd, env, options) => {
      if (command !== "bun") return box.exec(command, args, cwd, env, options);
      expect(args).toEqual(["install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"]);
      expect(cwd).toBe(subject.worktreeDir);
      expect(options?.timeoutMs).toBe(180_000);
      return { code: 1, stdout: "", stderr: "install refused" };
    };
    const result = mode === "sync"
      ? await provisionPipelineWorktree(subject, exec)
      : await provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal, options) => await exec(command, args, cwd, options?.env, { signal, timeoutMs: options?.timeoutMs }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("source dependencies preserved") });
    expect(fs.existsSync(path.join(subject.worktreeDir, "node_modules"))).toBe(false);
    expect(fs.readFileSync(path.join(box.repo, "node_modules/source-only"), "utf8")).toBe("preserved\n");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["sync", "async"] as const)("%s provisioning refuses private hook tools without a lane manifest", async mode => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, ".gitignore"), "node_modules/\n");
    box.run("add", ".");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "ignore tools");
    const subject = { ...box.subject, branch: "lane", baseBranch: "main", baseRef: box.run("rev-parse", "HEAD"), worktreeDir: path.join(box.root, "lane") };
    fs.writeFileSync(path.join(box.repo, "package.json"), "{}\n");
    fs.mkdirSync(path.join(box.repo, "node_modules"));
    fs.writeFileSync(path.join(box.repo, "node_modules/source-only"), "preserved\n");
    const result = mode === "sync"
      ? await provisionPipelineWorktree(subject, box.exec)
      : await provisionPipelineWorktreeAsync(subject, async (command, args, cwd) => await box.exec(command, args, cwd));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("source dependencies preserved") });
    expect(box.calls).toContain("bun install --frozen-lockfile --ignore-scripts --backend=copyfile");
    expect(fs.existsSync(path.join(subject.worktreeDir, "node_modules/source-only"))).toBe(false);
    expect(fs.readFileSync(path.join(box.repo, "node_modules/source-only"), "utf8")).toBe("preserved\n");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("async provisioning propagates cancellation during a private install", async () => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(box.repo, "package.json"), "{}\n");
    box.run("add", ".");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "package inputs");
    const subject = { ...box.subject, branch: "lane", baseBranch: "main", baseRef: box.run("rev-parse", "HEAD"), worktreeDir: path.join(box.root, "lane") };
    const abort = new AbortController();
    let installs = 0;
    const result = await provisionPipelineWorktreeAsync(subject, async (command, args, cwd, signal, options) => {
      if (command !== "bun") return await box.exec(command, args, cwd);
      installs++;
      expect(signal).toBe(abort.signal);
      expect(options?.timeoutMs).toBe(180_000);
      abort.abort();
      return { code: 0, stdout: "", stderr: "" };
    }, abort.signal);
    expect(installs).toBe(1);
    expect(result).toMatchObject({ ok: false, error: "pipeline provisioning cancelled" });
    expect(fs.existsSync(path.join(subject.worktreeDir, "node_modules"))).toBe(false);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([
  ["installed", "node_modules"], ["fixed-on-retry", "node_modules"],
  ["interrupted", "node_modules"], ["recovered", "node_modules"],
  ["installed", "node_modules/"], ["fixed-on-retry", "node_modules/"],
  ["interrupted", "node_modules/"], ["recovered", "node_modules/"],
] as const)("settlement finds the %s parent toolchain with %s ignored for a read-only TypeScript output", async (toolchain, ignore) => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, ".gitignore"), `${ignore}\n`);
    fs.writeFileSync(path.join(box.repo, "package.json"), "{}\n");
    fs.mkdirSync(path.join(box.repo, "scripts"));
    // The provisioning tests above already run ESLint. This matrix needs a
    // real package import so copies and missing installs affect the hook result.
    const tools = path.join(box.root, "installed-tools");
    const tool = path.join(tools, "fixture-lint");
    fs.mkdirSync(tool, { recursive: true });
    fs.writeFileSync(path.join(tool, "package.json"), JSON.stringify({ name: "fixture-lint", main: "index.js" }));
    fs.writeFileSync(path.join(tool, "index.js"), 'exports.check = (file) => require("node:fs").readFileSync(file, "utf8") === "export const value = 1;\\n";\n');
    fs.writeFileSync(path.join(box.repo, "scripts/lint.ts"), 'import { check } from "fixture-lint";\nif (!check("evidence/draft/output.ts")) process.exit(1);\n');
    box.run("add", ".");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "toolchain configuration");
    if (toolchain !== "fixed-on-retry") fs.symlinkSync(tools, path.join(box.repo, "node_modules"), "dir");
    const worktree = path.join(box.root, "lane");
    box.run("worktree", "add", "-b", "lane", worktree);
    box.subject.worktreeDir = worktree;
    box.subject.lastPassedCommit = box.run("rev-parse", "HEAD");
    fs.writeFileSync(path.join(box.repo, ".git/hooks/pre-commit"), `#!/bin/sh\necho 'pre-commit: eslint' >&2\n'${process.execPath}' --no-install scripts/lint.ts || exit $?\necho checked >> '${path.join(box.repo, ".git/hook-checks")}'\n`, { mode: 0o755 });
    writeOutput(worktree, "evidence/draft/output.ts", "export const value = 1;\n");
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
    if (toolchain === "fixed-on-retry") {
      const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
      expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("pre-commit: eslint"), commitRefusal: { paths: ["evidence/draft/output.ts"] } });
      if (refused.ok) throw new Error("unreachable");
      expect(fs.readFileSync(path.join(worktree, "evidence/draft/output.ts"), "utf8")).toBe("export const value = 1;\n");
      // The first attempt installed the declared empty graph privately.
      // Repair removes that fixture-owned install before providing tools;
      // settlement must preserve any existing private installation.
      const privateTools = path.join(worktree, "node_modules");
      expect(fs.lstatSync(privateTools).isDirectory()).toBe(true);
      fs.rmSync(privateTools, { recursive: true });
      fs.symlinkSync(tools, path.join(box.repo, "node_modules"), "dir");
    }
    const receipt = path.join(box.root, "stage-commit.json");
    if (toolchain === "recovered") {
      expect((await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit, receipt)).ok).toBe(true);
    }
    if (toolchain === "interrupted" || toolchain === "recovered") {
      // Model a source-owned link left by an older controller, including
      // recovery after a successful commit already prepared private tools.
      if (toolchain === "recovered") fs.rmSync(path.join(worktree, "node_modules"), { recursive: true, force: true });
      fs.symlinkSync(path.resolve(box.repo, "node_modules"), path.join(worktree, "node_modules"), "dir");
      if (toolchain === "interrupted") await box.exec("git", ["add", "evidence/draft/output.ts"], worktree);
    }
    const committed = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit, receipt);
    expect(committed).toMatchObject({ ok: true });
    const localTools = path.join(worktree, "node_modules");
    if (toolchain === "recovered") expect(fs.lstatSync(localTools, { throwIfNoEntry: false })).toBeUndefined();
    else {
      expect(fs.lstatSync(localTools).isDirectory()).toBe(true);
      expect(fs.realpathSync(localTools)).not.toBe(fs.realpathSync(path.join(box.repo, "node_modules")));
    }
    expect(fs.readlinkSync(path.join(box.repo, "node_modules"))).toBe(tools);
    const head = await box.exec("git", ["show", "--format=", "--name-only", "HEAD"], worktree);
    expect(head.stdout.trim()).toBe("evidence/draft/output.ts");
    expect(fs.readFileSync(path.join(box.repo, ".git/hook-checks"), "utf8")).toBe("checked\n");
    expect(box.calls.join("\n")).not.toContain("--no-verify");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["local", "unrelated", "dangling", "dangling-parent", "unignored"] as const)("settlement handles %s dependency paths and commits only declared outputs", async (mode) => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, ".gitignore"), mode === "unignored" ? "" : "node_modules\n");
    box.run("add", ".gitignore");
    box.run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "dependency ignore");
    fs.mkdirSync(path.join(box.repo, "node_modules"));
    const worktree = path.join(box.root, "lane");
    box.run("worktree", "add", "-b", "lane", worktree);
    box.subject.worktreeDir = worktree;
    box.subject.lastPassedCommit = box.run("rev-parse", "HEAD");
    const local = path.join(worktree, "node_modules");
    if (mode === "local") {
      fs.mkdirSync(local);
      fs.writeFileSync(path.join(local, "owned.txt"), "local install\n");
    } else if (mode === "unrelated") fs.symlinkSync(path.resolve("node_modules"), local, "dir");
    else if (mode === "dangling") fs.symlinkSync("missing-install", local, "dir");
    else if (mode === "dangling-parent") {
      fs.rmdirSync(path.join(box.repo, "node_modules"));
      fs.symlinkSync(path.resolve(box.repo, "node_modules"), local, "dir");
    }
    writeOutput(worktree, "evidence/draft/output.ts", "export const value = 1;\n");
    expect((await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit)).ok).toBe(true);
    expect((await box.exec("git", ["show", "--format=", "--name-only", "HEAD"], worktree)).stdout.trim()).toBe("evidence/draft/output.ts");
    if (mode === "local") expect(fs.readFileSync(path.join(local, "owned.txt"), "utf8")).toBe("local install\n");
    else if (mode === "unrelated") expect(fs.readlinkSync(local)).toBe(path.resolve("node_modules"));
    else if (mode === "dangling") expect(fs.readlinkSync(local)).toBe("missing-install");
    else if (mode === "dangling-parent") expect(fs.lstatSync(local, { throwIfNoEntry: false })).toBeUndefined();
    else expect(fs.existsSync(local)).toBe(false);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("an expired real commit keeps its staged output and retries through the same hook", async () => {
  const box = hookedRepo();
  try {
    const hook = path.join(box.repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nsleep 5\ngit diff --cached --check\n", { mode: 0o755 });
    writeOutput(box.repo, OUTPUT, "passed output\n");
    const exec: ExecPort = (command, args, cwd, env, options) => realExec(command, args, cwd, { ...box.env, ...env },
      args[0] === "commit" ? { ...options, timeoutMs: 100 } : options);
    const timedOut = await commitPipelineStage(box.subject, "study", false, exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(timedOut).toMatchObject({ ok: false, deferred: true, commitTimeout: true });
    expect(timedOut.commitRefusal).toBeUndefined();
    expect(box.run("rev-parse", "HEAD")).toBe(box.subject.lastPassedCommit!);
    expect(box.run("diff", "--cached", "--name-only")).toBe(OUTPUT);
    fs.writeFileSync(hook, "#!/bin/sh\ngit diff --cached --check\n", { mode: 0o755 });
    const retried = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(retried.ok).toBeTrue();
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a hook that refuses a read-only stage's declared output hands back its files, and the repaired output commits through the same hook", async () => {
  const box = hookedRepo();
  try {
    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote \n");
    const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    /* The park text is unchanged: the step, then what the hook printed. */
    expect(refused.error).toStartWith("committing the passed stage: pre-commit: staged whitespace — ");
    expect(refused.commitRefusal).toEqual({ paths: [OUTPUT] });
    expect(box.run("rev-parse", "HEAD")).toBe(box.subject.lastPassedCommit!);

    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote\n");
    const committed = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(committed.ok).toBe(true);
    expect(box.run("show", "--format=", "--name-only", "HEAD")).toBe(OUTPUT);
    /* The hook decided both times. */
    expect(box.calls.join("\n")).not.toContain("--no-verify");
    expect(box.calls.some((call) => call.includes("core.hooksPath"))).toBe(false);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a read-only repair that touches a path outside the declared outputs is still refused by the fence", async () => {
  const box = hookedRepo();
  try {
    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote \n");
    expect((await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit)).ok).toBe(false);

    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote\n");
    fs.writeFileSync(path.join(box.repo, "source.ts"), "export const value = 2;\n");
    const fenced = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(fenced).toEqual({ ok: false, error: "read-only stage study modified undeclared worktree paths" });
    expect(box.run("rev-parse", "HEAD")).toBe(box.subject.lastPassedCommit!);
    expect(fs.readFileSync(path.join(box.repo, "source.ts"), "utf8")).toBe("export const value = 2;\n");
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a writable stage's refused commit hands back the files it staged", async () => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, "source.ts"), "export const value = 2; \n");
    const refused = await commitPipelineStage(box.subject, "build", true, box.exec);
    expect(refused).toMatchObject({ ok: false, commitRefusal: { paths: ["source.ts"] } });
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

/* No pattern in the output decides anything: every refusal of `git commit` is
   handed back whole, with the files the commit held. */
test.each([
  ["a slot that never became free", "broken", ["gate-slot: no slot became free within 600s"]],
  ["a tool that is missing", "tool-missing", [`checking ${OUTPUT}`, "not found"]],
  ["a tool that is missing after a whitespace hit", "tool-missing-after-check", [`${OUTPUT}:1: trailing whitespace.`, "llv-test-tool-that-is-not-installed"]],
  ["a privacy gate that could not judge after a whitespace hit", "privacy-unconfigured", [`${OUTPUT}:1: trailing whitespace.`, "PRIVACY GATE: FAIL", "configuration_error: 1"]],
  ["a check that timed out after a whitespace hit", "timeout-after-check", [`${OUTPUT}:1: trailing whitespace.`, "timeout: sending signal TERM to command"]],
  ["a linter with no configuration after a whitespace hit", "eslint-unconfigured-after-check", [`${OUTPUT}:1: trailing whitespace.`, "eslint.config"]],
] as const)("a real hook refusal (%s) is handed back with all it printed", async (_name, mode, printed) => {
  const output = await realRefusal(mode);
  for (const line of printed) expect(output).toContain(line);
});

test("a real lint refusal of another file whose name ends like the staged one is handed back with all it printed", async () => {
  const output = await nestedSuffixRefusal();
  expect(output).toContain("nested/source.js");
  expect(output).toMatch(/1:7\s+error/);
});

/* ---------- the controller, over an isolated store ---------- */
