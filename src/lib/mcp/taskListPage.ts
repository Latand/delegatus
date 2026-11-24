import { createHash } from "node:crypto";
import type { SQLQueryBindings } from "bun:sqlite";
import { databaseFileIdentity, databaseSwapInProgress } from "@/lib/state/currentDatabase";
import { pipelineTaskMembershipReady } from "@/lib/state/pipelineEvidenceIndex";
import { sharedStateReadonlyDatabase } from "@/lib/state/sqliteStateStore";
import { taskListFields, taskListIndex, taskListIndexCurrent, taskListSeekSql } from "@/lib/state/taskListIndexes";
import { parseSqliteJson } from "@/lib/sqliteReadAttribution";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { taskPriority, type BoardTask } from "@/lib/tasks/types";
import { yieldToRuntime } from "@/lib/cooperative";
import type { BoardScope, Source } from "./boardSelection";
import { LIST_ANSWER_BYTES } from "./listAnswers";

const SCAN_LIMIT = 256;
const PARTITION_LIMIT = 32;
const LINK_LIMIT = 64;
const STATUSES = ["inbox", "assigned", "blocked", "done"];
const COUNTS = ["total", "remainingCount", "omittedCount"];
type Position = { id: string; time: string };
type Candidate = Position & { project: string; status: string };
type ReferenceTask = Pick<BoardTask, "id" | "project" | "text" | "workLinks">;
export type TaskReferenceMatcher = (task: ReferenceTask) => boolean | undefined;
type Metadata = { text?: string; placement?: string; priority?: string; workLinks?: string };
const compare = (a: Position, b: Position) => Buffer.compare(Buffer.from(b.time), Buffer.from(a.time))
  || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id));

function scopeKey(scope: BoardScope) {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 16);
}

export function deferredTaskPage() {
  return { rows: [], count: 0, hasMore: null, nextCursor: null, cursorReset: false, partial: true,
    omissions: ["taskPage", ...COUNTS], retryHint: "Retry the same filters without a cursor after the task index is available." };
}

function deferredDeadlineTaskPage(cursor?: string) {
  return { ...deferredTaskPage(), ...(cursor ? { hasMore: true, nextCursor: cursor } : {}),
    retryHint: "The task page time budget was exhausted; retry the same filters and cursor." };
}

/** Membership is maintained by the state store's fenced schema and triggers,
 * including writes that bypass the current process or change journal. */
export function taskListLinks(filename: string) {
  if (!databaseFileIdentity(filename) || databaseSwapInProgress(filename)) return undefined;
  const db = sharedStateReadonlyDatabase(filename);
  const names = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name GLOB 'pipeline_task_membership*'").all().map(row => row.name));
  if (!pipelineTaskMembershipReady(names)) return undefined;
  return (task: string) => {
    const rows = sharedStateReadonlyDatabase(filename).query<{ row_key: string }, [string, number]>(`
      SELECT row_key FROM pipeline_task_membership INDEXED BY pipeline_task_membership_lookup
      WHERE task_id=? AND collection='pipelines' ORDER BY row_key LIMIT ?`).all(task, LINK_LIMIT + 1);
    return rows.length > LINK_LIMIT ? undefined : rows.map(row => row.row_key);
  };
}

/** The PR matcher projects only lanes reached through the keyed membership. */
export function withTaskReferenceBudget<T>(filename: string, ids: readonly string[], read: (db: NonNullable<Source<T>["database"]>) => T): T | undefined {
  const db = sharedStateReadonlyDatabase(filename);
  return db.transaction(() => {
    const size = db.query<{ bytes: number }, string[]>(`SELECT sum(length(CAST(value_json AS BLOB))) AS bytes
      FROM state_rows WHERE collection='pipelines' AND row_key IN (${ids.map(() => "?").join(",")})`).get(...ids);
    if (!size || size.bytes > 2 * 1024 * 1024) return undefined;
    return read(db);
  })();
}

/** Each index seek is limited within a project/status partition, including at
 * deep cursors and ties. Merge only a bounded prefix, then check the other
 * filters. An empty sparse page can advance to the last inspected candidate. */
export async function indexedTaskPage<Row>(
  source: Source<BoardTask>, scope: BoardScope, cursor: unknown, limit: number,
  project: (task: BoardTask) => Row,
  { checkpoint, deadline, matchesReference, signal, now = () => performance.now() }: { checkpoint: () => void; deadline: number; matchesReference?: TaskReferenceMatcher; signal?: AbortSignal; now?: () => number },
) {
  const hash = scopeKey(scope);
  let boundary: Position | undefined, cursorReset = false;
  if (cursor) try {
    const decoded = JSON.parse(Buffer.from(String(cursor).slice(0, 2048), "base64url").toString());
    if (decoded.scope !== hash || typeof decoded.id !== "string" || typeof decoded.time !== "string") throw Error("cursor scope");
    boundary = decoded;
  } catch { cursorReset = true; }
  if (scope.ids.length > SCAN_LIMIT) return { ...deferredTaskPage(), retryHint: "Request at most 256 task ids at a time." };
  const identity = databaseFileIdentity(source.filename);
  const expired = () => now() >= deadline;
  const statuses = (scope.statuses?.length ? scope.statuses : STATUSES).filter(status => !scope.openOnly || status !== "done");
  const projects = scope.project
    ? [scope.project, ...Object.keys(projectAliasSnapshot().aliases).filter(key => key !== scope.project && canonicalProject(key) === scope.project)]
    : [""];
  if (!scope.ids.length && projects.length * statuses.length > PARTITION_LIMIT) {
    return { ...deferredTaskPage(), retryHint: "Narrow the status filter or request task ids." };
  }

  const matchesText = (task: ReferenceTask) => matchesReference ? matchesReference(task)
    : !scope.query || task.text.toLowerCase().includes(scope.query);
  const matchesTask = (task: BoardTask) => (!scope.project || canonicalProject(task.project) === scope.project)
    && statuses.includes(task.status) && (!scope.placement || task.placement === scope.placement)
    && (!scope.priorities?.length || scope.priorities.includes(taskPriority(task)))
    && task.updatedAt >= scope.updatedSince && matchesText(task);

  let started = now();
  const pause = async () => {
    if (now() - started < 8) return;
    await yieldToRuntime(signal);
    checkpoint();
    started = now();
  };
  const { project: storedProject, status, time } = taskListFields;
  const scan = async (after: Position | undefined) => {
    const found = new Map<string, Candidate>();
    for (const key of projects) for (const state of statuses) {
      if (expired()) return null;
      const db = sharedStateReadonlyDatabase(source.filename);
      const seek = (phase: "head" | "tied" | "older", bindings: SQLQueryBindings[], cap: number) =>
        db.query<Candidate, SQLQueryBindings[]>(taskListSeekSql(!!key, phase)).all(...(key ? [key, state] : [state]), ...bindings, cap);
      // Separate seeks keep the id constraint indexed when thousands of rows
      // share the same timestamp as the cursor.
      const sameTime = after && after.time >= scope.updatedSince
        ? seek("tied", [after.time, after.id], SCAN_LIMIT + 1) : [];
      const older = after && sameTime.length <= SCAN_LIMIT
        ? seek("older", [after.time, scope.updatedSince], SCAN_LIMIT + 1 - sameTime.length)
        : after ? [] : seek("head", [scope.updatedSince], SCAN_LIMIT + 1);
      for (const row of [...sameTime, ...older]) {
        const previous = found.get(row.id);
        if (!previous || compare(row, previous) < 0) found.set(row.id, row);
      }
      if (expired()) return null;
      await pause();
    }
    const ordered = [...found.values()].sort(compare);
    return { candidates: ordered.slice(0, SCAN_LIMIT), complete: ordered.length <= SCAN_LIMIT };
  };

  const hasMetadataFilters = Boolean(scope.placement || scope.priorities?.length || scope.query);
  const matchCandidate = (candidate: Candidate) => {
    if (!hasMetadataFilters) return true;
    const db = sharedStateReadonlyDatabase(source.filename);
    const row = db.query<Metadata, [string, string, string, string]>(`
      SELECT ${scope.placement ? "CASE WHEN COALESCE(json_extract(value_json,'$.placement'),'pinned')='pinned' AND json_type(value_json,'$.pos.x') IN ('real','integer') AND json_type(value_json,'$.pos.y') IN ('real','integer') THEN 'pinned' ELSE 'unplaced' END" : "NULL"} AS placement,
        ${scope.priorities?.length ? "json_extract(value_json,'$.priority')" : "NULL"} AS priority,
        ${scope.query ? "json_extract(value_json,'$.text')" : "NULL"} AS text,
        ${matchesReference ? "json_extract(value_json,'$.workLinks')" : "NULL"} AS workLinks
      FROM state_rows WHERE collection='tasks' AND row_key=? AND ${time}=? AND ${storedProject}=? AND ${status}=?
    `).get("t:" + candidate.id, candidate.time, candidate.project, candidate.status);
    return !!row && (!scope.placement || row.placement === scope.placement)
      && (!scope.priorities?.length || scope.priorities.includes(taskPriority(row)))
      && matchesText({ id: candidate.id, project: candidate.project, text: typeof row.text === "string" ? row.text : "",
        ...(row.workLinks ? { workLinks: parseSqliteJson(row.workLinks, db) } : {}) });
  };

  const keyed = new Map<string, BoardTask>();
  let referenceDeferred = false;
  let scanned;
  if (scope.ids.length) {
    for (const id of scope.ids) {
      if (expired()) return deferredDeadlineTaskPage(boundary && typeof cursor === "string" ? cursor : undefined);
      const task = source.read(id);
      const matches = task ? matchesTask(task) : false;
      if (matches === undefined) referenceDeferred = true;
      if (task && matches) keyed.set(id, task);
      await pause();
    }
    scanned = { candidates: [...keyed.values()].map(task => ({ id: task.id, time: task.updatedAt, project: task.project, status: task.status })).sort(compare)
      .filter(row => !boundary || compare(row, boundary) > 0), complete: true };
  } else {
    if (!identity || databaseSwapInProgress(source.filename)) return deferredTaskPage();
    const db = sharedStateReadonlyDatabase(source.filename);
    const index = scope.project ? taskListIndex.project : taskListIndex.installation;
    const definition = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index)?.sql;
    if (!taskListIndexCurrent(index, definition)) return deferredTaskPage();
    scanned = await scan(boundary);
    if (!scanned) return deferredDeadlineTaskPage(boundary && typeof cursor === "string" ? cursor : undefined);
  }

  const rows: Row[] = [];
  let last: Position | undefined, bytes = 2, visited = 0, skipped = false, deadlineHit = false, pageDeadlineHit = false;
  const matches = (candidate: Candidate) => scope.ids.length ? true : matchCandidate(candidate);
  for (const candidate of scanned.candidates) {
    if (rows.length === limit) break;
    if (expired()) {
      deadlineHit = true;
      if (!visited) return { ...deferredDeadlineTaskPage(boundary && typeof cursor === "string" ? cursor : undefined), hasMore: true };
      pageDeadlineHit = true;
      break;
    }
    const match = matches(candidate);
    if (match === undefined) referenceDeferred = true;
    if (match) {
      const task = keyed.get(candidate.id) ?? source.read(candidate.id);
      // The keyed payload may be newer than the seek. Check it against the
      // current scope and cursor position before it reaches the response.
      const current = task && task.updatedAt === candidate.time ? matchesTask(task) : false;
      if (current === undefined) referenceDeferred = true;
      if (task && current) {
        const row = project(task), size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (rows.length && bytes + size > LIST_ANSWER_BYTES) break;
        rows.push(row); bytes += size;
      } else skipped = true;
    }
    last = candidate;
    visited++;
    await pause();
  }

  // Count only on an exhausted, inexpensive index prefix, after the page has
  // been materialized. On a large board the cursor tracks inspected work.
  const count = async (candidates: Candidate[], from = 0) => {
    let n = 0;
    for (let i = from; i < candidates.length; i++) {
      if (expired()) { deadlineHit = true; return undefined; }
      const match = matches(candidates[i]!);
      if (match === undefined) { referenceDeferred = true; return undefined; }
      if (match) n++;
      await pause();
    }
    return n;
  };
  const remainingCount = !skipped && !referenceDeferred && scanned.complete ? await count(scanned.candidates, visited) : undefined;
  let total: number | undefined;
  if (scope.ids.length && !referenceDeferred) total = keyed.size;
  else if (remainingCount !== undefined) {
    if (!boundary) total = rows.length + remainingCount;
    else {
      const head = await scan(undefined);
      if (!head && expired()) deadlineHit = true;
      else if (head?.complete) total = await count(head.candidates);
    }
  }
  const hasMore = remainingCount === undefined ? visited < scanned.candidates.length || !scanned.complete : remainingCount > 0;
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ scope: hash, id: last.id, time: last.time })).toString("base64url") : null;
  if (databaseFileIdentity(source.filename) !== identity || databaseSwapInProgress(source.filename)) return deferredTaskPage();
  checkpoint();
  const omissions = [...new Set([...(pageDeadlineHit ? ["taskPage"] : []), ...(total === undefined ? ["total"] : []), ...(remainingCount === undefined ? ["remainingCount"] : []),
    ...(total === undefined ? ["omittedCount"] : []), ...(referenceDeferred || hasMore && !last ? ["taskPage"] : [])])];
  return {
    rows, count: rows.length, hasMore, nextCursor, cursorReset,
    ...(total === undefined ? {} : { total, omittedCount: total - rows.length }),
    ...(remainingCount === undefined ? {} : { remainingCount }),
    ...(omissions.length ? { partial: true, omissions } : {}),
    ...(deadlineHit ? { retryHint: "The task page time budget was exhausted; retry the same filters and cursor." }
      : referenceDeferred ? { retryHint: "Look up the PR association on the relevant task or pipeline by id." }
      : hasMore && !nextCursor ? { retryHint: "Retry this page with the same filters." } : {}),
  };
}
