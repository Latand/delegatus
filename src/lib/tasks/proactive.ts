import { createHash } from "node:crypto";
import { proactiveActive, type AutonomySetting } from "@/lib/monitor/autonomy";
import { effectiveSeatTickSettings, readSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { orchestratorSeatForCurrentProject } from "@/lib/orchestrator/seatProjectIdentity";
import { canonicalProject, projectAliasKeys } from "@/lib/projects/aliases";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { initializeStateCollections, readStateCollectionRevision, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import { createTask, type CreateTaskInput } from "./commands";
import { TASKS_FILE, patchTaskCompanion } from "./store";
import { proactiveScopeHash } from "./proactiveScope";
import type { BoardTask } from "./types";

const DAY = 86_400_000;
type Allowance = { key: string; kind: "allowance"; episode: string; used: number; admissions: number[] };
type Candidate = { key: string; kind: "candidate"; taskId: string; rejected: boolean; decisionRevision?: number; adopted?: { at: string; taskId: string } };
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
  if (row.kind === "candidate") return typeof row.taskId === "string" && typeof row.rejected === "boolean"
    && (row.decisionRevision === undefined || Number.isSafeInteger(row.decisionRevision) && row.decisionRevision >= 0)
    && (row.adopted === undefined || (row.adopted !== null && typeof row.adopted === "object"
      && row.adopted.taskId === row.taskId && typeof row.adopted.at === "string" && Number.isFinite(Date.parse(row.adopted.at)))) ? row : null;
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

/** Candidate-key rejection shares the operator command's decision revision. */
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
      const revision = nextDecisionRevision(rows);
      for (const row of rows) tx.put({ ...row, rejected: true, adopted: undefined, decisionRevision: revision });
    }, 5_000);
  } finally { store.close(); }
}

function nextDecisionRevision(rows: readonly Candidate[]): number {
  const revision = Math.max(0, ...rows.map(row => row.decisionRevision ?? 0));
  if (revision === Number.MAX_SAFE_INTEGER) throw new Error("proactive decision revision exhausted; operator recovery required");
  return revision + 1;
}

function readDecision(task: BoardTask, file: string): { rejected: boolean; adopted: boolean; revision: number } {
  if (!task.proactive) return { rejected: false, adopted: false, revision: 0 };
  const store = collection(file, false);
  try {
    const rows = projectKeys(task.project).flatMap(project => {
      const row = store?.get(candidateKey(project, task.proactive!.candidateKey));
      if (row && row.kind !== "candidate") throw new Error("invalid candidate receipt");
      return row ? [row] : [];
    });
    if (!rows.length || rows.some(row => row.taskId !== task.id)) throw new Error("candidate receipt has no matching task; operator recovery required");
    return { rejected: rows.some(row => row.rejected), adopted: rows.every(row => row.adopted?.taskId === task.id),
      revision: Math.max(0, ...rows.map(row => row.decisionRevision ?? 0)) };
  } finally { store?.close(); }
}

/** Indexed, durable decisions; ordinary task writes cannot manufacture adoption. */
export function proactiveCandidateDecision(task: BoardTask, file = TASKS_FILE): { rejected: boolean; adopted: boolean } {
  const { rejected, adopted } = readDecision(task, file);
  return { rejected, adopted };
}

export interface ProactiveDecisionToken { taskId: string; decisionRevision: number; scopeRevision: number; scopeHash: string }

export function validProactiveDecisionToken(value: unknown): value is ProactiveDecisionToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as ProactiveDecisionToken;
  return typeof token.taskId === "string" && token.taskId.length > 0 && token.taskId.length <= 200
    && Number.isSafeInteger(token.decisionRevision) && token.decisionRevision >= 0
    && Number.isSafeInteger(token.scopeRevision) && token.scopeRevision >= 0
    && typeof token.scopeHash === "string" && /^[a-f0-9]{64}$/.test(token.scopeHash);
}

/** A read grants no authority. Adoption compares this entire tuple again
 * under the task/decision transaction, after all admission waits. */
export function proactiveDecisionToken(task: BoardTask, file = TASKS_FILE): ProactiveDecisionToken {
  return proactiveDecisionSnapshot(task, file).expected;
}

/** The displayed decision and its revision belong to one observation. A
 * concurrent family write holds the response for a fresh read. */
export function proactiveDecisionSnapshot(task: BoardTask, file = TASKS_FILE): {
  decision: { rejected: boolean; adopted: boolean }; expected: ProactiveDecisionToken;
} {
  if (!task.proactive) throw new Error("invented task not found");
  const database = legacyDatabasePath(file);
  const before = readStateCollectionRevision(database, seed.collection);
  const { rejected, adopted, revision } = readDecision(task, file);
  if (readStateCollectionRevision(database, seed.collection) !== before) throw new Error("proactive decision changed while reading; reload before deciding");
  return { decision: { rejected, adopted }, expected: { taskId: task.id, decisionRevision: revision,
    scopeRevision: task.proactive.scopeRevision, scopeHash: proactiveScopeHash(task) } };
}

/** Caller identity is supplied by the authenticated transport, never its body.
 * Adoption changes authority only; artifacts, rejection history and counts stay.
 * Rejection revokes adoption but never removes the retained task or its work. */
export async function decideProactiveTask(taskId: string, decision: "reject" | "adopt", actor: "operator" | "agent",
  expected: ProactiveDecisionToken, file = TASKS_FILE, now: () => string = () => new Date().toISOString()): Promise<BoardTask> {
  if (actor !== "operator") throw new Error("only the operator may reject or adopt invented work");
  if (decision !== "reject" && decision !== "adopt") throw new Error("invalid proactive decision");
  if (!validProactiveDecisionToken(expected)) throw new Error("expected task scope and decision revision are required");
  expected = { ...expected };
  const store = collection(file, false);
  if (!store) throw new Error("candidate not found");
  try {
    return await patchTaskCompanion<Row, BoardTask>(store, get => {
      const task = get(taskId);
      if (!task?.proactive) throw new Error("invented task not found");
      const rows = projectKeys(task.project).flatMap(project => {
        const row = store.get(candidateKey(project, task.proactive!.candidateKey));
        if (row && (row.kind !== "candidate" || row.taskId !== task.id)) throw new Error("candidate receipt has no matching task");
        return row ? [row] : [];
      });
      if (!rows.length) throw new Error("candidate not found");
      const revision = nextDecisionRevision(rows);
      if (expected.taskId !== task.id || expected.decisionRevision !== revision - 1) throw new Error("proactive decision changed; reload before deciding");
      if (decision === "adopt" && (expected.scopeRevision !== task.proactive.scopeRevision || expected.scopeHash !== proactiveScopeHash(task))) {
        throw new Error("invented task scope changed; reload before adopting");
      }
      const at = decision === "adopt" ? now() : null;
      if (at !== null && !Number.isFinite(Date.parse(at))) throw new Error("invalid proactive decision time");
      const records = rows.map(row => ({ ...row, rejected: decision === "reject" || row.rejected,
        decisionRevision: revision, adopted: at ? { at, taskId } : undefined }));
      return { records, result: task };
    }, file);
  } finally { store.close(); }
}
