import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { runMemoryImportWork } from "./importWork";
import { readImportCandidates, readImportRecord } from "./importStore";
import type { ImportRoots } from "./importTypes";
import { memorySource, readMemorySourceFile } from "./source";
import { storedLessonTexts } from "./roleStore";

const at = "2026-10-19T00:00:00.000Z";
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
let root: string;
let roots: ImportRoots;
const priorState = process.env.LLV_STATE_DIR;
const write = async (file: string, body: string) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-import-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
  roots = { claudeHomes: [path.join(root, "claude-a"), path.join(root, "claude-b")], codexHomes: [path.join(root, "codex")] };
});
afterEach(async () => {
  if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
  await fs.rm(root, { recursive: true, force: true });
});
const memory = () => path.join(roots.claudeHomes[0], "projects", "project-a", "memory");
async function run(id = "fixture-1", ports: Parameters<typeof runMemoryImportWork>[1] = {}) {
  await write(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: id, changedAt: at }));
  return runMemoryImportWork({ importId: id, previous: null, roots, at }, { projectForSlug: slug => slug, ...ports });
}

test("linked account homes back up each physical file once with exact private copies and source hashes unchanged", async () => {
  const topic = "---\ntype: feedback\n---\nVerify the fixture before applying the change.\n";
  await write(path.join(memory(), "topic.md"), topic);
  await write(path.join(memory(), "MEMORY.md"), "- [Topic](topic.md)\n");
  const linked = path.join(roots.claudeHomes[1], "projects", "project-a", "memory");
  await fs.mkdir(path.dirname(linked), { recursive: true }); await fs.symlink(memory(), linked);
  const before = new Map(await Promise.all(["topic.md", "MEMORY.md"].map(async name => [name, sha(await fs.readFile(path.join(memory(), name)))] as const)));
  const result = await run();
  expect(result.state).toBe("ready");
  const manifest = JSON.parse(await fs.readFile(path.join(result.backup, "manifest.json"), "utf8"));
  expect(manifest.files).toHaveLength(2);
  for (const entry of manifest.files) {
    expect(sha(await fs.readFile(path.join(result.backup, entry.copy)))).toBe(entry.sha256);
    expect(before.get(path.basename(entry.file))).toBe(entry.sha256);
    expect(sha(await fs.readFile(path.join(memory(), path.basename(entry.file))))).toBe(entry.sha256);
    expect((await fs.stat(path.join(result.backup, entry.copy))).mode & 0o777).toBe(0o600);
  }
  expect((await fs.stat(result.backup)).mode & 0o777).toBe(0o700);
  const page = readImportCandidates("fixture-1");
  expect(page.candidates).toHaveLength(1);
  expect(page.candidates[0]).toMatchObject({ body: topic, loadedAtStart: true, occurrences: [{ file: "projects/project-a/memory/topic.md", sha256: before.get("topic.md") }] });
  expect(readImportRecord("fixture-1")?.state).toBe("ready");
  expect(storedLessonTexts()).not.toContain(topic);
  expect((await fs.stat(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"))).mode & 0o777).toBe(0o600);
});

test("normalized duplicates retain both occurrences while project, type and writer changes give linked candidates", async () => {
  const topic = (type: string, session: string, body = "Validate every persisted receipt.\n") => `---\nname: Receipt checks\ntype: ${type}\nsession_id: ${session}\nmodified: ${at}\n---\n${body}`;
  await write(path.join(memory(), "seat.md"), topic("feedback", "seat-session"));
  await write(path.join(memory(), "old", "copy.md"), topic("feedback", "seat-session", "Validate   every persisted receipt.\n"));
  await write(path.join(memory(), "stage.md"), topic("feedback", "stage-session"));
  await write(path.join(memory(), "reference.md"), topic("reference", "seat-session"));
  await write(path.join(roots.claudeHomes[0], "projects", "project-b", "memory", "other.md"), topic("feedback", "seat-session"));
  await run("fixture-1", { writer: async session => ({ kind: session === "seat-session" ? "seat" : "stage", roleId: session === "seat-session" ? "orchestrator" : "builder" }) });
  const { candidates } = readImportCandidates("fixture-1");
  expect(candidates).toHaveLength(4);
  expect(new Set(candidates.map(row => row.contentSha256)).size).toBe(1);
  const seat = candidates.find(row => row.occurrences.length === 2)!;
  expect(seat.occurrences.map(row => row.file).sort()).toEqual(["projects/project-a/memory/old/copy.md", "projects/project-a/memory/seat.md"]);
  expect(seat.suggestedScope).toBe("role:project-a:orchestrator");
  expect(candidates.find(row => row.occurrences[0].writer.kind === "stage")?.suggestedScope).toBe("role:project-a:builder");
  for (const row of candidates) {
    expect(row.linked.sort()).toEqual(candidates.filter(other => other.id !== row.id).map(other => other.id).sort());
    expect(row.occurrences.every(item => item.writtenAt === at)).toBe(true);
  }
});

test("a 16 KB topic keeps its final instruction in the read and covers every backup byte once, including long Unicode lines", async () => {
  const prefix = "---\ntype: feedback\n---\n" + "line of fixture text\n".repeat(300) + "🙂".repeat(2100);
  const final = "\nFINAL: check the last fixture instruction.\n";
  const body = prefix + "p".repeat(16 * 1024 - Buffer.byteLength(prefix + final)) + final;
  expect(Buffer.byteLength(body)).toBe(16 * 1024);
  await write(path.join(memory(), "long.md"), body);
  await run();
  const { candidates } = readImportCandidates("fixture-1");
  const parts = candidates.sort((a, b) => a.part.index - b.part.index);
  expect(parts.length).toBeGreaterThan(1);
  expect(new Set(parts.map(row => row.group)).size).toBe(1);
  let offset = 0;
  for (const part of parts) {
    expect(part.part.bytes[0]).toBe(offset);
    expect(part.part.bytes[1] - offset).toBe(Buffer.byteLength(part.body));
    expect(Buffer.byteLength(part.body)).toBeLessThanOrEqual(8192);
    expect(part.body).not.toContain("�");
    expect(part.part.of).toBe(parts.length);
    offset = part.part.bytes[1];
  }
  expect(parts.map(part => part.body).join("")).toBe(body);
  expect(offset).toBe(Buffer.byteLength(body));
  expect(parts.at(-1)!.body).toContain("FINAL: check the last fixture instruction.");
});

test("retention rejects path traversal in a manifest before deleting any listed or unrelated file", async () => {
  await write(path.join(memory(), "topic.md"), "Retention boundary fixture.\n");
  const first = await run("fixture-1");
  const manifestFile = path.join(first.backup, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  const originalCopy = path.join(first.backup, manifest.files[0].copy);
  const outside = path.join(root, "keep.fixture"); await fs.writeFile(outside, "Keep outside fixture.");
  manifest.files.push({ ...manifest.files[0], copy: path.relative(first.backup, outside) });
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  for (let index = 2; index <= 5; index++) await run(`fixture-${index}`);
  await expect(run("fixture-6")).rejects.toThrow("invalid memory backup path");
  expect(await fs.readFile(outside, "utf8")).toBe("Keep outside fixture.");
  expect(await fs.readFile(originalCopy, "utf8")).toBe("Retention boundary fixture.\n");
});

test("only Claude topic files and Codex summary bullets become candidates, with root-index reachability and summary headings", async () => {
  await write(path.join(memory(), "MEMORY.md"), "- [Root](root.md)\n");
  await write(path.join(memory(), "root.md"), "Root fixture topic.\n");
  await write(path.join(memory(), "unlisted.md"), "Unlisted fixture topic.\n");
  await write(path.join(memory(), "nested", "MEMORY.md"), "- [Nested](topic.md)\n");
  await write(path.join(memory(), "nested", "topic.md"), "Nested fixture topic.\n");
  await write(path.join(memory(), "CLAUDE.md"), "Fixture instruction.\n");
  await write(path.join(memory(), "skills", "SKILL.md"), "Fixture skill.\n");
  const codex = path.join(roots.codexHomes[0], "memories");
  await write(path.join(codex, "memory_summary.md"), "v1\n## General Tips\n- Verify the fixture.\n  Include its follow-up line.\n- Keep fixture state private.\n");
  for (const file of ["MEMORY.md", "raw_memories.md", "recovery.md", "rollout_summaries/one.md"]) await write(path.join(codex, file), "- Historical fixture.\n");
  const linkedHome = path.join(root, "codex-linked"); await fs.mkdir(linkedHome); await fs.symlink(codex, path.join(linkedHome, "memories"));
  roots = { ...roots, codexHomes: [...roots.codexHomes, linkedHome] };
  const sourceFiles = ["MEMORY.md", "root.md", "unlisted.md", "nested/MEMORY.md", "nested/topic.md", "CLAUDE.md", "skills/SKILL.md"].map(file => path.join(memory(), file)).concat(["memory_summary.md", "MEMORY.md", "raw_memories.md", "recovery.md", "rollout_summaries/one.md"].map(file => path.join(codex, file)));
  const hashes = await Promise.all(sourceFiles.map(async file => sha(await fs.readFile(file))));
  const result = await run();
  const { candidates } = readImportCandidates("fixture-1");
  expect(candidates).toHaveLength(5);
  expect(candidates.filter(row => row.engine === "codex")).toHaveLength(2);
  expect(candidates.filter(row => row.engine === "codex").every(row => row.title === "General Tips" && row.loadedAtStart && row.suggestedScope === "machine")).toBe(true);
  expect(candidates.find(row => row.body === "Root fixture topic.\n")?.loadedAtStart).toBe(true);
  expect(candidates.filter(row => row.body === "Unlisted fixture topic.\n" || row.body === "Nested fixture topic.\n").every(row => !row.loadedAtStart)).toBe(true);
  expect(await Promise.all(sourceFiles.map(async file => sha(await fs.readFile(file))))).toEqual(hashes);
  const manifest = JSON.parse(await fs.readFile(path.join(result.backup, "manifest.json"), "utf8"));
  expect(manifest.files).toHaveLength(sourceFiles.length);
  for (const entry of manifest.files) expect(sha(await fs.readFile(path.join(result.backup, entry.copy)))).toBe(entry.sha256);
});

test("project aliases and asynchronous discovery resolve to one canonical applicability before deduplication", async () => {
  const body = "---\ntype: project\n---\nUse a fixture transaction for every fixture write.\n";
  await write(path.join(memory(), "topic.md"), body);
  await write(path.join(roots.claudeHomes[0], "projects", "old-project", "memory", "topic.md"), body);
  await write(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: { "old-project": "project-a" }, displayNames: {} }));
  await run("fixture-1", { projectForSlug: async slug => slug });
  const { candidates } = readImportCandidates("fixture-1");
  expect(candidates).toHaveLength(1);
  expect(candidates[0].occurrences).toHaveLength(2);
  expect(candidates[0].occurrences.every(row => row.project === "project-a")).toBe(true);
  expect(candidates[0].suggestedScope).toBe("project:project-a");
});

test("test and build callers cannot fall back to native engine homes", async () => {
  await write(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: "fixture-1", changedAt: at }));
  await expect(runMemoryImportWork({ importId: "fixture-1", previous: null, at })).rejects.toThrow("backup_refused");
  expect(readImportCandidates("fixture-1").candidates).toEqual([]);
  expect(readMemorySourceFile()).toBeNull();
});

test.each([null, { schemaVersion: 1 as const, source: "engines" as const, changedAt: at }])("a mismatched copy publishes no candidates and restores the exact prior choice: %j", async previous => {
  await write(path.join(memory(), "topic.md"), "Integrity fixture.\n");
  await write(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", importId: "fixture-1", changedAt: at }));
  await expect(runMemoryImportWork({ importId: "fixture-1", previous, roots, at }, { projectForSlug: slug => slug, afterCopy: async file => { await fs.writeFile(file, "Changed fixture copy.\n"); } })).rejects.toThrow("integrity");
  expect(readImportCandidates("fixture-1").candidates).toEqual([]);
  expect(readImportRecord("fixture-1")).toMatchObject({ state: "failed", reason: "integrity" });
  expect(readMemorySourceFile()).toEqual(previous);
  expect(await fs.readFile(path.join(memory(), "topic.md"), "utf8")).toBe("Integrity fixture.\n");
});

test("a changed source after copying refuses the import; a newer operator choice survives failure recovery", async () => {
  await write(path.join(memory(), "topic.md"), "Source fixture.\n");
  await expect(run("fixture-1", { afterCopy: async (_copy, source) => { await fs.writeFile(source, "New fixture version.\n"); } })).rejects.toThrow("integrity");
  expect(memorySource().choice).toBeNull();
  const newer = { schemaVersion: 1 as const, source: "engines" as const, changedAt: "2026-10-20T00:00:00.000Z" };
  await expect(run("fixture-2", { afterCopy: async () => { await write(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify(newer)); } })).rejects.toThrow("source_changed");
  expect(readMemorySourceFile()).toEqual(newer);
  expect(readImportCandidates("fixture-2").candidates).toEqual([]);
});

test("backup destinations within checkouts, including symlinked backup parents, are refused", async () => {
  const checkout = path.join(root, "checkout");
  await fs.mkdir(path.join(checkout, ".git"), { recursive: true });
  process.env.LLV_STATE_DIR = path.join(checkout, "state");
  await expect(run()).rejects.toThrow("backup_refused");
  expect(await fs.readdir(process.env.LLV_STATE_DIR!)).not.toContain("backups");
  process.env.LLV_STATE_DIR = path.join(root, "outside-state");
  await fs.mkdir(process.env.LLV_STATE_DIR!, { recursive: true });
  await fs.symlink(checkout, path.join(process.env.LLV_STATE_DIR!, "backups"));
  await expect(run()).rejects.toThrow("backup_refused");
});

test("an interrupted import directory is preserved, never reused or overwritten, and returns to the prior choice", async () => {
  await write(path.join(memory(), "topic.md"), "Restart fixture.\n");
  const backup = path.join(process.env.LLV_STATE_DIR!, "backups", "engine-memory", "fixture-1");
  await write(path.join(backup, "keep.fixture"), "Interrupted fixture data.");
  await expect(run()).rejects.toThrow("interrupted");
  expect(await fs.readFile(path.join(backup, "keep.fixture"), "utf8")).toBe("Interrupted fixture data.");
  expect(await fs.readdir(backup)).toEqual(["keep.fixture"]);
  expect(readImportRecord("fixture-1")).toMatchObject({ state: "failed", reason: "interrupted" });
  expect(readMemorySourceFile()).toBeNull();
});

test("the sixth backup removes only files named by the oldest manifest and keeps unlisted data", async () => {
  await write(path.join(memory(), "topic.md"), "Retention fixture.\n");
  const first = await run("fixture-1");
  const manifest = JSON.parse(await fs.readFile(path.join(first.backup, "manifest.json"), "utf8"));
  const sentinel = path.join(first.backup, "keep.fixture"); await fs.writeFile(sentinel, "Owned elsewhere.");
  for (let index = 2; index <= 6; index++) await run(`fixture-${index}`);
  expect(await fs.readFile(sentinel, "utf8")).toBe("Owned elsewhere.");
  for (const file of manifest.files) expect(await fs.stat(path.join(first.backup, file.copy)).catch(() => null)).toBeNull();
  expect(await fs.stat(path.join(first.backup, "manifest.json")).catch(() => null)).toBeNull();
  for (let index = 2; index <= 6; index++) expect(await fs.stat(path.join(path.dirname(first.backup), `fixture-${index}`, "manifest.json"))).toBeDefined();
});
