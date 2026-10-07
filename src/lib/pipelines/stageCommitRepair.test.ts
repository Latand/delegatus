import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CreateFlowRequest, Flow } from "@/lib/flows/types";
import type { ExecPort, ExecResult } from "@/lib/workflows/provision";

/* Isolated state only: this suite drives the production pipeline controller
   over a store of its own and must never read or write the operator's. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-commit-repair-"));
const { createPipelineFromRequest, defaultPipelinePorts, tickPipelines } = await import("./engine");
const { commitPipelineStage } = await import("./git");
const { findPipelineRecord, loadPipelines, pipelineArtifactsDir, savePipelines } = await import("./store");
const { pipelineCorpus } = await import("./fixtures/corpus");
const { realExec } = await import("@/lib/workflows/provision");
const { registerPipelineTick } = await import("./controllerSignal");
type PipelinePorts = import("./engine").PipelinePorts;
type Pipeline = import("./types").Pipeline;
type PipelineStageAttempt = import("./types").PipelineStageAttempt;
type StageTurnEvidence = import("./durableEvidence").StageTurnEvidence;

/* A tick this suite did not ask for must never reach the real ports. */
registerPipelineTick(async () => {});

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const STAGE_TRANSCRIPT = "/claude/stage-1.jsonl";
const STAGE_CONVERSATION = "conversation_stage_1";
const BASE_SHA = "9".repeat(40);
const STAGE_HEAD = "7".repeat(40);
const TREE_SHA = "5".repeat(40);
const TICK_MS = 30_000;
const REPAIR_WAIT_MS = 20 * 60_000;
const OUTPUT = "evidence/draft/prototype.diff.txt";
/** The refusal that parked production lane dfcb63ab, with its path shortened. */
const WHITESPACE_REFUSAL = `pre-commit: staged whitespace — ${OUTPUT}:15: trailing whitespace.`;
const PASS = "The study is written.\n\n```json\n{\"status\":\"pass\"}\n```";

/* ---------- the commit itself, against a real repository and a real hook ---------- */

/** A repository of its own, with a pre-commit hook that refuses staged
    whitespace the way the project's gate words it, or fails for a reason no
    file can fix when `LLV_TEST_HOOK_BROKEN` is set. */
function hookedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-commit-repair-repo-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  for (const directory of [home, repo]) fs.mkdirSync(directory);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(root, "xdg"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") });
  const calls: string[] = [];
  const exec: ExecPort = (command, args, cwd, overrides) => {
    calls.push(`${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
  };
  const run = (...args: string[]) => {
    const result = exec("git", args, repo) as ExecResult;
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  run("init", "--initial-branch=main");
  fs.writeFileSync(path.join(repo, "source.ts"), "export const value = 1;\n");
  run("add", "source.ts");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-m", "initial");
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), [
    "#!/bin/sh",
    "if [ -f \"$(git rev-parse --git-dir)/hook-broken\" ]; then echo 'gate-slot: no slot became free within 600s' >&2; exit 1; fi",
    "if [ -f \"$(git rev-parse --git-dir)/hook-tool-missing\" ]; then echo \"checking $(git diff --cached --name-only)\" >&2; llv-test-tool-that-is-not-installed; exit 1; fi",
    "if [ -f \"$(git rev-parse --git-dir)/hook-tool-missing-after-check\" ]; then git diff --cached --check >&2; llv-test-tool-that-is-not-installed; exit 1; fi",
    "if [ -f \"$(git rev-parse --git-dir)/hook-runs-staged-checks\" ]; then for check in $(git diff --cached --name-only -- '*.cjs'); do node \"$check\" || exit 1; done; fi",
    "if ! out=$(git diff --cached --check 2>&1); then echo \"pre-commit: staged whitespace — $out\" >&2; exit 1; fi",
    "",
  ].join("\n"), { mode: 0o755 });
  const subject = {
    id: "12345678", task: "task", taskIds: [], project: "viewer", repoDir: repo, worktreeDir: repo,
    branch: "main", baseBranch: "", baseRef: "", lastPassedCommit: run("rev-parse", "HEAD"),
    stages: [], runs: [], cursor: null, state: "running", pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: "now", closedAt: null,
  } as unknown as Pipeline;
  return { root, repo, exec, run, calls, subject, breakHook: () => fs.writeFileSync(path.join(repo, ".git", "hook-broken"), ""),
    loseHookTool: () => fs.writeFileSync(path.join(repo, ".git", "hook-tool-missing"), ""),
    loseHookToolAfterCheck: () => fs.writeFileSync(path.join(repo, ".git", "hook-tool-missing-after-check"), ""),
    runStagedChecks: () => fs.writeFileSync(path.join(repo, ".git", "hook-runs-staged-checks"), "") };
}

function writeOutput(repo: string, relative: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), content);
}

test("a hook that refuses a read-only stage's declared output names that output as repairable, and the repaired output commits through the same hook", async () => {
  const box = hookedRepo();
  try {
    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote \n");
    const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    /* The park text is unchanged: the step, then what the hook printed. */
    expect(refused.error).toStartWith("committing the passed stage: pre-commit: staged whitespace — ");
    expect(refused.commitRefusal).toEqual({ repairable: true, paths: [OUTPUT] });
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

test("a writable stage's refused commit is repairable on the files it staged", async () => {
  const box = hookedRepo();
  try {
    fs.writeFileSync(path.join(box.repo, "source.ts"), "export const value = 2; \n");
    const refused = await commitPipelineStage(box.subject, "build", true, box.exec);
    expect(refused).toMatchObject({ ok: false, commitRefusal: { repairable: true, paths: ["source.ts"] } });
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a hook that fails for a reason no staged file names is not repairable", async () => {
  const box = hookedRepo();
  try {
    box.breakHook();
    writeOutput(box.repo, OUTPUT, "+ a clean line\n");
    const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused).toMatchObject({
      ok: false,
      error: "committing the passed stage: gate-slot: no slot became free within 600s",
      commitRefusal: { repairable: false, paths: [OUTPUT] },
    });
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a commit that was killed at its time limit is not repairable, whatever it printed first", async () => {
  const box = hookedRepo();
  try {
    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote \n");
    const exec: ExecPort = (command, args, cwd, overrides, options) => args[0] === "commit"
      ? { code: null, signal: "SIGKILL", stdout: "", stderr: WHITESPACE_REFUSAL }
      : box.exec(command, args, cwd, overrides, options);
    const refused = await commitPipelineStage(box.subject, "study", false, exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused).toMatchObject({ ok: false, commitRefusal: { repairable: false } });
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a hook whose tool is missing is not repairable, although its progress line names the staged file", async () => {
  const box = hookedRepo();
  try {
    box.loseHookTool();
    writeOutput(box.repo, OUTPUT, "+ a clean line\n");
    const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error).toContain(`checking ${OUTPUT}`);
    expect(refused.commitRefusal).toEqual({ repairable: false, paths: [OUTPUT] });
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a hook whose tool is missing is not repairable, although the whitespace check before it placed a genuine defect in the staged file", async () => {
  const box = hookedRepo();
  try {
    box.loseHookToolAfterCheck();
    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote \n");
    const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error).toContain(`${OUTPUT}:1: trailing whitespace.`);
    /* `/bin/sh` words it `<hook>: <line>: <command>: not found`, and the commit exits 1, not 127. */
    expect(refused.error).toMatch(/llv-test-tool-that-is-not-installed: (?:command )?not found/);
    expect(refused.commitRefusal).toEqual({ repairable: false, paths: [OUTPUT] });
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a whitespace defect on a source line that spells an errno is repairable, and the repaired line commits", async () => {
  const box = hookedRepo();
  try {
    writeOutput(box.repo, OUTPUT, "+ const missingFile = \"ENOENT\"; \n");
    const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    /* The hook echoes the offending line under its diagnostic. */
    expect(refused.error).toContain("++ const missingFile = \"ENOENT\";");
    expect(refused.commitRefusal).toEqual({ repairable: true, paths: [OUTPUT] });

    writeOutput(box.repo, OUTPUT, "+ const missingFile = \"ENOENT\";\n");
    expect((await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit)).ok).toBe(true);
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a staged check that crashes on a missing hook configuration is not repairable, although its stack frame places the staged file", async () => {
  const box = hookedRepo();
  try {
    box.runStagedChecks();
    const check = "evidence/draft/check.cjs";
    writeOutput(box.repo, check, "const config = require(\"fs\").readFileSync(\".git/hook-config.json\", \"utf8\");\nconsole.log(config);\n");
    const refused = await commitPipelineStage(box.subject, "study", false, box.exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error).toContain("ENOENT");
    expect(refused.error).toContain(`${check}:1:`);
    expect(refused.commitRefusal).toEqual({ repairable: false, paths: [check] });
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

const EMFILE_REFUSAL = `pre-commit: eslint — could not open ${OUTPUT}: EMFILE: too many open files`;
const LOCATED_EMFILE_REFUSAL = `${OUTPUT}:15:1: error: EMFILE: too many open files`;
const PRIVACY_REFUSAL = "pre-commit: privacy\nPRIVACY GATE: FAIL\nhome_path: 1\nknown_value: 2\npre-commit: bun failed (1); gate failed";

test.each([
  ["a located whitespace diagnostic", 1, WHITESPACE_REFUSAL, true],
  ["a located lint diagnostic", 1, `pre-commit: eslint\n${OUTPUT}:3:1 no-unused-vars: 'x' is defined but never used`, true],
  ["a lint report that lists positions under the file", 1, `/work/tree/${OUTPUT}\n  3:1  error  'x' is defined but never used  no-unused-vars\n\n1 problem`, true],
  ["a privacy verdict on the staged content", 1, PRIVACY_REFUSAL, true],
  ["a privacy gate that could not run", 1, "pre-commit: privacy\nPRIVACY GATE: FAIL\nconfiguration_error: 1", false],
  ["a privacy gate that lacks a tool, beside a content finding", 1, "PRIVACY GATE: FAIL\nhome_path: 1\ntool_unavailable: 1", false],
  ["a resource failure that names the staged file", 1, EMFILE_REFUSAL, false],
  ["a resource failure placed at a line of the staged file", 1, LOCATED_EMFILE_REFUSAL, false],
  ["a stack frame in the staged file", 1, `TypeError: x is not a function\n    at run (/work/tree/${OUTPUT}:4:9)\n    at main (/work/tree/${OUTPUT}:9:3)`, false],
  ["a crash header that places the staged file with no message", 1, `/work/tree/${OUTPUT}:4\nthrow new Error("config");\n^`, false],
  ["a Python traceback beside a located line", 1, `Traceback (most recent call last):\n${OUTPUT}:2: in <module>\nModuleNotFoundError: No module named 'yaml'`, false],
  ["a progress line that names the staged file", 1, `checking ${OUTPUT}\nfatal: unable to write new index file`, false],
  ["a shell that could not find a command after a located defect", 1, `${WHITESPACE_REFUSAL}\n.git/hooks/pre-commit: 3: llv-lint: not found`, false],
  ["a shell that could not find a command", 1, `${WHITESPACE_REFUSAL}\nsh: 1: llv-lint: not found`, false],
  ["a located defect whose echoed source line spells an errno", 1, `${WHITESPACE_REFUSAL}\n++ const missingFile = "ENOENT"; `, true],
  ["a located defect whose echoed prose says permission denied", 1, `${WHITESPACE_REFUSAL}\n+When the socket answers permission denied, retry. `, true],
  ["a located defect whose echoed code frame spells an errno", 1, `${OUTPUT}:3:7 no-unused-vars: 'x' is defined but never used\n> 3 | const x = "EACCES";\n    |       ^`, true],
  ["a lint message that quotes an errno name", 1, `${OUTPUT}:3:7 no-unused-vars: 'ENOENT' is assigned a value but never used`, true],
  ["a hook that could not find its command", 127, WHITESPACE_REFUSAL, false],
  ["a hook that could not be executed", 126, WHITESPACE_REFUSAL, false],
] as const)("%s decides whether the stage is asked", async (_name, code, stderr, repairable) => {
  const box = hookedRepo();
  try {
    writeOutput(box.repo, OUTPUT, "+ a line the stage wrote\n");
    const exec: ExecPort = (command, args, cwd, overrides, options) => args[0] === "commit"
      ? { code, stdout: "", stderr }
      : box.exec(command, args, cwd, overrides, options);
    const refused = await commitPipelineStage(box.subject, "study", false, exec, ["evidence/draft"], box.subject.lastPassedCommit);
    expect(refused).toMatchObject({ ok: false, commitRefusal: { repairable, paths: [OUTPUT] } });
  } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
});

/* ---------- the controller, over an isolated store ---------- */

function harness(options: { access?: "read-only" | "read-write" } = {}) {
  const access = options.access ?? "read-write";
  const requests: Array<{ conversationId: string; transcriptPath: string; clientMessageId: string; text: string; cohortAt?: string }> = [];
  let wall = Date.parse("2026-10-07T09:00:00.000Z");
  let turn: StageTurnEvidence = { turn: "busy", message: null, lastRecordAt: wall };
  let requestAccepted = true;
  let requestThrows = false;
  /** Answers for the next requests, in order, before the defaults above. */
  const answers: Array<"admitted-unacknowledged" | "refused" | "accepted"> = [];
  const storedAtRequest: Array<PipelineStageAttempt["commitRepair"]> = [];
  let head = BASE_SHA;
  let remote = BASE_SHA;
  let spawns = 0;
  /** What the stage left uncommitted, and what the hook answers to a commit. */
  let dirty: string[] = [OUTPUT];
  let hook: ExecResult = { code: 0, stdout: "", stderr: "" };
  let committedBody = "";
  let ancestry: ExecResult = { code: 0, stdout: "", stderr: "" };
  let branchRef: ExecResult | null = null;
  const calls: string[] = [];
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs) => {
      calls.push(`${rawCommand} ${rawArgs.join(" ")}`);
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") return ancestry;
      if (args[0] === "symbolic-ref" && branchRef) return branchRef;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: `${BASE_SHA}\n`, stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
      if (args[0] === "push") remote = head;
      if (args[0] === "ls-remote") return { code: 0, stdout: `${remote}\trefs/heads/${loadPipelines()[0]?.branch ?? "pipeline/test"}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: dirty.map((file) => ` M ${file}\n`).join(""), stderr: "" };
      if (args[0] === "diff" && args.includes("--name-only")) {
        /* Either side of the first commit: what the worktree or the index holds
           against HEAD, or what the new commit changed. */
        const changed = dirty.length || !args.includes(STAGE_HEAD) ? dirty : [OUTPUT];
        return { code: 0, stdout: changed.join("\0"), stderr: "" };
      }
      if (args[0] === "write-tree") return { code: 0, stdout: `${TREE_SHA}\n`, stderr: "" };
      if (args[0] === "commit") {
        if (hook.code === 0) {
          head = STAGE_HEAD; dirty = [];
          committedBody = args.filter((_, index) => args[index - 1] === "-m").join("\n\n");
        }
        return hook;
      }
      /* The ownership proof a read-only stage's commit is checked against. */
      if (args[0] === "show") return { code: 0, stdout: `${BASE_SHA}\0${TREE_SHA}\0${committedBody}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({ ok: true, repoDir, gitCommonDir: path.join(repoDir, ".git"), worktreeParent: path.dirname(repoDir) }),
    roleLookup: () => ({ engine: "claude", model: "opus", effort: "high", access, promptScaffold: "Guidance" }),
    spawnAgent: async (_input, onReserved) => {
      spawns += 1;
      onReserved({ launchId: `launch-${spawns}`, conversationId: STAGE_CONVERSATION, accountId: "default" });
      return {
        launchId: `launch-${spawns}`,
        conversationId: STAGE_CONVERSATION,
        sessionId: `session-${spawns}`,
        /* Quoted so the publication gate does not read the key as a transcript line. */
        "transcript": STAGE_TRANSCRIPT,
        paneId: null,
        accountId: "default",
      };
    },
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    paneAgentAlive: async () => false,
    stopStageAgent: async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "not-running" }),
    stageHostResident: async () => false,
    monotonicNow: () => wall,
    worktreePresent: () => true,
    conversationAgentActive: async () => null,
    runtimeHostEpoch: async () => 1_020,
    conversationDeliveryOutstanding: () => false,
    transcriptPresent: () => true,
    resumeSeveredTurn: async (input) => {
      requests.push({ ...input });
      storedAtRequest.push(structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!.commitRepair));
      const answer = answers.shift();
      /* The surface admitted the request and then lost its acknowledgement, as
         a delivered receipt followed by a registry-settlement error does. */
      if (answer === "admitted-unacknowledged") { input.onUncertain?.(); return false; }
      if (answer) return answer === "accepted";
      if (requestThrows) throw new Error("runtime host unreachable");
      return requestAccepted;
    },
    durableTurnEvidence: async () => turn,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: () => null,
    pathForConversation: (id) => id === STAGE_CONVERSATION ? STAGE_TRANSCRIPT : null,
    sourcePathAllowed: (pathname) => pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => pathname === STAGE_TRANSCRIPT
      ? STAGE_CONVERSATION
      : pathname === "/claude/creator.jsonl" ? "conversation_creator" : null,
    pipelineAdoptionCandidates: () => [],
    createFlow: async (request: CreateFlowRequest) => ({ flow: { id: "flow-1", implementerPath: request.implementerPath } as unknown as Flow }),
    patchFlow: () => ({}),
    closeFlow: async () => {},
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date(wall).toISOString(),
  };
  return {
    ports,
    requests,
    calls,
    advance: (milliseconds: number) => { wall += milliseconds; },
    endTurn: (text: string) => { turn = { turn: "terminal", message: { text, ts: wall }, lastRecordAt: wall }; },
    keepWorking: () => { turn = { turn: "busy", message: turn.message, lastRecordAt: wall }; },
    refuseRequest: () => { requestAccepted = false; },
    breakRequest: () => { requestThrows = true; },
    answerRequests: (...next: typeof answers) => { answers.push(...next); },
    storedAtRequest,
    hookAnswers: (result: ExecResult) => { hook = result; },
    ancestryAnswers: (result: ExecResult) => { ancestry = result; },
    branchRefAnswers: (result: ExecResult) => { branchRef = result; },
    stageLeaves: (...files: string[]) => { dirty = files; },
    spawnCount: () => spawns,
  };
}

/** A pipeline whose first stage is running on a pane-less structured host. */
async function runningStage(h: ReturnType<typeof harness>, access: "read-only" | "read-write" = "read-write") {
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Study the wires",
    spec: "AC1",
    repoDir: "/repo",
    src: "/claude/creator.jsonl",
    stages: [
      access === "read-only"
        ? { id: "study", kind: "run", role: { roleId: "architect" }, access, outputs: ["evidence/draft"], prompt: "Study", next: "verify" }
        : { id: "study", kind: "run", role: { roleId: "builder" }, access, prompt: "Study", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Verify {{prev.output}}", next: null },
    ],
  } as never, h.ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", paneId: null, conversationId: STAGE_CONVERSATION });
}

const refusal = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });
/** What the real hook above prints when its whitespace check is followed by a command `/bin/sh` cannot find. */
const MISSING_TOOL_REFUSAL = `${OUTPUT}:1: trailing whitespace.\n+ a line the stage wrote \n.git/hooks/pre-commit: 3: llv-test-tool-that-is-not-installed: not found`;
const study = () => loadPipelines()[0]!.runs[0]!.attempts[0]!;

test.each(["read-only", "read-write"] as const)("a passed %s stage whose output a pre-commit hook refuses repairs it in the same conversation and advances without the operator", async (access) => {
  const h = harness({ access });
  await runningStage(h, access);
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));

  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);

  /* The hook's own words went back to the stage that wrote the file. */
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({ conversationId: STAGE_CONVERSATION, transcriptPath: STAGE_TRANSCRIPT });
  expect(h.requests[0]!.text).toContain(WHITESPACE_REFUSAL);
  if (access === "read-only") expect(h.requests[0]!.text).toContain("evidence/draft");
  const repairing = loadPipelines()[0]!;
  expect(repairing.state).toBe("running");
  expect(repairing.stateDetail).toContain("commit hook refused");
  expect(study()).toMatchObject({ state: "committing", verdict: { status: "pass" }, commitRepair: { requestedAt: expect.any(String) } });
  expect(h.requests[0]!.cohortAt).toBe(study().startedAt!);

  /* While the repair turn is open nothing is committed and nothing more is sent. */
  h.advance(TICK_MS);
  h.keepWorking();
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);
  expect(h.calls.filter((call) => call.startsWith("git commit"))).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe("running");

  /* The stage fixed its file and ended its turn; the same hook now accepts it. */
  h.advance(TICK_MS);
  h.hookAnswers({ code: 0, stdout: "", stderr: "" });
  h.endTurn("Removed the trailing whitespace.");
  await tickPipelines([], h.ports);

  const advanced = loadPipelines()[0]!;
  expect(study()).toMatchObject({ state: "passed", verdict: { status: "pass" } });
  expect(advanced.lastPassedCommit).toBe(STAGE_HEAD);
  expect(advanced.state).toBe("running");
  expect(advanced.cursor?.stageId).toBe("verify");
  expect(h.requests).toHaveLength(1);
  expect(h.spawnCount()).toBe(1);
  expect(h.calls.join("\n")).not.toContain("--no-verify");
});

test("a second refusal after the repair parks with the hook's output", async () => {
  const h = harness();
  await runningStage(h);
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);

  const second = `pre-commit: staged whitespace — ${OUTPUT}:22: trailing whitespace.`;
  h.advance(TICK_MS);
  h.hookAnswers(refusal(second));
  h.endTurn("Fixed line 15.");
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  /* The refusal that parked it leads; the one the stage was asked about stays. */
  expect(parked.stateDetail).toStartWith(`committing the passed stage: ${second}`);
  expect(parked.stateDetail).toContain(`committing the passed stage: ${WHITESPACE_REFUSAL}`);
  expect(study()).toMatchObject({ state: "needs_decision", error: parked.stateDetail });
  /* The stage was asked exactly once. */
  expect(h.requests).toHaveLength(1);
});

test.each([
  ["a hook failure no stage file names", refusal("gate-slot: no slot became free within 600s"), "committing the passed stage: gate-slot: no slot became free within 600s"],
  ["a resource failure that names the stage's file", refusal(EMFILE_REFUSAL), `committing the passed stage: ${EMFILE_REFUSAL}`],
  ["a resource failure placed at a line of the stage's file", refusal(LOCATED_EMFILE_REFUSAL), `committing the passed stage: ${LOCATED_EMFILE_REFUSAL}`],
  ["a commit killed at its time limit", { code: null, signal: "SIGKILL", stdout: "", stderr: WHITESPACE_REFUSAL } as ExecResult, `committing the passed stage: ${WHITESPACE_REFUSAL}`],
  ["a hook command missing after a located defect", refusal(MISSING_TOOL_REFUSAL), `committing the passed stage: ${MISSING_TOOL_REFUSAL}`],
])("%s parks immediately and asks the stage for nothing", async (_name, answer, detail) => {
  const h = harness();
  await runningStage(h);
  h.hookAnswers(answer);
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe(detail);
  expect(h.requests).toEqual([]);
  expect(study().commitRepair).toBeUndefined();
});

test("a read-only repair that leaves an undeclared path changed parks on the fence", async () => {
  const h = harness({ access: "read-only" });
  await runningStage(h, "read-only");
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);

  h.advance(TICK_MS);
  h.stageLeaves(OUTPUT, "src/lib/pipelines/engine.ts");
  h.hookAnswers({ code: 0, stdout: "", stderr: "" });
  h.endTurn("Fixed it.");
  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toStartWith("read-only stage study modified undeclared worktree paths");
  expect(parked.stateDetail).toContain(`committing the passed stage: ${WHITESPACE_REFUSAL}`);
  expect(study().error).toBe(parked.stateDetail);
  expect(h.calls.filter((call) => call.startsWith("git commit"))).toHaveLength(1);
});

test("the refusal and its deadline are in the store before the request leaves", async () => {
  const h = harness();
  await runningStage(h);
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);

  expect(h.storedAtRequest).toHaveLength(1);
  expect(h.storedAtRequest[0]).toMatchObject({ refusedAt: "2026-10-07T09:00:01.000Z", detail: `committing the passed stage: ${WHITESPACE_REFUSAL}` });
  expect(h.storedAtRequest[0]!.requestedAt).toBeUndefined();
  /* So is the moment it left, which a replay after a crash keeps. */
  expect(h.storedAtRequest[0]!.sendingAt).toBe("2026-10-07T09:00:01.000Z");
  expect(study().commitRepair).toMatchObject({ requestedAt: "2026-10-07T09:00:01.000Z" });
  expect(study().commitRepair!.sendingAt).toBeUndefined();
});

test("a delivery that throws spends the one repair budget: the commit is not tried again and the lane parks with the hook's output", async () => {
  const h = harness();
  await runningStage(h);
  h.breakRequest();
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);

  /* What a restart right here would read back. */
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(study().commitRepair).toMatchObject({ refusedAt: "2026-10-07T09:00:01.000Z" });
  expect(study().commitRepair!.requestedAt).toBeUndefined();

  h.advance(REPAIR_WAIT_MS / 2);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(study().commitRepair).toMatchObject({ refusedAt: "2026-10-07T09:00:01.000Z" });

  for (let tick = 0; tick < 3; tick += 1) {
    h.advance(REPAIR_WAIT_MS);
    await tickPipelines([], h.ports);
  }
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`committing the passed stage: ${WHITESPACE_REFUSAL}`);
  expect(h.calls.filter((call) => call.startsWith("git commit"))).toHaveLength(1);
  expect(h.requests.length).toBe(2);
});

test("a repair the stage never finishes, or the delivery surface never accepts, parks with the hook's output on a bound", async () => {
  for (const refused of [false, true]) {
    const h = harness();
    await runningStage(h);
    if (refused) h.refuseRequest();
    h.hookAnswers(refusal(WHITESPACE_REFUSAL));
    h.advance(1_000);
    h.endTurn(PASS);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(Boolean(study().commitRepair?.requestedAt)).toBe(!refused);

    if (!refused) h.keepWorking();
    h.advance(REPAIR_WAIT_MS);
    await tickPipelines([], h.ports);

    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain(`committing the passed stage: ${WHITESPACE_REFUSAL}`);
    expect(h.calls.filter((call) => call.startsWith("git commit"))).toHaveLength(1);
  }
});

test("a request a crash interrupted after the stage accepted it is replayed under the same id, and the repair the stage already finished advances the lane", async () => {
  const h = harness();
  await runningStage(h);
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);
  const refusedAt = study().commitRepair!.refusedAt;

  /* The process died after the delivery surface admitted the request and
     before its acknowledgement was stored: a restart reads back what the
     store held when the request left. */
  const pipelines = loadPipelines();
  pipelines[0]!.runs[0]!.attempts[0]!.commitRepair = structuredClone(h.storedAtRequest[0]);
  savePipelines(pipelines);
  expect(study().commitRepair!.requestedAt).toBeUndefined();

  /* Meanwhile the stage repaired its file and finished that turn. */
  h.advance(TICK_MS);
  h.hookAnswers({ code: 0, stdout: "", stderr: "" });
  h.endTurn("Removed the trailing whitespace.");

  h.advance(TICK_MS);
  for (let tick = 0; tick < 3; tick += 1) await tickPipelines([], h.ports);

  /* The replay is the same request, and nothing else was asked. */
  expect(h.requests.map((request) => request.clientMessageId)).toEqual(h.requests.map(() => h.requests[0]!.clientMessageId));
  expect(study().commitRepair!.refusedAt).toBe(refusedAt);
  expect(study()).toMatchObject({ state: "passed" });
  const advanced = loadPipelines()[0]!;
  expect(advanced.state).toBe("running");
  expect(advanced.cursor?.stageId).toBe("verify");
  expect(advanced.lastPassedCommit).toBe(STAGE_HEAD);
  expect(h.calls.filter((call) => call.startsWith("git commit"))).toHaveLength(2);
});

test.each([
  ["the ancestry check fails", (h: ReturnType<typeof harness>) => h.ancestryAnswers({ code: 128, stdout: "", stderr: "fatal: object store unavailable" }),
    `stage head ${STAGE_HEAD} does not descend from accepted head ${BASE_SHA}; fatal: object store unavailable`],
  ["history reconciliation fails", (h: ReturnType<typeof harness>) => {
    h.ancestryAnswers({ code: 1, stdout: "", stderr: "" });
    h.branchRefAnswers({ code: 128, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref" });
  }, "pinning the reconciliation branch: fatal: ref HEAD is not a symbolic ref"],
] as const)("when %s after the repair committed, the park keeps the hook's output", async (_name, breakSettlement, reason) => {
  const h = harness();
  await runningStage(h);
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);

  h.advance(TICK_MS);
  h.hookAnswers({ code: 0, stdout: "", stderr: "" });
  breakSettlement(h);
  h.endTurn("Removed the trailing whitespace.");
  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toStartWith(reason);
  expect(parked.stateDetail).toContain(`committing the passed stage: ${WHITESPACE_REFUSAL}`);
  expect(study().error).toBe(parked.stateDetail);
});

test("a request the surface admitted but could not acknowledge keeps its moment, and the repair the stage already finished advances the lane", async () => {
  const h = harness();
  await runningStage(h);
  h.answerRequests("admitted-unacknowledged", "accepted");
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);
  const refusedAt = study().commitRepair!.refusedAt;
  expect(study().commitRepair).toMatchObject({ sendingAt: "2026-10-07T09:00:01.000Z" });
  expect(study().commitRepair!.requestedAt).toBeUndefined();

  /* The admitted request ran: the stage repaired its file and finished that turn. */
  h.advance(TICK_MS);
  h.hookAnswers({ code: 0, stdout: "", stderr: "" });
  h.endTurn("Removed the trailing whitespace.");

  h.advance(TICK_MS);
  for (let tick = 0; tick < 3; tick += 1) await tickPipelines([], h.ports);

  /* The replay carried the same id and was answered; it is judged from the first send. */
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]!.clientMessageId).toBe(h.requests[0]!.clientMessageId);
  expect(study().commitRepair).toMatchObject({ refusedAt, requestedAt: "2026-10-07T09:00:01.000Z" });
  expect(study()).toMatchObject({ state: "passed" });
  const advanced = loadPipelines()[0]!;
  expect(advanced.state).toBe("running");
  expect(advanced.cursor?.stageId).toBe("verify");
  expect(advanced.lastPassedCommit).toBe(STAGE_HEAD);
  expect(h.calls.filter((call) => call.startsWith("git commit"))).toHaveLength(2);
  /* The stage ran no other turn: its one launch, and the next stage's. */
  expect(study().launchId).toBe("launch-1");
});

test("a request the surface refused outright is judged from the send it later accepted", async () => {
  const h = harness();
  await runningStage(h);
  h.answerRequests("refused", "accepted");
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);
  expect(study().commitRepair!.sendingAt).toBeUndefined();

  h.advance(TICK_MS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(2);
  expect(study().commitRepair).toMatchObject({ requestedAt: "2026-10-07T09:00:31.000Z" });
});

test("a request admitted without acknowledgement keeps its moment through a later outright refusal", async () => {
  const h = harness();
  await runningStage(h);
  h.answerRequests("admitted-unacknowledged", "refused", "accepted");
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);
  h.advance(TICK_MS);
  await tickPipelines([], h.ports);
  h.advance(TICK_MS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(3);
  expect(study().commitRepair).toMatchObject({ requestedAt: "2026-10-07T09:00:01.000Z" });
});

test("a lock failure after the repair request parks with the lock's cause first and the hook's output kept", async () => {
  const h = harness();
  await runningStage(h);
  h.hookAnswers(refusal(WHITESPACE_REFUSAL));
  h.advance(1_000);
  h.endTurn(PASS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);

  const lock = path.join(pipelineArtifactsDir(loadPipelines()[0]!.id), "remote-action.lock");
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock, { recursive: true });
  h.advance(TICK_MS);
  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("EISDIR");
  expect(parked.stateDetail!.split("\n")[0]).toContain("EISDIR");
  expect(parked.stateDetail).toContain(`committing the passed stage: ${WHITESPACE_REFUSAL}`);
  expect(study().error).toBe(parked.stateDetail);
});

/* ---------- publication after a repaired commit, against a real remote and a real pre-push hook ---------- */

/** A remote-publishing lane whose passed stage was refused at commit, repaired
    itself, and committed: its commit is accepted and its publication is next. */
function repairedPublication() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-commit-repair-publication-"));
  const repo = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  let cwd = repo;
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main"); git("init", "-q", "--bare", remote);
  git("commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const lane = pipelineCorpus(2, 1)[1]!;
  git("checkout", "-q", "-b", lane.branch);
  writeOutput(repo, OUTPUT, "+ a line the stage wrote\n");
  git("add", "."); git("commit", "-q", "-m", "passed stage");
  const passed = git("rev-parse", "HEAD");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
  const checkout = `${repo}-pipeline-${lane.id}`;
  git("checkout", "-q", "main"); git("worktree", "add", "-q", checkout, lane.branch); cwd = checkout;
  Object.assign(lane, { repoDir: repo, worktreeDir: checkout, baseRef: base, baseBranch: "main", state: "running", closedAt: null,
    stateDetail: null, publication: "remote-branch", lastPassedCommit: passed, publishedCommit: null,
    cursor: { stageId: "build", state: "committing", input: null, activatedBy: null } });
  lane.stages = [lane.stages[0]!]; lane.stages[0]!.next = null; lane.runs = [lane.runs[0]!];
  const attempt = lane.runs[0]!.attempts[0]!;
  Object.assign(attempt, { state: "passed", verdict: { status: "pass", findings: [] }, agentPath: null, conversationId: null, launchId: null, paneId: null,
    commitRepair: { refusedAt: "2026-10-07T09:00:01.000Z", detail: `committing the passed stage: ${WHITESPACE_REFUSAL}`, paths: [OUTPUT],
      messageTs: 1, requestedAt: "2026-10-07T09:00:01.000Z", clientMessageId: "stage-commit-repair", settledAt: "2026-10-07T09:01:01.000Z" } });
  lane.delivery = { target: { repository: `fixture-${lane.id}`, remote, branch: `refs/heads/${lane.branch}` },
    disposition: "owner", publish: "enabled", ownerId: lane.id, epoch: 1, active: true, journal: [] };
  savePipelines([lane]);
  const ports = { ...defaultPipelinePorts(), exec: realExec, conversationAgentActive: async () => false, stageHostResident: async () => false,
    paneAgentAlive: async () => false, getFlow: () => null, worktreePresent: () => true };
  return { root, checkout, git, lane, ports, hook: path.join(repo, ".git", "hooks", "pre-push"),
    current: () => findPipelineRecord(lane.id)!,
    tick: async () => { for (let n = 0; n < 3; n += 1) await tickPipelines([], ports); } };
}

test.each([
  ["the pre-push hook refuses the repaired head", "publishing the passed stage: ", (h: ReturnType<typeof repairedPublication>) => {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: touched tests' >&2\necho '(fail) the stage broke this [2.00ms]' >&2\nexit 1\n", { mode: 0o700 });
  }],
  ["the worktree moved past the repaired head", "the worktree moved to ", (h: ReturnType<typeof repairedPublication>) => {
    fs.writeFileSync(path.join(h.checkout, "later.txt"), "later\n");
    h.git("add", "."); h.git("commit", "-q", "-m", "later work");
  }],
] as const)("when %s, the park keeps the hook's output after its own cause", async (_name, cause, breakPublication) => {
  const h = repairedPublication();
  try {
    breakPublication(h);
    await h.tick();
    const parked = h.current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toStartWith(cause);
    expect(parked.stateDetail).toContain(`committing the passed stage: ${WHITESPACE_REFUSAL}`);
    expect(parked.stateDetail!.indexOf(WHITESPACE_REFUSAL)).toBeGreaterThan(parked.stateDetail!.indexOf("\n"));
    expect(parked.runs[0]!.attempts[0]!.error).toBe(parked.stateDetail);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});
