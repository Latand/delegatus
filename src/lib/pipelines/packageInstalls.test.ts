import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commitPipelineStage, provisionPipelineWorktreeAsync } from "./git";
import type { Pipeline } from "./types";
import type { ExecPort } from "@/lib/workflows/provision";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-installs-"));
  const repo = path.join(root, "source"), lane = path.join(root, "lane");
  fs.mkdirSync(repo);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "global") };
  for (const key of Object.keys(env)) if (/^GIT_(?:AUTHOR_|COMMITTER_|CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS))/.test(key)) delete env[key as keyof typeof env];
  const exec: ExecPort = (command, args, cwd, overrides, options) => {
    const r = spawnSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: options?.stdoutEncoding ?? "utf8" });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
  };
  const git = async (...args: string[]) => {
    const r = await exec("git", args, repo);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Repository Fixture");
  await git("config", "user.email", ["fixture", "example.invalid"].join("@"));
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"fixture","private":true}\n');
  await git("add", "."); await git("commit", "-qm", "base");
  const base = await git("rev-parse", "HEAD");
  fs.mkdirSync(path.join(repo, "node_modules", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/fixture/index.js"), "original\n");
  const subject = { id: "12345678", repoDir: repo, worktreeDir: lane, branch: "pipeline/fixture",
    baseBranch: "main", baseRef: base, baseRefPinned: true, lastPassedCommit: base, taskIds: [],
    stages: [{ kind: "run", access: "read-only" }] } as unknown as Pipeline;
  return { root, repo, lane, env, exec, git, subject };
}

test("package installs: a read-only pipeline reuses the source dependencies", async () => {
  const f = await fixture();
  try {
    expect(await provisionPipelineWorktreeAsync(f.subject, async (c, a, cwd) => await f.exec(c, a, cwd))).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(f.lane, "node_modules/fixture/index.js"))).toBe(true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("package installs: controller commits use repository identity with tool attribution", async () => {
  const f = await fixture();
  try {
    f.subject.worktreeDir = f.repo;
    fs.writeFileSync(path.join(f.repo, "change.txt"), "stage change\n");
    expect(await commitPipelineStage(f.subject, "build", true, f.exec)).toMatchObject({ ok: true });
    expect(await f.git("log", "-1", "--format=%an")).toBe("Repository Fixture");
    expect(await f.git("log", "-1", "--format=%B")).toContain("Co-Authored-By: Delegatus <" + ["noreply", "delegatus.invalid"].join("@") + ">");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("package installs: settlement hooks use isolated dependencies when lane inputs differ", async () => {
  const f = await fixture();
  try {
    expect(await provisionPipelineWorktreeAsync(f.subject, async (c, a, cwd) => await f.exec(c, a, cwd))).toMatchObject({ ok: true });
    fs.rmSync(path.join(f.lane, "node_modules"), { recursive: true, force: true });
    fs.writeFileSync(path.join(f.repo, "package.json"), '{"name":"fixture","private":true,"dependencies":{"source-only":"1"}}\n');
    fs.writeFileSync(path.join(f.lane, "report.txt"), "stage report\n");
    const hooks = await f.git("rev-parse", "--git-path", "hooks");
    const hook = path.resolve(f.repo, hooks, "pre-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\nmkdir -p node_modules/fixture\nprintf generated > node_modules/fixture/generated.js\n", { mode: 0o755 });
    expect(await commitPipelineStage(f.subject, "review", false, f.exec, ["report.txt"])).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(f.repo, "node_modules/fixture/index.js"), "utf8")).toBe("original\n");
    expect(fs.existsSync(path.join(f.repo, "node_modules/fixture/generated.js"))).toBe(false);
    expect(fs.readFileSync(path.join(f.lane, "node_modules/fixture/generated.js"), "utf8")).toBe("generated");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("package installs: a real offline npm install changes only the writable lane", async () => {
  const f = await fixture();
  try {
    f.subject.stages[0].access = "read-write";
    expect(await provisionPipelineWorktreeAsync(f.subject, async (c, a, cwd) => await f.exec(c, a, cwd))).toMatchObject({ ok: true });
    const dependency = path.join(f.root, "new-package"); fs.mkdirSync(dependency);
    fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "local-fixture", version: "1.0.0" }));
    const manifest = fs.readFileSync(path.join(f.repo, "package.json"));
    const installed = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", dependency],
      { cwd: f.lane, env: { ...f.env, npm_config_cache: path.join(f.root, "npm-cache") }, encoding: "utf8", timeout: 30_000 });
    expect(installed.status, installed.stderr).toBe(0);
    expect(fs.existsSync(path.join(f.lane, "package-lock.json"))).toBe(true);
    expect(fs.existsSync(path.join(f.lane, "node_modules/local-fixture/package.json"))).toBe(true);
    expect(fs.readFileSync(path.join(f.repo, "package.json")).equals(manifest)).toBe(true);
    expect(fs.existsSync(path.join(f.repo, "package-lock.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.repo, "node_modules/local-fixture"))).toBe(false);
    expect(fs.readFileSync(path.join(f.repo, "node_modules/fixture/index.js"), "utf8")).toBe("original\n");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
