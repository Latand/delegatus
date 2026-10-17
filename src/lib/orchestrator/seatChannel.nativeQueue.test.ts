import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { startComposerPayloadRuntime } from "@/lib/runtime/fixtures/composerPayloadRuntime";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { parseRuntimeCommand } from "@/lib/runtime/commands";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorRevocations } from "./seats";
import { reconcileSeatChannel, type SeatChannelPorts } from "./seatChannel";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";

const environment = { ...process.env };
afterEach(() => {
  setSystemTime();
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});

test("an ordinary queue send already held by Codex is removed before its seat message is redirected", async () => {
  setSystemTime(new Date("2026-10-16T12:06:32.000Z"));
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "seat-native-queue-"));
  const runtime = await startComposerPayloadRuntime(root, { secondConversation: true });
  const journalClient = new UnixRuntimeHostClient(path.join(root, "rt.sock"));
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "rt.sock");
  const project = "seat-native-project";
  const seatKey = "native-first";
  beginOrchestratorSeatIntent({ project, mandate: "coordinate", mode: "existing", clientRequestId: seatKey, now: "2026-10-16T12:06:32.000Z" });
  completeOrchestratorSeatIntent({ project, clientRequestId: seatKey, conversationId: runtime.conversationId,
    path: runtime.artifactPath, now: "2026-10-16T12:06:32.000Z" });
  let nativeDeletionConfirmed = false;
  let nativeHeld = false;
  let redirected = 0;
  const client = new Proxy(journalClient, {
    get(target, key) {
      if (key === "operationStatus") return async (operationId: string) => {
        const original = await target.operationStatus(operationId);
        if (operationId === "ordinary_queue_seat_send" && !nativeHeld && original) {
          return { ...original, receipt: { ...original.receipt, status: "failed", reason: "delivery-discarded" } };
        }
        return original;
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ports: SeatChannelPorts = {
    registry: runtime.registry,
    client,
    now: () => Date.parse("2026-10-16T12:06:32.000Z"),
    ownsTraffic: () => true,
    enqueue: async request => {
      redirected++;
      return enqueueStructuredMessage({ operationId: "seat_native_redirect", ...request }, {
        enabled: () => true, registry: () => runtime.registry, client: () => client,
      });
    },
    withdrawNative: async (conversationId, operationId) => {
      const entry = (await client.nativeQueueRead!(conversationId)).find(row => row.entryId === operationId);
      if (!entry) return false;
      nativeHeld = false;
      nativeDeletionConfirmed = true;
      return true;
    },
  };

  try {
    await runtime.hostUp();
    const operationId = "ordinary_queue_seat_send";
    const conversationId = runtime.conversationId as `conversation_${string}`;
    const source = runtime.registry.conversation(conversationId)!;
    const generation = source.generations.at(-1)!;
    runtime.journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
      conversationId, sessionKey: { engine: "codex", sessionId: generation.id },
      hostKind: "codex-app-server", host: "hosted", turn: "running", activeTurnId: "held-turn", accountId: "fixture-account",
      capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
    } });
    runtime.registry.holdDelivery(conversationId, "Deliver this once to the current seat", "ordinary-queue-seat-send", "text", [], null,
      { operationId, kind: "send", policy: "queue" });
    const command = parseRuntimeCommand("send", { conversationId, operationId,
      idempotencyKey: "ordinary-queue-seat-send", text: "Deliver this once to the current seat", policy: "queue" });
    runtime.journal.executeOperation(command);
    expect(runtime.journal.effectBatch(100).some(row => row.kind === "runtime.native-queue")).toBe(true);
    const entry = (await client.nativeQueueRead!(conversationId)).find(row => row.entryId === operationId)!;
    const version = entry.versions.find(row => row.revision === entry.revision)!;
    await client.nativeQueueTransition!(operationId, { phase: "prepared", input: [{ type: "text", text: version.text }], binding: entry.binding });
    await client.nativeQueueTransition!(operationId, { phase: "acknowledged", nativeSubmissionId: "native-held-send" });
    nativeHeld = true;
    const owner = runtime.registry.readOnlySnapshot().deliveryOperationOwners[operationId]!;
    expect(owner).toMatchObject({ command: { kind: "send", policy: "queue" } });
    expect(owner.directAdmission).not.toBe("native-queue-add");

    const nextKey = "native-next";
    beginOrchestratorSeatIntent({ project, mandate: "coordinate", mode: "existing", clientRequestId: nextKey, now: "2026-10-16T12:06:33.000Z" });
    completeOrchestratorSeatIntent({ project, clientRequestId: nextKey, conversationId: runtime.successor!.conversationId,
      path: runtime.successor!.artifactPath, now: "2026-10-16T12:06:33.000Z" });
    const revocation = orchestratorRevocations().find(row => row.project === project)!;

    await reconcileSeatChannel(revocation, ports);

    expect(nativeDeletionConfirmed).toBe(true);
    expect(nativeHeld).toBe(false);
    expect(runtime.registry.readOnlySnapshot().heldDeliveries[owner.deliveryId]?.state).toBe("failed");
    expect(redirected).toBe(1);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
