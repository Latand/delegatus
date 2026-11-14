import { afterAll, expect, test, savePipelines, tickPipelines, patchPipeline, path, fs, os } from "./engine.fixture";
import { reviewSetupRecipe, setProjectSetupRecipe } from "@/lib/projects/setupRecipe";
import { afterEach, setSystemTime } from "bun:test";
import crypto from "node:crypto";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import { runPrivacyWork, shutdownTaskPageWorker, taskPageWorkerDiagnostics } from "@/lib/links/taskPageWorker";
import { withPrivacyWorkerOwner } from "@/lib/memory/privacyDiagnostics";
import { normalizeStages } from "./engine";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { tickPipelinesController } from "./controllerPass";
import { codexCloudEnvironmentId, setCodexCloudEnvironmentId, resetProjectSettingsForTests } from "@/lib/projects/settings";
import { stageExecution, CLOUD_STAGE_TIMEOUT_MS } from "./cloudStage";

import { createHostedCloudStageClient } from "./cloudHostedClient";
import { EventEmitter } from "node:events";

import type WebSocket from "ws";

import { stageDigest } from "./stageDigest";
import { composeStageInput, composeStageText } from "./stageInput";
import { learnedRulesForLaunchProfile } from "@/lib/memory/roleLaunch";
import { stageMemoryForLaunch } from "@/lib/memory/roleStage";
import { spawn, spawnSync } from "node:child_process";
import { spyOn } from "bun:test";

import type { PipelineStageInput } from "./types";

import { taskId, taskUrl, stage, pass, lane, attempt, privacyDigest, fixture, step, submitted } from "./engine.cloud.fixture";

const privacyRule = "Preserve amber orchard receipts until the owning operation completes";

const privacyRows = () => taskPageWorkerDiagnostics().privacy?.rows ?? [];

function putPrivacyRule(rule = privacyRule, why = "") {
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: "r_cloud_owner", scope: "machine",
    rule, why, state: "active", hints: [], source: { project: "fixture", pipelineId: "fixture", stageId: "review",
      attempt: 1, roleId: "reviewer", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-11-05T00:00:00Z", changedAt: "2026-11-05T00:00:00Z" }));
}

function privacyTestContext(seed: string) {
  setSystemTime(new Date("2026-11-05T00:00:00Z"));
  let n = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => {
    const hex = privacyDigest(`${seed}:${++n}`);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${hex.slice(20, 32)}`;
  });
  savePipelines([]);
  resetProjectSettingsForTests();
  putPrivacyRule();
  return async () => {
    await shutdownTaskPageWorker();
    roleMemoryCollection(true)!.boundedPatch(1, tx => tx.delete("r:r_cloud_owner"));
    ids.mockRestore(); setSystemTime();
  };
}

function privacyCloudStage(runtime: "codex-cloud" | "claude-cloud"): PipelineStageInput {
  return { ...stage, runtime, prompt: privacyRule,
    ...(runtime === "claude-cloud" ? { engine: "claude", model: "opus", effort: "high" } : {}) };
}

const privacyOwner = () => ({ pipeline: privacyDigest(lane().id), stage: privacyDigest("review"), attempt: attempt().n });

test.each(["codex-cloud", "claude-cloud"] as const)("Cloud privacy ownership survives repeated and nested callbacks (%s)", async runtime => {
  const restore = privacyTestContext(`${runtime}:success`);
  try {
    const before = new Set(privacyRows().map(row => row.jobId));
    const { h, submits, client } = await fixture({ stages: [privacyCloudStage(runtime)] });
    const submit = client.submit;
    client.submit = async input => {
      // Exercise the transport's preparation callback before its simulated effect.
      const prompt = await input.preparePrompt!("thread_fixture");
      expect(prompt).not.toContain(privacyRule);
      const lastJob = new Set(privacyRows().map(row => row.jobId));
      await withPrivacyWorkerOwner("foreign pipeline", "foreign stage", 9, async () => {
        // Unchanged callbacks reuse completed filtering without inventing jobs.
        expect(await input.preparePrompt!("thread_repeat")).toBe(prompt);
        expect(await input.preparePrompt!("thread_repeat")).toBe(prompt);
        expect(privacyRows().filter(row => !lastJob.has(row.jobId))).toHaveLength(0);
        // A semantic revision forces real work so ownership cannot pass vacuously.
        for (const why of ["first repeated callback", "second repeated callback"]) {
          putPrivacyRule(privacyRule, why);
          expect(await input.preparePrompt!("thread_repeat")).not.toContain(privacyRule);
        }
      });
      const repeated = privacyRows().filter(row => !lastJob.has(row.jobId));
      const settled = repeated.filter(row => row.phase === "settled");
      expect(settled).toHaveLength(2);
      expect(new Set(settled.map(row => row.requestId)).size).toBe(2);
      expect(repeated.every(row => JSON.stringify(row.owner) === JSON.stringify(privacyOwner()))).toBe(true);

      await withPrivacyWorkerOwner(lane().id, "review", attempt().n, async () => {
        putPrivacyRule(privacyRule, "nested callback");
        await runPrivacyWork({ kind: "filter", value: privacyRule });
        const parentRequest = privacyRows().at(-1)!.requestId;
        const beforeNested = new Set(privacyRows().map(row => row.jobId));
        expect(await input.preparePrompt!("thread_nested")).not.toContain(privacyRule);
        const nested = privacyRows().filter(row => !beforeNested.has(row.jobId));
        expect(nested.filter(row => row.phase === "settled")).toHaveLength(1);
        expect(nested.every(row => row.requestId === parentRequest)).toBe(true);
      });
      return submit({ ...input, prompt });
    };
    await submitted(h);
    expect(submits).toHaveLength(1);
    expect(h.spawnInputs).toHaveLength(0);
    const expected = privacyOwner();
    const owned = privacyRows().filter(row => !before.has(row.jobId));
    expect(owned.some(row => row.phase === "started")).toBe(true);
    expect(owned.filter(row => row.phase === "settled")).toHaveLength(5);
    expect(owned.every(row => JSON.stringify(row.owner) === JSON.stringify(expected))).toBe(true);
    // A completed submission's callback still carries its owner, while the
    // existing dispatch fence refuses its superseded intent.
    await expect(submits[0]!.preparePrompt!("thread_retired")).rejects.toThrow("operation superseded");
    expect(privacyRows().at(-1)?.owner).toEqual(expected);
    await runPrivacyWork({ kind: "filter", value: privacyRule });
    expect(privacyRows().at(-1)?.owner).toBe("unknown");
    expect(JSON.stringify(privacyRows())).not.toContain(privacyRule);
  } finally { await restore(); }
}, 30_000);

for (const runtime of ["codex-cloud", "claude-cloud"] as const) test.each(["initial", "callback"] as const)(
  `Cloud privacy ownership retains preparation failures (${runtime}, %s)`, async failureAt => {
    const restore = privacyTestContext(`${runtime}:${failureAt}`);
    try {
      const before = new Set(privacyRows().map(row => row.jobId));
      const { h, submits, client } = await fixture({ stages: [privacyCloudStage(runtime)] });
      let callbacks = 0;
      // A stored text above the matcher's individual source bound makes the
      // production worker refuse complete filtering, through its real error frame.
      if (failureAt === "initial") putPrivacyRule("amber".repeat(7_000));
      client.submit = async input => {
        callbacks++;
        putPrivacyRule("amber".repeat(7_000));
        await input.preparePrompt!("thread_failure");
        throw new Error("a refused preparation must stop before submission");
      };
      for (let i = 0; i < 4 && attempt()?.cloud?.phase !== "failed"; i++) await step(h);
      expect(callbacks).toBe(failureAt === "callback" ? 1 : 0);
      expect(submits).toHaveLength(0);
      expect(h.spawnInputs).toHaveLength(0);
      expect(attempt().cloud).toMatchObject({ phase: "failed", failures: 1, submissionUnresolved: failureAt === "callback" });
      expect(attempt().cloud?.error).toContain("worker-unavailable");
      const observed = privacyRows().filter(row => !before.has(row.jobId));
      expect(observed.some(row => row.phase === "started")).toBe(true);
      expect(observed.at(-1)).toMatchObject({ phase: "settled", failure: "worker-unavailable", owner: privacyOwner() });
      expect(observed.every(row => JSON.stringify(row.owner) === JSON.stringify(privacyOwner()))).toBe(true);
      expect(JSON.stringify(observed)).not.toContain("amber");
      // Failure unwinds its async context and does not contaminate unrelated jobs.
      putPrivacyRule();
      await runPrivacyWork({ kind: "filter", value: privacyRule });
      expect(privacyRows().at(-1)?.owner).toBe("unknown");
    } finally { await restore(); }
  }, 30_000);

const setupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-builder-setup-"));

afterAll(() => fs.rmSync(setupRoot, { recursive: true, force: true }));

let setupProject: string | undefined;

afterEach(async () => {
  if (setupProject) await setProjectSetupRecipe(setupProject, null);
  setupProject = undefined;
});

const setupRecipe = { command: ["sh", "setup.sh"], cwd: "." };

async function setupBuilder(name: string, roleId: "builder" | "reviewer" = "builder") {
  const result = await fixture({ repoDir: path.join(setupRoot, name, "repo"), stages: [{ ...stage, id: "build",
    role: { roleId }, access: roleId === "builder" ? "read-write" : "read-only", sandbox: "restricted" }] });
  await step(result.h);
  fs.mkdirSync(lane().worktreeDir, { recursive: true });
  fs.writeFileSync(path.join(lane().worktreeDir, "setup.sh"), "echo ready\n");
  const reviewed = await reviewSetupRecipe(lane().worktreeDir, setupRecipe);
  setupProject = lane().project;
  await setProjectSetupRecipe(lane().project, { ...setupRecipe, hash: reviewed.hash, approvedAt: result.h.ports.now() });
  return result;
}

test("a Cloud builder requiring local setup refuses before running the recipe or a local stage", async () => {
  const { h, submits } = await setupBuilder("required-cloud");
  let calls = 0;
  h.ports.executeProjectSetup = async () => { calls++; return { code: 0, stdout: "", stderr: "" }; };
  for (let i = 0; i < 6 && lane().state === "running"; i++) await step(h);
  expect(calls).toBe(0);
  expect(submits).toHaveLength(0);
  expect(h.spawnInputs).toHaveLength(0);
  expect(attempt().error).toContain("project setup requires a local builder");
  expect(attempt().definition?.runtime).toBe("codex-cloud");
  expect(stageExecution(lane().stages[0]!, attempt())).toMatchObject({ requestedRuntime: "codex-cloud", executionRuntime: "not-executed", reason: expect.stringContaining("project setup") });
  expect(attempt().cloud?.fallback).toBeUndefined();
});

test("Cloud builder setup disabled retains Cloud submission", async () => {
  const { h, submits } = await setupBuilder("disabled");
  await setProjectSetupRecipe(lane().project, null);
  h.ports.executeProjectSetup = async () => { throw new Error("disabled setup executed"); };
  await submitted(h);
  expect(submits).toHaveLength(1); expect(h.spawnInputs).toHaveLength(0);
  expect(attempt().setup).toBeUndefined();
});

test("Cloud builder setup does not redirect a reviewer", async () => {
  const { h, submits } = await setupBuilder("reviewer", "reviewer");
  h.ports.executeProjectSetup = async () => { throw new Error("reviewer executed builder setup"); };
  await submitted(h);
  expect(submits).toHaveLength(1); expect(h.spawnInputs).toHaveLength(0);
  expect(attempt().setup).toBeUndefined();
});

test("Cloud builder setup enabled after submission retains remote task custody", async () => {
  const { h, submits } = await setupBuilder("custody");
  const reviewed = await reviewSetupRecipe(lane().worktreeDir, setupRecipe);
  await setProjectSetupRecipe(lane().project, null);
  await submitted(h);
  await setProjectSetupRecipe(lane().project, { ...setupRecipe, hash: reviewed.hash, approvedAt: h.ports.now() });
  h.ports.cloudClient!.poll = async () => ({ state: "pending", model: "gpt-6.1-sol" });
  await step(h);
  expect(attempt().cloud?.taskId).toBe(taskId); expect(attempt().cloud?.phase).toBe("polling");
  expect(attempt().cloud?.fallback).toBeUndefined(); expect(lane().state).toBe("running");
  expect(submits).toHaveLength(1); expect(h.spawnInputs).toHaveLength(0);
});

test("Cloud builder setup enabled during catalog admission prevents submission", async () => {
  const { h, submits } = await setupBuilder("late");
  const reviewed = await reviewSetupRecipe(lane().worktreeDir, setupRecipe);
  await setProjectSetupRecipe(lane().project, null);
  h.ports.cloudClient!.hasEnvironment = async () => {
    await setProjectSetupRecipe(lane().project, { ...setupRecipe, hash: reviewed.hash, approvedAt: h.ports.now() });
    return true;
  };
  let calls = 0;
  h.ports.executeProjectSetup = async () => { calls++; return { code: 9, stdout: "", stderr: "failed setup" }; };
  for (let i = 0; i < 6 && lane().state === "running"; i++) await step(h);
  expect(submits).toHaveLength(0); expect(h.spawnInputs).toHaveLength(0);
  expect(calls).toBe(0); expect(attempt().setup).toBeUndefined();
  expect(attempt().error).toContain("project setup requires a local builder");
  expect(lane().state).toBe("needs_decision");
});

test("cloud reviewers submit the role scaffold, relay and lane facts, settle through the local verdict path", async () => {
  const { h, submits, reads } = await fixture();
  await submitted(h);
  expect(submits).toHaveLength(1);
  expect(submits[0]).toMatchObject({ environmentId: "env-fixture", branch: lane().branch, model: "gpt-6.1-sol", reasoningEffort: "xhigh", allowProviderModelFallback: false, account: { accountId: "cloud-account" } });
  const composed = await composeStageText(lane(), lane().stages[0]!, attempt().effectiveRole, attempt().input ?? "");
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

test("runtime turn metadata retains credential scrubbing", async () => {
  const secret = "gh" + "p_" + "fixture".repeat(6);
  const { h, submits } = await fixture({ deliveryBranch: `refs/heads/pipeline/${secret}` });
  await submitted(h);
  expect(submits[0]!.prompt).not.toContain(secret);
});

test("Cloud keeps an activated empty relay instead of recovering an older output", async () => {
  const { h, submits } = await fixture({ stages: [{ ...stage, id: "earlier", next: "review" }, stage] });
  await submitted(h);
  await step(h); await step(h);
  const record = lane();
  expect(record.cursor?.stageId).toBe("review");
  expect(record.runs[0]!.attempts[0]!.output).toBe("All checked.");
  // Retained activations can carry no relay even though an earlier run has output.
  record.cursor!.input = null;
  savePipelines([record]);
  for (let index = 0; index < 4 && submits.length < 2; index++) await step(h);
  expect(submits).toHaveLength(2);
  const current = lane().runs[1]!.attempts.at(-1)!;
  expect(current.input).toBeNull();
  expect(current.activatedBy).not.toBeNull();
  const local = await composeStageInput(lane(), lane().stages[1]!, current.effectiveRole, "", lane().worktreeDir, h.ports.exec);
  expect(submits[1]!.prompt.slice(0, local.length)).toBe(local);
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
  test(`a confirmed Cloud failure stops with its diagnostic: ${detail} (legacy: ${legacy})`, async () => {
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
  expect(attempt().cloud?.fallback).toBeUndefined();
  expect(attempt().executionRuntime).toBe("cloud");
  expect(attempt().state).toBe("failed");
  expect(attempt().error).toContain(error);
  expect(h.spawnInputs).toHaveLength(0);
});

test("confirmed Cloud failure cannot switch to an allowed local account", async () => {
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
  expect(h.spawnInputs).toHaveLength(0); expect(submits).toHaveLength(1);
  expect(attempt().executionRuntime).toBe("cloud");
  expect(attempt().cloud?.accountId).toBe(originalAccount);
  expect(attempt().cloud?.fallback).toBeUndefined();
  expect(attempt().accountId).toBe(originalAccount);
  expect(attempt().error).toContain("Cloud run timed out");
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
])("hosted $status with error $error retains custody and requires explicit local execution ($confirmed)", async ({ status, error, confirmed }) => {
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
  expect(h.spawnInputs).toHaveLength(0);
  expect(attempt().cloud?.fallback).toBeUndefined();
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
  } else {
    expect((await patchPipeline(lane().id, { action: "override-stage", stageId: stage.id, runtime: "local" }, h.ports)).error).toBeUndefined();
    expect((await patchPipeline(lane().id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await step(h); await step(h);
    expect(attempt().n).toBe(2);
    expect(attempt().definition?.runtime).toBe("local");
    expect(h.spawnInputs).toHaveLength(1);
    expect(lane().runs[0]!.attempts[0]!.cloud?.taskId).toBe(threadId);
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
    const profile = stageMemoryForLaunch(lane(), source, current.effectiveRole.roleId);
    const memory = await learnedRulesForLaunchProfile({ ...profile, learnedRules: profile.learnedRules ?? undefined });
    const composed = [memory, await composeStageText(lane(), source, current.effectiveRole, current.input ?? "")].filter(Boolean).join("\n\n");
    expect(submits[1]!.prompt.slice(0, composed.length)).toBe(composed);
  }
});

test("missing environment stops a required Cloud stage; an internal lane retains its custody refusal", async () => {
  expect(codexCloudEnvironmentId("absent-cloud-project")).toBe("");
  const { h, submits } = await fixture({ enabled: false });
  for (let i = 0; i < 6 && !h.spawnInputs.length; i++) await step(h);
  expect(submits).toHaveLength(0);
  expect(h.spawnInputs).toHaveLength(0);
  expect(attempt().executionRuntime).toBe("cloud");
  expect(attempt().error).toContain("environment unavailable");
  await step(h); await step(h);
  expect(h.spawnInputs).toHaveLength(0);
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
  for (const override of [{ runtime: "other" }, { role: { roleId: "builder" }, access: "read-only" }, { kind: "review-loop" }, { engine: "claude", model: null }, { outputs: ["review.md"] }, { model: null }, { model: "" }]) {
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
  ["before-submit", "submit", "poll"].map(seam => [kind, seam])))("%s withdrawal at %s respects submission authority and existing task custody", async (kind, seam) => {
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
  if (seam === "poll" && kind !== "delivery") {
    expect(attempt().state).toBe("passed");
    expect(attempt().cloud?.environmentId).toBe("env-fixture");
    expect(submits).toHaveLength(1); expect(h.spawnInputs).toHaveLength(0);
    return;
  }
  expect(attempt().state).toBe("failed"); expect(attempt().verdict).toBeNull();
  expect(attempt().error).toContain(kind === "delivery" ? "active published lane branch" : "environment changed");
  expect(submits).toHaveLength(seam === "before-submit" ? 0 : 1);
  if (seam === "submit") expect(attempt().cloud).toMatchObject({ taskId, taskUrl, phase: "failed" });
});
