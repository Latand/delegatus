import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RuntimeJournal } from "./journal";
import { RuntimeHost } from "./host";
import { runtimeScope, type RuntimeStartupSessionEvidence } from "@/lib/runtime/contracts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-session-read-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test.each([
  ["a pinned CLI", "0.162.1", {}],
  ["an unpinned CLI admitted under a pin", "0.162.7", { unpinnedCli: { cliVersion: "0.162.7", cliSchemaDigest: "b".repeat(64) } }],
])("the Codex protocol and capability receipt survives journal restart and keyed reads (%s)", (_name, version, unpinned) => {
  const filename = path.join(root, `protocol-${version}.sqlite`);
  const protocol = { schemaVersion: "0.162.1", schemaDigest: "a".repeat(64), experimentalApi: true,
    provider: { webSearch: true, imageGeneration: false }, models: [{ id: "text-model", inputModalities: ["text"] }], anomalies: 2, ...unpinned };
  let journal = new RuntimeJournal(filename);
  try {
    journal.append({ scope: runtimeScope("session", "conversation_protocol"), kind: "session-status", payload: {
      hostKind: "codex-app-server", diagnostics: { executable: "codex", version, protocol },
    } });
    expect(journal.snapshot().sessions[0]?.diagnostics?.protocol).toEqual(protocol);
    journal.close();
    journal = new RuntimeJournal(filename);
    expect(journal.readSession({ conversationId: "conversation_protocol" })?.diagnostics?.protocol).toEqual(protocol);
  } finally { journal.close(); }
});

test("keyed RPC shares snapshot normalization, identity precedence and absence semantics", async () => {
  const journal = new RuntimeJournal(path.join(root, "session.sqlite"));
  for (const id of ["conversation_first", "conversation_second"]) journal.append({
    scope: runtimeScope("session", id), kind: "session-status", payload: {
      artifactPath: `/sessions/${id}.jsonl`, host: "hosted", hostKind: "codex-app-server", turn: "running",
      liveTurn: { text: "large text ".repeat(100), turnId: "turn-one", items: [] },
      voiceDeliveries: [{ deliveryId: "voice-one", responses: [{ responseId: "response-one", text: "retained body" }] }],
    },
  });
  const snapshotSession = journal.snapshot().sessions[0]!;
  expect(snapshotSession.retirementBlocked).toBeUndefined();
  const expected = { ...snapshotSession, retirementBlocked: false };
  const snapshotSpy = spyOn(journal, "snapshotJson");
  const host = new RuntimeHost(journal);
  try {
    expect(await host.handle({ id: "read-one", method: "session-read", params: {
      conversationId: expected.conversationId, artifactPath: "/sessions/conversation_second.jsonl",
    } })).toEqual({ id: "read-one", ok: true, result: expected });
    expect(journal.readSession({ artifactPath: expected.artifactPath! })).toEqual(expected);
    expect(journal.readSession({ conversationId: "missing", artifactPath: expected.artifactPath! })).toEqual(expected);
    expect(journal.readSession({ conversationId: "missing" })).toBeNull();
    expect(await host.handle({ id: "invalid", method: "session-read", params: {} })).toMatchObject({ ok: false });
    expect(await host.handle({ id: "invalid", method: "session-read", params: { conversationId: 42 } })).toMatchObject({ ok: false });
    expect(snapshotSpy).not.toHaveBeenCalled();
  } finally { snapshotSpy.mockRestore(); journal.close(); }
});

test("runtime host binds bounded startup evidence to the session checkpoint and journal generation", async () => {
  const filename = path.join(root, "startup-evidence.sqlite");
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  const host = new RuntimeHost(journal);
  const id = "conversation_startup_runtime";
  const missing = "conversation_startup_missing";
  const evidence = async (conversationIds: string[], includeEvidence = false, target = host) => {
    const response = await target.handle({ id: "startup-read", method: "startup-session-evidence", params: { conversationIds, includeEvidence } });
    expect(response.ok).toBe(true);
    return response.result as RuntimeStartupSessionEvidence;
  };
  try {
    const absent = await evidence([missing], true);
    expect(absent).toMatchObject({ sessions: [null], evidence: null });
    journal.append({ scope: runtimeScope("session", id), kind: "session-status", payload: {
      host: "hosted", turn: "running", liveTurn: { text: "turn body", turnId: "active", items: [] },
    } });
    const before = await evidence([id, missing]);
    const present = await evidence([id], true);
    expect(before.effectsVersion).toBe(absent.effectsVersion);
    expect(present).toEqual({ generation: before.generation, version: before.version, effectsVersion: before.effectsVersion, sessions: [before.sessions[0]!],
      evidence: { conversationId: id, host: "hosted", turn: "running", recentReceipts: [] } });
    expect(before.sessions[0]).toBeGreaterThan(0);
    expect(before.sessions[1]).toBeNull();
    const peer = new RuntimeJournal(filename, { structuredHosts: true });
    try {
      const command = peer.executeOperation({ kind: "send", conversationId: id, idempotencyKey: "startup-evidence-send", text: "queued" });
      const current = await evidence([id], true);
      expect(current.version).not.toBe(before.version);
      expect(current.effectsVersion).not.toBe(before.effectsVersion);
      expect(current.sessions[0]).toBeGreaterThan(before.sessions[0]!);
      expect(current.evidence?.recentReceipts).toEqual([
        expect.objectContaining({ operationId: command.operationId, status: command.receipt.status }),
      ]);
      expect((await evidence([id], false, new RuntimeHost(peer))).generation).not.toBe(before.generation);
      peer.transitionOperation(command.operationId, "failed");
      const settled = await evidence([id], true);
      expect(settled.effectsVersion).not.toBe(current.effectsVersion);
      expect(settled.evidence?.recentReceipts).toEqual([
        expect.objectContaining({ operationId: command.operationId, status: "failed" }),
      ]);
    } finally { peer.close(); }
    for (const params of [
      { conversationIds: Array(129).fill(id) },
      { conversationIds: [id, missing], includeEvidence: true },
      { conversationIds: [42] },
    ]) {
      expect(await host.handle({ id: "invalid", method: "startup-session-evidence", params })).toMatchObject({ ok: false });
    }
  } finally { journal.close(); }
});

test("upgrade creates the artifact index without rewriting old projections or consumer cursors", () => {
  const filename = path.join(root, "upgrade.sqlite");
  let journal = new RuntimeJournal(filename);
  journal.registerConsumer("pending-consumer");
  journal.append({ scope: runtimeScope("session", "conversation_old"), kind: "session-status", payload: {
    artifactPath: "/sessions/old.jsonl", host: "dead", turn: "idle", liveTurn: { text: "stale" },
  } });
  const expected = { ...journal.snapshot().sessions[0]!, retirementBlocked: false };
  const pending = journal.unconsumedEvents("pending-consumer");
  journal.close();
  const legacy = new Database(filename);
  legacy.exec("DROP INDEX session_artifact_path");
  const bodies = legacy.query("SELECT state_json FROM entities ORDER BY kind,id").all();
  legacy.close();
  journal = new RuntimeJournal(filename);
  try {
    expect(journal.readSession({ artifactPath: "/sessions/old.jsonl" })).toEqual(expected);
    expect(journal.unconsumedEvents("pending-consumer")).toEqual(pending);
    const db = (journal as unknown as { db: Database }).db;
    expect(db.query("SELECT state_json FROM entities ORDER BY kind,id").all()).toEqual(bodies);
    expect(JSON.stringify(db.query("EXPLAIN QUERY PLAN SELECT state_json FROM entities WHERE kind='session' AND json_extract(state_json,'$.artifactPath')=? ORDER BY id LIMIT 1").all("/sessions/old.jsonl"))).toContain("session_artifact_path");
  } finally { journal.close(); }
});

test("a faulted pre-upgrade journal serves keyed diagnostics without installing the new index", async () => {
  const filename = path.join(root, "fault.sqlite");
  const journal = new RuntimeJournal(filename);
  journal.append({ scope: runtimeScope("session", "conversation_fault"), kind: "session-status", payload: { artifactPath: "/sessions/fault.jsonl" } });
  journal.close();
  const legacy = new Database(filename);
  legacy.exec("DROP INDEX session_artifact_path; UPDATE events SET producer_kind='tampered' WHERE seq=1");
  legacy.close();
  const faulted = new RuntimeJournal(filename);
  try {
    const host = new RuntimeHost(faulted);
    expect(faulted.isWritable()).toBe(false);
    expect(await host.handle({ id: "fault-read", method: "session-read", params: { artifactPath: "/sessions/fault.jsonl" } })).toMatchObject({ ok: true, result: { conversationId: "conversation_fault" } });
    const db = (faulted as unknown as { db: Database }).db;
    expect(db.query("SELECT name FROM sqlite_master WHERE name='session_artifact_path'").get()).toBeNull();
  } finally { faulted.close(); }
});

test("an event bound to a session revision is recorded only while the row still has it", async () => {
  const journal = new RuntimeJournal(path.join(root, "fence.sqlite"));
  const host = new RuntimeHost(journal);
  const scope = runtimeScope("session", "conversation_fenced");
  const status = (payload: Record<string, unknown>, expectedSessionRevision?: number) => ({ scope, kind: "session-status",
    payload: { hostKind: "codex-app-server", ...payload }, ...(expectedSessionRevision === undefined ? {} : { expectedSessionRevision }) });
  try {
    journal.append(status({ host: "hosted", turn: "running", activeTurnId: "turn-one" }));
    const read = journal.readSession({ conversationId: "conversation_fenced" })!;
    /* A new owner publishes after the reading; the stale verdict is refused whole. */
    journal.append(status({ host: "hosted", turn: "running", activeTurnId: "turn-two" }));
    const seq = journal.publishedSeq();
    expect(await host.handle({ id: "stale", method: "append-session-fenced", params: { event: status({ host: "dead", turn: "unknown", activeTurnId: null }, read.revision) } }))
      .toMatchObject({ ok: false, error: "the session row changed after this event's writer read it" });
    expect(journal.publishedSeq()).toBe(seq);
    const current = journal.readSession({ conversationId: "conversation_fenced" })!;
    expect(current).toMatchObject({ host: "hosted", turn: "running", activeTurnId: "turn-two" });
    /* The same verdict against the row as it stands is recorded. */
    /* The dedicated RPC cannot omit the fence or apply it to another scope. */
    for (const event of [status({ host: "dead" }), status({ host: "dead" }, -1), status({ host: "dead" }, 1.5),
      { ...status({ host: "dead" }, current.revision), scope: runtimeScope("system", "fence") },
      { ...status({ host: "dead" }, current.revision), kind: "delta" }]) {
      expect(await host.handle({ id: "invalid", method: "append-session-fenced", params: { event } })).toMatchObject({ ok: false });
      expect(journal.publishedSeq()).toBe(seq);
    }
    const withdrawal = {
      scope, kind: "pipeline.provider-continuation-cancelled", payload: { conversationId: "conversation_fenced" },
      producer: { kind: "viewer-command", eventKey: `pipeline-withdrawal:${"a".repeat(64)}:1` },
      expectedSessionRevision: current.revision,
    };
    for (const method of ["append", "operation"] as const) {
      for (const event of [withdrawal, { ...withdrawal,
        producer: { kind: "viewer-command" }, producerKey: withdrawal.producer.eventKey }]) {
        expect(await host.handle({ id: method, method, params: { event } })).toMatchObject({ ok: false });
      }
    }
    for (const event of [{ ...withdrawal, payload: { conversationId: "conversation_other" } },
      { ...withdrawal, expectedSessionRevision: undefined }, { ...withdrawal, kind: "session-status" },
      { ...withdrawal, operationId: "fixture-other-operation" }]) {
      expect(await host.handle({ id: "invalid-withdrawal", method: "append-session-fenced", params: { event } })).toMatchObject({ ok: false });
    }
    expect(journal.publishedSeq()).toBe(seq);
    expect(journal.producerCursor("viewer-command", `pipeline-withdrawal:${"a".repeat(64)}:`)).toBe(0);
    expect(await host.handle({ id: "current", method: "append-session-fenced", params: { event: status({ host: "dead", turn: "unknown", activeTurnId: null }, current.revision) } }))
      .toMatchObject({ ok: true });
    expect(journal.readSession({ conversationId: "conversation_fenced" })).toMatchObject({ host: "dead", turn: "unknown", activeTurnId: null });
    /* A row that does not exist, and a scope that holds no session row, have no revision to match. */
    expect(() => journal.append({ ...status({ host: "dead" }, 1), scope: runtimeScope("session", "conversation_absent") })).toThrow();
    expect(() => journal.append({ scope: runtimeScope("system", "fence"), kind: "session-status", payload: {}, expectedSessionRevision: 1 })).toThrow();
    expect(journal.readSession({ conversationId: "conversation_absent" })).toBeNull();
  } finally { journal.close(); }
});

test("startup operation pages retain native work after acknowledgement removes its outbox effect", async () => {
  const journal = new RuntimeJournal(path.join(root, "startup-native-queue.sqlite"), { structuredHosts: true });
  const host = new RuntimeHost(journal, undefined, undefined, true);
  const conversationId = "conversation_startup_native";
  const sessionKey = { engine: "codex" as const, sessionId: "startup-native-session" };
  const page = async (pendingOperationsAfter = { eventSeq: 0, rowId: 0 }) => {
    const response = await host.handle({ id: "startup-active-operations", method: "startup-session-evidence",
      params: { conversationIds: [], pendingOperationsAfter } });
    expect(response.ok).toBe(true);
    return response.result as RuntimeStartupSessionEvidence;
  };
  try {
    journal.append({ scope: runtimeScope("session", conversationId), kind: "session-status", payload: {
      conversationId, sessionKey, hostKind: "codex-app-server", host: "hosted", turn: "idle",
      writerClaim: "synthetic:1", capabilities: { nativeQueue: true, steer: true, structuredAttention: true },
    } });
    const empty = await page();
    const operationId = "startup-native-work";
    journal.executeOperation({ kind: "native-queue", conversationId, operationId, idempotencyKey: operationId,
      action: "add", binding: { threadId: sessionKey.sessionId, accountId: null }, text: "Synthetic native work" });
    journal.nativeQueueTransition(operationId, { phase: "prepared", input: [{ type: "text", text: "Synthetic native work" }] });
    journal.nativeQueueTransition(operationId, { phase: "observed-queued", submission: {
      id: "synthetic-native", clientUserMessageId: operationId, input: [{ type: "text", text: "Synthetic native work" }],
    } });
    expect(journal.effectBatch(100, ["runtime.native-queue"])).toHaveLength(0);
    const pending = await page();
    expect(pending.effectsVersion).not.toBe(empty.effectsVersion);
    expect(pending.pendingOperations).toEqual([expect.objectContaining({ operationId, conversationId, status: "queued" })]);
    expect((await page({ eventSeq: journal.publishedSeq(), rowId: Number.MAX_SAFE_INTEGER })).pendingOperations).toEqual([]);
    journal.transitionOperation(operationId, "failed");
    const ended = await page();
    expect(ended.effectsVersion).not.toBe(pending.effectsVersion);
    expect(ended.pendingOperations).toEqual([]);

    const ids = Array.from({ length: 103 }, (_, index) => `startup-queued-work-${index}`);
    for (const id of ids) journal.executeOperation({
      kind: "send", conversationId, operationId: id, idempotencyKey: id, text: "Synthetic queued work",
    });
    const firstPage = await page();
    expect(firstPage.pendingOperations).toHaveLength(100);
    expect(firstPage.pendingOperationsNext).toBeDefined();
    const lastPage = await page(firstPage.pendingOperationsNext);
    expect(lastPage.pendingOperationsNext).toBeUndefined();
    expect([...firstPage.pendingOperations!, ...lastPage.pendingOperations!].map(receipt => receipt.operationId)).toEqual(ids);
  } finally { journal.close(); }
});
