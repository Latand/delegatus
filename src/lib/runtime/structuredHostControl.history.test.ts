import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { normalizeRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { readStructuredHostRecords } from "./structuredHostControl";

test.each([false, true])("resources inventory with a structured host=%s does not expand cold history", (withHost) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-host-history-"));
  let store: SqliteAgentRegistryStore | undefined;
  try {
    const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05), {
      sessionsRoot: path.join(directory, "sessions"),
    });
    if (withHost) {
      const db = new Database(dataset.filename);
      try {
        const row = db.query<{ row_key: string; value_json: string }, []>(
          "SELECT row_key, value_json FROM registry_rows WHERE collection = 'entries' LIMIT 1",
        ).get()!;
        const entry = JSON.parse(row.value_json);
        entry.host = null;
        entry.structuredHost = {
          kind: "codex-app-server", endpoint: "stdio", process: { pid: 9_999_999, startIdentity: "fixture", bootEpoch: null },
          eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [],
        };
        db.query("UPDATE registry_rows SET value_json = ? WHERE collection = 'entries' AND row_key = ?")
          .run(JSON.stringify(entry), row.row_key);
      } finally { db.close(); }
    }
    let payloads = 0;
    store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry, initialSnapshot: () => { throw new Error("dataset is already imported"); },
      onRowPayloadRead: (_collection, count) => { payloads += count; },
    });
    const snapshot = store.readOnlySnapshot().file;
    const stat = spyOn(fs, "statSync");
    try {
      for (let pass = 0; pass < 2; pass++) {
        payloads = 0;
        stat.mockClear();
        const rows = readStructuredHostRecords({ snapshot: () => snapshot, owned: () => false });
        expect(rows).toHaveLength(withHost ? 1 : 0);
        if (withHost) expect(rows[0]).toMatchObject({ pid: 9_999_999, owned: false });
        const identityReads = stat.mock.calls.filter(([filename]) => filename === dataset.filename).length;
        console.info("resources retained history", { withHost, pass, payloads, identityReads });
        expect(payloads).toBeLessThan(10);
        expect(identityReads).toBeLessThan(50);
      }
    } finally { stat.mockRestore(); }

    if (withHost) {
      const before = readStructuredHostRecords({ snapshot: () => snapshot, owned: () => false });
      const listed = before[0]!;
      expect(listed.conversationId).not.toBeNull();
      const original = snapshot.conversations[listed.conversationId!]!;
      const generation = original.generations.find((item) => item.id === listed.sessionId);
      if (!generation) throw new Error("fixture host has no generation");
      const duplicate = structuredClone(original);
      duplicate.id = "conversation_last_raw_owner";
      duplicate.engine = original.engine === "claude" ? "codex" : "claude";
      duplicate.generations = [{ ...structuredClone(generation), launchProfile: { ...generation.launchProfile, title: "Last raw-session owner" } }];
      duplicate.agentRole = "reviewer";
      duplicate.turn = { ...duplicate.turn, state: "busy" };
      store.mutate((file) => { file.conversations[duplicate.id] = duplicate; }, false);

      // Keep the existing last-owner rule even when the duplicate belongs to
      // another engine. An older snapshot must keep its original owner.
      expect(readStructuredHostRecords({ snapshot: () => snapshot, owned: () => false })).toEqual(before);
      const current = store.readOnlySnapshot().file;
      const indexed = readStructuredHostRecords({ snapshot: () => current, owned: () => false });
      expect(indexed[0]).toMatchObject({
        conversationId: duplicate.id, title: "Last raw-session owner", role: "reviewer", turnBusy: true,
      });
      const plain = structuredClone(current);
      expect(readStructuredHostRecords({ snapshot: () => plain, owned: () => false })).toEqual(indexed);
    }
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
