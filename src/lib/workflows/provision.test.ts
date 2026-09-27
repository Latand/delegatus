import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wf-prov-test-"));
const { buildWorkflow, normalizeTemplate, setupStdoutPath, workflowArtifactsDir } = await import("./store");
const { finishMerge, finishPr, provisionWorktree, prTitle, realExec, runFinish, setupStatus, startSetup } = await import("./provision");

type Workflow = import("./types").Workflow;
type ExecResult = import("./provision").ExecResult;
type ExecPort = import("./provision").ExecPort;

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wf-prov-repo-"));

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const TEMPLATE = normalizeTemplate({
  name: "demo",
  setup: "true",
  stages: [
    { kind: "implement", agent: { engine: "codex", model: null, effort: "low" }, scope: "all" },
    { kind: "review-loop", reviewer: { engine: "codex", model: null, effort: "low" } },
  ],
})!;

function makeWorkflow(repoDir: string, overrides: Partial<Workflow> = {}): Workflow {
  const wf = buildWorkflow({
    id: "wfid1234",
    name: "demo",
    task: "Add a greeting file",
    project: "repo",
    repoDir,
    template: TEMPLATE,
    mode: "auto",
    now: "2026-07-05T00:00:00.000Z",
  });
  return { ...wf, ...overrides };
}

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

/** Fake exec that records calls and answers from a script keyed by subcommand. */
function fakeExec(script: (call: Call) => ExecResult): { exec: (c: string, a: string[], d: string) => ExecResult; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: (command, args, cwd) => {
      const call = { command, args, cwd };
      calls.push(call);
      return script(call);
    },
  };
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

/** Throwaway real repo with one commit on branch main. */
function makeRepo(): string {
  const repoDir = fs.mkdtempSync(path.join(SANDBOX, "repo-"));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.email", "test@example.com");
  git(repoDir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "init");
  return repoDir;
}

function makeIdentityIsolatedRepo() {
  const root = fs.mkdtempSync(path.join(SANDBOX, "identity-"));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const repo = path.join(root, "repo");
  for (const directory of [home, xdg, repo]) fs.mkdirSync(directory);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:AUTHOR_|COMMITTER_|CONFIG_)/.test(key)) delete env[key];
  }
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") });
  const exec: ExecPort = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
  };
  const run = (...args: string[]) => {
    const result = exec("git", args, repo);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  run("init", "--initial-branch=main");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("add", "base.txt");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "base");
  const wf = makeWorkflow(repo, { baseBranch: "main" });
  run("switch", "-c", wf.branch);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  run("add", "feature.txt");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "feature");
  run("switch", "main");
  return { repo, exec, run, wf };
}

test("provisionWorktree composes worktree add and captures base branch/ref", () => {
  const wf = makeWorkflow("/repo");
  const { exec, calls } = fakeExec((call) => {
    if (call.args[0] === "rev-parse" && call.args[1] === "--abbrev-ref") return ok("main\n");
    if (call.args[0] === "worktree") return ok();
    if (call.args[0] === "rev-parse") return ok("abc123\n");
    return fail("unexpected");
  });
  const res = provisionWorktree(wf, exec);
  if (!res.ok) throw new Error(res.error);
  expect(res.baseBranch).toBe("main");
  expect(res.baseRef).toBe("abc123");
  expect(calls[1]).toEqual({
    command: "git",
    args: ["worktree", "add", "-b", wf.branch, wf.worktreeDir, "HEAD"],
    cwd: "/repo",
  });
  expect(calls[2]?.cwd).toBe(wf.worktreeDir);
});

test("provisionWorktree maps a detached checkout to an error", () => {
  const wf = makeWorkflow("/repo");
  const { exec } = fakeExec(() => ok("HEAD\n"));
  const res = provisionWorktree(wf, exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("detached");
});

test("provisionWorktree adopts an already-created worktree on retry", () => {
  const wf = makeWorkflow("/repo");
  const { exec } = fakeExec((call) => {
    if (call.args[0] === "worktree") return fail(`fatal: '${wf.worktreeDir}' already exists`);
    if (call.args[1] === "--abbrev-ref") return ok(call.cwd === wf.worktreeDir ? wf.branch + "\n" : "main\n");
    return ok("abc123\n");
  });
  const res = provisionWorktree(wf, exec);
  expect(res.ok).toBe(true);
});

test("provisionWorktree surfaces the add error when nothing usable exists", () => {
  const wf = makeWorkflow("/repo");
  const { exec } = fakeExec((call) => {
    if (call.args[0] === "worktree") return fail("fatal: disk exploded");
    if (call.cwd === wf.worktreeDir) return fail("not a git repo");
    return ok("main\n");
  });
  const res = provisionWorktree(wf, exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("disk exploded");
});

test("finishPr pushes the branch then opens the PR against the base branch", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec, calls } = fakeExec((call) =>
    call.command === "gh" ? ok("https://github.com/o/r/pull/7\n") : ok(),
  );
  const res = finishPr(wf, "PR BODY", exec);
  if (!res.ok) throw new Error(res.error);
  expect(res.prUrl).toBe("https://github.com/o/r/pull/7");
  expect(calls[0]).toEqual({ command: "git", args: ["push", "-u", "origin", wf.branch], cwd: wf.worktreeDir });
  expect(calls[1]).toEqual({
    command: "gh",
    args: ["pr", "create", "--title", prTitle(wf), "--body", "PR BODY", "--base", "main", "--head", wf.branch],
    cwd: wf.worktreeDir,
  });
});

test("finishPr recovers the URL of a PR that already exists", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec } = fakeExec((call) => {
    if (call.command === "gh" && call.args[1] === "create") return fail("a pull request already exists");
    if (call.command === "gh" && call.args[1] === "view") return ok("https://github.com/o/r/pull/7\n");
    return ok();
  });
  const res = finishPr(wf, "body", exec);
  expect(res.ok && res.prUrl).toBe("https://github.com/o/r/pull/7");
});

test("finishPr maps a rejected push to an error", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec } = fakeExec((call) => (call.args[0] === "push" ? fail("rejected: no upstream") : ok()));
  const res = finishPr(wf, "body", exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("rejected");
});

test("runFinish refuses a dirty worktree before any push, gh or merge runs", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec, calls } = fakeExec((call) => {
    if (call.args[0] === "status") return ok(" M src/app.ts\n?? notes.txt\n M a.ts\n M b.ts\n");
    return ok();
  });
  const res = runFinish(wf, "body", exec);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error).toContain("uncommitted changes");
    expect(res.error).toContain("src/app.ts");
    expect(res.error).toContain("+1 more");
  }
  /* The guard ran alone: nothing was pushed, created or merged. */
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual({ command: "git", args: ["status", "--porcelain"], cwd: wf.worktreeDir });
});

test("runFinish delegates to the finish action once the worktree is clean", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec, calls } = fakeExec((call) =>
    call.command === "gh" ? ok("https://github.com/o/r/pull/7\n") : ok(),
  );
  const res = runFinish(wf, "body", exec);
  expect(res.ok && res.prUrl).toBe("https://github.com/o/r/pull/7");
  expect(calls[0]?.args).toEqual(["status", "--porcelain"]);
  expect(calls[1]?.args[0]).toBe("push");
});

test("finishMerge refuses when the repo checkout left the base branch", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec } = fakeExec(() => ok("feature/elsewhere\n"));
  const res = finishMerge(wf, exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("feature/elsewhere");
});

test("finishMerge aborts and surfaces a merge conflict", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec, calls } = fakeExec((call) => {
    if (call.args[1] === "--abbrev-ref") return ok("main\n");
    if (call.args[0] === "merge" && call.args[1] === "--no-ff") return fail("CONFLICT (content): README.md");
    return ok();
  });
  const res = finishMerge(wf, exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("CONFLICT");
  expect(calls.at(-1)?.args).toEqual(["merge", "--abort"]);
});

test("finishMerge supplies a controller identity when Git has none", () => {
  const box = makeIdentityIsolatedRepo();
  expect(box.exec("git", ["var", "GIT_AUTHOR_IDENT"], box.repo).code).not.toBe(0);
  expect(box.exec("git", ["var", "GIT_COMMITTER_IDENT"], box.repo).code).not.toBe(0);

  expect(finishMerge(box.wf, box.exec).ok).toBe(true);
  const fallbackEmail = ["noreply", "delegatus.invalid"].join("@");
  expect(box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce")).toBe(
    ["Delegatus", fallbackEmail, "Delegatus", fallbackEmail].join("\n"),
  );
  expect(box.exec("git", ["config", "--local", "--get", "user.name"], box.repo).code).not.toBe(0);
  expect(box.exec("git", ["config", "--local", "--get", "user.email"], box.repo).code).not.toBe(0);
});

test("finishMerge keeps the identity configured for its repository", () => {
  const box = makeIdentityIsolatedRepo();
  const email = ["configured", "example.invalid"].join("@");
  box.run("config", "--local", "user.name", "Configured Test");
  box.run("config", "--local", "user.email", email);

  expect(finishMerge(box.wf, box.exec).ok).toBe(true);
  expect(box.run("log", "-1", "--format=%an%n%ae%n%cn%n%ce")).toBe(
    ["Configured Test", email, "Configured Test", email].join("\n"),
  );
});

test("integration: provision + commit + local merge against a throwaway repo", async () => {
  const repoDir = makeRepo();
  let wf = makeWorkflow(repoDir, { template: { ...TEMPLATE, finish: "merge" as const } });
  const res = provisionWorktree(wf, realExec);
  if (!res.ok) throw new Error(res.error);
  wf = { ...wf, baseBranch: res.baseBranch, baseRef: res.baseRef };
  expect(res.baseBranch).toBe("main");
  expect(fs.existsSync(path.join(wf.worktreeDir, "README.md"))).toBe(true);

  /* The detached setup command runs in the worktree and reports done. */
  const setup = startSetup(wf);
  expect(setup.pid).toBeGreaterThan(0);
  wf = { ...wf, setupPid: setup.pid };
  for (let i = 0; i < 100 && setupStatus(wf).status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(setupStatus(wf).status).toBe("done");

  fs.writeFileSync(path.join(wf.worktreeDir, "greeting.txt"), "hi\n");

  /* Uncommitted work blocks the finish: the review approved more than the
     branch carries. */
  const blocked = runFinish(wf, "body", realExec);
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.error).toContain("greeting.txt");

  git(wf.worktreeDir, "add", ".");
  git(wf.worktreeDir, "commit", "-m", "add greeting");

  const merged = runFinish(wf, "body", realExec);
  if (!merged.ok) throw new Error(merged.error);
  expect(fs.existsSync(path.join(repoDir, "greeting.txt"))).toBe(true);
});

test("integration: a failing setup reports the exit code and stderr tail", async () => {
  const repoDir = makeRepo();
  const failing = normalizeTemplate({ ...TEMPLATE, setup: "echo boom >&2; exit 3" })!;
  let wf = { ...makeWorkflow(repoDir), id: "wfid9999", template: failing };
  wf = { ...wf, worktreeDir: path.join(path.dirname(repoDir), path.basename(repoDir) + "-wf-" + wf.id) };
  const res = provisionWorktree(wf, realExec);
  if (!res.ok) throw new Error(res.error);
  wf = { ...wf, setupPid: startSetup(wf).pid };
  for (let i = 0; i < 100 && setupStatus(wf).status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = setupStatus(wf);
  expect(status.status).toBe("failed");
  expect(status.detail).toContain("code 3");
  expect(status.detail).toContain("boom");
});

test("a launched setup with no exit code stays running until the settle window passes, then reads interrupted", () => {
  const wf = { ...makeWorkflow(SANDBOX), id: "wfsettle-" + process.pid };
  fs.mkdirSync(workflowArtifactsDir(wf.id), { recursive: true });
  fs.writeFileSync(setupStdoutPath(wf.id), ""); // the launch artifact, no exit-code file
  const launchedAt = fs.statSync(setupStdoutPath(wf.id)).mtimeMs;
  const dead = { ...wf, setupPid: 0x7fffffff }; // an implausible pid — never alive

  try {
    /* Right after launch a pid that is not yet observable must not be mistaken
       for an interruption — this is the race the integration polls above hit. */
    expect(setupStatus(dead, launchedAt + 500).status).toBe("running");

    /* Long after launch with still no exit code, it is a real interruption. */
    const stale = setupStatus(dead, launchedAt + 60_000);
    expect(stale.status).toBe("failed");
    expect(stale.detail).toContain("interrupted");
  } finally {
    fs.rmSync(workflowArtifactsDir(wf.id), { recursive: true, force: true });
  }
});
