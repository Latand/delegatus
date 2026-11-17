import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { AgentRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import { reconcileMigrations } from "./coordinator";
import { noSuccessor } from "./peakLoad.fixture";

test("intent completion conserves an unknown migration phase and commits a known ending atomically", () => {
  for (const mode of ["off", "sqlite"] as const) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-intent-custody-"));
    const filename = path.join(directory, "registry.json");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
    try {
      const conversation = registry.ensureConversation("codex", "/sessions/intent-custody.jsonl", "account-a");
      const intent = registry.upsertMigrationIntent("codex", "account-b", "manual", "intent-custody");
      registry.setConversationMigration(conversation.id, { intentId: intent.id, phase: "waiting-turn", targetId: "account-b",
        revision: intent.revision, sourceGenerationId: conversation.generations[0]!.id, operationId: "intent-custody-operation",
        error: null, errorCode: null, providerReceipt: null, updatedAt: "2026-11-17T06:00:00Z" });
      const cooldown = "2026-11-17T07:00:00Z";
      registry.completeSettledMigrationIntent(intent.id, cooldown);
      expect(registry.readOnlySnapshot().migrationIntents[intent.id]?.state).toBe("draining");
      registry.setConversationMigration(conversation.id, { ...registry.conversation(conversation.id)!.migration!,
        phase: "future-phase" as "waiting-turn" });
      registry.completeSettledMigrationIntent(intent.id, cooldown);
      expect(registry.readOnlySnapshot().migrationIntents[intent.id]?.state).toBe("draining");
      expect(registry.autoBalancePolicy("codex").cooldownUntil).not.toBe(cooldown);
      registry.setConversationMigration(conversation.id, { ...registry.conversation(conversation.id)!.migration!, phase: "rolled-back" });
      registry.completeSettledMigrationIntent(intent.id, cooldown);
      const after = registry.readOnlySnapshot();
      expect(after.migrationIntents[intent.id]?.state).toBe("complete");
      expect(after.autoBalance.codex.cooldownUntil).toBe(cooldown);
    } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test("a zero-budget migration pass reads nothing, including discovery and repair", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-budget-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const read = spyOn(registry, "readOnlySnapshot");
  try {
    await reconcileMigrations(noSuccessor, { async deliver() { throw new Error("unexpected dispatch"); } }, registry, { passBudgetMs: 0 });
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("large settled history is never reconstructed by an idle migration pass", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-history-"));
  const shape = { ...scaledRegistryPerformanceShape(0.02), conversations: 1_000, heldDeliveries: 4_096,
    deliveryOperationOwners: 4_096, pendingDeliveries: 0, uncertainDeliveries: 0, migrationIntents: 0 };
  const made = buildRegistryPerformanceDataset(directory, shape);
  const parsed: string[] = [];
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename: made.filename,
    onSqliteRowPayloadParse: (collection, count) => { for (let i = 0; i < count; i++) parsed.push(collection); },
  });
  const read = spyOn(registry, "readOnlySnapshot");
  parsed.length = 0;
  try {
    const started = performance.now();
    await reconcileMigrations(noSuccessor, { async deliver() { throw new Error("unexpected dispatch"); } }, registry);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(read).not.toHaveBeenCalled();
    expect(parsed.filter(collection => collection === "heldDeliveries")).toHaveLength(0);
    expect(parsed.length).toBeLessThan(100);
  } finally { read.mockRestore(); registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}, 30_000);

test("a bounded discovery page resumes after a real process restart without redispatching settled sends", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-restart-"));
  const shape = { ...scaledRegistryPerformanceShape(0.02), conversations: 160, entries: 56, heldDeliveries: 1_024,
    deliveryOperationOwners: 1_024, pendingDeliveries: 0, uncertainDeliveries: 128, migrationIntents: 0 };
  const made = buildRegistryPerformanceDataset(directory, shape);
  const db = new Database(made.filename);
  db.exec(`UPDATE registry_rows SET value_json=json_set(value_json,'$.state','assigned','$.recoveryIntent','reclaimed-host',
    '$.generationId',(SELECT json_extract(c.value_json,'$.generations[0].id') FROM registry_rows c
      WHERE c.collection='conversations' AND c.row_key=json_extract(registry_rows.value_json,'$.conversationId')))
    WHERE collection='heldDeliveries' AND json_extract(value_json,'$.state')='delivery-uncertain'`);
  db.close();
  const code = `
    import { AgentRegistry } from ${JSON.stringify(new URL("../../agent/registry.ts", import.meta.url).pathname)};
    import { reconcileMigrations } from ${JSON.stringify(new URL("./coordinator.ts", import.meta.url).pathname)};
    const registry = new AgentRegistry(process.argv[1], undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: process.argv[2] });
    const sent = [];
    await reconcileMigrations({ async create() { throw new Error("unexpected successor"); }, async verify() {} },
      { async deliver({ delivery }) { sent.push(delivery.command.operationId); return "delivered"; } }, registry, { passBudgetMs: 20_000 });
    registry.close();
    console.log("RESULT " + JSON.stringify(sent));
  `;
  const run = async () => {
    const child = Bun.spawn([process.execPath, "--eval", code, path.join(directory, "registry.json"), made.filename],
      { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
    return JSON.parse(output.split("RESULT ")[1]!) as string[];
  };
  try {
    const first = await run();
    expect(first).toHaveLength(64);
    const second = await run();
    expect(second).toHaveLength(64);
    expect(new Set([...first, ...second]).size).toBe(128);
    expect(await run()).toEqual([]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 150_000);


test("positive discovery expiry resumes unchanged work and dispatches original admissions once across processes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "migration-positive-budget-"));
  const shape = { ...scaledRegistryPerformanceShape(0.02), conversations: 160, entries: 56, heldDeliveries: 1_024,
    deliveryOperationOwners: 1_024, pendingDeliveries: 0, uncertainDeliveries: 128, migrationIntents: 0 };
  const made = buildRegistryPerformanceDataset(directory, shape);
  const db = new Database(made.filename);
  db.exec(`UPDATE registry_rows SET value_json=json_set(value_json,'$.recoveryIntent','reclaimed-host',
    '$.generationId',(SELECT json_extract(c.value_json,'$.generations[0].id') FROM registry_rows c
      WHERE c.collection='conversations' AND c.row_key=json_extract(registry_rows.value_json,'$.conversationId')))
    WHERE collection='heldDeliveries' AND json_extract(value_json,'$.state')='delivery-uncertain'`);
  const expected = db.query<{ value_json: string }, []>("SELECT value_json FROM registry_rows WHERE collection='heldDeliveries' AND json_extract(value_json,'$.state')='delivery-uncertain'")
    .all().map(row => JSON.parse(row.value_json)).map(row => [row.id, row.command.operationId, row.clientMessageId, row.generationId]);
  db.close();
  const ledger = path.join(directory, "dispatches.json");
  const code = `
    import fs from "node:fs";
    import { AgentRegistry } from ${JSON.stringify(new URL("../../agent/registry.ts", import.meta.url).pathname)};
    import { reconcileMigrations } from ${JSON.stringify(new URL("./coordinator.ts", import.meta.url).pathname)};
    const registry = new AgentRegistry(process.argv[1], undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: process.argv[2] });
    const mode = process.argv[3]; const ledger = process.argv[4];
    const seen = new Set(); let firstCount = 0;
    const delay = new Int32Array(new SharedArrayBuffer(4));
    const port = { async deliver({ delivery }) {
      const sent = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf8")) : [];
      sent.push([delivery.id, delivery.command.operationId, delivery.clientMessageId, delivery.generationId]);
      fs.writeFileSync(ledger, JSON.stringify(sent));
      Atomics.wait(delay, 0, 0, 40); return "delivered";
    }, async reconcileUncertain({ delivery }) {
      seen.add(delivery.id); Atomics.wait(delay, 0, 0, 40); return "delivery-uncertain";
    } };
    const provider = { async create() { throw new Error("unexpected successor"); }, async verify() {} };
    for (let pass = 0; pass < (mode === "observe" ? 64 : 256); pass++) {
      console.log("START " + pass);
      await reconcileMigrations(provider, port, registry, { passBudgetMs: 160 });
      console.log("END " + pass);
      if (!pass) firstCount = seen.size;
      if (mode === "observe" && seen.size === 128) break;
      if (mode === "once" || mode === "dispatch" && registry.migrationWorkPage("heldDeliveries", "", 1).length === 0) break;
    }
    registry.close(); console.log("RESULT " + JSON.stringify({ seen: [...seen], firstCount }));
  `;
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, "--eval", code, path.join(directory, "registry.json"), made.filename, mode, ledger],
      { env: process.env, stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let output = "";
    const errors = new Response(child.stderr).text();
    try {
      let buffer = "";
      const stdout = child.stdout.getReader();
      try {
        for (;;) {
          const { value: chunk, done } = await stdout.read();
          if (done) break;
          const text = new TextDecoder().decode(chunk); output += text; buffer += text;
          while (buffer.includes("\n")) {
            const at = buffer.indexOf("\n"); const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
            if (line.startsWith("START ")) timer = setTimeout(() => { expired = true; child.kill(); }, 1400);
            if (line.startsWith("END ")) clearTimeout(timer);
          }
        }
      } finally { stdout.releaseLock(); }
      expect({ exit: await child.exited, errors: await errors, expired }).toEqual({ exit: 0, errors: "", expired: false });
      return JSON.parse(output.split("RESULT ")[1]!);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); await child.exited; }
  };
  try {
    const observed = await run("observe");
    expect(observed.firstCount).toBeGreaterThan(0);
    expect(observed.firstCount).toBeLessThan(64);
    expect(observed.seen.sort()).toEqual(expected.map(row => row[0]).sort());
    const database = new Database(made.filename);
    const unchanged = database.query<{ value_json: string }, []>("SELECT value_json FROM registry_rows WHERE collection='heldDeliveries' AND json_extract(value_json,'$.state')='delivery-uncertain'")
      .all().map(row => JSON.parse(row.value_json)).map(row => [row.id, row.command.operationId, row.clientMessageId, row.generationId]);
    expect(unchanged).toEqual(expected);
    database.exec("UPDATE registry_rows SET value_json=json_set(value_json,'$.state','assigned') WHERE collection='heldDeliveries' AND json_extract(value_json,'$.state')='delivery-uncertain'");
    database.close();
    await run("once");
    const first = JSON.parse(fs.readFileSync(ledger, "utf8"));
    expect(first.length).toBeGreaterThan(0); expect(first.length).toBeLessThan(64);
    await run("dispatch");
    const sent = JSON.parse(fs.readFileSync(ledger, "utf8")) as string[][];
    expect(sent.sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual(expected.sort((a, b) => a[0]!.localeCompare(b[0]!)));
    expect(new Set(sent.map(row => row[1])).size).toBe(128);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 150_000);
