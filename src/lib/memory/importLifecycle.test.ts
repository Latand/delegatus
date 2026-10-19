import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runMemoryImportWork } from "./importWork";
let advanceMemoryImportWork: typeof import("./importLifecycle").advanceMemoryImportWork;
let legacyMemoryGenerations: typeof import("./importLifecycle").legacyMemoryGenerations;
let importTrialExcludes: typeof import("./importLifecycle").importTrialExcludes;
import { readImportCandidates, readImportRecord } from "./importStore";
let candidateState: typeof import("./importCuration").candidateState;
import { readMemorySourceFile, setMemorySource } from "./source";
import { claimPass, patchPass } from "./curation/store";
import { readCuration } from "./curation/read";
import { applyCuration, revertCuratorPass } from "./curation/apply";
import { curatorBrief } from "./curation/brief";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RegistryFile } from "@/lib/agent/registry";
import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { joinMovedScopes, roleScope } from "./roleStore";
import type { ImportManifest, ImportRoots } from "./importTypes";

const AT = "2026-10-19T00:00:00.000Z", NOW = Date.parse(AT), PROJECT = "import-fixture", ID = "fixture-import";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let root: string, memory: string, roots: ImportRoots;
const previous = process.env.LLV_STATE_DIR;
const at = (delta: number) => new Date(NOW + delta).toISOString();
beforeEach(async () => {
  resetProjectAliasesForTests();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "import-lifecycle-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const home = path.join(root, "claude"); memory = path.join(home, "projects", "fixture", "memory");
  roots = { claudeHomes: [home], codexHomes: [] };
  await fs.mkdir(memory, { recursive: true }); await fs.mkdir(process.env.LLV_STATE_DIR!);
  ({ advanceMemoryImportWork, legacyMemoryGenerations, importTrialExcludes } = await import("./importLifecycle"));
  ({ candidateState } = await import("./importCuration"));
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: ID, importStartedAt: AT, changedAt: AT }));
});
afterEach(async () => { if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; await fs.rm(root, { recursive: true, force: true }); resetProjectAliasesForTests(); });
const ports = () => ({ hostProject: PROJECT, projectForSlug: () => PROJECT, writer: async () => ({ kind: "unknown" as const, roleId: null }) });
const request = (delta = 0) => ({ importId: ID, previous: null, roots, at: at(delta) });
async function backup(body = "Inspect current ownership before changing a running worker.\n") {
  await fs.writeFile(path.join(memory, "topic.md"), body);
  await fs.writeFile(path.join(memory, "MEMORY.md"), "- [Topic](topic.md)\n");
  return runMemoryImportWork(request(), ports());
}
async function dispose(options: { room?: boolean; one?: boolean; id?: string } = {}) {
  const id = options.id ?? ID;
  const rows = readImportCandidates(id).candidates.filter(c => candidateState(c).state === "pending");
  const p = claimPass({ project: PROJECT, repoDir: null, now: NOW })!; expect(p).not.toBeNull();
  await readCuration(p, "imports");
  const selected = options.one ? rows.slice(0, 1) : rows;
  applyCuration(p, { scopes: [{ scope: "machine", revision: 0, order: [] }],
    drop: selected.map(c => ({ candidate: c.id, occurrences: c.occurrences.map(o => o.id), reason: options.room ? "no-reader" as const : "task-specific" as const, note: options.room ? "Only available room prevents keeping this seat note." : "This note narrates a finished task.", ...(options.room ? { forRoom: true } : {}) })),
    defer: rows.filter(c => !selected.includes(c)).map(c => ({ candidate: c.id, occurrences: c.occurrences.map(o => o.id) })) }, AT);
  patchPass(p.id, { state: "succeeded", endedAt: at(1) }); return p;
}
async function manifest() { return JSON.parse(await fs.readFile(path.join(readImportRecord(ID)!.backup, "manifest.json"), "utf8")) as ImportManifest; }

test.each(["configured", "manifest"] as const)("seatless folders join the installation project from its %s remote outside a checkout", async mode => {
  const { viewerRepositoryProjects } = await import("@/lib/projects/viewerRepository");
  const { default: metadata } = await import("../../../package.json");
  const packaged = path.join(root, "packaged"); await fs.mkdir(packaged);
  await fs.writeFile(path.join(memory, "topic.md"), "A note from a folder without its own seat.\n");
  const remote = "https://example.invalid/fixture/viewer.git";
  const expected = viewerRepositoryProjects(mode === "configured" ? remote : metadata.repository.url, packaged)[0];
  const code = `import {runMemoryImportWork} from ${JSON.stringify(path.join(import.meta.dir, "importWork.ts"))}; import {readImportCandidates} from ${JSON.stringify(path.join(import.meta.dir, "importStore.ts"))}; const record=await runMemoryImportWork(${JSON.stringify(request())},{projectForSlug:()=>"seatless-fixture"}); console.log(JSON.stringify({project:record.hostProject,curationProject:readImportCandidates(record.id).candidates[0].curationProject}));`;
  const child = Bun.spawn([process.execPath, "--eval", code], { cwd: packaged, env: { ...process.env, LLV_VIEWER_CANONICAL_REMOTE: mode === "configured" ? remote : undefined }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, errors).toBe(0);
  expect(JSON.parse(output)).toEqual({ project: expected, curationProject: expected });
});

test("the flip waits for every loaded part and happens once; active follows the committed final scan", async () => {
  await backup("x".repeat(16384) + "Decisive instruction in the final bytes.\n");
  const before = await fs.readFile(path.join(memory, "topic.md"));
  await dispose({ one: true });
  await advanceMemoryImportWork(request(10), { ...ports(), legacy: async () => [] });
  expect(readMemorySourceFile()).toMatchObject({ phase: "importing" });
  expect(readImportRecord(ID)?.progress).toMatchObject({ files: 1, pendingFiles: 1, pendingParts: 2, pendingLoadedParts: 2, adopted: 0, dropped: 0 });
  const remaining = readImportCandidates(ID).candidates.filter(c => candidateState(c).state === "pending");
  const p = claimPass({ project: PROJECT, repoDir: null, now: NOW + 2 })!;
  await readCuration(p, "imports");
  applyCuration(p, { scopes: [{ scope: "machine", revision: 1, order: [] }], drop: remaining.map(c => ({ candidate: c.id, occurrences: c.occurrences.map(o => o.id), reason: "task-specific", note: "The rest also narrates the same completed task." })) }, at(2));
  patchPass(p.id, { state: "succeeded", endedAt: at(3) });
  await advanceMemoryImportWork(request(20), { ...ports(), legacy: async () => [], afterScan: async () => {
    expect(readMemorySourceFile()).toMatchObject({ phase: "draining", flippedAt: at(20) });
    expect(readMemorySourceFile()?.drainedAt).toBeUndefined(); expect((await manifest()).files.length).toBeGreaterThan(0);
  } });
  expect(readMemorySourceFile()).toMatchObject({ phase: "active", flippedAt: at(20), drainedAt: at(20) });
  await advanceMemoryImportWork(request(30), { ...ports(), legacy: async () => { throw Error("active imports do no more scans"); } });
  expect(readMemorySourceFile()?.flippedAt).toBe(at(20)); expect(await fs.readFile(path.join(memory, "topic.md"))).toEqual(before);
});

test("a legacy Claude writer holds the drain and its retirement scan imports the note written after the first scan", async () => {
  await backup(); await dispose();
  let legacy = ["legacy-claude"];
  const lifecycle = { ...ports(), legacy: async () => legacy };
  await advanceMemoryImportWork(request(10), lifecycle);
  expect(readMemorySourceFile()).toMatchObject({ phase: "draining", flippedAt: at(10) });
  expect(readMemorySourceFile()?.drainedAt).toBeUndefined();
  const late = "A legacy writer changed the note after the first scan.\n";
  await fs.writeFile(path.join(memory, "topic.md"), late);
  await advanceMemoryImportWork(request(20), lifecycle);
  expect(readImportCandidates(ID).candidates.some(c => c.body === late)).toBe(false);
  legacy = [];
  await advanceMemoryImportWork(request(30), { ...lifecycle, afterScan: async () => {
    expect(readMemorySourceFile()?.drainedAt).toBeUndefined();
    const candidate = readImportCandidates(ID).candidates.find(c => c.body === late)!; expect(candidate).toBeDefined();
    const file = (await manifest()).files.findLast(f => f.sha256 === candidate.occurrences[0].sha256)!;
    expect(sha(await fs.readFile(path.join(readImportRecord(ID)!.backup, file.copy)))).toBe(file.sha256);
  } });
  expect(readMemorySourceFile()).toMatchObject({ phase: "active", drainedAt: at(30) });
  expect(candidateState(readImportCandidates(ID).candidates.find(c => c.body === late)!).state).toBe("pending");
  expect(await fs.readFile(path.join(memory, "topic.md"), "utf8")).toBe(late);
  expect(importTrialExcludes(readImportRecord(ID)!, ["legacy-claude"])).toBe(true);
  expect(importTrialExcludes(readImportRecord(ID)!, ["new-generation"])).toBe(false);
});

test("a retirement during a scan owes another final scan; failed scans never start the trial", async () => {
  await backup(); await dispose(); let legacy = ["legacy-claude"];
  await advanceMemoryImportWork(request(10), { ...ports(), legacy: async () => legacy, afterScan: async () => {
    legacy = []; await fs.writeFile(path.join(memory, "topic.md"), "A write landed after the scan committed.\n");
  } });
  expect(readMemorySourceFile()?.phase).toBe("draining"); expect(readMemorySourceFile()?.drainedAt).toBeUndefined();
  await expect(advanceMemoryImportWork(request(20), { ...ports(), legacy: async () => legacy, afterCopy: async copy => { await fs.writeFile(copy, "bad copy"); } })).rejects.toThrow(/integrity/);
  expect(readMemorySourceFile()?.drainedAt).toBeUndefined();
  expect(readImportRecord(ID)?.reason).toBe("integrity");
  await advanceMemoryImportWork(request(30), { ...ports(), legacy: async () => [] });
  expect(readMemorySourceFile()?.phase).toBe("active");
  expect(readImportRecord(ID)?.reason).toBeUndefined();
  expect(readImportCandidates(ID).candidates.some(c => c.body === "A write landed after the scan committed.\n")).toBe(true);
});

test("the fallback scan is durable across a fresh helper process and reversal leaves stores intact", async () => {
  await backup(); await dispose();
  await advanceMemoryImportWork(request(10), { ...ports(), legacy: async () => ["legacy-claude"] });
  const late = "A durable fallback scan catches this changed file.\n";
  await fs.writeFile(path.join(memory, "topic.md"), late);
  const code = `import {advanceMemoryImportWork} from ${JSON.stringify(path.join(import.meta.dir, "importLifecycle.ts"))}; await advanceMemoryImportWork(${JSON.stringify(request(30 * 60_000 + 11))},{hostProject:${JSON.stringify(PROJECT)},projectForSlug:()=>${JSON.stringify(PROJECT)},legacy:async()=>["legacy-claude"]});`;
  const child = Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ stdout, stderr, exit }).toEqual({ stdout: "", stderr: "", exit: 0 });
  expect(readImportCandidates(ID).candidates.some(c => c.body === late)).toBe(true);
  expect(readMemorySourceFile()?.phase).toBe("draining");
  expect(setMemorySource("engines", at(40 * 60_000))).toBeNull();
  expect(await fs.readFile(path.join(memory, "topic.md"), "utf8")).toBe(late);
  await expect(advanceMemoryImportWork(request(50 * 60_000), ports())).rejects.toThrow(/source changed/);
  expect(readMemorySourceFile()?.source).toBe("engines");
});

test("generation evidence counts only live non-clean Claude starts before the flip; Codex never holds the drain", () => {
  const make = (id: string, engine: "claude" | "codex", cleanMemory = false, createdAt = AT, archivedAt: string | null = null) => {
    const pathname = path.join(root, id + ".jsonl");
    const generation = { id, path: pathname, launchProfile: { ...emptyLaunchProfile({ cwd: root }), cleanMemory }, createdAt, archivedAt, host: null, accountId: null, historyHash: null };
    return { conversation: { id: `conversation_${id}`, engine, generations: [generation] }, entry: { artifactPath: pathname, structuredHost: { process: captureProcessIdentity(process.pid) } } };
  };
  const snapshot = { conversations: {}, entries: {} } as Pick<RegistryFile, "conversations" | "entries">;
  for (const [id, engine, clean, created, archived] of [["legacy", "claude", false, AT, null], ["codex", "codex", false, AT, null], ["clean", "claude", true, AT, null], ["new", "claude", false, at(20), null], ["retired", "claude", false, AT, at(5)]] as const) {
    const { conversation, entry } = make(id, engine, clean, created, archived);
    snapshot.conversations[conversation.id as keyof typeof snapshot.conversations] = conversation as RegistryFile["conversations"][string];
    snapshot.entries[`${engine}:${id}`] = entry as RegistryFile["entries"][string];
  }
  expect(legacyMemoryGenerations(snapshot, at(10))).toEqual(["legacy"]);
});

test("a second import skips dispositioned hashes, but fully undone drops are offered again", async () => {
  await backup(); const p = await dispose(); expect(setMemorySource("engines", at(10))).toBeNull();
  const second = "second-import";
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: second, changedAt: at(20) }));
  await runMemoryImportWork({ ...request(20), importId: second }, ports());
  expect(readImportCandidates(second).candidates.every(c => candidateState(c).state === "dropped")).toBe(true);
  revertCuratorPass(p.id, at(30));
  const third = "third-import";
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: third, changedAt: at(40) }));
  await runMemoryImportWork({ ...request(40), importId: third }, ports());
  expect(readImportCandidates(third).candidates.every(c => candidateState(c).state === "pending")).toBe(true);
});

test("the orchestrator target rises only after its project's completed import records a seat room drop", async () => {
  await backup("---\ntype: feedback\nsession: seat\n---\nInspect the board before assigning another lane.\n");
  // Attribute the fixture note as a seat before the curator receives it.
  const { importCollection } = await import("./importStore");
  const candidate = readImportCandidates(ID).candidates[0];
  importCollection()!.boundedPatch(2, tx => tx.put({ ...candidate, suggestedScope: roleScope(PROJECT, "orchestrator"), occurrences: candidate.occurrences.map(o => ({ ...o, writer: { kind: "seat", roleId: "orchestrator" } })) }));
  expect(curatorBrief(PROJECT)).not.toContain("raised only this project's");
  await dispose({ room: true });
  expect(curatorBrief(PROJECT)).not.toContain("raised only this project's");
  await advanceMemoryImportWork(request(10), { ...ports(), legacy: async () => [] });
  expect(curatorBrief(PROJECT)).toContain("raised only this project's orchestrator four-scope target to 24 000 bytes");
  expect(curatorBrief("another-project")).not.toContain("raised only this project's");
  const code = `import {curatorBrief} from ${JSON.stringify(path.join(import.meta.dir, "curation/brief.ts"))}; console.log(curatorBrief(${JSON.stringify(PROJECT)}).includes("raised only this project's orchestrator"));`;
  const child = Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ output: output.trim(), errors, exit }).toEqual({ output: "true", errors: "", exit: 0 });
  expect(persistProjectAliases([{ source: PROJECT, target: "renamed-import-fixture", displayName: "Renamed fixture" }])).toBe(true);
  expect(curatorBrief("renamed-import-fixture")).toContain("raised only this project's orchestrator");
  joinMovedScopes(at(20));
  expect(curatorBrief("renamed-import-fixture")).toContain("raised only this project's orchestrator");
});

test("an operator reversal or undo after the legacy await prevents a stale flip", async () => {
  await backup(); const pass = await dispose();
  await advanceMemoryImportWork(request(10), { ...ports(), legacy: async () => {
    revertCuratorPass(pass.id, at(5)); return [];
  } });
  expect(readMemorySourceFile()?.phase).toBe("importing");
  expect(readImportCandidates(ID).candidates.every(c => candidateState(c).state === "pending")).toBe(true);
  await expect(advanceMemoryImportWork(request(20), { ...ports(), legacy: async () => { setMemorySource("engines", at(15)); return []; } })).resolves.toBeDefined();
  // Pending loaded candidates prevent reaching the injected legacy probe.
  expect(readMemorySourceFile()?.source).toBe("delegatus");
});

test("a reversal after an awaited host lookup preserves the operator's later choice", async () => {
  await backup(); await dispose();
  await expect(advanceMemoryImportWork(request(10), { ...ports(), legacy: async () => { setMemorySource("engines", at(5)); return []; } })).rejects.toThrow(/source changed/);
  expect(readMemorySourceFile()?.source).toBe("engines");
  expect(readMemorySourceFile()?.flippedAt).toBeUndefined();
});

test("a day-old drain asks only its host project's seat for a decision and never rotates a process", async () => {
  const { memoryImportDrainSignal } = await import("./importStatus");
  await backup(); await dispose();
  await advanceMemoryImportWork(request(10), { ...ports(), legacy: async () => ["legacy-claude"] });
  expect(memoryImportDrainSignal(PROJECT, NOW + 24 * 60 * 60_000 + 9)).toEqual([]);
  expect(memoryImportDrainSignal("other-project", NOW + 24 * 60 * 60_000 + 11)).toEqual([]);
  const signals = memoryImportDrainSignal(PROJECT, NOW + 24 * 60 * 60_000 + 11);
  expect(signals).toHaveLength(1); expect(signals[0].label).toContain("decision form");
  expect(readMemorySourceFile()?.phase).toBe("draining"); expect(readMemorySourceFile()?.drainedAt).toBeUndefined();
});

test("a room drop after the trial opened keeps the pre-trial budget", async () => {
  await backup();
  const { importCollection } = await import("./importStore");
  const candidate = readImportCandidates(ID).candidates[0];
  importCollection()!.boundedPatch(2, tx => tx.put({ ...candidate, occurrences: candidate.occurrences.map(o => ({ ...o, writer: { kind: "seat", roleId: "orchestrator" } })) }));
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "active", importId: ID, changedAt: AT, flippedAt: AT, drainedAt: AT }));
  await dispose({ room: true });
  await advanceMemoryImportWork(request(10), ports());
  expect(curatorBrief(PROJECT)).not.toContain("raised only this project's");
});
