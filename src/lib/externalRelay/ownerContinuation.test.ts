import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { SEND_LOST_REASON, resolveSendReceipt, sendReceiptFor } from "@/lib/runtime/sendSettlement";
import { observeOwnerContinuation, ownerFailureAnswer, runOwnerAgent, confirmOwnerStop, type OwnerRunPorts } from "./ownerRun";
import { contextRequest } from "./request.fixture";
import { requestSchema } from "./protocol";
import { dropRun, reserveRun, readRunLedger, changeRun, newTargetSettings, updateRelayStore, type RunRecord } from "./store";

const epoch = Date.parse("2026-11-16T12:00:00Z");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function hasNoExecution(run: RunRecord, registry: AgentRegistry): boolean {
  const id = run.ownerTurn?.continuation?.operationId;
  if (!id || !run.ownerTurn?.admissionComplete) return false;
  const receipt = sendReceiptFor(registry.deliverySnapshotForOperation(id), id);
  return !!receipt && receipt.conversationId === run.conversationId && receipt.state === "failed" && receipt.resend === "safe" && !receipt.duplicateRisk;
}

function fixture(mode: "recovered" | "lost" | "unverified" | "expired" | "revoked" | "refused" | "restart" | "replaced" | "conversation-replaced" | "cursor-expired" | "reply-lost" | "reply-unverified" = "recovered", primaryReason = "idle-continuation-refused: fixture admission fence") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-continuation-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const request = requestSchema.parse({ ...contextRequest, request_id: "continuation-fixture" });
  const owner = { messageId: request.input.respond_to!, text: "Inspect fixture", requestText: null };
  const target = newTargetSettings({ target_id: "target_1", name: "Fixture", answered_by: "install", fallback: "none" });
  const operationId = `relay-owner-${request.request_id}`;
  const conversationId = "conversation_continuation-fixture" as const;
  const record: RunRecord = { requestId: request.request_id, relayId: "relay_fixture", targetId: target.id, leaseId: request.lease_id,
    conversationId, ownerTurn: { clientAttemptId: operationId, continuation: { operationId } }, ownerPid: process.pid,
    ownerIdentity: null, childPid: null, childIdentity: null, runDir: root, startedAt: new Date(epoch).toISOString() };
  reserveRun(record, 1);
  let now = epoch, authorized = true, launches = 0, stops = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sends: string[] = [];
  const primary = primaryReason;
  const lostReason = `${SEND_LOST_REASON}; primary rejected: ${primary}`;
  const settle = (id: string, state: "lost" | "unverified" | "delivered", failure = primary) => {
    const held = registry.holdDelivery(conversationId, "Fixture instruction", id, "text", [], null, { operationId: id });
    registry.recordDeliveryOutcome(held.id, state === "delivered" ? "delivered" : "failed", state === "lost" ? SEND_LOST_REASON : "fixture uncertain", state, null,
      state === "lost" ? { status: "rejected", reason: failure } : undefined);
  };
  const ports: OwnerRunPorts = {
    launch: async () => { launches++; throw Error("unexpected second agent"); },
    continue: async (turn, _prompt, _target, authorize) => {
      authorize();
      const id = turn.continuation!.operationId;
      sends.push(id);
      if (mode === "refused" && sends.length === 2) return { ok: false, structured: true, admission: "refused", status: 409, outcome: "failed", error: "fixture retry refused" };
      settle(id, mode === "unverified" || mode === "reply-unverified" && sends.length === 2 ? "unverified" : mode === "recovered" && sends.length === 2 ? "delivered" : "lost");
      if ((mode === "reply-lost" || mode === "reply-unverified") && sends.length === 2) throw Error("fixture reply lost after admission");
      return { ok: true, structured: true, operationId: id, outcome: "held", target: conversationId };
    },
    noExecution: async run => {
      const proof = hasNoExecution(run, registry);
      if (mode === "expired") now = epoch + 60_001;
      if (mode === "revoked") authorized = false;
      if (mode === "replaced") changeRun(record.requestId, row => ({ ...row, leaseId: "replacement-lease" }));
      if (mode === "conversation-replaced") changeRun(record.requestId, row => ({ ...row, conversationId: "conversation_replacement" }));
      return proof;
    },
    observe: async turn => {
      const receipt = await resolveSendReceipt(turn.continuation!.operationId, { registry, client: null, progress: null });
      if (receipt?.state === "delivered") return { state: "ended", conversationId, firstMessagePending: false, finalText: "Recovered" };
      return observeOwnerContinuation(turn, { registry: () => registry, now: () => now, liveness: async () => [] }, async () => receipt);
    },
    stop: async () => { stops++; if (mode === "lost") await new Promise<void>(() => {}); }, pollMs: 1, stopRetryMs: 1,
  };
  cleanups.push(() => { clock.mockRestore(); dropRun(request.request_id); registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const start = (engine: "codex" | "claude" = "codex") => runOwnerAgent({ request, owner, accountId: null, target: { ...target, engine }, hardCapMs: 5000, ports,
    deadline: { at: epoch + 60_000, declineAt: epoch + 50_000, receivedAt: epoch, source: "deadline_at", fallback: null },
    continuation: { conversationId, prompt: "Inspect fixture" }, preparedPrompt: { prompt: "Inspect fixture", seen: [], digest: "fixture" },
    authorize: () => { if (!authorized) throw Error("fixture authority revoked"); }, onConversation: (_id, prompt) => {
      if (mode === "cursor-expired" && prompt) now = epoch + 60_001;
    } });
  return { root, registry, record, request, ports, start, settle, primary, lostReason, operationId, conversationId,
    advance: (time: number) => { now = time; },
    counts: () => ({ launches, stops, sends }), saved: () => readRunLedger().runs.find(row => row.requestId === request.request_id)! };
}

for (const mode of ["recovered", "lost", "unverified", "expired", "revoked", "refused", "replaced", "conversation-replaced", "cursor-expired", "reply-lost", "reply-unverified"] as const)
test(`continuation ${mode} settles under its original deadline without another agent`, async () => {
  const f = fixture(mode);
  const result = await f.start().done;
  expect(result.status).toBe(mode === "recovered" ? "done" : "failed");
  expect(f.counts().launches).toBe(0);
  expect(f.counts().sends).toEqual([f.operationId, ...(["recovered", "lost", "refused", "reply-lost", "reply-unverified"].includes(mode) ? [`${f.operationId}-retry`] : [])]);
  if (mode === "recovered") expect(result.answer).toMatchObject({ text: "Recovered" });
  else {
    expect(result.diagnostic?.message).toContain(mode === "unverified" ? "fixture uncertain" : f.primary);
    if (mode === "replaced" || mode === "conversation-replaced") {
      if (mode === "replaced") expect(f.saved().leaseId).toBe("replacement-lease");
      else expect(f.saved().conversationId).toBe("conversation_replacement");
      expect(f.saved().ownerTurn?.cancel).toBeUndefined();
    } else expect(f.saved().ownerTurn).toMatchObject({ confirmed: true });
    expect(result.diagnostic?.deliveryFailure).toBe(true);
  }
  expect(f.counts().stops).toBe(mode === "unverified" || mode === "reply-unverified" ? 1 : 0);
  if (["recovered", "lost"].includes(mode)) expect(f.saved().ownerTurn?.continuation).toMatchObject({ operationId: `${f.operationId}-retry`, retryOfOperationId: f.operationId, deadlineAt: new Date(epoch + 50_000).toISOString(), failureReason: expect.stringContaining(f.primary) });
  expect(Object.values(f.registry.readOnlySnapshot().receipts)).toHaveLength(0);
}, 10_000);

for (const proof of ["lost", "unverified", "missing", "foreign", "unproven-cutoff"] as const)
test(`production stop uses only the exact durable ${proof} continuation proof`, async () => {
  const f = fixture();
  if (proof !== "missing" && proof !== "unproven-cutoff") f.settle(f.operationId, proof === "unverified" ? "unverified" : "lost");
  if (proof === "unproven-cutoff") f.registry.holdDelivery(f.conversationId, "Fixture instruction", f.operationId, "text", [], null, { operationId: f.operationId });
  if (proof === "unverified" || proof === "unproven-cutoff") {
    const snapshot = f.registry.deliverySnapshotForOperation(f.operationId);
    f.registry.terminalizeHeldDelivery(snapshot.deliveryOperationOwners[f.operationId]!.deliveryId, "fixture cleanup cutoff");
  }
  f.record.ownerTurn = { ...f.record.ownerTurn!, cancel: "interrupt", admissionComplete: true, cancelledAt: new Date(epoch).toISOString() };
  if (proof === "foreign") f.record.conversationId = "conversation_foreign";
  changeRun(f.record.requestId, () => f.record);
  const registryModule = await import("@/lib/agent/registry");
  const actions = await import("@/lib/conversation/actions");
  const sources = await import("@/lib/monitor/seatTickSources");
  const selected = spyOn(registryModule, "agentRegistry").mockReturnValue(f.registry);
  const control = spyOn(actions, "applyConversationAction").mockResolvedValue({ status: 200, body: {} });
  const observed = spyOn(sources, "defaultSeatTickSources").mockReturnValue({ registry: () => f.registry, liveness: async () => [], now: () => epoch } as never);
  cleanups.push(() => { selected.mockRestore(); control.mockRestore(); observed.mockRestore(); });
  expect(await confirmOwnerStop(f.record)).toBe(true);
  expect(control).toHaveBeenCalledTimes(proof === "lost" ? 0 : 1);
  if (proof === "lost") expect(f.saved().ownerTurn?.released?.reason).toBe("no_execution");
  if (proof === "unverified") expect(sendReceiptFor(f.registry.deliverySnapshotForOperation(f.operationId), f.operationId))
    .toMatchObject({ duplicateRisk: true, resend: "verify-first" });
});

// The child re-enters the real public owner entry point with the same durable
// retry marker. A process restart cannot replenish the one-retry allowance.
test("a fresh process adopts the persisted retry without creating another attempt", async () => {
  if (process.env.LLV_CONTINUATION_RESTART_CHILD === "1") {
    const clock = spyOn(Date, "now").mockReturnValue(epoch + 60_001);
    cleanups.push(() => { clock.mockRestore(); });
    const { continueOwnerAgent } = await import("./ownerRun");
    const record = readRunLedger().runs.find(row => row.requestId === "continuation-fixture")!;
    const registry = new AgentRegistry(process.env.LLV_CONTINUATION_REGISTRY!, undefined, undefined, { sqliteMode: "sqlite" });
    let sends = 0, starts = 0, stops = 0;
    const run = continueOwnerAgent({ accountId: null, request: requestSchema.parse({ ...contextRequest, request_id: record.requestId, lease_id: record.leaseId }),
      owner: { messageId: "m_fixture", text: "Inspect fixture", requestText: null }, target: { ...newTargetSettings({ target_id: "target_1", name: "Fixture", answered_by: "install", fallback: "none" }), engine: "codex" },
      hardCapMs: 5000, conversationId: record.conversationId!, prompt: "Inspect fixture",
      preparedPrompt: { prompt: "Inspect fixture", seen: [], digest: "fixture" }, onConversation: () => {}, ports: {
        launch: async () => { starts++; throw Error("unexpected launch"); },
        continue: async turn => { sends++; return { ok: true, structured: true, operationId: turn.continuation!.operationId, outcome: "held", target: record.conversationId! }; },
        observe: async turn => observeOwnerContinuation(turn, { registry: () => registry, liveness: async () => [], now: () => epoch },
          id => resolveSendReceipt(id, { registry, client: null, progress: null })),
        noExecution: async row => hasNoExecution(row, registry), stop: async () => { stops++; },
      } });
    const result = await run.done;
    console.log(`CONTINUATION_RESULT=${JSON.stringify({ status: result.status, sends, starts, stops, continuation: readRunLedger().runs.find(row => row.requestId === record.requestId)?.ownerTurn?.continuation, diagnostic: result.diagnostic?.message })}`);
    registry.close();
    return;
  }
  const f = fixture("restart");
  f.settle(f.operationId, "lost");
  const retry = { operationId: `${f.operationId}-retry`, retryOfOperationId: f.operationId,
    deadlineAt: new Date(epoch + 50_000).toISOString(), failureReason: f.lostReason };
  f.settle(retry.operationId, "lost");
  changeRun(f.record.requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, continuation: retry, admissionComplete: true, restartRetries: 1 } }));
  const child = Bun.spawn([process.execPath, "test", import.meta.filename, "--test-name-pattern", "a fresh process adopts"], {
    env: { ...process.env, LLV_CONTINUATION_RESTART_CHILD: "1", LLV_CONTINUATION_REGISTRY: f.registry.filename }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15_000);
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  expect(code, error).toBe(0);
  const result = JSON.parse(output.split("\n").find(line => line.startsWith("CONTINUATION_RESULT="))!.split("=")[1]!);
  expect(result).toMatchObject({ status: "failed", sends: 0, starts: 0, stops: 0, continuation: retry, diagnostic: expect.stringContaining(f.primary) });
}, 20_000);


for (const fence of ["admission", "async-admission", "dispatch", "recovery"] as const)
test(`production continuation retry rechecks custody at ${fence} after an await`, async () => {
  const f = fixture();
  const { sendOwnerContinuation } = await import("./ownerRun");
  const registryModule = await import("@/lib/agent/registry");
  const { accountManager } = await import("@/lib/accounts/manager");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const delivery = await import("@/lib/runtime/structuredMessageDelivery");
  const account = createManagedClaudeAccount("Pinned fixture");
  const transcript = path.join(f.root, "session.jsonl");
  fs.writeFileSync(transcript, "fixture");
  const conversation = { id: f.conversationId, engine: "claude", generations: [{ id: "fixture-session", path: transcript, accountId: account.id }] };
  f.settle(f.operationId, "lost");
  const continuation = { operationId: `${f.operationId}-retry`, retryOfOperationId: f.operationId,
    deadlineAt: new Date(epoch + 50_000).toISOString() };
  changeRun(f.record.requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, admissionComplete: true, continuation, restartRetries: 1 } }));
  const prepare = spyOn(registryModule, "prepareAgentRegistry").mockResolvedValue(f.registry);
  const lookup = spyOn(f.registry, "conversation").mockReturnValue(conversation as never);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId: account.id } as never });
  let effects = 0;
  const dispatch = spyOn(delivery, "enqueueStructuredMessage").mockImplementation(async (request, dependencies) => {
    expect(request.operationId).toBe(continuation.operationId);
    expect(request.clientMessageId).toBe(continuation.operationId);
    request.admissionGuard?.();
    await Promise.resolve();
    changeRun(f.record.requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, cancel: "interrupt" } }));
    if (fence === "admission") request.admissionGuard?.();
    if (fence === "async-admission") await request.admissionGuardAsync?.();
    if (fence === "dispatch") await dependencies?.authorizeDispatch?.();
    if (fence === "recovery") request.recoveryAuthorityGuard?.();
    effects++;
    return { ok: true, structured: true, target: f.conversationId, outcome: "held", operationId: continuation.operationId };
  });
  cleanups.push(() => { prepare.mockRestore(); lookup.mockRestore(); selection.mockRestore(); dispatch.mockRestore(); });
  await expect(sendOwnerContinuation({ clientAttemptId: f.operationId, conversationId: f.conversationId,
    claimedAt: f.record.startedAt, continuation }, "Fixture instruction", { ...newTargetSettings({ target_id: "target_1", name: "Fixture", answered_by: "install", fallback: "none" }), engine: "claude" }, () => {}))
    .rejects.toThrow("owner continuation retry custody changed");
  expect(effects).toBe(0);
});


test("a delivery failure answer is specific and keeps internal refusal details private in both languages", () => {
  const diagnostic = { source: "observation" as const, message: "fixture internal admission refusal", deliveryFailure: true as const };
  for (const text of ["Inspect fixture", "Перевір фікстуру"] ) {
    const reply = ownerFailureAnswer(requestSchema.parse({ ...contextRequest, answer: { ...contextRequest.answer, max_chars: 4000 } }),
      { messageId: contextRequest.input.respond_to!, text, requestText: null }, diagnostic);
    expect(reply?.text).toContain(text === "Inspect fixture" ? "continuation delivery failed" : "доставити продовження");
    expect(reply?.text).not.toContain(diagnostic.message);
  }
});

test("deadline expiry during retry registry preparation retains the proven no-execution retry without stopping the idle host", async () => {
  const f = fixture("lost");
  const { sendOwnerContinuation } = await import("./ownerRun");
  const registryModule = await import("@/lib/agent/registry");
  const { accountManager } = await import("@/lib/accounts/manager");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const account = createManagedClaudeAccount("Pinned fixture");
  const transcript = path.join(f.root, "session.jsonl");
  fs.writeFileSync(transcript, "fixture");
  const conversation = { id: f.conversationId, engine: "claude", generations: [{ id: "fixture-session", path: transcript, accountId: account.id }] };
  const prepare = spyOn(registryModule, "prepareAgentRegistry").mockImplementation(async () => {
    f.advance(epoch + 60_001);
    return f.registry;
  });
  const lookup = spyOn(f.registry, "conversation").mockReturnValue(conversation as never);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId: account.id } as never });
  let attempts = 0, enqueues = 0;
  f.ports.continue = async (turn, prompt, target, authorize) => {
    attempts++;
    if (attempts === 1) {
      authorize();
      f.settle(turn.continuation!.operationId, "lost");
      return { ok: true, structured: true, operationId: turn.continuation!.operationId, outcome: "held", target: f.conversationId };
    }
    return sendOwnerContinuation(turn, prompt, target, authorize);
  };
  const enqueue = await import("@/lib/runtime/structuredMessageDelivery");
  const dispatch = spyOn(enqueue, "enqueueStructuredMessage").mockImplementation(async () => {
    enqueues++;
    throw new Error("deadline refusal must happen before enqueue");
  });
  cleanups.push(() => { prepare.mockRestore(); lookup.mockRestore(); selection.mockRestore(); dispatch.mockRestore(); });

  const result = await f.start("claude").done;
  expect(result.status).toBe("failed");
  expect(result.diagnostic?.message).toContain(f.primary);
  expect(result.diagnostic?.deliveryFailure).toBe(true);
  expect(f.counts()).toMatchObject({ launches: 0, stops: 0 });
  expect(attempts).toBe(2);
  expect(enqueues).toBe(0);
  expect(f.saved().ownerTurn?.restartRetries).toBe(1);
  expect(f.saved().ownerTurn?.continuation).toMatchObject({
    operationId: f.operationId,
    retryOfOperationId: f.operationId,
    failureReason: expect.stringContaining(f.primary),
  });
});


test("orphan recovery in a fresh process spends the persisted continuation retry without starting another agent", async () => {
  const f = fixture("lost");
  expect((await f.start().done).status).toBe("failed");
  const issued = f.saved().ownerTurn!;
  expect(issued.restartRetries).toBe(1);
  const { clonePairing } = await import("./clone.fixture");
  const relay = clonePairing("http://127.0.0.1:1");
  relay.id = f.record.relayId;
  relay.targets = [{ ...newTargetSettings({ target_id: f.record.targetId, name: "Fixture", answered_by: "install", fallback: "none" }),
    ownerTier: true, enabled: true, engine: "codex" }];
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const dead = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  expect(await dead.exited).toBe(0);
  const retry = issued.continuation!;
  changeRun(f.record.requestId, row => ({ ...row, ownerPid: dead.pid, ownerIdentity: "exited-fixture-owner", ownerTurn: {
    clientAttemptId: issued.clientAttemptId, continuation: retry, restartRetries: issued.restartRetries, admissionComplete: true,
    // The runner persists only a verified owner claim as an owner turn's raw request.
    rawRequest: { ...f.request, input: { ...f.request.input, requester: { ...f.request.input.requester!, is_owner: true } } }, context: { messageId: f.request.input.respond_to!, text: "Inspect fixture", requestText: null } } }));
  const source = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
  const program = `
    Date.now = () => ${epoch};
    const { AgentRegistry } = await import(${source("../agent/registry.ts")});
    const { sendReceiptFor } = await import(${source("../runtime/sendSettlement.ts")});
    const { sweepExternalRelayOrphans } = await import(${source("./poller.ts")});
    const { readRunLedger } = await import(${source("./store.ts")});
    const { accountManager } = await import(${source("../accounts/manager.ts")});
    accountManager.resolveHeadlessSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: "fixture", kind: "managed",
      home: process.env.HOME, transcriptRoot: process.env.HOME, env: { ...process.env } } });
    const registry = new AgentRegistry(process.env.LLV_CONTINUATION_REGISTRY, undefined, undefined, { sqliteMode: "sqlite" });
    let starts = 0, stops = 0;
    await sweepExternalRelayOrphans({
      launch: async () => { starts++; throw Error("unexpected recovery agent"); },
      observe: async () => ({ state: "failed" }),
      noExecution: async run => {
        const id = run.ownerTurn.continuation.operationId;
        const receipt = sendReceiptFor(registry.deliverySnapshotForOperation(id), id);
        return receipt?.state === "failed" && receipt.resend === "safe" && receipt.conversationId === run.conversationId;
      }, stop: async () => { stops++; },
    });
    const saved = readRunLedger().runs.find(row => row.requestId === "continuation-fixture");
    console.log(JSON.stringify({ starts, stops, diagnostic: saved.ownerTurn.diagnostic, lateAnswer: saved.ownerTurn.lateAnswer }));
    registry.close();
  `;
  const child = Bun.spawn([process.execPath, "-e", program], { env: { ...process.env, LLV_CONTINUATION_REGISTRY: f.registry.filename }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15_000);
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  expect(code, error).toBe(0);
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  expect(result).toMatchObject({ starts: 0, stops: 0, diagnostic: { deliveryFailure: true, message: expect.stringContaining(f.primary), primaryFailure: { status: "rejected", reason: f.primary } },
    lateAnswer: { body: { outcome: "answered", answer: { text: "Delivery failed." } } } });
}, 20_000);


for (const replaced of [false, true]) test(`production retry traverses the real reservation and runtime journal (owner replaced=${replaced})`, async () => {
  const f = fixture();
  const { migrationDeliveryFixture } = await import("@/test-helpers/migrationDelivery");
  const native = migrationDeliveryFixture();
  cleanups.push(native.cleanup);
  const { clonePairing } = await import("./clone.fixture");
  const { procBackend } = await import("@/lib/proc");
  const relay = clonePairing("http://127.0.0.1:1");
  relay.id = f.record.relayId;
  relay.targets = [{ ...newTargetSettings({ target_id: f.record.targetId, name: "Fixture", answered_by: "install", fallback: "none" }), ownerTier: true, enabled: true }];
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const continuation = { operationId: `${f.operationId}-retry`, retryOfOperationId: f.operationId,
    deadlineAt: new Date(epoch + 50_000).toISOString() };
  changeRun(f.record.requestId, row => ({ ...row, conversationId: native.conversation.id,
    ownerIdentity: procBackend.processIdentity(process.pid), ownerTurn: { ...row.ownerTurn!, admissionComplete: true, continuation, restartRetries: 1 } }));
  const original = native.registry.holdDelivery(native.conversation.id, "Fixture instruction", f.operationId, "text", [], null, { operationId: f.operationId });
  native.registry.recordDeliveryOutcome(original.id, "failed", SEND_LOST_REASON, "lost", null, { status: "rejected", reason: f.primary });
  const registryModule = await import("@/lib/agent/registry");
  const delivery = await import("@/lib/runtime/structuredMessageDelivery");
  const { accountManager } = await import("@/lib/accounts/manager");
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const { sendOwnerContinuation } = await import("./ownerRun");
  const prepare = spyOn(registryModule, "prepareAgentRegistry").mockResolvedValue(native.registry);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId: "account-a" } as never });
  const enqueue = delivery.enqueueStructuredMessage;
  const route = spyOn(delivery, "enqueueStructuredMessage").mockImplementation((request, dependencies) => enqueue(request, {
    ...dependencies, enabled: () => true, registry: () => native.registry, client: () => native.client,
    kick: () => {}, startupFailed: () => false, progress: null,
  }));
  let claims = 0, commands = 0;
  const begin = native.registry.beginDeliveryAttemptOffLoop.bind(native.registry);
  const claim = spyOn(native.registry, "beginDeliveryAttemptOffLoop").mockImplementation(async (...args) => {
    const result = await begin(...args);
    if (result.acquired) {
      claims++;
      if (replaced) changeRun(f.record.requestId, row => ({ ...row, leaseId: "replacement-lease" }));
    }
    return result;
  });
  native.client.readSession = async identity => native.journal.snapshot().sessions.find(row => row.conversationId === identity.conversationId) ?? null;
  native.client.command = async command => { commands++; return native.journal.executeOperation(command); };
  cleanups.push(() => { prepare.mockRestore(); selection.mockRestore(); route.mockRestore(); claim.mockRestore(); });
  await bindStructuredDeliveryQueue([{ key: native.key, host: native.host }], { registry: native.registry, client: native.client,
    hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
  const result = await sendOwnerContinuation({ clientAttemptId: f.operationId, conversationId: native.conversation.id,
    claimedAt: f.record.startedAt, continuation }, "Fixture instruction", { ...relay.targets[0]!, engine: "codex" }, () => {
      if (f.saved().leaseId !== f.record.leaseId) throw Error("fixture owner replaced");
    });
  expect(claims, JSON.stringify(result)).toBe(1);
  expect(commands).toBe(replaced ? 0 : 1);
  expect(result).toMatchObject({ ok: !replaced });
  const snapshot = native.registry.deliverySnapshotForOperation(continuation.operationId);
  expect(snapshot.deliveryOperationOwners[continuation.operationId]?.clientMessageId).toBe(continuation.operationId);
  expect(sendReceiptFor(native.registry.deliverySnapshotForOperation(f.operationId), f.operationId)).toMatchObject({ state: "failed", resend: "safe" });
  if (!replaced) {
    const { ownerRelayOperationAuthorized } = await import("./ownerAuthority");
    const { kickStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliverySignal");
    expect(ownerRelayOperationAuthorized(continuation.operationId, native.conversation.id)).toBe(true);
    f.advance(epoch + 50_000);
    expect(ownerRelayOperationAuthorized(continuation.operationId, native.conversation.id)).toBe(false);
    await kickStructuredDeliveryQueue();
    expect(native.host.ledger.writes).toEqual([]);
  }
});


test("the durable retry dispatch deadline survives process restart and refuses missing or malformed proof", async () => {
  const f = fixture();
  const { clonePairing } = await import("./clone.fixture");
  const relay = clonePairing("http://127.0.0.1:1");
  relay.id = f.record.relayId;
  relay.targets = [{ ...newTargetSettings({ target_id: f.record.targetId, name: "Fixture", answered_by: "install", fallback: "none" }), ownerTier: true, enabled: true }];
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const retry = { operationId: `${f.operationId}-retry`, retryOfOperationId: f.operationId, deadlineAt: new Date(epoch + 50_000).toISOString() };
  changeRun(f.record.requestId, row => ({ ...row, ownerTurn: { ...row.ownerTurn!, continuation: retry, restartRetries: 1 } }));
  const source = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
  const program = `
    const { procBackend } = await import(${source("../proc/index.ts")});
    const { changeRun } = await import(${source("./store.ts")});
    const { ownerRelayOperationAuthorized } = await import(${source("./ownerAuthority.ts")});
    changeRun("continuation-fixture", row => ({ ...row, ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid) }));
    const authorized = () => ownerRelayOperationAuthorized("relay-owner-continuation-fixture-retry", "conversation_continuation-fixture");
    Date.now = () => ${epoch + 49_999};
    const before = authorized();
    Date.now = () => ${epoch + 50_000};
    const at = authorized();
    Date.now = () => ${epoch + 49_999};
    changeRun("continuation-fixture", row => ({ ...row, ownerTurn: { ...row.ownerTurn, continuation: { ...row.ownerTurn.continuation, deadlineAt: undefined } } }));
    const missing = authorized();
    changeRun("continuation-fixture", row => ({ ...row, ownerTurn: { ...row.ownerTurn, continuation: { ...row.ownerTurn.continuation, deadlineAt: "invalid-date" } } }));
    console.log(JSON.stringify({ before, at, missing, malformed: authorized() }));
  `;
  const child = Bun.spawn([process.execPath, "-e", program], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 15_000);
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  expect(code, error).toBe(0);
  expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ before: true, at: false, missing: false, malformed: false });
}, 20_000);


test("a long original refusal survives the relay diagnostic and its durable retry record", async () => {
  const primary = "fixture original admission refusal ".repeat(45);
  const f = fixture("lost", primary);
  const result = await f.start().done;
  expect(result.status).toBe("failed");
  expect(result.diagnostic?.message.length).toBeLessThanOrEqual(1024);
  expect(result.diagnostic?.primaryFailure).toEqual({ status: "rejected", reason: primary });
  expect(f.saved().ownerTurn?.continuation?.primaryFailure).toEqual({ status: "rejected", reason: primary });
  const { answerRecorder, readAnswerRecord } = await import("./answers");
  const recorder = answerRecorder({ requestId: f.record.requestId, relayId: f.record.relayId, targetId: f.record.targetId,
    targetName: "Fixture", claimedAt: f.record.startedAt, input: f.request.input });
  recorder!.diagnose(result.diagnostic!);
  expect(readAnswerRecord(f.record.relayId, f.record.targetId, f.record.requestId)?.diagnostic?.primaryFailure)
    .toEqual({ status: "rejected", reason: primary });
});

test("an initial terminal rejected receipt proves loss before continuation retry or stop", async () => {
  const primary = "initial journal rejection: " + "cause ".repeat(80);
  const f = fixture();
  let proofReads = 0;
  const directSends: string[] = [];
  const noExecution = f.ports.noExecution!;
  f.ports.noExecution = async run => { proofReads++; return noExecution(run); };
  f.ports.continue = async (turn, _prompt, _target, authorize) => {
    authorize();
    const id = turn.continuation!.operationId;
    directSends.push(id);
    if (id === f.operationId) {
      f.settle(id, "lost", primary);
      return {
        ok: false, structured: true, outcome: "failed", error: primary, status: 409, operationId: id,
        receipt: { operationId: id, idempotencyKey: "fixture-key", conversationId: f.conversationId, kind: "send", status: "rejected", reason: SEND_LOST_REASON,
          primaryFailure: { status: "rejected", reason: primary }, at: new Date(epoch).toISOString(), revision: 1 },
      };
    }
    f.settle(id, "delivered");
    return { ok: true, structured: true, operationId: id, outcome: "held", target: f.conversationId };
  };
  const result = await f.start().done;
  expect(result.status).toBe("done");
  expect(f.counts().launches).toBe(0);
  expect(f.counts().stops).toBe(0);
  expect(directSends).toEqual([f.operationId, `${f.operationId}-retry`]);
  expect(proofReads).toBeGreaterThan(0);
  expect(f.saved().ownerTurn?.continuation).toMatchObject({
    operationId: `${f.operationId}-retry`, retryOfOperationId: f.operationId,
    primaryFailure: { status: "rejected", reason: primary },
  });
});

test("initial terminal rejection retries through production custody without waiting for idle-host stop", async () => {
  const f = fixture("lost");
  const primary = "initial terminal fixture refusal";
  const { sendOwnerContinuation } = await import("./ownerRun");
  const registryModule = await import("@/lib/agent/registry");
  const { accountManager } = await import("@/lib/accounts/manager");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const delivery = await import("@/lib/runtime/structuredMessageDelivery");
  const account = createManagedClaudeAccount("Pinned fixture");
  const transcript = path.join(f.root, "session.jsonl");
  fs.writeFileSync(transcript, "fixture");
  const conversation = { id: f.conversationId, engine: "claude", generations: [{ id: "fixture-session", path: transcript, accountId: account.id }] };
  const prepare = spyOn(registryModule, "prepareAgentRegistry").mockResolvedValue(f.registry);
  const lookup = spyOn(f.registry, "conversation").mockReturnValue(conversation as never);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId: account.id } as never });
  let retryEnqueues = 0;
  const enqueue = spyOn(delivery, "enqueueStructuredMessage").mockImplementation(async (request, dependencies) => {
    retryEnqueues++;
    const operationId = request.operationId;
    if (!operationId) throw new Error("fixture delivery operation id is missing");
    expect(operationId).toBe(`${f.operationId}-retry`);
    request.admissionGuard?.();
    await request.admissionGuardAsync?.();
    await dependencies?.authorizeDispatch?.();
    f.settle(operationId, "delivered");
    return { ok: true, structured: true, target: f.conversationId, outcome: "held", operationId };
  });
  cleanups.push(() => { prepare.mockRestore(); lookup.mockRestore(); selection.mockRestore(); enqueue.mockRestore(); });
  let retrySendResult: Awaited<ReturnType<typeof sendOwnerContinuation>> | null = null;
  f.ports.continue = async (turn, prompt, target, authorize, repositoryBound) => {
    authorize();
    const operationId = turn.continuation!.operationId;
    if (!operationId) throw new Error("fixture continuation operation id is missing");
    if (operationId === f.operationId) {
      f.settle(operationId, "lost", primary);
      return { ok: false, structured: true, outcome: "failed", error: primary, status: 409, operationId,
        receipt: { operationId, idempotencyKey: "fixture-key", conversationId: f.conversationId, kind: "send", status: "rejected", reason: SEND_LOST_REASON,
          primaryFailure: { status: "rejected", reason: primary }, at: new Date(epoch).toISOString(), revision: 1 } };
    }
    const { ownerContinuationHasNoExecution } = await import("./ownerRun");
    const previous = readRunLedger().runs.find(row => row.requestId === f.record.requestId)!;
    expect(previous.ownerTurn?.admissionComplete).toBe(true);
    expect(ownerContinuationHasNoExecution({ ...previous, ownerTurn: { ...previous.ownerTurn!, continuation: { operationId: f.operationId } } }, f.registry)).toBe(true);
    retrySendResult = await sendOwnerContinuation(turn, prompt, target, authorize, repositoryBound);
    return retrySendResult;
  };

  const result = await f.start("claude").done;
  expect(result.status).toBe("done");
  expect(retrySendResult).toMatchObject({ ok: true, operationId: `${f.operationId}-retry` });
  expect(retryEnqueues).toBe(1);
  expect(f.counts()).toEqual({ launches: 0, stops: 0, sends: [] });
  expect(f.saved().ownerTurn).toMatchObject({ admissionComplete: true,
    continuation: { operationId: `${f.operationId}-retry`, retryOfOperationId: f.operationId, primaryFailure: { status: "rejected", reason: primary } } });
}, 10_000);


for (const reply of ["before-commit", "after-commit"] as const)
test(`a lost no-execution release reply ${reply} preserves custody without stopping the idle host`, async () => {
  const f = fixture();
  f.settle(f.operationId, "lost");
  f.record.ownerTurn = { ...f.record.ownerTurn!, cancel: "interrupt", admissionComplete: true, cancelledAt: new Date(epoch).toISOString() };
  changeRun(f.record.requestId, () => f.record);
  const store = await import("./store");
  const write = store.changeRunAsync;
  const refusal = spyOn(store, "changeRunAsync").mockImplementation(async (...args) => {
    if (reply === "after-commit") await write(...args);
    throw Error("fixture release reply unavailable");
  });
  try {
    expect(await confirmOwnerStop(f.record, f.ports)).toBe(reply === "after-commit");
    expect(f.counts().stops).toBe(0);
  } finally { refusal.mockRestore(); }
  expect(await confirmOwnerStop(f.record, f.ports)).toBe(true);
  expect(f.counts().stops).toBe(0);
  expect(f.saved().ownerTurn).toMatchObject({ confirmed: true, released: { reason: "no_execution" } });
});


for (const replacement of ["lease", "operation", "conversation"] as const)
test(`control acknowledgement cannot confirm a replaced continuation ${replacement}`, async () => {
  const f = fixture();
  f.settle(f.operationId, "unverified");
  f.record.ownerTurn = { ...f.record.ownerTurn!, cancel: "interrupt", admissionComplete: true, cancelledAt: new Date(epoch).toISOString() };
  changeRun(f.record.requestId, () => f.record);
  let controls = 0;
  f.ports.stop = async () => {
    controls++;
    changeRun(f.record.requestId, row => ({ ...row,
      ...(replacement === "lease" ? { leaseId: "replacement-lease" } : {}),
      ...(replacement === "conversation" ? { conversationId: "conversation_replacement" } : {}),
      ownerTurn: { ...row.ownerTurn!, ...(replacement === "operation" ? { continuation: { operationId: "replacement-operation" } } : {}) } }));
  };
  expect(await confirmOwnerStop(f.record, f.ports)).toBe(false);
  expect(controls).toBe(1);
  expect(f.saved().ownerTurn?.confirmed).toBeUndefined();
});

test("production continuation cleanup rechecks its owner after retiring the queued payload", async () => {
  const f = fixture();
  f.registry.holdDelivery(f.conversationId, "Fixture instruction", f.operationId, "text", [], null, { operationId: f.operationId });
  f.record.ownerTurn = { ...f.record.ownerTurn!, cancel: "interrupt", admissionComplete: true, cancelledAt: new Date(epoch).toISOString() };
  changeRun(f.record.requestId, () => f.record);
  const registryModule = await import("@/lib/agent/registry");
  const actions = await import("@/lib/conversation/actions");
  const sources = await import("@/lib/monitor/seatTickSources");
  const lookup = spyOn(registryModule, "agentRegistry").mockReturnValue(f.registry);
  const control = spyOn(actions, "applyConversationAction").mockResolvedValue({ status: 200, body: {} });
  const observed = spyOn(sources, "defaultSeatTickSources").mockReturnValue({ registry: () => f.registry, liveness: async () => [], now: () => epoch } as never);
  const write = f.registry.deliveryWrite.bind(f.registry);
  const retire = spyOn(f.registry, "deliveryWrite").mockImplementation(async (...args) => {
    const result = await write(...args);
    changeRun(f.record.requestId, row => ({ ...row, leaseId: "replacement-lease" }));
    return result;
  });
  cleanups.push(() => { lookup.mockRestore(); control.mockRestore(); observed.mockRestore(); retire.mockRestore(); });
  expect(await confirmOwnerStop(f.record)).toBe(false);
  expect(control).not.toHaveBeenCalled();
  expect(f.saved()).toMatchObject({ leaseId: "replacement-lease" });
  expect(f.saved().ownerTurn?.confirmed).toBeUndefined();
});

for (const afterAdmission of ["reply", "dispatch", "recovery"] as const)
for (const retryState of ["unverified", "delivered"] as const)
test(`review deadline after admitted retry preserves ${retryState} operation custody${afterAdmission === "reply" ? "" : ` at ${afterAdmission}`}`, async () => {
  const f = fixture("lost");
  const primary = "initial terminal fixture refusal";
  const { sendOwnerContinuation } = await import("./ownerRun");
  const registryModule = await import("@/lib/agent/registry");
  const { accountManager } = await import("@/lib/accounts/manager");
  const { createManagedClaudeAccount } = await import("@/lib/accounts/claude");
  const delivery = await import("@/lib/runtime/structuredMessageDelivery");
  const account = createManagedClaudeAccount("Pinned fixture");
  const transcript = path.join(f.root, "session.jsonl");
  fs.writeFileSync(transcript, "fixture");
  const conversation = { id: f.conversationId, engine: "claude", generations: [{ id: "fixture-session", path: transcript, accountId: account.id }] };
  const prepare = spyOn(registryModule, "prepareAgentRegistry").mockResolvedValue(f.registry);
  const lookup = spyOn(f.registry, "conversation").mockReturnValue(conversation as never);
  const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: { accountId: account.id } as never });
  let retryEnqueues = 0;
  const enqueue = spyOn(delivery, "enqueueStructuredMessage").mockImplementation(async (request, dependencies): ReturnType<typeof sendOwnerContinuation> => {
    retryEnqueues++;
    const operationId = request.operationId;
    if (!operationId) throw new Error("fixture delivery operation id is missing");
    expect(operationId).toBe(`${f.operationId}-retry`);
    request.admissionGuard?.();
    await request.admissionGuardAsync?.();
    await dependencies?.authorizeDispatch?.();
    f.settle(operationId, retryState);
    f.advance(epoch + 60_001);
    if (afterAdmission === "dispatch") await dependencies?.authorizeDispatch?.();
    if (afterAdmission === "recovery") request.recoveryAuthorityGuard?.();
    if (retryState === "unverified") return { ok: false, structured: true, status: 409, outcome: "failed", error: "fixture uncertain", operationId,
      receipt: { operationId, idempotencyKey: "fixture-retry-key", conversationId: f.conversationId, kind: "send", status: "uncertain", reason: "fixture uncertain", at: new Date(epoch).toISOString(), revision: 2 } };
    return { ok: true, structured: true, target: f.conversationId, outcome: "delivered", operationId,
      receipt: { operationId, idempotencyKey: "fixture-retry-key", conversationId: f.conversationId, kind: "send", status: "delivered",
        at: new Date(epoch).toISOString(), revision: 2 } };
  });
  cleanups.push(() => { prepare.mockRestore(); lookup.mockRestore(); selection.mockRestore(); enqueue.mockRestore(); });
  let retrySendResult: Awaited<ReturnType<typeof sendOwnerContinuation>> | null = null;
  let stopCalls = 0;
  f.ports.stop = async () => { stopCalls++; };
  f.ports.continue = async (turn, prompt, target, authorize, repositoryBound) => {
    authorize();
    const operationId = turn.continuation!.operationId;
    if (!operationId) throw new Error("fixture continuation operation id is missing");
    if (operationId === f.operationId) {
      f.settle(operationId, "lost", primary);
      return { ok: false, structured: true, outcome: "failed", error: primary, status: 409, operationId,
        receipt: { operationId, idempotencyKey: "fixture-key", conversationId: f.conversationId, kind: "send", status: "rejected", reason: SEND_LOST_REASON,
          primaryFailure: { status: "rejected", reason: primary }, at: new Date(epoch).toISOString(), revision: 1 } };
    }
    const { ownerContinuationHasNoExecution } = await import("./ownerRun");
    const previous = readRunLedger().runs.find(row => row.requestId === f.record.requestId)!;
    expect(previous.ownerTurn?.admissionComplete).toBe(true);
    expect(ownerContinuationHasNoExecution({ ...previous, ownerTurn: { ...previous.ownerTurn!, continuation: { operationId: f.operationId } } }, f.registry)).toBe(true);
    retrySendResult = await sendOwnerContinuation(turn, prompt, target, authorize, repositoryBound);
    return retrySendResult;
  };

  const result = await f.start("claude").done;
  expect(result.status).toBe("failed");
  if (afterAdmission === "reply") expect(retrySendResult).toMatchObject({ ok: retryState === "delivered", operationId: `${f.operationId}-retry` });
  else expect(retrySendResult).toBeNull();
  expect(retryEnqueues).toBe(1);
  expect(f.counts().launches).toBe(0);
  expect(f.saved().ownerTurn).toMatchObject({ restartRetries: 1,
    continuation: { operationId: `${f.operationId}-retry`, retryOfOperationId: f.operationId,
      deadlineAt: new Date(epoch + 50_000).toISOString(), primaryFailure: { status: "rejected", reason: primary } } });
  expect(result.diagnostic?.primaryFailure).toEqual({ status: "rejected", reason: primary });
  expect(sendReceiptFor(f.registry.deliverySnapshotForOperation(`${f.operationId}-retry`), `${f.operationId}-retry`))
    .toMatchObject(retryState === "unverified" ? { duplicateRisk: true, resend: "verify-first" } : { state: "delivered" });
  expect(f.saved().ownerTurn?.released?.reason).not.toBe("no_execution");
  expect(stopCalls).toBe(1);
}, 10_000);
