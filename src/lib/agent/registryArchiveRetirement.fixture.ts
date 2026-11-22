import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { archiveRetirementReport, RETIREMENT_GRACE_MS, retirementApprovalFile } from "./registryArchiveRetirement";
import { databaseFileIdentity } from "@/lib/state/currentDatabase";

export const RETIREMENT_NOW = Date.parse("2026-11-18T12:00:00Z");
export function approveFixture(filename: string, batchSize = 250) {
  const db = new Database(filename,{ readonly: true });
  try {
    fs.writeFileSync(retirementApprovalFile(filename),JSON.stringify({ category: "A",digest: archiveRetirementReport(db,RETIREMENT_NOW).digest,
      databaseIdentity: databaseFileIdentity(filename),graceMs: RETIREMENT_GRACE_MS,batchSize,cycleBatches: 4 }));
  } finally { db.close(); }
}

/** Product-produced row shapes, frozen timestamps and stable identifiers. */
export function retirementFixture(root: string, count = 160) {
  const seed = new AgentRegistry(path.join(root,"seed.json"),undefined,undefined,{ sqliteMode: "off" });
  const original = seed.ensureConversation("codex","/fixture/session.jsonl",null);
  const delivery = seed.holdDelivery(original.id,"preserved send text","fixture-key");
  const receipt = seed.beginSpawn("codex","/fixture",{ title: "Retirement fixture" });
  const source = seed.snapshot(); seed.close();
  const template = source.heldDeliveries[delivery.id]!;
  const owner = source.deliveryOperationOwners[template.command.operationId]!;
  const initial = normalizeRegistry({ version: 2,entries: {},receipts: {} });
  const at = "2026-10-01T00:00:00.000Z";
  for (let n=0;n<count;n++) {
    const conversationId = `conversation_retention_${n}` as typeof original.id;
    initial.conversations[conversationId] = { ...structuredClone(original),id: conversationId,createdAt: at,updatedAt: at,
      generations: [],migrationOptOut: null };
    const command = { ...template.command,operationId: `retention-operation-${n}` };
    const id = `retention-delivery-${n}`;
    const state = n===0 ? "held" : n===1 ? "delivery-uncertain" : "delivered";
    initial.heldDeliveries[id] = { ...structuredClone(template),id,conversationId,clientMessageId: `retention-message-${n}`,runtimeConversationId: conversationId,
      command,state,createdAt: at,deliveredAt: n>1 ? at : null };
    initial.deliveryOperationOwners[command.operationId] = { ...structuredClone(owner),conversationId,command,deliveryId: id,
      clientMessageId: `retention-message-${n}`,runtimeConversationId: conversationId,createdAt: at,settledAt: n>1 ? at : null,
      terminalState: n<2 ? null : n===2 ? "failed" : "delivered",
      terminalDisposition: n===2 ? "unverified" : n<2 ? null : "delivered",evidenceText: "preserved evidence ".repeat(64) };
    const launchId = `retention-launch-${n}`;
    initial.receipts[launchId] = { ...structuredClone(receipt),launchId,conversationId,clientAttemptId: `retention-attempt-${n}`,
      requestDigest: "b".repeat(64),createdAt: at,state: n===0 ? "path-pending" : "completed",
      launchDisplay: { prompt: "preserved launch ".repeat(64),echo: "fixture",images: 0 } };
  }
  // Active switch, open intent and permanent evidence-compaction marker.
  const switching = initial.conversations.conversation_retention_0!;
  switching.switchHold = { operationId: "retention-switch",accountId: "fixture",reason: "fixture",at };
  initial.migrationIntents["retention-intent"] = { id: "retention-intent",engine: "codex",targetId: "fixture",origin: "manual",
    revision: 1,state: "draining",createdAt: at,updatedAt: at,requestIds: [],evidence: null,stoppedAt: null };
  initial.deliveryEvidenceCompactions[switching.id] = { conversationId: switching.id,firstAt: at,lastAt: at,dropped: 1 };
  const filename = path.join(root,"agent-registry.sqlite");
  const store = new SqliteAgentRegistryStore(filename,{ initialSnapshot: initial,normalize: normalizeRegistry });
  while (store.archiveInactive(250)) { /* real terminal admission */ }
  // Rewrite conversations and receipts, then archive new versions. Delete one
  // terminal reservation; its original owner still answers keyed replay.
  const db = new Database(filename);
  db.transaction(() => {
    db.run(`UPDATE registry_rows SET value_json=json_set(value_json,'$.updatedAt',?)
      WHERE collection IN ('conversations','receipts')`,["2026-10-02T00:00:00.000Z"]);
    db.run("DELETE FROM registry_rows WHERE collection='heldDeliveries' AND row_key='retention-delivery-3'");
  })();
  while (store.archiveInactive(250)) { /* second version */ }
  db.close(); store.close();
  return filename;
}

export function preservation(db: Database) {
  const digest = (sql: string) => {
    const hash = crypto.createHash("sha256"); let count = 0;
    for (const row of db.query(sql).iterate()) { hash.update(JSON.stringify(row)); count++; }
    return { count,digest: hash.digest("hex") };
  };
  const rows = (where: string) => digest(`SELECT * FROM registry_records WHERE ${where} ORDER BY collection,row_key`);
  return {
    records: rows("1"), compatibility: digest("SELECT * FROM registry_rows ORDER BY collection,row_key"),
    mappings: digest("SELECT * FROM registry_cold ORDER BY collection,row_key"),
    pending: rows("collection='heldDeliveries' AND json_extract(value_json,'$.state') IN ('held','assigned','delivery-uncertain')"),
    openOwners: rows("collection='deliveryOperationOwners' AND json_extract(value_json,'$.terminalState') IS NULL"),
    uncertainOwners: rows("collection='deliveryOperationOwners' AND json_extract(value_json,'$.terminalState')='failed' AND COALESCE(json_extract(value_json,'$.terminalDisposition'),'unverified')='unverified'"),
    owners: rows("collection='deliveryOperationOwners'"), receipts: rows("collection='receipts'"),
    openReceipts: rows("collection='receipts' AND (json_extract(value_json,'$.state') NOT IN ('completed','failed','conflicted') OR json_extract(value_json,'$.repairPending') IS NOT NULL OR json_extract(value_json,'$.queuedPinnedSpawn') IS NOT NULL)"),
    switches: rows("collection='conversations' AND (json_extract(value_json,'$.migration') IS NOT NULL OR json_extract(value_json,'$.switchHold') IS NOT NULL OR json_extract(value_json,'$.reconfigure') IS NOT NULL)"),
    intents: rows("collection='migrationIntents' AND json_extract(value_json,'$.state') NOT IN ('complete','stopped')"),
    compactions: rows("collection='deliveryEvidenceCompactions'"),
    malformedMappings: db.query(`SELECT COUNT(*) AS count FROM registry_cold c LEFT JOIN registry_archive a ON a.id=c.archive_id
      WHERE a.id IS NULL OR a.collection IS NOT c.collection OR a.row_key IS NOT c.row_key`).get(),
    foreignKeys: db.query("PRAGMA foreign_key_check").all(), integrity: db.query("PRAGMA integrity_check").all(),
  };
}

export async function replayAnswers(filename: string, count: number) {
  const registry = new AgentRegistry(path.join(path.dirname(filename),"agent-registry.json"),undefined,undefined,{ sqliteMode: "sqlite",sqliteFilename: filename });
  try {
    await registry.prepareRecoveryIndexes();
    const hash = crypto.createHash("sha256");
    for (let n=0;n<count;n++) {
      hash.update(JSON.stringify(registry.deliverySnapshotForOperation(`retention-operation-${n}`,{ recipientEvidence: true })));
      hash.update(JSON.stringify(registry.deliverySnapshotForMessageKey(`conversation_retention_${n}`,`retention-message-${n}`)));
      hash.update(JSON.stringify(registry.spawnReceiptForClientAttempt(`retention-attempt-${n}`)));
    }
    return { reads: count*3,digest: hash.digest("hex") };
  } finally { registry.close(); }
}

/** Invoked only by the restart test. SIGKILL follows a durable product commit. */
async function worker(filename: string, mode: string) {
  Date.now = () => RETIREMENT_NOW + (mode === "observe" ? 0 : RETIREMENT_GRACE_MS + 1);
  const registry = new AgentRegistry(path.join(path.dirname(filename),"agent-registry.json"),undefined,undefined,{ sqliteMode: "sqlite",sqliteFilename: filename });
  const store = (registry as unknown as { sqliteStore: SqliteAgentRegistryStore }).sqliteStore;
  const db = new Database(filename,{ readonly: true });
  let commits = 0;
  const original = store.retireSupersededArchive.bind(store);
  store.retireSupersededArchive = (...args) => {
    const retired = original(...args);
    if (retired && mode === "kill" && ++commits === 2) process.kill(process.pid,"SIGKILL");
    return retired;
  };
  try {
    for (let cycle=0;cycle<10_000;cycle++) {
      await registry.retireSupersededArchive();
      const cursor = db.query<{ value: number }, []>("SELECT value FROM registry_archive_retirement_state WHERE key='cursor'").get()?.value ?? 0;
      const pending = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM registry_archive_retirements").get()!.count;
      if (cursor===0 && (mode === "observe" || pending===0)) return;
    }
    throw new Error("retirement did not converge");
  } finally { db.close(); registry.close(); }
}
if (import.meta.main) await worker(process.argv[2]!,process.argv[3]!);
