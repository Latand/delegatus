import { expect, test, harness, create, loadPipelines, savePipelines, tickPipelines, patchPipeline, ORIGIN_MAIN_SHA, path } from "./engine.fixture";
import { normalizeStages } from "./engine";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { tickPipelinesController } from "./controllerPass";
import { codexCloudEnvironmentId, setCodexCloudEnvironmentId, resetProjectSettingsForTests } from "@/lib/projects/settings";
import { CLOUD_STAGE_TIMEOUT_MS, type CloudStageClient } from "./cloudStage";
import { stageDigest } from "./stageDigest";
import { spawnSync } from "node:child_process";
import type { PipelineStageInput } from "./types";

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
  expect(submits[0]!.prompt).toContain("Review Ship pipelines");
  expect(submits[0]!.prompt).toContain("Role prompt scaffold:");
  expect(submits[0]!.prompt).toContain("Pinned specification and acceptance criteria:\nAC1");
  expect(submits[0]!.prompt).toContain(ORIGIN_MAIN_SHA);
  expect(submits[0]!.prompt).toContain("Cloud runtime instructions");
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

test("a cloud failure diagnostic is retained through durable stage settlement", async () => {
  const { h } = await fixture();
  const error = "Codex Cloud turn failed (environment_setup_failed): Environment setup failed: missing dependency";
  h.ports.cloudClient!.poll = async () => ({ state: "failed", model: "gpt-6.1-sol", error });
  await submitted(h); await step(h); await step(h);
  expect(attempt().cloud?.error).toBe(error);
  expect(attempt().error).toBe(error);
  expect(lane().stateDetail).toContain(error);
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

test("cloud review findings activate the local fix stage and reach its prompt", async () => {
  const { h } = await fixture({ stages: [{ ...stage, onFail: { to: "fix", maxRounds: 1 } },
    { id: "fix", kind: "run", role: { roleId: "builder" }, prompt: "Fix {{prev.output}}", next: null }] });
  h.ports.cloudClient!.readFinalMessage = async () => ({ model: "gpt-6.1-sol", message:
    'Fix required.\n```json\n{"status":"fail","findings":["P1 — a.ts:8 broken"]}\n```' });
  await submitted(h); await step(h); await step(h);
  expect(lane().cursor?.stageId).toBe("fix");
  await step(h);
  expect(h.spawnInputs).toHaveLength(1);
  expect(h.spawnInputs[0]!.prompt).toContain("P1 — a.ts:8 broken");
  expect(h.spawnInputs[0]!.role.roleId).toBe("builder");
});

test("feature is off by default; disabled cloud stages and internal lanes never fall back to local", async () => {
  expect(codexCloudEnvironmentId("absent-cloud-project")).toBe("");
  for (const options of [{ enabled: false }, { publication: "internal" as const }]) {
    const { h, submits, reads } = await fixture(options);
    await step(h); await step(h);
    expect(submits).toHaveLength(0); expect(reads).toHaveLength(0); expect(h.spawnInputs).toHaveLength(0);
    expect(attempt().state).toBe("failed");
    expect(attempt().error).toContain(options.enabled === false ? "disabled" : "published lane branch");
  }
});

test("polling has durable bounded backoff and a total timeout", async () => {
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
  expect(attempt().state).toBe("failed");
  expect(attempt().error).toBe("Codex Cloud stage timed out");
  expect(reads).toHaveLength(6);
});

test.each(["submission", "read", "failed-task", "final-read", "oversized-message", "invalid-receipt", "missing-verdict", "contradiction"])("cloud failure %s is explicit", async kind => {
  const { h, submits } = await fixture();
  if (kind === "oversized-message") h.ports.cloudClient!.readFinalMessage = async () => ({ message: "x".repeat(1024 * 1024 + 1), model: "gpt-6.1-sol" });
  if (kind === "invalid-receipt") h.ports.cloudClient!.submit = async () => ({ taskId: "invalid receipt", taskUrl });
  if (kind === "submission") h.ports.cloudClient!.submit = async () => { throw new Error("cloud submission unavailable"); };
  if (kind === "read") h.ports.cloudClient!.poll = async () => { throw new Error("cloud backend unavailable"); };
  if (kind === "final-read") h.ports.cloudClient!.readFinalMessage = async () => { throw new Error("cloud final message unavailable"); };
  if (kind === "failed-task") h.ports.cloudClient!.poll = async () => ({ state: "failed", model: "gpt-6.1-sol", error: "cloud environment setup failed" });
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

test("interrupted submission fails after a real process restart without a duplicate task", async () => {
  const { h, submits } = await fixture();
  await submitted(h);
  const record = lane(), cloud = record.runs[0]!.attempts.at(-1)!.cloud!;
  Object.assign(cloud, { phase: "submitting", taskId: null, taskUrl: null });
  savePipelines([record]);
  const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudStageRestart.ts"), record.id], {
    env: { ...process.env, LLV_CLOUD_RESTART_PROBE: "1" }, encoding: "utf8",
  });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).phase).toBe("submitting");
  await step(h);
  expect(attempt().error).toContain("outcome unknown"); expect(submits).toHaveLength(1);
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
  for (const override of [{ runtime: "other" }, { role: { roleId: "builder" } }, { kind: "review-loop" }, { engine: "claude", model: null }, { outputs: ["review.md"] }, { model: null }, { model: "" }, { model: undefined }]) {
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

test.each(["absent", "unsupported"])("a %s current-cloud transport refuses before any remote submission", async kind => {
  const { h, submits, reads } = await fixture();
  if (kind === "absent") h.ports.cloudClient = undefined;
  else h.ports.cloudClient!.supportsModel = () => false;
  for (let i = 0; i < 4 && ["provisioning", "running"].includes(lane().state); i++) await step(h);
  expect(attempt().state).toBe("failed");
  expect(attempt().error).toContain(kind === "absent" ? "not configured" : "cannot honour");
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
  expect(attempt().error).toContain(kind === "delivery" ? "active published lane branch" : kind === "disabled-environment" ? "disabled" : "environment changed");
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
