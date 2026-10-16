import { afterAll, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { defaultPipelinePorts, harness, createPipelineFromRequest, tickPipelines, loadPipelines, savePipelines, RUN_STAGES, finishReported, entry } from "./engine.fixture";
import { canonicalProject } from "@/lib/projects/aliases";
import { directoryProjectId, localRepositoryProjectId } from "@/lib/projects/identity";
import { projectForCwd } from "@/lib/scanner/describe";
import { globalCache } from "@/lib/scanner/caches";
import { readBridgeReportLog } from "@/lib/bridge/store";
import { realProvisionExec } from "./git";
import { realExec } from "@/lib/workflows/provision";
import { POST as preflight } from "@/app/api/pipelines/preflight/route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-init-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;
function folder() {
  const dir = path.join(root, String(++serial));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "readme.txt"), "Project baseline\n");
  return dir;
}
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const admit = (dir: string) => defaultPipelinePorts().preflightRepo(dir);
function ports() {
  const h = harness();
  h.ports.preflightRepo = defaultPipelinePorts().preflightRepo;
  h.ports.projectForCwd = dir => projectForCwd(dir);
  h.ports.exec = realExec;
  h.ports.provisionExec = realProvisionExec;
  return h;
}

test("A: board eligibility is read-only; creation initializes main and reports its safe baseline", async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, ".gitignore"), "custom-output/\n");
  for (const name of [".env", ".env.example", "private.key", "credentials.json", ".npmrc", ".gitconfig", "auth.json", "private.ppk"]) fs.writeFileSync(path.join(dir, name), "private fixture\n");
  fs.mkdirSync(path.join(dir, ".docker"));
  fs.writeFileSync(path.join(dir, ".docker", "config.json"), JSON.stringify({ auths: { registry: { auth: "fixture-value" } } }));
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "dependency.js"), "dependency\n");
  const response = await preflight(new NextRequest("http://localhost/api/pipelines/preflight", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ repoDir: dir }) }));
  expect(response.status).toBe(200);
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  const h = ports();
  const result = await createPipelineFromRequest({ task: "Initialize project", repoDir: dir, stages: RUN_STAGES as never }, h.ports);
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.state).toBe("provisioning");
  expect(git(dir, "branch", "--show-current")).toBe("main");
  expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  expect(git(dir, "show", "-s", "--format=%an|%cn")).toBe("Delegatus|Delegatus");
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([".gitignore", "readme.txt"]);
  expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toStartWith("custom-output/\n");
  expect(JSON.stringify(result)).toContain("committedFiles");
  const reports = readBridgeReportLog().reports.filter(report => report.project === result.pipeline!.project);
  expect(JSON.stringify(reports)).toContain("readme.txt");
  expect(JSON.stringify(reports)).toContain(".env");
});

test("B: refuses home and state roots with a reason and without modifying their files", async () => {
  for (const dir of [os.homedir(), process.env.LLV_STATE_DIR!]) {
    const result = await admit(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/home|state/i);
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  }
});

test("B: refuses a candidate over the configured file-count bound before creating git or ignore files", async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, "second.txt"), "second\n");
  const previous = process.env.LLV_PIPELINE_INIT_MAX_FILES;
  process.env.LLV_PIPELINE_INIT_MAX_FILES = "1";
  try {
    const result = await admit(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("file");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_PIPELINE_INIT_MAX_FILES;
    else process.env.LLV_PIPELINE_INIT_MAX_FILES = previous;
  }
});

test("B: content secrets, nested ignore overrides, links and large files never enter the commit or answer", async () => {
  const dir = folder();
  const secret = ["gh", "p_", "a".repeat(36)].join("");
  fs.writeFileSync(path.join(dir, "ordinary.txt"), "a".repeat(16_000) + "token" + "\n".repeat(16_000));
  fs.writeFileSync(path.join(dir, "innocent.txt"), secret);
  const escaped = [...secret].map(char => String.fromCharCode(92) + "u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  fs.writeFileSync(path.join(dir, "escaped.txt"), escaped);
  fs.writeFileSync(path.join(dir, "encoded.txt"), Buffer.from(secret, "utf16le"));
  fs.writeFileSync(path.join(dir, "encoded-be.txt"), Buffer.from(secret, "utf16le").swap16());
  fs.writeFileSync(path.join(dir, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", ".gitignore"), "!.env\n!innocent.txt\n!large.bin\n");
  fs.writeFileSync(path.join(dir, "nested", "innocent.txt"), secret);
  fs.writeFileSync(path.join(dir, "nested", "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(dir, "nested", ".env"), secret);
  fs.symlinkSync(path.join(dir, "readme.txt"), path.join(dir, "link.txt"));
  const result = await admit(dir);
  expect(result.ok).toBe(true);
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("innocent.txt");
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/large|link|encoded|escaped|\.env/);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(git(dir, "status", "--porcelain")).toBe("");
  git(dir, "add", "--all");
  expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
});

test("B: a subfolder of an existing repository never acquires a nested repository", async () => {
  const dir = folder();
  git(dir, "init", "-b", "main", "--template=");
  fs.mkdirSync(path.join(dir, "nested"));
  const result = await admit(path.join(dir, "nested"));
  expect(result.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, "nested", ".git"))).toBe(false);
});

test("C: initialization records the directory-to-local-repository succession immediately", async () => {
  const dir = folder();
  const before = directoryProjectId(dir);
  expect(projectForCwd(dir)).toBe(before);
  expect((await admit(dir)).ok).toBe(true);
  globalCache("project-info-cwd-v2").clear();
  const after = localRepositoryProjectId(dir)!;
  expect(canonicalProject(before)).toBe(after);
  expect(projectForCwd(dir)).toBe(after);
});

test("D: a new local repository provisions and completes its branch with no remote or PR", async () => {
  const dir = folder();
  const h = ports();
  h.ports.exec = (command, args, ...rest) => {
    expect(command).not.toBe("gh");
    expect(args).not.toContain("push");
    expect(args).not.toContain("fetch");
    return realExec(command, args, ...rest);
  };
  h.ports.provisionExec = (command, args, ...rest) => {
    expect(command).not.toBe("gh");
    expect(args).not.toContain("push");
    expect(args).not.toContain("fetch");
    return realProvisionExec(command, args, ...rest);
  };
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Local pipeline", repoDir: dir, stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] }, h.ports);
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.delivery?.target.remote).toBe("");
  expect(result.pipeline?.delivery?.target.pr).toBeUndefined();
  expect(git(dir, "remote")).toBe("");
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]?.state).toBe("running");
  expect(fs.existsSync(path.join(loadPipelines()[0]!.worktreeDir, ".git"))).toBe(true);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  const finished = finishReported(h, attempt.agentPath!, "pass", "Local work complete");
  await tickPipelines([finished], h.ports);
  for (let i = 0; i < 5 && loadPipelines()[0]?.state !== "completed"; i++) await tickPipelines([entry(attempt.agentPath!)], h.ports);
  expect(loadPipelines()[0]?.state).toBe("completed");
  expect(git(dir, "show-ref", "--verify", "refs/heads/" + lane.branch)).toContain(git(dir, "rev-parse", "HEAD"));
  expect(git(dir, "remote")).toBe("");
});

test("A: an empty folder receives its baseline ignore file and one commit", async () => {
  const dir = folder();
  fs.unlinkSync(path.join(dir, "readme.txt"));
  expect((await admit(dir)).ok).toBe(true);
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).toBe(".gitignore");
});

test("A: existing ignore rules and executable files survive initialization", async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, ".gitignore"), "custom-output/\n");
  fs.mkdirSync(path.join(dir, "custom-output"));
  fs.writeFileSync(path.join(dir, "custom-output", "result.txt"), "generated\n");
  fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\r\nexit 0\r\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, ".gitattributes"), "run.sh text eol=lf\n");
  fs.writeFileSync(path.join(dir, ":(glob)**"), "literal path\n");
  expect((await admit(dir)).ok).toBe(true);
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("result.txt");
  expect(git(dir, "ls-tree", "HEAD", "run.sh")).toStartWith("100755");
  expect(execFileSync("git", ["-C", dir, "show", "HEAD:run.sh"])).toEqual(fs.readFileSync(path.join(dir, "run.sh")));
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).toContain(":(glob)**");
  expect(fs.readFileSync(path.join(dir, "custom-output", "result.txt"), "utf8")).toBe("generated\n");
});

test("B: byte-bound refusal is unchanged after a real process restart", async () => {
  const dir = folder();
  const previous = process.env.LLV_PIPELINE_INIT_MAX_BYTES;
  process.env.LLV_PIPELINE_INIT_MAX_BYTES = "1";
  try {
    const result = await admit(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("size bound");
    const child = Bun.spawn([process.execPath, "-e", 'const {defaultPipelinePorts}=await import("./src/lib/pipelines/engine"); console.log(JSON.stringify(await defaultPipelinePorts().preflightRepo(process.argv[1])));', dir], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("size bound") });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_PIPELINE_INIT_MAX_BYTES;
    else process.env.LLV_PIPELINE_INIT_MAX_BYTES = previous;
  }
});

test("B: a symlink to state and existing foreign Git metadata are refused", async () => {
  const linked = path.join(root, "state-link");
  fs.symlinkSync(process.env.LLV_STATE_DIR!, linked, "dir");
  const result = await admit(linked);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.detail).toContain("state directory");
  const dir = folder();
  fs.writeFileSync(path.join(dir, ".git"), "foreign metadata\n");
  expect((await admit(dir)).ok).toBe(false);
  expect(fs.readFileSync(path.join(dir, ".git"), "utf8")).toBe("foreign metadata\n");
  expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
});

test("B: inherited author, hooks and templates cannot affect the baseline commit", async () => {
  const dir = folder();
  const foreign = folder();
  const hooks = path.join(foreign, "hooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 77\n", { mode: 0o755 });
  const settings = { GIT_AUTHOR_NAME: "Foreign fixture", GIT_COMMITTER_NAME: "Foreign fixture", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks, GIT_TEMPLATE_DIR: foreign };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    expect((await admit(dir)).ok).toBe(true);
    expect(git(dir, "show", "-s", "--format=%an|%cn")).toBe("Delegatus|Delegatus");
    expect(fs.readFileSync(path.join(hooks, "pre-commit"), "utf8")).toContain("exit 77");
    expect(fs.existsSync(path.join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("A/C: concurrent creators and a restarted process reuse the one initial commit and report", async () => {
  const dir = folder();
  const results = await Promise.all([admit(dir), admit(dir)]);
  expect(results.every(result => result.ok)).toBe(true);
  const head = git(dir, "rev-parse", "HEAD");
  const child = Bun.spawn([process.execPath, "-e", 'const {defaultPipelinePorts}=await import("./src/lib/pipelines/engine"); console.log(JSON.stringify(await defaultPipelinePorts().preflightRepo(process.argv[1])));', dir], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ ok: true, repositoryInitialization: { commit: head } });
  expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  expect(readBridgeReportLog().reports.filter(report => report.project === localRepositoryProjectId(dir))).toHaveLength(1);
});

test("C: both a fresh succession write and a receipt replay yield to a peer-held state writer", async () => {
  await admit(folder());
  for (const replay of [false, true]) {
    const dir = folder();
    if (replay) expect((await admit(dir)).ok).toBe(true);
    const ready = path.join(dir, "peer-ready");
    const child = Bun.spawn([process.execPath, "src/lib/state/lockWait.fixture.ts", "hold", path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), ready, "unused", "500"], { env: process.env, stdout: "ignore", stderr: "pipe" });
    try {
      while (!fs.existsSync(ready)) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        await Bun.sleep(5);
      }
      let advanced = false;
      const timer = setTimeout(() => { advanced = true; }, 20);
      try { expect((await admit(dir)).ok).toBe(true); expect(advanced).toBe(true); }
      finally { clearTimeout(timer); }
      expect(await child.exited).toBe(0);
    } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  }
});

test("B: existing linked worktrees retain their repository and receive no initialization receipt", async () => {
  const dir = folder();
  expect((await admit(dir)).ok).toBe(true);
  const linked = path.join(root, "existing-linked-worktree");
  git(dir, "worktree", "add", "-b", "linked", linked);
  const result = await admit(linked);
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain("repositoryInitialization");
  expect(git(linked, "branch", "--show-current")).toBe("linked");
});

test("B: a file changed after its snapshot is refused before installation", async () => {
  const dir = folder();
  const target = path.join(dir, "readme.txt");
  const original = fsAsync.open.bind(fsAsync);
  let changed = false;
  const hook = spyOn(fsAsync, "open").mockImplementation(async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (args[0] === target && !changed) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); changed = true; fs.writeFileSync(target, "changed after inspection\n"); };
    }
    return handle;
  });
  try {
    const result = await admit(dir);
    expect(changed).toBe(true);
    expect(result).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("changed") });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("changed after inspection\n");
  } finally { hook.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("B: swapping the project for a state symlink during install never writes into state", async () => {
  const dir = folder();
  const moved = dir + "-moved";
  const original = fsAsync.writeFile.bind(fsAsync);
  let movedRoot = false;
  const hook = spyOn(fsAsync, "writeFile").mockImplementation(async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    const name = String(args[0]);
    if (!movedRoot && name.startsWith("/proc/self/fd/") && name.endsWith("/.gitignore")) {
      fs.renameSync(dir, moved);
      fs.symlinkSync(process.env.LLV_STATE_DIR!, dir, "dir");
      movedRoot = true;
    }
    return result;
  });
  try {
    const result = await admit(dir);
    expect(movedRoot).toBe(true);
    expect(result).toMatchObject({ ok: false, code: "initialization_refused" });
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(moved, ".git"))).toBe(false);
  } finally { hook.mockRestore(); }
});

test("B: a secret-bearing filename never enters generated ignore rules or a response", async () => {
  const dir = folder();
  const value = ["gh", "p_", "b".repeat(36)].join("");
  fs.writeFileSync(path.join(dir, value + ".txt"), "fixture\n");
  const result = await admit(dir);
  expect(result).toMatchObject({ ok: false, code: "initialization_refused" });
  expect(JSON.stringify(result)).not.toContain(value);
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
});

test.each(["link", "encoding", "secret"] as const)("B: an unsafe existing gitignore is preserved: %s", async kind => {
  const dir = folder();
  const ignore = path.join(dir, ".gitignore");
  const target = path.join(dir, "original.txt");
  fs.writeFileSync(target, "original rules\n");
  const value = ["gh", "p_", "c".repeat(36)].join("");
  if (kind === "link") fs.symlinkSync(target, ignore);
  else fs.writeFileSync(ignore, kind === "encoding" ? Buffer.from("rules\n", "utf16le") : value);
  const before = fs.readFileSync(ignore);
  const result = await admit(dir);
  expect(result).toMatchObject({ ok: false, code: "initialization_refused" });
  expect(fs.readFileSync(ignore)).toEqual(before);
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  expect(JSON.stringify(result)).not.toContain(value);
});

test.each(["0", "invalid", "1.5"])("B: invalid initialization bounds are refused: %s", async value => {
  const dir = folder();
  const previous = process.env.LLV_PIPELINE_INIT_MAX_FILES;
  process.env.LLV_PIPELINE_INIT_MAX_FILES = value;
  try {
    expect(await admit(dir)).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("limit") });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_PIPELINE_INIT_MAX_FILES; else process.env.LLV_PIPELINE_INIT_MAX_FILES = previous;
  }
});

test("B: an oversized path inventory is refused before any project mutation", async () => {
  const dir = folder();
  for (let index = 0; index < 20; index++) fs.writeFileSync(path.join(dir, String(index).padStart(2, "0") + "a".repeat(220)), "fixture\n");
  const result = await admit(dir);
  expect(result).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("path-list bound") });
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
});

test.each(["LLV_PIPELINE_INIT_MAX_FILES", "LLV_PIPELINE_INIT_MAX_BYTES", "LLV_PIPELINE_INIT_MAX_FILE_BYTES"] as const)("B: generated ignore data also counts toward %s", async name => {
  const dir = folder();
  const previous = process.env[name];
  process.env[name] = name.endsWith("FILES") ? "1" : String(fs.statSync(path.join(dir, "readme.txt")).size);
  try {
    expect(await admit(dir)).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("bound") });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});

test("B: nested negations cannot re-admit excluded files on a later git add", async () => {
  const dir = folder();
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", ".gitignore"), "!private.txt\n!large.bin\n");
  fs.writeFileSync(path.join(dir, "nested", "private.txt"), ["gh", "p_", "d".repeat(36)].join(""));
  fs.writeFileSync(path.join(dir, "nested", "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
  expect((await admit(dir)).ok).toBe(true);
  git(dir, "add", "--all");
  expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
});

test.each(["secret", "large", "ignored"])("B: an unmergeable nested gitignore refuses initialization: %s", async kind => {
  const dir = folder();
  fs.mkdirSync(path.join(dir, "nested"));
  const privateFixture = ["gh", "p_", "e".repeat(36)].join("");
  const contents = kind === "secret" ? privateFixture : kind === "large" ? "#".repeat(2 * 1024 * 1024 + 1) : "!private.txt\n";
  fs.writeFileSync(path.join(dir, "nested", ".gitignore"), contents);
  if (kind === "ignored") fs.writeFileSync(path.join(dir, ".gitignore"), "nested/.gitignore\n");
  const result = await admit(dir);
  expect(result).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("gitignore") });
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  expect(fs.readFileSync(path.join(dir, "nested", ".gitignore"), "utf8")).toBe(contents);
});
