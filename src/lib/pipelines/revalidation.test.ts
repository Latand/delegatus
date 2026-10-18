import { expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worktreeRecoveryCollection } from "@/lib/projects/worktreeRecoveryStore";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { PIPELINES_SCHEMA_VERSION, buildPipeline, findPipelineRecord, savePipelines } from "./store";
import { pipelineRecordRevalidator } from "./revalidation";

function fixture(run: (filename: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-revalidation-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    const row = buildPipeline({ id: "watched", task: "fixture", project: "fixture", repoDir: "/repo",
      stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
        effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: null } }],
      srcPath: null, srcConversationId: null, now: "2026-10-01T00:00:00.000Z" });
    savePipelines([row]);
    run(path.join(root, "state.sqlite"));
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Observe the production decode seam, including JSON parsing and rejected rows.
const decodePrototype = SqliteStateCollection.prototype as unknown as { decodeRow(json: string): unknown };

test("unchanged ticks decode nothing; unrelated writes skip the predicate and external authority is checked every time", () => fixture(() => {
  let checks = 0, external = 0;
  const decode = spyOn(decodePrototype, "decodeRow");
  try {
    const validate = pipelineRecordRevalidator("watched", row => { checks++; expect(row?.id).toBe("watched"); }, () => { external++; });
    validate();
    expect(checks).toBe(1); expect(decode.mock.calls.length).toBe(1);
    decode.mockClear();
    for (let tick = 0; tick < 100; tick++) validate();
    const watched = findPipelineRecord("watched")!;
    const peer = buildPipeline({ ...watched, id: "unrelated", state: "draft", now: "2026-10-01T00:00:00.000Z", srcPath: null, srcConversationId: null });
    savePipelines([watched, peer]);
    decode.mockClear(); validate();
    expect(decode.mock.calls.length).toBe(0); expect(checks).toBe(1); expect(external).toBe(102);
    // Each operation owns its version; a newly started watcher must validate.
    pipelineRecordRevalidator("watched", () => { checks++; })();
    expect(checks).toBe(2); expect(decode.mock.calls.length).toBe(1);
  } finally { decode.mockRestore(); }
}));

test("peer-process changes, deletion and recreation re-run the predicate", () => fixture(filename => {
  const seen: (string | null)[] = [];
  const validate = pipelineRecordRevalidator("watched", row => { seen.push(row?.stateDetail ?? null); });
  validate();
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.LLV_STATE_DIR + "/state.sqlite");
    db.query("UPDATE state_rows SET value_json=json_set(value_json,'$.stateDetail','peer change'),row_revision=row_revision+1 WHERE collection='pipelines' AND row_key='watched'").run();
    db.close();`], { env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  validate(); validate();
  const row = findPipelineRecord("watched")!;
  savePipelines([]); validate(); validate();
  savePipelines([row]); validate();
  expect(seen).toEqual([null, "peer change", null, "peer change"]);
  const db = new Database(filename);
  db.query("UPDATE state_rows SET value_json=?,row_revision=row_revision+1 WHERE collection='pipelines' AND row_key='watched'").run("{broken");
  db.close();
  expect(validate).toThrow(); expect(validate).toThrow();
}));

test("archive moves and decoder authority changes remain visible without a row edit", () => fixture(filename => {
  const seen: (string | null)[] = [];
  const validate = pipelineRecordRevalidator("watched", row => { seen.push(row?.project ?? null); });
  validate();
  const db = new Database(filename);
  db.query("UPDATE state_rows SET collection='pipelines_archive' WHERE collection='pipelines' AND row_key='watched'").run();
  db.close(); validate(); validate();
  fs.writeFileSync(path.join(path.dirname(filename), "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: { fixture: "renamed" }, displayNames: {} }));
  validate();
  expect(seen).toEqual(["fixture", "fixture", "renamed"]);
}));

test("a failed predicate is retried and external refusal remains observable on an unchanged row", () => fixture(() => {
  let allowed = false, checks = 0;
  const validate = pipelineRecordRevalidator("watched", () => { checks++; if (!allowed) throw new Error("unavailable"); }, () => { if (!allowed) throw new Error("revoked"); });
  expect(validate).toThrow("unavailable"); allowed = true; validate();
  expect(checks).toBe(2); allowed = false;
  expect(validate).toThrow("revoked"); expect(checks).toBe(2);
}));

test("same-revision database replacement invalidates an existing watcher", () => fixture(filename => {
  const seen: (string | null)[] = [];
  const validate = pipelineRecordRevalidator("watched", row => { seen.push(row?.stateDetail ?? null); });
  validate();
  const replacement = filename + ".replacement";
  const db = new Database(filename);
  db.query("VACUUM INTO ?").run(replacement); db.close();
  const next = new Database(replacement);
  next.query("UPDATE state_rows SET value_json=json_set(value_json,'$.stateDetail','replacement') WHERE collection='pipelines' AND row_key='watched'").run();
  next.exec("PRAGMA wal_checkpoint(TRUNCATE)"); next.close();
  fs.renameSync(filename, filename + ".old");
  for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, filename + ".old" + suffix);
  fs.renameSync(replacement, filename);
  validate(); validate();
  expect(seen).toEqual([null, "replacement"]);
}));

test("row tokens use indexed key reads and never call the collection decode hook", () => fixture(filename => {
  let decodes = 0;
  const store = new SqliteStateCollection(filename, { collection: "pipelines", schemaVersion: PIPELINES_SCHEMA_VERSION, busyMessage: "busy",
    key: (row: { id: string }) => row.id, clone: row => ({ ...row }),
    decode: raw => { decodes++; return raw as { id: string }; } });
  const version = store.pipelineRecordVersionReader("watched");
  const before = version();
  for (let tick = 0; tick < 100; tick++) expect(version()).toBe(before);
  expect(decodes).toBe(0); store.get("watched"); expect(decodes).toBe(1);
  const db = new Database(filename);
  for (const key of ["watched", "missing"]) {
    const plan = db.query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN
      SELECT (SELECT row_revision FROM state_rows WHERE collection = 'pipelines' AND row_key = ?) AS hot,
             (SELECT row_revision FROM state_rows WHERE collection = 'pipelines_archive' AND row_key = ?) AS archive,
             (SELECT revision FROM state_collections WHERE collection = 'worktree_recovery') AS recovery`).all(key, key);
    expect(plan.filter(row => row.detail.includes("SEARCH") && row.detail.includes("row_key=?"))).toHaveLength(2);
    expect(plan.some(row => row.detail.includes("SEARCH state_collections") && row.detail.includes("collection=?"))).toBe(true);
  }
  db.close();
}));

test("an active database swap refuses an unchanged tick and recovery resumes validation", () => fixture(filename => {
  let checks = 0;
  const validate = pipelineRecordRevalidator("watched", () => { checks++; });
  validate();
  const marker = filename + ".swapping";
  fs.writeFileSync(marker, "");
  expect(validate).toThrow("being restored");
  fs.unlinkSync(marker);
  validate(); expect(checks).toBe(1);
}));

test("atomic recovery aliases invalidate the decoder without a pipeline row edit", () => fixture(() => {
  const seen: (string | null)[] = [];
  const validate = pipelineRecordRevalidator("watched", row => { seen.push(row?.project ?? null); });
  validate();
  worktreeRecoveryCollection().boundedPatch(1, tx => tx.put({
    source: "fixture", target: "recovered", displayName: "Recovered", cwd: "/fixture/worktree", repo: "/fixture", worktree: "worktree",
    event: { id: "recovery", seq: 1, at: "2026-10-01T00:00:00.000Z", type: "project_moved", state: "completed", project: "recovered",
      pipelineId: null, stageId: null, attempt: null, conversationId: null, role: null, summary: "Fixture recovery" },
  }));
  validate(); validate();
  expect(seen).toEqual(["fixture", "recovered"]);
}));

test("fresh processes establish their own first validation", () => fixture(() => {
  const source = `import { pipelineRecordRevalidator } from ${JSON.stringify(path.join(import.meta.dir, "revalidation.ts"))};
    let calls=0;const validate=pipelineRecordRevalidator("watched",()=>{calls++;});
    for(let tick=0;tick<10;tick++)validate();console.log(calls);`;
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawnSync([process.execPath, "-e", source], { env: process.env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0); expect(child.stdout.toString().trim()).toBe("1");
  }
}));
