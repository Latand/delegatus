import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { registryConversationRetentionStates } from "../../runtime-host/journalRetention";

const at = "2026-10-18T12:00:00.000Z";
function fixture(history: number) {
  const conversations: Record<string, unknown> = {};
  const entries: Record<string, unknown> = {};
  const receipts: Record<string, unknown> = {};
  const aliases: Record<string, string> = {
    conversation_outer: "conversation_inner", conversation_inner: "conversation_dead",
    conversation_receipt_alias: "conversation_receipt_mid", conversation_receipt_mid: "conversation_receipt_only",
    conversation_cycle_a: "conversation_cycle_b", conversation_cycle_b: "conversation_cycle_a",
    conversation_cycle_tail: "conversation_cycle_a", conversation_self: "conversation_self",
    conversation_own_row: "conversation_missing", conversation_shadowed: "conversation_dead",
  };
  const conversation = (name: string, status = "idle", superseded = false) => {
    const id = `conversation_${name}`;
    conversations[id] = { id, engine: "codex", generations: [{ id: `${name}-old`, path: `/sessions/${name}-old.jsonl` },
      { id: name, path: `/sessions/${name}.jsonl` }],
      supersededBy: superseded ? { conversationId: "conversation_current", at, reason: "manual" } : null };
    entries[`codex:${name}-old`] = { key: { engine: "codex", sessionId: `${name}-old` }, status: "dead" };
    entries[`codex:${name}`] = { key: { engine: "codex", sessionId: name }, status };
  };
  const receipt = (name: string, conversationId: string, state: string, artifactLifecycle = "pending") => {
    receipts[name] = { launchId: name, conversationId, state, artifactLifecycle, createdAt: at, updatedAt: at };
  };
  conversation("current"); conversation("dead", "dead"); conversation("superseded", "dead", true);
  conversation("revived", "dead"); conversation("own_row", "dead"); conversation("shadowed");
  receipt("failed-current", "conversation_current", "failed");
  receipt("failed-dead", "conversation_dead", "failed");
  receipt("completed-dead", "conversation_dead", "completed", "materialized");
  receipt("pending-superseded", "conversation_superseded", "starting");
  receipt("failed-only", "conversation_receipt_only", "conflicted");
  receipt("pending-only", "conversation_receipt_alias", "starting");
  receipt("failed-only-other", "conversation_failed_only", "failed");
  receipt("conflicted-only", "conversation_conflicted_only", "conflicted");
  receipt("completed-only", "conversation_completed_only", "completed", "materialized");
  receipt("revived", "conversation_revived", "path-pending");
  receipt("cycle-receipt", "conversation_cycle_a", "failed");
  receipt("current-only", "conversation_current_only", "starting");
  // A chain beyond the seat selector's 64-hop budget still has exact retention semantics.
  for (let i = 0; i < 70; i++) aliases[`conversation_long_${i}`] = i === 69 ? "conversation_dead" : `conversation_long_${i + 1}`;
  for (let i = 0; i < history; i++) {
    conversation(`unrelated_${i}`);
    receipt(`unrelated-${i}`, `conversation_unrelated_${i}`, "completed", "materialized");
    aliases[`conversation_unrelated_alias_${i}`] = `conversation_unrelated_${i}`;
  }
  return normalizeRegistry({ version: 2, conversations, entries, receipts, conversationAliases: aliases });
}

const pendingIds = ["current", "dead", "superseded", "revived", "outer", "receipt_alias", "receipt_mid", "receipt_only",
  "failed_only", "conflicted_only", "completed_only", "cycle_a", "cycle_b", "cycle_tail", "self", "own_row", "shadowed", "missing", "current_only", "long_0"]
  .map(id => `conversation_${id}`);

test.each(["off", "sqlite"] as const)("targeted %s retention agrees with the full map for every pending identity", mode => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-read-"));
  const filename = path.join(directory, "registry.json");
  fs.writeFileSync(filename, JSON.stringify(fixture(20)));
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode, now: () => Date.parse(at) });
  try {
    const full = registryConversationRetentionStates(registry.readOnlySnapshot());
    expect(full.get("conversation_own_row")).toBe("dead");
    expect(full.get("conversation_shadowed")).toBe("dead");
    expect(full.get("conversation_revived")).toBe("current");
    expect(full.get("conversation_superseded")).toBe("superseded");
    expect(full.get("conversation_cycle_tail")).toBe("current");
    for (const id of pendingIds) {
      expect(registryConversationRetentionStates(registry.conversationRetentionSnapshot(id)).get(id)).toBe(full.get(id));
    }
  } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("production selectors decode the same rows with ten times the history, cold and warm after process restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-history-"));
  const measure = (history: number) => {
    const filename = path.join(directory, `history-${history}.sqlite`);
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: fixture(history), normalize: normalizeRegistry });
    store.close();
    const script = `
      import { AgentRegistry } from ${JSON.stringify(path.join(import.meta.dir, "registry.ts"))};
      import { maintainRuntimeJournal } from ${JSON.stringify(path.resolve(import.meta.dir, "../../runtime-host/journalRetention.ts"))};
      import { RuntimeJournal } from ${JSON.stringify(path.resolve(import.meta.dir, "../../runtime-host/journal.ts"))};
      let reads = 0, parses = 0;
      const registry = new AgentRegistry(process.argv[1] + ".json", undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: process.argv[1], now: () => ${Date.parse(at)},
        onSqliteRowPayloadRead: (_, n) => { reads += n; }, onSqliteRowPayloadParse: () => { parses++; } });
      const ids = JSON.parse(process.argv[2]);
      const journal = new RuntimeJournal(process.argv[1] + ".events", { structuredHosts: true, now: () => ${Date.parse(at)} });
      for (const [index, id] of [...ids, ids[0]].entries()) journal.executeOperation({ kind: "spawn", conversationId: id,
        operationId: "operation_" + index, idempotencyKey: "spawn-" + index, engine: "codex", cwd: "/repo", prompt: "start" });
      const result = [];
      for (let pass = 0; pass < 2; pass++) {
        reads = 0; parses = 0;
        const tick = maintainRuntimeJournal(journal, () => registry);
        result.push({ reads, parses, tick });
      }
      reads = 0; parses = 0;
      const empty = new RuntimeJournal(process.argv[1] + ".empty", { structuredHosts: true, now: () => ${Date.parse(at)} });
      const emptyTick = maintainRuntimeJournal(empty, () => registry);
      result.push({ reads, parses, tick: emptyTick });
      empty.close(); journal.close(); registry.close(); console.log(JSON.stringify(result));`;
    const child = Bun.spawnSync([process.execPath, "-e", script, filename, JSON.stringify(pendingIds)], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString()) as Array<{ reads: number; parses: number; tick: { scanned: number; settled: number } }>;
  };
  try {
    const small = measure(20), large = measure(200);
    expect(large).toEqual(small);
    expect(small[0]!.reads).toBeGreaterThan(0);
    expect(small[0]!.reads).toBeLessThan(600);
    expect(small[1]!.tick).toEqual(small[0]!.tick);
    expect(small[0]!.tick).toEqual({ scanned: pendingIds.length + 1, settled: 0 });
    expect(small[2]).toEqual({ reads: 0, parses: 0, tick: { scanned: 0, settled: 0 } });
    expect(measure(20)).toEqual(small);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a warmed retention read follows peer receipt, entry and alias changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-peer-"));
  const filename = path.join(directory, "registry.sqlite");
  const writer = new SqliteAgentRegistryStore(filename, { initialSnapshot: fixture(20), normalize: normalizeRegistry });
  const reader = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: filename, now: () => Date.parse(at) });
  const state = (id: string) => registryConversationRetentionStates(reader.conversationRetentionSnapshot(id)).get(id);
  try {
    expect(state("conversation_outer")).toBe("dead");
    writer.mutate(file => { file.entries["codex:dead"]!.status = "idle"; }, false);
    expect(state("conversation_outer")).toBe("current");
    writer.mutate(file => { file.conversationAliases.conversation_inner = "conversation_receipt_only"; }, false);
    expect(state("conversation_outer")).toBe("current");
    writer.mutate(file => { file.receipts["pending-only"]!.state = "failed"; }, false);
    expect(state("conversation_outer")).toBe("dead");
    writer.mutate(file => { delete file.conversationAliases.conversation_receipt_alias; }, false);
    expect(state("conversation_receipt_alias")).toBe("dead");
    // Existing expression indexes must bound both reverse-alias and receipt selection.
    const db = new Database(filename, { readonly: true });
    try {
      for (const [collection, expression, values] of [
        ["conversationAliases", "json_extract(value_json, '$')", ["conversation_dead"]],
        ["receipts", "json_extract(value_json, '$.conversationId')", ["conversation_dead"]],
        ["receipts", "json_extract(value_json, '$.conversationId')", ["conversation_dead", "conversation_inner", "conversation_dead"]],
      ] as const) {
        // matchingRowKeys splits multi-value and duplicate inputs into distinct
        // one-value seeks, then merges row_order. Exercise those exact seeks.
        for (const value of new Set(values)) {
          const jsonPath = collection === "conversationAliases" ? "$" : "$.conversationId";
          const sql = collection === "receipts"
            ? `SELECT row_key,row_order FROM registry_hot_rows WHERE collection='receipts' AND json_extract(value_json,'${jsonPath}') IN (?)
                UNION ALL SELECT a.row_key,a.row_order FROM registry_archive a CROSS JOIN registry_cold c
                WHERE a.collection='receipts' AND json_extract(a.value_json,'${jsonPath}') IN (?)
                  AND c.collection=a.collection AND c.row_key=a.row_key AND c.archive_id=a.id ORDER BY row_order`
            : `SELECT row_key,row_order FROM registry_records WHERE collection=? AND ${expression} IN (?) ORDER BY row_order`;
          const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(collection === "receipts" ? [value, value] : [collection, value]));
          expect(JSON.stringify(plan)).toContain("USING INDEX registry_lookup_");
          expect(JSON.stringify(plan)).not.toContain("SCAN registry_rows");
        }
      }
    } finally { db.close(); }
  } finally { reader.close(); writer.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
