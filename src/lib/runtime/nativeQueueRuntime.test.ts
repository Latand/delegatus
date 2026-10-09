import { expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { RuntimeJournal } from "@/runtime-host/journal";
import { AgentRegistry } from "@/lib/agent/registry";
import { NativeCodexQueue, NativeQueueProtocolRefusal, type NativeQueuedSubmission } from "./nativeCodexQueue";
import { NativeQueueExecutor } from "./nativeQueueExecutor";
import type { EngineHost } from "./engineHost";
import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import type { NativeQueueCommand, NativeQueueProof, NativeQueueRecord } from "./nativeQueueContracts";
import { parseRuntimeCommand } from "./commands";
import { handleNativeQueue } from "./nativeQueueHttp";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { activeDrain, drainFile, releaseDrain, writeDrain } from "@/lib/selfUpdate/drain";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

const conversationId = "conversation_native";
const binding = { threadId: "thread-native", accountId: "account-a" };
function makeJournal(filename = ":memory:") {
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: binding.threadId }, hostKind: "codex-app-server",
    host: "hosted", turn: "running", activeTurnId: "active-a", accountId: binding.accountId,
    capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
  } });
  return journal;
}
function command(id: string, extra: Partial<NativeQueueCommand> = {}): NativeQueueCommand & { operationId: string } {
  return parseRuntimeCommand("native-queue", { kind: "native-queue", conversationId, operationId: id,
    idempotencyKey: id, action: "add", text: "queued text", binding, ...extra }) as NativeQueueCommand & { operationId: string };
}
function fixture(journal = makeJournal()) {
  let active: string | null = "active-a";
  let liveBinding = binding;
  let next = 0;
  const calls: string[] = [];
  const startedSubmissionIds: Array<string | null> = [];
  let items: NativeQueuedSubmission[] = [];
  let loseAdd = false;
  let raceDelete = false;
  let refuseDelete = false;
  let refuseUpdate = false;
  let proof: NativeQueueProof | null = null;
  const queue = new NativeCodexQueue({ rpc: async (method, params) => {
    calls.push(method);
    if (method === "thread/queue/list") return { data: items, nextCursor: null };
    if (method === "thread/queue/add") {
      const queuedSubmission = { id: `native-${++next}`, clientUserMessageId: params.clientUserMessageId as string, input: params.input as NativeQueuedSubmission["input"] };
      items.push(queuedSubmission);
      if (loseAdd) throw new Error("lost add reply");
      return { queuedSubmission };
    }
    if (method === "thread/queue/update") {
      if (refuseUpdate) throw new NativeQueueProtocolRefusal(-1, "native refused this edit");
      const item = items.find(i => i.id === params.queuedSubmissionId)!;
      item.input = params.input as NativeQueuedSubmission["input"];
      return { queuedSubmission: item };
    }
    if (method === "thread/queue/delete") {
      if (refuseDelete) return { deleted: false };
      items = items.filter(i => i.id !== params.queuedSubmissionId);
      if (raceDelete) active = "active-b";
      return { deleted: true };
    }
    if (method === "thread/queue/reorder") return {};
    if (method === "thread/queue/start") {
      /* Native's own queue-level start: `queuedSubmissionId` is nullable, and an
         entry-less start dispatches the head of the queue. */
      startedSubmissionIds.push((params.queuedSubmissionId ?? null) as string | null);
      return { turn: { id: "started", items: [], status: "inProgress" } };
    }
    throw new Error("unexpected method");
  } }, binding.threadId);
  const client = {
    command: async (c: NativeQueueCommand) => journal.executeOperation(c),
    operationStatus: async (id: string) => journal.operationResult(id),
    nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
    nativeQueueTransition: async (id: string, t: Parameters<RuntimeJournal["nativeQueueTransition"]>[1]) => journal.nativeQueueTransition(id, t),
  } as RuntimeHostClient;
  const host = {
    health: async () => ({ status: active ? "active" : "idle", activeTurnRef: active }),
    nativeQueue: {
      queue,
      prepare: async (_entry: NativeQueueRecord, v: NativeQueueRecord["versions"][number]) => [{ type: "text" as const, text: `${v.text} version=${v.revision}` }],
      evidence: async () => proof,
      sendWithdrawn: async (_entry: NativeQueueRecord, expected: string | null) => {
        if (active !== expected) throw new NativeQueueProtocolRefusal(-1, "stale-turn");
        calls.push(expected ? "turn/steer" : "turn/start");
        return { turnId: expected ?? "started" };
      },
    },
  } as unknown as EngineHost;
  const executor = new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => liveBinding });
  return { journal, client, executor, host, calls, queue, startedSubmissionIds, get items() { return items; },
    loseAdd: () => { loseAdd = true; }, race: () => { raceDelete = true; }, refuseDelete: () => { refuseDelete = true; },
    refuseUpdate: (value = true) => { refuseUpdate = value; },
    /* The host goes idle AND the journal's session projection says so: the
       admission fence reads the projection, the executor reads the host. */
    idle: () => {
      active = null;
      journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
        conversationId, sessionKey: { engine: "codex", sessionId: binding.threadId }, hostKind: "codex-app-server",
        host: "hosted", turn: "idle", activeTurnId: null, accountId: binding.accountId,
        capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
      } });
    },
    switchAccount: () => { liveBinding = { ...binding, accountId: "account-b" }; },
    prove: () => {
      const entry = journal.nativeQueueRead(conversationId)[0]!;
      proof = { threadId: binding.threadId, clientUserMessageId: entry.clientUserMessageId, revision: entry.revision,
        turnId: "canonical-turn", itemId: "canonical-item", input: entry.versions.at(-1)!.input! };
    } };
}

test("native add keeps Viewer/client/native IDs distinct; duplicate Viewer admission never adds twice", async () => {
  const f = fixture();
  const c = command("op-add");
  f.journal.executeOperation(c);
  await f.executor.execute(c);
  expect(f.journal.executeOperation(c).replayed).toBeTrue();
  await f.executor.execute(c);
  const entry = f.journal.nativeQueueRead(conversationId)[0]!;
  expect(entry).toMatchObject({ entryId: "op-add", clientUserMessageId: "op-add", nativeSubmissionId: "native-1", state: "queued", proof: null });
  expect(f.calls.filter(c => c.endsWith("/add"))).toHaveLength(1);
  expect(f.journal.operationResult("op-add")?.receipt.status).toBe("applied");
  f.journal.close();
});

test("lost add reply survives restart and account change without a second native mutation", async () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nq-")), "journal.sqlite");
  const f = fixture(makeJournal(filename));
  const c = command("op-lost"); f.loseAdd();
  f.journal.executeOperation(c); await f.executor.execute(c);
  expect(f.items).toHaveLength(1);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("uncertain");
  f.journal.close();
  const next = fixture(new RuntimeJournal(filename, { structuredHosts: true })); next.switchAccount();
  await next.executor.execute(c); await next.executor.reconcile(conversationId);
  expect(next.calls).toEqual([]);
  expect(next.journal.nativeQueueRead(conversationId)[0]?.mutationOperationId).toBe(c.operationId);
  expect(() => next.journal.retryOperation(c.operationId)).toThrow("does not support retry");
  next.journal.close();
});

test("edited native entry retains both payload versions; only canonical changed payload proves delivery", async () => {
  const f = fixture(); const add = command("op-version");
  f.journal.executeOperation(add); await f.executor.execute(add);
  const edit = command("op-edit", { action: "update", entryId: add.operationId, expectedRevision: 1, text: "changed", runtime: { model: "requested-model" } });
  f.journal.executeOperation(edit); await f.executor.execute(edit);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.versions.map(v => v.text)).toEqual(["queued text", "changed"]);
  await f.executor.reconcile(conversationId);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("queued");
  f.prove(); await f.executor.reconcile(conversationId);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "delivered", dispatchedRevision: 2 });
  expect(f.journal.operationResult(add.operationId)?.receipt).toMatchObject({ text: "changed", nativeQueue: { entryId: add.operationId, dispatchedRevision: 2 } });
  expect(() => f.journal.executeOperation(command("edit-after-dispatch", { action: "update", entryId: add.operationId, expectedRevision: 2 }))).toThrow("frozen or unresolved");
  f.journal.close();
});

test("queued Send now withdraws before steer, and a turn boundary sends zero duplicate instructions", async () => {
  for (const race of [false, true]) {
    const f = fixture(); const add = command("op-send-now"); f.journal.executeOperation(add); await f.executor.execute(add);
    if (race) f.race();
    const send = command("op-control", { action: "send-now", entryId: add.operationId, expectedRevision: 1, turnId: "active-a" });
    f.journal.executeOperation(send); await f.executor.execute(send);
    expect(f.calls).toEqual(race ? ["thread/queue/add", "thread/queue/delete"] : ["thread/queue/add", "thread/queue/delete", "turn/steer"]);
    expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe(race ? "withdrawn" : "dispatching");
    expect(f.journal.nativeQueueRead(conversationId)[0]?.versions[0]?.text).toBe("queued text");
    f.journal.close();
  }
});

test("queue disappearance or deleted=false never authorizes steering or delivery", async () => {
  const f = fixture(); const add = command("op-missing"); f.journal.executeOperation(add); await f.executor.execute(add); f.refuseDelete();
  const send = command("op-no-withdrawal", { action: "send-now", entryId: add.operationId, expectedRevision: 1, turnId: "active-a" });
  f.journal.executeOperation(send); await f.executor.execute(send);
  expect(f.calls).toEqual(["thread/queue/add", "thread/queue/delete"]);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "uncertain", proof: null });
  f.journal.close();
});

test("queue HTTP admits immediately on the populated fixture without waiting for native dispatch", async () => {
  const f = fixture();
  for (let i = 0; i < 128; i++) f.journal.append({ scope: `session:board-${i}`, kind: "session-status", payload: { host: "hosted", turn: "idle" } });
  let kicks = 0;
  const response = await handleNativeQueue(new NextRequest("http://localhost/api/runtime/queue", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify(command("op-http")) }), { client: () => f.client, enabled: () => true, kick: () => { kicks++; }, admitImages: () => ({ images: [], error: null }), storeImages: () => [] });
  // Admitted and kicked, with not one native call made on the way to the answer.
  expect(response.status).toBe(202); expect(kicks).toBe(1); expect(f.calls).toEqual([]);
  const body = await response.json(); expect(body.receipt.status).toBe("queued");
  f.journal.close();
});

test("a queued message is the operator's only from a Viewer page; a script's is an API client's", async () => {
  const f = fixture();
  const post = (id: string, headers: Record<string, string>) => handleNativeQueue(new NextRequest("http://localhost/api/runtime/queue", {
    method: "POST", headers: { host: "localhost", ...headers }, body: JSON.stringify(command(id)),
  }), { client: () => f.client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [] });
  expect((await post("op-page", { "sec-fetch-site": "same-origin" })).status).toBe(202);
  /* A script sends no fetch metadata, whatever token it holds. */
  expect((await post("op-script", {})).status).toBe(202);
  const origins = Object.fromEntries(f.journal.nativeQueueRead(conversationId).map((entry) => [entry.entryId, entry.versions[0]!.origin]));
  expect(origins).toEqual({ "op-page": { kind: "operator" }, "op-script": { kind: "agent", role: "api-client" } });
  f.journal.close();
});

test("the queue read answers the journal's entries beside Codex's own snapshot", async () => {
  /* What the panel reads. Both halves are needed and neither substitutes for the
     other: the journal knows about a mutation the queue has not acknowledged,
     and only the queue knows the order. */
  const f = fixture();
  const add = command("op-read");
  f.journal.executeOperation(add);
  await f.executor.execute(add);
  const response = await handleNativeQueue(
    new NextRequest(`http://localhost/api/runtime/queue?conversationId=${conversationId}`, { headers: { host: "localhost" } }),
    {
      client: () => f.client, enabled: () => true, kick: () => {},
      admitImages: () => ({ images: [], error: null }), storeImages: () => [],
      /* The production reader refreshes and falls back to the cached read; a
         cached read alone has never completed a list pass and answers null. */
      nativeSnapshot: async () => f.queue.refresh(),
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries.map((entry: { entryId: string }) => entry.entryId)).toEqual(["op-read"]);
  expect(body.native.items.map((item: { clientUserMessageId: string }) => item.clientUserMessageId))
    .toEqual([body.entries[0].clientUserMessageId]);
  f.journal.close();
});

test("a queue read that cannot see Codex still answers the journal, marked stale", async () => {
  /* A failed native read must not empty the panel: what the Viewer admitted is
     still true, and the snapshot says its order is the last one seen. */
  const f = fixture();
  const add = command("op-stale");
  f.journal.executeOperation(add);
  await f.executor.execute(add);
  const response = await handleNativeQueue(
    new NextRequest(`http://localhost/api/runtime/queue?conversationId=${conversationId}`, { headers: { host: "localhost" } }),
    {
      client: () => f.client, enabled: () => true, kick: () => {},
      admitImages: () => ({ images: [], error: null }), storeImages: () => [],
      nativeSnapshot: async () => ({ threadId: binding.threadId, items: null, stale: true }),
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries).toHaveLength(1);
  expect(body.native).toMatchObject({ stale: true, items: null });
  f.journal.close();
});

test("a queue read refuses an identity that is not a conversation", async () => {
  const f = fixture();
  const response = await handleNativeQueue(
    new NextRequest("http://localhost/api/runtime/queue?conversationId=../etc", { headers: { host: "localhost" } }),
    { client: () => f.client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [] },
  );
  expect(response.status).toBe(400);
  f.journal.close();
});

test("a queued message carries attachment bytes the same way an ordinary send does", async () => {
  /* #1629: the composer stages attachments as bytes. The queue route admits and
     content-addresses them here, so the command itself carries refs — the same
     road `/api/runtime/send` takes, and the reason the command's own size ceiling
     bounds the command rather than the attachment. */
  const f = fixture();
  const stored: unknown[] = [];
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const response = await handleNativeQueue(
    new NextRequest("http://localhost/api/runtime/queue", {
      method: "POST", headers: { host: "localhost" },
      body: JSON.stringify({
        kind: "native-queue", conversationId, operationId: "op-image", idempotencyKey: "op-image",
        action: "add", text: "look at this", binding,
        images: [{ base64: png, mime: "image/png" }],
      }),
    }),
    {
      client: () => f.client, enabled: () => true, kick: () => {},
      admitImages: (images) => ({ images: images as never[], error: null }),
      storeImages: (uploads) => {
        stored.push(...uploads);
        return [{ sha256: "a".repeat(64), mime: "image/png", bytes: 16 }];
      },
    },
  );
  expect(response.status).toBe(202);
  expect(stored).toHaveLength(1);
  const admitted = f.journal.nativeQueueRead(conversationId).find(entry => entry.entryId === "op-image");
  expect(admitted?.versions[0]?.images).toEqual([{ sha256: "a".repeat(64), mime: "image/png", bytes: 16 }]);
  f.journal.close();
});

test("a refused attachment refuses the whole queue admission, with the reason", async () => {
  const f = fixture();
  const response = await handleNativeQueue(
    new NextRequest("http://localhost/api/runtime/queue", {
      method: "POST", headers: { host: "localhost" },
      body: JSON.stringify({
        kind: "native-queue", conversationId, operationId: "op-bad-image", idempotencyKey: "op-bad-image",
        action: "add", text: "look at this", binding, images: [{ base64: "!!!", mime: "image/png" }],
      }),
    }),
    {
      client: () => f.client, enabled: () => true, kick: () => {},
      admitImages: () => ({ images: [], error: { error: "runtime image base64 is invalid", status: 400 } }),
      storeImages: () => [],
    },
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("base64 is invalid");
  expect(f.journal.nativeQueueRead(conversationId)).toEqual([]);
  f.journal.close();
});

test("native parser preserves null fence and nullable tier fields, rejects missing fences and duplicate reorder IDs", () => {
  expect(command("op-settings", { runtime: { serviceTier: null, serviceTierForTurn: "priority" } }).runtime).toEqual({ serviceTier: null, serviceTierForTurn: "priority" });
  expect(() => command("op-no-fence", { action: "send-now", entryId: "root", expectedRevision: 1 })).toThrow("fence");
  expect(() => command("op-order", { action: "reorder", queuedSubmissionIds: ["same", "same"] })).toThrow("queuedSubmissionIds");
});

test("ordinary explicit Codex queue send transfers dispatch to native and retains its original receipt", async () => {
  const f = fixture();
  const send = parseRuntimeCommand("send", { conversationId, operationId: "ordinary-queue", idempotencyKey: "ordinary-key", text: "native owned", policy: "queue" });
  const admitted = f.journal.executeOperation(send);
  expect(admitted.receipt).toMatchObject({ kind: "send", status: "queued" });
  const effect = f.journal.effectBatch(100).find(e => e.kind === "runtime.native-queue")!;
  expect(effect).toBeTruthy();
  expect(f.journal.effectBatch(100).some(e => e.kind === "runtime.send")).toBeFalse();
  await f.executor.execute(effect.payload as unknown as NativeQueueCommand & { operationId: string });
  expect(f.journal.operationResult(admitted.operationId)?.receipt.status).toBe("queued");
  expect(f.journal.effectBatch(100)).toHaveLength(0);
  expect(() => f.journal.retryOperation(admitted.operationId)).toThrow("native queue");
  f.prove(); await f.executor.reconcile(conversationId);
  expect(f.journal.operationResult(admitted.operationId)?.receipt.status).toBe("delivered");
  expect(f.calls.filter(c => c.endsWith("/add"))).toHaveLength(1);
  f.journal.close();
});

test("two executors competing for the same admitted native add perform one write", async () => {
  const f = fixture(); const add = command("op-concurrent"); f.journal.executeOperation(add);
  await Promise.all([f.executor.execute(add), f.executor.execute(add)]);
  expect(f.calls.filter(c => c.endsWith("/add"))).toHaveLength(1);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("queued");
  f.journal.close();
});

test("two executors rebinding an unsubmitted add to a successor perform one native write", async () => {
  const f = fixture();
  const add = command("op-successor-race");
  const successor = { threadId: "successor-thread", accountId: "account-b" };
  f.journal.executeOperation(add);
  const writes: string[] = [];
  const host = { ...f.host, nativeQueue: { ...f.host.nativeQueue!, queue: new NativeCodexQueue({ rpc: async (_method, params) => {
    writes.push(params.clientUserMessageId as string);
    return { queuedSubmission: { id: "successor-submission", clientUserMessageId: params.clientUserMessageId, input: params.input } };
  } }, successor.threadId) } };
  const port = { client: f.client, resolveHost: () => host, binding: () => successor,
    succession: () => ({ status: "committed" as const, binding: successor }) };
  try {
    await Promise.all([new NativeQueueExecutor(port).execute(add), new NativeQueueExecutor(port).execute(add)]);
    expect(writes).toEqual([add.operationId]);
    expect(f.journal.operationResult(add.operationId)?.receipt.status).toBe("applied");
    expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "queued", binding: successor });
  } finally { f.journal.close(); }
});

test("prepared successor binding survives journal reopening with original admission identity and successor proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-rebind-"));
  const filename = path.join(root, "journal.sqlite");
  let journal = makeJournal(filename);
  const add = command("op-rebound");
  const successor = { threadId: "successor-thread", accountId: "account-b" };
  const input = [{ type: "text" as const, text: add.text! }];
  try {
    journal.executeOperation(add);
    journal.nativeQueueTransition(add.operationId, { phase: "prepared", input, binding: successor });
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true });
    expect(journal.executeOperation(add)).toMatchObject({ replayed: true, receipt: { status: "delivering" } });
    journal.nativeQueueTransition(add.operationId, { phase: "acknowledged", nativeSubmissionId: "successor-submission" });
    const proof = { threadId: successor.threadId, clientUserMessageId: add.operationId, revision: 1, turnId: "turn", itemId: "item", input };
    expect(() => journal.nativeQueueTransition(add.operationId, { phase: "proven", proof: { ...proof, threadId: binding.threadId } })).toThrow("canonical proof mismatch");
    journal.nativeQueueTransition(add.operationId, { phase: "proven", proof });
    expect(journal.nativeQueueRead(conversationId)[0]).toMatchObject({ binding: successor, state: "delivered", proof });
    expect(journal.operationResult(add.operationId)?.receipt.status).toBe("delivered");
  } finally { journal.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a prepared native add cannot be rebound or replayed on a successor", () => {
  const f = fixture();
  const add = command("op-frozen-owner");
  const input = [{ type: "text" as const, text: add.text! }];
  try {
    f.journal.executeOperation(add);
    f.journal.nativeQueueTransition(add.operationId, { phase: "prepared", input });
    expect(() => f.journal.nativeQueueTransition(add.operationId, { phase: "prepared", input,
      binding: { threadId: "successor-thread", accountId: "account-b" } })).toThrow("submitted input cannot change ownership");
    expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ binding, mutationOperationId: add.operationId });
    expect(f.journal.operationResult(add.operationId)?.receipt.status).toBe("delivering");
    expect(f.calls).toEqual([]);
  } finally { f.journal.close(); }
});

test("native canonical proof must retain original client, version, content and thread", async () => {
  const f = fixture(); const add = command("op-proof"); f.journal.executeOperation(add); await f.executor.execute(add);
  const entry = f.journal.nativeQueueRead(conversationId)[0]!;
  const proof: NativeQueueProof = { threadId: binding.threadId, clientUserMessageId: entry.clientUserMessageId, revision: 1,
    turnId: "turn", itemId: "item", input: entry.versions[0]!.input! };
  for (const changed of [{ ...proof, threadId: "wrong" }, { ...proof, clientUserMessageId: "wrong" }, { ...proof, revision: 2 }, { ...proof, input: [{ type: "text" as const, text: "wrong" }] }]) {
    expect(() => f.journal.nativeQueueTransition(add.operationId, { phase: "proven", proof: changed })).toThrow("canonical proof mismatch");
    expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("queued");
  }
  f.journal.close();
});

test("an account change before dispatch refuses the new write and keeps payload versions", async () => {
  const f = fixture(); const add = command("op-account"); f.journal.executeOperation(add); f.switchAccount();
  await f.executor.execute(add);
  expect(f.calls).toEqual([]);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "refused", versions: [{ text: "queued text" }] });
  f.journal.close();
});

test("positive native deletion cancels the original entry receipt while retaining payload history", async () => {
  const f = fixture(); const add = command("op-remove"); f.journal.executeOperation(add); await f.executor.execute(add);
  const remove = command("op-delete", { action: "delete", entryId: add.operationId, expectedRevision: 1 });
  f.journal.executeOperation(remove); await f.executor.execute(remove); await f.executor.reconcile(conversationId);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "removed", proof: null, versions: [{ text: "queued text" }] });
  expect(f.journal.operationResult(add.operationId)?.receipt).toMatchObject({ status: "failed", reason: "delivery-discarded" });
  f.journal.close();
});

test("a unique live queue observation recovers a lost add acknowledgement without claiming delivery or retrying", async () => {
  const f = fixture(); f.loseAdd(); const add = command("op-observed");
  f.journal.executeOperation(add); await f.executor.execute(add);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("uncertain");
  await f.executor.reconcile(conversationId);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "queued", nativeSubmissionId: "native-1", mutationOperationId: null, proof: null });
  expect(f.journal.operationResult(add.operationId)?.receipt.status).toBe("applied");
  expect(f.calls.filter(c => c.endsWith("/add"))).toHaveLength(1);
  f.journal.close();
});

test("a named turn fence survives admission without being rebound to the active turn", () => {
  /* A fence the caller NAMED is honoured verbatim, and a stale one is refused
     before anything is admitted. */
  const journal = makeJournal();
  for (const kind of ["send", "steer", "interrupt"] as const) {
    const c = parseRuntimeCommand(kind, { conversationId, operationId: `${kind}-stale`, idempotencyKey: `${kind}-stale`, text: "fenced", turnId: "turn-that-ended" });
    expect(journal.executeOperation(c).receipt).toMatchObject({ status: "rejected", reason: "stale-turn" });
  }
  expect(journal.effectBatch(100)).toHaveLength(0);
  const matching = parseRuntimeCommand("steer", { conversationId, idempotencyKey: "matching", text: "fenced", turnId: "active-a" });
  expect(journal.executeOperation(matching).receipt.status).toBe("pending");
  expect(journal.effectBatch(100)[0]?.payload.turnId).toBe("active-a");
  journal.close();
});

test("an explicit null fence means idle for a native queue command, and no fence for an ordinary send", () => {
  /* THE TWO MEANINGS ARE NOT THE SAME AND THE SPLIT IS DELIBERATE. Native's
     queue controls take a turn fence whose explicit `null` is the protocol's own
     "only while idle" — `start` is refused without it. An ordinary send's
     `turnId: null` has always meant "no turn to fence against", which is exactly
     what a `policy: "queue"` send says: queue it, whatever is running. Reading
     the send's null as an idle fence rejected messages the Viewer has always
     delivered against a busy host. */
  const journal = makeJournal();
  const queued = parseRuntimeCommand("send", { conversationId, operationId: "send-null", idempotencyKey: "send-null", text: "queue me", policy: "queue", turnId: null });
  expect(journal.executeOperation(queued).receipt).toMatchObject({ status: "queued", reason: null });

  const idleStart = parseRuntimeCommand("native-queue", { conversationId, operationId: "start-null", idempotencyKey: "start-null", action: "start", binding, turnId: null });
  expect(journal.executeOperation(idleStart).receipt).toMatchObject({ status: "rejected", reason: "stale-turn" });
  journal.close();
});

test("native queue profile requests and image versions survive reopening without per-entry dispatch overrides", async () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nqp-")), "journal.sqlite");
  const f = fixture(makeJournal(filename));
  const images = [{ sha256: "a".repeat(64), mime: "image/png" as const, bytes: 8 }];
  const first = command("profile-one", { images, runtime: { model: "model-one", effort: "high", serviceTierForTurn: "priority" } });
  const second = command("profile-two", { runtime: { model: "model-two", effort: "low", serviceTier: null } });
  f.journal.executeOperation(first); await f.executor.execute(first);
  f.journal.executeOperation(second); await f.executor.execute(second);
  f.journal.close();
  const reopened = new RuntimeJournal(filename, { structuredHosts: true });
  const entries = reopened.nativeQueueRead(conversationId);
  expect(entries.map(e => e.profilePolicy)).toEqual(["thread-at-dispatch", "thread-at-dispatch"]);
  expect(entries.map(e => e.versions[0]?.requestedRuntime)).toEqual([first.runtime, second.runtime]);
  expect(entries[0]?.versions[0]?.images).toEqual(images);
  reopened.close();
});


test("unknown native queue capability cannot admit a second scheduler through ordinary queue policy", () => {
  const journal = makeJournal();
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    capabilities: { steer: true, structuredAttention: true, nativeQueue: false },
    diagnostics: { executable: "codex", version: "0.154.0", nativeQueue: false, queueCapability: "unknown", authRecovery: "unknown" },
  } });
  const c = parseRuntimeCommand("send", { conversationId, idempotencyKey: "unknown-capability", text: "queued", policy: "queue" });
  expect(journal.executeOperation(c).receipt).toMatchObject({ status: "rejected", reason: "native-queue-capability-unknown" });
  expect(journal.effectBatch(100)).toEqual([]);
  expect(journal.nativeQueueRead(conversationId)).toEqual([]);
  journal.close();
});

test("consecutive refused edits leave the entry on the last version native accepted", async () => {
  /* Every edit attempt appends a version, refused ones included, so counting
     back through `versions` to undo a refusal landed on the PREVIOUS REFUSAL the
     second time round. The entry then presented — and, on the next dispatch,
     would have sent — text native had already rejected. The command's own
     `expectedRevision` is the version it was a revision of, and the admission
     validated it against the entry, so that is what a refusal returns to. */
  const f = fixture();
  const add = command("op-refused-base");
  f.journal.executeOperation(add);
  await f.executor.execute(add);
  f.refuseUpdate();

  for (const attempt of ["op-refused-one", "op-refused-two"]) {
    const edit = command(attempt, { action: "update", entryId: add.operationId, expectedRevision: 1, text: attempt });
    f.journal.executeOperation(edit);
    await f.executor.execute(edit);
    const entry = f.journal.nativeQueueRead(conversationId)[0]!;
    expect(entry.revision).toBe(1);
    expect(entry.versions.find(version => version.revision === entry.revision)?.text).toBe("queued text");
    expect(entry.state).toBe("queued");
    expect(entry.mutationOperationId).toBeNull();
  }
  /* And what a dispatch would freeze is that same accepted version, never a
     refused one: the refused attempts survive as history and nothing else. */
  const entry = f.journal.nativeQueueRead(conversationId)[0]!;
  expect(entry.versions.map(version => version.text)).toEqual(["queued text", "op-refused-one", "op-refused-two"]);
  f.refuseUpdate(false);
  f.idle();
  const start = command("op-refused-dispatch", { action: "start", entryId: add.operationId, expectedRevision: 1, turnId: null });
  f.journal.executeOperation(start);
  await f.executor.execute(start);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ dispatchedRevision: 1, state: "dispatching" });
  f.journal.close();
});

test("the queue as a whole can be started, naming no entry at all", async () => {
  /* Native's `ThreadQueueStartParams.queuedSubmissionId` is nullable and its
     start with no submission dispatches the head of the queue. The panel header
     offers exactly that, and it used to be rejected at the parser with
     "entryId is invalid" — the one control on the panel that could never work. */
  const f = fixture();
  const add = command("op-queued-head");
  f.journal.executeOperation(add);
  await f.executor.execute(add);
  f.idle();

  const start = parseRuntimeCommand("native-queue", {
    conversationId, operationId: "op-queue-start", idempotencyKey: "op-queue-start",
    action: "start", binding, turnId: null,
  }) as NativeQueueCommand & { operationId: string };
  expect(start.entryId).toBeUndefined();
  expect(f.journal.executeOperation(start).receipt.status).toBe("queued");
  await f.executor.execute(start);

  expect(f.startedSubmissionIds).toEqual([null]);
  expect(f.journal.operationResult("op-queue-start")?.receipt.status).toBe("applied");
  /* It is a queue-level control, so it owns no entry and moves none. */
  expect(f.journal.nativeQueueRead(conversationId).map(entry => entry.state)).toEqual(["queued"]);
  f.journal.close();
});

test("a withdrawn payload goes back through an idle start, exactly once", async () => {
  /* Withdrawn is the payload that survived a send-now whose steer did not land:
     native no longer holds it and the Viewer still does. The journal admits only
     a `start` for it, so a panel that offered `send-now` offered the one action
     the journal always refused and the operator's words had no route back. */
  const f = fixture();
  const add = command("op-stranded");
  f.journal.executeOperation(add);
  await f.executor.execute(add);
  f.race();
  const steer = command("op-lost-steer", { action: "send-now", entryId: add.operationId, expectedRevision: 1, turnId: "active-a" });
  f.journal.executeOperation(steer);
  await f.executor.execute(steer);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "withdrawn", mutationOperationId: null });

  f.idle();
  /* The route the row used to offer, refused for exactly what it always refused
     — which is why the payload was stranded with no control that could move it. */
  expect(() => f.journal.executeOperation(command("op-wrong-route", {
    action: "send-now", entryId: add.operationId, expectedRevision: 1, turnId: null,
  }))).toThrow("withdrawn input requires an explicit idle start");

  const recover = command("op-recover", { action: "start", entryId: add.operationId, expectedRevision: 1, turnId: null });
  f.journal.executeOperation(recover);
  await f.executor.execute(recover);
  const recovered = f.journal.nativeQueueRead(conversationId)[0]!;
  expect(recovered).toMatchObject({ state: "dispatching", dispatchedRevision: 1, dispatchedTurnId: "started" });
  expect(recovered.versions[0]?.text).toBe("queued text");
  expect(f.calls.at(-1)).toBe("turn/start");

  /* And a second press is refused: the payload became a turn, and a turn's
     payload is not sent again by anything. */
  expect(() => f.journal.executeOperation(command("op-recover-again", {
    action: "start", entryId: add.operationId, expectedRevision: 1, turnId: null,
  }))).toThrow("frozen or unresolved");
  f.journal.close();
});

test("editing the words of a message keeps its attachments, its card and its authorship", async () => {
  /* An update replaces the version wholesale, so an edit that named no images
     admitted a revision with none: the operator saw a text edit and the pictures
     were gone, with nothing said. Attachments ride the command (their digest is
     computed over exactly what it carries); the card and the authorship are
     server-side provenance and are carried forward here. */
  const image = { sha256: "b".repeat(64), mime: "image/png" as const, bytes: 91 };
  const f = fixture();
  const add = command("op-with-image", {
    images: [image],
    selectedContext: { version: 1, state: "selected", conversationId: "conversation_card", capturedAt: "2026-09-10T00:00:00.000Z" },
    origin: { kind: "operator" },
  });
  f.journal.executeOperation(add);
  await f.executor.execute(add);
  const admitted = f.journal.nativeQueueRead(conversationId)[0]!.versions[0]!;
  expect(admitted.images).toEqual([image]);
  expect(admitted.selectedContext).toMatchObject({ conversationId: "conversation_card" });

  const edit = command("op-image-edit", {
    action: "update", entryId: add.operationId, expectedRevision: 1, text: "changed words", images: [image],
  });
  f.journal.executeOperation(edit);
  await f.executor.execute(edit);
  const entry = f.journal.nativeQueueRead(conversationId)[0]!;
  const latest = entry.versions.find(version => version.revision === entry.revision)!;
  expect(latest.text).toBe("changed words");
  expect(latest.images).toEqual([image]);
  expect(latest.contentDigest).not.toBe(admitted.contentDigest);
  expect(latest.selectedContext).toMatchObject({ conversationId: "conversation_card" });
  expect(admitted.origin).toEqual({ kind: "operator" });
  expect(latest.origin).toEqual({ kind: "operator" });

  /* And an edit that would drop them is refused rather than admitted: the
     command's digest describes what the command carries, so the journal cannot
     substitute the prior version's refs without describing something else. */
  expect(() => f.journal.executeOperation(command("op-image-dropping-edit", {
    action: "update", entryId: add.operationId, expectedRevision: entry.revision, text: "no images",
  }))).toThrow("native queue edit must carry the entry's attachments");
  f.journal.close();
});


test.each(["add", "start", "send-now"] as const)("persistent drain holds authenticated native %s through recovery and dispatches it once after release", async action => {
  const f = fixture(); f.idle();
  const seed = command("native-drain-seed");
  if (action === "send-now") { f.journal.executeOperation(seed); await f.executor.execute(seed); }
  f.calls.length = 0;
  const queued = () => new StructuredDeliveryQueue({
    effects: async (kinds, after) => f.journal.effectBatch(100, kinds, after),
    status: async id => { const r = f.journal.operationResult(id); return r ? { ...r.receipt, at: r.receipt.admittedAt! } : null; },
    transition: async (id, status, details) => { f.journal.transitionOperation(id, status, details); },
    autonomousTurnHeld: (_id, admittedAt) => {
      const hold = activeDrain();
      return !!hold && (!admittedAt || Date.parse(admittedAt) >= Date.parse(hold.since));
    },
    nativeQueueExecute: (c, reason) => f.executor.execute(c, reason),
  }, () => f.host);
  const post = (id: string, manual = false) => handleNativeQueue(new NextRequest("http://localhost/api/runtime/queue", {
    method: "POST", headers: { host: "localhost",
      ...(manual ? { "sec-fetch-site": "same-origin" } : { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) }) },
    body: JSON.stringify(command(id, { action, origin: { kind: "operator" },
      ...(action !== "add" ? { turnId: null } : {}),
      ...(action === "send-now" ? { entryId: seed.operationId, expectedRevision: 1 } : {}) })),
  }), { client: () => f.client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [] });
  setCallerConversationResolverForTests(() => "conversation_native_sender");
  try {
    writeDrain(drainFile(), { id: "native-drain", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    const response = await post("native-drain-fresh"); expect(response.status).toBe(202);
    const accepted = await response.json();
    const effect = f.journal.effectBatch(100).find(e => e.payload.operationId === accepted.operationId)!;
    expect(effect.payload.origin).toMatchObject({ kind: "agent" });
    await queued().drain(); await queued().drain();
    expect(f.calls).toEqual([]);
    expect(f.journal.operationResult(accepted.operationId)!.receipt.status).toBe("queued");
    // The fresh effect stays in the journal across executor reconstruction.
    releaseDrain(drainFile(), "native-drain");
    await queued().drain(); await queued().drain();
    expect(f.calls).toEqual([action === "add" ? "thread/queue/add" : "thread/queue/start"]);
    expect(f.journal.operationResult(accepted.operationId)!.receipt.status).toBe("applied");
    // Original submitted receipts remain settled while a later hold is active.
    writeDrain(drainFile(), { id: "native-drain", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    await queued().drain(); expect(f.calls).toHaveLength(1);
    if (action !== "send-now") {
      expect((await post("native-drain-manual", true)).status).toBe(202);
      await queued().drain(); expect(f.calls).toHaveLength(2);
    }
  } finally { setCallerConversationResolverForTests(null); releaseDrain(drainFile(), "native-drain"); f.journal.close(); }
});

/* docs/design/delivery-progress-and-drain.md, P18 and P25 (A6, A8, C3). */
test("a native entry's record shows the switch it follows, the successor it waits for and an unreadable health, then dispatching before its write and awaiting-turn once acknowledged; the entry is added once", async () => {
  const f = fixture();
  const add = command("op-native-notes");
  f.journal.executeOperation(add);
  const notes: string[] = [];
  const note = (reason: string) => { notes.push(reason); };
  const successor = { ...binding, accountId: "account-b" };
  const executorWith = (port: Partial<ConstructorParameters<typeof NativeQueueExecutor>[0]>) =>
    new NativeQueueExecutor({ client: f.client, resolveHost: () => f.host, binding: () => binding, ...port });
  expect(await executorWith({ succession: () => ({ status: "pending" }) }).execute(add, undefined, note)).toBe(false);
  expect(await executorWith({ succession: () => ({ status: "committed", binding: successor }), resolveHost: () => null, binding: () => successor })
    .execute(add, undefined, note)).toBe(false);
  const unreadableHost = { ...f.host, health: async () => { throw new Error("health unreadable"); } } as unknown as EngineHost;
  expect(await executorWith({ succession: () => ({ status: "committed", binding: successor }), resolveHost: () => unreadableHost, binding: () => successor })
    .execute(add, undefined, note)).toBe(false);
  expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(0);
  await f.executor.execute(add, undefined, note);
  expect(notes).toEqual(["switching-accounts", "awaiting-host", "evidence-unreadable", "dispatching", "awaiting-turn"]);
  expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(1);
  f.journal.close();
});

test("a native entry whose journal status cannot be read records why it waits", async () => {
  const f = fixture();
  const add = command("op-native-unreadable");
  f.journal.executeOperation(add);
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  progress.note(add.operationId, conversationId, { waitReason: "queued", originalKey: add.idempotencyKey });
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => f.journal.effectBatch(100, kinds, afterEventSeq),
    transition: async () => {},
    status: async () => { throw new Error("journal status unavailable"); },
    progress,
    nativeQueueExecute: async () => { throw new Error("nothing may run without a readable status"); },
  }, () => f.host);
  await queue.drain().catch(() => {});
  expect(progress.get(add.operationId)).toMatchObject({ waitReason: "evidence-unreadable", detail: "delivery journal status is unavailable", terminal: null });
  f.journal.close();
});

test("a native entry whose journal status read has not answered shows that step and its stall within the bound, and is added once when it answers", async () => {
  const f = fixture();
  const add = command("op-native-status-hangs");
  f.journal.executeOperation(add);
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  let clock = Date.now();
  const progress = new DeliveryProgressStore(null, () => clock);
  progress.note(add.operationId, conversationId, { waitReason: "queued", originalKey: add.idempotencyKey });
  let answer!: () => void;
  let reads = 0;
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => f.journal.effectBatch(100, kinds, afterEventSeq),
    transition: async () => {},
    status: async (operationId) => {
      reads += 1;
      if (reads === 1) await new Promise<void>((resolve) => { answer = resolve; });
      return f.journal.operationResult(operationId)?.receipt ?? null;
    },
    progress,
    nativeQueueExecute: (effect, refusal, note) => f.executor.execute(effect as never, refusal, note),
  }, () => f.host, undefined, undefined, undefined, undefined, undefined, undefined, { stallMs: 4_000, now: () => clock });
  const draining = queue.drain();
  for (let attempt = 0; attempt < 200 && !answer; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(0);
  clock += 5_000;
  await queue.tick();
  const waiting = progress.get(add.operationId)!;
  expect(waiting).toMatchObject({ waitReason: "checking", detail: "reading the delivery journal status", terminal: null });
  expect(typeof waiting.stalledSince).toBe("string");
  expect(clock - Date.parse(waiting.phaseSince)).toBeLessThanOrEqual(10_000);
  answer();
  await draining;
  expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(1);
  f.journal.close();
});

test("the executor's own status read, after the queue's answered, shows that step and its stall within the bound, and the entry is added once when it answers", async () => {
  const f = fixture();
  const add = command("op-native-executor-status-hangs");
  f.journal.executeOperation(add);
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  let clock = Date.now();
  const progress = new DeliveryProgressStore(null, () => clock);
  progress.note(add.operationId, conversationId, { waitReason: "queued", originalKey: add.idempotencyKey });
  let answer!: () => void;
  const hanging = { ...f.client, operationStatus: async (operationId: string) => {
    await new Promise<void>((resolve) => { answer = resolve; });
    return f.journal.operationResult(operationId);
  } } as RuntimeHostClient;
  const executor = new NativeQueueExecutor({ client: hanging, resolveHost: () => f.host, binding: () => binding });
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => f.journal.effectBatch(100, kinds, afterEventSeq),
    transition: async () => {},
    status: async (operationId) => f.journal.operationResult(operationId)?.receipt ?? null,
    progress,
    nativeQueueExecute: (effect, refusal, note, step) => executor.execute(effect as never, refusal, note, step),
  }, () => f.host, undefined, undefined, undefined, undefined, undefined, undefined, { stallMs: 4_000, now: () => clock });
  const draining = queue.drain();
  for (let attempt = 0; attempt < 200 && !answer; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(typeof answer).toBe("function");
  clock += 5_000;
  await queue.tick();
  const waiting = progress.get(add.operationId)!;
  expect(waiting).toMatchObject({ waitReason: "checking", detail: "reading the delivery journal status", terminal: null });
  expect(typeof waiting.stalledSince).toBe("string");
  expect(clock - Date.parse(waiting.phaseSince)).toBeLessThanOrEqual(10_000);
  answer();
  await draining;
  expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(1);
  expect(progress.get(add.operationId)).toMatchObject({ waitReason: "awaiting-turn" });
  f.journal.close();
});

function handOffFixture(name: string) {
  const f = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `llv-handoff-${name}-`));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  return { f, root, registry, cleanup: () => { f.journal.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function handOff(key: string, text = "queued for Codex") {
  return new NextRequest("http://localhost/api/runtime/queue", { method: "POST", headers: { host: "localhost", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ kind: "native-queue", conversationId, idempotencyKey: key, action: "add", text, binding }) });
}

test("a Queue-for-Codex hand-off whose reply is lost is owned and recorded from before its command, a replay answers the same operation, and Codex's queue receives one add", async () => {
  const { f, registry, cleanup } = handOffFixture("lost-reply");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  let lose = true;
  const seen: { row: boolean; record: boolean; operationId: string | undefined }[] = [];
  const client = {
    ...f.client,
    command: async (c: NativeQueueCommand) => {
      const owners = Object.values(registry.snapshot().deliveryOperationOwners);
      seen.push({ row: owners.some((owner) => owner.command.operationId === c.operationId), record: Boolean(c.operationId && progress.get(c.operationId)), operationId: c.operationId });
      const result = f.journal.executeOperation(c);
      if (lose) { lose = false; throw new RuntimeHostUnavailableError("runtime host is unavailable"); }
      return result;
    },
  } as RuntimeHostClient;
  const dependencies = { client: () => client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [],
    registry: () => registry, progress };
  try {
    const lost = await handleNativeQueue(handOff("handoff-lost"), dependencies as never);
    expect(lost.status).toBe(503);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ row: true, record: true });
    const operationId = seen[0]!.operationId!;
    expect(registry.snapshot().deliveryOperationOwners[operationId]).toMatchObject({ directAdmission: "native-queue-add", clientMessageId: "handoff-lost", terminalState: null });
    expect(progress.get(operationId)).toMatchObject({ originalKey: "handoff-lost", waitReason: "evidence-unreadable", attempt: 1, terminal: null });
    expect(progress.get(operationId)!.deadlineAt).not.toBeNull();

    const replay = await handleNativeQueue(handOff("handoff-lost"), dependencies as never);
    expect(replay.status).toBe(202);
    expect((await replay.json()).operationId).toBe(operationId);
    expect(seen.map((call) => call.operationId)).toEqual([operationId, operationId]);
    await f.executor.execute(f.journal.effectBatch(100).find((effect) => effect.kind === "runtime.native-queue")!.payload as never);
    expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(1);

    /* Past its deadline with the journal unreadable, the sweep ends the
       hand-off's own row, and its record keeps the ending. */
    const { settleDueSends } = await import("./sendSettlement");
    const unreadable = { ...client, operationStatus: async () => { throw new RuntimeHostUnavailableError("runtime host is unavailable"); } } as RuntimeHostClient;
    await settleDueSends({ registry, client: unreadable, progress, readMs: 200, now: () => Date.now() + 2 * 60 * 60_000 });
    expect(registry.snapshot().deliveryOperationOwners[operationId]?.terminalState).not.toBeNull();
    expect(progress.get(operationId)?.terminal).not.toBeNull();
  } finally {
    cleanup();
  }
});

test("a key first admitted before this build adopts the journal's operation, and a replay whose row has ended sends nothing and answers from the journal", async () => {
  const { f, registry, cleanup } = handOffFixture("adopt");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  let commands = 0;
  const client = { ...f.client, command: async (c: NativeQueueCommand) => { commands += 1; return f.journal.executeOperation(c); } } as RuntimeHostClient;
  const dependencies = { client: () => client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [],
    registry: () => registry, progress };
  try {
    /* Older code admitted it straight into the journal, which minted the id. */
    const older = f.journal.executeOperation(parseRuntimeCommand("native-queue", { kind: "native-queue", conversationId,
      idempotencyKey: "handoff-older", action: "add", text: "queued for Codex", binding }) as NativeQueueCommand);
    const adopted = await handleNativeQueue(handOff("handoff-older"), dependencies as never);
    expect(adopted.status).toBe(202);
    expect((await adopted.json()).operationId).toBe(older.operationId);
    expect(registry.snapshot().deliveryOperationOwners[older.operationId]).toMatchObject({ directAdmission: "native-queue-add", clientMessageId: "handoff-older", terminalState: null });
    expect(progress.get(older.operationId)).toMatchObject({ originalKey: "handoff-older", terminal: null });
    const own = Object.entries(registry.snapshot().deliveryOperationOwners)
      .filter(([id, owner]) => owner.clientMessageId === "handoff-older" && id !== older.operationId);
    expect(own.map(([, owner]) => owner)).toMatchObject([{ terminalState: "failed", terminalDisposition: "lost" }]);

    /* A row the settlement ended is never sent again. */
    const fresh = await handleNativeQueue(handOff("handoff-ended", "ended before its reply"), dependencies as never);
    const freshOperation = (await fresh.json()).operationId as string;
    registry.settleDirectAdmission(freshOperation, "failed", "settled at its deadline", "unverified");
    const before = commands;
    const replay = await handleNativeQueue(handOff("handoff-ended", "ended before its reply"), dependencies as never);
    expect(commands).toBe(before);
    expect(replay.status).toBe(202);
    expect((await replay.json()).operationId).toBe(freshOperation);
  } finally {
    cleanup();
  }
});

test("a hand-off whose acknowledgement is lost after Codex already holds the entry keeps the executor's phase and clocks, and the entry is added once", async () => {
  const { f, registry, cleanup } = handOffFixture("late-failed-ack");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  let kicks = 0;
  const client = {
    ...f.client,
    command: async (c: NativeQueueCommand) => {
      f.journal.executeOperation(c);
      /* The queue lists it and the executor hands it to Codex before the reply comes back. */
      const effect = f.journal.effectBatch(100).find((candidate) => candidate.kind === "runtime.native-queue")!;
      await f.executor.execute(effect.payload as never, undefined, (reason, detail) => {
        progress.note(c.operationId!, conversationId, { waitReason: reason, detail: detail ?? null, progressed: true });
      });
      setSystemTime(new Date(Date.now() + 5_000));
      throw new RuntimeHostUnavailableError("runtime host is unavailable");
    },
  } as RuntimeHostClient;
  const dependencies = { client: () => client, enabled: () => true, kick: () => { kicks += 1; }, admitImages: () => ({ images: [], error: null }), storeImages: () => [],
    registry: () => registry, progress };
  try {
    const lost = await handleNativeQueue(handOff("late-failed-ack"), dependencies as never);
    expect(lost.status).toBe(503);
    const operationId = Object.values(registry.snapshot().deliveryOperationOwners).find((owner) => owner.clientMessageId === "late-failed-ack")!.command.operationId;
    const record = progress.get(operationId)!;
    expect(record).toMatchObject({ waitReason: "awaiting-turn", attempt: 0, terminal: null });
    expect(Date.parse(record.lastProgressAt)).toBeLessThan(Date.now() - 4_000);
    expect(kicks).toBe(1);
    expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(1);
  } finally {
    setSystemTime();
    cleanup();
  }
});

test("a replay of a hand-off the executor already acknowledged leaves the executor's phase, clocks and wake as they were, and the entry is added once", async () => {
  const { f, registry, cleanup } = handOffFixture("replay-acknowledged");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  const dependencies = { client: () => f.client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [],
    registry: () => registry, progress };
  try {
    const first = await handleNativeQueue(handOff("replay-acknowledged"), dependencies as never);
    expect(first.status).toBe(202);
    const operationId = (await first.json()).operationId as string;
    const effect = f.journal.effectBatch(100).find((candidate) => candidate.kind === "runtime.native-queue")!;
    await f.executor.execute(effect.payload as never, undefined, (reason, detail) => {
      progress.note(operationId, conversationId, { waitReason: reason, detail: detail ?? null, progressed: true });
    });
    const acknowledged = structuredClone(progress.get(operationId)!);
    expect(acknowledged).toMatchObject({ waitReason: "awaiting-turn", terminal: null });
    setSystemTime(new Date(Date.now() + 5_000));
    const replay = await handleNativeQueue(handOff("replay-acknowledged"), dependencies as never);
    expect(replay.status).toBe(202);
    expect((await replay.json()).operationId).toBe(operationId);
    const after = progress.get(operationId)!;
    expect(after).toMatchObject({ waitReason: "awaiting-turn", terminal: null });
    expect(after.phaseSince).toBe(acknowledged.phaseSince);
    expect(after.lastProgressAt).toBe(acknowledged.lastProgressAt);
    expect(after.nextWakeAt).toBe(acknowledged.nextWakeAt);
    expect(after.stalledSince).toBe(acknowledged.stalledSince);
    expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(1);
  } finally {
    setSystemTime();
    cleanup();
  }
});

test("a hand-off whose supplied operation id names another key's owner is refused and leaves that owner, its record and its entry as they were", async () => {
  const { f, registry, cleanup } = handOffFixture("collision");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  let commands = 0;
  const client = { ...f.client, command: async (c: NativeQueueCommand) => { commands += 1; return f.journal.executeOperation(c); } } as RuntimeHostClient;
  const dependencies = { client: () => client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [],
    registry: () => registry, progress };
  const named = (key: string, text: string, operationId: string, target = conversationId) =>
    new NextRequest("http://localhost/api/runtime/queue", { method: "POST", headers: { host: "localhost", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ kind: "native-queue", conversationId: target, idempotencyKey: key, action: "add", text, operationId, binding }) });
  try {
    const first = await handleNativeQueue(handOff("owner-a", "message A"), dependencies as never);
    expect(first.status).toBe(202);
    const a = (await first.json()).operationId as string;
    const rowBefore = structuredClone(registry.snapshot().deliveryOperationOwners[a]);
    const recordBefore = structuredClone(progress.get(a));
    const before = commands;

    for (const request of [
      named("owner-b", "message B", a),
      named("owner-b2", "message A", a),
      named("owner-a", "message A", a, "conversation_other"),
    ]) {
      const refused = await handleNativeQueue(request, dependencies as never);
      expect(refused.status).toBe(409);
    }
    expect(commands).toBe(before);
    expect(registry.snapshot().deliveryOperationOwners[a]).toEqual(rowBefore);
    expect(progress.get(a)).toEqual(recordBefore);
    expect(f.journal.operationResult(a)?.receipt.status).toBe("queued");
    await f.executor.execute(f.journal.effectBatch(100).find((effect) => effect.kind === "runtime.native-queue")!.payload as never);
    expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(1);

    /* An owner that has ended is not answered for another key either. */
    registry.settleDirectAdmission(a, "failed", "settled at its deadline", "unverified");
    const ended = await handleNativeQueue(named("owner-c", "message C", a), dependencies as never);
    expect(ended.status).toBe(409);
    expect(registry.snapshot().deliveryOperationOwners[a]).toMatchObject({ clientMessageId: "owner-a", terminalDisposition: "unverified" });
  } finally {
    cleanup();
  }
});

test("a hand-off during a switch holds neither the switch nor the message", async () => {
  const { advanceConversationMigration } = await import("@/lib/accounts/migration/coordinator");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-switch-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    registry.reconcileConversations([{ engine: "codex", path: "/handoff-switch.jsonl", accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }), turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:00:00.000Z" }]);
    const conversation = registry.conversationForPath("/handoff-switch.jsonl")!;
    registry.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "handoff-switch", expectedRevision: registry.engineRouting("codex").revision });
    const row = registry.recordDirectAdmission({ handOff: { conversationId: conversation.id, clientMessageId: "handoff-during-switch",
      command: { operationId: "", kind: "send", policy: "queue" }, text: "queued during the switch", contentDigest: null,
      evidenceText: "queued during the switch", evidenceImageCount: 0 } })!;
    expect(row).toMatchObject({ directAdmission: "native-queue-add", terminalState: null });
    expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
    let created = 0;
    const committed = await advanceConversationMigration(conversation.id, registry, {
      virtualSource: true,
      async create(input) {
        created += 1;
        return { operationId: input.operationId, nativeId: "handoff-successor", path: "/handoff-successor.jsonl", continuityPaths: [],
          historyHash: "hash", host: { kind: "codex-app-server", identity: "host", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" } };
      },
      async verify() {},
    });
    expect(created).toBe(1);
    expect(committed.migration).toMatchObject({ phase: "committed" });
    expect(registry.snapshot().deliveryOperationOwners[row.command.operationId]).toMatchObject({ terminalState: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a native entry's settlement waits for the lock off the loop, a hand-off settles its own row, and a refused settle is left for the sweep", async () => {
  const { sqliteRegistryFixture, registryLockHolder, longestLoopGap } = await import("@/lib/agent/registryLockHolderFixture");
  const { blockingWaitDiagnostics, resetBlockingWaitsForTests } = await import("@/lib/blockingWaits");
  const { settleNativeQueueEntry } = await import("./nativeQueueSettlement");
  const made = sqliteRegistryFixture("llv-native-settle", { sqliteWriterDeadlineMs: 150 });
  const holder = registryLockHolder(made.sqliteFilename);
  const registry = made.registry;
  try {
    const conversation = registry.ensureConversation("codex", "/native-settle.jsonl", "a");
    const held = registry.holdDelivery(conversation.id, "converted send", "native-settle-send", "text", [], null, { operationId: "native-settle-send", kind: "send", policy: "queue" });
    registry.beginDeliveryAttempt(held.id, held.generationId!);
    const handOffRow = registry.recordDirectAdmission({ handOff: { conversationId: conversation.id, clientMessageId: "native-settle-handoff",
      command: { operationId: "native-settle-handoff", kind: "send", policy: "queue" }, text: "hand-off", contentDigest: null,
      evidenceText: "hand-off", evidenceImageCount: 0 } })!;
    resetBlockingWaitsForTests(() => {});
    await holder.hold(100);
    const { value: settled, gapMs } = await longestLoopGap(() => settleNativeQueueEntry(registry, { conversationId: conversation.id, entryId: "native-settle-send", state: "delivered" }));
    expect(settled).toBe(true);
    expect(gapMs).toBeLessThan(50);
    expect(blockingWaitDiagnostics().longest.find((sample) => sample.label === "delivery.native-settle")).toMatchObject({ operationId: "native-settle-send", synchronous: false });
    expect(registry.snapshot().deliveryOperationOwners["native-settle-send"]).toMatchObject({ terminalState: "delivered" });
    expect(await settleNativeQueueEntry(registry, { conversationId: conversation.id, entryId: handOffRow.command.operationId, state: "delivered" })).toBe(true);
    expect(registry.snapshot().deliveryOperationOwners[handOffRow.command.operationId]).toMatchObject({ terminalState: "delivered", terminalDisposition: "delivered" });
    const second = registry.recordDirectAdmission({ handOff: { conversationId: conversation.id, clientMessageId: "native-settle-refused",
      command: { operationId: "native-settle-refused", kind: "send", policy: "queue" }, text: "refused", contentDigest: null,
      evidenceText: "refused", evidenceImageCount: 0 } })!;
    await holder.hold(500);
    expect(await settleNativeQueueEntry(registry, { conversationId: conversation.id, entryId: second.command.operationId, state: "delivered" })).toBe(false);
    expect(registry.snapshot().deliveryOperationOwners[second.command.operationId]).toMatchObject({ terminalState: null });
  } finally {
    await holder.close();
    registry.close();
    made.cleanup();
  }
});

/* docs/design/delivery-progress-and-drain.md, P18 and P25 (A6, #1131): the
   durable record ended an add that was never handed to Codex while the journal
   was out of reach. The add's first actuation passes that fence like any
   send's: no add follows, through a later executor too, and the ending stands. */
test("a Queue-for-Codex add the durable record already ended is refused before any add, after a restart too, and its ended record stands", async () => {
  const { f, registry, cleanup } = handOffFixture("settled-fence");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const { settleDueSends, sendIsSettled } = await import("./sendSettlement");
  const progress = new DeliveryProgressStore(null);
  let lose = true;
  const client = {
    ...f.client,
    command: async (c: NativeQueueCommand) => {
      const result = f.journal.executeOperation(c);
      if (lose) { lose = false; throw new RuntimeHostUnavailableError("runtime host is unavailable"); }
      return result;
    },
  } as RuntimeHostClient;
  try {
    const lost = await handleNativeQueue(handOff("handoff-settled"), { client: () => client, enabled: () => true, kick: () => {},
      admitImages: () => ({ images: [], error: null }), storeImages: () => [], registry: () => registry, progress } as never);
    expect(lost.status).toBe(503);
    const operationId = Object.values(registry.snapshot().deliveryOperationOwners).find((owner) => owner.clientMessageId === "handoff-settled")!.command.operationId;
    const unreadable = { ...client, operationStatus: async () => { throw new RuntimeHostUnavailableError("runtime host is unavailable"); } } as RuntimeHostClient;
    await settleDueSends({ registry, client: unreadable, progress, readMs: 200, now: () => Date.now() + 61 * 60_000 });
    expect(sendIsSettled(registry.snapshot(), operationId)).toBe(true);
    const ended = progress.get(operationId)!.terminal;
    expect(ended).not.toBeNull();
    const queue = () => new StructuredDeliveryQueue({
      effects: async (kinds, afterEventSeq) => f.journal.effectBatch(100, kinds, afterEventSeq),
      status: async (id) => f.journal.operationResult(id)?.receipt ?? null,
      transition: async (id, status, details) => { f.journal.transitionOperation(id, status, details); },
      settled: (id) => sendIsSettled(registry.snapshot(), id),
      progress,
      nativeQueueExecute: (c, reason, note, step, settled) => f.executor.execute(c as never, reason, note, step, settled),
    }, () => f.host);
    await queue().drain();
    await queue().drain();
    expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(0);
    expect(f.journal.nativeQueueRead(conversationId).find((entry) => entry.entryId === operationId)?.state).toBe("refused");
    expect(f.journal.operationResult(operationId)?.receipt.status).toBe("failed");
    expect(progress.get(operationId)!.terminal).toEqual(ended);
  } finally {
    cleanup();
  }
});

test("a converted queue send's add waits on an unreadable settlement fence, then is refused once the record ended it; Codex's queue receives nothing", async () => {
  const f = fixture();
  const send = parseRuntimeCommand("send", { conversationId, operationId: "converted-fenced", idempotencyKey: "converted-fenced-key", text: "native owned", policy: "queue" });
  f.journal.executeOperation(send);
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  progress.note("converted-fenced", conversationId, { waitReason: "queued", originalKey: "converted-fenced-key" });
  let fence: "unreadable" | boolean = "unreadable";
  const queue = () => new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => f.journal.effectBatch(100, kinds, afterEventSeq),
    status: async (id) => f.journal.operationResult(id)?.receipt ?? null,
    transition: async (id, status, details) => { f.journal.transitionOperation(id, status, details); },
    settled: async () => { if (fence === "unreadable") throw new Error("registry is unreadable"); return fence; },
    progress,
    nativeQueueExecute: (c, reason, note, step, settled) => f.executor.execute(c as never, reason, note, step, settled),
  }, () => f.host);
  await queue().drain();
  expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(0);
  expect(progress.get("converted-fenced")).toMatchObject({ waitReason: "evidence-unreadable", detail: "durable delivery record is unavailable", terminal: null });
  expect(f.journal.operationResult("converted-fenced")?.receipt.status).toBe("queued");
  fence = true;
  progress.settle("converted-fenced", "uncertain", "settled while the journal was unreachable");
  await queue().drain();
  expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(0);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("refused");
  expect(progress.get("converted-fenced")!.terminal).toMatchObject({ state: "uncertain" });
  f.journal.close();
});

/* A6: the reads after a failed preparation are the entry's wait as much as
   the normal path's, so one that hangs shows as that step and stalls. */
test.each([
  ["reading the delivery journal status", "status"],
  ["reading the native queue journal", "journal"],
] as const)("after a failed preparation, %s that has not answered shows that step and its stall within the bound, and nothing is added", async (detail, hang) => {
  const f = fixture();
  const add = command(`op-native-error-${hang}`);
  f.journal.executeOperation(add);
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  let clock = Date.now();
  const progress = new DeliveryProgressStore(null, () => clock);
  progress.note(add.operationId, conversationId, { waitReason: "queued", originalKey: add.idempotencyKey });
  let answer: (() => void) | undefined;
  let statusReads = 0;
  let journalReads = 0;
  const hanging = {
    ...f.client,
    operationStatus: async (operationId: string) => {
      statusReads += 1;
      if (hang === "status" && statusReads === 2) await new Promise<void>((resolve) => { answer = resolve; });
      return f.journal.operationResult(operationId);
    },
    nativeQueueRead: async (id: string) => {
      journalReads += 1;
      if (hang === "journal" && journalReads === 2) await new Promise<void>((resolve) => { answer = resolve; });
      return f.journal.nativeQueueRead(id);
    },
  } as RuntimeHostClient;
  const failing = { ...f.host, nativeQueue: { ...f.host.nativeQueue!, prepare: async () => { throw new Error("attachment unreadable"); } } } as unknown as EngineHost;
  const executor = new NativeQueueExecutor({ client: hanging, resolveHost: () => failing, binding: () => binding });
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, afterEventSeq) => f.journal.effectBatch(100, kinds, afterEventSeq),
    transition: async () => {},
    status: async (operationId) => f.journal.operationResult(operationId)?.receipt ?? null,
    progress,
    nativeQueueExecute: (effect, refusal, note, step) => executor.execute(effect as never, refusal, note, step),
  }, () => failing, undefined, undefined, undefined, undefined, undefined, undefined, { stallMs: 4_000, now: () => clock });
  const draining = queue.drain();
  for (let attempt = 0; attempt < 200 && !answer; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(typeof answer).toBe("function");
  clock += 5_000;
  await queue.tick();
  const waiting = progress.get(add.operationId)!;
  expect(waiting).toMatchObject({ waitReason: "checking", detail, terminal: null });
  expect(typeof waiting.stalledSince).toBe("string");
  expect(clock - Date.parse(waiting.phaseSince)).toBeLessThanOrEqual(10_000);
  answer!();
  await draining;
  expect(f.calls.filter((call) => call.endsWith("/add"))).toHaveLength(0);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("refused");
  f.journal.close();
});
