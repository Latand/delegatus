import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runMemoryImportWork, MemoryImportError } from "./importWork";
import { readImportCandidates, readImportRecord } from "./importStore";
import { candidateState } from "./importCuration";
import { claimPass, patchPass } from "./curation/store";
import { readCuration } from "./curation/read";
import { applyCuration } from "./curation/apply";
import { admissionHeld } from "./curation/admission";
import { readSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { curatableImportId, memorySyncDue, memorySyncNextAt, memorySyncStatus, setMemorySyncInterval, syncCurationOpen, MEMORY_SYNC_MAX_FILES } from "./importSync";
import type { ImportManifest, ImportRoots } from "./importTypes";

/* The periodic sync of docs/design/memory-source-switch.md §4.9, on fixture
   homes in a private state directory. Every time is fixed. */
const AT = "2026-10-22T00:00:00.000Z", NOW = Date.parse(AT), PROJECT = "sync-fixture", ID = "sync-import";
const HOUR = 3600_000;
const at = (delta: number) => new Date(NOW + delta).toISOString();
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let root: string, memory: string, roots: ImportRoots;
const previous = { state: process.env.LLV_STATE_DIR, role: process.env.LLV_ROLE_MEMORY };
const stateFile = (name: string) => path.join(process.env.LLV_STATE_DIR!, name);
const source = (value: Record<string, unknown>) => fs.writeFile(stateFile("memory-source.json"), JSON.stringify({ schemaVersion: 1, importId: ID, importStartedAt: AT, changedAt: AT, ...value }));
const toEngines = () => source({ source: "engines", phase: "draining" });
beforeEach(async () => {
  resetProjectAliasesForTests();
  delete process.env.LLV_ROLE_MEMORY;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "import-sync-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const home = path.join(root, "claude"); memory = path.join(home, "projects", "fixture", "memory");
  roots = { claudeHomes: [home], codexHomes: [] };
  await fs.mkdir(memory, { recursive: true }); await fs.mkdir(process.env.LLV_STATE_DIR!);
  await source({ source: "delegatus", phase: "importing" });
});
afterEach(async () => {
  for (const [key, value] of Object.entries({ LLV_STATE_DIR: previous.state, LLV_ROLE_MEMORY: previous.role })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await fs.rm(root, { recursive: true, force: true }); resetProjectAliasesForTests();
});
const ports = () => ({ hostProject: PROJECT, projectForSlug: () => PROJECT, writer: async () => ({ kind: "unknown" as const, roleId: null }) });
const syncRun = (delta: number) => runMemoryImportWork({ importId: ID, previous: null, roots, at: at(delta), sync: true }, ports());
function allCandidates() {
  const rows: ReturnType<typeof readImportCandidates>["candidates"] = [];
  let cursor: string | null = "";
  do { const page = readImportCandidates(ID, cursor, 40); rows.push(...page.candidates); cursor = page.cursor; } while (cursor);
  return rows;
}
const pending = () => allCandidates().filter(c => candidateState(c).state === "pending");

/** The first import, every candidate dropped by a pass, then the switch to the engines. */
async function importedThenEngines(notes: Record<string, string> = { "topic.md": "Inspect current ownership before changing a running worker.\n" }) {
  for (const [name, body] of Object.entries(notes)) await fs.writeFile(path.join(memory, name), body);
  await fs.writeFile(path.join(memory, "MEMORY.md"), Object.keys(notes).map(name => `- [${name}](${name})`).join("\n") + "\n");
  await runMemoryImportWork({ importId: ID, previous: null, roots, at: AT }, ports());
  await dropPending(0);
  await toEngines();
}
async function dropPending(delta: number) {
  const rows = pending();
  const pass = claimPass({ project: PROJECT, repoDir: null, now: NOW + delta, importOnly: true })!;
  expect(pass?.importBatch?.candidates.length).toBe(rows.length);
  await readCuration(pass, "imports");
  const revision = (await readCuration(pass)).scopes.find(scope => scope.scope === "machine")?.revision ?? 0;
  applyCuration(pass, { scopes: [{ scope: "machine", revision, order: [] }],
    drop: rows.map(c => ({ candidate: c.id, occurrences: c.occurrences.map(o => o.id), reason: "task-specific" as const, note: "This note narrates a finished task." })) }, at(delta));
  patchPass(pass.id, { state: "succeeded", endedAt: at(delta + 1) });
}
async function hashes() {
  const entries = await fs.readdir(memory);
  return Object.fromEntries(await Promise.all(entries.sort().map(async name => [name, sha(await fs.readFile(path.join(memory, name)))])));
}

test("a note written after the import becomes a backed-up pending candidate of the same import when the sync is due", async () => {
  await importedThenEngines();
  expect(memorySyncDue(readImportRecord(ID), NOW)).toBe(true);
  const late = "Check the account's remaining limit before starting a long run.\n";
  await fs.writeFile(path.join(memory, "late.md"), late);
  const before = await hashes();
  const record = await syncRun(HOUR);
  expect(record.sync).toEqual({ lastAt: at(HOUR), result: "ok", added: 1 });
  expect(await hashes()).toEqual(before);
  const candidate = pending().find(c => c.body === late)!;
  expect(candidate.importId).toBe(ID);
  const manifest = JSON.parse(await fs.readFile(path.join(record.backup, "manifest.json"), "utf8")) as ImportManifest;
  const file = manifest.files.findLast(f => f.sha256 === candidate.occurrences[0].sha256)!;
  expect(sha(await fs.readFile(path.join(record.backup, file.copy)))).toBe(file.sha256);
  // Not again before the interval, then due once it passed.
  expect(memorySyncDue(readImportRecord(ID), NOW + HOUR + 23 * HOUR)).toBe(false);
  expect(memorySyncDue(readImportRecord(ID), NOW + HOUR + 24 * HOUR)).toBe(true);
  expect(memorySyncStatus(readImportRecord(ID), NOW + 2 * HOUR)).toEqual({ intervalHours: 24, lastAt: at(HOUR), nextAt: at(25 * HOUR), added: 1, capped: false, failure: null });
});

test("content an earlier pass dispositioned inherits that disposition and is never offered", async () => {
  await importedThenEngines();
  // Same body under new frontmatter, and the same body in a second file of the same store.
  await fs.writeFile(path.join(memory, "topic.md"), "---\nname: Ownership\ntype: feedback\n---\nInspect current ownership before changing a running worker.\n");
  await fs.writeFile(path.join(memory, "copy.md"), "Inspect   current ownership before changing a running worker.\n");
  const record = await syncRun(HOUR);
  expect(record.sync).toMatchObject({ result: "ok", added: 1 });
  // The typed copy has other applicability (type feedback) and is offered; the untyped copy inherits.
  const offered = pending();
  expect(offered).toHaveLength(1);
  expect(offered[0].occurrences.map(o => o.type)).toEqual(["feedback"]);
  const untyped = allCandidates().filter(c => c.occurrences.some(o => o.file.endsWith("copy.md")));
  expect(untyped.map(c => candidateState(c).state)).toEqual(["dropped"]);
  // A file changed back to dispositioned content is not offered either.
  await dropPending(2 * HOUR);
  await fs.writeFile(path.join(memory, "topic.md"), "Inspect current ownership before changing a running worker.\n");
  expect((await syncRun(26 * HOUR)).sync).toMatchObject({ result: "ok", added: 0 });
  expect(pending()).toEqual([]);
});

test("a run over the cap leaves the rest for the next run, which is due at once", async () => {
  await importedThenEngines();
  const count = MEMORY_SYNC_MAX_FILES + 5;
  for (let i = 0; i < count; i += 1) await fs.writeFile(path.join(memory, `note-${String(i).padStart(3, "0")}.md`), `Distinct practice number ${i} about checking evidence before reporting.\n`);
  const first = await syncRun(HOUR);
  expect(first.sync).toMatchObject({ result: "capped", added: MEMORY_SYNC_MAX_FILES });
  expect(memorySyncDue(readImportRecord(ID), NOW + HOUR)).toBe(true);
  expect(memorySyncNextAt(readImportRecord(ID))).toBe(NOW + HOUR);
  const second = await syncRun(2 * HOUR);
  expect(second.sync).toMatchObject({ result: "ok", added: 5 });
  expect(new Set(pending().map(c => c.group)).size).toBe(count);
});

test("files touched without a change are hashed once, so they never hold the cap", async () => {
  await importedThenEngines();
  const later = new Date(NOW + 5 * HOUR);
  await fs.utimes(path.join(memory, "topic.md"), later, later);
  const before = await hashes();
  expect((await syncRun(HOUR)).sync).toMatchObject({ result: "ok", added: 0 });
  const manifest = JSON.parse(await fs.readFile(path.join(readImportRecord(ID)!.backup, "manifest.json"), "utf8")) as ImportManifest;
  expect(manifest.files.findLast(f => f.file.endsWith("topic.md"))!.modifiedAt).toBe(later.toISOString());
  expect(await hashes()).toEqual(before);
  expect(pending()).toEqual([]);
});

test("the sync is not due in Delegatus mode, before a ready import, with the setting off or the emergency switch", async () => {
  await importedThenEngines();
  expect(memorySyncDue(readImportRecord(ID), NOW)).toBe(true);
  setMemorySyncInterval(0);
  expect(memorySyncDue(readImportRecord(ID), NOW)).toBe(false);
  expect(memorySyncStatus(readImportRecord(ID), NOW)).toMatchObject({ intervalHours: 0, nextAt: null });
  await expect(syncRun(HOUR)).rejects.toMatchObject({ reason: "source_changed" });
  setMemorySyncInterval(6);
  expect(memorySyncNextAt({ sync: { lastAt: AT, result: "ok", added: 0 } })).toBe(NOW + 6 * HOUR);
  expect(memorySyncNextAt({ sync: { lastAt: AT, result: "failed", added: 0, reason: "integrity" } })).toBe(NOW + HOUR);
  process.env.LLV_ROLE_MEMORY = "off";
  expect(memorySyncDue(readImportRecord(ID), NOW)).toBe(false);
  delete process.env.LLV_ROLE_MEMORY;
  await source({ source: "delegatus", phase: "active" });
  expect(memorySyncDue(readImportRecord(ID), NOW)).toBe(false);
  await expect(syncRun(HOUR)).rejects.toBeInstanceOf(MemoryImportError);
  await source({ source: "engines", importId: "another-import" });
  expect(memorySyncDue(readImportRecord(ID), NOW)).toBe(false);
  expect(memorySyncDue(null, NOW)).toBe(false);
  await fs.rm(stateFile("memory-source.json"));
  expect(memorySyncDue(readImportRecord(ID), NOW)).toBe(false);
  expect(() => setMemorySyncInterval(169)).toThrow();
});

test("the schedule survives a restart: a fresh process reads the same due time from the durable record", async () => {
  await importedThenEngines();
  await syncRun(HOUR);
  const probe = async (now: number) => {
    const code = `const { memorySyncDue } = await import(${JSON.stringify(path.join(import.meta.dir, "importSync.ts"))}); const { readImportRecord } = await import(${JSON.stringify(path.join(import.meta.dir, "importStore.ts"))}); console.log(JSON.stringify(memorySyncDue(readImportRecord(${JSON.stringify(ID)}), ${now})));`;
    const child = Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, errors).toBe(0);
    return JSON.parse(output.trim().split("\n").at(-1)!);
  };
  expect(await probe(NOW + 2 * HOUR)).toBe(false);
  expect(await probe(NOW + 25 * HOUR)).toBe(true);
});

test("a failed sync keeps the import ready, records its reason and retries after an hour", async () => {
  await importedThenEngines();
  await fs.rm(path.join(readImportRecord(ID)!.backup, "manifest.json"));
  await fs.writeFile(path.join(memory, "late.md"), "A note the broken backup cannot take.\n");
  await expect(syncRun(HOUR)).rejects.toThrow();
  const record = readImportRecord(ID)!;
  expect(record.state).toBe("ready");
  expect(record.sync).toMatchObject({ lastAt: at(HOUR), result: "failed", added: 0 });
  expect(memorySyncDue(record, NOW + HOUR + 59 * 60_000)).toBe(false);
  expect(memorySyncDue(record, NOW + 2 * HOUR)).toBe(true);
  expect(memorySyncStatus(record, NOW + HOUR)?.failure).toBe(record.sync!.reason!);
});

test("in the engines position the curator takes import passes of the synced import only", async () => {
  await importedThenEngines();
  expect(curatableImportId()).toBe(ID);
  const sources = { settings: (project: string) => readSeatTickSettings(project), now: () => NOW, latestDeployment: () => ({ state: "ok", value: null }) } as never;
  // No pending candidate: no pass at all, and an ordinary pass is never admitted.
  expect(claimPass({ project: PROJECT, repoDir: null, now: NOW + HOUR, importOnly: true })).toBeNull();
  expect(admissionHeld(PROJECT, { sources })).toBe("curation: paused, memory off");
  await fs.writeFile(path.join(memory, "late.md"), "Check the account's remaining limit before starting a long run.\n");
  await syncRun(HOUR);
  const pass = claimPass({ project: PROJECT, repoDir: null, now: NOW + 2 * HOUR, importOnly: true })!;
  expect(pass.importBatch).toMatchObject({ importId: ID, candidates: [pending()[0].id] });
  expect(syncCurationOpen(ID)).toBe(true);
  expect(admissionHeld(PROJECT, { sources }, pass)).not.toBe("curation: paused, memory off");
  expect((await readCuration(pass, "imports")).candidates).toHaveLength(1);
  // The sync turned off closes the open pass's reads.
  setMemorySyncInterval(0);
  expect(syncCurationOpen(ID)).toBe(false);
  expect(admissionHeld(PROJECT, { sources }, pass)).toBe("curation: paused, memory off");
  await expect(readCuration(pass, "imports")).rejects.toMatchObject({ code: "CURATE_IMPORT" });
  setMemorySyncInterval(24);
  process.env.LLV_ROLE_MEMORY = "off";
  expect(curatableImportId()).toBeNull();
});

test("an adoption in the engines position is stored as a rule and the candidate reads adopted", async () => {
  await importedThenEngines();
  const late = "Check the account's remaining limit before starting a long run.\n";
  await fs.writeFile(path.join(memory, "late.md"), late);
  await syncRun(HOUR);
  const candidate = pending()[0]!;
  const pass = claimPass({ project: PROJECT, repoDir: null, now: NOW + 2 * HOUR, importOnly: true })!;
  await readCuration(pass, "imports");
  const { roleMemoryCollection } = await import("./roleStore");
  const held = roleMemoryCollection()?.get(`s:${candidate.suggestedScope}`);
  const output = applyCuration(pass, { scopes: [{ scope: candidate.suggestedScope, revision: held?.kind === "scope" ? held.revision : 0, order: [`adopt:${candidate.id}:0`] }],
    adopt: [{ candidate: candidate.id, occurrences: candidate.occurrences.map(o => o.id), parts: [{ to: candidate.suggestedScope, rule: "Check the account's remaining limit before a long run.", why: "A long run can exhaust a shared limit." }], note: "A general practice for every long run." }] }, at(2 * HOUR));
  const ruleId = output.placeholders[`adopt:${candidate.id}:0`];
  expect(roleMemoryCollection()!.get(`r:${ruleId}`)?.kind).toBe("rule");
  expect(candidateState(allCandidates().find(c => c.id === candidate.id)!).state).toBe("adopted");
});

test("a run the helper deadline ends records its start, so the next refresh waits an hour instead of retrying at once", async () => {
  await importedThenEngines();
  await fs.writeFile(path.join(memory, "late.md"), "A note the stopped run never reaches.\n");
  let during: ReturnType<typeof readImportRecord> = null;
  // The phase seam stands for the point where the helper is killed: the run never returns.
  await expect(runMemoryImportWork({ importId: ID, previous: null, roots, at: at(HOUR), sync: true }, { ...ports(), phase: () => { during = readImportRecord(ID); throw Error("helper deadline"); } })).rejects.toThrow();
  expect(during!.sync).toEqual({ lastAt: at(HOUR), result: "running", added: 0 });
  // What a killed helper leaves behind is the running marker alone.
  const { importCollection } = await import("./importStore");
  importCollection(true)!.boundedPatch(2, tx => tx.put(during!));
  expect(memorySyncDue(readImportRecord(ID), NOW + HOUR + 59 * 60_000)).toBe(false);
  expect(memorySyncDue(readImportRecord(ID), NOW + 2 * HOUR)).toBe(true);
  expect(memorySyncStatus(readImportRecord(ID), NOW + HOUR + 60_000)?.failure).toBeNull();
  expect(memorySyncStatus(readImportRecord(ID), NOW + HOUR + 20 * 60_000)?.failure).toBe("interrupted");
});

test("a sync refused before its lock still records the failure and waits an hour", async () => {
  await importedThenEngines();
  const { execFileSync } = await import("node:child_process");
  execFileSync("mkfifo", [path.join(memory, "pipe.md")]);
  await expect(syncRun(HOUR)).rejects.toMatchObject({ reason: "backup_refused" });
  const record = readImportRecord(ID)!;
  expect(record.state).toBe("ready");
  expect(record.sync).toEqual({ lastAt: at(HOUR), result: "failed", added: 0, reason: "backup_refused" });
  expect(memorySyncDue(record, NOW + HOUR + 30 * 60_000)).toBe(false);
  expect((await fs.readFile(stateFile("memory-source.json"), "utf8"))).toContain('"engines"');
});
