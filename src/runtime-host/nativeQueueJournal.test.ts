import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { RuntimeJournal } from "./journal";
import { RuntimeHost } from "./host";
import { serveRuntimeHost } from "./socket";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { parseRuntimeCommand } from "@/lib/runtime/commands";
import { NativeQueueExecutor, withdrawNativeSeatMessage } from "@/lib/runtime/nativeQueueExecutor";
import { SEND_SEAT_REVOKED_REASON } from "@/lib/orchestrator/seatChannel";

// Real socket framing and journal reopen, with no engine process or shared state.
test("native queue journal preserves mutation identity and content through the production socket and reopen", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nqs-"));
  const filename = path.join(base, "journal.sqlite");
  const socket = path.join(base, "host.sock");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({ scope: "session:conversation_socket", kind: "session-status", payload: {
    conversationId: "conversation_socket", sessionKey: { engine: "codex", sessionId: "thread-socket" },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", accountId: null,
    capabilities: { steer: true, nativeQueue: true, structuredAttention: true },
  } });
  const server = serveRuntimeHost(socket, new RuntimeHost(journal, undefined, undefined, true));
  await once(server, "listening");
  const client = new UnixRuntimeHostClient(socket);
  try {
    const command = parseRuntimeCommand("native-queue", { conversationId: "conversation_socket", operationId: "op-socket", idempotencyKey: "socket-key",
      action: "add", binding: { threadId: "thread-socket", accountId: null }, text: "Привіт 🌍", runtime: { serviceTierForTurn: "priority" } });
    expect((await client.command(command)).receipt.status).toBe("queued");
    const input = [{ type: "text" as const, text: "Привіт 🌍" }];
    await client.nativeQueueTransition("op-socket", { phase: "prepared", input });
    await expect(client.nativeQueueTransition("op-socket", { phase: "prepared", input })).rejects.toThrow("moved");
    await client.nativeQueueTransition("op-socket", { phase: "deferred", reason: "fixture admission deferred" });
    expect(await client.operationStatus("op-socket")).toMatchObject({ receipt: { status: "queued", reason: "fixture admission deferred" } });
    await client.nativeQueueTransition("op-socket", { phase: "prepared", input });
    await client.nativeQueueTransition("op-socket", { phase: "uncertain", reason: "fixture lost acknowledgement" });
    expect((await client.nativeQueueRead("conversation_socket"))[0]).toMatchObject({ state: "uncertain", versions: [{ input, requestedRuntime: { serviceTierForTurn: "priority" } }] });
    expect((await client.command(command)).replayed).toBeTrue();
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    journal.close();
  }
  const reopened = new RuntimeJournal(filename, { structuredHosts: true });
  expect(reopened.nativeQueueRead("conversation_socket")[0]).toMatchObject({ mutationOperationId: "op-socket", state: "uncertain", proof: null });
  expect(reopened.operationResult("op-socket")?.receipt.status).toBe("uncertain");
  reopened.close();
});

test("seat withdrawal crosses the production socket before preparation and preserves a dispatch-owned add", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nqw-"));
  const journal = new RuntimeJournal(path.join(base, "journal.sqlite"), { structuredHosts: true });
  const socket = path.join(base, "host.sock");
  const conversationId = "conversation_withdrawal";
  const binding = { threadId: "thread-withdrawal", accountId: null };
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: binding.threadId }, hostKind: "codex-app-server", host: "hosted",
    turn: "idle", accountId: null, capabilities: { steer: true, nativeQueue: true, structuredAttention: true },
  } });
  const server = serveRuntimeHost(socket, new RuntimeHost(journal, undefined, undefined, true));
  await once(server, "listening");
  const client = new UnixRuntimeHostClient(socket);
  const executor = new NativeQueueExecutor({ client, resolveHost: () => null, binding: () => binding });
  const add = (operationId: string) => parseRuntimeCommand("native-queue", {
    conversationId, operationId, idempotencyKey: operationId, action: "add", binding, text: "deliver to the current seat",
  });
  try {
    const unprepared = add("seat-withdraw-unprepared");
    await client.command(unprepared);
    expect(await withdrawNativeSeatMessage(conversationId, unprepared.operationId!, client, executor)).toBe(true);
    expect(await client.operationStatus(unprepared.operationId!)).toMatchObject({ receipt: { status: "failed", reason: SEND_SEAT_REVOKED_REASON } });
    expect((await client.nativeQueueRead(conversationId)).find(row => row.entryId === unprepared.operationId)?.state).toBe("refused");

    const dispatchOwned = add("seat-withdraw-dispatch-owned");
    await client.command(dispatchOwned);
    await client.nativeQueueTransition(dispatchOwned.operationId!, { phase: "prepared", input: [{ type: "text", text: "deliver to the current seat" }] });
    expect(await withdrawNativeSeatMessage(conversationId, dispatchOwned.operationId!, client, executor)).toBe(false);
    expect(await client.operationStatus(dispatchOwned.operationId!)).toMatchObject({ receipt: { status: "delivering" } });
    expect((await client.nativeQueueRead(conversationId)).find(row => row.entryId === dispatchOwned.operationId)).toMatchObject({
      state: "admitted", versions: [{ input: [{ type: "text", text: "deliver to the current seat" }] }],
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    journal.close();
  }
});


test.each(["acknowledged", "lost-reply"])("guarded native starts survive a fresh interpreter: %s", async outcome => {
  const { NativeCodexQueue } = await import("@/lib/runtime/nativeCodexQueue");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nqg-"));
  const filename = path.join(base, "journal.sqlite"), socket = path.join(base, "host.sock");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({ scope: "session:conversation_guarded", kind: "session-status", payload: {
    conversationId: "conversation_guarded", sessionKey: { engine: "codex", sessionId: "guarded-thread" }, hostKind: "codex-app-server", host: "hosted",
    turn: "idle", accountId: null, capabilities: { steer: true, nativeQueue: true, structuredAttention: true },
  } });
  const server = serveRuntimeHost(socket, new RuntimeHost(journal, undefined, undefined, true));
  await once(server, "listening");
  const client = new UnixRuntimeHostClient(socket);
  const binding = { threadId: "guarded-thread", accountId: null };
  const command = parseRuntimeCommand("native-queue", { conversationId: "conversation_guarded", operationId: "guarded-op", idempotencyKey: "guarded-op",
    action: "add", binding, text: "Retain guarded input" }) as import("@/lib/runtime/nativeQueueContracts").NativeQueueCommand & { operationId: string };
  const input = [{ type: "text" as const, text: command.text! }];
  let starts = 0;
  const host = {
    health: async () => ({ status: "idle", activeTurnRef: null }),
    nativeQueue: {
      queue: new NativeCodexQueue({ rpc: async method => { if (method === "thread/queue/list") return { data: [], nextCursor: null }; throw new Error("automatic native dispatch is forbidden"); } }, binding.threadId),
      prepare: async () => input, evidence: async () => null,
      sendWithdrawn: async () => { starts++; if (outcome === "lost-reply") throw new Error("lost turn acknowledgement"); return { turnId: "guarded-turn" }; },
    },
  } as unknown as import("@/lib/runtime/engineHost").EngineHost;
  try {
    expect((await client.command(command)).receipt.status).toBe("queued");
    const executor = new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => binding, requiresDispatchGuard: () => true });
    await executor.execute(command);
    expect(starts).toBe(1);
    expect((await client.nativeQueueRead(command.conversationId))[0]).toMatchObject({
      state: outcome === "acknowledged" ? "dispatching" : "uncertain", nativeSubmissionId: null, versions: [{ input }],
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); journal.close();
  }
  const child = Bun.spawn([process.execPath, "-e", `
    const { RuntimeJournal } = await import("./src/runtime-host/journal.ts");
    const { NativeQueueExecutor } = await import("./src/lib/runtime/nativeQueueExecutor.ts");
    const { NativeCodexQueue } = await import("./src/lib/runtime/nativeCodexQueue.ts");
    const journal = new RuntimeJournal(process.env.FIXTURE_JOURNAL, { structuredHosts: true });
    const entry = journal.nativeQueueRead("conversation_guarded")[0];
    const proof = { threadId: entry.binding.threadId, clientUserMessageId: entry.clientUserMessageId,
      revision: entry.revision, turnId: "guarded-turn", itemId: "guarded-item", input: entry.versions[0].input };
    let writes = 0;
    const host = { nativeQueue: { queue: new NativeCodexQueue({ rpc: async method => {
      if(method === "thread/queue/list") return { data: [], nextCursor: null }; writes++; throw new Error("replayed mutation");
    } }, entry.binding.threadId), evidence: async () => proof, prepare: async () => proof.input, sendWithdrawn: async () => { writes++; throw new Error("replayed start"); } } };
    const client = { operationStatus: async id => journal.operationResult(id), nativeQueueRead: async id => journal.nativeQueueRead(id),
      nativeQueueTransition: async (id, change) => journal.nativeQueueTransition(id, change) };
    const executor = new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => entry.binding, requiresDispatchGuard: () => true });
    await executor.execute({ kind:"native-queue", action:"add", operationId:entry.entryId, conversationId:entry.conversationId, binding:entry.binding });
    await executor.reconcile(entry.conversationId);
    console.log(JSON.stringify({writes, entry:journal.nativeQueueRead(entry.conversationId)[0], receipt:journal.operationResult(entry.entryId).receipt}));
    journal.close();
  `], { env: { ...process.env, FIXTURE_JOURNAL: filename }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    expect(JSON.parse(out)).toMatchObject({ writes: 0, entry: { state: "delivered", versions: [{ input }], proof: { turnId: "guarded-turn" } }, receipt: { status: "delivered" } });
  } finally { if (child.exitCode === null) child.kill(); await child.exited; fs.rmSync(base, { recursive: true, force: true }); }
});
