import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pipeline } from "@/lib/pipelines/types";

/* A throwaway state directory: the pipelines this suite writes live inside the
   sandbox, never in the operator's runtime state. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-compact-answers-"));
const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
const creatorPath = path.join(process.env.LLV_CODEX_HOME, "sessions", "creator.jsonl");
fs.mkdirSync(path.dirname(creatorPath), { recursive: true });
fs.writeFileSync(creatorPath, "{}\n");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { compactLiveness, pipelineStageRead, stageReportAcknowledgement } = await import("./compactAnswers");
const { agentRegistry } = await import("@/lib/agent/registry");
const { CORPUS_BODY_MARKERS, pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
const { savePipelines } = await import("@/lib/pipelines/store");
const { MAX_SCAFFOLD_LENGTH } = await import("@/lib/roles/store");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
let requestedTicks = 0;
// Bind all controller signals in this suite to its own in-process controller.
const restorePipelineTick = registerPipelineTick(async () => { requestedTicks += 1; });
afterAll(restorePipelineTick);
agentRegistry().ensureConversation("codex", creatorPath, null);

const CURRENT_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("create_pipeline states local-only delivery and documents remote adoption", async () => {
  const repo = fs.mkdtempSync(path.join(sandbox, "local-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "base");
  const bindings = viewerMcpBindings();
  const args = { task: "Local lane", src: creatorPath, repoDir: repo, baseRef: git("rev-parse", "HEAD"), autoStart: false,
    stages: [{ id: "build", kind: "run", engine: "codex", prompt: "Build", next: null }] };
  const local = await bindings.create_pipeline({ ...args, clientRequestId: "local-delivery-create" }) as { delivery: { publishes: boolean; note: string } };
  expect(local.delivery.publishes).toBe(false);
  expect(local.delivery.note).toContain("local lane branch");
  expect(local.delivery.note).toContain("set-delivery-remote");
  git("remote", "add", "origin", "https://example.invalid/project.git");
  const remote = await bindings.create_pipeline({ ...args, clientRequestId: "remote-delivery-create" }) as { delivery: { publishes: boolean } };
  expect(remote.delivery.publishes).toBe(true);
});

function expectNoBodies(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const marker of Object.values(CORPUS_BODY_MARKERS)) expect(serialized).not.toContain(marker);
}

/** A corpus pipeline whose build stage carries a verdict with findings and a
    reported summary — what a stage read is for. */
function reviewedPipeline() {
  const [pipeline] = pipelineCorpus(2).filter((candidate) => candidate.state === "running");
  const attempts = pipeline!.runs[0]!.attempts;
  const latest = attempts[attempts.length - 1]!;
  latest.state = "failed";
  latest.verdict = {
    status: "fail",
    findings: ["P0 — the route permits an unsafe write", "P1 — the route ignores the project filter"],
  };
  latest.report = {
    seq: 1,
    at: "2026-09-19T09:00:00.000Z",
    actor: { kind: "agent" as const, role: "builder", conversationId: "conversation_stage" },
    verdict: latest.verdict,
    summary: "One finding left.",
    provenance: { head: "0".repeat(40), branch: "pipeline/x", uncommitted: [], pullRequest: null, outputs: [] },
    calls: 1,
  } as never;
  pipeline!.stateDetail = "the first stage failed; waiting on the fail edge";
  return pipeline!;
}

test("stage_report acknowledgement is compact, while one stage read retains every finding and summary (#1919)", async () => {
  const report = {
    seq: 7,
    at: "2026-09-20T06:30:00.000Z",
    actor: { kind: "agent" as const, role: "builder", conversationId: "conversation_stage" },
    verdict: {
      status: "fail" as const,
      findings: [
        `P0 — ${"critical evidence ".repeat(90)}`,
        `P1 — ${"important evidence ".repeat(90)}`,
        `P3 — ${"minor evidence ".repeat(90)}`,
      ],
      rankedFindings: [
        { severity: "P0" as const, text: "critical" },
        { severity: "P1" as const, text: "important" },
        { severity: "P3" as const, text: "minor" },
        { severity: null, text: "historical unranked finding" },
      ],
    },
    summary: "summary ".repeat(250),
    provenance: {
      head: "a".repeat(40), branch: "pipeline/fixture", uncommitted: ["changed.ts"],
      pullRequest: { url: "https://example.test/pr/1", number: 1, state: "OPEN" },
      outputs: [{ path: "evidence.json", present: true }],
    },
    calls: 2,
  };
  const acknowledgement = stageReportAcknowledgement(report);
  expect(acknowledgement).toMatchObject({
    seq: 7,
    verdict: { status: "fail", findingCount: 3, severityCounts: { P0: 1, P1: 1, P2: 0, P3: 1 } },
    provenance: { head: "a".repeat(40), branch: "pipeline/fixture", dirty: true, outputs: [{ path: "evidence.json", present: true }] },
    calls: 2,
  });
  expect(JSON.stringify(acknowledgement)).not.toContain("critical evidence");
  expect(JSON.stringify(acknowledgement)).not.toContain("summary summary");
  const oldSuccess = { pipelineId: "pipeline_fixture", stageId: "build", attempt: 1, replaced: false, report };
  const compactSuccess = { pipelineId: "pipeline_fixture", stageId: "build", attempt: 1, replaced: false, report: acknowledgement };
  const projectedOldOutput = 220 * bytes(oldSuccess);
  const projectedCompactOutput = 220 * bytes(compactSuccess);
  expect(projectedCompactOutput).toBeLessThan(projectedOldOutput);
  const serialize = (value: unknown) => {
    const started = performance.now();
    for (let index = 0; index < 1_000; index += 1) JSON.stringify(value);
    return performance.now() - started;
  };
  /* A local serialization timing only checks this projection's overhead. It
     deliberately says nothing about provider or end-to-end tool latency. */
  expect(serialize(compactSuccess)).toBeLessThan(serialize(oldSuccess));
  /* Immediate acknowledgements shrink; reading the full report is deliberately
     larger, so this is not a claim that every acknowledgement-plus-follow-up
     interaction costs less. */
  expect(bytes(acknowledgement)).toBeLessThan(bytes(report) / 4);
  expect(bytes(acknowledgement) + bytes(report)).toBeGreaterThan(bytes(report));
});

test("create_pipeline answers an acknowledgement, and get_pipeline still reads the whole record (#1845)", async () => {
  const bindings = viewerMcpBindings();
  const created = await bindings.create_pipeline({
    clientRequestId: "compact-create",
    task: "Compact create answer\nwith a body the acknowledgement must not echo",
    spec: CORPUS_BODY_MARKERS.spec.repeat(300),
    src: creatorPath,
    repoDir: process.cwd(),
    baseRef: CURRENT_HEAD,
    autoStart: false,
    stages: [
      { id: "build", kind: "run", engine: "codex", model: "gpt-6-astra", effort: "medium", prompt: CORPUS_BODY_MARKERS.stagePrompt.repeat(400), next: "verify" },
      { id: "verify", kind: "run", engine: "codex", model: "gpt-6-astra", effort: "medium", prompt: "verify ".repeat(400), next: null },
    ],
  }) as { pipelineId: string; stages: unknown[]; stageDigests: Record<string, string> };
  /* Read before toMatchObject, which rewrites matched values in place. */
  const pipelineId = created.pipelineId;
  const createdDigests = { ...created.stageDigests };
  expectNoBodies(created);
  expect(JSON.stringify(created)).not.toContain("promptScaffold");
  /* docs/design/model-sizing-tiers.md §3: which model each stage runs, and the
     one line a seat quotes in its launch message. */
  expect((created.stages as { role: unknown; variant: unknown }[]).map((stage) => [stage.role, stage.variant])).toEqual([[null, null], [null, null]]);
  expect((created as unknown as { runtimeLine: string }).runtimeLine).toBe("build: codex/gpt-6-astra/medium (explicit) · verify: codex/gpt-6-astra/medium (explicit)");
  // Includes the delivery ownership acknowledgement already present on main.
  expect(bytes(created)).toBeLessThan(1_600);

  expect(created).toMatchObject({
    pipelineId: expect.any(String),
    state: "draft",
    stages: [
      { id: "build", engine: expect.any(String), effort: expect.any(String) },
      { id: "verify", engine: expect.any(String), effort: expect.any(String) },
    ],
    stageDigests: { build: expect.stringMatching(/^[0-9a-f]{64}$/), verify: expect.stringMatching(/^[0-9a-f]{64}$/) },
    graphDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(created).not.toHaveProperty("pipeline");

  const full = await bindings.get_pipeline({ clientRequestId: "compact-create-read", full: true, pipelineId }) as { pipeline: { spec: string; stages: Array<{ prompt: string }> }; stageDigests: unknown };
  expect(full.pipeline.spec).toBe(CORPUS_BODY_MARKERS.spec.repeat(300).trim());
  expect(full.pipeline.stages[0]!.prompt).toContain(CORPUS_BODY_MARKERS.stagePrompt.repeat(100));
  expect(full.stageDigests).toEqual(createdDigests);
});

test("get_pipeline with stageId answers one stage's conclusion without prompts or transcripts (#1845)", async () => {
  const pipeline = reviewedPipeline();
  Object.assign(pipeline.runs[0]!.attempts.at(-1)!.report!, { result: "Review found two regressions." });
  savePipelines([pipeline]);
  const bindings = viewerMcpBindings();

  const whole = await bindings.get_pipeline({ clientRequestId: "stage-whole", full: true, pipelineId: pipeline.id });
  const stage = await bindings.get_pipeline({ clientRequestId: "stage-read", pipelineId: pipeline.id, stageId: "build" });
  expectNoBodies(stage);
  expect(bytes(stage)).toBeLessThan(2_400);
  /* The by-id read without options is unchanged: the whole record. */
  expect(JSON.stringify(whole)).toContain(CORPUS_BODY_MARKERS.attemptOutput);
  expect(bytes(whole)).toBeGreaterThan(50 * bytes(stage));
  expect(stage).toMatchObject({
    pipelineId: pipeline.id,
    state: "running",
    stage: { id: "build", kind: "run", roleId: "builder", attempts: 6, stageDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    attempt: {
      n: 6,
      state: "failed",
      verdict: "fail",
      findings: ["P0 — the route permits an unsafe write", "P1 — the route ignores the project filter"],
      summary: "One finding left.",
      result: "Review found two regressions.",
    },
  });

  const earlier = await bindings.get_pipeline({ clientRequestId: "stage-read-2", pipelineId: pipeline.id, stageId: "build", attempt: 2 });
  expect(earlier).toMatchObject({ attempt: { n: 2, state: "passed", verdict: "pass", findings: [], summary: null } });
  await expect(bindings.get_pipeline({ clientRequestId: "stage-missing", pipelineId: pipeline.id, stageId: "deploy" }))
    .rejects.toThrow("its stages are build, review");
  await expect(bindings.get_pipeline({ clientRequestId: "stage-attempt-missing", pipelineId: pipeline.id, stageId: "build", attempt: 9 }))
    .rejects.toThrow("has no attempt 9");

  const compact = await bindings.get_pipeline({ clientRequestId: "stage-compact", pipelineId: pipeline.id, compact: true });
  expectNoBodies(compact);
  // The voice detail contract retains stage kind and role alongside state.
  expect(bytes(compact)).toBeLessThan(800);
  expect(compact).toMatchObject({ pipelineId: pipeline.id, stages: [{ id: "build", kind: "run", roleId: "builder", latestAttempt: { n: 6, state: "failed", verdict: "fail" } }, { id: "review", kind: "review-loop", roleId: "reviewer" }] });
});

function metadataPipeline() {
  const pipeline = reviewedPipeline();
  const at = "2026-10-26T10:00:00.000Z";
  pipeline.createdAt = at;
  for (const run of pipeline.runs) for (const attempt of run.attempts) {
    attempt.startedAt = at;
    attempt.completedAt = at;
    attempt.effectiveRole = { ...attempt.effectiveRole };
  }
  const stage = pipeline.stages[0]!;
  stage.account = "account-A";
  stage.role = { roleId: "builder", params: { mode: "plain", rounds: 2 } };
  Object.assign(stage.effectiveRole, { serviceTier: "priority", serviceTierSource: "explicit", preferredServiceTier: "priority" });
  const attempt = pipeline.runs[0]!.attempts.at(-1)!;
  attempt.accountId = "account-B";
  attempt.effectiveRole = { ...stage.effectiveRole, model: "gpt-6.1-sol", effort: "high", access: "read-only", serviceTier: "standard", serviceTierSource: "role-default" };
  attempt.definition = {
    boundAt: at, stageDigest: "a".repeat(64), prompt: "Bound 🧭", account: "account-C",
    role: { roleId: "builder", params: { mode: "plan" } }, sandbox: null, outputs: null,
  };
  return { pipeline, stage, attempt };
}

test("stage metadata separates configured policy from the selected attempt's persisted runtime", () => {
  const { pipeline, stage, attempt } = metadataPipeline();
  const before = structuredClone(pipeline);
  const answer = pipelineStageRead(pipeline, stage.id);
  expect(answer.stage).toMatchObject({
    engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write",
    configured: { account: "account-A", serviceTier: "priority", serviceTierSource: "explicit", preferredServiceTier: "priority" },
    roleParams: { mode: "plain", rounds: 2 },
    promptMetadata: { length: stage.prompt.length, sha256: createHash("sha256").update(stage.prompt).digest("hex") },
  });
  expect(answer.attempt).toMatchObject({
    runtime: { engine: "codex", model: "gpt-6.1-sol", effort: "high", accountId: "account-B", serviceTier: "standard", serviceTierSource: "role-default" },
    accountPin: "account-C", roleParams: { mode: "plan" }, access: "read-only",
    promptMetadata: { length: 8, sha256: createHash("sha256").update("Bound 🧭").digest("hex") },
  });
  expect(pipeline).toEqual(before);
  const earlier = pipelineStageRead(pipeline, stage.id, 2);
  expect(earlier.attempt).toMatchObject({ n: 2, runtime: { engine: "codex", accountId: null, serviceTier: null, serviceTierSource: null }, promptMetadata: null });
  expect(answer.attempt!.n).toBe(attempt.n);
  Object.assign(attempt.effectiveRole, { engine: "claude", model: "opus" });
  delete attempt.effectiveRole.serviceTier;
  delete attempt.effectiveRole.serviceTierSource;
  delete attempt.effectiveRole.preferredServiceTier;
  expect(pipelineStageRead(pipeline, stage.id)).toMatchObject({ stage: { engine: "codex" }, attempt: { runtime: { engine: "claude", model: "opus", serviceTier: null, serviceTierSource: null } } });
});

test("stage metadata follows account pin precedence without treating a requested switch as observed", () => {
  const { pipeline, stage, attempt } = metadataPipeline();
  const runtimeSwitch: NonNullable<typeof attempt.runtimeSwitches>[number] = {
    id: "switch-1", seq: 1, requestedAt: "2026-10-26T10:01:00.000Z", actor: { kind: "operator" }, mode: "fork", phase: "requested",
    from: { engine: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: "standard", accountId: "account-B", conversationId: "conversation-1", launchId: null, sessionId: null, agentPath: null },
    to: { engine: "codex", model: "gpt-5.6-sol", effort: "medium", serviceTier: "priority", accountId: "account-D", accountPinned: true },
  };
  attempt.runtimeSwitches = [runtimeSwitch];
  expect(pipelineStageRead(pipeline, stage.id).attempt).toMatchObject({ accountPin: "account-C", runtime: { model: "gpt-6.1-sol", serviceTier: "standard", accountId: "account-B" } });
  runtimeSwitch.phase = "committed";
  Object.assign(attempt.effectiveRole, { model: "gpt-5.6-sol", effort: "medium", serviceTier: "priority" });
  delete attempt.effectiveRole.serviceTierSource;
  attempt.accountId = "account-D";
  expect(pipelineStageRead(pipeline, stage.id).attempt).toMatchObject({ accountPin: "account-D", runtime: { engine: "codex", model: "gpt-5.6-sol", accountId: "account-D", serviceTier: "priority", serviceTierSource: null } });
  runtimeSwitch.to.accountPinned = false;
  expect(pipelineStageRead(pipeline, stage.id).attempt!.accountPin).toBeNull();
  attempt.runtimeAccountPin = "account-E";
  expect(pipelineStageRead(pipeline, stage.id).attempt!.accountPin).toBe("account-E");
  attempt.runtimeAccountPin = null;
  expect(pipelineStageRead(pipeline, stage.id).attempt!.accountPin).toBeNull();
});

test("legacy metadata stays unknown and unstarted stages have no observed attempt", () => {
  const { pipeline, stage, attempt } = metadataPipeline();
  delete stage.account;
  delete stage.role;
  delete stage.effectiveRole.serviceTier;
  delete stage.effectiveRole.serviceTierSource;
  delete stage.effectiveRole.preferredServiceTier;
  delete attempt.definition;
  delete attempt.accountId;
  delete attempt.effectiveRole.serviceTier;
  delete attempt.effectiveRole.serviceTierSource;
  const answer = pipelineStageRead(pipeline, stage.id);
  expect(answer.stage).toMatchObject({ configured: { account: null, serviceTier: null, serviceTierSource: null, preferredServiceTier: null }, roleParams: null });
  expect(answer.attempt).toMatchObject({ accountPin: null, roleParams: null, promptMetadata: null, result: null, runtime: { accountId: null, serviceTier: null, serviceTierSource: null } });
  pipeline.runs = [];
  expect(pipelineStageRead(pipeline, stage.id).attempt).toBeNull();
  stage.prompt = "";
  expect(pipelineStageRead(pipeline, stage.id).stage.promptMetadata).toEqual({ length: 0, sha256: createHash("sha256").update("").digest("hex") });
});

test("stage metadata passes through trusted text and sensitive-key redaction", async () => {
  const { pipeline, stage, attempt } = metadataPipeline();
  stage.role!.params = { mode: "private-param-value", password: "demo-x" };
  attempt.definition!.role!.params = { authorization: "demo-x" };
  savePipelines([pipeline]);
  const bindings = viewerMcpBindings();
  const answer = await bindings.get_pipeline({ pipelineId: pipeline.id, stageId: stage.id }, {
    redactText: value => value.replace(/account-[A-Z]|private-param-value/g, "[redacted]"),
  });
  expect(answer).toMatchObject({
    stage: { configured: { account: "[redacted]" }, roleParams: { mode: "[redacted]", password: "[redacted]" } },
    attempt: { accountPin: "[redacted]", runtime: { accountId: "[redacted]" }, roleParams: { authorization: "[redacted]" } },
  });
  expect(JSON.stringify(answer)).not.toContain("demo-x");
  // The same sensitive-key protection still covers the explicit full path.
  const full = await bindings.get_pipeline({ pipelineId: pipeline.id, full: true });
  expect(JSON.stringify(full)).not.toContain("demo-x");
  expect(stage.role!.params.password).toBe("demo-x");
});

test("health-probe authorization still refuses every pipeline read before its binding runs", async () => {
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
  const bindings = viewerMcpBindings();
  let reads = 0;
  const service = createMcpToolService({ ...bindings, get_pipeline: async (args, context) => {
    reads += 1;
    return bindings.get_pipeline(args, context);
  } }, new MemoryMcpReceiptStore(), viewerMcpToolPolicy(undefined, true));
  for (const options of [{}, { compact: true }, { stageId: "build" }, { full: true }]) {
    const answer = await service.callTool("get_pipeline", { pipelineId: "p0000001", ...options });
    expect(answer.ok).toBe(false);
  }
  expect(reads).toBe(0);
});

test("stage result remains compatible with short results and bounded for legacy oversized values", () => {
  const { pipeline, stage, attempt } = metadataPipeline();
  Object.assign(attempt.report!, { result: "r".repeat(160) });
  expect(pipelineStageRead(pipeline, stage.id).attempt!.result).toBe("r".repeat(160));
  Object.assign(attempt.report!, { result: "r".repeat(1_000) });
  expect(pipelineStageRead(pipeline, stage.id).attempt!.result!.length).toBeLessThanOrEqual(160);
  Object.assign(attempt.report!, { result: { privatePayload: "demo-x" } });
  expect(pipelineStageRead(pipeline, stage.id).attempt!.result).toBeNull();
});

test("metadata size is independent of prompt bodies, scaffolds and retained history; explicit full reads stay exact", async () => {
  const { pipeline, stage, attempt } = metadataPipeline();
  const small = pipelineStageRead(pipeline, stage.id);
  stage.prompt = "🧭".repeat(500_000);
  stage.effectiveRole.promptScaffold = "s".repeat(1_000_000);
  attempt.definition!.prompt = "b".repeat(1_000_000);
  attempt.input = "i".repeat(1_000_000);
  attempt.output = "o".repeat(1_000_000);
  pipeline.runs[0]!.attempts.unshift(...Array.from({ length: 200 }, (_, i) => ({ ...attempt, n: -i - 1 })));
  const large = pipelineStageRead(pipeline, stage.id);
  expect(bytes(large) - bytes(small)).toBeLessThan(30);
  expect(bytes(large)).toBeLessThan(3_000);
  expect(large.stage.promptMetadata!.length).toBe(1_000_000);
  expect(large.attempt!.promptMetadata!.length).toBe(1_000_000);
  // Persist valid history and the schema's maximum scaffold; the real full
  // binding must retain the large prompt and transcript bodies byte for byte.
  pipeline.runs[0]!.attempts.splice(0, 200);
  stage.effectiveRole.promptScaffold = "s".repeat(MAX_SCAFFOLD_LENGTH);
  savePipelines([pipeline]);
  const bindings = viewerMcpBindings();
  const before = await bindings.get_pipeline({ pipelineId: pipeline.id, full: true });
  const detail = await bindings.get_pipeline({ pipelineId: pipeline.id, stageId: stage.id });
  const after = await bindings.get_pipeline({ pipelineId: pipeline.id, full: true });
  expect(after).toEqual(before);
  const stored = after.pipeline as Pipeline;
  expect(stored.stages[0]!.prompt).toBe(stage.prompt);
  expect(stored.stages[0]!.effectiveRole.promptScaffold).toBe(stage.effectiveRole.promptScaffold);
  const storedAttempt = stored.runs[0]!.attempts.find(row => row.n === attempt.n)!;
  expect(storedAttempt.input).toBe(attempt.input);
  expect(storedAttempt.output).toBe(attempt.output);
  expect(storedAttempt.definition!.prompt).toBe(attempt.definition!.prompt);
  expect(detail).toMatchObject({ stage: { stageDigest: (before.stageDigests as Record<string, string>)[stage.id] }, revision: before.revision });
});

test("get_pipeline reads an accepted report before settlement, after replacement, reopen, explicit selection, and settlement (#1919)", async () => {
  const pipeline = reviewedPipeline();
  const selected = pipeline.runs[0]!.attempts.at(-1)!;
  const firstVerdict = {
    status: "fail" as const,
    findings: ["P0 — first critical finding", "P1 — first important finding", "P3 — first minor finding"],
  };
  selected.state = "running";
  selected.verdict = null;
  selected.report = { ...selected.report!, verdict: firstVerdict, summary: "First accepted report." };
  savePipelines([pipeline]);

  const first = await viewerMcpBindings().get_pipeline({
    clientRequestId: "accepted-before-settlement", pipelineId: pipeline.id, stageId: "build", attempt: selected.n,
  });
  expect(first).toMatchObject({
    attempt: { n: selected.n, state: "running", verdict: "fail", findings: firstVerdict.findings, summary: "First accepted report." },
  });

  const replacementVerdict = {
    status: "needs_decision" as const,
    findings: ["P1 — replacement finding", "P2 — replacement follow-up"],
  };
  const accepted = selected.report;
  if (!accepted) throw new Error("fixture needs an accepted report");
  selected.report = { ...accepted, seq: 2, calls: 2, verdict: replacementVerdict, summary: "Replacement accepted report." };
  savePipelines([pipeline]);

  /* A fresh binding reads the persisted replacement, the same path after a
     process reopen; the attempt remains running until its turn settles. */
  const reopened = await viewerMcpBindings().get_pipeline({
    clientRequestId: "accepted-replacement-reopen", pipelineId: pipeline.id, stageId: "build", attempt: selected.n,
  });
  expect(reopened).toMatchObject({
    attempt: {
      n: selected.n,
      state: "running",
      verdict: "needs_decision",
      findings: replacementVerdict.findings,
      summary: "Replacement accepted report.",
    },
  });

  selected.state = "failed";
  selected.verdict = replacementVerdict;
  savePipelines([pipeline]);
  const settled = await viewerMcpBindings().get_pipeline({
    clientRequestId: "accepted-after-settlement", pipelineId: pipeline.id, stageId: "build", attempt: selected.n,
  });
  expect(settled).toMatchObject({
    attempt: { n: selected.n, state: "failed", verdict: "needs_decision", findings: replacementVerdict.findings },
  });
});

test("list_pipelines state open and compact answer small rows for the lanes that can still move (#1845)", async () => {
  const corpus = pipelineCorpus(24);
  corpus[1]!.state = "needs_decision";
  corpus[2]!.state = "completed";
  corpus[5]!.task = `${"A lane title that runs on ".repeat(20)}\nsecond line of the title`;
  const bindings = viewerMcpBindings(undefined, undefined, {
    getPipelines: () => ({ pipelines: corpus }),
  } as never);

  const open = await bindings.list_pipelines({ clientRequestId: "list-open", state: "open", compact: true }) as {
    count: number;
    pipelines: Array<{ id: string; task: string; state: string; stages: unknown[] }>;
  };
  const expected = corpus.filter((pipeline) => pipeline.state !== "closed" && pipeline.state !== "completed");
  expect(open.pipelines.map((row) => row.id)).toEqual(expected.map((pipeline) => pipeline.id));
  expect(new Set(open.pipelines.map((row) => row.state))).toEqual(new Set(["running", "needs_decision"]));
  /* #2187 §4.1: a compact row names the merge setting only when it is on. */
  expect(Object.keys(open.pipelines[0]!).sort()).toEqual(["cursor", "id", "stages", "state", "stateDetail", "task"]);
  expect(open.pipelines[0]!.stages).toEqual([
    { id: "build", latestAttempt: { n: 6, state: "passed", verdict: "pass" } },
    { id: "review", latestAttempt: { n: 6, state: "passed", verdict: "pass" } },
  ]);
  const long = open.pipelines.find((row) => row.id === corpus[5]!.id)!;
  expect(long.task).not.toContain("second line");
  expect(long.task.length).toBeLessThanOrEqual(121);
  expectNoBodies(open);
  for (const row of open.pipelines) expect(bytes(row)).toBeLessThan(400);

  /* The bounded card rows are unchanged without compact. */
  const cards = await bindings.list_pipelines({ clientRequestId: "list-cards", state: "open", compact: false }) as { pipelines: Array<Record<string, unknown>> };
  expect(cards.pipelines[0]).toHaveProperty("worktreeDir");
  expect(cards.pipelines[0]).toHaveProperty("hasSpec");
});

test("pipeline_action answers the acknowledgement for every accepted action (#1845)", async () => {
  const ticksBefore = requestedTicks;
  const pipeline = reviewedPipeline();
  const graphEdit = { seq: 1, at: "2026-09-19T00:00:00.000Z", action: "override-stage", stageId: "build", effect: "applied", appliesFromAttempt: 7, summary: "overrode build" };
  const bindings = viewerMcpBindings(undefined, undefined, {
    patchPipeline: async (_id: string, request: { action?: string }) => (request.action === "override-stage"
      ? { pipeline, graphEdit }
      : { pipeline }),
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
  } as never);

  for (const action of ["retry-stage", "close", "resume", "skip-stage"]) {
    const answer = await bindings.pipeline_action({ clientRequestId: `ack-${action}`, pipelineId: pipeline.id, action, stageId: "build" });
    expectNoBodies(answer);
    expect(bytes(answer)).toBeLessThan(1_000);
    expect(Object.keys(answer).sort()).toEqual(["changedFields", "closedAt", "cursor", "omittedRecordCount", "pipelineId", "revision", "state", "taskIds"]);
    expect(answer).toMatchObject({
      pipelineId: pipeline.id,
      state: "running",
      cursor: { stageId: "build" },
      closedAt: null,
    });
    expect(answer).not.toHaveProperty("pipeline");
  }
  const edited = await bindings.pipeline_action({ clientRequestId: "ack-edit", pipelineId: pipeline.id, action: "override-stage", stageId: "build" });
  expect(edited).toMatchObject({ pipelineId: pipeline.id, graphEdit });
  await Promise.resolve();
  expect(requestedTicks).toBeGreaterThan(ticksBefore);
});

test("pipeline_action acknowledges durable remote and legacy admission checks as pending", async () => {
  const pipeline = reviewedPipeline();
  pipeline.remoteAction = { id: "retry-intent", action: "retry-stage", state: "pending", fence: "a".repeat(64), at: "now", actor: null };
  const bindings = viewerMcpBindings(undefined, undefined, {
    patchPipeline: async () => ({ pipeline }),
    callerAttribution: () => ({ kind: "manager", conversationId: "conversation_orchestrator", role: "orchestrator" }),
  } as never);
  const retry = await bindings.pipeline_action({ clientRequestId: "pending-retry", pipelineId: pipeline.id, action: "retry-stage" });
  expect(retry).toMatchObject({ remoteCheck: { id: "retry-intent", action: "retry-stage", state: "pending" } });
  delete pipeline.remoteAction;
  pipeline.publicationAdmission = { id: "publication-intent", sha: "a".repeat(40), fence: "a".repeat(64), state: "pending" };
  const publish = await bindings.pipeline_action({ clientRequestId: "pending-publish", pipelineId: pipeline.id, action: "publish" });
  expect(publish).toMatchObject({ publicationAdmission: { id: "publication-intent", state: "pending" } });
  expectNoBodies(retry); expectNoBodies(publish);
});

test("agent_activity compact rows drop paths, host detail and the reports (#1845)", () => {
  const row = {
    conversationId: "conversation_lane",
    transcriptPath: "/state/claude/projects/-repo/0123456789abcdef.jsonl",
    project: "viewer",
    engine: "claude",
    title: "Builder: compact MCP answers\nsecond line",
    lastRecordAt: "2026-09-19T09:00:00.000Z",
    turnState: "busy",
    host: { state: "alive", kind: "structured", pid: 4242 },
    lifecycle: "running",
    reason: "host_alive_turn_active",
    silentForMs: 1_200,
    stalledForMs: null,
    verified: true,
    pipeline: { pipelineId: "pipeline_1", stageId: "build", attempt: 2, reportedState: "running", reportedPipelineState: "running", paneId: null },
    evidenceSource: "transcript",
  };
  const snapshot = {
    observedAt: "2026-09-19T09:00:01.000Z",
    stallAfterMs: 600_000,
    count: 20,
    stalledCount: 1,
    stalledConfirmedCount: 1,
    conversations: Array.from({ length: 20 }, () => row),
    selection: { scope: "project", scanned: 900, matched: 20, selected: 20, recovered: 0, recoveryTruncated: false, recoveryPending: 0, hydrated: 20, unreadable: 0, projected: 0, generation: 12, cacheStatus: "hit", freshScan: false, evidenceBytes: 400_000, budget: "complete" },
    timings: { inventorySelectionMs: 3, journalProjectionMs: 5, evidenceReadMs: 40, serializationMs: 1, totalMs: 49 },
  };
  const compact = compactLiveness(snapshot as never);
  expect(compact.conversations[0]).toEqual({
    conversationId: "conversation_lane",
    title: "Builder: compact MCP answers",
    turnState: "busy",
    lifecycle: "running",
    verified: true,
    silentForMs: 1_200,
    stalledForMs: null,
    pipeline: { pipelineId: "pipeline_1", stageId: "build", attempt: 2 },
  });
  expect(compact).not.toHaveProperty("selection");
  expect(JSON.stringify(compact)).not.toContain("transcriptPath");
  for (const conversation of compact.conversations) expect(bytes(conversation)).toBeLessThan(250);
});

test("account_limits answers each account's windows and tiers, narrowed by engine and account (#1845)", async () => {
  const now = Date.parse("2026-09-19T09:00:00.000Z");
  const observation = (engine: "claude" | "codex" | "copilot", accountId: string, session: number, weekly: number, tiers: Array<{ tier: string; usedPercent: number }> = []) => ({
    engine,
    accountId,
    authenticated: true,
    authCheckedAt: new Date(now - 60_000).toISOString(),
    observedAt: new Date(now - 60_000).toISOString(),
    bootId: "boot",
    provenance: { source: "live", reason: null, staleSince: null },
    limits: {
      session: { usedPercent: session, resetsAt: now / 1000 + 3_600, windowMinutes: 300 },
      weekly: { usedPercent: weekly, resetsAt: now / 1000 + 86_400, windowMinutes: 10_080 },
      tiers: tiers.map((tier) => ({ ...tier, resetsAt: now / 1000 + 86_400 })),
      plan: "max",
      capturedAt: now / 1000 - 60,
    },
  });
  const bindings = viewerMcpBindings(undefined, undefined, {
    accountLimitsSource: () => ({
      accounts: {
        claude: [{ accountId: "claude-a", label: "Account A" }, { accountId: "claude-b", label: "Account B" }],
        codex: [{ accountId: "codex-a", label: "Codex A" }],
        copilot: [{ accountId: "copilot-a", label: "Copilot A" }],
      },
      active: { claude: "claude-a", codex: "codex-a", copilot: "copilot-a" },
      observations: {
        claude: { "claude-a": observation("claude", "claude-a", 12, 40, [{ tier: "opus", usedPercent: 55 }]) },
        codex: { "codex-a": observation("codex", "codex-a", 3, 8) },
        copilot: { "copilot-a": { ...observation("copilot", "copilot-a", 0, 10), limits: { session: null, weekly: { usedPercent: 10, resetsAt: now / 1000 + 86_400, windowMinutes: 43_200 }, tiers: [], plan: null, capturedAt: now / 1000 - 60 }, provenance: { source: "transcript", reason: null, staleSince: null } } },
      },
      now,
    }),
  } as never);

  const all = await bindings.account_limits({ clientRequestId: "limits-all" }) as { count: number; accounts: Array<Record<string, unknown>> };
  expect(all.count).toBe(4);
  expect(all.accounts[0]).toEqual({
    engine: "claude",
    accountId: "claude-a",
    active: true,
    nextChosen: true,
    fresh: true,
    plan: "max",
    session: { usedPercent: 12, resetsAt: "2026-09-19T10:00:00.000Z" },
    weekly: { usedPercent: 40, resetsAt: "2026-09-20T09:00:00.000Z" },
    tiers: [{ tier: "opus", usedPercent: 55, resetsAt: "2026-09-20T09:00:00.000Z" }],
    observedAt: "2026-09-19T08:59:00.000Z",
  });
  /* An account never observed says so rather than inventing zero usage. */
  expect(all.accounts[1]).toMatchObject({ accountId: "claude-b", fresh: false, session: null, weekly: null, tiers: [] });
  for (const account of all.accounts) expect(bytes(account)).toBeLessThan(400);
  /* The label is free text the operator typed when adding the account, so it
     may hold an email or a handle; the account id is the only identity here. */
  for (const account of all.accounts) expect(account).not.toHaveProperty("label");
  expect(JSON.stringify(all)).not.toContain("Account A");

  const codex = await bindings.account_limits({ clientRequestId: "limits-codex", engine: "codex" }) as { accounts: Array<{ accountId: string }> };
  expect(codex.accounts.map((account) => account.accountId)).toEqual(["codex-a"]);
  const copilot = await bindings.account_limits({ clientRequestId: "limits-copilot", engine: "copilot" }) as { accounts: Array<{ accountId: string; engine: string; active: boolean; fresh: boolean; plan: string | null; session: unknown; weekly: { usedPercent: number; resetsAt: string }; tiers: unknown[]; observedAt: string }> };
  expect(copilot.accounts).toEqual([{ accountId: "copilot-a", engine: "copilot", active: true, fresh: true, plan: null, session: null, weekly: { usedPercent: 10, resetsAt: new Date(now / 1000 * 1000 + 86_400_000).toISOString() }, tiers: [], observedAt: new Date(now - 60_000).toISOString() }]);
  const one = await bindings.account_limits({ clientRequestId: "limits-one", accountId: "claude-b" }) as { accounts: Array<{ accountId: string }> };
  expect(one.accounts.map((account) => account.accountId)).toEqual(["claude-b"]);
  await expect(bindings.account_limits({ clientRequestId: "limits-missing", accountId: "nobody" })).rejects.toThrow("no claude, codex or copilot account has the id nobody");

  const selectedBindings = viewerMcpBindings(undefined, undefined, {
    accountLimitsSource: () => ({
      accounts: { claude: [{ accountId: "a", authPresent: true }, { accountId: "b", authPresent: true }], codex: [], copilot: [] },
      active: { claude: "a", codex: null, copilot: null },
      project: "project-fixture",
      model: "opus",
      bindings: [
        { engine: "claude", accountId: "a", project: "project-fixture", createdAt: "2026-09-01T00:00:00.000Z" },
        { engine: "claude", accountId: "b", project: "project-fixture", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
      observations: {
        claude: {
          a: {
            ...observation("claude", "a", 50, 50),
            limits: {
              ...observation("claude", "a", 50, 50).limits,
              session: { usedPercent: 50, resetsAt: now / 1000 + 2 * 86_400, windowMinutes: 300 },
              weekly: { usedPercent: 50, resetsAt: now / 1000 + 2 * 86_400, windowMinutes: 10_080 },
              tiers: [{ tier: "opus", usedPercent: 10, resetsAt: now / 1000 + 4 * 86_400, windowMinutes: 10_080 }],
            },
          },
          b: {
            ...observation("claude", "b", 10, 10),
            limits: {
              ...observation("claude", "b", 10, 10).limits,
              session: { usedPercent: 10, resetsAt: now / 1000 + 3 * 86_400, windowMinutes: 300 },
              weekly: { usedPercent: 10, resetsAt: now / 1000 + 3 * 86_400, windowMinutes: 10_080 },
              tiers: [{ tier: "opus", usedPercent: 50, resetsAt: now / 1000 + 86_400, windowMinutes: 10_080 }],
            },
          },
        }, codex: {}, copilot: {},
      },
      now,
    }),
  } as never);
  const selected = await selectedBindings.account_limits({ clientRequestId: "limits-next-choice", engine: "claude" }) as { accounts: Array<{ accountId: string; active: boolean; nextChosen?: boolean }> };
  expect(selected.accounts).toEqual([
    expect.objectContaining({ accountId: "a", active: true, nextChosen: false }),
    expect.objectContaining({ accountId: "b", active: false, nextChosen: true }),
  ]);
});

test("runtimeLine shows a role tier and the actual fallback after launch", async () => {
  const { pipelineAcknowledgement } = await import("./compactAnswers");
  const pipeline = pipelineCorpus(1)[0]!;
  const stage = pipeline.stages[0]!;
  stage.effectiveRole.serviceTier = "ultrafast";
  stage.effectiveRole.serviceTierSource = "role-default";
  pipeline.runs = [];
  expect(pipelineAcknowledgement(pipeline).runtimeLine).toContain("/ultrafast (role default, if offered)");
  const attempt = pipelineCorpus(1)[0]!.runs[0]!.attempts[0]!;
  attempt.effectiveRole = { ...stage.effectiveRole, serviceTier: undefined, preferredServiceTier: "ultrafast" };
  pipeline.runs = [{ stageId: stage.id, attempts: [attempt] }];
  expect(pipelineAcknowledgement(pipeline).runtimeLine).toContain("/default (role default ultrafast not offered by an available account)");
});


test("create_pipeline initializes a plain folder and acknowledges the committed and excluded paths", async () => {
  const folder = fs.mkdtempSync(path.join(sandbox, "plain-folder-"));
  fs.writeFileSync(path.join(folder, "readme.txt"), "Project\n");
  fs.writeFileSync(path.join(folder, ".env.local"), "private fixture\n");
  const args = { clientRequestId: "plain-folder-create", task: "Create local project", src: creatorPath, repoDir: folder, autoStart: false, stages: [] };
  const result = await viewerMcpBindings().create_pipeline(args) as { repositoryInitialization: { committedFiles: string[]; ignoredPaths: string[] }; delivery: { publishes: boolean } };
  expect(result.repositoryInitialization.committedFiles).toEqual([".gitignore", "readme.txt"]);
  expect(result.repositoryInitialization.ignoredPaths).toContain(".env.local");
  expect(result.delivery.publishes).toBe(false);
  const replay = await viewerMcpBindings().create_pipeline(args) as typeof result;
  expect(replay.repositoryInitialization).toEqual(result.repositoryInitialization);
});
