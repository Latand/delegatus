import { repairLinkedTasks } from "./taskRepair";
/**
 * B's half of the `tasks` part of `boards/sync` (docs/design/linked-installs.md
 * M.5). B never calls out and holds no cursor: A names the position, B answers
 * one page after it, and applies A's push before it acknowledges it.
 */
import { linkedPeer, linkedContext } from "./linked";
import { applyTaskRows } from "./taskApply";
import { isPosition, readLogPage, readScanPage, PAGE_ROWS, type Position } from "./taskFeed";
import { decodeWireRow, MalformedRow, TASK_BOARD_WIRE_VERSION } from "./taskWire";
import type { Grant } from "./state";
import { taskFeedSource } from "@/lib/tasks/store";

const SCAN_CURSOR = /^(t:[0-9a-f-]{36}|g:([0-9a-f-]{36})?)?$/;
const PROJECT = /^repo-[0-9a-f]{32}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export type ServeOutcome = { error: "malformed" | "clock" | "quota" } | { parts: Record<string, unknown>; moved: boolean };

/**
 * `agreed` says both sides hold each other's current shared list; until they
 * do, the two sides could disagree on what is linked, so no row moves.
 */
export function serveTasks(grant: Grant, wire: Record<string, unknown>, agreed: boolean): ServeOutcome {
  if (wire.tasks === undefined && wire.push === undefined) return { parts: {}, moved: false };
  const pull = wire.tasks;
  const push = wire.push;
  if (pull !== undefined && !(object(pull) && (pull.after === null || isPosition(pull.after)))) return { error: "malformed" };
  const scan = object(pull) ? pull.scan : undefined;
  if (scan !== undefined && !(object(scan) && Array.isArray(scan.p) && scan.p.length > 0 && scan.p.length <= 200
    && scan.p.every((key) => typeof key === "string" && PROJECT.test(key)) && typeof scan.after === "string" && SCAN_CURSOR.test(scan.after))) return { error: "malformed" };
  if (push !== undefined && !(object(push) && Array.isArray(push.rows) && push.rows.length <= PAGE_ROWS
    && (isPosition(push.through) !== (push.scan !== undefined)) && (push.scan === undefined || push.scan === null || (typeof push.scan === "string" && SCAN_CURSOR.test(push.scan))))) return { error: "malformed" };
  if (!agreed) return { parts: { tasks: { wait: true } }, moved: false };
  repairLinkedTasks();
  const context = linkedContext();
  const link = linkedPeer("grant", grant.id);
  if (!context.self || !link) return { parts: { tasks: { wait: true } }, moved: false };
  const parts: Record<string, unknown> = {};
  let moved = false;
  if (object(push)) {
    let rows;
    try { rows = (push.rows as unknown[]).map(decodeWireRow); } catch (error) {
      if (error instanceof MalformedRow) return { error: "malformed" };
      throw error;
    }
    let outcome;
    try { outcome = applyTaskRows(rows, { key: `grant:${grant.id}`, install: grant.install, prefix: link.prefix, projects: link.projects }); }
    catch (error) {
      if (error instanceof MalformedRow) return { error: "malformed" };
      throw error;
    }
    if (outcome.refused) return { error: outcome.refused };
    // The commit above is durable before A reads this acknowledgement.
    parts.ack = { push: isPosition(push.through) ? push.through : push.scan };
    moved ||= rows.length > 0;
  }
  if (object(pull)) {
    const filter = { self: context.self, skipPrefix: link.prefix, includeBoard: typeof wire.taskWireVersion === "number" && wire.taskWireVersion >= TASK_BOARD_WIRE_VERSION };
    if (object(scan)) {
      const projects = new Set((scan.p as string[]).filter((key) => link.projects.has(key)));
      // The position a resync ends on is read before its first row.
      const at: Position | undefined = scan.after === "" ? [taskFeedSource()?.revision() ?? 0] : undefined;
      const page = readScanPage(scan.after as string, { ...filter, projects, skipPrefix: null });
      parts.tasks = { cursor: pull.after, ...(page.rows.length ? { rows: page.rows } : {}), scan: page.next, ...(at ? { at } : {}) };
      moved ||= page.rows.length > 0;
    } else if (pull.after === null) {
      parts.tasks = { resync: true };
    } else {
      const page = readLogPage(pull.after as Position, { ...filter, projects: link.projects });
      if (page.kind === "resync") parts.tasks = { resync: true };
      else {
        parts.tasks = { cursor: page.cursor, ...(page.rows.length ? { rows: page.rows } : {}), ...(page.more ? { more: true } : {}) };
        moved ||= page.rows.length > 0;
      }
    }
  }
  return { parts, moved };
}
