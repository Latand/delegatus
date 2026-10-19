/** Generated state history for RG2. No installation state is an input. */
import path from "node:path";
import fs from "node:fs";
import type { RoleMemoryRow, RoleMemoryScopeRow } from "@/lib/memory/roleTypes";
import type { CuratorPass } from "@/lib/memory/curation/store";

export const CANDIDATE_HISTORY_PROJECT = "candidate-generated-history";
export const CANDIDATE_HISTORY_SCOPE = `role:${CANDIDATE_HISTORY_PROJECT}:builder`;
export const CANDIDATE_HISTORY_PASS = `curate_${"0".repeat(23)}1`;
const AT = "2026-10-01T00:00:00.000Z";
const counts = { calls: 1, changed: 1, rewritten: 1, merged: 0, moved: 0, split: 0, archived: 0, restored: 0 };
export interface StateHistoryCensus {
  hotPipelines: number; hotBytes: number; hotMaxBytes: number;
  archivedPipelines: number; archiveBytes: number; archiveMaxBytes: number;
  tasks: number; taskBytes: number; memoryRows: number; memoryBytes: number;
  scopes: number; historyBytes: number; memoryMaxBytes: number; curatorPasses: number;
}

/** Match serialized byte sizes, including a single large retained record. */
function sized<T extends object>(row: T, field: keyof T, bytes: number): T {
  const empty = { ...row, [field]: "" };
  return { ...empty, [field]: "Generated fixture. ".repeat(Math.ceil(bytes / 19)).slice(0, Math.max(0, bytes - Buffer.byteLength(JSON.stringify(empty)))) };
}

export async function buildCandidateStateDataset(directory: string): Promise<StateHistoryCensus> {
  if (fs.existsSync(path.join(directory, "state.sqlite"))) throw new Error("generated state requires a fresh directory");
  const { buildPipeline, PIPELINES_SCHEMA_VERSION } = await import("@/lib/pipelines/store");
  const { initializeStateCollections } = await import("@/lib/state/sqliteStateStore");
  const pipelineRows = (count: number, bytes: number, largest: number, archived: boolean) => {
    const common = Math.floor((bytes - largest) / (count - 1));
    return Array.from({ length: count }, (_, i) => {
      const row = buildPipeline({ id: `generated-${archived ? "archive" : "hot"}-${i}`, task: "Generated retained pipeline", project: CANDIDATE_HISTORY_PROJECT,
        repoDir: "/repo/generated", stages: [], srcPath: null, srcConversationId: null, now: AT, state: "draft" });
      if (archived) { row.state = "closed"; row.closedAt = AT; row.hiddenAt = AT; }
      return sized({ ...row, spec: "" }, "spec", i === 0 ? largest : common);
    });
  };
  const hot = pipelineRows(270, 34_000_000, 515_000, false);
  const archive = pipelineRows(950, 111_000_000, 1_100_000, true);
  const tasks = Array.from({ length: 2450 }, (_, i) => sized({ id: `generated-task-${i}`, project: CANDIDATE_HISTORY_PROJECT,
    status: "done", doneAt: AT, text: "Generated retained task", details: "", placement: "unplaced", assignments: [], board: "hidden", createdAt: AT, updatedAt: AT }, "details", 4000));
  const memory: RoleMemoryRow[] = [];
  const passes: CuratorPass[] = Array.from({ length: 50 }, (_, i) => ({
    kind: "pass", id: `curate_${(i + 1).toString(16).padStart(24, "0")}`, project: CANDIDATE_HISTORY_PROJECT, repoDir: null,
    scopes: [CANDIDATE_HISTORY_SCOPE], clientAttemptId: `generated-pass-${i}`, conversationId: null, launchId: null,
    transcriptPath: null, launchedAt: null, claimedAt: new Date(Date.parse(AT) + i * 1000).toISOString(), endedAt: AT, state: "succeeded", failure: null, counts,
  }));
  for (let i = 0; i < 100; i++) {
    const scope = i === 0 ? CANDIDATE_HISTORY_SCOPE : `role:${CANDIDATE_HISTORY_PROJECT}:generated-${i}`;
    const active: string[] = [];
    for (let j = 0; j < 38; j++) {
      const id = `r_${(i * 38 + j + 1).toString(16).padStart(16, "0")}`;
      active.push(id);
      memory.push(sized({ kind: "rule", id, scope, rule: "Read the generated fixture before recording its result.", why: "Retained history exercises the production readers.",
        state: "active", hints: [], source: { project: CANDIDATE_HISTORY_PROJECT, pipelineId: "generated-hot-0", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "generated-conversation" }, createdAt: AT, changedAt: AT, note: "" } as RoleMemoryRow & { note: string }, "note", 890));
    }
    const history: RoleMemoryScopeRow["history"] = [];
    const target = i === 0 ? 2_900_000 : Math.floor((12_600_000 - 2_900_000) / 99);
    let bytes = 2;
    while (bytes < target) {
      const entry = { revision: history.length + 1, at: new Date(Date.parse(AT) + history.length * 1000).toISOString(), by: "curator" as const,
        pass: passes[history.length % passes.length]!.id, counts, before: active, added: [], merged: [], archived: [] };
      bytes += Buffer.byteLength(JSON.stringify(entry)) + (history.length ? 1 : 0);
      history.push(entry);
    }
    memory.push({ kind: "scope", scope, revision: history.length, active, history });
  }
  const filename = path.join(directory, "state.sqlite");
  const seed = <T>(collection: string, migrationId: string, rows: T[], key: (row: T) => string, schemaVersion = 1) =>
    initializeStateCollections(filename, [{ collection, migrationId, schemaVersion, key, loadRecords: () => rows,
      controllerActive: () => collection === "pipelines" }]);
  seed("pipelines", "pipelines-json-v1", hot, row => row.id, PIPELINES_SCHEMA_VERSION);
  seed("pipelines_archive", "pipelines-archive-json-v1", archive, row => row.id, PIPELINES_SCHEMA_VERSION);
  const tasksFile = path.join(directory, "tasks.json");
  fs.writeFileSync(tasksFile, JSON.stringify({ version: 1, tasks }));
  const { importLegacyTasks } = await import("@/lib/tasks/store");
  importLegacyTasks(tasksFile, { reconcile: false });
  seed("role_memory", "role-memory-v1", memory, row => row.kind === "rule" ? `r:${row.id}` : row.kind === "scope" ? `s:${row.scope}` : "unused");
  const curation = [...passes, { kind: "project", project: CANDIDATE_HISTORY_PROJECT, current: null, lastClaimAt: AT, lastAt: AT, passes: passes.map(p => p.id) }];
  seed("role_memory_curation", "role-memory-curation-v1", curation, row => row.kind === "pass" ? `r:${(row as CuratorPass).id}` : `p:${CANDIDATE_HISTORY_PROJECT}`);
  const size = (row: unknown) => Buffer.byteLength(JSON.stringify(row));
  const sum = (rows: unknown[]) => rows.reduce<number>((n, row) => n + size(row), 0);
  return { hotPipelines: hot.length, hotBytes: sum(hot), hotMaxBytes: Math.max(...hot.map(size)), archivedPipelines: archive.length, archiveBytes: sum(archive), archiveMaxBytes: Math.max(...archive.map(size)),
    tasks: tasks.length, taskBytes: sum(tasks), memoryRows: memory.length, memoryBytes: sum(memory), scopes: 100,
    historyBytes: memory.reduce((n, row) => n + (row.kind === "scope" ? size(row.history) : 0), 0), memoryMaxBytes: Math.max(...memory.map(size)), curatorPasses: passes.length };
}
