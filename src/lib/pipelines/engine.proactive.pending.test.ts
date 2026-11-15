import { afterAll, afterEach, spyOn } from "bun:test";

import { expect, test, savePipelines } from "./engine.fixture";
import { decideProactiveTask, proactiveDecisionToken } from "@/lib/tasks/proactive";
import { NOW } from "@/lib/tasks/proactive.fixture";
import { readSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { agentRegistry } from "@/lib/agent/registry";

import { proactiveObservation } from "@/lib/accounts/proactiveReserve.fixture";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

import { fixture } from "./engine.proactive.fixture";

const clock = spyOn(Date, "now").mockImplementation(() => NOW);
afterEach(() => { clock.mockImplementation(() => NOW); });
afterAll(() => clock.mockRestore());
test.each(["parent", "child", "expiry", "reject", "continue", "adopt"])("native pending discretionary turns retain guarded custody: %s", async kind => {
  const f = await fixture(`native-pending-${kind}`);
  await f.tick(); await f.pass();
  const { migrationDeliveryFixture } = await import("@/test-helpers/migrationDelivery");
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const { kickStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliverySignal");
  const { NativeCodexQueue } = await import("@/lib/runtime/nativeCodexQueue");
  const delivery = migrationDeliveryFixture();
  const registry = delivery.registry;
  const lane = f.current();
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: delivery.root, transport: "structured", conversationId: delivery.conversation.id,
    origin: { kind: "container", container: "pipeline", containerId: f.id, creatorConversationId: null },
    clientAttemptId: `pending-${kind}`, taskIds: [f.task.id],
    memberships: [{ kind: "pipeline", containerId: f.id, role: "builder", slot: "build:1", stageId: "build", stageOrder: 1, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: delivery.root, model: "gpt-5.6-sol", title: "Continue the reviewed filter improvement" }) });
  if (begun.kind !== "created") throw new Error("fresh native receipt required");
  lane.runs[1]!.attempts.at(-1)!.conversationId = delivery.conversation.id;
  savePipelines([lane]);
  agentRegistry().recordQuotaObservation(proactiveObservation("account-a"));
  let active = true, adds = 0, starts = 0;
  const host = delivery.host;
  const health = host.health.bind(host);
  host.health = async () => ({ ...await health(), status: active ? "active" : "idle", activeTurnRef: active ? "current-turn" : null, activeFlags: ["native-queue"] });
  const input = [{ type: "text" as const, text: "Preserve this pending payload" }];
  const binding = { threadId: delivery.key.sessionId, accountId: "account-a" };
  Object.assign(host, { nativeQueue: {
    queue: new NativeCodexQueue({ rpc: async (method, params) => {
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (method === "thread/queue/add") { adds++; return { queuedSubmission: { id: "pending-native", clientUserMessageId: params.clientUserMessageId, input } }; }
      throw new Error(`unexpected native call ${method}`);
    } }, binding.threadId),
    prepare: async () => input, evidence: async () => null,
    sendWithdrawn: async () => { if (active) throw new Error("fixture turn still active"); starts++; return { turnId: "guarded-turn" }; },
  } });
  delivery.client.nativeQueueRead = async id => delivery.journal.nativeQueueRead(id);
  delivery.client.nativeQueueTransition = async (id, change) => delivery.journal.nativeQueueTransition(id, change);
  const bind = () => bindStructuredDeliveryQueue([{ key: delivery.key, host }], { registry, client: delivery.client,
    hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
  try {
    if (kind === "adopt") await decideProactiveTask(f.task.id, "adopt", "operator", proactiveDecisionToken(f.task));
    await bind();
    expect(delivery.journal.executeOperation({ kind: "native-queue", action: "add", binding, operationId: "pending-guarded", idempotencyKey: "pending-guarded",
      conversationId: delivery.conversation.id, text: input[0].text }).receipt.status).toBe("queued");
    await kickStructuredDeliveryQueue();
    expect(adds).toBe(kind === "adopt" ? 1 : 0);
    expect(starts).toBe(0);
    const settings = readSeatTickSettings(f.project);
    if (kind === "parent") settings.autonomy!.enabled = false;
    if (kind === "child") settings.autonomy!.proactive!.enabled = false;
    if (kind === "expiry") settings.autonomy!.until = new Date(NOW - 1).toISOString();
    writeSeatTickSettings(f.project, settings);
    if (kind === "reject") await decideProactiveTask(f.task.id, "reject", "operator", proactiveDecisionToken(f.task));
    // A replacement controller must recover the original durable operation.
    await bindStructuredDeliveryQueue([], { client: null }); active = false;
    await bind(); await kickStructuredDeliveryQueue();
    expect(adds).toBe(kind === "adopt" ? 1 : 0);
    expect(starts).toBe(kind === "continue" ? 1 : 0);
    const entry = delivery.journal.nativeQueueRead(delivery.conversation.id)[0]!;
    expect(entry.versions[0]!.text).toBe(input[0].text);
    expect(entry.state).toBe(kind === "continue" ? "dispatching" : kind === "adopt" ? "queued" : "refused");
  } finally { await delivery.cleanup(); }
});
