import { afterAll, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { pipelineCorpus } from "./fixtures/corpus";
import { findPipelineRecord, isStoredPipeline, savePipelines, withPipelineMutation } from "./store";
import { defaultPipelinePorts, patchPipeline, settlePendingRemoteActions } from "./engine";
import { prototypeCriticGate } from "@/lib/prototypeReview/criticGate";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { createMcpToolService, MemoryMcpReceiptStore } from "@/lib/mcp/server";
import { registerPipelineTick } from "./controllerSignal";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { publishPOST } from "@/lib/prototypeReview/http";
import { prototypeWorld } from "@/lib/prototypeReview/world";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

const restore = registerPipelineTick(async () => {});
setSystemTime(new Date("2026-10-12T10:05:00Z"));
afterAll(() => { restore(); closeAgentRegistryForTests(); setSystemTime(); });
const HEAD = "a".repeat(40);
function setup() {
  const lane = pipelineCorpus(2, 1)[1]!;
  const template = lane.stages[0]!;
  lane.stages = ["prototype", "critic", "proto-fix", "publish"].map((id, index, ids) => ({
    ...structuredClone(template), id, kind: "run", next: ids[index + 1] ?? null,
    role: { roleId: id === "critic" ? "visual-critic" : "builder" },
    effectiveRole: { ...template.effectiveRole, roleId: id === "critic" ? "visual-critic" : "builder" },
  }));
  lane.stages[1]!.next = "publish";
  lane.stages[1]!.onFail = { to: "proto-fix", maxRounds: 2, onExhausted: "park" };
  const attempt = lane.runs[0]!.attempts[0]!;
  lane.runs = lane.stages.slice(0, 3).map(stage => ({ stageId: stage.id, attempts: [{
    ...structuredClone(attempt), n: stage.id === "critic" ? 3 : 1,
    state: stage.id === "critic" ? "failed" : "passed",
    effectiveRole: stage.effectiveRole, flowId: null, launchId: null, agentPath: null,
    startedAt: "2026-10-12T10:00:00Z", completedAt: "2026-10-12T10:01:00Z",
    verdict: { status: stage.id === "critic" ? "fail" : "pass", findings: [] },
  }] }));
  const critic = lane.runs[1]!.attempts[0]!;
  lane.runs[1]!.attempts = [1, 2, 3].map(n => ({ ...structuredClone(critic), n }));
  lane.runs.push({ stageId: "publish", attempts: [] });
  lane.state = "needs_decision"; lane.closedAt = null; lane.publication = "internal";
  lane.cursor = { stageId: "critic", state: "pending", input: null, activatedBy: null };
  lane.lastPassedCommit = HEAD;
  savePipelines([lane]);
  let commands = 0;
  const ports = { ...defaultPipelinePorts(), now: () => "2026-10-12T10:05:00Z",
    remoteActionSupported: () => true, getFlow: () => null,
    conversationAgentActive: async () => false, paneAgentAlive: async () => false,
    stageHostResident: async () => false, stopStageAgent: async () => ({ outcome: "not-running" as const }),
    exec: async (_command: string, args: string[]) => {
      commands++;
      return { code: 0, stdout: args[0] === "rev-parse" ? HEAD : args[0] === "branch" ? lane.branch : "", stderr: "" };
    },
  };
  return { lane, ports, commands: () => commands };
}

test.each(["orchestrator", "builder", null])("MCP %s cannot skip the prototype critic gate", async role => {
  const h = setup();
  if (role === "builder") {
    // An override for the next attempt cannot erase the current critic gate.
    h.lane.stages[1]!.role = { roleId: "builder" };
    h.lane.stages[1]!.effectiveRole.roleId = "builder";
    savePipelines([h.lane]);
  }
  const before = findPipelineRecord(h.lane.id)!;
  const caller = { kind: role === "orchestrator" ? "manager" : "agent", role, conversationId: "conversation_skip_caller" };
  const bindings = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => caller,
    attentionAuthority: () => ({ kind: "worker", role, conversationId: caller.conversationId }),
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {}, memberships: {}, lineageEdges: {}, receipts: {}, entries: {} }),
    authorizedSeats: () => [], getPipelines: () => ({ pipelines: [findPipelineRecord(h.lane.id)!] }),
    patchPipeline: (id: string, request: Parameters<typeof patchPipeline>[1], _ports: unknown, actor?: PauseResumeActor) => patchPipeline(id, request, h.ports, actor),
  } as never);
  const result = await createMcpToolService(bindings, new MemoryMcpReceiptStore()).callTool("pipeline_action", {
    clientRequestId: "skip-critic", pipelineId: h.lane.id, action: "skip-stage", actor: { kind: "operator" }, operatorCriticSkip: true,
  });
  // On the base this reproduces the dead end: the skip advances, then publish refuses.
  if (result.ok) {
    await settlePendingRemoteActions(h.ports);
    expect(prototypeCriticGate(findPipelineRecord(h.lane.id)!, "publish")).toEqual({
      ok: false, missing: "visual-critic stage critic has not passed: attempt 3 skipped",
    });
  }
  expect(result.ok).toBe(false);
  expect(String(result.error)).toContain("visual-critic gate critic");
  expect(String(result.error)).toContain("retry the critic stage");
  expect(String(result.error)).toContain("operator");
  expect(findPipelineRecord(h.lane.id)).toEqual(before);
  expect(h.commands()).toBe(0);
});

test("an operator skip survives a fresh reader and publishes the uncritiqued prototype", async () => {
  const h = setup();
  expect((await patchPipeline(h.lane.id, { action: "skip-stage" }, h.ports, { kind: "operator" })).error).toBeUndefined();
  await settlePendingRemoteActions(h.ports);
  const lane = findPipelineRecord(h.lane.id)!;
  expect(lane.cursor?.stageId).toBe("publish");
  expect(lane.runs[1]!.attempts.at(-1)).toMatchObject({ state: "skipped", operatorCriticSkip: true });
  expect(prototypeCriticGate(lane, "publish")).toEqual({ ok: true, pass: {
    pipelineId: lane.id, stageId: "critic", attempt: 3, outcome: "skipped-by-operator",
  } });
  const child = Bun.spawn([process.execPath, "-e", `
    const { findPipelineRecord } = await import("./src/lib/pipelines/store.ts");
    const { prototypeCriticGate } = await import("./src/lib/prototypeReview/criticGate.ts");
    console.log(JSON.stringify(prototypeCriticGate(findPipelineRecord(${JSON.stringify(lane.id)}), "publish")));
  `], { stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, error).toBe(0);
  expect(JSON.parse(output)).toEqual(prototypeCriticGate(lane, "publish"));

  const root = await fs.mkdtemp(path.join(process.env.HOME!, "critic-prototype-"));
  try {
    const image = path.join(root, "prototype.png");
    await fs.writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    saveTasks([{ id: "prototype-task", project: lane.project, text: "Review prototype", status: "inbox", placement: "unplaced",
      assignments: [], createdAt: h.ports.now(), updatedAt: h.ports.now() }]);
    const response = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews", {
      method: "POST", headers: { host: "localhost", "sec-fetch-site": "same-origin", cookie: `llv_operator=${soloBrowserSession()}` },
      body: JSON.stringify({ clientRequestId: "operator-skipped-publication", title: "Prototype layout",
        variants: [{ number: 1, name: "Layout", description: "Review the proposed layout.", frames: [{ path: image, caption: "Layout" }] }] }),
    }), { ...prototypeWorld, caller: () => ({ conversationId: "conversation_publisher", project: lane.project }),
      stage: () => ({ taskIds: ["prototype-task"], project: lane.project,
        source: { conversationId: "conversation_publisher", pipelineId: lane.id, stageId: "publish", attempt: 1 } }),
      pipeline: () => findPipelineRecord(lane.id),
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(loadTasks()[0]!.prototypeReviews!.at(-1)!.title).toContain("Visual critic skipped by operator");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missing caller authority cannot skip a visual critic", async () => {
  const h = setup(); const before = findPipelineRecord(h.lane.id);
  expect((await patchPipeline(h.lane.id, { action: "skip-stage" }, h.ports, null)).status).toBe(403);
  expect(findPipelineRecord(h.lane.id)).toEqual(before);
  expect(h.commands()).toBe(0);
});

test("an agent can still skip an ordinary stage and its attribution remains readable", async () => {
  const h = setup();
  h.lane.stages[1]!.role = { roleId: "builder" };
  h.lane.stages[1]!.effectiveRole.roleId = "builder";
  h.lane.runs[1]!.attempts.at(-1)!.effectiveRole.roleId = "builder";
  savePipelines([h.lane]);
  const actor = { kind: "agent" as const, role: "builder", conversationId: "conversation_skip_caller" };
  expect((await patchPipeline(h.lane.id, { action: "skip-stage" }, h.ports, actor)).error).toBeUndefined();
  await settlePendingRemoteActions(h.ports);
  const current = findPipelineRecord(h.lane.id)!;
  expect(current.cursor?.stageId).toBe("publish");
  expect(current.runs[1]!.attempts.at(-1)).toMatchObject({ state: "skipped", output: "Skipped by agent." });
  expect(current.runs[1]!.attempts.at(-1)!.operatorCriticSkip).toBeUndefined();
  expect(isStoredPipeline(current)).toBe(true);
  Object.assign(current.runs[1]!.attempts.at(-1)!, { operatorCriticSkip: "unverified" });
  expect(isStoredPipeline(current)).toBe(false);
});

test.each(["agent", "operator"] as const)("a legacy pending skip labelled %s cannot cross the critic gate on a fresh executor", async kind => {
  const h = setup();
  await patchPipeline(h.lane.id, { action: "skip-stage" }, h.ports, { kind: "operator" });
  await withPipelineMutation(async (lanes, persist) => {
    lanes[0]!.remoteAction!.actor = kind === "operator" ? { kind } : { kind, role: "orchestrator", conversationId: null };
    delete lanes[0]!.remoteAction!.operatorCriticSkip;
    await persist();
  });
  const before = findPipelineRecord(h.lane.id)!;
  await settlePendingRemoteActions({ ...h.ports });
  const current = findPipelineRecord(h.lane.id)!;
  expect(current.remoteAction).toMatchObject({ state: "settled", error: expect.stringContaining("visual-critic gate critic") });
  expect(current.cursor).toEqual(before.cursor);
  expect(current.runs).toEqual(before.runs);
  expect(h.commands()).toBe(0);
});

test("a deferred agent skip rechecks a role change while Git is held", async () => {
  const h = setup();
  await withPipelineMutation(async (lanes, persist) => {
    lanes[0]!.stages[1]!.role = { roleId: "builder" };
    lanes[0]!.stages[1]!.effectiveRole.roleId = "builder";
    lanes[0]!.runs[1]!.attempts.at(-1)!.effectiveRole.roleId = "builder";
    await persist();
  });
  const agent = { kind: "agent" as const, role: "builder", conversationId: null };
  expect((await patchPipeline(h.lane.id, { action: "skip-stage" }, h.ports, agent)).error).toBeUndefined();
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = settlePendingRemoteActions({ ...h.ports, exec: async (command: string, args: string[]) => {
    entered(); await held; return h.ports.exec(command, args);
  } });
  try {
    await checking;
    await withPipelineMutation(async (lanes, persist) => {
      lanes[0]!.stages[1]!.role = { roleId: "visual-critic" };
      lanes[0]!.stages[1]!.effectiveRole.roleId = "visual-critic";
      await persist();
    });
    const before = findPipelineRecord(h.lane.id)!;
    release(); await work;
    const current = findPipelineRecord(h.lane.id)!;
    expect(current.remoteAction?.error).toContain("visual-critic gate critic");
    expect(current.cursor).toEqual(before.cursor);
    expect(current.runs).toEqual(before.runs);
  } finally { release(); await work; }
});
