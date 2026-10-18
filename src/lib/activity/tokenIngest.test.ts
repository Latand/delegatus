import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityStore, conversationDigest, type TurnOwner } from "./store";
import { ingestTranscripts, type IngestSource } from "./ingest";
import { usageMeta, countsFromRow, SUM_TOKENS, maintainUsage, DAY } from "./tokenStore";
import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import { claudeUsage, codexMeta, codexUsage, USAGE_AT, USAGE_NOW, usageRecord } from "./tokenUsage.fixture";
let root: string, database: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "token-ingest-")); database = path.join(root, "records.sqlite"); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const owner: TurnOwner = { conversation: "fixture", project: "fixture", engine: "claude", role: "builder", pipelineId: null, stageId: null };
const attr = () => ({ member: "member-a", account: "account-a", model: null, tier: null });
function file(name: string, rows: unknown[], engine = "claude"): IngestSource {
  const target = path.join(root, name);
  fs.writeFileSync(target, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return { path: target, engine, size: fs.statSync(target).size, mtimeMs: USAGE_NOW - DAY };
}
async function ingest(sources: IngestSource[], extra: Partial<Parameters<typeof ingestTranscripts>[1]> = {}) {
  const store = ActivityStore.open(database);
  try { return await ingestTranscripts(sources, { store, complete: true, listedAt: USAGE_NOW, now: () => USAGE_NOW,
    resolver: () => () => ({ project: "fixture", launch: "pipeline", registered: true, mode: "team", usageAttribution: attr,
      conversation: "parent", agent: { role: "builder", pipelineId: "p-a", stageId: "build" } }), ...extra }); }
  finally { store.close(); }
}
function read<T>(fn: (store: ActivityStore) => T) { const store = ActivityStore.open(database); try { return fn(store); } finally { store.close(); } }
const total = () => read(s => countsFromRow(s.db.query<Parameters<typeof countsFromRow>[0], []>(`SELECT ${SUM_TOKENS} FROM usage_days`).get()!));

test("Claude prefix copies and both fork continuations count exactly in either read order", async () => {
  for (const reverse of [false, true]) {
    database = path.join(root, `claude-${reverse}.sqlite`);
    const a = file("branch-a.jsonl", [claudeUsage("shared"), claudeUsage("own-a")]);
    const b = file("branch-b.jsonl", [claudeUsage("shared"), claudeUsage("own-b")]);
    expect((await ingest(reverse ? [b,a] : [a,b])).failures).toEqual([]);
    expect(total().requests).toBe(3);
    expect((await ingest([a,b])).filesSkipped).toBe(2);
    const shorter = file("branch-a.jsonl", [claudeUsage("shared")]);
    await ingest([shorter,b]); expect(total().requests).toBe(3);
    read(s => s.forgetFile(b.path)); expect(total().requests).toBe(3);
  }
});
test("Codex whole copies, inherited fork totals, legacy repeats, and a transition to response records", async () => {
  for (const reverse of [false, true]) {
    database = path.join(root, `codex-${reverse}.sqlite`);
    const a = file("original.jsonl", [codexMeta("main"), codexUsage("main"), codexUsage("main", 240)], "codex");
    const b = file("mirror.jsonl", [codexMeta("main"), codexUsage("main"), codexUsage("main", 240)], "codex");
    const fork = file("fork.jsonl", [codexMeta("fork", { forked_from_id: "main" }), codexUsage("fork", 1200)], "codex");
    const legacy = file("legacy.jsonl", [codexMeta("legacy"), codexUsage("legacy", 1200, USAGE_AT, true), codexUsage("legacy", 1200, USAGE_AT, true),
      codexUsage("legacy", 1320, USAGE_AT, true), codexUsage("legacy", 1320), codexUsage("legacy", 1440)], "codex");
    expect((await ingest(reverse ? [b,a,fork,legacy] : [a,b,fork,legacy])).failures).toEqual([]);
    expect(total()).toMatchObject({ requests: 6, input: 60, cacheRead: 480, output: 120 });
  }
});
test("Codex null-info events do not create requests or watermarks across process restarts", async () => {
  const target = path.join(root, "codex-null.jsonl");
  const nullInfo = { timestamp: USAGE_AT, type: "event_msg", payload: { type: "token_count", info: null } };
  fs.writeFileSync(target, [codexMeta("thread-null"), nullInfo].map(row => JSON.stringify(row)).join("\n") + "\n");
  const source: IngestSource = { path: target, engine: "codex", size: fs.statSync(target).size, mtimeMs: USAGE_NOW - DAY };
  const inventory = path.join(root, "codex-null-inventory.json");
  const pass = async () => {
    fs.writeFileSync(inventory, JSON.stringify([source]));
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "tokenIngest.child.ts"), database, inventory, String(1 << 20)], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    expect(JSON.parse(output).failures).toEqual([]);
  };
  await pass();
  expect(read(s => s.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_days").get()!.n)).toBe(0);
  expect(read(s => s.db.query("SELECT * FROM usage_codex_threads").all())).toEqual([]);
  expect(read(s => usageMeta(s.db)!.malformed)).toBe(0);
  fs.appendFileSync(target, JSON.stringify(codexUsage("thread-null", 120, USAGE_AT, true)) + "\n");
  source.size = fs.statSync(target).size;
  source.mtimeMs += 1;
  await pass();
  expect(total().requests).toBe(1);
  expect(read(s => s.db.query("SELECT total FROM usage_codex_threads").get())).toEqual({ total: 120 });
});
test("a subagent keeps the parent's attribution and has its own conversation key", async () => {
  const parent = file("parent.jsonl", [codexMeta("parent"), codexUsage("parent")], "codex");
  const child = file("child.jsonl", [codexMeta("child", { source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }), codexUsage("child")], "codex");
  await ingest([parent, child]);
  const rows = read(s => s.db.query<{ conversation:string;project:string;role:string;member:string;account:string }, []>("SELECT conversation, project, role, member, account FROM usage_hours").all());
  expect(new Set(rows.map(r => r.conversation)).size).toBe(2);
  for (const r of rows) expect(r).toMatchObject({ project: "fixture", role: "builder", member: "member-a", account: "account-a" });
});
test("held usage writes no cursor or tokens; expiry records old and malformed coverage", async () => {
  const young = file("young.jsonl", [{ type: "user", entrypoint: "delegatus", timestamp: USAGE_AT, uuid: "held-input", message: { role: "user", content: "fixture request" } }, claudeUsage("held")]); young.mtimeMs = USAGE_NOW;
  const got = await ingest([young], { resolver: () => () => ({ project: "fixture", launch: null, registered: false }) });
  expect(got.filesHeld).toBe(1); expect(total().requests).toBe(0);
  expect(read(s => s.fileCursor(young.path))).toBeNull();
  const old = file("old.jsonl", [claudeUsage("too-old", "2026-01-01T00:00:00Z")]);
  await ingest([old]); expect(read(s => usageMeta(s.db)!.skipped_old)).toBe(1);
});
test("old writer cursors backfill within the shared budget across real process restarts", async () => {
  const sources = Array.from({ length: 3 }, (_, i) => file(`old-${i}.jsonl`, Array.from({ length: 500 }, (_, j) => claudeUsage(`response-${i}-${j}`))));
  read(s => { for (const source of sources) s.commitFile(source.path, { offset: source.size, size: source.size, mtimeMs: source.mtimeMs,
    facts: { engine: "claude", cwd: null, entrypoint: null, sessionMeta: null }, prompted: false }, [], {}, null); });
  const inventory = path.join(root, "inventory.json"); fs.writeFileSync(inventory, JSON.stringify(sources));
  let deferred = 0;
  for (let pass = 0; pass < 20; pass++) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "tokenIngest.child.ts"), database, inventory, String(64 << 10)], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    const result = JSON.parse(output); expect(result.failures).toEqual([]); deferred += result.filesDeferred;
    expect(result.bytesRead).toBeLessThanOrEqual(64 << 10);
    if (!result.filesDeferred) break;
  }
  expect(deferred).toBeGreaterThan(0); expect(total().requests).toBe(1500);
  expect((await ingest(sources)).filesSkipped).toBe(3);
  expect(read(s => s.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version)).toBe(3);
});
test("a mixed-release shorter-file cursor replays tokens from zero and dedupes old responses after restart", async () => {
  const source = file("mixed-release.jsonl", [claudeUsage("response-a"), claudeUsage("response-b"), claudeUsage("response-c")]);
  expect((await ingest([source])).failures).toEqual([]);
  expect(total().requests).toBe(3);
  fs.writeFileSync(source.path, JSON.stringify(claudeUsage("response-d")) + "\n");
  source.size = fs.statSync(source.path).size;
  // An old release updates only the columns it knows and leaves usage_offset ahead.
  read(s => s.db.query("UPDATE activity_files SET offset=?, size=?, mtime_ms=? WHERE path=?")
    .run(source.size, source.size, source.mtimeMs, source.path));
  expect(read(s => s.fileCursor(source.path))).toMatchObject({ offset: source.size, usageOffset: expect.any(Number) });
  expect(read(s => s.fileCursor(source.path)!.usageOffset)).toBeGreaterThan(source.size);
  const inventory = path.join(root, "mixed-release-inventory.json"); fs.writeFileSync(inventory, JSON.stringify([source]));
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "tokenIngest.child.ts"), database, inventory, String(1 << 20)], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  expect(JSON.parse(output).failures).toEqual([]);
  expect(total().requests).toBe(4);
  expect(read(s => s.fileCursor(source.path))).toMatchObject({ offset: source.size, usageOffset: source.size });
});
test("a line larger than the remaining budget waits without reading past the cap", async () => {
  const row=claudeUsage("large-line"); row.message.content[0]!.text="fixture ".repeat(10_000);
  const source=file("large-line.jsonl",[row]);
  const limited=await ingest([source],{budgetBytes:16<<10});
  expect(limited.bytesRead).toBe(16<<10); expect(limited.filesDeferred).toBe(1);
  expect(read(s=>s.fileCursor(source.path)!.usageOffset)).toBe(0); expect(total().requests).toBe(0);
  expect((await ingest([source])).failures).toEqual([]); expect(total().requests).toBe(1);
});
test("a line spanning multiple pieces uses a durable bounded hint across real restarts", async () => {
  const row=claudeUsage("spanning");row.message.content[0]!.text="fixture ".repeat(1000);
  const source=file("spanning.jsonl",[row]);
  const inventory=path.join(root,"spanning-inventory.json");fs.writeFileSync(inventory,JSON.stringify([source]));
  for(const budget of [2048,32768]) {
    const child=Bun.spawn([process.execPath,path.join(import.meta.dir,"tokenIngest.child.ts"),database,inventory,String(budget),"1024"],{stdout:"pipe",stderr:"pipe"});
    const output=await new Response(child.stdout).text(),errors=await new Response(child.stderr).text();expect(await child.exited,errors).toBe(0);
    const result=JSON.parse(output);expect(result.bytesRead).toBeLessThanOrEqual(budget);
    if(budget===2048) {expect(result.filesDeferred).toBe(1);expect(read(s=>s.fileCursor(source.path)!.facts.readBytesHint)).toBeGreaterThan(1024);}
    else {expect(result.filesDeferred).toBe(0);expect(total().requests).toBe(1);}
  }
});
test("a failed transaction rolls back tokens, dedupe and cursor together", () => {
  read(s => {
    s.db.exec("CREATE TRIGGER refuse_cursor BEFORE INSERT ON activity_files BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
    expect(() => s.commitFile("refused", { offset: 1, size: 1, mtimeMs: 1, facts: { engine: "claude", cwd: null, entrypoint: null, sessionMeta: null }, prompted: false }, [], {}, null, null, false,
      { owner, records: [usageRecord("rollback")], attribution: attr, malformed: 0, now: USAGE_NOW })).toThrow("fixture refusal");
    expect(s.db.query("SELECT * FROM usage_hours").all()).toEqual([]);
    expect(s.db.query("SELECT * FROM usage_summaries").all()).toEqual([]);
    expect(s.db.query("SELECT * FROM usage_claude_seen").all()).toEqual([]);
    expect(s.fileCursor("refused")).toBeNull();
  });
});
test("retention deletes at most 10000 per table per pass and continues after reopening", () => {
  read(s => s.transaction(() => {
    for (let i=0; i<10003; i++) s.db.query("INSERT INTO usage_claude_seen VALUES(?, ?)").run(String(i), 1);
    maintainUsage(s.db, USAGE_NOW, "Europe/Kyiv");
    expect(s.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_claude_seen").get()!.n).toBe(3);
  }));
  read(s => s.transaction(() => maintainUsage(s.db, USAGE_NOW, "Europe/Kyiv")));
  expect(read(s => s.db.query("SELECT * FROM usage_claude_seen").all())).toEqual([]);
});

test("a schema-3 store migrates token cursors without replacing activity rows", async () => {
  const source = file("migrated.jsonl", [claudeUsage("migrated")]);
  read(s => {
    s.commitFile(source.path, { offset: source.size, size: source.size, mtimeMs: source.mtimeMs,
      facts: { engine:"claude",cwd:null,entrypoint:null,sessionMeta:null },prompted:true },[],{},null);
    s.db.exec("ALTER TABLE activity_files DROP COLUMN usage_offset");
    s.db.exec("ALTER TABLE activity_files DROP COLUMN usage_facts");
    for (const table of ["usage_hours","usage_days","usage_days_rebuild","usage_claude_seen","usage_codex_threads","usage_meta"]) s.db.exec(`DROP TABLE ${table}`);
  });
  await ingest([source]); expect(total().requests).toBe(1);
  expect(read(s=>s.fileCursor(source.path)!.usageOffset)).toBe(source.size);
  // An older writer advances only its own cursor; the next pass backfills the new bytes.
  const original=source.size;
  fs.appendFileSync(source.path,JSON.stringify(claudeUsage("old-writer-append"))+"\n"); source.size=fs.statSync(source.path).size;
  read(s=>s.db.query("UPDATE activity_files SET offset=?,size=? WHERE path=?").run(source.size,source.size,source.path));
  expect(read(s=>s.fileCursor(source.path)!.usageOffset)).toBe(original);
  await ingest([source]); expect(total().requests).toBe(2);
});

test("a later-dated Codex record below the watermark is reported as a possible branch", async () => {
  const source=file("branched.jsonl",[codexMeta("branch"),codexUsage("branch",240),codexUsage("branch",120,"2026-10-18T00:00:00Z")],"codex");
  await ingest([source]); expect(total().requests).toBe(1); expect(read(s=>usageMeta(s.db)!.branch_skipped)).toBe(1);
});

test("ingest yields during a real peer writer lock, then commits after release", async () => {
  const source=file("contended.jsonl",[claudeUsage("contended")]);
  const store=ActivityStore.open(database);
  const code="const {Database}=require('bun:sqlite'); const db=new Database(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready'); await Bun.stdin.text(); db.exec('ROLLBACK'); db.close();";
  const child=Bun.spawn([process.execPath,"-e",code,database],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  let ingestion:Promise<unknown>|undefined;
  try {
    const reader=child.stdout.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready"); reader.releaseLock();
    ingestion=ingestTranscripts([source],{store,complete:true,listedAt:USAGE_NOW,now:()=>USAGE_NOW,
      resolver:()=>()=>({project:"fixture",registered:true,launch:"operator",usageAttribution:attr})});
    const deadline=performance.now()+5000;
    while(!stateLockWaitsInFlight().some(w=>w.callSite==="activity.transaction")) {
      if(performance.now()>deadline) throw new Error("ingest did not reach its asynchronous writer admission");
      await new Promise<void>(resolve=>setTimeout(resolve,1));
    }
    child.stdin.end(); expect(await child.exited,await new Response(child.stderr).text()).toBe(0);
    await ingestion; expect(total().requests).toBe(1);
  } finally { child.stdin.end(); await child.exited; await ingestion; store.close(); }
});

test("zone rebuild resumes after a real restart and incorporates writes to already scanned hours", async () => {
  const sourceConversations=Array.from({length:10003},(_,i)=>({id:`c-${i}`,key:conversationDigest(`c-${i}`)})).sort((a,b)=>a.key.localeCompare(b.key));
  read(s=>s.transaction(()=>{
    const add=s.db.query("INSERT INTO usage_hours VALUES('', ?, ?, 'fixture-model', 'standard', 'account-a', 'claude', 'fixture', 'builder', 'member-a', NULL, NULL, 1, 10, 80, 10, 4, 20, 5)");
    for(const item of sourceConversations) add.run(Math.floor((USAGE_NOW-DAY)/3_600_000),item.key);
  }));
  const inventory=path.join(root,"empty.json"); fs.writeFileSync(inventory,"[]");
  const pass=async()=>{
    const child=Bun.spawn([process.execPath,path.join(import.meta.dir,"tokenIngest.child.ts"),database,inventory,"maintain:America/New_York"],{stdout:"pipe",stderr:"pipe"});
    const output=await new Response(child.stdout).text(), errors=await new Response(child.stderr).text(); expect(await child.exited,errors).toBe(0); return JSON.parse(output);
  };
  let first;
  for(let i=0;i<3;i++) first=await pass();
  expect(first!.target_zone).toBe("America/New_York"); expect(first!.rebuild_phase).toBe("scan"); expect(first!.rebuild_cursor).not.toBeNull();
  read(s=>{
    const conversation=sourceConversations[0]!.id;
    expect(conversationDigest(conversation) < JSON.parse(first!.rebuild_cursor!)[1]).toBeTrue();
    s.commitFile("concurrent",{offset:1,size:1,mtimeMs:1,prompted:false,facts:{engine:"claude",cwd:null,entrypoint:null,sessionMeta:null}},[],{},null,null,false,
      {owner:{...owner,conversation},records:[usageRecord("concurrent",USAGE_NOW-DAY)],attribution:attr,malformed:0,now:USAGE_NOW});
  });
  let second=first!;
  for(let i=0;i<40 && second.target_zone;i++) second=await pass();
  expect(second.zone).toBe("America/New_York"); expect(second.target_zone).toBeNull();
  expect(total().requests).toBe(10004);
});
