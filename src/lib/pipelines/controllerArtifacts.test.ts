import { afterAll, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { composeStructuredFirstMessage } from "@/lib/runtime/structuredFirstMessage";
import { CONTROLLER_ARTIFACT_DIRECTORY, prepareControllerArtifactDirectory } from "./controllerArtifacts";
import { realExec, type ExecResult } from "@/lib/workflows/provision";
import { renderStagePrompt } from "./prompts";
import { resolveStageTestGuidance } from "./testGuidance";
import { composeStageInput } from "./stageInput";
import { buildPipeline } from "./store";
import type { PipelineStage } from "./types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-controller-artifacts-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("artifact inspection retries a probe with a null exit status before preparing a handoff", async () => {
  const { repo } = repository("transient-signal");
  let probes = 0;
  let loopTurn = false;
  const directory = await prepareControllerArtifactDirectory(repo, async (command, args, ...rest) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && ++probes === 1) {
      setTimeout(() => { loopTurn = true; }, 0);
      return { code: null, signal: "SIGTERM", stdout: "", stderr: "" };
    }
    expect(loopTurn).toBe(true);
    return realExec(command, args, ...rest);
  });
  expect(probes).toBe(2);
  expect(fs.readFileSync(path.join(directory, ".gitignore"), "utf8")).toBe("*\n");
});

function clock() {
  let elapsed = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => elapsed,
    advance: (ms: number) => { elapsed += ms; },
    sleep: async (ms: number) => { waits.push(ms); elapsed += ms; },
  };
}

const probeFailures: { name: string; result?: ExecResult; error?: NodeJS.ErrnoException; cause: string }[] = [
  { name: "signal", result: { code: null, signal: "SIGTERM", stdout: "", stderr: "" }, cause: "signal SIGTERM" },
  { name: "timeout", result: { code: null, signal: "SIGKILL", stdout: "", stderr: "command timed out after 10000ms" }, cause: "command timed out after 10000ms" },
  { name: "spawn-result", result: { code: null, stdout: "", stderr: "spawn git EAGAIN" }, cause: "spawn git EAGAIN" },
  { name: "spawn-throw", error: Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" }), cause: "EAGAIN: resource temporarily unavailable" },
  { name: "unknown", result: { code: null, stdout: "", stderr: "" }, cause: "no exit status" },
];

test.each(probeFailures)("artifact inspection recovers from $name without replaying earlier probes", async ({ name, result, error }) => {
  const { repo } = repository(`recover-${name}`);
  const timing = clock();
  let top = 0, head = 0;
  const directory = await prepareControllerArtifactDirectory(repo, async (command, args, ...rest) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") top++;
    if (args[0] === "rev-parse" && args[1] === "--verify" && ++head === 1) {
      if (error) throw error;
      return result!;
    }
    return realExec(command, args, ...rest);
  }, timing);
  expect(top).toBe(1);
  expect(head).toBe(2);
  expect(timing.waits).toEqual([250]);
  expect(fs.readFileSync(path.join(directory, ".gitignore"), "utf8")).toBe("*\n");
});

test.each(probeFailures)("artifact inspection refuses persistent $name after three attempts with its cause", async ({ name, result, error, cause }) => {
  const { repo, git } = repository(`exhaust-${name}`);
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  const timing = clock();
  let probes = 0;
  const failure = await prepareControllerArtifactDirectory(repo, async () => {
    probes++;
    if (error) throw error;
    return result!;
  }, timing).then(() => null, (error: Error) => error);
  expect(failure?.message).toContain(cause);
  expect(failure?.message).toContain("git rev-parse, attempt 3");
  expect(probes).toBe(3);
  expect(timing.waits).toEqual([250, 500]);
  expect(fs.existsSync(path.join(repo, ".artifacts"))).toBe(false);
  expect(git("show", ":source.txt")).toBe("staged source");
});

test("all artifact probes share one deadline including backoff and earlier successful probes", async () => {
  const { repo } = repository("inspection-deadline");
  const timing = clock();
  const timeouts: number[] = [];
  const signals: AbortSignal[] = [];
  const failure = await prepareControllerArtifactDirectory(repo, async (_command, args, _cwd, _env, options) => {
    timeouts.push(options!.timeoutMs!);
    signals.push(options!.signal!);
    timing.advance(options!.timeoutMs!);
    if (args[1] === "--show-toplevel") return { code: 0, stdout: `${repo}\n`, stderr: "" };
    return { code: null, signal: "SIGKILL", stdout: "", stderr: `command timed out after ${options!.timeoutMs}ms` };
  }, timing).then(() => null, (error: Error) => error);
  expect(failure?.message).toContain("30000ms inspection deadline exceeded");
  expect(failure?.message).toContain("signal SIGKILL: command timed out after 9750ms");
  expect(timeouts).toEqual([10_000, 10_000, 9750]);
  expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true);
  expect(timing.waits).toEqual([250]);
  expect(timing.now()).toBe(30_000);
  expect(fs.existsSync(path.join(repo, ".artifacts"))).toBe(false);
});

test("artifact backoff cannot dispatch a retry beyond the inspection deadline", async () => {
  const { repo } = repository("backoff-deadline");
  const timing = clock();
  let probes = 0;
  const failure = await prepareControllerArtifactDirectory(repo, async () => {
    probes++;
    timing.advance(29_900);
    return { code: null, signal: "SIGTERM", stdout: "", stderr: "" };
  }, timing).then(() => null, (error: Error) => error);
  expect(failure?.message).toContain("30000ms inspection deadline exceeded: signal SIGTERM");
  expect(probes).toBe(1);
  expect(timing.waits).toEqual([100]);
  expect(timing.now()).toBe(30_000);
});

test.each([
  { name: "git-error", code: 128, stderr: "fatal: corrupt Git index", cause: "exit code 128: fatal: corrupt Git index" },
  { name: "output-limit", code: null, stderr: "command output exceeded its byte limit", cause: "command output exceeded its byte limit" },
  { name: "cancelled", code: null, stderr: "command cancelled", cause: "command cancelled" },
  { name: "missing-git", code: null, stderr: "spawn git ENOENT", cause: "spawn git ENOENT" },
])("artifact inspection immediately refuses $name with the original diagnostic", async ({ name, code, stderr, cause }) => {
  const { repo } = repository(`permanent-${name}`);
  const timing = clock();
  let probes = 0;
  await expect(prepareControllerArtifactDirectory(repo, async () => {
    probes++;
    return { code, stdout: "", stderr };
  }, timing)).rejects.toThrow(cause);
  expect(probes).toBe(1);
  expect(timing.waits).toEqual([]);
  expect(fs.existsSync(path.join(repo, ".artifacts"))).toBe(false);
});

test("a real broken Git repository refuses with its stderr and exit code", async () => {
  const { repo } = repository("real-git-error");
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "broken\n");
  const result = await realExec("git", ["rev-parse", "--show-toplevel"], repo);
  expect(result.code).toBe(128);
  expect(result.stderr).toContain("fatal:");
  await expect(prepareControllerArtifactDirectory(repo)).rejects.toThrow(`exit code 128: ${result.stderr.trim()}`);
});

test.each([{ unborn: false }, { unborn: true }])("an interrupted index write is refused without replay (unborn=$unborn)", async ({ unborn }) => {
  const { repo, git } = repository(`no-write-replay-${unborn}`, unborn);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "old.md"), "private staged input\n");
  git("add", "-A");
  let writes = 0;
  const timing = clock();
  await expect(prepareControllerArtifactDirectory(repo, async (command, args, ...rest) => {
    if (args[0] === (unborn ? "rm" : "reset")) {
      writes++;
      return { code: null, signal: "SIGTERM", stdout: "", stderr: "" };
    }
    return realExec(command, args, ...rest);
  }, timing)).rejects.toThrow("signal SIGTERM");
  expect(writes).toBe(1);
  expect(timing.waits).toEqual([]);
  expect(git("diff", "--cached", "--name-only")).toContain("old.md");
});

test("artifact retries recheck repository ancestors before creating files", async () => {
  const { repo } = repository("retry-ancestor");
  const external = path.join(root, "retry-ancestor-external");
  fs.mkdirSync(external);
  const timing = clock();
  await expect(prepareControllerArtifactDirectory(repo, async (command, args, ...rest) => {
    if (!timing.waits.length) return { code: null, signal: "SIGTERM", stdout: "", stderr: "" };
    return realExec(command, args, ...rest);
  }, { ...timing, sleep: async (ms) => {
    await timing.sleep(ms);
    fs.symlinkSync(external, path.join(repo, ".artifacts"), "dir");
  } })).rejects.toThrow("pipeline controller artifact path must be a real directory");
  expect(fs.readdirSync(external)).toEqual([]);
});

test("fresh processes each exhaust a bounded artifact inspection without creating retry work", async () => {
  const { repo } = repository("restart-bounds");
  const childRoot = path.join(root, "probe-child");
  const env: NodeJS.ProcessEnv = { ...process.env, LLV_STATE_OWNER: undefined, LLV_INBOX_DIR: undefined, DELEGATUS_STATE_DIR: undefined };
  for (const name of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
    const directory = path.join(childRoot, name.toLowerCase());
    fs.mkdirSync(directory, { recursive: true });
    env[name] = directory;
  }
  const source = `
    import { prepareControllerArtifactDirectory, protectExistingControllerArtifacts } from "./src/lib/pipelines/controllerArtifacts";
    let probes = 0, at = 0;
    const inspect = process.argv[2] === "prepare" ? prepareControllerArtifactDirectory : protectExistingControllerArtifacts;
    try {
      await inspect(process.argv[1], async () => { probes++; return { code: null, signal: "SIGTERM", stdout: "", stderr: "" }; },
        { now: () => at, sleep: async ms => { at += ms; } });
    } catch (error) { console.log(JSON.stringify({ probes, at, error: error.message })); }
  `;
  for (const entry of ["prepare", "protect"]) {
    for (let restart = 0; restart < 2; restart++) {
      const result = await promisify(execFile)(process.execPath, ["-e", source, repo, entry], {
        cwd: path.resolve(import.meta.dir, "../../.."), env, timeout: 10_000,
      });
      expect(JSON.parse(result.stdout)).toEqual({ probes: 3, at: 750,
        error: "cannot inspect controller artifact Git paths (git rev-parse, attempt 3): signal SIGTERM" });
    }
  }
  expect(fs.existsSync(path.join(repo, ".artifacts"))).toBe(false);
  expect(fs.readdirSync(env.LLV_STATE_DIR!)).toEqual([]);
});

function repository(name: string, unborn = false) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.invalid");
  git("config", "commit.gpgSign", "false");
  if (!unborn) {
    fs.writeFileSync(path.join(repo, "source.txt"), "base\n");
    git("add", "source.txt");
    git("commit", "-m", "base");
  }
  return { repo, git };
}

async function compose(kind: "structured" | "pipeline", cwd: string, exec: typeof realExec = realExec) {
  const text = "PRIVATE_INPUT_SENTINEL\n" + "Full context 🙂\n".repeat(3_000);
  if (kind === "structured") {
    return { text, delivered: (await composeStructuredFirstMessage(text, cwd, exec)) };
  }
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "{{task}}".repeat(100), next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Complete builder instructions" } };
  const pipeline = buildPipeline({ id: "private-index", task: "t".repeat(500), spec: "AC", project: "fixture", repoDir: cwd,
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = cwd;
  return { text: renderStagePrompt(pipeline, stage, stage.effectiveRole, text, undefined, resolveStageTestGuidance()), delivered: (await composeStageInput(pipeline, stage, stage.effectiveRole, text, cwd, exec)) };
}

async function composeSmall(kind: "structured" | "pipeline", cwd: string, exec: typeof realExec = realExec) {
  if (kind === "structured") return (await composeStructuredFirstMessage("small message", cwd, exec));
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Build", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: null } };
  const pipeline = buildPipeline({ id: "small-index", task: "Small task", project: "fixture", repoDir: cwd,
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = cwd;
  const delivered = (await composeStageInput(pipeline, stage, stage.effectiveRole, "", cwd, exec));
  expect(delivered).toBe(renderStagePrompt(pipeline, stage, stage.effectiveRole, "", undefined, resolveStageTestGuidance()));
  return delivered;
}

test.each([
  { kind: "structured", small: true }, { kind: "pipeline", small: true },
  { kind: "structured", small: false }, { kind: "pipeline", small: false },
] as const)("$kind launch composition survives a transient Git signal (small=$small)", async ({ kind, small }) => {
  const { repo } = repository(`launch-retry-${kind}-${small}`);
  let probes = 0;
  const exec: typeof realExec = async (command, args, ...rest) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && ++probes === 1) {
      return { code: null, signal: "SIGTERM", stdout: "", stderr: "" };
    }
    return realExec(command, args, ...rest);
  };
  const result = small ? await composeSmall(kind, repo, exec) : await compose(kind, repo, exec);
  expect(probes).toBe(2);
  if (typeof result === "string") expect(result.length).toBeGreaterThan(0);
  else {
    const file = result.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
    expect(fs.readFileSync(file!, "utf8")).toBe(result.text);
  }
});

test.each([
  { kind: "structured", nested: false, unborn: false },
  { kind: "pipeline", nested: false, unborn: false },
  { kind: "structured", nested: true, unborn: false },
  { kind: "pipeline", nested: true, unborn: false },
  { kind: "structured", nested: false, unborn: true },
  { kind: "pipeline", nested: false, unborn: true },
] as const)("$kind composition protects pre-staged handoffs from ordinary worker commits (nested=$nested, unborn=$unborn)", async ({ kind, nested, unborn }) => {
  const { repo, git } = repository(`staged-${kind}-${nested}-${unborn}`, unborn);
  const cwd = nested ? path.join(repo, "package[worker]") : repo;
  const directory = path.join(cwd, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const oldFile = path.join(directory, "old-private-input.md");
  const oldText = "PRIVATE_STAGED_SENTINEL\n" + "Prior handoff\n".repeat(3_000);
  fs.writeFileSync(oldFile, oldText);
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "-A");
  fs.writeFileSync(path.join(repo, "source.txt"), "unstaged source\n");
  expect(git("diff", "--cached", "--name-only")).toContain("old-private-input.md");

  const { text, delivered } = (await compose(kind, cwd));
  expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(32_000);
  const file = delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toBe(text);
  expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  expect(git("show", ":source.txt")).toBe("staged source");
  expect(fs.readFileSync(path.join(repo, "source.txt"), "utf8")).toBe("unstaged source\n");
  expect(fs.readFileSync(oldFile, "utf8")).toBe(oldText);
  git("add", "-A");
  git("commit", "-m", "ordinary worker change");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_STAGED_SENTINEL");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_INPUT_SENTINEL");
});

test("a tracked controller ignore file remains tracked while private staged inputs are removed", async () => {
  const { repo, git } = repository("tracked-ignore");
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, ".gitignore"), "!*.md\n");
  git("add", "-A");
  git("commit", "-m", "controller ignore");
  fs.writeFileSync(path.join(directory, "old.md"), "PRIVATE_STAGED_SENTINEL\n");
  git("add", "-A");
  (await compose("structured", repo));
  expect(git("diff", "--cached", "--name-only")).toBe("");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-files", "--", CONTROLLER_ARTIFACT_DIRECTORY)).toBe(`${CONTROLLER_ARTIFACT_DIRECTORY}/.gitignore`);
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_STAGED_SENTINEL");
});

test.each([
  { kind: "structured", layout: "root" }, { kind: "pipeline", layout: "root" },
  { kind: "structured", layout: "nested" }, { kind: "pipeline", layout: "nested" },
  { kind: "structured", layout: "linked" }, { kind: "pipeline", layout: "linked" },
] as const)("$kind handoffs stay private after restoring the tracked ignore before worker commit (layout=$layout)", async ({ kind, layout }) => {
  const base = repository(`restore-ignore-${kind}-${layout}`);
  let repo = base.repo;
  let git = base.git;
  if (layout === "linked") {
    repo = path.join(root, `linked-${kind}`);
    base.git("worktree", "add", "-b", "worker", repo);
    git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    };
  }
  const cwd = layout === "nested" ? path.join(repo, "package[worker]") : repo;
  const ignore = path.relative(repo, path.join(cwd, CONTROLLER_ARTIFACT_DIRECTORY, ".gitignore"));
  fs.mkdirSync(path.dirname(path.join(repo, ignore)), { recursive: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "!*/\n!*.md\n");
  fs.writeFileSync(path.join(repo, ignore), "!*.md\n");
  git("add", "-A");
  git("commit", "-m", "controller ignore");
  const before = git("rev-parse", "HEAD");

  const legacy = path.join(cwd, CONTROLLER_ARTIFACT_DIRECTORY, "previous-output-old.md");
  const legacyText = "PRIVATE_LEGACY_SENTINEL\n" + "Prior private input\n".repeat(3_000);
  fs.writeFileSync(legacy, legacyText);
  git("add", "-A");

  const { text, delivered } = (await compose(kind, cwd));
  const file = delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(32_000);
  expect(fs.readFileSync(file!, "utf8")).toBe(text);
  git("restore", "--", ignore);
  expect(fs.readFileSync(path.join(repo, ignore), "utf8")).toBe("!*.md\n");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "ordinary worker change before settlement");

  expect(git("diff", "--name-only", before, "HEAD")).toBe("source.txt");
  expect(git("ls-files", "--", path.relative(repo, path.join(cwd, CONTROLLER_ARTIFACT_DIRECTORY)))).toBe(ignore);
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_INPUT_SENTINEL");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_LEGACY_SENTINEL");
  expect(git("show", "HEAD:source.txt")).toBe("worker result");
  expect(fs.readFileSync(file!, "utf8")).toBe(text);
  expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
});

test.each([
  { kind: "structured", link: "directory symlink" }, { kind: "pipeline", link: "directory symlink" },
  { kind: "structured", link: "ignore symlink" }, { kind: "pipeline", link: "ignore symlink" },
  { kind: "structured", link: "ignore hardlink" }, { kind: "pipeline", link: "ignore hardlink" },
] as const)("$kind composition refuses a private $link without modifying external JSON", async ({ kind, link }) => {
  const { repo, git } = repository(`private-link-${kind}-${link.replaceAll(" ", "-")}`);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY, "private");
  const external = path.join(root, `external-${kind}-${link.replaceAll(" ", "-")}`);
  fs.mkdirSync(external);
  const target = path.join(external, ".gitignore");
  const original = '{"enabled":true}\n';
  fs.writeFileSync(target, original);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (link === "directory symlink") fs.symlinkSync(external, directory, "dir");
  else {
    fs.mkdirSync(directory);
    if (link === "ignore symlink") fs.symlinkSync(target, path.join(directory, ".gitignore"));
    else fs.linkSync(target, path.join(directory, ".gitignore"));
  }
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  await expect((async () => (await compose(kind, repo)))()).rejects.toThrow(/pipeline controller artifact (?:path|ignore file) must be/);
  expect(fs.readFileSync(target, "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ enabled: true });
  expect(fs.readdirSync(external)).toEqual([".gitignore"]);
  expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  expect(git("show", ":source.txt")).toBe("staged source");
});

test("separate output and specification handoffs stay private after restoring the tracked ignore", async () => {
  const { repo, git } = repository("restore-part-ignores");
  const ignore = `${CONTROLLER_ARTIFACT_DIRECTORY}/.gitignore`;
  fs.mkdirSync(path.dirname(path.join(repo, ignore)), { recursive: true });
  fs.writeFileSync(path.join(repo, ignore), "!*.md\n");
  git("add", "-A");
  git("commit", "-m", "controller ignore");
  const before = git("rev-parse", "HEAD");
  const output = "PRIVATE_OUTPUT_SENTINEL\n" + "o".repeat(40_000);
  const spec = "PRIVATE_SPEC_SENTINEL\n" + "s".repeat(40_000);
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Build {{prev.output}}", next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Builder instructions" } };
  const pipeline = buildPipeline({ id: "part-ignores", task: "Build", spec, project: "fixture", repoDir: repo,
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = repo;
  const delivered = (await composeStageInput(pipeline, stage, stage.effectiveRole, output));
  const outputFile = delivered.match(/Full previous output file: (.+)\n/)?.[1];
  const specFile = delivered.match(/Full specification file: (.+)\n/)?.[1];
  expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(32_000);
  expect(fs.readFileSync(outputFile!, "utf8")).toBe(output);
  expect(fs.readFileSync(specFile!, "utf8")).toBe(spec);
  git("restore", "--", ignore);
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "ordinary worker change before settlement");
  expect(git("diff", "--name-only", before, "HEAD")).toBe("source.txt");
  expect(git("ls-files", "--", CONTROLLER_ARTIFACT_DIRECTORY)).toBe(ignore);
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_OUTPUT_SENTINEL");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_SPEC_SENTINEL");
  expect(fs.readFileSync(outputFile!, "utf8")).toBe(output);
  expect(fs.readFileSync(specFile!, "utf8")).toBe(spec);
});

test.each([
  { kind: "structured", guard: "*\n", safe: true }, { kind: "pipeline", guard: "*\n", safe: true },
  { kind: "structured", guard: "/pipeline-stage-inputs/\n", safe: true }, { kind: "pipeline", guard: "/pipeline-stage-inputs/\n", safe: true },
  { kind: "structured", guard: "!*.md\n", safe: false }, { kind: "pipeline", guard: "!*.md\n", safe: false },
  { kind: "structured", guard: "/pipeline-stage-inputs/\n!/pipeline-stage-inputs/\n", safe: false },
  { kind: "pipeline", guard: "/pipeline-stage-inputs/\n!/pipeline-stage-inputs/\n", safe: false },
] as const)("$kind legacy protection validates tracked ancestor exclusion before composition (safe=$safe, guard=$guard)", async ({ kind, guard, safe }) => {
  const { repo, git } = repository(`tracked-ancestor-${kind}-${safe}-${Buffer.from(guard).toString("hex")}`);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const ancestor = ".artifacts/.gitignore";
  const leaf = `${CONTROLLER_ARTIFACT_DIRECTORY}/.gitignore`;
  fs.writeFileSync(path.join(repo, ancestor), guard);
  fs.writeFileSync(path.join(repo, leaf), "!*.md\n");
  git("add", "-f", ancestor, leaf);
  git("commit", "-m", "tracked ancestor ignore");
  const before = git("rev-parse", "HEAD");
  const legacy = path.join(directory, "old.md");
  const legacyText = "PRIVATE_LEGACY_SENTINEL\n";
  fs.writeFileSync(legacy, legacyText);
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  if (safe) {
    const { delivered, text } = (await compose(kind, repo));
    const file = delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
    expect(fs.readFileSync(file!, "utf8")).toBe(text);
    git("restore", "--", ancestor, leaf);
    git("add", "-A");
    git("commit", "-m", "ordinary worker change before settlement");
    expect(git("diff", "--name-only", before, "HEAD")).toBe("source.txt");
    expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_LEGACY_SENTINEL");
    expect(fs.readFileSync(file!, "utf8")).toBe(text);
  } else {
    await expect((async () => (await compose(kind, repo)))()).rejects.toThrow(/tracked ancestor ignore prevents safe legacy/);
    expect(fs.readdirSync(directory).sort()).toEqual([".gitignore", "old.md"]);
    expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  }
  expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
  expect(fs.readFileSync(path.join(repo, ancestor), "utf8")).toBe(guard);
});

test.each([
  { kind: "structured", link: "symlink" }, { kind: "pipeline", link: "symlink" },
  { kind: "structured", link: "hardlink" }, { kind: "pipeline", link: "hardlink" },
] as const)("$kind legacy protection refuses a $link ancestor ignore without external writes", async ({ kind, link }) => {
  const { repo, git } = repository(`linked-ancestor-${kind}-${link}`);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const legacy = path.join(directory, "old.md");
  fs.writeFileSync(legacy, "PRIVATE_LEGACY_SENTINEL\n");
  const external = path.join(root, `ancestor-${kind}-${link}.json`);
  const original = '{"enabled":true}\n';
  fs.writeFileSync(external, original);
  const guard = path.join(repo, ".artifacts", ".gitignore");
  if (link === "symlink") fs.symlinkSync(external, guard);
  else fs.linkSync(external, guard);
  await expect((async () => (await compose(kind, repo)))()).rejects.toThrow(/pipeline controller artifact ignore file must be a regular file with one link/);
  expect(fs.readFileSync(external, "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(external, "utf8"))).toEqual({ enabled: true });
  expect(fs.readFileSync(legacy, "utf8")).toBe("PRIVATE_LEGACY_SENTINEL\n");
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
});

test("composition refuses a committed input namespace before creating private files or changing its ignore file", async () => {
  const { repo, git } = repository("tracked-input");
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, ".gitignore"), "!*.md\n");
  fs.writeFileSync(path.join(directory, "tracked.md"), "repository content\n");
  git("add", "-A");
  git("commit", "-m", "tracked namespace");
  await expect((async () => (await compose("structured", repo)))()).rejects.toThrow(/committed files in the private controller artifact directory/);
  expect(fs.readdirSync(directory).sort()).toEqual([".gitignore", "tracked.md"]);
  expect(fs.readFileSync(path.join(directory, ".gitignore"), "utf8")).toBe("!*.md\n");
  expect(git("status", "--porcelain")).toBe("");
});

test.each([
  { kind: "structured", ignore: "missing" }, { kind: "pipeline", ignore: "missing" },
  { kind: "structured", ignore: "reinclude" }, { kind: "pipeline", ignore: "reinclude" },
  { kind: "structured", ignore: "catchall" }, { kind: "pipeline", ignore: "catchall" },
] as const)("a small $kind launch clears old private staging before an ordinary worker commit (ignore=$ignore)", async ({ kind, ignore }) => {
  const { repo, git } = repository(`small-${kind}-${ignore}`);
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  if (ignore !== "missing") fs.writeFileSync(path.join(directory, ".gitignore"), ignore === "reinclude" ? "!*.md\n" : "*\n");
  fs.writeFileSync(path.join(directory, "old.md"), "PRIVATE_STAGED_SENTINEL\n");
  git("add", "-f", `${CONTROLLER_ARTIFACT_DIRECTORY}/old.md`);
  (await composeSmall(kind, repo));
  expect(git("diff", "--cached", "--name-only")).toBe("");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
  expect(fs.readFileSync(path.join(directory, "old.md"), "utf8")).toBe("PRIVATE_STAGED_SENTINEL\n");
});

test.each([
  { kind: "structured", small: true, inherited: "root" }, { kind: "pipeline", small: true, inherited: "root" },
  { kind: "structured", small: false, inherited: "root" }, { kind: "pipeline", small: false, inherited: "root" },
  { kind: "structured", small: true, inherited: "sibling" }, { kind: "pipeline", small: true, inherited: "sibling" },
  { kind: "structured", small: false, inherited: "sibling" }, { kind: "pipeline", small: false, inherited: "sibling" },
] as const)("nested $kind launch protects inherited $inherited handoffs before ordinary worker commits (small=$small)", async ({ kind, small, inherited }) => {
  const { repo, git } = repository(`inherited-${kind}-${small}-${inherited}`);
  const cwd = path.join(repo, "worker");
  const priorCwd = inherited === "root" ? repo : path.join(repo, "sibling");
  fs.mkdirSync(cwd);
  fs.mkdirSync(priorCwd, { recursive: true });
  const prior = (await compose(kind, priorCwd));
  const file = prior.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  git("add", "-f", path.relative(repo, file!));
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  fs.writeFileSync(path.join(repo, "source.txt"), "unstaged source\n");
  if (small) (await composeSmall(kind, cwd));
  else (await compose(kind, cwd));
  expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  expect(git("show", ":source.txt")).toBe("staged source");
  expect(fs.readFileSync(file!, "utf8")).toBe(prior.text);
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
});

test.each(["structured", "pipeline"] as const)("%s composition protects the real Git index when its cwd is a directory alias", async (kind) => {
  const { repo, git } = repository(`alias-${kind}`);
  const alias = path.join(root, `cwd-alias-${kind}`);
  fs.symlinkSync(repo, alias, "dir");
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "old.md"), "PRIVATE_STAGED_SENTINEL\n");
  git("add", "-A");
  const { delivered, text } = (await compose(kind, alias));
  const file = delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  expect(fs.readFileSync(file!, "utf8")).toBe(text);
  expect(git("diff", "--cached", "--name-only")).toBe("");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
});

test.each(["structured", "pipeline"] as const)("a nested %s launch repairs an exposed untracked parent handoff", async (kind) => {
  const { repo, git } = repository(`untracked-parent-${kind}`);
  const prior = (await compose(kind, repo));
  const file = prior.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  fs.unlinkSync(path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY, ".gitignore"));
  const cwd = path.join(repo, "worker");
  fs.mkdirSync(cwd);
  (await composeSmall(kind, cwd));
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "worker result");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.txt");
  expect(fs.readFileSync(file!, "utf8")).toBe(prior.text);
});

test.each(["structured", "pipeline"] as const)("a small %s launch repairs an inherited private child ignore before tracked-ignore restore", async (kind) => {
  const { repo, git } = repository(`inherited-child-ignore-${kind}`);
  const sibling = path.join(repo, "sibling");
  fs.mkdirSync(sibling);
  const prior = (await compose(kind, sibling));
  const file = prior.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
  const ignore = path.relative(repo, path.join(sibling, CONTROLLER_ARTIFACT_DIRECTORY, ".gitignore"));
  fs.writeFileSync(path.join(repo, ignore), "!*.md\n");
  git("add", "-f", ignore);
  git("commit", "-m", "tracked sibling ignore");
  const before = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(path.dirname(file!), ".gitignore"), "!*.md\n");
  git("add", "-f", path.relative(repo, file!));
  const cwd = path.join(repo, "worker");
  fs.mkdirSync(cwd);
  (await composeSmall(kind, cwd));
  expect(git("diff", "--cached", "--name-only")).toBe("");
  git("restore", "--", ignore);
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  git("add", "-A");
  git("commit", "-m", "ordinary worker change before settlement");
  expect(git("diff", "--name-only", before, "HEAD")).toBe("source.txt");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_INPUT_SENTINEL");
  expect(fs.readFileSync(file!, "utf8")).toBe(prior.text);
});

test.each([
  { kind: "structured", small: true, inherited: "root" }, { kind: "pipeline", small: true, inherited: "root" },
  { kind: "structured", small: false, inherited: "root" }, { kind: "pipeline", small: false, inherited: "root" },
  { kind: "structured", small: true, inherited: "sibling" }, { kind: "pipeline", small: true, inherited: "sibling" },
  { kind: "structured", small: false, inherited: "sibling" }, { kind: "pipeline", small: false, inherited: "sibling" },
] as const)("nested $kind launch protects temporarily ignored legacy $inherited handoffs (small=$small)", async ({ kind, small, inherited }) => {
  const { repo, git } = repository(`ignored-legacy-${kind}-${small}-${inherited}`);
  const rootIgnore = "!*/\n!*.md\n";
  fs.writeFileSync(path.join(repo, ".gitignore"), rootIgnore);
  git("add", ".gitignore");
  git("commit", "-m", "repository inclusion rules");
  const priorCwd = inherited === "root" ? repo : path.join(repo, "sibling[worker]");
  const legacy = path.join(priorCwd, CONTROLLER_ARTIFACT_DIRECTORY, "previous-output-old.md");
  const legacyText = "PRIVATE_IGNORED_LEGACY_SENTINEL\n" + "Full prior context\n".repeat(3_000);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, legacyText);
  fs.writeFileSync(path.join(repo, ".gitignore"), `${rootIgnore}**/.artifacts/\n`);
  expect(git("ls-files", "--others", "--exclude-standard")).not.toContain("previous-output-old.md");
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "source.txt");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker result\n");
  const cwd = path.join(repo, "worker");
  fs.mkdirSync(cwd);
  if (small) (await composeSmall(kind, cwd));
  else (await compose(kind, cwd));
  expect(git("diff", "--cached", "--name-only")).toBe("source.txt");
  expect(git("show", ":source.txt")).toBe("staged source");
  expect(fs.readFileSync(path.join(repo, "source.txt"), "utf8")).toBe("worker result\n");
  git("restore", "--", ".gitignore");
  git("add", "-A");
  git("commit", "-m", "ordinary worker change before settlement");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe(".gitignore\nsource.txt");
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_IGNORED_LEGACY_SENTINEL");
  expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
});

test("inherited namespace discovery refuses a symlinked ancestor before repairing an external ignore file", async () => {
  const { repo, git } = repository("external-ancestor");
  const external = path.join(root, "external-namespace");
  const directory = path.join(external, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const original = '{"enabled":true}\n';
  fs.writeFileSync(path.join(directory, ".gitignore"), original);
  fs.symlinkSync(external, path.join(repo, "alias"), "dir");
  // A crafted index can name a descendant even when the filesystem ancestor
  // is a symlink. Git discovery must not authorize writes through that alias.
  const blob = git("hash-object", "-w", path.join(repo, "source.txt"));
  git("update-index", "--add", "--cacheinfo", `100644,${blob},alias/${CONTROLLER_ARTIFACT_DIRECTORY}/old.md`);
  await expect((async () => (await compose("structured", repo)))()).rejects.toThrow(/pipeline controller artifact path must be a real directory/);
  expect(fs.readFileSync(path.join(directory, ".gitignore"), "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(path.join(directory, ".gitignore"), "utf8"))).toEqual({ enabled: true });
  expect(fs.readdirSync(directory)).toEqual([".gitignore"]);
});

test("the refusal names the launch directory, the resolved work tree and core.worktree", async () => {
  const { repo, git } = repository("core-worktree-refusal");
  const elsewhere = path.join(root, "core-worktree-elsewhere");
  fs.mkdirSync(elsewhere);
  git("config", "core.worktree", elsewhere);
  const toplevel = fs.realpathSync(elsewhere);
  const failure = await prepareControllerArtifactDirectory(repo).then(() => null, (error: Error) => error);
  expect(failure).not.toBeNull();
  expect(failure!.message).toBe(
    `controller artifacts must stay inside the Git worktree: ${fs.realpathSync(repo)} resolves to Git work tree ${toplevel}; ` +
    `core.worktree is set to ${elsewhere} in this repository's config`);
  expect(fs.existsSync(path.join(repo, ".artifacts"))).toBe(false);
});

test("the refusal without core.worktree still names the launch directory and the resolved work tree", async () => {
  const { repo } = repository("outside-toplevel-refusal");
  const elsewhere = path.join(root, "outside-toplevel-elsewhere");
  fs.mkdirSync(elsewhere);
  const exec: typeof realExec = async (command, args, cwd, env, options) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: `${elsewhere}\n`, stderr: "" };
    }
    return realExec(command, args, cwd, env, options);
  };
  const failure = await prepareControllerArtifactDirectory(repo, exec).then(() => null, (error: Error) => error);
  expect(failure).not.toBeNull();
  expect(failure!.message).toBe(
    `controller artifacts must stay inside the Git worktree: ${fs.realpathSync(repo)} resolves to Git work tree ${fs.realpathSync(elsewhere)}`);
});

test("the refusal names GIT_WORK_TREE when the environment sets it", async () => {
  const { repo } = repository("environment-work-tree-refusal");
  const elsewhere = path.join(root, "environment-work-tree-elsewhere");
  fs.mkdirSync(elsewhere);
  const exec: typeof realExec = async (command, args, cwd, env, options) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${elsewhere}\n`, stderr: "" };
    return realExec(command, args, cwd, env, options);
  };
  const prior = process.env.GIT_WORK_TREE;
  process.env.GIT_WORK_TREE = elsewhere;
  try {
    const failure = await prepareControllerArtifactDirectory(repo, exec).then(() => null, (error: Error) => error);
    expect(failure!.message).toBe(
      `controller artifacts must stay inside the Git worktree: ${fs.realpathSync(repo)} resolves to Git work tree ${fs.realpathSync(elsewhere)}; ` +
      `GIT_WORK_TREE is set to ${elsewhere}`);
  } finally {
    if (prior === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = prior;
  }
});

test.each([
  { kind: "structured", small: true }, { kind: "pipeline", small: true },
  { kind: "structured", small: false }, { kind: "pipeline", small: false },
] as const)("$kind composition refuses non-round-tripping Git paths without losing staged work (small=$small)", async ({ kind, small }) => {
  const { repo, git } = repository(`invalid-git-path-${kind}-${small}`);
  const directory = Buffer.concat([Buffer.from(`${repo}/sibling-`), Buffer.from([0xff]), Buffer.from(`/${CONTROLLER_ARTIFACT_DIRECTORY}`)]);
  fs.mkdirSync(directory, { recursive: true });
  const file = Buffer.concat([directory, Buffer.from("/old.md")]);
  const input = "PRIVATE_INVALID_UTF8_SENTINEL\n" + "Full context\n".repeat(3_000);
  fs.writeFileSync(file, input);
  fs.writeFileSync(path.join(repo, "source.txt"), "staged source\n");
  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only");
  expect(staged).toContain("old.md");
  fs.writeFileSync(path.join(repo, "source.txt"), "unstaged source\n");
  const cwd = path.join(repo, "worker");
  fs.mkdirSync(cwd);
  await expect((async () => { if (small) (await composeSmall(kind, cwd)); else (await compose(kind, cwd)); })()).rejects.toThrow(/cannot safely decode controller artifact Git paths/);
  expect(git("diff", "--cached", "--name-only")).toBe(staged);
  expect(git("show", ":source.txt")).toBe("staged source");
  expect(fs.readFileSync(path.join(repo, "source.txt"), "utf8")).toBe("unstaged source\n");
  expect(fs.readFileSync(file, "utf8")).toBe(input);
  expect(fs.readdirSync(cwd)).toEqual([]);
  expect(git("show", "HEAD:source.txt")).toBe("base");
});

test.each([
  { kind: "structured", small: true }, { kind: "pipeline", small: true },
  { kind: "structured", small: false }, { kind: "pipeline", small: false },
] as const)("$kind composition preserves ordinary non-UTF-8 source paths (small=$small)", async ({ kind, small }) => {
  const { repo, git } = repository(`ordinary-byte-path-${kind}-${small}`);
  const tracked = Buffer.concat([Buffer.from(`${repo}/source-`), Buffer.from([0xff])]);
  const untracked = Buffer.concat([Buffer.from(`${repo}/source-`), Buffer.from([0xfe])]);
  fs.writeFileSync(tracked, "tracked source\n");
  git("add", "-A");
  git("commit", "-m", "ordinary source with byte filename");
  fs.writeFileSync(untracked, "new source\n");
  fs.writeFileSync(path.join(repo, "source.txt"), "worker source\n");
  const result = small ? (await composeSmall(kind, repo)) : (await compose(kind, repo));
  git("add", "-A");
  git("commit", "-m", "ordinary worker source");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain(CONTROLLER_ARTIFACT_DIRECTORY);
  expect(git("show", "--format=", "HEAD")).not.toContain("PRIVATE_INPUT_SENTINEL");
  expect(fs.readFileSync(tracked, "utf8")).toBe("tracked source\n");
  expect(fs.readFileSync(untracked, "utf8")).toBe("new source\n");
  expect(git("show", "HEAD:source.txt")).toBe("worker source");
  if (typeof result !== "string") {
    const file = result.delivered.match(/Full (?:structured first message|stage prompt) file: (.+)\n/)?.[1];
    expect(fs.readFileSync(file!, "utf8")).toBe(result.text);
  }
});


test.each([
  { boundary: "legacy ignore", unborn: false },
  { boundary: "unstage", unborn: false },
  { boundary: "unstage", unborn: true },
])("async artifact repair rechecks ancestors after $boundary (unborn=$unborn)", async ({ boundary, unborn }) => {
  const { repo, git } = repository(`async-ancestor-${boundary.replaceAll(" ", "-")}-${unborn}`, unborn);
  const artifactRoot = path.join(repo, ".artifacts");
  const directory = path.join(repo, CONTROLLER_ARTIFACT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "old.md"), "private staged handoff\n");
  git("add", "-A");
  const external = path.join(root, `async-external-${boundary.replaceAll(" ", "-")}-${unborn}`);
  fs.mkdirSync(external);
  const original = "preserve\n";
  fs.writeFileSync(path.join(external, ".gitignore"), original);
  if (boundary === "legacy ignore") fs.mkdirSync(path.join(external, "pipeline-stage-inputs"));
  let swapped = false;
  await expect(prepareControllerArtifactDirectory(repo, async (command, args, ...rest) => {
    const result = await realExec(command, args, ...rest);
    const atBoundary = boundary === "legacy ignore"
      ? args[0] === "ls-files" && args.at(-1) === ".artifacts/.gitignore"
      : args[0] === (unborn ? "rm" : "reset");
    if (!swapped && atBoundary) {
      swapped = true;
      const replaced = boundary === "legacy ignore" ? artifactRoot : directory;
      fs.renameSync(replaced, `${replaced}-retained`);
      fs.symlinkSync(external, replaced, "dir");
    }
    return result;
  })).rejects.toThrow(/pipeline controller artifact path must be a real directory/);
  expect(swapped).toBe(true);
  expect(fs.readFileSync(path.join(external, ".gitignore"), "utf8")).toBe(original);
  expect(fs.readdirSync(external).sort()).toEqual(boundary === "legacy ignore" ? [".gitignore", "pipeline-stage-inputs"] : [".gitignore"]);
});
