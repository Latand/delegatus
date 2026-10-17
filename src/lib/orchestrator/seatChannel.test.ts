import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { startComposerPayloadRuntime, type ComposerPayloadRuntime } from "@/lib/runtime/fixtures/composerPayloadRuntime";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";
import { lookupOriginalSend, resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { deliverConversationMessage } from "@/lib/delivery";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorRevocations, readOrchestratorSeatFileOrNull } from "./seats";
import { currentSeat, reconcileSeatChannel, seatChannelRecord, seatDeliveryDisposition, seatRecipientVerdictAsync, withdrawRuntimeWake, SEND_SEAT_REVOKED_REASON, type SeatChannelPorts } from "./seatChannel";
import { boardReportMessageId } from "./boardReportRun";
import { deputyNoteKey } from "./deputySweep";
import { bridgeDirectiveId } from "@/lib/bridge/directive";
import { spawnNoticeMessageId } from "@/lib/spawnNotice/sweep";
import { onSeatChannelChange } from "./seatChannelSignal";

const environment = { ...process.env };
afterEach(() => {
  setSystemTime();
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});
const AT = "2026-10-16T12:06:32.000Z";
let fixtureSequence = 0;
function designate(runtime: ComposerPayloadRuntime, next = false, project = "channel-project", at = AT) {
  const target = next ? runtime.successor! : runtime;
  const key = next ? "channel-next" : "channel-first";
  beginOrchestratorSeatIntent({ project, mandate: "coordinate", mode: "existing", clientRequestId: key, now: at });
  completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId: target.conversationId, path: target.artifactPath, now: at });
}
async function fixture(run: (runtime: ComposerPayloadRuntime, ports: SeatChannelPorts) => Promise<void>, options: { sourceInitiallyUnavailable?: boolean; pauseDeliveryQueue?: boolean } = {}) {
  // These cases drive reconciliation explicitly. Keep any process-wide startup
  // listener from racing the fixture's controlled pass after designation.
  onSeatChannelChange(() => {});
  setSystemTime(new Date(AT));
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "seat-channel-fixture-"));
  const runtime = await startComposerPayloadRuntime(root, { secondConversation: true, holdFirstTurn: true });
  const client = new UnixRuntimeHostClient(path.join(root, "rt.sock"));
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "rt.sock");
  const fixtureId = ++fixtureSequence;
  let operation = 0;
  const ports: SeatChannelPorts = { registry: runtime.registry, client, now: () => Date.parse(AT), ownsTraffic: () => true,
    enqueue: request => enqueueStructuredMessage({ operationId: `seat_fixture_${fixtureId}_${++operation}`, ...request }, {
      enabled: () => true, registry: () => runtime.registry, client: () => client,
      ...(options.pauseDeliveryQueue ? { kick: async () => {} } : {}),
    }),
    withdrawNative: async (conversationId, operationId) => {
      const entry = (await client.nativeQueueRead?.(conversationId))?.find(item => item.entryId === operationId);
      if (!entry || entry.nativeSubmissionId || !client.nativeQueueTransition) return false;
      await client.nativeQueueTransition(operationId, { phase: "refused", reason: SEND_SEAT_REVOKED_REASON });
      return (await client.nativeQueueRead?.(conversationId))?.find(item => item.entryId === operationId)?.state === "refused";
    },
  };
  try { if (!options.sourceInitiallyUnavailable) await runtime.hostUp(); await run(runtime, ports); }
  finally { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
for (const [key, origin] of [
  ["composer-fixture", { kind: "operator" as const }],
  ["worker-fixture", { kind: "agent" as const, role: "worker", conversationId: "conversation_worker" }],
  [bridgeDirectiveId("turn_fixture", 0), { kind: "agent" as const, role: "gateway", conversationId: "conversation_gateway" }],
] as const) test(`queued ${key} redirects once and the original receipt follows it`, async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: key, text: "Check the saved instruction.", images: [], origin, policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const revoked = orchestratorRevocations().at(-1)!;
  const settled = await reconcileSeatChannel(revoked, ports);
  expect({ settled, outcome: seatChannelRecord(original.operationId)?.outcome,
    status: runtime.journal.operationResult(original.operationId)?.receipt.status }).toMatchObject({ settled: true });
  await runtime.holdTurn!(false);
  await runtime.waitForDelivery(runtime.successor!.conversationId, 1);
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered[0]!.text).toMatch(/^\[Delegatus\] Redirected to you, the current orchestrator:/);
  expect(runtime.successor!.delivered[0]!.text).toEndWith("\nCheck the saved instruction.");
  expect(runtime.journal.operationResult(original.operationId)?.receipt).toMatchObject({ status: "failed", reason: SEND_SEAT_REVOKED_REASON });
  const record = seatChannelRecord(original.operationId)!;
  expect(record).toMatchObject({ outcome: "redirected", toConversationId: runtime.successor!.conversationId });
  expect(runtime.registry.deliverySnapshotForOperation(record.toOperationId!).deliveryOperationOwners[record.toOperationId!].command.origin).toEqual(origin);
  await reconcileSeatChannel(revoked, ports);
  expect(runtime.successor!.delivered).toHaveLength(1);
  expect(await resolveSendReceipt(original.operationId, { registry: runtime.registry, client: ports.client })).toMatchObject({
    state: "delivered", redirectedTo: { conversationId: runtime.successor!.conversationId, operationId: record.toOperationId }, resend: "not-needed",
  });
  expect(lookupOriginalSend(runtime.registry.readOnlySnapshot(), { conversationId: runtime.conversationId, clientMessageId: key, text: "Check the saved instruction.", origin }))
    .toMatchObject({ kind: "found", receipt: { state: "delivered", redirectedTo: { operationId: record.toOperationId } } });
}, { sourceInitiallyUnavailable: true, pauseDeliveryQueue: true }));

test("epoch-bound board reports are failed with a record and never redirected", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: boardReportMessageId("channel-project", 1), text: "Previous epoch report", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const revoked = orchestratorRevocations().at(-1)!;
  expect(await reconcileSeatChannel(revoked, ports)).toBe(true);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("dropped");
  await runtime.holdTurn!(false);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("dropped");
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered).toHaveLength(0);
  expect(runtime.journal.operationResult(original.operationId)?.receipt.reason).toBe(SEND_SEAT_REVOKED_REASON);
}, { sourceInitiallyUnavailable: true, pauseDeliveryQueue: true }));

test("an older revocation leaves a re-designated seat's fresh mandate deliverable", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const secondAt = new Date(Date.parse(AT) + 1_000).toISOString();
  designate(runtime, true, "channel-project", secondAt);
  const firstRevocation = orchestratorRevocations().find(row => row.project === "channel-project" && row.conversationId === runtime.conversationId)!;
  const thirdAt = new Date(Date.parse(AT) + 2_000).toISOString();
  designate(runtime, false, "channel-project", thirdAt);
  setSystemTime(new Date(Date.parse(AT) + 3_000));

  const fresh = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "orchmandate_after_return", text: "Handle the current mandate", images: [], policy: "queue" });
  if (!fresh?.ok) throw new Error("fixture admission failed");

  expect(await reconcileSeatChannel(firstRevocation, ports)).toBe(true);
  expect(seatChannelRecord(fresh.operationId)).toBeNull();
  expect(runtime.journal.operationResult(fresh.operationId)?.receipt.status).toBe("queued");
  await runtime.holdTurn!(false);
  await runtime.waitForDelivery(runtime.conversationId, 1);
  expect(runtime.delivered[0]!.text).toBe("Handle the current mandate");
  expect(runtime.successor!.delivered).toHaveLength(0);
}));

test("legacy sends to a revoked id are refused while history and stop metadata remain intact", async () => fixture(async (runtime) => {
  designate(runtime); designate(runtime, true);
  let commands = 0;
  const result = await deliverConversationMessage({ pid: null, path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "legacy-revoked", text: "Old target", images: [] }, { registry: runtime.registry,
    enqueueStructuredMessage: async () => null, deliverToPid: async () => { commands++; throw new Error("revoked target actuated"); } } as never);
  expect(result).toMatchObject({ ok: false, status: 409, successorConversationId: runtime.successor!.conversationId });
  expect(commands).toBe(0);
  expect(runtime.registry.conversation(runtime.conversationId as `conversation_${string}`)?.supersededBy).toBeNull();
  expect(readOrchestratorSeatFileOrNull()?.revocations.at(-1)?.conversationId).toBe(runtime.conversationId);
  expect((await seatRecipientVerdictAsync([runtime.conversationId])).kind).toBe("revoked");
  expect(currentSeat("channel-project")?.conversationId).toBe(runtime.successor!.conversationId);
}));

test("legacy pane sends recheck seat authority after recovery waits", async () => fixture(async runtime => {
  designate(runtime);
  let actuations = 0;
  const outcome = await deliverConversationMessage({ pid: 1, path: "",
    clientMessageId: "legacy-rotated-during-recovery", text: "Do not reach the retired pane", images: [] }, {
    registry: runtime.registry,
    recover: async () => null,
    listFiles: async () => [{ pid: 1, proc: "running", engine: "codex", path: runtime.artifactPath } as never],
    targetForKnownPid: async () => { designate(runtime, true); return "%1"; },
    sendText: async () => { actuations++; },
  } as never);

  expect(actuations).toBe(0);
  expect(outcome).toMatchObject({ ok: false, status: 409, successorConversationId: runtime.successor!.conversationId });
}));

test("legacy pane transport checks seat authority after waiting for its final dispatch boundary", async () => fixture(async runtime => {
  designate(runtime);
  let actuations = 0;
  let enterPaneWait!: () => void;
  let releasePaneWait!: () => void;
  const paneWaitEntered = new Promise<void>(resolve => { enterPaneWait = resolve; });
  const paneWait = new Promise<void>(resolve => { releasePaneWait = resolve; });
  const pending = deliverConversationMessage({ pid: 1, path: "",
    clientMessageId: "legacy-rotated-at-pane-lock", text: "Do not reach the retired pane", images: [] }, {
    registry: runtime.registry,
    recover: async () => null,
    listFiles: async () => [{ pid: 1, proc: "running", engine: "codex", path: runtime.artifactPath } as never],
    targetForKnownPid: async () => "%1",
    sendText: (async (_target: string, _text: string, authorityGuard?: () => void) => {
      enterPaneWait();
      await paneWait;
      authorityGuard?.();
      actuations++;
    }) as never,
  } as never);
  await paneWaitEntered;
  designate(runtime, true);
  releasePaneWait();
  const outcome = await pending;

  expect(actuations).toBe(0);
  expect(outcome).toMatchObject({ ok: false, status: 409, successorConversationId: runtime.successor!.conversationId });
}));

test("legacy child relays refuse a root seat revoked while transcript lookup waits", async () => fixture(async runtime => {
  designate(runtime);
  designate(runtime, true);
  const childPath = path.join(path.dirname(runtime.artifactPath), "child-session.jsonl");
  const child = runtime.registry.ensureConversation("codex", childPath, "fixture-account");
  let hostDeliveries = 0;
  const outcome = await deliverConversationMessage({ pid: null, path: childPath, conversationId: child.id,
    clientMessageId: "legacy-relay-to-revoked-root", text: "Do not relay to the retired root", images: [] }, {
    registry: runtime.registry,
    recover: async () => null,
    pathAllowed: () => true,
    listFiles: async () => [
      { path: childPath, parent: runtime.artifactPath, engine: "codex", root: path.dirname(childPath), title: "child" } as never,
      { path: runtime.artifactPath, parent: null, engine: "codex", root: path.dirname(runtime.artifactPath), title: "root" } as never,
    ],
    resumeSpecFor: (_root: string, pathname: string) => pathname === childPath ? null : ({ command: "resume", args: [], cwd: path.dirname(runtime.artifactPath), env: {} }) as never,
    deliver: async () => { hostDeliveries++; return { ok: true as const, outcome: "resumed" as const, target: "%root" }; },
  } as never);

  expect(hostDeliveries).toBe(0);
  expect(outcome).toMatchObject({ ok: false, status: 409, successorConversationId: runtime.successor!.conversationId });
}));

test("a project temporarily without a seat keeps its withdrawn words until activation", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "await-seat", text: "Keep these words", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const revocation = orchestratorRevocations().at(-1)!;
  const filename = path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json");
  const file = JSON.parse(fs.readFileSync(filename, "utf8"));
  delete file.seats["channel-project"];
  fs.writeFileSync(filename, JSON.stringify(file));
  expect(await reconcileSeatChannel(revocation, ports)).toBe(false);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("awaiting-seat");
  expect(await resolveSendReceipt(original.operationId, { registry: runtime.registry, client: ports.client })).toMatchObject({ state: "in-flight", resend: "verify-first" });
  beginOrchestratorSeatIntent({ project: "channel-project", mandate: "restored", mode: "existing", clientRequestId: "restore-seat", now: AT });
  completeOrchestratorSeatIntent({ project: "channel-project", clientRequestId: "restore-seat", conversationId: runtime.conversationId, path: runtime.artifactPath, now: AT });
  expect(await reconcileSeatChannel(revocation, ports)).toBe(true);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("redirected");
  await runtime.hostUp();
  await runtime.holdTurn!(false);
  await runtime.waitForDelivery(runtime.conversationId, 1);
  expect(runtime.successor!.delivered).toHaveLength(0);
  expect(runtime.delivered[0]!.text).toEndWith("\nKeep these words");
}, { sourceInitiallyUnavailable: true, pauseDeliveryQueue: true }));

test("withdrawn owner messages stay with their retry owner", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "prototype-decision:fixture", text: "Saved answer", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const revoked = orchestratorRevocations().at(-1)!;
  expect(await reconcileSeatChannel(revoked, ports)).toBe(true);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("owner");
  expect(runtime.successor!.delivered).toHaveLength(0);
}));

test("the disposition table includes every producer namespace and preserves unknown keys", () => {
  for (const key of ["prototype-decision:round", bridgeDirectiveId("telegram_reply", 0), "voice-fixture", spawnNoticeMessageId("child", "turn")])
    expect(seatDeliveryDisposition({ clientMessageId: key })).toBe("owner");
  for (const key of ["seat-tick:project:1", boardReportMessageId("project", 1), "seat-autorotate-nudge-fixture", deputyNoteKey("ask"), "orchmandate_fixture"])
    expect(seatDeliveryDisposition({ clientMessageId: key })).toBe("epoch");
  for (const key of ["composer", "mcp_orchestrator_fixture", bridgeDirectiveId("turn_fixture", 1), null])
    expect(seatDeliveryDisposition({ clientMessageId: key })).toBe("channel");
});

test("a redirect whose admission acknowledgement is lost keeps its bound successor across another rotation", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "redirect-ack-lost", text: "Review this work once", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const revoked = orchestratorRevocations().at(-1)!;
  const lostAck = { ...ports, enqueue: async (request: Parameters<SeatChannelPorts["enqueue"]>[0]) => {
    await ports.enqueue(request); throw new Error("admission acknowledgement lost");
  } };
  await expect(reconcileSeatChannel(revoked, lostAck)).rejects.toThrow("admission acknowledgement lost");
  await runtime.holdTurn!(false);
  await runtime.waitForDelivery(runtime.successor!.conversationId, 1);
  beginOrchestratorSeatIntent({ project: "channel-project", mandate: "return", mode: "existing", clientRequestId: "seat-return", now: AT });
  completeOrchestratorSeatIntent({ project: "channel-project", clientRequestId: "seat-return", conversationId: runtime.conversationId, path: runtime.artifactPath, now: AT });
  expect(await reconcileSeatChannel(revoked, ports)).toBe(true);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("redirected");
  await runtime.holdTurn!(false);
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered).toHaveLength(1);
  expect(await resolveSendReceipt(original.operationId, { registry: runtime.registry, client: ports.client })).toMatchObject({ state: "delivered" });
}, { sourceInitiallyUnavailable: true, pauseDeliveryQueue: true }));

test("a deferred first reconciliation pass retries before one successor admission", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "deferred-reconcile-first-pass", text: "Deliver only to the successor", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const revoked = orchestratorRevocations().at(-1)!;
  let statusReads = 0;
  const delayedClient = { ...ports.client, operationStatus: async (id: string) => {
    const current = await ports.client.operationStatus(id);
    statusReads++;
    if (id === original.operationId && statusReads === 2 && current) {
      return { ...current, receipt: { ...current.receipt, status: "delivering" as const } };
    }
    return current;
  } } as typeof ports.client;
  const delayedPorts = { ...ports, client: delayedClient };

  expect(await reconcileSeatChannel(revoked, delayedPorts)).toBe(false);
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered).toHaveLength(0);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("too-late");

  expect(await reconcileSeatChannel(revoked, ports)).toBe(true);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("redirected");
  expect(runtime.delivered).toHaveLength(0);
  await runtime.holdTurn!(false);
  await runtime.waitForDelivery(runtime.successor!.conversationId, 1);
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered[0]!.text).toEndWith("\nDeliver only to the successor");
}, { sourceInitiallyUnavailable: true, pauseDeliveryQueue: true }));

test("withdrawal treats a lost acknowledgement after the same terminal transition as withdrawn", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "withdrawal-lost-ack", text: "Withdraw exactly once", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const revoked = orchestratorRevocations().at(-1)!;
  let transitions = 0;
  const client = new Proxy(ports.client, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === "transitionOperation") return async (...args: Parameters<NonNullable<typeof target.transitionOperation>>) => {
      transitions++;
      await value.apply(target, args);
      throw new Error("withdrawal acknowledgement lost after commit");
    };
    return typeof value === "function" ? value.bind(target) : value;
  } }) as typeof ports.client;
  const result = await reconcileSeatChannel(revoked, { ...ports, client });
  expect(result).toBe(true);
  expect(transitions).toBe(1);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("redirected");
  await runtime.holdTurn!(false);
  await runtime.waitForDelivery(runtime.successor!.conversationId, 1);
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered).toHaveLength(1);
}, { sourceInitiallyUnavailable: true, pauseDeliveryQueue: true }));

test("withdrawal cannot end a message that entered dispatch during its journal wait", async () => fixture(async (runtime, ports) => {
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "withdrawal-race", text: "Race the journal claim", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  const client = { ...ports.client, operationStatus: ports.client.operationStatus.bind(ports.client),
    transitionOperation: async (...args: Parameters<typeof ports.client.transitionOperation>) => {
      await ports.client.transitionOperation(original.operationId, "delivering");
      return ports.client.transitionOperation(...args);
    } } as typeof ports.client;
  expect(await withdrawRuntimeWake(original.operationId, SEND_SEAT_REVOKED_REASON, client)).toBe("too-late");
  expect(runtime.journal.operationResult(original.operationId)?.receipt.status).toBe("delivering");
}));

test("a held withdrawal that loses its registry race is never redirected", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "held-withdrawal-race", text: "This may already have arrived", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const snapshot = runtime.registry.deliverySnapshotForOperation(original.operationId);
  const owner = snapshot.deliveryOperationOwners[original.operationId]!;
  const delivery = snapshot.heldDeliveries[owner.deliveryId]!;
  const racingRegistry = new Proxy(runtime.registry, {
    get(target, key) {
      if (key === "readOnlySnapshot") return () => {
        const current = target.readOnlySnapshot();
        return { ...current, heldDeliveries: { ...current.heldDeliveries, [delivery.id]: { ...delivery, state: "held" } } };
      };
      if (key === "deliveryWrite") return async (metadata: Parameters<typeof target.deliveryWrite>[0], write: () => unknown) => {
        if (metadata.label === "delivery.seat-channel") return { acquired: true, value: "too-late" as const };
        return target.deliveryWrite(metadata, write as never);
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const client = { ...ports.client, operationStatus: async () => null } as typeof ports.client;
  let successorAdmissions = 0;
  const lostRace = { ...ports, registry: racingRegistry, client,
    enqueue: async (request: Parameters<SeatChannelPorts["enqueue"]>[0]) => { successorAdmissions++; return ports.enqueue(request); } };

  await reconcileSeatChannel(orchestratorRevocations().at(-1)!, lostRace);
  expect(successorAdmissions).toBe(0);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("too-late");
}));

test("channel state writes wait off the event loop while a peer owns the SQLite writer", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  await reconcileSeatChannel({ project: "channel-project", conversationId: runtime.successor!.conversationId, seatEpoch: 0, revokedAt: AT }, ports);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "contention-message", text: "Retain the message while storage is busy", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  // The authority file is independent of the state database and can rotate while its writer is held.
  designate(runtime, true);
  const child = Bun.spawn([process.execPath, "-e", 'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n"); await Bun.stdin.stream().getReader().read(); db.exec("ROLLBACK"); db.close();', path.join(process.env.LLV_STATE_DIR!, "state.sqlite")],
    { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const held = await reader.read(); expect(new TextDecoder().decode(held.value)).toContain("held");
    let completed = false;
    const pending = reconcileSeatChannel(orchestratorRevocations().at(-1)!, ports).finally(() => { completed = true; });
    await new Promise<void>(resolve => { timer = setTimeout(resolve, 40); });
    expect(completed).toBe(false);
    child.stdin.write("release\n"); child.stdin.end();
    await child.exited;
    await pending;
  } finally {
    if (timer) clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}));

test("a revoked seat's messages remain readable through the MCP reader", async () => fixture(async runtime => {
  designate(runtime); designate(runtime, true);
  fs.mkdirSync(path.dirname(runtime.artifactPath), { recursive: true });
  fs.writeFileSync(runtime.artifactPath, JSON.stringify({ type: "event_msg", timestamp: AT,
    payload: { type: "agent_message", message: "Historical handoff remains readable." } }) + "\n");
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const bindings = viewerMcpBindings(undefined, undefined, {
    registrySnapshot: () => runtime.registry.readOnlySnapshot(),
    selectedContext: { selectedConversation: () => ({ resolve: (id: string) => id === runtime.conversationId
      ? { conversationId: id, engine: "codex", path: runtime.artifactPath, project: "channel-project" } : null }),
      pathAllowed: (candidate: string) => candidate === runtime.artifactPath },
    pinnedTranscript: (candidate: string) => {
      if (candidate !== runtime.artifactPath) return undefined;
      const descriptor = fs.openSync(candidate, "r");
      return { descriptor, stat: fs.fstatSync(descriptor), rootName: "codex-sessions", root: path.dirname(candidate), sameIdentity: () => true };
    },
  } as never);
  expect(await bindings.conversation_messages({ conversationId: runtime.conversationId, roles: ["assistant"] }))
    .toMatchObject({ records: [{ role: "assistant", text: "Historical handoff remains readable." }] });
  expect(await bindings.conversation_deliverability({ conversationId: runtime.conversationId })).toMatchObject({ condition: "superseded" });
}));

test("a fresh process resumes open records outside the recent-rotation window", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "restart-seat-channel", text: "Keep the pending instruction", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  const revoked = { ...orchestratorRevocations().at(-1)!, revokedAt: "2020-01-01T00:00:00.000Z" };
  const filename = path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json");
  const file = JSON.parse(fs.readFileSync(filename, "utf8"));
  file.seats = {}; file.revocations = [];
  fs.writeFileSync(filename, JSON.stringify(file));
  expect(await reconcileSeatChannel(revoked, { ...ports, now: () => Date.parse(revoked.revokedAt) })).toBe(false);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("awaiting-seat");
  const child = Bun.spawn([process.execPath, "-e", `
    import { startSeatChannel, seatChannelRecord } from "./src/lib/orchestrator/seatChannel";
    await startSeatChannel();
    for (let i = 0; i < 150; i++) {
      if (seatChannelRecord(process.argv[1])?.outcome === "dropped") process.exit(0);
      await Bun.sleep(20);
    }
    process.stderr.write("persisted channel record was not resumed\\n"); process.exit(1);
  `, original.operationId], { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const errors = new Response(child.stderr).text();
    expect({ exit: await child.exited, errors: await errors }).toEqual({ exit: 0, errors: "" });
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}));


test("seat inbox revocation composes with channel, owner and epoch reconciliation", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  // This test owns a second executor. Retire the fixture's idle controller
  // before admission so only this executor can claim its three operations.
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  await bindStructuredDeliveryQueue([], { registry: runtime.registry, client: null });
  const { StructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryQueue");
  const { seatRecipientVerdict } = await import("./seatChannel");
  const { isCurrentOrchestratorSeat } = await import("./seats");
  const keys = ["prototype-decision:inbox-fixture", "composer-inbox-fixture", "seat-tick:inbox-fixture"];
  const admitted: string[] = [];
  for (const [i, key] of keys.entries()) {
    const result = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
      operationId: `inbox-rotation-${i}`, clientMessageId: key, text: `inbox instruction ${i}`, images: [],
      origin: i === 1 ? { kind: "operator" } : { kind: "agent", role: "reviewer" }, policy: i === 1 ? "interrupt-active" : "queue" });
    if (!result?.ok) throw new Error("fixture admission failed");
    admitted.push(result.operationId);
  }
  await seatRecipientVerdictAsync([runtime.conversationId]);
  expect(isCurrentOrchestratorSeat).toBeFunction();
  expect(isCurrentOrchestratorSeat([runtime.conversationId])).toBe(true);
  let writes = 0;
  const engine: import("@/lib/runtime/engineHost").EngineHost = { coalescesQueuedInput: true, supportsSteer: false, supportsQueuedSend: false, sendWaitsForRunningTurn: true,
    attach: () => ({ async *[Symbol.asyncIterator]() {} }),
    health: async () => ({ status: "idle", sessionKey: "fixture-batch-generation", endpoint: "fixture:host", pid: null,
      processStartIdentity: null, eventCursor: 0, protocolVersion: null, activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null }),
    send: async (_entry, _proof, authorize) => { authorize?.(); writes++; throw new Error("revoked batch wrote to engine"); },
    interrupt: async () => { throw new Error("batch interrupted"); }, answer: async () => {}, release: async () => {},
  };
  const queue = new StructuredDeliveryQueue({
    effects: async () => runtime.journal.effectBatch(100), status: async id => runtime.journal.operationResult(id)?.receipt ?? null,
    hostClaim: () => "fixture-owner", coalescesConversation: () => true,
    seatRecipient: id => seatRecipientVerdict([id]),
    transition: async (...args) => { runtime.journal.transitionOperation(...args); },
    bindDeliveryBatch: async () => {
      designate(runtime, true);
      const revocation = orchestratorRevocations().at(-1)!;
      await reconcileSeatChannel(revocation, ports);
      expect(admitted.map(id => seatChannelRecord(id)?.outcome)).toEqual(Array(3).fill("too-late"));
      return true;
    },
  }, () => engine);
  await queue.drain();
  expect(writes).toBe(0);
  expect(admitted.map(id => runtime.journal.operationResult(id)?.receipt)).toEqual(Array(3).fill(expect.objectContaining({ status: "failed", reason: SEND_SEAT_REVOKED_REASON })));
  expect(isCurrentOrchestratorSeat([runtime.conversationId])).toBe(false);
  const revocation = orchestratorRevocations().at(-1)!;
  await reconcileSeatChannel(revocation, ports); await reconcileSeatChannel(revocation, ports);
  expect(admitted.map(id => seatChannelRecord(id)?.outcome)).toEqual(["owner", "redirected", "dropped"]);
  const owner = await ports.enqueue({ path: runtime.successor!.artifactPath, conversationId: runtime.successor!.conversationId,
    operationId: "inbox-owner-retry", clientMessageId: keys[0]!, text: "inbox instruction 0", images: [], policy: "queue" });
  expect(owner?.ok).toBe(true);
  await runtime.holdTurn!(false);
  await runtime.waitForDelivery(runtime.successor!.conversationId, 2);
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered).toHaveLength(2);
}, { pauseDeliveryQueue: true }));
