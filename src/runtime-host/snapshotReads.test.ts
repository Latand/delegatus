import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Database } from "bun:sqlite";
import { RuntimeJournal, RUNTIME_SNAPSHOT_INACTIVE_SESSION_LIMIT } from "./journal";
import { RuntimeHost } from "./host";
import { serveRuntimeHost } from "./socket";
import { SessionHostMetadata } from "./journalSessionMetadata";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { projectSnapshotRead, SNAPSHOT_ACTIVITY_LIMIT } from "@/lib/runtime/snapshotReads";
import type { RuntimeSession, RuntimeSnapshot } from "@/lib/runtime/contracts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-read-"));
  const database = path.join(root, "runtime.sqlite");
  const journal = new RuntimeJournal(database, { now: () => 1_000 });
  cleanups.push(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const append = (id: string, host: RuntimeSession["host"] = "hosted", extra: Partial<RuntimeSession> = {}) => journal.append({
    scope: { type: "session", id }, kind: "session-status",
    payload: { conversationId: id, sessionKey: { engine: "codex", sessionId: id }, hostKind: "codex-app-server",
      host, turn: "running", provenance: "structured", cwd: "/repo", artifactPath: `/repo/${id}.jsonl`,
      liveTurn: { turnId: "turn", text: "Large retained text. ".repeat(200) },
      voiceDeliveries: [{ deliveryId: "delivery", turnId: "turn", ready: true,
        responses: [{ responseId: "answer", text: "Spoken output. ".repeat(200) }] }], ...extra },
  });
  return { root, database, journal, append };
}

test("narrow reads equal the full snapshot through selection, adoption, retirement and metadata readiness", () => {
  const { journal, append, database } = fixture();
  for (let i = 0; i <= RUNTIME_SNAPSHOT_INACTIVE_SESSION_LIMIT; i++) append(`dead-${i}`, "dead");
  append("active-😀", "hosted", { attentionIds: ["attention"], writerClaim: "claim:7",
    writerStatus: { sessionKey: { engine: "codex", sessionId: "writer" }, writerClaim: "claim:7",
      host: "hosted", turn: "running", activeTurnId: "turn" },
    nativeTurnClaims: [{ sessionKey: { engine: "codex", sessionId: "native" }, writerClaim: null, turnId: null, revision: 2 }] });
  const check = () => {
    const full = journal.snapshot();
    expect(projectSnapshotRead(journal.snapshotRead({ version: 1, kind: "activity" }), "activity"))
      .toEqual(projectSnapshotRead(full, "activity"));
    const ids = ["active-😀", "dead-0", "dead-128", "absent"];
    for (const kind of ["metadata", "owners", "activity"] as const) {
      const request = { version: 1, kind, ...(kind === "activity" ? { conversationIds: ids } : {}) };
      const narrow = journal.snapshotRead(request);
      expect(projectSnapshotRead(narrow, kind, ids)).toEqual(projectSnapshotRead(full, kind, ids));
      expect(JSON.stringify(narrow)).not.toContain("Large retained text");
      expect(JSON.stringify(narrow)).not.toContain("Spoken output");
    }
    expect(projectSnapshotRead(journal.snapshotRead({ version: 1, kind: "activity", conversationIds: ["dead-0"] }), "activity", ["dead-0"]).sessions).toHaveLength(0);
    expect(journal.readSession({ conversationId: "dead-0" })).not.toBeNull();
    expect(journal.snapshot()).toEqual(full);
  };
  check(); // Same legacy selection while metadata backfill has not run.
  const db = new Database(database);
  const metadata = new SessionHostMetadata(db);
  try {
    for (let i = 0; !metadata.ready && i < 100; i++) metadata.step();
    expect(metadata.ready).toBe(true);
    // Open a fresh reader that starts with a completed companion index.
    const ready = new RuntimeJournal(database, { now: () => 1_000 });
    try {
      // Let its own metadata object observe the ready marker synchronously.
      (ready as unknown as { sessionHostMetadata: SessionHostMetadata }).sessionHostMetadata.step();
      expect(ready.snapshotRead({ version: 1, kind: "owners" })).toEqual(journal.snapshotRead({ version: 1, kind: "owners" }));
      append("active-😀", "recovering");
      expect(projectSnapshotRead(ready.snapshotRead({ version: 1, kind: "activity", conversationIds: ["active-😀"] }), "activity", ["active-😀"]).sessions[0]?.host).toBe("recovering");
      append("active-😀", "dead");
      expect(projectSnapshotRead(ready.snapshotRead({ version: 1, kind: "owners" }), "owners")).toEqual(projectSnapshotRead(ready.snapshot(), "owners"));
    } finally { ready.close(); }
  } finally { metadata.close(); db.close(); }
});

test("owner projection preserves absent and null custody evidence, writer marks and native claims", () => {
  const { journal, append, database } = fixture();
  append("owner");
  const db = new Database(database);
  try {
    // Stored pre-checkpoint rows distinguish absence/null from an empty list.
    for (const expression of ["json_remove(state_json, '$.nativeTurnClaims', '$.writerStatus', '$.writerClaim')",
      "json_set(state_json, '$.nativeTurnClaims', NULL, '$.writerClaim', NULL)",
      "json_set(state_json, '$.nativeTurnClaims', json('[]'))"]) {
      db.exec(`UPDATE entities SET state_json = ${expression} WHERE kind = 'session'`);
      const full = journal.snapshot();
      expect(projectSnapshotRead(journal.snapshotRead({ version: 1, kind: "owners" }), "owners"))
        .toEqual(projectSnapshotRead(full, "owners"));
    }
    db.exec("UPDATE journal_meta SET value = '12' WHERE key = 'host_epoch'");
    const metadata = projectSnapshotRead(journal.snapshotRead({ version: 1, kind: "metadata" }), "metadata");
    expect(metadata.runtime.hostEpoch).toBe(12);
    expect(metadata.snapshotSeq).toBe(journal.snapshot().snapshotSeq);
  } finally { db.close(); }
});

test("activity matches the published conversation identity when the journal scope differs", () => {
  const { journal, append } = fixture();
  append("stored-slot", "hosted", { conversationId: "published-session" });
  for (const conversationIds of [["published-session"], ["stored-slot"], ["published-session", "stored-slot"]]) {
    expect(projectSnapshotRead(journal.snapshotRead({ version: 1, kind: "activity", conversationIds }), "activity", conversationIds))
      .toEqual(projectSnapshotRead(journal.snapshot(), "activity", conversationIds));
  }
});

test("activity input is bounded and invalid scope or version refuses before reading", () => {
  const { journal } = fixture();
  for (const request of [null, { version: 2, kind: "metadata" }, { version: 1, kind: "other" },
    { version: 1, kind: "activity", conversationIds: "invalid" }, { version: 1, kind: "activity", conversationIds: [null] },
    { version: 1, kind: "owners", conversationIds: [] },
    { version: 1, kind: "activity", conversationIds: Array(SNAPSHOT_ACTIVITY_LIMIT + 1).fill("session") }]) {
    expect(() => journal.snapshotRead(request)).toThrow("runtime snapshot read is invalid");
  }
  expect(journal.snapshotRead({ version: 1, kind: "activity", conversationIds: [] }).sessions).toEqual([]);
  expect(journal.snapshotRead({ version: 1, kind: "activity", conversationIds: Array(SNAPSHOT_ACTIVITY_LIMIT).fill("absent") }).sessions).toEqual([]);
});

test.each(["owners", "activity"] as const)("encoded %s cache follows journal writes without retaining per-identity reads", kind => {
  const { journal, append, database } = fixture();
  append("owner");
  const request = { version: 1, kind };
  const first = journal.snapshotReadJson(request);
  expect(journal.snapshotReadJson(request)).toBe(first);
  append("owner", "dead");
  const changed = journal.snapshotReadJson(request);
  expect(changed).not.toBe(first);
  expect(projectSnapshotRead(JSON.parse(changed), kind)).toEqual(projectSnapshotRead(journal.snapshot(), kind));
  const peer = new Database(database);
  try { peer.exec("UPDATE journal_meta SET value = '42' WHERE key = 'files_revision'"); }
  finally { peer.close(); }
  expect(JSON.parse(journal.snapshotReadJson(request)).filesRevision).toBe(42);
  for (let i = 0; i < 100; i++) journal.snapshotReadJson({ version: 1, kind: "activity", conversationIds: [`missing-${i}`] });
  expect((journal as unknown as { snapshotCaches: Map<string, unknown> }).snapshotCaches.size).toBe(1);
});

test("a peer write between metadata reads cannot mix the cursor, floor and owner population", () => {
  const { journal, append, database } = fixture();
  append("owner");
  const before = projectSnapshotRead(journal.snapshot(), "owners");
  const peer = new Database(database);
  const reader = journal as unknown as { meta(key: string): string };
  const original = reader.meta.bind(reader);
  let changed = false;
  const hook = spyOn(reader, "meta").mockImplementation(key => {
    const value = original(key);
    if (!changed && key === "published_seq") {
      changed = true;
      peer.exec("BEGIN");
      peer.exec("UPDATE journal_meta SET value = '12' WHERE key = 'published_seq'");
      peer.exec("UPDATE journal_meta SET value = '11' WHERE key = 'anchor_seq'");
      peer.exec("UPDATE journal_meta SET value = '8' WHERE key = 'host_epoch'");
      peer.exec("UPDATE entities SET state_json = json_set(state_json, '$.host', 'dead') WHERE kind = 'session'");
      peer.exec("COMMIT");
    }
    return value;
  });
  try {
    expect(projectSnapshotRead(journal.snapshotRead({ version: 1, kind: "owners" }), "owners")).toEqual(before);
    expect(changed).toBe(true);
    const after = projectSnapshotRead(journal.snapshotRead({ version: 1, kind: "owners" }), "owners");
    expect(after.snapshotSeq).toBe(12);
    expect(after.retentionFloorSeq).toBe(11);
    expect(after.runtime.hostEpoch).toBe(8);
    expect(after.sessions[0]?.host).toBe("dead");
  } finally { hook.mockRestore(); peer.close(); }
});

test("real socket reads preserve old-host and old-client behavior across generation changes", async () => {
  const { journal, append, root } = fixture();
  append("active-😀");
  const host = new RuntimeHost(journal);
  let legacy = false;
  const server = serveRuntimeHost(path.join(root, "host.sock"), { handle: request => host.handle(legacy
    ? { ...request, params: { voiceBodiesFor: [] } } : request) });
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const client = new UnixRuntimeHostClient(path.join(root, "host.sock"));
  const full = await client.snapshot();
  for (const oldHost of [false, true, false]) {
    legacy = oldHost;
    for (const kind of ["metadata", "activity", "owners"] as const) {
      const ids = kind === "activity" ? ["active-😀", "absent"] : undefined;
      expect(await client.readSnapshot(kind, ids)).toEqual(projectSnapshotRead(full, kind, ids));
    }
  }
  expect(JSON.parse(new TextDecoder().decode(await client.snapshotBytes())) as RuntimeSnapshot).toEqual(full);
});
