import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AsyncControlEvidenceStore, ControlEvidenceStore, EVIDENCE_LIMIT, EVIDENCE_TTL_MS, controlRequestId } from "./controlEvidence";
import type { McpRequestBinding } from "./server";

const epoch = 1_800_000_000_000;
const id = (at: number, tail = "a") => `${at}-${tail.repeat(64)}`;
function fixture(openedAt = epoch) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "control-evidence-"));
  let now = openedAt;
  const filename = path.join(root, "http.sqlite");
  const store = new ControlEvidenceStore(filename, () => now);
  return { store, filename, at: (at: number) => { now = at; }, close: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("ingress and negative lookup serialize, and a fenced late request never becomes admitted", () => {
  const f = fixture();
  try {
    f.at(epoch + 100);
    expect(f.store.observe(id(epoch + 1), true).state).toBe("fenced");
    expect(f.store.observe(id(epoch + 1))).toMatchObject({ state: "fenced" });
    expect(f.store.observe(id(epoch + 2))).toMatchObject({ state: "seen", fresh: true });
    f.store.complete(id(epoch + 2), 200, '{"operationId":"operation-one"}');
    expect(f.store.observe(id(epoch + 2), true)).toMatchObject({ state: "seen", status: 200, outcome: '{"operationId":"operation-one"}' });
    expect(f.store.observe(id(epoch + 2)).fresh).toBeUndefined();
    const pending = f.store.observe(id(epoch + 3));
    f.store.abandon(id(epoch + 3), "stale-nonce");
    expect(f.store.observe(id(epoch + 3)).state).toBe("seen");
    f.store.complete(id(epoch + 3), 200, "{}", "stale-nonce");
    expect(f.store.observe(id(epoch + 3)).status).toBeNull();
    f.store.abandon(id(epoch + 3), pending.nonce!);
    expect(f.store.observe(id(epoch + 3)).state).toBe("fenced");
    expect(fs.statSync(f.filename).mode & 0o777).toBe(0o600);
  } finally { f.close(); }
});

test("malformed, pre-coverage, future and expired ids cannot prove nonexecution", () => {
  const f = fixture();
  try {
    for (const request of ["bad", id(epoch), id(epoch - 1), id(epoch + 10_000)]) expect(f.store.observe(request, true).state).toBe("unknown");
    f.at(epoch + 2);
    expect(f.store.observe(id(epoch + 1)).state).toBe("seen");
    f.at(epoch + EVIDENCE_TTL_MS + 3);
    expect(f.store.observe(id(epoch + 1), true).state).toBe("unknown");
  } finally { f.close(); }
});

test("request timestamps equal to coverage opening stay unknown and later timestamps are admitted", () => {
  const opened = epoch + 100;
  const f = fixture(opened);
  try {
    expect(f.store.observe(id(opened), true).state).toBe("unknown");
    expect(f.store.observe(id(opened + 1))).toMatchObject({ state: "seen", fresh: true });
  } finally { f.close(); }
});

test("both possible admissions and negative fences survive a new process", () => {
  const f = fixture();
  try {
    f.at(epoch + 100);
    f.store.observe(id(epoch + 1));
    f.store.complete(id(epoch + 1), 409, '{"error":"refused"}');
    f.store.observe(id(epoch + 2), true);
    const source = `import { ControlEvidenceStore } from './src/lib/mcp/controlEvidence.ts';
      const store = new ControlEvidenceStore(process.argv[1], () => ${epoch + 100});
      console.log(JSON.stringify([store.observe(process.argv[2], true), store.observe(process.argv[3])])); store.close();`;
    const replay = JSON.parse(execFileSync(process.execPath, ["--eval", source, f.filename, id(epoch + 1), id(epoch + 2)], { encoding: "utf8" }));
    expect(replay).toEqual([{ state: "seen", status: 409, outcome: '{"error":"refused"}' }, { state: "fenced", status: null, outcome: null }]);
  } finally { f.close(); }
});

test("capacity eviction advances the proof floor, including after process restart", () => {
  const f = fixture();
  try {
    f.at(epoch + EVIDENCE_LIMIT + 100);
    for (let index = 1; index <= EVIDENCE_LIMIT + 3; index++) f.store.observe(id(epoch + index));
    expect((f.store.db.query("SELECT count(*) AS n FROM requests").get() as { n: number }).n).toBeLessThanOrEqual(EVIDENCE_LIMIT);
    expect(f.store.observe(id(epoch + 1), true).state).toBe("unknown");
    for (let index = 0; index < EVIDENCE_LIMIT + 3; index++) f.store.event(id(epoch + 1), "error", 10, 20, "ECONNRESET");
    expect((f.store.db.query("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(EVIDENCE_LIMIT);
    const source = `import { ControlEvidenceStore } from './src/lib/mcp/controlEvidence.ts';
      const store = new ControlEvidenceStore(process.argv[1], () => ${epoch + EVIDENCE_LIMIT + 100});
      console.log(JSON.stringify(store.observe(process.argv[2], true))); store.close();`;
    expect(JSON.parse(execFileSync(process.execPath, ["--eval", source, f.filename, id(epoch + 1)], { encoding: "utf8" })).state).toBe("unknown");
  } finally { f.close(); }
});

test("failed reads, partial writes and a replaced database never invent a negative result", () => {
  const f = fixture();
  const peer = new ControlEvidenceStore(f.filename, () => epoch);
  try {
    f.at(epoch + 100);
    peer.db.exec("BEGIN IMMEDIATE");
    expect(() => f.store.observe(id(epoch + 1), true)).toThrow();
    peer.db.exec("ROLLBACK");
    expect(f.store.observe(id(epoch + 1)).state).toBe("seen");
    f.store.db.exec("CREATE TRIGGER fail_ingress BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'write refused'); END");
    expect(() => f.store.observe(id(epoch + 2), true)).toThrow("write refused");
    f.store.db.exec("DROP TRIGGER fail_ingress");
    expect(f.store.observe(id(epoch + 2)).state).toBe("seen");
    f.store.db.exec("ALTER TABLE coverage RENAME TO unreadable_coverage");
    expect(() => f.store.observe(id(epoch + 3), true)).toThrow();
    f.store.db.exec("ALTER TABLE unreadable_coverage RENAME TO coverage");
    const replacement = new ControlEvidenceStore(path.join(path.dirname(f.filename), "replacement.sqlite"), () => epoch + 200);
    replacement.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); replacement.close();
    peer.close();
    // A durability swap moves the complete old SQLite family together.
    for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(f.filename + suffix)) fs.renameSync(f.filename + suffix, f.filename + ".old" + suffix);
    fs.renameSync(path.join(path.dirname(f.filename), "replacement.sqlite"), f.filename);
    expect(f.store.observe(id(epoch + 1), true).state).toBe("unknown");
  } finally { try { peer.close(); } catch {} f.close(); }
});

test("a saved binding reconstructs the dispatch id without serializing private values into the header", () => {
  const binding = { toolName: "send_message", clientRequestId: "stable-send", claimedAt: new Date(epoch).toISOString(), claimGeneration: "generation-one" } as McpRequestBinding;
  const original = controlRequestId(binding, "/api/conversation-host");
  expect(controlRequestId(JSON.parse(JSON.stringify(binding)), "/api/conversation-host")).toBe(original);
  expect(controlRequestId(Object.fromEntries(Object.entries(binding).reverse()) as unknown as McpRequestBinding, "/api/conversation-host")).toBe(original);
  expect(controlRequestId({ ...binding, claimGeneration: "generation-two" }, "/api/conversation-host")).not.toBe(original);
  expect(original).toMatch(/^\d{13}-[a-f0-9]{64}$/);
});

test("the production worker persists writer output, fails busy reads promptly and reopens the same evidence", async () => {
  const f = fixture();
  const filename = path.join(path.dirname(f.filename), "worker.sqlite");
  const peer = new ControlEvidenceStore(filename);
  let worker = new AsyncControlEvidenceStore(filename, true, 1000);
  try {
    await worker.ready();
    const opened = (peer.db.query("SELECT opened FROM coverage WHERE id=1").get() as { opened: number }).opened;
    const request = id(opened + 1);
    expect((await worker.observe(request)).state).toBe("seen");
    await worker.complete(request, 200, '{"operationId":"worker-operation"}');
    await worker.closed(request, 321, 456);
    await worker.event(request, "close", 321, 456);
    await worker.close(); worker = new AsyncControlEvidenceStore(filename, true, 1000);
    expect(await worker.observe(request, true)).toMatchObject({ state: "seen", status: 200, outcome: '{"operationId":"worker-operation"}' });
    peer.db.exec("BEGIN IMMEDIATE");
    await expect(worker.observe(id(opened + 2), true)).rejects.toThrow();
    peer.db.exec("ROLLBACK");
    await worker.close();
    await expect(worker.observe(request, true)).rejects.toThrow("unavailable");
  } finally { await worker.close(); peer.close(); f.close(); }
});

test("a bundled evidence writer runs without the source tree and retains its fence", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "control-bundle-"));
  try {
    const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "controlEvidence.ts")], outdir: root, target: "bun", format: "esm" });
    expect(built.success).toBe(true);
    const source = `const {AsyncControlEvidenceStore}=await import(process.argv[1]);
      const store=new AsyncControlEvidenceStore(process.argv[2]); await store.ready();
      const {Database}=require('bun:sqlite'); const db=new Database(process.argv[2],{readonly:true});
      const opened=db.query('SELECT opened FROM coverage WHERE id=1').get().opened; db.close();
      const id=String(opened+1)+'-'+ 'a'.repeat(64);
      console.log(JSON.stringify([await store.observe(id,true),await store.observe(id)])); await store.close();`;
    const answer = JSON.parse(execFileSync(process.execPath, ["--eval", source, built.outputs[0]!.path, path.join(root, "bundle.sqlite")], { cwd: root, encoding: "utf8", env: { ...process.env } }));
    expect(answer).toMatchObject([{ state: "fenced" }, { state: "fenced" }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
