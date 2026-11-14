import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { deleteRule, leaveLessons, leaveSeatLessons, recordLessonRequest, restoreRule, revertRule, roleMemoryCollection, storedLessonRevision, withoutStoredLessons } from "./roleStore";
import { withCurrentRoleMemory, withoutStoredLessonsAsync } from "./privacy";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { importStateCollection, initializeStateCollections, reimportStateCollection } from "@/lib/state/sqliteStateStore";
import { memoryProblemSignals } from "./roleProblems";
import { seatTickSignalVersion } from "@/lib/monitor/seatTick";
import { claimPass } from "./curation/store";
import { readCuration } from "./curation/read";
import { applyCuration } from "./curation/apply";
import { projectViewRowsCooperatively } from "./roleViewSource";
import { importCandidate, seedImport, IMPORT_PROJECT, IMPORT_AT } from "./fixtures/import";

const root = process.env.LLV_STATE_DIR!;
const text = "Inspect the current ownership before changing a shared worker.";
const why = "Earlier operations changed a worker after its owner had moved.";
const source = { origin: "seat" as const, project: IMPORT_PROJECT, roleId: "orchestrator" as const, fixRound: false as const, conversationId: "conversation_fixture" };
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "privacy-revision-"));
  process.env.LLV_STATE_DIR = directory;
  importStateCollection(path.join(directory, "state.sqlite"), { collection: "role_memory", schemaVersion: 1, migrationId: "role-memory-v1", rows: [],
    sourceName: "fixture", sourceSha256: null, sourceBytes: 0, gap: null, release: null });
});
afterEach(async () => { await shutdownTaskPageWorker(); process.env.LLV_STATE_DIR = root; fs.rmSync(directory, { recursive: true, force: true }); });
const add = () => leaveSeatLessons({ source, lessons: [{ scope: "machine", rule: text, why }], now: IMPORT_AT }).left[0]!.id;

test("production lesson lifecycle changes revision without rewrite/revert ABA", async () => {
  const versions = [storedLessonRevision()];
  const id = add(); versions.push(storedLessonRevision());
  const rewritten = leaveSeatLessons({ source, lessons: [], rewrite: { id, rule: text + " Read its revision.", why }, now: IMPORT_AT });
  versions.push(storedLessonRevision());
  revertRule(rewritten.left[0]!.version!, IMPORT_AT); versions.push(storedLessonRevision());
  deleteRule(id, IMPORT_AT); versions.push(storedLessonRevision());
  restoreRule(id, IMPORT_AT); versions.push(storedLessonRevision());
  expect(new Set(versions).size).toBe(versions.length);
  expect(withoutStoredLessons(text)).toBe("[learned rule].");
  const worker = new TaskPageWorker();
  try {
    expect(await worker.privacy({ kind: "filter", value: text })).toEqual({ privacyRevision: storedLessonRevision(), value: "[learned rule]." });
  } finally { await worker.shutdown(); }
  const child = Bun.spawn([process.execPath, "-e", 'import { storedLessonRevision } from "./src/lib/memory/roleStore"; process.stdout.write(storedLessonRevision());'], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, output, errors }).toEqual({ code: 0, output: storedLessonRevision(), errors: "" });
});

test("requests, empty answers, problem delivery and scope bookkeeping preserve revision beyond the change floor", () => {
  add();
  const before = storedLessonRevision();
  const stageSource = { project: IMPORT_PROJECT, pipelineId: "request-fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" };
  recordLessonRequest({ ...stageSource, at: IMPORT_AT });
  expect(storedLessonRevision()).toBe(before);
  leaveLessons({ source: stageSource, request: stageSource, lessons: [], none: "No recurring practice was discovered.", now: IMPORT_AT });
  expect(storedLessonRevision()).toBe(before);
  const problemSource = { ...stageSource, attempt: 2 };
  recordLessonRequest({ ...problemSource, at: IMPORT_AT });
  leaveLessons({ source: problemSource, request: problemSource, lessons: [], none: null,
    problem: { statement: "The fixture exporter omits units.", evidence: "Its header contains only column names." }, now: IMPORT_AT });
  expect(storedLessonRevision()).toBe(before);
  const signals = memoryProblemSignals(IMPORT_PROJECT, []);
  memoryProblemSignals(IMPORT_PROJECT, signals.map(signal => seatTickSignalVersion(signal, null)));
  expect(storedLessonRevision()).toBe(before);
  const collection = roleMemoryCollection()!;
  const scope = collection.get("s:machine")!;
  if (scope.kind !== "scope") throw Error("scope missing");
  collection.boundedPatch(1, tx => tx.put({ ...scope, revision: scope.revision + 1 }));
  expect(storedLessonRevision()).toBe(before);
  for (let attempt = 3; attempt < 1035; attempt++) recordLessonRequest({ ...stageSource, attempt, at: IMPORT_AT });
  expect(storedLessonRevision()).toBe(before);
  deleteRule(scope.active[0]!, IMPORT_AT);
  expect(storedLessonRevision()).not.toBe(before);
});

test("curation, import adoption, rule scope and reason writes, deletion and reimport invalidate privacy", async () => {
  const id = add();
  const versions = [storedLessonRevision()];
  const candidate = importCandidate(1);
  await seedImport([candidate]);
  const pass = claimPass({ project: IMPORT_PROJECT, repoDir: null, now: Date.parse(IMPORT_AT) })!;
  await readCuration(pass); await readCuration(pass, "imports");
  const collection = roleMemoryCollection()!;
  const scope = collection.get("s:machine")!;
  if (scope.kind !== "scope") throw Error("scope missing");
  applyCuration(pass, { scopes: [
    { scope: "machine", revision: scope.revision, order: [id] },
    { scope: candidate.suggestedScope!, revision: 0, order: [`adopt:${candidate.id}:0`] },
  ], rewrite: [{ id, rule: text + " Check its revision.", note: "The revision proves which state was read." }], adopt: [{
    candidate: candidate.id, occurrences: candidate.occurrences.map(row => row.id),
    parts: [{ to: candidate.suggestedScope!, rule: "Validate the current owner before updating retained worker state.", why }], note: "Keep this recurring ownership practice.",
  }] }, IMPORT_AT);
  versions.push(storedLessonRevision());
  const rule = collection.get(`r:${id}`)!;
  if (rule.kind !== "rule") throw Error("rule missing");
  collection.boundedPatch(1, tx => tx.put({ ...rule, why: why + " Recheck it." })); versions.push(storedLessonRevision());
  collection.boundedPatch(2, tx => {
    const current = tx.get(`r:${id}`);
    if (current?.kind !== "rule") throw Error("rule missing");
    tx.put({ ...current, scope: `project:${IMPORT_PROJECT}` });
  }); versions.push(storedLessonRevision());
  const rows = collection.snapshot().map(value => ({ key: value.kind === "rule" ? `r:${value.id}` : value.kind === "scope" ? `s:${value.scope}` : `q:${value.pipelineId}:${value.stageId}:${value.attempt}`, value, controllerActive: false }));
  reimportStateCollection(collection.filename, { collection: "role_memory", schemaVersion: 1, migrationId: "role-memory-v1", rows,
    sourceName: "fixture", sourceSha256: null, sourceBytes: 0, gap: null, release: null });
  versions.push(storedLessonRevision());
  collection.boundedPatch(1, tx => tx.delete(`r:${id}`)); versions.push(storedLessonRevision());
  initializeStateCollections(collection.filename, [{ collection: "role_memory", schemaVersion: 1, migrationId: "fixture-role-memory-reimport",
    key: (value: (typeof rows)[number]["value"]) => value.kind === "rule" ? `r:${value.id}` : value.kind === "scope" ? `s:${value.scope}` : `q:${value.pipelineId}:${value.stageId}:${value.attempt}`,
    loadRecords: () => rows.map(row => row.value) }], { reimportExisting: true });
  versions.push(storedLessonRevision());
  expect(new Set(versions).size).toBe(versions.length);
});

test("privacy revision sees a write while a cooperative history cursor holds its old snapshot", async () => {
  const id = add();
  const collection = roleMemoryCollection()!;
  const scope = collection.get("s:machine")!;
  if (scope.kind !== "scope") throw Error("scope missing");
  collection.boundedPatch(1, tx => tx.put({ ...scope, revision: 600, history: Array.from({ length: 600 }, (_, index) => ({
    revision: index + 1, at: IMPORT_AT, by: "agent" as const, added: [], merged: [], archived: [],
  })) }));
  const before = storedLessonRevision();
  const reading = projectViewRowsCooperatively(IMPORT_PROJECT);
  try {
    deleteRule(id, IMPORT_AT);
    expect(storedLessonRevision()).not.toBe(before);
  } finally { await reading; }
});

const fixtureRule = (id: string, rule: string) => ({ kind: "rule" as const, id, scope: "machine", rule, why: "", hints: [], state: "active" as const, source, createdAt: IMPORT_AT, changedAt: IMPORT_AT });
async function coldRevision() {
  const child = Bun.spawn([process.execPath, "-e", 'import { storedLessonRevision } from "./src/lib/memory/roleStore"; process.stdout.write(storedLessonRevision());'], {
    env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, errors }).toEqual({ code: 0, errors: "" });
  return output;
}

test("a temporary rule insertion and physical deletion cannot restore an earlier approval revision", async () => {
  const held = roleMemoryCollection(true)!;
  held.boundedPatch(1, tx => tx.put(fixtureRule("r_initial", text)));
  const before = storedLessonRevision();
  held.boundedPatch(1, tx => tx.put(fixtureRule("r_temporary", "Check the retained revision before approving the next dispatch")));
  const during = storedLessonRevision();
  expect(during).not.toBe(before);
  expect(await coldRevision()).toBe(during);
  held.boundedPatch(1, tx => tx.delete("r:r_temporary"));
  expect(storedLessonRevision()).not.toBe(before);
  expect(storedLessonRevision()).not.toBe(during);
  expect(await coldRevision()).toBe(storedLessonRevision());
});

test("the real worker result must be rebuilt after an insertion/deletion cycle", async () => {
  const held = roleMemoryCollection(true)!;
  held.boundedPatch(1, tx => tx.put(fixtureRule("r_initial", text)));
  const transient = "Check the retained revision before approving the next dispatch";
  let requests = 0;
  const real = TaskPageWorker.prototype.privacy;
  const worker = spyOn(TaskPageWorker.prototype, "privacy").mockImplementation(async function(this: TaskPageWorker, request) {
    const first = ++requests === 1;
    if (first) held.boundedPatch(1, tx => tx.put(fixtureRule("r_temporary", transient)));
    try { return await real.call(this, request); }
    finally { if (first) held.boundedPatch(1, tx => tx.delete("r:r_temporary")); }
  });
  try {
    const output = await withCurrentRoleMemory(() => withoutStoredLessonsAsync(transient));
    expect(output).toBe(transient);
    expect(requests).toBeGreaterThan(1);
  } finally { worker.mockRestore(); }
});

test("the privacy clock survives a peer insertion/deletion cycle, journal pruning and process restarts", async () => {
  add();
  const before = storedLessonRevision();
  const child = Bun.spawn([process.execPath, "-e", `
    import { roleMemoryCollection, recordLessonRequest } from "./src/lib/memory/roleStore";
    const collection = roleMemoryCollection();
    const rule = collection.snapshot().find(row => row.kind === "rule");
    collection.boundedPatch(2, tx => { tx.put({ ...rule, id: "r_temporary" }); tx.delete("r:r_temporary"); });
    for (let attempt = 0; attempt < 1035; attempt++) recordLessonRequest({
      project: "fixture", pipelineId: "pruning-fixture", stageId: "build", attempt, roleId: "builder",
      conversationId: "conversation_fixture", at: "2026-11-06T00:00:00Z",
    });
  `], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, output, errors }).toEqual({ code: 0, output: "", errors: "" });
  const db = new Database(roleMemoryCollection()!.filename, { readonly: true });
  try {
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM state_changes WHERE collection='role_memory' AND row_key='r:r_temporary'").get()!.count).toBe(0);
  } finally { db.close(); }
  const after = storedLessonRevision();
  expect(after).not.toBe(before);
  expect(await coldRevision()).toBe(after);
  recordLessonRequest({ project: "fixture", pipelineId: "after-restart", stageId: "build", attempt: 1,
    roleId: "builder", conversationId: "conversation_fixture", at: IMPORT_AT });
  expect(storedLessonRevision()).toBe(after);
  expect(await coldRevision()).toBe(after);
});

test("rolled back rule writes leave the committed privacy revision unchanged", async () => {
  const id = add();
  const collection = roleMemoryCollection()!;
  const before = storedLessonRevision();
  expect(() => collection.boundedPatch(2, tx => {
    tx.delete(`r:${id}`);
    tx.put(fixtureRule("r_rollback", text + " Read its revision."));
    throw Error("fixture transaction refused");
  })).toThrow("fixture transaction refused");
  expect(storedLessonRevision()).toBe(before);
  expect(await coldRevision()).toBe(before);
  expect(collection.get(`r:${id}`)).not.toBeNull();
  expect(collection.get("r:r_rollback")).toBeNull();
});

test("privacy clock values remain exact beyond JavaScript integers and overflow refuses the whole write", async () => {
  const id = add();
  const collection = roleMemoryCollection()!;
  const original = collection.get(`r:${id}`)!;
  if (original.kind !== "rule") throw Error("rule missing");
  const db = new Database(collection.filename);
  try {
    db.exec("UPDATE role_memory_privacy_revision SET revision=9007199254740992");
    const before = storedLessonRevision();
    collection.boundedPatch(1, tx => tx.put({ ...original, why: why + " Read its revision." }));
    const first = storedLessonRevision();
    collection.boundedPatch(1, tx => tx.put(original));
    const second = storedLessonRevision();
    expect(new Set([before, first, second]).size).toBe(3);
    expect(await coldRevision()).toBe(second);
    db.exec("UPDATE role_memory_privacy_revision SET revision=9223372036854775807");
    const maximum = storedLessonRevision();
    expect(() => collection.boundedPatch(1, tx => tx.put({ ...original, why: "Refuse an overflowing revision." }))).toThrow();
    expect(storedLessonRevision()).toBe(maximum);
    expect(collection.get(`r:${id}`)).toEqual(original);
    expect(await coldRevision()).toBe(maximum);
  } finally { db.close(); }
});

test("startup installs the privacy clock for retained rules and repairs a missing trigger", async () => {
  const id = add();
  const collection = roleMemoryCollection()!;
  const db = new Database(collection.filename);
  try {
    for (const kind of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER role_memory_privacy_${kind}`);
    db.exec("DROP TABLE role_memory_privacy_revision");
    expect(() => storedLessonRevision()).toThrow("role memory could not be read");
    await coldRevision();
    expect(withoutStoredLessons(text)).toBe("[learned rule].");
    const before = storedLessonRevision();
    collection.boundedPatch(1, tx => tx.delete(`r:${id}`));
    expect(storedLessonRevision()).not.toBe(before);
    db.exec("DROP TRIGGER role_memory_privacy_insert");
    await coldRevision();
    const empty = storedLessonRevision();
    collection.boundedPatch(1, tx => tx.put(fixtureRule("r_after_upgrade", text)));
    expect(storedLessonRevision()).not.toBe(empty);
    expect(await coldRevision()).toBe(storedLessonRevision());
  } finally { db.close(); }
});
