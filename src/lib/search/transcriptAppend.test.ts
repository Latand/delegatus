import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptIndexFeed } from "@/lib/scanner/discover";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-append-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

// Each call is a fresh interpreter: checkpoints and deduplication must survive
// process exit, rather than relying on a module cache.
const driver = `
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { indexTranscriptSources, searchTranscripts } from ${JSON.stringify(path.join(import.meta.dir, "transcriptSearch.ts"))};
const [source, mode] = JSON.parse(process.argv[1]);
const originalStat = fs.promises.stat;
fs.promises.stat = async function(file, ...options) {
  if (file === source.path && mode === "late-truncate") fs.truncateSync(file, 0);
  return originalStat.call(this, file, ...options);
};
let bytes = 0;
let changed = false;
const original = fs.createReadStream;
fs.createReadStream = function(file, options) {
  const stream = original.call(this, file, options);
  if (file === source.path) stream.on("data", chunk => {
    bytes += chunk.length;
    if (mode === "fail") stream.destroy(new Error("fixture read failed"));
    if (mode === "truncate") fs.truncateSync(file, 0);
    if (mode === "append" && !changed) {
      changed = true;
      fs.appendFileSync(file, JSON.stringify({type:"user",timestamp:"2026-08-20T09:00:00.000Z",message:{content:"cobalt concurrent"}}) + "\\n");
    }
    if (mode === "rotate" && !changed) {
      changed = true;
      fs.renameSync(file, file + ".during-read");
      fs.writeFileSync(file, JSON.stringify({type:"user",message:{content:"cobalt replacement"}}) + "\\n");
    }
  });
  return stream;
};
const result = await indexTranscriptSources([source], {complete:true});
const db = new Database(process.env.LLV_STATE_DIR + "/transcript-search.sqlite", {readonly:true});
const rows = db.query("SELECT message_index, speaker, timestamp, byte_offset, line_number, body FROM transcript_messages ORDER BY message_index").all();
db.close();
console.log(JSON.stringify({bytes, result, rows, search:["newest","relevance"].map(order => searchTranscripts({query:"cobalt",order,limit:100}))}));
`;

function line(body: string, engine = "claude"): string {
  const timestamp = "2026-08-20T09:00:00.000Z";
  if (engine === "codex") return JSON.stringify({type:"response_item",timestamp,payload:{type:"message",role:"user",content:body}}) + "\n";
  if (engine === "copilot") return JSON.stringify({type:"user.message",timestamp,data:{content:body}}) + "\n";
  return JSON.stringify({type:"user",timestamp,message:{content:body}}) + "\n";
}

async function run(file: string, state: string, engine: "claude" | "codex" | "copilot" = "claude", mode = "") {
  const stat = fs.statSync(file);
  const source = transcriptIndexFeed([{
    path:file, root:"fixture", name:"session", project:"fixture", title:"Fixture", firstPrompt:"", engine,
    kind:"session", fmt:engine, mtime:stat.mtimeMs / 1000, size:stat.size,
  }], true).sources[0]!;
  const child = Bun.spawn([process.execPath, "--eval", driver, JSON.stringify([source,mode])], {
    env:{...process.env, LLV_STATE_DIR:path.join(sandbox,state)}, stdin:"ignore",stdout:"pipe",stderr:"pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout) as {
    bytes:number; result:{filesRead:number; filesSkipped:number; messagesIndexed:number; failures:Array<{error:string}>};
    rows:Array<{body:string;byte_offset:number;line_number:number}>; search:unknown;
  };
}

async function equalFull(file: string, state: string, engine: "claude" | "codex" | "copilot" = "claude") {
  const incremental = await run(file,state,engine);
  const full = await run(file,`${state}-full-${++fullSequence}`,engine);
  expect(incremental.result.failures).toEqual([]);
  expect(full.result.failures).toEqual([]);
  expect(full.bytes).toBe(fs.statSync(file).size);
  expect(incremental.rows).toEqual(full.rows);
  expect(incremental.search).toEqual(full.search);
  return incremental;
}
let fullSequence = 0;

test("append byte measurement and results match full reindex across process restarts", async () => {
  const file = path.join(sandbox,"measurement.jsonl");
  const seed = Array.from({length:12000}, (_,i) => {
    const body = `cobalt seed ${i} `;
    const raw = line(body);
    return line(body + "x".repeat(329 + (i < 1780 ? 1 : 0) - Buffer.byteLength(raw)));
  }).join("");
  fs.writeFileSync(file,seed);
  expect(Buffer.byteLength(seed)).toBe(3949780);
  const first = await run(file,"measurement");
  expect(first.bytes).toBe(3949780);
  const reads:number[] = [];
  for (let i=0;i<3;i++) {
    const body = `cobalt appended ${i} `;
    const tail = line(body + "x".repeat(331 - Buffer.byteLength(line(body))));
    fs.appendFileSync(file,tail);
    const indexed = await run(file,"measurement");
    expect(indexed.result.failures).toEqual([]);
    reads.push(indexed.bytes);
  }
  const unchanged = await equalFull(file,"measurement");
  console.log(JSON.stringify({seedBytes:first.bytes, appendedBytes:331, appendReads:reads, unchanged:unchanged.bytes}));
  expect(reads).toEqual([331,331,331]);
  expect(unchanged.bytes).toBe(0);
  expect(unchanged.result.filesSkipped).toBe(1);
});

for (const engine of ["claude", "codex", "copilot"] as const) {
  test(`${engine}: partial UTF-8, CRLF, malformed and empty lines resume at one partial line`, async () => {
    const file = path.join(sandbox,`${engine}-partial.jsonl`);
    const complete = line("cobalt initial", engine).replace("\n", "\r\n") + "\ninvalid\r\n";
    const pending = Buffer.from(line("cobalt Ж😀 completion", engine));
    const split = pending.indexOf(Buffer.from("😀")) + 2;
    fs.writeFileSync(file, Buffer.concat([Buffer.from(complete),pending.subarray(0,split)]));
    const first = await run(file,engine,engine);
    expect(first.rows).toHaveLength(1);
    fs.appendFileSync(file, pending.subarray(split));
    const resumed = await run(file,engine,engine);
    expect(resumed.result.failures).toEqual([]);
    expect(resumed.bytes).toBe(pending.length);
    expect(resumed.rows).toHaveLength(2);
    expect(resumed.rows[1]).toMatchObject({body:"cobalt Ж😀 completion",byte_offset:Buffer.byteLength(complete),line_number:4});
    await equalFull(file,engine,engine);

    const unterminated = line("cobalt valid final",engine).trimEnd();
    fs.appendFileSync(file,unterminated);
    expect((await run(file,engine,engine)).rows).toHaveLength(3);
    const suffix = "\n" + line("cobalt following",engine);
    fs.appendFileSync(file,suffix);
    const finalized = await run(file,engine,engine);
    expect(finalized.bytes).toBe(Buffer.byteLength(unterminated + suffix));
    expect(finalized.rows).toHaveLength(4);
    await equalFull(file,engine,engine);
  });
}

test("mirrored Codex representations deduplicate across checkpoints and an unfinished line", async () => {
  const file = path.join(sandbox,"mirror.jsonl");
  const response = line("cobalt mirrored", "codex");
  const event = JSON.stringify({type:"event_msg",timestamp:"2026-08-20T09:00:01.000Z",payload:{type:"user_message",message:"cobalt mirrored"}});
  fs.writeFileSync(file,response);
  await run(file,"mirror","codex");
  fs.appendFileSync(file,event);
  const partial = await run(file,"mirror","codex");
  expect(partial.rows).toHaveLength(1);
  fs.appendFileSync(file,"\n" + line("cobalt following","codex"));
  const resumed = await run(file,"mirror","codex");
  expect(resumed.bytes).toBe(Buffer.byteLength(event + "\n" + line("cobalt following","codex")));
  expect(resumed.rows).toHaveLength(2);
  await equalFull(file,"mirror","codex");
});

test("truncation, same-size rewrite, rotation and engine change read the complete file", async () => {
  const file = path.join(sandbox,"invalidation.jsonl");
  const original = line("cobalt original") + line("cobalt retained");
  fs.writeFileSync(file,original);
  await run(file,"invalidation");
  fs.writeFileSync(file,line("cobalt smaller"));
  fs.utimesSync(file, 1000, 2000);
  const truncated = await run(file,"invalidation");
  expect(truncated.bytes).toBe(fs.statSync(file).size);
  expect(truncated.rows).toHaveLength(1);
  await equalFull(file,"invalidation");

  const beforeRewrite = fs.statSync(file);
  fs.writeFileSync(file,line("cobalt rewrite"));
  fs.utimesSync(file, 1000, 2000);
  expect(fs.statSync(file).size).toBe(beforeRewrite.size);
  expect(fs.statSync(file).mtimeMs).toBe(beforeRewrite.mtimeMs);
  expect(fs.statSync(file).ctimeMs).not.toBe(beforeRewrite.ctimeMs);
  const rewritten = await run(file,"invalidation");
  expect(rewritten.bytes).toBe(fs.statSync(file).size);
  expect(rewritten.rows[0]!.body).toBe("cobalt rewrite");
  await equalFull(file,"invalidation");

  const before = fs.statSync(file);
  fs.renameSync(file,file + ".old");
  fs.writeFileSync(file,line("cobalt rotated"));
  fs.utimesSync(file,before.atime,before.mtime);
  expect(fs.statSync(file).size).toBe(before.size);
  expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  expect(fs.statSync(file).ino).not.toBe(before.ino);
  const rotated = await run(file,"invalidation");
  expect(rotated.bytes).toBe(fs.statSync(file).size);
  expect(rotated.rows[0]!.body).toBe("cobalt rotated");
  await equalFull(file,"invalidation");

  // Same bytes and metadata, interpreted under another engine.
  const changedEngine = await run(file,"invalidation","codex");
  expect(changedEngine.bytes).toBe(fs.statSync(file).size);
  expect(changedEngine.rows).toHaveLength(0);
  await equalFull(file,"invalidation","codex");

  fs.renameSync(file,file + ".second-old");
  fs.writeFileSync(file,line("cobalt replacement one","codex") + line("cobalt replacement two","codex"));
  const grownRotation = await run(file,"invalidation","codex");
  expect(grownRotation.bytes).toBe(fs.statSync(file).size);
  expect(grownRotation.rows).toHaveLength(2);
  await equalFull(file,"invalidation","codex");
});

test("read failures and mid-read truncation roll back both rows and checkpoint before retry", async () => {
  const file = path.join(sandbox,"retry.jsonl");
  fs.writeFileSync(file,line("cobalt initial"));
  const first = await run(file,"retry");
  const tail = line("cobalt appended");
  fs.appendFileSync(file,tail);
  const failed = await run(file,"retry","claude","fail");
  expect(failed.result.failures).toMatchObject([{error:"fixture read failed"}]);
  expect(failed.rows).toEqual(first.rows);
  const retry = await run(file,"retry");
  expect(retry.bytes).toBe(Buffer.byteLength(tail));
  expect(retry.rows).toHaveLength(2);
  await equalFull(file,"retry");
  fs.appendFileSync(file,line("cobalt racing"));
  const raced = await run(file,"retry","claude","truncate");
  expect(raced.result.failures).toMatchObject([{error:"Transcript changed while indexing; the next scan will retry"}]);
  expect(raced.rows).toEqual(retry.rows);
  const empty = await run(file,"retry");
  expect(empty.rows).toHaveLength(0);
  expect(empty.result.failures).toEqual([]);
  fs.appendFileSync(file,line("cobalt after empty"));
  await equalFull(file,"retry");
});

test("absent or invalid checkpoint rebuilds, and pruning cannot replay it", async () => {
  const file = path.join(sandbox,"legacy.jsonl");
  fs.writeFileSync(file,line("cobalt existing"));
  await run(file,"legacy");
  const filename = path.join(sandbox,"legacy","transcript-search.sqlite");
  for (const sql of ["DROP TABLE transcript_checkpoints", "UPDATE transcript_checkpoints SET cursor = '{}'", "UPDATE transcript_checkpoints SET size = -1"]) {
    const db = new Database(filename);
    db.exec(sql);
    db.close();
    const rebuilt = await run(file,"legacy");
    expect(rebuilt.result.failures).toEqual([]);
    expect(rebuilt.bytes).toBe(fs.statSync(file).size);
  }
  const db = new Database(filename);
  db.exec("PRAGMA foreign_keys = ON");
  db.query("DELETE FROM transcript_messages_fts").run();
  db.query("DELETE FROM transcript_files").run();
  expect(db.query("SELECT * FROM transcript_checkpoints").all()).toHaveLength(0);
  db.close();
  fs.appendFileSync(file,line("cobalt after pruning"));
  const restored = await run(file,"legacy");
  expect(restored.bytes).toBe(fs.statSync(file).size);
  expect(restored.rows).toHaveLength(2);
  await equalFull(file,"legacy");
});

test("a concurrent append is consumed on the next pass; rotation during a read rolls back", async () => {
  const file = path.join(sandbox,"concurrent.jsonl");
  fs.writeFileSync(file,line("cobalt initial"));
  await run(file,"concurrent");
  const tail = line("cobalt first tail");
  fs.appendFileSync(file,tail);
  const during = await run(file,"concurrent","claude","append");
  expect(during.result.failures).toEqual([]);
  expect(during.bytes).toBe(Buffer.byteLength(tail));
  expect(during.rows).toHaveLength(2);
  const later = await run(file,"concurrent");
  expect(later.bytes).toBe(Buffer.byteLength(line("cobalt concurrent")));
  expect(later.rows).toHaveLength(3);
  await equalFull(file,"concurrent");
  fs.appendFileSync(file,line("cobalt lost tail"));
  const rotated = await run(file,"concurrent","claude","rotate");
  expect(rotated.result.failures).toMatchObject([{error:"Transcript changed while indexing; the next scan will retry"}]);
  expect(rotated.rows).toEqual(later.rows);
  const replacement = await run(file,"concurrent");
  expect(replacement.bytes).toBe(fs.statSync(file).size);
  expect(replacement.rows).toHaveLength(1);
  expect(replacement.rows[0]!.body).toBe("cobalt replacement");
  await equalFull(file,"concurrent");
  fs.appendFileSync(file,line("cobalt later tail"));
  const lateTruncation = await run(file,"concurrent","claude","late-truncate");
  expect(lateTruncation.result.failures).toMatchObject([{error:"Transcript changed while indexing; the next scan will retry"}]);
  expect(lateTruncation.rows).toEqual(replacement.rows);
  expect((await run(file,"concurrent")).rows).toHaveLength(0);
});

test("checkpoint write refusal rolls back appended rows and can retry after restart", async () => {
  const file = path.join(sandbox,"checkpoint-refusal.jsonl");
  fs.writeFileSync(file,line("cobalt initial"));
  const first = await run(file,"checkpoint-refusal");
  const tail = line("cobalt append after refusal");
  fs.appendFileSync(file,tail);
  const filename = path.join(sandbox,"checkpoint-refusal","transcript-search.sqlite");
  const db = new Database(filename);
  db.exec("CREATE TRIGGER refuse_checkpoint BEFORE UPDATE ON transcript_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture checkpoint refused'); END");
  db.close();
  const refused = await run(file,"checkpoint-refusal");
  expect(refused.result.failures).toMatchObject([{error:"fixture checkpoint refused"}]);
  expect(refused.rows).toEqual(first.rows);
  const recovered = new Database(filename);
  recovered.exec("DROP TRIGGER refuse_checkpoint");
  recovered.close();
  const retry = await run(file,"checkpoint-refusal");
  expect(retry.bytes).toBe(Buffer.byteLength(tail));
  expect(retry.result.failures).toEqual([]);
  expect(retry.rows).toHaveLength(2);
  await equalFull(file,"checkpoint-refusal");
});

test("deduplication history stays bounded and evicts old mirrors across restart", async () => {
  const file = path.join(sandbox,"dedup-bound.jsonl");
  fs.writeFileSync(file, Array.from({length:9}, (_,i) => line(`cobalt mirror ${i}`,"codex")).join(""));
  await run(file,"dedup-bound","codex");
  const db = new Database(path.join(sandbox,"dedup-bound","transcript-search.sqlite"), {readonly:true});
  const checkpoint = db.query<{cursor:string}, []>("SELECT cursor FROM transcript_checkpoints").get()!;
  db.close();
  const recent = JSON.parse(checkpoint.cursor).recent as Array<{key:string}>;
  expect(recent).toHaveLength(8);
  expect(recent.every(entry => entry.key.length === 64)).toBe(true);
  const event = (i:number) => JSON.stringify({type:"event_msg",timestamp:"2026-08-20T09:00:01.000Z",payload:{type:"user_message",message:`cobalt mirror ${i}`}}) + "\n";
  fs.appendFileSync(file,event(0) + event(8));
  const resumed = await run(file,"dedup-bound","codex");
  expect(resumed.result.failures).toEqual([]);
  expect(resumed.rows).toHaveLength(10);
  expect(resumed.rows.at(-1)!.body).toBe("cobalt mirror 0");
  await equalFull(file,"dedup-bound","codex");
});
