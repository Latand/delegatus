import { createHash } from "node:crypto";
import { proactiveActive } from "@/lib/monitor/autonomy";
import { canonicalProject, projectAliasKeys } from "@/lib/projects/aliases";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { waitForStateLock } from "@/lib/state/lockWait";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { proactiveAuthority, proactiveCandidateAuthority, proactiveCandidateDecision, type ProactiveAuthority } from "./proactive";
import { proactiveScopeHash } from "./proactiveScope";
import { TASKS_FILE, patchTaskCompanion, loadTasksByIds } from "./store";
import { findPipelineRecord } from "@/lib/pipelines/store";
import type { BoardTask } from "./types";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keyFor = (project: string) => digest(project);
const holdKey = (taskId: string) => digest(["scope-hold", taskId]);
type Reservation = {
  key: string; taskId: string; laneId: string; requestKey: string;
  scopeHash: string; scopeRevision: number; graph: string; reviewStage: string;
  review: "pending" | "pass" | "hold";
  reviewer?: { conversationId: string; attempt: number };
  released?: true;
};
function decode(value: unknown): Reservation | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Reservation;
  return [row.key, row.scopeHash, row.graph].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
    && [row.taskId, row.laneId, row.requestKey, row.reviewStage].every(v => typeof v === "string" && !!v && v.length <= 500)
    && Number.isSafeInteger(row.scopeRevision) && row.scopeRevision >= 0
    && ["pending", "pass", "hold"].includes(row.review) && (row.released === undefined || row.released === true)
    && (row.review === "pending" || row.reviewer !== undefined)
    && (row.reviewer === undefined || typeof row.reviewer.conversationId === "string" && !!row.reviewer.conversationId
      && Number.isSafeInteger(row.reviewer.attempt) && row.reviewer.attempt > 0) ? row : null;
}
const seed = { collection: "proactive_execution", schemaVersion: 1, migrationId: "proactive-execution-v1",
  key: (row: Reservation) => row.key, loadRecords: (): Reservation[] => [] };
function collection(file: string, create: boolean) {
  const database = legacyDatabasePath(file);
  if (!create && !stateCollectionsInitialized(database, [seed])) return null;
  if (create) initializeStateCollections(database, [seed]);
  return new SqliteStateCollection<Reservation>(database, { collection: seed.collection, schemaVersion: 1,
    key: seed.key, decode, clone: structuredClone, strictDecode: true, busyMessage: "proactive lane reservation is busy" });
}
function family(project: string) {
  const keys = projectAliasKeys(project);
  if (keys.length > 128) throw new Error("proactive project evidence exceeds its bound");
  return keys;
}
function rows(store: SqliteStateCollection<Reservation>, project: string, includeReleased = false) {
  return family(project).flatMap(key => { const row = store.get(keyFor(key)); return row && (includeReleased || !row.released) ? [row] : []; });
}

/** Includes edit history: restoring an older graph cannot revive its pass. */
export function proactiveGraphDigest(pipeline: Pipeline): string {
  return digest({ task: pipeline.task, spec: pipeline.spec ?? null, stages: pipeline.stages, edits: pipeline.graphEdits ?? [] });
}
export function proactiveScopeReview(stage: PipelineStage | undefined): boolean {
  return !!stage && stage.kind === "run" && stage.effectiveRole.roleId === "reviewer"
    && stage.effectiveRole.access === "read-only" && !(stage.outputs?.length);
}
export function proactiveTaskHasReservedLane(task: BoardTask, file = TASKS_FILE): boolean {
  const store = collection(file, false);
  try { return !!store && rows(store, task.project).some(row => row.taskId === task.id); }
  finally { store?.close(); }
}
export function proactiveAcceptedWorkWaiting(task: BoardTask, file = TASKS_FILE): boolean {
  if (task.status === "done" || task.assignments.some(row => row.state === "linked")) return false;
  if (task.proactive && !proactiveCandidateDecision(task, file).adopted) return false;
  if (task.hold) return ["resource", "limit", "worker"].includes(task.hold.kind);
  return task.status === "inbox" || task.status === "assigned";
}
export function proactiveLiveAuthorityError(task: BoardTask, file = TASKS_FILE, ports: ProactiveAuthority = proactiveAuthority): string | null {
  const context = proactiveCandidateAuthority(task, file);
  if (!context) return "proactive starts remain disabled without their original episode and seat";
  const project = canonicalProject(task.project);
  if (canonicalProject(context.project) !== project) return "proactive project authority changed";
  let settings = ports.settings(project);
  // A verified key succession preserves the original episode until the new
  // key has an explicit setting. An explicit off always takes precedence.
  if (settings.updatedAt === null && !settings.autonomy && context.project !== project) settings = ports.settings(context.project);
  if (!settings.enabled || !proactiveActive(settings.autonomy, ports.now()) || settings.autonomy?.startedAt !== context.startedAt) {
    return "proactive starts remain disabled: permission is inactive or the episode changed";
  }
  const seat = ports.seat(canonicalProject(task.project));
  return !seat || seat.conversationId !== context.conversationId || seat.epoch !== context.seatEpoch
    ? "proactive seat authority changed" : null;
}

/** One indexed row per project, under the task store's asynchronous transaction.
 * A failed creation keeps this recoverable reservation for the same request. */
export async function reserveProactiveLane(pipeline: Pipeline, requestKey: string, file = TASKS_FILE,
  ports: ProactiveAuthority = proactiveAuthority): Promise<void> {
  if (!loadTasksByIds(new Set(pipeline.taskIds), file).some(task => task.proactive && !proactiveCandidateDecision(task, file).adopted)) return;
  const store = await waitForStateLock("tasks.proactive.lane.initialize", () => collection(file, true)!, { waitMs: 5_000 });
  try {
    await patchTaskCompanion(store, (get, boardTasks) => {
      const tasks = pipeline.taskIds.map(id => get(id));
      if (tasks.some(task => !task)) throw new Error("proactive task evidence is missing");
      const invented = tasks.filter((task): task is BoardTask => !!task?.proactive && !proactiveCandidateDecision(task, file).adopted);
      if (!invented.length) return { records: [], result: undefined };
      if (invented.length !== 1) throw new Error("one proactive outcome per lane is required");
      const task = invented[0]!;
      if (store.get(holdKey(task.id))?.review === "hold") throw new Error("proactive scope review is held for the operator");
      if (canonicalProject(task.project) !== canonicalProject(pipeline.project)) throw new Error("proactive project mismatch");
      if (proactiveCandidateDecision(task, file).rejected) throw new Error("invented work was rejected by the operator");
      const authorityError = proactiveLiveAuthorityError(task, file, ports);
      if (authorityError) throw new Error(authorityError);
      if (task.proactive!.score.reduce((sum, value) => sum + value, 0) < 6 || task.proactive!.score[0]! < 1 || task.proactive!.score[2]! < 1) {
        throw new Error("proactive proposal requires operator adoption");
      }
      const first = pipeline.stages[0];
      if (!proactiveScopeReview(first)) throw new Error("proactive lane must begin with independent read-only scope review");
      if (first!.runtime === "codex-cloud") throw new Error("proactive scope review requires the local read-only runtime");
      const all = rows(store, task.project, true);
      const released = all.filter(row => {
        if (row.released) return true;
        const previous = get(row.taskId);
        if (previous && proactiveCandidateDecision(previous, file).adopted) return true;
        const lane = findPipelineRecord(row.laneId);
        const report = lane?.closeReport;
        if (lane?.runs.some(run => run.attempts.some(attempt => attempt.cloud
          && (attempt.cloud.submissionUnresolved || ["reserved", "submitting", "polling"].includes(attempt.cloud.phase))))) return false;
        return lane?.state === "closed" && lane.closeTeardown?.phase === "settled" && report?.status === "settled"
          && !report.pending.length && !report.pendingContinuations?.length && !report.stillRunning.length && !report.unconfirmed.length
          && lane.delivery?.operation?.state !== "running" && !(lane.delivery?.operation?.result && "uncertain" in lane.delivery.operation.result && lane.delivery.operation.result.uncertain);
      });
      const held = all.filter(row => !released.includes(row));
      if (held.some(row => row.taskId !== task.id || row.requestKey !== requestKey || row.laneId !== pipeline.id)) {
        throw new Error("proactive project lane is already reserved");
      }
      const graph = proactiveGraphDigest(pipeline);
      if (held.some(row => row.review === "hold" || row.graph !== graph || row.scopeRevision !== task.proactive!.scopeRevision
        || row.scopeHash !== proactiveScopeHash({ ...task, project: "" }))) throw new Error("proactive scope review requires operator recovery");
      // Indexed project reads share the existing 1,024-operation admission cap.
      const pendingAccepted = boardTasks(family(task.project)).some(row => row.id !== task.id && proactiveAcceptedWorkWaiting(row, file));
      if (pendingAccepted) throw new Error("accepted work has precedence over proactive work");
      pipeline.proactiveTaskIds = [task.id];
      return { records: held.length ? [] : [...released.filter(row => row.key !== keyFor(canonicalProject(task.project))).map(row => ({ ...row, released: true as const })),
        { key: keyFor(canonicalProject(task.project)), taskId: task.id, laneId: pipeline.id,
        requestKey, scopeHash: proactiveScopeHash({ ...task, project: "" }), scopeRevision: task.proactive!.scopeRevision,
        graph, reviewStage: first!.id, review: "pending" as const }], result: undefined };
    }, file);
  } finally { store.close(); }
}

/** The reviewer receives the exact evidence the grant will compare again at
 * settlement. This is local task data, never a repository artifact. */
export function proactiveScopeReviewEvidence(pipeline: Pipeline, stageId: string, file = TASKS_FILE): string {
  if (!pipeline.proactiveTaskIds?.length || pipeline.stages[0]?.id !== stageId) return "";
  const task = loadTasksByIds(new Set(pipeline.proactiveTaskIds), file)[0];
  if (!task?.proactive || proactiveCandidateDecision(task, file).adopted) return "";
  const error = proactiveLaneError(task, pipeline, stageId, "prepare", file);
  if (error) throw new Error(error);
  return JSON.stringify({ task: { text: task.text, details: task.details, steps: task.steps, attachments: task.attachments,
    scopeRevision: task.proactive.scopeRevision }, brief: { task: pipeline.task, spec: pipeline.spec },
    graph: pipeline.stages.map(stage => ({ id: stage.id, role: stage.role, runtime: stage.runtime,
      engine: stage.effectiveRole.engine, model: stage.effectiveRole.model, access: stage.effectiveRole.access,
      sandbox: stage.sandbox, outputs: stage.outputs, account: stage.account, prompt: stage.prompt,
      next: stage.next, onFail: stage.onFail })) });
}

export function proactiveLaneError(task: BoardTask, pipeline: Pipeline | undefined, stageId: string | undefined,
  phase: "prepare" | "dispatch" | "effect" | "settle", file = TASKS_FILE, ports: ProactiveAuthority = proactiveAuthority): string | null {
  const authorityError = proactiveLiveAuthorityError(task, file, ports);
  if (authorityError) return authorityError;
  if (!pipeline) return "proactive starts remain disabled outside their reserved scope-reviewed lane";
  const store = collection(file, false);
  try {
    const held = store && rows(store, task.project);
    if (store?.get(holdKey(task.id))?.review === "hold") return "proactive scope review is held for the operator";
    if (!held?.length || held.some(row => row.taskId !== task.id || row.laneId !== pipeline.id)) return "proactive lane reservation is not owned";
    if (held.some(row => row.scopeRevision !== task.proactive!.scopeRevision || row.scopeHash !== proactiveScopeHash({ ...task, project: "" })
      || row.graph !== proactiveGraphDigest(pipeline))) return "proactive frozen task, graph or brief changed";
    if (held.some(row => row.review === "hold")) return "proactive scope review is held for the operator";
    if (held.every(row => row.review === "pass")) return null;
    if (phase !== "effect" && held.every(row => row.reviewStage === stageId)
      && proactiveScopeReview(pipeline.stages.find(stage => stage.id === stageId))) return null;
    return "proactive implementation requires independent scope review";
  } finally { store?.close(); }
}

/** Written by controller settlement, never from submitted request fields. A
 * decision hold is irreversible under proactive authority, across all retries. */
export async function recordProactiveScopeReview(pipeline: Pipeline, stageId: string, attempt: number, conversationId: string | null,
  verdict: "pass" | "fail" | "needs_decision", file = TASKS_FILE): Promise<boolean> {
  if (!pipeline.proactiveTaskIds?.length) return false;
  const store = collection(file, false);
  if (!store) throw new Error("proactive lane reservation is missing");
  try {
    return await patchTaskCompanion(store, get => {
      const task = get(pipeline.proactiveTaskIds![0]!);
      if (!task?.proactive) throw new Error("proactive task is missing");
      if (proactiveCandidateDecision(task, file).adopted) return { records: [], result: false };
      const held = rows(store, task.project);
      if (!held.length || held.some(row => row.reviewStage !== stageId)) return { records: [], result: false };
      const error = proactiveLaneError(task, pipeline, stageId, "settle", file);
      if (error) throw new Error(error);
      if (!conversationId || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error("scope reviewer identity is missing");
      if (conversationId === pipeline.srcConversationId) throw new Error("scope reviewer must be independent of the creator");
      const records = held.map(row => ({ ...row, review: verdict === "pass" ? "pass" as const : verdict === "needs_decision" ? "hold" as const : "pending" as const,
        reviewer: { conversationId, attempt } }));
      if (verdict === "needs_decision") records.push({ ...records[0]!, key: holdKey(task.id) });
      return { records, result: true };
    }, file);
  } finally { store.close(); }
}
