import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, normalizeRegistry } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { reconcileMigrations } from "./coordinator";
import { noSuccessor } from "./peakLoad.fixture";

function seed(directory: string) {
  const registry = new AgentRegistry(path.join(directory, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  try {
    const conversation = registry.ensureConversation("codex", "/sessions/ownership.jsonl", "account-a");
    const held = registry.holdDelivery(conversation.id, "pending input", "input-key");
    const receipt = registry.beginSpawn("codex", "/repo", { title: "ownership fixture" });
    const file = registry.snapshot();
    const fixedAt = "2026-11-17T06:00:00Z";
    const selected = { ...conversation, id: "conversation_ownership" as typeof conversation.id,
      createdAt: fixedAt, updatedAt: fixedAt,
      generations: conversation.generations.map(generation => ({ ...generation, id: "generation-ownership" })) };
    file.conversations = { [selected.id]: selected };
    file.receipts = {};
    file.heldDeliveries = {};
    file.deliveryOperationOwners = {};
    return { file, conversation: selected,
      template: { ...held, id: "selected-delivery", conversationId: selected.id,
        runtimeConversationId: selected.id, generationId: selected.generations[0]!.id,
        createdAt: fixedAt, assignedAt: fixedAt, command: { ...held.command, operationId: "selected-operation" } },
      receipt: { ...receipt, launchId: "selected-receipt", conversationId: selected.id, createdAt: fixedAt } };
  } finally { registry.close(); }
}

for (const mode of ["off", "sqlite"] as const) test(`${mode}: the advancing actuator page never dispatches an ownerless assigned reservation`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-owner-page-"));
  const { file, conversation, template } = seed(directory);
  for (let i = 0; i < 257; i++) {
    const id = `delivery-${String(i).padStart(5, "0")}`;
    file.heldDeliveries[id] = { ...template, id, state: i < 256 ? "delivery-uncertain" : "assigned",
      generationId: conversation.generations[0]!.id, admissionSeq: i + 1, clientMessageId: `input-${i}`,
      command: { ...template.command, operationId: `operation-${i}` } };
  }
  const filename = path.join(directory, "registry.json");
  fs.writeFileSync(filename, JSON.stringify(file));
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
  const dispatched: string[] = [];
  const before = registry.snapshot().heldDeliveries;
  try {
    for (let pass = 0; pass < 4; pass++) await reconcileMigrations(noSuccessor, {
      async deliver({ delivery }) { dispatched.push(delivery.command.operationId); return "delivered"; },
      async reconcileUncertain() { return "delivery-uncertain"; },
    }, registry, { passBudgetMs: 20_000, servingStartedAt: 0 });
    expect(dispatched).toEqual([]);
    const rows = registry.snapshot().heldDeliveries;
    expect(rows["delivery-00256"]).toMatchObject({ state: "failed", attempts: 0 });
    expect(rows["delivery-00256"]!.error).toContain("no host owns its conversation");
    for (let i = 0; i < 256; i++) expect(rows[`delivery-${String(i).padStart(5, "0")}`]).toEqual(before[`delivery-${String(i).padStart(5, "0")}`]);
  } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

for (const mode of ["off", "sqlite"] as const) test(`${mode}: recovery claim rechecks current ownership and original admission`, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-owner-claim-"));
  try {
    for (const owner of ["absent", "generation", "receipt", "wrong-engine", "terminal", "reclaimed", "replacement", "entry", "entry-wrong-engine", "entry-wrong-generation", "entry-wrong-path"] as const) {
      const { file, conversation, template, receipt } = seed(directory);
      const current = file.conversations[conversation.id]!.generations[0]!;
      const candidate = { ...template, state: "assigned" as const, generationId: current.id };
      file.heldDeliveries[candidate.id] = structuredClone(candidate);
      if (owner === "generation") current.host = { kind: "codex-app-server", identity: "fixture", epoch: 1, verifiedAt: "2026-11-17T06:00:00Z" };
      if (["receipt", "wrong-engine", "terminal"].includes(owner)) file.receipts[receipt.launchId] = { ...receipt,
        conversationId: conversation.id, engine: owner === "wrong-engine" ? "claude" : "codex",
        state: owner === "terminal" ? "completed" : "starting" };
      if (owner.startsWith("entry")) file.entries[`codex:${current.id}`] = {
        key: { engine: owner === "entry-wrong-engine" ? "claude" : "codex",
          sessionId: owner === "entry-wrong-generation" ? "other-generation" : current.id },
        artifactPath: owner === "entry-wrong-path" ? "/sessions/other.jsonl" : current.path,
        cwd: "/repo", accountId: "account-a", status: "idle", host: null,
        structuredHost: { kind: "codex-app-server", endpoint: "stdio:fixture", process: null,
          eventCursor: 0, protocolVersion: "v1", writerClaimEpoch: 1, activeTurnRef: null,
          pendingAttention: [], activeFlags: [] },
        claimEpoch: 1, claimOwner: null, pendingAction: null, updatedAt: "2026-11-17T06:00:00Z",
      };
      if (owner === "reclaimed") file.heldDeliveries[candidate.id]!.recoveryIntent = "reclaimed-host";
      if (owner === "replacement") file.heldDeliveries[candidate.id]!.command = { ...candidate.command, operationId: "replacement-operation" };
      const filename = path.join(directory, `${owner}.json`);
      fs.writeFileSync(filename, JSON.stringify(file));
      const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
      try {
        const result = registry.beginDeliveryAttempt(candidate.id, current.id, { expected: candidate, reason: "ownerless reservation" });
        if (["generation", "receipt", "reclaimed", "entry"].includes(owner)) expect(result).toMatchObject({ state: "delivery-uncertain", attempts: 1 });
        else {
          expect(result).toBeNull();
          expect(registry.snapshot().heldDeliveries[candidate.id]).toMatchObject({ state: owner === "replacement" ? "assigned" : "failed", attempts: 0 });
        }
      } finally { registry.close(); }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const work of ["uncertain", "generation", "receipt", "ownerless"] as const) test(`cold and warm ${work} reconciliation excludes concentrated terminal receipt history`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-owner-history-"));
  const { file, conversation, template, receipt } = seed(directory);
  for (let i = 0; i < 8192; i++) {
    const id = `receipt-${i}`;
    file.receipts[id] = { ...receipt, launchId: id, conversationId: conversation.id, state: "completed" };
  }
  if (work === "receipt") file.receipts["active-receipt"] = { ...receipt, launchId: "active-receipt", conversationId: conversation.id, state: "starting" };
  const current = file.conversations[conversation.id]!.generations[0]!;
  if (work === "generation") current.host = { kind: "codex-app-server", identity: "fixture", epoch: 1, verifiedAt: "2026-11-17T06:00:00Z" };
  for (let i = 0; i < (work === "uncertain" ? 1 : 16); i++) {
    const id = `delivery-${i}`;
    file.heldDeliveries[id] = { ...template, id, state: work === "uncertain" ? "delivery-uncertain" : "assigned",
      generationId: current.id, admissionSeq: i + 1, clientMessageId: `input-${i}`,
      command: { ...template.command, operationId: `operation-${i}` } };
  }
  const sqliteFilename = path.join(directory, "registry.sqlite");
  const store = new SqliteAgentRegistryStore(sqliteFilename, { initialSnapshot: file, normalize: normalizeRegistry });
  store.close();
  let reads = 0;
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename,
    onSqliteRowPayloadRead: (collection, count) => { if (collection === "receipts") reads += count; },
  });
  let dispatched = 0;
  try {
    for (let pass = 0; pass < 2; pass++) {
      reads = 0;
      await reconcileMigrations(noSuccessor, {
        async deliver() { dispatched++; return "held"; },
        async reconcileUncertain() { return "delivery-uncertain"; },
        actuates: () => false,
      }, registry, { passBudgetMs: 20_000 });
      expect(reads).toBe(0);
    }
    expect(dispatched).toBe(0);
    // Exercise the actual writer check too, including a late active receipt
    // after all retained terminal rows. Every scalar equality is indexed.
    const candidate = file.heldDeliveries["delivery-0"]!;
    if (work !== "uncertain") {
      reads = 0;
      const claimed = registry.beginDeliveryAttempt(candidate.id, current.id, { expected: candidate, reason: "ownerless reservation" });
      expect(Boolean(claimed)).toBe(work !== "ownerless");
      expect(reads).toBeLessThanOrEqual(1);
    }
    const db = new Database(sqliteFilename, { readonly: true });
    try {
      const plan = db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN SELECT row_key FROM registry_rows INDEXED BY registry_receipt_claim_owner
        WHERE collection=? AND json_extract(value_json,'$.conversationId') IN (?)
        AND json_extract(value_json,'$.engine') IN (?) AND json_extract(value_json,'$.state') IN (?) ORDER BY row_order LIMIT 1`)
        .all("receipts", conversation.id, "codex", "starting");
      expect(plan.some(row => /SCAN|TEMP B-TREE/.test(row.detail))).toBe(false);
      expect(plan.some(row => row.detail.includes("registry_receipt_claim_owner"))).toBe(true);
    } finally { db.close(); }
  } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
