import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeRegistry } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { archiveRetirementReport, RETIREMENT_GRACE_MS } from "@/lib/agent/registryArchiveRetirement";
import { approveFixture, preservation, RETIREMENT_NOW, retirementFixture } from "@/lib/agent/registryArchiveRetirement.fixture";

// Synthetic, public fixture with the measured production distribution. Never
// accepts a source database or a state directory. Every file is owned here.
const shape = [
  ["heldDeliveries",34653,34273,3867,1240],
  ["deliveryOperationOwners",40330,39889,248,11290],
  ["receipts",23564,23173,6669,8430],
  ["conversations",22842,10855,308420,1660],
  ["entries",21267,20929,2010,1430],
  ["lineageEdges",19103,17677,24,925],
  ["memberships",17510,16115,0,325],
  ["migrationIntents",281,207,2,500],
  ["agentStates",18348,0,0,1315],
] as const;
if (process.argv.slice(2).join(" ") !== "--fixture") throw new Error("usage: measure-registry-archive-retirement.ts --fixture");
const root = fs.mkdtempSync(path.join(os.tmpdir(),"registry-retirement-measure-"));
try {
  const templatesRoot = path.join(root,"templates"); fs.mkdirSync(templatesRoot);
  const templatesFile = retirementFixture(templatesRoot,8);
  const templates = new Database(templatesFile,{ readonly: true });
  const filename = path.join(root,"agent-registry.sqlite");
  const store = new SqliteAgentRegistryStore(filename,{ normalize: normalizeRegistry,initialSnapshot: normalizeRegistry({ version: 2,entries: {},receipts: {} }) });
  const db = new Database(filename); db.run("PRAGMA foreign_keys=ON");
  db.run("PRAGMA auto_vacuum=NONE"); db.run("VACUUM");
  try {
    const row = db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES (?,?,?,?)");
    const archive = db.query<{ id: number }, [string,string,string,number]>("INSERT INTO registry_archive(collection,row_key,value_json,row_order) VALUES (?,?,?,?) RETURNING id");
    const mapping = db.query("INSERT INTO registry_cold VALUES (?,?,?)");
    db.transaction(() => {
      for (const [collection,logical,cold,dead,payloadBytes] of shape) {
        const raw = templates.query<{ value_json: string }, [string]>("SELECT value_json FROM registry_rows WHERE collection=? ORDER BY row_order DESC LIMIT 1").get(collection)?.value_json ?? "{}";
        const original = JSON.parse(raw);
        const retained = templates.query<{ row_key: string; value_json: string }, [string]>("SELECT row_key,value_json FROM registry_rows WHERE collection=? ORDER BY row_order").all(collection);
        for (let n=0;n<logical;n++) {
          const key = retained[n]?.row_key ?? `fixture-${collection}-${String(n).padStart(6,"0")}`;
          const value = n<retained.length ? JSON.parse(retained[n]!.value_json)
            : { ...original,id: key,fixturePadding: "x".repeat(Math.max(0,payloadBytes-Buffer.byteLength(raw)-100)) };
          const json = JSON.stringify(value); row.run(collection,key,json,n);
          if (n>=logical-cold) mapping.run(collection,key,archive.get(collection,key,json,n)!.id);
        }
        // Historical versions reference existing keys and have lower order.
        // Superseded cold, promoted-hot and deleted-key versions all occur.
        const json = JSON.stringify({ ...original,fixturePadding: "y".repeat(Math.max(0,payloadBytes-Buffer.byteLength(raw)-100)) });
        for (let n=0;n<dead;n++) archive.get(collection,`historical-${n%Math.max(1,cold)}`,json,n%(logical-1));
      }
    })();
    console.log("fixture seeded");
    const before = archiveRetirementReport(db,RETIREMENT_NOW), preserved = preservation(db);
    const io = () => {
      if (process.platform !== "linux") return null;
      return Number(/^write_bytes: (\d+)$/m.exec(fs.readFileSync("/proc/self/io","utf8"))![1]);
    };
    const backup = (name: string) => {
      const target = path.join(root,name); const start = io();
      db.run("VACUUM INTO ?",[target]);
      const copy = new Database(target);
      try { copy.run("PRAGMA journal_mode=DELETE");
        if (JSON.stringify(copy.query("PRAGMA integrity_check").all()) !== '[{"integrity_check":"ok"}]') throw new Error("backup integrity failed");
      } finally { copy.close(); }
      const end = io();
      return { fileBytes: fs.statSync(target).size,processWriteBytes: start===null || end===null ? null : end-start };
    };
    const backupBefore = [backup("before-1.sqlite"),backup("before-2.sqlite")];
    approveFixture(filename);
    for (let pass=0;pass<1000;pass++) {
      store.retireSupersededArchive(store.prepareArchiveRetirement(),RETIREMENT_NOW);
      await new Promise<void>(resolve => setImmediate(resolve));
      if ((db.query("SELECT value FROM registry_archive_retirement_state WHERE key='cursor'").get() as { value: number }).value===0) break;
      if (pass===999) throw new Error("observation did not converge");
    }
    const timings: number[] = [];
    for (let batch=0;batch<10000;batch++) {
      const start = performance.now();
      const retired = store.retireSupersededArchive(undefined,RETIREMENT_NOW+RETIREMENT_GRACE_MS+1);
      timings.push(performance.now()-start);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!retired) break;
      if (batch===9999) throw new Error("retirement did not converge");
    }
    if (JSON.stringify(preservation(db))!==JSON.stringify(preserved)) throw new Error("preservation mismatch");
    const after = archiveRetirementReport(db,RETIREMENT_NOW+RETIREMENT_GRACE_MS+1);
    const backupAfter = [backup("after-1.sqlite"),backup("after-2.sqlite")];
    timings.sort((a,b) => a-b);
    console.log(JSON.stringify({ fixture: "Synthetic production distribution; no production input",before,after,
      backupBefore,backupAfter,preservation: preserved,
      batchMs: { count: timings.length,p50: timings[Math.floor(timings.length*.5)],p99: timings[Math.floor(timings.length*.99)],max: timings.at(-1) } },null,2));
  } finally { db.close(); store.close(); templates.close(); }
} finally { fs.rmSync(root,{ recursive: true,force: true }); }
