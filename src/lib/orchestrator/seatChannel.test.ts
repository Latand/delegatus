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

const environment = { ...process.env };
afterEach(() => {
  setSystemTime();
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
});
const AT = "2026-10-16T12:06:32.000Z";
function designate(runtime: ComposerPayloadRuntime, next = false, project = "channel-project") {
  const target = next ? runtime.successor! : runtime;
  const key = next ? "channel-next" : "channel-first";
  beginOrchestratorSeatIntent({ project, mandate: "coordinate", mode: "existing", clientRequestId: key, now: AT });
  completeOrchestratorSeatIntent({ project, clientRequestId: key, conversationId: target.conversationId, path: target.artifactPath, now: AT });
}
async function fixture(run: (runtime: ComposerPayloadRuntime, ports: SeatChannelPorts) => Promise<void>) {
  setSystemTime(new Date(AT));
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "seat-channel-fixture-"));
  const runtime = await startComposerPayloadRuntime(root, { secondConversation: true, holdFirstTurn: true });
  const client = new UnixRuntimeHostClient(path.join(root, "rt.sock"));
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(root, "rt.sock");
  let operation = 0;
  const ports: SeatChannelPorts = { registry: runtime.registry, client, now: () => Date.parse(AT), ownsTraffic: () => true,
    enqueue: request => enqueueStructuredMessage({ operationId: `seat_fixture_${++operation}`, ...request }, { enabled: () => true, registry: () => runtime.registry, client: () => client }) };
  try { await runtime.hostUp(); await run(runtime, ports); }
  finally { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
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
  let settled = await reconcileSeatChannel(revoked, ports);
  for (let tick = 0; !settled && tick < 100; tick++) {
    expect(runtime.delivered).toHaveLength(0);
    await Bun.sleep(10);
    settled = await reconcileSeatChannel(revoked, ports);
  }
  expect({ settled, outcome: seatChannelRecord(original.operationId)?.outcome,
    status: runtime.journal.operationResult(original.operationId)?.receipt.status }).toMatchObject({ settled: true });
  await runtime.holdTurn!(false);
  await waitFor(() => runtime.successor!.delivered.length === 1);
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
}));

test("epoch-bound board reports are failed with a record and never redirected", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: boardReportMessageId("channel-project", 1), text: "Previous epoch report", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  await reconcileSeatChannel(orchestratorRevocations().at(-1)!, ports);
  await runtime.holdTurn!(false);
  expect(seatChannelRecord(original.operationId)?.outcome).toBe("dropped");
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered).toHaveLength(0);
  expect(runtime.journal.operationResult(original.operationId)?.receipt.reason).toBe(SEND_SEAT_REVOKED_REASON);
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
  await reconcileSeatChannel(revocation, ports);
  await runtime.holdTurn!(false);
  await waitFor(() => runtime.delivered.length === 1);
  expect(runtime.successor!.delivered).toHaveLength(0);
  expect(runtime.delivered[0]!.text).toEndWith("\nKeep these words");
}));

test("withdrawn owner messages stay with their retry owner", async () => fixture(async (runtime, ports) => {
  designate(runtime);
  const original = await ports.enqueue({ path: runtime.artifactPath, conversationId: runtime.conversationId,
    clientMessageId: "prototype-decision:fixture", text: "Saved answer", images: [], policy: "queue" });
  if (!original?.ok) throw new Error("fixture admission failed");
  designate(runtime, true);
  await reconcileSeatChannel(orchestratorRevocations().at(-1)!, ports);
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
  await expect(reconcileSeatChannel(revoked, lostAck)).rejects.toThrow("acknowledgement lost");
  await waitFor(() => runtime.successor!.delivered.length === 1);
  beginOrchestratorSeatIntent({ project: "channel-project", mandate: "return", mode: "existing", clientRequestId: "seat-return", now: AT });
  completeOrchestratorSeatIntent({ project: "channel-project", clientRequestId: "seat-return", conversationId: runtime.conversationId, path: runtime.artifactPath, now: AT });
  await reconcileSeatChannel(revoked, ports);
  await runtime.holdTurn!(false);
  expect(runtime.delivered).toHaveLength(0);
  expect(runtime.successor!.delivered).toHaveLength(1);
  expect(await resolveSendReceipt(original.operationId, { registry: runtime.registry, client: ports.client })).toMatchObject({ state: "delivered" });
}));

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
