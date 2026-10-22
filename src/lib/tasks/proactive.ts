import { createHash } from "node:crypto";
import { proactiveActive, type AutonomySetting } from "@/lib/monitor/autonomy";
import { effectiveSeatTickSettings, readSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { orchestratorSeatForCurrentProject } from "@/lib/orchestrator/seatProjectIdentity";
import { canonicalProject, projectAliasKeys } from "@/lib/projects/aliases";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import { createTask, type CreateTaskInput } from "./commands";
import { TASKS_FILE, patchTaskCompanion } from "./store";
import { proactiveScopeHash } from "./proactiveScope";
import type { BoardTask } from "./types";

const DAY = 86_400_000;
type Allowance = { key: string; kind: "allowance"; episode: string; used: number; admissions: number[] };
type Candidate = { key: string; kind: "candidate"; taskId: string; rejected: boolean };
type Row = Allowance | Candidate;
const seed = { collection: "proactive_allowance", schemaVersion: 1, migrationId: "proactive-allowance-v1", key: (row: Row) => row.key, loadRecords: (): Row[] => [] };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const allowanceKey = (project: string) => `allowance:${hash(project)}`;
const candidateKey = (project: string, candidate: string) => `candidate:${hash([project, candidate])}`;

function projectKeys(project: string): string[] {
  const keys = projectAliasKeys(project);
  if (keys.length > 128) throw new Error("proactive project alias evidence exceeds its bound; operator recovery required");
  return keys;
}

function allowanceRows(store: SqliteStateCollection<Row> | null, projects: string[]): Allowance[] {
  return projects.flatMap(project => {
    const row = store?.get(allowanceKey(project));
    if (row && row.kind !== "allowance") throw new Error("invalid proactive allowance");
    return row ? [row] : [];
  });
}

function usage(rows: Allowance[], episode: string, now: number) {
  return {
    episodeUsed: rows.reduce((sum, row) => sum + (row.episode === episode ? row.used : 0), 0),
    rollingUsed: rows.reduce((sum, row) => sum + row.admissions.filter(at => at > now - DAY).length, 0),
  };
}

function decode(value: unknown): Row | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Row;
  if (typeof row.key !== "string") return null;
  if (row.kind === "candidate") return typeof row.taskId === "string" && typeof row.rejected === "boolean" ? row : null;
  return row.kind === "allowance" && typeof row.episode === "string" && Number.isFinite(Date.parse(row.episode))
    && Number.isInteger(row.used) && row.used >= 0 && row.used <= 2
    && Array.isArray(row.admissions) && row.admissions.length <= 2 && row.admissions.every(Number.isFinite) ? row : null;
}

/** No process cache: indexed reads retain receipts under predecessor keys. */
function collection(file: string, create: boolean): SqliteStateCollection<Row> | null {
  const database = legacyDatabasePath(file);
  if (!create && !stateCollectionsInitialized(database, [seed])) return null;
  if (create) initializeStateCollections(database, [seed]);
  return new SqliteStateCollection<Row>(database, { collection: seed.collection, schemaVersion: 1,
    key: seed.key, decode, clone: structuredClone, strictDecode: true, busyMessage: "proactive allowance is busy" });
}

export function readProactiveAllowance(project: string, episode: string, now: number, file = TASKS_FILE) {
  const store = collection(file, false);
  try {
    return usage(allowanceRows(store, projectKeys(project)), episode, now);
  } finally { store?.close(); }
}

export interface ProactiveContext { project: string; startedAt: string; conversationId: string; seatEpoch: number }
interface Authority {
  now: () => number;
  settings: (project: string) => { enabled: boolean; autonomy?: AutonomySetting | null };
  seat: (project: string) => { conversationId: string | null; epoch: number } | null;
}
const authority: Authority = {
  now: Date.now,
  settings: project => effectiveSeatTickSettings(readSeatTickSettings(project), Date.now(), 3_600_000),
  seat: project => { const seat = orchestratorSeatForCurrentProject(project).active; return seat ? { conversationId: seat.conversationId, epoch: seat.seatEpoch } : null; },
};

function validate(input: CreateTaskInput & { candidateKey: string; sources: string[]; score: number[] }) {
  if (typeof input.candidateKey !== "string" || !input.candidateKey.trim() || input.candidateKey.length > 200) throw new Error("candidate key must contain 1–200 characters");
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 5 || input.sources.some(source => typeof source !== "string" || !source.trim() || source.length > 500)) throw new Error("one to five bounded source references are required");
  if (!Array.isArray(input.score) || input.score.length !== 4 || input.score.some(score => !Number.isInteger(score) || score < 0 || score > 2)) throw new Error("four scores from zero to two are required");
  if (input.findingKey !== undefined) throw new Error("an invented candidate cannot also be an observed finding");
}

/** Internal preparation only. Starts remain disabled until dispatch/effect
 * fencing and independent scope review are connected. No HTTP/MCP entry yet. */
export async function admitProactiveTask(input: CreateTaskInput & { candidateKey: string; sources: string[]; score: number[] },
  context: ProactiveContext, file = TASKS_FILE, ports: Authority = authority): Promise<{ task: BoardTask; replay: boolean }> {
  validate(input);
  input = structuredClone(input);
  context = { ...context };
  const store = await waitForStateLock("tasks.proactive.initialize", () => collection(file, true)!, { waitMs: 5_000, subject: "proactive allowance" });
  try {
    return await patchTaskCompanion<Row, { task: BoardTask; replay: boolean }>(store, (get, boardTasks) => {
      const projects = projectKeys(context.project);
      const project = projects[0]!;
      if (canonicalProject(String(input.project)) !== project) throw new Error("proactive project mismatch");
      const key = candidateKey(project, input.candidateKey);
      const receipts = projects.flatMap(identity => {
        const row = store.get(candidateKey(identity, input.candidateKey));
        if (row && row.kind !== "candidate") throw new Error("invalid candidate receipt");
        return row ? [row] : [];
      });
      if (receipts.some(row => row.rejected)) throw new Error("candidate was rejected by the operator");
      const previous = receipts[0];
      if (previous) {
        const task = get(previous.taskId);
        if (!task || task.project !== project || task.proactive?.candidateKey !== input.candidateKey) throw new Error("candidate receipt has no matching task; operator recovery required");
        return { records: [], result: { task, replay: true } };
      }
      // Read live authority after every admission wait, under the commit boundary.
      const now = ports.now();
      const settings = ports.settings(project);
      if (!settings.enabled || !proactiveActive(settings.autonomy, now) || settings.autonomy?.startedAt !== context.startedAt) throw new Error("proactive permission is inactive or the episode changed");
      const seat = ports.seat(project);
      if (!seat || seat.conversationId !== context.conversationId || seat.epoch !== context.seatEpoch) throw new Error("proactive seat authority changed");
      const rows = allowanceRows(store, projects);
      const total = usage(rows, context.startedAt, now);
      const held = rows.find(row => row.key === allowanceKey(project));
      const admissions = (held?.admissions ?? []).filter(at => at > now - DAY);
      const used = held?.episode === context.startedAt ? held.used : 0;
      if (total.episodeUsed >= 2) throw new Error("proactive episode allowance exhausted");
      if (total.rollingUsed >= 2) throw new Error("proactive rolling 24-hour allowance exhausted");
      const result = createTask(boardTasks(projects), { ...input, project, placement: "unplaced", board: "shown", clientRequestId: undefined }, [], { now: () => new Date(now).toISOString(), explicit: true, actor: "agent" });
      if (!result.ok) throw new Error(result.error);
      const task = result.task;
      task.proactive = { episode: context.startedAt, candidateKey: input.candidateKey, sources: [...input.sources], score: [...input.score], scopeHash: proactiveScopeHash(task), scopeRevision: 0 };
      return { task, records: [{ key, kind: "candidate", taskId: task.id, rejected: false },
        { key: allowanceKey(project), kind: "allowance", episode: context.startedAt, used: used + 1, admissions: [...admissions, now] }], result: { task, replay: false } };
    }, file);
  } finally { store.close(); }
}

/** Internal transition; operator-attributed transports belong to slice 3. */
export async function rejectProactiveCandidate(project: string, candidate: string, file = TASKS_FILE): Promise<void> {
  const store = collection(file, false);
  if (!store) throw new Error("candidate not found");
  try {
    await store.boundedPatchAsync(256, tx => {
      const rows = projectKeys(project).flatMap(identity => {
        const row = tx.get(candidateKey(identity, candidate));
        if (row && row.kind !== "candidate") throw new Error("invalid candidate receipt");
        return row ? [row] : [];
      });
      if (!rows.length) throw new Error("candidate not found");
      for (const row of rows) tx.put({ ...row, rejected: true });
    }, 5_000);
  } finally { store.close(); }
}
