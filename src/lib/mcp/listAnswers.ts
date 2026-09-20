import { createHash } from "node:crypto";
import { taskRevision } from "@/lib/tasks/revision";
import type { BoardTask } from "@/lib/tasks/types";

export const LIST_ANSWER_BYTES = 24_000;
export const fullAnswer = (args: Record<string, unknown>) => args.full === true || args.compact === false;
export const firstLine = (value: string, max = 160) => value.split("\n", 1)[0]!.slice(0, max);

export function compactTask(task: BoardTask & { pipelineIds?: string[] }) {
  return {
    id: task.id, project: task.project, status: task.status, text: firstLine(task.text),
    updatedAt: task.updatedAt, revision: taskRevision(task), placement: task.placement,
    ...(task.pipelineIds ? { pipelineIds: task.pipelineIds.slice(0, 20), pipelineIdsOmitted: Math.max(0, task.pipelineIds.length - 20) } : {}), assignmentCount: task.assignments?.length ?? 0,
    detailsLength: task.details?.length ?? 0, textLength: task.text.length,
    ...(task.board ? { board: task.board } : {}),
    ...(task.color ? { color: task.color } : {}),
    ...(task.pos ? { pos: task.pos } : {}),
  };
}

export function recordRevision(record: unknown): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export function fieldValues(record: object | null | undefined) {
  return new Map(Object.entries(record ?? {}).map(([key, value]) => [key, JSON.stringify(value)]));
}

export function changedFieldNames(before: Map<string, string | undefined>, after: object) {
  return [...new Set([...before.keys(), ...Object.keys(after)])].filter(key => before.get(key) !== JSON.stringify((after as Record<string, unknown>)[key]));
}

export function taskAcknowledgement(task: BoardTask, args: Record<string, unknown>, fields: string[]) {
  const full = fullAnswer(args);
  return {
    taskId: task.id, revision: taskRevision(task), task: full ? task : compactTask(task),
    changedFields: fields,
    changes: Object.fromEntries(fields.filter(key => !["id", "project", "revision", "updatedAt", "createdAt"].includes(key)).map(key => {
      const value = (task as unknown as Record<string, unknown>)[key];
      if (typeof value === "string") return [key, firstLine(value) === value ? value : { preview: firstLine(value), length: value.length, truncated: true }];
      if (Array.isArray(value)) return [key, { count: value.length, omittedCount: value.length }];
      if (value && typeof value === "object" && Buffer.byteLength(JSON.stringify(value)) > 300) return [key, { omitted: true }];
      return [key, value ?? null];
    })),
    omittedFieldCount: full ? 0 : Object.keys(task).filter(key => !["id", "project", "status", "updatedAt", "revision", "placement", "board", "color", "pos"].includes(key)).length,
    readMore: "get_task(taskId) reads the complete stored task; full:true returns it on a write.",
  };
}

type IndexedRow<T> = { id: string; time: string; record: T };
type Index<T> = { rows: IndexedRow<T>[]; queries: Map<string, IndexedRow<T>[]> };
const indexes = new WeakMap<object, Index<unknown>>();

/** One ordering per immutable store generation. Repeated polls and cursor pages
 * reuse a bounded query cache; only the selected page is materialized/redacted.
 * A new generation invalidates both ordering and query results. */
type PageOptions<T, Row> = {
  scope: Record<string, unknown>; cursor: unknown; limit: number;
  identity: (record: T) => { id: string; time: string };
  matches: (record: T) => boolean; project: (record: T) => Row;
};

export function listPage<T, Row>(records: readonly T[], options: PageOptions<T, Row>) {
  const work = pageGenerator(records, options);
  let next = work.next();
  while (!next.done) next = work.next();
  return next.value;
}

export async function listPageAsync<T, Row>(records: readonly T[], options: PageOptions<T, Row>, checkpoint: () => void) {
  checkpoint();
  const work = pageGenerator(records, options);
  let next = work.next();
  while (!next.done) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    checkpoint();
    next = work.next();
  }
  return next.value;
}

function* pageGenerator<T, Row>(records: readonly T[], options: PageOptions<T, Row>) {
  let index = indexes.get(records) as Index<T> | undefined;
  if (!index) {
    const rows: IndexedRow<T>[] = [];
    for (const record of records) {
      if (rows.length && rows.length % 250 === 0) yield;
      rows.push({ ...options.identity(record), record });
    }
    index = { rows: rows.sort(compare), queries: new Map() };
    indexes.set(records, index as Index<unknown>);
  }
  const scope = createHash("sha256").update(JSON.stringify(options.scope)).digest("hex").slice(0, 16);
  let selected = index.queries.get(scope);
  if (!selected) {
    selected = [];
    for (let at = 0; at < index.rows.length; at++) {
      if (at && at % 250 === 0) yield;
      const row = index.rows[at]!;
      if (options.matches(row.record)) selected.push(row);
    }
    if (index.queries.size >= 32) index.queries.delete(index.queries.keys().next().value!);
    index.queries.set(scope, selected);
  }
  let boundary: { id: string; time: string } | null = null;
  let cursorReset = false;
  if (options.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(String(options.cursor).slice(0, 2048), "base64url").toString());
      if (cursor.scope !== scope || typeof cursor.id !== "string" || typeof cursor.time !== "string") throw new Error("cursor scope");
      boundary = cursor;
    } catch { cursorReset = true; }
  }
  // Binary keyset lookup also works if the boundary row was deleted.
  let start = 0;
  if (boundary) {
    let end = selected.length;
    while (start < end) {
      const mid = (start + end) >>> 1;
      if (compare(selected[mid]!, boundary) <= 0) start = mid + 1;
      else end = mid;
    }
  }
  const rows: Row[] = [];
  let bytes = 2;
  for (let at = start; at < selected.length && rows.length < options.limit; at++) {
    if (rows.length && rows.length % 25 === 0) yield;
    const row = options.project(selected[at]!.record);
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    // A full record remains reachable even when that single record exceeds the
    // list budget. Default compact rows fit; full reads are explicit opt-ins.
    if (rows.length && bytes + size > LIST_ANSWER_BYTES) break;
    rows.push(row);
    bytes += size;
  }
  const remainingCount = selected.length - start - rows.length;
  const last = selected[start + rows.length - 1];
  return {
    rows, count: rows.length, total: selected.length, remainingCount,
    hasMore: remainingCount > 0,
    nextCursor: remainingCount > 0 && last ? Buffer.from(JSON.stringify({ scope, id: last.id, time: last.time })).toString("base64url") : null,
    omittedCount: selected.length - rows.length, cursorReset,
  };
}

function compare(a: { time: string; id: string }, b: { time: string; id: string }) {
  return b.time.localeCompare(a.time) || b.id.localeCompare(a.id);
}

export function stringSet(value: unknown, allowed?: readonly string[]): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.filter((v): v is string => typeof v === "string").map(v => v.trim()).filter(v => v && (!allowed || allowed.includes(v))))].sort();
}

export function sinceTime(value: unknown): string {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}
