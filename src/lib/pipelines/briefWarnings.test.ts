import { expect, test } from "bun:test";
import { briefWarnings, withBriefWarnings } from "./briefWarnings";
import type { Pipeline, PipelineStage } from "./types";

function stage(prompt: string, access: "read-only" | "read-write" = "read-write"): PipelineStage {
  return { id: "work", kind: "run", prompt, next: null,
    effectiveRole: { roleId: access === "read-only" ? "reviewer" : "builder", engine: "codex", model: "fixture", effort: "high", access, promptScaffold: "" } };
}
const lane = (spec: string, prompt: string, access?: "read-only" | "read-write") => ({ spec, stages: [stage(prompt, access)] });
const conflicts = (input: Parameters<typeof briefWarnings>[0]) => briefWarnings(input).filter(row => row.reason === "acceptance-conflict");

for (const engine of ["claude", "codex"] as const) {
  test(`${engine}: workflow test contradiction names both sides without mutating admission`, () => {
    const pipeline = lane("Update the workflow timeout. Required tests must pass.", "No test edits.");
    pipeline.stages[0]!.effectiveRole.engine = engine;
    const before = structuredClone(pipeline);
    expect(conflicts(pipeline)).toMatchObject([{ stageId: "work", source: "prompt", criterion: expect.any(String), restriction: expect.any(String) }]);
    expect(pipeline).toEqual(before);
    expect(conflicts(lane("Update the workflow timeout. Required tests must pass.", "Update workflow and regression test."))).toEqual([]);
  });
}

test.each(["pipeline-store", "archive", "interruption"])("recipient acceptance exposes excluded %s dependency", resource => {
  expect(conflicts(lane("Complete recipient delivery with archive and interruption owners.", `No ${resource} edits.`))).toHaveLength(1);
});

test("an explicitly assigned successor owns required regression test edits", () => {
  const build = stage("Update the workflow. No test edits. Authority: active parallel owner; Reason: avoid shared edits; Resource: regression tests; Owner: tests stage.");
  const tests = stage("Update regression tests after the workflow change.");
  tests.id = "tests";
  const pipeline = { spec: "Required tests must pass.", stages: [build, tests] };
  expect(conflicts(pipeline)).toEqual([]);

  tests.prompt = "Required tests must pass.";
  expect(conflicts(pipeline)).toMatchObject([{ stageId: "work", reason: "acceptance-conflict" }]);

  pipeline.stages = [build];
  expect(conflicts(pipeline)).toMatchObject([{ stageId: "work", reason: "acceptance-conflict" }]);
});

test("a successor only resolves the conflict when it can edit that resource", () => {
  const build = stage("Update the workflow. No test edits. Authority: active parallel owner; Reason: avoid shared edits; Resource: regression tests; Owner: tests stage.");
  const tests = stage("Update regression tests after the workflow change.");
  tests.id = "tests";
  const pipeline = { spec: "Required tests must pass.", stages: [build, tests] };

  tests.effectiveRole.access = "read-only";
  expect(conflicts(pipeline)).toMatchObject([{ stageId: "work", reason: "acceptance-conflict" }]);

  tests.effectiveRole.access = "read-write";
  tests.access = "read-only";
  expect(conflicts(pipeline)).toMatchObject([{ stageId: "work", reason: "acceptance-conflict" }]);

  tests.access = undefined;
  tests.prompt = "Review regression tests. Update documentation.";
  expect(conflicts(pipeline)).toMatchObject([{ stageId: "work", reason: "acceptance-conflict" }]);

  tests.prompt = "Update regression tests after the workflow change.";
  expect(conflicts(pipeline)).toEqual([]);

  tests.effectiveRole.promptScaffold = "Fixture role\n\nSafety fences:\n- No test edits.";
  expect(conflicts(pipeline)).toMatchObject([
    { stageId: "work", reason: "acceptance-conflict" },
    { stageId: "tests", source: "role/controller", reason: "acceptance-conflict" },
  ]);
});

test.each(["Do not skip tests.", "Do not weaken tests."])("retaining test integrity is not a ban: %s", fence => {
  const prompt = `${fence} Authority: project policy; Reason: verification; Resource: test coverage; Owner: builder.`;
  expect(conflicts(lane("Required tests must pass.", prompt))).toEqual([]);
});

test("fixed SQL mechanism warns while a free implementation preserves equivalence", () => {
  const spec = "Ensure SQL equivalence across the full accepted domain.";
  for (const limit of ["only", "exactly", "fixed"]) {
    expect(conflicts(lane(spec, `Use ${limit} 16 patterns.`))).toMatchObject([{ reason: "acceptance-conflict" }]);
  }
  expect(conflicts(lane(spec, "Choose the mechanism preserving SQL equivalence."))).toEqual([]);
});

test.each(["Close the superseded PR.", "Rerun CI.", "Deploy the reviewed revision."])("read-only action %s stays with its authorized owner", action => {
  expect(conflicts(lane("Review the change.", action, "read-only"))).toMatchObject([{ source: "role/controller", stageId: "work" }]);
  expect(conflicts(lane(action, "Review the artifact and report pending external work.", "read-only"))).toEqual([]);
});

test("a reason needs authority, resource and continuation, and remains advisory", () => {
  const input = lane("Implement the change.", "No test edits. Reason: simplicity.");
  expect(briefWarnings(input).map(row => row.reason)).toEqual(["restriction-reason"]);
  input.stages[0]!.prompt = "No production writes. Authority: project policy; Reason: live data; Resource: production; Owner: release owner after recorded approval.";
  expect(briefWarnings(input)).toEqual([]);
});

test.each([
  "No unrelated process inspection. Authority: project policy; Reason: foreign ownership; Resource: foreign processes; Owner: operator supplies isolated fixture.",
  "No publication until personal review. Authority: operator; Reason: personal hold; Resource: branch; Owner: operator after review.",
  "Do not retry an unknown write. Authority: project policy; Reason: uncertain operation; Resource: receipt; Owner: seat reconciles original key.",
  "No production writes. Authority: project policy; Reason: live state; Resource: production; Owner: operations with current approval. Continue permitted reads.",
])("justified boundary survives the advisory unchanged: %#", prompt => {
  const input = lane("Deliver a bounded evidence report.", prompt);
  const before = structuredClone(input);
  expect(briefWarnings(input)).toEqual([]);
  expect(input).toEqual(before);
});

test("bounded warnings preserve failures and successful records", () => {
  const pipeline = lane("Required tests pass.", Array.from({ length: 60 }, (_, index) => `No test edits in area ${index}.`).join("\n"));
  expect(briefWarnings(pipeline)).toHaveLength(24);
  const refusal = { error: "workspace denied", status: 403, pipeline: undefined };
  expect(withBriefWarnings(refusal)).toBe(refusal);
  const stored = pipeline as Pipeline;
  const result = withBriefWarnings({ pipeline: stored, queued: true });
  expect(result.pipeline).toBe(stored);
  expect(result.queued).toBe(true);
  expect((result as { briefWarnings?: unknown[] }).briefWarnings).toHaveLength(24);
});


test("one justified fence does not supply the reason for a separate restriction", () => {
  const prompt = "No production writes. Authority: project policy; Reason: live state; Resource: production; Owner: release.\n\nNo test edits.";
  expect(briefWarnings(lane("Required tests pass.", prompt)).filter(row => row.reason === "restriction-reason")).toHaveLength(1);
});

test("frozen role fences and explicit read-only overrides participate in the check", () => {
  const input = lane("Required tests pass.", "Update the workflow.");
  input.stages[0]!.effectiveRole.promptScaffold = "Fixture role\n\nSafety fences:\n- No test edits.";
  expect(conflicts(input)).toMatchObject([{ source: "role/controller", stageId: "work" }]);
  const override = lane("Review the change.", "Close the superseded PR.");
  override.stages[0]!.access = "read-only";
  expect(conflicts(override)).toHaveLength(1);
});

test("production acceptance cannot silently lose its necessary action", () => {
  expect(conflicts(lane("Required production write proves recovery.", "No production writes."))).toHaveLength(1);
  expect(conflicts(lane("Deliver a bounded evidence report.", "No production writes."))).toEqual([]);
});


test("a specification fence is compared with the stage's required action", () => {
  expect(conflicts(lane("No test edits.", "Update the regression tests."))).toMatchObject([{ source: "spec", stageId: "work" }]);
});
