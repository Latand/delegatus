import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { writeImportRows } from "../importStore";
import type { ImportCandidate } from "../importTypes";
export const IMPORT_AT = "2026-10-19T00:00:00.000Z";
export const IMPORT_PROJECT = "import-fixture";
export const IMPORT_ID = "fixture-import";
export function importCandidate(index = 0, patch: Partial<ImportCandidate> = {}): ImportCandidate {
  const id = `c_${index.toString(16).padStart(16, "0")}`;
  return { kind: "candidate", id, group: id, importId: IMPORT_ID, engine: "claude", store: "claude_topic",
    part: { index: 0, of: 1, bytes: [0, 74] }, contentSha256: "a".repeat(64), linked: [],
    occurrences: [{ id: `o_${index.toString(16).padStart(16, "0")}`, file: `projects/fixture/memory/note-${index}.md`, sha256: "b".repeat(64), type: "feedback", writtenAt: IMPORT_AT, writer: { kind: "unknown", roleId: null }, project: IMPORT_PROJECT }],
    anchor: "topic", loadedAtStart: true, suggestedScope: `project:${IMPORT_PROJECT}`, body: "Inspect current process ownership before changing a running worker's state.", title: "Worker ownership", dispositions: [], ...patch };
}
export async function seedImport(candidates: ImportCandidate[], project = IMPORT_PROJECT) {
  fs.writeFileSync(statePath("memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", changedAt: IMPORT_AT, importStartedAt: IMPORT_AT, importId: IMPORT_ID }));
  await writeImportRows([{ kind: "import", id: IMPORT_ID, state: "ready", previous: null, at: IMPORT_AT,
    backup: statePath("backups/engine-memory/fixture-import"), hostProject: project, files: candidates.length, candidates: new Set(candidates.map(c => c.group)).size, parts: candidates.length }, ...candidates]);
}
