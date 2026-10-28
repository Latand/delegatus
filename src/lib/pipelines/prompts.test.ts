import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DELEGATUS_MECHANICS, OPERATOR_CORRECTION_RULE } from "@/lib/roles/defaults";

import { convertNewLegacyReviewStages } from "./legacyReviewDefinition";
import { buildPipeline } from "./store";
import { effectiveWorkerLimit, setMachineWorkerLimit, setProjectWorkerLimit } from "@/lib/operator/workerLimit";
import { renderStagePrompt } from "./prompts";
import { parseStageVerdict } from "./verdict";
import { pipelineRoleLookup, resolvePipelineRole } from "./roles";
import type { PipelineStage } from "./types";
import { composeStageInput } from "./stageInput";
import { seededTemplatesFromRoles } from "@/lib/workflows/store";

test.each(["vitest", "delegatus", "missing"])("assembled test guidance uses installed tooling and project checks: %s", async (kind) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-test-guidance-"));
  const toolingCwd = process.cwd();
  const worktree = path.join(root, "project checkout");
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, "package.json"), JSON.stringify({
    name: kind === "delegatus" ? "delegatus-cli" : "fixture-project",
    scripts: { test: kind === "delegatus" ? "bun test" : "vitest run" },
  }));
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Build", next: null,
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: null } };
  const pipeline = buildPipeline({ id: "test-guidance", task: "Build", project: "fixture", repoDir: worktree,
    stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  pipeline.worktreeDir = worktree;
  try {
    if (kind === "missing") process.chdir(root);
    const prompt = await composeStageInput(pipeline, stage, stage.effectiveRole, "", worktree,
      async () => ({ code: 1, stdout: "", stderr: "not a Git repository" }));
    if (kind === "missing") {
      expect(prompt).toContain("Gate wrapper unavailable");
      expect(prompt).not.toContain("never bypass it");
    } else {
      const wrapper = fs.realpathSync(path.join(toolingCwd, "scripts", "gate-slot.sh"));
      expect(prompt).toContain(wrapper);
      expect(path.isAbsolute(wrapper)).toBe(true);
      expect(prompt).toContain("never bypass it for lifecycle tests");
    }
  } finally {
    process.chdir(toolingCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("role and workflow defaults leave gate location and test runner to assembly and project rules", () => {
  for (const template of seededTemplatesFromRoles()) expect(template.verify).toBeUndefined();
});

test("comparison guidance names the owner while preserving full host capabilities", () => {
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Compare changes", next: null, sandbox: "full",
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } };
  const pipeline = buildPipeline({ id: "comparison", task: "Compare changes", project: "viewer", repoDir: "/repo", stages: [stage],
    srcPath: null, srcConversationId: null, now: "now" });
  pipeline.delivery = { target: { repository: "repo-fixture", remote: "", branch: "refs/heads/review" },
    disposition: "comparison", publish: "disabled", active: false, ownerId: "publishing-lane", epoch: 2, journal: [] };
  const prompt = renderStagePrompt(pipeline, stage, stage.effectiveRole, "");
  expect(prompt).toContain("owned by publishing-lane at epoch 2");
  expect(stage.sandbox).toBe("full");
});

test("persisted orchestrator scaffolds use the project's worker limit when each stage launches", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-prompt-worker-limit-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    setMachineWorkerLimit(8, { kind: "operator", via: "test" }, null);
    setProjectWorkerLimit("one", 10, { kind: "operator", via: "test" }, null);
    const role = { roleId: "orchestrator" as const, engine: "codex" as const, model: "gpt-6-luna", effort: "high", access: "read-write" as const,
      promptScaffold: "Keep at most 10 workers running. Legacy template: {{maxWorkers}}." };
    const stage: PipelineStage = { id: "coordinate", kind: "run", prompt: "Coordinate", next: null, effectiveRole: role };
    const pipeline = buildPipeline({ id: "worker-limit", task: "Coordinate", project: "one", repoDir: "/repo", stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
    const persisted = JSON.parse(JSON.stringify(pipeline));
    expect(persisted.stages[0].effectiveRole.promptScaffold).toContain("at most 10 workers");

    setProjectWorkerLimit("one", 12, { kind: "operator", via: "test" }, null);
    const prompt = renderStagePrompt(persisted, persisted.stages[0], persisted.stages[0].effectiveRole, "", effectiveWorkerLimit("one").value);
    const preview = renderStagePrompt(persisted, persisted.stages[0], persisted.stages[0].effectiveRole, "");
    expect(preview).toContain("at most 10 workers");
    expect(prompt).toContain("Keep at most 12 workers running.");
    expect(prompt).toContain("Legacy template: 12.");
    expect(prompt).not.toContain("at most 10 workers");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("every run scaffold overrides conflicting branch instructions and names the lane branch", () => {
  for (const access of ["read-write", "read-only"] as const) {
    const stage: PipelineStage = { id: "build", kind: "run", prompt: "Branch from current origin/main", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access, promptScaffold: "Create a new branch" } };
    const pipeline = buildPipeline({ id: "branch-rule", task: "Branch rule", project: "viewer", repoDir: "/repo",
      stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
    const prompt = renderStagePrompt(pipeline, stage, stage.effectiveRole, "Switch branches");
    expect(prompt).toContain(`Pipeline branch: ${pipeline.branch}. Never create or switch branches.`);
    expect(prompt.indexOf("Pipeline branch:")).toBeGreaterThan(prompt.indexOf("Create a new branch"));
    if (access === "read-write") {
      expect(prompt).toContain(`Commit your changes on ${pipeline.branch}`);
    }
    else expect(prompt).not.toContain("Commit your changes on");
  }
});

test("run prompt renders task, previous output, spec, access, verdict, and nesting contracts", () => {
  const stage: PipelineStage = {
    id: "build",
    kind: "run" as const,
    role: { roleId: "builder" },
    engine: "codex" as const,
    ["prompt"]: "Build {{task}} from {{prev.output}}",
    next: "review",
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Keep the implementation focused on {{task}}." },
  };
  const pipeline = buildPipeline({
    id: "12345678",
    task: "pipeline support",
    spec: "AC1: structured verdict",
    project: "viewer",
    repoDir: "/repo",
    stages: [stage, { ...stage, id: "review", next: null }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const prompt = renderStagePrompt(pipeline, stage, {
    roleId: "builder",
    engine: "codex",
    model: null,
    effort: "high",
    access: "read-write",
    promptScaffold: "Keep the implementation focused on {{task}}.",
  }, "the plan");
  expect(prompt).toContain("Build pipeline support from the plan");
  expect(prompt).toContain("AC1: structured verdict");
  expect(prompt).toContain("Access: read-write");
  expect(prompt).toContain(DELEGATUS_MECHANICS);
  /* Review of #2301: the fallback block's own shape, which the parser reads:
     string findings led by their severity, and no summary key. */
  expect(parseStageVerdict('```json\n{"status":"fail","findings":["P1 — src/a.ts:3 wrong label"]}\n```')).toMatchObject({ verdict: { status: "fail", rankedFindings: [{ severity: "P1", text: "src/a.ts:3 wrong label" }] } });
  expect(prompt).toContain("Role preset: builder");
  expect(prompt).toContain("Keep the implementation focused on pipeline support.");
});

test("role-less prompts omit role identity and scaffolding", () => {
  const stage: PipelineStage = {
    id: "research",
    kind: "run",
    ["prompt"]: "Investigate {{task}}",
    next: "write",
    effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null },
  };
  const pipeline = buildPipeline({
    id: "12345678",
    task: "pipeline support",
    project: "viewer",
    repoDir: "/repo",
    stages: [stage, { ...stage, id: "write", next: null }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const prompt = renderStagePrompt(pipeline, stage, {
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    access: "read-write",
    promptScaffold: null,
  }, "");
  expect(prompt).toContain("Investigate pipeline support");
  expect(prompt).toContain("Pinned task:");
  expect(prompt).not.toContain("Role preset:");
  expect(prompt).not.toContain("Role prompt scaffold:");
});

test("a prompt without {{prev.output}} still receives the relayed previous output (#1678)", () => {
  const stage: PipelineStage = {
    id: "verify",
    kind: "run",
    role: { roleId: "builder" },
    engine: "claude",
    ["prompt"]: "Verify the fact the previous stage reported for {{task}}.",
    next: null,
    effectiveRole: { roleId: "builder", engine: "claude", model: "haiku", effort: "low", access: "read-only", promptScaffold: "Builder guidance." },
  };
  const pipeline = buildPipeline({
    id: "12345678",
    task: "pipeline support",
    project: "viewer",
    repoDir: "/repo",
    stages: [{ ...stage, id: "observe", next: "verify" }, stage],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const role = stage.effectiveRole;
  const relayed = renderStagePrompt(pipeline, stage, role, "name agent-log-viewer, version 1.1.0");
  const section = relayed.indexOf("Relayed by the controller");
  expect(section).toBeGreaterThan(relayed.indexOf("Verify the fact the previous stage reported for pipeline support."));
  expect(section).toBeLessThan(relayed.indexOf("Pinned task:"));
  expect(relayed).toContain("name agent-log-viewer, version 1.1.0");

  /* An entry stage, or one whose predecessor wrote nothing, gets no empty section. */
  expect(renderStagePrompt(pipeline, stage, role, "")).not.toContain("Relayed by the controller");
  expect(renderStagePrompt(pipeline, stage, role, "   \n")).not.toContain("Relayed by the controller");

  /* A prompt or scaffold that places the relay itself keeps sole control of where it lands. */
  const placed = renderStagePrompt(pipeline, { ...stage, ["prompt"]: "Relay:\n{{prev.output}}\nVerify {{task}}." }, role, "the observation");
  expect(placed).toContain("Relay:\nthe observation\nVerify pipeline support.");
  expect(placed).not.toContain("Relayed by the controller");
  const scaffolded = renderStagePrompt(pipeline, stage, { ...role, promptScaffold: "Context: {{prev.output}}" }, "the observation");
  expect(scaffolded).toContain("Context: the observation");
  expect(scaffolded).not.toContain("Relayed by the controller");
});

test("the stage prompt renders exactly one JSON fence", () => {
  const stage: PipelineStage = {
    id: "build",
    kind: "run",
    role: { roleId: "builder" },
    engine: "claude",
    ["prompt"]: "Build {{task}}",
    next: null,
    effectiveRole: { roleId: "builder", engine: "claude", model: "opus", effort: "medium", access: "read-write", promptScaffold: null },
  };
  const pipeline = buildPipeline({
    id: "12345678",
    task: "pipeline support",
    project: "viewer",
    repoDir: "/repo",
    stages: [stage],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const prompt = renderStagePrompt(pipeline, stage, stage.effectiveRole, "");

  expect(prompt.split("```json").length - 1).toBe(1);
});

test("every stage a lane renders names no stack and teaches one verdict vocabulary", () => {
  const stage = (id: string, next: string | null, role: NonNullable<PipelineStage["role"]>, prompt: string): PipelineStage => {
    const resolved = resolvePipelineRole({ role }, "run", pipelineRoleLookup);
    if (!resolved.role) throw new Error(resolved.error);
    return { id, kind: "run", role, ["prompt"]: prompt, next, effectiveRole: resolved.role } as PipelineStage;
  };
  const build = stage("build", "review", { roleId: "builder", params: { domain: "frontend" } }, "Build {{task}}. End with REVIEW_READY: <PR url>.");
  const review = { ...stage("review", null, { roleId: "reviewer" }, "Review the change against the pinned spec."), kind: "review-loop" } as PipelineStage;
  review.effectiveRole = { ...review.effectiveRole, access: "read-only" };
  const converted = convertNewLegacyReviewStages([build, review], undefined, () => null, pipelineRoleLookup);
  expect(converted.convertedStages).toEqual([{ reviewer: "review", fixer: "review-fix" }]);
  const pipeline = buildPipeline({ id: "12345678", task: "pipeline support", spec: "AC1: it works", project: "p", repoDir: "/repo", stages: converted.stages, srcPath: null, srcConversationId: null, now: "now" });
  pipeline.baseRef = "a".repeat(40);
  pipeline.baseBranch = "main";
  for (const current of converted.stages) {
    const prompt = renderStagePrompt(pipeline, current, current.effectiveRole, "prior output");
    expect(prompt).not.toMatch(/[a-f0-9]{20,}/i);
    expect(prompt).toContain(`This pipeline's worktree started from commit ${"a".repeat(8)} on main.`);
  }
  /* The fix stage is a builder fix round with the implementer's domain, on
     the fix row (§3 (a)), and its prompt says the first build's steps are done. */
  const fixer = converted.stages.find((current) => current.id === "review-fix")!;
  expect(fixer.role).toEqual({ roleId: "builder", params: { mode: "apply-fixes", domain: "frontend" } });
  expect(fixer.effectiveRole).toMatchObject({ roleId: "builder", engine: "claude", model: "claude-sonnet-5-5", effort: "high", access: "read-write" });
  const fixPrompt = renderStagePrompt(pipeline, fixer, fixer.effectiveRole, "P1 src/a.ts:3 wrong label");
  expect(fixPrompt).toContain("P1 src/a.ts:3 wrong label");
});


/* A stage keeps the scaffold it was created with (pipelines/roles.ts): a lane
   stored before the working rules shipped renders that text byte for byte,
   and the wrapper, which renders at every launch, still gives its fix stage
   the blocked rule whether the stage is known by its params or its fail edge. */
const STORED_FIX_SCAFFOLD = "You are a Builder in apply-fixes mode. Implement the brief with focused checks. You are done when every handed finding and every issue you notice within the pinned specification is fixed, or left unfixed with evidence that it is wrong, and the project's own checks for what you touched pass. The reviewer evaluates the result against the pinned specification. Report the verification evidence; fix any issue you notice within the specification before finishing. Stay inside the scope the brief names. Process cleanup: stop only the processes you started yourself, each by the PID you recorded when you started it.\n\nApply-fixes guidance: Fix every handed finding and anything you notice yourself within the pinned specification.\n\nSafety fences:\n- Product source changes stay inside the scope the brief names.";

test("a stored lane keeps its scaffold after the correction duty and its fix stage still reads the blocked rule", () => {
  const review: PipelineStage = { id: "review", kind: "run", prompt: "Review", next: null, onFail: { to: "fix", maxRounds: 2 },
    effectiveRole: { roleId: "reviewer", engine: "codex", model: null, effort: "xhigh", access: "read-only", promptScaffold: "You are a fresh-context Reviewer. Three standing rules." } };
  const byParams: PipelineStage = { id: "fix", kind: "run", prompt: "Fix", next: "review", role: { roleId: "builder", params: { mode: "apply-fixes" } },
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: STORED_FIX_SCAFFOLD } };
  const pipeline = buildPipeline({ id: "stored", task: "Fix it", project: "viewer", repoDir: "/repo", stages: [review, byParams], srcPath: null, srcConversationId: null, now: "now" });
  const fixPrompt = renderStagePrompt(pipeline, byParams, byParams.effectiveRole, "P1 a finding");
  expect(fixPrompt).toContain(`Role prompt scaffold:\n${OPERATOR_CORRECTION_RULE}\n\n${STORED_FIX_SCAFFOLD}\n`);
  expect(fixPrompt).not.toContain("Working rules (every role, every project)");
  expect(fixPrompt).toContain("For a blocked fix stage, return fail with blocked:true and a non-empty blockedReason");
  expect(fixPrompt).toContain(DELEGATUS_MECHANICS);
  /* A fix stage stored without params, known only by the edge that leads to it. */
  const byEdge: PipelineStage = { ...byParams, role: undefined };
  const edgePipeline = buildPipeline({ id: "stored-edge", task: "Fix it", project: "viewer", repoDir: "/repo", stages: [review, byEdge], srcPath: null, srcConversationId: null, now: "now" });
  expect(renderStagePrompt(edgePipeline, byEdge, byEdge.effectiveRole, "P1 a finding")).toContain("For a blocked fix stage");
  const reviewPrompt = renderStagePrompt(pipeline, review, review.effectiveRole, "");
  expect(reviewPrompt).toContain(`Role prompt scaffold:\n${OPERATOR_CORRECTION_RULE}\n\nYou are a fresh-context Reviewer. Three standing rules.\n`);
  expect(reviewPrompt).not.toContain("For a blocked fix stage");
});

test("an owner without a delivery remote gets a local commit instruction", () => {
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Build", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } };
  const pipeline = buildPipeline({ id: "local", task: "Build", project: "viewer", repoDir: "/repo", stages: [stage],
    srcPath: null, srcConversationId: null, now: "now" });
  pipeline.delivery = { target: { repository: "repo-local", remote: "", branch: `refs/heads/${pipeline.branch}` },
    disposition: "owner", publish: "enabled", active: true, ownerId: pipeline.id, epoch: 1, journal: [] };
  const local = renderStagePrompt(pipeline, stage, stage.effectiveRole, "");
  expect(local).toContain("keep the commits on this local branch and do not push");
  expect(local).not.toContain("Push this branch");
  pipeline.delivery.target.remote = "https://example.invalid/repo.git";
  expect(renderStagePrompt(pipeline, stage, stage.effectiveRole, "")).toContain("Never push; the pipeline publishes");
});


test("retained stage scaffolds receive the correction duty and its write exception on delivery", () => {
  for (const roleId of ["builder", "reviewer", "orchestrator"] as const) {
    const role = { roleId, engine: "codex" as const, model: "gpt-6-luna", effort: "high", access: "read-only" as const,
      promptScaffold: "A stored scaffold.\n\nSafety fences:\n- Change role memory only through curate_rules.\n- Never publish: the only write is issue_report with action preview." };
    const stage: PipelineStage = { id: "work", kind: "run", prompt: "Handle the request", next: null, effectiveRole: role };
    const pipeline = buildPipeline({ id: "retained-correction", task: "Handle the request", project: "one", repoDir: "/repo", stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
    const prompt = renderStagePrompt(pipeline, stage, role, "");
    expect(prompt.split(OPERATOR_CORRECTION_RULE)).toHaveLength(2);
    expect(prompt).not.toContain("Change role memory only through curate_rules.");
    expect(prompt).not.toContain("the only write is issue_report");
    expect(role.promptScaffold).toStartWith("A stored scaffold.");
  }
});
