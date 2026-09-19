import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const { viewerMcpBindings } = await import("./bindings");
const { compactLiveness } = await import("./compactAnswers");
const { agentRegistry } = await import("@/lib/agent/registry");
const { CORPUS_BODY_MARKERS, pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
const { savePipelines } = await import("@/lib/pipelines/store");
agentRegistry().ensureConversation("codex", creatorPath, null);

const CURRENT_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

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
  latest.verdict = { status: "fail", findings: ["P1 — the route ignores the project filter"] };
  latest.report = {
    seq: 1,
    at: "2026-09-19T09:00:00.000Z",
    actor: { kind: "agent", role: "builder", conversationId: "conversation_stage" },
    verdict: latest.verdict,
    summary: "One finding left.",
    provenance: { head: "0".repeat(40), branch: "pipeline/x", uncommitted: [], pullRequest: null, outputs: [] },
    calls: 1,
  } as never;
  pipeline!.stateDetail = "the first stage failed; waiting on the fail edge";
  return pipeline!;
}

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
      { id: "build", kind: "run", prompt: CORPUS_BODY_MARKERS.stagePrompt.repeat(400), next: "verify" },
      { id: "verify", kind: "run", prompt: "verify ".repeat(400), next: null },
    ],
  }) as { pipelineId: string; stages: unknown[]; stageDigests: Record<string, string> };
  /* Read before toMatchObject, which rewrites matched values in place. */
  const pipelineId = created.pipelineId;
  const createdDigests = { ...created.stageDigests };
  expectNoBodies(created);
  expect(JSON.stringify(created)).not.toContain("promptScaffold");
  expect(bytes(created)).toBeLessThan(800);

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

  const full = await bindings.get_pipeline({ clientRequestId: "compact-create-read", pipelineId }) as { pipeline: { spec: string; stages: Array<{ prompt: string }> }; stageDigests: unknown };
  expect(full.pipeline.spec).toBe(CORPUS_BODY_MARKERS.spec.repeat(300).trim());
  expect(full.pipeline.stages[0]!.prompt).toContain(CORPUS_BODY_MARKERS.stagePrompt.repeat(100));
  expect(full.stageDigests).toEqual(createdDigests);
});

test("get_pipeline with stageId answers one stage's conclusion without prompts or transcripts (#1845)", async () => {
  const pipeline = reviewedPipeline();
  savePipelines([pipeline]);
  const bindings = viewerMcpBindings();

  const whole = await bindings.get_pipeline({ clientRequestId: "stage-whole", pipelineId: pipeline.id });
  const stage = await bindings.get_pipeline({ clientRequestId: "stage-read", pipelineId: pipeline.id, stageId: "build" });
  expectNoBodies(stage);
  expect(bytes(stage)).toBeLessThan(1_500);
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
      findings: ["P1 — the route ignores the project filter"],
      summary: "One finding left.",
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
  expect(bytes(compact)).toBeLessThan(700);
  expect(compact).toMatchObject({ pipelineId: pipeline.id, stages: [{ id: "build", latestAttempt: { n: 6, state: "failed", verdict: "fail" } }, { id: "review" }] });
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
  const cards = await bindings.list_pipelines({ clientRequestId: "list-cards", state: "open" }) as { pipelines: Array<Record<string, unknown>> };
  expect(cards.pipelines[0]).toHaveProperty("worktreeDir");
  expect(cards.pipelines[0]).toHaveProperty("hasSpec");
});

test("pipeline_action answers the acknowledgement for every accepted action (#1845)", async () => {
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
    expect(bytes(answer)).toBeLessThan(400);
    expect(Object.keys(answer).sort()).toEqual(["closedAt", "cursor", "graphDigest", "pipelineId", "stageDigests", "state"]);
    expect(answer).toMatchObject({
      pipelineId: pipeline.id,
      state: "running",
      cursor: { stageId: "build" },
      closedAt: null,
      stageDigests: { build: expect.any(String), review: expect.any(String) },
    });
    expect(answer).not.toHaveProperty("pipeline");
  }
  const edited = await bindings.pipeline_action({ clientRequestId: "ack-edit", pipelineId: pipeline.id, action: "override-stage", stageId: "build" });
  expect(edited).toMatchObject({ pipelineId: pipeline.id, graphEdit });
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
    selection: { scope: "project", scanned: 900, matched: 20, selected: 20, recovered: 0, recoveryTruncated: false, hydrated: 20, unreadable: 0, projected: 0, generation: 12, cacheStatus: "hit", freshScan: false, evidenceBytes: 400_000, budget: "complete" },
    timings: { inventorySelectionMs: 3, journalProjectionMs: 5, evidenceReadMs: 40, serializationMs: 1, totalMs: 49 },
  };
  const compact = compactLiveness(snapshot as never);
  expect(compact.conversations[0]).toEqual({
    conversationId: "conversation_lane",
    title: "Builder: compact MCP answers",
    turnState: "busy",
    lifecycle: "running",
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
  const observation = (engine: "claude" | "codex", accountId: string, session: number, weekly: number, tiers: Array<{ tier: string; usedPercent: number }> = []) => ({
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
      },
      active: { claude: "claude-a", codex: "codex-a" },
      observations: {
        claude: { "claude-a": observation("claude", "claude-a", 12, 40, [{ tier: "opus", usedPercent: 55 }]) },
        codex: { "codex-a": observation("codex", "codex-a", 3, 8) },
      },
      now,
    }),
  } as never);

  const all = await bindings.account_limits({ clientRequestId: "limits-all" }) as { count: number; accounts: Array<Record<string, unknown>> };
  expect(all.count).toBe(3);
  expect(all.accounts[0]).toEqual({
    engine: "claude",
    accountId: "claude-a",
    label: "Account A",
    active: true,
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

  const codex = await bindings.account_limits({ clientRequestId: "limits-codex", engine: "codex" }) as { accounts: Array<{ accountId: string }> };
  expect(codex.accounts.map((account) => account.accountId)).toEqual(["codex-a"]);
  const one = await bindings.account_limits({ clientRequestId: "limits-one", accountId: "claude-b" }) as { accounts: Array<{ accountId: string }> };
  expect(one.accounts.map((account) => account.accountId)).toEqual(["claude-b"]);
  await expect(bindings.account_limits({ clientRequestId: "limits-missing", accountId: "nobody" })).rejects.toThrow("no claude or codex account has the id nobody");
});
