// destructive-code: head-only; fixture-owned paths and recording process doubles.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { CodexAppServerHost, rolloutTurnsFromDisk } from "./codexAppServerHost";
import { FileRuntimeEventStore, type RuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import { NativeQueueExecutor } from "./nativeQueueExecutor";
import { settleNativeQueueEntry } from "./nativeQueueSettlement";
import type { NativeQueueRecord } from "./nativeQueueContracts";
import { installCodexHostFixture, COMPACT_SELECTED, MemoryEventStore, FakeAppServer, fakeSpawn, waitForCondition, metadataState } from "./codexAppServerHost.fixture";

installCodexHostFixture();

describe("CodexAppServerHost", () => {
  describe("native queue proof of an entry the engine consumed", () => {
    const queueEntry = (threadId: string, overrides: Partial<NativeQueueRecord["versions"][number]> = {}): NativeQueueRecord => ({
      entryId: "consumed-entry", conversationId: "conversation_fixture",
      binding: {threadId, accountId: "fixture"}, clientUserMessageId: "consumed-entry", nativeSubmissionId: "native-submission",
      revision: 1, versions: [{revision: 1, operationId: "consumed-entry", text: "Look at this", images: [], contentDigest: "fixture-digest",
        origin: {kind: "operator"}, ...overrides}],
      profilePolicy: "thread-at-dispatch", state: "queued", mutationOperationId: null,
      dispatchedRevision: null, dispatchedTurnId: null, proof: null, reason: null,
    });

    test("an emptied event window proves the last 128 events from its ledger", async () => {
      const threadId = "idle-proof-thread";
      const server = new FakeAppServer(threadId);
      server.userAgent = "codex_desktop_app/0.154.0 (Linux)";
      server.paginatedHistory = true;
      const store = new MemoryEventStore();
      const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: store, spawnProcess: fakeSpawn(server) });
      try {
        const entry = queueEntry(threadId);
        entry.versions[0]!.input = await host.nativeQueue!.prepare(entry, entry.versions[0]!);
        server.notify("item/completed", { threadId, turnId: "proof-turn", item: {
          type: "userMessage", id: "proof-user", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input,
        } });
        await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && event.phase === "completed"), "proof item to persist");
        const window = host as unknown as { events: RuntimeEvent[]; eventWindowReleased: boolean };
        window.events.length = 0;
        window.eventWindowReleased = true;
        server.readError = server.turnsError = "canonical read unavailable";
        expect(await host.nativeQueue!.evidence(entry)).toMatchObject({ itemId: "proof-user" });
        expect(host.heapAttribution().events).toBe(0);
        expect(await host.nativeQueue!.evidence({ ...entry, clientUserMessageId: "absent-client" })).toBeNull();
        for (let index = 0; index < 128; index++) server.notify("item/agentMessage/delta", {
          threadId, turnId: "proof-turn", delta: "later",
        });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "delta").length === 128, "proof to leave the last 128 events");
        window.events.length = 0;
        window.eventWindowReleased = true;
        expect(await host.nativeQueue!.evidence(entry)).toBeNull();
      } finally { await host.release(); }
    });

    test("an adopted thread whose resume omitted its transcript path still proves a consumed entry", async () => {
      const server = new FakeAppServer("pathless-native-thread");
      server.userAgent = "codex_desktop_app/0.154.0 (Linux)";
      server.paginatedHistory = true;
      server.omitThreadPath = true;
      const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
      try {
        const entry = queueEntry("pathless-native-thread");
        entry.versions[0].input = await host.nativeQueue!.prepare(entry, entry.versions[0]);
        server.readTurns = [{id: "turn-1", status: "completed", items: [
          {type: "userMessage", id: "canonical-user", clientId: entry.clientUserMessageId, content: entry.versions[0].input}]}];
        expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([expect.objectContaining({itemId: "canonical-user"})]);
        expect(await host.nativeQueue!.evidence(entry)).toMatchObject({itemId: "canonical-user"});
        // The executor's pass over this real host moves the consumed entry to delivered.
        const transitions: Array<{ id: string; phase: string }> = [];
        const executor = new NativeQueueExecutor({ resolveHost: () => host, binding: () => entry.binding, client: {
          nativeQueueRead: async () => [entry],
          operationStatus: async () => ({ receipt: { status: "queued" } }),
          nativeQueueTransition: async (id: string, transition: { phase: string }) => { transitions.push({ id, phase: transition.phase }); },
        } as unknown as RuntimeHostClient });
        expect(await executor.reconcile("conversation_fixture")).toBeFalse();
        expect(transitions).toEqual([{ id: "consumed-entry", phase: "proven" }]);
        expect(server.requests.some(r => r.method === "turn/start" || r.method === "turn/steer" || r.method === "thread/queue/add")).toBeFalse();
      } finally { await host.release(); }
    }, 15000);

    test.each(["absent", "changed-input", "conflicting-items", "mixed-batch", "malformed", "foreign-path"])(
      "canonical readback with %s takes precedence over a retained completed item", async scenario => {
        const threadId = "readback-precedence-thread";
        const server = new FakeAppServer(threadId);
        server.paginatedHistory = true;
        const eventStore = new MemoryEventStore();
        const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
        try {
          const entry = queueEntry(threadId);
          entry.versions[0]!.input = await host.nativeQueue!.prepare(entry, entry.versions[0]!);
          const peer = { ...entry, entryId: "other-entry", clientUserMessageId: "other-entry" };
          const user = { type: "userMessage", id: "retained-user", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
          server.notify("item/completed", { threadId, turnId: "consuming-turn", item: {
            type: "commandExecution", id: "preview-before-proof", command: "printf output", exitCode: 0, aggregatedOutput: "output".repeat(10_000),
          } });
          server.notify("item/completed", { threadId, turnId: "consuming-turn", item: user });
          await waitForCondition(() => eventStore.load(threadId).some(event => event.kind === "item" && (event.item as { id?: string }).id === user.id), "completed item was not retained");
          expect(host.heapAttribution().trimmedEvents).toBe(1);
          const turn = (id: string, item: typeof user) => ({ id, status: "completed", items: [item] });
          server.readTurns = scenario === "absent" ? []
            : scenario === "changed-input" ? [turn("consuming-turn", { ...user, content: [{ type: "text", text: "different input" }] })]
            : scenario === "conflicting-items" ? [{ ...turn("consuming-turn", user), items: [user, { ...user, id: "another-user" }] }]
            : scenario === "malformed" ? [{ id: "malformed-turn", items: [] }]
            : [turn("peer-turn", { ...user, id: "peer-user", clientId: peer.clientUserMessageId })];
          if (scenario === "foreign-path") server.threadPath = "/sessions/other-thread.jsonl";
          const before = structuredClone(entry);
          expect(await host.nativeQueue!.evidence(entry)).toBeNull();
          expect(await host.nativeQueue!.evidenceBatch!([entry, peer])).toEqual([
            null, scenario === "mixed-batch" ? expect.objectContaining({ clientUserMessageId: peer.clientUserMessageId, itemId: "peer-user" }) : null,
          ]);
          expect(entry).toEqual(before);
          // A later exact read settles the original entry through both readers.
          server.threadPath = null;
          server.readTurns = [turn("consuming-turn", user)];
          expect(await host.nativeQueue!.evidence(entry)).toMatchObject({ clientUserMessageId: entry.clientUserMessageId, itemId: user.id });
          expect(await host.nativeQueue!.evidenceBatch!([entry, peer])).toEqual([
            expect.objectContaining({ clientUserMessageId: entry.clientUserMessageId, itemId: user.id }), null,
          ]);
          expect(server.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBe(false);
        } finally { await host.release(); }
      });

    test.each([false, true])("a persisted canonical item settles only its frozen queued send after an unreadable journal and restart (lost proof reply=%s)", async lostProofReply => {
      const threadId = "event-proof-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const eventStore = new FileRuntimeEventStore(path.join(metadataState, "events"));
      let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
      const registry = new AgentRegistry(path.join(metadataState, "registry.json"));
      const conversation = registry.ensureConversation("codex", path.join(metadataState, `${threadId}.jsonl`), "fixture");
      const filename = path.join(metadataState, "native.sqlite");
      let journal = new RuntimeJournal(filename, { structuredHosts: true });
      let readable = true;
      let refuseProof = true;
      let loseProofReply = lostProofReply;
      const client = {
        operationStatus: async (id: string) => journal.operationResult(id),
        nativeQueueRead: async (id: string) => {
          if (!readable) throw new Error("runtime journal unavailable");
          return journal.nativeQueueRead(id);
        },
        nativeQueueTransition: async (id: string, change: Parameters<RuntimeJournal["nativeQueueTransition"]>[1]) => {
          if (change.phase === "proven" && refuseProof) throw new Error("proof write unavailable");
          const result = journal.nativeQueueTransition(id, change);
          if (change.phase === "proven" && loseProofReply) {
            loseProofReply = false;
            throw new Error("proof committed but reply lost");
          }
          return result;
        },
      } as RuntimeHostClient;
      const binding = { threadId, accountId: "fixture" };
      const executor = () => new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => binding,
        settled: entry => settleNativeQueueEntry(registry, entry) });
      const entry = (id: string) => journal.nativeQueueRead(conversation.id).find(row => row.entryId === id)!;
      const ids = ["consumed-send", "same-text-send", "changed-input-send"];
      try {
        journal.append({ scope: `session:${conversation.id}`, kind: "session-status", payload: {
          conversationId: conversation.id, sessionKey: { engine: "codex", sessionId: threadId }, hostKind: "codex-app-server",
          host: "hosted", turn: "running", activeTurnId: "busy-turn", accountId: binding.accountId,
          capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
        } });
        for (const id of ids) {
          const held = registry.holdDelivery(conversation.id, "same words", id, "text", [], null,
            { operationId: id, kind: "send", policy: "queue" });
          registry.beginDeliveryAttempt(held.id, held.generationId!);
          journal.executeOperation({ kind: "send", operationId: id, idempotencyKey: id,
            conversationId: conversation.id, text: "same words", policy: "queue" });
          // The real host prepares the frozen input for the ordinary send the journal converted.
          const version = entry(id).versions[0]!;
          const input = await host.nativeQueue!.prepare(entry(id), version);
          journal.nativeQueueTransition(id, { phase: "prepared", input });
          journal.nativeQueueTransition(id, { phase: "acknowledged", nativeSubmissionId: `native-${id}` });
        }
        const input = entry(ids[0]!).versions[0]!.input!;
        const user = { type: "userMessage", id: "canonical-consumed", clientId: ids[0],
          content: input.map(part => part.type === "text" ? { ...part, text_elements: [] } : part) };
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item: user });
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item: {
          ...user, id: "canonical-conflict", clientId: ids[2], content: [{ type: "text", text: "changed words" }],
        } });
        await waitForCondition(() => eventStore.load(threadId).some(event => event.kind === "item" && event.phase === "completed"), "canonical item was not persisted");
        server.turnsError = "canonical history temporarily unavailable";
        server.readError = server.turnsError;
        journal.executeOperation({ kind: "native-queue", action: "send-now", operationId: "uncertain-control", idempotencyKey: "uncertain-control",
          conversationId: conversation.id, binding, entryId: ids[0], expectedRevision: 1, turnId: "busy-turn" });
        journal.nativeQueueTransition("uncertain-control", { phase: "prepared", input });
        journal.nativeQueueTransition("uncertain-control", { phase: "uncertain", reason: "withdrawal not confirmed" });
        readable = false;
        await expect(executor().reconcile(conversation.id)).rejects.toThrow("runtime journal unavailable");
        expect(journal.operationResult(ids[0]!)?.receipt.status).toBe("queued");
        await host.release();
        journal.close();
        journal = new RuntimeJournal(filename, { structuredHosts: true });
        let successor = new FakeAppServer(threadId);
        successor.paginatedHistory = true;
        successor.turnsError = server.turnsError;
        successor.readError = server.readError;
        host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore, spawnProcess: fakeSpawn(successor) });
        readable = true;
        // A predecessor could have observed a rejection without persisting it.
        // The successor leaves the durable row queued until its own readback.
        await executor().reconcile(conversation.id);
        expect(entry(ids[0]!).proof).toBeNull();
        expect(journal.operationResult(ids[0]!)?.receipt.status).toBe("queued");
        successor.turnsError = successor.readError = null;
        successor.readTurns = [{ id: "consuming-turn", status: "completed", items: [user] }];
        expect(await executor().reconcile(conversation.id)).toBe(true);
        expect(journal.operationResult(ids[0]!)?.receipt.status).toBe("queued");
        // Once validated by this owner, the exact item survives a later outage.
        successor.turnsError = successor.readError = "canonical history temporarily unavailable";
        refuseProof = false;
        if (lostProofReply) {
          const snapshot = registry.deliverySnapshotForOperation(ids[0]!);
          registry.recordDeliveryOutcome(snapshot.deliveryOperationOwners[ids[0]!]!.deliveryId!, "failed", "verify-first", "unverified");
        }
        await executor().reconcile(conversation.id);
        expect(journal.operationResult(ids[0]!)?.receipt.status).toBe("delivered");
        if (lostProofReply) {
          // The journal committed, but the sender still needs settlement. Recover
          // using that durable proof after both the host and journal restart.
          await host.release();
          journal.close();
          journal = new RuntimeJournal(filename, { structuredHosts: true });
          expect(successor.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBe(false);
          successor = new FakeAppServer(threadId);
          successor.paginatedHistory = true;
          successor.turnsError = server.turnsError;
          successor.readError = server.readError;
          host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore, spawnProcess: fakeSpawn(successor) });
          await executor().reconcile(conversation.id);
        }
        expect(entry(ids[0]!).proof).toMatchObject({ clientUserMessageId: ids[0], turnId: "consuming-turn", itemId: user.id, revision: 1, input });
        const owner = registry.deliverySnapshotForOperation(ids[0]!).deliveryOperationOwners[ids[0]!]!;
        expect(owner.terminalState).toBe("delivered");
        if (!lostProofReply) expect(registry.deliverySnapshotForOperation(ids[0]!).heldDeliveries[owner.deliveryId]?.state).toBe("delivered");
        expect(entry(ids[0]!).mutationOperationId).toBe("uncertain-control");
        expect(journal.operationResult("uncertain-control")?.receipt.status).toBe("uncertain");
        for (const id of ids.slice(1)) {
          expect(entry(id).state).toBe("queued");
          expect(journal.operationResult(id)?.receipt.status).toBe("queued");
        }
        expect(journal.replay(0).events.filter(event => event.kind === "native-queue-changed" && event.payload.entryId === ids[0])).toHaveLength(1);
        await executor().reconcile(conversation.id);
        expect(successor.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBe(false);
      } finally { await host.release(); journal.close(); registry.close(); }
    }, 15000);

    test.each(["started", "foreign-thread", "foreign-client", "missing-item", "missing-thread", "missing-turn", "changed-input", "wrong-turn", "wrong-revision", "conflicting-items"])(
      "a canonical event with %s cannot prove a frozen native send", async scenario => {
        const threadId = "unproven-event-thread";
        const server = new FakeAppServer(threadId);
        server.paginatedHistory = true;
        const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
        try {
          const entry = queueEntry(threadId);
          entry.versions[0]!.input = await host.nativeQueue!.prepare(entry, entry.versions[0]!);
          if (scenario === "wrong-turn") entry.dispatchedTurnId = "expected-turn";
          if (scenario === "missing-turn" || scenario === "missing-thread") {
            entry.dispatchedTurnId = "observed-turn";
            server.notify("turn/started", { threadId, turn: { id: "observed-turn" } });
          }
          if (scenario === "wrong-revision") {
            entry.versions.push({ ...entry.versions[0]!, revision: 2, input: [{ type: "text", text: "new frozen input" }] });
            entry.revision = entry.dispatchedRevision = 2;
          }
          const item = { type: "userMessage", ...(scenario !== "missing-item" ? { id: "observed-item" } : {}),
            clientId: scenario === "foreign-client" ? "different-client" : entry.clientUserMessageId,
            content: scenario === "changed-input" ? [{ type: "text", text: "different input" }] : entry.versions[0]!.input };
          server.notify(scenario === "started" ? "item/started" : "item/completed", {
            ...(scenario === "missing-thread" ? {} : { threadId: scenario === "foreign-thread" ? "different-thread" : threadId }),
            ...(scenario === "missing-turn" ? {} : { turnId: "observed-turn" }), item,
          });
          if (scenario === "conflicting-items") server.notify("item/completed", { threadId, turnId: "another-turn", item: { ...item, id: "another-item" } });
          server.turnsError = "history unavailable";
          server.readError = server.turnsError;
          expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([null]);
          expect(await host.nativeQueue!.evidence(entry)).toBeNull();
          expect(server.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBe(false);
        } finally { await host.release(); }
      });

    test.each(["missing-thread", "missing-turn", "legacy", "foreign-provenance", "wrong-turn-provenance"])(
      "persisted %s items require canonical readback after restart", async scenario => {
        const threadId = "unbound-persisted-thread";
        const server = new FakeAppServer(threadId);
        server.paginatedHistory = true;
        const disk = new FileRuntimeEventStore(path.join(metadataState, "unbound-events"));
        const eventStore: RuntimeEventStore = {
          load: id => disk.load(id),
          append: (id, event) => {
            if (event.kind === "item" && scenario === "legacy") {
              const legacy = { ...event };
              delete legacy.codexItemIdentity;
              disk.append(id, legacy);
            } else if (event.kind === "item" && scenario.endsWith("provenance")) {
              disk.append(id, { ...event, codexItemIdentity: {
                threadId: scenario === "foreign-provenance" ? "other-thread" : threadId,
                turnId: scenario === "wrong-turn-provenance" ? "other-turn" : "observed-turn",
              } });
            } else disk.append(id, event);
          },
        };
        let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
        try {
          const entry = queueEntry(threadId);
          entry.dispatchedTurnId = "observed-turn";
          entry.versions[0]!.input = await host.nativeQueue!.prepare(entry, entry.versions[0]!);
          const item = { type: "userMessage", id: "persisted-user", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
          server.notify("turn/started", { threadId, turn: { id: "observed-turn" } });
          server.notify("item/completed", { item,
            ...(scenario === "missing-thread" ? {} : { threadId }),
            ...(scenario === "missing-turn" ? {} : { turnId: "observed-turn" }),
          });
          await waitForCondition(() => disk.load(threadId).some(event => event.kind === "item"), "item was not persisted");
          await host.release();
          const successor = new FakeAppServer(threadId);
          successor.paginatedHistory = true;
          successor.turnsError = successor.readError = "canonical history unavailable";
          host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: disk, spawnProcess: fakeSpawn(successor) });
          expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([null]);
          expect(await host.nativeQueue!.evidence(entry)).toBeNull();
          successor.turnsError = successor.readError = null;
          successor.readTurns = [{ id: "observed-turn", status: "completed", items: [item] }];
          expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([expect.objectContaining({ itemId: item.id, turnId: "observed-turn" })]);
          expect(successor.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
        } finally { await host.release(); }
      });

    test.each(["changed-input", "duplicate-client"])("a hydrated canonical conflict survives failed reads and adoption (%s)", async scenario => {
      const threadId = "conflicting-page-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const directory = path.join(metadataState, "conflict-events");
      let store = new FileRuntimeEventStore(directory);
      let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const journal = new RuntimeJournal(path.join(metadataState, "conflicting-page.sqlite"), { structuredHosts: true });
      const binding = { threadId, accountId: "fixture" };
      const conversationId = "conversation_fixture";
      const target = host as unknown as { rpc: (method: string, params: Record<string, unknown>, timeout?: number, preserve?: boolean) => Promise<unknown> };
      const originalRpc = target.rpc.bind(host);
      let rpcSpy: ReturnType<typeof spyOn> | undefined;
      try {
        journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
          conversationId, sessionKey: { engine: "codex", sessionId: threadId }, hostKind: "codex-app-server", host: "hosted", turn: "running",
          activeTurnId: "busy-turn", accountId: binding.accountId, provenance: "structured", capabilities: { nativeQueue: true, steer: true, structuredAttention: true },
        } });
        const entries: NativeQueueRecord[] = [];
        for (const id of ["conflicting-entry", "peer-entry"]) {
          journal.executeOperation({ kind: "send", operationId: id, idempotencyKey: id, conversationId, text: "Look at this", policy: "queue" });
          const admitted = journal.nativeQueueRead(conversationId).find(entry => entry.entryId === id)!;
          const input = await host.nativeQueue!.prepare(admitted, admitted.versions[0]!);
          journal.nativeQueueTransition(id, { phase: "prepared", input });
          journal.nativeQueueTransition(id, { phase: "acknowledged", nativeSubmissionId: `native-${id}` });
          entries.push(journal.nativeQueueRead(conversationId).find(entry => entry.entryId === id)!);
          server.notify("item/completed", { threadId, turnId: "consuming-turn", item: {
            type: "userMessage", id: `retained-${id}`, clientId: admitted.clientUserMessageId, content: input,
          } });
        }
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 2, "completed items were not retained");
        const entry = entries[0]!;
        const user = { type: "userMessage", id: "retained-conflicting-entry", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input! };
        const changed = { ...user, id: "changed-user", content: [{ type: "text", text: "canonical conflicting input" }] };
        let failedPages = 0;
        rpcSpy = spyOn(target, "rpc").mockImplementation(async (method, params, timeout, preserve) => {
          if (method === "thread/turns/list") {
            if (params.cursor) { failedPages++; throw new Error("older canonical page transport failed"); }
            return { data: [{ id: "consuming-turn", status: "completed", itemsView: "full", items: scenario === "changed-input" ? [changed] : [user, changed] }], nextCursor: "older-page" };
          }
          return originalRpc(method, params, timeout, preserve);
        });
        expect(await host.nativeQueue!.evidence(entry)).toBeNull();
        const before = journal.nativeQueueRead(conversationId).find(row => row.entryId === entry.entryId);
        const client = {
          nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
          operationStatus: async (id: string) => journal.operationResult(id),
          nativeQueueTransition: async (id: string, transition: Parameters<RuntimeJournal["nativeQueueTransition"]>[1]) => journal.nativeQueueTransition(id, transition),
        } as unknown as RuntimeHostClient;
        await new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => binding }).reconcile(conversationId);
        expect(failedPages).toBe(1);
        expect(journal.nativeQueueRead(conversationId).find(row => row.entryId === entry.entryId)).toEqual(before);
        expect(journal.operationResult(entry.entryId)!.receipt.status).toBe("queued");
        // The failed page does not erase the independent peer's exact retained proof.
        expect(journal.nativeQueueRead(conversationId).find(row => row.entryId === "peer-entry")).toMatchObject({
          state: "delivered", proof: { clientUserMessageId: "peer-entry", itemId: "retained-peer-entry" },
        });
        expect(journal.operationResult("peer-entry")!.receipt.status).toBe("delivered");
        rpcSpy.mockRestore();
        server.readError = server.turnsError = "canonical history unavailable";
        await new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => binding }).reconcile(conversationId);
        expect(journal.nativeQueueRead(conversationId).find(row => row.entryId === entry.entryId)).toEqual(before);
        await host.release();
        const successor = new FakeAppServer(threadId);
        successor.paginatedHistory = true;
        successor.readError = successor.turnsError = "canonical history unavailable";
        store = new FileRuntimeEventStore(directory);
        host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(successor) });
        await new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => binding }).reconcile(conversationId);
        expect(journal.nativeQueueRead(conversationId).find(row => row.entryId === entry.entryId)).toEqual(before);
        expect(journal.operationResult(entry.entryId)!.receipt.status).toBe("queued");
        successor.readError = successor.turnsError = null;
        successor.readTurns = [{ id: "consuming-turn", status: "completed", items: [{ ...user, id: "fresh-valid-item" }] }];
        await new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => binding }).reconcile(conversationId);
        expect(journal.nativeQueueRead(conversationId).find(row => row.entryId === entry.entryId)).toMatchObject({
          state: "delivered", proof: { clientUserMessageId: entry.clientUserMessageId, itemId: "fresh-valid-item" },
        });
        expect(successor.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
        expect(server.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
      } finally { rpcSpy?.mockRestore(); journal.close(); await host.release(); }
    });

    for (const batch of [false, true]) test(`canonical absence survives unavailable history and host adoption (batch=${batch})`, async () => {
      const threadId = "absent-then-unavailable";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const directory = path.join(metadataState, "absence-events");
      let store = new FileRuntimeEventStore(directory);
      let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      try {
        const entry = queueEntry(threadId);
        entry.versions[0]!.input = await host.nativeQueue!.prepare(entry, entry.versions[0]!);
        const user = { type: "userMessage", id: "retained-user", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item: user });
        await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && event.phase === "completed"), "item not retained");
        const evidence = async () => batch ? (await host.nativeQueue!.evidenceBatch!([entry]))[0] : host.nativeQueue!.evidence(entry);
        server.readTurns = [];
        expect(await evidence()).toBeNull();
        const afterAbsence = store.load(threadId).length;
        server.readError = server.turnsError = "history unavailable";
        expect(await evidence()).toBeNull();
        expect(store.load(threadId)).toHaveLength(afterAbsence);
        await host.release();
        const successor = new FakeAppServer(threadId);
        successor.paginatedHistory = true;
        successor.readError = successor.turnsError = "history unavailable";
        store = new FileRuntimeEventStore(directory);
        host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(successor) });
        expect(await evidence()).toBeNull();
        // A later canonical observation is fresh proof for the original identity.
        successor.readError = successor.turnsError = null;
        successor.readTurns = [{ id: "consuming-turn", status: "completed", items: [{ ...user, id: "fresh-canonical-user" }] }];
        expect(await evidence()).toMatchObject({ clientUserMessageId: entry.clientUserMessageId, itemId: "fresh-canonical-user" });
        for (const source of [server, successor]) {
          expect(source.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
        }
      } finally { await host.release(); }
    });

    for (const batch of [false, true]) for (const owns of [false, true]) for (const conflicting of [false, true]) test(`a held native queue read respects writer ownership (batch=${batch}, owns=${owns}, conflicting=${conflicting})`, async () => {
      const threadId = "revoked-proof-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const store = new MemoryEventStore();
      const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const target = host as unknown as { rpc: (method: string, params: Record<string, unknown>, timeout?: number, preserve?: boolean) => Promise<unknown> };
      const originalRpc = target.rpc.bind(host);
      let entered!: () => void;
      const readEntered = new Promise<void>(resolve => { entered = resolve; });
      let resume!: () => void;
      const held = new Promise<void>(resolve => { resume = resolve; });
      let rpcSpy: ReturnType<typeof spyOn> | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        const entry = queueEntry(threadId);
        entry.versions[0]!.input = await host.nativeQueue!.prepare(entry, entry.versions[0]!);
        const user = { type: "userMessage", id: "retained-user", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item: user });
        await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && event.phase === "completed"), "item not retained");
        server.readTurns = [{ id: "consuming-turn", status: "completed", items: [conflicting
          ? { ...user, content: [{ type: "text", text: "different canonical input" }] } : user] }];
        rpcSpy = spyOn(target, "rpc").mockImplementation(async (method, params, timeout, preserve) => {
          const result = await originalRpc(method, params, timeout, preserve);
          if (method === "thread/turns/list") { entered(); await held; }
          return result;
        });
        pending = batch ? host.nativeQueue!.evidenceBatch!([entry]) : host.nativeQueue!.evidence(entry);
        await readEntered;
        const before = store.load(threadId);
        host.setWriterFence(() => owns);
        resume();
        const proof = expect.objectContaining({ clientUserMessageId: entry.clientUserMessageId, itemId: user.id });
        const expected = conflicting ? null : proof;
        expect(await pending).toEqual(batch ? [expected] : expected);
        if (!owns || !conflicting) expect(store.load(threadId)).toEqual(before);
        server.readError = server.turnsError = "canonical history unavailable";
        const retained = owns && !conflicting ? proof : null;
        expect(await (batch ? host.nativeQueue!.evidenceBatch!([entry]) : host.nativeQueue!.evidence(entry))).toEqual(batch ? [retained] : retained);
        expect(server.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
      } finally {
        resume();
        await pending?.catch(() => {});
        rpcSpy?.mockRestore();
        host.setWriterFence(() => true);
        await host.release();
      }
    });

    test.each([false, true])("a canonical validation deadline retains an exact completed item and rejects observed conflicts (conflicting peer=%s)", async conflictingPeer => {
      const threadId = "proof-deadline-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const store = new MemoryEventStore();
      const host = await CodexAppServerHost.start({ cwd: "/repo", requestTimeoutMs: 5000, eventStore: store, spawnProcess: fakeSpawn(server) });
      let restoreClock: (() => void) | undefined;
      let restoreProof: (() => void) | undefined;
      try {
        const entry = queueEntry(threadId);
        const peer = queueEntry(threadId, { operationId: "conflicting-peer" });
        peer.entryId = peer.clientUserMessageId = "conflicting-peer";
        const entries = conflictingPeer ? [entry, peer] : [entry];
        const users = [];
        for (const candidate of entries) {
          candidate.versions[0]!.input = await host.nativeQueue!.prepare(candidate, candidate.versions[0]!);
          const user = { type: "userMessage", id: `deadline-${candidate.entryId}`, clientId: candidate.clientUserMessageId, content: candidate.versions[0]!.input };
          users.push(user);
          server.notify("item/completed", { threadId, turnId: "deadline-turn", item: user });
        }
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === entries.length, "completed items were not retained");
        server.readTurns = [{ id: "deadline-turn", status: "completed", items: users.map((user, index) => index === 0 ? user
          : { ...user, content: [{ type: "text", text: "different canonical input" }] }) }];
        expect(await host.nativeQueue!.evidence(entry)).toMatchObject({ itemId: users[0]!.id });
        let now = Date.now();
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        restoreClock = () => clock.mockRestore();
        type History = import("./codexHistoryReader").CodexDeliveryHistoryResult;
        const target = host as unknown as { nativeQueueProof(entry: NativeQueueRecord, history: History): unknown };
        const originalProof = target.nativeQueueProof.bind(host);
        let deadlineCrossed = false;
        const proof = spyOn(target, "nativeQueueProof").mockImplementation((candidate, history) => {
          const result = originalProof(candidate, history);
          if (!deadlineCrossed && result && history.state === "observed" && history.pages.length > 0) {
            deadlineCrossed = true;
            now += 5001;
          }
          return result;
        });
        restoreProof = () => proof.mockRestore();
        const result = await host.nativeQueue!.evidenceBatch!(entries);
        expect(deadlineCrossed).toBeTrue();
        expect(result).toEqual([expect.objectContaining({ threadId, clientUserMessageId: entry.clientUserMessageId,
          revision: 1, turnId: "deadline-turn", itemId: users[0]!.id, input: entry.versions[0]!.input }), ...(conflictingPeer ? [null] : [])]);
      } finally { restoreProof?.(); restoreClock?.(); await host.release(); }
    });

    async function durableQueueFixture(host: CodexAppServerHost, threadId: string) {
      const conversationId = "conversation_fixture";
      const binding = { threadId, accountId: "fixture" };
      const journal = new RuntimeJournal(path.join(metadataState, "rejected-evidence.sqlite"), { structuredHosts: true });
      journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
        conversationId, sessionKey: { engine: "codex", sessionId: threadId }, hostKind: "codex-app-server", host: "hosted", turn: "running",
        activeTurnId: "busy-turn", accountId: "fixture", provenance: "structured", capabilities: { nativeQueue: true, steer: true, structuredAttention: true },
      } });
      journal.executeOperation({ kind: "send", operationId: "rejected-entry", idempotencyKey: "rejected-entry-key", conversationId, text: "Look at this", policy: "queue" });
      let entry = journal.nativeQueueRead(conversationId)[0]!;
      const input = await host.nativeQueue!.prepare(entry, entry.versions[0]!);
      journal.nativeQueueTransition(entry.entryId, { phase: "prepared", input });
      journal.nativeQueueTransition(entry.entryId, { phase: "acknowledged", nativeSubmissionId: "rejected-native-entry" });
      entry = journal.nativeQueueRead(conversationId)[0]!;
      const client = {
        nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
        operationStatus: async (id: string) => journal.operationResult(id),
        nativeQueueTransition: async (id: string, change: Parameters<RuntimeJournal["nativeQueueTransition"]>[1]) => journal.nativeQueueTransition(id, change),
      } as RuntimeHostClient;
      return { entry, journal, async reconcile(currentHost: CodexAppServerHost) {
        return new NativeQueueExecutor({ client, resolveHost: () => currentHost, binding: () => binding }).reconcile(conversationId);
      } };
    }

    test.each(["absent", "conflict"])("rejected evidence: replaying a rejected completed item cannot revive its proof (%s)", async scenario => {
      const threadId = "rejected-replay-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const store = new MemoryEventStore();
      let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const durable = await durableQueueFixture(host, threadId);
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "already-rejected-item", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 1, "first item was not retained");
        server.readTurns = scenario === "absent" ? [] : [{ id: "consuming-turn", status: "completed", items: [{ ...item, content: [{ type: "text", text: "different canonical payload" }] }] }];
        expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([null]);
        server.readError = server.turnsError = "canonical history unavailable";
        expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([null]);
        const rejectionCount = store.load(threadId).filter(event => event.kind === "native-queue-changed" && event.evidenceRejectedFor).length;
        for (let replay = 0; replay < 3; replay++) {
          server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
          await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === replay + 2, "replayed item was not retained");
          await durable.reconcile(host);
          expect(await host.nativeQueue!.evidence(entry)).toBeNull();
          expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
        }
        expect(store.load(threadId).filter(event => event.kind === "native-queue-changed" && event.evidenceRejectedFor)).toHaveLength(rejectionCount);
        expect(server.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
        await host.release();
        const successor = new FakeAppServer(threadId);
        successor.paginatedHistory = true;
        successor.readError = successor.turnsError = "canonical history unavailable";
        host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(successor) });
        successor.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 5, "adopted replay was not retained");
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
      } finally { durable.journal.close(); await host.release(); }
    });

    test.each(["item", "turn", "canonical"])("rejected evidence: fresh %s proof stays eligible after rejecting an old identity", async fresh => {
      const threadId = "fresh-proof-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const store = new MemoryEventStore();
      const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const durable = await durableQueueFixture(host, threadId);
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "old-item", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        server.notify("item/completed", { threadId, turnId: "old-turn", item });
        await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && event.phase === "completed"), "item was not retained");
        server.readTurns = [];
        expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([null]);
        const turnId = fresh === "turn" ? "fresh-turn" : "old-turn";
        const valid = fresh === "item" ? { ...item, id: "fresh-item" } : item;
        if (fresh === "canonical") {
          server.readTurns = [{ id: turnId, status: "completed", items: [valid] }];
          expect(await host.nativeQueue!.evidence(entry)).toMatchObject({ itemId: valid.id, turnId });
        }
        server.readError = server.turnsError = "canonical history unavailable";
        if (fresh !== "canonical") {
          server.notify("item/completed", { threadId, turnId, item: valid });
          await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 2, "fresh item was not retained");
        }
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toMatchObject({
          state: "delivered", proof: { itemId: valid.id, turnId, clientUserMessageId: entry.clientUserMessageId },
        });
        expect(server.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
      } finally { durable.journal.close(); await host.release(); }
    });

    test("rejected evidence: a canonical rejection invalidates validated items outside the notification window", async () => {
      const threadId = "window-rejection-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const store = new MemoryEventStore();
      const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const durable = await durableQueueFixture(host, threadId);
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "validated-item", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && event.phase === "completed"), "item was not retained");
        server.readTurns = [{ id: "consuming-turn", status: "completed", items: [item] }];
        expect(await host.nativeQueue!.evidence(entry)).toMatchObject({ itemId: item.id });
        for (let index = 0; index < 128; index++) server.notify("item/completed", {
          threadId, turnId: "other-turn", item: { type: "agentMessage", id: `other-item-${index}`, text: "Other activity" },
        });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 129, "activity did not advance the window");
        server.readTurns = [];
        expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([null]);
        server.readError = server.turnsError = "canonical history unavailable";
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 130, "replayed item was not retained");
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
      } finally { durable.journal.close(); await host.release(); }
    });

    test("rejected evidence: saturating the rejection fence requires canonical proof across adoption", async () => {
      const threadId = "bounded-rejection-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const directory = path.join(metadataState, "bounded-rejection-events");
      const store = new FileRuntimeEventStore(directory);
      let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const durable = await durableQueueFixture(host, threadId);
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "rejected-item-0", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        for (let index = 0; index < 129; index++) {
          server.notify("item/completed", { threadId, turnId: "consuming-turn", item: { ...item, id: `rejected-item-${index}` } });
          await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === index + 1, "item was not retained");
          expect(await host.nativeQueue!.evidence(entry)).toBeNull();
        }
        const rejectionCount = store.load(threadId).filter(event => event.kind === "native-queue-changed" && event.evidenceRejectedFor).length;
        for (let retry = 0; retry < 3; retry++) expect(await host.nativeQueue!.evidence(entry)).toBeNull();
        expect(store.load(threadId).filter(event => event.kind === "native-queue-changed" && event.evidenceRejectedFor)).toHaveLength(rejectionCount);
        server.readError = server.turnsError = "canonical history unavailable";
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        server.notify("item/completed", { threadId, turnId: "fresh-turn", item: { ...item, id: "new-item" } });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 131, "replayed items were not retained");
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
        await host.release();
        const successor = new FakeAppServer(threadId);
        successor.paginatedHistory = true;
        successor.readError = successor.turnsError = "canonical history unavailable";
        host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: new FileRuntimeEventStore(directory), spawnProcess: fakeSpawn(successor) });
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
        successor.readError = successor.turnsError = null;
        successor.readTurns = [{ id: "consuming-turn", status: "completed", items: [item] }];
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toMatchObject({ state: "delivered", proof: { itemId: item.id } });
      } finally { durable.journal.close(); await host.release(); }
    });

    test.each(["absent", "conflict"])("rejected evidence: a canonical rejection during writer handoff survives adoption (%s)", async scenario => {
      const threadId = "rejected-handoff-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const directory = path.join(metadataState, "rejected-handoff-events");
      const store = new FileRuntimeEventStore(directory);
      let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      let entered!: () => void;
      const readEntered = new Promise<void>(resolve => { entered = resolve; });
      let resume!: () => void;
      const held = new Promise<void>(resolve => { resume = resolve; });
      let pending: Promise<unknown> | undefined;
      let rpcSpy: ReturnType<typeof spyOn> | undefined;
      const durable = await durableQueueFixture(host, threadId);
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "old-handoff-item", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && event.phase === "completed"), "item was not retained");
        server.readTurns = scenario === "absent" ? [] : [{ id: "consuming-turn", status: "completed", items: [{ ...item, content: [{ type: "text", text: "different canonical payload" }] }] }];
        const target = host as unknown as { rpc: (method: string, params: Record<string, unknown>, timeout?: number, preserve?: boolean) => Promise<unknown> };
        const originalRpc = target.rpc.bind(host);
        rpcSpy = spyOn(target, "rpc").mockImplementation(async (method, params, timeout, preserve) => {
          const result = await originalRpc(method, params, timeout, preserve);
          if (method === "thread/turns/list") { entered(); await held; }
          return result;
        });
        pending = host.nativeQueue!.evidenceBatch!([entry]);
        await readEntered;
        host.setWriterFence(() => false);
        resume();
        expect(await pending).toEqual([null]);
        rpcSpy.mockRestore();
        await host.release();
        const successor = new FakeAppServer(threadId);
        successor.paginatedHistory = true;
        successor.readError = successor.turnsError = "canonical history unavailable";
        host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: new FileRuntimeEventStore(directory), spawnProcess: fakeSpawn(successor) });
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
        expect(successor.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
        successor.readError = successor.turnsError = null;
        successor.readTurns = [{ id: "consuming-turn", status: "completed", items: [{ ...item, id: "fresh-canonical-item" }] }];
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toMatchObject({ state: "delivered", proof: { itemId: "fresh-canonical-item" } });
      } finally {
        resume(); await pending?.catch(() => {}); rpcSpy?.mockRestore();
        durable.journal.close(); host.setWriterFence(() => true); await host.release();
      }
    });

    test("rejected evidence: an in-flight canonical conflict dominates a replay before a later page fails", async () => {
      const threadId = "inflight-conflict-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const store = new MemoryEventStore();
      const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const durable = await durableQueueFixture(host, threadId);
      let rpcSpy: ReturnType<typeof spyOn> | undefined;
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "rejected-inflight-item", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 1, "old item was not retained");
        const target = host as unknown as { rpc: (method: string, params: Record<string, unknown>, timeout?: number, preserve?: boolean) => Promise<unknown> };
        const originalRpc = target.rpc.bind(host);
        let olderPages = 0;
        rpcSpy = spyOn(target, "rpc").mockImplementation(async (method, params, timeout, preserve) => {
          if (method !== "thread/turns/list") return originalRpc(method, params, timeout, preserve);
          if (params.cursor) {
            olderPages++;
            server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
            await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 2, "replayed item was not retained");
            throw new Error("older page transport failed");
          }
          return { data: [{ id: "consuming-turn", status: "completed", itemsView: "full", items: [{ ...item, content: [{ type: "text", text: "different canonical payload" }] }] }], nextCursor: "older-page" };
        });
        await durable.reconcile(host);
        expect(olderPages).toBe(1);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
      } finally { rpcSpy?.mockRestore(); durable.journal.close(); await host.release(); }
    });


    test("rejected evidence: a canonical rejection whose ledger append fails cannot revive after adoption", async () => {
      const threadId = "rejected-ledger-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const directory = path.join(metadataState, "rejected-ledger-events");
      const store = new FileRuntimeEventStore(directory);
      let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const durable = await durableQueueFixture(host, threadId);
      let appendSpy: ReturnType<typeof spyOn> | undefined;
      let rejectionWrites = 0;
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "old-ledger-item", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).some(event => event.kind === "item" && event.phase === "completed"), "item was not retained");
        server.readTurns = [{ id: "consuming-turn", status: "completed", items: [{ ...item, content: [{ type: "text", text: "different canonical payload" }] }] }];
        const originalAppend = store.append.bind(store);
        appendSpy = spyOn(store, "append").mockImplementation((id, event) => {
          if (event.kind === "native-queue-changed" && "evidenceRejectedFor" in event) {
            rejectionWrites++;
            throw new Error("injected invalidation write failure");
          }
          return originalAppend(id, event);
        });
        expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([null]);
        expect(rejectionWrites).toBe(1);
        await host.release();
        appendSpy.mockRestore();
        const successor = new FakeAppServer(threadId);
        successor.paginatedHistory = true;
        successor.readError = successor.turnsError = "canonical history unavailable";
        host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: new FileRuntimeEventStore(directory), spawnProcess: fakeSpawn(successor) });
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
      } finally { appendSpy?.mockRestore(); durable.journal.close(); await host.release(); }
    });
    test.each(["canonical-first", "aged-conflict", "aged-absence"])("rejected identity survives delayed or aged notifications (%s)", async scenario => {
      const threadId = "notification-order-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const store = new MemoryEventStore();
      const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const durable = await durableQueueFixture(host, threadId);
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "known-conflicting-item", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        let count = 0;
        if (scenario !== "canonical-first") {
          server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
          for (let index = 0; index < 128; index++) server.notify("item/completed", {
            threadId, turnId: "activity-turn", item: { type: "agentMessage", id: `activity-${index}`, text: "Other activity" },
          });
          count = 129;
          await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === count, "items were not retained");
        }
        server.readTurns = scenario === "aged-absence" ? [] : [{ id: "consuming-turn", status: "completed", items: [{ ...item, content: [{ type: "text", text: "canonical payload differs" }] }] }];
        expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([null]);
        server.readError = server.turnsError = "canonical history unavailable";
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === count + 1, "replayed item was not retained");
        await durable.reconcile(host);
        expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
        expect(server.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
      } finally { durable.journal.close(); await host.release(); }
    });

    test("unvalidated notification overflow requires canonical proof through journal restart and adoption", async () => {
      const threadId = "observed-capacity-thread";
      const server = new FakeAppServer(threadId);
      server.paginatedHistory = true;
      const directory = path.join(metadataState, "observed-capacity-events");
      const store = new FileRuntimeEventStore(directory);
      let host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
      const durable = await durableQueueFixture(host, threadId);
      let reopened: RuntimeJournal | undefined;
      try {
        const entry = durable.entry;
        const item = { type: "userMessage", id: "unvalidated-item", clientId: entry.clientUserMessageId, content: entry.versions[0]!.input };
        for (let index = 0; index < 128; index++) server.notify("item/completed", {
          threadId, turnId: "activity-turn", item: { ...item, id: `peer-${index}`, clientId: `peer-${index}` },
        });
        server.notify("item/completed", { threadId, turnId: "consuming-turn", item });
        await waitForCondition(() => store.load(threadId).filter(event => event.kind === "item" && event.phase === "completed").length === 129, "items were not retained");
        server.readError = server.turnsError = "canonical history unavailable";
        for (let retry = 0; retry < 3; retry++) {
          await durable.reconcile(host);
          expect(durable.journal.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
        }
        await host.release();
        durable.journal.close();
        reopened = new RuntimeJournal(path.join(metadataState, "rejected-evidence.sqlite"), { structuredHosts: true });
        const successor = new FakeAppServer(threadId);
        successor.paginatedHistory = true;
        successor.readError = successor.turnsError = "canonical history unavailable";
        host = await CodexAppServerHost.adopt(threadId, { cwd: "/repo", eventStore: new FileRuntimeEventStore(directory), spawnProcess: fakeSpawn(successor) });
        const client = {
          nativeQueueRead: async (id: string) => reopened!.nativeQueueRead(id),
          operationStatus: async (id: string) => reopened!.operationResult(id),
          nativeQueueTransition: async (id: string, change: Parameters<RuntimeJournal["nativeQueueTransition"]>[1]) => reopened!.nativeQueueTransition(id, change),
        } as RuntimeHostClient;
        const executor = new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => entry.binding });
        await executor.reconcile(entry.conversationId);
        expect(reopened.nativeQueueRead(entry.conversationId)[0]).toEqual(entry);
        successor.readError = successor.turnsError = null;
        successor.readTurns = [{ id: "consuming-turn", status: "completed", items: [item] }];
        expect(await host.nativeQueue!.evidence(entry)).toMatchObject({ itemId: item.id });
        successor.readError = successor.turnsError = "canonical history unavailable";
        await executor.reconcile(entry.conversationId);
        expect(reopened.nativeQueueRead(entry.conversationId)[0]).toMatchObject({ state: "delivered", proof: { itemId: item.id } });
        for (const transport of [server, successor]) {
          expect(transport.requests.some(request => ["turn/start", "turn/steer", "thread/queue/add"].includes(String(request.method)))).toBeFalse();
        }
      } finally { if (reopened) reopened.close(); else durable.journal.close(); await host.release(); }
    });

    test("an image entry the engine recorded as a data URL is proven", async () => {
      const server = new FakeAppServer("image-native-thread");
      server.userAgent = "codex_desktop_app/0.154.0 (Linux)";
      server.paginatedHistory = true;
      const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
      try {
        const bytes = Buffer.from("fixture-image-bytes");
        const { createHash } = await import("node:crypto");
        const image = {sha256: createHash("sha256").update(bytes).digest("hex"), mime: "image/png" as const, bytes: bytes.length};
        const entry = queueEntry("image-native-thread", {images: [image]});
        entry.versions[0].input = [
          {type: "localImage", path: `/runtime-images/${image.sha256}.png`},
          {type: "text", text: "Look at this", text_elements: []},
        ];
        server.readTurns = [{id: "turn-1", status: "completed", items: [{type: "userMessage", id: "canonical-user", clientId: entry.clientUserMessageId,
          content: [{type: "image", url: `data:image/png;base64,${bytes.toString("base64")}`}, {type: "text", text: "Look at this", text_elements: []}]}]}];
        expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([expect.objectContaining({itemId: "canonical-user"})]);
      } finally { await host.release(); }
    }, 15000);
  });

  test("confirms native queue delivery and materialization across 316 turns within existing bounds", async () => {
    const server = new FakeAppServer("long-native-thread");
    server.userAgent = "codex_desktop_app/0.154.0 (Linux)";
    server.paginatedHistory = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    });
    try {
      expect(host.nativeQueue).toBeDefined();
      const entry: NativeQueueRecord = {
        entryId: "long-history-send", conversationId: "conversation_fixture",
        binding: {threadId: "long-native-thread", accountId: "fixture"},
        clientUserMessageId: "long-history-send", nativeSubmissionId: "native-submission",
        revision: 1, versions: [{revision: 1, operationId: "long-history-send", text: "Continue the authorized review", images: [], contentDigest: "fixture-digest", selectedContext: COMPACT_SELECTED, origin: { kind: "agent", role: "orchestrator" }}],
        profilePolicy: "thread-at-dispatch", state: "queued", mutationOperationId: null,
        dispatchedRevision: null, dispatchedTurnId: null, proof: null, reason: null,
      };
      entry.versions[0].input = await host.nativeQueue!.prepare(entry, entry.versions[0]);
      const preparedText = entry.versions[0].input.find((part) => part.type === "text");
      expect(preparedText?.type === "text" && preparedText.text.split("\n")[0]!.length).toBeLessThanOrEqual(96);
      const user = {type: "userMessage", id: "canonical-user", clientId: entry.clientUserMessageId, content: entry.versions[0].input};
      // Match the observed 316-turn, roughly 2,500-item / 12 MB projection.
      // The target is recent; reading unrelated history must fit the original
      // 128-response / 16 MiB bounds without creating any new model turn.
      server.readTurns = Array.from({length: 316}, (_, index) => ({
        id: `history-${index}`, status: "completed", items: [
          ...Array.from({length: 7}, (_, tool) => ({type: "commandExecution", id: `tool-${index}-${tool}`, aggregatedOutput: "x".repeat(5500)})),
          ...(index === 315 ? [user] : [{type: "agentMessage", id: `answer-${index}`, text: "Earlier answer"}]),
        ],
      }));
      expect(await host.nativeQueue!.evidence(entry)).toMatchObject({clientUserMessageId: entry.clientUserMessageId, turnId: "history-315", itemId: user.id});
      expect(await host.nativeQueue!.evidenceBatch!([entry])).toEqual([expect.objectContaining({itemId: user.id})]);
      expect(await host.sessionMaterializationEvidence(entry.clientUserMessageId)).toEqual({state: "materialized"});
      const mismatched = structuredClone(entry);
      mismatched.versions[0].input = [{type: "text", text: "Different payload"}];
      expect(await host.nativeQueue!.evidence(mismatched)).toBeNull();
      const foreign = {...entry, binding: {...entry.binding, threadId: "foreign-thread"}};
      expect(await host.nativeQueue!.evidence(foreign)).toBeNull();
      (server.readTurns[315] as {items: unknown[]}).items.pop();
      expect(await host.nativeQueue!.evidence(entry)).toBeNull();
      expect(server.requests.some(r => r.method === "turn/start" || r.method === "turn/steer" || r.method === "thread/queue/add")).toBeFalse();
      expect((await host.send({id: "fresh-long-history-message", text: "A fresh authorized message"})).outcome).toBe("turn-started");
    } finally { await host.release(); }
  }, 15000);

  test("native-history transport refusals never authorize a first delivery", async () => {
    const server = new FakeAppServer("refused-first-thread");
    server.paginatedHistory = true;
    server.readError = "permission denied";
    const host = await CodexAppServerHost.start({
      cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    });
    try {
      await expect(host.send({ id: "refused-first", text: "hello" }))
        .rejects.toThrow("Codex canonical history is unavailable: transport");
      expect(server.requests.some(request => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
    } finally { await host.release(); }
  });

  test("journal first-dispatch evidence avoids a cold history scan while retaining collision checks", async () => {
    const server = new FakeAppServer("journal-first-thread");
    server.paginatedHistory = true;
    const host = await CodexAppServerHost.start({cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server)});
    server.readError = "history transport is unavailable";
    try {
      await expect(host.send({id: "wrong-binding", text: "hello"}, {operationId: "different", writerClaim: "owner:1", firstDispatch: true}))
        .rejects.toThrow("Codex canonical history is unavailable");
      expect(server.requests.some(request => request.method === "turn/start")).toBeFalse();
      const input = {id: "fresh-authorized", text: "hello"};
      const proof = {operationId: input.id, writerClaim: "owner:1", firstDispatch: true as const};
      expect((await host.send(input, proof)).outcome).toBe("turn-started");
      expect((await host.send(input, proof)).outcome).toBe("turn-started");
      await expect(host.send({...input, text: "changed"}, proof)).rejects.toThrow("different payload");
      expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    } finally { await host.release(); }
  });

  test("a successful hydrated read with no turns defers to the rollout on disk (#1332)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-empty-hydration-"));
    const rollout = path.join(directory, "empty-hydration-thread.jsonl");
    const server = new FakeAppServer("empty-hydration-thread");
    server.threadPath = rollout;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-empty-hydration", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    await expect(host.sessionMaterializationEvidence("operation-empty-hydration")).resolves.toEqual({
      state: "absent",
      reason: "Codex app-server did not read back the confirmed first message",
    });
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: "t1",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn-1",
        item: { type: "UserMessage", id: "item-1", client_id: "operation-empty-hydration", content: [{ type: "text", text: "hello" }] },
      },
    })}\n`);
    await expect(host.sessionMaterializationEvidence("operation-empty-hydration")).resolves.toEqual({
      state: "materialized",
    });
    await host.release();
  });

  test("rolloutTurnsFromDisk parses once per file change and refreshes on append", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rollout-cache-"));
    const rollout = path.join(directory, "cached-thread.jsonl");
    const record = (turn: string, clientId: string) => `${JSON.stringify({
      timestamp: "t",
      type: "event_msg",
      payload: { type: "item_completed", turn_id: turn, item: { type: "UserMessage", id: clientId, client_id: clientId, content: [] } },
    })}\n`;
    fs.writeFileSync(rollout, record("turn-1", "first"));
    const initial = rolloutTurnsFromDisk(rollout);
    expect(initial.length).toBe(1);
    /* A caller mutating its returned page must not poison later reads. */
    initial.pop();
    expect(rolloutTurnsFromDisk(rollout).length).toBe(1);
    fs.appendFileSync(rollout, record("turn-2", "second"));
    const refreshed = rolloutTurnsFromDisk(rollout);
    expect(refreshed.length).toBe(2);
    expect((refreshed[1] as { id?: string }).id).toBe("turn-2");
  });

  test("a rollout on disk outranks the engine's not-materialized answer (#1332)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-disk-outranks-"));
    const rollout = path.join(directory, "disk-outranks-thread.jsonl");
    const server = new FakeAppServer("disk-outranks-thread");
    server.threadPath = rollout;
    server.readError = "thread disk-outranks-thread is not materialized yet; includeTurns is unavailable before first user message";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-disk-outranks", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    await expect(host.sessionMaterializationEvidence("operation-disk-outranks")).resolves.toEqual({
      state: "absent",
      reason: "Codex app-server has not materialized the confirmed first message yet",
    });
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: "t1",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn-1",
        item: { type: "UserMessage", id: "item-1", client_id: "operation-disk-outranks", content: [{ type: "text", text: "hello" }] },
      },
    })}\n`);
    await expect(host.sessionMaterializationEvidence("operation-disk-outranks")).resolves.toEqual({
      state: "materialized",
    });
    await host.release();
  });

  test("fails materialization only after the confirmed first turn ends without a session", async () => {
    const server = new FakeAppServer("failed-materialization-thread");
    server.readError = "thread failed-materialization-thread is not materialized yet; includeTurns is unavailable before first user message";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-materialization", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    await expect(host.sessionMaterializationEvidence("operation-materialization")).resolves.toEqual({
      state: "absent",
      reason: "Codex app-server has not materialized the confirmed first message yet",
    });

    server.notify("turn/completed", {
      threadId: "failed-materialization-thread",
      turn: { id: "turn-1", status: "completed" },
    });
    await expect(host.sessionMaterializationEvidence("operation-materialization")).resolves.toEqual({
      state: "failed",
      reason: "Codex app-server completed the confirmed first turn without materializing its session",
    });
    await host.release();
  });

  test("classifies a terminal thread/read rejection as failed materialization evidence", async () => {
    const server = new FakeAppServer("rejected-materialization-thread");
    server.readError = "thread rejected-materialization-thread not found";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    await expect(host.sessionMaterializationEvidence("operation-rejected")).resolves.toMatchObject({
      state: "failed",
      reason: expect.stringContaining("thread rejected-materialization-thread not found"),
    });
    await host.release();
  });

  test("keeps a transient thread/read rejection inconclusive", async () => {
    const server = new FakeAppServer("transient-materialization-thread");
    server.readError = "service temporarily unavailable";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    await expect(host.sessionMaterializationEvidence("operation-transient")).resolves.toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("service temporarily unavailable"),
    });
    await host.release();
  });

  test("confirms the persisted first message from thread/read materialization evidence", async () => {
    const server = new FakeAppServer("materialized-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-materialized", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    server.readTurns = [{
      id: "turn-1",
      status: "inProgress",
      items: [{ type: "userMessage", clientId: "operation-materialized", content: [{ type: "text", text: "hello" }] }],
    }];
    await expect(host.sessionMaterializationEvidence("operation-materialized")).resolves.toEqual({
      state: "materialized",
    });
    await host.release();
  });

  test("a paginated thread that refuses hydration still proves materialization from the rollout on disk (#1332)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-paginated-evidence-"));
    const rollout = path.join(directory, "paginated-evidence-thread.jsonl");
    const server = new FakeAppServer("paginated-evidence-thread");
    server.threadPath = rollout;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-paginated", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    server.hydratedReadError = "list_turns is not supported yet";
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: "t1",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn-1",
        item: { type: "UserMessage", id: "item-1", client_id: "operation-paginated", content: [{ type: "text", text: "hello" }] },
      },
    })}\n`);
    await expect(host.sessionMaterializationEvidence("operation-paginated")).resolves.toEqual({
      state: "materialized",
    });
    expect(server.requests.filter((request) => request.method === "thread/turns/list")).toHaveLength(1);
    const fallbackRead = server.requests.findLast((request) => request.method === "thread/read");
    expect((fallbackRead?.params as { includeTurns?: boolean }).includeTurns).toBeUndefined();
    await host.release();
  });

  test("the disk fallback still reports an absent first message (#1332)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-paginated-absent-"));
    const rollout = path.join(directory, "paginated-absent-thread.jsonl");
    const server = new FakeAppServer("paginated-absent-thread");
    server.threadPath = rollout;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "operation-paginated-absent", text: "hello" })).toEqual({
      outcome: "turn-started",
      turnId: "turn-1",
    });
    server.hydratedReadError = "list_turns is not supported yet";
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: "t1",
      type: "event_msg",
      payload: { type: "item_completed", turn_id: "turn-1", item: { type: "AgentMessage", id: "item-2", text: "working" } },
    })}\n`);
    await expect(host.sessionMaterializationEvidence("operation-paginated-absent")).resolves.toEqual({
      state: "absent",
      reason: "Codex app-server did not read back the confirmed first message",
    });
    await host.release();
  });
});
