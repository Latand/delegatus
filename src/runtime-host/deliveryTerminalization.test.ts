import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { RuntimeJournal } from "./journal";
import { RuntimeHost } from "./host";
import { serveRuntimeHost } from "./socket";
import { testEndpoint } from "./fixtures/testEndpoint";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import { FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";
import { classifyStructuredHostStartupError, runStructuredHostStartup } from "@/lib/viewerInstrumentation";
import { AgentRegistry } from "@/lib/agent/registry";
import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import { STOPPED_MIGRATION_DELIVERY_REASON } from "@/lib/accounts/migration/intentLiveness";

const now = Date.parse("2026-10-01T00:00:00Z");
const operationId = "terminalization-send";
function seed(journal: RuntimeJournal, conversationId = "conversation_terminalization") {
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: "terminalization" },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
  } });
  journal.executeOperation({ kind: "send", operationId, conversationId,
    idempotencyKey: "terminalization-key", text: "deliver once", policy: "queue" });
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

for (const sqliteMode of ["off", "sqlite"] as const) for (const prior of ["unverified", "compacted", "migration", "lost", "delivered"] as const) {
  test(`batched discard projection preserves its winner across reopen: ${sqliteMode}, ${prior}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-projection-"));
    const filename = path.join(directory, "registry.json");
    const options = { sqliteMode, now: () => now };
    const registry = new AgentRegistry(filename, undefined, undefined, options);
    let reopened: AgentRegistry | undefined;
    try {
      const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), null);
      const held = registry.holdDelivery(conversation.id, "retained instruction", "projection-key", "text", [], null,
        { operationId, kind: "send", policy: "queue" });
      registry.beginDeliveryAttempt(held.id, held.generationId!);
      const reason = prior === "migration" ? STOPPED_MIGRATION_DELIVERY_REASON : "prior observation";
      registry.recordDeliveryOutcome(held.id, prior === "delivered" ? "delivered" : "failed", reason,
        prior === "delivered" ? "delivered" : prior === "lost" ? "lost" : "unverified");
      if (prior === "compacted") registry.discardDelivery(held.id);
      const outcome = { conversationId: conversation.id, operationId, state: "failed" as const,
        error: "delivery-discarded", disposition: "unverified" as const };
      registry.recordDeliveryOutcomesForOperations([outcome]);
      registry.recordDeliveryOutcomesForOperations([outcome]);
      registry.close();
      reopened = new AgentRegistry(filename, undefined, undefined, options);
      const owner = reopened.readOnlySnapshot().deliveryOperationOwners[operationId]!;
      expect(owner.terminalState).toBe(prior === "delivered" ? "delivered" : "failed");
      expect(owner.terminalReason).toBe(prior === "lost" || prior === "delivered" ? reason : "delivery-discarded");
      if (prior !== "lost" && prior !== "delivered") {
        expect(owner.terminalDisposition).toBe("unverified");
        expect(owner.evidenceText).toBe("");
      }
    } finally {
      reopened?.close(); registry.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const winner of ["discard", "acknowledgement"] as const) test(`the real socket preserves ${winner} as the sole terminal decision`, async () => {
  const { confirmJournalDelivery } = await import("@/lib/runtime/sendSettlement");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-decision-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true, now: () => now });
  seed(journal);
  journal.transitionOperation(operationId, "delivering");
  journal.transitionOperation(operationId, "uncertain");
  const endpoint = testEndpoint(directory, "decision");
  const server = serveRuntimeHost(endpoint, new RuntimeHost(journal));
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const client = new UnixRuntimeHostClient(endpoint);
  try {
    if (winner === "discard") {
      await client.claimDeliveryAction(operationId, "discard");
      expect(await confirmJournalDelivery(client, operationId)).toMatchObject({ verdict: { state: "failed", reason: "delivery-discarded" } });
    } else {
      expect(await confirmJournalDelivery(client, operationId)).toMatchObject({ verdict: { state: "delivered" } });
      await expect(client.claimDeliveryAction(operationId, "discard")).rejects.toThrow("cannot discard");
    }
    const committed = journal.operationResult(operationId);
    await confirmJournalDelivery(client, operationId);
    expect(journal.operationResult(operationId)).toEqual(committed);
    expect(journal.effectBatch()).toEqual([]);
    await expect(client.transitionOperation(operationId, "queued", {}, { confirmedDelivery: true })).rejects.toThrow("flag is invalid");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    journal.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an older host cannot silently drop confirmation arbitration and receives no fallback write", async () => {
  const { confirmJournalDelivery } = await import("@/lib/runtime/sendSettlement");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-old-protocol-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true, now: () => now });
  seed(journal);
  journal.transitionOperation(operationId, "delivering");
  journal.transitionOperation(operationId, "uncertain");
  const host = new RuntimeHost(journal);
  const requests: string[] = [];
  const endpoint = testEndpoint(directory, "old");
  const server = serveRuntimeHost(endpoint, { handle: async (request, options) => {
    requests.push(request.method);
    return request.method === "operation-confirm-delivery"
      ? { id: request.id, ok: false, error: "runtime request method is unsupported" }
      : host.handle(request, options);
  } });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  try {
    expect(await confirmJournalDelivery(new UnixRuntimeHostClient(endpoint), operationId)).toBeNull();
    expect(requests).toEqual(["operation-confirm-delivery", "operation-status"]);
    expect(journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    journal.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical confirmation cannot reopen a cancelled migration or acknowledge a control", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-confirm-refusal-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true, now: () => now });
  seed(journal);
  journal.transitionOperation(operationId, "failed", { reason: STOPPED_MIGRATION_DELIVERY_REASON });
  journal.executeOperation({ kind: "compact", operationId: "control-confirmation", conversationId: "conversation_terminalization",
    idempotencyKey: "control-confirmation-key", sessionKey: { engine: "codex", sessionId: "terminalization" } });
  const endpoint = testEndpoint(directory, "refused");
  const server = serveRuntimeHost(endpoint, new RuntimeHost(journal));
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const client = new UnixRuntimeHostClient(endpoint);
  try {
    await expect(client.transitionOperation(operationId, "delivered", {}, { confirmedDelivery: true })).rejects.toThrow("cancellation already won");
    await expect(client.transitionOperation("control-confirmation", "delivered", {}, { confirmedDelivery: true })).rejects.toThrow("requires a delivered message");
    expect(journal.operationResult(operationId)?.receipt).toMatchObject({ status: "failed", reason: STOPPED_MIGRATION_DELIVERY_REASON });
    expect(journal.operationResult("control-confirmation")?.receipt.status).toBe("pending");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    journal.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const method of ["operation-delivery-action", "operation-transition", "operation-projection-ack"] as const) {
  test(`${method} yields under a real SQLite writer lock and commits after release`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-writer-"));
    const filename = path.join(directory, "runtime.sqlite");
    const journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
    seed(journal);
    const peer = new Database(filename);
    peer.exec("BEGIN IMMEDIATE");
    let locked = true;
    const entered = barrier();
    const host = new RuntimeHost(journal);
    const endpoint = testEndpoint(directory, "writer");
    const server = serveRuntimeHost(endpoint, { handle: (request, options) => {
      const response = host.handle(request, options);
      entered.release();
      return response;
    } });
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const client = new UnixRuntimeHostClient(endpoint);
    const pending = method === "operation-delivery-action"
      ? client.claimDeliveryAction(operationId, "discard")
      : method === "operation-transition"
        ? client.transitionOperation(operationId, "failed", { reason: "delivery-discarded" }, { fromStatuses: ["queued"] })
        : client.acknowledgeTerminalProjection([operationId]);
    try {
      await entered.promise;
      expect(stateLockWaitsInFlight().some(wait => wait.callSite === (method === "operation-delivery-action"
        ? "runtime.delivery-action" : method === "operation-transition" ? "runtime.delivery-transition" : "runtime.delivery-projection"))).toBe(true);
      expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
      peer.exec("COMMIT");
      locked = false;
      await pending;
      expect(journal.operationResult(operationId)?.receipt).toMatchObject(method === "operation-projection-ack"
        ? { status: "queued" } : { status: "failed", reason: "delivery-discarded" });
    } finally {
      if (locked) peer.exec("ROLLBACK");
      await pending.catch(() => {});
      await new Promise<void>(resolve => server.close(() => resolve()));
      peer.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test(`${method} cancelled during writer admission commits nothing after release`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-cancel-writer-"));
    const filename = path.join(directory, "runtime.sqlite");
    const journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
    const peer = new Database(filename);
    const abort = new AbortController();
    let pending: ReturnType<RuntimeHost["handle"]> | undefined;
    try {
      seed(journal);
      peer.exec("BEGIN IMMEDIATE");
      pending = new RuntimeHost(journal).handle({ id: "cancel-writer", method, params: {
        operationId, operationIds: [operationId], action: "discard", status: "failed", details: { reason: "delivery-discarded" }, fromStatuses: ["queued"],
      } }, { signal: abort.signal });
      expect(stateLockWaitsInFlight().some(wait => wait.callSite.startsWith("runtime.delivery-"))).toBe(true);
      abort.abort(new Error("fixture admission cancelled"));
      peer.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: "fixture admission cancelled" });
      expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
      expect(journal.effectBatch()).toHaveLength(1);
    } finally {
      abort.abort(new Error("fixture cleanup"));
      if (peer.inTransaction) peer.exec("ROLLBACK");
      await pending?.catch(() => {});
      peer.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
}

test("a queued discard retains its terminal receipt until projection is acknowledged after restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-discard-retention-"));
  const filename = path.join(directory, "runtime.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
  let reopened: RuntimeJournal | undefined;
  try {
    seed(journal);
    journal.transitionOperation(operationId, "failed", { reason: "delivery-discarded" }, { fromStatuses: ["queued"] });
    expect(journal.unprojectedTerminalOperationIds()).toEqual([operationId]);
    journal.close();
    reopened = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
    expect(reopened.unprojectedTerminalOperationIds()).toEqual([operationId]);
    expect(reopened.acknowledgeTerminalProjection([operationId])).toBe(1);
    expect(reopened.unprojectedTerminalOperationIds()).toEqual([]);
  } finally { reopened?.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const initial of ["queued", "uncertain"] as const) test(`HTTP discard releases ${initial} receipt retention after its registry projection`, async () => {
  const { handleRuntimeDiscard } = await import("@/lib/runtime/http");
  const { NextRequest } = await import("next/server");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-http-projection-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off", now: () => now });
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), null);
  const held = registry.holdDelivery(conversation.id, "deliver once", "terminalization-key", "text", [], null,
    { operationId, kind: "send", policy: "queue" });
  registry.beginDeliveryAttempt(held.id, held.generationId!);
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true, now: () => now });
  seed(journal, conversation.id);
  if (initial === "uncertain") {
    journal.transitionOperation(operationId, "delivering");
    journal.transitionOperation(operationId, "uncertain");
  }
  const host = new RuntimeHost(journal);
  const reasonsAtAcknowledgement: (string | null)[] = [];
  const endpoint = testEndpoint(directory, "projected");
  const server = serveRuntimeHost(endpoint, { handle: (request, options) => {
    if (request.method === "operation-projection-ack") {
      reasonsAtAcknowledgement.push(registry.readOnlySnapshot().heldDeliveries[held.id]?.error ?? null);
    }
    return host.handle(request, options);
  } });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const client = new UnixRuntimeHostClient(endpoint);
  try {
    const response = await handleRuntimeDiscard(new NextRequest("http://127.0.0.1/api/runtime/operations/terminalization-send", {
      method: "DELETE", headers: { host: "127.0.0.1" },
    }), operationId, { enabled: () => true, registry: () => registry, client: () => client, kick: () => {} });
    expect(response.status).toBe(200);
    expect(reasonsAtAcknowledgement).toEqual(["delivery-discarded"]);
    expect(journal.unprojectedTerminalOperationIds()).toEqual([]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    registry.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("discard wins after a queue read and fences dispatch and late acknowledgement", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-cancel-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true, now: () => now });
  const healthEntered = barrier();
  const healthReleased = barrier();
  const host = new FakeEngineHost();
  const health = host.health.bind(host);
  host.health = async () => { healthEntered.release(); await healthReleased.promise; return health(); };
  seed(journal);
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
    transition: async (...args) => { journal.transitionOperation(...args); },
    status: async id => journal.operationResult(id)?.receipt ?? null,
  }, () => host);
  const draining = queue.drain();
  try {
    await healthEntered.promise;
    expect(journal.claimDeliveryAction(operationId, "discard").winner).toBe("discard");
    const committed = journal.operationResult(operationId);
    expect(journal.claimDeliveryAction(operationId, "discard")).toMatchObject({ winner: "discard", replayed: true });
    expect(journal.operationResult(operationId)).toEqual(committed);
    healthReleased.release();
    await draining;
    expect(host.ledger.writes).toEqual([]);
    expect(() => journal.transitionOperation(operationId, "delivered", { turnId: "late-turn" })).toThrow();
    expect(journal.operationResult(operationId)?.receipt).toMatchObject({ status: "failed", reason: "delivery-discarded" });
    expect(journal.effectBatch()).toEqual([]);
  } finally {
    healthReleased.release();
    await draining.catch(() => {});
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a refused discard commit rolls back its action, receipt and effect together", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-rollback-"));
  const filename = path.join(directory, "runtime.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
  const db = new Database(filename);
  try {
    seed(journal);
    db.exec("CREATE TRIGGER refuse_terminal_receipt BEFORE UPDATE OF receipt_json ON operations BEGIN SELECT RAISE(ABORT, 'fixture commit refused'); END");
    expect(() => journal.claimDeliveryAction(operationId, "discard")).toThrow("fixture commit refused");
    expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
    expect(journal.effectBatch()).toHaveLength(1);
    expect(db.query("SELECT count(*) AS n FROM delivery_operation_actions").get()).toEqual({ n: 0 });
    db.exec("DROP TRIGGER refuse_terminal_receipt");
    expect(journal.claimDeliveryAction(operationId, "discard").winner).toBe("discard");
    expect(journal.operationResult(operationId)?.receipt.reason).toBe("delivery-discarded");
    expect(journal.effectBatch()).toEqual([]);
  } finally { db.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("replaying an older claim-only discard repairs its receipt before answering retry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-legacy-"));
  const filename = path.join(directory, "runtime.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
  const db = new Database(filename);
  try {
    seed(journal);
    db.query("INSERT INTO delivery_operation_actions(operation_id, winner, claimed_at) VALUES (?, 'discard', ?)").run(operationId, now);
    expect(journal.claimDeliveryAction(operationId, "retry")).toMatchObject({ winner: "discard", replayed: true });
    expect(journal.operationResult(operationId)?.receipt).toMatchObject({ status: "failed", reason: "delivery-discarded" });
    expect(journal.effectBatch()).toEqual([]);
  } finally { db.close(); journal.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a handover that wins before cancel records its late acknowledgement once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-ack-"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true, now: () => now });
  const entered = barrier();
  const acknowledged = barrier();
  const host = new FakeEngineHost();
  const send = host.send.bind(host);
  host.send = async entry => { const receipt = await send(entry); entered.release(); await acknowledged.promise; return receipt; };
  seed(journal);
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
    transition: async (...args) => { journal.transitionOperation(...args); },
    status: async id => journal.operationResult(id)?.receipt ?? null,
  }, () => host);
  const draining = queue.drain();
  try {
    await entered.promise;
    expect(() => journal.claimDeliveryAction(operationId, "discard")).toThrow(/cannot discard/);
    expect(() => journal.transitionOperation(operationId, "failed", { reason: "delivery-discarded" },
      { fromStatuses: ["pending", "queued", "uncertain"] })).toThrow();
    acknowledged.release();
    await draining;
    await queue.drain();
    expect(host.ledger.writes).toHaveLength(1);
    expect(journal.operationResult(operationId)?.receipt).toMatchObject({ status: "delivered", turnId: `turn:${operationId}` });
    expect(journal.effectBatch()).toEqual([]);
  } finally {
    acknowledged.release();
    await draining.catch(() => {});
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("process restart after the discard claim retains the terminal outcome before projection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-restart-"));
  const filename = path.join(directory, "runtime.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off", now: () => now });
  const conversation = registry.ensureConversation("codex", path.join(directory, "recipient.jsonl"), null);
  const delivery = registry.holdDelivery(conversation.id, "deliver once", "terminalization-key", "text", [], null,
    { operationId, kind: "send", policy: "queue" });
  registry.beginDeliveryAttempt(delivery.id, delivery.generationId!);
  registry.close();
  seed(journal, conversation.id);
  journal.transitionOperation(operationId, "delivering");
  journal.transitionOperation(operationId, "uncertain");
  journal.close();
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/deliveryTerminalization.ts"), mode, filename], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    try {
      expect(await child.exited).toBe(0);
      expect(await errors).toBe("");
      return JSON.parse(await output);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  };
  try {
    expect(await run("claim")).toMatchObject({ winner: "discard" });
    for (let recovery = 0; recovery < 2; recovery++) expect(await run("recover")).toMatchObject({
      receipt: { status: "failed", reason: "delivery-discarded" }, writes: 0, effects: 0,
      projected: { state: "failed", reason: "delivery-discarded", duplicateRisk: true, resend: "verify-first" },
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test.each(["{broken", "null", "[]", "sqlite-page"])("corrupt queue data (%s) crosses the real socket as terminal data corruption with no startup retry", async corruption => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-corrupt-"));
  const filename = path.join(directory, "runtime.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
  seed(journal);
  const db = new Database(filename);
  let damagedPage: { pageSize: number; rootPage: number } | null = null;
  if (corruption === "sqlite-page") {
    const { page_size: pageSize } = db.query("PRAGMA page_size").get() as { page_size: number };
    const { rootpage: rootPage } = db.query("SELECT rootpage FROM sqlite_master WHERE name = 'outbox'").get() as { rootpage: number };
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    damagedPage = { pageSize, rootPage };
  } else db.query("UPDATE outbox SET payload_json = ? WHERE id = ?").run(corruption, `effect:${operationId}`);
  db.close();
  if (damagedPage) {
    // Damage the isolated table's actual b-tree page, then advance the file's
    // change counter so the live journal connection discards its cached page.
    const bytes = fs.readFileSync(filename);
    bytes.fill(0, (damagedPage.rootPage - 1) * damagedPage.pageSize, damagedPage.rootPage * damagedPage.pageSize);
    bytes.writeUInt32BE((bytes.readUInt32BE(24) + 1) >>> 0, 24);
    fs.writeFileSync(filename, bytes);
  }
  const server = serveRuntimeHost(testEndpoint(directory, "corrupt"), new RuntimeHost(journal));
  const client = new UnixRuntimeHostClient(testEndpoint(directory, "corrupt"));
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const logs: unknown[][] = [];
  const retries: number[] = [];
  try {
    let failure: unknown;
    try { await client.effectBatch(); } catch (error) { failure = error; }
    expect(classifyStructuredHostStartupError(failure)).toMatchObject({ disposition: "terminal", category: "data-corruption" });
    await expect(runStructuredHostStartup(() => client.effectBatch(), (...args) => logs.push(args), {
      schedule: (_callback, delay) => { retries.push(delay); return { unref() {} } as ReturnType<typeof setTimeout>; },
    })).rejects.toThrow();
    expect(retries).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[1]).toMatchObject({ category: "data-corruption", action: expect.stringContaining("state data") });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a real socket outage remains recoverable and schedules one startup retry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-outage-"));
  const retries: number[] = [];
  const logs: unknown[][] = [];
  const client = new UnixRuntimeHostClient(testEndpoint(directory, "absent"));
  try {
    await runStructuredHostStartup(() => client.effectBatch(), (...args) => logs.push(args), {
      jitterRatio: 0,
      schedule: (_callback, delay) => { retries.push(delay); return { unref() {} } as ReturnType<typeof setTimeout>; },
    });
    expect(retries).toEqual([5_000]);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[1]).toMatchObject({ category: "runtime-host-unavailable" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
