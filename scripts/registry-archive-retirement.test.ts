import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retirementFixture } from "../src/lib/agent/registryArchiveRetirement.fixture";
import { retirementApprovalFile } from "../src/lib/agent/registryArchiveRetirement";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root,{ recursive: true,force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"retirement-cli-")); roots.push(root);
  const filename = retirementFixture(root,8);
  for (const name of ["home","config","tmp"]) fs.mkdirSync(path.join(root,name));
  return { root,filename };
}
async function run(root: string, args: string[], explicit = true) {
  const env = { ...process.env,HOME: path.join(root,"home"),XDG_CONFIG_HOME: path.join(root,"config"),
    LLV_STATE_DIR: root,TMPDIR: path.join(root,"tmp"),LLV_STATE_OWNER: undefined,LLV_AGENT_REGISTRY_SQLITE: explicit ? "sqlite" : undefined,DELEGATUS_AGENT_REGISTRY_SQLITE: undefined,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9" };
  const child = Bun.spawn([process.execPath,"scripts/registry-archive-retirement.ts",...args],{ env,stdout: "pipe",stderr: "pipe" });
  const [code,out,error] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  return { code,out,error };
}
function tree(root: string): [string,string][] {
  return fs.readdirSync(root,{ recursive: true,withFileTypes: true }).filter(entry => entry.isFile() && !entry.name.endsWith("-wal") && !entry.name.endsWith("-shm")).map(entry => {
    const full = path.join(entry.parentPath,entry.name);
    return [path.relative(root,full),crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")] as [string,string];
  }).sort(([a],[b]) => a.localeCompare(b));
}

test("production command opens read-only before the schema upgrade, reports categories and refuses stale approval", async () => {
  const { root,filename } = fixture();
  const db = new Database(filename);
  db.run("DROP INDEX registry_cold_archive");
  for (const table of ["registry_archive_retirements","registry_archive_retirement_state","registry_archive_retirement_totals"]) db.run(`DROP TABLE ${table}`);
  db.run("DROP TRIGGER registry_archive_immutable_delete");
  db.run("CREATE TRIGGER registry_archive_immutable_delete BEFORE DELETE ON registry_archive BEGIN SELECT RAISE(ABORT,'no expiry'); END");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const before = tree(root);
  const dry = await run(root,["--dry-run"]);
  expect(dry.code,dry.error).toBe(0);
  expect(tree(root)).toEqual(before);
  const report = JSON.parse(dry.out);
  expect(report).toMatchObject({ category: "A",approved: false,graceMs: 3600000,batchSize: 250,cycleBatches: 4,observed: { rows: 0,bytes: 0 },retired: [] });
  expect(report.B1.rows).toBeGreaterThan(0); expect(report.B2.rows).toBeGreaterThan(0);
  expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
  const refused = await run(root,["--approve","0".repeat(64)]);
  expect(refused.code).toBe(1); expect(refused.error).toContain("report digest changed");
  expect(tree(root)).toEqual(before);
  const accepted = await run(root,["--approve",report.digest]);
  expect(accepted.code,accepted.error).toBe(0);
  expect(JSON.parse(fs.readFileSync(retirementApprovalFile(filename),"utf8"))).toMatchObject({ category: "A",digest: report.digest });
});

test("invalid arguments and missing databases fail without creating an approval", async () => {
  const { root,filename } = fixture();
  for (const args of [[],["--apply"],["--dry-run","--approve","x"],["--approve"]]) {
    const result = await run(root,args); expect(result.code).toBe(1); expect(result.error).toContain("usage:");
    expect(fs.existsSync(retirementApprovalFile(filename))).toBe(false);
  }
  const missing = path.join(root,"empty"); fs.mkdirSync(missing);
  for (const name of ["home","config","tmp"]) fs.mkdirSync(path.join(missing,name));
  const result = await run(missing,["--dry-run"]);
  expect(result.code).toBe(1); expect(fs.existsSync(path.join(missing,"agent-registry.sqlite"))).toBe(false);
});


test("a pending JSON import refuses reports and approval in explicit and default SQLite modes", async () => {
  const { root,filename } = fixture();
  fs.writeFileSync(path.join(root,"agent-registry.json"),JSON.stringify({ version: 2,entries: {},receipts: {} }));
  for (const mode of ["off","dual-write"]) {
    fs.writeFileSync(path.join(root,"agent-registry.backend.json"),JSON.stringify({ schemaVersion: 1,mode,
      sqliteFile: mode === "off" ? null : "agent-registry.sqlite",publishedAt: "2026-10-01T00:00:00Z" }));
    for (const explicit of [false,true]) {
      const before = tree(root);
      for (const args of [["--dry-run"],["--approve","0".repeat(64)]]) {
        const result = await run(root,args,explicit);
        expect(result.code).toBe(1); expect(result.error).toContain("registry import is pending");
        expect(tree(root)).toEqual(before);
        expect(fs.existsSync(retirementApprovalFile(filename))).toBe(false);
      }
    }
  }
});
