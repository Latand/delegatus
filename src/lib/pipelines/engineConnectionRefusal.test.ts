import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

/* #1876's acceptance case, on a throwaway state directory: an install with one
   Claude account and no Codex account, and a pipeline whose bare reviewer
   stage defaults to Codex. Nothing here launches a process. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-engine-refusal-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_STRUCTURED_HOSTS = "0";
process.env.HOME = path.join(sandbox, "home");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { engineConnectedFrom, ENGINE_NOT_CONNECTED } = await import("@/lib/accounts/engineConnection");
const { equivalentConfig } = await import("@/lib/roles/equivalents");
const { loadRoleDefinitions, saveRoleMapping } = await import("@/lib/roles/store");
const { createPipelineFromRequest, defaultPipelinePorts, patchPipeline } = await import("./engine");
const { savePipelines } = await import("./store");
type PipelinePorts = import("./engine").PipelinePorts;

const REPO = path.join(sandbox, "repo");
fs.mkdirSync(REPO, { recursive: true });
const ACCOUNTS = { claude: [{ id: "primary", authPresent: true }], codex: [] as { id: string; authPresent: boolean }[] };
const CLI_FOUND = { claude: true, codex: true };
let spawns = 0;

function ports(): PipelinePorts {
  return {
    ...defaultPipelinePorts(),
    preflightRepo: () => ({ ok: true, repoDir: REPO, gitCommonDir: path.join(REPO, ".git"), worktreeParent: sandbox }),
    projectForCwd: () => "project-atlas",
    allowedAccountIds: () => null,
    engineReadiness: (engine) => !CLI_FOUND[engine] ? "cli-missing" : engineConnectedFrom(ACCOUNTS[engine], null) ? "connected" : "signed-out",
    spawnAgent: async () => {
      spawns += 1;
      throw new Error("no stage may spawn in this suite");
    },
  };
}

function reviewDraft() {
  return {
    task: "Review the change",
    repoDir: REPO,
    autoStart: false as const,
    stages: [{ id: "review", kind: "run" as const, role: { roleId: "reviewer" as const }, ["prompt"]: "Review the branch", next: null }],
  };
}

beforeEach(() => {
  savePipelines([]);
  spawns = 0;
  ACCOUNTS.codex = [];
  CLI_FOUND.codex = true;
});

test("starting a pipeline whose reviewer runs on a disconnected engine is refused before anything spawns", async () => {
  const created = await createPipelineFromRequest(reviewDraft(), ports(), { allowOperatorDraftWithoutLineage: true });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);
  expect(created.pipeline?.stages[0]?.effectiveRole.engine).toBe("codex");
  /* The draft is stored, and says which stage would be refused. */
  expect(created.warnings).toEqual([{ stageId: "review", engine: "codex", reason: "signed-out", message: expect.stringContaining("no Codex account is signed in") }]);

  const started = await patchPipeline(id, { action: "start" }, ports());
  expect(started.status).toBe(409);
  expect(started.code).toBe(ENGINE_NOT_CONNECTED);
  expect(started.details).toEqual({ stageId: "review", role: "reviewer", engine: "codex", reason: "signed-out", connect: "accounts", mapping: "agent-mapping" });
  expect(started.error).toBe('Stage "review" runs on Codex, and no Codex account is signed in on this machine. Connect Codex (menu → Accounts), or point the reviewer role at another engine (menu → Agent mapping), or set engine and model on this stage.');
  expect(spawns).toBe(0);
  const { getPipeline } = await import("./engine");
  expect(getPipeline(id)?.state).toBe("draft");
});

test("after the reviewer moves to Claude, the same plan starts on Claude Opus", async () => {
  const reviewer = loadRoleDefinitions().find((role) => role.id === "reviewer")!;
  saveRoleMapping({ reviewer: { config: equivalentConfig(reviewer.config, "claude") } });

  const created = await createPipelineFromRequest(reviewDraft(), ports(), { allowOperatorDraftWithoutLineage: true });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);
  expect(created.warnings).toBeUndefined();
  const started = await patchPipeline(id, { action: "start" }, ports());
  expect(started.error).toBeUndefined();
  expect(started.pipeline?.state).toBe("provisioning");
  expect(started.pipeline?.stages[0]?.effectiveRole).toMatchObject({ engine: "claude", model: "opus", effort: "xhigh" });
  expect(spawns).toBe(0);
  saveRoleMapping({ reviewer: { config: null } });
});

test("a stage with an explicit engine is never refused for another engine's sign-in", async () => {
  const request = reviewDraft();
  const created = await createPipelineFromRequest({
    ...request,
    stages: [{ ...request.stages[0]!, engine: "claude" as const, model: "sonnet", effort: "high" }],
  }, ports(), { allowOperatorDraftWithoutLineage: true });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);
  const started = await patchPipeline(id, { action: "start" }, ports());
  expect(started.error).toBeUndefined();
});

test("a signed-in engine whose command is missing is refused just the same, and says so", async () => {
  ACCOUNTS.codex = [{ id: "codex-main", authPresent: true }];
  CLI_FOUND.codex = false;
  const created = await createPipelineFromRequest(reviewDraft(), ports(), { allowOperatorDraftWithoutLineage: true });
  const id = created.pipeline?.id;
  if (!id) throw new Error(`draft was not created: ${created.error}`);
  expect(created.warnings).toEqual([{ stageId: "review", engine: "codex", reason: "cli-missing", message: expect.stringContaining("the codex command was not found") }]);
  const started = await patchPipeline(id, { action: "start" }, ports());
  expect(started.status).toBe(409);
  expect(started.code).toBe(ENGINE_NOT_CONNECTED);
  expect(started.details).toMatchObject({ stageId: "review", engine: "codex", reason: "cli-missing" });
  expect(spawns).toBe(0);
});
