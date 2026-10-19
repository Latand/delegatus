import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimPass, patchPass, readPass, type CuratorPass } from "./store";
import { readCuration } from "./read";
import { applyCuration, revertCuratorPass, type CurationApply } from "./apply";
import { readImportCandidates } from "../importStore";
let importCollection: typeof import("../importStore").importCollection;
let candidateById: typeof import("../importCuration").candidateById;
let candidateState: typeof import("../importCuration").candidateState;
import { roleMemoryCollection, projectView } from "../roleStore";
import { IMPORT_AT, IMPORT_ID, IMPORT_PROJECT, importCandidate, seedImport } from "../fixtures/import";
import type { ImportCandidate } from "../importTypes";
import type { RoleMemoryRule } from "../roleTypes";

const NOW = Date.parse(IMPORT_AT), RULE = "Check the current owner before changing a running worker's state.";
const WHY = "A retained import records this recurring ownership check.";
let root: string;
const previous = process.env.LLV_STATE_DIR;
// Resolve the new APIs per case so the pinned-base red run records each
// missing behaviour instead of aborting the entire file at import time.
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "import-curation-")); process.env.LLV_STATE_DIR = root;
  ({ importCollection } = await import("../importStore"));
  ({ candidateById, candidateState } = await import("../importCuration"));
});
afterEach(() => { if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
function pass(project = IMPORT_PROJECT, now = NOW) { const held = claimPass({ project, now, repoDir: null }); expect(held).not.toBeNull(); return held!; }
function scopeInput(scopes: Record<string, string[]>, edits: Partial<CurationApply> = {}): CurationApply {
  return { scopes: Object.entries(scopes).map(([scope, order]) => {
    const held = roleMemoryCollection()?.get(`s:${scope}`);
    return { scope, order, revision: held?.kind === "scope" ? held.revision : 0 };
  }), ...edits };
}
const ids = (candidate: ImportCandidate) => candidate.occurrences.map(o => o.id);
const drop = (candidate: ImportCandidate) => ({ candidate: candidate.id, occurrences: ids(candidate), reason: "task-specific" as const, note: "This narrates a finished task." });
function adopt(candidate: ImportCandidate, scope = candidate.suggestedScope) { return { candidate: candidate.id, occurrences: ids(candidate), parts: [{ to: scope, rule: RULE, why: WHY }], note: "Retain this general ownership check for its readers." }; }
function rule(id: string) { const row = roleMemoryCollection()!.get(`r:${id}`); expect(row?.kind).toBe("rule"); return row as RoleMemoryRule; }
async function adoptOne(candidate: ImportCandidate, p: CuratorPass) {
  await readCuration(p, "imports");
  const output = applyCuration(p, scopeInput({ [candidate.suggestedScope]: [`adopt:${candidate.id}:0`] }, { adopt: [adopt(candidate)] }), IMPORT_AT);
  return output.placeholders[`adopt:${candidate.id}:0`];
}

test.each(["candidate", "part", "occurrence"] as const)("import refuses an unaccounted %s and stores no rules or receipts", async kind => {
  const first = importCandidate(1), second = importCandidate(2);
  if (kind === "part") { second.group = first.id; first.part.of = 2; second.part = { index: 1, of: 2, bytes: [74, 148] }; }
  if (kind === "occurrence") first.occurrences.push({ ...first.occurrences[0], id: "o_0000000000000002", file: "projects/fixture/memory/copy.md" });
  await seedImport(kind === "occurrence" ? [first] : [first, second]);
  const p = pass(); await readCuration(p, "imports");
  const operation = { ...drop(first), occurrences: [first.occurrences[0].id] };
  expect(() => applyCuration(p, scopeInput({ machine: [] }, { drop: [operation] }), IMPORT_AT)).toThrow(/every candidate/);
  expect(candidateById(IMPORT_ID, first.id)!.dispositions).toEqual([]);
  expect(roleMemoryCollection()?.get("s:machine")).toBeNull();
});

test("a disposition requires a read of that part; an unread tail keeps a 16 KB file pending", async () => {
  const first = importCandidate(1, { body: "a".repeat(8192) }), tail = importCandidate(2, { group: first.id, body: "b".repeat(8192) });
  first.part = { index: 0, of: 2, bytes: [0, 8192] }; tail.part = { index: 1, of: 2, bytes: [8192, 16384] };
  await seedImport([first, tail]); const p = pass();
  expect(() => applyCuration(p, scopeInput({ machine: [] }, { drop: [drop(first), drop(tail)] }))).toThrow(/must read this part/);
  const read = await readCuration(p, "imports");
  expect("candidates" in read && read.candidates.map(c => c.body).join("")).toBe(first.body + tail.body);
  importCollection()!.boundedPatch(2, tx => tx.put({ ...candidateById(IMPORT_ID, tail.id)!, readBy: [] }));
  expect(() => applyCuration(p, scopeInput({ machine: [] }, { drop: [drop(first), drop(tail)] }))).toThrow(/must read this part/);
  expect(readImportCandidates(IMPORT_ID).candidates.every(c => candidateState(c).state === "pending")).toBe(true);
});

test("adopt writes an active curated rule with every occurrence and import provenance", async () => {
  const candidate = importCandidate(1); candidate.occurrences.push({ ...candidate.occurrences[0], id: "o_0000000000000002", file: "projects/fixture/memory/duplicate.md" });
  await seedImport([candidate]); const p = pass(); const id = await adoptOne(candidate, p);
  expect(rule(id)).toMatchObject({ state: "active", curatedAt: IMPORT_AT, source: { origin: "import", candidate: candidate.id, occurrences: candidate.occurrences, engine: "claude", sha256: candidate.contentSha256, importId: IMPORT_ID } });
  expect(candidateState(candidateById(IMPORT_ID, candidate.id)!)).toMatchObject({ state: "adopted", pending: [], ruleIds: [id] });
  expect(projectView(IMPORT_PROJECT).scopes.flatMap(s => s.active).find(r => r.id === id)?.importSource?.occurrences).toEqual(candidate.occurrences);
});

test("equal bodies in two projects keep both narrow scopes and refuse adoption beyond their reach", async () => {
  const a = importCandidate(1), b = importCandidate(2, { curationProject: "project-b", suggestedScope: "project:project-b" });
  b.occurrences[0].project = "project-b"; a.linked = [b.id]; b.linked = [a.id];
  await seedImport([a, b]); const p = pass(); await readCuration(p, "imports");
  expect(() => applyCuration(p, scopeInput({ "project:project-b": [`adopt:${a.id}:0`] }, { adopt: [adopt(a, "project:project-b")] }))).toThrow(/scope/);
  const one = await adoptOne(a, p); patchPass(p.id, { state: "succeeded", endedAt: new Date(NOW + 1).toISOString() });
  const q = pass("project-b", NOW + 2); const two = await adoptOne(b, q);
  expect(rule(one).scope).toBe(a.suggestedScope); expect(rule(two).scope).toBe(b.suggestedScope);
  expect(roleMemoryCollection()?.get("s:machine")).toBeNull();
});

test("undo of an adoption merged into pre-existing text re-pends its candidate and preserves that text", async () => {
  const candidate = importCandidate(1); await seedImport([candidate]);
  const target = "r_1111111111111111", scope = candidate.suggestedScope;
  roleMemoryCollection(true)!.boundedPatch(2, tx => {
    tx.put({ kind: "rule", id: target, scope, rule: RULE, why: WHY, state: "active", hints: [], createdAt: IMPORT_AT, changedAt: IMPORT_AT,
      source: { origin: "seat", project: IMPORT_PROJECT, roleId: "orchestrator", fixRound: false, conversationId: "conversation_fixture" } });
    tx.put({ kind: "scope", scope, active: [target], revision: 1, history: [] });
  });
  const p = pass(); expect(await adoptOne(candidate, p)).toBe(target);
  expect(candidateState(candidateById(IMPORT_ID, candidate.id)!)).toMatchObject({ state: "adopted", ruleIds: [target] });
  patchPass(p.id, { state: "succeeded", endedAt: new Date(NOW + 1).toISOString() });
  expect(revertCuratorPass(p.id, new Date(NOW + 2).toISOString())).toMatchObject({ skipped: [], importUndo: { state: "undone", kept: 0 } });
  expect(rule(target)).toMatchObject({ state: "active", rule: RULE });
  expect(candidateState(candidateById(IMPORT_ID, candidate.id)!).state).toBe("pending");
});

test("one occurrence can be adopted and another dropped; explicit defer permits another call", async () => {
  const a = importCandidate(1), b = importCandidate(2); a.occurrences.push({ ...a.occurrences[0], id: "o_0000000000000003" });
  await seedImport([a, b]); const p = pass(); await readCuration(p, "imports");
  const adoption = { ...adopt(a), occurrences: [a.occurrences[0].id] };
  applyCuration(p, scopeInput({ [a.suggestedScope]: [`adopt:${a.id}:0`] }, { adopt: [adoption], drop: [{ ...drop(a), occurrences: [a.occurrences[1].id] }], defer: [{ candidate: b.id, occurrences: ids(b) }] }), IMPORT_AT);
  expect(candidateState(candidateById(IMPORT_ID, a.id)!).state).toBe("adopted");
  applyCuration(p, scopeInput({ machine: [] }, { drop: [drop(b)] }), new Date(NOW + 1).toISOString());
  expect(candidateState(candidateById(IMPORT_ID, b.id)!).state).toBe("dropped");
});

test("a host pass counts and undoes a seatless folder's own scope", async () => {
  const candidate = importCandidate(1, { curationProject: IMPORT_PROJECT, suggestedScope: "project:seatless-folder" });
  candidate.occurrences[0].project = "seatless-folder";
  await seedImport([candidate]); const p = pass(); const id = await adoptOne(candidate, p);
  expect(readPass(p.id)!.counts).toMatchObject({ calls: 1, changed: 1 });
  patchPass(p.id, { state: "succeeded", endedAt: new Date(NOW + 1).toISOString() });
  expect(revertCuratorPass(p.id, new Date(NOW + 2).toISOString()).skipped).toEqual([]);
  expect(rule(id).reason).toBe("undone");
  expect(candidateState(candidateById(IMPORT_ID, candidate.id)!).state).toBe("pending");
});

test("completed redispositions after Undo cannot starve the next pending batch", async () => {
  const { selectImportBatch } = await import("../importCuration");
  const rows = Array.from({ length: 81 }, (_, i) => importCandidate(i + 1));
  await seedImport(rows);
  // A completed Undo followed by a new disposition is no longer pending.
  // Seed durable receipts so this probes the selector beyond its 80-row cap.
  const { curationCollection } = await import("./store");
  const p = pass();
  patchPass(p.id, { state: "succeeded", endedAt: new Date(NOW + 1).toISOString(), revertedAt: new Date(NOW + 2).toISOString(), skipped: [] });
  curationCollection()!.boundedPatch(2, tx => tx.put({ ...readPass(p.id)!, id: "curate_redisposition", revertedAt: undefined }));
  importCollection()!.boundedPatch(100, tx => {
    for (const row of rows.slice(0, 80)) tx.put({ ...candidateById(IMPORT_ID, row.id)!, dispositions: [
      { at: IMPORT_AT, pass: p.id, kind: "drop", ruleIds: [], occurrences: ids(row), reason: "stale", note: "Earlier disposition." },
      { at: new Date(NOW + 3).toISOString(), pass: "curate_redisposition", kind: "drop", ruleIds: [], occurrences: ids(row), reason: "stale", note: "Completed reconsideration." },
    ] });
  });
  expect(selectImportBatch(IMPORT_PROJECT)?.candidates).toEqual([rows[80].id]);
});

test.each(["rewrite", "ranking", "merge", "split", "none"] as const)("pass undo derives candidate state after later %s and prevents duplicate adoption", async later => {
  const candidate = importCandidate(1); await seedImport([candidate]); const p = pass(); const id = await adoptOne(candidate, p);
  patchPass(p.id, { state: "succeeded", endedAt: new Date(NOW + 1).toISOString() });
  const scope = candidate.suggestedScope;
  if (later !== "none") {
    // A succeeding pass has the ordinary interval because the import is done.
    const q = pass(IMPORT_PROJECT, NOW + 24 * 60 * 60_000);
    const edits: Partial<CurationApply> = later === "rewrite" ? { rewrite: [{ id, rule: RULE + " Check its revision too.", note: "A later writer retained an extra condition." }] }
      : later === "split" ? { split: [{ id, parts: [{ to: scope, rule: RULE }, { to: "machine", rule: "Inspect ownership evidence before stopping a shared process." }], note: "Separate the project check and the general stopping check." }] } : {};
    if (later === "merge") {
      // Restore an independent target by importing another candidate.
      const other = importCandidate(2); await seedImport([other]);
      const batch = claimPass({ project: IMPORT_PROJECT, repoDir: null, now: NOW + 25 * 60 * 60_000 }); expect(batch).toBeNull();
      const target = "r_1111111111111111";
      roleMemoryCollection()!.boundedPatch(4, tx => { const s = tx.get(`s:${scope}`); if (s?.kind !== "scope") throw Error(); tx.put({ ...rule(id), id: target }); tx.put({ ...s, active: [...s.active, target] }); });
      edits.merge = [{ into: target, from: [id], rule: RULE, note: "The equal active rule survives this merge." }];
      applyCuration(q, scopeInput({ [scope]: [target] }, edits), IMPORT_AT);
    } else applyCuration(q, scopeInput({ [scope]: [id], ...(later === "split" ? { machine: [`split:${id}:1`] } : {}) }, edits), IMPORT_AT);
    patchPass(q.id, { state: "succeeded", endedAt: new Date(NOW + 24 * 60 * 60_000 + 1).toISOString() });
  }
  const result = revertCuratorPass(p.id, new Date(NOW + 26 * 60 * 60_000).toISOString());
  const current = candidateState(candidateById(IMPORT_ID, candidate.id)!);
  expect(result.importUndo?.state).toBe(later === "none" ? "undone" : "partly undone");
  expect(current.state).toBe(later === "none" ? "pending" : "adopted");
  if (later === "none") { expect(rule(id).reason).toBe("undone"); expect(result.skipped).toEqual([]); expect(current.undonePasses).toEqual([p.id]); }
  else { expect(result.skipped).toContain(id); expect(current.ruleIds.length).toBeGreaterThan(0); }
  const r = pass(IMPORT_PROJECT, NOW + 48 * 60 * 60_000);
  if (later !== "none") {
    // A hostile call cannot manufacture another import batch for an adopted row.
    patchPass(r.id, { importBatch: { importId: IMPORT_ID, candidates: [candidate.id] } });
    await readCuration(readPass(r.id)!, "imports");
    expect(() => applyCuration(readPass(r.id)!, scopeInput({ [scope]: [id, `adopt:${candidate.id}:0`] }, { adopt: [adopt(candidate)] }))).toThrow(/surviving rule/);
  }
});

test("successful import batches bypass cooldown while a failed batch keeps it, across process restart", async () => {
  const rows = Array.from({ length: 41 }, (_, i) => importCandidate(i + 1)); await seedImport(rows);
  const p = pass(); expect(p.importBatch!.candidates).toHaveLength(40); await readCuration(p, "imports");
  applyCuration(p, scopeInput({ machine: [] }, { drop: rows.slice(0, 40).map(drop) }), IMPORT_AT);
  patchPass(p.id, { state: "succeeded", endedAt: new Date(NOW + 1).toISOString() });
  const code = `import { claimPass, patchPass } from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; const p=claimPass({project:${JSON.stringify(IMPORT_PROJECT)}, repoDir:null, now:${NOW + 2}}); if(!p) process.exit(2); patchPass(p.id,{state:"failed", endedAt:${JSON.stringify(new Date(NOW + 3).toISOString())}}); console.log(p.importBatch.candidates.length);`;
  const child = Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0); expect(stdout.trim()).toBe("1");
  expect(claimPass({ project: IMPORT_PROJECT, repoDir: null, now: NOW + 4 })).toBeNull();
});

test("a commit refusal rolls back imported rules and dispositions together, then the same read can retry", async () => {
  const { injectStateWriteFaultForTests } = await import("@/lib/state/sqliteStateStore");
  const candidate = importCandidate(1); await seedImport([candidate]); const p = pass();
  await readCuration(p, "imports");
  const input = scopeInput({ [candidate.suggestedScope]: [`adopt:${candidate.id}:0`] }, { adopt: [adopt(candidate)] });
  try {
    injectStateWriteFaultForTests({ site: "commit", collection: "role_memory", times: 1, error: Error("fixture commit refused") });
    expect(() => applyCuration(p, input, IMPORT_AT)).toThrow(/fixture commit refused/);
  } finally { injectStateWriteFaultForTests(null); }
  expect(candidateById(IMPORT_ID, candidate.id)!.dispositions).toEqual([]);
  expect(roleMemoryCollection()!.get(`s:${candidate.suggestedScope}`)).toBeNull();
  expect(() => applyCuration(p, input, IMPORT_AT)).not.toThrow();
});

test("groups longer than a page continue in bounded same-project passes without losing a byte", async () => {
  const rows = Array.from({ length: 17 }, (_, index) => importCandidate(index + 1, {
    group: "c_0000000000000001", body: index === 16 ? "Decisive final instruction." : String.fromCharCode(65 + index).repeat(8192),
    part: { index, of: 17, bytes: [index * 8192, index * 8192 + (index === 16 ? Buffer.byteLength("Decisive final instruction.") : 8192)] },
  }));
  await seedImport(rows);
  const bodies: string[] = [];
  for (let round = 0; round < 3; round++) {
    const p = pass(IMPORT_PROJECT, NOW + round * 2);
    const page = await readCuration(p, "imports");
    expect(page.candidates.length).toBeLessThanOrEqual(40);
    expect(page.candidates.reduce((bytes, c) => bytes + Buffer.byteLength(c.body), 0)).toBeLessThanOrEqual(64 * 1024);
    bodies.push(...page.candidates.map(c => c.body));
    applyCuration(p, scopeInput({ machine: [] }, { drop: page.candidates.map(drop) }), new Date(NOW + round * 2).toISOString());
    patchPass(p.id, { state: "succeeded", endedAt: new Date(NOW + round * 2 + 1).toISOString() });
    expect(rows.some(c => candidateState(candidateById(IMPORT_ID, c.id)!).state === "pending")).toBe(round < 2);
  }
  expect(bodies.join("")).toBe(rows.map(c => c.body).join(""));
});
