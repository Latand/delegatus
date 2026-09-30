/**
 * A task on the wire of `boards/sync` (docs/design/linked-installs.md M.5).
 * Only the merged groups cross; assignments, holds, sources, attachments,
 * deadlines and group hides never do. Project sharing consents to task text;
 * board membership crosses on arrival. Every field has a bound, checked by the sender before
 * it encodes a row and by the receiver like a local write.
 */
import { boundedRepository, MAX_WORK_LINKS, type StoredWorkLink } from "@/lib/forge/workLinks";
import { readTaskIconInput } from "@/lib/tasks/taskIcon";
import { TASK_COLORS, TASK_DETAILS_LIMIT, TASK_SYNC_GROUPS, TASK_TEXT_LIMIT, type BoardTask, type TaskBoardVisibility, type TaskColor, type TaskPlacement, type TaskStatus, type TaskSyncGroup } from "@/lib/tasks/types";

import { isStamp } from "./stamp";
import { effectiveStamp, newestStamp } from "./taskStamp";

export type WireTask = {
  id: string; project: string; text: string; details?: string; status: TaskStatus; board?: TaskBoardVisibility;
  color?: TaskColor; icon?: string; priority?: "high" | "low"; placement: TaskPlacement; pos?: { x: number; y: number };
  workLinks?: StoredWorkLink[]; machine: string; handover?: { to: string };
  createdAt: string; updatedAt: string; s: Record<TaskSyncGroup, string>;
};
export type WireGone = { id: string; project: string; gone: string };
export type WireStub = { id: string; project: string; withheld: string };
export type WireRow = WireTask | WireGone | WireStub;

export const isWireGone = (row: WireRow): row is WireGone => "gone" in row;
export const isWireStub = (row: WireRow): row is WireStub => "withheld" in row;
export const isWireTask = (row: WireRow): row is WireTask => !isWireGone(row) && !isWireStub(row);

/** The sender refuses to encode a row above this. */
export const MAX_WIRE_ROW_BYTES = 170_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const PROJECT = /^repo-[0-9a-f]{32}$/;

export class MalformedRow extends Error { constructor(readonly field: string) { super(`malformed ${field}`); } }

/** The row as it leaves this machine, or a withheld stub when a stored field
    breaks a bound (a repository written before the bound existed). */
export function encodeTask(task: BoardTask, self: { id: string; prefix: string }): { row: WireTask | WireStub; bytes: number } {
  const s = Object.fromEntries(TASK_SYNC_GROUPS.map((group) => [group, effectiveStamp(task, group, self.prefix)])) as Record<TaskSyncGroup, string>;
  const row: WireTask = {
    id: task.id, project: task.project, text: task.text,
    ...(task.board !== undefined ? { board: task.board } : {}),
    ...(task.details !== undefined ? { details: task.details } : {}), status: task.status,
    ...(task.color ? { color: task.color } : {}), ...(task.icon ? { icon: task.icon } : {}),
    ...(task.priority === "high" || task.priority === "low" ? { priority: task.priority } : {}),
    placement: task.placement, ...(task.pos ? { pos: task.pos } : {}),
    ...(task.workLinks?.length ? { workLinks: task.workLinks } : {}),
    machine: task.machine ?? self.id, ...(task.handover ? { handover: task.handover } : {}),
    createdAt: task.createdAt, updatedAt: task.updatedAt, s,
  };
  const bytes = Buffer.byteLength(JSON.stringify(row));
  try {
    if (bytes > MAX_WIRE_ROW_BYTES) throw new MalformedRow("size");
    validateWireTask(row);
    return { row, bytes };
  } catch (error) {
    if (!(error instanceof MalformedRow)) throw error;
    const stub: WireStub = { id: task.id, project: task.project, withheld: newestStamp(task, self.prefix) };
    return { row: stub, bytes: Buffer.byteLength(JSON.stringify(stub)) };
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function validWorkLink(value: unknown): value is StoredWorkLink {
  if (!object(value)) return false;
  return boundedRepository(value.repository) && typeof value.number === "number" && Number.isSafeInteger(value.number) && value.number > 0
    && (value.kind === "pr" || value.kind === "issue" || value.kind === null)
    && typeof value.addedAt === "string" && ISO.test(value.addedAt) && (value.addedBy === "operator" || value.addedBy === "agent")
    && Object.keys(value).length === 5;
}

const GROUP_KEYS = new Set(["id", "project", "text", "details", "status", "color", "icon", "priority", "placement", "pos", "workLinks", "machine", "handover", "createdAt", "updatedAt", "s", "board"]);

function validateWireTask(row: Record<string, unknown>): asserts row is WireTask {
  const fail = (field: string): never => { throw new MalformedRow(field); };
  for (const key of Object.keys(row)) if (!GROUP_KEYS.has(key)) fail(key);
  if (typeof row.id !== "string" || !UUID.test(row.id)) fail("id");
  if (typeof row.project !== "string" || !PROJECT.test(row.project)) fail("project");
  if (typeof row.text !== "string" || !row.text.trim() || row.text.length > TASK_TEXT_LIMIT) fail("text");
  if (row.details !== undefined && (typeof row.details !== "string" || row.details.length > TASK_DETAILS_LIMIT)) fail("details");
  if (row.board !== undefined && row.board !== "hidden" && row.board !== "shown") fail("board");
  if (!["inbox", "assigned", "blocked", "done"].includes(row.status as string)) fail("status");
  if (row.color !== undefined && !(TASK_COLORS as readonly unknown[]).includes(row.color)) fail("color");
  if (row.icon !== undefined) { const icon = readTaskIconInput(row.icon); if (icon.kind !== "set" || icon.icon !== row.icon) fail("icon"); }
  if (row.priority !== undefined && row.priority !== "high" && row.priority !== "low") fail("priority");
  if (!["pinned", "unplaced", "auto"].includes(row.placement as string)) fail("placement");
  if (row.pos !== undefined && !(object(row.pos) && Object.keys(row.pos).length === 2 && typeof row.pos.x === "number" && Number.isFinite(row.pos.x) && typeof row.pos.y === "number" && Number.isFinite(row.pos.y))) fail("pos");
  if ((row.placement === "pinned") !== (row.pos !== undefined)) fail("placement");
  if (row.workLinks !== undefined && !(Array.isArray(row.workLinks) && row.workLinks.length > 0 && row.workLinks.length <= MAX_WORK_LINKS && row.workLinks.every(validWorkLink))) fail("workLinks");
  if (typeof row.machine !== "string" || !UUID.test(row.machine)) fail("machine");
  if (row.handover !== undefined && !(object(row.handover) && Object.keys(row.handover).length === 1 && typeof row.handover.to === "string" && UUID.test(row.handover.to))) fail("handover");
  if (typeof row.createdAt !== "string" || !ISO.test(row.createdAt)) fail("createdAt");
  if (typeof row.updatedAt !== "string" || !ISO.test(row.updatedAt)) fail("updatedAt");
  if (!object(row.s) || Object.keys(row.s).length !== TASK_SYNC_GROUPS.length || !TASK_SYNC_GROUPS.every((group) => isStamp((row.s as Record<string, unknown>)[group]))) fail("s");
}

/** Receiver side: a row that breaks a bound fails its whole page. */
export function decodeWireRow(value: unknown): WireRow {
  if (!object(value)) throw new MalformedRow("row");
  if ("gone" in value || "withheld" in value) {
    const stamp = "gone" in value ? value.gone : value.withheld;
    if (Object.keys(value).length !== 3 || typeof value.id !== "string" || !UUID.test(value.id) || typeof value.project !== "string" || !PROJECT.test(value.project) || !isStamp(stamp)) throw new MalformedRow("row");
    return value as WireRow;
  }
  validateWireTask(value);
  return value;
}

/** A group's value in wire form, for the equality the `o` rule compares. */
export function wireGroup(row: WireTask, group: TaskSyncGroup): string {
  switch (group) {
    case "text": return JSON.stringify([row.text, row.details ?? null]);
    case "status": return JSON.stringify(row.status);
    case "look": return JSON.stringify([row.color ?? null, row.icon ?? null, row.priority ?? null]);
    case "place": return JSON.stringify([row.placement, row.pos ?? null]);
    case "links": return JSON.stringify(row.workLinks ?? null);
    case "machine": return JSON.stringify(row.machine);
    case "handover": return JSON.stringify(row.handover ?? null);
  }
}
