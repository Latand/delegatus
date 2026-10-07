/*
 * The prototype tools through the MCP service and its durable SQLite receipts,
 * dispatched into the production Viewer handlers. Two agents may pick the same
 * clientRequestId: the receipt belongs to the caller and the task the Viewer
 * resolved for it, so neither can read, or publish as, the other. A publication
 * whose process stopped before its receipt settled is answered from the round
 * it recorded, even once its source files are gone.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { runAsMcpHttpCaller } from "@/lib/mcp/callerContext";
import { createMcpToolService, SqliteMcpReceiptStore, type McpReceiptStore, type McpToolResult } from "@/lib/mcp/server";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { publishPOST, reviewPOST, reviewReadPOST, reviewScopePOST } from "./http";
import { prototypeWorld, type PrototypeWorld } from "./world";

const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const CAPABILITY = { a: "a".repeat(43), b: "b".repeat(43) } as const;
const CALLERS: Record<string, { conversationId: string; project: string }> = {
  [CAPABILITY.a]: { conversationId: "conversation_agent_a", project: "project-a" },
  [CAPABILITY.b]: { conversationId: "conversation_agent_b", project: "project-b" },
};
const roots: string[] = [];
let sandbox = "";
let dispatches: string[] = [];

function task(id: string, project: string) {
  return { id, project, status: "inbox" as const, placement: "unplaced" as const, text: id, assignments: [], sources: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
}
function request(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { host: "localhost", "sec-fetch-site": "same-origin", ...headers } });
}
function world(callers = CALLERS): PrototypeWorld {
  return { ...prototypeWorld, orchestrator: () => null, caller: req => {
    const capability = req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER);
    if (!capability) return { conversationId: null, project: null };
    const caller = callers[capability];
    if (!caller) throw new Error("unknown capability");
    return caller;
  } };
}
/** The Viewer routes the MCP bindings reach, answering as the HTTP control does. */
function control(prototype = world()) {
  return { post: async (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
    const req = request(url, body, headers);
    const route = url.endsWith("/read") ? reviewReadPOST : url.endsWith("/scope") ? reviewScopePOST : publishPOST;
    dispatches.push(url);
    const response = await route(req, prototype);
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? `HTTP ${response.status}`);
    return answer;
  } };
}
const receiptFile = () => path.join(sandbox, "mcp-receipts.sqlite");
function service(store: McpReceiptStore = new SqliteMcpReceiptStore(receiptFile()), prototype = world()) {
  return createMcpToolService(viewerMcpBindings(undefined, control(prototype)), store);
}
/** One call as the agent presenting `capability`, read as the plain answer it is. */
const as = (capability: string, call: () => Promise<McpToolResult>) => runAsMcpHttpCaller({ capability }, call) as Promise<Record<string, unknown>>;
async function frames(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.HOME!, "prototype-receipt-source-")); roots.push(root);
  await fs.writeFile(path.join(root, "new.png"), PNG);
  return root;
}
async function input(key: string, taskId?: string) {
  const root = await frames();
  return { clientRequestId: key, ...(taskId ? { taskId } : {}), title: "Layout", variants: [
    { number: 1, name: "Compact", description: "Keeps the controls together.", frames: [{ path: path.join(root, "new.png"), caption: "Compact controls" }] },
  ] };
}
const rounds = (taskId: string) => loadTasks().find(t => t.id === taskId)?.prototypeReviews ?? [];

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "prototype-receipts-")); roots.push(sandbox);
  dispatches = [];
  saveTasks([task("task-a", "project-a"), task("task-b", "project-b"), task("task-a2", "project-a")]);
});
afterEach(async () => { savePipelines([]); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

test("another project's caller replaying a review read under the same key learns nothing of it", async () => {
  const published = await as(CAPABILITY.a, async () => service().callTool("publish_prototype_review", await input("publish-a", "task-a")));
  expect(published).toMatchObject({ ok: true, taskId: "task-a" });
  const decided = await reviewPOST(request("/api/tasks/task-a/prototypes", { reviewId: published.reviewId, chosen: [1], comment: "Private comment of project A" }), "task-a", world());
  expect(decided.status).toBe(200);
  const args = { clientRequestId: "read-review", taskId: "task-a" };
  const first = await as(CAPABILITY.a, () => service().callTool("read_prototype_review", args));
  expect(JSON.stringify(first)).toContain("Private comment of project A");

  // A new MCP service over the reopened receipt store, as another agent's process would be.
  const foreign = await as(CAPABILITY.b, () => service().callTool("read_prototype_review", args));
  expect(foreign.ok).toBe(false);
  expect(foreign.replayed).not.toBe(true);
  expect(JSON.stringify(foreign)).not.toContain("Private comment of project A");
  const fresh = await as(CAPABILITY.b, () => service().callTool("read_prototype_review", { taskId: "task-a" }));
  expect(fresh.ok).toBe(false);

  // The caller that read it gets the same answer again.
  const again = await as(CAPABILITY.a, () => service().callTool("read_prototype_review", args));
  expect(again).toMatchObject({ ok: true, replayed: true });
  expect(JSON.stringify(again)).toContain("Private comment of project A");
});

test("each pipeline publishes on its own task under the same key, sequentially and in parallel", async () => {
  const role = { roleId: "builder" as const, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: "Build" };
  const pipeline = (id: string, taskId: string, conversationId: string) => {
    const built = buildPipeline({ id, task: id, taskIds: [taskId], project: "project-a", repoDir: "/repo",
      stages: [{ id: "design", kind: "run", role: { roleId: "builder" }, prompt: "Design", next: null, effectiveRole: role }], srcPath: null, srcConversationId: null, now: new Date().toISOString() });
    built.runs[0]!.attempts.push({ n: 1, state: "running", conversationId, launchId: `launch_${id}`, effectiveRole: role,
      sessionId: null, agentPath: null, paneId: null, flowId: null, expectedReviewHeadSha: null, reviewHeadSha: null,
      startedAt: new Date().toISOString(), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null });
    return built;
  };
  savePipelines([pipeline("pipeline-a", "task-a", "conversation_agent_a"), pipeline("pipeline-a2", "task-a2", "conversation_agent_b")]);
  const sameProject = world({ ...CALLERS, [CAPABILITY.b]: { conversationId: "conversation_agent_b", project: "project-a" } });
  const args = await input("publish-design");

  const a = await as(CAPABILITY.a, () => service(undefined, sameProject).callTool("publish_prototype_review", args));
  const b = await as(CAPABILITY.b, () => service(undefined, sameProject).callTool("publish_prototype_review", args));
  expect(a).toMatchObject({ ok: true, taskId: "task-a" });
  expect(b).toMatchObject({ ok: true, taskId: "task-a2", replayed: false });
  expect(rounds("task-a")).toHaveLength(1);
  expect(rounds("task-a2")).toHaveLength(1);
  expect(rounds("task-a2")[0]!.id).toBe(b.reviewId as string);

  const replay = await as(CAPABILITY.a, () => service(undefined, sameProject).callTool("publish_prototype_review", args));
  expect(replay).toMatchObject({ ok: true, replayed: true, reviewId: a.reviewId, taskId: "task-a" });
  expect(rounds("task-a")).toHaveLength(1);

  // Both callers in flight at once in one service under one key.
  const parallelArgs = await input("publish-parallel");
  const shared = service(undefined, sameProject);
  const [pa, pb] = await Promise.all([
    as(CAPABILITY.a, () => shared.callTool("publish_prototype_review", parallelArgs)),
    as(CAPABILITY.b, () => shared.callTool("publish_prototype_review", parallelArgs)),
  ]);
  expect(pa).toMatchObject({ ok: true, taskId: "task-a" });
  expect(pb).toMatchObject({ ok: true, taskId: "task-a2" });
  expect(rounds("task-a")).toHaveLength(2);
  expect(rounds("task-a2")).toHaveLength(2);
});

class StoppedProcess extends Error {}
/** The receipt store as a process sees it that stops at `at`: the row it wrote stays exactly as SQLite holds it. */
function stoppingAt(at: "claim" | "complete"): SqliteMcpReceiptStore {
  const store = new SqliteMcpReceiptStore(receiptFile());
  if (at === "claim") {
    const claim = store.claim.bind(store);
    store.claim = (...args) => { claim(...args); throw new StoppedProcess("stopped after its claim, before dispatch"); };
  } else {
    store.complete = () => { throw new StoppedProcess("stopped between the round's write and the receipt's completion"); };
  }
  return store;
}

test("a publication whose process stopped after the round was written answers with that round, once its sources are gone", async () => {
  const args = await input("publish-stopped", "task-a");
  const stopped = stoppingAt("complete");
  await expect(as(CAPABILITY.a, () => service(stopped).callTool("publish_prototype_review", args))).rejects.toBeInstanceOf(StoppedProcess);
  stopped.close();
  expect(rounds("task-a")).toHaveLength(1);
  const recorded = rounds("task-a")[0]!.id;
  for (const root of roots.filter(root => root !== sandbox)) await fs.rm(root, { recursive: true, force: true });

  const recovered = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
  expect(recovered).toMatchObject({ ok: true, reviewId: recorded, taskId: "task-a" });
  const replayed = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
  expect(replayed).toMatchObject({ ok: true, replayed: true, reviewId: recorded });
  expect(rounds("task-a")).toHaveLength(1);

  const changed = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", { ...args, title: "Another layout" }));
  expect(changed).toMatchObject({ ok: false, code: "idempotency_conflict" });
  expect(rounds("task-a")).toHaveLength(1);
});

test("a publication whose process stopped before dispatch publishes once on the retry", async () => {
  const args = await input("publish-before-dispatch", "task-a");
  const stopped = stoppingAt("claim");
  await expect(as(CAPABILITY.a, () => service(stopped).callTool("publish_prototype_review", args))).rejects.toBeInstanceOf(StoppedProcess);
  stopped.close();
  expect(rounds("task-a")).toHaveLength(0);
  expect(dispatches.filter(url => url === "/api/prototype-reviews")).toHaveLength(0);

  const first = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
  expect(first).toMatchObject({ ok: true, taskId: "task-a" });
  const second = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
  expect(second).toMatchObject({ ok: true, replayed: true, reviewId: first.reviewId });
  expect(rounds("task-a")).toHaveLength(1);
});
