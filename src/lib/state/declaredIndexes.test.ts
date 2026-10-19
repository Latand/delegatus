import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { OWNERSHIP_PRELOAD, ownershipSandbox } from "./fixtures/ownershipSandbox";
import { initializeStateCollections } from "./sqliteStateStore";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { normalizeRegistry } from "@/lib/agent/registry";
import { installHistoryProjection } from "./historyProjection";

type Index = { name: string; sql: string };
function indexes(filename: string): Index[] {
  const db = new Database(filename);
  try { return db.query<Index, []>("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(row => ({ ...row, sql: row.sql.replace(/('(?:[^']|'')*'|"(?:[^"]|"")*")|\s+/g, (token, quoted: string | undefined) => quoted ?? " ") })); }
  finally { db.close(); }
}
function data(filename: string): string {
  const db = new Database(filename);
  try {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return JSON.stringify(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}

test("state reopens with every declared index and preserves all table data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "declared-indexes-"));
  const filename = path.join(root, "state.sqlite");
  const open = () => {
    initializeStateCollections(filename, [{ collection: "fixture", schemaVersion: 1, migrationId: "fixture",
      key: (row: { id: string }) => row.id, loadRecords: () => [{ id: "row" }] }]);
    const db = new Database(filename);
    try { installHistoryProjection(db, root); } finally { db.close(); }
  };
  try {
    open();
    const fixture = new Database(filename);
    try {
      fixture.exec("INSERT INTO pipeline_tick_work VALUES ('fixture',4,9,0,424242,7)");
      fixture.exec("UPDATE pipeline_tick_cursor SET row_order=4,row_key='fixture'");
      fixture.exec("INSERT INTO pipeline_ref_inputs VALUES ('fixture',jsonb('{}'))");
      fixture.exec("INSERT INTO pipeline_attempt_refs VALUES ('fixture',1,'build',1,0,0,0,1,1)");
      fixture.exec("INSERT INTO pipeline_owner_refs VALUES ('fixture','conversation','conversation_fixture',1)");
    } finally { fixture.close(); }
    const declared = indexes(filename);
    expect(declared.length).toBeGreaterThan(30);
    const before = data(filename);
    const queueIndex = declared.find(index => index.name === "pipeline_tick_due")!;
    for (const index of [queueIndex, ...declared.filter(index => index !== queueIndex)]) {
      const db = new Database(filename);
      try { db.exec(`DROP INDEX "${index.name}"`); } finally { db.close(); }
      open();
      expect(indexes(filename).find(row => row.name === index.name), index.name).toEqual(index);
      expect(data(filename), `${index.name} must not rewrite tables`).toBe(before);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("a unique-index repair refuses conflicting rows without changing data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "declared-index-conflict-"));
  const filename = path.join(root, "state.sqlite");
  const open = () => initializeStateCollections(filename, [{collection:"pipelines",schemaVersion:1,migrationId:"fixture",key:(row:{id:string})=>row.id,loadRecords:()=>[]}]);
  try {
    open();
    const declared = indexes(filename).find(index=>index.name==="pipeline_creation_request")!;
    const db = new Database(filename);
    try {
      db.exec("DROP INDEX pipeline_creation_request");
      const put = db.query("INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active) VALUES ('pipelines',?,?,?,1,1)");
      for (const [order,id] of ["first","second"].entries()) {
        put.run(id,JSON.stringify({id,state:"completed",runs:[],stages:[],creationRequest:{key:"fixture"}}),order);
      }
    } finally {db.close();}
    const before = data(filename);
    expect(open).toThrow("UNIQUE constraint failed");
    expect(indexes(filename).some(index=>index.name===declared.name)).toBe(false);
    expect(data(filename)).toBe(before);
    const repair = new Database(filename);
    try {repair.exec("DELETE FROM state_rows WHERE collection='pipelines' AND row_key='second'");}
    finally {repair.close();}
    open();
    expect(indexes(filename).find(index=>index.name===declared.name)).toEqual(declared);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("registry reopens with every declared index and preserves all table data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "declared-registry-indexes-"));
  const filename = path.join(root, "registry.sqlite");
  const open = async () => {
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }), normalize: normalizeRegistry });
    try { await store.prepareRecoveryIndexes(); } finally { store.close(); }
  };
  try {
    await open();
    const fixture = new Database(filename);
    try {
      fixture.exec("INSERT INTO registry_generation_identities VALUES ('conversation_fixture','entry_fixture','artifact_fixture')");
      fixture.exec("INSERT INTO registry_caller_roots VALUES ('conversation_fixture','2026-10-19T00:00:00.000Z',0)");
    } finally { fixture.close(); }
    const declared = indexes(filename);
    expect(declared.length).toBeGreaterThan(40);
    const before = data(filename);
    for (const index of declared) {
      const db = new Database(filename);
      try { db.exec(`DROP INDEX "${index.name}"`); } finally { db.close(); }
      await open();
      expect(indexes(filename).find(row => row.name === index.name), index.name).toEqual(index);
      expect(data(filename), `${index.name} must not rewrite tables`).toBe(before);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


// Use each store's writable initialization path. Read-only connections never
// repair schema. Background-owned indexes use the store's preparation entry.
const otherStores = [
  { name: "activity", async open(file: string) { const { ActivityStore } = await import("@/lib/activity/store"); ActivityStore.open(file).close(); } },
  { name: "team", async open(file: string) { const { TeamStore } = await import("@/lib/team/store"); new TeamStore(file).close(); } },
  { name: "telegram", async open(file: string) {
    const { TelegramBotStore } = await import("@/lib/telegram/bot/store"); new TelegramBotStore(file).close();
    const { outboundState } = await import("@/lib/telegram/bot/outbound"); await outboundState(file, true, () => {});
  } },
  { name: "handoff", async open(file: string) { const { SqliteHandoffQueueStore } = await import("@/lib/runtime/handoffQueueStore"); new SqliteHandoffQueueStore(file)["db"].close(); } },
  { name: "receipts", async open(file: string) { const { SqliteMcpReceiptStore } = await import("@/lib/mcp/server"); new SqliteMcpReceiptStore(file, { now: () => 0 }).close(); } },
  { name: "memory", file: "memory-index.sqlite", async open() { const { MemoryIndex } = await import("@/lib/memory/index"); const store = new MemoryIndex(); try { await store.search({ query: "fixture" }); } finally { store.close(); } } },
  { name: "transcripts", file: "transcript-search.sqlite", async open() { const { prepareTranscriptSearchIndexInBackground } = await import("@/lib/search/transcriptSearch"); prepareTranscriptSearchIndexInBackground(); } },
  { name: "progress", async open(file: string) {
    const { DeliveryProgressStore } = await import("@/lib/runtime/deliveryProgress");
    const store = new DeliveryProgressStore(file, () => 0);
    try { store.note("fixture", "conversation_fixture", { waitReason: "queued" }); expect(store.flush()).toBe(true); } finally { store.close(); }
  } },
  { name: "journal", async open(file: string) {
    const { RuntimeJournal } = await import("@/runtime-host/journal");
    const journal = new RuntimeJournal(file, { now: () => 0 });
    const db = new Database(file);
    try {
      const deadline = performance.now() + 2000;
      while (!db.query("SELECT 1 FROM journal_meta WHERE key='session_host_metadata_ready' AND value='1'").get()) {
        if (performance.now() > deadline) throw new Error("session metadata did not become ready");
        await Bun.sleep(1);
      }
    } finally { db.close(); journal.close(); }
  } },
  { name: "delivery-ledger", file: "role-memory/delivery.sqlite", async open() {
    const { recordMemoryDelivery } = await import("@/lib/memory/deliveryLedger");
    await recordMemoryDelivery({ engine: "codex", conversationId: "conversation_fixture", cwd: process.cwd(), nativeMemoryEnabled: false }, true, () => undefined);
  } },
  { name: "native-queue", async open(file: string) {
    const { NativeQueueJournal } = await import("@/runtime-host/nativeQueueJournal");
    const db = new Database(file, { create: true });
    try { new NativeQueueJournal(db); } finally { db.close(); }
  } },
];

test.each(otherStores)("$name reopens with every declared index", async store => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "declared-store-indexes-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  const filename = path.join(root, store.file ?? "fixture.sqlite");
  try {
    await store.open(filename);
    const declared = indexes(filename);
    expect(declared.length).toBeGreaterThan(0);
    for (const index of declared) {
      const db = new Database(filename);
      try { db.exec(`DROP INDEX "${index.name}"`); } finally { db.close(); }
      await store.open(filename);
      expect(indexes(filename).find(row => row.name === index.name), index.name).toEqual(index);
    }
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test.each(otherStores)("$name fences every missing index in operator-shaped state", async store => {
  const sandbox = ownershipSandbox();
  const directory = path.join(sandbox.home, ".config", "delegatus", "state");
  fs.mkdirSync(directory, { recursive: true });
  const previous = { state: process.env.LLV_STATE_DIR, owner: process.env.LLV_STATE_OWNER, temp: process.env.TMPDIR, node: process.env.NODE_ENV };
  process.env.TMPDIR = sandbox.environment().TMPDIR;
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.LLV_STATE_DIR = directory;
  const filename = path.join(directory, store.file ?? "fixture.sqlite");
  try {
    process.env.LLV_STATE_OWNER = "viewer";
    await store.open(filename);
    const declared = indexes(filename);
    for (const index of declared) {
      const db = new Database(filename);
      try { db.exec(`DROP INDEX "${index.name}"`); } finally { db.close(); }
      const before = data(filename);
      process.env.LLV_STATE_OWNER = "mcp";
      // Some stores report refusal through a return value; either path must
      // leave the missing index and every existing row untouched.
      try { await store.open(filename); } catch { /* explicit refusal */ }
      expect(indexes(filename).some(row => row.name === index.name), index.name).toBe(false);
      expect(data(filename)).toBe(before);
      process.env.LLV_STATE_OWNER = "viewer";
      await store.open(filename);
      expect(indexes(filename).find(row => row.name === index.name)).toEqual(index);
    }
  } finally {
    if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
    if (previous.owner === undefined) delete process.env.LLV_STATE_OWNER; else process.env.LLV_STATE_OWNER = previous.owner;
    if (previous.temp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.temp;
    Object.assign(process.env, { NODE_ENV: previous.node });
    sandbox.release();
  }
});

test("every persistent index declaration has a reopen fixture", () => {
  const covered = [
    "lib/state/sqliteStateStore.ts", "lib/state/pipelineControllerIndex.ts",
    "lib/state/pipelineControllerSchedule.ts", "lib/state/pipelineControllerReferences.ts", "lib/state/historyProjection.ts",
    "lib/agent/sqliteRegistryStore.ts", "lib/agent/registryArchive.ts",
    "lib/activity/store.ts", "lib/activity/tokenStore.ts", "lib/team/store.ts",
    "lib/telegram/bot/store.ts", "lib/telegram/bot/outbound.ts", "lib/runtime/handoffQueueStore.ts",
    "lib/runtime/deliveryProgress.ts", "lib/mcp/server.ts", "lib/memory/index.ts",
    "lib/memory/deliveryLedger.ts", "lib/search/transcriptSearch.ts",
    "runtime-host/journal.ts", "runtime-host/journalSessionMetadata.ts", "runtime-host/nativeQueueJournal.ts",
    // Process-local :memory: projection: each construction creates its tables and indexes together.
    "lib/mcp/boardSelection.ts",
  ];
  const sourceRoot = path.resolve(import.meta.dir, "../..");
  const declarations = [...new Bun.Glob("**/*.ts").scanSync(sourceRoot)].filter(file =>
    !file.includes(".test.") && /CREATE (?:UNIQUE )?INDEX /.test(fs.readFileSync(path.join(sourceRoot, file), "utf8")));
  expect(declarations.sort()).toEqual(covered.sort());
});


test("fresh processes repair indexes only with startup authority", () => {
  const sandbox = ownershipSandbox();
  const directory = path.join(sandbox.home, ".config", "delegatus", "state");
  fs.mkdirSync(directory, { recursive: true });
  const source = `
    import { initializeStateCollections } from "./src/lib/state/sqliteStateStore";
    import { SqliteAgentRegistryStore } from "./src/lib/agent/sqliteRegistryStore";
    import { normalizeRegistry } from "./src/lib/agent/registry";
    import { RuntimeJournal } from "./src/runtime-host/journal";
    import { SessionHostMetadata } from "./src/runtime-host/journalSessionMetadata";
    import { Database } from "bun:sqlite";
    const [kind, filename, registryMode] = process.argv.slice(1);
    try {
      if (kind === "state") initializeStateCollections(filename, [{ collection:"fixture", schemaVersion:1, migrationId:"fixture", key:r=>r.id, loadRecords:()=>[{id:"fixture"}] }]);
      if (kind === "registry") new SqliteAgentRegistryStore(filename, { initialSnapshot: normalizeRegistry({version:2,entries:{},receipts:{}}), normalize: normalizeRegistry, ...(registryMode === "restricted" ? {allowArchiveMigration:false} : {}) }).close();
      if (kind === "journal") {
        const journal = new RuntimeJournal(filename, {now:()=>0});
        const db = new Database(filename);
        try { new SessionHostMetadata(db).step(); } finally { db.close(); journal.close(); }
      }
    } catch (error) { console.error(error.name); process.exit(7); }
  `;
  const run = (kind: string, filename: string, owner: string | undefined, extra: Record<string, string | undefined> = {}) => Bun.spawnSync({
    cmd: [process.execPath, "--preload", OWNERSHIP_PRELOAD, "-e", source, kind, filename],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...sandbox.environment(), LLV_STATE_DIR: directory, LLV_STATE_OWNER: owner, ...extra }, stdout: "pipe", stderr: "pipe",
  });
  try {
    for (const [kind, missing] of [
      ["state", "pipeline_tick_due"], ["state", "history_path"], ["state", "pipeline_attempt_current"],
      ["state", "state_rows_task_project"], ["registry", "registry_caller_agent_pid"],
      ["registry", "registry_generation_identities_entry"], ["journal", "session_host_activity"],
    ]) {
      const filename = path.join(directory, `${kind}.sqlite`);
      const seed = run(kind!, filename, "viewer");
      expect(seed.exitCode, seed.stderr.toString()).toBe(0);
      for (const owner of ["launcher", "mcp", "tool", "deploy-adapter"]) {
        // Registry writers already require startup authority for archive setup.
        if (kind === "registry") continue;
        const ready = run(kind!, filename, owner);
        expect(ready.exitCode, ready.stderr.toString()).toBe(0);
      }
      const declared = indexes(filename).find(row => row.name === missing)!;
      expect(declared).toBeDefined();
      for (const allowed of ["viewer", "runtime-host"]) {
        const db = new Database(filename);
        try { db.exec(`DROP INDEX "${missing}"`); } finally { db.close(); }
        const before = data(filename);
        if (kind === "state") {
          const target = path.join(directory, "viewer-release.json");
          const authority = path.join(directory, "hot-state-authority.json");
          fs.writeFileSync(target, JSON.stringify({ endpoint: "http://127.0.0.1:1", revision: "a".repeat(40) }));
          fs.writeFileSync(authority, JSON.stringify({ schemaVersion: 1, epoch: 1, mode: "sqlite", releaseRevision: "a".repeat(40), updatedAt: "2026-10-19T00:00:00.000Z" }));
          try {
            const retired = run(kind, filename, "viewer", { LLV_HOT_STATE_RELEASE_REVISION: "b".repeat(40) });
            expect(retired.exitCode).toBe(7);
            expect(indexes(filename).some(row => row.name === missing)).toBe(false);
            expect(data(filename)).toBe(before);
          } finally { fs.unlinkSync(target); fs.unlinkSync(authority); }
        }
        for (const owner of [undefined, "launcher", "mcp", "tool", "deploy-adapter"]) {
          const refused = run(kind!, filename, owner);
          expect(refused.exitCode, `${kind}:${owner}`).toBe(7);
          expect(refused.stderr.toString()).toContain("StateStartupMutationRefused");
          expect(indexes(filename).some(row => row.name === missing)).toBe(false);
          expect(data(filename)).toBe(before);
        }
        const repaired = run(kind!, filename, allowed);
        expect(repaired.exitCode, repaired.stderr.toString()).toBe(0);
        expect(indexes(filename).find(row => row.name === missing)).toEqual(declared);
        expect(data(filename)).toBe(before);
      }
    }
  } finally { sandbox.release(); }
}, 120_000);

test("restricted registry opens refuse repair of every missing constructor index", () => {
  const sandbox = ownershipSandbox();
  const directory = path.join(sandbox.home, ".config", "delegatus", "state");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "registry.sqlite");
  const source = `
    import { SqliteAgentRegistryStore } from "./src/lib/agent/sqliteRegistryStore";
    import { normalizeRegistry } from "./src/lib/agent/registry";
    const [file, mode] = process.argv.slice(1);
    try { new SqliteAgentRegistryStore(file, {initialSnapshot:normalizeRegistry({version:2,entries:{},receipts:{}}),normalize:normalizeRegistry,...(mode === "restricted" ? {allowArchiveMigration:false} : {})}).close(); }
    catch (error) { console.error(error.name); process.exit(7); }
  `;
  const run = (owner: string, mode: "full" | "restricted") => Bun.spawnSync({
    cmd: [process.execPath, "--preload", OWNERSHIP_PRELOAD, "-e", source, filename, mode],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...sandbox.environment(), LLV_STATE_DIR: directory, LLV_STATE_OWNER: owner }, stdout: "pipe", stderr: "pipe",
  });
  try {
    const seeded = run("viewer", "full");
    expect(seeded.exitCode, seeded.stderr.toString()).toBe(0);
    const deferredLookupIndexes = new Set([
      "registry_lookup_launchId", "registry_lookup_requestDigest", "registry_lookup_supersedes_conversationId",
      "registry_lookup_structuredHost_kind", "registry_lookup_parentConversationId",
      "registry_lookup_launchProfile_parentConversationId", "registry_lookup_pendingSpawnCapability_operationId",
      // These belong to the archive migration, which restricted opens skip.
      "registry_changes_collection_seq", "registry_hot_operation",
    ]);
    const declared = indexes(filename).filter(({ name }) =>
      !name.startsWith("registry_archive_") && !deferredLookupIndexes.has(name));
    expect(declared.length).toBeGreaterThan(15);
    const before = data(filename);
    const complete = run("mcp", "restricted");
    expect(complete.exitCode, complete.stderr.toString()).toBe(0);
    expect(indexes(filename)).toEqual(expect.arrayContaining(declared));
    expect(data(filename)).toBe(before);
    for (const index of declared) {
      const db = new Database(filename);
      try { db.exec(`DROP INDEX "${index.name}"`); } finally { db.close(); }
      const missing = data(filename);
      const refused = run("mcp", "restricted");
      expect(refused.exitCode, `${index.name}: ${refused.stderr.toString()}`).toBe(7);
      expect(refused.stderr.toString()).toContain("StateStartupMutationRefused");
      expect(indexes(filename).some(row => row.name === index.name), index.name).toBe(false);
      expect(data(filename)).toBe(missing);
      const repaired = run("viewer", "full");
      expect(repaired.exitCode, repaired.stderr.toString()).toBe(0);
      expect(indexes(filename).find(row => row.name === index.name)).toEqual(index);
      expect(data(filename)).toBe(before);
    }
  } finally { sandbox.release(); }
}, 120_000);


// Opt-in production-sized rehearsal; every reopen runs in a fresh process over
// a copy of the same checkpointed synthetic fixture. No live store is read.
test.skipIf(process.env.LLV_INDEX_REPAIR_BENCHMARK !== "1")("index repair startup on retained history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "index-startup-"));
  const seed = path.join(root, "seed.sqlite");
  const specs = [{ collection: "tasks", schemaVersion: 1, migrationId: "fixture", key: (row: { id: string }) => row.id, loadRecords: () => [] }];
  const source = `import { initializeStateCollections } from "./src/lib/state/sqliteStateStore";
    const start=performance.now();
    initializeStateCollections(process.argv[1], [{collection:"tasks",schemaVersion:1,migrationId:"fixture",key:r=>r.id,loadRecords:()=>[]}]);
    console.log(JSON.stringify({ms:performance.now()-start}));`;
  try {
    initializeStateCollections(seed, specs);
    const db = new Database(seed);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<99999)
        INSERT INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active)
        SELECT 'tasks',printf('task-%06d',i),json_object('id',printf('task-%06d',i),'project','repo-fixture','text',printf('%02048d',i),'status','inbox'),i,1,1 FROM n`);
      db.exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<53298)
        INSERT INTO pipeline_tick_work SELECT printf('pipeline-%06d',i),i,1,i%2,i*1000,i%8 FROM n`);
      db.exec("INSERT INTO pipeline_controller_work SELECT 'publication',row_key,row_order FROM pipeline_tick_work");
      db.exec("INSERT INTO pipeline_ref_inputs SELECT row_key,jsonb('{}') FROM pipeline_tick_work");
      db.exec("INSERT INTO pipeline_attempt_refs SELECT row_key,1,'build',1,0,0,0,1,1 FROM pipeline_tick_work");
      db.exec("INSERT INTO pipeline_owner_refs SELECT row_key,'conversation',row_key,1 FROM pipeline_tick_work");
      db.exec("INSERT INTO history_inputs SELECT 'pipelines',row_key,row_order,'repo-fixture','running',jsonb('{}') FROM pipeline_tick_work");
      db.exec("INSERT INTO history_attempts(collection,row_key,run,attempt,conversationId,agentPath,historical,startedMs) SELECT 'pipelines',row_key,0,0,row_key,row_key,0,row_order FROM pipeline_tick_work");
      db.exec("INSERT INTO history_rounds SELECT row_key,0,row_key,row_key,row_order,'fixture' FROM pipeline_tick_work");
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    console.log(JSON.stringify({store:"state",fixture:{stateRows:100000,taskTextBytes:2048,queueRows:53299,attemptRows:53299,seedBytes:fs.statSync(seed).size},
      ...measureStartup(root, seed, source)}));
  } finally { fs.rmSync(root, {recursive:true,force:true}); }
}, 120_000);


function measureStartup(root: string, seed: string, source: string, selected?: readonly string[]) {
  const declared = indexes(seed);
  const dropped = selected ? declared.filter(index => selected.includes(index.name)) : declared;
  const samples: { completeMs: number; repairedMs: number }[] = [];
  for (let round = 0; round < 3; round++) {
    const times: number[] = [];
    for (const repair of [false, true]) {
      const file = path.join(root, `sample-${round}-${repair}.sqlite`);
      fs.copyFileSync(seed, file);
      if (repair) {
        const db = new Database(file);
        try {
          for (const index of dropped) db.exec(`DROP INDEX "${index.name}"`);
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally { db.close(); }
      }
      const child = Bun.spawnSync({cmd:[process.execPath,"-e",source,file],cwd:path.resolve(import.meta.dir,"../../.."),
        env:{...process.env,LLV_STATE_DIR:root,LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1"},stdout:"pipe",stderr:"pipe"});
      expect(child.exitCode,child.stderr.toString()).toBe(0);
      times.push((JSON.parse(child.stdout.toString()) as {ms:number}).ms);
      expect(indexes(file)).toEqual(declared);
    }
    samples.push({completeMs:times[0]!,repairedMs:times[1]!});
  }
  return {indexes:dropped.length,samples};
}

test.skipIf(process.env.LLV_INDEX_REPAIR_BENCHMARK !== "1")("companion index repair startup on retained history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-index-startup-"));
  try {
    const registry = path.join(root, "registry.sqlite");
    const store = new SqliteAgentRegistryStore(registry, {initialSnapshot:normalizeRegistry({version:2,entries:{},receipts:{}}),normalize:normalizeRegistry});
    store.close();
    const db = new Database(registry);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<53298)
        INSERT INTO registry_rows SELECT 'fixture',printf('row-%06d',i),json_object('text',printf('%02048d',i)),i FROM n`);
      db.exec("INSERT INTO registry_generation_identities SELECT row_key,row_key,row_key FROM registry_rows");
      db.exec("INSERT INTO registry_caller_roots SELECT row_key,'2026-10-19T00:00:00.000Z',row_order FROM registry_rows");
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    const registrySource = `import {SqliteAgentRegistryStore} from "./src/lib/agent/sqliteRegistryStore";
      import {normalizeRegistry} from "./src/lib/agent/registry";
      const start=performance.now();
      const store=new SqliteAgentRegistryStore(process.argv[1],{initialSnapshot:normalizeRegistry({version:2,entries:{},receipts:{}}),normalize:normalizeRegistry});
      store.close();console.log(JSON.stringify({ms:performance.now()-start}));`;
    console.log(JSON.stringify({store:"registry",fixture:{rows:53299,textBytes:2048,generationRows:53299,callerRows:53299,seedBytes:fs.statSync(registry).size},
      ...measureStartup(root,registry,registrySource,indexes(registry).filter(index=>/registry_(generation_identities|caller_)/.test(index.name)).map(index=>index.name))}));
    const journal = path.join(root, "journal.sqlite");
    const {SessionHostMetadata} = await import("@/runtime-host/journalSessionMetadata");
    const metadataDb = new Database(journal, {create:true});
    try {
      metadataDb.exec("PRAGMA journal_mode=WAL");
      metadataDb.exec("CREATE TABLE journal_meta(key TEXT PRIMARY KEY,value TEXT)");
      metadataDb.exec("CREATE TABLE entities(kind TEXT,id TEXT,state_json TEXT,checkpoint_seq INTEGER,updated_at INTEGER)");
      new SessionHostMetadata(metadataDb).step();
      metadataDb.exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<23999)
        INSERT INTO entities SELECT 'session',printf('session-%06d',i),'{"host":"dead"}',i,i FROM n`);
      metadataDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {metadataDb.close();}
    const journalSource = `import {Database} from "bun:sqlite";
      import {SessionHostMetadata} from "./src/runtime-host/journalSessionMetadata";
      const start=performance.now();const db=new Database(process.argv[1]);
      const metadata=new SessionHostMetadata(db);metadata.start();
      if(!metadata.ready)throw Error("metadata did not reopen ready");
      metadata.close();db.close();console.log(JSON.stringify({ms:performance.now()-start}));`;
    console.log(JSON.stringify({store:"session-metadata",fixture:{rows:24000},...measureStartup(root,journal,journalSource)}));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},120_000);
