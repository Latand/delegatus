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
const { createPipelineFromRequest, tickPipelines } = await import("./engine");
const { commitPipelineStage } = await import("./git");
const { loadPipelines, savePipelines } = await import("./store");
const { registerPipelineTick } = await import("./controllerSignal");
type PipelinePorts = import("./engine").PipelinePorts;
type Pipeline = import("./types").Pipeline;
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
    "if ! out=$(git diff --cached --check 2>&1); then echo \"pre-commit: staged whitespace — $out\" >&2; exit 1; fi",
    "",
  ].join("\n"), { mode: 0o755 });
  const subject = {
    id: "12345678", task: "task", taskIds: [], project: "viewer", repoDir: repo, worktreeDir: repo,
    branch: "main", baseBranch: "", baseRef: "", lastPassedCommit: run("rev-parse", "HEAD"),
    stages: [], runs: [], cursor: null, state: "running", pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: "now", closedAt: null,
  } as unknown as Pipeline;
  return { root, repo, exec, run, calls, subject, breakHook: () => fs.writeFileSync(path.join(repo, ".git", "hook-broken"), "") };
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

/* ---------- the controller, over an isolated store ---------- */

function harness(options: { access?: "read-only" | "read-write" } = {}) {
  const access = options.access ?? "read-write";
  const requests: Array<{ conversationId: string; transcriptPath: string; clientMessageId: string; text: string; cohortAt?: string }> = [];
  let wall = Date.parse("2026-10-07T09:00:00.000Z");
  let turn: StageTurnEvidence = { turn: "busy", message: null, lastRecordAt: wall };
  let requestAccepted = true;
  let head = BASE_SHA;
  let remote = BASE_SHA;
  let spawns = 0;
  /** What the stage left uncommitted, and what the hook answers to a commit. */
  let dirty: string[] = [OUTPUT];
  let hook: ExecResult = { code: 0, stdout: "", stderr: "" };
  let committedBody = "";
  const calls: string[] = [];
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs) => {
      calls.push(`${rawCommand} ${rawArgs.join(" ")}`);
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
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
    hookAnswers: (result: ExecResult) => { hook = result; },
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
  expect(parked.stateDetail).toBe(`committing the passed stage: ${second}`);
  expect(study()).toMatchObject({ state: "needs_decision", error: parked.stateDetail });
  /* The stage was asked exactly once. */
  expect(h.requests).toHaveLength(1);
});

test.each([
  ["a hook failure no stage file names", refusal("gate-slot: no slot became free within 600s"), "committing the passed stage: gate-slot: no slot became free within 600s"],
  ["a commit killed at its time limit", { code: null, signal: "SIGKILL", stdout: "", stderr: WHITESPACE_REFUSAL } as ExecResult, `committing the passed stage: ${WHITESPACE_REFUSAL}`],
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
  expect(parked.stateDetail).toBe("read-only stage study modified undeclared worktree paths");
  expect(h.calls.filter((call) => call.startsWith("git commit"))).toHaveLength(1);
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
