import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncResource } from "node:async_hooks";
import { Database } from "bun:sqlite";
import { RuntimeJournal } from "@/runtime-host/journal";
import { OperationLease } from "@/lib/operationLease";
import { DeliveryProgressStore, readDeliveryProgress } from "./deliveryProgress";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { FakeEngineHost } from "./fixtures/fakeEngineHost";

test("a failed progress commit retries once while durable delivery and a restarted executor dispatch once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "progress-delivery-failure-"));
  const filename = path.join(directory, "progress.sqlite");
  const journalPath = path.join(directory, "journal.sqlite");
  let now = Date.parse("2026-11-17T06:00:00Z");
  const callbacks: Array<() => void> = [];
  const store = new DeliveryProgressStore(filename, () => now, callback => {
    callbacks.push(AsyncResource.bind(callback));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  const journal = new RuntimeJournal(journalPath, { structuredHosts: true });
  const host = new FakeEngineHost();
  let dispatches = 0;
  const send = host.send.bind(host);
  host.send = async entry => { dispatches++; return send(entry); };
  const queue = new StructuredDeliveryQueue({
    progress: store,
    async effects(kinds, after) { return journal.effectBatch(100, kinds, after); },
    async status(id) { return journal.operationResult(id)?.receipt ?? null; },
    async transition(...args) { journal.transitionOperation(...args); },
  }, () => host);
  let retries = 0;
  const holder = new Database(filename, { create: true });
  try {
    store.note("seed", "conversation", { waitReason: "queued" });
    store.flush();
    callbacks.length = 0;
    now += 11 * 60_000;
    holder.exec("BEGIN IMMEDIATE");
    const lease = new OperationLease();
    journal.append({ scope: { type: "session", id: "conversation" }, kind: "session-status", payload: {
      conversationId: "conversation", sessionKey: { engine: "codex", sessionId: "fake-session" },
      hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null, provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    } });
    journal.executeOperation({ kind: "send", conversationId: "conversation", operationId: "original-operation",
      idempotencyKey: "original-key", text: "fixture input", policy: "queue" });
    lease.run(() => store.note("original-operation", "conversation", { waitReason: "queued", originalKey: "original-key" }));
    await queue.drain();
    // One actual SQLite refusal, after the engine effect and journal ending.
    expect(store.flush()).toBe(false);
    callbacks.length = 0;
    expect(journal.operationResult("original-operation")?.receipt.status).toBe("delivered");
    expect(readDeliveryProgress(["original-operation"], filename).size).toBe(0);
    expect(host.ledger.writes).toHaveLength(1);
    expect(dispatches).toBe(1);
    lease.expire();
    holder.exec("ROLLBACK");
    // Exercise the accepted retry under the caller context that has expired.
    lease.run(() => { retries++; expect(store.flush()).toBe(true); });
    expect(retries).toBe(1);
    expect(readDeliveryProgress(["original-operation"], filename).get("original-operation")?.terminal?.state).toBe("delivered");
    await queue.drain();
    expect(host.ledger.writes).toHaveLength(1);
    expect(dispatches).toBe(1);
    store.close();
    journal.close();
    const code = `
      import { RuntimeJournal } from ${JSON.stringify(new URL("../../runtime-host/journal.ts", import.meta.url).pathname)};
      import { StructuredDeliveryQueue } from ${JSON.stringify(new URL("./structuredDeliveryQueue.ts", import.meta.url).pathname)};
      import { DeliveryProgressStore } from ${JSON.stringify(new URL("./deliveryProgress.ts", import.meta.url).pathname)};
      import { FakeEngineHost } from ${JSON.stringify(new URL("./fixtures/fakeEngineHost.ts", import.meta.url).pathname)};
      const journal = new RuntimeJournal(process.argv[1], { structuredHosts: true });
      const progress = new DeliveryProgressStore(process.argv[2]);
      const host = new FakeEngineHost();
      const queue = new StructuredDeliveryQueue({ progress,
        async effects(kinds, after) { return journal.effectBatch(100, kinds, after); },
        async status(id) { return journal.operationResult(id)?.receipt ?? null; },
        async transition(...args) { journal.transitionOperation(...args); }
      }, () => host);
      await queue.drain();
      console.log(JSON.stringify({ writes: host.ledger.writes.length, record: progress.get("original-operation") }));
      queue.retire(); progress.close(); journal.close();
    `;
    const child = Bun.spawn([process.execPath, "--eval", code, journalPath, filename], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ error, exit }).toEqual({ error: "", exit: 0 });
    expect(JSON.parse(output)).toMatchObject({ writes: 0, record: { originalKey: "original-key", terminal: { state: "delivered" } } });
  } finally {
    queue.retire();
    try { holder.exec("ROLLBACK"); } catch { /* already released */ }
    holder.close(); store.close(); journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
