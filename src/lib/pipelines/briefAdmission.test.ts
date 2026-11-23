import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "brief-admission-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.HOME = path.join(sandbox, "home");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_STRUCTURED_HOSTS = "0";
for (const dir of [process.env.LLV_STATE_DIR, process.env.HOME, process.env.XDG_CONFIG_HOME]) fs.mkdirSync(dir, { recursive: true });
afterAll(() => fs.rmSync(sandbox, { force: true, recursive: true }));
const { createPipelineFromRequest, patchPipeline, defaultPipelinePorts } = await import("./engine");
const { savePipelines } = await import("./store");
const repo = path.join(sandbox, "repo");
fs.mkdirSync(repo);
let spawns = 0;
const ports = () => ({ ...defaultPipelinePorts(),
  now: () => "2026-11-12T10:00:00.000Z",
  preflightRepo: () => ({ ok: true as const, repoDir: repo, gitCommonDir: path.join(repo, ".git"), worktreeParent: sandbox }),
  projectForCwd: () => "fixture-project",
  engineReadiness: () => "connected" as const,
  allowedAccountIds: () => null,
  sourcePathAllowed: () => true,
  conversationIdForPath: () => "conversation_fixture-creator",
  exec: async (_command: string, args: string[]) => ({
    code: args[0] === "remote" && args[1] === "get-url" ? 2 : 0,
    stdout: args[0] === "rev-parse" ? "a".repeat(40) : args[0] === "symbolic-ref" ? "refs/heads/main" : "",
    stderr: "",
  }),
  spawnAgent: async () => { spawns++; throw new Error("no launch in admission check"); },
});
const request = (engine: "codex" | "claude", autoStart = false) => ({ task: "Workflow timeout", spec: "Required tests pass after the workflow update.", repoDir: repo, autoStart, publication: "internal" as const,
  stages: [{ id: "build", kind: "run" as const, prompt: "No test edits.", next: null as string | null, engine, model: engine === "codex" ? "gpt-6.1-sol" : "opus", role: { roleId: "builder" as const } }],
});
beforeEach(() => { savePipelines([]); spawns = 0; });

for (const engine of ["claude", "codex"] as const) {
  test(`${engine}: draft and replay warn once; start only counts existing warnings`, async () => {
    const options = { allowOperatorDraftWithoutLineage: true, creationRequest: { key: `brief-${engine}`, digest: "same-request" } };
    const created = await createPipelineFromRequest(request(engine), ports(), options);
    expect(created.error).toBeUndefined();
    expect(created.pipeline?.state).toBe("draft");
    expect(created.briefWarnings?.some(row => row.reason === "acceptance-conflict")).toBe(true);
    const replay = await createPipelineFromRequest(request(engine), ports(), options);
    expect(replay.pipeline?.id).toBe(created.pipeline!.id);
    expect(replay.briefWarnings).toEqual(created.briefWarnings);
    const started = await patchPipeline(created.pipeline!.id, { action: "start" }, ports());
    expect(started.error).toBeUndefined();
    expect(started.pipeline?.state).toBe("provisioning");
    expect(started.briefWarnings).toBeUndefined();
    expect(started.briefWarningCount).toBe(created.briefWarnings!.length);
    expect(spawns).toBe(0);
  });
}

test("draft edit recomputes warnings from the normalized replacement", async () => {
  const created = await createPipelineFromRequest(request("codex"), ports(), { allowOperatorDraftWithoutLineage: true });
  const corrected = request("codex");
  corrected.stages[0]!.prompt = "Update workflow and its regression test.";
  const edited = await patchPipeline(created.pipeline!.id, { action: "override-stage", stageId: "build", prompt: corrected.stages[0]!.prompt }, ports());
  expect(edited.error).toBeUndefined();
  expect(edited.briefWarnings).toBeUndefined();
  expect(edited.pipeline?.stages[0]?.effectiveRole.access).toBe("read-write");
  expect(spawns).toBe(0);
});

test("automatic start admits warnings, and invalid graphs keep their refusal", async () => {
  const created = await createPipelineFromRequest({ ...request("codex", true), src: "fixtures/creator.jsonl" }, ports());
  expect(created.error).toBeUndefined();
  expect(created.pipeline?.state).toBe("provisioning");
  expect(created.briefWarnings?.some(row => row.reason === "acceptance-conflict")).toBe(true);
  const invalid = await createPipelineFromRequest({ ...request("codex"), stages: [{ ...request("codex").stages[0]!, next: "missing" }] }, ports(), { allowOperatorDraftWithoutLineage: true });
  expect(invalid.pipeline).toBeUndefined();
  expect(invalid.error).toBeDefined();
  expect(invalid.briefWarnings).toBeUndefined();
  expect(spawns).toBe(0);
});


test("removing a stage only counts diagnostics for the resulting brief", async () => {
  const input = request("codex");
  input.stages[0]!.next = "review";
  input.stages.push({ ...input.stages[0]!, id: "review", prompt: "Review the artifact.", next: null });
  const created = await createPipelineFromRequest(input, ports(), { allowOperatorDraftWithoutLineage: true });
  expect(created.error).toBeUndefined();
  const edited = await patchPipeline(created.pipeline!.id, { action: "remove-stage", stageId: "review" }, ports());
  expect(edited.error).toBeUndefined();
  expect(edited.pipeline?.stages).toHaveLength(1);
  expect(edited.briefWarnings).toBeUndefined();
  expect(edited.briefWarningCount).toBeGreaterThan(0);
  expect(spawns).toBe(0);
});
