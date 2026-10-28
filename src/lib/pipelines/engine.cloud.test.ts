import { expect, test, harness, create, loadPipelines, savePipelines, tickPipelines, patchPipeline, path, realProvisioningRepo, fs } from "./engine.fixture";
import { normalizeStages } from "./engine";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { tickPipelinesController } from "./controllerPass";
import { codexCloudEnvironmentId, setCodexCloudEnvironmentId, resetProjectSettingsForTests, setPipelineStageRuntime, reserveCloudStageAccount } from "@/lib/projects/settings";
import { CLOUD_STAGE_TIMEOUT_MS, type CloudStageClient } from "./cloudStage";
import { HostedCloudError } from "./cloudHostedErrors";
import { CloudSubmissionNotStartedError, createHostedCloudStageClient } from "./cloudHostedClient";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { TOOL_INPUT_SCHEMAS } from "@/lib/mcp/server";
import { stageDigest } from "./stageDigest";
import { renderStagePrompt } from "./prompts";
import { resolveStageTestGuidance } from "./testGuidance";
import { effectiveWorkerLimit } from "@/lib/operator/workerLimit";
import { hardenedRedact } from "@/lib/view/compactText";
import { spawn, spawnSync } from "node:child_process";
import type { PipelineStageInput, PatchPipelineRequest } from "./types";

const taskId = "current-review-1";
const taskUrl = `https://example.com/cloud/${taskId}`;
const stage: PipelineStageInput = { id: "review", kind: "run", runtime: "codex-cloud", role: { roleId: "reviewer" },
  engine: "codex", model: "gpt-6.1-sol", effort: "xhigh", prompt: "Review {{task}}. {{prev.output}}", next: null };
const pass = 'All checked.\n\n```json\n{"status":"pass","findings":[]}\n```';
const lane = () => loadPipelines()[0]!;
const attempt = () => lane().runs[0]!.attempts.at(-1)!;

async function fixture(options: { enabled?: boolean; publication?: "internal" | "remote-branch"; stages?: PipelineStageInput[] } = {}) {
  await settlePipelineControllerJobs();
  const h = harness();
  let clock = Date.UTC(2026, 9, 23);
  h.ports.now = () => new Date(clock).toISOString();
  h.advanceWallClock = milliseconds => { clock += milliseconds; };
  const submits: Parameters<CloudStageClient["submit"]>[0][] = [];
  const reads: Parameters<CloudStageClient["poll"]>[0][] = [];
  h.ports.resolveProjectSpawn = (_engine, request) => ({ kind: "available", account: {
    engine: "codex", accountId: request.requestedId ?? "cloud-account", kind: "managed", home: path.resolve("fixture-account"), transcriptRoot: path.resolve("fixture-account"), env: { NODE_ENV: "test" },
  } });
  h.ports.cloudClient = {
    supportsModel: model => model === "gpt-6.1-sol",
    hasEnvironment: async () => true,
    submit: async input => { submits.push(input); return { taskId, taskUrl }; },
    poll: async input => { reads.push(input); return { state: "completed", model: "gpt-6.1-sol" }; },
    readFinalMessage: async () => ({ message: pass, model: "gpt-6.1-sol" }),
    readDiff: async () => { throw new Error("read-only stages must never read a diff"); },
  };
  await create(h.ports, (options.stages ?? [stage]) as never, { publication: options.publication ?? "remote-branch" });
  expect(setCodexCloudEnvironmentId(lane().project, options.enabled === false ? "" : "env-fixture")).toBe(true);
  return { h, submits, reads };
}

async function step(h: ReturnType<typeof harness>) {
  await tickPipelines([], h.ports);
  await settlePipelineControllerJobs();
}
async function submitted(h: ReturnType<typeof harness>, expectedTaskId = taskId) {
  for (let i = 0; i < 4 && !lane().runs[0]?.attempts.at(-1)?.cloud?.taskId && ["provisioning", "running"].includes(lane().state); i++) await step(h);
  expect({ phase: attempt().cloud?.phase, error: attempt().error, cloudError: attempt().cloud?.error }).toEqual({ phase: "polling", error: null, cloudError: undefined });
  expect(attempt().cloud?.taskId).toBe(expectedTaskId);
}

test("cloud reviewers submit the role scaffold, relay and lane facts, settle through the local verdict path", async () => {
  const { h, submits, reads } = await fixture();
  await submitted(h);
  expect(submits).toHaveLength(1);
  expect(submits[0]).toMatchObject({ environmentId: "env-fixture", branch: lane().branch, model: "gpt-6.1-sol", reasoningEffort: "xhigh", allowProviderModelFallback: false, account: { accountId: "cloud-account" } });
  const composed = hardenedRedact(renderStagePrompt(lane(), lane().stages[0]!, attempt().effectiveRole,
    attempt().input ?? "", effectiveWorkerLimit(lane().project).value, resolveStageTestGuidance()));
  expect(submits[0]!.prompt.slice(0, composed.length)).toBe(composed);
  expect(attempt().definition?.runtime).toBe("codex-cloud");
  expect(attempt().cloud).toMatchObject({ taskId, taskUrl, phase: "polling" });
  await step(h); await step(h);
  expect(reads).toHaveLength(1);
  expect(h.spawnInputs).toHaveLength(0);
  expect(attempt().cloud?.model).toBe("gpt-6.1-sol");
  expect(attempt().verdict).toMatchObject({ status: "pass", findings: [] });
  expect(attempt().output).toBe("All checked.");
});

test.each(["default", "priority", "ultrafast"])("cloud admission refuses an explicit %s tier before any submission", async serviceTier => {
  const { h, submits } = await fixture();
  // Stored stages from an older release must hit the execution guard too.
  await step(h);
  const record = lane();
  Object.assign(record.stages[0]!.effectiveRole, { serviceTier, serviceTierSource: "explicit" });
  savePipelines([record]);
  await step(h);
  expect(attempt().error).toContain("explicit service tier");
  expect(submits).toHaveLength(0);
  expect(h.spawnInputs).toHaveLength(0);
});

test("cloud execution checks the bound attempt tier even when the live stage has no tier", async () => {
  const { h, submits } = await fixture();
  await submitted(h);
  const record = lane();
  Object.assign(record.runs[0]!.attempts.at(-1)!.effectiveRole, { serviceTier: "default", serviceTierSource: "explicit" });
  savePipelines([record]);
  await step(h);
  expect(attempt().error).toContain("explicit service tier");
  expect(submits).toHaveLength(1);
});

test("a newly created cloud stage with an explicit default tier fails before submission", async () => {
  const { h, submits } = await fixture({ stages: [{ ...stage, serviceTier: "default" }] });
  await step(h); await step(h);
  expect(attempt().error).toContain("explicit service tier");
  expect(submits).toHaveLength(0);
});

test("cloud role tier preferences visibly fall back to the provider default", async () => {
  const { h, submits } = await fixture();
  const record = lane();
  Object.assign(record.stages[0]!.effectiveRole, { serviceTier: "priority", serviceTierSource: "role-default" });
  savePipelines([record]);
  await submitted(h);
  expect(submits).toHaveLength(1);
  expect(attempt().effectiveRole).toMatchObject({ preferredServiceTier: "priority", serviceTierSource: "role-default" });
  expect(attempt().effectiveRole.serviceTier).toBeUndefined();
  expect(lane().stages[0]!.effectiveRole.serviceTier).toBe("priority");
});

for (const detail of ["Environment setup failed: missing dependency", "Cloud task timed out"]) for (const legacy of [false, true])
  test(`a confirmed Cloud failure falls back with its diagnostic: ${detail} (legacy: ${legacy})`, async () => {
  const { h } = await fixture();
  const error = `Codex Cloud turn failed: ${detail}`;
  h.ports.cloudClient!.poll = async () => ({ state: "failed", model: "gpt-6.1-sol", error });
  await submitted(h);
  const accountId = attempt().accountId!;
  if (legacy) {
    const record = lane(), cloud = record.runs[0]!.attempts.at(-1)!.cloud!;
    delete cloud.accountId; delete cloud.submissionUnresolved; savePipelines([record]);
  }
  await step(h); await step(h);
  expect(attempt().cloud?.error).toBe(error);
  expect(attempt().cloud?.accountId).toBe(accountId);
  expect(attempt().cloud?.failureConfirmed).toBe(true);
  expect(attempt().cloud?.fallback?.reason).toBe(error);
  expect(attempt().executionRuntime).toBe("cloud-then-local");
  expect(attempt().state).toBe("pending");
});

test("confirmed Cloud failure releases account custody for an allowed local fallback", async () => {
  const { h, submits } = await fixture();
  await submitted(h);
  const originalAccount = attempt().accountId!;
  h.ports.cloudClient!.poll = async () => ({ state: "failed", model: "gpt-6.1-sol", error: "Cloud run timed out" });
  await step(h);
  expect(attempt().cloud?.failureConfirmed).toBe(true);
  h.ports.allowedAccountIds = () => ["replacement-account"];
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = (input, reserved) => spawn({ ...input, requestedAccountId: input.requestedAccountId ?? "replacement-account" }, reserved);
  h.ports.resolveProjectSpawn = (_engine, request) => request.requestedId && request.requestedId !== "replacement-account"
    ? { kind: "not_allowed", accountId: request.requestedId, allowedAccountIds: ["replacement-account"] }
    : { kind: "available", account: { engine: "codex", accountId: "replacement-account", kind: "managed",
      home: path.resolve("replacement"), transcriptRoot: path.resolve("replacement"), env: { NODE_ENV: "test" } } };
  for (let i = 0; i < 8 && !h.spawnInputs.length; i++) await step(h);
  expect(h.spawnInputs).toHaveLength(1); expect(submits).toHaveLength(1);
  expect(attempt().executionRuntime).toBe("cloud-then-local");
  expect(attempt().cloud?.accountId).toBe(originalAccount);
  expect(attempt().cloud?.fallback?.reason).toBe("Cloud run timed out");
  expect(attempt().accountId).toBe("replacement-account");
});

test.each([
  { status: "inProgress", error: false, confirmed: false },
  { status: "inProgress", error: 0, confirmed: false },
  { status: "inProgress", error: "", confirmed: false },
  { status: "inProgress", error: { message: "Provider failure" }, confirmed: false },
  { status: "completed", error: false, confirmed: false },
  { status: "failed", error: false, confirmed: false },
  { status: "interrupted", error: false, confirmed: false },
  { status: "unknown", error: { message: "Provider failure" }, confirmed: false },
  { status: "failed", error: { message: "Provider failure" }, confirmed: true },
  { status: "interrupted", error: null, confirmed: true },
])("hosted $status with error $error grants fallback only with terminal proof ($confirmed)", async ({ status, error, confirmed }) => {
  const { h, submits } = await fixture();
  const threadId = "00000000-0000-0000-0000-000000000000", turnId = "turn-fixture";
  const hosted = { environmentId: "ccarenv_fixture", cwd: "/workspace/project", model: stage.model! };
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventEmitter {
    readyState = 1;
    send(value: string, done?: (error?: Error) => void) {
      const frame = JSON.parse(value);
      done?.();
      if (frame.id === undefined) return;
      const result = frame.method === "thread/read"
        ? { model: stage.model, thread: { id: threadId, ephemeral: false, environments: [hosted] } }
        : frame.method === "thread/turns/list" ? { data: [{ id: turnId, status, error, model: stage.model }] } : {};
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: frame.id, result }))));
    }
    terminate() { this.readyState = 3; this.emit("close"); }
  }
  const hostedClient = createHostedCloudStageClient({
    authenticate: async () => ({ token: "fixture-auth" }),
    socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
    fetch: async () => { throw new Error("polling must not fetch the catalog"); },
    uuid: () => "command-fixture",
  });
  h.ports.cloudClient!.submit = async input => {
    submits.push(input);
    return { taskId: threadId, taskUrl: `codex://threads/${threadId}?hostId=durable`, thread: { threadId, turnId, hosted } };
  };
  h.ports.cloudClient!.poll = hostedClient.poll;
  await submitted(h, threadId);
  const receipt = structuredClone(attempt().cloud);
  await step(h); await step(h); await step(h); await step(h);
  expect(attempt().cloud?.taskId).toBe(receipt!.taskId);
  expect(attempt().cloud?.thread).toEqual(receipt!.thread);
  expect(attempt().cloud?.failureConfirmed === true).toBe(confirmed);
  expect(h.spawnInputs).toHaveLength(confirmed ? 1 : 0);
  expect(submits).toHaveLength(1);
  expect(sockets.length).toBeGreaterThan(0);
  expect(sockets.every(socket => socket.readyState === 3)).toBe(true);
  if (!confirmed) {
    expect(lane().state).toBe("needs_decision");
    expect(attempt().cloud?.fallback).toBeUndefined();
    expect((await patchPipeline(lane().id, { action: "override-stage", stageId: stage.id, runtime: "local" }, h.ports)).error).toBeUndefined();
    expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await step(h); await step(h);
    expect(attempt().n).toBe(1);
    expect(attempt().definition?.runtime).toBe("codex-cloud");
    expect(attempt().cloud?.taskId).toBe(threadId);
    expect(h.spawnInputs).toHaveLength(0);
    expect(submits).toHaveLength(1);
  }
});

test("cloud verifier findings use the same normalization, severity ranking and failure routing", async () => {
  const { h } = await fixture();
  const record = lane();
  record.stages[0]!.role!.roleId = "verifier";
  record.stages[0]!.effectiveRole.roleId = "verifier";
  savePipelines([record]);
  h.ports.cloudClient!.readFinalMessage = async () => ({ model: "gpt-6.1-sol", message:
    'Issues.\n```json\n{"status":"fail","findings":[{"severity":"P3","file":"a.ts","line":4,"summary":"cosmetic"},{"severity":"P1","file":"b.ts","line":8,"summary":"broken"}]}\n```' });
  await submitted(h); await step(h); await step(h);
  expect({ state: attempt().state, error: attempt().error }).toMatchObject({ state: "failed" });
  expect(attempt().verdict?.findings).toEqual(["P1 — b.ts:8 — broken", "P3 — a.ts:4 — cosmetic"]);
});

test.each(["local", "codex-cloud"] as const)("cloud review findings activate a %s fix stage with the previous output", async runtime => {
  const { h, submits } = await fixture({ stages: [{ ...stage, onFail: { to: "fix", maxRounds: 1 } },
    { id: "fix", kind: "run", runtime, role: { roleId: "builder" }, engine: "codex", model: "gpt-6.1-sol", prompt: "Fix {{prev.output}}", next: null }] });
  h.ports.cloudClient!.readFinalMessage = async () => ({ model: "gpt-6.1-sol", message:
    'Fix required.\n```json\n{"status":"fail","findings":["P1 — a.ts:8 broken"]}\n```' });
  await submitted(h); await step(h); await step(h);
  expect(lane().cursor?.stageId).toBe("fix");
  await step(h);
  const fix = lane().runs.find(run => run.stageId === "fix")!.attempts.at(-1)!;
  expect(fix.input).toContain("P1 — a.ts:8 broken");
  if (runtime === "local") {
    expect(h.spawnInputs).toHaveLength(1);
    expect(h.spawnInputs[0]!.role.roleId).toBe("builder");
  } else {
    await step(h);
    expect(submits).toHaveLength(2);
    expect(h.spawnInputs).toHaveLength(0);
    const current = lane().runs.find(run => run.stageId === "fix")!.attempts.at(-1)!;
    const source = lane().stages.find(stage => stage.id === "fix")!;
    const composed = hardenedRedact(renderStagePrompt(lane(), source, current.effectiveRole,
      current.input ?? "", effectiveWorkerLimit(lane().project).value, resolveStageTestGuidance()));
    expect(submits[1]!.prompt.slice(0, composed.length)).toBe(composed);
  }
});

test("missing environment falls back once; an internal lane retains its custody refusal", async () => {
  expect(codexCloudEnvironmentId("absent-cloud-project")).toBe("");
  const { h, submits } = await fixture({ enabled: false });
  await step(h); await step(h); await step(h);
  expect(submits).toHaveLength(0);
  expect(h.spawnInputs).toHaveLength(1);
  expect(attempt().executionRuntime).toBe("cloud-then-local");
  expect(attempt().cloud?.fallback?.reason).toContain("disabled");
  const internal = await fixture({ publication: "internal" });
  await step(internal.h); await step(internal.h);
  expect(internal.h.spawnInputs).toHaveLength(0);
  expect(attempt().error).toContain("published lane branch");
});

test("polling has durable bounded backoff and expiry retains remote custody", async () => {
  const { h, reads } = await fixture();
  h.ports.cloudClient!.poll = async input => { reads.push(input); return { state: "pending", model: "gpt-6.1-sol" }; };
  await submitted(h);
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    await step(h);
    const cloud = attempt().cloud!;
    expect({ phase: cloud.phase, polls: cloud.polls, error: attempt().error, delay: Date.parse(cloud.nextPollAt) - Date.parse(h.ports.now()) }).toMatchObject({ phase: "polling", delay });
    const count = reads.length;
    await step(h); expect(reads).toHaveLength(count);
    h.advanceWallClock(delay);
  }
  // A new process reads the same poll counter and due time from the store.
  const script = path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts");
  const child = spawnSync(process.execPath, [script, lane().id], { env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ polls: 6, deadlineAt: attempt().cloud!.deadlineAt, taskId });
  h.advanceWallClock(CLOUD_STAGE_TIMEOUT_MS);
  await step(h);
  expect(lane().state).toBe("needs_decision");
  expect(attempt().error).toContain("remote execution is unresolved");
  expect(attempt().cloud?.fallback).toBeUndefined();
  await step(h); await step(h);
  expect(h.spawnInputs).toHaveLength(0);
  expect(reads).toHaveLength(6);
  h.ports.cloudClient!.poll = async input => { reads.push(input); return { state: "completed", model: "gpt-6.1-sol" }; };
  const n = attempt().n;
  expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await step(h); await step(h);
  expect(attempt().n).toBe(n);
  expect(attempt().state).toBe("passed");
  expect(reads.at(-1)!.taskId).toBe(taskId);
});

test.each(["submission", "read", "final-read", "oversized-message", "invalid-receipt", "missing-verdict", "contradiction"])("cloud failure %s is explicit", async kind => {
  const { h, submits } = await fixture();
  if (kind === "oversized-message") h.ports.cloudClient!.readFinalMessage = async () => ({ message: "x".repeat(1024 * 1024 + 1), model: "gpt-6.1-sol" });
  if (kind === "invalid-receipt") h.ports.cloudClient!.submit = async () => ({ taskId: "invalid receipt", taskUrl });
  if (kind === "submission") h.ports.cloudClient!.submit = async () => { throw new Error("cloud submission unavailable"); };
  if (kind === "read") h.ports.cloudClient!.poll = async () => { throw new Error("cloud backend unavailable"); };
  if (kind === "final-read") h.ports.cloudClient!.readFinalMessage = async () => { throw new Error("cloud final message unavailable"); };
  if (kind === "missing-verdict") h.ports.cloudClient!.readFinalMessage = async () => ({ model: "gpt-6.1-sol", message: "No verdict" });
  if (kind === "contradiction") h.ports.cloudClient!.readFinalMessage = async () => ({ model: "gpt-6.1-sol", message: '```json\n{"status":"pass","findings":["P1 — broken"]}\n```' });
  for (let i = 0; i < 5 && ["provisioning", "running"].includes(lane().state); i++) await step(h);
  expect(lane().state).toBe("needs_decision");
  const reasons = { submission: "cloud submission unavailable", read: "cloud backend unavailable", "failed-task": "cloud environment setup failed",
    "final-read": "cloud final message unavailable", "oversized-message": "exceeded its byte limit", "invalid-receipt": "invalid task reference", "missing-verdict": "missing a fenced JSON verdict", contradiction: "contradictory stage verdict" };
  expect(attempt().error).toContain(reasons[kind as keyof typeof reasons]);
  expect(h.spawnInputs).toHaveLength(0);
  expect(submits.length).toBeLessThanOrEqual(1);
});

for (const runtime of ["local", "codex-cloud"] as const) for (const [kind, message] of [
  ["missing", "No verdict"], ["contradictory", '```json\n{"status":"pass","findings":["P1 — broken"]}\n```'],
] as const)
  test(`a terminal rejected Cloud verdict permits a fresh ${runtime} retry with a new account (${kind})`, async () => {
  const { h, submits } = await fixture();
  h.ports.cloudClient!.readFinalMessage = async () => ({ model: stage.model!, message });
  await submitted(h); await step(h); await step(h);
  expect(lane().state).toBe("needs_decision");
  expect(attempt().verdict).toBeNull();
  expect(attempt().cloud?.phase).toBe("completed");
  expect(attempt().cloud?.result).toHaveProperty("failureReason");
  const rejected = structuredClone(attempt().cloud);
  // A fresh reader must recognize the terminal rejection and keep its receipt.
  const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id], {
    env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
  expect({ status: child.status, error: child.stderr }).toMatchObject({ status: 0 });
  expect(JSON.parse(child.stdout)).toEqual(rejected);
  const submit = h.ports.cloudClient!.submit;
  h.ports.cloudClient!.submit = async input => ({ ...await submit(input), taskId: `${taskId}-retry`, taskUrl: `${taskUrl}-retry` });
  h.ports.allowedAccountIds = () => ["retry-account"];
  const resolve = h.ports.resolveProjectSpawn!;
  h.ports.resolveProjectSpawn = (engine, request) => resolve(engine, { ...request, requestedId: request.requestedId ?? "retry-account" });
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = (input, reserved) => spawn({ ...input, requestedAccountId: input.requestedAccountId ?? "retry-account" }, reserved);
  expect((await patchPipeline(lane().id, { action: "override-stage", stageId: stage.id, runtime }, h.ports)).error).toBeUndefined();
  expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  h.ports.cloudClient!.readFinalMessage = async () => ({ model: stage.model!, message: pass });
  await step(h); await step(h);
  expect(attempt().n).toBe(2);
  expect(attempt().definition?.runtime).toBe(runtime);
  expect(attempt().accountId).toBe("retry-account");
  if (runtime === "local") {
    expect(h.spawnInputs).toHaveLength(1);
    expect(submits).toHaveLength(1);
    const pathname = attempt().agentPath!;
    const finished = h.finish(pathname, "pass");
    h.messages.get(pathname)!.ts = Date.parse(h.ports.now()) + 1;
    h.durableTurns.set(pathname, { turn: "terminal", message: h.messages.get(pathname)! });
    await tickPipelines([finished], h.ports);
  } else {
    await step(h); await step(h);
    expect(submits).toHaveLength(2);
    expect(attempt().cloud?.taskId).toBe(`${taskId}-retry`);
    expect(h.spawnInputs).toHaveLength(0);
  }
  expect(attempt().state).toBe("passed");
  expect(lane().runs[0]!.attempts[0]!.cloud).toEqual(rejected);
});

for (const expired of [false, true]) for (const legacy of [false, true])
  test(`interrupted submission survives restart without duplicate work (expired: ${expired}, legacy: ${legacy})`, async () => {
  const { h, submits } = await fixture();
  await submitted(h);
  const record = lane(), cloud = record.runs[0]!.attempts.at(-1)!.cloud!;
  Object.assign(cloud, { phase: "submitting", taskId: null, taskUrl: null, submissionUnresolved: true });
  if (legacy) { delete cloud.accountId; delete cloud.submissionUnresolved; }
  savePipelines([record]);
  const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), record.id], {
    env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8",
  });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).phase).toBe("submitting");
  if (expired) h.advanceWallClock(CLOUD_STAGE_TIMEOUT_MS);
  await step(h); await step(h);
  expect(attempt().error).toContain("outcome unknown"); expect(submits).toHaveLength(1);
  expect(h.spawnInputs).toHaveLength(0);
  expect(attempt().cloud?.submissionUnresolved).toBe(true);
  expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toContain("outcome unknown");
});

test("a legacy failed submission keeps custody when its account exists only on the attempt", async () => {
  const { h, submits } = await fixture();
  await submitted(h);
  const record = lane(), cloud = record.runs[0]!.attempts.at(-1)!.cloud!;
  Object.assign(cloud, { phase: "failed", taskId: null, taskUrl: null, error: "Cloud submission outcome unknown" });
  delete cloud.accountId; delete cloud.submissionUnresolved;
  savePipelines([record]); h.advanceWallClock(CLOUD_STAGE_TIMEOUT_MS);
  await step(h); await step(h);
  expect(lane().state).toBe("needs_decision"); expect(h.spawnInputs).toHaveLength(0);
  expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toContain("outcome unknown");
  expect(submits).toHaveLength(1);
});

test("unpublished or moved heads are refused before submission and before acceptance", async () => {
  for (const seam of ["submit", "complete"]) {
    const { h, submits } = await fixture();
    if (seam === "complete") await submitted(h);
    const exec = h.ports.exec;
    h.ports.exec = (command, args, ...rest) => args.includes("ls-remote") ? { code: 0, stdout: `${"f".repeat(40)}\trefs/heads/${lane().branch}\n`, stderr: "" } : exec(command, args, ...rest);
    for (let i = 0; i < 5 && ["provisioning", "running"].includes(lane().state); i++) await step(h);
    expect(attempt().state).toBe("failed"); expect(attempt().verdict).toBeNull();
    expect(submits).toHaveLength(seam === "submit" ? 0 : 1);
  }
});

test("account refusal never submits or falls back, and runtime validation covers copies and digests", async () => {
  const { h, submits } = await fixture();
  h.ports.resolveProjectSpawn = () => ({ kind: "not_allowed", accountId: "forbidden", allowedAccountIds: ["allowed"] });
  await step(h); await step(h); await step(h);
  expect(attempt().error).toContain("not_allowed"); expect(submits).toHaveLength(0);
  for (const override of [{ runtime: "other" }, { role: { roleId: "builder" }, access: "read-only" }, { kind: "review-loop" }, { engine: "claude", model: null }, { outputs: ["review.md"] }, { model: null }, { model: "" }, { model: undefined }]) {
    expect(normalizeStages([{ ...stage, ...override }], h.ports.roleLookup).error).toBeTruthy();
  }
  const stored = lane().stages[0]!;
  expect(stageDigest(stored)).not.toBe(stageDigest({ ...stored, runtime: undefined }));
  resetProjectSettingsForTests();
  expect(codexCloudEnvironmentId(lane().project)).toBe("env-fixture");
});

test("a blocked cloud submission yields the Viewer loop and holds no lane mutation lease", async () => {
  const { h } = await fixture();
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  h.ports.cloudClient!.submit = async () => { ready(); await held; return { taskId, taskUrl }; };
  try {
    await tickPipelines([], h.ports); await tickPipelines([], h.ports);
    await started;
    const record = lane();
    record.state = "paused"; record.pausedAt = h.ports.now();
    savePipelines([record]);
    await tickPipelines([], h.ports);
    expect(lane().state).toBe("paused");
  } finally { release(); await settlePipelineControllerJobs(); }
  expect(lane().state).toBe("paused");
  expect(attempt().verdict).toBeNull();
  expect(attempt().cloud).toMatchObject({ taskId, taskUrl, phase: "polling" });
});

test("a late poll result cannot overwrite a superseding cloud task receipt", async () => {
  const { h } = await fixture();
  await submitted(h);
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  h.ports.cloudClient!.poll = async () => { ready(); await held; return { state: "completed", model: "stale" }; };
  try {
    await tickPipelines([], h.ports);
    await started;
    const record = lane();
    const cloud = record.runs[0]!.attempts.at(-1)!.cloud!;
    cloud.taskId = "current-replacement-1"; cloud.taskUrl = "https://example.com/cloud/current-replacement-1";
    savePipelines([record]);
  } finally { release(); await settlePipelineControllerJobs(); }
  expect(attempt().cloud!.taskId).toBe("current-replacement-1");
  expect(attempt().cloud!.model).toBeNull();
  expect(attempt().verdict).toBeNull();
});

test("the indexed controller polls a cloud stage only when its durable backoff is due", async () => {
  const { h, reads } = await fixture();
  h.ports.cloudClient!.poll = async input => { reads.push(input); return { state: "pending", model: "gpt-6.1-sol" }; };
  for (let i = 0; i < 4 && !lane().runs[0]?.attempts.at(-1)?.cloud?.taskId; i++) {
    await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
  }
  expect(attempt().cloud!.taskId).toBe(taskId);
  await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
  expect(reads).toHaveLength(1);
  h.advanceWallClock(1999);
  await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
  expect(reads).toHaveLength(1);
  h.advanceWallClock(1);
  await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
  expect(reads).toHaveLength(2);
  expect(attempt().cloud!.polls).toBe(2);
});

test("an unsupported transport retains its model fidelity refusal", async () => {
  const { h, submits, reads } = await fixture();
  h.ports.cloudClient!.supportsModel = () => false;
  await step(h); await step(h); await step(h);
  expect(attempt().state).toBe("failed");
  expect(attempt().error).toContain("cannot honour");
  expect(submits).toHaveLength(0); expect(reads).toHaveLength(0); expect(h.spawnInputs).toHaveLength(0);
});

test.each(["poll", "final", "missing"])("%s model fidelity is enforced before verdict settlement", async seam => {
  const { h } = await fixture();
  if (seam === "poll") h.ports.cloudClient!.poll = async () => ({ state: "completed", model: "unsupported-model" });
  else h.ports.cloudClient!.readFinalMessage = async () => ({ message: pass, model: seam === "missing" ? "" : "unsupported-model" });
  await submitted(h); await step(h); await step(h);
  expect(attempt().state).toBe("failed"); expect(attempt().verdict).toBeNull();
  expect(attempt().error).toContain("explicit stage model");
});

test("account revocation after a poll prevents reading the final message", async () => {
  const { h } = await fixture();
  await submitted(h);
  let finalReads = 0;
  h.ports.cloudClient!.poll = async () => {
    h.ports.resolveProjectSpawn = () => ({ kind: "not_allowed", accountId: "forbidden", allowedAccountIds: ["allowed"] });
    return { state: "completed", model: "gpt-6.1-sol" };
  };
  h.ports.cloudClient!.readFinalMessage = async () => { finalReads++; return { message: pass, model: "gpt-6.1-sol" }; };
  await step(h); await step(h);
  expect(finalReads).toBe(0); expect(attempt().error).toContain("not_allowed");
});

for (const legacy of [false, true]) test(`Cloud account removal preserves the original task account (legacy: ${legacy})`, async () => {
  const { h, submits, reads } = await fixture();
  await submitted(h);
  const originalAccount = attempt().accountId!, n = attempt().n;
  if (legacy) {
    const record = lane(), cloud = record.runs[0]!.attempts.at(-1)!.cloud!;
    delete cloud.accountId; delete cloud.submissionUnresolved; savePipelines([record]);
  }
  let revoked = true;
  h.ports.allowedAccountIds = () => revoked ? ["replacement-account"] : [originalAccount, "replacement-account"];
  h.ports.resolveProjectSpawn = (_engine, request) => {
    const id = request.requestedId ?? "replacement-account";
    if (revoked && id === originalAccount) return { kind: "not_allowed", accountId: id, allowedAccountIds: ["replacement-account"] };
    return { kind: "available", account: { engine: "codex", accountId: id, kind: "managed", home: path.resolve(id), transcriptRoot: path.resolve(id), env: { NODE_ENV: "test" } } };
  };
  await step(h); await step(h);
  expect(lane().state).toBe("needs_decision"); expect(attempt().accountId).toBe(originalAccount);
  expect(reads).toHaveLength(0); expect(submits).toHaveLength(1); expect(h.spawnInputs).toHaveLength(0);
  revoked = false;
  expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await step(h); await step(h);
  expect(attempt().state).toBe("passed"); expect(attempt().n).toBe(n);
  expect(reads.at(-1)!.account.accountId).toBe(originalAccount);
  expect(attempt().cloud?.accountId).toBe(originalAccount); expect(submits).toHaveLength(1);
});

test("edits after activation preserve the explicit model bound to the cloud attempt", async () => {
  const { h, submits } = await fixture();
  await submitted(h);
  const record = lane();
  record.stages[0]!.model = "gpt-6-sol";
  record.stages[0]!.effectiveRole.model = "gpt-6-sol";
  savePipelines([record]);
  await step(h); await step(h);
  expect(submits[0]!.model).toBe("gpt-6.1-sol");
  expect(attempt().cloud!.model).toBe("gpt-6.1-sol");
  expect(attempt().state).toBe("passed");
});

test.each(["prompt", "output", "error"])("cloud %s never retains a credential-shaped value", async seam => {
  const secret = "sk-" + "x".repeat(48);
  const { h, submits } = await fixture({ stages: [{ ...stage, prompt: "Review " + secret }] });
  if (seam === "output") h.ports.cloudClient!.readFinalMessage = async () => ({ message: secret + "\n" + pass, model: "gpt-6.1-sol" });
  if (seam === "error") h.ports.cloudClient!.poll = async () => ({ state: "failed", model: "gpt-6.1-sol", error: secret });
  await submitted(h); await step(h); await step(h);
  expect(submits[0]!.prompt).not.toContain(secret);
  expect(attempt().output ?? "").not.toContain(secret);
  expect(attempt().error ?? "").not.toContain(secret);
  expect(JSON.stringify(attempt().cloud)).not.toContain(secret);
});

test("stage overrides validate the proposed explicit cloud model before copying defaults", async () => {
  const { h } = await fixture();
  const changed = await patchPipeline(lane().id, { action: "override-stage", stageId: "review", model: "gpt-6-sol" }, h.ports);
  expect(changed.error).toBeUndefined();
  expect(lane().stages[0]!.model).toBe("gpt-6-sol");
  const cleared = await patchPipeline(lane().id, { action: "override-stage", stageId: "review", model: null }, h.ports);
  expect(cleared.error).toContain("explicit stage model");
  expect(lane().stages[0]!.model).toBe("gpt-6-sol");
});

test("hosted thread and turn handles survive restart and reach poll and final-message reads", async () => {
  const { h } = await fixture();
  const thread = { threadId: "00000000-0000-0000-0000-000000000000", turnId: "hosted-turn-1",
    hosted: { environmentId: "ccarenv_fixture", cwd: "/workspace/project", model: "gpt-6.1-sol" } };
  const hostedUrl = `codex://threads/${thread.threadId}?hostId=durable`;
  h.ports.cloudClient!.submit = async () => ({ taskId: thread.threadId, taskUrl: hostedUrl, thread });
  await submitted(h, thread.threadId);
  expect(attempt().cloud?.taskUrl).toBe(hostedUrl);
  expect(attempt().cloud?.model).toBe("gpt-6.1-sol");
  const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id], {
    env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8",
  });
  expect(child.status).toBe(0); expect(JSON.parse(child.stdout).thread).toEqual(thread);
  const reads: string[] = [];
  h.ports.cloudClient!.poll = async input => { expect(input.thread).toEqual(thread); reads.push("poll"); return { state: "completed", model: "gpt-6.1-sol" }; };
  h.ports.cloudClient!.readFinalMessage = async input => { expect(input.thread).toEqual(thread); reads.push("final"); return { message: pass, model: "gpt-6.1-sol" }; };
  await step(h); await step(h);
  expect(reads).toEqual(["poll", "final"]); expect(attempt().state).toBe("passed");
});

test.each(["delivery", "disabled-environment", "changed-environment"].flatMap(kind =>
  ["before-submit", "submit", "poll"].map(seam => [kind, seam])))("%s withdrawal at %s cannot advance the cloud stage", async (kind, seam) => {
  const { h, submits } = await fixture();
  if (seam === "poll") await submitted(h);
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  if (seam === "before-submit") {
    const exec = h.ports.exec;
    h.ports.exec = async (command, args, ...rest) => {
      const result = await exec(command, args, ...rest);
      if (args.includes("ls-remote") && lane().runs[0]?.attempts.at(-1)?.cloud?.phase === "submitting") { ready(); await held; }
      return result;
    };
  } else if (seam === "submit") {
    const submit = h.ports.cloudClient!.submit;
    h.ports.cloudClient!.submit = async input => { ready(); await held; return submit(input); };
  } else {
    h.ports.cloudClient!.poll = async () => { ready(); await held; return { state: "completed", model: "gpt-6.1-sol" }; };
  }
  try {
    await tickPipelines([], h.ports); await tickPipelines([], h.ports);
    await started;
    if (kind === "delivery") {
      const record = lane();
      record.delivery!.active = false; record.delivery!.publish = "disabled"; record.delivery!.releasedAt = h.ports.now();
      savePipelines([record]);
    } else {
      expect(setCodexCloudEnvironmentId(lane().project, kind === "disabled-environment" ? "" : "asenvcfg_other")).toBe(true);
    }
    if (seam === "submit") {
      await tickPipelines([], h.ports);
      expect(attempt().state).toBe("failed");
    }
  } finally { release(); await settlePipelineControllerJobs(); }
  await step(h);
  expect(attempt().state).toBe("failed"); expect(attempt().verdict).toBeNull();
  expect(attempt().error).toContain(kind === "delivery" ? "active published lane branch" : "environment changed");
  expect(submits).toHaveLength(seam === "before-submit" ? 0 : 1);
  if (seam === "submit") expect(attempt().cloud).toMatchObject({ taskId, taskUrl, phase: "failed" });
});

test.each(["reject", "edit"] as const)("proactive authority is rechecked before cloud dispatch after %s", async change => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority, NOW } = await import("@/lib/tasks/proactive.fixture");
  const { mutateTasks, loadTasksByIds } = await import("@/lib/tasks/store");
  const { patchTask } = await import("@/lib/tasks/commands");
  const { proactiveTaskExecutionError } = await import("@/lib/tasks/proactiveExecution");
  const { proactiveCandidateDecision } = await import("@/lib/tasks/proactive");
  const { h, submits } = await fixture();
  const record = lane();
  record.project = `${record.project}-cloud-authority-${change}-${record.id}`;
  savePipelines([record]);
  const project = record.project;
  expect(setCodexCloudEnvironmentId(project, "env-fixture")).toBe(true);
  const startedAt = new Date(NOW - (change === "reject" ? 1_000 : 2_000)).toISOString();
  const { task } = await admitProactiveTask({ ...candidate(`cloud-authority-${change}`), project },
    { ...context(startedAt), project }, undefined, authority(NOW, startedAt));
  const now = () => new Date(NOW).toISOString();
  await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task), undefined, now);
  const linked = lane();
  linked.taskIds = [task.id];
  savePipelines([linked]);

  const exec = h.ports.exec;
  let invalidated = false;
  h.ports.exec = async (command, args, ...rest) => {
    const result = await exec(command, args, ...rest);
    if (!invalidated && args.includes("ls-remote") && lane().runs[0]?.attempts.at(-1)?.cloud?.phase === "submitting") {
      invalidated = true;
      if (change === "reject") {
        const currentTask = loadTasksByIds(new Set([task.id]))[0]!;
        await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(currentTask), undefined, now);
      } else {
        mutateTasks(tasks => {
          const result = patchTask(tasks, task.id, { text: "The accepted scope changed before Cloud dispatch" });
          if (!result.ok) throw new Error(result.error);
          return { tasks: result.tasks, result: null };
        });
        const changedTask = loadTasksByIds(new Set([task.id]))[0]!;
        expect(changedTask.text).toBe("The accepted scope changed before Cloud dispatch");
        expect(changedTask.proactive?.scopeRevision).toBeGreaterThan(0);
        expect(proactiveCandidateDecision(changedTask)).toEqual({ rejected: false, adopted: false });
        expect(proactiveTaskExecutionError([task.id])).toBeTruthy();
      }
    }
    return result;
  };
  try {
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await settlePipelineControllerJobs();
  } finally { h.ports.exec = exec; }

  expect(invalidated).toBe(true);
  expect(submits).toHaveLength(0);
  expect(attempt().cloud?.phase).toBe("failed");
  expect(attempt().cloud?.error).toMatch(/rejected|scope review|unreadable/i);
});

test("the hosted transport guard rejects authority revoked after engine admission", async () => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority, NOW } = await import("@/lib/tasks/proactive.fixture");
  const { loadTasksByIds } = await import("@/lib/tasks/store");
  const { h, submits } = await fixture();
  const record = lane();
  record.project = `${record.project}-cloud-authority-transport-${record.id}`;
  savePipelines([record]);
  const project = record.project;
  expect(setCodexCloudEnvironmentId(project, "env-fixture")).toBe(true);
  const startedAt = new Date(NOW - 4_000).toISOString();
  const { task } = await admitProactiveTask({ ...candidate("cloud-authority-transport"), project },
    { ...context(startedAt), project }, undefined, authority(NOW, startedAt));
  const now = () => new Date(NOW).toISOString();
  await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task), undefined, now);
  const linked = lane();
  linked.taskIds = [task.id];
  savePipelines([linked]);

  h.ports.cloudClient!.submit = async input => {
    const currentTask = loadTasksByIds(new Set([task.id]))[0]!;
    await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(currentTask), undefined, now);
    input.assertCurrent();
    submits.push(input);
    return { taskId, taskUrl };
  };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await settlePipelineControllerJobs();

  expect(submits).toHaveLength(0);
  expect(attempt().cloud?.phase).toBe("failed");
  expect(attempt().cloud?.error).toContain("invented work was rejected");
});

test("a Cloud submission already in flight keeps its receipt after proactive authority is revoked", async () => {
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority, NOW } = await import("@/lib/tasks/proactive.fixture");
  const { loadTasksByIds } = await import("@/lib/tasks/store");
  const { h, submits } = await fixture();
  const record = lane();
  record.project = `${record.project}-cloud-authority-inflight-${record.id}`;
  savePipelines([record]);
  const project = record.project;
  expect(setCodexCloudEnvironmentId(project, "env-fixture")).toBe(true);
  const startedAt = new Date(NOW - 3_000).toISOString();
  const { task } = await admitProactiveTask({ ...candidate("cloud-authority-inflight"), project },
    { ...context(startedAt), project }, undefined, authority(NOW, startedAt));
  const now = () => new Date(NOW).toISOString();
  await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task), undefined, now);
  const linked = lane();
  linked.taskIds = [task.id];
  savePipelines([linked]);

  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  h.ports.cloudClient!.submit = async input => {
    input.assertCurrent();
    submits.push(input);
    ready();
    await held;
    return { taskId, taskUrl };
  };
  try {
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await started;
    const currentTask = loadTasksByIds(new Set([task.id]))[0]!;
    await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(currentTask), undefined, now);
  } finally { release(); await settlePipelineControllerJobs(); }

  expect(submits).toHaveLength(1);
  expect(attempt().cloud).toMatchObject({ taskId, taskUrl, phase: "failed" });
});


test.each(["refused", "missing-transport"] as const)("%s Cloud execution falls back locally once with its reason after bounded retries", async kind => {
  const { h, submits } = await fixture();
  if (kind === "refused") h.ports.cloudClient!.submit = async () => { throw new HostedCloudError("Cloud capacity refused", "cloud-limit"); };
  else h.ports.cloudClient = undefined;
  for (let i = 0; i < 12 && !h.spawnInputs.length; i++) { await step(h); h.advanceWallClock(30_000); }
  expect(attempt().executionRuntime).toBe("cloud-then-local");
  expect(attempt().cloud?.fallback?.reason).toContain(kind === "refused" ? "capacity refused" : "not configured");
  expect(attempt().cloud?.failures).toBe(kind === "refused" ? 1 : 3);
  const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id], {
    env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).fallback).toEqual(attempt().cloud!.fallback);
  await step(h); await step(h);
  expect(h.spawnInputs).toHaveLength(1);
  expect(submits).toHaveLength(0);
});

test("local fallback keeps the role and definition bound before a future-stage override", async () => {
  const { h } = await fixture();
  await submitted(h);
  const role = structuredClone(attempt().effectiveRole), definition = structuredClone(attempt().definition);
  expect((await patchPipeline(lane().id, { action: "override-stage", stageId: "review", model: "gpt-6-sol", prompt: "Future instruction" }, h.ports)).error).toBeUndefined();
  h.ports.cloudClient!.poll = async () => ({ state: "failed", model: "gpt-6.1-sol", error: "Cloud limit reached" });
  await step(h); await step(h); await step(h);
  expect(h.spawnInputs).toHaveLength(1);
  expect(h.spawnInputs[0]!.role).toEqual(role);
  expect(attempt().definition).toEqual(definition);
});

test("an unanswered Cloud submission cannot start another paid turn or a local fallback", async () => {
  const { h, submits } = await fixture();
  h.ports.cloudClient!.submit = async input => {
    submits.push(input);
    throw new HostedCloudError("Cloud connection lost after submission", "unavailable");
  };
  for (let i = 0; i < 8; i++) { await step(h); h.advanceWallClock(30_000); }
  expect(submits).toHaveLength(1);
  expect(h.spawnInputs).toHaveLength(0);
  expect(lane().state).toBe("needs_decision");
  expect(attempt().cloud?.fallback).toBeUndefined();
  expect(attempt().cloud?.error).toBe("Cloud connection lost after submission");
});

test("a failed Cloud handshake retries before falling back because no turn started", async () => {
  const { h, submits } = await fixture();
  h.ports.cloudClient!.submit = async input => {
    submits.push(input);
    throw new CloudSubmissionNotStartedError("Codex Cloud handshake failed", "unavailable");
  };
  for (let i = 0; i < 12 && !h.spawnInputs.length; i++) { await step(h); h.advanceWallClock(30_000); }
  expect(submits).toHaveLength(3);
  expect(h.spawnInputs).toHaveLength(1);
  expect(attempt().cloud?.failures).toBe(3);
  expect(attempt().cloud?.fallback?.reason).toBe("Codex Cloud handshake failed");
});

test("a confirmed pre-turn refusal permits retry without treating it as an unresolved submission", async () => {
  const { h, submits } = await fixture();
  h.ports.cloudClient!.submit = async input => { submits.push(input); throw new CloudSubmissionNotStartedError("Cloud model setup refused", "invalid"); };
  for (let i = 0; i < 6 && lane().state !== "needs_decision"; i++) await step(h);
  expect(lane().state).toBe("needs_decision");
  expect(attempt().cloud).toMatchObject({ taskId: null, submissionUnresolved: false, fallbackEligible: false });
  expect(h.spawnInputs).toHaveLength(0);
  h.ports.cloudClient!.submit = async input => { submits.push(input); return { taskId, taskUrl }; };
  expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await submitted(h);
  expect(submits).toHaveLength(2);
  expect(attempt().cloud?.submissionUnresolved).toBe(false);
});

test.each(["poll", "readFinalMessage", "readDiff"] as const)("transient %s failures retain the receipt and durable retry budget", async operation => {
  const { h, submits } = await fixture({ stages: operation === "readDiff" ? [{ ...stage, role: { roleId: "builder" }, access: "read-write" }] : undefined });
  await submitted(h);
  let polls = 0;
  h.ports.cloudClient![operation] = async () => { polls++; throw new HostedCloudError("Cloud unavailable", "unavailable"); };
  for (const [failures, delay] of [[1, 2000], [2, 4000]] as const) {
    if (operation === "poll" && failures === 2) {
      const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id,
        "poll-unavailable", h.ports.now()], { env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
      expect({ status: child.status, error: child.stderr }).toMatchObject({ status: 0 });
      const output = JSON.parse(child.stdout);
      expect(output).toMatchObject({ pollRequests: 1, submissions: 0, failures: 2 });
      polls += output.pollRequests;
    } else await step(h);
    expect(attempt().cloud).toMatchObject({ phase: "polling", failures, taskId });
    const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id], {
      env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
    expect(child.status).toBe(0); expect(JSON.parse(child.stdout).failures).toBe(failures);
    await step(h); expect(polls).toBe(failures);
    h.advanceWallClock(delay);
  }
  await step(h); await step(h); await step(h);
  expect(polls).toBe(3); expect(submits).toHaveLength(1); expect(h.spawnInputs).toHaveLength(0);
  expect(lane().state).toBe("needs_decision");
  expect(attempt().cloud?.fallback).toBeUndefined();
  expect(attempt().cloud?.error).toBe("Cloud unavailable");
  expect(attempt().cloud?.fallbackEligible).toBe(false);
  const receipt = attempt().cloud!.taskId, n = attempt().n;
  if (operation === "poll") h.ports.cloudClient!.poll = async () => ({ state: "completed", model: "gpt-6.1-sol" });
  else if (operation === "readFinalMessage") h.ports.cloudClient!.readFinalMessage = async () => ({ message: pass, model: "gpt-6.1-sol" });
  // A diff retry is exercised against real Git by the builder checks below.
  if (operation !== "readDiff") {
    const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id], {
      env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
    expect(child.status).toBe(0); expect(JSON.parse(child.stdout).taskId).toBe(receipt);
    expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await step(h); await step(h);
    expect(attempt().n).toBe(n); expect(attempt().cloud!.taskId).toBe(receipt);
    expect(attempt().state).toBe("passed"); expect(submits).toHaveLength(1);
  }
});

test("Cloud account selection skips a missing environment and spreads durable reservations", async () => {
  const { h, submits } = await fixture();
  const catalogs: string[] = [];
  h.ports.resolveProjectSpawn = (_engine, request) => {
    const id = request.requestedId ?? ["account-a", "account-b", "account-c"].find(id => !request.unavailableIds?.includes(id));
    return id ? { kind: "available", account: { engine: "codex", accountId: id, kind: "managed", home: path.resolve(id), transcriptRoot: path.resolve(id), env: { NODE_ENV: "test" } } }
      : { kind: "unavailable", allowedAccountIds: [] };
  };
  h.ports.cloudClient!.hasEnvironment = async input => { catalogs.push(input.account.accountId); return input.account.accountId !== "account-a"; };
  await submitted(h);
  expect(catalogs).toEqual(["account-a", "account-b", "account-c"]);
  expect(attempt().cloud?.accountId).toBe("account-b");
  expect(submits[0]!.account.accountId).toBe("account-b");
  await step(h); await step(h);
  // A new reservation reads the previous attempt, including after a restart.
  const record = lane(), previous = structuredClone(record.runs[0]!.attempts[0]!);
  record.state = "running"; record.cursor = { stageId: "review", state: "pending", input: null, activatedBy: null };
  Object.assign(record.delivery!, { active: true, publish: "enabled", disposition: "owner", ownerId: record.id });
  record.runs[0]!.attempts.push({ ...previous, n: 2, state: "pending", startedAt: null, completedAt: null,
    verdict: null, accountId: null, definition: undefined, cloud: undefined, executionRuntime: undefined });
  savePipelines([record]);
  await submitted(h);
  expect(attempt().cloud?.accountId).toBe("account-c");
  expect(submits[1]!.account.accountId).toBe("account-c");
  const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id,
    "reserve", JSON.stringify(["account-b", "account-c"])], { env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).accountId).toBe("account-b");
});

test("legacy fallback eligibility cannot abandon a known Cloud receipt", async () => {
  const { h, submits } = await fixture();
  await submitted(h);
  const record = lane();
  Object.assign(record.runs[0]!.attempts.at(-1)!.cloud!, { phase: "failed", fallbackEligible: true, error: "Cloud unavailable" });
  savePipelines([record]);
  await step(h); await step(h);
  expect(h.spawnInputs).toHaveLength(0); expect(lane().state).toBe("needs_decision");
  expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await step(h); await step(h);
  expect(attempt().cloud?.taskId).toBe(taskId); expect(attempt().state).toBe("passed");
  expect(submits).toHaveLength(1);
});

for (const replacement of [false, true]) test(`fresh preselected accounts require catalog admission (eligible replacement: ${replacement})`, async () => {
  const { h, submits } = await fixture();
  await submitted(h);
  const record = lane(), current = record.runs[0]!.attempts.at(-1)!;
  Object.assign(current.cloud!, { phase: "reserved", taskId: null, taskUrl: null, accountId: "account-a" });
  current.accountId = "account-a";
  savePipelines([record]); submits.length = 0;
  const catalogs: string[] = [];
  h.ports.resolveProjectSpawn = (_engine, request) => {
    const id = request.requestedId ?? ["account-a", ...(replacement ? ["account-b"] : [])].find(id => !request.unavailableIds?.includes(id));
    return id ? { kind: "available", account: { engine: "codex", accountId: id, kind: "managed", home: path.resolve(id), transcriptRoot: path.resolve(id), env: { NODE_ENV: "test" } } }
      : { kind: "unavailable", allowedAccountIds: [] };
  };
  h.ports.cloudClient!.hasEnvironment = async input => { catalogs.push(input.account.accountId); return input.account.accountId === "account-b"; };
  await step(h); await step(h);
  expect(catalogs).toContain("account-a");
  if (replacement) {
    expect(submits).toHaveLength(1); expect(submits[0]!.account.accountId).toBe("account-b");
  } else {
    expect(submits).toHaveLength(0); expect(attempt().cloud?.fallback?.reason).toContain("environment unavailable");
  }
});

test("local account recovery catalog-admits its replacement before a new Cloud submission", async () => {
  const { h, submits } = await fixture({ enabled: false });
  const originalSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => ({ ...await originalSpawn(input, reserved), paneId: null });
  for (let i = 0; i < 6 && !h.spawnInputs.length; i++) await step(h);
  expect(h.spawnInputs).toHaveLength(1);
  expect(attempt().executionRuntime).toBe("cloud-then-local");
  h.setConversationActive(false);
  h.advanceWallClock(1000);
  const text = "You've hit your usage limit", ts = Date.parse(h.ports.now());
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", message: { text, ts },
    terminalProviderMessage: { text, ts, errorClass: "usage_limit_exceeded", usageLimit: { resetsAt: null } } });
  setCodexCloudEnvironmentId(lane().project, "env-fixture");
  const catalogs: string[] = [];
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: "replacement-account", kind: "managed",
    home: path.resolve("replacement"), transcriptRoot: path.resolve("replacement"), env: { NODE_ENV: "test" } } });
  h.ports.cloudClient!.hasEnvironment = async input => { catalogs.push(input.account.accountId); return false; };
  for (let i = 0; i < 8 && !catalogs.length; i++) await step(h);
  expect(lane().runs[0]!.attempts.length).toBeGreaterThan(1);
  expect(catalogs).toEqual(["replacement-account"]);
  expect(submits).toHaveLength(0);
});

test("Cloud reservation yields under a peer settings lock while stage work continues", async () => {
  const { h } = await fixture();
  await submitted(h);
  const child = spawn(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), lane().id, "hold-settings-lock"], {
    env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  let inputError: Error | undefined;
  child.stdin.on("error", error => { inputError = error; });
  let reservation: Promise<string | null> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", data => data.toString().includes("locked") ? resolve() : reject(new Error("lock not acquired")));
      child.once("error", reject); child.once("exit", () => reject(new Error("lock holder exited before readiness")));
    });
    let settled = false;
    reservation = Promise.resolve(reserveCloudStageAccount(lane().project, ["account-a", "account-b"]))
      .then(value => { settled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    await step(h); await step(h);
    expect(attempt().state).toBe("passed");
    expect(settled).toBe(false);
    child.stdin.end("release");
    expect(await exited).toBe(0); expect(inputError).toBeUndefined();
    expect(await reservation).toBe("account-a");
    expect(await reserveCloudStageAccount(lane().project, ["account-a", "account-b"])).toBe("account-b");
  } finally {
    if (!child.stdin.destroyed) child.stdin.end("release");
    await exited;
    await reservation;
  }
});

test("MCP runtime choices persist through creation, overrides, defaults and frozen definitions", async () => {
  const { h } = await fixture();
  const project = lane().project;
  expect(setPipelineStageRuntime(project, "codex-cloud")).toBe(true);
  try {
    const schema = TOOL_INPUT_SCHEMAS.create_pipeline;
    const input = schema.parse({ clientRequestId: "cloud-runtime-create", task: "Cloud runtime", repoDir: "/repo",
      stages: [{ ...stage, runtime: "local" }] });
    await create(h.ports, input.stages as never);
    expect(lane().stages[0]!.runtime).toBe("local");
    const override = TOOL_INPUT_SCHEMAS.pipeline_action.parse({ clientRequestId: "cloud-runtime-override", pipelineId: lane().id,
      action: "override-stage", stageId: "review", runtime: "codex-cloud" }) as unknown as PatchPipelineRequest;
    expect((await patchPipeline(lane().id, override, h.ports)).error).toBeUndefined();
    expect(lane().stages[0]!.runtime).toBe("codex-cloud");
    const local = { ...override, runtime: "local" as const };
    expect((await patchPipeline(lane().id, local, h.ports)).error).toBeUndefined();
    expect(lane().stages[0]!.runtime).toBe("local");
    const inherited = { ...stage };
    delete inherited.runtime;
    expect(normalizeStages([inherited], h.ports.roleLookup, undefined, 1, project).stages?.[0]?.runtime).toBe("codex-cloud");
    expect(normalizeStages([inherited], h.ports.roleLookup, undefined, 1, project).stages?.[0]?.model).toBe(stage.model);
    await step(h); await step(h);
    expect(attempt().definition?.runtime).toBe("local");
    expect(attempt().executionRuntime).toBe("local");
    expect((await patchPipeline(lane().id, { ...override, runtime: "other" } as never, h.ports)).error).toContain("runtime");
    expect(attempt().definition?.runtime).toBe("local");
  } finally { setPipelineStageRuntime(project, "local"); }
});


for (const [id, refuseHook, exhaustedWriter, diffOutage, lateWriter] of [["builder", false, false, false, false], ["fix", false, false, false, false],
  ["builder", true, false, false, false], ["builder", false, true, false, false], ["builder", false, false, true, false],
  ["builder", false, false, false, true]] as const)
  test(`Cloud ${id} diff settlement honours commit hooks (refused: ${refuseHook}, writer exhausted: ${exhaustedWriter}, diff outage: ${diffOutage}, late writer: ${lateWriter})`, async () => {
  const native = await realProvisioningRepo(`cloud-${id}`);
  try {
    const { repo, root, git, realExec } = native;
    fs.writeFileSync(path.join(repo, "existing.txt"), "before\n");
    await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
    const origin = path.join(root, "origin.git");
    await git(root, "init", "--bare", "--initial-branch=main", origin);
    await git(repo, "remote", "add", "origin", origin); await git(repo, "push", "origin", "main");
    const { h, submits } = await fixture();
    h.ports.exec = realExec;
    const { realProvisionExec } = await import("./git"); h.ports.provisionExec = realProvisionExec;
    const cloudBuilder = { ...stage, id, role: { roleId: "builder" }, access: "read-write", prompt: "Implement {{task}} from {{prev.output}}" };
    await create(h.ports, [cloudBuilder] as never, { publication: "remote-branch", repoDir: repo });
    setCodexCloudEnvironmentId(lane().project, "env-fixture");
    const hook = path.join(repo, ".git", "hooks", "pre-commit"), receipt = path.join(root, "hook-ran");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\nprintf "hook\n" >> "' + receipt + '"\n' + (refuseHook ? 'exit 1\n' : ''), { mode: 0o755 });
    h.ports.cloudClient!.readDiff = async () => [
      "diff --git a/existing.txt b/existing.txt", "--- a/existing.txt", "+++ b/existing.txt", "@@ -1 +1 @@", "-before", "+after",
      "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+created", "",
    ].join("\n");
    await submitted(h);
    expect(submits[0]!.headSha).toBe(await git(repo, "rev-parse", "main"));
    if (diffOutage) {
      const readDiff = h.ports.cloudClient!.readDiff;
      h.ports.cloudClient!.readDiff = async () => { throw new HostedCloudError("Cloud diff unavailable", "unavailable"); };
      for (const delay of [2000, 4000, 0]) { await step(h); h.advanceWallClock(delay); }
      await step(h);
      expect(lane().state).toBe("needs_decision"); expect(h.spawnInputs).toHaveLength(0);
      expect(attempt().cloud?.fallback).toBeUndefined(); expect(submits).toHaveLength(1);
      h.ports.cloudClient!.readDiff = readDiff;
      expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    }
    const record = lane(), current = record.runs[0]!.attempts.at(-1)!;
    const previous = { ...structuredClone(current), n: 1, state: "passed" as const, cloud: undefined,
      completedAt: h.ports.now(), verdict: { status: "pass" as const, findings: [] },
      definition: current.definition && { ...structuredClone(current.definition), runtime: "local" as const },
      conversationId: "previous-local-writer", executionRuntime: "local" as const };
    current.n = 2;
    record.runs[0]!.attempts.unshift(previous); savePipelines([record]);
    const base = record.lastPassedCommit;
    let writerAlive = true, writerChecks = 0, stops = 0;
    h.ports.stageHostTreeStillRunning = ids => { writerChecks++; return writerAlive && ids.includes(previous.conversationId) ? "previous writer remains alive" : null; };
    h.ports.stopSettledStageWriter = async () => { stops++; return { outcome: "failed", error: "writer still alive" }; };
    await step(h); await step(h);
    expect(writerChecks).toBeGreaterThan(0); expect(stops).toBe(1);
    expect(attempt().cloud?.patch?.applied).toBeUndefined();
    expect(fs.readFileSync(path.join(lane().worktreeDir, "existing.txt"), "utf8")).toBe("before\n");
    expect(lane().lastPassedCommit).toBe(base); expect(fs.existsSync(receipt)).toBe(false);
    expect(await git(repo, "ls-remote", "--heads", "origin", `refs/heads/${lane().branch}`)).toStartWith(base);
    if (exhaustedWriter) {
      for (let i = 0; i < 4 && lane().state === "running"; i++) { h.advanceWallClock(5000); await step(h); }
      expect(lane().state).toBe("needs_decision"); expect(stops).toBe(3);
      expect(attempt().cloud?.patch?.applied).toBeUndefined();
      expect(fs.existsSync(receipt)).toBe(false); expect(lane().lastPassedCommit).toBe(base);
      return;
    }
    writerAlive = false;
    if (lateWriter) {
      const execute = h.ports.exec;
      h.ports.exec = async (command, args, cwd, env, options) => {
        const result = await execute(command, args, cwd, env, options);
        if (command === "git" && args[0] === "diff" && args.includes("--cached") && args.includes("--quiet")) writerAlive = true;
        return result;
      };
    }
    for (let i = 0; i < 8 && lane().state === "running"; i++) await step(h);
    if (lateWriter) {
      expect(lane().state).toBe("needs_decision"); expect(attempt().error).toContain("prior stage writer");
      expect(attempt().cloud?.patch?.applied).toBeUndefined();
      expect(fs.readFileSync(path.join(lane().worktreeDir, "existing.txt"), "utf8")).toBe("before\n");
      expect(fs.existsSync(receipt)).toBe(false); expect(lane().lastPassedCommit).toBe(base);
      expect(await git(repo, "ls-remote", "--heads", "origin", `refs/heads/${lane().branch}`)).toStartWith(base);
      return;
    }
    if (refuseHook) {
      expect(lane().state).toBe("needs_decision");
      expect(attempt().error).toContain("commit");
      expect(await git(lane().worktreeDir, "diff", "--cached", "--name-only")).toBe("existing.txt\nnew.txt");
      expect(await git(repo, "ls-remote", "--heads", "origin", `refs/heads/${lane().branch}`)).toStartWith(lane().lastPassedCommit);
      expect(attempt().cloud?.patch?.applied).toBe(true);
      return;
    }
    expect({ state: lane().state, detail: lane().stateDetail, error: attempt().error }).toMatchObject({ state: "completed" });
    expect(fs.readFileSync(receipt, "utf8")).toBe("hook\n");
    expect(await git(lane().worktreeDir, "status", "--porcelain")).toBe("");
    expect(await git(lane().worktreeDir, "show", "HEAD:existing.txt")).toBe("after");
    expect(await git(lane().worktreeDir, "show", "HEAD:new.txt")).toBe("created");
    expect(await git(repo, "ls-remote", "--heads", "origin", `refs/heads/${lane().branch}`)).toStartWith(lane().lastPassedCommit);
    expect(attempt().executionRuntime).toBe("cloud");
    expect(attempt().cloud?.patch?.applied).toBe(true);
    expect(h.spawnInputs).toHaveLength(0);
  } finally { await settlePipelineControllerJobs(); fs.rmSync(native.root, { recursive: true, force: true }); }
}, 30_000);
