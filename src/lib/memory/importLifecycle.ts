import { agentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { processIdentityStatus } from "@/lib/processIdentity";
import { readMemorySourceFile, advanceMemorySource } from "./source";
import { readImportCandidates, readImportRecord, writeImportRows } from "./importStore";
import type { ImportCandidate, ImportRecord, ImportRequest } from "./importTypes";
import { runMemoryImportWork, validateMemoryImportEnvironment, defaultImportRoots, type ImportWorkPorts } from "./importWork";
import { candidateState, importMemoryRevision } from "./importCuration";
import { roleMemoryCollection, roleScope } from "./roleStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import { canonicalProject } from "@/lib/projects/aliases";

export function legacyMemoryGenerations(snapshot: Pick<RegistryFile, "conversations" | "entries">, flippedAt: string): string[] {
  const result = new Set<string>();
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.engine !== "claude") continue;
    for (const generation of conversation.generations) {
      if (generation.archivedAt || generation.launchProfile.cleanMemory || generation.createdAt >= flippedAt) continue;
      const entry = snapshot.entries[`claude:${generation.id}`];
      if (!entry || entry.artifactPath !== generation.path) continue;
      const process = entry.structuredHost?.process ?? entry.host?.agent;
      if (process && processIdentityStatus(process) !== "dead") result.add(generation.id);
    }
  }
  return [...result].sort();
}
export function importTrialExcludes(record: Pick<ImportRecord, "legacyGenerations">, generationIds: readonly string[]): boolean {
  return generationIds.some(id => record.legacyGenerations?.includes(id));
}
async function candidates(id: string) {
  const rows: ImportCandidate[] = [];
  let cursor: string | null = "";
  do {
    const page = readImportCandidates(id, cursor, 40);
    rows.push(...page.candidates); cursor = page.cursor;
    // This worker never lends its caller a serving-loop synchronous history walk.
    await new Promise<void>(resolve => setImmediate(resolve));
  } while (cursor);
  return rows;
}
function owns(id: string) {
  const source = readMemorySourceFile();
  if (source?.source !== "delegatus" || source.importId !== id) throw Error("memory import source changed");
  return source;
}
export type ImportLifecyclePorts = ImportWorkPorts & {
  legacy?: (flippedAt: string) => Promise<string[]>;
  /** Runs after a real scan committed the manifest and candidates. */
  afterScan?: () => Promise<void>;
};
async function raiseBudgetTriggers(record: ImportRecord, rows: readonly ImportCandidate[]) {
  const projects = [...new Set(rows.flatMap(row => row.occurrences.flatMap(o => o.project ? [canonicalProject(o.project)] : [])))];
  for (const project of projects) {
    if (record.raisedOrchestratorProjects?.some(key => canonicalProject(key) === project)) continue;
    const own = rows.filter(row => row.loadedAtStart && row.occurrences.some(o => o.project && canonicalProject(o.project) === project));
    if (own.some(row => candidateState(row).state === "pending")) continue;
    if (!own.some(row => row.dispositions.some(d => d.forRoom && row.occurrences.some(o => d.occurrences.includes(o.id) && o.writer.kind === "seat")))) continue;
    await waitForStateLock("memory.import.budget", () => {
      owns(record.id);
      const collection = roleMemoryCollection(true)!;
      collection.boundedPatch(4, tx => {
        const scope = roleScope(project, "orchestrator"), held = tx.get(`s:${scope}`);
        tx.put({ ...(held?.kind === "scope" ? held : { kind: "scope" as const, scope, active: [], history: [], revision: 0 }), fourScopeTarget: 24_000 });
      });
    });
    record.raisedOrchestratorProjects = [...record.raisedOrchestratorProjects ?? [], project];
  }
}
/** Runs only in the leased helper. No native store is read by a request. A
 * stopped helper restarts from the durable source, manifest and pass receipts. */
export async function advanceMemoryImportWork(request: ImportRequest, ports: ImportLifecyclePorts = {}): Promise<ImportRecord> {
  const source = owns(request.importId);
  const at = new Date(request.at ?? Date.now()).toISOString();
  let record = readImportRecord(request.importId);

  if (record?.state !== "ready") record = await runMemoryImportWork({ ...request, roots: request.roots ?? record?.roots }, ports);
  const roots = request.roots ?? record.roots ?? await defaultImportRoots();
  owns(record.id);
  record.roots ??= roots;
  // The import record itself is stored in importCollection and changes during
  // this boundary. Candidate disposition and Undo authority live in the role
  // memory and curation revisions returned by importMemoryRevision.
  const stamp = () => importMemoryRevision();
  const changed = record.curationDirty || !record.progress || record.observedMemoryRevision !== importMemoryRevision();
  if (changed) {
    await validateMemoryImportEnvironment(roots);
    owns(record.id);
    const before = stamp();
    const rows = await candidates(record.id);
    if (before !== stamp()) return record;
    if (source.phase !== "active") await raiseBudgetTriggers(record, rows);
    const states = rows.map(row => candidateState(row));
    const groups = new Map<string, { pending: boolean; adopted: boolean }>();
    rows.forEach((row, index) => {
      const group = groups.get(row.group) ?? { pending: false, adopted: false };
      group.pending ||= states[index].state === "pending";
      group.adopted ||= states[index].state === "adopted";
      groups.set(row.group, group);
    });
    const files = [...groups.values()];
    record.progress = { files: files.length, parts: rows.length, pendingFiles: files.filter(group => group.pending).length,
      pendingParts: states.filter(row => row.state === "pending").length,
      pendingLoadedParts: rows.filter((row, index) => row.loadedAtStart && states[index].state === "pending").length,
      adopted: files.filter(group => !group.pending && group.adopted).length,
      dropped: files.filter(group => !group.pending && !group.adopted).length };
    record.curationDirty = false;
    record.observedMemoryRevision = importMemoryRevision();
    const prepared = stamp();
    await writeImportRows([record], () => { owns(record!.id); if (prepared !== stamp()) throw Error("memory import observations changed; retry the advance"); });
  }
  if (source.phase === "active" || source.phase === "importing" && record.progress!.pendingLoadedParts > 0) return record;
  const expected = stamp();
  const legacy = ports.legacy ?? (async time => legacyMemoryGenerations(await agentRegistry().prepareReadOnlySnapshot(), time));
  if (owns(record.id).phase === "importing") {
    const generations = await legacy(at);
    owns(record.id);
    if (expected !== stamp()) return record;
    record = { ...record, flippedAt: at, legacyGenerations: generations, remainingGenerations: generations };
    // Persist the boundary and exclusions before turning off any new start.
    await writeImportRows([record], () => {
      owns(record!.id);
      if (expected !== stamp()) throw Error("memory import observations changed; retry the advance");
    });
    if (!await advanceMemorySource(record.id, "draining", request.at ? at : undefined, () => expected === stamp())) return record;
  }
  const flippedAt = owns(record.id).flippedAt!;
  const generations = await legacy(flippedAt);
  owns(record.id);
  const retired = record.remainingGenerations?.some(id => !generations.includes(id));
  const due = !record.lastScanAt || !generations.length || retired || Date.parse(at) - Date.parse(record.lastScanAt) >= 30 * 60_000;
  if (!due) return record;
  // Always scan the current roots, extending the very same verified backup.
  await runMemoryImportWork({ ...request, roots, rescan: true }, ports);
  await ports.afterScan?.();
  owns(record.id);
  const afterScan = await legacy(flippedAt);
  owns(record.id);
  record = { ...readImportRecord(record.id)!, flippedAt, legacyGenerations: [...new Set([...record.legacyGenerations ?? [], ...generations, ...afterScan])].sort(), remainingGenerations: afterScan, lastScanAt: at };
  await writeImportRows([record], () => owns(record!.id));
  // A writer that retired during the scan owes a fresh final scan on the next
  // advance. Its last write can have landed after this scan read that file.
  if (!generations.length && !afterScan.length) {
    record.drainedAt = request.at ? at : new Date().toISOString();
    await writeImportRows([record], () => owns(record!.id));
    await advanceMemorySource(record.id, "active", record.drainedAt);
  }
  return record;
}
