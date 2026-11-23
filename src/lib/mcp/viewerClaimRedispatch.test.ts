import { expect, test } from "bun:test";

import { viewerMcpBindings, viewerMcpToolPolicy } from "./bindings";
import {
  McpDispatchUncertainError,
  McpToolRefusal,
  MemoryMcpReceiptStore,
  createMcpToolService,
  type McpToolBindings,
  type McpToolName,
  type McpToolResult,
} from "./server";

type Answer = McpToolResult & Record<string, unknown>;

function serviceFor(tool: McpToolName, steps: Array<() => Record<string, unknown>>) {
  let calls = 0;
  const bindings = { [tool]: async () => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    return step();
  } } as unknown as McpToolBindings;
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  return { call: (args: Record<string, unknown>) => service.callTool(tool, args) as Promise<Answer>, calls: () => calls };
}

const lostReply = () => { throw new McpDispatchUncertainError("Viewer control dispatch timed out"); };

test.each([
  ["telegram_bot_send", { chat: "team", text: "status" }, { messageIds: [41] }],
  ["telegram_bot_send_document", { chat: "team", path: "/tmp/report.pdf" }, { messageIds: [42] }],
] as const)("%s: a repeat after an unknown outcome asks the Viewer again and keeps its answer (#3786)", async (tool, fields, done) => {
  const harness = serviceFor(tool, [lostReply, () => ({ ...done })]);
  const args = { clientRequestId: `claim-${tool}`, ...fields };
  expect(await harness.call(args)).toMatchObject({ ok: false, code: "outcome_unknown" });
  expect(await harness.call(args)).toMatchObject({ ok: true, ...done });
  expect(harness.calls()).toBe(2);
  // The answer the Viewer gave is now the receipt; nothing is dispatched again.
  expect(await harness.call(args)).toMatchObject({ ok: true, replayed: true, ...done });
  expect(harness.calls()).toBe(2);
});

test("telegram_bot_send: the bot's own uncertainty is asked again, a finished send is not (#3786)", async () => {
  const uncertain = () => { throw new McpToolRefusal("an earlier send never finished", { code: "send_uncertain", retryable: false }); };
  const harness = serviceFor("telegram_bot_send", [lostReply, uncertain, () => ({ messageIds: [7], alreadySent: true })]);
  const args = { clientRequestId: "claim-in-flight", chat: "team", text: "status" };
  expect(await harness.call(args)).toMatchObject({ ok: false, code: "outcome_unknown" });
  expect(await harness.call(args)).toMatchObject({ ok: false, code: "send_uncertain" });
  expect(await harness.call(args)).toMatchObject({ ok: true, messageIds: [7] });
  expect(await harness.call(args)).toMatchObject({ ok: true, replayed: true });
  expect(harness.calls()).toBe(3);
});

test("a tool with no Viewer-side claim still replays its unknown outcome without a second dispatch", async () => {
  const harness = serviceFor("bridge_directive", [lostReply, () => ({ sent: true })]);
  const args = { clientRequestId: "no-claim", project: "demo", text: "do the thing" };
  const first = await harness.call(args);
  expect(first).toMatchObject({ ok: false, code: "outcome_unknown" });
  expect(await harness.call(args)).toMatchObject({ ok: false, code: "outcome_unknown", replayed: true });
  expect(harness.calls()).toBe(1);
});

test("pipeline_action: a guard field on an action it does not guard leaves the clientRequestId usable (#3741)", async () => {
  const patched: unknown[] = [];
  const seat = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };
  const domain = {
    attentionAuthority: () => ({ kind: "worker", conversationId: seat.conversationId, role: seat.role }),
    callerAttribution: () => seat,
    authorizedSeats: () => [],
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {}, memberships: {}, lineageEdges: {}, receipts: {}, entries: {} }),
    patchPipeline: async (id: string, body: unknown) => { patched.push(body); return { pipeline: { id, stages: [], state: "running" } }; },
    getPipelines: () => ({ pipelines: [] }),
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
  const skip = { clientRequestId: "skip-with-stray-guard", pipelineId: "pipeline-1", action: "skip-stage", stageId: "visual", reason: "not needed" };
  const refused = await service.callTool("pipeline_action", { ...skip, expectedRevision: "abcdef1" }) as Answer;
  expect(refused).toMatchObject({ ok: false, retryable: true });
  expect(patched).toHaveLength(0);
  const corrected = await service.callTool("pipeline_action", skip) as Answer;
  expect(corrected).toMatchObject({ ok: true, replayed: false });
  expect(patched).toHaveLength(1);
});
