import { afterAll, afterEach, beforeEach } from "bun:test";
import { canonicalProject, persistProjectAliases } from "@/lib/projects/aliases";
import { projectAliasStore } from "@/lib/projects/persistence";
import { projectForCwd } from "@/lib/scanner/describe";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { clearStoredSeatRecord } from "@/lib/orchestrator/seatStoreFixture";
import {
  expect, spyOn, test, crypto, fs, path, harness, boardTask, RUN_STAGES, engineModule,
  rawCreatePipelineFromRequest, loadPipelines, savePipelines, saveTasks,
} from "@/lib/pipelines/engine.fixture";
import { viewerMcpBindings, viewerMcpRecoverableTools, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore } from "./server";
import { runAsMcpHttpCaller } from "./callerContext";

const SEAT_PROJECT = `repo-${"5".repeat(32)}`;
const TASK_PROJECT = `repo-${"6".repeat(32)}`;
let sequence = 0;
const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
  `${(++sequence).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
afterAll(() => ids.mockRestore());
let restoreCreate = () => {};
afterEach(() => restoreCreate());
beforeEach(() => {
  clearStoredSeatRecord();
  savePipelines([]);
  saveTasks([]);
  projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), () => ({
    next: { aliases: {}, displayNames: {} }, result: undefined,
  }));
});

function fixture() {
  const h = harness();
  const cwd = path.join(process.env.LLV_STATE_DIR!, `repository-${sequence}`);
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(cwd, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/fixture.git\n');
  const repositoryProject = projectForCwd(cwd)!;
  const caller = { kind: "manager" as const, conversationId: "conversation_creator", role: "orchestrator" };
  const designation = { project: SEAT_PROJECT, conversationId: caller.conversationId, clientRequestId: "alias-seat", now: "2026-11-04T00:00:00.000Z" };
  beginOrchestratorSeatIntent({ ...designation, mandate: "Own fixture work", mode: "existing" });
  expect(completeOrchestratorSeatIntent({ ...designation, path: null }).kind).toBe("activated");
  expect(persistProjectAliases([
    { source: repositoryProject, target: SEAT_PROJECT, displayName: "Alias fixture" },
    { source: TASK_PROJECT, target: repositoryProject, displayName: "Alias fixture" },
  ])).toBe(true);
  const task = boardTask("task-alias-mcp", TASK_PROJECT);
  saveTasks([task]);
  h.ports.projectForCwd = projectForCwd;
  const create = spyOn(engineModule, "createPipelineFromRequest").mockImplementation((request, _ports, options) =>
    rawCreatePipelineFromRequest(request, h.ports, options));
  restoreCreate = () => { create.mockRestore(); };
  const domain = {
    callerAttribution: () => caller,
    attentionAuthority: () => ({ kind: "worker", conversationId: caller.conversationId, role: caller.role }),
    authorizedSeats: () => [{ conversationId: caller.conversationId, path: null, project: SEAT_PROJECT }],
    registrySnapshot: () => ({ conversations: { [caller.conversationId]: {
      id: caller.conversationId, agentRole: "orchestrator", generations: [{ path: "/codex/creator.jsonl" }], continuityPaths: [],
    } }, conversationAliases: {} }),
  } as unknown as ViewerMcpDomainDependencies;
  const receipts = new MemoryMcpReceiptStore();
  const service = () => {
    const live = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), receipts, undefined,
      { recovery: viewerMcpRecoverableTools(domain) });
    return { callTool: (...args: Parameters<typeof live.callTool>) => runAsMcpHttpCaller({}, () => live.callTool(...args)) };
  };
  const request = { clientRequestId: "alias-pipeline", task: "Build fixture task", repoDir: cwd, src: "/codex/creator.jsonl",
    taskIds: [task.id], autoStart: true, stages: RUN_STAGES };
  return { h, repositoryProject, task, request, service, receipts };
}

test.each(["omitted", "seat-full", "seat-short", "repository-full", "repository-short", "task-full"] as const)(
  "MCP creates one task-bound pipeline through %s project identity and recovers it", async selection => {
    const f = fixture();
    const project = selection === "omitted" ? undefined : selection === "seat-full" ? SEAT_PROJECT
      : selection === "seat-short" ? SEAT_PROJECT.slice(0, 13) : selection === "repository-full" ? f.repositoryProject
      : selection === "repository-short" ? f.repositoryProject.slice(0, 13) : TASK_PROJECT;
    if (project) expect(await f.service().callTool("get_orchestrator", { project })).toMatchObject({
      ok: true, conversationId: "conversation_creator",
    });
    const args = { ...f.request, project };
    const answer = await f.service().callTool("create_pipeline", args);
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    expect(loadPipelines()).toHaveLength(1);
    expect(loadPipelines()[0]!).toMatchObject({ project: canonicalProject(f.repositoryProject), taskIds: [f.task.id], state: "provisioning" });
    expect(f.h.spawnInputs).toEqual([]);
    // Reconstruct the service, then recover with the original request identity.
    expect(await f.service().callTool("create_pipeline", { ...args, recoveryOnly: true })).toMatchObject({ ok: true });
    expect(await f.service().callTool("create_pipeline", args)).toMatchObject({ ok: true, replayed: true });
    expect(loadPipelines()).toHaveLength(1);
  });

test("MCP refuses a contradictory project before creating or launching work", async () => {
  const f = fixture();
  const other = `repo-${"7".repeat(32)}`;
  expect(persistProjectAliases([{ source: "foreign-fixture", target: other, displayName: "Other fixture" }])).toBe(true);
  const intent = { project: other, conversationId: "conversation_foreign", clientRequestId: "foreign-seat", now: "2026-11-04T00:00:00.000Z" };
  beginOrchestratorSeatIntent({ ...intent, mode: "existing", mandate: "Own other fixture" });
  completeOrchestratorSeatIntent({ ...intent, path: null });
  expect(await f.service().callTool("create_pipeline", { ...f.request, project: other })).toMatchObject({ ok: false, code: "invalid_request" });
  expect(await f.receipts.lookup("create_pipeline:alias-pipeline")).toBeNull();
  expect(loadPipelines()).toEqual([]);
  expect(f.h.spawnInputs).toEqual([]);
});

test("MCP refuses a foreign task even when the requested project alias is valid", async () => {
  const f = fixture();
  saveTasks([boardTask(f.task.id, `repo-${"8".repeat(32)}`)]);
  const answer = await f.service().callTool("create_pipeline", { ...f.request, project: SEAT_PROJECT });
  expect(answer).toMatchObject({ ok: false, error: `task project does not match pipeline project: ${f.task.id}` });
  expect(loadPipelines()).toEqual([]);
  expect(f.h.spawnInputs).toEqual([]);
});

test("MCP refusal names the foreign task when an aliased task precedes it", async () => {
  const f = fixture();
  const foreign = boardTask("task-foreign-mcp", `repo-${"8".repeat(32)}`);
  saveTasks([f.task, foreign]);
  const answer = await f.service().callTool("create_pipeline", { ...f.request, taskIds: [f.task.id, foreign.id] });
  expect(answer).toMatchObject({ ok: false, error: `task project does not match pipeline project: ${foreign.id}` });
  expect(loadPipelines()).toEqual([]);
  expect(f.h.spawnInputs).toEqual([]);
});

test("an aliased creation recovers its durable pipeline after receipt settlement is interrupted", async () => {
  const f = fixture();
  const settle = spyOn(f.receipts, "settle").mockImplementation(() => { throw new Error("fixture receipt interruption"); });
  const args = { ...f.request, project: SEAT_PROJECT };
  try {
    expect(await f.service().callTool("create_pipeline", args)).toMatchObject({ ok: true });
  } finally { settle.mockRestore(); }
  expect(loadPipelines()).toHaveLength(1);
  const id = loadPipelines()[0]!.id;
  expect(await f.service().callTool("create_pipeline", { ...args, recoveryOnly: true })).toMatchObject({ ok: true, pipelineId: id });
  expect(loadPipelines()).toHaveLength(1);
  expect(f.h.spawnInputs).toEqual([]);
});
