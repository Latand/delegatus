import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

/* docs/design/model-sizing-tiers.md §2 at the pipeline seams, on a throwaway
   state directory: who briefed a create or a graph edit decides whether a
   trivial or light stage is admitted. Nothing here launches a process. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-sizing-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_STRUCTURED_HOSTS = "0";
process.env.HOME = path.join(sandbox, "home");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { createPipelineFromRequest, defaultPipelinePorts, patchPipeline } = await import("./engine");
const { pipelineAcknowledgement } = await import("@/lib/mcp/compactAnswers");
const { savePipelines } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;
type LaunchRuntime = import("@/lib/roles/sizing").LaunchRuntime;

const REPO = path.join(sandbox, "repo");
fs.mkdirSync(REPO, { recursive: true });

/* Two seats, told apart by the transcript they create from. */
const SONNET_SEAT = { src: path.join(sandbox, "sonnet-seat.jsonl"), conversationId: "conversation_sonnet_seat" };
const OPUS_SEAT = { src: path.join(sandbox, "opus-seat.jsonl"), conversationId: "conversation_opus_seat" };
const RUNTIMES: Record<string, LaunchRuntime> = {
  [SONNET_SEAT.conversationId]: { engine: "claude", model: "claude-sonnet-5" },
  [OPUS_SEAT.conversationId]: { engine: "claude", model: "opus" },
};

function ports(): PipelinePorts {
  return {
    ...defaultPipelinePorts(),
    preflightRepo: () => ({ ok: true, repoDir: REPO, gitCommonDir: path.join(REPO, ".git"), worktreeParent: sandbox }),
    projectForCwd: () => "project-atlas",
    allowedAccountIds: () => null,
    engineReadiness: () => "connected",
    sourcePathAllowed: (pathname) => pathname === SONNET_SEAT.src || pathname === OPUS_SEAT.src,
    conversationIdForPath: (pathname) => [SONNET_SEAT, OPUS_SEAT].find((seat) => seat.src === pathname)?.conversationId ?? null,
    conversationRuntime: (conversationId) => RUNTIMES[conversationId] ?? null,
    spawnAgent: async () => { throw new Error("no stage may spawn in this suite"); },
  };
}

type CreatePipelineRequest = import("./types").CreatePipelineRequest;
type StageInput = CreatePipelineRequest["stages"][number];

function trivialLane(src: string | undefined, overrides: { build?: Partial<StageInput>; review?: Partial<StageInput> } = {}): CreatePipelineRequest {
  return {
    task: "Fix the label on the settings button",
    repoDir: REPO,
    autoStart: false as const,
    ...(src ? { src } : {}),
    stages: [
      { id: "build", kind: "run" as const, role: { roleId: "builder" as const, params: { size: "trivial", domain: "frontend" } }, ["prompt"]: "Change the label to Save", next: "review", ...overrides.build },
      { id: "review", kind: "review-loop" as const, role: { roleId: "reviewer" as const, params: { size: "trivial" } }, ["prompt"]: "Review the label change", next: null, ...overrides.review },
    ],
  };
}

beforeEach(() => savePipelines([]));

test("a trivial lane briefed by a Sonnet-run agent is refused at create, its fix stage with it", async () => {
  const created = await createPipelineFromRequest(trivialLane(SONNET_SEAT.src), ports(), { briefer: { kind: "agent", conversationId: null } });
  expect(created.pipeline).toBeUndefined();
  expect(created.status).toBe(400);
  expect(created.violations?.map((violation) => violation.field)).toEqual(["stages[0].role", "stages[1].role", "stages[2].role"]);
  expect(created.violations?.[0]?.message).toBe("stage build: size=trivial runs a light model and needs a brief written by an Opus-class agent; this brief comes from claude/claude-sonnet-5.");
});

test("an Opus-run agent's trivial lane is admitted, its fix stage inherits size=trivial, and the answer states each runtime", async () => {
  const created = await createPipelineFromRequest(trivialLane(OPUS_SEAT.src), ports(), { briefer: { kind: "agent", conversationId: OPUS_SEAT.conversationId } });
  if (!created.pipeline) throw new Error(`create refused: ${created.error}`);
  const stages = created.pipeline.stages;
  expect(stages.map((stage) => [stage.id, stage.role?.roleId, stage.role?.params?.size, stage.effectiveRole.engine, stage.effectiveRole.model, stage.effectiveRole.effort])).toEqual([
    ["build", "builder", "trivial", "claude", "sonnet", "high"],
    ["review", "reviewer", "trivial", "codex", "gpt-6-luna", "high"],
    ["review-fix", "builder", "trivial", "claude", "sonnet", "high"],
  ]);
  const answer = pipelineAcknowledgement(created.pipeline);
  expect(answer.stages.map((stage) => [stage.id, stage.role, stage.variant])).toEqual([["build", "builder", "trivial"], ["review", "reviewer", "trivial"], ["review-fix", "builder", "trivial"]]);
  expect(answer.runtimeLine).toBe("build: builder·trivial claude/sonnet/high · review: reviewer·trivial codex/gpt-6-luna/high · review-fix: builder·trivial claude/sonnet/high");
});

test("the operator's own draft is admitted whatever it names", async () => {
  const created = await createPipelineFromRequest(trivialLane(undefined, { review: { role: { roleId: "reviewer" }, engine: "claude", model: "sonnet", effort: "high" } }), ports(), {
    allowOperatorDraftWithoutLineage: true,
    briefer: { kind: "operator" },
  });
  expect(created.error).toBeUndefined();
  expect(created.pipeline?.stages.find((stage) => stage.id === "review")?.effectiveRole.model).toBe("sonnet");
});

test("an explicit Sonnet builder without size=trivial, and an explicit Sonnet reviewer, are refused for an agent", async () => {
  const lightBuilder = await createPipelineFromRequest(trivialLane(OPUS_SEAT.src, {
    build: { role: { roleId: "builder" }, engine: "claude", model: "sonnet", effort: "high" },
    review: { role: { roleId: "reviewer" } },
  }), ports(), { briefer: { kind: "agent", conversationId: OPUS_SEAT.conversationId } });
  expect(lightBuilder.violations?.map((violation) => violation.field)).toEqual(["stages[0].role", "stages[2].role"]);
  expect(lightBuilder.violations?.[0]?.message).toContain("a builder runs claude/sonnet only as size=trivial");

  const sonnetReviewer = await createPipelineFromRequest(trivialLane(OPUS_SEAT.src, {
    review: { role: { roleId: "reviewer" }, engine: "claude", model: "sonnet", effort: "high" },
  }), ports(), { briefer: { kind: "agent", conversationId: OPUS_SEAT.conversationId } });
  expect(sonnetReviewer.violations).toEqual([expect.objectContaining({ field: "stages[1].role", message: expect.stringContaining("Sonnet and Haiku do not run") })]);
});

test("a create without a briefer (the Viewer's own) is not judged", async () => {
  const created = await createPipelineFromRequest(trivialLane(SONNET_SEAT.src), ports());
  expect(created.error).toBeUndefined();
});

test("override-stage and add-stage by an agent actor are checked, and by the operator they are not", async () => {
  const created = await createPipelineFromRequest({
    task: "Normal lane",
    repoDir: REPO,
    autoStart: false as const,
    src: OPUS_SEAT.src,
    stages: [{ id: "build", kind: "run" as const, role: { roleId: "builder" as const }, ["prompt"]: "Build it", next: null }],
  }, ports(), { briefer: { kind: "agent", conversationId: OPUS_SEAT.conversationId } });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`create refused: ${created.error}`);
  const sonnetAgent = { kind: "agent" as const, role: "orchestrator", conversationId: SONNET_SEAT.conversationId };

  const byAgent = await patchPipeline(id, { action: "override-stage", stageId: "build", engine: "claude", model: "sonnet", effort: "high" }, ports(), sonnetAgent);
  expect(byAgent.status).toBe(400);
  expect(byAgent.error).toContain("a builder runs claude/sonnet only as size=trivial");
  const trivialByAgent = await patchPipeline(id, { action: "override-stage", stageId: "build", role: { roleId: "builder", params: { size: "trivial" } } }, ports(), sonnetAgent);
  expect(trivialByAgent.error).toContain("needs a brief written by an Opus-class agent");

  const addedByAgent = await patchPipeline(id, {
    action: "add-stage",
    index: 1,
    stage: { id: "check", kind: "run", role: { roleId: "verifier", params: { claims: "the label reads Save" } }, engine: "claude", model: "haiku", effort: "low", ["prompt"]: "Check it", next: null },
  }, ports(), sonnetAgent);
  expect(addedByAgent.error).toContain("Sonnet and Haiku do not run");

  const byOperator = await patchPipeline(id, { action: "override-stage", stageId: "build", engine: "claude", model: "sonnet", effort: "high" }, ports());
  expect(byOperator.error).toBeUndefined();
  expect(byOperator.pipeline?.stages[0]?.effectiveRole).toMatchObject({ engine: "claude", model: "sonnet" });
});
