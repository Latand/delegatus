import { beforeEach, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedImport, importCandidate, IMPORT_AT, IMPORT_ID, IMPORT_PROJECT } from "./fixtures/import";
import { roleMemoryCollection } from "./roleStore";
import { claimPass } from "./curation/store";
import { readCuration } from "./curation/read";
import { applyCuration, type CurationApply } from "./curation/apply";
import { setMemorySource, readMemorySourceFile } from "./source";
import { readImportCandidates, writeImportRows } from "./importStore";
import { runMemoryImport } from "./importJob";

/** Black-box detectors use only APIs that exist on the pinned base. They are
 * copied unchanged, with the fixture, into that export for the red campaign. */
let root: string;
const previous = process.env.LLV_STATE_DIR;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "source-import-contract-")); process.env.LLV_STATE_DIR = path.join(root, "state"); fs.mkdirSync(process.env.LLV_STATE_DIR);
  roleMemoryCollection(true)!.boundedPatch(4, tx => {
    const scope = `role:${IMPORT_PROJECT}:builder`, id = "r_0000000000000001";
    tx.put({ kind: "rule", id, scope, rule: "Check current ownership before editing a shared worker.", why: "An existing rule admits an ordinary pass on the pinned base.", state: "active", hints: [], source: { project: IMPORT_PROJECT, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" }, createdAt: IMPORT_AT, changedAt: IMPORT_AT });
    tx.put({ kind: "scope", scope, active: [id], revision: 1, history: [] });
  });
});
afterEach(() => { if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
const pass = () => claimPass({ project: IMPORT_PROJECT, repoDir: null, now: Date.parse(IMPORT_AT) })!;
async function readOffered(p: ReturnType<typeof pass>) { const meta = await readCuration(p); if ("import" in meta) await readCuration(p, "imports"); }

test("Delegatus selection is accepted and starts importing with the engines still on", () => {
  expect(setMemorySource("delegatus", IMPORT_AT)).toBeNull();
  expect(readMemorySourceFile()).toMatchObject({ source: "delegatus", phase: "importing" });
});

test.each(["candidate", "part", "occurrence"] as const)("apply refuses a batch's missing %s", async kind => {
  const first = importCandidate(1), second = importCandidate(2);
  if (kind === "part") { first.part.of = 2; second.group = first.id; second.part = { index: 1, of: 2, bytes: [74, 148] }; }
  if (kind === "occurrence") first.occurrences.push({ ...first.occurrences[0], id: "o_0000000000000002" });
  await seedImport(kind === "occurrence" ? [first] : [first, second]); const p = pass(); await readOffered(p);
  const input = { scopes: [{ scope: "machine", revision: 0, order: [] }], drop: [{ candidate: first.id, occurrences: [first.occurrences[0].id], reason: "task-specific", note: "This is a narration of a completed task." }] } as CurationApply;
  expect(() => applyCuration(p, input, IMPORT_AT)).toThrow();
});

test("a pass cannot drop a candidate part its read never returned", async () => {
  const candidate = importCandidate(1); await seedImport([candidate]); const p = pass();
  expect(() => applyCuration(p, { scopes: [{ scope: "machine", revision: 0, order: [] }], drop: [{ candidate: candidate.id, occurrences: candidate.occurrences.map(o => o.id), reason: "task-specific", note: "This is a narration of one completed task." }] } as CurationApply, IMPORT_AT)).toThrow();
});

test("the curator receives the final decisive bytes of a 16 KB import group", async () => {
  const first = importCandidate(1, { body: "x".repeat(8192) }), second = importCandidate(2, { group: first.id, body: "y".repeat(8150) + "Follow the decisive instruction at the end." });
  first.part.of = 2; second.part = { index: 1, of: 2, bytes: [8192, 8192 + Buffer.byteLength(second.body)] };
  await seedImport([first, second]);
  const read = await readCuration(pass(), "imports");
  expect(JSON.stringify(read)).toContain("Follow the decisive instruction at the end.");
});

test("adopt creates a curated rule with import origin and every source occurrence", async () => {
  const candidate = importCandidate(1); await seedImport([candidate]); const p = pass(); await readOffered(p);
  const result = applyCuration(p, { scopes: [{ scope: candidate.suggestedScope, revision: 0, order: [`adopt:${candidate.id}:0`] }], adopt: [{ candidate: candidate.id, occurrences: candidate.occurrences.map(o => o.id), parts: [{ to: candidate.suggestedScope, rule: "Inspect current ownership before changing a shared worker.", why: "This imported note records a recurring ownership check." }], note: "Keep this generic condition with its project readers." }] } as CurationApply, IMPORT_AT);
  const row = roleMemoryCollection()!.get(`r:${result.placeholders[`adopt:${candidate.id}:0`]}`);
  expect(row).toMatchObject({ state: "active", curatedAt: IMPORT_AT, source: { origin: "import", occurrences: candidate.occurrences } });
});

test("an adoption outside the named scopes is refused even when the ordinary partition is empty", async () => {
  const candidate = importCandidate(1); await seedImport([candidate]); const p = pass(); await readOffered(p);
  expect(() => applyCuration(p, { scopes: [{ scope: "machine", revision: 0, order: [] }], adopt: [{ candidate: candidate.id, occurrences: candidate.occurrences.map(o => o.id), parts: [{ to: "project:foreign", rule: "Check ownership before editing a shared worker.", why: "This records a recurring ownership check for future work." }], note: "Try to reach a scope this call did not name." }] } as CurationApply, IMPORT_AT)).toThrow();
});

test("a production helper flips only after its backed-up loaded candidates have dispositions", async () => {
  const home = path.join(root, "claude"), memory = path.join(home, "projects", "fixture", "memory"); fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, "MEMORY.md"), "- [Topic](topic.md)\n"); fs.writeFileSync(path.join(memory, "topic.md"), "Inspect current ownership before changing a worker.\n");
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: IMPORT_ID, changedAt: IMPORT_AT }));
  const request = { importId: IMPORT_ID, previous: null, roots: { claudeHomes: [home], codexHomes: [] }, at: IMPORT_AT };
  await runMemoryImport(request); expect(readMemorySourceFile()?.phase).toBe("importing");
  const candidates = readImportCandidates(IMPORT_ID).candidates;
  await writeImportRows(candidates.map(c => ({ ...c, dispositions: [{ at: IMPORT_AT, pass: "fixture-disposition", kind: "drop", ruleIds: [], reason: "task-specific", note: "This fixture narrates one finished task.", occurrences: c.occurrences.map(o => o.id) }] })));
  await runMemoryImport({ ...request, advance: true });
  expect(readMemorySourceFile()).toMatchObject({ phase: "active", flippedAt: IMPORT_AT, drainedAt: IMPORT_AT });
});

test.each(["seat", "preference", "narration", "defect"] as const)("the import disposition contract handles %s", async kind => {
  const candidate = importCandidate(1, { suggestedScope: kind === "seat" ? `role:${IMPORT_PROJECT}:orchestrator` : `project:${IMPORT_PROJECT}` });
  if (kind === "seat") candidate.occurrences[0].writer = { kind: "seat", roleId: "orchestrator" };
  await seedImport([candidate]); const p = pass(); await readOffered(p);
  const target = kind === "seat" ? candidate.suggestedScope : kind === "preference" ? "machine" : candidate.suggestedScope;
  const adoption = { candidate: candidate.id, occurrences: candidate.occurrences.map(o => o.id), parts: [{ to: target, rule: kind === "seat" ? "Inspect the board before assigning another worker." : "Keep replies concise and use the operator's latest language.", why: "The imported note records a recurring preference for these readers." }], note: "Retain this note at the level whose readers act on it." };
  applyCuration(p, { scopes: [{ scope: target, revision: 0, order: kind === "seat" || kind === "preference" ? [`adopt:${candidate.id}:0`] : [] }],
    ...(kind === "seat" || kind === "preference" ? { adopt: [adoption] } : kind === "narration" ? { drop: [{ candidate: candidate.id, occurrences: candidate.occurrences.map(o => o.id), reason: "task-specific", note: "This narrates a completed task." }] } : { problem: [{ id: candidate.id, statement: "The exporter omits units from its header.", evidence: "The fixture export has a header without units.", note: "The original project seat should assess this defect." }] }) } as CurationApply, IMPORT_AT);
  const disposition = readImportCandidates(IMPORT_ID).candidates[0].dispositions[0];
  expect(disposition).toBeDefined();
  expect(disposition.kind).toBe(kind === "seat" || kind === "preference" ? "adopt" : "drop");
  if (kind === "narration" || kind === "defect") expect(disposition.reason).toBe(kind === "defect" ? "problem" : "task-specific");
  else expect(roleMemoryCollection()!.get(`r:${disposition.ruleIds[0]}`)).toMatchObject({ scope: target });
});
