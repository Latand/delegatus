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
import { AgentRegistry } from "@/lib/agent/registry";
import { defaultSeatTickSources } from "@/lib/monitor/seatTickSources";
import { writeSeatTickState } from "@/lib/monitor/seatTickState";
import { emptySeatTickState } from "@/lib/monitor/types";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { input as tickInput } from "@/lib/boardMaintenance/testFixture";
import { stopWorktreeSweepWorker } from "@/lib/pipelines/worktreeSweepWorker";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { productionCurationController } from "./curation/run";
import { machinePass, readPass } from "./curation/store";
import { newRuleId, roleMemoryCollection, roleScope } from "./roleStore";

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
const ports = (project = PROJECT) => ({ hostProject: project, projectForSlug: () => project, writer: async () => ({ kind: "unknown" as const, roleId: null }) });
const syncRun = (delta: number, project = PROJECT) => runMemoryImportWork({ importId: ID, previous: null, roots, at: at(delta), sync: true }, ports(project));
function allCandidates() {
  const rows: ReturnType<typeof readImportCandidates>["candidates"] = [];
  let cursor: string | null = "";
  do { const page = readImportCandidates(ID, cursor, 40); rows.push(...page.candidates); cursor = page.cursor; } while (cursor);
  return rows;
}
const pending = () => allCandidates().filter(c => candidateState(c).state === "pending");

/** The first import, every candidate dropped by a pass, then the switch to the engines. */
async function importedThenEngines(notes: Record<string, string> = { "topic.md": "Inspect current ownership before changing a running worker.\n" }, project = PROJECT) {
  for (const [name, body] of Object.entries(notes)) await fs.writeFile(path.join(memory, name), body);
  await fs.writeFile(path.join(memory, "MEMORY.md"), Object.keys(notes).map(name => `- [${name}](${name})`).join("\n") + "\n");
  await runMemoryImportWork({ importId: ID, previous: null, roots, at: AT }, ports(project));
  await dropPending(0, project);
  await toEngines();
}
async function dropPending(delta: number, project = PROJECT) {
  const rows = pending();
  const pass = claimPass({ project, repoDir: null, now: NOW + delta, importOnly: true })!;
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

test("a curator drop committed between the history lookup and the candidate write covers the equivalent new copy", async () => {
  const body = "Inspect current ownership before changing a running worker.\n";
  await fs.writeFile(path.join(memory, "topic.md"), body);
  await fs.writeFile(path.join(memory, "MEMORY.md"), "- [topic.md](topic.md)\n");
  await runMemoryImportWork({ importId: ID, previous: null, roots, at: AT }, ports());
  await toEngines();
  const rows = pending();
  expect(rows).toHaveLength(1);
  const pass = claimPass({ project: PROJECT, repoDir: null, now: NOW + 1, importOnly: true })!;
  await readCuration(pass, "imports");
  const revision = (await readCuration(pass)).scopes.find(scope => scope.scope === "machine")?.revision ?? 0;
  await fs.writeFile(path.join(memory, "copy.md"), body.replace("current", "current  "));
  let applied = 0;
  const record = await runMemoryImportWork({ importId: ID, previous: null, roots, at: at(HOUR), sync: true }, { ...ports(), beforeCandidateBatch: index => {
    if (index) return;
    // The curator's pass lands after the sync read the history and before it writes.
    applyCuration(pass, { scopes: [{ scope: "machine", revision, order: [] }],
      drop: rows.map(c => ({ candidate: c.id, occurrences: c.occurrences.map(o => o.id), reason: "task-specific" as const, note: "This note narrates a finished task." })) }, at(HOUR));
    patchPass(pass.id, { state: "succeeded", endedAt: at(HOUR + 1) });
    applied += 1;
  } });
  expect(applied).toBe(1);
  expect(record.sync).toEqual({ lastAt: at(HOUR), result: "ok", added: 0 });
  expect(pending()).toEqual([]);
  const copy = allCandidates().filter(c => c.occurrences.some(o => o.file.endsWith("copy.md")));
  expect(copy.map(c => candidateState(c).state)).toEqual(["dropped"]);
  const inherited = copy[0].dispositions.filter(d => d.occurrences.some(id => copy[0].occurrences.find(o => o.id === id)?.file.endsWith("copy.md")));
  expect(inherited).toMatchObject([{ kind: "drop", reason: "task-specific", pass: pass.id, inheritedFrom: rows[0].id }]);
});

test("a later deduplicated sync leaves a closed week's import counts unchanged (§6.2)", async () => {
  const { windowReport } = await import("./weeklyMetrics");
  await importedThenEngines();
  const week = { from: at(-HOUR), to: at(7 * 24 * HOUR) };
  const report = () => windowReport({ pipelines: [], memory: [], imports: allCandidates() as never, deliveries: [] }, week).imports;
  expect(report()).toEqual({ adopted: 0, dropped: { "task-specific": 1 }, adoptedArchived: 0 });
  await fs.writeFile(path.join(memory, "copy.md"), "Inspect   current ownership before changing a running worker.\n");
  expect((await syncRun(8 * 24 * HOUR)).sync).toMatchObject({ result: "ok", added: 0 });
  expect(pending()).toEqual([]);
  expect(allCandidates().flatMap(c => c.occurrences)).toHaveLength(2);
  expect(report()).toEqual({ adopted: 0, dropped: { "task-specific": 1 }, adoptedArchived: 0 });
  // A distinct curator outcome after the week is counted in its own week.
  await fs.writeFile(path.join(memory, "late.md"), "Check the account's remaining limit before starting a long run.\n");
  await syncRun(9 * 24 * HOUR);
  await dropPending(9 * 24 * HOUR + 1);
  expect(report()).toEqual({ adopted: 0, dropped: { "task-specific": 1 }, adoptedArchived: 0 });
  expect(windowReport({ pipelines: [], memory: [], imports: allCandidates() as never, deliveries: [] }, { from: at(9 * 24 * HOUR), to: at(10 * 24 * HOUR) }).imports.dropped).toEqual({ "task-specific": 1 });
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
  // A refused sync marks no attempt.
  expect(readImportRecord(ID)!.sync).toBeUndefined();
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

/** memorySyncDue read by a fresh process: a restarted reader sees only the durable record. */
async function freshDue(now: number) {
  const code = `const { memorySyncDue } = await import(${JSON.stringify(path.join(import.meta.dir, "importSync.ts"))}); const { readImportRecord } = await import(${JSON.stringify(path.join(import.meta.dir, "importStore.ts"))}); console.log(JSON.stringify(memorySyncDue(readImportRecord(${JSON.stringify(ID)}), ${now})));`;
  const child = Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, errors).toBe(0);
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

test("the schedule survives a restart: a fresh process reads the same due time from the durable record", async () => {
  await importedThenEngines();
  await syncRun(HOUR);
  const probe = freshDue;
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

/** A sync run in its own process, standing for the leased helper. `blockInventory` parks it in the
    inventory's project lookup after printing "inventory"; it never returns there. */
function spawnSync(blockInventory: boolean) {
  const code = `const { runMemoryImportWork } = await import(${JSON.stringify(path.join(import.meta.dir, "importWork.ts"))});
    setInterval(() => {}, 1000);
    await runMemoryImportWork({ importId: ${JSON.stringify(ID)}, previous: null, roots: ${JSON.stringify(roots)}, at: ${JSON.stringify(at(HOUR))}, sync: true }, {
      hostProject: ${JSON.stringify(PROJECT)}, writer: async () => ({ kind: "unknown", roleId: null }),
      projectForSlug: async () => { if (${blockInventory}) { console.log("inventory"); await new Promise(() => {}); } return ${JSON.stringify(PROJECT)}; },
    });
    console.log("finished");`;
  return Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
}
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
/** After a killed run: the marker alone, the hour's backoff for this and a restarted reader, untouched engine files, and a later run that completes. */
async function expectInterruptedAttempt(before: Record<string, string>) {
  expect(readImportRecord(ID)!.sync).toEqual({ lastAt: at(HOUR), result: "running", added: 0 });
  expect(memorySyncDue(readImportRecord(ID), NOW + HOUR + 59 * 60_000)).toBe(false);
  expect(await freshDue(NOW + HOUR + 59 * 60_000)).toBe(false);
  expect(await freshDue(NOW + 2 * HOUR)).toBe(true);
  expect(memorySyncStatus(readImportRecord(ID), NOW + HOUR + 20 * 60_000)?.failure).toBe("interrupted");
  expect(await hashes()).toEqual(before);
  expect((await syncRun(2 * HOUR)).sync).toEqual({ lastAt: at(2 * HOUR), result: "ok", added: 1 });
}

test("a helper killed in its inventory leaves its attempt marked, so the next refresh waits an hour", async () => {
  await importedThenEngines();
  await fs.writeFile(path.join(memory, "late.md"), "A note the killed run never reaches.\n");
  const before = await hashes();
  const child = spawnSync(true);
  const reader = child.stdout.getReader();
  let output = "";
  await until(async () => { const { value, done } = await reader.read(); if (done) throw Error(`helper ended early: ${await new Response(child.stderr).text()}`); output += new TextDecoder().decode(value); return output.includes("inventory"); }, "the inventory");
  child.kill("SIGKILL");
  expect(await child.exited).not.toBe(0);
  expect(output).not.toContain("finished");
  await expectInterruptedAttempt(before);
}, 60_000);

test("a helper killed while it waits for the import lock leaves its attempt marked, so the next refresh waits an hour", async () => {
  await importedThenEngines();
  await fs.writeFile(path.join(memory, "late.md"), "A note the killed run never reaches.\n");
  const before = await hashes();
  const parent = path.join(process.env.LLV_STATE_DIR!, "backups", "engine-memory");
  let release!: () => void, holding!: () => void;
  const held = new Promise<void>(resolve => { holding = resolve; });
  const holder = withFileTransaction(path.join(parent, "import-job"), "the test holds the import lock", () => new Promise<void>(resolve => { release = resolve; holding(); }));
  await held;
  const child = spawnSync(false);
  try {
    // The helper queued its own ticket behind this one: it waits for the lock.
    await until(async () => (await fs.readdir(path.join(parent, "import-job.write-locks"))).filter(name => name.endsWith(".json")).length >= 2, "the helper's lock ticket");
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
  } finally { child.kill("SIGKILL"); release(); await holder; }
  expect(await new Response(child.stdout).text()).not.toContain("finished");
  await expectInterruptedAttempt(before);
}, 60_000);

test("in the engines position the host is chosen among projects with a pending import batch", async () => {
  const A = "a-fixture", B = "b-fixture";
  await importedThenEngines(undefined, B);
  await fs.writeFile(path.join(memory, "late.md"), "Check the account's remaining limit before starting a long run.\n");
  await syncRun(HOUR, B);
  // Project A holds an ordinary rule, so it is due for an ordinary pass; B holds the pending import.
  roleMemoryCollection(true)!.boundedPatch(20, tx => {
    const id = newRuleId(tx), scope = roleScope(A, "builder");
    tx.put({ kind: "rule", id, scope, rule: "Inspect the requested scope before changing stored guidance.", why: "An earlier attempt applied guidance at the wrong level.", state: "active", hints: [],
      source: { project: A, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" }, createdAt: at(0), changedAt: at(0) });
    tx.put({ kind: "scope", scope, revision: 1, history: [], active: [id] });
  });
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "registry.json"));
  registry.conversation = () => ({ supersededBy: null, generations: [] }) as never;
  const seats = new Map<string, { conversationId: string; seatEpoch: number; designatedAt: string; path: null }>();
  const lives = new Map<string, AgentLivenessRecord>();
  const now = NOW + 2 * HOUR;
  const sources = { ...defaultSeatTickSources(), now: () => now, registry: () => registry, workerCounts: undefined,
    seatFor: (project: string) => ({ active: seats.get(project) ?? null, pending: null, history: [] }) as never,
    activeSeats: () => [...seats.keys()],
    pipelines: () => [...seats.keys()].map(project => ({ project, repoDir: root }) as never),
    liveness: async ({ conversationId }: { conversationId?: string }) => lives.has(conversationId!) ? [lives.get(conversationId!)!] : [],
    latestDeployment: () => ({ state: "ok" as const, value: null }),
  };
  const seat = (project: string, wakeAgo: number) => {
    const conversationId = `conversation_seat_${project}`;
    seats.set(project, { conversationId, seatEpoch: seats.size + 1, designatedAt: at(-86_400_000), path: null });
    lives.set(conversationId, { conversationId, host: { state: "alive", pid: process.pid, kind: "structured" }, lifecycle: "waiting", reason: "host_alive_turn_idle" } as AgentLivenessRecord);
    writeSeatTickState(project, { ...emptySeatTickState(), seatEpoch: seats.get(project)!.seatEpoch, lastWakeAt: new Date(now - wakeAgo).toISOString() });
  };
  const bodies: Record<string, unknown>[] = [];
  const controller = productionCurationController(sources, { archive: () => {}, observe: async () => ({ state: "running" as const }),
    launch: async body => { bodies.push(body); return { status: 202, body: { state: "running", conversationId: "conversation_fixture_curator", launchId: "fixture" } }; } });
  const tick = { ...tickInput(), project: A, now };
  try {
    // A alone: due for ordinary curation, nothing to import, so no pass of any kind.
    seat(A, 1000);
    expect(await controller.launchIfDue(tick)).toBe("curation: paused, memory off");
    expect(machinePass()).toBeNull();
    // B joins with an older wake: its import pass launches, never an ordinary pass in A.
    seat(B, 20_000);
    expect(await controller.launchIfDue(tick)).toContain("launched");
    expect(bodies.map(body => body.project)).toEqual([B]);
    const pass = readPass(String(bodies[0].clientAttemptId))!;
    expect(pass.project).toBe(B);
    expect(pass.importBatch).toMatchObject({ importId: ID, candidates: [pending()[0].id] });
  } finally { await stopWorktreeSweepWorker(); }
});
