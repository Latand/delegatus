import { expect, test, harness, create, loadPipelines, savePipelines, tickPipelines, patchPipeline, path, realProvisioningRepo, fs } from "./engine.fixture";
import { normalizeStages } from "./engine";
import { pipelineRoleLookup } from "./roles";
import { spawnSync } from "node:child_process";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { createClaudeCloudStageClient } from "./cloudClaudeClient";
import { fakeClaudeCloud } from "./claudeCloud.fixture";
import { statePath } from "@/lib/configDir";
import { resetProjectSettingsForTests, setClaudeCloudTasks } from "@/lib/projects/settings";
import type { PipelineStageInput } from "./types";

const reviewer: PipelineStageInput = { id: "review", kind: "run", runtime: "claude-cloud", role: { roleId: "reviewer" },
  engine: "claude", model: "opus", effort: "high", prompt: "Review {{task}}. {{prev.output}}", next: null };
const lane = () => loadPipelines()[0]!;
const attempt = () => lane().runs[0]!.attempts.at(-1)!;
const advancing = () => ["provisioning", "running"].includes(lane().state);

async function fixture(options: Parameters<typeof fakeClaudeCloud>[0] & { stages?: PipelineStageInput[]; repoDir?: string; tasks?: boolean } = {}) {
  await settlePipelineControllerJobs();
  resetProjectSettingsForTests();
  fs.rmSync(statePath("cloud/claude-write-access.json"), { force: true });
  const h = harness();
  let clock = Date.UTC(2026, 10, 1);
  h.ports.now = () => new Date(clock).toISOString();
  h.advanceWallClock = milliseconds => { clock += milliseconds; };
  h.ports.resolveProjectSpawn = (engine, request) => ({ kind: "available", account: { engine, accountId: request.requestedId ?? "account-a", kind: "managed",
    home: path.resolve("fixture-account"), transcriptRoot: path.resolve("fixture-account"), env: { NODE_ENV: "test" } } });
  const fake = fakeClaudeCloud(options);
  h.ports.claudeCloudClient = createClaudeCloudStageClient(fake.dependencies);
  await create(h.ports, (options.stages ?? [reviewer]) as never, { publication: "remote-branch", ...(options.repoDir ? { repoDir: options.repoDir } : {}) });
  const record = lane();
  record.inputContext = { handoffDigest: "Preserve the accepted scope." };
  record.delivery!.target.remote = "https://github.com/sample/project.git";
  record.baseBranch = "main";
  savePipelines([record]);
  expect(setClaudeCloudTasks(record.project, options.tasks === false ? [] : [{ accountId: "account-a", taskId: "task-1" }])).toBe(true);
  return { h, fake };
}

async function step(h: ReturnType<typeof harness>) {
  await tickPipelines([], h.ports);
  await settlePipelineControllerJobs();
}

test("a Claude cloud reviewer runs as one session on the account's login and settles through the shared verdict path", async () => {
  const { h, fake } = await fixture();
  try {
    for (let i = 0; i < 10 && !attempt()?.verdict; i++) await step(h);
    expect(lane().stages[0]!.runtime).toBe("claude-cloud");
    expect(attempt().definition?.runtime).toBe("claude-cloud");
    expect(fake.runCalls()).toBe(1);
    expect(h.spawnInputs).toHaveLength(0);
    expect(attempt().executionRuntime).toBe("cloud");
    expect(attempt().cloud).toMatchObject({ taskId: fake.sessionId, taskUrl: "https://claude.ai/code/session_fixture0001", environmentId: "task-1", accountId: "account-a", model: "claude-opus-5-5" });
    expect(attempt().cloud?.thread?.threadId).toBe(fake.sessionId);
    expect(attempt().verdict).toMatchObject({ status: "pass", findings: [] });
    expect(attempt().output).toBe("All checked.");
    const assignment = fake.sent.filter(text => text.startsWith("Input part")).join("");
    expect(assignment).toContain("Preserve the accepted scope.");
    expect(assignment).toContain(lane().branch);
    /* The run call carries a header only: the brief goes as the account's own follow-ups. */
    expect(JSON.stringify(fake.calls.find(call => call.path.endsWith("/run"))!.body)).not.toContain("Preserve the accepted scope.");
  } finally { fake.stop(); }
});

test("the session receipt survives a real process restart and the session completes without a second run", async () => {
  const { h, fake } = await fixture({ onSend: (text, id) => {
    if (!text.startsWith("Input part")) return null;
    fake.push(id, { type: "user", uuid: "last", message: { role: "user", content: text } });
    return { state: "queued" };
  } });
  try {
    for (let i = 0; i < 6 && !attempt()?.cloud?.taskId; i++) await step(h);
    expect(attempt().cloud?.phase).toBe("polling");
    const thread = attempt().cloud!.thread!;
    const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id], {
      env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).thread).toEqual(thread);
    fake.assistant(fake.sessionId, [{ type: "text", text: `Receipt ${thread.turnId}\nDone.\n\n\`\`\`json\n{"status":"fail","findings":["P1 — a defect"]}\n\`\`\`` }]);
    fake.endTurn(fake.sessionId, "last");
    for (let i = 0; i < 4 && !attempt().verdict; i++) { h.advanceWallClock(30_000); await step(h); }
    expect(attempt().verdict).toMatchObject({ status: "fail" });
    expect(fake.runCalls()).toBe(1);
    expect(fake.sent.filter(text => text.startsWith("Input part"))).toHaveLength(1);
  } finally { fake.stop(); }
});

test.each([
  ["no task for the account", { tasks: false }, "no Claude cloud scheduled task"],
  ["connector on the task", { task: { enabled: true, mcp_connections: [{ name: "slack" }], job_config: { ccr: { session_context: { sources: [{ git_repository: { url: "https://github.com/sample/project" } }] } } } } }, "connectors attached"],
])("an unusable launch (%s) starts nothing, keeps its cause and runs locally exactly once", async (_name, options, cause) => {
  const { h, fake } = await fixture(options as never);
  try {
    for (let i = 0; i < 6 && !h.spawnInputs.length; i++) await step(h);
    expect(fake.runCalls()).toBe(0);
    expect(fake.sent).toEqual([]);
    expect(h.spawnInputs).toHaveLength(1);
    expect(h.spawnInputs[0]!.role.engine).toBe("claude");
    expect(attempt().executionRuntime).toBe("cloud-then-local");
    expect(attempt().cloud?.fallback?.reason).toContain(cause);
    expect(lane().stateDetail ?? "").not.toContain("Codex");
    const restarted = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id], {
      env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
    expect(restarted.status).toBe(0);
    expect(JSON.parse(restarted.stdout).fallback).toEqual(attempt().cloud?.fallback);
    await step(h); await step(h);
    expect(h.spawnInputs).toHaveLength(1);
  } finally { fake.stop(); }
});

test.each([
  ["refused run", () => new Response("{}", { status: 404 }), "missing, paused or turned off"],
  ["start limit", () => new Response("{}", { status: 429 }), "start limit"],
])("a %s keeps its cause and falls back once with one run call", async (_name, runAnswer, cause) => {
  const { h, fake } = await fixture({ runAnswer });
  try {
    for (let i = 0; i < 6 && !h.spawnInputs.length; i++) await step(h);
    expect(fake.runCalls()).toBe(1);
    expect(h.spawnInputs).toHaveLength(1);
    expect(attempt().cloud?.fallback?.reason).toContain(cause);
  } finally { fake.stop(); }
});

test("a session that can write to GitHub gets no assignment and the stage runs locally with that cause", async () => {
  const { h, fake } = await fixture({ probe: { comment: "write" } });
  try {
    for (let i = 0; i < 6 && !h.spawnInputs.length; i++) await step(h);
    expect(fake.sent.filter(text => text.startsWith("Input part"))).toEqual([]);
    expect(attempt().cloud?.fallback?.reason).toContain("can write to GitHub");
    expect(h.spawnInputs).toHaveLength(1);
  } finally { fake.stop(); }
});

test("an unknown run outcome keeps custody: no second run, no local start", async () => {
  const { h, fake } = await fixture({ runAnswer: () => new Response("{}", { status: 503 }) });
  try {
    for (let i = 0; i < 6 && advancing(); i++) await step(h);
    expect(fake.runCalls()).toBe(1);
    expect(h.spawnInputs).toHaveLength(0);
    expect(lane().state).toBe("needs_decision");
    expect(attempt().cloud?.submissionUnresolved).toBe(true);
    expect(attempt().cloud?.error ?? attempt().error ?? "").toContain("Claude Cloud run outcome is unknown");
    expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toContain("Claude Cloud submission outcome unknown");
    expect(fake.runCalls()).toBe(1);
  } finally { fake.stop(); }
});

test("a read that cannot bind the model confirms nothing and retains the receipt", async () => {
  const { h, fake } = await fixture({ stages: [{ ...reviewer, model: "sonnet" }], task: { enabled: true, job_config: { ccr: { session_context: { sources: [{ git_repository: { url: "https://github.com/sample/project" } }] } } } } });
  try {
    for (let i = 0; i < 8 && advancing(); i++) await step(h);
    expect(attempt().error).toContain("differs from the explicit stage model");
    expect(attempt().cloud?.taskId).toBe(fake.sessionId);
    expect(h.spawnInputs).toHaveLength(0);
  } finally { fake.stop(); }
});

test("runtime and engine must agree, and each role the runtime allows normalizes with its bound model", async () => {
  const refused = normalizeStages([{ ...reviewer, engine: "codex", model: "gpt-6.1-sol" }] as never, pipelineRoleLookup);
  expect(JSON.stringify(refused)).toContain("claude-cloud requires a Claude reviewer");
  for (const [roleId, extra] of [["reviewer", {}], ["verifier", {}], ["architect", {}], ["builder", { access: "read-write" }]] as const) {
    const answer = normalizeStages([{ id: "stage", kind: "run", runtime: "claude-cloud", role: { roleId }, engine: "claude", model: "opus", effort: "high", prompt: "Work.", next: null, ...extra }] as never, pipelineRoleLookup);
    expect((answer as { error?: string }).error, JSON.stringify(answer)).toBeUndefined();
    const stage = (answer as { stages: Array<{ runtime?: string; model?: string; effectiveRole: { engine: string; model: string } }> }).stages[0]!;
    expect(stage.effectiveRole.engine).toBe("claude");
    expect(stage.runtime).toBe("claude-cloud");
    expect(stage.model).toBe(stage.effectiveRole.model);
  }
  /* A stage naming no model binds its role's: this is a request an agent writes first. */
  const preset = normalizeStages([{ id: "design", kind: "run", runtime: "claude-cloud", role: { roleId: "architect" }, prompt: "Design.", next: null }] as never, pipelineRoleLookup) as { stages: Array<{ model?: string; effectiveRole: { engine: string; model: string } }> };
  expect(preset.stages[0]!.effectiveRole.engine).toBe("claude");
  expect(preset.stages[0]!.model).toBe(preset.stages[0]!.effectiveRole.model);
});

test("a Claude cloud builder's diff lands on the lane branch through hooks and publication", async () => {
  const native = await realProvisioningRepo("claude-cloud-builder");
  try {
    const { repo, root, git, realExec } = native;
    fs.writeFileSync(path.join(repo, "existing.txt"), "before\n");
    await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
    const origin = path.join(root, "origin.git");
    await git(root, "init", "--bare", "--initial-branch=main", origin);
    await git(repo, "remote", "add", "origin", origin); await git(repo, "push", "origin", "main");
    const patch = ["diff --git a/existing.txt b/existing.txt", "--- a/existing.txt", "+++ b/existing.txt", "@@ -1 +1 @@", "-before", "+after", ""].join("\n");
    const { h, fake } = await fixture({ exportDiff: patch, repoDir: repo, stages: [{ id: "build", kind: "run", runtime: "claude-cloud", role: { roleId: "builder" }, engine: "claude", model: "opus", effort: "high", access: "read-write", prompt: "Implement {{task}}", next: null }] });
    try {
      h.ports.exec = realExec;
      const { realProvisionExec } = await import("./git"); h.ports.provisionExec = realProvisionExec;
      const record = lane();
      /* The session reads the repository from its task; the lane still publishes to the local bare origin. */
      const execute = h.ports.exec;
      h.ports.exec = async (command, args, cwd, env, options) => execute(command, args.map(arg => arg === "https://github.com/sample/project.git" ? origin : arg), cwd, env, options);
      const hook = path.join(repo, ".git", "hooks", "pre-commit"), ran = path.join(root, "hook-ran");
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, `#!/bin/sh\nprintf hook >> "${ran}"\n`, { mode: 0o755 });
      for (let i = 0; i < 16 && advancing(); i++) { h.advanceWallClock(30_000); await step(h); }
      expect(fake.runCalls()).toBe(1);
      expect(h.spawnInputs).toHaveLength(0);
      expect(attempt().cloud?.patch?.applied).toBe(true);
      expect(fs.existsSync(ran)).toBe(true);
      expect(fs.readFileSync(path.join(lane().worktreeDir, "existing.txt"), "utf8")).toBe("after\n");
      expect(lane().lastPassedCommit).not.toBe(record.lastPassedCommit);
      expect(await git(repo, "ls-remote", "--heads", origin, `refs/heads/${lane().branch}`)).toStartWith(lane().lastPassedCommit);
    } finally { fake.stop(); }
  } finally { await settlePipelineControllerJobs(); fs.rmSync(native.root, { recursive: true, force: true }); }
}, 30_000);
