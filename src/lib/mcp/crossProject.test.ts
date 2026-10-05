import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectForCwd } from "@/lib/scanner/describe";
import { loadTasks } from "@/lib/tasks/store";

import { viewerMcpBindings, viewerMcpRecoverableTools, type CallerAttribution } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, TOOL_INPUT_SCHEMAS, type McpToolResult } from "./server";

/*
 * #2518 part 4: cross-project work goes seat to seat. A designated seat that
 * puts a task, a pipeline or an agent on a project that has its own seat is
 * refused with a pointer to send_message_to_orchestrator, unless it quotes the
 * operator's request for exactly that in crossProjectRequest.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-cross-project-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  fs.mkdirSync(path.join(sandbox, "other"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, "unmanaged"), { recursive: true });
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const OWN = "own-project";
const OWN_SEAT = "conversation_own_seat";
const OTHER_SEAT = "conversation_other_seat";
const SEAT: CallerAttribution = { kind: "manager", conversationId: OWN_SEAT, role: "orchestrator" };
const DEPUTY: CallerAttribution = { kind: "manager", conversationId: OWN_SEAT, role: "orchestrator", via: { deputy: "conversation_deputy" } };
const WORKER: CallerAttribution = { kind: "agent", conversationId: "conversation_worker", role: "builder" };
const OPERATOR: CallerAttribution = { kind: "gateway", conversationId: "conversation_root", role: null };

const otherDir = () => path.join(sandbox, "other");
const unmanagedDir = () => path.join(sandbox, "unmanaged");
/* The other project is whatever its directory resolves to, the way a launch resolves it. */
const otherProject = () => projectForCwd(otherDir())!;

function dependencies(caller: CallerAttribution) {
  return {
    attentionAuthority: () => ({ kind: "worker", conversationId: caller.conversationId, role: caller.role }),
    callerAttribution: () => caller,
    authorizedSeats: () => [
      { conversationId: OWN_SEAT, path: "seat-own.jsonl", project: OWN },
      { conversationId: OTHER_SEAT, path: "seat-other.jsonl", project: otherProject() },
    ],
    loadTasks,
  } as never;
}

/* The task store is opened once per process and may outlive it, so every
   request key and card name of a run carries the run's own mark. */
const RUN = Math.random().toString(36).slice(2, 10);
let next = 0;
function call(caller: CallerAttribution, tool: "create_task" | "create_pipeline" | "spawn_agent", args: Record<string, unknown>) {
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies(caller)), new MemoryMcpReceiptStore());
  return service.callTool(tool, { clientRequestId: `cross-project-${RUN}-${next += 1}`, ...args, ...(typeof args.text === "string" ? { text: `${args.text} ${RUN}` } : {}) }) as Promise<McpToolResult & Record<string, unknown>>;
}

const REFUSED = { ok: false, code: "cross_project_refused", retryable: false };
const cardsNamed = (text: string) => loadTasks().filter((task) => task.text === `${text} ${RUN}`);

test("the three launch tools take crossProjectRequest and nothing else changed in what they require", () => {
  for (const tool of ["create_task", "create_pipeline", "spawn_agent"] as const) {
    expect(Object.keys(TOOL_INPUT_SCHEMAS[tool].shape)).toContain("crossProjectRequest");
  }
});

test("a seat's task on another seat's board is refused with a pointer to the relay, and nothing is created", async () => {
  const refused = await call(SEAT, "create_task", { project: otherProject(), text: "Refused seat card" });
  expect(refused).toMatchObject(REFUSED);
  expect(refused.error).toContain("send_message_to_orchestrator");
  expect(refused.error).toContain("crossProjectRequest");
  expect(refused.details).toMatchObject({ tool: "create_task", seatProject: OWN, targetProject: otherProject(), use: "send_message_to_orchestrator" });
  expect(cardsNamed("Refused seat card")).toEqual([]);
});

test("the seat's parallel self is the seat, and is refused the same way", async () => {
  expect(await call(DEPUTY, "create_task", { project: otherProject(), text: "Refused deputy card" })).toMatchObject(REFUSED);
  expect(cardsNamed("Refused deputy card")).toEqual([]);
});

test("the operator's explicit request, quoted in crossProjectRequest, lets the task through", async () => {
  const created = await call(SEAT, "create_task", {
    project: otherProject(), text: "Card the operator asked for", crossProjectRequest: "Put this one on their board yourself, their seat is rotating.",
  });
  expect(created.ok).toBe(true);
  const tasks = cardsNamed("Card the operator asked for");
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.project).toBe(otherProject());
  /* The quote is the seat's statement to Delegatus; it is not stored on the card. */
  expect(JSON.stringify(tasks[0])).not.toContain("their seat is rotating");
  /* A blank quote says nothing. */
  expect(await call(SEAT, "create_task", { project: otherProject(), text: "Blank quote card", crossProjectRequest: "   " })).toMatchObject(REFUSED);
  expect(cardsNamed("Blank quote card")).toEqual([]);
});

test("a seat works its own board, and a project with no seat has nobody to hand over to", async () => {
  expect((await call(SEAT, "create_task", { project: OWN, text: "Our own work" })).ok).toBe(true);
  expect((await call(SEAT, "create_task", { project: "project-without-a-seat", text: "Nobody manages this board" })).ok).toBe(true);
  expect(cardsNamed("Our own work").map((task) => task.project)).toEqual([OWN]);
  expect(cardsNamed("Nobody manages this board").map((task) => task.project)).toEqual(["project-without-a-seat"]);
});

test("only a seat is judged: a worker and the operator's own session create the task as before", async () => {
  expect((await call(WORKER, "create_task", { project: otherProject(), text: "A worker's follow-up" })).ok).toBe(true);
  expect((await call(OPERATOR, "create_task", { project: otherProject(), text: "The operator's own card" })).ok).toBe(true);
  expect(cardsNamed("A worker's follow-up")).toHaveLength(1);
  expect(cardsNamed("The operator's own card")).toHaveLength(1);
});

test("a seat's agent in another seat's project is refused before anything is dispatched", async () => {
  const dispatched: string[] = [];
  const control = { dispatch: async (route: string) => { dispatched.push(route); throw new Error("no dispatch expected"); } } as never;
  const service = createMcpToolService(viewerMcpBindings(undefined, control, dependencies(SEAT)), new MemoryMcpReceiptStore());
  const refused = await service.callTool("spawn_agent", {
    clientRequestId: "cross-project-spawn", cwd: otherDir(), prompt: "Fix their login form", title: "Login form fix",
  }) as McpToolResult & Record<string, unknown>;
  expect(refused).toMatchObject({ ok: false });
  expect(refused.error).toContain("spawn_agent from an orchestrator seat onto another project's board is refused");
  expect(refused.error).toContain("send_message_to_orchestrator");
  expect(dispatched).toEqual([]);
});

test("the recoverable launch tools refuse while they bind, so no receipt is claimed for a refused launch", () => {
  const tools = viewerMcpRecoverableTools(dependencies(SEAT));
  const spawn = () => tools.spawn_agent!.bind({ clientRequestId: "bind-spawn", cwd: otherDir(), prompt: "p", title: "t" });
  const pipeline = () => tools.create_pipeline!.bind({ clientRequestId: "bind-pipeline", repoDir: otherDir(), task: "Fix their login form", stages: [] });
  for (const bind of [spawn, pipeline]) {
    let thrown: unknown;
    try { bind(); } catch (error) { thrown = error; }
    expect((thrown as { details?: { code?: string; use?: string } }).details).toMatchObject({ code: "cross_project_refused", use: "send_message_to_orchestrator" });
  }
  /* With the operator's request quoted, the pipeline binds to the other project. */
  const bound = tools.create_pipeline!.bind({ clientRequestId: "bind-pipeline-asked", repoDir: otherDir(), task: "t", stages: [], crossProjectRequest: "Do it on their board." });
  expect(bound).toMatchObject({ target: { project: otherProject() } });
  /* A directory no seat manages binds as before. */
  expect(tools.create_pipeline!.bind({ clientRequestId: "bind-unmanaged", repoDir: unmanagedDir(), task: "t", stages: [] }))
    .toMatchObject({ target: { project: projectForCwd(unmanagedDir()) } });
});
