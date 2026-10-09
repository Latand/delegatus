import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENGINE_MODELS } from "@/lib/agent/models";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import { realExec } from "./provision";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wf-engine-test-"));
const { createWorkflowFromRequest, patchWorkflow, tickWorkflows } = await import("./engine");
const { accountManager } = await import("@/lib/accounts/manager");
const { loadWorkflows, saveWorkflows } = await import("./store");
const { writeDrain, drainFile, releaseDrain } = await import("@/lib/selfUpdate/drain");

type Workflow = import("./types").Workflow;
type WorkflowPorts = import("./engine").WorkflowPorts;
type ExecResult = import("./provision").ExecResult;

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

const STAGES = [
  { kind: "implement", agent: { engine: "codex", model: null, effort: "xhigh" }, scope: "Backend/API" },
  { kind: "implement", agent: { engine: "claude", model: "fable", effort: null }, scope: "UI/frontend" },
  {
    kind: "review-loop",
    reviewer: { engine: "codex", model: null, effort: "xhigh" },
    fixer: { engine: "codex", model: null, effort: "low" },
    roundLimit: 5,
    reviewerMode: "headless",
  },
] as const;

function entryFor(pathname: string, engine: "claude" | "codex", mtime: number): FileEntry {
  return {
    path: pathname,
    root: engine === "claude" ? "claude-projects" : "codex-sessions",
    name: path.basename(pathname),
    project: "repo-wf",
    title: "agent",
    engine,
    kind: "session",
    fmt: engine,
    parent: null,
    mtime,
    size: 100,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function writeCodexEntry(name: string, payload: Record<string, unknown>, mtime: number): FileEntry {
  const pathname = path.join(process.env.LLV_STATE_DIR!, "codex-fixtures", name);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, JSON.stringify({ type: "session_meta", payload }) + "\n");
  return { ...entryFor(pathname, "codex", mtime), size: fs.statSync(pathname).size };
}

/**
 * A scripted harness: every port is observable and answers from mutable
 * state, so tests walk the machine tick by tick without tmux, git or flows.
 */
function makeHarness() {
  const calls: string[] = [];
  const state = {
    execFail: null as string | null, // subcommand marker that should fail
    dirtyWorktree: false,
    spawnFail: false,
    paneDead: new Set<string>(),
    messages: new Map<string, { text: string; ts: number }>(),
    cwds: new Map<string, string>(),
    setup: "done" as "running" | "done" | "failed",
    setupDetail: "",
    flows: new Map<string, Flow>(),
    createFlowError: null as string | null,
    spawnCount: 0,
    spawnTitles: [] as (string | undefined)[],
    prUrl: "https://github.com/o/r/pull/9",
    nowTick: 1_000_000,
  };
  const now = () => new Date((state.nowTick += 1000)).toISOString();
  const ports: WorkflowPorts = {
    exec: (command, args, cwd) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(`exec:${key} @${cwd}`);
      if (state.execFail && key.includes(state.execFail)) return { code: 1, stdout: "", stderr: `${state.execFail} boom` } as ExecResult;
      if (args[0] === "status" && state.dirtyWorktree) return { code: 0, stdout: " M src/x.ts\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "basesha\n", stderr: "" };
      if (command === "gh" && args[1] === "create") return { code: 0, stdout: state.prUrl + "\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    startSetup: () => {
      calls.push("startSetup");
      return { pid: 4242 };
    },
    setupStatus: () => ({ status: state.setup, detail: state.setupDetail }),
    spawnAgent: async (role, cwd, prompt, _accountId, title) => {
      calls.push(`spawn:${role.engine}:${role.effort ?? role.model ?? "default"}`);
      state.spawnTitles.push(title);
      if (state.spawnFail) throw new Error("tmux window failed to open");
      state.spawnCount += 1;
      const transcript = role.engine === "claude" ? `/claude/agent-${state.spawnCount}.jsonl` : null;
      if (transcript) state.cwds.set(transcript, cwd);
      void prompt;
      return { paneId: `%${state.spawnCount}`, transcript, panePid: 100 + state.spawnCount };
    },
    paneAgentAlive: async (paneId) => !state.paneDead.has(paneId),
    headCwd: (transcript) => state.cwds.get(transcript) ?? null,
    lastMessage: (entry) => state.messages.get(entry.path) ?? null,
    createFlow: async (req) => {
      calls.push(`createFlow:${req.implementerPath}:${req.baseRef}`);
      if (state.createFlowError) return { error: state.createFlowError };
      const flow = {
        id: "flow1234",
        implementerPath: req.implementerPath,
        state: "waiting_ready",
        rounds: [],
        closedAt: null,
        createdAt: now(),
      } as unknown as Flow;
      state.flows.set(flow.id, flow);
      return { flow };
    },
    advanceFlow: (id, note) => calls.push(`advanceFlow:${id}:${note.slice(0, 20)}`),
    closeFlow: async (id) => {
      calls.push(`closeFlow:${id}`);
      const flow = state.flows.get(id);
      if (flow) {
        flow.state = "closed";
        flow.closedAt = now();
      }
    },
    getFlow: (id) => state.flows.get(id) ?? null,
    findFlowByImplementer: (implementerPath) =>
      [...state.flows.values()].find((flow) => flow.implementerPath === implementerPath) ?? null,
    projectForCwd: (cwd) => (cwd === "/repos/repo" ? "repo" : null),
    linkChild: (child, parent) => calls.push(`link:${child}<-${parent}`),
    now,
  };
  return { ports, calls, state };
}

async function createWf(ports: WorkflowPorts, overrides: Partial<Parameters<typeof createWorkflowFromRequest>[0]> = {}): Promise<Workflow> {
  saveWorkflows([]);
  const res = (await createWorkflowFromRequest(
    { task: "Build the thing", repoDir: "/repos/repo", stages: STAGES as never, mode: "auto", ...overrides },
    ports,
  ));
  if (!res.workflow) throw new Error(res.error);
  return res.workflow;
}

function load(id: string): Workflow {
  const wf = loadWorkflows().find((item) => item.id === id);
  if (!wf) throw new Error("workflow disappeared from the store");
  return wf;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function prepareMergeCancellation(harness: ReturnType<typeof makeHarness>) {
  const wf = await createWf(harness.ports);
  const repoDir = path.join(process.env.LLV_STATE_DIR!, `merge-cancel-${wf.id}`);
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Workflow Test");
  git(repoDir, "config", "user.email", "noreply@example.invalid");
  fs.writeFileSync(path.join(repoDir, "base.txt"), "base\n");
  git(repoDir, "add", "base.txt");
  git(repoDir, "commit", "-m", "base");
  const base = git(repoDir, "rev-parse", "HEAD");
  git(repoDir, "switch", "-c", wf.branch);
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");
  git(repoDir, "add", "feature.txt");
  git(repoDir, "commit", "-m", "feature");
  git(repoDir, "switch", "main");

  const hooks = path.join(repoDir, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const ready = path.join(repoDir, ".git", "merge-hook-ready");
  const release = path.join(repoDir, ".git", "merge-hook-release");
  fs.writeFileSync(path.join(hooks, "prepare-commit-msg"),
    `#!/bin/sh\ntouch ${JSON.stringify(ready)}\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done\n`, { mode: 0o700 });

  const workflows = loadWorkflows();
  const current = workflows.find((item) => item.id === wf.id)!;
  current.state = "finishing";
  current.repoDir = repoDir;
  current.worktreeDir = path.join(repoDir, "workflow-worktree");
  current.baseRef = base;
  current.baseBranch = "main";
  current.template.finish = "merge";
  saveWorkflows(workflows);

  const original = harness.ports.exec;
  harness.ports.exec = (command, args, cwd, env, options) => cwd === repoDir
    ? realExec(command, args, cwd, env, options)
    : original(command, args, cwd, env, options);
  return { workflow: current, repoDir, base, ready, release };
}

async function waitForFile(filename: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filename) && Date.now() < deadline) await Bun.sleep(10);
  expect(fs.existsSync(filename)).toBe(true);
}

/** Marks the agent's turn as finished with the given last message. */
function finishTurn(harness: ReturnType<typeof makeHarness>, transcript: string, text: string): FileEntry {
  const entry = entryFor(transcript, transcript.startsWith("/claude") ? "claude" : "codex", harness.state.nowTick / 1000 + 10);
  harness.state.messages.set(transcript, { text, ts: harness.state.nowTick + 100_000 });
  return entry;
}

test("createWorkflowFromRequest validates task, repo and stages", async () => {
  const { ports } = makeHarness();
  expect((await createWorkflowFromRequest({ task: " ", repoDir: "/r", stages: STAGES as never }, ports)).status).toBe(400);
  expect((await createWorkflowFromRequest({ task: "t", repoDir: "/r", stages: [] as never }, ports)).status).toBe(400);
  expect((await createWorkflowFromRequest({ task: "t", repoDir: "/r", template: "nope" }, ports)).status).toBe(400);
  const { ports: failing, state } = makeHarness();
  state.execFail = "--git-dir";
  expect((await createWorkflowFromRequest({ task: "t", repoDir: "/r", stages: STAGES as never }, failing)).status).toBe(400);
});

test("createWorkflowFromRequest rejects unknown implementer, reviewer, and fixer models before persistence", async () => {
  const { ports } = makeHarness();
  const expected = `invalid codex model id "gpt-fabricated"; valid codex model ids: ${ENGINE_MODELS.codex.map((option) => option.id).join(", ")}`;
  const cases = [
    [
      { ...STAGES[0], agent: { ...STAGES[0].agent, model: "gpt-fabricated" } },
      STAGES[1],
      STAGES[2],
    ],
    [
      STAGES[0],
      STAGES[1],
      { ...STAGES[2], reviewer: { ...STAGES[2].reviewer, model: "gpt-fabricated" } },
    ],
    [
      STAGES[0],
      STAGES[1],
      { ...STAGES[2], fixer: { ...STAGES[2].fixer, model: "gpt-fabricated" } },
    ],
  ];

  for (const stages of cases) {
    saveWorkflows([]);
    expect((await createWorkflowFromRequest({ task: "t", repoDir: "/r", stages: stages as never }, ports))).toEqual({
      error: expected,
      status: 400,
    });
    expect(loadWorkflows()).toEqual([]);
  }
});

test("createWorkflowFromRequest stamps the scanner project key, basename as fallback", async () => {
  const { ports } = makeHarness();
  const stamped = (await createWf(ports));
  expect(stamped.project).toBe("repo");
  saveWorkflows([]);
  const fallback = (await createWorkflowFromRequest(
    { task: "t", repoDir: "/elsewhere/deep/tool-dir", stages: STAGES as never },
    ports,
  ));
  expect(fallback.workflow?.project).toBe("tool-dir");
});

test.each(["auto", "manual"] as const)("update admission holds fresh %s workflow stages without consuming their launch identity", async (mode) => {
  const { ports, state } = makeHarness();
  const workflow = await createWf(ports, { mode });
  await tickWorkflows([], ports); // Provision before establishing the hold.
  writeDrain(drainFile(), { id: "workflow-drain", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
  try {
    for (let i = 0; i < 3; i++) await tickWorkflows([], ports);
    expect(state.spawnCount).toBe(mode === "auto" ? 0 : 1);
    if (mode === "auto") expect(load(workflow.id).stageRuns[0]?.startedAt).toBeNull();
    releaseDrain(drainFile(), "workflow-drain");
    for (let i = 0; i < 3; i++) await tickWorkflows([], ports);
    expect(state.spawnCount).toBe(1);
    expect(load(workflow.id).stageRuns[0]?.paneId).toBe("%1");
  } finally { releaseDrain(drainFile(), "workflow-drain"); }
});

test("long workflow tasks retain a distinct stage suffix", async () => {
  const { ports, state } = makeHarness();
  const workflow = (await createWf(ports, { task: "Long workflow task ".repeat(20) }));

  await tickWorkflows([], ports);
  await tickWorkflows([], ports);

  expect(load(workflow.id).stageRuns[0]?.paneId).toBe("%1");
  expect(state.spawnTitles[0]?.length).toBeLessThanOrEqual(120);
  expect(state.spawnTitles[0]).toEndWith(" · stage 1");
});

test("happy path: provision → two stages → review flow → PR", async () => {
  const harness = makeHarness();
  const { ports, calls, state } = harness;
  const wf = (await createWf(ports));
  expect(wf.state).toBe("provisioning");

  /* Tick 1: worktree + setup already done → implementing, stage 0 spawns. */
  await tickWorkflows([], ports);
  let cur = load(wf.id);
  expect(cur.baseRef).toBe("basesha");
  expect(cur.baseBranch).toBe("main");
  expect(cur.state).toBe("implementing");

  await tickWorkflows([], ports);
  cur = load(wf.id);
  expect(calls.some((call) => call.startsWith("spawn:codex:xhigh"))).toBe(true);
  expect(state.spawnTitles[0]).toBe("Build the thing · stage 1");
  expect(cur.stageRuns[0]!.paneId).toBe("%1");
  expect(cur.stageRuns[0]!.agentPath).toBeNull();

  /* Codex transcript appears in the worktree and gets claimed. */
  const stage0 = "/codex/rollout-1.jsonl";
  state.cwds.set(stage0, cur.worktreeDir);
  const stage0Entry = entryFor(stage0, "codex", state.nowTick / 1000 + 5);
  await tickWorkflows([stage0Entry], ports);
  cur = load(wf.id);
  expect(cur.stageRuns[0]!.agentPath).toBe(stage0);

  /* STAGE_DONE ends stage 0; the barrier moves to stage 1 and spawns claude. */
  const doneEntry = finishTurn(harness, stage0, "All done.\nSTAGE_DONE: API contract in src/api.ts");
  await tickWorkflows([doneEntry], ports);
  cur = load(wf.id);
  expect(cur.stageRuns[0]!.doneNote).toBe("API contract in src/api.ts");
  expect(cur.stageIndex).toBe(1);
  expect(cur.state).toBe("implementing");

  await tickWorkflows([doneEntry], ports);
  cur = load(wf.id);
  expect(calls.some((call) => call.startsWith("spawn:claude:fable"))).toBe(true);
  expect(state.spawnTitles[1]).toBe("Build the thing · stage 2");
  const stage1 = cur.stageRuns[1]!.agentPath!;
  expect(stage1).toContain("/claude/");
  /* Lineage: the UI stage descends from the backend stage. */
  expect(calls).toContain(`link:${stage1}<-${stage0}`);

  /* Stage 1 finishes → review stage: fixer spawns, flow created + advanced. */
  const uiDone = finishTurn(harness, stage1, "STAGE_DONE: UI wired to the API");
  await tickWorkflows([uiDone], ports);
  await tickWorkflows([uiDone], ports);
  cur = load(wf.id);
  expect(cur.state).toBe("reviewing");
  expect(calls.some((call) => call.startsWith("spawn:codex:low"))).toBe(true);
  expect(state.spawnTitles[2]).toBe("Build the thing · review fixer");

  const fixer = "/codex/rollout-fixer.jsonl";
  state.cwds.set(fixer, cur.worktreeDir);
  const fixerEntry = entryFor(fixer, "codex", state.nowTick / 1000 + 5);
  await tickWorkflows([fixerEntry], ports);
  await tickWorkflows([fixerEntry], ports);
  cur = load(wf.id);
  expect(cur.fixerPath).toBe(fixer);
  expect(cur.flowId).toBe("flow1234");
  expect(calls.some((call) => call.startsWith(`createFlow:${fixer}:basesha`))).toBe(true);
  expect(calls.some((call) => call.startsWith("advanceFlow:flow1234"))).toBe(true);

  /* The flow approves → finishing → push + PR → approved with the URL. */
  state.flows.get("flow1234")!.state = "approved";
  state.flows.get("flow1234")!.rounds = [{ n: 1, verdict: "APPROVE", findingsCount: 0 }] as never;
  await tickWorkflows([fixerEntry], ports);
  cur = load(wf.id);
  expect(cur.state).toBe("finishing");
  await tickWorkflows([fixerEntry], ports);
  cur = load(wf.id);
  expect(cur.state).toBe("approved");
  expect(cur.prUrl).toBe("https://github.com/o/r/pull/9");
  expect(calls.some((call) => call.includes("git push -u origin " + cur.branch))).toBe(true);
});

test("provisioning failures park the workflow: worktree add, setup start, setup exit", async () => {
  const worktree = makeHarness();
  worktree.state.execFail = "worktree add";
  const wf1 = (await createWf(worktree.ports));
  await tickWorkflows([], worktree.ports);
  let cur = load(wf1.id);
  expect(cur.state).toBe("needs_decision");
  expect(cur.stateDetail).toContain("worktree add");
  expect(cur.pausedState).toBe("provisioning");

  const setup = makeHarness();
  setup.state.setup = "failed";
  setup.state.setupDetail = "setup exited with code 3: boom";
  const wf2 = (await createWf(setup.ports, { setup: "bun install" }));
  /* createWf builds an ad-hoc template; setup comes from the request.
     Tick 1 starts the detached setup, tick 2 sees its failure. */
  await tickWorkflows([], setup.ports);
  await tickWorkflows([], setup.ports);
  cur = load(wf2.id);
  expect(cur.state).toBe("needs_decision");
  expect(cur.stateDetail).toContain("code 3");
});

test("a failed stage spawn parks; retry-stage respawns fresh", async () => {
  const harness = makeHarness();
  harness.state.spawnFail = true;
  const wf = (await createWf(harness.ports));
  await tickWorkflows([], harness.ports); // provision → implementing
  await tickWorkflows([], harness.ports); // spawn fails
  let cur = load(wf.id);
  expect(cur.state).toBe("needs_decision");
  expect(cur.stateDetail).toContain("tmux window failed");

  harness.state.spawnFail = false;
  const patched = await patchWorkflow(wf.id, { action: "retry-stage" }, harness.ports);
  expect(patched.workflow?.state).toBe("implementing");
  expect(patched.workflow?.stageRuns[0]!.startedAt).toBeNull();
  await tickWorkflows([], harness.ports);
  cur = load(wf.id);
  expect(cur.stageRuns[0]!.paneId).toBe("%1");
  expect(cur.state).toBe("implementing");
});

test("pause during spawn preserves operator state and the spawned pane binding", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  await tickWorkflows([], harness.ports); // provision → implementing
  const spawn = harness.ports.spawnAgent;
  harness.ports.spawnAgent = async (...args) => {
    const paused = await patchWorkflow(wf.id, { action: "pause" }, harness.ports);
    expect(paused.workflow?.state).toBe("paused");
    return spawn(...args);
  };
  await tickWorkflows([], harness.ports);
  const current = load(wf.id);
  expect(current.state).toBe("paused");
  expect(current.pausedState).toBe("implementing");
  expect(current.stageRuns[0]).toMatchObject({ paneId: "%1", startedAt: expect.any(String) });
});

test("a stage agent pane dying before STAGE_DONE parks the workflow", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  await tickWorkflows([], harness.ports);
  await tickWorkflows([], harness.ports); // stage 0 spawned, pane %1
  harness.state.paneDead.add("%1");
  await tickWorkflows([], harness.ports);
  const cur = load(wf.id);
  expect(cur.state).toBe("needs_decision");
  expect(cur.stateDetail).toContain("died");
});

test("workflow fallback claim skips a newer native Codex subagent", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  await tickWorkflows([], harness.ports);
  await tickWorkflows([], harness.ports);
  let cur = load(wf.id);
  const started = Date.parse(cur.stageRuns[0]!.startedAt!) / 1000;
  const rootId = ["019f421e", "02e1", "73e0", "9b77", "bebde063f10a"].join("-");
  const childId = ["019f423a", "d6e9", "7903", "b597", "3e676b6ff3d4"].join("-");
  const root = writeCodexEntry(`rollout-root-${rootId}.jsonl`, { id: rootId, cwd: cur.worktreeDir }, started + 5);
  const nativeChild = writeCodexEntry(
    `rollout-child-${childId}.jsonl`,
    {
      id: childId,
      parent_thread_id: rootId,
      cwd: cur.worktreeDir,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
    },
    started + 10,
  );
  harness.state.cwds.set(root.path, cur.worktreeDir);
  harness.state.cwds.set(nativeChild.path, cur.worktreeDir);

  await tickWorkflows([nativeChild, root], harness.ports);
  cur = load(wf.id);

  expect(cur.stageRuns[0]!.agentPath).toBe(root.path);
});

test("a spawn interrupted by a restart parks instead of double-spawning", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  await tickWorkflows([], harness.ports);
  /* Simulate the persisted mid-spawn shape from a previous process. */
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "implementing";
  cur.stageRuns[0]!.startedAt = new Date().toISOString();
  saveWorkflows(workflows);
  await tickWorkflows([], harness.ports);
  const after = load(wf.id);
  expect(after.state).toBe("needs_decision");
  expect(after.stateDetail).toContain("interrupted by a restart");
});

test("embedded flow trouble parks the workflow: create error, needs_decision, COMMENT, closed", async () => {
  const cases: { mutate: (harness: ReturnType<typeof makeHarness>) => void; detail: string }[] = [
    { mutate: (harness) => (harness.state.createFlowError = "no cwd"), detail: "creating the review flow failed" },
    { mutate: (harness) => harness.state.flows.set("flow1234", { id: "flow1234", state: "needs_decision", stateDetail: "round limit reached", rounds: [], closedAt: null } as never), detail: "round limit reached" },
    { mutate: (harness) => harness.state.flows.set("flow1234", { id: "flow1234", state: "done_comment", rounds: [], closedAt: null } as never), detail: "COMMENT" },
    { mutate: (harness) => harness.state.flows.set("flow1234", { id: "flow1234", state: "closed", rounds: [], closedAt: "t" } as never), detail: "was closed" },
  ];
  for (const testCase of cases) {
    const harness = makeHarness();
    const wf = (await createWf(harness.ports));
    const workflows = loadWorkflows();
    const cur = workflows.find((item) => item.id === wf.id)!;
    /* Jump straight to the bootstrapped review stage. */
    cur.state = "reviewing";
    cur.stageIndex = 2;
    cur.baseRef = "basesha";
    cur.baseBranch = "main";
    cur.stageRuns[2]! = { ...cur.stageRuns[2]!, startedAt: "2026-01-01T00:00:00Z", paneId: "%9", agentPath: "/codex/fixer.jsonl" };
    cur.fixerPath = "/codex/fixer.jsonl";
    if (testCase.detail !== "creating the review flow failed") cur.flowId = "flow1234";
    saveWorkflows(workflows);
    testCase.mutate(harness);
    await tickWorkflows([], harness.ports);
    const after = load(wf.id);
    expect(after.state).toBe("needs_decision");
    expect(after.stateDetail).toContain(testCase.detail);
  }
});

test.each((["finishing", "provisioning"] as const).flatMap((phase) => (["pause", "close", "cycle"] as const).map((action) => [phase, action] as const)))("async workflow %s respects %s", async (phase, action) => {
    const h = makeHarness(), wf = await createWf(h.ports);
    const rows = loadWorkflows(), current = rows.find((item) => item.id === wf.id)!;
    current.state = phase; current.stateDetail = "resumed by operator";
    current.baseRef = phase === "finishing" ? "basesha" : ""; current.baseBranch = "main";
    saveWorkflows(rows);
    let entered!: () => void, release!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = h.ports.exec; let first = true, signal: AbortSignal | undefined;
    h.ports.exec = async (...args) => {
      if (first) { first = false; signal = args[4]?.signal; entered(); await held; }
      return await original(...args);
    };
    h.calls.length = 0;
    const work = tickWorkflows([], h.ports);
    try {
      await checking;
      await patchWorkflow(wf.id, { action: action === "cycle" ? "pause" : action }, h.ports);
      if (action === "cycle") await patchWorkflow(wf.id, { action: "resume" }, h.ports);
      await Bun.sleep(75); expect(signal?.aborted).toBe(true);
      release(); await work;
      expect(h.calls.some((call) => call.includes("git push") || call.includes("gh pr create") || call.includes("git worktree add"))).toBe(false);
      expect(load(wf.id)).toMatchObject({ state: action === "cycle" ? phase : action === "close" ? "closed" : "paused", prUrl: null });
    } finally { release(); await work; }
});

test.each(["pause", "close"] as const)("workflow %s during its merge preserves pending state for recovery", async (action) => {
  const h = makeHarness();
  const merge = await prepareMergeCancellation(h);
  const work = tickWorkflows([], h.ports);
  try {
    await waitForFile(merge.ready);
    expect(git(merge.repoDir, "rev-parse", "MERGE_HEAD")).not.toBe("");
    await patchWorkflow(merge.workflow.id, { action }, h.ports);
    const controlled = load(merge.workflow.id);
    await Bun.sleep(75);
    fs.writeFileSync(merge.release, "continue");
    await work;

    const after = load(merge.workflow.id);
    expect(after.state).toBe(action === "pause" ? "paused" : "closed");
    expect(after.controlGeneration).toBe(controlled.controlGeneration);
    expect(after.closedAt).toBe(controlled.closedAt);
    expect(after.stateDetail).toContain("recovery");
    if (action === "pause") expect(after.pausedState).toBe("finishing");
    expect(git(merge.repoDir, "rev-parse", "HEAD")).toBe(merge.base);
    expect(spawnSync("git", ["rev-parse", "--verify", "MERGE_HEAD"], { cwd: merge.repoDir }).status).toBe(0);
    expect(git(merge.repoDir, "show", ":feature.txt")).toBe("feature");
  } finally {
    fs.writeFileSync(merge.release, "continue");
    await work;
  }
});

test("merge cancellation preserves new operator files and records recovery when ownership is uncertain", async () => {
  const h = makeHarness();
  const merge = await prepareMergeCancellation(h);
  const work = tickWorkflows([], h.ports);
  try {
    await waitForFile(merge.ready);
    await patchWorkflow(merge.workflow.id, { action: "pause" }, h.ports);
    fs.writeFileSync(path.join(merge.repoDir, "operator-note.txt"), "keep this\n");
    await Bun.sleep(75);
    fs.writeFileSync(merge.release, "continue");
    await work;

    expect(load(merge.workflow.id)).toMatchObject({ state: "paused", stateDetail: expect.stringContaining("recovery") });
    expect(fs.readFileSync(path.join(merge.repoDir, "operator-note.txt"), "utf8")).toBe("keep this\n");
    expect(spawnSync("git", ["rev-parse", "--verify", "MERGE_HEAD"], { cwd: merge.repoDir }).status).toBe(0);
  } finally {
    fs.writeFileSync(merge.release, "continue");
    await work;
  }
});

test("a finish failure parks; retry-stage reruns the finish", async () => {
  const harness = makeHarness();
  harness.state.execFail = "push";
  const wf = (await createWf(harness.ports));
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "finishing";
  cur.baseRef = "basesha";
  cur.baseBranch = "main";
  saveWorkflows(workflows);
  await tickWorkflows([], harness.ports);
  let after = load(wf.id);
  expect(after.state).toBe("needs_decision");
  expect(after.stateDetail).toContain("push");

  harness.state.execFail = null;
  await patchWorkflow(wf.id, { action: "retry-stage" }, harness.ports);
  await tickWorkflows([], harness.ports);
  after = load(wf.id);
  expect(after.state).toBe("approved");
  expect(after.prUrl).toBe("https://github.com/o/r/pull/9");
});

test("finishing a dirty worktree parks; retry after the commit publishes", async () => {
  const harness = makeHarness();
  harness.state.dirtyWorktree = true;
  const wf = (await createWf(harness.ports));
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "finishing";
  cur.baseRef = "basesha";
  cur.baseBranch = "main";
  saveWorkflows(workflows);
  await tickWorkflows([], harness.ports);
  let after = load(wf.id);
  expect(after.state).toBe("needs_decision");
  expect(after.stateDetail).toContain("uncommitted changes");
  expect(after.stateDetail).toContain("src/x.ts");
  expect(harness.calls.some((call) => call.includes("git push"))).toBe(false);

  harness.state.dirtyWorktree = false;
  await patchWorkflow(wf.id, { action: "retry-stage" }, harness.ports);
  await tickWorkflows([], harness.ports);
  after = load(wf.id);
  expect(after.state).toBe("approved");
  expect(after.prUrl).toBe("https://github.com/o/r/pull/9");
});

test("manual mode gates every stage boundary until advance", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports, { mode: "manual" }));
  await tickWorkflows([], harness.ports); // provision → implementing
  await tickWorkflows([], harness.ports); // spawn stage 0
  const stage0 = "/codex/rollout-1.jsonl";
  harness.state.cwds.set(stage0, load(wf.id).worktreeDir);
  const entry = entryFor(stage0, "codex", harness.state.nowTick / 1000 + 5);
  await tickWorkflows([entry], harness.ports); // claim
  const done = finishTurn(harness, stage0, "STAGE_DONE: backend ready");
  await tickWorkflows([done], harness.ports);
  const cur = load(wf.id);
  expect(cur.stageRuns[0]!.doneAt).not.toBeNull();
  /* The gate: the stage is done, the index has not moved. */
  expect(cur.stageIndex).toBe(0);
  await tickWorkflows([done], harness.ports);
  expect(load(wf.id).stageIndex).toBe(0);

  const patched = await patchWorkflow(wf.id, { action: "advance" }, harness.ports);
  expect(patched.workflow?.stageIndex).toBe(1);
  expect(patched.workflow?.state).toBe("implementing");
});

test("advance force-completes a running stage with the user note", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  await tickWorkflows([], harness.ports);
  await tickWorkflows([], harness.ports); // stage 0 running
  const patched = await patchWorkflow(wf.id, { action: "advance", note: "good enough" }, harness.ports);
  expect(patched.workflow?.stageRuns[0]!.doneNote).toBe("good enough");
  expect(patched.workflow?.stageIndex).toBe(1);
});

test("advance past a live review closes the embedded flow and moves to finishing", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "reviewing";
  cur.stageIndex = 2;
  cur.flowId = "flow1234";
  saveWorkflows(workflows);
  harness.state.flows.set("flow1234", { id: "flow1234", state: "reviewing", rounds: [], closedAt: null } as never);
  const patched = await patchWorkflow(wf.id, { action: "advance" }, harness.ports);
  expect(patched.workflow?.state).toBe("finishing");
  expect(harness.calls).toContain("closeFlow:flow1234");
});

test("pause holds the phase; resume returns to it", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  await tickWorkflows([], harness.ports);
  const paused = await patchWorkflow(wf.id, { action: "pause" }, harness.ports);
  expect(paused.workflow).toMatchObject({ state: "paused", stateDetail: "paused by operator" });
  await tickWorkflows([], harness.ports); // parked: the tick leaves it alone
  expect(load(wf.id).state).toBe("paused");
  const resumed = await patchWorkflow(wf.id, { action: "resume" }, harness.ports);
  expect(resumed.workflow).toMatchObject({ state: "implementing", stateDetail: "resumed by operator" });

  const actor = { kind: "agent" as const, role: "builder", conversationId: "conversation_builder" };
  const agentPause = await patchWorkflow(wf.id, { action: "pause" }, harness.ports, actor);
  expect(agentPause.workflow).toMatchObject({ state: "paused", stateDetail: "paused by builder conversation_builder" });
  const agentResume = await patchWorkflow(wf.id, { action: "resume" }, harness.ports, actor);
  expect(agentResume.workflow).toMatchObject({ state: "implementing", stateDetail: "resumed by builder conversation_builder" });
});

test("close stops the embedded flow and keeps worktree state on the record", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "reviewing";
  cur.flowId = "flow1234";
  saveWorkflows(workflows);
  harness.state.flows.set("flow1234", { id: "flow1234", state: "reviewing", rounds: [], closedAt: null } as never);
  const closed = await patchWorkflow(wf.id, { action: "close" }, harness.ports);
  expect(closed.workflow?.state).toBe("closed");
  expect(closed.workflow?.closedAt).not.toBeNull();
  expect(closed.workflow?.worktreeDir).toContain("-wf-");
  expect(harness.calls).toContain("closeFlow:flow1234");
});

test("review transitions stop when embedded reviewer teardown fails", async () => {
  for (const action of ["advance", "retry-stage", "close"] as const) {
    const harness = makeHarness();
    const wf = (await createWf(harness.ports));
    const workflows = loadWorkflows();
    const cur = workflows.find((item) => item.id === wf.id)!;
    cur.state = "reviewing";
    cur.stageIndex = 2;
    cur.flowId = "flow1234";
    saveWorkflows(workflows);
    harness.state.flows.set("flow1234", { id: "flow1234", state: "reviewing", rounds: [], closedAt: null } as never);
    harness.ports.closeFlow = async () => ({ error: "reviewer process group did not terminate", status: 409 });

    const result = await patchWorkflow(wf.id, { action }, harness.ports);

    expect(result).toEqual({ error: "reviewer process group did not terminate", status: 409 });
    expect(load(wf.id)).toMatchObject({ state: "reviewing", flowId: "flow1234", closedAt: null });
  }
});

test("an orphaned flow from a restart is adopted instead of recreated", async () => {
  const harness = makeHarness();
  const wf = (await createWf(harness.ports));
  const workflows = loadWorkflows();
  const cur = workflows.find((item) => item.id === wf.id)!;
  cur.state = "reviewing";
  cur.stageIndex = 2;
  cur.baseRef = "basesha";
  cur.stageRuns[2] = { ...cur.stageRuns[2]!, startedAt: "2026-01-01T00:00:00Z", paneId: "%9", agentPath: "/codex/fixer.jsonl" };
  cur.fixerPath = "/codex/fixer.jsonl";
  saveWorkflows(workflows);
  harness.state.flows.set("flowOld", { id: "flowOld", implementerPath: "/codex/fixer.jsonl", state: "reviewing", rounds: [], closedAt: null, createdAt: "t" } as never);
  await tickWorkflows([], harness.ports);
  const after = load(wf.id);
  expect(after.flowId).toBe("flowOld");
  expect(harness.calls.filter((call) => call.startsWith("createFlow")).length).toBe(0);
});

/* #1279: a workflow stage is a launch of the workflow's project's work, so the
   project's account binding fences it like every other launch. Both tests spy
   on the one seam that chooses, so nothing here reads or writes a real account
   catalogue. */
test("a workflow stage launches on the account the project's allowed set resolves to (#1279)", async () => {
  const { ports, calls, state } = makeHarness();
  const wf = (await createWf(ports));
  await tickWorkflows([], ports);
  /* Captured inside the mock: mockRestore() drops the recorded calls with it. */
  const asked: unknown[] = [];
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation((engine, request) => {
    asked.push([engine, request]);
    return {
      kind: "available",
      account: { engine: "codex", accountId: "acct-reserved", home: "/nowhere", transcriptRoot: "/nowhere" } as never,
    };
  });
  try {
    await tickWorkflows([], ports);
  } finally {
    resolve.mockRestore();
  }
  expect(asked).toEqual([["codex", { project: "repo", model: null }]]);
  const cur = load(wf.id);
  expect(cur.state).toBe("implementing");
  expect(cur.stageRuns[0]!.accountId).toBe("acct-reserved");
  expect(calls.some((call) => call.startsWith("spawn:codex"))).toBe(true);
  expect(state.spawnCount).toBe(1);
});

test("every allowed account out of capacity parks the workflow instead of crossing the boundary (#1279)", async () => {
  const { ports, calls } = makeHarness();
  const wf = (await createWf(ports));
  await tickWorkflows([], ports);
  const resetsAt = Math.floor(Date.parse("2026-08-30T11:00:00.000Z") / 1000);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "exhausted",
    resetsAt,
    allowedAccountIds: ["acct-reserved"],
  }));
  try {
    await tickWorkflows([], ports);
  } finally {
    resolve.mockRestore();
  }
  const parked = load(wf.id);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe(
    "no allowed codex account has capacity for project repo (allowed codex accounts: acct-reserved); resetsAt=2026-08-30T11:00:00.000Z",
  );
  /* Nothing launched, and the stage kept no half-started record: the next tick
     after the operator answers re-enters the same branch. */
  expect(calls.some((call) => call.startsWith("spawn:"))).toBe(false);
  expect(parked.stageRuns[0]!.startedAt).toBeNull();
  expect(parked.stageRuns[0]!.accountId ?? null).toBeNull();
});

test("CPU pressure holds the setup launch with a visible reason, then launches it once; a launched setup is never held", async () => {
  const { CpuPressureGate, DEFAULT_CPU_PRESSURE_POLICY } = await import("@/lib/runtime/cpuPressure");
  const harness = makeHarness();
  let pressure = 80; let clock = 0; let asked = 0;
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => pressure, now: () => clock });
  harness.ports.cpuPressureHold = () => { asked += 1; return gate.check(); };
  harness.state.setup = "running";
  const wf = await createWf(harness.ports, { setup: "bun install" });
  const starts = () => harness.calls.filter((call) => call === "startSetup").length;

  await tickWorkflows([], harness.ports);
  expect(starts()).toBe(0);
  expect(load(wf.id)).toMatchObject({ state: "provisioning", setupPid: null, stateDetail: "setup held for CPU pressure since 1970-01-01T00:00:00.000Z (avg10 80% ≥ 20%)" });
  clock = 120_000;
  await tickWorkflows([], harness.ports);
  expect(starts()).toBe(0);
  expect(load(wf.id).stateDetail).toStartWith("setup deferred by CPU pressure: held since 1970-01-01T00:00:00.000Z");

  pressure = 5; clock = 130_000;
  await tickWorkflows([], harness.ports);
  expect(starts()).toBe(0); // the release window has only begun
  clock = 140_000;
  await tickWorkflows([], harness.ports);
  expect(starts()).toBe(1);
  expect(load(wf.id)).toMatchObject({ state: "provisioning", setupPid: 4242, stateDetail: null });

  // Observation of the launched setup never asks, whatever the pressure reads.
  pressure = 95; const before = asked;
  await tickWorkflows([], harness.ports);
  harness.state.setup = "done";
  await tickWorkflows([], harness.ports);
  expect(asked).toBe(before);
  expect(starts()).toBe(1);
  expect(load(wf.id).state).toBe("implementing");
});

test("CPU pressure holds every stage-agent start before its launch is stamped, then starts it once; a started stage is never held", async () => {
  const { CpuPressureGate, DEFAULT_CPU_PRESSURE_POLICY } = await import("@/lib/runtime/cpuPressure");
  const harness = makeHarness();
  const { ports, state } = harness;
  let pressure = 80; let clock = 0; let asked = 0;
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => pressure, now: () => clock });
  ports.cpuPressureHold = () => { asked += 1; return gate.check(); };
  const wf = await createWf(ports);
  expect(wf.template.setup ?? null).toBeNull();

  for (let i = 0; i < 4; i++) await tickWorkflows([], ports);
  expect(state.spawnCount).toBe(0);
  expect(load(wf.id)).toMatchObject({ state: "implementing", stateDetail: "stage start held for CPU pressure since 1970-01-01T00:00:00.000Z (avg10 80% ≥ 20%)" });
  expect(load(wf.id).stageRuns[0]!.startedAt).toBeNull();
  clock = 120_000;
  await tickWorkflows([], ports);
  expect(load(wf.id).stateDetail).toStartWith("stage start deferred by CPU pressure: held since 1970-01-01T00:00:00.000Z");

  pressure = 5; clock = 130_000;
  await tickWorkflows([], ports);
  expect(state.spawnCount).toBe(0); // the ten-second release window has only begun
  clock = 140_000;
  await tickWorkflows([], ports);
  expect(state.spawnCount).toBe(1);
  expect(load(wf.id).stateDetail).toBeNull();
  expect(load(wf.id).stageRuns[0]!.startedAt).not.toBeNull();

  // Observing the started stage never asks, whatever the pressure reads.
  pressure = 95; const before = asked;
  const stage0 = "/codex/rollout-held.jsonl";
  state.cwds.set(stage0, load(wf.id).worktreeDir);
  const claimed = entryFor(stage0, "codex", state.nowTick / 1000 + 5);
  await tickWorkflows([claimed], ports);
  await tickWorkflows([claimed], ports);
  expect(asked).toBe(before);
  expect(load(wf.id).stageRuns[0]!.agentPath).toBe(stage0);

  // The next stage asks again before its own start.
  const done = finishTurn(harness, stage0, "STAGE_DONE: API");
  for (let i = 0; i < 3; i++) await tickWorkflows([done], ports);
  expect(load(wf.id).stageIndex).toBe(1);
  expect(state.spawnCount).toBe(1);
  expect(load(wf.id).stageRuns[1]!.startedAt).toBeNull();
  expect(load(wf.id).stateDetail).toStartWith("stage start held for CPU pressure since ");
});

test("a failed CPU-pressure sample admits a workflow stage start", async () => {
  const { CpuPressureGate, DEFAULT_CPU_PRESSURE_POLICY } = await import("@/lib/runtime/cpuPressure");
  const { ports, state } = makeHarness();
  const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => { throw new Error("no /proc/pressure/cpu"); }, now: () => 0 });
  ports.cpuPressureHold = () => gate.check();
  const wf = await createWf(ports);
  await tickWorkflows([], ports);
  await tickWorkflows([], ports);
  expect(state.spawnCount).toBe(1);
  expect(load(wf.id).stateDetail).toBeNull();
});
