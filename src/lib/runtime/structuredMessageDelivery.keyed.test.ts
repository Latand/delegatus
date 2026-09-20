import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { serveRuntimeHost } from "@/runtime-host/socket";
import * as runtimeClient from "./client";
import { runtimeScope } from "./contracts";
import { runtimeHostEndpoint } from "./localEndpoint";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { handleRuntimeCommand } from "./http";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-keyed-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const p95 = (values: number[]) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!;

test("HTTP admission stays keyed as thousands of unrelated sessions and reservations accumulate", async () => {
  const filename = path.join(root, "registry.json");
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  seed.reconcileConversations([{
    engine: "codex", path: "/sessions/keyed-target.jsonl", accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date().toISOString(),
  }]);
  const target = seed.conversationForPath("/sessions/keyed-target.jsonl")!;
  const generation = target.generations.at(-1)!;
  seed.upsert({ key: { engine: "codex", sessionId: generation.id }, artifactPath: generation.path,
    cwd: "/repo", accountId: "default", status: "idle", host: null, claimEpoch: 1,
    claimOwner: null, pendingAction: null });
  const held = seed.holdDelivery(target.id, "unrelated template", "template", "text", [], null);
  const state = seed.snapshot();
  delete state.heldDeliveries[held.id];
  delete state.deliveryOperationOwners[held.command.operationId];
  const journal = new RuntimeJournal(path.join(root, "events.sqlite"), { structuredHosts: true });
  journal.append({ scope: runtimeScope("session", target.id), kind: "session-status", payload: {
    conversationId: target.id, sessionKey: { engine: "codex", sessionId: generation.id },
    artifactPath: generation.path, host: "hosted", hostKind: "codex-app-server", turn: "idle",
    capabilities: { steer: true, structuredAttention: true },
  } });
  const before = journal.snapshot().sessions.find(row => row.conversationId === target.id)!;
  const socket = runtimeHostEndpoint(root, `keyed-${process.pid}`).socketPath;
  const server = serveRuntimeHost(socket, new RuntimeHost(journal, undefined, undefined, true));
  if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
  const client = new runtimeClient.UnixRuntimeHostClient(socket);
  const small: number[] = [];
  for (let i = 0; i < 25; i++) {
    const start = performance.now();
    expect(await client.readSession({ conversationId: target.id })).toEqual(before);
    small.push(performance.now() - start);
  }
  const db = (journal as unknown as { db: Database }).db;
  db.transaction(() => {
    const insert = db.query("INSERT INTO entities(kind,id,revision,state_json,checkpoint_seq) VALUES ('session',?,1,?,0)");
    for (let i = 0; i < 6_000; i++) {
      const id = `conversation_background-${i}` as const;
      const artifact = `/sessions/background-${i}.jsonl`;
      state.conversations[id] = { ...structuredClone(target), id,
        generations: [{ ...structuredClone(generation), id: `background-${i}`, path: artifact }] };
      state.entries[`codex:background-${i}`] = { ...structuredClone(state.entries[`codex:${generation.id}`]!),
        key: { engine: "codex", sessionId: `background-${i}` }, artifactPath: artifact };
      state.heldDeliveries[`background-${i}`] = { ...structuredClone(held), id: `background-${i}`, conversationId: id,
        runtimeConversationId: id, command: { ...held.command, operationId: `background-op-${i}` } };
      state.conversationAliases[`conversation_alias-${i}`] = id;
      state.pendingSupersedence[id] = { predecessorConversationId: id, successorConversationId: target.id,
        reason: "manual", stagedAt: new Date().toISOString() };
      insert.run(id, JSON.stringify({ ...before, conversationId: id, artifactPath: artifact,
        liveTurn: { text: "background".repeat(2_000) } }));
    }
  })();
  fs.writeFileSync(filename, JSON.stringify(state));
  let loads = 0;
  let rows = 0;
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite",
    onSqliteSnapshotLoad: () => loads++, onSqliteRowPayloadRead: (_collection, count) => { rows += count; } });
  const cached = registry.readOnlySnapshot();
  let cachedMapEnumerations = 0;
  cached.heldDeliveries = new Proxy(cached.heldDeliveries, {
    ownKeys: target => { cachedMapEnumerations++; return Reflect.ownKeys(target); },
  });
  const snapshotSpy = spyOn(runtimeClient.UnixRuntimeHostClient.prototype, "snapshot");
  const factory = spyOn(runtimeClient, "runtimeHostClient").mockReturnValue(client);
  const globalRegistryRead = spyOn(registry, "readOnlySnapshot");
  const globalJournalRead = spyOn(journal, "snapshotJson");
  try {
    loads = rows = 0;
    const large: number[] = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      expect(await client.readSession({ conversationId: target.id })).toEqual(before);
      registry.conversationDeliverySnapshot({ conversationId: target.id });
      large.push(performance.now() - start);
    }
    const admission: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const response = await handleRuntimeCommand(new NextRequest("http://localhost/api/runtime/send", {
        method: "POST", headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ conversationId: target.id, idempotencyKey: `message-${i}`, text: "continue" }),
      }), "send", { enabled: () => true, structuredEnabled: () => true,
        client: () => runtimeClient.runtimeHostClient(), registry: () => registry,
        enqueue: enqueueStructuredMessage, recordOperatorActivity: () => null, retireReplySuggestions: () => ({ cleared: false, pending: false }), kick: () => {} });
      expect(response.status).toBe(202);
      admission.push(performance.now() - start);
    }
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(globalRegistryRead).not.toHaveBeenCalled();
    expect(globalJournalRead).not.toHaveBeenCalled();
    expect(loads).toBe(0);
    expect(cachedMapEnumerations).toBe(0);
    expect(rows).toBeLessThan(12_000);
    expect(p95(large)).toBeLessThan(250);
    expect(p95(admission)).toBeLessThan(250);
    console.log(JSON.stringify({ sessions: 6_001, smallReadP95Ms: p95(small), populatedReadP95Ms: p95(large), admissionP95Ms: p95(admission), rowPayloadReads: rows }));
  } finally {
    snapshotSpy.mockRestore(); factory.mockRestore(); globalRegistryRead.mockRestore(); globalJournalRead.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve()));
    registry.close(); journal.close();
  }
}, 30_000);
