import { expect, test } from "bun:test";

import { ROLE_DEFAULTS } from "@/lib/roles/defaults";

import { convertNewLegacyReviewStages } from "./legacyReviewDefinition";
import { buildPipeline } from "./store";
import { renderDecisionInput, renderStagePrompt } from "./prompts";
import { parseStageVerdict } from "./verdict";
import { pipelineRoleLookup, resolvePipelineRole } from "./roles";
import type { PipelineStage } from "./types";

test("comparison guidance names the owner while preserving full host capabilities", () => {
  const stage: PipelineStage = { id: "build", kind: "run", prompt: "Compare changes", next: null, sandbox: "full",
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } };
  const pipeline = buildPipeline({ id: "comparison", task: "Compare changes", project: "viewer", repoDir: "/repo", stages: [stage],
    srcPath: null, srcConversationId: null, now: "now" });
  pipeline.delivery = { target: { repository: "repo-fixture", remote: "", branch: "refs/heads/review" },
    disposition: "comparison", publish: "disabled", active: false, ownerId: "publishing-lane", epoch: 2, journal: [] };
  const prompt = renderStagePrompt(pipeline, stage, stage.effectiveRole, "");
  expect(prompt).toContain("owned by publishing-lane at epoch 2");
  expect(prompt).toContain("Do not push to that branch");
  expect(prompt).toContain("This instruction is guidance");
  expect(prompt).toContain("Host access: full");
  expect(stage.sandbox).toBe("full");
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
  expect(prompt).toContain('"status":"pass"');
  expect(prompt).toContain('"findings":[]');
  expect(prompt).toContain("it replaces any other ending the brief above asks for (REVIEW_READY, VERDICT: APPROVE, VERDICT: REQUEST_CHANGES, NO FINDINGS): write none of them.");
  expect(prompt).toContain("Its status uses the same three words.");
  /* Review of #2301: the fallback block's own shape, which the parser reads:
     string findings led by their severity, and no summary key. */
  expect(prompt).toContain("In the block each finding is a string that starts with its severity");
  expect(parseStageVerdict('```json\n{"status":"fail","findings":["P1 — src/a.ts:3 wrong label"]}\n```')).toMatchObject({ verdict: { status: "fail", rankedFindings: [{ severity: "P1", text: "src/a.ts:3 wrong label" }] } });
  expect(prompt).not.toContain("COMMENT");
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
  expect(prompt).toContain('"status":"pass"');
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

/* #1797: the rendered stage instruction names one completion channel. The
   fenced block stays in the prompt — the engine still settles from it when no
   report was recorded — but only under the condition that the call failed. */
test("the stage prompt names stage_report as the one completion channel and the fenced block as its fallback", () => {
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

  const call = prompt.indexOf("stage_report");
  const fence = prompt.indexOf("```json");
  expect(call).toBeGreaterThan(-1);
  expect(fence).toBeGreaterThan(call);

  /* Everything introducing the fence is conditional on the call failing, and
     no earlier line asks for the block unconditionally. */
  const preamble = prompt.slice(call, fence);
  expect(preamble).toMatch(/error/i);
  expect(preamble).toMatch(/absent|not available|unavailable/i);
  const introduction = preamble.split("\n").filter((line) => line.trim()).at(-1)!;
  expect(introduction).toMatch(/stage_report/);
  expect(introduction).toMatch(/only when|unless|if/i);

  /* The status vocabulary is still stated, once. */
  expect(prompt).toContain('"status":"pass"');
  expect(prompt.split("needs_decision").length - 1).toBeGreaterThan(0);
  expect(prompt.split("```json").length - 1).toBe(1);
});

test("no role scaffold instructs an unconditional fenced verdict (#1797)", () => {
  for (const role of ROLE_DEFAULTS) {
    const scaffold = role.promptScaffold ?? "";
    expect(scaffold).not.toContain("```");
    expect(scaffold).not.toMatch(/fenced|"status":/i);
  }
});

/* docs/design/agent-prompt-contract.md N5: an answer that replaced a spec
   item lost to the pinned specification rendered below it. */
test("a decision continuation says the answer governs and is relayed under a label that fits it", () => {
  const input = renderDecisionInput(null, { stageId: "build", attempt: 1, question: "Cap at 20 or 100?", answer: "100 replaces spec item 3." } as Parameters<typeof renderDecisionInput>[1]);
  expect(input).toContain("Where the answer differs from the brief or the pinned specification, the answer governs.");
  expect(input).toContain("report the final result with stage_report");
  const stage: PipelineStage = { id: "build", kind: "run", ["prompt"]: "Build it.", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } };
  const pipeline = buildPipeline({ id: "12345678", task: "t", project: "p", repoDir: "/repo", stages: [stage], srcPath: null, srcConversationId: null, now: "now" });
  expect(renderStagePrompt(pipeline, stage, stage.effectiveRole, input)).toContain("Relayed by the controller (a previous stage's output, or the answer to this stage's earlier question):");
});

/* The review check of agent-prompt-contract.md §2.11, on the prompts a lane
   actually renders: a builder, a reviewer and the fix stage a review-loop
   converts into, each through the install's role registry. None names a
   language, a tool, a topology or this product's internals, and the retired
   completion markers appear once, in the sentence that retires them. */
const STACK_SPECIFIC = [/\btsc\b/, /bunx/, /TypeScript/, /blue\/green/i, /external-worker/, /conveyor/i, /8898/, /Ukrainian/, /review flow/i, /list_flows/, /flowRound/, /review review/, /file ownership/, /GitHub CLI/];

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
    for (const pattern of STACK_SPECIFIC) expect(prompt).not.toMatch(pattern);
    expect(prompt).not.toContain("COMMENT");
    expect(prompt).not.toMatch(/Inspect\s+with/);
    expect(prompt).toContain(`This pipeline's worktree started from commit ${"a".repeat(40)} on main.`);
    /* Once in the completion sentence; the builder's brief asked for one more. */
    const briefMarkers = current.id === "build" ? 1 : 0;
    expect(prompt.split("REVIEW_READY").length - 1).toBe(1 + briefMarkers);
    expect(prompt.split("NO FINDINGS").length - 1).toBe(1);
    expect(prompt.split("VERDICT").length - 1).toBe(2);
    /* The server reads the head itself, so a pipeline reviewer is never asked
       to report it (review of #2301). */
    expect(prompt).not.toContain("Report the commit you reviewed");
  }
  /* The fix stage is a builder fix round with the implementer's domain, on
     the fix row (§3 (a)), and its prompt says the first build's steps are done. */
  const fixer = converted.stages.find((current) => current.id === "review-fix")!;
  expect(fixer.role).toEqual({ roleId: "builder", params: { mode: "apply-fixes", domain: "frontend" } });
  expect(fixer.effectiveRole).toMatchObject({ roleId: "builder", engine: "claude", model: "sonnet", effort: "high", access: "read-write" });
  const fixPrompt = renderStagePrompt(pipeline, fixer, fixer.effectiveRole, "P1 src/a.ts:3 wrong label");
  expect(fixPrompt).toContain("Fix the findings stage review reported for: pipeline support");
  expect(fixPrompt).toContain("P1 src/a.ts:3 wrong label");
  expect(fixPrompt).toContain("Apply-fixes guidance");
  expect(fixPrompt).toContain("the specification's steps for the first build (where to branch, whether to open a pull request) are already done");
  /* Review of #2301: the fix stage has one finish line, scoped to its findings. */
  expect(fixPrompt.split("You are done when")).toHaveLength(2);
  expect(fixPrompt).toContain("You are done when every finding that names its place is fixed");
});
