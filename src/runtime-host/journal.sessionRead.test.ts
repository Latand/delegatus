import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RuntimeJournal } from "./journal";
import { RuntimeHost } from "./host";
import { runtimeScope } from "@/lib/runtime/contracts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-session-read-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("keyed RPC shares snapshot normalization, identity precedence and absence semantics", async () => {
  const journal = new RuntimeJournal(path.join(root, "session.sqlite"));
  for (const id of ["conversation_first", "conversation_second"]) journal.append({
    scope: runtimeScope("session", id), kind: "session-status", payload: {
      artifactPath: `/sessions/${id}.jsonl`, host: "hosted", hostKind: "codex-app-server", turn: "running",
      liveTurn: { text: "large text ".repeat(100), turnId: "turn-one", items: [] },
      voiceDeliveries: [{ deliveryId: "voice-one", responses: [{ responseId: "response-one", text: "retained body" }] }],
    },
  });
  const expected = journal.snapshot().sessions[0]!;
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

test("upgrade creates the artifact index without rewriting old projections or consumer cursors", () => {
  const filename = path.join(root, "upgrade.sqlite");
  let journal = new RuntimeJournal(filename);
  journal.registerConsumer("pending-consumer");
  journal.append({ scope: runtimeScope("session", "conversation_old"), kind: "session-status", payload: {
    artifactPath: "/sessions/old.jsonl", host: "dead", turn: "idle", liveTurn: { text: "stale" },
  } });
  const expected = journal.snapshot().sessions[0]!;
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
