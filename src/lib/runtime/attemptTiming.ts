import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import type { RuntimeEvent } from "./engineHost";
import type { TimeSpan } from "@/lib/pipelines/accounting";

type OpenTurn = { owner: string; turn: string; start: number; lastAt: number; tools: Record<string, number>; spans: TimeSpan[]; valid: boolean };
// A fresh process cannot close a previous process's unobserved interval.
const owner = crypto.randomUUID();
function openDatabase(filename: string, readonly = false): Database {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("Native timing requires Bun SQLite");
  return new sqlite.Database(filename, readonly ? { readonly: true } : { create: true });
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const toolTypes = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "collabAgentToolCall"]);
function boundaries(event: Extract<RuntimeEvent, { kind: "item" }>): { id: string; start: boolean }[] {
  const item = object(event.item);
  if (toolTypes.has(String(item.type)) && typeof item.id === "string") return [{ id: item.id, start: event.phase === "started" }];
  const content = object(item.message).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap<{ id: string; start: boolean }>(block => {
    const row = object(block);
    return row.type === "tool_use" && typeof row.id === "string" ? [{ id: row.id, start: true }]
      : row.type === "tool_result" && typeof row.tool_use_id === "string" ? [{ id: row.tool_use_id, start: false }] : [];
  });
}

/** Compact native observations beside the event ledger. No transcript reads,
 * no delta writes, no retained payloads, and bounded open-turn state. */
export function recordNativeTiming(directory: string, session: string, event: RuntimeEvent, gap = false, source = ""): void {
  if (event.kind !== "turn-started" && event.kind !== "turn-ended" && event.kind !== "item") return;
  const at = Date.parse(event.accountingAt ?? "");
  if (!Number.isFinite(at)) return; // Reconstructed history carries no clock.
  const filename = path.join(directory, "timing.sqlite");
  const db = openDatabase(filename);
  try {
    db.exec("PRAGMA busy_timeout=0");
    db.exec("CREATE TABLE IF NOT EXISTS timing_open(session TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT); CREATE TABLE IF NOT EXISTS timing_spans(session TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session,seq))");
    db.transaction(() => {
      const row = db.query<{ source: string; seq: number; value: string | null }, [string]>("SELECT source,seq,value FROM timing_open WHERE session=?").get(session);
      const replaced = row && (row.source !== source || event.seq === 1 && row.seq > 1);
      if (row && !replaced && row.seq >= event.seq) return;
      if (replaced) db.query("DELETE FROM timing_spans WHERE session=?").run(session);
      let turn: OpenTurn | null = !replaced && row?.value ? JSON.parse(row.value) : null;
      if (turn?.owner !== owner) turn = null;
      if (turn && gap) turn.valid = false;
      if (event.kind === "turn-started") turn = { owner, turn: event.turnId, start: at, lastAt: at, tools: {}, spans: [], valid: true };
      else if (event.kind === "item" && turn && event.turnId === turn.turn) {
        for (const boundary of boundaries(event)) {
          if (boundary.start) {
            if (Object.keys(turn.tools).length >= 128) turn.valid = false;
            else if (!Object.hasOwn(turn.tools, boundary.id)) turn.tools = Object.fromEntries([...Object.entries(turn.tools), [boundary.id, at]]);
          } else {
            const start = Object.hasOwn(turn.tools, boundary.id) ? turn.tools[boundary.id] : undefined;
            if (start === undefined || at < start) turn.valid = false;
            else if (turn.spans.length < 4096) turn.spans.push({ kind: "tools", start, end: at });
            else turn.valid = false;
            delete turn.tools[boundary.id];
          }
        }
        if (at < turn.lastAt) turn.valid = false; else turn.lastAt = at;
      } else if (event.kind === "turn-ended" && turn && event.turnId === turn.turn) {
        const spans = turn.valid && !Object.keys(turn.tools).length && at >= turn.lastAt
          ? [{ kind: "model", start: turn.start, end: at }, ...turn.spans] : [];
        db.query("INSERT OR IGNORE INTO timing_spans VALUES(?,?,?)").run(session, event.seq, JSON.stringify(spans));
        turn = null;
      }
      db.query("INSERT INTO timing_open VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET source=excluded.source,seq=excluded.seq,value=excluded.value")
        .run(session, source, event.seq, turn ? JSON.stringify(turn) : null);
    })();
  } finally { db.close(); }
}

/** One session, closed intervals and the last observed open-turn boundary.
 * The bounded tail cannot attribute
 * omitted time: it remains unknown in the attempt's reconciliation. */
export function readNativeTiming(session: string, directory = statePath("structured-host-events")): TimeSpan[] {
  const filename = path.join(directory, "timing.sqlite");
  if (!fs.existsSync(filename)) return [];
  const db = openDatabase(filename, true);
  try {
    db.exec("PRAGMA busy_timeout=0");
    // Reserve room in the attempt for bounded check observations too. Keep
    // whole turns: dropping a tool span while retaining its turn would label
    // that missing observation as model time.
    const limit = 4096 - 512;
    const result: TimeSpan[] = [];
    const current = db.query<{ value: string | null }, [string]>("SELECT value FROM timing_open WHERE session=?").get(session);
    const turn: OpenTurn | null = current?.value ? JSON.parse(current.value) : null;
    if (turn?.valid && turn.lastAt >= turn.start) {
      const active: TimeSpan[] = [{ kind: "model", start: turn.start, end: turn.lastAt }, ...turn.spans,
        ...Object.values(turn.tools).map(start => ({ kind: "tools" as const, start, end: turn.lastAt }))];
      if (active.length <= limit) result.push(...active);
    }
    const rows = db.query<{ value: string }, [string]>("SELECT value FROM timing_spans WHERE session=? ORDER BY seq DESC LIMIT 256").iterate(session);
    for (const row of rows) {
      const spans = JSON.parse(row.value) as TimeSpan[];
      if (result.length + spans.length > limit) break;
      result.push(...spans);
    }
    return result;
  } finally { db.close(); }
}
