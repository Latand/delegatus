import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-reads-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { productionDomainDependencies, viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { saveTasks } = await import("@/lib/tasks/store");
const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
const { pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
const { observeForgePullRequest, resetForgeCacheForTests } = await import("@/lib/forge/cache");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const at = "2026-10-10T12:00:00.000Z";

function lane(id: string, project = "board-a", title = "Calm cards"): Pipeline {
  return { ...buildPipeline({ id, task: title, project, repoDir: root, srcPath: null, srcConversationId: null, now: at,
    stages: [{ id: "build", kind: "run", prompt: "Build", next: null, effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-only", promptScaffold: null } }] }),
    state: "completed", cursor: null, closedAt: at,
    delivery: { target: { repository: "acme/widgets", remote: "https://github.com/acme/widgets.git", branch: "refs/heads/main", pr: 2800 }, disposition: "owner", publish: "enabled", ownerId: id, epoch: 1, active: false, journal: [] } };
}
function task(id: string, project = "board-a"): BoardTask {
  return { id, project, text: "Calm cards", status: "done", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at };
}

function referenceFixture() {
  const manual = (kind: "pr" | "issue", number = 2800) => [{ repository: kind === "issue" ? "acme/requests" : "acme/widgets", number, kind, addedAt: at, addedBy: "operator" as const }];
  const delivery = { ...lane("delivery"), taskIds: ["carried"] };
  const attached = { ...lane("manual"), delivery: undefined, workLinks: manual("pr"), taskIds: ["carried"] };
  const provenance = { ...lane("provenance"), delivery: { ...lane("provenance").delivery!, target: { ...lane("provenance").delivery!.target, pr: undefined } }, runs: pipelineCorpus(1, 1)[0].runs.slice(0, 1), taskIds: ["provenance-task"] };
  provenance.runs[0].attempts[0].report = { seq: 1, at, actor: { kind: "agent", role: "builder", conversationId: null }, verdict: { status: "pass" }, summary: "Done", calls: 1,
    provenance: { head: null, branch: "reference-head", uncommitted: [], outputs: [], pullRequest: { number: 2800, state: "MERGED", url: "https://github.com/acme/widgets/pull/2800" } } };
  const cached = { ...lane("cached"), delivery: { ...lane("cached").delivery!, target: { ...lane("cached").delivery!.target, pr: undefined, branch: "refs/heads/reference-head" } }, taskIds: ["cached-task"] };
  const title = { ...lane("title", "board-a", "#2800 Retained title"), delivery: undefined };
  const longer = { ...lane("longer", "board-a", "#12800 Another change"), delivery: undefined, workLinks: manual("pr", 12800) };
  const issue = { ...lane("issue", "board-a", "Track issue #2800"), delivery: undefined, workLinks: manual("issue") };
  const foreign = { ...lane("foreign", "board-b"), taskIds: ["foreign-task", "foreign-linked"] };
  const pipelines = [delivery, attached, provenance, cached, title, longer, issue, foreign];
  const tasks = [task("carried"), task("provenance-task"), task("cached-task"), { ...task("manual-task"), workLinks: manual("pr") },
    { ...task("issue-task"), text: "Track issue #2800", workLinks: manual("issue") }, task("foreign-linked"), task("foreign-task", "board-b")];
  saveTasks(tasks); savePipelines(pipelines);
  return { tasks, pipelines };
}

for (const mode of ["indexed", "explicit", "fallback"] as const) test(`${mode} PR reads join stored associations, page and fence before counting`, async () => {
  const { tasks, pipelines } = referenceFixture();
  const domain = { ...productionDomainDependencies, callerAttribution: () => ({ kind: "gateway" as const, conversationId: null, role: null }),
    ...(mode === "fallback" ? { taskSelectionSource: undefined, pipelineSelectionSource: undefined, listTaskRecords: () => tasks, listPipelineRecords: () => pipelines } : {}) };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), new MemoryMcpReceiptStore());
  const expectedLanes = ["delivery", "manual", "provenance", "title"];
  const expectedTasks = ["carried", "manual-task", "provenance-task"];
  for (const query of ["2800", "#2800", "PR 2800", "pull request 2800"]) {
    for (const [name, rows, ids] of [["list_pipelines", "pipelines", expectedLanes], ["list_tasks", "tasks", expectedTasks]] as const) {
      const args = { project: "board-a", query, limit: 2, ...(mode === "explicit" ? { ids: (name === "list_pipelines" ? pipelines : tasks).map(row => row.id) } : {}) };
      const first = await service.callTool(name, args);
      expect(first).toMatchObject({ ok: true, total: ids.length, count: 2, hasMore: true });
      if (!first.ok) throw new Error(first.error);
      const next = await service.callTool(name, { ...args, query: "PR 2800", cursor: first.nextCursor });
      expect(next).toMatchObject({ ok: true, total: ids.length, cursorReset: false, hasMore: false });
      if (!next.ok) throw new Error(next.error);
      const found = [...first[rows] as Array<{ id: string }>, ...next[rows] as Array<{ id: string }>].map(row => row.id).sort();
      expect(found).toEqual([...ids].sort());
      expect(new Set(found).size).toBe(ids.length);
      const other = await service.callTool(name, { ...args, project: "board-b", cursor: first.nextCursor });
      expect(other).toMatchObject({ total: 1, cursorReset: true });
    }
  }
  expect(await service.callTool("list_pipelines", { project: "board-a", query: "Retained title" })).toMatchObject({ total: 1 });
  expect(await service.callTool("list_pipelines", { project: "board-a", query: "PR 2800", state: "open" })).toMatchObject({ total: 0 });
  expect(await service.callTool("list_tasks", { project: "board-a", query: "PR 2800", openOnly: true })).toMatchObject({ total: 0 });
});

test("cached branch associations are read afresh without a registry write or a forge refresh", async () => {
  referenceFixture();
  const service = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore());
  expect(await service.callTool("list_pipelines", { project: "board-a", query: "PR 2800" })).toMatchObject({ total: 4 });
  observeForgePullRequest("acme/widgets", { number: 2800, state: "MERGED", url: "https://github.com/acme/widgets/pull/2800" }, "reference-head", at);
  try {
    expect(await service.callTool("list_pipelines", { project: "board-a", query: "PR 2800" })).toMatchObject({ total: 5 });
    expect(await service.callTool("list_tasks", { project: "board-a", query: "PR 2800" })).toMatchObject({ total: 4 });
  } finally { resetForgeCacheForTests(); }
});

test("PR selection materializes only the delivered page and never loads either whole collection", async () => {
  referenceFixture();
  const taskSource = productionDomainDependencies.taskSelectionSource!()!;
  const pipelineSource = productionDomainDependencies.pipelineSelectionSource!()!;
  let taskReads = 0, pipelineReads = 0;
  const domain = { ...productionDomainDependencies,
    taskSelectionSource: () => ({ ...taskSource, read: (id: string) => { taskReads++; return taskSource.read(id); } }),
    pipelineSelectionSource: () => ({ ...pipelineSource, read: (id: string) => { pipelineReads++; return pipelineSource.read(id); } }),
    listTaskRecords: () => { throw new Error("whole task collection read"); },
    listPipelineRecords: () => { throw new Error("whole pipeline collection read"); },
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), new MemoryMcpReceiptStore());
  for (const name of ["list_pipelines", "list_tasks"] as const) expect(await service.callTool(name, { project: "board-a", query: "PR 2800", limit: 1 })).toMatchObject({ ok: true, count: 1 });
  expect(taskReads).toBe(1); expect(pipelineReads).toBe(1);
});

test("an authenticated seat defaults both lists to its designation and refuses another project through MCP", async () => {
  saveTasks([task("own-task"), task("foreign-task", "board-b")]);
  savePipelines([{ ...lane("own-lane"), taskIds: ["own-task"] }, { ...lane("foreign-lane", "board-b"), taskIds: ["foreign-task"] }]);
  const domain = { ...productionDomainDependencies, callerAttribution: () => ({ kind: "manager" as const, conversationId: "seat-own", role: "orchestrator" }),
    callerProject: () => "board-a", authorizedSeats: () => [{ conversationId: "seat-own", path: "seat.jsonl", project: "board-a" }] };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), new MemoryMcpReceiptStore());
  for (const name of ["list_pipelines", "list_tasks"] as const) {
    const result = await service.callTool(name, { query: "PR 2800" });
    expect(result).toMatchObject({ ok: true, total: 1 });
    expect(JSON.stringify(result)).not.toContain("foreign-");
    expect(await service.callTool(name, { project: "board-b", query: "PR 2800" })).toMatchObject({ ok: false, code: "cross_project_refused" });
  }
});

test("a known issue link keeps an ambiguous numbered title out of explicit PR reads", async () => {
  const workLinks = [{ repository: "acme/requests", number: 2800, kind: "issue" as const, addedAt: at, addedBy: "operator" as const }];
  saveTasks([{ ...task("issue-title-task"), text: "#2800 Issue work", workLinks }]);
  savePipelines([{ ...lane("issue-title-lane", "board-a", "#2800 Issue work"), delivery: undefined, workLinks, taskIds: ["issue-title-task"] }]);
  const service = createMcpToolService(viewerMcpBindings(), new MemoryMcpReceiptStore());
  for (const name of ["list_pipelines", "list_tasks"] as const) expect(await service.callTool(name, { project: "board-a", query: "PR 2800" })).toMatchObject({ total: 0 });
});
